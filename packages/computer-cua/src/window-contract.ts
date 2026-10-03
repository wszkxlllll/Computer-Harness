import {
  BoundsExpectation,
  StatePredicate,
  VerifyStateInput,
  WindowPredicate,
  type CuaDriverLike,
  type ToolResult,
} from "@trycua/cua-driver";
import type { Viewport } from "@computer-harness/protocol";
import { mergeWindowRelationshipInventory, type WindowRelationshipProbe } from "./window-relationship-probe.js";

/** Explicit host-owned identity; never model-facing. */
export interface CuaWindowTarget {
  readonly pid: number;
  readonly windowId: number;
}

export interface CuaWindowGeometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CuaWindowBinding {
  readonly target: CuaWindowTarget;
  readonly bounds: CuaWindowGeometry;
}

/**
 * Host-only window discovery result.  The optional label is for a local
 * picker/status line; it is never inserted into a model Context by this
 * package.  Actions must still use the opaque PID/window_id pair.
 */
export interface CuaWindowInfo extends CuaWindowBinding {
  readonly title?: string;
  readonly appName?: string;
  readonly zIndex?: number;
  readonly isOnScreen?: boolean;
  readonly ownerPid?: number;
  readonly ownerWindowId?: number;
  readonly minimized?: boolean;
  readonly windowClass?: string;
}

export interface CuaWindowInventory {
  readonly windows: readonly CuaWindowInfo[];
  /** Positive backend attestation that the returned inventory is complete. */
  readonly complete: boolean;
  /** Missing can be filled by another producer only when no source supplied negative evidence. */
  readonly completeAttestation?: "explicit" | "missing" | "negative";
  readonly truncated?: boolean;
  readonly source?: "cua_inventory" | "win32_relationship_probe";
  readonly foregroundPid?: number;
  readonly foregroundWindowId?: number;
}

export interface CuaWindowCapture {
  readonly binding: CuaWindowBinding;
  readonly viewport: Viewport;
  readonly data: Uint8Array;
}

/**
 * Test seam for the bounded read-only capture retry loop. Production callers
 * use the built-in abort-aware timer; tests can resolve immediately and use a
 * fake clock without sleeping.
 */
export interface WindowCaptureRetryOptions {
  readonly delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly now?: () => number;
}

export class WindowContractError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "WindowContractError";
  }
}

export function validateWindowTarget(target: CuaWindowTarget): void {
  if (!Number.isSafeInteger(target.pid) || target.pid <= 0) {
    throw new Error("CUA window target pid must be a positive safe integer");
  }
  if (!Number.isSafeInteger(target.windowId) || target.windowId <= 0) {
    throw new Error("CUA window target windowId must be a positive safe integer");
  }
}

export async function discoverWindow(
  driver: CuaDriverLike,
  session: string,
  target: CuaWindowTarget,
  signal: AbortSignal,
): Promise<CuaWindowBinding> {
  const windows = await listWindowTargets(driver, session, signal, target.pid);
  const match = windows.find((window) => window.target.pid === target.pid && window.target.windowId === target.windowId);
  if (match === undefined) throw new WindowContractError("WINDOW_TARGET_NOT_FOUND", "configured CUA window target was not found");
  return { target, bounds: match.bounds };
}

/**
 * Enumerate visible top-level windows for a host-owned picker.  This is a
 * read-only operation: it never focuses, captures, or dispatches input to a
 * window.  A caller must select a returned identity explicitly; the adapter
 * never auto-selects a sibling window, tab, popup, or recreated PID/windowId.
 */
export async function listWindowTargets(
  driver: CuaDriverLike,
  session: string,
  signal: AbortSignal,
  pid?: number,
  onScreenOnly = true,
  relationshipProbe?: WindowRelationshipProbe,
): Promise<readonly CuaWindowInfo[]> {
  return (await listWindowInventory(driver, session, signal, pid, onScreenOnly, relationshipProbe)).windows;
}

/** Return exact visible-window rows plus fail-closed completeness evidence. */
export async function listWindowInventory(
  driver: CuaDriverLike,
  session: string,
  signal: AbortSignal,
  pid?: number,
  onScreenOnly = true,
  relationshipProbe?: WindowRelationshipProbe,
): Promise<CuaWindowInventory> {
  const result = await driver.callTool("list_windows", JSON.stringify({
    on_screen_only: onScreenOnly,
    ...(pid === undefined ? {} : { pid }),
    session,
  }), { signal });
  if (result.isError) throw new WindowContractError("WINDOW_TARGET_REFUSED", "configured CUA window target was refused");
  if (result.degraded) throw new WindowContractError("WINDOW_TARGET_UNKNOWN", "configured CUA window target is degraded");
  const value = parseStructured(result.structuredJson);
  if (value?.degraded === true) throw new WindowContractError("WINDOW_TARGET_UNKNOWN", "configured CUA window target is degraded");
  const windows = parseWindows(result);
  const rawWindows = value?.windows;
  const truncated = value?.truncated === true;
  const negativeCompletenessEvidence = value?.complete === false || truncated;
  const completeAttestation = negativeCompletenessEvidence
    ? "negative"
    : value !== undefined && Object.hasOwn(value, "complete") ? "explicit" : "missing";
  const complete = value?.complete === true && !truncated && value.degraded !== true &&
    Array.isArray(rawWindows) && rawWindows.length === windows.length;
  const inventory: CuaWindowInventory = {
    windows,
    complete,
    completeAttestation,
    source: "cua_inventory",
    ...(truncated ? { truncated: true } : {}),
    ...(positiveSafeInteger(value?.foreground_pid ?? value?.foregroundPid) === undefined
      ? {}
      : { foregroundPid: positiveSafeInteger(value?.foreground_pid ?? value?.foregroundPid)! }),
    ...(positiveSafeInteger(value?.foreground_window_id ?? value?.foregroundWindowId) === undefined
      ? {}
      : { foregroundWindowId: positiveSafeInteger(value?.foreground_window_id ?? value?.foregroundWindowId)! }),
  };
  if (relationshipProbe === undefined || hasCompleteRelationshipFields(inventory)) return inventory;
  try {
    const probe = await relationshipProbe.read(signal);
    signal.throwIfAborted();
    return mergeWindowRelationshipInventory(inventory, probe, onScreenOnly);
  } catch {
    signal.throwIfAborted();
    return { ...inventory, complete: false };
  }
}

function hasCompleteRelationshipFields(inventory: CuaWindowInventory): boolean {
  return inventory.complete && inventory.windows.every((window) =>
    window.zIndex !== undefined && window.isOnScreen !== undefined && window.minimized !== undefined &&
    window.ownerPid !== undefined && window.ownerWindowId !== undefined && window.windowClass !== undefined) &&
    inventory.foregroundPid !== undefined && inventory.foregroundWindowId !== undefined;
}

export async function captureWindow(
  driver: CuaDriverLike,
  session: string,
  binding: CuaWindowBinding,
  signal: AbortSignal,
): Promise<CuaWindowCapture> {
  const predicate = StatePredicate.new({
    window: WindowPredicate.new({
      exists: true,
      bounds: BoundsExpectation.new({
        x: binding.bounds.x,
        y: binding.bounds.y,
        width: binding.bounds.width,
        height: binding.bounds.height,
        tolerancePx: 0,
      }),
    }),
  });
  const result = await driver.verifyState(VerifyStateInput.new({
    pid: BigInt(binding.target.pid),
    windowId: BigInt(binding.target.windowId),
    expect: [predicate],
    session,
    timeoutMs: BigInt(0),
    stableSamples: BigInt(1),
    includeScreenshot: true,
  }), { signal });
  if (result.isError) throw captureRefusalError("verify_state", binding.target, result.errorCode, result.text);
  if (result.degraded) throw new WindowContractError("WINDOW_CAPTURE_UNKNOWN", "configured CUA window capture is degraded");
  const verification = result.verification;
  if (verification === undefined || verification.status !== 0 || verification.stable !== true) {
    throw new WindowContractError("WINDOW_GEOMETRY_UNCONFIRMED", "configured CUA window geometry was not verified");
  }
  const { data, dimensions } = parseWindowCaptureImages(result.images, "CUA window capture");
  return {
    binding,
    viewport: { ...dimensions, coordinateSpace: "physical" },
    data,
  };
}

/**
 * Capture a selected window for a read-only open/observe boundary. A daemon
 * can transiently return an empty or malformed image envelope while the
 * target window is still present. In that narrow case we rediscover the
 * target before each retry so every capture uses fresh geometry. There are at
 * most three schema-failure captures, one shared retry for an explicit UIA
 * provider timeout, and one same-target fallback. A timeout retry can happen
 * in either capture path, never both; the total backoff remains capped at
 * 300ms, and all work shares one 20-second deadline. No action path calls
 * this helper, and no other contract failure is retried.
 */
export async function captureWindowWithRetry(
  driver: CuaDriverLike,
  session: string,
  target: CuaWindowTarget,
  signal: AbortSignal,
  options: WindowCaptureRetryOptions = {},
): Promise<CuaWindowCapture> {
  const deadlineController = new AbortController();
  const deadlineError = new WindowContractError("WINDOW_CAPTURE_DEADLINE", "configured CUA window capture exceeded its total read deadline");
  const deadlineTimer = setTimeout(() => deadlineController.abort(deadlineError), WINDOW_CAPTURE_MAX_DURATION_MS);
  const captureSignal = AbortSignal.any([signal, deadlineController.signal]);
  const throwIfCaptureAborted = (): void => {
    signal.throwIfAborted();
    if (deadlineController.signal.aborted) throw deadlineController.signal.reason ?? deadlineError;
  };
  let retryStartedAt: number | undefined;
  let scheduledBackoffMs = 0;
  let schemaFailure: WindowContractError | undefined;
  let uiaTimeoutRetriesRemaining = WINDOW_CAPTURE_MAX_UIA_TIMEOUT_RETRIES;
  let captureReadCalls = 0;
  let schemaAttempts = 0;
  const now = options.now ?? Date.now;
  const delay = options.delay ?? delayWithAbort;

  const waitBeforeRetry = async (attempt: number): Promise<void> => {
    throwIfCaptureAborted();
    if (retryStartedAt === undefined) retryStartedAt = now();
    const elapsed = Math.max(0, now() - retryStartedAt);
    const remaining = Math.max(0, WINDOW_CAPTURE_MAX_BACKOFF_MS - Math.max(elapsed, scheduledBackoffMs));
    const backoff = Math.min(WINDOW_CAPTURE_BACKOFF_MS[Math.min(attempt, WINDOW_CAPTURE_BACKOFF_MS.length - 1)]!, remaining);
    if (backoff > 0) {
      await delay(backoff, captureSignal);
      scheduledBackoffMs += backoff;
    }
    throwIfCaptureAborted();
  };

  try {
    while (schemaAttempts < WINDOW_CAPTURE_MAX_SCHEMA_ATTEMPTS) {
      throwIfCaptureAborted();
      const binding = await discoverWindowChecked(driver, session, target, captureSignal);
      try {
        if (captureReadCalls >= WINDOW_CAPTURE_MAX_READ_CALLS) {
          throw new WindowContractError("WINDOW_CAPTURE_RETRY_BUDGET_EXHAUSTED", "configured CUA window capture retry budget was exhausted");
        }
        captureReadCalls += 1;
        const capture = await captureWindow(driver, session, binding, captureSignal);
        throwIfCaptureAborted();
        return capture;
      } catch (error) {
        throwIfCaptureAborted();
        if (isUiaProviderTimeoutError(error) && uiaTimeoutRetriesRemaining > 0) {
          uiaTimeoutRetriesRemaining -= 1;
          await waitBeforeRetry(schemaAttempts);
          continue;
        }
        if (!isTransientWindowCaptureError(error)) {
          throw error;
        }
        schemaFailure = error;
        schemaAttempts += 1;
        if (schemaAttempts >= WINDOW_CAPTURE_MAX_SCHEMA_ATTEMPTS) {
          break;
        }
        await waitBeforeRetry(schemaAttempts - 1);
      }
    }
    if (schemaFailure !== undefined) {
      const captureFallback = async (): Promise<CuaWindowCapture> => {
        if (captureReadCalls >= WINDOW_CAPTURE_MAX_READ_CALLS) {
          throw new WindowContractError("WINDOW_CAPTURE_RETRY_BUDGET_EXHAUSTED", "configured CUA window capture retry budget was exhausted");
        }
        captureReadCalls += 1;
        return captureWindowFallbackAfterSchema(driver, session, target, captureSignal);
      };
      try {
        return await captureFallback();
      } catch (error) {
        throwIfCaptureAborted();
        if (!isUiaProviderTimeoutError(error) || uiaTimeoutRetriesRemaining <= 0) throw error;
        uiaTimeoutRetriesRemaining -= 1;
        await waitBeforeRetry(schemaAttempts);
        return captureFallback();
      }
    }
    throw new Error("unreachable window capture retry state");
  } finally {
    clearTimeout(deadlineTimer);
  }
}

/**
 * Last-resort read-only capture for the daemon regression where every bounded
 * verify_state attempt returns an envelope with no image. The caller has
 * already exhausted retries; this path rediscovers the exact configured
 * identity, then permits one screenshot-bearing get_window_state call. The
 * caller may repeat that read once only for an explicit UIA provider timeout.
 * It never dispatches or repeats an action.
 */
async function captureWindowFallbackAfterSchema(
  driver: CuaDriverLike,
  session: string,
  target: CuaWindowTarget,
  signal: AbortSignal,
): Promise<CuaWindowCapture> {
  signal.throwIfAborted();
  const binding = await discoverWindowChecked(driver, session, target, signal);
  signal.throwIfAborted();
  const result = await driver.callTool("get_window_state", JSON.stringify({
    pid: binding.target.pid,
    window_id: binding.target.windowId,
    include_screenshot: true,
    session,
  }), { signal });
  signal.throwIfAborted();
  if (!isRecord(result)) throw new WindowContractError("WINDOW_CAPTURE_SCHEMA", "CUA get_window_state fallback returned an invalid result envelope");
  if (result.isError) throw captureRefusalError("get_window_state fallback", binding.target, result.errorCode, result.text);
  if (result.degraded) throw new WindowContractError("WINDOW_CAPTURE_UNKNOWN", "configured CUA window fallback capture is degraded");
  const { data, dimensions } = parseWindowCaptureImages(
    result.images,
    "CUA get_window_state fallback",
    binding.bounds,
  );
  return {
    binding,
    viewport: { ...dimensions, coordinateSpace: "physical" },
    data,
  };
}

function parseWindowCaptureImages(
  rawImages: unknown,
  label: string,
  bounds?: CuaWindowGeometry,
): { data: Uint8Array; dimensions: { width: number; height: number } } {
  const images = Array.isArray(rawImages) ? rawImages : [];
  const imageSummary = summarizeCaptureImages(images);
  if (images.length !== 1 || !isRecord(images[0]) || images[0].mimeType !== "image/png") {
    throw new WindowContractError(
      "WINDOW_CAPTURE_SCHEMA",
      `${label} did not return one PNG image (${imageSummary})`,
    );
  }
  const dataBase64 = images[0].dataBase64;
  if (typeof dataBase64 !== "string") {
    throw new WindowContractError("WINDOW_CAPTURE_SCHEMA", `${label} returned invalid image data (${imageSummary})`);
  }
  const data = decodeBase64Png(dataBase64, imageSummary, label);
  const dimensions = readPngDimensions(data);
  if (dimensions === undefined) {
    throw new WindowContractError("WINDOW_CAPTURE_SCHEMA", `${label} returned an invalid PNG (${imageSummary})`);
  }
  if (bounds !== undefined && (dimensions.width > bounds.width || dimensions.height > bounds.height)) {
    throw new WindowContractError(
      "WINDOW_CAPTURE_SCHEMA",
      `${label} returned dimensions outside the verified window bounds (${dimensions.width}x${dimensions.height}; bounds=${bounds.width}x${bounds.height})`,
    );
  }
  return { data, dimensions };
}

const WINDOW_CAPTURE_MAX_ATTEMPTS = 3;
const WINDOW_CAPTURE_MAX_SCHEMA_ATTEMPTS = WINDOW_CAPTURE_MAX_ATTEMPTS;
const WINDOW_CAPTURE_MAX_UIA_TIMEOUT_RETRIES = 1;
const WINDOW_CAPTURE_MAX_FALLBACK_ATTEMPTS = 1;
const WINDOW_CAPTURE_MAX_READ_CALLS = WINDOW_CAPTURE_MAX_SCHEMA_ATTEMPTS + WINDOW_CAPTURE_MAX_UIA_TIMEOUT_RETRIES + WINDOW_CAPTURE_MAX_FALLBACK_ATTEMPTS;
const WINDOW_CAPTURE_MAX_DURATION_MS = 20_000;
const WINDOW_CAPTURE_BACKOFF_MS = [75, 150] as const;
const WINDOW_CAPTURE_MAX_BACKOFF_MS = 300;

const SAFE_CAPTURE_ERROR_CODES = new Map<string, string>([
  ["timeout", "TIMEOUT"],
  ["uia_provider_timeout", "UIA_PROVIDER_TIMEOUT"],
  ["permission_denied", "PERMISSION_DENIED"],
  ["window_id_not_found", "WINDOW_NOT_FOUND"],
  ["window_not_found", "WINDOW_NOT_FOUND"],
  ["window_owner_pid_mismatch", "WINDOW_OWNER_PID_MISMATCH"],
  ["px_capture_unavailable", "PX_CAPTURE_UNAVAILABLE"],
  ["px_frame_mismatch", "PX_FRAME_MISMATCH"],
  ["screen_capture_unavailable", "SCREEN_CAPTURE_UNAVAILABLE"],
]);

function captureRefusalMessage(
  tool: string,
  target: CuaWindowTarget,
  errorCode: string | undefined,
  errorText: string,
): string {
  const classification = captureFailureClassification(errorCode, errorText);
  return `configured CUA ${tool} capture was refused for exact target pid=${target.pid}, window_id=${target.windowId}` +
    (classification === undefined ? "" : ` [${classification}]`);
}

function captureRefusalError(
  tool: string,
  target: CuaWindowTarget,
  errorCode: string | undefined,
  errorText: string,
): WindowContractError {
  const message = captureRefusalMessage(tool, target, errorCode, errorText);
  return new WindowContractError(
    isUiaProviderTimeoutRefusal(errorCode, errorText) ? "WINDOW_CAPTURE_UIA_TIMEOUT" : "WINDOW_CAPTURE_REFUSED",
    message,
  );
}

/** Bring one exact OS window to the foreground. This may restore a minimized
 * window, but it never guesses an identity and dispatches no keyboard/mouse
 * input. */
export async function activateWindowTarget(
  driver: CuaDriverLike,
  session: string,
  target: CuaWindowTarget,
  signal: AbortSignal,
): Promise<void> {
  validateWindowTarget(target);
  signal.throwIfAborted();
  const result = await driver.callTool("bring_to_front", JSON.stringify({
    pid: target.pid,
    window_id: target.windowId,
    session,
  }), { signal });
  signal.throwIfAborted();
  if (result.isError) throw new WindowContractError("WINDOW_ACTIVATION_REFUSED", "CUA bring_to_front refused the exact window target");
  if (result.degraded) throw new WindowContractError("WINDOW_ACTIVATION_UNKNOWN", "CUA bring_to_front returned a degraded result for the exact window target");
  const structured = parseStructured(result.structuredJson);
  const landed = structured?.landed_on_target;
  const targetHandle = parseWindowHandle(structured?.target_hwnd);
  const foregroundHandle = parseWindowHandle(structured?.now_fg_hwnd);
  const expectedHandle = String(target.windowId);
  if (landed !== true || (targetHandle !== undefined && targetHandle !== expectedHandle) ||
      (foregroundHandle !== undefined && foregroundHandle !== expectedHandle) ||
      (targetHandle !== undefined && foregroundHandle !== undefined && targetHandle !== foregroundHandle)) {
    throw new WindowContractError("WINDOW_ACTIVATION_REFUSED", "CUA bring_to_front did not land on the exact window target");
  }
}

function parseWindowHandle(value: unknown): string | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (/^0x[0-9a-f]+$/iu.test(normalized)) {
    const parsed = Number.parseInt(normalized.slice(2), 16);
    return Number.isSafeInteger(parsed) ? String(parsed) : undefined;
  }
  if (/^\d+$/u.test(normalized)) {
    const parsed = Number(normalized);
    return Number.isSafeInteger(parsed) ? String(parsed) : undefined;
  }
  return undefined;
}

function captureFailureClassification(errorCode: string | undefined, errorText: string): string | undefined {
  if (errorCode !== undefined) return SAFE_CAPTURE_ERROR_CODES.get(errorCode.toLowerCase());
  return isUiaProviderTimeoutRefusal(undefined, errorText) ? "UIA_PROVIDER_TIMEOUT" : undefined;
}

async function discoverWindowChecked(
  driver: CuaDriverLike,
  session: string,
  target: CuaWindowTarget,
  signal: AbortSignal,
): Promise<CuaWindowBinding> {
  signal.throwIfAborted();
  const binding = await discoverWindow(driver, session, target, signal);
  signal.throwIfAborted();
  return binding;
}

function delayWithAbort(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("window capture retry aborted"));
      return;
    }
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("window capture retry aborted"));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isTransientWindowCaptureError(error: unknown): error is WindowContractError {
  return error instanceof WindowContractError && error.code === "WINDOW_CAPTURE_SCHEMA";
}

function isUiaProviderTimeoutError(error: unknown): error is WindowContractError {
  return error instanceof WindowContractError && error.code === "WINDOW_CAPTURE_UIA_TIMEOUT";
}

function isUiaProviderTimeoutRefusal(errorCode: string | undefined, errorText: string): boolean {
  if (errorCode !== undefined) return errorCode.toLowerCase() === "uia_provider_timeout";
  const normalizedText = errorText.toLowerCase();
  if (/\b(?:permission|access) denied\b|\b(?:refused|rejected|privacy|safety)\b|\b(?:window|target|geometry|bounds).{0,40}\b(?:not found|missing|mismatch|changed|invalid|unknown)\b/u.test(normalizedText)) {
    return false;
  }
  return /uia provider unresponsive/u.test(normalizedText) && /timed?\s*out|timeout/u.test(normalizedText);
}

export function sameWindowGeometry(left: CuaWindowGeometry, right: CuaWindowGeometry): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

export function windowActionTarget(binding: CuaWindowBinding): { kind: "window"; pid: number; window_id: number } {
  return { kind: "window", pid: binding.target.pid, window_id: binding.target.windowId };
}

function parseWindows(result: ToolResult): CuaWindowInfo[] {
  const value = parseStructured(result.structuredJson);
  const windows = value?.windows;
  if (!Array.isArray(windows)) throw new WindowContractError("WINDOW_TARGET_SCHEMA", "CUA list_windows returned no structured windows");
  return windows.flatMap((item) => {
    if (!isRecord(item)) return [];
    const pid = positiveSafeInteger(item.pid);
    const windowId = positiveSafeInteger(item.window_id);
    const bounds = parseGeometry(item.bounds);
    if (pid === undefined || windowId === undefined || bounds === undefined) return [];
    const title = boundedLabel(item.title);
    const appName = boundedLabel(item.app_name);
    const zIndex = integer(item.z_index ?? item.zIndex);
    const isOnScreenValue = item.is_on_screen ?? item.isOnScreen;
    const ownerPid = positiveSafeInteger(item.owner_pid ?? item.ownerPid);
    const ownerWindowId = positiveSafeInteger(item.owner_window_id ?? item.ownerWindowId);
    const minimized = typeof (item.is_minimized ?? item.minimized) === "boolean" ? (item.is_minimized ?? item.minimized) as boolean : undefined;
    const windowClass = boundedClassName(item.window_class ?? item.windowClass);
    return [{
      target: { pid, windowId },
      bounds,
      ...(title === undefined ? {} : { title }),
      ...(appName === undefined ? {} : { appName }),
      ...(zIndex === undefined ? {} : { zIndex }),
      ...(typeof isOnScreenValue === "boolean" ? { isOnScreen: isOnScreenValue } : {}),
      ...(ownerPid === undefined ? {} : { ownerPid }),
      ...(ownerWindowId === undefined ? {} : { ownerWindowId }),
      ...(minimized === undefined ? {} : { minimized }),
      ...(windowClass === undefined ? {} : { windowClass }),
    }];
  });
}

function boundedClassName(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || !/^[\x20-\x7e]+$/u.test(value)) return undefined;
  return value;
}

function boundedLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 240 ? trimmed : undefined;
}

function parseGeometry(value: unknown): CuaWindowGeometry | undefined {
  if (!isRecord(value)) return undefined;
  const x = integer(value.x);
  const y = integer(value.y);
  const width = positiveSafeInteger(value.width);
  const height = positiveSafeInteger(value.height);
  return x === undefined || y === undefined || width === undefined || height === undefined
    ? undefined
    : { x, y, width, height };
}

function positiveSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function parseStructured(value: string | undefined): Record<string, unknown> | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const MAX_CAPTURE_DIAGNOSTIC_IMAGES = 4;
const MAX_CAPTURE_DIAGNOSTIC_MIME_LENGTH = 64;

function summarizeCaptureImages(images: readonly unknown[]): string {
  const imageCount = images.length > MAX_CAPTURE_DIAGNOSTIC_IMAGES
    ? `${MAX_CAPTURE_DIAGNOSTIC_IMAGES}+`
    : String(images.length);
  const mimeTypes = images.slice(0, MAX_CAPTURE_DIAGNOSTIC_IMAGES).map((image) => {
    const mimeType = isRecord(image) ? image.mimeType : undefined;
    if (typeof mimeType !== "string" || mimeType.length === 0) return "unknown";
    const bounded = mimeType
      .replace(/[\u0000-\u001f\u007f]/gu, "?")
      .slice(0, MAX_CAPTURE_DIAGNOSTIC_MIME_LENGTH);
    return bounded.length === 0 ? "unknown" : bounded;
  });
  return `imageCount=${imageCount}, mimeTypes=${mimeTypes.length === 0 ? "none" : `[${mimeTypes.join(",")}]`}`;
}

function decodeBase64Png(value: string, imageSummary: string, label = "CUA window capture"): Uint8Array {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    throw new WindowContractError("WINDOW_CAPTURE_SCHEMA", `${label} returned invalid image data (${imageSummary})`);
  }
  const data = new Uint8Array(Buffer.from(value, "base64"));
  if (data.length === 0) throw new WindowContractError("WINDOW_CAPTURE_SCHEMA", `${label} returned empty image data (${imageSummary})`);
  return data;
}

function readPngDimensions(data: Uint8Array): { width: number; height: number } | undefined {
  if (data.length < 24) return undefined;
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((value, index) => data[index] === value)) return undefined;
  if (data[12] !== 73 || data[13] !== 72 || data[14] !== 68 || data[15] !== 82) return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}
