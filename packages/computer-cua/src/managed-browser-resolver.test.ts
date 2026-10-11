import { describe, expect, it } from "vitest";
import type { CuaDriverLike } from "./cua-sdk-contract.js";
import {
  browserBoundsToCuaScaleFromPageMetrics,
  createManagedBrowserWindowBindingHint,
  inspectManagedPageActivity,
  managedBrowserWindowBoundsMatch,
  selectManagedBrowserStartupActivity,
  validateOwnedWindowResolution,
} from "./managed-browser-host.js";
import { ManagedBrowserWindowResolutionError, resolveOwnedManagedBrowserWindow, validateManagedBrowserWindowResolution } from "./managed-browser-resolver.js";

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

  it("accepts one uniquely owned window using an independently supplied DPI scale", async () => {
    const fixture = driverWithWindows([
      { pid: 5432, window_id: 2, bounds: { x: 24, y: 15, width: 1557, height: 1490 } },
      { pid: 9999, window_id: 3, bounds: { x: 864, y: 129, width: 516, height: 309 } },
    ]);
    await expect(resolveOwnedManagedBrowserWindow(fixture.driver, "s", 4321, new AbortController().signal, {
      browserWindowId: 77,
      browserBounds: { x: 10, y: 10, width: 1050, height: 1000 },
      browserBoundsToCuaScale: 1.5,
      ownedProcessIds: [5432],
    })).resolves.toMatchObject({ target: { pid: 5432, windowId: 2 } });
  });

  it("rejects candidate-derived scale and translated or malformed four-dimensional geometry", async () => {
    const browserBounds = { x: 10, y: 10, width: 800, height: 600 };
    expect(managedBrowserWindowBoundsMatch(
      { x: 20, y: 20, width: 1600, height: 1200 }, browserBounds, 1,
    )).toBe(false);
    expect(managedBrowserWindowBoundsMatch(
      { x: 40, y: 10, width: 800, height: 600 }, browserBounds, 1,
    )).toBe(false);
    expect(managedBrowserWindowBoundsMatch(
      { x: 10, y: 10, width: 800, height: 600 }, browserBounds, Number.NaN,
    )).toBe(false);

    const fixture = driverWithWindows([
      { pid: 5432, window_id: 1, bounds: { x: 20, y: 20, width: 1600, height: 1200 } },
      { pid: 5432, window_id: 2, bounds: { x: 40, y: 10, width: 800, height: 600 } },
    ]);
    await expect(resolveOwnedManagedBrowserWindow(fixture.driver, "s", 4321, new AbortController().signal, {
      browserWindowId: 77,
      browserBounds,
      browserBoundsToCuaScale: 1,
      ownedProcessIds: [5432],
    })).rejects.toMatchObject({ reason: "ownership_mismatch" });
  });

  it("derives scale only from stable independent page metrics", () => {
    const metrics = (zoom: number, osScale: number) => ({
      visualViewport: { clientWidth: 800 * zoom * osScale, clientHeight: 600 * zoom * osScale },
      cssVisualViewport: { clientWidth: 800, clientHeight: 600, zoom },
    });
    const before = metrics(1.25, 1.5);
    expect(browserBoundsToCuaScaleFromPageMetrics(before, before, "win32")).toBeCloseTo(1.5);
    expect(browserBoundsToCuaScaleFromPageMetrics(before, undefined, "win32")).toBeUndefined();
    expect(browserBoundsToCuaScaleFromPageMetrics(before, metrics(1.5, 1.5), "win32")).toBeUndefined();
    expect(browserBoundsToCuaScaleFromPageMetrics(undefined, undefined, "darwin")).toBe(1);
  });

  it("carries fake CDP page metrics through selection, resolution, and both validators", async () => {
    const page = { type: "page", id: "bound-page", webSocketDebuggerUrl: "ws://page" };
    const metrics = {
      visualViewport: { clientWidth: 1200, clientHeight: 900 },
      cssVisualViewport: { clientWidth: 800, clientHeight: 600, zoom: 1 },
    };
    let metricRead = 0;
    const connect: Parameters<typeof inspectManagedPageActivity>[3] = async (url) => ({
      async command(method) {
        if (url === "ws://browser" && method === "Browser.getWindowForTarget") return { result: { windowId: 77 } };
        if (url === "ws://browser" && method === "Browser.getWindowBounds") return { result: { bounds: { left: 10, top: 10, width: 800, height: 600 } } };
        if (url === "ws://page" && method === "Page.getLayoutMetrics") {
          metricRead += 1;
          return { result: metrics };
        }
        if (url === "ws://page" && method === "Runtime.evaluate") return { result: { result: { value: { visibilityState: "visible", hasFocus: true, navigationKey: "123.5" } } } };
        throw new Error(`unexpected fake CDP command ${method}`);
      },
      close() {},
    });
    const activity = await inspectManagedPageActivity(page, "ws://browser", new AbortController().signal, connect, "win32");
    expect(metricRead).toBe(2);
    const selected = selectManagedBrowserStartupActivity([activity], "bound-page", true);
    expect(selected?.browserBoundsToCuaScale).toBe(1.5);
    const hint = createManagedBrowserWindowBindingHint(selected!, [4321, 5432]);
    const fixture = driverWithWindows([
      { pid: 5432, window_id: 1, bounds: { x: 10, y: 10, width: 800, height: 600 } },
      { pid: 5432, window_id: 2, bounds: { x: 15, y: 15, width: 1200, height: 900 } },
    ]);
    const resolution = await resolveOwnedManagedBrowserWindow(fixture.driver, "s", 4321, new AbortController().signal, hint);
    expect(resolution?.target).toEqual({ pid: 5432, windowId: 2 });
    expect(validateOwnedWindowResolution(4321, resolution, hint)).toEqual(resolution?.target);
    expect(validateManagedBrowserWindowResolution(4321, resolution, hint)).toEqual(resolution?.target);
  });

  it("filters an exact DIP coincidence and a correctly scaled window together", async () => {
    const fixture = driverWithWindows([
      { pid: 5432, window_id: 1, bounds: { x: 10, y: 10, width: 800, height: 600 } },
      { pid: 5432, window_id: 2, bounds: { x: 15, y: 15, width: 1200, height: 900 } },
    ]);
    const hint = {
      browserWindowId: 77,
      browserBounds: { x: 10, y: 10, width: 800, height: 600 },
      browserBoundsToCuaScale: 1.5,
      ownedProcessIds: [5432],
    };
    await expect(resolveOwnedManagedBrowserWindow(fixture.driver, "s", 4321, new AbortController().signal, hint))
      .resolves.toMatchObject({ target: { pid: 5432, windowId: 2 } });
  });

  it.each(["missing", "changed"] as const)("does not resolve scaled candidates when CDP metrics are %s", async (metricState) => {
    const page = { type: "page", id: "bound-page", webSocketDebuggerUrl: "ws://page" };
    const stable = { visualViewport: { clientWidth: 1200, clientHeight: 900 }, cssVisualViewport: { clientWidth: 800, clientHeight: 600, zoom: 1 } };
    const changed = { visualViewport: { clientWidth: 1200, clientHeight: 900 }, cssVisualViewport: { clientWidth: 800, clientHeight: 600, zoom: 1.25 } };
    let metricRead = 0;
    const connect: Parameters<typeof inspectManagedPageActivity>[3] = async (url) => ({
      async command(method) {
        if (url === "ws://browser" && method === "Browser.getWindowForTarget") return { result: { windowId: 77 } };
        if (url === "ws://browser" && method === "Browser.getWindowBounds") return { result: { bounds: { left: 10, top: 10, width: 800, height: 600 } } };
        if (url === "ws://page" && method === "Page.getLayoutMetrics") {
          const index = metricRead++;
          if (metricState === "missing" && index > 0) return { result: undefined };
          return { result: index === 0 ? stable : metricState === "changed" ? changed : stable };
        }
        if (url === "ws://page" && method === "Runtime.evaluate") return { result: { result: { value: { visibilityState: "visible", hasFocus: true } } } };
        throw new Error(`unexpected fake CDP command ${method}`);
      },
      close() {},
    });
    const activity = await inspectManagedPageActivity(page, "ws://browser", new AbortController().signal, connect, "win32");
    const selected = selectManagedBrowserStartupActivity([activity], "bound-page", true);
    const hint = createManagedBrowserWindowBindingHint(selected!, [4321, 5432]);
    expect(hint.browserBoundsToCuaScale).toBeUndefined();
    const fixture = driverWithWindows([{ pid: 5432, window_id: 2, bounds: { x: 15, y: 15, width: 1200, height: 900 } }]);
    await expect(resolveOwnedManagedBrowserWindow(fixture.driver, "s", 4321, new AbortController().signal, hint))
      .rejects.toMatchObject({ reason: "ownership_mismatch" });
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
