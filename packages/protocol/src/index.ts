export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type RunId = Brand<string, "RunId">;
export type ComputerSessionId = Brand<string, "ComputerSessionId">;
export type ObservationId = Brand<string, "ObservationId">;
export type ActionId = Brand<string, "ActionId">;
export type ToolCallId = Brand<string, "ToolCallId">;
export type EventId = Brand<string, "EventId">;
export type AssetId = Brand<string, "AssetId">;

/** Shared task description used by Planning and future read-only consumers. */
export interface TaskSpec {
  subject: string;
  description?: string;
}

export type PlanningTaskStatus = "pending" | "in_progress" | "completed" | "blocked";

export interface PlanningTask extends TaskSpec {
  id: string;
  status: PlanningTaskStatus;
  blockedBy?: string[];
}

export interface PlanState {
  runId: RunId;
  tasks: PlanningTask[];
}

export type MemorySubject = { type: "run" } | { type: "entity"; entityId: string };

export type MemoryScope =
  | { kind: "run" }
  | { kind: "computer_session"; sessionId: ComputerSessionId };

export type MemoryRetentionClass = "stable" | "task" | "short_lived";

export type MemoryStatusReason = "manual_review" | "scope_ended";

/** A small fact retained after raw history is compacted; scope gates applicability within its Run. */
export interface MemoryFact {
  id: string;
  /** Facts are normalized at the top level; this links one fact to an entity without nesting. */
  subject: MemorySubject;
  key: string;
  value: string;
  sourceEventId: EventId;
  status: "active" | "needs_check" | "superseded";
  /** Omitted only by legacy records; readers normalize omission to run scope. */
  scope?: MemoryScope;
  /** Omitted only by legacy records; readers normalize omission to stable. */
  retentionClass?: MemoryRetentionClass;
  statusReason?: MemoryStatusReason;
  relatedTaskIds?: string[];
  updatedSequence: number;
}

/** Optional entity representation built on top of facts; IDs are run-local. */
export interface MemoryEntity {
  id: string;
  type: string;
  description: string;
  sourceEventId: EventId;
  status: "active" | "stale" | "superseded";
  relatedTaskIds?: string[];
  updatedSequence: number;
}

export interface MemoryState {
  runId: RunId;
  facts: MemoryFact[];
  entities: MemoryEntity[];
}

export type MemoryMutation =
  | { operation: "upsert_fact"; fact: MemoryFact }
  | { operation: "supersede_fact"; factId: string; replacement?: MemoryFact }
  | { operation: "mark_fact_needs_check"; factId: string; reason?: MemoryStatusReason }
  | { operation: "upsert_entity"; entity: MemoryEntity }
  | { operation: "invalidate_entity"; entityId: string };

/**
 * Bounds for the serialized, run-scoped Memory contract.  Runtime validates
 * tool-produced mutations with this contract before writing a
 * `memory.updated` event; MemoryStore reuses the same validator at its own
 * persistence boundary.
 */
export const MEMORY_LIMITS = {
  runId: 128,
  id: 128,
  key: 256,
  value: 4_096,
  entityType: 128,
  description: 4_096,
  sourceEventId: 256,
  relatedTaskId: 128,
  relatedTaskIds: 32,
} as const;

/**
 * Parse and normalize an untrusted Memory mutation without changing any
 * state.  This intentionally owns only the shape/length contract; callers
 * still validate run-local references and Planning task links before commit.
 */
export function validateMemoryMutation(value: unknown): MemoryMutation {
  const record = memoryObject(value, "memory mutation");
  if (typeof record.operation !== "string") throw new Error("memory mutation.operation must be a string");
  switch (record.operation) {
    case "upsert_fact":
      memoryExactKeys(record, ["operation", "fact"], [], "memory mutation");
      return { operation: "upsert_fact", fact: validateMemoryFactShape(record.fact, "memory mutation.fact") };
    case "supersede_fact":
      memoryExactKeys(record, ["operation", "factId"], ["replacement"], "memory mutation");
      return {
        operation: "supersede_fact",
        factId: memoryString(record.factId, "memory mutation.factId", MEMORY_LIMITS.id),
        ...(memoryHasOwn(record, "replacement")
          ? { replacement: validateMemoryFactShape(record.replacement, "memory mutation.replacement") }
          : {}),
      };
    case "mark_fact_needs_check":
      memoryExactKeys(record, ["operation", "factId"], ["reason"], "memory mutation");
      return {
        operation: "mark_fact_needs_check",
        factId: memoryString(record.factId, "memory mutation.factId", MEMORY_LIMITS.id),
        ...(record.reason === undefined ? {} : { reason: validateMemoryStatusReason(record.reason, "memory mutation.reason") }),
      };
    case "upsert_entity":
      memoryExactKeys(record, ["operation", "entity"], [], "memory mutation");
      return { operation: "upsert_entity", entity: validateMemoryEntityShape(record.entity, "memory mutation.entity") };
    case "invalidate_entity":
      memoryExactKeys(record, ["operation", "entityId"], [], "memory mutation");
      return {
        operation: "invalidate_entity",
        entityId: memoryString(record.entityId, "memory mutation.entityId", MEMORY_LIMITS.id),
      };
    default:
      throw new Error(`memory mutation operation is invalid: ${record.operation}`);
  }
}

/**
 * Compare the semantic content of two facts.  Event provenance is deliberately
 * excluded because Runtime re-stamps sourceEventId and updatedSequence when a
 * tool result becomes a committed mutation.
 */
export function sameMemoryFactContent(left: MemoryFact, right: MemoryFact): boolean {
  if (left.id !== right.id || left.key !== right.key || left.value !== right.value || left.status !== right.status || left.subject.type !== right.subject.type) return false;
  if (left.subject.type === "entity" && right.subject.type === "entity" && left.subject.entityId !== right.subject.entityId) return false;
  const leftScope = left.scope ?? { kind: "run" as const };
  const rightScope = right.scope ?? { kind: "run" as const };
  if (leftScope.kind !== rightScope.kind || (leftScope.kind === "computer_session" && rightScope.kind === "computer_session" && leftScope.sessionId !== rightScope.sessionId)) return false;
  if ((left.retentionClass ?? "stable") !== (right.retentionClass ?? "stable") || left.statusReason !== right.statusReason) return false;
  if (left.relatedTaskIds === undefined || right.relatedTaskIds === undefined) return left.relatedTaskIds === right.relatedTaskIds;
  return left.relatedTaskIds.length === right.relatedTaskIds.length && left.relatedTaskIds.every((id, index) => id === right.relatedTaskIds?.[index]);
}

export function memoryFactScope(fact: MemoryFact): MemoryScope {
  return fact.scope ?? { kind: "run" };
}

export function memoryFactRetentionClass(fact: MemoryFact): MemoryRetentionClass {
  return fact.retentionClass ?? "stable";
}

export function isMemoryFactScopeApplicable(fact: MemoryFact, sessionId: ComputerSessionId | undefined): boolean {
  const scope = memoryFactScope(fact);
  return scope.kind === "run" || scope.sessionId === sessionId;
}

export function isMemoryFactApplicable(state: MemoryState, fact: MemoryFact, sessionId: ComputerSessionId | undefined): boolean {
  if (fact.status === "superseded" || !isMemoryFactScopeApplicable(fact, sessionId)) return false;
  if (fact.subject.type !== "entity") return true;
  const entityId = fact.subject.entityId;
  return state.entities.some((entity) => entity.id === entityId && entity.status === "active");
}

function normalizeMemoryFactForState(fact: MemoryFact): MemoryFact {
  return {
    ...fact,
    scope: memoryFactScope(fact),
    retentionClass: memoryFactRetentionClass(fact),
    ...(fact.relatedTaskIds === undefined ? {} : { relatedTaskIds: [...fact.relatedTaskIds] }),
  };
}

function validateMemoryFactShape(value: unknown, label: string): MemoryFact {
  const record = memoryObject(value, label);
  memoryExactKeys(
    record,
    ["id", "subject", "key", "value", "sourceEventId", "status", "updatedSequence"],
    ["scope", "retentionClass", "statusReason", "relatedTaskIds"],
    label,
  );
  const status = validateMemoryFactStatus(record.status, `${label}.status`);
  const statusReason = record.statusReason === undefined ? undefined : validateMemoryStatusReason(record.statusReason, `${label}.statusReason`);
  return {
    id: memoryString(record.id, `${label}.id`, MEMORY_LIMITS.id),
    subject: validateMemorySubjectShape(record.subject, `${label}.subject`),
    key: memoryString(record.key, `${label}.key`, MEMORY_LIMITS.key),
    value: memoryString(record.value, `${label}.value`, MEMORY_LIMITS.value, true),
    sourceEventId: memoryString(record.sourceEventId, `${label}.sourceEventId`, MEMORY_LIMITS.sourceEventId) as EventId,
    status,
    scope: record.scope === undefined ? { kind: "run" } : validateMemoryScopeShape(record.scope, `${label}.scope`),
    retentionClass: record.retentionClass === undefined ? "stable" : validateMemoryRetentionClass(record.retentionClass, `${label}.retentionClass`),
    ...(statusReason === undefined ? {} : { statusReason }),
    ...(memoryHasOwn(record, "relatedTaskIds")
      ? { relatedTaskIds: validateMemoryRelatedTaskIds(record.relatedTaskIds, `${label}.relatedTaskIds`) }
      : {}),
    updatedSequence: validateMemorySequence(record.updatedSequence, `${label}.updatedSequence`),
  };
}

function validateMemoryScopeShape(value: unknown, label: string): MemoryScope {
  const record = memoryObject(value, label);
  if (record.kind === "run") {
    memoryExactKeys(record, ["kind"], [], label);
    return { kind: "run" };
  }
  if (record.kind === "computer_session") {
    memoryExactKeys(record, ["kind", "sessionId"], [], label);
    return { kind: "computer_session", sessionId: memoryString(record.sessionId, `${label}.sessionId`, MEMORY_LIMITS.id) as ComputerSessionId };
  }
  throw new Error(`${label}.kind must be run or computer_session`);
}

function validateMemoryRetentionClass(value: unknown, label: string): MemoryRetentionClass {
  if (value === "stable" || value === "task" || value === "short_lived") return value;
  throw new Error(`${label} is invalid`);
}

function validateMemoryStatusReason(value: unknown, label: string): MemoryStatusReason {
  if (value === "manual_review" || value === "scope_ended") return value;
  throw new Error(`${label} is invalid`);
}

function validateMemoryEntityShape(value: unknown, label: string): MemoryEntity {
  const record = memoryObject(value, label);
  memoryExactKeys(record, ["id", "type", "description", "sourceEventId", "status", "updatedSequence"], ["relatedTaskIds"], label);
  return {
    id: memoryString(record.id, `${label}.id`, MEMORY_LIMITS.id),
    type: memoryString(record.type, `${label}.type`, MEMORY_LIMITS.entityType),
    description: memoryString(record.description, `${label}.description`, MEMORY_LIMITS.description),
    sourceEventId: memoryString(record.sourceEventId, `${label}.sourceEventId`, MEMORY_LIMITS.sourceEventId) as EventId,
    status: validateMemoryEntityStatus(record.status, `${label}.status`),
    ...(memoryHasOwn(record, "relatedTaskIds")
      ? { relatedTaskIds: validateMemoryRelatedTaskIds(record.relatedTaskIds, `${label}.relatedTaskIds`) }
      : {}),
    updatedSequence: validateMemorySequence(record.updatedSequence, `${label}.updatedSequence`),
  };
}

function validateMemorySubjectShape(value: unknown, label: string): MemorySubject {
  const record = memoryObject(value, label);
  if (record.type === "run") {
    memoryExactKeys(record, ["type"], [], label);
    return { type: "run" };
  }
  if (record.type === "entity") {
    memoryExactKeys(record, ["type", "entityId"], [], label);
    return { type: "entity", entityId: memoryString(record.entityId, `${label}.entityId`, MEMORY_LIMITS.id) };
  }
  throw new Error(`${label}.type must be run or entity`);
}

function validateMemoryRelatedTaskIds(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > MEMORY_LIMITS.relatedTaskIds) {
    throw new Error(`${label} exceeds the maximum of ${MEMORY_LIMITS.relatedTaskIds} items`);
  }
  const ids: string[] = [];
  for (const [index, item] of value.entries()) {
    const id = memoryString(item, `${label}[${index}]`, MEMORY_LIMITS.relatedTaskId);
    if (ids.includes(id)) throw new Error(`${label} contains duplicate task id ${id}`);
    ids.push(id);
  }
  return ids;
}

function validateMemoryFactStatus(value: unknown, label: string): MemoryFact["status"] {
  if (value === "active" || value === "needs_check" || value === "superseded") return value;
  throw new Error(`${label} is invalid`);
}

function validateMemoryEntityStatus(value: unknown, label: string): MemoryEntity["status"] {
  if (value === "active" || value === "stale" || value === "superseded") return value;
  throw new Error(`${label} is invalid`);
}

function validateMemorySequence(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function memoryString(value: unknown, label: string, maxLength: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (value.length > maxLength) throw new Error(`${label} exceeds the maximum length of ${maxLength}`);
  return value;
}

function memoryObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function memoryHasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function memoryExactKeys(record: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new Error(`${label} contains unknown field ${key}`);
  for (const key of required) if (!memoryHasOwn(record, key)) throw new Error(`${label}.${key} is required`);
}

/** Pure state transition shared by the trajectory reducer and MemoryStore. */
export function reduceMemoryMutation(state: MemoryState, mutation: MemoryMutation): MemoryState {
  const next: MemoryState = {
    runId: state.runId,
    facts: state.facts.map(normalizeMemoryFactForState),
    entities: state.entities.map((entity) => ({
      ...entity,
      ...(entity.relatedTaskIds === undefined ? {} : { relatedTaskIds: [...entity.relatedTaskIds] }),
    })),
  };
  switch (mutation.operation) {
    case "upsert_fact": {
      const index = next.facts.findIndex((fact) => fact.id === mutation.fact.id);
      const fact = normalizeMemoryFactForState(mutation.fact);
      if (index < 0) next.facts.push(fact); else next.facts[index] = fact;
      return next;
    }
    case "supersede_fact": {
      const index = next.facts.findIndex((fact) => fact.id === mutation.factId);
      const existing = index >= 0 ? next.facts[index] : undefined;
      if (existing !== undefined) next.facts[index] = { ...existing, status: "superseded" };
      if (mutation.replacement !== undefined) next.facts.push(normalizeMemoryFactForState(mutation.replacement));
      return next;
    }
    case "mark_fact_needs_check": {
      const index = next.facts.findIndex((fact) => fact.id === mutation.factId);
      const existing = index >= 0 ? next.facts[index] : undefined;
      if (existing !== undefined && existing.status !== "superseded") next.facts[index] = { ...existing, status: "needs_check", statusReason: mutation.reason ?? "manual_review" };
      return next;
    }
    case "upsert_entity": {
      const index = next.entities.findIndex((entity) => entity.id === mutation.entity.id);
      if (index < 0) next.entities.push(mutation.entity); else next.entities[index] = mutation.entity;
      return next;
    }
    case "invalidate_entity": {
      const index = next.entities.findIndex((entity) => entity.id === mutation.entityId);
      const existing = index >= 0 ? next.entities[index] : undefined;
      if (existing !== undefined) next.entities[index] = { ...existing, status: "stale" };
      return next;
    }
  }
}

export type PlanningTaskMutation =
  | { operation: "created"; task: PlanningTask }
  | { operation: "updated"; task: PlanningTask };

export interface Viewport {
  width: number;
  height: number;
  coordinateSpace: "physical" | "logical" | "reference";
}

export interface Point {
  x: number;
  y: number;
}

export interface AssetRef {
  assetId: AssetId;
  relativePath: string;
  mediaType: string;
  byteLength: number;
}

export interface ObservationFrame {
  id: ObservationId;
  runId: RunId;
  computerSessionId: ComputerSessionId;
  capturedAt: string;
  viewport: Viewport;
  screenshot: AssetRef;
}

/** Raw computer output before Runtime persists its screenshot asset. */
export interface ObservationCapture {
  capturedAt: string;
  viewport: Viewport;
  screenshot: {
    mediaType: "image/png" | "image/jpeg";
    data: Uint8Array;
  };
}

export type DeclaredActionEffect =
  | "observe"
  | "navigate"
  | "local_edit"
  | "destructive"
  | "financial"
  | "external_commitment"
  | "sensitive_disclosure"
  | "security_change"
  | "unknown";

export interface ActionEffectDeclaration {
  effects: DeclaredActionEffect[];
  target: string;
  summary: string;
}

export interface ToolCall {
  id: ToolCallId;
  name: string;
  arguments: JsonValue;
  /** Model-declared immediate effect. It is advisory metadata, never an execution argument. */
  declaredEffect?: ActionEffectDeclaration;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ToolResult =
  | {
      callId: ToolCallId;
      status: "completed";
      output: JsonValue;
    }
  | {
      callId: ToolCallId;
      status: "failed";
      error: { code: string; message: string };
    }
  | {
      callId: ToolCallId;
      status: "rejected";
      error: { code: string; message: string };
    };

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Provider-reported prompt cache reads; absent means unknown, not zero. */
  cacheReadTokens?: number;
}

/**
 * Provider-owned continuation data that must survive a subsequent request in
 * the same Run.  The protocol keeps the payload narrow and serializable; a
 * Provider Adapter decides whether it can consume a particular kind.
 */
export interface ModelContinuation {
  providerId: string;
  kind: "reasoning_content";
  content: string;
}

export type ModelTurn =
  | {
      type: "tool_calls";
      calls: ToolCall[];
      assistantText?: string;
      continuation?: ModelContinuation;
      usage?: ModelUsage;
    }
  | {
      type: "user_input_required";
      question: string;
      usage?: ModelUsage;
    }
  | {
      type: "finish";
      summary: string;
      /** Structured termination status supplied by providers that expose it. */
      reportedStatus?: "success" | "failure";
      usage?: ModelUsage;
    };

export interface GuiActionBase {
  actionId: ActionId;
  basedOn: ObservationId;
}

export type ActionIntent =
  | (GuiActionBase & { kind: "click"; point: Point })
  | (GuiActionBase & { kind: "double_click"; point: Point })
  | (GuiActionBase & { kind: "right_click"; point: Point })
  | (GuiActionBase & { kind: "type"; text: string })
  | (GuiActionBase & { kind: "keypress"; keys: string[] })
  | (GuiActionBase & {
      kind: "scroll";
      point: Point;
      direction: "up" | "down" | "left" | "right";
      /** Positive driver-independent wheel ticks; the Computer adapter chooses its unit mapping. */
      ticks: number;
    })
  | (GuiActionBase & { kind: "drag"; from: Point; to: Point })
  | { actionId: ActionId; kind: "wait"; durationMs: number };

/** Redacted action shape persisted by the Guard; typed text remains only in the ToolCall/action execution path. */
export type ActionGuardActionSummary =
  | Exclude<ActionIntent, GuiActionBase & { kind: "type" }>
  | (GuiActionBase & { kind: "type"; textLength: number });

export interface ActionReceipt {
  actionId: ActionId;
  status: "completed" | "refused" | "failed" | "cancelled";
  driverCode?: string;
  message?: string;
}

export interface ComputerCapabilities {
  screenshot: boolean;
  pointer: boolean;
  keyboard: boolean;
  accessibility: boolean;
}

/** Stable, serializable description of an opened Computer session. */
export interface ComputerSessionDescriptor {
  readonly id: ComputerSessionId;
  readonly backend: string;
  readonly viewport: Readonly<Viewport>;
  readonly capabilities: Readonly<ComputerCapabilities>;
  readonly openedAt: string;
}

export type RunStatus =
  | "created"
  | "starting"
  | "running"
  | "waiting_user"
  | "waiting_approval"
  | "paused"
  | "finished";

export type RunOutcome =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "budget_exhausted"
  | "outcome_unknown";

export type RiskCategory =
  | "destructive"
  | "financial"
  | "external_commitment"
  | "privacy_account"
  | "intent_violation";

export type ActionGuardDecision = "allow" | "require_approval" | "deny";
export type ActionGuardPath = "local" | "model" | "fallback";

export interface RuntimeEventBase {
  eventId: EventId;
  runId: RunId;
  sequence: number;
  occurredAt: string;
}

export type ContextTraceDiscardReason = "history_limit" | "input_budget";

export type MemoryRecallExclusionReason = "superseded" | "scope_mismatch" | "entity_stale" | "entity_missing";

export interface ContextMemorySelectionTrace {
  admittedFactIds: readonly string[];
  revalidationFactIds: readonly string[];
  excluded: readonly { kind: "fact" | "entity"; id: string; reason: MemoryRecallExclusionReason }[];
}

/** Private diagnostic metadata emitted alongside a prepared Provider request;
 * it contains no body/path, and its hash is not an anonymity guarantee. */
export interface PreparedRequestEstimate {
  readonly estimatedTextTokens: number;
  readonly imageCount: number;
  readonly estimationMethod: "context_report" | "provider_projection";
}

export interface PreparedRequestMetadata {
  readonly payloadHash: string;
  readonly estimate?: PreparedRequestEstimate;
}

/**
 * Private diagnostic explanation of one Context projection. It contains
 * identifiers, counts, reasons and hashes only; it never carries prompt text,
 * asset bytes or local paths. Hashes are not an anonymity guarantee.
 */
export interface ContextTrace {
  compilerVersion: string;
  runId: RunId;
  stablePrefixHash: string;
  fixedBlocks: readonly {
    name: "system" | "goal" | "tools" | "plan" | "memory";
    estimatedTokens: number;
    included: boolean;
  }[];
  selectedEventIds: readonly EventId[];
  /** Events actually represented in ModelInput history or latest image. */
  projectedEventIds?: readonly EventId[];
  discardedEvents: readonly { eventId: EventId; reason: ContextTraceDiscardReason }[];
  authoritativeUserEventIds: readonly EventId[];
  historyEstimatedTokens: number;
  historyBudgetTokens?: number;
  memoryEstimatedTokens?: number;
  memoryTruncated?: boolean;
  memorySelection?: ContextMemorySelectionTrace;
  observationIncluded: boolean;
  preparedRequest?: PreparedRequestMetadata;
}

export type RuntimeEventData =
  | { type: "run.created"; goal: string }
  | { type: "run.started" }
  | { type: "computer.open.started" }
  | { type: "computer.open.completed"; session: ComputerSessionDescriptor }
  | { type: "observation.created"; observation: ObservationFrame }
  | { type: "model.request.started"; providerId: string; requestId?: string; decisionId?: string; attempt?: number; preparedRequest?: PreparedRequestMetadata; contextBudget?: { mode: "raw" | "recent"; estimatedInputTokens: number; estimatedFixedTextTokens?: number; estimatedHistoryTextTokens?: number; estimatedToolSchemaTokens?: number; imageCount?: number; selectedHistoryEvents: number; omittedHistoryEvents: number; maxHistoryEvents?: number; maxInputTokens?: number; estimatedMemoryTokens?: number; memoryMaxTokens?: number; trace?: ContextTrace } }
  | { type: "model.response.received"; requestId?: string; decisionId?: string; attempt?: number; turn: ModelTurn }
  | {
      type: "model.request.failed";
      category: string;
      message: string;
      code?: string;
      retryable?: boolean;
      requestId?: string;
      decisionId?: string;
      attempt?: number;
    }
  | { type: "tool.call.received"; call: ToolCall }
  | { type: "tool.call.rejected"; callId: ToolCallId; reason: string }
  | { type: "tool.call.completed"; result: Extract<ToolResult, { status: "completed" }> }
  | {
      type: "tool.call.failed";
      result: Extract<ToolResult, { status: "failed" }>;
    }
  | { type: "action.proposed"; callId: ToolCallId; action: ActionIntent; executionObservationId?: ObservationId }
  | {
      type: "action.guard.evaluated";
      callIds: ToolCallId[];
      actions: ActionGuardActionSummary[];
      decision: ActionGuardDecision;
      categories: RiskCategory[];
      reasonCode: string;
      reason: string;
      path: ActionGuardPath;
      policyVersion: string;
      assessorId?: string;
      semanticEffects?: DeclaredActionEffect[];
      alignment?: "aligned" | "conflicts" | "unclear";
      modelRequestCount: number;
      latencyMs?: number;
      usage?: ModelUsage;
    }
  | { type: "action.execution.started"; action: ActionIntent; executionObservationId?: ObservationId }
  | { type: "action.execution.completed"; receipt: ActionReceipt }
  | { type: "action.execution.failed"; receipt: ActionReceipt }
  | { type: "planning.task.updated"; callId: ToolCallId; mutation: PlanningTaskMutation }
  | { type: "memory.updated"; callId: ToolCallId; mutation: MemoryMutation }
  | { type: "run.paused"; reason: string }
  | { type: "run.resumed" }
  | { type: "approval.requested"; requestId: string; callId: ToolCallId; reason: string }
  | { type: "approval.resolved"; requestId: string; approved: boolean }
  | { type: "user.input.requested"; question: string }
  | { type: "user.input.received"; text: string }
  | { type: "runtime.error"; category: string; message: string }
  | {
      type: "run.finished";
      outcome: RunOutcome;
      summary?: string;
      reportedStatus?: "success" | "failure";
    };

export type RuntimeEvent = RuntimeEventBase & RuntimeEventData;

export type RuntimeEventType = RuntimeEventData["type"];

/**
 * The runtime discriminator list is kept next to the event union so a newly
 * added event cannot silently be omitted from schema and compatibility tests.
 */
export const runtimeEventTypes = [
  "run.created",
  "run.started",
  "computer.open.started",
  "computer.open.completed",
  "observation.created",
  "model.request.started",
  "model.response.received",
  "model.request.failed",
  "tool.call.received",
  "tool.call.rejected",
  "tool.call.completed",
  "tool.call.failed",
  "action.proposed",
  "action.guard.evaluated",
  "action.execution.started",
  "action.execution.completed",
  "action.execution.failed",
  "planning.task.updated",
  "memory.updated",
  "run.paused",
  "run.resumed",
  "approval.requested",
  "approval.resolved",
  "user.input.requested",
  "user.input.received",
  "runtime.error",
  "run.finished",
] as const satisfies readonly RuntimeEventType[];

type MissingRuntimeEventTypes = Exclude<RuntimeEventType, (typeof runtimeEventTypes)[number]>;
type UnexpectedRuntimeEventTypes = Exclude<(typeof runtimeEventTypes)[number], RuntimeEventType>;
type RuntimeEventTypesAreComplete =
  [MissingRuntimeEventTypes, UnexpectedRuntimeEventTypes] extends [never, never] ? true : false;
const runtimeEventTypesAreComplete: RuntimeEventTypesAreComplete = true;

export type RuntimeEventDraft = RuntimeEventData & {
  runId: RunId;
  eventId?: EventId;
  occurredAt?: string;
};
