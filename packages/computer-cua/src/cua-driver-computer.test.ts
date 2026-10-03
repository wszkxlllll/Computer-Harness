import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CuaDriverLike, ToolResult } from "@trycua/cua-driver";
import type { ActionId, ObservationId } from "@computer-harness/protocol";
import { CuaDriverComputer as ProductionCuaDriverComputer, type CuaDriverComputerOptions } from "./cua-driver-computer.js";
import { createMockDomGroundingTransport, type DomGroundingTransport, type ManagedBrowserTarget } from "./dom-grounding.js";
import { captureWindow, captureWindowWithRetry, listWindowTargets } from "./window-contract.js";

// Historical native fixtures model Windows. Make their contract independent
// of the machine running Vitest; macOS contract cases explicitly opt in.
class CuaDriverComputer extends ProductionCuaDriverComputer {
  public constructor(options: CuaDriverComputerOptions) { super({ platform: "win32", ...options }); }
}

const ONE_BY_ONE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

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
  let missingAfterListCall: number | undefined;
  let extraWindow: { pid: number; windowId: number; title: string; appName: string } | undefined;
  let extraWindowAfterClick: typeof extraWindow | undefined;
  let extraWindowOnListCall: { call: number; value: NonNullable<typeof extraWindow> } | undefined;
  let foregroundRefusal = false;
  let foregroundRefusalMessage = "foreground_unavailable: Windows did not activate exact target HWND 0x162e (actual foreground HWND 0x223d); no mouse input was sent";
  let foregroundRefusalCode: string | undefined;
  let activationRefusal = false;
  let activationLanded = true;
  let activationTargetHwnd: number | undefined;
  let activationForegroundHwnd: number | undefined;
  const target = { pid: 1234, windowId: 5678 };
  const driver = {
    async startSession() { calls.push({ name: "startSession" }); return { active: true, revived: false } as never; },
    async endSession() { calls.push({ name: "endSession" }); return { active: false, session: "window-test" } as never; },
    async shutdown() { calls.push({ name: "shutdown" }); },
    async verifyState() {
      calls.push({ name: "verifyState" });
      const scriptedImages = captureImages === undefined
        ? undefined
        : captureImages[Math.min(captureImageIndex++, captureImages.length - 1)];
      const images = scriptedImages ?? [{ mimeType: "image/png", dataBase64: pngWithDimensions(image.width, image.height) }];
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
        if (extraWindowOnListCall?.call === listWindowsCallCount) extraWindow = extraWindowOnListCall.value;
        const unavailable = missing || (missingAfterListCall !== undefined && listWindowsCallCount >= missingAfterListCall);
        return result({ structuredJson: JSON.stringify({ windows: unavailable ? [] : [
          { pid: target.pid, window_id: target.windowId, title: "Safe fixture", app_name: "Computer Harness", bounds },
          ...(extraWindow === undefined ? [] : [{ pid: extraWindow.pid, window_id: extraWindow.windowId, title: extraWindow.title, app_name: extraWindow.appName, bounds }]),
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
        const state = groundingStateSequence === undefined
          ? groundingState
          : groundingStateSequence[Math.min(groundingStateIndex++, groundingStateSequence.length - 1)];
        return result({
          images: input.include_screenshot === true ? fallbackImages ?? [] : [],
          structuredJson: JSON.stringify(state ?? {}),
        });
      }
      if (name === "click" && extraWindowAfterClick !== undefined) {
        extraWindow = extraWindowAfterClick;
        extraWindowAfterClick = undefined;
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
    setExtraWindow(value: typeof extraWindow) { extraWindow = value; },
    setExtraWindowAfterClick(value: NonNullable<typeof extraWindow>) { extraWindowAfterClick = value; },
    setExtraWindowOnListCall(call: number, value: NonNullable<typeof extraWindow>) { extraWindowOnListCall = { call, value }; },
    getListWindowsCallCount() { return listWindowsCallCount; },
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
        "startSession", "bring_to_front", "list_windows", "verifyState",
      ]);
      expect(fake.calls[1]?.input).toMatchObject({
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
        "startSession", "list_windows", "verifyState",
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
    }]);
    expect(fake.calls).toEqual([{
      name: "list_windows",
      input: { on_screen_only: true, session: "picker-session" },
    }]);
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
      expect(next.id).not.toBe(session.id);
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
      fake.setExtraWindowAfterClick(dialog);
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
      fake.setExtraWindowOnListCall(baselineCallCount + 3, dialog);
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
        "PRIVATE_ACCESS_TOKEN",
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
      expect(retryDelays).toEqual([75, 150]);
      expect(fake.calls.filter((call) => call.name === "verifyState")).toHaveLength(5);
      expect(fake.calls.filter((call) => call.name === "get_window_state")).toHaveLength(1);
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
          expect(signal).toBe(controller.signal);
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
      }, new AbortController().signal)).resolves.toMatchObject({ status: "completed" });
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
      expect(await computer.execute(session, { kind: "keypress", actionId: "location-bar-refused" as ActionId, basedOn: observationId, keys: ["CMD", "L"] }, signal)).toMatchObject({ status: "refused" });
      refuseShortcut.mockRestore();
      expect(await type("refused-location-keeps-binding")).toMatchObject({ status: "refused", driverCode: "DOM_INPUT_FOCUS_MISMATCH" });
      expect(await computer.execute(session, { kind: "keypress", actionId: "location-bar" as ActionId, basedOn: observationId, keys: ["CMD", "L"] }, signal)).toMatchObject({ status: "completed" });
      expect(await type("explicit-location-input")).toMatchObject({ status: "completed" });
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
