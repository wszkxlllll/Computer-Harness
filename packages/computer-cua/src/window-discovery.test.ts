import { describe, expect, it } from "vitest";
import type { CuaDriverLike, ToolResult } from "./cua-sdk-contract.js";
import { installFakeCuaSdkModuleForTests } from "./cua-sdk-test-support.js";
import { CuaWindowDiscovery } from "./window-discovery.js";

installFakeCuaSdkModuleForTests();

function result(overrides: Partial<ToolResult> = {}): ToolResult {
  return {
    text: "ok",
    images: [],
    isError: false,
    degraded: false,
    rawJson: "{}",
    ...overrides,
  };
}

describe("CuaWindowDiscovery", () => {
  it("lists host windows through a temporary read-only session and cleans it up", async () => {
    const calls: string[] = [];
    const driver = {
      async startSession() { calls.push("startSession"); return { active: true, revived: false } as never; },
      async callTool(name: string) {
        calls.push(name);
        return result({ structuredJson: JSON.stringify({ windows: [{ pid: 1234, window_id: 5678, app_name: "Browser", title: "12306", bounds: { x: 1, y: 2, width: 3, height: 4 } }] }) });
      },
      async endSession() { calls.push("endSession"); return { active: false, session: "picker" } as never; },
      async shutdown() { calls.push("shutdown"); },
      uniffiDestroy() { calls.push("destroy"); },
    } as unknown as CuaDriverLike;
    const discovery = new CuaWindowDiscovery({ socketPath: "fixture", driverFactory: () => driver });
    await expect(discovery.listWindows(new AbortController().signal)).resolves.toEqual([{
      target: { pid: 1234, windowId: 5678 },
      bounds: { x: 1, y: 2, width: 3, height: 4 },
      appName: "Browser",
      title: "12306",
    }]);
    expect(calls).toEqual(["startSession", "list_windows", "endSession", "shutdown", "destroy"]);
  });

  it("normalizes the macOS inventory without collapsing distinct real windows", async () => {
    const driver = {
      async startSession() { return { active: true, revived: false } as never; },
      async callTool(name: string) {
        expect(name).toBe("list_windows");
        return result({ structuredJson: JSON.stringify({ windows: [
          // macOS emits one shallow menu-bar proxy per application/window.
          { pid: 10, window_id: 100, app_name: "Google Chrome", title: "", bounds: { x: 0, y: 0, width: 1512, height: 33 } },
          { pid: 10, window_id: 101, app_name: "Google Chrome", title: "", bounds: { x: 0, y: 0, width: 1512, height: 33 } },
          // Hidden Chromium placeholders are not actionable identities.
          { pid: 10, window_id: 102, app_name: "Google Chrome", title: "", bounds: { x: 0, y: 0, width: 1, height: 1 } },
          { pid: 10, window_id: 103, app_name: "Google Chrome", title: "", bounds: { x: 0, y: 0, width: 1, height: 1 } },
          // Untitled Accessibility service proxies are also not actionable.
          { pid: 10, window_id: 109, app_name: "CursorUIViewService", title: "", bounds: { x: 400, y: 500, width: 64, height: 64 } },
          // Untitled normal-size sheets remain available for explicit/manual
          // handoff, even when the app also has titled windows.
          { pid: 10, window_id: 104, app_name: "Google Chrome", title: "", bounds: { x: 99, y: 59, width: 1296, height: 139 } },
          { pid: 11, window_id: 105, app_name: "Google Chrome", title: "", bounds: { x: 99, y: 59, width: 1296, height: 139 } },
          // Same app and process, but two real titled windows: retain both.
          { pid: 10, window_id: 106, app_name: "Google Chrome", title: "Orders", bounds: { x: 0, y: 34, width: 1512, height: 948 } },
          { pid: 10, window_id: 107, app_name: "Google Chrome", title: "Calendar", bounds: { x: 12, y: 48, width: 1200, height: 800 } },
          // The same exact PID/HWND can be duplicated by the macOS bridge;
          // retain a different HWND even when all labels/geometries match.
          { pid: 10, window_id: 108, app_name: "Google Chrome", title: "Orders", bounds: { x: 0, y: 34, width: 1512, height: 948 } },
          // An app exposing only untitled windows remains available, and two
          // different geometries stay ambiguous for safety.
          { pid: 20, window_id: 200, app_name: "Terminal", title: "", bounds: { x: 20, y: 40, width: 900, height: 700 } },
          { pid: 20, window_id: 201, app_name: "Terminal", title: "", bounds: { x: 40, y: 60, width: 800, height: 600 } },
        ] }) });
      },
      async endSession() { return { active: false, session: "picker" } as never; },
      async shutdown() {},
      uniffiDestroy() {},
    } as unknown as CuaDriverLike;
    const discovery = new CuaWindowDiscovery({ socketPath: "fixture", driverFactory: () => driver, osPlatform: "darwin" });

    await expect(discovery.listWindows(new AbortController().signal)).resolves.toEqual([
      {
        target: { pid: 10, windowId: 104 },
        bounds: { x: 99, y: 59, width: 1296, height: 139 },
        appName: "Google Chrome",
      },
      {
        target: { pid: 11, windowId: 105 },
        bounds: { x: 99, y: 59, width: 1296, height: 139 },
        appName: "Google Chrome",
      },
      {
        target: { pid: 10, windowId: 106 },
        bounds: { x: 0, y: 34, width: 1512, height: 948 },
        appName: "Google Chrome",
        title: "Orders",
      },
      {
        target: { pid: 10, windowId: 107 },
        bounds: { x: 12, y: 48, width: 1200, height: 800 },
        appName: "Google Chrome",
        title: "Calendar",
      },
      {
        target: { pid: 10, windowId: 108 },
        bounds: { x: 0, y: 34, width: 1512, height: 948 },
        appName: "Google Chrome",
        title: "Orders",
      },
      {
        target: { pid: 20, windowId: 200 },
        bounds: { x: 20, y: 40, width: 900, height: 700 },
        appName: "Terminal",
      },
      {
        target: { pid: 20, windowId: 201 },
        bounds: { x: 40, y: 60, width: 800, height: 600 },
        appName: "Terminal",
      },
    ]);

    await expect(discovery.listWindows(new AbortController().signal, false)).resolves.toEqual([
      {
        target: { pid: 10, windowId: 104 },
        bounds: { x: 99, y: 59, width: 1296, height: 139 },
        appName: "Google Chrome",
      },
      {
        target: { pid: 11, windowId: 105 },
        bounds: { x: 99, y: 59, width: 1296, height: 139 },
        appName: "Google Chrome",
      },
      {
        target: { pid: 10, windowId: 106 },
        bounds: { x: 0, y: 34, width: 1512, height: 948 },
        appName: "Google Chrome",
        title: "Orders",
      },
      {
        target: { pid: 10, windowId: 107 },
        bounds: { x: 12, y: 48, width: 1200, height: 800 },
        appName: "Google Chrome",
        title: "Calendar",
      },
      {
        target: { pid: 10, windowId: 108 },
        bounds: { x: 0, y: 34, width: 1512, height: 948 },
        appName: "Google Chrome",
        title: "Orders",
      },
      {
        target: { pid: 20, windowId: 200 },
        bounds: { x: 20, y: 40, width: 900, height: 700 },
        appName: "Terminal",
      },
      {
        target: { pid: 20, windowId: 201 },
        bounds: { x: 40, y: 60, width: 800, height: 600 },
        appName: "Terminal",
      },
    ]);
  });

  it.each(["win32", "linux"] satisfies NodeJS.Platform[])(
    "does not apply macOS proxy heuristics on %s",
    async (osPlatform) => {
      const driver = {
        async startSession() { return { active: true, revived: false } as never; },
        async callTool() {
          return result({ structuredJson: JSON.stringify({ windows: [
            { pid: 30, window_id: 300, app_name: "Dashboard", title: "", bounds: { x: 0, y: 0, width: 1920, height: 32 } },
            { pid: 31, window_id: 301, app_name: "AccessibilityService", title: "", bounds: { x: 200, y: 300, width: 64, height: 64 } },
          ] }) });
        },
        async endSession() { return { active: false, session: "picker" } as never; },
        async shutdown() {},
        uniffiDestroy() {},
      } as unknown as CuaDriverLike;
      const discovery = new CuaWindowDiscovery({ socketPath: "fixture", driverFactory: () => driver, osPlatform });

      await expect(discovery.listWindows(new AbortController().signal)).resolves.toEqual([
        {
          target: { pid: 30, windowId: 300 },
          bounds: { x: 0, y: 0, width: 1920, height: 32 },
          appName: "Dashboard",
        },
        {
          target: { pid: 31, windowId: 301 },
          bounds: { x: 200, y: 300, width: 64, height: 64 },
          appName: "AccessibilityService",
        },
      ]);
    },
  );

  it("can read the full top-level inventory and restore only the exact selected HWND", async () => {
    const calls: Array<{ tool: string; args?: Record<string, unknown> }> = [];
    const driver = {
      async startSession() { calls.push({ tool: "startSession" }); return { active: true, revived: false } as never; },
      async callTool(name: string, rawArgs: string) {
        const args = JSON.parse(rawArgs) as Record<string, unknown>;
        calls.push({ tool: name, args });
        if (name === "list_windows") {
          return result({ structuredJson: JSON.stringify({ windows: [{ pid: 102_140, window_id: 33_296_778, app_name: "Weixin", title: "微信", bounds: { x: -2_000, y: -2_000, width: 800, height: 600 } }] }) });
        }
        return result({ structuredJson: JSON.stringify({ landed_on_target: true, target_hwnd: "33296778", now_fg_hwnd: "33296778" }) });
      },
      async endSession() { calls.push({ tool: "endSession" }); return { active: false, session: "picker" } as never; },
      async shutdown() { calls.push({ tool: "shutdown" }); },
      uniffiDestroy() { calls.push({ tool: "destroy" }); },
    } as unknown as CuaDriverLike;
    const discovery = new CuaWindowDiscovery({ socketPath: "fixture", driverFactory: () => driver });

    await expect(discovery.listWindows(new AbortController().signal, false)).resolves.toMatchObject([
      { target: { pid: 102_140, windowId: 33_296_778 }, title: "微信" },
    ]);
    await discovery.activateWindow({ pid: 102_140, windowId: 33_296_778 }, new AbortController().signal);

    expect(calls.filter((call) => call.tool === "list_windows")[0]?.args).toMatchObject({ on_screen_only: false });
    expect(calls.filter((call) => call.tool === "bring_to_front")[0]).toEqual({
      tool: "bring_to_front",
      args: { pid: 102_140, window_id: 33_296_778, session: expect.any(String) },
    });
  });

  it("accepts CUA 0.22.2 Cocoa activation evidence with the observed focused HWND", async () => {
    const driver = {
      async startSession() { return { active: true, revived: false } as never; },
      async callTool(name: string) {
        expect(name).toBe("bring_to_front");
        return result({
          structuredJson: JSON.stringify({
            status: "activated",
            window_id: 10,
            exact_window_effect: { verified: true },
            observed: {
              focused_window_id: 10,
              frontmost_ordinary_window_id: 10,
              front_process_matches_target: true,
            },
          }),
        });
      },
      async endSession() { return { active: false, session: "picker" } as never; },
      async shutdown() {},
      uniffiDestroy() {},
    } as unknown as CuaDriverLike;
    const discovery = new CuaWindowDiscovery({ socketPath: "fixture", driverFactory: () => driver });
    await expect(discovery.activateWindow({ pid: 123, windowId: 10 }, new AbortController().signal)).resolves.toBeUndefined();
  });

  it("rejects an activation that does not report landing on the exact target", async () => {
    const calls: string[] = [];
    const driver = {
      async startSession() { calls.push("startSession"); return { active: true, revived: false } as never; },
      async callTool(name: string) {
        calls.push(name);
        return result({ structuredJson: JSON.stringify({ landed_on_target: false, target_hwnd: "10", now_fg_hwnd: "11" }) });
      },
      async endSession() { calls.push("endSession"); return { active: false, session: "picker" } as never; },
      async shutdown() { calls.push("shutdown"); },
      uniffiDestroy() { calls.push("destroy"); },
    } as unknown as CuaDriverLike;
    const discovery = new CuaWindowDiscovery({ socketPath: "fixture", driverFactory: () => driver });
    await expect(discovery.activateWindow({ pid: 123, windowId: 10 }, new AbortController().signal))
      .rejects.toMatchObject({ name: "WindowContractError", code: "WINDOW_ACTIVATION_REFUSED" });
    expect(calls).toEqual(["startSession", "bring_to_front", "endSession", "shutdown", "destroy"]);
  });

  it("classifies a surfaced sheet whose HWND cannot independently become foreground", async () => {
    const driver = {
      async startSession() { return { active: true, revived: false } as never; },
      async callTool(name: string) {
        expect(name).toBe("bring_to_front");
        return result({
          isError: true,
          structuredJson: JSON.stringify({
            status: "partial",
            window_id: 11,
            exact_window_effect: { verified: false },
            observed: {
              focused_window_id: 10,
              frontmost_ordinary_window_id: 10,
              front_process_matches_target: true,
            },
          }),
        });
      },
      async endSession() { return { active: false, session: "picker" } as never; },
      async shutdown() {},
      uniffiDestroy() {},
    } as unknown as CuaDriverLike;
    const discovery = new CuaWindowDiscovery({ socketPath: "fixture", driverFactory: () => driver });
    await expect(discovery.activateWindow({ pid: 123, windowId: 11 }, new AbortController().signal))
      .rejects.toMatchObject({
        name: "WindowContractError",
        code: "WINDOW_ACTIVATION_UNCONFIRMED",
        message: expect.stringContaining("no capture or input was sent"),
      });
  });

  it("attempts cleanup after an aborted start and exposes cleanup failure", async () => {
    const calls: string[] = [];
    const driver = {
      async startSession() { calls.push("startSession"); throw new Error("start aborted"); },
      async endSession() { calls.push("endSession"); throw new Error("session status unavailable"); },
      async shutdown() { calls.push("shutdown"); },
      uniffiDestroy() { calls.push("destroy"); },
    } as unknown as CuaDriverLike;
    const discovery = new CuaWindowDiscovery({ socketPath: "fixture", driverFactory: () => driver });
    await expect(discovery.listWindows(new AbortController().signal)).rejects.toMatchObject({
      name: "CuaWindowDiscoveryCleanupError",
      cleanupErrors: ["endSession: session status unavailable"],
    });
    expect(calls).toEqual(["startSession", "endSession", "shutdown"]);
  });

  it("retains failed cleanup for a bounded retry instead of destroying the driver", async () => {
    const calls: string[] = [];
    let endFailures = 1;
    const driver = {
      async startSession() { calls.push("startSession"); return { active: true, revived: false } as never; },
      async callTool(name: string) {
        calls.push(name);
        return result({ structuredJson: JSON.stringify({ windows: [] }) });
      },
      async endSession() {
        calls.push("endSession");
        if (endFailures > 0) { endFailures -= 1; throw new Error("temporary cleanup failure"); }
        return { active: false, session: "picker" } as never;
      },
      async shutdown() { calls.push("shutdown"); },
      uniffiDestroy() { calls.push("destroy"); },
    } as unknown as CuaDriverLike;
    const discovery = new CuaWindowDiscovery({ socketPath: "fixture", driverFactory: () => driver });
    await expect(discovery.listWindows(new AbortController().signal)).rejects.toMatchObject({ name: "CuaWindowDiscoveryCleanupError" });
    expect(calls).not.toContain("destroy");
    await expect(discovery.listWindows(new AbortController().signal)).resolves.toEqual([]);
    expect(calls).toEqual(["startSession", "list_windows", "endSession", "shutdown", "endSession", "shutdown", "destroy", "startSession", "list_windows", "endSession", "shutdown", "destroy"]);
  });

  it("serializes an overlapping picker request until the previous cleanup is settled", async () => {
    const calls: string[] = [];
    let factoryCalls = 0;
    let firstEndStarted!: () => void;
    const firstEndStartedPromise = new Promise<void>((resolve) => { firstEndStarted = resolve; });
    let releaseFirstEnd!: () => void;
    const firstEndGate = new Promise<void>((resolve) => { releaseFirstEnd = resolve; });
    let endCalls = 0;
    const makeDriver = (name: string, blockFirstEnd = false): CuaDriverLike => ({
      async startSession() { calls.push(`${name}:startSession`); return { active: true, revived: false } as never; },
      async callTool(toolName: string) { calls.push(`${name}:${toolName}`); return result({ structuredJson: JSON.stringify({ windows: [] }) }); },
      async endSession() {
        calls.push(`${name}:endSession`);
        endCalls += 1;
        if (blockFirstEnd && endCalls === 1) {
          firstEndStarted();
          await firstEndGate;
          throw new Error("temporary cleanup failure");
        }
        return { active: false, session: "picker" } as never;
      },
      async shutdown() { calls.push(`${name}:shutdown`); },
      uniffiDestroy() { calls.push(`${name}:destroy`); },
    } as unknown as CuaDriverLike);
    const discovery = new CuaWindowDiscovery({
      socketPath: "fixture",
      driverFactory: () => {
        factoryCalls += 1;
        return factoryCalls === 1 ? makeDriver("first", true) : makeDriver("second");
      },
    });
    const first = discovery.listWindows(new AbortController().signal);
    await firstEndStartedPromise;
    const second = discovery.listWindows(new AbortController().signal);
    await Promise.resolve();
    expect(factoryCalls).toBe(1);
    expect(calls).toEqual(["first:startSession", "first:list_windows", "first:endSession"]);

    releaseFirstEnd();
    await expect(first).rejects.toMatchObject({ name: "CuaWindowDiscoveryCleanupError" });
    await expect(second).resolves.toEqual([]);
    expect(factoryCalls).toBe(2);
    expect(calls).toEqual([
      "first:startSession", "first:list_windows", "first:endSession", "first:shutdown",
      "first:endSession", "first:shutdown", "first:destroy",
      "second:startSession", "second:list_windows", "second:endSession", "second:shutdown", "second:destroy",
    ]);
  });
});
