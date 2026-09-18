import { createHash } from "node:crypto";
import type { ActionIntent, EventId, RunId, RuntimeEvent, Viewport } from "@computer-harness/protocol";

const DEFAULT_LIMITS = {
  maxObservations: 32,
  maxActionHistory: 64,
  maxUpdateEvents: 32,
  maxOutputEventIds: 12,
  repeatThreshold: 3,
  refusalThreshold: 2,
  churnThreshold: 3,
} as const;

export interface ProgressMonitorOptions {
  maxObservations?: number;
  maxActionHistory?: number;
  maxUpdateEvents?: number;
  maxOutputEventIds?: number;
  repeatThreshold?: number;
  refusalThreshold?: number;
  churnThreshold?: number;
}

type MonitorLimits = Readonly<Required<ProgressMonitorOptions>>;

export type ProgressMonitorReasonCode =
  | "repeated_proposal"
  | "repeated_action"
  | "action_cycle"
  | "repeated_refusal"
  | "repeated_failure"
  | "plan_memory_churn"
  | "unknown_outcome";

export type ProgressMonitorEvidenceKind =
  | "action_proposed"
  | "action_receipt"
  | "receipt_unbound"
  | "planning_update"
  | "memory_update"
  | "visual_feature_unavailable"
  | "action_binding_unavailable"
  | "partition_changed"
  | "unknown_outcome";

export interface ProgressMonitorReason {
  code: ProgressMonitorReasonCode;
  eventIds: readonly EventId[];
}

export interface ProgressMonitorEvidence {
  kind: ProgressMonitorEvidenceKind;
  eventIds: readonly EventId[];
}

/**
 * The foundation is deliberately a candidate reporter.  It has no stop,
 * retry, guidance, approval, or execution field for a consumer to mistake
 * for an online control decision.
 */
export interface ProgressMonitorOutput {
  candidate: boolean;
  reasons: readonly ProgressMonitorReason[];
  evidence: readonly ProgressMonitorEvidence[];
  eventIds: readonly EventId[];
}

interface ObservationBinding {
  partitionKey: string;
  eventId: EventId;
}

type ActionStatus = "proposed" | "completed" | "refused" | "failed" | "cancelled";

interface ActionRecord {
  actionKey: string;
  partitionKey?: string;
  signature?: string;
  eventId: EventId;
  status: ActionStatus;
}

/**
 * State is intentionally in-memory and bounded.  It is not a persistence or
 * shareable diagnostic format; opaque keys are local hashes and no action
 * payload, typed text, URL, screenshot bytes, or model text is retained.
 */
export interface ProgressMonitorState {
  readonly runId?: RunId;
  readonly observations: ReadonlyMap<string, ObservationBinding>;
  readonly actionRecords: ReadonlyMap<string, ActionRecord>;
  readonly recentActions: readonly ActionRecord[];
  readonly updateEventIds: readonly EventId[];
  readonly lastObservationPartition?: string;
  readonly limits: MonitorLimits;
}

export interface ProgressMonitorUpdate {
  state: ProgressMonitorState;
  output: ProgressMonitorOutput;
}

export function createProgressMonitorState(runId?: RunId, options?: ProgressMonitorOptions): ProgressMonitorState {
  return {
    ...(runId === undefined ? {} : { runId }),
    observations: new Map(),
    actionRecords: new Map(),
    recentActions: [],
    updateEventIds: [],
    limits: normalizeLimits(options),
  };
}

/** Apply one committed RuntimeEvent without executing or scheduling anything. */
export function reduceProgressMonitor(state: ProgressMonitorState, event: RuntimeEvent): ProgressMonitorUpdate {
  const current = state.runId === undefined
    ? { ...state, runId: event.runId }
    : state.runId === event.runId
      ? state
      : createProgressMonitorState(event.runId, state.limits);

  switch (event.type) {
    case "observation.created":
      return onObservation(current, event);
    case "action.proposed":
      return onActionProposed(current, event);
    case "action.execution.completed":
    case "action.execution.failed":
      return onActionReceipt(current, event);
    case "planning.task.updated":
      return onProgressUpdate(current, event.eventId, "planning_update");
    case "memory.updated":
      return onProgressUpdate(current, event.eventId, "memory_update");
    case "run.finished":
      return onRunFinished(current, event);
    default:
      return { state: current, output: makeOutput(current.limits, false, [], [], [event.eventId]) };
  }
}

function onObservation(
  state: ProgressMonitorState,
  event: Extract<RuntimeEvent, { type: "observation.created" }>,
): ProgressMonitorUpdate {
  const partitionKey = observationPartition(event.observation.computerSessionId, event.observation.viewport);
  const previousPartition = state.lastObservationPartition;
  const observations = boundedMap(
    state.observations,
    opaqueHash(`observation:${String(event.observation.id)}`),
    { partitionKey, eventId: event.eventId },
    state.limits.maxObservations,
  );
  const partitionChanged = previousPartition !== undefined && previousPartition !== partitionKey;
  const evidence: ProgressMonitorEvidence[] = [
    { kind: "visual_feature_unavailable", eventIds: [event.eventId] },
  ];
  if (partitionChanged) evidence.push({ kind: "partition_changed", eventIds: [event.eventId] });
  return {
    state: {
      ...state,
      observations,
      lastObservationPartition: partitionKey,
      updateEventIds: partitionChanged ? [] : state.updateEventIds,
    },
    output: makeOutput(state.limits, false, [], evidence, [event.eventId]),
  };
}

function onActionProposed(
  state: ProgressMonitorState,
  event: Extract<RuntimeEvent, { type: "action.proposed" }>,
): ProgressMonitorUpdate {
  const partitionKey = actionPartition(state, event.action);
  const actionKey = opaqueHash(`action:${String(event.action.actionId)}`);
  const signature = partitionKey === undefined ? undefined : actionSignature(event.action, partitionKey);
  const record: ActionRecord = {
    actionKey,
    ...(partitionKey === undefined ? {} : { partitionKey }),
    ...(signature === undefined ? {} : { signature }),
    eventId: event.eventId,
    status: "proposed",
  };
  const actionRecords = boundedMap(state.actionRecords, actionKey, record, state.limits.maxActionHistory);
  const recentActions = appendBounded(state.recentActions, record, state.limits.maxActionHistory);
  const evidence: ProgressMonitorEvidence[] = [{ kind: "action_proposed", eventIds: [event.eventId] }];
  const reasons: ProgressMonitorReason[] = [];

  if (partitionKey === undefined || signature === undefined) {
    evidence.push({ kind: "action_binding_unavailable", eventIds: [event.eventId] });
  } else {
    const comparable = recentActions.filter((item) => item.partitionKey === partitionKey && item.signature !== undefined);
    const repeated = trailingSignature(comparable, signature);
    if (repeated.length >= state.limits.repeatThreshold) {
      reasons.push({
        code: repeated.every((item) => item.status === "completed") ? "repeated_action" : "repeated_proposal",
        eventIds: repeated.map((item) => item.eventId),
      });
    }
    const lastThree = comparable.slice(-3);
    if (
      lastThree.length === 3
      && lastThree[0]?.signature === lastThree[2]?.signature
      && lastThree[0]?.signature !== lastThree[1]?.signature
      && lastThree.every((item) => item.status === "completed")
    ) {
      reasons.push({ code: "action_cycle", eventIds: lastThree.map((item) => item.eventId) });
    }
  }

  return {
    state: { ...state, actionRecords, recentActions },
    output: makeOutput(state.limits, reasons.length > 0, reasons, evidence, [event.eventId]),
  };
}

function onActionReceipt(
  state: ProgressMonitorState,
  event: Extract<RuntimeEvent, { type: "action.execution.completed" | "action.execution.failed" }>,
): ProgressMonitorUpdate {
  const actionKey = opaqueHash(`action:${String(event.receipt.actionId)}`);
  const previous = state.actionRecords.get(actionKey);
  if (previous === undefined) {
    return {
      state,
      output: makeOutput(
        state.limits,
        false,
        [],
        [{ kind: "receipt_unbound", eventIds: [event.eventId] }],
        [event.eventId],
      ),
    };
  }

  const updated: ActionRecord = { ...previous, status: event.receipt.status };
  const actionRecords = new Map(state.actionRecords);
  actionRecords.set(actionKey, updated);
  const recentActions = state.recentActions.map((item) => item.actionKey === actionKey ? updated : item);
  const evidence: ProgressMonitorEvidence[] = [{ kind: "action_receipt", eventIds: [previous.eventId, event.eventId] }];
  const reasons: ProgressMonitorReason[] = [];
  if (updated.signature !== undefined && updated.partitionKey !== undefined) {
    const comparable = recentActions.filter((item) => item.partitionKey === updated.partitionKey && item.signature !== undefined);
    if (updated.status === "refused") {
      const refused = trailingStatus(comparable, updated.signature, "refused");
      if (refused.length >= state.limits.refusalThreshold) {
        reasons.push({ code: "repeated_refusal", eventIds: refused.map((item) => item.eventId).concat(event.eventId) });
      }
    } else if (updated.status === "failed" || updated.status === "cancelled") {
      const failed = trailingStatus(comparable, updated.signature, "failed", "cancelled");
      if (failed.length >= state.limits.refusalThreshold) {
        reasons.push({ code: "repeated_failure", eventIds: failed.map((item) => item.eventId).concat(event.eventId) });
      }
    } else if (updated.status === "completed") {
      reasons.push(...completedActionReasons(recentActions, updated, state.limits));
    }
  }

  return {
    state: {
      ...state,
      actionRecords,
      recentActions,
      updateEventIds: updated.status === "completed" ? [] : state.updateEventIds,
    },
    output: makeOutput(state.limits, reasons.length > 0, reasons, evidence, [event.eventId]),
  };
}

function onProgressUpdate(
  state: ProgressMonitorState,
  eventId: EventId,
  kind: "planning_update" | "memory_update",
): ProgressMonitorUpdate {
  const updateEventIds = appendBounded(state.updateEventIds, eventId, state.limits.maxUpdateEvents);
  const reasons: ProgressMonitorReason[] = updateEventIds.length >= state.limits.churnThreshold
    ? [{ code: "plan_memory_churn", eventIds: updateEventIds }]
    : [];
  return {
    state: { ...state, updateEventIds },
    output: makeOutput(
      state.limits,
      reasons.length > 0,
      reasons,
      [{ kind, eventIds: [eventId] }],
      [eventId],
    ),
  };
}

function onRunFinished(
  state: ProgressMonitorState,
  event: Extract<RuntimeEvent, { type: "run.finished" }>,
): ProgressMonitorUpdate {
  if (event.outcome !== "outcome_unknown") {
    return { state, output: makeOutput(state.limits, false, [], [], [event.eventId]) };
  }
  const reason: ProgressMonitorReason = { code: "unknown_outcome", eventIds: [event.eventId] };
  return {
    state,
    output: makeOutput(
      state.limits,
      true,
      [reason],
      [{ kind: "unknown_outcome", eventIds: [event.eventId] }],
      [event.eventId],
    ),
  };
}

function actionPartition(state: ProgressMonitorState, action: ActionIntent): string | undefined {
  if (action.kind === "wait") return state.lastObservationPartition;
  const observationId = action.basedOn;
  return state.observations.get(opaqueHash(`observation:${String(observationId)}`))?.partitionKey;
}

function actionSignature(action: ActionIntent, partitionKey: string): string {
  return opaqueHash(JSON.stringify({ partitionKey, action: normalizedAction(action) }));
}

/** The returned object is serialized immediately and never retained or emitted. */
function normalizedAction(action: ActionIntent): unknown {
  switch (action.kind) {
    case "click":
    case "double_click":
    case "right_click":
      return { kind: action.kind, x: action.point.x, y: action.point.y };
    case "scroll":
      return { kind: action.kind, x: action.point.x, y: action.point.y, direction: action.direction, ticks: action.ticks };
    case "drag":
      return { kind: action.kind, fromX: action.from.x, fromY: action.from.y, toX: action.to.x, toY: action.to.y };
    case "type":
      return { kind: action.kind, text: action.text };
    case "keypress":
      return { kind: action.kind, keys: [...action.keys] };
    case "wait":
      return { kind: action.kind, durationMs: action.durationMs };
  }
}

function trailingSignature(records: readonly ActionRecord[], signature: string): readonly ActionRecord[] {
  const result: ActionRecord[] = [];
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const item = records[index];
    if (item?.signature !== signature) break;
    result.unshift(item);
  }
  return result;
}

function trailingStatus(records: readonly ActionRecord[], signature: string, ...statuses: readonly ActionStatus[]): readonly ActionRecord[] {
  const accepted = new Set(statuses);
  const result: ActionRecord[] = [];
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const item = records[index];
    if (item === undefined || item.signature !== signature || !accepted.has(item.status)) break;
    result.unshift(item);
  }
  return result;
}

function completedActionReasons(
  records: readonly ActionRecord[],
  updated: ActionRecord,
  limits: MonitorLimits,
): ProgressMonitorReason[] {
  if (updated.partitionKey === undefined || updated.signature === undefined) return [];
  const comparable = records.filter((item) => item.partitionKey === updated.partitionKey && item.signature !== undefined);
  const reasons: ProgressMonitorReason[] = [];
  const repeated = trailingSignature(comparable, updated.signature);
  if (repeated.length >= limits.repeatThreshold && repeated.every((item) => item.status === "completed")) {
    reasons.push({ code: "repeated_action", eventIds: repeated.map((item) => item.eventId) });
  }
  const lastThree = comparable.slice(-3);
  if (
    lastThree.length === 3
    && lastThree[0]?.signature === lastThree[2]?.signature
    && lastThree[0]?.signature !== lastThree[1]?.signature
    && lastThree.every((item) => item.status === "completed")
  ) {
    reasons.push({ code: "action_cycle", eventIds: lastThree.map((item) => item.eventId) });
  }
  return reasons;
}

function observationPartition(sessionId: string, viewport: Viewport): string {
  return `session:${opaqueHash(String(sessionId))}|viewport:${viewport.coordinateSpace}:${viewport.width}x${viewport.height}`;
}

function makeOutput(
  limits: MonitorLimits,
  candidate: boolean,
  reasons: readonly ProgressMonitorReason[],
  evidence: readonly ProgressMonitorEvidence[],
  eventIds: readonly EventId[],
): ProgressMonitorOutput {
  return {
    candidate,
    reasons: reasons.map((reason) => ({ ...reason, eventIds: limitEventIds(reason.eventIds, limits.maxOutputEventIds) })),
    evidence: evidence.map((item) => ({ ...item, eventIds: limitEventIds(item.eventIds, limits.maxOutputEventIds) })),
    eventIds: limitEventIds(eventIds, limits.maxOutputEventIds),
  };
}

function limitEventIds(eventIds: readonly EventId[], limit: number): readonly EventId[] {
  return [...new Set(eventIds)].slice(-limit);
}

function normalizeLimits(options?: ProgressMonitorOptions | MonitorLimits): MonitorLimits {
  return {
    maxObservations: boundedPositive(options?.maxObservations, DEFAULT_LIMITS.maxObservations, 256),
    maxActionHistory: boundedPositive(options?.maxActionHistory, DEFAULT_LIMITS.maxActionHistory, 256),
    maxUpdateEvents: boundedPositive(options?.maxUpdateEvents, DEFAULT_LIMITS.maxUpdateEvents, 256),
    maxOutputEventIds: boundedPositive(options?.maxOutputEventIds, DEFAULT_LIMITS.maxOutputEventIds, 64),
    repeatThreshold: boundedPositive(options?.repeatThreshold, DEFAULT_LIMITS.repeatThreshold, 64),
    refusalThreshold: boundedPositive(options?.refusalThreshold, DEFAULT_LIMITS.refusalThreshold, 64),
    churnThreshold: boundedPositive(options?.churnThreshold, DEFAULT_LIMITS.churnThreshold, 64),
  };
}

function boundedPositive(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) return fallback;
  return Math.min(value, maximum);
}

function appendBounded<T>(items: readonly T[], item: T, limit: number): T[] {
  const next = [...items, item];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

function boundedMap<K, V>(source: ReadonlyMap<K, V>, key: K, value: V, limit: number): Map<K, V> {
  const next = new Map(source);
  next.set(key, value);
  while (next.size > limit) {
    const first = next.keys().next();
    if (first.done) break;
    next.delete(first.value);
  }
  return next;
}

function opaqueHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24);
}
