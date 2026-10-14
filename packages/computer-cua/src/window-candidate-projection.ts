import type { ComputerWindowIdentity } from "@computer-harness/protocol";
import type { CuaWindowInfo } from "./window-contract.js";

export const SELECTABLE_WINDOW_CANDIDATE_LIMIT = 128;

export interface SelectableWindowCandidateProjection {
  readonly windows: readonly CuaWindowInfo[];
  readonly truncated: boolean;
  readonly omittedCount: number;
}

/**
 * Build the bounded model-facing list from a full topology snapshot. This
 * projection never mutates or caps the source rows; callers must finish all
 * parent/child/absence reasoning against the original inventory first.
 */
export function projectSelectableWindowCandidates(
  windows: readonly CuaWindowInfo[],
  currentTarget: ComputerWindowIdentity | undefined,
  platform: "win32" | "darwin" | "linux" | undefined,
  limit = SELECTABLE_WINDOW_CANDIDATE_LIMIT,
  include?: (window: CuaWindowInfo) => boolean,
  preserveExactOwnedTransientChildren = false,
): SelectableWindowCandidateProjection {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("window candidate limit must be a positive safe integer");
  const currentKey = currentTarget === undefined ? undefined : identityKey(currentTarget);
  const candidates = windows
    .filter((window) => currentKey === identityKey(window.target) ||
      isSelectableApplicationWindow(window, platform) ||
      preserveExactOwnedTransientChildren && currentTarget !== undefined &&
        window.ownerPid === currentTarget.pid && window.ownerWindowId === currentTarget.windowId &&
        window.isOnScreen === true && window.minimized !== true)
    .filter((window) => include === undefined || include(window))
    .sort((left, right) => compareCandidates(left, right, currentKey));
  const selected = candidates.slice(0, limit);
  return {
    windows: selected,
    truncated: candidates.length > selected.length,
    omittedCount: Math.max(0, candidates.length - selected.length),
  };
}

export function isRelevantManualWindowCandidate(
  window: CuaWindowInfo,
  currentTarget: ComputerWindowIdentity,
  foreground: ComputerWindowIdentity | undefined,
  hostAuthorizedTargets: readonly ComputerWindowIdentity[] | undefined,
  platform: "win32" | "darwin" | "linux" | undefined,
): boolean {
  if (window.minimized === true ||
      (platform === "win32" ? window.isOnScreen !== true : window.isOnScreen === false)) return false;
  if (foreground !== undefined && identityKey(window.target) === identityKey(foreground)) return true;
  const exactOwnedChild = window.ownerPid === currentTarget.pid && window.ownerWindowId === currentTarget.windowId;
  if (exactOwnedChild) return true;
  if (hostAuthorizedTargets?.some((target) => identityKey(target) === identityKey(window.target))) return true;
  // Same-process visible user windows can be related to the current task even
  // when the provider omitted owner metadata. Labels alone never establish
  // relevance; hidden/minimized helpers and known menu HWNDs were filtered by
  // the shared projection above.
  return window.target.pid === currentTarget.pid;
}

function isSelectableApplicationWindow(
  window: CuaWindowInfo,
  platform: "win32" | "darwin" | "linux" | undefined,
): boolean {
  if (platform !== "win32") return true;
  // These are positive native relationship facts, not title/process-name
  // heuristics. Preserve minimized apps and all visible windows, including
  // untitled dialogs. A hidden, non-minimized HWND is not a switchable app
  // target; a native menu HWND is interaction state owned by its parent.
  if (window.isOnScreen === false && window.minimized !== true) return false;
  if (window.windowClass === "#32768") return false;
  return true;
}

function compareCandidates(
  left: CuaWindowInfo,
  right: CuaWindowInfo,
  currentKey: string | undefined,
): number {
  const leftCurrent = identityKey(left.target) === currentKey;
  const rightCurrent = identityKey(right.target) === currentKey;
  if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1;

  const visibility = visibilityRank(left) - visibilityRank(right);
  if (visibility !== 0) return visibility;
  const zOrder = (right.zIndex ?? Number.NEGATIVE_INFINITY) - (left.zIndex ?? Number.NEGATIVE_INFINITY);
  if (zOrder !== 0 && Number.isFinite(zOrder)) return zOrder;
  const minimized = Number(left.minimized === true) - Number(right.minimized === true);
  if (minimized !== 0) return minimized;
  const app = compareText(left.appName, right.appName);
  if (app !== 0) return app;
  const title = compareText(left.title, right.title);
  if (title !== 0) return title;
  return left.target.pid - right.target.pid || left.target.windowId - right.target.windowId;
}

function visibilityRank(window: CuaWindowInfo): number {
  if (window.isOnScreen === true) return 0;
  if (window.minimized === true) return 1;
  if (window.isOnScreen === undefined) return 1;
  return 2;
}

function compareText(left: string | undefined, right: string | undefined): number {
  const a = (left ?? "").toLowerCase();
  const b = (right ?? "").toLowerCase();
  return a < b ? -1 : a > b ? 1 : 0;
}

function identityKey(identity: ComputerWindowIdentity): string {
  return `${identity.pid}:${identity.windowId}`;
}
