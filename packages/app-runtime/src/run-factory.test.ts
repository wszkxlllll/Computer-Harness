import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createMemoryRunModule, FileMemoryStore, HybridMemoryRecallService, InMemoryMemoryStore, type MemoryRunModule, type MemoryStore } from "@computer-harness/memory";
import { DefaultContextCompiler } from "@computer-harness/context";
import type { EventId, JsonValue, MemoryMutation, RunId, RuntimeEvent, SurfaceId, ToolCallId, Viewport } from "@computer-harness/protocol";
import { createDefaultToolRegistry, type Computer, type MemoryRecallService, type ModelInput, type NonComputerToolDefinition, type PlanningTaskMutation, type ProviderAdapter } from "@computer-harness/runtime";
import { createPlanningRunModule, FilePlanStore, InMemoryPlanStore, type PlanningRunModule } from "@computer-harness/planning";
import { readRuntimeEvents, reduceRuntimeEvents } from "@computer-harness/trajectory";
import { buildRunReport, createRun, createRunFactory, writeRunReport, type ResolvedRunConfig } from "./index.js";

const fixtureSurfaceRef = { surfaceId: "run-factory-desktop" as SurfaceId, generation: 1, kind: "desktop" as const };

// Check effective report defaults against current source without rebuilding dist.
vi.mock("@computer-harness/provider-glm", () => import("../../provider-glm/src/index.js"));

function config(outputDir: string): ResolvedRunConfig {
  return {
    runId: "app-runtime-test" as RunId,
    goal: "finish the fixture",
    model: "glm-5.3-flash",
    computer: { kind: "osworld", bridgeUrl: "http://fixture.invalid" },
    outputDir,
    maxSteps: 5,
    maxModelRequests: 5,
    planning: false,
    memory: "off",
    batching: "off",
    contextMode: "raw",
    contextMaxHistoryEvents: 10,
    riskProfile: "experiment",
    riskGuard: "off",
    riskModel: "off",
    riskMaxModelRequests: 2,
    riskTimeoutMs: 100,
    cleanupDeadlineMs: 100,
    glmThinking: "enabled",
  };
}

function fakeComputer(calls: { open: number; observe: number; close: number }): Computer {
  const viewport: Viewport = { width: 1, height: 1, coordinateSpace: "physical" };
  const session = {
    id: "fixture-session",
    backend: "fixture",
    viewport,
    capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false },
    openedAt: "2026-09-17T00:00:00.000Z",
  };
  return {
    async open() {
      calls.open += 1;
      return session;
    },
    async observe() {
      calls.observe += 1;
      return {
        capturedAt: "2026-09-17T00:00:00.000Z",
        viewport,
        surfaceRef: fixtureSurfaceRef,
        screenshot: { mediaType: "image/png", data: new Uint8Array([1, 2, 3]) },
      };
    },
    async execute(_session, action) {
      return { actionId: action.actionId, status: "completed" };
    },
    async close() {
      calls.close += 1;
    },
  };
}

function recoveryReportBaseEvents(runId: RunId): RuntimeEvent[] {
  const viewport: Viewport = { width: 800, height: 600, coordinateSpace: "physical" };
  const sessionId = `${runId}-session` as import("@computer-harness/protocol").ComputerSessionId;
  const observationId = `${runId}-observation` as import("@computer-harness/protocol").ObservationId;
  const time = (offset: number) => `2026-10-01T02:00:0${offset}.000Z`;
  return [
    { eventId: `${runId}-event-0` as EventId, runId, sequence: 0, occurredAt: time(0), type: "run.created", goal: "Inspect the requested information." },
    { eventId: `${runId}-event-1` as EventId, runId, sequence: 1, occurredAt: time(1), type: "run.started" },
    { eventId: `${runId}-event-2` as EventId, runId, sequence: 2, occurredAt: time(2), type: "computer.open.started" },
    {
      eventId: `${runId}-event-3` as EventId,
      runId,
      sequence: 3,
      occurredAt: time(3),
      type: "computer.open.completed",
      session: {
        id: sessionId,
        backend: "fixture",
        viewport,
        capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false },
        openedAt: time(3),
      },
    },
    {
      eventId: `${runId}-event-4` as EventId,
      runId,
      sequence: 4,
      occurredAt: time(4),
      type: "observation.created",
      observation: {
        id: observationId,
        runId,
        computerSessionId: sessionId,
        surfaceRef: { ...fixtureSurfaceRef, surfaceId: `${runId}-surface` as SurfaceId },
        capturedAt: time(4),
        viewport,
        screenshot: { assetId: `${runId}-asset` as import("@computer-harness/protocol").AssetId, relativePath: "screenshots/current.png", mediaType: "image/png", byteLength: 1 },
      },
    },
  ];
}

describe("app-runtime RunHandle", () => {
  it("passes the frozen Run preference snapshot to Context but not provider factories", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-app-assistant-preferences-"));
    const preferences = {
      version: 1 as const,
      responseDetail: "detailed" as const,
      stepExplanation: "more" as const,
      preferredLanguage: "zh-CN" as const,
      additionalGuidance: "Group findings by topic.",
    };
    const inputs: ModelInput[] = [];
    let providerConfig: ResolvedRunConfig | undefined;
    try {
      const handle = await createRun({ ...config(outputDir), assistantPreferences: preferences }, {
        createProvider: (options) => {
          providerConfig = options.config;
          return {
            id: "assistant-preferences-provider",
            async generate(input) {
              inputs.push(input);
              return { type: "finish", summary: "The page was summarized." };
            },
          };
        },
        createComputer: () => Promise.resolve(fakeComputer({ open: 0, observe: 0, close: 0 })),
      });
      expect(handle.config.assistantPreferences).toEqual(preferences);
      await expect(handle.start()).resolves.toBe("succeeded");
      const trace = inputs[0]?.contextBudget?.trace;
      expect(providerConfig).not.toHaveProperty("assistantPreferences");
      expect(inputs[0]?.messages.some((message) => message.content.some((block) =>
        block.type === "text" && block.text.includes("Group findings by topic."),
      ))).toBe(true);
      expect(JSON.stringify(trace)).not.toContain("Group findings by topic.");
      expect(trace?.assistantPreferences).toMatchObject({ included: true, responseDetail: "detailed", additionalGuidancePresent: true });
      const report = await handle.report();
      const modelRequest = report.events.find((event) => event.type === "model.request.started");
      expect(modelRequest?.type === "model.request.started" ? JSON.stringify(modelRequest.contextBudget?.trace) : "").not.toContain("Group findings by topic.");
      await handle.close();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("keeps the default Planning and Memory module tools and Context path working", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-app-default-modules-"));
    let request = 0;
    let finalContext = "";
    const provider: ProviderAdapter = {
      id: "default-module-regression-provider",
      async generate(input, options) {
        options.signal.throwIfAborted();
        request += 1;
        if (request === 1) return { type: "tool_calls", calls: [{ id: "default-plan-create" as ToolCallId, name: "task_create", arguments: { subject: "default phase" } }] };
        if (request === 2) return { type: "tool_calls", calls: [{ id: "default-memory-write" as ToolCallId, name: "memory_write_fact", arguments: { key: "default_marker", value: "default context fact" } }] };
        finalContext = JSON.stringify(input.messages);
        return { type: "finish", summary: "default module path complete" };
      },
    };
    try {
      const handle = await createRun({ ...config(outputDir), planning: true, memory: "facts" }, {
        createProvider: () => provider,
        createComputer: () => Promise.resolve(fakeComputer({ open: 0, observe: 0, close: 0 })),
      });
      await expect(handle.start()).resolves.toBe("succeeded");
      const report = await handle.report();
      expect(request).toBe(3);
      expect(finalContext).toContain("Current run plan");
      expect(finalContext).toContain("default context fact");
      expect(report.events.some((event) => event.type === "planning.task.updated")).toBe(true);
      expect(report.events.some((event) => event.type === "memory.updated" && event.source === "tool")).toBe(true);
      expect((await new FilePlanStore(join(outputDir, "plan-store")).get("app-runtime-test" as RunId)).tasks[0]?.subject).toBe("default phase");
      expect((await new FileMemoryStore(join(outputDir, "memory-store")).get("app-runtime-test" as RunId)).facts[0]?.value).toBe("default context fact");
      await handle.close();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("runs custom Planning and Memory tools through their coordinated Run modules and Context projections", async () => {
    const outputA = await mkdtemp(join(tmpdir(), "harness-app-modules-a-"));
    const outputB = await mkdtemp(join(tmpdir(), "harness-app-modules-b-"));
    const planStores = new Map<RunId, InMemoryPlanStore>();
    const memoryStores = new Map<RunId, InMemoryMemoryStore>();
    const planningModules = new Map<RunId, PlanningRunModule>();
    const memoryModules = new Map<RunId, MemoryRunModule>();
    const capturedContexts = new Map<RunId, string>();
    const evidenceByRun = new Map<RunId, {
      liveSnapshot: ReturnType<typeof reduceRuntimeEvents>;
      controllerEvents: RuntimeEvent[];
      fileEvents: RuntimeEvent[];
    }>();
    const planningCloseCalls: RunId[] = [];
    const memoryCloseCalls: RunId[] = [];
    const recallInputs: Array<{ runId: RunId; value?: string }> = [];
    const recall: MemoryRecallService = {
      async search(state, query, signal) {
        signal.throwIfAborted();
        recallInputs.push({ runId: query.runId, value: state.facts[0]?.value });
        return {
          method: "lexical",
          semanticStatus: "disabled",
          stateStable: true,
          embeddingBudgetUsed: 0,
          embeddingBudgetLimit: 0,
          admitted: state.facts.map((fact) => ({ id: fact.id, score: 1, match: "exact" })),
          revalidation: [],
          excluded: [],
        };
      },
    };
    const createPlanningTool = (targetRunId: RunId): NonComputerToolDefinition => ({
      name: "custom_plan_create",
      description: "Create a custom phase in the active Run module.",
      category: "planning",
      inputSchema: { type: "object", properties: { subject: { type: "string" } }, required: ["subject"], additionalProperties: false },
      validate(args) {
        if (typeof args !== "object" || args === null || Array.isArray(args) || typeof args.subject !== "string") throw new Error("subject required");
      },
      async execute(args) {
        if (typeof args !== "object" || args === null || Array.isArray(args) || typeof args.subject !== "string") throw new Error("subject required");
        return { operation: "created", task: { id: "custom-plan", subject: `${args.subject}-${targetRunId}`, status: "pending" } } as unknown as JsonValue;
      },
      planMutationFromResult(output) { return output as unknown as PlanningTaskMutation; },
    });
    const createMemoryTool = (targetRunId: RunId): NonComputerToolDefinition => ({
      name: "custom_memory_write",
      description: "Write a custom Run Memory fact.",
      category: "side",
      inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
      validate(args) {
        if (typeof args !== "object" || args === null || Array.isArray(args) || typeof args.value !== "string") throw new Error("value required");
      },
      async execute(args) {
        if (typeof args !== "object" || args === null || Array.isArray(args) || typeof args.value !== "string") throw new Error("value required");
        return {
          operation: "upsert_fact",
          fact: {
            id: "custom-memory",
            subject: { type: "run" },
            key: "custom_marker",
            value: `${args.value}-${targetRunId}`,
            sourceEventId: "pending:custom-memory" as EventId,
            status: "active",
            scope: { kind: "run" },
            retentionClass: "stable",
            updatedSequence: 0,
          },
        } as unknown as JsonValue;
      },
      memoryMutationFromResult(output) { return output as unknown as MemoryMutation; },
    });
    const runFactory = createRunFactory({
      createProvider: ({ config: resolved }) => {
        const targetRunId = resolved.runId!;
        let request = 0;
        return {
          id: "custom-module-provider",
          async generate(input, options) {
            options.signal.throwIfAborted();
            request += 1;
            if (request === 1) {
              expect(input.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["custom_plan_create", "custom_memory_write"]));
              return { type: "tool_calls", calls: [{ id: `plan-${targetRunId}` as ToolCallId, name: "custom_plan_create", arguments: { subject: "module-plan" } }] };
            }
            if (request === 2) {
              return { type: "tool_calls", calls: [{ id: `memory-${targetRunId}` as ToolCallId, name: "custom_memory_write", arguments: { value: "module-memory" } }] };
            }
            capturedContexts.set(targetRunId, JSON.stringify(input.messages));
            return { type: "finish", summary: `module run ${targetRunId} complete` };
          },
        };
      },
      createComputer: () => Promise.resolve(fakeComputer({ open: 0, observe: 0, close: 0 })),
      createPlanningModule: ({ runId }) => {
        const store = new InMemoryPlanStore();
        planStores.set(runId, store);
        const baseModule = createPlanningRunModule(runId, store, {
          tools: [createPlanningTool(runId)],
          projectContext: (plan) => {
            for (const task of plan.tasks) task.subject = `context-plan:${task.subject}`;
            return plan;
          },
          close: async () => { planningCloseCalls.push(runId); },
        });
        const module: PlanningRunModule = {
          ...baseModule,
          async apply(mutation) {
            const applied = await store.apply(runId, mutation);
            mutation.task.subject = `apply-mutated:${mutation.task.subject}`;
            return applied;
          },
        };
        planningModules.set(runId, module);
        return module;
      },
      createMemoryModule: ({ runId, mode }) => {
        const store = new InMemoryMemoryStore();
        memoryStores.set(runId, store);
        const baseModule = createMemoryRunModule(runId, store, {
          mode,
          tools: [createMemoryTool(runId)],
          recall,
          projectContext: (memory) => {
            for (const fact of memory.facts) fact.value = `context-memory:${fact.value}`;
            return memory;
          },
          close: async () => { memoryCloseCalls.push(runId); },
        });
        const module: MemoryRunModule = {
          ...baseModule,
          async apply(mutation) {
            const applied = await store.apply(runId, mutation);
            if (mutation.operation === "upsert_fact") mutation.fact.value = `apply-mutated:${mutation.fact.value}`;
            return applied;
          },
        };
        memoryModules.set(runId, module);
        return module;
      },
    });
    const reports: Array<{ events: RuntimeEvent[] }> = [];
    try {
      for (const [targetRunId, outputDir] of [["module-run-a" as RunId, outputA], ["module-run-b" as RunId, outputB]] as const) {
        const handle = await runFactory({ ...config(outputDir), runId: targetRunId, planning: true, memory: "facts" });
        await expect(handle.start()).resolves.toBe("succeeded");
        reports.push(await handle.report());
        evidenceByRun.set(targetRunId, {
          liveSnapshot: handle.controller.getSnapshot(),
          controllerEvents: [...handle.controller.getEvents()],
          fileEvents: await readRuntimeEvents(join(outputDir, "trajectory.jsonl")),
        });
        expect(planningCloseCalls.filter((id) => id === targetRunId)).toHaveLength(1);
        expect(memoryCloseCalls.filter((id) => id === targetRunId)).toHaveLength(1);
        await handle.close();
      }

      for (const targetRunId of ["module-run-a", "module-run-b"] as RunId[]) {
        const serialized = capturedContexts.get(targetRunId) ?? "";
        expect(serialized).toContain(`context-plan:module-plan-${targetRunId}`);
        expect(serialized).toContain(`context-memory:module-memory-${targetRunId}`);
        const otherRunId = targetRunId === "module-run-a" ? "module-run-b" : "module-run-a";
        expect(serialized).not.toContain(otherRunId);
        expect((await planStores.get(targetRunId)!.get(targetRunId)).tasks[0]?.subject).toBe(`module-plan-${targetRunId}`);
        expect((await memoryStores.get(targetRunId)!.get(targetRunId)).facts[0]?.value).toBe(`module-memory-${targetRunId}`);

        const evidence = evidenceByRun.get(targetRunId)!;
        expect(evidence.liveSnapshot.plan.tasks[0]?.subject).toBe(`module-plan-${targetRunId}`);
        expect(evidence.liveSnapshot.memory.facts[0]?.value).toBe(`module-memory-${targetRunId}`);
        const controllerPlanEvent = evidence.controllerEvents.find((event) => event.type === "planning.task.updated");
        const controllerMemoryEvent = evidence.controllerEvents.find((event) => event.type === "memory.updated" && event.source === "tool");
        expect(controllerPlanEvent).toMatchObject({ mutation: { task: { subject: `module-plan-${targetRunId}` } } });
        expect(controllerMemoryEvent).toMatchObject({ mutation: { fact: { value: `module-memory-${targetRunId}` } } });
        const filePlanEvent = evidence.fileEvents.find((event) => event.type === "planning.task.updated");
        const fileMemoryEvent = evidence.fileEvents.find((event) => event.type === "memory.updated" && event.source === "tool");
        expect(filePlanEvent).toMatchObject({ mutation: { task: { subject: `module-plan-${targetRunId}` } } });
        expect(fileMemoryEvent).toMatchObject({ mutation: { fact: { value: `module-memory-${targetRunId}` } } });
        const replayedFileSnapshot = reduceRuntimeEvents(evidence.fileEvents, targetRunId);
        expect(replayedFileSnapshot.plan.tasks[0]?.subject).toBe(`module-plan-${targetRunId}`);
        expect(replayedFileSnapshot.memory.facts[0]?.value).toBe(`module-memory-${targetRunId}`);
      }
      expect(recallInputs).toEqual(expect.arrayContaining([
        { runId: "module-run-a", value: "context-memory:module-memory-module-run-a" },
        { runId: "module-run-b", value: "context-memory:module-memory-module-run-b" },
      ]));

      const allEvents = reports.flatMap((report) => report.events);
      for (const targetRunId of ["module-run-a", "module-run-b"] as RunId[]) {
        await planningModules.get(targetRunId)!.restoreFromEvents(allEvents);
        await memoryModules.get(targetRunId)!.restoreFromEvents(allEvents);
        expect((await planStores.get(targetRunId)!.get(targetRunId)).tasks[0]?.subject).toBe(`module-plan-${targetRunId}`);
        expect((await memoryStores.get(targetRunId)!.get(targetRunId)).facts[0]?.value).toBe(`module-memory-${targetRunId}`);
      }
    } finally {
      await rm(outputA, { recursive: true, force: true });
      await rm(outputB, { recursive: true, force: true });
    }
  });

  it("rejects competing module and legacy factories, and does not construct disabled modules", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-app-modules-disabled-"));
    const createPlanningModule = vi.fn(() => { throw new Error("disabled Planning module must not be created"); });
    const createMemoryModule = vi.fn(() => { throw new Error("disabled Memory module must not be created"); });
    try {
      await expect(createRun({ ...config(outputDir), planning: true }, {
        createPlanningModule,
        createPlanStore: () => new InMemoryPlanStore(),
      })).rejects.toThrow(/createPlanningModule and legacy createPlanStore/iu);
      await expect(createRun({ ...config(outputDir), memory: "facts" }, {
        createMemoryModule,
        createMemoryStore: () => new InMemoryMemoryStore(),
      })).rejects.toThrow(/createMemoryModule and legacy Memory factories/iu);

      const handle = await createRun(config(outputDir), {
        createProvider: () => ({ id: "disabled-module-provider", async generate() { return { type: "finish", summary: "modules off" }; } }),
        createComputer: () => Promise.resolve(fakeComputer({ open: 0, observe: 0, close: 0 })),
        createPlanningModule,
        createMemoryModule,
      });
      await expect(handle.start()).resolves.toBe("succeeded");
      expect(createPlanningModule).not.toHaveBeenCalled();
      expect(createMemoryModule).not.toHaveBeenCalled();
      expect((await handle.report()).summary.tools).not.toContain("custom_memory_write");
      await handle.close();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("does not expose ExecutionSegment unless explicitly opted in", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-app-runtime-segment-default-"));
    const provider: ProviderAdapter = { id: "fixture-provider", async generate() { return { type: "finish", summary: "unused" }; } };
    let observedTools: readonly string[] = [];
    let observedSegments: string | undefined;
    try {
      const handle = await createRun({
        ...config(outputDir),
        grounding: "dom-catalog-v1",
        computer: { kind: "cua", socketPath: "fixture-socket", grounding: "dom-catalog-v1", managedBrowserUrl: "http://127.0.0.1:9222", managedBrowserProfileMode: "ephemeral" },
      }, {
        createProvider: () => provider,
        createComputer: () => Promise.resolve(fakeComputer({ open: 0, observe: 0, close: 0 })),
        createContextCompiler: (tools, features) => {
          observedTools = tools.list().map((tool) => tool.name);
          observedSegments = features.executionSegments;
          return new DefaultContextCompiler(tools, { features });
        },
      });
      expect(observedTools).not.toContain("execution_segment_set");
      expect(observedSegments).toBe("off");
      await handle.close();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it.each([
    [undefined, "enabled"], [16384, "low"], [8192, "high"], [8192, "max"], [8192, "disabled"],
  ] as const)("assembles a fake Run with output budget %s and thinking %s, then closes Controller-owned resources once", async (budget, thinking) => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-app-runtime-"));
    const calls = { provider: 0, open: 0, observe: 0, close: 0 };
    const provider: ProviderAdapter = {
      id: "fixture-provider",
      async generate() {
        calls.provider += 1;
        return { type: "finish", summary: "fixture done", reportedStatus: "success" };
      },
    };
    try {
      const handle = await createRun({ ...config(outputDir), glmThinking: thinking, ...(budget === undefined ? {} : { glmMaxOutputTokens: budget }) }, {
        credentials: { glmApiKey: "must-not-be-serialized" },
        createProvider: (options) => {
          expect(options.credentials.glmApiKey).toBe("must-not-be-serialized");
          expect(options.config).not.toHaveProperty("credentials");
          return provider;
        },
        createComputer: () => Promise.resolve(fakeComputer(calls)),
      });
      expect(calls).toMatchObject({ provider: 0, open: 0, observe: 0, close: 0 });
      const outcome = await handle.start();
      expect(outcome).toBe("succeeded");
      expect(calls).toMatchObject({ provider: 1, open: 1, observe: 1, close: 1 });
      await expect(handle.start()).rejects.toThrow(/only start once/iu);
      const report = await handle.report();
      expect(report.summary).toMatchObject({
        runId: "app-runtime-test",
        goal: "finish the fixture",
        model: "glm-5.3-flash",
        computer: "osworld",
        maxSteps: 5,
        maxModelRequests: 5,
        memoryRetrieval: "off",
        monitor: "off",
        runtimeOutcome: "succeeded",
        glmMaxOutputTokens: budget ?? 8192,
        glmThinking: thinking === "disabled" ? "enabled" : thinking,
      });
      expect(report.events.map((event) => event.type)).toEqual([
        "run.created",
        "run.started",
        "computer.open.started",
        "computer.open.completed",
        "computer.surface.transitioned",
        "observation.created",
        "model.request.started",
        "model.response.received",
        "run.finished",
      ]);
      expect(JSON.stringify(report.summary)).not.toContain("must-not-be-serialized");
      await writeRunReport(report, outputDir);
      expect(JSON.parse(await readFile(join(outputDir, "summary.json"), "utf8"))).toMatchObject({ runtimeOutcome: "succeeded" });
      await handle.close();
      expect(calls.close).toBe(1);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("writes non-model recovery evidence for a budget-stopped Run without promoting Plan or Memory to verified facts", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-app-runtime-recovery-report-"));
    const runId = "recovery-report-run" as RunId;
    const viewport = { width: 800, height: 600, coordinateSpace: "physical" as const };
    const session = {
      id: "recovery-session",
      backend: "fixture",
      viewport,
      capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false },
      openedAt: "2026-10-01T01:00:00.000Z",
    };
    const events: RuntimeEvent[] = [
      { eventId: "recovery-event-0" as EventId, runId, sequence: 0, occurredAt: "2026-10-01T01:00:00.000Z", type: "run.created", goal: "Compare the requested options." },
      { eventId: "recovery-event-1" as EventId, runId, sequence: 1, occurredAt: "2026-10-01T01:00:00.001Z", type: "run.started" },
      { eventId: "recovery-event-2" as EventId, runId, sequence: 2, occurredAt: "2026-10-01T01:00:00.002Z", type: "computer.open.started" },
      { eventId: "recovery-event-3" as EventId, runId, sequence: 3, occurredAt: "2026-10-01T01:00:00.003Z", type: "computer.open.completed", session },
      {
        eventId: "recovery-event-4" as EventId,
        runId,
        sequence: 4,
        occurredAt: "2026-10-01T01:00:00.004Z",
        type: "observation.created",
        observation: {
          id: "recovery-observation" as import("@computer-harness/protocol").ObservationId,
          runId,
          computerSessionId: session.id as import("@computer-harness/protocol").ComputerSessionId,
          surfaceRef: { ...fixtureSurfaceRef, surfaceId: "recovery-desktop" as SurfaceId },
          capturedAt: "2026-10-01T01:00:00.004Z",
          viewport,
          screenshot: { assetId: "recovery-asset" as import("@computer-harness/protocol").AssetId, relativePath: "screenshots/observation.png", mediaType: "image/png", byteLength: 1 },
        },
      },
      {
        eventId: "recovery-event-5" as EventId,
        runId,
        sequence: 5,
        occurredAt: "2026-10-01T01:00:00.005Z",
        type: "planning.task.updated",
        callId: "recovery-plan-call" as ToolCallId,
        mutation: { operation: "created", task: { id: "phase-1", subject: "sensitive plan text", status: "in_progress" } },
      },
      {
        eventId: "recovery-event-6" as EventId,
        runId,
        sequence: 6,
        occurredAt: "2026-10-01T01:00:00.006Z",
        type: "memory.updated",
        callId: "recovery-memory-call" as ToolCallId,
        source: "tool",
        mutation: { operation: "upsert_fact", fact: { id: "memory-id", subject: { type: "run" }, key: "sensitive-memory-key", value: "sensitive-memory-value", sourceEventId: "recovery-event-6" as EventId, status: "active", updatedSequence: 6 } },
      },
      { eventId: "recovery-event-7" as EventId, runId, sequence: 7, occurredAt: "2026-10-01T01:00:00.007Z", type: "runtime.error", category: "budget", message: "action budget exhausted at 5; finish or continue without GUI actions" },
      { eventId: "recovery-event-8" as EventId, runId, sequence: 8, occurredAt: "2026-10-01T01:00:00.008Z", type: "run.finished", outcome: "budget_exhausted" },
    ];
    try {
      await writeFile(join(outputDir, "trajectory.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
      const report = await buildRunReport({ ...config(outputDir), runId, planning: true, memory: "facts" }, runId, [], []);
      expect(report.summary).toMatchObject({ runtimeOutcome: "budget_exhausted", modelSummary: null });
      expect(report.summary.recoveryReport).toMatchObject({
        businessResult: "not_assessed",
        modelReply: { status: "not_recorded" },
        notDeliveredNote: expect.stringContaining("No final model reply was recorded"),
        latestObservation: { sourceEventId: "recovery-event-4", observationId: "recovery-observation", capturedAt: "2026-10-01T01:00:00.004Z", sourceUrl: null, sourceUrlStatus: "unknown_not_recorded" },
        budget: { exhaustedKinds: ["gui_actions"], evidenceEventIds: ["recovery-event-7"] },
        planState: { tasks: [{ id: "phase-1", status: "in_progress", sourceEventId: "recovery-event-5" }] },
        memoryState: { facts: [{ id: "memory-id", status: "active", sourceEventId: "recovery-event-6" }] },
      });
      await writeRunReport(report, outputDir);
      const markdown = await readFile(join(outputDir, "report.md"), "utf8");
      expect(markdown).toContain("## Model reply");
      expect(markdown).toContain("## Program-generated Runtime evidence");
      expect(markdown).toContain("source URL: unknown");
      expect(markdown).toContain("Plan state references (not environment verification)");
      expect(markdown).toContain("Run Memory state references (model-authored, values omitted, not independently verified)");
      expect(markdown).not.toContain("sensitive plan text");
      expect(markdown).not.toContain("sensitive-memory-key");
      expect(markdown).not.toContain("sensitive-memory-value");
      expect(JSON.parse(await readFile(join(outputDir, "summary.json"), "utf8"))).toMatchObject({ runtimeOutcome: "budget_exhausted", modelSummary: null });
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("preserves timeout, cancellation, and unknown-side-effect evidence in the non-model report", async () => {
    const scenarios = [
      { id: "api-timeout", outcome: "failed" as const, category: "provider", code: "API_TIMEOUT", message: "Request timed out; opaque private body remains in the original event." },
      { id: "cancelled", outcome: "cancelled" as const, category: "cancelled", code: "ABORTED", message: "Request was cancelled." },
    ];
    for (const scenario of scenarios) {
      const outputDir = await mkdtemp(join(tmpdir(), `harness-app-runtime-recovery-${scenario.id}-`));
      const runId = `recovery-${scenario.id}` as RunId;
      const events = [
        ...recoveryReportBaseEvents(runId),
        { eventId: `${runId}-event-5` as EventId, runId, sequence: 5, occurredAt: "2026-10-01T02:00:05.000Z", type: "model.request.started", providerId: "fixture-provider", requestId: `${runId}-request` },
        { eventId: `${runId}-event-6` as EventId, runId, sequence: 6, occurredAt: "2026-10-01T02:00:06.000Z", type: "model.request.failed", category: scenario.category, code: scenario.code, message: scenario.message, retryable: false, requestId: `${runId}-request` },
        { eventId: `${runId}-event-7` as EventId, runId, sequence: 7, occurredAt: "2026-10-01T02:00:07.000Z", type: "run.finished", outcome: scenario.outcome },
      ] as RuntimeEvent[];
      try {
        await writeFile(join(outputDir, "trajectory.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
        const report = await buildRunReport({ ...config(outputDir), runId }, runId, [], []);
        expect(report.summary).toMatchObject({ runtimeOutcome: scenario.outcome, modelSummary: null });
        expect(report.summary.recoveryReport).toMatchObject({
          modelReply: { status: "not_recorded" },
          notDeliveredNote: expect.stringContaining("No final model reply was recorded"),
          evidenceEvents: [{ eventId: `${runId}-event-6`, type: "model.request.failed", category: scenario.category, code: scenario.code, retryable: false }],
        });
        expect((report.summary.metrics as { providerErrors: Array<{ message: string }> }).providerErrors[0]?.message).toBe(scenario.message);
        await writeRunReport(report, outputDir);
        const markdown = await readFile(join(outputDir, "report.md"), "utf8");
        expect(markdown).not.toContain("opaque private body");
        expect(markdown).toContain("Failure/error event references");
      } finally {
        await rm(outputDir, { recursive: true, force: true });
      }
    }

    const outputDir = await mkdtemp(join(tmpdir(), "harness-app-runtime-recovery-unknown-side-effect-"));
    const runId = "recovery-unknown-side-effect" as RunId;
    const latestObservationId = `${runId}-observation` as import("@computer-harness/protocol").ObservationId;
    const callId = `${runId}-call` as ToolCallId;
    const action = { actionId: "unknown-action" as import("@computer-harness/protocol").ActionId, basedOn: latestObservationId, kind: "click" as const, point: { x: 20, y: 30 } };
    const call = { id: callId, name: "click", arguments: { x: 20, y: 30 } };
    const events: RuntimeEvent[] = [
      ...recoveryReportBaseEvents(runId),
      { eventId: `${runId}-event-5` as EventId, runId, sequence: 5, occurredAt: "2026-10-01T02:00:05.000Z", type: "model.request.started", providerId: "fixture-provider", requestId: `${runId}-request` },
      { eventId: `${runId}-event-6` as EventId, runId, sequence: 6, occurredAt: "2026-10-01T02:00:06.000Z", type: "model.response.received", requestId: `${runId}-request`, turn: { type: "tool_calls", calls: [call] } },
      { eventId: `${runId}-event-7` as EventId, runId, sequence: 7, occurredAt: "2026-10-01T02:00:07.000Z", type: "tool.call.received", call },
      { eventId: `${runId}-event-8` as EventId, runId, sequence: 8, occurredAt: "2026-10-01T02:00:08.000Z", type: "action.proposed", callId, action },
      { eventId: `${runId}-event-9` as EventId, runId, sequence: 9, occurredAt: "2026-10-01T02:00:09.000Z", type: "action.execution.started", action },
      { eventId: `${runId}-event-10` as EventId, runId, sequence: 10, occurredAt: "2026-10-01T02:00:10.000Z", type: "run.finished", outcome: "outcome_unknown" },
    ];
    try {
      await writeFile(join(outputDir, "trajectory.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
      const report = await buildRunReport({ ...config(outputDir), runId }, runId, [], []);
      expect(report.summary).toMatchObject({ runtimeOutcome: "outcome_unknown", modelSummary: null });
      expect(report.summary.recoveryReport).toMatchObject({
        businessResult: "not_assessed",
        modelReply: { status: "not_recorded" },
        unknownSideEffects: { status: "unknown", actionIds: ["unknown-action"] },
        notDeliveredNote: expect.stringContaining("program does not recommend replay"),
      });
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("does not revive the old Observation after a completed window handoff with no fresh frame", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-app-runtime-recovery-handoff-no-frame-"));
    const runId = "recovery-handoff-no-frame" as RunId;
    const nextSession = {
      id: `${runId}-session` as import("@computer-harness/protocol").ComputerSessionId,
      backend: "fixture",
      viewport: { width: 800, height: 600, coordinateSpace: "physical" as const },
      capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false },
      openedAt: "2026-10-01T02:00:03.000Z",
    };
    const events: RuntimeEvent[] = [
      ...recoveryReportBaseEvents(runId),
      { eventId: "recovery-handoff-no-frame-event-5" as EventId, runId, sequence: 5, occurredAt: "2026-10-01T02:00:05.000Z", type: "computer.window.handoff.requested", sourceActionId: "handoff-action", reasonCode: "foreground_mismatch" },
      { eventId: "recovery-handoff-no-frame-event-6" as EventId, runId, sequence: 6, occurredAt: "2026-10-01T02:00:06.000Z", type: "computer.window.handoff.completed", target: { pid: 2345, windowId: 6789 }, session: nextSession },
      { eventId: "recovery-handoff-no-frame-event-7" as EventId, runId, sequence: 7, occurredAt: "2026-10-01T02:00:07.000Z", type: "run.finished", outcome: "cancelled" },
    ];
    try {
      await writeFile(join(outputDir, "trajectory.jsonl"), events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
      const report = await buildRunReport({ ...config(outputDir), runId }, runId, [], []);
      expect(report.snapshot.latestObservationId).toBeUndefined();
      expect(report.summary.recoveryReport).toMatchObject({
        runId,
        runtimeOutcome: "cancelled",
        latestObservation: null,
        notDeliveredNote: expect.stringContaining("No final model reply was recorded"),
      });
      await writeRunReport(report, outputDir);
      expect(await readFile(join(outputDir, "report.md"), "utf8")).toContain("Latest observation: unavailable in the committed event set.");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("reports an unknown final target after any started switch without a newer confirmed handoff", async () => {
    for (const scenario of [
      { id: "refused", terminal: true, receiptStatus: "refused" as const, outcome: "failed" as const },
      { id: "failed", terminal: true, receiptStatus: "failed" as const, outcome: "outcome_unknown" as const },
      { id: "unresolved", terminal: false, receiptStatus: undefined, outcome: "outcome_unknown" as const },
    ]) {
      const outputDir = await mkdtemp(join(tmpdir(), `harness-app-runtime-window-switch-${scenario.id}-`));
      const runId = `window-switch-${scenario.id}` as RunId;
      const baseEvents = recoveryReportBaseEvents(runId);
      const observationId = `${runId}-observation` as import("@computer-harness/protocol").ObservationId;
      const callId = `${runId}-call` as ToolCallId;
      const action = {
        actionId: `${runId}-action` as import("@computer-harness/protocol").ActionId,
        basedOn: observationId,
        kind: "switch_window" as const,
        windowRef: "opaque-window-ref",
      };
      const call = { id: callId, name: "switch_window", arguments: { windowRef: "opaque-window-ref" } };
      const events: RuntimeEvent[] = [
        ...baseEvents,
        { eventId: `${runId}-event-5` as EventId, runId, sequence: 5, occurredAt: "2026-10-01T02:00:05.000Z", type: "model.request.started", providerId: "fixture-provider", requestId: `${runId}-request` },
        { eventId: `${runId}-event-6` as EventId, runId, sequence: 6, occurredAt: "2026-10-01T02:00:06.000Z", type: "model.response.received", requestId: `${runId}-request`, turn: { type: "tool_calls", calls: [call] } },
        { eventId: `${runId}-event-7` as EventId, runId, sequence: 7, occurredAt: "2026-10-01T02:00:07.000Z", type: "tool.call.received", call },
        { eventId: `${runId}-event-8` as EventId, runId, sequence: 8, occurredAt: "2026-10-01T02:00:08.000Z", type: "action.proposed", callId, action },
        { eventId: `${runId}-event-9` as EventId, runId, sequence: 9, occurredAt: "2026-10-01T02:00:09.000Z", type: "action.execution.started", action },
        ...(scenario.terminal ? [
          { eventId: `${runId}-event-10` as EventId, runId, sequence: 10, occurredAt: "2026-10-01T02:00:10.000Z", type: "action.execution.failed", receipt: { actionId: action.actionId, status: scenario.receiptStatus, message: `fixture ${scenario.receiptStatus}` } },
          { eventId: `${runId}-event-11` as EventId, runId, sequence: 11, occurredAt: "2026-10-01T02:00:11.000Z", type: "tool.call.failed", result: { callId, status: "failed", error: { code: `ACTION_${scenario.receiptStatus!.toUpperCase()}`, message: `fixture ${scenario.receiptStatus}` } } },
        ] : []),
        { eventId: `${runId}-event-12` as EventId, runId, sequence: scenario.terminal ? 12 : 10, occurredAt: "2026-10-01T02:00:12.000Z", type: "run.finished", outcome: scenario.outcome },
      ];
      try {
        await writeFile(join(outputDir, "trajectory.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
        const report = await buildRunReport({
          ...config(outputDir),
          runId,
          windowSwitch: "opened-windows-v1",
          computer: { kind: "cua", socketPath: "fixture.sock", screenshotDir: "screenshots", windowTarget: { pid: 1234, windowId: 5678 } },
        }, runId, [], []);
        expect(report.summary).toMatchObject({ windowSwitch: "opened-windows-v1", runtimeOutcome: scenario.outcome, finalComputerTarget: null });
        expect(report.snapshot.latestObservationId).toBeUndefined();
        await writeRunReport(report, outputDir);
        expect(await readFile(join(outputDir, "report.md"), "utf8")).toContain("Final target: unknown after a model-selected window switch began");
      } finally {
        await rm(outputDir, { recursive: true, force: true });
      }
    }
  });

  it("reports the verified window-target tool allowlist without enabling unverified primitives", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-app-runtime-window-tools-"));
    const calls = { open: 0, observe: 0, close: 0 };
    const windowConfig: ResolvedRunConfig = {
      ...config(outputDir),
      computer: { kind: "cua", socketPath: "fixture.sock", screenshotDir: "screenshots", windowTarget: { pid: 1234, windowId: 5678 } },
    };
    try {
      const handle = await createRun(windowConfig, {
        createProvider: () => ({ id: "fixture-provider", async generate() { return { type: "finish", summary: "window done" }; } }),
        createComputer: () => Promise.resolve(fakeComputer(calls)),
      });
      await expect(handle.start()).resolves.toBe("succeeded");
      const report = await handle.report();
      expect(report.summary.computerTarget).toEqual({ mode: "window", pid: 1234, windowId: 5678, deliveryMode: "background" });
      expect(report.summary.tools).toEqual(expect.arrayContaining(["click", "wait"]));
      expect(report.summary.tools).not.toContain("type");
      expect(report.summary.tools).not.toContain("keypress");
      expect(report.summary.tools).not.toContain("scroll");
      expect(report.summary.tools).not.toContain("double_click");
      expect(report.summary.tools).not.toContain("right_click");
      expect(report.summary.tools).not.toContain("drag");
      expect(report.summary.tools).not.toContain("hotkey");
      await handle.close();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("enables manual handoff confirmation as part of the explicit window-switch opt-in", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-app-runtime-window-switch-handoff-config-"));
    const calls = { open: 0, observe: 0, close: 0 };
    const baseComputer = fakeComputer(calls);
    const computer: Computer = {
      ...baseComputer,
      async listWindows() { return []; },
    };
    try {
      const handle = await createRun({
        ...config(outputDir),
        computer: { kind: "cua", socketPath: "fixture.sock", screenshotDir: "screenshots", windowTarget: { pid: 1234, windowId: 5678 } },
        windowSwitch: "opened-windows-v1",
      }, {
        createProvider: () => ({ id: "fixture-provider", async generate() { return { type: "finish", summary: "unused" }; } }),
        createComputer: async () => computer,
      });
      expect(handle.config).toMatchObject({ windowSwitch: "opened-windows-v1", windowHandoff: "confirm-v1" });
      await handle.close();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("hides and rejects an unverified custom Computer tool on a grounded CUA window Run", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-app-runtime-window-custom-tool-"));
    const calls = { open: 0, observe: 0, close: 0 };
    const inputs: ModelInput[] = [];
    const registry = createDefaultToolRegistry();
    const click = registry.get("click");
    if (click === undefined || click.category !== "computer") throw new Error("default registry is missing click");
    const customToAction = vi.fn(click.toAction);
    registry.register({ ...click, name: "unverified_click", toAction: customToAction });
    let request = 0;
    const provider: ProviderAdapter = {
      id: "fixture-provider",
      async generate(input) {
        inputs.push(input);
        request += 1;
        if (request === 1) {
          return {
            type: "tool_calls",
            calls: [{ id: "unverified-window-click" as ToolCallId, name: "unverified_click", arguments: { x: 10, y: 10 } }],
          };
        }
        return { type: "finish", summary: "The unverified action was rejected." };
      },
    };
    try {
      const handle = await createRun({
        ...config(outputDir),
        computer: {
          kind: "cua",
          socketPath: "fixture.sock",
          screenshotDir: "screenshots",
          windowTarget: { pid: 1234, windowId: 5678 },
        },
        grounding: "uia-catalog-v1",
      }, {
        createProvider: () => provider,
        createComputer: () => Promise.resolve(fakeComputer(calls)),
        createToolRegistry: () => registry,
      });

      await expect(handle.start()).resolves.toBe("succeeded");
      const projectedNames = inputs[0]?.tools.map((tool) => tool.name) ?? [];
      expect(projectedNames).toContain("click_element");
      expect(projectedNames).not.toContain("unverified_click");
      const report = await handle.report();
      const rejection = report.events.find((event) => event.type === "tool.call.rejected" && event.callId === "unverified-window-click");
      expect(rejection).toMatchObject({ reason: "tool unverified_click is disabled for this run" });
      expect(customToAction).not.toHaveBeenCalled();
      await handle.close();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("registers click_element only for an explicit CUA window grounding Run", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-app-runtime-grounding-"));
    const groundingConfig: ResolvedRunConfig = {
      ...config(outputDir),
      computer: { kind: "cua", socketPath: "fixture.sock", screenshotDir: "screenshots", windowTarget: { pid: 1234, windowId: 5678 } },
      grounding: "uia-catalog-v1",
    };
    try {
      const handle = await createRun(groundingConfig, {
        createProvider: () => ({ id: "fixture-provider", async generate() { return { type: "finish", summary: "grounding done" }; } }),
        createComputer: () => Promise.resolve(fakeComputer({ open: 0, observe: 0, close: 0 })),
      });
      await expect(handle.start()).resolves.toBe("succeeded");
      const report = await handle.report();
      expect(report.summary.grounding).toBe("uia-catalog-v1");
      expect(report.summary.tools).toContain("click_element");
      expect(report.summary.tools).not.toContain("select_option");
      await handle.close();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("rejects grounding configuration before Run resources are created", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-app-runtime-grounding-gate-"));
    const createProvider = vi.fn(() => ({ id: "fixture-provider", async generate() { return { type: "finish" as const, summary: "unused" }; } }));
    try {
      await expect(createRun({ ...config(outputDir), grounding: "uia-catalog-v1" }, { createProvider }))
        .rejects.toThrow(/explicit CUA window target/iu);
      expect(createProvider).not.toHaveBeenCalled();
      expect(await readdir(outputDir)).toEqual([]);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("registers the shared click_element tool for managed DOM grounding without exposing the URL", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-app-runtime-dom-grounding-"));
    const calls = { open: 0, observe: 0, close: 0 };
    const managedConfig: ResolvedRunConfig = {
      ...config(outputDir),
      computer: {
        kind: "cua",
        socketPath: "fixture.sock",
        screenshotDir: "screenshots",
        managedBrowserUrl: "https://example.test/path?secret=not-for-model",
        managedBrowserProfileMode: "persistent",
        managedBrowserProfileLabel: "fixture",
        managedBrowserProfileRoot: "C:\\HarnessOwned\\profiles",
      },
      grounding: "dom-catalog-v1",
    };
    try {
      const handle = await createRun(managedConfig, {
        createProvider: () => ({ id: "fixture-provider", async generate() { return { type: "finish", summary: "managed grounding done" }; } }),
        createComputer: (options) => {
          expect(options.config).toMatchObject({ grounding: "dom-catalog-v1", windowDeliveryMode: "foreground", managedBrowserUrl: managedConfig.computer.kind === "cua" ? managedConfig.computer.managedBrowserUrl : undefined, managedBrowserProfileRoot: "C:\\HarnessOwned\\profiles" });
          return Promise.resolve(fakeComputer(calls));
        },
      });
      await expect(handle.start()).resolves.toBe("succeeded");
      const report = await handle.report();
      expect(report.summary.grounding).toBe("dom-catalog-v1");
      expect(report.summary.computerTarget).toEqual({ mode: "managed-browser", deliveryMode: "foreground" });
      expect(report.summary.tools).toContain("click_element");
      expect(report.summary.tools).toContain("select_option");
      expect(report.summary.tools).toEqual(expect.arrayContaining(["type", "keypress", "hotkey", "scroll", "drag"]));
      expect(JSON.stringify(report.summary)).not.toContain("secret=not-for-model");
      expect(JSON.stringify(report.summary)).not.toContain("HarnessOwned");
      await handle.close();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("resolves the Host-selected browser companion for desktop startup without exposing private fields", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-app-runtime-browser-companion-"));
    let providerConfig: ResolvedRunConfig | undefined;
    let computerConfig: ResolvedRunConfig["computer"] | undefined;
    const calls = { open: 0, observe: 0, close: 0 };
    try {
      const handle = await createRun({
        ...config(outputDir),
        computer: {
          kind: "cua",
          socketPath: "fixture.sock",
          screenshotDir: "screenshots",
          managedBrowserCompanion: true,
          managedBrowserProfileMode: "persistent",
          managedBrowserProfileLabel: "default",
          managedBrowserProfileRoot: "C:\\HarnessOwned\\profiles",
        },
        windowSwitch: "opened-windows-v1",
      }, {
        createProvider: (options) => {
          providerConfig = options.config;
          return { id: "fixture-provider", async generate() { return { type: "finish", summary: "companion configured" }; } };
        },
        createComputer: (options) => {
          computerConfig = options.config;
          const computer = fakeComputer(calls);
          return Promise.resolve({ ...computer, async listWindows() { return []; } });
        },
      });

      expect(handle.config.grounding).toBe("hybrid-catalog-v1");
      expect(handle.config.computer).toMatchObject({ managedBrowserCompanion: true, managedBrowserUrl: "about:blank" });
      expect(computerConfig).toMatchObject({ managedBrowserCompanion: true, managedBrowserUrl: "about:blank", managedBrowserProfileRoot: "C:\\HarnessOwned\\profiles" });
      expect(providerConfig?.computer).not.toHaveProperty("managedBrowserCompanion");
      expect(providerConfig?.computer).not.toHaveProperty("managedBrowserProfileRoot");
      expect(providerConfig?.computer).not.toHaveProperty("managedBrowserProfileLabel");
      expect(JSON.stringify(providerConfig)).not.toContain("HarnessOwned");
      await expect(handle.start()).resolves.toBe("succeeded");
      const report = await handle.report();
      expect(report.summary.computerTarget).toMatchObject({ mode: "desktop" });
      expect(JSON.stringify(report.summary)).not.toContain("managedBrowserCompanion");
      expect(JSON.stringify(report.summary)).not.toContain("HarnessOwned");
      await handle.close();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("rejects a Host companion projection when cross-window opt-in is off before creating resources", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-app-runtime-browser-companion-off-"));
    const createProvider = vi.fn(() => ({ id: "fixture-provider", async generate() { return { type: "finish" as const, summary: "unused" }; } }));
    try {
      await expect(createRun({
        ...config(outputDir),
        computer: { kind: "cua", socketPath: "fixture.sock", screenshotDir: "screenshots", managedBrowserCompanion: true },
      }, { createProvider })).rejects.toThrow(/requires the opened-windows-v1 Run opt-in/iu);
      expect(createProvider).not.toHaveBeenCalled();
      expect(await readdir(outputDir)).toEqual([]);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("rejects managed DOM/Hybrid grounding without CUA, URL, or socket before Run assembly", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-app-runtime-dom-grounding-gate-"));
    try {
      await expect(createRun({ ...config(outputDir), grounding: "dom-catalog-v1" })).rejects.toThrow(/requires the CUA computer/iu);
      await expect(createRun({
        ...config(outputDir),
        grounding: "hybrid-catalog-v1",
        computer: { kind: "cua", socketPath: "fixture.sock", screenshotDir: "screenshots" },
      })).rejects.toThrow(/managedBrowserUrl/iu);
      await expect(createRun({
        ...config(outputDir),
        grounding: "dom-catalog-v1",
        computer: { kind: "cua", socketPath: "", screenshotDir: "screenshots", managedBrowserUrl: "https://example.test" },
      })).rejects.toThrow(/non-empty CUA socket/iu);
      await expect(createRun({
        ...config(outputDir),
        grounding: "dom-catalog-v1",
        computer: { kind: "cua", socketPath: "fixture.sock", screenshotDir: "screenshots", managedBrowserUrl: "https://example.test", managedBrowserProfileMode: "persistent" },
      })).rejects.toThrow(/profile label/iu);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("does not construct a risk provider or emit Guard work when Guard is off", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-app-runtime-guard-off-"));
    const calls = { provider: 0, open: 0, observe: 0, close: 0 };
    const fixtureProvider: ProviderAdapter = {
      id: "fixture-provider",
      async generate() { return { type: "finish", summary: "guard-off" }; },
    };
    try {
      const handle = await createRun({
        ...config(outputDir),
        riskModel: "glm-5.3-flash",
        riskGuard: "off",
      }, {
        createProvider: () => {
          calls.provider += 1;
          return fixtureProvider;
        },
        createComputer: () => Promise.resolve(fakeComputer(calls)),
      });
      await expect(handle.start()).resolves.toBe("succeeded");
      const report = await handle.report();
      expect(calls.provider).toBe(1);
      expect(report.events.some((event) => event.type === "action.guard.evaluated")).toBe(false);
      expect(report.events.some((event) => event.type === "approval.requested")).toBe(false);
      expect(report.summary.riskGuard).toBe("off");
      await handle.close();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("exposes window scroll only with explicit foreground delivery", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-app-runtime-window-foreground-tools-"));
    const windowConfig: ResolvedRunConfig = {
      ...config(outputDir),
      computer: {
        kind: "cua",
        socketPath: "fixture.sock",
        screenshotDir: "screenshots",
        windowTarget: { pid: 1234, windowId: 5678 },
        windowDeliveryMode: "foreground",
      },
    };
    try {
      const handle = await createRun(windowConfig, {
        createProvider: () => ({ id: "fixture-provider", async generate() { return { type: "finish", summary: "window done" }; } }),
        createComputer: () => Promise.resolve(fakeComputer({ open: 0, observe: 0, close: 0 })),
      });
      await expect(handle.start()).resolves.toBe("succeeded");
      const report = await handle.report();
      expect(report.summary.computerTarget).toMatchObject({ mode: "window", deliveryMode: "foreground" });
      expect(report.summary.tools).toEqual(expect.arrayContaining(["click", "type", "keypress", "hotkey", "drag", "scroll", "wait"]));
      await handle.close();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("materializes session-scoped Memory lifecycle updates through the app factory", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-app-runtime-memory-lifecycle-"));
    const store = new InMemoryMemoryStore();
    const retrieval = new HybridMemoryRecallService();
    const syncState = vi.spyOn(retrieval, "syncState");
    const provider: ProviderAdapter = {
      id: "fixture-memory-provider",
      calls: 0,
      async generate() {
        this.calls += 1;
        return this.calls === 1
          ? { type: "tool_calls", calls: [{ id: "session-fact-call" as ToolCallId, name: "memory_write_fact", arguments: { key: "window_state", value: "synthetic-last-known", scope: "computer_session", retentionClass: "short_lived" } }] }
          : { type: "finish", summary: "memory lifecycle checked", reportedStatus: "success" };
      },
    } as ProviderAdapter & { calls: number };
    try {
      const handle = await createRun({
        ...config(outputDir),
        runId: "app-runtime-memory-lifecycle" as RunId,
        goal: "write one synthetic session fact and finish",
        memory: "facts",
      }, {
        createProvider: () => provider,
        createMemoryStore: () => store,
        createMemoryRecallService: () => retrieval,
        createComputer: () => Promise.resolve(fakeComputer({ open: 0, observe: 0, close: 0 })),
      });
      await expect(handle.start()).resolves.toBe("succeeded");
      const state = await store.get("app-runtime-memory-lifecycle" as RunId);
      expect(state.facts).toMatchObject([{ status: "needs_check", statusReason: "scope_ended", scope: { kind: "computer_session", sessionId: "fixture-session" } }]);
      const report = await handle.report();
      expect(report.events.some((event) => event.type === "memory.updated" && event.source === "lifecycle" && event.callId === undefined)).toBe(true);
      expect(report.summary.memoryRetrieval).toBe("lexical");
      expect(report.summary.monitor).toBe("off");
      expect(syncState.mock.calls.some(([next]) => next.facts.some((fact) => fact.statusReason === "scope_ended"))).toBe(true);
      await handle.close();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("fails the app Run when lifecycle Memory materialization is rejected", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-app-runtime-memory-lifecycle-failure-"));
    const backingStore = new InMemoryMemoryStore();
    const failingStore: MemoryStore = {
      get: (runId) => backingStore.get(runId),
      apply: async (runId, mutation) => {
        if (mutation.operation === "mark_fact_needs_check") throw new Error("injected app lifecycle store failure");
        return backingStore.apply(runId, mutation);
      },
      rebuild: (runId, mutations) => backingStore.rebuild(runId, mutations),
    };
    const provider: ProviderAdapter & { calls: number } = {
      id: "fixture-memory-provider-failure",
      calls: 0,
      async generate() {
        this.calls += 1;
        return this.calls === 1
          ? { type: "tool_calls", calls: [{ id: "session-fact-failure" as ToolCallId, name: "memory_write_fact", arguments: { key: "window_state", value: "synthetic-last-known", scope: "computer_session", retentionClass: "short_lived" } }] }
          : { type: "finish", summary: "memory lifecycle checked", reportedStatus: "success" };
      },
    };
    try {
      const handle = await createRun({
        ...config(outputDir),
        runId: "app-runtime-memory-lifecycle-failure" as RunId,
        goal: "write one synthetic session fact and finish",
        memory: "facts",
      }, {
        createProvider: () => provider,
        createMemoryStore: () => failingStore,
        createComputer: () => Promise.resolve(fakeComputer({ open: 0, observe: 0, close: 0 })),
      });
      await expect(handle.start()).resolves.toBe("failed");
      const report = await handle.report();
      expect(report.events).toContainEqual(expect.objectContaining({ type: "runtime.error", category: "memory_materialization_failed" }));
      expect(report.summary.runtimeOutcome).toBe("failed");
      expect((await backingStore.get("app-runtime-memory-lifecycle-failure" as RunId)).facts).toMatchObject([{ status: "active" }]);
      await handle.close();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("closes a custom Memory module once when its committed tool mutation fails", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-app-module-run-failure-"));
    const backingStore = new InMemoryMemoryStore();
    const failingStore: MemoryStore = {
      get: (runId) => backingStore.get(runId),
      apply: async () => { throw new Error("injected module materialization failure"); },
      rebuild: (runId, mutations) => backingStore.rebuild(runId, mutations),
    };
    const moduleClose = vi.fn(async () => undefined);
    const provider: ProviderAdapter = {
      id: "module-run-failure-provider",
      async generate() {
        return { type: "tool_calls", calls: [{ id: "module-write-failure" as ToolCallId, name: "memory_write_fact", arguments: { key: "failure_marker", value: "should fail to materialize" } }] };
      },
    };
    try {
      const handle = await createRun({ ...config(outputDir), memory: "facts" }, {
        createProvider: () => provider,
        createMemoryModule: ({ runId, mode }) => createMemoryRunModule(runId, failingStore, { mode, close: moduleClose }),
        createComputer: () => Promise.resolve(fakeComputer({ open: 0, observe: 0, close: 0 })),
      });
      await expect(handle.start()).resolves.toBe("failed");
      expect((await handle.report()).events).toContainEqual(expect.objectContaining({ type: "runtime.error", category: "memory_materialization_failed" }));
      expect(moduleClose).toHaveBeenCalledOnce();
      await handle.close();
      expect(moduleClose).toHaveBeenCalledOnce();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("bounds a hanging module close and records its cleanup diagnostic once", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-app-module-close-timeout-"));
    const moduleClose = vi.fn(() => new Promise<void>(() => undefined));
    try {
      const handle = await createRun({ ...config(outputDir), memory: "facts", cleanupDeadlineMs: 50 }, {
        createProvider: () => ({ id: "module-close-timeout-provider", async generate() { return { type: "finish", summary: "finished before module timeout" }; } }),
        createMemoryModule: ({ runId, mode }) => createMemoryRunModule(runId, new InMemoryMemoryStore(), { mode, close: moduleClose }),
        createComputer: () => Promise.resolve(fakeComputer({ open: 0, observe: 0, close: 0 })),
      });
      await expect(handle.start()).resolves.toBe("succeeded");
      const report = await handle.report();
      expect(moduleClose).toHaveBeenCalledOnce();
      expect(report.summary.cleanupDiagnostics).toContainEqual(expect.objectContaining({ operation: "memory_module.close", status: "timed_out" }));
      await handle.close();
      expect(moduleClose).toHaveBeenCalledOnce();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("closes the writer and already-created Provider when later Computer construction fails", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-app-runtime-failure-"));
    const close = vi.fn(async () => undefined);
    const providerClose = vi.fn(async () => undefined);
    const planningModuleClose = vi.fn(async () => undefined);
    const memoryModuleClose = vi.fn(async () => undefined);
    const computerError = new Error("computer fixture failed");
    const provider: ProviderAdapter & { close: () => Promise<void> } = {
      id: "fixture-provider",
      async generate() { return { type: "finish", summary: "unused" }; },
      close: providerClose,
    };
    const computerFactory = vi.fn(async () => { throw computerError; });
    try {
      await expect(createRun({ ...config(outputDir), planning: true, memory: "facts" }, {
        createEventWriter: () => ({
          append: async () => { throw new Error("append must not run"); },
          flush: async () => undefined,
          close,
        }),
        createProvider: () => provider,
        createComputer: computerFactory,
        createPlanningModule: ({ runId }) => createPlanningRunModule(runId, new InMemoryPlanStore(), { close: planningModuleClose }),
        createMemoryModule: ({ runId, mode }) => createMemoryRunModule(runId, new InMemoryMemoryStore(), { mode, close: memoryModuleClose }),
      })).rejects.toBe(computerError);
      expect(close).toHaveBeenCalledOnce();
      expect(computerFactory).toHaveBeenCalledOnce();
      expect(providerClose).toHaveBeenCalledOnce();
      expect(planningModuleClose).toHaveBeenCalledOnce();
      expect(memoryModuleClose).toHaveBeenCalledOnce();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("closes the writer and does not construct a Computer when Provider creation fails", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-app-runtime-provider-failure-"));
    const close = vi.fn(async () => undefined);
    const providerError = new Error("provider fixture failed");
    const computerFactory = vi.fn(async () => fakeComputer({ open: 0, observe: 0, close: 0 }));
    try {
      await expect(createRun(config(outputDir), {
        createEventWriter: () => ({
          append: async () => { throw new Error("append must not run"); },
          flush: async () => undefined,
          close,
        }),
        createProvider: () => { throw providerError; },
        createComputer: computerFactory,
      })).rejects.toBe(providerError);
      expect(close).toHaveBeenCalledOnce();
      expect(computerFactory).not.toHaveBeenCalled();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("disposes a not-yet-started handle without touching an unstarted Computer", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-app-runtime-dispose-"));
    const calls = { open: 0, observe: 0, close: 0 };
    const planningModuleClose = vi.fn(async () => undefined);
    const memoryModuleClose = vi.fn(async () => undefined);
    try {
      const handle = await createRun({ ...config(outputDir), planning: true, memory: "facts" }, {
        createProvider: () => ({
          id: "fixture-provider",
          async generate() { return { type: "finish", summary: "unused" }; },
        }),
        createComputer: () => Promise.resolve(fakeComputer(calls)),
        createPlanningModule: ({ runId }) => createPlanningRunModule(runId, new InMemoryPlanStore(), { close: planningModuleClose }),
        createMemoryModule: ({ runId, mode }) => createMemoryRunModule(runId, new InMemoryMemoryStore(), { mode, close: memoryModuleClose }),
      });
      await handle.close();
      await handle.close();
      await expect(handle.start()).rejects.toThrow(/already closed/iu);
      expect(calls).toEqual({ open: 0, observe: 0, close: 0 });
      expect(planningModuleClose).toHaveBeenCalledOnce();
      expect(memoryModuleClose).toHaveBeenCalledOnce();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("derives report outcome from the committed trajectory instead of a caller claim", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-app-runtime-unknown-"));
    const calls = { open: 0, observe: 0, close: 0 };
    const provider: ProviderAdapter = {
      id: "fixture-provider",
      async generate() {
        return { type: "tool_calls", calls: [{ id: "click-call" as ToolCallId, name: "click", arguments: { x: 0, y: 0 } }] };
      },
    };
    const computer = fakeComputer(calls);
    computer.execute = async () => {
      throw new Error("fixture transport failed after dispatch");
    };
    try {
      const handle = await createRun(config(outputDir), {
        createProvider: () => provider,
        createComputer: () => Promise.resolve(computer),
      });
      let controllerOutcome: string | undefined;
      const externallyClaimed = await handle.start(async (controller, goal, markControllerStarted) => {
        const started = controller.start(goal);
        markControllerStarted();
        controllerOutcome = await started;
        return "succeeded";
      });
      expect(controllerOutcome).toBe("outcome_unknown");
      expect(externallyClaimed).toBe("succeeded");
      const report = await handle.report();
      expect(report.outcome).toBe("outcome_unknown");
      expect(report.summary).toMatchObject({ runtimeOutcome: "outcome_unknown" });
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("closes the writer once when a starter rejects before Controller ownership", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-app-runtime-starter-failure-"));
    const close = vi.fn(async () => undefined);
    const starterError = new Error("TUI requires an interactive terminal");
    try {
      const handle = await createRun(config(outputDir), {
        createEventWriter: () => ({
          append: async () => { throw new Error("append must not run"); },
          flush: async () => undefined,
          close,
        }),
        createProvider: () => ({
          id: "fixture-provider",
          async generate() { return { type: "finish", summary: "unused" }; },
        }),
        createComputer: () => Promise.resolve(fakeComputer({ open: 0, observe: 0, close: 0 })),
      });
      await expect(handle.start(async () => { throw starterError; })).rejects.toBe(starterError);
      await expect(handle.close()).rejects.toBe(starterError);
      await handle.close().catch(() => undefined);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("publishes committed events incrementally without letting a UI listener affect the Run", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-app-runtime-feed-"));
    const calls = { open: 0, observe: 0, close: 0 };
    try {
      const handle = await createRun(config(outputDir), {
        createProvider: () => ({ id: "fixture-provider", async generate() { return { type: "finish", summary: "feed done" }; } }),
        createComputer: () => Promise.resolve(fakeComputer(calls)),
      });
      const seen: number[] = [];
      handle.eventFeed.subscribe({
        listener: (notification) => {
          if (notification.type === "event") {
            seen.push(notification.event.sequence);
            throw new Error("TUI listener should be isolated");
          }
        },
      });
      await expect(handle.start()).resolves.toBe("succeeded");
      expect(seen.length).toBeGreaterThan(0);
      expect(seen).toEqual([...seen].sort((left, right) => left - right));
      expect(new Set(seen).size).toBe(seen.length);
      await handle.close();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
