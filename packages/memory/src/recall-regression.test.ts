import { describe, expect, it } from "vitest";
import type { RunId } from "@computer-harness/protocol";
import { createMemoryRunModule, HybridMemoryRecallService, InMemoryMemoryStore } from "./index.js";

const runId = "memory-recall-regression" as RunId;

function testContext() {
  return { runId, session: {} as never, signal: new AbortController().signal };
}

async function callMutationTool(
  module: ReturnType<typeof createMemoryRunModule>,
  name: string,
  args: Record<string, unknown>,
) {
  const context = testContext();
  const tool = module.tools.find((candidate) => candidate.name === name);
  if (tool?.memoryMutationFromResult === undefined) throw new Error(`${name} mutation hook is missing`);
  const output = await tool.execute(args as never, context);
  const mutation = tool.memoryMutationFromResult(output, context);
  if (mutation === undefined) throw new Error(`${name} did not produce a mutation`);
  await module.apply(mutation);
  return mutation;
}

describe("Run Memory recall reliability", () => {
  it("keeps source and current-view limits explicit in the write guidance", () => {
    const write = createMemoryRunModule(runId, new InMemoryMemoryStore(), { mode: "facts" }).tools.find((tool) => tool.name === "memory_write_fact");
    const schema = write?.inputSchema as { properties?: Record<string, { description?: string }> } | null | undefined;
    const valueDescription = schema?.properties?.value?.description;
    expect(write?.description).toContain("source and inspected range");
    expect(write?.description).toContain("Absence from one current view does not prove absence elsewhere");
    expect(valueDescription).toContain("current screen/page/section");
  });

  it("supersedes a corrected fact and excludes facts after their entity is invalidated", async () => {
    const store = new InMemoryMemoryStore();
    const retrieval = new HybridMemoryRecallService();
    const module = createMemoryRunModule(runId, store, { mode: "entities", retrieval });
    const write = await callMutationTool(module, "memory_write_fact", {
      key: "source_policy",
      value: "First observed value from the inspected source section.",
      retentionClass: "stable",
    });
    expect(write.operation).toBe("upsert_fact");

    const initial = await retrieval.search(await store.get(runId), {
      runId,
      originalGoal: "retrieve the source policy",
      explicitQuery: "source_policy",
    }, new AbortController().signal);
    expect(initial.admittedFacts.map((item) => item.fact.value)).toEqual(["First observed value from the inspected source section."]);

    await callMutationTool(module, "memory_mark_fact_needs_check", { factId: "m1", reason: "manual_review" });
    const needsCheck = await retrieval.search(await store.get(runId), {
      runId,
      originalGoal: "retrieve the source policy",
      explicitQuery: "source_policy",
    }, new AbortController().signal);
    expect(needsCheck.admittedFacts).toHaveLength(0);
    expect(needsCheck.revalidationCandidates.map((item) => item.fact.id)).toEqual(["m1"]);

    const correction = await callMutationTool(module, "memory_write_fact", {
      key: "source_policy",
      value: "Corrected value from the rechecked source section.",
      retentionClass: "stable",
    });
    expect(correction.operation).toBe("supersede_fact");
    const corrected = await retrieval.search(await store.get(runId), {
      runId,
      originalGoal: "retrieve the source policy",
      explicitQuery: "source_policy",
    }, new AbortController().signal);
    expect(corrected.admittedFacts.map((item) => item.fact.value)).toEqual(["Corrected value from the rechecked source section."]);
    expect(corrected.excluded).toContainEqual({ kind: "fact", id: "m1", reason: "superseded" });

    await callMutationTool(module, "memory_upsert_entity", { type: "window", description: "Tracked application window" });
    await callMutationTool(module, "memory_write_fact", {
      key: "tracked_window_state",
      value: "The tracked window is currently open.",
      entityId: "e1",
      retentionClass: "stable",
    });
    const beforeInvalidation = await retrieval.search(await store.get(runId), {
      runId,
      originalGoal: "retrieve tracked window state",
      explicitQuery: "tracked_window_state",
    }, new AbortController().signal);
    expect(beforeInvalidation.admittedFacts.map((item) => item.fact.id)).toEqual(["m3"]);

    await callMutationTool(module, "memory_invalidate_entity", { entityId: "e1" });
    const afterInvalidation = await retrieval.search(await store.get(runId), {
      runId,
      originalGoal: "retrieve tracked window state",
      explicitQuery: "tracked_window_state",
    }, new AbortController().signal);
    expect(afterInvalidation.admittedFacts).toHaveLength(0);
    expect(afterInvalidation.excluded).toContainEqual({ kind: "fact", id: "m3", reason: "entity_stale" });
  });
});
