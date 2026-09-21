import { describe, expect, it } from "vitest";
import type { CuaDriverLike } from "@trycua/cua-driver";
import { ManagedBrowserWindowResolutionError, resolveOwnedManagedBrowserWindow } from "./managed-browser-resolver.js";

function driverWithWindows(windows: unknown[]): { driver: CuaDriverLike; calls: Array<{ name: string; input: Record<string, unknown> }> } {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const driver = {
    async callTool(name: string, inputJson: string) {
      calls.push({ name, input: JSON.parse(inputJson) as Record<string, unknown> });
      return { isError: false, degraded: false, structuredJson: JSON.stringify({ windows }), text: "", images: [], rawJson: "{}" };
    },
  } as unknown as CuaDriverLike;
  return { driver, calls };
}

describe("managed browser CUA window resolver", () => {
  it("uses strict pid/on_screen_only and returns one owned window", async () => {
    const fixture = driverWithWindows([{ pid: 4321, window_id: 9876, title: "ignored" }]);
    await expect(resolveOwnedManagedBrowserWindow(fixture.driver, "pilot-session", 4321, new AbortController().signal)).resolves.toMatchObject({
      target: { pid: 4321, windowId: 9876 },
      ownershipEvidence: { ownedByHost: true, hostProcessId: 4321, processId: 4321, windowCount: 1 },
    });
    expect(fixture.calls).toEqual([{ name: "list_windows", input: { on_screen_only: true, pid: 4321, session: "pilot-session" } }]);
  });

  it("gates zero, multiple, and mismatched windows without title matching", async () => {
    await expect(resolveOwnedManagedBrowserWindow(driverWithWindows([]).driver, "s", 4321, new AbortController().signal)).rejects.toMatchObject({ reason: "zero_windows" });
    await expect(resolveOwnedManagedBrowserWindow(driverWithWindows([{ pid: 4321, window_id: 1 }, { pid: 4321, window_id: 2 }]).driver, "s", 4321, new AbortController().signal)).rejects.toMatchObject({ reason: "multiple_candidates" });
    await expect(resolveOwnedManagedBrowserWindow(driverWithWindows([{ pid: 9999, window_id: 1, title: "same title" }]).driver, "s", 4321, new AbortController().signal)).rejects.toMatchObject({ reason: "ownership_mismatch" });
  });

  it("binds an Edge PID reattribution only with owned-process and CDP-window evidence", async () => {
    const fixture = driverWithWindows([
      { pid: 9999, window_id: 1, bounds: { x: 1, y: 2, width: 900, height: 700 }, title: "personal" },
      { pid: 5432, window_id: 2, bounds: { x: 10, y: 20, width: 1200, height: 800 }, title: "ignored" },
    ]);
    await expect(resolveOwnedManagedBrowserWindow(fixture.driver, "s", 4321, new AbortController().signal, {
      browserWindowId: 77,
      browserBounds: { x: 10, y: 20, width: 1200, height: 800 },
      ownedProcessIds: [4321, 5432],
    })).resolves.toMatchObject({ target: { pid: 5432, windowId: 2 }, ownershipEvidence: { processId: 5432, browserWindowId: 77 } });
    await expect(resolveOwnedManagedBrowserWindow(fixture.driver, "s", 4321, new AbortController().signal, {
      browserWindowId: 77,
      browserBounds: { x: 10, y: 20, width: 1200, height: 800 },
      ownedProcessIds: [4321],
    })).rejects.toMatchObject({ reason: "ownership_mismatch" });
    await expect(resolveOwnedManagedBrowserWindow(driverWithWindows([
      { pid: 5432, window_id: 2, bounds: { x: 10, y: 20, width: 1200, height: 800 } },
      { pid: 6543, window_id: 3, bounds: { x: 11, y: 21, width: 1200, height: 800 } },
    ]).driver, "s", 4321, new AbortController().signal, { browserWindowId: 77, ownedProcessIds: [4321, 5432, 6543] })).rejects.toMatchObject({ reason: "multiple_candidates" });
  });

  it("accepts one uniquely owned window when CDP and CUA use a common DPI scale", async () => {
    const fixture = driverWithWindows([
      { pid: 5432, window_id: 2, bounds: { x: 24, y: 15, width: 1557, height: 1490 } },
      { pid: 9999, window_id: 3, bounds: { x: 864, y: 129, width: 516, height: 309 } },
    ]);
    await expect(resolveOwnedManagedBrowserWindow(fixture.driver, "s", 4321, new AbortController().signal, {
      browserWindowId: 77,
      browserBounds: { x: 10, y: 10, width: 1050, height: 1000 },
      ownedProcessIds: [5432],
    })).resolves.toMatchObject({ target: { pid: 5432, windowId: 2 } });
  });

  it("classifies CUA query failure without exposing driver text", async () => {
    const driver = { async callTool() { throw new Error("private driver details"); } } as unknown as CuaDriverLike;
    await expect(resolveOwnedManagedBrowserWindow(driver, "s", 4321, new AbortController().signal)).rejects.toMatchObject({ reason: "cua_query_failed", message: expect.not.stringContaining("private driver details") });
    expect(ManagedBrowserWindowResolutionError).toBeDefined();
  });

  it("emits only bounded ownership and geometry diagnostics", async () => {
    const diagnostics: unknown[] = [];
    const fixture = driverWithWindows([
      { pid: 9999, window_id: 1, bounds: { x: 1, y: 2, width: 900, height: 700 }, title: "personal title must not leak" },
      { pid: 5432, window_id: 2, bounds: { x: 14, y: 22, width: 1200, height: 500 }, title: "managed title must not leak" },
    ]);
    await expect(resolveOwnedManagedBrowserWindow(fixture.driver, "s", 4321, new AbortController().signal, {
      browserWindowId: 77,
      browserBounds: { x: 10, y: 20, width: 1200, height: 800 },
      ownedProcessIds: [4321, 5432],
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })).rejects.toMatchObject({ reason: "ownership_mismatch" });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toEqual({
      hostProcessId: 4321,
      ownedProcessCount: 2,
      cdpBrowserWindowId: 77,
      cdpBounds: { x: 10, y: 20, width: 1200, height: 800 },
      candidateCount: 2,
      ownedCandidateCount: 1,
      boundsMatchingCandidateCount: 0,
      geometryCompatibleCandidateCount: 0,
      boundsDifferences: [{ dx: 4, dy: 2, dwidth: 0, dheight: -300 }],
      reason: "ownership_mismatch",
    });
    expect(JSON.stringify(diagnostics)).not.toContain("title");
  });
});
