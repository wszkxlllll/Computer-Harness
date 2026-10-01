import { mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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
  ComputerWindowCandidate,
  GroundingCatalog,
  GroundingBrowserRegion,
  GroundingElement,
  ObservationCapture,
  ObservationId,
  Viewport,
} from "@computer-harness/protocol";
import type { Computer, ComputerExecuteOptions, ComputerOpenOptions } from "@computer-harness/runtime";
import {
  DomGroundingUnavailableError,
  materializeDomGrounding,
  validateManagedBrowserTarget,
  type DomGroundingContentRect,
  type DomGroundingTransport,
  type DomClickRequest,
  type DomSelectOptionRequest,
  type ManagedBrowserTarget,
} from "./dom-grounding.js";
import {
  captureWindowWithRetry,
  discoverWindow,
  activateWindowTarget,
  listWindowTargets,
  sameWindowGeometry,
  validateWindowTarget,
  windowActionTarget,
  type CuaWindowBinding,
  type CuaWindowGeometry,
  type CuaWindowTarget,
  type WindowCaptureRetryOptions,
  WindowContractError,
} from "./window-contract.js";

const PRIMARY_DESKTOP = { kind: "desktop", display_id: "primary" } as const;
const CLEANUP_POLL_INTERVAL_MS = 50;

function windowIdentityKey(target: { readonly pid: number; readonly windowId: number }): string {
  return `${target.pid}:${target.windowId}`;
}

function windowRefusalCode(code: string | undefined, message: string): string {
  // CUA 0.22.2 reports the exact-HWND foreground refusal in Tool text rather
  // than a dedicated error code. Require explicit evidence that it sent no
  // input; the prefix alone is not enough to make an action retry-safe.
  const foregroundRefusal = /^foreground_unavailable:/iu.test(message);
  const noInputEvidence = hasExplicitNoInputEvidence(message);
  if (foregroundRefusal || code === "WINDOW_FOREGROUND_MISMATCH") {
    return noInputEvidence ? "WINDOW_FOREGROUND_MISMATCH" : "CUA_TOOL_REFUSED";
  }
  return code ?? "CUA_TOOL_REFUSED";
}

function hasExplicitNoInputEvidence(message: string): boolean {
  return /\bno (?:mouse |keyboard )?input (?:was|has been) (?:sent|dispatched|performed|injected)\b|\binput (?:was|has been) not (?:sent|dispatched|performed|injected)\b/iu.test(message);
}

function parseActualForegroundWindowId(message: string): number | undefined {
  if (!/^foreground_unavailable:/iu.test(message) || !hasExplicitNoInputEvidence(message)) return undefined;
  const rawHandle = /\bactual foreground HWND\s+(0x[0-9a-f]+|\d+)\b/iu.exec(message)?.[1];
  if (rawHandle === undefined) return undefined;
  try {
    const parsed = BigInt(rawHandle);
    return parsed > 0n && parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : undefined;
  } catch {
    return undefined;
  }
}

async function bringWindowToFrontOnce(
  driver: CuaDriverLike,
  session: string,
  target: CuaWindowTarget,
  signal: AbortSignal,
): Promise<void> {
  // Keep the foreground evidence contract in one place.  In particular, a
  // successful `landed_on_target` flag is not enough when the daemon also
  // reports a different actual foreground HWND: continuing would let a
  // keyboard action land in a newly surfaced sheet or dialog.
  await activateWindowTarget(driver, session, target, signal);
}

export type CuaDriverFactory = (socketPath: string) => CuaDriverLike;
export type CuaWindowDeliveryMode = "background" | "foreground";
export type CuaGroundingMode = "off" | "uia-catalog-v1" | "dom-catalog-v1" | "hybrid-catalog-v1";

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
  /** Explicit host-owned managed browser target for the DOM transport gate. */
  browserTarget?: ManagedBrowserTarget;
  /** Host-supplied managed-browser transport; never discovered by this adapter. */
  domGroundingTransport?: DomGroundingTransport;
  /** Total wall-clock budget for endSession/shutdown cleanup; no GUI action is retried. */
  cleanupWaitMs?: number;
  /** Test seam; production uses CuaDriver.connect. */
  driverFactory?: CuaDriverFactory;
  /** Test seam for capture retry timing; production uses bounded real delays. */
  windowCaptureRetry?: WindowCaptureRetryOptions;
}

interface PrivateSession {
  label: string;
  driver: CuaDriverLike;
  descriptor: ComputerSessionDescriptor;
  active: boolean;
  windowBinding?: CuaWindowBinding;
  windowIdentityInvalidated: boolean;
  handoffGeneration: number;
  /** Allow one bounded managed-browser content-rect stabilization at startup. */
  initialObservationPending: boolean;
  /** Full visible-window baseline from the last successful target observation. */
  visibleWindowBaseline: ReadonlySet<string> | undefined;
  /** Fresh inventory immediately before an opted-in foreground GUI action. */
  preActionWindowBaseline: ReadonlySet<string> | undefined;
  /** Windows surfaced since that observation; only these may be considered for automatic handoff. */
  newlySurfacedWindowKeys: ReadonlySet<string>;
  /** Candidate snapshot produced by the immediately preceding list call. */
  newHandoffCandidates: readonly ComputerWindowCandidate[];
  /** Exact HWND reported by CUA as foreground for the current no-input refusal. */
  foregroundMismatchWindowId: number | undefined;
  /** True only when the last completed action produced a pre/post inventory diff. */
  proactiveHandoffCandidatesReady: boolean;
  /** Adapter-private active managed tab; never serialized to Runtime. */
  browserTarget?: ManagedBrowserTarget;
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
  /** Current host-attested tab/generation, retained only by the Adapter. */
  readonly browserTarget?: ManagedBrowserTarget;
  /** Trusted physical browser content rect derived from the same observation's UIA Document. */
  readonly contentRect?: DomGroundingContentRect;
  readonly elements: ReadonlyMap<string, {
    readonly element: GroundingElement;
    /** Raw adapter-private DOM name; the public element name may be redacted. */
    readonly candidateName?: string;
    readonly point: { readonly x: number; readonly y: number };
    readonly candidateFingerprint?: string;
    readonly candidateFrame?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
    readonly selectable?: boolean;
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
    if (this.options.grounding !== undefined && !["off", "uia-catalog-v1", "dom-catalog-v1", "hybrid-catalog-v1"].includes(this.options.grounding)) {
      throw new Error("grounding must be off, uia-catalog-v1, dom-catalog-v1 or hybrid-catalog-v1");
    }
    if (this.options.grounding === "uia-catalog-v1" && this.options.windowTarget === undefined) {
      throw new Error("uia-catalog-v1 grounding requires an explicit CUA window target");
    }
    if (this.options.grounding === "dom-catalog-v1" || this.options.grounding === "hybrid-catalog-v1") {
      if (this.options.windowTarget === undefined) throw new Error("DOM grounding requires an explicit CUA window target");
      if (this.options.browserTarget === undefined) throw new DomGroundingUnavailableError("DOM grounding requires an explicit managed Chromium/Edge target");
      validateManagedBrowserTarget(this.options.browserTarget);
      if (this.options.browserTarget.windowTarget.pid !== this.options.windowTarget!.pid || this.options.browserTarget.windowTarget.windowId !== this.options.windowTarget!.windowId) {
        throw new DomGroundingUnavailableError("managed browser target must match the explicitly selected CUA window pid/windowId");
      }
      if (this.options.domGroundingTransport === undefined) {
        throw new DomGroundingUnavailableError("CUA 0.22.2 has no browser/DOM typed surface; provide a managed loopback CDP transport");
      }
      if (this.options.domGroundingTransport.kind !== "managed-loopback-cdp-v1") {
        throw new DomGroundingUnavailableError("unsupported DOM grounding transport");
      }
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
        // Foreground mode gets a one-time activation assist for this exact
        // PID/HWND. Background delivery keeps its existing behavior unchanged.
        if (this.options.windowDeliveryMode === "foreground") {
          await bringWindowToFrontOnce(driver, label, this.options.windowTarget, signal);
        }
        // Capture once during open so the public session viewport describes the
        // actual image coordinates. No outer-frame correction is hard-coded.
        const capture = await captureWindowWithRetry(driver, label, this.options.windowTarget, signal, this.options.windowCaptureRetry);
        windowBinding = capture.binding;
        viewport = capture.viewport;
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
          // `accessibility` means native/OS UIA availability. DOM grounding
          // alone is structured browser content, not OS Accessibility.
          accessibility: this.options.grounding === "uia-catalog-v1" || this.options.grounding === "hybrid-catalog-v1",
        },
        openedAt: new Date().toISOString(),
      };
      this.session = {
        label,
        driver,
        descriptor,
        active: true,
        windowIdentityInvalidated: false,
        handoffGeneration: 0,
        initialObservationPending: true,
        visibleWindowBaseline: undefined,
        preActionWindowBaseline: undefined,
        newlySurfacedWindowKeys: new Set(),
        newHandoffCandidates: [],
        foregroundMismatchWindowId: undefined,
        proactiveHandoffCandidatesReady: false,
        ...(windowBinding === undefined ? {} : { windowBinding }),
        ...(this.options.browserTarget === undefined ? {} : { browserTarget: this.options.browserTarget }),
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
        const capture = await captureWindowWithRetry(current.driver, current.label, current.windowBinding.target, signal, this.options.windowCaptureRetry);
        const liveBinding = capture.binding;
        current.windowBinding = liveBinding;
        current.descriptor = { ...current.descriptor, viewport: capture.viewport };
        if (this.options.windowDeliveryMode === "foreground") {
          try {
            const visibleWindows = await listWindowTargets(current.driver, current.label, signal);
            const visibleWindowKeys = new Set(visibleWindows.map((window) => windowIdentityKey(window.target)));
            current.newlySurfacedWindowKeys = current.visibleWindowBaseline === undefined
              ? new Set()
              : new Set([...visibleWindowKeys].filter((key) => !current.visibleWindowBaseline!.has(key)));
            current.visibleWindowBaseline = visibleWindowKeys;
          } catch (error) {
            signal.throwIfAborted();
            // Inventory is optional handoff evidence. A failed read keeps this
            // observation usable but disables automatic candidate selection.
            current.visibleWindowBaseline = undefined;
            current.newlySurfacedWindowKeys = new Set();
          }
        } else {
          current.visibleWindowBaseline = undefined;
          current.newlySurfacedWindowKeys = new Set();
        }
        current.newHandoffCandidates = [];
        current.preActionWindowBaseline = undefined;
        current.proactiveHandoffCandidatesReady = false;
        const grounding = await readWindowGrounding(
          this.options.grounding,
          current.driver,
          current.label,
          liveBinding,
          capture.viewport,
          observationId,
          session.id,
          current.browserTarget ?? this.options.browserTarget,
          this.options.domGroundingTransport,
          signal,
          current.initialObservationPending,
        );
        this.observations.set(String(observationId), {
          sessionId: String(session.id),
          viewport: capture.viewport,
          geometry: liveBinding.bounds,
        });
        if (grounding !== undefined) {
          if (grounding.browserTarget !== undefined) current.browserTarget = grounding.browserTarget;
          this.groundings.set(String(observationId), grounding);
        }
        this.latestObservationId = observationId;
        current.initialObservationPending = false;
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

  public async listWindowHandoffCandidates(session: ComputerSessionDescriptor, signal: AbortSignal): Promise<readonly ComputerWindowCandidate[]> {
    const current = this.requireSession(session);
    if (current.windowBinding === undefined || this.options.browserTarget !== undefined || this.options.grounding === "dom-catalog-v1" || this.options.grounding === "hybrid-catalog-v1") {
      throw new Error("window handoff is available only for an explicitly bound native window");
    }
    const windows = await listWindowTargets(current.driver, current.label, signal);
    const candidates = windows.map((window) => ({
      pid: window.target.pid,
      windowId: window.target.windowId,
      ...(window.appName === undefined ? {} : { appName: window.appName }),
      ...(window.title === undefined ? {} : { title: window.title }),
    }));
    const newlySurfacedKeys = new Set(current.newlySurfacedWindowKeys);
    if (current.visibleWindowBaseline !== undefined) {
      for (const window of windows) {
        const key = windowIdentityKey(window.target);
        if (!current.visibleWindowBaseline.has(key)) newlySurfacedKeys.add(key);
      }
    }
    current.newHandoffCandidates = candidates.filter((candidate) => newlySurfacedKeys.has(windowIdentityKey(candidate)));
    return candidates;
  }

  public async listNewWindowHandoffCandidates(session: ComputerSessionDescriptor, signal: AbortSignal): Promise<readonly ComputerWindowCandidate[]> {
    const current = this.requireSession(session);
    signal.throwIfAborted();
    if (current.proactiveHandoffCandidatesReady) return current.newHandoffCandidates;
    const foregroundWindowId = current.foregroundMismatchWindowId;
    if (foregroundWindowId === undefined) return [];
    return current.newHandoffCandidates.filter((candidate) => candidate.windowId === foregroundWindowId);
  }

  public async detectNewWindowHandoffCandidates(session: ComputerSessionDescriptor, signal: AbortSignal): Promise<readonly ComputerWindowCandidate[]> {
    const current = this.requireSession(session);
    const baseline = current.preActionWindowBaseline;
    current.proactiveHandoffCandidatesReady = false;
    current.newHandoffCandidates = [];
    current.newlySurfacedWindowKeys = new Set();
    if (baseline === undefined || current.windowBinding === undefined || this.options.windowDeliveryMode !== "foreground") return [];
    const readDiff = async (): Promise<ComputerWindowCandidate[]> => {
      signal.throwIfAborted();
      const windows = await listWindowTargets(current.driver, current.label, signal);
      signal.throwIfAborted();
      return windows
        .filter((window) => !baseline.has(windowIdentityKey(window.target)))
        .map((window) => ({
          pid: window.target.pid,
          windowId: window.target.windowId,
          ...(window.appName === undefined ? {} : { appName: window.appName }),
          ...(window.title === undefined ? {} : { title: window.title }),
        }));
    };
    let candidates = await readDiff();
    // Some native dialogs appear just after the initiating tool returns. One
    // short abort-aware poll catches that case without a long pause or retry.
    if (candidates.length === 0) {
      await waitWithAbort(80, signal);
      candidates = await readDiff();
    }
    current.newHandoffCandidates = candidates;
    current.newlySurfacedWindowKeys = new Set(candidates.map(windowIdentityKey));
    current.proactiveHandoffCandidatesReady = candidates.length > 0;
    return candidates;
  }

  public async handoffWindow(session: ComputerSessionDescriptor, candidate: ComputerWindowCandidate, signal: AbortSignal): Promise<ComputerSessionDescriptor> {
    const current = this.requireSession(session);
    if (current.windowBinding === undefined || this.options.browserTarget !== undefined || this.options.grounding === "dom-catalog-v1" || this.options.grounding === "hybrid-catalog-v1") {
      throw new Error("window handoff is available only for an explicitly bound native window");
    }
    validateWindowTarget(candidate);
    if (current.windowBinding.target.pid === candidate.pid && current.windowBinding.target.windowId === candidate.windowId) {
      throw new Error("window handoff target must differ from the current window");
    }
    signal.throwIfAborted();
    const windows = await listWindowTargets(current.driver, current.label, signal);
    const fresh = windows.find((window) => window.target.pid === candidate.pid && window.target.windowId === candidate.windowId);
    if (fresh === undefined || candidate.appName !== undefined && candidate.appName !== fresh.appName || candidate.title !== undefined && candidate.title !== fresh.title) {
      throw new WindowContractError("WINDOW_HANDOFF_STALE", "window handoff candidate changed before confirmation");
    }
    if (this.options.windowDeliveryMode === "foreground") {
      await bringWindowToFrontOnce(current.driver, current.label, candidate, signal);
    }
    const capture = await captureWindowWithRetry(current.driver, current.label, candidate, signal, this.options.windowCaptureRetry);
    signal.throwIfAborted();
    // No GUI input is sent here. Commit the new binding only after a fresh,
    // exact-identity capture; old frame and element references cannot survive.
    current.windowBinding = capture.binding;
    current.handoffGeneration += 1;
    current.descriptor = {
      ...current.descriptor,
      id: `${current.label}-handoff-${current.handoffGeneration}` as ComputerSessionDescriptor["id"],
      viewport: capture.viewport,
      openedAt: new Date().toISOString(),
    };
    this.observations.clear();
    this.groundings.clear();
    this.latestObservationId = undefined;
    current.visibleWindowBaseline = undefined;
    current.preActionWindowBaseline = undefined;
    current.newlySurfacedWindowKeys = new Set();
    current.newHandoffCandidates = [];
    current.foregroundMismatchWindowId = undefined;
    current.proactiveHandoffCandidatesReady = false;
    return current.descriptor;
  }

  public async execute(
    session: ComputerSessionDescriptor,
    action: ActionIntent,
    signal: AbortSignal,
    options?: ComputerExecuteOptions,
  ): Promise<ActionReceipt> {
    const current = this.requireSession(session);
    current.foregroundMismatchWindowId = undefined;
    current.preActionWindowBaseline = undefined;
    current.proactiveHandoffCandidatesReady = false;
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
    if (action.kind === "select_option") {
      const privateGrounding = this.groundings.get(String(action.basedOn));
      const resolved = privateGrounding?.elements.get(action.groundingRef);
      if (privateGrounding === undefined || resolved === undefined) {
        return refused(action.actionId, "GROUNDING_REF_STALE", "DOM select reference is stale or unavailable; observe again and choose a current element");
      }
      if (privateGrounding.catalog.source !== "dom" && privateGrounding.catalog.source !== "hybrid") {
        return refused(action.actionId, "SELECT_OPTION_DOM_REQUIRED", "select_option requires managed-browser DOM/hybrid grounding");
      }
      if (resolved.element.source !== "dom" || resolved.selectable !== true || !isSelectLikeRole(resolved.element.role)) {
        return refused(action.actionId, "SELECT_OPTION_ROLE_UNSUPPORTED", "select_option supports only native HTML select elements");
      }
      if (resolved.element.state?.enabled === false) {
        return refused(action.actionId, "GROUNDING_ELEMENT_DISABLED", "DOM select is explicitly disabled and cannot receive a selection");
      }
      if (resolved.element.bbox === undefined || resolved.element.bbox.width <= 0 || resolved.element.bbox.height <= 0) {
        return refused(action.actionId, "GROUNDING_BBOX_UNAVAILABLE", "DOM select bounds are unavailable");
      }
      if (resolved.element.options === undefined) {
        return refused(action.actionId, "SELECT_OPTION_OPTIONS_UNAVAILABLE", "current native select did not publish its bounded options list");
      }
      const matchingOptions = resolved.element.options.filter((option) => normalizeSelectOptionText(option.text) === normalizeSelectOptionText(action.optionText));
      if (matchingOptions.length === 0) {
        return refused(action.actionId, "SELECT_OPTION_OPTION_MISSING", "optionText is not listed in the current observation");
      }
      if (matchingOptions.length > 1) {
        return refused(action.actionId, "SELECT_OPTION_OPTION_AMBIGUOUS", "optionText matches multiple listed options");
      }
      if (matchingOptions[0]?.enabled !== true) {
        return refused(action.actionId, "SELECT_OPTION_OPTION_DISABLED", "optionText is listed but disabled");
      }
      if (resolved.geometry !== undefined && decisionObservation?.geometry !== undefined && !sameWindowGeometry(resolved.geometry, decisionObservation.geometry)) {
        return refused(action.actionId, "GROUNDING_GEOMETRY_CHANGED", "DOM select reference was created for an older window geometry");
      }
      const target = privateGrounding.browserTarget;
      const transport = this.options.domGroundingTransport;
      if (target === undefined || transport?.selectOption === undefined || resolved.candidateFingerprint === undefined) {
        return refused(action.actionId, "SELECT_OPTION_UNSUPPORTED", "managed-browser DOM select delivery is unavailable");
      }
      if (action.optionText.trim().length === 0 || action.optionText.length > 160) {
        return refused(action.actionId, "SELECT_OPTION_INVALID", "select_option optionText must be non-empty and at most 160 characters");
      }
      const request: DomSelectOptionRequest = {
        observationId: action.basedOn,
        computerSessionId: session.id,
        viewport: decisionObservation?.viewport ?? session.viewport,
        browserTarget: target,
        candidate: {
          role: resolved.element.role,
          ...(resolved.element.name === undefined ? {} : { name: resolved.element.name }),
          ...(resolved.element.description === undefined ? {} : { description: resolved.element.description }),
          bbox: {
            x: resolved.element.bbox.x,
            y: resolved.element.bbox.y,
            width: resolved.element.bbox.width,
            height: resolved.element.bbox.height,
          },
          ...(resolved.candidateFrame === undefined ? {} : { frame: resolved.candidateFrame }),
          fingerprint: resolved.candidateFingerprint,
        },
        optionText: action.optionText.trim(),
      };
      try {
        const result = await transport.selectOption(request, signal);
        if (result.status === "completed" && (result.tabId !== target.tabId || result.generation !== target.generation)) {
          return refused(action.actionId, "SELECT_OPTION_GENERATION_MISMATCH", "managed-browser tab or page generation changed; observe again before selecting");
        }
        if (result.status === "completed") {
          return { actionId: action.actionId, status: "completed", ...(result.message === undefined ? {} : { message: result.message }) };
        }
        if (result.status === "refused") {
          return refused(action.actionId, result.driverCode ?? "SELECT_OPTION_REFUSED", result.message ?? "managed-browser select_option was refused");
        }
        return { actionId: action.actionId, status: "failed", driverCode: result.driverCode ?? "SELECT_OPTION_FAILED", ...(result.message === undefined ? {} : { message: result.message }) };
      } catch (error) {
        const details = driverErrorDetails(error);
        if (details.tag === "Transport") current.active = false;
        if (details.tag === "Tool") return refused(action.actionId, details.errorCode ?? "SELECT_OPTION_REFUSED", details.message);
        throw normalizeDriverError(error, "execute");
      }
    }
    const privateGrounding = action.groundingRef === undefined ? undefined : this.groundings.get(String(action.basedOn));
    const resolvedGrounding = action.groundingRef === undefined ? undefined : privateGrounding?.elements.get(action.groundingRef);
    const browserTarget = privateGrounding?.browserTarget ?? current.browserTarget ?? this.options.browserTarget;
    const domTransport = this.options.domGroundingTransport;
    if (action.kind === "click" && privateGrounding?.catalog.source === "hybrid"
      && resolvedGrounding?.element.source === "uia"
      && isManagedBrowserContainerRole(resolvedGrounding.element.role)) {
      return refused(action.actionId, "MANAGED_BROWSER_CONTAINER_NOT_INTERACTIVE", "managed-browser window/document containers are not interactive controls");
    }
    // Hybrid observations intentionally expose both producers.  A model may
    // still select the UIA copy of a browser control even when an equivalent
    // DOM candidate is available.  Normalize that selection here, at the
    // adapter boundary, so browser clicks remain observation-bound CDP
    // actions.  The native coordinate path below is retained for non-browser
    // UIA and visual controls only.
    const domEquivalent = action.kind === "click"
      && resolvedGrounding?.element.source === "uia"
      && browserTarget !== undefined
      ? findEquivalentDomGrounding(privateGrounding, resolvedGrounding)
      : undefined;
    const browserGrounding = domEquivalent ?? (
      resolvedGrounding?.element.source === "dom" ? resolvedGrounding : undefined
    );
    if (action.kind === "click"
      && action.groundingRef !== undefined
      && browserGrounding !== undefined
      && browserTarget !== undefined
      && domTransport?.click !== undefined
      && browserGrounding.candidateFingerprint !== undefined
      && browserGrounding.element.bbox !== undefined) {
      if (browserGrounding.element.state?.enabled === false) {
        return refused(action.actionId, "GROUNDING_ELEMENT_DISABLED", "DOM element is explicitly disabled and cannot receive a click");
      }
      if (browserGrounding.geometry !== undefined && decisionObservation?.geometry !== undefined && !sameWindowGeometry(browserGrounding.geometry, decisionObservation.geometry)) {
        return refused(action.actionId, "GROUNDING_GEOMETRY_CHANGED", "DOM element reference was created for an older window geometry");
      }
      // For a UIA alias, first validate against the selected UIA point (the
      // model's action binding), then require the point to land inside the
      // equivalent DOM box. This prevents a name-only alias from redirecting
      // an unrelated coordinate.
      const selectedPoint = resolvedGrounding?.point ?? browserGrounding.point;
      if (Math.abs(action.point.x - selectedPoint.x) > 0.01 || Math.abs(action.point.y - selectedPoint.y) > 0.01) {
        return refused(action.actionId, "GROUNDING_POINT_MISMATCH", "grounding click point does not match the current DOM element bounds");
      }
      if (domEquivalent !== undefined && !pointInBox(action.point, browserGrounding.element.bbox)) {
        return refused(action.actionId, "GROUNDING_DOM_ALIAS_MISMATCH", "UIA browser target does not overlap its equivalent DOM element; observe again before clicking");
      }
      const request: DomClickRequest = {
        observationId: action.basedOn,
        computerSessionId: session.id,
        viewport: decisionObservation?.viewport ?? session.viewport,
        browserTarget,
        candidate: {
          role: browserGrounding.element.role,
          ...(browserGrounding.candidateName === undefined ? {} : { name: browserGrounding.candidateName }),
          bbox: {
            x: browserGrounding.element.bbox.x,
            y: browserGrounding.element.bbox.y,
            width: browserGrounding.element.bbox.width,
            height: browserGrounding.element.bbox.height,
          },
          ...(browserGrounding.candidateFrame === undefined ? {} : { frame: browserGrounding.candidateFrame }),
          fingerprint: browserGrounding.candidateFingerprint,
        },
      };
      try {
        const result = await domTransport.click(request, signal);
        if (result.status === "completed" && (result.tabId !== browserTarget.tabId || result.generation !== browserTarget.generation)) {
          return refused(action.actionId, "DOM_CLICK_GENERATION_MISMATCH", "managed-browser tab or page generation changed; observe again before clicking");
        }
        if (result.status === "completed") {
          return { actionId: action.actionId, status: "completed", ...(result.message === undefined ? {} : { message: result.message }) };
        }
        if (result.status === "refused") {
          return refused(action.actionId, result.driverCode ?? "DOM_CLICK_REFUSED", result.message ?? "managed-browser DOM click was refused");
        }
        return { actionId: action.actionId, status: "failed", driverCode: result.driverCode ?? "DOM_CLICK_FAILED", ...(result.message === undefined ? {} : { message: result.message }) };
      } catch (error) {
        const details = driverErrorDetails(error);
        if (details.tag === "Transport") current.active = false;
        if (details.tag === "Tool") return refused(action.actionId, details.errorCode ?? "DOM_CLICK_REFUSED", details.message);
        throw normalizeDriverError(error, "execute");
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
      );
    } catch (error) {
      if (error instanceof WindowCoordinateMappingError) {
        return refused(action.actionId, error.code, error.message);
      }
      throw error;
    }
    if (options?.detectNewWindowHandoff === true && current.windowBinding !== undefined && this.options.windowDeliveryMode === "foreground") {
      try {
        const visibleWindows = await listWindowTargets(current.driver, current.label, signal);
        signal.throwIfAborted();
        const visibleKeys = new Set(visibleWindows.map((window) => windowIdentityKey(window.target)));
        if (!visibleKeys.has(windowIdentityKey(current.windowBinding.target))) {
          return refused(action.actionId, "WINDOW_INVENTORY_UNKNOWN", "bound target was missing from visible-window inventory; no input was sent");
        }
        current.preActionWindowBaseline = visibleKeys;
        current.visibleWindowBaseline = visibleKeys;
        current.newlySurfacedWindowKeys = new Set();
        current.newHandoffCandidates = [];
      } catch (error) {
        signal.throwIfAborted();
        return refused(action.actionId, "WINDOW_INVENTORY_UNKNOWN", "visible-window inventory failed before action; no input was sent");
      }
    }
    try {
      const result = await callTool(current.driver, request.name, request.arguments, signal);
      if (result.isError) {
        const driverCode = windowRefusalCode(result.errorCode, result.text);
        if (driverCode === "WINDOW_FOREGROUND_MISMATCH") {
          current.foregroundMismatchWindowId = parseActualForegroundWindowId(result.text);
        }
        return refused(action.actionId, driverCode, result.text);
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
        const driverCode = windowRefusalCode(details.errorCode, details.message);
        if (driverCode === "WINDOW_FOREGROUND_MISMATCH") {
          current.foregroundMismatchWindowId = parseActualForegroundWindowId(details.message);
        }
        return refused(action.actionId, driverCode, details.message);
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
      return { name: "type_text", arguments: { session, target, text: action.text, delivery_mode: deliveryMode } };
    case "keypress":
      return action.keys.length === 1
        ? { name: "press_key", arguments: { session, target, key: action.keys[0], delivery_mode: deliveryMode } }
        : { name: "hotkey", arguments: { session, target, keys: action.keys, delivery_mode: deliveryMode } };
    case "scroll":
      return { name: "scroll", arguments: { session, target, ...point(action.point), direction: action.direction, by: "line", amount: action.ticks, delivery_mode: deliveryMode } };
    case "drag": {
      const from = point(action.from);
      const to = point(action.to);
      return { name: "drag", arguments: { session, target, from_x: from.x, from_y: from.y, to_x: to.x, to_y: to.y, delivery_mode: deliveryMode } };
    }
    case "select_option":
      throw new WindowCoordinateMappingError("SELECT_OPTION_DOM_REQUIRED", "select_option must use managed-browser DOM delivery");
    default:
      return assertNever(action);
  }
}

type GroundingToolResult = {
  readonly isError?: boolean;
  readonly degraded?: boolean;
  readonly structuredJson?: string;
};

async function readWindowGrounding(
  mode: CuaGroundingMode | undefined,
  driver: CuaDriverLike,
  session: string,
  binding: CuaWindowBinding,
  viewport: Viewport,
  observationId: ObservationId,
  computerSessionId: ComputerSessionDescriptor["id"],
  browserTarget: ManagedBrowserTarget | undefined,
  domTransport: DomGroundingTransport | undefined,
  signal: AbortSignal,
  allowInitialHybridResampling = false,
): Promise<PrivateGrounding | undefined> {
  if (mode === undefined || mode === "off") return undefined;
  if (mode === "uia-catalog-v1") return readGroundingCatalog(driver, session, binding, viewport, observationId, computerSessionId, signal, false);
  if (browserTarget === undefined || domTransport === undefined) {
    // Constructor validation normally prevents this branch. Preserve an
    // observable degraded DOM sidecar if an untyped host boundary mutates it.
    return emptyDomGrounding(observationId, computerSessionId);
  }
  let uia = mode === "hybrid-catalog-v1"
    ? await readGroundingCatalog(driver, session, binding, viewport, observationId, computerSessionId, signal, browserTarget !== undefined)
    : undefined;
  // Browser accessibility trees can expose toolbar nodes before the Document
  // / AXWebArea record is ready. Retry only the trusted UIA producer within a
  // 3.35-second total budget; DOM collection remains fail-closed until content
  // origin evidence exists.
  if (allowInitialHybridResampling && mode === "hybrid-catalog-v1" && browserTarget !== undefined && uia?.contentRect === undefined) {
    const retryDelaysMs = [100, 250, 500, 1_000, 1_500] as const;
    const retryDeadline = Date.now() + retryDelaysMs.reduce((total, delay) => total + delay, 0);
    for (const delayMs of retryDelaysMs) {
      const beforeDelayMs = retryDeadline - Date.now();
      if (beforeDelayMs <= 0) break;
      await waitWithAbort(Math.min(delayMs, beforeDelayMs), signal);
      const remainingMs = retryDeadline - Date.now();
      if (remainingMs <= 0) break;

      const retryController = new AbortController();
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let timeoutExpired = false;
      let onAbort: (() => void) | undefined;
      try {
        const retrySignal = AbortSignal.any([signal, retryController.signal]);
        const timeoutPromise = new Promise<{ readonly timedOut: true }>((resolve) => {
          timeoutId = setTimeout(() => {
            timeoutExpired = true;
            retryController.abort(new Error("hybrid grounding retry budget exhausted"));
            resolve({ timedOut: true });
          }, remainingMs);
        });
        const retryPromise = readGroundingCatalog(driver, session, binding, viewport, observationId, computerSessionId, retrySignal, true)
          .then((value) => ({ value }), (error: unknown) => ({ error }));
        const abortPromise = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(signal.reason ?? new Error("hybrid grounding retry aborted"));
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        });
        const result = await Promise.race([retryPromise, timeoutPromise, abortPromise]);
        if ("timedOut" in result) break;
        if ("error" in result) {
          if (signal.aborted) signal.throwIfAborted();
          if (timeoutExpired || retryController.signal.aborted) break;
          throw result.error;
        }
        uia = result.value;
        if (uia.contentRect !== undefined) break;
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
        if (!retryController.signal.aborted) retryController.abort(new Error("hybrid grounding retry completed"));
      }
    }
  }
  // DOM-only has no trusted producer for the browser content origin. Keep the
  // capability explicitly fail-closed until a future browser-native content
  // rect producer is added; never guess from window bounds/DPI.
  const dom = mode === "dom-catalog-v1" && uia === undefined
    ? emptyDomGrounding(observationId, computerSessionId)
    : await readDomGroundingCatalog(domTransport, browserTarget, binding, viewport, observationId, computerSessionId, uia?.contentRect, signal);
  if (mode === "dom-catalog-v1") return dom;
  if (uia === undefined) return dom;
  if (dom === undefined) return uia;
  return mergeGroundings(uia, dom, observationId, computerSessionId);
}

async function readDomGroundingCatalog(
  transport: DomGroundingTransport,
  browserTarget: ManagedBrowserTarget,
  binding: CuaWindowBinding,
  viewport: Viewport,
  observationId: ObservationId,
  computerSessionId: ComputerSessionDescriptor["id"],
  trustedContentRect: DomGroundingContentRect | undefined,
  signal: AbortSignal,
): Promise<PrivateGrounding> {
  if (trustedContentRect === undefined) return emptyDomGrounding(observationId, computerSessionId);
  try {
    const result = await transport.collect({ observationId, computerSessionId, viewport, browserTarget }, signal);
    // The host attests the active tab/generation at collection time. A tab
    // switch may update both private fields; every public ref remains bound to
    // this observation and must be re-observed before reuse.
    if (!isBoundedBrowserIdentity(result.tabId) || !isBoundedBrowserIdentity(result.generation)) return emptyDomGrounding(observationId, computerSessionId);
    const activeBrowserTarget: ManagedBrowserTarget = { ...browserTarget, tabId: result.tabId, generation: result.generation };
    const materialized = materializeDomGrounding({ observationId, computerSessionId, viewport, browserTarget: activeBrowserTarget }, result, GROUNDING_MAX_ELEMENTS, trustedContentRect);
    const elements = new Map<string, {
      readonly element: GroundingElement;
      readonly candidateName?: string;
      readonly point: { readonly x: number; readonly y: number };
      readonly candidateFingerprint: string;
      readonly candidateFrame?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
      readonly selectable: boolean;
      readonly geometry?: CuaWindowGeometry;
    }>();
    for (const [elementRef, privateElement] of materialized.privateElements) {
      elements.set(elementRef, {
        element: privateElement.element,
        ...(privateElement.candidateName === undefined ? {} : { candidateName: privateElement.candidateName }),
        point: privateElement.point,
        candidateFingerprint: privateElement.candidateFingerprint,
        ...(privateElement.candidateFrame === undefined ? {} : { candidateFrame: privateElement.candidateFrame }),
        selectable: privateElement.selectable,
        geometry: binding.bounds,
      });
    }
    return {
      catalog: materialized.catalog,
      browserTarget: activeBrowserTarget,
      contentRect: trustedContentRect,
      elements,
    };
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted();
    if (error instanceof Error && error.name === "AbortError") throw error;
    // A DOM transport is an optional producer. Keep a redacted degraded
    // sidecar so DOM-only/hybrid runs expose the capability failure without
    // leaking error text or browser identity; screenshot/visual fallback is
    // still unaffected.
    return emptyDomGrounding(observationId, computerSessionId);
  }
}

function emptyDomGrounding(
  observationId: ObservationId,
  computerSessionId: ComputerSessionDescriptor["id"],
): PrivateGrounding {
  return {
    catalog: {
      version: "grounding-catalog-v2",
      source: "dom",
      observationId,
      computerSessionId,
      completeness: "unknown",
      degraded: true,
      maxElements: GROUNDING_MAX_ELEMENTS,
      elements: [],
    },
    elements: new Map(),
  };
}

function isBoundedBrowserIdentity(value: string | undefined): value is string {
  return value !== undefined && /^[A-Za-z0-9._:-]{1,128}$/u.test(value);
}

function isSelectLikeRole(role: string): boolean {
  const normalized = role.normalize("NFKC").toLocaleLowerCase().replace(/[\s_-]+/gu, "").trim();
  return normalized === "select" || normalized === "combobox";
}

function normalizeSelectOptionText(value: string): string {
  return value.normalize("NFKC").replace(/[\u0000-\u001F\u007F]/gu, " ").replace(/\s+/gu, " ").trim();
}

/** Fairly merge the two bounded producers before Runtime applies its hot cap. */
export function mergeGroundingElements(
  uiaElements: readonly GroundingElement[],
  domElements: readonly GroundingElement[],
  maxElements = GROUNDING_MAX_ELEMENTS,
): GroundingElement[] {
  const merged: GroundingElement[] = [];
  let uiaIndex = 0;
  let domIndex = 0;
  while (merged.length < maxElements && (uiaIndex < uiaElements.length || domIndex < domElements.length)) {
    if (uiaIndex < uiaElements.length) merged.push(uiaElements[uiaIndex++]!);
    if (merged.length >= maxElements) break;
    if (domIndex < domElements.length) merged.push(domElements[domIndex++]!);
  }
  return merged;
}

function mergeGroundings(
  uia: PrivateGrounding,
  dom: PrivateGrounding,
  observationId: ObservationId,
  computerSessionId: ComputerSessionDescriptor["id"],
): PrivateGrounding {
  const elements = new Map(uia.elements);
  for (const [elementRef, value] of dom.elements) elements.set(elementRef, value);
  const publicElements = mergeGroundingElements(uia.catalog.elements, dom.catalog.elements);
  const truncated = uia.catalog.completeness !== "complete" || dom.catalog.completeness !== "complete";
  return {
    catalog: {
      version: "grounding-catalog-v2",
      source: "hybrid",
      observationId,
      computerSessionId,
      completeness: truncated ? "partial" : "complete",
      degraded: uia.catalog.degraded || dom.catalog.degraded,
      maxElements: GROUNDING_MAX_ELEMENTS,
      elements: publicElements,
    },
    ...(dom.browserTarget === undefined ? {} : { browserTarget: dom.browserTarget }),
    ...(dom.contentRect === undefined ? {} : { contentRect: dom.contentRect }),
    elements,
  };
}

type PrivateGroundingElement = PrivateGrounding["elements"] extends ReadonlyMap<string, infer Value> ? Value : never;

function findEquivalentDomGrounding(
  grounding: PrivateGrounding | undefined,
  selected: PrivateGroundingElement | undefined,
): PrivateGroundingElement | undefined {
  if (grounding === undefined || selected === undefined || selected.element.bbox === undefined) return undefined;
  const matches = [...grounding.elements.values()]
    .filter((candidate) => candidate.element.source === "dom" && candidate.element.bbox !== undefined)
    .filter((candidate) => equivalentBrowserCandidate(selected.element, candidate.element));
  if (matches.length === 0) return undefined;
  matches.sort((left, right) => boxIntersectionOverUnion(selected.element.bbox!, right.element.bbox!) - boxIntersectionOverUnion(selected.element.bbox!, left.element.bbox!));
  return matches[0];
}

function equivalentBrowserCandidate(left: GroundingElement, right: GroundingElement): boolean {
  if (normalizeGroundingRole(left.role) !== normalizeGroundingRole(right.role)) return false;
  const overlap = boxIntersectionOverUnion(left.bbox!, right.bbox!);
  if (overlap < 0.5) return false;
  const leftName = normalizeGroundingName(left.name);
  const rightName = normalizeGroundingName(right.name);
  return leftName === undefined || rightName === undefined || leftName === rightName || overlap >= 0.8;
}

function normalizeGroundingRole(value: string): string {
  const normalized = value.normalize("NFKC").toLocaleLowerCase().replace(/[\s_-]+/gu, "");
  const axRole = normalized.startsWith("ax") ? normalized.slice(2) : normalized;
  switch (axRole) {
    case "link": return "link";
    case "button": return "button";
    case "textfield":
    case "searchfield": return "textbox";
    case "webarea": return "document";
    case "checkbox": return "checkbox";
    case "radiobutton": return "radio";
    case "combobox": return "combobox";
    case "menuitem": return "menuitem";
    default: return axRole;
  }
}

function isManagedBrowserContainerRole(role: string): boolean {
  const normalized = normalizeGroundingRole(role);
  return normalized === "window" || normalized === "document";
}

function normalizeGroundingName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.normalize("NFKC").replace(/[\s\u3000]+/gu, " ").trim().toLocaleLowerCase();
  return normalized.length === 0 ? undefined : normalized;
}

function pointInBox(point: { readonly x: number; readonly y: number }, box: NonNullable<GroundingElement["bbox"]>): boolean {
  return point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height;
}

function boxIntersectionOverUnion(left: NonNullable<GroundingElement["bbox"]>, right: NonNullable<GroundingElement["bbox"]>): number {
  const x1 = Math.max(left.x, right.x);
  const y1 = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.width, right.x + right.width);
  const y2 = Math.min(left.y + left.height, right.y + right.height);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = left.width * left.height + right.width * right.height - intersection;
  return union <= 0 ? 0 : intersection / union;
}

async function readGroundingCatalog(
  driver: CuaDriverLike,
  session: string,
  binding: CuaWindowBinding,
  viewport: Viewport,
  observationId: ObservationId,
  computerSessionId: ComputerSessionDescriptor["id"],
  signal: AbortSignal,
  managedBrowserHybrid: boolean,
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
  const selectedRecords = selected.map((candidate) => ({
    element: candidate.element,
    point: candidate.point,
  }));
  const contentRect = trustedContentRectFromUia(selectedRecords.map((candidate) => candidate.element), viewport);
  const annotatedRecords = managedBrowserHybrid && contentRect !== undefined
    ? selectedRecords.map((candidate) => ({
      ...candidate,
      element: {
        ...candidate.element,
        browserRegion: classifyUiaBrowserRegion(candidate.element, contentRect, viewport),
      },
    }))
    : selectedRecords;
  const elements = new Map<string, { readonly element: GroundingElement; readonly point: { readonly x: number; readonly y: number }; readonly geometry: CuaWindowGeometry }>();
  const publicElements = annotatedRecords.map((candidate, index) => {
    const elementRef = `uia-${groundingObservationDiscriminator(observationId)}-${index + 1}`;
    const element: GroundingElement = managedBrowserHybrid && isManagedBrowserContainerRole(candidate.element.role)
      ? {
          ...candidate.element,
          elementRef,
          state: { ...candidate.element.state, enabled: false },
        }
      : { ...candidate.element, elementRef };
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
    ...(contentRect === undefined ? {} : { contentRect }),
    elements,
  };
}

/**
 * Classify UIA elements only after the same observation has proven a managed
 * browser content rectangle from a UIA Document.  The tolerance is bounded
 * to account for integer rounding at a content edge; it is not a browser
 * chrome-height or DPI guess.  An element which crosses the boundary by more
 * than that tolerance remains unknown rather than being promoted to either
 * side.  The returned label is attached to the exact object used by both the
 * public catalog and the private delivery map.
 */
const UIA_BROWSER_REGION_TOLERANCE_PX = 2;

function classifyUiaBrowserRegion(
  element: { readonly bbox?: GroundingElement["bbox"] },
  contentRect: DomGroundingContentRect,
  viewport: Viewport,
): GroundingBrowserRegion {
  const bbox = element.bbox;
  if (bbox === undefined || bbox.coordinateSpace !== "physical" || !validGroundingRect(bbox, viewport) || !validContentRectForRegion(contentRect, viewport)) {
    return "unknown";
  }
  const contentRight = contentRect.x + contentRect.width;
  const contentBottom = contentRect.y + contentRect.height;
  const bboxRight = bbox.x + bbox.width;
  const bboxBottom = bbox.y + bbox.height;
  const fullyInside = bbox.x >= contentRect.x - UIA_BROWSER_REGION_TOLERANCE_PX
    && bbox.y >= contentRect.y - UIA_BROWSER_REGION_TOLERANCE_PX
    && bboxRight <= contentRight + UIA_BROWSER_REGION_TOLERANCE_PX
    && bboxBottom <= contentBottom + UIA_BROWSER_REGION_TOLERANCE_PX;
  const centerInside = bbox.x + bbox.width / 2 >= contentRect.x
    && bbox.x + bbox.width / 2 <= contentRight
    && bbox.y + bbox.height / 2 >= contentRect.y
    && bbox.y + bbox.height / 2 <= contentBottom;
  if (fullyInside && centerInside) return "content";

  const overlapsContent = bbox.x < contentRight
    && bboxRight > contentRect.x
    && bbox.y < contentBottom
    && bboxBottom > contentRect.y;
  if (overlapsContent) {
    // Permit a center-inside element whose only boundary crossing is within
    // the bounded measurement tolerance; larger crossings are ambiguous.
    const crossing = Math.max(
      Math.max(0, contentRect.x - bbox.x),
      Math.max(0, contentRect.y - bbox.y),
      Math.max(0, bboxRight - contentRight),
      Math.max(0, bboxBottom - contentBottom),
    );
    return centerInside && crossing <= UIA_BROWSER_REGION_TOLERANCE_PX ? "content" : "unknown";
  }

  const separatedFromContent = bboxRight <= contentRect.x - UIA_BROWSER_REGION_TOLERANCE_PX
    || bbox.x >= contentRight + UIA_BROWSER_REGION_TOLERANCE_PX
    || bboxBottom <= contentRect.y - UIA_BROWSER_REGION_TOLERANCE_PX
    || bbox.y >= contentBottom + UIA_BROWSER_REGION_TOLERANCE_PX;
  return separatedFromContent ? "chrome" : "unknown";
}

function validGroundingRect(
  bbox: NonNullable<GroundingElement["bbox"]>,
  viewport: Viewport,
): boolean {
  return Number.isFinite(bbox.x)
    && Number.isFinite(bbox.y)
    && Number.isFinite(bbox.width)
    && Number.isFinite(bbox.height)
    && bbox.width > 0
    && bbox.height > 0
    && bbox.x >= 0
    && bbox.y >= 0
    && bbox.x + bbox.width <= viewport.width + UIA_BROWSER_REGION_TOLERANCE_PX
    && bbox.y + bbox.height <= viewport.height + UIA_BROWSER_REGION_TOLERANCE_PX;
}

function validContentRectForRegion(rect: DomGroundingContentRect, viewport: Viewport): boolean {
  return Number.isFinite(rect.x)
    && Number.isFinite(rect.y)
    && Number.isFinite(rect.width)
    && Number.isFinite(rect.height)
    && rect.width > 0
    && rect.height > 0
    && rect.x >= 0
    && rect.y >= 0
    && rect.x + rect.width <= viewport.width + UIA_BROWSER_REGION_TOLERANCE_PX
    && rect.y + rect.height <= viewport.height + UIA_BROWSER_REGION_TOLERANCE_PX;
}

function trustedContentRectFromUia(
  elements: readonly { readonly role: string; readonly bbox?: GroundingElement["bbox"] }[],
  viewport: Viewport,
): DomGroundingContentRect | undefined {
  const candidates = elements
    // Windows UIA exposes browser content as `Document`, while macOS
    // Accessibility exposes the same trusted top-level surface as
    // `AXWebArea`. Both records come from the exact bound browser window.
    .filter((element) => {
      const role = element.role.normalize("NFKC").toLocaleLowerCase().replace(/[\\s_-]+/gu, "");
      return (role === "document" || role === "axwebarea" || role === "webarea" || role === "axdocument" || role === "documentcontrol")
        && element.bbox?.coordinateSpace === "physical";
    })
    .map((element) => element.bbox!)
    .filter((bbox) => bbox.width >= viewport.width * 0.5 && bbox.height >= viewport.height * 0.5)
    .filter((bbox) => bbox.x >= 0 && bbox.y >= 0 && bbox.x + bbox.width <= viewport.width + 1 && bbox.y + bbox.height <= viewport.height + 1)
    .sort((left, right) => right.width * right.height - left.width * left.height);
  const candidate = candidates[0];
  return candidate === undefined ? undefined : {
    x: candidate.x,
    y: candidate.y,
    width: candidate.width,
    height: candidate.height,
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
    source: "uia",
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
