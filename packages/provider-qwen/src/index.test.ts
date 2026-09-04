import { describe, expect, it } from "vitest";
import type { AssetId, JsonValue, Viewport } from "@computer-harness/protocol";
import type { AssetReader, ModelInput } from "@computer-harness/runtime";
import { Qwen38FlashAdapter, type QwenHttpClient } from "./index.js";

const viewport: Viewport = { width: 800, height: 600, coordinateSpace: "physical" };
const asset = { assetId: "asset-1" as AssetId, relativePath: "screenshots/asset-1.png", mediaType: "image/png", byteLength: 2 };

const reader: AssetReader = {
  async read(_ref, signal) { signal.throwIfAborted(); return new Uint8Array([7, 8]); },
};

class Client implements QwenHttpClient {
  public body: Record<string, unknown> | undefined;
  public url: string | undefined;
  public headers: Readonly<Record<string, string>> | undefined;
  public constructor(private readonly response: unknown) {}
  public async post(url: string, body: Record<string, unknown>, headers: Readonly<Record<string, string>>, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    this.url = url;
    this.body = body;
    this.headers = headers;
    return this.response;
  }
}

function input(): ModelInput {
  const schemas: Record<string, JsonValue> = {
    click: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"], additionalProperties: false },
    type: { type: "object", properties: { text: { type: "string", description: "Text to type into the currently focused GUI control." } }, required: ["text"], additionalProperties: false },
    keypress: { type: "object", properties: { keys: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 1 } }, required: ["keys"], additionalProperties: false },
    hotkey: { type: "object", properties: { keys: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 } }, required: ["keys"], additionalProperties: false },
    scroll: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, direction: { type: "string" }, ticks: { type: "integer" } }, required: ["x", "y", "direction", "ticks"], additionalProperties: false },
    drag: { type: "object", properties: { fromX: { type: "number" }, fromY: { type: "number" }, toX: { type: "number" }, toY: { type: "number" } }, required: ["fromX", "fromY", "toX", "toY"], additionalProperties: false },
    wait: { type: "object", properties: { durationMs: { type: "number" } }, required: ["durationMs"], additionalProperties: false },
  };
  return { system: "system", messages: [{ role: "user", content: [{ type: "image", asset, viewport }] }], tools: Object.keys(schemas).map((name) => ({ name, description: `${name} description`, inputSchema: schemas[name]! })) };
}

function response(name: string, argumentsValue: Record<string, unknown>, usage?: Record<string, number>): unknown {
  return {
    choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "native-call-1", type: "function", function: { name, arguments: JSON.stringify(argumentsValue) } }] } }],
    ...(usage === undefined ? {} : { usage }),
  };
}

describe("Qwen3.8-Flash provider adapter", () => {
  it("does not append a provider-specific prompt patch to the caller's system message", async () => {
    const client = new Client(response("terminate", { status: "success", text: "done" }));
    const adapter = new Qwen38FlashAdapter({ apiKey: "key", assetReader: reader, httpClient: client, thinking: "disabled", outputMode: "native_tools" });
    await adapter.generate(input(), { signal: new AbortController().signal });
    const messages = client.body?.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: "system", content: "system" });
  });

  it("uses the official strict JSON response format by default", async () => {
    const client = new Client({
      choices: [{
          finish_reason: "stop",
          message: {
          content: JSON.stringify({ kind: "tool_call", id: "q38-json-1", name: "click", arguments: { x: 400, y: 500 } }),
        },
      }],
    });
    const adapter = new Qwen38FlashAdapter({ apiKey: "key", assetReader: reader, httpClient: client, thinking: "disabled" });
    await expect(adapter.generate(input(), { signal: new AbortController().signal })).resolves.toMatchObject({
      type: "tool_calls",
      calls: [{ id: "q38-json-1", name: "click", arguments: { x: 319.6, y: 299.5 } }],
    });
    expect(client.body?.tools).toBeUndefined();
    expect(client.body?.tool_choice).toBeUndefined();
    expect(client.body?.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "qwen_model_turn", strict: true, schema: { additionalProperties: false, required: ["kind", "id", "name", "arguments"], properties: { arguments: { additionalProperties: false, properties: { x: { type: "number", maximum: 1000 }, y: { type: "number", maximum: 1000 }, status: { enum: ["success", "failure"] } } } } } },
    });
  });

  it("projects strict-mode tool history as JSON content instead of native tool messages", async () => {
    const firstClient = new Client({
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ kind: "tool_call", id: "q38-json-history", name: "click", arguments: { x: 10, y: 20 } }) } }],
    });
    const adapter = new Qwen38FlashAdapter({ apiKey: "key", assetReader: reader, httpClient: firstClient, thinking: "disabled", outputMode: "strict_json" });
    const first = await adapter.generate(input(), { signal: new AbortController().signal });
    if (first.type !== "tool_calls") throw new Error("expected tool call");
    const secondClient = new Client({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ kind: "finish", id: "q38-json-finish", name: "terminate", arguments: { status: "success", text: "done" } }) } }] });
    const secondInput: ModelInput = {
      ...input(),
      messages: [
        ...input().messages,
        { role: "assistant", content: [{ type: "tool_call", call: first.calls[0]!, viewport }] },
        { role: "tool", content: [{ type: "tool_result", result: { callId: first.calls[0]!.id, status: "completed", output: { ok: true } } }] },
      ],
    };
    await new Qwen38FlashAdapter({ apiKey: "key", assetReader: reader, httpClient: secondClient, thinking: "disabled", outputMode: "strict_json" }).generate(secondInput, { signal: new AbortController().signal });
    const messages = secondClient.body?.messages as Array<Record<string, unknown>>;
    expect(messages.some((message) => Array.isArray(message.tool_calls))).toBe(false);
    expect(messages.some((message) => message.role === "user" && typeof message.content === "string" && message.content.includes("Tool result"))).toBe(true);
  });

  it("rejects plain assistant text without an explicit terminate tool call", async () => {
    const client = new Client({ choices: [{ finish_reason: "stop", message: { content: "done" } }] });
    const adapter = new Qwen38FlashAdapter({ apiKey: "key", assetReader: reader, httpClient: client, thinking: "disabled", outputMode: "native_tools" });
    await expect(adapter.generate(input(), { signal: new AbortController().signal })).rejects.toMatchObject({ code: "QWEN_UNCONFIRMED_FINISH", retryable: true });
  });

  it("uses the canonical per-tool schema and maps normalized coordinates", async () => {
    const client = new Client({
      choices: [{ finish_reason: "tool_calls", message: { content: "", reasoning_content: "locate the target", tool_calls: [{ id: "q38-call-1", type: "function", function: { name: "click", arguments: JSON.stringify({ x: 400, y: 500 }) } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    });
    const adapter = new Qwen38FlashAdapter({ apiKey: "key", assetReader: reader, httpClient: client, thinking: "low", outputMode: "native_tools" });
    await expect(adapter.generate(input(), { signal: new AbortController().signal })).resolves.toMatchObject({
      type: "tool_calls",
      calls: [{ id: "q38-call-1", name: "click", arguments: { x: 319.6, y: 299.5 } }],
      continuation: { providerId: "qwen3.8-flash", kind: "reasoning_content", content: "locate the target" },
    });
    expect(client.body?.model).toBe("qwen3.8-flash");
    expect(client.body?.reasoning_effort).toBe("low");
    expect(client.body?.preserve_thinking).toBe(true);
    expect(client.body?.parallel_tool_calls).toBe(false);
    const tools = client.body?.tools as Array<{ function: { name: string; parameters: Record<string, unknown> } }>;
    expect(tools[0]).toMatchObject({ function: { name: "click", parameters: { required: ["x", "y"], properties: { x: { maximum: 1000 }, y: { maximum: 1000 } } } } });
    expect(tools.find((tool) => tool.function.name === "type")).toMatchObject({ function: { parameters: { required: ["text"], properties: { text: { description: "Text to type into the currently focused GUI control." } } } } });
    expect(tools.find((tool) => tool.function.name === "keypress")).toMatchObject({ function: { parameters: { required: ["keys"], properties: { keys: { maxItems: 1 } } } } });
  });

  it("round-trips reasoning continuation and preserves native ToolCall IDs", async () => {
    const firstClient = new Client({ choices: [{ finish_reason: "tool_calls", message: { content: "", reasoning_content: "step one", tool_calls: [{ id: "q38-call-1", type: "function", function: { name: "click", arguments: JSON.stringify({ x: 10, y: 20 }) } }] } }] });
    const adapter = new Qwen38FlashAdapter({ apiKey: "key", assetReader: reader, httpClient: firstClient, thinking: "low", outputMode: "native_tools" });
    const first = await adapter.generate(input(), { signal: new AbortController().signal });
    expect(first.type).toBe("tool_calls");
    if (first.type !== "tool_calls") throw new Error("expected tool calls");
    const historyInput: ModelInput = {
      ...input(),
      messages: [
        ...input().messages,
        { role: "assistant", content: [{ type: "tool_call", call: first.calls[0]!, viewport }, ...(first.continuation === undefined ? [] : [{ type: "provider_continuation" as const, continuation: first.continuation }])] },
        { role: "tool", content: [{ type: "tool_result", result: { callId: first.calls[0]!.id, status: "completed", output: { ok: true } } }] },
      ],
    };
    const secondClient = new Client(response("terminate", { status: "success", text: "done" }));
    const secondAdapter = new Qwen38FlashAdapter({ apiKey: "key", assetReader: reader, httpClient: secondClient, thinking: "low", outputMode: "native_tools" });
    await secondAdapter.generate(historyInput, { signal: new AbortController().signal });
    const messages = secondClient.body?.messages as Array<Record<string, unknown>>;
    const assistant = messages.find((message) => message.role === "assistant");
    expect(assistant?.reasoning_content).toBe("step one");
    expect(assistant?.tool_calls).toEqual([{ id: "q38-call-1", type: "function", function: { name: "click", arguments: JSON.stringify({ x: 10, y: 20 }) } }]);
    expect(messages.find((message) => message.role === "tool")).toMatchObject({ tool_call_id: "q38-call-1" });
  });

  it("keeps actual-pixel coordinates in the physical viewport and rejects out-of-range values", async () => {
    const client = new Client({ choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "q38-pixel", type: "function", function: { name: "click", arguments: JSON.stringify({ x: 799, y: 599 }) } }] } }] });
    const adapter = new Qwen38FlashAdapter({ apiKey: "key", assetReader: reader, httpClient: client, thinking: "disabled", outputMode: "native_tools", coordinateMode: "actual_pixels" });
    await expect(adapter.generate(input(), { signal: new AbortController().signal })).resolves.toMatchObject({ calls: [{ name: "click", arguments: { x: 799, y: 599 } }] });
    const tools = client.body?.tools as Array<{ function: { name: string; parameters: Record<string, unknown> } }>;
    expect(tools[0]).toMatchObject({ function: { name: "click", parameters: { properties: { x: { maximum: 799 }, y: { maximum: 599 } } } } });
    const bad = new Client({ choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "q38-bad", type: "function", function: { name: "click", arguments: JSON.stringify({ x: 800, y: 599 }) } }] } }] });
    await expect(new Qwen38FlashAdapter({ apiKey: "key", assetReader: reader, httpClient: bad, thinking: "disabled", outputMode: "native_tools", coordinateMode: "actual_pixels" }).generate(input(), { signal: new AbortController().signal })).rejects.toMatchObject({ code: "QWEN_COORDINATE_OUT_OF_RANGE" });
  });

  it("maps normalized boundary coordinates to the last physical pixel", async () => {
    const client = new Client({ choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "q38-edge", type: "function", function: { name: "click", arguments: JSON.stringify({ x: 1000, y: 1000 }) } }] } }] });
    await expect(new Qwen38FlashAdapter({ apiKey: "key", assetReader: reader, httpClient: client, thinking: "disabled", outputMode: "native_tools", coordinateMode: "normalized_1000" }).generate(input(), { signal: new AbortController().signal })).resolves.toMatchObject({ calls: [{ arguments: { x: 799, y: 599 } }] });
    const onePixelViewport: ModelInput = {
      ...input(),
      messages: [{ role: "user", content: [{ type: "image", asset, viewport: { width: 1, height: 1, coordinateSpace: "physical" } }] }],
    };
    const onePixelClient = new Client({ choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "q38-one", type: "function", function: { name: "click", arguments: JSON.stringify({ x: 1000, y: 1000 }) } }] } }] });
    await expect(new Qwen38FlashAdapter({ apiKey: "key", assetReader: reader, httpClient: onePixelClient, thinking: "disabled", outputMode: "native_tools", coordinateMode: "normalized_1000" }).generate(onePixelViewport, { signal: new AbortController().signal })).resolves.toMatchObject({ calls: [{ arguments: { x: 0, y: 0 } }] });
  });

  it("maps actual coordinates from a resized presented image back to the Observation viewport", async () => {
    const client = new Client({ choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "q38-resized", type: "function", function: { name: "click", arguments: JSON.stringify({ x: 399, y: 299 }) } }] } }] });
    const adapter = new Qwen38FlashAdapter({
      apiKey: "key",
      assetReader: reader,
      httpClient: client,
      thinking: "disabled",
      outputMode: "native_tools",
      coordinateMode: "actual_pixels",
      imagePreprocessor: async () => ({
        bytes: new Uint8Array([1]),
        mediaType: "image/jpeg",
        viewport: { width: 400, height: 300, coordinateSpace: "physical" },
      }),
    });
    await expect(adapter.generate(input(), { signal: new AbortController().signal })).resolves.toMatchObject({ calls: [{ arguments: { x: 799, y: 599 } }] });
    const tools = client.body?.tools as Array<{ function: { name: string; parameters: Record<string, unknown> } }>;
    expect(tools[0]).toMatchObject({ function: { parameters: { properties: { x: { maximum: 399 }, y: { maximum: 299 } } } } });
  });

  it("rejects invalid prepared-image viewports", async () => {
    const adapter = new Qwen38FlashAdapter({
      apiKey: "key",
      assetReader: reader,
      httpClient: new Client({}),
      outputMode: "native_tools",
      imagePreprocessor: async () => ({
        bytes: new Uint8Array([1]),
        mediaType: "image/jpeg",
        viewport: { width: 0, height: 300, coordinateSpace: "physical" },
      }),
    });
    await expect(adapter.generate(input(), { signal: new AbortController().signal })).rejects.toMatchObject({ code: "QWEN_INVALID_PREPARED_IMAGE" });
  });

  it("passes every supported enabled thinking level to Qwen3.8", async () => {
    for (const thinking of ["low", "medium", "xhigh"] as const) {
      const client = new Client({ choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: `q38-${thinking}`, type: "function", function: { name: "click", arguments: JSON.stringify({ x: 1, y: 2 }) } }] } }] });
      await new Qwen38FlashAdapter({ apiKey: "key", assetReader: reader, httpClient: client, thinking, outputMode: "native_tools" }).generate(input(), { signal: new AbortController().signal });
      expect(client.body?.reasoning_effort).toBe(thinking);
      expect(client.body?.preserve_thinking).toBe(true);
      expect(client.body?.enable_thinking).toBeUndefined();
    }
  });

  it("accepts multiple independent native calls but rejects mixed control calls", async () => {
    const calls = ["click", "type"].map((name, index) => ({ id: `q38-call-${index + 1}`, type: "function", function: { name, arguments: JSON.stringify(name === "click" ? { x: 1, y: 2 } : { text: "hello" }) } }));
    const client = new Client({ choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: calls } }] });
    const adapter = new Qwen38FlashAdapter({ apiKey: "key", assetReader: reader, httpClient: client, thinking: "disabled", outputMode: "native_tools" });
    await expect(adapter.generate(input(), { signal: new AbortController().signal })).resolves.toMatchObject({ type: "tool_calls", calls: [{ id: "q38-call-1" }, { id: "q38-call-2" }] });
    expect(client.body?.enable_thinking).toBe(false);
    expect(client.body?.preserve_thinking).toBe(false);
    const mixed = new Client({ choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [...calls, { id: "q38-control", type: "function", function: { name: "terminate", arguments: JSON.stringify({ status: "success" }) } }] } }] });
    await expect(new Qwen38FlashAdapter({ apiKey: "key", assetReader: reader, httpClient: mixed, thinking: "disabled", outputMode: "native_tools" }).generate(input(), { signal: new AbortController().signal })).rejects.toMatchObject({ code: "QWEN_INVALID_TOOL_CALL" });
  });
});
