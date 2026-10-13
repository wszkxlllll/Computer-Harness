import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DefaultContextCompiler } from "@computer-harness/context";
import type {
  AssetRef,
  ComputerSession,
  ComputerSessionId,
  ModelInput,
  RunId,
  SourceLinkedFinishContract,
  SourceLinkedFinishReport,
  SurfaceId,
  Viewport,
} from "@computer-harness/protocol";
import {
  createDefaultToolRegistry,
  ToolRegistry,
  type AssetReader,
  type Computer,
  type ProviderAdapter,
} from "@computer-harness/runtime";
import { GlmAdapter, glmProfiles, type GlmHttpClient } from "../../provider-glm/src/index.js";
import { Qwen38FlashAdapter, type QwenHttpClient } from "../../provider-qwen/src/index.js";
import { createRun } from "./run-factory.js";
import type { ResolvedRunConfig } from "./config.js";

vi.mock("@computer-harness/context", () => import("../../context/src/index.js"));

const runId = "source-linked-factory-test" as RunId;
const contract: SourceLinkedFinishContract = {
  version: "source-linked-finish-v1",
  fields: [{ fieldId: "cpu", label: "CPU", required: true }],
};
const report: SourceLinkedFinishReport = {
  version: "source-linked-finish-v1",
  fields: [{ fieldId: "cpu", disposition: "unknown", reason: "not_observed" }],
};
const viewport: Viewport = { width: 2, height: 2, coordinateSpace: "physical" };
const surfaceRef = { surfaceId: "source-linked-factory-surface" as SurfaceId, generation: 1, kind: "desktop" as const };

function config(outputDir: string, sourceLinked = true): ResolvedRunConfig {
  return {
    runId,
    goal: "report the listed CPU",
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
    ...(sourceLinked ? { sourceLinkedFinish: contract } : {}),
  };
}

function fakeComputer(): Computer {
  const session: ComputerSession = {
    id: "source-linked-factory-session" as ComputerSessionId,
    backend: "fixture",
    viewport,
    capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false },
    openedAt: "2026-10-13T00:00:00.000Z",
  };
  return {
    async open() {
      return session;
    },
    async observe() {
      return {
        capturedAt: "2026-10-13T00:00:01.000Z",
        viewport,
        surfaceRef,
        screenshot: { mediaType: "image/png", data: new Uint8Array([1, 2, 3]) },
      };
    },
    async execute(_current, action) {
      return { actionId: action.actionId, status: "completed" };
    },
    async close() {},
  };
}

function finishProvider(inputs: ModelInput[], includeUnrequestedEvidence: boolean): ProviderAdapter {
  return {
    id: "source-linked-fixture-provider",
    async generate(input) {
      inputs.push(input);
      return {
        type: "finish",
        summary: "The requested CPU is reported.",
        reportedStatus: "success",
        ...(includeUnrequestedEvidence ? { resultEvidence: report } : {}),
      };
    },
  };
}

class GlmCaptureClient implements GlmHttpClient {
  public body: Record<string, unknown> | undefined;

  public constructor(private readonly response: unknown) {}

  public async post(
    _url: string,
    body: Record<string, unknown>,
    _headers: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): Promise<unknown> {
    signal.throwIfAborted();
    this.body = body;
    return this.response;
  }
}

class QwenCaptureClient implements QwenHttpClient {
  public body: Record<string, unknown> | undefined;

  public constructor(private readonly response: unknown) {}

  public async post(
    _url: string,
    body: Record<string, unknown>,
    _headers: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): Promise<unknown> {
    signal.throwIfAborted();
    this.body = body;
    return this.response;
  }
}

const assetReader: AssetReader = {
  async read(_asset: AssetRef, signal) {
    signal.throwIfAborted();
    return new Uint8Array([1, 2, 3]);
  },
};

describe("source-linked finish tool contract", () => {
  it("registers one Runtime terminate contract, projects it through a replaceable Context, and preserves both Provider wires", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-source-linked-contract-"));
    const inputs: ModelInput[] = [];
    const provider = finishProvider(inputs, true);
    let registry: ToolRegistry | undefined;
    let handle: Awaited<ReturnType<typeof createRun>> | undefined;
    try {
      handle = await createRun(config(outputDir), {
        createProvider: () => provider,
        createComputer: () => Promise.resolve(fakeComputer()),
        createContextCompiler: (tools, features) => {
          registry = tools;
          const base = new DefaultContextCompiler(tools, { features });
          return {
            async compile(input, signal) {
              const compiled = await base.compile(input, signal);
              return {
                ...compiled,
                messages: [
                  { role: "user", content: [{ type: "text", text: "Custom evidence note: inspect the CPU field." }] },
                  ...compiled.messages,
                ],
              };
            },
          };
        },
      });
      await expect(handle.start()).resolves.toBe("succeeded");
      expect(inputs).toHaveLength(1);
      const modelInput = inputs[0]!;
      const actualRegistry = registry;
      if (actualRegistry === undefined) throw new Error("Run did not create its ToolRegistry");
      const registeredTerminate = actualRegistry.modelTools("main").find((tool) => tool.name === "terminate");
      const projectedTerminate = modelInput.tools.find((tool) => tool.name === "terminate");
      expect(projectedTerminate).toEqual(registeredTerminate);
      expect(modelInput.tools.filter((tool) => tool.control === "finish")).toHaveLength(1);
      expect(JSON.stringify(modelInput.messages)).toContain("Custom evidence note: inspect the CPU field.");
      expect(handle.controller.getEvents().some((event) =>
        event.type === "run.finished" && event.resultEvidence?.version === "source-linked-finish-v1",
      )).toBe(true);

      const glmClient = new GlmCaptureClient({
        choices: [{
          finish_reason: "tool_calls",
          message: {
            tool_calls: [{
              id: "glm-finish",
              type: "function",
              function: { name: "terminate", arguments: JSON.stringify({ status: "success", text: "CPU reported.", resultEvidence: report }) },
            }],
          },
        }],
      });
      const glmTurn = await new GlmAdapter({
        apiKey: "fixture-key",
        profile: glmProfiles["glm-5.3-flash"],
        assetReader,
        httpClient: glmClient,
      }).generate(modelInput, { signal: new AbortController().signal });
      const glmTerminate = (glmClient.body?.tools as Array<{ function: { name: string; parameters: Record<string, unknown> } }> | undefined)
        ?.find((tool) => tool.function.name === "terminate")?.function;
      expect(glmTerminate?.parameters).toMatchObject({
        properties: {
          resultEvidence: {
            type: "object",
            properties: {
              version: { type: "string", const: "source-linked-finish-v1" },
              fields: {
                type: "array",
                maxItems: 32,
                items: {
                  oneOf: expect.arrayContaining([
                    expect.objectContaining({
                      properties: expect.objectContaining({
                        disposition: { type: "string", const: "source_bound" },
                        sources: expect.objectContaining({
                          type: "array",
                          maxItems: 4,
                          items: expect.objectContaining({
                            properties: {
                              observationId: { type: "string", minLength: 1, maxLength: 128 },
                              elementRef: { type: "string", minLength: 1, maxLength: 96 },
                            },
                          }),
                        }),
                      }),
                    }),
                    expect.objectContaining({
                      properties: expect.objectContaining({ disposition: { type: "string", const: "inference" } }),
                    }),
                    expect.objectContaining({
                      properties: expect.objectContaining({ disposition: { type: "string", const: "unknown" } }),
                    }),
                  ]),
                },
              },
            },
            required: ["version", "fields"],
            additionalProperties: false,
          },
        },
        required: expect.arrayContaining(["status", "text", "resultEvidence"]),
      });
      expect(glmTurn).toMatchObject({ type: "finish", resultEvidence: report });

      const qwenClient = new QwenCaptureClient({
        choices: [{
          finish_reason: "stop",
          message: {
            content: JSON.stringify({
              calls: [{ id: "qwen-finish", name: "terminate", arguments: { status: "success", text: "CPU reported.", resultEvidence: report } }],
            }),
          },
        }],
      });
      const qwenTurn = await new Qwen38FlashAdapter({
        apiKey: "fixture-key",
        assetReader,
        httpClient: qwenClient,
        outputMode: "strict_json",
      }).generate(modelInput, { signal: new AbortController().signal });
      const qwenWireMessages = qwenClient.body?.messages as Array<{ role: string; content: unknown }> | undefined;
      const qwenSystem = qwenWireMessages?.find((message) => message.role === "system")?.content;
      const qwenSystemText = typeof qwenSystem === "string" ? qwenSystem : "";
      const catalogStart = qwenSystemText.indexOf("Available tools (semantic guidance; Runtime validates exact arguments):");
      const catalogEnd = qwenSystemText.indexOf("\nStrict output envelope", catalogStart);
      const toolCatalog = catalogStart < 0 || catalogEnd < 0 ? "" : qwenSystemText.slice(catalogStart, catalogEnd);
      const terminateLine = toolCatalog.split("\n").find((line) => line.startsWith("- terminate("));
      const argumentsStart = terminateLine?.indexOf("(") ?? -1;
      const argumentsEnd = terminateLine?.indexOf("):", argumentsStart) ?? -1;
      const terminateArguments = argumentsStart < 0 || argumentsEnd < 0
        ? ""
        : terminateLine!.slice(argumentsStart + 1, argumentsEnd);
      const responseFormat = qwenClient.body?.response_format as { type?: string; json_schema?: { schema?: Record<string, unknown> } } | undefined;
      expect(terminateArguments).toMatch(/(?:^|,\s*)status:string=success\|failure(?:\s+description=|,|$)/u);
      expect(terminateArguments).toMatch(/(?:^|,\s*)text:string(?:\s+description=|,|$)/u);
      expect(terminateArguments).toMatch(/(?:^|,\s*)resultEvidence:object(?:,|$)/u);
      const serializedQwenMessages = JSON.stringify(qwenWireMessages);
      expect(serializedQwenMessages).toContain("resultEvidence version source-linked-finish-v1");
      expect(serializedQwenMessages).toContain("cpu (CPU; required)");
      expect(qwenClient.body).not.toHaveProperty("tools");
      expect(responseFormat?.type).toBe("json_schema");
      const callArray = (responseFormat?.json_schema?.schema?.properties as Record<string, unknown> | undefined)?.calls as
        { items?: { properties?: Record<string, unknown>; required?: string[] } } | undefined;
      const argumentsSchema = callArray?.items?.properties?.arguments as { type?: string; properties?: Record<string, unknown>; additionalProperties?: boolean } | undefined;
      expect(callArray?.items?.required).toEqual(["id", "name", "arguments"]);
      expect((callArray?.items?.properties?.name as { enum?: string[] } | undefined)?.enum).toContain("terminate");
      expect(argumentsSchema).toMatchObject({ type: "object", additionalProperties: true });
      expect(argumentsSchema?.properties).not.toHaveProperty("resultEvidence");
      expect(qwenTurn).toMatchObject({ type: "finish", resultEvidence: report });
    } finally {
      if (handle !== undefined) await handle.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("keeps default termination free of source-linked input and persisted result fields when disabled", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-source-linked-disabled-"));
    const inputs: ModelInput[] = [];
    let registry: ToolRegistry | undefined;
    let handle: Awaited<ReturnType<typeof createRun>> | undefined;
    try {
      handle = await createRun(config(outputDir, false), {
        createProvider: () => finishProvider(inputs, true),
        createComputer: () => Promise.resolve(fakeComputer()),
        createContextCompiler: (tools, features) => {
          registry = tools;
          return new DefaultContextCompiler(tools, { features });
        },
      });
      await expect(handle.start()).resolves.toBe("succeeded");
      const modelInput = inputs[0];
      if (modelInput === undefined) throw new Error("fixture Provider did not receive a ModelInput");
      const actualRegistry = registry;
      if (actualRegistry === undefined) throw new Error("Run did not create its ToolRegistry");
      const registeredTerminate = actualRegistry.modelTools("main").find((tool) => tool.name === "terminate");
      const projectedTerminate = modelInput.tools.find((tool) => tool.name === "terminate");
      expect(projectedTerminate).toEqual(registeredTerminate);
      expect(JSON.stringify(projectedTerminate?.inputSchema)).not.toContain("resultEvidence");
      expect(JSON.stringify(modelInput.messages)).not.toContain("Source-linked finish is enabled for this Run");
      expect(JSON.stringify(handle.controller.getEvents())).not.toContain("resultEvidence");
      expect(JSON.stringify(handle.controller.getEvents())).not.toContain("reportedSummary");
    } finally {
      if (handle !== undefined) await handle.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["missing finish", () => new ToolRegistry()],
    ["multiple finishes", () => {
      const registry = createDefaultToolRegistry({ sourceLinkedFinish: contract });
      registry.register({
        name: "other_finish",
        description: "second finish",
        category: "control",
        control: "finish",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        validate() {},
      });
      return registry;
    }],
    ["mismatched custom terminate", () => createDefaultToolRegistry()],
  ] as const)("rejects a custom Registry with %s when source-linked finish is enabled", async (_label, makeRegistry) => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-source-linked-registry-error-"));
    try {
      await expect(createRun(config(outputDir), {
        createProvider: () => finishProvider([], true),
        createToolRegistry: makeRegistry,
      })).rejects.toThrow(/source-linked finish requires/u);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
