import type { CuaWindowGeometry, CuaWindowInfo, CuaWindowInventory, CuaWindowTarget } from "./window-contract.js";

/**
 * Host-only, read-only relationship evidence. Implementations are injected at
 * the adapter boundary so native APIs stay outside the portable Runtime.
 */
export interface WindowRelationshipProbeWindow {
  readonly pid: number;
  readonly windowId: number;
  readonly ownerPid?: number;
  readonly ownerWindowId?: number;
  readonly zIndex?: number;
  readonly isOnScreen: boolean;
  readonly minimized: boolean;
  readonly bounds: CuaWindowGeometry;
  readonly windowClass?: string;
  /** Optional top-level caption; control contents are never included. */
  readonly title?: string;
  /** Optional process basename without an executable path. */
  readonly appName?: string;
}

export interface WindowRelationshipProbeSnapshot {
  readonly complete: boolean;
  readonly truncated?: boolean;
  readonly source: "win32_relationship_probe";
  readonly windows: readonly WindowRelationshipProbeWindow[];
  readonly foregroundPid?: number;
  readonly foregroundWindowId?: number;
}

export interface WindowRelationshipProbe {
  read(signal: AbortSignal): Promise<WindowRelationshipProbeSnapshot>;
}

/**
 * Use one complete relationship-probe snapshot as the current topology and
 * bounds authority. CUA is independently sampled and contributes only exact
 * PID/HWND labels, unless it explicitly contradicts a relationship field for
 * an identity present in both snapshots. When CUA omits a label for an exact
 * identity, the probe's optional caption/process-name label is used. Row churn
 * and geometry movement are expected between these non-atomic reads and do not
 * invalidate the probe.
 */
export function mergeWindowRelationshipInventory(
  cua: CuaWindowInventory,
  probe: WindowRelationshipProbeSnapshot,
  onScreenOnly: boolean,
): CuaWindowInventory {
  const rows = validateProbeRows(probe.windows);
  const foregroundValid = validOptionalIdentity(probe.foregroundPid, probe.foregroundWindowId);
  const cuaForegroundValid = validOptionalIdentity(cua.foregroundPid, cua.foregroundWindowId);
  const foregroundConflict = cua.foregroundPid !== undefined && probe.foregroundPid !== undefined &&
    (cua.foregroundPid !== probe.foregroundPid || cua.foregroundWindowId !== probe.foregroundWindowId);
  if (rows === undefined || !foregroundValid || !cuaForegroundValid || foregroundConflict ||
      probe.source !== "win32_relationship_probe" || typeof probe.complete !== "boolean" ||
      (probe.truncated !== undefined && typeof probe.truncated !== "boolean") ||
      !cuaCanBeAugmented(cua) || cua.truncated === true ||
      probe.truncated === true) {
    return rejectedMerge(cua, probe);
  }

  const probeByIdentity = new Map<string, WindowRelationshipProbeWindow>();
  for (const row of rows) {
    const key = identityKey(row);
    if (probeByIdentity.has(key)) return rejectedMerge(cua, probe);
    probeByIdentity.set(key, row);
  }

  const cuaRows = new Map<string, CuaWindowInfo>();
  for (const row of cua.windows) {
    const key = identityKey(row.target);
    if (cuaRows.has(key)) return rejectedMerge(cua, probe);
    cuaRows.set(key, row);
  }

  for (const [key, cuaRow] of cuaRows) {
    const probeRow = probeByIdentity.get(key);
    // A missing row is normal snapshot churn; only a field explicitly present
    // on both exact identities can establish a contradiction.
    if (probeRow !== undefined && !relationshipFieldsAgree(cuaRow, probeRow)) return rejectedMerge(cua, probe);
  }
  if (!relativeZOrderAgrees(cuaRows, probeByIdentity)) return rejectedMerge(cua, probe);

  if (!probe.complete || rows.some((row) => row.zIndex === undefined)) {
    return mergePartialExactRows(cua, probe, cuaRows, probeByIdentity, onScreenOnly);
  }

  const selectedRows = onScreenOnly ? rows.filter((row) => row.isOnScreen) : rows;
  const windows = selectedRows.map((row) => {
    const identity = { pid: row.pid, windowId: row.windowId };
    const cuaRow = cuaRows.get(identityKey(identity));
    const title = cuaRow?.title ?? row.title;
    const appName = cuaRow?.appName ?? row.appName;
    return {
      target: identity,
      bounds: { ...row.bounds },
      ...(title === undefined ? {} : { title }),
      ...(appName === undefined ? {} : { appName }),
      ...(row.zIndex === undefined ? {} : { zIndex: row.zIndex }),
      isOnScreen: row.isOnScreen,
      ...(row.ownerPid === undefined ? {} : { ownerPid: row.ownerPid }),
      ...(row.ownerWindowId === undefined ? {} : { ownerWindowId: row.ownerWindowId }),
      minimized: row.minimized,
      ...(row.windowClass === undefined ? {} : { windowClass: row.windowClass }),
    } satisfies CuaWindowInfo;
  });

  const foregroundKey = probe.foregroundPid === undefined || probe.foregroundWindowId === undefined
    ? undefined
    : `${probe.foregroundPid}:${probe.foregroundWindowId}`;
  const foregroundInProbe = foregroundKey !== undefined && probeByIdentity.has(foregroundKey);
  return {
    windows,
    complete: true,
    source: "win32_relationship_probe",
    ...(foregroundInProbe && probe.foregroundPid !== undefined ? { foregroundPid: probe.foregroundPid } : {}),
    ...(foregroundInProbe && probe.foregroundWindowId !== undefined ? { foregroundWindowId: probe.foregroundWindowId } : {}),
  };
}

function cuaCanBeAugmented(cua: CuaWindowInventory): boolean {
  if (typeof cua.complete !== "boolean" || (cua.truncated !== undefined && typeof cua.truncated !== "boolean") ||
      (cua.completeAttestation !== undefined && cua.completeAttestation !== "explicit" &&
        cua.completeAttestation !== "missing" && cua.completeAttestation !== "negative") ||
      cua.truncated === true || cua.completeAttestation === "negative") return false;
  if (cua.complete === true) return true;
  return cua.complete === false && cua.completeAttestation === "missing";
}

function mergePartialExactRows(
  cua: CuaWindowInventory,
  probe: WindowRelationshipProbeSnapshot,
  cuaRows: ReadonlyMap<string, CuaWindowInfo>,
  probeRows: ReadonlyMap<string, WindowRelationshipProbeWindow>,
  onScreenOnly: boolean,
): CuaWindowInventory {
  const windows = cua.windows.flatMap((cuaRow) => {
    const key = identityKey(cuaRow.target);
    const probeRow = probeRows.get(key);
    if (onScreenOnly && (probeRow?.isOnScreen === false || cuaRow.isOnScreen === false)) return [];
    if (probeRow === undefined) return [cuaRow];
    return [{
      ...cuaRow,
      ...(cuaRow.ownerPid === undefined && probeRow.ownerPid !== undefined ? { ownerPid: probeRow.ownerPid } : {}),
      ...(cuaRow.ownerWindowId === undefined && probeRow.ownerWindowId !== undefined ? { ownerWindowId: probeRow.ownerWindowId } : {}),
      ...(cuaRow.isOnScreen === undefined ? { isOnScreen: probeRow.isOnScreen } : {}),
      ...(cuaRow.minimized === undefined ? { minimized: probeRow.minimized } : {}),
      ...(cuaRow.windowClass === undefined && probeRow.windowClass !== undefined ? { windowClass: probeRow.windowClass } : {}),
      ...(cuaRow.title === undefined && probeRow.title !== undefined ? { title: probeRow.title } : {}),
      ...(cuaRow.appName === undefined && probeRow.appName !== undefined ? { appName: probeRow.appName } : {}),
    } satisfies CuaWindowInfo];
  });

  const foregroundKey = validOptionalIdentity(probe.foregroundPid, probe.foregroundWindowId)
    ? `${probe.foregroundPid}:${probe.foregroundWindowId}`
    : undefined;
  const foregroundRow = foregroundKey === undefined ? undefined : probeRows.get(foregroundKey);
  const foregroundExistsInCua = foregroundKey !== undefined && cuaRows.has(foregroundKey) && foregroundRow !== undefined &&
    (!onScreenOnly || foregroundRow.isOnScreen);
  return {
    windows,
    complete: false,
    completeAttestation: "negative",
    source: "win32_relationship_probe",
    ...(foregroundExistsInCua && probe.foregroundPid !== undefined ? { foregroundPid: probe.foregroundPid } : {}),
    ...(foregroundExistsInCua && probe.foregroundWindowId !== undefined ? { foregroundWindowId: probe.foregroundWindowId } : {}),
    ...(cua.truncated === true || probe.truncated === true ? { truncated: true } : {}),
  };
}

function rejectedMerge(cua: CuaWindowInventory, probe: WindowRelationshipProbeSnapshot): CuaWindowInventory {
  return {
    windows: cua.windows,
    complete: false,
    completeAttestation: "negative",
    source: "win32_relationship_probe",
    ...(cua.truncated === true || probe.truncated === true ? { truncated: true } : {}),
  };
}

function validateProbeRows(
  windows: readonly WindowRelationshipProbeWindow[],
): readonly WindowRelationshipProbeWindow[] | undefined {
  if (!Array.isArray(windows)) return undefined;
  const result: WindowRelationshipProbeWindow[] = [];
  for (const value of windows) {
    if (!isRecord(value) || !isPositiveSafeInteger(value.pid) || !isPositiveSafeInteger(value.windowId) ||
        typeof value.isOnScreen !== "boolean" || typeof value.minimized !== "boolean" ||
        !isWindowGeometry(value.bounds) ||
        (value.zIndex !== undefined && !Number.isSafeInteger(value.zIndex)) ||
        !validOptionalOwner(value.ownerPid, value.ownerWindowId) ||
        (value.windowClass !== undefined && !isAsciiClass(value.windowClass))) {
      return undefined;
    }
    const sanitized = { ...value };
    if (!isBoundedLabel(value.title, 240)) delete sanitized.title;
    if (!isBoundedLabel(value.appName, 128)) delete sanitized.appName;
    result.push(sanitized as unknown as WindowRelationshipProbeWindow);
  }
  return result;
}

function relationshipFieldsAgree(cua: CuaWindowInfo, probe: WindowRelationshipProbeWindow): boolean {
  return agreesWhenPresent(cua.ownerPid, probe.ownerPid) &&
    agreesWhenPresent(cua.ownerWindowId, probe.ownerWindowId) &&
    agreesWhenPresent(cua.isOnScreen, probe.isOnScreen) &&
    agreesWhenPresent(cua.minimized, probe.minimized) &&
    agreesWhenPresent(cua.windowClass, probe.windowClass);
}

/** CUA visible-list ranks and probe global-chain ranks have different scales. */
function relativeZOrderAgrees(
  cuaRows: ReadonlyMap<string, CuaWindowInfo>,
  probeRows: ReadonlyMap<string, WindowRelationshipProbeWindow>,
): boolean {
  const common: Array<{ cuaZ: number; probeZ: number }> = [];
  for (const [key, cua] of cuaRows) {
    const probe = probeRows.get(key);
    if (cua.zIndex === undefined || probe?.zIndex === undefined) continue;
    if (!Number.isSafeInteger(cua.zIndex)) return false;
    common.push({ cuaZ: cua.zIndex, probeZ: probe.zIndex });
  }
  common.sort((left, right) => left.cuaZ - right.cuaZ);
  // Strictly increasing adjacent pairs imply identical signs for every pair;
  // duplicate ranks on either side cannot prove an unambiguous ordering.
  return common.every((row, index) => index === 0 ||
    row.cuaZ > common[index - 1]!.cuaZ && row.probeZ > common[index - 1]!.probeZ);
}

function agreesWhenPresent<T>(left: T | undefined, right: T | undefined): boolean {
  return left === undefined || right === undefined || left === right;
}

function isWindowGeometry(value: unknown): value is CuaWindowGeometry {
  return isRecord(value) && Number.isSafeInteger(value.x) && Number.isSafeInteger(value.y) &&
    isPositiveSafeInteger(value.width) && isPositiveSafeInteger(value.height);
}

function validOptionalIdentity(pid: unknown, windowId: unknown): boolean {
  return (pid === undefined && windowId === undefined) ||
    (isPositiveSafeInteger(pid) && isPositiveSafeInteger(windowId));
}

function validOptionalOwner(ownerPid: unknown, ownerWindowId: unknown): boolean {
  return (ownerPid === undefined && ownerWindowId === undefined) ||
    (isNonNegativeSafeInteger(ownerPid) && isNonNegativeSafeInteger(ownerWindowId) &&
      ((ownerPid === 0) === (ownerWindowId === 0)));
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isAsciiClass(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[\x20-\x7e]+$/u.test(value);
}

function isBoundedLabel(value: unknown, maxLength: number): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength ||
      value.trim() !== value || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function identityKey(value: CuaWindowTarget | WindowRelationshipProbeWindow): string {
  return `${value.pid}:${value.windowId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
