import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionReceipt, ComputerSessionDescriptor, RunId, SurfaceId, SurfaceRef, Viewport } from "@computer-harness/protocol";
import type { Computer, PreparedProviderRequest, ProviderAdapter } from "@computer-harness/runtime";
import { createProvider as createProductionProvider } from "../../../packages/app-runtime/src/providers.js";
import { createRun as createProductionRun } from "../../../packages/app-runtime/src/run-factory.js";
import type { ProviderHttpClient, ResolvedRunConfig } from "../../../packages/app-runtime/src/config.js";
import { parseGlmInputBudgets, parseGlmOutputBudget, parseGlmRequestTimeoutMs, readGlmThinking } from "./glm-output-budget.js";

describe("Host GLM output budget", () => {
  it("uses bounded independent text and wire input defaults and rejects inconsistent values", () => {
    expect(parseGlmInputBudgets()).toEqual({ contextMaxInputTokens: 16_384, contextMaxWireInputTokens: 24_576 });
    expect(parseGlmInputBudgets("24576", "32768")).toEqual({ contextMaxInputTokens: 24_576, contextMaxWireInputTokens: 32_768 });
    for (const [text, wire] of [["0", "24576"], ["1.5", "24576"], ["16384", "131073"], ["16384", "16000"], ["NaN", "24576"], ["", "24576"]]) {
      expect(() => parseGlmInputBudgets(text, wire)).toThrow("GLM input budgets");
    }
  });
  it("prepares the first all-on Host Run request under the GLM wire budget offline", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-host-glm-budget-"));
    const inputBudgets = parseGlmInputBudgets();
    const viewport: Viewport = { width: 1, height: 1, coordinateSpace: "physical" };
    const surfaceRef: SurfaceRef = { surfaceId: "host-budget-fixture" as SurfaceId, generation: 1, kind: "desktop" };
    const png = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp6kAAAAASUVORK5CYII=", "base64"));
    const session: ComputerSessionDescriptor = {
      id: "host-budget-session" as ComputerSessionDescriptor["id"],
      backend: "fixture-cua",
      viewport,
      capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false },
      openedAt: "2026-10-06T00:00:00.000Z",
    };
    const computer: Computer = {
      async open() { return session; },
      async observe(_session, _observationId) {
        return { capturedAt: "2026-10-06T00:00:01.000Z", viewport, surfaceRef, screenshot: { mediaType: "image/png", data: png } };
      },
      async execute(_session, action) {
        return { actionId: action.actionId, status: "completed" } satisfies ActionReceipt;
      },
      async close() {},
    };
    const bodies: Record<string, unknown>[] = [];
    const terminateFixtureResponse = {
      choices: [{
        finish_reason: "tool_calls",
        message: {
          tool_calls: [{
            id: "host-budget-fixture-terminate",
            type: "function",
            function: {
              name: "terminate",
              arguments: JSON.stringify({
                status: "success",
                text: "The first all-on Host Run request was prepared within the configured GLM wire budget.",
              }),
            },
          }],
        },
      }],
    };
    const httpClient: ProviderHttpClient = {
      async post(_url, body) {
        bodies.push(structuredClone(body));
        return terminateFixtureResponse;
      },
    };
    const config: ResolvedRunConfig = {
      runId: "host-glm-budget-fixture" as RunId,
      goal: "Read the synthetic blue panel and summarize its visible label.",
      model: "glm-5.3-flash",
      computer: {
        kind: "cua",
        socketPath: "offline-cua-fixture",
        screenshotDir: join(outputDir, "driver-screenshots"),
        grounding: "off",
        managedBrowserProfileMode: "persistent",
        managedBrowserProfileLabel: "budget-test",
        managedBrowserProfileRoot: join(outputDir, "managed-profile"),
      },
      outputDir,
      maxSteps: 160,
      maxModelRequests: 1,
      planning: true,
      memory: "facts",
      memoryRetrieval: "lexical",
      batching: "same-control-input-v1",
      contextMode: "recent",
      contextMaxHistoryEvents: 32,
      ...inputBudgets,
      riskProfile: "live-interactive",
      riskGuard: "layered",
      riskModel: "same",
      riskMaxModelRequests: 1,
      riskTimeoutMs: 15_000,
      cleanupDeadlineMs: 5_000,
      monitor: "shadow",
      windowHandoff: "confirm-v1",
      glmThinking: "enabled",
      glmMaxOutputTokens: parseGlmOutputBudget(),
      glmRequestTimeoutMs: 90_000,
    };
    let handle: Awaited<ReturnType<typeof createProductionRun>> | undefined;
    let prepared: PreparedProviderRequest | undefined;
    try {
      handle = await createProductionRun(config, {
        credentials: { glmApiKey: "offline-fixture-key" },
        createComputer: async () => computer,
        createProvider(options) {
          const adapter = createProductionProvider({ ...options, httpClients: { glm: httpClient } });
          if (adapter.prepare === undefined || adapter.generatePrepared === undefined) throw new Error("The production GLM adapter must expose prepare/generatePrepared.");
          return {
            id: adapter.id,
            generate: (input, generateOptions) => adapter.generate(input, generateOptions),
            async prepare(input, prepareOptions) {
              const request = await adapter.prepare!(input, prepareOptions);
              prepared = request;
              return request;
            },
            generatePrepared: (request, generateOptions) => adapter.generatePrepared!(request, generateOptions),
            ...(adapter.close === undefined ? {} : { close: () => adapter.close!() }),
          } satisfies ProviderAdapter;
        },
      });
      expect(handle.config.contextMaxWireInputTokens).toBe(inputBudgets.contextMaxWireInputTokens);
      const outcome = await handle.start();
      const report = await handle.report();
      const diagnosticEvents = report.events
        .filter((event) => event.type === "runtime.error" || event.type === "model.request.failed" || event.type === "run.finished")
        .map((event) => event.type === "runtime.error"
          ? { type: event.type, category: event.category, message: event.message }
          : event.type === "model.request.failed"
            ? { type: event.type, category: event.category, code: event.code, message: event.message }
            : { type: event.type, outcome: event.outcome, summary: event.summary });
      expect(outcome, JSON.stringify(diagnosticEvents)).toBe("succeeded");
      const requestEvent = report.events.find((event) => event.type === "model.request.started");
      expect(requestEvent?.type).toBe("model.request.started");
      expect(bodies).toHaveLength(1);
      expect(prepared?.estimate).toMatchObject({ imageCount: 1, estimationMethod: "provider_projection" });
      expect(requestEvent?.type === "model.request.started" ? requestEvent.contextBudget : undefined).toMatchObject({
        maxInputTokens: 16_384,
        maxWireInputTokens: 24_576,
      });
      const estimatedTextTokens = prepared?.estimate?.estimatedTextTokens;
      const imageTokens = Math.min(480, Math.ceil((viewport.width * viewport.height) / 750) + 128);
      const estimatedWireTokens = (estimatedTextTokens ?? 0) + imageTokens + 32;
      expect(estimatedTextTokens).toBeGreaterThan(0);
      expect(estimatedWireTokens).toBeLessThanOrEqual(inputBudgets.contextMaxWireInputTokens);
      const bodyTools = bodies[0]?.tools as Array<{ function: { name: string; parameters: { properties?: Record<string, unknown> } } }> | undefined;
      const toolNames = bodyTools?.map((tool) => tool.function.name) ?? [];
      expect(toolNames).toEqual(expect.arrayContaining(["click", "type", "task_create", "memory_write_fact"]));
      expect(toolNames.length).toBeGreaterThan(10);
      const clickTool = bodyTools?.find((tool) => tool.function.name === "click");
      expect(clickTool?.function.parameters.properties).toHaveProperty("_harnessEffect");
      expect(prepared?.estimate?.imageCount).toBe(1);

      const oldOutputDir = await mkdtemp(join(tmpdir(), "harness-host-glm-budget-old-"));
      const oldConfig = structuredClone(config);
      oldConfig.outputDir = oldOutputDir;
      oldConfig.contextMaxInputTokens = 8_000;
      delete oldConfig.contextMaxWireInputTokens;
      if (oldConfig.computer.kind === "cua") {
        oldConfig.computer.screenshotDir = join(oldOutputDir, "driver-screenshots");
        oldConfig.computer.managedBrowserProfileRoot = join(oldOutputDir, "managed-profile");
      }
      const oldBodies: Record<string, unknown>[] = [];
      const oldHttpClient: ProviderHttpClient = {
        async post(_url, body) {
          oldBodies.push(structuredClone(body));
          return terminateFixtureResponse;
        },
      };
      let oldHandle: Awaited<ReturnType<typeof createProductionRun>> | undefined;
      let oldPreflightBudgetFailure = false;
      try {
        oldHandle = await createProductionRun(oldConfig, {
          credentials: { glmApiKey: "offline-fixture-key" },
          createComputer: async () => computer,
          createProvider(options) {
            return createProductionProvider({ ...options, httpClients: { glm: oldHttpClient } });
          },
        });
        await expect(oldHandle.start()).resolves.toBe("failed");
        const oldReport = await oldHandle.report();
        const preflightFailure = oldReport.events.find((event) => event.type === "runtime.error");
        const failureMessage = preflightFailure?.type === "runtime.error" ? preflightFailure.message : "";
        oldPreflightBudgetFailure = failureMessage.includes("GLM prompt exceeds wire input budget");
        expect(failureMessage).toContain(`estimated=${estimatedWireTokens}`);
        expect(failureMessage).toContain("maxInputTokens=8000");
        expect(oldReport.events.some((event) => event.type === "model.request.started")).toBe(false);
        expect(oldBodies).toHaveLength(0);
        expect(oldPreflightBudgetFailure).toBe(true);
      } finally {
        await oldHandle?.close();
        await rm(oldOutputDir, { recursive: true, force: true });
      }
      console.info("[glm-budget-offline-fixture]", JSON.stringify({
        estimatedTextTokens,
        estimatedWireTokens,
        maxInputTokens: inputBudgets.contextMaxInputTokens,
        maxWireInputTokens: inputBudgets.contextMaxWireInputTokens,
        toolCount: toolNames.length,
        imageCount: prepared?.estimate?.imageCount,
        responseContract: "fake GLM terminate control with explicit success status and actionable result text",
        legacy8000NoWire: { preflightBudgetFailure: oldPreflightBudgetFailure, httpRequests: oldBodies.length },
      }));
    } finally {
      await handle?.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });
  it("keeps the effective request timeout at 90 seconds by default and validates bounded overrides", () => {
    expect(parseGlmRequestTimeoutMs(undefined)).toBe(90_000);
    expect(parseGlmRequestTimeoutMs("120000")).toBe(120_000);
    expect(parseGlmRequestTimeoutMs("240000")).toBe(240_000);
    for (const raw of ["", "0", "999", "1000.5", "NaN", "240001", "Infinity"]) {
      expect(() => parseGlmRequestTimeoutMs(raw)).toThrow(/GLM_REQUEST_TIMEOUT_MS/u);
    }
  });
  it("keeps the existing enabled thinking default and rejects malformed overrides", () => {
    expect(readGlmThinking(undefined)).toBe("enabled");
    expect(readGlmThinking("low")).toBe("low");
    expect(() => readGlmThinking("private-invalid")).toThrow(/GLM_THINKING/u);
  });
  it("uses the bounded 8192 default and accepts explicit supported overrides", () => {
    expect(parseGlmOutputBudget()).toBe(8192);
    expect(parseGlmOutputBudget("16384")).toBe(16384);
    expect(parseGlmOutputBudget("131072")).toBe(131072);
  });
  it.each(["0", "-1", "1.5", "NaN", "Infinity", "131073", "9007199254740992", ""])("rejects invalid option %s", (value) => {
    expect(() => parseGlmOutputBudget(value)).toThrow(/--glm-max-output-tokens/u);
  });
});
