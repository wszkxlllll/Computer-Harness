import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CuaDriverLike, ToolResult } from "./cua-sdk-contract.js";
import { installFakeCuaSdkModuleForTests } from "./cua-sdk-test-support.js";
import { cuaSdkVersionForPlatform } from "./cua-sdk-platform.js";
import type { ActionId, ActionIntent, ObservationId } from "@computer-harness/protocol";
import { CuaDriverComputer as ProductionCuaDriverComputer, resolveCapturePlatform, type CuaDriverComputerOptions } from "./cua-driver-computer.js";
import { createMockDomGroundingTransport, type DomGroundingTransport, type ManagedBrowserTarget } from "./dom-grounding.js";
import { captureWindow, captureWindowWithRetry as productionCaptureWindowWithRetry, isLocalWindowsNamedPipeSocket, listWindowInventory, listWindowTargets } from "./window-contract.js";

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

function windowsForegroundRefusalResult(
  targetWindowId: number,
  actualForegroundWindowId: number,
  overrides: Partial<ToolResult> = {},
): Partial<ToolResult> {
  const structuredContent = {
    landed_on_target: false,
    target_hwnd: `0x${targetWindowId.toString(16)}`,
    now_fg_hwnd: `0x${actualForegroundWindowId.toString(16)}`,
    code: "foreground_unavailable",
    effect: "refused",
    raised: true,
    restored: false,
  };
  const rawEnvelope = {
    content: [{ type: "text", text: "foreground_unavailable" }],
    isError: true,
    structuredContent,
  };
  return {
    isError: true,
    errorCode: "foreground_unavailable",
    text: "foreground_unavailable: the exact target remained outside the foreground",
    structuredJson: JSON.stringify(structuredContent),
    rawJson: JSON.stringify(rawEnvelope),
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
  noActivate?: boolean;
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
  let activationRefusalResult: Partial<ToolResult> | undefined;
  let activationLanded = true;
  let activationTargetHwnd: number | undefined;
  let activationForegroundHwnd: number | undefined;
  let foregroundTarget: { pid: number; windowId: number } | undefined;
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
      if (name === "get_screen_size") return result({ structuredJson: JSON.stringify({ width: 1, height: 1 }) });
      if (name === "get_desktop_state") {
        await writeFile(String(input.screenshot_out_file), ONE_BY_ONE_PNG);
        return result({ structuredJson: JSON.stringify({ screenshot_width: 1, screenshot_height: 1 }) });
      }
      if (name === "bring_to_front") {
        return activationRefusal
          ? result({ isError: true, text: "fixture activation refused", ...activationRefusalResult })
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
        return result({ structuredJson: JSON.stringify({
          complete: windowInventoryComplete,
          ...(foregroundTarget === undefined ? {} : {
            foreground_pid: foregroundTarget.pid,
            foreground_window_id: foregroundTarget.windowId,
          }),
          windows: unavailable ? [] : [
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
            ...(extraWindow.noActivate === undefined ? {} : { no_activate: extraWindow.noActivate }),
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
    setActivationRefusal(value: boolean, resultOverrides?: Partial<ToolResult>) {
      activationRefusal = value;
      activationRefusalResult = resultOverrides;
    },
    setActivationLanded(value: boolean) { activationLanded = value; },
    setActivationHandles(targetHwnd: number | undefined, foregroundHwnd: number | undefined) {
      activationTargetHwnd = targetHwnd;
      activationForegroundHwnd = foregroundHwnd;
    },
    setForegroundTarget(value: { pid: number; windowId: number } | undefined) {
      foregroundTarget = value === undefined ? undefined : { ...value };
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
            ...(extra.noActivate === undefined ? {} : { noActivate: extra.noActivate }),
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
            ...(peer.noActivate === undefined ? {} : { noActivate: peer.noActivate }),
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
  it("uses the active CUA session platform ahead of a different host fallback", () => {
    expect(resolveCapturePlatform(undefined, "win32", "darwin")).toBe("win32");
    expect(resolveCapturePlatform(undefined, "darwin", "win32")).toBe("darwin");
    expect(resolveCapturePlatform(undefined, undefined, "darwin")).toBe("darwin");
  });

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
      const candidates = await computer.detectNewWindowHandoffCandidates(session, signal);
      expect(candidates).toEqual([{
        pid: popup.pid, windowId: popup.windowId, appName: popup.appName, title: popup.title,
      }]);
      expect(await computer.listNewWindowHandoffCandidates(session, signal)).toEqual(candidates);
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
      const editor = initial.options.find((window) => window.title === "Draft")!;
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
      const editorRef = refreshed.options.find((window) => window.title === "Draft")!.windowRef;
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

  it("preserves the prior bound browser Surface after a proven exact-target activation refusal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-switch-refusal-preserves-parent-"));
    const fake = windowDriver();
    const editor = { pid: 4321, windowId: 8765, appName: "Editor", title: "Draft" };
    fake.setExtraWindow(editor);
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
      tabId: "fixture-tab",
      generation: "fixture-generation",
      delivery: "loopback-cdp",
    };
    let collectCount = 0;
    const domGroundingTransport = createMockDomGroundingTransport((request) => {
      collectCount += 1;
      return {
        complete: true,
        tabId: request.browserTarget.tabId,
        generation: request.browserTarget.generation,
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
      domGroundingTransport,
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const before = await computer.observe(session, "preserved-browser-before" as ObservationId, signal);
      expect(before.grounding?.source).toBe("hybrid");
      const candidate = (await computer.listWindows(session, signal)).options.find((window) => window.title === editor.title)!;
      fake.setActivationRefusal(true, windowsForegroundRefusalResult(editor.windowId, fake.target.windowId));

      const receipt = await computer.execute(session, {
        actionId: "preserved-browser-refused-switch" as ActionId,
        basedOn: "preserved-browser-before" as ObservationId,
        kind: "switch_window",
        windowRef: candidate.windowRef,
      }, signal);
      expect(receipt).toMatchObject({ status: "refused", driverCode: "WINDOW_ACTIVATION_REFUSED" });
      expect(fake.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(2);

      const fresh = await computer.observe(session, "preserved-browser-after-refusal" as ObservationId, signal);
      expect(fresh.surfaceRef.kind).toBe(before.surfaceRef.kind);
      expect(fresh.surfaceRef.surfaceId).toBe(before.surfaceRef.surfaceId);
      expect(fresh.grounding?.source).toBe("hybrid");
      expect(collectCount).toBe(2);
      const retry = await computer.execute(session, {
        actionId: "preserved-browser-expired-ref" as ActionId,
        basedOn: "preserved-browser-after-refusal" as ObservationId,
        kind: "switch_window",
        windowRef: candidate.windowRef,
      }, signal);
      expect(retry).toMatchObject({ status: "refused", driverCode: "WINDOW_REF_STALE" });
      expect(fake.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(2);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the old browser binding executable when a switch candidate cannot be captured", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-switch-capture-failure-preserves-parent-"));
    const fake = windowDriver();
    const editor = { pid: 4321, windowId: 8765, appName: "Editor", title: "Draft" };
    fake.setExtraWindow(editor);
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
      tabId: "fixture-tab",
      generation: "fixture-generation",
      delivery: "loopback-cdp",
    };
    let collectCount = 0;
    const domGroundingTransport = createMockDomGroundingTransport((request) => {
      collectCount += 1;
      return {
        complete: true,
        tabId: request.browserTarget.tabId,
        generation: request.browserTarget.generation,
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
      domGroundingTransport,
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const before = await computer.observe(session, "capture-failure-browser-before" as ObservationId, signal);
      expect(before.grounding?.source).toBe("hybrid");
      const candidate = (await computer.listWindows(session, signal)).options.find((window) => window.title === editor.title)!;
      const originalVerifyState = fake.driver.verifyState.bind(fake.driver);
      fake.driver.verifyState = async (rawInput, asyncOptions) => {
        const input = rawInput as { windowId?: unknown; window_id?: unknown };
        const windowId = input.windowId ?? input.window_id;
        if (typeof windowId === "bigint" && Number(windowId) === editor.windowId) {
          fake.calls.push({ name: "verifyState-refused", input: { window_id: editor.windowId } });
          return result({ isError: true, errorCode: "screen_capture_unavailable", text: "fixture candidate capture refused" });
        }
        return originalVerifyState(rawInput, asyncOptions);
      };

      const receipt = await computer.execute(session, {
        actionId: "capture-failure-browser-switch" as ActionId,
        basedOn: "capture-failure-browser-before" as ObservationId,
        kind: "switch_window",
        windowRef: candidate.windowRef,
      }, signal);
      fake.driver.verifyState = originalVerifyState;
      expect(receipt).toMatchObject({ status: "failed", driverCode: "WINDOW_CAPTURE_REFUSED" });
      expect(fake.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(2);
      expect(fake.calls.filter((call) => call.name === "verifyState-refused")).toHaveLength(1);

      const fresh = await computer.observe(session, "capture-failure-browser-after" as ObservationId, signal);
      expect(fresh.surfaceRef.kind).toBe(before.surfaceRef.kind);
      expect(fresh.surfaceRef.surfaceId).toBe(before.surfaceRef.surfaceId);
      expect(fresh.grounding?.source).toBe("hybrid");
      expect(collectCount).toBe(2);
      const retry = await computer.execute(session, {
        actionId: "capture-failure-browser-expired-ref" as ActionId,
        basedOn: "capture-failure-browser-after" as ObservationId,
        kind: "switch_window",
        windowRef: candidate.windowRef,
      }, signal);
      expect(retry).toMatchObject({ status: "refused", driverCode: "WINDOW_REF_STALE" });
      expect(fake.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(2);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("activates a listed window while preserving the primary desktop Surface and capture", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-desktop-switch-window-"));
    const fake = windowDriver();
    const editor = { pid: 4_321, windowId: 8_765, appName: "Editor", title: "Draft" };
    fake.setExtraWindow(editor);
    fake.setForegroundTarget({ pid: 9_999, windowId: 9_999 });
    fake.setWindowInventoryComplete(false);
    const browserTarget: ManagedBrowserTarget = {
      kind: "managed-chromium",
      browser: "edge",
      profileId: "fixture-profile",
      windowTarget: fake.target,
      tabId: "fixture-tab",
      generation: "fixture-generation",
      delivery: "loopback-cdp",
    };
    let domCollectCount = 0;
    const domGroundingTransport = createMockDomGroundingTransport((request) => {
      domCollectCount += 1;
      return {
        complete: true,
        tabId: request.browserTarget.tabId,
        generation: request.browserTarget.generation,
        coordinateSpace: "physical",
        candidates: [],
      };
    });
    const computer = new CuaDriverComputer({
      socketPath: "test-socket",
      screenshotDir: directory,
      windowDeliveryMode: "foreground",
      windowSwitch: "opened-windows-v1",
      windowSwitchAllowedTargets: [fake.target, { pid: editor.pid, windowId: editor.windowId }],
      grounding: "hybrid-catalog-v1",
      browserTarget,
      domGroundingTransport,
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const before = await computer.observe(session, "desktop-switch-before" as ObservationId, signal);
      expect(before.surfaceRef.kind).toBe("desktop");
      expect(before.grounding).toBeUndefined();
      const listed = await computer.listWindows(session, signal);
      const browser = listed.options.find((window) => window.appName === "Computer Harness")!;
      expect(listed.options.every((window) => window.isCurrent === false)).toBe(true);

      const browserReceipt = await computer.execute(session, {
        actionId: "desktop-switch-managed-browser" as ActionId,
        basedOn: "desktop-switch-before" as ObservationId,
        kind: "switch_window",
        windowRef: browser.windowRef,
      }, signal);
      expect(browserReceipt).toMatchObject({
        status: "completed",
        message: expect.stringContaining("next observation remains the full primary desktop"),
        sessionAfter: { id: session.id, viewport: session.viewport },
      });
      expect(fake.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(1);
      expect(fake.calls.filter((call) => call.name === "bring_to_front").at(-1)?.input)
        .toMatchObject({ pid: fake.target.pid, window_id: fake.target.windowId });
      expect(fake.calls.some((call) => call.name === "get_window_state")).toBe(false);
      if (browserReceipt.status !== "completed" || browserReceipt.sessionAfter === undefined) {
        throw new Error("desktop-preserving browser activation did not return its current session");
      }
      const afterBrowser = await computer.observe(browserReceipt.sessionAfter, "desktop-switch-after-browser" as ObservationId, signal);
      expect(afterBrowser.surfaceRef).toEqual(before.surfaceRef);
      expect(afterBrowser.surfaceRef.kind).toBe("desktop");
      expect(afterBrowser.grounding).toBeUndefined();
      expect(domCollectCount).toBe(0);

      // The managed companion remains available for native-window Runs, but
      // this desktop Run continues using the full display after activation.
      fake.setForegroundTarget(fake.target);
      const listedAfterBrowser = await computer.listWindows(browserReceipt.sessionAfter, signal);
      const currentBrowser = listedAfterBrowser.options.find((window) => window.appName === "Computer Harness");
      const candidate = listedAfterBrowser.options.find((window) => window.title === "Draft");
      expect(currentBrowser?.isCurrent).toBe(true);
      expect(candidate?.isCurrent).toBe(false);
      expect(candidate).toMatchObject({ appName: "Editor", title: "Draft" });

      const receipt = await computer.execute(browserReceipt.sessionAfter, {
        actionId: "desktop-switch-notepad" as ActionId,
        basedOn: "desktop-switch-after-browser" as ObservationId,
        kind: "switch_window",
        windowRef: candidate!.windowRef,
      }, signal);
      expect(receipt).toMatchObject({ status: "completed", sessionAfter: { id: session.id, viewport: session.viewport } });
      expect(fake.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(2);
      expect(fake.calls.filter((call) => call.name === "bring_to_front").at(-1)?.input)
        .toMatchObject({ pid: editor.pid, window_id: editor.windowId });
      if (receipt.status !== "completed" || receipt.sessionAfter === undefined) {
        throw new Error("desktop-preserving native-app activation did not return its current session");
      }
      const after = await computer.observe(receipt.sessionAfter, "desktop-switch-after-editor" as ObservationId, signal);
      expect(after.surfaceRef).toEqual(before.surfaceRef);
      expect(after.surfaceRef.kind).toBe("desktop");
      expect(after.grounding).toBeUndefined();
      expect(fake.calls.filter((call) => call.name === "get_desktop_state")).toHaveLength(3);
      expect(fake.calls.some((call) => call.name === "get_window_state")).toBe(false);
      expect(fake.calls.some((call) => call.name === "get_accessibility_tree")).toBe(false);
      expect(domCollectCount).toBe(0);

      const click = await computer.execute(receipt.sessionAfter, {
        actionId: "desktop-switch-following-click" as ActionId,
        basedOn: "desktop-switch-after-editor" as ObservationId,
        kind: "click",
        point: { x: 20, y: 30 },
      }, signal);
      expect(click.status).toBe("completed");
      expect(fake.calls.filter((call) => call.name === "click").at(-1)?.input)
        .toMatchObject({ target: { kind: "desktop", display_id: "primary" }, delivery_mode: "foreground" });

      const stale = await computer.execute(receipt.sessionAfter, {
        actionId: "desktop-switch-expired-ref" as ActionId,
        basedOn: "desktop-switch-after-editor" as ObservationId,
        kind: "switch_window",
        windowRef: candidate!.windowRef,
      }, signal);
      expect(stale).toMatchObject({ status: "refused", driverCode: "WINDOW_REF_STALE" });
      expect(fake.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(2);
      await computer.close(receipt.sessionAfter);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses only a fresh exact foreground PID/HWND pair for desktop no-op switching", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-desktop-switch-current-"));
    const fake = windowDriver();
    const editor = { pid: 4_321, windowId: 8_765, appName: "Editor", title: "Draft" };
    fake.setExtraWindow(editor);
    const computer = new CuaDriverComputer({
      socketPath: "test-socket",
      screenshotDir: directory,
      windowDeliveryMode: "foreground",
      windowSwitch: "opened-windows-v1",
      windowSwitchAllowedTargets: [fake.target, { pid: editor.pid, windowId: editor.windowId }],
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const before = await computer.observe(session, "desktop-current-before" as ObservationId, signal);
      const listed = await computer.listWindows(session, signal);
      const candidate = listed.options.find((window) => window.title === "Draft")!;
      // Without both fields, do not infer any listed window is the current one.
      expect(listed.options.every((window) => window.isCurrent === false)).toBe(true);

      // The target becomes foreground after list_windows but before dispatch.
      // A no-op is safe and still goes through Runtime's fresh observation path.
      fake.setForegroundTarget({ pid: editor.pid, windowId: editor.windowId });
      const receipt = await computer.execute(session, {
        actionId: "desktop-current-noop" as ActionId,
        basedOn: "desktop-current-before" as ObservationId,
        kind: "switch_window",
        windowRef: candidate.windowRef,
      }, signal);
      expect(receipt).toMatchObject({
        status: "completed",
        message: expect.stringContaining("already the exact foreground window"),
        sessionAfter: { id: session.id },
      });
      expect(fake.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(0);
      expect(fake.calls.some((call) => call.name === "get_window_state")).toBe(false);
      if (receipt.status !== "completed" || receipt.sessionAfter === undefined) {
        throw new Error("already-foreground no-op did not preserve its Computer session");
      }
      const after = await computer.observe(receipt.sessionAfter, "desktop-current-after" as ObservationId, signal);
      expect(after.surfaceRef).toEqual(before.surfaceRef);
      expect(after.surfaceRef.kind).toBe("desktop");
      await computer.close(receipt.sessionAfter);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("offers and rechecks an exact native-only HWND only for an authorized desktop switch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-native-only-desktop-switch-"));
    const fake = windowDriver();
    const editor = { pid: 4_321, windowId: 8_765, appName: "Editor", title: "Native-only editor", zIndex: 2 };
    fake.setExtraWindow(editor);
    fake.setForegroundTarget(fake.target);
    const baseRelationshipProbe = relationshipProbeFor(fake);
    const nativeOnlyRelationshipProbe = {
      async read(signal: AbortSignal) {
        const snapshot = await baseRelationshipProbe.read();
        return {
          ...snapshot,
          windows: snapshot.windows.map((window) => window.pid === editor.pid && window.windowId === editor.windowId
            ? { ...window, appName: editor.appName, title: editor.title }
            : window),
          foregroundPid: fake.target.pid,
          foregroundWindowId: fake.target.windowId,
        };
      },
    };
    const originalCallTool = fake.driver.callTool.bind(fake.driver);
    fake.driver.callTool = async (name, inputJson, options) => {
      const response = await originalCallTool(name, inputJson, options);
      if (name !== "list_windows" || response.structuredJson === undefined) return response;
      const payload = JSON.parse(response.structuredJson) as {
        windows?: Array<{ pid?: number; window_id?: number }>;
      };
      return {
        ...response,
        structuredJson: JSON.stringify({
          ...payload,
          windows: payload.windows?.filter((window) => window.pid !== editor.pid || window.window_id !== editor.windowId),
        }),
      };
    };
    const computer = new CuaDriverComputer({
      socketPath: "test-socket",
      screenshotDir: directory,
      windowDeliveryMode: "foreground",
      windowSwitch: "opened-windows-v1",
      windowSwitchAllowedTargets: [fake.target, { pid: editor.pid, windowId: editor.windowId }],
      windowRelationshipProbe: nativeOnlyRelationshipProbe,
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const before = await computer.observe(session, "native-only-desktop-before" as ObservationId, signal);
      expect(before.surfaceRef.kind).toBe("desktop");
      const listed = await computer.listWindows(session, signal);
      const candidate = listed.options.find((window) => window.title === editor.title);
      expect(candidate).toMatchObject({ appName: editor.appName, isCurrent: false });
      expect(candidate === undefined ? [] : Object.keys(candidate).sort()).toEqual([
        "appName", "isCurrent", "title", "windowRef",
      ]);

      const switched = await computer.execute(session, {
        actionId: "native-only-desktop-switch" as ActionId,
        basedOn: "native-only-desktop-before" as ObservationId,
        kind: "switch_window",
        windowRef: candidate!.windowRef,
      }, signal);
      expect(switched).toMatchObject({
        status: "completed",
        message: expect.stringContaining("next observation remains the full primary desktop"),
        sessionAfter: { id: session.id, viewport: session.viewport },
      });
      expect(fake.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(1);
      expect(fake.calls.filter((call) => call.name === "bring_to_front").at(-1)?.input)
        .toMatchObject({ pid: editor.pid, window_id: editor.windowId });
      expect(fake.calls.filter((call) => call.name === "verifyState")).toHaveLength(0);
      if (switched.status !== "completed" || switched.sessionAfter === undefined) {
        throw new Error("native-only desktop switch did not preserve its desktop session");
      }
      const afterSwitch = await computer.observe(switched.sessionAfter, "native-only-desktop-after" as ObservationId, signal);
      expect(afterSwitch.surfaceRef).toEqual(before.surfaceRef);
      expect(afterSwitch.surfaceRef.kind).toBe("desktop");
      const refreshedCandidate = (await computer.listWindows(switched.sessionAfter, signal)).options.find((window) => window.title === editor.title)!;

      // A fresh exact relationship check invalidates eligibility if the HWND
      // becomes a known non-activating auxiliary after it was listed.
      fake.setExtraWindow({ ...editor, noActivate: true });
      const refusal = await computer.execute(session, {
        actionId: "native-only-desktop-stale-eligibility" as ActionId,
        basedOn: "native-only-desktop-after" as ObservationId,
        kind: "switch_window",
        windowRef: refreshedCandidate.windowRef,
      }, signal);
      expect(refusal).toMatchObject({ status: "refused", driverCode: "WINDOW_SWITCH_UNAUTHORIZED" });
      expect(fake.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(1);
      expect(fake.calls.filter((call) => call.name === "verifyState")).toHaveLength(0);
      await computer.close(switched.sessionAfter);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps opted-in read-only inventory available when the current Surface is unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-inventory-unavailable-surface-"));
    const fake = windowDriver();
    const editor = { pid: 4_321, windowId: 8_765, appName: "Editor", title: "Fresh peer" };
    fake.setExtraWindow(editor);
    const computer = new CuaDriverComputer({
      socketPath: "test-socket",
      screenshotDir: directory,
      windowTarget: fake.target,
      windowDeliveryMode: "foreground",
      windowSwitch: "opened-windows-v1",
      windowSwitchAllowedTargets: [fake.target, { pid: editor.pid, windowId: editor.windowId }],
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "inventory-unavailable-surface-before" as ObservationId, signal);
      const capturesBeforeInventory = fake.calls.filter((call) => call.name === "verifyState").length;
      fake.setMissing(true);
      await expect(computer.listWindows(session, signal)).rejects.toMatchObject({ code: "WINDOW_TARGET_NOT_FOUND" });

      // The exact bound target is visible again, but its Surface remains
      // unavailable until a fresh capture. Listing stays read-only and does
      // not reactivate or capture another window.
      fake.setMissing(false);
      const listed = await computer.listWindows(session, signal);
      expect(listed.options.some((window) => window.title === editor.title)).toBe(true);
      expect(fake.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(1);
      expect(fake.calls.filter((call) => call.name === "verifyState")).toHaveLength(capturesBeforeInventory);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps single-line desktop typing and refuses the native-window-only multiline path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-desktop-multiline-type-"));
    const fake = windowDriver();
    const computer = new CuaDriverComputer({
      socketPath: "test-socket",
      screenshotDir: directory,
      windowDeliveryMode: "foreground",
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const before = await computer.observe(session, "desktop-type-before" as ObservationId, signal);
      expect(before.surfaceRef.kind).toBe("desktop");
      const singleLine = await computer.execute(session, {
        actionId: "desktop-single-line-type" as ActionId,
        basedOn: "desktop-type-before" as ObservationId,
        kind: "type",
        text: "one line",
      }, signal);
      expect(singleLine.status).toBe("completed");
      expect(fake.calls.filter((call) => call.name === "type_text")).toHaveLength(1);
      expect(fake.calls.filter((call) => call.name === "type_text").at(-1)?.input)
        .toMatchObject({ target: { kind: "desktop", display_id: "primary" }, text: "one line", delivery_mode: "foreground" });

      await computer.observe(session, "desktop-type-after-single" as ObservationId, signal);
      expect(fake.calls.filter((call) => call.name === "get_desktop_state")).toHaveLength(2);
      const multiline = await computer.execute(session, {
        actionId: "desktop-multiline-type" as ActionId,
        basedOn: "desktop-type-after-single" as ObservationId,
        kind: "type",
        text: "line one\nline two",
      }, signal);
      expect(multiline).toMatchObject({ status: "refused", driverCode: "MULTILINE_GROUNDING_UNAVAILABLE" });
      expect(fake.calls.filter((call) => call.name === "type_text")).toHaveLength(1);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses the host-opted-in primary-desktop foreground route for multiline caret typing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-desktop-caret-multiline-"));
    const fake = windowDriver();
    const computer = new CuaDriverComputer({
      socketPath: "test-socket",
      screenshotDir: directory,
      multilineTypeProfile: "foreground-caret-v1",
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    const text = "前缀🙂\r\nsecond line";
    try {
      const session = await computer.open({}, signal);
      const before = await computer.observe(session, "desktop-caret-type-before" as ObservationId, signal);
      expect(before.surfaceRef.kind).toBe("desktop");
      const receipt = await computer.execute(session, {
        actionId: "desktop-caret-type-action" as ActionId,
        basedOn: "desktop-caret-type-before" as ObservationId,
        kind: "type",
        text,
      }, signal);

      expect(receipt.status).toBe("completed");
      expect(fake.calls.filter((call) => call.name === "type_text")).toHaveLength(1);
      expect(fake.calls.find((call) => call.name === "type_text")?.input).toMatchObject({
        target: { kind: "desktop", display_id: "primary" },
        text,
        delivery_mode: "foreground",
      });
      expect(fake.calls.some((call) => call.name === "get_window_state")).toBe(false);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("settles only the final full-desktop frame after successful local Windows foreground type_text", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-desktop-type-settle-"));
    const fake = windowDriver();
    const computer = new CuaDriverComputer({
      socketPath: String.raw`\\.\pipe\computer-harness-pi-local`,
      screenshotDir: directory,
      windowDeliveryMode: "foreground",
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const before = await computer.observe(session, "desktop-type-settle-before" as ObservationId, signal);
      const typeReceipt = await computer.execute(session, {
        actionId: "desktop-type-settle-action" as ActionId,
        basedOn: "desktop-type-settle-before" as ObservationId,
        kind: "type",
        text: "single unchanged payload",
      }, signal);
      expect(typeReceipt).toMatchObject({ status: "completed" });
      const typeCalls = fake.calls.filter((call) => call.name === "type_text");
      expect(typeCalls).toHaveLength(1);
      expect(typeCalls[0]?.input).toMatchObject({
        target: { kind: "desktop", display_id: "primary" },
        text: "single unchanged payload",
        delivery_mode: "foreground",
      });

      const observeStartedAt = performance.now();
      const after = await computer.observe(session, "desktop-type-settle-after" as ObservationId, signal);
      const observeElapsedMs = performance.now() - observeStartedAt;
      const desktopCaptures = fake.calls.filter((call) => call.name === "get_desktop_state");
      expect(observeElapsedMs).toBeGreaterThanOrEqual(1_500);
      expect(desktopCaptures).toHaveLength(3);
      expect(desktopCaptures[1]?.input?.screenshot_out_file).toBe(desktopCaptures[2]?.input?.screenshot_out_file);
      expect(after.surfaceRef).toEqual(before.surfaceRef);
      expect(Buffer.from(after.screenshot.data)).toEqual(ONE_BY_ONE_PNG);
      expect(fake.calls.filter((call) => call.name === "type_text")).toHaveLength(1);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("settles a successful local Windows full-desktop click, regardless of window-delivery preference, but not wait or failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-desktop-click-settle-"));
    const fake = windowDriver();
    const computer = new CuaDriverComputer({
      socketPath: String.raw`\\.\pipe\computer-harness-pi-local`,
      screenshotDir: directory,
      // This option scopes native-window delivery only; desktop requests are
      // explicitly constructed with foreground delivery.
      windowDeliveryMode: "background",
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "desktop-click-settle-before" as ObservationId, signal);
      expect(await computer.execute(session, {
        actionId: "desktop-click-settle-action" as ActionId,
        basedOn: "desktop-click-settle-before" as ObservationId,
        kind: "click",
        point: { x: 10, y: 20 },
      }, signal)).toMatchObject({ status: "completed" });
      expect(fake.calls.find((call) => call.name === "click")?.input).toMatchObject({
        target: { kind: "desktop", display_id: "primary" },
        delivery_mode: "foreground",
      });
      await computer.observe(session, "desktop-click-settle-after" as ObservationId, signal);
      expect(fake.calls.filter((call) => call.name === "get_desktop_state")).toHaveLength(3);

      expect(await computer.execute(session, {
        actionId: "desktop-click-settle-wait" as ActionId,
        kind: "wait",
        durationMs: 0,
      }, signal)).toMatchObject({ status: "completed" });
      await computer.observe(session, "desktop-click-settle-after-wait" as ObservationId, signal);
      expect(fake.calls.filter((call) => call.name === "get_desktop_state")).toHaveLength(4);

      fake.setForegroundRefusal(true, "foreground_unavailable: no input was sent", "WINDOW_FOREGROUND_MISMATCH");
      expect(await computer.execute(session, {
        actionId: "desktop-click-settle-refused" as ActionId,
        basedOn: "desktop-click-settle-after-wait" as ObservationId,
        kind: "click",
        point: { x: 30, y: 40 },
      }, signal)).toMatchObject({ status: "refused", driverCode: "WINDOW_FOREGROUND_MISMATCH" });
      await computer.observe(session, "desktop-click-settle-after-refusal" as ObservationId, signal);
      expect(fake.calls.filter((call) => call.name === "get_desktop_state")).toHaveLength(5);

      fake.setForegroundRefusal(true, "fixture generic driver failure", "GENERIC_FAILURE");
      const genericFailure = await computer.execute(session, {
        actionId: "desktop-click-settle-generic-failure" as ActionId,
        basedOn: "desktop-click-settle-after-refusal" as ObservationId,
        kind: "click",
        point: { x: 50, y: 60 },
      }, signal);
      expect(genericFailure).toMatchObject({ status: "refused", driverCode: "GENERIC_FAILURE" });
      expect(genericFailure).not.toHaveProperty("safeRecovery");
      await computer.observe(session, "desktop-click-settle-after-generic-failure" as ObservationId, signal);
      expect(fake.calls.filter((call) => call.name === "get_desktop_state")).toHaveLength(6);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("re-observes an ambiguous full-desktop action after paint settling without clearing its primitive replay guard", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-desktop-unknown-settle-"));
    const fake = windowDriver();
    const computer = new CuaDriverComputer({
      socketPath: String.raw`\\.\pipe\computer-harness-pi-local`,
      screenshotDir: directory,
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const before = await computer.observe(session, "desktop-unknown-before" as ObservationId, signal);
      fake.setForegroundRefusal(true, "foreground_unavailable: foreground changed after dispatch; outcome is unknown");
      const unknown = await computer.execute(session, {
        actionId: "desktop-unknown-first" as ActionId,
        basedOn: "desktop-unknown-before" as ObservationId,
        kind: "click",
        point: { x: 10, y: 20 },
      }, signal);
      expect(unknown).toMatchObject({
        status: "partial",
        driverCode: "ACTION_OUTCOME_UNKNOWN",
        safeRecovery: { kind: "desktop_surface_reconfirmed", surfaceRef: before.surfaceRef },
      });
      const afterUnknown = await computer.observe(session, "desktop-unknown-fresh" as ObservationId, signal);
      expect(afterUnknown.surfaceRef).toEqual(before.surfaceRef);
      expect(fake.calls.filter((call) => call.name === "get_desktop_state")).toHaveLength(3);
      expect(fake.calls.filter((call) => call.name === "list_windows")).toHaveLength(0);

      await computer.execute(session, { actionId: "desktop-unknown-wait" as ActionId, kind: "wait", durationMs: 0 }, signal);
      await computer.observe(session, "desktop-unknown-after-wait" as ObservationId, signal);
      const samePrimitive = await computer.execute(session, {
        actionId: "desktop-unknown-new-id-same-primitive" as ActionId,
        basedOn: "desktop-unknown-after-wait" as ObservationId,
        kind: "click",
        point: { x: 10, y: 20 },
      }, signal);
      expect(samePrimitive).toMatchObject({ status: "refused", driverCode: "ACTION_OUTCOME_UNKNOWN_RETRY_BLOCKED" });
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(1);

      fake.setForegroundRefusal(false);
      expect(await computer.execute(session, {
        actionId: "desktop-unknown-different-primitive" as ActionId,
        basedOn: "desktop-unknown-after-wait" as ObservationId,
        kind: "click",
        point: { x: 30, y: 40 },
      }, signal)).toMatchObject({ status: "completed" });
      await computer.observe(session, "desktop-unknown-after-alternative" as ObservationId, signal);
      expect(await computer.execute(session, {
        actionId: "desktop-unknown-retry-after-alternative-observed" as ActionId,
        basedOn: "desktop-unknown-after-alternative" as ObservationId,
        kind: "click",
        point: { x: 10, y: 20 },
      }, signal)).toMatchObject({ status: "completed" });
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(3);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not schedule desktop paint settling for an aborted or transport-failed GUI dispatch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-desktop-no-settle-unknown-"));
    const fake = windowDriver();
    const computer = new CuaDriverComputer({
      socketPath: String.raw`\\.\pipe\computer-harness-pi-local`,
      screenshotDir: directory,
      driverFactory: () => fake.driver,
    });
    try {
      const session = await computer.open({}, new AbortController().signal);
      await computer.observe(session, "desktop-no-settle-before" as ObservationId, new AbortController().signal);
      const aborted = new AbortController();
      aborted.abort(new Error("cancel before GUI dispatch"));
      await expect(computer.execute(session, {
        actionId: "desktop-no-settle-abort" as ActionId,
        basedOn: "desktop-no-settle-before" as ObservationId,
        kind: "click",
        point: { x: 10, y: 20 },
      }, aborted.signal)).rejects.toThrow(/cancel before GUI dispatch/u);
      await computer.observe(session, "desktop-no-settle-after-abort" as ObservationId, new AbortController().signal);
      expect(fake.calls.filter((call) => call.name === "get_desktop_state")).toHaveLength(2);

      const callTool = fake.driver.callTool.bind(fake.driver);
      fake.driver.callTool = async (name, inputJson, options) => {
        if (name === "click") throw Object.assign(new Error("fixture transport lost"), { tag: "Transport" });
        return callTool(name, inputJson, options);
      };
      await expect(computer.execute(session, {
        actionId: "desktop-no-settle-transport" as ActionId,
        basedOn: "desktop-no-settle-after-abort" as ObservationId,
        kind: "click",
        point: { x: 10, y: 20 },
      }, new AbortController().signal)).rejects.toThrow(/fixture transport lost/u);
      expect(fake.calls.filter((call) => call.name === "get_desktop_state")).toHaveLength(2);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps a local-pipe-shaped non-Windows desktop type observation immediate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-desktop-type-nonwindows-"));
    const fake = windowDriver();
    const computer = new CuaDriverComputer({
      socketPath: String.raw`\\.\pipe\computer-harness-pi-local`,
      screenshotDir: directory,
      windowDeliveryMode: "foreground",
      platform: "darwin",
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "desktop-type-nonwindows-before" as ObservationId, signal);
      expect(await computer.execute(session, {
        actionId: "desktop-type-nonwindows-action" as ActionId,
        basedOn: "desktop-type-nonwindows-before" as ObservationId,
        kind: "type",
        text: "single line",
      }, signal)).toMatchObject({ status: "completed" });
      await computer.observe(session, "desktop-type-nonwindows-after" as ObservationId, signal);
      expect(fake.calls.filter((call) => call.name === "get_desktop_state")).toHaveLength(2);
      expect(fake.calls.filter((call) => call.name === "type_text")).toHaveLength(1);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("distinguishes proven Windows foreground refusal from generic activation errors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-desktop-switch-fail-"));
    const fake = windowDriver();
    const editor = { pid: 4_321, windowId: 8_765, appName: "Editor", title: "Draft" };
    fake.setExtraWindow(editor);
    fake.setForegroundTarget(fake.target);
    const computer = new CuaDriverComputer({
      socketPath: "test-socket",
      screenshotDir: directory,
      windowDeliveryMode: "foreground",
      windowSwitch: "opened-windows-v1",
      windowSwitchAllowedTargets: [fake.target, { pid: editor.pid, windowId: editor.windowId }],
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "desktop-fail-before" as ObservationId, signal);
      const listed = await computer.listWindows(session, signal);
      const candidate = listed.options.find((window) => window.title === "Draft")!;
      fake.setExtraWindow({ ...editor, noActivate: true });
      const noActivate = await computer.execute(session, {
        actionId: "desktop-noactivate-refused" as ActionId,
        basedOn: "desktop-fail-before" as ObservationId,
        kind: "switch_window",
        windowRef: candidate.windowRef,
      }, signal);
      expect(noActivate).toMatchObject({ status: "refused", driverCode: "WINDOW_SWITCH_NOACTIVATE" });
      expect(fake.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(0);

      fake.setExtraWindow(editor);
      const refreshed = await computer.listWindows(session, signal);
      const refreshedCandidate = refreshed.options.find((window) => window.title === "Draft")!;
      fake.setActivationRefusal(true);
      const unknown = await computer.execute(session, {
        actionId: "desktop-activation-unknown" as ActionId,
        basedOn: "desktop-fail-before" as ObservationId,
        kind: "switch_window",
        windowRef: refreshedCandidate.windowRef,
      }, signal);
      expect(unknown).toMatchObject({ status: "failed", driverCode: "WINDOW_ACTIVATION_REFUSED" });
      expect(unknown.status).not.toBe("completed");
      expect(fake.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(1);
      const fresh = await computer.observe(session, "desktop-fail-after" as ObservationId, signal);
      expect(fresh.surfaceRef.kind).toBe("desktop");
      const staleRetry = await computer.execute(session, {
        actionId: "desktop-activation-unknown-no-replay" as ActionId,
        basedOn: "desktop-fail-after" as ObservationId,
        kind: "switch_window",
        windowRef: refreshedCandidate.windowRef,
      }, signal);
      expect(staleRetry).toMatchObject({ status: "refused", driverCode: "WINDOW_REF_STALE" });
      expect(fake.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(1);

      const proofInventory = await computer.listWindows(session, signal);
      const proofCandidate = proofInventory.options.find((window) => window.title === "Draft")!;
      fake.setActivationRefusal(true, windowsForegroundRefusalResult(editor.windowId, fake.target.windowId));
      const provenRefusal = await computer.execute(session, {
        actionId: "desktop-activation-proven-refusal" as ActionId,
        basedOn: "desktop-fail-after" as ObservationId,
        kind: "switch_window",
        windowRef: proofCandidate.windowRef,
      }, signal);
      expect(provenRefusal).toMatchObject({
        status: "refused",
        driverCode: "WINDOW_ACTIVATION_REFUSED",
        message: expect.stringContaining("Do not type into that target"),
      });
      expect(fake.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(2);

      await computer.observe(session, "desktop-proof-after" as ObservationId, signal);
      const proofStaleRetry = await computer.execute(session, {
        actionId: "desktop-activation-proven-no-replay" as ActionId,
        basedOn: "desktop-proof-after" as ObservationId,
        kind: "switch_window",
        windowRef: proofCandidate.windowRef,
      }, signal);
      expect(proofStaleRetry).toMatchObject({ status: "refused", driverCode: "WINDOW_REF_STALE" });
      expect(fake.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(2);

      await computer.observe(session, "desktop-proof-unknown-after" as ObservationId, signal);
      const degradedCandidate = (await computer.listWindows(session, signal)).options.find((window) => window.title === "Draft")!;
      fake.setActivationRefusal(true, windowsForegroundRefusalResult(editor.windowId, fake.target.windowId, { degraded: true }));
      const degradedRefusal = await computer.execute(session, {
        actionId: "desktop-activation-degraded" as ActionId,
        basedOn: "desktop-proof-unknown-after" as ObservationId,
        kind: "switch_window",
        windowRef: degradedCandidate.windowRef,
      }, signal);
      expect(degradedRefusal).toMatchObject({ status: "failed", driverCode: "WINDOW_ACTIVATION_REFUSED" });
      expect(degradedRefusal.status).not.toBe("refused");

      await computer.observe(session, "desktop-proof-mismatch-after" as ObservationId, signal);
      const mismatchCandidate = (await computer.listWindows(session, signal)).options.find((window) => window.title === "Draft")!;
      fake.setActivationRefusal(true, windowsForegroundRefusalResult(editor.windowId + 1, fake.target.windowId));
      const mismatchedTarget = await computer.execute(session, {
        actionId: "desktop-activation-target-mismatch" as ActionId,
        basedOn: "desktop-proof-mismatch-after" as ObservationId,
        kind: "switch_window",
        windowRef: mismatchCandidate.windowRef,
      }, signal);
      expect(mismatchedTarget).toMatchObject({ status: "failed", driverCode: "WINDOW_ACTIVATION_REFUSED" });
      expect(mismatchedTarget.status).not.toBe("refused");
      expect(fake.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(4);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("expires the desktop observation and never replays when Abort follows bring_to_front", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-desktop-switch-abort-"));
    const fake = windowDriver();
    const editor = { pid: 4_321, windowId: 8_765, appName: "Editor", title: "Draft" };
    fake.setExtraWindow(editor);
    fake.setForegroundTarget(fake.target);
    const computer = new CuaDriverComputer({
      socketPath: "test-socket",
      screenshotDir: directory,
      windowDeliveryMode: "foreground",
      windowSwitch: "opened-windows-v1",
      windowSwitchAllowedTargets: [fake.target, { pid: editor.pid, windowId: editor.windowId }],
      driverFactory: () => fake.driver,
    });
    const abort = new AbortController();
    try {
      const session = await computer.open({}, abort.signal);
      const before = await computer.observe(session, "desktop-abort-before" as ObservationId, abort.signal);
      const listed = await computer.listWindows(session, abort.signal);
      const candidate = listed.options.find((window) => window.title === "Draft")!;
      const originalCallTool = fake.driver.callTool.bind(fake.driver);
      fake.driver.callTool = async (name, argumentsJson, options) => {
        const response = await originalCallTool(name, argumentsJson, options);
        if (name === "bring_to_front") abort.abort();
        return response;
      };

      const receipt = await computer.execute(session, {
        actionId: "desktop-abort-during-activation" as ActionId,
        basedOn: "desktop-abort-before" as ObservationId,
        kind: "switch_window",
        windowRef: candidate.windowRef,
      }, abort.signal);
      expect(receipt).toMatchObject({ status: "failed", driverCode: "WINDOW_SWITCH_OUTCOME_UNKNOWN" });
      expect(receipt.status).not.toBe("completed");
      expect(fake.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(1);

      const fresh = await computer.observe(session, "desktop-abort-after" as ObservationId, new AbortController().signal);
      expect(fresh.surfaceRef).toEqual(before.surfaceRef);
      expect(fresh.surfaceRef.kind).toBe("desktop");
      const replay = await computer.execute(session, {
        actionId: "desktop-abort-no-replay" as ActionId,
        basedOn: "desktop-abort-after" as ObservationId,
        kind: "switch_window",
        windowRef: candidate.windowRef,
      }, new AbortController().signal);
      expect(replay).toMatchObject({ status: "refused", driverCode: "WINDOW_REF_STALE" });
      expect(fake.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(1);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps a known no-activate window available for background switching and actions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-background-noactivate-window-"));
    const fake = windowDriver();
    const candidate: FixtureWindow = {
      pid: 4_321,
      windowId: 8_766,
      appName: "Fixture",
      title: "Background target",
      bounds: { x: 180, y: 140, width: 420, height: 320 },
      zIndex: 2,
      ownerPid: 0,
      ownerWindowId: 0,
      isOnScreen: true,
      minimized: false,
      windowClass: "UnclassifiedOwnedWindow",
      noActivate: true,
    };
    fake.setExtraWindow(candidate);
    fake.setWindowImageSize(candidate.windowId, 418, 318);
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "background", windowSwitch: "opened-windows-v1",
      windowSwitchAllowedTargets: [fake.target, { pid: candidate.pid, windowId: candidate.windowId }],
      windowRelationshipProbe: relationshipProbeFor(fake), driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const parent = await computer.observe(session, "background-noactivate-parent" as ObservationId, signal);
      expect(parent.surfaceRef.kind).toBe("native_window");
      const listed = await computer.listWindows(session, signal);
      const option = listed.options.find((window) => window.title === candidate.title);
      expect(option).toBeDefined();
      const activationsBeforeSwitch = fake.calls.filter((call) => call.name === "bring_to_front").length;
      const switched = await computer.execute(session, {
        actionId: "background-noactivate-switch" as ActionId,
        basedOn: "background-noactivate-parent" as ObservationId,
        kind: "switch_window",
        windowRef: option!.windowRef,
      }, signal);
      expect(switched.status).toBe("completed");
      if (switched.status !== "completed" || switched.sessionAfter === undefined) throw new Error("background switch did not return its exact session");
      expect(fake.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(activationsBeforeSwitch);
      const target = await computer.observe(switched.sessionAfter, "background-noactivate-target" as ObservationId, signal);
      expect(target.viewport).toEqual({ width: 418, height: 318, coordinateSpace: "physical" });
      const click = await computer.execute(switched.sessionAfter, {
        actionId: "background-noactivate-click" as ActionId,
        basedOn: "background-noactivate-target" as ObservationId,
        kind: "click",
        point: { x: 20, y: 30 },
      }, signal);
      expect(click.status).toBe("completed");
      expect(fake.calls.filter((call) => call.name === "click").at(-1)?.input).toMatchObject({
        target: { kind: "window", pid: candidate.pid, window_id: candidate.windowId },
      });
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the old scope until fresh observation proves its identity is gone", async () => {
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
      const selected = windows.options.find((window) => window.title === "Draft")!;
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
        .rejects.toThrow(/target was not found/iu);
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
      const currentRef = (await computer.listWindows(session, signal)).options.find((window) => window.isCurrent)!;
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
      expect(windows.options).toHaveLength(1);
      expect(windows.options[0]).toMatchObject({ appName: "Computer Harness", isCurrent: true });
      expect(windows.options.some((window) => window.title === "Draft")).toBe(false);
      expect(fake.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(1);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps native-only owner rows out of model window lists and manual handoff candidates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-native-only-targets-"));
    const fake = windowDriver();
    const nativeOnlyChild = {
      pid: 4321,
      windowId: 8765,
      appName: "Editor",
      title: "",
      bounds: { x: 160, y: 140, width: 480, height: 360 },
      ownerPid: fake.target.pid,
      ownerWindowId: fake.target.windowId,
      zIndex: 2,
      isOnScreen: true,
      minimized: false,
      windowClass: "FixtureDialog",
    };
    const computer = new CuaDriverComputer({
      socketPath: "test-socket",
      screenshotDir: directory,
      windowTarget: fake.target,
      windowDeliveryMode: "foreground",
      windowSwitch: "opened-windows-v1",
      windowSwitchAllowedTargets: [fake.target],
      windowRelationshipProbe: {
        async read() {
          return {
            source: "win32_relationship_probe" as const,
            complete: true,
            foregroundPid: fake.target.pid,
            foregroundWindowId: fake.target.windowId,
            windows: [
              {
                pid: fake.target.pid,
                windowId: fake.target.windowId,
                ownerPid: 0,
                ownerWindowId: 0,
                zIndex: 1,
                isOnScreen: true,
                minimized: false,
                bounds: { x: 100, y: 120, width: 960, height: 680 },
                windowClass: "FixtureMain",
              },
              nativeOnlyChild,
            ],
          };
        },
      },
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const listed = await computer.listWindows(session, signal);
      expect(listed.options).toHaveLength(1);
      expect(listed.options[0]).toMatchObject({ isCurrent: true });
      expect(listed.options.some((option) => option.title === nativeOnlyChild.title)).toBe(false);
      expect(await computer.listWindowHandoffCandidates(session, signal)).toEqual([]);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retains a registered current Surface when a partial CUA all-windows sample omits a native-present row", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-native-present-current-"));
    const fake = windowDriver();
    const computer = new CuaDriverComputer({
      socketPath: "test-socket",
      screenshotDir: directory,
      windowTarget: fake.target,
      windowDeliveryMode: "foreground",
      windowSwitch: "opened-windows-v1",
      windowSwitchAllowedTargets: [fake.target],
      windowRelationshipProbe: relationshipProbeFor(fake),
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "native-present-current-before" as ObservationId, signal);
      const originalCallTool = fake.driver.callTool.bind(fake.driver);
      fake.driver.callTool = async (name: string, inputJson: string, options?: { signal: AbortSignal }) => {
        const input = JSON.parse(inputJson) as Record<string, unknown>;
        if (name === "list_windows" && input.on_screen_only === false) {
          // Missing completeness attestation is a partial sample. The full
          // native probe still proves the exact current PID/HWND exists.
          return result({ structuredJson: JSON.stringify({ windows: [] }) });
        }
        return originalCallTool(name, inputJson, options);
      };

      const listed = await computer.listWindows(session, signal);
      expect(listed.options).toEqual([]);
      const receipt = await computer.execute(session, {
        actionId: "native-present-current-click" as ActionId,
        basedOn: "native-present-current-before" as ObservationId,
        kind: "click",
        point: { x: 12, y: 18 },
      }, signal);
      expect(receipt.status).toBe("completed");
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(1);
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
      expect(candidates).toEqual([]);
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

  it("offers a complete exact-owned current foreground peer only as an explicit manual handoff", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-unscoped-owned-foreground-peer-"));
    const fake = windowDriver();
    const candidate: FixtureWindow = {
      pid: 9_877,
      windowId: 8_765,
      appName: "WPS Writer",
      title: "New document",
      bounds: { x: 240, y: 180, width: 720, height: 560 },
      zIndex: 2,
      ownerPid: fake.target.pid,
      ownerWindowId: fake.target.windowId,
      isOnScreen: true,
      minimized: false,
      windowClass: "WPSMainFrame",
      // The native producer may not report WS_EX_NOACTIVATE on legacy or
      // non-Windows inventories. Undefined remains compatible with those
      // snapshots; only an explicit true fact blocks foreground activation.
    };
    fake.setWindowImageSize(candidate.windowId, 718, 558);
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", windowSwitch: "opened-windows-v1",
      windowSwitchAllowedTargets: [fake.target],
      windowRelationshipProbe: relationshipProbeFor(fake), driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const parent = await computer.observe(session, "unscoped-owned-peer-parent" as ObservationId, signal);
      fake.setExtraWindow(candidate);
      fake.setForegroundRefusal(true);
      expect(await computer.execute(session, {
        actionId: "unscoped-owned-peer-refusal" as ActionId,
        basedOn: "unscoped-owned-peer-parent" as ObservationId,
        kind: "click",
        point: { x: 12, y: 18 },
      }, signal)).toMatchObject({ status: "refused", driverCode: "WINDOW_FOREGROUND_MISMATCH" });

      const activationsBeforeList = fake.calls.filter((call) => call.name === "bring_to_front").length;
      const candidates = await computer.listWindowHandoffCandidates(session, signal);
      expect(candidates).toEqual([{
        pid: candidate.pid,
        windowId: candidate.windowId,
        appName: candidate.appName,
        title: candidate.title,
        relationship: {
          kind: "owned_child",
          owner: { pid: fake.target.pid, windowId: fake.target.windowId },
        },
      }]);
      expect(fake.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(activationsBeforeList);
      expect(fake.calls.filter((call) => call.name === "get_window_state" && call.input?.window_id === candidate.windowId)).toHaveLength(0);

      // Listing leaves the parent Surface intact; only the existing explicit
      // handoff confirmation may activate the fresh peer.
      const selected = await computer.handoffWindow(session, candidates[0]!, signal);
      expect(selected.id).toBe(session.id);
      expect(fake.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(activationsBeforeList + 1);
      expect(fake.calls.filter((call) => call.name === "bring_to_front").at(-1)?.input).toMatchObject({
        pid: candidate.pid,
        window_id: candidate.windowId,
      });
      const selectedObservation = await computer.observe(selected, "unscoped-owned-peer-selected" as ObservationId, signal);
      expect(selectedObservation.surfaceRef.kind).toBe("native_window");
      expect(selectedObservation.surfaceRef.parentSurfaceId).toBeUndefined();
      expect(selectedObservation.surfaceTransitionReason).toBe("peer_switch");
      await computer.close(selected);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["no-activate", "native-only", "partial", "conflict", "not-foreground"] as const)(
    "does not offer an out-of-scope owned peer without complete foreground/CUA evidence (%s)", async (scenario) => {
      const directory = await mkdtemp(join(tmpdir(), `computer-harness-cua-owned-peer-${scenario}-`));
      const fake = windowDriver();
      const candidate: FixtureWindow = {
        pid: 9_877,
        windowId: 8_765,
        appName: "WPS Writer",
        title: "New document",
        bounds: { x: 240, y: 180, width: 720, height: 560 },
        zIndex: 2,
        ownerPid: fake.target.pid,
        ownerWindowId: fake.target.windowId,
        isOnScreen: true,
        minimized: false,
        windowClass: "WPSMainFrame",
        ...(scenario === "no-activate" ? { noActivate: true } : {}),
      };
      const baseProbe = relationshipProbeFor(fake, scenario !== "partial");
      const probe = {
        async read() {
          const snapshot = await baseProbe.read();
          const foregroundIsParent = scenario === "not-foreground";
          return {
            ...snapshot,
            ...(scenario === "conflict"
              ? { windows: snapshot.windows.map((window) => window.windowId === candidate.windowId
                ? { ...window, ownerPid: candidate.pid + 1 }
                : window) }
              : {}),
            ...(foregroundIsParent
              ? { foregroundPid: fake.target.pid, foregroundWindowId: fake.target.windowId }
              : {}),
          };
        },
      };
      const computer = new CuaDriverComputer({
        socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
        windowDeliveryMode: "foreground", windowSwitch: "opened-windows-v1",
        windowSwitchAllowedTargets: [fake.target],
        windowRelationshipProbe: probe, driverFactory: () => fake.driver,
      });
      const signal = new AbortController().signal;
      try {
        const session = await computer.open({}, signal);
        await computer.observe(session, `owned-peer-${scenario}-parent` as ObservationId, signal);
        fake.setExtraWindow(candidate);
        if (scenario === "native-only") {
          const originalCallTool = fake.driver.callTool.bind(fake.driver);
          fake.driver.callTool = async (name: string, inputJson: string, options?: { signal: AbortSignal }) => {
            const response = await originalCallTool(name, inputJson, options);
            if (name !== "list_windows" || response.structuredJson === undefined) return response;
            const structured = JSON.parse(response.structuredJson) as { windows?: readonly Record<string, unknown>[] };
            return result({ structuredJson: JSON.stringify({
              ...structured,
              windows: (structured.windows ?? []).filter((window) => window.window_id !== candidate.windowId),
            }) });
          };
        }
        fake.setForegroundRefusal(true);
        expect(await computer.execute(session, {
          actionId: `owned-peer-${scenario}-refusal` as ActionId,
          basedOn: `owned-peer-${scenario}-parent` as ObservationId,
          kind: "click",
          point: { x: 12, y: 18 },
        }, signal)).toMatchObject({ status: "refused", driverCode: "WINDOW_FOREGROUND_MISMATCH" });

        const activationsBeforeRefresh = fake.calls.filter((call) => call.name === "bring_to_front").length;
        await expect(computer.listWindowHandoffCandidates(session, signal))
          .rejects.toMatchObject({ code: "WINDOW_SCOPE_REQUIRED" });
        expect(fake.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(activationsBeforeRefresh);
        expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(1);
        await computer.close(session);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(["no-activate-drift", "cua-membership-drift"] as const)(
    "rechecks foreground-owned peer eligibility before explicit activation (%s)", async (scenario) => {
      const directory = await mkdtemp(join(tmpdir(), `computer-harness-cua-owned-peer-refresh-${scenario}-`));
      const fake = windowDriver();
      const candidate: FixtureWindow = {
        pid: 9_877,
        windowId: 8_765,
        appName: "WPS Writer",
        title: "New document",
        bounds: { x: 240, y: 180, width: 720, height: 560 },
        zIndex: 2,
        ownerPid: fake.target.pid,
        ownerWindowId: fake.target.windowId,
        isOnScreen: true,
        minimized: false,
        windowClass: "WPSMainFrame",
      };
      fake.setWindowImageSize(candidate.windowId, 718, 558);
      const computer = new CuaDriverComputer({
        socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
        windowDeliveryMode: "foreground", windowSwitch: "opened-windows-v1",
        windowSwitchAllowedTargets: [fake.target],
        windowRelationshipProbe: relationshipProbeFor(fake), driverFactory: () => fake.driver,
      });
      const signal = new AbortController().signal;
      try {
        const session = await computer.open({}, signal);
        await computer.observe(session, `owned-peer-refresh-${scenario}-parent` as ObservationId, signal);
        fake.setExtraWindow(candidate);
        fake.setForegroundRefusal(true);
        expect(await computer.execute(session, {
          actionId: `owned-peer-refresh-${scenario}-refusal` as ActionId,
          basedOn: `owned-peer-refresh-${scenario}-parent` as ObservationId,
          kind: "click",
          point: { x: 12, y: 18 },
        }, signal)).toMatchObject({ status: "refused", driverCode: "WINDOW_FOREGROUND_MISMATCH" });
        const candidateFromList = (await computer.listWindowHandoffCandidates(session, signal))[0]!;
        const activationsBeforeHandoff = fake.calls.filter((call) => call.name === "bring_to_front").length;

        if (scenario === "no-activate-drift") {
          fake.setExtraWindow({ ...candidate, noActivate: true });
        } else {
          const originalCallTool = fake.driver.callTool.bind(fake.driver);
          let omitNextVisibleCandidate = true;
          let omittedVisibleCandidate = false;
          fake.driver.callTool = async (name: string, inputJson: string, options?: { signal: AbortSignal }) => {
            const input = JSON.parse(inputJson) as Record<string, unknown>;
            const response = await originalCallTool(name, inputJson, options);
            if (name !== "list_windows" || input.pid !== undefined || input.on_screen_only !== true || !omitNextVisibleCandidate || response.structuredJson === undefined) {
              return response;
            }
            omitNextVisibleCandidate = false;
            const structured = JSON.parse(response.structuredJson) as { windows?: readonly Record<string, unknown>[] };
            omittedVisibleCandidate = (structured.windows ?? []).some((window) => window.window_id === candidate.windowId);
            return result({ structuredJson: JSON.stringify({
              ...structured,
              windows: (structured.windows ?? []).filter((window) => window.window_id !== candidate.windowId),
            }) });
          };
          const handoff = computer.handoffWindow(session, candidateFromList, signal);
          let error: unknown;
          try { await handoff; } catch (caught) { error = caught; }
          expect(omittedVisibleCandidate).toBe(true);
          expect(error).toMatchObject({ code: "WINDOW_HANDOFF_STALE" });
        }
        if (scenario === "no-activate-drift") {
          await expect(computer.handoffWindow(session, candidateFromList, signal))
            .rejects.toMatchObject({ code: "WINDOW_SWITCH_UNAUTHORIZED" });
        }
        expect(fake.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(activationsBeforeHandoff);
        expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(1);
        await computer.close(session);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

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
      expect(await computer.detectNewWindowHandoffCandidates(session, signal)).toEqual([]);
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

      const nativeOption = (await computer.listWindows(session, signal)).options.find((window) => window.title === "Personal profile")!;
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

      const managedOption = (await computer.listWindows(toNative.sessionAfter, signal)).options.find((window) => window.title === "Safe fixture")!;
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

  it.each([
    {
      label: "partial-dispatch-prefix",
      message: "foreground_input_outcome_unknown: SendInput began before exact foreground drift",
      errorCode: "GENERIC_FAILURE",
      expectedStatus: "partial",
      expectedDriverCode: "ACTION_OUTCOME_UNKNOWN",
      outcomeUnknown: true,
    },
    {
      label: "firstzero-explicit-no-input",
      message: "foreground_unavailable: exact target HWND not active; no mouse input was sent",
      errorCode: "GENERIC_FAILURE",
      expectedStatus: "refused",
      expectedDriverCode: "WINDOW_FOREGROUND_MISMATCH",
      outcomeUnknown: false,
    },
    {
      label: "unrecognized-error",
      message: "fixture generic driver failure",
      errorCode: "GENERIC_FAILURE",
      expectedStatus: "refused",
      expectedDriverCode: "GENERIC_FAILURE",
      outcomeUnknown: false,
    },
  ] as const)("classifies foreground errors safely: $label", async ({
    label,
    message,
    errorCode,
    expectedStatus,
    expectedDriverCode,
    outcomeUnknown,
  }) => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-foreground-prefix-"));
    const fake = windowDriver();
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", windowRelationshipProbe: relationshipProbeFor(fake), driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const beforeId = `foreground-${label}-before` as ObservationId;
      await computer.observe(session, beforeId, signal);
      fake.setForegroundRefusal(true, message, errorCode);
      const receipt = await computer.execute(session, {
        actionId: `foreground-${label}-action` as ActionId,
        basedOn: beforeId,
        kind: "click",
        point: { x: 10, y: 20 },
      }, signal);
      expect(receipt).toMatchObject({ status: expectedStatus, driverCode: expectedDriverCode });

      if (outcomeUnknown) {
        expect(receipt.status).not.toBe("refused");
        expect(receipt.message).toContain("Do not repeat this action");
        const freshId = `foreground-${label}-fresh` as ObservationId;
        await computer.observe(session, freshId, signal);
        const replay = await computer.execute(session, {
          actionId: `foreground-${label}-replay` as ActionId,
          basedOn: freshId,
          kind: "click",
          point: { x: 10, y: 20 },
        }, signal);
        expect(replay).toMatchObject({ status: "refused", driverCode: "ACTION_OUTCOME_UNKNOWN_RETRY_BLOCKED" });
      }
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(1);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["result", "thrown-tool"] as const)("marks post-dispatch foreground uncertainty unknown and invalidates the old action (%s)", async (delivery) => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-foreground-ambiguous-"));
    const fake = windowDriver();
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", windowRelationshipProbe: relationshipProbeFor(fake), driverFactory: () => fake.driver,
    });
    try {
      const signal = new AbortController().signal;
      const session = await computer.open({}, signal);
      const parent = await computer.observe(session, "ambiguous-refusal-observation" as ObservationId, signal);
      fake.setForegroundRefusal(true, "foreground_unavailable: exact target HWND not active", "WINDOW_FOREGROUND_MISMATCH");
      if (delivery === "thrown-tool") {
        const callTool = fake.driver.callTool.bind(fake.driver);
        fake.driver.callTool = async (name, input) => {
          const response = await callTool(name, input);
          if (name === "click" && response.isError) {
            throw Object.assign(new Error(response.text), {
              tag: "Tool",
              inner: { message: response.text, errorCode: response.errorCode },
            });
          }
          return response;
        };
      }
      expect(await computer.execute(session, {
        actionId: `ambiguous-refusal-click-${delivery}` as ActionId,
        basedOn: "ambiguous-refusal-observation" as ObservationId,
        kind: "click",
        point: { x: 10, y: 20 },
      }, signal, { detectNewWindowHandoff: true })).toMatchObject({
        status: "partial",
        driverCode: "ACTION_OUTCOME_UNKNOWN",
        message: expect.stringContaining("Do not repeat this action"),
        safeRecovery: { kind: "native_surface_reconfirmed" },
      });
      const replay = await computer.execute(session, {
        actionId: `ambiguous-refusal-replay-${delivery}` as ActionId,
        basedOn: "ambiguous-refusal-observation" as ObservationId,
        kind: "click",
        point: { x: 10, y: 20 },
      }, signal);
      expect(replay).toMatchObject({ status: "refused", driverCode: "OBSERVATION_NOT_FOUND" });
      const fresh = await computer.observe(session, `ambiguous-refusal-fresh-${delivery}` as ObservationId, signal);
      expect(fresh.surfaceRef.surfaceId).toBe(parent.surfaceRef.surfaceId);
      const samePrimitive = await computer.execute(session, {
        point: { y: 20, x: 10 },
        kind: "click",
        basedOn: `ambiguous-refusal-fresh-${delivery}` as ObservationId,
        actionId: `ambiguous-refusal-same-primitive-${delivery}` as ActionId,
      } as ActionIntent, signal);
      expect(samePrimitive).toMatchObject({ status: "refused", driverCode: "ACTION_OUTCOME_UNKNOWN_RETRY_BLOCKED" });
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(1);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the unknown-action replay guard through wait and failed alternatives, then clears it after a successful alternative and fresh observe", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-unknown-replay-guard-"));
    const fake = windowDriver();
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", windowRelationshipProbe: relationshipProbeFor(fake), driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "unknown-guard-start" as ObservationId, signal);
      fake.setForegroundRefusal(true, "foreground_unavailable: foreground changed while dispatching; input outcome unknown");
      const initial = await computer.execute(session, {
        actionId: "unknown-guard-first" as ActionId,
        basedOn: "unknown-guard-start" as ObservationId,
        kind: "click",
        point: { x: 10, y: 20 },
      }, signal, { detectNewWindowHandoff: true });
      expect(initial).toMatchObject({ status: "partial", safeRecovery: { kind: "native_surface_reconfirmed" } });
      await computer.observe(session, "unknown-guard-observe-1" as ObservationId, signal);
      await computer.execute(session, { actionId: "unknown-guard-wait" as ActionId, kind: "wait", durationMs: 0 }, signal);
      await computer.observe(session, "unknown-guard-observe-after-wait" as ObservationId, signal);

      const duplicate = await computer.execute(session, {
        actionId: "unknown-guard-duplicate" as ActionId,
        basedOn: "unknown-guard-observe-after-wait" as ObservationId,
        kind: "click", point: { x: 10, y: 20 },
      }, signal);
      expect(duplicate).toMatchObject({ status: "refused", driverCode: "ACTION_OUTCOME_UNKNOWN_RETRY_BLOCKED" });

      const failedAlternative = await computer.execute(session, {
        actionId: "unknown-guard-failed-alternative" as ActionId,
        basedOn: "unknown-guard-observe-after-wait" as ObservationId,
        kind: "click", point: { x: 20, y: 30 },
      }, signal, { detectNewWindowHandoff: true });
      expect(failedAlternative).toMatchObject({ status: "partial", driverCode: "ACTION_OUTCOME_UNKNOWN" });
      await computer.observe(session, "unknown-guard-observe-after-failure" as ObservationId, signal);
      const originalStillBlocked = await computer.execute(session, {
        actionId: "unknown-guard-original-after-failure" as ActionId,
        basedOn: "unknown-guard-observe-after-failure" as ObservationId,
        kind: "click", point: { x: 10, y: 20 },
      }, signal);
      expect(originalStillBlocked).toMatchObject({ status: "refused", driverCode: "ACTION_OUTCOME_UNKNOWN_RETRY_BLOCKED" });

      fake.setForegroundRefusal(false);
      expect(await computer.execute(session, {
        actionId: "unknown-guard-successful-alternative" as ActionId,
        basedOn: "unknown-guard-observe-after-failure" as ObservationId,
        kind: "click", point: { x: 40, y: 50 },
      }, signal)).toMatchObject({ status: "completed" });
      await computer.observe(session, "unknown-guard-observe-after-success" as ObservationId, signal);
      expect(await computer.execute(session, {
        actionId: "unknown-guard-original-after-success" as ActionId,
        basedOn: "unknown-guard-observe-after-success" as ObservationId,
        kind: "click", point: { x: 10, y: 20 },
      }, signal)).toMatchObject({ status: "completed" });
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(4);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves an explicit no-input foreground refusal as retry-safe", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-foreground-no-input-"));
    const fake = windowDriver();
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", driverFactory: () => fake.driver,
    });
    try {
      const session = await computer.open({}, new AbortController().signal);
      await computer.observe(session, "explicit-no-input-observation" as ObservationId, new AbortController().signal);
      fake.setForegroundRefusal(true, "foreground_unavailable: exact target HWND not active; no mouse input was sent", "WINDOW_FOREGROUND_MISMATCH");
      expect(await computer.execute(session, {
        actionId: "explicit-no-input-click" as ActionId,
        basedOn: "explicit-no-input-observation" as ObservationId,
        kind: "click",
        point: { x: 10, y: 20 },
      }, new AbortController().signal)).toMatchObject({ status: "refused", driverCode: "WINDOW_FOREGROUND_MISMATCH" });
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(1);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not reconfirm the same Surface when exact Win32 foreground evidence changes after dispatch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-unknown-foreground-changed-"));
    const fake = windowDriver();
    const baseProbe = relationshipProbeFor(fake);
    let parentIsForeground = true;
    const probe = {
      async read() {
        const inventory = await baseProbe.read();
        return {
          ...inventory,
          foregroundPid: parentIsForeground ? fake.target.pid : fake.target.pid + 1,
          foregroundWindowId: parentIsForeground ? fake.target.windowId : fake.target.windowId + 1,
        };
      },
    };
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", windowRelationshipProbe: probe, driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const observation = await computer.observe(session, "unknown-foreground-changed-before" as ObservationId, signal);
      fake.setForegroundRefusal(true, "foreground_unavailable: foreground changed while dispatching; input outcome unknown");
      const callTool = fake.driver.callTool.bind(fake.driver);
      fake.driver.callTool = async (name, input) => {
        const response = await callTool(name, input);
        if (name === "click" && response.isError) parentIsForeground = false;
        return response;
      };
      const receipt = await computer.execute(session, {
        actionId: "unknown-foreground-changed-action" as ActionId,
        basedOn: "unknown-foreground-changed-before" as ObservationId,
        kind: "click", point: { x: 10, y: 20 },
      }, signal, { detectNewWindowHandoff: true });
      expect(receipt).toMatchObject({
        status: "partial",
        driverCode: "ACTION_OUTCOME_UNKNOWN",
      });
      expect(receipt).not.toHaveProperty("safeRecovery");
      const fresh = await computer.observe(session, "unknown-foreground-changed-fresh" as ObservationId, signal);
      expect(fresh.surfaceRef.surfaceId).toBe(observation.surfaceRef.surfaceId);
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(1);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses structured no-input evidence to classify a refused action on a transient child", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-transient-structured-no-input-"));
    const fake = windowDriver();
    const menu = {
      pid: fake.target.pid,
      windowId: 8675,
      appName: "Editor",
      title: "Action menu",
      bounds: { x: 180, y: 140, width: 260, height: 180 },
      zIndex: 2,
      ownerPid: fake.target.pid,
      ownerWindowId: fake.target.windowId,
      windowClass: "#32768",
    };
    fake.setWindowImageSize(menu.windowId, 260, 180);
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", grounding: "off", windowRelationshipProbe: relationshipProbeFor(fake),
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const parent = await computer.observe(session, "structured-no-input-parent" as ObservationId, signal);
      fake.setExtraWindowAfterClick(menu);
      expect((await computer.execute(session, {
        actionId: "structured-no-input-open" as ActionId,
        basedOn: "structured-no-input-parent" as ObservationId,
        kind: "click", point: { x: 10, y: 20 },
      }, signal, { detectNewWindowHandoff: true })).status).toBe("completed");
      expect(await computer.detectNewWindowHandoffCandidates(session, signal)).toEqual([]);
      const child = await computer.observe(session, "structured-no-input-child" as ObservationId, signal);
      expect(child.surfaceRef.parentSurfaceId).toBe(parent.surfaceRef.surfaceId);

      fake.setForegroundRefusal(true, "foreground_unavailable: exact target HWND was not active");
      const originalCallTool = fake.driver.callTool.bind(fake.driver);
      fake.driver.callTool = async (name, inputJson) => {
        const response = await originalCallTool(name, inputJson);
        if (name === "click" && response.isError) {
          return { ...response, structuredJson: JSON.stringify({ input_sent: false }) };
        }
        return response;
      };
      expect(await computer.execute(session, {
        actionId: "structured-no-input-refused" as ActionId,
        basedOn: "structured-no-input-child" as ObservationId,
        kind: "click", point: { x: 10, y: 20 },
      }, signal)).toMatchObject({ status: "refused", driverCode: "WINDOW_FOREGROUND_MISMATCH" });
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(2);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["text", "structured"] as const)("pops a closed child after an explicit no-input refusal (%s)", async (proofKind) => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-no-input-child-pop-"));
    const fake = windowDriver();
    const menu = {
      pid: fake.target.pid,
      windowId: 8676,
      appName: "Editor",
      title: "Action menu",
      bounds: { x: 180, y: 140, width: 260, height: 180 },
      zIndex: 2,
      ownerPid: fake.target.pid,
      ownerWindowId: fake.target.windowId,
      windowClass: "#32768",
    };
    fake.setWindowImageSize(menu.windowId, 260, 180);
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", grounding: "off", windowRelationshipProbe: relationshipProbeFor(fake),
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const parent = await computer.observe(session, `no-input-pop-parent-${proofKind}` as ObservationId, signal);
      fake.setExtraWindowAfterClick(menu);
      expect((await computer.execute(session, {
        actionId: `no-input-pop-open-${proofKind}` as ActionId,
        basedOn: `no-input-pop-parent-${proofKind}` as ObservationId,
        kind: "click", point: { x: 10, y: 20 },
      }, signal, { detectNewWindowHandoff: true })).status).toBe("completed");
      expect(await computer.detectNewWindowHandoffCandidates(session, signal)).toEqual([]);
      const child = await computer.observe(session, `no-input-pop-child-${proofKind}` as ObservationId, signal);
      expect(child.surfaceRef.parentSurfaceId).toBe(parent.surfaceRef.surfaceId);

      const noInputMessage = proofKind === "text"
        ? "foreground_unavailable: exact target HWND was not active; no input was sent"
        : "foreground_unavailable: exact target HWND was not active";
      fake.setForegroundRefusal(true, noInputMessage);
      const originalCallTool = fake.driver.callTool.bind(fake.driver);
      fake.driver.callTool = async (name, inputJson) => {
        if (name === "click") fake.setExtraWindow(undefined);
        const response = await originalCallTool(name, inputJson);
        if (proofKind === "structured" && name === "click" && response.isError) {
          return { ...response, structuredJson: JSON.stringify({ input_sent: false }) };
        }
        return response;
      };
      const refused = await computer.execute(session, {
        actionId: `no-input-pop-refused-${proofKind}` as ActionId,
        basedOn: `no-input-pop-child-${proofKind}` as ObservationId,
        kind: "click", point: { x: 10, y: 20 },
      }, signal, { detectNewWindowHandoff: true });
      expect(refused).toMatchObject({ status: "refused", driverCode: "WINDOW_FOREGROUND_REFUSED_PARENT_RESTORED" });
      const restored = await computer.observe(session, `no-input-pop-restored-${proofKind}` as ObservationId, signal);
      expect(restored.surfaceRef.surfaceId).toBe(parent.surfaceRef.surfaceId);
      expect(restored.surfaceTransitionReason).toBe("child_pop");
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(2);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["absent", "hidden", "thrown-tool"] as const)("recovers an unknown action after complete Win32 proof of a closed child (%s)", async (closure) => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-unknown-child-recovery-"));
    const fake = windowDriver();
    const popup = {
      pid: fake.target.pid,
      windowId: 8677,
      appName: "Editor",
      title: "Transient dialog",
      bounds: { x: 180, y: 140, width: 260, height: 180 },
      zIndex: 2,
      ownerPid: fake.target.pid,
      ownerWindowId: fake.target.windowId,
      windowClass: "GenericDialogWindow",
    };
    fake.setWindowImageSize(popup.windowId, 260, 180);
    const baseProbe = relationshipProbeFor(fake);
    let afterRefusal = false;
    const probe = {
      async read(signal?: AbortSignal) {
        const snapshot = await baseProbe.read();
        if (!afterRefusal) return snapshot;
        return {
          ...snapshot,
          foregroundPid: fake.target.pid,
          foregroundWindowId: fake.target.windowId,
        };
      },
    };
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", grounding: "off", windowRelationshipProbe: probe,
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const parent = await computer.observe(session, `unknown-recovery-parent-${closure}` as ObservationId, signal);
      fake.setExtraWindowAfterClick(popup);
      expect((await computer.execute(session, {
        actionId: `unknown-recovery-open-${closure}` as ActionId,
        basedOn: `unknown-recovery-parent-${closure}` as ObservationId,
        kind: "click", point: { x: 10, y: 20 },
      }, signal, { detectNewWindowHandoff: true })).status).toBe("completed");
      expect(await computer.detectNewWindowHandoffCandidates(session, signal)).toEqual([]);
      const child = await computer.observe(session, `unknown-recovery-child-${closure}` as ObservationId, signal);
      expect(child.surfaceRef.parentSurfaceId).toBe(parent.surfaceRef.surfaceId);

      fake.setForegroundRefusal(true, "foreground_unavailable: foreground changed and the input outcome is unknown");
      const originalCallTool = fake.driver.callTool.bind(fake.driver);
      fake.driver.callTool = async (name, inputJson) => {
        const response = await originalCallTool(name, inputJson);
        if (name === "click" && response.isError) {
          afterRefusal = true;
          fake.setExtraWindow(closure === "hidden" ? { ...popup, isOnScreen: false, minimized: false } : undefined);
          if (closure === "thrown-tool") {
            throw Object.assign(new Error("fixture SDK wrapper error"), {
              tag: "Tool",
              inner: { message: "foreground_unavailable: foreground changed and the input outcome is unknown" },
            });
          }
        }
        return response;
      };
      const receipt = await computer.execute(session, {
        actionId: `unknown-recovery-close-${closure}` as ActionId,
        basedOn: `unknown-recovery-child-${closure}` as ObservationId,
        kind: "click", point: { x: 20, y: 30 },
      }, signal);
      expect(receipt).toMatchObject({
        actionId: `unknown-recovery-close-${closure}`,
        status: "partial",
        safeRecovery: { kind: "transient_parent_restored", surfaceRef: { surfaceId: parent.surfaceRef.surfaceId } },
      });
      const restored = await computer.observe(session, `unknown-recovery-restored-${closure}` as ObservationId, signal);
      expect(restored.surfaceRef.surfaceId).toBe(parent.surfaceRef.surfaceId);
      expect(restored.surfaceTransitionReason).toBe("child_pop");
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(2);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["unknown", "completed"] as const)(
    "reconciles an old menu into a freshly captured same-owner dialog after a %s click without replay",
    async (outcome) => {
      const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-owned-dialog-replacement-"));
      const fake = windowDriver();
      const menu = {
        pid: fake.target.pid,
        windowId: 8893,
        appName: "Fixture.exe",
        title: "File menu",
        bounds: { x: 120, y: 160, width: 447, height: 697 },
        zIndex: 2,
        ownerPid: fake.target.pid,
        ownerWindowId: fake.target.windowId,
        isOnScreen: true,
        minimized: false,
        windowClass: "#32768",
      };
      const dialog = {
        pid: fake.target.pid,
        windowId: 8894,
        appName: "Fixture.exe",
        title: "Save As",
        bounds: { x: 180, y: 100, width: 1265, height: 791 },
        zIndex: 3,
        ownerPid: fake.target.pid,
        ownerWindowId: fake.target.windowId,
        isOnScreen: true,
        minimized: false,
        windowClass: "#32770",
      };
      fake.setWindowImageSize(menu.windowId, 445, 695);
      fake.setWindowImageSize(dialog.windowId, 1263, 789);
      const baseProbe = relationshipProbeFor(fake);
      let afterUnknownRefusal = false;
      let postRefusalProbeReads = 0;
      const probe = {
        async read() {
          const snapshot = await baseProbe.read();
          if (outcome === "unknown" && afterUnknownRefusal) {
            postRefusalProbeReads += 1;
            if (postRefusalProbeReads === 1) {
              // The error snapshot still sees the menu. It then disappears
              // before its dialog is enumerated, exercising the bounded gap.
              fake.setExtraWindow({ ...menu, isOnScreen: false, minimized: false });
            } else if (postRefusalProbeReads === 2) {
              // The owned dialog arrives on the read after the hidden-menu gap.
              fake.setSecondExtraWindow(dialog);
            }
          }
          return { ...snapshot, foregroundPid: fake.target.pid, foregroundWindowId: fake.target.windowId };
        },
      };
      const computer = new CuaDriverComputer({
        socketPath: "test-socket",
        screenshotDir: directory,
        windowTarget: fake.target,
        windowDeliveryMode: "foreground",
        grounding: "off",
        windowRelationshipProbe: probe,
        windowCaptureRetry: { delay: async (_milliseconds, signal) => { signal.throwIfAborted(); } },
        driverFactory: () => fake.driver,
      });
      const signal = new AbortController().signal;
      try {
        const session = await computer.open({}, signal);
        const parent = await computer.observe(session, `replacement-parent-${outcome}` as ObservationId, signal);
        fake.setExtraWindowAfterClick(menu);
        const opened = await computer.execute(session, {
          actionId: `replacement-open-menu-${outcome}` as ActionId,
          basedOn: `replacement-parent-${outcome}` as ObservationId,
          kind: "click",
          point: { x: 12, y: 18 },
        }, signal, { detectNewWindowHandoff: true });
        expect(opened.status).toBe("completed");
        expect(await computer.detectNewWindowHandoffCandidates(session, signal)).toEqual([]);
        const oldChild = await computer.observe(session, `replacement-old-menu-${outcome}` as ObservationId, signal);
        expect(oldChild.surfaceRef.parentSurfaceId).toBe(parent.surfaceRef.surfaceId);

        const originalCallTool = fake.driver.callTool.bind(fake.driver);
        if (outcome === "unknown") {
          fake.setForegroundRefusal(true, "foreground_unavailable: foreground changed and input may have been sent");
        }
        fake.driver.callTool = async (name, inputJson, options) => {
          const response = await originalCallTool(name, inputJson, options);
          const clickCount = fake.calls.filter((call) => call.name === "click").length;
          if (name === "click" && clickCount === 2 && outcome === "unknown" && response.isError) {
            afterUnknownRefusal = true;
          }
          if (name === "click" && clickCount === 2 && outcome === "completed" && !response.isError) {
            fake.setExtraWindow({ ...menu, isOnScreen: false, minimized: false });
            fake.setSecondExtraWindow(dialog);
          }
          return response;
        };
        const selected = await computer.execute(session, {
          actionId: `replacement-select-save-as-${outcome}` as ActionId,
          basedOn: `replacement-old-menu-${outcome}` as ObservationId,
          kind: "click",
          point: { x: 60, y: 331 },
        }, signal, { detectNewWindowHandoff: true });
        if (outcome === "unknown") {
          expect(selected).toMatchObject({
            status: "partial",
            driverCode: "CUA_TRANSIENT_ACTION_OUTCOME_UNKNOWN",
            safeRecovery: { kind: "transient_owned_surface_reconciled" },
          });
          expect(postRefusalProbeReads).toBeGreaterThanOrEqual(3);
        } else {
          expect(selected.status).toBe("completed");
          expect(await computer.detectNewWindowHandoffCandidates(session, signal)).toEqual([]);
        }
        expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(2);

        const dialogObservation = await computer.observe(session, `replacement-dialog-${outcome}` as ObservationId, signal);
        expect(dialogObservation.surfaceTransitionReason).toBe("child_push");
        expect(dialogObservation.viewport).toEqual({ width: 1263, height: 789, coordinateSpace: "physical" });
        expect(dialogObservation.surfaceRef.surfaceId).not.toBe(oldChild.surfaceRef.surfaceId);
        expect(dialogObservation.surfaceRef.parentSurfaceId).toBe(oldChild.surfaceRef.parentSurfaceId);
        if (outcome === "unknown") {
          expect(dialogObservation.surfaceRef.surfaceId).toBe(
            "safeRecovery" in selected ? selected.safeRecovery?.surfaceRef.surfaceId : undefined,
          );
        }
        expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(2);
        await computer.close(session);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(["false-parent", "wrong-owner", "multiple-top", "partial", "capture-failure", "abort"] as const)(
    "keeps an ambiguous action unresolved when sibling reconciliation lacks %s evidence",
    async (scenario) => {
      const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-owned-dialog-rejection-"));
      const fake = windowDriver();
      const menu = {
        pid: fake.target.pid,
        windowId: 8895,
        appName: "Fixture.exe",
        title: "File menu",
        bounds: { x: 120, y: 160, width: 447, height: 697 },
        zIndex: 2,
        ownerPid: fake.target.pid,
        ownerWindowId: fake.target.windowId,
        isOnScreen: true,
        minimized: false,
        windowClass: "#32768",
      };
      const dialog = {
        pid: fake.target.pid,
        windowId: 8896,
        appName: "Fixture.exe",
        title: "Save As",
        bounds: { x: 180, y: 100, width: 1265, height: 791 },
        zIndex: 3,
        ownerPid: fake.target.pid,
        ownerWindowId: fake.target.windowId,
        isOnScreen: true,
        minimized: false,
        windowClass: "#32770",
      };
      fake.setWindowImageSize(menu.windowId, 445, 695);
      fake.setWindowImageSize(dialog.windowId, 1263, 789);
      const baseProbe = relationshipProbeFor(fake);
      const abortController = new AbortController();
      let afterRefusal = false;
      const probe = {
        async read(signal?: AbortSignal) {
          if (afterRefusal && scenario === "abort") {
            abortController.abort(new DOMException("fixture reconciliation aborted", "AbortError"));
            signal?.throwIfAborted();
          }
          const snapshot = await baseProbe.read();
          if (!afterRefusal) return snapshot;
          const windows = snapshot.windows.map((window) => {
            if (scenario === "false-parent" && window.windowId === fake.target.windowId) {
              return { ...window, bounds: { ...window.bounds, x: window.bounds.x + 1 } };
            }
            if (scenario === "wrong-owner" && window.windowId === dialog.windowId) {
              return { ...window, ownerPid: 9999, ownerWindowId: 9998 };
            }
            return window;
          });
          if (scenario === "multiple-top") {
            const sibling = windows.find((window) => window.windowId === dialog.windowId);
            if (sibling !== undefined) windows.push({ ...sibling, windowId: 8897, zIndex: dialog.zIndex });
          }
          return {
            ...snapshot,
            complete: scenario !== "partial",
            windows,
            ...(scenario === "wrong-owner"
              ? { foregroundPid: fake.target.pid, foregroundWindowId: dialog.windowId }
              : { foregroundPid: fake.target.pid, foregroundWindowId: fake.target.windowId }),
          };
        },
      };
      const computer = new CuaDriverComputer({
        socketPath: "test-socket",
        screenshotDir: directory,
        windowTarget: fake.target,
        windowDeliveryMode: "foreground",
        grounding: "off",
        windowRelationshipProbe: probe,
        windowCaptureRetry: { delay: async (_milliseconds, signal) => { signal.throwIfAborted(); } },
        driverFactory: () => fake.driver,
      });
      const signal = abortController.signal;
      let session: import("@computer-harness/protocol").ComputerSessionDescriptor | undefined;
      let captureAttempted = false;
      try {
        session = await computer.open({}, signal);
        await computer.observe(session, `sibling-rejection-parent-${scenario}` as ObservationId, signal);
        fake.setExtraWindowAfterClick(menu);
        expect((await computer.execute(session, {
          actionId: `sibling-rejection-open-${scenario}` as ActionId,
          basedOn: `sibling-rejection-parent-${scenario}` as ObservationId,
          kind: "click",
          point: { x: 12, y: 18 },
        }, signal, { detectNewWindowHandoff: true })).status).toBe("completed");
        expect(await computer.detectNewWindowHandoffCandidates(session, signal)).toEqual([]);
        await computer.observe(session, `sibling-rejection-menu-${scenario}` as ObservationId, signal);

        fake.setForegroundRefusal(true, "foreground_unavailable: foreground changed and input may have been sent");
        const originalCallTool = fake.driver.callTool.bind(fake.driver);
        fake.driver.callTool = async (name, inputJson, options) => {
          const response = await originalCallTool(name, inputJson, options);
          if (name === "click" && fake.calls.filter((call) => call.name === "click").length === 2 && response.isError) {
            afterRefusal = true;
            fake.setExtraWindow({ ...menu, isOnScreen: false, minimized: false });
            if (scenario !== "abort") {
              fake.setSecondExtraWindow(dialog);
            }
          }
          return response;
        };
        if (scenario === "capture-failure") {
          const originalVerifyState = fake.driver.verifyState.bind(fake.driver);
          fake.driver.verifyState = async (input) => {
            const record = input !== null && typeof input === "object" ? input as unknown as Record<string, unknown> : {};
            const targetWindowId = record.windowId ?? record.window_id;
            if (afterRefusal && Number(targetWindowId) === dialog.windowId) {
              captureAttempted = true;
              throw new Error("fixture exact sibling capture failure");
            }
            return originalVerifyState(input);
          };
        }

        const action = computer.execute(session, {
          actionId: `sibling-rejection-select-${scenario}` as ActionId,
          basedOn: `sibling-rejection-menu-${scenario}` as ObservationId,
          kind: "click",
          point: { x: 60, y: 331 },
        }, signal);
        if (scenario === "abort") {
          await expect(action).rejects.toThrow(/fixture reconciliation aborted/u);
          expect(signal.aborted).toBe(true);
        } else {
          await expect(action).rejects.toThrow(/outcome is unknown/u);
        }
        expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(2);
        expect(captureAttempted).toBe(scenario === "capture-failure");
      } finally {
        if (session !== undefined) await computer.close(session).catch(() => undefined);
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(["incomplete", "truncated", "owner-mismatch", "wrong-foreground", "replacement", "parent-hidden", "capture-failure"] as const)(
    "does not recover an unknown child action without full exact parent evidence (%s)", async (scenario) => {
      const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-unknown-child-no-recovery-"));
      const fake = windowDriver();
      const popup = {
        pid: fake.target.pid,
        windowId: 8678,
        appName: "Editor",
        title: "Transient dialog",
        bounds: { x: 180, y: 140, width: 260, height: 180 },
        zIndex: 2,
        ownerPid: fake.target.pid,
        ownerWindowId: fake.target.windowId,
        windowClass: "GenericDialogWindow",
      };
      fake.setWindowImageSize(popup.windowId, 260, 180);
      const baseProbe = relationshipProbeFor(fake);
      let afterRefusal = false;
      const probe = {
        async read() {
          const snapshot = await baseProbe.read();
          if (!afterRefusal) return snapshot;
          const windows = snapshot.windows.map((window) => {
            if (scenario === "owner-mismatch" && window.windowId === popup.windowId) {
              return { ...window, ownerWindowId: 9999 };
            }
            if (scenario === "parent-hidden" && window.windowId === fake.target.windowId) {
              return { ...window, isOnScreen: false };
            }
            return window;
          });
          return {
            ...snapshot,
            complete: scenario !== "incomplete",
            ...(scenario === "truncated" ? { truncated: true } : {}),
            windows,
            ...(scenario === "wrong-foreground" ? { foregroundPid: 9999, foregroundWindowId: 8888 } : {}),
          };
        },
      };
      const computer = new CuaDriverComputer({
        socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
        windowDeliveryMode: "foreground", grounding: "off", windowRelationshipProbe: probe,
        driverFactory: () => fake.driver,
      });
      const signal = new AbortController().signal;
      try {
        const session = await computer.open({}, signal);
        const parent = await computer.observe(session, `unknown-no-recovery-parent-${scenario}` as ObservationId, signal);
        fake.setExtraWindowAfterClick(popup);
        expect((await computer.execute(session, {
          actionId: `unknown-no-recovery-open-${scenario}` as ActionId,
          basedOn: `unknown-no-recovery-parent-${scenario}` as ObservationId,
          kind: "click", point: { x: 10, y: 20 },
        }, signal, { detectNewWindowHandoff: true })).status).toBe("completed");
        expect(await computer.detectNewWindowHandoffCandidates(session, signal)).toEqual([]);
        const child = await computer.observe(session, `unknown-no-recovery-child-${scenario}` as ObservationId, signal);
        fake.setForegroundRefusal(true, "foreground_unavailable: foreground changed and the input outcome is unknown");
        const originalCallTool = fake.driver.callTool.bind(fake.driver);
        fake.driver.callTool = async (name, inputJson) => {
          const response = await originalCallTool(name, inputJson);
          if (name === "click" && response.isError) {
            afterRefusal = true;
            if (scenario === "replacement") {
              fake.setExtraWindow(undefined);
              fake.setSecondExtraWindow({ ...popup, windowId: 8679, zIndex: 3 });
            } else if (scenario === "owner-mismatch") {
              fake.setExtraWindow({ ...popup, isOnScreen: false, minimized: false });
            } else if (scenario !== "parent-hidden") {
              fake.setExtraWindow(undefined);
            }
          }
          return response;
        };
        if (scenario === "capture-failure") {
          const originalVerifyState = fake.driver.verifyState.bind(fake.driver);
          fake.driver.verifyState = async (input) => {
            const record = input !== null && typeof input === "object" ? input as unknown as Record<string, unknown> : {};
            const targetWindowId = record.windowId ?? record.window_id;
            if (afterRefusal && Number(targetWindowId) === fake.target.windowId) throw new Error("fixture parent capture failure");
            return originalVerifyState(input);
          };
        }
        await expect(computer.execute(session, {
          actionId: `unknown-no-recovery-close-${scenario}` as ActionId,
          basedOn: `unknown-no-recovery-child-${scenario}` as ObservationId,
          kind: "click", point: { x: 20, y: 30 },
        }, signal)).rejects.toThrow(/outcome is unknown/u);
        expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(2);
        await computer.close(session);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

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
      expect(await computer.listWindowHandoffCandidates(session, signal)).toHaveLength(1);
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
      windowDeliveryMode: "foreground", windowSwitchAllowedTargets: [fake.target, { pid: 4321, windowId: 8765 }],
      driverFactory: () => fake.driver,
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
      expect(candidates.some((candidate) => candidate.pid === 4321 && candidate.title === "Save As")).toBe(false);
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
      expect(await computer.listWindowHandoffCandidates(session, signal)).toEqual([]);
      expect(await computer.listNewWindowHandoffCandidates(session, signal)).toEqual([]);
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
      expect(await computer.detectNewWindowHandoffCandidates(session, signal)).toEqual([]);
      expect(fake.calls.some((call) => call.name === "get_accessibility_tree")).toBe(false);
      const stillParent = await computer.observe(session, "truncated-popup-still-parent" as ObservationId, signal);
      expect(stillParent.surfaceRef).toEqual(before.surfaceRef);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("continues with a fresh exact observation when the post-action inventory is partial and has no related window", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-partial-post-action-no-child-"));
    const fake = windowDriver();
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const before = await computer.observe(session, "partial-post-action-before" as ObservationId, signal);
      const receipt = await computer.execute(session, {
        actionId: "partial-post-action-click" as ActionId,
        basedOn: "partial-post-action-before" as ObservationId,
        kind: "click",
        point: { x: 10, y: 20 },
      }, signal, { detectNewWindowHandoff: true });
      expect(receipt.status).toBe("completed");
      fake.setWindowInventoryComplete(false);
      expect(await computer.detectNewWindowHandoffCandidates(session, signal)).toEqual([]);
      const after = await computer.observe(session, "partial-post-action-after" as ObservationId, signal);
      expect(after.surfaceRef).toEqual(before.surfaceRef);
      expect(after.surfaceTransitionReason).toBeUndefined();
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(1);
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

  it("attempts native visible capture once across a UIA timeout retry and again on the next capture", async () => {
    const fake = windowDriver();
    const originalVerifyState = fake.driver.verifyState.bind(fake.driver);
    let verifyCalls = 0;
    fake.driver.verifyState = async (...args: Parameters<CuaDriverLike["verifyState"]>) => {
      verifyCalls += 1;
      if (verifyCalls === 1) {
        return result({ isError: true, errorCode: "uia_provider_timeout", text: "UIA provider unresponsive; timed out" });
      }
      return await originalVerifyState(...args);
    };
    const foregroundVisibleCapture = vi.fn(async () => undefined);
    const options = { foregroundVisibleCapture, delay: async () => undefined };
    const signal = new AbortController().signal;

    const retried = await captureWindowWithRetry(fake.driver, "window-visible-uia-retry", fake.target, signal, options, "win32");
    expect(retried.source).toBe("verify_state");
    expect(foregroundVisibleCapture).toHaveBeenCalledTimes(1);
    expect(verifyCalls).toBe(2);

    const nextCapture = await captureWindowWithRetry(fake.driver, "window-visible-next-observation", fake.target, signal, options, "win32");
    expect(nextCapture.source).toBe("verify_state");
    expect(foregroundVisibleCapture).toHaveBeenCalledTimes(2);
    expect(verifyCalls).toBe(3);
  });

  it("does not repeat a refused native capture during schema retries", async () => {
    const fake = windowDriver();
    const foregroundVisibleCapture = vi.fn(async () => undefined);
    const validImage = [{ mimeType: "image/png", dataBase64: pngWithDimensions(960, 680) }];
    fake.setCaptureImages([[], validImage, validImage]);

    const capture = await captureWindowWithRetry(
      fake.driver,
      "window-visible-schema-retry",
      fake.target,
      new AbortController().signal,
      { foregroundVisibleCapture, delay: async () => undefined },
      "win32",
    );

    expect(capture.source).toBe("verify_state");
    expect(foregroundVisibleCapture).toHaveBeenCalledTimes(1);
    expect(fake.calls.filter((call) => call.name === "verifyState")).toHaveLength(2);
    expect(fake.calls.filter((call) => call.name === "list_windows")).toHaveLength(2);
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

  it("keeps a known no-activate owned menu on the parent Surface and exposes its UIA item there", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-noactivate-menu-parent-surface-"));
    const fake = windowDriver();
    const menu = {
      pid: fake.target.pid,
      windowId: 8769,
      appName: "Notepad",
      title: "Owned menu fixture",
      bounds: { x: 300, y: 200, width: 180, height: 88 },
      zIndex: 2,
      ownerPid: fake.target.pid,
      ownerWindowId: fake.target.windowId,
      windowClass: "Microsoft.UI.Content.PopupWindowSiteBridge",
      noActivate: true,
    };
    fake.setWindowImageSize(menu.windowId, menu.bounds.width, menu.bounds.height);
    const parentState = (elements: readonly Record<string, unknown>[]) => ({
      complete: true,
      elements_complete: true,
      geometry_verified: true,
      snapshot_id: "parent-menu-snapshot",
      root_surface: { pid: fake.target.pid, window_id: fake.target.windowId, role: "Window", complete: true },
      overlay_root: null,
      elements,
    });
    fake.setWindowGroundingState(fake.target.windowId, parentState([]));
    const baseProbe = relationshipProbeFor(fake);
    const parentForegroundProbe = {
      async read() {
        const snapshot = await baseProbe.read();
        return { ...snapshot, foregroundPid: fake.target.pid, foregroundWindowId: fake.target.windowId };
      },
    };
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", grounding: "uia-catalog-v1", windowSwitch: "opened-windows-v1",
      windowSwitchAllowedTargets: [fake.target], windowRelationshipProbe: parentForegroundProbe,
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const parent = await computer.observe(session, "noactivate-menu-parent-before" as ObservationId, signal);
      fake.setExtraWindowAfterClick(menu);
      const receipt = await computer.execute(session, {
        actionId: "noactivate-menu-open" as ActionId,
        basedOn: "noactivate-menu-parent-before" as ObservationId,
        kind: "click",
        point: { x: 12, y: 18 },
      }, signal, { detectNewWindowHandoff: true });
      expect(receipt.status).toBe("completed");
      expect(await computer.detectNewWindowHandoffCandidates(session, signal)).toEqual([]);

      fake.setWindowGroundingState(fake.target.windowId, parentState([{
        depth: 1,
        element_index: 1,
        parent_index: 0,
        element_token: "noactivate-menu-item",
        role: "MenuItem",
        enabled: true,
        label: "Replace all",
        frame: { x: 320, y: 210, width: 80, height: 24 },
      }]));
      const after = await computer.observe(session, "noactivate-menu-parent-menu-visible" as ObservationId, signal);
      expect(after.surfaceRef.surfaceId).toBe(parent.surfaceRef.surfaceId);
      expect(after.surfaceRef.parentSurfaceId).toBeUndefined();
      expect(after.surfaceTransitionReason).toBeUndefined();
      expect(after.viewport).toEqual(parent.viewport);
      const item = after.grounding?.elements.find((element) => element.role === "MenuItem");
      expect(item).toBeDefined();

      expect(await computer.listWindowHandoffCandidates(session, signal)).toEqual([]);
      const listed = await computer.listWindows(session, signal);
      expect(listed.options.some((option) => option.title === menu.title)).toBe(false);

      const action = await computer.execute(session, {
        actionId: "noactivate-menu-item-click" as ActionId,
        basedOn: "noactivate-menu-parent-menu-visible" as ObservationId,
        kind: "click",
        point: { x: item!.bbox!.x + item!.bbox!.width / 2, y: item!.bbox!.y + item!.bbox!.height / 2 },
        groundingRef: item!.elementRef,
      }, signal);
      expect(action.status).toBe("completed");
      expect(fake.calls.filter((call) => call.name === "click").at(-1)?.input).toMatchObject({
        target: { kind: "window", pid: fake.target.pid, window_id: fake.target.windowId },
      });
      expect(fake.calls.some((call) => call.name === "verifyState" && call.input?.window_id === menu.windowId)).toBe(false);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses an exact Win32 child-foreground relationship to push a child when UIA root data is unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-owned-child-no-uia-root-"));
    const fake = windowDriver();
    const child = {
      pid: fake.target.pid,
      windowId: 8766,
      appName: "Notepad",
      title: "Edit",
      bounds: { x: 300, y: 200, width: 300, height: 200 },
      zIndex: 2,
      ownerPid: fake.target.pid,
      ownerWindowId: fake.target.windowId,
      isOnScreen: true,
      minimized: false,
    };
    fake.setWindowImageSize(child.windowId, 298, 198);
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", grounding: "off", windowRelationshipProbe: relationshipProbeFor(fake),
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const parent = await computer.observe(session, "owner-stack-no-uia-parent" as ObservationId, signal);
      fake.setExtraWindowAfterClick(child);
      await computer.execute(session, {
        actionId: "owner-stack-no-uia-open" as ActionId,
        basedOn: "owner-stack-no-uia-parent" as ObservationId,
        kind: "click",
        point: { x: 10, y: 20 },
      }, signal, { detectNewWindowHandoff: true });
      expect(await computer.detectNewWindowHandoffCandidates(session, signal)).toEqual([]);
      const opened = await computer.observe(session, "owner-stack-no-uia-child" as ObservationId, signal);
      expect(opened.surfaceTransitionReason).toBe("child_push");
      expect(opened.surfaceRef).toMatchObject({
        kind: "native_window",
        parentSurfaceId: parent.surfaceRef.surfaceId,
        admissionSource: "win32_relationship_probe",
      });
      expect(fake.calls.filter((call) => call.name === "get_window_state" && call.input?.window_id === child.windowId)).toHaveLength(2);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps a generic exact-owned auxiliary non-blocking while the parent remains foreground", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-owned-auxiliary-nonblocking-"));
    const fake = windowDriver();
    const auxiliary = {
      pid: fake.target.pid,
      windowId: 8767,
      appName: "WPS Office",
      title: "Selection tools",
      bounds: { x: 300, y: 200, width: 300, height: 80 },
      zIndex: 2,
      ownerPid: fake.target.pid,
      ownerWindowId: fake.target.windowId,
      isOnScreen: true,
      minimized: false,
      windowClass: "FloatingToolbarWindow",
    };
    const unrelatedHelper = {
      pid: 9876,
      windowId: 8768,
      appName: "Background helper",
      title: "Helper window",
      zIndex: 3,
    };
    fake.setWindowImageSize(auxiliary.windowId, 298, 78);
    fake.setWindowGroundingState(auxiliary.windowId, {
      pid: auxiliary.pid,
      window_id: auxiliary.windowId,
      complete: true,
      elements_complete: true,
      root_surface: { pid: auxiliary.pid, window_id: auxiliary.windowId, role: "Window", complete: true },
      elements: [{ depth: 0, element_index: 0, role: "Window", enabled: true }],
    });
    const baseProbe = relationshipProbeFor(fake);
    const parentForegroundProbe = {
      async read() {
        const snapshot = await baseProbe.read();
        return {
          ...snapshot,
          foregroundPid: fake.target.pid,
          foregroundWindowId: fake.target.windowId,
        };
      },
    };
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", grounding: "off", windowSwitch: "opened-windows-v1",
      windowRelationshipProbe: parentForegroundProbe, driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const parent = await computer.observe(session, "owned-auxiliary-parent" as ObservationId, signal);
      fake.setExtraWindowAfterClick(auxiliary);
      fake.setSecondExtraWindowAfterClick(unrelatedHelper);
      const receipt = await computer.execute(session, {
        actionId: "owned-auxiliary-trigger" as ActionId,
        basedOn: "owned-auxiliary-parent" as ObservationId,
        kind: "click",
        point: { x: 10, y: 20 },
      }, signal, { detectNewWindowHandoff: true });
      expect(receipt.status).toBe("completed");

      // The exact owner + visible geometry/z-order rows are known, but the
      // generic helper did not take foreground and supplied no modal root.
      // Continue with a fresh observation of the same parent Surface rather
      // than handing an irrelevant toolbar to the Host as a modal dialog.
      expect(await computer.detectNewWindowHandoffCandidates(session, signal)).toEqual([]);
      expect(await computer.listNewWindowHandoffCandidates(session, signal)).toEqual([]);
      const after = await computer.observe(session, "owned-auxiliary-parent-fresh" as ObservationId, signal);
      expect(after.surfaceRef).toMatchObject({
        kind: "native_window",
        surfaceId: parent.surfaceRef.surfaceId,
        generation: parent.surfaceRef.generation,
      });
      expect(after.surfaceTransitionReason).not.toBe("child_push");
      expect(fake.calls.filter((call) => call.name === "get_window_state" && call.input?.window_id === auxiliary.windowId)).toHaveLength(1);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("routes a grounded native Menu popup under foreground delivery even when public grounding is off", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-owned-menu-grounding-off-"));
    const fake = windowDriver();
    const menu = {
      pid: fake.target.pid,
      windowId: 8870,
      appName: "Fixture.exe",
      title: "Owned popup",
      bounds: { x: 120, y: 160, width: 447, height: 697 },
      zIndex: 2,
      ownerPid: fake.target.pid,
      ownerWindowId: fake.target.windowId,
      isOnScreen: true,
      minimized: false,
      windowClass: "PopupWindowSiteBridge",
    };
    fake.setWindowImageSize(menu.windowId, 445, 695);
    fake.setWindowGroundingState(menu.windowId, {
      pid: menu.pid,
      window_id: menu.windowId,
      element_count: 2,
      returned_element_count: 2,
      total_element_count: 2,
      elements_complete: false,
      elements: [
        { depth: 3, element_index: 0, role: "Menu", enabled: true },
        { depth: 4, element_index: 1, parent_index: 0, role: "MenuItem", enabled: true, label: "Save" },
      ],
    });
    const baseProbe = relationshipProbeFor(fake);
    const parentForegroundProbe = {
      async read() {
        const snapshot = await baseProbe.read();
        return {
          ...snapshot,
          foregroundPid: fake.target.pid,
          foregroundWindowId: fake.target.windowId,
        };
      },
    };
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", grounding: "off", windowRelationshipProbe: parentForegroundProbe,
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const parent = await computer.observe(session, "menu-off-parent" as ObservationId, signal);
      fake.setExtraWindowAfterClick(menu);
      const receipt = await computer.execute(session, {
        actionId: "menu-off-open" as ActionId,
        basedOn: "menu-off-parent" as ObservationId,
        kind: "click",
        point: { x: 12, y: 18 },
      }, signal, { detectNewWindowHandoff: true });
      expect(receipt.status).toBe("completed");
      expect(await computer.detectNewWindowHandoffCandidates(session, signal)).toEqual([]);

      const opened = await computer.observe(session, "menu-off-child" as ObservationId, signal);
      expect(opened.surfaceTransitionReason).toBe("child_push");
      expect(opened.viewport).toEqual({ width: 445, height: 695, coordinateSpace: "physical" });
      expect(opened.surfaceRef).toMatchObject({
        kind: "native_window",
        parentSurfaceId: parent.surfaceRef.surfaceId,
        admissionSource: "win32_relationship_probe",
      });
      expect(opened.grounding).toBeUndefined();
      expect(session.capabilities.accessibility).toBe(false);
      expect(fake.calls.filter((call) => call.name === "get_accessibility_tree")).toHaveLength(0);
      expect(fake.calls.filter((call) => call.name === "get_window_state" && call.input?.window_id === menu.windowId).length).toBeGreaterThan(0);

      fake.closeExtraWindowAfterNextClick();
      const selection = await computer.execute(session, {
        actionId: "menu-off-select" as ActionId,
        basedOn: "menu-off-child" as ObservationId,
        kind: "click",
        point: { x: 40, y: 40 },
      }, signal);
      expect(selection.status).toBe("completed");
      expect(fake.calls.filter((call) => call.name === "click").at(-1)?.input).toMatchObject({
        target: { kind: "window", pid: menu.pid, window_id: menu.windowId },
      });
      expect(await computer.detectNewWindowHandoffCandidates(session, signal)).toEqual([]);
      const returned = await computer.observe(session, "menu-off-parent-restored" as ObservationId, signal);
      expect(returned.surfaceTransitionReason).toBe("child_pop");
      expect(returned.surfaceRef.surfaceId).toBe(parent.surfaceRef.surfaceId);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("admits an already-open owned Menu before the first native foreground observation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-initial-owned-menu-"));
    const fake = windowDriver();
    const menu = {
      pid: fake.target.pid,
      windowId: 8890,
      appName: "Fixture.exe",
      title: "Owned popup",
      bounds: { x: 120, y: 160, width: 447, height: 697 },
      zIndex: 2,
      ownerPid: fake.target.pid,
      ownerWindowId: fake.target.windowId,
      isOnScreen: true,
      minimized: false,
      windowClass: "PopupWindowSiteBridge",
    };
    fake.setExtraWindow(menu);
    fake.setWindowImageSize(menu.windowId, 445, 695);
    fake.setWindowGroundingState(menu.windowId, {
      pid: menu.pid,
      window_id: menu.windowId,
      element_count: 2,
      returned_element_count: 2,
      total_element_count: 2,
      elements_complete: false,
      elements: [
        { depth: 3, element_index: 0, role: "Menu", enabled: true },
        { depth: 4, element_index: 1, parent_index: 0, role: "MenuItem", enabled: true, label: "Save" },
      ],
    });
    const baseProbe = relationshipProbeFor(fake);
    const parentForegroundProbe = {
      async read() {
        const snapshot = await baseProbe.read();
        return { ...snapshot, foregroundPid: fake.target.pid, foregroundWindowId: fake.target.windowId };
      },
    };
    const verifyRequests: Array<{ readonly windowId: bigint; readonly includeScreenshot: boolean }> = [];
    const verifyState = fake.driver.verifyState.bind(fake.driver);
    fake.driver.verifyState = async (input, options) => {
      verifyRequests.push({ windowId: input.windowId, includeScreenshot: input.includeScreenshot });
      return verifyState(input, options);
    };
    const computer = new ProductionCuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", grounding: "off", windowRelationshipProbe: parentForegroundProbe,
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const opened = await computer.observe(session, "initial-existing-menu" as ObservationId, signal);

      expect(opened.surfaceTransitionReason).toBe("child_push");
      expect(opened.viewport).toEqual({ width: 445, height: 695, coordinateSpace: "physical" });
      expect(opened.surfaceRef).toMatchObject({ kind: "native_window", parentSurfaceId: expect.any(String) });
      expect(opened.grounding).toBeUndefined();
      expect(session.capabilities.accessibility).toBe(false);
      expect(verifyRequests.find((request) => request.windowId === BigInt(menu.windowId))).toMatchObject({ includeScreenshot: true });
      expect(fake.calls.filter((call) => call.name === "get_accessibility_tree")).toHaveLength(0);
      expect(fake.calls.filter((call) => call.name === "verifyState" && call.input?.window_id === menu.windowId)).toHaveLength(1);
      expect(fake.calls.filter((call) => call.name === "get_window_state" && call.input?.window_id === menu.windowId))
        .toMatchObject([{ input: expect.objectContaining({ include_screenshot: false }) }]);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the verified parent when an exact-owned z-order candidate has no positive root or foreground proof", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-initial-weak-owned-child-"));
    const fake = windowDriver();
    const candidate = {
      pid: fake.target.pid,
      windowId: 8897,
      appName: "Fixture.exe",
      title: "",
      bounds: { x: 90, y: 110, width: 980, height: 700 },
      zIndex: 2,
      ownerPid: fake.target.pid,
      ownerWindowId: fake.target.windowId,
      isOnScreen: true,
      minimized: false,
      windowClass: "UnclassifiedOwnedWindow",
    };
    fake.setExtraWindow(candidate);
    fake.setWindowImageSize(candidate.windowId, 978, 698);
    const baseProbe = relationshipProbeFor(fake);
    const parentForegroundProbe = {
      async read(signal?: AbortSignal) {
        const snapshot = await baseProbe.read();
        return { ...snapshot, foregroundPid: fake.target.pid, foregroundWindowId: fake.target.windowId };
      },
    };
    const originalCallTool = fake.driver.callTool.bind(fake.driver);
    fake.driver.callTool = async (name, inputJson, options) => {
      const input = JSON.parse(inputJson) as Record<string, unknown>;
      if (name === "get_window_state" && input.window_id === candidate.windowId && input.include_screenshot === false) {
        fake.calls.push({ name, input });
        return result({ isError: true, text: "fixture exact child root unavailable" });
      }
      return originalCallTool(name, inputJson, options);
    };
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory,
      windowTarget: fake.target, windowDeliveryMode: "foreground", grounding: "off",
      windowRelationshipProbe: parentForegroundProbe, driverFactory: () => fake.driver });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const opened = await computer.observe(session, "initial-weak-owned-child" as ObservationId, signal);

      expect(opened.surfaceRef.kind).toBe("native_window");
      expect(opened.surfaceRef.parentSurfaceId).toBeUndefined();
      expect(opened.surfaceTransitionReason).toBeUndefined();
      expect(opened.grounding).toBeUndefined();
      expect(fake.calls.filter((call) => call.name === "get_window_state" && call.input?.window_id === candidate.windowId)).toHaveLength(1);
      expect(fake.calls.filter((call) => call.name === "verifyState" && call.input?.window_id === candidate.windowId)).toHaveLength(0);
      expect(fake.calls.filter((call) => call.name === "verifyState" && call.input?.window_id === fake.target.windowId).length).toBeGreaterThan(0);
      expect(fake.calls.some((call) => call.name === "click" || call.name === "type_text" || call.name === "press_key")).toBe(false);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("admits an exact-foreground directly-owned child after capture without requiring a UIA root role", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-initial-native-foreground-child-"));
    const fake = windowDriver();
    const candidate = {
      pid: fake.target.pid,
      windowId: 8898,
      appName: "Fixture.exe",
      title: "",
      bounds: { x: 180, y: 140, width: 420, height: 320 },
      zIndex: 2,
      ownerPid: fake.target.pid,
      ownerWindowId: fake.target.windowId,
      isOnScreen: true,
      minimized: false,
      windowClass: "UnclassifiedOwnedWindow",
    };
    fake.setExtraWindow(candidate);
    fake.setWindowImageSize(candidate.windowId, 418, 318);
    fake.setWindowGroundingState(candidate.windowId, {
      pid: candidate.pid,
      window_id: candidate.windowId,
      elements_complete: false,
      elements: [],
    });
    const baseProbe = relationshipProbeFor(fake);
    let inventoryReads = 0;
    const foregroundChildProbe = {
      async read(signal?: AbortSignal) {
        inventoryReads += 1;
        const snapshot = await baseProbe.read();
        return { ...snapshot, foregroundPid: candidate.pid, foregroundWindowId: candidate.windowId };
      },
    };
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory,
      windowTarget: fake.target, windowDeliveryMode: "foreground", grounding: "off",
      windowRelationshipProbe: foregroundChildProbe, driverFactory: () => fake.driver });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const opened = await computer.observe(session, "initial-native-foreground-child" as ObservationId, signal);

      expect(opened.surfaceTransitionReason).toBe("child_push");
      expect(opened.viewport).toEqual({ width: 418, height: 318, coordinateSpace: "physical" });
      expect(opened.surfaceRef).toMatchObject({ kind: "native_window", parentSurfaceId: expect.any(String), admissionSource: "win32_relationship_probe" });
      expect(inventoryReads).toBeGreaterThanOrEqual(2);
      expect(fake.calls.filter((call) => call.name === "verifyState" && call.input?.window_id === candidate.windowId)).toHaveLength(1);
      expect(fake.calls.filter((call) => call.name === "get_window_state" && call.input?.window_id === candidate.windowId)).toHaveLength(1);
      expect(opened.grounding).toBeUndefined();
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not commit a rootless foreground child if exact foreground proof changes during capture", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-initial-stale-foreground-child-"));
    const fake = windowDriver();
    const candidate = {
      pid: fake.target.pid,
      windowId: 8899,
      appName: "Fixture.exe",
      title: "",
      bounds: { x: 180, y: 140, width: 420, height: 320 },
      zIndex: 2,
      ownerPid: fake.target.pid,
      ownerWindowId: fake.target.windowId,
      isOnScreen: true,
      minimized: false,
      windowClass: "UnclassifiedOwnedWindow",
    };
    fake.setExtraWindow(candidate);
    fake.setWindowImageSize(candidate.windowId, 418, 318);
    fake.setWindowGroundingState(candidate.windowId, {
      pid: candidate.pid,
      window_id: candidate.windowId,
      elements_complete: false,
      elements: [],
    });
    const baseProbe = relationshipProbeFor(fake);
    let inventoryReads = 0;
    const changingForegroundProbe = {
      async read(signal?: AbortSignal) {
        inventoryReads += 1;
        const snapshot = await baseProbe.read();
        return inventoryReads === 1
          ? { ...snapshot, foregroundPid: candidate.pid, foregroundWindowId: candidate.windowId }
          : { ...snapshot, foregroundPid: fake.target.pid, foregroundWindowId: fake.target.windowId };
      },
    };
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory,
      windowTarget: fake.target, windowDeliveryMode: "foreground", grounding: "off",
      windowRelationshipProbe: changingForegroundProbe, driverFactory: () => fake.driver });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await expect(computer.observe(session, "initial-stale-foreground-child" as ObservationId, signal))
        .rejects.toMatchObject({ code: "TRANSIENT_SURFACE_UNKNOWN" });
      expect(inventoryReads).toBe(2);
      expect(fake.calls.filter((call) => call.name === "verifyState" && call.input?.window_id === candidate.windowId)).toHaveLength(1);
      expect(fake.calls.filter((call) => call.name === "click" || call.name === "type_text" || call.name === "press_key")).toHaveLength(0);

      const parent = await computer.observe(session, "initial-stale-foreground-parent" as ObservationId, signal);
      expect(parent.surfaceRef.kind).toBe("native_window");
      expect(parent.surfaceRef.parentSurfaceId).toBeUndefined();
      expect(parent.surfaceTransitionReason).toBeUndefined();
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not push an initial generic Window with a descendant Button as an interactive Menu", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-initial-window-button-not-menu-"));
    const fake = windowDriver();
    const auxiliary = {
      pid: fake.target.pid,
      windowId: 8891,
      appName: "Fixture.exe",
      title: "Owned helper",
      bounds: { x: 120, y: 160, width: 300, height: 200 },
      zIndex: 2,
      ownerPid: fake.target.pid,
      ownerWindowId: fake.target.windowId,
      isOnScreen: true,
      minimized: false,
      windowClass: "GenericOwnedWindow",
    };
    fake.setExtraWindow(auxiliary);
    fake.setWindowImageSize(auxiliary.windowId, 298, 198);
    fake.setWindowGroundingState(auxiliary.windowId, {
      pid: auxiliary.pid,
      window_id: auxiliary.windowId,
      complete: true,
      elements_complete: true,
      root_surface: { pid: auxiliary.pid, window_id: auxiliary.windowId, role: "Window", complete: true },
      elements: [
        { depth: 0, element_index: 0, role: "Window", enabled: true },
        { depth: 1, element_index: 1, parent_index: 0, role: "Button", enabled: true, label: "OK" },
      ],
    });
    const baseProbe = relationshipProbeFor(fake);
    const parentForegroundProbe = {
      async read() {
        const snapshot = await baseProbe.read();
        return { ...snapshot, foregroundPid: fake.target.pid, foregroundWindowId: fake.target.windowId };
      },
    };
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", grounding: "off", windowRelationshipProbe: parentForegroundProbe,
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const opened = await computer.observe(session, "initial-window-button" as ObservationId, signal);

      expect(opened.surfaceRef.kind).toBe("native_window");
      expect(opened.surfaceRef.parentSurfaceId).toBeUndefined();
      expect(opened.surfaceTransitionReason).toBeUndefined();
      expect(opened.grounding).toBeUndefined();
      expect(fake.calls.filter((call) => call.name === "get_window_state" && call.input?.window_id === auxiliary.windowId)).toHaveLength(1);
      expect(fake.calls.filter((call) => call.name === "verifyState" && call.input?.window_id === auxiliary.windowId)).toHaveLength(0);
      expect(fake.calls.filter((call) => call.name === "get_accessibility_tree")).toHaveLength(0);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["capture", "revalidation", "root-query-failed", "root-unparseable"] as const)(
    "does not commit an unverified initial transient when %s is unavailable",
    async (failureStage) => {
      const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-initial-menu-unresolved-"));
      const fake = windowDriver();
      const menu = {
        pid: fake.target.pid,
        windowId: 8892,
        appName: "Fixture.exe",
        title: "Owned popup",
        bounds: { x: 120, y: 160, width: 447, height: 697 },
        zIndex: 2,
        ownerPid: fake.target.pid,
        ownerWindowId: fake.target.windowId,
        isOnScreen: true,
        minimized: false,
        windowClass: "PopupWindowSiteBridge",
      };
      fake.setExtraWindow(menu);
      fake.setWindowImageSize(menu.windowId, 445, 695);
      fake.setWindowGroundingState(menu.windowId, {
        pid: menu.pid,
        window_id: menu.windowId,
        element_count: 2,
        returned_element_count: 2,
        total_element_count: 2,
        elements_complete: false,
        elements: [
          { depth: 3, element_index: 0, role: "Menu", enabled: true },
          { depth: 4, element_index: 1, parent_index: 0, role: "MenuItem", enabled: true, label: "Save" },
        ],
      });
      const baseProbe = relationshipProbeFor(fake);
      const parentForegroundProbe = {
        async read() {
          const snapshot = await baseProbe.read();
          return { ...snapshot, foregroundPid: fake.target.pid, foregroundWindowId: fake.target.windowId };
        },
      };
      if (failureStage === "root-unparseable") {
        fake.setWindowGroundingState(menu.windowId, {
          pid: menu.pid,
          window_id: menu.windowId,
          complete: false,
          elements_complete: false,
          elements: [],
        });
      }
      if (failureStage === "root-query-failed") {
        const callTool = fake.driver.callTool.bind(fake.driver);
        fake.driver.callTool = async (name, inputJson, options) => {
          const response = await callTool(name, inputJson, options);
          const input = JSON.parse(inputJson) as Record<string, unknown>;
          return name === "get_window_state" && input.window_id === menu.windowId && input.include_screenshot === false
            ? result({ isError: true, text: "fixture exact root query failed" })
            : response;
        };
      }
      let probeReads = 0;
      const probe = {
        async read(signal: AbortSignal) {
          probeReads += 1;
          const snapshot = await baseProbe.read();
          return failureStage === "revalidation" && probeReads === 2
            ? { ...snapshot, complete: false }
            : snapshot;
        },
      };
        if (failureStage === "capture") {
        const verifyState = fake.driver.verifyState.bind(fake.driver);
        fake.driver.verifyState = async (input, options) => {
          const windowId = typeof input.windowId === "bigint" ? Number(input.windowId) : input.windowId;
          if (windowId === menu.windowId) return result({ isError: true, text: "fixture child capture refused" });
          return verifyState(input, options);
        };
      }
      const computer = new CuaDriverComputer({
        socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
        windowDeliveryMode: "foreground", grounding: "off", windowRelationshipProbe: {
          async read(signal) {
            return { ...(await probe.read(signal)), foregroundPid: fake.target.pid, foregroundWindowId: fake.target.windowId };
          },
        },
        driverFactory: () => fake.driver,
      });
      const signal = new AbortController().signal;
      try {
        const session = await computer.open({}, signal);
        const weakRoot = failureStage === "root-query-failed" || failureStage === "root-unparseable";
        if (weakRoot) {
          const initialParent = await computer.observe(session, `initial-menu-${failureStage}-parent-first` as ObservationId, signal);
          expect(initialParent.surfaceRef.kind).toBe("native_window");
          expect(initialParent.surfaceRef.parentSurfaceId).toBeUndefined();
          expect(initialParent.surfaceTransitionReason).toBeUndefined();
          expect(fake.calls.filter((call) => call.name === "verifyState" && call.input?.window_id === menu.windowId)).toHaveLength(0);
        } else {
          await expect(computer.observe(session, `initial-menu-${failureStage}-failed` as ObservationId, signal))
            .rejects.toMatchObject({ code: "TRANSIENT_SURFACE_UNKNOWN" });
        }
        expect(fake.calls.filter((call) => call.name === "click" || call.name === "press_key")).toHaveLength(0);
        expect(fake.calls.filter((call) => call.name === "get_window_state" && call.input?.window_id === menu.windowId)).toHaveLength(1);

        fake.setExtraWindow(undefined);
        const parent = await computer.observe(session, `initial-menu-${failureStage}-parent` as ObservationId, signal);
        expect(parent.surfaceRef.kind).toBe("native_window");
        expect(parent.surfaceRef.parentSurfaceId).toBeUndefined();
        expect(parent.surfaceTransitionReason).toBeUndefined();
        if (failureStage === "revalidation") expect(probeReads).toBe(4);
        await computer.close(session);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("does not admit a generic Window with only a descendant Button as an interactive Menu", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-window-button-not-menu-"));
    const fake = windowDriver();
    const auxiliary = {
      pid: fake.target.pid,
      windowId: 8872,
      appName: "Fixture.exe",
      title: "Owned helper",
      bounds: { x: 120, y: 160, width: 300, height: 200 },
      zIndex: 2,
      ownerPid: fake.target.pid,
      ownerWindowId: fake.target.windowId,
      isOnScreen: true,
      minimized: false,
      windowClass: "GenericOwnedWindow",
    };
    fake.setWindowImageSize(auxiliary.windowId, 298, 198);
    fake.setWindowGroundingState(auxiliary.windowId, {
      pid: auxiliary.pid,
      window_id: auxiliary.windowId,
      complete: true,
      elements_complete: true,
      root_surface: { pid: auxiliary.pid, window_id: auxiliary.windowId, role: "Window", complete: true },
      elements: [
        { depth: 0, element_index: 0, role: "Window", enabled: true },
        { depth: 1, element_index: 1, parent_index: 0, role: "Button", enabled: true, label: "OK" },
      ],
    });
    const baseProbe = relationshipProbeFor(fake);
    const parentForegroundProbe = {
      async read() {
        const snapshot = await baseProbe.read();
        return { ...snapshot, foregroundPid: fake.target.pid, foregroundWindowId: fake.target.windowId };
      },
    };
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", grounding: "off", windowRelationshipProbe: parentForegroundProbe,
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const parent = await computer.observe(session, "owned-window-button-parent" as ObservationId, signal);
      fake.setExtraWindowAfterClick(auxiliary);
      await computer.execute(session, {
        actionId: "owned-window-button-trigger" as ActionId,
        basedOn: "owned-window-button-parent" as ObservationId,
        kind: "click",
        point: { x: 10, y: 20 },
      }, signal, { detectNewWindowHandoff: true });
      expect(await computer.detectNewWindowHandoffCandidates(session, signal)).toEqual([]);
      const after = await computer.observe(session, "owned-window-button-parent-fresh" as ObservationId, signal);
      expect(after.surfaceRef).toMatchObject({ surfaceId: parent.surfaceRef.surfaceId, generation: parent.surfaceRef.generation });
      expect(after.surfaceTransitionReason).not.toBe("child_push");
      expect(after.grounding).toBeUndefined();
      expect(fake.calls.filter((call) => call.name === "get_accessibility_tree")).toHaveLength(0);
      expect(fake.calls.filter((call) => call.name === "get_window_state" && call.input?.window_id === auxiliary.windowId)).toHaveLength(1);
      expect(fake.calls.filter((call) => call.name === "verifyState" && call.input?.window_id === auxiliary.windowId)).toHaveLength(0);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps a cross-process exact Win32-owned auxiliary non-blocking while its parent remains foreground", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-cross-process-owned-auxiliary-"));
    const fake = windowDriver();
    const auxiliary = {
      pid: 9876,
      windowId: 8867,
      appName: "WPS floating toolbar",
      title: "Selection tools",
      bounds: { x: 300, y: 200, width: 300, height: 80 },
      zIndex: 2,
      ownerPid: fake.target.pid,
      ownerWindowId: fake.target.windowId,
      isOnScreen: true,
      minimized: false,
      windowClass: "Qt5QWindowToolSaveBits",
    };
    fake.setWindowImageSize(auxiliary.windowId, 298, 78);
    fake.setWindowGroundingState(auxiliary.windowId, {
      pid: auxiliary.pid,
      window_id: auxiliary.windowId,
      complete: true,
      elements_complete: true,
      root_surface: { pid: auxiliary.pid, window_id: auxiliary.windowId, role: "Window", complete: true },
      elements: [{ depth: 0, element_index: 0, role: "Window", enabled: true }],
    });
    const baseProbe = relationshipProbeFor(fake);
    const parentForegroundProbe = {
      async read() {
        const snapshot = await baseProbe.read();
        return { ...snapshot, foregroundPid: fake.target.pid, foregroundWindowId: fake.target.windowId };
      },
    };
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", grounding: "off", windowSwitch: "opened-windows-v1",
      windowRelationshipProbe: parentForegroundProbe, driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const parent = await computer.observe(session, "cross-process-owned-aux-parent" as ObservationId, signal);
      fake.setExtraWindowAfterClick(auxiliary);
      const receipt = await computer.execute(session, {
        actionId: "cross-process-owned-aux-trigger" as ActionId,
        basedOn: "cross-process-owned-aux-parent" as ObservationId,
        kind: "click",
        point: { x: 10, y: 20 },
      }, signal, { detectNewWindowHandoff: true });
      expect(receipt.status).toBe("completed");
      expect(await computer.detectNewWindowHandoffCandidates(session, signal)).toEqual([]);
      const after = await computer.observe(session, "cross-process-owned-aux-parent-fresh" as ObservationId, signal);
      expect(after.surfaceRef).toMatchObject({ kind: "native_window", surfaceId: parent.surfaceRef.surfaceId });
      expect(after.surfaceTransitionReason).not.toBe("child_push");
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps an unowned cross-process foreground window in manual handoff", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-cross-process-unowned-window-"));
    const fake = windowDriver();
    const candidate = {
      pid: 9877,
      windowId: 8868,
      appName: "Unowned helper",
      title: "Manual candidate",
      bounds: { x: 300, y: 200, width: 300, height: 80 },
      zIndex: 2,
      ownerPid: 0,
      ownerWindowId: 0,
      isOnScreen: true,
      minimized: false,
      windowClass: "GenericHelperWindow",
    };
    const candidateTarget = { pid: candidate.pid, windowId: candidate.windowId };
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", grounding: "off", windowSwitch: "opened-windows-v1",
      windowSwitchAllowedTargets: [fake.target, candidateTarget],
      windowRelationshipProbe: {
        async read() {
          const candidateVisible = fake.getExtraWindow() !== undefined;
          return {
            source: "win32_relationship_probe" as const,
            complete: true,
            windows: [
              {
                pid: fake.target.pid, windowId: fake.target.windowId, ownerPid: 0, ownerWindowId: 0,
                zIndex: 1, isOnScreen: true, minimized: false,
                bounds: { x: 100, y: 120, width: 960, height: 680 }, windowClass: "WPS",
              },
              ...(candidateVisible ? [{
                pid: candidate.pid, windowId: candidate.windowId, ownerPid: 0, ownerWindowId: 0,
                zIndex: candidate.zIndex, isOnScreen: true, minimized: false,
                bounds: candidate.bounds, windowClass: candidate.windowClass,
              }] : []),
            ],
            foregroundPid: candidateVisible ? candidate.pid : fake.target.pid,
            foregroundWindowId: candidateVisible ? candidate.windowId : fake.target.windowId,
          };
        },
      },
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "cross-process-unowned-parent" as ObservationId, signal);
      fake.setExtraWindowAfterClick(candidate);
      const receipt = await computer.execute(session, {
        actionId: "cross-process-unowned-trigger" as ActionId,
        basedOn: "cross-process-unowned-parent" as ObservationId,
        kind: "click",
        point: { x: 10, y: 20 },
      }, signal, { detectNewWindowHandoff: true });
      expect(receipt.status).toBe("completed");
      expect(await computer.detectNewWindowHandoffCandidates(session, signal)).toEqual([{
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

  it.each(["hidden", "absent", "visible", "non-activating", "incomplete", "minimized", "parent-missing", "parent-hidden", "replacement", "reused-hwnd", "conflict"])(
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
            ...menu, isOnScreen: scenario === "visible" || scenario === "non-activating", minimized: scenario === "minimized",
            ...(scenario === "non-activating" ? { noActivate: true } : {}),
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
          if (scenario === "hidden" || scenario === "absent" || scenario === "visible" || scenario === "non-activating") {
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
        } else if (scenario === "replacement") {
          expect(await computer.detectNewWindowHandoffCandidates(session, signal)).toEqual([]);
          const replaced = await computer.observe(session, "escape-replaced" as ObservationId, signal);
          expect(replaced.surfaceTransitionReason).toBe("child_push");
          expect(replaced.surfaceRef.surfaceId).not.toBe(child.surfaceRef.surfaceId);
          expect(replaced.surfaceRef.parentSurfaceId).toBe(parent.surfaceRef.surfaceId);
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

  it("keeps an allowed exact-owned candidate in the manual picker when UIA root evidence contradicts it", async () => {
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
      const candidates = await computer.detectNewWindowHandoffCandidates(session, signal);
      expect(candidates).toEqual([{ pid: dialog.pid, windowId: dialog.windowId, appName: dialog.appName, title: dialog.title }]);
      expect(await computer.listNewWindowHandoffCandidates(session, signal)).toEqual(candidates);
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

      const peerOption = (await computer.listWindows(session, signal)).options.find((window) => window.appName === peer.appName)!;
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
          foregroundPid: menu.pid,
          foregroundWindowId: menu.windowId,
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
        expect(await computer.detectNewWindowHandoffCandidates(session, signal)).toEqual([]);
        const child = await computer.observe(session, "counted-menu-child" as ObservationId, signal);
        expect(child.surfaceTransitionReason).toBe("child_push");
        expect(child.surfaceRef).toMatchObject({ kind: "native_window", parentSurfaceId: parent.surfaceRef.surfaceId });
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
    const initialSibling = { ...sibling, ownerPid: 0, ownerWindowId: 0, windowClass: "GenericSiblingWindow" };
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
    fake.setSecondExtraWindow(initialSibling);
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
      fake.setSecondExtraWindowAfterClick(sibling);
      const receipt = await computer.execute(session, {
        actionId: "probe-menu-ambiguous-open" as ActionId,
        basedOn: "probe-menu-ambiguous-parent" as ObservationId,
        kind: "click",
        point: { x: 12, y: 18 },
      }, signal, { detectNewWindowHandoff: true });
      expect(receipt.status).toBe("completed");
      const candidates = await computer.detectNewWindowHandoffCandidates(session, signal);
      expect(candidates).toEqual([{ pid: menu.pid, windowId: menu.windowId, appName: menu.appName, title: menu.title }]);
      expect(await computer.listNewWindowHandoffCandidates(session, signal)).toEqual(candidates);
      const current = await computer.observe(session, "probe-menu-ambiguous-still-parent" as ObservationId, signal);
      expect(current.surfaceRef).toEqual(parent.surfaceRef);
      expect(fake.calls.filter((call) => call.name === "get_window_state" && call.input?.window_id === menu.windowId)).toHaveLength(0);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps a user-confirmed new cross-process HWND as an owned child and restores its parent after close", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-confirmed-owned-child-handoff-"));
    const fake = windowDriver();
    const popup = {
      pid: 9877,
      windowId: 6424762,
      appName: "Editor helper",
      title: "Transient helper",
      bounds: { x: 300, y: 200, width: 57, height: 70 },
      zIndex: 2,
      ownerPid: fake.target.pid,
      ownerWindowId: fake.target.windowId,
      isOnScreen: true,
      minimized: false,
      windowClass: "GenericWindow",
    };
    fake.setWindowImageSize(popup.windowId, 57, 70);
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", grounding: "off", windowSwitch: "opened-windows-v1",
      windowSwitchAllowedTargets: [fake.target, { pid: popup.pid, windowId: popup.windowId }],
      windowRelationshipProbe: relationshipProbeFor(fake),
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const parent = await computer.observe(session, "confirmed-owned-handoff-parent" as ObservationId, signal);
      fake.setExtraWindow(popup);
      const candidates = await computer.listWindowHandoffCandidates(session, signal);
      expect(candidates).toEqual([{
        pid: popup.pid,
        windowId: popup.windowId,
        appName: popup.appName,
        title: popup.title,
        relationship: {
          kind: "owned_child",
          owner: { pid: fake.target.pid, windowId: fake.target.windowId },
        },
      }]);
      const selected = await computer.handoffWindow(session, candidates[0]!, signal);
      const child = await computer.observe(selected, "confirmed-owned-handoff-child" as ObservationId, signal);
      expect(child.viewport).toMatchObject({ width: 57, height: 70 });
      expect(child.surfaceRef).toMatchObject({
        kind: "native_window",
        parentSurfaceId: parent.surfaceRef.surfaceId,
        admissionSource: "win32_relationship_probe",
      });

      fake.setExtraWindow(undefined);
      const restored = await computer.observe(selected, "confirmed-owned-handoff-restored" as ObservationId, signal);
      expect(restored.surfaceRef.surfaceId).toBe(parent.surfaceRef.surfaceId);
      expect(restored.surfaceTransitionReason).toBe("child_pop");
      await computer.close(selected);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requires Host confirmation when exact root role proof is wrong", async () => {
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
      const candidates = await computer.detectNewWindowHandoffCandidates(session, signal);
      expect(candidates).toEqual([{ pid: popup.pid, windowId: popup.windowId, appName: popup.appName, title: popup.title }]);
      const selected = await computer.handoffWindow(session, candidates[0]!, signal);
      expect(fake.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(2);
      const after = await computer.observe(selected, "owned-root-host-selected" as ObservationId, signal);
      expect(after.surfaceRef.kind).toBe("native_window");
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
      const candidates = await computer.detectNewWindowHandoffCandidates(session, signal);
      expect(candidates).toEqual([{ pid: popup.pid, windowId: popup.windowId, appName: popup.appName, title: popup.title }]);
      expect(await computer.listNewWindowHandoffCandidates(session, signal)).toEqual(candidates);
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
    const baseProbe = relationshipProbeFor(fake);
    const parentForegroundProbe = {
      async read() {
        const snapshot = await baseProbe.read();
        return { ...snapshot, foregroundPid: fake.target.pid, foregroundWindowId: fake.target.windowId };
      },
    };
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", grounding: "uia-catalog-v1", windowSwitch: "opened-windows-v1",
      windowSwitchAllowedTargets: [fake.target], windowRelationshipProbe: parentForegroundProbe, driverFactory: () => fake.driver,
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
      const candidates = await computer.detectNewWindowHandoffCandidates(session, signal);
      expect(candidates).toEqual([{ pid: popup.pid, windowId: popup.windowId, appName: popup.appName, title: popup.title }]);
      expect(await computer.listNewWindowHandoffCandidates(session, signal)).toEqual(candidates);
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

  it("uses an injected visible-region PNG only for the exact HWND and one-pixel-compatible fresh geometry", async () => {
    const fake = windowDriver();
    const visibleBounds = { x: 101, y: 121, width: 961, height: 681 };
    const foregroundVisibleCapture = vi.fn(async (target: { pid: number; windowId: number }) => ({
      target,
      bounds: visibleBounds,
      data: new Uint8Array(Buffer.from(pngWithDimensions(visibleBounds.width, visibleBounds.height), "base64")),
    }));

    const capture = await captureWindowWithRetry(
      fake.driver,
      "window-visible-region",
      fake.target,
      new AbortController().signal,
      { foregroundVisibleCapture },
    );

    expect(foregroundVisibleCapture).toHaveBeenCalledTimes(1);
    expect(foregroundVisibleCapture).toHaveBeenCalledWith(fake.target, expect.any(AbortSignal));
    expect(capture).toMatchObject({
      binding: { target: fake.target, bounds: visibleBounds },
      viewport: { width: 961, height: 681, coordinateSpace: "physical" },
      source: "windows_foreground_region",
    });
    expect(capture.data).toEqual(new Uint8Array(Buffer.from(pngWithDimensions(961, 681), "base64")));
    expect(fake.calls.filter((call) => call.name === "verifyState")).toHaveLength(0);
    expect(fake.calls.filter((call) => call.name === "list_windows")).toHaveLength(1);
  });

  it("executes from a native visible-region observation while checking fresh CUA geometry separately", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-visible-region-geometry-"));
    const fake = windowDriver();
    const captureBounds = { x: 101, y: 121, width: 961, height: 681 };
    const png = new Uint8Array(Buffer.from(pngWithDimensions(captureBounds.width, captureBounds.height), "base64"));
    const foregroundVisibleCapture = vi.fn(async (target: { pid: number; windowId: number }) => ({
      target,
      bounds: captureBounds,
      data: png,
    }));
    const computer = new CuaDriverComputer({
      socketPath: "fixture",
      screenshotDir: directory,
      windowTarget: fake.target,
      windowDeliveryMode: "foreground",
      windowSwitch: "opened-windows-v1",
      windowSwitchAllowedTargets: [fake.target],
      windowCaptureRetry: { foregroundVisibleCapture },
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const observation = await computer.observe(session, "visible-region-geometry-observation" as ObservationId, signal);
      expect(observation).toMatchObject({
        viewport: { width: 961, height: 681, coordinateSpace: "physical" },
        screenshot: { data: png },
      });

      const receipt = await computer.execute(session, {
        actionId: "visible-region-geometry-click" as ActionId,
        basedOn: "visible-region-geometry-observation" as ObservationId,
        kind: "click",
        point: { x: 10, y: 20 },
      }, signal, { detectNewWindowHandoff: true });

      expect(receipt.status).toBe("completed");
      await expect(computer.detectNewWindowHandoffCandidates(session, signal)).resolves.toEqual([]);
      const click = fake.calls.filter((call) => call.name === "click").at(-1);
      expect(click?.input).toMatchObject({
        target: { kind: "window", pid: fake.target.pid, window_id: fake.target.windowId },
        x: 10,
        y: 20,
      });
      expect(foregroundVisibleCapture).toHaveBeenCalledTimes(2);
      expect(fake.calls.filter((call) => call.name === "verifyState")).toHaveLength(0);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("falls back to isolated CUA capture when the visible-region identity is stale", async () => {
    const fake = windowDriver();
    const foregroundVisibleCapture = vi.fn(async (target: { pid: number; windowId: number }) => ({
      target: { ...target, windowId: target.windowId + 1 },
      bounds: { x: 100, y: 120, width: 960, height: 680 },
      data: new Uint8Array(Buffer.from(pngWithDimensions(960, 680), "base64")),
    }));

    const capture = await captureWindowWithRetry(
      fake.driver,
      "window-visible-region-stale",
      fake.target,
      new AbortController().signal,
      { foregroundVisibleCapture },
    );

    expect(capture.source).toBe("verify_state");
    expect(capture.binding).toMatchObject({ target: fake.target, bounds: { x: 100, y: 120, width: 960, height: 680 } });
    expect(fake.calls.filter((call) => call.name === "verifyState")).toHaveLength(1);
  });

  it("recognizes only local Windows named-pipe socket endpoints for native pixel access", () => {
    expect(isLocalWindowsNamedPipeSocket(String.raw`\\.\pipe\computer-harness-pi-local`)).toBe(true);
    expect(isLocalWindowsNamedPipeSocket(String.raw`\\server\pipe\computer-harness-pi-local`)).toBe(false);
    expect(isLocalWindowsNamedPipeSocket("tcp://127.0.0.1:4318")).toBe(false);
    expect(isLocalWindowsNamedPipeSocket("\\\\.\\pipe\\")).toBe(false);
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
      const nativeClick = await computer.execute(session, {
        actionId: "hybrid-region-content-click" as ActionId,
        basedOn: observationId,
        kind: "click",
        point: { x: content!.bbox!.x + content!.bbox!.width / 2, y: content!.bbox!.y + content!.bbox!.height / 2 },
        groundingRef: content!.elementRef,
      }, new AbortController().signal);
      expect(nativeClick.status).toBe("completed");
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(1);
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

      const wpsOption = (await computer.listWindows(managedSession, signal)).options.find((window) => window.title === "HarnessProbe-WPS-Doc")!;
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

      const managedReturnOption = (await computer.listWindows(nativeSession, signal)).options.find((window) => window.title === "Safe fixture")!;
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

  it.each(["click", "select_option"] as const)("clears the unknown-action guard only after a completed managed DOM %s and fresh observe", async (alternativeKind) => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-dom-unknown-guard-"));
    const fake = windowDriver({ x: 0, y: 0, width: 1000, height: 800 }, { width: 1000, height: 800 });
    fake.setGroundingState({ elements_complete: true, elements: [
      { role: "Document", frame: { x: 0, y: 0, width: 1000, height: 800 }, enabled: true },
    ] });
    const browserTarget: ManagedBrowserTarget = {
      kind: "managed-chromium", browser: "chromium", profileId: "fixture-profile", windowTarget: fake.target,
      tabId: "tab-fixture", generation: "generation-1", delivery: "loopback-cdp",
    };
    const transport = createMockDomGroundingTransport({
      complete: true, tabId: "tab-fixture", generation: "generation-1", coordinateSpace: "physical",
      candidates: [{
        tagName: alternativeKind === "click" ? "a" : "select", name: "Alternative", frame: { x: 100, y: 100, width: 120, height: 40 },
        visible: true, interactive: true, state: { enabled: true },
        ...(alternativeKind === "select_option" ? { options: [{ text: "Choice", enabled: true }] } : {}),
      }],
    });
    const actionTransport: DomGroundingTransport = {
      ...transport,
      click: async () => ({ status: "completed", tabId: "tab-fixture", generation: "generation-1" }),
      selectOption: async () => ({ status: "completed", tabId: "tab-fixture", generation: "generation-1" }),
    };
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory,
      windowTarget: fake.target, windowDeliveryMode: "foreground", grounding: "hybrid-catalog-v1",
      browserTarget, domGroundingTransport: actionTransport, driverFactory: () => fake.driver });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const initialId = "dom-guard-initial" as ObservationId;
      await computer.observe(session, initialId, signal);
      fake.setForegroundRefusal(true, "foreground_unavailable: foreground changed after dispatch; input outcome unknown");
      expect(await computer.execute(session, {
        actionId: "dom-guard-unknown" as ActionId, basedOn: initialId, kind: "click", point: { x: 10, y: 20 },
      }, signal)).toMatchObject({ status: "partial", driverCode: "ACTION_OUTCOME_UNKNOWN" });
      fake.setForegroundRefusal(false);
      const alternativeId = "dom-guard-alternative" as ObservationId;
      const fresh = await computer.observe(session, alternativeId, signal);
      const element = fresh.grounding!.elements.find((item) => item.source === "dom" && item.name === "Alternative")!;
      const receipt = await computer.execute(session, alternativeKind === "click" ? {
        actionId: "dom-guard-alternative-action" as ActionId, basedOn: alternativeId, kind: "click",
        groundingRef: element.elementRef, point: { x: 160, y: 120 },
      } : {
        actionId: "dom-guard-alternative-action" as ActionId, basedOn: alternativeId, kind: "select_option",
        groundingRef: element.elementRef, optionText: "Choice",
      }, signal);
      expect(receipt).toMatchObject({ status: "completed" });
      expect(await computer.execute(session, {
        actionId: "dom-guard-before-fresh" as ActionId, basedOn: alternativeId, kind: "click", point: { x: 10, y: 20 },
      }, signal)).toMatchObject({ status: "refused", driverCode: "ACTION_OUTCOME_UNKNOWN_RETRY_BLOCKED" });
      const finalId = "dom-guard-final" as ObservationId;
      await computer.observe(session, finalId, signal);
      expect(await computer.execute(session, {
        actionId: "dom-guard-after-fresh" as ActionId, basedOn: finalId, kind: "click", point: { x: 10, y: 20 },
      }, signal)).toMatchObject({ status: "completed" });
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
      const shortcutTool = platform === "win32" ? "press_key" : "hotkey";
      const dispatch = vi.spyOn(fake.driver, "callTool").mockImplementation(async (name, ...args) => {
        if (name === shortcutTool) throw new Error("unknown shortcut outcome");
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

  it.each(["missing", "partial", "ambiguous"] as const)("uses the guarded UIA point path when DOM equivalence is %s and matches a visual click", async (scenario) => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-uia-dom-gate-"));
    const fake = windowDriver({ x: 0, y: 0, width: 1000, height: 800 }, { width: 1000, height: 800 });
    fake.setGroundingState({ elements_complete: true, elements: [
      { role: "Document", frame: { x: 0, y: 80, width: 1000, height: 720 }, enabled: true },
      { role: "Button", name: "Continue", frame: { x: 100, y: 200, width: 120, height: 40 }, enabled: true },
      { role: "Button", name: "Disabled control", frame: { x: 300, y: 300, width: 100, height: 40 }, enabled: false },
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
      const point = { x: 160, y: 220 };
      expect(await computer.execute(session, { kind: "click", actionId: "uia-fallback" as ActionId, basedOn, groundingRef: candidate.elementRef, point }, signal)).toMatchObject({ status: "completed" });
      expect(await computer.execute(session, { kind: "click", actionId: "visual-fallback" as ActionId, basedOn, point }, signal)).toMatchObject({ status: "completed" });
      const nativeClicks = fake.calls.filter((call) => call.name === "click");
      expect(nativeClicks).toHaveLength(2);
      expect(nativeClicks[0]?.input).toEqual(nativeClicks[1]?.input);
      expect(transport.click).not.toHaveBeenCalled();

      const disabled = observation.grounding!.elements.find((item) => item.source === "uia" && item.name === "Disabled control")!;
      expect(await computer.execute(session, {
        kind: "click",
        actionId: "uia-disabled" as ActionId,
        basedOn,
        groundingRef: disabled.elementRef,
        point: { x: disabled.bbox!.x + disabled.bbox!.width / 2, y: disabled.bbox!.y + disabled.bbox!.height / 2 },
      }, signal)).toMatchObject({ status: "refused", driverCode: "GROUNDING_ELEMENT_DISABLED" });
      expect(await computer.execute(session, {
        kind: "click",
        actionId: "uia-point-mismatch" as ActionId,
        basedOn,
        groundingRef: candidate.elementRef,
        point: { x: point.x + 1, y: point.y },
      }, signal)).toMatchObject({ status: "refused", driverCode: "GROUNDING_POINT_MISMATCH" });
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(2);

      await computer.observe(session, "uia-content-refreshed" as ObservationId, signal);
      expect(await computer.execute(session, { kind: "click", actionId: "uia-stale" as ActionId, basedOn, groundingRef: candidate.elementRef, point }, signal)).toMatchObject({ status: "refused", driverCode: "STALE_OBSERVATION" });
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(2);
      await computer.close(session);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("routes a screenshot-point click from a DOM Surface through the exact-target CUA path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-dom-surface-raw-click-"));
    const fake = windowDriver({ x: 0, y: 0, width: 1000, height: 800 }, { width: 1000, height: 800 });
    const browserTarget: ManagedBrowserTarget = { kind: "managed-chromium", browser: "chromium", profileId: "fixture", windowTarget: fake.target, tabId: "tab-dom-raw", generation: "generation-dom-raw", delivery: "loopback-cdp" };
    const transport = createMockDomGroundingTransport(() => ({
      complete: true,
      tabId: browserTarget.tabId,
      generation: browserTarget.generation,
      coordinateSpace: "physical",
      candidates: [{ tagName: "button", ariaRole: "button", name: "Search", frame: { x: 100, y: 200, width: 120, height: 40 }, visible: true, interactive: true, state: { enabled: true } }],
    }));
    const computer = new CuaDriverComputer({
      socketPath: "test-socket",
      screenshotDir: directory,
      windowTarget: fake.target,
      windowDeliveryMode: "foreground",
      grounding: "dom-catalog-v1",
      browserTarget,
      domGroundingTransport: transport,
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const observationId = "dom-surface-raw-click-observation" as ObservationId;
      const observation = await computer.observe(session, observationId, signal);
      expect(observation.surfaceRef.kind).toBe("browser_tab");
      expect(observation.grounding?.source).toBe("dom");

      const point = { x: 160, y: 220 };
      const receipt = await computer.execute(session, {
        kind: "click",
        actionId: "dom-surface-screenshot-point-click" as ActionId,
        basedOn: observationId,
        point,
      }, signal);

      expect(receipt.status).toBe("completed");
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(1);
      expect(fake.calls.find((call) => call.name === "click")?.input).toMatchObject({
        target: { kind: "window", pid: fake.target.pid, window_id: fake.target.windowId },
        x: point.x,
        y: point.y,
        delivery_mode: "foreground",
      });
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
        const option = (await computer.listWindows(session, signal)).options.find((item) => item.title === title)!;
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
    const verifyFocus = vi.fn(async () => focus
      ? ({ status: "completed" as const, tabId: browserTarget.tabId, generation: browserTarget.generation })
      : ({ status: "refused" as const, driverCode: "DOM_INPUT_FOCUS_MISMATCH" }));
    const transport: DomGroundingTransport = {
      kind: "managed-loopback-cdp-v1",
      collect: async () => ({ tabId: browserTarget.tabId, generation: browserTarget.generation, coordinateSpace: "physical", complete: true, candidates: [{ tagName: "input", ariaRole: "textbox", inputType: "text", name: "Query", frame: { x: 100, y: 100, width: 120, height: 40 }, visible: true, interactive: true, state: { enabled: true, editable: true, focused: focus } }] }),
      click: vi.fn(async () => { throw new Error("editable input must never dispatch programmatic click"); }),
      validateClick: vi.fn(async () => ({ status: "completed" as const, tabId: browserTarget.tabId, generation: browserTarget.generation })),
      verifyFocus,
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
      const verifyCallsBeforeEscape = verifyFocus.mock.calls.length;
      expect(await computer.execute(session, { kind: "keypress", actionId: "escape-unfocused" as ActionId, basedOn: observationId, keys: ["ESC"] }, signal)).toMatchObject({ status: "completed" });
      expect(verifyFocus).toHaveBeenCalledTimes(verifyCallsBeforeEscape);
      expect(fake.calls.filter((call) => call.name === "press_key")).toHaveLength(1);
      expect(await type("still-protected")).toMatchObject({ status: "refused" });
      expect(verifyFocus).toHaveBeenCalledTimes(verifyCallsBeforeEscape + 1);
      expect(await computer.execute(session, { kind: "keypress", actionId: "enter-unfocused" as ActionId, basedOn: observationId, keys: ["ENTER"] }, signal)).toMatchObject({ status: "refused", driverCode: "DOM_INPUT_FOCUS_MISMATCH" });
      expect(fake.calls.filter((call) => call.name === "press_key")).toHaveLength(1);
      expect(fake.calls.filter((call) => call.name === "type_text")).toHaveLength(0);
      const verifyCallsBeforeEscapeAlias = verifyFocus.mock.calls.length;
      fake.failActionOnCall(3, "foreground_unavailable: exact target HWND not active; no keyboard input was sent", "WINDOW_FOREGROUND_MISMATCH");
      expect(await computer.execute(session, { kind: "keypress", actionId: "escape-alias-foreground-refused" as ActionId, basedOn: observationId, keys: ["ESCAPE"] }, signal)).toMatchObject({ status: "refused", driverCode: "WINDOW_FOREGROUND_MISMATCH" });
      expect(verifyFocus).toHaveBeenCalledTimes(verifyCallsBeforeEscapeAlias);
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
      expect(fake.calls.find((call) => call.name === "press_key" && call.input?.modifiers !== undefined)?.input).toMatchObject({
        target: { kind: "window", pid: 1234, window_id: 5678 },
        key: "A",
        modifiers: ["ctrl"],
        delivery_mode: "foreground",
      });
      expect(fake.calls.filter((call) => call.name === "hotkey")).toHaveLength(0);

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

  it.each([
    ["Shift+Home", ["SHIFT", "HOME"], "HOME", ["shift"]],
    ["Alt+F4", ["ALT", "F4"], "F4", ["alt"]],
    ["Control alias", ["CONTROL", "A"], "A", ["ctrl"]],
  ] as const)("uses exact-target foreground press_key modifiers for %s", async (_label, keys, key, modifiers) => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-foreground-modifier-chord-"));
    const fake = windowDriver();
    const computer = new CuaDriverComputer({
      socketPath: "test-socket",
      screenshotDir: directory,
      windowTarget: fake.target,
      windowDeliveryMode: "foreground",
      driverFactory: () => fake.driver,
    });
    try {
      const signal = new AbortController().signal;
      const session = await computer.open({}, signal);
      await computer.observe(session, "foreground-modifier-chord-observation" as ObservationId, signal);
      const receipt = await computer.execute(session, {
        actionId: `foreground-modifier-chord-${key}-${modifiers[0]}` as ActionId,
        basedOn: "foreground-modifier-chord-observation" as ObservationId,
        kind: "keypress",
        keys: [...keys],
      }, signal);
      expect(receipt).toMatchObject({ status: "completed" });
      expect(fake.calls.filter((call) => call.name === "press_key")).toHaveLength(1);
      expect(fake.calls.find((call) => call.name === "press_key")?.input).toMatchObject({
        session: session.id,
        target: { kind: "window", pid: fake.target.pid, window_id: fake.target.windowId },
        key,
        modifiers: [...modifiers],
        delivery_mode: "foreground",
      });
      expect(fake.calls.filter((call) => call.name === "hotkey")).toHaveLength(0);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["multiple base keys", ["CTRL", "A", "B"]],
    ["unknown modifier", ["CTRL", "HYPER", "A"]],
    ["duplicate modifier aliases", ["CTRL", "CONTROL", "A"]],
  ] as const)("leaves %s on the existing foreground hotkey route", async (_label, keys) => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-foreground-modifier-unmapped-"));
    const fake = windowDriver();
    const computer = new CuaDriverComputer({
      socketPath: "test-socket",
      screenshotDir: directory,
      windowTarget: fake.target,
      windowDeliveryMode: "foreground",
      driverFactory: () => fake.driver,
    });
    try {
      const signal = new AbortController().signal;
      const session = await computer.open({}, signal);
      await computer.observe(session, "foreground-modifier-unmapped-observation" as ObservationId, signal);
      const receipt = await computer.execute(session, {
        actionId: `foreground-modifier-unmapped-${_label}` as ActionId,
        basedOn: "foreground-modifier-unmapped-observation" as ObservationId,
        kind: "keypress",
        keys: [...keys],
      }, signal);
      expect(receipt).toMatchObject({ status: "completed" });
      expect(fake.calls.filter((call) => call.name === "hotkey")).toHaveLength(1);
      expect(fake.calls.find((call) => call.name === "hotkey")?.input).toMatchObject({
        target: { kind: "window", pid: fake.target.pid, window_id: fake.target.windowId },
        keys: [...keys],
        delivery_mode: "foreground",
      });
      expect(fake.calls.filter((call) => call.name === "press_key")).toHaveLength(0);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["background", "win32", "background"],
    ["non-Windows", "linux", "foreground"],
  ] as const)("preserves the prior hotkey route or refusal for %s input", async (_label, platform, deliveryMode) => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-modifier-chord-legacy-route-"));
    const fake = windowDriver();
    fake.setPlatform(platform);
    const computer = new CuaDriverComputer({
      socketPath: "test-socket",
      screenshotDir: directory,
      windowTarget: fake.target,
      windowDeliveryMode: deliveryMode,
      platform,
      driverFactory: () => fake.driver,
    });
    try {
      const signal = new AbortController().signal;
      const session = await computer.open({}, signal);
      await computer.observe(session, "modifier-chord-legacy-observation" as ObservationId, signal);
      const receipt = await computer.execute(session, {
        actionId: `modifier-chord-legacy-${platform}-${deliveryMode}` as ActionId,
        basedOn: "modifier-chord-legacy-observation" as ObservationId,
        kind: "keypress",
        keys: ["CTRL", "A"],
      }, signal);
      if (deliveryMode === "background") {
        expect(receipt).toMatchObject({ status: "refused", driverCode: "WINDOW_INPUT_UNSUPPORTED" });
        expect(fake.calls.filter((call) => call.name === "hotkey" || call.name === "press_key")).toHaveLength(0);
      } else {
        expect(receipt).toMatchObject({ status: "completed" });
        expect(fake.calls.find((call) => call.name === "hotkey")?.input).toMatchObject({
          target: { kind: "window", pid: fake.target.pid, window_id: fake.target.windowId },
          keys: ["CTRL", "A"],
          delivery_mode: deliveryMode,
        });
        expect(fake.calls.filter((call) => call.name === "press_key")).toHaveLength(0);
      }
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves foreground refusal without trying the same chord through hotkey", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-modifier-chord-refusal-"));
    const fake = windowDriver();
    const computer = new CuaDriverComputer({
      socketPath: "test-socket",
      screenshotDir: directory,
      windowTarget: fake.target,
      windowDeliveryMode: "foreground",
      driverFactory: () => fake.driver,
    });
    try {
      const signal = new AbortController().signal;
      const session = await computer.open({}, signal);
      await computer.observe(session, "modifier-chord-refusal-observation" as ObservationId, signal);
      fake.failActionOnCall(1, "foreground_unavailable: exact target HWND not active; no keyboard input was sent");
      const receipt = await computer.execute(session, {
        actionId: "modifier-chord-foreground-refused" as ActionId,
        basedOn: "modifier-chord-refusal-observation" as ObservationId,
        kind: "keypress",
        keys: ["CTRL", "A"],
      }, signal);
      expect(receipt).toMatchObject({ status: "refused", driverCode: "WINDOW_FOREGROUND_MISMATCH" });
      expect(fake.calls.filter((call) => call.name === "press_key")).toHaveLength(1);
      expect(fake.calls.filter((call) => call.name === "hotkey")).toHaveLength(0);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not fall back to hotkey after an aborted foreground press_key chord", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-modifier-chord-abort-"));
    const fake = windowDriver();
    const computer = new CuaDriverComputer({
      socketPath: "test-socket",
      screenshotDir: directory,
      windowTarget: fake.target,
      windowDeliveryMode: "foreground",
      driverFactory: () => fake.driver,
    });
    const controller = new AbortController();
    let session: import("@computer-harness/protocol").ComputerSessionDescriptor | undefined;
    try {
      session = await computer.open({}, controller.signal);
      await computer.observe(session, "modifier-chord-abort-observation" as ObservationId, controller.signal);
      const originalCallTool = fake.driver.callTool.bind(fake.driver);
      fake.driver.callTool = async (name, inputJson, options) => {
        if (name === "press_key") {
          fake.calls.push({ name, input: JSON.parse(inputJson) as Record<string, unknown> });
          controller.abort(new Error("fixture key chord abort"));
          throw controller.signal.reason;
        }
        return originalCallTool(name, inputJson, options);
      };
      await expect(computer.execute(session, {
        actionId: "modifier-chord-aborted" as ActionId,
        basedOn: "modifier-chord-abort-observation" as ObservationId,
        kind: "keypress",
        keys: ["CTRL", "A"],
      }, controller.signal)).rejects.toThrow(/fixture key chord abort/u);
      expect(controller.signal.aborted).toBe(true);
      expect(fake.calls.filter((call) => call.name === "press_key")).toHaveLength(1);
      expect(fake.calls.filter((call) => call.name === "hotkey")).toHaveLength(0);
    } finally {
      if (session !== undefined) await computer.close(session).catch(() => undefined);
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
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", grounding: "uia-catalog-v1", driverFactory: () => fake.driver });
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

  it("privately resolves default-off multiline input against only the exact current window", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-multiline-private-off-"));
    const fake = windowDriver();
    fake.setTypeTextResult({ structuredJson: JSON.stringify({ effect: "confirmed", evidence: [{ kind: "value_readback" }] }) });
    fake.setWindowGroundingState(fake.target.windowId, { snapshot_id: "s00000111", elements_complete: true, elements: [
      { role: "Document", frame: { x: 140, y: 160, width: 700, height: 420 }, element_token: "exact-window-token" },
    ] });
    fake.setWindowGroundingState(fake.target.windowId + 1, { snapshot_id: "s-wrong-window", elements_complete: true, elements: [
      { role: "Document", frame: { x: 140, y: 160, width: 700, height: 420 }, element_token: "wrong-window-token" },
    ] });
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory,
      windowTarget: fake.target, windowDeliveryMode: "foreground", grounding: "off", driverFactory: () => fake.driver });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const capture = await computer.observe(session, "multiline-private-off-observation" as ObservationId, signal);
      expect(capture.grounding).toBeUndefined();
      expect(fake.calls.filter((call) => call.name === "get_window_state")).toHaveLength(0);

      const receipt = await computer.execute(session, {
        actionId: "multiline-private-off-action" as ActionId,
        basedOn: "multiline-private-off-observation" as ObservationId,
        kind: "type",
        text: "first\nsecond",
      }, signal);
      expect(receipt).toMatchObject({ status: "completed" });
      expect(JSON.stringify(capture)).not.toContain("exact-window-token");
      expect(fake.calls.filter((call) => call.name === "get_window_state")).toHaveLength(1);
      expect(fake.calls.find((call) => call.name === "get_window_state")?.input).toMatchObject({
        pid: fake.target.pid,
        window_id: fake.target.windowId,
        include_screenshot: false,
        max_depth: 16,
        max_elements: 256,
      });
      expect(fake.calls.find((call) => call.name === "type_text")?.input).toMatchObject({
        pid: fake.target.pid,
        window_id: fake.target.windowId,
        element_token: "exact-window-token",
        snapshot_id: "s00000111",
        text: "first\rsecond",
        delivery_mode: "background",
      });
      expect(JSON.stringify(receipt)).not.toContain("exact-window-token");
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { name: "partial UIA data", complete: false, elements: [
      { role: "Document", frame: { x: 140, y: 160, width: 700, height: 420 }, element_token: "partial-token" },
    ], code: "MULTILINE_GROUNDING_INCOMPLETE" },
    { name: "no editable surface", complete: true, elements: [
      { role: "Button", name: "Save", frame: { x: 200, y: 240, width: 120, height: 32 }, element_token: "button-token" },
    ], code: "MULTILINE_TARGET_NOT_FOUND" },
  ])("keeps default-off private multiline resolution fail-closed for $name", async ({ complete, elements, code }) => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-multiline-private-refuse-"));
    const fake = windowDriver();
    fake.setGroundingState({ snapshot_id: "s-private-refusal", elements_complete: complete, elements });
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory,
      windowTarget: fake.target, windowDeliveryMode: "foreground", grounding: "off", driverFactory: () => fake.driver });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "multiline-private-refusal-observation" as ObservationId, signal);
      const receipt = await computer.execute(session, {
        actionId: "multiline-private-refusal-action" as ActionId,
        basedOn: "multiline-private-refusal-observation" as ObservationId,
        kind: "type",
        text: "first\nsecond",
      }, signal);
      expect(receipt).toMatchObject({ status: "refused", driverCode: code });
      expect(fake.calls.filter((call) => call.name === "get_window_state")).toHaveLength(1);
      expect(fake.calls.some((call) => call.name === "type_text" || call.name === "press_key")).toBe(false);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses private multiline UIA results that explicitly identify a neighboring window", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-multiline-private-wrong-window-"));
    const fake = windowDriver();
    fake.setGroundingState({ pid: fake.target.pid, window_id: fake.target.windowId + 1,
      snapshot_id: "s00000112", elements_complete: true, elements: [
        { role: "Document", frame: { x: 140, y: 160, width: 700, height: 420 }, element_token: "neighbor-root-token" },
      ] });
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory,
      windowTarget: fake.target, windowDeliveryMode: "foreground", grounding: "off", driverFactory: () => fake.driver });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "multiline-private-wrong-window-observation" as ObservationId, signal);
      const receipt = await computer.execute(session, {
        actionId: "multiline-private-wrong-window-action" as ActionId,
        basedOn: "multiline-private-wrong-window-observation" as ObservationId,
        kind: "type",
        text: "first\nsecond",
      }, signal);
      expect(receipt).toMatchObject({ status: "refused" });
      expect(fake.calls.find((call) => call.name === "get_window_state")?.input).toMatchObject({
        pid: fake.target.pid,
        window_id: fake.target.windowId,
      });
      expect(fake.calls.some((call) => call.name === "type_text" || call.name === "press_key")).toBe(false);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses a timed-out private multiline UIA lookup and aborts only the read request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-multiline-private-timeout-"));
    const fake = windowDriver();
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory,
      windowTarget: fake.target, windowDeliveryMode: "foreground", grounding: "off", driverFactory: () => fake.driver });
    const controller = new AbortController();
    let lookupAborted = false;
    try {
      const session = await computer.open({}, controller.signal);
      await computer.observe(session, "multiline-private-timeout-observation" as ObservationId, controller.signal);
      const originalCallTool = fake.driver.callTool.bind(fake.driver);
      let markLookupStarted!: () => void;
      const lookupStarted = new Promise<void>((resolve) => { markLookupStarted = resolve; });
      fake.driver.callTool = async (name, inputJson, options) => {
        if (name === "get_window_state" && JSON.parse(inputJson).include_screenshot === false) {
          fake.calls.push({ name, input: JSON.parse(inputJson) as Record<string, unknown> });
          markLookupStarted();
          const querySignal = options?.signal;
          if (querySignal === undefined) throw new Error("private UIA query signal missing");
          if (querySignal.aborted) {
            lookupAborted = true;
            throw querySignal.reason;
          }
          await new Promise<never>((_resolve, reject) => {
            querySignal.addEventListener("abort", () => {
              lookupAborted = true;
              reject(querySignal.reason);
            }, { once: true });
          });
        }
        return originalCallTool(name, inputJson, options);
      };

      vi.useFakeTimers();
      const pending = computer.execute(session, {
        actionId: "multiline-private-timeout-action" as ActionId,
        basedOn: "multiline-private-timeout-observation" as ObservationId,
        kind: "type",
        text: "first\nsecond",
      }, controller.signal);
      await lookupStarted;
      await vi.advanceTimersByTimeAsync(10_000);
      const receipt = await pending;
      vi.useRealTimers();
      expect(receipt).toMatchObject({ status: "refused" });
      expect(controller.signal.aborted).toBe(false);
      expect(lookupAborted).toBe(true);
      expect(fake.calls.filter((call) => call.name === "get_window_state")).toHaveLength(1);
      expect(fake.calls.some((call) => call.name === "type_text" || call.name === "press_key")).toBe(false);
      await computer.close(session);
    } finally {
      vi.useRealTimers();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not use private multiline evidence if its exact Observation is superseded during lookup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-multiline-private-stale-"));
    const fake = windowDriver();
    fake.setGroundingState({ snapshot_id: "s-private-stale", elements_complete: true, elements: [
      { role: "Document", frame: { x: 140, y: 160, width: 700, height: 420 }, element_token: "stale-private-token" },
    ] });
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory,
      windowTarget: fake.target, windowDeliveryMode: "foreground", grounding: "off", driverFactory: () => fake.driver });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "multiline-private-stale-observation" as ObservationId, signal);
      const originalCallTool = fake.driver.callTool.bind(fake.driver);
      let releaseLookup!: () => void;
      let markLookupStarted!: () => void;
      const lookupStarted = new Promise<void>((resolve) => { markLookupStarted = resolve; });
      const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
      fake.driver.callTool = async (name, inputJson, options) => {
        if (name === "get_window_state" && JSON.parse(inputJson).include_screenshot === false) {
          markLookupStarted();
          await lookupGate;
        }
        return originalCallTool(name, inputJson, options);
      };

      const pending = computer.execute(session, {
        actionId: "multiline-private-stale-action" as ActionId,
        basedOn: "multiline-private-stale-observation" as ObservationId,
        kind: "type",
        text: "first\nsecond",
      }, signal);
      await lookupStarted;
      await computer.observe(session, "multiline-private-stale-replacement" as ObservationId, signal);
      releaseLookup();
      const receipt = await pending;
      expect(receipt).toMatchObject({ status: "refused", driverCode: "MULTILINE_GROUNDING_STALE" });
      expect(fake.calls.some((call) => call.name === "type_text" || call.name === "press_key")).toBe(false);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("stops default-off private multiline resolution when the action is aborted after UIA returns", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-multiline-private-abort-"));
    const fake = windowDriver();
    fake.setGroundingState({ snapshot_id: "s-private-abort", elements_complete: true, elements: [
      { role: "Document", frame: { x: 140, y: 160, width: 700, height: 420 }, element_token: "abort-private-token" },
    ] });
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory,
      windowTarget: fake.target, windowDeliveryMode: "foreground", grounding: "off", driverFactory: () => fake.driver });
    const controller = new AbortController();
    try {
      const session = await computer.open({}, controller.signal);
      await computer.observe(session, "multiline-private-abort-observation" as ObservationId, controller.signal);
      const originalCallTool = fake.driver.callTool.bind(fake.driver);
      fake.driver.callTool = async (name, inputJson, options) => {
        const response = await originalCallTool(name, inputJson, options);
        if (name === "get_window_state" && JSON.parse(inputJson).include_screenshot === false) {
          controller.abort(Object.assign(new Error("fixture abort after private UIA lookup"), { name: "AbortError" }));
        }
        return response;
      };
      await expect(computer.execute(session, {
        actionId: "multiline-private-abort-action" as ActionId,
        basedOn: "multiline-private-abort-observation" as ObservationId,
        kind: "type",
        text: "first\nsecond",
      }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
      expect(fake.calls.filter((call) => call.name === "get_window_state")).toHaveLength(1);
      expect(fake.calls.some((call) => call.name === "type_text" || call.name === "press_key")).toBe(false);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["darwin", "linux"])("preserves the native multiline type_text route on %s with the Windows-only profile present", async (platform) => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-multiline-platform-"));
    const fake = windowDriver();
    fake.setPlatform(platform);
    fake.setGroundingState({ snapshot_id: "s00000001", elements_complete: true, elements: [
      { role: "Document", name: "Document", frame: { x: 140, y: 160, width: 700, height: 420 }, element_token: "platform-target-token" },
    ] });
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target, windowDeliveryMode: "foreground", grounding: "uia-catalog-v1", multilineTypeProfile: "foreground-caret-v1", driverFactory: () => fake.driver });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "multiline-platform-observation" as ObservationId, signal);
      const receipt = await computer.execute(session, {
        actionId: "multiline-platform-native" as ActionId,
        basedOn: "multiline-platform-observation" as ObservationId,
        kind: "type",
        text: "first\nsecond",
      }, signal);
      expect(receipt).toMatchObject({ status: "completed" });
      expect(fake.calls.find((call) => call.name === "type_text")?.input).toMatchObject({
        target: { kind: "window", pid: fake.target.pid, window_id: fake.target.windowId },
        text: "first\nsecond",
        delivery_mode: "foreground",
      });
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses ordinary foreground typing for an ungrounded Windows multiline window action when opted in", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-window-caret-multiline-"));
    const fake = windowDriver();
    fake.setGroundingState({ snapshot_id: "s00000001", elements_complete: true, elements: [
      { role: "Document", name: "Document", frame: { x: 140, y: 160, width: 700, height: 420 }, element_token: "unique-editor-token" },
    ] });
    const computer = new CuaDriverComputer({
      socketPath: "test-socket",
      screenshotDir: directory,
      windowTarget: fake.target,
      windowDeliveryMode: "foreground",
      grounding: "uia-catalog-v1",
      multilineTypeProfile: "foreground-caret-v1",
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    const text = "first🙂\nsecond";
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "window-caret-type-before" as ObservationId, signal);
      const receipt = await computer.execute(session, {
        actionId: "window-caret-type-action" as ActionId,
        basedOn: "window-caret-type-before" as ObservationId,
        kind: "type",
        text,
      }, signal);

      expect(receipt.status).toBe("completed");
      expect(fake.calls.filter((call) => call.name === "type_text")).toHaveLength(1);
      expect(fake.calls.find((call) => call.name === "type_text")?.input).toMatchObject({
        target: { kind: "window", pid: fake.target.pid, window_id: fake.target.windowId },
        text,
        delivery_mode: "foreground",
      });
      expect(fake.calls.find((call) => call.name === "type_text")?.input).not.toHaveProperty("element_token");
      expect(fake.calls.some((call) => call.name === "press_key")).toBe(false);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps candidate-profile foreground input unknown and non-replayable after ambiguous dispatch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-caret-unknown-outcome-"));
    const fake = windowDriver();
    const computer = new CuaDriverComputer({
      socketPath: "test-socket",
      screenshotDir: directory,
      multilineTypeProfile: "foreground-caret-v1",
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "caret-unknown-before" as ObservationId, signal);
      fake.setTypeTextResult({ isError: true, errorCode: "GENERIC_FAILURE", text: "foreground_input_outcome_unknown: dispatch may have begun before foreground drift" });
      const partial = await computer.execute(session, {
        actionId: "caret-unknown-action" as ActionId,
        basedOn: "caret-unknown-before" as ObservationId,
        kind: "type",
        text: "first\nsecond",
      }, signal);
      expect(partial).toMatchObject({ status: "partial", driverCode: "ACTION_OUTCOME_UNKNOWN" });
      expect(fake.calls.filter((call) => call.name === "type_text")).toHaveLength(1);

      fake.setTypeTextResult(undefined);
      await computer.observe(session, "caret-unknown-fresh" as ObservationId, signal);
      const replay = await computer.execute(session, {
        actionId: "caret-unknown-replay" as ActionId,
        basedOn: "caret-unknown-fresh" as ObservationId,
        kind: "type",
        text: "first\nsecond",
      }, signal);
      expect(replay).toMatchObject({ status: "refused", driverCode: "ACTION_OUTCOME_UNKNOWN_RETRY_BLOCKED" });
      expect(fake.calls.filter((call) => call.name === "type_text")).toHaveLength(1);
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

  it("keeps explicit UIA elementRef on the append-to-end route when caret typing is enabled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-multiline-nonempty-"));
    const fake = windowDriver();
    fake.setTypeTextResult({ structuredJson: JSON.stringify({ effect: "confirmed", evidence: [{ kind: "value_readback" }] }) });
    fake.setGroundingState({ snapshot_id: "s00000001", elements_complete: true, elements: [
      { role: "Document", name: "Document", frame: { x: 140, y: 160, width: 700, height: 420 }, element_token: "nonempty-token", value: "existing text" },
    ] });
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target, windowDeliveryMode: "foreground", grounding: "uia-catalog-v1", multilineTypeProfile: "foreground-caret-v1", driverFactory: () => fake.driver });
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
      expect(receipt).toMatchObject({ status: "completed" });
      expect(receipt.message).toContain("same-target read-back");
      expect(fake.calls.filter((call) => call.name === "type_text")).toHaveLength(1);
      expect(fake.calls.find((call) => call.name === "type_text")?.input).toMatchObject({
        pid: fake.target.pid,
        window_id: fake.target.windowId,
        element_token: "nonempty-token",
        text: "first\rsecond",
        delivery_mode: "background",
      });
      expect(fake.calls.some((call) => call.name === "press_key")).toBe(false);
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

  it("keeps non-empty multiline input partial when CUA does not provide confirmed value-readback evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-multiline-mismatch-"));
    const fake = windowDriver();
    fake.setGroundingState({ snapshot_id: "s00000001", elements_complete: true, elements: [
      { role: "Document", frame: { x: 140, y: 160, width: 700, height: 420 }, element_token: "mismatch-token", value: "existing text" },
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

  it("preserves explicit no-input refusal for a non-empty multiline UIA target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-multiline-no-input-"));
    const fake = windowDriver();
    fake.setTypeTextResult({ structuredJson: JSON.stringify({ input_sent: false }) });
    fake.setGroundingState({ snapshot_id: "s00000001", elements_complete: true, elements: [
      { role: "Document", frame: { x: 140, y: 160, width: 700, height: 420 }, element_token: "no-input-token", value: "existing text" },
    ] });
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target, windowDeliveryMode: "foreground", grounding: "uia-catalog-v1", driverFactory: () => fake.driver });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "multiline-no-input-observation" as ObservationId, signal);
      const receipt = await computer.execute(session, {
        actionId: "multiline-no-input-action" as ActionId,
        basedOn: "multiline-no-input-observation" as ObservationId,
        kind: "type",
        text: "first\nsecond",
      }, signal);
      expect(receipt).toMatchObject({ status: "refused", driverCode: "MULTILINE_TYPE_REFUSED" });
      expect(fake.calls.filter((call) => call.name === "type_text")).toHaveLength(1);
      expect(fake.calls.some((call) => call.name === "press_key")).toBe(false);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps non-empty multiline input partial after a type_text error without replay", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-cua-multiline-driver-error-"));
    const fake = windowDriver();
    fake.setTypeTextThrownError(new Error("fixture type_text failure"));
    fake.setGroundingState({ snapshot_id: "s00000001", elements_complete: true, elements: [
      { role: "Document", frame: { x: 140, y: 160, width: 700, height: 420 }, element_token: "error-token", value: "existing text" },
    ] });
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target, windowDeliveryMode: "foreground", grounding: "uia-catalog-v1", driverFactory: () => fake.driver });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "multiline-error-observation" as ObservationId, signal);
      const receipt = await computer.execute(session, {
        actionId: "multiline-error-action" as ActionId,
        basedOn: "multiline-error-observation" as ObservationId,
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
    const computer = new CuaDriverComputer({ socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", grounding: "uia-catalog-v1",
      windowSwitchAllowedTargets: [fake.target, { pid: candidate.pid, windowId: candidate.windowId }],
      driverFactory: () => fake.driver });
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

describe("window repair integration boundaries", () => {
  it.each(["confirmed", "owner_changed", "unrelated", "partial_nonforeground"] as const)("checks temporary exact-owner Host authorization: %s", async (scenario) => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-owner-boundary-"));
    const fake = windowDriver();
    const popup = {
      pid: fake.target.pid, windowId: 8767, appName: "Fixture", title: "Owned popup",
      zIndex: 2, isOnScreen: true, minimized: false,
      ownerPid: fake.target.pid, ownerWindowId: fake.target.windowId,
    };
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", windowSwitchAllowedTargets: [fake.target],
      driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      const before = await computer.observe(session, "owner-boundary-before" as ObservationId, signal);
      fake.setExtraWindowAfterClick(popup);
      const receipt = await computer.execute(session, {
        actionId: "owner-boundary-click" as ActionId, basedOn: "owner-boundary-before" as ObservationId,
        kind: "click", point: { x: 10, y: 20 },
      }, signal, { detectNewWindowHandoff: true });
      expect(receipt.status).toBe("completed");
      expect(await computer.detectNewWindowHandoffCandidates(session, signal)).toEqual([
        { pid: popup.pid, windowId: popup.windowId, appName: popup.appName, title: popup.title },
      ]);
      const activationsBefore = fake.calls.filter((call) => call.name === "bring_to_front").length;
      if (scenario === "owner_changed") {
        fake.setExtraWindowOnListCall(fake.getListWindowsCallCount() + 3, { ...popup, ownerWindowId: 9999 });
      } else if (scenario === "unrelated") {
        fake.setExtraWindow({ ...popup, ownerPid: 4321, ownerWindowId: 9999 });
      } else if (scenario === "partial_nonforeground") {
        fake.setWindowInventoryComplete(false);
      }
      if (scenario === "confirmed") {
        const selected = await computer.handoffWindow(session, popup, signal);
        const after = await computer.observe(selected, "owner-boundary-after" as ObservationId, signal);
        expect(after.surfaceRef.surfaceId).not.toBe(before.surfaceRef.surfaceId);
        expect(fake.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(activationsBefore + 1);
      } else {
        await expect(computer.handoffWindow(session, popup, signal)).rejects.toMatchObject({
          code: scenario === "owner_changed" || scenario === "partial_nonforeground"
            ? "WINDOW_HANDOFF_STALE"
            : "WINDOW_SWITCH_UNAUTHORIZED",
        });
        expect(fake.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(activationsBefore);
      }
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(1);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not replay an uncertain action while refreshing popup discovery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-uncertain-popup-"));
    const fake = windowDriver();
    const computer = new CuaDriverComputer({
      socketPath: "test-socket", screenshotDir: directory, windowTarget: fake.target,
      windowDeliveryMode: "foreground", driverFactory: () => fake.driver,
    });
    const signal = new AbortController().signal;
    try {
      const session = await computer.open({}, signal);
      await computer.observe(session, "uncertain-popup-before" as ObservationId, signal);
      fake.degradeActionOnCall(1);
      const receipt = await computer.execute(session, {
        actionId: "uncertain-popup-click" as ActionId, basedOn: "uncertain-popup-before" as ObservationId,
        kind: "click", point: { x: 10, y: 20 },
      }, signal, { detectNewWindowHandoff: true });
      expect(receipt.status).not.toBe("completed");
      expect(await computer.detectNewWindowHandoffCandidates(session, signal)).toEqual([]);
      await computer.observe(session, "uncertain-popup-after" as ObservationId, signal);
      expect(await computer.detectNewWindowHandoffCandidates(session, signal)).toEqual([]);
      expect(fake.calls.filter((call) => call.name === "click")).toHaveLength(1);
      await computer.close(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
