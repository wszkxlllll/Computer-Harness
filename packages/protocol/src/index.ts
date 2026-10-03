export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type RunId = Brand<string, "RunId">;
export type ComputerSessionId = Brand<string, "ComputerSessionId">;
export type SurfaceId = Brand<string, "SurfaceId">;
export type ObservationId = Brand<string, "ObservationId">;
export type ActionId = Brand<string, "ActionId">;
export type ToolCallId = Brand<string, "ToolCallId">;
export type EventId = Brand<string, "EventId">;
export type AssetId = Brand<string, "AssetId">;

/** A run-scoped, generation-checked address for the exact UI surface captured by an Observation. */
/** `unknown` is reserved for legacy trajectory decoding; live producers must never emit it. */
export type SurfaceKind = "desktop" | "native_window" | "browser_tab" | "dom" | "overlay" | "unknown";

/** Adapter-attested source for transient child Surface admission; never an HWND or UI label. */
export type SurfaceAdmissionSource =
  | "same_hwnd_overlay_root_proof"
  | "owned_transient_window_root_proof"
  | "win32_relationship_probe";

export type SurfaceTransitionReason =
  | "initial_observation"
  | "peer_switch"
  | "child_push"
  | "child_pop"
  | "generation_advanced"
  | "surface_changed";

export interface SurfaceRef {
  readonly surfaceId: SurfaceId;
  readonly generation: number;
  readonly kind: SurfaceKind;
  /** Exact direct parent for a registry-backed child Surface; omitted for root peers and legacy unknowns. */
  readonly parentSurfaceId?: SurfaceId;
  /** Present only when a transient child was admitted from exact root/owner evidence. */
  readonly admissionSource?: SurfaceAdmissionSource;
}

export type ResponseDetailPreference = "concise" | "standard" | "detailed";
export type StepExplanationPreference = "standard" | "more";
export type PreferredLanguagePreference = "follow_conversation" | "zh-CN" | "en";

/** Versioned, provider-neutral answer preferences frozen for one Run. */
export interface RunAssistantPreferencesSnapshot {
  readonly version: 1;
  readonly responseDetail: ResponseDetailPreference;
  readonly stepExplanation: StepExplanationPreference;
  readonly preferredLanguage: PreferredLanguagePreference;
  readonly additionalGuidance: string;
}

export const RUN_ASSISTANT_PREFERENCES_MAX_GUIDANCE_CHARS = 600;

/** Strictly validates and safely normalizes the only assistant preferences accepted by a Run. */
export function normalizeRunAssistantPreferencesSnapshot(value: unknown): RunAssistantPreferencesSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("assistantPreferences must be an object");
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = ["version", "responseDetail", "stepExplanation", "preferredLanguage", "additionalGuidance"] as const;
  const ownKeys = Reflect.ownKeys(record);
  if ((Object.getPrototypeOf(record) !== Object.prototype && Object.getPrototypeOf(record) !== null) ||
      ownKeys.length !== expectedKeys.length || ownKeys.some((key) => typeof key !== "string" || !expectedKeys.includes(key as typeof expectedKeys[number]))) {
    throw new Error("assistantPreferences contains unsupported fields");
  }
  if (record.version !== 1) throw new Error("assistantPreferences.version must be 1");
  if (record.responseDetail !== "concise" && record.responseDetail !== "standard" && record.responseDetail !== "detailed") {
    throw new Error("assistantPreferences.responseDetail is invalid");
  }
  if (record.stepExplanation !== "standard" && record.stepExplanation !== "more") {
    throw new Error("assistantPreferences.stepExplanation is invalid");
  }
  if (record.preferredLanguage !== "follow_conversation" && record.preferredLanguage !== "zh-CN" && record.preferredLanguage !== "en") {
    throw new Error("assistantPreferences.preferredLanguage is invalid");
  }
  if (typeof record.additionalGuidance !== "string") throw new Error("assistantPreferences.additionalGuidance must be text");
  if ([...record.additionalGuidance].length > RUN_ASSISTANT_PREFERENCES_MAX_GUIDANCE_CHARS) {
    throw new Error(`assistantPreferences.additionalGuidance exceeds ${RUN_ASSISTANT_PREFERENCES_MAX_GUIDANCE_CHARS} characters`);
  }
  const additionalGuidance = record.additionalGuidance
    .normalize("NFC")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return Object.freeze({
    version: 1,
    responseDetail: record.responseDetail,
    stepExplanation: record.stepExplanation,
    preferredLanguage: record.preferredLanguage,
    additionalGuidance,
  });
}

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

/** Short-lived, observation-driven execution guidance. Unlike PlanState this
 * never represents global task progress or durable completion. */
export interface ExecutionSegmentStep {
  id: string;
  intent: string;
  allowedAction: "click";
  completion: {
    kind: "element_present" | "element_selected" | "element_expanded" | "element_focused";
    text: string;
  };
}

export interface ExecutionSegment {
  id: string;
  objective: string;
  steps: ExecutionSegmentStep[];
  cursor: number;
  status: "active" | "completed" | "invalidated";
  sourceObservationId: ObservationId;
  computerSessionId: ComputerSessionId;
  attemptedStepIds: string[];
  invalidReason?: string;
}

export type ExecutionSegmentMutation =
  | { operation: "set"; segment: ExecutionSegment }
  | { operation: "step_attempted"; segmentId: string; stepId: string }
  | { operation: "advanced"; segmentId: string; cursor: number; status: "active" | "completed" }
  | { operation: "invalidated"; segmentId: string; reason: string };

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

export type MemoryFactAdmission =
  | { kind: "admitted" }
  | { kind: "revalidation"; reason: "needs_check" | "short_lived_last_known" }
  | { kind: "excluded"; reason: "superseded" | "scope_mismatch" | "entity_stale" | "entity_missing" };

/**
 * The single current-view gate shared by Context and Memory read tools.  It
 * separates ordinary facts from last-known/revalidation candidates before a
 * caller projects values into a model-facing structure.
 */
export function classifyMemoryFactAdmission(
  state: MemoryState,
  fact: MemoryFact,
  context: { runId?: RunId; computerSessionId?: ComputerSessionId } = {},
): MemoryFactAdmission {
  if (fact.status === "superseded") return { kind: "excluded", reason: "superseded" };
  if ((context.runId !== undefined && state.runId !== context.runId) || !isMemoryFactScopeApplicable(fact, context.computerSessionId)) {
    return { kind: "excluded", reason: "scope_mismatch" };
  }
  if (!isMemoryFactApplicable(state, fact, context.computerSessionId)) {
    const subject = fact.subject;
    const entity = subject.type === "entity"
      ? state.entities.find((candidate) => candidate.id === subject.entityId)
      : undefined;
    return { kind: "excluded", reason: entity === undefined ? "entity_missing" : "entity_stale" };
  }
  if (fact.status === "needs_check") return { kind: "revalidation", reason: "needs_check" };
  if (memoryFactRetentionClass(fact) === "short_lived") return { kind: "revalidation", reason: "short_lived_last_known" };
  return { kind: "admitted" };
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

/** A bounded, redacted UI grounding box in the observation's physical pixels. */
export interface GroundingBoundingBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly coordinateSpace: "physical";
}

/**
 * Public grounding provenance.  The backend identity, selector and node
 * handle remain private to the Computer adapter; only this coarse provenance
 * is safe to use for deterministic fusion and diagnostics.
 */
export type GroundingElementSource = "uia" | "dom";
export type GroundingCatalogSource = GroundingElementSource | "hybrid";
export type GroundingCatalogVersion = "uia-catalog-v1" | "grounding-catalog-v2";
export type GroundingBrowserRegion = "content" | "chrome" | "unknown";

/** Low-sensitivity state that may help a model choose an interaction target. */
export interface GroundingElementState {
  readonly enabled?: boolean;
  readonly focused?: boolean;
  readonly editable?: boolean;
  readonly expanded?: boolean;
  readonly selected?: boolean;
  /** Only whether a value exists; the value itself is never exposed here. */
  readonly valuePresent?: boolean;
}

/**
 * A bounded native-select option projection. It contains only visible text
 * and effective enabled state; option values, ids and selectors never cross
 * the adapter boundary. The list is observation-bound and expires with its
 * parent GroundingElement.
 */
export interface GroundingOption {
  readonly text: string;
  readonly enabled: boolean;
}

/**
 * A model-facing element reference. It is minted by a Computer adapter and is
 * valid only for this observation/session/target geometry. It is not a CUA
 * token, PID, HWND, selector, or other backend identity.
 */
export interface GroundingElement {
  readonly elementRef: string;
  readonly role: string;
  readonly name?: string;
  readonly description?: string;
  readonly bbox?: GroundingBoundingBox;
  readonly state?: GroundingElementState;
  /** Coarse source only; raw accessibility/DOM identities never cross this boundary. */
  readonly source?: GroundingElementSource;
  /** Browser content vs browser chrome/native UI; omitted for non-browser UIA. */
  readonly browserRegion?: GroundingBrowserRegion;
  /** Produced only for native DOM <select> elements; omitted for UIA/ARIA. */
  readonly options?: readonly GroundingOption[];
  /** True when more than the bounded visible-option projection was present. */
  readonly optionsTruncated?: boolean;
}

export type GroundingCompleteness = "complete" | "partial" | "unknown";

/** Deterministic, runtime-owned projection metadata for a bounded catalog. */
export interface GroundingSelectionTrace {
  readonly strategy: "deterministic-lexical-v1" | "bounded-fusion-v1";
  /** Number of safe adapter candidates before the runtime hot-element cap. */
  readonly candidateElementCount: number;
  readonly selectedElementRefs: readonly string[];
  readonly truncated: boolean;
  readonly reasons: readonly {
    readonly elementRef: string;
    readonly codes: readonly string[];
  }[];
  /** Counts only; names, selectors, node ids and values are never traced. */
  readonly sourceCounts?: Readonly<Partial<Record<GroundingElementSource, number>>>;
  readonly deduplicatedElementCount?: number;
  readonly recovery?: GroundingRecoveryTrace;
}

/**
 * A short-lived, low-sensitivity hint produced by Runtime's existing Monitor
 * path.  It is a selector input, not a second retry/stop loop.  The action id
 * is opaque and the region is limited to the latest observation's pixels.
 */
export interface GroundingRecoveryHint {
  readonly actionId?: ActionId;
  readonly reason: "no_observed_change" | "repeated_failure" | "repeated_refusal" | "unknown_outcome" | "action_stall";
  readonly attempt: number;
  readonly region?: GroundingBoundingBox;
  /** Bounded local intent, normally the latest user correction or action label. */
  readonly localIntent?: string;
  readonly localIntentSource?: "user_correction" | "active_plan" | "goal_background" | "declared_effect" | "provider_hint";
}

/** Redacted selector trace for a recovery hint; no user text is retained. */
export interface GroundingRecoveryTrace {
  readonly reason: GroundingRecoveryHint["reason"];
  readonly attempt: number;
  readonly regionApplied: boolean;
  readonly localIntentApplied: boolean;
  readonly localIntentSource?: GroundingRecoveryHint["localIntentSource"];
  readonly actionId?: ActionId;
}

/**
 * Bounded sidecar evidence attached to one ObservationFrame. Raw UIA/DOM
 * trees and backend references stay inside the Computer adapter.
 */
export interface GroundingCatalog {
  readonly version: GroundingCatalogVersion;
  readonly source: GroundingCatalogSource;
  readonly observationId: ObservationId;
  readonly computerSessionId: ComputerSessionId;
  /** Exact Surface incarnation whose pixels/UIA/DOM produced this catalog. */
  readonly surfaceRef: SurfaceRef;
  readonly completeness: GroundingCompleteness;
  readonly degraded: boolean;
  /** Adapter safety cap (currently at most 256); Runtime persists a hot subset. */
  readonly maxElements: number;
  readonly elements: readonly GroundingElement[];
  /** Present when Runtime narrowed an adapter catalog for persistence/Context. */
  readonly selection?: GroundingSelectionTrace;
}

export interface ObservationFrame {
  id: ObservationId;
  runId: RunId;
  computerSessionId: ComputerSessionId;
  /** Exact Surface incarnation represented by screenshot and grounding. */
  surfaceRef: SurfaceRef;
  capturedAt: string;
  viewport: Viewport;
  screenshot: AssetRef;
  readonly grounding?: GroundingCatalog;
}

/** Exact persisted observation shown with one computer-action approval. */
export interface ApprovalEvidence {
  readonly observationId: ObservationId;
  readonly decisionObservationId: ObservationId;
  readonly assetId: AssetId;
  readonly capturedAt: string;
  readonly viewport: Viewport;
  /** The decision Observation's exact Surface incarnation. */
  readonly surfaceRef: SurfaceRef;
}

/** Raw computer output before Runtime persists its screenshot asset. */
export interface ObservationCapture {
  capturedAt: string;
  viewport: Viewport;
  /** Producer-owned address of the Surface represented by this capture. */
  surfaceRef: SurfaceRef;
  /** Producer hint for the observed ref change; absent when the Surface is unchanged. */
  readonly surfaceTransitionReason?: SurfaceTransitionReason;
  screenshot: {
    mediaType: "image/png" | "image/jpeg";
    data: Uint8Array;
  };
  readonly grounding?: GroundingCatalog;
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

export type ObservationActionOutcome = "expected_change" | "no_effect" | "unexpected_change" | "uncertain";

export interface ObservationAssessment {
  /** Exact current Observation that the assessment describes. */
  observationId: ObservationId;
  /** The immediately preceding GUI action associated with that Observation. */
  actionId: ActionId;
  actionOutcome: ObservationActionOutcome;
  /** Concise, untrusted evidence from the visible state. */
  evidence: string;
  /**
   * Optional user-facing report grounded in the exact current observation.
   * `milestone` is a user-level stage result visible now, including a stable
   * result that may have existed before the immediately preceding action;
   * it does not claim that action caused the result. `blocked` is an explicit
   * visible blocker or request for user attention. Consumers must validate
   * that this observation was included in the response request and sanitize
   * the summary before speaking it. Action and Monitor fields remain diagnostic.
   */
  progress?: {
    kind: "milestone" | "blocked";
    summary: string;
  };
}

export type ModelTurn =
  | {
      type: "tool_calls";
      calls: ToolCall[];
      assistantText?: string;
      observationAssessment?: ObservationAssessment;
      continuation?: ModelContinuation;
      usage?: ModelUsage;
    }
  | {
      type: "user_input_required";
      question: string;
      observationAssessment?: ObservationAssessment;
      usage?: ModelUsage;
    }
  | {
      type: "finish";
      summary: string;
      /** Structured termination status supplied by providers that expose it. */
      reportedStatus?: "success" | "failure";
      observationAssessment?: ObservationAssessment;
      usage?: ModelUsage;
    };

export interface GuiActionBase {
  actionId: ActionId;
  basedOn: ObservationId;
  /** Public observation element reference, revalidated by the Computer adapter; never a raw driver token. */
  groundingRef?: string;
}

/** A model-visible reference to one host-discovered opened window. The
 * reference is opaque and is resolved only by the Computer adapter that
 * created it; host window identifiers and adapter handles stay private. */
export interface ComputerWindowOption {
  readonly windowRef: string;
  readonly appName?: string;
  readonly title?: string;
  readonly isCurrent: boolean;
}

/** A bounded, deterministic projection of the latest opened-window topology.
 * `omittedCount` makes the fixed option budget visible to the model so it
 * cannot mistake a truncated candidate list for a complete inventory. */
export interface ComputerWindowList {
  readonly options: readonly ComputerWindowOption[];
  readonly truncated: boolean;
  readonly omittedCount: number;
}

export type SwitchWindowAction = GuiActionBase & {
  kind: "switch_window";
  windowRef: string;
};

export type ActionIntent =
  | (GuiActionBase & { kind: "click"; point: Point })
  | (GuiActionBase & { kind: "double_click"; point: Point })
  | (GuiActionBase & { kind: "right_click"; point: Point })
  | (GuiActionBase & { kind: "type"; text: string })
  | (GuiActionBase & { kind: "keypress"; keys: string[] })
  | (GuiActionBase & { kind: "select_option"; groundingRef: string; optionText: string })
  | (GuiActionBase & {
      kind: "scroll";
      point: Point;
      direction: "up" | "down" | "left" | "right";
      /** Positive driver-independent wheel ticks; the Computer adapter chooses its unit mapping. */
      ticks: number;
    })
  | (GuiActionBase & { kind: "drag"; from: Point; to: Point })
  | SwitchWindowAction
  | { actionId: ActionId; kind: "wait"; durationMs: number };

/** Redacted action shape persisted by the Guard; typed text remains only in the ToolCall/action execution path. */
export type ActionGuardActionSummary =
  | Exclude<ActionIntent, GuiActionBase & { kind: "type" }>
  | (GuiActionBase & { kind: "type"; textLength: number });

export type ActionReceipt =
  | {
      actionId: ActionId;
      status: "completed";
      driverCode?: string;
      message?: string;
      /** Present only on a completed `switch_window`; it carries the updated
       * active-target viewport/capabilities while retaining the same ComputerSession id. */
      sessionAfter?: ComputerSessionDescriptor;
    }
  | {
      actionId: ActionId;
      status: "refused" | "failed" | "cancelled" | "partial";
      driverCode?: string;
      message?: string;
    };

/**
 * Runtime-owned, low-confidence visual evidence for one completed action.
 * It deliberately contains no screenshot bytes, hashes, text or coordinates;
 * the corresponding Observation assets remain the only visual source.
 */
export type ObservationTransition = "changed" | "unchanged" | "unknown";

export interface ComputerCapabilities {
  screenshot: boolean;
  pointer: boolean;
  keyboard: boolean;
  /** Native/OS accessibility availability; DOM grounding is not OS Accessibility. */
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

/** Host window identity and its current human-readable picker metadata. */
export interface ComputerWindowIdentity {
  readonly pid: number;
  readonly windowId: number;
}

export interface ComputerWindowCandidate extends ComputerWindowIdentity {
  readonly appName?: string;
  readonly title?: string;
}

export type RunStatus =
  | "created"
  | "starting"
  | "running"
  | "waiting_user"
  | "waiting_window"
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
  /** Current JSONL writers set this; absent on pre-versioned legacy trajectories. */
  schemaVersion?: 1 | 2;
}

export type ContextTraceDiscardReason = "history_limit" | "input_budget";

export type MemoryRecallExclusionReason = "superseded" | "scope_mismatch" | "entity_stale" | "entity_missing";

export interface ContextMemorySelectionTrace {
  /** IDs actually represented in the rendered memory text. */
  admittedFactIds: readonly string[];
  revalidationFactIds: readonly string[];
  /** Candidate IDs selected before the shared memory text budget was applied. */
  selectedAdmittedFactIds?: readonly string[];
  selectedRevalidationFactIds?: readonly string[];
  omitted?: readonly { id: string; class: "admitted" | "revalidation"; reason: "budget" | "not_rendered" }[];
  excluded: readonly { kind: "fact" | "entity"; id: string; reason: MemoryRecallExclusionReason }[];
}

/** Safe automatic Memory retrieval metadata; never includes query/value/vector text. */
export interface ContextMemoryRetrievalTrace {
  method: "lexical" | "hybrid";
  semanticStatus: "used" | "disabled" | "not_needed" | "unavailable" | "timed_out";
  stateStable: boolean;
  embeddingBudgetUsed: number;
  embeddingBudgetLimit: number;
  admitted: readonly { id: string; score: number; match: "exact" | "lexical" | "semantic" }[];
  revalidation: readonly { id: string; score: number; match: "exact" | "lexical" | "semantic"; reason?: "needs_check" | "short_lived_last_known" }[];
}

/** Redacted accounting for the dynamic Observation grounding projection. */
export interface ContextGroundingTrace {
  readonly present: boolean;
  readonly projected: boolean;
  readonly truncated: boolean;
  readonly completeness: GroundingCompleteness;
  readonly candidateElementCount: number;
  readonly projectedElementCount: number;
  readonly estimatedTokens: number;
  readonly strategy?: "deterministic-lexical-v1" | "bounded-fusion-v1" | "adapter-bounded-v1";
  readonly source?: GroundingCatalogSource;
  readonly sourceCounts?: Readonly<Partial<Record<GroundingElementSource, number>>>;
  readonly deduplicatedElementCount?: number;
  readonly selectedElementRefs?: readonly string[];
  readonly selectionReasons?: readonly { elementRef: string; codes: readonly string[] }[];
  readonly recovery?: GroundingRecoveryTrace;
}

/** Redacted accounting for the late, provider-neutral answer-preference message. */
export interface ContextAssistantPreferencesTrace {
  readonly projectionVersion: 1;
  readonly included: boolean;
  readonly omittedReason?: "budget";
  /** Candidate projection token estimate, including values omitted by the budget. */
  readonly estimatedTokens: number;
  readonly responseDetail: ResponseDetailPreference;
  readonly stepExplanation: StepExplanationPreference;
  readonly preferredLanguage: PreferredLanguagePreference;
  readonly additionalGuidancePresent: boolean;
  readonly additionalGuidanceCharacters: number;
  readonly additionalGuidanceSha256?: string;
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
    name: "system" | "goal" | "tools" | "plan" | "execution_segment" | "memory";
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
  memoryRetrieval?: ContextMemoryRetrievalTrace;
  grounding?: ContextGroundingTrace;
  assistantPreferences?: ContextAssistantPreferencesTrace;
  observationIncluded: boolean;
  monitorGuidanceIncluded?: boolean;
  monitorGuidanceOmittedReason?: "budget";
  preparedRequest?: PreparedRequestMetadata;
}

export type RuntimeEventData =
  | { type: "run.created"; goal: string }
  | { type: "run.started" }
  | { type: "computer.open.started" }
  | { type: "computer.open.completed"; session: ComputerSessionDescriptor }
  | { type: "computer.window.handoff.requested"; sourceActionId: ActionId; reasonCode: "foreground_mismatch" | "new_window_detected" }
  | { type: "computer.window.handoff.completed"; target: ComputerWindowIdentity; session: ComputerSessionDescriptor }
  | { type: "computer.window.handoff.ignored"; sourceActionId: ActionId }
  | { type: "observation.created"; observation: ObservationFrame }
  | {
      type: "computer.surface.transitioned";
      from: SurfaceRef | null;
      to: SurfaceRef;
      reason: SurfaceTransitionReason;
    }
  | { type: "model.request.started"; providerId: string; requestId?: string; decisionId?: string; attempt?: number; preparedRequest?: PreparedRequestMetadata; contextBudget?: { mode: "raw" | "recent"; estimatedInputTokens: number; estimatedFixedTextTokens?: number; estimatedHistoryTextTokens?: number; estimatedToolSchemaTokens?: number; imageCount?: number; selectedHistoryEvents: number; omittedHistoryEvents: number; maxHistoryEvents?: number; maxInputTokens?: number; estimatedMemoryTokens?: number; memoryMaxTokens?: number; estimatedMonitorGuidanceTokens?: number; monitorGuidanceIncluded?: boolean; estimatedGroundingTokens?: number; groundingIncluded?: boolean; trace?: ContextTrace } }
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
      type: "grounding.coordinate_coverage";
      actionId: ActionId;
      observationId: ObservationId;
      /** Decision producer. Historical events may omit this field. */
      decisionSource?: "main_provider";
      mapping: "containment" | "nearest" | "none";
      matchedElementRef?: string;
      inHotProjection: boolean;
      normalizedDistance?: number;
    }
  | {
      type: "action.guard.evaluated";
      evaluatedSurfaceRef: SurfaceRef;
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
  | { type: "execution.segment.updated"; callId?: ToolCallId; source: "tool" | "runtime"; mutation: ExecutionSegmentMutation }
  | { type: "memory.updated"; callId?: ToolCallId; source?: "tool" | "lifecycle"; mutation: MemoryMutation }
  | {
      type: "monitor.proposal";
      mode: "shadow" | "guidance";
      proposal: "candidate" | "guidance" | "help_requested" | "suppressed_by_execution_barrier";
      fingerprint: string;
      sourceEventIds: EventId[];
      reasonCodes: string[];
      evidenceKinds: string[];
      modelDecisionCount: number;
      guiActionCount: number;
      guidanceText?: string;
    }
  | {
      type: "monitor.transition";
      actionId: ActionId;
      preObservationId?: ObservationId;
      postObservationId: ObservationId;
      sourceActionEventId: EventId;
      sourceObservationEventId: EventId;
      transition: ObservationTransition;
    }
  | { type: "run.paused"; reason: string }
  | { type: "run.resumed" }
  | {
      type: "approval.requested";
      requestId: string;
      callId: ToolCallId;
      reason: string;
      /** Trusted approval subject classification; older events omit it. */
      requiresVisualReview?: boolean;
      /** Present for computer actions and bound to the exact screenshot shown for approval. */
      evidence?: ApprovalEvidence;
      /** Redacted action details; raw typed text is never included. */
      actions?: ActionGuardActionSummary[];
    }
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
  "computer.window.handoff.requested",
  "computer.window.handoff.completed",
  "computer.window.handoff.ignored",
  "observation.created",
  "computer.surface.transitioned",
  "model.request.started",
  "model.response.received",
  "model.request.failed",
  "tool.call.received",
  "tool.call.rejected",
  "tool.call.completed",
  "tool.call.failed",
  "action.proposed",
  "grounding.coordinate_coverage",
  "action.guard.evaluated",
  "action.execution.started",
  "action.execution.completed",
  "action.execution.failed",
  "planning.task.updated",
  "execution.segment.updated",
  "memory.updated",
  "monitor.proposal",
  "monitor.transition",
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
