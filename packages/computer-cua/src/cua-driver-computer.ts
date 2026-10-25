import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { BoundWindowMissingError, isGroundingWebUrl } from "@computer-harness/protocol";
import { dirname, join } from "node:path";
import { cuaSdkVersionForPlatform, loadCuaSdkModule, type CuaDriverLike } from "./cua-sdk-platform.js";
import type { ToolResult } from "./cua-sdk-contract.js";
import type {
  ActionIntent,
  ActionReceipt,
  AuthorizedSavedDocumentEvidence,
  ComputerSessionDescriptor,
  ComputerWindowCandidate,
  ComputerWindowOption,
  ComputerWindowList,
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
  type DomClickRequest,
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
  activateWindowTarget,
  hasConfirmedWindowsActivationRefusal,
  isLocalWindowsNamedPipeSocket,
  listWindowInventory,
  listWindowTargets,
  sameWindowGeometry,
  validateWindowTarget,
  type CuaWindowBinding,
  type CuaWindowCapture,
  type CuaWindowGeometry,
  type CuaWindowInventory,
  type CuaWindowInfo,
  type CuaWindowTarget,
  type WindowCaptureRetryOptions,
  WindowContractError,
} from "./window-contract.js";
import { captureVisibleWindowRegion } from "./windows-visible-window-capture.js";
import { assessOwnedTransientWindowAdmission } from "./transient-window-admission.js";
import { mergeWindowRelationshipInventory, type WindowRelationshipProbe } from "./window-relationship-probe.js";
import { settlePostInputObservation } from "./post-input-observation-settler.js";
import { projectExactWindowRoot as exactWindowRoot } from "./window-root-projection.js";
import {
  actionRequest,
  isBrowserShortcut,
  normalizeLogicalLineEndings,
  resolveMultilineTypeDispatch,
  WindowCoordinateMappingError,
  type CuaMultilineTypeProfile,
  type CuaWindowDeliveryMode,
} from "./cua-platform-input.js";
import {
  authorizedOutputParentIsPinned,
  fileIdentityPin,
  hasExplicitApplicationIdentityConflict,
  inspectAuthorizedOutputFileIdentity,
  parseDocumentIdentityProof,
  prepareReopenSavedDocumentGrant,
  sameApplicationIdentity,
  sameApplicationProcess,
  sameFileIdentity,
  samePostLaunchFileIdentity,
  type PrivateReopenSavedDocumentState,
  type ReopenSavedDocumentGrant,
  type VerifiedApplicationIdentity,
} from "./macos-saved-document.js";
import { verifyMacAttachedSheetEvidence, type MacAttachedSheetState } from "./macos-attached-sheet-evidence.js";
import {
  canVerifyExactTransientRoot,
  hasExactOwnedAuxiliaryStackEvidence,
  hasUniqueOwnedMenuStack,
  trustedWindowClassRootRole,
  win32OwnedChildEvidence,
  win32RelationshipChildEvidence,
  windowCandidateRelationship,
} from "./windows-transient-evidence.js";
import {
  isEligibleNativeOnlyDesktopCandidate,
  isRelevantManualWindowCandidate,
  projectSelectableWindowCandidates,
} from "./window-candidate-projection.js";

export { inspectAuthorizedOutputFileIdentity };
export type { CuaMultilineTypeProfile, CuaWindowDeliveryMode, ReopenSavedDocumentGrant };

const PRIMARY_DESKTOP = { kind: "desktop", display_id: "primary" } as const;
const TEXTEDIT_EXECUTABLE_URL = "file:///System/Applications/TextEdit.app/Contents/MacOS/TextEdit";
const CLEANUP_POLL_INTERVAL_MS = 50;
const TRANSIENT_RECOVERY_RECHECK_DELAYS_MS = [300, 300, 300] as const;
const unconfirmedNativeTransitionFailures = new WeakSet<object>();

function markUnconfirmedNativeTransitionFailure(error: unknown): void {
  if (typeof error === "object" && error !== null) unconfirmedNativeTransitionFailures.add(error);
}

function isUnconfirmedNativeTransitionFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && unconfirmedNativeTransitionFailures.has(error);
}

function windowIdentityKey(target: { readonly pid: number; readonly windowId: number }): string {
  return `${target.pid}:${target.windowId}`;
}

function actionPrimitiveFingerprint(action: ActionIntent): string {
  const primitive = { ...action } as Record<string, unknown>;
  delete primitive.actionId;
  delete primitive.basedOn;
  return createHash("sha256").update(stableActionValue(primitive)).digest("hex");
}

function stableActionValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableActionValue).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableActionValue(record[key])}`).join(",")}}`;
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

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value && typeof (value as NodeJS.ErrnoException).code === "string";
}

async function queryDocumentIdentity(
  driver: CuaDriverLike,
  session: string,
  target: CuaWindowTarget,
  bounds: CuaWindowGeometry,
  expectedExecutableUrl: string,
  signal: AbortSignal,
  expectedDocumentUrl?: string,
): Promise<{ readonly identity: VerifiedApplicationIdentity; readonly snapshotId: string; readonly cleanDocument: boolean } | undefined> {
  const result = await readDocumentIdentityResult(driver, session, target, signal, expectedDocumentUrl);
  return parseDocumentIdentityProof(result, target, bounds, expectedExecutableUrl, expectedDocumentUrl);
}

async function readDocumentIdentityResult(
  driver: CuaDriverLike,
  session: string,
  target: CuaWindowTarget,
  signal: AbortSignal,
  expectedDocumentUrl?: string,
) {
  const result = await callTool(driver, "get_window_state", {
    pid: target.pid,
    window_id: target.windowId,
    include_screenshot: false,
    max_depth: 0,
    max_elements: 0,
    document_identity_query: expectedDocumentUrl === undefined ? {} : { expected_document_url: expectedDocumentUrl },
    session,
  }, signal);
  return result;
}

type OverlayVerification =
  | { readonly status: "present"; readonly evidence: Extract<TransientChildEvidence, { readonly kind: "overlay" }> }
  | { readonly status: "absent" }
  | { readonly status: "unknown"; readonly reason: string; readonly candidateObserved: boolean };

type TransientRootVerification =
  | { readonly status: "verified"; readonly evidence: Extract<TransientChildEvidence, { readonly kind: "native_window" }> }
  | { readonly status: "unavailable"; readonly rootRole?: "menu" | "popup" | "dialog" | "window"; readonly queryFailed?: boolean }
  | { readonly status: "contradictory"; readonly reason: string };

async function readMacAttachedSheetState(
  driver: CuaDriverLike,
  session: string,
  parent: CuaWindowBinding,
  candidate: CuaWindowInfo | undefined,
  signal: AbortSignal,
  expectedAxParent?: CuaWindowTarget,
): Promise<MacAttachedSheetState> {
  const result = await callTool(driver, "get_window_state", {
    pid: parent.target.pid,
    window_id: parent.target.windowId,
    include_screenshot: false,
    max_depth: 8,
    max_elements: 64,
    session,
  }, signal);
  const state = parseStructuredRecord(result.structuredJson);
  return verifyMacAttachedSheetEvidence({
    result,
    parent,
    candidate,
    state,
    parentIdentityMismatch: state === undefined || hasExplicitIdentityMismatch(state, parent.target),
    ...(expectedAxParent === undefined ? {} : { expectedAxParent }),
  });
}
type UnknownTransientReplacementAttempt =
  | { readonly decision: "recovered"; readonly surfaceRef: SurfaceRef }
  | { readonly decision: "retry" }
  | { readonly decision: "stop" };

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
): Promise<TransientRootVerification> {
  if (windowIdentityKey(candidate.target) === windowIdentityKey(owner) ||
      candidate.isOnScreen !== true || candidate.minimized === true ||
      candidate.ownerPid !== owner.pid || candidate.ownerWindowId !== owner.windowId) {
    return { status: "unavailable" };
  }
  const admissionSource = inventory.source === "win32_relationship_probe"
    ? "win32_relationship_probe" as const
    : "owned_transient_window_root_proof" as const;
  const policyEvidence = (rootRole: "menu" | "popup" | "dialog"): "exact_foreground" | "unique_owned_stack" | undefined => {
    if (inventory.foregroundPid === candidate.target.pid && inventory.foregroundWindowId === candidate.target.windowId) {
      return "exact_foreground";
    }
    const uniqueOwnedStack = hasUniqueOwnedMenuStack(inventory, owner, candidate, baselineComplete);
    if (uniqueOwnedStack && (rootRole !== "dialog" || inventory.source === "win32_relationship_probe")) {
      return "unique_owned_stack";
    }
    return undefined;
  };

  const classRole = trustedWindowClassRootRole(candidate.windowClass);
  if (classRole !== undefined) {
    const frontmostEvidence = policyEvidence(classRole);
    if (frontmostEvidence === undefined) return { status: "unavailable", rootRole: classRole };
    return { status: "verified", evidence: {
      kind: "native_window",
      nativeWindow: asNativeWindowIdentity(candidate.target),
      owner: asNativeWindowIdentity(owner),
      rootRole: classRole,
      visible: true,
      rootSemanticsVerified: true,
      interactionPolicy: "modal",
      frontmostEvidence,
      admissionSource,
    } };
  }
  if (!allowExactStateProof) return { status: "unavailable" };

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
  if (stateResult.isError || stateResult.degraded) return { status: "unavailable", queryFailed: true };
  const state = parseStructuredRecord(stateResult.structuredJson);
  if (hasExplicitIdentityMismatch(state, candidate.target)) {
    return { status: "contradictory", reason: "exact child state reported a different PID/HWND" };
  }
  const root = exactWindowRoot(state, candidate.target);
  // Generic Window is common for native dialogs and modern menu bridges.
  // It adds no root-role proof, but does not contradict exact Win32 ownership.
  if (root === undefined) return { status: "unavailable" };
  if (root.role === "window") return { status: "unavailable", rootRole: root.role };
  const frontmostEvidence = policyEvidence(root.role);
  if (frontmostEvidence === undefined) return { status: "unavailable", rootRole: root.role };
  return { status: "verified", evidence: {
    kind: "native_window",
    nativeWindow: asNativeWindowIdentity(candidate.target),
    owner: asNativeWindowIdentity(owner),
    rootRole: root.role,
    visible: true,
    rootSemanticsVerified: true,
    interactionPolicy: "modal",
    frontmostEvidence,
    admissionSource,
  } };
}

function hasExplicitIdentityMismatch(state: Record<string, unknown> | undefined, target: CuaWindowTarget): boolean {
  if (state === undefined) return false;
  const pairs = [
    { keys: ["pid", "window_pid", "windowPid"], expected: target.pid },
    { keys: ["window_id", "windowId"], expected: target.windowId },
  ];
  for (const { keys, expected } of pairs) {
    for (const key of keys) {
      if (Object.hasOwn(state, key) && Number.isSafeInteger(state[key]) && state[key] !== expected) return true;
    }
  }
  for (const key of ["root_surface", "rootSurface"]) {
    const root = parseStructuredRecord(state[key]);
    if (root !== undefined && hasExplicitIdentityMismatch(root, target)) return true;
  }
  return false;
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

function isPrimaryDesktopForegroundActionRequest(
  request: { readonly name: string; readonly arguments: Record<string, unknown> },
  sessionLabel: string,
): boolean {
  const target = request.arguments.target;
  if (typeof target !== "object" || target === null || Array.isArray(target)) return false;
  const targetRecord = target as Record<string, unknown>;
  const targetKeys = Object.keys(targetRecord);
  return request.arguments.session === sessionLabel && request.arguments.delivery_mode === "foreground" &&
    targetRecord.kind === PRIMARY_DESKTOP.kind && targetRecord.display_id === PRIMARY_DESKTOP.display_id &&
    targetKeys.length === 2 && targetKeys.every((key) => key === "kind" || key === "display_id") &&
    ["click", "type_text", "press_key", "hotkey", "scroll", "drag"].includes(request.name);
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

function isFreshUnscopedOwnedForegroundPeer(
  candidate: CuaWindowInfo,
  owner: CuaWindowTarget,
  inventory: CuaWindowInventory,
  mismatchWindowId: number | undefined,
  foregroundDelivery: boolean,
): boolean {
  if (mismatchWindowId === undefined || candidate.target.windowId !== mismatchWindowId ||
      candidate.cuaListed === false || inventory.complete !== true || inventory.truncated === true ||
      inventory.completeAttestation === "negative" ||
      candidate.ownerPid !== owner.pid || candidate.ownerWindowId !== owner.windowId ||
      candidate.isOnScreen !== true || candidate.minimized === true ||
      foregroundDelivery && candidate.noActivate === true ||
      inventory.foregroundPid !== candidate.target.pid || inventory.foregroundWindowId !== candidate.target.windowId) {
    return false;
  }
  return inventory.windows.filter((window) => windowIdentityKey(window.target) === windowIdentityKey(candidate.target)).length === 1;
}

function samePinnedRecoveryIdentity(pinned: CuaWindowInfo, fresh: CuaWindowInfo): boolean {
  return windowIdentityKey(pinned.target) === windowIdentityKey(fresh.target) &&
    pinned.bounds.x === fresh.bounds.x && pinned.bounds.y === fresh.bounds.y &&
    pinned.bounds.width === fresh.bounds.width && pinned.bounds.height === fresh.bounds.height &&
    pinned.appName === fresh.appName && pinned.title === fresh.title &&
    pinned.ownerPid === fresh.ownerPid && pinned.ownerWindowId === fresh.ownerWindowId &&
    pinned.windowClass === fresh.windowClass;
}

const PINNED_TYPE_TEXT_NO_DISPATCH_MESSAGES = new Set([
  "type_text failed: exact foreground target is not currently focused; no text was dispatched",
  "type_text failed: exact foreground target changed during settle; no text was dispatched",
]);

const PINNED_TOOL_NO_DISPATCH_MESSAGES: Readonly<Record<string, ReadonlySet<string>>> = {
  type_text: PINNED_TYPE_TEXT_NO_DISPATCH_MESSAGES,
  hotkey: new Set([
    "hotkey failed: exact target window did not become focused for foreground HID delivery",
  ]),
  click: new Set([
    "click failed: exact foreground target is not focused and unobscured at the click point; no pointer or mouse event was dispatched",
  ]),
};

function hasPinnedToolNoDispatchMessage(toolName: string | undefined, message: string): boolean {
  return toolName !== undefined && (PINNED_TOOL_NO_DISPATCH_MESSAGES[toolName]?.has(message) ?? false);
}

function hasPinnedClickFocusMismatchDiagnostic(
  toolName: string | undefined,
  message: string,
  structuredJson: string | undefined,
  expectedTarget: CuaWindowTarget | undefined,
): boolean {
  if (toolName !== "click" ||
      !PINNED_TOOL_NO_DISPATCH_MESSAGES.click?.has(message) ||
      structuredJson === undefined || expectedTarget === undefined ||
      !Number.isSafeInteger(expectedTarget.pid) || expectedTarget.pid <= 0 ||
      !Number.isSafeInteger(expectedTarget.windowId) || expectedTarget.windowId <= 0) return false;
  const structured = parseStructuredRecord(structuredJson);
  const diagnostic = parseStructuredRecord(structured?.guard_diagnostic);
  if (diagnostic?.schema !== "foreground-pixel-guard-diagnostic-v1" &&
      diagnostic?.schema !== "foreground-pixel-guard-diagnostic-v2") return false;
  const target = parseStructuredRecord(diagnostic.target);
  const frontmost = parseStructuredRecord(diagnostic.frontmost_pid);
  const focused = parseStructuredRecord(diagnostic.focused_window_id);
  const pointHitTest = parseStructuredRecord(diagnostic.point_hit_test);
  if (target?.pid !== expectedTarget.pid || target.window_id !== expectedTarget.windowId ||
      frontmost?.status !== "available" || typeof frontmost.value !== "number" || !Number.isSafeInteger(frontmost.value) || frontmost.value <= 0 ||
      focused?.status !== "available" || typeof focused.value !== "number" || !Number.isSafeInteger(focused.value) || focused.value <= 0 ||
      pointHitTest?.status !== "not_evaluated") return false;
  return frontmost.value !== expectedTarget.pid || focused.value !== expectedTarget.windowId;
}

function windowRefusalCode(
  code: string | undefined,
  message: string,
  structuredNoInputEvidence = false,
  toolName?: string,
  structuredJson?: string,
  expectedTarget?: CuaWindowTarget,
): string {
  // This prefix is emitted only after input dispatch may have begun. Keep it
  // on the existing unknown-outcome path even if the Tool also supplies a
  // generic refusal code.
  if (isUnknownForegroundInputOutcome(message)) return "CUA_TOOL_REFUSED";
  // CUA 0.22.2 reports the exact-HWND foreground refusal in Tool text rather
  // than a dedicated error code. The old foreground_unavailable: prefix alone
  // is not enough to make an action retry-safe; require explicit no-input
  // evidence.
  const pinnedToolRefusal = (toolName === "type_text" || toolName === "hotkey") &&
    hasPinnedToolNoDispatchMessage(toolName, message);
  const pinnedClickFocusMismatch = hasPinnedClickFocusMismatchDiagnostic(toolName, message, structuredJson, expectedTarget);
  const foregroundRefusal = /^foreground_unavailable:/iu.test(message) || pinnedToolRefusal || pinnedClickFocusMismatch;
  const noInputEvidence = hasExplicitNoInputEvidence(message) || structuredNoInputEvidence || pinnedToolRefusal;
  if (foregroundRefusal || code === "WINDOW_FOREGROUND_MISMATCH") {
    return noInputEvidence ? "WINDOW_FOREGROUND_MISMATCH" : "CUA_TOOL_REFUSED";
  }
  return code ?? "CUA_TOOL_REFUSED";
}

function nativeIncompleteTypeTextReceipt(
  actionId: ActionReceipt["actionId"],
  toolName: string,
  errorCode: string | undefined,
  structuredJson: string | undefined,
): ActionReceipt | undefined {
  if (toolName !== "type_text") return undefined;
  const structured = parseStructuredRecord(structuredJson);
  const structuredCode = typeof structured?.code === "string" ? structured.code : undefined;
  if (errorCode !== "type_text_incomplete" && structuredCode !== "type_text_incomplete") return undefined;

  // This native code is emitted after dispatch may have started. Treat malformed
  // diagnostics as unknown too; never downgrade it to a retry-safe refusal.
  const requested = structured?.requested_chars;
  const delivered = structured?.delivered_chars;
  const validCounts = structured?.effect === "partial" &&
    typeof requested === "number" && Number.isSafeInteger(requested) && requested > 0 &&
    typeof delivered === "number" && Number.isSafeInteger(delivered) && delivered >= 0 && delivered <= requested;
  const countMessage = validCounts
    ? ` Native typing delivered ${delivered} of ${requested} requested characters.`
    : " Native typing delivery counts were unavailable or malformed.";
  return {
    actionId,
    status: "partial",
    driverCode: "ACTION_OUTCOME_UNKNOWN",
    message: `The native type_text tool reported incomplete input after dispatch may have begun.${countMessage} Inspect the current screen; do not repeat or automatically continue the text action.`,
  };
}

function hasExplicitNoInputEvidence(message: string): boolean {
  return /\bno (?:mouse |keyboard )?input (?:was|has been) (?:sent|dispatched|performed|injected)\b|\binput (?:was|has been) not (?:sent|dispatched|performed|injected)\b/iu.test(message);
}

function isUnknownForegroundInputOutcome(message: string): boolean {
  return /^foreground_input_outcome_unknown:/iu.test(message);
}

function isAmbiguousForegroundResult(message: string): boolean {
  return isUnknownForegroundInputOutcome(message) ||
    (/^foreground_unavailable:/iu.test(message) && !hasExplicitNoInputEvidence(message));
}

function resultProvesNoInput(
  result: { readonly text: string; readonly structuredJson?: string },
  toolName?: string,
): boolean {
  if (hasExplicitNoInputEvidence(result.text) || hasPinnedToolNoDispatchMessage(toolName, result.text)) return true;
  const structured = parseStructuredRecord(result.structuredJson);
  return (structured?.input_sent === false) || (structured?.inputSent === false);
}

const NATIVE_POINT_BLOCKED_NO_DISPATCH_MESSAGE =
  "click failed: exact foreground target is not focused and unobscured at the click point; no pointer or mouse event was dispatched";
const POINT_GUARD_DIAGNOSTIC_MAX_COORDINATE = 1_000_000;

/** Project the one pinned native click-guard refusal into bounded numeric facts only. */
function pointBlockedGuardRefusalMessage(input: {
  readonly actionKind: ActionIntent["kind"];
  readonly toolName: string;
  readonly message: string;
  readonly structuredJson?: string;
  readonly bindingTarget?: CuaWindowTarget;
  readonly requestedTarget: unknown;
}): string | undefined {
  if (input.actionKind !== "click" || input.toolName !== "click" || input.bindingTarget === undefined ||
      input.message !== NATIVE_POINT_BLOCKED_NO_DISPATCH_MESSAGE ||
      input.structuredJson === undefined || input.structuredJson.length > 16_384) return undefined;
  const requestTarget = parseStructuredRecord(input.requestedTarget);
  if (requestTarget?.pid !== input.bindingTarget.pid || requestTarget.window_id !== input.bindingTarget.windowId) return undefined;

  const envelope = parseStructuredRecord(input.structuredJson);
  const diagnostic = parseStructuredRecord(envelope?.guard_diagnostic);
  const target = parseStructuredRecord(diagnostic?.target);
  const frontmost = parseStructuredRecord(diagnostic?.frontmost_pid);
  const focused = parseStructuredRecord(diagnostic?.focused_window_id);
  const point = parseStructuredRecord(diagnostic?.translated_screen_point);
  const hitTest = parseStructuredRecord(diagnostic?.point_hit_test);
  const enumeration = parseStructuredRecord(hitTest?.enumeration);
  const targetRow = parseStructuredRecord(hitTest?.target_row);
  const blockerRow = parseStructuredRecord(hitTest?.first_blocking_row);
  const targetBounds = parseDiagnosticBounds(targetRow?.bounds);
  const blockerBounds = parseDiagnosticBounds(blockerRow?.bounds);
  const screenX = boundedDiagnosticCoordinate(point?.x);
  const screenY = boundedDiagnosticCoordinate(point?.y);
  const targetLayer = boundedDiagnosticInteger(targetRow?.layer, -1_000_000, 1_000_000);
  const targetZ = boundedDiagnosticInteger(targetRow?.z_index, -1_000_000, 1_000_000);
  const blockerLayer = boundedDiagnosticInteger(blockerRow?.layer, -1_000_000, 1_000_000);
  const blockerZ = boundedDiagnosticInteger(blockerRow?.z_index, -1_000_000, 1_000_000);
  const rawRows = boundedDiagnosticInteger(enumeration?.raw_row_count, 0, 1_000_000);
  const parsedRows = boundedDiagnosticInteger(enumeration?.parsed_row_count, 2, 1_000_000);
  const malformedRows = boundedDiagnosticInteger(enumeration?.malformed_row_count, 0, 1_000_000);
  const targetPid = boundedDiagnosticInteger(target?.pid, 1, Number.MAX_SAFE_INTEGER);
  const targetWindowId = boundedDiagnosticInteger(target?.window_id, 1, Number.MAX_SAFE_INTEGER);
  const blockerPid = boundedDiagnosticInteger(blockerRow?.pid, 1, Number.MAX_SAFE_INTEGER);
  const blockerWindowId = boundedDiagnosticInteger(blockerRow?.window_id, 1, Number.MAX_SAFE_INTEGER);

  if (diagnostic?.schema !== "foreground-pixel-guard-diagnostic-v2" ||
      targetPid !== input.bindingTarget.pid || targetWindowId !== input.bindingTarget.windowId ||
      frontmost?.status !== "available" || frontmost.value !== targetPid ||
      focused?.status !== "available" || focused.value !== targetWindowId ||
      screenX === undefined || screenY === undefined ||
      hitTest?.status !== "blocked_by_window" || hitTest.allowed !== false ||
      enumeration?.read_status !== "ok" || rawRows === undefined || parsedRows === undefined || malformedRows === undefined ||
      parsedRows > rawRows || malformedRows > rawRows ||
      targetPid !== targetRow?.pid || targetWindowId !== targetRow.window_id ||
      targetRow.is_on_screen !== true || blockerRow?.is_on_screen !== true ||
      blockerPid === undefined || blockerWindowId === undefined ||
      (blockerPid === targetPid && blockerWindowId === targetWindowId) ||
      targetLayer === undefined || targetZ === undefined || blockerLayer === undefined || blockerZ === undefined ||
      blockerZ <= targetZ || targetBounds === undefined || blockerBounds === undefined ||
      !diagnosticBoundsContainPoint(targetBounds, screenX, screenY) ||
      !diagnosticBoundsContainPoint(blockerBounds, screenX, screenY)) return undefined;

  return `Click refused: exact focus matched target pid/window=${targetPid}/${targetWindowId}; point=${formatDiagnosticCoordinate(screenX)},${formatDiagnosticCoordinate(screenY)} is blocked by reported window pid/window/layer/z=${blockerPid}/${blockerWindowId}/${blockerLayer}/${blockerZ} (target layer/z=${targetLayer}/${targetZ}; target bounds=${formatDiagnosticBounds(targetBounds)}; blocker bounds=${formatDiagnosticBounds(blockerBounds)}); no pointer or mouse event was dispatched. Do not repeat this click, or use another reference/tool to send the same click, while the reported blocker remains. A target-window screenshot alone does not prove the blocker disappeared. Use fresh GUI evidence to choose an unobstructed control, or a normal menu/keyboard path only after confirming the exact target is focused. If safe progress cannot be verified, stop and report the blocker.`;
}

function boundedDiagnosticInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : undefined;
}

function boundedDiagnosticCoordinate(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= POINT_GUARD_DIAGNOSTIC_MAX_COORDINATE
    ? value
    : undefined;
}

function parseDiagnosticBounds(value: unknown): CuaWindowGeometry | undefined {
  const record = parseStructuredRecord(value);
  const x = boundedDiagnosticCoordinate(record?.x);
  const y = boundedDiagnosticCoordinate(record?.y);
  const width = boundedDiagnosticCoordinate(record?.width);
  const height = boundedDiagnosticCoordinate(record?.height);
  return x !== undefined && y !== undefined && width !== undefined && height !== undefined && width > 0 && height > 0
    ? { x, y, width, height }
    : undefined;
}

function diagnosticBoundsContainPoint(bounds: CuaWindowGeometry, x: number, y: number): boolean {
  return x >= bounds.x && y >= bounds.y && x <= bounds.x + bounds.width && y <= bounds.y + bounds.height;
}

function formatDiagnosticCoordinate(value: number): string {
  return value.toFixed(2);
}

function formatDiagnosticBounds(bounds: CuaWindowGeometry): string {
  return `${formatDiagnosticCoordinate(bounds.x)},${formatDiagnosticCoordinate(bounds.y)},${formatDiagnosticCoordinate(bounds.width)},${formatDiagnosticCoordinate(bounds.height)}`;
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
export type CuaGroundingMode = "off" | "uia-catalog-v1" | "dom-catalog-v1" | "hybrid-catalog-v1";
export type CuaWindowSwitchMode = "off" | "opened-windows-v1";

// Keep the adapter side bounded but larger than the model-facing hot set. The
// Runtime selector narrows this to at most 16 before Observation persistence;
// the private ref map still retains every safe candidate here for the current
// Computer session. Depth 16 is needed for real browser document descendants;
// the hard element cap prevents an unbounded UIA tree from entering Runtime.
const GROUNDING_MAX_ELEMENTS = 256;
const GROUNDING_QUERY_MAX_ELEMENTS = 256;
const OPTIONAL_GROUNDING_READ_TIMEOUT_MS = 5_000;
const MULTILINE_GROUNDING_QUERY_TIMEOUT_MS = 2_500;

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
  /** Host-only opt-in to ordinary foreground typing for ungrounded Windows multiline text. */
  multilineTypeProfile?: CuaMultilineTypeProfile;
  /** Optional, explicit UIA sidecar; requires an explicit window target. */
  grounding?: CuaGroundingMode;
  /** Explicit host-owned managed browser target for the DOM transport gate. */
  browserTarget?: ManagedBrowserTarget;
  /** Host-only opt-in: activate the exact managed-browser window target once at open without changing desktop scope. */
  activateManagedBrowserOnOpen?: boolean;
  /** Explicit per-Run permission to discover and switch among opened windows. */
  windowSwitch?: CuaWindowSwitchMode;
  /**
   * Optional exact host-authorized target scope for every window transition.
   * When set, returning to the Run-owned browser also requires its HWND here.
   */
  windowSwitchAllowedTargets?: readonly CuaWindowTarget[];
  /** Exact Host-prepared recovery window, restricted to the opt-in missing-bound recovery flow. */
  recoveryWindowTarget?: CuaWindowTarget;
  recoverBoundWindowMissing?: boolean;
  /** Explicit one-file reopen grant; Darwin native-window Runs only. */
  reopenSavedDocumentGrant?: ReopenSavedDocumentGrant;
  /** Host-issued capability joining one ephemeral Browser target to one exact native recovery pair. */
  hybridNativeWebDocumentCapability?: {
    readonly managedBrowserTarget: ManagedBrowserTarget;
    readonly primaryTarget: CuaWindowTarget;
    readonly recoveryTarget: CuaWindowTarget;
  };
  /** Injected host-only read-only relationship evidence; absent/failed means manual transient handling. */
  windowRelationshipProbe?: WindowRelationshipProbe;
  /** Optional private Win32 evidence used only for desktop managed-browser grounding and ref freshness. */
  desktopGroundingRelationshipProbe?: WindowRelationshipProbe;
  /** Host-supplied managed-browser transport; never discovered by this adapter. */
  domGroundingTransport?: DomGroundingTransport;
  /** Total wall-clock budget for endSession/shutdown cleanup; no GUI action is retried. */
  cleanupWaitMs?: number;
  /** Test seam; production uses CuaDriver.connect. */
  driverFactory?: CuaDriverFactory;
  /** Controlled platform override for this session; otherwise use valid driver health, then the host platform. */
  platform?: NodeJS.Platform;
  /** Test seam for capture retry timing; production uses bounded real delays. */
  windowCaptureRetry?: WindowCaptureRetryOptions;
}

interface PrivateSession {
  label: string;
  driver: CuaDriverLike;
  platform: CuaPlatform;
  descriptor: ComputerSessionDescriptor;
  active: boolean;
  surfaceRegistry: SurfaceRegistryState;
  /** Exact HWND geometry snapshots, keyed by Registry-owned Surface identity. */
  windowBindings: Map<string, CuaWindowBinding>;
  /** Allow one bounded managed-browser content-rect stabilization at startup. */
  initialObservationPending: boolean;
  /** Full visible-window baseline from the last successful target observation. */
  visibleWindowBaseline: ReadonlySet<string> | undefined;
  /** Fresh inventory immediately before an opted-in foreground GUI action. */
  preActionWindowBaseline: {
    readonly actionId: ActionIntent["actionId"];
    readonly sourceObservationId: ObservationId;
    readonly closeShortcut: boolean;
    readonly createTextEditDocumentShortcut: boolean;
    readonly openTextEditDocumentShortcut: boolean;
    readonly sourceApplicationIdentity?: VerifiedApplicationIdentity;
    completed: boolean;
    readonly targetKeys: ReadonlySet<string>;
    readonly windowRows: readonly CuaWindowInfo[];
    readonly complete: boolean;
    readonly truncated: boolean;
    readonly parentSurfaceRef: SurfaceRef;
    /** Fresh pure-CUA list bounds, distinct from the native screenshot rectangle when capture is DWM-pixel based. */
    readonly parentCuaBounds?: CuaWindowGeometry;
    readonly parentBinding: CuaWindowBinding;
  } | undefined;
  missingParent?: {
    readonly sourceActionId: ActionIntent["actionId"];
    readonly reason: "bound_window_missing";
    candidates: Map<string, ComputerWindowCandidate>;
    epoch: number;
    confirming: boolean;
  };
  /** Exact TextEdit document windows created by this Run's completed Cmd+N actions. */
  runOwnedTextEditWindows: Map<string, RunOwnedTextEditWindowProof>;
  /** A completed model Cmd+O, scoped to its exact Run-owned TextEdit root until its modal Open action completes. */
  runOwnedTextEditOpenIntent?: RunOwnedTextEditOpenIntent;
  /** Transition-only capture after a completed close, awaiting explicit model switch_window. */
  taskWindowTransition?: {
    readonly closeSourceActionId: ActionIntent["actionId"];
    readonly closeSourceSurfaceRef: SurfaceRef;
    readonly target: CuaWindowTarget;
    readonly candidate: RunOwnedTextEditWindowProof;
    observationSurfaceRef?: SurfaceRef;
  };
  /** Windows surfaced since that observation; only these may be considered for automatic handoff. */
  newlySurfacedWindowKeys: ReadonlySet<string>;
  /** Visible identities observed after a completed action; model inventory annotation only. */
  firstObservedAfterActionWindows: { readonly actionId: ActionIntent["actionId"]; readonly targetKeys: ReadonlySet<string> } | undefined;
  /** Candidate snapshot produced by the immediately preceding list call. */
  newHandoffCandidates: readonly ComputerWindowCandidate[];
  /** Exact HWND reported by CUA as foreground for the current no-input refusal. */
  foregroundMismatchWindowId: number | undefined;
  /** Set only when the driver has an explicit no-input foreground refusal; it does not require a foreign HWND value. */
  managedBrowserRestoreEligible: boolean;
  /** Fresh UI-confirmable restore tokens for this exact managed browser target. */
  managedBrowserRestoreCandidates: Map<string, ComputerWindowCandidate>;
  managedBrowserRestoreConfirming: boolean;
  /** True only when the last completed action produced a pre/post inventory diff. */
  proactiveHandoffCandidatesReady: boolean;
  recoveryWindowIdentity?: CuaWindowInfo;
  reopenSavedDocument?: PrivateReopenSavedDocumentState;
  /** Adapter-private active managed tab; never serialized to Runtime. */
  browserTarget?: ManagedBrowserTarget;
  /** Run-owned managed target survives switching to native windows. */
  managedBrowserTarget?: ManagedBrowserTarget;
  /** Opaque Run-local peer Surface refs emitted by the latest listWindows call. */
  windowRefs: Map<string, SurfaceRef>;
  /** SurfaceRegistry mutation reason attached to the next successful capture. */
  pendingSurfaceTransitionReason?: SurfaceTransitionReason;
  /** Exact root already checked for an existing owned transient during observe. */
  lastInspectedExistingTransientRootRef?: SurfaceRef;
  /** Monotonic dispatch time for a local Windows foreground desktop GUI action whose next frame needs bounded paint settling. */
  pendingPostGuiActionObservationAt?: number;
  /** Short-lived guard against replaying the same GUI primitive after an unknown foreground outcome. */
  unknownActionReplayGuard?: {
    readonly surfaceRef: SurfaceRef;
    readonly primitiveFingerprints: Set<string>;
    /** Desktop recovery keeps this guard until a different GUI primitive completes and a fresh same-Surface observation follows. */
    readonly recoveryKind?: "desktop_surface_reconfirmed";
    alternativeActionCompleted: boolean;
  };
  /** Set only while the current unknown action's post-dispatch native diff is being verified. */
  unknownActionReconciliationPending?: boolean;
  /** Exact active root re-confirmed by the most recent unknown-action diff. */
  unknownActionReconfirmedSurfaceRef?: SurfaceRef;
}

interface RunOwnedTextEditWindowProof {
  readonly target: CuaWindowTarget;
  readonly sourceActionId: ActionIntent["actionId"];
  readonly sourceOpenActionId?: ActionIntent["actionId"];
  readonly sourceParentSurfaceRef: SurfaceRef;
  readonly sourceApplicationIdentity: VerifiedApplicationIdentity;
  surfaceRef: SurfaceRef;
}

interface RunOwnedTextEditOpenIntent {
  readonly sourceActionId: ActionIntent["actionId"];
  readonly sourceTarget: CuaWindowTarget;
  readonly sourceParentSurfaceRef: SurfaceRef;
  readonly sourceApplicationIdentity: VerifiedApplicationIdentity;
  readonly baselineTargetKeys: ReadonlySet<string>;
  admittedOpenSheetRef?: SurfaceRef;
  sourceParentAfterOpenSheetRef?: SurfaceRef;
}

type CuaPlatform = "win32" | "darwin" | "linux";
interface PlatformHealthEvidence {
  readonly status: "valid" | "unavailable" | "degraded" | "invalid";
  readonly reportedPlatform?: CuaPlatform;
  readonly schemaVersion?: string;
  readonly driverVersion?: string;
}
interface PlatformResolution {
  readonly effective: CuaPlatform;
  readonly source: "configured" | "health" | "host";
  readonly configured?: CuaPlatform;
  readonly health: PlatformHealthEvidence;
  readonly conflict: boolean;
}

/** Resolve platform-specific capture behavior from the explicit override, the
 * detected CUA session, then the host fallback. `hostPlatform` supports stable
 * unit coverage without mutating process.platform. */
export function resolveCapturePlatform(
  configuredPlatform: NodeJS.Platform | undefined,
  sessionPlatform: NodeJS.Platform | undefined,
  hostPlatform: NodeJS.Platform = process.platform,
): NodeJS.Platform {
  return configuredPlatform ?? sessionPlatform ?? hostPlatform;
}

interface PendingDriverCleanup {
  label: string;
  driver: CuaDriverLike;
}

interface PrivateObservation {
  sessionId: string;
  captureSource?: "verify_state" | "get_window_state_registered" | "get_window_state_fallback" | "windows_foreground_region";
  readonly surfaceRef: SurfaceRef;
  /**
   * The image coordinate space that the model used for this observation.
   * Window actions must be projected from this viewport, not from the
   * current session viewport (which may belong to a later observation).
   */
  viewport: Viewport;
  /** Fresh CUA list_windows geometry used only for execute-time freshness checks. */
  cuaBounds?: CuaWindowGeometry;
  geometry?: CuaWindowGeometry;
}

interface BrowserChromeInputIntent {
  readonly sessionId: ComputerSessionDescriptor["id"];
  readonly surfaceRef: SurfaceRef;
  readonly browserTarget: ManagedBrowserTarget;
  readonly fingerprint?: string;
  readonly invalidated: boolean;
}

interface PrivateGrounding {
  readonly catalog: Omit<GroundingCatalog, "surfaceRef">;
  /** Exact native surface and window lifecycle that produced this catalog. */
  readonly windowBinding?: CuaWindowBinding;
  /** Producer-local image viewport when public bounds are projected onto the desktop frame. */
  readonly producerViewport?: Viewport;
  /** Native-window to desktop-physical scale, retained for explicit-ref freshness checks. */
  readonly nativeToDesktopScale?: number;
  /** Current host-attested tab/generation, retained only by the Adapter. */
  readonly browserTarget?: ManagedBrowserTarget;
  /** Trusted physical browser content rect derived from the same observation's UIA Document. */
  readonly contentRect?: DomGroundingContentRect;
  /** Completeness of the DOM producer, independently of the UIA catalog. */
  readonly domComplete?: boolean;
  /** Independent macOS AX focus attestation; never projected as an ordinary catalog row. */
  readonly focusProof?: PrivateGroundingElement;
  readonly elements: ReadonlyMap<string, PrivateGroundingElement>;
}

interface BoundPrivateGrounding extends Omit<PrivateGrounding, "catalog"> {
  readonly catalog: GroundingCatalog;
  readonly surfaceRef: SurfaceRef;
}

interface PrivateGroundingElement {
  readonly element: GroundingElement;
  /** Raw private DOM name; public names may be redacted. */
  readonly candidateName?: string;
  readonly point: { readonly x: number; readonly y: number };
  readonly candidateFingerprint?: string;
  readonly candidateFrame?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly selectable?: boolean;
  readonly geometry?: CuaWindowGeometry;
  /** Window-local physical bounds retained for managed-browser dispatch after desktop projection. */
  readonly dispatchBBox?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  /** Stable private identity; excludes element token and editable value. */
  readonly uiaIdentityFingerprint?: string;
  /** Raw UIA token and snapshot are never projected to Runtime or Providers. */
  readonly uiaTarget?: { readonly pid: number; readonly windowId: number; readonly elementToken: string; readonly snapshotId?: string };
}

interface DriverErrorDetails {
  message: string;
  tag?: string;
  errorCode?: string;
  structuredJson?: string;
}

export class CuaDriverComputer implements Computer {
  private readonly options: Required<Pick<CuaDriverComputerOptions, "socketPath" | "screenshotDir" | "cleanupWaitMs">> & Omit<CuaDriverComputerOptions, "socketPath" | "screenshotDir" | "cleanupWaitMs">;
  private readonly windowCaptureRetryOptions: WindowCaptureRetryOptions;
  private readonly observations = new Map<string, PrivateObservation>();
  private readonly groundings = new Map<string, BoundPrivateGrounding>();
  private latestObservationId: ObservationId | undefined;
  private expectedDomInput: DomClickRequest | undefined;
  private browserChromeInput: BrowserChromeInputIntent | undefined;
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
    const nativeForegroundCaptureAllowed = process.platform === "win32" && options.driverFactory === undefined &&
      options.windowDeliveryMode === "foreground" && isLocalWindowsNamedPipeSocket(options.socketPath);
    this.windowCaptureRetryOptions = {
      ...this.options.windowCaptureRetry,
      ...(this.options.windowCaptureRetry?.foregroundVisibleCapture !== undefined || !nativeForegroundCaptureAllowed
        ? {}
        : { foregroundVisibleCapture: captureVisibleWindowRegion }),
    };
    if (!Number.isInteger(this.options.cleanupWaitMs) || this.options.cleanupWaitMs <= 0) {
      throw new Error("cleanupWaitMs must be a positive integer");
    }
    if (this.options.windowDeliveryMode !== undefined
      && this.options.windowDeliveryMode !== "background"
      && this.options.windowDeliveryMode !== "foreground") {
      throw new Error("windowDeliveryMode must be background or foreground");
    }
    if (this.options.multilineTypeProfile !== undefined && this.options.multilineTypeProfile !== "foreground-caret-v1") {
      throw new Error("multilineTypeProfile must be foreground-caret-v1");
    }
    if (this.options.windowSwitch !== undefined
      && this.options.windowSwitch !== "off"
      && this.options.windowSwitch !== "opened-windows-v1") {
      throw new Error("windowSwitch must be off or opened-windows-v1");
    }
    if (this.options.windowTarget !== undefined) validateWindowTarget(this.options.windowTarget);
    for (const target of this.options.windowSwitchAllowedTargets ?? []) validateWindowTarget(target);
    if (this.options.recoveryWindowTarget !== undefined) validateWindowTarget(this.options.recoveryWindowTarget);
    const hybridCapability = this.options.hybridNativeWebDocumentCapability;
    if (hybridCapability !== undefined && (this.options.browserTarget === undefined ||
        this.options.recoverBoundWindowMissing !== true || this.options.reopenSavedDocumentGrant === undefined ||
        this.options.grounding !== "hybrid-catalog-v1" || this.options.windowTarget === undefined ||
        windowIdentityKey(hybridCapability.primaryTarget) !== windowIdentityKey(this.options.windowTarget) ||
        this.options.recoveryWindowTarget === undefined ||
        windowIdentityKey(hybridCapability.recoveryTarget) !== windowIdentityKey(this.options.recoveryWindowTarget) ||
        this.options.browserTarget.profileId !== hybridCapability.managedBrowserTarget.profileId ||
        this.options.browserTarget.tabId !== hybridCapability.managedBrowserTarget.tabId ||
        this.options.browserTarget.generation !== hybridCapability.managedBrowserTarget.generation ||
        windowIdentityKey(this.options.browserTarget.windowTarget) !== windowIdentityKey(hybridCapability.managedBrowserTarget.windowTarget) ||
        windowIdentityKey(hybridCapability.managedBrowserTarget.windowTarget) === windowIdentityKey(this.options.windowTarget) ||
        windowIdentityKey(hybridCapability.managedBrowserTarget.windowTarget) === windowIdentityKey(this.options.recoveryWindowTarget) ||
        this.options.windowSwitchAllowedTargets?.length !== 2 ||
        !this.options.windowSwitchAllowedTargets.some((target) => windowIdentityKey(target) === windowIdentityKey(hybridCapability.primaryTarget)) ||
        !this.options.windowSwitchAllowedTargets.some((target) => windowIdentityKey(target) === windowIdentityKey(hybridCapability.recoveryTarget)))) {
      throw new Error("hybrid native-web-document capability must exactly bind one managed Browser and the Host native recovery pair");
    }
    if (this.options.recoverBoundWindowMissing === true && (this.options.windowSwitch !== "opened-windows-v1" ||
        this.options.windowTarget === undefined || this.options.recoveryWindowTarget === undefined ||
        (this.options.browserTarget !== undefined && hybridCapability === undefined) ||
        (this.options.grounding === "dom-catalog-v1" || this.options.grounding === "hybrid-catalog-v1") && hybridCapability === undefined ||
        this.options.windowSwitchAllowedTargets?.length !== 2 ||
        !this.options.windowSwitchAllowedTargets.some((target) => windowIdentityKey(target) === windowIdentityKey(this.options.windowTarget!)) ||
        !this.options.windowSwitchAllowedTargets.some((target) => windowIdentityKey(target) === windowIdentityKey(this.options.recoveryWindowTarget!)) ||
        windowIdentityKey(this.options.windowTarget) === windowIdentityKey(this.options.recoveryWindowTarget) ||
        !targetAllowedByHostScope(this.options.windowTarget, this.options.windowSwitchAllowedTargets) ||
        !targetAllowedByHostScope(this.options.recoveryWindowTarget, this.options.windowSwitchAllowedTargets))) {
      throw new Error("bound-window recovery requires distinct exact primary/recovery targets, window switching, and Host authorization for both");
    }
    if (this.options.recoverBoundWindowMissing !== true && this.options.recoveryWindowTarget !== undefined) {
      throw new Error("recoveryWindowTarget requires recoverBoundWindowMissing opt-in");
    }
    if (this.options.reopenSavedDocumentGrant !== undefined &&
        (this.options.recoverBoundWindowMissing !== true ||
         this.options.windowDeliveryMode !== "foreground" || this.options.windowTarget === undefined ||
         this.options.recoveryWindowTarget === undefined || this.options.windowTarget.pid !== this.options.recoveryWindowTarget.pid ||
         (this.options.browserTarget !== undefined && hybridCapability === undefined) ||
         (this.options.grounding === "dom-catalog-v1" || this.options.grounding === "hybrid-catalog-v1") && hybridCapability === undefined)) {
      throw new Error("saved-document reopen requires a Darwin foreground native recovery Run for one exact TextEdit process");
    }
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
      const browserHasHybridGrant = hybridCapability !== undefined &&
        windowIdentityKey(this.options.browserTarget.windowTarget) === windowIdentityKey(hybridCapability.managedBrowserTarget.windowTarget);
      if (!browserIsInitialTarget && (this.options.windowSwitch !== "opened-windows-v1" ||
          (!targetAllowedByHostScope(this.options.browserTarget.windowTarget, this.options.windowSwitchAllowedTargets) && !browserHasHybridGrant))) {
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
    const sdkModule = await loadCuaSdkModule();
    const driver = this.options.driverFactory !== undefined
      ? this.options.driverFactory(this.options.socketPath)
      : sdkModule.CuaDriver.connect(this.options.socketPath);
    const label = this.options.sessionLabel ?? `computer-harness-${Date.now()}`;
    let sessionStarted = false;
    try {
      await driver.startSession(sdkModule.StartSessionInput.new({ session: label }), { signal });
      sessionStarted = true;
      const healthEvidence = await detectCuaPlatform(driver, signal);
      // Resolve once so Runtime mapping and every CUA route share the same
      // platform even when health is unavailable or disagrees with Host config.
      const platformResolution = resolveSessionPlatform(this.options.platform, healthEvidence, process.platform);
      const platform = platformResolution.effective;
      let viewport: Viewport;
      let windowBinding: CuaWindowBinding | undefined;
      let surfaceRegistry = createSurfaceRegistry(label);
      const windowBindings = new Map<string, CuaWindowBinding>();
      let recoveryWindowIdentity: CuaWindowInfo | undefined;
      const reopenGrant = this.options.reopenSavedDocumentGrant === undefined
        ? undefined
        : await prepareReopenSavedDocumentGrant(this.options.reopenSavedDocumentGrant);
      let reopenSavedDocument: PrivateReopenSavedDocumentState | undefined;
      if (this.options.recoverBoundWindowMissing === true) {
        if (platform !== "darwin") throw new Error("bound-window recovery is currently supported only on Darwin");
        const inventory = await listWindowInventory(driver, label, signal, undefined, true, this.options.windowRelationshipProbe, platform);
        if (inventory.truncated === true) throw new Error("recovery target identity could not be pinned from a truncated fresh inventory");
        const matches = inventory.windows.filter((window) => windowIdentityKey(window.target) === windowIdentityKey(this.options.recoveryWindowTarget!));
        if (matches.length !== 1 || matches[0]!.isOnScreen !== true || matches[0]!.minimized === true) {
          throw new Error("Host-prepared recovery target was not uniquely visible at Run open");
        }
        recoveryWindowIdentity = matches[0];
      }
      if (this.options.windowTarget === undefined) {
        if (this.options.activateManagedBrowserOnOpen === true && this.options.browserTarget !== undefined) {
          // This is only a one-time startup focus assist. Keep the full desktop
          // Surface and continue visually if activation is refused or unknown.
          try {
            await bringWindowToFrontOnce(driver, label, this.options.browserTarget.windowTarget, signal);
          } catch {
            signal.throwIfAborted();
            process.stderr.write("Managed-browser startup activation was not confirmed; continuing with full-desktop capture and manual window switching.\n");
          }
        }
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
        const capture = await captureWindowWithRetry(driver, label, this.options.windowTarget, signal, this.windowCaptureRetryOptions, resolveCapturePlatform(this.options.platform, platform));
        windowBinding = capture.binding;
        viewport = capture.viewport;
        if (reopenGrant !== undefined) {
          if (platform !== "darwin") throw new Error("saved-document reopen is currently supported only on Darwin");
          const appProof = await queryDocumentIdentity(driver, label, capture.binding.target, capture.binding.bounds,
            reopenGrant.canonicalExecutableUrl, signal);
          if (appProof === undefined || appProof.identity.pid !== this.options.windowTarget.pid ||
              appProof.identity.windowId !== this.options.windowTarget.windowId) {
            throw new Error("Host-granted TextEdit process identity could not be uniquely verified at Run open");
          }
          reopenSavedDocument = {
            ...reopenGrant,
            primaryIdentity: appProof.identity,
            recoveryReady: false,
            attempted: false,
          };
        }
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
        ...(platform === undefined ? {} : { platform }),
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
        platform,
        descriptor,
        active: true,
        surfaceRegistry,
        windowBindings,
        initialObservationPending: true,
        visibleWindowBaseline: undefined,
        preActionWindowBaseline: undefined,
        runOwnedTextEditWindows: new Map(),
        newlySurfacedWindowKeys: new Set(),
        firstObservedAfterActionWindows: undefined,
        newHandoffCandidates: [],
        foregroundMismatchWindowId: undefined,
        managedBrowserRestoreEligible: false,
        managedBrowserRestoreCandidates: new Map(),
        managedBrowserRestoreConfirming: false,
        proactiveHandoffCandidatesReady: false,
        ...(recoveryWindowIdentity === undefined ? {} : { recoveryWindowIdentity }),
        ...(reopenSavedDocument === undefined ? {} : { reopenSavedDocument }),
        ...(this.options.browserTarget === undefined ? {} : {
          ...(browserIsInitialTarget ? { browserTarget: this.options.browserTarget! } : {}),
          managedBrowserTarget: this.options.browserTarget,
        }),
        windowRefs: new Map(),
      };
      this.expectedDomInput = undefined;
      this.browserChromeInput = undefined;
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
    if (current.missingParent !== undefined && current.taskWindowTransition !== undefined) {
      return this.observeTaskWindowTransition(current, session, observationId, signal);
    }
    if (current.missingParent !== undefined) throw new BoundWindowMissingError(current.missingParent.sourceActionId);
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
      const pendingPostGuiActionObservationAt = current.pendingPostGuiActionObservationAt;
      delete current.pendingPostGuiActionObservationAt;
      try {
        const captureDesktopFrame = async () => {
          signal.throwIfAborted();
          // Reuse one private path across samples, but never accept a prior
          // frame as proof that this capture completed.
          await rm(screenshotPath, { force: true });
          const result = await callTool(current.driver, "get_desktop_state", {
            session: current.label,
            screenshot_out_file: screenshotPath,
          }, signal);
          const capturedAt = new Date().toISOString();
          const dimensions = readStructuredScreenshotDimensions(result) ?? await readPngDimensions(screenshotPath);
          if (dimensions === undefined) throw new Error("CUA get_desktop_state did not return screenshot dimensions");
          const data = new Uint8Array(await readFile(screenshotPath));
          return { png: data, value: { dimensions, data, capturedAt } };
        };
        const captured = pendingPostGuiActionObservationAt === undefined
          ? (await captureDesktopFrame()).value
          : await settlePostInputObservation({
            inputCompletedAt: pendingPostGuiActionObservationAt,
            capture: captureDesktopFrame,
            signal,
            wait: waitWithAbort,
            now: () => performance.now(),
          });
        const { dimensions, data, capturedAt } = captured;
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
        const unknownActionReplayGuard = current.unknownActionReplayGuard;
        if (unknownActionReplayGuard?.recoveryKind === "desktop_surface_reconfirmed" &&
            sameSurfaceRef(unknownActionReplayGuard.surfaceRef, observedSurfaceRef) &&
            unknownActionReplayGuard.alternativeActionCompleted) {
          delete current.unknownActionReplayGuard;
        }
        const desktopGrounding = await readAuthorizedDesktopGrounding({
          mode: this.options.grounding,
          driver: current.driver,
          session: current.label,
          sessionId: session.id,
          observationId,
          desktopViewport: { ...dimensions, coordinateSpace: "physical" },
          current,
          captureRetryOptions: this.windowCaptureRetryOptions,
          platform: resolveCapturePlatform(this.options.platform, current.platform),
          ...(this.getDesktopGroundingRelationshipProbe() === undefined ? {} : { relationshipProbe: this.getDesktopGroundingRelationshipProbe()! }),
          ...(this.options.domGroundingTransport === undefined ? {} : { domTransport: this.options.domGroundingTransport }),
          signal,
        });
        signal.throwIfAborted();
        const boundGrounding: BoundPrivateGrounding | undefined = desktopGrounding === undefined
          ? undefined
          : {
            ...desktopGrounding,
            catalog: { ...desktopGrounding.catalog, surfaceRef: observedSurfaceRef },
            surfaceRef: observedSurfaceRef,
          };
        this.observations.set(String(observationId), {
          sessionId: String(session.id),
          surfaceRef: observedSurfaceRef,
          viewport: current.descriptor.viewport,
        });
        if (boundGrounding !== undefined) this.groundings.set(String(observationId), boundGrounding);
        else this.groundings.delete(String(observationId));
        this.latestObservationId = observationId;
        const surfaceTransitionReason = takeSurfaceTransitionReason(current);
        return {
          capturedAt,
          viewport: current.descriptor.viewport,
          surfaceRef: observedSurfaceRef,
          ...(surfaceTransitionReason === undefined ? {} : { surfaceTransitionReason }),
          screenshot: { mediaType: "image/png", data },
          ...(boundGrounding === undefined ? {} : { grounding: boundGrounding.catalog }),
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
    const captureAfterExistingTransient = await this.admitExistingOwnedTransientChild(current, signal);
    const captureBinding = activeWindowBinding(current);
    if (captureBinding === undefined) {
      throw normalizeDriverError(new WindowContractError("WINDOW_TARGET_INVALIDATED", "active Surface has no verified native capture binding"), "observe");
    }
    {
      try {
        const capture = captureAfterExistingTransient ?? await captureWindowWithRetry(
          current.driver,
          current.label,
          captureBinding.target,
          signal,
          this.windowCaptureRetryOptions,
          resolveCapturePlatform(this.options.platform, current.platform),
        );
        const liveBinding = capture.binding;
        const reopenState = current.reopenSavedDocument;
        let authorizedSavedDocumentEvidenceStatus: AuthorizedSavedDocumentEvidence["status"] | undefined;
        if (reopenState !== undefined && current.platform === "darwin" &&
            windowIdentityKey(liveBinding.target) === windowIdentityKey(this.options.windowTarget!)) {
          authorizedSavedDocumentEvidenceStatus = "unverified";
          delete reopenState.savedDocument;
          try {
            signal.throwIfAborted();
            if (!(await authorizedOutputParentIsPinned(reopenState.path, reopenState.parentIdentity))) throw new Error("authorized output parent changed");
            const fileState = await inspectAuthorizedOutputFileIdentity(reopenState.path);
            if (fileState.status === "unverified") throw new Error("authorized output file state could not be verified");
            const beforeFileIdentity = fileState.status === "present" ? fileState.identity : undefined;
            const fileWasAbsent = fileState.status === "absent";
            const documentProof = await queryDocumentIdentity(
              current.driver,
              current.label,
              liveBinding.target,
              liveBinding.bounds,
              reopenState.canonicalExecutableUrl,
              signal,
              fileWasAbsent ? undefined : reopenState.fileUrl,
            );
            signal.throwIfAborted();
            const parentStillPinned = await authorizedOutputParentIsPinned(reopenState.path, reopenState.parentIdentity);
            if (!parentStillPinned || documentProof === undefined ||
                !sameApplicationIdentity(documentProof.identity, reopenState.primaryIdentity)) {
              throw new Error("authorized document or parent proof was not stable");
            }
            if (fileWasAbsent) {
              let remainsAbsent = false;
              try {
                await lstat(reopenState.path, { bigint: true });
              } catch (error) {
                if (isNodeError(error) && error.code === "ENOENT") remainsAbsent = true;
                else throw error;
              }
              if (!remainsAbsent) throw new Error("authorized file appeared during observation");
              authorizedSavedDocumentEvidenceStatus = "authorized_file_absent";
            } else {
              const afterFileIdentity = await fileIdentityPin(reopenState.path);
              if (beforeFileIdentity === undefined || !sameFileIdentity(beforeFileIdentity, afterFileIdentity) ||
                  documentProof.cleanDocument !== true) {
                throw new Error("authorized file/document binding changed during observation");
              }
              reopenState.savedDocument = {
                snapshotId: documentProof.snapshotId,
                observationId,
                identity: documentProof.identity,
                fileUrl: reopenState.fileUrl,
                windowGeometry: { ...liveBinding.bounds },
                fileIdentity: afterFileIdentity,
              };
              authorizedSavedDocumentEvidenceStatus = "verified_clean_current_document";
            }
          } catch (error) {
            if (signal.aborted) throw error;
            // A private file/document proof failure only withholds the
            // one-shot reopen grant; it never changes the normal observation.
            delete reopenState.savedDocument;
            authorizedSavedDocumentEvidenceStatus = "unverified";
          }
        }
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
          current.initialObservationPending,
          current.platform === "darwin",
        );
        signal.throwIfAborted();
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
        const unknownActionReplayGuard = current.unknownActionReplayGuard;
        if (unknownActionReplayGuard !== undefined) {
          if (unknownActionReplayGuard.recoveryKind === "desktop_surface_reconfirmed") {
            if (sameSurfaceRef(unknownActionReplayGuard.surfaceRef, surfaceRef) &&
                unknownActionReplayGuard.alternativeActionCompleted) {
              delete current.unknownActionReplayGuard;
            }
          } else if (!sameSurfaceRef(unknownActionReplayGuard.surfaceRef, surfaceRef) ||
              unknownActionReplayGuard.alternativeActionCompleted) {
            delete current.unknownActionReplayGuard;
          }
        }
        this.observations.set(String(observationId), {
          sessionId: String(session.id),
          captureSource: capture.source,
          surfaceRef,
          viewport: capture.viewport,
          ...(capture.cuaBounds === undefined ? {} : { cuaBounds: capture.cuaBounds }),
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
          // A refreshed frame can contradict the pending location-bar intent.
          // Keep the invalid intent until type refuses; never silently retarget
          // that text to the page control which acquired focus instead.
          if (this.browserChromeInput !== undefined && [...grounding.elements.values()].some((item) => item.element.source === "dom" && item.element.state?.focused === true)) {
            this.browserChromeInput = { ...this.browserChromeInput, invalidated: true };
          }
        } else if (!managedBrowserTargetForBinding(current, liveBinding)) {
          delete current.browserTarget;
        }
        this.latestObservationId = observationId;
        current.initialObservationPending = false;
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
          ...(authorizedSavedDocumentEvidenceStatus === undefined ? {} : {
            authorizedSavedDocumentEvidence: {
              source: "host-authorized-file-and-native-proof-v1",
              status: authorizedSavedDocumentEvidenceStatus,
              observationId,
              surfaceRef,
            },
          }),
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

  private async reconcileActiveTransientChild(
    current: PrivateSession,
    signal: AbortSignal,
    inventoryPidScope?: number,
  ): Promise<SurfaceRef | undefined> {
    signal.throwIfAborted();
    const ref = current.surfaceRegistry.activeSurface;
    if (ref === undefined || !isExecutableSurfaceRef(current.surfaceRegistry, ref)) {
      throw new WindowContractError("SURFACE_UNKNOWN", "active Surface is not executable");
    }
    const child = current.surfaceRegistry.surfaces.get(ref.surfaceId);
    if (child?.parentSurfaceId === undefined || (child.kind !== "overlay" && child.kind !== "native_window")) return undefined;
    const parent = current.surfaceRegistry.surfaces.get(child.parentSurfaceId);
    const parentRef = parent === undefined ? undefined : currentSurfaceRef(current.surfaceRegistry, parent.surfaceId);
    const parentNative = parentRef === undefined ? undefined : resolveNativeWindow(current.surfaceRegistry, parentRef);
    if (parent === undefined || parentRef === undefined || parentNative === undefined) {
      throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", "transient Surface parent identity is unavailable");
    }
    const parentTarget = asCuaWindowTarget(parentNative);
    if (child.kind === "native_window" && child.admissionSource === "macos_attached_sheet_proof") {
      if (current.platform !== "darwin" || this.options.windowDeliveryMode !== "foreground" ||
          this.options.windowSwitch !== "opened-windows-v1" || !isCurrentSurfaceRef(current.surfaceRegistry, parentRef)) {
        throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", "macOS attached-sheet lifecycle lost its authorized current parent context");
      }
      if (inventoryPidScope !== undefined && inventoryPidScope !== parentTarget.pid) {
        throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", "attached-sheet reconciliation PID scope does not match its exact parent");
      }
      const [inventory, parentBinding] = await Promise.all([
        listWindowInventory(current.driver, current.label, signal, inventoryPidScope, false, this.options.windowRelationshipProbe, current.platform),
        discoverWindow(current.driver, current.label, parentTarget, signal),
      ]);
      if (inventoryPidScope !== undefined && (!inventory.complete || inventory.truncated === true)) {
        throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", "incomplete parent-process inventory cannot prove that the exact Open sheet disappeared");
      }
      const storedParentBinding = current.windowBindings.get(windowIdentityKey(parentTarget));
      if (storedParentBinding === undefined || !sameWindowGeometry(parentBinding.bounds, storedParentBinding.bounds)) {
        throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", "the exact parent window geometry changed during attached-sheet reconciliation");
      }
      const childTarget = asCuaWindowTarget(child.nativeWindow);
      const childRows = inventory.windows.filter((window) => windowIdentityKey(window.target) === windowIdentityKey(childTarget));
      if (childRows.length > 1) {
        throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", "multiple inventory rows match the admitted macOS attached child");
      }
      const candidate = childRows.length === 1 ? childRows[0] : undefined;
      const grandparent = parent.parentSurfaceId === undefined ? undefined : current.surfaceRegistry.surfaces.get(parent.parentSurfaceId);
      const grandparentRef = grandparent === undefined ? undefined : currentSurfaceRef(current.surfaceRegistry, grandparent.surfaceId);
      const grandparentNative = grandparentRef === undefined ? undefined : resolveNativeWindow(current.surfaceRegistry, grandparentRef);
      const attached = await readMacAttachedSheetState(
        current.driver, current.label, parentBinding, candidate, signal,
        parent.kind === "native_window" && parent.admissionSource === "macos_attached_sheet_proof" && grandparentNative !== undefined
          ? asCuaWindowTarget(grandparentNative)
          : undefined,
      );
      if (attached.status === "sheet") {
        if (windowIdentityKey(asCuaWindowTarget(attached.evidence.nativeWindow)) !== windowIdentityKey(childTarget)) {
          throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", "a different or replacement AXSheet is active; the current child is retained for manual handling");
        }
        return undefined;
      }
      if (attached.status !== "none") {
        throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", attached.status === "unknown" ? attached.reason : "attached-sheet state is unknown");
      }
      const parentRows = inventory.windows.filter((window) => windowIdentityKey(window.target) === windowIdentityKey(parentTarget));
      const parentVisible = parentRows.length === 1 && parentRows[0]!.isOnScreen === true && parentRows[0]!.minimized !== true;
      const hasAnotherVisibleOwnedWindow = (rows: readonly CuaWindowInfo[]): boolean => rows.some((window) =>
        windowIdentityKey(window.target) !== windowIdentityKey(parentTarget) &&
        windowIdentityKey(window.target) !== windowIdentityKey(childTarget) &&
        window.ownerPid === parentTarget.pid && window.ownerWindowId === parentTarget.windowId &&
        window.isOnScreen === true && window.minimized !== true);
      if (!parentVisible || hasAnotherVisibleOwnedWindow(inventory.windows)) {
        throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", "fresh no-sheet AX proof did not coincide with an absent child and visible exact parent");
      }
      if (candidate !== undefined) {
        const storedChildBinding = current.windowBindings.get(windowIdentityKey(childTarget));
        const exactHiddenChild = candidate.isOnScreen === false && candidate.minimized !== true &&
          (candidate.ownerPid === undefined || candidate.ownerPid === parentTarget.pid) &&
          (candidate.ownerWindowId === undefined || candidate.ownerWindowId === parentTarget.windowId) &&
          storedChildBinding !== undefined && sameWindowGeometry(candidate.bounds, storedChildBinding.bounds);
        if (!exactHiddenChild || inventory.truncated === true) {
          throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", "the admitted child remains visible, ambiguous, or lacks exact hidden-window geometry evidence");
        }

        const initialRef = { ...ref };
        const initialParentRef = { ...parentRef };
        const initialRootRef = grandparentRef === undefined ? undefined : { ...grandparentRef };
        const initialParentGeometry = { ...parentBinding.bounds };
        const stillSameStack = (): boolean => {
          const activeNow = current.surfaceRegistry.activeSurface;
          const activeChild = current.surfaceRegistry.surfaces.get(initialRef.surfaceId);
          const parentNow = current.surfaceRegistry.surfaces.get(initialParentRef.surfaceId);
          const rootNow = initialRootRef === undefined
            ? undefined
            : current.surfaceRegistry.surfaces.get(initialRootRef.surfaceId);
          return this.session === current && current.active &&
            sameSurfaceRef(initialRef, activeNow) && isCurrentSurfaceRef(current.surfaceRegistry, initialRef) &&
            isExecutableSurfaceRef(current.surfaceRegistry, initialRef) &&
            sameSurfaceRef(initialParentRef, currentSurfaceRef(current.surfaceRegistry, initialParentRef.surfaceId)) &&
            isCurrentSurfaceRef(current.surfaceRegistry, initialParentRef) && parentNow !== undefined &&
            activeChild?.kind === "native_window" && activeChild.admissionSource === "macos_attached_sheet_proof" &&
            activeChild.parentSurfaceId === initialParentRef.surfaceId &&
            (initialRootRef === undefined
              ? parentNow.parentSurfaceId === undefined
              : parentNow.parentSurfaceId === initialRootRef.surfaceId && rootNow !== undefined &&
                sameSurfaceRef(initialRootRef, currentSurfaceRef(current.surfaceRegistry, initialRootRef.surfaceId)) &&
                isCurrentSurfaceRef(current.surfaceRegistry, initialRootRef));
        };

        await waitWithAbort(80, signal);
        signal.throwIfAborted();
        if (!stillSameStack()) {
          throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", "the attached-sheet stack changed during the bounded hidden-child recheck");
        }
        const [retryInventory, retryParentBinding] = await Promise.all([
          listWindowInventory(current.driver, current.label, signal, inventoryPidScope, false, this.options.windowRelationshipProbe, current.platform),
          discoverWindow(current.driver, current.label, parentTarget, signal),
        ]);
        const retryChildRows = retryInventory.windows.filter((window) => windowIdentityKey(window.target) === windowIdentityKey(childTarget));
        const retryParentRows = retryInventory.windows.filter((window) => windowIdentityKey(window.target) === windowIdentityKey(parentTarget));
        const retryCandidate = retryChildRows.length === 1 ? retryChildRows[0] : undefined;
        const retryParentRow = retryParentRows.length === 1 ? retryParentRows[0] : undefined;
        if (!stillSameStack() || windowIdentityKey(retryParentBinding.target) !== windowIdentityKey(parentTarget) ||
            retryInventory.truncated === true || inventoryPidScope !== undefined && !retryInventory.complete || retryChildRows.length !== 1 ||
            retryParentRows.length !== 1 || retryCandidate === undefined || retryCandidate.isOnScreen !== false ||
            retryCandidate.minimized === true ||
            (retryCandidate.ownerPid !== undefined && retryCandidate.ownerPid !== parentTarget.pid) ||
            (retryCandidate.ownerWindowId !== undefined && retryCandidate.ownerWindowId !== parentTarget.windowId) ||
            !sameWindowGeometry(retryCandidate.bounds, storedChildBinding!.bounds) ||
            retryParentRow?.isOnScreen !== true || retryParentRow.minimized === true ||
            hasAnotherVisibleOwnedWindow(retryInventory.windows) || !sameWindowGeometry(retryParentBinding.bounds, initialParentGeometry) ||
            !sameWindowGeometry(retryParentBinding.bounds, storedParentBinding.bounds)) {
          throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", "the exact hidden child, parent, or stack changed during the bounded recheck");
        }
        const retryAttached = await readMacAttachedSheetState(
          current.driver, current.label, retryParentBinding, retryCandidate, signal,
          parent.kind === "native_window" && parent.admissionSource === "macos_attached_sheet_proof" && grandparentNative !== undefined
            ? asCuaWindowTarget(grandparentNative)
            : undefined,
        );
        if (retryAttached.status !== "none" || !stillSameStack() ||
            !sameWindowGeometry(retryParentBinding.bounds, storedParentBinding.bounds)) {
          throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", retryAttached.status === "unknown"
            ? retryAttached.reason
            : "a fresh exact no-sheet proof did not remain stable through the bounded recheck");
        }
        signal.throwIfAborted();
        const currentParentBinding = current.windowBindings.get(windowIdentityKey(parentTarget));
        const currentChildBinding = current.windowBindings.get(windowIdentityKey(childTarget));
        if (!stillSameStack() || currentParentBinding === undefined || currentChildBinding === undefined ||
            !sameWindowGeometry(currentParentBinding.bounds, initialParentGeometry) ||
            !sameWindowGeometry(currentChildBinding.bounds, storedChildBinding.bounds)) {
          throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", "the exact attached-sheet binding changed before the verified pop");
        }
      }
      this.commitVerifiedChildPop(current, ref, parent.surfaceId, parentBinding);
      return undefined;
    }
    let childAbsent = false;
    if (child.kind === "overlay") {
      const verification = await verifySameHwndOverlay(current.driver, current.label, parentTarget, signal);
      if (verification.status === "unknown") {
        throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", verification.reason);
      }
      childAbsent = verification.status === "absent";
    } else {
      const childTarget = asCuaWindowTarget(child.nativeWindow);
      let inventory = await listWindowInventory(current.driver, current.label, signal, undefined, false, this.options.windowRelationshipProbe, current.platform);
      let candidate = inventory.windows.find((window) => windowIdentityKey(window.target) === windowIdentityKey(childTarget));
      if (this.options.windowDeliveryMode === "foreground" && candidate?.noActivate === true && candidate.isOnScreen === true && candidate.minimized !== true &&
          candidate.ownerPid === parentTarget.pid && candidate.ownerWindowId === parentTarget.windowId) {
        // Keep a known non-activating popup on its parent's visual/UIA path.
        // It may still be interactive; only its independent Surface is popped.
        childAbsent = true;
      } else {
      // Menus can retain their native HWND after ESC. A complete snapshot can
      // prove that the admitted interaction Surface is gone without claiming
      // that the OS destroyed the HWND. Never reuse Stage1 on this hidden row.
      let hiddenChild = candidate?.isOnScreen === false && candidate.minimized === false &&
        candidate.ownerPid === parentTarget.pid && candidate.ownerWindowId === parentTarget.windowId;
      const hasVisibleOwnedSibling = (): boolean => inventory.source === "win32_relationship_probe" && inventory.complete &&
        inventory.windows.some((window) => windowIdentityKey(window.target) !== windowIdentityKey(childTarget) &&
          windowIdentityKey(window.target) !== windowIdentityKey(parentTarget) &&
          window.ownerPid === parentTarget.pid && window.ownerWindowId === parentTarget.windowId &&
          window.isOnScreen === true && window.minimized !== true &&
          (candidate?.isOnScreen !== true || candidate.zIndex === undefined || window.zIndex === undefined ||
            window.zIndex >= candidate.zIndex));
      if (candidate?.isOnScreen === true && candidate.minimized !== true && hasVisibleOwnedSibling()) {
        // A completed menu action can asynchronously replace its menu HWND
        // with a sibling dialog. Wait briefly for the old child to become
        // explicitly hidden before classifying and capturing that sibling.
        for (const delayMs of TRANSIENT_RECOVERY_RECHECK_DELAYS_MS) {
          await this.waitForTransientRecoveryRecheck(delayMs, signal);
          inventory = await this.readCompleteWin32Inventory(current, signal);
          const childRows = inventory.windows.filter((window) => windowIdentityKey(window.target) === windowIdentityKey(childTarget));
          candidate = childRows.length === 1 ? childRows[0] : undefined;
          hiddenChild = candidate?.isOnScreen === false && candidate.minimized === false &&
            candidate.ownerPid === parentTarget.pid && candidate.ownerWindowId === parentTarget.windowId;
          if (candidate === undefined || hiddenChild || !hasVisibleOwnedSibling()) break;
        }
      }
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
              (window.ownerPid === undefined || window.ownerPid === parentTarget.pid) && window.isOnScreen !== false ||
            inventory.source === "win32_relationship_probe" && inventory.complete &&
              window.ownerPid === parentTarget.pid && window.ownerWindowId === parentTarget.windowId &&
              window.isOnScreen !== false));
        if (replacement) {
          const reconciled = await this.reconcileOwnedTransientChildReplacement(current, ref, inventory, signal);
          if (reconciled.decision === "recovered") return reconciled.surfaceRef;
          throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", "a replacement owned HWND did not pass exact root, capture, and fresh owner/stack verification; child state is retained for manual handling");
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
          const root = await verifyTransientNativeChildRoot(
            current.driver, current.label, parentTarget, candidate, inventory, inventory.complete,
            canVerifyExactTransientRoot(inventory), signal,
          );
          if (root.status === "verified") evidence = root.evidence;
          else if (root.status === "unavailable") evidence = win32RelationshipChildEvidence(parentTarget, candidate, inventory);
          else throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", root.reason);
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof WindowContractError) throw error;
          if (driverErrorDetails(error).tag === "Transport") {
            current.active = false;
            throw error;
          }
          evidence = win32RelationshipChildEvidence(parentTarget, candidate, inventory);
          if (evidence === undefined) {
            throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", "exact UIA root query failed and fresh Win32 owner/foreground/stack evidence was insufficient; child state is retained for manual handling");
          }
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
    }
    if (!childAbsent) return undefined;

    const parentBinding = await discoverWindow(current.driver, current.label, parentTarget, signal);
    this.commitVerifiedChildPop(current, ref, parent.surfaceId, parentBinding);
    return undefined;
  }

  /**
   * A native popup can already exist before the Run's first parent observation,
   * so no post-action window diff is available to admit it. Inspect only the
   * exact active Windows foreground root, and push only after a complete
   * Win32-owned stack, a positive exact Menu/Popup/Dialog root, one successful
   * child capture, and a fresh same-source revalidation.
   */
  private async admitExistingOwnedTransientChild(
    current: PrivateSession,
    signal: AbortSignal,
  ): Promise<CuaWindowCapture | undefined> {
    const parentRef = current.surfaceRegistry.activeSurface;
    if (current.platform !== "win32" || this.options.windowDeliveryMode !== "foreground" ||
        parentRef === undefined || !isExecutableSurfaceRef(current.surfaceRegistry, parentRef) ||
        sameSurfaceRef(current.lastInspectedExistingTransientRootRef, parentRef)) return undefined;
    const parentSurface = current.surfaceRegistry.surfaces.get(parentRef.surfaceId);
    if (parentSurface?.kind !== "native_window" || parentSurface.parentSurfaceId !== undefined) return undefined;
    const parentBinding = activeWindowBinding(current);
    if (parentBinding === undefined) return undefined;

    let inventory: CuaWindowInventory;
    try {
      inventory = await this.readCompleteWin32Inventory(current, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (driverErrorDetails(error).tag === "Transport") {
        current.active = false;
        throw error;
      }
      // An incomplete or unavailable snapshot does not prove that no child
      // exists, and must not permanently suppress a later complete check.
      return undefined;
    }
    if (!sameSurfaceRef(parentRef, current.surfaceRegistry.activeSurface) ||
        !isCurrentSurfaceRef(current.surfaceRegistry, parentRef) ||
        !isExecutableSurfaceRef(current.surfaceRegistry, parentRef)) return undefined;

    const parentRows = inventory.windows.filter((window) =>
      windowIdentityKey(window.target) === windowIdentityKey(parentBinding.target));
    if (parentRows.length !== 1) return undefined;
    const parentRow = parentRows[0]!;
    if (parentRow.isOnScreen !== true || parentRow.minimized === true ||
        !sameWindowGeometry(parentRow.bounds, parentBinding.bounds)) return undefined;

    const exactOwnedVisible = inventory.windows.filter((window) =>
      windowIdentityKey(window.target) !== windowIdentityKey(parentBinding.target) &&
      window.ownerPid === parentBinding.target.pid && window.ownerWindowId === parentBinding.target.windowId &&
      window.isOnScreen === true && window.minimized !== true);
    const stageOneCandidates = exactOwnedVisible.filter((candidate) => assessOwnedTransientWindowAdmission({
      parent: parentBinding.target,
      candidate,
      inventory,
      surfacedWindowCount: 1,
      baselineComplete: inventory.complete,
      baselineTruncated: inventory.truncated === true,
      parentSurfaceCurrent: isCurrentSurfaceRef(current.surfaceRegistry, parentRef),
    }).decision === "admitted");
    if (stageOneCandidates.length !== 1) {
      this.markExistingTransientRootInspected(current, parentRef);
      return undefined;
    }

    const candidate = stageOneCandidates[0]!;
    let root: TransientRootVerification;
    try {
      root = await verifyTransientNativeChildRoot(
        current.driver,
        current.label,
        parentBinding.target,
        candidate,
        inventory,
        true,
        canVerifyExactTransientRoot(inventory),
        signal,
      );
    } catch (error) {
      signal.throwIfAborted();
      if (driverErrorDetails(error).tag === "Transport") current.active = false;
      if (driverErrorDetails(error).tag === "Transport") throw error;
      // UIA is not a universal requirement for every application's child
      // HWND. A failed exact-root read is weak evidence only; the fresh native
      // foreground relationship below may still independently prove an
      // interactive child, otherwise the verified parent remains usable.
      root = { status: "unavailable", queryFailed: true };
    }
    if (root.status === "contradictory") {
      throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", `${root.reason}; confirm or close the owned transient before continuing`);
    }
    if (root.status === "unavailable" && root.queryFailed !== true && root.rootRole === "window" &&
        hasExactOwnedAuxiliaryStackEvidence(parentBinding.target, candidate, inventory)) {
      this.markExistingTransientRootInspected(current, parentRef);
      return undefined;
    }
    let childEvidence: Extract<TransientChildEvidence, { readonly kind: "native_window" }>;
    const requiresFreshForegroundProof = root.status === "unavailable";
    if (root.status === "verified") {
      childEvidence = root.evidence;
    } else {
      // Exact owner/z-order alone is not proof of a blocking child. Keep the
      // already-verified parent active unless Win32 independently confirms
      // that this exact owned HWND is actually foreground. This avoids both
      // false modal locks and app/class/title heuristics.
      const relationshipEvidence = win32RelationshipChildEvidence(parentBinding.target, candidate, inventory);
      if (relationshipEvidence === undefined) {
        this.markExistingTransientRootInspected(current, parentRef);
        return undefined;
      }
      childEvidence = relationshipEvidence;
    }

    let capture: CuaWindowCapture;
    try {
      capture = await captureWindowWithRetry(
        current.driver,
        current.label,
        candidate.target,
        signal,
        this.windowCaptureRetryOptions,
        resolveCapturePlatform(this.options.platform, current.platform),
      );
      signal.throwIfAborted();
    } catch (error) {
      signal.throwIfAborted();
      if (driverErrorDetails(error).tag === "Transport") current.active = false;
      throw new WindowContractError(
        "TRANSIENT_SURFACE_UNKNOWN",
        "an interactive owned transient was verified, but its exact window capture failed; confirm or close it before continuing",
      );
    }

    let freshInventory: CuaWindowInventory;
    try {
      freshInventory = await this.readCompleteWin32Inventory(current, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (driverErrorDetails(error).tag === "Transport") current.active = false;
      throw new WindowContractError(
        "TRANSIENT_SURFACE_UNKNOWN",
        "an interactive owned transient was verified and captured, but fresh Win32 revalidation failed; confirm or close it before continuing",
      );
    }
    const freshParentRows = freshInventory.windows.filter((window) =>
      windowIdentityKey(window.target) === windowIdentityKey(parentBinding.target));
    const freshCandidateRows = freshInventory.windows.filter((window) =>
      windowIdentityKey(window.target) === windowIdentityKey(candidate.target));
    const freshParent = freshParentRows[0];
    const freshCandidate = freshCandidateRows[0];
    const stillCurrent = sameSurfaceRef(parentRef, current.surfaceRegistry.activeSurface) &&
      isCurrentSurfaceRef(current.surfaceRegistry, parentRef) &&
      isExecutableSurfaceRef(current.surfaceRegistry, parentRef);
    const freshStageOne = freshCandidate === undefined ? undefined : assessOwnedTransientWindowAdmission({
      parent: parentBinding.target,
      candidate: freshCandidate,
      inventory: freshInventory,
      surfacedWindowCount: 1,
      baselineComplete: freshInventory.complete,
      baselineTruncated: freshInventory.truncated === true,
      parentSurfaceCurrent: stillCurrent,
    });
    const freshForegroundEvidence = requiresFreshForegroundProof && freshCandidate !== undefined
      ? win32RelationshipChildEvidence(parentBinding.target, freshCandidate, freshInventory)
      : undefined;
    if (!stillCurrent || freshParentRows.length !== 1 || freshCandidateRows.length !== 1 ||
        freshParent?.isOnScreen !== true || freshParent.minimized === true ||
        !sameWindowGeometry(freshParent.bounds, parentBinding.bounds) ||
        freshCandidate?.isOnScreen !== true || freshCandidate.minimized === true ||
        freshCandidate.ownerPid !== parentBinding.target.pid ||
        freshCandidate.ownerWindowId !== parentBinding.target.windowId ||
        !sameWindowGeometry(freshCandidate.bounds, capture.binding.bounds) ||
        freshStageOne?.decision !== "admitted" ||
        (requiresFreshForegroundProof && freshForegroundEvidence === undefined)) {
      throw new WindowContractError(
        "TRANSIENT_SURFACE_UNKNOWN",
        "an interactive owned transient changed or became ambiguous during capture; confirm or close it before continuing",
      );
    }

    const pushed = pushChild(current.surfaceRegistry, parentRef, childEvidence);
    if (pushed.decision !== "applied") {
      throw new WindowContractError(
        "TRANSIENT_SURFACE_UNKNOWN",
        `${pushed.reason}; confirm or close the owned transient before continuing`,
      );
    }
    current.surfaceRegistry = pushed.state;
    current.windowBindings.set(windowIdentityKey(capture.binding.target), capture.binding);
    current.windowRefs.clear();
    this.clearTargetObservationState(current, parentRef);
    delete current.lastInspectedExistingTransientRootRef;
    // This successful root transition is the observation's primary fact even
    // if an earlier geometry check queued a less specific transition reason.
    current.pendingSurfaceTransitionReason = "child_push";
    return capture;
  }

  private markExistingTransientRootInspected(current: PrivateSession, ref: SurfaceRef): void {
    if (isCurrentSurfaceRef(current.surfaceRegistry, ref)) {
      current.lastInspectedExistingTransientRootRef = { ...ref };
    }
  }

  private commitVerifiedChildPop(
    current: PrivateSession,
    childRef: SurfaceRef,
    parentSurfaceId: SurfaceRef["surfaceId"],
    parentBinding: CuaWindowBinding,
  ): SurfaceRef {
    const child = current.surfaceRegistry.surfaces.get(childRef.surfaceId);
    const parentRef = currentSurfaceRef(current.surfaceRegistry, parentSurfaceId);
    if (child === undefined || parentRef === undefined) {
      throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", "the exact child or parent Surface is unavailable for pop");
    }
    const popped = popChild(current.surfaceRegistry, childRef, {
      parent: parentRef,
      parentRevalidated: true,
      childAbsent: true,
    });
    if (popped.decision !== "applied") {
      throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", popped.reason);
    }
    current.surfaceRegistry = popped.state;
    noteSurfaceTransition(current, "child_pop");
    delete current.lastInspectedExistingTransientRootRef;
    current.windowRefs.clear();
    this.clearTargetObservationState(current, childRef, parentRef);
    current.windowBindings.set(windowIdentityKey(parentBinding.target), parentBinding);
    if (child.kind === "native_window") current.windowBindings.delete(windowIdentityKey(asCuaWindowTarget(child.nativeWindow)));
    return popped.value;
  }

  private async readCompleteWin32Inventory(current: PrivateSession, signal: AbortSignal): Promise<CuaWindowInventory> {
    const probe = this.options.windowRelationshipProbe;
    if (probe === undefined) {
      throw new WindowContractError("WINDOW_INVENTORY_UNKNOWN", "safe transient recovery requires a Win32 relationship probe");
    }
    const cua = await listWindowInventory(current.driver, current.label, signal, undefined, false, undefined, current.platform);
    signal.throwIfAborted();
    const snapshot = await probe.read(signal);
    signal.throwIfAborted();
    const inventory = mergeWindowRelationshipInventory(cua, snapshot, false);
    if (inventory.source !== "win32_relationship_probe" || !inventory.complete || inventory.truncated === true) {
      throw new WindowContractError("WINDOW_INVENTORY_UNKNOWN", "safe transient recovery requires one complete, untruncated Win32 snapshot");
    }
    return inventory;
  }

  private async waitForTransientRecoveryRecheck(delayMs: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const testDelay = this.options.windowCaptureRetry?.delay;
    if (testDelay === undefined) await waitWithAbort(delayMs, signal);
    else await testDelay(delayMs, signal);
    signal.throwIfAborted();
  }

  private restoredParentFromCompleteInventory(
    current: PrivateSession,
    childRef: SurfaceRef,
    inventory: CuaWindowInventory,
  ): { readonly parentSurfaceId: SurfaceRef["surfaceId"]; readonly parentTarget: CuaWindowTarget; readonly parentBounds: CuaWindowGeometry } | undefined {
    if (inventory.source !== "win32_relationship_probe" || !inventory.complete || inventory.truncated === true ||
        !sameSurfaceRef(childRef, current.surfaceRegistry.activeSurface)) return undefined;
    const child = current.surfaceRegistry.surfaces.get(childRef.surfaceId);
    if (child?.kind !== "native_window" || child.parentSurfaceId === undefined) return undefined;
    const parent = current.surfaceRegistry.surfaces.get(child.parentSurfaceId);
    if (parent?.kind !== "native_window" || parent.status === "closed" || parent.status === "unknown") return undefined;
    const parentTarget = asCuaWindowTarget(parent.nativeWindow);
    const childTarget = asCuaWindowTarget(child.nativeWindow);
    const parentBinding = current.windowBindings.get(windowIdentityKey(parentTarget));
    if (parentBinding === undefined) return undefined;
    const parentRows = inventory.windows.filter((window) => windowIdentityKey(window.target) === windowIdentityKey(parentTarget));
    const childRows = inventory.windows.filter((window) => windowIdentityKey(window.target) === windowIdentityKey(childTarget));
    if (parentRows.length !== 1 || childRows.length > 1) return undefined;
    const parentRow = parentRows[0]!;
    if (parentRow.isOnScreen !== true || parentRow.minimized === true ||
        inventory.foregroundPid !== parentTarget.pid || inventory.foregroundWindowId !== parentTarget.windowId ||
        !sameWindowGeometry(parentRow.bounds, parentBinding.bounds)) return undefined;
    const childRow = childRows[0];
    if (childRow !== undefined && (childRow.isOnScreen !== false || childRow.minimized !== false ||
        childRow.ownerPid !== parentTarget.pid || childRow.ownerWindowId !== parentTarget.windowId)) return undefined;
    const replacement = inventory.windows.some((window) => {
      if (windowIdentityKey(window.target) === windowIdentityKey(childTarget)) return false;
      if (this.options.windowDeliveryMode === "foreground" && window.noActivate === true) return false;
      if (window.target.windowId === childTarget.windowId) return true;
      return window.ownerPid === parentTarget.pid && window.ownerWindowId === parentTarget.windowId &&
        window.isOnScreen !== false && window.minimized !== true;
    });
    return replacement ? undefined : { parentSurfaceId: parent.surfaceId, parentTarget, parentBounds: parentRow.bounds };
  }

  private async recoverClosedTransientChild(
    current: PrivateSession,
      childRef: SurfaceRef,
      signal: AbortSignal,
      suppliedInventory?: CuaWindowInventory,
  ): Promise<SurfaceRef | undefined> {
    const firstInventory = suppliedInventory ?? await this.readCompleteWin32Inventory(current, signal);
    const firstProof = this.restoredParentFromCompleteInventory(current, childRef, firstInventory);
    if (firstProof === undefined) return undefined;
    const firstParentCapture = await captureWindowWithRetry(
      current.driver,
      current.label,
      firstProof.parentTarget,
      signal,
      this.windowCaptureRetryOptions,
      resolveCapturePlatform(this.options.platform, current.platform),
    );
    if (!sameWindowGeometry(firstParentCapture.binding.bounds, firstProof.parentBounds)) return undefined;
    const currentInventory = await this.readCompleteWin32Inventory(current, signal);
    const currentProof = this.restoredParentFromCompleteInventory(current, childRef, currentInventory);
    if (currentProof === undefined || currentProof.parentSurfaceId !== firstProof.parentSurfaceId ||
        windowIdentityKey(currentProof.parentTarget) !== windowIdentityKey(firstProof.parentTarget) ||
        !sameWindowGeometry(firstParentCapture.binding.bounds, currentProof.parentBounds)) return undefined;
    return this.commitVerifiedChildPop(current, childRef, currentProof.parentSurfaceId, firstParentCapture.binding);
  }

  private async recoverUnknownTransientActionReceipt(
    current: PrivateSession,
    action: ActionIntent,
    childRef: SurfaceRef,
    signal: AbortSignal,
  ): Promise<ActionReceipt | undefined> {
    try {
      for (let attempt = 0; attempt <= TRANSIENT_RECOVERY_RECHECK_DELAYS_MS.length; attempt += 1) {
        signal.throwIfAborted();
        let inventory: CuaWindowInventory;
        try {
          inventory = await this.readCompleteWin32Inventory(current, signal);
        } catch (error) {
          signal.throwIfAborted();
          if (driverErrorDetails(error).tag === "Transport") {
            current.active = false;
            throw error;
          }
          return undefined;
        }

        const replacement = await this.reconcileOwnedTransientChildReplacement(current, childRef, inventory, signal);
        if (replacement.decision === "recovered") {
          this.rememberUnknownActionPrimitive(current, action, childRef);
          return {
            actionId: action.actionId,
            status: "partial",
            driverCode: "CUA_TRANSIENT_ACTION_OUTCOME_UNKNOWN",
            message: "The action outcome is unknown. A different exact-owned transient Surface was freshly verified and captured; do not repeat the action, and make a new decision from the current dialog.",
            safeRecovery: { kind: "transient_owned_surface_reconciled", surfaceRef: replacement.surfaceRef },
          };
        }
        // A hidden menu can precede its owned dialog by a short asynchronous
        // gap. Prefer bounded sibling checks before taking the legacy parent
        // route, so an empty intermediate inventory cannot outrun the modal.
        if (replacement.decision === "stop" || attempt >= TRANSIENT_RECOVERY_RECHECK_DELAYS_MS.length) {
          const restoredParent = await this.recoverClosedTransientChild(current, childRef, signal, inventory);
          if (restoredParent === undefined) return undefined;
          this.rememberUnknownActionPrimitive(current, action, childRef);
          return {
            actionId: action.actionId,
            status: "partial",
            driverCode: "CUA_TRANSIENT_ACTION_OUTCOME_UNKNOWN",
            message: "The action outcome is unknown. The transient window closed and its exact parent was freshly captured. Do not repeat this action; inspect the refreshed screen and choose the next step.",
            safeRecovery: { kind: "transient_parent_restored", surfaceRef: restoredParent },
          };
        }
        await this.waitForTransientRecoveryRecheck(TRANSIENT_RECOVERY_RECHECK_DELAYS_MS[attempt]!, signal);
      }
      return undefined;
    } catch (error) {
      signal.throwIfAborted();
      if (driverErrorDetails(error).tag === "Transport") current.active = false;
      if (driverErrorDetails(error).tag === "Transport") throw error;
      return undefined;
    }
  }

  private async reconfirmNativeSurfaceAfterUnknownAction(
    current: PrivateSession,
    expectedSurfaceRef: SurfaceRef,
    signal: AbortSignal,
  ): Promise<SurfaceRef | undefined> {
    if (current.platform !== "win32" || this.options.windowDeliveryMode !== "foreground" ||
        expectedSurfaceRef.kind !== "native_window" || current.preActionWindowBaseline === undefined) return undefined;
    current.unknownActionReconciliationPending = true;
    delete current.unknownActionReconfirmedSurfaceRef;
    try {
      const candidates = await this.detectNewWindowHandoffCandidates(current.descriptor, signal);
      if (candidates.length !== 0) return undefined;
      const confirmed = current.unknownActionReconfirmedSurfaceRef;
      return confirmed !== undefined && sameSurfaceRef(confirmed, expectedSurfaceRef)
        ? confirmed
        : undefined;
    } catch (error) {
      signal.throwIfAborted();
      if (driverErrorDetails(error).tag === "Transport") current.active = false;
      return undefined;
    } finally {
      current.unknownActionReconciliationPending = false;
      delete current.unknownActionReconfirmedSurfaceRef;
    }
  }

  private async unknownForegroundActionReceipt(
    current: PrivateSession,
    action: ActionIntent,
    actionSurfaceRef: SurfaceRef,
    request: { readonly name: string; readonly arguments: Record<string, unknown> },
    actionWindowBinding: CuaWindowBinding | undefined,
    signal: AbortSignal,
  ): Promise<ActionReceipt> {
    signal.throwIfAborted();
    const desktopSurfaceReconfirmed = this.isExactPrimaryDesktopAction(current, actionSurfaceRef, request, actionWindowBinding);
    this.rememberUnknownActionPrimitive(
      current,
      action,
      actionSurfaceRef,
      desktopSurfaceReconfirmed ? "desktop_surface_reconfirmed" : undefined,
    );
    if (desktopSurfaceReconfirmed && this.canSettleLocalWindowsDesktopObservation(current)) {
      current.pendingPostGuiActionObservationAt = performance.now();
    }
    const safeSurfaceRef = desktopSurfaceReconfirmed
      ? undefined
      : await this.reconfirmNativeSurfaceAfterUnknownAction(current, actionSurfaceRef, signal);
    return {
      actionId: action.actionId,
      status: "partial",
      driverCode: "ACTION_OUTCOME_UNKNOWN",
      message: "CUA could not confirm the foreground after dispatch; input may have been sent. The action outcome is unknown. Do not repeat this action; inspect a fresh screen and choose a different GUI action.",
      ...(desktopSurfaceReconfirmed
        ? { safeRecovery: { kind: "desktop_surface_reconfirmed" as const, surfaceRef: { ...actionSurfaceRef } } }
        : safeSurfaceRef === undefined
          ? {}
          : { safeRecovery: { kind: "native_surface_reconfirmed" as const, surfaceRef: safeSurfaceRef } }),
    };
  }

  private isExactPrimaryDesktopAction(
    current: PrivateSession,
    actionSurfaceRef: SurfaceRef,
    request: { readonly name: string; readonly arguments: Record<string, unknown> },
    actionWindowBinding: CuaWindowBinding | undefined,
  ): boolean {
    const activeRef = current.surfaceRegistry.activeSurface;
    const surface = activeSurface(current);
    return current.active && this.session === current && actionWindowBinding === undefined &&
      isPrimaryDesktopForegroundActionRequest(request, current.label) &&
      activeRef?.kind === "desktop" && sameSurfaceRef(activeRef, actionSurfaceRef) &&
      surface?.kind === "desktop" && resolveDisplayId(current.surfaceRegistry, activeRef) === PRIMARY_DESKTOP.display_id &&
      isExecutableSurfaceRef(current.surfaceRegistry, actionSurfaceRef);
  }

  private canSettleLocalWindowsDesktopObservation(current: PrivateSession): boolean {
    return resolveCapturePlatform(this.options.platform, current.platform) === "win32" &&
      isLocalWindowsNamedPipeSocket(this.options.socketPath);
  }

  private rememberUnknownActionPrimitive(
    current: PrivateSession,
    action: ActionIntent,
    surfaceRef: SurfaceRef,
    recoveryKind?: "desktop_surface_reconfirmed",
  ): void {
    const primitiveFingerprint = actionPrimitiveFingerprint(action);
    const activeGuard = current.unknownActionReplayGuard;
    if (activeGuard !== undefined && sameSurfaceRef(activeGuard.surfaceRef, surfaceRef)) {
      activeGuard.primitiveFingerprints.add(primitiveFingerprint);
      activeGuard.alternativeActionCompleted = false;
      return;
    }
    current.unknownActionReplayGuard = {
      surfaceRef: { ...surfaceRef },
      primitiveFingerprints: new Set([primitiveFingerprint]),
      ...(recoveryKind === undefined ? {} : { recoveryKind }),
      alternativeActionCompleted: false,
    };
  }

  /**
   * Reconcile an unknown child action only when the previous exact-owned child
   * is proven hidden/absent and one new same-owner native transient is the
   * unique highest owned window with a positive Menu/Popup/Dialog root. The
   * click itself is never replayed.
   */
  private async reconcileOwnedTransientChildReplacement(
    current: PrivateSession,
    oldChildRef: SurfaceRef,
    inventory: CuaWindowInventory,
    signal: AbortSignal,
  ): Promise<UnknownTransientReplacementAttempt> {
    if (current.platform !== "win32" || this.options.windowDeliveryMode !== "foreground" ||
        inventory.source !== "win32_relationship_probe" || !inventory.complete || inventory.truncated === true ||
        !sameSurfaceRef(oldChildRef, current.surfaceRegistry.activeSurface) ||
        !isExecutableSurfaceRef(current.surfaceRegistry, oldChildRef)) return { decision: "stop" };
    const oldChild = current.surfaceRegistry.surfaces.get(oldChildRef.surfaceId);
    if (oldChild?.kind !== "native_window" || oldChild.parentSurfaceId === undefined) return { decision: "stop" };
    const parent = current.surfaceRegistry.surfaces.get(oldChild.parentSurfaceId);
    const parentRef = currentSurfaceRef(current.surfaceRegistry, oldChild.parentSurfaceId);
    if (parent?.kind !== "native_window" || parentRef === undefined || parent.status === "closed" || parent.status === "unknown") {
      return { decision: "stop" };
    }
    const parentTarget = asCuaWindowTarget(parent.nativeWindow);
    const oldChildTarget = asCuaWindowTarget(oldChild.nativeWindow);
    const parentBinding = current.windowBindings.get(windowIdentityKey(parentTarget));
    if (parentBinding === undefined) return { decision: "stop" };

    const parentRows = inventory.windows.filter((window) => windowIdentityKey(window.target) === windowIdentityKey(parentTarget));
    const oldChildRows = inventory.windows.filter((window) => windowIdentityKey(window.target) === windowIdentityKey(oldChildTarget));
    if (parentRows.length !== 1 || oldChildRows.length > 1) return { decision: "retry" };
    const parentRow = parentRows[0]!;
    if (parentRow.isOnScreen !== true || parentRow.minimized === true ||
        !sameWindowGeometry(parentRow.bounds, parentBinding.bounds)) return { decision: "retry" };
    const oldChildRow = oldChildRows[0];
    if (oldChildRow !== undefined && oldChildRow.isOnScreen === true && oldChildRow.minimized !== true) {
      // This is the expected asynchronous transition after some native menu
      // commands. Wait for fresh read-only evidence; never resend the click.
      return { decision: "retry" };
    }
    if (oldChildRow !== undefined && (oldChildRow.isOnScreen !== false || oldChildRow.minimized !== false ||
        oldChildRow.ownerPid !== parentTarget.pid || oldChildRow.ownerWindowId !== parentTarget.windowId)) {
      return { decision: "stop" };
    }

    const ownedVisible = inventory.windows.filter((window) =>
      windowIdentityKey(window.target) !== windowIdentityKey(parentTarget) &&
      windowIdentityKey(window.target) !== windowIdentityKey(oldChildTarget) &&
      window.ownerPid === parentTarget.pid && window.ownerWindowId === parentTarget.windowId &&
      window.isOnScreen === true && window.minimized !== true);
    if (ownedVisible.length === 0) return { decision: "retry" };
    const candidates = ownedVisible.filter((candidate) => assessOwnedTransientWindowAdmission({
      parent: parentTarget,
      candidate,
      inventory,
      surfacedWindowCount: 1,
      baselineComplete: true,
      baselineTruncated: false,
      parentSurfaceCurrent: isCurrentSurfaceRef(current.surfaceRegistry, parentRef),
    }).decision === "admitted");
    if (candidates.length === 0 && ownedVisible.some((window) => window.noActivate === true)) {
      const restoredParent = this.restoredParentFromCompleteInventory(current, oldChildRef, inventory);
      if (restoredParent !== undefined) {
        this.commitVerifiedChildPop(current, oldChildRef, restoredParent.parentSurfaceId, {
          target: restoredParent.parentTarget,
          bounds: restoredParent.parentBounds,
        });
        const activeParentRef = current.surfaceRegistry.activeSurface;
        if (activeParentRef === undefined || activeParentRef.surfaceId !== restoredParent.parentSurfaceId ||
            !isExecutableSurfaceRef(current.surfaceRegistry, activeParentRef)) {
          throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", "the verified parent was not active after popping a non-activating popup");
        }
        return { decision: "recovered", surfaceRef: activeParentRef };
      }
    }
    if (candidates.length !== 1) return { decision: "stop" };
    const candidate = candidates[0]!;
    const foregroundIsInOwnerPair =
      inventory.foregroundPid === parentTarget.pid && inventory.foregroundWindowId === parentTarget.windowId ||
      inventory.foregroundPid === candidate.target.pid && inventory.foregroundWindowId === candidate.target.windowId;
    if (!foregroundIsInOwnerPair) return { decision: "stop" };

    let root: TransientRootVerification;
    try {
      root = await verifyTransientNativeChildRoot(
        current.driver, current.label, parentTarget, candidate, inventory, true,
        canVerifyExactTransientRoot(inventory), signal,
      );
    } catch (error) {
      signal.throwIfAborted();
      if (driverErrorDetails(error).tag === "Transport") {
        current.active = false;
        throw error;
      }
      return { decision: "stop" };
    }
    if (root.status !== "verified") return { decision: "stop" };

    let capture: CuaWindowCapture;
    try {
      capture = await captureWindowWithRetry(
        current.driver,
        current.label,
        candidate.target,
        signal,
        this.windowCaptureRetryOptions,
        resolveCapturePlatform(this.options.platform, current.platform),
      );
      signal.throwIfAborted();
    } catch (error) {
      signal.throwIfAborted();
      if (driverErrorDetails(error).tag === "Transport") {
        current.active = false;
        throw error;
      }
      return { decision: "stop" };
    }

    let freshInventory: CuaWindowInventory;
    try {
      freshInventory = await this.readCompleteWin32Inventory(current, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (driverErrorDetails(error).tag === "Transport") {
        current.active = false;
        throw error;
      }
      return { decision: "retry" };
    }
    const freshParentRows = freshInventory.windows.filter((window) => windowIdentityKey(window.target) === windowIdentityKey(parentTarget));
    const freshOldChildRows = freshInventory.windows.filter((window) => windowIdentityKey(window.target) === windowIdentityKey(oldChildTarget));
    const freshCandidateRows = freshInventory.windows.filter((window) => windowIdentityKey(window.target) === windowIdentityKey(candidate.target));
    const freshParent = freshParentRows[0];
    const freshOldChild = freshOldChildRows[0];
    const freshCandidate = freshCandidateRows[0];
    const oldChildStillHidden = freshOldChildRows.length === 0 || freshOldChild !== undefined &&
      freshOldChild.isOnScreen === false && freshOldChild.minimized === false &&
      freshOldChild.ownerPid === parentTarget.pid && freshOldChild.ownerWindowId === parentTarget.windowId;
    const stillCurrent = sameSurfaceRef(oldChildRef, current.surfaceRegistry.activeSurface) &&
      isCurrentSurfaceRef(current.surfaceRegistry, oldChildRef) && isExecutableSurfaceRef(current.surfaceRegistry, oldChildRef) &&
      isCurrentSurfaceRef(current.surfaceRegistry, parentRef);
    const freshForegroundInOwnerPair =
      freshInventory.foregroundPid === parentTarget.pid && freshInventory.foregroundWindowId === parentTarget.windowId ||
      freshInventory.foregroundPid === candidate.target.pid && freshInventory.foregroundWindowId === candidate.target.windowId;
    const freshStageOne = freshCandidate === undefined ? undefined : assessOwnedTransientWindowAdmission({
      parent: parentTarget,
      candidate: freshCandidate,
      inventory: freshInventory,
      surfacedWindowCount: 1,
      baselineComplete: freshInventory.complete,
      baselineTruncated: freshInventory.truncated === true,
      parentSurfaceCurrent: isCurrentSurfaceRef(current.surfaceRegistry, parentRef),
    });
    if (!stillCurrent || freshInventory.source !== "win32_relationship_probe" || !freshInventory.complete ||
        freshInventory.truncated === true || !freshForegroundInOwnerPair || !oldChildStillHidden ||
        freshParentRows.length !== 1 || freshParent?.isOnScreen !== true || freshParent.minimized === true ||
        !sameWindowGeometry(freshParent.bounds, parentBinding.bounds) || freshCandidateRows.length !== 1 ||
        freshCandidate?.isOnScreen !== true || freshCandidate.minimized === true ||
        freshCandidate.ownerPid !== parentTarget.pid || freshCandidate.ownerWindowId !== parentTarget.windowId ||
        !sameWindowGeometry(freshCandidate.bounds, capture.binding.bounds) || freshStageOne?.decision !== "admitted") {
      return { decision: "retry" };
    }
    let freshRoot: TransientRootVerification;
    try {
      freshRoot = await verifyTransientNativeChildRoot(
        current.driver, current.label, parentTarget, freshCandidate, freshInventory, true,
        canVerifyExactTransientRoot(freshInventory), signal,
      );
    } catch (error) {
      signal.throwIfAborted();
      if (driverErrorDetails(error).tag === "Transport") {
        current.active = false;
        throw error;
      }
      return { decision: "stop" };
    }
    if (freshRoot.status !== "verified") return { decision: "stop" };

    signal.throwIfAborted();
    const parentBindingFresh = { target: parentTarget, bounds: freshParent!.bounds };
    this.commitVerifiedChildPop(current, oldChildRef, parent.surfaceId, parentBindingFresh);
    const activeParentRef = current.surfaceRegistry.activeSurface;
    if (activeParentRef === undefined || activeParentRef.surfaceId !== parent.surfaceId ||
        !isExecutableSurfaceRef(current.surfaceRegistry, activeParentRef)) {
      throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", "the verified parent was not active after popping the closed child");
    }
    const pushed = pushChild(current.surfaceRegistry, activeParentRef, freshRoot.evidence);
    if (pushed.decision !== "applied") {
      throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", `${pushed.reason}; the verified replacement transient was not activated`);
    }
    current.surfaceRegistry = pushed.state;
    current.windowBindings.set(windowIdentityKey(capture.binding.target), capture.binding);
    current.windowRefs.clear();
    delete current.lastInspectedExistingTransientRootRef;
    // Runtime sees the recovered sibling as the current modal decision surface;
    // the old action remains partial/unknown and is never replayed.
    current.pendingSurfaceTransitionReason = "child_push";
    return { decision: "recovered", surfaceRef: pushed.value };
  }

  private async restoreTransientParentAfterExplicitNoInput(
    current: PrivateSession,
    childRef: SurfaceRef,
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      return (await this.recoverClosedTransientChild(current, childRef, signal)) !== undefined;
    } catch (error) {
      if (driverErrorDetails(error).tag === "Transport") current.active = false;
      return false;
    }
  }

  public async listWindowHandoffCandidates(session: ComputerSessionDescriptor, signal: AbortSignal): Promise<readonly ComputerWindowCandidate[]> {
    const current = this.requireSession(session);
    const missing = current.missingParent;
    if (missing?.confirming) throw new Error("window handoff confirmation is in flight");
    if (current.managedBrowserRestoreConfirming) throw new Error("managed browser restore confirmation is in flight");
    const epoch = missing === undefined ? undefined : ++missing.epoch;
    // Invalidate before I/O, including failed/aborted refreshes.
    missing?.candidates.clear();
    current.managedBrowserRestoreCandidates.clear();
    current.windowRefs.clear();
    const restoreTarget = this.eligibleCurrentManagedBrowserRestoreTarget(current);
    if (missing === undefined && restoreTarget !== undefined) {
      const inventory = await listWindowInventory(current.driver, current.label, signal, restoreTarget.pid, true,
        this.options.windowRelationshipProbe, current.platform);
      const matches = inventory.windows.filter((window) => windowIdentityKey(window.target) === windowIdentityKey(restoreTarget));
      if (matches.length !== 1 || matches[0]?.isOnScreen !== true || matches[0]?.minimized === true) return [];
      signal.throwIfAborted();
      if (this.eligibleCurrentManagedBrowserRestoreTarget(current) === undefined) return [];
      const handoffToken = randomUUID();
      const candidate: ComputerWindowCandidate = {
        ...restoreTarget,
        handoffToken,
        restoreCurrentManagedBrowser: true,
        appName: "Harness-managed browser",
        title: "Run-owned browser window",
      };
      current.managedBrowserRestoreCandidates.set(handoffToken, candidate);
      return [candidate];
    }
    if (!this.canUseManualWindowHandoff(current)) {
      throw new Error("window handoff is available only for an explicitly bound native window");
    }
    const inventory = await listWindowInventory(current.driver, current.label, signal, undefined, true, this.options.windowRelationshipProbe, current.platform);
    const windows = inventory.windows;
    const binding = activeWindowBinding(current);
    if (binding === undefined) throw new Error("window handoff requires the exact active native-window binding");
    const unauthorizedForeground = current.foregroundMismatchWindowId === undefined
      ? undefined
      : windows.find((window) => window.target.windowId === current.foregroundMismatchWindowId &&
        !targetAllowedByHostScope(window.target, this.options.windowSwitchAllowedTargets));
    const isUnscopedOwnedForegroundPeer = (window: CuaWindowInfo) => isFreshUnscopedOwnedForegroundPeer(
      window,
      binding.target,
      inventory,
      current.foregroundMismatchWindowId,
      this.options.windowDeliveryMode === "foreground",
    );
    if (unauthorizedForeground !== undefined && !isUnscopedOwnedForegroundPeer(unauthorizedForeground)) {
      throw new WindowContractError("WINDOW_SCOPE_REQUIRED", "the foreground window is outside the host-authorized window scope");
    }
    const candidatePool = windows
      .filter((window) => windowIdentityKey(window.target) !== windowIdentityKey(binding.target))
      .filter((window) => this.options.hybridNativeWebDocumentCapability === undefined ||
        (missing?.reason === "bound_window_missing"
          ? windowIdentityKey(window.target) === windowIdentityKey(this.options.hybridNativeWebDocumentCapability.recoveryTarget)
          : windowIdentityKey(window.target) !== windowIdentityKey(this.options.hybridNativeWebDocumentCapability.recoveryTarget)))
      .filter((window) => targetAllowedByHostScope(window.target, this.options.windowSwitchAllowedTargets) ||
        window.ownerPid === binding.target.pid && window.ownerWindowId === binding.target.windowId ||
        isUnscopedOwnedForegroundPeer(window))
      .filter((window) => !isRegisteredChildWindow(current, window.target))
      .filter((window) => isRelevantManualWindowCandidate(
        window,
        binding.target,
        current.foregroundMismatchWindowId === undefined
          ? undefined
          : { pid: binding.target.pid, windowId: current.foregroundMismatchWindowId },
        this.options.windowSwitchAllowedTargets,
        current.platform,
      ));
    const recoveryIdentity = missing?.reason === "bound_window_missing" ? current.recoveryWindowIdentity : undefined;
    const eligiblePool = recoveryIdentity === undefined ? candidatePool : candidatePool.filter((window) => samePinnedRecoveryIdentity(recoveryIdentity, window));
    const candidates = projectSelectableWindowCandidates(
      eligiblePool,
      binding.target,
      current.platform,
      undefined,
      (window) => this.options.windowDeliveryMode !== "foreground" || window.noActivate !== true,
      true,
    ).windows
      .map((window) => {
        const relationship = windowCandidateRelationship(
          window,
          binding.target,
          inventory,
          targetAllowedByHostScope(window.target, this.options.windowSwitchAllowedTargets),
        );
        return {
        pid: window.target.pid,
        windowId: window.target.windowId,
        ...(window.appName === undefined ? {} : { appName: window.appName }),
        ...(window.title === undefined ? {} : { title: window.title }),
        ...(relationship === undefined ? {} : { relationship }),
        };
      });
    signal.throwIfAborted();
    if (missing !== undefined) {
      if (current.missingParent !== missing || missing.epoch !== epoch || missing.confirming) throw new Error("window handoff boundary changed during refresh");
      return candidates.map((candidate) => {
        const issued = { ...candidate, handoffToken: randomUUID() };
        missing.candidates.set(issued.handoffToken, issued);
        return issued;
      });
    }
    const newlySurfacedKeys = new Set(current.newlySurfacedWindowKeys);
    if (current.visibleWindowBaseline !== undefined) {
      for (const window of windows) {
        const key = windowIdentityKey(window.target);
        if (!current.visibleWindowBaseline.has(key)) newlySurfacedKeys.add(key);
      }
    }
    current.newlySurfacedWindowKeys = newlySurfacedKeys;
    current.newHandoffCandidates = candidates.filter((candidate) => newlySurfacedKeys.has(windowIdentityKey(candidate)));
    return current.proactiveHandoffCandidatesReady ? current.newHandoffCandidates : candidates;
  }

  /**
   * Return the top-level windows CUA reports without its on-screen-only
   * filter, using opaque per-Run refs. Dispatch rechecks exact native identity;
   * desktop scope activates in place while native-window scope captures/rebinds.
   */
  public async listWindows(session: ComputerSessionDescriptor, signal: AbortSignal): Promise<ComputerWindowList> {
    const current = this.requireSession(session);
    current.windowRefs.clear();
    const previousFirstObservedAfterAction = current.firstObservedAfterActionWindows;
    current.firstObservedAfterActionWindows = undefined;
    if (this.options.windowSwitch !== "opened-windows-v1") {
      throw new WindowContractError("WINDOW_SWITCH_DISABLED", "cross-window switching is not enabled for this Run");
    }
    signal.throwIfAborted();
    if (current.missingParent !== undefined && current.taskWindowTransition !== undefined) {
      const { target } = await this.verifyTaskWindowTransition(current, signal);
      const candidate = current.taskWindowTransition.candidate;
      const peerRef = currentSurfaceRef(current.surfaceRegistry, candidate.surfaceRef.surfaceId);
      if (peerRef === undefined || !isCurrentSurfaceRef(current.surfaceRegistry, peerRef) ||
          isExecutableSurfaceRef(current.surfaceRegistry, peerRef) ||
          windowIdentityKey(candidate.target) !== windowIdentityKey(target.target)) {
        throw new WindowContractError("WINDOW_SWITCH_STALE", "fresh task-window list no longer matches the Run-owned peer Surface");
      }
      candidate.surfaceRef = peerRef;
      const windowRef = `win-${randomUUID()}`;
      current.windowRefs.set(windowRef, peerRef);
      return {
        options: [{ windowRef, ...(target.appName === undefined ? {} : { appName: target.appName }),
          ...(target.title === undefined ? {} : { title: target.title }), isCurrent: false,
          ...(target.isOnScreen === undefined ? {} : { isOnScreen: target.isOnScreen }),
          ...(target.minimized === undefined ? {} : { minimized: target.minimized }) }],
        truncated: false,
        omittedCount: 0,
      };
    }
    const inventory = await listWindowInventory(current.driver, current.label, signal, undefined, false, this.options.windowRelationshipProbe, current.platform);
    signal.throwIfAborted();
    const inventoryComplete = inventory.complete && inventory.truncated !== true;
    const actionBaseline = current.preActionWindowBaseline;
    const activeBinding = activeWindowBinding(current);
    const baselineStillBound = actionBaseline !== undefined && activeBinding !== undefined &&
      sameSurfaceRef(current.surfaceRegistry.activeSurface, actionBaseline.parentSurfaceRef) &&
      isCurrentSurfaceRef(current.surfaceRegistry, actionBaseline.parentSurfaceRef) &&
      isExecutableSurfaceRef(current.surfaceRegistry, actionBaseline.parentSurfaceRef) &&
      windowIdentityKey(activeBinding.target) === windowIdentityKey(actionBaseline.parentBinding.target);
    if (actionBaseline?.completed === true && baselineStillBound && inventoryComplete) {
      const firstObservedAfterActionKeys = inventory.windows
        .filter((window) => window.isOnScreen === true && !actionBaseline.targetKeys.has(windowIdentityKey(window.target)))
        .map((window) => windowIdentityKey(window.target));
      current.firstObservedAfterActionWindows = firstObservedAfterActionKeys.length > 0
        ? { actionId: actionBaseline.actionId, targetKeys: new Set(firstObservedAfterActionKeys) }
        : undefined;
    } else if (actionBaseline === undefined && previousFirstObservedAfterAction !== undefined && inventoryComplete) {
      const visibleKeys = new Set(inventory.windows
        .filter((window) => window.isOnScreen === true && previousFirstObservedAfterAction.targetKeys.has(windowIdentityKey(window.target)))
        .map((window) => windowIdentityKey(window.target)));
      current.firstObservedAfterActionWindows = visibleKeys.size > 0
        ? { actionId: previousFirstObservedAfterAction.actionId, targetKeys: visibleKeys }
        : undefined;
    } else {
      current.firstObservedAfterActionWindows = undefined;
    }
    const boundPeer = activePeerTarget(current);
    if (inventoryComplete && boundPeer !== undefined && !inventory.windows.some((window) => windowIdentityKey(window.target) === windowIdentityKey(boundPeer))) {
      const activeRef = current.surfaceRegistry.activeSurface;
      const preserveForFormalDetection = this.options.recoverBoundWindowMissing === true &&
        this.options.windowSwitch === "opened-windows-v1" &&
        this.options.windowDeliveryMode === "foreground" &&
        current.platform === "darwin" &&
        actionBaseline?.completed === true && baselineStillBound &&
        actionBaseline.parentSurfaceRef.parentSurfaceId === undefined &&
        this.canUseManualWindowHandoff(current);
      if (!preserveForFormalDetection) {
        if (activeRef !== undefined) {
          const invalidated = markSurfaceUnknown(current.surfaceRegistry, activeRef);
          if (invalidated.decision === "applied") current.surfaceRegistry = invalidated.state;
        }
        current.windowRefs.clear();
        this.clearTargetObservationState(current, activeRef);
      }
      throw new WindowContractError("WINDOW_TARGET_NOT_FOUND", "current bound window is missing from the opened-window inventory");
    }
    const childWindowKeys = new Set([...current.surfaceRegistry.surfaces.values()]
      .filter((surface): surface is Extract<SurfaceRecord, { readonly kind: "native_window" }> =>
        surface.kind === "native_window" && surface.parentSurfaceId !== undefined && surface.status !== "closed")
      .map((surface) => windowIdentityKey(asCuaWindowTarget(surface.nativeWindow))));
    const runOwnedTextEditWindowKeys = new Set(current.runOwnedTextEditWindows.keys());
    const isDesktopScope = activeSurface(current)?.kind === "desktop";
    const windows: CuaWindowInfo[] = [];
    for (const window of inventory.windows) {
      if (childWindowKeys.has(windowIdentityKey(window.target))) continue;
      // The Host recovery blank belongs only to the completed-close recovery
      // flow. Its presence in the recovery pair never grants ordinary switching.
      if (!this.isTargetSwitchAllowed(window.target)) continue;
      if (targetAllowedByHostScope(window.target, this.options.windowSwitchAllowedTargets) ||
          this.hasHybridCapability() && windowIdentityKey(window.target) === windowIdentityKey(this.options.hybridNativeWebDocumentCapability!.managedBrowserTarget.windowTarget)) {
        windows.push(window);
        continue;
      }
      if (runOwnedTextEditWindowKeys.has(windowIdentityKey(window.target))) continue;
    }
    // A valid Run-owned TextEdit peer is verified against its own complete
    // process inventory. Unrelated applications can make the desktop-wide
    // list partial without making this exact Run task window ambiguous.
    const scopedRunOwnedPids = new Set([...current.runOwnedTextEditWindows.values()]
      .filter((candidate) => !childWindowKeys.has(windowIdentityKey(candidate.target)) &&
        !targetAllowedByHostScope(candidate.target, this.options.windowSwitchAllowedTargets) &&
        !(this.hasHybridCapability() && windowIdentityKey(candidate.target) ===
          windowIdentityKey(this.options.hybridNativeWebDocumentCapability!.managedBrowserTarget.windowTarget)))
      .map((candidate) => candidate.target.pid));
    let runOwnedInventoryIncomplete = false;
    for (const pid of scopedRunOwnedPids) {
      const scopedInventory = await listWindowInventory(
        current.driver, current.label, signal, pid, false, this.options.windowRelationshipProbe, "darwin",
      );
      if (!scopedInventory.complete || scopedInventory.truncated === true) {
        runOwnedInventoryIncomplete = true;
        continue;
      }
      for (const candidate of current.runOwnedTextEditWindows.values()) {
        if (candidate.target.pid !== pid || childWindowKeys.has(windowIdentityKey(candidate.target)) ||
            targetAllowedByHostScope(candidate.target, this.options.windowSwitchAllowedTargets) ||
            this.hasHybridCapability() && windowIdentityKey(candidate.target) ===
              windowIdentityKey(this.options.hybridNativeWebDocumentCapability!.managedBrowserTarget.windowTarget)) continue;
        const verified = await this.verifyRunOwnedTextEditWindow(current, candidate, signal, scopedInventory);
        if (verified !== undefined) windows.push(verified);
      }
    }
    const inventoryForegroundTarget = isDesktopScope && inventory.foregroundPid !== undefined && inventory.foregroundWindowId !== undefined
      ? { pid: inventory.foregroundPid, windowId: inventory.foregroundWindowId }
      : undefined;
    const foregroundMatches = inventoryForegroundTarget === undefined
      ? []
      : windows.filter((window) => windowIdentityKey(window.target) === windowIdentityKey(inventoryForegroundTarget));
    const currentTarget = boundPeer ?? (foregroundMatches.length === 1 ? inventoryForegroundTarget : undefined);
    const currentKey = currentTarget === undefined ? undefined : windowIdentityKey(currentTarget);
    const projected = projectSelectableWindowCandidates(
      windows,
      currentTarget,
      current.platform,
      undefined,
      (window) => (isDesktopScope || this.options.windowDeliveryMode === "foreground")
        ? window.noActivate !== true
        : true,
      false,
      isDesktopScope ? (window) => isEligibleNativeOnlyDesktopCandidate(inventory, window) : undefined,
    );
    const options = projected.windows.map((window) => {
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
        ...(window.isOnScreen === undefined ? {} : { isOnScreen: window.isOnScreen }),
        ...(window.minimized === undefined ? {} : { minimized: window.minimized }),
        ...(window.isOnScreen === true && current.firstObservedAfterActionWindows?.targetKeys.has(windowIdentityKey(window.target)) === true
          ? { firstObservedAfterAction: true, sourceActionId: current.firstObservedAfterActionWindows.actionId }
          : {}),
      };
    }).filter((window): window is ComputerWindowOption => window !== undefined);
    const registrationOmissions = projected.windows.length - options.length;
    const omittedCount = projected.omittedCount + registrationOmissions;
    return {
      options,
      truncated: !inventoryComplete || runOwnedInventoryIncomplete || omittedCount > 0,
      omittedCount,
    };
  }

  public async listNewWindowHandoffCandidates(session: ComputerSessionDescriptor, signal: AbortSignal): Promise<readonly ComputerWindowCandidate[]> {
    const current = this.requireSession(session);
    signal.throwIfAborted();
    if (current.missingParent !== undefined) return []; // Missing is not proven-new or auto-selectable.
    if (current.proactiveHandoffCandidatesReady) return current.newHandoffCandidates;
    const foregroundWindowId = current.foregroundMismatchWindowId;
    if (foregroundWindowId === undefined) return [];
    return current.newHandoffCandidates.filter((candidate) => candidate.windowId === foregroundWindowId);
  }

  public async detectNewWindowHandoffCandidates(session: ComputerSessionDescriptor, signal: AbortSignal): Promise<readonly ComputerWindowCandidate[]> {
    const current = this.requireSession(session);
    current.firstObservedAfterActionWindows = undefined;
    signal.throwIfAborted();
    if (current.missingParent !== undefined && current.taskWindowTransition !== undefined) return [];
    if (current.missingParent !== undefined) throw new BoundWindowMissingError(current.missingParent.sourceActionId);
    const confirmingUnknownAction = current.unknownActionReconciliationPending === true;
    delete current.unknownActionReconfirmedSurfaceRef;
    const baseline = current.preActionWindowBaseline;
    const activeBeforeReconcile = current.surfaceRegistry.activeSurface;
    // Consume the one-shot pre-action authorization before any asynchronous
    // reconciliation or inventory/proof call; uncertain outcomes are not replayable.
    current.preActionWindowBaseline = undefined;
    // A key chord can open a second macOS sheet while the first verified sheet
    // is active. Reconcile that exact completed handoff before asking the
    // parent->first-sheet proof to pop: focus may already have moved to the new
    // direct child, so treating the old edge as absent would lose the stack.
    const activeSurface = activeBeforeReconcile === undefined
      ? undefined
      : current.surfaceRegistry.surfaces.get(activeBeforeReconcile.surfaceId);
    let completedOpenDocumentPid: number | undefined;
    if (activeBeforeReconcile !== undefined && baseline?.completed === true && activeSurface?.kind === "native_window" &&
        activeSurface.admissionSource === "macos_attached_sheet_proof" &&
        activeSurface.parentSurfaceId !== undefined &&
        sameSurfaceRef(activeBeforeReconcile, baseline.parentSurfaceRef) &&
        current.platform === "darwin" && this.options.windowDeliveryMode === "foreground" &&
        this.options.windowSwitch === "opened-windows-v1" && baseline.truncated !== true &&
        isCurrentSurfaceRef(current.surfaceRegistry, activeBeforeReconcile) &&
        isExecutableSurfaceRef(current.surfaceRegistry, activeBeforeReconcile)) {
      const activeBinding = activeWindowBinding(current);
      const rootSurface = current.surfaceRegistry.surfaces.get(activeSurface.parentSurfaceId);
      const rootRef = rootSurface === undefined
        ? undefined
        : currentSurfaceRef(current.surfaceRegistry, rootSurface.surfaceId);
      const rootNative = rootRef === undefined ? undefined : resolveNativeWindow(current.surfaceRegistry, rootRef);
      if (activeBinding === undefined || rootRef === undefined || rootNative === undefined ||
          windowIdentityKey(activeBinding.target) !== windowIdentityKey(baseline.parentBinding.target)) {
        throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", "nested macOS sheet has no exact active parent binding");
      }
      let nestedInventory = await listWindowInventory(
        current.driver, current.label, signal, undefined, true, this.options.windowRelationshipProbe,
      );
      const newRows = nestedInventory.windows.filter((window) =>
        !baseline.targetKeys.has(windowIdentityKey(window.target)) && window.isOnScreen === true && window.minimized !== true);
      let nestedCandidate = newRows.length === 1 && newRows[0]!.target.pid === activeBinding.target.pid
        ? newRows[0]
        : undefined;
      // A completed normal Cmd+O flow can replace its exact admitted sheet
      // with a new TextEdit document window. The sheet's parent HWND is then
      // gone, so do not try to rediscover that obsolete parent as though the
      // new document were another attached sheet. Require the completed
      // Enter action's recorded Open lineage, exact Run-owned root peer, a
      // complete inventory proving the panel absent, and a fresh exact
      // document/process proof before falling through to ordinary child
      // reconciliation. This never activates the document or creates a
      // handoff; the model must still list and select its opaque window ref.
      const openedDocumentProofs = [...current.runOwnedTextEditWindows.values()].filter((candidate) =>
        candidate.sourceActionId === baseline.actionId && candidate.sourceOpenActionId !== undefined &&
        candidate.sourceParentSurfaceRef.surfaceId === rootRef.surfaceId && candidate.target.pid === activeBinding.target.pid);
      const rootTaskWindow = current.runOwnedTextEditWindows.get(windowIdentityKey(asCuaWindowTarget(rootNative)));
      if (baseline.completed && openedDocumentProofs.length === 1 && rootTaskWindow !== undefined &&
          rootTaskWindow.surfaceRef.surfaceId === rootRef.surfaceId &&
          windowIdentityKey(rootTaskWindow.target) === windowIdentityKey(asCuaWindowTarget(rootNative)) &&
          sameApplicationProcess(openedDocumentProofs[0]!.sourceApplicationIdentity, rootTaskWindow.sourceApplicationIdentity)) {
        const openedDocument = openedDocumentProofs[0]!;
        const openedDocumentInventory = await listWindowInventory(
          current.driver, current.label, signal, activeBinding.target.pid, false, this.options.windowRelationshipProbe, "darwin",
        );
        const openedRows = openedDocumentInventory.windows.filter((window) =>
          windowIdentityKey(window.target) === windowIdentityKey(openedDocument.target));
        if (openedDocumentInventory.complete && openedDocumentInventory.truncated !== true &&
            !openedDocumentInventory.windows.some((window) => windowIdentityKey(window.target) === windowIdentityKey(activeBinding.target)) &&
            openedRows.length === 1 && openedRows[0]!.isOnScreen === true && openedRows[0]!.minimized !== true &&
            openedDocumentInventory.foregroundPid === openedDocument.target.pid &&
            openedDocumentInventory.foregroundWindowId === openedDocument.target.windowId) {
          const verifiedOpenedDocument = await this.verifyRunOwnedTextEditWindow(
            current, openedDocument, signal, openedDocumentInventory,
          );
          if (verifiedOpenedDocument !== undefined &&
              windowIdentityKey(verifiedOpenedDocument.target) === windowIdentityKey(openedDocument.target) &&
              sameApplicationProcess(openedDocument.sourceApplicationIdentity, rootTaskWindow.sourceApplicationIdentity)) {
            completedOpenDocumentPid = activeBinding.target.pid;
            nestedCandidate = undefined;
          }
        }
      }
      if (nestedInventory.truncated === true && completedOpenDocumentPid === undefined) {
        throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", "nested macOS sheet candidate inventory is truncated");
      }
      if (completedOpenDocumentPid !== undefined) {
        // The PID-scoped complete inventory above proves the old panel is
        // absent and the newly opened peer is exact; the ordinary sheet path
        // below would otherwise rediscover that already-closed panel.
        nestedCandidate = undefined;
      }
      if (nestedCandidate !== undefined) {
        let freshParent = await discoverWindow(current.driver, current.label, activeBinding.target, signal);
        const storedParent = current.windowBindings.get(windowIdentityKey(activeBinding.target));
        if (storedParent === undefined || !sameWindowGeometry(freshParent.bounds, storedParent.bounds)) {
          throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", "nested macOS sheet parent geometry changed");
        }
        let attached = await readMacAttachedSheetState(
          current.driver, current.label, freshParent, nestedCandidate, signal, asCuaWindowTarget(rootNative),
        );
        if (attached.status === "geometry_unstable") {
          // Only an otherwise fully verified, exact nested sheet may receive
          // one bounded geometry-only reread. Do not replay the action or use
          // the old AX proof after the wait.
          await waitWithAbort(80, signal);
          const activeNow = current.surfaceRegistry.activeSurface;
          const activeSurfaceNow = activeNow === undefined ? undefined : current.surfaceRegistry.surfaces.get(activeNow.surfaceId);
          const rootNow = activeSurfaceNow?.parentSurfaceId === rootRef.surfaceId
            ? current.surfaceRegistry.surfaces.get(rootRef.surfaceId)
            : undefined;
          const rootBinding = current.windowBindings.get(windowIdentityKey(asCuaWindowTarget(rootNative)));
          const parentStillCurrent = sameSurfaceRef(activeBeforeReconcile, activeNow) &&
            sameSurfaceRef(activeBeforeReconcile, baseline.parentSurfaceRef) &&
            isCurrentSurfaceRef(current.surfaceRegistry, activeBeforeReconcile) &&
            isExecutableSurfaceRef(current.surfaceRegistry, activeBeforeReconcile) &&
            activeSurfaceNow?.kind === "native_window" &&
            activeSurfaceNow.admissionSource === "macos_attached_sheet_proof" &&
            activeSurfaceNow.parentSurfaceId === rootRef.surfaceId && rootNow !== undefined &&
            isCurrentSurfaceRef(current.surfaceRegistry, rootRef) &&
            windowIdentityKey(activeWindowBinding(current)?.target ?? { pid: 0, windowId: 0 }) ===
              windowIdentityKey(baseline.parentBinding.target) &&
            windowIdentityKey(activeBinding.target) === windowIdentityKey(baseline.parentBinding.target) &&
            rootBinding !== undefined && windowIdentityKey(rootBinding.target) === windowIdentityKey(asCuaWindowTarget(rootNative));
          if (parentStillCurrent) {
            try {
              const retryInventory = await listWindowInventory(
                current.driver, current.label, signal, undefined, true, this.options.windowRelationshipProbe,
              );
              const retryRows = retryInventory.windows.filter((window) =>
                !baseline.targetKeys.has(windowIdentityKey(window.target)) && window.isOnScreen === true && window.minimized !== true);
              const retryCandidate = retryInventory.truncated !== true && retryRows.length === 1
                ? retryRows[0]
                : undefined;
              if (retryCandidate !== undefined &&
                  windowIdentityKey(retryCandidate.target) === windowIdentityKey(nestedCandidate.target) &&
                  retryCandidate.target.pid === activeBinding.target.pid &&
                  retryCandidate.target.windowId === nestedCandidate.target.windowId &&
                  sameSurfaceRef(activeBeforeReconcile, current.surfaceRegistry.activeSurface) &&
                  isCurrentSurfaceRef(current.surfaceRegistry, activeBeforeReconcile) &&
                  isExecutableSurfaceRef(current.surfaceRegistry, activeBeforeReconcile)) {
                const retryParent = await discoverWindow(current.driver, current.label, activeBinding.target, signal);
                if (sameWindowGeometry(retryParent.bounds, freshParent.bounds) &&
                    sameWindowGeometry(retryParent.bounds, storedParent.bounds) &&
                    sameSurfaceRef(activeBeforeReconcile, current.surfaceRegistry.activeSurface) &&
                    isCurrentSurfaceRef(current.surfaceRegistry, activeBeforeReconcile) &&
                    isExecutableSurfaceRef(current.surfaceRegistry, activeBeforeReconcile)) {
                  const retryAttached = await readMacAttachedSheetState(
                    current.driver, current.label, retryParent, retryCandidate, signal, asCuaWindowTarget(rootNative),
                  );
                  const stackStillCurrent = baseline.completed === true &&
                    sameSurfaceRef(activeBeforeReconcile, current.surfaceRegistry.activeSurface) &&
                    sameSurfaceRef(activeBeforeReconcile, baseline.parentSurfaceRef) &&
                    isCurrentSurfaceRef(current.surfaceRegistry, activeBeforeReconcile) &&
                    isExecutableSurfaceRef(current.surfaceRegistry, activeBeforeReconcile) &&
                    current.surfaceRegistry.surfaces.get(activeBeforeReconcile.surfaceId)?.parentSurfaceId === rootRef.surfaceId &&
                    isCurrentSurfaceRef(current.surfaceRegistry, rootRef) &&
                    windowIdentityKey(activeWindowBinding(current)?.target ?? { pid: 0, windowId: 0 }) ===
                      windowIdentityKey(baseline.parentBinding.target) &&
                    windowIdentityKey(retryCandidate.target) === windowIdentityKey(nestedCandidate.target) &&
                    retryInventory.truncated !== true;
                  if (retryAttached.status === "sheet" && stackStillCurrent) {
                    nestedInventory = retryInventory;
                    nestedCandidate = retryCandidate;
                    freshParent = retryParent;
                    attached = retryAttached;
                  }
                }
              }
            } catch (error) {
              signal.throwIfAborted();
              if (driverErrorDetails(error).tag === "Transport") {
                current.active = false;
                throw error;
              }
              // A failed fresh read cannot authorize stale geometry.
            }
          }
        }
        if (attached.status !== "sheet") {
          throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", attached.status === "unknown"
            ? attached.reason
            : "completed nested-sheet action has no exact direct AXSheet proof");
        }
        const nestedTarget = asCuaWindowTarget(attached.evidence.nativeWindow);
        if (windowIdentityKey(nestedTarget) !== windowIdentityKey(nestedCandidate.target)) {
          throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", "nested AXSheet proof does not match the unique fresh candidate");
        }
        const pushed = pushChild(current.surfaceRegistry, activeBeforeReconcile, attached.evidence);
        if (pushed.decision !== "applied") {
          throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", pushed.reason ?? "nested AXSheet admission was refused");
        }
        current.surfaceRegistry = pushed.state;
        current.windowBindings.set(windowIdentityKey(nestedTarget), { target: nestedTarget, bounds: nestedCandidate.bounds });
        noteSurfaceTransition(current, "child_push");
        current.windowRefs.clear();
        this.clearTargetObservationState(current, activeBeforeReconcile);
        current.firstObservedAfterActionWindows = { actionId: baseline.actionId, targetKeys: new Set([windowIdentityKey(nestedTarget)]) };
        return [];
      }
    }
    const reconciledSibling = await this.reconcileActiveTransientChild(current, signal, completedOpenDocumentPid);
    if (reconciledSibling !== undefined) return [];
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
    if (baseline === undefined || ownerBinding === undefined || this.options.windowDeliveryMode !== "foreground") {
      if (confirmingUnknownAction) {
        throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", "unknown action has no complete pre-action native baseline for safe foreground reconciliation");
      }
      return [];
    }
    const ownerTarget = ownerBinding.target;
    if (!sameSurfaceRef(baseline.parentSurfaceRef, current.surfaceRegistry.activeSurface) ||
        !isCurrentSurfaceRef(current.surfaceRegistry, baseline.parentSurfaceRef) ||
        !isExecutableSurfaceRef(current.surfaceRegistry, baseline.parentSurfaceRef) ||
        windowIdentityKey(ownerTarget) !== windowIdentityKey(baseline.parentBinding.target)) {
      throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", "the pre-action parent Surface generation or exact binding is no longer active");
    }
    let freshParentBinding: CuaWindowBinding;
    try {
      freshParentBinding = await discoverWindow(current.driver, current.label, baseline.parentBinding.target, signal);
    } catch (error) {
      signal.throwIfAborted();
      // No other discover/reconcile/unknown-action path is a recovery permit.
      if (!(error instanceof WindowContractError) || error.code !== "WINDOW_TARGET_NOT_FOUND" ||
          !baseline.completed || confirmingUnknownAction || baseline.parentSurfaceRef.parentSurfaceId !== undefined ||
          !this.canUseManualWindowHandoff(current)) throw error;
      current.missingParent = { sourceActionId: baseline.actionId, reason: "bound_window_missing", candidates: new Map(), epoch: 0, confirming: false };
      const reopenState = current.reopenSavedDocument;
      const saved = reopenState?.savedDocument;
      if (reopenState !== undefined && saved !== undefined && baseline.sourceObservationId === saved.observationId &&
          baseline.closeShortcut &&
          saved.identity.windowId === baseline.parentBinding.target.windowId &&
          reopenState.closedSourceActionId === undefined) {
        try {
          const currentFileIdentity = await fileIdentityPin(reopenState.path);
          if (sameFileIdentity(currentFileIdentity, saved.fileIdentity)) {
            reopenState.closedSourceActionId = baseline.actionId;
          }
        } catch {
          // A missing source window is not a saved-document reopen permit
          // unless the Host-pinned output is still the exact clean file.
        }
      }
      this.clearTargetObservationState(current, baseline.parentSurfaceRef);
      throw new BoundWindowMissingError(baseline.actionId);
    }
    if (!sameWindowGeometry(freshParentBinding.bounds, baseline.parentCuaBounds ?? baseline.parentBinding.bounds)) {
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
      const inventory = await listWindowInventory(current.driver, current.label, signal, undefined, true, this.options.windowRelationshipProbe, current.platform);
      signal.throwIfAborted();
      const rawSurfaced = inventory.windows.filter((window) => !baseline.targetKeys.has(windowIdentityKey(window.target)));
      const surfaced = projectSelectableWindowCandidates(rawSurfaced, baseline.parentBinding.target, current.platform, undefined, (window) =>
        {
          if (window.noActivate === true) return false;
          const exactForeground = inventory.foregroundPid === window.target.pid &&
            inventory.foregroundWindowId === window.target.windowId;
          const exactOwner = window.ownerPid === baseline.parentBinding.target.pid &&
            window.ownerWindowId === baseline.parentBinding.target.windowId;
          if (!baseline.complete || baseline.truncated) return exactForeground && exactOwner;
          const isHostAllowedPeer = targetAllowedByHostScope(window.target, this.options.windowSwitchAllowedTargets);
          return exactOwner || isHostAllowedPeer && isRelevantManualWindowCandidate(
            window,
            baseline.parentBinding.target,
            exactForeground ? { pid: inventory.foregroundPid!, windowId: inventory.foregroundWindowId! } : undefined,
            this.options.windowSwitchAllowedTargets,
            current.platform,
          );
        }, true).windows;
      // Peer authorization must not bypass owned-child classification. A
      // complete Win32 exact-owner row may be an auxiliary HWND in another
      // process (for example a floating WPS toolbar); PID equality is not the
      // owner relation. Missing/partial owner evidence remains manual.
      const potentialChildren = surfaced.filter((window) =>
        window.ownerPid === baseline.parentBinding.target.pid &&
        window.ownerWindowId === baseline.parentBinding.target.windowId);
      const admittedPotentialChildren = potentialChildren.filter((candidate) => {
        const parentSurfaceCurrent = sameSurfaceRef(baseline.parentSurfaceRef, current.surfaceRegistry.activeSurface) &&
          isCurrentSurfaceRef(current.surfaceRegistry, baseline.parentSurfaceRef) &&
          isExecutableSurfaceRef(current.surfaceRegistry, baseline.parentSurfaceRef) &&
          windowIdentityKey(activeWindowBinding(current)?.target ?? { pid: 0, windowId: 0 }) === windowIdentityKey(baseline.parentBinding.target);
        const stageOne = assessOwnedTransientWindowAdmission({
          parent: baseline.parentBinding.target,
          candidate,
          inventory,
          // Unrelated foreground peers and hidden/background helper rows are
          // not part of the exact owner's transient stack. Stage one and the
          // unique-highest proof below classify the exact child itself.
          surfacedWindowCount: 1,
          baselineComplete: baseline.complete,
          baselineTruncated: baseline.truncated,
          parentSurfaceCurrent,
        });
        return stageOne.decision === "admitted";
      });
      if (admittedPotentialChildren.length === 1) {
        return {
          surfaced,
          complete: inventory.complete,
          sourceInventory: inventory,
          potentialOwnedTransientChild: admittedPotentialChildren[0]!,
        };
      }
      return { surfaced, complete: inventory.complete, sourceInventory: inventory };
    };
    let inventory: Awaited<ReturnType<typeof readDiff>>;
    try {
      inventory = await readDiff();
    } catch (error) {
      signal.throwIfAborted();
      if (driverErrorDetails(error).tag === "Transport") current.active = false;
      current.newHandoffCandidates = [];
      current.newlySurfacedWindowKeys = new Set();
      current.proactiveHandoffCandidatesReady = false;
      if (confirmingUnknownAction) {
        throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", "post-action native foreground diff could not be verified");
      }
      return [];
    }
    // Some native dialogs appear just after the initiating tool returns. One
    // short abort-aware read refreshes the post-action view. An incomplete
    // result never proves absence; Runtime still captures the exact active
    // target below before another model turn.
    if (inventory.surfaced.length === 0 && baseline.complete) {
      await waitWithAbort(80, signal);
      try {
        inventory = await readDiff();
      } catch (error) {
        signal.throwIfAborted();
        if (driverErrorDetails(error).tag === "Transport") current.active = false;
        current.newHandoffCandidates = [];
        current.newlySurfacedWindowKeys = new Set();
        current.proactiveHandoffCandidatesReady = false;
        if (confirmingUnknownAction) {
          throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", "post-action native foreground recheck could not be verified");
        }
        return [];
      }
    }
    const transientOwner = activePeerTarget(current);
    const activeWindowRow = inventory.sourceInventory.windows.find((window) =>
      windowIdentityKey(window.target) === windowIdentityKey(ownerBinding.target));
    const hasOwnedSiblingUnderTransientOwner = inventory.complete && transientOwner !== undefined &&
      inventory.sourceInventory.windows.some((window) =>
        windowIdentityKey(window.target) !== windowIdentityKey(ownerBinding.target) &&
        window.ownerPid === transientOwner.pid && window.ownerWindowId === transientOwner.windowId &&
        window.isOnScreen === true && window.minimized !== true &&
        (activeWindowRow?.isOnScreen !== true || activeWindowRow.zIndex === undefined || window.zIndex === undefined ||
          window.zIndex >= activeWindowRow.zIndex));
    if (hasOwnedSiblingUnderTransientOwner) {
      const reconciled = await this.reconcileActiveTransientChild(current, signal);
      if (reconciled !== undefined) return [];
    }
    const surfaced = inventory.surfaced;
    const firstObservedAfterActionKeys = inventory.sourceInventory.windows
      .filter((window) => window.isOnScreen === true && !baseline.targetKeys.has(windowIdentityKey(window.target)))
      .map((window) => windowIdentityKey(window.target));
    current.firstObservedAfterActionWindows = firstObservedAfterActionKeys.length > 0
      ? { actionId: baseline.actionId, targetKeys: new Set(firstObservedAfterActionKeys) }
      : undefined;
    const exactInventoryForAutoPush = baseline.complete && inventory.complete;
    let pushedChild = false;
    const supportsTransientUia = this.options.grounding === "uia-catalog-v1" || this.options.grounding === "hybrid-catalog-v1";
    const provisionalCandidate = current.platform === "darwin" ? undefined : inventory.potentialOwnedTransientChild;
    const parentRef = current.surfaceRegistry.activeSurface;
    let nonBlockingAuxiliaryKey: string | undefined;
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
    if (!pushedChild && current.platform === "darwin" && this.options.windowSwitch === "opened-windows-v1" &&
        this.options.windowDeliveryMode === "foreground" && parentRef !== undefined &&
        baseline.truncated !== true && inventory.sourceInventory.truncated !== true &&
        sameSurfaceRef(parentRef, baseline.parentSurfaceRef) && isCurrentSurfaceRef(current.surfaceRegistry, parentRef) &&
        isExecutableSurfaceRef(current.surfaceRegistry, parentRef)) {
      const rawFreshRows = inventory.sourceInventory.windows.filter((window) =>
        !baseline.targetKeys.has(windowIdentityKey(window.target)) && window.isOnScreen === true && window.minimized !== true);
      const exactInventoryRow = rawFreshRows.length === 1 ? rawFreshRows[0] : undefined;
      if (exactInventoryRow !== undefined && exactInventoryRow.target.pid === ownerTarget.pid &&
          exactInventoryRow.target.windowId !== ownerTarget.windowId) {
        let candidate = exactInventoryRow;
        let attached = await readMacAttachedSheetState(current.driver, current.label, freshParentBinding, exactInventoryRow, signal);
        if (attached.status === "geometry_unstable") {
          // AX and WindowServer can publish the same native sheet at slightly
          // different positions while the system panel is settling. Retry one
          // bounded, read-only cycle; never repeat the action or reuse proof.
          await waitWithAbort(80, signal);
          const parentStillCurrent = sameSurfaceRef(parentRef, current.surfaceRegistry.activeSurface) &&
            sameSurfaceRef(parentRef, baseline.parentSurfaceRef) &&
            isCurrentSurfaceRef(current.surfaceRegistry, parentRef) &&
            isExecutableSurfaceRef(current.surfaceRegistry, parentRef) &&
            windowIdentityKey(activeWindowBinding(current)?.target ?? { pid: 0, windowId: 0 }) ===
              windowIdentityKey(baseline.parentBinding.target);
          if (parentStillCurrent) {
            try {
              const retryParentBinding = await discoverWindow(current.driver, current.label, baseline.parentBinding.target, signal);
              if (sameWindowGeometry(retryParentBinding.bounds, baseline.parentBinding.bounds)) {
                const retryInventory = await readDiff();
                const retryRows = retryInventory.sourceInventory.windows.filter((window) =>
                  !baseline.targetKeys.has(windowIdentityKey(window.target)) && window.isOnScreen === true && window.minimized !== true);
                const retryCandidate = retryRows.length === 1 ? retryRows[0] : undefined;
                if (retryCandidate !== undefined &&
                    windowIdentityKey(retryCandidate.target) === windowIdentityKey(candidate.target) &&
                    retryCandidate.target.pid === ownerTarget.pid && retryInventory.sourceInventory.truncated !== true &&
                    sameSurfaceRef(parentRef, current.surfaceRegistry.activeSurface) &&
                    isCurrentSurfaceRef(current.surfaceRegistry, parentRef) && isExecutableSurfaceRef(current.surfaceRegistry, parentRef)) {
                  const retryAttached = await readMacAttachedSheetState(
                    current.driver, current.label, retryParentBinding, retryCandidate, signal,
                  );
                  if (retryAttached.status === "sheet") {
                    freshParentBinding = retryParentBinding;
                    inventory = retryInventory;
                    candidate = retryCandidate;
                    attached = retryAttached;
                  }
                }
              }
            } catch (error) {
              signal.throwIfAborted();
              if (driverErrorDetails(error).tag === "Transport") {
                current.active = false;
                throw error;
              }
              // A failed fresh read cannot authorize the old geometry.
            }
          }
        }
        if (attached.status === "sheet") {
          const proofInventory: CuaWindowInventory = {
            windows: inventory.sourceInventory.windows.map((window) => windowIdentityKey(window.target) === windowIdentityKey(candidate.target)
              ? { ...window, ownerPid: ownerTarget.pid, ownerWindowId: ownerTarget.windowId }
              : window),
            complete: false,
            completeAttestation: "negative",
            ...(inventory.sourceInventory.truncated === undefined ? {} : { truncated: inventory.sourceInventory.truncated }),
            ...(inventory.sourceInventory.source === undefined ? {} : { source: inventory.sourceInventory.source }),
            foregroundPid: candidate.target.pid,
            foregroundWindowId: candidate.target.windowId,
          };
          const enrichedCandidate = {
            ...candidate,
            ownerPid: ownerTarget.pid,
            ownerWindowId: ownerTarget.windowId,
          };
          const stageOne = assessOwnedTransientWindowAdmission({
            parent: ownerTarget,
            candidate: enrichedCandidate,
            inventory: proofInventory,
            surfacedWindowCount: rawFreshRows.length,
            baselineComplete: false,
            baselineTruncated: false,
            parentSurfaceCurrent: true,
          });
          if (stageOne.decision === "admitted") {
            const pushed = pushChild(current.surfaceRegistry, parentRef, attached.evidence);
            if (pushed.decision === "applied") {
              current.surfaceRegistry = pushed.state;
              const openIntent = current.runOwnedTextEditOpenIntent;
              const sourceParentAfterOpenSheet = openIntent === undefined
                ? undefined
                : currentSurfaceRef(pushed.state, openIntent.sourceParentSurfaceRef.surfaceId);
              if (baseline.openTextEditDocumentShortcut && openIntent !== undefined &&
                  openIntent.sourceActionId === baseline.actionId &&
                  sameSurfaceRef(openIntent.sourceParentSurfaceRef, baseline.parentSurfaceRef) &&
                  pushed.value.parentSurfaceId === openIntent.sourceParentSurfaceRef.surfaceId &&
                  sourceParentAfterOpenSheet !== undefined &&
                  sourceParentAfterOpenSheet.generation === openIntent.sourceParentSurfaceRef.generation + 1) {
                current.runOwnedTextEditOpenIntent = {
                  ...openIntent,
                  admittedOpenSheetRef: { ...pushed.value },
                  sourceParentAfterOpenSheetRef: { ...sourceParentAfterOpenSheet },
                };
              }
              noteSurfaceTransition(current, "child_push");
              pushedChild = true;
              current.windowBindings.set(windowIdentityKey(enrichedCandidate.target), {
                target: enrichedCandidate.target,
                bounds: enrichedCandidate.bounds,
              });
              current.windowRefs.clear();
              this.clearTargetObservationState(current, parentRef);
            } else if (pushed.decision === "manual") {
              throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", pushed.reason);
            }
          }
        }
      }
    }
    if (!pushedChild && parentRef !== undefined && provisionalCandidate !== undefined) {
      const candidate = provisionalCandidate;
      const stageOne = assessOwnedTransientWindowAdmission({
        parent: ownerTarget,
        candidate,
        inventory: inventory.sourceInventory,
        surfacedWindowCount: 1,
        baselineComplete: baseline.complete,
        baselineTruncated: baseline.truncated,
        parentSurfaceCurrent: sameSurfaceRef(baseline.parentSurfaceRef, current.surfaceRegistry.activeSurface) &&
          isCurrentSurfaceRef(current.surfaceRegistry, baseline.parentSurfaceRef) &&
          isExecutableSurfaceRef(current.surfaceRegistry, baseline.parentSurfaceRef),
      });
      let evidence: TransientChildEvidence | undefined;
      let rootVerification: TransientRootVerification | undefined;
      if (stageOne.decision === "admitted") {
        try {
          rootVerification = await verifyTransientNativeChildRoot(
            current.driver, current.label, ownerTarget, candidate, inventory.sourceInventory, baseline.complete,
            canVerifyExactTransientRoot(inventory.sourceInventory), signal,
          );
          if (rootVerification.status === "verified") {
            evidence = rootVerification.evidence;
          } else if (rootVerification.status === "unavailable") {
            evidence = win32RelationshipChildEvidence(ownerTarget, candidate, inventory.sourceInventory);
          }
        } catch (error) {
          signal.throwIfAborted();
          if (driverErrorDetails(error).tag === "Transport") {
            current.active = false;
            throw error;
          }
          // The action receipt is already known. Optional UIA failure does
          // not erase the exact Win32 owner/foreground relationship proof.
          rootVerification = { status: "unavailable", queryFailed: true };
          evidence = win32RelationshipChildEvidence(ownerTarget, candidate, inventory.sourceInventory);
        }
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
          // Keep the Run alive and route the exact candidate through the
          // existing explicit Host picker when child admission is ambiguous.
        }
      } else if (stageOne.decision === "admitted" && rootVerification?.status === "unavailable" && rootVerification.queryFailed !== true &&
          rootVerification.rootRole === "window" &&
          hasExactOwnedAuxiliaryStackEvidence(ownerTarget, candidate, inventory.sourceInventory)) {
        // A non-modal owned helper (for example a floating selection toolbar)
        // may sit above the parent without taking foreground. Keep the parent
        // Surface active and continue with a fresh parent observation; do not
        // push a modal child or interrupt the Run for Host handoff.
        nonBlockingAuxiliaryKey = windowIdentityKey(candidate.target);
        this.markExistingTransientRootInspected(current, parentRef);
      }
    }
    const handoffWindows = pushedChild ? [] : surfaced
      .filter((window) => !current.runOwnedTextEditWindows.has(windowIdentityKey(window.target)))
      .filter((window) => targetAllowedByHostScope(window.target, this.options.windowSwitchAllowedTargets) ||
        window.ownerPid === ownerTarget.pid && window.ownerWindowId === ownerTarget.windowId)
      .filter((window) => windowIdentityKey(window.target) !== nonBlockingAuxiliaryKey);
    const candidates = handoffWindows.map((window) => ({
        pid: window.target.pid,
        windowId: window.target.windowId,
        ...(window.appName === undefined ? {} : { appName: window.appName }),
        ...(window.title === undefined ? {} : { title: window.title }),
      }));
    current.newHandoffCandidates = candidates;
    current.newlySurfacedWindowKeys = new Set(candidates.map(windowIdentityKey));
    current.proactiveHandoffCandidatesReady = candidates.length > 0;
    if (confirmingUnknownAction && candidates.length === 0) {
      const activeRef = current.surfaceRegistry.activeSurface;
      const exactParentRows = inventory.sourceInventory.windows.filter((window) =>
        windowIdentityKey(window.target) === windowIdentityKey(ownerTarget));
      const exactParent = exactParentRows[0];
      if (inventory.sourceInventory.source !== "win32_relationship_probe" ||
          !inventory.sourceInventory.complete || inventory.sourceInventory.truncated === true ||
          !baseline.complete || baseline.truncated || activeRef === undefined ||
          !sameSurfaceRef(activeRef, baseline.parentSurfaceRef) ||
          !isCurrentSurfaceRef(current.surfaceRegistry, baseline.parentSurfaceRef) ||
          !isExecutableSurfaceRef(current.surfaceRegistry, baseline.parentSurfaceRef) ||
          windowIdentityKey(ownerBinding.target) !== windowIdentityKey(baseline.parentBinding.target) ||
          exactParentRows.length !== 1 || exactParent?.isOnScreen !== true || exactParent.minimized === true ||
          !sameWindowGeometry(exactParent.bounds, baseline.parentBinding.bounds) ||
          !sameWindowGeometry(exactParent.bounds, freshParentBinding.bounds) ||
          inventory.sourceInventory.foregroundPid !== ownerTarget.pid ||
          inventory.sourceInventory.foregroundWindowId !== ownerTarget.windowId) {
        throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", "the original exact native Surface was not freshly confirmed as the stable foreground");
      }
      current.unknownActionReconfirmedSurfaceRef = { ...activeRef };
    }
    return candidates;
  }

  private eligibleCurrentManagedBrowserRestoreTarget(current: PrivateSession): CuaWindowTarget | undefined {
    const binding = activeWindowBinding(current);
    const managed = current.managedBrowserTarget;
    if (this.options.windowSwitch !== "opened-windows-v1" || this.options.windowDeliveryMode !== "foreground" ||
        this.options.browserTarget === undefined || binding === undefined || managed === undefined ||
        current.browserTarget === undefined || !managedBrowserTargetForBinding(current, binding) ||
        windowIdentityKey(current.browserTarget.windowTarget) !== windowIdentityKey(binding.target) ||
        windowIdentityKey(managed.windowTarget) !== windowIdentityKey(binding.target) ||
        !current.managedBrowserRestoreEligible ||
        current.missingParent !== undefined) return undefined;
    return { ...binding.target };
  }

  public async handoffWindow(session: ComputerSessionDescriptor, candidate: ComputerWindowCandidate, signal: AbortSignal): Promise<ComputerSessionDescriptor> {
    const current = this.requireSession(session);
    const binding = activeWindowBinding(current);
    if (candidate.restoreCurrentManagedBrowser === true) {
      return this.restoreCurrentManagedBrowser(current, session, candidate, signal);
    }
    if (binding === undefined || !this.canUseManualWindowHandoff(current)) {
      throw new Error("window handoff is available only for an explicitly bound native window");
    }
    validateWindowTarget(candidate);
    const missing = current.missingParent;
    if (missing?.reason !== "bound_window_missing" && this.options.hybridNativeWebDocumentCapability !== undefined &&
        windowIdentityKey(candidate) === windowIdentityKey(this.options.hybridNativeWebDocumentCapability.recoveryTarget)) {
      throw new WindowContractError("WINDOW_HANDOFF_STALE", "the Host recovery blank is available only after the exact saved-document close boundary");
    }
    if (missing !== undefined) {
      const issued = candidate.handoffToken === undefined ? undefined : missing.candidates.get(candidate.handoffToken);
      if (missing.confirming || issued === undefined || issued.pid !== candidate.pid || issued.windowId !== candidate.windowId ||
          issued.title !== candidate.title || issued.appName !== candidate.appName ||
          !targetAllowedByHostScope(candidate, this.options.windowSwitchAllowedTargets)) {
        throw new WindowContractError("WINDOW_HANDOFF_STALE", "missing-window candidate requires its current refresh token and exact host scope");
      }
      // Explicit Host confirmation grants only this exact selected peer, not
      // the undefined broad inventory scope or an old-parent child bypass.
      missing.confirming = true; // Serialize refresh/confirm before the first await or side effect.
      try {
      if (this.options.recoverBoundWindowMissing === true && missing.reason === "bound_window_missing") {
        const pinned = current.recoveryWindowIdentity;
        const freshInventory = await listWindowInventory(current.driver, current.label, signal, undefined, true, this.options.windowRelationshipProbe, current.platform);
        const freshMatches = freshInventory.windows.filter((window) => windowIdentityKey(window.target) === windowIdentityKey(candidate));
        if (pinned === undefined || freshInventory.truncated === true || freshMatches.length !== 1 ||
            !samePinnedRecoveryIdentity(pinned, freshMatches[0]!)) {
          throw new WindowContractError("WINDOW_HANDOFF_STALE", "Host-pinned recovery window identity changed after listing; no activation was attempted");
        }
      }
      const result = await this.transitionWindow(current, candidate, signal, {
        onScreenOnly: true, staleCode: "WINDOW_HANDOFF_STALE", authorizedTargets: [{ pid: candidate.pid, windowId: candidate.windowId }],
        missingPermit: { boundary: missing, epoch: missing.epoch, issued },
        ...(issued.appName === undefined ? {} : { expectedAppName: issued.appName }),
        ...(issued.title === undefined ? {} : { expectedTitle: issued.title }),
      });
      signal.throwIfAborted();
      if (current.missingParent !== missing || missing.candidates.get(candidate.handoffToken!) !== issued) {
        throw new WindowContractError("WINDOW_HANDOFF_STALE", "missing-window confirmation expired during transition");
      }
      const reopenState = current.reopenSavedDocument;
      if (reopenState !== undefined && missing.reason === "bound_window_missing" &&
          missing.sourceActionId === reopenState.closedSourceActionId && reopenState.savedDocument !== undefined &&
          windowIdentityKey(candidate) === windowIdentityKey(this.options.recoveryWindowTarget!)) {
        const recoveryBinding = activeWindowBinding(current);
        const recoveryProof = recoveryBinding === undefined
          ? undefined
          : await queryDocumentIdentity(current.driver, current.label, recoveryBinding.target, recoveryBinding.bounds,
            reopenState.canonicalExecutableUrl, signal);
        if (recoveryProof === undefined || !sameApplicationProcess(recoveryProof.identity, reopenState.primaryIdentity)) {
          throw new WindowContractError("WINDOW_HANDOFF_STALE", "recovery blank is not in the pinned TextEdit process");
        }
        reopenState.recoveryReady = true;
      }
      delete current.missingParent;
      return result;
      } finally { missing.confirming = false; }
    }
    if (binding.target.pid === candidate.pid && binding.target.windowId === candidate.windowId) {
      throw new Error("window handoff target must differ from the current window");
    }
    const isNewlySurfacedForCurrentAction = current.newlySurfacedWindowKeys.has(windowIdentityKey(candidate));
    let authorizedTargets = this.options.windowSwitchAllowedTargets;
    let expectedOwner: CuaWindowTarget | undefined;
    const isForegroundMismatchPeer = !targetAllowedByHostScope(candidate, authorizedTargets) &&
      current.foregroundMismatchWindowId === candidate.windowId;
    if (!targetAllowedByHostScope(candidate, authorizedTargets)) {
      // A user-confirmed exact-owned child is part of the current parent's
      // interaction scope. Recheck the live parent and the child's exact
      // owner/visibility before temporarily authorizing only this HWND.
      const activeRef = current.surfaceRegistry.activeSurface;
      if (activeRef?.parentSurfaceId !== undefined) {
        throw new WindowContractError("WINDOW_SWITCH_UNAUTHORIZED", "an owned child cannot be selected while another modal child is active");
      }
      const freshParent = await discoverWindow(current.driver, current.label, binding.target, signal);
      if (!sameWindowGeometry(freshParent.bounds, binding.bounds)) {
        throw new WindowContractError("WINDOW_HANDOFF_STALE", "the current parent geometry changed before the owned-child selection");
      }
      const inventory = await listWindowInventory(current.driver, current.label, signal, undefined, false, this.options.windowRelationshipProbe, current.platform);
      const ownedRows = inventory.windows.filter((window) => windowIdentityKey(window.target) === windowIdentityKey(candidate));
      const ownedRow = ownedRows.length === 1 ? ownedRows[0] : undefined;
      const freshMismatchPeer = isForegroundMismatchPeer && ownedRow !== undefined &&
        isFreshUnscopedOwnedForegroundPeer(
          ownedRow,
          binding.target,
          inventory,
          current.foregroundMismatchWindowId,
          this.options.windowDeliveryMode === "foreground",
        );
      if (ownedRow === undefined ||
          isForegroundMismatchPeer && !freshMismatchPeer ||
          ownedRow.ownerPid !== binding.target.pid ||
          ownedRow.ownerWindowId !== binding.target.windowId || ownedRow.isOnScreen !== true ||
          ownedRow.minimized === true) {
        throw new WindowContractError("WINDOW_SWITCH_UNAUTHORIZED", "the selected window is not a fresh visible exact-owned child; a foreground-mismatch peer requires complete exact identity evidence");
      }
      authorizedTargets = [...(authorizedTargets ?? []), { pid: candidate.pid, windowId: candidate.windowId }];
      expectedOwner = { pid: binding.target.pid, windowId: binding.target.windowId };
    }
    return this.transitionWindow(current, candidate, signal, {
      onScreenOnly: true,
      staleCode: "WINDOW_HANDOFF_STALE",
      staleMessage: "window handoff candidate changed before confirmation",
      ...(authorizedTargets === undefined ? {} : { authorizedTargets }),
      ...(expectedOwner === undefined ? {} : { expectedOwner }),
      ...(isNewlySurfacedForCurrentAction && !isForegroundMismatchPeer ? { classifyOwnedChild: true } : {}),
      ...(candidate.appName === undefined ? {} : { expectedAppName: candidate.appName }),
      ...(candidate.title === undefined ? {} : { expectedTitle: candidate.title }),
    });
  }

  private async restoreCurrentManagedBrowser(
    current: PrivateSession,
    session: ComputerSessionDescriptor,
    candidate: ComputerWindowCandidate,
    signal: AbortSignal,
  ): Promise<ComputerSessionDescriptor> {
    const token = candidate.handoffToken;
    const issued = token === undefined ? undefined : current.managedBrowserRestoreCandidates.get(token);
    const target = this.eligibleCurrentManagedBrowserRestoreTarget(current);
    if (token === undefined || current.managedBrowserRestoreConfirming || issued === undefined || target === undefined ||
        issued.pid !== candidate.pid || issued.windowId !== candidate.windowId ||
        candidate.pid !== target.pid || candidate.windowId !== target.windowId ||
        candidate.appName !== issued.appName || candidate.title !== issued.title ||
        candidate.restoreCurrentManagedBrowser !== true) {
      throw new WindowContractError("WINDOW_HANDOFF_STALE", "the exact Run-owned browser restore candidate is missing, stale, or outside the current Run");
    }
    current.managedBrowserRestoreConfirming = true;
    try {
      const result = await this.transitionWindow(current, target, signal, {
        onScreenOnly: true,
        staleCode: "WINDOW_HANDOFF_STALE",
        authorizedTargets: [{ pid: target.pid, windowId: target.windowId }],
        allowCurrentTargetRestore: true,
        targetPidOnly: true,
        restorePermit: { candidate: issued, token },
      });
      signal.throwIfAborted();
      return result;
    } finally {
      current.managedBrowserRestoreCandidates.clear();
      current.managedBrowserRestoreConfirming = false;
    }
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
      readonly allowCurrentTargetRestore?: boolean;
      readonly allowRunOwnedPeerRefocus?: boolean;
      readonly allowBoundCurrentRefocus?: boolean;
      readonly targetPidOnly?: boolean;
      readonly expectedAppName?: string;
      readonly expectedTitle?: string;
      readonly expectedOwner?: CuaWindowTarget;
      readonly classifyOwnedChild?: boolean;
      readonly authorizedTargets?: readonly CuaWindowTarget[];
      readonly selectedSurfaceRef?: SurfaceRef;
      readonly missingPermit?: { readonly boundary: NonNullable<PrivateSession["missingParent"]>; readonly epoch: number; readonly issued: ComputerWindowCandidate };
      readonly restorePermit?: { readonly candidate: ComputerWindowCandidate; readonly token: string };
      readonly taskOwnedWindow?: RunOwnedTextEditWindowProof;
      readonly taskWindowTransitionPermit?: NonNullable<PrivateSession["taskWindowTransition"]>;
    },
  ): Promise<ComputerSessionDescriptor> {
    validateWindowTarget(target);
    const taskOwnedWindow = options.taskOwnedWindow;
    const taskTransition = options.taskWindowTransitionPermit;
    const exactRunOwnedTarget = taskOwnedWindow !== undefined &&
      current.runOwnedTextEditWindows.get(windowIdentityKey(target)) === taskOwnedWindow &&
      windowIdentityKey(taskOwnedWindow.target) === windowIdentityKey(target);
    const exactTransitionTarget = taskTransition !== undefined && current.taskWindowTransition === taskTransition &&
      current.runOwnedTextEditWindows.get(windowIdentityKey(target)) === taskTransition.candidate &&
      windowIdentityKey(taskTransition.target) === windowIdentityKey(target);
    if (!targetAllowedByHostScope(target, options.authorizedTargets) && !exactRunOwnedTarget && !exactTransitionTarget) {
      throw new WindowContractError("WINDOW_SWITCH_UNAUTHORIZED", "selected window is outside the host-authorized window scope");
    }
    const activeRefBefore = current.surfaceRegistry.activeSurface;
    const activeBefore = activeSurface(current);
    const activeBindingBefore = activeWindowBinding(current);
    const selectedIsCurrent = activePeerTarget(current) !== undefined &&
      windowIdentityKey(activePeerTarget(current)!) === windowIdentityKey(target);
    let runOwnedForegroundPeerRefocus: RunOwnedTextEditWindowProof | undefined;
    const assertTransitionCurrent = (): void => {
      const permit = options.missingPermit;
      const restorePermit = options.restorePermit;
      const taskPermit = options.taskWindowTransitionPermit;
      const taskWindow = options.taskOwnedWindow;
      if (permit === undefined && restorePermit === undefined && taskPermit === undefined && taskWindow === undefined &&
          options.allowRunOwnedPeerRefocus !== true && options.allowBoundCurrentRefocus !== true) return; // Do not narrow historical non-missing recovery paths.
      signal.throwIfAborted();
      if (this.session !== current || !current.active || activeRefBefore === undefined ||
          !sameSurfaceRef(activeRefBefore, current.surfaceRegistry.activeSurface) ||
          !isExecutableSurfaceRef(current.surfaceRegistry, activeRefBefore)) {
        throw new WindowContractError(options.staleCode, "target transition session or Surface is no longer current");
      }
      if (permit !== undefined && (current.missingParent !== permit.boundary || !permit.boundary.confirming ||
          permit.boundary.epoch !== permit.epoch || permit.boundary.candidates.get(permit.issued.handoffToken!) !== permit.issued)) {
        throw new WindowContractError(options.staleCode, "missing-window confirmation is no longer current");
      }
      if (restorePermit !== undefined && (current.missingParent !== undefined || !current.managedBrowserRestoreConfirming ||
          current.managedBrowserRestoreCandidates.get(restorePermit.token) !== restorePermit.candidate ||
          this.eligibleCurrentManagedBrowserRestoreTarget(current) === undefined)) {
        throw new WindowContractError(options.staleCode, "managed-browser restore confirmation is no longer current");
      }
      if (taskWindow !== undefined && (current.taskWindowTransition !== undefined || current.missingParent !== undefined ||
          current.runOwnedTextEditWindows.get(windowIdentityKey(target)) !== taskWindow ||
          !isCurrentSurfaceRef(current.surfaceRegistry, taskWindow.surfaceRef) ||
          !sameSurfaceRef(current.surfaceRegistry.activeSurface, activeRefBefore))) {
        throw new WindowContractError(options.staleCode, "Run-created TextEdit peer authorization changed before transition");
      }
      if (taskPermit !== undefined && (current.taskWindowTransition !== taskPermit || current.missingParent === undefined ||
          current.missingParent.sourceActionId !== taskPermit.closeSourceActionId ||
          taskPermit.candidate !== current.runOwnedTextEditWindows.get(windowIdentityKey(target)) ||
          !sameSurfaceRef(current.surfaceRegistry.activeSurface, taskPermit.closeSourceSurfaceRef) ||
          taskPermit.observationSurfaceRef === undefined || !isCurrentSurfaceRef(current.surfaceRegistry, taskPermit.observationSurfaceRef))) {
        throw new WindowContractError(options.staleCode, "completed-close task-window authorization changed before transition");
      }
      if (options.allowBoundCurrentRefocus === true &&
          (current.platform !== "win32" || this.options.windowSwitch !== "opened-windows-v1" ||
           this.options.windowDeliveryMode !== "foreground" || current.missingParent !== undefined ||
           !selectedIsCurrent || activeBefore?.kind !== "native_window" || activeBefore.parentSurfaceId !== undefined ||
           activeBindingBefore === undefined || options.selectedSurfaceRef === undefined ||
           !sameSurfaceRef(options.selectedSurfaceRef, activeRefBefore) ||
           !isCurrentSurfaceRef(current.surfaceRegistry, options.selectedSurfaceRef) ||
           windowIdentityKey(activeBindingBefore.target) !== windowIdentityKey(target) ||
           !targetAllowedByHostScope(target, this.options.windowSwitchAllowedTargets))) {
        throw new WindowContractError(options.staleCode, "current-window refocus is outside the exact authorized Windows root-window boundary");
      }
      if (options.allowRunOwnedPeerRefocus === true) {
        const selectedRef = options.selectedSurfaceRef;
        const hostScope = this.options.windowSwitchAllowedTargets;
        if (this.options.windowSwitch !== "opened-windows-v1" || this.options.windowDeliveryMode !== "foreground" ||
            current.platform !== "darwin" || this.options.browserTarget !== undefined ||
            this.options.hybridNativeWebDocumentCapability !== undefined || taskWindow !== undefined || taskPermit !== undefined ||
            permit !== undefined || restorePermit !== undefined || !selectedIsCurrent || activeRefBefore === undefined ||
            selectedRef === undefined || !sameSurfaceRef(selectedRef, activeRefBefore) ||
            !isCurrentSurfaceRef(current.surfaceRegistry, activeRefBefore) || !isExecutableSurfaceRef(current.surfaceRegistry, activeRefBefore) ||
            activeBefore?.kind !== "native_window" || activeBefore.parentSurfaceId !== undefined || activeBindingBefore === undefined ||
            windowIdentityKey(activeBindingBefore.target) !== windowIdentityKey(target) ||
            !sameSurfaceRef(current.surfaceRegistry.activeSurface, activeRefBefore) ||
            !this.isAuthorizedBoundRootRefocusTarget(target, hostScope)) {
          throw new WindowContractError(options.staleCode, "current-window refocus is outside the exact authorized root-window boundary");
        }
        if (runOwnedForegroundPeerRefocus !== undefined &&
            (current.runOwnedTextEditWindows.get(windowIdentityKey(runOwnedForegroundPeerRefocus.target)) !== runOwnedForegroundPeerRefocus ||
             !sameSurfaceRef(runOwnedForegroundPeerRefocus.sourceParentSurfaceRef, activeRefBefore) ||
             runOwnedForegroundPeerRefocus.sourceOpenActionId !== undefined ||
             runOwnedForegroundPeerRefocus.target.pid !== target.pid ||
             !isCurrentSurfaceRef(current.surfaceRegistry, runOwnedForegroundPeerRefocus.surfaceRef))) {
          throw new WindowContractError(options.staleCode, "Run-created foreground peer authorization changed before current-window refocus");
        }
      }
    };
    if (activeBefore?.parentSurfaceId !== undefined &&
        (activeBefore.kind === "overlay" || activeBefore.kind === "native_window")) {
      throw new WindowContractError("TRANSIENT_SURFACE_MODAL", "close and pop the active modal child Surface before switching peers");
    }
    signal.throwIfAborted();
    const transitionInventory = options.expectedOwner === undefined && options.classifyOwnedChild !== true &&
        options.taskOwnedWindow === undefined && options.taskWindowTransitionPermit === undefined &&
        options.allowRunOwnedPeerRefocus !== true && options.allowBoundCurrentRefocus !== true
      ? undefined
      : options.taskWindowTransitionPermit !== undefined
        ? (await this.verifyTaskWindowTransition(current, signal)).inventory
        : options.taskOwnedWindow !== undefined
          ? (await this.verifyRunOwnedTextEditWindow(current, options.taskOwnedWindow, signal)) === undefined
            ? undefined
            : await listWindowInventory(current.driver, current.label, signal, target.pid, false, this.options.windowRelationshipProbe, "darwin")
          : options.allowRunOwnedPeerRefocus === true
            ? await listWindowInventory(current.driver, current.label, signal, target.pid, false, this.options.windowRelationshipProbe, "darwin")
            : await listWindowInventory(current.driver, current.label, signal, undefined, options.onScreenOnly, this.options.windowRelationshipProbe, current.platform);
    if ((options.taskOwnedWindow !== undefined || options.taskWindowTransitionPermit !== undefined ||
        options.allowRunOwnedPeerRefocus === true) && transitionInventory === undefined) {
      throw new WindowContractError(options.staleCode, "fresh complete TextEdit inventory no longer proves the Run-owned target");
    }
    const windows = transitionInventory?.windows ?? await listWindowTargets(
      current.driver, current.label, signal, options.targetPidOnly === true ? target.pid : undefined,
      options.onScreenOnly, this.options.windowRelationshipProbe, current.platform,
    );
    assertTransitionCurrent();
    const freshRows = options.restorePermit === undefined ? undefined
      : windows.filter((window) => windowIdentityKey(window.target) === windowIdentityKey(target));
    if (freshRows !== undefined && freshRows.length !== 1) {
      throw new WindowContractError(options.staleCode, "the exact Run-owned browser target is absent or ambiguous in fresh PID-scoped inventory");
    }
    const fresh = freshRows?.[0] ?? windows.find((window) => windowIdentityKey(window.target) === windowIdentityKey(target));
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
    if (this.options.windowDeliveryMode === "foreground" && fresh.noActivate === true) {
      throw new WindowContractError(options.staleCode, "selected window is a known WS_EX_NOACTIVATE auxiliary and cannot be activated as an independent target");
    }
    if (options.restorePermit !== undefined && (fresh.isOnScreen !== true || fresh.minimized === true)) {
      throw new WindowContractError(options.staleCode, "the exact Run-owned browser target is no longer visible and eligible for restoration");
    }
    if (options.allowBoundCurrentRefocus === true) {
      const inventory = transitionInventory!;
      const targetRows = inventory.windows.filter((window) => windowIdentityKey(window.target) === windowIdentityKey(target));
      if (targetRows.length !== 1 || fresh.isOnScreen !== true && fresh.minimized !== true ||
          activeBindingBefore === undefined || !sameWindowGeometry(fresh.bounds, activeBindingBefore.bounds) ||
          inventory.foregroundPid === undefined || inventory.foregroundWindowId === undefined) {
        throw new WindowContractError(options.staleCode, "fresh exact target identity, geometry and foreground evidence are required for current-window refocus");
      }
      if (inventory.foregroundPid === target.pid && inventory.foregroundWindowId === target.windowId) {
        throw new WindowContractError("WINDOW_ALREADY_CURRENT", "the bound window is already the verified physical foreground");
      }
    }
    if (options.allowRunOwnedPeerRefocus === true) {
      const inventory = transitionInventory!;
      const selectedRef = options.selectedSurfaceRef;
      const targetRows = inventory.windows.filter((window) => windowIdentityKey(window.target) === windowIdentityKey(target));
      const foregroundTarget = inventory.foregroundPid !== undefined && inventory.foregroundWindowId !== undefined
        ? { pid: inventory.foregroundPid, windowId: inventory.foregroundWindowId }
        : undefined;
      if (!inventory.complete || inventory.truncated === true || selectedRef === undefined ||
          !sameSurfaceRef(selectedRef, activeRefBefore) || targetRows.length !== 1 || targetRows[0]!.isOnScreen !== true ||
          targetRows[0]!.minimized === true || targetRows[0]!.noActivate === true || activeBindingBefore === undefined ||
          !sameWindowGeometry(targetRows[0]!.bounds, activeBindingBefore.bounds) || foregroundTarget === undefined) {
        throw new WindowContractError(options.staleCode, "fresh complete TextEdit inventory no longer proves the bound current window and physical foreground");
      }
      if (windowIdentityKey(foregroundTarget) === windowIdentityKey(target)) {
        throw new WindowContractError("WINDOW_ALREADY_CURRENT", "the bound window is already the verified physical foreground");
      }
      const foregroundRows = inventory.windows.filter((window) => windowIdentityKey(window.target) === windowIdentityKey(foregroundTarget));
      const runOwnedMatches = [...current.runOwnedTextEditWindows.values()].filter((candidate) =>
        windowIdentityKey(candidate.target) === windowIdentityKey(foregroundTarget) && candidate.target.pid === target.pid &&
        candidate.sourceActionId.length > 0 && candidate.sourceOpenActionId === undefined &&
        candidate.sourceApplicationIdentity.pid === target.pid && sameSurfaceRef(candidate.sourceParentSurfaceRef, activeRefBefore!),
      );
      if (foregroundRows.length !== 1 || foregroundRows[0]!.isOnScreen !== true || foregroundRows[0]!.minimized === true ||
          runOwnedMatches.length !== 1 || !isCurrentSurfaceRef(current.surfaceRegistry, runOwnedMatches[0]!.surfaceRef) ||
          await this.verifyRunOwnedTextEditWindow(current, runOwnedMatches[0]!, signal, inventory) === undefined) {
        throw new WindowContractError(options.staleCode, "physical foreground is not the exact visible Run-created TextEdit peer of the bound window");
      }
      runOwnedForegroundPeerRefocus = runOwnedMatches[0]!;
      assertTransitionCurrent();
    }
    if (options.expectedOwner !== undefined) {
      const ownerRows = windows.filter((window) => windowIdentityKey(window.target) === windowIdentityKey(options.expectedOwner!));
      const childRows = windows.filter((window) => windowIdentityKey(window.target) === windowIdentityKey(target));
      const parentBinding = activeWindowBinding(current);
      const exactForeground = transitionInventory?.foregroundPid === target.pid &&
        transitionInventory.foregroundWindowId === target.windowId;
      if (transitionInventory === undefined || ownerRows.length !== 1 || childRows.length !== 1 || parentBinding === undefined ||
          !sameWindowGeometry(ownerRows[0]!.bounds, parentBinding.bounds) || ownerRows[0]!.isOnScreen !== true ||
          ownerRows[0]!.minimized === true || childRows[0]!.ownerPid !== options.expectedOwner.pid ||
          childRows[0]!.ownerWindowId !== options.expectedOwner.windowId || childRows[0]!.isOnScreen !== true ||
          childRows[0]!.minimized === true ||
          !transitionInventory.complete && !exactForeground ||
          current.foregroundMismatchWindowId === target.windowId &&
            (!transitionInventory.complete || transitionInventory.truncated === true ||
              transitionInventory.completeAttestation === "negative" || !exactForeground ||
              ownerRows[0]!.cuaListed === false || childRows[0]!.cuaListed === false ||
              this.options.windowDeliveryMode === "foreground" && childRows[0]!.noActivate === true)) {
        throw new WindowContractError(options.staleCode, "fresh inventory no longer proves the current parent geometry and exact visible child owner relationship");
      }
    }
    let confirmedChildEvidence: Extract<TransientChildEvidence, { readonly kind: "native_window" }> | undefined;
    if (options.classifyOwnedChild === true && transitionInventory !== undefined && activeRefBefore !== undefined &&
        activeBefore?.kind === "native_window" && activeBefore.parentSurfaceId === undefined && activeBindingBefore !== undefined) {
      const owner = activeBindingBefore.target;
      const ownerRows = transitionInventory.windows.filter((window) => windowIdentityKey(window.target) === windowIdentityKey(owner));
      const childRows = transitionInventory.windows.filter((window) => windowIdentityKey(window.target) === windowIdentityKey(target));
      const child = childRows.length === 1 ? childRows[0] : undefined;
      const exactForeground = transitionInventory.foregroundPid === target.pid && transitionInventory.foregroundWindowId === target.windowId;
      const trustedCrossProcessOwner = target.pid === owner.pid ||
        transitionInventory.source === "win32_relationship_probe" && transitionInventory.complete && transitionInventory.truncated !== true;
      if (ownerRows.length === 1 && child !== undefined && sameWindowGeometry(ownerRows[0]!.bounds, activeBindingBefore.bounds) &&
          child.ownerPid === owner.pid && child.ownerWindowId === owner.windowId && child.isOnScreen === true &&
          child.minimized !== true && exactForeground && trustedCrossProcessOwner) {
        confirmedChildEvidence = win32OwnedChildEvidence(owner, child, transitionInventory, isCurrentSurfaceRef(current.surfaceRegistry, activeRefBefore));
        if (confirmedChildEvidence === undefined) {
          const root = await verifyTransientNativeChildRoot(
            current.driver,
            current.label,
            owner,
            child,
            transitionInventory,
            transitionInventory.complete,
            canVerifyExactTransientRoot(transitionInventory),
            signal,
          );
          if (root.status === "verified") confirmedChildEvidence = root.evidence;
        }
      }
    }
    if (selectedIsCurrent && options.allowCurrentTargetRestore !== true && options.allowRunOwnedPeerRefocus !== true &&
        options.allowBoundCurrentRefocus !== true) {
      throw new WindowContractError("WINDOW_ALREADY_CURRENT", "selected window is already the current target");
    }
    current.windowRefs.clear();

    assertTransitionCurrent();
    let targetSurfaceRef = options.selectedSurfaceRef;
    if (targetSurfaceRef === undefined && options.allowCurrentTargetRestore === true) {
      const restoreRoot = surfaceRefForWindow(current, target);
      if (activeRefBefore === undefined || restoreRoot === undefined || !selectedIsCurrent) {
        throw new WindowContractError(options.staleCode, "managed browser restore target no longer matches the current Surface");
      }
      targetSurfaceRef = restoreRoot;
    } else if (targetSurfaceRef === undefined && confirmedChildEvidence === undefined) {
      const registered = registerNativePeer(current.surfaceRegistry, asNativeWindowIdentity(target));
      if (registered.decision !== "applied") {
        throw new WindowContractError(options.staleCode, registered.reason);
      }
      current.surfaceRegistry = registered.state;
      targetSurfaceRef = registered.value;
    }
    if (targetSurfaceRef !== undefined && !isCurrentSurfaceRef(current.surfaceRegistry, targetSurfaceRef)) {
      throw new WindowContractError(options.staleCode, options.staleMessage ?? "selected Surface generation changed before target transition");
    }

    if (this.options.windowDeliveryMode === "foreground") {
      signal.throwIfAborted();
      assertTransitionCurrent();
      try {
        await bringWindowToFrontOnce(current.driver, current.label, target, signal);
      } catch (error) {
        // Activation attempts carry no app-content input. Keep the exact old
        // authorized Surface/binding executable, but expire every frame/ref
        // that could otherwise be reused across the attempted transition.
        current.windowRefs.clear();
        this.clearTargetObservationState(current, activeRefBefore, targetSurfaceRef);
        if (!hasConfirmedWindowsActivationRefusal(error)) markUnconfirmedNativeTransitionFailure(error);
        throw error;
      }
    }

    if (options.taskWindowTransitionPermit !== undefined) {
      await this.verifyTaskWindowTransition(current, signal);
      assertTransitionCurrent();
    } else if (options.taskOwnedWindow !== undefined) {
      if (await this.verifyRunOwnedTextEditWindow(current, options.taskOwnedWindow, signal) === undefined) {
        throw new WindowContractError(options.staleCode, "Run-created TextEdit peer identity changed after activation");
      }
      assertTransitionCurrent();
    }

    let capture: Awaited<ReturnType<typeof captureWindowWithRetry>>;
    try {
      assertTransitionCurrent();
      capture = await captureWindowWithRetry(current.driver, current.label, target, signal, this.windowCaptureRetryOptions, resolveCapturePlatform(this.options.platform, current.platform));
      signal.throwIfAborted();
      assertTransitionCurrent();
      if (options.allowBoundCurrentRefocus === true) {
        const inventory = await listWindowInventory(current.driver, current.label, signal, undefined, false,
          this.options.windowRelationshipProbe, current.platform);
        signal.throwIfAborted();
        assertTransitionCurrent();
        const matches = inventory.windows.filter((window) => windowIdentityKey(window.target) === windowIdentityKey(target));
        if (matches.length !== 1 || matches[0]!.isOnScreen !== true || matches[0]!.minimized === true || matches[0]!.noActivate === true ||
            !sameWindowGeometry(matches[0]!.bounds, capture.binding.bounds) ||
            inventory.foregroundPid !== target.pid || inventory.foregroundWindowId !== target.windowId) {
          throw new WindowContractError(options.staleCode, "refocused window lost its exact identity, geometry or physical foreground during capture");
        }
      }
    } catch (error) {
      // A failed candidate capture does not prove the prior bound HWND lost
      // identity. Do not promote the candidate; retain the old Surface and
      // binding for a later fresh observation, with no stale refs or frames.
      current.windowRefs.clear();
      this.clearTargetObservationState(current, activeRefBefore, targetSurfaceRef);
      markUnconfirmedNativeTransitionFailure(error);
      throw error;
    }

    if (options.taskWindowTransitionPermit !== undefined) {
      const proof = await queryDocumentIdentity(current.driver, current.label, target, capture.binding.bounds, TEXTEDIT_EXECUTABLE_URL, signal);
      if (proof === undefined || !sameApplicationProcess(proof.identity, options.taskWindowTransitionPermit.candidate.sourceApplicationIdentity)) {
        throw new WindowContractError(options.staleCode, "captured task peer no longer proves the Run-created TextEdit process");
      }
      assertTransitionCurrent();
    } else if (options.taskOwnedWindow !== undefined) {
      const proof = await queryDocumentIdentity(current.driver, current.label, target, capture.binding.bounds, TEXTEDIT_EXECUTABLE_URL, signal);
      if (proof === undefined || !sameApplicationProcess(proof.identity, options.taskOwnedWindow.sourceApplicationIdentity)) {
        throw new WindowContractError(options.staleCode, "captured TextEdit peer no longer proves the Run-created process");
      }
      assertTransitionCurrent();
    } else if (runOwnedForegroundPeerRefocus !== undefined) {
      const proof = await queryDocumentIdentity(current.driver, current.label, target, capture.binding.bounds, TEXTEDIT_EXECUTABLE_URL, signal);
      if (proof === undefined || !sameApplicationProcess(proof.identity, runOwnedForegroundPeerRefocus.sourceApplicationIdentity)) {
        throw new WindowContractError(options.staleCode, "fresh refocused window identity no longer proves the Run-created TextEdit process and foreground");
      }
      assertTransitionCurrent();
    }

    // Activation may change foreground focus, but sends no application content
    // input. Commit only after a fresh exact capture, with the new viewport and
    // no references from the old UI.
    if (confirmedChildEvidence !== undefined && activeRefBefore !== undefined) {
      const pushed = pushChild(current.surfaceRegistry, activeRefBefore, confirmedChildEvidence);
      if (pushed.decision !== "applied") throw new WindowContractError(options.staleCode, pushed.reason);
      current.surfaceRegistry = pushed.state;
      targetSurfaceRef = pushed.value;
      noteSurfaceTransition(current, "child_push");
    } else if (options.taskWindowTransitionPermit !== undefined) {
      if (targetSurfaceRef === undefined) throw new WindowContractError(options.staleCode, "selected task peer has no current transition Surface");
      const activated = activatePeer(current.surfaceRegistry, targetSurfaceRef, {
        nativeWindow: asNativeWindowIdentity(capture.binding.target), identityVerified: true, captureVerified: true,
      });
      if (activated.decision !== "applied") throw new WindowContractError(options.staleCode, activated.reason);
      current.surfaceRegistry = activated.state;
      targetSurfaceRef = activated.value;
    } else if (options.allowCurrentTargetRestore === true) {
      const advanced = advanceSurfaceGeneration(current.surfaceRegistry, targetSurfaceRef!);
      if (advanced.decision !== "applied") throw new WindowContractError(options.staleCode, advanced.reason);
      current.surfaceRegistry = advanced.state;
      targetSurfaceRef = advanced.value;
      noteSurfaceTransition(current, "generation_advanced");
    } else if (runOwnedForegroundPeerRefocus !== undefined || options.allowBoundCurrentRefocus === true) {
      if (targetSurfaceRef === undefined) throw new WindowContractError(options.staleCode, "authorized current Surface disappeared before refocus commit");
      const advanced = advanceSurfaceGeneration(current.surfaceRegistry, targetSurfaceRef);
      if (advanced.decision !== "applied") throw new WindowContractError(options.staleCode, advanced.reason);
      current.surfaceRegistry = advanced.state;
      targetSurfaceRef = advanced.value;
      noteSurfaceTransition(current, "generation_advanced");
      const replayGuard = current.unknownActionReplayGuard;
      if (replayGuard !== undefined && sameSurfaceRef(replayGuard.surfaceRef, activeRefBefore)) {
        current.unknownActionReplayGuard = { ...replayGuard, surfaceRef: { ...targetSurfaceRef } };
      }
    } else {
      if (targetSurfaceRef === undefined) throw new WindowContractError(options.staleCode, "selected Surface could not be registered");
      const advanced = advanceSurfaceGeneration(current.surfaceRegistry, targetSurfaceRef);
      if (advanced.decision !== "applied") throw new WindowContractError(options.staleCode, advanced.reason);
      const activated = activatePeer(advanced.state, advanced.value, {
        nativeWindow: asNativeWindowIdentity(capture.binding.target),
        identityVerified: true,
        captureVerified: true,
      });
      if (activated.decision !== "applied") throw new WindowContractError(options.staleCode, activated.reason);
      current.surfaceRegistry = activated.state;
      targetSurfaceRef = activated.value;
      noteSurfaceTransition(current, "peer_switch");
    }
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
    if (options.taskOwnedWindow !== undefined) options.taskOwnedWindow.surfaceRef = targetSurfaceRef;
    if (options.taskWindowTransitionPermit !== undefined) {
      options.taskWindowTransitionPermit.candidate.surfaceRef = targetSurfaceRef;
      delete current.missingParent;
      delete current.taskWindowTransition;
    }
    return current.descriptor;
  }

  private clearTargetObservationState(current: PrivateSession, ...surfaces: Array<SurfaceRef | undefined>): void {
    this.expectedDomInput = undefined;
    this.browserChromeInput = undefined;
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
    current.firstObservedAfterActionWindows = undefined;
    current.newlySurfacedWindowKeys = new Set();
    current.newHandoffCandidates = [];
    current.foregroundMismatchWindowId = undefined;
    current.managedBrowserRestoreEligible = false;
    current.managedBrowserRestoreCandidates.clear();
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

  private rootSurfaceRefFor(current: PrivateSession, surfaceRef: SurfaceRef): SurfaceRef | undefined {
    if (!isCurrentSurfaceRef(current.surfaceRegistry, surfaceRef)) return undefined;
    let surface = current.surfaceRegistry.surfaces.get(surfaceRef.surfaceId);
    if (surface === undefined) return undefined;
    while (surface.parentSurfaceId !== undefined) {
      const parent = current.surfaceRegistry.surfaces.get(surface.parentSurfaceId);
      if (parent === undefined) return undefined;
      surface = parent;
    }
    return currentSurfaceRef(current.surfaceRegistry, surface.surfaceId);
  }

  private recordRunOwnedTextEditOpenIntent(
    current: PrivateSession,
    baseline: NonNullable<PrivateSession["preActionWindowBaseline"]>,
  ): void {
    const sourceIdentity = baseline.sourceApplicationIdentity;
    const sourceTarget = baseline.parentBinding.target;
    const sourceSurface = current.surfaceRegistry.surfaces.get(baseline.parentSurfaceRef.surfaceId);
    const sourceIsAuthorized = targetAllowedByHostScope(sourceTarget, this.options.windowSwitchAllowedTargets) ||
      current.runOwnedTextEditWindows.has(windowIdentityKey(sourceTarget));
    if (current.platform !== "darwin" || this.options.windowSwitch !== "opened-windows-v1" ||
        !baseline.openTextEditDocumentShortcut || baseline.closeShortcut || !baseline.complete || baseline.truncated ||
        sourceIdentity === undefined || baseline.parentSurfaceRef.parentSurfaceId !== undefined ||
        sourceSurface?.kind !== "native_window" || sourceSurface.parentSurfaceId !== undefined ||
        windowIdentityKey(asCuaWindowTarget(sourceSurface.nativeWindow)) !== windowIdentityKey(sourceTarget) ||
        !sourceIsAuthorized || !baseline.targetKeys.has(windowIdentityKey(sourceTarget))) {
      delete current.runOwnedTextEditOpenIntent;
      return;
    }
    current.runOwnedTextEditOpenIntent = {
      sourceActionId: baseline.actionId,
      sourceTarget: { ...sourceTarget },
      sourceParentSurfaceRef: { ...baseline.parentSurfaceRef },
      sourceApplicationIdentity: sourceIdentity,
      baselineTargetKeys: new Set(baseline.targetKeys),
    };
  }

  private async recordRunOwnedTextEditOpenedWindow(
    current: PrivateSession,
    baseline: NonNullable<PrivateSession["preActionWindowBaseline"]>,
    signal: AbortSignal,
  ): Promise<void> {
    const intent = current.runOwnedTextEditOpenIntent;
    if (intent === undefined || baseline.actionId === intent.sourceActionId) return;
    const sourceTarget = intent.sourceTarget;
    const actionRoot = this.rootSurfaceRefFor(current, baseline.parentSurfaceRef);
    const sourceSurface = current.surfaceRegistry.surfaces.get(intent.sourceParentSurfaceRef.surfaceId);
    const currentSourceRef = currentSurfaceRef(current.surfaceRegistry, intent.sourceParentSurfaceRef.surfaceId);
    const admittedOpenSheet = intent.admittedOpenSheetRef === undefined
      ? undefined
      : current.surfaceRegistry.surfaces.get(intent.admittedOpenSheetRef.surfaceId);
    let lineage = current.surfaceRegistry.surfaces.get(baseline.parentSurfaceRef.surfaceId);
    let isDescendantOfAdmittedOpenSheet = false;
    while (lineage !== undefined) {
      if (intent.admittedOpenSheetRef !== undefined && lineage.surfaceId === intent.admittedOpenSheetRef.surfaceId) {
        isDescendantOfAdmittedOpenSheet = sameSurfaceRef(
          currentSurfaceRef(current.surfaceRegistry, lineage.surfaceId), intent.admittedOpenSheetRef,
        );
        break;
      }
      lineage = lineage.parentSurfaceId === undefined ? undefined : current.surfaceRegistry.surfaces.get(lineage.parentSurfaceId);
    }
    const isSameRunTask = baseline.parentBinding.target.pid === sourceTarget.pid &&
      actionRoot !== undefined && actionRoot.surfaceId === intent.sourceParentSurfaceRef.surfaceId &&
      currentSourceRef !== undefined && sourceSurface?.kind === "native_window" &&
      sourceSurface.parentSurfaceId === undefined && sourceSurface.status === "inactive" &&
      intent.sourceParentAfterOpenSheetRef !== undefined &&
      sameSurfaceRef(currentSourceRef, intent.sourceParentAfterOpenSheetRef) &&
      isCurrentSurfaceRef(current.surfaceRegistry, currentSourceRef) &&
      sameSurfaceRef(baseline.parentSurfaceRef, current.surfaceRegistry.activeSurface) &&
      isCurrentSurfaceRef(current.surfaceRegistry, baseline.parentSurfaceRef) &&
      isExecutableSurfaceRef(current.surfaceRegistry, baseline.parentSurfaceRef);
    const hasModalOpenEvidence = isSameRunTask && intent.admittedOpenSheetRef !== undefined &&
      admittedOpenSheet?.kind === "native_window" &&
      admittedOpenSheet.admissionSource === "macos_attached_sheet_proof" &&
      admittedOpenSheet.parentSurfaceId === intent.sourceParentSurfaceRef.surfaceId &&
      isDescendantOfAdmittedOpenSheet &&
      sameSurfaceRef(currentSurfaceRef(current.surfaceRegistry, intent.admittedOpenSheetRef.surfaceId), intent.admittedOpenSheetRef);
    if (!isSameRunTask || !baseline.complete || baseline.truncated || !hasModalOpenEvidence || baseline.closeShortcut) {
      delete current.runOwnedTextEditOpenIntent;
      return;
    }

    const inventory = await listWindowInventory(
      current.driver, current.label, signal, sourceTarget.pid, false, this.options.windowRelationshipProbe, "darwin",
    );
    signal.throwIfAborted();
    if (!inventory.complete || inventory.truncated === true) {
      delete current.runOwnedTextEditOpenIntent;
      return;
    }
    const sourceRows = inventory.windows.filter((window) => windowIdentityKey(window.target) === windowIdentityKey(sourceTarget));
    const sourceRow = sourceRows.length === 1 ? sourceRows[0] : undefined;
    const openPanelStillPresent = inventory.windows.some((window) =>
      window.target.pid === sourceTarget.pid && window.ownerPid === sourceTarget.pid &&
      window.ownerWindowId === sourceTarget.windowId && window.isOnScreen === true && window.minimized !== true);
    const excludedKeys = new Set([...intent.baselineTargetKeys, ...baseline.targetKeys]);
    const created = inventory.windows.filter((window) =>
      window.target.pid === sourceTarget.pid && !excludedKeys.has(windowIdentityKey(window.target)) &&
      window.ownerWindowId === undefined && window.isOnScreen === true && window.minimized !== true);
    if (sourceRow === undefined || sourceRow.isOnScreen !== true || sourceRow.minimized === true) {
      delete current.runOwnedTextEditOpenIntent;
      return;
    }
    if (created.length === 0 && openPanelStillPresent) return;
    if (created.length !== 1 || inventory.foregroundPid !== created[0]!.target.pid ||
        inventory.foregroundWindowId !== created[0]!.target.windowId) {
      delete current.runOwnedTextEditOpenIntent;
      return;
    }

    const candidate = created[0]!;
    const candidateProof = await queryDocumentIdentity(
      current.driver, current.label, candidate.target, candidate.bounds, TEXTEDIT_EXECUTABLE_URL, signal,
    );
    signal.throwIfAborted();
    if (candidateProof === undefined || !sameApplicationProcess(candidateProof.identity, intent.sourceApplicationIdentity)) {
      delete current.runOwnedTextEditOpenIntent;
      return;
    }
    const registered = registerNativePeer(current.surfaceRegistry, asNativeWindowIdentity(candidate.target));
    if (registered.decision !== "applied") {
      delete current.runOwnedTextEditOpenIntent;
      return;
    }
    current.surfaceRegistry = registered.state;
    current.windowBindings.set(windowIdentityKey(candidate.target), { target: candidate.target, bounds: candidate.bounds });
    current.runOwnedTextEditWindows.set(windowIdentityKey(candidate.target), {
      target: { ...candidate.target },
      sourceActionId: baseline.actionId,
      sourceOpenActionId: intent.sourceActionId,
      sourceParentSurfaceRef: { ...intent.sourceParentSurfaceRef },
      sourceApplicationIdentity: candidateProof.identity,
      surfaceRef: registered.value,
    });
    current.firstObservedAfterActionWindows = {
      actionId: baseline.actionId,
      targetKeys: new Set([windowIdentityKey(candidate.target)]),
    };
    delete current.runOwnedTextEditOpenIntent;
  }

  private async recordRunOwnedTextEditWindow(
    current: PrivateSession,
    baseline: NonNullable<PrivateSession["preActionWindowBaseline"]>,
    signal: AbortSignal,
  ): Promise<boolean> {
    const sourceIdentity = baseline.sourceApplicationIdentity;
    if (current.platform !== "darwin" || this.options.windowSwitch !== "opened-windows-v1" ||
        baseline.closeShortcut || !baseline.complete || baseline.truncated || sourceIdentity === undefined ||
        baseline.parentSurfaceRef.parentSurfaceId !== undefined) return false;
    const parentTarget = baseline.parentBinding.target;
    const inventory = await listWindowInventory(
      current.driver, current.label, signal, parentTarget.pid, false, this.options.windowRelationshipProbe, "darwin",
    );
    if (!inventory.complete || inventory.truncated === true) return false;
    const parentRows = inventory.windows.filter((window) => windowIdentityKey(window.target) === windowIdentityKey(parentTarget));
    const created = inventory.windows.filter((window) =>
      window.target.pid === parentTarget.pid && windowIdentityKey(window.target) !== windowIdentityKey(parentTarget) &&
      !baseline.targetKeys.has(windowIdentityKey(window.target)) && window.isOnScreen === true && window.minimized !== true);
    if (parentRows.length !== 1 || parentRows[0]!.isOnScreen !== true || parentRows[0]!.minimized === true ||
        created.length !== 1 || inventory.foregroundPid !== created[0]!.target.pid ||
        inventory.foregroundWindowId !== created[0]!.target.windowId ||
        !sameWindowGeometry(parentRows[0]!.bounds, baseline.parentBinding.bounds)) return false;
    const candidate = created[0]!;
    const identity = await queryDocumentIdentity(
      current.driver, current.label, candidate.target, candidate.bounds, TEXTEDIT_EXECUTABLE_URL, signal,
    );
    if (identity === undefined || !sameApplicationProcess(identity.identity, sourceIdentity)) return false;
    const registered = registerNativePeer(current.surfaceRegistry, asNativeWindowIdentity(candidate.target));
    if (registered.decision !== "applied") return false;
    current.surfaceRegistry = registered.state;
    current.windowBindings.set(windowIdentityKey(candidate.target), { target: candidate.target, bounds: candidate.bounds });
    current.runOwnedTextEditWindows.set(windowIdentityKey(candidate.target), {
      target: { ...candidate.target },
      sourceActionId: baseline.actionId,
      sourceParentSurfaceRef: { ...baseline.parentSurfaceRef },
      sourceApplicationIdentity: sourceIdentity,
      surfaceRef: registered.value,
    });
    current.firstObservedAfterActionWindows = {
      actionId: baseline.actionId,
      targetKeys: new Set([windowIdentityKey(candidate.target)]),
    };
    return true;
  }

  private async verifyRunOwnedTextEditWindow(
    current: PrivateSession,
    candidate: RunOwnedTextEditWindowProof,
    signal: AbortSignal,
    suppliedInventory?: CuaWindowInventory,
  ): Promise<CuaWindowInfo | undefined> {
    if (current.runOwnedTextEditWindows.get(windowIdentityKey(candidate.target)) !== candidate ||
        current.platform !== "darwin" || this.options.windowSwitch !== "opened-windows-v1" ||
        candidate.sourceParentSurfaceRef.parentSurfaceId !== undefined) return undefined;
    const peerRef = currentSurfaceRef(current.surfaceRegistry, candidate.surfaceRef.surfaceId);
    const peerNative = peerRef === undefined ? undefined : resolveNativeWindow(current.surfaceRegistry, peerRef);
    const originSurface = current.surfaceRegistry.surfaces.get(candidate.sourceParentSurfaceRef.surfaceId);
    if (peerRef === undefined || !isCurrentSurfaceRef(current.surfaceRegistry, peerRef) ||
        peerNative === undefined || windowIdentityKey(asCuaWindowTarget(peerNative)) !== windowIdentityKey(candidate.target) ||
        originSurface?.kind !== "native_window" || originSurface.parentSurfaceId !== undefined ||
        originSurface.status === "unknown" || originSurface.status === "closed") {
      return undefined;
    }
    const inventory = suppliedInventory ?? await listWindowInventory(
      current.driver, current.label, signal, candidate.target.pid, false, this.options.windowRelationshipProbe, "darwin",
    );
    signal.throwIfAborted();
    if (!inventory.complete || inventory.truncated === true) return undefined;
    const rows = inventory.windows.filter((window) => windowIdentityKey(window.target) === windowIdentityKey(candidate.target));
    if (rows.length !== 1 || rows[0]!.isOnScreen !== true || rows[0]!.minimized === true ||
        this.options.windowDeliveryMode === "foreground" && rows[0]!.noActivate === true) return undefined;
    const proof = await queryDocumentIdentity(
      current.driver, current.label, candidate.target, rows[0]!.bounds, TEXTEDIT_EXECUTABLE_URL, signal,
    );
    signal.throwIfAborted();
    if (proof === undefined || !sameApplicationProcess(proof.identity, candidate.sourceApplicationIdentity)) return undefined;
    candidate.surfaceRef = peerRef;
    return rows[0];
  }

  private async beginTaskWindowTransitionAfterClose(
    current: PrivateSession,
    baseline: NonNullable<PrivateSession["preActionWindowBaseline"]>,
    signal: AbortSignal,
  ): Promise<void> {
    if (current.platform !== "darwin" || this.options.windowSwitch !== "opened-windows-v1" ||
        this.options.windowDeliveryMode !== "foreground" || !baseline.complete || baseline.truncated ||
        baseline.parentSurfaceRef.parentSurfaceId !== undefined || current.missingParent !== undefined) return;
    const sourceTarget = baseline.parentBinding.target;
    const candidates = [...current.runOwnedTextEditWindows.values()].filter((candidate) =>
      windowIdentityKey(candidate.target) !== windowIdentityKey(sourceTarget) &&
      resolveNativeWindow(current.surfaceRegistry, candidate.surfaceRef) !== undefined &&
      windowIdentityKey(asCuaWindowTarget(resolveNativeWindow(current.surfaceRegistry, candidate.surfaceRef)!)) === windowIdentityKey(candidate.target) &&
      candidate.sourceParentSurfaceRef.surfaceId === baseline.parentSurfaceRef.surfaceId);
    if (candidates.length !== 1) return;
    const candidate = candidates[0]!;
    const inventory = await listWindowInventory(
      current.driver, current.label, signal, sourceTarget.pid, false, this.options.windowRelationshipProbe, "darwin",
    );
    if (!inventory.complete || inventory.truncated === true ||
        inventory.windows.some((window) => windowIdentityKey(window.target) === windowIdentityKey(sourceTarget))) return;
    const rows = inventory.windows.filter((window) => windowIdentityKey(window.target) === windowIdentityKey(candidate.target));
    if (rows.length !== 1 || rows[0]!.isOnScreen !== true || rows[0]!.minimized === true ||
        inventory.foregroundPid !== candidate.target.pid || inventory.foregroundWindowId !== candidate.target.windowId) return;
    const identity = await queryDocumentIdentity(
      current.driver, current.label, candidate.target, rows[0]!.bounds, TEXTEDIT_EXECUTABLE_URL, signal,
    );
    if (identity === undefined || !sameApplicationProcess(identity.identity, candidate.sourceApplicationIdentity)) return;
    const sourceRef = currentSurfaceRef(current.surfaceRegistry, baseline.parentSurfaceRef.surfaceId);
    const peerRef = currentSurfaceRef(current.surfaceRegistry, candidate.surfaceRef.surfaceId);
    if (sourceRef === undefined || peerRef === undefined || !isCurrentSurfaceRef(current.surfaceRegistry, sourceRef) ||
        !isCurrentSurfaceRef(current.surfaceRegistry, peerRef) || isExecutableSurfaceRef(current.surfaceRegistry, peerRef)) return;
    candidate.surfaceRef = peerRef;
    current.missingParent = {
      sourceActionId: baseline.actionId, reason: "bound_window_missing", candidates: new Map(), epoch: 0, confirming: false,
    };
    current.taskWindowTransition = {
      closeSourceActionId: baseline.actionId,
      closeSourceSurfaceRef: sourceRef,
      target: { ...candidate.target },
      candidate,
    };
    this.clearTargetObservationState(current, sourceRef);
  }

  private async verifyTaskWindowTransition(
    current: PrivateSession,
    signal: AbortSignal,
  ): Promise<{ readonly inventory: CuaWindowInventory; readonly target: CuaWindowInfo; readonly identity: VerifiedApplicationIdentity }> {
    const boundary = current.missingParent;
    const transition = current.taskWindowTransition;
    if (boundary === undefined || transition === undefined || boundary.sourceActionId !== transition.closeSourceActionId ||
        current.runOwnedTextEditWindows.get(windowIdentityKey(transition.target)) !== transition.candidate ||
        !isCurrentSurfaceRef(current.surfaceRegistry, transition.closeSourceSurfaceRef) ||
        !isExecutableSurfaceRef(current.surfaceRegistry, transition.closeSourceSurfaceRef)) {
      throw new WindowContractError("WINDOW_SWITCH_STALE", "completed-close task-window transition boundary changed");
    }
    const inventory = await listWindowInventory(
      current.driver, current.label, signal, transition.target.pid, false, this.options.windowRelationshipProbe, "darwin",
    );
    signal.throwIfAborted();
    const sourceNative = resolveNativeWindow(current.surfaceRegistry, transition.closeSourceSurfaceRef);
    const sourceTarget = sourceNative === undefined ? undefined : asCuaWindowTarget(sourceNative);
    const sourceRows = sourceTarget === undefined ? [] : inventory.windows.filter((window) =>
      windowIdentityKey(window.target) === windowIdentityKey(sourceTarget));
    const matches = inventory.windows.filter((window) => windowIdentityKey(window.target) === windowIdentityKey(transition.target));
    if (!inventory.complete || inventory.truncated === true || sourceRows.length !== 0 || matches.length !== 1 ||
        matches[0]!.isOnScreen !== true || matches[0]!.minimized === true ||
        inventory.foregroundPid !== transition.target.pid || inventory.foregroundWindowId !== transition.target.windowId) {
      throw new WindowContractError("WINDOW_SWITCH_STALE", "fresh process-scoped inventory no longer proves the completed close and exact visible task peer");
    }
    const fresh = matches[0]!;
    const proof = await queryDocumentIdentity(
      current.driver, current.label, transition.target, fresh.bounds, TEXTEDIT_EXECUTABLE_URL, signal,
    );
    signal.throwIfAborted();
    if (proof === undefined || !sameApplicationProcess(proof.identity, transition.candidate.sourceApplicationIdentity)) {
      throw new WindowContractError("WINDOW_SWITCH_STALE", "fresh foreground identity no longer matches the Run-created TextEdit process");
    }
    return { inventory, target: fresh, identity: proof.identity };
  }

  private async observeTaskWindowTransition(
    current: PrivateSession,
    session: ComputerSessionDescriptor,
    observationId: ObservationId,
    signal: AbortSignal,
  ): Promise<ObservationCapture> {
    const transition = current.taskWindowTransition!;
    const boundary = current.missingParent;
    const closeSourceActionId = transition.closeSourceActionId;
    const closeSourceSurfaceRef = { ...transition.closeSourceSurfaceRef };
    const candidateSurfaceRef = { ...transition.candidate.surfaceRef };
    const savedWindowRef = current.windowRefs.size === 1
      ? [...current.windowRefs.entries()][0]
      : undefined;
    // A window ref survives this evidence refresh only if the exact transition
    // boundary and peer generation are re-proven below. Any failed/aborted
    // capture leaves the old inventory unusable.
    current.windowRefs.clear();
    const { target, identity } = await this.verifyTaskWindowTransition(current, signal);
    const capture = await captureWindowWithRetry(
      current.driver, current.label, transition.target, signal, this.windowCaptureRetryOptions, "darwin",
    );
    signal.throwIfAborted();
    const afterCapture = await queryDocumentIdentity(
      current.driver, current.label, transition.target, capture.binding.bounds, TEXTEDIT_EXECUTABLE_URL, signal,
    );
    if (afterCapture === undefined || !sameApplicationProcess(afterCapture.identity, identity) ||
        !sameWindowGeometry(capture.binding.bounds, target.bounds)) {
      throw new WindowContractError("WINDOW_SWITCH_STALE", "transition-only capture lost its exact foreground TextEdit identity");
    }
    const afterCaptureVerification = await this.verifyTaskWindowTransition(current, signal);
    const currentPeerRef = currentSurfaceRef(current.surfaceRegistry, transition.candidate.surfaceRef.surfaceId);
    if (current.taskWindowTransition !== transition || current.missingParent !== boundary ||
        boundary === undefined || boundary.sourceActionId !== closeSourceActionId ||
        transition.closeSourceActionId !== closeSourceActionId ||
        !sameSurfaceRef(transition.closeSourceSurfaceRef, closeSourceSurfaceRef) ||
        !sameSurfaceRef(transition.candidate.surfaceRef, candidateSurfaceRef) ||
        currentPeerRef === undefined || !sameSurfaceRef(candidateSurfaceRef, currentPeerRef) ||
        windowIdentityKey(afterCaptureVerification.target.target) !== windowIdentityKey(target.target) ||
        !sameApplicationProcess(afterCaptureVerification.identity, identity) ||
        !sameWindowGeometry(capture.binding.bounds, afterCaptureVerification.target.bounds)) {
      throw new WindowContractError("WINDOW_SWITCH_STALE", "transition boundary or exact peer changed during fresh approval capture");
    }
    let peerRef = currentSurfaceRef(current.surfaceRegistry, transition.candidate.surfaceRef.surfaceId);
    if (peerRef === undefined || !isCurrentSurfaceRef(current.surfaceRegistry, peerRef) ||
        isExecutableSurfaceRef(current.surfaceRegistry, peerRef)) {
      throw new WindowContractError("WINDOW_SWITCH_STALE", "transition-only peer Surface changed before capture");
    }
    const needsSurfaceTransition = transition.observationSurfaceRef === undefined;
    if (needsSurfaceTransition) {
      const advanced = advanceSurfaceGeneration(current.surfaceRegistry, peerRef);
      if (advanced.decision !== "applied") throw new WindowContractError("WINDOW_SWITCH_STALE", "transition-only peer Surface generation could not advance");
      current.surfaceRegistry = advanced.state;
      peerRef = advanced.value;
    }
    transition.candidate.surfaceRef = peerRef;
    transition.observationSurfaceRef = peerRef;
    current.windowBindings.set(windowIdentityKey(capture.binding.target), capture.binding);
    this.observations.set(String(observationId), {
      sessionId: String(session.id),
      captureSource: capture.source,
      surfaceRef: peerRef,
      viewport: capture.viewport,
      ...(capture.cuaBounds === undefined ? {} : { cuaBounds: capture.cuaBounds }),
      geometry: capture.binding.bounds,
    });
    if (!needsSurfaceTransition && savedWindowRef !== undefined &&
        sameSurfaceRef(savedWindowRef[1], candidateSurfaceRef) && sameSurfaceRef(candidateSurfaceRef, peerRef) &&
        isCurrentSurfaceRef(current.surfaceRegistry, peerRef) && current.windowRefs.size === 0 &&
        current.taskWindowTransition === transition && current.missingParent === boundary) {
      current.windowRefs.set(savedWindowRef[0], peerRef);
    }
    this.latestObservationId = observationId;
    return {
      capturedAt: new Date().toISOString(),
      viewport: capture.viewport,
      surfaceRef: peerRef,
      ...(needsSurfaceTransition ? { surfaceTransitionReason: "peer_switch" as const } : {}),
      screenshot: { mediaType: "image/png", data: capture.data },
    };
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

  /** A current-root refocus is a narrow exception to the ordinary peer scope.
   * Explicit scopes remain authoritative. When no explicit scope was supplied,
   * only the exact Host-selected initial target can use this path. */
  private isAuthorizedBoundRootRefocusTarget(
    target: CuaWindowTarget,
    explicitScope: readonly CuaWindowTarget[] | undefined,
  ): boolean {
    if (explicitScope !== undefined) return targetAllowedByHostScope(target, explicitScope);
    const hostSelectedTarget = this.options.windowTarget;
    return hostSelectedTarget !== undefined && windowIdentityKey(hostSelectedTarget) === windowIdentityKey(target);
  }

  private async executeWindowSwitch(
    current: PrivateSession,
    action: SwitchWindowAction,
    signal: AbortSignal,
  ): Promise<ActionReceipt> {
    if (this.options.windowSwitch !== "opened-windows-v1") {
      return refused(action.actionId, "WINDOW_SWITCH_DISABLED", "cross-window switching is not enabled for this Run");
    }
    const taskTransition = current.taskWindowTransition;
    if (activeSurfaceUnavailable(current) && taskTransition === undefined) {
      return refused(action.actionId, "WINDOW_TARGET_INVALIDATED", "window target identity was invalidated; close and open a new session");
    }
    const selectedRef = current.windowRefs.get(action.windowRef);
    const selectedSurface = selectedRef === undefined ? undefined : current.surfaceRegistry.surfaces.get(selectedRef.surfaceId);
    if (selectedRef === undefined || selectedSurface?.kind !== "native_window" || selectedSurface.parentSurfaceId !== undefined ||
        !isCurrentSurfaceRef(current.surfaceRegistry, selectedRef)) {
      return refused(action.actionId, "WINDOW_REF_STALE", "windowRef was not issued by the current window inventory; list windows again");
    }
    const selectedTarget = asCuaWindowTarget(selectedSurface.nativeWindow);
    if (!this.isTargetSwitchAllowed(selectedTarget)) {
      current.windowRefs.clear();
      return refused(action.actionId, "WINDOW_SWITCH_UNAUTHORIZED", "selected window is outside the Host-authorized ordinary window-switch scope");
    }
    const selectedKey = windowIdentityKey(selectedTarget);
    const taskOwnedWindow = current.runOwnedTextEditWindows.get(selectedKey);
    const activeRef = current.surfaceRegistry.activeSurface;
    const activeRoot = activeSurface(current);
    const allowBoundCurrentRefocus = taskTransition === undefined && current.missingParent === undefined &&
      current.platform === "win32" && this.options.windowDeliveryMode === "foreground" &&
      activeRoot?.kind === "native_window" && activeRoot.parentSurfaceId === undefined &&
      activeRef !== undefined && sameSurfaceRef(selectedRef, activeRef) &&
      targetAllowedByHostScope(selectedTarget, this.options.windowSwitchAllowedTargets);
    const allowRunOwnedPeerRefocus = taskTransition === undefined && taskOwnedWindow === undefined &&
      this.options.windowDeliveryMode === "foreground" && current.platform === "darwin" &&
      this.options.browserTarget === undefined && this.options.hybridNativeWebDocumentCapability === undefined &&
      activeRoot?.kind === "native_window" && activeRoot.parentSurfaceId === undefined &&
      activeRef !== undefined && sameSurfaceRef(selectedRef, activeRef) &&
      this.isAuthorizedBoundRootRefocusTarget(selectedTarget, this.options.windowSwitchAllowedTargets);
    if (taskTransition !== undefined && (current.missingParent === undefined ||
        taskTransition.candidate !== taskOwnedWindow ||
        windowIdentityKey(taskTransition.target) !== selectedKey ||
        !sameSurfaceRef(selectedRef, taskTransition.candidate.surfaceRef) ||
        taskTransition.observationSurfaceRef === undefined ||
        !isCurrentSurfaceRef(current.surfaceRegistry, taskTransition.observationSurfaceRef) ||
        this.latestObservationId === undefined ||
        !sameSurfaceRef(this.observations.get(String(this.latestObservationId))?.surfaceRef, taskTransition.observationSurfaceRef))) {
      return refused(action.actionId, "WINDOW_SWITCH_STALE", "completed-close switch must use the fresh listed Run-owned task peer");
    }
    if (taskTransition === undefined && taskOwnedWindow !== undefined &&
        !sameSurfaceRef(selectedRef, taskOwnedWindow.surfaceRef)) {
      return refused(action.actionId, "WINDOW_REF_STALE", "Run-created TextEdit peer changed; list windows again");
    }
    // A switch consumes the entire prior inventory. A subsequent choice must
    // come from a fresh list, even if the selected target proves stale.
    current.windowRefs.clear();
    if (activeSurface(current)?.kind === "desktop") {
      return this.executeDesktopWindowSwitch(current, action, selectedTarget, selectedRef, signal);
    }
    try {
      const sessionAfter = await this.transitionWindow(current, selectedTarget, signal, {
        onScreenOnly: false,
        staleCode: "WINDOW_SWITCH_STALE",
        selectedSurfaceRef: selectedRef,
        ...(allowBoundCurrentRefocus ? { allowBoundCurrentRefocus: true } : {}),
        ...(allowRunOwnedPeerRefocus ? { allowRunOwnedPeerRefocus: true } : {}),
        ...(taskTransition === undefined
          ? taskOwnedWindow === undefined ? {} : { taskOwnedWindow }
          : { taskWindowTransitionPermit: taskTransition }),
        ...(this.options.windowSwitchAllowedTargets === undefined
          ? {}
          : { authorizedTargets: this.hasHybridCapability()
            ? [...this.options.windowSwitchAllowedTargets, this.options.hybridNativeWebDocumentCapability!.managedBrowserTarget.windowTarget]
            : this.options.windowSwitchAllowedTargets }),
      });
      return { actionId: action.actionId, status: "completed", sessionAfter };
    } catch (error) {
      if (error instanceof WindowContractError) {
        const driverCode = error.code;
        const message = error.message;
        if (activeSurfaceUnavailable(current)) {
          return { actionId: action.actionId, status: "failed", driverCode, message };
        }
        if (isUnconfirmedNativeTransitionFailure(error)) {
          return { actionId: action.actionId, status: "failed", driverCode, message };
        }
        if (hasConfirmedWindowsActivationRefusal(error)) {
          return { actionId: action.actionId, status: "refused", driverCode, message };
        }
        return refused(action.actionId, driverCode, message);
      }
      const details = driverErrorDetails(error);
      if (details.tag === "Transport") current.active = false;
      throw normalizeDriverError(error, "execute");
    }
  }

  private async executeDesktopWindowSwitch(
    current: PrivateSession,
    action: SwitchWindowAction,
    target: CuaWindowTarget,
    selectedSurfaceRef: SurfaceRef,
    signal: AbortSignal,
  ): Promise<ActionReceipt> {
    const desktopSurfaceRef = current.surfaceRegistry.activeSurface;
    if (desktopSurfaceRef === undefined || activeSurface(current)?.kind !== "desktop" ||
        !isCurrentSurfaceRef(current.surfaceRegistry, desktopSurfaceRef) ||
        !isExecutableSurfaceRef(current.surfaceRegistry, desktopSurfaceRef)) {
      return refused(action.actionId, "SURFACE_REF_STALE", "primary desktop Surface changed before activating the listed window");
    }
    if (!targetAllowedByHostScope(target, this.options.windowSwitchAllowedTargets) || isRegisteredChildWindow(current, target)) {
      return refused(action.actionId, "WINDOW_SWITCH_UNAUTHORIZED", "selected window is outside the Host-authorized top-level window scope");
    }
    if (!isCurrentSurfaceRef(current.surfaceRegistry, selectedSurfaceRef)) {
      return refused(action.actionId, "WINDOW_REF_STALE", "windowRef no longer identifies a current listed window; list windows again");
    }
    signal.throwIfAborted();
    const inventory = await listWindowInventory(current.driver, current.label, signal, undefined, false, this.options.windowRelationshipProbe, current.platform);
    signal.throwIfAborted();
    const matches = inventory.windows.filter((window) => windowIdentityKey(window.target) === windowIdentityKey(target));
    if (matches.length !== 1) {
      return refused(action.actionId, "WINDOW_SWITCH_STALE", "selected window identity is no longer uniquely present in the fresh inventory");
    }
    const fresh = matches[0]!;
    const eligibleNativeOnlyDesktopTarget = isEligibleNativeOnlyDesktopCandidate(inventory, fresh);
    if (!targetAllowedByHostScope(fresh.target, this.options.windowSwitchAllowedTargets) ||
        fresh.cuaListed === false && !eligibleNativeOnlyDesktopTarget ||
        isRegisteredChildWindow(current, fresh.target)) {
      return refused(action.actionId, "WINDOW_SWITCH_UNAUTHORIZED", "selected window is no longer a Host-authorized top-level window");
    }
    if (fresh.isOnScreen === false && fresh.minimized !== true) {
      return refused(action.actionId, "WINDOW_SWITCH_STALE", "selected window is no longer a visible or restorable application window");
    }
    if (fresh.noActivate === true) {
      return refused(action.actionId, "WINDOW_SWITCH_NOACTIVATE", "selected window is a known WS_EX_NOACTIVATE auxiliary and cannot be activated independently");
    }

    const alreadyForeground = inventory.foregroundPid === target.pid && inventory.foregroundWindowId === target.windowId;
    if (alreadyForeground) {
      this.clearTargetObservationState(current, desktopSurfaceRef, selectedSurfaceRef);
      return {
        actionId: action.actionId,
        status: "completed",
        message: "The listed window is already the exact foreground window; no activation was dispatched and the next observation remains the full primary desktop.",
        sessionAfter: current.descriptor,
      };
    }

    signal.throwIfAborted();
    try {
      await bringWindowToFrontOnce(current.driver, current.label, target, signal);
    } catch (error) {
      // A failed foreground change does not invalidate the full desktop
      // Surface. Expire its old screenshot/references, but keep the primary
      // display executable so a fresh desktop observation can clarify state.
      this.clearTargetObservationState(current, desktopSurfaceRef, selectedSurfaceRef);
      const details = driverErrorDetails(error);
      if (details.tag === "Transport") current.active = false;
      const confirmedRefusal = hasConfirmedWindowsActivationRefusal(error);
      return {
        actionId: action.actionId,
        status: confirmedRefusal ? "refused" : "failed",
        driverCode: error instanceof WindowContractError ? error.code : "WINDOW_SWITCH_OUTCOME_UNKNOWN",
        message: confirmedRefusal
          ? "Windows did not activate the exact listed window; no UI input was sent and the full-desktop scope remains active. Do not type into that target; re-observe and choose a different switching action or ask an operator to activate it."
          : details.message,
      };
    }
    this.clearTargetObservationState(current, desktopSurfaceRef, selectedSurfaceRef);
    return {
      actionId: action.actionId,
      status: "completed",
      message: "Activated the exact listed window; the next observation remains the full primary desktop.",
      sessionAfter: current.descriptor,
    };
  }

  private hasHybridCapability(): boolean {
    return this.options.hybridNativeWebDocumentCapability !== undefined;
  }

  private isTargetSwitchAllowed(target: CuaWindowTarget): boolean {
    const hybrid = this.options.hybridNativeWebDocumentCapability;
    if (hybrid !== undefined && windowIdentityKey(target) === windowIdentityKey(hybrid.recoveryTarget)) return false;
    return targetAllowedByHostScope(target, this.options.windowSwitchAllowedTargets) ||
      (hybrid !== undefined && windowIdentityKey(target) === windowIdentityKey(hybrid.managedBrowserTarget.windowTarget)) ||
      this.session?.runOwnedTextEditWindows.has(windowIdentityKey(target)) === true;
  }

  private async executeReopenSavedDocument(
    current: PrivateSession,
    action: Extract<ActionIntent, { readonly kind: "reopen_saved_document" }>,
    observation: PrivateObservation,
    signal: AbortSignal,
  ): Promise<ActionReceipt> {
    const state = current.reopenSavedDocument;
    const saved = state?.savedDocument;
    const recoveryTarget = this.options.recoveryWindowTarget;
    const activeBinding = activeWindowBinding(current);
    if (state === undefined || saved === undefined || recoveryTarget === undefined || !state.recoveryReady || state.attempted ||
        state.closedSourceActionId === undefined ||
        activeBinding === undefined || windowIdentityKey(activeBinding.target) !== windowIdentityKey(recoveryTarget) ||
        observation.geometry === undefined || !sameWindowGeometry(observation.geometry, activeBinding.bounds)) {
      return refused(action.actionId, "DOCUMENT_REOPEN_NOT_READY", "the saved document is not ready for the one-shot Host-authorized reopen");
    }

    // Failures here precede dispatch, so the single-use capability remains
    // available for a fresh, corrected action.
    try {
      const parentInfo = await lstat(dirname(state.path), { bigint: true });
      const currentFile = await fileIdentityPin(state.path);
      const currentBinding = await discoverWindow(current.driver, current.label, recoveryTarget, signal);
      const appProof = await queryDocumentIdentity(current.driver, current.label, currentBinding.target, currentBinding.bounds,
        state.canonicalExecutableUrl, signal);
      if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() ||
          parentInfo.dev.toString() !== state.parentIdentity.dev || parentInfo.ino.toString() !== state.parentIdentity.ino ||
          !sameFileIdentity(currentFile, saved.fileIdentity) ||
          !sameWindowGeometry(currentBinding.bounds, activeBinding.bounds) || appProof === undefined ||
          !sameApplicationProcess(appProof.identity, state.primaryIdentity)) {
        return refused(action.actionId, "DOCUMENT_REOPEN_PREFLIGHT_FAILED", "the exact saved file or recovery window could not be reverified; no launch was attempted");
      }
    } catch {
      signal.throwIfAborted();
      return refused(action.actionId, "DOCUMENT_REOPEN_PREFLIGHT_FAILED", "the exact saved file or recovery window could not be reverified; no launch was attempted");
    }

    // Consume immediately before dispatch. Anything after this point is a
    // verified completion or an unknown outcome; never launch a second time.
    state.attempted = true;
    state.recoveryReady = false;
    let launched: Awaited<ReturnType<typeof callTool>>;
    try {
      launched = await callTool(current.driver, "launch_app", {
        session: current.label,
        bundle_id: "com.apple.TextEdit",
        urls: [state.fileUrl],
      }, signal);
    } catch {
      signal.throwIfAborted();
      return { actionId: action.actionId, status: "partial", driverCode: "DOCUMENT_REOPEN_OUTCOME_UNKNOWN", message: "TextEdit launch was attempted but the saved document could not be verified; do not retry" };
    }
    if (launched.isError) {
      return { actionId: action.actionId, status: "partial", driverCode: "DOCUMENT_REOPEN_OUTCOME_UNKNOWN", message: "TextEdit launch was attempted but the saved document could not be verified; do not retry" };
    }
    const launchValue = parseStructuredRecord(launched.structuredJson);
    if (launchValue?.pid !== state.primaryIdentity.pid) {
      return { actionId: action.actionId, status: "partial", driverCode: "DOCUMENT_REOPEN_OUTCOME_UNKNOWN", message: "TextEdit launch was attempted but the saved document could not be verified; do not retry" };
    }

    try {
      const verificationSignal = AbortSignal.any([signal, AbortSignal.timeout(1_500)]);
      const verificationAttempts = 8;
      let reopened: CuaWindowInfo | undefined;
      for (let attempt = 0; attempt < verificationAttempts; attempt += 1) {
        verificationSignal.throwIfAborted();
        if (!samePostLaunchFileIdentity(await fileIdentityPin(state.path), saved.fileIdentity)) throw new Error("file identity changed");
        verificationSignal.throwIfAborted();
        const inventory = await listWindowInventory(current.driver, current.label, verificationSignal, state.primaryIdentity.pid, true,
          this.options.windowRelationshipProbe, "darwin");
        verificationSignal.throwIfAborted();
        if (inventory.truncated === true) throw new Error("document verification inventory was truncated");
        const matches: CuaWindowInfo[] = [];
        for (const info of inventory.windows) {
          if (info.target.pid !== state.primaryIdentity.pid || info.isOnScreen !== true || info.minimized === true) continue;
          const appResult = await readDocumentIdentityResult(current.driver, current.label, info.target, verificationSignal);
          verificationSignal.throwIfAborted();
          const appProof = parseDocumentIdentityProof(appResult, info.target, info.bounds, state.canonicalExecutableUrl);
          if (appProof === undefined) {
            if (hasExplicitApplicationIdentityConflict(appResult, info.target, state.canonicalExecutableUrl, state.primaryIdentity)) {
              throw new Error("TextEdit application identity changed during document verification");
            }
            continue;
          }
          if (!sameApplicationProcess(appProof.identity, state.primaryIdentity)) {
            throw new Error("TextEdit application identity changed during document verification");
          }
          const documentResult = await readDocumentIdentityResult(current.driver, current.label, info.target, verificationSignal, state.fileUrl);
          verificationSignal.throwIfAborted();
          const proof = parseDocumentIdentityProof(documentResult, info.target, info.bounds, state.canonicalExecutableUrl, state.fileUrl);
          if (proof?.cleanDocument === true && sameApplicationProcess(proof.identity, state.primaryIdentity)) matches.push(info);
        }
        if (matches.length > 1) throw new Error("saved document matched multiple TextEdit windows");
        if (matches.length === 1) {
          reopened = matches[0]!;
          break;
        }
        if (attempt + 1 < verificationAttempts) await delayWithAbort(100, verificationSignal);
      }
      if (reopened === undefined) throw new Error("saved document was not verified before the bounded launch-settle deadline");
      verificationSignal.throwIfAborted();
      if (!samePostLaunchFileIdentity(await fileIdentityPin(state.path), saved.fileIdentity)) throw new Error("file identity changed");
      verificationSignal.throwIfAborted();
      const target = reopened.target;
      let sessionAfter: ComputerSessionDescriptor;
      if (windowIdentityKey(target) !== windowIdentityKey(activeBinding.target)) {
        sessionAfter = await this.transitionWindow(current, target, signal, {
          onScreenOnly: true,
          staleCode: "DOCUMENT_REOPEN_OUTCOME_UNKNOWN",
          staleMessage: "saved document identity changed before the verified transition",
          authorizedTargets: [{ pid: target.pid, windowId: target.windowId }],
          ...(reopened.appName === undefined ? {} : { expectedAppName: reopened.appName }),
          ...(reopened.title === undefined ? {} : { expectedTitle: reopened.title }),
        });
      } else {
        const capture = await captureWindowWithRetry(current.driver, current.label, target, signal,
          this.options.windowCaptureRetry, current.platform);
        const oldRef = current.surfaceRegistry.activeSurface;
        if (oldRef === undefined || !isCurrentSurfaceRef(current.surfaceRegistry, oldRef)) throw new Error("recovery Surface changed after document launch");
        const advanced = advanceSurfaceGeneration(current.surfaceRegistry, oldRef);
        if (advanced.decision !== "applied") throw new Error("recovery Surface generation could not advance");
        const activated = activatePeer(advanced.state, advanced.value, {
          nativeWindow: asNativeWindowIdentity(target), identityVerified: true, captureVerified: true,
        });
        if (activated.decision !== "applied") throw new Error("reopened document Surface could not be activated");
        current.surfaceRegistry = activated.state;
        current.windowBindings.set(windowIdentityKey(capture.binding.target), capture.binding);
        current.descriptor = { ...current.descriptor, viewport: capture.viewport };
        noteSurfaceTransition(current, "peer_switch");
        this.clearTargetObservationState(current, oldRef, activated.value);
        sessionAfter = current.descriptor;
      }
      const finalBinding = activeWindowBinding(current);
      const finalProof = finalBinding === undefined
        ? undefined
        : await queryDocumentIdentity(current.driver, current.label, finalBinding.target, finalBinding.bounds,
          state.canonicalExecutableUrl, signal, state.fileUrl);
      if (finalProof?.cleanDocument !== true || !sameApplicationProcess(finalProof.identity, state.primaryIdentity) ||
          !samePostLaunchFileIdentity(await fileIdentityPin(state.path), saved.fileIdentity)) {
        throw new Error("saved document changed after transition");
      }
      delete state.savedDocument;
      return { actionId: action.actionId, status: "completed", sessionAfter,
        message: "The Host-authorized saved document was reopened and its exact TextEdit window was captured." };
    } catch {
      signal.throwIfAborted();
      return { actionId: action.actionId, status: "partial", driverCode: "DOCUMENT_REOPEN_OUTCOME_UNKNOWN", message: "TextEdit launch was attempted but the saved document could not be verified; do not retry" };
    }
  }

  public async execute(
    session: ComputerSessionDescriptor,
    action: ActionIntent,
    signal: AbortSignal,
    options?: ComputerExecuteOptions,
  ): Promise<ActionReceipt> {
    const current = this.requireSession(session);
    current.firstObservedAfterActionWindows = undefined;
    const taskWindowTransitionPending = current.missingParent !== undefined && current.taskWindowTransition !== undefined;
    if (current.missingParent !== undefined && (!taskWindowTransitionPending || action.kind !== "switch_window")) {
      return refused(action.actionId, "WINDOW_TARGET_INVALIDATED", "missing bound window awaits a fresh explicit switch to its Run-owned task peer; no input was sent");
    }
    current.foregroundMismatchWindowId = undefined;
    current.managedBrowserRestoreEligible = false;
    current.managedBrowserRestoreCandidates.clear();
    current.preActionWindowBaseline = undefined;
    current.proactiveHandoffCandidatesReady = false;
    signal.throwIfAborted();
    if (activeSurfaceUnavailable(current) && !taskWindowTransitionPending) {
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
      if (current.platform === "darwin" && activeWindowBinding(current) !== undefined
        && ["click", "double_click", "right_click", "scroll", "drag"].includes(action.kind)) {
        const executionViewport = this.observations.get(String(executionObservationId))?.viewport;
        if (executionViewport === undefined || executionViewport.width !== decisionObservation.viewport.width || executionViewport.height !== decisionObservation.viewport.height || executionViewport.coordinateSpace !== decisionObservation.viewport.coordinateSpace) {
          return refused(action.actionId, "WINDOW_VIEWPORT_CHANGED", "window screenshot dimensions changed since the decision observation; observe and ground a new action; no input was sent");
        }
      }
      const activeRef = current.surfaceRegistry.activeSurface;
      const taskTransitionObservation = action.kind === "switch_window" && taskWindowTransitionPending &&
        current.taskWindowTransition?.observationSurfaceRef !== undefined &&
        sameSurfaceRef(decisionObservation.surfaceRef, current.taskWindowTransition.observationSurfaceRef) &&
        isCurrentSurfaceRef(current.surfaceRegistry, decisionObservation.surfaceRef) &&
        current.runOwnedTextEditWindows.get(windowIdentityKey(current.taskWindowTransition.target)) === current.taskWindowTransition.candidate;
      if (activeRef === undefined || decisionObservation.surfaceRef.surfaceId !== activeRef.surfaceId ||
          decisionObservation.surfaceRef.generation !== activeRef.generation ||
          decisionObservation.surfaceRef.parentSurfaceId !== activeRef.parentSurfaceId ||
          decisionObservation.surfaceRef.admissionSource !== activeRef.admissionSource ||
          !isExecutableSurfaceRef(current.surfaceRegistry, decisionObservation.surfaceRef)) {
        if (taskTransitionObservation) {
          // The one transition-only observation is an exact fresh frame of the
          // Run-owned live peer. It authorizes only a model-selected switch.
        } else {
        return refused(action.actionId, "SURFACE_REF_STALE", "action Observation is not bound to the current active Surface generation");
        }
      }
    }
    const shortcutPlatform = current.platform;
    const locationBarShortcut = isBrowserShortcut(action, "L", shortcutPlatform);
    const selectAllShortcut = isBrowserShortcut(action, "A", shortcutPlatform);
    const unmodifiedEscape = action.kind === "keypress" && action.keys.length === 1 &&
      ["ESC", "ESCAPE"].includes(action.keys[0]?.trim().toUpperCase() ?? "");
    if (action.kind !== "wait" && action.kind !== "type" && !selectAllShortcut) this.browserChromeInput = undefined;
    if (action.kind === "wait") {
      delete current.lastInspectedExistingTransientRootRef;
      await waitWithAbort(action.durationMs, signal);
      return { actionId: action.actionId, status: "completed" };
    }
    if (action.kind === "switch_window") {
      delete current.lastInspectedExistingTransientRootRef;
      return this.executeWindowSwitch(current, action, signal);
    }
    if (action.kind === "reopen_saved_document") {
      delete current.lastInspectedExistingTransientRootRef;
      return this.executeReopenSavedDocument(current, action, decisionObservation!, signal);
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
    const replayGuard = current.unknownActionReplayGuard;
    let alternativePrimitiveForUnknownAction: string | undefined;
    if (replayGuard !== undefined && !sameSurfaceRef(replayGuard.surfaceRef, activeRefAfterReconcile) &&
        replayGuard.recoveryKind !== "desktop_surface_reconfirmed") {
      delete current.unknownActionReplayGuard;
    } else if (replayGuard !== undefined) {
      const primitiveFingerprint = actionPrimitiveFingerprint(action);
      if (replayGuard.primitiveFingerprints.has(primitiveFingerprint)) {
        return refused(
          action.actionId,
          "ACTION_OUTCOME_UNKNOWN_RETRY_BLOCKED",
          "the same GUI action already had an unknown outcome; choose a different action and re-observe before trying it again",
        );
      }
      alternativePrimitiveForUnknownAction = primitiveFingerprint;
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
        const observedCuaBounds = decisionObservation.cuaBounds ?? decisionObservation.geometry!;
        if (!sameWindowGeometry(liveBinding.bounds, observedCuaBounds)) {
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
        if (decisionObservation.captureSource !== "windows_foreground_region") {
          current.windowBindings.set(windowIdentityKey(liveBinding.target), liveBinding);
          actionWindowBinding = liveBinding;
        }
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
    if ((action.kind === "click" || action.kind === "select_option") && action.groundingRef !== undefined) {
      const desktopGrounding = this.groundings.get(String(action.basedOn));
      const desktopCandidate = desktopGrounding?.elements.get(action.groundingRef);
      if (desktopGrounding?.surfaceRef.kind === "desktop" &&
          (desktopCandidate === undefined ||
          !(await revalidateDesktopManagedGrounding({
            driver: current.driver,
            session: current.label,
            sessionId: session.id,
            grounding: desktopGrounding,
            candidate: desktopCandidate,
            current,
            platform: resolveCapturePlatform(this.options.platform, current.platform),
            ...(this.getDesktopGroundingRelationshipProbe() === undefined ? {} : { relationshipProbe: this.getDesktopGroundingRelationshipProbe()! }),
            ...(this.options.domGroundingTransport === undefined ? {} : { domTransport: this.options.domGroundingTransport }),
            signal,
          })))) {
        return refused(action.actionId, "GROUNDING_REF_STALE", "the managed browser window or tab changed since the desktop observation; no input was sent");
      }
    }
    const multilineTypeDispatch = resolveMultilineTypeDispatch(current.platform, action, this.options.multilineTypeProfile);
    const isMultilineType = multilineTypeDispatch !== "standard";
    const isMultilineUiaType = multilineTypeDispatch === "windows_uia";
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
        viewport: privateGrounding.producerViewport ?? decisionObservation?.viewport ?? session.viewport,
        browserTarget: target,
        candidate: {
          role: resolved.element.role,
          ...(resolved.element.name === undefined ? {} : { name: resolved.element.name }),
          ...(resolved.element.description === undefined ? {} : { description: resolved.element.description }),
          bbox: resolved.dispatchBBox ?? {
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
          if (alternativePrimitiveForUnknownAction !== undefined && current.unknownActionReplayGuard !== undefined &&
              decisionObservation !== undefined && sameSurfaceRef(current.unknownActionReplayGuard.surfaceRef, decisionObservation.surfaceRef)) {
            current.unknownActionReplayGuard.alternativeActionCompleted = true;
          }
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
    // Browser identity also protects native UIA clicks when DOM grounding is
    // disabled; it does not grant access to DOM dispatch or focus validation.
    const managedBrowserTarget = privateGrounding?.browserTarget ?? current.browserTarget;
    if (action.kind === "click" && managedBrowserTarget !== undefined && resolvedGrounding?.geometry !== undefined
      && decisionObservation !== undefined
      && isCollapsedBrowserContentUia(resolvedGrounding.element, decisionObservation.viewport, resolvedGrounding.geometry)) {
      return refused(action.actionId, "GROUNDING_ELEMENT_NOT_ACTIONABLE", "managed-browser UIA content bounds have no reliable clickable interior; scroll into view and observe again; no input was sent");
    }
    const domTransport = this.options.domGroundingTransport;
    // Managed-browser identity is retained for target reconciliation, but it
    // enables DOM-specific dispatch/focus gates only when this Run has an
    // authorized DOM catalog and its Host transport. A companion Host alone
    // must not turn ordinary foreground typing into a DOM-dependent action.
    const domGroundingAvailable = domTransport !== undefined &&
      (this.options.grounding === "dom-catalog-v1" || this.options.grounding === "hybrid-catalog-v1");
    const browserTarget = domGroundingAvailable
      ? privateGrounding?.browserTarget ?? current.browserTarget
      : undefined;
    if (action.kind === "click" && privateGrounding?.catalog.source === "hybrid"
      && resolvedGrounding?.element.source === "uia"
      && isManagedBrowserContainerRole(resolvedGrounding.element.role)) {
      return refused(action.actionId, "MANAGED_BROWSER_CONTAINER_NOT_INTERACTIVE", "managed-browser window/document containers are not interactive controls");
    }
    // Hybrid observations intentionally expose both producers. A model may
    // select the UIA copy of a browser control; when a unique equivalent from
    // the DOM observation exists, prefer that observation-bound CDP path even
    // when the overall DOM catalog is partial. Known target restrictions
    // (such as disabled state or live click validation) remain authoritative.
    // Only a missing or ambiguous match continues through the guarded native
    // point path below with identity, geometry, enabled-state, and exact-point
    // checks.
    const domEquivalent = action.kind === "click"
      && resolvedGrounding?.element.source === "uia"
      && browserTarget !== undefined
      ? findEquivalentDomGrounding(privateGrounding, resolvedGrounding)
      : undefined;
    const browserGrounding = domEquivalent ?? (
      resolvedGrounding?.element.source === "dom" ? resolvedGrounding : undefined
    );
    let validatedEditablePoint: { x: number; y: number } | undefined;
    domClickDispatch: if (action.kind === "click"
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
        viewport: privateGrounding?.producerViewport ?? decisionObservation?.viewport ?? session.viewport,
        browserTarget,
        candidate: {
          role: browserGrounding.element.role,
          ...(browserGrounding.candidateName === undefined ? {} : { name: browserGrounding.candidateName }),
          bbox: browserGrounding.dispatchBBox ?? {
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
        this.browserChromeInput = undefined;
        if (browserGrounding.element.state?.editable === true) {
          if (domTransport.validateClick === undefined || domTransport.verifyFocus === undefined || this.options.windowDeliveryMode !== "foreground") {
            return refused(action.actionId, "DOM_INPUT_FOCUS_UNAVAILABLE", "editable browser click requires verified native foreground delivery; no input was sent");
          }
          const validation = await domTransport.validateClick(request, signal);
          if (validation.status !== "completed" || validation.tabId !== browserTarget.tabId || validation.generation !== browserTarget.generation) {
            return refused(action.actionId, validation.driverCode ?? "DOM_CLICK_GENERATION_MISMATCH", validation.message ?? "editable browser click binding changed; no input was sent");
          }
          this.expectedDomInput = request;
          // One native click performs the browser's actual focus default.
          // DOM validation above is read-only; no programmatic click is sent.
          validatedEditablePoint = browserGrounding.point;
          break domClickDispatch;
        }
        const result = await domTransport.click(request, signal);
        if (result.status === "completed" && (result.tabId !== browserTarget.tabId || result.generation !== browserTarget.generation)) {
          return refused(action.actionId, "DOM_CLICK_GENERATION_MISMATCH", "managed-browser tab or page generation changed; observe again before clicking");
        }
        if (result.status === "completed") {
          if (alternativePrimitiveForUnknownAction !== undefined && current.unknownActionReplayGuard !== undefined &&
              decisionObservation !== undefined && sameSurfaceRef(current.unknownActionReplayGuard.surfaceRef, decisionObservation.surfaceRef)) {
            current.unknownActionReplayGuard.alternativeActionCompleted = true;
          }
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
    // A completed page click is not proof that native typing will reach it.
    // Preserve the expectation across observations, scrolls and waits; only
    // an explicit location-bar shortcut may switch to browser chrome input.
    let chromeVerifiedForAction = false;
    if (action.kind === "type" && this.browserChromeInput !== undefined) {
      const intent = this.browserChromeInput;
      this.browserChromeInput = undefined;
      const surface = current.surfaceRegistry.activeSurface;
      const bound = intent.sessionId === session.id && surface !== undefined &&
        intent.surfaceRef.surfaceId === surface.surfaceId && intent.surfaceRef.generation === surface.generation &&
        isExecutableSurfaceRef(current.surfaceRegistry, intent.surfaceRef) && browserTarget !== undefined &&
        sameBrowserInputTarget(intent.browserTarget, browserTarget);
      const liveFingerprint = !intent.invalidated && bound && decisionObservation !== undefined
        ? await this.readBrowserChromeFocus(current, session, action.basedOn, decisionObservation.viewport, intent.browserTarget, signal)
        : undefined;
      if (intent.fingerprint === undefined || liveFingerprint !== intent.fingerprint) {
        return refused(action.actionId, "BROWSER_CHROME_FOCUS_UNCONFIRMED", "address-bar identity and focus are not positively verified; no keyboard input was sent. Observe and choose a verified target, or set the initial browser URL");
      }
      chromeVerifiedForAction = true;
    }
    let adoptedDomInput = false;
    if (action.kind === "type" && browserTarget !== undefined && this.expectedDomInput === undefined && !chromeVerifiedForAction) {
      const latestGrounding = this.groundings.get(String(options?.executionObservationId ?? action.basedOn));
      const focused = [...(latestGrounding?.elements.values() ?? [])].filter((item) => item.element.source === "dom" && item.element.state?.focused === true && item.element.state.editable === true);
      const candidate = focused.length === 1 ? focused[0] : undefined;
      if (candidate?.candidateFingerprint === undefined || candidate.element.bbox === undefined || latestGrounding?.browserTarget === undefined) {
        return refused(action.actionId, "DOM_INPUT_FOCUS_MISMATCH", "no unique observed editable browser control owns page focus; no keyboard input was sent. Observe again, click the current editable control, then observe before typing");
      }
      adoptedDomInput = true;
      this.expectedDomInput = {
        observationId: options?.executionObservationId ?? action.basedOn,
        computerSessionId: session.id,
        viewport: latestGrounding?.producerViewport ?? decisionObservation?.viewport ?? session.viewport,
        browserTarget: latestGrounding.browserTarget,
        candidate: { role: candidate.element.role, ...(candidate.candidateName === undefined ? {} : { name: candidate.candidateName }), bbox: candidate.dispatchBBox ?? candidate.element.bbox, ...(candidate.candidateFrame === undefined ? {} : { frame: candidate.candidateFrame }), fingerprint: candidate.candidateFingerprint },
      };
    }
    // Escape can cancel editing or dismiss an overlay without entering text.
    // Let it reach the same checked foreground dispatcher even when editable
    // browser focus has moved; keep the expected input binding so every later
    // type or non-Escape keypress must still pass fresh focus verification.
    if ((action.kind === "type" || action.kind === "keypress") && !locationBarShortcut && !unmodifiedEscape && this.expectedDomInput !== undefined) {
      if (domTransport?.verifyFocus === undefined) return refused(action.actionId, "DOM_INPUT_FOCUS_UNAVAILABLE", "managed-browser focus verification unavailable; no keyboard input was sent");
      const expected = this.expectedDomInput;
      try {
        const result = await domTransport.verifyFocus(expected, signal);
        if (result.status !== "completed" || result.tabId !== expected.browserTarget.tabId || result.generation !== expected.browserTarget.generation) {
          if (adoptedDomInput) this.expectedDomInput = undefined;
          return refused(action.actionId, result.driverCode ?? "DOM_INPUT_FOCUS_MISMATCH", "managed-browser input identity or focus changed; no keyboard input was sent. Observe again and click the current editable control before typing");
        }
      } catch (error) {
        signal.throwIfAborted();
        if (adoptedDomInput) this.expectedDomInput = undefined;
        return refused(action.actionId, "DOM_INPUT_FOCUS_UNAVAILABLE", "managed-browser input focus could not be verified; no keyboard input was sent");
      }
    }
    let requestAction = action;
    if (action.groundingRef !== undefined && !isMultilineType) {
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
    if (validatedEditablePoint !== undefined && requestAction.kind === "click") requestAction = { ...requestAction, point: validatedEditablePoint };
    let request: { name: string; arguments: Record<string, unknown> } | undefined;
    try {
      if (!isMultilineUiaType) {
        request = actionRequest(
          requestAction,
          current.label,
          PRIMARY_DESKTOP,
          actionWindowBinding,
          this.options.windowDeliveryMode,
          decisionObservation?.viewport,
          current.platform,
        );
      }
    } catch (error) {
      if (error instanceof WindowCoordinateMappingError) {
        return refused(action.actionId, error.code, error.message);
      }
      throw error;
    }
    const currentWindowBinding = activeWindowBinding(current);
    const commandChord = action.kind === "keypress" && action.keys.length === 2 &&
      action.keys.some((key) => key.toUpperCase() === "CMD" || key.toUpperCase() === "META");
    const createTextEditDocumentShortcut = current.platform === "darwin" &&
      this.options.windowSwitch === "opened-windows-v1" && commandChord &&
      action.kind === "keypress" && action.keys.some((key) => key.toUpperCase() === "N");
    const openTextEditDocumentShortcut = current.platform === "darwin" &&
      this.options.windowSwitch === "opened-windows-v1" && commandChord &&
      action.kind === "keypress" && action.keys.some((key) => key.toUpperCase() === "O");
    const closeShortcut = action.kind === "keypress" && action.keys.length === 2 &&
      action.keys.some((key) => key.toUpperCase() === "W") && commandChord;
    const pendingTextEditOpenIntent = current.runOwnedTextEditOpenIntent !== undefined && !closeShortcut;
    if ((options?.detectNewWindowHandoff === true || createTextEditDocumentShortcut || openTextEditDocumentShortcut ||
        pendingTextEditOpenIntent || closeShortcut) &&
        currentWindowBinding !== undefined && this.options.windowDeliveryMode === "foreground") {
      const parentSurfaceRef = current.surfaceRegistry.activeSurface;
      if (parentSurfaceRef === undefined || !isCurrentSurfaceRef(current.surfaceRegistry, parentSurfaceRef) ||
          !isExecutableSurfaceRef(current.surfaceRegistry, parentSurfaceRef)) {
        return refused(action.actionId, "SURFACE_REF_STALE", "pre-action window inventory has no current executable parent Surface; no input was sent");
      }
      try {
        const scopedPid = createTextEditDocumentShortcut || openTextEditDocumentShortcut || pendingTextEditOpenIntent || closeShortcut
          ? currentWindowBinding.target.pid
          : undefined;
        const visibleInventory = await listWindowInventory(
          current.driver, current.label, signal, scopedPid, false, this.options.windowRelationshipProbe, current.platform,
        );
        signal.throwIfAborted();
        const visibleKeys = new Set(visibleInventory.windows.map((window) => windowIdentityKey(window.target)));
        if (!visibleKeys.has(windowIdentityKey(currentWindowBinding.target))) {
          return refused(action.actionId, "WINDOW_INVENTORY_UNKNOWN", "bound target was missing from visible-window inventory; no input was sent");
        }
        let sourceApplicationIdentity: VerifiedApplicationIdentity | undefined;
        if (createTextEditDocumentShortcut || openTextEditDocumentShortcut) {
          try {
            sourceApplicationIdentity = (await queryDocumentIdentity(
              current.driver, current.label, currentWindowBinding.target, currentWindowBinding.bounds,
              TEXTEDIT_EXECUTABLE_URL, signal,
            ))?.identity;
          } catch {
            signal.throwIfAborted();
          }
        }
        current.preActionWindowBaseline = {
          actionId: action.actionId,
          sourceObservationId: action.basedOn,
          closeShortcut,
          createTextEditDocumentShortcut,
          openTextEditDocumentShortcut,
          ...(sourceApplicationIdentity === undefined ? {} : { sourceApplicationIdentity }),
          completed: false,
          targetKeys: visibleKeys,
          windowRows: visibleInventory.windows.map((window) => ({
            ...window,
            bounds: { ...window.bounds },
            target: { ...window.target },
          })),
          complete: visibleInventory.complete,
          truncated: visibleInventory.truncated === true,
          parentSurfaceRef: { ...parentSurfaceRef },
          ...(decisionObservation?.cuaBounds === undefined ? {} : { parentCuaBounds: { ...decisionObservation.cuaBounds } }),
          parentBinding: { target: { ...currentWindowBinding.target }, bounds: { ...currentWindowBinding.bounds } },
        };
        current.firstObservedAfterActionWindows = undefined;
        current.visibleWindowBaseline = visibleKeys;
        current.newlySurfacedWindowKeys = new Set();
        current.newHandoffCandidates = [];
      } catch (error) {
        signal.throwIfAborted();
        return refused(action.actionId, "WINDOW_INVENTORY_UNKNOWN", "visible-window inventory failed before action; no input was sent");
      }
    }
    if (isMultilineUiaType) {
      // Preserve normal Surface/window preflight, then fail closed in the
      // Windows UIA route before any input primitive is dispatched. The
      // Host-only foreground-caret path remains on its separate input route.
      const receipt = await this.executeMultilineType(
        current,
        session,
        action as Extract<ActionIntent, { kind: "type" }>,
        decisionObservation,
        actionWindowBinding,
        signal,
      );
      if (receipt.status === "completed" && current.preActionWindowBaseline?.actionId === action.actionId) current.preActionWindowBaseline.completed = true;
      if (receipt.status === "completed" && alternativePrimitiveForUnknownAction !== undefined &&
          current.unknownActionReplayGuard !== undefined && decisionObservation !== undefined &&
          sameSurfaceRef(current.unknownActionReplayGuard.surfaceRef, decisionObservation.surfaceRef)) {
        current.unknownActionReplayGuard.alternativeActionCompleted = true;
      }
      return receipt;
    }
    if (request === undefined) throw new Error("CUA action request was not constructed");
    delete current.lastInspectedExistingTransientRootRef;
    try {
      // Tab is permitted only after the old target's focus gate above. Drop its
      // binding before dispatch; a fresh observation and verifyFocus must prove
      // the next target, even if the Tab dispatch has an unknown outcome.
      if (action.kind === "keypress" && (action.keys.length === 1 && action.keys[0]?.toUpperCase() === "TAB" || action.keys.length === 2 && action.keys.some((key) => key.toUpperCase() === "TAB") && action.keys.some((key) => key.toUpperCase() === "SHIFT"))) this.expectedDomInput = undefined;
      if (action.kind === "click" && browserTarget !== undefined) this.browserChromeInput = undefined;
      // A successful location-bar shortcut permits just one text dispatch.
      // Consume before dispatch so an unknown outcome cannot reuse it.
      if (action.kind === "type" && browserTarget !== undefined) this.browserChromeInput = undefined;
      const result = await callTool(current.driver, request.name, request.arguments, signal);
      if (result.isError) {
        const incompleteTypeText = nativeIncompleteTypeTextReceipt(
          action.actionId, request.name, result.errorCode, result.structuredJson,
        );
        if (incompleteTypeText !== undefined) {
          this.invalidateObservationAfterAction(current);
          return incompleteTypeText;
        }
        const driverCode = windowRefusalCode(
          result.errorCode, result.text, resultProvesNoInput(result, request.name), request.name,
          result.structuredJson, actionWindowBinding?.target,
        );
        if (decisionObservation !== undefined && isTransientSurface(current, decisionObservation.surfaceRef) &&
            driverCode === "WINDOW_FOREGROUND_MISMATCH" &&
            await this.restoreTransientParentAfterExplicitNoInput(current, decisionObservation.surfaceRef, signal)) {
          return refused(
            action.actionId,
            "WINDOW_FOREGROUND_REFUSED_PARENT_RESTORED",
            "The driver confirmed that no input was sent. The transient window closed and its exact parent was freshly captured. Inspect the refreshed screen and choose the next step.",
          );
        }
        if (decisionObservation !== undefined && isTransientSurface(current, decisionObservation.surfaceRef) &&
            driverCode === "CUA_TOOL_REFUSED" && isAmbiguousForegroundResult(result.text)) {
          const recoveredReceipt = await this.recoverUnknownTransientActionReceipt(
            current,
            action,
            decisionObservation.surfaceRef,
            signal,
          );
          if (recoveredReceipt !== undefined) return recoveredReceipt;
          this.clearTargetObservationState(current, decisionObservation.surfaceRef);
          throw new Error("CUA changed foreground while dispatching the action and did not confirm that input was withheld; action outcome is unknown");
        }
        if (decisionObservation !== undefined && driverCode === "CUA_TOOL_REFUSED" &&
            isAmbiguousForegroundResult(result.text)) {
          // CUA 0.22.2 emits this form after the foreground click's SendInput
          // dispatch and post-action foreground check. It is not proof that
          // input was withheld. Invalidate the old Observation while retaining
          // the one-shot pre-action inventory for a fresh, read-only recovery
          // or Host handoff; never report a retry-safe refusal here.
          this.invalidateObservationAfterAction(current);
          return await this.unknownForegroundActionReceipt(current, action, decisionObservation.surfaceRef, request, actionWindowBinding, signal);
        }
        if (driverCode === "WINDOW_FOREGROUND_MISMATCH") {
          current.foregroundMismatchWindowId = parseActualForegroundWindowId(result.text);
          current.managedBrowserRestoreEligible = resultProvesNoInput(result, request.name);
        }
        const refusalMessage = pointBlockedGuardRefusalMessage({
          actionKind: action.kind,
          toolName: request.name,
          message: result.text,
          ...(result.structuredJson === undefined ? {} : { structuredJson: result.structuredJson }),
          ...(actionWindowBinding?.target === undefined ? {} : { bindingTarget: actionWindowBinding.target }),
          requestedTarget: request.arguments.target,
        });
        return refused(action.actionId, driverCode, refusalMessage ?? result.text);
      }
      if (result.degraded) {
        return { actionId: action.actionId, status: "failed", driverCode: "CUA_DEGRADED", message: result.text };
      }
      if (decisionObservation !== undefined &&
          this.isExactPrimaryDesktopAction(current, decisionObservation.surfaceRef, request, actionWindowBinding) &&
          this.canSettleLocalWindowsDesktopObservation(current)) {
        // A successful local Windows foreground desktop GUI dispatch can be
        // followed by a paint-only transition; settling does not verify its effect.
        current.pendingPostGuiActionObservationAt = performance.now();
      }
      if (locationBarShortcut && browserTarget !== undefined && decisionObservation !== undefined) {
        this.expectedDomInput = undefined;
        const fingerprint = await this.readBrowserChromeFocus(current, session, action.basedOn, decisionObservation.viewport, browserTarget, signal);
        this.browserChromeInput = {
          sessionId: session.id,
          surfaceRef: { ...decisionObservation.surfaceRef },
          browserTarget: { ...browserTarget, windowTarget: { ...browserTarget.windowTarget } },
          ...(fingerprint === undefined ? {} : { fingerprint }),
          invalidated: fingerprint === undefined,
        };
      } else if (action.kind === "click") this.browserChromeInput = undefined;
      else if (action.kind === "keypress" && !selectAllShortcut) this.browserChromeInput = undefined;
      if (alternativePrimitiveForUnknownAction !== undefined && current.unknownActionReplayGuard !== undefined &&
          decisionObservation !== undefined && sameSurfaceRef(current.unknownActionReplayGuard.surfaceRef, decisionObservation.surfaceRef)) {
        current.unknownActionReplayGuard.alternativeActionCompleted = true;
      }
      const diagnostic = currentWindowBinding !== undefined && ["click", "scroll", "drag"].includes(action.kind)
        ? `cua-window-pixels source=${decisionObservation?.captureSource ?? "unknown"} viewport=${decisionObservation?.viewport.width}x${decisionObservation?.viewport.height} bounds=${currentWindowBinding.bounds.width}x${currentWindowBinding.bounds.height} target=${currentWindowBinding.target.pid}/${currentWindowBinding.target.windowId} delivery=${this.options.windowDeliveryMode ?? "background"} point=${JSON.stringify(Object.fromEntries(Object.entries(request.arguments).filter(([key]) => ["x", "y", "from_x", "from_y", "to_x", "to_y"].includes(key))))}`
        : undefined;
      const completedLifecycleBaseline = current.preActionWindowBaseline?.actionId === action.actionId
        ? current.preActionWindowBaseline
        : undefined;
      let runCreatedTextEditPeer = false;
      if (completedLifecycleBaseline !== undefined) {
        completedLifecycleBaseline.completed = true;
        if (completedLifecycleBaseline.createTextEditDocumentShortcut) {
          try {
            runCreatedTextEditPeer = await this.recordRunOwnedTextEditWindow(current, completedLifecycleBaseline, signal);
          } catch {
            signal.throwIfAborted();
          }
        }
        if (completedLifecycleBaseline.openTextEditDocumentShortcut) {
          this.recordRunOwnedTextEditOpenIntent(current, completedLifecycleBaseline);
        } else if (current.runOwnedTextEditOpenIntent !== undefined) {
          if (completedLifecycleBaseline.closeShortcut) {
            delete current.runOwnedTextEditOpenIntent;
          } else {
            try {
              await this.recordRunOwnedTextEditOpenedWindow(current, completedLifecycleBaseline, signal);
            } catch {
              signal.throwIfAborted();
              delete current.runOwnedTextEditOpenIntent;
            }
          }
        }
        if (completedLifecycleBaseline.closeShortcut) {
          try {
            await this.beginTaskWindowTransitionAfterClose(current, completedLifecycleBaseline, signal);
          } catch {
            signal.throwIfAborted();
          }
        }
      }
      const runCreatedPeerGuidance = runCreatedTextEditPeer
        ? "A Run-created TextEdit peer was verified from this completed action. It may now have physical foreground while isCurrent still marks the Run-bound target, not physical focus. Use list_windows, then switch_window to the intended fresh ref even if isCurrent is true before input or closing, and wait for the fresh observation before continuing."
        : undefined;
      const message = [result.text, diagnostic, runCreatedPeerGuidance].filter(Boolean).join("; ");
      return { actionId: action.actionId, status: "completed", ...(message ? { message } : {}) };
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
        const incompleteTypeText = nativeIncompleteTypeTextReceipt(
          action.actionId, request.name, details.errorCode, details.structuredJson,
        );
        if (incompleteTypeText !== undefined) {
          this.invalidateObservationAfterAction(current);
          return incompleteTypeText;
        }
        const structuredNoInput = resultProvesNoInput({
          text: details.message,
          ...(details.structuredJson === undefined ? {} : { structuredJson: details.structuredJson }),
        }, request.name);
        const driverCode = windowRefusalCode(
          details.errorCode, details.message, structuredNoInput, request.name,
          details.structuredJson, actionWindowBinding?.target,
        );
        if (decisionObservation !== undefined && isTransientSurface(current, decisionObservation.surfaceRef) &&
            driverCode === "WINDOW_FOREGROUND_MISMATCH" &&
            await this.restoreTransientParentAfterExplicitNoInput(current, decisionObservation.surfaceRef, signal)) {
          return refused(
            action.actionId,
            "WINDOW_FOREGROUND_REFUSED_PARENT_RESTORED",
            "The driver confirmed that no input was sent. The transient window closed and its exact parent was freshly captured. Inspect the refreshed screen and choose the next step.",
          );
        }
        if (decisionObservation !== undefined && isTransientSurface(current, decisionObservation.surfaceRef) &&
            driverCode === "CUA_TOOL_REFUSED" && isAmbiguousForegroundResult(details.message)) {
          const recoveredReceipt = await this.recoverUnknownTransientActionReceipt(
            current,
            action,
            decisionObservation.surfaceRef,
            signal,
          );
          if (recoveredReceipt !== undefined) return recoveredReceipt;
          this.clearTargetObservationState(current, decisionObservation.surfaceRef);
          throw normalizeDriverError(new Error("CUA changed foreground while dispatching the action and did not confirm that input was withheld; action outcome is unknown"), "execute");
        }
        if (decisionObservation !== undefined && driverCode === "CUA_TOOL_REFUSED" &&
            isAmbiguousForegroundResult(details.message)) {
          this.invalidateObservationAfterAction(current);
          return await this.unknownForegroundActionReceipt(current, action, decisionObservation.surfaceRef, request, actionWindowBinding, signal);
        }
        if (driverCode === "WINDOW_FOREGROUND_MISMATCH") {
          current.foregroundMismatchWindowId = parseActualForegroundWindowId(details.message);
          current.managedBrowserRestoreEligible = structuredNoInput;
        }
        const refusalMessage = pointBlockedGuardRefusalMessage({
          actionKind: action.kind,
          toolName: request.name,
          message: details.message,
          ...(details.structuredJson === undefined ? {} : { structuredJson: details.structuredJson }),
          ...(actionWindowBinding?.target === undefined ? {} : { bindingTarget: actionWindowBinding.target }),
          requestedTarget: request.arguments.target,
        });
        return refused(action.actionId, driverCode, refusalMessage ?? details.message);
      }
      throw normalizeDriverError(error, "execute");
    }
  }

  private async readBrowserChromeFocus(
    current: PrivateSession,
    session: ComputerSessionDescriptor,
    observationId: ObservationId,
    viewport: Viewport,
    browserTarget: ManagedBrowserTarget,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const binding = activeWindowBinding(current);
    const transport = this.options.domGroundingTransport;
    if (binding === undefined || transport === undefined || !managedBrowserTargetForBinding(current, binding) ||
        windowIdentityKey(binding.target) !== windowIdentityKey(browserTarget.windowTarget)) return undefined;
    try {
      const uia = await readGroundingCatalog(current.driver, current.label, binding, viewport, observationId, session.id, signal, true, current.platform === "darwin");
      if (uia.catalog.degraded || uia.contentRect === undefined) return undefined;
      const focused = [...uia.elements.values()].filter((item) => item.element.state?.focused === true);
      const candidate = uia.catalog.completeness === "complete"
        ? focused.length === 1 ? focused[0] : undefined
        : current.platform === "darwin" ? uia.focusProof : undefined;
      if (candidate?.uiaIdentityFingerprint === undefined || !isAddressBarElement(candidate.element)) return undefined;
      const dom = await transport.collect({ observationId, computerSessionId: session.id, viewport, browserTarget }, signal);
      if (dom.complete !== true || dom.degraded === true || dom.tabId !== browserTarget.tabId || dom.generation !== browserTarget.generation ||
          dom.candidates.some((item) => item.state?.focused === true)) return undefined;
      return candidate.uiaIdentityFingerprint;
    } catch {
      signal.throwIfAborted();
      return undefined;
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
    if (action.basedOn !== this.latestObservationId) {
      this.clearTargetObservationState(current, decisionObservation?.surfaceRef);
      return refused(action.actionId, "MULTILINE_OBSERVATION_STALE", "multiline input requires the latest observation; observe again before typing");
    }
    let grounding = this.groundings.get(String(action.basedOn));
    if (grounding === undefined) {
      // `grounding: off` deliberately suppresses public Observation catalogs,
      // but Windows multiline typing still needs the same private UIA
      // identity/read-back proof as the opt-in catalog route. Resolve it only
      // for this exact action target and keep the result local: it is not an
      // Observation capability or a reusable element reference.
      if (action.groundingRef !== undefined) {
        return refused(action.actionId, "MULTILINE_GROUNDING_REF_STALE", "no UIA element reference was published for this observation; observe with grounding enabled to select an explicit target");
      }
      if (decisionObservation === undefined || actionWindowBinding === undefined ||
          decisionObservation.geometry === undefined || String(current.descriptor.id) !== String(session.id) ||
          decisionObservation.sessionId !== String(session.id)) {
        return refused(action.actionId, "MULTILINE_GROUNDING_UNAVAILABLE", "multiline input requires an exact current window and Computer session");
      }
      signal.throwIfAborted();
      const privateCatalog = await readMultilinePrivateGroundingCatalog(
        current.driver,
        current.label,
        actionWindowBinding,
        decisionObservation.viewport,
        action.basedOn,
        session.id,
        signal,
        current.platform === "darwin",
      );
      signal.throwIfAborted();

      // The query is asynchronous. Do not bind its tokens to an Observation
      // that was superseded or whose active Surface/window changed meanwhile.
      const latestObservation = this.observations.get(String(action.basedOn));
      const activeRef = current.surfaceRegistry.activeSurface;
      const liveBinding = activeWindowBinding(current);
      if (this.latestObservationId !== action.basedOn || latestObservation !== decisionObservation ||
          activeRef === undefined || activeRef.surfaceId !== decisionObservation.surfaceRef.surfaceId ||
          activeRef.generation !== decisionObservation.surfaceRef.generation ||
          activeRef.parentSurfaceId !== decisionObservation.surfaceRef.parentSurfaceId ||
          activeRef.admissionSource !== decisionObservation.surfaceRef.admissionSource ||
          !isExecutableSurfaceRef(current.surfaceRegistry, decisionObservation.surfaceRef) ||
          liveBinding === undefined || windowIdentityKey(liveBinding.target) !== windowIdentityKey(actionWindowBinding.target) ||
          !sameWindowGeometry(liveBinding.bounds, actionWindowBinding.bounds) ||
          !sameWindowGeometry(actionWindowBinding.bounds, decisionObservation.geometry)) {
        return refused(action.actionId, "MULTILINE_GROUNDING_STALE", "the active observation, Surface, or exact window changed during private UIA resolution; observe again");
      }
      grounding = {
        ...privateCatalog,
        catalog: { ...privateCatalog.catalog, surfaceRef: decisionObservation.surfaceRef },
        surfaceRef: decisionObservation.surfaceRef,
        windowBinding: actionWindowBinding,
      };
    }
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
    delete current.lastInspectedExistingTransientRootRef;
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
    const sdkModule = await loadCuaSdkModule();
    try {
      let result;
      try {
        result = await awaitWithDeadline(
          () => current.driver.endSession(sdkModule.EndSessionInput.new({ session: current.label })),
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
          () => current.driver.endSession(sdkModule.EndSessionInput.new({ session: current.label })),
          deadline,
          "endSession",
        );
      }
      if (result.active) {
        await waitForCleanupPoll(deadline);
        result = await awaitWithDeadline(
          () => current.driver.endSession(sdkModule.EndSessionInput.new({ session: current.label })),
          deadline,
          "endSession",
        );
      }
      if (result.active) {
        await waitForCleanupPoll(deadline);
        result = await awaitWithDeadline(
          () => current.driver.endSession(sdkModule.EndSessionInput.new({ session: current.label })),
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

  private getDesktopGroundingRelationshipProbe(): WindowRelationshipProbe | undefined {
    const desktopProbe = this.options.desktopGroundingRelationshipProbe;
    if (desktopProbe === undefined) return this.options.windowRelationshipProbe;
    return {
      async read(signal) {
        // Desktop grounding needs a stable foreground/z snapshot, but Win32's
        // EnumWindows and z-chain reads are not atomic. Resample only bounded,
        // non-truncated partial snapshots; this never retries input or broadens
        // the regular window-switch inventory.
        let latest: Awaited<ReturnType<WindowRelationshipProbe["read"]>> | undefined;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          signal.throwIfAborted();
          latest = await desktopProbe.read(signal);
          if (latest.complete || latest.truncated === true || signal.aborted || attempt === 2) return latest;
        }
        return latest!;
      },
    };
  }
}

function sameBrowserInputTarget(left: ManagedBrowserTarget, right: ManagedBrowserTarget): boolean {
  return left.profileId === right.profileId && left.tabId === right.tabId && left.generation === right.generation &&
    left.windowTarget.pid === right.windowTarget.pid && left.windowTarget.windowId === right.windowTarget.windowId;
}

function isAddressBarElement(element: GroundingElement): boolean {
  // Positive browser-owned chrome semantics only. Unknown localized names or
  // incomplete AX/UIA evidence remain unsupported, never inferred from no DOM focus.
  const name = normalizeGroundingName(element.name);
  return element.source === "uia" && element.browserRegion === "chrome" && element.state?.enabled !== false &&
    element.state?.editable === true && element.state.focused === true &&
    ["edit", "textbox", "textfield", "combobox"].includes(normalizeGroundingRole(element.role)) &&
    ["address and search bar", "search or enter web address", "地址和搜索栏", "地址栏", "搜索或输入网址"].includes(name ?? "");
}

type GroundingToolResult = {
  readonly isError?: boolean;
  readonly degraded?: boolean;
  readonly structuredJson?: string;
};

interface AuthorizedDesktopGroundingInput {
  readonly mode: CuaGroundingMode | undefined;
  readonly driver: CuaDriverLike;
  readonly session: string;
  readonly sessionId: ComputerSessionDescriptor["id"];
  readonly observationId: ObservationId;
  readonly desktopViewport: Viewport;
  readonly current: PrivateSession;
  readonly captureRetryOptions: WindowCaptureRetryOptions;
  readonly platform: NodeJS.Platform;
  readonly relationshipProbe?: WindowRelationshipProbe;
  readonly domTransport?: DomGroundingTransport;
  readonly signal: AbortSignal;
}

/**
 * Project one exact Host-authorized foreground window onto a full desktop
 * observation. The inventory is used only as a visibility/occlusion check;
 * unrelated rows never become Surfaces or grounding candidates.
 */
async function readAuthorizedDesktopGrounding(
  input: AuthorizedDesktopGroundingInput,
): Promise<PrivateGrounding | undefined> {
  const { mode, driver, session, sessionId, observationId, desktopViewport, current, signal } = input;
  const hostBrowserTarget = current.managedBrowserTarget;
  const activeBrowserTarget = current.browserTarget ?? hostBrowserTarget;
  if (mode !== "hybrid-catalog-v1" || hostBrowserTarget === undefined || activeBrowserTarget === undefined ||
      desktopViewport.coordinateSpace !== "physical" ||
      hostBrowserTarget.profileId !== activeBrowserTarget.profileId ||
      windowIdentityKey(hostBrowserTarget.windowTarget) !== windowIdentityKey(activeBrowserTarget.windowTarget)) return undefined;
  // Only the exact Browser target issued by the managed-browser Host is a
  // desktop grounding source. The broader opened-window inventory remains a
  // picker input and never authorizes additional native-app candidates here.
  const authorized = new Map<string, CuaWindowTarget>([[windowIdentityKey(hostBrowserTarget.windowTarget), hostBrowserTarget.windowTarget]]);

  try {
    const before = await listWindowInventory(driver, session, signal, undefined, true, input.relationshipProbe, input.platform);
    const target = foregroundAuthorizedWindow(before, authorized);
    if (target === undefined) return undefined;
    const capture = await captureWindowWithRetry(
      driver,
      session,
      target.target,
      signal,
      input.captureRetryOptions,
      input.platform,
    );
    if (windowIdentityKey(capture.binding.target) !== windowIdentityKey(target.target) ||
        !sameWindowGeometry(capture.binding.bounds, target.bounds) || capture.viewport.coordinateSpace !== "physical") {
      return undefined;
    }

    const grounding = await readWindowGrounding(
      mode,
      driver,
      session,
      capture.binding,
      capture.viewport,
      observationId,
      sessionId,
      activeBrowserTarget,
      input.domTransport,
      signal,
      false,
      input.platform === "darwin",
    );
    signal.throwIfAborted();
    if (grounding === undefined || grounding.elements.size === 0 || grounding.browserTarget === undefined) return undefined;
    if (grounding.browserTarget.profileId !== activeBrowserTarget.profileId ||
        windowIdentityKey(grounding.browserTarget.windowTarget) !== windowIdentityKey(activeBrowserTarget.windowTarget)) {
      return undefined;
    }
    if (grounding.browserTarget.tabId !== activeBrowserTarget.tabId || grounding.browserTarget.generation !== activeBrowserTarget.generation) {
      // A fresh host attestation can discover a user-selected tab, but it is
      // not the tab shown in the desktop frame captured for this observation.
      // Adopt that exact page for the next observation and keep this one visual.
      current.browserTarget = grounding.browserTarget;
      return undefined;
    }

    const after = await listWindowInventory(driver, session, signal, undefined, true, input.relationshipProbe, input.platform);
    if (!sameForegroundWindowSnapshot(before, after, target)) return undefined;
    return projectGroundingToDesktop(grounding, capture, desktopViewport, target, after, input.platform);
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted();
    // Desktop capture remains usable when an optional authorized grounding
    // read is incomplete or unavailable.
    return undefined;
  }
}

function foregroundAuthorizedWindow(
  inventory: CuaWindowInventory,
  authorized: ReadonlyMap<string, CuaWindowTarget>,
): CuaWindowInfo | undefined {
  if (!inventory.complete || inventory.truncated === true || inventory.foregroundPid === undefined || inventory.foregroundWindowId === undefined) return undefined;
  const foreground = { pid: inventory.foregroundPid, windowId: inventory.foregroundWindowId };
  if (!authorized.has(windowIdentityKey(foreground))) return undefined;
  const matches = inventory.windows.filter((window) => windowIdentityKey(window.target) === windowIdentityKey(foreground));
  const target = matches.length === 1 ? matches[0] : undefined;
  if (target === undefined || target.isOnScreen !== true || target.minimized === true || target.zIndex === undefined) return undefined;
  return target;
}

function sameForegroundWindowSnapshot(
  before: CuaWindowInventory,
  after: CuaWindowInventory,
  target: CuaWindowInfo,
): boolean {
  if (!after.complete || after.truncated === true ||
      after.foregroundPid !== target.target.pid || after.foregroundWindowId !== target.target.windowId) return false;
  const matches = after.windows.filter((window) => windowIdentityKey(window.target) === windowIdentityKey(target.target));
  const latest = matches.length === 1 ? matches[0] : undefined;
  const original = before.windows.find((window) => windowIdentityKey(window.target) === windowIdentityKey(target.target));
  return latest !== undefined && original !== undefined && latest.isOnScreen === true && latest.minimized !== true &&
    latest.zIndex === original.zIndex && sameWindowGeometry(latest.bounds, target.bounds);
}

interface DesktopGroundingFreshnessInput {
  readonly driver: CuaDriverLike;
  readonly session: string;
  readonly sessionId: ComputerSessionDescriptor["id"];
  readonly grounding: BoundPrivateGrounding;
  readonly candidate: PrivateGroundingElement;
  readonly current: PrivateSession;
  readonly relationshipProbe?: WindowRelationshipProbe;
  readonly platform: NodeJS.Platform;
  readonly domTransport?: DomGroundingTransport;
  readonly signal: AbortSignal;
}

/** Read-only freshness gate for an explicit desktop grounding reference. */
async function revalidateDesktopManagedGrounding(input: DesktopGroundingFreshnessInput): Promise<boolean> {
  const { grounding, candidate, current, driver, session, signal } = input;
  const binding = grounding.windowBinding;
  const browserTarget = grounding.browserTarget;
  const hostTarget = current.managedBrowserTarget;
  const transport = input.domTransport;
  const viewport = grounding.producerViewport;
  if (grounding.surfaceRef.kind !== "desktop" || binding === undefined || browserTarget === undefined ||
      hostTarget === undefined || transport?.collect === undefined || viewport === undefined ||
      browserTarget.profileId !== hostTarget.profileId ||
      windowIdentityKey(browserTarget.windowTarget) !== windowIdentityKey(hostTarget.windowTarget) ||
      windowIdentityKey(binding.target) !== windowIdentityKey(browserTarget.windowTarget)) return false;
  const authorized = new Map<string, CuaWindowTarget>([[windowIdentityKey(hostTarget.windowTarget), hostTarget.windowTarget]]);
  const bbox = candidate.element.bbox;
  const transform = desktopGroundingCoordinateTransform(
    viewport,
    binding.bounds,
    input.platform,
    grounding.nativeToDesktopScale,
  );
  if (bbox === undefined || bbox.coordinateSpace !== "physical" ||
      transform === undefined ||
      ![bbox.x, bbox.y, bbox.width, bbox.height].every(Number.isFinite) ||
      bbox.width <= 0 || bbox.height <= 0) return false;
  try {
    const before = await listWindowInventory(driver, session, signal, undefined, true, input.relationshipProbe, input.platform);
    const target = foregroundAuthorizedWindow(before, authorized);
    if (target === undefined || !sameWindowGeometry(target.bounds, binding.bounds) ||
        isOccludedDesktopGroundingCandidate(bbox, target, before, transform.nativeToDesktopScaleX, transform.nativeToDesktopScaleY)) return false;
    const activePage = await transport.collect({
      observationId: grounding.catalog.observationId,
      computerSessionId: input.sessionId,
      viewport,
      browserTarget,
    }, signal);
    const after = await listWindowInventory(driver, session, signal, undefined, true, input.relationshipProbe, input.platform);
    const latestTarget = foregroundAuthorizedWindow(after, authorized);
    if (latestTarget === undefined || !sameForegroundWindowSnapshot(before, after, target) ||
        !sameWindowGeometry(latestTarget.bounds, binding.bounds) ||
        isOccludedDesktopGroundingCandidate(bbox, latestTarget, after, transform.nativeToDesktopScaleX, transform.nativeToDesktopScaleY)) return false;
    if (!isBoundedBrowserIdentity(activePage.tabId) || !isBoundedBrowserIdentity(activePage.generation)) return false;
    if (activePage.tabId !== browserTarget.tabId || activePage.generation !== browserTarget.generation) {
      // The exact Host-owned window now shows a different managed tab. Keep
      // the next observation aligned with that Host attestation; never retarget
      // the current action's old element reference.
      current.browserTarget = { ...browserTarget, tabId: activePage.tabId, generation: activePage.generation };
      return false;
    }
    return true;
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted();
    return false;
  }
}

function projectGroundingToDesktop(
  grounding: PrivateGrounding,
  capture: CuaWindowCapture,
  desktopViewport: Viewport,
  target: CuaWindowInfo,
  inventory: CuaWindowInventory,
  platform: NodeJS.Platform,
): PrivateGrounding | undefined {
  const bounds = capture.binding.bounds;
  const transform = desktopGroundingCoordinateTransform(capture.viewport, bounds, platform, capture.nativeToDesktopScale);
  if (transform === undefined) return undefined;
  // Win32 window bounds and the desktop viewport are both native physical
  // pixels. Window captures may be reduced, so undo that reduction for local
  // candidate geometry while keeping the native window origin unchanged.
  // macOS window bounds are logical points; retain the established Retina
  // backing-scale projection for both origin and unrelated inventory rows.
  // Other platforms keep the previous logical-origin behavior.
  const windowFrame = {
    x: bounds.x * transform.nativeToDesktopScaleX,
    y: bounds.y * transform.nativeToDesktopScaleY,
  };

  const elements = new Map<string, PrivateGroundingElement>();
  const publicElements: GroundingElement[] = [];
  for (const observedElement of grounding.catalog.elements) {
    const elementRef = observedElement.elementRef;
    const candidate = grounding.elements.get(elementRef);
    if (candidate === undefined) continue;
    const local = candidate.element.bbox;
    if (local === undefined || local.coordinateSpace !== "physical") continue;
    const bbox = {
      x: windowFrame.x + local.x * transform.localToDesktopScaleX,
      y: windowFrame.y + local.y * transform.localToDesktopScaleY,
      width: local.width * transform.localToDesktopScaleX,
      height: local.height * transform.localToDesktopScaleY,
      coordinateSpace: "physical" as const,
    };
    if (bbox.x < 0 || bbox.y < 0 || bbox.x + bbox.width > desktopViewport.width || bbox.y + bbox.height > desktopViewport.height ||
        isOccludedDesktopGroundingCandidate(bbox, target, inventory, transform.nativeToDesktopScaleX, transform.nativeToDesktopScaleY)) continue;
    const point = {
      x: windowFrame.x + candidate.point.x * transform.localToDesktopScaleX,
      y: windowFrame.y + candidate.point.y * transform.localToDesktopScaleY,
    };
    const element: GroundingElement = { ...candidate.element, bbox };
    elements.set(elementRef, {
      ...candidate,
      element,
      point,
      dispatchBBox: {
        x: local.x,
        y: local.y,
        width: local.width,
        height: local.height,
      },
    });
    publicElements.push(element);
  }
  if (elements.size === 0) return undefined;
  // Table text still uses window-capture coordinates and has no trustworthy
  // desktop overlay intersection test. Keep it available to native-window
  // observations only until both geometry and occlusion can be proven.
  const { visibleText: windowLocalVisibleText, ...desktopCatalog } = grounding.catalog;
  void windowLocalVisibleText;
  return {
    ...grounding,
    windowBinding: capture.binding,
    producerViewport: capture.viewport,
    nativeToDesktopScale: transform.nativeToDesktopScaleX,
    elements,
    catalog: {
      ...desktopCatalog,
      ...(publicElements.length === grounding.catalog.elements.length ? {} : { completeness: "partial" as const }),
      elements: publicElements,
    },
  };
}

interface DesktopGroundingCoordinateTransform {
  /** Map native/logical origins and inventory bounds into desktop physical pixels. */
  readonly nativeToDesktopScaleX: number;
  readonly nativeToDesktopScaleY: number;
  /** Map window-capture-local physical pixels into desktop physical pixels. */
  readonly localToDesktopScaleX: number;
  readonly localToDesktopScaleY: number;
}

function desktopGroundingCoordinateTransform(
  viewport: Viewport,
  bounds: CuaWindowBinding["bounds"],
  platform: NodeJS.Platform,
  reportedNativeToDesktopScale?: number,
): DesktopGroundingCoordinateTransform | undefined {
  if (![viewport.width, viewport.height, bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ||
      viewport.width <= 0 || viewport.height <= 0 || bounds.width <= 0 || bounds.height <= 0) return undefined;
  const captureScaleX = viewport.width / bounds.width;
  const captureScaleY = viewport.height / bounds.height;
  if (![captureScaleX, captureScaleY].every(Number.isFinite) || captureScaleX <= 0 || captureScaleY <= 0 ||
      Math.abs(captureScaleX - captureScaleY) > Math.max(captureScaleX, captureScaleY) * 0.01) return undefined;

  if (platform === "win32") {
    // Win32 bounds are already in desktop physical pixels. Only the local
    // image-space candidate needs the inverse of the actual capture reduction.
    return {
      nativeToDesktopScaleX: 1,
      nativeToDesktopScaleY: 1,
      localToDesktopScaleX: 1 / captureScaleX,
      localToDesktopScaleY: 1 / captureScaleY,
    };
  }

  if (platform === "darwin") {
    // macOS reports logical native geometry and explicitly reports screenshot
    // backing scale in get_window_state metadata. Capture/nativeBounds is only
    // the image sampling ratio; do not confuse it with Retina scale.
    if (reportedNativeToDesktopScale !== 1 && reportedNativeToDesktopScale !== 2) return undefined;
    return {
      nativeToDesktopScaleX: reportedNativeToDesktopScale,
      nativeToDesktopScaleY: reportedNativeToDesktopScale,
      localToDesktopScaleX: reportedNativeToDesktopScale / captureScaleX,
      localToDesktopScaleY: reportedNativeToDesktopScale / captureScaleY,
    };
  }

  // Other platforms retain the prior origin/bounds interpretation until they
  // define a separate native coordinate contract.
  return {
    nativeToDesktopScaleX: captureScaleX,
    nativeToDesktopScaleY: captureScaleY,
    localToDesktopScaleX: 1,
    localToDesktopScaleY: 1,
  };
}

function isOccludedDesktopGroundingCandidate(
  candidate: NonNullable<GroundingElement["bbox"]>,
  target: CuaWindowInfo,
  inventory: CuaWindowInventory,
  scaleX: number,
  scaleY: number,
): boolean {
  for (const window of inventory.windows) {
    if (windowIdentityKey(window.target) === windowIdentityKey(target.target) || window.isOnScreen === false || window.minimized === true) continue;
    const bounds = window.bounds;
    const other = {
      x: bounds.x * scaleX,
      y: bounds.y * scaleY,
      width: bounds.width * scaleX,
      height: bounds.height * scaleY,
    };
    const overlaps = candidate.x < other.x + other.width && candidate.x + candidate.width > other.x &&
      candidate.y < other.y + other.height && candidate.y + candidate.height > other.y;
    if (!overlaps) continue;
    if (window.zIndex === undefined || target.zIndex === undefined || window.zIndex > target.zIndex) return true;
  }
  return false;
}

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
  allowMacTextFormat = false,
): Promise<PrivateGrounding | undefined> {
  if (mode === undefined || mode === "off") return undefined;
  if (mode === "uia-catalog-v1") return readGroundingCatalog(driver, session, binding, viewport, observationId, computerSessionId, signal, false, allowMacTextFormat);
  if (mode === "dom-catalog-v1") {
    if (browserTarget === undefined || domTransport === undefined) return undefined;
    // DOM-only has no trusted producer for the browser content origin. Keep
    // its capability explicitly fail-closed until a browser-native content
    // rect producer is available; never guess from window bounds/DPI.
    return emptyDomGrounding(observationId, computerSessionId);
  }
  let uia = mode === "hybrid-catalog-v1"
    ? await readGroundingCatalog(driver, session, binding, viewport, observationId, computerSessionId, signal, browserTarget !== undefined, allowMacTextFormat)
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
        const retryPromise = readGroundingCatalog(driver, session, binding, viewport, observationId, computerSessionId, retrySignal, true, allowMacTextFormat)
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
  if (browserTarget === undefined || domTransport === undefined) return uia;
  const dom = await readDomGroundingCatalog(domTransport, browserTarget, binding, viewport, observationId, computerSessionId, uia?.contentRect, signal);
  if (uia === undefined) return dom;
  if (dom === undefined) return uia;
  return mergeGroundings(uia, dom, observationId, computerSessionId);
}

/** Bound only optional enrichment reads; late results never reach catalog materialization. */
async function readOptionalGrounding<T>(
  signal: AbortSignal,
  read: (querySignal: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
  signal.throwIfAborted();
  const timeoutController = new AbortController();
  const querySignal = AbortSignal.any([signal, timeoutController.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const query = Promise.resolve().then(() => {
    querySignal.throwIfAborted();
    return read(querySignal);
  }).then((value) => ({ kind: "value" as const, value }), (error: unknown) => ({ kind: "error" as const, error }));
  const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => {
      timeoutController.abort(new Error("optional grounding read exceeded its read deadline"));
      resolve({ kind: "timeout" });
    }, OPTIONAL_GROUNDING_READ_TIMEOUT_MS);
  });
  const aborted = new Promise<{ kind: "aborted" }>((resolve) => {
    onAbort = () => resolve({ kind: "aborted" });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    const result = await Promise.race([query, timeout, aborted]);
    // Parent cancellation takes precedence even when the deadline/result won
    // the race earlier in the same turn. Never turn cancellation into fallback.
    signal.throwIfAborted();
    if (result.kind === "timeout" || timeoutController.signal.aborted) return undefined;
    if (result.kind === "aborted") {
      signal.throwIfAborted();
      return undefined;
    }
    if (result.kind === "error") throw result.error;
    return result.value;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

/** A bounded read-only UIA lookup used only while resolving a Windows multiline action. */
async function readMultilinePrivateGroundingCatalog(
  driver: CuaDriverLike,
  session: string,
  binding: CuaWindowBinding,
  viewport: Viewport,
  observationId: ObservationId,
  computerSessionId: ComputerSessionDescriptor["id"],
  signal: AbortSignal,
  allowMacTextFormat: boolean,
): Promise<PrivateGrounding> {
  signal.throwIfAborted();
  const timeoutController = new AbortController();
  const timeoutReason = new Error("private multiline UIA lookup exceeded its read deadline");
  const querySignal = AbortSignal.any([signal, timeoutController.signal]);
  const unavailable = (): PrivateGrounding => ({
    catalog: {
      version: "uia-catalog-v1",
      source: "uia",
      observationId,
      computerSessionId,
      completeness: "unknown",
      degraded: true,
      maxElements: GROUNDING_MAX_ELEMENTS,
      elements: [],
    },
    elements: new Map(),
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const query = readGroundingCatalog(driver, session, binding, viewport, observationId, computerSessionId, querySignal, false, allowMacTextFormat)
    .then((grounding) => ({ kind: "grounding" as const, grounding }), (error: unknown) => ({ kind: "error" as const, error }));
  const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => {
      timeoutController.abort(timeoutReason);
      resolve({ kind: "timeout" });
    }, MULTILINE_GROUNDING_QUERY_TIMEOUT_MS);
  });
  const aborted = new Promise<{ kind: "aborted" }>((resolve) => {
    if (signal.aborted) {
      resolve({ kind: "aborted" });
      return;
    }
    onAbort = () => resolve({ kind: "aborted" });
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    const result = await Promise.race([query, timeout, aborted]);
    if (result.kind === "aborted") {
      signal.throwIfAborted();
      return unavailable();
    }
    signal.throwIfAborted();
    if (result.kind === "timeout" || timeoutController.signal.aborted) {
      // The query is read-only and precedes any text dispatch. A timeout is a
      // fail-closed refusal, never an unknown input outcome.
      return unavailable();
    }
    if (result.kind === "error") {
      signal.throwIfAborted();
      throw result.error;
    }
    signal.throwIfAborted();
    return result.grounding;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
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
    const result = await readOptionalGrounding(signal, (querySignal) =>
      transport.collect({ observationId, computerSessionId, viewport, browserTarget }, querySignal));
    signal.throwIfAborted();
    if (result === undefined) return emptyDomGrounding(observationId, computerSessionId);
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
      domComplete: materialized.catalog.completeness === "complete" && !materialized.catalog.degraded,
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
  const elements = new Map<string, PrivateGroundingElement>();
  const uiaElements: GroundingElement[] = [];
  for (const [elementRef, value] of uia.elements) {
    // Browser UIA can retain clipped carousel links and inactive-tab links.
    // A complete DOM catalog is authoritative for named hyperlink targets;
    // unsupported/hidden links must not bypass its hit test via native input.
    if (dom.domComplete === true && value.element.browserRegion === "content"
        && normalizeGroundingRole(value.element.role) === "link"
        && findEquivalentDomGrounding(dom, value) === undefined) continue;
    elements.set(elementRef, value);
    uiaElements.push(value.element);
  }
  for (const [elementRef, value] of dom.elements) elements.set(elementRef, value);
  const publicElements = mergeGroundingElements(uiaElements, dom.catalog.elements);
  const truncated = uia.catalog.completeness !== "complete" || dom.catalog.completeness !== "complete";
  return {
    catalog: {
      version: "grounding-catalog-v2",
      source: "hybrid",
      observationId,
      computerSessionId,
      ...(isGroundingWebUrl(dom.catalog.pageUrl) ? { pageUrl: dom.catalog.pageUrl } : {}),
      ...(dom.catalog.visibleText === undefined ? {} : { visibleText: dom.catalog.visibleText }),
      completeness: truncated ? "partial" : "complete",
      degraded: uia.catalog.degraded || dom.catalog.degraded,
      maxElements: GROUNDING_MAX_ELEMENTS,
      elements: publicElements,
    },
    domComplete: dom.domComplete === true,
    ...(dom.browserTarget === undefined ? {} : { browserTarget: dom.browserTarget }),
    ...(dom.contentRect === undefined ? {} : { contentRect: dom.contentRect }),
    elements,
  };
}

function findEquivalentDomGrounding(
  grounding: PrivateGrounding | undefined,
  selected: PrivateGroundingElement | undefined,
): PrivateGroundingElement | undefined {
  if (grounding === undefined || selected === undefined || selected.element.bbox === undefined) return undefined;
  let match: PrivateGroundingElement | undefined;
  for (const candidate of grounding.elements.values()) {
    if (candidate.element.source !== "dom" || candidate.element.bbox === undefined
        || !equivalentBrowserCandidate(selected.element, candidate.element)) continue;
    if (match !== undefined) return undefined;
    match = candidate;
  }
  return match;
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
    case "hyperlink":
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
  allowMacTextFormat: boolean,
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
    const queryResult = await readOptionalGrounding(signal, (querySignal) => callTool(driver, "get_window_state", {
      pid: binding.target.pid,
      window_id: binding.target.windowId,
      include_screenshot: false,
      max_depth: 16,
      max_elements: GROUNDING_QUERY_MAX_ELEMENTS,
      session,
    }, querySignal));
    signal.throwIfAborted();
    if (queryResult === undefined) return empty("unknown", true);
    result = queryResult;
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted();
    if (error instanceof Error && error.name === "AbortError") throw error;
    return empty("unknown", true);
  }
  if (result.isError === true) return empty("unknown", true);
  const structured = parseStructuredRecord(result.structuredJson);
  if (hasExplicitIdentityMismatch(structured, binding.target)) return empty("unknown", true);
  const rawElements = structured?.elements;
  if (!Array.isArray(rawElements)) return empty("unknown", true);
  const snapshotId = safeCuaSnapshotId(structured?.snapshot_id ?? structured?.snapshotId);
  const parsed = rawElements.flatMap((value, index) => parseGroundingCandidate(value, index, binding, viewport, snapshotId, allowMacTextFormat));
  parsed.sort((left, right) => left.priority - right.priority || left.sortKey.localeCompare(right.sortKey));
  const selected = parsed.slice(0, GROUNDING_MAX_ELEMENTS);
  const selectedRecords = selected.map((candidate) => ({
    element: candidate.element,
    point: candidate.point,
    ...(candidate.uiaIdentityFingerprint === undefined ? {} : { uiaIdentityFingerprint: candidate.uiaIdentityFingerprint }),
    ...(candidate.elementToken === undefined ? {} : { elementToken: candidate.elementToken }),
    ...(candidate.snapshotId === undefined ? {} : { snapshotId: candidate.snapshotId }),
  }));
  const contentRect = trustedContentRectFromUia(selectedRecords.map((candidate) => candidate.element), viewport);
  const focusProof = managedBrowserHybrid && contentRect !== undefined
    ? parseMacFocusedElementProof(structured, binding, viewport, snapshotId, contentRect)
    : undefined;
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
    const element: GroundingElement = managedBrowserHybrid && (isManagedBrowserContainerRole(candidate.element.role)
      || isCollapsedBrowserContentUia(candidate.element, viewport, binding.bounds))
      ? {
          ...candidate.element,
          elementRef,
          state: { ...candidate.element.state, enabled: false },
        }
      : { ...candidate.element, elementRef };
    elements.set(elementRef, {
      element,
      point: candidate.point,
      geometry: binding.bounds,
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
    ...(focusProof === undefined ? {} : { focusProof }),
    elements,
  };
}

function parseMacFocusedElementProof(
  structured: Record<string, unknown> | undefined,
  binding: CuaWindowBinding,
  viewport: Viewport,
  snapshotId: string | undefined,
  contentRect: DomGroundingContentRect,
): PrivateGroundingElement | undefined {
  const proof = parseStructuredRecord(structured?.focus_proof);
  const focused = parseStructuredRecord(proof?.focused_element);
  const bounds = parseGroundingFrame(proof?.window_bounds);
  const frame = parseGroundingFrame(focused?.frame);
  if (proof?.version !== "macos-focused-element-v1"
      || proof.coordinate_space !== "macos-screen-points"
      || snapshotId === undefined
      || safeCuaSnapshotId(proof.snapshot_id) !== snapshotId
      || proof.pid !== binding.target.pid
      || proof.window_id !== binding.target.windowId
      || proof.frontmost_pid !== binding.target.pid
      || proof.focused_window_id !== binding.target.windowId
      || focused?.focused !== true
      || focused.enabled !== true
      || focused.editable !== true
      || focused.ancestry_verified !== true
      || bounds === undefined
      || !sameWindowGeometry(bounds, binding.bounds)
      || frame === undefined
      || frame.x < bounds.x || frame.y < bounds.y
      || frame.x + frame.width > bounds.x + bounds.width
      || frame.y + frame.height > bounds.y + bounds.height) return undefined;

  const role = boundedGroundingLabel(focused.role, 64);
  const name = boundedGroundingLabel(focused.name, 160);
  if (role === undefined || name === undefined) return undefined;
  const nativeLocal = {
    x: frame.x - bounds.x,
    y: frame.y - bounds.y,
    width: frame.width,
    height: frame.height,
  };
  const projected = {
    x: nativeLocal.x * viewport.width / bounds.width,
    y: nativeLocal.y * viewport.height / bounds.height,
    width: nativeLocal.width * viewport.width / bounds.width,
    height: nativeLocal.height * viewport.height / bounds.height,
    coordinateSpace: "physical" as const,
  };
  if (!validGroundingRect(projected, viewport)) return undefined;
  const element: GroundingElement = {
    elementRef: "uia-native-focus-proof",
    role,
    name,
    bbox: projected,
    state: { enabled: true, editable: true, focused: true },
    source: "uia",
    browserRegion: classifyUiaBrowserRegion({ bbox: projected }, contentRect, viewport),
  };
  const uiaIdentityFingerprint = makeUiaTargetFingerprint(element, binding);
  if (uiaIdentityFingerprint === undefined) return undefined;
  return {
    element,
    point: { x: projected.x + projected.width / 2, y: projected.y + projected.height / 2 },
    geometry: binding.bounds,
    uiaIdentityFingerprint,
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

function isCollapsedBrowserContentUia(
  element: Omit<GroundingElement, "elementRef">,
  viewport: Viewport,
  nativeBounds: CuaWindowGeometry,
): boolean {
  if (element.source !== "uia" || element.browserRegion !== "content" || element.bbox === undefined) return false;
  // A31 exposed a scrolled-away browser control as a one-native-unit strip.
  // Its PNG extent changes with registered-capture scaling (1 -> 1.3064 px
  // in that Run), so check native geometry units instead of a DPI-dependent
  // screenshot threshold. Retain its read evidence, but do not treat the
  // strip's center as proof of an actionable target. This does not identify
  // which upstream component produced the collapsed frame.
  const nativeWidth = element.bbox.width * nativeBounds.width / viewport.width;
  const nativeHeight = element.bbox.height * nativeBounds.height / viewport.height;
  const roundingTolerance = 1e-6;
  return nativeWidth <= 1 + roundingTolerance || nativeHeight <= 1 + roundingTolerance;
}

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
  allowMacTextFormat = false,
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
  const textFormat = allowMacTextFormat && item.in_web_content !== true && item.browserRegion !== "content" && role === "AXTextArea"
    ? parseGroundingTextFormat(item.text_format)
    : undefined;
  const elementToken = boundedGroundingToken(item.element_token ?? item.elementToken);
  const itemSnapshotId = safeCuaSnapshotId(item.snapshot_id ?? item.snapshotId) ?? snapshotId;
  const element: Omit<GroundingElement, "elementRef"> = {
    role,
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    bbox: { ...clipped, coordinateSpace: "physical" },
    ...(state === undefined ? {} : { state }),
    source: "uia",
    ...(textFormat === undefined ? {} : { textFormat }),
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

function parseGroundingTextFormat(value: unknown): GroundingElement["textFormat"] | undefined {
  const item = parseStructuredRecord(value);
  if (item === undefined || item.source !== "ax-cfstring-v1") return undefined;
  const keys = Object.keys(item).sort();
  if (item.status === "over_limit") {
    return keys.length === 2 && keys[0] === "source" && keys[1] === "status"
      ? { source: "ax-cfstring-v1", status: "over_limit" }
      : undefined;
  }
  const expectedKeys = ["carriage_return_count", "code_point_count", "line_feed_count", "source", "status", "trailing_line_feed_count", "utf8_bytes"];
  if (item.status !== "complete" || keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) return undefined;
  const utf8Bytes = boundedFormatCount(item.utf8_bytes, 16_384);
  const codePointCount = boundedFormatCount(item.code_point_count, 16_384);
  const lineFeedCount = boundedFormatCount(item.line_feed_count, 16_384);
  const trailingLineFeedCount = boundedFormatCount(item.trailing_line_feed_count, 16_384);
  const carriageReturnCount = boundedFormatCount(item.carriage_return_count, 16_384);
  if (utf8Bytes === undefined || codePointCount === undefined || lineFeedCount === undefined ||
      trailingLineFeedCount === undefined || carriageReturnCount === undefined ||
      utf8Bytes < codePointCount || utf8Bytes > 4 * codePointCount ||
      lineFeedCount > codePointCount || trailingLineFeedCount > lineFeedCount ||
      lineFeedCount + carriageReturnCount > codePointCount) return undefined;
  return { source: "ax-cfstring-v1", status: "complete", utf8Bytes, codePointCount, lineFeedCount, trailingLineFeedCount, carriageReturnCount };
}

function boundedFormatCount(value: unknown, maximum: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : undefined;
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

async function detectCuaPlatform(driver: CuaDriverLike, signal: AbortSignal): Promise<PlatformHealthEvidence> {
  let result: ToolResult;
  try {
    result = await callTool(driver, "health_report", {}, signal);
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted();
    return { status: "unavailable" };
  }
  if (result.isError) return { status: "unavailable" };
  const report = parseStructuredRecord(result.structuredJson);
  const reportedPlatform = isCuaPlatform(report?.platform) ? report.platform : undefined;
  const schemaVersion = typeof report?.schema_version === "string" ? report.schema_version.slice(0, 64) : undefined;
  const driverVersion = typeof report?.driver_version === "string" ? report.driver_version.slice(0, 128) : undefined;
  const metadata = {
    ...(reportedPlatform === undefined ? {} : { reportedPlatform }),
    ...(schemaVersion === undefined ? {} : { schemaVersion }),
    ...(driverVersion === undefined ? {} : { driverVersion }),
  };
  if (result.degraded) return { status: "degraded", ...metadata };
  if (report?.schema_version !== "1" || reportedPlatform === undefined ||
      report.driver_version !== cuaSdkVersionForPlatform(reportedPlatform)) return { status: "invalid", ...metadata };
  return { status: "valid", ...metadata };
}

function resolveSessionPlatform(
  configuredPlatform: NodeJS.Platform | undefined,
  health: PlatformHealthEvidence,
  hostPlatform: NodeJS.Platform,
): PlatformResolution {
  if (configuredPlatform !== undefined && !isCuaPlatform(configuredPlatform)) {
    throw new Error(`unsupported configured CUA platform ${configuredPlatform}`);
  }
  const configured = configuredPlatform as CuaPlatform | undefined;
  const healthPlatform = health.status === "valid" ? health.reportedPlatform : undefined;
  const hostFallback = isCuaPlatform(hostPlatform) ? hostPlatform : undefined;
  const effective = configured ?? healthPlatform ?? hostFallback;
  if (effective === undefined) throw new Error(`unsupported host CUA platform ${hostPlatform}`);
  return {
    effective,
    source: configured !== undefined ? "configured" : healthPlatform !== undefined ? "health" : "host",
    ...(configured === undefined ? {} : { configured }),
    health,
    conflict: configured !== undefined && healthPlatform !== undefined && configured !== healthPlatform,
  };
}

function isCuaPlatform(value: unknown): value is CuaPlatform {
  return value === "win32" || value === "darwin" || value === "linux";
}

/**
 * Windows foreground press_key has a SendInput chord path; hotkey on modern
 * XAML targets instead tries UIA Accelerator matching. Convert only an
 * unambiguous one-base-key chord with known native modifiers. Background,
 * desktop, non-Windows, and multi-base actions retain the existing hotkey path.
 */
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
    ...(typeof record.structuredJson === "string" ? { structuredJson: record.structuredJson } :
      typeof inner?.structuredJson === "string" ? { structuredJson: inner.structuredJson } : {}),
  };
}

function normalizeDriverError(error: unknown, operation: string): Error {
  const details = driverErrorDetails(error);
  return new Error(`CUA ${operation} failed${details.errorCode ? ` [${details.errorCode}]` : ""}: ${details.message}`);
}

async function bestEffortCloseDriver(driver: CuaDriverLike, label: string, waitMs: number, sessionStarted: boolean): Promise<boolean> {
  const sdkModule = await loadCuaSdkModule();
  const deadline = Date.now() + waitMs;
  let safeToDestroy = !sessionStarted;
  try {
    let result;
    try {
      result = await awaitWithDeadline(() => driver.endSession(sdkModule.EndSessionInput.new({ session: label })), deadline, "endSession");
    } catch (error) {
      const details = driverErrorDetails(error);
      if (details.errorCode !== "session_cleanup_pending" && !/session_cleanup_pending/i.test(details.message)) {
        // After startSession succeeds, a transport/unknown failure leaves the
        // driver ownership unresolved.  Retaining it is safer than destroy().
        if (sessionStarted) return false;
        throw error;
      }
      await waitForCleanupPoll(deadline);
      result = await awaitWithDeadline(() => driver.endSession(sdkModule.EndSessionInput.new({ session: label })), deadline, "endSession");
    }
    if (result.active) {
      await waitForCleanupPoll(deadline);
      result = await awaitWithDeadline(() => driver.endSession(sdkModule.EndSessionInput.new({ session: label })), deadline, "endSession");
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

function delayWithAbort(durationMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, durationMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason instanceof Error ? signal.reason : new Error("operation aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  }).then(() => signal.throwIfAborted());
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
