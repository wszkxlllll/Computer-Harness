import { randomUUID } from "node:crypto";
import {
  classifyMemoryFactAdmission,
  memoryFactScope,
  sameMemoryFactContent,
  type JsonValue,
  type MemoryEntity,
  type MemoryFact,
  type MemoryMutation,
  type MemorySubject,
} from "@computer-harness/protocol";
import type { NonComputerToolDefinition } from "@computer-harness/runtime";
import {
  MAX_MEMORY_DESCRIPTION_LENGTH,
  MAX_MEMORY_ENTITY_TYPE_LENGTH,
  MAX_MEMORY_ID_LENGTH,
  MAX_MEMORY_KEY_LENGTH,
  MAX_MEMORY_VALUE_LENGTH,
  MAX_RELATED_TASK_ID_LENGTH,
  MAX_RELATED_TASK_IDS,
} from "./constants.js";
import type { MemoryStore } from "./store.js";
import type { HybridMemoryRecallService } from "./retrieval/hybrid-recall.js";
import {
  assertExactKeys,
  isRecord,
  nextMemoryId,
  normalizeMemoryMutation,
  readEntityMutation,
  readFactMutation,
  sameSubject,
  validateBoundedString,
  validateRelatedTaskIds,
  validateWriteFact,
  writeFactArgs,
} from "./validation.js";

export type MemoryToolMode = "facts" | "entities";

export interface MemoryToolOptions {
  /** When present, exposes the bounded model-facing memory_search tool. */
  readonly retrieval?: HybridMemoryRecallService;
}

/** Model proposes semantic changes; Runtime supplies IDs and event provenance. */
export function createMemoryTools(store: MemoryStore, mode: MemoryToolMode = "facts", options: MemoryToolOptions = {}): readonly NonComputerToolDefinition[] {
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
          view: { type: "string", enum: ["current", "history"], description: "Current applicable records by default; history is explicit and marks scope applicability." },
        },
        oneOf: [{ required: ["id"] }, { required: ["key"] }],
        additionalProperties: false,
      },
      validate: (args) => {
        if (!isRecord(args)) throw new Error("memory_get requires exactly one of id or key");
        assertExactKeys(args, [], ["id", "key", "view"], "memory_get");
        if (args.id !== undefined) validateBoundedString(args.id, "memory_get.id", MAX_MEMORY_ID_LENGTH);
        if (args.key !== undefined) validateBoundedString(args.key, "memory_get.key", MAX_MEMORY_KEY_LENGTH);
        if (args.view !== undefined && args.view !== "current" && args.view !== "history") throw new Error("memory_get.view must be current or history");
        const hasId = typeof args.id === "string" && args.id.trim().length > 0;
        const hasKey = typeof args.key === "string" && args.key.trim().length > 0;
        if (hasId === hasKey || (args.id !== undefined && !hasId) || (args.key !== undefined && !hasKey)) throw new Error("memory_get requires exactly one of id or key");
      },
      execute: async (args, context) => {
        const query = args as { id?: string; key?: string; view?: "current" | "history" };
        const state = await store.get(context.runId);
        const view = query.view ?? "current";
        const entities = query.id === undefined ? [] : state.entities.filter((entity) => entity.id === query.id);
        const matchedFacts = query.id !== undefined
          ? state.facts.filter((fact) => fact.id === query.id || (entities.some((entity) => entity.id === query.id) && fact.subject.type === "entity" && fact.subject.entityId === query.id))
          : state.facts.filter((fact) => fact.key === query.key);
        const admittedFacts: MemoryFact[] = [];
        const revalidationCandidates: Array<{ fact: MemoryFact; reason: "needs_check" | "short_lived_last_known" }> = [];
        for (const fact of matchedFacts) {
          if (view === "history") continue;
          const admission = classifyMemoryFactAdmission(state, fact, { runId: context.runId, ...(context.session?.id === undefined ? {} : { computerSessionId: context.session.id }) });
          if (admission.kind === "admitted") admittedFacts.push(fact);
          else if (admission.kind === "revalidation") revalidationCandidates.push({ fact, reason: admission.reason });
        }
        if (view === "current" && admittedFacts.length === 0 && revalidationCandidates.length === 0 && entities.length === 0) throw new Error("memory_get found no matching record");
        if (view === "history" && matchedFacts.length === 0 && entities.length === 0) throw new Error("memory_get found no matching record");
        return {
          ...(view === "history" ? { facts: matchedFacts } : { admittedFacts, revalidationCandidates }),
          entities: view === "history" ? entities : entities.filter((entity) => entity.status === "active"),
          ...(view === "history"
            ? { factApplicability: matchedFacts.map((fact) => ({ id: fact.id, applicable: classifyMemoryFactAdmission(state, fact, { runId: context.runId, ...(context.session?.id === undefined ? {} : { computerSessionId: context.session.id }) }).kind !== "excluded" })) }
            : {}),
        } as unknown as JsonValue;
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
          scope: { type: "string", enum: ["run", "computer_session"], description: "Applicability scope; Runtime supplies the real session id." },
          retentionClass: { type: "string", enum: ["stable", "task", "short_lived"], description: "Recall policy classification, not truth or authorization." },
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
        if (input.scope === "computer_session" && context.session?.id === undefined) throw new Error("memory computer_session scope is unsupported without a live session");
        if (input.retentionClass === "task" && (input.relatedTaskIds === undefined || input.relatedTaskIds.length === 0)) throw new Error("task retention requires relatedTaskIds");
        if (input.entityId !== undefined && !current.entities.some((entity) => entity.id === input.entityId && entity.status === "active")) throw new Error(`memory entity ${input.entityId} does not exist`);
        const subject: MemorySubject = input.entityId === undefined ? { type: "run" } : { type: "entity", entityId: input.entityId };
        const scope = input.scope === "computer_session" ? { kind: "computer_session" as const, sessionId: context.session.id } : { kind: "run" as const };
        const existing = current.facts.find((fact) => fact.key === input.key && sameSubject(fact.subject, subject) && fact.status !== "superseded" && sameScope(fact, scope));
        const fact: MemoryFact = {
          id: nextMemoryId(current.facts.map((item) => item.id), "m"),
          subject,
          key: input.key,
          value: input.value,
          sourceEventId: `pending:${randomUUID()}` as import("@computer-harness/protocol").EventId,
          status: "active",
          scope,
          retentionClass: input.retentionClass ?? "stable",
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
        properties: {
          factId: { type: "string", minLength: 1, maxLength: MAX_MEMORY_ID_LENGTH },
          reason: { type: "string", enum: ["manual_review"] },
        },
        required: ["factId"],
        additionalProperties: false,
      },
      validate: (args) => {
        if (!isRecord(args)) throw new Error("memory_mark_fact_needs_check requires an object");
        assertExactKeys(args, ["factId"], ["reason"], "memory_mark_fact_needs_check");
        validateBoundedString(args.factId, "memory_mark_fact_needs_check.factId", MAX_MEMORY_ID_LENGTH);
        if (args.reason !== undefined && args.reason !== "manual_review") throw new Error("memory_mark_fact_needs_check.reason is invalid");
      },
      execute: async (args, context) => {
        const factId = (args as { factId: string }).factId;
        if (!(await store.get(context.runId)).facts.some((fact) => fact.id === factId && fact.status !== "superseded")) throw new Error(`memory fact ${factId} does not exist`);
        return { operation: "mark_fact_needs_check", factId, reason: "manual_review" } as unknown as JsonValue;
      },
      memoryMutationFromResult: (output) => readFactMutation(output),
      afterMemoryCommit: async (mutation, context) => { await store.apply(context.runId, mutation); },
    },
  ];
  if (options.retrieval !== undefined) {
    tools.push({
      name: "memory_search",
      description: "Search current applicable Memory by a bounded query. Results are ranked hints, not proof or authorization; superseded and out-of-scope facts are excluded before retrieval.",
      category: "side",
      audiences: ["main", "advisor"],
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, maxLength: 512, description: "Short retrieval query; this cannot change run/session scope or action authorization." },
        },
        required: ["query"],
        additionalProperties: false,
      },
      validate: (args) => {
        if (!isRecord(args)) throw new Error("memory_search requires an object");
        assertExactKeys(args, ["query"], [], "memory_search");
        validateBoundedString(args.query, "memory_search.query", 512);
      },
      execute: async (args, context) => {
        const searchQuery = (args as { query: string }).query;
        const state = await store.get(context.runId);
        const result = await options.retrieval!.search(state, {
          runId: context.runId,
          originalGoal: "",
          explicitQuery: searchQuery,
          ...(context.session?.id === undefined ? {} : { computerSessionId: context.session.id }),
        }, context.signal);
        return {
          admittedFacts: result.admittedFacts.map((item) => ({ fact: item.fact, score: item.score, match: item.match })),
          revalidationCandidates: result.revalidationCandidates.map((item) => ({ fact: item.fact, score: item.score, match: item.match, reason: item.reason })),
          excluded: result.excluded,
          diagnostics: result.diagnostics,
          trace: result.trace,
        } as unknown as JsonValue;
      },
    });
  }
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
      execute: async (_args, context) => {
        const state = await store.get(context.runId);
        const admittedFacts: MemoryFact[] = [];
        const revalidationCandidates: Array<{ fact: MemoryFact; reason: "needs_check" | "short_lived_last_known" }> = [];
        for (const fact of state.facts) {
          const admission = classifyMemoryFactAdmission(state, fact, { runId: context.runId, ...(context.session?.id === undefined ? {} : { computerSessionId: context.session.id }) });
          if (admission.kind === "admitted") admittedFacts.push(fact);
          else if (admission.kind === "revalidation") revalidationCandidates.push({ fact, reason: admission.reason });
        }
        return {
          admittedFacts,
          revalidationCandidates,
          entities: state.entities.filter((entity) => entity.status === "active"),
        } as unknown as JsonValue;
      },
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

function sameScope(fact: MemoryFact, scope: MemoryFact["scope"]): boolean {
  const existing = memoryFactScope(fact);
  if (scope === undefined || existing.kind !== scope.kind) return false;
  return existing.kind === "run" || (scope.kind === "computer_session" && existing.sessionId === scope.sessionId);
}
