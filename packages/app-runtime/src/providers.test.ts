import { describe, expect, it } from "vitest";
import type { ModelInput } from "@computer-harness/runtime";
import type { AssetRef } from "@computer-harness/protocol";
import { createProvider, type ProviderHttpClient, type ResolvedRunConfig } from "./index.js";

function config(overrides: Partial<ResolvedRunConfig> = {}): ResolvedRunConfig {
  return {
    goal: "fixture",
    model: "glm-5.3-flash",
    computer: { kind: "osworld", bridgeUrl: "http://fixture.invalid" },
    outputDir: "runs/app-runtime-provider-test",
    maxSteps: 1,
    maxModelRequests: 1,
    planning: false,
    memory: "off",
    batching: "off",
    contextMode: "raw",
    contextMaxHistoryEvents: 1,
    riskProfile: "experiment",
    riskGuard: "off",
    riskModel: "off",
    riskMaxModelRequests: 1,
    riskTimeoutMs: 100,
    cleanupDeadlineMs: 100,
    ...overrides,
  };
}

const assetReader = {
  async read() { return new Uint8Array([1]); },
};

function clickInput(): ModelInput {
  return {
    system: "system",
    messages: [{ role: "user", content: [{ type: "text", text: "click the fixture" }] }],
    tools: [{
      name: "click",
      description: "Click one point.",
      category: "computer",
      coordinate: { fields: ["x", "y"] },
      inputSchema: {
        type: "object",
        properties: { x: { type: "number" }, y: { type: "number" } },
        required: ["x", "y"],
        additionalProperties: false,
      },
    }],
  };
}

function finishInput(): ModelInput {
  return {
    system: "system",
    messages: [{ role: "user", content: [{ type: "text", text: "finish the fixture" }] }],
    tools: [{
      name: "finish",
      description: "Finish the run.",
      category: "control",
      control: "finish",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" }, status: { enum: ["success", "failure"] } },
        required: ["text", "status"],
        additionalProperties: false,
      },
    }],
  };
}

function clickInputWithImage(): ModelInput {
  return {
    ...clickInput(),
    messages: [{
      role: "user",
      content: [{
        type: "image",
        asset: { assetId: "fixture-asset", relativePath: "screenshots/fixture.png", mediaType: "image/png", byteLength: 1 } as AssetRef,
        viewport: { width: 1000, height: 500, coordinateSpace: "physical" },
      }],
    }],
  };
}

describe("app-runtime provider factory", () => {
  it("requires injected credentials without reading the environment", () => {
    expect(() => createProvider({ model: "glm-5.3-flash", config: config(), assetReader, outputDir: "runs/glm", credentials: {} })).toThrow(/ZHIPUAI_API_KEY/iu);
    expect(() => createProvider({ model: "qwen3.8-flash", config: config({ model: "qwen3.8-flash" }), assetReader, outputDir: "runs/qwen", credentials: {} })).toThrow(/DASHSCOPE_API_KEY/iu);
  });

  it("constructs both provider adapters from the resolved model and injected key", () => {
    const glm = createProvider({ model: "glm-5.3-flash", config: config(), assetReader, outputDir: "runs/glm", credentials: { glmApiKey: "fixture-glm-key" } });
    const qwen = createProvider({ model: "qwen3.8-flash", config: config({ model: "qwen3.8-flash", qwenCoordinateMode: "normalized_1000", qwenThinking: "low", qwenOutputMode: "strict_json" }), assetReader, outputDir: "runs/qwen", credentials: { qwenApiKey: "fixture-qwen-key" } });
    expect(glm.id).toBe("glm-5.3-flash");
    expect(qwen.id).toBe("qwen3.8-flash");
  });

  it("preserves GLM request endpoint, thinking mode, and canonical tool projection", async () => {
    let request: { url: string; body: Record<string, unknown>; headers: Readonly<Record<string, string>> } | undefined;
    const client: ProviderHttpClient = {
      async post(url, body, headers) {
        request = { url, body, headers };
        return {
          choices: [{ finish_reason: "tool_calls", message: {
            content: "",
            tool_calls: [{ id: "glm-call", type: "function", function: { name: "click", arguments: JSON.stringify({ x: 12, y: 34 }) } }],
          } }],
        };
      },
    };
    const provider = createProvider({
      model: "glm-5.3-flash",
      config: config({ glmEndpoint: "https://glm.fixture/v1", glmThinking: "disabled" }),
      assetReader,
      outputDir: "runs/glm-wire",
      credentials: { glmApiKey: "fixture-glm-key" },
      httpClients: { glm: client },
    });
    await expect(provider.generate(clickInput(), { signal: new AbortController().signal })).resolves.toMatchObject({ type: "tool_calls", calls: [{ name: "click", arguments: { x: 12, y: 34 } }] });
    expect(request?.url).toBe("https://glm.fixture/v1");
    expect(request?.headers.Authorization).toBe("Bearer fixture-glm-key");
    expect(request?.body).toMatchObject({ model: "glm-5.3-flash", stream: false, thinking: { type: "disabled" } });
    expect(request?.body.tools).toMatchObject([{ type: "function", function: { name: "click" } }]);
  });

  it("preserves Qwen native output, endpoint, thinking, and coordinate-unit schema", async () => {
    let request: { url: string; body: Record<string, unknown> } | undefined;
    const client: ProviderHttpClient = {
      async post(url, body) {
        request = { url, body };
        return {
          choices: [{ finish_reason: "tool_calls", message: {
            content: "",
            tool_calls: [{ id: "qwen-call", type: "function", function: { name: "click", arguments: JSON.stringify({ x: 500, y: 250 }) } }],
          } }],
        };
      },
    };
    const provider = createProvider({
      model: "qwen3.8-flash",
      config: config({ model: "qwen3.8-flash", qwenEndpoint: "https://qwen.fixture/v1", qwenCoordinateMode: "normalized_1000", qwenThinking: "xhigh", qwenOutputMode: "native_tools" }),
      assetReader,
      outputDir: "runs/qwen-native-wire",
      credentials: { qwenApiKey: "fixture-qwen-key" },
      httpClients: { qwen: client },
    });
    await expect(provider.generate(clickInputWithImage(), { signal: new AbortController().signal })).resolves.toMatchObject({ type: "tool_calls", calls: [{ name: "click" }] });
    expect(request?.url).toBe("https://qwen.fixture/v1/chat/completions");
    expect(request?.body).toMatchObject({ model: "qwen3.8-flash", stream: false, temperature: 0, tool_choice: "auto", parallel_tool_calls: false, reasoning_effort: "xhigh", preserve_thinking: true });
    expect(request?.body.tools).toMatchObject([{ type: "function", function: { name: "click", description: expect.stringContaining("normalized") } }]);
    expect(request?.body).not.toHaveProperty("response_format");
  });

  it("keeps Qwen strict JSON output separate from native tool schemas", async () => {
    let request: { url: string; body: Record<string, unknown> } | undefined;
    const client: ProviderHttpClient = {
      async post(url, body) {
        request = { url, body };
        return {
          choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ calls: [{ id: "finish-call", name: "finish", arguments: { text: "done", status: "success" } }] }) } }],
        };
      },
    };
    const provider = createProvider({
      model: "qwen3.8-flash",
      config: config({ model: "qwen3.8-flash", qwenEndpoint: "https://qwen.strict/v1", qwenCoordinateMode: "actual_pixels", qwenThinking: "disabled", qwenOutputMode: "strict_json" }),
      assetReader,
      outputDir: "runs/qwen-strict-wire",
      credentials: { qwenApiKey: "fixture-qwen-key" },
      httpClients: { qwen: client },
    });
    const input = finishInput();
    input.tools = [...clickInput().tools, ...input.tools];
    await expect(provider.generate(input, { signal: new AbortController().signal })).resolves.toMatchObject({ type: "finish", summary: "done", reportedStatus: "success" });
    expect(request?.url).toBe("https://qwen.strict/v1/chat/completions");
    expect(request?.body).toMatchObject({ model: "qwen3.8-flash", enable_thinking: false, preserve_thinking: false });
    expect(request?.body).not.toHaveProperty("reasoning_effort");
    expect(request?.body.response_format).toMatchObject({ type: "json_schema" });
    expect(request?.body).not.toHaveProperty("tools");
    const messages = request?.body.messages as Array<Record<string, unknown>> | undefined;
    expect(messages?.[0]?.content).toEqual(expect.stringContaining("[pixel]"));
  });
});
