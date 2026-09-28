// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceAudioCaptureAdapter, VoiceAudioCaptureSession, VoiceCaptureEvent, VoiceInputEvent } from "@computer-harness/voice";
import { GoalComposer } from "./components/GoalComposer";
import { CorrectionForm } from "./components/CorrectionForm";
import { PendingRequestPanel } from "./components/PendingRequestPanel";
import { VoiceInputControl } from "./components/VoiceInputControl";
import { VoiceInputCapabilitiesContext } from "./voice-capabilities";

vi.mock("./api", () => ({
  appendVoiceAudio: vi.fn(),
  cancelVoiceInput: vi.fn(),
  finishVoiceInput: vi.fn(),
  startVoiceInput: vi.fn(),
}));

import { appendVoiceAudio, cancelVoiceInput, finishVoiceInput, startVoiceInput } from "./api";

class FakeCapture implements VoiceAudioCaptureSession {
  private readonly queue = new CaptureQueue();
  public readonly events = this.queue;
  public stopped = false;
  public cancelled = false;
  private nextSequence = 0;

  public emitChunk(): void {
    this.queue.push({
      type: "audio_chunk",
      chunk: { sequence: this.nextSequence++, data: new Uint8Array(3_200) },
    });
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    this.emitChunk();
    this.queue.push({ type: "capture_stopped" });
    this.queue.close();
  }

  public async cancel(): Promise<void> {
    this.cancelled = true;
    this.queue.close();
  }
}

class CaptureQueue implements AsyncIterable<VoiceCaptureEvent> {
  private readonly values: VoiceCaptureEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<VoiceCaptureEvent>) => void> = [];
  private ended = false;

  public push(event: VoiceCaptureEvent): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.values.push(event);
  }

  public close(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  public [Symbol.asyncIterator](): AsyncIterator<VoiceCaptureEvent> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<VoiceCaptureEvent>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

const capabilities = {
  available: true,
  provider: "qwen3-asr-flash-realtime",
  sampleRate: 16_000,
  channels: 1,
  chunkBytes: 3_200,
  maxDurationMs: 60_000,
} as const;

const voiceContext = ({ children }: { children: React.ReactNode }) => (
  <VoiceInputCapabilitiesContext.Provider value={capabilities}>{children}</VoiceInputCapabilitiesContext.Provider>
);

function stateEvent(sequence: number, state: "starting" | "recording" | "finished" | "cancelled", sessionId = "voice-session-1"): { sequence: number; event: VoiceInputEvent } {
  return { sequence, event: { type: "state_changed", sessionId, state } };
}

function transcriptEvent(sequence: number, text: string, state: "partial" | "final", sessionId = "voice-session-1"): { sequence: number; event: VoiceInputEvent } {
  return {
    sequence,
    event: {
      type: "transcript_updated",
      sessionId,
      segment: { segmentId: "item-1:0", index: 0, revision: sequence, text, state },
    },
  };
}

beforeEach(() => {
  vi.mocked(startVoiceInput).mockResolvedValue({
    sessionId: "voice-session-1",
    events: [stateEvent(1, "starting"), stateEvent(2, "recording")],
    eventCursor: 2,
  });
  vi.mocked(appendVoiceAudio).mockImplementation(async (_sessionId, chunks) => ({
    sessionId: "voice-session-1",
    events: chunks.some((chunk) => chunk.sequence === 0) ? [transcriptEvent(3, "上海到杭州", "partial")] : [],
    eventCursor: 3,
    acceptedSequence: chunks.at(-1)?.sequence,
  }));
  vi.mocked(finishVoiceInput).mockResolvedValue({
    sessionId: "voice-session-1",
    events: [
      { sequence: 4, event: { type: "state_changed", sessionId: "voice-session-1", state: "finalizing" } },
      transcriptEvent(5, "请查询上海到杭州的车票。", "final"),
      stateEvent(6, "finished"),
    ],
    eventCursor: 6,
  });
  vi.mocked(cancelVoiceInput).mockResolvedValue({ sessionId: "voice-session-1", events: [stateEvent(3, "cancelled")], eventCursor: 3 });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("voice input control", () => {
  it("requests no microphone until the user starts, then streams partials and fills only the final editable text", async () => {
    const capture = new FakeCapture();
    const createCaptureAdapter = vi.fn((): VoiceAudioCaptureAdapter => ({ start: async () => capture }));
    const onTranscript = vi.fn();
    render(
      <VoiceInputCapabilitiesContext.Provider value={capabilities}>
        <VoiceInputControl onTranscript={onTranscript} createCaptureAdapter={createCaptureAdapter} />
      </VoiceInputCapabilitiesContext.Provider>,
    );

    expect(createCaptureAdapter).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "按下说话" }));
    await screen.findByRole("button", { name: "停止录音" });
    expect(createCaptureAdapter).toHaveBeenCalledWith(3_200);
    expect(onTranscript).not.toHaveBeenCalled();

    await act(async () => { capture.emitChunk(); });
    await screen.findByText("上海到杭州");
    fireEvent.click(screen.getByRole("button", { name: "停止录音" }));

    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith("请查询上海到杭州的车票。"));
    expect(capture.stopped).toBe(true);
    const sentChunks = vi.mocked(appendVoiceAudio).mock.calls.flatMap((call) => call[1].map((chunk) => chunk.sequence));
    expect(sentChunks).toEqual([0, 1]);
    expect(vi.mocked(appendVoiceAudio).mock.calls[0]?.[1]).toHaveLength(1);
    expect(finishVoiceInput).toHaveBeenCalledWith("voice-session-1", 3);
    expect(screen.getByText("识别结果已填入输入框，请检查并编辑后再发送。")).toBeDefined();
  });

  it("cancels capture and the Host session without committing partial recognition", async () => {
    const capture = new FakeCapture();
    const onTranscript = vi.fn();
    render(
      <VoiceInputCapabilitiesContext.Provider value={capabilities}>
        <VoiceInputControl onTranscript={onTranscript} createCaptureAdapter={() => ({ start: async () => capture })} />
      </VoiceInputCapabilitiesContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "按下说话" }));
    await screen.findByRole("button", { name: "停止录音" });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(cancelVoiceInput).toHaveBeenCalledWith("voice-session-1", 2));
    expect(capture.cancelled).toBe(true);
    expect(finishVoiceInput).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
    expect(screen.queryByText(/实时转写/u)).toBeNull();
  });

  it("ignores a late final response from a cancelled recording after a new recording starts", async () => {
    const firstCapture = new FakeCapture();
    const secondCapture = new FakeCapture();
    let releaseOldFinish: (update: Awaited<ReturnType<typeof finishVoiceInput>>) => void = () => undefined;
    vi.mocked(startVoiceInput)
      .mockResolvedValueOnce({ sessionId: "voice-old", events: [stateEvent(1, "starting", "voice-old"), stateEvent(2, "recording", "voice-old")], eventCursor: 2 })
      .mockResolvedValueOnce({ sessionId: "voice-new", events: [stateEvent(1, "starting", "voice-new"), stateEvent(2, "recording", "voice-new")], eventCursor: 2 });
    vi.mocked(appendVoiceAudio).mockImplementation(async (sessionId, chunks) => ({
      sessionId,
      events: chunks.some((chunk) => chunk.sequence === 0) ? [transcriptEvent(3, sessionId === "voice-old" ? "旧识别" : "新识别", "partial", sessionId)] : [],
      eventCursor: 3,
    }));
    vi.mocked(finishVoiceInput).mockImplementationOnce(() => new Promise((resolve) => { releaseOldFinish = resolve; }));
    vi.mocked(cancelVoiceInput).mockImplementation(async (sessionId) => ({ sessionId, events: [stateEvent(3, "cancelled", sessionId)], eventCursor: 3 }));
    const onTranscript = vi.fn();
    const createCaptureAdapter = vi.fn()
      .mockImplementationOnce((): VoiceAudioCaptureAdapter => ({ start: async () => firstCapture }))
      .mockImplementationOnce((): VoiceAudioCaptureAdapter => ({ start: async () => secondCapture }));
    render(
      <VoiceInputCapabilitiesContext.Provider value={capabilities}>
        <VoiceInputControl onTranscript={onTranscript} createCaptureAdapter={createCaptureAdapter} />
      </VoiceInputCapabilitiesContext.Provider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "按下说话" }));
    await screen.findByRole("button", { name: "停止录音" });
    fireEvent.click(screen.getByRole("button", { name: "停止录音" }));
    await waitFor(() => expect(finishVoiceInput).toHaveBeenCalledWith("voice-old", 3));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(cancelVoiceInput).toHaveBeenCalledWith("voice-old", 3));

    fireEvent.click(screen.getByRole("button", { name: "重新录音" }));
    await screen.findByRole("button", { name: "停止录音" });
    releaseOldFinish({
      sessionId: "voice-old",
      events: [
        { sequence: 3, event: { type: "state_changed", sessionId: "voice-old", state: "finalizing" } },
        transcriptEvent(4, "旧任务结果", "final", "voice-old"),
        stateEvent(5, "finished", "voice-old"),
      ],
      eventCursor: 5,
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(onTranscript).not.toHaveBeenCalled();
    expect(screen.queryByText("旧任务结果")).toBeNull();
    expect(screen.getByText("正在录音。再次按“停止录音”后，识别结果会填入输入框供你编辑。")).toBeDefined();
    await secondCapture.cancel();
  });

  it("keeps voice controls available at Goal, correction, and user-answer inputs", () => {
    const targetPicker = {
      candidates: [],
      loading: false,
      onSelect: vi.fn(),
      onRefresh: vi.fn(),
    };
    const goal = render(
      <VoiceInputCapabilitiesContext.Provider value={capabilities}>
        <GoalComposer
          canStart
          targetMode="auto"
          browserSessionMode="temporary"
          browserUrl=""
          onTargetModeChange={vi.fn()}
          onBrowserSessionModeChange={vi.fn()}
          onBrowserUrlChange={vi.fn()}
          targetPicker={targetPicker}
          onSubmit={vi.fn(async () => undefined)}
        />
      </VoiceInputCapabilitiesContext.Provider>,
    );
    expect(screen.getByRole("button", { name: "按下说话" })).toBeDefined();
    goal.unmount();

    const correction = render(
      <VoiceInputCapabilitiesContext.Provider value={capabilities}>
        <CorrectionForm onSubmit={vi.fn(async () => true)} />
      </VoiceInputCapabilitiesContext.Provider>,
    );
    expect(screen.getByRole("button", { name: "按下说话" })).toBeDefined();
    correction.unmount();

    render(
      <VoiceInputCapabilitiesContext.Provider value={capabilities}>
        <PendingRequestPanel
          request={{ requestId: "input-1", kind: "user_input", question: "Which date?" }}
          onApprove={vi.fn()}
          onRespond={vi.fn(async () => true)}
          onChooseWindow={vi.fn()}
          onIgnoreNewWindow={vi.fn()}
        />
      </VoiceInputCapabilitiesContext.Provider>,
    );
    expect(screen.getByRole("button", { name: "按下说话" })).toBeDefined();
  });

  it("locks each parent form against edits and submission throughout capture/finalization", async () => {
    const targetPicker = { candidates: [], loading: false, onSelect: vi.fn(), onRefresh: vi.fn() };
    const goalCapture = new FakeCapture();
    const goalSubmit = vi.fn(async () => undefined);
    const goal = render(
      <VoiceInputCapabilitiesContext.Provider value={capabilities}>
        <GoalComposer
          canStart
          targetMode="auto"
          browserSessionMode="temporary"
          browserUrl=""
          onTargetModeChange={vi.fn()}
          onBrowserSessionModeChange={vi.fn()}
          onBrowserUrlChange={vi.fn()}
          targetPicker={targetPicker}
          voiceCaptureAdapterFactory={() => ({ start: async () => goalCapture })}
          onSubmit={goalSubmit}
        />
      </VoiceInputCapabilitiesContext.Provider>,
    );
    fireEvent.change(screen.getByLabelText("想让电脑做什么？"), { target: { value: "查询天气" } });
    fireEvent.click(screen.getByRole("button", { name: "按下说话" }));
    await screen.findByRole("button", { name: "停止录音" });
    expect((screen.getByLabelText("想让电脑做什么？") as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "开始任务" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(screen.getByRole("button", { name: "开始任务" }).closest("form")!);
    expect(goalSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect((screen.getByLabelText("想让电脑做什么？") as HTMLTextAreaElement).disabled).toBe(false));
    goal.unmount();

    const correctionCapture = new FakeCapture();
    const correctionSubmit = vi.fn(async () => true);
    const correction = render(
      <VoiceInputCapabilitiesContext.Provider value={capabilities}>
        <CorrectionForm voiceCaptureAdapterFactory={() => ({ start: async () => correctionCapture })} onSubmit={correctionSubmit} />
      </VoiceInputCapabilitiesContext.Provider>,
    );
    fireEvent.change(screen.getByLabelText("补充或修正任务要求"), { target: { value: "不要打开付款页" } });
    fireEvent.click(screen.getByRole("button", { name: "按下说话" }));
    await screen.findByRole("button", { name: "停止录音" });
    expect((screen.getByLabelText("补充或修正任务要求") as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.submit(screen.getByLabelText("补充或修正任务要求").closest("form")!);
    expect(correctionSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    correction.unmount();

    const answerCapture = new FakeCapture();
    const answerSubmit = vi.fn(async () => true);
    render(
      <VoiceInputCapabilitiesContext.Provider value={capabilities}>
        <PendingRequestPanel
          request={{ requestId: "input-busy", kind: "user_input", question: "补充一下？" }}
          voiceCaptureAdapterFactory={() => ({ start: async () => answerCapture })}
          onApprove={vi.fn()}
          onRespond={answerSubmit}
          onChooseWindow={vi.fn()}
          onIgnoreNewWindow={vi.fn()}
        />
      </VoiceInputCapabilitiesContext.Provider>,
    );
    fireEvent.change(screen.getByLabelText("你的补充"), { target: { value: "上海出发" } });
    fireEvent.click(screen.getByRole("button", { name: "按下说话" }));
    await screen.findByRole("button", { name: "停止录音" });
    expect((screen.getByLabelText("你的补充") as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.submit(screen.getByLabelText("你的补充").closest("form")!);
    expect(answerSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
  });

  it("keeps text entry available and the microphone unopened when Host capability is unavailable", () => {
    const createCaptureAdapter = vi.fn();
    render(
      <VoiceInputCapabilitiesContext.Provider value={{ available: false, unavailableReason: "not_configured" }}>
        <VoiceInputControl onTranscript={vi.fn()} createCaptureAdapter={createCaptureAdapter} />
      </VoiceInputCapabilitiesContext.Provider>,
    );
    expect((screen.getByRole("button", { name: "按下说话" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("语音输入尚不可用，仍可直接输入文字。")).toBeDefined();
    expect(createCaptureAdapter).not.toHaveBeenCalled();
  });

  it("cancels the Host session and never requests a final transcript when Worklet stop-flush fails", async () => {
    const capture = new FakeCapture();
    vi.spyOn(capture, "stop").mockRejectedValue(new Error("flush failed"));
    const onTranscript = vi.fn();
    render(
      <VoiceInputCapabilitiesContext.Provider value={capabilities}>
        <VoiceInputControl onTranscript={onTranscript} createCaptureAdapter={() => ({ start: async () => capture })} />
      </VoiceInputCapabilitiesContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "按下说话" }));
    await screen.findByRole("button", { name: "停止录音" });
    fireEvent.click(screen.getByRole("button", { name: "停止录音" }));
    await waitFor(() => expect(cancelVoiceInput).toHaveBeenCalledWith("voice-session-1", 2));
    expect(finishVoiceInput).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("automatically finalizes at the Host-advertised maximum duration", async () => {
    const capture = new FakeCapture();
    const onTranscript = vi.fn();
    render(
      <VoiceInputCapabilitiesContext.Provider value={{ ...capabilities, maxDurationMs: 20 }}>
        <VoiceInputControl onTranscript={onTranscript} createCaptureAdapter={() => ({ start: async () => capture })} />
      </VoiceInputCapabilitiesContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "按下说话" }));
    await waitFor(() => expect(finishVoiceInput).toHaveBeenCalledWith("voice-session-1", expect.any(Number)));
    expect(capture.stopped).toBe(true);
    expect(cancelVoiceInput).not.toHaveBeenCalled();
    expect(onTranscript).toHaveBeenCalledWith("请查询上海到杭州的车票。");
    expect(screen.getByText("已到 60 秒上限，完整识别结果已填入输入框，请检查后再发送。")).toBeDefined();
  });
});
