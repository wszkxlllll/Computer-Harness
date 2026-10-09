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

    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    expect(commands.control).toHaveBeenCalledWith("pause");
    const correction = screen.getByLabelText("补充或修正任务要求") as HTMLTextAreaElement;
    fireEvent.change(correction, { target: { value: "Use the date shown in the current report" } });
    fireEvent.submit(correction.closest("form")!);
    expect(commands.correct).toHaveBeenCalledWith("Use the date shown in the current report");
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
      capabilities: { correct: true, pause: true, abort: true },
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
    expect(screen.queryByRole("heading", { name: "电脑请求你确认一项操作" })).toBeNull();
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
