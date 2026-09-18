import {
  sameMemoryFactContent,
  validateMemoryMutation,
  type JsonValue,
  type MemoryEntity,
  type MemoryFact,
  type MemoryMutation,
  type MemoryState,
  type MemorySubject,
  type RunId,
} from "@computer-harness/protocol";
import {
  MAX_MEMORY_DESCRIPTION_LENGTH,
  MAX_MEMORY_ENTITY_TYPE_LENGTH,
  MAX_MEMORY_ID_LENGTH,
  MAX_MEMORY_KEY_LENGTH,
  MAX_MEMORY_RUN_ID_LENGTH,
  MAX_MEMORY_SOURCE_EVENT_ID_LENGTH,
  MAX_MEMORY_VALUE_LENGTH,
  MAX_RELATED_TASK_ID_LENGTH,
  MAX_RELATED_TASK_IDS,
} from "./constants.js";

export function emptyMemory(runId: RunId): MemoryState { return { runId, facts: [], entities: [] }; }

export function cloneMemory(state: MemoryState): MemoryState {
  return {
    runId: state.runId,
    facts: state.facts.map(cloneFact),
    entities: state.entities.map((entity) => ({
      ...entity,
      sourceEventId: entity.sourceEventId ?? "legacy:entity-source" as import("@computer-harness/protocol").EventId,
      ...(entity.relatedTaskIds === undefined ? {} : { relatedTaskIds: [...entity.relatedTaskIds] }),
    })),
  };
}

function cloneFact(fact: MemoryFact): MemoryFact {
  return { ...fact, subject: fact.subject ?? { type: "run" }, ...(fact.relatedTaskIds === undefined ? {} : { relatedTaskIds: [...fact.relatedTaskIds] }) };
}

export function parseMemoryState(value: unknown, expectedRunId?: RunId): MemoryState {
  const record = asObjectRecord(value, "memory.json");
  assertExactKeys(record, ["runId", "facts", "entities"], [], "memory.json");
  const runId = boundedString(record.runId, "memory.json.runId", MAX_MEMORY_RUN_ID_LENGTH);
  if (expectedRunId !== undefined && runId !== expectedRunId) throw new Error("memory.json.runId does not match the requested run");
  if (!Array.isArray(record.facts) || !Array.isArray(record.entities)) throw new Error("memory.json.facts and entities must be arrays");
  const entities = record.entities.map((item, index) => parseMemoryEntity(item, `memory.json.entities[${index}]`, true));
  const facts = record.facts.map((item, index) => parseMemoryFact(item, `memory.json.facts[${index}]`, true));
  validateUniqueMemoryIds(facts, entities);
  const entityIds = new Set(entities.map((item) => item.id));
  for (const [index, item] of facts.entries()) {
    if (item.subject.type === "entity" && !entityIds.has(item.subject.entityId)) throw new Error(`memory.json.facts[${index}].subject references unknown entity ${item.subject.entityId}`);
  }
  return { runId: runId as RunId, facts, entities };
}

export function validateMemoryState(state: MemoryState, expectedRunId: RunId): void {
  parseMemoryState(state, expectedRunId);
}

export function normalizeMemoryMutation(value: unknown): MemoryMutation {
  return validateMemoryMutation(value);
}

function parseMemoryFact(value: unknown, label: string, allowLegacySubject: boolean): MemoryFact {
  const record = asObjectRecord(value, label);
  assertExactKeys(record, ["id", "key", "value", "sourceEventId", "status", "updatedSequence"], ["subject", "relatedTaskIds"], label);
  const subject = parseMemorySubject(record.subject, `${label}.subject`, allowLegacySubject);
  const valueText = boundedString(record.value, `${label}.value`, MAX_MEMORY_VALUE_LENGTH, true);
  const status = parseFactStatus(record.status, `${label}.status`);
  const updatedSequence = nonNegativeSequence(record.updatedSequence, `${label}.updatedSequence`);
  return {
    id: boundedString(record.id, `${label}.id`, MAX_MEMORY_ID_LENGTH),
    subject,
    key: boundedString(record.key, `${label}.key`, MAX_MEMORY_KEY_LENGTH),
    value: valueText,
    sourceEventId: boundedString(record.sourceEventId, `${label}.sourceEventId`, MAX_MEMORY_SOURCE_EVENT_ID_LENGTH) as import("@computer-harness/protocol").EventId,
    status,
    ...(record.relatedTaskIds === undefined ? {} : { relatedTaskIds: parseRelatedTaskIds(record.relatedTaskIds, `${label}.relatedTaskIds`) }),
    updatedSequence,
  };
}

function parseMemoryEntity(value: unknown, label: string, allowLegacySource: boolean): MemoryEntity {
  const record = asObjectRecord(value, label);
  assertExactKeys(record, ["id", "type", "description", "status", "updatedSequence"], ["sourceEventId", "relatedTaskIds"], label);
  const sourceEventId = record.sourceEventId === undefined && allowLegacySource ? "legacy:entity-source" : boundedString(record.sourceEventId, `${label}.sourceEventId`, MAX_MEMORY_SOURCE_EVENT_ID_LENGTH);
  const description = boundedString(record.description, `${label}.description`, MAX_MEMORY_DESCRIPTION_LENGTH);
  const status = parseEntityStatus(record.status, `${label}.status`);
  const updatedSequence = nonNegativeSequence(record.updatedSequence, `${label}.updatedSequence`);
  return {
    id: boundedString(record.id, `${label}.id`, MAX_MEMORY_ID_LENGTH),
    type: boundedString(record.type, `${label}.type`, MAX_MEMORY_ENTITY_TYPE_LENGTH),
    description,
    sourceEventId: sourceEventId as import("@computer-harness/protocol").EventId,
    status,
    ...(record.relatedTaskIds === undefined ? {} : { relatedTaskIds: parseRelatedTaskIds(record.relatedTaskIds, `${label}.relatedTaskIds`) }),
    updatedSequence,
  };
}

function parseMemorySubject(value: unknown, label: string, allowLegacySubject: boolean): MemorySubject {
  if (value === undefined && allowLegacySubject) return { type: "run" };
  const record = asObjectRecord(value, label);
  if (record.type === "run") {
    assertExactKeys(record, ["type"], [], label);
    return { type: "run" };
  }
  if (record.type === "entity") {
    assertExactKeys(record, ["type", "entityId"], [], label);
    return { type: "entity", entityId: boundedString(record.entityId, `${label}.entityId`, MAX_MEMORY_ID_LENGTH) };
  }
  throw new Error(`${label}.type must be run or entity`);
}

function parseRelatedTaskIds(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > MAX_RELATED_TASK_IDS) throw new Error(`${label} exceeds the maximum of ${MAX_RELATED_TASK_IDS} items`);
  const ids: string[] = [];
  for (const [index, item] of value.entries()) {
    const id = boundedString(item, `${label}[${index}]`, MAX_RELATED_TASK_ID_LENGTH);
    if (ids.includes(id)) throw new Error(`${label} contains duplicate task id ${id}`);
    ids.push(id);
  }
  return ids;
}

function parseFactStatus(value: unknown, label: string): MemoryFact["status"] {
  if (value === "active" || value === "needs_check" || value === "superseded") return value;
  throw new Error(`${label} is invalid`);
}

function parseEntityStatus(value: unknown, label: string): MemoryEntity["status"] {
  if (value === "active" || value === "stale" || value === "superseded") return value;
  throw new Error(`${label} is invalid`);
}

function nonNegativeSequence(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function boundedString(value: unknown, label: string, maxLength: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) throw new Error(`${label} must be a non-empty string`);
  if (value.length > maxLength) throw new Error(`${label} exceeds the maximum length of ${maxLength}`);
  return value;
}

export function validateBoundedString(value: unknown, label: string, maxLength: number, allowEmpty = false): asserts value is string {
  boundedString(value, label, maxLength, allowEmpty);
}

export function validateRelatedTaskIds(value: unknown, label: string): asserts value is string[] {
  parseRelatedTaskIds(value, label);
}

function asObjectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function assertExactKeys(record: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new Error(`${label} contains unknown field ${key}`);
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(record, key)) throw new Error(`${label}.${key} is required`);
}

function validateUniqueMemoryIds(facts: readonly MemoryFact[], entities: readonly MemoryEntity[]): void {
  const ids = new Set<string>();
  for (const item of [...facts, ...entities]) {
    if (ids.has(item.id)) throw new Error(`memory.json contains duplicate id ${item.id}`);
    ids.add(item.id);
  }
}

export function validateMutationReferences(state: MemoryState, mutation: MemoryMutation): void {
  switch (mutation.operation) {
    case "upsert_fact":
      validateFactReference(state, mutation.fact, "memory fact");
      return;
    case "supersede_fact": {
      const existing = state.facts.find((fact) => fact.id === mutation.factId);
      if (existing === undefined || existing.status === "superseded") throw new Error(`memory fact ${mutation.factId} does not exist or is superseded`);
      if (mutation.replacement !== undefined) {
        if (mutation.replacement.id === mutation.factId) throw new Error("memory replacement must have a distinct fact id");
        if (state.facts.some((fact) => fact.id === mutation.replacement?.id) || state.entities.some((entity) => entity.id === mutation.replacement?.id)) throw new Error(`memory replacement id ${mutation.replacement.id} already exists`);
        validateFactReference(state, mutation.replacement, "memory replacement");
      }
      return;
    }
    case "mark_fact_needs_check": {
      const existing = state.facts.find((fact) => fact.id === mutation.factId);
      if (existing === undefined || existing.status === "superseded") throw new Error(`memory fact ${mutation.factId} does not exist or is superseded`);
      return;
    }
    case "upsert_entity": {
      const existing = state.entities.find((entity) => entity.id === mutation.entity.id);
      if (state.facts.some((fact) => fact.id === mutation.entity.id)) throw new Error(`memory entity id ${mutation.entity.id} collides with a fact id`);
      if (existing !== undefined && existing.status !== "active") throw new Error(`memory entity ${mutation.entity.id} is not active`);
      return;
    }
    case "invalidate_entity": {
      const existing = state.entities.find((entity) => entity.id === mutation.entityId);
      if (existing === undefined || existing.status !== "active") throw new Error(`memory entity ${mutation.entityId} does not exist or is not active`);
      return;
    }
  }
}

function validateFactReference(state: MemoryState, fact: MemoryFact, label: string): void {
  if (state.entities.some((entity) => entity.id === fact.id)) throw new Error(`${label} id ${fact.id} collides with an entity id`);
  const existing = state.facts.find((item) => item.id === fact.id);
  if (existing !== undefined && existing.status === "superseded") throw new Error(`${label} id ${fact.id} is superseded`);
  if (existing !== undefined && !sameMemoryFactContent(existing, fact)) {
    throw new Error(`${label} id ${fact.id} already exists; changed content requires supersede_fact`);
  }
  const subject = fact.subject;
  if (subject.type === "entity") {
    const entity = state.entities.find((item) => item.id === subject.entityId);
    if (entity === undefined || entity.status !== "active") throw new Error(`${label} subject references an unknown or inactive entity ${subject.entityId}`);
  }
}

export function validateWriteFact(args: JsonValue): void {
  const value = writeFactArgs(args);
  if (value.key.trim().length === 0) throw new Error("memory_write_fact.key must be non-empty");
}

export function writeFactArgs(args: JsonValue): { key: string; value: string; entityId?: string; relatedTaskIds?: string[] } {
  if (!isRecord(args)) throw new Error("memory_write_fact requires an object");
  assertExactKeys(args, ["key", "value"], ["entityId", "relatedTaskIds"], "memory_write_fact");
  if (typeof args.key !== "string" || typeof args.value !== "string") throw new Error("memory_write_fact requires key and value");
  validateBoundedString(args.key, "memory_write_fact.key", MAX_MEMORY_KEY_LENGTH);
  validateBoundedString(args.value, "memory_write_fact.value", MAX_MEMORY_VALUE_LENGTH, true);
  if (args.entityId !== undefined) validateBoundedString(args.entityId, "memory_write_fact.entityId", MAX_MEMORY_ID_LENGTH);
  if (args.relatedTaskIds !== undefined) validateRelatedTaskIds(args.relatedTaskIds, "memory_write_fact.relatedTaskIds");
  return { key: args.key, value: args.value, ...(args.entityId === undefined ? {} : { entityId: args.entityId }), ...(args.relatedTaskIds === undefined ? {} : { relatedTaskIds: [...args.relatedTaskIds] as string[] }) };
}

export function readFactMutation(value: JsonValue): MemoryMutation {
  const mutation = normalizeMemoryMutation(value);
  if (mutation.operation === "upsert_fact" || mutation.operation === "supersede_fact" || mutation.operation === "mark_fact_needs_check") return mutation;
  throw new Error("memory tool result has invalid fact mutation");
}

export function readEntityMutation(value: JsonValue): MemoryMutation {
  const mutation = normalizeMemoryMutation(value);
  if (mutation.operation !== "upsert_entity") throw new Error("memory entity result has invalid mutation");
  return mutation;
}

export function isRecord(value: JsonValue): value is Record<string, JsonValue> { return typeof value === "object" && value !== null && !Array.isArray(value); }

export function sameSubject(left: MemorySubject, right: MemorySubject): boolean {
  return left.type === right.type && (left.type === "run" || right.type === "run" || left.entityId === right.entityId);
}

export function nextMemoryId(existing: readonly string[], prefix: string): string {
  const used = new Set(existing);
  let index = existing.length + 1;
  while (used.has(`${prefix}${index}`)) index += 1;
  return `${prefix}${index}`;
}
