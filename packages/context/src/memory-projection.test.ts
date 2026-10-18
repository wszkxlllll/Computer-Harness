import { describe, expect, it } from "vitest";
import type { EventId, MemoryFact, MemoryState, PlanState, RunId } from "@computer-harness/protocol";
import type { MemoryRecallSelection } from "@computer-harness/runtime";
import { selectMemoryForContext } from "./memory-recall.js";
import { formatMemory } from "./projections.js";

const runId = "memory-projection" as RunId;

function fact(id: string, value: string, overrides: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id,
    subject: { type: "run" },
    key: id,
    value,
    sourceEventId: `${id}-source` as EventId,
    status: "active",
    updatedSequence: Number(id.replace("fact-", "")) || 1,
    ...overrides,
  };
}

function crowdedMemory(): MemoryState {
  return {
    runId,
    facts: [
      ...Array.from({ length: 20 }, (_, index) => fact(`fact-${index}`, `value-${index}`)),
      fact("needs", "needs-old", { status: "needs_check", statusReason: "manual_review", updatedSequence: 30 }),
      fact("short", "short-last-known", { retentionClass: "short_lived", updatedSequence: 31 }),
    ],
    entities: [],
  };
}

describe("memory projection packets", () => {
  it("gives hot and revalidation packets an opportunity before remaining index records", () => {
    const projection = formatMemory(crowdedMemory(), undefined, 256);
    expect(projection).toBeDefined();
    expect(projection?.text).toContain("Revalidation candidates");
    expect(projection?.text).toContain("needs-old");
    expect(projection?.text).toContain("short-last-known");
    expect(projection?.text).toContain("Current run memory index");
    expect((projection?.text.split("\n").filter((line) => line.includes("fact-19")).length ?? 0)).toBe(1);
    expect(projection?.selection.hotFacts.map((item) => item.id)).not.toEqual(expect.arrayContaining(["needs", "short"]));
    expect(projection?.rendered.admittedFactIds).not.toEqual(expect.arrayContaining(["needs", "short"]));
    expect(projection?.rendered.revalidationFactIds).toEqual(expect.arrayContaining(["needs", "short"]));
    const admittedSection = projection?.text.split("Revalidation candidates")[0] ?? "";
    expect(admittedSection).not.toContain("needs-old");
    expect(admittedSection).not.toContain("short-last-known");
  });

  it("uses existing task links only as an admitted-fact fallback and keeps query hits without a Plan", () => {
    const memory: MemoryState = {
      runId,
      facts: [
        fact("matched", "query matched"),
        fact("task-linked", "linked fallback", { relatedTaskIds: ["t-current"], updatedSequence: 20 }),
        fact("taskless", "not linked", { updatedSequence: 30 }),
        fact("expired-linked", "old linked value", { relatedTaskIds: ["t-current"], retentionClass: "short_lived", updatedSequence: 40 }),
      ],
      entities: [],
    };
    const plan: PlanState = { runId, tasks: [{ id: "t-current", subject: "current task", status: "in_progress" }] };
    const recall: MemoryRecallSelection = {
      method: "lexical",
      semanticStatus: "disabled",
      stateStable: true,
      embeddingBudgetUsed: 0,
      embeddingBudgetLimit: 6,
      admitted: [{ id: "matched", score: 1, match: "lexical" }],
      revalidation: [],
      excluded: [],
    };

    const withPlan = selectMemoryForContext(memory, plan, {}, { runId, recall });
    expect(withPlan.admittedFacts.map((item) => item.id)).toEqual(["matched", "task-linked"]);
    expect(withPlan.hotFacts.map((item) => item.id)).toEqual(["matched", "task-linked"]);
    expect(withPlan.revalidationCandidates).toHaveLength(0);

    const withoutPlan = selectMemoryForContext(memory, undefined, {}, { runId, recall });
    expect(withoutPlan.admittedFacts.map((item) => item.id)).toEqual(["matched"]);
  });

  it("does not partially expose an oversized candidate value", () => {
    const memory = crowdedMemory();
    memory.facts = [fact("long", "secret-prefix-" + "x".repeat(500), { retentionClass: "short_lived" })];
    const projection = formatMemory(memory, undefined, 256);
    expect(projection?.text).toContain("value omitted; query by id");
    expect(projection?.text).not.toContain("secret-prefix-");
  });

  it("reports omission honestly when the packet budget cannot fit a complete group", () => {
    const projection = formatMemory(crowdedMemory(), undefined, 4);
    expect(projection?.truncated).toBe(true);
    expect(projection?.text).toBe("");
  });
});
