import type { ComputerWindowCandidateRelationship } from "@computer-harness/protocol";
import { assessOwnedTransientWindowAdmission } from "./transient-window-admission.js";
import type { NativeWindowIdentity, TransientChildEvidence } from "./surface-registry.js";
import type { CuaWindowInfo, CuaWindowInventory, CuaWindowTarget } from "./window-contract.js";

const TRUSTED_MENU_WINDOW_CLASSES = new Set(["#32768"]);

function identityKey(target: CuaWindowTarget): string {
  return `${target.pid}:${target.windowId}`;
}

function nativeIdentity(target: CuaWindowTarget): NativeWindowIdentity {
  return { pid: target.pid, hwnd: target.windowId };
}

export function trustedWindowClassRootRole(windowClass: string | undefined): "menu" | "dialog" | undefined {
  if (windowClass !== undefined && TRUSTED_MENU_WINDOW_CLASSES.has(windowClass)) return "menu";
  if (windowClass === "#32770") return "dialog";
  return undefined;
}

export function hasUniqueOwnedMenuStack(
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

/** The exact-child UIA query is valid only with a complete Win32 relationship snapshot. */
export function canVerifyExactTransientRoot(inventory: CuaWindowInventory): boolean {
  return inventory.source === "win32_relationship_probe" && inventory.complete && inventory.truncated !== true;
}

export function win32RelationshipChildEvidence(
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
  // by verifyTransientNativeChildRoot; this path requires exact foreground.
  if (!exactForeground) return undefined;
  const evidenceKind = "exact_foreground";
  return {
    kind: "native_window",
    nativeWindow: nativeIdentity(candidate.target),
    owner: nativeIdentity(owner),
    visible: true,
    interactionPolicy: "modal",
    relationshipProof: evidenceKind,
    frontmostEvidence: evidenceKind,
    admissionSource: "win32_relationship_probe",
  };
}

export function hasExactOwnedAuxiliaryStackEvidence(
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
  const parentRows = inventory.windows.filter((window) => identityKey(window.target) === identityKey(owner));
  const candidateRows = inventory.windows.filter((window) => identityKey(window.target) === identityKey(candidate.target));
  return parentRows.length === 1 && candidateRows.length === 1 && parentRows[0]!.isOnScreen === true &&
    parentRows[0]!.minimized !== true && parentRows[0]!.zIndex !== undefined &&
    candidate.zIndex > parentRows[0]!.zIndex!;
}

export function windowCandidateRelationship(
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

export function win32OwnedChildEvidence(
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
    nativeWindow: nativeIdentity(candidate.target),
    owner: nativeIdentity(owner),
    visible: true,
    interactionPolicy: "modal",
    relationshipProof,
    frontmostEvidence: relationshipProof,
    admissionSource: "win32_relationship_probe",
  };
}
