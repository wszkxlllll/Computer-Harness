import type { ActionGuardActionSummary, RiskCategory, RuntimeEvent, ToolCallId } from "@computer-harness/protocol";
import type { RemoteApprovalActionPreview, RemoteApprovalEvidence, RemoteApprovalPreview } from "./remote-control.js";

const MAX_PREVIEW_ACTIONS = 16;
const MAX_PREVIEW_KEYS = 8;

export interface ApprovalVoiceContext {
  readonly categories: readonly RiskCategory[];
  readonly reasonCode: string;
  readonly actionKind?: ActionGuardActionSummary["kind"];
}

/** Build private speech context from the Guard record for this exact approval call. */
export function projectApprovalVoiceContext(
  events: readonly RuntimeEvent[],
  requestId: string,
  callId: ToolCallId,
): ApprovalVoiceContext | undefined {
  const approvalIndex = events.findIndex((event) =>
    event.type === "approval.requested" && event.requestId === requestId && event.callId === callId,
  );
  const approvalEvent = events[approvalIndex];
  if (approvalEvent?.type !== "approval.requested") return undefined;

  for (let index = approvalIndex - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== "action.guard.evaluated" || event.decision !== "require_approval"
      || event.sequence >= approvalEvent.sequence) continue;
    const matchingCallIndices = event.callIds.flatMap((candidate, candidateIndex) => candidate === callId ? [candidateIndex] : []);
    if (matchingCallIndices.length === 0) continue;
    if (matchingCallIndices.length !== 1) return undefined;
    const callIndex = matchingCallIndices[0]!;
    const action = event.callIds.length === event.actions.length ? event.actions[callIndex] : undefined;
    return {
      categories: [...event.categories],
      reasonCode: event.reasonCode,
      ...(action === undefined ? {} : { actionKind: action.kind }),
    };
  }
  return undefined;
}

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
  const approvalEvent = events[approvalIndex];
  if (approvalEvent?.type !== "approval.requested") return undefined;

  let receivedEvent: Extract<RuntimeEvent, { type: "tool.call.received" }> | undefined;
  for (let index = approvalIndex - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === "tool.call.received" && event.call.id === callId) {
      receivedEvent = event;
      break;
    }
  }
  if (receivedEvent === undefined) return undefined;

  const actionEntries: Array<{ operation: string; action: ActionGuardActionSummary }> = [];
  if (approvalEvent.actions !== undefined && approvalEvent.actions.length > 0) {
    for (const action of approvalEvent.actions.slice(0, MAX_PREVIEW_ACTIONS)) {
      actionEntries.push({ operation: receivedEvent.call.name, action });
    }
  } else {
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

    for (let index = 0; index < guardEvent.callIds.length && index < MAX_PREVIEW_ACTIONS; index += 1) {
      const action = guardEvent.actions[index];
      const guardedCall = receivedByCallId.get(guardEvent.callIds[index]!);
      if (action === undefined || guardedCall === undefined) return undefined;
      actionEntries.push({ operation: guardedCall.call.name, action });
    }
  }
  if (actionEntries.length === 0) return undefined;

  const actions = actionEntries.map(({ operation, action }) =>
    projectApprovalAction(operation, action),
  );
  const evidence = approvalEvent.evidence === undefined
    ? undefined
    : projectApprovalEvidence(approvalEvent.evidence, events, approvalEvent.sequence, actionEntries);

  const target = boundedText(receivedEvent.call.declaredEffect?.target, 256);
  const summary = boundedText(receivedEvent.call.declaredEffect?.summary, 512);
  return {
    actions,
    ...(evidence === undefined ? {} : { evidence }),
    ...(target === undefined || summary === undefined
      ? {}
      : { modelDeclaredEffect: { target, summary, verified: false as const } }),
  };
}

/**
 * Classify approval using the committed Runtime request, not preview success.
 * Legacy or contradictory records are treated as computer actions so a broken
 * preview can never turn an unknown approval into an approvable non-computer request.
 */
export function approvalRequiresVisualReview(
  events: readonly RuntimeEvent[],
  requestId: string,
  callId: ToolCallId,
): boolean {
  const approval = events.find((event) =>
    event.type === "approval.requested" && event.requestId === requestId && event.callId === callId,
  );
  if (approval?.type !== "approval.requested") return true;
  const guardedComputerCall = events.some((event) =>
    event.type === "action.guard.evaluated"
    && event.sequence < approval.sequence
    && event.callIds.includes(callId),
  );
  if (guardedComputerCall) return true;
  if (approval.requiresVisualReview === true) return true;
  if (approval.requiresVisualReview === false && approval.evidence === undefined && approval.actions === undefined) return false;
  return true;
}

function projectApprovalEvidence(
  evidence: NonNullable<Extract<RuntimeEvent, { type: "approval.requested" }>["evidence"]>,
  events: readonly RuntimeEvent[],
  approvalSequence: number,
  actionEntries: readonly { action: ActionGuardActionSummary }[],
): RemoteApprovalEvidence | undefined {
  const evidenceEvent = events.find((event): event is Extract<RuntimeEvent, { type: "observation.created" }> =>
    event.type === "observation.created" && event.observation.id === evidence.observationId,
  );
  const decisionEvent = events.find((event): event is Extract<RuntimeEvent, { type: "observation.created" }> =>
    event.type === "observation.created" && event.observation.id === evidence.decisionObservationId,
  );
  const evidenceObservation = evidenceEvent?.observation;
  const decisionObservation = decisionEvent?.observation;
  if (evidenceEvent === undefined || decisionEvent === undefined
    || evidenceObservation === undefined || decisionObservation === undefined
    || evidenceEvent.sequence >= approvalSequence
    || decisionEvent.sequence >= evidenceEvent.sequence
    || evidenceObservation.computerSessionId !== decisionObservation.computerSessionId
    || evidenceObservation.screenshot.assetId !== evidence.assetId
    || evidenceObservation.capturedAt !== evidence.capturedAt
    || !sameViewport(evidenceObservation.viewport, evidence.viewport)) {
    return undefined;
  }
  const actionBasedOn = actionEntries[0]?.action;
  if (actionBasedOn !== undefined && "basedOn" in actionBasedOn && actionBasedOn.basedOn !== evidence.decisionObservationId) {
    return undefined;
  }
  const assetId = boundedText(String(evidence.assetId), 128);
  const observationId = boundedText(String(evidence.observationId), 128);
  const decisionObservationId = boundedText(String(evidence.decisionObservationId), 128);
  const capturedAt = boundedText(evidence.capturedAt, 64);
  if (assetId === undefined || observationId === undefined || decisionObservationId === undefined || capturedAt === undefined) return undefined;
  return {
    assetId: assetId as RemoteApprovalEvidence["assetId"],
    observationId: observationId as RemoteApprovalEvidence["observationId"],
    decisionObservationId: decisionObservationId as RemoteApprovalEvidence["decisionObservationId"],
    capturedAt,
    viewport: { ...evidenceObservation.viewport },
  };
}

function sameViewport(
  left: { readonly width: number; readonly height: number; readonly coordinateSpace: string },
  right: { readonly width: number; readonly height: number; readonly coordinateSpace: string },
): boolean {
  return left.width === right.width && left.height === right.height && left.coordinateSpace === right.coordinateSpace;
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
