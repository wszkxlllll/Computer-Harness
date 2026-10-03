import type { CuaWindowTarget } from "./window-contract.js";

export interface ExactWindowRootProjection {
  readonly role: "menu" | "popup" | "dialog" | "window";
  readonly complete: true;
}

/**
 * Project a root role only from one exact HWND's structured state. The
 * established complete depth-zero contract remains authoritative. Some UIA
 * providers instead return a complete counted slice whose first node is below
 * depth zero; that fallback requires exact top-level identity, matching safe
 * counts, one unique shallowest node, and a strict transient root role.
 */
export function projectExactWindowRoot(
  state: Record<string, unknown> | undefined,
  target: CuaWindowTarget,
): ExactWindowRootProjection | undefined {
  if (state === undefined) return undefined;
  const depthZero = projectCompleteDepthZeroRoot(state, target);
  if (depthZero !== undefined) return depthZero;
  return projectCountedMinimumDepthRoot(state, target);
}

function projectCompleteDepthZeroRoot(
  state: Record<string, unknown>,
  target: CuaWindowTarget,
): ExactWindowRootProjection | undefined {
  if (state.truncated === true || state.degraded === true || state.complete !== true ||
      state.elements_complete !== true || !Array.isArray(state.elements) ||
      !optionalIdentityMatches(state, target, ["pid", "window_pid", "windowPid"], ["window_id", "windowId"])) {
    return undefined;
  }
  const rootKeys = ["root_surface", "rootSurface"].filter((key) => Object.hasOwn(state, key));
  const assertedRoots: Record<string, unknown>[] = [];
  for (const key of rootKeys) {
    const root = asRecord(state[key]);
    if (root === undefined || requiredIdentity(root, ["pid", "window_pid", "windowPid"]) !== target.pid ||
        requiredIdentity(root, ["window_id", "windowId"]) !== target.windowId || root.complete !== true) return undefined;
    assertedRoots.push(root);
  }

  const roots = state.elements.filter((element): element is Record<string, unknown> =>
    asRecord(element) !== undefined && (element as Record<string, unknown>).depth === 0);
  if (roots.length !== 1) return undefined;
  const rootElement = roots[0]!;
  if (!optionalIdentityMatches(rootElement, target, ["pid", "window_pid", "windowPid"], ["window_id", "windowId"])) return undefined;
  const role = establishedRole(rootElement.role ?? assertedRoots[0]?.role);
  if (assertedRoots.some((root) => Object.hasOwn(root, "role") && establishedRole(root.role) !== role)) return undefined;
  return role === undefined ? undefined : { role, complete: true };
}

function projectCountedMinimumDepthRoot(
  state: Record<string, unknown>,
  target: CuaWindowTarget,
): ExactWindowRootProjection | undefined {
  if (state.degraded === true || state.truncated === true ||
      (Object.hasOwn(state, "complete") && state.complete !== true) || !hasExactIdentity(state, target)) return undefined;
  if (!Array.isArray(state.elements)) return undefined;

  const expectedCount = consistentCount(state, "element_count", "elementCount");
  const returnedCount = consistentCount(state, "returned_element_count", "returnedElementCount");
  const totalCount = consistentCount(state, "total_element_count", "totalElementCount");
  if (expectedCount === undefined || returnedCount === undefined || totalCount === undefined ||
      expectedCount !== state.elements.length || returnedCount !== state.elements.length || totalCount !== state.elements.length) {
    return undefined;
  }

  const elements: Array<{ readonly value: Record<string, unknown>; readonly depth: number }> = [];
  for (const element of state.elements) {
    const record = asRecord(element);
    if (record === undefined || !Number.isSafeInteger(record.depth) || (record.depth as number) < 0) {
      return undefined;
    }
    elements.push({ value: record, depth: record.depth as number });
  }
  if (elements.length === 0) return undefined;

  const minimumDepth = Math.min(...elements.map((element) => element.depth));
  const minimumElements = elements.filter((element) => element.depth === minimumDepth);
  if (minimumElements.length !== 1) return undefined;
  const selected = minimumElements[0]!.value;
  if (!optionalIdentityMatches(selected, target, ["pid", "window_pid", "windowPid"], ["window_id", "windowId"])) return undefined;
  const role = strictTransientRole(selected.role);
  if (role === undefined || !rootSurfaceAgrees(state, target, role)) return undefined;
  return { role, complete: true };
}

function rootSurfaceAgrees(
  state: Record<string, unknown>,
  target: CuaWindowTarget,
  projectedRole: "menu" | "popup" | "dialog",
): boolean {
  const keys = ["root_surface", "rootSurface"].filter((key) => Object.hasOwn(state, key));
  if (keys.length === 0) return true;
  for (const key of keys) {
    const root = asRecord(state[key]);
    if (root === undefined || requiredIdentity(root, ["pid", "window_pid", "windowPid"]) !== target.pid ||
        requiredIdentity(root, ["window_id", "windowId"]) !== target.windowId || root.complete !== true) return false;
    if (Object.hasOwn(root, "role") && strictTransientRole(root.role) !== projectedRole) return false;
  }
  return true;
}

function hasExactIdentity(state: Record<string, unknown>, target: CuaWindowTarget): boolean {
  return requiredIdentity(state, ["pid", "window_pid", "windowPid"]) === target.pid &&
    requiredIdentity(state, ["window_id", "windowId"]) === target.windowId;
}

function optionalIdentityMatches(
  value: Record<string, unknown>,
  target: CuaWindowTarget,
  pidKeys: readonly string[],
  windowIdKeys: readonly string[],
): boolean {
  const pid = optionalConsistentIdentity(value, pidKeys);
  const windowId = optionalConsistentIdentity(value, windowIdKeys);
  return pid !== null && windowId !== null &&
    (pid === undefined || pid === target.pid) && (windowId === undefined || windowId === target.windowId);
}

function requiredIdentity(value: Record<string, unknown>, keys: readonly string[]): number | undefined {
  const result = optionalConsistentIdentity(value, keys);
  return result === null || result === undefined ? undefined : result;
}

function optionalConsistentIdentity(value: Record<string, unknown>, keys: readonly string[]): number | undefined | null {
  const present = keys.filter((key) => Object.hasOwn(value, key));
  if (present.length === 0) return undefined;
  const identities = present.map((key) => safePositiveInteger(value[key]));
  if (identities.some((identity) => identity === undefined) || identities.some((identity) => identity !== identities[0])) return null;
  return identities[0];
}

function consistentCount(value: Record<string, unknown>, snakeKey: string, camelKey: string): number | undefined {
  const present = [snakeKey, camelKey].filter((key) => Object.hasOwn(value, key));
  if (present.length === 0) return undefined;
  const counts = present.map((key) => safeCount(value[key]));
  if (counts.some((count) => count === undefined) || counts.some((count) => count !== counts[0])) return undefined;
  return counts[0];
}

function safePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function safeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function strictTransientRole(value: unknown): "menu" | "popup" | "dialog" | undefined {
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase()) {
    case "menu": return "menu";
    case "popup": return "popup";
    case "dialog": return "dialog";
    default: return undefined;
  }
}

function establishedRole(value: unknown): "menu" | "popup" | "dialog" | "window" | undefined {
  if (typeof value !== "string") return undefined;
  const role = value.toLowerCase().replace(/[\s_-]/gu, "");
  if (role === "menu") return "menu";
  if (role === "popup" || role === "popupmenu" || role === "contextmenu") return "popup";
  if (role === "dialog" || role === "alertdialog" || role === "filedialog") return "dialog";
  if (role === "window") return "window";
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
