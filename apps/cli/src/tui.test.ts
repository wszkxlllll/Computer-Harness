import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ActionId, EventId, ObservationId, RunId, RuntimeEvent, RunOutcome, ToolCallId } from "@computer-harness/protocol";
import type { RunController } from "@computer-harness/runtime";
import type { RunHandle, ResolvedRunConfig, WindowTargetDiscovery } from "@computer-harness/app-runtime";
import { ApplicationSession, createRunEventFeed, InProcessEnvironmentOwner, type ApplicationSessionConfig } from "@computer-harness/app-runtime";
import { initialRunSnapshot, type RunSnapshot } from "@computer-harness/trajectory";
import { buildTuiFrame, runApplicationTui } from "./tui.js";
import { limitTuiInput, removeLastTuiGrapheme, tailTuiInput, wrapTuiText } from "./tui-text.js";
import stringWidth from "string-width";

function makePendingCorrectionFixture(
  pauseBarrier: () => Promise<void>,
  windowDiscovery?: WindowTargetDiscovery,
  computer: ResolvedRunConfig["computer"] = { kind: "osworld", bridgeUrl: "http://tui-fixture" },
) {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean; setRawMode?: (mode: boolean) => void };
  const output = new PassThrough() as PassThrough & { isTTY?: boolean; columns?: number; rows?: number };
  input.isTTY = true;
  output.isTTY = true;
  const rawModes: boolean[] = [];
  input.setRawMode = (mode) => rawModes.push(mode);
  const outputText: string[] = [];
  output.on("data", (chunk: Buffer) => outputText.push(chunk.toString("utf8")));
  const runId = "tui-pending-run" as RunId;
  let resolveStart!: (outcome: RunOutcome) => void;
  let snapshot: RunSnapshot = { ...initialRunSnapshot(runId), status: "running" };
  const controller = {
    getSnapshot: vi.fn(() => structuredClone(snapshot)),
    getEventsAfter: vi.fn(() => []),
    submitUserInput: vi.fn(async () => undefined),
    cancel: vi.fn(() => {
      snapshot = { ...snapshot, status: "finished", outcome: "cancelled" };
      resolveStart("cancelled");
    }),
    pause: vi.fn(async () => {
      await pauseBarrier();
      snapshot = { ...snapshot, status: "paused" };
    }),
    resume: vi.fn(async () => { if (snapshot.outcome === "cancelled") snapshot = { ...snapshot, status: "finished" }; else snapshot = { ...snapshot, status: "running" }; }),
  } as unknown as RunController;
  const config = {
    goal: "placeholder",
    model: "glm-5.3-flash",
    computer,
    outputDir: "runs/tui-pending",
    maxSteps: 2,
    maxModelRequests: 2,
    planning: false,
    memory: "off",
    batching: "off",
    contextMode: "raw",
    contextMaxHistoryEvents: 4,
    riskProfile: "live-interactive",
    riskGuard: "layered",
    riskModel: "off",
    riskMaxModelRequests: 1,
    riskTimeoutMs: 100,
    cleanupDeadlineMs: 100,
  } as ResolvedRunConfig;
  const eventFeed = createRunEventFeed();
  const handle = {
    runId,
    config,
    controller,
    eventFeed,
    start: vi.fn(() => new Promise<RunOutcome>((resolve) => { resolveStart = resolve; })),
    report: vi.fn(async () => ({ runId, outcome: "cancelled" as const, summary: { cleanupDiagnostics: [] }, snapshot: { ...snapshot, status: "finished" as const, outcome: "cancelled" as const }, events: [] })),
    close: vi.fn(async () => undefined),
  } as unknown as RunHandle;
  const sessionConfig: ApplicationSessionConfig = { ...config };
  delete (sessionConfig as Partial<ResolvedRunConfig>).goal;
  const createRun = vi.fn(async () => handle);
  const owner = new InProcessEnvironmentOwner();
  const session = new ApplicationSession({
    config: sessionConfig,
    createRun,
    owner,
    ...(windowDiscovery === undefined ? {} : { windowDiscovery }),
  });
  return { input, output, outputText, rawModes, controller, session, handle, runId, createRun, owner };
}

async function waitForTui(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("TUI fixture condition was not reached");
}

describe("TUI renderer", () => {
  it("presents the home setup in readable text within a narrow terminal", async () => {
    const fixture = makePendingCorrectionFixture(async () => undefined, undefined, {
      kind: "cua",
      socketPath: "fixture.sock",
      screenshotDir: "runs/tui-home/screenshots",
    });
    fixture.output.columns = 40;
    fixture.output.rows = 24;
    const tui = runApplicationTui(fixture.session, {
      provider: "glm-5.3-flash",
      computer: "cua",
      cuaWindowTarget: { pid: 1234, windowId: 5678 },
      cuaWindowLabel: "上海出行窗口标题很长需要换行显示",
      cuaWindowDeliveryMode: "foreground",
      output: "runs/tui-home",
      profile: "live-interactive",
      riskGuard: "layered",
      features: {
        planning: false,
        memory: "off",
        memoryRetrieval: "off",
        batching: "off",
        contextMode: "raw",
        riskGuard: "layered",
        monitor: "off",
        grounding: "off",
      },
    }, { terminal: { input: fixture.input, output: fixture.output } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const frame = fixture.outputText.join("").split("\u001b[H\u001b[2J").at(-1) ?? "";
    expect(frame).toContain("Model: glm-5.3-flash");
    expect(frame).toContain("Computer: cua");
    expect(frame.replace(/\s/gu, "")).toContain("上海出行窗口标题很长需要换行显示");
    expect(frame).toContain("Full target:");
    expect(frame).toContain("Features: Baseline");
    expect(frame).toContain("Risk Guard: ON");
    expect(frame).toContain("Enter starts");
    expect(frame).toContain("TTY only; no global hotkeys");
    expect(frame.split("\n").every((line) => stringWidth(line) <= 40)).toBe(true);
    fixture.input.emit("keypress", "", { name: "escape" });
    fixture.input.emit("keypress", "", { name: "q" });
    await tui;
  });

  it.each([20, 40])("keeps Guard and next-step visible at %i columns by 12 rows with long Chinese content", async (columns) => {
    let rejectSecond!: (error: Error) => void;
    const longWindow = {
      pid: 9876,
      windowId: 54321,
      appName: "12306上海出行查询应用窗口名称很长",
      title: "12306车次查询结果页面标题也很长",
    };
    const listWindows = vi.fn<WindowTargetDiscovery["listWindows"]>()
      .mockResolvedValueOnce([longWindow])
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSecond = reject; }));
    const windowDiscovery: WindowTargetDiscovery = { listWindows };
    const fixture = makePendingCorrectionFixture(async () => undefined, windowDiscovery, {
      kind: "cua",
      socketPath: "fixture.sock",
      screenshotDir: "runs/tui-home-compact/screenshots",
    });
    fixture.output.columns = columns;
    fixture.output.rows = 12;
    const tui = runApplicationTui(fixture.session, {
      provider: "glm-5.3-flash",
      computer: "cua",
      output: "runs/tui-home-compact",
      profile: "live-interactive",
      riskGuard: "layered",
    }, { terminal: { input: fixture.input, output: fixture.output } });
    const tick = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)); };
    const waitFor = async (predicate: () => boolean): Promise<void> => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (predicate()) return;
        await tick();
      }
      throw new Error("TUI fixture condition was not reached");
    };
    const longGoal = "请检查上海出行页面中的车次、到达时间、换乘条件并整理可选方案。".repeat(5);

    fixture.input.emit("keypress", longGoal, {});
    fixture.input.emit("keypress", "", { name: "escape" });
    fixture.input.emit("keypress", "W", { name: "w" });
    await waitFor(() => fixture.outputText.join("").includes("WINDOW TARGET"));
    await waitFor(() => fixture.outputText.join("").includes("12306上海"));
    fixture.input.emit("keypress", "", { name: "down" });
    fixture.input.emit("keypress", "", { name: "return" });
    await tick();

    fixture.input.emit("keypress", "W", { name: "w" });
    await waitFor(() => listWindows.mock.calls.length === 2);
    fixture.input.emit("keypress", "", { name: "escape" });
    const cleanupError = new Error("窗口资源清理状态无法确认；请检查运行会话并在清理完成前不要启动下一次操作。".repeat(2));
    cleanupError.name = "CuaWindowDiscoveryCleanupError";
    rejectSecond(cleanupError);
    const pendingOwner = fixture.owner.acquire(fixture.session.environmentId, "blocked-cleanup-fixture");
    await waitFor(() => fixture.outputText.join("").includes("Status: BLOCKED"));

    const frame = fixture.outputText.join("").split("\u001b[H\u001b[2J").at(-1) ?? "";
    expect(frame).toContain("Goal draft:");
    expect(frame).toContain("Model: glm-5.3-flash");
    expect(frame).toContain("Target:");
    expect(frame).toContain("Features: Baseline");
    expect(frame).toContain("Risk Guard: ON");
    expect(frame).toContain("Status: BLOCKED");
    expect(frame).toContain("Next: I resumes");
    expect(frame).toContain("…");
    expect(frame).not.toContain("Details [");
    expect(frame.trimEnd().split("\n").length).toBeLessThanOrEqual(11);
    expect(frame.split("\n").every((line) => stringWidth(line) <= columns)).toBe(true);

    fixture.input.emit("keypress", "D", { name: "d" });
    await waitFor(() => (fixture.outputText.join("").split("\u001b[H\u001b[2J").at(-1) ?? "").includes("Harness | DETAILS"));
    const detailsFrames: string[] = [];
    const firstDetails = fixture.outputText.join("").split("\u001b[H\u001b[2J").at(-1) ?? "";
    const pageCount = Number(/Details \[1\/(\d+)\]/u.exec(firstDetails)?.[1]);
    expect(Number.isInteger(pageCount)).toBe(true);
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      if (pageIndex > 0) {
        fixture.input.emit("keypress", "", { name: "pagedown" });
        await tick();
      }
      const detailFrame = fixture.outputText.join("").split("\u001b[H\u001b[2J").at(-1) ?? "";
      expect(detailFrame).toContain("Risk Guard: ON");
      expect(detailFrame).toContain("Session: BLOCKED");
      expect(detailFrame).toContain("Status: BLOCKED");
      expect(detailFrame.trimEnd().split("\n").length).toBeLessThanOrEqual(11);
      expect(detailFrame.split("\n").every((line) => stringWidth(line) <= columns)).toBe(true);
      detailsFrames.push(detailFrame);
    }
    const allDetails = detailsFrames
      .map((detailFrame) => detailFrame.trimEnd().split("\n").slice(5, -2).join(""))
      .join("")
      .replace(/\s/gu, "");
    expect(allDetails).toContain(`Fullgoal:${longGoal}`.replace(/\s/gu, ""));
    expect(allDetails).toContain(`${longWindow.appName}—${longWindow.title}`.replace(/\s/gu, ""));
    expect(allDetails).toContain(cleanupError.message.replace(/\s/gu, ""));

    fixture.input.emit("keypress", "", { name: "escape" });
    await tick();
    const returnedHome = fixture.outputText.join("").split("\u001b[H\u001b[2J").at(-1) ?? "";
    expect(returnedHome).toContain("Harness | HOME");
    expect(returnedHome).toContain("Status: BLOCKED");
    expect(returnedHome).toContain("Goal draft:");

    pendingOwner.release();
    fixture.input.emit("keypress", "", { name: "q" });
    await tui;
  });

  it("keeps the focused goal draft read-only while the details page is open", async () => {
    const fixture = makePendingCorrectionFixture(async () => undefined);
    fixture.output.columns = 80;
    fixture.output.rows = 30;
    const tui = runApplicationTui(fixture.session, {
      provider: "glm-5.3-flash",
      computer: "osworld",
      output: "runs/tui-home-details-readonly",
      profile: "live-interactive",
      riskGuard: "layered",
    }, { terminal: { input: fixture.input, output: fixture.output } });
    const tick = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)); };
    const goal = "原始目标草稿保持不变";
    const unintendedInput = "不应写入的文字";

    fixture.input.emit("keypress", goal, {});
    fixture.input.emit("keypress", "", { name: "pagedown" });
    await tick();
    expect(fixture.outputText.join("")).toContain("Harness | DETAILS");

    fixture.input.emit("keypress", unintendedInput, {});
    fixture.input.emit("keypress", "", { name: "return" });
    await tick();
    const detailsFrame = fixture.outputText.join("").split("\u001b[H\u001b[2J").at(-1) ?? "";
    expect(detailsFrame).toContain("Harness | DETAILS");
    expect(detailsFrame).toContain("Full goal:");
    expect(detailsFrame).toContain(goal);
    expect(detailsFrame).not.toContain(unintendedInput);
    expect(fixture.session.activeRun).toBeUndefined();
    expect(fixture.createRun).not.toHaveBeenCalled();

    fixture.input.emit("keypress", "", { name: "escape" });
    await tick();
    const returnedHome = fixture.outputText.join("").split("\u001b[H\u001b[2J").at(-1) ?? "";
    expect(returnedHome).toContain("Goal: >");
    expect(returnedHome).toContain(goal);
    expect(returnedHome).not.toContain(unintendedInput);

    fixture.input.emit("keypress", "", { name: "escape" });
    fixture.input.emit("keypress", "", { name: "q" });
    await tui;
    expect(fixture.rawModes).toEqual([true, false]);
  });

  it("keeps a typed goal draft while the user reviews features and selects a window", async () => {
    const fixture = makePendingCorrectionFixture(async () => undefined, {
      listWindows: async () => [{ pid: 1234, windowId: 5678, appName: "Browser", title: "12306" }],
    }, {
      kind: "cua",
      socketPath: "fixture.sock",
      screenshotDir: "runs/tui-home-draft/screenshots",
    });
    fixture.output.columns = 80;
    fixture.output.rows = 30;
    const tui = runApplicationTui(fixture.session, {
      provider: "glm-5.3-flash",
      computer: "cua",
      output: "runs/tui-home-draft",
      profile: "live-interactive",
      riskGuard: "layered",
    }, { terminal: { input: fixture.input, output: fixture.output } });
    const tick = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)); };
    const waitFor = async (predicate: () => boolean): Promise<void> => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (predicate()) return;
        await tick();
      }
      throw new Error("TUI fixture condition was not reached");
    };
    const goal = "检查上海出行窗口并整理当前查询结果";

    fixture.input.emit("keypress", goal, {});
    fixture.input.emit("keypress", "F", { name: "f" });
    await tick();
    expect(fixture.outputText.join("")).toContain("FEATURES");
    fixture.input.emit("keypress", "", { name: "escape" });
    await tick();
    expect(fixture.outputText.join("")).toContain(`Goal draft: ${goal}`);

    fixture.input.emit("keypress", "W", { name: "w" });
    await waitFor(() => fixture.outputText.join("").includes("Browser — 12306"));
    fixture.input.emit("keypress", "", { name: "down" });
    fixture.input.emit("keypress", "", { name: "return" });
    await tick();
    expect(fixture.outputText.join("")).toContain(`Goal draft: ${goal}`);
    expect(fixture.outputText.join("")).toContain("Target: Browser — 12306");

    fixture.input.emit("keypress", "", { name: "i" });
    fixture.input.emit("keypress", "", { name: "return" });
    await waitFor(() => fixture.createRun.mock.calls.length === 1);
    const startedConfig = ((fixture.createRun.mock.calls as unknown[][])[0]?.[0]) as ResolvedRunConfig | undefined;
    expect(startedConfig?.goal).toBe(goal);
    expect(startedConfig?.computer).toMatchObject({ kind: "cua", windowTarget: { pid: 1234, windowId: 5678 }, windowDeliveryMode: "foreground" });
    fixture.input.emit("keypress", "", { name: "a" });
    await waitFor(() => fixture.session.status === "idle");
    await tick();
    fixture.input.emit("keypress", "", { name: "escape" });
    fixture.input.emit("keypress", "", { name: "q" });
    await tui;
  });

  it("lets the home screen select per-Run feature flags before entering a goal", async () => {
    const fixture = makePendingCorrectionFixture(async () => undefined);
    fixture.output.columns = 80;
    fixture.output.rows = 24;
    const tui = runApplicationTui(fixture.session, {
      provider: "glm",
      computer: "osworld",
      output: "runs/tui-features",
      profile: "live-interactive",
      riskGuard: "layered",
    }, { terminal: { input: fixture.input, output: fixture.output } });
    const tick = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)); };
    fixture.input.emit("keypress", "F", { name: "f" });
    await tick();
    expect(fixture.outputText.join("")).toContain("FEATURES");
    fixture.input.emit("keypress", "", { name: "down" });
    fixture.input.emit("keypress", "", { name: "space" });
    fixture.input.emit("keypress", "", { name: "down" });
    fixture.input.emit("keypress", "", { name: "right" });
    fixture.input.emit("keypress", "", { name: "down" });
    fixture.input.emit("keypress", "", { name: "down" });
    fixture.input.emit("keypress", "", { name: "down" });
    fixture.input.emit("keypress", "", { name: "space" });
    fixture.input.emit("keypress", "", { name: "return" });
    await tick();
    expect(fixture.outputText.join("")).toContain("Features: Custom");
    expect(fixture.outputText.join("")).toContain("Risk Guard: OFF");

    fixture.input.emit("keypress", "打开任务管理器", {});
    fixture.input.emit("keypress", "", { name: "return" });
    await tick();
    const startedConfig = ((fixture.createRun.mock.calls as unknown[][])[0]?.[0]) as ResolvedRunConfig | undefined;
    expect(startedConfig?.planning).toBe(false);
    expect(startedConfig?.memory).toBe("facts");
    expect(startedConfig?.memoryRetrieval).toBe("lexical");
    expect(startedConfig?.riskGuard).toBe("off");
    fixture.input.emit("keypress", "", { name: "q" });
    await tui;
  });

  it("blocks UIA grounding before start when no CUA window is selected", async () => {
    const fixture = makePendingCorrectionFixture(async () => undefined, undefined, { kind: "cua", socketPath: "fixture.sock", screenshotDir: "runs/tui-grounding/screenshots" });
    const tui = runApplicationTui(fixture.session, {
      provider: "glm",
      computer: "cua",
      output: "runs/tui-grounding",
      profile: "live-interactive",
      riskGuard: "layered",
      windowSelectionAvailable: false,
      features: {
        planning: false,
        memory: "off",
        memoryRetrieval: "off",
        batching: "off",
        contextMode: "raw",
        riskGuard: "layered",
        monitor: "off",
        grounding: "uia-catalog-v1",
      },
    }, { terminal: { input: fixture.input, output: fixture.output } });
    fixture.input.emit("keypress", "choose a control", {});
    fixture.input.emit("keypress", "", { name: "return" });
    await waitForTui(() => fixture.outputText.join("").includes("no target was auto-selected"));
    expect(fixture.createRun).not.toHaveBeenCalled();
    fixture.input.emit("keypress", "", { name: "return" });
    await waitForTui(() => fixture.outputText.join("").includes("Primary desktop selected"));
    fixture.input.emit("keypress", "", { name: "i" });
    fixture.input.emit("keypress", "", { name: "return" });
    await waitForTui(() => fixture.outputText.join("").includes("UIA grounding requires an explicitly selected CUA window"));
    expect(fixture.createRun).not.toHaveBeenCalled();
    expect(fixture.outputText.join("")).toContain("UIA grounding requires an explicitly selected CUA window");
    fixture.input.emit("keypress", "", { name: "q" });
    await tui;
  });

  it("blocks managed DOM grounding before start when the CLI did not provide a URL", async () => {
    const fixture = makePendingCorrectionFixture(async () => undefined, undefined, { kind: "cua", socketPath: "fixture.sock", screenshotDir: "runs/tui-dom-grounding/screenshots" });
    const tui = runApplicationTui(fixture.session, {
      provider: "glm",
      computer: "cua",
      output: "runs/tui-dom-grounding",
      profile: "live-interactive",
      riskGuard: "layered",
      features: {
        planning: false,
        memory: "off",
        memoryRetrieval: "off",
        batching: "off",
        contextMode: "raw",
        riskGuard: "layered",
        monitor: "off",
        grounding: "dom-catalog-v1",
      },
    }, { terminal: { input: fixture.input, output: fixture.output } });
    const tick = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)); };
    fixture.input.emit("keypress", "find a control", {});
    fixture.input.emit("keypress", "", { name: "return" });
    await tick();
    expect(fixture.createRun).not.toHaveBeenCalled();
    expect(fixture.outputText.join("")).toContain("DOM/Hybrid grounding requires --managed-browser-url");
    fixture.input.emit("keypress", "", { name: "escape" });
    fixture.input.emit("keypress", "", { name: "q" });
    await tui;
  });

  it("resolves auto grounding to UIA for a uniquely selected ordinary browser window", async () => {
    const target = { pid: 22, windowId: 33, appName: "Microsoft Edge", title: "Inbox" };
    const fixture = makePendingCorrectionFixture(async () => undefined, { listWindows: async () => [target] }, {
      kind: "cua", socketPath: "fixture.sock", screenshotDir: "runs/tui-auto-grounding/screenshots",
    });
    const tui = runApplicationTui(fixture.session, {
      provider: "glm", computer: "cua", output: "runs/tui-auto-grounding", profile: "live-interactive",
      riskGuard: "layered", windowSelectionAvailable: true,
      features: { planning: false, memory: "off", memoryRetrieval: "off", batching: "off", contextMode: "raw", riskGuard: "layered", monitor: "off", grounding: "auto" },
    }, { terminal: { input: fixture.input, output: fixture.output } });
    fixture.input.emit("keypress", "Open Microsoft Edge and inspect the page", {});
    fixture.input.emit("keypress", "", { name: "return" });
    await waitForTui(() => fixture.createRun.mock.calls.length === 1 && fixture.session.status === "running");
    const started = ((fixture.createRun.mock.calls as unknown[][])[0]?.[0]) as ResolvedRunConfig;
    expect(started.grounding).toBe("uia-catalog-v1");
    expect(started.computer).toMatchObject({ kind: "cua", windowTarget: { pid: 22, windowId: 33 } });
    fixture.input.emit("keypress", "", { name: "a" });
    await waitForTui(() => fixture.session.status === "idle");
    fixture.input.emit("keypress", "", { name: "escape" });
    fixture.input.emit("keypress", "", { name: "q" });
    await tui;
  });

  it("resolves auto grounding to hybrid only after explicitly selecting the managed browser", async () => {
    const fixture = makePendingCorrectionFixture(async () => undefined, { listWindows: async () => [{ pid: 22, windowId: 33, appName: "Microsoft Edge", title: "Inbox" }] }, {
      kind: "cua", socketPath: "fixture.sock", screenshotDir: "runs/tui-managed-auto/screenshots",
      managedBrowserUrl: "https://example.test/inbox",
    });
    const tui = runApplicationTui(fixture.session, {
      provider: "glm", computer: "cua", output: "runs/tui-managed-auto", profile: "live-interactive",
      riskGuard: "layered", windowSelectionAvailable: true, managedBrowserUrl: "https://example.test/inbox",
      features: { planning: false, memory: "off", memoryRetrieval: "off", batching: "off", contextMode: "raw", riskGuard: "layered", monitor: "off", grounding: "auto" },
    }, { terminal: { input: fixture.input, output: fixture.output } });
    fixture.input.emit("keypress", "", { name: "escape" });
    fixture.input.emit("keypress", "", { name: "w" });
    await waitForTui(() => fixture.outputText.join("").includes("Option 1 of 3") && fixture.outputText.join("").includes("Harness-managed browser (example.test; DOM + UIA)"));
    fixture.input.emit("keypress", "", { name: "down" });
    fixture.input.emit("keypress", "", { name: "return" });
    await waitForTui(() => fixture.outputText.join("").includes("Harness-managed browser selected"));
    fixture.input.emit("keypress", "Open the saved browser page", {});
    fixture.input.emit("keypress", "", { name: "return" });
    await waitForTui(() => fixture.createRun.mock.calls.length === 1 && fixture.session.status === "running");
    const started = ((fixture.createRun.mock.calls as unknown[][])[0]?.[0]) as ResolvedRunConfig;
    expect(started.grounding).toBe("hybrid-catalog-v1");
    expect(started.computer).not.toHaveProperty("windowTarget");
    fixture.input.emit("keypress", "", { name: "a" });
    await waitForTui(() => fixture.session.status === "idle");
    fixture.input.emit("keypress", "", { name: "escape" });
    fixture.input.emit("keypress", "", { name: "q" });
    await tui;
  });

  it("shows managed browser mode and host only on the feature page", async () => {
    const fixture = makePendingCorrectionFixture(async () => undefined, undefined, { kind: "cua", socketPath: "fixture.sock", screenshotDir: "runs/tui-dom-display/screenshots" });
    const tui = runApplicationTui(fixture.session, {
      provider: "glm",
      computer: "cua",
      output: "runs/tui-dom-display",
      profile: "live-interactive",
      riskGuard: "layered",
      managedBrowserUrl: "https://example.test/path?secret=should-not-render",
      features: {
        planning: false,
        memory: "off",
        memoryRetrieval: "off",
        batching: "off",
        contextMode: "raw",
        riskGuard: "layered",
        monitor: "off",
        grounding: "hybrid-catalog-v1",
      },
    }, { terminal: { input: fixture.input, output: fixture.output } });
    const tick = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)); };
    fixture.input.emit("keypress", "F", { name: "f" });
    await tick();
    const rendered = fixture.outputText.join("");
    expect(rendered).toContain("temporary profile");
    expect(rendered).toContain("delivery=foreground");
    expect(rendered).toContain("do not operate this window concurrently");
    expect(rendered).toContain("example.test");
    expect(rendered).not.toContain("secret=should-not-render");
    fixture.input.emit("keypress", "", { name: "escape" });
    fixture.input.emit("keypress", "", { name: "q" });
    await tui;
  });

  it("keeps the selected Grounding row visible on a 12-row terminal", async () => {
    const fixture = makePendingCorrectionFixture(async () => undefined, undefined, { kind: "cua", socketPath: "fixture.sock", screenshotDir: "runs/tui-narrow-features/screenshots" });
    fixture.output.rows = 12;
    const tui = runApplicationTui(fixture.session, {
      provider: "glm", computer: "cua", output: "runs/tui-narrow-features", profile: "live-interactive", riskGuard: "layered",
      features: { planning: false, memory: "off", memoryRetrieval: "off", batching: "off", contextMode: "raw", riskGuard: "layered", monitor: "off", grounding: "auto" },
    }, { terminal: { input: fixture.input, output: fixture.output } });
    fixture.input.emit("keypress", "", { name: "escape" });
    fixture.input.emit("keypress", "", { name: "f" });
    for (let index = 0; index < 7; index += 1) fixture.input.emit("keypress", "", { name: "down" });
    const frame = fixture.outputText.join("").split("\u001b[H\u001b[2J").at(-1) ?? "";
    expect(frame).toContain("Feature 8 of 8");
    expect(frame).toContain("❯ Grounding");
    expect(frame).toContain("Risk Guard: ENABLED");
    fixture.input.emit("keypress", "", { name: "escape" });
    fixture.input.emit("keypress", "", { name: "q" });
    await tui;
  });

  it("keeps uppercase W in the goal editor and opens the picker after editing ends", async () => {
    const fixture = makePendingCorrectionFixture(async () => undefined, {
      listWindows: async () => [{ pid: 1234, windowId: 5678, appName: "Browser", title: "12306" }],
    }, { kind: "cua", socketPath: "fixture.sock", screenshotDir: "runs/tui-w-editor/screenshots" });
    fixture.output.columns = 100;
    fixture.output.rows = 30;
    const tui = runApplicationTui(fixture.session, {
      provider: "glm",
      computer: "cua",
      output: "runs/tui-w-editor",
      profile: "live-interactive",
      riskGuard: "layered",
    }, { terminal: { input: fixture.input, output: fixture.output } });
    const tick = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)); };

    fixture.input.emit("keypress", "Windows 任务", {});
    await tick();
    expect(fixture.outputText.join("")).toContain("Windows 任务");
    expect(fixture.outputText.join("")).not.toContain("WINDOW TARGET");

    fixture.input.emit("keypress", "", { name: "escape" });
    fixture.input.emit("keypress", "W", { name: "w" });
    await tick();
    await tick();
    expect(fixture.outputText.join("")).toContain("WINDOW TARGET");
    fixture.input.emit("keypress", "", { name: "escape" });
    fixture.input.emit("keypress", "", { name: "q" });
    await tui;
  });

  it("starts once on a unique local name match and ignores rapid repeated Enter", async () => {
    const target = { pid: 1234, windowId: 5678, appName: "Google Chrome", title: "New Tab" };
    const nextTarget = { pid: 4321, windowId: 8765, appName: "Slack", title: "General" };
    const listWindows = vi.fn<WindowTargetDiscovery["listWindows"]>()
      .mockResolvedValueOnce([target])
      .mockResolvedValueOnce([nextTarget]);
    const fixture = makePendingCorrectionFixture(async () => undefined, { listWindows }, {
      kind: "cua",
      socketPath: "fixture.sock",
      screenshotDir: "runs/tui-auto-match/screenshots",
    });
    const tui = runApplicationTui(fixture.session, {
      provider: "glm",
      computer: "cua",
      output: "runs/tui-auto-match",
      profile: "live-interactive",
      riskGuard: "layered",
      windowSelectionAvailable: true,
    }, { terminal: { input: fixture.input, output: fixture.output } });
    const goal = "Open Google Chrome and inspect the current page";

    fixture.input.emit("keypress", goal, {});
    fixture.input.emit("keypress", "", { name: "return" });
    fixture.input.emit("keypress", "", { name: "return" });
    await waitForTui(() => fixture.createRun.mock.calls.length === 1 && fixture.session.status === "running");

    const startedConfig = ((fixture.createRun.mock.calls as unknown[][])[0]?.[0]) as ResolvedRunConfig | undefined;
    expect(listWindows).toHaveBeenCalledTimes(1);
    expect(startedConfig?.goal).toBe(goal);
    expect(startedConfig?.computer).toMatchObject({ kind: "cua", windowTarget: { pid: 1234, windowId: 5678 }, windowDeliveryMode: "foreground" });
    expect(fixture.outputText.join("")).toContain("local goal/name match (not model-selected)");
    expect(fixture.outputText.join("")).toContain("not model-selected");

    fixture.input.emit("keypress", "", { name: "a" });
    await waitForTui(() => fixture.session.status === "idle");
    await waitForTui(() => fixture.outputText.join("").includes("Run finished: cancelled"));
    fixture.input.emit("keypress", "Open Slack and inspect the channel", {});
    fixture.input.emit("keypress", "", { name: "return" });
    await waitForTui(() => fixture.createRun.mock.calls.length === 2 && fixture.session.status === "running");
    const secondConfig = ((fixture.createRun.mock.calls as unknown[][])[1]?.[0]) as ResolvedRunConfig | undefined;
    expect(listWindows).toHaveBeenCalledTimes(2);
    expect(secondConfig?.computer).toMatchObject({ kind: "cua", windowTarget: { pid: 4321, windowId: 8765 }, windowDeliveryMode: "foreground" });

    fixture.input.emit("keypress", "", { name: "a" });
    await waitForTui(() => fixture.session.status === "idle");
    fixture.input.emit("keypress", "", { name: "escape" });
    fixture.input.emit("keypress", "", { name: "q" });
    await tui;
  });

  it.each([
    {
      caseName: "ambiguous names",
      targets: [
        { pid: 1, windowId: 10, appName: "Google Chrome", title: "Chrome profile one" },
        { pid: 2, windowId: 20, appName: "Google Chrome", title: "Chrome profile two" },
      ],
      goal: "Open Google Chrome and inspect the current page",
      reason: "Ambiguous local match",
    },
    {
      caseName: "no confident name",
      targets: [{ pid: 3, windowId: 30, appName: "Browser", title: "New Tab" }],
      goal: "Inspect the current screen and search the page",
      reason: "No confident local match",
    },
  ])("stops for the picker and preserves the goal draft for $caseName", async ({ targets, goal, reason }) => {
    const fixture = makePendingCorrectionFixture(async () => undefined, { listWindows: async () => targets }, {
      kind: "cua",
      socketPath: "fixture.sock",
      screenshotDir: "runs/tui-auto-picker/screenshots",
    });
    fixture.output.columns = 80;
    fixture.output.rows = 12;
    const tui = runApplicationTui(fixture.session, {
      provider: "glm",
      computer: "cua",
      output: "runs/tui-auto-picker",
      profile: "live-interactive",
      riskGuard: "layered",
      windowSelectionAvailable: true,
    }, { terminal: { input: fixture.input, output: fixture.output } });

    fixture.input.emit("keypress", goal, {});
    fixture.input.emit("keypress", "", { name: "return" });
    await waitForTui(() => fixture.outputText.join("").includes("WINDOW TARGET") && fixture.outputText.join("").includes(reason));
    expect(fixture.createRun).not.toHaveBeenCalled();
    const pickerFrame = fixture.outputText.join("").split("\u001b[H\u001b[2J").at(-1) ?? "";
    const pickerLines = pickerFrame.split("\n");
    const statusIndex = pickerLines.findIndex((line) => line.startsWith("Status:"));
    const desktopIndex = pickerLines.findIndex((line) => line.includes("Primary desktop"));
    expect(pickerLines[statusIndex]).toContain(reason);
    expect(pickerLines[statusIndex]).toContain("no model chose it");
    expect(statusIndex).toBeGreaterThanOrEqual(0);
    expect(desktopIndex).toBeGreaterThan(statusIndex);

    fixture.input.emit("keypress", "", { name: "down" });
    fixture.input.emit("keypress", "", { name: "return" });
    await waitForTui(() => fixture.outputText.join("").includes(`Goal draft: ${goal}`));
    expect(fixture.createRun).not.toHaveBeenCalled();
    expect(fixture.outputText.join("")).toContain("goal draft kept");
    fixture.input.emit("keypress", "", { name: "escape" });
    await tui;
  });

  it("scrolls the selected window into view in a 12-row picker", async () => {
    const targets = Array.from({ length: 8 }, (_, index) => ({
      pid: index + 1,
      windowId: (index + 1) * 10,
      appName: `App ${index + 1}`,
      title: `Window ${index + 1}`,
    }));
    const fixture = makePendingCorrectionFixture(async () => undefined, { listWindows: async () => targets }, {
      kind: "cua",
      socketPath: "fixture.sock",
      screenshotDir: "runs/tui-window-scroll/screenshots",
    });
    fixture.output.columns = 80;
    fixture.output.rows = 12;
    const tui = runApplicationTui(fixture.session, {
      provider: "glm",
      computer: "cua",
      output: "runs/tui-window-scroll",
      profile: "live-interactive",
      riskGuard: "layered",
      windowSelectionAvailable: true,
    }, { terminal: { input: fixture.input, output: fixture.output } });

    fixture.input.emit("keypress", "", { name: "escape" });
    fixture.input.emit("keypress", "W", { name: "w" });
    await waitForTui(() => fixture.outputText.join("").includes("Option 1 of 9; showing 1-3"));
    for (let index = 0; index < 8; index += 1) fixture.input.emit("keypress", "", { name: "down" });

    const pickerFrame = fixture.outputText.join("").split("\u001b[H\u001b[2J").at(-1) ?? "";
    expect(pickerFrame).toContain("Option 9 of 9; showing 7-9");
    expect(pickerFrame).toContain("❯ App 8 — Window 8");
    expect(pickerFrame).not.toContain("App 1 — Window 1");
    fixture.input.emit("keypress", "", { name: "return" });
    await waitForTui(() => fixture.outputText.join("").includes("Target: App 8 — Window 8"));
    expect(fixture.createRun).not.toHaveBeenCalled();
    fixture.input.emit("keypress", "", { name: "escape" });
    await tui;
  });

  it("does not start on window-discovery failure and keeps the goal for retry", async () => {
    const listWindows = vi.fn(async () => { throw new Error("fixture discovery failure"); });
    const fixture = makePendingCorrectionFixture(async () => undefined, { listWindows }, {
      kind: "cua",
      socketPath: "fixture.sock",
      screenshotDir: "runs/tui-auto-error/screenshots",
    });
    const tui = runApplicationTui(fixture.session, {
      provider: "glm",
      computer: "cua",
      output: "runs/tui-auto-error",
      profile: "live-interactive",
      riskGuard: "layered",
      windowSelectionAvailable: true,
    }, { terminal: { input: fixture.input, output: fixture.output } });
    const goal = "Open Chrome and inspect the report";

    fixture.input.emit("keypress", goal, {});
    fixture.input.emit("keypress", "", { name: "return" });
    await waitForTui(() => fixture.outputText.join("").includes("Window discovery error: fixture discovery failure"));
    expect(fixture.createRun).not.toHaveBeenCalled();
    expect(fixture.outputText.join("")).toContain("No Run started");

    fixture.input.emit("keypress", "", { name: "escape" });
    await waitForTui(() => fixture.outputText.join("").includes(`Goal draft: ${goal}`));
    expect(fixture.createRun).not.toHaveBeenCalled();
    fixture.input.emit("keypress", "", { name: "escape" });
    await tui;
  });

  it("ignores a late goal-match result after the user cancels to the picker", async () => {
    let resolveFirst!: (targets: readonly { pid: number; windowId: number; appName: string; title: string }[]) => void;
    const listWindows = vi.fn<WindowTargetDiscovery["listWindows"]>()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce([{ pid: 2, windowId: 20, appName: "Google Chrome", title: "Fresh" }]);
    const fixture = makePendingCorrectionFixture(async () => undefined, { listWindows }, {
      kind: "cua",
      socketPath: "fixture.sock",
      screenshotDir: "runs/tui-auto-abort/screenshots",
    });
    const tui = runApplicationTui(fixture.session, {
      provider: "glm",
      computer: "cua",
      output: "runs/tui-auto-abort",
      profile: "live-interactive",
      riskGuard: "layered",
      windowSelectionAvailable: true,
    }, { terminal: { input: fixture.input, output: fixture.output } });
    const goal = "Open Chrome and inspect the page";

    fixture.input.emit("keypress", goal, {});
    fixture.input.emit("keypress", "", { name: "return" });
    await waitForTui(() => listWindows.mock.calls.length === 1);
    fixture.input.emit("keypress", "", { name: "w" });
    await waitForTui(() => fixture.outputText.join("").includes("Google Chrome — Fresh"));
    resolveFirst([{ pid: 1, windowId: 10, appName: "Google Chrome", title: "Stale" }]);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(listWindows).toHaveBeenCalledTimes(2);
    expect(fixture.outputText.join("")).not.toContain("Google Chrome — Stale");
    expect(fixture.createRun).not.toHaveBeenCalled();
    fixture.input.emit("keypress", "", { name: "escape" });
    await waitForTui(() => fixture.outputText.join("").includes(`Goal draft: ${goal}`));
    fixture.input.emit("keypress", "", { name: "q" });
    await tui;
  });

  it("aborts goal matching on exit and ignores a late result without starting on desktop", async () => {
    let resolveWindows!: (targets: readonly { pid: number; windowId: number; appName: string; title: string }[]) => void;
    const listWindows = vi.fn<WindowTargetDiscovery["listWindows"]>(() => new Promise((resolve) => { resolveWindows = resolve; }));
    const fixture = makePendingCorrectionFixture(async () => undefined, { listWindows }, {
      kind: "cua",
      socketPath: "fixture.sock",
      screenshotDir: "runs/tui-auto-exit/screenshots",
    });
    const tui = runApplicationTui(fixture.session, {
      provider: "glm",
      computer: "cua",
      output: "runs/tui-auto-exit",
      profile: "live-interactive",
      riskGuard: "layered",
      windowSelectionAvailable: true,
    }, { terminal: { input: fixture.input, output: fixture.output } });

    fixture.input.emit("keypress", "Open Chrome", {});
    fixture.input.emit("keypress", "", { name: "return" });
    await waitForTui(() => listWindows.mock.calls.length === 1);
    fixture.input.emit("keypress", "", { name: "q" });
    await tui;
    resolveWindows([{ pid: 1, windowId: 10, appName: "Google Chrome", title: "Late result" }]);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(fixture.createRun).not.toHaveBeenCalled();
    expect(fixture.session.status).toBe("closed");
  });

  it("uses Escape to cancel local matching and return to the preserved goal draft", async () => {
    let resolveWindows!: (targets: readonly { pid: number; windowId: number; appName: string; title: string }[]) => void;
    const listWindows = vi.fn<WindowTargetDiscovery["listWindows"]>(() => new Promise((resolve) => { resolveWindows = resolve; }));
    const fixture = makePendingCorrectionFixture(async () => undefined, { listWindows }, {
      kind: "cua",
      socketPath: "fixture.sock",
      screenshotDir: "runs/tui-auto-cancel/screenshots",
    });
    const tui = runApplicationTui(fixture.session, {
      provider: "glm",
      computer: "cua",
      output: "runs/tui-auto-cancel",
      profile: "live-interactive",
      riskGuard: "layered",
      windowSelectionAvailable: true,
    }, { terminal: { input: fixture.input, output: fixture.output } });
    const goal = "Open Chrome and inspect the page";

    fixture.input.emit("keypress", goal, {});
    fixture.input.emit("keypress", "", { name: "return" });
    await waitForTui(() => listWindows.mock.calls.length === 1);
    fixture.input.emit("keypress", "", { name: "escape" });
    await waitForTui(() => fixture.outputText.join("").includes("Local matching cancelled"));
    expect(fixture.outputText.join("")).toContain(`Goal draft: ${goal}`);
    expect(fixture.createRun).not.toHaveBeenCalled();

    fixture.input.emit("keypress", "", { name: "q" });
    await tui;
    resolveWindows([{ pid: 1, windowId: 10, appName: "Google Chrome", title: "Late result" }]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fixture.createRun).not.toHaveBeenCalled();
  });

  it("does not override an explicitly host-selected window", async () => {
    const listWindows = vi.fn(async () => [{ pid: 2, windowId: 20, appName: "Google Chrome", title: "New Tab" }]);
    const fixture = makePendingCorrectionFixture(async () => undefined, { listWindows }, {
      kind: "cua",
      socketPath: "fixture.sock",
      screenshotDir: "runs/tui-explicit-window/screenshots",
    });
    const tui = runApplicationTui(fixture.session, {
      provider: "glm",
      computer: "cua",
      output: "runs/tui-explicit-window",
      profile: "live-interactive",
      riskGuard: "layered",
      windowSelectionAvailable: true,
      cuaWindowTarget: { pid: 1, windowId: 10 },
      cuaWindowDeliveryMode: "foreground",
      cuaWindowLabel: "Host-selected window",
    }, { terminal: { input: fixture.input, output: fixture.output } });

    fixture.input.emit("keypress", "Open Chrome", {});
    fixture.input.emit("keypress", "", { name: "return" });
    await waitForTui(() => fixture.createRun.mock.calls.length === 1 && fixture.session.status === "running");
    const startedConfig = ((fixture.createRun.mock.calls as unknown[][])[0]?.[0]) as ResolvedRunConfig | undefined;
    expect(listWindows).not.toHaveBeenCalled();
    expect(startedConfig?.computer).toMatchObject({ kind: "cua", windowTarget: { pid: 1, windowId: 10 }, windowDeliveryMode: "foreground" });

    fixture.input.emit("keypress", "", { name: "a" });
    await waitForTui(() => fixture.session.status === "idle");
    fixture.input.emit("keypress", "", { name: "escape" });
    fixture.input.emit("keypress", "", { name: "q" });
    await tui;
  });

  it("keeps an explicit desktop choice and managed-browser ownership out of local matching", async () => {
    const target = { pid: 4, windowId: 40, appName: "Google Chrome", title: "New Tab" };
    const listWindows = vi.fn(async () => [target]);
    const fixture = makePendingCorrectionFixture(async () => undefined, { listWindows }, {
      kind: "cua",
      socketPath: "fixture.sock",
      screenshotDir: "runs/tui-explicit-desktop/screenshots",
    });
    const tui = runApplicationTui(fixture.session, {
      provider: "glm",
      computer: "cua",
      output: "runs/tui-explicit-desktop",
      profile: "live-interactive",
      riskGuard: "layered",
      windowSelectionAvailable: true,
    }, { terminal: { input: fixture.input, output: fixture.output } });

    fixture.input.emit("keypress", "", { name: "escape" });
    fixture.input.emit("keypress", "W", { name: "w" });
    await waitForTui(() => fixture.outputText.join("").includes("Google Chrome — New Tab"));
    fixture.input.emit("keypress", "", { name: "return" });
    fixture.input.emit("keypress", "Open Chrome and inspect this page", {});
    fixture.input.emit("keypress", "", { name: "return" });
    await waitForTui(() => fixture.createRun.mock.calls.length === 1 && fixture.session.status === "running");
    const startedConfig = ((fixture.createRun.mock.calls as unknown[][])[0]?.[0]) as ResolvedRunConfig | undefined;
    expect(listWindows).toHaveBeenCalledTimes(1);
    expect(startedConfig?.computer).toMatchObject({ kind: "cua" });
    expect(startedConfig?.computer).not.toHaveProperty("windowTarget");
    expect(startedConfig?.computer).not.toHaveProperty("windowDeliveryMode");

    fixture.input.emit("keypress", "", { name: "a" });
    await waitForTui(() => fixture.session.status === "idle");
    fixture.input.emit("keypress", "", { name: "escape" });
    fixture.input.emit("keypress", "", { name: "q" });
    await tui;
  });

  it("requires an explicit desktop choice when CUA window discovery is unavailable", async () => {
    const fixture = makePendingCorrectionFixture(async () => undefined, undefined, {
      kind: "cua",
      socketPath: "fixture.sock",
      screenshotDir: "runs/tui-no-discovery/screenshots",
    });
    const tui = runApplicationTui(fixture.session, {
      provider: "glm",
      computer: "cua",
      output: "runs/tui-no-discovery",
      profile: "live-interactive",
      riskGuard: "layered",
      windowSelectionAvailable: false,
    }, { terminal: { input: fixture.input, output: fixture.output } });
    const goal = "Open the task window";

    fixture.input.emit("keypress", goal, {});
    fixture.input.emit("keypress", "", { name: "return" });
    await waitForTui(() => fixture.outputText.join("").includes("no target was auto-selected"));
    expect(fixture.createRun).not.toHaveBeenCalled();

    fixture.input.emit("keypress", "", { name: "return" });
    await waitForTui(() => fixture.outputText.join("").includes("Primary desktop selected"));
    expect(fixture.createRun).not.toHaveBeenCalled();
    fixture.input.emit("keypress", "", { name: "i" });
    fixture.input.emit("keypress", "", { name: "return" });
    await waitForTui(() => fixture.createRun.mock.calls.length === 1 && fixture.session.status === "running");
    const startedConfig = ((fixture.createRun.mock.calls as unknown[][])[0]?.[0]) as ResolvedRunConfig | undefined;
    expect(startedConfig?.computer).not.toHaveProperty("windowTarget");
    expect(startedConfig?.computer).not.toHaveProperty("windowDeliveryMode");

    fixture.input.emit("keypress", "", { name: "a" });
    await waitForTui(() => fixture.session.status === "idle");
    fixture.input.emit("keypress", "", { name: "escape" });
    fixture.input.emit("keypress", "", { name: "q" });
    await tui;
  });

  it("does not discover or bind desktop windows in managed-browser mode", async () => {
    const listWindows = vi.fn(async () => [{ pid: 5, windowId: 50, appName: "Google Chrome", title: "Google" }]);
    const fixture = makePendingCorrectionFixture(async () => undefined, { listWindows }, {
      kind: "cua",
      socketPath: "fixture.sock",
      screenshotDir: "runs/tui-managed-browser/screenshots",
    });
    const tui = runApplicationTui(fixture.session, {
      provider: "glm",
      computer: "cua",
      output: "runs/tui-managed-browser",
      profile: "live-interactive",
      riskGuard: "layered",
      managedBrowserUrl: "https://example.test/path",
      windowSelectionAvailable: true,
      features: {
        planning: false,
        memory: "off",
        memoryRetrieval: "off",
        batching: "off",
        contextMode: "raw",
        riskGuard: "layered",
        monitor: "off",
        grounding: "dom-catalog-v1",
      },
    }, { terminal: { input: fixture.input, output: fixture.output } });

    fixture.input.emit("keypress", "Open Chrome", {});
    fixture.input.emit("keypress", "", { name: "return" });
    await waitForTui(() => fixture.createRun.mock.calls.length === 1 && fixture.session.status === "running");
    const startedConfig = ((fixture.createRun.mock.calls as unknown[][])[0]?.[0]) as ResolvedRunConfig | undefined;
    expect(listWindows).not.toHaveBeenCalled();
    expect(startedConfig?.grounding).toBe("dom-catalog-v1");
    expect(startedConfig?.computer).not.toHaveProperty("windowTarget");
    expect(startedConfig?.computer).not.toHaveProperty("windowDeliveryMode");

    fixture.input.emit("keypress", "", { name: "a" });
    await waitForTui(() => fixture.session.status === "idle");
    fixture.input.emit("keypress", "", { name: "escape" });
    fixture.input.emit("keypress", "", { name: "q" });
    await tui;
  });

  it("selects a host window by label and keeps it for subsequent Runs", async () => {
    const fixture = makePendingCorrectionFixture(async () => undefined, {
      listWindows: async () => [{ pid: 1234, windowId: 5678, appName: "Browser", title: "12306" }],
    }, { kind: "cua", socketPath: "fixture.sock", screenshotDir: "runs/tui-windows/screenshots" });
    fixture.output.columns = 100;
    fixture.output.rows = 30;
    const tui = runApplicationTui(fixture.session, {
      provider: "glm",
      computer: "cua",
      output: "runs/tui-windows",
      profile: "live-interactive",
      riskGuard: "layered",
    }, { terminal: { input: fixture.input, output: fixture.output } });
    const tick = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)); };
    const waitFor = async (predicate: () => boolean): Promise<void> => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (predicate()) return;
        await tick();
      }
      throw new Error("TUI fixture condition was not reached");
    };

    fixture.input.emit("keypress", "", { name: "escape" });
    fixture.input.emit("keypress", "W", { name: "w" });
    await tick();
    await tick();
    expect(fixture.outputText.join("")).toContain("WINDOW TARGET");
    expect(fixture.outputText.join("")).toContain("Browser — 12306");
    expect(fixture.outputText.join("")).toContain("fully visible, unobscured");
    expect(fixture.outputText.join("")).toContain("Window layout is user-managed; Harness does not move/resize windows.");
    expect(fixture.outputText.join("")).toContain("occlusion support is limited");
    expect(fixture.outputText.join("")).toContain("focus restoration is not guaranteed");
    fixture.input.emit("keypress", "", { name: "down" });
    fixture.input.emit("keypress", "", { name: "return" });
    await tick();
    expect(fixture.outputText.join("")).toContain("Target: Browser — 12306; pid=1234; window=5678; delivery=foreground");

    fixture.input.emit("keypress", "打开目标窗口", {});
    fixture.input.emit("keypress", "", { name: "return" });
    await tick();
    await tick();
    const startedConfig = ((fixture.createRun.mock.calls as unknown[][])[0]?.[0]) as ResolvedRunConfig | undefined;
    expect(startedConfig?.computer).toMatchObject({ kind: "cua", windowTarget: { pid: 1234, windowId: 5678 }, windowDeliveryMode: "foreground" });

    fixture.input.emit("keypress", "", { name: "a" });
    await waitFor(() => fixture.session.status === "idle");
    await tick();

    fixture.input.emit("keypress", "第二个窗口任务", {});
    fixture.input.emit("keypress", "", { name: "return" });
    await waitFor(() => fixture.createRun.mock.calls.length >= 2);
    const secondConfig = ((fixture.createRun.mock.calls as unknown[][])[1]?.[0]) as ResolvedRunConfig | undefined;
    expect(secondConfig?.computer).toMatchObject({ kind: "cua", windowTarget: { pid: 1234, windowId: 5678 }, windowDeliveryMode: "foreground" });
    fixture.input.emit("keypress", "", { name: "a" });
    await waitFor(() => fixture.session.status === "idle");
    await tick();

    // Choosing the desktop explicitly clears the sticky window override for
    // the following Run; it must not silently fall back when a window dies.
    fixture.input.emit("keypress", "", { name: "escape" });
    fixture.input.emit("keypress", "W", { name: "w" });
    await tick();
    await tick();
    expect(fixture.outputText.join("")).toContain("Browser — 12306");
    fixture.input.emit("keypress", "", { name: "return" });
    await tick();
    fixture.input.emit("keypress", "第三个桌面任务", {});
    fixture.input.emit("keypress", "", { name: "return" });
    await waitFor(() => fixture.createRun.mock.calls.length >= 3);
    const thirdConfig = ((fixture.createRun.mock.calls as unknown[][])[2]?.[0]) as ResolvedRunConfig | undefined;
    expect(thirdConfig?.computer).toMatchObject({ kind: "cua" });
    expect(thirdConfig?.computer).not.toHaveProperty("windowTarget");
    expect(thirdConfig?.computer).not.toHaveProperty("windowDeliveryMode");
    fixture.input.emit("keypress", "", { name: "a" });
    await waitFor(() => fixture.session.status === "idle");
    await tick();
    fixture.input.emit("keypress", "", { name: "escape" });
    fixture.input.emit("keypress", "", { name: "q" });
    await tui;
  });

  it("ignores a late window-list result after cancel and reopen", async () => {
    let firstResolve!: (targets: readonly { pid: number; windowId: number; appName: string; title: string }[]) => void;
    const discovery = {
      listWindows: vi.fn()
        .mockImplementationOnce(() => new Promise((resolve) => { firstResolve = resolve; }))
        .mockResolvedValueOnce([{ pid: 2222, windowId: 3333, appName: "Second", title: "Fresh" }]),
    };
    const fixture = makePendingCorrectionFixture(async () => undefined, discovery);
    fixture.output.columns = 100;
    fixture.output.rows = 30;
    const tui = runApplicationTui(fixture.session, {
      provider: "glm",
      computer: "cua",
      output: "runs/tui-window-refresh",
      profile: "live-interactive",
      riskGuard: "layered",
    }, { terminal: { input: fixture.input, output: fixture.output } });
    const tick = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)); };

    fixture.input.emit("keypress", "", { name: "escape" });
    fixture.input.emit("keypress", "W", { name: "w" });
    await tick();
    fixture.input.emit("keypress", "", { name: "escape" });
    fixture.input.emit("keypress", "W", { name: "w" });
    await tick();
    await tick();
    expect(fixture.outputText.join("")).toContain("Second — Fresh");
    firstResolve([{ pid: 1111, windowId: 1112, appName: "Stale", title: "Old" }]);
    await tick();
    await tick();
    const rendered = fixture.outputText.join("");
    expect(rendered).not.toContain("Stale — Old");
    fixture.input.emit("keypress", "", { name: "escape" });
    fixture.input.emit("keypress", "", { name: "q" });
    await tui;
  });

  it("shows picker cleanup diagnostics after cancellation without changing the target", async () => {
    let rejectFirst!: (error: Error) => void;
    const discovery = {
      listWindows: vi.fn(() => new Promise<readonly { pid: number; windowId: number }[]>((_resolve, reject) => { rejectFirst = reject; })),
    };
    const fixture = makePendingCorrectionFixture(async () => undefined, discovery);
    const tui = runApplicationTui(fixture.session, {
      provider: "glm",
      computer: "cua",
      output: "runs/tui-window-cleanup",
      profile: "live-interactive",
      riskGuard: "layered",
    }, { terminal: { input: fixture.input, output: fixture.output } });
    const tick = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)); };
    fixture.input.emit("keypress", "", { name: "escape" });
    fixture.input.emit("keypress", "W", { name: "w" });
    await tick();
    fixture.input.emit("keypress", "", { name: "escape" });
    const error = new Error("window picker cleanup is not confirmed");
    error.name = "CuaWindowDiscoveryCleanupError";
    rejectFirst(error);
    await tick();
    await tick();
    expect(fixture.outputText.join("")).toContain("Window picker cleanup is unconfirmed");
    expect(fixture.outputText.join("")).toContain("Target: Primary desktop (default)");
    fixture.input.emit("keypress", "", { name: "q" });
    await tui;
  });

  it("renders status and does not expose typed action content", () => {
    const runId = "tui-run" as RunId;
    const snapshot = { ...initialRunSnapshot(runId), status: "running" as const };
    const events: RuntimeEvent[] = [{
      eventId: "event-1" as EventId,
      runId,
      sequence: 0,
      occurredAt: "2026-09-16T00:00:00.000Z",
      type: "action.execution.started" as const,
      action: { actionId: "action-1" as ActionId, kind: "type" as const, text: "private-value", basedOn: "observation-1" as ObservationId },
      executionObservationId: "observation-1" as ObservationId,
    }];
    const frame = buildTuiFrame(snapshot, events, "safe goal", { provider: "qwen", computer: "cua", output: "runs/test", profile: "live-interactive", riskGuard: "layered" }, { editMode: false, input: "", notice: "" });
    expect(frame).toContain("action.started: type");
    expect(frame).not.toContain("private-value");
  });

  it("strips terminal control sequences from untrusted UI text while retaining Chinese text", () => {
    const runId = "tui-terminal-run" as RunId;
    const snapshot = { ...initialRunSnapshot(runId), status: "running" as const };
    const injected = "中文👩‍💻\u001b[2J\u001b]0;FAKE-TITLE\u0007\u001b[31m\u001b[?25l\u2028line\u2029paragraph\u061cmark";
    const events: RuntimeEvent[] = [{
      eventId: "event-terminal" as EventId,
      runId,
      sequence: 0,
      occurredAt: "2026-09-16T00:00:00.000Z",
      type: "runtime.error" as const,
      category: injected,
      message: injected,
    }];
    const frame = buildTuiFrame(snapshot, events, injected, { provider: injected, computer: "cua", output: injected, profile: "live-interactive", riskGuard: "layered" }, { editMode: false, input: "", notice: injected });
    expect(frame).toContain("中文");
    expect(frame).toContain("👩‍💻");
    expect(frame).not.toContain("\u001b");
    expect(frame).not.toContain("FAKE-TITLE");
    expect(frame).not.toContain("\u2028");
    expect(frame).not.toContain("\u2029");
    expect(frame).not.toContain("\u061c");
  });

  it("renders the resolved profile and actual Guard mode", () => {
    const runId = "tui-profile-run" as RunId;
    const frame = buildTuiFrame({ ...initialRunSnapshot(runId), status: "running" as const }, [], "safe goal", {
      provider: "glm",
      computer: "cua",
      output: "runs/test",
      profile: "live-interactive",
      riskGuard: "layered",
    }, { editMode: false, input: "", notice: "" });
    expect(frame).toContain("Profile: live-interactive");
    expect(frame).toContain("Risk Guard: ENABLED (layered)");
    expect(frame).toContain("Focus evidence: UNKNOWN");
  });

  it("renders the host-selected CUA window target without implying model window discovery", () => {
    const runId = "tui-window-target" as RunId;
    const frame = buildTuiFrame({ ...initialRunSnapshot(runId), status: "running" as const }, [], "inspect selected window", {
      provider: "glm",
      computer: "cua",
      cuaWindowTarget: { pid: 1234, windowId: 5678 },
      output: "runs/test",
      profile: "live-interactive",
      riskGuard: "layered",
    }, { editMode: false, input: "", notice: "" });
    expect(frame).toContain("Target: window selected window pid=1234 id=5678 (host-selected, delivery=background)");
    expect(frame).toContain("Focus evidence: UNKNOWN");
  });

  it("renders a final reply and useful model request failure detail", () => {
    const runId = "tui-reply-run" as RunId;
    const snapshot = { ...initialRunSnapshot(runId), status: "finished" as const, outcome: "failed" as const, summary: "无法完成：模型请求失败" };
    const event: RuntimeEvent = {
      eventId: "event-model-failure" as EventId,
      runId,
      sequence: 0,
      occurredAt: "2026-09-18T00:00:00.000Z",
      type: "model.request.failed",
      category: "transport",
      message: "provider request failed",
    };
    const frame = buildTuiFrame(snapshot, [event], "打开任务管理器看内存", { provider: "glm", computer: "cua", output: "runs/test", profile: "live-interactive", riskGuard: "layered" }, { editMode: false, input: "", notice: "" });
    expect(frame).toContain("Reply [1/1]");
    expect(frame).toContain("无法完成：模型请求失败");
    expect(frame).toContain("model.request.failed: provider request failed");
    expect(frame).toContain("打开任务管理器看内存");

    const waitingFrame = buildTuiFrame({ ...initialRunSnapshot(runId), status: "running" as const }, [{
      ...event,
      eventId: "event-model-start" as EventId,
      type: "model.request.started",
      providerId: "fixture-provider",
      contextBudget: { mode: "raw", estimatedInputTokens: 10, selectedHistoryEvents: 0, omittedHistoryEvents: 0 },
    }], "打开任务管理器看内存", { provider: "glm", computer: "cua", output: "runs/test", profile: "live-interactive", riskGuard: "layered" }, { editMode: false, input: "", notice: "" });
    expect(waitingFrame).toContain("WAITING: provider request in progress");
    expect(waitingFrame).toContain("no global hotkeys");
  });

  it("pages long questions and approvals, and keeps the newest sanitized input visible", () => {
    const runId = "tui-long-detail" as RunId;
    const longQuestion = Array.from({ length: 18 }, (_, index) => `问题${index}-请确认任务管理器内存`).join("\n");
    const questionFrame = buildTuiFrame({ ...initialRunSnapshot(runId), status: "waiting_user" as const, pendingUserQuestion: longQuestion }, [], "长任务", { provider: "glm", computer: "cua", output: "runs/test", profile: "live-interactive", riskGuard: "layered" }, { editMode: false, input: "", notice: "", columns: 24, rows: 22, detailPage: 0 });
    const questionNextPage = buildTuiFrame({ ...initialRunSnapshot(runId), status: "waiting_user" as const, pendingUserQuestion: longQuestion }, [], "长任务", { provider: "glm", computer: "cua", output: "runs/test", profile: "live-interactive", riskGuard: "layered" }, { editMode: false, input: "", notice: "", columns: 24, rows: 22, detailPage: 1 });
    expect(questionFrame).toContain("Question [1/");
    expect(questionFrame).toContain("问题0");
    expect(questionNextPage).toContain("Question [2/");
    expect(questionNextPage).toContain("问题1");

    const approvalFrame = buildTuiFrame({ ...initialRunSnapshot(runId), status: "waiting_approval" as const, pendingApproval: { requestId: "approval-1", callId: "call-1" as ToolCallId, reason: longQuestion } }, [], "长任务", { provider: "glm", computer: "cua", output: "runs/test", profile: "live-interactive", riskGuard: "layered" }, { editMode: false, input: "", notice: "", columns: 24, rows: 22, detailPage: 0 });
    expect(approvalFrame).toContain("Approval [1/");

    const inputFrame = buildTuiFrame({ ...initialRunSnapshot(runId), status: "running" as const }, [], "长任务", { provider: "glm", computer: "cua", output: "runs/test", profile: "live-interactive", riskGuard: "layered" }, { editMode: true, input: `前缀很长${"字".repeat(80)}\u001b[2J尾部`, notice: "", inputLimitReached: true, columns: 24, rows: 22, detailPage: 0 });
    expect(inputFrame).toContain("尾部");
    expect(inputFrame).not.toContain("\u001b");
    expect(inputFrame).toContain("Editing: Enter submit");
    expect(inputFrame).toContain("Esc cancel");
    expect(inputFrame).toContain("Input is limited to 500 characters");
    expect(inputFrame).not.toContain("Keys: I correction/input");
  });

  it("explains why an approval is pending without rendering tool arguments", () => {
    const runId = "tui-approval-explanation" as RunId;
    const callId = "approval-call" as ToolCallId;
    const snapshot = {
      ...initialRunSnapshot(runId),
      status: "waiting_approval" as const,
      pendingApproval: { requestId: "approval-1", callId, reason: "Risk semantics are unclear and no reviewer is configured." },
    };
    const events: RuntimeEvent[] = [
      {
        eventId: "approval-call-received" as EventId,
        runId,
        sequence: 1,
        occurredAt: "2026-09-20T00:00:00.000Z",
        type: "tool.call.received",
        call: {
          id: callId,
          name: "click",
          arguments: { text: "private-value" },
          declaredEffect: { effects: ["external_commitment"], target: "查询按钮", summary: "提交查询结果，不创建订单" },
        },
      },
      {
        eventId: "approval-guard" as EventId,
        runId,
        sequence: 2,
        occurredAt: "2026-09-20T00:00:00.001Z",
        type: "action.guard.evaluated",
        callIds: [callId],
        actions: [],
        decision: "require_approval",
        categories: ["external_commitment"],
        reasonCode: "semantic_review_unavailable",
        reason: "Risk semantics are unclear and no reviewer is configured.",
        path: "fallback",
        policyVersion: "layered-effects-v1",
        modelRequestCount: 0,
      },
    ];
    const frame = buildTuiFrame(snapshot, events, "查询车票", { provider: "glm", computer: "cua", output: "runs/test", profile: "live-interactive", riskGuard: "layered" }, { editMode: false, input: "", notice: "", columns: 100, rows: 40 });
    expect(frame).toContain("APPROVAL REQUIRED: Run is waiting");
    expect(frame).toContain("Approval is pending: the Run is waiting and no GUI action is executing.");
    expect(frame).toContain("Action: click");
    expect(frame).toContain("Target: 查询按钮");
    expect(frame).toContain("Intent: 提交查询结果，不创建订单");
    expect(frame).toContain("Effects: external_commitment");
    expect(frame).toContain("Guard detail: require_approval via fallback (semantic_review_unavailable)");
    expect(frame).toContain("Why: Risk semantics are unclear and no reviewer is configured.");
    expect(frame).toContain("Approval controls: Y approve   N reject   I correct   A abort");
    expect(frame).not.toContain("private-value");
    const compactFrame = buildTuiFrame(snapshot, events, "查询车票", { provider: "glm", computer: "cua", output: "runs/test", profile: "live-interactive", riskGuard: "layered" }, { editMode: false, input: "", notice: "", columns: 100, rows: 24 });
    expect(compactFrame).toContain("Why: Risk semantics are unclear and no reviewer is configured.");
    expect(compactFrame).toContain("Approval controls: Y approve   N reject   I correct   A abort");
  });

  it("wraps graphemes by terminal display width without splitting emoji or combining marks", () => {
    const value = "中🙂👩‍💻é全幅";
    const lines = wrapTuiText(value, 6);
    expect(lines.every((line) => stringWidth(line) <= 6)).toBe(true);
    expect(lines.join("")).toBe(value);
    const limited = limitTuiInput(`${"😀".repeat(510)}é`, 500);
    expect(limited.truncated).toBe(true);
    expect(removeLastTuiGrapheme("A😀é")).toBe("A😀");
    expect(stringWidth(tailTuiInput(`${"中".repeat(20)}👩‍💻`, 8))).toBeLessThanOrEqual(8);
  });

  it("coalesces rapid pasted keypress paints without dropping the newest input", async () => {
    const input = new PassThrough() as PassThrough & { isTTY?: boolean; setRawMode?: (mode: boolean) => void };
    const output = new PassThrough() as PassThrough & { isTTY?: boolean; columns?: number; rows?: number };
    input.isTTY = true;
    output.isTTY = true;
    output.columns = 24;
    output.rows = 22;
    const rawModes: boolean[] = [];
    input.setRawMode = (mode) => rawModes.push(mode);
    const outputText: string[] = [];
    output.on("data", (chunk: Buffer) => outputText.push(chunk.toString("utf8")));
    const session = new ApplicationSession({
      config: {
        model: "glm-5.3-flash",
        computer: { kind: "osworld", bridgeUrl: "http://tui-paste" },
        outputDir: "runs/tui-paste",
        maxSteps: 1,
        maxModelRequests: 1,
        planning: false,
        memory: "off",
        batching: "off",
        contextMode: "raw",
        contextMaxHistoryEvents: 2,
        riskProfile: "live-interactive",
        riskGuard: "layered",
        riskModel: "off",
        riskMaxModelRequests: 1,
        riskTimeoutMs: 100,
        cleanupDeadlineMs: 100,
      },
      owner: new InProcessEnvironmentOwner(),
    });
    const tui = runApplicationTui(session, {
      provider: "glm",
      computer: "osworld",
      output: "runs/tui-paste",
      profile: "live-interactive",
      riskGuard: "layered",
    }, { terminal: { input, output } });
    input.emit("keypress", "", { name: "I" });
    for (let index = 0; index < 650; index += 1) input.emit("keypress", "字", {});
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const rendered = outputText.join("");
    expect(rendered.replace(/\s+/gu, " ")).toContain("Input limit reached (500 characters)");
    expect(rendered).toContain("> …字");
    expect(rendered.split("\u001b[H\u001b[2J").length).toBeLessThanOrEqual(5);
    input.emit("keypress", "", { name: "escape" });
    input.emit("keypress", "", { name: "q" });
    await tui;
    expect(rawModes).toEqual([true, false]);
  });

  it("keeps a home session, accepts pasted Chinese correction, and restores the terminal on exit", async () => {
    const input = new PassThrough() as PassThrough & { isTTY?: boolean; setRawMode?: (mode: boolean) => void };
    const output = new PassThrough() as PassThrough & { isTTY?: boolean; columns?: number; rows?: number };
    input.isTTY = true;
    output.isTTY = true;
    output.columns = 24;
    output.rows = 22;
    const rawModes: boolean[] = [];
    input.setRawMode = (mode) => rawModes.push(mode);
    const outputText: string[] = [];
    output.on("data", (chunk: Buffer) => outputText.push(chunk.toString("utf8")));

    let resolveStart!: (outcome: RunOutcome) => void;
    let releasePause!: () => void;
    const pauseReady = new Promise<void>((resolve) => { releasePause = resolve; });
    let snapshot: RunSnapshot = { ...initialRunSnapshot("tui-session-run" as RunId), status: "running" };
    const controller = {
      getSnapshot: vi.fn(() => structuredClone(snapshot)),
      getEventsAfter: vi.fn(() => []),
      submitUserInput: vi.fn(async () => undefined),
      cancel: vi.fn(() => {
        snapshot = { ...snapshot, status: "finished", outcome: "cancelled" };
        resolveStart("cancelled");
      }),
      pause: vi.fn(async () => { await pauseReady; snapshot = { ...snapshot, status: "paused" }; }),
      resume: vi.fn(async () => { snapshot = { ...snapshot, status: "running" }; }),
    } as unknown as RunController;
    const config = {
      goal: "placeholder",
      model: "glm-5.3-flash",
      computer: { kind: "osworld", bridgeUrl: "http://tui-fixture" },
      outputDir: "runs/tui-test",
      maxSteps: 2,
      maxModelRequests: 2,
      planning: false,
      memory: "off",
      batching: "off",
      contextMode: "raw",
      contextMaxHistoryEvents: 4,
      riskProfile: "live-interactive",
      riskGuard: "layered",
      riskModel: "off",
      riskMaxModelRequests: 1,
      riskTimeoutMs: 100,
      cleanupDeadlineMs: 100,
    } as ResolvedRunConfig;
    const eventFeed = createRunEventFeed();
    const handle = {
      runId: "tui-session-run" as RunId,
      config,
      controller,
      eventFeed,
      start: vi.fn(() => new Promise<RunOutcome>((resolve) => { resolveStart = resolve; })),
      report: vi.fn(async () => ({ runId: config.runId!, outcome: "cancelled" as const, summary: { cleanupDiagnostics: [] }, snapshot: { ...snapshot, status: "finished" as const, outcome: "cancelled" as const }, events: [] })),
      close: vi.fn(async () => undefined),
    } as unknown as RunHandle;
    const createRun = vi.fn(async () => handle);
    const sessionConfig: ApplicationSessionConfig = { ...config };
    delete (sessionConfig as Partial<ResolvedRunConfig>).goal;
    const session = new ApplicationSession({
      config: sessionConfig,
      createRun,
      owner: new InProcessEnvironmentOwner(),
    });
    const tui = runApplicationTui(session, {
      provider: "glm",
      computer: "osworld",
      output: "runs/tui-test",
      profile: "live-interactive",
      riskGuard: "layered",
    }, { terminal: { input, output } });
    const tick = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)); };
    input.emit("keypress", "查看支付历史", {});
    input.emit("keypress", "", { name: "return" });
    output.emit("resize");
    await tick();
    await tick();
    expect(session.activeRun).toBe(handle);
    input.emit("keypress", "", { name: "I" });
    await tick();
    await tick();
    expect(controller.pause).toHaveBeenCalledWith("paused before TUI correction");
    expect(outputText.join("")).toContain("Notice: Pausing Run");
    input.emit("keypress", "不要发送草稿", {});
    input.emit("keypress", "", { name: "return" });
    await tick();
    expect(controller.submitUserInput).not.toHaveBeenCalled();
    input.emit("keypress", "", { name: "return" });
    await tick();
    expect(controller.submitUserInput).not.toHaveBeenCalled();
    releasePause();
    await tick();
    await tick();
    expect(controller.submitUserInput).toHaveBeenCalledWith("不要发送草稿");
    expect(controller.submitUserInput).toHaveBeenCalledTimes(1);
    expect(controller.resume).toHaveBeenCalledTimes(1);
    input.emit("keypress", "", { name: "a" });
    await tick();
    await tick();
    input.emit("keypress", "", { name: "pagedown" });
    input.emit("keypress", "", { name: "escape" });
    input.emit("keypress", "", { name: "escape" });
    input.emit("keypress", "", { name: "q" });
    await tui;
    expect(rawModes).toEqual([true, false]);
    expect(outputText.join("")).toContain("HOME");
    expect(outputText.join("")).toContain("查看支付历史");
    expect(outputText.join("")).toContain("不要发送草稿");
    expect(outputText.join("")).toContain("Details [");
    expect(outputText.join("").replace(/\s+/gu, " ")).toContain("No final reply was reported (cancelled).");
    expect(outputText.join("")).not.toContain("characters hidden");
  });

  it("does not submit a correction when the pause barrier rejects", async () => {
    let rejectPause!: (error: Error) => void;
    const fixture = makePendingCorrectionFixture(() => new Promise<void>((_resolve, reject) => { rejectPause = reject; }));
    const tui = runApplicationTui(fixture.session, {
      provider: "glm",
      computer: "osworld",
      output: "runs/tui-pending",
      profile: "live-interactive",
      riskGuard: "layered",
    }, { terminal: { input: fixture.input, output: fixture.output } });
    const tick = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)); };
    fixture.input.emit("keypress", "打开任务管理器看内存", {});
    fixture.input.emit("keypress", "", { name: "return" });
    await tick();
    await tick();
    fixture.input.emit("keypress", "I", { name: "I" });
    await tick();
    fixture.input.emit("keypress", "不要发送草稿", {});
    fixture.input.emit("keypress", "", { name: "return" });
    expect(fixture.controller.submitUserInput).not.toHaveBeenCalled();
    rejectPause(new Error("pause refused by fixture"));
    await tick();
    await tick();
    expect(fixture.controller.submitUserInput).not.toHaveBeenCalled();
    expect(fixture.outputText.join("")).toContain("Correction unavailable");
    fixture.input.emit("keypress", "", { name: "escape" });
    fixture.input.emit("keypress", "", { name: "q" });
    await tui;
  });

  it("discards a pending correction on abort and resumes no late pause", async () => {
    let releasePause!: () => void;
    const fixture = makePendingCorrectionFixture(() => new Promise<void>((resolve) => { releasePause = resolve; }));
    const tui = runApplicationTui(fixture.session, {
      provider: "glm",
      computer: "osworld",
      output: "runs/tui-pending",
      profile: "live-interactive",
      riskGuard: "layered",
    }, { terminal: { input: fixture.input, output: fixture.output } });
    const tick = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)); };
    fixture.input.emit("keypress", "打开任务管理器看内存", {});
    fixture.input.emit("keypress", "", { name: "return" });
    await tick();
    await tick();
    fixture.input.emit("keypress", "I", { name: "I" });
    await tick();
    fixture.input.emit("keypress", "不要发送草稿", {});
    fixture.input.emit("keypress", "", { name: "c", ctrl: true });
    expect(fixture.controller.submitUserInput).not.toHaveBeenCalled();
    releasePause();
    await tick();
    await tick();
    expect(fixture.controller.resume).toHaveBeenCalledTimes(1);
    expect(fixture.controller.getSnapshot().status).toBe("finished");
    fixture.input.emit("keypress", "", { name: "escape" });
    fixture.input.emit("keypress", "", { name: "q" });
    await tui;
    expect(fixture.rawModes).toEqual([true, false]);
  });

  it("cancels a pending correction with Escape and repairs a late pause", async () => {
    let releasePause!: () => void;
    const fixture = makePendingCorrectionFixture(() => new Promise<void>((resolve) => { releasePause = resolve; }));
    const tui = runApplicationTui(fixture.session, {
      provider: "glm",
      computer: "osworld",
      output: "runs/tui-pending",
      profile: "live-interactive",
      riskGuard: "layered",
    }, { terminal: { input: fixture.input, output: fixture.output } });
    const tick = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)); };
    fixture.input.emit("keypress", "打开任务管理器看内存", {});
    fixture.input.emit("keypress", "", { name: "return" });
    await tick();
    await tick();
    fixture.input.emit("keypress", "I", { name: "I" });
    await tick();
    fixture.input.emit("keypress", "不要发送草稿", {});
    fixture.input.emit("keypress", "", { name: "escape" });
    expect(fixture.controller.submitUserInput).not.toHaveBeenCalled();
    releasePause();
    await tick();
    await tick();
    expect(fixture.controller.resume).toHaveBeenCalledTimes(1);
    fixture.input.emit("keypress", "", { name: "q" });
    await tui;
  });

  it("does not let an old Run pause callback resume a new paused Run", async () => {
    let releaseOldPause!: () => void;
    const fixture = makePendingCorrectionFixture(() => new Promise<void>((resolve) => { releaseOldPause = resolve; }));
    const newRunId = "tui-new-run" as RunId;
    let resolveNewStart!: (outcome: RunOutcome) => void;
    let newSnapshot: RunSnapshot = { ...initialRunSnapshot(newRunId), status: "running" };
    const newController = {
      getSnapshot: vi.fn(() => structuredClone(newSnapshot)),
      getEventsAfter: vi.fn(() => []),
      cancel: vi.fn(() => { newSnapshot = { ...newSnapshot, status: "finished", outcome: "cancelled" }; resolveNewStart("cancelled"); }),
      pause: vi.fn(async () => { newSnapshot = { ...newSnapshot, status: "paused" }; }),
      resume: vi.fn(async () => { newSnapshot = { ...newSnapshot, status: "running" }; }),
    } as unknown as RunController;
    const newConfig = { ...fixture.handle.config, runId: newRunId, outputDir: "runs/tui-new-run" } as ResolvedRunConfig;
    const newHandle = {
      runId: newRunId,
      config: newConfig,
      controller: newController,
      eventFeed: createRunEventFeed({ runId: newRunId }),
      start: vi.fn(() => new Promise<RunOutcome>((resolve) => { resolveNewStart = resolve; })),
      report: vi.fn(async () => ({ runId: newRunId, outcome: "cancelled" as const, summary: { cleanupDiagnostics: [] }, snapshot: { ...newSnapshot, status: "finished" as const, outcome: "cancelled" as const }, events: [] })),
      close: vi.fn(async () => undefined),
    } as unknown as RunHandle;
    fixture.createRun.mockResolvedValueOnce(fixture.handle).mockResolvedValueOnce(newHandle);
    const tui = runApplicationTui(fixture.session, {
      provider: "glm",
      computer: "osworld",
      output: "runs/tui-pending",
      profile: "live-interactive",
      riskGuard: "layered",
    }, { terminal: { input: fixture.input, output: fixture.output } });
    const tick = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)); };
    fixture.input.emit("keypress", "旧任务", {});
    fixture.input.emit("keypress", "", { name: "return" });
    await tick();
    await tick();
    fixture.input.emit("keypress", "I", { name: "I" });
    await tick();
    fixture.controller.cancel();
    await tick();
    await tick();
    fixture.input.emit("keypress", "新任务", {});
    fixture.input.emit("keypress", "", { name: "return" });
    await tick();
    await tick();
    fixture.input.emit("keypress", "", { name: "p" });
    await tick();
    expect(newSnapshot.status).toBe("paused");
    releaseOldPause();
    await tick();
    await tick();
    expect(newController.resume).not.toHaveBeenCalled();
    fixture.input.emit("keypress", "", { name: "c", ctrl: true });
    await tick();
    await tick();
    fixture.input.emit("keypress", "", { name: "escape" });
    fixture.input.emit("keypress", "", { name: "q" });
    await tui;
  });

  it("retains only the newest reply when a second Run starts", async () => {
    const input = new PassThrough() as PassThrough & { isTTY?: boolean; setRawMode?: (mode: boolean) => void };
    const output = new PassThrough() as PassThrough & { isTTY?: boolean; columns?: number; rows?: number };
    input.isTTY = true;
    output.isTTY = true;
    const rawModes: boolean[] = [];
    input.setRawMode = (mode) => rawModes.push(mode);
    const outputText: string[] = [];
    output.on("data", (chunk: Buffer) => outputText.push(chunk.toString("utf8")));
    const makeHandle = (runId: RunId, summary: string) => {
      let resolveStart!: (outcome: RunOutcome) => void;
      let snapshot: RunSnapshot = { ...initialRunSnapshot(runId), status: "running" };
      const controller = {
        getSnapshot: vi.fn(() => structuredClone(snapshot)),
        getEventsAfter: vi.fn(() => []),
        cancel: vi.fn(() => { snapshot = { ...snapshot, status: "finished", outcome: "cancelled" }; resolveStart("cancelled"); }),
      } as unknown as RunController;
      const config = {
        goal: "placeholder",
        model: "glm-5.3-flash",
        computer: { kind: "osworld", bridgeUrl: "http://tui-reply" },
        outputDir: `runs/${runId}`,
        maxSteps: 2,
        maxModelRequests: 2,
        planning: false,
        memory: "off",
        batching: "off",
        contextMode: "raw",
        contextMaxHistoryEvents: 4,
        riskProfile: "live-interactive",
        riskGuard: "layered",
        riskModel: "off",
        riskMaxModelRequests: 1,
        riskTimeoutMs: 100,
        cleanupDeadlineMs: 100,
      } as ResolvedRunConfig;
      const eventFeed = createRunEventFeed({ runId });
      const handle = {
        runId,
        config,
        controller,
        eventFeed,
        start: vi.fn(() => new Promise<RunOutcome>((resolve) => { resolveStart = resolve; })),
        report: vi.fn(async () => ({ runId, outcome: "succeeded" as const, summary: { cleanupDiagnostics: [] }, snapshot: { ...snapshot, status: "finished" as const, outcome: "succeeded" as const, summary }, events: [] })),
        close: vi.fn(async () => undefined),
      } as unknown as RunHandle;
      return { handle, finish: () => { snapshot = { ...snapshot, status: "finished", outcome: "succeeded", summary }; resolveStart("succeeded"); } };
    };
    const first = makeHandle("tui-reply-one" as RunId, "第一轮最终回复");
    const second = makeHandle("tui-reply-two" as RunId, `第二轮最终回复\n${Array.from({ length: 18 }, (_, index) => `细节${index}`).join("\n")}`);
    const sessionConfig: ApplicationSessionConfig = {
      model: "glm-5.3-flash",
      computer: { kind: "osworld", bridgeUrl: "http://tui-reply" },
      outputDir: "runs/tui-replies",
      maxSteps: 2,
      maxModelRequests: 2,
      planning: false,
      memory: "off",
      batching: "off",
      contextMode: "raw",
      contextMaxHistoryEvents: 4,
      riskProfile: "live-interactive",
      riskGuard: "layered",
      riskModel: "off",
      riskMaxModelRequests: 1,
      riskTimeoutMs: 100,
      cleanupDeadlineMs: 100,
    };
    const handles = [first.handle, second.handle];
    const session = new ApplicationSession({ config: sessionConfig, createRun: vi.fn(async () => handles.shift()!), owner: new InProcessEnvironmentOwner() });
    const tui = runApplicationTui(session, { provider: "glm", computer: "osworld", output: "runs/tui-replies", profile: "live-interactive", riskGuard: "layered" }, { terminal: { input, output } });
    const tick = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)); };
    input.emit("keypress", "第一轮", {});
    input.emit("keypress", "", { name: "return" });
    await tick();
    await tick();
    first.finish();
    await tick();
    await tick();
    input.emit("keypress", "第二轮", {});
    input.emit("keypress", "", { name: "return" });
    await tick();
    await tick();
    second.finish();
    await tick();
    await tick();
    input.emit("keypress", "", { name: "pagedown" });
    await tick();
    const latestReplyFrame = outputText.join("").split("\u001b[H\u001b[2J").at(-1) ?? "";
    expect(latestReplyFrame).toContain("Harness | DETAILS");
    expect(latestReplyFrame).toContain("第二轮最终回复");
    expect(latestReplyFrame).not.toContain("第一轮最终回复");
    input.emit("keypress", "", { name: "escape" });
    input.emit("keypress", "", { name: "escape" });
    input.emit("keypress", "", { name: "q" });
    await tui;
    const frames = outputText.join("").split("\u001b[H\u001b[2J");
    const lastFrame = frames[frames.length - 1] ?? "";
    expect(lastFrame).toContain("HOME");
    expect(lastFrame.split("\n").length).toBeLessThanOrEqual(23);
    expect(rawModes).toEqual([true, false]);
  });

  it("restores raw mode and cursor when Escape carries no text before any Run starts", async () => {
    const input = new PassThrough() as PassThrough & { isTTY?: boolean; setRawMode?: (mode: boolean) => void };
    const output = new PassThrough() as PassThrough & { isTTY?: boolean; columns?: number };
    input.isTTY = true;
    output.isTTY = true;
    const rawModes: boolean[] = [];
    input.setRawMode = (mode) => rawModes.push(mode);
    const session = new ApplicationSession({
      config: {
        model: "glm-5.3-flash",
        computer: { kind: "osworld", bridgeUrl: "http://tui-eof" },
        outputDir: "runs/tui-eof",
        maxSteps: 1,
        maxModelRequests: 1,
        planning: false,
        memory: "off",
        batching: "off",
        contextMode: "raw",
        contextMaxHistoryEvents: 2,
        riskProfile: "live-interactive",
        riskGuard: "layered",
        riskModel: "off",
        riskMaxModelRequests: 1,
        riskTimeoutMs: 100,
        cleanupDeadlineMs: 100,
      },
    });
    const tui = runApplicationTui(session, {
      provider: "glm",
      computer: "osworld",
      output: "runs/tui-eof",
      profile: "live-interactive",
      riskGuard: "layered",
    }, { terminal: { input, output } });
    // Node's readline keypress event supplies undefined text for Escape. The
    // handler must still take the exit path and restore the terminal before q
    // is processed; this is the real ESC -> q sequence observed on Windows.
    input.emit("keypress", undefined as unknown as string, { name: "escape" });
    input.emit("keypress", "", { name: "q" });
    await tui;
    expect(rawModes).toEqual([true, false]);
  });

  it("restores the terminal on EOF even when a Provider lifecycle never settles", async () => {
    const input = new PassThrough() as PassThrough & { isTTY?: boolean; setRawMode?: (mode: boolean) => void };
    const output = new PassThrough() as PassThrough & { isTTY?: boolean; columns?: number };
    input.isTTY = true;
    output.isTTY = true;
    const rawModes: boolean[] = [];
    input.setRawMode = (mode) => rawModes.push(mode);
    const runId = "tui-never-settles" as RunId;
    const config = {
      goal: "hang",
      model: "glm-5.3-flash",
      computer: { kind: "osworld", bridgeUrl: "http://tui-hang" },
      outputDir: "runs/tui-hang",
      maxSteps: 1,
      maxModelRequests: 1,
      planning: false,
      memory: "off",
      batching: "off",
      contextMode: "raw",
      contextMaxHistoryEvents: 2,
      riskProfile: "live-interactive",
      riskGuard: "layered",
      riskModel: "off",
      riskMaxModelRequests: 1,
      riskTimeoutMs: 100,
      cleanupDeadlineMs: 100,
      runId,
    } as ResolvedRunConfig;
    const controller = {
      getSnapshot: vi.fn(() => ({ ...initialRunSnapshot(runId), status: "running" as const })),
      cancel: vi.fn(),
    } as unknown as RunController;
    const handle = {
      runId,
      config,
      controller,
      eventFeed: createRunEventFeed({ runId }),
      start: vi.fn(() => new Promise<RunOutcome>(() => {})),
      report: vi.fn(async () => { throw new Error("report must not run before lifecycle settles"); }),
      close: vi.fn(async () => undefined),
    } as unknown as RunHandle;
    const owner = new (await import("@computer-harness/app-runtime")).InProcessEnvironmentOwner();
    const session = new ApplicationSession({
      config: {
        ...config,
      },
      createRun: async () => handle,
      owner,
    });
    const tui = runApplicationTui(session, {
      provider: "glm",
      computer: "osworld",
      output: "runs/tui-hang",
      profile: "live-interactive",
      riskGuard: "layered",
    }, { terminal: { input, output }, initialGoal: "hang", lifecycleWaitMs: 10 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(session.activeRun).toBe(handle);
    input.emit("end");
    await tui;
    expect(rawModes).toEqual([true, false]);
    expect(session.inspectEnvironment()?.state).toBe("pending_cleanup");
  });
});
