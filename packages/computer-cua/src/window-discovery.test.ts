import { afterEach, describe, expect, it } from "vitest";
import type { CuaDriverLike, ToolResult } from "./cua-sdk-contract.js";
import { installFakeCuaSdkModuleForTests } from "./cua-sdk-test-support.js";
import { CuaWindowDiscovery as ProductionCuaWindowDiscovery, type CuaWindowDiscoveryOptions } from "./window-discovery.js";
import { activateWindowTarget } from "./window-contract.js";
import { loadCuaSdkModule, setCuaSdkModuleLoaderForTests } from "./cua-sdk-platform.js";

installFakeCuaSdkModuleForTests();

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const MAX_WINDOW_PREVIEW_SOURCE_BYTES = 16 * 1024 * 1024;

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

function pngWithDimensions(width: number, height: number): Uint8Array {
  const data = new Uint8Array(ONE_PIXEL_PNG);
  const header = new DataView(data.buffer, data.byteOffset, data.byteLength);
  header.setUint32(16, width);
  header.setUint32(20, height);
  return data;
}

class WindowsFixtureDiscovery extends ProductionCuaWindowDiscovery {
  public constructor(options: CuaWindowDiscoveryOptions) { super({ osPlatform: "win32", ...options }); }
}

describe("CuaWindowDiscovery", () => {
  it.each([
    {
      label: "same focused ID but a different frontmost ID",
      structured: { status: "partial", window_id: 1312, exact_window_effect: { verified: true }, observed: { focused_window_id: 1312, frontmost_ordinary_window_id: 999, front_process_matches_target: true } },
      expectedCode: "WINDOW_ACTIVATION_UNCONFIRMED",
      expectedEvidence: "frontmost=mismatch:999",
    },
    {
      label: "matching IDs but exact effect is false",
      structured: { status: "partial", window_id: 1312, exact_window_effect: { verified: false }, observed: { focused_window_id: 1312, frontmost_ordinary_window_id: 1312, front_process_matches_target: true } },
      expectedCode: "WINDOW_ACTIVATION_UNCONFIRMED",
      expectedEvidence: "exact_verified=false",
    },
    {
      label: "front process is explicitly false",
      structured: { status: "activated", window_id: 1312, exact_window_effect: { verified: true }, observed: { focused_window_id: 1312, frontmost_ordinary_window_id: 1312, front_process_matches_target: false } },
      expectedCode: "WINDOW_ACTIVATION_REFUSED",
      expectedEvidence: "front_process=false",
    },
    {
      label: "front process is missing",
      structured: { status: "activated", window_id: 1312, exact_window_effect: { verified: true }, observed: { focused_window_id: 1312, frontmost_ordinary_window_id: 1312 } },
      expectedCode: "WINDOW_ACTIVATION_REFUSED",
      expectedEvidence: "front_process=missing",
    },
    {
      label: "front process has an invalid type without exposing it",
      structured: { status: "activated", window_id: 1312, exact_window_effect: { verified: true }, observed: { focused_window_id: 1312, frontmost_ordinary_window_id: 1312, front_process_matches_target: "PRIVATE_DRIVER_FIELD" } },
      expectedCode: "WINDOW_ACTIVATION_REFUSED",
      expectedEvidence: "front_process=invalid",
    },
  ])("reports bounded activation evidence when $label", async ({ structured, expectedCode, expectedEvidence }) => {
    const driver = { async callTool() { return result({ isError: structured.status === "partial", structuredJson: JSON.stringify(structured) }); } } as unknown as CuaDriverLike;
    await expect(activateWindowTarget(driver, "private-session", { pid: 42, windowId: 1312 }, new AbortController().signal))
      .rejects.toMatchObject({ code: expectedCode, message: expect.stringContaining(expectedEvidence) });
  });

  it("maps malformed status, null nested objects and unknown fields to enums without leaking raw values", async () => {
    const driver = { async callTool() { return result({
      degraded: false,
      structuredJson: JSON.stringify({ status: "PRIVATE_UNKNOWN_STATUS", window_id: "PRIVATE_HANDLE", observed: null, exact_window_effect: "PRIVATE_EFFECT" }),
    }); } } as unknown as CuaDriverLike;
    const error = await activateWindowTarget(driver, "private-session", { pid: 42, windowId: 1312 }, new AbortController().signal).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "WINDOW_ACTIVATION_REFUSED",
      message: expect.stringContaining("status=invalid window_id=invalid focused=invalid frontmost=invalid front_process=invalid exact_effect=invalid exact_verified=invalid"),
    });
    expect((error as Error).message).not.toMatch(/PRIVATE_/u);
  });

  it("distinguishes missing nested evidence from present-but-invalid containers", async () => {
    const target = { pid: 42, windowId: 1312 };
    const absent = { async callTool() { return result({ structuredJson: JSON.stringify({ landed_on_target: false }) }); } } as unknown as CuaDriverLike;
    const absentError = await activateWindowTarget(absent, "private-session", target, new AbortController().signal).catch((caught: unknown) => caught);
    expect((absentError as Error).message).toContain("focused=missing frontmost=missing front_process=missing exact_effect=missing exact_verified=missing");

    const malformed = { async callTool() { return result({ structuredJson: JSON.stringify({ landed_on_target: false, observed: [], exact_window_effect: null }) }); } } as unknown as CuaDriverLike;
    const malformedError = await activateWindowTarget(malformed, "private-session", target, new AbortController().signal).catch((caught: unknown) => caught);
    expect((malformedError as Error).message).toContain("focused=invalid frontmost=invalid front_process=invalid exact_effect=invalid exact_verified=invalid");
  });

  it("does not coerce malformed ToolResult booleans in the diagnostic summary", async () => {
    const driver = { async callTool() {
      return result({ isError: "PRIVATE_TRUTHY" as unknown as boolean, degraded: "PRIVATE_DEGRADED" as unknown as boolean }) as unknown as ToolResult;
    } } as unknown as CuaDriverLike;
    const error = await activateWindowTarget(driver, "private-session", { pid: 42, windowId: 1312 }, new AbortController().signal).catch((caught: unknown) => caught);
    expect((error as Error).message).toContain("is_error=invalid degraded=invalid");
    expect((error as Error).message).not.toMatch(/PRIVATE_/u);
  });

  it("keeps the legacy exact landing success path and rejects it if another exact ID conflicts", async () => {
    const target = { pid: 42, windowId: 1312 };
    const success = { async callTool() { return result({ structuredJson: JSON.stringify({ landed_on_target: true, target_hwnd: "0x520", now_fg_hwnd: 1312 }) }); } } as unknown as CuaDriverLike;
    await expect(activateWindowTarget(success, "private-session", target, new AbortController().signal)).resolves.toBeUndefined();

    const conflict = { async callTool() { return result({ structuredJson: JSON.stringify({ landed_on_target: true, target_hwnd: target.windowId, now_fg_hwnd: target.windowId + 1 }) }); } } as unknown as CuaDriverLike;
    await expect(activateWindowTarget(conflict, "private-session", target, new AbortController().signal))
      .rejects.toMatchObject({ code: "WINDOW_ACTIVATION_REFUSED", message: expect.stringContaining("now_fg_hwnd=mismatch:1313") });
  });

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
    const discovery = new WindowsFixtureDiscovery({ socketPath: "fixture", driverFactory: () => driver });
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
    const discovery = new WindowsFixtureDiscovery({
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
        { target: { pid: 1234, windowId: 5678 }, title: "Probe parent label", ownerPid: 0, ownerWindowId: 0 },
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

  it("rejects a native-only preview target before attempting CUA capture", async () => {
    const calls: string[] = [];
    const driver = {
      async startSession() { calls.push("startSession"); return { active: true, revived: false } as never; },
      async callTool(name: string) {
        calls.push(name);
        return result({ structuredJson: JSON.stringify({ windows: [{
          pid: 1234,
          window_id: 5678,
          app_name: "Fixture",
          title: "Main",
          bounds: { x: 10, y: 20, width: 500, height: 400 },
        }] }) });
      },
      async verifyState() { calls.push("verifyState"); return result({ images: [{ mimeType: "image/png", dataBase64: minimalPngBase64() }] }); },
      async endSession() { calls.push("endSession"); return { active: false, session: "picker" } as never; },
      async shutdown() { calls.push("shutdown"); },
      uniffiDestroy() { calls.push("destroy"); },
    } as unknown as CuaDriverLike;
    const discovery = new WindowsFixtureDiscovery({
      socketPath: "fixture",
      driverFactory: () => driver,
      windowRelationshipProbe: {
        async read() {
          return {
            source: "win32_relationship_probe" as const,
            complete: true,
            foregroundPid: 1234,
            foregroundWindowId: 5678,
            windows: [
              { pid: 1234, windowId: 5678, ownerPid: 0, ownerWindowId: 0, zIndex: 1, isOnScreen: true, minimized: false, bounds: { x: 10, y: 20, width: 500, height: 400 }, windowClass: "FixtureMain" },
              { pid: 4321, windowId: 8765, ownerPid: 1234, ownerWindowId: 5678, zIndex: 2, isOnScreen: true, minimized: false, bounds: { x: 50, y: 60, width: 300, height: 200 }, windowClass: "FixtureDialog" },
            ],
          };
        },
      },
    });

    await expect(discovery.captureWindowPreview({ pid: 4321, windowId: 8765 }, new AbortController().signal))
      .rejects.toMatchObject({ code: "WINDOW_TARGET_NOT_FOUND" });
    expect(calls).toContain("list_windows");
    expect(calls).not.toContain("verifyState");
    expect(calls).not.toContain("get_window_state");
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
    const discovery = new WindowsFixtureDiscovery({ socketPath: "fixture", driverFactory: () => driver });

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

  it("reuses a supplied foreground-region capture for an exact preview without activating the candidate", async () => {
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
      async verifyState() { calls.push("verifyState"); return result(); },
      async endSession() { calls.push("endSession"); return { active: false, session: "picker" } as never; },
      async shutdown() { calls.push("shutdown"); },
      uniffiDestroy() { calls.push("destroy"); },
    } as unknown as CuaDriverLike;
    const foregroundVisibleCapture = async (target: { pid: number; windowId: number }) => ({
      target,
      bounds: { x: 10, y: 20, width: 320, height: 240 },
      data: pngWithDimensions(320, 240),
    });
    const discovery = new WindowsFixtureDiscovery({
      socketPath: "fixture",
      driverFactory: () => driver,
      foregroundVisibleCapture,
    });

    const preview = await discovery.captureWindowPreview({ pid: 1234, windowId: 5678 }, new AbortController().signal);

    expect(preview.capture).toMatchObject({
      binding: { target: { pid: 1234, windowId: 5678 }, bounds: { x: 10, y: 20, width: 320, height: 240 } },
      viewport: { width: 320, height: 240, coordinateSpace: "physical" },
      source: "windows_foreground_region",
    });
    expect(preview.capture.data).toEqual(pngWithDimensions(320, 240));
    expect(calls).toEqual(["startSession", "list_windows", "list_windows", "list_windows", "endSession", "shutdown", "destroy"]);
    expect(calls).not.toContain("verifyState");
    expect(calls).not.toContain("bring_to_front");
    expect(calls).not.toContain("get_desktop_state");
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
    const discovery = new WindowsFixtureDiscovery({ socketPath: "fixture", driverFactory: () => driver });

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
    const discovery = new WindowsFixtureDiscovery({ socketPath: "fixture", driverFactory: () => driver });

    await expect(discovery.captureWindowPreview({ pid: 1234, windowId: 5678 }, new AbortController().signal))
      .rejects.toMatchObject({ name: "WindowContractError", code: "WINDOW_TARGET_NOT_FOUND" });
    expect(listCount).toBe(3);
    expect(calls).toContain("endSession");
    expect(calls).toContain("shutdown");
    expect(calls).toContain("destroy");
  });

  it("classifies duplicate exact HWND rows as an inventory schema failure", async () => {
    const calls: string[] = [];
    const driver = {
      async startSession() { calls.push("startSession"); return { active: true, revived: false } as never; },
      async callTool(name: string) {
        calls.push(name);
        if (name !== "list_windows") return result();
        return result({ structuredJson: JSON.stringify({ complete: false, windows: [
          { pid: 1234, window_id: 5678, app_name: "Notepad.exe", title: "Untitled - Notepad", bounds: { x: 10, y: 20, width: 320, height: 240 } },
          { pid: 1234, window_id: 5678, app_name: "Notepad.exe", title: "Other", bounds: { x: 10, y: 20, width: 320, height: 240 } },
        ] }) });
      },
      async endSession() { calls.push("endSession"); return { active: false, session: "picker" } as never; },
      async shutdown() { calls.push("shutdown"); },
      uniffiDestroy() { calls.push("destroy"); },
    } as unknown as CuaDriverLike;
    const discovery = new WindowsFixtureDiscovery({ socketPath: "fixture", driverFactory: () => driver });

    await expect(discovery.captureWindowPreview({ pid: 1234, windowId: 5678 }, new AbortController().signal))
      .rejects.toMatchObject({ name: "WindowContractError", code: "WINDOW_TARGET_SCHEMA" });
    expect(calls).toEqual(["startSession", "list_windows", "endSession", "shutdown", "destroy"]);
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
    const discovery = new WindowsFixtureDiscovery({ socketPath: "fixture", driverFactory: () => driver });
    const controller = new AbortController();
    const preview = discovery.captureWindowPreview({ pid: 1234, windowId: 5678 }, controller.signal);
    await started;
    controller.abort(new Error("phone cancelled preview"));

    await expect(preview).rejects.toThrow("phone cancelled preview");
    expect(calls).toContain("endSession");
    expect(calls).toContain("shutdown");
    expect(calls).toContain("destroy");
  });

  it.each([
    { byteLength: 2 * 1024 * 1024 + 1, expectedCode: undefined },
    { byteLength: MAX_WINDOW_PREVIEW_SOURCE_BYTES, expectedCode: undefined },
    { byteLength: MAX_WINDOW_PREVIEW_SOURCE_BYTES + 1, expectedCode: "WINDOW_PREVIEW_IMAGE_TOO_LARGE" },
  ])("enforces the bounded $byteLength-byte raw CUA preview source and closes the temporary session", async ({ byteLength, expectedCode }) => {
    const calls: string[] = [];
    const captureImage = new Uint8Array(byteLength);
    captureImage.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
    new DataView(captureImage.buffer).setUint32(16, 320);
    new DataView(captureImage.buffer).setUint32(20, 240);
    const captureBase64 = Buffer.from(captureImage).toString("base64");
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
          images: [{ mimeType: "image/png", dataBase64: captureBase64 }],
        });
      },
      async endSession() { calls.push("endSession"); return { active: false, session: "picker" } as never; },
      async shutdown() { calls.push("shutdown"); },
      uniffiDestroy() { calls.push("destroy"); },
    } as unknown as CuaDriverLike;
    const discovery = new WindowsFixtureDiscovery({ socketPath: "fixture", driverFactory: () => driver });

    const preview = discovery.captureWindowPreview({ pid: 1234, windowId: 5678 }, new AbortController().signal);
    if (expectedCode !== undefined) {
      await expect(preview).rejects.toMatchObject({
        name: "WindowContractError",
        code: expectedCode,
        message: expect.stringContaining("bounded normalization size"),
      });
    } else {
      const captured = await preview;
      expect(captured.capture.data.byteLength).toBe(byteLength);
      expect(captured.capture.binding.target).toEqual({ pid: 1234, windowId: 5678 });
    }
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
    const discovery = new WindowsFixtureDiscovery({
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
    const discovery = new ProductionCuaWindowDiscovery({ socketPath: "fixture", driverFactory: () => driver, osPlatform: "darwin" });

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
      const discovery = new ProductionCuaWindowDiscovery({ socketPath: "fixture", driverFactory: () => driver, osPlatform });

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
    const discovery = new WindowsFixtureDiscovery({ socketPath: "fixture", driverFactory: () => driver });

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
        if (name === "list_windows") return result({ structuredJson: JSON.stringify({ windows: [{ pid: 123, window_id: 10, app_name: "Editor", title: "Draft", bounds: { x: 0, y: 0, width: 640, height: 480 } }] }) });
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
    const discovery = new WindowsFixtureDiscovery({ socketPath: "fixture", driverFactory: () => driver });
    await expect(discovery.activateWindow({ pid: 123, windowId: 10 }, new AbortController().signal)).resolves.toBeUndefined();
  });

  it("rejects an activation that does not report landing on the exact target", async () => {
    const calls: string[] = [];
    const driver = {
      async startSession() { calls.push("startSession"); return { active: true, revived: false } as never; },
      async callTool(name: string) {
        calls.push(name);
        if (name === "list_windows") return result({ structuredJson: JSON.stringify({ windows: [{ pid: 123, window_id: 10, app_name: "Editor", title: "Draft", bounds: { x: 0, y: 0, width: 640, height: 480 } }] }) });
        return result({ structuredJson: JSON.stringify({ landed_on_target: false, target_hwnd: "10", now_fg_hwnd: "11" }) });
      },
      async endSession() { calls.push("endSession"); return { active: false, session: "picker" } as never; },
      async shutdown() { calls.push("shutdown"); },
      uniffiDestroy() { calls.push("destroy"); },
    } as unknown as CuaDriverLike;
    const discovery = new WindowsFixtureDiscovery({ socketPath: "fixture", driverFactory: () => driver });
    await expect(discovery.activateWindow({ pid: 123, windowId: 10 }, new AbortController().signal))
      .rejects.toMatchObject({ name: "WindowContractError", code: "WINDOW_ACTIVATION_REFUSED" });
    expect(calls).toEqual(["startSession", "list_windows", "bring_to_front", "endSession", "shutdown", "destroy"]);
  });

  it("classifies a surfaced sheet whose HWND cannot independently become foreground", async () => {
    const driver = {
      async startSession() { return { active: true, revived: false } as never; },
      async callTool(name: string) {
        if (name === "list_windows") return result({ structuredJson: JSON.stringify({ windows: [{ pid: 123, window_id: 11, app_name: "Editor", title: "Sheet", bounds: { x: 0, y: 0, width: 640, height: 480 } }] }) });
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
    const discovery = new WindowsFixtureDiscovery({ socketPath: "fixture", driverFactory: () => driver });
    await expect(discovery.activateWindow({ pid: 123, windowId: 11 }, new AbortController().signal))
      .rejects.toMatchObject({
        name: "WindowContractError",
        code: "WINDOW_ACTIVATION_UNCONFIRMED",
        message: expect.stringContaining("no capture or input was sent"),
      });
  });

  it("does not activate a fresh exact window known to be WS_EX_NOACTIVATE", async () => {
    const calls: string[] = [];
    const target = { pid: 123, windowId: 10 };
    const driver = {
      async startSession() { calls.push("startSession"); return { active: true, revived: false } as never; },
      async callTool(name: string) {
        calls.push(name);
        if (name === "list_windows") return result({ structuredJson: JSON.stringify({ windows: [
          { pid: target.pid, window_id: target.windowId, app_name: "Notepad", title: "Popup", bounds: { x: 0, y: 0, width: 180, height: 60 } },
        ] }) });
        throw new Error(`unexpected ${name}`);
      },
      async endSession() { calls.push("endSession"); return { active: false, session: "picker" } as never; },
      async shutdown() { calls.push("shutdown"); },
      uniffiDestroy() { calls.push("destroy"); },
    } as unknown as CuaDriverLike;
    const discovery = new WindowsFixtureDiscovery({
      socketPath: "fixture",
      driverFactory: () => driver,
      windowRelationshipProbe: {
        async read() {
          return {
            source: "win32_relationship_probe" as const,
            complete: true,
            windows: [{
              ...target, ownerPid: 123, ownerWindowId: 20, zIndex: 2, isOnScreen: true, minimized: false,
              bounds: { x: 0, y: 0, width: 180, height: 60 }, windowClass: "PopupWindow", noActivate: true,
            }],
          };
        },
      },
    });

    await expect(discovery.activateWindow(target, new AbortController().signal)).rejects.toMatchObject({
      name: "WindowContractError",
      code: "WINDOW_TARGET_NOT_FOUND",
    });
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
    const discovery = new WindowsFixtureDiscovery({ socketPath: "fixture", driverFactory: () => driver });
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
    const discovery = new WindowsFixtureDiscovery({ socketPath: "fixture", driverFactory: () => driver });
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
    const discovery = new WindowsFixtureDiscovery({
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
    const discovery = new WindowsFixtureDiscovery({ socketPath: "fixture", driverFactory: () => { factoryCalls += 1; return driver; } });
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

describe("discovery safe lifecycle snapshot", () => {
  afterEach(() => installFakeCuaSdkModuleForTests());
  function driverFixture(changes: Record<string, unknown> = {}): CuaDriverLike {
    return {
      async startSession() { return { active: true, revived: false }; },
      async callTool() { return result({ structuredJson: JSON.stringify({ windows: [] }) }); },
      async endSession() { return { active: false }; },
      async shutdown() {}, uniffiDestroy() {}, ...changes,
    } as unknown as CuaDriverLike;
  }
  it("retains the same driver/session after unexpected destroy throw", async () => {
    const original = { synthetic: "destroy" }, driver = driverFixture({ uniffiDestroy() { throw original; } });
    const discovery = new WindowsFixtureDiscovery({ socketPath: "fixture", sessionLabel: "synthetic-session", driverFactory: () => driver });
    await expect(discovery.listWindows(new AbortController().signal)).rejects.toBe(original);
    expect((discovery as unknown as { pendingCleanup?: { driver: CuaDriverLike; session: string } }).pendingCleanup)
      .toEqual({ driver, session: "synthetic-session" });
    expect(discovery.getLifecycleSnapshot()).toMatchObject({ cleanup: "unconfirmed", pendingCleanup: true, destroy: "failed", cleanupErrorKind: "destroy_failed", primaryFailed: false });
  });
  it("retains the same driver/session after unexpected cleanup loader throw", async () => {
    const original = { synthetic: "cleanup-load" };
    const driver = driverFixture({ async callTool() { setCuaSdkModuleLoaderForTests(async () => { throw original; }); return result({ structuredJson: JSON.stringify({ windows: [] }) }); } });
    const discovery = new WindowsFixtureDiscovery({ socketPath: "fixture", sessionLabel: "synthetic-session", driverFactory: () => driver });
    await expect(discovery.listWindows(new AbortController().signal)).rejects.toBe(original);
    expect((discovery as unknown as { pendingCleanup?: { driver: CuaDriverLike; session: string } }).pendingCleanup)
      .toEqual({ driver, session: "synthetic-session" });
    expect(discovery.getLifecycleSnapshot()).toMatchObject({ cleanup: "unconfirmed", pendingCleanup: true, cleanupLoadSDK: "failed", endSessionAttempts: 0, cleanupErrorKind: "cleanup_load_sdk_failed" });
  });
  it("observes fixed successful stages without extra calls and returns immutable scalar copies", async () => {
    const calls: string[] = [], driver = driverFixture({
      async startSession() { calls.push("start"); },
      async callTool() { calls.push("operation"); return result({ structuredJson: JSON.stringify({ windows: [] }) }); },
      async endSession() { calls.push("end"); return { active: false }; },
      async shutdown() { calls.push("shutdown"); }, uniffiDestroy() { calls.push("destroy"); },
    });
    installFakeCuaSdkModuleForTests(() => { calls.push("connect"); return driver; });
    const discovery = new WindowsFixtureDiscovery({ socketPath: "PRIVATE_SOCKET", sessionLabel: "PRIVATE_SESSION" });
    const idle = discovery.getLifecycleSnapshot(); expect(idle.phase).toBe("idle");
    await discovery.listWindows(new AbortController().signal);
    const snapshot = discovery.getLifecycleSnapshot();
    expect(snapshot).toMatchObject({ sequence: 1, phase: "complete", complete: true, outcome: "succeeded", primaryFailed: false, cleanup: "confirmed", pendingCleanup: false,
      loadSDK: "succeeded", connect: "succeeded", start: "succeeded", operation: "succeeded", cleanupLoadSDK: "succeeded", endSession: "succeeded", shutdown: "succeeded", destroy: "succeeded", endSessionAttempts: 1, cleanupAttempts: 1 });
    expect(calls).toEqual(["connect", "start", "operation", "end", "shutdown", "destroy"]);
    expect(Object.isFrozen(snapshot)).toBe(true); expect(() => { (snapshot as unknown as { phase: string }).phase = "changed"; }).toThrow();
    expect(snapshot).not.toBe(discovery.getLifecycleSnapshot()); expect(idle.phase).toBe("idle");
    expect(Object.values(snapshot).every((v) => ["string", "number", "boolean"].includes(typeof v))).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_"); expect(calls).toHaveLength(6);
  });
  it("load failure remains outside driver cleanup with original thrown identity", async () => {
    const original = Object.assign(new Error("PRIVATE_PATH"), { code: "ERR_DLOPEN_FAILED" }); let factory = 0;
    setCuaSdkModuleLoaderForTests(async () => { throw original; });
    const discovery = new WindowsFixtureDiscovery({ socketPath: "fixture", driverFactory: () => { factory++; return driverFixture(); } });
    await expect(discovery.listWindows(new AbortController().signal)).rejects.toBe(original);
    expect(factory).toBe(0); expect(discovery.getLifecycleSnapshot()).toMatchObject({ outcome: "failed_cleanup_not_started", loadSDK: "failed", connect: "not_started", start: "not_started", cleanup: "not_started", pendingCleanup: false, primaryFailed: true, primaryExceptionKind: "dlopen" });
  });
  it("connect failure has zero start/cleanup and does not inspect hostile error getters", async () => {
    let getters = 0;
    const original = Object.defineProperties({}, { message: { get() { getters++; throw new Error("PRIVATE"); } }, name: { get() { getters++; throw 0; } }, code: { get() { getters++; throw 0; } }, tag: { get() { getters++; throw 0; } } });
    installFakeCuaSdkModuleForTests(() => { throw original; });
    const discovery = new WindowsFixtureDiscovery({ socketPath: "fixture" });
    await expect(discovery.listWindows(new AbortController().signal)).rejects.toBe(original);
    expect(getters).toBe(0); expect(discovery.getLifecycleSnapshot()).toMatchObject({ connect: "failed", start: "not_started", cleanup: "not_started", primaryExceptionKind: "unknown", pendingCleanup: false });
  });
  it.each(["start", "operation"] as const)("%s primary failure and confirmed cleanup retain original throw", async (stage) => {
    const original = { tag: "Protocol", inner: { reason: "PRIVATE_ROW" } }, calls: string[] = [];
    const driver = driverFixture({
      async startSession() { calls.push("start"); if (stage === "start") throw original; },
      async callTool() { calls.push("operation"); throw original; },
      async endSession() { calls.push("end"); return { active: false }; }, async shutdown() { calls.push("shutdown"); }, uniffiDestroy() { calls.push("destroy"); },
    });
    const discovery = new WindowsFixtureDiscovery({ socketPath: "fixture", driverFactory: () => driver });
    await expect(discovery.listWindows(new AbortController().signal)).rejects.toBe(original);
    const snapshot = discovery.getLifecycleSnapshot();
    expect(snapshot).toMatchObject({ outcome: "failed_cleanup_confirmed", primaryFailed: true, primaryExceptionKind: "protocol", cleanup: "confirmed", pendingCleanup: false });
    expect(snapshot[stage]).toBe("failed"); expect(calls).toEqual(stage === "start" ? ["start", "end", "shutdown", "destroy"] : ["start", "operation", "end", "shutdown", "destroy"]);
    expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_");
  });
  it.each(["end", "active", "shutdown"])("%s cleanup failure exposes actual pending without destroy", async (stage) => {
    const calls: string[] = [], driver = driverFixture({
      async endSession() { calls.push("end"); if (stage === "end") throw Object.assign(new Error("PRIVATE_END"), { tag: "Transport" }); return { active: stage === "active" }; },
      async shutdown() { calls.push("shutdown"); if (stage === "shutdown") throw new Error("PRIVATE_SHUTDOWN"); }, uniffiDestroy() { calls.push("destroy"); },
    });
    const discovery = new WindowsFixtureDiscovery({ socketPath: "fixture", driverFactory: () => driver });
    await expect(discovery.listWindows(new AbortController().signal)).rejects.toMatchObject({ name: "CuaWindowDiscoveryCleanupError" });
    const snapshot = discovery.getLifecycleSnapshot(); expect(snapshot).toMatchObject({ outcome: "failed_cleanup_unconfirmed", cleanup: "unconfirmed", pendingCleanup: true, primaryFailed: false, destroy: "not_started", endSessionAttempts: stage === "active" ? 2 : 1 });
    expect(calls).toEqual(stage === "active" ? ["end", "end", "shutdown"] : ["end", "shutdown"]);
    expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_");
  });
  it.each([
    { error: new DOMException("PRIVATE", "AbortError"), kind: "abort" },
    { error: new DOMException("PRIVATE", "TimeoutError"), kind: "timeout" },
    { error: new TypeError("PRIVATE"), kind: "type_error" },
    { error: Object.assign(new Error("PRIVATE"), { code: "ERR_MODULE_NOT_FOUND" }), kind: "module_not_found" },
    { error: { tag: "Transport", inner: "PRIVATE" }, kind: "transport" },
    { error: { code: "PRIVATE_UNKNOWN", name: "PRIVATE_UNKNOWN" }, kind: "unknown" },
    { error: new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("PRIVATE_PROXY"); }, getPrototypeOf() { throw 0; } }), kind: "unknown" },
  ])("maps closed exception kind $kind without raw evidence", async ({ error, kind }) => {
    const discovery = new WindowsFixtureDiscovery({ socketPath: "fixture", driverFactory: () => { throw error; } });
    await expect(discovery.listWindows(new AbortController().signal)).rejects.toBe(error);
    expect(discovery.getLifecycleSnapshot().primaryExceptionKind).toBe(kind); expect(JSON.stringify(discovery.getLifecycleSnapshot())).not.toContain("PRIVATE");
  });
  it("keeps in-flight cleanup truthful through a queued abort and late completion", async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }), started = new Promise<void>((resolve) => { entered = resolve; }); let factories = 0;
    const discovery = new WindowsFixtureDiscovery({ socketPath: "fixture", driverFactory: () => { factories++; return driverFixture({ async endSession() { entered(); await gate; return { active: false }; } }); } });
    const first = discovery.listWindows(new AbortController().signal); await started;
    const before = discovery.getLifecycleSnapshot(); expect(before).toMatchObject({ phase: "endSession", complete: false, cleanup: "unconfirmed", pendingCleanup: false });
    const controller = new AbortController(), next = discovery.listWindows(controller.signal); controller.abort(new Error("queued cancelled"));
    await expect(next).rejects.toThrow("queued cancelled"); expect(factories).toBe(1); expect(discovery.getLifecycleSnapshot()).toEqual(before);
    release(); await first; expect(discovery.getLifecycleSnapshot()).toMatchObject({ complete: true, cleanup: "confirmed", pendingCleanup: false }); expect(before.complete).toBe(false);
  });
  it("retries only the retained owner before opening the next driver after destroy failure", async () => {
    let destroys = 0, factories = 0;
    const original = { marker: "destroy" }, driver = driverFixture({ uniffiDestroy() { if (++destroys === 1) throw original; } });
    const discovery = new WindowsFixtureDiscovery({ socketPath: "fixture", driverFactory: () => { factories++; return driver; } });
    await expect(discovery.listWindows(new AbortController().signal)).rejects.toBe(original); expect(factories).toBe(1);
    await expect(discovery.listWindows(new AbortController().signal)).resolves.toEqual([]);
    expect(factories).toBe(2); expect(destroys).toBe(3); expect(discovery.getLifecycleSnapshot()).toMatchObject({ cleanup: "confirmed", pendingCleanup: false, cleanupAttempts: 2, sequence: 2 });
  });
  it("pre-abort does not load/connect or change the idle snapshot", async () => {
    let calls = 0; setCuaSdkModuleLoaderForTests(async () => { calls++; throw new Error("unexpected"); });
    const discovery = new WindowsFixtureDiscovery({ socketPath: "fixture" }), controller = new AbortController();
    controller.abort(new Error("cancelled")); const before = discovery.getLifecycleSnapshot();
    await expect(discovery.listWindows(controller.signal)).rejects.toThrow("cancelled");
    expect(calls).toBe(0); expect(discovery.getLifecycleSnapshot()).toEqual(before);
  });
  it("cleanup retry followed by connect failure does not claim new-driver cleanup", async () => {
    const original = { stage: "connect" }; let destroys = 0, factories = 0;
    const driver = driverFixture({ uniffiDestroy() { if (++destroys === 1) throw 0; } });
    const discovery = new WindowsFixtureDiscovery({ socketPath: "fixture", driverFactory: () => { if (++factories === 2) throw original; return driver; } });
    await expect(discovery.listWindows(new AbortController().signal)).rejects.toBe(0);
    await expect(discovery.listWindows(new AbortController().signal)).rejects.toBe(original);
    expect(discovery.getLifecycleSnapshot()).toMatchObject({ connect: "failed", cleanup: "not_started", pendingCleanup: false, outcome: "failed_cleanup_not_started", cleanupAttempts: 1 });
  });
  it("does not claim the optional destroy method was called when absent", async () => {
    const discovery = new WindowsFixtureDiscovery({ socketPath: "fixture", driverFactory: () => driverFixture({ uniffiDestroy: undefined }) });
    await expect(discovery.listWindows(new AbortController().signal)).resolves.toEqual([]);
    expect(discovery.getLifecycleSnapshot()).toMatchObject({ cleanup: "confirmed", destroy: "not_available", pendingCleanup: false });
  });
});
