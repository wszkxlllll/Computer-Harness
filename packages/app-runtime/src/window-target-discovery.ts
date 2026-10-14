import type { CuaWindowInfo, CuaWindowInventory } from "@computer-harness/computer-cua";
import type { WindowTargetInfo } from "./application-session.js";

/**
 * Project CUA's host-only inventory into local window targets. An owned-child
 * relation is emitted only when one complete, untruncated inventory proves
 * the exact child owner pair and that owner is itself an unowned row in the
 * same snapshot. This is evidence for initial target-pool narrowing, not a
 * surface/action permission.
 */
export function projectWindowTargetInventory(inventory: CuaWindowInventory): readonly WindowTargetInfo[] {
  const visibilityIsTrusted = inventory.complete === true && inventory.truncated !== true &&
    inventory.completeAttestation !== "negative" && (
      inventory.source === "win32_relationship_probe" ||
      (inventory.source === "cua_inventory" && inventory.completeAttestation === "explicit")
    );
  const ownerPairsAreTrusted = inventory.complete === true && inventory.truncated !== true &&
    inventory.completeAttestation !== "negative" && (
      inventory.source === "win32_relationship_probe" ||
      (inventory.source === "cua_inventory" && inventory.completeAttestation === "explicit" &&
        inventory.foregroundPid !== undefined && inventory.foregroundWindowId !== undefined &&
        inventory.windows.every((window) => window.zIndex !== undefined && window.isOnScreen !== undefined &&
          window.minimized !== undefined && window.ownerPid !== undefined && window.ownerWindowId !== undefined &&
          window.windowClass !== undefined))
    );
  const counts = new Map<string, number>();
  for (const window of inventory.windows) {
    const key = identityKey(window.target);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const uniqueRows = new Map(inventory.windows
    .filter((window) => counts.get(identityKey(window.target)) === 1)
    .map((window) => [identityKey(window.target), window]));

  return inventory.windows.flatMap((window) => {
    // Keep full rows available above while checking exact owner pairs, then
    // exclude only positively known invisible, non-minimized helper windows
    // from the user/provider target pool. Missing visibility evidence remains
    // eligible for legacy/partial SDK inventories.
    if (visibilityIsTrusted && window.isOnScreen === false && window.minimized === false) return [];
    const relationship = ownerPairsAreTrusted ? directOwnedChildRelationship(window, uniqueRows) : undefined;
    return [{
      pid: window.target.pid,
      windowId: window.target.windowId,
      ...(window.appName === undefined ? {} : { appName: window.appName }),
      ...(window.title === undefined ? {} : { title: window.title }),
      ...(relationship === undefined ? {} : { relationship }),
    }];
  });
}

function directOwnedChildRelationship(
  child: CuaWindowInfo,
  uniqueRows: ReadonlyMap<string, CuaWindowInfo>,
): WindowTargetInfo["relationship"] | undefined {
  const ownerPid = child.ownerPid;
  const ownerWindowId = child.ownerWindowId;
  if (!isPositiveSafeInteger(ownerPid) || !isPositiveSafeInteger(ownerWindowId)) return undefined;
  const owner = { pid: ownerPid, windowId: ownerWindowId };
  if (sameIdentity(child.target, owner)) return undefined;
  const parent = uniqueRows.get(identityKey(owner));
  if (parent === undefined || parent.ownerPid !== 0 || parent.ownerWindowId !== 0) return undefined;
  return { kind: "owned_child", owner };
}

function identityKey(identity: { readonly pid: number; readonly windowId: number }): string {
  return `${identity.pid}:${identity.windowId}`;
}

function sameIdentity(left: { readonly pid: number; readonly windowId: number }, right: { readonly pid: number; readonly windowId: number }): boolean {
  return left.pid === right.pid && left.windowId === right.windowId;
}

function isPositiveSafeInteger(value: number | undefined): value is number {
  return Number.isSafeInteger(value) && value! > 0;
}
