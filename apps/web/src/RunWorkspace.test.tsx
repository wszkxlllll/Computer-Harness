// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunWorkspace } from "./RunWorkspace";
import { PreferencesProvider } from "./PreferencesContext";
import { useRunFeed } from "./hooks/useRunFeed";
import { useRunCommands } from "./hooks/useRunCommands";
import type { ApprovalEvidence, RunSnapshot } from "./types";
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
