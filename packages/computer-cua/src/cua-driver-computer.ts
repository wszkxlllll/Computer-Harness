import { mkdir, readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { BoundWindowMissingError } from "@computer-harness/protocol";
import { join } from "node:path";
import { cuaSdkVersionForPlatform, loadCuaSdkModule, type CuaDriverLike } from "./cua-sdk-platform.js";
import type {
  ActionIntent,
  ActionReceipt,
  ComputerSessionDescriptor,
  ComputerWindowCandidate,
  ComputerWindowCandidateRelationship,
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
  listWindowInventory,
  listWindowTargets,
  sameWindowGeometry,
  validateWindowTarget,
  windowActionTarget,
  type CuaWindowBinding,
  type CuaWindowCapture,
  type CuaWindowGeometry,
  type CuaWindowInventory,
  type CuaWindowInfo,
  type CuaWindowTarget,
  type WindowCaptureRetryOptions,
  WindowContractError,
} from "./window-contract.js";
import { assessOwnedTransientWindowAdmission } from "./transient-window-admission.js";
import { mergeWindowRelationshipInventory, type WindowRelationshipProbe } from "./window-relationship-probe.js";
import { projectExactWindowRoot as exactWindowRoot } from "./window-root-projection.js";
import {
  isRelevantManualWindowCandidate,
  projectSelectableWindowCandidates,
} from "./window-candidate-projection.js";

const PRIMARY_DESKTOP = { kind: "desktop", display_id: "primary" } as const;
const CLEANUP_POLL_INTERVAL_MS = 50;
const TRANSIENT_RECOVERY_RECHECK_DELAYS_MS = [300, 300, 300] as const;
function hasLineBreak(text: string): boolean {
  return /[\r\n\u0085\u2028\u2029]/u.test(text);
}

function normalizeLogicalLineEndings(text: string): string {
  return text.replace(/\r\n|\r|\n/gu, "\n");
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

type OverlayVerification =
  | { readonly status: "present"; readonly evidence: Extract<TransientChildEvidence, { readonly kind: "overlay" }> }
  | { readonly status: "absent" }
  | { readonly status: "unknown"; readonly reason: string; readonly candidateObserved: boolean };

type TransientRootVerification =
  | { readonly status: "verified"; readonly evidence: Extract<TransientChildEvidence, { readonly kind: "native_window" }> }
  | { readonly status: "unavailable"; readonly rootRole?: "menu" | "popup" | "dialog" | "window"; readonly queryFailed?: boolean }
  | { readonly status: "contradictory"; readonly reason: string };

type MacAttachedSheetState =
  | { readonly status: "sheet"; readonly evidence: Extract<TransientChildEvidence, { readonly kind: "native_window" }> }
  | { readonly status: "geometry_unstable" }
  | { readonly status: "none" }
  | { readonly status: "unknown"; readonly reason: string };

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
  if (result.isError) return { status: "unknown", reason: "native parent AX proof query failed" };
  const state = parseStructuredRecord(result.structuredJson);
  if (state === undefined || hasExplicitIdentityMismatch(state, parent.target)) {
    return { status: "unknown", reason: "native parent AX proof has no exact target identity" };
  }
  const proof = parseStructuredRecord(state.attached_sheet_proof);
  // A degraded catalog can still carry a separately captured, exact AX
  // relationship proof. In that case its relation snapshot is authoritative;
  // the catalog snapshot may describe a different (partial) tree.
  const proofSnapshotId = state.degraded === true
    ? state.attached_sheet_snapshot_id
    : state.snapshot_id;
  const relationOnlyDegraded = state.degraded === true && state.elements_complete === false &&
    typeof state.attached_sheet_snapshot_id === "string" &&
    state.attached_sheet_snapshot_id === proof?.snapshot_id && result.degraded === true;
  if ((result.degraded || state.degraded === true) && !relationOnlyDegraded) {
    return { status: "unknown", reason: "degraded AX catalog has no exact attached-sheet-only snapshot proof" };
  }
  const parentBounds = parseStructuredRecord(proof?.parent_bounds);
  const snapshotId = proofSnapshotId;
  const identityOk = proof?.version === "macos-attached-sheet-v1" &&
    typeof snapshotId === "string" && snapshotId.length > 0 && proof.snapshot_id === snapshotId &&
    proof.pid === parent.target.pid && proof.parent_window_id === parent.target.windowId &&
    proof.parent_owner_pid === parent.target.pid && proof.frontmost_pid === parent.target.pid &&
    proof.direct_children_status === "success" && Number.isSafeInteger(proof.direct_child_count) &&
    (proof.direct_child_count as number) >= 0 &&
    (proof.parent_role === "AXWindow" || proof.parent_role === "AXSheet") &&
    (proof.parent_role !== "AXSheet" || proof.parent_ax_parent_verified === true &&
      expectedAxParent !== undefined && proof.parent_ax_parent_window_id === expectedAxParent.windowId) &&
    Number.isFinite(parentBounds?.x) && Number.isFinite(parentBounds?.y) &&
    Number.isFinite(parentBounds?.width) && Number.isFinite(parentBounds?.height) &&
    sameWindowGeometry(parent.bounds, {
      x: parentBounds!.x as number, y: parentBounds!.y as number,
      width: parentBounds!.width as number, height: parentBounds!.height as number,
    });
  if (!identityOk) return { status: "unknown", reason: "native parent AX proof is stale, incomplete, or bound to different geometry" };
  if (proof!.status === "none") {
    return proof!.focused_window_id === parent.target.windowId && proof!.sheet === undefined
      ? { status: "none" }
      : { status: "unknown", reason: "native no-sheet proof does not show the exact parent focused" };
  }
  const sheet = parseStructuredRecord(proof!.sheet);
  const bounds = parseStructuredRecord(sheet?.bounds);
  if (proof!.status !== "sheet" || sheet?.role !== "AXSheet" || sheet.ax_parent_verified !== true ||
      sheet.pid !== parent.target.pid || sheet.owner_pid !== parent.target.pid ||
      sheet.ax_parent_pid !== parent.target.pid || sheet.ax_parent_window_id !== parent.target.windowId ||
      !Number.isSafeInteger(sheet.window_id) || (sheet.window_id as number) <= 0 ||
      sheet.window_id === parent.target.windowId || (proof!.direct_child_count as number) < 1 ||
      proof!.focused_window_id !== sheet.window_id || candidate === undefined ||
      candidate.target.pid !== sheet.pid || candidate.target.windowId !== sheet.window_id ||
      candidate.isOnScreen !== true || candidate.minimized === true ||
      !Number.isFinite(bounds?.x) || !Number.isFinite(bounds?.y) ||
      !Number.isFinite(bounds?.width) || !Number.isFinite(bounds?.height) ||
      (bounds!.width as number) <= 0 || (bounds!.height as number) <= 0 ||
      !Number.isFinite(candidate.bounds.width) || !Number.isFinite(candidate.bounds.height) ||
      candidate.bounds.width <= 0 || candidate.bounds.height <= 0) {
    return { status: "unknown", reason: "native AXSheet proof does not exactly match the unique fresh surfaced candidate" };
  }
  if (!sameWindowGeometry(candidate.bounds, {
    x: bounds!.x as number, y: bounds!.y as number,
    width: bounds!.width as number, height: bounds!.height as number,
  })) return { status: "geometry_unstable" };
  return { status: "sheet", evidence: {
    kind: "native_window",
    nativeWindow: asNativeWindowIdentity(candidate.target),
    owner: asNativeWindowIdentity(parent.target),
    rootRole: "dialog",
    visible: true,
    rootSemanticsVerified: true,
    interactionPolicy: "modal",
    frontmostEvidence: "exact_foreground",
    admissionSource: "macos_attached_sheet_proof",
  } };
}

type UnknownTransientReplacementAttempt =
  | { readonly decision: "recovered"; readonly surfaceRef: SurfaceRef }
  | { readonly decision: "retry" }
  | { readonly decision: "stop" };

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

/**
 * The exact-child UIA query below is private transient-surface evidence, not a
 * UIA grounding/catalog feature exposed to the model. Require a complete,
 * untruncated Win32 relationship snapshot before spending that bounded read.
 */
function canVerifyExactTransientRoot(inventory: CuaWindowInventory): boolean {
  return inventory.source === "win32_relationship_probe" && inventory.complete && inventory.truncated !== true;
}

function win32RelationshipChildEvidence(
  owner: CuaWindowTarget,
  candidate: CuaWindowInfo,
  inventory: CuaWindowInventory,
): Extract<TransientChildEvidence, { readonly kind: "native_window" }> | undefined {
  if (inventory.source !== "win32_relationship_probe" || candidate.isOnScreen !== true || candidate.minimized === true ||
      candidate.ownerPid !== owner.pid || candidate.ownerWindowId !== owner.windowId) return undefined;
  const exactForeground = inventory.foregroundPid === candidate.target.pid &&
    inventory.foregroundWindowId === candidate.target.windowId;
  // Owner/z-order alone does not make an arbitrary auxiliary HWND modal.
  // Native menu/dialog class evidence and explicit UIA root roles are handled
  // by verifyTransientNativeChildRoot; the relationship-only fast path is
  // reserved for an exact child that actually owns the foreground.
  if (!exactForeground) return undefined;
  const evidenceKind = "exact_foreground";
  return {
    kind: "native_window",
    nativeWindow: asNativeWindowIdentity(candidate.target),
    owner: asNativeWindowIdentity(owner),
    visible: true,
    interactionPolicy: "modal",
    relationshipProof: evidenceKind,
    frontmostEvidence: evidenceKind,
    admissionSource: "win32_relationship_probe",
  };
}

function hasExactOwnedAuxiliaryStackEvidence(
  owner: CuaWindowTarget,
  candidate: CuaWindowInfo,
  inventory: CuaWindowInventory,
): boolean {
  const exactOwner = candidate.ownerPid === owner.pid && candidate.ownerWindowId === owner.windowId;
  const trustedCrossProcessOwner = candidate.target.pid !== owner.pid && inventory.source === "win32_relationship_probe" &&
    inventory.complete && inventory.truncated !== true && exactOwner;
  if (!inventory.complete || inventory.truncated === true ||
      inventory.foregroundPid !== owner.pid || inventory.foregroundWindowId !== owner.windowId ||
      candidate.target.pid !== owner.pid && !trustedCrossProcessOwner ||
      candidate.isOnScreen !== true || candidate.minimized === true || !exactOwner || candidate.zIndex === undefined) {
    return false;
  }
  const parentRows = inventory.windows.filter((window) => windowIdentityKey(window.target) === windowIdentityKey(owner));
  const candidateRows = inventory.windows.filter((window) => windowIdentityKey(window.target) === windowIdentityKey(candidate.target));
  return parentRows.length === 1 && candidateRows.length === 1 && parentRows[0]!.isOnScreen === true &&
    parentRows[0]!.minimized !== true && parentRows[0]!.zIndex !== undefined &&
    candidate.zIndex > parentRows[0]!.zIndex!;
}

function windowCandidateRelationship(
  candidate: CuaWindowInfo,
  owner: CuaWindowTarget,
  inventory: CuaWindowInventory,
  hostScoped: boolean,
): ComputerWindowCandidateRelationship | undefined {
  const exactOwner = candidate.ownerPid === owner.pid && candidate.ownerWindowId === owner.windowId;
  const trustedCrossProcessOwner = candidate.target.pid === owner.pid ||
    inventory.source === "win32_relationship_probe" && inventory.complete && inventory.truncated !== true;
  if (exactOwner && trustedCrossProcessOwner) {
    const rootRole = trustedWindowClassRootRole(candidate.windowClass);
    return {
      kind: "owned_child",
      owner: { pid: owner.pid, windowId: owner.windowId },
      ...(rootRole === undefined ? {} : { rootRole }),
    };
  }
  return hostScoped && !exactOwner ? { kind: "scoped_peer" } : undefined;
}

function win32OwnedChildEvidence(
  owner: CuaWindowTarget,
  candidate: CuaWindowInfo,
  inventory: CuaWindowInventory,
  parentSurfaceCurrent: boolean,
): Extract<TransientChildEvidence, { readonly kind: "native_window" }> | undefined {
  if (inventory.source !== "win32_relationship_probe") return undefined;
  const stageOne = assessOwnedTransientWindowAdmission({
    parent: owner,
    candidate,
    inventory,
    surfacedWindowCount: 1,
    baselineComplete: inventory.complete,
    baselineTruncated: inventory.truncated === true,
    parentSurfaceCurrent,
  });
  if (stageOne.decision !== "admitted") return undefined;
  const exactForeground = inventory.foregroundPid === candidate.target.pid &&
    inventory.foregroundWindowId === candidate.target.windowId;
  if (!exactForeground) return undefined;
  const relationshipProof = "exact_foreground" as const;
  return {
    kind: "native_window",
    nativeWindow: asNativeWindowIdentity(candidate.target),
    owner: asNativeWindowIdentity(owner),
    visible: true,
    interactionPolicy: "modal",
    relationshipProof,
    frontmostEvidence: relationshipProof,
    admissionSource: "win32_relationship_probe",
  };
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

function windowRefusalCode(code: string | undefined, message: string, structuredNoInputEvidence = false): string {
  // CUA 0.22.2 reports the exact-HWND foreground refusal in Tool text rather
  // than a dedicated error code. Require explicit evidence that it sent no
  // input; the prefix alone is not enough to make an action retry-safe.
  const foregroundRefusal = /^foreground_unavailable:/iu.test(message);
  const noInputEvidence = hasExplicitNoInputEvidence(message) || structuredNoInputEvidence;
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
  // Keep the foreground evidence contract in one place.  In particular, a
  // successful `landed_on_target` flag is not enough when the daemon also
  // reports a different actual foreground HWND: continuing would let a
  // keyboard action land in a newly surfaced sheet or dialog.
  await activateWindowTarget(driver, session, target, signal);
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
  /** Test seam for the pinned platform coordinate contract; defaults to process.platform. */
  platform?: NodeJS.Platform;
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
  /** Allow one bounded managed-browser content-rect stabilization at startup. */
  initialObservationPending: boolean;
  /** Full visible-window baseline from the last successful target observation. */
  visibleWindowBaseline: ReadonlySet<string> | undefined;
  /** Fresh inventory immediately before an opted-in foreground GUI action. */
  preActionWindowBaseline: {
    readonly actionId: ActionIntent["actionId"];
    completed: boolean;
    readonly targetKeys: ReadonlySet<string>;
    readonly complete: boolean;
    readonly truncated: boolean;
    readonly parentSurfaceRef: SurfaceRef;
    readonly parentBinding: CuaWindowBinding;
  } | undefined;
  missingParent?: {
    readonly sourceActionId: ActionIntent["actionId"];
    candidates: Map<string, ComputerWindowCandidate>;
    epoch: number;
    confirming: boolean;
  };
  /** Windows surfaced since that observation; only these may be considered for automatic handoff. */
  newlySurfacedWindowKeys: ReadonlySet<string>;
  /** Visible identities observed after a completed action; model inventory annotation only. */
  firstObservedAfterActionWindows: { readonly actionId: ActionIntent["actionId"]; readonly targetKeys: ReadonlySet<string> } | undefined;
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
  /** Exact root already checked for an existing owned transient during observe. */
  lastInspectedExistingTransientRootRef?: SurfaceRef;
  /** Short-lived guard against replaying the same GUI primitive after an unknown foreground outcome. */
  unknownActionReplayGuard?: {
    readonly surfaceRef: SurfaceRef;
    readonly primitiveFingerprints: Set<string>;
    alternativeActionCompleted: boolean;
  };
  /** Set only while the current unknown action's post-dispatch native diff is being verified. */
  unknownActionReconciliationPending?: boolean;
  /** Exact active root re-confirmed by the most recent unknown-action diff. */
  unknownActionReconfirmedSurfaceRef?: SurfaceRef;
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
  captureSource?: "verify_state" | "get_window_state_registered" | "get_window_state_fallback";
  readonly surfaceRef: SurfaceRef;
  /**
   * The image coordinate space that the model used for this observation.
   * Window actions must be projected from this viewport, not from the
   * current session viewport (which may belong to a later observation).
   */
  viewport: Viewport;
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
  /** Stable private identity; excludes element token and editable value. */
  readonly uiaIdentityFingerprint?: string;
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
  structuredJson?: string;
}

export class CuaDriverComputer implements Computer {
  private readonly options: Required<Pick<CuaDriverComputerOptions, "socketPath" | "screenshotDir" | "cleanupWaitMs">> & Omit<CuaDriverComputerOptions, "socketPath" | "screenshotDir" | "cleanupWaitMs">;
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
    const sdkModule = await loadCuaSdkModule();
    const driver = this.options.driverFactory !== undefined
      ? this.options.driverFactory(this.options.socketPath)
      : sdkModule.CuaDriver.connect(this.options.socketPath);
    const label = this.options.sessionLabel ?? `computer-harness-${Date.now()}`;
    let sessionStarted = false;
    try {
      await driver.startSession(sdkModule.StartSessionInput.new({ session: label }), { signal });
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
        const capture = await captureWindowWithRetry(driver, label, this.options.windowTarget, signal, this.options.windowCaptureRetry, resolveCapturePlatform(this.options.platform, platform));
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
        ...(platform === undefined ? {} : { platform }),
        descriptor,
        active: true,
        surfaceRegistry,
        windowBindings,
        initialObservationPending: true,
        visibleWindowBaseline: undefined,
        preActionWindowBaseline: undefined,
        newlySurfacedWindowKeys: new Set(),
        firstObservedAfterActionWindows: undefined,
        newHandoffCandidates: [],
        foregroundMismatchWindowId: undefined,
        proactiveHandoffCandidatesReady: false,
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
          this.options.windowCaptureRetry,
          resolveCapturePlatform(this.options.platform, current.platform),
        );
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
          current.initialObservationPending,
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
        const unknownActionReplayGuard = current.unknownActionReplayGuard;
        if (unknownActionReplayGuard !== undefined &&
            (!sameSurfaceRef(unknownActionReplayGuard.surfaceRef, surfaceRef) ||
              unknownActionReplayGuard.alternativeActionCompleted)) {
          delete current.unknownActionReplayGuard;
        }
        this.observations.set(String(observationId), {
          sessionId: String(session.id),
          captureSource: capture.source,
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

  private async reconcileActiveTransientChild(current: PrivateSession, signal: AbortSignal): Promise<SurfaceRef | undefined> {
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
      const [inventory, parentBinding] = await Promise.all([
        listWindowInventory(current.driver, current.label, signal, undefined, false, this.options.windowRelationshipProbe),
        discoverWindow(current.driver, current.label, parentTarget, signal),
      ]);
      const storedParentBinding = current.windowBindings.get(windowIdentityKey(parentTarget));
      if (storedParentBinding === undefined || !sameWindowGeometry(parentBinding.bounds, storedParentBinding.bounds)) {
        throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", "the exact parent window geometry changed during attached-sheet reconciliation");
      }
      const childTarget = asCuaWindowTarget(child.nativeWindow);
      const childRows = inventory.windows.filter((window) => windowIdentityKey(window.target) === windowIdentityKey(childTarget));
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
      const anotherVisibleOwnedWindow = inventory.windows.some((window) =>
        windowIdentityKey(window.target) !== windowIdentityKey(parentTarget) &&
        windowIdentityKey(window.target) !== windowIdentityKey(childTarget) &&
        window.ownerPid === parentTarget.pid && window.ownerWindowId === parentTarget.windowId &&
        window.isOnScreen === true && window.minimized !== true);
      if (!parentVisible || candidate !== undefined || anotherVisibleOwnedWindow) {
        throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", "fresh no-sheet AX proof did not coincide with an absent child and visible exact parent");
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
      let inventory = await listWindowInventory(current.driver, current.label, signal, undefined, false, this.options.windowRelationshipProbe);
      let candidate = inventory.windows.find((window) => windowIdentityKey(window.target) === windowIdentityKey(childTarget));
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
        this.options.windowCaptureRetry,
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
    const cua = await listWindowInventory(current.driver, current.label, signal, undefined, false);
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
      this.options.windowCaptureRetry,
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
    signal: AbortSignal,
  ): Promise<ActionReceipt> {
    const safeSurfaceRef = await this.reconfirmNativeSurfaceAfterUnknownAction(current, actionSurfaceRef, signal);
    this.rememberUnknownActionPrimitive(current, action, actionSurfaceRef);
    return {
      actionId: action.actionId,
      status: "partial",
      driverCode: "ACTION_OUTCOME_UNKNOWN",
      message: "CUA could not confirm the foreground after dispatch; input may have been sent. The action outcome is unknown. Do not repeat this action; inspect a fresh screen and choose a different GUI action.",
      ...(safeSurfaceRef === undefined
        ? {}
        : { safeRecovery: { kind: "native_surface_reconfirmed" as const, surfaceRef: safeSurfaceRef } }),
    };
  }

  private rememberUnknownActionPrimitive(current: PrivateSession, action: ActionIntent, surfaceRef: SurfaceRef): void {
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
        this.options.windowCaptureRetry,
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
    const epoch = missing === undefined ? undefined : ++missing.epoch;
    // Invalidate before I/O, including failed/aborted refreshes.
    missing?.candidates.clear();
    current.windowRefs.clear();
    if (!this.canUseManualWindowHandoff(current)) {
      throw new Error("window handoff is available only for an explicitly bound native window");
    }
    const inventory = await listWindowInventory(current.driver, current.label, signal, undefined, true, this.options.windowRelationshipProbe);
    const windows = inventory.windows;
    const binding = activeWindowBinding(current);
    if (binding === undefined) throw new Error("window handoff requires the exact active native-window binding");
    const unauthorizedForeground = current.foregroundMismatchWindowId === undefined
      ? undefined
      : windows.find((window) => window.target.windowId === current.foregroundMismatchWindowId &&
        !targetAllowedByHostScope(window.target, this.options.windowSwitchAllowedTargets));
    if (unauthorizedForeground !== undefined) {
      throw new WindowContractError("WINDOW_SCOPE_REQUIRED", "the foreground window is outside the host-authorized window scope");
    }
    const candidatePool = windows
      .filter((window) => windowIdentityKey(window.target) !== windowIdentityKey(binding.target))
      .filter((window) => targetAllowedByHostScope(window.target, this.options.windowSwitchAllowedTargets) ||
        window.ownerPid === binding.target.pid && window.ownerWindowId === binding.target.windowId)
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
    const candidates: ComputerWindowCandidate[] = projectSelectableWindowCandidates(candidatePool, binding.target, current.platform, undefined, undefined, true).windows
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
   * filter, using opaque per-Run refs. Dispatch still rechecks the exact
   * native identity and captures the selected target fresh.
   */
  public async listWindows(session: ComputerSessionDescriptor, signal: AbortSignal): Promise<ComputerWindowList> {
    const current = this.requireSession(session);
    current.windowRefs.clear();
    const previousFirstObservedAfterAction = current.firstObservedAfterActionWindows;
    current.firstObservedAfterActionWindows = undefined;
    if (this.options.windowSwitch !== "opened-windows-v1") {
      throw new WindowContractError("WINDOW_SWITCH_DISABLED", "cross-window switching is not enabled for this Run");
    }
    if (activeSurfaceUnavailable(current)) {
      throw new WindowContractError("WINDOW_TARGET_INVALIDATED", "window target identity was invalidated; close and open a new session");
    }
    signal.throwIfAborted();
    const inventory = await listWindowTargets(current.driver, current.label, signal, undefined, false, this.options.windowRelationshipProbe);
    signal.throwIfAborted();
    const actionBaseline = current.preActionWindowBaseline;
    const activeBinding = activeWindowBinding(current);
    const baselineStillBound = actionBaseline !== undefined && activeBinding !== undefined &&
      sameSurfaceRef(current.surfaceRegistry.activeSurface, actionBaseline.parentSurfaceRef) &&
      isCurrentSurfaceRef(current.surfaceRegistry, actionBaseline.parentSurfaceRef) &&
      isExecutableSurfaceRef(current.surfaceRegistry, actionBaseline.parentSurfaceRef) &&
      windowIdentityKey(activeBinding.target) === windowIdentityKey(actionBaseline.parentBinding.target);
    if (actionBaseline?.completed === true && baselineStillBound) {
      const firstObservedAfterActionKeys = inventory
        .filter((window) => window.isOnScreen === true && !actionBaseline.targetKeys.has(windowIdentityKey(window.target)))
        .map((window) => windowIdentityKey(window.target));
      current.firstObservedAfterActionWindows = firstObservedAfterActionKeys.length > 0
        ? { actionId: actionBaseline.actionId, targetKeys: new Set(firstObservedAfterActionKeys) }
        : undefined;
    } else if (actionBaseline === undefined && previousFirstObservedAfterAction !== undefined) {
      const visibleKeys = new Set(inventory
        .filter((window) => window.isOnScreen === true && previousFirstObservedAfterAction.targetKeys.has(windowIdentityKey(window.target)))
        .map((window) => windowIdentityKey(window.target)));
      current.firstObservedAfterActionWindows = visibleKeys.size > 0
        ? { actionId: previousFirstObservedAfterAction.actionId, targetKeys: visibleKeys }
        : undefined;
    } else {
      current.firstObservedAfterActionWindows = undefined;
    }
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
    const projected = projectSelectableWindowCandidates(windows, boundPeer, current.platform);
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
        ...(window.isOnScreen === true && current.firstObservedAfterActionWindows?.targetKeys.has(windowIdentityKey(window.target)) === true
          ? { firstObservedAfterAction: true, sourceActionId: current.firstObservedAfterActionWindows.actionId }
          : {}),
      };
    }).filter((window): window is ComputerWindowOption => window !== undefined);
    const registrationOmissions = projected.windows.length - options.length;
    const omittedCount = projected.omittedCount + registrationOmissions;
    return {
      options,
      truncated: omittedCount > 0,
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
      const nestedInventory = await listWindowInventory(
        current.driver, current.label, signal, undefined, true, this.options.windowRelationshipProbe,
      );
      if (nestedInventory.truncated === true) {
        throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", "nested macOS sheet candidate inventory is truncated");
      }
      const newRows = nestedInventory.windows.filter((window) =>
        !baseline.targetKeys.has(windowIdentityKey(window.target)) && window.isOnScreen === true && window.minimized !== true);
      const nestedCandidate = newRows.length === 1 && newRows[0]!.target.pid === activeBinding.target.pid
        ? newRows[0]
        : undefined;
      if (nestedCandidate !== undefined) {
        const freshParent = await discoverWindow(current.driver, current.label, activeBinding.target, signal);
        const storedParent = current.windowBindings.get(windowIdentityKey(activeBinding.target));
        if (storedParent === undefined || !sameWindowGeometry(freshParent.bounds, storedParent.bounds)) {
          throw new WindowContractError("TRANSIENT_SURFACE_UNKNOWN", "nested macOS sheet parent geometry changed");
        }
        const attached = await readMacAttachedSheetState(
          current.driver, current.label, freshParent, nestedCandidate, signal, asCuaWindowTarget(rootNative),
        );
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
    const reconciledSibling = await this.reconcileActiveTransientChild(current, signal);
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
      current.missingParent = { sourceActionId: baseline.actionId, candidates: new Map(), epoch: 0, confirming: false };
      this.clearTargetObservationState(current, baseline.parentSurfaceRef);
      throw new BoundWindowMissingError(baseline.actionId);
    }
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
      const rawSurfaced = inventory.windows.filter((window) => !baseline.targetKeys.has(windowIdentityKey(window.target)));
      const surfaced = projectSelectableWindowCandidates(rawSurfaced, baseline.parentBinding.target, current.platform, undefined, (window) =>
        {
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

  public async handoffWindow(session: ComputerSessionDescriptor, candidate: ComputerWindowCandidate, signal: AbortSignal): Promise<ComputerSessionDescriptor> {
    const current = this.requireSession(session);
    const binding = activeWindowBinding(current);
    if (binding === undefined || !this.canUseManualWindowHandoff(current)) {
      throw new Error("window handoff is available only for an explicitly bound native window");
    }
    validateWindowTarget(candidate);
    const missing = current.missingParent;
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
      const inventory = await listWindowInventory(current.driver, current.label, signal, undefined, false, this.options.windowRelationshipProbe);
      const ownedRows = inventory.windows.filter((window) => windowIdentityKey(window.target) === windowIdentityKey(candidate));
      if (ownedRows.length !== 1 || ownedRows[0]!.ownerPid !== binding.target.pid ||
          ownedRows[0]!.ownerWindowId !== binding.target.windowId || ownedRows[0]!.isOnScreen !== true ||
          ownedRows[0]!.minimized === true) {
        throw new WindowContractError("WINDOW_SWITCH_UNAUTHORIZED", "the selected window is not a fresh visible exact-owned child of the current target");
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
      ...(isNewlySurfacedForCurrentAction ? { classifyOwnedChild: true } : {}),
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
      readonly expectedOwner?: CuaWindowTarget;
      readonly classifyOwnedChild?: boolean;
      readonly authorizedTargets?: readonly CuaWindowTarget[];
      readonly selectedSurfaceRef?: SurfaceRef;
      readonly missingPermit?: { readonly boundary: NonNullable<PrivateSession["missingParent"]>; readonly epoch: number; readonly issued: ComputerWindowCandidate };
    },
  ): Promise<ComputerSessionDescriptor> {
    validateWindowTarget(target);
    if (!targetAllowedByHostScope(target, options.authorizedTargets)) {
      throw new WindowContractError("WINDOW_SWITCH_UNAUTHORIZED", "selected window is outside the host-authorized window scope");
    }
    const activeRefBefore = current.surfaceRegistry.activeSurface;
    const assertTransitionCurrent = (): void => {
      const permit = options.missingPermit;
      if (permit === undefined) return; // Do not narrow historical non-missing recovery paths.
      signal.throwIfAborted();
      if (this.session !== current || !current.active || activeRefBefore === undefined ||
          !sameSurfaceRef(activeRefBefore, current.surfaceRegistry.activeSurface) ||
          !isExecutableSurfaceRef(current.surfaceRegistry, activeRefBefore)) {
        throw new WindowContractError(options.staleCode, "target transition session or Surface is no longer current");
      }
      if (current.missingParent !== permit.boundary || !permit.boundary.confirming ||
          permit.boundary.epoch !== permit.epoch || permit.boundary.candidates.get(permit.issued.handoffToken!) !== permit.issued) {
        throw new WindowContractError(options.staleCode, "missing-window confirmation is no longer current");
      }
    };
    const activeBefore = activeSurface(current);
    if (activeBefore?.parentSurfaceId !== undefined &&
        (activeBefore.kind === "overlay" || activeBefore.kind === "native_window")) {
      throw new WindowContractError("TRANSIENT_SURFACE_MODAL", "close and pop the active modal child Surface before switching peers");
    }
    const activeBindingBefore = activeWindowBinding(current);
    const selectedIsCurrent = activePeerTarget(current) !== undefined &&
      windowIdentityKey(activePeerTarget(current)!) === windowIdentityKey(target);
    signal.throwIfAborted();
    const transitionInventory = options.expectedOwner === undefined && options.classifyOwnedChild !== true
      ? undefined
      : await listWindowInventory(current.driver, current.label, signal, undefined, options.onScreenOnly, this.options.windowRelationshipProbe);
    const windows = transitionInventory?.windows ?? await listWindowTargets(
      current.driver, current.label, signal, undefined, options.onScreenOnly, this.options.windowRelationshipProbe,
    );
    assertTransitionCurrent();
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
          childRows[0]!.minimized === true || (!transitionInventory.complete && !exactForeground)) {
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
    if (selectedIsCurrent) {
      throw new WindowContractError("WINDOW_ALREADY_CURRENT", "selected window is already the current target");
    }
    current.windowRefs.clear();

    assertTransitionCurrent();
    let targetSurfaceRef = options.selectedSurfaceRef;
    if (targetSurfaceRef === undefined && confirmedChildEvidence === undefined) {
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

    let activationAttempted = false;
    if (this.options.windowDeliveryMode === "foreground") {
      assertTransitionCurrent();
      activationAttempted = true;
      try {
        await bringWindowToFrontOnce(current.driver, current.label, target, signal);
      } catch (error) {
        if (targetSurfaceRef === undefined) this.invalidateUnknownTargetTransition(current, activeRefBefore, undefined);
        else this.invalidateUnknownTargetTransition(current, activeRefBefore, targetSurfaceRef);
        throw error;
      }
    }

    let capture: Awaited<ReturnType<typeof captureWindowWithRetry>>;
    try {
      assertTransitionCurrent();
      capture = await captureWindowWithRetry(current.driver, current.label, target, signal, this.options.windowCaptureRetry, resolveCapturePlatform(this.options.platform, current.platform));
      assertTransitionCurrent();
    } catch (error) {
      if (activationAttempted) {
        if (targetSurfaceRef === undefined) this.invalidateUnknownTargetTransition(current, activeRefBefore, undefined);
        else this.invalidateUnknownTargetTransition(current, activeRefBefore, targetSurfaceRef);
      }
      throw error;
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
    return current.descriptor;
  }

  private invalidateUnknownTargetTransition(
    current: PrivateSession,
    previous: SurfaceRef | undefined,
    target: SurfaceRef | undefined,
  ): void {
    if (previous !== undefined && isCurrentSurfaceRef(current.surfaceRegistry, previous)) {
      const invalidated = markSurfaceUnknown(current.surfaceRegistry, previous);
      if (invalidated.decision === "applied") current.surfaceRegistry = invalidated.state;
    }
    if (target !== undefined && isCurrentSurfaceRef(current.surfaceRegistry, target)) {
      const invalidated = markSurfaceUnknown(current.surfaceRegistry, target);
      if (invalidated.decision === "applied") current.surfaceRegistry = invalidated.state;
    }
    current.windowRefs.clear();
    delete current.browserTarget;
    this.clearTargetObservationState(current, previous, target);
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
    current.firstObservedAfterActionWindows = undefined;
    if (current.missingParent !== undefined) return refused(action.actionId, "WINDOW_TARGET_INVALIDATED", "missing bound window awaits explicit handoff; no input was sent");
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
      if ((this.options.platform ?? current.platform ?? process.platform) === "darwin" && activeWindowBinding(current) !== undefined
        && ["click", "double_click", "right_click", "scroll", "drag"].includes(action.kind)) {
        const executionViewport = this.observations.get(String(executionObservationId))?.viewport;
        if (executionViewport === undefined || executionViewport.width !== decisionObservation.viewport.width || executionViewport.height !== decisionObservation.viewport.height || executionViewport.coordinateSpace !== decisionObservation.viewport.coordinateSpace) {
          return refused(action.actionId, "WINDOW_VIEWPORT_CHANGED", "window screenshot dimensions changed since the decision observation; observe and ground a new action; no input was sent");
        }
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
    const shortcutPlatform = this.options.platform ?? current.platform ?? process.platform;
    const locationBarShortcut = isBrowserShortcut(action, "L", shortcutPlatform);
    const selectAllShortcut = isBrowserShortcut(action, "A", shortcutPlatform);
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
    if (replayGuard !== undefined && !sameSurfaceRef(replayGuard.surfaceRef, activeRefAfterReconcile)) {
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
    const isMultilineType = current.platform === "win32" && action.kind === "type" && hasLineBreak(action.text);
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
    const browserTarget = privateGrounding?.browserTarget ?? current.browserTarget;
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
      && browserTarget !== undefined && privateGrounding?.domComplete === true
      ? findEquivalentDomGrounding(privateGrounding, resolvedGrounding)
      : undefined;
    if (action.kind === "click" && browserTarget !== undefined && resolvedGrounding?.element.source === "uia" &&
        resolvedGrounding.element.browserRegion !== "chrome" && domEquivalent === undefined) {
      return refused(action.actionId, "MANAGED_BROWSER_DOM_REQUIRED", "managed-browser content requires a unique equivalent from a complete DOM observation; no native click was sent");
    }
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
        viewport: decisionObservation?.viewport ?? session.viewport,
        browserTarget: latestGrounding.browserTarget,
        candidate: { role: candidate.element.role, ...(candidate.candidateName === undefined ? {} : { name: candidate.candidateName }), bbox: candidate.element.bbox, ...(candidate.candidateFrame === undefined ? {} : { frame: candidate.candidateFrame }), fingerprint: candidate.candidateFingerprint },
      };
    }
    if ((action.kind === "type" || action.kind === "keypress") && !locationBarShortcut && this.expectedDomInput !== undefined) {
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
      if (!isMultilineType) {
        request = actionRequest(
          requestAction,
          current.label,
          actionWindowBinding,
          this.options.windowDeliveryMode,
          decisionObservation?.viewport,
          this.options.platform ?? current.platform ?? process.platform,
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
          actionId: action.actionId,
          completed: false,
          targetKeys: visibleKeys,
          complete: visibleInventory.complete,
          truncated: visibleInventory.truncated === true,
          parentSurfaceRef: { ...parentSurfaceRef },
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
    if (isMultilineType) {
      // Preserve normal Surface/window preflight, then fail closed in the
      // Windows UIA route before any input primitive is dispatched.
      const receipt = await this.executeMultilineType(current, session, action, decisionObservation, actionWindowBinding, signal);
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
        const driverCode = windowRefusalCode(result.errorCode, result.text, resultProvesNoInput(result));
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
          return await this.unknownForegroundActionReceipt(current, action, decisionObservation.surfaceRef, signal);
        }
        if (driverCode === "WINDOW_FOREGROUND_MISMATCH") {
          current.foregroundMismatchWindowId = parseActualForegroundWindowId(result.text);
        }
        return refused(action.actionId, driverCode, result.text);
      }
      if (result.degraded) {
        return { actionId: action.actionId, status: "failed", driverCode: "CUA_DEGRADED", message: result.text };
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
      if (current.preActionWindowBaseline?.actionId === action.actionId) current.preActionWindowBaseline.completed = true;
      return { actionId: action.actionId, status: "completed", ...((result.text || diagnostic) ? { message: [result.text, diagnostic].filter(Boolean).join("; ") } : {}) };
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
        const structuredNoInput = resultProvesNoInput({
          text: details.message,
          ...(details.structuredJson === undefined ? {} : { structuredJson: details.structuredJson }),
        });
        const driverCode = windowRefusalCode(details.errorCode, details.message, structuredNoInput);
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
          return await this.unknownForegroundActionReceipt(current, action, decisionObservation.surfaceRef, signal);
        }
        if (driverCode === "WINDOW_FOREGROUND_MISMATCH") {
          current.foregroundMismatchWindowId = parseActualForegroundWindowId(details.message);
        }
        return refused(action.actionId, driverCode, details.message);
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
      const uia = await readGroundingCatalog(current.driver, current.label, binding, viewport, observationId, session.id, signal, true);
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

    // CUA 0.22.2's Windows UIA multiline writer may substitute an unreadable
    // old value with an empty string before SetValue. Until a trustworthy
    // no-write failure signal exists, never dispatch this element-token route.
    // This is a refusal before any input primitive; do not fall back to keys.
    if (current.platform === "win32") {
      return refused(
        action.actionId,
        "WINDOWS_UIA_MULTILINE_DISABLED",
        "Windows UIA multiline input is disabled until the driver can prove old-value reads before writing; no text was sent",
      );
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

function isBrowserShortcut(action: ActionIntent, key: string, platform: NodeJS.Platform): boolean {
  if (action.kind !== "keypress" || action.keys.length !== 2) return false;
  const keys = action.keys.map((part) => part.toUpperCase());
  const modifiers = platform === "darwin" ? ["CMD", "META"] : ["CTRL"];
  return keys.includes(key) && keys.some((part) => modifiers.includes(part));
}

function actionRequest(
  action: Exclude<ActionIntent, { kind: "wait" } | SwitchWindowAction>,
  session: string,
  windowBinding?: CuaWindowBinding,
  configuredDeliveryMode?: CuaWindowDeliveryMode,
  decisionViewport?: Viewport,
  platform: NodeJS.Platform = process.platform,
): { name: string; arguments: Record<string, unknown> } {
  const target = windowBinding === undefined ? PRIMARY_DESKTOP : windowActionTarget(windowBinding);
  const deliveryMode = windowBinding === undefined ? "foreground" : configuredDeliveryMode ?? "background";
  const point = (value: { x: number; y: number }) => windowBinding === undefined
    ? value
    : mapWindowPoint(value, decisionViewport, windowBinding.bounds, platform);
  switch (action.kind) {
    case "click":
      return { name: "click", arguments: { session, target, ...point(action.point), delivery_mode: deliveryMode } };
    case "double_click":
      return { name: "click", arguments: { session, target, ...point(action.point), count: 2, delivery_mode: deliveryMode } };
    case "right_click":
      return { name: "click", arguments: { session, target, ...point(action.point), button: "right", delivery_mode: deliveryMode } };
    case "type":
      return { name: "type_text", arguments: { session, target, text: action.text, delivery_mode: deliveryMode } };
    case "keypress": {
      if (action.keys.length === 1) {
        return { name: "press_key", arguments: { session, target, key: action.keys[0], delivery_mode: deliveryMode } };
      }
      const foregroundChord = platform === "win32" && windowBinding !== undefined && deliveryMode === "foreground"
        ? foregroundPressKeyChord(action.keys)
        : undefined;
      return foregroundChord === undefined
        ? { name: "hotkey", arguments: { session, target, keys: action.keys, delivery_mode: deliveryMode } }
        : { name: "press_key", arguments: {
            session,
            target,
            key: foregroundChord.key,
            modifiers: foregroundChord.modifiers,
            delivery_mode: deliveryMode,
          } };
    }
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
  if (mode === "dom-catalog-v1") {
    if (browserTarget === undefined || domTransport === undefined) return undefined;
    // DOM-only has no trusted producer for the browser content origin. Keep
    // its capability explicitly fail-closed until a browser-native content
    // rect producer is available; never guess from window bounds/DPI.
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
  if (browserTarget === undefined || domTransport === undefined) return uia;
  const dom = await readDomGroundingCatalog(domTransport, browserTarget, binding, viewport, observationId, computerSessionId, uia?.contentRect, signal);
  if (uia === undefined) return dom;
  if (dom === undefined) return uia;
  return mergeGroundings(uia, dom, observationId, computerSessionId);
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
  const query = readGroundingCatalog(driver, session, binding, viewport, observationId, computerSessionId, querySignal, false)
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
  const matches = [...grounding.elements.values()]
    .filter((candidate) => candidate.element.source === "dom" && candidate.element.bbox !== undefined)
    .filter((candidate) => equivalentBrowserCandidate(selected.element, candidate.element));
  if (matches.length !== 1) return undefined;
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
  if (hasExplicitIdentityMismatch(structured, binding.target)) return empty("unknown", true);
  const rawElements = structured?.elements;
  if (!Array.isArray(rawElements)) return empty("unknown", true);
  const snapshotId = safeCuaSnapshotId(structured?.snapshot_id ?? structured?.snapshotId);
  const parsed = rawElements.flatMap((value, index) => parseGroundingCandidate(value, index, binding, viewport, snapshotId));
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
    const element: GroundingElement = managedBrowserHybrid && isManagedBrowserContainerRole(candidate.element.role)
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
    if (report?.schema_version !== "1" || report.driver_version !== cuaSdkVersionForPlatform()) return undefined;
    return report.platform === "win32" || report.platform === "darwin" || report.platform === "linux"
      ? report.platform
      : undefined;
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted();
    return undefined;
  }
}

/**
 * Windows foreground press_key has a SendInput chord path; hotkey on modern
 * XAML targets instead tries UIA Accelerator matching. Convert only an
 * unambiguous one-base-key chord with known native modifiers. Background,
 * desktop, non-Windows, and multi-base actions retain the existing hotkey path.
 */
function foregroundPressKeyChord(keys: readonly string[]): { key: string; modifiers: string[] } | undefined {
  const modifiers: string[] = [];
  const baseKeys: string[] = [];
  const seenModifiers = new Set<string>();
  for (const key of keys) {
    const modifier = canonicalPressKeyModifier(key);
    if (modifier === undefined) {
      baseKeys.push(key);
      continue;
    }
    if (seenModifiers.has(modifier)) return undefined;
    seenModifiers.add(modifier);
    modifiers.push(modifier);
  }
  if (modifiers.length === 0 || baseKeys.length !== 1) return undefined;
  return { key: baseKeys[0]!, modifiers };
}

function canonicalPressKeyModifier(key: string): string | undefined {
  switch (key.toLowerCase()) {
    case "ctrl":
    case "control":
      return "ctrl";
    case "shift":
      return "shift";
    case "alt":
    case "menu":
    case "option":
      return "alt";
    case "win":
    case "windows":
    case "meta":
    case "cmd":
    case "command":
      return "win";
    default:
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
 * Validate image-local coordinates and apply the pinned platform contract.
 * The decision frame is the source of truth: an approved action may execute
 * against a later observation, but its coordinates were still produced from
 * action.basedOn. Geometry is checked by the caller before this projection.
 */
function mapWindowPoint(
  point: { x: number; y: number },
  sourceViewport: Viewport | undefined,
  targetBounds: CuaWindowGeometry,
  platform: NodeJS.Platform,
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
    // CUA 0.22.2 macOS click/scroll/drag consume get_window_state PNG pixels.
    // The driver reverses its per-window resize ratio and Retina backing
    // scale itself. A bounds projection here would apply a second transform.
    // Keep the historical Windows/Linux contract unchanged: Windows capture
    // through observation-only verify_state does not refresh its resize map.
    x: platform === "darwin" ? clampCoordinate(Math.round(point.x), sourceViewport.width) : clampCoordinate(Math.round(point.x * targetBounds.width / sourceViewport.width), targetBounds.width),
    y: platform === "darwin" ? clampCoordinate(Math.round(point.y), sourceViewport.height) : clampCoordinate(Math.round(point.y * targetBounds.height / sourceViewport.height), targetBounds.height),
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
