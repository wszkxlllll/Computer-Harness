import type { TransientChildEvidence, NativeWindowIdentity } from "./surface-registry.js";
import { sameWindowGeometry, type CuaWindowBinding, type CuaWindowInfo, type CuaWindowTarget } from "./window-contract.js";

export type MacAttachedSheetState =
  | { readonly status: "sheet"; readonly evidence: Extract<TransientChildEvidence, { readonly kind: "native_window" }> }
  | { readonly status: "geometry_unstable" }
  | { readonly status: "none" }
  | { readonly status: "unknown"; readonly reason: string };

export interface MacAttachedSheetEvidenceInput {
  readonly result: { readonly isError?: boolean; readonly degraded?: boolean };
  readonly parent: CuaWindowBinding;
  readonly candidate: CuaWindowInfo | undefined;
  readonly expectedAxParent?: CuaWindowTarget;
  readonly state: Record<string, unknown> | undefined;
  /** Exact-target check for the already parsed outer CUA state. */
  readonly parentIdentityMismatch: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return isRecord(value) ? value : undefined;
}

function nativeIdentity(target: CuaWindowTarget): NativeWindowIdentity {
  return { pid: target.pid, hwnd: target.windowId };
}

export function verifyMacAttachedSheetEvidence(input: MacAttachedSheetEvidenceInput): MacAttachedSheetState {
  const { result, parent, candidate, expectedAxParent, state } = input;
  if (result.isError) return { status: "unknown", reason: "native parent AX proof query failed" };
  if (state === undefined || input.parentIdentityMismatch) {
    return { status: "unknown", reason: "native parent AX proof has no exact target identity" };
  }
  const proof = parseRecord(state.attached_sheet_proof);
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
  const parentBounds = parseRecord(proof?.parent_bounds);
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
  const sheet = parseRecord(proof!.sheet);
  const bounds = parseRecord(sheet?.bounds);
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
    nativeWindow: nativeIdentity(candidate.target),
    owner: nativeIdentity(parent.target),
    rootRole: "dialog",
    visible: true,
    rootSemanticsVerified: true,
    interactionPolicy: "modal",
    frontmostEvidence: "exact_foreground",
    admissionSource: "macos_attached_sheet_proof",
  } };
}
