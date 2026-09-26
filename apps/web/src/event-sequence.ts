export type SequenceDecision = "duplicate" | "next" | "gap";

export function decideSequence(lastSequence: number, incomingSequence: number): SequenceDecision {
  if (!Number.isSafeInteger(incomingSequence) || incomingSequence <= lastSequence) return "duplicate";
  if (lastSequence >= 0 && incomingSequence > lastSequence + 1) return "gap";
  return "next";
}

export function reconnectCursor(snapshotSequence: number): number {
  return Number.isSafeInteger(snapshotSequence) && snapshotSequence >= 0 ? snapshotSequence : 0;
}
