import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DefaultContextCompiler } from "@computer-harness/context";
import type { ComputerSessionDescriptor, RunId, RuntimeEvent, SurfaceId, ToolCallId, Viewport } from "@computer-harness/protocol";
import {
  createDefaultToolRegistry,
  type CleanupDiagnostic,
  type Computer,
  type ContextCompiler,
  type ModelInput,
  type ProviderAdapter,
} from "@computer-harness/runtime";
import { createRunFactory, type ResolvedRunConfig } from "./index.js";

const fixtureSurfaceRef = { surfaceId: "sdk-mock-desktop" as SurfaceId, generation: 1, kind: "desktop" as const };

function config(outputDir: string, runId = "sdk-mock-run"): ResolvedRunConfig {
  return {
    runId: runId as RunId,
    goal: "click the fixture target and finish",
    model: { kind: "external", id: "sdk-mock-provider" },
    computer: { kind: "external", id: "sdk-mock-computer" },
    outputDir,
    maxSteps: 3,
    maxModelRequests: 3,
    planning: false,
    memory: "off",
    batching: "off",
    contextMode: "raw",
    contextMaxHistoryEvents: 10,
    riskProfile: "experiment",
    riskGuard: "off",
    riskModel: "off",
    riskMaxModelRequests: 1,
    riskTimeoutMs: 100,
    cleanupDeadlineMs: 100,
  };
}

function mockComputer(
  lifecycle: string[],
  id = "sdk-mock-computer",
  capabilities = { screenshot: true, pointer: true, keyboard: true, accessibility: false },
): Computer {
  const viewport: Viewport = { width: 100, height: 100, coordinateSpace: "physical" };
  const session = {
    id: `${id}-session` as ComputerSessionDescriptor["id"],
    backend: id,
    viewport,
    capabilities,
    openedAt: "2026-09-23T00:00:00.000Z",
  };
  let observationCount = 0;

  return {
    async open() {
      lifecycle.push("computer.open");
      return session;
    },
    async observe() {
      observationCount += 1;
      lifecycle.push(`computer.observe.${observationCount}`);
      return {
        capturedAt: `2026-09-23T00:00:0${observationCount}.000Z`,
        viewport,
        surfaceRef: fixtureSurfaceRef,
        screenshot: { mediaType: "image/png", data: new Uint8Array([observationCount]) },
      };
    },
    async execute(_session, action) {
      lifecycle.push(`computer.execute.${action.kind}`);
      return { actionId: action.actionId, status: "completed" };
    },
    async close() {
      lifecycle.push(`computer.close:${id}`);
    },
    async dispose() {
      lifecycle.push(`computer.dispose:${id}`);
    },
  };
}

function noopEventWriter(close: () => Promise<void> = async () => undefined) {
  return {
    async append(event: RuntimeEvent) { return event; },
    async flush() {},
    close,
  };
}

describe("public app-runtime SDK assembly", () => {
  it("runs Observe → Tool → Receipt → Observe → Finish with injected adapters and context", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-sdk-mock-run-"));
    const lifecycle: string[] = [];
    const inputs: ModelInput[] = [];
    let registryFactoryCalls = 0;
    let contextFactoryCalls = 0;
    let providerFactoryCalls = 0;
    let computerFactoryCalls = 0;

    const provider: ProviderAdapter = {
      id: "sdk-mock-provider",
      async generate(input) {
        lifecycle.push("provider.generate");
        inputs.push(input);
        if (inputs.length === 1) {
          return {
            type: "tool_calls",
            calls: [{ id: "sdk-click" as ToolCallId, name: "click", arguments: { x: 20, y: 30 } }],
          };
        }
        return { type: "finish", summary: "Fixture target clicked and verified.", reportedStatus: "success" };
      },
      async close() {
        lifecycle.push("provider.close");
      },
    };

    const createRun = createRunFactory({
      createProvider: (options) => {
        providerFactoryCalls += 1;
        expect(options.model).toEqual({ kind: "external", id: "sdk-mock-provider" });
        return provider;
      },
      createComputer: (options) => {
        computerFactoryCalls += 1;
        expect(options.config).toEqual({ kind: "external", id: "sdk-mock-computer" });
        return Promise.resolve(mockComputer(lifecycle));
      },
      createToolRegistry: () => {
        registryFactoryCalls += 1;
        const registry = createDefaultToolRegistry();
        registry.register({
          name: "fixture_marker",
          description: "An application-owned tool visible to the Provider.",
          category: "side",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          validate: () => undefined,
          async execute() { return { marker: "custom registry" }; },
        });
        return registry;
      },
      createContextCompiler: (tools): ContextCompiler => {
        contextFactoryCalls += 1;
        const base = new DefaultContextCompiler(tools, { mode: "raw", maxHistoryEvents: 10 });
        return {
          async compile(input, signal) {
            const compiled = await base.compile(input, signal);
            return { ...compiled, system: `${compiled.system}\nApplication context extension: fixture build.` };
          },
        };
      },
    });

    try {
      const run = await createRun(config(outputDir));
      expect(await run.start()).toBe("succeeded");

      const report = await run.report();
      const eventTypes = report.events.map((event) => event.type);
      const firstObservation = eventTypes.indexOf("observation.created");
      const toolCall = eventTypes.indexOf("tool.call.received");
      const receipt = eventTypes.indexOf("action.execution.completed");
      const secondObservation = eventTypes.indexOf("observation.created", firstObservation + 1);
      const finish = eventTypes.indexOf("run.finished");

      expect(firstObservation).toBeGreaterThanOrEqual(0);
      expect(firstObservation).toBeLessThan(toolCall);
      expect(toolCall).toBeLessThan(receipt);
      expect(receipt).toBeLessThan(secondObservation);
      expect(secondObservation).toBeLessThan(finish);
      expect(report.events.find((event) => event.type === "action.execution.completed")).toMatchObject({ receipt: { status: "completed" } });
      expect(report.summary).toMatchObject({
        model: { kind: "external", id: "sdk-mock-provider" },
        computer: { kind: "external", id: "sdk-mock-computer" },
        computerTarget: { mode: "external", id: "sdk-mock-computer" },
      });
      expect(inputs).toHaveLength(2);
      expect(inputs[0]?.system).toContain("Application context extension: fixture build.");
      expect(inputs[0]?.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["click", "terminate", "fixture_marker"]));
      expect(inputs[1]?.messages.flatMap((message) => message.content).some((block) =>
        block.type === "tool_result" && block.result.status === "completed",
      )).toBe(true);
      expect(lifecycle).toEqual([
        "computer.open",
        "computer.observe.1",
        "provider.generate",
        "computer.execute.click",
        "computer.observe.2",
        "provider.generate",
        "computer.close:sdk-mock-computer",
        "computer.dispose:sdk-mock-computer",
        "provider.close",
      ]);
      expect({ providerFactoryCalls, computerFactoryCalls, registryFactoryCalls, contextFactoryCalls }).toEqual({
        providerFactoryCalls: 1,
        computerFactoryCalls: 1,
        registryFactoryCalls: 1,
        contextFactoryCalls: 1,
      });
      await run.close();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("projects an external Computer's actual capabilities without CUA window filtering", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-sdk-capabilities-"));
    const inputs: ModelInput[] = [];
    const lifecycle: string[] = [];
    let turn = 0;
    const provider: ProviderAdapter = {
      id: "sdk-mock-provider",
      async generate(input) {
        inputs.push(input);
        if (turn++ === 0) {
          return {
            type: "tool_calls",
            calls: [{ id: "disabled-click" as ToolCallId, name: "click", arguments: { x: 10, y: 10 } }],
          };
        }
        return { type: "finish", summary: "Capabilities were enforced.", reportedStatus: "success" };
      },
    };
    try {
      const run = await createRunFactory({
        createProvider: () => provider,
        createComputer: () => Promise.resolve(mockComputer(lifecycle, "sdk-mock-computer", {
          screenshot: true,
          pointer: false,
          keyboard: true,
          accessibility: false,
        })),
      })(config(outputDir));

      await expect(run.start()).resolves.toBe("succeeded");
      const projectedNames = inputs[0]?.tools.map((tool) => tool.name) ?? [];
      expect(projectedNames).toEqual(expect.arrayContaining(["type", "keypress", "wait", "terminate"]));
      for (const name of ["click", "double_click", "right_click", "scroll", "drag"]) {
        expect(projectedNames).not.toContain(name);
      }
      const report = await run.report();
      expect(report.summary.tools).toEqual(expect.arrayContaining(["type", "keypress", "wait", "terminate"]));
      expect(report.events.filter((event) => event.type === "tool.call.rejected")).toHaveLength(1);
      expect(lifecycle).not.toContain("computer.execute.click");
      await run.close();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("keeps external adapter instances and state isolated across Runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sdk-isolation-"));
    const providerInstances: ProviderAdapter[] = [];
    const computerInstances: Computer[] = [];
    const registries: ReturnType<typeof createDefaultToolRegistry>[] = [];
    const compilers: ContextCompiler[] = [];
    const providerRequests: Record<string, number> = {};
    const providerClosures: string[] = [];
    const computerLifecycles = new Map<string, string[]>();
    try {
      const createRun = createRunFactory({
        createProvider: ({ model }) => {
          if (typeof model === "string") throw new Error("expected an external model descriptor");
          const id = model.id;
          const provider: ProviderAdapter = {
            id,
            async generate() {
              providerRequests[id] = (providerRequests[id] ?? 0) + 1;
              return { type: "finish", summary: `finished by ${id}`, reportedStatus: "success" };
            },
            async close() { providerClosures.push(id); },
          };
          providerInstances.push(provider);
          return provider;
        },
        createComputer: ({ config: computerConfig }) => {
          if (computerConfig.kind !== "external") throw new Error("expected an external Computer descriptor");
          const lifecycle: string[] = [];
          computerLifecycles.set(computerConfig.id, lifecycle);
          const computer = mockComputer(lifecycle, computerConfig.id);
          computerInstances.push(computer);
          return Promise.resolve(computer);
        },
        createToolRegistry: () => {
          const registry = createDefaultToolRegistry();
          registries.push(registry);
          return registry;
        },
        createContextCompiler: (tools) => {
          const compiler = new DefaultContextCompiler(tools);
          compilers.push(compiler);
          return compiler;
        },
      });
      const firstConfig = {
        ...config(join(root, "first"), "sdk-run-first"),
        model: { kind: "external" as const, id: "provider-first" },
        computer: { kind: "external" as const, id: "computer-first" },
      };
      const secondConfig = {
        ...config(join(root, "second"), "sdk-run-second"),
        model: { kind: "external" as const, id: "provider-second" },
        computer: { kind: "external" as const, id: "computer-second" },
      };
      const [first, second] = await Promise.all([createRun(firstConfig), createRun(secondConfig)]);
      expect(providerInstances[0]).not.toBe(providerInstances[1]);
      expect(computerInstances[0]).not.toBe(computerInstances[1]);
      expect(registries[0]).not.toBe(registries[1]);
      expect(compilers[0]).not.toBe(compilers[1]);

      await Promise.all([first.start(), second.start()]);
      const [firstReport, secondReport] = await Promise.all([first.report(), second.report()]);
      expect(firstReport.runId).toBe("sdk-run-first");
      expect(secondReport.runId).toBe("sdk-run-second");
      expect(firstReport.summary).toMatchObject({ model: { id: "provider-first" }, computerTarget: { id: "computer-first" } });
      expect(secondReport.summary).toMatchObject({ model: { id: "provider-second" }, computerTarget: { id: "computer-second" } });
      expect(providerRequests).toEqual({ "provider-first": 1, "provider-second": 1 });
      expect(providerClosures.sort()).toEqual(["provider-first", "provider-second"]);
      expect(computerLifecycles.get("computer-first")).toEqual([
        "computer.open",
        "computer.observe.1",
        "computer.close:computer-first",
        "computer.dispose:computer-first",
      ]);
      expect(computerLifecycles.get("computer-second")).toEqual([
        "computer.open",
        "computer.observe.1",
        "computer.close:computer-second",
        "computer.dispose:computer-second",
      ]);
      await Promise.all([first.close(), second.close()]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects missing or mismatched external adapters before falling back to defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sdk-invalid-external-"));
    const outputDir = join(root, "run");
    const createEventWriter = vi.fn(() => noopEventWriter());
    try {
      await expect(createRunFactory({ createEventWriter })(config(outputDir))).rejects.toThrow(/requires RunDependencies\.createProvider/iu);
      expect(createEventWriter).not.toHaveBeenCalled();

      const providerFactory = vi.fn((): ProviderAdapter => ({
        id: "sdk-mock-provider",
        async generate() { return { type: "finish" as const, summary: "unused" }; },
      }));
      await expect(createRunFactory({ createEventWriter, createProvider: providerFactory })(config(outputDir))).rejects.toThrow(/requires RunDependencies\.createComputer/iu);
      expect(providerFactory).not.toHaveBeenCalled();
      expect(createEventWriter).not.toHaveBeenCalled();

      const providerClose = vi.fn(async () => undefined);
      const writerClose = vi.fn(async () => undefined);
      const computerFactory = vi.fn(async () => mockComputer([]));
      const mismatchFactory = createRunFactory({
        createEventWriter: () => noopEventWriter(writerClose),
        createProvider: () => ({ id: "wrong-provider-id", async generate() { return { type: "finish" as const, summary: "unused" }; }, close: providerClose }),
        createComputer: computerFactory,
      });
      await expect(mismatchFactory(config(outputDir))).rejects.toThrow(/does not match configured external Provider/iu);
      expect(providerClose).toHaveBeenCalledOnce();
      expect(writerClose).toHaveBeenCalledOnce();
      expect(computerFactory).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects app-managed grounding on an external Computer before allocating adapters", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sdk-grounding-boundary-"));
    const createProvider = vi.fn((): ProviderAdapter => ({ id: "sdk-mock-provider", async generate() { return { type: "finish" as const, summary: "unused" }; } }));
    const createComputer = vi.fn(async (): Promise<Computer> => mockComputer([]));
    const createEventWriter = vi.fn(() => noopEventWriter());
    try {
      const buildRun = createRunFactory({ createProvider, createComputer, createEventWriter });
      await expect(buildRun({ ...config(join(root, "run")), grounding: "dom-catalog-v1" })).rejects.toThrow(/external Computer.*grounding.*off/iu);
      expect(createProvider).not.toHaveBeenCalled();
      expect(createComputer).not.toHaveBeenCalled();
      expect(createEventWriter).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("releases external resources when a Run is closed before start or assembly fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sdk-resource-ownership-"));
    try {
      const beforeStart: string[] = [];
      const unstarted = await createRunFactory({
        createProvider: () => ({ id: "sdk-mock-provider", async generate() { return { type: "finish", summary: "unused" }; }, async close() { beforeStart.push("provider.close"); } }),
        createComputer: () => Promise.resolve(mockComputer(beforeStart)),
      })(config(join(root, "unstarted"), "sdk-unstarted"));
      await unstarted.close();
      expect(beforeStart).toEqual(["computer.dispose:sdk-mock-computer", "provider.close"]);
      await expect(unstarted.start()).rejects.toThrow(/already closed/iu);

      const assemblyFailure: string[] = [];
      await expect(createRunFactory({
        createProvider: () => ({ id: "sdk-mock-provider", async generate() { return { type: "finish", summary: "unused" }; }, async close() { assemblyFailure.push("provider.close"); } }),
        createComputer: () => Promise.resolve(mockComputer(assemblyFailure)),
        createPolicy: () => { throw new Error("fixture policy construction failed"); },
      })(config(join(root, "failure"), "sdk-assembly-failure"))).rejects.toThrow(/fixture policy construction failed/iu);
      expect(assemblyFailure).toEqual(["computer.dispose:sdk-mock-computer", "provider.close"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bounds event-writer close before Controller ownership and still releases adapters", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sdk-writer-timeout-"));
    try {
      for (const scenario of ["unstarted-close", "starter-failure"] as const) {
        const lifecycle: string[] = [];
        const diagnostics: CleanupDiagnostic[] = [];
        const writerClose = vi.fn(async () => { await new Promise<void>(() => undefined); });
        const run = await createRunFactory({
          createEventWriter: () => noopEventWriter(writerClose),
          createProvider: () => ({
            id: "sdk-mock-provider",
            async generate() { return { type: "finish" as const, summary: "unused" }; },
            async close() { lifecycle.push("provider.close"); },
          }),
          createComputer: () => Promise.resolve(mockComputer(lifecycle)),
          onCleanupError: (diagnostic) => diagnostics.push(diagnostic),
        })({ ...config(join(root, scenario), `sdk-${scenario}`), cleanupDeadlineMs: 20 });

        if (scenario === "unstarted-close") {
          await expect(run.close()).rejects.toBeInstanceOf(AggregateError);
        } else {
          const starterError = new Error("fixture starter failed before Controller ownership");
          await expect(run.start(async () => { throw starterError; })).rejects.toBe(starterError);
        }
        expect(writerClose).toHaveBeenCalledOnce();
        expect(lifecycle).toEqual(["computer.dispose:sdk-mock-computer", "provider.close"]);
        expect(diagnostics).toEqual([{
          operation: "event_writer.close",
          message: expect.stringMatching(/cleanup deadline exceeded during event_writer\.close/iu),
          status: "timed_out",
        }]);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("disposes a Computer after failed open and reports failed Provider cleanup", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-sdk-open-failure-"));
    const lifecycle: string[] = [];
    const cleanupError = new Error("fixture Provider close failed");
    const diagnostics: Array<{ operation: string; message: string }> = [];
    const brokenComputer: Computer = {
      ...mockComputer(lifecycle),
      async open() { throw new Error("fixture Computer open failed"); },
    };
    try {
      const run = await createRunFactory({
        createProvider: () => ({
          id: "sdk-mock-provider",
          async generate() { return { type: "finish" as const, summary: "unused" }; },
          async close() {
            lifecycle.push("provider.close");
            throw cleanupError;
          },
        }),
        createComputer: () => Promise.resolve(brokenComputer),
        onCleanupError: (diagnostic) => diagnostics.push({ operation: diagnostic.operation, message: diagnostic.message }),
      })(config(outputDir, "sdk-open-failure"));

      await expect(run.start()).resolves.toBe("failed");
      expect(lifecycle).toEqual(["computer.dispose:sdk-mock-computer", "provider.close"]);
      expect(diagnostics).toEqual([{ operation: "provider.close", message: cleanupError.message }]);
      expect((await run.report()).summary.cleanupDiagnostics).toEqual(diagnostics);
      await run.close();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
