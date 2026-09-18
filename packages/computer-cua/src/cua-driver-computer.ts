import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CuaDriver,
  EndSessionInput,
  StartSessionInput,
  type CuaDriverLike,
} from "@trycua/cua-driver";
import type {
  ActionIntent,
  ActionReceipt,
  ComputerSessionDescriptor,
  ObservationCapture,
  ObservationId,
  Viewport,
} from "@computer-harness/protocol";
import type { Computer, ComputerExecuteOptions, ComputerOpenOptions } from "@computer-harness/runtime";
import {
  captureWindow,
  discoverWindow,
  sameWindowGeometry,
  validateWindowTarget,
  windowActionTarget,
  type CuaWindowBinding,
  type CuaWindowGeometry,
  type CuaWindowTarget,
  WindowContractError,
} from "./window-contract.js";

const PRIMARY_DESKTOP = { kind: "desktop", display_id: "primary" } as const;
const CLEANUP_POLL_INTERVAL_MS = 50;

export type CuaDriverFactory = (socketPath: string) => CuaDriverLike;

export interface CuaDriverComputerOptions {
  /** Explicit daemon endpoint. The adapter never falls back to embedded CUA. */
  socketPath: string;
  /** Where action observations are written before Runtime persists them as assets. */
  screenshotDir: string;
  /** Optional stable label; a generated label is used when omitted. */
  sessionLabel?: string;
  /** Explicit host-owned window opt-in; omitted means the existing desktop path. */
  windowTarget?: CuaWindowTarget;
  /** Total wall-clock budget for endSession/shutdown cleanup; no GUI action is retried. */
  cleanupWaitMs?: number;
  /** Test seam; production uses CuaDriver.connect. */
  driverFactory?: CuaDriverFactory;
}

interface PrivateSession {
  label: string;
  driver: CuaDriverLike;
  descriptor: ComputerSessionDescriptor;
  active: boolean;
  windowBinding?: CuaWindowBinding;
  windowIdentityInvalidated: boolean;
}

interface PendingDriverCleanup {
  label: string;
  driver: CuaDriverLike;
}

interface PrivateObservation {
  sessionId: string;
  geometry?: CuaWindowGeometry;
}

interface DriverErrorDetails {
  message: string;
  tag?: string;
  errorCode?: string;
}

export class CuaDriverComputer implements Computer {
  private readonly options: Required<Pick<CuaDriverComputerOptions, "socketPath" | "screenshotDir" | "cleanupWaitMs">> & Omit<CuaDriverComputerOptions, "socketPath" | "screenshotDir" | "cleanupWaitMs">;
  private readonly observations = new Map<string, PrivateObservation>();
  private latestObservationId: ObservationId | undefined;
  private session: PrivateSession | undefined;
  private pendingCleanup: PendingDriverCleanup | undefined;

  public constructor(options: CuaDriverComputerOptions) {
    if (!options.socketPath.trim()) {
      throw new Error("CuaDriverComputer requires an explicit daemon socketPath");
    }
    this.options = {
      ...options,
      socketPath: options.socketPath,
      screenshotDir: options.screenshotDir,
      cleanupWaitMs: options.cleanupWaitMs ?? 5000,
    };
    if (!Number.isInteger(this.options.cleanupWaitMs) || this.options.cleanupWaitMs <= 0) {
      throw new Error("cleanupWaitMs must be a positive integer");
    }
    if (this.options.windowTarget !== undefined) validateWindowTarget(this.options.windowTarget);
  }

  public async open(options: ComputerOpenOptions, signal: AbortSignal): Promise<ComputerSessionDescriptor> {
    if (this.pendingCleanup !== undefined) {
      throw new Error(`CUA computer cleanup for session ${this.pendingCleanup.label} is pending; resolve it before opening another`);
    }
    if (this.session !== undefined) {
      throw new Error(`computer session ${this.session.descriptor.id} is still retained; close it before opening another`);
    }
    signal.throwIfAborted();
    const driver = (this.options.driverFactory ?? ((socketPath) => CuaDriver.connect(socketPath)))(this.options.socketPath);
    const label = this.options.sessionLabel ?? `computer-harness-${Date.now()}`;
    let sessionStarted = false;
    try {
      await driver.startSession(StartSessionInput.new({ session: label }), { signal });
      sessionStarted = true;
      let viewport: Viewport;
      let windowBinding: CuaWindowBinding | undefined;
      if (this.options.windowTarget === undefined) {
        const size = await callTool(driver, "get_screen_size", { session: label }, signal);
        const dimensions = readStructuredDimensions(size);
        if (dimensions === undefined) {
          throw new Error("CUA get_screen_size did not return width/height");
        }
        viewport = { ...dimensions, coordinateSpace: "physical" };
      } else {
        windowBinding = await discoverWindow(driver, label, this.options.windowTarget, signal);
        // Capture once during open so the public session viewport describes the
        // actual image coordinates. No outer-frame correction is hard-coded.
        viewport = (await captureWindow(driver, label, windowBinding, signal)).viewport;
      }
      if (options.viewport !== undefined &&
          (options.viewport.width !== viewport.width || options.viewport.height !== viewport.height || options.viewport.coordinateSpace !== viewport.coordinateSpace)) {
        throw new Error(`requested viewport ${options.viewport.width}x${options.viewport.height}/${options.viewport.coordinateSpace} does not match CUA viewport ${viewport.width}x${viewport.height}/${viewport.coordinateSpace}`);
      }
      const descriptor: ComputerSessionDescriptor = {
        id: label as ComputerSessionDescriptor["id"],
        backend: "cua-driver-daemon",
        viewport,
        capabilities: { screenshot: true, pointer: true, keyboard: windowBinding === undefined, accessibility: false },
        openedAt: new Date().toISOString(),
      };
      this.session = {
        label,
        driver,
        descriptor,
        active: true,
        windowIdentityInvalidated: false,
        ...(windowBinding === undefined ? {} : { windowBinding }),
      };
      return descriptor;
    } catch (error) {
      const cleanupCompleted = await bestEffortCloseDriver(driver, label, this.options.cleanupWaitMs, sessionStarted);
      if (!cleanupCompleted) this.pendingCleanup = { label, driver };
      throw normalizeDriverError(error, "open");
    }
  }

  public async observe(
    session: ComputerSessionDescriptor,
    observationId: ObservationId,
    signal: AbortSignal,
  ): Promise<ObservationCapture> {
    const current = this.requireSession(session);
    signal.throwIfAborted();
    if (current.windowBinding !== undefined) {
      if (current.windowIdentityInvalidated) {
        throw normalizeDriverError(new WindowContractError("WINDOW_TARGET_INVALIDATED", "window target identity was invalidated; close and open a new session"), "observe");
      }
      try {
        const liveBinding = await discoverWindow(current.driver, current.label, current.windowBinding.target, signal);
        const capture = await captureWindow(current.driver, current.label, liveBinding, signal);
        current.windowBinding = liveBinding;
        current.descriptor = { ...current.descriptor, viewport: capture.viewport };
        this.observations.set(String(observationId), { sessionId: String(session.id), geometry: liveBinding.bounds });
        this.latestObservationId = observationId;
        return {
          capturedAt: new Date().toISOString(),
          viewport: capture.viewport,
          screenshot: { mediaType: "image/png", data: capture.data },
        };
      } catch (error) {
        const details = driverErrorDetails(error);
        if (error instanceof WindowContractError && error.code === "WINDOW_TARGET_NOT_FOUND") current.windowIdentityInvalidated = true;
        if (details.tag === "Transport") current.active = false;
        throw normalizeDriverError(error, "observe");
      }
    }
    await mkdir(this.options.screenshotDir, { recursive: true });
    const fileName = `${safeId(String(observationId))}.png`;
    const screenshotPath = join(this.options.screenshotDir, fileName);
    try {
      const result = await callTool(current.driver, "get_desktop_state", {
        session: current.label,
        screenshot_out_file: screenshotPath,
      }, signal);
      const dimensions = readStructuredScreenshotDimensions(result) ?? await readPngDimensions(screenshotPath);
      if (dimensions === undefined) {
        throw new Error("CUA get_desktop_state did not return screenshot dimensions");
      }
      if (dimensions.width !== current.descriptor.viewport.width || dimensions.height !== current.descriptor.viewport.height) {
        throw new Error(`CUA screenshot ${dimensions.width}x${dimensions.height} does not match opened viewport ${current.descriptor.viewport.width}x${current.descriptor.viewport.height}`);
      }
      const data = new Uint8Array(await readFile(screenshotPath));
      this.observations.set(String(observationId), { sessionId: String(session.id) });
      this.latestObservationId = observationId;
      return {
        capturedAt: new Date().toISOString(),
        viewport: current.descriptor.viewport,
        screenshot: { mediaType: "image/png", data },
      };
    } catch (error) {
      const details = driverErrorDetails(error);
      if (details.tag === "Transport") {
        current.active = false;
      }
      throw normalizeDriverError(error, "observe");
    }
  }

  public async execute(
    session: ComputerSessionDescriptor,
    action: ActionIntent,
    signal: AbortSignal,
    options?: ComputerExecuteOptions,
  ): Promise<ActionReceipt> {
    const current = this.requireSession(session);
    signal.throwIfAborted();
    if (action.kind !== "wait") {
      const observation = this.observations.get(String(action.basedOn));
      if (observation === undefined || observation.sessionId !== String(session.id)) {
        return refused(action.actionId, "OBSERVATION_NOT_FOUND", `action is based on unknown observation ${String(action.basedOn)}`);
      }
      const executionObservationId = options?.executionObservationId ?? action.basedOn;
      if (executionObservationId !== this.latestObservationId) {
        return refused(action.actionId, "STALE_OBSERVATION", `action executes against stale observation ${String(executionObservationId)}`);
      }
    }
    if (action.kind === "wait") {
      await waitWithAbort(action.durationMs, signal);
      return { actionId: action.actionId, status: "completed" };
    }
    if (current.windowBinding !== undefined) {
      if (current.windowIdentityInvalidated) {
        return refused(action.actionId, "WINDOW_TARGET_INVALIDATED", "window target identity was invalidated; close and open a new session");
      }
      if (action.kind === "type" || action.kind === "keypress") {
        return refused(action.actionId, "WINDOW_INPUT_UNSUPPORTED", "window keyboard input is disabled until focus delivery is independently verified");
      }
      if (action.kind !== "click") {
        return refused(action.actionId, "WINDOW_ACTION_UNSUPPORTED", "this window-target primitive is not enabled by the verified coordinate contract");
      }
      const observation = this.observations.get(String(action.basedOn));
      if (observation?.geometry === undefined) {
        return refused(action.actionId, "WINDOW_GEOMETRY_UNKNOWN", "window action is not bound to verified window geometry");
      }
      try {
        const liveBinding = await discoverWindow(current.driver, current.label, current.windowBinding.target, signal);
        if (!sameWindowGeometry(liveBinding.bounds, observation.geometry)) {
          return refused(action.actionId, "WINDOW_GEOMETRY_CHANGED", "window geometry changed since the action observation");
        }
        current.windowBinding = liveBinding;
      } catch (error) {
        const details = driverErrorDetails(error);
        if (details.tag === "Transport") current.active = false;
        if (error instanceof WindowContractError) {
          if (error.code === "WINDOW_TARGET_NOT_FOUND") current.windowIdentityInvalidated = true;
          return refused(action.actionId, error.code, error.message);
        }
        return refused(action.actionId, "WINDOW_TARGET_UNKNOWN", "window target could not be verified before action");
      }
    }
    const request = actionRequest(action, current.label, current.windowBinding);
    try {
      const result = await callTool(current.driver, request.name, request.arguments, signal);
      if (result.isError) {
        return refused(action.actionId, result.errorCode ?? "CUA_TOOL_REFUSED", result.text);
      }
      if (result.degraded) {
        return { actionId: action.actionId, status: "failed", driverCode: "CUA_DEGRADED", message: result.text };
      }
      return { actionId: action.actionId, status: "completed", ...(result.text ? { message: result.text } : {}) };
    } catch (error) {
      const details = driverErrorDetails(error);
      if (details.tag === "Transport") {
        current.active = false;
      }
      // A thrown transport/abort/unknown error may follow a real side effect.
      // Do not manufacture a terminal receipt and never retry here; Runtime
      // records the unresolved action as outcome_unknown. Only explicit
      // structured Tool errors are safe to classify as a refusal.
      if (details.tag === "Tool") {
        return refused(action.actionId, details.errorCode ?? "CUA_TOOL_REFUSED", details.message);
      }
      throw normalizeDriverError(error, "execute");
    }
  }

  public async close(session: ComputerSessionDescriptor): Promise<void> {
    const current = this.session;
    if (current === undefined || String(current.descriptor.id) !== String(session.id)) {
      throw new Error(`unknown CUA computer session ${String(session.id)}`);
    }
    this.observations.forEach((_value, key) => {
      if (_value.sessionId === String(session.id)) this.observations.delete(key);
    });
    this.latestObservationId = undefined;
    const deadline = Date.now() + this.options.cleanupWaitMs;
    try {
      let result;
      try {
        result = await awaitWithDeadline(
          () => current.driver.endSession(EndSessionInput.new({ session: current.label })),
          deadline,
          "endSession",
        );
      } catch (error) {
        const details = driverErrorDetails(error);
        if (details.errorCode !== "session_cleanup_pending" && !/session_cleanup_pending/i.test(details.message)) {
          throw error;
        }
        await waitForCleanupPoll(deadline);
        result = await awaitWithDeadline(
          () => current.driver.endSession(EndSessionInput.new({ session: current.label })),
          deadline,
          "endSession",
        );
      }
      if (result.active) {
        await waitForCleanupPoll(deadline);
        result = await awaitWithDeadline(
          () => current.driver.endSession(EndSessionInput.new({ session: current.label })),
          deadline,
          "endSession",
        );
      }
      if (result.active) {
        await waitForCleanupPoll(deadline);
        result = await awaitWithDeadline(
          () => current.driver.endSession(EndSessionInput.new({ session: current.label })),
          deadline,
          "endSession",
        );
      }
      if (result.active) {
        throw new Error(`CUA session ${current.label} remained active after bounded close`);
      }
      await awaitWithDeadline(() => current.driver.shutdown(), deadline, "shutdown");
      current.active = false;
      this.session = undefined;
      destroyDriver(current.driver);
    } catch (error) {
      current.active = false;
      throw normalizeDriverError(error, "close");
    }
  }

  private requireSession(session: ComputerSessionDescriptor): PrivateSession {
    const current = this.session;
    if (current === undefined || String(current.descriptor.id) !== String(session.id)) {
      throw new Error(`unknown CUA computer session ${String(session.id)}`);
    }
    if (!current.active) {
      throw new Error(`CUA computer session ${String(session.id)} is inactive; open a new session`);
    }
    return current;
  }
}

function actionRequest(action: Exclude<ActionIntent, { kind: "wait" }>, session: string, windowBinding?: CuaWindowBinding): { name: string; arguments: Record<string, unknown> } {
  const target = windowBinding === undefined ? PRIMARY_DESKTOP : windowActionTarget(windowBinding);
  const deliveryMode = windowBinding === undefined ? "foreground" : "background";
  switch (action.kind) {
    case "click":
      return { name: "click", arguments: { session, target, x: action.point.x, y: action.point.y, delivery_mode: deliveryMode } };
    case "double_click":
      return { name: "click", arguments: { session, target, x: action.point.x, y: action.point.y, count: 2, delivery_mode: deliveryMode } };
    case "right_click":
      return { name: "click", arguments: { session, target, x: action.point.x, y: action.point.y, button: "right", delivery_mode: deliveryMode } };
    case "type":
      return { name: "type_text", arguments: { session, target, text: action.text, delivery_mode: deliveryMode } };
    case "keypress":
      return action.keys.length === 1
        ? { name: "press_key", arguments: { session, target, key: action.keys[0], delivery_mode: deliveryMode } }
        : { name: "hotkey", arguments: { session, target, keys: action.keys, delivery_mode: deliveryMode } };
    case "scroll":
      return { name: "scroll", arguments: { session, target, x: action.point.x, y: action.point.y, direction: action.direction, by: "line", amount: action.ticks, delivery_mode: deliveryMode } };
    case "drag":
      return { name: "drag", arguments: { session, target, from_x: action.from.x, from_y: action.from.y, to_x: action.to.x, to_y: action.to.y, delivery_mode: deliveryMode } };
    default:
      return assertNever(action);
  }
}

async function callTool(driver: CuaDriverLike, name: string, input: Record<string, unknown>, signal: AbortSignal) {
  return driver.callTool(name, JSON.stringify(input), { signal });
}

function readStructuredDimensions(result: { structuredJson?: string }): { width: number; height: number } | undefined {
  if (typeof result.structuredJson !== "string") return undefined;
  try {
    const value = JSON.parse(result.structuredJson) as Record<string, unknown>;
    return dimensions(value.width, value.height);
  } catch { return undefined; }
}

function readStructuredScreenshotDimensions(result: { structuredJson?: string }): { width: number; height: number } | undefined {
  if (typeof result.structuredJson !== "string") return undefined;
  try {
    const value = JSON.parse(result.structuredJson) as Record<string, unknown>;
    return dimensions(value.screenshot_width, value.screenshot_height);
  } catch { return undefined; }
}

function dimensions(width: unknown, height: unknown): { width: number; height: number } | undefined {
  return typeof width === "number" && Number.isInteger(width) && width > 0 && typeof height === "number" && Number.isInteger(height) && height > 0
    ? { width, height }
    : undefined;
}

async function readPngDimensions(path: string): Promise<{ width: number; height: number } | undefined> {
  try {
    const bytes = await readFile(path);
    if (bytes.length < 24 || bytes.toString("ascii", 1, 4) !== "PNG" || bytes.toString("ascii", 12, 16) !== "IHDR") return undefined;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  } catch { return undefined; }
}

function safeId(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "_");
  return safe || "observation";
}

function refused(actionId: ActionReceipt["actionId"], driverCode: string, message: string): ActionReceipt {
  return { actionId, status: "refused", driverCode, message };
}

function driverErrorDetails(error: unknown): DriverErrorDetails {
  const message = error instanceof Error ? error.message : String(error);
  if (!error || typeof error !== "object") return { message };
  const record = error as Record<string, unknown>;
  const inner = record.inner && typeof record.inner === "object" ? record.inner as Record<string, unknown> : undefined;
  const innerMessage = typeof inner?.message === "string"
    ? inner.message
    : typeof inner?.reason === "string"
      ? inner.reason
      : message;
  return {
    message: innerMessage,
    ...(typeof record.tag === "string" ? { tag: record.tag } : {}),
    ...(typeof inner?.errorCode === "string" ? { errorCode: inner.errorCode } : {}),
  };
}

function normalizeDriverError(error: unknown, operation: string): Error {
  const details = driverErrorDetails(error);
  return new Error(`CUA ${operation} failed${details.errorCode ? ` [${details.errorCode}]` : ""}: ${details.message}`);
}

async function bestEffortCloseDriver(driver: CuaDriverLike, label: string, waitMs: number, sessionStarted: boolean): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  let safeToDestroy = !sessionStarted;
  try {
    let result;
    try {
      result = await awaitWithDeadline(() => driver.endSession(EndSessionInput.new({ session: label })), deadline, "endSession");
    } catch (error) {
      const details = driverErrorDetails(error);
      if (details.errorCode !== "session_cleanup_pending" && !/session_cleanup_pending/i.test(details.message)) {
        // After startSession succeeds, a transport/unknown failure leaves the
        // driver ownership unresolved.  Retaining it is safer than destroy().
        if (sessionStarted) return false;
        throw error;
      }
      await waitForCleanupPoll(deadline);
      result = await awaitWithDeadline(() => driver.endSession(EndSessionInput.new({ session: label })), deadline, "endSession");
    }
    if (result.active) {
      await waitForCleanupPoll(deadline);
      result = await awaitWithDeadline(() => driver.endSession(EndSessionInput.new({ session: label })), deadline, "endSession");
      if (result.active) return false;
    }
    safeToDestroy = true;
  } catch (error) {
    if (sessionStarted) return false;
    safeToDestroy = !isCleanupDeadlineError(error);
  }
  if (safeToDestroy) {
    try {
      await awaitWithDeadline(() => driver.shutdown(), deadline, "shutdown");
    } catch (error) {
      // A started session is not released until shutdown is confirmed too.
      if (sessionStarted) return false;
      safeToDestroy = !isCleanupDeadlineError(error);
    }
  }
  if (safeToDestroy) destroyDriver(driver);
  return safeToDestroy;
}

class CleanupDeadlineError extends Error {
  public constructor(operation: string) {
    super(`cleanup deadline exceeded during ${operation}`);
    this.name = "CleanupDeadlineError";
  }
}

function isCleanupDeadlineError(error: unknown): boolean {
  return error instanceof CleanupDeadlineError;
}

async function awaitWithDeadline<T>(work: () => Promise<T>, deadline: number, operation: string): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new CleanupDeadlineError(operation);
  const settled = Promise.resolve().then(work).then(
    (value) => ({ status: "completed" as const, value }),
    (error: unknown) => ({ status: "failed" as const, error }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ status: "timed_out" }>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timed_out" }), remaining);
  });
  const result = await Promise.race([settled, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  if (result.status === "timed_out") throw new CleanupDeadlineError(operation);
  if (result.status === "failed") throw result.error;
  return result.value;
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

async function waitForCleanupPoll(deadline: number): Promise<void> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new CleanupDeadlineError("cleanup wait");
  const interval = Math.min(CLEANUP_POLL_INTERVAL_MS, Math.max(1, Math.floor(remaining / 2)));
  await awaitWithDeadline(() => delay(interval), deadline, "cleanup wait");
}

function destroyDriver(driver: CuaDriverLike): void {
  const destroy = (driver as unknown as { uniffiDestroy?: () => void }).uniffiDestroy;
  destroy?.call(driver);
}

async function waitWithAbort(durationMs: number, signal: AbortSignal): Promise<void> {
  if (durationMs === 0) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("wait aborted"));
    };
    timer = setTimeout(() => {
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, durationMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function assertNever(value: never): never {
  throw new Error(`unsupported CUA action ${String(value)}`);
}
