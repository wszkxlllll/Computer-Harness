import type { PlanState, MemoryEntity, MemoryFact, MemoryState } from "@computer-harness/protocol";

export interface MemoryRecallLimits {
  maxIndexFacts?: number;
  maxIndexEntities?: number;
  maxHotFacts?: number;
  maxHotEntities?: number;
}
export interface MemoryContextSelection {
  indexFacts: readonly MemoryFact[];
  indexEntities: readonly MemoryEntity[];
  hotFacts: readonly MemoryFact[];
  hotEntities: readonly MemoryEntity[];
}

export function selectMemoryForContext(
  memory: MemoryState,
  plan: PlanState | undefined,
  limits: MemoryRecallLimits = {},
): MemoryContextSelection {
  const maxIndexFacts = limits.maxIndexFacts ?? 20;
  const maxIndexEntities = limits.maxIndexEntities ?? 10;
  const maxHotFacts = limits.maxHotFacts ?? 8;
  const maxHotEntities = limits.maxHotEntities ?? 4;
  const taskPriority = new Map<string, number>();
  for (const task of plan?.tasks ?? []) {
    taskPriority.set(task.id, task.status === "in_progress" ? 4 : task.status === "pending" ? 3 : task.status === "blocked" ? 2 : 1);
  }
  const relevance = (ids: readonly string[] | undefined): number => Math.max(0, ...(ids ?? []).map((id) => taskPriority.get(id) ?? 0));
  const entityById = new Map(memory.entities.map((entity) => [entity.id, entity]));
  const factScore = (fact: MemoryFact): readonly number[] => [
    Math.max(relevance(fact.relatedTaskIds), fact.subject.type === "entity" ? relevance(entityById.get(fact.subject.entityId)?.relatedTaskIds) : 0),
    fact.status === "needs_check" ? 2 : 1,
    fact.updatedSequence,
  ];
  const entityScore = (entity: MemoryEntity): readonly number[] => [
    relevance(entity.relatedTaskIds),
    entity.updatedSequence,
  ];
  const compare = (left: readonly number[], right: readonly number[]): number => {
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      const difference = (right[index] ?? 0) - (left[index] ?? 0);
      if (difference !== 0) return difference;
    }
    return 0;
  };
  const activeFacts = memory.facts.filter((fact) => (fact.status === "active" || fact.status === "needs_check") && (fact.subject.type === "run" || entityById.get(fact.subject.entityId)?.status === "active")).sort((left, right) => compare(factScore(left), factScore(right)));
  const activeEntities = memory.entities.filter((entity) => entity.status === "active").sort((left, right) => compare(entityScore(left), entityScore(right)));
  const candidateFacts = activeFacts.slice(0, maxIndexFacts);
  const requiredEntityIds = [...new Set(candidateFacts.flatMap((fact) => fact.subject.type === "entity" ? [fact.subject.entityId] : []))];
  const indexEntities: MemoryEntity[] = [];
  for (const entityId of requiredEntityIds) {
    const entity = entityById.get(entityId);
    if (entity !== undefined && entity.status === "active" && indexEntities.length < maxIndexEntities) indexEntities.push(entity);
  }
  for (const entity of activeEntities) {
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
    indexFacts,
    indexEntities,
    hotFacts,
    hotEntities,
  };
}
