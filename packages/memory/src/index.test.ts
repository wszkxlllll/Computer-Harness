import { describe, expect, it } from "vitest";
import type { RunId } from "@computer-harness/protocol";
import { InMemoryMemoryStore, createMemoryTools } from "./index.js";

const runId = "memory-test" as RunId;

describe("Run memory", () => {
  it("writes, updates and rebuilds a fact without sharing state across runs", async () => {
    const store = new InMemoryMemoryStore();
    const write = createMemoryTools(store).find((tool) => tool.name === "memory_write_fact");
    expect(write).toBeDefined();
    const output = await write!.execute({ key: "target_file", value: "report.odt" }, {
      runId,
      session: {} as never,
      signal: new AbortController().signal,
    });
    const mutation = write!.memoryMutationFromResult!(output, {
      runId,
      session: {} as never,
      signal: new AbortController().signal,
    });
    expect(mutation?.operation).toBe("upsert_fact");
    await store.apply(runId, mutation!);
    expect((await store.get(runId)).facts[0]?.value).toBe("report.odt");
    await store.rebuild(runId, [mutation!]);
    expect((await store.get("other-run" as RunId)).facts).toHaveLength(0);
    const get = createMemoryTools(store).find((tool) => tool.name === "memory_get");
    const details = await get!.execute({ id: "m1" }, { runId, session: {} as never, signal: new AbortController().signal });
    expect(details).toMatchObject({ facts: [{ id: "m1", value: "report.odt" }] });
  });

  it("adds entity tools only in entities mode", () => {
    expect(createMemoryTools(new InMemoryMemoryStore(), "facts").map((tool) => tool.name)).toEqual(["memory_get", "memory_write_fact", "memory_mark_fact_needs_check"]);
    expect(createMemoryTools(new InMemoryMemoryStore(), "entities").map((tool) => tool.name)).toContain("memory_upsert_entity");
  });

  it("keeps entity identity separate from normalized entity-scoped facts", async () => {
    const store = new InMemoryMemoryStore();
    const tools = createMemoryTools(store, "entities");
    const context = { runId, session: {} as never, signal: new AbortController().signal };
    const upsert = tools.find((tool) => tool.name === "memory_upsert_entity")!;
    const entityOutput = await upsert.execute({ type: "document", description: "report.odt" }, context);
    await store.apply(runId, upsert.memoryMutationFromResult!(entityOutput, context)!);
    const entityId = (await store.get(runId)).entities[0]!.id;
    const factTool = tools.find((tool) => tool.name === "memory_write_fact")!;
    const factOutput = await factTool.execute({ entityId, key: "saved", value: "false" }, context);
    await store.apply(runId, factTool.memoryMutationFromResult!(factOutput, context)!);
    const updateOutput = await upsert.execute({ entityId, type: "document", description: "report.odt in Writer" }, context);
    await store.apply(runId, upsert.memoryMutationFromResult!(updateOutput, context)!);
    const get = tools.find((tool) => tool.name === "memory_get")!;
    await expect(get.execute({ id: entityId }, context)).resolves.toMatchObject({
      entities: [{ id: entityId, description: "report.odt in Writer" }],
      facts: [{ subject: { type: "entity", entityId }, key: "saved", value: "false" }],
    });
    expect(() => get.validate({ id: entityId, key: "saved" })).toThrow("exactly one");
    const mark = tools.find((tool) => tool.name === "memory_mark_fact_needs_check")!;
    const factId = (await store.get(runId)).facts[0]!.id;
    const markOutput = await mark.execute({ factId }, context);
    await store.apply(runId, mark.memoryMutationFromResult!(markOutput, context)!);
    expect((await store.get(runId)).facts[0]!.status).toBe("needs_check");

    const duplicateOutput = await upsert.execute({ type: "document", description: "report.odt in Writer" }, context);
    await store.apply(runId, upsert.memoryMutationFromResult!(duplicateOutput, context)!);
    expect((await store.get(runId)).entities).toHaveLength(2);
  });
});
