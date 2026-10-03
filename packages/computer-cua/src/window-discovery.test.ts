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
