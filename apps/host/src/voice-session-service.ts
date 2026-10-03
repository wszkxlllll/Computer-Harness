import { createHash, randomUUID } from "node:crypto";
import type {
  Pcm16AudioChunk,
  StreamingVoiceInputProvider,
  StreamingVoiceInputSession,
  VoiceInputCapabilities,
  VoiceInputEvent,
  VoiceInputSessionService,
  VoiceInputState,
  VoiceSessionEventEnvelope,
  VoiceSessionUpdate,
} from "@computer-harness/voice";
import {
  VOICE_INPUT_MAX_AUDIO_BYTES,
  VOICE_INPUT_MAX_BATCH_CHUNKS,
  VOICE_INPUT_MAX_CHUNK_BYTES,
  VOICE_INPUT_MAX_CHUNKS,
  VOICE_INPUT_MAX_DURATION_MS,
  VOICE_INPUT_RECOMMENDED_CHUNK_BYTES,
  VOICE_INPUT_SAMPLE_RATE,
} from "@computer-harness/voice";

export const VOICE_SAMPLE_RATE = VOICE_INPUT_SAMPLE_RATE;
export const VOICE_CHUNK_BYTES = VOICE_INPUT_RECOMMENDED_CHUNK_BYTES;
export const VOICE_MAX_CHUNK_BYTES = VOICE_INPUT_MAX_CHUNK_BYTES;
export const VOICE_MAX_DURATION_MS = VOICE_INPUT_MAX_DURATION_MS;
export const VOICE_MAX_AUDIO_BYTES = VOICE_INPUT_MAX_AUDIO_BYTES;
export const VOICE_FINAL_CHUNK_UPLOAD_GRACE_MS = 10_000;
const MAX_ACTIVE_SESSIONS = 16;
const MAX_RETAINED_SESSIONS = 64;
const IDLE_TTL_MS = 60_000;
const TERMINAL_TTL_MS = 30_000;
const MAX_EVENTS_PER_SESSION = 512;
const MAX_TRANSCRIPT_CHARS = 20_000;
const MAX_TRANSCRIPT_SEGMENTS = 256;

export class VoiceSessionServiceError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "VoiceSessionServiceError";
  }
}

interface VoiceSessionRecord {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly requestId: string;
  readonly providerSession: StreamingVoiceInputSession;
  firstAudioAt: number | undefined;
  readonly operationDigests: Map<number, string>;
  readonly events: VoiceSessionEventEnvelope[];
  readonly transcriptBySegment: Map<string, string>;
  readonly segmentIdByIndex: Map<number, string>;
  operationTail: Promise<void>;
  lastActivityAt: number;
  acceptedAudioBytes: number;
  nextSequence: number;
  nextEventSequence: number;
  state: VoiceInputState;
  terminalAt?: number;
  providerPump?: Promise<void>;
  readonly stateWaiters: Set<() => void>;
}

export interface VoiceSessionServiceOptions {
  readonly provider?: StreamingVoiceInputProvider;
  readonly now?: () => number;
  readonly sweepIntervalMs?: number;
  readonly maxActiveSessions?: number;
  readonly maxRetainedSessions?: number;
  readonly idleTtlMs?: number;
  readonly maxDurationMs?: number;
  readonly terminalTtlMs?: number;
  readonly finishTimeoutMs?: number;
}

/** Device-owned, bounded, in-memory recognition sessions for the Host API. */
export class HostVoiceSessionService implements VoiceInputSessionService {
  private readonly sessions = new Map<string, VoiceSessionRecord>();
  private readonly startRequests = new Map<string, string>();
  private readonly reservedDevices = new Set<string>();
  private readonly now: () => number;
  private readonly maxActiveSessions: number;
  private readonly maxRetainedSessions: number;
  private readonly idleTtlMs: number;
  private readonly maxDurationMs: number;
  private readonly terminalTtlMs: number;
  private readonly finishTimeoutMs: number;
  private readonly timer?: NodeJS.Timeout;
  private closed = false;

  public constructor(private readonly options: VoiceSessionServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxActiveSessions = options.maxActiveSessions ?? MAX_ACTIVE_SESSIONS;
    this.maxRetainedSessions = options.maxRetainedSessions ?? MAX_RETAINED_SESSIONS;
    this.idleTtlMs = options.idleTtlMs ?? IDLE_TTL_MS;
    this.maxDurationMs = Math.min(options.maxDurationMs ?? VOICE_MAX_DURATION_MS, VOICE_MAX_DURATION_MS);
    this.terminalTtlMs = options.terminalTtlMs ?? TERMINAL_TTL_MS;
    this.finishTimeoutMs = options.finishTimeoutMs ?? 22_000;
    const intervalMs = options.sweepIntervalMs ?? 5_000;
    if (intervalMs > 0) {
      this.timer = setInterval(() => this.sweepExpiredSessions(), intervalMs);
      this.timer.unref?.();
    }
  }

  public capabilities(): VoiceInputCapabilities {
    if (this.closed) return { available: false, unavailableReason: "provider_unavailable" };
    const provider = this.options.provider;
    if (provider === undefined) return { available: false, unavailableReason: "not_configured" };
    const reported = provider.capabilities();
    if (!reported.available) return { ...reported, provider: provider.providerId };
    return {
      ...reported,
      provider: provider.providerId,
      maxDurationMs: this.maxDurationMs,
    };
  }

  public async start(deviceId: string, requestId: string): Promise<VoiceSessionUpdate> {
    this.assertAvailable();
    if (!isIdentifier(deviceId) || !isIdentifier(requestId)) {
      throw new VoiceSessionServiceError(400, "INVALID_REQUEST", "Voice start request is invalid.");
    }
    this.sweepExpiredSessions();
    const idempotencyKey = deviceId + ":" + requestId;
    const previousId = this.startRequests.get(idempotencyKey);
    if (previousId !== undefined) {
      const previous = this.sessions.get(previousId);
      if (previous !== undefined) return this.snapshot(previous, 0);
      this.startRequests.delete(idempotencyKey);
    }
    if (this.reservedDevices.has(deviceId) || [...this.sessions.values()].some((session) =>
      session.deviceId === deviceId && !isTerminal(session.state))) {
      throw new VoiceSessionServiceError(409, "VOICE_SESSION_ACTIVE", "This device already has an active voice session.");
    }
    if (this.activeCount() >= this.maxActiveSessions || this.sessions.size >= this.maxRetainedSessions) {
      this.removeOldestTerminalSessions();
    }
    if (this.activeCount() >= this.maxActiveSessions || this.sessions.size >= this.maxRetainedSessions) {
      throw new VoiceSessionServiceError(429, "VOICE_CAPACITY", "Voice input is busy. Try again shortly.");
    }

    this.reservedDevices.add(deviceId);
    const sessionId = randomUUID();
    let providerSession: StreamingVoiceInputSession;
    try {
      providerSession = await this.options.provider!.start();
    } catch {
      throw new VoiceSessionServiceError(503, "VOICE_PROVIDER_UNAVAILABLE", "Speech recognition could not be started.");
    } finally {
      this.reservedDevices.delete(deviceId);
    }

    if (this.closed) {
      await providerSession.cancel().catch(() => undefined);
      throw new VoiceSessionServiceError(503, "VOICE_UNAVAILABLE", "Voice input is unavailable.");
    }

    const now = this.now();
    const record: VoiceSessionRecord = {
      sessionId,
      deviceId,
      requestId,
      providerSession,
      firstAudioAt: undefined,
      lastActivityAt: now,
      acceptedAudioBytes: 0,
      nextSequence: 0,
      nextEventSequence: 0,
      state: "starting",
      operationDigests: new Map(),
      events: [],
      transcriptBySegment: new Map(),
      segmentIdByIndex: new Map(),
      operationTail: Promise.resolve(),
      stateWaiters: new Set(),
    };
    this.sessions.set(sessionId, record);
    this.startRequests.set(idempotencyKey, sessionId);
    this.emit(record, { type: "state_changed", sessionId, state: "starting" });
    this.emit(record, { type: "state_changed", sessionId, state: "recording" });
    record.state = "recording";
    record.providerPump = this.consumeProviderEvents(record);
    return this.snapshot(record, 0);
  }

  public append(
    deviceId: string,
    sessionId: string,
    chunks: readonly Pcm16AudioChunk[],
    afterEventSequence: number,
  ): Promise<VoiceSessionUpdate> {
    const submittedChunks = Array.isArray(chunks) ? chunks : [];
    let record: VoiceSessionRecord;
    try {
      record = this.requireOwnedSession(deviceId, sessionId);
    } catch (error) {
      zeroChunks(submittedChunks);
      throw error;
    }
    return this.serialize(record, async () => {
      try {
        this.assertActive(record);
        validateEventCursor(record, afterEventSequence);
        if (submittedChunks.length === 0 || submittedChunks.length > VOICE_INPUT_MAX_BATCH_CHUNKS) {
          throw new VoiceSessionServiceError(400, "INVALID_AUDIO_BATCH", "Audio batch size is invalid.");
        }
        let expectedSequence = record.nextSequence;
        let expectedBytes = record.acceptedAudioBytes;
        let previousSubmittedSequence = -1;
        const newChunks: Array<{ readonly chunk: Pcm16AudioChunk; readonly digest: string }> = [];
        for (const chunk of submittedChunks) {
          if (!Number.isSafeInteger(chunk.sequence) || chunk.sequence < 0 || chunk.sequence >= VOICE_INPUT_MAX_CHUNKS || chunk.data.byteLength === 0
            || chunk.data.byteLength > VOICE_MAX_CHUNK_BYTES || chunk.data.byteLength % 2 !== 0
            || chunk.sequence <= previousSubmittedSequence) {
            throw new VoiceSessionServiceError(400, "INVALID_AUDIO_CHUNK", "Audio batch contains an invalid chunk.");
          }
          previousSubmittedSequence = chunk.sequence;
          const digest = createHash("sha256").update(chunk.data).digest("hex");
          const previousDigest = record.operationDigests.get(chunk.sequence);
          if (previousDigest !== undefined) {
            if (previousDigest !== digest) {
              throw new VoiceSessionServiceError(409, "VOICE_CHUNK_CONFLICT", "A repeated audio chunk did not match the accepted chunk.");
            }
            continue;
          }
          if (chunk.sequence !== expectedSequence) {
            throw new VoiceSessionServiceError(409, "VOICE_CHUNK_SEQUENCE", "Audio chunks must arrive once and in order.");
          }
          expectedSequence += 1;
          expectedBytes += chunk.data.byteLength;
          if (expectedBytes > VOICE_MAX_AUDIO_BYTES) {
            throw new VoiceSessionServiceError(413, "VOICE_AUDIO_LIMIT", "Recording reached its size limit.");
          }
          newChunks.push({ chunk, digest });
        }

        for (const { chunk, digest } of newChunks) {
          try {
            await record.providerSession.appendAudioChunk(chunk);
          } catch {
            this.fail(record, "provider_unavailable");
            throw new VoiceSessionServiceError(503, "VOICE_PROVIDER_UNAVAILABLE", "Speech recognition was interrupted.");
          }
          if (isTerminal(record.state)) {
            throw new VoiceSessionServiceError(409, "VOICE_SESSION_TERMINAL", "This voice session has already ended.");
          }
          record.operationDigests.set(chunk.sequence, digest);
          record.nextSequence += 1;
          record.acceptedAudioBytes += chunk.data.byteLength;
          record.firstAudioAt ??= this.now();
          record.lastActivityAt = this.now();
        }
        if (newChunks.length === 0) record.lastActivityAt = this.now();
        const lastChunk = submittedChunks.at(-1)!;
        return {
          ...this.snapshot(record, afterEventSequence),
          acceptedAudioBytes: record.acceptedAudioBytes,
          acceptedSequence: lastChunk.sequence,
          duplicate: newChunks.length === 0,
        };
      } finally {
        zeroChunks(submittedChunks);
      }
    });
  }

  public finish(deviceId: string, sessionId: string, afterEventSequence: number): Promise<VoiceSessionUpdate> {
    const record = this.requireOwnedSession(deviceId, sessionId);
    return this.serialize(record, async () => {
      validateEventCursor(record, afterEventSequence);
      if (record.state === "finished" || record.state === "cancelled") return this.snapshot(record, afterEventSequence);
      if (record.state === "failed") throw new VoiceSessionServiceError(409, "VOICE_SESSION_FAILED", "This recording could not be completed.");
      if (record.state === "recording") {
        record.state = "finalizing";
        record.lastActivityAt = this.now();
        this.emit(record, { type: "state_changed", sessionId, state: "finalizing" });
      }
      try {
        await withTimeout(record.providerSession.finish(), this.finishTimeoutMs);
        await this.waitForTerminal(record);
      } catch {
        if ((record.state as VoiceInputState) === "cancelled") {
          throw new VoiceSessionServiceError(409, "VOICE_SESSION_CANCELLED", "This recording was cancelled.");
        }
        if ((record.state as VoiceInputState) === "failed") {
          throw new VoiceSessionServiceError(503, "VOICE_PROVIDER_UNAVAILABLE", "Speech recognition could not finish.");
        }
        if (!isTerminal(record.state)) this.fail(record, "provider_timeout");
        throw new VoiceSessionServiceError(504, "VOICE_FINISH_TIMEOUT", "The final transcript did not arrive in time.");
      }
      if ((record.state as VoiceInputState) !== "finished") throw new VoiceSessionServiceError(409, "VOICE_SESSION_FAILED", "This recording could not be completed.");
      return this.snapshot(record, afterEventSequence);
    });
  }

  public async cancel(deviceId: string, sessionId: string, afterEventSequence: number): Promise<VoiceSessionUpdate> {
    const record = this.requireOwnedSession(deviceId, sessionId);
    validateEventCursor(record, afterEventSequence);
    if (isTerminal(record.state)) return this.snapshot(record, afterEventSequence);
    record.state = "cancelled";
    record.terminalAt = this.now();
    record.firstAudioAt = undefined;
    this.emit(record, { type: "state_changed", sessionId, state: "cancelled" });
    record.stateWaiters.forEach((notify) => notify());
    record.operationDigests.clear();
    this.clearTranscriptEvents(record);
    await record.providerSession.cancel().catch(() => undefined);
    return this.snapshot(record, afterEventSequence);
  }

  public async cancelDevice(deviceId: string): Promise<void> {
    const sessions = [...this.sessions.values()].filter((session) => session.deviceId === deviceId && !isTerminal(session.state));
    await Promise.all(sessions.map(async (record) => {
      record.state = "cancelled";
      record.terminalAt = this.now();
      record.firstAudioAt = undefined;
      record.operationDigests.clear();
      record.stateWaiters.forEach((notify) => notify());
      this.emit(record, { type: "state_changed", sessionId: record.sessionId, state: "cancelled" });
      this.clearTranscriptEvents(record);
      await record.providerSession.cancel().catch(() => undefined);
    }));
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    const activeDevices = new Set([...this.sessions.values()].filter((record) => !isTerminal(record.state)).map((record) => record.deviceId));
    await Promise.all([...activeDevices].map((deviceId) => this.cancelDevice(deviceId)));
    this.sessions.clear();
    this.startRequests.clear();
  }

  /** Public for deterministic tests and the periodic bounded cleanup timer. */
  public sweepExpiredSessions(): void {
    const now = this.now();
    for (const record of [...this.sessions.values()]) {
      if (isTerminal(record.state)) {
        if (record.terminalAt !== undefined && now - record.terminalAt >= this.terminalTtlMs) this.removeSession(record);
        continue;
      }
      if (record.state !== "recording") continue;
      const expiredByAge = record.firstAudioAt !== undefined
        && now - record.firstAudioAt >= this.maxDurationMs + VOICE_FINAL_CHUNK_UPLOAD_GRACE_MS;
      const expiredByIdle = now - record.lastActivityAt >= this.idleTtlMs;
      if (expiredByAge || expiredByIdle) {
        this.fail(record, expiredByAge ? "session_expired" : "session_idle_timeout");
        void record.providerSession.cancel().catch(() => undefined);
      }
    }
  }

  private async consumeProviderEvents(record: VoiceSessionRecord): Promise<void> {
    try {
      for await (const event of record.providerSession.events) {
        if (this.sessions.get(record.sessionId) !== record || isTerminal(record.state)) break;
        if (event.sessionId !== record.providerSession.sessionId) continue;
        if (event.type === "state_changed") {
          if (event.state === "starting" || event.state === "recording") continue;
          if (event.state === "finalizing") {
            if (record.state === "recording") {
              record.state = "finalizing";
              this.emit(record, { type: "state_changed", sessionId: record.sessionId, state: "finalizing" });
            }
            continue;
          }
          record.state = event.state;
          record.terminalAt = this.now();
          record.firstAudioAt = undefined;
          record.operationDigests.clear();
          this.emit(record, {
            type: "state_changed",
            sessionId: record.sessionId,
            state: event.state,
            ...(event.state === "failed" ? { errorCode: safeErrorCode(event.errorCode) } : {}),
          });
          record.stateWaiters.forEach((notify) => notify());
          continue;
        }
        const segment = event.segment;
        if (typeof segment.segmentId !== "string" || segment.segmentId.trim().length === 0 || segment.segmentId.length > 256
          || !Number.isSafeInteger(segment.index) || segment.index < 0
          || !Number.isSafeInteger(segment.revision) || segment.revision < 0
          || typeof segment.text !== "string" || (segment.state !== "partial" && segment.state !== "final")) {
          this.fail(record, "provider_protocol_error");
          await record.providerSession.cancel().catch(() => undefined);
          break;
        }
        const existingIndexId = record.segmentIdByIndex.get(segment.index);
        const existingSegmentIndex = [...record.segmentIdByIndex.entries()]
          .find(([, segmentId]) => segmentId === segment.segmentId)?.[0];
        if ((existingIndexId !== undefined && existingIndexId !== segment.segmentId)
          || (existingSegmentIndex !== undefined && existingSegmentIndex !== segment.index)
          || (!record.transcriptBySegment.has(segment.segmentId) && record.transcriptBySegment.size >= MAX_TRANSCRIPT_SEGMENTS)) {
          this.fail(record, "provider_protocol_error");
          await record.providerSession.cancel().catch(() => undefined);
          break;
        }
        const totalTranscriptChars = [...record.transcriptBySegment.entries()]
          .reduce((total, [segmentId, text]) => total + (segmentId === segment.segmentId ? 0 : text.length), 0)
          + segment.text.length;
        if (segment.text.length > MAX_TRANSCRIPT_CHARS || totalTranscriptChars > MAX_TRANSCRIPT_CHARS) {
          this.fail(record, "provider_protocol_error");
          await record.providerSession.cancel().catch(() => undefined);
          break;
        }
        record.transcriptBySegment.set(segment.segmentId, segment.text);
        record.segmentIdByIndex.set(segment.index, segment.segmentId);
        this.emit(record, { type: "transcript_updated", sessionId: record.sessionId, segment: structuredClone(segment) });
      }
    } catch {
      if (!isTerminal(record.state)) this.fail(record, "provider_unavailable");
    }
    if (!isTerminal(record.state) && this.sessions.get(record.sessionId) === record) {
      this.fail(record, "provider_unavailable");
    }
  }

  private emit(record: VoiceSessionRecord, event: VoiceInputEvent): void {
    const envelope = { sequence: ++record.nextEventSequence, event };
    if (event.type === "transcript_updated") {
      const previousIndex = record.events.findIndex((entry) => entry.event.type === "transcript_updated"
        && entry.event.segment.segmentId === event.segment.segmentId);
      if (previousIndex >= 0) {
        record.events[previousIndex] = envelope;
        return;
      }
    }
    record.events.push(envelope);
    while (record.events.length > MAX_EVENTS_PER_SESSION) record.events.shift();
    if (event.type === "state_changed") record.stateWaiters.forEach((notify) => notify());
  }

  private snapshot(record: VoiceSessionRecord, afterSequence: number): VoiceSessionUpdate {
    validateEventCursor(record, afterSequence);
    return {
      sessionId: record.sessionId,
      events: record.events.filter((entry) => entry.sequence > afterSequence)
        .sort((left, right) => left.sequence - right.sequence)
        .map((entry) => structuredClone(entry)),
      eventCursor: record.nextEventSequence,
      acceptedAudioBytes: record.acceptedAudioBytes,
    };
  }

  private requireOwnedSession(deviceId: string, sessionId: string): VoiceSessionRecord {
    this.sweepExpiredSessions();
    const record = this.sessions.get(sessionId);
    if (record === undefined || record.deviceId !== deviceId) {
      throw new VoiceSessionServiceError(404, "VOICE_SESSION_NOT_FOUND", "Voice session was not found.");
    }
    return record;
  }

  private assertAvailable(): void {
    if (this.closed || this.options.provider === undefined) {
      throw new VoiceSessionServiceError(503, "VOICE_UNAVAILABLE", "Voice input is not configured on this computer.");
    }
  }

  private assertActive(record: VoiceSessionRecord): void {
    if (isTerminal(record.state)) throw new VoiceSessionServiceError(409, "VOICE_SESSION_TERMINAL", "This voice session has already ended.");
    if (record.state !== "recording") throw new VoiceSessionServiceError(409, "VOICE_SESSION_FINALIZING", "This voice session is already finalizing.");
    const now = this.now();
    const expiredByAge = record.firstAudioAt !== undefined
      && now - record.firstAudioAt >= this.maxDurationMs + VOICE_FINAL_CHUNK_UPLOAD_GRACE_MS;
    const expiredByIdle = now - record.lastActivityAt >= this.idleTtlMs;
    if (expiredByAge || expiredByIdle) {
      this.fail(record, expiredByAge ? "session_expired" : "session_idle_timeout");
      void record.providerSession.cancel().catch(() => undefined);
      throw new VoiceSessionServiceError(410, "VOICE_SESSION_EXPIRED", "This recording expired. Start a new one.");
    }
  }

  private activeCount(): number {
    return [...this.sessions.values()].filter((session) => !isTerminal(session.state)).length + this.reservedDevices.size;
  }

  private removeOldestTerminalSessions(): void {
    const terminal = [...this.sessions.values()].filter((session) => isTerminal(session.state)).sort((a, b) => (a.terminalAt ?? 0) - (b.terminalAt ?? 0));
    while (this.sessions.size >= this.maxRetainedSessions && terminal.length > 0) this.removeSession(terminal.shift()!);
  }

  private removeSession(record: VoiceSessionRecord): void {
    this.sessions.delete(record.sessionId);
    this.startRequests.delete(record.deviceId + ":" + record.requestId);
    record.operationDigests.clear();
    record.transcriptBySegment.clear();
    record.segmentIdByIndex.clear();
    record.firstAudioAt = undefined;
    record.events.length = 0;
  }

  private clearTranscriptEvents(record: VoiceSessionRecord): void {
    record.transcriptBySegment.clear();
    record.segmentIdByIndex.clear();
    for (let index = record.events.length - 1; index >= 0; index -= 1) {
      if (record.events[index]?.event.type === "transcript_updated") record.events.splice(index, 1);
    }
  }

  private serialize<T>(record: VoiceSessionRecord, operation: () => Promise<T>): Promise<T> {
    const pending = record.operationTail.then(operation, operation);
    record.operationTail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private async waitForTerminal(record: VoiceSessionRecord): Promise<void> {
    if (isTerminal(record.state)) {
      if (record.state === "finished") return;
      throw new VoiceSessionServiceError(409, "VOICE_SESSION_FAILED", "This recording could not be completed.");
    }
    await withTimeout(new Promise<void>((resolve) => {
      const notify = () => {
        if (!isTerminal(record.state)) return;
        record.stateWaiters.delete(notify);
        resolve();
      };
      record.stateWaiters.add(notify);
      notify();
    }), this.finishTimeoutMs);
  }

  private fail(record: VoiceSessionRecord, errorCode: string): void {
    if (isTerminal(record.state)) return;
    record.state = "failed";
    record.terminalAt = this.now();
    record.firstAudioAt = undefined;
    record.operationDigests.clear();
    this.emit(record, { type: "state_changed", sessionId: record.sessionId, state: "failed", errorCode: safeErrorCode(errorCode) });
    record.stateWaiters.forEach((notify) => notify());
  }
}

function validateEventCursor(record: VoiceSessionRecord, cursor: number): void {
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > record.nextEventSequence) {
    throw new VoiceSessionServiceError(400, "INVALID_VOICE_CURSOR", "Voice event cursor is invalid.");
  }
}

function isIdentifier(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}

function zeroChunks(chunks: readonly Pcm16AudioChunk[]): void {
  for (const chunk of chunks) chunk.data.fill(0);
}

function isTerminal(state: VoiceInputState): boolean {
  return state === "finished" || state === "cancelled" || state === "failed";
}

function safeErrorCode(value: string | undefined): string {
  if (value === "provider_timeout") return value;
  if (value === "provider_protocol_error") return value;
  if (value === "session_expired") return value;
  if (value === "session_idle_timeout") return value;
  return "provider_unavailable";
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
