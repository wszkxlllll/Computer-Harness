import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { reduceMemoryMutation, type JsonValue, type MemoryEntity, type MemoryFact, type MemoryMutation, type MemoryState, type RunId, type MemorySubject } from "@computer-harness/protocol";
import type { NonComputerToolDefinition } from "@computer-harness/runtime";

export interface MemoryStore {
  get(runId: RunId): Promise<MemoryState>;
  apply(runId: RunId, mutation: MemoryMutation): Promise<MemoryState>;
  rebuild(runId: RunId, mutations: readonly MemoryMutation[]): Promise<MemoryState>;
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly states = new Map<RunId, MemoryState>();

  public async get(runId: RunId): Promise<MemoryState> {
    return cloneMemory(this.states.get(runId) ?? emptyMemory(runId));
  }

  public async apply(runId: RunId, mutation: MemoryMutation): Promise<MemoryState> {
    const next = reduceMemoryMutation(await this.get(runId), mutation);
    this.states.set(runId, next);
    return cloneMemory(next);
  }

  public async rebuild(runId: RunId, mutations: readonly MemoryMutation[]): Promise<MemoryState> {
    let state = emptyMemory(runId);
    for (const mutation of mutations) state = reduceMemoryMutation(state, mutation);
    this.states.set(runId, state);
    return cloneMemory(state);
  }
}

export class FileMemoryStore implements MemoryStore {
  public constructor(private readonly rootDir: string) {}

  public async get(runId: RunId): Promise<MemoryState> {
    try {
      const value = JSON.parse(await readFile(this.pathFor(runId), "utf8")) as unknown;
      if (!isMemoryState(value) || value.runId !== runId) throw new Error("memory.json has an invalid shape");
      return cloneMemory(value);
    } catch (error) {
      if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT") return emptyMemory(runId);
      throw error;
    }
  }

  public async apply(runId: RunId, mutation: MemoryMutation): Promise<MemoryState> {
    const next = reduceMemoryMutation(await this.get(runId), mutation);
    await this.write(runId, next);
    return cloneMemory(next);
  }

  public async rebuild(runId: RunId, mutations: readonly MemoryMutation[]): Promise<MemoryState> {
    let next = emptyMemory(runId);
    for (const mutation of mutations) next = reduceMemoryMutation(next, mutation);
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
          id: { type: "string", minLength: 1, description: "Fact or entity id from the memory index." },
          key: { type: "string", minLength: 1, description: "Fact key when an id is not available." },
        },
        oneOf: [{ required: ["id"] }, { required: ["key"] }],
        additionalProperties: false,
      },
      validate: (args) => {
        if (!isRecord(args)) throw new Error("memory_get requires exactly one of id or key");
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
          key: { type: "string", minLength: 1, description: "Stable fact key, such as target_file or saved." },
          value: { type: "string", description: "Short factual value." },
          entityId: { type: "string", minLength: 1, description: "Optional entity id; omit for a run-level fact." },
          relatedTaskIds: { type: "array", items: { type: "string", minLength: 1 } },
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
        return (existing === undefined || existing.value === input.value
          ? { operation: "upsert_fact", fact: { ...fact, id: existing?.id ?? fact.id } }
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
        properties: { factId: { type: "string", minLength: 1 } },
        required: ["factId"],
        additionalProperties: false,
      },
      validate: (args) => {
        if (!isRecord(args) || typeof args.factId !== "string" || args.factId.trim().length === 0) throw new Error("memory_mark_fact_needs_check requires factId");
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
          entityId: { type: "string", minLength: 1, description: "Existing entity id to update; omit to create or deduplicate." },
          type: { type: "string", minLength: 1 },
          description: { type: "string", minLength: 1 },
          relatedTaskIds: { type: "array", items: { type: "string", minLength: 1 } },
        },
        required: ["type", "description"],
        additionalProperties: false,
      },
      validate: (args) => {
        if (!isRecord(args) || typeof args.type !== "string" || args.type.trim().length === 0 || typeof args.description !== "string" || args.description.trim().length === 0) throw new Error("memory_upsert_entity requires type and description");
        if (args.entityId !== undefined && (typeof args.entityId !== "string" || args.entityId.trim().length === 0)) throw new Error("memory_upsert_entity.entityId must be a non-empty string");
        if (args.relatedTaskIds !== undefined && (!Array.isArray(args.relatedTaskIds) || args.relatedTaskIds.some((id) => typeof id !== "string" || id.trim().length === 0))) throw new Error("memory_upsert_entity.relatedTaskIds must be non-empty strings");
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
        properties: { entityId: { type: "string", minLength: 1 } },
        required: ["entityId"],
        additionalProperties: false,
      },
      validate: (args) => {
        if (!isRecord(args) || typeof args.entityId !== "string" || args.entityId.trim().length === 0) throw new Error("memory_invalidate_entity requires entityId");
      },
      execute: async (args, context) => {
        const entityId = (args as { entityId: string }).entityId;
        if (!(await store.get(context.runId)).entities.some((entity) => entity.id === entityId && entity.status === "active")) throw new Error(`memory entity ${entityId} does not exist`);
        return { operation: "invalidate_entity", entityId } as unknown as JsonValue;
      },
      memoryMutationFromResult: (output) => {
        if (!isRecord(output) || output.operation !== "invalidate_entity" || typeof output.entityId !== "string") throw new Error("memory entity invalidation has invalid mutation");
        return { operation: "invalidate_entity", entityId: output.entityId };
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

function isMemoryState(value: unknown): value is MemoryState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { runId?: unknown; facts?: unknown; entities?: unknown };
  return typeof candidate.runId === "string" && Array.isArray(candidate.facts) && Array.isArray(candidate.entities);
}

function validateWriteFact(args: JsonValue): void {
  const value = writeFactArgs(args);
  if (value.key.trim().length === 0) throw new Error("memory_write_fact.key must be non-empty");
}

function writeFactArgs(args: JsonValue): { key: string; value: string; entityId?: string; relatedTaskIds?: string[] } {
  if (!isRecord(args) || typeof args.key !== "string" || typeof args.value !== "string") throw new Error("memory_write_fact requires key and value");
  if (args.entityId !== undefined && (typeof args.entityId !== "string" || args.entityId.length === 0)) throw new Error("entityId must be a non-empty string");
  if (args.relatedTaskIds !== undefined && (!Array.isArray(args.relatedTaskIds) || args.relatedTaskIds.some((id) => typeof id !== "string" || id.length === 0))) throw new Error("relatedTaskIds must be non-empty strings");
  return { key: args.key, value: args.value, ...(args.entityId === undefined ? {} : { entityId: args.entityId }), ...(args.relatedTaskIds === undefined ? {} : { relatedTaskIds: [...args.relatedTaskIds] as string[] }) };
}

function readFactMutation(value: JsonValue): MemoryMutation {
  if (!isRecord(value) || typeof value.operation !== "string") throw new Error("memory tool result has invalid mutation");
  const fact = value.fact;
  if (value.operation === "upsert_fact" && fact !== undefined && isRecord(fact) && typeof fact.id === "string") return { operation: "upsert_fact", fact: fact as unknown as MemoryFact };
  if (value.operation === "supersede_fact" && typeof value.factId === "string") {
    const replacement = value.replacement;
    return {
      operation: "supersede_fact",
      factId: value.factId,
      ...(replacement === undefined ? {} : { replacement: replacement as unknown as MemoryFact }),
    };
  }
  if (value.operation === "mark_fact_needs_check" && typeof value.factId === "string") return { operation: "mark_fact_needs_check", factId: value.factId };
  throw new Error("memory tool result has invalid mutation");
}

function readEntityMutation(value: JsonValue): MemoryMutation {
  if (!isRecord(value) || value.operation !== "upsert_entity" || value.entity === undefined || !isRecord(value.entity) || typeof value.entity.id !== "string") throw new Error("memory entity result has invalid mutation");
  return { operation: "upsert_entity", entity: value.entity as unknown as MemoryEntity };
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
