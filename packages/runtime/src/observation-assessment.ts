import type { ActionId, JsonValue, ObservationAssessment, ObservationId, ObservationTransition, RuntimeEvent } from "@computer-harness/protocol";

export const OBSERVATION_ASSESSMENT_FIELD = "observationAssessment";

/** Stable instructions/schema shared by both Provider adapters. Per-turn IDs stay in user messages. */
export const OBSERVATION_ASSESSMENT_GUIDANCE =
  "Optional ObservationAssessment: attach one observationAssessment object inside the arguments of the normal action or control call only when useful. Progress has a one-turn delay: after an action, wait for its fresh post-action Observation and report only in the next ModelTurn; do not announce a result in the action-producing turn. Report what the exact current screenshot visibly confirms in this response's fresh Observation. Use the exact latest Observation ID and preceding GUI action ID supplied in the current user message. progress.kind=milestone means a distinct user-level stage result is visible now; it may be a stable result that was already present before the immediately preceding action, so do not claim that action caused it. Examples include the requested search results being visible or requested content visible in the destination application after a fresh screenshot. progress.kind=blocked means the current screenshot shows a concrete blocker or something the user needs to handle. Do not add progress for routine clicks, focus changes, menu openings, cursors, unverified typing, action receipts, planned next steps, or the whole task merely because the screen looks stable. Report meaningful stage results, not every step. Never use raw assistant narration, future intent, or a Planning declaration as evidence. actionOutcome, evidence and any supplied Runtime Monitor transition describe action diagnostics; they do not prove or disprove the semantic state shown in the current screenshot. Do not invent IDs or include confidence scores. This annotation does not replace the normal action/control decision.";

export const observationAssessmentSchema: JsonValue = {
  type: "object",
  properties: {
    observationId: { type: "string", minLength: 1, maxLength: 128 },
    actionId: { type: "string", minLength: 1, maxLength: 128 },
    actionOutcome: { type: "string", enum: ["expected_change", "no_effect", "unexpected_change", "uncertain"] },
    evidence: { type: "string", minLength: 1, maxLength: 240 },
    progress: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["milestone", "blocked"] },
        summary: { type: "string", minLength: 1, maxLength: 160 },
      },
      required: ["kind", "summary"],
      additionalProperties: false,
    },
  },
  required: ["observationId", "actionId", "actionOutcome", "evidence"],
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
  if (value.progress !== undefined) {
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
