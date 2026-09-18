import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ComputerSessionId, EventId, MemoryEntity, MemoryFact, MemoryState, RunId } from "@computer-harness/protocol";
import { FileMemoryStore, InMemoryMemoryStore, createMemoryTools } from "./index.js";

const runId = "memory-test" as RunId;

function fact(overrides: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id: "m1",
    subject: { type: "run" },
    key: "target_file",
    value: "report.odt",
    sourceEventId: "event-1" as EventId,
    status: "active",
    updatedSequence: 1,
    ...overrides,
  };
}

function entity(overrides: Partial<MemoryEntity> = {}): MemoryEntity {
  return {
    id: "e1",
    type: "document",
    description: "report.odt",
    sourceEventId: "event-2" as EventId,
    status: "active",
    updatedSequence: 1,
    ...overrides,
  };
}

async function readPersistedMemory(value: unknown): Promise<MemoryState> {
  const root = await mkdtemp(join(tmpdir(), "computer-harness-memory-schema-"));
  const runDirectory = join(root, runId);
  await mkdir(runDirectory, { recursive: true });
  await writeFile(join(runDirectory, "memory.json"), JSON.stringify(value), "utf8");
  try {
    return await new FileMemoryStore(root).get(runId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

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
    expect((await store.get(runId)).facts[0]?.scope).toEqual({ kind: "run" });
    expect((await store.get(runId)).facts[0]?.retentionClass).toBe("stable");
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
    expect((await store.get(runId)).facts[0]!.statusReason).toBe("manual_review");

    const duplicateOutput = await upsert.execute({ type: "document", description: "report.odt in Writer" }, context);
    await store.apply(runId, upsert.memoryMutationFromResult!(duplicateOutput, context)!);
    expect((await store.get(runId)).entities).toHaveLength(2);
  });

  it("rejects malformed persisted nested records and dangling references", async () => {
    const base = { runId, facts: [fact()], entities: [] };
    const cases: Array<[string, unknown]> = [
      ["invalid fact subject", { ...base, facts: [{ ...fact(), subject: "run" }] },],
      ["invalid fact status", { ...base, facts: [{ ...fact(), status: "corrupt" }] },],
      ["invalid source event id", { ...base, facts: [{ ...fact(), sourceEventId: 7 }] },],
      ["invalid sequence", { ...base, facts: [{ ...fact(), updatedSequence: -1 }] },],
      ["duplicate fact id", { ...base, facts: [fact(), fact({ key: "other" })] },],
      ["duplicate cross-domain id", { ...base, entities: [entity({ id: "m1" })] },],
      ["dangling entity reference", { ...base, facts: [{ ...fact(), subject: { type: "entity", entityId: "missing" } }] },],
      ["invalid entity status", { ...base, entities: [entity({ status: "corrupt" })] },],
      ["invalid entity source event id", { ...base, entities: [entity({ sourceEventId: 7 as unknown as EventId })] },],
      ["invalid entity sequence", { ...base, entities: [entity({ updatedSequence: -1 })] },],
      ["invalid entity description", { ...base, entities: [entity({ description: 7 as unknown as string })] },],
    ];
    for (const [label, value] of cases) {
      await expect(readPersistedMemory(value), label).rejects.toThrow(/memory\.json|invalid|reference/i);
    }
  });

  it("migrates legacy facts and keeps current/history scope gates identical", async () => {
    const legacy = await readPersistedMemory({ runId, facts: [fact()], entities: [] });
    expect(legacy.facts[0]).toMatchObject({ scope: { kind: "run" }, retentionClass: "stable" });

    const store = new InMemoryMemoryStore();
    const tools = createMemoryTools(store);
    const sessionA = "session-a" as ComputerSessionId;
    const sessionB = "session-b" as ComputerSessionId;
    const contextA = { runId, session: { id: sessionA } as never, signal: new AbortController().signal };
    const contextB = { runId, session: { id: sessionB } as never, signal: new AbortController().signal };
    const write = tools.find((tool) => tool.name === "memory_write_fact")!;
    const output = await write.execute({ key: "last_seen", value: "synthetic", scope: "computer_session", retentionClass: "short_lived" }, contextA);
    await store.apply(runId, write.memoryMutationFromResult!(output, contextA)!);
    const get = tools.find((tool) => tool.name === "memory_get")!;
    await expect(get.execute({ key: "last_seen" }, contextA)).resolves.toMatchObject({
      facts: [{ scope: { kind: "computer_session", sessionId: sessionA }, retentionClass: "short_lived" }],
      factAdmission: [{ id: "m1", class: "revalidation", reason: "short_lived_last_known" }],
    });
    await expect(get.execute({ key: "last_seen" }, contextB)).rejects.toThrow("no matching");
    await expect(get.execute({ key: "last_seen", view: "history" }, contextB)).resolves.toMatchObject({
      facts: [{ id: "m1" }],
      factApplicability: [{ id: "m1", applicable: false }],
    });
  });

  it("keeps superseded facts in explicit history but not current", async () => {
    const store = new InMemoryMemoryStore();
    const oldFact = fact({ id: "old", key: "state", value: "old", scope: { kind: "run" }, retentionClass: "stable" });
    const newFact = fact({ id: "new", key: "state", value: "new", scope: { kind: "run" }, retentionClass: "stable" });
    await store.rebuild(runId, [{ operation: "upsert_fact", fact: oldFact }, { operation: "supersede_fact", factId: "old", replacement: newFact }]);
    const get = createMemoryTools(store).find((tool) => tool.name === "memory_get")!;
    const context = { runId, session: {} as never, signal: new AbortController().signal };
    await expect(get.execute({ key: "state" }, context)).resolves.toMatchObject({ facts: [{ id: "new", value: "new" }] });
    const history = await get.execute({ key: "state", view: "history" }, context);
    const historyFacts = (history as { facts: MemoryFact[] }).facts;
    expect(historyFacts.some((item) => item.id === "old" && item.status === "superseded")).toBe(true);
    expect(historyFacts.some((item) => item.id === "new" && item.status === "active")).toBe(true);
  });

  it("rejects overlong memory fields and collections before persistence", async () => {
    const base = { runId, facts: [fact()], entities: [] };
    const cases: Array<[string, unknown]> = [
      ["fact key", { ...base, facts: [{ ...fact(), key: "k".repeat(10_000) }] },],
      ["fact value", { ...base, facts: [{ ...fact(), value: "v".repeat(10_000) }] },],
      ["entity type", { ...base, facts: [], entities: [entity({ type: "t".repeat(10_000) })] },],
      ["entity description", { ...base, facts: [], entities: [entity({ description: "d".repeat(10_000) })] },],
      ["related task collection", { ...base, facts: [{ ...fact(), relatedTaskIds: Array.from({ length: 100 }, (_, index) => `task-${index}`) }] },],
      ["duplicate related task", { ...base, facts: [{ ...fact(), relatedTaskIds: ["task-1", "task-1"] }] },],
    ];
    for (const [label, value] of cases) {
      await expect(readPersistedMemory(value), label).rejects.toThrow(/memory\.json|length|limit|duplicate/i);
    }
  });

  it("validates write arguments and mutation output shapes", async () => {
    const store = new InMemoryMemoryStore();
    const tools = createMemoryTools(store, "entities");
    const write = tools.find((tool) => tool.name === "memory_write_fact")!;
    const upsert = tools.find((tool) => tool.name === "memory_upsert_entity")!;
    expect(() => write.validate({ key: "k".repeat(10_000), value: "ok" })).toThrow(/length|limit/i);
    expect(() => write.validate({ key: "key", value: "v".repeat(10_000) })).toThrow(/length|limit/i);
    expect(() => write.validate({ key: "key", value: "ok", relatedTaskIds: Array.from({ length: 100 }, () => "task") })).toThrow(/length|maximum|limit/i);
    expect(() => upsert.validate({ type: "t".repeat(10_000), description: "ok" })).toThrow(/length|maximum|limit/i);
    expect(() => upsert.validate({ type: "document", description: "d".repeat(10_000) })).toThrow(/length|maximum|limit/i);
    expect(() => write.memoryMutationFromResult!({ operation: "upsert_fact", fact: { id: "m1", subject: { type: "entity", entityId: 1 }, key: "k", value: "v", sourceEventId: "e1", status: "active", updatedSequence: 0 } } as never, { runId, session: {} as never, signal: new AbortController().signal })).toThrow(/fact|subject|invalid/i);
  });
});
