import { createHash, randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  VOICE_INPUT_MAX_CHUNK_BYTES,
  VOICE_INPUT_MAX_CHUNKS,
  VOICE_INPUT_MAX_DURATION_MS,
  VOICE_INPUT_RECOMMENDED_CHUNK_BYTES,
} from "@computer-harness/voice";
import type {
  Pcm16AudioChunk,
  StreamingVoiceInputProvider,
  StreamingVoiceInputSession,
  VoiceInputCapabilities,
  VoiceInputEvent,
  VoiceInputState,
  VoiceTranscriptSegment,
} from "@computer-harness/voice";

const DEFAULT_MODEL = "qwen3-asr-flash-realtime";
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_FINISH_TIMEOUT_MS = 20_000;
const MAX_TRANSCRIPT_CHARS = 20_000;
const MAX_SERVER_EVENT_BYTES = 128 * 1024;

export type QwenRealtimeEvent = Readonly<Record<string, unknown>>;

export interface QwenRealtimeConnection {
  readonly ready: Promise<void>;
  send(event: QwenRealtimeEvent): void;
  onMessage(listener: (event: unknown) => void): () => void;
  onError(listener: () => void): () => void;
  onClose(listener: () => void): () => void;
  close(): void;
}

export type QwenRealtimeSocketFactory = (
  url: string,
  headers: Readonly<Record<string, string>>,
) => QwenRealtimeConnection;

export interface QwenRealtimeProviderOptions {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly workspaceId?: string;
  readonly language?: string;
  readonly handshakeTimeoutMs?: number;
  readonly finishTimeoutMs?: number;
  readonly createConnection?: QwenRealtimeSocketFactory;
}

export class QwenVoiceProviderError extends Error {
  public constructor(public readonly code: "provider_unavailable" | "provider_timeout" | "provider_protocol_error") {
    super(code);
    this.name = "QwenVoiceProviderError";
  }
}

/** Qwen realtime ASR adapter. It owns only the provider WebSocket protocol. */
export class QwenRealtimeVoiceProvider implements StreamingVoiceInputProvider {
  public readonly providerId = DEFAULT_MODEL;
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly workspaceId: string | undefined;
  private readonly language: string;
  private readonly handshakeTimeoutMs: number;
  private readonly finishTimeoutMs: number;
  private readonly createConnection: QwenRealtimeSocketFactory;

  public constructor(options: QwenRealtimeProviderOptions) {
    this.endpoint = validateEndpoint(options.endpoint);
    if (options.apiKey.trim().length === 0) throw new Error("Qwen realtime ASR requires an API key.");
    this.apiKey = options.apiKey;
    this.workspaceId = options.workspaceId;
    this.language = options.language ?? "zh";
    this.handshakeTimeoutMs = positiveTimeout(options.handshakeTimeoutMs, DEFAULT_HANDSHAKE_TIMEOUT_MS);
    this.finishTimeoutMs = positiveTimeout(options.finishTimeoutMs, DEFAULT_FINISH_TIMEOUT_MS);
    this.createConnection = options.createConnection ?? createNodeWebSocketConnection;
  }

  public capabilities(): VoiceInputCapabilities {
    return {
      available: true,
      provider: this.providerId,
      sampleRate: 16_000,
      channels: 1,
      chunkBytes: VOICE_INPUT_RECOMMENDED_CHUNK_BYTES,
      maxDurationMs: VOICE_INPUT_MAX_DURATION_MS,
    };
  }

  public async start(options: { readonly signal?: AbortSignal } = {}): Promise<StreamingVoiceInputSession> {
    if (options.signal?.aborted) throw new QwenVoiceProviderError("provider_unavailable");
    const url = new URL(this.endpoint);
    url.searchParams.set("model", DEFAULT_MODEL);
    const headers: Record<string, string> = {
      Authorization: "Bearer " + this.apiKey,
      "OpenAI-Beta": "realtime=v1",
    };
    if (this.workspaceId !== undefined && this.workspaceId.length > 0) {
      headers["X-DashScope-WorkSpace"] = this.workspaceId;
    }

    let connection: QwenRealtimeConnection | undefined;
    try {
      connection = this.createConnection(url.toString(), headers);
      await withTimeout(connection.ready, this.handshakeTimeoutMs, options.signal);
    } catch (error) {
      try { connection?.close(); } catch { /* Preserve the original connect/timeout failure. */ }
      const code = options.signal?.aborted ? "provider_unavailable"
        : error instanceof Error && error.message === "timeout" ? "provider_timeout"
          : "provider_unavailable";
      throw new QwenVoiceProviderError(code);
    }

    const session = new QwenRealtimeVoiceSession(connection!, this.language, this.finishTimeoutMs);
    try {
      await session.initialize(options.signal, this.handshakeTimeoutMs);
      return session;
    } catch (error) {
      await session.cancel().catch(() => undefined);
      if (error instanceof QwenVoiceProviderError) throw error;
      throw new QwenVoiceProviderError("provider_protocol_error");
    }
  }
}

class QwenRealtimeVoiceSession implements StreamingVoiceInputSession {
  public readonly sessionId = randomUUID();
  public readonly events: AsyncIterable<VoiceInputEvent>;
  private readonly channel = new EventChannel<VoiceInputEvent>();
  private readonly cleanups: Array<() => void> = [];
  private readonly itemIds = new Map<string, number>();
  private readonly revisions = new Map<string, number>();
  private readonly chunkDigests = new Map<number, string>();
  private nextChunkSequence = 0;
  private nextSegmentIndex = 0;
  private state: VoiceInputState = "starting";
  private updateResolve: (() => void) | undefined;
  private updateReject: ((error: Error) => void) | undefined;
  private finishPromise: Promise<void> | undefined;
  private terminalResolve: (() => void) | undefined;
  private terminalReject: ((error: Error) => void) | undefined;
  private terminalPromise: Promise<void> | undefined;
  private closed = false;

  public constructor(
    private readonly connection: QwenRealtimeConnection,
    private readonly language: string,
    private readonly finishTimeoutMs: number,
  ) {
    this.events = this.channel;
    this.channel.push({ type: "state_changed", sessionId: this.sessionId, state: "starting" });
    this.cleanups.push(connection.onMessage((message) => this.handleMessage(message)));
    this.cleanups.push(connection.onError(() => this.fail("provider_unavailable")));
    this.cleanups.push(connection.onClose(() => {
      if (!this.closed && !isTerminal(this.state)) this.fail("provider_unavailable");
    }));
  }

  public async initialize(signal: AbortSignal | undefined, timeoutMs: number): Promise<void> {
    const updated = new Promise<void>((resolve, reject) => {
      this.updateResolve = resolve;
      this.updateReject = reject;
    });
    this.connection.send({
      event_id: randomUUID(),
      type: "session.update",
      session: {
        modalities: ["text"],
        input_audio_format: "pcm",
        sample_rate: 16_000,
        input_audio_transcription: { language: this.language },
        turn_detection: null,
      },
    });
    try {
      await withTimeout(updated, timeoutMs, signal);
    } catch {
      throw new QwenVoiceProviderError(signal?.aborted ? "provider_unavailable" : "provider_timeout");
    }
  }

  public async appendAudioChunk(chunk: Pcm16AudioChunk): Promise<void> {
    if (this.state !== "recording") throw new QwenVoiceProviderError("provider_protocol_error");
    if (!Number.isSafeInteger(chunk.sequence) || chunk.sequence < 0 || chunk.sequence >= VOICE_INPUT_MAX_CHUNKS || chunk.data.byteLength === 0
      || chunk.data.byteLength > VOICE_INPUT_MAX_CHUNK_BYTES || chunk.data.byteLength % 2 !== 0) {
      throw new QwenVoiceProviderError("provider_protocol_error");
    }
    const digest = createHash("sha256").update(chunk.data).digest("hex");
    const prior = this.chunkDigests.get(chunk.sequence);
    if (prior !== undefined) {
      if (prior !== digest) throw new QwenVoiceProviderError("provider_protocol_error");
      return;
    }
    if (chunk.sequence !== this.nextChunkSequence) throw new QwenVoiceProviderError("provider_protocol_error");
      this.connection.send({
      event_id: randomUUID(),
      type: "input_audio_buffer.append",
      audio: Buffer.from(chunk.data).toString("base64"),
    });
    this.chunkDigests.set(chunk.sequence, digest);
    this.nextChunkSequence += 1;
  }

  public finish(): Promise<void> {
    if (this.finishPromise !== undefined) return this.finishPromise;
    if (this.state === "finished") return Promise.resolve();
    if (this.state !== "recording") return Promise.reject(new QwenVoiceProviderError("provider_protocol_error"));
    this.transition("finalizing");
    this.terminalPromise = new Promise<void>((resolve, reject) => {
      this.terminalResolve = resolve;
      this.terminalReject = reject;
    });
    this.finishPromise = (async () => {
      try {
        this.connection.send({ event_id: randomUUID(), type: "input_audio_buffer.commit" });
        this.connection.send({ event_id: randomUUID(), type: "session.finish" });
        await withTimeout(this.terminalPromise!, this.finishTimeoutMs);
      } catch {
        if (!isTerminal(this.state)) this.fail("provider_timeout");
        throw new QwenVoiceProviderError("provider_timeout");
      }
    })();
    return this.finishPromise;
  }

  public async cancel(): Promise<void> {
    if (this.state === "cancelled") return;
    if (this.state === "finished" || this.state === "failed") return;
    this.transition("cancelled");
    this.terminalResolve?.();
    this.dispose();
  }

  private handleMessage(raw: unknown): void {
    const message = parseServerEvent(raw);
    if (message === undefined) {
      this.fail("provider_protocol_error");
      return;
    }
    switch (message.type) {
      case "session.updated":
        if (this.state === "starting") {
          this.transition("recording");
          this.updateResolve?.();
          this.updateResolve = undefined;
          this.updateReject = undefined;
        }
        break;
      case "conversation.item.input_audio_transcription.text":
        this.publishTranscript(message, "partial");
        break;
      case "conversation.item.input_audio_transcription.completed":
        this.publishTranscript(message, "final");
        break;
      case "session.finished":
        if (!isTerminal(this.state)) this.transition("finished");
        this.terminalResolve?.();
        this.dispose();
        break;
      case "error":
        this.fail("provider_unavailable");
        break;
      default:
        break;
    }
  }

  private publishTranscript(message: Record<string, unknown>, state: "partial" | "final"): void {
    if (isTerminal(this.state)) return;
    const itemId = typeof message.item_id === "string" ? message.item_id : "item-default";
    const contentIndex = Number.isSafeInteger(message.content_index) ? Number(message.content_index) : 0;
    if (itemId.length === 0 || itemId.length > 128 || contentIndex < 0 || contentIndex > 255) {
      this.fail("provider_protocol_error");
      return;
    }
    const segmentId = itemId + ":" + String(contentIndex);
    let index = this.itemIds.get(segmentId);
    if (index === undefined) {
      index = this.nextSegmentIndex++;
      this.itemIds.set(segmentId, index);
    }
    const revision = (this.revisions.get(segmentId) ?? -1) + 1;
    this.revisions.set(segmentId, revision);
    const partialText = message.text;
    const stash = message.stash === undefined ? "" : message.stash;
    const text = state === "final" ? message.transcript
      : typeof partialText === "string" && typeof stash === "string" ? partialText + stash : undefined;
    if (typeof text !== "string" || text.length > MAX_TRANSCRIPT_CHARS) {
      this.fail("provider_protocol_error");
      return;
    }
    const segment: VoiceTranscriptSegment = { segmentId, index, revision, text, state };
    this.channel.push({ type: "transcript_updated", sessionId: this.sessionId, segment });
  }

  private transition(next: VoiceInputState): void {
    if (isTerminal(this.state)) return;
    this.state = next;
    this.channel.push({ type: "state_changed", sessionId: this.sessionId, state: next });
    if (isTerminal(next)) this.channel.close();
  }

  private fail(code: "provider_unavailable" | "provider_timeout" | "provider_protocol_error"): void {
    if (isTerminal(this.state)) return;
    this.state = "failed";
    this.channel.push({ type: "state_changed", sessionId: this.sessionId, state: "failed", errorCode: code });
    this.channel.close();
    this.updateReject?.(new QwenVoiceProviderError(code));
    this.terminalReject?.(new QwenVoiceProviderError(code));
    this.dispose();
  }

  private dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.chunkDigests.clear();
    this.itemIds.clear();
    this.revisions.clear();
    this.connection.close();
  }
}

class EventChannel<T> implements AsyncIterable<T> {
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

function createNodeWebSocketConnection(url: string, headers: Readonly<Record<string, string>>): QwenRealtimeConnection {
  const socket = new WebSocket(url, { headers: { ...headers }, maxPayload: MAX_SERVER_EVENT_BYTES });
  let readyResolve: () => void = () => undefined;
  let readyReject: (error: Error) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const messages = new Set<(event: unknown) => void>();
  const errors = new Set<() => void>();
  const closes = new Set<() => void>();
  socket.once("open", () => readyResolve());
  socket.once("error", () => {
    readyReject(new Error("websocket unavailable"));
    for (const listener of [...errors]) listener();
  });
  socket.on("message", (data) => { for (const listener of [...messages]) listener(data); });
  socket.on("error", () => { for (const listener of [...errors]) listener(); });
  socket.on("close", () => {
    readyReject(new Error("websocket closed"));
    for (const listener of [...closes]) listener();
  });
  return {
    ready,
    send(event) { socket.send(JSON.stringify(event)); },
    onMessage(listener) { messages.add(listener); return () => messages.delete(listener); },
    onError(listener) { errors.add(listener); return () => errors.delete(listener); },
    onClose(listener) { closes.add(listener); return () => closes.delete(listener); },
    close() {
      try {
        if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
        else if (socket.readyState === WebSocket.OPEN) socket.close();
      } catch {
        // Teardown must not mask the original connect/timeout failure.
      }
    },
  };
}

function parseServerEvent(raw: unknown): Record<string, unknown> | undefined {
  let text: string;
  if (typeof raw === "string") text = raw;
  else if (Buffer.isBuffer(raw)) text = raw.toString("utf8");
  else if (raw instanceof ArrayBuffer) text = new TextDecoder().decode(raw);
  else if (ArrayBuffer.isView(raw)) text = new TextDecoder().decode(raw);
  else return undefined;
  if (Buffer.byteLength(text, "utf8") > MAX_SERVER_EVENT_BYTES) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function validateEndpoint(endpoint: string): string {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error("Qwen realtime ASR endpoint must be a URL."); }
  if (url.protocol !== "wss:" || url.username || url.password || url.hash) {
    throw new Error("Qwen realtime ASR endpoint must use an authenticated wss URL.");
  }
  return url.toString();
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 100 || value > 120_000) throw new Error("Qwen realtime timeout is invalid.");
  return value;
}

function isTerminal(state: VoiceInputState): boolean {
  return state === "finished" || state === "cancelled" || state === "failed";
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("aborted")); return; }
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    const abort = () => reject(new Error("aborted"));
    signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    promise.then((value) => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error); });
  });
}

export function createQwenRealtimeVoiceProvider(options: QwenRealtimeProviderOptions): StreamingVoiceInputProvider {
  return new QwenRealtimeVoiceProvider(options);
}
