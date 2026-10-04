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

function minimalPngBase64(width = 320, height = 240): string {
  const data = new Uint8Array(24);
  data.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(data.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return Buffer.from(data).toString("base64");
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

  it("returns one complete relationship inventory with exact owned-child metadata", async () => {
    const calls: string[] = [];
    const driver = {
      async startSession() { calls.push("startSession"); return { active: true, revived: false } as never; },
      async callTool(name: string) {
        calls.push(name);
        return result({ structuredJson: JSON.stringify({
          complete: true,
          windows: [{ pid: 1234, window_id: 5678, app_name: "Fixture.exe", title: "Parent", bounds: { x: 10, y: 20, width: 500, height: 400 } }],
        }) });
      },
      async endSession() { calls.push("endSession"); return { active: false, session: "picker" } as never; },
      async shutdown() { calls.push("shutdown"); },
      uniffiDestroy() { calls.push("destroy"); },
    } as unknown as CuaDriverLike;
    let probeCalls = 0;
    const discovery = new CuaWindowDiscovery({
      socketPath: "fixture",
      driverFactory: () => driver,
      windowRelationshipProbe: {
        async read() {
          probeCalls += 1;
          return {
            source: "win32_relationship_probe" as const,
            complete: true,
            foregroundPid: 1234,
            foregroundWindowId: 5678,
            windows: [
              {
                pid: 1234,
                windowId: 5678,
                ownerPid: 0,
                ownerWindowId: 0,
                zIndex: 10,
                isOnScreen: true,
                minimized: false,
                bounds: { x: 10, y: 20, width: 500, height: 400 },
                windowClass: "FixtureMainWindow",
                title: "Probe parent label",
                appName: "Fixture.exe",
              },
              {
                pid: 1234,
                windowId: 9012,
                ownerPid: 1234,
                ownerWindowId: 5678,
                zIndex: 11,
                isOnScreen: true,
                minimized: false,
                bounds: { x: 20, y: 80, width: 180, height: 240 },
                windowClass: "PopupWindowSiteBridge",
                title: "Owned popup",
                appName: "Fixture.exe",
              },
            ],
          };
        },
      },
    });

    const inventory = await discovery.listInventory(new AbortController().signal);

    expect(inventory).toMatchObject({
      complete: true,
      source: "win32_relationship_probe",
      foregroundPid: 1234,
      foregroundWindowId: 5678,
      windows: [
        { target: { pid: 1234, windowId: 5678 }, title: "Parent", ownerPid: 0, ownerWindowId: 0 },
        {
          target: { pid: 1234, windowId: 9012 },
          title: "Owned popup",
          ownerPid: 1234,
          ownerWindowId: 5678,
          windowClass: "PopupWindowSiteBridge",
        },
      ],
    });
    expect(probeCalls).toBe(1);
    expect(calls).toEqual(["startSession", "list_windows", "endSession", "shutdown", "destroy"]);
  });

  it("previews one fresh exact HWND without activation, input, asset writes, or surface work", async () => {
    const calls: string[] = [];
    const driver = {
      async startSession() { calls.push("startSession"); return { active: true, revived: false } as never; },
      async callTool(name: string) {
        calls.push(name);
        if (name !== "list_windows") return result();
        return result({ structuredJson: JSON.stringify({ complete: true, windows: [{
          pid: 1234,
          window_id: 5678,
          app_name: "Notepad.exe",
          title: "Untitled - Notepad",
          bounds: { x: 10, y: 20, width: 320, height: 240 },
        }] }) });
      },
      async verifyState(input: { pid: bigint; windowId: bigint; includeScreenshot: boolean }) {
        calls.push("verifyState");
        expect(input).toMatchObject({ pid: 1234n, windowId: 5678n, includeScreenshot: true });
        return result({
          verification: { status: 0, stable: true } as never,
          images: [{ mimeType: "image/png", dataBase64: minimalPngBase64() }],
        });
      },
      async endSession() { calls.push("endSession"); return { active: false, session: "picker" } as never; },
      async shutdown() { calls.push("shutdown"); },
      uniffiDestroy() { calls.push("destroy"); },
    } as unknown as CuaDriverLike;
    const discovery = new CuaWindowDiscovery({ socketPath: "fixture", driverFactory: () => driver });

    const preview = await discovery.captureWindowPreview({ pid: 1234, windowId: 5678 }, new AbortController().signal);

    expect(preview).toMatchObject({
      capture: { binding: { target: { pid: 1234, windowId: 5678 } }, viewport: { width: 320, height: 240 }, data: expect.any(Uint8Array) },
      inventory: { complete: true, windows: [{ appName: "Notepad.exe", title: "Untitled - Notepad" }] },
      capturedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
    });
    expect(calls).toEqual([
      "startSession", "list_windows", "list_windows", "verifyState", "list_windows",
      "endSession", "shutdown", "destroy",
    ]);
    expect(calls).not.toContain("bring_to_front");
    expect(calls).not.toContain("get_desktop_state");
    expect(calls).not.toContain("get_window_state");
  });

  it("previews an exact candidate present in a partial inventory without inferring global absence", async () => {
    const calls: string[] = [];
    const driver = {
      async startSession() { calls.push("startSession"); return { active: true, revived: false } as never; },
      async callTool(name: string) {
        calls.push(name);
        return result({ structuredJson: JSON.stringify({ complete: false, windows: [{
          pid: 1234,
          window_id: 5678,
          app_name: "Notepad.exe",
          title: "Untitled - Notepad",
          bounds: { x: 10, y: 20, width: 320, height: 240 },
        }] }) });
      },
      async verifyState() {
        calls.push("verifyState");
        return result({
          verification: { status: 0, stable: true } as never,
          images: [{ mimeType: "image/png", dataBase64: minimalPngBase64() }],
        });
      },
      async endSession() { calls.push("endSession"); return { active: false, session: "picker" } as never; },
      async shutdown() { calls.push("shutdown"); },
      uniffiDestroy() { calls.push("destroy"); },
    } as unknown as CuaDriverLike;
    const discovery = new CuaWindowDiscovery({ socketPath: "fixture", driverFactory: () => driver });

    await expect(discovery.captureWindowPreview({ pid: 1234, windowId: 5678 }, new AbortController().signal))
      .resolves.toMatchObject({ inventory: { complete: false }, capture: { binding: { target: { pid: 1234, windowId: 5678 } } } });
    expect(calls.filter((call) => call === "list_windows")).toHaveLength(3);
    expect(calls).toContain("endSession");
    expect(calls).toContain("shutdown");
    expect(calls).toContain("destroy");
  });

  it("rejects if the exact PID/HWND is absent after capture and still closes the temporary session", async () => {
    const calls: string[] = [];
    let listCount = 0;
    const driver = {
      async startSession() { calls.push("startSession"); return { active: true, revived: false } as never; },
      async callTool(name: string) {
        calls.push(name);
        if (name !== "list_windows") return result();
        listCount += 1;
        const target = listCount === 3
          ? { pid: 1234, window_id: 9999, app_name: "Notepad.exe", title: "Recreated", bounds: { x: 10, y: 20, width: 320, height: 240 } }
          : { pid: 1234, window_id: 5678, app_name: "Notepad.exe", title: "Untitled - Notepad", bounds: { x: 10, y: 20, width: 320, height: 240 } };
        return result({ structuredJson: JSON.stringify({ complete: false, windows: [target] }) });
      },
      async verifyState() {
        calls.push("verifyState");
        return result({
          verification: { status: 0, stable: true } as never,
          images: [{ mimeType: "image/png", dataBase64: minimalPngBase64() }],
        });
      },
      async endSession() { calls.push("endSession"); return { active: false, session: "picker" } as never; },
      async shutdown() { calls.push("shutdown"); },
      uniffiDestroy() { calls.push("destroy"); },
    } as unknown as CuaDriverLike;
    const discovery = new CuaWindowDiscovery({ socketPath: "fixture", driverFactory: () => driver });

    await expect(discovery.captureWindowPreview({ pid: 1234, windowId: 5678 }, new AbortController().signal))
      .rejects.toThrow("candidate is missing or ambiguous");
    expect(listCount).toBe(3);
    expect(calls).toContain("endSession");
    expect(calls).toContain("shutdown");
    expect(calls).toContain("destroy");
  });

  it("closes an in-progress capture when cancelled instead of retaining the temporary session", async () => {
    const calls: string[] = [];
    let captureStarted!: () => void;
    const started = new Promise<void>((resolve) => { captureStarted = resolve; });
    const driver = {
      async startSession() { calls.push("startSession"); return { active: true, revived: false } as never; },
      async callTool(name: string) {
        calls.push(name);
        return result({ structuredJson: JSON.stringify({ complete: true, windows: [{
          pid: 1234,
          window_id: 5678,
          app_name: "Notepad.exe",
          title: "Untitled - Notepad",
          bounds: { x: 10, y: 20, width: 320, height: 240 },
        }] }) });
      },
      async verifyState(_input: unknown, options: { signal: AbortSignal }) {
        calls.push("verifyState");
        captureStarted();
        await new Promise<never>((_resolve, reject) => {
          const fail = () => reject(options.signal.reason ?? new Error("capture cancelled"));
          if (options.signal.aborted) fail();
          else options.signal.addEventListener("abort", fail, { once: true });
        });
      },
      async endSession() { calls.push("endSession"); return { active: false, session: "picker" } as never; },
      async shutdown() { calls.push("shutdown"); },
      uniffiDestroy() { calls.push("destroy"); },
    } as unknown as CuaDriverLike;
    const discovery = new CuaWindowDiscovery({ socketPath: "fixture", driverFactory: () => driver });
    const controller = new AbortController();
    const preview = discovery.captureWindowPreview({ pid: 1234, windowId: 5678 }, controller.signal);
    await started;
    controller.abort(new Error("phone cancelled preview"));

    await expect(preview).rejects.toThrow("phone cancelled preview");
    expect(calls).toContain("endSession");
    expect(calls).toContain("shutdown");
    expect(calls).toContain("destroy");
  });

  it("rejects image bytes beyond the preview cap and closes the temporary session", async () => {
    const calls: string[] = [];
    const oversized = new Uint8Array(1_048_577);
    oversized.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
    oversized[12] = 73;
    oversized[13] = 72;
    oversized[14] = 68;
    oversized[15] = 82;
    new DataView(oversized.buffer).setUint32(16, 320);
    new DataView(oversized.buffer).setUint32(20, 240);
    const oversizedBase64 = Buffer.from(oversized).toString("base64");
    const driver = {
      async startSession() { calls.push("startSession"); return { active: true, revived: false } as never; },
      async callTool(name: string) {
        calls.push(name);
        return result({ structuredJson: JSON.stringify({ complete: true, windows: [{
          pid: 1234,
          window_id: 5678,
          app_name: "Notepad.exe",
          title: "Untitled - Notepad",
          bounds: { x: 10, y: 20, width: 320, height: 240 },
        }] }) });
      },
      async verifyState() {
        calls.push("verifyState");
        return result({
          verification: { status: 0, stable: true } as never,
          images: [{ mimeType: "image/png", dataBase64: oversizedBase64 }],
        });
      },
      async endSession() { calls.push("endSession"); return { active: false, session: "picker" } as never; },
      async shutdown() { calls.push("shutdown"); },
      uniffiDestroy() { calls.push("destroy"); },
    } as unknown as CuaDriverLike;
    const discovery = new CuaWindowDiscovery({ socketPath: "fixture", driverFactory: () => driver });

    await expect(discovery.captureWindowPreview({ pid: 1234, windowId: 5678 }, new AbortController().signal))
      .rejects.toThrow("bounded image size");
    expect(calls).toContain("endSession");
    expect(calls).toContain("shutdown");
    expect(calls).toContain("destroy");
  });

  it("does not promote a partial relationship probe to a complete picker inventory", async () => {
    const driver = {
      async startSession() { return { active: true, revived: false } as never; },
      async callTool() {
        return result({ structuredJson: JSON.stringify({
          complete: true,
          windows: [{ pid: 1234, window_id: 5678, title: "Parent", bounds: { x: 10, y: 20, width: 500, height: 400 } }],
        }) });
      },
      async endSession() { return { active: false, session: "picker" } as never; },
      async shutdown() {},
      uniffiDestroy() {},
    } as unknown as CuaDriverLike;
    const discovery = new CuaWindowDiscovery({
      socketPath: "fixture",
      driverFactory: () => driver,
      osPlatform: "win32",
      windowRelationshipProbe: {
        async read() {
          return {
            source: "win32_relationship_probe" as const,
            complete: false,
            windows: [{
              pid: 1234,
              windowId: 5678,
              ownerPid: 0,
              ownerWindowId: 0,
              isOnScreen: true,
              minimized: false,
              bounds: { x: 10, y: 20, width: 500, height: 400 },
              windowClass: "FixtureMainWindow",
            }],
          };
        },
      },
    });

    const inventory = await discovery.listInventory(new AbortController().signal);

    expect(inventory.complete).toBe(false);
    expect(inventory.completeAttestation).toBe("negative");
    expect(inventory.source).toBe("win32_relationship_probe");
    expect(inventory.windows).toHaveLength(1);
    expect(inventory.windows[0]).toMatchObject({ ownerPid: 0, ownerWindowId: 0 });
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

  it("lets an aborted preview leave the queue immediately without opening another driver", async () => {
    const calls: string[] = [];
    let firstEndStarted!: () => void;
    const firstEndStartedPromise = new Promise<void>((resolve) => { firstEndStarted = resolve; });
    let releaseFirstEnd!: () => void;
    const firstEndGate = new Promise<void>((resolve) => { releaseFirstEnd = resolve; });
    let factoryCalls = 0;
    const driver = {
      async startSession() { calls.push("startSession"); return { active: true, revived: false } as never; },
      async callTool(name: string) {
        calls.push(name);
        return result({ structuredJson: JSON.stringify({ complete: true, windows: [] }) });
      },
      async endSession() {
        calls.push("endSession");
        firstEndStarted();
        await firstEndGate;
        return { active: false, session: "picker" } as never;
      },
      async shutdown() { calls.push("shutdown"); },
      uniffiDestroy() { calls.push("destroy"); },
    } as unknown as CuaDriverLike;
    const discovery = new CuaWindowDiscovery({ socketPath: "fixture", driverFactory: () => { factoryCalls += 1; return driver; } });
    const first = discovery.listWindows(new AbortController().signal);
    await firstEndStartedPromise;
    const controller = new AbortController();
    const queuedPreview = discovery.captureWindowPreview({ pid: 1234, windowId: 5678 }, controller.signal);
    controller.abort();

    const cancellation = await Promise.race([
      queuedPreview.then(() => "resolved", () => "rejected"),
      new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 100)),
    ]);
    expect(cancellation).toBe("rejected");
    expect(factoryCalls).toBe(1);
    expect(calls).toEqual(["startSession", "list_windows", "endSession"]);

    releaseFirstEnd();
    await expect(first).resolves.toEqual([]);
    await queuedPreview.catch(() => undefined);
    expect(factoryCalls).toBe(1);
    expect(calls).toEqual(["startSession", "list_windows", "endSession", "shutdown", "destroy"]);
  });
});
