import type { ComputerSessionId, PlanState, MemoryState } from "@computer-harness/protocol";
import type { RunFeatureConfig } from "@computer-harness/runtime";
import { selectMemoryForContext, type MemoryContextSelection } from "./memory-recall.js";

export function formatPlan(plan: PlanState): string {
  const unfinished = plan.tasks.filter((task) => task.status !== "completed");
  const completedCount = plan.tasks.length - unfinished.length;
  const lines = unfinished.map((task) => {
    const description = task.description === undefined ? "" : ` — ${task.description}`;
    const blockedBy = task.blockedBy === undefined || task.blockedBy.length === 0 ? "" : ` (blocked by ${task.blockedBy.join(", ")})`;
    return `- [${task.status}] ${task.id}: ${task.subject}${description}${blockedBy}`;
  });
  if (lines.length === 0) {
    return `Current run plan (progress declaration, not proof of task completion): no unfinished phases; completed phases: ${completedCount}.`;
  }
  const completedSummary = completedCount === 0 ? "" : `\nCompleted phases: ${completedCount}.`;
  return `Current run plan (optional phase progress, not proof of task completion):\n${lines.join("\n")}${completedSummary}`;
}

export function composeSystemPrompt(base: string, features: RunFeatureConfig): string {
  const sections = [base];
  if (features.planning !== "off") sections.push("Planning tools are optional: use them for handoff-sized phases, real blockers, or goal changes, not for every click. A planning task describes a phase goal and necessary unfinished work; completed is a declared plan state, not official task verification.");
  if (features.memory !== "off") sections.push(`Run Memory is enabled (${features.memory}). Write only durable facts or objects needed later in this Run; do not record every click or duplicate plan progress. Scoped and needs-check entries are applicability-gated; last-known candidates are not current GUI truth, so use the current observation before acting and revise or invalidate explicitly. Read details by id when the compact index is insufficient.`);
  if (features.riskGuard === "layered") sections.push("For every Computer tool call, include _harnessEffect with non-empty effects, target, and summary. Describe this call's immediate expected effect, not the eventual goal: ordinary browsing/navigation is navigate, ordinary reversible typing is local_edit, and final payment, sending/publishing/submission, irreversible deletion/overwrite, sensitive disclosure, or security changes use their matching effect. Use unknown when uncertain. Never include secrets or private content in target/summary, and never claim that an action is approved or safe.");
  if (features.batching === "off") {
    sections.push("Return at most one Computer tool call per model turn.");
  } else {
    sections.push("A model turn may contain up to two Plan/Memory write calls first, followed by one Computer call or one GUI batch. A GUI batch is only click→type, Ctrl+A→type, or click→Ctrl+A→type in the same already-active text control. Do not put read tools, Control decisions, Enter, Tab, submit, navigation, scroll, drag, wait, or state writes after/between GUI calls. Do not claim post-action success before the next observation.");
  }
  return sections.join(" ");
}

export interface MemoryProjection {
  text: string;
  estimatedTokens: number;
  truncated: boolean;
  selection: MemoryContextSelection;
}

export function formatMemory(
  memory: MemoryState,
  plan: PlanState | undefined,
  maxTokens = Number.POSITIVE_INFINITY,
  context: { runId?: import("@computer-harness/protocol").RunId; computerSessionId?: ComputerSessionId } = {},
): MemoryProjection | undefined {
  const selection = selectMemoryForContext(memory, plan, {}, context);
  if (selection.indexFacts.length === 0 && selection.indexEntities.length === 0 && selection.revalidationCandidates.length === 0 && selection.excluded.length === 0) return undefined;
  const hotFactIds = new Set(selection.hotFacts.map((fact) => fact.id));
  const hotEntityIds = new Set(selection.hotEntities.map((entity) => entity.id));
  const indexRecords = [
    ...selection.indexFacts.filter((fact) => !hotFactIds.has(fact.id)).map((fact) => `- fact ${fact.id}${fact.subject.type === "entity" ? ` (entity ${fact.subject.entityId})` : ""}: ${fact.key} [${fact.status}]`),
    ...selection.indexEntities.filter((entity) => !hotEntityIds.has(entity.id)).map((entity) => `- entity ${entity.id} (${entity.type}): ${boundedPreview(entity.description)}`),
  ];
  const hotRecords = [
    ...selection.hotFacts.map((fact) => `- ${fact.id}${fact.subject.type === "entity" ? ` (entity ${fact.subject.entityId})` : ""}: ${fact.key} = ${boundedValue(fact.value)}${fact.status === "needs_check" ? " [needs_check]" : ""}`),
    ...selection.hotEntities.map((entity) => `- ${entity.id}: ${boundedPreview(entity.description)}`),
  ];
  const revalidationRecords = selection.revalidationCandidates.map((candidate) => {
    const fact = candidate.fact;
    return `- ${fact.id}: ${fact.key} [${candidate.reason}] old=${boundedValue(fact.value)} source=${fact.sourceEventId}`;
  });
  const header = "Current run memory index / packets (scoped; not proof of current GUI state):";
  const headerTokens = estimateTextTokens(header);
  const finiteBudget = Number.isFinite(maxTokens);
  let remaining = finiteBudget ? Math.max(0, maxTokens - headerTokens) : Number.POSITIVE_INFINITY;
  let omitted = false;
  const renderedGroups: string[][] = [];
  const renderGroup = (title: string, records: readonly string[], allowance: number): void => {
    if (records.length === 0) return;
    const chosen: string[] = [];
    for (const record of records) {
      const candidate = [title, ...chosen, record];
      if (estimateTextTokens(candidate.join("\n")) > allowance) {
        omitted = true;
        continue;
      }
      chosen.push(record);
    }
    if (chosen.length === 0) {
      omitted = true;
      return;
    }
    const group = [title, ...chosen];
    renderedGroups.push(group);
    remaining -= estimateTextTokens(group.join("\n"));
    if (chosen.length < records.length) omitted = true;
  };
  const hotAllowance = finiteBudget ? Math.floor(remaining * 0.45) : Number.POSITIVE_INFINITY;
  renderGroup("Current admitted values (hot; verify GUI state before side effects):", hotRecords, hotAllowance);
  const revalidationAllowance = finiteBudget ? Math.floor(remaining * 0.55) : Number.POSITIVE_INFINITY;
  renderGroup("Revalidation candidates (last-known only; use current observation, then revise or query by id):", revalidationRecords, revalidationAllowance);
  renderGroup("Memory index (IDs/keys only; not current-value proof):", indexRecords, remaining);
  if (renderedGroups.length === 0) {
    const marker = "[…memory truncated; query by id; packets omitted]";
    const minimal = `${header}\n${marker}`;
    if (!finiteBudget || estimateTextTokens(minimal) <= maxTokens) return { text: minimal, estimatedTokens: estimateTextTokens(minimal), truncated: true, selection };
    return { text: "", estimatedTokens: 0, truncated: true, selection };
  }
  const lines = [header, ...renderedGroups.flat()];
  let text = lines.join("\n");
  if (omitted || selection.excluded.length > 0) {
    const marker = "[…memory truncated; query by id; packets omitted]";
    if (!finiteBudget || estimateTextTokens(`${text}\n${marker}`) <= maxTokens) text = `${text}\n${marker}`;
    else omitted = true;
  }
  return { text, estimatedTokens: estimateTextTokens(text), truncated: omitted || selection.excluded.length > 0, selection };
}

const MEMORY_VALUE_PREVIEW_LIMIT = 160;

function boundedValue(value: string): string {
  if (value.length > MEMORY_VALUE_PREVIEW_LIMIT) return `[value omitted; query by id; length=${value.length}]`;
  return JSON.stringify(value);
}

function boundedPreview(value: string): string {
  if (value.length > MEMORY_VALUE_PREVIEW_LIMIT) return `[description omitted; query by id; length=${value.length}]`;
  return JSON.stringify(value);
}

function estimateTextTokens(value: string): number {
  return Math.ceil(value.length / 4);
}
