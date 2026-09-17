import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MEMORY_LIMITS, reduceMemoryMutation, sameMemoryFactContent, validateMemoryMutation, type JsonValue, type MemoryEntity, type MemoryFact, type MemoryMutation, type MemoryState, type RunId, type MemorySubject } from "@computer-harness/protocol";
import type { NonComputerToolDefinition } from "@computer-harness/runtime";

const MAX_MEMORY_RUN_ID_LENGTH = MEMORY_LIMITS.runId;
const MAX_MEMORY_ID_LENGTH = MEMORY_LIMITS.id;
const MAX_MEMORY_KEY_LENGTH = MEMORY_LIMITS.key;
const MAX_MEMORY_VALUE_LENGTH = MEMORY_LIMITS.value;
const MAX_MEMORY_ENTITY_TYPE_LENGTH = MEMORY_LIMITS.entityType;
const MAX_MEMORY_DESCRIPTION_LENGTH = MEMORY_LIMITS.description;
const MAX_MEMORY_SOURCE_EVENT_ID_LENGTH = MEMORY_LIMITS.sourceEventId;
const MAX_RELATED_TASK_ID_LENGTH = MEMORY_LIMITS.relatedTaskId;
const MAX_RELATED_TASK_IDS = MEMORY_LIMITS.relatedTaskIds;

export interface MemoryStore {
  get(runId: RunId): Promise<MemoryState>;
  apply(runId: RunId, mutation: MemoryMutation): Promise<MemoryState>;
  rebuild(runId: RunId, mutations: readonly MemoryMutation[]): Promise<MemoryState>;
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly states = new Map<RunId, MemoryState>();

  public async get(runId: RunId): Promise<MemoryState> {
    validateBoundedString(runId, "runId", MAX_MEMORY_RUN_ID_LENGTH);
    return cloneMemory(this.states.get(runId) ?? emptyMemory(runId));
  }

  public async apply(runId: RunId, mutation: MemoryMutation): Promise<MemoryState> {
    validateBoundedString(runId, "runId", MAX_MEMORY_RUN_ID_LENGTH);
    const current = await this.get(runId);
    const normalized = normalizeMemoryMutation(mutation);
    validateMutationReferences(current, normalized);
    const next = reduceMemoryMutation(current, normalized);
    validateMemoryState(next, runId);
    this.states.set(runId, next);
    return cloneMemory(next);
  }

  public async rebuild(runId: RunId, mutations: readonly MemoryMutation[]): Promise<MemoryState> {
    validateBoundedString(runId, "runId", MAX_MEMORY_RUN_ID_LENGTH);
    let state = emptyMemory(runId);
    for (const mutation of mutations) {
      const normalized = normalizeMemoryMutation(mutation);
      validateMutationReferences(state, normalized);
      state = reduceMemoryMutation(state, normalized);
    }
    validateMemoryState(state, runId);
    this.states.set(runId, state);
    return cloneMemory(state);
  }
}

export class FileMemoryStore implements MemoryStore {
  public constructor(private readonly rootDir: string) {}

  public async get(runId: RunId): Promise<MemoryState> {
    try {
      const value = JSON.parse(await readFile(this.pathFor(runId), "utf8")) as unknown;
      return cloneMemory(parseMemoryState(value, runId));
    } catch (error) {
      if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT") return emptyMemory(runId);
      if (error instanceof Error && error.message.startsWith("memory.json")) throw error;
      throw new Error(`memory.json is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async apply(runId: RunId, mutation: MemoryMutation): Promise<MemoryState> {
    const current = await this.get(runId);
    const normalized = normalizeMemoryMutation(mutation);
    validateMutationReferences(current, normalized);
    const next = reduceMemoryMutation(current, normalized);
    validateMemoryState(next, runId);
    await this.write(runId, next);
    return cloneMemory(next);
  }

  public async rebuild(runId: RunId, mutations: readonly MemoryMutation[]): Promise<MemoryState> {
    let next = emptyMemory(runId);
    for (const mutation of mutations) {
      const normalized = normalizeMemoryMutation(mutation);
      validateMutationReferences(next, normalized);
      next = reduceMemoryMutation(next, normalized);
    }
    validateMemoryState(next, runId);
    await this.write(runId, next);
    return cloneMemory(next);
  }

  private async write(runId: RunId, state: MemoryState): Promise<void> {
    const path = this.pathFor(runId);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  }

  private pathFor(runId: RunId): string {
    validateBoundedString(runId, "runId", MAX_MEMORY_RUN_ID_LENGTH);
    if (runId.includes("..") || runId.includes("/") || runId.includes("\\")) throw new Error("invalid run id for MemoryStore");
    return join(this.rootDir, runId, "memory.json");
  }
}

export type MemoryToolMode = "facts" | "entities";

/** Model proposes semantic changes; Runtime supplies IDs and event provenance. */
export function createMemoryTools(store: MemoryStore, mode: MemoryToolMode = "facts"): readonly NonComputerToolDefinition[] {
  const tools: NonComputerToolDefinition[] = [
    {
      name: "memory_get",
      description: "Read the full current-run details for one remembered fact or entity by id (or a fact by key) when the compact memory index is insufficient.",
      category: "side",
      audiences: ["main", "advisor"],
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1, maxLength: MAX_MEMORY_ID_LENGTH, description: "Fact or entity id from the memory index." },
          key: { type: "string", minLength: 1, maxLength: MAX_MEMORY_KEY_LENGTH, description: "Fact key when an id is not available." },
        },
        oneOf: [{ required: ["id"] }, { required: ["key"] }],
        additionalProperties: false,
      },
      validate: (args) => {
        if (!isRecord(args)) throw new Error("memory_get requires exactly one of id or key");
        assertExactKeys(args, [], ["id", "key"], "memory_get");
        if (args.id !== undefined) validateBoundedString(args.id, "memory_get.id", MAX_MEMORY_ID_LENGTH);
        if (args.key !== undefined) validateBoundedString(args.key, "memory_get.key", MAX_MEMORY_KEY_LENGTH);
        const hasId = typeof args.id === "string" && args.id.trim().length > 0;
        const hasKey = typeof args.key === "string" && args.key.trim().length > 0;
        if (hasId === hasKey || (args.id !== undefined && !hasId) || (args.key !== undefined && !hasKey)) throw new Error("memory_get requires exactly one of id or key");
      },
      execute: async (args, context) => {
        const query = args as { id?: string; key?: string };
        const state = await store.get(context.runId);
        const entities = query.id === undefined ? [] : state.entities.filter((entity) => entity.id === query.id);
        const facts = query.id !== undefined
          ? state.facts.filter((fact) => fact.id === query.id || (entities.some((entity) => entity.id === query.id) && fact.subject.type === "entity" && fact.subject.entityId === query.id))
          : state.facts.filter((fact) => fact.key === query.key);
        if (facts.length === 0 && entities.length === 0) throw new Error("memory_get found no matching record");
        return { facts, entities } as unknown as JsonValue;
      },
    },
    {
      name: "memory_write_fact",
      description: "Remember one concise fact needed later in this run. Use only for durable task constraints or GUI facts that may leave the recent context; do not duplicate plan progress or record every click.",
      category: "side",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", minLength: 1, maxLength: MAX_MEMORY_KEY_LENGTH, description: "Stable fact key, such as target_file or saved." },
          value: { type: "string", maxLength: MAX_MEMORY_VALUE_LENGTH, description: "Short factual value." },
          entityId: { type: "string", minLength: 1, maxLength: MAX_MEMORY_ID_LENGTH, description: "Optional entity id; omit for a run-level fact." },
          relatedTaskIds: { type: "array", maxItems: MAX_RELATED_TASK_IDS, items: { type: "string", minLength: 1, maxLength: MAX_RELATED_TASK_ID_LENGTH } },
        },
        required: ["key", "value"],
        additionalProperties: false,
      },
      validate: (args) => validateWriteFact(args),
      execute: async (args, context) => {
        const input = writeFactArgs(args);
        const current = await store.get(context.runId);
        if (input.entityId !== undefined && !current.entities.some((entity) => entity.id === input.entityId && entity.status === "active")) throw new Error(`memory entity ${input.entityId} does not exist`);
        const subject: MemorySubject = input.entityId === undefined ? { type: "run" } : { type: "entity", entityId: input.entityId };
        const existing = current.facts.find((fact) => fact.key === input.key && sameSubject(fact.subject, subject) && fact.status !== "superseded");
        const fact: MemoryFact = {
          id: nextMemoryId(current.facts.map((item) => item.id), "m"),
          subject,
          key: input.key,
          value: input.value,
          sourceEventId: `pending:${randomUUID()}` as import("@computer-harness/protocol").EventId,
          status: "active",
          ...(input.relatedTaskIds === undefined ? {} : { relatedTaskIds: input.relatedTaskIds }),
          updatedSequence: current.facts.length,
        };
        const candidate = { ...fact, id: existing?.id ?? fact.id };
        return (existing === undefined || sameMemoryFactContent(existing, candidate)
          ? { operation: "upsert_fact", fact: candidate }
          : { operation: "supersede_fact", factId: existing.id, replacement: fact }) as unknown as JsonValue;
      },
      memoryMutationFromResult: (output) => readFactMutation(output),
      afterMemoryCommit: async (mutation, context) => { await store.apply(context.runId, mutation); },
    },
    {
      name: "memory_mark_fact_needs_check",
      description: "Mark a remembered fact as needing re-check when the GUI or user correction makes it unreliable; keep it available for review.",
      category: "side",
      inputSchema: {
        type: "object",
        properties: { factId: { type: "string", minLength: 1, maxLength: MAX_MEMORY_ID_LENGTH } },
        required: ["factId"],
        additionalProperties: false,
      },
      validate: (args) => {
        if (!isRecord(args)) throw new Error("memory_mark_fact_needs_check requires an object");
        assertExactKeys(args, ["factId"], [], "memory_mark_fact_needs_check");
        validateBoundedString(args.factId, "memory_mark_fact_needs_check.factId", MAX_MEMORY_ID_LENGTH);
      },
      execute: async (args, context) => {
        const factId = (args as { factId: string }).factId;
        if (!(await store.get(context.runId)).facts.some((fact) => fact.id === factId && fact.status !== "superseded")) throw new Error(`memory fact ${factId} does not exist`);
        return { operation: "mark_fact_needs_check", factId } as unknown as JsonValue;
      },
      memoryMutationFromResult: (output) => readFactMutation(output),
      afterMemoryCommit: async (mutation, context) => { await store.apply(context.runId, mutation); },
    },
  ];
  if (mode === "entities") {
    // Entity mutation is intentionally opt-in; facts are the V1 default.
    tools.push({
      name: "memory_upsert_entity",
      description: "Create one durable GUI object when entityId is omitted, or update an existing current-run object by entityId. Use for an object whose identity matters across phases, not for every visible control.",
      category: "side",
      inputSchema: {
        type: "object",
        properties: {
          entityId: { type: "string", minLength: 1, maxLength: MAX_MEMORY_ID_LENGTH, description: "Existing entity id to update; omit to create or deduplicate." },
          type: { type: "string", minLength: 1, maxLength: MAX_MEMORY_ENTITY_TYPE_LENGTH },
          description: { type: "string", minLength: 1, maxLength: MAX_MEMORY_DESCRIPTION_LENGTH },
          relatedTaskIds: { type: "array", maxItems: MAX_RELATED_TASK_IDS, items: { type: "string", minLength: 1, maxLength: MAX_RELATED_TASK_ID_LENGTH } },
        },
        required: ["type", "description"],
        additionalProperties: false,
      },
      validate: (args) => {
        if (!isRecord(args)) throw new Error("memory_upsert_entity requires an object");
        assertExactKeys(args, ["type", "description"], ["entityId", "relatedTaskIds"], "memory_upsert_entity");
        validateBoundedString(args.type, "memory_upsert_entity.type", MAX_MEMORY_ENTITY_TYPE_LENGTH);
        validateBoundedString(args.description, "memory_upsert_entity.description", MAX_MEMORY_DESCRIPTION_LENGTH);
        if (args.entityId !== undefined) validateBoundedString(args.entityId, "memory_upsert_entity.entityId", MAX_MEMORY_ID_LENGTH);
        if (args.relatedTaskIds !== undefined) validateRelatedTaskIds(args.relatedTaskIds, "memory_upsert_entity.relatedTaskIds");
      },
      execute: async (args, context) => {
        const input = args as { entityId?: string; type: string; description: string; relatedTaskIds?: string[] };
        const current = await store.get(context.runId);
        const existing = input.entityId === undefined ? undefined : current.entities.find((item) => item.id === input.entityId && item.status === "active");
        if (input.entityId !== undefined && existing === undefined) throw new Error(`memory entity ${input.entityId} does not exist`);
        const entity: MemoryEntity = {
          id: existing?.id ?? nextMemoryId(current.entities.map((item) => item.id), "e"),
          type: input.type,
          description: input.description,
          sourceEventId: `pending:${randomUUID()}` as import("@computer-harness/protocol").EventId,
          status: "active",
          ...(input.relatedTaskIds === undefined ? {} : { relatedTaskIds: [...input.relatedTaskIds] }),
          updatedSequence: current.entities.length,
        };
        return { operation: "upsert_entity", entity } as unknown as JsonValue;
      },
      memoryMutationFromResult: (output) => readEntityMutation(output),
      afterMemoryCommit: async (mutation, context) => { await store.apply(context.runId, mutation); },
    });
    tools.push({
      name: "memory_list",
      description: "List current run memory facts and active entities when you need to resolve an object identity.",
      category: "side",
      audiences: ["main", "advisor"],
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
      validate: (args) => { if (!isRecord(args) || Object.keys(args).length !== 0) throw new Error("memory_list accepts an empty object"); },
      execute: async (_args, context) => await store.get(context.runId) as unknown as JsonValue,
    });
    tools.push({
      name: "memory_invalidate_entity",
      description: "Mark a tracked GUI object stale after it is closed, renamed, replaced, or contradicted by a later observation.",
      category: "side",
      inputSchema: {
        type: "object",
        properties: { entityId: { type: "string", minLength: 1, maxLength: MAX_MEMORY_ID_LENGTH } },
        required: ["entityId"],
        additionalProperties: false,
      },
      validate: (args) => {
        if (!isRecord(args)) throw new Error("memory_invalidate_entity requires an object");
        assertExactKeys(args, ["entityId"], [], "memory_invalidate_entity");
        validateBoundedString(args.entityId, "memory_invalidate_entity.entityId", MAX_MEMORY_ID_LENGTH);
      },
      execute: async (args, context) => {
        const entityId = (args as { entityId: string }).entityId;
        if (!(await store.get(context.runId)).entities.some((entity) => entity.id === entityId && entity.status === "active")) throw new Error(`memory entity ${entityId} does not exist`);
        return { operation: "invalidate_entity", entityId } as unknown as JsonValue;
      },
      memoryMutationFromResult: (output) => {
        const mutation = normalizeMemoryMutation(output);
        if (mutation.operation !== "invalidate_entity") throw new Error("memory entity invalidation has invalid mutation");
        return mutation;
      },
      afterMemoryCommit: async (mutation, context) => { await store.apply(context.runId, mutation); },
    });
  }
  return tools;
}

function emptyMemory(runId: RunId): MemoryState { return { runId, facts: [], entities: [] }; }

function cloneMemory(state: MemoryState): MemoryState {
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

function parseMemoryState(value: unknown, expectedRunId?: RunId): MemoryState {
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

function validateMemoryState(state: MemoryState, expectedRunId: RunId): void {
  parseMemoryState(state, expectedRunId);
}

function normalizeMemoryMutation(value: unknown): MemoryMutation {
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

function validateBoundedString(value: unknown, label: string, maxLength: number, allowEmpty = false): asserts value is string {
  boundedString(value, label, maxLength, allowEmpty);
}

function validateRelatedTaskIds(value: unknown, label: string): asserts value is string[] {
  parseRelatedTaskIds(value, label);
}

function asObjectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function assertExactKeys(record: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string): void {
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

function validateMutationReferences(state: MemoryState, mutation: MemoryMutation): void {
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

function validateWriteFact(args: JsonValue): void {
  const value = writeFactArgs(args);
  if (value.key.trim().length === 0) throw new Error("memory_write_fact.key must be non-empty");
}

function writeFactArgs(args: JsonValue): { key: string; value: string; entityId?: string; relatedTaskIds?: string[] } {
  if (!isRecord(args)) throw new Error("memory_write_fact requires an object");
  assertExactKeys(args, ["key", "value"], ["entityId", "relatedTaskIds"], "memory_write_fact");
  if (typeof args.key !== "string" || typeof args.value !== "string") throw new Error("memory_write_fact requires key and value");
  validateBoundedString(args.key, "memory_write_fact.key", MAX_MEMORY_KEY_LENGTH);
  validateBoundedString(args.value, "memory_write_fact.value", MAX_MEMORY_VALUE_LENGTH, true);
  if (args.entityId !== undefined) validateBoundedString(args.entityId, "memory_write_fact.entityId", MAX_MEMORY_ID_LENGTH);
  if (args.relatedTaskIds !== undefined) validateRelatedTaskIds(args.relatedTaskIds, "memory_write_fact.relatedTaskIds");
  return { key: args.key, value: args.value, ...(args.entityId === undefined ? {} : { entityId: args.entityId }), ...(args.relatedTaskIds === undefined ? {} : { relatedTaskIds: [...args.relatedTaskIds] as string[] }) };
}

function readFactMutation(value: JsonValue): MemoryMutation {
  const mutation = normalizeMemoryMutation(value);
  if (mutation.operation === "upsert_fact" || mutation.operation === "supersede_fact" || mutation.operation === "mark_fact_needs_check") return mutation;
  throw new Error("memory tool result has invalid fact mutation");
}

function readEntityMutation(value: JsonValue): MemoryMutation {
  const mutation = normalizeMemoryMutation(value);
  if (mutation.operation !== "upsert_entity") throw new Error("memory entity result has invalid mutation");
  return mutation;
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function sameSubject(left: MemorySubject, right: MemorySubject): boolean {
  return left.type === right.type && (left.type === "run" || right.type === "run" || left.entityId === right.entityId);
}

function nextMemoryId(existing: readonly string[], prefix: string): string {
  const used = new Set(existing);
  let index = existing.length + 1;
  while (used.has(`${prefix}${index}`)) index += 1;
  return `${prefix}${index}`;
}
