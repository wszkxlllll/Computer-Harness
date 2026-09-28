/**
 * Provider-neutral contracts for a single user-controlled voice interaction.
 * Browser/Host capture and speech services implement these interfaces; the
 * Runtime and Guard intentionally do not depend on this package.
 */

export type VoiceInputState = "starting" | "recording" | "finalizing" | "finished" | "cancelled" | "failed";

/** Shared upload contract limits. Four maximum-sized chunks stay below the Relay's 32 KiB JSON request bound. */
export const VOICE_INPUT_SAMPLE_RATE = 16_000;
export const VOICE_INPUT_RECOMMENDED_CHUNK_BYTES = 3_200;
export const VOICE_INPUT_MAX_CHUNK_BYTES = 4_096;
export const VOICE_INPUT_MAX_BATCH_CHUNKS = 4;
export const VOICE_INPUT_MAX_BATCH_BYTES = VOICE_INPUT_MAX_CHUNK_BYTES * VOICE_INPUT_MAX_BATCH_CHUNKS;
export const VOICE_INPUT_MAX_DURATION_MS = 60_000;
export const VOICE_INPUT_MAX_AUDIO_BYTES = VOICE_INPUT_SAMPLE_RATE * 2 * 60;
/** Transport sequence ceiling; the byte and elapsed-time budgets remain authoritative session limits. */
export const VOICE_INPUT_MAX_CHUNKS = 1_200;

/**
 * One stable transcript segment. Providers may update it with a higher
 * revision; a `final` segment does not finish the recording session.
 */
export interface VoiceTranscriptSegment {
  readonly segmentId: string;
  readonly index: number;
  readonly revision: number;
  readonly text: string;
  readonly state: "partial" | "final";
}

export type VoiceInputEvent =
  | { readonly type: "state_changed"; readonly sessionId: string; readonly state: VoiceInputState; readonly errorCode?: string }
  | { readonly type: "transcript_updated"; readonly sessionId: string; readonly segment: VoiceTranscriptSegment };

/**
 * A caller invokes `finish()` to stop capture and flush recognition. It must
 * keep consuming `events` until a terminal state event arrives; one final
 * transcript segment is not a session terminal event. `cancel()` discards
 * unfinished recognition and is idempotent.
 */
export interface VoiceInputSession {
  readonly sessionId: string;
  readonly events: AsyncIterable<VoiceInputEvent>;
  finish(): Promise<void>;
  cancel(): Promise<void>;
}

export interface VoiceInputAdapter {
  start(options?: { readonly signal?: AbortSignal }): Promise<VoiceInputSession>;
}

/** One ordered mono PCM16 audio block at 16 kHz. Treat `data` as borrowed and do not retain it. */
export interface Pcm16AudioChunk {
  readonly sequence: number;
  readonly data: Uint8Array;
}

export type VoiceCaptureEvent =
  | { readonly type: "audio_chunk"; readonly chunk: Pcm16AudioChunk }
  | { readonly type: "capture_stopped" }
  | { readonly type: "capture_failed"; readonly errorCode: string };

/** Platform-owned microphone capture. Implementations must not persist raw audio. */
export interface VoiceAudioCaptureSession {
  readonly events: AsyncIterable<VoiceCaptureEvent>;
  stop(): Promise<void>;
  cancel(): Promise<void>;
}

export interface VoiceAudioCaptureAdapter {
  start(options?: { readonly signal?: AbortSignal }): Promise<VoiceAudioCaptureSession>;
}

/** Streaming recognition adds audio input to the compatible transcript session contract. */
export interface StreamingVoiceInputSession extends VoiceInputSession {
  appendAudioChunk(chunk: Pcm16AudioChunk): Promise<void>;
}

export interface StreamingVoiceInputProvider {
  /** Stable provider identifier used by Host capability discovery. */
  readonly providerId: string;
  capabilities(): VoiceInputCapabilities;
  start(options?: { readonly signal?: AbortSignal }): Promise<StreamingVoiceInputSession>;
}

export interface VoiceInputCapabilities {
  readonly available: boolean;
  readonly provider?: string;
  readonly sampleRate?: 16_000;
  readonly channels?: 1;
  readonly chunkBytes?: number;
  readonly maxDurationMs?: number;
  readonly unavailableReason?: "not_configured" | "provider_unavailable";
}

export interface VoiceSessionEventEnvelope {
  readonly sequence: number;
  readonly event: VoiceInputEvent;
}

export interface VoiceSessionUpdate {
  readonly sessionId: string;
  readonly events: readonly VoiceSessionEventEnvelope[];
  readonly eventCursor: number;
  readonly acceptedAudioBytes?: number;
  /** Highest sequence accepted by the last audio batch. */
  readonly acceptedSequence?: number;
  /** True only when every submitted chunk was an already accepted identical retry. */
  readonly duplicate?: boolean;
}

/** Host-side owner of paired-device voice sessions; never a Runtime/Computer dependency. */
export interface VoiceInputSessionService {
  capabilities(): VoiceInputCapabilities;
  start(deviceId: string, requestId: string): Promise<VoiceSessionUpdate>;
  append(
    deviceId: string,
    sessionId: string,
    chunks: readonly Pcm16AudioChunk[],
    afterEventSequence: number,
  ): Promise<VoiceSessionUpdate>;
  finish(deviceId: string, sessionId: string, afterEventSequence: number): Promise<VoiceSessionUpdate>;
  cancel(deviceId: string, sessionId: string, afterEventSequence: number): Promise<VoiceSessionUpdate>;
  cancelDevice(deviceId: string): Promise<void>;
  close(): Promise<void>;
}

export type VoiceOutputCancelReason = "user" | "interrupted" | "run_changed" | "failed";

export interface VoiceTextChunk {
  /** Stable producer ID, normally the RunNotice ID. */
  readonly chunkId: string;
  /** Monotonic within one output session. */
  readonly sequence: number;
  readonly text: string;
}

/**
 * An output session accepts text incrementally so an adapter can begin TTS
 * before the whole response is available. `cancel()` must stop generation and
 * playback where the provider permits; `finish()` drains accepted chunks.
 */
export interface VoiceOutputSession {
  enqueueText(chunk: VoiceTextChunk): Promise<void>;
  finish(): Promise<void>;
  cancel(reason: VoiceOutputCancelReason): Promise<void>;
}

export type VoiceSpeechRate = 0.85 | 1 | 1.15;

export interface VoiceOutputAdapter {
  openSession(options?: { readonly signal?: AbortSignal; readonly speechRate?: VoiceSpeechRate }): Promise<VoiceOutputSession>;
}
