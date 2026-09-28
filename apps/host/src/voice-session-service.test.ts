import { describe, expect, it, vi } from "vitest";
import type {
  Pcm16AudioChunk,
  StreamingVoiceInputProvider,
  StreamingVoiceInputSession,
  VoiceInputEvent,
} from "@computer-harness/voice";
import { HostVoiceSessionService, VOICE_FINAL_CHUNK_UPLOAD_GRACE_MS, VOICE_MAX_AUDIO_BYTES, VOICE_MAX_DURATION_MS } from "./voice-session-service.js";

class FakeEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private ended = false;

  public push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  public close(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  public [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

class FakeVoiceSession implements StreamingVoiceInputSession {
  public readonly sessionId = "provider-session-1";
  public readonly queue = new FakeEventQueue<VoiceInputEvent>();
  public readonly events = this.queue;
  public readonly appendAudioChunk = vi.fn(async (chunk: Pcm16AudioChunk) => {
    this.queue.push({
      type: "transcript_updated",
      sessionId: this.sessionId,
      segment: { segmentId: "item-1:0", index: 0, revision: chunk.sequence, text: "预览", state: "partial" },
    });
  });
  public readonly finish = vi.fn(async () => {
    this.queue.push({ type: "state_changed", sessionId: this.sessionId, state: "finalizing" });
    this.queue.push({
      type: "transcript_updated",
      sessionId: this.sessionId,
      segment: { segmentId: "item-1:0", index: 0, revision: 99, text: "完整语音指令", state: "final" },
    });
    this.queue.push({ type: "state_changed", sessionId: this.sessionId, state: "finished" });
    this.queue.close();
  });
  public readonly cancel = vi.fn(async () => {
    this.queue.push({ type: "state_changed", sessionId: this.sessionId, state: "cancelled" });
    this.queue.close();
  });
}

function fakeProvider(session = new FakeVoiceSession()): StreamingVoiceInputProvider {
  const providerId = "fixture-streaming-asr";
  return {
    providerId,
    capabilities: () => ({ available: true, provider: "untrusted-capability-label", sampleRate: 16_000, channels: 1, chunkBytes: 2_400, maxDurationMs: 45_000 }),
    start: vi.fn(async () => session),
  };
}

describe("HostVoiceSessionService", () => {
  it("reports unavailable without a configured provider and does not create a session", async () => {
    const service = new HostVoiceSessionService({ sweepIntervalMs: 0 });
    expect(service.capabilities()).toEqual({ available: false, unavailableReason: "not_configured" });
    await expect(service.start("device-1", "request-1")).rejects.toMatchObject({ code: "VOICE_UNAVAILABLE" });
    await service.close();
  });

  it("binds one session per device, makes starts idempotent, and returns provider-owned capabilities", async () => {
    const providerSession = new FakeVoiceSession();
    const provider = fakeProvider(providerSession);
    const service = new HostVoiceSessionService({ provider, sweepIntervalMs: 0 });
    const first = await service.start("device-1", "request-1");
    const duplicateStart = await service.start("device-1", "request-1");
    expect(service.capabilities()).toMatchObject({ available: true, provider: "fixture-streaming-asr", sampleRate: 16_000, channels: 1, chunkBytes: 2_400, maxDurationMs: 60_000 });
    expect(first.sessionId).toBe(duplicateStart.sessionId);
    expect(first.events.map((entry) => entry.event.type === "state_changed" ? entry.event.state : "transcript")).toEqual(["starting", "recording"]);
    expect(provider.start).toHaveBeenCalledTimes(1);
    await expect(service.start("device-1", "request-2")).rejects.toMatchObject({ code: "VOICE_SESSION_ACTIVE" });
    await service.close();
  });

  it("reserves capacity before the provider await so simultaneous devices cannot exceed the bound", async () => {
    const providerSession = new FakeVoiceSession();
    let releaseProviderStart: (session: StreamingVoiceInputSession) => void = () => undefined;
    const provider: StreamingVoiceInputProvider = {
      providerId: "fixture-streaming-asr",
      capabilities: () => ({ available: true, provider: "fixture-streaming-asr", sampleRate: 16_000, channels: 1, chunkBytes: 3_200 }),
      start: vi.fn(() => new Promise((resolve) => { releaseProviderStart = resolve; })),
    };
    const service = new HostVoiceSessionService({ provider, maxActiveSessions: 1, sweepIntervalMs: 0 });
    const first = service.start("device-1", "request-1");
    await vi.waitFor(() => expect(provider.start).toHaveBeenCalledTimes(1));
    await expect(service.start("device-2", "request-2")).rejects.toMatchObject({ code: "VOICE_CAPACITY" });
    releaseProviderStart(providerSession);
    await first;
    await service.close();
  });

  it("enforces device ownership, strict sequence, digest-based duplicate idempotency, and chunk caps", async () => {
    const providerSession = new FakeVoiceSession();
    const service = new HostVoiceSessionService({ provider: fakeProvider(providerSession), sweepIntervalMs: 0 });
    const started = await service.start("device-1", "request-1");
    const makeChunk = () => ({ sequence: 0, data: new Uint8Array(3_200).fill(7) });
    expect(() => service.append("device-2", started.sessionId, [makeChunk()], started.eventCursor)).toThrow(expect.objectContaining({ code: "VOICE_SESSION_NOT_FOUND" }));
    const wrongSequence = makeChunk();
    await expect(service.append("device-1", started.sessionId, [{ sequence: 1, data: wrongSequence.data }], started.eventCursor)).rejects.toMatchObject({ code: "VOICE_CHUNK_SEQUENCE" });
    expect(wrongSequence.data.every((byte) => byte === 0)).toBe(true);

    const acceptedChunk = makeChunk();
    const accepted = await service.append("device-1", started.sessionId, [acceptedChunk], started.eventCursor);
    expect(acceptedChunk.data.every((byte) => byte === 0)).toBe(true);
    const duplicateChunk = makeChunk();
    const duplicate = await service.append("device-1", started.sessionId, [duplicateChunk], accepted.eventCursor);
    expect(duplicateChunk.data.every((byte) => byte === 0)).toBe(true);
    expect(accepted).toMatchObject({ acceptedSequence: 0, duplicate: false, acceptedAudioBytes: 3_200 });
    expect(duplicate).toMatchObject({ acceptedSequence: 0, duplicate: true, acceptedAudioBytes: 3_200 });
    expect(providerSession.appendAudioChunk).toHaveBeenCalledTimes(1);
    await expect(service.append("device-1", started.sessionId, [{ sequence: 0, data: new Uint8Array([1, 0]) }], duplicate.eventCursor))
      .rejects.toMatchObject({ code: "VOICE_CHUNK_CONFLICT" });
    await expect(service.append("device-1", started.sessionId, [{ sequence: 1, data: new Uint8Array(4_098) }], duplicate.eventCursor))
      .rejects.toMatchObject({ code: "INVALID_AUDIO_CHUNK" });
    await service.close();
  });

  it("prevalidates an entire batch before forwarding any new prefix when a later chunk conflicts or skips", async () => {
    const providerSession = new FakeVoiceSession();
    const service = new HostVoiceSessionService({ provider: fakeProvider(providerSession), sweepIntervalMs: 0 });
    const started = await service.start("device-1", "request-1");
    const first = { sequence: 0, data: new Uint8Array([1, 0]) };
    const accepted = await service.append("device-1", started.sessionId, [first], started.eventCursor);
    expect(providerSession.appendAudioChunk).toHaveBeenCalledTimes(1);

    const newPrefix = { sequence: 1, data: new Uint8Array([2, 0]) };
    const conflictingRetry = { sequence: 0, data: new Uint8Array([9, 0]) };
    await expect(service.append("device-1", started.sessionId, [conflictingRetry, newPrefix], accepted.eventCursor))
      .rejects.toMatchObject({ code: "VOICE_CHUNK_CONFLICT" });
    expect(providerSession.appendAudioChunk).toHaveBeenCalledTimes(1);

    const validPrefix = { sequence: 1, data: new Uint8Array([2, 0]) };
    const sequenceGap = { sequence: 3, data: new Uint8Array([3, 0]) };
    await expect(service.append("device-1", started.sessionId, [validPrefix, sequenceGap], accepted.eventCursor))
      .rejects.toMatchObject({ code: "VOICE_CHUNK_SEQUENCE" });
    expect(providerSession.appendAudioChunk).toHaveBeenCalledTimes(1);
    expect([conflictingRetry, newPrefix, validPrefix, sequenceGap].every((chunk) => chunk.data.every((byte) => byte === 0))).toBe(true);
    await service.close();
  });

  it("allows the normal microphone permission delay and measures the 60 second cap from first accepted audio", async () => {
    let now = 1_000;
    const providerSession = new FakeVoiceSession();
    const service = new HostVoiceSessionService({ provider: fakeProvider(providerSession), now: () => now, sweepIntervalMs: 0 });
    const started = await service.start("device-1", "request-1");
    now += 30_000;
    const first = await service.append("device-1", started.sessionId, [{ sequence: 0, data: new Uint8Array(3_200) }], started.eventCursor);
    expect(first.acceptedSequence).toBe(0);
    now += 59_999;
    const second = await service.append("device-1", started.sessionId, [{ sequence: 1, data: new Uint8Array(3_200) }], first.eventCursor);
    expect(second.acceptedSequence).toBe(1);
    now += VOICE_FINAL_CHUNK_UPLOAD_GRACE_MS + 3;
    service.sweepExpiredSessions();
    const expired = await service.cancel("device-1", started.sessionId, second.eventCursor);
    expect(expired.events.at(-1)).toMatchObject({ event: { type: "state_changed", state: "failed", errorCode: "session_expired" } });
    await service.close();
  });

  it("accepts the final audio batch during the bounded upload grace without relaxing the byte cap", async () => {
    let now = 2_000;
    const providerSession = new FakeVoiceSession();
    const service = new HostVoiceSessionService({ provider: fakeProvider(providerSession), now: () => now, sweepIntervalMs: 0 });
    const started = await service.start("device-1", "request-1");
    const first = await service.append("device-1", started.sessionId, [{ sequence: 0, data: new Uint8Array(3_200) }], started.eventCursor);
    now += VOICE_MAX_DURATION_MS - 100;
    const recent = await service.append("device-1", started.sessionId, [{ sequence: 1, data: new Uint8Array(3_200) }], first.eventCursor);
    now += 5_100;
    service.sweepExpiredSessions();
    const tail = await service.append("device-1", started.sessionId, [
      { sequence: 2, data: new Uint8Array(3_200) },
      { sequence: 3, data: new Uint8Array(3_200) },
    ], recent.eventCursor);
    expect(tail.acceptedSequence).toBe(3);
    expect(tail.acceptedAudioBytes).toBe(12_800);
    expect(providerSession.appendAudioChunk).toHaveBeenCalledTimes(4);
    const finished = await service.finish("device-1", started.sessionId, tail.eventCursor);
    expect(finished.events.at(-1)).toMatchObject({ event: { type: "state_changed", state: "finished" } });
    await service.close();
  });

  it("does not age-expire finalizing sessions, while the existing finish timeout still fails", async () => {
    let now = 3_000;
    const providerSession = new FakeVoiceSession();
    const provider = fakeProvider(providerSession);
    providerSession.finish.mockImplementation(() => new Promise<void>(() => undefined));
    const service = new HostVoiceSessionService({ provider, now: () => now, sweepIntervalMs: 0, finishTimeoutMs: 75 });
    const started = await service.start("device-1", "request-1");
    const first = await service.append("device-1", started.sessionId, [{ sequence: 0, data: new Uint8Array(3_200) }], started.eventCursor);
    now += VOICE_MAX_DURATION_MS - 100;
    const recent = await service.append("device-1", started.sessionId, [{ sequence: 1, data: new Uint8Array(3_200) }], first.eventCursor);
    now += 5_100;
    const finishing = service.finish("device-1", started.sessionId, recent.eventCursor);
    await vi.waitFor(() => expect(providerSession.finish).toHaveBeenCalledTimes(1));
    now += VOICE_MAX_DURATION_MS + VOICE_FINAL_CHUNK_UPLOAD_GRACE_MS;
    service.sweepExpiredSessions();
    expect(providerSession.cancel).not.toHaveBeenCalled();
    await expect(finishing).rejects.toMatchObject({ code: "VOICE_FINISH_TIMEOUT" });
    await service.close();
  });

  it("only exposes final transcript after the provider terminal event, and finish is idempotent", async () => {
    const providerSession = new FakeVoiceSession();
    const service = new HostVoiceSessionService({ provider: fakeProvider(providerSession), sweepIntervalMs: 0 });
    const started = await service.start("device-1", "request-1");
    const appended = await service.append("device-1", started.sessionId, [{ sequence: 0, data: new Uint8Array(3_200) }], started.eventCursor);
    expect(appended.events.some((entry) => entry.event.type === "transcript_updated" && entry.event.segment.state === "partial")).toBe(true);

    const finished = await service.finish("device-1", started.sessionId, appended.eventCursor);
    const finalSegments = finished.events.flatMap((entry) => entry.event.type === "transcript_updated" && entry.event.segment.state === "final" ? [entry.event.segment.text] : []);
    expect(finalSegments).toEqual(["完整语音指令"]);
    expect(finished.events.at(-1)).toMatchObject({ event: { type: "state_changed", state: "finished" } });
    expect(providerSession.finish).toHaveBeenCalledTimes(1);

    const repeatedFinish = await service.finish("device-1", started.sessionId, finished.eventCursor);
    expect(repeatedFinish.events).toEqual([]);
    expect(providerSession.finish).toHaveBeenCalledTimes(1);
    await service.close();
  });

  it("makes cancel idempotent, discards transcript previews, and clears raw chunk digests", async () => {
    const providerSession = new FakeVoiceSession();
    const service = new HostVoiceSessionService({ provider: fakeProvider(providerSession), sweepIntervalMs: 0 });
    const started = await service.start("device-1", "request-1");
    const appended = await service.append("device-1", started.sessionId, [{ sequence: 0, data: new Uint8Array(3_200) }], started.eventCursor);
    const cancelled = await service.cancel("device-1", started.sessionId, appended.eventCursor);
    expect(cancelled.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: { type: "state_changed", state: "cancelled", sessionId: started.sessionId } }),
    ]));
    expect(cancelled.events.some((entry) => entry.event.type === "transcript_updated")).toBe(false);
    await service.cancel("device-1", started.sessionId, cancelled.eventCursor);
    expect(providerSession.cancel).toHaveBeenCalledTimes(1);
    await service.close();
  });

  it("allows cancel to interrupt a pending finalization instead of waiting behind its request", async () => {
    const providerSession = new FakeVoiceSession();
    let releaseFinish: () => void = () => undefined;
    providerSession.finish.mockImplementation(() => new Promise<void>((resolve) => { releaseFinish = resolve; }));
    const service = new HostVoiceSessionService({ provider: fakeProvider(providerSession), sweepIntervalMs: 0, finishTimeoutMs: 1_000 });
    const started = await service.start("device-1", "request-1");
    const finishing = service.finish("device-1", started.sessionId, started.eventCursor);
    await vi.waitFor(() => expect(providerSession.finish).toHaveBeenCalledTimes(1));
    const cancelled = await service.cancel("device-1", started.sessionId, started.eventCursor);
    expect(cancelled.events.at(-1)).toMatchObject({ event: { type: "state_changed", state: "cancelled" } });
    expect(providerSession.cancel).toHaveBeenCalledTimes(1);
    releaseFinish();
    await expect(finishing).rejects.toMatchObject({ code: "VOICE_SESSION_CANCELLED" });
    await service.close();
  });

  it("applies total active and byte limits, expires idle sessions, and cleans retained state", async () => {
    let now = 1_000;
    const providerSession = new FakeVoiceSession();
    const provider = fakeProvider(providerSession);
    const service = new HostVoiceSessionService({
      provider,
      now: () => now,
      sweepIntervalMs: 0,
      maxActiveSessions: 1,
      idleTtlMs: 1_000,
      terminalTtlMs: 500,
    });
    const started = await service.start("device-1", "request-1");
    await expect(service.start("device-2", "request-2")).rejects.toMatchObject({ code: "VOICE_CAPACITY" });
    await expect(service.append("device-1", started.sessionId, [{ sequence: 0, data: new Uint8Array(VOICE_MAX_AUDIO_BYTES + 2) }], started.eventCursor))
      .rejects.toMatchObject({ code: "INVALID_AUDIO_CHUNK" });
    now += 1_001;
    service.sweepExpiredSessions();
    expect(providerSession.cancel).toHaveBeenCalledTimes(1);
    const expired = await service.cancel("device-1", started.sessionId, started.eventCursor);
    expect(expired.events.at(-1)).toMatchObject({ event: { type: "state_changed", state: "failed", errorCode: "session_idle_timeout" } });
    now += 501;
    service.sweepExpiredSessions();
    await expect(service.cancel("device-1", started.sessionId, 0)).rejects.toMatchObject({ code: "VOICE_SESSION_NOT_FOUND" });
    await service.close();
  });

  it("stops at the 60 second aggregate audio cap", async () => {
    const providerSession = new FakeVoiceSession();
    const service = new HostVoiceSessionService({ provider: fakeProvider(providerSession), sweepIntervalMs: 0 });
    const started = await service.start("device-1", "request-1");
    let cursor = started.eventCursor;
    for (let sequence = 0; sequence < 600; sequence += 1) {
      const result = await service.append("device-1", started.sessionId, [{ sequence, data: new Uint8Array(3_200) }], cursor);
      cursor = result.eventCursor;
    }
    await expect(service.append("device-1", started.sessionId, [{ sequence: 600, data: new Uint8Array(2) }], cursor))
      .rejects.toMatchObject({ code: "VOICE_AUDIO_LIMIT" });
    expect(providerSession.appendAudioChunk).toHaveBeenCalledTimes(600);
    await service.close();
  });
});
