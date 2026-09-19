import { describe, expect, it } from "vitest";
import type { ActionId, ActionIntent, AssetId, ComputerSessionId, EventId, MemoryMutation, MemoryFact, ModelTurn, ObservationId, RunId, RuntimeEvent, RuntimeEventDraft, ToolCall, ToolCallId, Viewport } from "@computer-harness/protocol";
import { DefaultRuntimePolicy, RunController, ToolRegistry, type Computer, type ComputerOpenOptions, type ComputerSession, type ContextCompiler, type IdFactory, type ModelInput, type ModelMessage, type NonComputerToolDefinition, type ProviderAdapter } from "@computer-harness/runtime";
import type { AssetStore, RunEventWriter } from "@computer-harness/trajectory";
import { InMemoryMemoryStore, createMemoryTools } from "./index.js";

const runId = "memory-runtime-regression" as RunId;
const sessionId = "memory-runtime-computer" as ComputerSessionId;
const viewport: Viewport = { width: 800, height: 600, coordinateSpace: "physical" };

class FakeComputer implements Computer {
  private observationCount = 0;
  public readonly session: ComputerSession = {
    id: sessionId,
    backend: "fake",
    viewport,
    capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false },
    openedAt: "2026-09-17T00:00:00.000Z",
  };

  public async open(_options: ComputerOpenOptions, signal: AbortSignal): Promise<ComputerSession> {
    signal.throwIfAborted();
    return this.session;
  }

  public async observe(_session: ComputerSession, _observationId: ObservationId, signal: AbortSignal) {
    signal.throwIfAborted();
    this.observationCount += 1;
    return {
      capturedAt: `2026-09-17T00:00:0${this.observationCount}.000Z`,
      viewport,
      screenshot: { mediaType: "image/png" as const, data: new Uint8Array([this.observationCount]) },
    };
  }

  public async execute(_session: ComputerSession, _action: ActionIntent, signal: AbortSignal) {
    signal.throwIfAborted();
    return { actionId: _action.actionId, status: "completed" as const };
  }

  public async close(_session: ComputerSession): Promise<void> {}
}

class ScriptedProvider implements ProviderAdapter {
  public readonly id = "memory-runtime-regression-provider";
  public constructor(private readonly turns: ModelTurn[]) {}

  public async generate(_input: ModelInput, options: { signal: AbortSignal }): Promise<ModelTurn> {
    options.signal.throwIfAborted();
    const turn = this.turns.shift();
    if (turn === undefined) throw new Error("memory runtime regression provider exhausted");
    return turn;
  }
}

class MemoryEventWriter implements RunEventWriter {
  public readonly events: RuntimeEvent[] = [];

  public async append(draft: RuntimeEventDraft): Promise<RuntimeEvent> {
    const event = { ...draft, eventId: draft.eventId ?? `event-${this.events.length}` as EventId, sequence: this.events.length, occurredAt: draft.occurredAt ?? "2026-09-17T00:00:00.000Z" } as RuntimeEvent;
    this.events.push(event);
    return event;
  }

  public async flush(): Promise<void> {}
  public async close(): Promise<void> {}
}

class RegressionContextCompiler implements ContextCompiler {
  public async compile(input: Parameters<ContextCompiler["compile"]>[0], signal: AbortSignal): Promise<ModelInput> {
    signal.throwIfAborted();
    const messages: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: input.goal }] }];
    return { system: "memory runtime regression context", messages, tools: [] };
  }
}

const assets: AssetStore = {
  async put(input) {
    return { assetId: input.assetId, relativePath: input.relativePath, mediaType: input.mediaType, byteLength: input.data.length };
  },
};

function idFactory(): IdFactory {
  let count = 0;
  return {
    eventId: () => `event-${count++}` as EventId,
    observationId: () => `observation-${count++}` as ObservationId,
    assetId: () => `asset-${count++}` as AssetId,
    actionId: () => `action-${count++}` as ActionId,
  };
}

function writeCall(id: string, value: string, relatedTaskIds?: string[]): ToolCall {
  return {
    id: id as ToolCallId,
    name: "memory_write_fact",
    arguments: { key: "destination", value, ...(relatedTaskIds === undefined ? {} : { relatedTaskIds }) },
  };
}

function syntheticMemoryTool(name: string, mutation: unknown, store: InMemoryMemoryStore): NonComputerToolDefinition {
  return {
    name,
    description: "Synthetic Runtime memory-boundary regression tool.",
    category: "side",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    validate: (args) => { if (args !== null) throw new Error(`${name} accepts null`); },
    execute: async () => ({ ok: true }),
    memoryMutationFromResult: () => mutation as MemoryMutation,
    afterMemoryCommit: async (committed, context) => { await store.apply(context.runId, committed); },
  };
}

function syntheticPlanningTaskTool(name: string, id: string): NonComputerToolDefinition {
  return {
    name,
    description: "Synthetic Planning task setup tool.",
    category: "planning",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    validate: (args) => { if (args !== null) throw new Error(`${name} accepts null`); },
    execute: async () => ({ ok: true }),
    planMutationFromResult: () => ({ operation: "created", task: { id, subject: `Known task ${id}`, status: "pending" } }),
  };
}

function syntheticFact(overrides: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id: "m1",
    subject: { type: "run" },
    key: "destination",
    value: "old",
    sourceEventId: "synthetic-source" as EventId,
    status: "active",
    updatedSequence: 0,
    ...overrides,
  };
}

function makeController(
  store: InMemoryMemoryStore,
  planning: "off" | "tasks-v1",
  turns: ModelTurn[],
  registry: ToolRegistry,
  overrides: { memoryMutationApplier?: (targetRunId: RunId, mutation: MemoryMutation) => Promise<void> } = {},
): { controller: RunController; writer: MemoryEventWriter } {
  const writer = new MemoryEventWriter();
  const controller = new RunController({
    runId,
    provider: new ScriptedProvider(turns),
    computer: new FakeComputer(),
    contextCompiler: new RegressionContextCompiler(),
    toolRegistry: registry,
    policy: new DefaultRuntimePolicy(8, 8),
    eventWriter: writer,
    assetStore: assets,
    idFactory: idFactory(),
    clock: { now: () => "2026-09-17T00:00:00.000Z" },
    features: { planning, memory: "facts-v1", batching: "off" },
    memoryMutationApplier: overrides.memoryMutationApplier ?? (async (targetRunId, mutation) => { await store.apply(targetRunId, mutation); }),
  });
  return { controller, writer };
}

describe("Memory mutations through RunController", () => {
  it.each([
    ["new", false, [writeCall("invalid-new", "new", ["missing-task"])], "invalid-new"],
    ["same-value", true, [writeCall("seed-same", "old"), writeCall("invalid-same", "old", ["missing-task"])], "invalid-same"],
    ["replacement", true, [writeCall("seed-replacement", "old"), writeCall("invalid-replacement", "new", ["missing-task"])], "invalid-replacement"],
  ] as const)("rejects %s with an unknown task link when Planning is off", async (_label, _seeded, calls, invalidCallId) => {
    const store = new InMemoryMemoryStore();
    const registry = new ToolRegistry();
    registry.registerMany(createMemoryTools(store));
    const created = makeController(store, "off", [...calls.map((call) => ({ type: "tool_calls" as const, calls: [call] })), { type: "finish", summary: "done" }], registry);

    await expect(created.controller.start("validate memory links")).resolves.toBe("succeeded");
    const state = await store.get(runId);
    expect(created.writer.events.some((event) => event.type === "memory.updated" && event.callId === invalidCallId)).toBe(false);
    expect(created.writer.events.some((event) => event.type === "tool.call.failed" && event.result.callId === invalidCallId)).toBe(true);
    if (_seeded) expect(state.facts).toMatchObject([{ id: "m1", value: "old", status: "active" }]);
    else expect(state.facts).toHaveLength(0);
  });

  it.each([
    ["new", false, [writeCall("invalid-new-planning", "new", ["missing-task"])], "invalid-new-planning"],
    ["same-value", true, [writeCall("seed-same-planning", "old"), writeCall("invalid-same-planning", "old", ["missing-task"])], "invalid-same-planning"],
    ["replacement", true, [writeCall("seed-replacement-planning", "old"), writeCall("invalid-replacement-planning", "new", ["missing-task"])], "invalid-replacement-planning"],
  ] as const)("rejects %s with an unknown task link when Planning is on", async (_label, _seeded, calls, invalidCallId) => {
    const store = new InMemoryMemoryStore();
    const registry = new ToolRegistry();
    registry.registerMany(createMemoryTools(store));
    const created = makeController(store, "tasks-v1", [...calls.map((call) => ({ type: "tool_calls" as const, calls: [call] })), { type: "finish", summary: "done" }], registry);

    await expect(created.controller.start("validate memory links")).resolves.toBe("succeeded");
    const state = await store.get(runId);
    expect(created.writer.events.some((event) => event.type === "memory.updated" && event.callId === invalidCallId)).toBe(false);
    expect(created.writer.events.some((event) => event.type === "tool.call.failed" && event.result.callId === invalidCallId)).toBe(true);
    if (_seeded) expect(state.facts).toMatchObject([{ id: "m1", value: "old", status: "active" }]);
    else expect(state.facts).toHaveLength(0);
  });

  it("rejects a replacement with a foreign entity subject before memory.updated", async () => {
    const store = new InMemoryMemoryStore();
    const registry = new ToolRegistry();
    registry.registerMany(createMemoryTools(store));
    registry.register({
      name: "invalid_entity_replacement",
      description: "Synthetic invalid replacement.",
      category: "side",
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
      validate: (args) => { if (args !== null) throw new Error("invalid_entity_replacement accepts null"); },
      execute: async () => ({ ok: true }),
      memoryMutationFromResult: () => ({
        operation: "supersede_fact" as const,
        factId: "m1",
        replacement: {
          id: "m2",
          subject: { type: "entity" as const, entityId: "foreign-entity" },
          key: "destination",
          value: "new",
          sourceEventId: "placeholder" as EventId,
          status: "active" as const,
          updatedSequence: 0,
        },
      }),
      afterMemoryCommit: async (mutation, context) => { await store.apply(context.runId, mutation); },
    });
    const turns: ModelTurn[] = [
      { type: "tool_calls", calls: [writeCall("seed-entity-replacement", "old")] },
      { type: "tool_calls", calls: [{ id: "invalid-entity-replacement" as ToolCallId, name: "invalid_entity_replacement", arguments: null }] },
      { type: "finish", summary: "done" },
    ];
    const created = makeController(store, "off", turns, registry);

    await expect(created.controller.start("validate entity replacement")).resolves.toBe("succeeded");
    const state = await store.get(runId);
    expect(created.writer.events.some((event) => event.type === "memory.updated" && event.callId === "invalid-entity-replacement")).toBe(false);
    expect(created.writer.events.some((event) => event.type === "tool.call.failed" && event.result.callId === "invalid-entity-replacement")).toBe(true);
    expect(state.facts).toMatchObject([{ id: "m1", value: "old", status: "active" }]);
  });

  it.each([
    ["unknown nested field", { operation: "upsert_fact", fact: { ...syntheticFact(), extra: "reject me" } }],
    ["oversized key", { operation: "upsert_fact", fact: syntheticFact({ key: "k".repeat(257) }) }],
    ["invalid status", { operation: "upsert_fact", fact: { ...syntheticFact(), status: "not-a-memory-status" } }],
  ] as const)("rejects custom memory mutation with %s before memory.updated", async (_label, mutation) => {
    const store = new InMemoryMemoryStore();
    const registry = new ToolRegistry();
    registry.registerMany(createMemoryTools(store));
    const toolName = `invalid-memory-${_label.replaceAll(" ", "-")}`;
    const callId = `call-${toolName}`;
    registry.register(syntheticMemoryTool(toolName, mutation, store));
    const created = makeController(store, "off", [
      { type: "tool_calls", calls: [writeCall("seed-invalid-memory", "old")] },
      { type: "tool_calls", calls: [{ id: callId as ToolCallId, name: toolName, arguments: null }] },
      { type: "finish", summary: "done" },
    ], registry);

    await expect(created.controller.start("validate custom memory shape")).resolves.toBe("succeeded");
    const state = await store.get(runId);
    expect(created.writer.events.some((event) => event.type === "memory.updated" && event.callId === callId)).toBe(false);
    expect(created.writer.events.some((event) => event.type === "tool.call.failed" && event.result.callId === callId)).toBe(true);
    expect(created.writer.events.filter((event) => event.type === "memory.updated").map((event) => event.callId)).toEqual(["seed-invalid-memory"]);
    expect(state.facts).toMatchObject([{ id: "m1", key: "destination", value: "old", status: "active" }]);
    expect(created.controller.getSnapshot().memory).toEqual(state);
  });

  it("rejects a custom active-ID upsert with changed content before memory.updated", async () => {
    const store = new InMemoryMemoryStore();
    const registry = new ToolRegistry();
    registry.registerMany(createMemoryTools(store));
    const callId = "call-changed-active-upsert" as ToolCallId;
    registry.register(syntheticMemoryTool("changed_active_upsert", {
      operation: "upsert_fact",
      fact: syntheticFact({ value: "new" }),
    }, store));
    const created = makeController(store, "off", [
      { type: "tool_calls", calls: [writeCall("seed-active-upsert", "old")] },
      { type: "tool_calls", calls: [{ id: callId, name: "changed_active_upsert", arguments: null }] },
      { type: "finish", summary: "done" },
    ], registry);

    await expect(created.controller.start("validate active memory upsert")).resolves.toBe("succeeded");
    const state = await store.get(runId);
    expect(created.writer.events.some((event) => event.type === "memory.updated" && event.callId === callId)).toBe(false);
    expect(created.writer.events.some((event) => event.type === "tool.call.failed" && event.result.callId === callId)).toBe(true);
    expect(state.facts).toMatchObject([{ id: "m1", key: "destination", value: "old", status: "active" }]);
    expect(created.controller.getSnapshot().memory).toEqual(state);
  });

  it("keeps same-content active-ID upsert refresh semantics after provenance restamping", async () => {
    const store = new InMemoryMemoryStore();
    const registry = new ToolRegistry();
    registry.registerMany(createMemoryTools(store));
    registry.register(syntheticMemoryTool("same_content_upsert", {
      operation: "upsert_fact",
      fact: syntheticFact({ sourceEventId: "different-source" as EventId, updatedSequence: 999 }),
    }, store));
    const created = makeController(store, "off", [
      { type: "tool_calls", calls: [writeCall("seed-same-content", "old")] },
      { type: "tool_calls", calls: [{ id: "call-same-content" as ToolCallId, name: "same_content_upsert", arguments: null }] },
      { type: "finish", summary: "done" },
    ], registry);

    await expect(created.controller.start("validate same-content memory upsert")).resolves.toBe("succeeded");
    const state = await store.get(runId);
    expect(created.writer.events.some((event) => event.type === "memory.updated" && event.callId === "call-same-content")).toBe(true);
    expect(state.facts).toMatchObject([{ id: "m1", key: "destination", value: "old", status: "active" }]);
    expect(created.controller.getSnapshot().memory).toEqual(state);
  });

  it("supersedes when the official writer changes valid task links even if the value is unchanged", async () => {
    const store = new InMemoryMemoryStore();
    const registry = new ToolRegistry();
    registry.registerMany(createMemoryTools(store));
    registry.register(syntheticPlanningTaskTool("create_known_task_one", "task-one"));
    registry.register(syntheticPlanningTaskTool("create_known_task_two", "task-two"));
    const created = makeController(store, "tasks-v1", [
      {
        type: "tool_calls",
        calls: [
          { id: "create-task-one" as ToolCallId, name: "create_known_task_one", arguments: null },
          { id: "create-task-two" as ToolCallId, name: "create_known_task_two", arguments: null },
          writeCall("seed-linked-fact", "old", ["task-one"]),
        ],
      },
      { type: "tool_calls", calls: [writeCall("change-linked-fact", "old", ["task-two"]) ] },
      { type: "finish", summary: "done" },
    ], registry);

    await expect(created.controller.start("validate linked memory refresh")).resolves.toBe("succeeded");
    const state = await store.get(runId);
    const changedFailure = created.writer.events.find((event) => event.type === "tool.call.failed" && event.result.callId === "change-linked-fact");
    expect(changedFailure).toBeUndefined();
    expect(created.writer.events.some((event) => event.type === "memory.updated" && event.callId === "change-linked-fact")).toBe(true);
    expect(state.facts).toMatchObject([
      { id: "m1", value: "old", status: "superseded", relatedTaskIds: ["task-one"] },
      { id: "m2", value: "old", status: "active", relatedTaskIds: ["task-two"] },
    ]);
  });

  it("marks session-scoped facts needs_check on Runtime-owned run completion", async () => {
    const store = new InMemoryMemoryStore();
    const registry = new ToolRegistry();
    registry.registerMany(createMemoryTools(store));
    const created = makeController(store, "off", [
      {
        type: "tool_calls",
        calls: [{
          id: "session-fact" as ToolCallId,
          name: "memory_write_fact",
          arguments: { key: "window_state", value: "last-known", scope: "computer_session", retentionClass: "short_lived" },
        }],
      },
      { type: "finish", summary: "done" },
    ], registry);

    await expect(created.controller.start("close session memory")).resolves.toBe("succeeded");
    const state = await store.get(runId);
    expect(state.facts).toMatchObject([{ scope: { kind: "computer_session", sessionId }, status: "needs_check", statusReason: "scope_ended" }]);
    expect(created.writer.events.some((event) => event.type === "memory.updated" && event.source === "lifecycle" && event.callId === undefined && event.mutation.operation === "mark_fact_needs_check")).toBe(true);
  });

  it("commits every lifecycle mutation and reports a partial Store materialization failure", async () => {
    const store = new InMemoryMemoryStore();
    const registry = new ToolRegistry();
    registry.registerMany(createMemoryTools(store));
    let lifecycleApplyCalls = 0;
    const created = makeController(store, "off", [
      { type: "tool_calls", calls: [{ id: "session-fact-one" as ToolCallId, name: "memory_write_fact", arguments: { key: "first", value: "one", scope: "computer_session", retentionClass: "short_lived" } }] },
      { type: "tool_calls", calls: [{ id: "session-fact-two" as ToolCallId, name: "memory_write_fact", arguments: { key: "second", value: "two", scope: "computer_session", retentionClass: "short_lived" } }] },
      { type: "finish", summary: "done" },
    ], registry, {
      memoryMutationApplier: async (targetRunId, mutation) => {
        lifecycleApplyCalls += 1;
        if (lifecycleApplyCalls === 2) throw new Error("injected lifecycle Store failure");
        await store.apply(targetRunId, mutation);
      },
    });

    await expect(created.controller.start("close two session facts")).resolves.toBe("failed");
    const lifecycleEvents = created.writer.events.filter((event) => event.type === "memory.updated" && event.source === "lifecycle");
    expect(lifecycleEvents).toHaveLength(2);
    expect(lifecycleEvents.every((event) => event.callId === undefined && event.mutation.operation === "mark_fact_needs_check")).toBe(true);
    expect(created.writer.events.some((event) => event.type === "runtime.error" && event.category === "memory_materialization_failed")).toBe(true);
    expect((await store.get(runId)).facts.filter((fact) => fact.status === "active")).toHaveLength(1);
  });
});
