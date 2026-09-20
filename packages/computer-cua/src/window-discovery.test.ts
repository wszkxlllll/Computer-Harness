import { describe, expect, it } from "vitest";
import type { CuaDriverLike, ToolResult } from "@trycua/cua-driver";
import { CuaWindowDiscovery } from "./window-discovery.js";

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
