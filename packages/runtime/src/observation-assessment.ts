import type { ActionId, JsonValue, ObservationAssessment, ObservationId, ObservationTransition, RuntimeEvent } from "@computer-harness/protocol";

export const OBSERVATION_ASSESSMENT_FIELD = "observationAssessment";

/** Stable instructions/schema shared by both Provider adapters. Per-turn IDs stay in user messages. */
export const OBSERVATION_ASSESSMENT_GUIDANCE =
  `When a valid current assessment reference is supplied, include one observationAssessment object inside the arguments of the normal action or control call. The outer field remains optional in the wire schema for compatibility; on this referenced turn, do not confuse schema optionality with whether you should report. Its progress field is REQUIRED and must be an explicit choice: use null when this fresh screenshot confirms neither a meaningful user-requested subgoal result nor a concrete blocker; use {kind: milestone, summary: ...} when it confirms a meaningful requested result; use {kind: blocked, summary: ...} only for a concrete blocker or something the user needs to handle. Null means no speech notice. Judge progress against the Goal's user-visible subgoals, not only whether the whole Goal is finished: when the screenshot confirms any meaningful requested subgoal, report that milestone now even if later Goal steps remain. For example, results now displayed or requested content now present in its destination can be a milestone while the broader task continues. Do not call a partial milestone final completion. Use the exact current Observation ID and preceding GUI action ID in the supplied reference. The full object shape is {"observationId":"<exact current Observation ID>","actionId":"<exact preceding GUI action ID>","actionOutcome":"<accurate diagnostic enum>","evidence":"<brief non-sensitive screenshot fact>","progress":{"kind":"milestone","summary":"<what this screenshot confirms; mention remaining work only if relevant>"}}. Replace every placeholder with this turn's exact IDs and screenshot-grounded facts; do not output placeholders or mechanically reuse the example summary. For no meaningful subgoal or blocker, set progress to null instead. Progress has a one-turn delay: after an action, wait for its fresh post-action Observation and report only in the next ModelTurn; do not announce a result in the action-producing turn. The current screenshot is the evidence for this turn. A result may have existed before the immediately preceding action; report what is visible without claiming that action caused it, and do not require a changed action or Monitor transition. Do not add a milestone for routine clicks, focus changes, menu openings, cursors, unverified typing, action receipts, planned next steps, or the whole task merely because the screen looks stable. Report meaningful stage results, not every step. Never use raw assistant narration, future intent, a Planning declaration, actionOutcome, evidence, or a Runtime Monitor transition as proof of semantic state; those diagnostics do not decide what the screenshot shows. Do not copy private on-screen text into a summary. Do not invent IDs or include confidence scores. This annotation does not replace the normal action/control decision.`;

export const observationAssessmentSchema: JsonValue = {
  type: "object",
  properties: {
    observationId: { type: "string", minLength: 1, maxLength: 128 },
    actionId: { type: "string", minLength: 1, maxLength: 128 },
    actionOutcome: { type: "string", enum: ["expected_change", "no_effect", "unexpected_change", "uncertain"] },
    evidence: { type: "string", minLength: 1, maxLength: 240 },
    progress: {
      type: ["object", "null"],
      description: "Required explicit choice: null means no progress/blocker and produces no speech notice. If the fresh screenshot confirms a meaningful requested subgoal result, use an object with kind=milestone and a concise user-facing summary (for example, requested text is visible in its destination app or requested results are displayed). Use kind=blocked only for a concrete blocker. Base it on screenshot semantics, independent of actionOutcome or Monitor transition; do not require a changed transition, quote private screen text, or report routine actions.",
      properties: {
        kind: { type: "string", enum: ["milestone", "blocked"] },
        summary: { type: "string", minLength: 1, maxLength: 160 },
      },
      required: ["kind", "summary"],
      additionalProperties: false,
    },
  },
  required: ["observationId", "actionId", "actionOutcome", "evidence", "progress"],
  additionalProperties: false,
};

export interface ObservationAssessmentBinding {
  readonly observationId: ObservationId;
  readonly actionId: ActionId;
  readonly transition?: ObservationTransition;
}

export function currentObservationAssessmentBinding(events: readonly RuntimeEvent[]): ObservationAssessmentBinding | undefined {
  let latestObservation: Extract<RuntimeEvent, { type: "observation.created" }> | undefined;
  let latestProposal: Extract<RuntimeEvent, { type: "action.proposed" }> | undefined;
  let latestReceipt: Extract<RuntimeEvent, { type: "action.execution.completed" | "action.execution.failed" }> | undefined;
  let latestGuiEventSequence = -1;
  let latestGuiEventType: "proposal" | "receipt" | undefined;
  for (const event of events) {
    if (event.type === "observation.created" && (latestObservation === undefined || event.sequence > latestObservation.sequence)) {
      latestObservation = event;
    } else if (event.type === "action.proposed") {
      if (latestProposal === undefined || event.sequence > latestProposal.sequence) latestProposal = event;
      if (event.sequence > latestGuiEventSequence) {
        latestGuiEventSequence = event.sequence;
        latestGuiEventType = "proposal";
      }
    } else if (event.type === "action.execution.completed" || event.type === "action.execution.failed") {
      if (latestReceipt === undefined || event.sequence > latestReceipt.sequence) latestReceipt = event;
      if (event.sequence > latestGuiEventSequence) {
        latestGuiEventSequence = event.sequence;
        latestGuiEventType = "receipt";
      }
    }
  }
  if (latestObservation === undefined || latestProposal === undefined || latestReceipt === undefined
    || latestGuiEventType !== "receipt"
    || latestProposal.action.actionId !== latestReceipt.receipt.actionId
    || latestProposal.sequence >= latestReceipt.sequence
    || latestReceipt.sequence >= latestObservation.sequence) return undefined;
  let transition: Extract<RuntimeEvent, { type: "monitor.transition" }> | undefined;
  for (const event of events) {
    if (event.type === "monitor.transition"
      && event.actionId === latestReceipt.receipt.actionId
      && event.postObservationId === latestObservation.observation.id
      && event.sourceActionEventId === latestReceipt.eventId
      && event.sourceObservationEventId === latestObservation.eventId
      && event.sequence > latestObservation.sequence
      && (transition === undefined || event.sequence > transition.sequence)) {
      transition = event;
    }
  }
  return {
    observationId: latestObservation.observation.id,
    actionId: latestReceipt.receipt.actionId,
    ...(transition === undefined ? {} : { transition: transition.transition }),
  };
}

export function withObservationAssessmentSchema(schema: JsonValue | undefined): JsonValue {
  const base = isRecord(schema) && schema.type === "object"
    ? schema
    : { type: "object", properties: {}, additionalProperties: true };
  const properties = isRecord(base.properties) ? base.properties : {};
  return {
    ...base,
    properties: { ...properties, [OBSERVATION_ASSESSMENT_FIELD]: observationAssessmentSchema },
  } as JsonValue;
}

export function splitObservationAssessment(argumentsValue: JsonValue): {
  readonly arguments: JsonValue;
  readonly supplied: boolean;
  readonly observationAssessment?: ObservationAssessment;
} {
  if (!isRecord(argumentsValue) || !Object.hasOwn(argumentsValue, OBSERVATION_ASSESSMENT_FIELD)) {
    return { arguments: argumentsValue, supplied: false };
  }
  const { [OBSERVATION_ASSESSMENT_FIELD]: rawAssessment, ...toolArguments } = argumentsValue;
  const observationAssessment = parseObservationAssessment(rawAssessment);
  return {
    arguments: toolArguments,
    supplied: true,
    ...(observationAssessment === undefined ? {} : { observationAssessment }),
  };
}

/** Invalid optional annotations are discarded; they never invalidate the enclosing tool/control turn. */
export function parseObservationAssessment(value: unknown): ObservationAssessment | undefined {
  if (!isRecord(value)) return undefined;
  const allowed = new Set(["observationId", "actionId", "actionOutcome", "evidence", "progress"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  if (!isBoundedId(value.observationId) || !isBoundedId(value.actionId)) return undefined;
  if (value.actionOutcome !== "expected_change" && value.actionOutcome !== "no_effect"
    && value.actionOutcome !== "unexpected_change" && value.actionOutcome !== "uncertain") return undefined;
  const evidence = conciseText(value.evidence, 240);
  if (evidence === undefined) return undefined;
  let progress: ObservationAssessment["progress"];
  if (value.progress !== undefined && value.progress !== null) {
    if (!isRecord(value.progress)
      || Object.keys(value.progress).some((key) => key !== "kind" && key !== "summary")
      || (value.progress.kind !== "milestone" && value.progress.kind !== "blocked")) return undefined;
    const summary = conciseText(value.progress.summary, 160);
    if (summary === undefined) return undefined;
    progress = { kind: value.progress.kind, summary };
  }
  return {
    observationId: value.observationId as ObservationAssessment["observationId"],
    actionId: value.actionId as ObservationAssessment["actionId"],
    actionOutcome: value.actionOutcome,
    evidence,
    ...(progress === undefined ? {} : { progress }),
  };
}

function isBoundedId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function conciseText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/u.test(value)) return undefined;
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > 0 && normalized.length <= maximum ? normalized : undefined;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
