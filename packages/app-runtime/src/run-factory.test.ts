import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createMemoryRunModule, FileMemoryStore, HybridMemoryRecallService, InMemoryMemoryStore, type MemoryRunModule, type MemoryStore } from "@computer-harness/memory";
import { DefaultContextCompiler } from "@computer-harness/context";
import type { EventId, JsonValue, MemoryMutation, RunId, RuntimeEvent, SurfaceId, ToolCallId, Viewport } from "@computer-harness/protocol";
import { createDefaultToolRegistry, ToolRegistry, type Computer, type MemoryRecallService, type ModelInput, type NonComputerToolDefinition, type PlanningTaskMutation, type ProviderAdapter } from "@computer-harness/runtime";
import { createPlanningRunModule, FilePlanStore, InMemoryPlanStore, type PlanningRunModule } from "@computer-harness/planning";
import { readRuntimeEvents, reduceRuntimeEvents } from "@computer-harness/trajectory";
import { buildRunReport, createRun, createRunFactory, writeRunReport, type ResolvedRunConfig } from "./index.js";

const fixtureSurfaceRef = { surfaceId: "run-factory-desktop" as SurfaceId, generation: 1, kind: "desktop" as const };

// Keep this integration test on current package sources without rebuilding dist.
vi.mock("@computer-harness/provider-glm", () => import("../../provider-glm/src/index.js"));
vi.mock("@computer-harness/context", () => import("../../context/src/index.js"));

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

function hybridNativeRecoveryConfig(outputDir: string, managedBrowserUrl: string): ResolvedRunConfig {
  const primary = { pid: 101, windowId: 501 };
  const recovery = { pid: 101, windowId: 502 };
  return {
    ...config(outputDir),
    windowSwitch: "opened-windows-v1",
    windowHandoff: "confirm-v1",
    recoverBoundWindowMissing: true,
    grounding: "hybrid-catalog-v1",
    computer: {
      kind: "cua",
      socketPath: "fixture.sock",
      screenshotDir: join(outputDir, "screenshots"),
      windowTarget: primary,
      recoveryWindowTarget: recovery,
      windowSwitch: "opened-windows-v1",
      windowSwitchAllowedTargets: [primary, recovery],
      recoverBoundWindowMissing: true,
      managedBrowserCompanion: true,
      managedBrowserUrl,
      managedBrowserProfileMode: "ephemeral",
      hybridNativeWebDocumentTargets: { primaryTarget: primary, recoveryTarget: recovery },
      reopenSavedDocumentGrant: {
        path: join(outputDir, "authorized-output.txt"),
        expectedExecutableUrl: "file:///System/Applications/TextEdit.app/Contents/MacOS/TextEdit",
      },
    },
  };
}

async function withDarwinPlatform<T>(run: () => Promise<T>): Promise<T> {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  if (originalPlatform === undefined || originalPlatform.configurable !== true) {
    throw new Error("test runtime does not allow restoring a temporary process.platform override");
  }
  Object.defineProperty(process, "platform", { ...originalPlatform, value: "darwin" });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, "platform", originalPlatform);
    expect(process.platform).toBe(originalPlatform.value);
  }
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
  it("rejects missing main or active layered risk credentials before Run allocation", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-provider-preflight-"));
    const mainOutput = join(root, "main-run");
    const riskOutput = join(root, "risk-run");
    const createComputer = vi.fn(() => Promise.resolve(fakeComputer({ open: 0, observe: 0, close: 0 })));
    const createEventWriter = vi.fn();
    const createAssetStore = vi.fn();
    try {
      await expect(createRun(config(mainOutput), { createComputer, createEventWriter, createAssetStore }))
        .rejects.toMatchObject({ name: "ProviderConfigurationError", code: "PROVIDER_CREDENTIALS_MISSING" });
      await expect(readdir(mainOutput)).rejects.toMatchObject({ code: "ENOENT" });
      expect(createComputer).not.toHaveBeenCalled();
      expect(createEventWriter).not.toHaveBeenCalled();
      expect(createAssetStore).not.toHaveBeenCalled();

      await expect(createRun({ ...config(riskOutput), riskGuard: "layered", riskModel: "qwen3.8-flash" }, {
        credentials: { glmApiKey: "fixture-main-key" }, createComputer, createEventWriter, createAssetStore,
      })).rejects.toMatchObject({ name: "ProviderConfigurationError", code: "PROVIDER_CREDENTIALS_MISSING" });
      await expect(readdir(riskOutput)).rejects.toMatchObject({ code: "ENOENT" });
      expect(createComputer).not.toHaveBeenCalled();
      expect(createEventWriter).not.toHaveBeenCalled();
      expect(createAssetStore).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preflights risk credentials only for an active distinct layered model", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-provider-risk-preflight-"));
    const createComputer = () => Promise.resolve(fakeComputer({ open: 0, observe: 0, close: 0 }));
    try {
      for (const [name, riskGuard, riskModel] of [
        ["guard-off", "off", "qwen3.8-flash"],
        ["same-model", "layered", "same"],
      ] as const) {
        const handle = await createRun({ ...config(join(root, name)), riskGuard, riskModel }, {
          credentials: { glmApiKey: "fixture-main-key" }, createComputer,
        });
        await handle.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves credential policy to an injected Provider factory", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-provider-injection-preflight-"));
    const provider = { id: "fixture-provider", async generate() { return { type: "finish" as const, summary: "unused" }; } };
    const createProvider = vi.fn(() => provider);
    try {
      const handle = await createRun(config(join(root, "run")), {
        credentials: {}, createProvider,
        createComputer: () => Promise.resolve(fakeComputer({ open: 0, observe: 0, close: 0 })),
      });
      expect(createProvider).toHaveBeenCalledOnce();
      await handle.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    [undefined, false],
    ["off", false],
    ["catalog-v1", true],
  ] as const)("keeps task operation guidance opt-in for a Run (%s)", async (operationGuidance, expectedIncluded) => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-app-operation-guidance-"));
    const inputs: ModelInput[] = [];
    let configuredOperationGuidance: string | undefined;
    let compiledGoal: string | undefined;
    let selectedOperationGuidance: string | undefined;
    const provider: ProviderAdapter = {
      id: "fixture-provider",
      async generate(input) {
        inputs.push(input);
        return { type: "finish", summary: "fixture done", reportedStatus: "success" };
      },
    };
    try {
      const handle = await createRun({
        ...config(outputDir),
        goal: "新建文档并保存。",
        ...(operationGuidance === undefined ? {} : { operationGuidance }),
      }, {
        createProvider: () => provider,
        createComputer: () => Promise.resolve(fakeComputer({ open: 0, observe: 0, close: 0 })),
        createContextCompiler: (tools, features, runConfig) => {
          configuredOperationGuidance = runConfig.operationGuidance;
          const base = new DefaultContextCompiler(tools, { features });
          return {
            async compile(input, signal) {
              compiledGoal = input.goal;
              selectedOperationGuidance = input.operationGuidance?.id;
              return base.compile(input, signal);
            },
          };
        },
      });
      await expect(handle.start()).resolves.toBe("succeeded");
      expect(configuredOperationGuidance).toBe(operationGuidance);
      expect(compiledGoal).toBe("新建文档并保存。");
      expect(selectedOperationGuidance).toBe(expectedIncluded ? "text_document_save" : undefined);
      const input = inputs[0];
      if (input === undefined) throw new Error("fixture Provider did not receive a Context");
      const guidanceMessages = input.messages.filter((message) =>
        message.role === "user" && JSON.stringify(message.content).includes("Current task operation note"),
      );
      expect(guidanceMessages).toHaveLength(expectedIncluded ? 1 : 0);
      expect(input.contextBudget?.trace?.operationGuidance?.included).toBe(expectedIncluded ? true : undefined);
      await handle.close();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("requires matching Run and CUA recovery opt-ins with the exact opened-window scope", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-recovery-config-gate-"));
    const primary = { pid: 101, windowId: 501 };
    const recovery = { pid: 101, windowId: 502 };
    const cua = {
      kind: "cua" as const,
      socketPath: "/tmp/cua-recovery-fixture.sock",
      screenshotDir: join(outputDir, "screenshots"),
      windowTarget: primary,
      recoveryWindowTarget: recovery,
      recoverBoundWindowMissing: true,
      windowSwitch: "opened-windows-v1" as const,
      windowSwitchAllowedTargets: [primary, recovery],
    };
    try {
      await expect(createRun({ ...config(outputDir), recoverBoundWindowMissing: true }, {}))
        .rejects.toThrow(/matching Run and CUA computer opt-ins/u);
      await expect(createRun({ ...config(outputDir), computer: cua }, {}))
        .rejects.toThrow(/matching Run and CUA computer opt-ins/u);
      await expect(createRun({ ...config(outputDir), computer: cua, recoverBoundWindowMissing: true }, {}))
        .rejects.toThrow(/exact native window switching/u);
      const nativeRecoveryConfig = {
        ...config(outputDir),
        computer: cua,
        recoverBoundWindowMissing: true,
        windowSwitch: "opened-windows-v1" as const,
      };
      await expect(createRun({
        ...nativeRecoveryConfig,
        computer: { ...cua, windowSwitch: "off" },
      }, {})).rejects.toThrow(/exact native window switching/u);
      await expect(createRun({ ...nativeRecoveryConfig, computer: { ...cua, managedBrowserUrl: "https://example.invalid" } }, {}))
        .rejects.toThrow(/exact native window switching/u);
      await expect(createRun({ ...nativeRecoveryConfig, computer: { ...cua, grounding: "hybrid-catalog-v1" } }, {}))
        .rejects.toThrow(/exact native window switching/u);
      expect(await readdir(outputDir)).toEqual([]);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it.each([
    "https://catalog-one.example/items?q=fixture",
    "http://store-two.example:8080/products",
    "about:blank",
  ])("accepts an explicit managed-browser URL for hybrid native recovery: %s", async (managedBrowserUrl) => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-hybrid-native-recovery-url-"));
    const calls = { open: 0, observe: 0, close: 0 };
    let computerConfig: ResolvedRunConfig["computer"] | undefined;
    try {
      await withDarwinPlatform(async () => {
        const handle = await createRun(hybridNativeRecoveryConfig(outputDir, managedBrowserUrl), {
          createProvider: () => ({ id: "fixture-provider", async generate() { return { type: "finish", summary: "unused" }; } }),
          createComputer: (options) => {
            computerConfig = options.config;
            const computer = fakeComputer(calls);
            return Promise.resolve({ ...computer, async listWindows() { return []; } });
          },
        });

        expect(handle.config.computer).toMatchObject({
          kind: "cua",
          managedBrowserUrl,
          managedBrowserProfileMode: "ephemeral",
          managedBrowserCompanion: true,
          windowTarget: { pid: 101, windowId: 501 },
          recoveryWindowTarget: { pid: 101, windowId: 502 },
          hybridNativeWebDocumentTargets: {
            primaryTarget: { pid: 101, windowId: 501 },
            recoveryTarget: { pid: 101, windowId: 502 },
          },
          reopenSavedDocumentGrant: {
            path: join(outputDir, "authorized-output.txt"),
            expectedExecutableUrl: "file:///System/Applications/TextEdit.app/Contents/MacOS/TextEdit",
          },
        });
        expect(computerConfig).toMatchObject({
          kind: "cua",
          managedBrowserUrl,
          managedBrowserProfileMode: "ephemeral",
          managedBrowserCompanion: true,
        });
        await handle.close();
      });
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("rejects unsafe hybrid recovery URLs before creating Run resources", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-hybrid-native-recovery-unsafe-url-"));
    const createProvider = vi.fn(() => ({ id: "fixture-provider", async generate() { return { type: "finish" as const, summary: "unused" }; } }));
    const createComputer = vi.fn(() => Promise.resolve(fakeComputer({ open: 0, observe: 0, close: 0 })));
    try {
      await withDarwinPlatform(async () => {
        await expect(createRun(hybridNativeRecoveryConfig(outputDir, "https://user:secret@example.test/path"), {
          createProvider,
          createComputer,
        })).rejects.toThrow(/credential-free http\(s\) managedBrowserUrl/iu);
      });
      expect(createProvider).not.toHaveBeenCalled();
      expect(createComputer).not.toHaveBeenCalled();
      expect(await readdir(outputDir)).toEqual([]);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("keeps hybrid native recovery limited to ephemeral managed-browser profiles", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-hybrid-native-recovery-persistent-profile-"));
    const createProvider = vi.fn(() => ({ id: "fixture-provider", async generate() { return { type: "finish" as const, summary: "unused" }; } }));
    const createComputer = vi.fn(() => Promise.resolve(fakeComputer({ open: 0, observe: 0, close: 0 })));
    try {
      await withDarwinPlatform(async () => {
        const ephemeral = hybridNativeRecoveryConfig(outputDir, "https://generic.example/path");
        if (ephemeral.computer.kind !== "cua") throw new Error("hybrid recovery fixture must use CUA");
        await expect(createRun({
          ...ephemeral,
          computer: {
            ...ephemeral.computer,
            managedBrowserProfileMode: "persistent",
            managedBrowserProfileLabel: "default",
            managedBrowserProfileRoot: join(outputDir, "persistent-profile"),
          },
        }, { createProvider, createComputer })).rejects.toThrow(/ephemeral managed Browser/iu);
      });
      expect(createProvider).not.toHaveBeenCalled();
      expect(createComputer).not.toHaveBeenCalled();
      expect(await readdir(outputDir)).toEqual([]);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("rejects a missing hybrid recovery URL and mismatched target pair", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-hybrid-native-recovery-target-gate-"));
    const createProvider = vi.fn(() => ({ id: "fixture-provider", async generate() { return { type: "finish" as const, summary: "unused" }; } }));
    try {
      await withDarwinPlatform(async () => {
        const withUrl = hybridNativeRecoveryConfig(outputDir, "https://generic.example/path");
        const computerWithoutUrl = { ...withUrl.computer };
        if (computerWithoutUrl.kind !== "cua") throw new Error("hybrid recovery fixture must use CUA");
        delete computerWithoutUrl.managedBrowserUrl;
        await expect(createRun({ ...withUrl, computer: computerWithoutUrl }, { createProvider }))
          .rejects.toThrow(/explicit URL/iu);

        const withMismatchedTarget = {
          ...withUrl,
          computer: {
            ...withUrl.computer,
            hybridNativeWebDocumentTargets: {
              ...withUrl.computer.hybridNativeWebDocumentTargets!,
              recoveryTarget: { pid: 101, windowId: 999 },
            },
          },
        };
        await expect(createRun(withMismatchedTarget, { createProvider }))
          .rejects.toThrow(/exact Host-authorized window targets/iu);
      });
      expect(createProvider).not.toHaveBeenCalled();
      expect(await readdir(outputDir)).toEqual([]);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("rejects an invalid resolved GLM timeout before creating Run resources", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-glm-timeout-config-gate-"));
    const createProvider = vi.fn(() => ({ id: "fixture-provider", async generate() { return { type: "finish" as const, summary: "unused" }; } }));
    try {
      await expect(createRun({ ...config(outputDir), glmRequestTimeoutMs: 240001 }, { createProvider })).rejects.toThrow(/request timeout/u);
      expect(createProvider).not.toHaveBeenCalled();
      expect(await readdir(outputDir)).toEqual([]);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("records a real Runtime→GLM→recorder→Fetch exchange against its Run request", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-runtime-glm-exchange-"));
    const runId = "runtime-http-correlation" as RunId;
    const fetchResponse = {
      choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{
        id: "synthetic-terminate",
        type: "function",
        function: { name: "terminate", arguments: JSON.stringify({ status: "failure", text: "The requested result remains unverified; no GUI result was supplied." }) },
      }] } }],
    };
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => fetchResponse }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const handle = await createRun({
        ...config(outputDir),
        runId,
        maxModelRequests: 3,
        contextMaxInputTokens: 16384,
        contextMaxWireInputTokens: 24576,
      }, {
        credentials: { glmApiKey: "synthetic-secret-token" },
        createComputer: () => Promise.resolve(fakeComputer({ open: 0, observe: 0, close: 0 })),
      });
      await expect(handle.start()).resolves.toBe("failed");
      const report = await handle.report();
      const started = report.events.find((event) => event.type === "model.request.started");
      expect(started?.type).toBe("model.request.started");
      if (started?.type !== "model.request.started") throw new Error("model request start event was missing");
      const exchanges = (await readFile(join(outputDir, "provider-exchanges.jsonl"), "utf8")).trim().split(/\r?\n/u).map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(started).toMatchObject({
        requestId: expect.any(String),
        decisionId: expect.any(String),
        attempt: 1,
        preparedRequest: { payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/u) },
        contextBudget: { maxInputTokens: 16384, maxWireInputTokens: 24576 },
      });
      expect(exchanges).toHaveLength(1);
      expect(exchanges[0]).toMatchObject({
        provider: "glm",
        correlation: "complete",
        runId,
        requestId: started.requestId,
        decisionId: started.decisionId,
        attempt: 1,
        payloadHash: started.preparedRequest?.payloadHash,
        httpEvidence: { source: "fetch", stages: [
          { stage: "fetch_invoked", phase: "awaiting_headers", deadlineMs: 90000, serializedBodyBytes: expect.any(Number), requestConfiguration: { stream: false, thinking: "enabled", reasoningEffort: "server_default", maxTokens: 8192, messageCount: expect.any(Number), toolCount: expect.any(Number), imageCount: 1 } },
          { stage: "headers_received", phase: "reading_body", httpStatus: 200 },
          { stage: "body_received", phase: "complete", outcome: "success", httpStatus: 200 },
        ] },
        preparedEstimate: { estimatedTextTokens: expect.any(Number), estimatedVisualTokens: expect.any(Number), estimatedEnvelopeTokens: 32, estimatedTotalTokens: expect.any(Number), imageCount: 1, estimationMethod: "provider_projection" },
      });
      const serialized = JSON.stringify(exchanges);
      expect(serialized).not.toContain("synthetic-secret-token");
      expect(serialized).not.toContain("open.bigmodel.cn");
      expect(serialized).not.toContain("requested result remains unverified");
      await handle.close();
    } finally {
      vi.unstubAllGlobals();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("runs official DeepSeek with only its own credential and reports native multimodal usage privately", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-runtime-deepseek-exchange-"));
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(_url).toBe("https://api.deepseek.com/chat/completions");
      expect(body).toMatchObject({ model: "deepseek-flash", thinking: { type: "disabled" }, max_tokens: 4096 });
      return { ok: true, status: 200, json: async () => ({
        model: "deepseek-flash",
        choices: [{ finish_reason: "tool_calls", message: { role: "assistant", tool_calls: [{
          id: "deepseek-terminate", type: "function",
          function: { name: "terminate", arguments: JSON.stringify({ status: "failure", text: "The requested result could not be verified." }) },
        }] } }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30, prompt_cache_hit_tokens: 15, prompt_cache_miss_tokens: 5 },
      }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const handle = await createRun({ ...config(outputDir), model: "deepseek-flash" }, {
        credentials: { deepseekApiKey: "synthetic-deepseek-secret" },
        createComputer: () => Promise.resolve(fakeComputer({ open: 0, observe: 0, close: 0 })),
      });
      await expect(handle.start()).resolves.toBe("failed");
      const report = await handle.report();
      expect(report.summary).toMatchObject({
        model: "deepseek-flash", thinkingMode: "disabled", outputMode: "native_tools", coordinateMode: "actual_pixels",
        glmThinking: null, glmMaxOutputTokens: null, deepseekMaxOutputTokens: 4096, deepseekRequestTimeoutMs: 90000,
        modelReportedStatus: "failure", modelSummary: "The requested result could not be verified.",
      });
      const completed = report.events.find((event) => event.type === "model.response.received");
      expect(completed).toMatchObject({ turn: { usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30, cacheReadTokens: 15 } } });
      const record = JSON.parse((await readFile(join(outputDir, "provider-exchanges.jsonl"), "utf8")).trim()) as Record<string, unknown>;
      expect(record).toMatchObject({
        provider: "deepseek", requestedModel: "deepseek-flash",
        httpEvidence: { source: "fetch", stages: [
          { stage: "fetch_invoked", deadlineMs: 90000, requestConfiguration: { thinking: "disabled", maxTokens: 4096, imageCount: 1 } },
          { stage: "headers_received" }, { stage: "body_received", outcome: "success" },
        ] },
        response: { usage: { cachedReadTokens: 15, cacheMissTokens: 5 } },
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(record)).not.toContain("synthetic-deepseek-secret");
      expect(JSON.stringify(record)).not.toContain("The requested result could not be verified.");
      expect(JSON.stringify(report.summary)).not.toContain("synthetic-deepseek-secret");
      await handle.close();
    } finally {
      vi.unstubAllGlobals();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("rejects unknown model selections before acquiring Run resources", async () => {
    const createComputer = vi.fn();
    await expect(createRun({ ...config("unused"), model: "unknown" as ResolvedRunConfig["model"] }, { createComputer })).rejects.toThrow(/unsupported Provider model/u);
    expect(createComputer).not.toHaveBeenCalled();
  });

  it("uses one explicit GLM timeout for Fetch evidence and Runtime retry reserve", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-runtime-glm-explicit-timeout-"));
    const runId = "runtime-glm-explicit-timeout" as RunId;
    const fetchMock = vi.fn(async () => { throw new Error("synthetic network failure"); });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const handle = await createRun({
        ...config(outputDir),
        runId,
        glmRequestTimeoutMs: 120_000,
        maxModelRequests: 3,
      }, {
        credentials: { glmApiKey: "synthetic-secret-token" },
        createComputer: () => Promise.resolve(fakeComputer({ open: 0, observe: 0, close: 0 })),
      });
      await expect(handle.start()).resolves.toBe("failed");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const records = (await readFile(join(outputDir, "provider-exchanges.jsonl"), "utf8")).trim().split(/\r?\n/u).map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        runId,
        correlation: "complete",
        httpEvidence: { source: "fetch", stages: [
          { stage: "fetch_invoked", deadlineMs: 120_000, serializedBodyBytes: expect.any(Number) },
          { stage: "fetch_failed", outcome: "network_error", phase: "awaiting_headers" },
        ] },
      });
      await handle.close();
    } finally {
      vi.unstubAllGlobals();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it.each(["glm-5.3-flash", "qwen3.8-flash"] as const)("does not apply the default GLM retry reserve to injected %s providers", async (model) => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-injected-provider-timeout-"));
    let calls = 0;
    const injectedProvider: ProviderAdapter = {
      id: `injected-${model}`,
      async generate() {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error("synthetic retryable provider error"), { retryable: true, retryMode: "same_input" });
        return { type: "finish", summary: "The injected fixture completed successfully." };
      },
    };
    try {
      const handle = await createRun({ ...config(outputDir), model, glmRequestTimeoutMs: 120_000, maxModelRequests: 3 }, {
        createProvider: () => injectedProvider,
        createComputer: () => Promise.resolve(fakeComputer({ open: 0, observe: 0, close: 0 })),
      });
      await expect(handle.start()).resolves.toBe("succeeded");
      expect(calls).toBe(2);
      await handle.close();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("projects the opt-in multiline typing presentation without replacing registered tool behavior", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-app-multiline-type-profile-"));
    const inputs: ModelInput[] = [];
    const baseRegistry = createDefaultToolRegistry();
    const sourceType = baseRegistry.get("type");
    if (sourceType?.category !== "computer") throw new Error("default registry is missing the type Computer tool");
    const validate = vi.fn(sourceType.validate);
    const toAction = vi.fn(sourceType.toAction);
    const customSchema: JsonValue = {
      ...(sourceType.inputSchema as { [key: string]: JsonValue }),
      fixtureMarker: "preserved",
    };
    const customRegistry = new ToolRegistry();
    for (const definition of baseRegistry.list()) {
      customRegistry.register(definition.name === "type"
        ? { ...sourceType, audiences: ["main"] as const, inputSchema: customSchema, validate, toAction }
        : definition);
    }
    let projectedType: ReturnType<ToolRegistry["get"]> = undefined;
    try {
      const handle = await createRun({
        ...config(outputDir),
        computer: { kind: "cua", socketPath: "candidate.sock", screenshotDir: "screenshots", multilineTypeProfile: "foreground-caret-v1" },
      }, {
        createProvider: () => ({
          id: "fixture-provider",
          async generate(input) {
            inputs.push(input);
            return { type: "finish", summary: "profile fixture done" };
          },
        }),
        createComputer: () => Promise.resolve(fakeComputer({ open: 0, observe: 0, close: 0 })),
        createToolRegistry: () => customRegistry,
        createContextCompiler: (tools, features) => {
          projectedType = tools.get("type");
          return new DefaultContextCompiler(tools, { features });
        },
      });
      await expect(handle.start()).resolves.toBe("succeeded");
      const modelType = inputs[0]?.tools.find((tool) => tool.name === "type");
      expect(modelType?.inputSchema).toMatchObject({ fixtureMarker: "preserved" });
      expect(projectedType?.category).toBe("computer");
      expect(projectedType?.audiences).toEqual(["main"]);
      expect(projectedType?.validate).toBe(validate);
      expect(projectedType?.category === "computer" ? projectedType.toAction : undefined).toBe(toAction);
      if (process.platform === "win32") {
        expect(modelType?.description).toContain("foreground-caret-v1");
        expect(modelType?.description).toContain("Enter key events and can submit/send");
        expect(modelType?.description).toContain("that route does not automatically submit or send");
        expect(modelType?.description).toContain("intended to insert at the current caret or replace the current selection");
        expect(modelType?.description).toContain("driver completion does not verify the resulting content");
        expect(modelType?.description).not.toContain("preserves the current caret or selection");
        expect(modelType?.description).not.toContain("separate single-line type calls with Enter between lines");
        expect(JSON.stringify(modelType?.inputSchema)).not.toContain("without the Host-only foreground-caret profile");
        expect(modelType?.inputSchema).toMatchObject({
          properties: {
            text: { description: expect.stringContaining("intended to insert at the current caret or replace the current selection") },
            elementRef: { description: expect.stringContaining("append-to-end") },
          },
        });
        expect(modelType?.inputSchema).toMatchObject({
          properties: { text: { description: expect.stringContaining("Enter key events and can submit/send") } },
        });
      } else {
        expect(modelType?.description).toBe(sourceType.description);
      }
      await handle.close();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("rejects an undersized wire budget before the first real HTTP call", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-runtime-glm-wire-reject-"));
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ choices: [] }) }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const handle = await createRun({
        ...config(outputDir),
        goal: `Inspect this synthetic request without losing its content: ${"x".repeat(40000)}`,
        runId: "runtime-http-wire-reject" as RunId,
        maxModelRequests: 3,
        contextMaxInputTokens: 8000,
        contextMaxWireInputTokens: 8000,
      }, {
        credentials: { glmApiKey: "synthetic-secret-token" },
        createComputer: () => Promise.resolve(fakeComputer({ open: 0, observe: 0, close: 0 })),
      });
      await expect(handle.start()).resolves.toBe("failed");
      expect(fetchMock).not.toHaveBeenCalled();
      const report = await handle.report();
      expect(report.events.some((event) => event.type === "model.request.started")).toBe(false);
      expect(report.events).toContainEqual(expect.objectContaining({ type: "runtime.error", category: "budget" }));
      await handle.close();
    } finally {
      vi.unstubAllGlobals();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

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

  it("keeps a single-file reopen grant out of provider configuration while exposing its zero-argument tool only for that Run", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-app-reopen-grant-"));
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    if (originalPlatform === undefined || originalPlatform.configurable !== true) {
      await rm(outputDir, { recursive: true, force: true });
      throw new Error("test runtime does not allow restoring a temporary process.platform override");
    }
    let providerConfig: ResolvedRunConfig | undefined;
    let modelToolNames: string[] = [];
    let computerConfig: import("./computers.js").ComputerBackendConfig | undefined;
    try {
      Object.defineProperty(process, "platform", { ...originalPlatform, value: "darwin" });
      expect(createDefaultToolRegistry().get("reopen_saved_document")).toBeUndefined();
      const reopenPath = join(outputDir, "one-run-output.txt");
      const handle = await createRun({
        ...config(outputDir),
        computer: {
          kind: "cua", socketPath: "fixture.sock", screenshotDir: join(outputDir, "screenshots"),
          windowTarget: { pid: 42, windowId: 84 }, recoveryWindowTarget: { pid: 42, windowId: 85 },
          windowSwitchAllowedTargets: [{ pid: 42, windowId: 84 }, { pid: 42, windowId: 85 }],
          recoverBoundWindowMissing: true,
          reopenSavedDocumentGrant: { path: reopenPath, expectedExecutableUrl: "file:///System/Applications/TextEdit.app/Contents/MacOS/TextEdit" },
        },
        windowSwitch: "opened-windows-v1",
        windowHandoff: "confirm-v1",
        recoverBoundWindowMissing: true,
      }, {
        createProvider: (options) => {
          providerConfig = options.config;
          return {
            id: "reopen-grant-provider",
            async generate(input) {
              modelToolNames = input.tools.map((tool) => tool.name);
              return { type: "finish", summary: "Grant tool visibility checked." };
            },
          };
        },
        createComputer: ({ config: value }) => {
          computerConfig = value;
          const computer = fakeComputer({ open: 0, observe: 0, close: 0 });
          const open = computer.open.bind(computer);
          computer.open = async (...args) => ({ ...await open(...args), platform: "darwin" });
          computer.listWindows = async () => ({ options: [], truncated: false, omittedCount: 0 });
          return Promise.resolve(computer);
        },
      });
      const outcome = await handle.start();
      if (outcome !== "succeeded") throw new Error(`reopen-grant fixture ended ${outcome}: ${JSON.stringify(await handle.report())}`);
      expect(computerConfig).toMatchObject({ reopenSavedDocumentGrant: { path: reopenPath } });
      expect(providerConfig?.computer).not.toHaveProperty("reopenSavedDocumentGrant");
      expect(modelToolNames).toContain("reopen_saved_document");
      await handle.close();
    } finally {
      Object.defineProperty(process, "platform", originalPlatform);
      expect(process.platform).toBe(originalPlatform.value);
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
      const handle = await createRun({
        ...config(outputDir),
        glmThinking: thinking,
        contextMaxInputTokens: 16_384,
        contextMaxWireInputTokens: 24_576,
        ...(budget === undefined ? {} : { glmMaxOutputTokens: budget }),
      }, {
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
        contextMaxInputTokens: 16_384,
        contextMaxWireInputTokens: 24_576,
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
        expect(await readFile(join(outputDir, "report.md"), "utf8")).toContain("Final target: unknown after a model-selected target transition began");
      } finally {
        await rm(outputDir, { recursive: true, force: true });
      }
    }
  });

  it("invalidates a reported target only after reopen dispatch and restores it after a newer handoff", async () => {
    const scenarios: ReadonlyArray<{ id: string; refusalCode?: string; newerHandoff?: boolean }> = [
      { id: "not-ready-refusal", refusalCode: "DOCUMENT_REOPEN_NOT_READY" },
      { id: "preflight-refusal", refusalCode: "DOCUMENT_REOPEN_PREFLIGHT_FAILED" },
      { id: "generic-refusal", refusalCode: "OTHER_REFUSAL" },
      { id: "reopen-started" },
      { id: "newer-handoff", newerHandoff: true },
    ];
    for (const scenario of scenarios) {
      const outputDir = await mkdtemp(join(tmpdir(), `harness-app-reopen-final-target-${scenario.id}-`));
      const runId = `reopen-final-target-${scenario.id}` as RunId;
      const session = {
        id: `${runId}-session` as import("@computer-harness/protocol").ComputerSessionId,
        backend: "fixture",
        viewport: { width: 800, height: 600, coordinateSpace: "physical" as const },
        capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false },
        openedAt: "2026-10-01T02:00:03.000Z",
      };
      const originalTarget = { pid: 2345, windowId: 6789 };
      const nextTarget = { pid: 3456, windowId: 7890 };
      const observationId = `${runId}-recovery-observation` as import("@computer-harness/protocol").ObservationId;
      const callId = `${runId}-reopen-call` as ToolCallId;
      const actionId = `${runId}-reopen-action` as import("@computer-harness/protocol").ActionId;
      const action = { actionId, basedOn: observationId, kind: "reopen_saved_document" as const };
      const call = { id: callId, name: "reopen_saved_document", arguments: {} };
      const events: RuntimeEvent[] = [
        ...recoveryReportBaseEvents(runId),
        { eventId: `${runId}-event-5` as EventId, runId, sequence: 5, occurredAt: "2026-10-01T02:00:05.000Z", type: "computer.window.handoff.requested", sourceActionId: `${runId}-initial-handoff`, reasonCode: "bound_window_missing" },
        { eventId: `${runId}-event-6` as EventId, runId, sequence: 6, occurredAt: "2026-10-01T02:00:06.000Z", type: "computer.window.handoff.completed", target: originalTarget, session },
        ...[
          { eventId: `${runId}-event-7` as EventId, runId, sequence: 7, occurredAt: "2026-10-01T02:00:07.000Z", type: "observation.created" as const, observation: {
            id: observationId,
            runId,
            computerSessionId: session.id,
            surfaceRef: { ...fixtureSurfaceRef, surfaceId: `${runId}-surface` as SurfaceId },
            capturedAt: "2026-10-01T02:00:07.000Z",
            viewport: session.viewport,
            screenshot: { assetId: `${runId}-asset` as import("@computer-harness/protocol").AssetId, relativePath: "screenshots/current.png", mediaType: "image/png" as const, byteLength: 1 },
          } },
          { eventId: `${runId}-event-8` as EventId, runId, sequence: 8, occurredAt: "2026-10-01T02:00:08.000Z", type: "tool.call.received" as const, call },
          { eventId: `${runId}-event-9` as EventId, runId, sequence: 9, occurredAt: "2026-10-01T02:00:09.000Z", type: "action.proposed" as const, callId, action },
          { eventId: `${runId}-event-10` as EventId, runId, sequence: 10, occurredAt: "2026-10-01T02:00:10.000Z", type: "action.execution.started" as const, action },
          ...(scenario.refusalCode !== undefined ? [
            { eventId: `${runId}-event-11` as EventId, runId, sequence: 11, occurredAt: "2026-10-01T02:00:11.000Z", type: "action.execution.failed" as const, receipt: { actionId, status: "refused" as const, driverCode: scenario.refusalCode, message: "fixture refusal" } },
            { eventId: `${runId}-event-12` as EventId, runId, sequence: 12, occurredAt: "2026-10-01T02:00:12.000Z", type: "tool.call.failed" as const, result: { callId, status: "failed" as const, error: { code: scenario.refusalCode, message: "fixture refusal" } } },
            { eventId: `${runId}-event-13` as EventId, runId, sequence: 13, occurredAt: "2026-10-01T02:00:13.000Z", type: "run.finished" as const, outcome: "failed" as const },
          ] : scenario.newerHandoff ? [
            { eventId: `${runId}-event-11` as EventId, runId, sequence: 11, occurredAt: "2026-10-01T02:00:11.000Z", type: "action.execution.completed" as const, receipt: { actionId, status: "completed" as const, sessionAfter: session } },
            { eventId: `${runId}-event-12` as EventId, runId, sequence: 12, occurredAt: "2026-10-01T02:00:12.000Z", type: "computer.window.handoff.requested" as const, sourceActionId: actionId, reasonCode: "bound_window_missing" as const },
            { eventId: `${runId}-event-13` as EventId, runId, sequence: 13, occurredAt: "2026-10-01T02:00:13.000Z", type: "computer.window.handoff.completed" as const, target: nextTarget, session },
            { eventId: `${runId}-event-14` as EventId, runId, sequence: 14, occurredAt: "2026-10-01T02:00:14.000Z", type: "run.finished" as const, outcome: "succeeded" as const },
          ] : [
            { eventId: `${runId}-event-11` as EventId, runId, sequence: 11, occurredAt: "2026-10-01T02:00:11.000Z", type: "run.finished" as const, outcome: "outcome_unknown" as const },
          ]),
        ],
      ];
      try {
        await writeFile(join(outputDir, "trajectory.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
        const report = await buildRunReport({
          ...config(outputDir),
          runId,
          windowSwitch: "opened-windows-v1",
          computer: { kind: "cua", socketPath: "fixture.sock", screenshotDir: "screenshots", windowTarget: { pid: 1234, windowId: 5678 } },
        }, runId, [], []);
        if (scenario.refusalCode === "DOCUMENT_REOPEN_NOT_READY" || scenario.refusalCode === "DOCUMENT_REOPEN_PREFLIGHT_FAILED") {
          expect(report.summary.finalComputerTarget).toEqual({ mode: "window", ...originalTarget });
        } else if (scenario.refusalCode !== undefined || scenario.id === "reopen-started") {
          expect(report.summary.finalComputerTarget).toBeNull();
        } else {
          expect(report.summary.finalComputerTarget).toEqual({ mode: "window", ...nextTarget });
        }
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

  it("rejects markerless native-only recovery combined with Browser/Hybrid/grant before creating Run resources", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-app-runtime-markerless-hybrid-rejected-"));
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    if (originalPlatform === undefined || originalPlatform.configurable !== true) {
      await rm(outputDir, { recursive: true, force: true });
      throw new Error("test runtime does not allow restoring a temporary process.platform override");
    }
    const createProvider = vi.fn(() => ({ id: "fixture-provider", async generate() { return { type: "finish" as const, summary: "unused" }; } }));
    const createComputer = vi.fn(() => Promise.resolve(fakeComputer({ open: 0, observe: 0, close: 0 })));
    try {
      Object.defineProperty(process, "platform", { ...originalPlatform, value: "darwin" });
      await expect(createRun({
        ...config(outputDir),
        windowSwitch: "opened-windows-v1",
        windowHandoff: "confirm-v1",
        recoverBoundWindowMissing: true,
        grounding: "hybrid-catalog-v1",
        computer: {
          kind: "cua", socketPath: "fixture.sock", screenshotDir: join(outputDir, "screenshots"),
          windowTarget: { pid: 42, windowId: 84 }, recoveryWindowTarget: { pid: 42, windowId: 85 },
          windowSwitchAllowedTargets: [{ pid: 42, windowId: 84 }, { pid: 42, windowId: 85 }],
          recoverBoundWindowMissing: true, managedBrowserCompanion: true, managedBrowserUrl: "https://example.test/",
          reopenSavedDocumentGrant: { path: join(outputDir, "output.txt"), expectedExecutableUrl: "file:///System/Applications/TextEdit.app/Contents/MacOS/TextEdit" },
        },
      }, { createProvider, createComputer })).rejects.toThrow(/bound-window recovery requires/iu);
      expect(createProvider).not.toHaveBeenCalled();
      expect(createComputer).not.toHaveBeenCalled();
      expect(await readdir(outputDir)).toEqual([]);
    } finally {
      Object.defineProperty(process, "platform", originalPlatform);
      expect(process.platform).toBe(originalPlatform.value);
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
      const close = handle.close();
      expect(handle.close()).toBe(close);
      await expect(close).rejects.toThrow(/memory_module\.close/iu);
      expect(moduleClose).toHaveBeenCalledOnce();
      expect((await handle.report()).summary.cleanupDiagnostics).toEqual(report.summary.cleanupDiagnostics);
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
