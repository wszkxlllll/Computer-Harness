/**
 * Provider-neutral contracts for a single user-controlled voice interaction.
 * Browser/Host capture and speech services implement these interfaces; the
 * Runtime and Guard intentionally do not depend on this package.
 */

export type VoiceInputState = "starting" | "recording" | "finalizing" | "finished" | "cancelled" | "failed";

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

export interface VoiceOutputAdapter {
  openSession(options?: { readonly signal?: AbortSignal }): Promise<VoiceOutputSession>;
}
