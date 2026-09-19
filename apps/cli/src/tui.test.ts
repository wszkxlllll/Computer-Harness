import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ActionId, EventId, ObservationId, RunId, RuntimeEvent, RunOutcome, ToolCallId } from "@computer-harness/protocol";
import type { RunController } from "@computer-harness/runtime";
import type { RunHandle, ResolvedRunConfig } from "@computer-harness/app-runtime";
import { ApplicationSession, createRunEventFeed, InProcessEnvironmentOwner, type ApplicationSessionConfig } from "@computer-harness/app-runtime";
import { initialRunSnapshot, type RunSnapshot } from "@computer-harness/trajectory";
import { buildTuiFrame, runApplicationTui } from "./tui.js";
import { limitTuiInput, removeLastTuiGrapheme, tailTuiInput, wrapTuiText } from "./tui-text.js";
import stringWidth from "string-width";

function makePendingCorrectionFixture(pauseBarrier: () => Promise<void>) {
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
    computer: { kind: "osworld", bridgeUrl: "http://tui-fixture" },
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
  const session = new ApplicationSession({
    config: sessionConfig,
    createRun,
    owner: new InProcessEnvironmentOwner(),
  });
  return { input, output, outputText, rawModes, controller, session, handle, runId, createRun };
}

describe("TUI renderer", () => {
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
    fixture.input.emit("keypress", "", { name: "return" });
    await tick();
    expect(fixture.outputText.join("")).toContain("memory=facts/lexical");

    fixture.input.emit("keypress", "打开任务管理器", {});
    fixture.input.emit("keypress", "", { name: "return" });
    await tick();
    const startedConfig = ((fixture.createRun.mock.calls as unknown[][])[0]?.[0]) as ResolvedRunConfig | undefined;
    expect(startedConfig?.planning).toBe(false);
    expect(startedConfig?.memory).toBe("facts");
    expect(startedConfig?.memoryRetrieval).toBe("lexical");
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
    expect(rendered).toContain("Input is limited to 500 characters");
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
    input.emit("keypress", "", { name: "escape" });
    input.emit("keypress", "", { name: "q" });
    await tui;
    expect(rawModes).toEqual([true, false]);
    expect(outputText.join("")).toContain("HOME");
    expect(outputText.join("")).toContain("查看支付历史");
    expect(outputText.join("")).toContain("不要发送草稿");
    expect(outputText.join("")).toContain("No final reply was r");
    expect(outputText.join("")).toContain("eported (cancelled)");
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
    input.emit("keypress", "", { name: "escape" });
    input.emit("keypress", "", { name: "q" });
    await tui;
    const frames = outputText.join("").split("\u001b[H\u001b[2J");
    const lastFrame = frames[frames.length - 1] ?? "";
    expect(lastFrame).toContain("Last reply [2/");
    expect(lastFrame).toContain("细节");
    expect(lastFrame).not.toContain("第一轮最终回复");
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
