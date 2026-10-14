import type { PendingRequestBase, RunSnapshot } from "./types";

export type WebRunCommand = Record<string, unknown> & { expectedSequence: number; type: string };

export function approvalCommand(snapshot: RunSnapshot, requestId: string, approved: boolean): WebRunCommand | undefined {
  const pending = snapshot.pendingRequest;
  if (!pending || pending.kind !== "approval" || pending.requestId !== requestId || snapshot.capabilities.approval !== true) return undefined;
  return {
    expectedSequence: snapshot.sequence,
    type: approved ? "approve" : "reject",
    requestId: pending.requestId,
  };
}

export function responseCommand(snapshot: RunSnapshot, requestId: string, text: string): WebRunCommand | undefined {
  const pending = snapshot.pendingRequest;
  if (!pending || pending.kind !== "user_input" || pending.requestId !== requestId || !text.trim()) return undefined;
  return { expectedSequence: snapshot.sequence, type: "respond", requestId: pending.requestId, text: text.trim() };
}

export function windowChoiceCommand(snapshot: RunSnapshot, requestId: string, candidateToken: string, previewToken?: string): WebRunCommand | undefined {
  const pending = snapshot.pendingRequest;
  const candidate = pending?.candidates?.find((item) => item.token === candidateToken);
  if (!pending || pending.kind !== "window_handoff" || pending.requestId !== requestId || candidate === undefined || snapshot.capabilities.windowHandoff !== true ||
      candidate.previewRequired === true && (previewToken === undefined || !/^[A-Za-z0-9_-]{32}$/u.test(previewToken))) return undefined;
  return { expectedSequence: snapshot.sequence, type: "window.confirm", requestId: pending.requestId, candidateToken, ...(previewToken === undefined ? {} : { previewToken }) };
}

export function ignoreWindowCommand(snapshot: RunSnapshot, requestId: string): WebRunCommand | undefined {
  const pending = snapshot.pendingRequest;
  if (!pending || pending.kind !== "window_handoff" || pending.requestId !== requestId || pending.reasonCode !== "new_window_detected" || snapshot.capabilities.windowHandoff !== true) return undefined;
  return { expectedSequence: snapshot.sequence, type: "window.ignore", requestId: pending.requestId };
}

export function correctionCommand(snapshot: RunSnapshot, text: string): WebRunCommand | undefined {
  if (snapshot.pendingRequest || snapshot.capabilities.correct !== true || !text.trim()) return undefined;
  return { expectedSequence: snapshot.sequence, type: "correct", text: text.trim() };
}

export function controlCommand(snapshot: RunSnapshot, type: "pause" | "resume" | "abort"): WebRunCommand | undefined {
  if (snapshot.capabilities[type] !== true) return undefined;
  return { expectedSequence: snapshot.sequence, type };
}

export function canIgnoreWindow(request: PendingRequestBase): boolean {
  return request.kind === "window_handoff" && request.reasonCode === "new_window_detected";
}
