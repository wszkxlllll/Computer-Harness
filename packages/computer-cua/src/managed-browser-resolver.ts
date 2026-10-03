import type { CuaDriverLike } from "./cua-sdk-contract.js";
import type { CuaWindowTarget } from "./window-contract.js";
import { DomGroundingUnavailableError } from "./dom-grounding.js";
import { managedBrowserWindowBoundsMatch, type ManagedBrowserWindowBindingHint, type ManagedBrowserWindowResolution, type ManagedBrowserWindowResolutionDiagnostic } from "./managed-browser-host.js";

export type ManagedBrowserWindowResolutionFailure = "cua_query_failed" | "zero_windows" | "multiple_candidates" | "ownership_mismatch";

export class ManagedBrowserWindowResolutionError extends DomGroundingUnavailableError {
  public constructor(public readonly reason: ManagedBrowserWindowResolutionFailure) {
    super(`managed browser window resolver ${reason}`);
    this.name = "ManagedBrowserWindowResolutionError";
  }
}

/**
 * Resolve exactly one top-level CUA window for the active managed CDP page.
 * Ownership uses explicit process evidence and optional CDP bounds; titles,
 * URLs and sibling-process guessing are never used as identity.
 */
export async function resolveOwnedManagedBrowserWindow(
  driver: CuaDriverLike,
  session: string,
  hostProcessId: number,
  signal: AbortSignal,
  hint?: ManagedBrowserWindowBindingHint,
): Promise<ManagedBrowserWindowResolution | undefined> {
  if (!Number.isSafeInteger(hostProcessId) || hostProcessId <= 0) return undefined;
  let result: Awaited<ReturnType<CuaDriverLike["callTool"]>>;
  try {
    result = await driver.callTool("list_windows", JSON.stringify({
      on_screen_only: true,
      ...(hint === undefined ? { pid: hostProcessId } : {}),
      session,
    }), { signal });
  } catch (error) {
    if (signal.aborted) throw error;
    emitDiagnostic(hint, diagnosticBase(hostProcessId, hint), "cua_query_failed");
    throw new ManagedBrowserWindowResolutionError("cua_query_failed");
  }
  if (result.isError || result.degraded) {
    emitDiagnostic(hint, diagnosticBase(hostProcessId, hint), "cua_query_failed");
    throw new ManagedBrowserWindowResolutionError("cua_query_failed");
  }
  const structured = parseStructured(result.structuredJson);
  const windows = structured?.windows;
  if (!Array.isArray(windows)) {
    emitDiagnostic(hint, diagnosticBase(hostProcessId, hint), "cua_query_failed");
    throw new ManagedBrowserWindowResolutionError("cua_query_failed");
  }
  const parsedWindows = windows.flatMap(parseWindow);
  if (parsedWindows.length === 0) {
    emitDiagnostic(hint, diagnosticBase(hostProcessId, hint, 0, 0, 0), "zero_windows");
    throw new ManagedBrowserWindowResolutionError("zero_windows");
  }
  const ownedProcessIds = new Set(hint?.ownedProcessIds ?? [hostProcessId]);
  let candidates = parsedWindows.filter((window) => ownedProcessIds.has(window.pid));
  const boundsMatchingCandidateCount = countBoundsMatches(candidates, hint?.browserBounds);
  const geometryCompatibleCandidateCount = countGeometryCompatibleCandidates(candidates, hint?.browserBounds);
  const base = diagnosticBase(hostProcessId, hint, parsedWindows.length, candidates.length, boundsMatchingCandidateCount, geometryCompatibleCandidateCount, candidates);
  if (candidates.length === 0) {
    emitDiagnostic(hint, base, "ownership_mismatch");
    throw new ManagedBrowserWindowResolutionError("ownership_mismatch");
  }
  const browserBounds = hint?.browserBounds;
  if (browserBounds !== undefined) {
    const exactCandidates = candidates.filter((window) => {
      const bounds = window.bounds;
      return bounds !== undefined && sameBounds(bounds, browserBounds);
    });
    candidates = exactCandidates.length > 0
      ? exactCandidates
      : candidates.filter((window) => window.bounds !== undefined && managedBrowserWindowBoundsMatch(window.bounds, browserBounds));
    if (candidates.length === 0) {
      emitDiagnostic(hint, base, "ownership_mismatch");
      throw new ManagedBrowserWindowResolutionError("ownership_mismatch");
    }
  }
  if (candidates.length > 1) {
    emitDiagnostic(hint, base, "multiple_candidates");
    throw new ManagedBrowserWindowResolutionError("multiple_candidates");
  }
  const window = candidates[0]!;
  const target: CuaWindowTarget = { pid: window.pid, windowId: window.windowId };
  emitDiagnostic(hint, base);
  return {
    target,
    ownershipEvidence: {
      ownedByHost: true,
      hostProcessId,
      processId: window.pid,
      windowId: target.windowId,
      windowCount: candidates.length,
      ...(hint?.browserWindowId === undefined ? {} : { browserWindowId: hint.browserWindowId }),
      ...(window.bounds === undefined ? {} : { windowBounds: window.bounds }),
    },
  };
}

function diagnosticBase(
  hostProcessId: number,
  hint: ManagedBrowserWindowBindingHint | undefined,
  candidateCount = 0,
  ownedCandidateCount = 0,
  boundsMatchingCandidateCount = 0,
  geometryCompatibleCandidateCount = 0,
  candidates: readonly ParsedWindow[] = [],
): ManagedBrowserWindowResolutionDiagnostic {
  return {
    hostProcessId,
    ownedProcessCount: hint?.ownedProcessIds?.length ?? 1,
    cdpBrowserWindowId: hint?.browserWindowId ?? 0,
    ...(hint?.browserBounds === undefined ? {} : { cdpBounds: hint.browserBounds }),
    candidateCount,
    ownedCandidateCount,
    boundsMatchingCandidateCount,
    geometryCompatibleCandidateCount,
    boundsDifferences: calculateBoundsDifferences(candidates, hint?.browserBounds),
  };
}

function emitDiagnostic(
  hint: ManagedBrowserWindowBindingHint | undefined,
  diagnostic: ManagedBrowserWindowResolutionDiagnostic,
  reason?: ManagedBrowserWindowResolutionDiagnostic["reason"],
): void {
  if (hint?.onDiagnostic === undefined) return;
  try {
    hint.onDiagnostic(reason === undefined ? diagnostic : { ...diagnostic, reason });
  } catch {
    // Diagnostics are best-effort and must never change the ownership result.
  }
}

function countBoundsMatches(
  candidates: readonly ParsedWindow[],
  browserBounds: ManagedBrowserWindowBindingHint["browserBounds"],
): number {
  if (browserBounds === undefined) return 0;
  return candidates.filter((candidate) => candidate.bounds !== undefined && sameBounds(candidate.bounds, browserBounds)).length;
}

function countGeometryCompatibleCandidates(
  candidates: readonly ParsedWindow[],
  browserBounds: ManagedBrowserWindowBindingHint["browserBounds"],
): number {
  if (browserBounds === undefined) return 0;
  return candidates.filter((candidate) => candidate.bounds !== undefined && managedBrowserWindowBoundsMatch(candidate.bounds, browserBounds)).length;
}

function calculateBoundsDifferences(
  candidates: readonly ParsedWindow[],
  browserBounds: ManagedBrowserWindowBindingHint["browserBounds"],
): readonly ManagedBrowserWindowResolutionDiagnostic["boundsDifferences"][number][] {
  if (browserBounds === undefined) return [];
  return candidates
    .filter((candidate) => candidate.bounds !== undefined)
    .slice(0, 8)
    .map((candidate) => ({
      dx: candidate.bounds!.x - browserBounds.x,
      dy: candidate.bounds!.y - browserBounds.y,
      dwidth: candidate.bounds!.width - browserBounds.width,
      dheight: candidate.bounds!.height - browserBounds.height,
    }));
}

export function validateManagedBrowserWindowResolution(
  browserProcessId: number,
  resolution: ManagedBrowserWindowResolution | undefined,
  hint?: ManagedBrowserWindowBindingHint,
): CuaWindowTarget {
  if (resolution === undefined) throw new ManagedBrowserWindowResolutionError("ownership_mismatch");
  const evidence = resolution.ownershipEvidence;
  if (!evidence.ownedByHost || evidence.hostProcessId !== browserProcessId || evidence.processId !== resolution.target.pid || evidence.windowId !== resolution.target.windowId || evidence.windowCount !== 1) {
    throw new ManagedBrowserWindowResolutionError("ownership_mismatch");
  }
  if (hint?.ownedProcessIds !== undefined && !hint.ownedProcessIds.includes(resolution.target.pid)) {
    throw new ManagedBrowserWindowResolutionError("ownership_mismatch");
  }
  if (hint?.browserWindowId !== undefined && evidence.browserWindowId !== hint.browserWindowId) {
    throw new ManagedBrowserWindowResolutionError("ownership_mismatch");
  }
  if (hint?.browserBounds !== undefined && (evidence.windowBounds === undefined || !managedBrowserWindowBoundsMatch(evidence.windowBounds, hint.browserBounds))) {
    throw new ManagedBrowserWindowResolutionError("ownership_mismatch");
  }
  return resolution.target;
}

function parseStructured(value: string | undefined): Record<string, unknown> | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

interface ParsedWindow {
  readonly pid: number;
  readonly windowId: number;
  readonly bounds?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

function parseWindow(value: unknown): ParsedWindow[] {
  if (!isRecord(value)) return [];
  const pid = positiveInteger(value.pid) ? value.pid : undefined;
  const windowId = positiveInteger(value.window_id) ? value.window_id : undefined;
  if (pid === undefined || windowId === undefined) return [];
  const bounds = parseBounds(value.bounds);
  return [{ pid, windowId, ...(bounds === undefined ? {} : { bounds }) }];
}

function parseBounds(value: unknown): ParsedWindow["bounds"] {
  if (!isRecord(value)) return undefined;
  const x = integer(value.x);
  const y = integer(value.y);
  const width = positiveInteger(value.width) ? value.width as number : undefined;
  const height = positiveInteger(value.height) ? value.height as number : undefined;
  return x === undefined || y === undefined || width === undefined || height === undefined ? undefined : { x, y, width, height };
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function sameBounds(left: NonNullable<ParsedWindow["bounds"]>, right: NonNullable<ManagedBrowserWindowBindingHint["browserBounds"]>): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}
