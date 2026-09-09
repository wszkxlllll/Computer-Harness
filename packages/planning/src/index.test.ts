import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DefaultContextCompiler } from "@computer-harness/context";
import type { ActionIntent, AssetId, ComputerSessionId, ModelTurn, ObservationCapture, ObservationId, RunId, ToolCallId, Viewport } from "@computer-harness/protocol";
import {
  DefaultRuntimePolicy,
  RunController,
  createDefaultToolRegistry,
  ToolRegistry,
  type AssetReader,
  type Computer,
  type ComputerOpenOptions,
  type ComputerSession,
  type ContextCompiler,
  type ModelInput,
  type ProviderAdapter,
} from "@computer-harness/runtime";
import { FileAssetStore, JsonlRunEventWriter, readRuntimeEvents, reduceRuntimeEvents, type RunEventWriter } from "@computer-harness/trajectory";
import { FilePlanStore, InMemoryPlanStore, createPlanningTools, rebuildPlanFromEvents, type PlanStore } from "./index.js";

const runId = "planning-test" as RunId;
const context = { runId, session: {} as never, signal: new AbortController().signal };

const loopRunId = "planning-loop" as RunId;
const loopViewport: Viewport = { width: 100, height: 100, coordinateSpace: "physical" };

class NoGuiComputer implements Computer {
  public readonly session: ComputerSession = {
    id: "planning-computer" as ComputerSessionId,
    backend: "fake",
    viewport: loopViewport,
    capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false },
    openedAt: "2026-09-07T00:00:00.000Z",
  };
  public executeCalls = 0;

  public async open(_options: ComputerOpenOptions, signal: AbortSignal): Promise<ComputerSession> {
    signal.throwIfAborted();
    return this.session;
  }

  public async observe(_session: ComputerSession, _observationId: ObservationId, signal: AbortSignal): Promise<ObservationCapture> {
    signal.throwIfAborted();
    return { capturedAt: "2026-09-07T00:00:00.000Z", viewport: loopViewport, screenshot: { mediaType: "image/png", data: new Uint8Array([1]) } };
  }

  public async execute(_session: ComputerSession, _action: ActionIntent, _signal: AbortSignal): Promise<never> {
    this.executeCalls += 1;
    throw new Error("GUI execution was not expected in the Planning closure test");
  }

  public async close(_session: ComputerSession): Promise<void> {}
}

class PlanningLoopProvider implements ProviderAdapter {
  public readonly id = "planning-loop-provider";
  public readonly inputs: ModelInput[] = [];

  public constructor(private readonly store: FilePlanStore) {}

  public async generate(input: ModelInput, options: { signal: AbortSignal }): Promise<ModelTurn> {
    options.signal.throwIfAborted();
    this.inputs.push(input);
    if (this.inputs.length === 1) return { type: "tool_calls", calls: [{ id: "create-loop" as never, name: "task_create", arguments: { subject: "Open Writer" } }] };
    const task = (await this.store.get(loopRunId)).tasks[0];
    if (this.inputs.length === 2) {
      if (task === undefined) throw new Error("TaskCreate did not materialize before the next model turn");
      return { type: "tool_calls", calls: [{ id: "update-loop" as never, name: "task_update", arguments: { taskId: task.id, status: "in_progress" } }] };
    }
    return { type: "finish", summary: "planning complete" };
  }
}

class PlanningLoopContext implements ContextCompiler {
  public readonly plans: Array<Readonly<ModelInput["messages"]>> = [];
  public readonly planSnapshots: Array<{ tasks: number; status?: string }> = [];

  public constructor(private readonly registry: ToolRegistry) {}

  public async compile(input: Parameters<ContextCompiler["compile"]>[0], signal: AbortSignal): Promise<ModelInput> {
    signal.throwIfAborted();
    this.planSnapshots.push({ tasks: input.plan?.tasks.length ?? 0, status: input.plan?.tasks[0]?.status });
    return { system: "planning test", messages: [{ role: "user", content: [{ type: "text", text: input.goal }] }], tools: this.registry.modelTools() };
  }
}

class ContextDrivenPlanningProvider implements ProviderAdapter {
  public readonly id = "context-driven-planning-provider";
  public readonly inputs: ModelInput[] = [];

  public async generate(input: ModelInput, options: { signal: AbortSignal }): Promise<ModelTurn> {
    options.signal.throwIfAborted();
    this.inputs.push(input);
    if (this.inputs.length === 1) {
      if (!input.tools.some((tool) => tool.name === "task_create")) throw new Error("Planning tool was not projected into the first ModelInput");
      return { type: "tool_calls", calls: [{ id: "context-create" as ToolCallId, name: "task_create", arguments: { subject: "Open Writer" } }] };
    }
    if (this.inputs.length === 2) {
      const serialized = JSON.stringify(input.messages);
      const taskId = /\bt[0-9]+\b/u.exec(serialized)?.[0];
      if (taskId === undefined) throw new Error("next ModelInput did not contain the Plan-generated task id");
      if (!serialized.includes("Current run plan")) throw new Error("next ModelInput did not contain the Plan summary");
      return { type: "tool_calls", calls: [{ id: "context-update" as ToolCallId, name: "task_update", arguments: { taskId, status: "completed" } }] };
    }
    return { type: "finish", summary: "planning complete" };
  }
}

class FailingMaterializationStore extends FilePlanStore {
  public override async apply(_runId: RunId, _mutation: import("@computer-harness/protocol").PlanningTaskMutation): Promise<never> {
    throw new Error("plan disk unavailable");
  }
}

class PlanningEventRejectingWriter implements RunEventWriter {
  public constructor(private readonly inner: JsonlRunEventWriter) {}

  public async append(draft: Parameters<RunEventWriter["append"]>[0]): ReturnType<RunEventWriter["append"]> {
    if (draft.type === "planning.task.updated") throw new Error("event append unavailable");
    return this.inner.append(draft);
  }

  public flush(): Promise<void> { return this.inner.flush(); }
  public close(): Promise<void> { return this.inner.close(); }
}

describe("Planning tools and PlanStore", () => {
  it("creates a program id, persists after the event hook, and exposes the next snapshot", async () => {
    const store = new InMemoryPlanStore();
    const tools = createPlanningTools(store);
    const create = tools.find((tool) => tool.name === "task_create");
    const update = tools.find((tool) => tool.name === "task_update");
    const list = tools.find((tool) => tool.name === "task_list");
    if (create?.category !== "planning" || update?.category !== "planning" || list?.category !== "planning") throw new Error("planning tools missing");
    const created = await create.execute({ subject: "Open Writer" }, context);
    const mutation = create.planMutationFromResult?.(created);
    if (mutation === undefined || create.afterPlanCommit === undefined) throw new Error("create mutation hooks missing");
    await create.afterPlanCommit(mutation, context);
    const createdTask = (await store.get(runId)).tasks[0];
    expect(createdTask).toMatchObject({ subject: "Open Writer", status: "pending" });
    expect(createdTask?.id).toBe("t1");

    const updated = await update.execute({ taskId: createdTask!.id, status: "in_progress" }, context);
    const updateMutation = update.planMutationFromResult?.(updated);
    if (updateMutation === undefined || update.afterPlanCommit === undefined) throw new Error("update mutation hooks missing");
    await update.afterPlanCommit(updateMutation, context);
    expect((await list.execute({}, context))).toEqual({ tasks: [{ ...createdTask, status: "in_progress" }] });
  });

  it("keeps runs isolated and writes a readable plan file", async () => {
    const root = await mkdtemp(join(tmpdir(), "computer-harness-plan-"));
    try {
      const store = new FilePlanStore(root);
      const tools = createPlanningTools(store);
      const create = tools.find((tool) => tool.name === "task_create");
      if (create?.category !== "planning" || create.planMutationFromResult === undefined || create.afterPlanCommit === undefined) throw new Error("create tool missing");
      const first = await create.execute({ subject: "First" }, context);
      const firstMutation = create.planMutationFromResult(first);
      await create.afterPlanCommit(firstMutation, context);
      const otherRun = { ...context, runId: "other-run" as RunId };
      expect(await store.get(otherRun.runId)).toEqual({ runId: otherRun.runId, tasks: [] });
      const otherCreated = await create.execute({ subject: "Other" }, otherRun);
      const otherMutation = create.planMutationFromResult(otherCreated);
      await create.afterPlanCommit(otherMutation, otherRun);
      expect((await store.get(otherRun.runId)).tasks[0]?.id).toBe("t1");
      const text = await readFile(join(root, runId, "plan.json"), "utf8");
      expect(JSON.parse(text)).toEqual(await store.get(runId));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an update before TaskCreate has returned an id", async () => {
    const tool = createPlanningTools(new InMemoryPlanStore()).find((item) => item.name === "task_update");
    if (tool === undefined) throw new Error("task_update missing");
    await expect(tool.execute({ taskId: "task-not-created", status: "completed" }, context)).rejects.toThrow(/does not exist/);
  });

  it("allocates the next short id after rebuilding legacy and current mutations", async () => {
    const store = new InMemoryPlanStore();
    await store.rebuild(runId, [
      { operation: "created", task: { id: "legacy-uuid", subject: "Legacy", status: "completed" } },
      { operation: "created", task: { id: "t2", subject: "Existing", status: "pending" } },
    ]);
    const create = createPlanningTools(store).find((tool) => tool.name === "task_create");
    if (create?.planMutationFromResult === undefined || create.afterPlanCommit === undefined) throw new Error("create hooks missing");
    const mutation = create.planMutationFromResult(await create.execute({ subject: "Next" }, context));
    await create.afterPlanCommit(mutation, context);
    expect((await store.get(runId)).tasks.at(-1)?.id).toBe("t3");

    const rebuilt = new InMemoryPlanStore();
    await rebuildPlanFromEvents(rebuilt, runId, [{
      runId,
      eventId: "event-1" as never,
      sequence: 0,
      occurredAt: "2026-09-08T00:00:00.000Z",
      type: "planning.task.updated",
      callId: "call-1" as never,
      mutation,
    }]);
    const rebuiltCreate = createPlanningTools(rebuilt).find((tool) => tool.name === "task_create");
    if (rebuiltCreate?.planMutationFromResult === undefined || rebuiltCreate.afterPlanCommit === undefined) throw new Error("rebuilt create hooks missing");
    const rebuiltMutation = rebuiltCreate.planMutationFromResult(await rebuiltCreate.execute({ subject: "After rebuild" }, context));
    await rebuiltCreate.afterPlanCommit(rebuiltMutation, context);
    expect((await rebuilt.get(runId)).tasks.at(-1)?.id).toBe("t4");
  });

  it("keeps schema and runtime validation aligned for required updates and extra fields", () => {
    const tools = createPlanningTools(new InMemoryPlanStore());
    const create = tools.find((tool) => tool.name === "task_create");
    const update = tools.find((tool) => tool.name === "task_update");
    const get = tools.find((tool) => tool.name === "task_get");
    expect(update?.inputSchema).toMatchObject({ anyOf: expect.arrayContaining([{ required: ["subject"] }, { required: ["status"] }]) });
    expect(() => create?.validate({ subject: "   " })).toThrow(/non-empty/);
    expect(() => update?.validate({ taskId: "task-1" })).toThrow(/at least one/);
    expect(() => update?.validate({ taskId: "task-1", subject: "   " })).toThrow(/non-empty/);
    expect(() => update?.validate({ taskId: "task-1", status: "completed", extra: true })).toThrow(/unknown field/);
    expect(() => get?.validate({ taskId: "task-1", extra: true })).toThrow(/unknown field/);
  });

  it("validates blockedBy references, self-blocking, and dependency cycles", async () => {
    const store = new InMemoryPlanStore();
    const tools = createPlanningTools(store);
    const update = tools.find((tool) => tool.name === "task_update");
    if (update?.category !== "planning") throw new Error("task_update missing");
    await store.apply(runId, { operation: "created", task: { id: "task-a", subject: "A", status: "pending" } });
    await store.apply(runId, { operation: "created", task: { id: "task-b", subject: "B", status: "pending" } });
    await expect(update.execute({ taskId: "task-a", blockedBy: ["task-missing"] }, context)).rejects.toThrow(/missing blocker/);
    await expect(update.execute({ taskId: "task-a", blockedBy: ["task-a"] }, context)).rejects.toThrow(/cannot block itself/);
    await update.execute({ taskId: "task-a", blockedBy: ["task-b"] }, context).then(async (output) => {
      const mutation = update.planMutationFromResult?.(output);
      if (mutation === undefined || update.afterPlanCommit === undefined) throw new Error("update hooks missing");
      await update.afterPlanCommit(mutation, context);
    });
    await expect(update.execute({ taskId: "task-b", blockedBy: ["task-a"] }, context)).rejects.toThrow(/dependency cycle/);
  });

  it("runs task_create through RunController, exposes the updated plan next turn, and persists task_update", async () => {
    const root = await mkdtemp(join(tmpdir(), "computer-harness-planning-loop-"));
    try {
      const store = new FilePlanStore(root);
      const registry = new ToolRegistry();
      registry.registerMany(createPlanningTools(store));
      const provider = new PlanningLoopProvider(store);
      const compiler = new PlanningLoopContext(registry);
      const computer = new NoGuiComputer();
      const output = join(root, "run");
      const controller = new RunController({
        runId: loopRunId,
        provider,
        computer,
        contextCompiler: compiler,
        toolRegistry: registry,
        policy: new DefaultRuntimePolicy(10, 10),
        eventWriter: new JsonlRunEventWriter(join(output, "trajectory.jsonl"), loopRunId),
        assetStore: new FileAssetStore(join(output, "assets")),
      });
      await expect(controller.start("maintain a plan")).resolves.toBe("succeeded");
      expect(computer.executeCalls).toBe(0);
      expect(provider.inputs).toHaveLength(3);
      expect(compiler.planSnapshots).toEqual([
        { tasks: 0, status: undefined },
        { tasks: 1, status: "pending" },
        { tasks: 1, status: "in_progress" },
      ]);
      expect((await store.get(loopRunId)).tasks[0]).toMatchObject({ subject: "Open Writer", status: "in_progress" });
      const events = await readRuntimeEvents(join(output, "trajectory.jsonl"));
      expect(events.filter((event) => event.type === "planning.task.updated")).toHaveLength(2);
      expect(events.filter((event) => event.type === "tool.call.completed")).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stops the Run after committed planning facts when materialization fails, then rebuilds from events", async () => {
    const root = await mkdtemp(join(tmpdir(), "computer-harness-planning-failure-"));
    try {
      const store = new FailingMaterializationStore(root);
      const registry = new ToolRegistry();
      registry.registerMany(createPlanningTools(store));
      const provider = new PlanningLoopProvider(store);
      const compiler = new PlanningLoopContext(registry);
      const computer = new NoGuiComputer();
      const output = join(root, "run");
      const controller = new RunController({
        runId: loopRunId,
        provider,
        computer,
        contextCompiler: compiler,
        toolRegistry: registry,
        policy: new DefaultRuntimePolicy(10, 10),
        eventWriter: new JsonlRunEventWriter(join(output, "trajectory.jsonl"), loopRunId),
        assetStore: new FileAssetStore(join(output, "assets")),
      });
      await expect(controller.start("fail plan persistence")).resolves.toBe("failed");
      expect(provider.inputs).toHaveLength(1);
      expect(computer.executeCalls).toBe(0);
      const events = await readRuntimeEvents(join(output, "trajectory.jsonl"));
      expect(events.some((event) => event.type === "planning.task.updated")).toBe(true);
      expect(events.some((event) => event.type === "runtime.error" && event.category === "planning_materialization_failed")).toBe(true);
      expect(events.some((event) => event.type === "run.finished" && event.outcome === "failed")).toBe(true);
      const recovery = new FilePlanStore(root);
      const rebuilt = await rebuildPlanFromEvents(recovery, loopRunId, events);
      expect(rebuilt.tasks).toHaveLength(1);
      expect(JSON.parse(await readFile(join(root, loopRunId, "plan.json"), "utf8"))).toEqual(rebuilt);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not materialize a Plan when the planning event cannot be appended", async () => {
    const root = await mkdtemp(join(tmpdir(), "computer-harness-planning-event-failure-"));
    try {
      const store = new FilePlanStore(root);
      const registry = new ToolRegistry();
      registry.registerMany(createPlanningTools(store));
      const provider: ProviderAdapter = {
        id: "event-failure-provider",
        async generate(_input, options) {
          options.signal.throwIfAborted();
          return { type: "tool_calls", calls: [{ id: "event-failure-call" as never, name: "task_create", arguments: { subject: "Never persisted" } }] };
        },
      };
      const output = join(root, "run");
      const controller = new RunController({
        runId: "planning-event-failure" as RunId,
        provider,
        computer: new NoGuiComputer(),
        contextCompiler: new PlanningLoopContext(registry),
        toolRegistry: registry,
        policy: new DefaultRuntimePolicy(1, 1),
        eventWriter: new PlanningEventRejectingWriter(new JsonlRunEventWriter(join(output, "trajectory.jsonl"), "planning-event-failure" as RunId)),
        assetStore: new FileAssetStore(join(output, "assets")),
      });
      await expect(controller.start("event append failure")).resolves.toBe("budget_exhausted");
      expect((await store.get("planning-event-failure" as RunId)).tasks).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("connects DefaultContextCompiler, RunController, registry and FilePlanStore without Provider Store access", async () => {
    const root = await mkdtemp(join(tmpdir(), "computer-harness-planning-context-loop-"));
    const currentRunId = "planning-context-loop" as RunId;
    try {
      const store = new FilePlanStore(root);
      const registry = createDefaultToolRegistry();
      registry.registerMany(createPlanningTools(store));
      const provider = new ContextDrivenPlanningProvider();
      const output = join(root, "run");
      const controller = new RunController({
        runId: currentRunId,
        provider,
        computer: new NoGuiComputer(),
        contextCompiler: new DefaultContextCompiler(registry),
        toolRegistry: registry,
        policy: new DefaultRuntimePolicy(5, 5),
        eventWriter: new JsonlRunEventWriter(join(output, "trajectory.jsonl"), currentRunId),
        assetStore: new FileAssetStore(join(output, "assets")),
      });
      await expect(controller.start("create and complete a planning task")).resolves.toBe("succeeded");
      const events = await readRuntimeEvents(join(output, "trajectory.jsonl"));
      const snapshot = reduceRuntimeEvents(events, currentRunId);
      expect(snapshot.plan.tasks).toMatchObject([{ subject: "Open Writer", status: "completed" }]);
      expect(JSON.parse(await readFile(join(root, currentRunId, "plan.json"), "utf8"))).toEqual(snapshot.plan);
      expect(provider.inputs).toHaveLength(3);
      expect(provider.inputs[1]?.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["task_create", "task_update", "terminate", "interact"]));
      expect(events.some((event) => event.type === "action.execution.started")).toBe(false);

      const baselineRegistry = createDefaultToolRegistry();
      const baselineInput = await new DefaultContextCompiler(baselineRegistry).compile({ runId: currentRunId, goal: "baseline", recentEvents: [] }, new AbortController().signal);
      expect(baselineInput.tools.map((tool) => tool.name)).not.toContain("task_create");
      expect(baselineInput.messages.some((message) => message.content.some((block) => block.type === "text" && block.text.includes("Current run plan")))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
