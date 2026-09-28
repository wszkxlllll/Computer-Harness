import { describe, expect, it, vi } from "vitest";
import type { VoiceOutputAdapter, VoiceOutputSession } from "@computer-harness/voice";
import type { PendingRequestBase, RunNotice } from "./types";
import { BrowserSpeechOutput, RunNoticeCursor, RunNoticeSpeechController, type BrowserSpeechEnvironment } from "./run-notice-speech";

class FakeUtterance {
  rate = 1;
  onend: ((event: SpeechSynthesisEvent) => void) | null = null;
  onerror: ((event: SpeechSynthesisErrorEvent) => void) | null = null;
  constructor(readonly text: string) {}
}

function fakeEnvironment(options: { failSpeak?: boolean } = {}) {
  const utterances: FakeUtterance[] = [];
  const cancel = vi.fn();
  const speak = vi.fn((utterance: SpeechSynthesisUtterance) => {
    if (options.failSpeak) throw new Error("speech unavailable");
    utterances.push(utterance as unknown as FakeUtterance);
  });
  const environment: BrowserSpeechEnvironment = {
    speechSynthesis: { speak, cancel },
    createUtterance: (text) => new FakeUtterance(text) as unknown as SpeechSynthesisUtterance,
  };
  return { environment, utterances, speak, cancel };
}

function notice(overrides: Partial<RunNotice> = {}): RunNotice {
  return {
    noticeId: "notice-1",
    kind: "progress",
    text: "正在核对页面。",
    delivery: "polite",
    eventSequence: 4,
    ...overrides,
  };
}

function options(pending: () => PendingRequestBase | undefined, enabled = true) {
  return { enabled, speechRate: 1 as const, currentPendingRequest: pending };
}

describe("browser RunNotice speech output", () => {
  it("stays silent when disabled and reports unsupported speech synthesis", async () => {
    const { environment, speak } = fakeEnvironment();
    const controller = new RunNoticeSpeechController(new BrowserSpeechOutput(environment), vi.fn());
    const item = notice();
    await controller.deliver(item, options(() => undefined, false));
    await controller.deliver(item, options(() => undefined, true));
    expect(speak).not.toHaveBeenCalled();

    await expect(new BrowserSpeechOutput(null).openSession()).rejects.toThrow("当前浏览器不支持语音播报");
  });

  it("cancels current playback before an interrupt notice and applies the selected rate", async () => {
    const { environment, utterances, cancel } = fakeEnvironment();
    const controller = new RunNoticeSpeechController(new BrowserSpeechOutput(environment), vi.fn());
    await controller.deliver(notice(), { ...options(() => undefined), speechRate: 1.15 });
    await controller.deliver(notice({ noticeId: "notice-2", kind: "error", delivery: "interrupt", eventSequence: 5, text: "遇到问题。" }), options(() => undefined));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(utterances.map((item) => item.text)).toEqual(["正在核对页面。", "遇到问题。"]);
    expect(utterances[0]?.rate).toBe(1.15);
  });

  it("coalesces a StrictMode-style duplicate effect while its notice is in flight", async () => {
    const { environment, utterances } = fakeEnvironment();
    const controller = new RunNoticeSpeechController(new BrowserSpeechOutput(environment), vi.fn());
    const item = notice();
    const states = await Promise.all([
      controller.deliver(item, options(() => undefined)),
      controller.deliver(item, options(() => undefined)),
    ]);
    expect(states).toContain("deferred");
    expect(utterances.map((entry) => entry.text)).toEqual([item.text]);
  });

  it("allows only the latest same-tick interrupt to start, with the terminal result winning", async () => {
    const { environment, utterances } = fakeEnvironment();
    const controller = new RunNoticeSpeechController(new BrowserSpeechOutput(environment), vi.fn());
    const error = notice({ noticeId: "error-1", kind: "error", delivery: "interrupt", eventSequence: 8, text: "旧错误通知。" });
    const result = notice({ noticeId: "result-1", kind: "result", delivery: "interrupt", eventSequence: 9, text: "最终结果。" });
    await Promise.all([
      controller.deliver(error, options(() => undefined)),
      controller.deliver(result, options(() => undefined)),
    ]);
    expect(utterances.map((item) => item.text)).toEqual(["最终结果。"]);
    await controller.deliver(notice({ noticeId: "late-error", kind: "error", delivery: "interrupt", eventSequence: 10 }), options(() => undefined));
    expect(utterances).toHaveLength(1);
  });

  it("cancels and reopens the output session after a speech-rate preference changes", async () => {
    const { environment, utterances, cancel } = fakeEnvironment();
    const controller = new RunNoticeSpeechController(new BrowserSpeechOutput(environment), vi.fn());
    controller.setSpeechRate(0.85);
    await controller.deliver(notice({ noticeId: "slow-1" }), { ...options(() => undefined), speechRate: 0.85 });
    controller.setSpeechRate(1.15);
    await controller.deliver(notice({ noticeId: "fast-2", eventSequence: 5 }), { ...options(() => undefined), speechRate: 1.15 });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(utterances.map((item) => item.rate)).toEqual([0.85, 1.15]);
  });

  it("clears pending-request tracking after the matching utterance settles", async () => {
    const { environment, utterances, cancel } = fakeEnvironment();
    const controller = new RunNoticeSpeechController(new BrowserSpeechOutput(environment), vi.fn());
    const approval: PendingRequestBase = { requestId: "approval-1", kind: "approval" };
    await controller.deliver(
      notice({ noticeId: "approval-1-notice", kind: "approval", delivery: "interrupt", pendingRequestId: approval.requestId }),
      options(() => approval),
    );
    utterances[0]!.onend?.({} as SpeechSynthesisEvent);
    await Promise.resolve();
    await Promise.resolve();
    await controller.deliver(notice({ noticeId: "progress-after-approval", eventSequence: 5 }), options(() => approval));
    controller.syncPendingRequest(undefined);
    await Promise.resolve();
    expect(utterances).toHaveLength(2);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("cancels active speech when the user starts text or voice input", async () => {
    const { environment, cancel } = fakeEnvironment();
    const controller = new RunNoticeSpeechController(new BrowserSpeechOutput(environment), vi.fn());
    await controller.deliver(notice(), options(() => undefined));
    controller.notifyUserStartedInput();
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("rechecks approval immediately before speaking and cancels it when the pending request changes", async () => {
    const { environment, utterances, cancel } = fakeEnvironment();
    let current: PendingRequestBase | undefined = { requestId: "approval-1", kind: "approval" };
    const controller = new RunNoticeSpeechController(new BrowserSpeechOutput(environment), vi.fn());
    const approval = notice({ noticeId: "approval-notice", kind: "approval", delivery: "interrupt", pendingRequestId: "approval-1" });
    await controller.deliver(approval, options(() => current));
    expect(utterances).toHaveLength(1);
    current = undefined;
    controller.syncPendingRequest(current);
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(1);

    let staleCurrent: PendingRequestBase | undefined = { requestId: "approval-old", kind: "approval" };
    let resolveOpening!: (session: VoiceOutputSession) => void;
    const enqueueText = vi.fn(async () => undefined);
    const cancelLateSession = vi.fn(async () => undefined);
    const opening = vi.fn(() => new Promise<VoiceOutputSession>((resolve) => { resolveOpening = resolve; }));
    const delayedAdapter: VoiceOutputAdapter = { openSession: opening };
    const delayedController = new RunNoticeSpeechController(delayedAdapter, vi.fn());
    const delivery = delayedController.deliver(
      notice({ noticeId: "approval-delayed", kind: "approval", delivery: "interrupt", pendingRequestId: "approval-old" }),
      options(() => staleCurrent),
    );
    await Promise.resolve();
    staleCurrent = { requestId: "approval-new", kind: "approval" };
    resolveOpening({ enqueueText, finish: vi.fn(async () => undefined), cancel: cancelLateSession });
    await delivery;
    expect(opening).toHaveBeenCalledTimes(1);
    expect(enqueueText).not.toHaveBeenCalled();
    expect(cancelLateSession).toHaveBeenCalledTimes(1);
  });

  it("defers an approval notice until its newer Run snapshot arrives", async () => {
    const { environment, utterances } = fakeEnvironment();
    const controller = new RunNoticeSpeechController(new BrowserSpeechOutput(environment), vi.fn());
    const approval: PendingRequestBase = { requestId: "approval-current", kind: "approval" };
    const item = notice({
      noticeId: "approval-waiting-for-snapshot",
      kind: "approval",
      delivery: "interrupt",
      pendingRequestId: approval.requestId,
      feedSequence: 12,
    });
    expect(await controller.deliver(item, { ...options(() => undefined), snapshotSequence: 11 })).toBe("deferred");
    expect(utterances).toHaveLength(0);
    expect(await controller.deliver(item, { ...options(() => approval), snapshotSequence: 12 })).toBe("handled");
    expect(utterances.map((entry) => entry.text)).toEqual([item.text]);
  });

  it("keeps notice text available to the caller when speech synthesis fails", async () => {
    const { environment } = fakeEnvironment({ failSpeak: true });
    const onFailure = vi.fn();
    const controller = new RunNoticeSpeechController(new BrowserSpeechOutput(environment), onFailure);
    await controller.deliver(notice(), options(() => undefined));
    expect(onFailure).toHaveBeenCalledWith("语音播报未能播放（speech unavailable）；通知文字仍保留在任务进展中。");
    expect(notice().text).toBe("正在核对页面。");
  });

  it("propagates finish failures to the controller's visible fallback", async () => {
    const onFailure = vi.fn();
    const adapter: VoiceOutputAdapter = {
      async openSession(): Promise<VoiceOutputSession> {
        return {
          enqueueText: async () => undefined,
          finish: async () => { throw new Error("output drain failed"); },
          cancel: async () => undefined,
        };
      },
    };
    const controller = new RunNoticeSpeechController(adapter, onFailure);
    await controller.deliver(notice({ noticeId: "terminal-1", kind: "result", delivery: "interrupt" }), options(() => undefined));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onFailure).toHaveBeenCalledWith("语音播报未能播放（output drain failed）；通知文字仍保留在任务进展中。");
  });

  it("preserves BrowserSpeechSession playback errors for finish() to report", async () => {
    const { environment, utterances } = fakeEnvironment();
    const session = await new BrowserSpeechOutput(environment).openSession();
    const playback = session.enqueueText({ chunkId: "failed-chunk", sequence: 1, text: "需要播报的文字仍在页面上。" });
    utterances[0]!.onerror?.({ error: "failed-chunk" } as unknown as SpeechSynthesisErrorEvent);
    await expect(playback).rejects.toThrow("failed-chunk");
    await expect(session.finish()).rejects.toThrow("failed-chunk");
  });

  it("does not hide a BrowserSpeechSession utterance error from finish()", async () => {
    const { environment, utterances } = fakeEnvironment();
    const session = await new BrowserSpeechOutput(environment).openSession();
    const playback = session.enqueueText({ chunkId: "chunk-1", sequence: 1, text: "测试播报。" });
    utterances[0]!.onerror?.({ error: "synthesis-failed" } as SpeechSynthesisErrorEvent);
    await expect(playback).rejects.toThrow("synthesis-failed");
    await expect(session.finish()).rejects.toThrow("synthesis-failed");
  });

  it("does not replay cached notices when speech is enabled mid-Run", () => {
    const cursor = new RunNoticeCursor("run-1");
    const cached = notice({ eventSequence: 10 });
    expect(cursor.select("run-1", [cached], false)).toEqual([]);
    expect(cursor.select("run-1", [cached], true)).toEqual([]);
    const next = notice({ noticeId: "notice-11", eventSequence: 11 });
    expect(cursor.select("run-1", [cached, next], true)).toEqual([next]);
    cursor.acknowledge(next.noticeId);
    expect(cursor.select("run-1", [cached, next], true)).toEqual([]);

    const enabledOnMount = new RunNoticeCursor("run-2");
    expect(enabledOnMount.select("run-2", [], true)).toEqual([]);
    const firstLiveNotice = notice({ noticeId: "first-live", feedSequence: 1 });
    expect(enabledOnMount.select("run-2", [firstLiveNotice], true)).toEqual([firstLiveNotice]);
  });
});
