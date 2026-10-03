import type { CuaWindowInfo, CuaWindowInventory, CuaWindowTarget } from "./window-contract.js";

export type OwnedTransientWindowAdmission =
  | { readonly decision: "admitted" }
  | { readonly decision: "manual"; readonly code: "TRANSIENT_SURFACE_UNKNOWN" | "WINDOW_INVENTORY_UNKNOWN"; readonly reason: string }
  | { readonly decision: "rejected"; readonly code: "WINDOW_SCOPE_REQUIRED"; readonly reason: string };

/**
 * Stage-one, read-only admission for a possible owned transient HWND.
 *
 * This deliberately does not authorize a general peer. The caller must pass
 * exactly one newly surfaced candidate and a still-current parent binding;
 * stage two must separately prove that this exact HWND's root role is Menu,
 * Popup, or Dialog before the SurfaceRegistry can push it.
 */
export function assessOwnedTransientWindowAdmission(input: {
  readonly parent: CuaWindowTarget;
  readonly candidate: CuaWindowInfo;
  readonly inventory: CuaWindowInventory;
  readonly surfacedWindowCount: number;
  readonly baselineComplete: boolean;
  readonly baselineTruncated?: boolean;
  readonly parentSurfaceCurrent: boolean;
}): OwnedTransientWindowAdmission {
  const { parent, candidate, inventory } = input;
  if (!input.parentSurfaceCurrent) {
    return {
      decision: "manual",
      code: "TRANSIENT_SURFACE_UNKNOWN",
      reason: "the pre-action parent Surface generation is no longer active",
    };
  }
  if (input.baselineTruncated === true || inventory.truncated === true) {
    return {
      decision: "manual",
      code: "WINDOW_INVENTORY_UNKNOWN",
      reason: "truncated window inventory cannot authorize transient child admission",
    };
  }
  if (input.surfacedWindowCount !== 1) {
    return {
      decision: "rejected",
      code: "WINDOW_SCOPE_REQUIRED",
      reason: "an out-of-scope transient candidate must be the only newly surfaced window",
    };
  }
  if (candidate.target.windowId === parent.windowId) {
    return {
      decision: "rejected",
      code: "WINDOW_SCOPE_REQUIRED",
      reason: "an independent transient child must have a distinct exact HWND",
    };
  }
  if (candidate.target.pid !== parent.pid && !hasTrustedCrossProcessOwner(candidate, parent, inventory)) {
    return {
      decision: "rejected",
      code: "WINDOW_SCOPE_REQUIRED",
      reason: "a cross-process transient child requires a complete Win32 snapshot proving its exact owner PID/HWND",
    };
  }
  if (candidate.ownerPid === undefined || candidate.ownerWindowId === undefined) {
    return {
      decision: "manual",
      code: "TRANSIENT_SURFACE_UNKNOWN",
      reason: "the candidate did not expose exact owner PID and HWND evidence",
    };
  }
  if (candidate.ownerPid !== parent.pid || candidate.ownerWindowId !== parent.windowId) {
    return {
      decision: "rejected",
      code: "WINDOW_SCOPE_REQUIRED",
      reason: "the candidate's exact owner does not match the authorized parent PID/HWND",
    };
  }
  if (candidate.isOnScreen === undefined) {
    return {
      decision: "manual",
      code: "TRANSIENT_SURFACE_UNKNOWN",
      reason: "the candidate lacks fresh on-screen evidence",
    };
  }
  if (candidate.isOnScreen !== true) {
    return {
      decision: "rejected",
      code: "WINDOW_SCOPE_REQUIRED",
      reason: "the candidate is not proven on-screen",
    };
  }
  if (candidate.minimized === true) {
    return {
      decision: "rejected",
      code: "WINDOW_SCOPE_REQUIRED",
      reason: "the candidate is minimized and cannot be admitted as a visible transient child",
    };
  }

  const candidateKey = identityKey(candidate.target);
  const matchingRows = inventory.windows.filter((window) => identityKey(window.target) === candidateKey);
  if (matchingRows.length !== 1) {
    return {
      decision: "manual",
      code: "TRANSIENT_SURFACE_UNKNOWN",
      reason: "the exact candidate identity is missing or duplicated in the complete inventory",
    };
  }
  const completeStacking = input.baselineComplete && inventory.complete;
  const exactForeground = inventory.foregroundPid === candidate.target.pid &&
    inventory.foregroundWindowId === candidate.target.windowId;
  if (!completeStacking) {
    if (exactForeground) return { decision: "admitted" };
    return {
      decision: "manual",
      code: "WINDOW_INVENTORY_UNKNOWN",
      reason: "incomplete global window evidence permits only exact foreground plus owner proof",
    };
  }
  const parents = inventory.windows.filter((window) => identityKey(window.target) === identityKey(parent));
  if (parents.length !== 1 || parents[0]!.zIndex === undefined || candidate.zIndex === undefined) {
    return {
      decision: "manual",
      code: "TRANSIENT_SURFACE_UNKNOWN",
      reason: "the exact parent row and candidate require known z-order in the complete inventory",
    };
  }
  if (candidate.zIndex <= parents[0]!.zIndex!) {
    return {
      decision: "manual",
      code: "TRANSIENT_SURFACE_UNKNOWN",
      reason: "the owned transient candidate is not above its exact parent window",
    };
  }

  // Shell helpers and other applications may be above a popup without
  // belonging to this interaction scope. Only the exact owner's visible,
  // non-minimized transient stack can make the candidate ambiguous.
  const ownedVisible: CuaWindowInfo[] = [];
  for (const window of inventory.windows) {
    if (window.ownerPid !== parent.pid || window.ownerWindowId !== parent.windowId) continue;
    if (window.isOnScreen === undefined) {
      return {
        decision: "manual",
        code: "TRANSIENT_SURFACE_UNKNOWN",
        reason: "the exact owner's transient stack contains unknown visibility",
      };
    }
    if (window.isOnScreen && window.minimized !== true) {
      if (window.zIndex === undefined) {
        return {
          decision: "manual",
          code: "TRANSIENT_SURFACE_UNKNOWN",
          reason: "the exact owner's visible transient stack contains unknown z-order",
        };
      }
      ownedVisible.push(window);
    }
  }
  if (ownedVisible.length === 0) {
    return {
      decision: "manual",
      code: "TRANSIENT_SURFACE_UNKNOWN",
      reason: "the complete inventory contains no visible exact-owned transient stack",
    };
  }

  const highestZ = Math.max(...ownedVisible.map((window) => window.zIndex!));
  const frontmost = ownedVisible.filter((window) => window.zIndex === highestZ);
  if (frontmost.length !== 1) {
    return {
      decision: "manual",
      code: "TRANSIENT_SURFACE_UNKNOWN",
      reason: "the exact owner's transient stack does not prove a unique highest HWND",
    };
  }
  if (identityKey(frontmost[0]!.target) !== candidateKey) {
    return {
      decision: "manual",
      code: "TRANSIENT_SURFACE_UNKNOWN",
      reason: "another exact-owned transient window is above the candidate",
    };
  }
  return { decision: "admitted" };
}

function hasTrustedCrossProcessOwner(
  candidate: CuaWindowInfo,
  parent: CuaWindowTarget,
  inventory: CuaWindowInventory,
): boolean {
  return inventory.source === "win32_relationship_probe" && inventory.complete && inventory.truncated !== true &&
    candidate.ownerPid === parent.pid && candidate.ownerWindowId === parent.windowId;
}

function identityKey(target: CuaWindowTarget): string {
  return `${target.pid}:${target.windowId}`;
}
