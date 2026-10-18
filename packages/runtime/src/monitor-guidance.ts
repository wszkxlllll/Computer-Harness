import type { ActionEffectDeclaration, ActionIntent, EventId, ObservationFrame, RunId, RuntimeEvent } from "@computer-harness/protocol";
import { declaredEffectSignature, type ProgressMonitorOutput } from "./progress-monitor.js";
import { currentObservationAssessmentBinding, parseObservationAssessment } from "./observation-assessment.js";

export interface MonitorGuidanceProjection {
  readonly text: string;
  readonly sourceEventIds: readonly EventId[];
}

export function projectMonitorCandidateGuidance(input: {
  readonly event: RuntimeEvent;
  readonly output: ProgressMonitorOutput;
  readonly events: readonly RuntimeEvent[];
  readonly runId: RunId;
  readonly latestObservation?: ObservationFrame;
}): MonitorGuidanceProjection {
  const sourceEvents = input.events.filter((event) => event.runId === input.runId);
  const repeatedEffect = projectRepeatedDeclaredEffectGuidance(
    sourceEvents,
    input.runId,
    input.latestObservation,
    input.output.reasons.find((reason) => reason.code === "repeated_declared_effect")?.eventIds,
    input.event.eventId,
  );
  if (repeatedEffect !== undefined) return repeatedEffect;

  const assessed = projectRecentAssessmentGuidance(sourceEvents, input.runId, input.latestObservation);
  if (assessed !== undefined) return assessed;

  const currentAction = projectCurrentMonitorGuidance(sourceEvents, input.runId, input.latestObservation);
  if (currentAction !== undefined) return currentAction;

  if (input.event.type === "action.execution.completed" && input.event.receipt.status === "completed") {
    const completedActionId = input.event.receipt.actionId;
    const action = sourceEvents.find((event): event is Extract<RuntimeEvent, { type: "action.proposed" }> =>
      event.type === "action.proposed" && event.action.actionId === completedActionId,
    );
    if (action !== undefined && action.action.kind !== "wait") {
      return {
        text: `A repeated ${action.action.kind} action was dispatched. Check the next fresh image to see whether the intended result appears before choosing a follow-up.`,
        sourceEventIds: [...new Set([...candidateSourceEventIds(input.event, input.output), action.eventId])].slice(-12),
      };
    }
  }

  return {
    text: "Monitor evidence is incomplete for this action. Inspect the newest image and choose the next step from visible state; do not infer that the action was missed.",
    sourceEventIds: candidateSourceEventIds(input.event, input.output),
  };
}

/** Reuses a prior assessment only while its unchanged observation chain is current on one Surface. */
export function projectRecentAssessmentGuidance(
  events: readonly RuntimeEvent[],
  runId: RunId,
  latestObservation: ObservationFrame | undefined,
): MonitorGuidanceProjection | undefined {
  if (latestObservation === undefined) return undefined;
  const runEvents = events.filter((event) => event.runId === runId);
  const boundarySequence = latestAttemptBoundarySequence(runEvents, runId);
  const response = [...runEvents].reverse().find((event): event is Extract<RuntimeEvent, { type: "model.response.received" }> =>
    event.type === "model.response.received" && event.turn.observationAssessment !== undefined
    && event.sequence > boundarySequence,
  );
  if (response === undefined) return undefined;
  const assessment = parseObservationAssessment(response.turn.observationAssessment);
  if (assessment === undefined || response.runId !== runId) return undefined;

  const sourceEvents = runEvents.filter((event) => event.sequence <= response.sequence);
  const binding = currentObservationAssessmentBinding(sourceEvents);
  if (binding === undefined || binding.observationId !== assessment.observationId || binding.actionId !== assessment.actionId) return undefined;
  const action = sourceEvents.find((event): event is Extract<RuntimeEvent, { type: "action.proposed" }> =>
    event.type === "action.proposed" && event.action.actionId === assessment.actionId && event.sequence > boundarySequence,
  );
  const receipt = sourceEvents.find((event): event is Extract<RuntimeEvent, { type: "action.execution.completed" | "action.execution.failed" }> =>
    (event.type === "action.execution.completed" || event.type === "action.execution.failed")
    && event.receipt.actionId === assessment.actionId,
  );
  const preObservation = action === undefined || action.action.kind === "wait" ? undefined : observationEvent(sourceEvents, action.action.basedOn, runId);
  const assessedObservation = observationEvent(sourceEvents, assessment.observationId, runId);
  const sourceTransition = sourceEvents.find((event): event is Extract<RuntimeEvent, { type: "monitor.transition" }> =>
    event.type === "monitor.transition" && event.actionId === assessment.actionId
    && event.postObservationId === assessment.observationId && event.transition === binding.transition,
  );
  if (action === undefined || action.action.kind === "wait" || receipt?.type !== "action.execution.completed"
    || preObservation === undefined || assessedObservation === undefined || sourceTransition === undefined
    || binding.transition === undefined
    || sourceTransition.preObservationId !== preObservation.observation.id
    || !sameObservationPartition(preObservation.observation, assessedObservation.observation)) return undefined;

  const currentObservationEvent = observationEvent(runEvents, latestObservation.id, runId);
  if (currentObservationEvent === undefined || !sameObservationPartition(assessedObservation.observation, latestObservation)) return undefined;
  const interveningActions = runEvents.filter((event): event is Extract<RuntimeEvent, { type: "action.proposed" }> =>
    event.type === "action.proposed" && event.sequence > response.sequence,
  );
  const interveningTransitions = runEvents.filter((event): event is Extract<RuntimeEvent, { type: "monitor.transition" }> =>
    event.type === "monitor.transition" && event.sequence > response.sequence,
  );
  if (interveningActions.length !== interveningTransitions.length
    || runEvents.some((event) => event.sequence > response.sequence
      && (event.type === "user.input.received" || event.type === "computer.window.handoff.requested"
        || event.type === "computer.window.handoff.completed" || event.type === "computer.window.handoff.ignored"))) return undefined;

  let cursor = assessedObservation.observation;
  const intermediateIds: EventId[] = [];
  for (const transition of interveningTransitions) {
    if (transition.transition !== "unchanged" || transition.preObservationId !== cursor.id) return undefined;
    const proposal = interveningActions.find((candidate) => candidate.action.actionId === transition.actionId);
    const receiptEvent = eventById(events, transition.sourceActionEventId);
      const postObservation = observationEvent(runEvents, transition.postObservationId, runId);
    if (proposal === undefined || proposal.action.kind === "wait" || proposal.action.basedOn !== cursor.id
      || receiptEvent?.type !== "action.execution.completed" || receiptEvent.receipt.status !== "completed"
      || receiptEvent.receipt.actionId !== proposal.action.actionId || postObservation === undefined
        || proposal.sequence <= response.sequence || proposal.sequence >= receiptEvent.sequence
        || receiptEvent.sequence >= postObservation.sequence || postObservation.sequence >= transition.sequence
      || postObservation.eventId !== transition.sourceObservationEventId
      || !sameObservationPartition(cursor, postObservation.observation)) return undefined;
    intermediateIds.push(proposal.eventId, receiptEvent.eventId, postObservation.eventId, transition.eventId);
    cursor = postObservation.observation;
  }
  if (cursor.id !== latestObservation.id) return undefined;
  const latestInterveningTransition = interveningTransitions.at(-1);
  const latestInterveningAction = latestInterveningTransition === undefined
    ? undefined
    : interveningActions.find((candidate) => candidate.action.actionId === latestInterveningTransition.actionId);

  const essentialIds = [
    response.eventId,
    action.eventId,
    receipt.eventId,
    preObservation.eventId,
    assessedObservation.eventId,
    sourceTransition.eventId,
    currentObservationEvent.eventId,
    ...interveningTransitions.slice(-1).flatMap((transition) => [
      transition.sourceActionEventId,
      transition.sourceObservationEventId,
      transition.eventId,
    ]),
  ];
  const sourceEventIds = [...new Set([...essentialIds, ...intermediateIds])].slice(0, 12);
  if (assessment.actionOutcome === "no_effect" && binding.transition === "unchanged") {
    const evidenceQuote = boundedAssessmentEvidence(assessment.evidence, action.action);
    const chained = interveningTransitions.length > 0;
    const prefix = action.action.kind === "type"
      ? chained
        ? `${latestInterveningAction?.action.kind ?? "GUI action"} dispatched; newest screenshot unchanged. Earlier model report (untrusted; unverified):`
        : "Type dispatched; image unchanged. Earlier model report (untrusted; unverified):"
      : chained
        ? `${latestInterveningAction?.action.kind ?? "GUI action"} dispatched; newest screenshot unchanged. Earlier model report (untrusted; unverified):`
        : `${action.action.kind} dispatched; image unchanged. Earlier model report (untrusted; unverified):`;
    const suffix = chained
      ? " Check newest image: is the reported issue resolved? Continue or change method."
      : " Check newest image: is it resolved? Then continue or change method.";
    return { text: composeBoundedHint(prefix, evidenceQuote, suffix), sourceEventIds };
  }
  if (assessment.actionOutcome === "unexpected_change" && binding.transition === "changed" && interveningTransitions.length === 0) {
    return {
      text: "The newest screenshot changed after the preceding action. Inspect what is visible before deciding what it means; a changed screen does not confirm the requested result.",
      sourceEventIds,
    };
  }
  return undefined;
}

export function projectCurrentMonitorGuidance(
  events: readonly RuntimeEvent[],
  runId: RunId,
  latestObservation: ObservationFrame | undefined,
): MonitorGuidanceProjection | undefined {
  if (latestObservation === undefined) return undefined;
  const runEvents = events.filter((event) => event.runId === runId);
  const repeatedEffect = projectRepeatedDeclaredEffectGuidance(runEvents, runId, latestObservation);
  if (repeatedEffect !== undefined) return repeatedEffect;
  const assessmentGuidance = projectRecentAssessmentGuidance(runEvents, runId, latestObservation);
  if (assessmentGuidance !== undefined) return assessmentGuidance;
  const binding = currentObservationAssessmentBinding(runEvents);
  if (binding?.observationId !== latestObservation.id || binding.transition !== "unchanged") return undefined;
  const proposal = runEvents.find((event): event is Extract<RuntimeEvent, { type: "action.proposed" }> =>
    event.type === "action.proposed" && event.action.actionId === binding.actionId
    && event.sequence > latestAttemptBoundarySequence(runEvents, runId),
  );
  if (proposal === undefined || proposal.action.kind === "wait") return undefined;
  const receipt = runEvents.find((event): event is Extract<RuntimeEvent, { type: "action.execution.completed" }> =>
    event.type === "action.execution.completed" && event.receipt.actionId === binding.actionId && event.receipt.status === "completed",
  );
  const transition = runEvents.find((event): event is Extract<RuntimeEvent, { type: "monitor.transition" }> =>
    event.type === "monitor.transition" && event.actionId === binding.actionId
    && event.postObservationId === latestObservation.id && event.transition === "unchanged",
  );
  const preObservation = observationEvent(runEvents, proposal.action.basedOn, runId);
  const postObservation = observationEvent(runEvents, latestObservation.id, runId);
  if (receipt === undefined || transition === undefined || preObservation === undefined || postObservation === undefined
    || !sameObservationPartition(preObservation.observation, postObservation.observation)) return undefined;
  return {
    text: `A ${proposal.action.kind} action was dispatched; the screenshot appeared unchanged. Check the newest image to see whether the intended result is visible, then continue or choose another method.`,
    sourceEventIds: [proposal.eventId, receipt.eventId, preObservation.eventId, postObservation.eventId, transition.eventId],
  };
}

function projectRepeatedDeclaredEffectGuidance(
  events: readonly RuntimeEvent[],
  runId: RunId,
  latestObservation: ObservationFrame | undefined,
  reasonEventIds?: readonly EventId[],
  currentEventId?: EventId,
): MonitorGuidanceProjection | undefined {
  const boundarySequence = latestAttemptBoundarySequence(events, runId);
  const currentEpisodeActions = events.filter((event): event is Extract<RuntimeEvent, { type: "action.proposed" }> =>
    event.type === "action.proposed" && event.sequence > boundarySequence,
  );
  const actionEvents = reasonEventIds === undefined
    ? currentEpisodeActions.slice(-3)
    : reasonEventIds.flatMap((id) => {
        const event = eventById(events, id);
        return event?.type === "action.proposed" && event.sequence > boundarySequence ? [event] : [];
      });
  if (reasonEventIds !== undefined && actionEvents.length !== reasonEventIds.length) return undefined;
  if (actionEvents.length < 2 || actionEvents.some((event) => event.runId !== runId || event.action.kind !== "click")) return undefined;

  const declarations = actionEvents.map((actionEvent) => declaredEffectForAction(events, actionEvent));
  const signatures = declarations.map((declaration, index) => {
    const action = actionEvents[index];
    return declaration === undefined || action === undefined ? undefined : declaredEffectSignature(declaration, action.action.kind);
  });
  if (signatures[0] === undefined || signatures.some((signature) => signature !== signatures[0])) return undefined;

  const receipts = actionEvents.map((actionEvent) => events.find((event): event is Extract<RuntimeEvent, { type: "action.execution.completed" | "action.execution.failed" }> =>
    (event.type === "action.execution.completed" || event.type === "action.execution.failed")
    && event.receipt.actionId === actionEvent.action.actionId
    && event.sequence > actionEvent.sequence,
  ));
  if (receipts.some((event) => event?.type !== "action.execution.completed" || event.receipt.status !== "completed")) return undefined;

  const latestAction = actionEvents.at(-1);
  const latestDeclaration = declarations.at(-1);
  if (latestAction === undefined || latestDeclaration === undefined) return undefined;
  const latestReceipt = receipts.at(-1);
  if (latestReceipt === undefined || (latestObservation !== undefined && latestReceipt.sequence >= (observationEvent(events, latestObservation.id, runId)?.sequence ?? -1))) return undefined;

  if (latestObservation !== undefined) {
    for (const actionEvent of actionEvents) {
      const basedOn = actionBasedOnObservation(actionEvent.action);
      const before = basedOn === undefined ? undefined : observationEvent(events, basedOn, runId);
      if (before === undefined || !sameObservationPartition(before.observation, latestObservation)) return undefined;
    }
  }

  const assessed = latestAssessmentForActions(events, actionEvents.slice(0, -1), runId, latestAction.sequence, boundarySequence);
  const actionForReport = assessed === undefined
    ? undefined
    : actionEvents.find((event) => event.action.actionId === assessed.assessment.actionId)?.action;
  const report = assessed === undefined || actionForReport === undefined
    ? undefined
    : boundedAssessmentEvidence(assessed.assessment.evidence, actionForReport);
  const target = boundedActionLabel(latestDeclaration.target, latestAction.action, 28);
  const summary = boundedActionLabel(latestDeclaration.summary, latestAction.action, 32);
  const prefix = `Model-declared target “${target}” repeated; expected “${summary}” (unverified).`;
  const suffix = " Recheck newest image first; pixels alone are not proof.";
  const reportLabel = report === undefined
    ? " No verified outcome recorded."
    : ` ${assessed?.assessment.actionOutcome} (unverified):`;
  const availableReport = Math.max(0, 240 - prefix.length - suffix.length - reportLabel.length - (report === undefined ? 0 : 4));
  const reportTruncated = report !== undefined && report.length > availableReport;
  const boundedReport = report === undefined ? undefined : truncateUtf16(report, Math.max(0, availableReport - (reportTruncated ? 1 : 0)));
  const text = report === undefined
    ? `${prefix}${reportLabel}${suffix}`
    : `${prefix}${reportLabel} “${boundedReport}${reportTruncated ? "…" : ""}”.${suffix}`;
  const latestObservationEvent = latestObservation === undefined ? undefined : observationEvent(events, latestObservation.id, runId);
  const sourceEventIds = [
    ...actionEvents.map((event) => event.eventId),
    ...actionEvents.flatMap((event) => {
      const call = events.find((candidate): candidate is Extract<RuntimeEvent, { type: "tool.call.received" }> =>
        candidate.type === "tool.call.received" && candidate.call.id === event.callId,
      );
      return call === undefined ? [] : [call.eventId];
    }),
    ...(assessed === undefined ? [] : [assessed.response.eventId, assessed.observationEvent.eventId, assessed.transition.eventId]),
    ...(latestObservationEvent === undefined ? [] : [latestObservationEvent.eventId]),
    ...(currentEventId === undefined ? [] : [currentEventId]),
  ];
  return { text: truncateUtf16(text, 240), sourceEventIds: [...new Set(sourceEventIds)].slice(-12) };
}

function declaredEffectForAction(
  events: readonly RuntimeEvent[],
  actionEvent: Extract<RuntimeEvent, { type: "action.proposed" }>,
): ActionEffectDeclaration | undefined {
  const call = events.find((event): event is Extract<RuntimeEvent, { type: "tool.call.received" }> =>
    event.runId === actionEvent.runId && event.type === "tool.call.received" && event.call.id === actionEvent.callId,
  );
  return call?.call.declaredEffect;
}

function latestAssessmentForActions(
  events: readonly RuntimeEvent[],
  actions: readonly Extract<RuntimeEvent, { type: "action.proposed" }>[],
  runId: RunId,
  beforeSequence: number,
  boundarySequence: number,
): {
  readonly assessment: NonNullable<ReturnType<typeof parseObservationAssessment>>;
  readonly response: Extract<RuntimeEvent, { type: "model.response.received" }>;
  readonly observationEvent: Extract<RuntimeEvent, { type: "observation.created" }>;
  readonly transition: Extract<RuntimeEvent, { type: "monitor.transition" }>;
} | undefined {
  const actionIds = new Set(actions.map((event) => event.action.actionId));
  const responses = [...events].reverse().filter((event): event is Extract<RuntimeEvent, { type: "model.response.received" }> =>
    event.runId === runId && event.type === "model.response.received" && event.sequence > boundarySequence
    && event.sequence < beforeSequence && event.turn.observationAssessment !== undefined,
  );
  for (const response of responses) {
    const assessment = parseObservationAssessment(response.turn.observationAssessment);
    if (assessment === undefined || !actionIds.has(assessment.actionId)) continue;
    const action = actions.find((event) => event.action.actionId === assessment.actionId);
    const receipt = events.find((event): event is Extract<RuntimeEvent, { type: "action.execution.completed" | "action.execution.failed" }> =>
      (event.type === "action.execution.completed" || event.type === "action.execution.failed")
      && event.receipt.actionId === assessment.actionId && event.sequence < response.sequence,
    );
    const evidenceObservation = observationEvent(events, assessment.observationId, runId);
    const transition = events.find((event): event is Extract<RuntimeEvent, { type: "monitor.transition" }> =>
      event.runId === runId && event.type === "monitor.transition" && event.actionId === assessment.actionId
      && event.postObservationId === assessment.observationId && event.sequence > boundarySequence,
    );
    const basedOn = action === undefined ? undefined : actionBasedOnObservation(action.action);
    const actionObservation = basedOn === undefined ? undefined : observationEvent(events, basedOn, runId);
    if (action === undefined || action.action.kind === "wait" || receipt?.type !== "action.execution.completed"
      || receipt.receipt.status !== "completed" || evidenceObservation === undefined || transition === undefined
      || actionObservation === undefined || !sameObservationPartition(actionObservation.observation, evidenceObservation.observation)
      || transition.sequence >= response.sequence || receipt.sequence >= evidenceObservation.sequence) continue;
    return { assessment, response, observationEvent: evidenceObservation, transition };
  }
  return undefined;
}

function latestAttemptBoundarySequence(events: readonly RuntimeEvent[], runId: RunId): number {
  const orderedEvents = events.filter((event) => event.runId === runId).sort((left, right) => left.sequence - right.sequence);
  let boundarySequence = -1;
  let previousObservation: ObservationFrame | undefined;
  for (const event of orderedEvents) {
    if (event.type === "user.input.received" || event.type === "computer.window.handoff.requested"
      || event.type === "computer.window.handoff.completed" || event.type === "computer.window.handoff.ignored"
      || (event.type === "monitor.transition" && event.transition === "unknown")) {
      boundarySequence = event.sequence;
      continue;
    }
    if (event.type !== "observation.created") continue;
    if (previousObservation !== undefined && !sameObservationPartition(previousObservation, event.observation)) {
      boundarySequence = event.sequence;
    }
    previousObservation = event.observation;
  }
  return boundarySequence;
}

function actionBasedOnObservation(action: ActionIntent): string | undefined {
  return "basedOn" in action ? String(action.basedOn) : undefined;
}

function boundedActionLabel(value: string, action: ActionIntent, maximum: number): string {
  let safe = normalizeRecoveryText(value);
  if (action.kind === "type") {
    const typedText = normalizeRecoveryText(action.text);
    const containsTypedText = typedText.length > 0
      && safe.toLocaleLowerCase("en-US").includes(typedText.toLocaleLowerCase("en-US"));
    if (containsTypedText && typedText.length < 4) return "typed text omitted";
    if (containsTypedText) safe = safe.replace(new RegExp(escapeRegExp(typedText), "giu"), "[typed text omitted]");
  }
  return truncateUtf16(safe, maximum);
}

function candidateSourceEventIds(event: RuntimeEvent, output: ProgressMonitorOutput): readonly EventId[] {
  return [...new Set([
    event.eventId,
    ...output.eventIds,
    ...output.reasons.flatMap((reason) => reason.eventIds),
    ...output.evidence.flatMap((item) => item.eventIds),
  ])].slice(-12);
}

function observationEvent(events: readonly RuntimeEvent[], id: string, runId: RunId): Extract<RuntimeEvent, { type: "observation.created" }> | undefined {
  return events.find((event): event is Extract<RuntimeEvent, { type: "observation.created" }> =>
    event.runId === runId && event.type === "observation.created" && event.observation.id === id,
  );
}

function eventById(events: readonly RuntimeEvent[], id: EventId): RuntimeEvent | undefined {
  return events.find((event) => event.eventId === id);
}

function sameObservationPartition(left: ObservationFrame, right: ObservationFrame): boolean {
  const a = left.surfaceRef;
  const b = right.surfaceRef;
  return left.computerSessionId === right.computerSessionId
    && a.surfaceId === b.surfaceId && a.generation === b.generation && a.kind === b.kind
    && a.parentSurfaceId === b.parentSurfaceId && a.admissionSource === b.admissionSource
    && left.viewport.coordinateSpace === right.viewport.coordinateSpace
    && left.viewport.width === right.viewport.width && left.viewport.height === right.viewport.height;
}

function boundedAssessmentEvidence(evidence: string, action: ActionIntent): string {
  // Mask the complete known text before bounding the quote. Truncating first
  // can hide a long typed value from the masker and leak its leading portion.
  let safe = normalizeRecoveryText(evidence);
  if (action.kind === "type") {
    const typedText = normalizeRecoveryText(action.text);
    const safeContainsTypedText = typedText.length > 0
      && safe.toLocaleLowerCase("en-US").includes(typedText.toLocaleLowerCase("en-US"));
    if (safeContainsTypedText && typedText.length < 4) return "typed text omitted";
    if (safeContainsTypedText) {
      safe = safe.replace(new RegExp(escapeRegExp(typedText), "giu"), "[typed text omitted]");
    }
  }
  return [...safe].slice(0, 72).join("");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function composeBoundedHint(prefix: string, evidence: string, suffix: string): string {
  const evidenceWrapperLength = 4; // space, opening quote, closing quote, and period
  const availableEvidence = Math.max(0, 240 - prefix.length - suffix.length - evidenceWrapperLength);
  const evidencePoints = [...evidence];
  const evidenceParts: string[] = [];
  let evidenceUnits = 0;
  let isTruncated = false;
  for (const point of evidencePoints) {
    if (evidenceUnits + point.length > availableEvidence) {
      isTruncated = true;
      break;
    }
    evidenceParts.push(point);
    evidenceUnits += point.length;
  }
  if (evidenceParts.length < evidencePoints.length) isTruncated = true;
  if (isTruncated && evidenceUnits + 1 > availableEvidence && evidenceParts.length > 0) {
    const removed = evidenceParts.pop()!;
    evidenceUnits -= removed.length;
  }
  const boundedEvidence = evidenceParts.join("");
  const finalEvidencePart = boundedEvidence.length === 0 ? "" : ` “${boundedEvidence}${isTruncated ? "…" : ""}”.`;
  const text = `${prefix}${finalEvidencePart}${suffix}`;
  return text;
}

export function boundedRecoveryIntent(value: string): string | undefined {
  const normalized = normalizeRecoveryText(value);
  return normalized.length === 0 ? undefined : truncateUtf16(normalized, 160);
}

function normalizeRecoveryText(value: string): string {
  return value
    .replace(/[\u0000-\u001F\u007F]/gu, " ")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[redacted-email]")
    .replace(/\b1\d{10}\b/gu, "[redacted-phone]")
    .replace(/\s+/gu, " ")
    .trim();
}

function truncateUtf16(value: string, maximumUnits: number): string {
  const output: string[] = [];
  let units = 0;
  for (const point of value) {
    if (units + point.length > maximumUnits) break;
    output.push(point);
    units += point.length;
  }
  return output.join("");
}
