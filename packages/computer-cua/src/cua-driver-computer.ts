import { mkdir, readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
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
  ComputerWindowOption,
  GroundingCatalog,
  GroundingBrowserRegion,
  GroundingElement,
  ObservationCapture,
  ObservationId,
  SurfaceTransitionReason,
  SwitchWindowAction,
  Viewport,
} from "@computer-harness/protocol";
import type { Computer, ComputerExecuteOptions, ComputerOpenOptions } from "@computer-harness/runtime";
import {
  DomGroundingUnavailableError,
  materializeDomGrounding,
  validateManagedBrowserTarget,
  type DomGroundingContentRect,
  type DomGroundingTransport,
  type DomSelectOptionRequest,
  type ManagedBrowserTarget,
} from "./dom-grounding.js";
import {
  activatePeer,
  advanceSurfaceGeneration,
  closeSurfaceRegistry,
  createSurfaceRegistry,
  deactivateChild,
  currentSurfaceRef,
  isCurrentSurfaceRef,
  isExecutableSurfaceRef,
  markSurfaceUnknown,
  popChild,
  pushChild,
  registerDesktopSurface,
  registerNativePeer,
  resolveDisplayId,
  resolveNativeWindow,
  type NativeWindowIdentity,
  type SurfaceRecord,
  type SurfaceRef,
  type SurfaceRegistryState,
  type TransientChildEvidence,
} from "./surface-registry.js";
import {
  captureWindowWithRetry,
  discoverWindow,
  listWindowInventory,
  listWindowTargets,
  sameWindowGeometry,
  validateWindowTarget,
  windowActionTarget,
  type CuaWindowBinding,
  type CuaWindowGeometry,
  type CuaWindowInventory,
  type CuaWindowInfo,
  type CuaWindowTarget,
  type WindowCaptureRetryOptions,
  WindowContractError,
} from "./window-contract.js";
import { assessOwnedTransientWindowAdmission } from "./transient-window-admission.js";
import type { WindowRelationshipProbe } from "./window-relationship-probe.js";
import { projectExactWindowRoot as exactWindowRoot } from "./window-root-projection.js";

const PRIMARY_DESKTOP = { kind: "desktop", display_id: "primary" } as const;
const CLEANUP_POLL_INTERVAL_MS = 50;
function hasLineBreak(text: string): boolean {
  return /[\r\n\u0085\u2028\u2029]/u.test(text);
}

function normalizeLogicalLineEndings(text: string): string {
  return text.replace(/\r\n|\r|\n/gu, "\n");
}

function windowIdentityKey(target: { readonly pid: number; readonly windowId: number }): string {
  return `${target.pid}:${target.windowId}`;
}

function sameSurfaceRef(left: SurfaceRef | undefined, right: SurfaceRef | undefined): boolean {
  return left !== undefined && right !== undefined && left.surfaceId === right.surfaceId &&
    left.generation === right.generation && left.kind === right.kind &&
    left.parentSurfaceId === right.parentSurfaceId && left.admissionSource === right.admissionSource;
}

function noteSurfaceTransition(current: PrivateSession, reason: SurfaceTransitionReason): void {
  current.pendingSurfaceTransitionReason ??= reason;
}

function takeSurfaceTransitionReason(current: PrivateSession): SurfaceTransitionReason | undefined {
  const reason = current.pendingSurfaceTransitionReason;
  delete current.pendingSurfaceTransitionReason;
  return reason;
}

function positiveWindowId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

type OverlayVerification =
  | { readonly status: "present"; readonly evidence: Extract<TransientChildEvidence, { readonly kind: "overlay" }> }
  | { readonly status: "absent" }
  | { readonly status: "unknown"; readonly reason: string; readonly candidateObserved: boolean };

const TRUSTED_MENU_WINDOW_CLASSES = new Set(["#32768"]);

/**
 * A transient HWND shares one Surface lifecycle; evidence policy differs by
 * root semantics: dialogs require exact foreground ownership, while native
 * menus require a complete unique owned stack above their parent. A
 * MenuItem anywhere in the descendant list is never root-role evidence.
 */
async function verifyTransientNativeChildRoot(
  driver: CuaDriverLike,
  session: string,
  owner: CuaWindowTarget,
  candidate: CuaWindowInfo,
  inventory: CuaWindowInventory,
  baselineComplete: boolean,
  allowExactStateProof: boolean,
  signal: AbortSignal,
): Promise<TransientChildEvidence | undefined> {
  if (windowIdentityKey(candidate.target) === windowIdentityKey(owner) ||
      candidate.isOnScreen !== true || candidate.minimized === true ||
      candidate.ownerPid !== owner.pid || candidate.ownerWindowId !== owner.windowId) {
    return undefined;
  }

  const admissionSource = inventory.source === "win32_relationship_probe"
    ? "win32_relationship_probe" as const
    : "owned_transient_window_root_proof" as const;
  const policyEvidence = (rootRole: "menu" | "popup" | "dialog"): "exact_foreground" | "unique_owned_stack" | undefined => {
    if (rootRole === "dialog") {
      return inventory.foregroundPid === candidate.target.pid &&
        inventory.foregroundWindowId === candidate.target.windowId
        ? "exact_foreground"
        : undefined;
    }
    return hasUniqueOwnedMenuStack(inventory, owner, candidate, baselineComplete)
      ? "unique_owned_stack"
      : undefined;
  };

  const classRole = trustedWindowClassRootRole(candidate.windowClass);
  if (classRole !== undefined) {
    const frontmostEvidence = policyEvidence(classRole);
    if (frontmostEvidence === undefined) return undefined;
    return {
      kind: "native_window",
      nativeWindow: asNativeWindowIdentity(candidate.target),
      owner: asNativeWindowIdentity(owner),
      rootRole: classRole,
      visible: true,
      rootSemanticsVerified: true,
      interactionPolicy: "modal",
      frontmostEvidence,
      admissionSource,
    };
  }
  if (!allowExactStateProof) return undefined;

  // Stage one owner/visibility/freshness evidence comes from the merged
  // inventory. Stage two reads only this exact candidate HWND, never a global
  // accessibility tree, and requests no screenshot.
  const stateResult = await callTool(driver, "get_window_state", {
    pid: candidate.target.pid,
    window_id: candidate.target.windowId,
    include_screenshot: false,
    max_depth: 8,
    max_elements: 64,
    session,
  }, signal);
  if (stateResult.isError || stateResult.degraded) return undefined;
  const state = parseStructuredRecord(stateResult.structuredJson);
  const root = exactWindowRoot(state, candidate.target);
  if (root === undefined || root.role === "window") return undefined;
  const frontmostEvidence = policyEvidence(root.role);
  if (frontmostEvidence === undefined) return undefined;
  return {
    kind: "native_window",
    nativeWindow: asNativeWindowIdentity(candidate.target),
    owner: asNativeWindowIdentity(owner),
    rootRole: root.role,
    visible: true,
    rootSemanticsVerified: true,
    interactionPolicy: "modal",
    frontmostEvidence,
    admissionSource,
  };
}

function trustedWindowClassRootRole(windowClass: string | undefined): "menu" | "dialog" | undefined {
  if (windowClass !== undefined && TRUSTED_MENU_WINDOW_CLASSES.has(windowClass)) return "menu";
  if (windowClass === "#32770") return "dialog";
  return undefined;
}

function hasUniqueOwnedMenuStack(
  inventory: CuaWindowInventory,
  parent: CuaWindowTarget,
  candidate: CuaWindowInfo,
  baselineComplete: boolean,
): boolean {
  if (!inventory.complete || !baselineComplete) return false;
  return assessOwnedTransientWindowAdmission({
    parent,
    candidate,
    inventory,
    surfacedWindowCount: 1,
    baselineComplete,
    parentSurfaceCurrent: true,
  }).decision === "admitted";
}

/** Read an explicit same-HWND overlay root; ordinary descendant MenuItems do not qualify. */
async function verifySameHwndOverlay(
  driver: CuaDriverLike,
  session: string,
  owner: CuaWindowTarget,
  signal: AbortSignal,
): Promise<OverlayVerification> {
  const result = await callTool(driver, "get_window_state", {
    pid: owner.pid,
    window_id: owner.windowId,
    include_screenshot: false,
    max_depth: 8,
    max_elements: 64,
    session,
  }, signal);
  if (result.isError || result.degraded) return { status: "unknown", reason: "same-HWND overlay query failed or degraded", candidateObserved: false };
  const state = parseStructuredRecord(result.structuredJson);
  const hasOverlayField = state !== undefined && (Object.hasOwn(state, "overlay_root") || Object.hasOwn(state, "overlayRoot"));
  const rawOverlay = state === undefined
    ? undefined
    : Object.hasOwn(state, "overlay_root") ? state.overlay_root : state.overlayRoot;
  const candidateObserved = hasOverlayField && rawOverlay !== null &&
    !(isRecord(rawOverlay) && rawOverlay.present === false);
  if (!isCompleteWindowState(state)) return {
    status: "unknown",
    reason: "same-HWND overlay query returned incomplete or truncated state",
    candidateObserved,
  };
  const root = parseStructuredRecord(state.root_surface ?? state.rootSurface);
  if (root === undefined || positiveWindowId(root.pid) !== owner.pid ||
      positiveWindowId(root.window_id ?? root.windowId) !== owner.windowId || root.complete !== true ||
      state.geometry_verified !== true && state.geometryVerified !== true) {
    return { status: "unknown", reason: "same-HWND overlay state did not prove the exact parent root and geometry", candidateObserved };
  }
  if (!hasOverlayField) return { status: "unknown", reason: "same-HWND overlay status was not explicitly reported", candidateObserved: false };
  if (rawOverlay === null) return { status: "absent" };
  const overlay = parseStructuredRecord(rawOverlay);
  if (overlay === undefined || positiveWindowId(overlay.pid) !== owner.pid ||
      positiveWindowId(overlay.window_id ?? overlay.windowId) !== owner.windowId ||
      overlay.complete !== true || overlay.geometry_verified !== true && overlay.geometryVerified !== true) {
    return { status: "unknown", reason: "same-HWND overlay root had incomplete, contradictory, or unverified identity", candidateObserved: true };
  }
  if (overlay.present === false) return { status: "absent" };
  if (overlay.present !== true) return { status: "unknown", reason: "same-HWND overlay root did not explicitly prove presence", candidateObserved: true };
  const role = transientRootRole(overlay.role);
  if (role !== "menu" && role !== "popup") return { status: "unknown", reason: "same-HWND overlay root role is not an exact menu/popup role", candidateObserved: true };
  return {
    status: "present",
    evidence: {
      kind: "overlay",
      nativeWindow: asNativeWindowIdentity(owner),
      owner: asNativeWindowIdentity(owner),
      rootRole: role,
      treeComplete: true,
      geometryVerified: true,
      visible: true,
      rootSemanticsVerified: true,
      interactionPolicy: "modal",
    },
  };
}

function isCompleteWindowState(state: Record<string, unknown> | undefined): state is Record<string, unknown> {
  return state !== undefined && state.truncated !== true && state.degraded !== true &&
    state.complete === true && state.elements_complete === true && Array.isArray(state.elements);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rootSemanticRole(value: unknown): "menu" | "popup" | "dialog" | "window" | undefined {
  if (typeof value !== "string") return undefined;
  const role = value.toLowerCase().replace(/[\s_-]/gu, "");
  if (role === "menu") return "menu";
  if (role === "popup" || role === "popupmenu" || role === "contextmenu") return "popup";
  if (role === "dialog" || role === "alertdialog" || role === "filedialog") return "dialog";
  if (role === "window") return "window";
  return undefined;
}

function transientRootRole(value: unknown): "menu" | "popup" | "dialog" | undefined {
  const role = rootSemanticRole(value);
  return role === "window" ? undefined : role;
}

function managedBrowserTargetForBinding(
  current: PrivateSession,
  binding: CuaWindowBinding,
): boolean {
  const target = current.managedBrowserTarget?.windowTarget;
  return target !== undefined && windowIdentityKey(target) === windowIdentityKey(binding.target);
}

function asNativeWindowIdentity(target: CuaWindowTarget): NativeWindowIdentity {
  return { pid: target.pid, hwnd: target.windowId };
}

function asCuaWindowTarget(target: NativeWindowIdentity): CuaWindowTarget {
  return { pid: target.pid, windowId: target.hwnd };
}

function activeSurface(current: PrivateSession) {
  const ref = current.surfaceRegistry.activeSurface;
  return ref === undefined ? undefined : current.surfaceRegistry.surfaces.get(ref.surfaceId);
}

function activeWindowBinding(current: PrivateSession): CuaWindowBinding | undefined {
  const ref = current.surfaceRegistry.activeSurface;
  if (ref === undefined || !isExecutableSurfaceRef(current.surfaceRegistry, ref)) return undefined;
  const nativeWindow = resolveNativeWindow(current.surfaceRegistry, ref);
  if (nativeWindow === undefined) return undefined;
  return current.windowBindings.get(windowIdentityKey({ pid: nativeWindow.pid, windowId: nativeWindow.hwnd }));
}

function activePeerTarget(current: PrivateSession): CuaWindowTarget | undefined {
  let surface = activeSurface(current);
  while (surface?.parentSurfaceId !== undefined) {
    surface = current.surfaceRegistry.surfaces.get(surface.parentSurfaceId);
  }
  return surface?.kind === "native_window" ? asCuaWindowTarget(surface.nativeWindow) : undefined;
}

function activeSurfaceUnavailable(current: PrivateSession): boolean {
  const ref = current.surfaceRegistry.activeSurface;
  return ref === undefined || !isExecutableSurfaceRef(current.surfaceRegistry, ref);
}

function surfaceRefForWindow(current: PrivateSession, target: CuaWindowTarget): SurfaceRef | undefined {
  let surfaceRef = current.surfaceRegistry.activeSurface;
  while (surfaceRef !== undefined) {
    const surface = current.surfaceRegistry.surfaces.get(surfaceRef.surfaceId);
    if (surface === undefined) return undefined;
    if (surface.kind === "native_window" &&
        windowIdentityKey(asCuaWindowTarget(surface.nativeWindow)) === windowIdentityKey(target)) {
      return currentSurfaceRef(current.surfaceRegistry, surface.surfaceId);
    }
    surfaceRef = surface.parentSurfaceId === undefined
      ? undefined
      : currentSurfaceRef(current.surfaceRegistry, surface.parentSurfaceId);
  }
  return undefined;
}

function surfaceSubtreeIds(registry: SurfaceRegistryState, rootSurfaceId: SurfaceRef["surfaceId"]): Set<SurfaceRef["surfaceId"]> {
  const included = new Set<SurfaceRef["surfaceId"]>([rootSurfaceId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const surface of registry.surfaces.values()) {
      if (surface.parentSurfaceId !== undefined && included.has(surface.parentSurfaceId) && !included.has(surface.surfaceId)) {
        included.add(surface.surfaceId);
        changed = true;
      }
    }
  }
  return included;
}

function isRegisteredChildWindow(current: PrivateSession, target: CuaWindowTarget): boolean {
  return [...current.surfaceRegistry.surfaces.values()].some((surface) =>
    surface.kind === "native_window" && surface.parentSurfaceId !== undefined && surface.status !== "closed" &&
    windowIdentityKey({ pid: surface.nativeWindow.pid, windowId: surface.nativeWindow.hwnd }) === windowIdentityKey(target));
}

function isTransientSurface(current: PrivateSession, ref: SurfaceRef): boolean {
  const surface = current.surfaceRegistry.surfaces.get(ref.surfaceId);
  return surface !== undefined && surface.generation === ref.generation && surface.parentSurfaceId !== undefined &&
    (surface.kind === "overlay" || surface.kind === "native_window");
}

function wasTransientSurface(current: PrivateSession, ref: SurfaceRef): boolean {
  const surface = current.surfaceRegistry.surfaces.get(ref.surfaceId);
  return surface !== undefined && surface.parentSurfaceId !== undefined &&
    (surface.kind === "overlay" || surface.kind === "native_window");
}

function syncManagedBrowserSurface(
  current: PrivateSession,
  binding: CuaWindowBinding,
  target: ManagedBrowserTarget | undefined,
  includeDocument: boolean,
): SurfaceRef | undefined {
  const activeRef = current.surfaceRegistry.activeSurface;
  if (activeRef === undefined) return undefined;
  const captureRoot = (): SurfaceRef | undefined => {
    let surface = current.surfaceRegistry.surfaces.get(activeRef.surfaceId);
    while (surface?.parentSurfaceId !== undefined) {
      surface = current.surfaceRegistry.surfaces.get(surface.parentSurfaceId);
    }
    return surface?.kind === "native_window"
      ? currentSurfaceRef(current.surfaceRegistry, surface.surfaceId)
      : undefined;
  };
  const rootRef = captureRoot();
  const root = rootRef === undefined ? undefined : current.surfaceRegistry.surfaces.get(rootRef.surfaceId);
  if (target === undefined || root?.kind !== "native_window" ||
      windowIdentityKey(asCuaWindowTarget(root.nativeWindow)) !== windowIdentityKey(binding.target) ||
      windowIdentityKey(target.windowTarget) !== windowIdentityKey(binding.target)) {
    return activeRef;
  }

  let leafRef = current.surfaceRegistry.activeSurface;
  let leaf = leafRef === undefined ? undefined : current.surfaceRegistry.surfaces.get(leafRef.surfaceId);
  while (leaf !== undefined && leaf.surfaceId !== root.surfaceId) {
    const currentRef = leafRef!;
    const parentId = leaf.parentSurfaceId;
    if (parentId === undefined) return activeRef;
    const parent = current.surfaceRegistry.surfaces.get(parentId);
    if (parent === undefined) return activeRef;
    const leafParent = leaf.parentSurfaceId === undefined
      ? undefined
      : current.surfaceRegistry.surfaces.get(leaf.parentSurfaceId);
    const sameManagedTab = leaf.kind === "browser_tab" && leaf.tabId === target.tabId && leaf.hostGeneration === target.generation;
    const sameManagedDocument = leaf.kind === "dom" && leaf.documentGeneration === target.generation &&
      leafParent?.kind === "browser_tab" && leafParent.tabId === target.tabId && leafParent.hostGeneration === target.generation;
    if (sameManagedTab || sameManagedDocument) {
      if (leaf.kind === "dom" || !includeDocument) return currentRef;
    }
    const parentRef = currentSurfaceRef(current.surfaceRegistry, parent.surfaceId);
    if (parentRef === undefined) return activeRef;
    const deactivated = deactivateChild(current.surfaceRegistry, currentRef, {
      parent: parentRef,
      parentRevalidated: true,
      childNoLongerActive: true,
    });
    if (deactivated.decision !== "applied") return activeRef;
    current.surfaceRegistry = deactivated.state;
    leafRef = deactivated.value;
    leaf = current.surfaceRegistry.surfaces.get(leafRef.surfaceId);
  }

  const currentRoot = current.surfaceRegistry.surfaces.get(root.surfaceId);
  if (currentRoot === undefined) return activeRef;
  const currentRootRef = currentSurfaceRef(current.surfaceRegistry, currentRoot.surfaceId);
  if (currentRootRef === undefined) return activeRef;
  const tab = pushChild(current.surfaceRegistry, currentRootRef, {
    kind: "browser_tab",
    tabId: target.tabId,
    hostGeneration: target.generation,
    hostAttested: true,
  });
  if (tab.decision !== "applied") return current.surfaceRegistry.activeSurface;
  current.surfaceRegistry = tab.state;
  if (!includeDocument) return tab.value;
  const document = pushChild(current.surfaceRegistry, tab.value, {
    kind: "dom",
    documentGeneration: target.generation,
    hostAttested: true,
  });
  if (document.decision !== "applied") return current.surfaceRegistry.activeSurface;
  current.surfaceRegistry = document.state;
  return document.value;
}

function targetAllowedByHostScope(
  target: CuaWindowTarget,
  allowedTargets: readonly CuaWindowTarget[] | undefined,
): boolean {
  return allowedTargets === undefined || allowedTargets.some((allowed) => windowIdentityKey(allowed) === windowIdentityKey(target));
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

function isAmbiguousForegroundResult(message: string): boolean {
  return /^foreground_unavailable:/iu.test(message) && !hasExplicitNoInputEvidence(message);
}

function resultProvesNoInput(result: { readonly text: string; readonly structuredJson?: string }): boolean {
  if (hasExplicitNoInputEvidence(result.text)) return true;
  const structured = parseStructuredRecord(result.structuredJson);
  return (structured?.input_sent === false) || (structured?.inputSent === false);
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
  signal.throwIfAborted();
  const result = await driver.callTool("bring_to_front", JSON.stringify({
    pid: target.pid,
    window_id: target.windowId,
    session,
  }), { signal });
  signal.throwIfAborted();
  if (result.isError) {
    throw new WindowContractError("WINDOW_ACTIVATION_REFUSED", "CUA bring_to_front refused the exact window target");
  }
  if (result.degraded) {
    throw new WindowContractError("WINDOW_ACTIVATION_UNKNOWN", "CUA bring_to_front returned a degraded result for the exact window target");
  }
  if (typeof result.structuredJson === "string") {
    try {
      const payload: unknown = JSON.parse(result.structuredJson);
      if (payload !== null && typeof payload === "object" && !Array.isArray(payload) &&
          "landed_on_target" in payload && payload.landed_on_target === false) {
        throw new WindowContractError("WINDOW_ACTIVATION_REFUSED", "CUA bring_to_front did not land on the exact window target");
      }
    } catch (error) {
      if (error instanceof WindowContractError) throw error;
      // An unavailable optional result field is not focus evidence; the
      // retained per-action foreground guard remains authoritative.
    }
  }
}

export type CuaDriverFactory = (socketPath: string) => CuaDriverLike;
export type CuaWindowDeliveryMode = "background" | "foreground";
export type CuaGroundingMode = "off" | "uia-catalog-v1" | "dom-catalog-v1" | "hybrid-catalog-v1";
export type CuaWindowSwitchMode = "off" | "opened-windows-v1";

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
  /** Explicit per-Run permission to discover and switch among opened windows. */
  windowSwitch?: CuaWindowSwitchMode;
  /**
   * Optional exact host-authorized target scope for every window transition.
   * When set, returning to the Run-owned browser also requires its HWND here.
   */
  windowSwitchAllowedTargets?: readonly CuaWindowTarget[];
  /** Injected host-only read-only relationship evidence; absent/failed means manual transient handling. */
  windowRelationshipProbe?: WindowRelationshipProbe;
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
  platform?: "win32" | "darwin" | "linux";
  descriptor: ComputerSessionDescriptor;
  active: boolean;
  surfaceRegistry: SurfaceRegistryState;
  /** Exact HWND geometry snapshots, keyed by Registry-owned Surface identity. */
  windowBindings: Map<string, CuaWindowBinding>;
  /** Full visible-window baseline from the last successful target observation. */
  visibleWindowBaseline: ReadonlySet<string> | undefined;
  /** Fresh inventory immediately before an opted-in foreground GUI action. */
  preActionWindowBaseline: {
    readonly targetKeys: ReadonlySet<string>;
    readonly complete: boolean;
    readonly truncated: boolean;
    readonly parentSurfaceRef: SurfaceRef;
    readonly parentBinding: CuaWindowBinding;
  } | undefined;
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
  /** Run-owned managed target survives switching to native windows. */
  managedBrowserTarget?: ManagedBrowserTarget;
  /** Opaque Run-local peer Surface refs emitted by the latest listWindows call. */
  windowRefs: Map<string, SurfaceRef>;
  /** SurfaceRegistry mutation reason attached to the next successful capture. */
  pendingSurfaceTransitionReason?: SurfaceTransitionReason;
}

interface PendingDriverCleanup {
  label: string;
  driver: CuaDriverLike;
}

interface PrivateObservation {
  sessionId: string;
  readonly surfaceRef: SurfaceRef;
  /**
   * The image coordinate space that the model used for this observation.
   * Window actions must be projected from this viewport, not from the
   * current session viewport (which may belong to a later observation).
   */
  viewport: Viewport;
  geometry?: CuaWindowGeometry;
}

interface PrivateGrounding {
  readonly catalog: Omit<GroundingCatalog, "surfaceRef">;
  /** Exact native surface and window lifecycle that produced this catalog. */
  readonly windowBinding?: CuaWindowBinding;
  /** Current host-attested tab/generation, retained only by the Adapter. */
  readonly browserTarget?: ManagedBrowserTarget;
  /** Trusted physical browser content rect derived from the same observation's UIA Document. */
  readonly contentRect?: DomGroundingContentRect;
  readonly elements: ReadonlyMap<string, PrivateGroundingElement>;
}

interface BoundPrivateGrounding extends Omit<PrivateGrounding, "catalog"> {
  readonly catalog: GroundingCatalog;
  readonly surfaceRef: SurfaceRef;
}

interface PrivateGroundingElement {
  readonly element: GroundingElement;
  readonly point: { readonly x: number; readonly y: number };
  readonly candidateFingerprint?: string;
  readonly candidateFrame?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly selectable?: boolean;
  readonly geometry?: CuaWindowGeometry;
  /** Stable private identity; excludes element token and editable value. */
  readonly uiaIdentityFingerprint?: string;
  /** Private Observation-bound fact: the pre-action UIA value was absent or empty. */
  readonly preValueEmpty?: boolean;
  /** Raw UIA token and snapshot are never projected to Runtime or Providers. */
  readonly uiaTarget?: { readonly pid: number; readonly windowId: number; readonly elementToken: string; readonly snapshotId?: string };
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
  private readonly groundings = new Map<string, BoundPrivateGrounding>();
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
      ...(options.windowSwitchAllowedTargets === undefined
        ? {}
        : { windowSwitchAllowedTargets: options.windowSwitchAllowedTargets.map((target) => ({ ...target })) }),
    };
    if (!Number.isInteger(this.options.cleanupWaitMs) || this.options.cleanupWaitMs <= 0) {
      throw new Error("cleanupWaitMs must be a positive integer");
    }
    if (this.options.windowDeliveryMode !== undefined
      && this.options.windowDeliveryMode !== "background"
      && this.options.windowDeliveryMode !== "foreground") {
      throw new Error("windowDeliveryMode must be background or foreground");
    }
    if (this.options.windowSwitch !== undefined
      && this.options.windowSwitch !== "off"
      && this.options.windowSwitch !== "opened-windows-v1") {
      throw new Error("windowSwitch must be off or opened-windows-v1");
    }
    if (this.options.windowTarget !== undefined) validateWindowTarget(this.options.windowTarget);
    for (const target of this.options.windowSwitchAllowedTargets ?? []) validateWindowTarget(target);
    if (this.options.grounding !== undefined && !["off", "uia-catalog-v1", "dom-catalog-v1", "hybrid-catalog-v1"].includes(this.options.grounding)) {
      throw new Error("grounding must be off, uia-catalog-v1, dom-catalog-v1 or hybrid-catalog-v1");
    }
    if (this.options.grounding === "uia-catalog-v1" && this.options.windowTarget === undefined) {
      throw new Error("uia-catalog-v1 grounding requires an explicit CUA window target");
    }
    if (this.options.grounding === "dom-catalog-v1" || this.options.grounding === "hybrid-catalog-v1") {
      if (this.options.browserTarget === undefined) throw new DomGroundingUnavailableError("DOM grounding requires an explicit managed Chromium/Edge target");
      validateManagedBrowserTarget(this.options.browserTarget);
      const browserIsInitialTarget = this.options.windowTarget !== undefined &&
        this.options.browserTarget.windowTarget.pid === this.options.windowTarget.pid &&
        this.options.browserTarget.windowTarget.windowId === this.options.windowTarget.windowId;
      if (!browserIsInitialTarget && (this.options.windowSwitch !== "opened-windows-v1" ||
          !targetAllowedByHostScope(this.options.browserTarget.windowTarget, this.options.windowSwitchAllowedTargets))) {
        throw new DomGroundingUnavailableError("a managed browser target distinct from the initial binding requires cross-window opt-in and Host authorization");
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
      const platform = await detectCuaPlatform(driver, signal);
      let viewport: Viewport;
      let windowBinding: CuaWindowBinding | undefined;
      let surfaceRegistry = createSurfaceRegistry(label);
      const windowBindings = new Map<string, CuaWindowBinding>();
      if (this.options.windowTarget === undefined) {
        const size = await callTool(driver, "get_screen_size", { session: label }, signal);
        const dimensions = readStructuredDimensions(size);
        if (dimensions === undefined) {
          throw new Error("CUA get_screen_size did not return width/height");
        }
        viewport = { ...dimensions, coordinateSpace: "physical" };
        const desktop = registerDesktopSurface(surfaceRegistry, PRIMARY_DESKTOP.display_id);
        if (desktop.decision !== "applied") throw new Error(`CUA primary desktop Surface could not be registered: ${desktop.reason}`);
        surfaceRegistry = desktop.state;
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
        const peer = registerNativePeer(surfaceRegistry, asNativeWindowIdentity(capture.binding.target));
        if (peer.decision !== "applied") throw new Error(`CUA initial native Surface could not be registered: ${peer.reason}`);
        const active = activatePeer(peer.state, peer.value, {
          nativeWindow: asNativeWindowIdentity(capture.binding.target),
          identityVerified: true,
          captureVerified: true,
        });
        if (active.decision !== "applied") throw new Error(`CUA initial native Surface could not be activated: ${active.reason}`);
        surfaceRegistry = active.state;
        windowBindings.set(windowIdentityKey(capture.binding.target), capture.binding);
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
      const browserIsInitialTarget = windowBinding !== undefined && this.options.browserTarget !== undefined &&
        windowIdentityKey(windowBinding.target) === windowIdentityKey(this.options.browserTarget.windowTarget);
      this.session = {
        label,
        driver,
        ...(platform === undefined ? {} : { platform }),
        descriptor,
        active: true,
        surfaceRegistry,
        windowBindings,
        visibleWindowBaseline: undefined,
        preActionWindowBaseline: undefined,
        newlySurfacedWindowKeys: new Set(),
        newHandoffCandidates: [],
        foregroundMismatchWindowId: undefined,
        proactiveHandoffCandidatesReady: false,
        ...(this.options.browserTarget === undefined ? {} : {
          ...(browserIsInitialTarget ? { browserTarget: this.options.browserTarget! } : {}),
          managedBrowserTarget: this.options.browserTarget,
        }),
        windowRefs: new Map(),
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
    if (activeSurfaceUnavailable(current)) {
      throw normalizeDriverError(new WindowContractError("WINDOW_TARGET_INVALIDATED", "window target identity was invalidated; close and open a new session"), "observe");
    }
    let observedSurfaceRef = current.surfaceRegistry.activeSurface!;
    const currentSurface = activeSurface(current);
    if (currentSurface?.kind === "desktop") {
      if (resolveDisplayId(current.surfaceRegistry, observedSurfaceRef) !== PRIMARY_DESKTOP.display_id) {
        throw normalizeDriverError(new WindowContractError("DESKTOP_SURFACE_UNKNOWN", "active desktop Surface has no supported display identity"), "observe");
      }
      await mkdir(this.options.screenshotDir, { recursive: true });
      const screenshotPath = join(this.options.screenshotDir, `${safeId(String(observationId))}.png`);
      try {
        const result = await callTool(current.driver, "get_desktop_state", {
          session: current.label,
          screenshot_out_file: screenshotPath,
        }, signal);
        const dimensions = readStructuredScreenshotDimensions(result) ?? await readPngDimensions(screenshotPath);
        if (dimensions === undefined) throw new Error("CUA get_desktop_state did not return screenshot dimensions");
        if (dimensions.width !== current.descriptor.viewport.width || dimensions.height !== current.descriptor.viewport.height) {
          const advanced = advanceSurfaceGeneration(current.surfaceRegistry, observedSurfaceRef);
          if (advanced.decision !== "applied") {
            throw new WindowContractError("DESKTOP_SURFACE_UNKNOWN", "desktop dimensions changed but the Surface generation could not advance");
          }
          current.surfaceRegistry = advanced.state;
          observedSurfaceRef = advanced.value;
          noteSurfaceTransition(current, "generation_advanced");
          current.descriptor = { ...current.descriptor, viewport: { ...dimensions, coordinateSpace: "physical" } };
          current.windowRefs.clear();
          this.clearTargetObservationState(current, observedSurfaceRef);
        }
        const data = new Uint8Array(await readFile(screenshotPath));
        this.observations.set(String(observationId), {
          sessionId: String(session.id),
          surfaceRef: observedSurfaceRef,
          viewport: current.descriptor.viewport,
        });
        this.latestObservationId = observationId;
        const surfaceTransitionReason = takeSurfaceTransitionReason(current);
        return {
          capturedAt: new Date().toISOString(),
          viewport: current.descriptor.viewport,
          surfaceRef: observedSurfaceRef,
          ...(surfaceTransitionReason === undefined ? {} : { surfaceTransitionReason }),
          screenshot: { mediaType: "image/png", data },
        };
      } catch (error) {
        const details = driverErrorDetails(error);
        if (details.tag === "Transport") current.active = false;
        throw normalizeDriverError(error, "observe");
      }
    }
    if (currentSurface === undefined) {
      throw normalizeDriverError(new WindowContractError("SURFACE_UNKNOWN", "active Surface has no executable identity"), "observe");
    }
    await this.reconcileActiveTransientChild(current, signal);
    const captureBinding = activeWindowBinding(current);
    if (captureBinding === undefined) {
      throw normalizeDriverError(new WindowContractError("WINDOW_TARGET_INVALIDATED", "active Surface has no verified native capture binding"), "observe");
    }
    {
      try {
        const capture = await captureWindowWithRetry(current.driver, current.label, captureBinding.target, signal, this.options.windowCaptureRetry);
        const liveBinding = capture.binding;
        const previousBinding = current.windowBindings.get(windowIdentityKey(liveBinding.target));
        if (previousBinding !== undefined && !sameWindowGeometry(previousBinding.bounds, liveBinding.bounds)) {
          const geometrySurface = surfaceRefForWindow(current, liveBinding.target);
          if (geometrySurface === undefined) {
            throw new WindowContractError("SURFACE_UNKNOWN", "window geometry changed without a registered Surface owner");
          }
          const advanced = advanceSurfaceGeneration(current.surfaceRegistry, geometrySurface);
          if (advanced.decision !== "applied") {
            throw new WindowContractError("SURFACE_UNKNOWN", "window geometry changed but its Surface generation could not advance");
          }
          current.surfaceRegistry = advanced.state;
          noteSurfaceTransition(current, "generation_advanced");
          this.clearTargetObservationState(current, geometrySurface);
        }
        current.windowBindings.set(windowIdentityKey(liveBinding.target), liveBinding);
        current.descriptor = { ...current.descriptor, viewport: capture.viewport };
        if (this.options.windowDeliveryMode === "foreground") {
          try {
            const visibleWindows = await listWindowTargets(current.driver, current.label, signal, undefined, true, this.options.windowRelationshipProbe);
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
        const leafBeforeGrounding = activeSurface(current);
        const managedDomAllowed = leafBeforeGrounding?.kind !== "overlay" &&
          (leafBeforeGrounding?.kind !== "native_window" || leafBeforeGrounding.parentSurfaceId === undefined);
        const activeBrowserTarget = managedDomAllowed && managedBrowserTargetForBinding(current, liveBinding)
          ? current.browserTarget ?? current.managedBrowserTarget
          : undefined;
        const grounding = await readWindowGrounding(
          this.options.grounding,
          current.driver,
          current.label,
          liveBinding,
          capture.viewport,
          observationId,
          session.id,
          activeBrowserTarget,
          this.options.domGroundingTransport,
          signal,
        );
        const observedBrowserTarget = grounding?.browserTarget ?? activeBrowserTarget;
        const includeDomSurface = grounding?.browserTarget !== undefined &&
          (grounding.catalog.source === "dom" || grounding.catalog.source === "hybrid");
        const activeRefBeforeSync = current.surfaceRegistry.activeSurface;
        const surfaceRef = syncManagedBrowserSurface(current, liveBinding, observedBrowserTarget, includeDomSurface);
        if (surfaceRef === undefined || !isExecutableSurfaceRef(current.surfaceRegistry, surfaceRef)) {
          throw new WindowContractError("SURFACE_UNKNOWN", "active Surface lineage could not be established for the captured frame");
        }
        if (activeRefBeforeSync !== undefined &&
            (activeRefBeforeSync.surfaceId !== surfaceRef.surfaceId || activeRefBeforeSync.generation !== surfaceRef.generation ||
              activeRefBeforeSync.kind !== surfaceRef.kind || activeRefBeforeSync.parentSurfaceId !== surfaceRef.parentSurfaceId ||
              activeRefBeforeSync.admissionSource !== surfaceRef.admissionSource)) {
          const reason: SurfaceTransitionReason = activeRefBeforeSync.surfaceId === surfaceRef.surfaceId
            ? "generation_advanced"
            : activeRefBeforeSync.parentSurfaceId === surfaceRef.surfaceId
              ? "child_pop"
              : surfaceRef.parentSurfaceId === activeRefBeforeSync.surfaceId
                ? "child_push"
                : "peer_switch";
          noteSurfaceTransition(current, reason);
          this.clearSurfaceLineageObservationState(current, activeRefBeforeSync);
        }
        this.observations.set(String(observationId), {
          sessionId: String(session.id),
          surfaceRef,
          viewport: capture.viewport,
          geometry: liveBinding.bounds,
        });
        if (grounding !== undefined) {
          if (grounding.browserTarget !== undefined) current.browserTarget = grounding.browserTarget;
          const boundGrounding: BoundPrivateGrounding = {
            ...grounding,
            catalog: { ...grounding.catalog, surfaceRef },
            surfaceRef,
            windowBinding: liveBinding,
          };
          this.groundings.set(String(observationId), boundGrounding);
        } else if (!managedBrowserTargetForBinding(current, liveBinding)) {
          delete current.browserTarget;
        }
        this.latestObservationId = observationId;
        const surfaceTransitionReason = takeSurfaceTransitionReason(current);
        const boundGrounding = grounding === undefined
          ? undefined
          : { ...grounding.catalog, surfaceRef } satisfies GroundingCatalog;
        return {
          capturedAt: new Date().toISOString(),
          viewport: capture.viewport,
          surfaceRef,
          ...(surfaceTransitionReason === undefined ? {} : { surfaceTransitionReason }),
          screenshot: { mediaType: "image/png", data: capture.data },
          ...(boundGrounding === undefined ? {} : { grounding: boundGrounding }),
        };
      } catch (error) {
        const details = driverErrorDetails(error);
        if (error instanceof WindowContractError && error.code === "WINDOW_TARGET_NOT_FOUND") {
          const activeRef = current.surfaceRegistry.activeSurface;
          if (activeRef !== undefined) {
            const invalidated = markSurfaceUnknown(current.surfaceRegistry, activeRef);
            if (invalidated.decision === "applied") current.surfaceRegistry = invalidated.state;
          }
          current.windowRefs.clear();
          this.clearTargetObservationState(current, activeRef);
        }
        if (details.tag === "Transport") current.active = false;
        throw normalizeDriverError(error, "observe");
      }
    }
  }

  private async reconcileActiveTransientChild(current: PrivateSession, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const ref = current.surfaceRegistry.activeSurface;
    if (ref === undefined || !isExecutableSurfaceRef(current.surfaceRegistry, ref)) {
      throw new WindowContractError("SURFACE_UNKNOWN", "active Surface is not executable");
    }
    const child = current.surfaceRegistry.surfaces.get(ref.surfaceId);
    if (child?.parentSurfaceId === undefined || (child.kind !== "overlay" && child.kind !== "native_window")) return;
    const parent = current.surfaceRegistry.surfaces.get(child.parentSurfaceId);
    const parentRef = parent === undefined ? undefined : currentSurfaceRef(current.surfaceRegistry, parent.surfaceId);
    const parentNative = parentRef === undefined ? undefined : resolveNativeWindow(current.surfaceRegistry, parentRef);
    if (parent === undefined || parentRef === undefined || parentNative === undefined) {
      throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", "transient Surface parent identity is unavailable");
    }
    const parentTarget = asCuaWindowTarget(parentNative);
    let childAbsent = false;
    if (child.kind === "overlay") {
      const verification = await verifySameHwndOverlay(current.driver, current.label, parentTarget, signal);
      if (verification.status === "unknown") {
        throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", verification.reason);
      }
      childAbsent = verification.status === "absent";
    } else {
      const childTarget = asCuaWindowTarget(child.nativeWindow);
      const inventory = await listWindowInventory(current.driver, current.label, signal, undefined, false, this.options.windowRelationshipProbe);
      const candidate = inventory.windows.find((window) => windowIdentityKey(window.target) === windowIdentityKey(childTarget));
      // Menus can retain their native HWND after ESC. A complete snapshot can
      // prove that the admitted interaction Surface is gone without claiming
      // that the OS destroyed the HWND. Never reuse Stage1 on this hidden row.
      const hiddenChild = candidate?.isOnScreen === false && candidate.minimized === false &&
        candidate.ownerPid === parentTarget.pid && candidate.ownerWindowId === parentTarget.windowId;
      if (candidate === undefined || hiddenChild) {
        if (!inventory.complete) {
          throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", "incomplete inventory cannot prove that the transient HWND disappeared; child state is retained for manual handling");
        }
        const exactParent = inventory.windows.find((window) => windowIdentityKey(window.target) === windowIdentityKey(parentTarget));
        if (exactParent?.isOnScreen !== true || exactParent.minimized === true || !isCurrentSurfaceRef(current.surfaceRegistry, parentRef)) {
          throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", "the exact parent is not currently present and visible; child state is retained for manual handling");
        }
        const replacement = inventory.windows.some((window) =>
          windowIdentityKey(window.target) !== windowIdentityKey(childTarget) &&
          (window.target.windowId === childTarget.windowId ||
            window.target.pid === parentTarget.pid && window.ownerWindowId === parentTarget.windowId &&
            (window.ownerPid === undefined || window.ownerPid === parentTarget.pid) && window.isOnScreen !== false));
        if (replacement) {
          throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", "a replacement owned HWND prevents proving that the interaction Surface closed; child state is retained for manual handling");
        }
        childAbsent = true;
      } else {
        let evidence: TransientChildEvidence | undefined;
        try {
          const stageOne = assessOwnedTransientWindowAdmission({
            parent: parentTarget,
            candidate,
            inventory,
            surfacedWindowCount: 1,
            baselineComplete: inventory.complete,
            baselineTruncated: inventory.truncated === true,
            parentSurfaceCurrent: isCurrentSurfaceRef(current.surfaceRegistry, parentRef),
          });
          if (stageOne.decision !== "admitted") {
            throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", stageOne.reason);
          }
          evidence = await verifyTransientNativeChildRoot(
            current.driver, current.label, parentTarget, candidate, inventory, inventory.complete,
            this.options.grounding === "uia-catalog-v1" || this.options.grounding === "hybrid-catalog-v1", signal,
          );
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof WindowContractError) throw error;
          if (driverErrorDetails(error).tag === "Transport") current.active = false;
          throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", "transient HWND owner/root proof errored; child state is retained for manual handling");
        }
        if (evidence === undefined || evidence.kind !== "native_window") {
          throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", "transient HWND lost exact owner, root-role, or frontmost evidence; child state is retained for manual handling");
        }
        const previousBinding = current.windowBindings.get(windowIdentityKey(childTarget));
        if (previousBinding !== undefined && !sameWindowGeometry(previousBinding.bounds, candidate.bounds)) {
          const advanced = advanceSurfaceGeneration(current.surfaceRegistry, ref);
          if (advanced.decision === "applied") {
            current.surfaceRegistry = advanced.state;
            noteSurfaceTransition(current, "generation_advanced");
            this.clearTargetObservationState(current, ref);
          }
        }
        current.windowBindings.set(windowIdentityKey(candidate.target), { target: candidate.target, bounds: candidate.bounds });
      }
    }
    if (!childAbsent) return;

    const parentBinding = await discoverWindow(current.driver, current.label, parentTarget, signal);
    const freshParentRef = currentSurfaceRef(current.surfaceRegistry, parent.surfaceId);
    if (freshParentRef === undefined) throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", "parent Surface generation changed during pop verification");
    const popped = popChild(current.surfaceRegistry, ref, {
      parent: freshParentRef,
      parentRevalidated: true,
      childAbsent: true,
    });
    if (popped.decision !== "applied") {
      throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", popped.reason);
    }
    current.surfaceRegistry = popped.state;
    noteSurfaceTransition(current, "child_pop");
    current.windowRefs.clear();
    this.clearTargetObservationState(current, ref, freshParentRef);
    current.windowBindings.set(windowIdentityKey(parentBinding.target), parentBinding);
    if (child.kind === "native_window") current.windowBindings.delete(windowIdentityKey(asCuaWindowTarget(child.nativeWindow)));
  }

  public async listWindowHandoffCandidates(session: ComputerSessionDescriptor, signal: AbortSignal): Promise<readonly ComputerWindowCandidate[]> {
    const current = this.requireSession(session);
    current.windowRefs.clear();
    if (!this.canUseManualWindowHandoff(current)) {
      throw new Error("window handoff is available only for an explicitly bound native window");
    }
    const windows = await listWindowTargets(current.driver, current.label, signal, undefined, true, this.options.windowRelationshipProbe);
    const unauthorizedForeground = current.foregroundMismatchWindowId === undefined
      ? undefined
      : windows.find((window) => window.target.windowId === current.foregroundMismatchWindowId &&
        !targetAllowedByHostScope(window.target, this.options.windowSwitchAllowedTargets));
    if (unauthorizedForeground !== undefined) {
      throw new WindowContractError("WINDOW_SCOPE_REQUIRED", "the foreground window is outside the host-authorized window scope");
    }
    const candidates = windows
      .filter((window) => targetAllowedByHostScope(window.target, this.options.windowSwitchAllowedTargets))
      .filter((window) => !isRegisteredChildWindow(current, window.target))
      .map((window) => ({
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

  /**
   * Return the top-level windows CUA reports without its on-screen-only
   * filter, using opaque per-Run refs. Dispatch still rechecks the exact
   * native identity and captures the selected target fresh.
   */
  public async listWindows(session: ComputerSessionDescriptor, signal: AbortSignal): Promise<readonly ComputerWindowOption[]> {
    const current = this.requireSession(session);
    current.windowRefs.clear();
    if (this.options.windowSwitch !== "opened-windows-v1") {
      throw new WindowContractError("WINDOW_SWITCH_DISABLED", "cross-window switching is not enabled for this Run");
    }
    if (activeSurfaceUnavailable(current)) {
      throw new WindowContractError("WINDOW_TARGET_INVALIDATED", "window target identity was invalidated; close and open a new session");
    }
    signal.throwIfAborted();
    const inventory = await listWindowTargets(current.driver, current.label, signal, undefined, false, this.options.windowRelationshipProbe);
    signal.throwIfAborted();
    const boundPeer = activePeerTarget(current);
    if (boundPeer !== undefined && !inventory.some((window) => windowIdentityKey(window.target) === windowIdentityKey(boundPeer))) {
      const activeRef = current.surfaceRegistry.activeSurface;
      if (activeRef !== undefined) {
        const invalidated = markSurfaceUnknown(current.surfaceRegistry, activeRef);
        if (invalidated.decision === "applied") current.surfaceRegistry = invalidated.state;
      }
      current.windowRefs.clear();
      this.clearTargetObservationState(current, activeRef);
      throw new WindowContractError("WINDOW_TARGET_NOT_FOUND", "current bound window is missing from the opened-window inventory");
    }
    const childWindowKeys = new Set([...current.surfaceRegistry.surfaces.values()]
      .filter((surface): surface is Extract<SurfaceRecord, { readonly kind: "native_window" }> =>
        surface.kind === "native_window" && surface.parentSurfaceId !== undefined && surface.status !== "closed")
      .map((surface) => windowIdentityKey(asCuaWindowTarget(surface.nativeWindow))));
    const windows = inventory
      .filter((window) => targetAllowedByHostScope(window.target, this.options.windowSwitchAllowedTargets))
      .filter((window) => !childWindowKeys.has(windowIdentityKey(window.target)));
    const currentKey = boundPeer === undefined ? undefined : windowIdentityKey(boundPeer);
    return windows.map((window) => {
      const peer = registerNativePeer(current.surfaceRegistry, asNativeWindowIdentity(window.target));
      if (peer.decision !== "applied") return undefined;
      current.surfaceRegistry = peer.state;
      const windowRef = `win-${randomUUID()}`;
      current.windowRefs.set(windowRef, peer.value);
      return {
        windowRef,
        ...(window.appName === undefined ? {} : { appName: window.appName }),
        ...(window.title === undefined ? {} : { title: window.title }),
        isCurrent: currentKey === windowIdentityKey(window.target),
      };
    }).filter((window): window is ComputerWindowOption => window !== undefined);
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
    const activeBeforeReconcile = current.surfaceRegistry.activeSurface;
    // Consume the one-shot pre-action authorization before any asynchronous
    // reconciliation or inventory/proof call; uncertain outcomes are not replayable.
    current.preActionWindowBaseline = undefined;
    await this.reconcileActiveTransientChild(current, signal);
    if (baseline !== undefined && sameSurfaceRef(activeBeforeReconcile, baseline.parentSurfaceRef) &&
        baseline.parentSurfaceRef.parentSurfaceId !== undefined &&
        current.surfaceRegistry.activeSurface?.surfaceId === baseline.parentSurfaceRef.parentSurfaceId &&
        !isCurrentSurfaceRef(current.surfaceRegistry, baseline.parentSurfaceRef)) {
      // Reconciliation already proved the transient child absent and popped
      // to its parent; there is no new-window diff to apply to the old child.
      return [];
    }
    current.proactiveHandoffCandidatesReady = false;
    current.newHandoffCandidates = [];
    current.newlySurfacedWindowKeys = new Set();
    const ownerBinding = activeWindowBinding(current);
    if (baseline === undefined || ownerBinding === undefined || this.options.windowDeliveryMode !== "foreground") return [];
    const ownerTarget = ownerBinding.target;
    if (!sameSurfaceRef(baseline.parentSurfaceRef, current.surfaceRegistry.activeSurface) ||
        !isCurrentSurfaceRef(current.surfaceRegistry, baseline.parentSurfaceRef) ||
        !isExecutableSurfaceRef(current.surfaceRegistry, baseline.parentSurfaceRef) ||
        windowIdentityKey(ownerTarget) !== windowIdentityKey(baseline.parentBinding.target)) {
      throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", "the pre-action parent Surface generation or exact binding is no longer active");
    }
    const freshParentBinding = await discoverWindow(current.driver, current.label, baseline.parentBinding.target, signal);
    if (!sameWindowGeometry(freshParentBinding.bounds, baseline.parentBinding.bounds)) {
      const advanced = advanceSurfaceGeneration(current.surfaceRegistry, baseline.parentSurfaceRef);
      if (advanced.decision === "applied") {
        current.surfaceRegistry = advanced.state;
        noteSurfaceTransition(current, "generation_advanced");
      }
      current.windowBindings.set(windowIdentityKey(freshParentBinding.target), freshParentBinding);
      this.clearTargetObservationState(current, baseline.parentSurfaceRef);
      throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", "the parent window geometry changed after the action; observe again before transient admission");
    }
    const readDiff = async (): Promise<{
      readonly surfaced: readonly CuaWindowInfo[];
      readonly complete: boolean;
      readonly sourceInventory: CuaWindowInventory;
      readonly potentialOwnedTransientChild?: CuaWindowInfo;
    }> => {
      signal.throwIfAborted();
      const inventory = await listWindowInventory(current.driver, current.label, signal, undefined, true, this.options.windowRelationshipProbe);
      signal.throwIfAborted();
      const surfaced = inventory.windows.filter((window) => !baseline.targetKeys.has(windowIdentityKey(window.target)));
      // Peer authorization must not bypass owned-child classification. A
      // partial exact-owner match (or trusted transient class with no owner)
      // stays unknown, never a peer fallback. Same PID alone is not ownership.
      const potentialChildren = surfaced.filter((window) =>
        window.target.pid === baseline.parentBinding.target.pid &&
        (window.ownerPid === undefined || window.ownerPid === baseline.parentBinding.target.pid) &&
        (window.ownerWindowId === undefined || window.ownerWindowId === baseline.parentBinding.target.windowId) &&
        (window.ownerPid === baseline.parentBinding.target.pid ||
          window.ownerWindowId === baseline.parentBinding.target.windowId ||
          trustedWindowClassRootRole(window.windowClass) !== undefined));
      if (potentialChildren.length > 0) {
        const candidate = potentialChildren[0]!;
        const parentSurfaceCurrent = sameSurfaceRef(baseline.parentSurfaceRef, current.surfaceRegistry.activeSurface) &&
          isCurrentSurfaceRef(current.surfaceRegistry, baseline.parentSurfaceRef) &&
          isExecutableSurfaceRef(current.surfaceRegistry, baseline.parentSurfaceRef) &&
          windowIdentityKey(activeWindowBinding(current)?.target ?? { pid: 0, windowId: 0 }) === windowIdentityKey(baseline.parentBinding.target);
        const stageOne = assessOwnedTransientWindowAdmission({
          parent: baseline.parentBinding.target,
          candidate,
          inventory,
          surfacedWindowCount: surfaced.length,
          baselineComplete: baseline.complete,
          baselineTruncated: baseline.truncated,
          parentSurfaceCurrent,
        });
        if (stageOne.decision !== "admitted") {
          throw new WindowContractError(stageOne.code, stageOne.reason);
        }
        return { surfaced, complete: inventory.complete, sourceInventory: inventory, potentialOwnedTransientChild: candidate };
      }
      if (surfaced.some((window) => !targetAllowedByHostScope(window.target, this.options.windowSwitchAllowedTargets))) {
        throw new WindowContractError("WINDOW_SCOPE_REQUIRED", "newly surfaced windows are outside the host-authorized target scope");
      }
      return { surfaced, complete: inventory.complete, sourceInventory: inventory };
    };
    let inventory = await readDiff();
    // Some native dialogs appear just after the initiating tool returns. One
    // short abort-aware poll catches that case without a long pause or retry.
    if (inventory.surfaced.length === 0 && inventory.complete && baseline.complete) {
      await waitWithAbort(80, signal);
      inventory = await readDiff();
    }
    const surfaced = inventory.surfaced;
    const exactInventoryForAutoPush = baseline.complete && inventory.complete;
    if (!exactInventoryForAutoPush && surfaced.length === 0) {
      throw new WindowContractError("WINDOW_INVENTORY_UNKNOWN", "window inventory was incomplete or truncated; popup state requires manual handling");
    }
    let pushedChild = false;
    const supportsTransientUia = this.options.grounding === "uia-catalog-v1" || this.options.grounding === "hybrid-catalog-v1";
    const provisionalCandidate = inventory.potentialOwnedTransientChild;
    const provisionalClassRoot = trustedWindowClassRootRole(provisionalCandidate?.windowClass);
    const canProveWithoutUia = provisionalClassRoot === "dialog" ||
      provisionalClassRoot === "menu" && inventory.complete && baseline.complete;
    if (provisionalCandidate !== undefined && !supportsTransientUia && !canProveWithoutUia) {
      throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", "owned transient child has no trusted root proof; candidate is withheld from the peer picker");
    }
    const parentRef = current.surfaceRegistry.activeSurface;
    if (exactInventoryForAutoPush && supportsTransientUia && parentRef !== undefined && surfaced.length === 0) {
      const overlayVerification = await verifySameHwndOverlay(current.driver, current.label, ownerTarget, signal);
      if (overlayVerification.status === "unknown" && overlayVerification.candidateObserved) {
        throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", `${overlayVerification.reason}; same-HWND menu transition requires manual handling`);
      }
      if (overlayVerification.status === "present") {
        const pushed = pushChild(current.surfaceRegistry, parentRef, overlayVerification.evidence);
        if (pushed.decision === "applied") {
          current.surfaceRegistry = pushed.state;
          noteSurfaceTransition(current, "child_push");
          pushedChild = true;
          current.windowRefs.clear();
          this.clearTargetObservationState(current, parentRef);
        } else if (pushed.decision === "manual") {
          throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", `${pushed.reason}; same-HWND menu transition requires manual handling`);
        }
      }
    }
    if (!pushedChild && (supportsTransientUia || canProveWithoutUia) && surfaced.length === 1 && parentRef !== undefined && provisionalCandidate !== undefined) {
      const candidate = surfaced[0]!;
      const stageOne = assessOwnedTransientWindowAdmission({
        parent: ownerTarget,
        candidate,
        inventory: inventory.sourceInventory,
        surfacedWindowCount: surfaced.length,
        baselineComplete: baseline.complete,
        baselineTruncated: baseline.truncated,
        parentSurfaceCurrent: sameSurfaceRef(baseline.parentSurfaceRef, current.surfaceRegistry.activeSurface) &&
          isCurrentSurfaceRef(current.surfaceRegistry, baseline.parentSurfaceRef) &&
          isExecutableSurfaceRef(current.surfaceRegistry, baseline.parentSurfaceRef),
      });
      if (stageOne.decision !== "admitted") {
        if (inventory.potentialOwnedTransientChild !== undefined) {
          throw new WindowContractError(stageOne.code, `${stageOne.reason}; candidate is withheld from the peer picker`);
        }
      }
      let evidence: TransientChildEvidence | undefined;
      if (stageOne.decision === "admitted") {
        try {
          evidence = await verifyTransientNativeChildRoot(
            current.driver, current.label, ownerTarget, candidate, inventory.sourceInventory, baseline.complete,
            supportsTransientUia, signal,
          );
        } catch (error) {
          signal.throwIfAborted();
          if (driverErrorDetails(error).tag === "Transport") current.active = false;
          if (inventory.potentialOwnedTransientChild !== undefined) {
            throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", "owned transient child root proof errored; candidate is withheld from the peer picker");
          }
          throw error;
        }
      }
      if (inventory.potentialOwnedTransientChild !== undefined &&
          (evidence === undefined || evidence.kind !== "native_window")) {
        throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", "owned transient child root proof failed or was incomplete; candidate is withheld from the peer picker");
      }
      if (evidence !== undefined) {
        const pushed = pushChild(current.surfaceRegistry, parentRef, evidence);
        if (pushed.decision === "applied") {
          current.surfaceRegistry = pushed.state;
          noteSurfaceTransition(current, "child_push");
          pushedChild = true;
          current.windowRefs.clear();
          this.clearTargetObservationState(current, parentRef);
          if (evidence.kind === "native_window") {
            current.windowBindings.set(windowIdentityKey(candidate.target), { target: candidate.target, bounds: candidate.bounds });
          }
        } else if (pushed.decision === "manual") {
          if (inventory.potentialOwnedTransientChild !== undefined) {
            throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", `${pushed.reason}; candidate is withheld from the peer picker`);
          }
          // An in-scope, non-child candidate may still use the ordinary Host-confirmed picker.
        } else if (inventory.potentialOwnedTransientChild !== undefined) {
          throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", `${pushed.reason}; candidate is withheld from the peer picker`);
        }
      }
    }
    const handoffWindows = pushedChild ? [] : surfaced;
    const candidates = handoffWindows.map((window) => ({
      pid: window.target.pid,
      windowId: window.target.windowId,
      ...(window.appName === undefined ? {} : { appName: window.appName }),
      ...(window.title === undefined ? {} : { title: window.title }),
    }));
    current.newHandoffCandidates = candidates;
    current.newlySurfacedWindowKeys = new Set(candidates.map(windowIdentityKey));
    current.proactiveHandoffCandidatesReady = candidates.length > 0;
    return candidates;
  }

  public async handoffWindow(session: ComputerSessionDescriptor, candidate: ComputerWindowCandidate, signal: AbortSignal): Promise<ComputerSessionDescriptor> {
    const current = this.requireSession(session);
    const binding = activeWindowBinding(current);
    if (binding === undefined || !this.canUseManualWindowHandoff(current)) {
      throw new Error("window handoff is available only for an explicitly bound native window");
    }
    validateWindowTarget(candidate);
    if (binding.target.pid === candidate.pid && binding.target.windowId === candidate.windowId) {
      throw new Error("window handoff target must differ from the current window");
    }
    return this.transitionWindow(current, candidate, signal, {
      onScreenOnly: true,
      staleCode: "WINDOW_HANDOFF_STALE",
      staleMessage: "window handoff candidate changed before confirmation",
      ...(this.options.windowSwitchAllowedTargets === undefined
        ? {}
        : { authorizedTargets: this.options.windowSwitchAllowedTargets }),
      ...(candidate.appName === undefined ? {} : { expectedAppName: candidate.appName }),
      ...(candidate.title === undefined ? {} : { expectedTitle: candidate.title }),
    });
  }

  /**
   * The shared native target transition for host-confirmed handoff and the
   * opted-in model switch action. It validates identity, activates at most
   * once for foreground delivery, and only commits a fresh exact capture.
   */
  private async transitionWindow(
    current: PrivateSession,
    target: CuaWindowTarget,
    signal: AbortSignal,
    options: {
      readonly onScreenOnly: boolean;
      readonly staleCode: string;
      readonly staleMessage?: string;
      readonly expectedAppName?: string;
      readonly expectedTitle?: string;
      readonly authorizedTargets?: readonly CuaWindowTarget[];
      readonly selectedSurfaceRef?: SurfaceRef;
    },
  ): Promise<ComputerSessionDescriptor> {
    validateWindowTarget(target);
    if (!targetAllowedByHostScope(target, options.authorizedTargets)) {
      throw new WindowContractError("WINDOW_SWITCH_UNAUTHORIZED", "selected window is outside the host-authorized window scope");
    }
    const activeRefBefore = current.surfaceRegistry.activeSurface;
    const activeBefore = activeSurface(current);
    if (activeBefore?.parentSurfaceId !== undefined &&
        (activeBefore.kind === "overlay" || activeBefore.kind === "native_window")) {
      throw new WindowContractError("TRANSIENT_SURFACE_MODAL", "close and pop the active modal child Surface before switching peers");
    }
    const activeBindingBefore = activeWindowBinding(current);
    const selectedIsCurrent = activePeerTarget(current) !== undefined &&
      windowIdentityKey(activePeerTarget(current)!) === windowIdentityKey(target);
    signal.throwIfAborted();
    const windows = await listWindowTargets(current.driver, current.label, signal, undefined, options.onScreenOnly, this.options.windowRelationshipProbe);
    const fresh = windows.find((window) => windowIdentityKey(window.target) === windowIdentityKey(target));
    if (fresh === undefined && selectedIsCurrent) {
      if (activeRefBefore !== undefined) {
        const invalidated = markSurfaceUnknown(current.surfaceRegistry, activeRefBefore);
        if (invalidated.decision === "applied") current.surfaceRegistry = invalidated.state;
      }
      delete current.browserTarget;
      current.windowRefs.clear();
      this.clearTargetObservationState(current, activeRefBefore, options.selectedSurfaceRef);
      throw new WindowContractError("WINDOW_TARGET_NOT_FOUND", "current bound window is missing from the opened-window inventory");
    }
    if (fresh === undefined || options.expectedAppName !== undefined && options.expectedAppName !== fresh.appName ||
        options.expectedTitle !== undefined && options.expectedTitle !== fresh.title) {
      throw new WindowContractError(options.staleCode, options.staleMessage ?? "selected window identity changed before target transition");
    }
    if (selectedIsCurrent) {
      throw new WindowContractError("WINDOW_ALREADY_CURRENT", "selected window is already the current target");
    }
    current.windowRefs.clear();

    let targetSurfaceRef = options.selectedSurfaceRef;
    if (targetSurfaceRef === undefined) {
      const registered = registerNativePeer(current.surfaceRegistry, asNativeWindowIdentity(target));
      if (registered.decision !== "applied") {
        throw new WindowContractError(options.staleCode, registered.reason);
      }
      current.surfaceRegistry = registered.state;
      targetSurfaceRef = registered.value;
    }
    if (!isCurrentSurfaceRef(current.surfaceRegistry, targetSurfaceRef)) {
      throw new WindowContractError(options.staleCode, options.staleMessage ?? "selected Surface generation changed before target transition");
    }

    let activationAttempted = false;
    if (this.options.windowDeliveryMode === "foreground") {
      signal.throwIfAborted();
      activationAttempted = true;
      try {
        await bringWindowToFrontOnce(current.driver, current.label, target, signal);
      } catch (error) {
        this.invalidateUnknownTargetTransition(current, activeRefBefore, targetSurfaceRef);
        throw error;
      }
    }

    let capture: Awaited<ReturnType<typeof captureWindowWithRetry>>;
    try {
      capture = await captureWindowWithRetry(current.driver, current.label, target, signal, this.options.windowCaptureRetry);
      signal.throwIfAborted();
    } catch (error) {
      if (activationAttempted) {
        this.invalidateUnknownTargetTransition(current, activeRefBefore, targetSurfaceRef);
      }
      throw error;
    }

    // Activation may change foreground focus, but sends no application content
    // input. Commit only after a fresh exact capture, with the new viewport and
    // no references from the old UI.
    const advanced = advanceSurfaceGeneration(current.surfaceRegistry, targetSurfaceRef);
    if (advanced.decision !== "applied") throw new WindowContractError(options.staleCode, advanced.reason);
    const activated = activatePeer(advanced.state, advanced.value, {
      nativeWindow: asNativeWindowIdentity(capture.binding.target),
      identityVerified: true,
      captureVerified: true,
    });
    if (activated.decision !== "applied") throw new WindowContractError(options.staleCode, activated.reason);
    current.surfaceRegistry = activated.state;
    noteSurfaceTransition(current, "peer_switch");
    current.windowBindings.set(windowIdentityKey(capture.binding.target), capture.binding);
    if (managedBrowserTargetForBinding(current, capture.binding) && current.managedBrowserTarget !== undefined) {
      current.browserTarget = current.managedBrowserTarget;
    } else {
      delete current.browserTarget;
    }
    current.descriptor = {
      ...current.descriptor,
      viewport: capture.viewport,
      capabilities: {
        ...current.descriptor.capabilities,
        keyboard: this.options.windowDeliveryMode === "foreground",
        accessibility: this.options.grounding === "uia-catalog-v1" || this.options.grounding === "hybrid-catalog-v1",
      },
    };
    current.windowRefs.clear();
    this.clearTargetObservationState(current, activeRefBefore, targetSurfaceRef);
    return current.descriptor;
  }

  private invalidateUnknownTargetTransition(
    current: PrivateSession,
    previous: SurfaceRef | undefined,
    target: SurfaceRef,
  ): void {
    if (previous !== undefined && isCurrentSurfaceRef(current.surfaceRegistry, previous)) {
      const invalidated = markSurfaceUnknown(current.surfaceRegistry, previous);
      if (invalidated.decision === "applied") current.surfaceRegistry = invalidated.state;
    }
    if (isCurrentSurfaceRef(current.surfaceRegistry, target)) {
      const invalidated = markSurfaceUnknown(current.surfaceRegistry, target);
      if (invalidated.decision === "applied") current.surfaceRegistry = invalidated.state;
    }
    current.windowRefs.clear();
    delete current.browserTarget;
    this.clearTargetObservationState(current, previous, target);
  }

  private clearTargetObservationState(current: PrivateSession, ...surfaces: Array<SurfaceRef | undefined>): void {
    const surfaceIds = new Set<SurfaceRef["surfaceId"]>();
    for (const surface of surfaces) {
      if (surface === undefined) continue;
      for (const surfaceId of surfaceSubtreeIds(current.surfaceRegistry, surface.surfaceId)) surfaceIds.add(surfaceId);
    }
    for (const [key, observation] of this.observations) {
      if (surfaceIds.has(observation.surfaceRef.surfaceId)) {
        this.observations.delete(key);
        this.groundings.delete(key);
      }
    }
    this.latestObservationId = undefined;
    current.visibleWindowBaseline = undefined;
    current.preActionWindowBaseline = undefined;
    current.newlySurfacedWindowKeys = new Set();
    current.newHandoffCandidates = [];
    current.foregroundMismatchWindowId = undefined;
    current.proactiveHandoffCandidatesReady = false;
  }

  private clearSurfaceLineageObservationState(current: PrivateSession, surface: SurfaceRef): void {
    let record = current.surfaceRegistry.surfaces.get(surface.surfaceId);
    if (record === undefined) {
      this.clearTargetObservationState(current, surface);
      return;
    }
    while (record.parentSurfaceId !== undefined) {
      const parent = current.surfaceRegistry.surfaces.get(record.parentSurfaceId);
      if (parent === undefined) break;
      record = parent;
    }
    this.clearTargetObservationState(current, currentSurfaceRef(current.surfaceRegistry, record.surfaceId) ?? surface);
  }

  private canUseManualWindowHandoff(current: PrivateSession): boolean {
    const binding = activeWindowBinding(current);
    const surface = activeSurface(current);
    if (binding === undefined || surface?.kind !== "native_window" || surface.parentSurfaceId !== undefined ||
        managedBrowserTargetForBinding(current, binding)) return false;
    // Preserve the old managed-browser refusal by default. An explicitly
    // opted-in Run may use the existing confirmed manual flow while a native
    // window is current; the Run-owned browser target itself remains excluded.
    return this.options.browserTarget === undefined || this.options.windowSwitch === "opened-windows-v1";
  }

  private async executeWindowSwitch(
    current: PrivateSession,
    action: SwitchWindowAction,
    signal: AbortSignal,
  ): Promise<ActionReceipt> {
    if (this.options.windowSwitch !== "opened-windows-v1") {
      return refused(action.actionId, "WINDOW_SWITCH_DISABLED", "cross-window switching is not enabled for this Run");
    }
    if (activeSurfaceUnavailable(current)) {
      return refused(action.actionId, "WINDOW_TARGET_INVALIDATED", "window target identity was invalidated; close and open a new session");
    }
    const selectedRef = current.windowRefs.get(action.windowRef);
    const selectedSurface = selectedRef === undefined ? undefined : current.surfaceRegistry.surfaces.get(selectedRef.surfaceId);
    if (selectedRef === undefined || selectedSurface?.kind !== "native_window" || selectedSurface.parentSurfaceId !== undefined ||
        !isCurrentSurfaceRef(current.surfaceRegistry, selectedRef)) {
      return refused(action.actionId, "WINDOW_REF_STALE", "windowRef was not issued by the current window inventory; list windows again");
    }
    const selectedTarget = asCuaWindowTarget(selectedSurface.nativeWindow);
    // A switch consumes the entire prior inventory. A subsequent choice must
    // come from a fresh list, even if the selected target proves stale.
    current.windowRefs.clear();
    try {
      const sessionAfter = await this.transitionWindow(current, selectedTarget, signal, {
        onScreenOnly: false,
        staleCode: "WINDOW_SWITCH_STALE",
        selectedSurfaceRef: selectedRef,
        ...(this.options.windowSwitchAllowedTargets === undefined
          ? {}
          : { authorizedTargets: this.options.windowSwitchAllowedTargets }),
      });
      return { actionId: action.actionId, status: "completed", sessionAfter };
    } catch (error) {
      if (error instanceof WindowContractError) {
        if (activeSurfaceUnavailable(current)) {
          return { actionId: action.actionId, status: "failed", driverCode: error.code, message: error.message };
        }
        return refused(action.actionId, error.code, error.message);
      }
      const details = driverErrorDetails(error);
      if (details.tag === "Transport") current.active = false;
      throw normalizeDriverError(error, "execute");
    }
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
    if (activeSurfaceUnavailable(current)) {
      return refused(action.actionId, "WINDOW_TARGET_INVALIDATED", "window target identity was invalidated; close and open a new session");
    }
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
      const activeRef = current.surfaceRegistry.activeSurface;
      if (activeRef === undefined || decisionObservation.surfaceRef.surfaceId !== activeRef.surfaceId ||
          decisionObservation.surfaceRef.generation !== activeRef.generation ||
          decisionObservation.surfaceRef.parentSurfaceId !== activeRef.parentSurfaceId ||
          decisionObservation.surfaceRef.admissionSource !== activeRef.admissionSource ||
          !isExecutableSurfaceRef(current.surfaceRegistry, decisionObservation.surfaceRef)) {
        return refused(action.actionId, "SURFACE_REF_STALE", "action Observation is not bound to the current active Surface generation");
      }
    }
    if (action.kind === "wait") {
      await waitWithAbort(action.durationMs, signal);
      return { actionId: action.actionId, status: "completed" };
    }
    if (action.kind === "switch_window") {
      return this.executeWindowSwitch(current, action, signal);
    }
    try {
      await this.reconcileActiveTransientChild(current, signal);
    } catch (error) {
      if (error instanceof WindowContractError) {
        return refused(action.actionId, error.code, error.message);
      }
      throw error;
    }
    const activeRefAfterReconcile = current.surfaceRegistry.activeSurface;
    if (decisionObservation?.surfaceRef === undefined || activeRefAfterReconcile === undefined ||
        decisionObservation.surfaceRef.surfaceId !== activeRefAfterReconcile.surfaceId ||
        decisionObservation.surfaceRef.generation !== activeRefAfterReconcile.generation ||
        decisionObservation.surfaceRef.parentSurfaceId !== activeRefAfterReconcile.parentSurfaceId ||
        decisionObservation.surfaceRef.admissionSource !== activeRefAfterReconcile.admissionSource) {
      const code = decisionObservation !== undefined && wasTransientSurface(current, decisionObservation.surfaceRef)
        ? "TRANSIENT_SURFACE_STALE"
        : "SURFACE_REF_STALE";
      return refused(action.actionId, code, "the active Surface changed after the action Observation; observe again");
    }
    let actionWindowBinding = activeWindowBinding(current);
    if (actionWindowBinding !== undefined) {
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
        const liveBinding = await discoverWindow(current.driver, current.label, actionWindowBinding.target, signal);
        if (!sameWindowGeometry(liveBinding.bounds, decisionObservation!.geometry!)) {
          const geometrySurface = surfaceRefForWindow(current, liveBinding.target);
          if (geometrySurface !== undefined) {
          const advanced = advanceSurfaceGeneration(current.surfaceRegistry, geometrySurface);
          if (advanced.decision === "applied") {
              current.surfaceRegistry = advanced.state;
              noteSurfaceTransition(current, "generation_advanced");
              this.clearTargetObservationState(current, geometrySurface);
            } else {
              this.clearTargetObservationState(current, decisionObservation!.surfaceRef);
            }
          } else {
            this.clearTargetObservationState(current, decisionObservation!.surfaceRef);
          }
          current.windowBindings.set(windowIdentityKey(liveBinding.target), liveBinding);
          return refused(action.actionId, "WINDOW_GEOMETRY_CHANGED", "window geometry changed since the action observation");
        }
        current.windowBindings.set(windowIdentityKey(liveBinding.target), liveBinding);
        actionWindowBinding = liveBinding;
      } catch (error) {
        const details = driverErrorDetails(error);
        if (details.tag === "Transport") current.active = false;
        if (error instanceof WindowContractError) {
          if (error.code === "WINDOW_TARGET_NOT_FOUND") {
            const activeRef = current.surfaceRegistry.activeSurface;
            if (activeRef !== undefined) {
              const invalidated = markSurfaceUnknown(current.surfaceRegistry, activeRef);
              if (invalidated.decision === "applied") current.surfaceRegistry = invalidated.state;
            }
            current.windowRefs.clear();
            this.clearTargetObservationState(current, decisionObservation?.surfaceRef);
          }
          return refused(action.actionId, error.code, error.message);
        }
        return refused(action.actionId, "WINDOW_TARGET_UNKNOWN", "window target could not be verified before action");
      }
    }
    const isMultilineType = action.kind === "type" && hasLineBreak(action.text);
    if (action.kind === "select_option") {
    const privateGrounding = this.groundings.get(String(action.basedOn));
    const resolved = privateGrounding?.elements.get(action.groundingRef);
      if (privateGrounding === undefined || resolved === undefined ||
          privateGrounding.surfaceRef?.surfaceId !== decisionObservation?.surfaceRef.surfaceId ||
          privateGrounding.surfaceRef?.generation !== decisionObservation?.surfaceRef.generation ||
          privateGrounding.surfaceRef?.parentSurfaceId !== decisionObservation?.surfaceRef.parentSurfaceId ||
          privateGrounding.surfaceRef?.admissionSource !== decisionObservation?.surfaceRef.admissionSource) {
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
      if (resolved.element.optionsTruncated === true) {
        return refused(action.actionId, "SELECT_OPTION_OPTIONS_TRUNCATED", "current native select options list is incomplete");
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
    let requestAction = action;
    if (action.groundingRef !== undefined && !(action.kind === "type" && hasLineBreak(action.text))) {
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
    let request: { name: string; arguments: Record<string, unknown> } | undefined;
    try {
      if (!isMultilineType) {
        request = actionRequest(
          requestAction,
          current.label,
          actionWindowBinding,
          this.options.windowDeliveryMode,
          decisionObservation?.viewport,
        );
      }
    } catch (error) {
      if (error instanceof WindowCoordinateMappingError) {
        return refused(action.actionId, error.code, error.message);
      }
      throw error;
    }
    const currentWindowBinding = activeWindowBinding(current);
    if (options?.detectNewWindowHandoff === true && currentWindowBinding !== undefined && this.options.windowDeliveryMode === "foreground") {
      const parentSurfaceRef = current.surfaceRegistry.activeSurface;
      if (parentSurfaceRef === undefined || !isCurrentSurfaceRef(current.surfaceRegistry, parentSurfaceRef) ||
          !isExecutableSurfaceRef(current.surfaceRegistry, parentSurfaceRef)) {
        return refused(action.actionId, "SURFACE_REF_STALE", "pre-action window inventory has no current executable parent Surface; no input was sent");
      }
      try {
        const visibleInventory = await listWindowInventory(current.driver, current.label, signal, undefined, true, this.options.windowRelationshipProbe);
        signal.throwIfAborted();
        const visibleKeys = new Set(visibleInventory.windows.map((window) => windowIdentityKey(window.target)));
        if (!visibleKeys.has(windowIdentityKey(currentWindowBinding.target))) {
          return refused(action.actionId, "WINDOW_INVENTORY_UNKNOWN", "bound target was missing from visible-window inventory; no input was sent");
        }
        current.preActionWindowBaseline = {
          targetKeys: visibleKeys,
          complete: visibleInventory.complete,
          truncated: visibleInventory.truncated === true,
          parentSurfaceRef: { ...parentSurfaceRef },
          parentBinding: { target: { ...currentWindowBinding.target }, bounds: { ...currentWindowBinding.bounds } },
        };
        current.visibleWindowBaseline = visibleKeys;
        current.newlySurfacedWindowKeys = new Set();
        current.newHandoffCandidates = [];
      } catch (error) {
        signal.throwIfAborted();
        return refused(action.actionId, "WINDOW_INVENTORY_UNKNOWN", "visible-window inventory failed before action; no input was sent");
      }
    }
    if (action.kind === "type" && hasLineBreak(action.text)) {
      // Multiline uses the same fresh pre-action inventory baseline as every
      // opted-in foreground action. Its completed receipt returns through the
      // normal Runtime post-action handoff diff before the next observation.
      return this.executeMultilineType(current, session, action, decisionObservation, actionWindowBinding, signal);
    }
    if (request === undefined) throw new Error("CUA action request was not constructed");
    try {
      const result = await callTool(current.driver, request.name, request.arguments, signal);
      if (result.isError) {
        const driverCode = windowRefusalCode(result.errorCode, result.text);
        if (decisionObservation !== undefined && isTransientSurface(current, decisionObservation.surfaceRef) &&
            driverCode === "CUA_TOOL_REFUSED" && isAmbiguousForegroundResult(result.text)) {
          this.clearTargetObservationState(current, decisionObservation.surfaceRef);
          throw new Error("CUA changed foreground while dispatching the action and did not confirm that input was withheld; action outcome is unknown");
        }
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
        if (decisionObservation !== undefined && isTransientSurface(current, decisionObservation.surfaceRef) &&
            driverCode === "CUA_TOOL_REFUSED" && isAmbiguousForegroundResult(details.message)) {
          this.clearTargetObservationState(current, decisionObservation.surfaceRef);
          throw normalizeDriverError(new Error("CUA changed foreground while dispatching the action and did not confirm that input was withheld; action outcome is unknown"), "execute");
        }
        if (driverCode === "WINDOW_FOREGROUND_MISMATCH") {
          current.foregroundMismatchWindowId = parseActualForegroundWindowId(details.message);
        }
        return refused(action.actionId, driverCode, details.message);
      }
      throw normalizeDriverError(error, "execute");
    }
  }

  private async executeMultilineType(
    current: PrivateSession,
    session: ComputerSessionDescriptor,
    action: Extract<ActionIntent, { kind: "type" }>,
    decisionObservation: PrivateObservation | undefined,
    actionWindowBinding: CuaWindowBinding | undefined,
    signal: AbortSignal,
  ): Promise<ActionReceipt> {
    if (current.platform !== "win32") {
      return refused(action.actionId, "MULTILINE_PLATFORM_UNSUPPORTED", "multiline UIA input is enabled only for the verified Windows CUA driver route");
    }
    if (action.basedOn !== this.latestObservationId) {
      this.clearTargetObservationState(current, decisionObservation?.surfaceRef);
      return refused(action.actionId, "MULTILINE_OBSERVATION_STALE", "multiline input requires the latest observation; observe again before typing");
    }
    const grounding = this.groundings.get(String(action.basedOn));
    if (grounding === undefined || String(grounding.catalog.observationId) !== String(action.basedOn) ||
        String(grounding.catalog.computerSessionId) !== String(session.id) ||
        decisionObservation?.surfaceRef.surfaceId !== grounding.surfaceRef?.surfaceId ||
        decisionObservation?.surfaceRef.generation !== grounding.surfaceRef?.generation ||
        decisionObservation?.surfaceRef.parentSurfaceId !== grounding.surfaceRef?.parentSurfaceId ||
        decisionObservation?.surfaceRef.admissionSource !== grounding.surfaceRef?.admissionSource ||
        grounding.surfaceRef === undefined || !isExecutableSurfaceRef(current.surfaceRegistry, grounding.surfaceRef)) {
      return refused(action.actionId, "MULTILINE_GROUNDING_UNAVAILABLE", "multiline input requires UIA data from this exact observation and Computer session");
    }
    if (grounding.catalog.source !== "uia" && grounding.catalog.source !== "hybrid") {
      return refused(action.actionId, "MULTILINE_UIA_REQUIRED", "multiline input requires a current UIA grounding catalog");
    }
    const explicitTarget = action.groundingRef !== undefined;
    if (grounding.catalog.degraded || grounding.windowBinding === undefined ||
        String(current.descriptor.id) !== String(session.id) ||
        actionWindowBinding === undefined ||
        windowIdentityKey(grounding.windowBinding.target) !== windowIdentityKey(actionWindowBinding.target) ||
        decisionObservation?.geometry === undefined ||
        !sameWindowGeometry(grounding.windowBinding.bounds, decisionObservation.geometry)) {
      return refused(action.actionId, "MULTILINE_GROUNDING_STALE", "multiline input requires current session, window surface, and geometry evidence");
    }
    if (!explicitTarget && grounding.catalog.completeness !== "complete") {
      return refused(action.actionId, "MULTILINE_GROUNDING_INCOMPLETE", "automatic multiline targeting requires a complete UIA catalog; select a current text element explicitly");
    }

    let resolved: PrivateGroundingElement | undefined;
    if (action.groundingRef !== undefined) {
      resolved = grounding.elements.get(action.groundingRef);
      if (resolved === undefined) {
        return refused(action.actionId, "MULTILINE_GROUNDING_REF_STALE", "elementRef is not present in the exact current observation; observe again");
      }
    } else {
      if (grounding.catalog.completeness !== "complete") {
        return refused(action.actionId, "MULTILINE_GROUNDING_INCOMPLETE", "automatic multiline targeting requires a complete UIA catalog; provide a current elementRef or choose a target explicitly");
      }
      const candidates = [...grounding.elements.values()].filter((candidate) => candidate.element.source === "uia" &&
        isTextEditingRole(candidate.element.role) && candidate.element.state?.enabled !== false && candidate.element.state?.editable !== false);
      if (candidates.length !== 1) {
        return refused(action.actionId, candidates.length === 0 ? "MULTILINE_TARGET_NOT_FOUND" : "MULTILINE_TARGET_AMBIGUOUS",
          candidates.length === 0
            ? "no supported UIA text-editing surface is available in the current observation"
            : "more than one UIA text-editing surface is available; select one from the current observation");
      }
      resolved = candidates[0];
    }
    if (resolved === undefined) {
      return refused(action.actionId, "MULTILINE_TARGET_NOT_FOUND", "no unique UIA text target was resolved; no text was sent");
    }

    if (resolved.element.source !== "uia" || !isTextEditingRole(resolved.element.role)) {
      return refused(action.actionId, "MULTILINE_TARGET_ROLE_UNSUPPORTED", "multiline input supports only UIA Document/Edit/TextBox surfaces");
    }
    if (resolved.element.state?.enabled === false || resolved.element.state?.editable === false) {
      return refused(action.actionId, "MULTILINE_TARGET_UNAVAILABLE", "the UIA text target is explicitly disabled or not editable");
    }
    const target = resolved.uiaTarget;
    const targetFingerprint = resolved.uiaIdentityFingerprint;
    if (resolved.preValueEmpty !== true) {
      return refused(action.actionId, "MULTILINE_TYPE_INSERTION_UNSUPPORTED", "multiline UIA typing only replaces a currently empty or value-unavailable text surface; non-empty targets are refused");
    }
    if (target === undefined || target.snapshotId === undefined || targetFingerprint === undefined) {
      return refused(action.actionId, "MULTILINE_TARGET_IDENTITY_UNAVAILABLE", "the current UIA element is missing a private target identity or fresh driver token; no text was sent");
    }
    const fingerprintMatches = [...grounding.elements.values()].filter((candidate) =>
      candidate.element.source === "uia" && candidate.uiaIdentityFingerprint === targetFingerprint);
    if (fingerprintMatches.length !== 1) {
      return refused(action.actionId, "MULTILINE_TARGET_AMBIGUOUS", "the selected UIA text surface is not unique in the current observation; no text was sent");
    }
    if (actionWindowBinding === undefined || decisionObservation?.geometry === undefined || resolved.geometry === undefined ||
        !sameWindowGeometry(resolved.geometry, decisionObservation.geometry) ||
        !sameWindowGeometry(grounding.windowBinding!.bounds, decisionObservation.geometry) ||
        actionWindowBinding.target.pid !== target.pid || actionWindowBinding.target.windowId !== target.windowId ||
        grounding.windowBinding!.target.pid !== target.pid || grounding.windowBinding!.target.windowId !== target.windowId) {
      this.clearTargetObservationState(current, decisionObservation?.surfaceRef);
      return refused(action.actionId, "MULTILINE_TARGET_STALE", "the UIA text target no longer matches the observed window geometry or identity; observe again");
    }
    if (/[\u0085\u2028\u2029]/u.test(action.text)) {
      return refused(action.actionId, "MULTILINE_SEPARATOR_UNSUPPORTED", "multiline UIA input supports CR/LF line endings only; no text was sent");
    }

    signal.throwIfAborted();
    try {
      const driverText = normalizeLogicalLineEndings(action.text).replace(/\n/gu, "\r");
      const result = await callTool(current.driver, "type_text", {
        session: current.label,
        pid: target.pid,
        window_id: target.windowId,
        element_token: target.elementToken,
        snapshot_id: target.snapshotId,
        text: driverText,
        delivery_mode: "background",
      }, signal);
      if (isExplicitDriverRefusal(result.structuredJson) || resultProvesNoInput(result)) {
        return refused(action.actionId, "MULTILINE_TYPE_REFUSED", "CUA explicitly refused multiline UIA input; no text was sent");
      }
      this.invalidateObservationAfterAction(current);
      if (!result.isError && !result.degraded && confirmsCuaValueWrite(result.structuredJson)) {
        return { actionId: action.actionId, status: "completed", message: "CUA confirmed the multiline UIA value by same-target read-back." };
      }
      return {
        actionId: action.actionId,
        status: "partial",
        driverCode: "MULTILINE_TYPE_UNCONFIRMED",
        message: "CUA did not confirm multiline input with a value read-back. Text may have changed; inspect the current screen before continuing, and do not resend automatically.",
      };
    } catch (error) {
      const details = driverErrorDetails(error);
      if (details.tag === "Transport") current.active = false;
      this.invalidateObservationAfterAction(current);
      return {
        actionId: action.actionId,
        status: "partial",
        driverCode: "MULTILINE_TYPE_UNCONFIRMED",
        message: "CUA returned an unknown multiline input outcome. Text may have changed; inspect the current screen before continuing, and do not resend automatically.",
      };
    }
  }

  /** Invalidate pre-action references without discarding the handoff baseline
   * or source observation id that Runtime consumes immediately after receipt. */
  private invalidateObservationAfterAction(current: PrivateSession): void {
    this.observations.clear();
    this.groundings.clear();
  }

  public async close(session: ComputerSessionDescriptor): Promise<void> {
    const current = this.session;
    if (current === undefined || String(current.descriptor.id) !== String(session.id)) {
      throw new Error(`unknown CUA computer session ${String(session.id)}`);
    }
    this.observations.forEach((_value, key) => {
      if (_value.sessionId === String(session.id)) this.observations.delete(key);
    });
    current.windowRefs.clear();
    this.groundings.clear();
    this.latestObservationId = undefined;
    current.windowBindings.clear();
    current.surfaceRegistry = closeSurfaceRegistry(current.surfaceRegistry);
    delete current.pendingSurfaceTransitionReason;
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

  /** Retry bounded cleanup retained after a failed open/close; no GUI action is sent. */
  public async dispose(): Promise<void> {
    if (this.session !== undefined) {
      await this.close(this.session.descriptor);
    }
    const pending = this.pendingCleanup;
    if (pending === undefined) return;
    const completed = await bestEffortCloseDriver(pending.driver, pending.label, this.options.cleanupWaitMs, true);
    if (!completed) throw new Error(`CUA cleanup for session ${pending.label} is still pending`);
    if (this.pendingCleanup === pending) this.pendingCleanup = undefined;
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
  action: Exclude<ActionIntent, { kind: "wait" } | SwitchWindowAction>,
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
): Promise<PrivateGrounding | undefined> {
  if (mode === undefined || mode === "off") return undefined;
  if (mode === "uia-catalog-v1") return readGroundingCatalog(driver, session, binding, viewport, observationId, computerSessionId, signal, false);
  if (mode === "dom-catalog-v1") {
    if (browserTarget === undefined || domTransport === undefined) return undefined;
    // DOM-only has no trusted producer for the browser content origin. Keep
    // its capability explicitly fail-closed until a browser-native content
    // rect producer is available; never guess from window bounds/DPI.
    return emptyDomGrounding(observationId, computerSessionId);
  }
  const uia = await readGroundingCatalog(
    driver,
    session,
    binding,
    viewport,
    observationId,
    computerSessionId,
    signal,
    browserTarget !== undefined,
  );
  if (browserTarget === undefined || domTransport === undefined) return uia;
  // Hybrid DOM candidates require a trusted content rect from this same
  // managed-browser observation; never guess from window bounds or DPI.
  const dom = await readDomGroundingCatalog(domTransport, browserTarget, binding, viewport, observationId, computerSessionId, uia.contentRect, signal);
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
    const elements = new Map<string, PrivateGroundingElement>();
    for (const [elementRef, privateElement] of materialized.privateElements) {
      elements.set(elementRef, {
        element: privateElement.element,
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

function isTextEditingRole(role: string): boolean {
  return ["document", "edit", "textbox", "textarea", "textedit", "texteditor"].includes(
    role.normalize("NFKC").toLocaleLowerCase().replace(/[\s_-]+/gu, "").trim(),
  );
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
  const snapshotId = safeCuaSnapshotId(structured?.snapshot_id ?? structured?.snapshotId);
  const parsed = rawElements.flatMap((value, index) => parseGroundingCandidate(value, index, binding, viewport, snapshotId));
  parsed.sort((left, right) => left.priority - right.priority || left.sortKey.localeCompare(right.sortKey));
  const selected = parsed.slice(0, GROUNDING_MAX_ELEMENTS);
  const selectedRecords = selected.map((candidate) => ({
    element: candidate.element,
    point: candidate.point,
    preValueEmpty: candidate.preValueEmpty,
    ...(candidate.uiaIdentityFingerprint === undefined ? {} : { uiaIdentityFingerprint: candidate.uiaIdentityFingerprint }),
    ...(candidate.elementToken === undefined ? {} : { elementToken: candidate.elementToken }),
    ...(candidate.snapshotId === undefined ? {} : { snapshotId: candidate.snapshotId }),
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
  const elements = new Map<string, PrivateGroundingElement>();
  const publicElements = annotatedRecords.map((candidate, index) => {
    const elementRef = `uia-${groundingObservationDiscriminator(observationId)}-${index + 1}`;
    const element: GroundingElement = { ...candidate.element, elementRef };
    elements.set(elementRef, {
      element,
      point: candidate.point,
      geometry: binding.bounds,
      preValueEmpty: candidate.preValueEmpty,
      ...(candidate.uiaIdentityFingerprint === undefined ? {} : { uiaIdentityFingerprint: candidate.uiaIdentityFingerprint }),
      ...(candidate.elementToken === undefined ? {} : {
        uiaTarget: {
          pid: binding.target.pid,
          windowId: binding.target.windowId,
          elementToken: candidate.elementToken,
          ...(candidate.snapshotId === undefined ? {} : { snapshotId: candidate.snapshotId }),
        },
      }),
    });
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
    .filter((element) => element.role.toLocaleLowerCase() === "document" && element.bbox?.coordinateSpace === "physical")
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
  readonly preValueEmpty: boolean;
  readonly uiaIdentityFingerprint?: string;
  readonly elementToken?: string;
  readonly snapshotId?: string;
}

function parseGroundingCandidate(
  value: unknown,
  index: number,
  binding: CuaWindowBinding,
  viewport: Viewport,
  snapshotId?: string,
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
  const preValueEmpty = item.value === undefined || item.value === null || (typeof item.value === "string" && item.value.length === 0);
  const elementToken = boundedGroundingToken(item.element_token ?? item.elementToken);
  const itemSnapshotId = safeCuaSnapshotId(item.snapshot_id ?? item.snapshotId) ?? snapshotId;
  const element: Omit<GroundingElement, "elementRef"> = {
    role,
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    bbox: { ...clipped, coordinateSpace: "physical" },
    ...(state === undefined ? {} : { state }),
    source: "uia",
  };
  const uiaIdentityFingerprint = element.source === "uia"
    ? makeUiaTargetFingerprint(element, binding)
    : undefined;
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
  return [{
    element,
    point,
    priority,
    sortKey: `${role}\u0000${name ?? ""}\u0000${index.toString().padStart(8, "0")}`,
    preValueEmpty,
    ...(uiaIdentityFingerprint === undefined ? {} : { uiaIdentityFingerprint }),
    ...(elementToken === undefined ? {} : { elementToken }),
    ...(itemSnapshotId === undefined ? {} : { snapshotId: itemSnapshotId }),
  }];
}

/**
 * Build an adapter-private selector identity from UIA structure only. It is
 * used to reject duplicate pre-action selectors; snapshot tokens and editable
 * values are not part of this structural identity.
 */
function makeUiaTargetFingerprint(
  element: Omit<GroundingElement, "elementRef">,
  binding: CuaWindowBinding,
): string | undefined {
  if (element.source !== "uia" || element.bbox === undefined) return undefined;
  const stableLabel = (value: string | undefined): string =>
    value?.normalize("NFKC").replace(/\s+/gu, " ").trim() ?? "";
  const stableNumber = (value: number): string => Number.isFinite(value) ? value.toFixed(2) : "invalid";
  const bounds = binding.bounds;
  const bbox = element.bbox;
  return JSON.stringify({
    version: "uia-target-v1",
    pid: binding.target.pid,
    windowId: binding.target.windowId,
    window: [bounds.x, bounds.y, bounds.width, bounds.height].map(stableNumber),
    role: element.role.normalize("NFKC").toLocaleLowerCase().replace(/[\s_-]+/gu, "").trim(),
    name: stableLabel(element.name),
    description: stableLabel(element.description),
    bbox: [bbox.x, bbox.y, bbox.width, bbox.height].map(stableNumber),
  });
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

async function detectCuaPlatform(driver: CuaDriverLike, signal: AbortSignal): Promise<"win32" | "darwin" | "linux" | undefined> {
  try {
    const result = await callTool(driver, "health_report", {}, signal);
    if (result.isError || result.degraded) return undefined;
    const report = parseStructuredRecord(result.structuredJson);
    if (report?.schema_version !== "1" || report.driver_version !== "0.22.2") return undefined;
    return report.platform === "win32" || report.platform === "darwin" || report.platform === "linux"
      ? report.platform
      : undefined;
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted();
    return undefined;
  }
}

function safeCuaSnapshotId(value: unknown): string | undefined {
  return typeof value === "string" && /^s[0-9a-f]{8}$/u.test(value) ? value : undefined;
}

function boundedGroundingToken(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : undefined;
}

function isExplicitDriverRefusal(value: unknown): boolean {
  return parseStructuredRecord(value)?.effect === "refused";
}

function confirmsCuaValueWrite(value: unknown): boolean {
  const record = parseStructuredRecord(value);
  if (record?.effect !== "confirmed" || !Array.isArray(record.evidence)) return false;
  return record.evidence.some((item) => parseStructuredRecord(item)?.kind === "value_readback");
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
