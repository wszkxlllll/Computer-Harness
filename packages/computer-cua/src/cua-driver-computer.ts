import { mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  CaptureScope,
  CuaDriver,
  EndSessionInput,
  StartSessionInput,
  type CuaDriverLike,
} from "@trycua/cua-driver";
import type {
  ActionIntent,
  ActionReceipt,
  ComputerSessionDescriptor,
  GroundingCatalog,
  GroundingElement,
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
export type CuaWindowDeliveryMode = "background" | "foreground";
export type CuaGroundingMode = "off" | "uia-catalog-v1";

// Keep the adapter side bounded but larger than the model-facing hot set. The
// Runtime selector narrows this to at most 16 before Observation persistence;
// the private ref map still retains every safe candidate here for the current
// Computer session. Depth 16 is needed for real browser document descendants;
// the hard element cap prevents an unbounded UIA tree from entering Runtime.
const GROUNDING_MAX_ELEMENTS = 256;
const GROUNDING_QUERY_MAX_ELEMENTS = 256;

export interface CuaDriverComputerOptions {
  /** Explicit daemon endpoint. The adapter never falls back to embedded CUA. */
  socketPath: string;
  /** Where action observations are written before Runtime persists them as assets. */
  screenshotDir: string;
  /** Optional stable label; a generated label is used when omitted. */
  sessionLabel?: string;
  /** Explicit host-owned window opt-in; omitted means the existing desktop path. */
  windowTarget?: CuaWindowTarget;
  /**
   * Delivery is explicit per window Run. Background never escalates; foreground
   * asks CUA to deliver to this target. It is not a desktop fallback or a
   * sandbox, and foreground restoration/occlusion are driver-dependent. The
   * default preserves the existing background route.
   */
  windowDeliveryMode?: CuaWindowDeliveryMode;
  /** Optional, explicit UIA sidecar; requires an explicit window target. */
  grounding?: CuaGroundingMode;
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
  /** One confirmed click point that may establish renderer focus for the next type action. */
  pendingWindowTypePoint?: { x: number; y: number };
  /** Last confirmed click point used to focus a renderer before a window hotkey. */
  windowHotkeyPoint?: { x: number; y: number };
  windowIdentityInvalidated: boolean;
}

interface PendingDriverCleanup {
  label: string;
  driver: CuaDriverLike;
}

interface PrivateObservation {
  sessionId: string;
  /**
   * The image coordinate space that the model used for this observation.
   * Window actions must be projected from this viewport, not from the
   * current session viewport (which may belong to a later observation).
   */
  viewport: Viewport;
  geometry?: CuaWindowGeometry;
}

interface PrivateGrounding {
  readonly catalog: GroundingCatalog;
  readonly elements: ReadonlyMap<string, {
    readonly element: GroundingElement;
    readonly point: { readonly x: number; readonly y: number };
    readonly geometry?: CuaWindowGeometry;
  }>;
}

class WindowCoordinateMappingError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "WindowCoordinateMappingError";
  }
}

interface DriverErrorDetails {
  message: string;
  tag?: string;
  errorCode?: string;
}

export class CuaDriverComputer implements Computer {
  private readonly options: Required<Pick<CuaDriverComputerOptions, "socketPath" | "screenshotDir" | "cleanupWaitMs">> & Omit<CuaDriverComputerOptions, "socketPath" | "screenshotDir" | "cleanupWaitMs">;
  private readonly observations = new Map<string, PrivateObservation>();
  private readonly groundings = new Map<string, PrivateGrounding>();
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
    if (this.options.windowDeliveryMode !== undefined
      && this.options.windowDeliveryMode !== "background"
      && this.options.windowDeliveryMode !== "foreground") {
      throw new Error("windowDeliveryMode must be background or foreground");
    }
    if (this.options.windowTarget !== undefined) validateWindowTarget(this.options.windowTarget);
    if (this.options.grounding !== undefined && this.options.grounding !== "off" && this.options.grounding !== "uia-catalog-v1") {
      throw new Error("grounding must be off or uia-catalog-v1");
    }
    if (this.options.grounding === "uia-catalog-v1" && this.options.windowTarget === undefined) {
      throw new Error("uia-catalog-v1 grounding requires an explicit CUA window target");
    }
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
      await driver.startSession(StartSessionInput.new({
        session: label,
        // Keep the shared Computer contract explicit across platforms. On
        // macOS CUA 0.22.2, Auto intentionally resolves to Window; the
        // primary-desktop adapter must request Desktop while an explicit
        // host-selected window stays least-privilege Window.
        captureScope: this.options.windowTarget === undefined ? CaptureScope.Desktop : CaptureScope.Window,
      }), { signal });
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
        // The explicit window route uses the driver's targeted delivery for
        // the verified input primitives below. It never falls back to the
        // primary desktop, so advertising keyboard here does not mean that
        // the OS foreground focus is owned by this session.
        capabilities: {
          screenshot: true,
          pointer: true,
          keyboard: windowBinding === undefined || this.options.windowDeliveryMode === "foreground",
          accessibility: this.options.grounding === "uia-catalog-v1",
        },
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
        if (!sameWindowGeometry(liveBinding.bounds, current.windowBinding.bounds)) {
          delete current.pendingWindowTypePoint;
          delete current.windowHotkeyPoint;
        }
        const capture = await captureWindow(current.driver, current.label, liveBinding, signal);
        current.windowBinding = liveBinding;
        current.descriptor = { ...current.descriptor, viewport: capture.viewport };
        const grounding = this.options.grounding === "uia-catalog-v1"
          ? await readGroundingCatalog(current.driver, current.label, liveBinding, capture.viewport, observationId, session.id, signal)
          : undefined;
        this.observations.set(String(observationId), {
          sessionId: String(session.id),
          viewport: capture.viewport,
          geometry: liveBinding.bounds,
        });
        if (grounding !== undefined) this.groundings.set(String(observationId), grounding);
        this.latestObservationId = observationId;
        return {
          capturedAt: new Date().toISOString(),
          viewport: capture.viewport,
          screenshot: { mediaType: "image/png", data: capture.data },
          ...(grounding === undefined ? {} : { grounding: grounding.catalog }),
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
      this.observations.set(String(observationId), {
        sessionId: String(session.id),
        viewport: current.descriptor.viewport,
      });
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
    let decisionObservation: PrivateObservation | undefined;
    if (action.kind !== "wait") {
      decisionObservation = this.observations.get(String(action.basedOn));
      if (decisionObservation === undefined || decisionObservation.sessionId !== String(session.id)) {
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
      if (action.kind === "double_click" || action.kind === "right_click") {
        return refused(action.actionId, "WINDOW_ACTION_UNSUPPORTED", "this window-target primitive is not enabled by the verified coordinate contract");
      }
      if (action.kind === "scroll" && this.options.windowDeliveryMode !== "foreground") {
        return refused(action.actionId, "WINDOW_ACTION_UNSUPPORTED", "window scroll requires explicit foreground delivery");
      }
      if (action.kind === "drag" && this.options.windowDeliveryMode !== "foreground") {
        return refused(action.actionId, "WINDOW_ACTION_UNSUPPORTED", "window drag requires explicit foreground delivery");
      }
      if (action.kind === "keypress" && action.keys.length > 1 && this.options.windowDeliveryMode !== "foreground") {
        return refused(action.actionId, "WINDOW_INPUT_UNSUPPORTED", "window hotkey requires explicit foreground delivery");
      }
      if ((action.kind === "type" || action.kind === "keypress") && this.options.windowDeliveryMode !== "foreground") {
        return refused(action.actionId, "WINDOW_INPUT_UNSUPPORTED", "window keyboard input requires explicit foreground delivery");
      }
      if (decisionObservation?.geometry === undefined) {
        return refused(action.actionId, "WINDOW_GEOMETRY_UNKNOWN", "window action is not bound to verified window geometry");
      }
      try {
        const liveBinding = await discoverWindow(current.driver, current.label, current.windowBinding.target, signal);
        if (!sameWindowGeometry(liveBinding.bounds, decisionObservation.geometry)) {
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
    let requestAction = action;
    if (action.groundingRef !== undefined) {
      if (action.kind !== "click") {
        return refused(action.actionId, "GROUNDING_ACTION_UNSUPPORTED", "grounding references are only valid for click actions");
      }
      const privateGrounding = this.groundings.get(String(action.basedOn));
      const resolved = privateGrounding?.elements.get(action.groundingRef);
      if (resolved === undefined) {
        return refused(action.actionId, "GROUNDING_REF_STALE", "UIA element reference is stale or unavailable; observe again and choose a current element");
      }
      if (resolved.element.state?.enabled === false) {
        return refused(action.actionId, "GROUNDING_ELEMENT_DISABLED", "UIA element is explicitly disabled and cannot receive a click");
      }
      if (resolved.geometry !== undefined && decisionObservation?.geometry !== undefined && !sameWindowGeometry(resolved.geometry, decisionObservation.geometry)) {
        return refused(action.actionId, "GROUNDING_GEOMETRY_CHANGED", "UIA element reference was created for an older window geometry");
      }
      if (Math.abs(action.point.x - resolved.point.x) > 0.01 || Math.abs(action.point.y - resolved.point.y) > 0.01) {
        return refused(action.actionId, "GROUNDING_POINT_MISMATCH", "grounding click point does not match the current element bounds");
      }
      requestAction = { ...action, point: resolved.point };
    }
    let request: { name: string; arguments: Record<string, unknown> };
    try {
      request = actionRequest(
        requestAction,
        current.label,
        current.windowBinding,
        this.options.windowDeliveryMode,
        decisionObservation?.viewport,
        current.pendingWindowTypePoint,
        current.windowHotkeyPoint,
      );
    } catch (error) {
      if (error instanceof WindowCoordinateMappingError) {
        return refused(action.actionId, error.code, error.message);
      }
      throw error;
    }
    try {
      const result = await callTool(current.driver, request.name, request.arguments, signal);
      if (result.isError) {
        return refused(action.actionId, result.errorCode ?? "CUA_TOOL_REFUSED", result.text);
      }
      if (result.degraded) {
        return { actionId: action.actionId, status: "failed", driverCode: "CUA_DEGRADED", message: result.text };
      }
      if (current.windowBinding !== undefined && action.kind === "click") {
        const x = request.arguments.x;
        const y = request.arguments.y;
        if (typeof x === "number" && typeof y === "number") {
          current.pendingWindowTypePoint = { x, y };
          current.windowHotkeyPoint = { x, y };
        }
      } else if (current.windowBinding !== undefined && action.kind === "type") {
        delete current.pendingWindowTypePoint;
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
    this.groundings.clear();
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

function actionRequest(
  action: Exclude<ActionIntent, { kind: "wait" }>,
  session: string,
  windowBinding?: CuaWindowBinding,
  configuredDeliveryMode?: CuaWindowDeliveryMode,
  decisionViewport?: Viewport,
  pendingWindowTypePoint?: { x: number; y: number },
  windowHotkeyPoint?: { x: number; y: number },
): { name: string; arguments: Record<string, unknown> } {
  const target = windowBinding === undefined ? PRIMARY_DESKTOP : windowActionTarget(windowBinding);
  const deliveryMode = windowBinding === undefined ? "foreground" : configuredDeliveryMode ?? "background";
  const point = (value: { x: number; y: number }) => windowBinding === undefined
    ? value
    : mapWindowPoint(value, decisionViewport, windowBinding.bounds);
  switch (action.kind) {
    case "click":
      return { name: "click", arguments: { session, target, ...point(action.point), delivery_mode: deliveryMode } };
    case "double_click":
      return { name: "click", arguments: { session, target, ...point(action.point), count: 2, delivery_mode: deliveryMode } };
    case "right_click":
      return { name: "click", arguments: { session, target, ...point(action.point), button: "right", delivery_mode: deliveryMode } };
    case "type":
      return {
        name: "type_text",
        arguments: {
          session,
          target,
          text: action.text,
          delivery_mode: deliveryMode,
          ...(windowBinding === undefined || pendingWindowTypePoint === undefined ? {} : pendingWindowTypePoint),
        },
      };
    case "keypress":
      return action.keys.length === 1
        ? { name: "press_key", arguments: { session, target, key: action.keys[0], delivery_mode: deliveryMode } }
        : {
            name: "hotkey",
            arguments: {
              session,
              target,
              keys: action.keys,
              delivery_mode: deliveryMode,
              ...(windowBinding === undefined || windowHotkeyPoint === undefined ? {} : windowHotkeyPoint),
            },
          };
    case "scroll":
      return { name: "scroll", arguments: { session, target, ...point(action.point), direction: action.direction, by: "line", amount: action.ticks, delivery_mode: deliveryMode } };
    case "drag": {
      const from = point(action.from);
      const to = point(action.to);
      return { name: "drag", arguments: { session, target, from_x: from.x, from_y: from.y, to_x: to.x, to_y: to.y, delivery_mode: deliveryMode } };
    }
    default:
      return assertNever(action);
  }
}

type GroundingToolResult = {
  readonly isError?: boolean;
  readonly degraded?: boolean;
  readonly structuredJson?: string;
};

async function readGroundingCatalog(
  driver: CuaDriverLike,
  session: string,
  binding: CuaWindowBinding,
  viewport: Viewport,
  observationId: ObservationId,
  computerSessionId: ComputerSessionDescriptor["id"],
  signal: AbortSignal,
): Promise<PrivateGrounding> {
  const empty = (completeness: "partial" | "unknown", degraded: boolean): PrivateGrounding => ({
    catalog: {
      version: "uia-catalog-v1",
      source: "uia",
      observationId,
      computerSessionId,
      completeness,
      degraded,
      maxElements: GROUNDING_MAX_ELEMENTS,
      elements: [],
    },
    elements: new Map(),
  });
  let result: GroundingToolResult;
  try {
    result = await callTool(driver, "get_window_state", {
      pid: binding.target.pid,
      window_id: binding.target.windowId,
      include_screenshot: false,
      max_depth: 16,
      max_elements: GROUNDING_QUERY_MAX_ELEMENTS,
      session,
    }, signal);
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted();
    if (error instanceof Error && error.name === "AbortError") throw error;
    return empty("unknown", true);
  }
  if (result.isError === true) return empty("unknown", true);
  const structured = parseStructuredRecord(result.structuredJson);
  const rawElements = structured?.elements;
  if (!Array.isArray(rawElements)) return empty("unknown", true);
  const parsed = rawElements.flatMap((value, index) => parseGroundingCandidate(value, index, binding, viewport));
  parsed.sort((left, right) => left.priority - right.priority || left.sortKey.localeCompare(right.sortKey));
  const selected = parsed.slice(0, GROUNDING_MAX_ELEMENTS);
  const elements = new Map<string, { readonly element: GroundingElement; readonly point: { readonly x: number; readonly y: number }; readonly geometry: CuaWindowGeometry }>();
  const publicElements = selected.map((candidate, index) => {
    const elementRef = `uia-${groundingObservationDiscriminator(observationId)}-${index + 1}`;
    const element: GroundingElement = { ...candidate.element, elementRef };
    elements.set(elementRef, { element, point: candidate.point, geometry: binding.bounds });
    return element;
  });
  const explicitlyComplete = structured?.complete === true || structured?.elements_complete === true;
  const truncated = structured?.truncated === true || structured?.degraded === true || rawElements.length > GROUNDING_MAX_ELEMENTS;
  const completeness = explicitlyComplete && !truncated ? "complete" : "partial";
  return {
    catalog: {
      version: "uia-catalog-v1",
      source: "uia",
      observationId,
      computerSessionId,
      completeness,
      degraded: Boolean(result.degraded) || structured?.degraded === true || structured?.truncated === true,
      maxElements: GROUNDING_MAX_ELEMENTS,
      elements: publicElements,
    },
    elements,
  };
}

interface GroundingCandidate {
  readonly element: Omit<GroundingElement, "elementRef">;
  readonly point: { readonly x: number; readonly y: number };
  readonly priority: number;
  readonly sortKey: string;
}

function parseGroundingCandidate(
  value: unknown,
  index: number,
  binding: CuaWindowBinding,
  viewport: Viewport,
): GroundingCandidate[] {
  const item = parseStructuredRecord(value);
  if (item === undefined) return [];
  const role = boundedGroundingLabel(item.role, 64);
  const frame = parseGroundingFrame(item.frame);
  if (role === undefined || frame === undefined) return [];
  // UIA frames are desktop/global coordinates in the native window space.
  // First translate to window-local native pixels, then map into the actual
  // screenshot viewport. The screenshot can be smaller than native bounds
  // because of client capture/DPI scaling; treating the native frame as an
  // image coordinate would apply the scale twice during execution.
  const localNative = {
    x: frame.x - binding.bounds.x,
    y: frame.y - binding.bounds.y,
    width: frame.width,
    height: frame.height,
  };
  const scaled = {
    x: localNative.x * viewport.width / binding.bounds.width,
    y: localNative.y * viewport.height / binding.bounds.height,
    width: localNative.width * viewport.width / binding.bounds.width,
    height: localNative.height * viewport.height / binding.bounds.height,
  };
  const clipped = intersectGroundingFrame(scaled, viewport.width, viewport.height);
  if (clipped === undefined) return [];
  const name = boundedGroundingLabel(item.name ?? item.label ?? item.title, 160);
  const description = boundedGroundingLabel(item.description ?? item.help_text, 240);
  const state = groundingState(item);
  const element: Omit<GroundingElement, "elementRef"> = {
    role,
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    bbox: { ...clipped, coordinateSpace: "physical" },
    ...(state === undefined ? {} : { state }),
  };
  const point = { x: clipped.x + clipped.width / 2, y: clipped.y + clipped.height / 2 };
  const priority = state?.enabled === false
    ? 20
    : state?.editable === true
      ? 0
      : state?.focused === true
        ? 1
        : state?.enabled === true && name !== undefined
          ? 2
          : name === undefined ? 4 : 3;
  return [{ element, point, priority, sortKey: `${role}\u0000${name ?? ""}\u0000${index.toString().padStart(8, "0")}` }];
}

function groundingState(item: Record<string, unknown>): GroundingElement["state"] | undefined {
  const enabled = booleanField(item, "enabled") ?? booleanField(item, "is_enabled");
  const focused = booleanField(item, "focused") ?? booleanField(item, "is_focused");
  const editable = booleanField(item, "editable") ?? booleanField(item, "is_editable");
  const expanded = booleanField(item, "expanded") ?? booleanField(item, "is_expanded");
  const selected = booleanField(item, "selected") ?? booleanField(item, "checked") ?? booleanField(item, "is_selected");
  const value = item.value;
  const valuePresent = value !== undefined && value !== null && (typeof value !== "string" || value.length > 0);
  if (enabled === undefined && focused === undefined && editable === undefined && expanded === undefined && selected === undefined && !valuePresent) return undefined;
  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(focused === undefined ? {} : { focused }),
    ...(editable === undefined ? {} : { editable }),
    ...(expanded === undefined ? {} : { expanded }),
    ...(selected === undefined ? {} : { selected }),
    ...(valuePresent ? { valuePresent: true } : {}),
  };
}

function parseGroundingFrame(value: unknown): CuaWindowGeometry | undefined {
  const item = parseStructuredRecord(value);
  if (item === undefined) return undefined;
  const x = finiteNumber(item.x);
  const y = finiteNumber(item.y);
  const width = finiteNumber(item.width ?? item.w);
  const height = finiteNumber(item.height ?? item.h);
  return x === undefined || y === undefined || width === undefined || height === undefined || width <= 0 || height <= 0
    ? undefined
    : { x, y, width, height };
}

function intersectGroundingFrame(
  frame: CuaWindowGeometry,
  viewportWidth: number,
  viewportHeight: number,
): { x: number; y: number; width: number; height: number } | undefined {
  const left = Math.max(0, frame.x);
  const top = Math.max(0, frame.y);
  const right = Math.min(viewportWidth, frame.x + frame.width);
  const bottom = Math.min(viewportHeight, frame.y + frame.height);
  return right <= left || bottom <= top ? undefined : { x: left, y: top, width: right - left, height: bottom - top };
}

function boundedGroundingLabel(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replace(/[\u0000-\u001F\u007F]/gu, " ")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[redacted-email]")
    .replace(/\b1\d{10}\b/gu, "[redacted-phone]")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized.length === 0 ? undefined : normalized.slice(0, maxLength);
}

function booleanField(item: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) if (typeof item[key] === "boolean") return item[key] as boolean;
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function groundingObservationDiscriminator(observationId: ObservationId): string {
  return createHash("sha256").update(String(observationId)).digest("hex").slice(0, 12);
}

function parseStructuredRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
    } catch {
      return undefined;
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * Convert model/image-local coordinates to the CUA window-local coordinates.
 * The decision frame is the source of truth: an approved action may execute
 * against a later observation, but its coordinates were still produced from
 * action.basedOn. Geometry is checked by the caller before this projection.
 *
 * Windows window captures can differ from the outer bounds by a small border,
 * so the established contract scales those near-1:1 dimensions. macOS Retina
 * captures instead expose physical screenshot pixels while WindowServer bounds
 * are logical points. CUA's pixel actions consume screenshot-local pixels, so a
 * coherent high-density ratio must not be divided back into logical points.
 */
function mapWindowPoint(
  point: { x: number; y: number },
  sourceViewport: Viewport | undefined,
  targetBounds: CuaWindowGeometry,
): { x: number; y: number } {
  if (sourceViewport === undefined) {
    throw new WindowCoordinateMappingError("WINDOW_VIEWPORT_UNKNOWN", "window action has no source observation viewport");
  }
  if (sourceViewport.coordinateSpace !== "physical") {
    throw new WindowCoordinateMappingError("WINDOW_COORDINATE_SPACE_UNSUPPORTED", "window action requires a physical observation viewport");
  }
  if (!validDimension(sourceViewport.width) || !validDimension(sourceViewport.height)) {
    throw new WindowCoordinateMappingError("WINDOW_VIEWPORT_INVALID", "window action has an invalid source observation viewport");
  }
  if (!validDimension(targetBounds.width) || !validDimension(targetBounds.height)) {
    throw new WindowCoordinateMappingError("WINDOW_GEOMETRY_INVALID", "window action has invalid target geometry");
  }
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x >= sourceViewport.width || point.y >= sourceViewport.height) {
    throw new WindowCoordinateMappingError("WINDOW_COORDINATE_INVALID", `window action point (${point.x}, ${point.y}) is outside source viewport ${sourceViewport.width}x${sourceViewport.height}`);
  }
  const scaleX = sourceViewport.width / targetBounds.width;
  const scaleY = sourceViewport.height / targetBounds.height;
  const highDensityCapture = scaleX >= 1.25 && scaleY >= 1.25 && Math.abs(scaleX - scaleY) <= 0.08;
  if (highDensityCapture) {
    return {
      x: clampCoordinate(Math.round(point.x), sourceViewport.width),
      y: clampCoordinate(Math.round(point.y), sourceViewport.height),
    };
  }
  return {
    x: clampCoordinate(Math.round(point.x * targetBounds.width / sourceViewport.width), targetBounds.width),
    y: clampCoordinate(Math.round(point.y * targetBounds.height / sourceViewport.height), targetBounds.height),
  };
}

function validDimension(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function clampCoordinate(value: number, size: number): number {
  return Math.min(size - 1, Math.max(0, value));
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
