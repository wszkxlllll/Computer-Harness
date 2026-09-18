import {
  isMemoryFactApplicable,
  isMemoryFactScopeApplicable,
  memoryFactRetentionClass,
  type ComputerSessionId,
  type MemoryEntity,
  type MemoryFact,
  type MemoryState,
  type PlanState,
  type RunId,
} from "@computer-harness/protocol";

export interface MemoryRecallLimits {
  maxIndexFacts?: number;
  maxIndexEntities?: number;
  maxHotFacts?: number;
  maxHotEntities?: number;
  maxRevalidationFacts?: number;
  maxExcluded?: number;
}

export interface MemoryRecallContext {
  runId?: RunId;
  computerSessionId?: ComputerSessionId;
}

export type MemoryRevalidationReason = "needs_check" | "short_lived_last_known";

export interface MemoryRevalidationCandidate {
  fact: MemoryFact;
  reason: MemoryRevalidationReason;
}

export interface MemoryExcludedRecord {
  kind: "fact" | "entity";
  id: string;
  reason: "superseded" | "scope_mismatch" | "entity_stale" | "entity_missing";
}

export interface MemoryContextSelection {
  /** Normal current/admitted facts only; safe for normal and hot values. */
  admittedFacts: readonly MemoryFact[];
  /** Last-known or needs-check facts, kept separate from current values. */
  revalidationCandidates: readonly MemoryRevalidationCandidate[];
  /** Bounded, safe IDs and reasons; no values or descriptions. */
  excluded: readonly MemoryExcludedRecord[];
  indexFacts: readonly MemoryFact[];
  indexEntities: readonly MemoryEntity[];
  hotFacts: readonly MemoryFact[];
  hotEntities: readonly MemoryEntity[];
}

export function selectMemoryForContext(
  memory: MemoryState,
  plan: PlanState | undefined,
  limits: MemoryRecallLimits = {},
  context: MemoryRecallContext = {},
): MemoryContextSelection {
  const maxIndexFacts = limits.maxIndexFacts ?? 20;
  const maxIndexEntities = limits.maxIndexEntities ?? 10;
  const maxHotFacts = limits.maxHotFacts ?? 8;
  const maxHotEntities = limits.maxHotEntities ?? 4;
  const maxRevalidationFacts = limits.maxRevalidationFacts ?? 4;
  const maxExcluded = limits.maxExcluded ?? 32;
  const taskPriority = new Map<string, number>();
  for (const task of plan?.tasks ?? []) {
    taskPriority.set(task.id, task.status === "in_progress" ? 4 : task.status === "pending" ? 3 : task.status === "blocked" ? 2 : 1);
  }
  const relevance = (ids: readonly string[] | undefined): number => Math.max(0, ...(ids ?? []).map((id) => taskPriority.get(id) ?? 0));
  const entityById = new Map(memory.entities.map((entity) => [entity.id, entity]));
  const excluded: MemoryExcludedRecord[] = [];
  const revalidationCandidates: MemoryRevalidationCandidate[] = [];
  const admittedFacts: MemoryFact[] = [];
  const activeEntities: MemoryEntity[] = [];
  const memoryRunApplicable = context.runId === undefined || memory.runId === context.runId;

  for (const entity of memory.entities) {
    if (!memoryRunApplicable) excluded.push({ kind: "entity", id: entity.id, reason: "scope_mismatch" });
    else if (entity.status === "active") activeEntities.push(entity);
    else excluded.push({ kind: "entity", id: entity.id, reason: "entity_stale" });
  }

  for (const fact of memory.facts) {
    if (fact.status === "superseded") {
      excluded.push({ kind: "fact", id: fact.id, reason: "superseded" });
      continue;
    }
    if (!memoryRunApplicable || !isMemoryFactScopeApplicable(fact, context.computerSessionId)) {
      excluded.push({ kind: "fact", id: fact.id, reason: "scope_mismatch" });
      continue;
    }
    if (!isMemoryFactApplicable(memory, fact, context.computerSessionId)) {
      const entity = fact.subject.type === "entity" ? entityById.get(fact.subject.entityId) : undefined;
      excluded.push({ kind: "fact", id: fact.id, reason: entity === undefined ? "entity_missing" : "entity_stale" });
      continue;
    }
    if (fact.status === "needs_check") {
      revalidationCandidates.push({ fact, reason: "needs_check" });
    } else if (memoryFactRetentionClass(fact) === "short_lived") {
      revalidationCandidates.push({ fact, reason: "short_lived_last_known" });
    } else {
      admittedFacts.push(fact);
    }
  }

  const boundedExcluded = excluded.slice(0, maxExcluded);
  const revalidationScore = (candidate: MemoryRevalidationCandidate): readonly number[] => [
    Math.max(relevance(candidate.fact.relatedTaskIds), candidate.fact.subject.type === "entity" ? relevance(entityById.get(candidate.fact.subject.entityId)?.relatedTaskIds) : 0),
    candidate.reason === "needs_check" ? 2 : 1,
    candidate.fact.updatedSequence,
  ];
  const factScore = (fact: MemoryFact): readonly number[] => [
    Math.max(relevance(fact.relatedTaskIds), fact.subject.type === "entity" ? relevance(entityById.get(fact.subject.entityId)?.relatedTaskIds) : 0),
    memoryFactRetentionClass(fact) === "stable" ? 2 : 1,
    fact.status === "needs_check" ? 0 : 1,
    fact.updatedSequence,
  ];
  const entityScore = (entity: MemoryEntity): readonly number[] => [relevance(entity.relatedTaskIds), entity.updatedSequence];
  const compare = (left: readonly number[], right: readonly number[]): number => {
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      const difference = (right[index] ?? 0) - (left[index] ?? 0);
      if (difference !== 0) return difference;
    }
    return 0;
  };
  const boundedRevalidation = revalidationCandidates.sort((left, right) => compare(revalidationScore(left), revalidationScore(right))).slice(0, maxRevalidationFacts);
  const candidateFacts = admittedFacts.sort((left, right) => compare(factScore(left), factScore(right))).slice(0, maxIndexFacts);
  const sortedEntities = activeEntities.sort((left, right) => compare(entityScore(left), entityScore(right)));
  const requiredEntityIds = [...new Set(candidateFacts.flatMap((fact) => fact.subject.type === "entity" ? [fact.subject.entityId] : []))];
  const indexEntities: MemoryEntity[] = [];
  for (const entityId of requiredEntityIds) {
    const entity = entityById.get(entityId);
    if (entity !== undefined && entity.status === "active" && indexEntities.length < maxIndexEntities) indexEntities.push(entity);
  }
  for (const entity of sortedEntities) {
    if (indexEntities.length >= maxIndexEntities) break;
    if (!indexEntities.some((selected) => selected.id === entity.id)) indexEntities.push(entity);
  }
  const indexedEntityIds = new Set(indexEntities.map((entity) => entity.id));
  const indexFacts = candidateFacts.filter((fact) => fact.subject.type === "run" || indexedEntityIds.has(fact.subject.entityId));
  const hotFacts = indexFacts.slice(0, maxHotFacts);
  const hotFactEntityIds = new Set(hotFacts.flatMap((fact) => fact.subject.type === "entity" ? [fact.subject.entityId] : []));
  const hotEntities = [
    ...indexEntities.filter((entity) => hotFactEntityIds.has(entity.id)),
    ...indexEntities.filter((entity) => !hotFactEntityIds.has(entity.id)),
  ].slice(0, maxHotEntities);
  return {
    admittedFacts: candidateFacts,
    revalidationCandidates: boundedRevalidation,
    excluded: boundedExcluded,
    indexFacts,
    indexEntities,
    hotFacts,
    hotEntities,
  };
}
