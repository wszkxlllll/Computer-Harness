import type { ActionGuardActionSummary, RuntimeEvent, ToolCallId } from "@computer-harness/protocol";
import type { RemoteApprovalActionPreview, RemoteApprovalPreview } from "./remote-control.js";

const MAX_PREVIEW_ACTIONS = 16;
const MAX_PREVIEW_KEYS = 8;

/** Build a safe, request-bound preview from the already committed Runtime events. */
export function projectApprovalPreview(
  events: readonly RuntimeEvent[],
  requestId: string,
  callId: ToolCallId,
): RemoteApprovalPreview | undefined {
  const approvalIndex = events.findIndex((event) =>
    event.type === "approval.requested" && event.requestId === requestId && event.callId === callId,
  );
  if (approvalIndex < 0) return undefined;

  let receivedEvent: Extract<RuntimeEvent, { type: "tool.call.received" }> | undefined;
  for (let index = approvalIndex - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === "tool.call.received" && event.call.id === callId) {
      receivedEvent = event;
      break;
    }
  }
  if (receivedEvent === undefined) return undefined;

  let guardEvent: Extract<RuntimeEvent, { type: "action.guard.evaluated" }> | undefined;
  for (let index = approvalIndex - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === "action.guard.evaluated" &&
        event.decision === "require_approval" &&
        event.callIds.includes(callId) &&
        event.sequence > receivedEvent.sequence) {
      guardEvent = event;
      break;
    }
  }
  if (guardEvent === undefined || guardEvent.callIds.length !== guardEvent.actions.length) return undefined;

  const guardedCallIds = new Set(guardEvent.callIds);
  const receivedByCallId = new Map<ToolCallId, Extract<RuntimeEvent, { type: "tool.call.received" }>>();
  for (const event of events) {
    if (event.sequence >= guardEvent.sequence) break;
    if (event.type === "tool.call.received" && guardedCallIds.has(event.call.id)) receivedByCallId.set(event.call.id, event);
  }
  if (guardEvent.callIds.some((guardedCallId) => !receivedByCallId.has(guardedCallId))) return undefined;

  const actions: RemoteApprovalActionPreview[] = [];
  for (let index = 0; index < guardEvent.callIds.length && index < MAX_PREVIEW_ACTIONS; index += 1) {
    const action = guardEvent.actions[index];
    const guardedCall = receivedByCallId.get(guardEvent.callIds[index]!);
    if (action === undefined || guardedCall === undefined) return undefined;
    actions.push(projectApprovalAction(guardedCall.call.name, action));
  }
  if (actions.length === 0) return undefined;

  const target = boundedText(receivedEvent.call.declaredEffect?.target, 256);
  const summary = boundedText(receivedEvent.call.declaredEffect?.summary, 512);
  return {
    actions,
    ...(target === undefined || summary === undefined
      ? {}
      : { modelDeclaredEffect: { target, summary, verified: false as const } }),
  };
}

function projectApprovalAction(operation: string, action: ActionGuardActionSummary): RemoteApprovalActionPreview {
  const points: Array<{ x: number; y: number }> = [];
  if (action.kind === "click" || action.kind === "double_click" || action.kind === "right_click" || action.kind === "scroll") {
    const point = safeApprovalPoint(action.point);
    if (point !== undefined) points.push(point);
  } else if (action.kind === "drag") {
    const from = safeApprovalPoint(action.from);
    const to = safeApprovalPoint(action.to);
    if (from !== undefined) points.push(from);
    if (to !== undefined) points.push(to);
  }

  const keys = action.kind === "keypress"
    ? action.keys.slice(0, MAX_PREVIEW_KEYS).flatMap((key) => {
        const bounded = boundedText(key, 32);
        return bounded === undefined ? [] : [bounded];
      })
    : [];
  const typedCharacterCount = action.kind === "type" && Number.isSafeInteger(action.textLength) && action.textLength >= 0
    ? action.textLength
    : undefined;
  return {
    operation: boundedText(operation, 64) ?? action.kind,
    kind: action.kind,
    ...(points.length === 0 ? {} : { points }),
    ...(keys.length === 0 ? {} : { keys }),
    ...(typedCharacterCount === undefined ? {} : { typedCharacterCount }),
  };
}

function safeApprovalPoint(point: { readonly x: number; readonly y: number }): { x: number; y: number } | undefined {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.abs(point.x) > 100_000 || Math.abs(point.y) > 100_000) return undefined;
  return { x: point.x, y: point.y };
}

function boundedText(value: string | undefined, maxChars: number): string | undefined {
  if (value === undefined) return undefined;
  const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "").slice(0, maxChars);
  return clean.length === 0 ? undefined : clean;
}
