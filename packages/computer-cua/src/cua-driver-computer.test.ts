import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CuaDriverLike, ToolResult } from "./cua-sdk-contract.js";
import { installFakeCuaSdkModuleForTests } from "./cua-sdk-test-support.js";
import { cuaSdkVersionForPlatform } from "./cua-sdk-platform.js";
import type { ActionId, ObservationId } from "@computer-harness/protocol";
import { CuaDriverComputer as ProductionCuaDriverComputer, type CuaDriverComputerOptions } from "./cua-driver-computer.js";
import { createMockDomGroundingTransport, type DomGroundingTransport, type ManagedBrowserTarget } from "./dom-grounding.js";
import { captureWindow, captureWindowWithRetry as productionCaptureWindowWithRetry, listWindowInventory, listWindowTargets } from "./window-contract.js";

// Historical native fixtures model Windows. Make their contract independent
// of the machine running Vitest; macOS contract cases explicitly opt in.
class CuaDriverComputer extends ProductionCuaDriverComputer {
  public constructor(options: CuaDriverComputerOptions) { super({ platform: "win32", ...options }); }
}

const captureWindowWithRetry: typeof productionCaptureWindowWithRetry = (driver, session, target, signal, options, platform = "win32") => productionCaptureWindowWithRetry(driver, session, target, signal, options, platform);

const ONE_BY_ONE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

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

function pngWithDimensions(width: number, height: number): string {
  const bytes = Buffer.from(ONE_BY_ONE_PNG);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString("base64");
}

type FixtureWindow = {
  pid: number;
  windowId: number;
  title: string;
  appName: string;
  bounds?: { x: number; y: number; width: number; height: number };
  zIndex?: number;
  isOnScreen?: boolean;
  ownerPid?: number;
  ownerWindowId?: number;
  minimized?: boolean;
  windowClass?: string;
};

function windowDriver(initialBounds = { x: 100, y: 120, width: 960, height: 680 }, initialImage = { width: 958, height: 678 }) {
  const calls: Array<{ name: string; input?: Record<string, unknown> }> = [];
  let bounds = { ...initialBounds };
  let image = { ...initialImage };
  let missing = false;
  let groundingState: Record<string, unknown> | undefined;
  let groundingStateSequence: readonly Record<string, unknown>[] | undefined;
  let groundingStateIndex = 0;
  let abortGrounding = false;
  let captureImages: ToolResult["images"][] | undefined;
  let captureImageIndex = 0;
  let fallbackImages: ToolResult["images"] | undefined;
  let fallbackRefusal: { errorCode?: string; text: string } | undefined;
  let abortAfterCapture: AbortController | undefined;
  let listWindowsCallCount = 0;
  let windowInventoryComplete = true;
  let missingAfterListCall: number | undefined;
  let failedListWindowsCall: number | undefined;
  let extraWindow: FixtureWindow | undefined;
  let extraWindowAfterClick: typeof extraWindow | undefined;
  let closeExtraWindowAfterClick = false;
  let secondExtraWindow: typeof extraWindow | undefined;
  let secondExtraWindowAfterClick: typeof extraWindow | undefined;
  let extraWindowOnListCall: { call: number; value: NonNullable<typeof extraWindow> } | undefined;
  let foregroundRefusal = false;
  let foregroundRefusalMessage = "foreground_unavailable: Windows did not activate exact target HWND 0x162e (actual foreground HWND 0x223d); no mouse input was sent";
  let foregroundRefusalCode: string | undefined;
  let activationRefusal = false;
  let activationLanded = true;
  let activationTargetHwnd: number | undefined;
  let activationForegroundHwnd: number | undefined;
  let groundingStateByWindowId = new Map<number, Record<string, unknown>>();
  const windowImageSizes = new Map<number, { width: number; height: number }>();
  let actionToolCallCount = 0;
  let failActionCallNumber: number | undefined;
  let actionFailure: { errorCode?: string; text: string; structuredJson?: string } | undefined;
  let actionDegradedCallNumber: number | undefined;
  let typeTextResult: Partial<ToolResult> | undefined;
  let typeTextThrownError: Error | undefined;
  let extraWindowAfterTypeText: typeof extraWindow | undefined;
  let platform: unknown = "win32";
  const target = { pid: 1234, windowId: 5678 };
  const driver = {
    async startSession() { calls.push({ name: "startSession" }); return { active: true, revived: false } as never; },
    async endSession() { calls.push({ name: "endSession" }); return { active: false, session: "window-test" } as never; },
    async shutdown() { calls.push({ name: "shutdown" }); },
    async verifyState(rawInput?: unknown) {
      const input = rawInput !== null && typeof rawInput === "object"
        ? rawInput as { windowId?: unknown; window_id?: unknown }
        : {};
      const rawWindowId = input.windowId ?? input.window_id;
      const windowId = typeof rawWindowId === "bigint"
        ? Number(rawWindowId)
        : typeof rawWindowId === "number"
          ? rawWindowId
          : undefined;
      calls.push({ name: "verifyState", ...(windowId === undefined ? {} : { input: { window_id: windowId } }) });
      const scriptedImages = captureImages === undefined
        ? undefined
        : captureImages[Math.min(captureImageIndex++, captureImages.length - 1)];
      const dimensions = windowId === undefined ? undefined : windowImageSizes.get(windowId);
      const captureSize = dimensions ?? image;
      const images = scriptedImages ?? [{ mimeType: "image/png", dataBase64: pngWithDimensions(captureSize.width, captureSize.height) }];
      const pendingAbort = abortAfterCapture;
      abortAfterCapture = undefined;
      pendingAbort?.abort();
      return result({
        images,
        verification: { status: 0, stable: true, elapsedMs: 0n, samples: 1n, predicates: [] },
      });
    },
    async callTool(name: string, inputJson: string) {
      const input = JSON.parse(inputJson) as Record<string, unknown>;
      calls.push({ name, input });
      if (name === "health_report") return result({ structuredJson: JSON.stringify({ schema_version: "1", platform, driver_version: cuaSdkVersionForPlatform() }) });
      if (name === "bring_to_front") {
        return activationRefusal
          ? result({ isError: true, text: "fixture activation refused" })
          : result({ structuredJson: JSON.stringify({
            landed_on_target: activationLanded,
            ...(activationTargetHwnd === undefined ? {} : { target_hwnd: activationTargetHwnd }),
            ...(activationForegroundHwnd === undefined ? {} : { now_fg_hwnd: activationForegroundHwnd }),
          }) });
      }
      if (name === "list_windows") {
        listWindowsCallCount += 1;
        if (failedListWindowsCall === listWindowsCallCount) {
          return result({ isError: true, text: "fixture list_windows failure" });
        }
        if (extraWindowOnListCall?.call === listWindowsCallCount) extraWindow = extraWindowOnListCall.value;
        const unavailable = missing || (missingAfterListCall !== undefined && listWindowsCallCount >= missingAfterListCall);
        return result({ structuredJson: JSON.stringify({ complete: windowInventoryComplete, windows: unavailable ? [] : [
          { pid: target.pid, window_id: target.windowId, title: "Safe fixture", app_name: "Computer Harness", bounds, z_index: 1, is_on_screen: true },
          ...(extraWindow === undefined ? [] : [{
            pid: extraWindow.pid,
            window_id: extraWindow.windowId,
            title: extraWindow.title,
            app_name: extraWindow.appName,
            bounds: extraWindow.bounds ?? bounds,
            z_index: extraWindow.zIndex,
            is_on_screen: extraWindow.isOnScreen ?? true,
            ...(extraWindow.minimized === undefined ? {} : { is_minimized: extraWindow.minimized }),
            owner_pid: extraWindow.ownerPid ?? extraWindow.pid,
            ...(extraWindow.ownerWindowId === undefined ? {} : { owner_window_id: extraWindow.ownerWindowId }),
            ...(extraWindow.windowClass === undefined ? {} : { window_class: extraWindow.windowClass }),
          }]),
          ...(secondExtraWindow === undefined ? [] : [{
            pid: secondExtraWindow.pid,
            window_id: secondExtraWindow.windowId,
            title: secondExtraWindow.title,
            app_name: secondExtraWindow.appName,
            bounds: secondExtraWindow.bounds ?? bounds,
            z_index: secondExtraWindow.zIndex ?? 0,
            is_on_screen: secondExtraWindow.isOnScreen ?? true,
            owner_pid: secondExtraWindow.ownerPid ?? secondExtraWindow.pid,
            ...(secondExtraWindow.ownerWindowId === undefined ? {} : { owner_window_id: secondExtraWindow.ownerWindowId }),
            ...(secondExtraWindow.minimized === undefined ? {} : { is_minimized: secondExtraWindow.minimized }),
            ...(secondExtraWindow.windowClass === undefined ? {} : { window_class: secondExtraWindow.windowClass }),
          }]),
        ] }) });
      }
      if (name === "get_accessibility_tree") {
        return result({ structuredJson: JSON.stringify({ complete: true, windows: [
          { pid: target.pid, window_id: target.windowId, owner_pid: target.pid, z_index: 1, is_on_screen: true },
          ...(extraWindow === undefined ? [] : [{
            pid: extraWindow.pid,
            window_id: extraWindow.windowId,
            owner_pid: extraWindow.ownerPid ?? extraWindow.pid,
            ...(extraWindow.ownerWindowId === undefined ? {} : { owner_window_id: extraWindow.ownerWindowId }),
            z_index: extraWindow.zIndex,
            is_on_screen: extraWindow.isOnScreen ?? true,
          }]),
          ...(secondExtraWindow === undefined ? [] : [{
            pid: secondExtraWindow.pid,
            window_id: secondExtraWindow.windowId,
            owner_pid: secondExtraWindow.ownerPid ?? secondExtraWindow.pid,
            z_index: secondExtraWindow.zIndex ?? 0,
            is_on_screen: secondExtraWindow.isOnScreen ?? true,
          }]),
        ] }) });
      }
      if (name === "get_window_state") {
        if (input.include_screenshot === true && fallbackRefusal === undefined) return result({
          images: fallbackImages ?? (input.max_depth === 1 && input.max_elements === 1 ? [{ mimeType: "image/png", dataBase64: pngWithDimensions(image.width, image.height) }] : []),
          structuredJson: JSON.stringify({ pid: target.pid, window_id: target.windowId, window_bounds: bounds, screenshot_frame_valid: true, screenshot_scale: 2, screenshot_width: image.width, screenshot_height: image.height, screenshot_mime_type: "image/png" }),
        });
        if (abortGrounding) throw Object.assign(new Error("grounding aborted"), { name: "AbortError" });
        if (fallbackRefusal !== undefined) {
          return result({
            isError: true,
            images: [],
            text: fallbackRefusal.text,
            ...(fallbackRefusal.errorCode === undefined ? {} : { errorCode: fallbackRefusal.errorCode }),
          });
        }
        const windowId = typeof input.window_id === "number" ? input.window_id : undefined;
        const state = groundingStateSequence === undefined
          ? groundingState
          : groundingStateSequence[Math.min(groundingStateIndex++, groundingStateSequence.length - 1)];
        return result({
          images: input.include_screenshot === true ? fallbackImages ?? [] : [],
          structuredJson: JSON.stringify((windowId === undefined ? undefined : groundingStateByWindowId.get(windowId)) ?? state ?? {}),
        });
      }
      if (["click", "type_text", "press_key", "hotkey", "scroll", "drag"].includes(name)) {
        actionToolCallCount += 1;
        if (failActionCallNumber === actionToolCallCount && actionFailure !== undefined) {
          return result({
            isError: true,
            text: actionFailure.text,
            ...(actionFailure.errorCode === undefined ? {} : { errorCode: actionFailure.errorCode }),
            ...(actionFailure.structuredJson === undefined ? {} : { structuredJson: actionFailure.structuredJson }),
          });
        }
        if (actionDegradedCallNumber === actionToolCallCount) {
          return result({ degraded: true, text: "fixture action degraded" });
        }
        if (name === "type_text" && extraWindowAfterTypeText !== undefined) {
          extraWindow = extraWindowAfterTypeText;
          extraWindowAfterTypeText = undefined;
        }
        if (name === "type_text" && typeTextThrownError !== undefined) {
          const error = typeTextThrownError;
          typeTextThrownError = undefined;
          throw error;
        }
        if (name === "type_text" && typeTextResult !== undefined) return result(typeTextResult);
      }
      if (name === "click" && extraWindowAfterClick !== undefined) {
        extraWindow = extraWindowAfterClick;
        extraWindowAfterClick = undefined;
      }
      if (name === "click" && closeExtraWindowAfterClick) {
        extraWindow = undefined;
        closeExtraWindowAfterClick = false;
      }
      if (name === "click" && secondExtraWindowAfterClick !== undefined) {
        secondExtraWindow = secondExtraWindowAfterClick;
        secondExtraWindowAfterClick = undefined;
      }
      if (foregroundRefusal && name === "click") return result({
        isError: true,
        text: foregroundRefusalMessage,
        ...(foregroundRefusalCode === undefined ? {} : { errorCode: foregroundRefusalCode }),
      });
      return result();
    },
    uniffiDestroy() { calls.push({ name: "uniffiDestroy" }); },
  } as unknown as CuaDriverLike;
  return {
    driver,
    target,
    calls,
    setBounds(next: typeof bounds, nextImage: typeof image) { bounds = { ...next }; image = { ...nextImage }; },
    setMissing(value: boolean) { missing = value; },
    setGroundingState(value: Record<string, unknown> | undefined) { groundingState = value; groundingStateSequence = undefined; groundingStateIndex = 0; },
    setGroundingStateSequence(values: readonly Record<string, unknown>[]) { groundingStateSequence = values; groundingStateIndex = 0; },
    setGroundingAbort(value: boolean) { abortGrounding = value; },
    setCaptureImages(value: ToolResult["images"][] | undefined) { captureImages = value; captureImageIndex = 0; },
    setFallbackImages(value: ToolResult["images"] | undefined) { fallbackImages = value; },
    setFallbackRefusal(errorCode: string | undefined, text: string) { fallbackRefusal = { ...(errorCode === undefined ? {} : { errorCode }), text }; },
    abortAfterNextCapture(controller: AbortController) { abortAfterCapture = controller; },
    setMissingAfterListCall(value: number | undefined) { missingAfterListCall = value; },
    setWindowInventoryComplete(value: boolean) { windowInventoryComplete = value; },
    setExtraWindow(value: typeof extraWindow) { extraWindow = value; },
    setWindowGroundingState(windowId: number, value: Record<string, unknown>) { groundingStateByWindowId.set(windowId, value); },
    setWindowImageSize(windowId: number, width: number, height: number) { windowImageSizes.set(windowId, { width, height }); },
    failActionOnCall(callNumber: number, text: string, errorCode?: string, structuredJson?: string) {
      failActionCallNumber = callNumber;
      actionFailure = { text, ...(errorCode === undefined ? {} : { errorCode }), ...(structuredJson === undefined ? {} : { structuredJson }) };
    },
    setTypeTextResult(value: Partial<ToolResult> | undefined) { typeTextResult = value; },
    setTypeTextThrownError(value: Error | undefined) { typeTextThrownError = value; },
    setExtraWindowAfterTypeText(value: NonNullable<typeof extraWindow>) { extraWindowAfterTypeText = value; },
    failListWindowsOnCall(callNumber: number | undefined) { failedListWindowsCall = callNumber; },
    setPlatform(value: unknown) { platform = value; },
    degradeActionOnCall(callNumber: number) { actionDegradedCallNumber = callNumber; },
    setSecondExtraWindow(value: typeof extraWindow) { secondExtraWindow = value; },
    setExtraWindowAfterClick(value: NonNullable<typeof extraWindow>) { extraWindowAfterClick = value; },
    closeExtraWindowAfterNextClick() { closeExtraWindowAfterClick = true; },
    setSecondExtraWindowAfterClick(value: NonNullable<typeof extraWindow>) { secondExtraWindowAfterClick = value; },
    setExtraWindowOnListCall(call: number, value: NonNullable<typeof extraWindow>) { extraWindowOnListCall = { call, value }; },
    getListWindowsCallCount() { return listWindowsCallCount; },
    getExtraWindow() { return extraWindow; },
    getSecondExtraWindow() { return secondExtraWindow; },
    setForegroundRefusal(value: boolean, message?: string, errorCode?: string) {
      foregroundRefusal = value;
      if (message !== undefined) foregroundRefusalMessage = message;
      foregroundRefusalCode = errorCode;
    },
    setActivationRefusal(value: boolean) { activationRefusal = value; },
    setActivationLanded(value: boolean) { activationLanded = value; },
    setActivationHandles(targetHwnd: number | undefined, foregroundHwnd: number | undefined) {
      activationTargetHwnd = targetHwnd;
      activationForegroundHwnd = foregroundHwnd;
    },
  };
}

function relationshipProbeFor(
  fake: ReturnType<typeof windowDriver>,
  complete = true,
) {
  const parentBounds = { x: 100, y: 120, width: 960, height: 680 };
  return {
    async read() {
      const extra = fake.getExtraWindow();
      const peer = fake.getSecondExtraWindow();
      return {
        source: "win32_relationship_probe" as const,
        complete,
        windows: [
          {
            pid: fake.target.pid,
            windowId: fake.target.windowId,
            ownerPid: 0,
            ownerWindowId: 0,
            zIndex: 1,
            isOnScreen: true,
            minimized: false,
            bounds: parentBounds,
            windowClass: "Notepad",
          },
          ...(extra === undefined ? [] : [{
            pid: extra.pid,
            windowId: extra.windowId,
            ownerPid: extra.ownerPid ?? 0,
            ownerWindowId: extra.ownerWindowId ?? 0,
            zIndex: extra.zIndex ?? 2,
            isOnScreen: extra.isOnScreen ?? true,
            minimized: extra.minimized ?? false,
            bounds: extra.bounds ?? parentBounds,
            ...(extra.windowClass === undefined ? {} : { windowClass: extra.windowClass }),
          }]),
          ...(peer === undefined ? [] : [{
            pid: peer.pid,
            windowId: peer.windowId,
            ...(peer.ownerPid === undefined ? {} : { ownerPid: peer.ownerPid }),
            ...(peer.ownerWindowId === undefined ? {} : { ownerWindowId: peer.ownerWindowId }),
            zIndex: peer.zIndex ?? 0,
            isOnScreen: peer.isOnScreen ?? true,
            minimized: peer.minimized ?? false,
            bounds: peer.bounds ?? parentBounds,
            ...(peer.windowClass === undefined ? {} : { windowClass: peer.windowClass }),
          }]),
        ],
        foregroundPid: extra?.pid ?? fake.target.pid,
        foregroundWindowId: extra?.windowId ?? fake.target.windowId,
      };
    },
  };
}

function fakeDriver() {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const driver = {
    async startSession() { return { active: true, revived: false } as never; },
    async endSession() { return { active: false, session: "test" } as never; },
    async shutdown() {},
    async callTool(name: string, inputJson: string) {
      const input = JSON.parse(inputJson) as Record<string, unknown>;
      calls.push({ name, input });
      if (name === "get_screen_size") {
        return result({ structuredJson: JSON.stringify({ width: 1, height: 1 }) });
      }
      if (name === "get_desktop_state") {
        await writeFile(String(input.screenshot_out_file), ONE_BY_ONE_PNG);
        return result({ structuredJson: JSON.stringify({ screenshot_width: 1, screenshot_height: 1 }) });
      }
      return result();
    },
  } as unknown as CuaDriverLike;
  return { driver, calls };
}

describe("CuaDriverComputer", () => {
  it("activates the exact HWND once before fresh capture and never reactivates before an action", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-activation-"));
    const fake = windowDriver();
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", driverFactory: () => fake.driver,
    });
    try {
      const session = await computer.open({}, new AbortController().signal);
      expect(fake.calls.slice(0, 4).map((call) => call.name)).toEqual([
        "startSession", "health_report", "bring_to_front", "list_windows",
      ]);
      expect(fake.calls[2]?.input).toMatchObject({
        pid: fake.target.pid,
        window_id: fake.target.windowId,
        session: expect.any(String),
      });
      await computer.observe(session, "activation-observation" as ObservationId, new AbortController().signal);
      const receipt = await computer.execute(session, {
        actionId: "activation-click" as ActionId,
        basedOn: "activation-observation" as ObservationId,
        kind: "click",
        point: { x: 10, y: 20 },
      }, new AbortController().signal);
      expect(receipt.status).toBe("completed");
      expect(fake.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(1);
      expect(fake.calls.find((call) => call.name === "click")?.input?.target)
        .toMatchObject({ pid: fake.target.pid, window_id: fake.target.windowId });
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the default background window path free of bring_to_front", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-background-"));
    const fake = windowDriver();
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      driverFactory: () => fake.driver,
    });
    try {
      const session = await computer.open({}, new AbortController().signal);
      expect(fake.calls.map((call) => call.name).slice(0, 3)).toEqual([
        "startSession", "health_report", "list_windows",
      ]);
      await computer.observe(session, "background-observation" as ObservationId, new AbortController().signal);
      expect(await computer.execute(session, {
        actionId: "background-click" as ActionId,
        basedOn: "background-observation" as ObservationId,
        kind: "click",
        point: { x: 10, y: 20 },
      }, new AbortController().signal)).toMatchObject({ status: "completed" });
      expect(fake.calls.some((call) => call.name === "bring_to_front")).toBe(false);
      expect(fake.calls.find((call) => call.name === "click")?.input).toMatchObject({ delivery_mode: "background" });
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when exact-target activation is refused, before capture or input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-activation-failure-"));
    const fake = windowDriver();
    fake.setActivationRefusal(true);
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", driverFactory: () => fake.driver,
    });
    try {
      await expect(computer.open({}, new AbortController().signal)).rejects.toThrow(/bring_to_front refused/u);
      expect(fake.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(1);
      expect(fake.calls.some((call) => call.name === "verifyState")).toBe(false);
      expect(fake.calls.some((call) => call.name === "click" || call.name === "type_text" || call.name === "press_key")).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not continue when bring_to_front explicitly misses the selected HWND", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-activation-miss-"));
    const fake = windowDriver();
    fake.setActivationLanded(false);
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", driverFactory: () => fake.driver,
    });
    try {
      await expect(computer.open({}, new AbortController().signal)).rejects.toThrow(/did not land on the exact window target/u);
      expect(fake.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(1);
      expect(fake.calls.some((call) => call.name === "verifyState")).toBe(false);
      expect(fake.calls.some((call) => call.name === "click" || call.name === "type_text" || call.name === "press_key")).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when bring_to_front reports a different actual foreground HWND", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-activation-foreground-mismatch-"));
    const fake = windowDriver();
    // The selected target reports success, but the daemon's actual foreground
    // remains another window (the shape observed with macOS sheets).
    fake.setActivationHandles(fake.target.windowId, fake.target.windowId + 1);
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", driverFactory: () => fake.driver,
    });
    try {
      await expect(computer.open({}, new AbortController().signal)).rejects.toThrow(/did not land on the exact window target/u);
      expect(fake.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(1);
      expect(fake.calls.some((call) => call.name === "verifyState")).toBe(false);
      expect(fake.calls.some((call) => call.name === "click" || call.name === "type_text" || call.name === "press_key")).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("provides read-only host window candidates without selecting or focusing one", async () => {
    const fake = windowDriver();
    const windows = await listWindowTargets(fake.driver, "picker-session", new AbortController().signal);
    expect(windows).toEqual([{
      target: fake.target,
      bounds: { x: 100, y: 120, width: 960, height: 680 },
      title: "Safe fixture",
      appName: "Computer Harness",
      zIndex: 1,
      isOnScreen: true,
    }]);
    expect(fake.calls).toEqual([{
      name: "list_windows",
      input: { on_screen_only: true, session: "picker-session" },
    }]);
  });

  it("uses complete CUA relationship inventories directly without invoking the fallback probe", async () => {
    const driver = {
      async callTool(name: string) {
        expect(name).toBe("list_windows");
        return result({ structuredJson: JSON.stringify({
          complete: true,
          foreground_pid: 41,
          foreground_window_id: 101,
          windows: [{
            pid: 41,
            window_id: 101,
            bounds: { x: 0, y: 0, width: 800, height: 600 },
            owner_pid: 5,
            owner_window_id: 20,
            z_index: 4,
            is_on_screen: true,
            is_minimized: false,
            window_class: "Notepad",
          }],
        }) });
      },
    } as unknown as CuaDriverLike;
    const probe = { read: vi.fn(async () => { throw new Error("complete CUA inventory must be sufficient"); }) };
    const inventory = await listWindowInventory(driver, "relationship-direct", new AbortController().signal, undefined, true, probe);

    expect(inventory).toMatchObject({ complete: true, source: "cua_inventory", foregroundPid: 41, foregroundWindowId: 101 });
    expect(inventory.windows[0]).toMatchObject({ minimized: false, windowClass: "Notepad", ownerPid: 5, ownerWindowId: 20 });
    expect(probe.read).not.toHaveBeenCalled();
  });

  it("rejects structured degraded inventories before a complete probe can promote missing completeness", async () => {
    const driver = {
      async callTool(name: string) {
        expect(name).toBe("list_windows");
        return result({ structuredJson: JSON.stringify({
          degraded: true,
          windows: [{ pid: 41, window_id: 101, bounds: { x: 0, y: 0, width: 800, height: 600 } }],
        }) });
      },
    } as unknown as CuaDriverLike;
    const probe = { read: vi.fn(async () => { throw new Error("a degraded response must never be promoted"); }) };

    await expect(listWindowInventory(driver, "degraded-structured", new AbortController().signal, undefined, true, probe))
      .rejects.toMatchObject({ code: "WINDOW_TARGET_UNKNOWN" });
    expect(probe.read).not.toHaveBeenCalled();
  });

  it("rejects an envelope/structured completeness conflict before fallback probing", async () => {
    const driver = {
      async callTool(name: string) {
        expect(name).toBe("list_windows");
        return result({
          degraded: true,
          structuredJson: JSON.stringify({
            complete: true,
            degraded: false,
            windows: [{ pid: 41, window_id: 101, bounds: { x: 0, y: 0, width: 800, height: 600 } }],
          }),
        });
      },
    } as unknown as CuaDriverLike;
    const probe = { read: vi.fn(async () => { throw new Error("the degraded envelope must win"); }) };

    await expect(listWindowInventory(driver, "degraded-envelope", new AbortController().signal, undefined, true, probe))
      .rejects.toMatchObject({ code: "WINDOW_TARGET_UNKNOWN" });
    expect(probe.read).not.toHaveBeenCalled();
  });

  it.each(["off", "dom-catalog-v1"] as const)("withholds out-of-scope owned HWNDs from the picker when grounding=%s cannot prove a root", async (grounding) => {
    const directory = await mkdtemp(join(tmpdir(), `computer-harness-cua-owned-no-root-${grounding}-`));
    const fake = windowDriver();
    const popup = {
      pid: fake.target.pid,
      windowId: 8772,
      appName: "Editor",
      title: "No-root-proof fixture",
      bounds: { x: 240, y: 180, width: 420, height: 320 },
      zIndex: 2,
      ownerPid: fake.target.pid,
      ownerWindowId: fake.target.windowId,
    };
    const browserTarget: ManagedBrowserTarget = {
      kind: "managed-chromium",
      browser: "edge",
      profileId: "fixture-profile",
      windowTarget: fake.target,
      tabId: "fixture-tab",
      generation: "fixture-generation",
      delivery: "loopback-cdp",
    };
    const computer = new CuaDriverComputer({
      socketPath: "test-socket",
      screenshotDir: directory,
      windowTarget: fake.target,
      windowDeliveryMode: "foreground",
      grounding,
      windowSwitch: "opened-windows-v1",
      windowSwitchAllowedTargets: [fake.target],
      ...(grounding === "dom-catalog-v1" ? {
        browserTarget,
        domGroundingTransport: createMockDomGroundingTransport({
          complete: true,
          coordinateSpace: "physical",
          tabId: browserTarget.tabId,
          generation: browserTarget.generation,
          candidates: [],
        }),
      } : {}),
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const before = await computer.observe(session, `owned-no-root-before-${grounding}` as ObservationId, signal);
      const globalRootCallsBefore = fake.calls.filter((call) => call.name === "get_accessibility_tree" || call.name === "get_window_state").length;
      expect(globalRootCallsBefore).toBe(0);
      fake.setExtraWindowAfterClick(popup);
      const receipt = await computer.execute(session, {
        actionId: `owned-no-root-open-${grounding}` as ActionId,
        basedOn: `owned-no-root-before-${grounding}` as ObservationId,
        kind: "click",
        point: { x: 10, y: 20 },
      }, signal, { detectNewWindowHandoff: true });
      expect(receipt.status).toBe("completed");
      await expect(computer.detectNewWindowHandoffCandidates(session, signal))
        .rejects.toMatchObject({ code: "TRANSIENT_SURFACE_UNKNOWN" });
      expect(await computer.listNewWindowHandoffCandidates(session, signal)).toEqual([]);
      expect(fake.calls.filter((call) => call.name === "get_accessibility_tree" || call.name === "get_window_state"))
        .toHaveLength(globalRootCallsBefore);
      expect(await computer.detectNewWindowHandoffCandidates(session, signal)).toEqual([]);
      const after = await computer.observe(session, `owned-no-root-after-${grounding}` as ObservationId, signal);
      expect(after.surfaceRef).toEqual(before.surfaceRef);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses opaque full-inventory refs and shares the verified target transition with switch_window", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-switch-window-"));
    const fake = windowDriver();
    fake.setExtraWindow({ pid: 4321, windowId: 8765, appName: "Editor", title: "Draft" });
    const computer = new CuaDriverComputer({
      socketPath: "test-socket",
      screenshotDir: directory,
      windowTarget: fake.target,
      windowDeliveryMode: "foreground",
      windowSwitch: "opened-windows-v1",
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const startingObservation = await computer.observe(session, "switch-window-before-list" as ObservationId, signal);
      expect(startingObservation.surfaceRef.kind).toBe("native_window");
      const initial = await computer.listWindows(session, signal);
      const editor = initial.find((window) => window.title === "Draft")!;
      expect(editor).toMatchObject({ appName: "Editor", isCurrent: false });
      expect(Object.keys(editor).sort()).toEqual(["appName", "isCurrent", "title", "windowRef"]);
      expect(fake.calls.filter((call) => call.name === "list_windows").at(-1)?.input)
        .toMatchObject({ on_screen_only: false });
      expect(fake.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(1);

      const inventoryCall = fake.driver.callTool.bind(fake.driver);
      fake.driver.callTool = async (name: string, inputJson: string, options?: { signal: AbortSignal }) => {
        if (name === "list_windows") return result({ isError: true, text: "fixture inventory unavailable" });
        return inventoryCall(name, inputJson, options);
      };
      await expect(computer.listWindows(session, signal)).rejects.toThrow(/window target was refused/iu);
      fake.driver.callTool = inventoryCall;
      const refAfterFailedRefresh = await computer.execute(session, {
        actionId: "switch-window-failed-refresh-ref" as ActionId,
        basedOn: "switch-window-before-list" as ObservationId,
        kind: "switch_window",
        windowRef: editor.windowRef,
      }, signal);
      expect(refAfterFailedRefresh).toMatchObject({ status: "refused", driverCode: "WINDOW_REF_STALE" });

      const refreshed = await computer.listWindows(session, signal);
      const staleRef = await computer.execute(session, {
        actionId: "switch-window-stale-ref" as ActionId,
        basedOn: "switch-window-before-list" as ObservationId,
        kind: "switch_window",
        windowRef: editor.windowRef,
      }, signal);
      expect(staleRef).toMatchObject({ status: "refused", driverCode: "WINDOW_REF_STALE" });
      expect(fake.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(1);

      // Ordinary observation does not invalidate refs from the latest list.
      const editorRef = refreshed.find((window) => window.title === "Draft")!.windowRef;
      await computer.observe(session, "switch-window-after-observation" as ObservationId, signal);
      fake.setBounds(
        { x: 500, y: 300, width: 802, height: 602 },
        { width: 800, height: 600 },
      );
      const switched = await computer.execute(session, {
        actionId: "switch-window-action" as ActionId,
        basedOn: "switch-window-after-observation" as ObservationId,
        kind: "switch_window",
        windowRef: editorRef,
      }, signal);
      expect(switched.status).toBe("completed");
      if (switched.status !== "completed" || switched.sessionAfter === undefined) {
        throw new Error("switch_window did not return its verified sessionAfter");
      }
      expect(switched).toMatchObject({
        status: "completed",
        sessionAfter: { viewport: { width: 800, height: 600, coordinateSpace: "physical" } },
      });
      expect(switched.sessionAfter.id).toBe(session.id);
      expect(fake.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(2);
      expect(fake.calls.filter((call) => call.name === "bring_to_front").at(-1)?.input)
        .toMatchObject({ pid: 4321, window_id: 8765 });

      const nextSession = switched.sessionAfter;
      const stalePeerAction = await computer.execute(nextSession, {
        actionId: "switch-window-stale-surface-action" as ActionId,
        basedOn: "switch-window-after-observation" as ObservationId,
        kind: "click",
        point: { x: 20, y: 30 },
      }, signal);
      expect(stalePeerAction).toMatchObject({ status: "refused", driverCode: "OBSERVATION_NOT_FOUND" });
      const targetObservation = await computer.observe(nextSession, "switch-window-after-switch" as ObservationId, signal);
      expect(targetObservation.surfaceRef).not.toEqual(startingObservation.surfaceRef);
      expect(targetObservation.surfaceRef.kind).toBe("native_window");
      const click = await computer.execute(nextSession, {
        actionId: "switch-window-targeted-click" as ActionId,
        basedOn: "switch-window-after-switch" as ObservationId,
        kind: "click",
        point: { x: 20, y: 30 },
      }, signal);
      expect(click.status).toBe("completed");
      expect(fake.calls.filter((call) => call.name === "click").at(-1)?.input?.target)
        .toMatchObject({ pid: 4321, window_id: 8765 });
      await computer.close(nextSession);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("invalidates the old authorized frame if exact activation succeeds but target capture fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-switch-window-uncertain-"));
    const fake = windowDriver();
    fake.setExtraWindow({ pid: 4321, windowId: 8765, appName: "Editor", title: "Draft" });
    const computer = new CuaDriverComputer({
      socketPath: "test-socket",
      screenshotDir: directory,
      windowTarget: fake.target,
      windowDeliveryMode: "foreground",
      windowSwitch: "opened-windows-v1",
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "switch-window-uncertain-before" as ObservationId, signal);
      const windows = await computer.listWindows(session, signal);
      const selected = windows.find((window) => window.title === "Draft")!;
      // The transition's pre-activation inventory succeeds, then its fresh
      // post-activation identity capture reports that the target disappeared.
      fake.setMissingAfterListCall(fake.getListWindowsCallCount() + 2);
      const receipt = await computer.execute(session, {
        actionId: "switch-window-uncertain-action" as ActionId,
        basedOn: "switch-window-uncertain-before" as ObservationId,
        kind: "switch_window",
        windowRef: selected.windowRef,
      }, signal);
      expect(receipt).toMatchObject({ status: "failed", driverCode: "WINDOW_TARGET_NOT_FOUND" });
      expect(receipt).not.toHaveProperty("sessionAfter");
      expect(fake.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(2);
      await expect(computer.observe(session, "switch-window-uncertain-old-frame" as ObservationId, signal))
        .rejects.toThrow(/identity was invalidated/iu);
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(0);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("latches a missing current identity before treating a cached self-ref as already current", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-switch-window-current-closed-"));
    const fake = windowDriver();
    const computer = new CuaDriverComputer({
      socketPath: "test-socket",
      screenshotDir: directory,
      windowTarget: fake.target,
      windowDeliveryMode: "foreground",
      windowSwitch: "opened-windows-v1",
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "closed-current-window-observation" as ObservationId, signal);
      const currentRef = (await computer.listWindows(session, signal)).find((window) => window.isCurrent)!;
      fake.setMissing(true);
      const receipt = await computer.execute(session, {
        actionId: "closed-current-window-switch" as ActionId,
        basedOn: "closed-current-window-observation" as ObservationId,
        kind: "switch_window",
        windowRef: currentRef.windowRef,
      }, signal);
      expect(receipt).toMatchObject({ status: "failed", driverCode: "WINDOW_TARGET_NOT_FOUND" });
      expect(receipt).not.toHaveProperty("sessionAfter");
      expect(fake.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(1);
      await expect(computer.observe(session, "closed-current-window-old-frame" as ObservationId, signal))
        .rejects.toThrow(/identity was invalidated/iu);
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(0);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("filters model-selectable windows only through the exact host-provided scope", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-switch-window-scope-"));
    const fake = windowDriver();
    fake.setExtraWindow({ pid: 4321, windowId: 8765, appName: "Editor", title: "Draft" });
    const computer = new CuaDriverComputer({
      socketPath: "test-socket",
      screenshotDir: directory,
      windowTarget: fake.target,
      windowDeliveryMode: "foreground",
      windowSwitch: "opened-windows-v1",
      windowSwitchAllowedTargets: [fake.target],
      driverFactory: () => fake.driver,
    });
    try {
      const session = await computer.open({}, new AbortController().signal);
      const windows = await computer.listWindows(session, new AbortController().signal);
      expect(windows).toHaveLength(1);
      expect(windows[0]).toMatchObject({ appName: "Computer Harness", isCurrent: true });
      expect(windows.some((window) => window.title === "Draft")).toBe(false);
      expect(fake.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(1);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not let an exact host scope be bypassed through legacy handoff routes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-handoff-scope-"));
    const fake = windowDriver();
    const unauthorized = { pid: 4321, windowId: 8765, appName: "Editor", title: "Save As" };
    fake.setExtraWindow(unauthorized);
    const computer = new CuaDriverComputer({
      socketPath: "test-socket",
      screenshotDir: directory,
      windowTarget: fake.target,
      windowDeliveryMode: "foreground",
      windowSwitch: "opened-windows-v1",
      windowSwitchAllowedTargets: [fake.target],
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "handoff-scope-observation" as ObservationId, signal);
      const candidates = await computer.listWindowHandoffCandidates(session, signal);
      expect(candidates).toEqual([{
        pid: fake.target.pid,
        windowId: fake.target.windowId,
        appName: "Computer Harness",
        title: "Safe fixture",
      }]);
      await expect(computer.handoffWindow(session, unauthorized, signal))
        .rejects.toMatchObject({ code: "WINDOW_SWITCH_UNAUTHORIZED" });
      expect(fake.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(1);

      fake.setForegroundRefusal(true);
      await expect(computer.execute(session, {
        actionId: "handoff-scope-refused-click" as ActionId,
        basedOn: "handoff-scope-observation" as ObservationId,
        kind: "click",
        point: { x: 10, y: 20 },
      }, signal)).resolves.toMatchObject({ status: "refused", driverCode: "WINDOW_FOREGROUND_MISMATCH" });
      await expect(computer.listWindowHandoffCandidates(session, signal))
        .rejects.toMatchObject({ code: "WINDOW_SCOPE_REQUIRED" });
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(1);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("blocks a newly surfaced foreground window outside the exact host scope", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-proactive-handoff-scope-"));
    const fake = windowDriver();
    fake.setExtraWindowAfterClick({ pid: 4321, windowId: 8765, appName: "Editor", title: "Save As" });
    const computer = new CuaDriverComputer({
      socketPath: "test-socket",
      screenshotDir: directory,
      windowTarget: fake.target,
      windowDeliveryMode: "foreground",
      windowSwitch: "opened-windows-v1",
      windowSwitchAllowedTargets: [fake.target],
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "proactive-handoff-scope-observation" as ObservationId, signal);
      const click = await computer.execute(session, {
        actionId: "proactive-handoff-scope-click" as ActionId,
        basedOn: "proactive-handoff-scope-observation" as ObservationId,
        kind: "click",
        point: { x: 10, y: 20 },
      }, signal, { detectNewWindowHandoff: true });
      expect(click.status).toBe("completed");
      await expect(computer.detectNewWindowHandoffCandidates(session, signal))
        .rejects.toMatchObject({ code: "WINDOW_SCOPE_REQUIRED" });
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(1);
      expect(fake.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(1);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses DOM grounding only for the Run-owned browser HWND across native round trips", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-switch-managed-browser-"));
    const fake = windowDriver();
    fake.setExtraWindow({ pid: 4321, windowId: 8765, appName: "Microsoft Edge", title: "Personal profile" });
    fake.setGroundingState({
      elements_complete: true,
      elements: [
        { role: "Document", frame: { x: 106, y: 220, width: 940, height: 560 }, enabled: true },
        { role: "Edit", name: "Search", frame: { x: 200, y: 240, width: 180, height: 32 }, enabled: true, editable: true },
      ],
    });
    const browserTarget: ManagedBrowserTarget = {
      kind: "managed-chromium",
      browser: "edge",
      profileId: "fixture-profile",
      windowTarget: fake.target,
      tabId: "startup-tab",
      generation: "startup-generation",
      delivery: "loopback-cdp",
    };
    let collectCount = 0;
    const collectedTargets: Array<{ pid: number; windowId: number }> = [];
    const transport = createMockDomGroundingTransport((request) => {
      collectCount += 1;
      collectedTargets.push({ ...request.browserTarget.windowTarget });
      return {
        complete: true,
        tabId: `active-tab-${collectCount}`,
        generation: `active-generation-${collectCount}`,
        candidates: [],
      };
    });
    const computer = new CuaDriverComputer({
      socketPath: "test-socket",
      screenshotDir: directory,
      windowTarget: fake.target,
      windowDeliveryMode: "foreground",
      windowSwitch: "opened-windows-v1",
      grounding: "hybrid-catalog-v1",
      browserTarget,
      domGroundingTransport: transport,
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const managed = await computer.observe(session, "managed-before-switch" as ObservationId, signal);
      expect(managed.grounding?.source).toBe("hybrid");
      expect(collectCount).toBe(1);

      const nativeOption = (await computer.listWindows(session, signal)).find((window) => window.title === "Personal profile")!;
      const toNative = await computer.execute(session, {
        actionId: "managed-to-native" as ActionId,
        basedOn: "managed-before-switch" as ObservationId,
        kind: "switch_window",
        windowRef: nativeOption.windowRef,
      }, signal);
      if (toNative.status !== "completed" || toNative.sessionAfter === undefined) {
        throw new Error("switch to native window did not return a verified sessionAfter");
      }
      const native = await computer.observe(toNative.sessionAfter, "native-personal-edge" as ObservationId, signal);
      expect(native.grounding?.source).toBe("uia");
      expect(collectCount).toBe(1);

      const managedOption = (await computer.listWindows(toNative.sessionAfter, signal)).find((window) => window.title === "Safe fixture")!;
      const backToManaged = await computer.execute(toNative.sessionAfter, {
        actionId: "native-to-managed" as ActionId,
        basedOn: "native-personal-edge" as ObservationId,
        kind: "switch_window",
        windowRef: managedOption.windowRef,
      }, signal);
      if (backToManaged.status !== "completed" || backToManaged.sessionAfter === undefined) {
        throw new Error("switch back to Run-owned browser did not return a verified sessionAfter");
      }
      const managedAgain = await computer.observe(backToManaged.sessionAfter, "managed-after-round-trip" as ObservationId, signal);
      expect(managedAgain.grounding?.source).toBe("hybrid");
      expect(collectCount).toBe(2);
      expect(collectedTargets).toEqual([fake.target, fake.target]);
      await computer.close(backToManaged.sessionAfter);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("classifies exact-foreground refusal and handoffs only after fresh identity verification", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-handoff-"));
    const fake = windowDriver();
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "before-handoff" as ObservationId, signal);
      fake.setExtraWindow({ pid: fake.target.pid, windowId: 8765, appName: "Editor", title: "Save As" });
      fake.setForegroundRefusal(true);
      expect(await computer.execute(session, {
        actionId: "refused-handoff-click" as ActionId, basedOn: "before-handoff" as ObservationId,
        kind: "click", point: { x: 10, y: 20 },
      }, signal)).toMatchObject({ status: "refused", driverCode: "WINDOW_FOREGROUND_MISMATCH" });
      const candidate = (await computer.listWindowHandoffCandidates(session, signal)).find((window) => window.title === "Save As")!;
      expect(await computer.listNewWindowHandoffCandidates(session, signal)).toEqual([candidate]);
      await expect(computer.handoffWindow(session, { ...candidate, title: "Changed" }, signal)).rejects.toThrow(/changed before confirmation/u);
      const next = await computer.handoffWindow(session, candidate, signal);
      expect(next.id).toBe(session.id);
      expect(fake.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(2);
      expect(fake.calls.filter((call) => call.name === "bring_to_front").at(-1)?.input)
        .toMatchObject({ pid: candidate.pid, window_id: candidate.windowId });
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(1);
      fake.setForegroundRefusal(false);
      const stale = await computer.execute(next, {
        actionId: "stale-handoff-click" as ActionId, basedOn: "before-handoff" as ObservationId,
        kind: "click", point: { x: 10, y: 20 },
      }, signal);
      expect(stale.status).toBe("refused");
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(1);
      await computer.observe(next, "after-handoff" as ObservationId, signal);
      expect(await computer.execute(next, {
        actionId: "new-handoff-click" as ActionId, basedOn: "after-handoff" as ObservationId,
        kind: "click", point: { x: 10, y: 20 },
      }, signal)).toMatchObject({ status: "completed" });
      expect(fake.calls.filter((call) => call.name === "click").at(-1)?.input?.target).toMatchObject({ pid: candidate.pid, window_id: candidate.windowId });
      await computer.close(next);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps a foreground refusal generic unless the driver explicitly says no input was sent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-foreground-ambiguous-"));
    const fake = windowDriver();
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", driverFactory: () => fake.driver,
    });
    try {
      const session = await computer.open({}, new AbortController().signal);
      await computer.observe(session, "ambiguous-refusal-observation" as ObservationId, new AbortController().signal);
      fake.setForegroundRefusal(true, "foreground_unavailable: exact target HWND not active", "WINDOW_FOREGROUND_MISMATCH");
      expect(await computer.execute(session, {
        actionId: "ambiguous-refusal-click" as ActionId,
        basedOn: "ambiguous-refusal-observation" as ObservationId,
        kind: "click",
        point: { x: 10, y: 20 },
      }, new AbortController().signal)).toMatchObject({ status: "refused", driverCode: "CUA_TOOL_REFUSED" });
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("excludes a concurrent new same-process window when its HWND differs from the reported foreground HWND", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-handoff-foreground-id-mismatch-"));
    const fake = windowDriver();
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "foreground-id-baseline" as ObservationId, signal);
      fake.setExtraWindow({ pid: fake.target.pid, windowId: 9999, appName: "Editor", title: "Similar Save As" });
      fake.setForegroundRefusal(true);
      expect(await computer.execute(session, {
        actionId: "foreground-id-mismatch-click" as ActionId,
        basedOn: "foreground-id-baseline" as ObservationId,
        kind: "click", point: { x: 10, y: 20 },
      }, signal)).toMatchObject({ status: "refused", driverCode: "WINDOW_FOREGROUND_MISMATCH" });
      const candidates = await computer.listWindowHandoffCandidates(session, signal);
      expect(candidates.some((candidate) => candidate.pid === fake.target.pid && candidate.windowId === 9999)).toBe(true);
      expect(await computer.listNewWindowHandoffCandidates(session, signal)).toEqual([]);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requires an actual foreground HWND before exposing a new candidate for automatic handoff", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-handoff-foreground-id-missing-"));
    const fake = windowDriver();
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "foreground-id-missing-baseline" as ObservationId, signal);
      fake.setExtraWindow({ pid: fake.target.pid, windowId: 8765, appName: "Editor", title: "Save As" });
      fake.setForegroundRefusal(true, "foreground_unavailable: exact target HWND 0x162e was not active; no mouse input was sent");
      expect(await computer.execute(session, {
        actionId: "foreground-id-missing-click" as ActionId,
        basedOn: "foreground-id-missing-baseline" as ObservationId,
        kind: "click", point: { x: 10, y: 20 },
      }, signal)).toMatchObject({ status: "refused", driverCode: "WINDOW_FOREGROUND_MISMATCH" });
      expect(await computer.listWindowHandoffCandidates(session, signal)).toHaveLength(2);
      expect(await computer.listNewWindowHandoffCandidates(session, signal)).toEqual([]);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("detects a newly surfaced same-process dialog after a completed foreground action", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-proactive-handoff-same-process-"));
    const fake = windowDriver();
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "proactive-same-process-before" as ObservationId, signal);
      const dialog = { pid: fake.target.pid, windowId: 8765, appName: "Editor", title: "Save As" };
      fake.setExtraWindowAfterClick({ ...dialog, ownerPid: 0, ownerWindowId: 0 });
      const receipt = await computer.execute(session, {
        actionId: "proactive-same-process-click" as ActionId,
        basedOn: "proactive-same-process-before" as ObservationId,
        kind: "click", point: { x: 10, y: 20 },
      }, signal, { detectNewWindowHandoff: true });
      expect(receipt.status).toBe("completed");
      expect(await computer.detectNewWindowHandoffCandidates(session, signal)).toEqual([dialog]);
      expect(await computer.listNewWindowHandoffCandidates(session, signal)).toEqual([dialog]);
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(1);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("ignores pre-existing similarly titled windows and returns no-dialog after a bounded check", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-proactive-handoff-existing-"));
    const fake = windowDriver();
    fake.setExtraWindow({ pid: 4321, windowId: 8765, appName: "Editor", title: "Save As" });
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "proactive-existing-before" as ObservationId, signal);
      const receipt = await computer.execute(session, {
        actionId: "proactive-existing-click" as ActionId,
        basedOn: "proactive-existing-before" as ObservationId,
        kind: "click", point: { x: 10, y: 20 },
      }, signal, { detectNewWindowHandoff: true });
      expect(receipt.status).toBe("completed");
      expect(await computer.detectNewWindowHandoffCandidates(session, signal)).toEqual([]);
      expect(await computer.listNewWindowHandoffCandidates(session, signal)).toEqual([]);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("catches a dialog that appears during the single delayed foreground inventory poll", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-proactive-handoff-delayed-"));
    const fake = windowDriver();
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "proactive-delayed-before" as ObservationId, signal);
      const dialog = { pid: fake.target.pid, windowId: 8765, appName: "Editor", title: "Save As" };
      const baselineCallCount = fake.getListWindowsCallCount();
      fake.setExtraWindowOnListCall(baselineCallCount + 3, { ...dialog, ownerPid: 0, ownerWindowId: 0 });
      const receipt = await computer.execute(session, {
        actionId: "proactive-delayed-click" as ActionId,
        basedOn: "proactive-delayed-before" as ObservationId,
        kind: "click", point: { x: 10, y: 20 },
      }, signal, { detectNewWindowHandoff: true });
      expect(receipt.status).toBe("completed");
      expect(await computer.detectNewWindowHandoffCandidates(session, signal)).toEqual([dialog]);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("surfaces a new cross-process window only as a candidate and never activates it automatically", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-proactive-handoff-cross-process-"));
    const fake = windowDriver();
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "proactive-cross-process-before" as ObservationId, signal);
      const candidate = { pid: 4321, windowId: 8765, appName: "Editor", title: "Save As" };
      fake.setExtraWindowAfterClick(candidate);
      await computer.execute(session, {
        actionId: "proactive-cross-process-click" as ActionId,
        basedOn: "proactive-cross-process-before" as ObservationId,
        kind: "click", point: { x: 10, y: 20 },
      }, signal, { detectNewWindowHandoff: true });
      expect(await computer.detectNewWindowHandoffCandidates(session, signal)).toEqual([candidate]);
      expect(fake.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(1);
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(1);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("aborts the delayed read-only inventory poll promptly", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-proactive-handoff-abort-"));
    const fake = windowDriver();
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", driverFactory: () => fake.driver,
    });
    const controller = new AbortController();
    try {
      const session = await computer.open({}, controller.signal);
      await computer.observe(session, "proactive-abort-before" as ObservationId, controller.signal);
      await computer.execute(session, {
        actionId: "proactive-abort-click" as ActionId,
        basedOn: "proactive-abort-before" as ObservationId,
        kind: "click", point: { x: 10, y: 20 },
      }, controller.signal, { detectNewWindowHandoff: true });
      const abortTimer = setTimeout(() => controller.abort(new Error("fixture abort")), 10);
      await expect(computer.detectNewWindowHandoffCandidates(session, controller.signal)).rejects.toThrow("fixture abort");
      clearTimeout(abortTimer);
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses before input when opted-in foreground inventory cannot prove the bound HWND", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-proactive-handoff-inventory-failure-"));
    const fake = windowDriver();
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "proactive-inventory-before" as ObservationId, signal);
      fake.setMissingAfterListCall(fake.getListWindowsCallCount() + 2);
      const receipt = await computer.execute(session, {
        actionId: "proactive-inventory-click" as ActionId,
        basedOn: "proactive-inventory-before" as ObservationId,
        kind: "click", point: { x: 10, y: 20 },
      }, signal, { detectNewWindowHandoff: true });
      expect(receipt).toMatchObject({ status: "refused", driverCode: "WINDOW_INVENTORY_UNKNOWN", message: expect.stringContaining("no input was sent") });
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(0);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("leaves background native delivery unchanged when proactive detection is requested", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-proactive-handoff-background-"));
    const fake = windowDriver();
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "background", driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "proactive-background-before" as ObservationId, signal);
      const listCountBeforeAction = fake.getListWindowsCallCount();
      const receipt = await computer.execute(session, {
        actionId: "proactive-background-click" as ActionId,
        basedOn: "proactive-background-before" as ObservationId,
        kind: "click", point: { x: 10, y: 20 },
      }, signal, { detectNewWindowHandoff: true });
      expect(receipt.status).toBe("completed");
      expect(fake.getListWindowsCallCount() - listCountBeforeAction).toBe(1); // exact-target preflight only; no proactive baseline
      expect(await computer.detectNewWindowHandoffCandidates(session, signal)).toEqual([]);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not mark a pre-existing similarly titled unrelated window as newly surfaced", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-handoff-existing-"));
    const fake = windowDriver();
    fake.setExtraWindow({ pid: 4321, windowId: 8765, appName: "Editor", title: "Save As" });
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "existing-handoff-baseline" as ObservationId, signal);
      fake.setForegroundRefusal(true);
      expect(await computer.execute(session, {
        actionId: "existing-refused-click" as ActionId, basedOn: "existing-handoff-baseline" as ObservationId,
        kind: "click", point: { x: 10, y: 20 },
      }, signal)).toMatchObject({ status: "refused", driverCode: "WINDOW_FOREGROUND_MISMATCH" });
      const candidates = await computer.listWindowHandoffCandidates(session, signal);
      expect(candidates.some((candidate) => candidate.pid === 4321 && candidate.title === "Save As")).toBe(true);
      expect(await computer.listNewWindowHandoffCandidates(session, signal)).toEqual([]);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("marks a newly surfaced different-process window for manual-only handoff", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-handoff-other-process-"));
    const fake = windowDriver();
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "other-process-baseline" as ObservationId, signal);
      fake.setExtraWindow({ pid: 4321, windowId: 8765, appName: "Editor", title: "Save As" });
      fake.setForegroundRefusal(true);
      expect(await computer.execute(session, {
        actionId: "other-process-refused-click" as ActionId, basedOn: "other-process-baseline" as ObservationId,
        kind: "click", point: { x: 10, y: 20 },
      }, signal)).toMatchObject({ status: "refused", driverCode: "WINDOW_FOREGROUND_MISMATCH" });
      const candidate = (await computer.listWindowHandoffCandidates(session, signal)).find((window) => window.title === "Save As")!;
      expect(await computer.listNewWindowHandoffCandidates(session, signal)).toEqual([candidate]);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps a surfaced popup manual when the window inventory is truncated", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-truncated-popup-inventory-"));
    const fake = windowDriver();
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", grounding: "uia-catalog-v1", driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    const popup = { pid: fake.target.pid, windowId: 8780, appName: "Editor", title: "Edit" };
    try {
      const session = await computer.open({}, signal);
      const before = await computer.observe(session, "truncated-popup-before" as ObservationId, signal);
      fake.setWindowInventoryComplete(false);
      fake.setExtraWindowAfterClick({ ...popup, ownerPid: 0, ownerWindowId: 0 });
      const receipt = await computer.execute(session, {
        actionId: "truncated-popup-open" as ActionId,
        basedOn: "truncated-popup-before" as ObservationId,
        kind: "click", point: { x: 10, y: 20 },
      }, signal, { detectNewWindowHandoff: true });
      expect(receipt.status).toBe("completed");
      expect(await computer.detectNewWindowHandoffCandidates(session, signal)).toEqual([popup]);
      expect(fake.calls.some((call) => call.name === "get_accessibility_tree")).toBe(false);
      const stillParent = await computer.observe(session, "truncated-popup-still-parent" as ObservationId, signal);
      expect(stillParent.surfaceRef).toEqual(before.surfaceRef);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("opens, observes, maps actions, and closes without exposing CUA state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-"));
    const fake = fakeDriver();
    const computer = new CuaDriverComputer({
      socketPath: "test-socket",
      screenshotDir: directory,
      sessionLabel: "test-session",
      driverFactory: () => fake.driver,
    });

    try {
      const session = await computer.open({}, new AbortController().signal);
      expect(session).toMatchObject({
        backend: "cua-driver-daemon",
        viewport: { width: 1, height: 1, coordinateSpace: "physical" },
        capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false },
      });
      const observationId = "observation-1" as ObservationId;
      const capture = await computer.observe(session, observationId, new AbortController().signal);
      expect(capture.viewport).toEqual({ width: 1, height: 1, coordinateSpace: "physical" });
      expect((await readFile(join(directory, "observation-1.png"))).equals(ONE_BY_ONE_PNG)).toBe(true);

      const click = await computer.execute(session, {
        actionId: "click-1" as ActionId,
        basedOn: observationId,
        kind: "click",
        point: { x: 0, y: 0 },
      }, new AbortController().signal);
      expect(click).toMatchObject({ actionId: "click-1", status: "completed" });

      const staleExecution = await computer.execute(session, {
        actionId: "stale-execution" as ActionId,
        basedOn: observationId,
        kind: "click",
        point: { x: 0, y: 0 },
      }, new AbortController().signal, { executionObservationId: "other-observation" as ObservationId });
      expect(staleExecution).toMatchObject({ status: "refused", driverCode: "STALE_OBSERVATION" });

      const scroll = await computer.execute(session, {
        actionId: "scroll-1" as ActionId,
        basedOn: observationId,
        kind: "scroll",
        point: { x: 0, y: 0 },
        direction: "down",
        ticks: 3,
      }, new AbortController().signal);
      expect(scroll.status).toBe("completed");
      const scrollCall = fake.calls.find((call) => call.name === "scroll");
      expect(scrollCall?.input).toMatchObject({ direction: "down", by: "line", amount: 3 });

      const stale = await computer.execute(session, {
        actionId: "stale-1" as ActionId,
        basedOn: "missing" as ObservationId,
        kind: "click",
        point: { x: 0, y: 0 },
      }, new AbortController().signal);
      expect(stale).toMatchObject({ status: "refused", driverCode: "OBSERVATION_NOT_FOUND" });
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("advances the desktop Surface and revokes old observations when display geometry changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-desktop-resize-"));
    const fake = fakeDriver();
    let desktopSize = { width: 1, height: 1 };
    fake.driver.callTool = async (name: string, inputJson: string) => {
      const input = JSON.parse(inputJson) as Record<string, unknown>;
      fake.calls.push({ name, input });
      if (name === "get_screen_size") return result({ structuredJson: JSON.stringify({ width: 1, height: 1 }) });
      if (name === "get_desktop_state") {
        await writeFile(String(input.screenshot_out_file), pngWithDimensions(desktopSize.width, desktopSize.height));
        return result({ structuredJson: JSON.stringify({ screenshot_width: desktopSize.width, screenshot_height: desktopSize.height }) });
      }
      return result();
    };
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, driverFactory: () => fake.driver });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const initial = await computer.observe(session, "desktop-size-initial" as ObservationId, signal);
      desktopSize = { width: 2, height: 2 };
      const resized = await computer.observe(session, "desktop-size-resized" as ObservationId, signal);
      expect(resized.viewport).toEqual({ width: 2, height: 2, coordinateSpace: "physical" });
      expect(resized.surfaceRef).toMatchObject({ surfaceId: initial.surfaceRef.surfaceId, generation: initial.surfaceRef.generation + 1, kind: "desktop" });
      expect(await computer.execute(session, {
        actionId: "desktop-size-stale-action" as ActionId,
        basedOn: "desktop-size-initial" as ObservationId,
        kind: "click", point: { x: 0, y: 0 },
      }, signal)).toMatchObject({ status: "refused", driverCode: "OBSERVATION_NOT_FOUND" });
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("accepts the first valid window capture without backoff", async () => {
    const fake = windowDriver();
    const retryDelays: number[] = [];
    const capture = await captureWindowWithRetry(
      fake.driver,
      "window-first-capture",
      fake.target,
      new AbortController().signal,
      {
        now: () => 0,
        delay: async (milliseconds) => { retryDelays.push(milliseconds); },
      },
      "win32",
    );
    expect(capture.viewport).toEqual({ width: 958, height: 678, coordinateSpace: "physical" });
    expect(retryDelays).toEqual([]);
    expect(fake.calls.filter((call) => call.name === "list_windows")).toHaveLength(1);
    expect(fake.calls.filter((call) => call.name === "verifyState")).toHaveLength(1);
  });

  it("applies one 20-second deadline across all window capture reads", async () => {
    vi.useFakeTimers();
    const fake = windowDriver();
    let signalFromDriver: AbortSignal | undefined;
    let onVerifyStarted: (() => void) | undefined;
    const verifyStarted = new Promise<void>((resolve) => { onVerifyStarted = resolve; });
    fake.driver.verifyState = async (...args: Parameters<CuaDriverLike["verifyState"]>) => {
      fake.calls.push({ name: "verifyState" });
      signalFromDriver = args[1]?.signal;
      onVerifyStarted?.();
      return await new Promise<never>((_resolve, reject) => {
        const abort = () => reject(signalFromDriver?.reason ?? new Error("capture deadline aborted"));
        if (signalFromDriver?.aborted) abort();
        else signalFromDriver?.addEventListener("abort", abort, { once: true });
      });
    };
    let settled = false;
    let failure: unknown;
    const capture = captureWindowWithRetry(
      fake.driver,
      "window-total-deadline",
      fake.target,
      new AbortController().signal,
    ).then(
      () => { settled = true; },
      (error) => { settled = true; failure = error; },
    );

    try {
      await verifyStarted;
      await vi.advanceTimersByTimeAsync(19_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await capture;
      expect(failure).toMatchObject({ code: "WINDOW_CAPTURE_DEADLINE" });
      expect(fake.calls.filter((call) => call.name === "verifyState")).toHaveLength(1);
      expect(fake.calls.filter((call) => call.name === "list_windows")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a verified same-process menu as an internal surface and clicks it without cross-window handoff", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-transient-menu-"));
    const fake = windowDriver();
    const menu = {
      pid: fake.target.pid,
      windowId: 8765,
      appName: "Editor",
      title: "Edit",
      bounds: { x: 300, y: 200, width: 300, height: 200 },
      zIndex: 2,
      ownerPid: fake.target.pid,
      ownerWindowId: fake.target.windowId,
      windowClass: "#32768",
    };
    fake.setWindowGroundingState(fake.target.windowId, {
      complete: true,
      elements_complete: true,
      geometry_verified: true,
      root_surface: { pid: fake.target.pid, window_id: fake.target.windowId, role: "Window", complete: true },
      overlay_root: null,
      elements: [],
    });
    fake.setWindowImageSize(menu.windowId, 298, 198);
    fake.setWindowGroundingState(menu.windowId, {
      complete: true,
      elements_complete: true,
      root_surface: { pid: menu.pid, window_id: menu.windowId, role: "Menu", complete: true },
      elements: [
        { role: "Menu", depth: 0 },
        { role: "MenuItem", depth: 1, name: "Select All", frame: { x: 320, y: 210, width: 80, height: 24 }, enabled: true },
      ],
    });
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", grounding: "uia-catalog-v1", windowSwitch: "opened-windows-v1",
      windowSwitchAllowedTargets: [fake.target], windowRelationshipProbe: relationshipProbeFor(fake), driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "menu-owner-observation" as ObservationId, signal);
      const globalTreeReadsBeforeTransientProof = fake.calls.filter((call) => call.name === "get_accessibility_tree").length;
      fake.setExtraWindowAfterClick(menu);
      const opened = await computer.execute(session, {
        actionId: "open-menu" as ActionId,
        basedOn: "menu-owner-observation" as ObservationId,
        kind: "click",
        point: { x: 12, y: 18 },
      }, signal, { detectNewWindowHandoff: true });
      expect(opened.status).toBe("completed");
      expect(await computer.detectNewWindowHandoffCandidates(session, signal)).toEqual([]);
      expect(fake.calls.filter((call) => call.name === "get_accessibility_tree")).toHaveLength(globalTreeReadsBeforeTransientProof);
      const exactRootReads = fake.calls.filter((call) => call.name === "get_window_state" && call.input?.window_id === menu.windowId);
      expect(exactRootReads).toHaveLength(0);

      const popup = await computer.observe(session, "menu-popup-observation" as ObservationId, signal);
      const menuItem = popup.grounding?.elements.find((element) => element.name === "Select All");
      expect(menuItem).toBeDefined();
      expect(popup.surfaceRef.admissionSource).toBe("win32_relationship_probe");
      const menuBbox = menuItem!.bbox!;
      const point = {
        x: menuBbox.x + menuBbox.width / 2,
        y: menuBbox.y + menuBbox.height / 2,
      };
      fake.closeExtraWindowAfterNextClick();
      const selected = await computer.execute(session, {
        actionId: "select-menu-item" as ActionId,
        basedOn: "menu-popup-observation" as ObservationId,
        kind: "click",
        point,
        groundingRef: menuItem!.elementRef,
      }, signal, { detectNewWindowHandoff: true });
      expect(selected.status).toBe("completed");
      expect(fake.calls.filter((call) => call.name === "click").at(-1)?.input).toMatchObject({
        target: { kind: "window", pid: fake.target.pid, window_id: menu.windowId },
      });
      expect(await computer.detectNewWindowHandoffCandidates(session, signal)).toEqual([]);

      const returned = await computer.observe(session, "menu-owner-restored" as ObservationId, signal);
      expect(returned.viewport).toEqual({ width: 958, height: 678, coordinateSpace: "physical" });
      expect(fake.calls.filter((call) => call.name === "verifyState").at(-1)?.input).toEqual({ window_id: fake.target.windowId });
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["hidden", "absent", "visible", "incomplete", "minimized", "parent-missing", "parent-hidden", "replacement", "reused-hwnd", "conflict"])(
    "reconciles an active child before post-ESC admission (%s)", async (scenario) => {
      const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-post-escape-"));
      const fake = windowDriver();
      const menu = {
        pid: fake.target.pid, windowId: 8900, title: "menu", appName: "Notepad",
        bounds: { x: 200, y: 150, width: 300, height: 200 }, zIndex: 2,
        ownerPid: fake.target.pid, ownerWindowId: fake.target.windowId,
        isOnScreen: true, minimized: false, windowClass: "#32768",
      };
      fake.setWindowImageSize(menu.windowId, 300, 200);
      const baseProbe = relationshipProbeFor(fake);
      let escaped = false;
      const probe = {
        async read() {
          const snapshot = await baseProbe.read();
          return {
            ...snapshot,
            complete: !(escaped && scenario === "incomplete"),
            windows: snapshot.windows
              .filter((row) => !(escaped && scenario === "parent-missing" && row.windowId === fake.target.windowId))
              .map((row) => {
                if (escaped && scenario === "conflict" && row.windowId === menu.windowId) return { ...row, ownerPid: 9999 };
                if (escaped && scenario === "parent-hidden" && row.windowId === fake.target.windowId) return { ...row, isOnScreen: false };
                return row;
              }),
            ...(escaped ? { foregroundPid: fake.target.pid, foregroundWindowId: fake.target.windowId } : {}),
          };
        },
      };
      const originalCallTool = fake.driver.callTool;
      fake.driver.callTool = async (name, inputJson) => {
        const response = await originalCallTool(name, inputJson);
        if (name === "press_key" && JSON.parse(inputJson).key === "ESC") {
          escaped = true;
          fake.setExtraWindow(scenario === "absent" ? undefined : {
            ...menu, isOnScreen: scenario === "visible", minimized: scenario === "minimized",
            ...(scenario === "reused-hwnd" ? { pid: 9999 } : {}),
          });
          if (scenario === "replacement") fake.setSecondExtraWindow({ ...menu, windowId: 8901, zIndex: 3 });
        }
        return response;
      };
      const computer = new CuaDriverComputer({
        socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
        windowDeliveryMode: "foreground", grounding: "off", windowRelationshipProbe: probe,
        driverFactory: () => fake.driver,
      });
      const signal = new AbortController().signal;
      try {
        const session = await computer.open({}, signal);
        const parent = await computer.observe(session, "escape-parent" as ObservationId, signal);
        fake.setExtraWindowAfterClick(menu);
        expect((await computer.execute(session, {
          actionId: "escape-open" as ActionId, basedOn: "escape-parent" as ObservationId,
          kind: "click", point: { x: 12, y: 18 },
        }, signal, { detectNewWindowHandoff: true })).status).toBe("completed");
        expect(await computer.detectNewWindowHandoffCandidates(session, signal)).toEqual([]);
        const child = await computer.observe(session, "escape-child" as ObservationId, signal);
        expect(child.surfaceTransitionReason).toBe("child_push");
        const receipt = await computer.execute(session, {
          actionId: "escape-close" as ActionId, basedOn: "escape-child" as ObservationId,
          kind: "keypress", keys: ["ESC"],
        }, signal, { detectNewWindowHandoff: true });
        expect(receipt.status).toBe("completed");
        if (scenario === "hidden" || scenario === "absent" || scenario === "visible") {
          expect(await computer.detectNewWindowHandoffCandidates(session, signal)).toEqual([]);
          const restored = await computer.observe(session, "escape-restored" as ObservationId, signal);
          if (scenario === "visible") {
            expect(restored.surfaceRef.surfaceId).toBe(child.surfaceRef.surfaceId);
            expect(restored.surfaceTransitionReason).not.toBe("child_pop");
          } else {
            expect(restored.surfaceTransitionReason).toBe("child_pop");
            expect(restored.surfaceRef.surfaceId).toBe(parent.surfaceRef.surfaceId);
            expect(restored.surfaceRef.generation).toBeGreaterThan(parent.surfaceRef.generation);
            expect(fake.calls.filter((call) => call.name === "verifyState").at(-1)?.input?.window_id).toBe(fake.target.windowId);
            expect(await computer.execute(session, {
              actionId: "escape-stale" as ActionId, basedOn: "escape-child" as ObservationId,
              kind: "keypress", keys: ["ESC"],
            }, signal)).toMatchObject({ status: "refused", driverCode: "OBSERVATION_NOT_FOUND" });
          }
        } else {
          await expect(computer.detectNewWindowHandoffCandidates(session, signal))
            .rejects.toMatchObject({ code: "TRANSIENT_SURFACE_UNKNOWN" });
          expect(await computer.listNewWindowHandoffCandidates(session, signal)).toEqual([]);
        }
        expect(fake.calls.filter((call) => call.name === "press_key")).toHaveLength(1);
        await computer.close(session);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("refuses a menu element action after the transient popup becomes stale", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-transient-menu-stale-"));
    const fake = windowDriver();
    const menu = {
      pid: fake.target.pid,
      windowId: 8766,
      appName: "Editor",
      title: "Edit",
      bounds: { x: 300, y: 200, width: 300, height: 200 },
      zIndex: 2,
      ownerPid: fake.target.pid,
      ownerWindowId: fake.target.windowId,
      windowClass: "#32768",
    };
    fake.setWindowGroundingState(fake.target.windowId, {
      complete: true,
      elements_complete: true,
      geometry_verified: true,
      root_surface: { pid: fake.target.pid, window_id: fake.target.windowId, role: "Window", complete: true },
      overlay_root: null,
      elements: [],
    });
    fake.setWindowImageSize(menu.windowId, 298, 198);
    fake.setWindowGroundingState(menu.windowId, {
      complete: true,
      elements_complete: true,
      root_surface: { pid: menu.pid, window_id: menu.windowId, role: "Menu", complete: true },
      elements: [
        { role: "Menu", depth: 0 },
        { role: "MenuItem", depth: 1, name: "Select All", frame: { x: 320, y: 210, width: 80, height: 24 }, enabled: true },
      ],
    });
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", grounding: "uia-catalog-v1", windowSwitchAllowedTargets: [fake.target],
      windowRelationshipProbe: relationshipProbeFor(fake), driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "stale-menu-owner" as ObservationId, signal);
      fake.setExtraWindowAfterClick(menu);
      await computer.execute(session, {
        actionId: "stale-open-menu" as ActionId,
        basedOn: "stale-menu-owner" as ObservationId,
        kind: "click",
        point: { x: 12, y: 18 },
      }, signal, { detectNewWindowHandoff: true });
      await computer.detectNewWindowHandoffCandidates(session, signal);
      const popup = await computer.observe(session, "stale-popup-observation" as ObservationId, signal);
      const menuItem = popup.grounding?.elements.find((element) => element.name === "Select All");
      expect(menuItem).toBeDefined();
      const menuBbox = menuItem!.bbox!;
      fake.setExtraWindow(undefined);
      const clicksBefore = fake.calls.filter((call) => call.name === "click").length;
      const stale = await computer.execute(session, {
        actionId: "stale-popup-click" as ActionId,
        basedOn: "stale-popup-observation" as ObservationId,
        kind: "click",
        point: { x: menuBbox.x + menuBbox.width / 2, y: menuBbox.y + menuBbox.height / 2 },
        groundingRef: menuItem!.elementRef,
      }, signal);
      expect(stale).toMatchObject({ status: "refused", driverCode: "TRANSIENT_SURFACE_STALE" });
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(clicksBefore);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("models a same-HWND overlay as a child, keeps it active on unknown evidence, and pops only on trusted absence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-same-hwnd-overlay-"));
    const fake = windowDriver();
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", grounding: "uia-catalog-v1", driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    const parentState = (overlayRoot: Record<string, unknown> | null, elements: readonly Record<string, unknown>[] = []) => ({
      complete: true,
      elements_complete: true,
      geometry_verified: true,
      root_surface: { pid: fake.target.pid, window_id: fake.target.windowId, role: "Window", complete: true },
      overlay_root: overlayRoot,
      elements,
    });
    const menuRoot = {
      pid: fake.target.pid,
      window_id: fake.target.windowId,
      role: "Menu",
      complete: true,
      geometry_verified: true,
      present: true,
    };
    const menuElements = [{ role: "MenuItem", name: "Select All", frame: { x: 320, y: 210, width: 80, height: 24 }, enabled: true }];
    try {
      const session = await computer.open({}, signal);
      const parentObservation = await computer.observe(session, "overlay-parent-observation" as ObservationId, signal);
      fake.setWindowGroundingState(fake.target.windowId, parentState(menuRoot, menuElements));
      const opened = await computer.execute(session, {
        actionId: "overlay-open" as ActionId,
        basedOn: "overlay-parent-observation" as ObservationId,
        kind: "click", point: { x: 12, y: 18 },
      }, signal, { detectNewWindowHandoff: true });
      expect(opened.status).toBe("completed");
      expect(await computer.detectNewWindowHandoffCandidates(session, signal)).toEqual([]);

      const overlayObservation = await computer.observe(session, "overlay-observation" as ObservationId, signal);
      expect(overlayObservation.surfaceRef.kind).toBe("overlay");
      expect(overlayObservation.surfaceRef.admissionSource).toBe("same_hwnd_overlay_root_proof");
      expect(overlayObservation.surfaceRef.parentSurfaceId).toBe(parentObservation.surfaceRef.surfaceId);
      expect(overlayObservation.surfaceTransitionReason).toBe("child_push");
      expect(overlayObservation.surfaceRef.surfaceId).not.toBe(parentObservation.surfaceRef.surfaceId);
      expect(overlayObservation.grounding?.elements.some((element) => element.name === "Select All")).toBe(true);
      const selectAll = overlayObservation.grounding!.elements.find((element) => element.name === "Select All")!;
      const selected = await computer.execute(session, {
        actionId: "overlay-select-all" as ActionId,
        basedOn: "overlay-observation" as ObservationId,
        kind: "click",
        point: { x: selectAll.bbox!.x + selectAll.bbox!.width / 2, y: selectAll.bbox!.y + selectAll.bbox!.height / 2 },
        groundingRef: selectAll.elementRef,
      }, signal);
      expect(selected.status).toBe("completed");
      expect(fake.calls.filter((call) => call.name === "click").at(-1)?.input).toMatchObject({
        target: { kind: "window", pid: fake.target.pid, window_id: fake.target.windowId },
      });

      fake.setWindowGroundingState(fake.target.windowId, parentState({ ...menuRoot, complete: false }, menuElements));
      await expect(computer.observe(session, "overlay-unknown" as ObservationId, signal)).rejects.toThrow(/same-HWND overlay root had incomplete/iu);
      fake.setWindowGroundingState(fake.target.windowId, {
        complete: true,
        elements_complete: true,
        geometry_verified: true,
        root_surface: { pid: fake.target.pid, window_id: fake.target.windowId, role: "Window", complete: true },
        elements: menuElements,
      });
      await expect(computer.observe(session, "overlay-status-unreported" as ObservationId, signal)).rejects.toThrow(/overlay status was not explicitly reported/iu);
      fake.setWindowGroundingState(fake.target.windowId, parentState(menuRoot, menuElements));
      const stillOverlay = await computer.observe(session, "overlay-still-present" as ObservationId, signal);
      expect(stillOverlay.surfaceRef).toEqual(overlayObservation.surfaceRef);
      expect(stillOverlay.surfaceTransitionReason).toBeUndefined();

      fake.setWindowGroundingState(fake.target.windowId, parentState(null));
      const returned = await computer.observe(session, "overlay-closed" as ObservationId, signal);
      expect(returned.surfaceTransitionReason).toBe("child_pop");
      expect(returned.surfaceRef.surfaceId).toBe(parentObservation.surfaceRef.surfaceId);
      expect(returned.surfaceRef.kind).toBe("native_window");
      expect(returned.surfaceRef.generation).toBeGreaterThan(parentObservation.surfaceRef.generation);
      expect(fake.calls.filter((call) => call.name === "verifyState").at(-1)?.input).toEqual({ window_id: fake.target.windowId });
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not fail a completed action when the backend provides no same-HWND overlay candidate marker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-overlay-marker-unsupported-"));
    const fake = windowDriver();
    fake.setWindowGroundingState(fake.target.windowId, {
      complete: true,
      elements_complete: true,
      geometry_verified: true,
      root_surface: { pid: fake.target.pid, window_id: fake.target.windowId, role: "Window", complete: true },
      elements: [],
    });
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", grounding: "uia-catalog-v1", windowSwitchAllowedTargets: [fake.target],
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const before = await computer.observe(session, "overlay-marker-before" as ObservationId, signal);
      const receipt = await computer.execute(session, {
        actionId: "overlay-marker-click" as ActionId,
        basedOn: "overlay-marker-before" as ObservationId,
        kind: "click",
        point: { x: 12, y: 18 },
      }, signal, { detectNewWindowHandoff: true });

      expect(receipt.status).toBe("completed");
      await expect(computer.detectNewWindowHandoffCandidates(session, signal)).resolves.toEqual([]);
      const after = await computer.observe(session, "overlay-marker-after" as ObservationId, signal);
      expect(after.surfaceRef).toEqual(before.surfaceRef);
      expect(after.surfaceTransitionReason).toBeUndefined();
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("withholds an allowed exact-owned candidate whose root proof is not Dialog", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-transient-not-dialog-"));
    const fake = windowDriver();
    const dialog = {
      pid: fake.target.pid,
      windowId: 8767,
      appName: "Editor",
      title: "Save As",
      bounds: { x: 240, y: 180, width: 420, height: 320 },
      zIndex: 2,
      ownerPid: fake.target.pid,
      ownerWindowId: fake.target.windowId,
    };
    fake.setWindowImageSize(dialog.windowId, 418, 318);
    fake.setWindowGroundingState(dialog.windowId, {
      complete: true,
      elements: [{ role: "Window", name: "Save As", frame: { x: 240, y: 180, width: 420, height: 320 }, enabled: true }],
    });
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", grounding: "uia-catalog-v1", driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "dialog-owner-observation" as ObservationId, signal);
      fake.setExtraWindowAfterClick(dialog);
      await computer.execute(session, {
        actionId: "open-save-dialog" as ActionId,
        basedOn: "dialog-owner-observation" as ObservationId,
        kind: "click",
        point: { x: 12, y: 18 },
      }, signal, { detectNewWindowHandoff: true });
      await expect(computer.detectNewWindowHandoffCandidates(session, signal))
        .rejects.toMatchObject({ code: "TRANSIENT_SURFACE_UNKNOWN" });
      expect(await computer.listNewWindowHandoffCandidates(session, signal)).toEqual([]);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("admits an exact owned Dialog only as the active child scope and blocks peer switching until pop", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-owned-dialog-scope-"));
    const fake = windowDriver();
    const peer = { pid: 4321, windowId: 9876, title: "Peer fixture", appName: "Peer", zIndex: 0, isOnScreen: true };
    const dialog = {
      pid: fake.target.pid,
      windowId: 8768,
      appName: "Editor",
      title: "Find fixture",
      bounds: { x: 240, y: 180, width: 420, height: 320 },
      zIndex: 3,
      ownerPid: fake.target.pid,
      ownerWindowId: fake.target.windowId,
    };
    fake.setSecondExtraWindow(peer);
    fake.setWindowImageSize(dialog.windowId, 418, 318);
    fake.setWindowGroundingState(dialog.windowId, {
      complete: true,
      elements_complete: true,
      root_surface: { pid: dialog.pid, window_id: dialog.windowId, role: "Dialog", complete: true },
      elements: [{ role: "Dialog", depth: 0 }],
    });
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", grounding: "uia-catalog-v1", windowSwitch: "opened-windows-v1",
      windowSwitchAllowedTargets: [fake.target, { pid: peer.pid, windowId: peer.windowId }],
      windowRelationshipProbe: relationshipProbeFor(fake),
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const parent = await computer.observe(session, "owned-dialog-parent" as ObservationId, signal);
      fake.setExtraWindowAfterClick(dialog);
      const opened = await computer.execute(session, {
        actionId: "owned-dialog-open" as ActionId,
        basedOn: "owned-dialog-parent" as ObservationId,
        kind: "click",
        point: { x: 10, y: 20 },
      }, signal, { detectNewWindowHandoff: true });
      expect(opened.status).toBe("completed");
      expect(await computer.detectNewWindowHandoffCandidates(session, signal)).toEqual([]);

      const dialogObservation = await computer.observe(session, "owned-dialog-active" as ObservationId, signal);
      expect(dialogObservation.surfaceRef).toMatchObject({
        kind: "native_window",
        parentSurfaceId: parent.surfaceRef.surfaceId,
        admissionSource: "win32_relationship_probe",
      });
      expect(fake.calls.find((call) => call.name === "get_window_state" && call.input?.window_id === dialog.windowId)?.input)
        .toMatchObject({ pid: dialog.pid, window_id: dialog.windowId, include_screenshot: false });

      const peerOption = (await computer.listWindows(session, signal)).find((window) => window.appName === peer.appName)!;
      const activationsBefore = fake.calls.filter((call) => call.name === "bring_to_front").length;
      const blocked = await computer.execute(session, {
        actionId: "owned-dialog-peer-switch" as ActionId,
        basedOn: "owned-dialog-active" as ObservationId,
        kind: "switch_window",
        windowRef: peerOption.windowRef,
      }, signal);
      expect(blocked).toMatchObject({ status: "refused", driverCode: "TRANSIENT_SURFACE_MODAL" });
      expect(fake.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(activationsBefore);

      fake.setExtraWindow(undefined);
      const returned = await computer.observe(session, "owned-dialog-parent-restored" as ObservationId, signal);
      expect(returned.surfaceTransitionReason).toBe("child_pop");
      expect(returned.surfaceRef.kind).toBe("native_window");
      expect(returned.surfaceRef.surfaceId).toBe(parent.surfaceRef.surfaceId);
      expect(returned.surfaceRef.generation).toBeGreaterThan(parent.surfaceRef.generation);
      const stale = await computer.execute(session, {
        actionId: "owned-dialog-stale-action" as ActionId,
        basedOn: "owned-dialog-active" as ObservationId,
        kind: "keypress",
        keys: ["ESC"],
      }, signal);
      expect(stale).toMatchObject({ status: "refused", driverCode: "OBSERVATION_NOT_FOUND" });
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("admits a WPS-style #32770 dialog from partial inventory only when exact owner and foreground agree", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-probe-dialog-"));
    const fake = windowDriver();
    const dialog = {
      pid: fake.target.pid,
      windowId: 8780,
      appName: "WPS",
      title: "synthetic dialog fixture",
      bounds: { x: 240, y: 180, width: 420, height: 320 },
      zIndex: 2,
      ownerPid: fake.target.pid,
      ownerWindowId: fake.target.windowId,
      minimized: false,
      windowClass: "#32770",
    };
    const parentBounds = { x: 100, y: 120, width: 960, height: 680 };
    const relationshipProbe = {
      async read() {
        const currentDialog = fake.getExtraWindow();
        return {
          source: "win32_relationship_probe" as const,
          complete: false,
          windows: [
            { pid: fake.target.pid, windowId: fake.target.windowId, ownerPid: 0, ownerWindowId: 0, zIndex: 1, isOnScreen: true, minimized: false, bounds: parentBounds, windowClass: "Notepad" },
            ...(currentDialog === undefined ? [] : [{
              pid: currentDialog.pid,
              windowId: currentDialog.windowId,
              ...(currentDialog.ownerPid === undefined ? {} : { ownerPid: currentDialog.ownerPid }),
              ...(currentDialog.ownerWindowId === undefined ? {} : { ownerWindowId: currentDialog.ownerWindowId }),
              ...(currentDialog.zIndex === undefined ? {} : { zIndex: currentDialog.zIndex }),
              isOnScreen: currentDialog.isOnScreen ?? true,
              minimized: currentDialog.minimized ?? false,
              bounds: currentDialog.bounds ?? parentBounds,
              ...(currentDialog.windowClass === undefined ? {} : { windowClass: currentDialog.windowClass }),
            }]),
          ],
          foregroundPid: currentDialog?.pid ?? fake.target.pid,
          foregroundWindowId: currentDialog?.windowId ?? fake.target.windowId,
        };
      },
    };
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", grounding: "off", windowSwitch: "opened-windows-v1",
      windowSwitchAllowedTargets: [fake.target], windowRelationshipProbe: relationshipProbe,
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const parent = await computer.observe(session, "probe-dialog-parent" as ObservationId, signal);
      fake.setExtraWindowAfterClick(dialog);
      const receipt = await computer.execute(session, {
        actionId: "probe-dialog-open" as ActionId,
        basedOn: "probe-dialog-parent" as ObservationId,
        kind: "click",
        point: { x: 12, y: 18 },
      }, signal, { detectNewWindowHandoff: true });
      expect(receipt.status).toBe("completed");
      expect(await computer.detectNewWindowHandoffCandidates(session, signal)).toEqual([]);

      const child = await computer.observe(session, "probe-dialog-child" as ObservationId, signal);
      expect(child.surfaceRef).toMatchObject({
        kind: "native_window",
        parentSurfaceId: parent.surfaceRef.surfaceId,
        admissionSource: "win32_relationship_probe",
      });
      expect(child.surfaceTransitionReason).toBe("child_push");
      expect(fake.calls.filter((call) => call.name === "get_window_state" && call.input?.window_id === dialog.windowId)).toHaveLength(0);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("admits a Notepad menu class only with complete unique owned stacking above its parent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-probe-menu-"));
    const fake = windowDriver();
    const menu = {
      pid: fake.target.pid,
      windowId: 8781,
      appName: "Notepad",
      title: "synthetic menu fixture",
      bounds: { x: 200, y: 150, width: 280, height: 180 },
      zIndex: 2,
      ownerPid: fake.target.pid,
      ownerWindowId: fake.target.windowId,
      minimized: false,
      windowClass: "#32768",
    };
    const parentBounds = { x: 100, y: 120, width: 960, height: 680 };
    const relationshipProbe = {
      async read() {
        const currentMenu = fake.getExtraWindow();
        return {
          source: "win32_relationship_probe" as const,
          complete: true,
          windows: [
            { pid: fake.target.pid, windowId: fake.target.windowId, ownerPid: 0, ownerWindowId: 0, zIndex: 1, isOnScreen: true, minimized: false, bounds: parentBounds, windowClass: "Notepad" },
            ...(currentMenu === undefined ? [] : [{
              pid: currentMenu.pid,
              windowId: currentMenu.windowId,
              ...(currentMenu.ownerPid === undefined ? {} : { ownerPid: currentMenu.ownerPid }),
              ...(currentMenu.ownerWindowId === undefined ? {} : { ownerWindowId: currentMenu.ownerWindowId }),
              ...(currentMenu.zIndex === undefined ? {} : { zIndex: currentMenu.zIndex }),
              isOnScreen: currentMenu.isOnScreen ?? true,
              minimized: currentMenu.minimized ?? false,
              bounds: currentMenu.bounds ?? parentBounds,
              ...(currentMenu.windowClass === undefined ? {} : { windowClass: currentMenu.windowClass }),
            }]),
          ],
          foregroundPid: fake.target.pid,
          foregroundWindowId: fake.target.windowId,
        };
      },
    };
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", grounding: "off", windowSwitch: "opened-windows-v1",
      windowSwitchAllowedTargets: [fake.target], windowRelationshipProbe: relationshipProbe,
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const parent = await computer.observe(session, "probe-menu-parent" as ObservationId, signal);
      fake.setExtraWindowAfterClick(menu);
      const receipt = await computer.execute(session, {
        actionId: "probe-menu-open" as ActionId,
        basedOn: "probe-menu-parent" as ObservationId,
        kind: "click",
        point: { x: 12, y: 18 },
      }, signal, { detectNewWindowHandoff: true });
      expect(receipt.status).toBe("completed");
      expect(await computer.detectNewWindowHandoffCandidates(session, signal)).toEqual([]);

      const child = await computer.observe(session, "probe-menu-child" as ObservationId, signal);
      expect(child.surfaceRef).toMatchObject({ kind: "native_window", parentSurfaceId: parent.surfaceRef.surfaceId, admissionSource: "win32_relationship_probe" });
      expect(child.surfaceTransitionReason).toBe("child_push");
      expect(fake.calls.filter((call) => call.name === "get_window_state" && call.input?.window_id === menu.windowId)).toHaveLength(0);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["Menu", "Window"].flatMap((rootRole) => ["unrestricted", "includes-child", "parent-only"].flatMap((scope) =>
    ["off", "opened-windows-v1"].map((windowSwitch) => ({ rootRole, scope, windowSwitch: windowSwitch as "off" | "opened-windows-v1" })),
  )))("classifies owned bridge before peer scope: $rootRole / $scope / $windowSwitch", async ({ rootRole, scope, windowSwitch }) => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-counted-menu-root-"));
    const fake = windowDriver();
    const originalCallTool = fake.driver.callTool;
    fake.driver.callTool = async (name, inputJson) => {
      const response = await originalCallTool(name, inputJson);
      if (name !== "list_windows" || response.structuredJson === undefined) return response;
      const inventory = JSON.parse(response.structuredJson) as { windows: Array<{ pid: number; window_id: number; z_index?: number }> };
      for (const row of inventory.windows) {
        if (row.pid === fake.target.pid && row.window_id === fake.target.windowId) row.z_index = 5;
      }
      return { ...response, structuredJson: JSON.stringify(inventory) };
    };
    const menu = {
      pid: fake.target.pid,
      windowId: 8790,
      appName: "Notepad",
      title: "synthetic modern menu fixture",
      bounds: { x: 200, y: 150, width: 280, height: 180 },
      zIndex: 6,
      ownerPid: fake.target.pid,
      ownerWindowId: fake.target.windowId,
      minimized: false,
      windowClass: "Microsoft.UI.Content.PopupWindowSiteBridge",
    };
    const elements = [
      { depth: 3, role: rootRole },
      ...Array.from({ length: 26 }, (_, index) => ({ depth: index % 2 === 0 ? 4 : 5, role: "MenuItem" })),
    ];
    fake.setWindowImageSize(menu.windowId, menu.bounds.width, menu.bounds.height);
    fake.setWindowGroundingState(menu.windowId, {
      pid: menu.pid,
      window_id: menu.windowId,
      element_count: elements.length,
      returned_element_count: elements.length,
      total_element_count: elements.length,
      elements_complete: false,
      elements,
    });
    fake.setSecondExtraWindow({
      pid: 9999, windowId: 9990, appName: "Explorer", title: "shell helper",
      bounds: { x: 0, y: 0, width: 50, height: 50 },
      zIndex: 744, ownerPid: 0, ownerWindowId: 0, minimized: false,
      windowClass: "ThumbnailDeviceHelperWnd",
    });
    const baseProbe = relationshipProbeFor(fake);
    const probe = {
      async read() {
        const snapshot = await baseProbe.read();
        return {
          ...snapshot,
          // Model a fresh DWM bounds sample arriving after CUA's independent
          // inventory while preserving exact PID/HWND and relationship facts.
          windows: snapshot.windows.map((window) => ({
            ...window, bounds: { ...window.bounds, x: window.bounds.x + 1 },
            zIndex: window.windowId === menu.windowId ? 699 : window.windowId === fake.target.windowId ? 639 : window.zIndex,
          })),
          foregroundPid: 9999,
          foregroundWindowId: 9990,
        };
      },
    };
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", grounding: "uia-catalog-v1", windowSwitch,
      ...(scope === "unrestricted" ? {} : { windowSwitchAllowedTargets: scope === "includes-child" ? [fake.target, { pid: menu.pid, windowId: menu.windowId }] : [fake.target] }),
      windowRelationshipProbe: probe,
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const parent = await computer.observe(session, "counted-menu-parent" as ObservationId, signal);
      fake.setExtraWindowAfterClick(menu);
      const receipt = await computer.execute(session, {
        actionId: "counted-menu-open" as ActionId,
        basedOn: "counted-menu-parent" as ObservationId,
        kind: "click",
        point: { x: 12, y: 18 },
      }, signal, { detectNewWindowHandoff: true });

      expect(receipt.status).toBe("completed");
      if (rootRole === "Window") {
        await expect(computer.detectNewWindowHandoffCandidates(session, signal)).rejects.toMatchObject({
          code: "TRANSIENT_SURFACE_UNKNOWN",
        });
        await computer.close(session);
        return;
      }
      expect(await computer.detectNewWindowHandoffCandidates(session, signal)).toEqual([]);
      const child = await computer.observe(session, "counted-menu-child" as ObservationId, signal);
      expect(child.surfaceTransitionReason).toBe("child_push");
      expect(child.surfaceRef).toMatchObject({ kind: "native_window", parentSurfaceId: parent.surfaceRef.surfaceId });
      expect(fake.calls.some((call) => call.name === "get_window_state" && call.input?.pid === menu.pid &&
        call.input.window_id === menu.windowId && call.input.include_screenshot === false)).toBe(true);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["unrestricted", "includes-child", "parent-only"])("withholds an ambiguous owned popup stack before peer scope (%s)", async (scope) => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-probe-menu-ambiguous-"));
    const fake = windowDriver();
    const sibling = {
      pid: fake.target.pid,
      windowId: 8782,
      appName: "Notepad",
      title: "synthetic sibling fixture",
      bounds: { x: 210, y: 160, width: 250, height: 150 },
      zIndex: 3,
      ownerPid: fake.target.pid,
      ownerWindowId: fake.target.windowId,
      minimized: false,
      windowClass: "#32768",
    };
    const menu = {
      pid: fake.target.pid,
      windowId: 8783,
      appName: "Notepad",
      title: "synthetic menu fixture",
      bounds: { x: 200, y: 150, width: 280, height: 180 },
      zIndex: 3,
      ownerPid: fake.target.pid,
      ownerWindowId: fake.target.windowId,
      minimized: false,
      windowClass: "#32768",
    };
    fake.setSecondExtraWindow(sibling);
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", grounding: "off",
      ...(scope === "unrestricted" ? {} : { windowSwitchAllowedTargets: scope === "includes-child" ? [fake.target, { pid: menu.pid, windowId: menu.windowId }] : [fake.target] }),
      windowRelationshipProbe: relationshipProbeFor(fake), driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const parent = await computer.observe(session, "probe-menu-ambiguous-parent" as ObservationId, signal);
      fake.setExtraWindowAfterClick(menu);
      const receipt = await computer.execute(session, {
        actionId: "probe-menu-ambiguous-open" as ActionId,
        basedOn: "probe-menu-ambiguous-parent" as ObservationId,
        kind: "click",
        point: { x: 12, y: 18 },
      }, signal, { detectNewWindowHandoff: true });
      expect(receipt.status).toBe("completed");
      await expect(computer.detectNewWindowHandoffCandidates(session, signal))
        .rejects.toMatchObject({ code: "WINDOW_INVENTORY_UNKNOWN" });
      expect(await computer.listNewWindowHandoffCandidates(session, signal)).toEqual([]);
      const current = await computer.observe(session, "probe-menu-ambiguous-still-parent" as ObservationId, signal);
      expect(current.surfaceRef).toEqual(parent.surfaceRef);
      expect(fake.calls.filter((call) => call.name === "get_window_state" && call.input?.window_id === menu.windowId)).toHaveLength(0);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("withholds an out-of-scope candidate when exact root role proof is wrong", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-owned-root-role-"));
    const fake = windowDriver();
    const popup = {
      pid: fake.target.pid,
      windowId: 8769,
      appName: "Editor",
      title: "Ambiguous fixture",
      bounds: { x: 220, y: 160, width: 300, height: 220 },
      zIndex: 2,
      ownerPid: fake.target.pid,
      ownerWindowId: fake.target.windowId,
    };
    fake.setWindowGroundingState(popup.windowId, {
      complete: true,
      elements_complete: true,
      root_surface: { pid: popup.pid, window_id: popup.windowId, role: "Window", complete: true },
      elements: [{ role: "MenuItem", name: "Not a root role" }],
    });
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", grounding: "uia-catalog-v1", windowSwitch: "opened-windows-v1",
      windowSwitchAllowedTargets: [fake.target], driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const parent = await computer.observe(session, "owned-root-parent" as ObservationId, signal);
      fake.setExtraWindowAfterClick(popup);
      await computer.execute(session, {
        actionId: "owned-root-open" as ActionId,
        basedOn: "owned-root-parent" as ObservationId,
        kind: "click",
        point: { x: 10, y: 20 },
      }, signal, { detectNewWindowHandoff: true });
      await expect(computer.detectNewWindowHandoffCandidates(session, signal))
        .rejects.toMatchObject({ code: "TRANSIENT_SURFACE_UNKNOWN" });
      expect(await computer.listNewWindowHandoffCandidates(session, signal)).toEqual([]);
      const after = await computer.observe(session, "owned-root-rejected-parent" as ObservationId, signal);
      expect(after.surfaceRef).toEqual(parent.surfaceRef);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("withholds an out-of-scope candidate when root proof names a different HWND", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-owned-wrong-root-hwnd-"));
    const fake = windowDriver();
    const popup = {
      pid: fake.target.pid,
      windowId: 8773,
      appName: "Editor",
      title: "Wrong HWND fixture",
      bounds: { x: 220, y: 160, width: 300, height: 220 },
      zIndex: 2,
      ownerPid: fake.target.pid,
      ownerWindowId: fake.target.windowId,
    };
    fake.setWindowGroundingState(popup.windowId, {
      complete: true,
      elements_complete: true,
      root_surface: { pid: popup.pid, window_id: popup.windowId + 1, role: "Menu", complete: true },
      elements: [],
    });
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", grounding: "uia-catalog-v1", windowSwitch: "opened-windows-v1",
      windowSwitchAllowedTargets: [fake.target], driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const parent = await computer.observe(session, "owned-wrong-root-hwnd-parent" as ObservationId, signal);
      fake.setExtraWindowAfterClick(popup);
      await computer.execute(session, {
        actionId: "owned-wrong-root-hwnd-open" as ActionId,
        basedOn: "owned-wrong-root-hwnd-parent" as ObservationId,
        kind: "click",
        point: { x: 10, y: 20 },
      }, signal, { detectNewWindowHandoff: true });
      await expect(computer.detectNewWindowHandoffCandidates(session, signal))
        .rejects.toMatchObject({ code: "TRANSIENT_SURFACE_UNKNOWN" });
      expect(await computer.listNewWindowHandoffCandidates(session, signal)).toEqual([]);
      const after = await computer.observe(session, "owned-wrong-root-hwnd-parent-restored" as ObservationId, signal);
      expect(after.surfaceRef).toEqual(parent.surfaceRef);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("withholds an out-of-scope candidate when exact root proof errors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-owned-root-error-"));
    const fake = windowDriver();
    const popup = {
      pid: fake.target.pid,
      windowId: 8770,
      appName: "Editor",
      title: "Proof error fixture",
      bounds: { x: 220, y: 160, width: 300, height: 220 },
      zIndex: 2,
      ownerPid: fake.target.pid,
      ownerWindowId: fake.target.windowId,
    };
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", grounding: "uia-catalog-v1", windowSwitch: "opened-windows-v1",
      windowSwitchAllowedTargets: [fake.target], driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "owned-proof-error-parent" as ObservationId, signal);
      fake.setExtraWindowAfterClick(popup);
      await computer.execute(session, {
        actionId: "owned-proof-error-open" as ActionId,
        basedOn: "owned-proof-error-parent" as ObservationId,
        kind: "click",
        point: { x: 10, y: 20 },
      }, signal, { detectNewWindowHandoff: true });
      fake.setFallbackRefusal("UIA_REFUSED", "exact fixture root proof refused");
      await expect(computer.detectNewWindowHandoffCandidates(session, signal))
        .rejects.toMatchObject({ code: "TRANSIENT_SURFACE_UNKNOWN" });
      expect(await computer.listNewWindowHandoffCandidates(session, signal)).toEqual([]);
      const proofCalls = fake.calls.filter((call) => call.name === "get_window_state" && call.input?.window_id === popup.windowId);
      expect(proofCalls).toHaveLength(1);
      expect(await computer.detectNewWindowHandoffCandidates(session, signal)).toEqual([]);
      expect(fake.calls.filter((call) => call.name === "get_window_state" && call.input?.window_id === popup.windowId)).toHaveLength(1);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("invalidates one-shot transient admission when the parent generation changes after the action", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-owned-stale-parent-"));
    const fake = windowDriver();
    const popup = {
      pid: fake.target.pid,
      windowId: 8771,
      appName: "Editor",
      title: "Stale parent fixture",
      bounds: { x: 220, y: 160, width: 300, height: 220 },
      zIndex: 2,
      ownerPid: fake.target.pid,
      ownerWindowId: fake.target.windowId,
    };
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", grounding: "uia-catalog-v1", windowSwitch: "opened-windows-v1",
      windowSwitchAllowedTargets: [fake.target], driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const parent = await computer.observe(session, "owned-stale-parent" as ObservationId, signal);
      fake.setExtraWindowAfterClick(popup);
      await computer.execute(session, {
        actionId: "owned-stale-open" as ActionId,
        basedOn: "owned-stale-parent" as ObservationId,
        kind: "click",
        point: { x: 10, y: 20 },
      }, signal, { detectNewWindowHandoff: true });
      const accessibilityCallsBeforeAdmission = fake.calls.filter((call) => call.name === "get_accessibility_tree").length;
      fake.setBounds({ x: 101, y: 120, width: 960, height: 680 }, { width: 958, height: 678 });
      await expect(computer.detectNewWindowHandoffCandidates(session, signal))
        .rejects.toMatchObject({ code: "TRANSIENT_SURFACE_UNKNOWN" });
      expect(fake.calls.filter((call) => call.name === "get_accessibility_tree")).toHaveLength(accessibilityCallsBeforeAdmission);
      expect(await computer.listNewWindowHandoffCandidates(session, signal)).toEqual([]);
      const refreshed = await computer.observe(session, "owned-stale-parent-refreshed" as ObservationId, signal);
      expect(refreshed.surfaceRef.surfaceId).toBe(parent.surfaceRef.surfaceId);
      expect(refreshed.surfaceRef.generation).toBeGreaterThan(parent.surfaceRef.generation);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers one explicit UIA timeout within the shared bounded capture budget", async () => {
    const fake = windowDriver();
    fake.setCaptureImages([[], [], []]);
    const retryDelays: number[] = [];
    const fallbackInputs: Record<string, unknown>[] = [];
    let fallbackAttempt = 0;
    const callTool = fake.driver.callTool.bind(fake.driver);
    fake.driver.callTool = async (name: string, inputJson: string, options?: { signal: AbortSignal }) => {
      const input = JSON.parse(inputJson) as Record<string, unknown>;
      if (name === "get_window_state" && input.include_screenshot === true) {
        fake.calls.push({ name, input });
        fallbackInputs.push(input);
        fallbackAttempt += 1;
        if (fallbackAttempt === 1) {
          return result({ isError: true, text: "get_window_state timed out after 4s (UIA provider unresponsive)" });
        }
        return result({ images: [{ mimeType: "image/png", dataBase64: pngWithDimensions(958, 678) }] });
      }
      return callTool(name, inputJson, options);
    };

    const capture = await captureWindowWithRetry(
      fake.driver,
      "window-timeout-recovery",
      fake.target,
      new AbortController().signal,
      {
        now: () => 0,
        delay: async (milliseconds) => { retryDelays.push(milliseconds); },
      },
    );

    expect(capture.viewport).toEqual({ width: 958, height: 678, coordinateSpace: "physical" });
    expect(fallbackAttempt).toBe(2);
    expect(fallbackInputs).toEqual([
      { pid: fake.target.pid, window_id: fake.target.windowId, include_screenshot: true, session: "window-timeout-recovery" },
      { pid: fake.target.pid, window_id: fake.target.windowId, include_screenshot: true, session: "window-timeout-recovery" },
    ]);
    expect(fake.calls.filter((call) => call.name === "verifyState")).toHaveLength(3);
    expect(fake.calls.filter((call) => call.name === "list_windows")).toHaveLength(5);
    expect(retryDelays).toEqual([75, 150, 75]);
    expect(retryDelays.reduce((total, milliseconds) => total + milliseconds, 0)).toBeLessThanOrEqual(300);
    expect(fake.calls.filter((call) => call.name === "get_desktop_state")).toHaveLength(0);
  });

  it("preserves Abort during the shared UIA timeout retry wait", async () => {
    const fake = windowDriver();
    fake.setCaptureImages([[], [], []]);
    const controller = new AbortController();
    const retryDelays: number[] = [];
    let fallbackAttempt = 0;
    const callTool = fake.driver.callTool.bind(fake.driver);
    fake.driver.callTool = async (name: string, inputJson: string, options?: { signal: AbortSignal }) => {
      const input = JSON.parse(inputJson) as Record<string, unknown>;
      if (name === "get_window_state" && input.include_screenshot === true) {
        fake.calls.push({ name, input });
        fallbackAttempt += 1;
        return result({ isError: true, text: "get_window_state timed out after 4s (UIA provider unresponsive)" });
      }
      return callTool(name, inputJson, options);
    };

    await expect(captureWindowWithRetry(
      fake.driver,
      "window-timeout-abort",
      fake.target,
      controller.signal,
      {
        now: () => 0,
        delay: async (milliseconds) => {
          retryDelays.push(milliseconds);
          if (retryDelays.length === 3) controller.abort(new Error("abort during UIA timeout retry"));
        },
      },
    )).rejects.toThrow(/abort during UIA timeout retry/u);

    expect(fallbackAttempt).toBe(1);
    expect(fake.calls.filter((call) => call.name === "verifyState")).toHaveLength(3);
    expect(retryDelays).toEqual([75, 150, 75]);
  });

  it("does not retry a permission refusal that contains timeout-like text", async () => {
    const fake = windowDriver();
    fake.setCaptureImages([[], [], []]);
    const fallbackCalls: Record<string, unknown>[] = [];
    const callTool = fake.driver.callTool.bind(fake.driver);
    fake.driver.callTool = async (name: string, inputJson: string, options?: { signal: AbortSignal }) => {
      const input = JSON.parse(inputJson) as Record<string, unknown>;
      if (name === "get_window_state" && input.include_screenshot === true) {
        fake.calls.push({ name, input });
        fallbackCalls.push(input);
        return result({ isError: true, text: "UIA provider unresponsive timed out; screenshot permission denied" });
      }
      return callTool(name, inputJson, options);
    };
    const retryDelays: number[] = [];

    await expect(captureWindowWithRetry(
      fake.driver,
      "window-refusal-conflict",
      fake.target,
      new AbortController().signal,
      {
        now: () => 0,
        delay: async (milliseconds) => { retryDelays.push(milliseconds); },
      },
    )).rejects.toThrow(/was refused/u);

    expect(fallbackCalls).toHaveLength(1);
    expect(fake.calls.filter((call) => call.name === "verifyState")).toHaveLength(3);
    expect(retryDelays).toEqual([75, 150]);
  });

  it("does not capture a selected window without verified geometry", async () => {
    const fake = windowDriver();
    fake.setBounds({ x: 100, y: 120, width: 0, height: 680 }, { width: 1, height: 1 });

    await expect(captureWindowWithRetry(
      fake.driver,
      "window-unknown-geometry",
      fake.target,
      new AbortController().signal,
    )).rejects.toThrow(/window target was not found/u);

    expect(fake.calls.filter((call) => call.name === "verifyState")).toHaveLength(0);
    expect(fake.calls.filter((call) => call.name === "get_window_state")).toHaveLength(0);
  });

  it("rejects a fallback frame that exceeds the freshly listed window bounds", async () => {
    const fake = windowDriver();
    fake.setCaptureImages([[], [], []]);
    fake.setFallbackImages([{ mimeType: "image/png", dataBase64: pngWithDimensions(961, 680) }]);

    await expect(captureWindowWithRetry(
      fake.driver,
      "window-frame-out-of-bounds",
      fake.target,
      new AbortController().signal,
      { now: () => 0, delay: async () => undefined },
    )).rejects.toThrow(/outside the verified window bounds/u);

    expect(fake.calls.filter((call) => call.name === "verifyState")).toHaveLength(3);
    expect(fake.calls.filter((call) => call.name === "get_window_state")).toHaveLength(1);
    expect(fake.calls.filter((call) => call.name === "get_desktop_state")).toHaveLength(0);
  });

  it("fails closed after a transport error instead of retrying a GUI action", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-"));
    const fake = fakeDriver();
    let transport = false;
    fake.driver.callTool = async (name: string, input: string, options?: { signal: AbortSignal }) => {
      if (transport && name === "click") {
        throw Object.assign(new Error("transport closed"), { tag: "Transport", inner: { reason: "closed" } });
      }
      const fallback = fakeDriver();
      return fallback.driver.callTool(name, input, options);
    };
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, driverFactory: () => fake.driver });
    try {
      const session = await computer.open({}, new AbortController().signal);
      await computer.observe(session, "observation-1" as ObservationId, new AbortController().signal);
      transport = true;
      await expect(computer.execute(session, {
        actionId: "click-transport" as ActionId,
        basedOn: "observation-1" as ObservationId,
        kind: "click",
        point: { x: 0, y: 0 },
      }, new AbortController().signal)).rejects.toThrow(/CUA execute failed: closed/);
      await expect(computer.execute(session, {
        actionId: "click-after-transport" as ActionId,
        basedOn: "observation-1" as ObservationId,
        kind: "click",
        point: { x: 0, y: 0 },
      }, new AbortController().signal)).rejects.toThrow(/inactive/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps explicit driver Tool errors as refusals", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-"));
    const fake = fakeDriver();
    fake.driver.callTool = async (name: string, input: string, options?: { signal: AbortSignal }) => {
      if (name === "click") {
        throw Object.assign(new Error("foreground target unavailable"), {
          tag: "Tool",
          inner: { errorCode: "FOREGROUND_UNAVAILABLE", reason: "target not active" },
        });
      }
      const fallback = fakeDriver();
      return fallback.driver.callTool(name, input, options);
    };
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, driverFactory: () => fake.driver });
    try {
      const session = await computer.open({}, new AbortController().signal);
      await computer.observe(session, "observation-1" as ObservationId, new AbortController().signal);
      const receipt = await computer.execute(session, {
        actionId: "click-refused" as ActionId,
        basedOn: "observation-1" as ObservationId,
        kind: "click",
        point: { x: 0, y: 0 },
      }, new AbortController().signal);
      expect(receipt).toMatchObject({ status: "refused", driverCode: "FOREGROUND_UNAVAILABLE" });
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("invalidates the session when observation transport fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-"));
    const fake = fakeDriver();
    fake.driver.callTool = async (name: string, input: string, options?: { signal: AbortSignal }) => {
      if (name === "get_desktop_state") {
        throw Object.assign(new Error("observation channel closed"), { tag: "Transport", inner: { reason: "closed" } });
      }
      const fallback = fakeDriver();
      return fallback.driver.callTool(name, input, options);
    };
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, driverFactory: () => fake.driver });
    let session: Awaited<ReturnType<CuaDriverComputer["open"]>> | undefined;
    try {
      session = await computer.open({}, new AbortController().signal);
      await expect(computer.observe(session, "observation-transport" as ObservationId, new AbortController().signal)).rejects.toThrow(/CUA observe failed: closed/);
      await expect(computer.execute(session, {
        actionId: "click-after-observe-transport" as ActionId,
        basedOn: "observation-transport" as ObservationId,
        kind: "click",
        point: { x: 0, y: 0 },
      }, new AbortController().signal)).rejects.toThrow(/inactive/);
    } finally {
      if (session !== undefined) await computer.close(session).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not overwrite an inactive retained session before close", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-"));
    const fake = fakeDriver();
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, driverFactory: () => fake.driver });
    const session = await computer.open({}, new AbortController().signal);
    await computer.observe(session, "observation-1" as ObservationId, new AbortController().signal);
    fake.driver.callTool = async (name: string, input: string, options?: { signal: AbortSignal }) => {
      if (name === "get_desktop_state") throw Object.assign(new Error("transport closed"), { tag: "Transport" });
      return fakeDriver().driver.callTool(name, input, options);
    };
    await expect(computer.observe(session, "observation-2" as ObservationId, new AbortController().signal)).rejects.toThrow(/transport/);
    await expect(computer.open({}, new AbortController().signal)).rejects.toThrow(/close it before opening/);
    await computer.close(session);
    await rm(directory, { recursive: true, force: true });
  });

  it("bounds a hanging endSession and retains the session so a new Run cannot reuse it", async () => {
    vi.useFakeTimers();
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-cleanup-"));
    const fake = fakeDriver();
    let hang = false;
    fake.driver.endSession = async () => {
      if (hang) return await new Promise<never>(() => undefined);
      return { active: false, session: "test" } as never;
    };
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, cleanupWaitMs: 25, driverFactory: () => fake.driver });
    try {
      const session = await computer.open({}, new AbortController().signal);
      hang = true;
      const close = computer.close(session);
      const closeResult = expect(close).rejects.toThrow(/cleanup deadline exceeded during endSession/iu);
      await vi.advanceTimersByTimeAsync(25);
      await closeResult;
      await expect(computer.open({}, new AbortController().signal)).rejects.toThrow(/still retained/iu);
    } finally {
      vi.useRealTimers();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("bounds a hanging shutdown after endSession without destroying the retained driver", async () => {
    vi.useFakeTimers();
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-cleanup-"));
    const fake = fakeDriver();
    fake.driver.shutdown = async () => await new Promise<void>(() => undefined);
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, cleanupWaitMs: 25, driverFactory: () => fake.driver });
    try {
      const session = await computer.open({}, new AbortController().signal);
      const close = computer.close(session);
      const closeResult = expect(close).rejects.toThrow(/cleanup deadline exceeded during shutdown/iu);
      await vi.advanceTimersByTimeAsync(25);
      await closeResult;
      await expect(computer.open({}, new AbortController().signal)).rejects.toThrow(/still retained/iu);
    } finally {
      vi.useRealTimers();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retries an active session with a bounded poll interval and completes after it becomes inactive", async () => {
    vi.useFakeTimers();
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-cleanup-"));
    const fake = fakeDriver();
    let endSessionCalls = 0;
    let shutdownCalls = 0;
    fake.driver.endSession = async () => {
      endSessionCalls += 1;
      return { active: endSessionCalls === 1, session: "test" } as never;
    };
    fake.driver.shutdown = async () => {
      shutdownCalls += 1;
    };
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, cleanupWaitMs: 100, driverFactory: () => fake.driver });
    try {
      const session = await computer.open({}, new AbortController().signal);
      const close = computer.close(session);
      await vi.advanceTimersByTimeAsync(100);
      await expect(close).resolves.toBeUndefined();
      expect(endSessionCalls).toBe(2);
      expect(shutdownCalls).toBe(1);
    } finally {
      vi.useRealTimers();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retries a session_cleanup_pending response with a bounded poll interval", async () => {
    vi.useFakeTimers();
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-cleanup-"));
    const fake = fakeDriver();
    let endSessionCalls = 0;
    fake.driver.endSession = async () => {
      endSessionCalls += 1;
      if (endSessionCalls === 1) {
        throw Object.assign(new Error("cleanup pending"), { inner: { errorCode: "session_cleanup_pending" } });
      }
      return { active: false, session: "test" } as never;
    };
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, cleanupWaitMs: 100, driverFactory: () => fake.driver });
    try {
      const session = await computer.open({}, new AbortController().signal);
      const close = computer.close(session);
      await vi.advanceTimersByTimeAsync(100);
      await expect(close).resolves.toBeUndefined();
      expect(endSessionCalls).toBe(2);
    } finally {
      vi.useRealTimers();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retains pending ownership when an already-started open cannot confirm cleanup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-cleanup-"));
    const fake = fakeDriver();
    let startSessionCalls = 0;
    let endSessionCalls = 0;
    let destroyCalls = 0;
    fake.driver.startSession = async () => {
      startSessionCalls += 1;
      return { active: true, revived: false } as never;
    };
    fake.driver.callTool = async (name: string) => {
      if (name === "get_screen_size") {
        throw Object.assign(new Error("screen transport closed"), { tag: "Transport", inner: { reason: "closed" } });
      }
      return result();
    };
    fake.driver.endSession = async () => {
      endSessionCalls += 1;
      throw Object.assign(new Error("cleanup transport closed"), { tag: "Transport", inner: { reason: "closed" } });
    };
    fake.driver.shutdown = async () => undefined;
    (fake.driver as unknown as { uniffiDestroy: () => void }).uniffiDestroy = () => {
      destroyCalls += 1;
    };
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, cleanupWaitMs: 25, driverFactory: () => fake.driver });
    try {
      await expect(computer.open({}, new AbortController().signal)).rejects.toThrow(/CUA open failed/iu);
      expect(startSessionCalls).toBe(1);
      expect(endSessionCalls).toBe(1);
      expect(destroyCalls).toBe(0);
      await expect(computer.open({}, new AbortController().signal)).rejects.toThrow(/pending/iu);
      expect(startSessionCalls).toBe(1);
      expect(destroyCalls).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retries retained failed-open cleanup through dispose without reopening the session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-dispose-pending-"));
    const fake = fakeDriver();
    let endSessionCalls = 0;
    const shutdown = vi.fn(async () => undefined);
    let destroyCalls = 0;
    fake.driver.callTool = async (name: string) => {
      if (name === "get_screen_size") {
        throw Object.assign(new Error("screen transport closed"), { tag: "Transport", inner: { reason: "closed" } });
      }
      return result();
    };
    fake.driver.endSession = async () => {
      endSessionCalls += 1;
      if (endSessionCalls === 1) {
        throw Object.assign(new Error("cleanup transport closed"), { tag: "Transport", inner: { reason: "closed" } });
      }
      return { active: false, session: "test" } as never;
    };
    fake.driver.shutdown = shutdown;
    (fake.driver as unknown as { uniffiDestroy: () => void }).uniffiDestroy = () => { destroyCalls += 1; };
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, cleanupWaitMs: 100, driverFactory: () => fake.driver });
    try {
      await expect(computer.open({}, new AbortController().signal)).rejects.toThrow(/CUA open failed/iu);
      await expect(computer.dispose()).resolves.toBeUndefined();
      expect(endSessionCalls).toBe(2);
      expect(shutdown).toHaveBeenCalledOnce();
      expect(destroyCalls).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses an explicit window target and the actual PNG viewport without desktop fallback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-window-"));
    const fake = windowDriver();
    const computer = new CuaDriverComputer({
      socketPath: "test-socket",
      screenshotDir: directory,
      windowTarget: fake.target,
      driverFactory: () => fake.driver,
    });
    try {
      const session = await computer.open({}, new AbortController().signal);
      expect(session.viewport).toEqual({ width: 958, height: 678, coordinateSpace: "physical" });
      expect(session.capabilities).toMatchObject({ screenshot: true, pointer: true, keyboard: false });
      const observation = await computer.observe(session, "window-observation" as ObservationId, new AbortController().signal);
      expect(observation.viewport).toEqual({ width: 958, height: 678, coordinateSpace: "physical" });
      const receipt = await computer.execute(session, {
        actionId: "window-click" as ActionId,
        basedOn: "window-observation" as ObservationId,
        kind: "click",
        point: { x: 10, y: 20 },
      }, new AbortController().signal);
      expect(receipt.status).toBe("completed");
      const click = fake.calls.find((call) => call.name === "click");
      expect(click?.input).toMatchObject({ target: { kind: "window", pid: 1234, window_id: 5678 }, x: 10, y: 20, delivery_mode: "background" });
      const backgroundType = await computer.execute(session, {
        actionId: "window-background-type-refused" as ActionId,
        basedOn: "window-observation" as ObservationId,
        kind: "type",
        text: "must-not-dispatch",
      }, new AbortController().signal);
      expect(backgroundType).toMatchObject({ status: "refused", driverCode: "WINDOW_INPUT_UNSUPPORTED" });
      expect(fake.calls.filter((call) => call.name === "type_text")).toHaveLength(0);
      const backgroundScroll = await computer.execute(session, {
        actionId: "window-background-scroll-refused" as ActionId,
        basedOn: "window-observation" as ObservationId,
        kind: "scroll",
        point: { x: 10, y: 20 },
        direction: "down",
        ticks: 1,
      }, new AbortController().signal);
      expect(backgroundScroll).toMatchObject({ status: "refused", driverCode: "WINDOW_ACTION_UNSUPPORTED" });
      expect(fake.calls.filter((call) => call.name === "scroll")).toHaveLength(0);
      const backgroundHotkey = await computer.execute(session, {
        actionId: "window-background-hotkey-refused" as ActionId,
        basedOn: "window-observation" as ObservationId,
        kind: "keypress",
        keys: ["CTRL", "A"],
      }, new AbortController().signal);
      expect(backgroundHotkey).toMatchObject({ status: "refused", driverCode: "WINDOW_INPUT_UNSUPPORTED" });
      expect(fake.calls.filter((call) => call.name === "hotkey")).toHaveLength(0);
      const backgroundDrag = await computer.execute(session, {
        actionId: "window-background-drag-refused" as ActionId,
        basedOn: "window-observation" as ObservationId,
        kind: "drag",
        from: { x: 1, y: 1 },
        to: { x: 20, y: 20 },
      }, new AbortController().signal);
      expect(backgroundDrag).toMatchObject({ status: "refused", driverCode: "WINDOW_ACTION_UNSUPPORTED" });
      expect(fake.calls.filter((call) => call.name === "drag")).toHaveLength(0);
      expect(fake.calls.some((call) => call.name === "get_screen_size" || call.name === "get_desktop_state")).toBe(false);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retries transient no-image captures twice after rediscovering geometry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-window-retry-"));
    const fake = windowDriver();
    const retryDelays: number[] = [];
    const computer = new CuaDriverComputer({
      socketPath: "test-socket",
      screenshotDir: directory,
      windowTarget: fake.target,
      windowCaptureRetry: {
        now: () => 0,
        delay: async (milliseconds) => { retryDelays.push(milliseconds); },
      },
      driverFactory: () => fake.driver,
    });
    try {
      const session = await computer.open({}, new AbortController().signal);
      fake.setCaptureImages([
        [],
        [],
        [{ mimeType: "image/png", dataBase64: pngWithDimensions(958, 678) }],
      ]);
      const observationId = "window-retry-observation" as ObservationId;
      const capture = await computer.observe(session, observationId, new AbortController().signal);
      expect(capture.viewport).toEqual({ width: 958, height: 678, coordinateSpace: "physical" });
      expect(retryDelays).toEqual([75, 150]);
      expect(fake.calls.filter((call) => call.name === "list_windows")).toHaveLength(4);
      expect(fake.calls.filter((call) => call.name === "verifyState")).toHaveLength(4);

      const receipt = await computer.execute(session, {
        actionId: "window-retry-click" as ActionId,
        basedOn: observationId,
        kind: "click",
        point: { x: 10, y: 20 },
      }, new AbortController().signal);
      expect(receipt.status).toBe("completed");
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(1);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses one same-target get_window_state fallback after bounded schema retries without replaying the action", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-window-fallback-"));
    const fake = windowDriver();
    const retryDelays: number[] = [];
    const computer = new CuaDriverComputer({
      socketPath: "test-socket",
      screenshotDir: directory,
      windowTarget: fake.target,
      windowCaptureRetry: {
        now: () => 0,
        delay: async (milliseconds) => { retryDelays.push(milliseconds); },
      },
      driverFactory: () => fake.driver,
    });
    try {
      const session = await computer.open({}, new AbortController().signal);
      fake.setCaptureImages([[], [], []]);
      fake.setFallbackImages([{ mimeType: "image/png", dataBase64: pngWithDimensions(958, 678) }]);
      const observationId = "window-fallback-observation" as ObservationId;
      const capture = await computer.observe(session, observationId, new AbortController().signal);
      expect(capture.viewport).toEqual({ width: 958, height: 678, coordinateSpace: "physical" });
      expect(retryDelays).toEqual([75, 150]);
      expect(fake.calls.filter((call) => call.name === "list_windows")).toHaveLength(5);
      expect(fake.calls.filter((call) => call.name === "verifyState")).toHaveLength(4);
      const fallbackCalls = fake.calls.filter((call) => call.name === "get_window_state");
      expect(fallbackCalls).toHaveLength(1);
      expect(fallbackCalls[0]?.input).toEqual({
        pid: fake.target.pid,
        window_id: fake.target.windowId,
        include_screenshot: true,
        session: session.id,
      });

      const receipt = await computer.execute(session, {
        actionId: "window-fallback-click" as ActionId,
        basedOn: observationId,
        kind: "click",
        point: { x: 10, y: 20 },
      }, new AbortController().signal);
      expect(receipt.status).toBe("completed");
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(1);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("surfaces a bounded classified fallback refusal without retrying input or using desktop capture", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-window-fallback-refused-"));
    const fake = windowDriver();
    const retryDelays: number[] = [];
    const computer = new CuaDriverComputer({
      socketPath: "test-socket",
      screenshotDir: directory,
      windowTarget: fake.target,
      windowCaptureRetry: {
        now: () => 0,
        delay: async (milliseconds) => { retryDelays.push(milliseconds); },
      },
      driverFactory: () => fake.driver,
    });
    try {
      const session = await computer.open({}, new AbortController().signal);
      const before = await computer.observe(session, "window-refusal-before" as ObservationId, new AbortController().signal);
      fake.setCaptureImages([[], [], []]);
      fake.setFallbackRefusal(
        undefined,
        "get_window_state timed out after 4s (UIA provider unresponsive on hwnd 0x999, auth token=do-not-persist) C:\\Users\\private\\document.pdf",
      );

      const receipt = await computer.execute(session, {
        actionId: "window-refusal-click" as ActionId,
        basedOn: "window-refusal-before" as ObservationId,
        kind: "click",
        point: { x: 10, y: 20 },
      }, new AbortController().signal);
      expect(receipt.status).toBe("completed");

      let failure: unknown;
      try {
        await computer.observe(session, "window-refusal-after" as ObservationId, new AbortController().signal);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toContain("get_window_state fallback");
      expect(message).toContain(`pid=${fake.target.pid}`);
      expect(message).toContain(`window_id=${fake.target.windowId}`);
      expect(message).toContain("[UIA_PROVIDER_TIMEOUT]");
      expect(message).not.toContain("PRIVATE_ACCESS_TOKEN");
      expect(message).not.toContain("do-not-persist");
      expect(message).not.toContain("private\\document.pdf");
      expect(message).not.toContain("0x999");
      expect(retryDelays).toEqual([75, 150, 75]);
      expect(fake.calls.filter((call) => call.name === "verifyState")).toHaveLength(5);
      expect(fake.calls.filter((call) => call.name === "get_window_state")).toHaveLength(2);
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(1);
      expect(fake.calls.filter((call) => call.name === "get_desktop_state")).toHaveLength(0);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails after two retries when the window capture remains schema-invalid", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-window-retry-"));
    const fake = windowDriver();
    const retryDelays: number[] = [];
    const computer = new CuaDriverComputer({
      socketPath: "test-socket",
      screenshotDir: directory,
      windowTarget: fake.target,
      windowCaptureRetry: {
        now: () => 0,
        delay: async (milliseconds) => { retryDelays.push(milliseconds); },
      },
      driverFactory: () => fake.driver,
    });
    try {
      const session = await computer.open({}, new AbortController().signal);
      fake.setCaptureImages([[], [], []]);
      await expect(computer.observe(session, "window-persistent-retry" as ObservationId, new AbortController().signal))
        .rejects.toThrow(/imageCount=0, mimeTypes=none/iu);
      expect(retryDelays).toEqual([75, 150]);
      expect(fake.calls.filter((call) => call.name === "list_windows")).toHaveLength(5);
      expect(fake.calls.filter((call) => call.name === "verifyState")).toHaveLength(4);
      expect(fake.calls.filter((call) => call.name === "get_window_state")).toHaveLength(1);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not continue retrying when fresh window discovery fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-window-retry-"));
    const fake = windowDriver();
    const retryDelays: number[] = [];
    const computer = new CuaDriverComputer({
      socketPath: "test-socket",
      screenshotDir: directory,
      windowTarget: fake.target,
      windowCaptureRetry: {
        now: () => 0,
        delay: async (milliseconds) => { retryDelays.push(milliseconds); },
      },
      driverFactory: () => fake.driver,
    });
    try {
      const session = await computer.open({}, new AbortController().signal);
      fake.setCaptureImages([[]]);
      // The open capture is list_windows call 1; the retry discovery below is
      // call 3 because observe has its own first discovery at call 2.
      fake.setMissingAfterListCall(3);
      await expect(computer.observe(session, "window-rediscover-failed" as ObservationId, new AbortController().signal))
        .rejects.toThrow(/window target was not found/iu);
      expect(retryDelays).toEqual([75]);
      expect(fake.calls.filter((call) => call.name === "list_windows")).toHaveLength(3);
      expect(fake.calls.filter((call) => call.name === "verifyState")).toHaveLength(2);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not retry a refused window capture", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-window-retry-"));
    const fake = windowDriver();
    const retryDelays: number[] = [];
    const computer = new CuaDriverComputer({
      socketPath: "test-socket",
      screenshotDir: directory,
      windowTarget: fake.target,
      windowCaptureRetry: {
        now: () => 0,
        delay: async (milliseconds) => { retryDelays.push(milliseconds); },
      },
      driverFactory: () => fake.driver,
    });
    try {
      const session = await computer.open({}, new AbortController().signal);
      fake.driver.verifyState = async () => result({ isError: true, images: [] });
      await expect(computer.observe(session, "window-refused-capture" as ObservationId, new AbortController().signal))
        .rejects.toThrow(/capture was refused/iu);
      expect(retryDelays).toEqual([]);
      expect(fake.calls.filter((call) => call.name === "list_windows")).toHaveLength(2);
      expect(fake.calls.filter((call) => call.name === "get_window_state")).toHaveLength(0);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("stops during retry backoff when the capture signal is aborted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-window-retry-"));
    const fake = windowDriver();
    const retryDelays: number[] = [];
    const controller = new AbortController();
    const computer = new CuaDriverComputer({
      socketPath: "test-socket",
      screenshotDir: directory,
      windowTarget: fake.target,
      windowCaptureRetry: {
        now: () => 0,
        delay: async (milliseconds, signal) => {
          retryDelays.push(milliseconds);
          expect(signal.aborted).toBe(false);
          controller.abort(new Error("aborted during capture backoff"));
        },
      },
      driverFactory: () => fake.driver,
    });
    try {
      const session = await computer.open({}, new AbortController().signal);
      fake.setCaptureImages([[]]);
      await expect(computer.observe(session, "window-abort-retry" as ObservationId, controller.signal)).rejects.toThrow(/aborted during capture backoff/iu);
      expect(retryDelays).toEqual([75]);
      expect(fake.calls.filter((call) => call.name === "list_windows")).toHaveLength(2);
      expect(fake.calls.filter((call) => call.name === "verifyState")).toHaveLength(2);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not enter the fallback after the final schema capture is aborted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-window-fallback-abort-"));
    const fake = windowDriver();
    const controller = new AbortController();
    const computer = new CuaDriverComputer({
      socketPath: "test-socket",
      screenshotDir: directory,
      windowTarget: fake.target,
      windowCaptureRetry: {
        now: () => 0,
        delay: async () => undefined,
      },
      driverFactory: () => fake.driver,
    });
    try {
      const session = await computer.open({}, new AbortController().signal);
      fake.setCaptureImages([[], [], []]);
      fake.setFallbackImages([{ mimeType: "image/png", dataBase64: pngWithDimensions(958, 678) }]);
      const verifyState = fake.driver.verifyState.bind(fake.driver);
      let verifyCount = 0;
      fake.driver.verifyState = async (...args: Parameters<CuaDriverLike["verifyState"]>) => {
        const response = await verifyState(...args);
        verifyCount += 1;
        if (verifyCount === 3) controller.abort(new Error("aborted after final schema capture"));
        return response;
      };
      await expect(computer.observe(session, "window-fallback-abort" as ObservationId, controller.signal))
        .rejects.toThrow(/aborted after final schema capture/iu);
      expect(fake.calls.filter((call) => call.name === "get_window_state")).toHaveLength(0);
      expect(fake.calls.filter((call) => call.name === "verifyState")).toHaveLength(4);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("projects a bounded redacted UIA catalog and validates observation-bound element clicks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-grounding-"));
    const fake = windowDriver(
      { x: 100, y: 120, width: 1828, height: 1528 },
      { width: 1568, height: 1310 },
    );
    fake.setGroundingState({
      elements_complete: true,
      elements: [
        { element_index: 1, role: "ComboBox", name: "Departure time", frame: { x: 568, y: 634, width: 100, height: 40 }, enabled: true, expanded: false, value: "secret" },
        { element_index: 2, role: "Edit", name: "Search", frame: { x: 350, y: 420, width: 160, height: 30 }, enabled: true, editable: true, focused: true },
        { element_index: 3, role: "Button", name: "Disabled", frame: { x: 800, y: 820, width: 120, height: 40 }, enabled: false },
      ],
    });
    const computer = new CuaDriverComputer({
      platform: "win32",
      socketPath: "test-socket",
      screenshotDir: directory,
      windowTarget: fake.target,
      windowDeliveryMode: "foreground",
      grounding: "uia-catalog-v1",
      driverFactory: () => fake.driver,
    });
    try {
      const session = await computer.open({}, new AbortController().signal);
      expect(session.capabilities.accessibility).toBe(true);
      const observationId = "grounding-observation" as ObservationId;
      const capture = await computer.observe(session, observationId, new AbortController().signal);
      expect(capture.grounding).toMatchObject({ version: "uia-catalog-v1", source: "uia", completeness: "complete", degraded: false, maxElements: 256 });
      expect(capture.grounding?.elements).toHaveLength(3);
      const combo = capture.grounding?.elements.find((element) => element.name === "Departure time");
      expect(combo).toMatchObject({ role: "ComboBox", state: { enabled: true, valuePresent: true } });
      expect(combo).not.toHaveProperty("browserRegion");
      expect(combo?.bbox?.x).toBeCloseTo(401.4, 1);
      expect(combo?.bbox?.y).toBeCloseTo(440.7, 1);
      expect(combo).not.toHaveProperty("value");
      expect(combo?.elementRef).toMatch(/^uia-[0-9a-f]{12}-\d+$/u);

      const comboPoint = {
        x: combo!.bbox!.x + combo!.bbox!.width / 2,
        y: combo!.bbox!.y + combo!.bbox!.height / 2,
      };

      const click = await computer.execute(session, {
        actionId: "grounding-click" as ActionId,
        basedOn: observationId,
        kind: "click",
        point: comboPoint,
        groundingRef: combo!.elementRef,
      }, new AbortController().signal);
      expect(click.status).toBe("completed");
      expect(fake.calls.find((call) => call.name === "click")?.input).toMatchObject({ x: 518, y: 534 });

      const disabled = capture.grounding?.elements.find((element) => element.name === "Disabled");
      const disabledPoint = {
        x: disabled!.bbox!.x + disabled!.bbox!.width / 2,
        y: disabled!.bbox!.y + disabled!.bbox!.height / 2,
      };
      const disabledClick = await computer.execute(session, {
        actionId: "grounding-disabled" as ActionId,
        basedOn: observationId,
        kind: "click",
        point: disabledPoint,
        groundingRef: disabled!.elementRef,
      }, new AbortController().signal);
      expect(disabledClick).toMatchObject({ status: "refused", driverCode: "GROUNDING_ELEMENT_DISABLED" });
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(1);

      const fresh = await computer.observe(session, "grounding-fresh" as ObservationId, new AbortController().signal);
      const freshCombo = fresh.grounding?.elements.find((element) => element.name === "Departure time");
      expect(freshCombo?.elementRef).not.toBe(combo?.elementRef);
      const stale = await computer.execute(session, {
        actionId: "grounding-stale" as ActionId,
        basedOn: observationId,
        kind: "click",
        point: comboPoint,
        groundingRef: combo!.elementRef,
      }, new AbortController().signal);
      expect(stale).toMatchObject({ status: "refused", driverCode: "STALE_OBSERVATION" });
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("invalidates element refs when a fresh window frame has no usable accessibility data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-grounding-unavailable-"));
    const fake = windowDriver();
    fake.setGroundingState({
      elements_complete: true,
      elements: [
        { element_index: 1, role: "Button", name: "Continue", frame: { x: 180, y: 200, width: 120, height: 40 }, enabled: true },
      ],
    });
    const computer = new CuaDriverComputer({
      socketPath: "test-socket",
      screenshotDir: directory,
      windowTarget: fake.target,
      grounding: "uia-catalog-v1",
      driverFactory: () => fake.driver,
    });
    try {
      const session = await computer.open({}, new AbortController().signal);
      const first = await computer.observe(session, "grounding-before-unavailable" as ObservationId, new AbortController().signal);
      const button = first.grounding?.elements.find((element) => element.name === "Continue");
      expect(button?.elementRef).toMatch(/^uia-[0-9a-f]{12}-\d+$/u);

      const callTool = fake.driver.callTool.bind(fake.driver);
      fake.driver.callTool = async (name: string, inputJson: string, options?: { signal: AbortSignal }) => {
        const input = JSON.parse(inputJson) as Record<string, unknown>;
        if (name === "get_window_state" && input.include_screenshot === false) {
          fake.calls.push({ name, input });
          return result({ isError: true, errorCode: "UIA_PROVIDER_TIMEOUT", text: "UIA provider timed out" });
        }
        return callTool(name, inputJson, options);
      };

      const fresh = await computer.observe(session, "grounding-fresh-without-uia" as ObservationId, new AbortController().signal);
      expect(fresh.screenshot.data.length).toBeGreaterThan(0);
      expect(fresh.grounding).toMatchObject({ completeness: "unknown", degraded: true, elements: [] });
      const stale = await computer.execute(session, {
        actionId: "grounding-unavailable-old-ref" as ActionId,
        basedOn: "grounding-fresh-without-uia" as ObservationId,
        kind: "click",
        point: {
          x: button!.bbox!.x + button!.bbox!.width / 2,
          y: button!.bbox!.y + button!.bbox!.height / 2,
        },
        groundingRef: button!.elementRef,
      }, new AbortController().signal);
      expect(stale).toMatchObject({ status: "refused", driverCode: "GROUNDING_REF_STALE" });
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(0);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retains a safe candidate beyond 64 elements and executes its current ref", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-grounding-large-"));
    const fake = windowDriver();
    fake.setGroundingState({
      elements_complete: true,
      elements: [
        ...Array.from({ length: 80 }, (_, index) => ({
          element_index: index + 1,
          role: "TabItem",
          name: `Chrome tab ${index}`,
          frame: { x: 130 + index, y: 180 + index, width: 80, height: 24 },
          enabled: true,
        })),
        { element_index: 81, role: "Edit", name: "起点输入框", frame: { x: 300, y: 400, width: 160, height: 30 }, enabled: true, editable: true },
      ],
    });
    const computer = new CuaDriverComputer({
      socketPath: "test-socket",
      screenshotDir: directory,
      windowTarget: fake.target,
      windowDeliveryMode: "foreground",
      grounding: "uia-catalog-v1",
      driverFactory: () => fake.driver,
    });
    try {
      const session = await computer.open({}, new AbortController().signal);
      const observationId = "grounding-large-observation" as ObservationId;
      const capture = await computer.observe(session, observationId, new AbortController().signal);
      expect(capture.grounding?.maxElements).toBe(256);
      expect(capture.grounding?.elements).toHaveLength(81);
      const target = capture.grounding?.elements.find((element) => element.name === "起点输入框");
      expect(target).toBeDefined();
      const point = { x: target!.bbox!.x + target!.bbox!.width / 2, y: target!.bbox!.y + target!.bbox!.height / 2 };
      const receipt = await computer.execute(session, {
        actionId: "grounding-large-click" as ActionId,
        basedOn: observationId,
        kind: "click",
        point,
        groundingRef: target!.elementRef,
      }, new AbortController().signal);
      expect(receipt.status).toBe("completed");
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(1);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps screenshot observation available and marks UIA query failure degraded", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-grounding-degraded-"));
    const fake = windowDriver();
    const computer = new CuaDriverComputer({
      socketPath: "test-socket",
      screenshotDir: directory,
      windowTarget: fake.target,
      grounding: "uia-catalog-v1",
      driverFactory: () => fake.driver,
    });
    try {
      const session = await computer.open({}, new AbortController().signal);
      const capture = await computer.observe(session, "grounding-degraded" as ObservationId, new AbortController().signal);
      expect(capture.screenshot.data.byteLength).toBeGreaterThan(0);
      expect(capture.grounding).toMatchObject({ completeness: "unknown", degraded: true, elements: [] });
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps an observable degraded DOM catalog on transport error or identity mismatch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-dom-degraded-"));
    const fake = windowDriver();
    const browserTarget: ManagedBrowserTarget = {
      kind: "managed-chromium",
      browser: "edge",
      profileId: "fixture-profile",
      windowTarget: fake.target,
      tabId: "tab-fixture",
      generation: "generation-1",
      delivery: "loopback-cdp",
    };
    const transportError = createMockDomGroundingTransport(() => { throw new Error("private transport detail"); });
    const mismatchTransport = createMockDomGroundingTransport({ tabId: "", generation: "", candidates: [] });
    try {
      for (const [transport, observationId] of [[transportError, "dom-transport-error"], [mismatchTransport, "dom-identity-mismatch"]] as const) {
        const computer = new CuaDriverComputer({
          socketPath: "test-socket",
          screenshotDir: directory,
          windowTarget: fake.target,
          grounding: "dom-catalog-v1",
          browserTarget,
          domGroundingTransport: transport,
          driverFactory: () => fake.driver,
        });
        const session = await computer.open({}, new AbortController().signal);
        const capture = await computer.observe(session, observationId as ObservationId, new AbortController().signal);
        expect(capture.screenshot.data.byteLength).toBeGreaterThan(0);
        expect(capture.grounding).toMatchObject({ version: "grounding-catalog-v2", source: "dom", completeness: "unknown", degraded: true, maxElements: 256, elements: [] });
        await computer.close(session);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed for DOM-only grounding without a trusted UIA content rectangle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-dom-only-closed-"));
    const fake = windowDriver();
    const browserTarget: ManagedBrowserTarget = {
      kind: "managed-chromium",
      browser: "edge",
      profileId: "fixture-profile",
      windowTarget: fake.target,
      tabId: "tab-fixture",
      generation: "generation-1",
      delivery: "loopback-cdp",
    };
    let collected = 0;
    const transport = createMockDomGroundingTransport(() => {
      collected += 1;
      return { tabId: "tab-fixture", generation: "generation-1", candidates: [] };
    });
    try {
      const computer = new CuaDriverComputer({
        socketPath: "test-socket",
        screenshotDir: directory,
        windowTarget: fake.target,
        grounding: "dom-catalog-v1",
        browserTarget,
        domGroundingTransport: transport,
        driverFactory: () => fake.driver,
      });
      const session = await computer.open({}, new AbortController().signal);
      const capture = await computer.observe(session, "dom-only-closed" as ObservationId, new AbortController().signal);
      expect(capture.grounding).toMatchObject({ source: "dom", completeness: "unknown", degraded: true, elements: [] });
      expect(collected).toBe(0);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("marks hybrid UIA fallback degraded when the DOM producer fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-hybrid-degraded-"));
    const fake = windowDriver();
    fake.setGroundingState({
      elements_complete: true,
      elements: [{ role: "Button", name: "Native fallback", frame: { x: 200, y: 220, width: 80, height: 30 }, enabled: true }],
    });
    const browserTarget: ManagedBrowserTarget = {
      kind: "managed-chromium",
      browser: "edge",
      profileId: "fixture-profile",
      windowTarget: fake.target,
      tabId: "tab-fixture",
      generation: "generation-1",
      delivery: "loopback-cdp",
    };
    try {
      const computer = new CuaDriverComputer({
        socketPath: "test-socket",
        screenshotDir: directory,
        windowTarget: fake.target,
        grounding: "hybrid-catalog-v1",
        browserTarget,
        domGroundingTransport: createMockDomGroundingTransport(() => { throw new Error("private transport detail"); }),
        driverFactory: () => fake.driver,
      });
      const session = await computer.open({}, new AbortController().signal);
      const capture = await computer.observe(session, "hybrid-dom-fallback" as ObservationId, new AbortController().signal);
      expect(capture.grounding).toMatchObject({ version: "grounding-catalog-v2", source: "hybrid", completeness: "partial", degraded: true });
      expect(capture.grounding?.elements.some((element) => element.name === "Native fallback")).toBe(true);
      expect(capture.grounding?.elements.find((element) => element.name === "Native fallback")).not.toHaveProperty("browserRegion");
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("resamples the same hybrid observation until its trusted content rect makes DOM grounding available", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-hybrid-first-frame-ready-"));
    const fake = windowDriver();
    fake.setGroundingStateSequence([
      { elements_complete: true, elements: [{ role: "AXWindow", name: "Browser", frame: { x: 100, y: 120, width: 960, height: 680 }, enabled: true }] },
      { elements_complete: true, elements: [
        { role: "AXWindow", name: "Browser", frame: { x: 100, y: 120, width: 960, height: 680 }, enabled: true },
        { role: "AXWebArea", frame: { x: 100, y: 120, width: 960, height: 680 }, enabled: true },
      ] },
    ]);
    const browserTarget: ManagedBrowserTarget = {
      kind: "managed-chromium",
      browser: "chromium",
      profileId: "fixture-profile",
      windowTarget: fake.target,
      tabId: "tab-fixture",
      generation: "generation-1",
      delivery: "loopback-cdp",
    };
    let collectCount = 0;
    const transport = createMockDomGroundingTransport(() => {
      collectCount += 1;
      return {
        complete: true,
        tabId: "tab-fixture",
        generation: "generation-1",
        coordinateSpace: "physical",
        candidates: [{ tagName: "select", name: "Departure", frame: { x: 200, y: 220, width: 120, height: 28 }, visible: true, interactive: true, options: [{ text: "08:00", enabled: true }], state: { enabled: true } }],
      };
    });
    const computer = new CuaDriverComputer({
      socketPath: "test-socket",
      screenshotDir: directory,
      windowTarget: fake.target,
      grounding: "hybrid-catalog-v1",
      browserTarget,
      domGroundingTransport: transport,
      driverFactory: () => fake.driver,
    });
    try {
      const session = await computer.open({}, new AbortController().signal);
      const capture = await computer.observe(session, "hybrid-first-frame-ready" as ObservationId, new AbortController().signal);
      expect(capture.grounding).toMatchObject({ source: "hybrid", degraded: false });
      expect(capture.grounding?.elements.some((element) => element.source === "dom" && element.role === "combobox" && element.options?.some((option) => option.text === "08:00"))).toBe(true);
      expect(collectCount).toBe(1);
      expect(fake.calls.filter((call) => call.name === "get_window_state")).toHaveLength(2);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("cancels hybrid content-rect resampling when the observation signal aborts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-hybrid-resample-abort-"));
    const fake = windowDriver();
    fake.setGroundingState({ elements_complete: true, elements: [{ role: "AXWindow", name: "Browser", frame: { x: 100, y: 120, width: 960, height: 680 }, enabled: true }] });
    const browserTarget: ManagedBrowserTarget = {
      kind: "managed-chromium",
      browser: "chromium",
      profileId: "fixture-profile",
      windowTarget: fake.target,
      tabId: "tab-fixture",
      generation: "generation-1",
      delivery: "loopback-cdp",
    };
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target, grounding: "hybrid-catalog-v1", browserTarget, domGroundingTransport: createMockDomGroundingTransport({ tabId: "tab-fixture", generation: "generation-1", candidates: [] }), driverFactory: () => fake.driver });
    try {
      const session = await computer.open({}, new AbortController().signal);
      const controller = new AbortController();
      const pending = computer.observe(session, "hybrid-resample-abort" as ObservationId, controller.signal);
      setTimeout(() => controller.abort(new Error("hybrid grounding observation aborted")), 10);
      await expect(pending).rejects.toThrow(/hybrid grounding observation aborted/iu);
      expect(fake.calls.filter((call) => call.name === "get_window_state")).toHaveLength(1);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps managed-browser window containers visible as context but refuses their clicks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-container-click-"));
    const fake = windowDriver();
    fake.setGroundingStateSequence([
      { elements_complete: true, elements: [
        { role: "AXWindow", name: "Browser", frame: { x: 100, y: 120, width: 960, height: 680 }, enabled: true },
      ] },
      { elements_complete: true, elements: [
        { role: "AXWindow", name: "Browser", frame: { x: 100, y: 120, width: 960, height: 680 }, enabled: true },
        { role: "AXWebArea", frame: { x: 100, y: 120, width: 960, height: 680 }, enabled: true },
      ] },
    ]);
    const browserTarget: ManagedBrowserTarget = {
      kind: "managed-chromium",
      browser: "chromium",
      profileId: "fixture-profile",
      windowTarget: fake.target,
      tabId: "tab-fixture",
      generation: "generation-1",
      delivery: "loopback-cdp",
    };
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target, grounding: "hybrid-catalog-v1", browserTarget, domGroundingTransport: createMockDomGroundingTransport({ tabId: "tab-fixture", generation: "generation-1", candidates: [] }), driverFactory: () => fake.driver });
    try {
      const session = await computer.open({}, new AbortController().signal);
      const capture = await computer.observe(session, "container-click" as ObservationId, new AbortController().signal);
      const container = capture.grounding?.elements.find((element) => element.source === "uia" && element.name === "Browser");
      expect(container).toMatchObject({ state: { enabled: false } });
      const receipt = await computer.execute(session, {
        actionId: "container-click" as ActionId,
        basedOn: "container-click" as ObservationId,
        kind: "click",
        point: { x: container!.bbox!.x + container!.bbox!.width / 2, y: container!.bbox!.y + container!.bbox!.height / 2 },
        groundingRef: container!.elementRef,
      }, new AbortController().signal);
      expect(receipt).toMatchObject({ status: "refused", driverCode: "MANAGED_BROWSER_CONTAINER_NOT_INTERACTIVE" });
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(0);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("labels UIA browser regions only in managed hybrid mode using the trusted Document rect", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-hybrid-region-"));
    const fake = windowDriver(
      { x: 100, y: 120, width: 1_000, height: 800 },
      { width: 1_000, height: 800 },
    );
    fake.setGroundingState({
      elements_complete: true,
      elements: [
        { role: "Document", frame: { x: 200, y: 220, width: 800, height: 600 }, enabled: true },
        { role: "Button", name: "Content control", frame: { x: 300, y: 320, width: 100, height: 40 }, enabled: true },
        { role: "Button", name: "Browser toolbar", frame: { x: 110, y: 130, width: 60, height: 30 }, enabled: true },
        { role: "Button", name: "Boundary control", frame: { x: 180, y: 300, width: 50, height: 40 }, enabled: true },
      ],
    });
    const browserTarget: ManagedBrowserTarget = {
      kind: "managed-chromium",
      browser: "edge",
      profileId: "fixture-profile",
      windowTarget: fake.target,
      tabId: "tab-fixture",
      generation: "generation-1",
      delivery: "loopback-cdp",
    };
    try {
      const computer = new CuaDriverComputer({
        socketPath: "test-socket",
        screenshotDir: directory,
        windowTarget: fake.target,
        grounding: "hybrid-catalog-v1",
        browserTarget,
        domGroundingTransport: createMockDomGroundingTransport({
          complete: true,
          tabId: "tab-fixture",
          generation: "generation-1",
          candidates: [],
        }),
        driverFactory: () => fake.driver,
      });
      const session = await computer.open({}, new AbortController().signal);
      const observationId = "hybrid-region-observation" as ObservationId;
      const capture = await computer.observe(session, observationId, new AbortController().signal);
      expect(capture.grounding?.source).toBe("hybrid");
      expect(capture.grounding?.elements.find((element) => element.name === "Content control")).toMatchObject({ browserRegion: "content" });
      expect(capture.grounding?.elements.find((element) => element.name === "Browser toolbar")).toMatchObject({ browserRegion: "chrome" });
      expect(capture.grounding?.elements.find((element) => element.name === "Boundary control")).toMatchObject({ browserRegion: "unknown" });

      const content = capture.grounding?.elements.find((element) => element.name === "Content control");
      await expect(computer.execute(session, {
        actionId: "hybrid-region-content-click" as ActionId,
        basedOn: observationId,
        kind: "click",
        point: { x: content!.bbox!.x + content!.bbox!.width / 2, y: content!.bbox!.y + content!.bbox!.height / 2 },
        groundingRef: content!.elementRef,
      }, new AbortController().signal)).resolves.toMatchObject({ status: "refused", driverCode: "MANAGED_BROWSER_DOM_REQUIRED" });
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(0);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("calibrates a DOM control against the same observation's UIA Document rect", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-hybrid-calibration-"));
    const bounds = { x: 100, y: 120, width: 1_828, height: 1_528 };
    const image = { width: 1_568, height: 1_310 };
    const fake = windowDriver(bounds, image);
    const documentFrame = { x: 106, y: 220, width: 1_816, height: 1_400 };
    const controlFrame = { x: 500, y: 500, width: 200, height: 40 };
    fake.setGroundingState({
      elements_complete: true,
      elements: [
        { role: "Document", frame: documentFrame, enabled: true },
        { role: "Edit", name: "到达城市", frame: controlFrame, enabled: true, editable: true },
      ],
    });
    const toImage = (frame: typeof controlFrame) => ({
      x: (frame.x - bounds.x) * image.width / bounds.width,
      y: (frame.y - bounds.y) * image.height / bounds.height,
      width: frame.width * image.width / bounds.width,
      height: frame.height * image.height / bounds.height,
    });
    const documentRect = toImage(documentFrame);
    const controlRect = toImage(controlFrame);
    const cssViewport = { width: 1_254.4, height: 958.4 };
    const domFrame = {
      x: (controlRect.x - documentRect.x) * cssViewport.width / documentRect.width,
      y: (controlRect.y - documentRect.y) * cssViewport.height / documentRect.height,
      width: controlRect.width * cssViewport.width / documentRect.width,
      height: controlRect.height * cssViewport.height / documentRect.height,
    };
    const browserTarget: ManagedBrowserTarget = {
      kind: "managed-chromium",
      browser: "edge",
      profileId: "fixture-profile",
      windowTarget: fake.target,
      tabId: "tab-fixture",
      generation: "generation-1",
      delivery: "loopback-cdp",
    };
    try {
      const computer = new CuaDriverComputer({
        socketPath: "test-socket",
        screenshotDir: directory,
        windowTarget: fake.target,
        grounding: "hybrid-catalog-v1",
        browserTarget,
        domGroundingTransport: createMockDomGroundingTransport({
          tabId: "tab-fixture",
          generation: "generation-1",
          coordinateSpace: "css",
          viewportMetrics: { cssWidth: cssViewport.width, cssHeight: cssViewport.height, deviceScaleFactor: 1.25 },
          candidates: [{ tagName: "input", name: "到达城市", frame: domFrame, visible: true, interactive: true, state: { enabled: true, editable: true } }],
        }),
        driverFactory: () => fake.driver,
      });
      const session = await computer.open({}, new AbortController().signal);
      const capture = await computer.observe(session, "hybrid-calibration" as ObservationId, new AbortController().signal);
      const uia = capture.grounding?.elements.find((element) => element.source === "uia" && element.name === "到达城市");
      const dom = capture.grounding?.elements.find((element) => element.source === "dom" && element.name === "到达城市");
      expect(uia?.bbox).toBeDefined();
      expect(dom?.bbox).toBeDefined();
      expect(dom?.bbox?.x).toBeCloseTo(uia!.bbox!.x, 5);
      expect(dom?.bbox?.y).toBeCloseTo(uia!.bbox!.y, 5);
      expect(dom?.bbox?.width).toBeCloseTo(uia!.bbox!.width, 5);
      expect(dom?.bbox?.height).toBeCloseTo(uia!.bbox!.height, 5);
      const point = { x: dom!.bbox!.x + dom!.bbox!.width / 2, y: dom!.bbox!.y + dom!.bbox!.height / 2 };
      await expect(computer.execute(session, {
        actionId: "hybrid-calibration-click" as ActionId,
        basedOn: "hybrid-calibration" as ObservationId,
        kind: "click",
        point,
        groundingRef: dom!.elementRef,
      }, new AbortController().signal)).resolves.toMatchObject({ status: "completed" });
      const click = fake.calls.find((call) => call.name === "click");
      expect(click?.input).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves confirmed same-app manual handoff while a managed-browser Run is on a native target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-managed-manual-handoff-"));
    const fake = windowDriver();
    fake.setExtraWindow({ pid: 4321, windowId: 8765, appName: "WPS", title: "HarnessProbe-WPS-Doc" });
    fake.setGroundingState({
      elements_complete: true,
      elements: [
        { role: "Document", frame: { x: 106, y: 220, width: 940, height: 560 }, enabled: true },
        { role: "Edit", name: "Search", frame: { x: 200, y: 240, width: 180, height: 32 }, enabled: true, editable: true },
      ],
    });
    const browserTarget: ManagedBrowserTarget = {
      kind: "managed-chromium",
      browser: "edge",
      profileId: "fixture-profile",
      windowTarget: fake.target,
      tabId: "startup-tab",
      generation: "startup-generation",
      delivery: "loopback-cdp",
    };
    let collectCount = 0;
    const collectedTargets: Array<{ pid: number; windowId: number }> = [];
    const transport = createMockDomGroundingTransport((request) => {
      collectCount += 1;
      collectedTargets.push({ ...request.browserTarget.windowTarget });
      return { complete: true, tabId: `active-tab-${collectCount}`, generation: `active-generation-${collectCount}`, candidates: [] };
    });
    const computer = new CuaDriverComputer({
      socketPath: "test-socket",
      screenshotDir: directory,
      windowTarget: fake.target,
      windowDeliveryMode: "foreground",
      windowSwitch: "opened-windows-v1",
      windowSwitchAllowedTargets: [fake.target, { pid: 4321, windowId: 8765 }, { pid: 4321, windowId: 9876 }],
      grounding: "hybrid-catalog-v1",
      browserTarget,
      domGroundingTransport: transport,
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const managedSession = await computer.open({}, signal);
      const managedBefore = await computer.observe(managedSession, "managed-manual-before" as ObservationId, signal);
      expect(managedBefore.grounding?.source).toBe("hybrid");
      expect(collectCount).toBe(1);

      const wpsOption = (await computer.listWindows(managedSession, signal)).find((window) => window.title === "HarnessProbe-WPS-Doc")!;
      const toWps = await computer.execute(managedSession, {
        actionId: "managed-manual-to-wps" as ActionId,
        basedOn: "managed-manual-before" as ObservationId,
        kind: "switch_window",
        windowRef: wpsOption.windowRef,
      }, signal);
      if (toWps.status !== "completed" || toWps.sessionAfter === undefined) throw new Error("switch to WPS did not return sessionAfter");
      let nativeSession = toWps.sessionAfter;
      const wpsObservation = await computer.observe(nativeSession, "managed-manual-wps-before-dialog" as ObservationId, signal);
      expect(wpsObservation.grounding?.source).toBe("uia");
      expect(collectCount).toBe(1);

      fake.setSecondExtraWindowAfterClick({ pid: 4321, windowId: 9876, appName: "WPS", title: "HarnessProbe-WPS-Dialog", ownerPid: 0, ownerWindowId: 0 });
      const triggerReceipt = await computer.execute(nativeSession, {
        actionId: "managed-manual-dialog-trigger" as ActionId,
        basedOn: "managed-manual-wps-before-dialog" as ObservationId,
        kind: "click",
        point: { x: 40, y: 50 },
      }, signal, { detectNewWindowHandoff: true });
      expect(triggerReceipt.status).toBe("completed");
      const newlySurfaced = await computer.detectNewWindowHandoffCandidates(nativeSession, signal);
      expect(newlySurfaced).toEqual([expect.objectContaining({ pid: 4321, windowId: 9876, appName: "WPS", title: "HarnessProbe-WPS-Dialog" })]);
      const manualCandidates = await computer.listWindowHandoffCandidates(nativeSession, signal);
      const manualCandidate = manualCandidates.find((candidate) => candidate.windowId === 9876)!;
      expect(await computer.listNewWindowHandoffCandidates(nativeSession, signal)).toEqual([manualCandidate]);

      // This direct host method is the adapter's confirmed manual-handoff
      // boundary; Runtime separately owns waiting_window/Enter confirmation.
      nativeSession = await computer.handoffWindow(nativeSession, manualCandidate, signal);
      expect(nativeSession.id).toBe(toWps.sessionAfter.id);
      expect(fake.calls.filter((call) => call.name === "bring_to_front").at(-1)?.input)
        .toMatchObject({ pid: 4321, window_id: 9876 });
      const dialogObservation = await computer.observe(nativeSession, "managed-manual-wps-dialog" as ObservationId, signal);
      expect(dialogObservation.grounding?.source).toBe("uia");
      expect(dialogObservation.viewport).toEqual(nativeSession.viewport);
      expect(collectCount).toBe(1);

      const managedReturnOption = (await computer.listWindows(nativeSession, signal)).find((window) => window.title === "Safe fixture")!;
      const toManaged = await computer.execute(nativeSession, {
        actionId: "managed-manual-return-browser" as ActionId,
        basedOn: "managed-manual-wps-dialog" as ObservationId,
        kind: "switch_window",
        windowRef: managedReturnOption.windowRef,
      }, signal);
      if (toManaged.status !== "completed" || toManaged.sessionAfter === undefined) throw new Error("switch back to managed browser did not return sessionAfter");
      const managedAfter = await computer.observe(toManaged.sessionAfter, "managed-manual-after-dialog" as ObservationId, signal);
      expect(managedAfter.grounding?.source).toBe("hybrid");
      expect(managedAfter.grounding?.observationId).toBe("managed-manual-after-dialog");
      expect(collectCount).toBe(2);
      expect(collectedTargets).toEqual([fake.target, fake.target]);
      await computer.close(toManaged.sessionAfter);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });


  it("calibrates DOM grounding from the macOS AXWebArea content rect", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-macos-web-area-"));
    const fake = windowDriver({ x: 0, y: 0, width: 1568, height: 1181 }, { width: 1568, height: 1181 });
    fake.setGroundingState({
      elements_complete: true,
      elements: [
        { role: "AXWebArea", name: "Apple", frame: { x: 0, y: 114, width: 1568, height: 1067 }, enabled: true },
      ],
    });
    const browserTarget: ManagedBrowserTarget = {
      kind: "managed-chromium",
      browser: "chromium",
      profileId: "fixture-profile",
      windowTarget: fake.target,
      tabId: "tab-fixture",
      generation: "generation-1",
      delivery: "loopback-cdp",
    };
    try {
      const computer = new CuaDriverComputer({
        socketPath: "test-socket",
        screenshotDir: directory,
        windowTarget: fake.target,
        grounding: "hybrid-catalog-v1",
        browserTarget,
        domGroundingTransport: createMockDomGroundingTransport({
          complete: true,
          tabId: "tab-fixture",
          generation: "generation-1",
          coordinateSpace: "css",
          viewportMetrics: { cssWidth: 1568, cssHeight: 1067, deviceScaleFactor: 1 },
          candidates: [{ tagName: "a", name: "Mac 机型比较", frame: { x: 1045, y: 369, width: 111, height: 121 }, visible: true, interactive: true, state: { enabled: true } }],
        }),
        driverFactory: () => fake.driver,
      });
      const session = await computer.open({}, new AbortController().signal);
      const capture = await computer.observe(session, "macos-web-area-observation" as ObservationId, new AbortController().signal);
      expect(capture.grounding?.source).toBe("hybrid");
      expect(capture.grounding?.degraded).toBe(false);
      expect(capture.grounding?.elements.some((element) => element.source === "dom" && element.name === "Mac 机型比较")).toBe(true);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("delivers a DOM-grounded click through managed CDP instead of native coordinates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-dom-click-"));
    const fake = windowDriver({ x: 0, y: 0, width: 1000, height: 800 }, { width: 1000, height: 800 });
    fake.setGroundingState({
      elements_complete: true,
      elements: [
        { role: "Document", frame: { x: 0, y: 0, width: 1000, height: 800 }, enabled: true },
        // Deliberately duplicate the managed DOM candidate. The selected
        // action below uses this UIA ref to reproduce the failed real run.
        { role: "AXLink", name: "Contact user@example.com", frame: { x: 100, y: 100, width: 120, height: 40 }, enabled: true },
      ],
    });
    const browserTarget: ManagedBrowserTarget = {
      kind: "managed-chromium",
      browser: "chromium",
      profileId: "fixture-profile",
      windowTarget: fake.target,
      tabId: "tab-fixture",
      generation: "generation-1",
      delivery: "loopback-cdp",
    };
    const clickRequests: unknown[] = [];
    const transport = createMockDomGroundingTransport({
      complete: true,
      tabId: "tab-fixture",
      generation: "generation-1",
      coordinateSpace: "physical",
      candidates: [{ tagName: "a", name: "Contact user@example.com", frame: { x: 100, y: 100, width: 120, height: 40 }, visible: true, interactive: true, state: { enabled: true } }],
    }) as DomGroundingTransport & { click: NonNullable<DomGroundingTransport["click"]> };
    transport.click = async (request, signal) => {
      signal.throwIfAborted();
      clickRequests.push(request);
      return { status: "completed", tabId: "tab-fixture", generation: "generation-1", message: "dom click fixture" };
    };
    try {
      const computer = new CuaDriverComputer({
        socketPath: "test-socket",
        screenshotDir: directory,
        windowTarget: fake.target,
        grounding: "hybrid-catalog-v1",
        browserTarget,
        domGroundingTransport: transport,
        driverFactory: () => fake.driver,
      });
      const session = await computer.open({}, new AbortController().signal);
      const observationId = "dom-click-observation" as ObservationId;
      const capture = await computer.observe(session, observationId, new AbortController().signal);
      const element = capture.grounding?.elements.find((candidate) => candidate.source === "uia" && candidate.name === "Contact [redacted-email]");
      expect(element?.bbox).toBeDefined();
      const receipt = await computer.execute(session, {
        kind: "click",
        actionId: "dom-click-action" as ActionId,
        basedOn: observationId,
        groundingRef: element!.elementRef,
        point: { x: element!.bbox!.x + element!.bbox!.width / 2, y: element!.bbox!.y + element!.bbox!.height / 2 },
      }, new AbortController().signal);
      expect(receipt).toMatchObject({ status: "completed", message: "dom click fixture" });
      expect(clickRequests).toHaveLength(1);
      expect(clickRequests[0]).toMatchObject({ candidate: { name: "Contact user@example.com" } });
      expect(fake.calls.some((call) => call.name === "click")).toBe(false);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not swallow an AbortError from the UIA query", async () => {
    // Native grounding reads retain their abort semantics.
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-grounding-abort-"));
    const fake = windowDriver();
    fake.setGroundingAbort(true);
    const computer = new CuaDriverComputer({
      socketPath: "test-socket",
      screenshotDir: directory,
      windowTarget: fake.target,
      grounding: "uia-catalog-v1",
      driverFactory: () => fake.driver,
    });
    try {
      const session = await computer.open({}, new AbortController().signal);
      await expect(computer.observe(session, "grounding-abort" as ObservationId, new AbortController().signal)).rejects.toThrow(/grounding aborted/iu);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["win32", "darwin"] as const)("scopes chrome input permission to %s shortcuts and revokes it before focus-changing dispatch", async (platform) => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-focus-shortcuts-"));
    const fake = windowDriver({ x: 0, y: 0, width: 1000, height: 800 }, { width: 1000, height: 800 });
    fake.setPlatform(platform);
    fake.setGroundingState({ elements_complete: true, elements: [
      { role: "Document", frame: { x: 0, y: 80, width: 1000, height: 720 }, enabled: true },
      { role: "Edit", name: "Address and search bar", frame: { x: 100, y: 10, width: 400, height: 30 }, enabled: true, focused: true, editable: true },
    ] });
    const browserTarget: ManagedBrowserTarget = { kind: "managed-chromium", browser: "chromium", profileId: "fixture", windowTarget: fake.target, tabId: "tab", generation: "generation", delivery: "loopback-cdp" };
    const transport = createMockDomGroundingTransport({ complete: true, tabId: "tab", generation: "generation", coordinateSpace: "physical", candidates: [] });
    const computer = new CuaDriverComputer({ socketPath: "test", screenshotDir: directory, platform, windowTarget: fake.target, windowDeliveryMode: "foreground", grounding: "hybrid-catalog-v1", browserTarget, domGroundingTransport: transport, driverFactory: () => fake.driver });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const basedOn = "shortcut-frame" as ObservationId;
      await computer.observe(session, basedOn, signal);
      let id = 0;
      const key = (keys: string[]) => computer.execute(session, { kind: "keypress", actionId: ("shortcut-" + id++) as ActionId, basedOn, keys }, signal);
      const type = () => computer.execute(session, { kind: "type", actionId: ("text-" + id++) as ActionId, basedOn, text: "fixture" }, signal);
      for (const modifier of ["CTRL", "CMD", "META"]) {
        expect(await key([modifier, "L"])).toMatchObject({ status: "completed" });
        const valid = platform === "darwin" ? modifier !== "CTRL" : modifier === "CTRL";
        expect(await type()).toMatchObject({ status: valid ? "completed" : "refused" });
        expect(await type()).toMatchObject({ status: "refused" });
      }
      const modifier = platform === "darwin" ? "CMD" : "CTRL";
      await key([modifier, "L"]);
      await key([modifier, "A"]);
      expect(await type()).toMatchObject({ status: "completed" });
      await key([modifier, "L"]);
      await key([modifier, "F"]);
      const sent = fake.calls.filter((call) => call.name === "type_text").length;
      expect(await type()).toMatchObject({ status: "refused", driverCode: "DOM_INPUT_FOCUS_MISMATCH" });
      expect(fake.calls.filter((call) => call.name === "type_text")).toHaveLength(sent);
      await key([modifier, "L"]);
      const originalCall = fake.driver.callTool.bind(fake.driver);
      const dispatch = vi.spyOn(fake.driver, "callTool").mockImplementation(async (name, ...args) => {
        if (name === "hotkey") throw new Error("unknown shortcut outcome");
        return originalCall(name, ...args);
      });
      await expect(key([modifier, "F"])).rejects.toThrow("unknown shortcut outcome");
      dispatch.mockRestore();
      expect(await type()).toMatchObject({ status: "refused" });
      await computer.close(session);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each(["dom-observed", "dom-live", "uia-missing", "uia-partial", "chrome-changed"] as const)("refuses address-bar typing when positive focus evidence is %s", async (scenario) => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-chrome-focus-proof-"));
    const fake = windowDriver({ x: 0, y: 0, width: 1000, height: 800 }, { width: 1000, height: 800 });
    const document = { role: "Document", frame: { x: 0, y: 80, width: 1000, height: 720 }, enabled: true };
    const address = { role: "Edit", name: "Address and search bar", frame: { x: 100, y: 10, width: 400, height: 30 }, enabled: true, focused: true, editable: true };
    fake.setGroundingState({ elements_complete: true, elements: [document, address] });
    let domFocused = false;
    const browserTarget: ManagedBrowserTarget = { kind: "managed-chromium", browser: "chromium", profileId: "fixture", windowTarget: fake.target, tabId: "tab", generation: "generation", delivery: "loopback-cdp" };
    const transport = createMockDomGroundingTransport(() => ({ complete: true, tabId: "tab", generation: "generation", coordinateSpace: "physical", candidates: [{ tagName: "input", ariaRole: "textbox", inputType: "text", name: "Page input", frame: { x: 100, y: 200, width: 120, height: 40 }, visible: true, interactive: true, state: { enabled: true, editable: true, focused: domFocused } }] }));
    const computer = new CuaDriverComputer({ socketPath: "test", screenshotDir: directory, windowTarget: fake.target, windowDeliveryMode: "foreground", grounding: "hybrid-catalog-v1", browserTarget, domGroundingTransport: transport, driverFactory: () => fake.driver });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      let basedOn = "chrome-proof-before" as ObservationId;
      await computer.observe(session, basedOn, signal);
      expect(await computer.execute(session, { kind: "keypress", actionId: "location-shortcut" as ActionId, basedOn, keys: ["CTRL", "L"] }, signal)).toMatchObject({ status: "completed" });
      if (scenario.startsWith("dom-")) domFocused = true;
      if (scenario === "uia-missing") fake.setGroundingState({ elements_complete: true, elements: [document] });
      if (scenario === "uia-partial") fake.setGroundingState({ elements_complete: false, elements: [document, address] });
      if (scenario === "chrome-changed") fake.setGroundingState({ elements_complete: true, elements: [document, { ...address, name: "Find in page" }] });
      await computer.execute(session, { kind: "wait", actionId: "wait-before-type" as ActionId, durationMs: 1 }, signal);
      if (scenario === "dom-observed") {
        basedOn = "chrome-proof-page-focus" as ObservationId;
        await computer.observe(session, basedOn, signal);
        // Even if focus later moves away, the observed conflict invalidated
        // this intent; type must not adopt the page or reuse chrome permission.
        domFocused = false;
      }
      expect(await computer.execute(session, { kind: "type", actionId: "refused-chrome-text" as ActionId, basedOn, text: "https://example.test/" }, signal)).toMatchObject({ status: "refused", driverCode: "BROWSER_CHROME_FOCUS_UNCONFIRMED" });
      expect(fake.calls.filter((call) => call.name === "type_text")).toHaveLength(0);
      await computer.close(session);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each(["missing", "partial", "ambiguous"] as const)("refuses native UIA content fallback when DOM equivalence is %s", async (scenario) => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-uia-dom-gate-"));
    const fake = windowDriver({ x: 0, y: 0, width: 1000, height: 800 }, { width: 1000, height: 800 });
    fake.setGroundingState({ elements_complete: true, elements: [
      { role: "Document", frame: { x: 0, y: 80, width: 1000, height: 720 }, enabled: true },
      { role: "Button", name: "Continue", frame: { x: 100, y: 200, width: 120, height: 40 }, enabled: true },
    ] });
    const browserTarget: ManagedBrowserTarget = { kind: "managed-chromium", browser: "chromium", profileId: "fixture", windowTarget: fake.target, tabId: "tab", generation: "generation", delivery: "loopback-cdp" };
    const domCandidate = { tagName: "button", ariaRole: "button", name: "Continue", frame: { x: 100, y: 200, width: 120, height: 40 }, visible: true, interactive: true, state: { enabled: true } };
    const transport: DomGroundingTransport = {
      kind: "managed-loopback-cdp-v1",
      collect: async () => ({ complete: scenario !== "partial", tabId: "tab", generation: "generation", coordinateSpace: "physical", candidates: scenario === "missing" ? [] : scenario === "ambiguous" ? [domCandidate, domCandidate] : [domCandidate] }),
      click: vi.fn(async () => ({ status: "completed" as const, tabId: "tab", generation: "generation" })),
    };
    const computer = new CuaDriverComputer({ socketPath: "test", screenshotDir: directory, windowTarget: fake.target, windowDeliveryMode: "foreground", grounding: "hybrid-catalog-v1", browserTarget, domGroundingTransport: transport, driverFactory: () => fake.driver });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const basedOn = "uia-content" as ObservationId;
      const observation = await computer.observe(session, basedOn, signal);
      const candidate = observation.grounding!.elements.find((item) => item.source === "uia" && item.name === "Continue")!;
      expect(await computer.execute(session, { kind: "click", actionId: "uia-fallback" as ActionId, basedOn, groundingRef: candidate.elementRef, point: { x: 160, y: 220 } }, signal)).toMatchObject({ status: "refused", driverCode: "MANAGED_BROWSER_DOM_REQUIRED" });
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(0);
      expect(transport.click).not.toHaveBeenCalled();
      await computer.close(session);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("requires fresh verified focus after Tab and clears page/chrome bindings across peer switches", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-focus-surface-"));
    const fake = windowDriver({ x: 0, y: 0, width: 1000, height: 800 }, { width: 1000, height: 800 });
    fake.setExtraWindow({ pid: 4321, windowId: 8765, appName: "Native", title: "Native fixture" });
    fake.setGroundingState({ elements_complete: true, elements: [{ role: "Document", frame: { x: 0, y: 0, width: 1000, height: 800 }, enabled: true }] });
    const browserTarget: ManagedBrowserTarget = { kind: "managed-chromium", browser: "chromium", profileId: "fixture", windowTarget: fake.target, tabId: "tab", generation: "generation", delivery: "loopback-cdp" };
    let focused: string | undefined = "A";
    const transport: DomGroundingTransport = {
      kind: "managed-loopback-cdp-v1",
      collect: async () => ({ complete: true, tabId: "tab", generation: "generation", coordinateSpace: "physical", candidates: ["A", "B"].map((name, index) => ({ tagName: "input", inputType: "text", ariaRole: "textbox", name, frame: { x: 100, y: 100 + index * 100, width: 120, height: 40 }, visible: true, interactive: true, state: { enabled: true, editable: true, focused: focused === name } })) }),
      verifyFocus: vi.fn(async (request) => ({ status: focused === request.candidate.name ? "completed" as const : "refused" as const, tabId: "tab", generation: "generation", driverCode: "DOM_INPUT_FOCUS_MISMATCH" })),
    };
    const computer = new CuaDriverComputer({ socketPath: "test", screenshotDir: directory, windowTarget: fake.target, windowDeliveryMode: "foreground", windowSwitch: "opened-windows-v1", windowSwitchAllowedTargets: [fake.target, { pid: 4321, windowId: 8765 }], grounding: "hybrid-catalog-v1", browserTarget, domGroundingTransport: transport, driverFactory: () => fake.driver });
    const signal = new AbortController().signal;
    try {
      let session = await computer.open({}, signal);
      let basedOn = "focus-A" as ObservationId;
      await computer.observe(session, basedOn, signal);
      const type = (id: string) => computer.execute(session, { kind: "type", actionId: id as ActionId, basedOn, text: "fixture" }, signal);
      expect(await type("bind-A")).toMatchObject({ status: "completed" });
      expect(await computer.execute(session, { kind: "keypress", actionId: "tab-to-B" as ActionId, basedOn, keys: ["TAB"] }, signal)).toMatchObject({ status: "completed" });
      focused = "B";
      // The old observation still describes A and may not authorize B.
      expect(await type("stale-after-tab")).toMatchObject({ status: "refused" });
      basedOn = "focus-B" as ObservationId;
      await computer.observe(session, basedOn, signal);
      // A failed implicit focus adoption must not stick across observations.
      expect(await type("fresh-after-tab")).toMatchObject({ status: "completed" });
      expect(transport.verifyFocus).toHaveBeenLastCalledWith(expect.objectContaining({ candidate: expect.objectContaining({ name: "B" }) }), signal);
      const switchTo = async (title: string) => {
        const option = (await computer.listWindows(session, signal)).find((item) => item.title === title)!;
        const receipt = await computer.execute(session, { kind: "switch_window", actionId: ("switch-" + title) as ActionId, basedOn, windowRef: option.windowRef }, signal);
        expect(receipt.status).toBe("completed");
        if (receipt.status !== "completed") throw new Error("fixture window switch did not complete");
        session = receipt.sessionAfter!;
        basedOn = ("after-" + title) as ObservationId;
        await computer.observe(session, basedOn, signal);
      };
      await switchTo("Native fixture");
      focused = undefined;
      expect(await type("native-after-page")).toMatchObject({ status: "completed" });
      await switchTo("Safe fixture");
      expect(await type("browser-return-needs-focus")).toMatchObject({ status: "refused" });
      await computer.execute(session, { kind: "keypress", actionId: "chrome-before-switch" as ActionId, basedOn, keys: ["CTRL", "L"] }, signal);
      await switchTo("Native fixture");
      await switchTo("Safe fixture");
      expect(await type("chrome-permission-not-restored")).toMatchObject({ status: "refused" });
      await computer.close(session);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("validates editable DOM/UIA clicks once and gates native typing across fresh observations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-dom-focus-"));
    const fake = windowDriver({ x: 0, y: 0, width: 1000, height: 800 }, { width: 1000, height: 800 });
    fake.setGroundingState({ elements_complete: true, elements: [
      { role: "Document", frame: { x: 0, y: 0, width: 1000, height: 800 }, enabled: true },
      { role: "AXTextField", name: "Query", frame: { x: 100, y: 100, width: 120, height: 40 }, enabled: true, editable: true },
    ] });
    const browserTarget: ManagedBrowserTarget = { kind: "managed-chromium", browser: "chromium", profileId: "fixture", windowTarget: fake.target, tabId: "tab-fixture", generation: "generation-1", delivery: "loopback-cdp" };
    let focus = false;
    const transport: DomGroundingTransport = {
      kind: "managed-loopback-cdp-v1",
      collect: async () => ({ tabId: browserTarget.tabId, generation: browserTarget.generation, coordinateSpace: "physical", complete: true, candidates: [{ tagName: "input", ariaRole: "textbox", inputType: "text", name: "Query", frame: { x: 100, y: 100, width: 120, height: 40 }, visible: true, interactive: true, state: { enabled: true, editable: true, focused: focus } }] }),
      click: vi.fn(async () => { throw new Error("editable input must never dispatch programmatic click"); }),
      validateClick: vi.fn(async () => ({ status: "completed" as const, tabId: browserTarget.tabId, generation: browserTarget.generation })),
      verifyFocus: vi.fn(async () => focus ? ({ status: "completed" as const, tabId: browserTarget.tabId, generation: browserTarget.generation }) : ({ status: "refused" as const, driverCode: "DOM_INPUT_FOCUS_MISMATCH" })),
    };
    try {
      const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target, windowDeliveryMode: "foreground", grounding: "hybrid-catalog-v1", browserTarget, domGroundingTransport: transport, driverFactory: () => fake.driver });
      const signal = new AbortController().signal;
      const session = await computer.open({}, signal);
      let observationId = "focus-initial" as ObservationId;
      const capture = await computer.observe(session, observationId, signal);
      const type = (id: string) => computer.execute(session, { kind: "type", actionId: id as ActionId, basedOn: observationId, text: "query" }, signal);
      expect(await type("unbound-type")).toMatchObject({ status: "refused", driverCode: "DOM_INPUT_FOCUS_MISMATCH" });
      const input = capture.grounding!.elements.find((element) => element.source === "uia" && element.name === "Query")!;
      expect(await computer.execute(session, { kind: "click", actionId: "native-focus-click" as ActionId, basedOn: observationId, groundingRef: input.elementRef, point: { x: 160, y: 120 } }, signal)).toMatchObject({ status: "completed" });
      expect(transport.validateClick).toHaveBeenCalledTimes(1);
      expect(transport.click).not.toHaveBeenCalled();
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(1);
      observationId = "focus-after-click" as ObservationId;
      await computer.observe(session, observationId, signal);
      expect(await type("page-unfocused")).toMatchObject({ status: "refused", driverCode: "DOM_INPUT_FOCUS_MISMATCH" });
      expect(await computer.execute(session, { kind: "keypress", actionId: "escape-unfocused" as ActionId, basedOn: observationId, keys: ["ESC"] }, signal)).toMatchObject({ status: "refused" });
      expect(await type("still-protected")).toMatchObject({ status: "refused" });
      expect(fake.calls.filter((call) => call.name === "type_text")).toHaveLength(0);
      focus = true;
      expect(await type("focused-type")).toMatchObject({ status: "completed" });
      expect(fake.calls.filter((call) => call.name === "type_text")).toHaveLength(1);
      focus = false;
      const refuseShortcut = vi.spyOn(fake.driver, "callTool").mockResolvedValueOnce(result({ isError: true, text: "location bar shortcut refused; no keyboard input was sent" }));
      expect(await computer.execute(session, { kind: "keypress", actionId: "location-bar-refused" as ActionId, basedOn: observationId, keys: ["CTRL", "L"] }, signal)).toMatchObject({ status: "refused" });
      refuseShortcut.mockRestore();
      expect(await type("refused-location-keeps-binding")).toMatchObject({ status: "refused", driverCode: "DOM_INPUT_FOCUS_MISMATCH" });
      expect(await computer.execute(session, { kind: "keypress", actionId: "location-bar" as ActionId, basedOn: observationId, keys: ["CTRL", "L"] }, signal)).toMatchObject({ status: "completed" });
      expect(await type("explicit-location-input")).toMatchObject({ status: "refused", driverCode: "BROWSER_CHROME_FOCUS_UNCONFIRMED" });
      expect(await type("location-permission-consumed")).toMatchObject({ status: "refused", driverCode: "DOM_INPUT_FOCUS_MISMATCH" });
      expect(await computer.execute(session, { kind: "keypress", actionId: "location-enter" as ActionId, basedOn: observationId, keys: ["ENTER"] }, signal)).toMatchObject({ status: "completed" });
      expect(await type("location-mode-ended")).toMatchObject({ status: "refused", driverCode: "DOM_INPUT_FOCUS_MISMATCH" });
      await computer.close(session);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });


  it.each(["background", "validation-refusal", "inventory-failure", "unknown-click"] as const)("keeps editable browser click %s fail-closed without fallback or replay", async (scenario) => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-dom-boundary-"));
    const fake = windowDriver({ x: 0, y: 0, width: 1000, height: 800 }, { width: 1000, height: 800 });
    fake.setGroundingState({ elements_complete: true, elements: [{ role: "Document", frame: { x: 0, y: 0, width: 1000, height: 800 }, enabled: true }] });
    const browserTarget: ManagedBrowserTarget = { kind: "managed-chromium", browser: "chromium", profileId: "fixture", windowTarget: fake.target, tabId: "tab-fixture", generation: "generation-1", delivery: "loopback-cdp" };
    const transport: DomGroundingTransport = {
      kind: "managed-loopback-cdp-v1",
      collect: async () => ({ tabId: browserTarget.tabId, generation: browserTarget.generation, coordinateSpace: "physical", complete: true, candidates: [{ tagName: "input", name: "Query", frame: { x: 100, y: 100, width: 120, height: 40 }, visible: true, interactive: true, state: { enabled: true, editable: true, focused: false } }] }),
      click: vi.fn(async () => ({ status: "completed" as const })),
      validateClick: vi.fn(async () => ({ status: scenario === "validation-refusal" ? "refused" as const : "completed" as const, driverCode: "DOM_CLICK_OCCLUDED", tabId: browserTarget.tabId, generation: browserTarget.generation })),
      verifyFocus: vi.fn(async () => ({ status: "refused" as const, driverCode: "DOM_INPUT_FOCUS_MISMATCH" })),
    };
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target, windowDeliveryMode: scenario === "background" ? "background" : "foreground", grounding: "hybrid-catalog-v1", browserTarget, domGroundingTransport: transport, driverFactory: () => fake.driver });
    try {
      const signal = new AbortController().signal;
      const session = await computer.open({}, signal);
      const observationId = "boundary-observation" as ObservationId;
      const capture = await computer.observe(session, observationId, signal);
      const input = capture.grounding!.elements.find((element) => element.source === "dom" && element.name === "Query")!;
      const originalCall = fake.driver.callTool.bind(fake.driver);
      let attemptedClicks = 0;
      const dispatch = vi.spyOn(fake.driver, "callTool").mockImplementation(async (name, ...args) => {
        if (scenario === "inventory-failure" && name === "list_windows") throw new Error("inventory unavailable");
        if (name === "click") { attemptedClicks += 1; if (scenario === "unknown-click") throw new Error("unknown native click outcome"); }
        return originalCall(name, ...args);
      });
      const click = computer.execute(session, { kind: "click", actionId: "boundary-click" as ActionId, basedOn: observationId, groundingRef: input.elementRef, point: { x: 160, y: 120 } }, signal, { detectNewWindowHandoff: scenario === "inventory-failure" });
      if (scenario === "unknown-click") {
        await expect(click).rejects.toThrow(/unknown native click outcome/);
        expect(await computer.execute(session, { kind: "type", actionId: "after-unknown" as ActionId, basedOn: observationId, text: "blocked" }, signal)).toMatchObject({ status: "refused", driverCode: "DOM_INPUT_FOCUS_MISMATCH" });
        expect(transport.verifyFocus).toHaveBeenCalledTimes(1);
      } else await expect(click).resolves.toMatchObject({ status: "refused" });
      expect(attemptedClicks).toBe(scenario === "unknown-click" ? 1 : 0);
      expect(transport.click).not.toHaveBeenCalled();
      expect(fake.calls.filter((call) => call.name === "type_text")).toHaveLength(0);
      dispatch.mockRestore();
      await computer.close(session);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("maps click, scroll, and drag coordinates from the image viewport to window-local bounds", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-window-coordinate-map-"));
    const fake = windowDriver(
      { x: 100, y: 120, width: 1828, height: 1528 },
      { width: 1568, height: 1310 },
    );
    const computer = new CuaDriverComputer({
      platform: "win32",
      socketPath: "test-socket",
      screenshotDir: directory,
      windowTarget: fake.target,
      windowDeliveryMode: "foreground",
      driverFactory: () => fake.driver,
    });
    try {
      const session = await computer.open({}, new AbortController().signal);
      const observationId = "window-coordinate-map" as ObservationId;
      await computer.observe(session, observationId, new AbortController().signal);

      const click = await computer.execute(session, {
        actionId: "window-coordinate-map-click" as ActionId,
        basedOn: observationId,
        kind: "click",
        point: { x: 444, y: 458 },
      }, new AbortController().signal);
      expect(click.status).toBe("completed");
      expect(fake.calls.find((call) => call.name === "click")?.input).toMatchObject({ x: 518, y: 534 });

      const scroll = await computer.execute(session, {
        actionId: "window-coordinate-map-scroll" as ActionId,
        basedOn: observationId,
        kind: "scroll",
        point: { x: 1567, y: 1309 },
        direction: "down",
        ticks: 1,
      }, new AbortController().signal);
      expect(scroll.status).toBe("completed");
      expect(fake.calls.find((call) => call.name === "scroll")?.input).toMatchObject({ x: 1827, y: 1527 });

      const drag = await computer.execute(session, {
        actionId: "window-coordinate-map-drag" as ActionId,
        basedOn: observationId,
        kind: "drag",
        from: { x: 0, y: 0 },
        to: { x: 1567, y: 1309 },
      }, new AbortController().signal);
      expect(drag.status).toBe("completed");
      expect(fake.calls.find((call) => call.name === "drag")?.input).toMatchObject({
        from_x: 0,
        from_y: 0,
        to_x: 1827,
        to_y: 1527,
      });

      const invalid = await computer.execute(session, {
        actionId: "window-coordinate-map-invalid" as ActionId,
        basedOn: observationId,
        kind: "click",
        point: { x: 1568, y: 1310 },
      }, new AbortController().signal);
      expect(invalid).toMatchObject({ status: "refused", driverCode: "WINDOW_COORDINATE_INVALID" });
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses the decision observation viewport when Runtime supplies a fresh execution observation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-window-coordinate-map-execution-"));
    const fake = windowDriver(
      { x: 100, y: 120, width: 1828, height: 1528 },
      { width: 1568, height: 1310 },
    );
    const computer = new CuaDriverComputer({
      platform: "win32",
      socketPath: "test-socket",
      screenshotDir: directory,
      windowTarget: fake.target,
      windowDeliveryMode: "foreground",
      driverFactory: () => fake.driver,
    });
    try {
      const session = await computer.open({}, new AbortController().signal);
      const decisionObservationId = "window-decision-observation" as ObservationId;
      await computer.observe(session, decisionObservationId, new AbortController().signal);
      fake.setBounds(
        { x: 100, y: 120, width: 1828, height: 1528 },
        { width: 800, height: 600 },
      );
      const executionObservationId = "window-execution-observation" as ObservationId;
      await computer.observe(session, executionObservationId, new AbortController().signal);

      const click = await computer.execute(session, {
        actionId: "window-coordinate-map-fresh-execution" as ActionId,
        basedOn: decisionObservationId,
        kind: "click",
        point: { x: 444, y: 458 },
      }, new AbortController().signal, { executionObservationId });
      expect(click.status).toBe("completed");
      expect(fake.calls.find((call) => call.name === "click")?.input).toMatchObject({ x: 518, y: 534 });
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps foreground window delivery an explicit host choice", async () => {
    // Host delivery choice remains independent of the platform pixel contract.
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-window-foreground-"));
    const fake = windowDriver();
    const computer = new CuaDriverComputer({
      socketPath: "test-socket",
      screenshotDir: directory,
      windowTarget: fake.target,
      windowDeliveryMode: "foreground",
      driverFactory: () => fake.driver,
    });
    try {
      const session = await computer.open({}, new AbortController().signal);
      const observationId = "window-foreground-observation" as ObservationId;
      await computer.observe(session, observationId, new AbortController().signal);
      const receipt = await computer.execute(session, {
        actionId: "window-foreground-click" as ActionId,
        basedOn: observationId,
        kind: "click",
        point: { x: 10, y: 20 },
      }, new AbortController().signal);
      expect(receipt.status).toBe("completed");
      expect(fake.calls.find((call) => call.name === "click")?.input).toMatchObject({ delivery_mode: "foreground" });
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["foreground", "background"] as const)("sends macOS screenshot pixels without a second bounds scale in %s delivery", async (delivery) => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-macos-pixels-"));
    const fake = windowDriver({ x: 0, y: 12, width: 1200, height: 904 }, { width: 1568, height: 1181 });
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target, windowDeliveryMode: delivery, platform: "darwin", driverFactory: () => fake.driver });
    try {
      const signal = new AbortController().signal;
      const session = await computer.open({}, signal);
      const basedOn = "mac-pixel-observation" as ObservationId;
      await computer.observe(session, basedOn, signal);
      expect(await computer.execute(session, { kind: "click", actionId: "mac-pixel-click" as ActionId, basedOn, point: { x: 106, y: 216 } }, signal)).toMatchObject({ status: "completed" });
      expect(fake.calls.find((call) => call.name === "click")?.input).toMatchObject({ x: 106, y: 216, delivery_mode: delivery });
      // The real failed Run sent (81,165) for this screenshot point. CUA owns
      // the backing/resize conversion, so no bounds projection belongs here.
      if (delivery === "foreground") {
        expect(await computer.execute(session, { kind: "scroll", actionId: "mac-pixel-scroll" as ActionId, basedOn, point: { x: 1567, y: 1180 }, direction: "down", ticks: 1 }, signal)).toMatchObject({ status: "completed" });
        expect(fake.calls.find((call) => call.name === "scroll")?.input).toMatchObject({ x: 1567, y: 1180 });
        expect(await computer.execute(session, { kind: "drag", actionId: "mac-pixel-drag" as ActionId, basedOn, from: { x: 106, y: 216 }, to: { x: 1567, y: 1180 } }, signal)).toMatchObject({ status: "completed" });
        expect(fake.calls.find((call) => call.name === "drag")?.input).toMatchObject({ from_x: 106, from_y: 216, to_x: 1567, to_y: 1180 });
      }
      expect(await computer.execute(session, { kind: "click", actionId: "mac-pixel-invalid" as ActionId, basedOn, point: { x: 1568, y: 1181 } }, signal)).toMatchObject({ status: "refused", driverCode: "WINDOW_COORDINATE_INVALID" });
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(1);
      await computer.close(session);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("refuses macOS pointer input when a fresh execution image changes the decision pixel scale", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-macos-pixel-drift-"));
    const fake = windowDriver({ x: 0, y: 12, width: 1200, height: 904 }, { width: 1568, height: 1181 });
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target, windowDeliveryMode: "foreground", platform: "darwin", driverFactory: () => fake.driver });
    try {
      const signal = new AbortController().signal;
      const session = await computer.open({}, signal);
      const basedOn = "mac-pixel-decision" as ObservationId;
      await computer.observe(session, basedOn, signal);
      fake.setBounds({ x: 0, y: 12, width: 1200, height: 904 }, { width: 800, height: 603 });
      const executionObservationId = "mac-pixel-execution" as ObservationId;
      await computer.observe(session, executionObservationId, signal);
      expect(await computer.execute(session, { kind: "click", actionId: "mac-pixel-drift" as ActionId, basedOn, point: { x: 106, y: 216 } }, signal, { executionObservationId })).toMatchObject({ status: "refused", driverCode: "WINDOW_VIEWPORT_CHANGED" });
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(0);
      expect(await computer.execute(session, { kind: "keypress", actionId: "mac-key-no-pixel-scale" as ActionId, basedOn, keys: ["ESC"] }, signal, { executionObservationId })).toMatchObject({ status: "completed" });
      await computer.close(session);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each(["dom", "uia"] as const)("delivers a CSS-grounded editable control selected through %s in macOS PNG pixels after trusted UIA projection", async (source) => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-macos-dom-pixels-"));
    const fake = windowDriver({ x: 0, y: 12, width: 1200, height: 904 }, { width: 1568, height: 1181 });
    fake.setGroundingState({ elements_complete: true, elements: [
      { role: "AXWebArea", frame: { x: 0, y: 112, width: 1200, height: 804 }, enabled: true },
      { role: "AXTextField", name: "Search", frame: { x: 8, y: 168, width: 147, height: 22 }, enabled: true, editable: true },
    ] });
    const browserTarget: ManagedBrowserTarget = { kind: "managed-chromium", browser: "chromium", profileId: "fixture", windowTarget: fake.target, tabId: "tab-fixture", generation: "generation-1", delivery: "loopback-cdp" };
    const transport: DomGroundingTransport = {
      kind: "managed-loopback-cdp-v1",
      collect: async () => ({ tabId: browserTarget.tabId, generation: browserTarget.generation, complete: true, coordinateSpace: "css", viewportMetrics: { cssWidth: 1200, cssHeight: 804, deviceScaleFactor: 2 }, candidates: [{ tagName: "input", ariaRole: "textbox", inputType: "text", name: "Search", frame: { x: 8, y: 56, width: 147, height: 22 }, visible: true, interactive: true, state: { enabled: true, editable: true, focused: false } }] }),
      click: vi.fn(async () => ({ status: "completed" as const })),
      validateClick: vi.fn(async () => ({ status: "completed" as const, tabId: browserTarget.tabId, generation: browserTarget.generation })),
      verifyFocus: vi.fn(async () => ({ status: "refused" as const, driverCode: "DOM_INPUT_FOCUS_MISMATCH" })),
    };
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target, windowDeliveryMode: "foreground", platform: "darwin", grounding: "hybrid-catalog-v1", browserTarget, domGroundingTransport: transport, driverFactory: () => fake.driver });
    try {
      const signal = new AbortController().signal;
      const session = await computer.open({}, signal);
      const basedOn = "mac-dom-projected" as ObservationId;
      const capture = await computer.observe(session, basedOn, signal);
      const input = capture.grounding!.elements.find((element) => element.source === source && element.name === "Search")!;
      const point = { x: input.bbox!.x + input.bbox!.width / 2, y: input.bbox!.y + input.bbox!.height / 2 };
      expect(point.x).toBeCloseTo(106.4933, 3);
      expect(point.y).toBeCloseTo(218.1715, 3);
      expect(await computer.execute(session, { kind: "click", actionId: "mac-dom-input" as ActionId, basedOn, groundingRef: input.elementRef, point }, signal)).toMatchObject({ status: "completed" });
      expect(fake.calls.find((call) => call.name === "click")?.input).toMatchObject({ x: 106, y: 218 });
      expect(transport.validateClick).toHaveBeenCalledTimes(1);
      expect(transport.click).not.toHaveBeenCalled();
      expect(await computer.execute(session, { kind: "type", actionId: "mac-dom-still-guarded" as ActionId, basedOn, text: "A-LINE-FOCUS-001" }, signal)).toMatchObject({ status: "refused", driverCode: "DOM_INPUT_FOCUS_MISMATCH" });
      await computer.close(session);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("refuses an old window action after resize and reobserves the new image viewport", async () => {
    // Window resize still invalidates the geometry binding before input.
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-window-"));
    const fake = windowDriver();
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target, driverFactory: () => fake.driver });
    try {
      const session = await computer.open({}, new AbortController().signal);
      const oldObservation = await computer.observe(session, "window-old" as ObservationId, new AbortController().signal);
      fake.setBounds({ x: 200, y: 160, width: 1040, height: 720 }, { width: 1038, height: 718 });
      const stale = await computer.execute(session, {
        actionId: "window-stale" as ActionId,
        basedOn: "window-old" as ObservationId,
        kind: "click",
        point: { x: 10, y: 20 },
      }, new AbortController().signal);
      expect(stale).toMatchObject({ status: "refused", driverCode: "WINDOW_GEOMETRY_CHANGED" });
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(0);

      const fresh = await computer.observe(session, "window-fresh" as ObservationId, new AbortController().signal);
      expect(fresh.viewport).toEqual({ width: 1038, height: 718, coordinateSpace: "physical" });
      const current = await computer.execute(session, {
        actionId: "window-current" as ActionId,
        basedOn: "window-fresh" as ObservationId,
        kind: "click",
        point: { x: 20, y: 30 },
      }, new AbortController().signal);
      expect(current.status).toBe("completed");
      expect(oldObservation.viewport).toEqual({ width: 958, height: 678, coordinateSpace: "physical" });
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([undefined, "ax_tree_empty", "ax_window_unresolved"] as const)("registers the macOS screenshot ratio before native input and leaves it intact across UIA-only reads (AX status %s)", async (axStatus) => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-macos-registry-"));
    const bounds = { x: 0, y: 12, width: 1200, height: 904 };
    const fake = windowDriver(bounds, { width: 1568, height: 1181 });
    fake.setGroundingState({ elements_complete: true, elements: [{ role: "AXWebArea", frame: { x: 0, y: 112, width: 1200, height: 804 }, enabled: true, name: "private synthetic title" }] });
    const browserTarget: ManagedBrowserTarget = { kind: "managed-chromium", browser: "chromium", profileId: "fixture", windowTarget: fake.target, tabId: "tab-fixture", generation: "generation-1", delivery: "loopback-cdp" };
    let ratio = 1;
    let nativeScreen: { x: number; y: number } | undefined;
    const order: string[] = [];
    const originalVerify = fake.driver.verifyState.bind(fake.driver);
    vi.spyOn(fake.driver, "verifyState").mockImplementation(async (...args) => { order.push("verify-only"); return originalVerify(...args); });
    const originalCall = fake.driver.callTool.bind(fake.driver);
    vi.spyOn(fake.driver, "callTool").mockImplementation(async (name, inputJson, ...args) => {
      const input = JSON.parse(inputJson) as Record<string, unknown>;
      if (name === "get_window_state") {
        if (input.include_screenshot === true) { ratio = 2400 / 1568; order.push("registered-png"); }
        else order.push("uia-only");
      }
      if (name === "click") {
        order.push("click");
        nativeScreen = { x: Number(input.x) * ratio / 2 + bounds.x, y: Number(input.y) * ratio / 2 + bounds.y };
      }
      const value = await originalCall(name, inputJson, ...args);
      if (axStatus !== undefined && name === "get_window_state" && input.include_screenshot === true) {
        return { ...value, degraded: true, structuredJson: JSON.stringify({ ...JSON.parse(value.structuredJson!), degraded: true, degraded_reason: `${axStatus}: synthetic AX-only degradation` }) };
      }
      return value;
    });
    try {
      // Reproduce the old capture's missing registry state: the same PNG is
      // delivered by verify_state, but the pinned driver does not set ratio.
      const legacy = await captureWindow(fake.driver, "legacy-observation-only", { target: fake.target, bounds }, new AbortController().signal, "win32");
      expect(legacy.viewport.width).toBe(1568);
      expect(ratio).toBe(1);
      expect(106 * ratio / 2).toBe(53); // wrong screen point before registration
      const computer = new ProductionCuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target, windowDeliveryMode: "foreground", platform: "darwin", grounding: "hybrid-catalog-v1", browserTarget, domGroundingTransport: createMockDomGroundingTransport({ complete: true, tabId: "tab-fixture", generation: "generation-1", coordinateSpace: "physical", candidates: [] }), driverFactory: () => fake.driver });
      const signal = new AbortController().signal;
      const session = await computer.open({}, signal);
      const basedOn = "registered-observation" as ObservationId;
      await computer.observe(session, basedOn, signal);
      expect(ratio).toBe(2400 / 1568);
      expect(order.slice(-3)).toEqual(["verify-only", "registered-png", "uia-only"]);
      const receipt = await computer.execute(session, { kind: "click", actionId: "registered-point" as ActionId, basedOn, point: { x: 106, y: 218 } }, signal);
      expect(receipt).toMatchObject({ status: "completed" });
      expect(nativeScreen!.x).toBeCloseTo(81.1224, 3);
      expect(nativeScreen!.y).toBeCloseTo(178.8367, 3);
      expect(order.filter((entry) => entry === "click")).toHaveLength(1);
      expect(receipt.message).toContain("source=get_window_state_registered viewport=1568x1181 bounds=1200x904 target=1234/5678 delivery=foreground");
      expect(receipt.message).toContain('point={"x":106,"y":218}');
      expect(receipt.message).not.toContain("private synthetic title");
      await computer.close(session);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each(["missing-png", "refused", "identity", "reported-size", "frame-invalid", "unknown-degraded", "abort", "post-resize"] as const)("fails closed on macOS registered capture %s without returning the old verify PNG", async (failure) => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-macos-registry-refusal-"));
    const fake = windowDriver({ x: 0, y: 12, width: 1200, height: 904 }, { width: 1568, height: 1181 });
    const originalCall = fake.driver.callTool.bind(fake.driver);
    const controller = new AbortController();
    let registeredCalls = 0;
    vi.spyOn(fake.driver, "callTool").mockImplementation(async (name, inputJson, ...args) => {
      const input = JSON.parse(inputJson) as Record<string, unknown>;
      const value = await originalCall(name, inputJson, ...args);
      if (name !== "get_window_state" || input.include_screenshot !== true) return value;
      registeredCalls += 1;
      if (failure === "refused") return result({ isError: true, text: "permission denied" });
      if (failure === "missing-png") return { ...value, images: [] };
      if (failure === "abort") { controller.abort(new Error("registered capture cancelled")); return value; }
      if (failure === "post-resize") { fake.setBounds({ x: 0, y: 12, width: 1201, height: 904 }, { width: 1568, height: 1181 }); return value; }
      const metadata = JSON.parse(value.structuredJson!) as Record<string, unknown>;
      if (failure === "unknown-degraded") return { ...value, degraded: true, structuredJson: JSON.stringify({ ...metadata, degraded: true, degraded_reason: "unknown private title must not be emitted" }) };
      if (failure === "identity") metadata.window_id = 8765;
      if (failure === "reported-size") metadata.screenshot_width = 1200;
      if (failure === "frame-invalid") metadata.screenshot_frame_valid = false;
      return { ...value, structuredJson: JSON.stringify(metadata) };
    });
    const computer = new ProductionCuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target, windowDeliveryMode: "foreground", platform: "darwin", driverFactory: () => fake.driver });
    try {
      await expect(computer.open({}, controller.signal)).rejects.toThrow();
      expect(registeredCalls).toBe(1);
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(0);
      expect(fake.calls.filter((call) => call.name === "verifyState")).toHaveLength(1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("dispatches verified window input primitives and never falls back when a target closes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-window-"));
    const fake = windowDriver();
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target, windowDeliveryMode: "foreground", driverFactory: () => fake.driver });
    try {
      const session = await computer.open({}, new AbortController().signal);
      await computer.observe(session, "window-input" as ObservationId, new AbortController().signal);
      const typed = await computer.execute(session, {
        actionId: "window-type" as ActionId,
        basedOn: "window-input" as ObservationId,
        kind: "type",
        text: "window-target-text",
      }, new AbortController().signal);
      expect(typed).toMatchObject({ status: "completed" });
      expect(fake.calls.find((call) => call.name === "type_text")?.input).toMatchObject({
        target: { kind: "window", pid: 1234, window_id: 5678 },
        text: "window-target-text",
        delivery_mode: "foreground",
      });

      const keypress = await computer.execute(session, {
        actionId: "window-keypress" as ActionId,
        basedOn: "window-input" as ObservationId,
        kind: "keypress",
        keys: ["F2"],
      }, new AbortController().signal);
      expect(keypress).toMatchObject({ status: "completed" });
      expect(fake.calls.find((call) => call.name === "press_key")?.input).toMatchObject({
        target: { kind: "window", pid: 1234, window_id: 5678 },
        key: "F2",
        delivery_mode: "foreground",
      });

      const hotkey = await computer.execute(session, {
        actionId: "window-hotkey" as ActionId,
        basedOn: "window-input" as ObservationId,
        kind: "keypress",
        keys: ["CTRL", "A"],
      }, new AbortController().signal);
      expect(hotkey).toMatchObject({ status: "completed" });
      expect(fake.calls.find((call) => call.name === "hotkey")?.input).toMatchObject({
        target: { kind: "window", pid: 1234, window_id: 5678 },
        keys: ["CTRL", "A"],
        delivery_mode: "foreground",
      });

      const drag = await computer.execute(session, {
        actionId: "window-drag" as ActionId,
        basedOn: "window-input" as ObservationId,
        kind: "drag",
        from: { x: 1, y: 1 },
        to: { x: 20, y: 20 },
      }, new AbortController().signal);
      expect(drag).toMatchObject({ status: "completed" });
      expect(fake.calls.find((call) => call.name === "drag")?.input).toMatchObject({
        target: { kind: "window", pid: 1234, window_id: 5678 },
        delivery_mode: "foreground",
      });

      const scroll = await computer.execute(session, {
        actionId: "window-scroll" as ActionId,
        basedOn: "window-input" as ObservationId,
        kind: "scroll",
        point: { x: 1, y: 1 },
        direction: "down",
        ticks: 1,
      }, new AbortController().signal);
      expect(scroll).toMatchObject({ status: "completed" });
      expect(fake.calls.find((call) => call.name === "scroll")?.input).toMatchObject({
        target: { kind: "window", pid: 1234, window_id: 5678 },
        delivery_mode: "foreground",
      });

      const unsupported = await computer.execute(session, {
        actionId: "window-double-click" as ActionId,
        basedOn: "window-input" as ObservationId,
        kind: "double_click",
        point: { x: 1, y: 1 },
      }, new AbortController().signal);
      expect(unsupported).toMatchObject({ status: "refused", driverCode: "WINDOW_ACTION_UNSUPPORTED" });
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(0);
      const rightClick = await computer.execute(session, {
        actionId: "window-right-click" as ActionId,
        basedOn: "window-input" as ObservationId,
        kind: "right_click",
        point: { x: 1, y: 1 },
      }, new AbortController().signal);
      expect(rightClick).toMatchObject({ status: "refused", driverCode: "WINDOW_ACTION_UNSUPPORTED" });
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(0);

      fake.setMissing(true);
      const closed = await computer.execute(session, {
        actionId: "window-closed" as ActionId,
        basedOn: "window-input" as ObservationId,
        kind: "click",
        point: { x: 1, y: 1 },
      }, new AbortController().signal);
      expect(closed).toMatchObject({ status: "refused", driverCode: "WINDOW_TARGET_NOT_FOUND" });
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(0);
      expect(fake.calls.some((call) => call.name === "get_desktop_state")).toBe(false);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("canonicalizes LF/CRLF multiline to one CR and trusts only same-call CUA value readback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-multiline-uia-"));
    const fake = windowDriver();
    fake.setTypeTextResult({ structuredJson: JSON.stringify({ effect: "confirmed", evidence: [{ kind: "value_readback" }] }) });
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", grounding: "uia-catalog-v1", driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      for (const [index, text] of ["first 123\nsecond 456", "first 123\r\nsecond 456"].entries()) {
        const observationId = `multiline-observation-${index}` as ObservationId;
        const preSnapshotId = `s0000000${index + 1}`;
        fake.setGroundingState({ snapshot_id: preSnapshotId, elements_complete: true, elements: [
          { role: "Document", name: "Document", frame: { x: 140, y: 160, width: 700, height: 420 }, element_token: `private-token-${index}`, enabled: true },
        ] });
        const capture = await computer.observe(session, observationId, signal);
        const elementRef = capture.grounding?.elements[0]?.elementRef;
        expect(elementRef).toBeDefined();
        expect(JSON.stringify(capture)).not.toContain("private-token-");
        const receipt = await computer.execute(session, {
          actionId: `multiline-type-${index}` as ActionId,
          basedOn: observationId,
          kind: "type",
          text,
          ...(elementRef === undefined ? {} : { groundingRef: elementRef }),
        }, signal);
        expect(receipt).toMatchObject({ status: "completed" });
        expect(receipt.message).toContain("same-target read-back");
        expect(JSON.stringify(receipt)).not.toContain("private-token-");
        const operation = fake.calls.filter((call) => call.name === "type_text").at(-1);
        expect(operation?.input).toMatchObject({
          session: session.id,
          pid: fake.target.pid,
          window_id: fake.target.windowId,
          element_token: `private-token-${index}`,
          snapshot_id: preSnapshotId,
          text: text.replace(/\r\n|\r|\n/gu, "\r"),
          delivery_mode: "background",
        });
      }
      expect(fake.calls.filter((call) => call.name === "get_window_state" && call.input?.include_screenshot === false)).toHaveLength(2);
      expect(fake.calls.filter((call) => call.name === "press_key")).toHaveLength(0);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("auto-binds exactly one current Document surface even without focused/editable state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-multiline-auto-"));
    const fake = windowDriver();
    fake.setTypeTextResult({ structuredJson: JSON.stringify({ effect: "confirmed", evidence: [{ kind: "value_readback" }] }) });
    fake.setGroundingState({ snapshot_id: "s00000001", elements_complete: true, elements: [
      { role: "Document", frame: { x: 140, y: 160, width: 700, height: 420 }, element_token: "private-document-token" },
    ] });
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target, windowDeliveryMode: "foreground", grounding: "uia-catalog-v1", driverFactory: () => fake.driver });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "multiline-auto-observation" as ObservationId, signal);
      const receipt = await computer.execute(session, {
        actionId: "multiline-auto-type" as ActionId,
        basedOn: "multiline-auto-observation" as ObservationId,
        kind: "type",
        text: "第一行 123\n第二行 456",
      }, signal);
      expect(receipt.status).toBe("completed");
      expect(fake.calls.find((call) => call.name === "type_text")?.input).toMatchObject({
        element_token: "private-document-token",
        snapshot_id: "s00000001",
        text: "第一行 123\r第二行 456",
        delivery_mode: "background",
      });
      expect(fake.calls.some((call) => call.name === "press_key")).toBe(false);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["linux", "unknown"])("refuses Windows-only multiline canonicalization when CUA platform is %s", async (platform) => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-multiline-platform-"));
    const fake = windowDriver();
    fake.setPlatform(platform);
    fake.setGroundingState({ snapshot_id: "s00000001", elements_complete: true, elements: [
      { role: "Document", name: "Document", frame: { x: 140, y: 160, width: 700, height: 420 }, element_token: "platform-target-token" },
    ] });
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target, windowDeliveryMode: "foreground", grounding: "uia-catalog-v1", driverFactory: () => fake.driver });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "multiline-platform-observation" as ObservationId, signal);
      const receipt = await computer.execute(session, {
        actionId: "multiline-platform-refused" as ActionId,
        basedOn: "multiline-platform-observation" as ObservationId,
        kind: "type",
        text: "first\nsecond",
      }, signal);
      expect(receipt).toMatchObject({ status: "refused", driverCode: "MULTILINE_PLATFORM_UNSUPPORTED" });
      expect(fake.calls.some((call) => call.name === "type_text")).toBe(false);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { name: "no editor", elements: [{ role: "Button", name: "Save", frame: { x: 200, y: 240, width: 120, height: 32 }, element_token: "button-token" }] },
    { name: "ambiguous editors", elements: [
      { role: "Edit", name: "Title", frame: { x: 200, y: 240, width: 220, height: 32 }, element_token: "title-token" },
      { role: "Document", name: "Body", frame: { x: 200, y: 300, width: 600, height: 300 }, element_token: "body-token" },
    ] },
    { name: "explicitly non-editable editor", elements: [{ role: "Document", name: "Read only", frame: { x: 200, y: 240, width: 600, height: 300 }, element_token: "readonly-token", editable: false }] },
  ])("refuses multiline before side effects for $name", async ({ elements }) => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-multiline-refuse-"));
    const fake = windowDriver();
    fake.setGroundingState({ snapshot_id: "s00000001", elements_complete: true, elements });
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target, windowDeliveryMode: "foreground", grounding: "uia-catalog-v1", driverFactory: () => fake.driver });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "multiline-refusal-observation" as ObservationId, signal);
      const receipt = await computer.execute(session, {
        actionId: "multiline-refused" as ActionId,
        basedOn: "multiline-refusal-observation" as ObservationId,
        kind: "type",
        text: "first\nsecond",
      }, signal);
      expect(receipt.status).toBe("refused");
      expect(fake.calls.some((call) => call.name === "type_text" || call.name === "press_key")).toBe(false);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses multiline replacement when the current UIA target is non-empty", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-multiline-nonempty-"));
    const fake = windowDriver();
    fake.setGroundingState({ snapshot_id: "s00000001", elements_complete: true, elements: [
      { role: "Document", name: "Document", frame: { x: 140, y: 160, width: 700, height: 420 }, element_token: "nonempty-token", value: "existing text" },
    ] });
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target, windowDeliveryMode: "foreground", grounding: "uia-catalog-v1", driverFactory: () => fake.driver });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const capture = await computer.observe(session, "multiline-nonempty-observation" as ObservationId, signal);
      const ref = capture.grounding?.elements.find((element) => element.role === "Document")?.elementRef;
      const receipt = await computer.execute(session, {
        actionId: "multiline-nonempty-action" as ActionId,
        basedOn: "multiline-nonempty-observation" as ObservationId,
        kind: "type",
        ...(ref === undefined ? {} : { groundingRef: ref }),
        text: "first\nsecond",
      }, signal);
      expect(receipt).toMatchObject({ status: "refused", driverCode: "MULTILINE_TYPE_INSERTION_UNSUPPORTED" });
      expect(fake.calls.some((call) => call.name === "type_text" || call.name === "press_key")).toBe(false);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses Unicode paragraph separators before dispatch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-multiline-separator-"));
    const fake = windowDriver();
    fake.setGroundingState({ snapshot_id: "s00000001", elements_complete: true, elements: [
      { role: "Document", name: "Document", frame: { x: 140, y: 160, width: 700, height: 420 }, element_token: "separator-target-token" },
    ] });
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target, windowDeliveryMode: "foreground", grounding: "uia-catalog-v1", driverFactory: () => fake.driver });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "multiline-separator-before" as ObservationId, signal);
      const receipt = await computer.execute(session, {
        actionId: "multiline-separator-refused" as ActionId,
        basedOn: "multiline-separator-before" as ObservationId,
        kind: "type",
        text: "first\u2028second",
      }, signal);
      expect(receipt).toMatchObject({ status: "refused", driverCode: "MULTILINE_SEPARATOR_UNSUPPORTED" });
      expect(fake.calls.some((call) => call.name === "type_text")).toBe(false);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns partial when CUA does not provide same-call confirmed value-readback evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-multiline-mismatch-"));
    const fake = windowDriver();
    fake.setGroundingState({ snapshot_id: "s00000001", elements_complete: true, elements: [
      { role: "Document", frame: { x: 140, y: 160, width: 700, height: 420 }, element_token: "mismatch-token" },
    ] });
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target, windowDeliveryMode: "foreground", grounding: "uia-catalog-v1", driverFactory: () => fake.driver });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "multiline-mismatch-observation" as ObservationId, signal);
      const receipt = await computer.execute(session, {
        actionId: "multiline-mismatch-action" as ActionId,
        basedOn: "multiline-mismatch-observation" as ObservationId,
        kind: "type",
        text: "first\nsecond",
      }, signal);
      expect(receipt).toMatchObject({ status: "partial", driverCode: "MULTILINE_TYPE_UNCONFIRMED" });
      expect(fake.calls.filter((call) => call.name === "type_text")).toHaveLength(1);
      expect(fake.calls.some((call) => call.name === "press_key")).toBe(false);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("allows an explicit token-bound target in a partial catalog but refuses partial-catalog auto binding", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-multiline-identity-"));
    const fake = windowDriver();
    const expected = "first\nsecond";
    fake.setTypeTextResult({ structuredJson: JSON.stringify({ effect: "confirmed", evidence: [{ kind: "value_readback" }] }) });
    fake.setGroundingState({ snapshot_id: "s00000001", elements_complete: false, elements: [
      { role: "Document", name: "Body", frame: { x: 140, y: 160, width: 700, height: 420 }, element_token: "target-token" },
      { role: "Edit", name: "Other", frame: { x: 160, y: 590, width: 300, height: 32 }, element_token: "other-token" },
    ] });
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target, windowDeliveryMode: "foreground", grounding: "uia-catalog-v1", driverFactory: () => fake.driver });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const capture = await computer.observe(session, "multiline-identity-before" as ObservationId, signal);
      const ref = capture.grounding?.elements.find((element) => element.name === "Body")?.elementRef;
      expect(ref).toBeDefined();
      const receipt = await computer.execute(session, {
        actionId: "multiline-identity-action" as ActionId,
        basedOn: "multiline-identity-before" as ObservationId,
        kind: "type",
        text: expected,
        ...(ref === undefined ? {} : { groundingRef: ref }),
      }, signal);
      expect(receipt).toMatchObject({ status: "completed" });
      expect(fake.calls.filter((call) => call.name === "type_text")).toHaveLength(1);
      expect(fake.calls.find((call) => call.name === "type_text")?.input).toMatchObject({ element_token: "target-token", text: "first\rsecond" });

      fake.setGroundingState({ snapshot_id: "s00000003", elements_complete: false, elements: [
        { role: "Document", name: "Body", frame: { x: 140, y: 160, width: 700, height: 420 }, element_token: "target-token-2" },
      ] });
      await computer.observe(session, "multiline-incomplete-before" as ObservationId, signal);
      const autoRefused = await computer.execute(session, {
        actionId: "multiline-incomplete-action" as ActionId,
        basedOn: "multiline-incomplete-before" as ObservationId,
        kind: "type",
        text: expected,
      }, signal);
      expect(autoRefused).toMatchObject({ status: "refused", driverCode: "MULTILINE_GROUNDING_INCOMPLETE" });
      expect(fake.calls.filter((call) => call.name === "type_text")).toHaveLength(1);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses explicit elementRefs whose structural selector matches duplicate UIA targets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-multiline-duplicate-selector-"));
    const fake = windowDriver();
    fake.setGroundingState({ snapshot_id: "s00000001", elements_complete: true, elements: [
      { role: "Document", name: "Body", frame: { x: 140, y: 160, width: 700, height: 420 }, element_token: "duplicate-target-token-a" },
      { role: "Document", name: "Body", frame: { x: 140, y: 160, width: 700, height: 420 }, element_token: "duplicate-target-token-b" },
    ] });
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target, windowDeliveryMode: "foreground", grounding: "uia-catalog-v1", driverFactory: () => fake.driver });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const capture = await computer.observe(session, "multiline-duplicate-selector-before" as ObservationId, signal);
      const ref = capture.grounding?.elements[0]?.elementRef;
      const receipt = await computer.execute(session, {
        actionId: "multiline-duplicate-selector-action" as ActionId,
        basedOn: "multiline-duplicate-selector-before" as ObservationId,
        kind: "type",
        text: "first\nsecond",
        ...(ref === undefined ? {} : { groundingRef: ref }),
      }, signal);
      expect(receipt).toMatchObject({ status: "refused", driverCode: "MULTILINE_TARGET_AMBIGUOUS" });
      expect(fake.calls.some((call) => call.name === "type_text")).toBe(false);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("routes an explicitly selected editor among multiple complete-catalog text surfaces", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-multiline-selected-"));
    const fake = windowDriver();
    const expected = "selected 123\nbody 456";
    fake.setTypeTextResult({ structuredJson: JSON.stringify({ effect: "confirmed", evidence: [{ kind: "value_readback" }] }) });
    fake.setGroundingState({ snapshot_id: "s00000001", elements_complete: true, elements: [
      { role: "Edit", name: "Title", frame: { x: 140, y: 160, width: 300, height: 32 }, element_token: "title-token" },
      { role: "Document", name: "Body", frame: { x: 140, y: 220, width: 700, height: 420 }, element_token: "body-token" },
    ] });
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target, windowDeliveryMode: "foreground", grounding: "uia-catalog-v1", driverFactory: () => fake.driver });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const capture = await computer.observe(session, "multiline-selected-before" as ObservationId, signal);
      const ref = capture.grounding?.elements.find((element) => element.name === "Body")?.elementRef;
      expect(ref).toBeDefined();
      const receipt = await computer.execute(session, {
        actionId: "multiline-selected-action" as ActionId,
        basedOn: "multiline-selected-before" as ObservationId,
        kind: "type",
        text: expected,
        ...(ref === undefined ? {} : { groundingRef: ref }),
      }, signal);
      expect(receipt).toMatchObject({ status: "completed" });
      expect(fake.calls.filter((call) => call.name === "get_window_state" && call.input?.include_screenshot === false)).toHaveLength(1);
      expect(fake.calls.find((call) => call.name === "type_text")?.input).toMatchObject({ element_token: "body-token", text: "selected 123\rbody 456" });
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the shared pre-action window baseline for the Runtime post-action handoff diff", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-multiline-handoff-"));
    const fake = windowDriver();
    fake.setTypeTextResult({ structuredJson: JSON.stringify({ effect: "confirmed", evidence: [{ kind: "value_readback" }] }) });
    fake.setGroundingState({ snapshot_id: "s00000001", elements_complete: true, elements: [
      { role: "Document", name: "Document", frame: { x: 140, y: 160, width: 700, height: 420 }, element_token: "handoff-target-token" },
    ] });
    const candidate = { pid: 4321, windowId: 8765, title: "New surface", appName: "Fixture", bounds: { x: 10, y: 20, width: 640, height: 480 } };
    fake.setExtraWindowAfterTypeText(candidate);
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target, windowDeliveryMode: "foreground", grounding: "uia-catalog-v1", driverFactory: () => fake.driver });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "multiline-handoff-before" as ObservationId, signal);
      const receipt = await computer.execute(session, {
        actionId: "multiline-handoff-action" as ActionId,
        basedOn: "multiline-handoff-before" as ObservationId,
        kind: "type",
        text: "first\nsecond",
      }, signal, { detectNewWindowHandoff: true });
      expect(receipt.status).toBe("completed");
      await expect(computer.detectNewWindowHandoffCandidates(session, signal)).resolves.toEqual([{
        pid: candidate.pid,
        windowId: candidate.windowId,
        appName: candidate.appName,
        title: candidate.title,
      }]);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses multiline input when the shared pre-action window inventory fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-multiline-inventory-before-"));
    const fake = windowDriver();
    fake.setGroundingState({ snapshot_id: "s00000001", elements_complete: true, elements: [
      { role: "Document", name: "Document", frame: { x: 140, y: 160, width: 700, height: 420 }, element_token: "inventory-target-token" },
    ] });
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target, windowDeliveryMode: "foreground", grounding: "uia-catalog-v1", driverFactory: () => fake.driver });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "multiline-inventory-before" as ObservationId, signal);
      // `execute` first rediscovers the bound target, then obtains the shared
      // pre-action baseline. Fail exactly the latter inventory read.
      fake.failListWindowsOnCall(fake.getListWindowsCallCount() + 2);
      const receipt = await computer.execute(session, {
        actionId: "multiline-inventory-refused" as ActionId,
        basedOn: "multiline-inventory-before" as ObservationId,
        kind: "type",
        text: "first\nsecond",
      }, signal, { detectNewWindowHandoff: true });
      expect(receipt).toMatchObject({ status: "refused", driverCode: "WINDOW_INVENTORY_UNKNOWN" });
      expect(fake.calls.some((call) => call.name === "type_text")).toBe(false);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps completed-action inventory failure visible to the shared post-action handoff consumer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-multiline-inventory-after-"));
    const fake = windowDriver();
    fake.setTypeTextResult({ structuredJson: JSON.stringify({ effect: "confirmed", evidence: [{ kind: "value_readback" }] }) });
    fake.setGroundingState({ snapshot_id: "s00000001", elements_complete: true, elements: [
      { role: "Document", name: "Document", frame: { x: 140, y: 160, width: 700, height: 420 }, element_token: "post-inventory-target-token" },
    ] });
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target, windowDeliveryMode: "foreground", grounding: "uia-catalog-v1", driverFactory: () => fake.driver });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "multiline-inventory-after" as ObservationId, signal);
      const receipt = await computer.execute(session, {
        actionId: "multiline-inventory-completed" as ActionId,
        basedOn: "multiline-inventory-after" as ObservationId,
        kind: "type",
        text: "first\nsecond",
      }, signal, { detectNewWindowHandoff: true });
      expect(receipt.status).toBe("completed");
      fake.failListWindowsOnCall(fake.getListWindowsCallCount() + 1);
      await expect(computer.detectNewWindowHandoffCandidates(session, signal)).rejects.toMatchObject({ code: "WINDOW_TARGET_REFUSED" });
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("redacts a private UIA token from an unknown driver exception", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-multiline-token-error-"));
    const fake = windowDriver();
    const token = "RAW-PRIVATE-ELEMENT-TOKEN-7331";
    fake.setGroundingState({ snapshot_id: "s00000001", elements_complete: true, elements: [
      { role: "Document", name: "Document", frame: { x: 140, y: 160, width: 700, height: 420 }, element_token: token },
    ] });
    fake.setTypeTextThrownError(new Error(`driver failed for element_token=${token}`));
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target, windowDeliveryMode: "foreground", grounding: "uia-catalog-v1", driverFactory: () => fake.driver });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const capture = await computer.observe(session, "multiline-token-error-before" as ObservationId, signal);
      const ref = capture.grounding?.elements[0]?.elementRef;
      const receipt = await computer.execute(session, {
        actionId: "multiline-token-error-action" as ActionId,
        basedOn: "multiline-token-error-before" as ObservationId,
        kind: "type",
        text: "first\nsecond",
        ...(ref === undefined ? {} : { groundingRef: ref }),
      }, signal);
      expect(receipt).toMatchObject({ status: "partial", driverCode: "MULTILINE_TYPE_UNCONFIRMED" });
      expect(JSON.stringify(receipt)).not.toContain(token);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an old multiline element observation after a fresh snapshot replaces it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-multiline-stale-"));
    const fake = windowDriver();
    fake.setGroundingState({ snapshot_id: "s00000001", elements_complete: true, elements: [
      { role: "Document", frame: { x: 140, y: 160, width: 700, height: 420 }, element_token: "old-private-token" },
    ] });
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target, windowDeliveryMode: "foreground", grounding: "uia-catalog-v1", driverFactory: () => fake.driver });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const old = await computer.observe(session, "multiline-stale-old" as ObservationId, signal);
      const oldRef = old.grounding?.elements[0]?.elementRef;
      await computer.observe(session, "multiline-stale-fresh" as ObservationId, signal);
      const receipt = await computer.execute(session, {
        actionId: "multiline-stale-action" as ActionId,
        basedOn: "multiline-stale-old" as ObservationId,
        kind: "type",
        text: "first\nsecond",
        ...(oldRef === undefined ? {} : { groundingRef: oldRef }),
      }, signal);
      expect(receipt).toMatchObject({ status: "refused", driverCode: "STALE_OBSERVATION" });
      expect(fake.calls.some((call) => call.name === "type_text" || call.name === "press_key")).toBe(false);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps single-line type on the existing foreground path and reports uncertain multiline as partial once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-multiline-result-"));
    const fake = windowDriver();
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target, windowDeliveryMode: "foreground", grounding: "uia-catalog-v1", driverFactory: () => fake.driver });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "single-line-before-multiline" as ObservationId, signal);
      expect(await computer.execute(session, { actionId: "single-line-type" as ActionId, basedOn: "single-line-before-multiline" as ObservationId, kind: "type", text: "single line 123" }, signal)).toMatchObject({ status: "completed" });
      expect(fake.calls.find((call) => call.name === "type_text")?.input).toMatchObject({ text: "single line 123", delivery_mode: "foreground" });

      fake.setGroundingState({ snapshot_id: "s00000001", elements_complete: true, elements: [
        { role: "Document", frame: { x: 140, y: 160, width: 700, height: 420 }, element_token: "uncertain-token" },
      ] });
      await computer.observe(session, "uncertain-multiline-observation" as ObservationId, signal);
      const partial = await computer.execute(session, { actionId: "uncertain-multiline" as ActionId, basedOn: "uncertain-multiline-observation" as ObservationId, kind: "type", text: "first\nsecond" }, signal);
      expect(partial).toMatchObject({ status: "partial", driverCode: "MULTILINE_TYPE_UNCONFIRMED" });
      expect(fake.calls.filter((call) => call.name === "press_key")).toHaveLength(0);
      const noReplay = await computer.execute(session, { actionId: "multiline-no-replay" as ActionId, basedOn: "uncertain-multiline-observation" as ObservationId, kind: "type", text: "first\nsecond" }, signal);
      expect(noReplay).toMatchObject({ status: "refused", driverCode: "OBSERVATION_NOT_FOUND" });
      expect(fake.calls.filter((call) => call.name === "type_text")).toHaveLength(2);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("latches a missing window identity and does not revive when the same ids reappear", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-window-"));
    const fake = windowDriver();
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target, driverFactory: () => fake.driver });
    try {
      let session = await computer.open({}, new AbortController().signal);
      await computer.observe(session, "window-latch-old" as ObservationId, new AbortController().signal);
      fake.setMissing(true);
      const first = await computer.execute(session, {
        actionId: "window-latch-first" as ActionId,
        basedOn: "window-latch-old" as ObservationId,
        kind: "click",
        point: { x: 1, y: 1 },
      }, new AbortController().signal);
      expect(first).toMatchObject({ status: "refused", driverCode: "WINDOW_TARGET_NOT_FOUND" });
      fake.setMissing(false);
      await expect(computer.observe(session, "window-latch-reappear" as ObservationId, new AbortController().signal)).rejects.toThrow(/identity was invalidated/iu);
      const oldAfterReappear = await computer.execute(session, {
        actionId: "window-latch-old-after-reappear" as ActionId,
        basedOn: "window-latch-old" as ObservationId,
        kind: "click",
        point: { x: 1, y: 1 },
      }, new AbortController().signal);
      expect(oldAfterReappear).toMatchObject({ status: "refused", driverCode: "WINDOW_TARGET_INVALIDATED" });
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(0);

      await computer.close(session);
      session = await computer.open({}, new AbortController().signal);
      await computer.observe(session, "window-latch-new" as ObservationId, new AbortController().signal);
      const afterNewSession = await computer.execute(session, {
        actionId: "window-latch-new-click" as ActionId,
        basedOn: "window-latch-new" as ObservationId,
        kind: "click",
        point: { x: 1, y: 1 },
      }, new AbortController().signal);
      expect(afterNewSession.status).toBe("completed");
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(1);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
