// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunSpeechActions, RunWorkspace } from "./RunWorkspace";
import { PreferencesProvider } from "./PreferencesContext";
import { useRunFeed } from "./hooks/useRunFeed";
import { useRunCommands } from "./hooks/useRunCommands";
import type { ApprovalEvidence, RunNotice, RunSnapshot } from "./types";
import { DEFAULT_PREFERENCES, PREFERENCES_STORAGE_KEY } from "./preferences";
import type { VoiceCapabilities } from "./voice-capabilities";
import type { VoiceOutputSession } from "@computer-harness/voice";

vi.mock("./hooks/useRunFeed", () => ({ useRunFeed: vi.fn() }));
vi.mock("./hooks/useRunCommands", () => ({ useRunCommands: vi.fn() }));

const refresh = vi.fn().mockResolvedValue(undefined);
const setNotice = vi.fn();
const parentSurfaceRef = {
  surfaceId: "surface-1", generation: 1, kind: "native_window",
} satisfies ApprovalEvidence["surfaceRef"];
const commands = {
  busyCommand: undefined,
  notice: undefined,
  setNotice,
  actOnApproval: vi.fn(),
  answerRequest: vi.fn(),
  chooseWindow: vi.fn(),
  ignoreNewWindow: vi.fn(),
  correct: vi.fn(),
  control: vi.fn(),
  refreshStatus: vi.fn(),
};

const approval: RunSnapshot = {
  runId: "run-1",
  goal: "Review the current screen",
  status: "waiting_approval",
  outcome: undefined,
  sequence: 1,
  capabilities: { approval: true, pause: true, abort: true },
  pendingRequest: {
    requestId: "approval-A",
    kind: "approval",
    requiresVisualReview: true,
    reason: "Approval A reason",
    preview: {
      actions: [{ operation: "click", kind: "click", points: [{ x: 20, y: 30 }] }],
      evidence: {
        surfaceRef: parentSurfaceRef,
        assetId: "asset-A",
        observationId: "obs-A",
        decisionObservationId: "decision-A",
        capturedAt: "2026-09-27T00:00:00.000Z",
        viewport: { width: 640, height: 480, coordinateSpace: "physical" },
      },
    },
    candidates: undefined,
  },
  latestAssetId: "asset-A",
};

let feedState: ReturnType<typeof useRunFeed>;

beforeEach(() => {
  feedState = { snapshot: approval, events: [], notices: [], connection: "live", refresh };
  vi.mocked(useRunFeed).mockImplementation(() => feedState);
  vi.mocked(useRunCommands).mockReturnValue(commands);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("request-bound screenshot lifecycle", () => {
  it("disables manual progress and result reading during voice input but leaves stop reading available", () => {
    render(<RunSpeechActions voiceInputActive hasResult onReadProgress={vi.fn()} onReadResult={vi.fn()} onStop={vi.fn()} />);

    expect((screen.getByRole("button", { name: "听听进度" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "朗读结果" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "停止朗读" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows current status and latest progress in simple mode with a keyboard skip target", () => {
    localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify({
      ...DEFAULT_PREFERENCES,
      presentation: { ...DEFAULT_PREFERENCES.presentation, layoutMode: "simple" },
    }));
    const latestNotice: RunNotice = {
      noticeId: "progress-latest",
      kind: "progress",
      text: "电脑已打开查询结果页面。",
      delivery: "polite",
      eventSequence: 8,
      feedSequence: 5,
    };
    feedState = {
      ...feedState,
      snapshot: {
        ...approval,
        status: "running",
        sequence: 5,
        reply: "电脑返回的查询结果。",
        capabilities: { correct: true },
        pendingRequest: undefined,
      },
      notices: [
        { ...latestNotice, noticeId: "progress-old", text: "较早的进展。", feedSequence: 4 },
        latestNotice,
      ],
    };

    render(<PreferencesProvider><RunWorkspace runId="run-1" /></PreferencesProvider>);

    expect(screen.getByText("电脑正在处理")).toBeDefined();
    expect(document.querySelector(".run-activity-copy")?.textContent)
      .toContain("上次进展：电脑已打开查询结果页面。");
    expect(screen.queryByText("较早的进展。")).toBeNull();
    const statusDetails = document.querySelector(".run-activity-details") as HTMLDetailsElement;
    expect(statusDetails.open).toBe(false);
    expect(statusDetails.textContent).toContain("刷新只读取最新状态，不会重新开始任务。");
    expect(screen.getByRole("button", { name: "听听进度" })).toBeDefined();
    expect(screen.getByRole("button", { name: "朗读结果" })).toBeDefined();
    expect(screen.getByRole("link", { name: "跳到主要内容" }).getAttribute("href")).toBe("#main-content");
    expect(document.getElementById("main-content")?.tagName).toBe("MAIN");
  });

  it("keeps one live status region silent on mount and deduplicates repeated progress text", async () => {
    localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify({
      ...DEFAULT_PREFERENCES,
      voice: { runNoticesEnabled: false, speechRate: "normal" },
    }));
    const firstProgress: RunNotice = {
      noticeId: "progress-initial",
      kind: "progress",
      text: "电脑正在整理结果。",
      delivery: "polite",
      eventSequence: 4,
      feedSequence: 2,
    };
    feedState = {
      ...feedState,
      snapshot: { ...approval, status: "running", sequence: 2, capabilities: {}, pendingRequest: undefined },
      notices: [firstProgress],
    };
    const view = render(<PreferencesProvider><RunWorkspace runId="run-1" /></PreferencesProvider>);
    const liveRegion = document.querySelector("[data-run-announcement]") as HTMLElement;
    expect(liveRegion.textContent).toBe("");

    feedState = { ...feedState, snapshot: { ...feedState.snapshot!, status: "paused", sequence: 3 } };
    view.rerender(<PreferencesProvider><RunWorkspace runId="run-1" /></PreferencesProvider>);
    await waitFor(() => expect(liveRegion.textContent).toContain("任务状态已更新：任务已暂停。"));

    const nextProgress = { ...firstProgress, noticeId: "progress-next", feedSequence: 3, text: "已整理两项结果。" };
    feedState = { ...feedState, notices: [firstProgress, nextProgress] };
    view.rerender(<PreferencesProvider><RunWorkspace runId="run-1" /></PreferencesProvider>);
    await waitFor(() => expect(liveRegion.textContent).toContain("最近进展：已整理两项结果。"));

    feedState = { ...feedState, notices: [...feedState.notices, { ...nextProgress, noticeId: "progress-duplicate", feedSequence: 4 }] };
    view.rerender(<PreferencesProvider><RunWorkspace runId="run-1" /></PreferencesProvider>);
    expect(liveRegion.textContent).toBe("最近进展：已整理两项结果。");
    expect(document.querySelectorAll("[data-run-announcement]")).toHaveLength(1);
  });

  it("announces a new same-kind pending request, moves focus only when the old decision control disappears", async () => {
    const view = render(<PreferencesProvider><RunWorkspace runId="run-1" /></PreferencesProvider>);
    const reject = screen.getByRole("button", { name: "拒绝" });
    reject.focus();
    expect(document.activeElement).toBe(reject);

    feedState = {
      ...feedState,
      snapshot: {
        ...approval,
        status: "waiting_user",
        sequence: 2,
        capabilities: {},
        pendingRequest: { requestId: "input-B", kind: "user_input", question: "请确认新的送达地址。" },
      },
    };
    view.rerender(<PreferencesProvider><RunWorkspace runId="run-1" /></PreferencesProvider>);

    expect(screen.getByText("请确认新的送达地址。")).toBeDefined();
    expect(screen.queryByText("Approval A reason")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "电脑需要你补充信息" }));
    expect(document.querySelector("[data-run-announcement]")?.textContent).toContain("请确认新的送达地址。");
    expect(document.querySelector(".pending-panel [role='status']")).toBeNull();
  });

  it("shows an event-ahead request without allowing commands against the old snapshot, then enables it when caught up", () => {
    const nextRequest = { requestId: "input-new", kind: "user_input", question: "应该使用哪个日期？" } as const;
    feedState = {
      ...feedState,
      snapshot: { ...approval, status: "running", sequence: 1, capabilities: { correct: true }, pendingRequest: undefined },
      pendingRequestState: { sequence: 1 },
    };
    const view = render(<PreferencesProvider><RunWorkspace runId="run-1" /></PreferencesProvider>);

    expect(screen.queryByRole("textbox", { name: "你的补充" })).toBeNull();
    expect(document.querySelector("[data-run-announcement]")?.textContent).toBe("");
    feedState = { ...feedState, pendingRequestState: { sequence: 2, request: nextRequest } };
    view.rerender(<PreferencesProvider><RunWorkspace runId="run-1" /></PreferencesProvider>);

    const input = screen.getByRole("textbox", { name: "你的补充" }) as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    expect(screen.getByText(/同步完成前不能处理/u)).toBeDefined();
    expect(screen.getByRole("button", { name: "刷新任务状态" })).toBeDefined();
    expect(document.querySelector("[data-run-announcement]")?.textContent).toContain("应该使用哪个日期？");

    feedState = {
      ...feedState,
      snapshot: { ...feedState.snapshot!, status: "waiting_user", sequence: 2, pendingRequest: nextRequest },
      pendingRequestState: { sequence: 2, request: nextRequest },
    };
    view.rerender(<PreferencesProvider><RunWorkspace runId="run-1" /></PreferencesProvider>);
    expect((screen.getByRole("textbox", { name: "你的补充" }) as HTMLTextAreaElement).disabled).toBe(false);
    expect(screen.queryByText(/同步完成前不能处理/u)).toBeNull();

    const currentInput = screen.getByRole("textbox", { name: "你的补充" });
    currentInput.focus();
    feedState = { ...feedState, pendingRequestState: { sequence: 3 } };
    view.rerender(<PreferencesProvider><RunWorkspace runId="run-1" /></PreferencesProvider>);
    expect(screen.queryByRole("textbox", { name: "你的补充" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Review the current screen" }));
    expect(document.querySelector("[data-run-announcement]")?.textContent).toContain("正在同步最新任务状态");
  });

  it("announces terminal unknown results and connection errors without claiming success", async () => {
    feedState = {
      ...feedState,
      snapshot: { ...approval, status: "running", sequence: 2, capabilities: {}, pendingRequest: undefined },
    };
    const view = render(<PreferencesProvider><RunWorkspace runId="run-1" /></PreferencesProvider>);
    feedState = {
      ...feedState,
      snapshot: {
        ...feedState.snapshot!,
        status: "finished",
        sequence: 3,
        outcome: "outcome_unknown",
        reply: undefined,
        error: "电脑没有确认最后一步是否完成。",
      },
    };
    view.rerender(<PreferencesProvider><RunWorkspace runId="run-1" /></PreferencesProvider>);
    const liveRegion = document.querySelector("[data-run-announcement]") as HTMLElement;
    await waitFor(() => expect(liveRegion.textContent).toContain("结果状态：结果待确认。"));
    expect(liveRegion.textContent).toContain("原因：电脑没有确认最后一步是否完成。");
    expect(liveRegion.textContent).not.toContain("结果状态：已完成");

    feedState = { ...feedState, error: "暂时无法刷新任务状态。", connection: "offline" };
    view.rerender(<PreferencesProvider><RunWorkspace runId="run-1" /></PreferencesProvider>);
    await waitFor(() => expect(liveRegion.textContent).toContain("读取说明：暂时无法刷新任务状态。"));
  });

  it("shows the latest real Runtime progress event when optional spoken progress text is absent", () => {
    feedState = {
      ...feedState,
      snapshot: {
        ...approval,
        status: "running",
        capabilities: {},
        pendingRequest: undefined,
      },
      events: [{
        runId: "run-1",
        sequence: 6,
        type: "run.progress",
        data: { phase: "action", status: "completed" },
      }],
      notices: [],
    };

    render(<PreferencesProvider><RunWorkspace runId="run-1" /></PreferencesProvider>);

    expect(document.querySelector(".run-activity-copy")?.textContent).toContain("电脑完成了一步操作");
    expect(screen.queryByText("上次进展：暂无文字记录。")).toBeNull();
  });

  it.each([
    ["paused", "任务已暂停"],
    ["waiting_approval", "等你确认操作"],
    ["finished", "任务已结束"],
  ] as const)("keeps %s authoritative when the last progress event is older", (status, statusText) => {
    feedState = {
      ...feedState,
      snapshot: {
        ...approval,
        status,
        sequence: 12,
        capabilities: status === "waiting_approval" ? { approval: true } : {},
        pendingRequest: status === "waiting_approval" ? approval.pendingRequest : undefined,
      },
      events: [{
        runId: "run-1",
        sequence: 11,
        type: "run.progress",
        data: { phase: "model", status: "started" },
      }],
      notices: [],
    };

    render(<PreferencesProvider><RunWorkspace runId="run-1" /></PreferencesProvider>);

    expect(document.querySelector(".run-activity-current-status")?.textContent).toContain(statusText);
    expect(document.querySelector(".run-activity-copy")?.textContent)
      .toBe("上次进展：模型正在分析当前画面");
  });

  it("offers a direct status retry when the initial snapshot fails and does not imply the task stopped", async () => {
    feedState = { ...feedState, snapshot: undefined, error: "电脑暂时无法连接。", connection: "offline" };
    vi.mocked(commands.refreshStatus).mockResolvedValueOnce(undefined);
    render(<PreferencesProvider><RunWorkspace runId="run-1" /></PreferencesProvider>);

    expect(screen.getByText(/任务目前情况未知；连接中断不代表任务已经停止/)).toBeDefined();
    const reason = document.querySelector(".run-error-details") as HTMLDetailsElement;
    expect(reason.open).toBe(false);
    expect(reason.textContent).toContain("电脑暂时无法连接。");
    fireEvent.click(screen.getByRole("button", { name: "重试读取任务状态" }));
    await waitFor(() => expect(commands.refreshStatus).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "重试读取任务状态" })).toBeDefined();
  });

  it("speaks current progress and result on request with auto notices off, and keeps global stop available", async () => {
    localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify({
      ...DEFAULT_PREFERENCES,
      voice: { runNoticesEnabled: false, speechRate: "fast" },
    }));
    const spoken: string[] = [];
    const cancel = vi.fn(async () => undefined);
    const outputSession: VoiceOutputSession = {
      enqueueText: async ({ text }) => { spoken.push(text); },
      finish: async () => undefined,
      cancel,
    };
    const openSession = vi.fn(async () => outputSession);
    const voiceCapabilities: VoiceCapabilities = { createOutputAdapter: () => ({ openSession }) };
    feedState = {
      ...feedState,
      snapshot: {
        ...approval,
        status: "running",
        sequence: 3,
        reply: "已找到两个选项。",
        capabilities: { correct: true },
        pendingRequest: undefined,
      },
      notices: [{
        noticeId: "manual-progress",
        kind: "progress",
        text: "电脑已打开查询结果页面。",
        delivery: "polite",
        eventSequence: 3,
        feedSequence: 3,
      }],
    };
    const view = render(<PreferencesProvider><RunWorkspace runId="run-1" voiceCapabilities={voiceCapabilities} /></PreferencesProvider>);

    fireEvent.click(screen.getByRole("button", { name: "听听进度" }));
    await waitFor(() => expect(spoken).toHaveLength(1));
    expect(spoken[0]).toContain("当前任务状态：电脑正在处理。");
    expect(spoken[0]).toContain("最近一次进展：电脑已打开查询结果页面。");
    expect(spoken[0]).toContain("可能早于当前状态");
    expect(spoken[0]).toContain("电脑已打开查询结果页面。");
    expect(openSession).toHaveBeenCalledWith({ speechRate: 1.15 });

    fireEvent.click(screen.getByRole("button", { name: "朗读结果" }));
    await waitFor(() => expect(spoken).toHaveLength(2));
    expect(spoken[1]).toContain("已找到两个选项。");
    expect(cancel).not.toHaveBeenCalled();

    feedState = { ...feedState, notices: [...feedState.notices, {
      noticeId: "new-progress-while-manual-speech-enabled",
      kind: "progress",
      text: "电脑正在整理结果。",
      delivery: "polite",
      eventSequence: 4,
      feedSequence: 4,
    }] };
    view.rerender(<PreferencesProvider><RunWorkspace runId="run-1" voiceCapabilities={voiceCapabilities} /></PreferencesProvider>);
    expect(cancel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "停止朗读" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("user"));
  });

  it("shows visible speech fallback text when an output adapter is unavailable", async () => {
    const voiceCapabilities: VoiceCapabilities = {
      createOutputAdapter: () => ({
        openSession: async () => { throw new Error("speech unavailable"); },
      }),
    };
    feedState = {
      ...feedState,
      snapshot: {
        ...approval,
        status: "running",
        capabilities: {},
        pendingRequest: undefined,
      },
      notices: [],
    };
    render(<PreferencesProvider><RunWorkspace runId="run-1" voiceCapabilities={voiceCapabilities} /></PreferencesProvider>);

    fireEvent.click(screen.getByRole("button", { name: "听听进度" }));

    expect(await screen.findByText(/语音播报未能播放.*speech unavailable/)).toBeDefined();
    expect(screen.getByText("上次进展：暂无文字记录。")).toBeDefined();
  });

  it("routes pause and the exact correction text through the current Run controls", () => {
    feedState = {
      ...feedState,
      snapshot: {
        ...approval,
        status: "running",
        sequence: 4,
        capabilities: { pause: true, resume: false, abort: true, correct: true },
        pendingRequest: undefined,
      },
    };
    render(<PreferencesProvider><RunWorkspace runId="run-1" /></PreferencesProvider>);

    fireEvent.click(screen.getByRole("button", { name: "暂停任务" }));
    expect(commands.control).toHaveBeenCalledWith("pause");
    const correction = screen.getByRole("textbox", { name: "补充或修正任务要求" }) as HTMLTextAreaElement;
    fireEvent.change(correction, { target: { value: "Use the date shown in the current report" } });
    fireEvent.submit(correction.closest("form")!);
    expect(commands.correct).toHaveBeenCalledWith("Use the date shown in the current report");
  });

  it("exposes separate keyboard-focusable pause, resume, and stop controls", () => {
    feedState = {
      ...feedState,
      snapshot: {
        ...approval,
        status: "running",
        sequence: 4,
        capabilities: { pause: true, resume: true, abort: true },
        pendingRequest: undefined,
      },
    };
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<PreferencesProvider><RunWorkspace runId="run-1" /></PreferencesProvider>);

    const pause = screen.getByRole("button", { name: "暂停任务" }) as HTMLButtonElement;
    const resume = screen.getByRole("button", { name: "继续任务" }) as HTMLButtonElement;
    const stop = screen.getByRole("button", { name: "停止任务" }) as HTMLButtonElement;
    expect([pause.tagName, resume.tagName, stop.tagName]).toEqual(["BUTTON", "BUTTON", "BUTTON"]);
    expect([pause.tabIndex, resume.tabIndex, stop.tabIndex]).toEqual([0, 0, 0]);

    fireEvent.click(pause);
    fireEvent.click(resume);
    fireEvent.click(stop);
    expect(commands.control.mock.calls).toEqual([["pause"], ["resume"], ["abort"]]);
    confirm.mockRestore();
  });

  it("restores focus to the task heading when a focused control is removed by a Run update", async () => {
    feedState = {
      ...feedState,
      snapshot: {
        ...approval,
        status: "running",
        sequence: 4,
        capabilities: { pause: true, abort: true, correct: true },
        pendingRequest: undefined,
      },
    };
    const view = render(<PreferencesProvider><RunWorkspace runId="run-1" /></PreferencesProvider>);
    const pause = screen.getByRole("button", { name: "暂停任务" });
    pause.focus();
    feedState = {
      ...feedState,
      snapshot: { ...feedState.snapshot!, status: "paused", sequence: 5, capabilities: { resume: true, abort: true, correct: true } },
    };
    view.rerender(<PreferencesProvider><RunWorkspace runId="run-1" /></PreferencesProvider>);
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Review the current screen" }));
    expect(screen.getByRole("button", { name: "继续任务" })).toBeDefined();

    const stop = screen.getByRole("button", { name: "停止任务" });
    stop.focus();
    feedState = {
      ...feedState,
      snapshot: { ...feedState.snapshot!, status: "finished", sequence: 6, outcome: "cancelled", capabilities: {} },
    };
    view.rerender(<PreferencesProvider><RunWorkspace runId="run-1" /></PreferencesProvider>);
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Review the current screen" }));
    expect(screen.queryByRole("button", { name: "停止任务" })).toBeNull();
  });

  it("restores focus when retry or correction controls disappear after their task update", async () => {
    feedState = { ...feedState, snapshot: undefined, error: "电脑暂时无法连接。", connection: "offline" };
    const freshSnapshot = { ...approval, status: "running" as const, sequence: 3, capabilities: { correct: true }, pendingRequest: undefined };
    vi.mocked(commands.refreshStatus).mockResolvedValueOnce(freshSnapshot);
    const view = render(<PreferencesProvider><RunWorkspace runId="run-1" /></PreferencesProvider>);
    const retry = screen.getByRole("button", { name: "重试读取任务状态" });
    retry.focus();
    fireEvent.click(retry);
    await waitFor(() => expect(commands.refreshStatus).toHaveBeenCalledTimes(1));

    feedState = { ...feedState, snapshot: freshSnapshot, error: undefined, connection: "live" };
    view.rerender(<PreferencesProvider><RunWorkspace runId="run-1" /></PreferencesProvider>);
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Review the current screen" }));

    const correction = screen.getByRole("textbox", { name: "补充或修正任务要求" });
    correction.focus();
    feedState = {
      ...feedState,
      snapshot: { ...freshSnapshot, status: "finished", sequence: 4, outcome: "outcome_unknown", capabilities: {} },
    };
    view.rerender(<PreferencesProvider><RunWorkspace runId="run-1" /></PreferencesProvider>);
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Review the current screen" }));
  });

  it("distinguishes terminal cleanup pending and clears the warning after confirmed release", () => {
    feedState = {
      ...feedState,
      snapshot: {
        ...approval,
        status: "finished",
        ownerState: "pending_cleanup",
        sequence: 9,
        capabilities: { pause: false, resume: false, abort: false, correct: false },
        pendingRequest: undefined,
      },
    };
    const view = render(<PreferencesProvider><RunWorkspace runId="run-1" /></PreferencesProvider>);

    expect(screen.getByText(/任务已结束，但电脑尚未确认资源清理/)).toBeDefined();
    expect(screen.queryByRole("button", { name: "停止任务" })).toBeNull();

    feedState = {
      ...feedState,
      snapshot: { ...feedState.snapshot!, ownerState: "released" },
    };
    view.rerender(<PreferencesProvider><RunWorkspace runId="run-1" /></PreferencesProvider>);
    expect(screen.queryByText(/任务已结束，但电脑尚未确认资源清理/)).toBeNull();
  });

  it("does not duplicate a live notice when React StrictMode replays effects", async () => {
    localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify({
      ...DEFAULT_PREFERENCES,
      voice: { runNoticesEnabled: true, speechRate: "normal" },
    }));
    const spoken: string[] = [];
    const openSession = vi.fn(async () => ({
      enqueueText: async (chunk: { text: string }) => { spoken.push(chunk.text); },
      finish: async () => undefined,
      cancel: async () => undefined,
    }));
    const voiceCapabilities: VoiceCapabilities = {
      createOutputAdapter: () => ({ openSession }),
    };
    const renderElement = () => <StrictMode><PreferencesProvider><RunWorkspace runId="run-1" voiceCapabilities={voiceCapabilities} /></PreferencesProvider></StrictMode>;
    const view = render(renderElement());
    feedState = {
      ...feedState,
      snapshot: { ...approval, sequence: 3 },
      notices: [{
        noticeId: "notice-strict-mode",
        kind: "error",
        text: "任务出现问题，请查看详情。",
        delivery: "interrupt",
        eventSequence: 7,
        feedSequence: 4,
      }],
    };
    view.rerender(renderElement());
    await waitFor(() => expect(spoken).toEqual(["任务出现问题，请查看详情。"]));
    expect(openSession).toHaveBeenCalledTimes(1);
  });

  it("speaks a validated milestone summary through the same notice consumer", async () => {
    localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify({
      ...DEFAULT_PREFERENCES,
      voice: { runNoticesEnabled: true, speechRate: "normal" },
    }));
    const spoken: string[] = [];
    const voiceCapabilities: VoiceCapabilities = {
      createOutputAdapter: () => ({
        openSession: async () => ({
          enqueueText: async ({ text }: { text: string }) => { spoken.push(text); },
          finish: async () => undefined,
          cancel: async () => undefined,
        }),
      }),
    };
    const runningSnapshot: RunSnapshot = {
      ...approval,
      status: "running",
      sequence: 1,
      capabilities: { correct: true, pause: true, abort: true },
      pendingRequest: undefined,
    };
    feedState = { ...feedState, snapshot: runningSnapshot, pendingRequestState: { sequence: 1 }, notices: [] };
    const view = render(<PreferencesProvider><RunWorkspace runId="run-1" voiceCapabilities={voiceCapabilities} /></PreferencesProvider>);
    const milestoneNotice = {
      noticeId: "milestone-summary",
      kind: "progress" as const,
      text: "搜索结果页面已打开。",
      delivery: "polite" as const,
      eventSequence: 8,
      feedSequence: 2,
    };
    feedState = { ...feedState, notices: [milestoneNotice] };
    view.rerender(<PreferencesProvider><RunWorkspace runId="run-1" voiceCapabilities={voiceCapabilities} /></PreferencesProvider>);

    await waitFor(() => expect(spoken).toEqual([milestoneNotice.text]));
  });

  it("speaks an approval from the pending SSE state before the GET snapshot catches up", async () => {
    localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify({
      ...DEFAULT_PREFERENCES,
      voice: { runNoticesEnabled: true, speechRate: "normal" },
    }));
    const spoken: string[] = [];
    const voiceCapabilities: VoiceCapabilities = {
      createOutputAdapter: () => ({
        openSession: async () => ({
          enqueueText: async ({ text }: { text: string }) => { spoken.push(text); },
          finish: async () => undefined,
          cancel: async () => undefined,
        }),
      }),
    };
    const runningSnapshot: RunSnapshot = {
      ...approval,
      status: "running",
      sequence: 1,
      capabilities: { correct: true, pause: true, abort: true, approval: true },
      pendingRequest: undefined,
    };
    feedState = { ...feedState, snapshot: runningSnapshot, pendingRequestState: { sequence: 1 } };
    const view = render(<PreferencesProvider><RunWorkspace runId="run-1" voiceCapabilities={voiceCapabilities} /></PreferencesProvider>);

    feedState = {
      ...feedState,
      pendingRequestState: { sequence: 2, request: approval.pendingRequest! },
      notices: [{
        noticeId: "approval-before-snapshot",
        kind: "approval",
        text: "可能涉及对外发送或提交内容的点击操作，请核对后审批。",
        delivery: "interrupt",
        eventSequence: 7,
        feedSequence: 3,
        pendingRequestId: "approval-A",
      }],
    };
    view.rerender(<PreferencesProvider><RunWorkspace runId="run-1" voiceCapabilities={voiceCapabilities} /></PreferencesProvider>);

    await waitFor(() => expect(spoken).toEqual(["可能涉及对外发送或提交内容的点击操作，请核对后审批。"]));
    expect(screen.getByRole("heading", { name: "电脑请求你确认一项操作" })).toBeDefined();
    expect(screen.getByText(/正在同步当前状态；同步完成前不能处理/u)).toBeDefined();
    expect((screen.getByRole("button", { name: "拒绝" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("drops an approval that resolves while speech output is opening, even before a fresh snapshot", async () => {
    localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify({
      ...DEFAULT_PREFERENCES,
      voice: { runNoticesEnabled: true, speechRate: "normal" },
    }));
    let resolveSession!: (session: VoiceOutputSession) => void;
    const openSession = vi.fn(() => new Promise<VoiceOutputSession>((resolve) => { resolveSession = resolve; }));
    const enqueueText = vi.fn(async () => undefined);
    const cancelSession = vi.fn(async () => undefined);
    const voiceCapabilities: VoiceCapabilities = { createOutputAdapter: () => ({ openSession }) };
    const runningSnapshot: RunSnapshot = {
      ...approval,
      status: "running",
      sequence: 1,
      capabilities: { correct: true, pause: true, abort: true },
      pendingRequest: undefined,
    };
    feedState = { ...feedState, snapshot: runningSnapshot, pendingRequestState: { sequence: 1 } };
    const view = render(<PreferencesProvider><RunWorkspace runId="run-1" voiceCapabilities={voiceCapabilities} /></PreferencesProvider>);

    feedState = {
      ...feedState,
      pendingRequestState: { sequence: 2, request: approval.pendingRequest! },
      notices: [{
        noticeId: "approval-resolved-during-open",
        kind: "approval",
        text: "可能涉及对外发送或提交内容的点击操作，请核对后审批。",
        delivery: "interrupt",
        eventSequence: 7,
        feedSequence: 3,
        pendingRequestId: "approval-A",
      }],
    };
    view.rerender(<PreferencesProvider><RunWorkspace runId="run-1" voiceCapabilities={voiceCapabilities} /></PreferencesProvider>);
    await waitFor(() => expect(openSession).toHaveBeenCalledTimes(1));

    feedState = { ...feedState, pendingRequestState: { sequence: 4 } };
    view.rerender(<PreferencesProvider><RunWorkspace runId="run-1" voiceCapabilities={voiceCapabilities} /></PreferencesProvider>);
    resolveSession({ enqueueText, finish: vi.fn(), cancel: cancelSession });

    await waitFor(() => expect(cancelSession).toHaveBeenCalledWith("interrupted"));
    expect(enqueueText).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "电脑请求你确认一项操作" })).toBeNull();
  });

  it("does not speak an approval again when the same SSE notice is replayed", async () => {
    localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify({
      ...DEFAULT_PREFERENCES,
      voice: { runNoticesEnabled: true, speechRate: "normal" },
    }));
    const spoken: string[] = [];
    const voiceCapabilities: VoiceCapabilities = {
      createOutputAdapter: () => ({
        openSession: async () => ({
          enqueueText: async ({ text }: { text: string }) => { spoken.push(text); },
          finish: async () => undefined,
          cancel: async () => undefined,
        }),
      }),
    };
    const runningSnapshot: RunSnapshot = {
      ...approval,
      status: "running",
      sequence: 1,
      capabilities: { correct: true, pause: true, abort: true },
      pendingRequest: undefined,
    };
    feedState = {
      ...feedState,
      snapshot: runningSnapshot,
      pendingRequestState: { sequence: 2, request: approval.pendingRequest! },
      notices: [],
    };
    const view = render(<PreferencesProvider><RunWorkspace runId="run-1" voiceCapabilities={voiceCapabilities} /></PreferencesProvider>);

    const replayedNotice = {
      noticeId: "approval-replay-once",
      kind: "approval" as const,
      text: "可能涉及对外发送或提交内容的点击操作，请核对后审批。",
      delivery: "interrupt" as const,
      eventSequence: 7,
      feedSequence: 3,
      pendingRequestId: "approval-A",
    };
    feedState = { ...feedState, notices: [replayedNotice] };
    view.rerender(<PreferencesProvider><RunWorkspace runId="run-1" voiceCapabilities={voiceCapabilities} /></PreferencesProvider>);
    await waitFor(() => expect(spoken).toEqual([replayedNotice.text]));

    feedState = { ...feedState, notices: [{ ...replayedNotice, feedSequence: 5 }] };
    view.rerender(<PreferencesProvider><RunWorkspace runId="run-1" voiceCapabilities={voiceCapabilities} /></PreferencesProvider>);
    expect(spoken).toEqual([replayedNotice.text]);
  });

  it("closes the old approval viewer and never resurrects that request after a newer request resolves", () => {
    const view = render(<PreferencesProvider><RunWorkspace runId="run-1" /></PreferencesProvider>);
    fireEvent.click(screen.getByRole("button", { name: /放大查看/ }));
    expect(screen.getByRole("dialog", { name: "本次请求绑定的电脑画面" })).toBeDefined();

    feedState = {
      ...feedState,
      snapshot: {
        ...approval,
        status: "waiting_user",
        sequence: 2,
        capabilities: { pause: true, abort: true },
        pendingRequest: { requestId: "input-B", kind: "user_input", question: "Which option should the computer use?" },
      },
    };
    view.rerender(<PreferencesProvider><RunWorkspace runId="run-1" /></PreferencesProvider>);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByLabelText("你的补充")).toBeDefined();
    expect((screen.getByLabelText("你的补充") as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.queryByText("Approval A reason")).toBeNull();

    feedState = {
      ...feedState,
      snapshot: {
        ...approval,
        status: "running",
        sequence: 3,
        capabilities: { correct: true, pause: true, abort: true },
        pendingRequest: undefined,
      },
    };
    view.rerender(<PreferencesProvider><RunWorkspace runId="run-1" /></PreferencesProvider>);
    expect(screen.queryByRole("heading", { name: "电脑请求你确认一项操作" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "电脑需要你补充信息" })).toBeNull();
  });

  it("keeps the pinned frame while approval B replaces A, then restores focus when B disappears", () => {
    const view = render(<PreferencesProvider><RunWorkspace runId="run-1" /></PreferencesProvider>);
    fireEvent.click(screen.getByRole("button", { name: /放大查看/ }));
    const dialog = screen.getByRole("dialog", { name: "本次请求绑定的电脑画面" });

    feedState = {
      ...feedState,
      snapshot: {
        ...approval,
        sequence: 2,
        pendingRequest: {
          requestId: "approval-B",
          kind: "approval",
          requiresVisualReview: true,
          preview: {
            actions: [{ operation: "click", kind: "click", points: [{ x: 40, y: 50 }] }],
            evidence: {
              surfaceRef: parentSurfaceRef,
              assetId: "asset-B",
              observationId: "obs-B",
              decisionObservationId: "decision-B",
              capturedAt: "2026-09-27T00:01:00.000Z",
              viewport: { width: 640, height: 480, coordinateSpace: "physical" },
            },
          },
        },
      },
    };
    view.rerender(<PreferencesProvider><RunWorkspace runId="run-1" /></PreferencesProvider>);
    expect(dialog.querySelector("img")?.getAttribute("src")).toContain("asset-A");
    expect(screen.getByText(/确认请求已变化/)).toBeDefined();

    feedState = {
      ...feedState,
      snapshot: {
        ...approval,
        status: "running",
        sequence: 3,
        capabilities: { correct: true, pause: true, abort: true },
        pendingRequest: undefined,
      },
    };
    view.rerender(<PreferencesProvider><RunWorkspace runId="run-1" /></PreferencesProvider>);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Review the current screen" }));
  });
});
