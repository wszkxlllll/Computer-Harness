import type { VoiceInputEvent, VoiceInputState, VoiceTranscriptSegment } from "./contracts.js";

export interface VoiceTranscriptState {
  readonly sessionId: string;
  readonly status: VoiceInputState;
  readonly segments: readonly VoiceTranscriptSegment[];
  readonly errorCode?: string;
}

export function createVoiceTranscriptState(sessionId: string): VoiceTranscriptState {
  if (sessionId.trim().length === 0) throw new Error("voice sessionId must not be empty");
  return { sessionId, status: "starting", segments: [] };
}

/**
 * Consume one adapter event without allowing stale sessions, old revisions,
 * or post-terminal transcript updates to rewrite the user's editable text.
 */
export function reduceVoiceInputEvent(state: VoiceTranscriptState, event: VoiceInputEvent): VoiceTranscriptState {
  if (event.sessionId !== state.sessionId || isTerminal(state.status)) return state;

  if (event.type === "transcript_updated") {
    if (state.status !== "recording" && state.status !== "finalizing") return state;
    validateSegment(event.segment);
    const current = state.segments.find((segment) => segment.segmentId === event.segment.segmentId);
    if (current !== undefined && (current.index !== event.segment.index || event.segment.revision <= current.revision)) return state;
    if (current?.state === "final" && event.segment.state === "partial") return state;
    if (current === undefined && state.segments.some((segment) => segment.index === event.segment.index)) return state;
    const segments = current === undefined
      ? [...state.segments, structuredClone(event.segment)]
      : state.segments.map((segment) => segment.segmentId === event.segment.segmentId ? structuredClone(event.segment) : segment);
    segments.sort((left, right) => left.index - right.index);
    return { ...state, segments };
  }

  if (!isValidTransition(state.status, event.state)) return state;
  return {
    sessionId: state.sessionId,
    status: event.state,
    segments: state.segments,
    ...(event.state === "failed" && event.errorCode !== undefined ? { errorCode: event.errorCode } : {}),
  };
}

export function transcriptText(state: VoiceTranscriptState): string {
  return state.segments.map((segment) => segment.text).join("").trim();
}

function validateSegment(segment: VoiceTranscriptSegment): void {
  if (segment.segmentId.trim().length === 0) throw new Error("transcript segmentId must not be empty");
  if (!Number.isSafeInteger(segment.index) || segment.index < 0) throw new Error("transcript segment index must be a non-negative integer");
  if (!Number.isSafeInteger(segment.revision) || segment.revision < 0) throw new Error("transcript segment revision must be a non-negative integer");
  if (typeof segment.text !== "string") throw new Error("transcript segment text must be a string");
}

function isTerminal(state: VoiceInputState): boolean {
  return state === "finished" || state === "cancelled" || state === "failed";
}

function isValidTransition(current: VoiceInputState, next: VoiceInputState): boolean {
  const valid: Readonly<Record<VoiceInputState, readonly VoiceInputState[]>> = {
    starting: ["recording", "finalizing", "cancelled", "failed"],
    recording: ["finalizing", "cancelled", "failed"],
    finalizing: ["finished", "cancelled", "failed"],
    finished: [],
    cancelled: [],
    failed: [],
  };
  return valid[current].includes(next);
}
