import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ActionId, EventId, ObservationId, RunId, RuntimeEvent, RunOutcome } from "@computer-harness/protocol";
import type { RunController } from "@computer-harness/runtime";
import type { RunHandle, ResolvedRunConfig } from "@computer-harness/app-runtime";
import { ApplicationSession, createRunEventFeed, InProcessEnvironmentOwner, type ApplicationSessionConfig } from "@computer-harness/app-runtime";
import { initialRunSnapshot, type RunSnapshot } from "@computer-harness/trajectory";
import { buildTuiFrame, runApplicationTui } from "./tui.js";

describe("TUI renderer", () => {
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
    const injected = "中文\u001b[2J\u001b]0;FAKE-TITLE\u0007\u001b[31m\u001b[?25l\u2028line\u2029paragraph\u061cmark";
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

  it("keeps a home session, accepts pasted Chinese correction, and restores the terminal on exit", async () => {
    const input = new PassThrough() as PassThrough & { isTTY?: boolean; setRawMode?: (mode: boolean) => void };
    const output = new PassThrough() as PassThrough & { isTTY?: boolean; columns?: number };
    input.isTTY = true;
    output.isTTY = true;
    const rawModes: boolean[] = [];
    input.setRawMode = (mode) => rawModes.push(mode);
    const outputText: string[] = [];
    output.on("data", (chunk: Buffer) => outputText.push(chunk.toString("utf8")));

    let resolveStart!: (outcome: RunOutcome) => void;
    let snapshot: RunSnapshot = { ...initialRunSnapshot("tui-session-run" as RunId), status: "running" };
    const controller = {
      getSnapshot: vi.fn(() => structuredClone(snapshot)),
      submitUserInput: vi.fn(async () => undefined),
      cancel: vi.fn(() => {
        snapshot = { ...snapshot, status: "finished", outcome: "cancelled" };
        resolveStart("cancelled");
      }),
      pause: vi.fn(async () => { snapshot = { ...snapshot, status: "paused" }; }),
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
    input.emit("keypress", "", { name: "i" });
    await tick();
    await tick();
    expect(controller.pause).toHaveBeenCalledWith("paused before TUI correction");
    input.emit("keypress", "不要发送草稿", {});
    input.emit("keypress", "", { name: "return" });
    await tick();
    expect(controller.submitUserInput).toHaveBeenCalledWith("不要发送草稿");
    expect(controller.resume).toHaveBeenCalled();
    input.emit("keypress", "", { name: "a" });
    await tick();
    await tick();
    input.emit("keypress", "", { name: "q" });
    await tui;
    expect(rawModes).toEqual([true, false]);
    expect(outputText.join("")).toContain("HOME");
    expect(outputText.join("")).not.toContain("不要发送草稿");
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
