import type { PlanState, MemoryState } from "@computer-harness/protocol";
import type { RunFeatureConfig } from "@computer-harness/runtime";
import { selectMemoryForContext } from "./memory-recall.js";

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
  if (features.memory !== "off") sections.push(`Run Memory is enabled (${features.memory}). Write only durable facts or objects needed later in this Run; do not record every click or duplicate plan progress. Read details by id when the compact index is insufficient.`);
  if (features.riskGuard === "layered") sections.push("For every Computer tool call, include _harnessEffect with non-empty effects, target, and summary. Describe this call's immediate expected effect, not the eventual goal: ordinary browsing/navigation is navigate, ordinary reversible typing is local_edit, and final payment, sending/publishing/submission, irreversible deletion/overwrite, sensitive disclosure, or security changes use their matching effect. Use unknown when uncertain. Never include secrets or private content in target/summary, and never claim that an action is approved or safe.");
  if (features.batching === "off") {
    sections.push("Return at most one Computer tool call per model turn.");
  } else {
    sections.push("A model turn may contain up to two Plan/Memory write calls first, followed by one Computer call or one GUI batch. A GUI batch is only click→type, Ctrl+A→type, or click→Ctrl+A→type in the same already-active text control. Do not put read tools, Control decisions, Enter, Tab, submit, navigation, scroll, drag, wait, or state writes after/between GUI calls. Do not claim post-action success before the next observation.");
  }
  return sections.join(" ");
}

export function formatMemory(memory: MemoryState, plan: PlanState | undefined): string | undefined {
  const selection = selectMemoryForContext(memory, plan);
  if (selection.indexFacts.length === 0 && selection.indexEntities.length === 0) return undefined;
  const hotFactIds = new Set(selection.hotFacts.map((fact) => fact.id));
  const hotEntityIds = new Set(selection.hotEntities.map((entity) => entity.id));
  const lines = ["Current run memory index (run-scoped facts, not proof of GUI state):"];
  for (const fact of selection.indexFacts) lines.push(`- fact ${fact.id}${fact.subject.type === "entity" ? ` (entity ${fact.subject.entityId})` : ""}: ${fact.key} [${fact.status}]${hotFactIds.has(fact.id) ? " [hot]" : ""}`);
  for (const entity of selection.indexEntities) lines.push(`- entity ${entity.id} (${entity.type}): ${entity.description} [${entity.status}]${hotEntityIds.has(entity.id) ? " [hot]" : ""}`);
  if (selection.hotFacts.length > 0) {
    lines.push("Hot facts:");
    for (const fact of selection.hotFacts) lines.push(`- ${fact.id}${fact.subject.type === "entity" ? ` (entity ${fact.subject.entityId})` : ""}: ${fact.key} = ${fact.value}${fact.status === "needs_check" ? " [needs_check]" : ""}`);
  }
  if (selection.hotEntities.length > 0) {
    lines.push("Hot entities:");
    for (const entity of selection.hotEntities) lines.push(`- ${entity.id}: ${entity.description}`);
  }
  return lines.join("\n");
}
