import { describe, expect, it, vi } from "vitest";
import type { AssetId, JsonValue, ToolCallId, Viewport } from "@computer-harness/protocol";
import type { AssetReader, ModelInput } from "@computer-harness/runtime";
import { Qwen38FlashAdapter, QwenGuiPlusAdapter, type QwenHttpClient } from "./index.js";

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

describe("Qwen GUI-Plus provider adapter", () => {
  it("exposes one Function Schema per tool and converts normalized coordinates into Harness pixels", async () => {
    const client = new Client(response("click", { coordinate: [40, 50] }, { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 }));
    const adapter = new QwenGuiPlusAdapter({ apiKey: "key", assetReader: reader, httpClient: client });
    const turn = await adapter.generate(input(), { signal: new AbortController().signal });
    expect(turn).toMatchObject({ type: "tool_calls", calls: [{ id: "native-call-1", name: "click", arguments: { x: 31.96, y: 29.95 } }], usage: { inputTokens: 9, outputTokens: 3, totalTokens: 12 } });
    const messages = client.body?.messages as Array<Record<string, unknown>>;
    const systemText = String(messages[0]?.content ?? "");
    expect(systemText).toContain("Coordinates are normalized from 0 to 1000");
    expect(systemText).not.toContain("<tools>");
    const tools = client.body?.tools as Array<{ type: string; function: { name: string; description: string; parameters: Record<string, unknown> } }>;
    expect(tools.map((tool) => tool.function.name)).toEqual(["click", "type", "keypress", "hotkey", "scroll", "drag", "wait", "terminate", "interact"]);
    expect(tools[0]).toMatchObject({ type: "function", function: { name: "click", parameters: { required: ["coordinate"], properties: { coordinate: { description: expect.stringContaining("0..1000") } } } } });
    expect(tools.find((tool) => tool.function.name === "scroll")).toMatchObject({ function: { parameters: { required: ["coordinate", "pixels", "direction"] } } });
    expect(tools.find((tool) => tool.function.name === "drag")).toMatchObject({ function: { parameters: { required: ["coordinate", "coordinate2"] } } });
    expect(tools.find((tool) => tool.function.name === "wait")).toMatchObject({ function: { parameters: { required: ["time"] } } });
    expect(tools.find((tool) => tool.function.name === "terminate")).toMatchObject({ function: { parameters: { required: ["status"], properties: { status: { enum: ["success", "failure"] } } } } });
    expect(tools.find((tool) => tool.function.name === "interact")).toMatchObject({ function: { parameters: { required: ["text"] } } });
    expect(client.body?.vl_high_resolution_images).toBe(true);
    expect(client.url).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
  });

  it("constrains actual-pixel schemas to the current viewport and preserves pixel output", async () => {
    const client = new Client(response("click", { coordinate: [799, 599] }));
    const adapter = new QwenGuiPlusAdapter({ apiKey: "key", assetReader: reader, coordinateMode: "actual_pixels", httpClient: client });
    await expect(adapter.generate(input(), { signal: new AbortController().signal })).resolves.toMatchObject({ calls: [{ name: "click", arguments: { x: 799, y: 599 } }] });
    const tools = client.body?.tools as Array<{ function: { name: string; parameters: Record<string, unknown> } }>;
    expect(tools[0]).toMatchObject({ function: { name: "click", parameters: { required: ["coordinate"], properties: { coordinate: { description: expect.stringContaining("x 0-799, y 0-599") } } } } });
  });

  it("maps independent key, wait, terminate, and interact function calls", async () => {
    const keyClient = new Client(response("hotkey", { keys: ["CTRL", "L"] }));
    const keyTurn = await new QwenGuiPlusAdapter({ apiKey: "key", assetReader: reader, httpClient: keyClient }).generate(input(), { signal: new AbortController().signal });
    expect(keyTurn).toMatchObject({ type: "tool_calls", calls: [{ name: "hotkey", arguments: { keys: ["CTRL", "L"] } }] });
    const waitClient = new Client(response("wait", { time: 1.25 }));
    const waitTurn = await new QwenGuiPlusAdapter({ apiKey: "key", assetReader: reader, httpClient: waitClient }).generate(input(), { signal: new AbortController().signal });
    expect(waitTurn).toMatchObject({ type: "tool_calls", calls: [{ name: "wait", arguments: { durationMs: 1250 } }] });
    const scrollClient = new Client(response("scroll", { coordinate: [40, 50], pixels: -3, direction: "down" }));
    const scrollTurn = await new QwenGuiPlusAdapter({ apiKey: "key", assetReader: reader, httpClient: scrollClient }).generate(input(), { signal: new AbortController().signal });
    expect(scrollTurn).toMatchObject({ type: "tool_calls", calls: [{ name: "scroll", arguments: { x: 31.96, y: 29.95, direction: "down", ticks: 3 } }] });
    const dragClient = new Client(response("drag", { coordinate: [10, 20], coordinate2: [100, 200] }));
    const dragTurn = await new QwenGuiPlusAdapter({ apiKey: "key", assetReader: reader, httpClient: dragClient }).generate(input(), { signal: new AbortController().signal });
    expect(dragTurn).toMatchObject({ type: "tool_calls", calls: [{ name: "drag", arguments: { fromX: 7.99, fromY: 11.98, toX: 79.9, toY: 119.8 } }] });
    const terminateClient = new Client(response("terminate", { status: "failure", text: "not complete" }));
    await expect(new QwenGuiPlusAdapter({ apiKey: "key", assetReader: reader, httpClient: terminateClient }).generate(input(), { signal: new AbortController().signal })).resolves.toEqual({ type: "finish", summary: "not complete", reportedStatus: "failure" });
    const interactClient = new Client(response("interact", { text: "Need confirmation" }));
    await expect(new QwenGuiPlusAdapter({ apiKey: "key", assetReader: reader, httpClient: interactClient }).generate(input(), { signal: new AbortController().signal })).resolves.toEqual({ type: "user_input_required", question: "Need confirmation" });
  });

  it("rejects missing terminate status and unknown tools", async () => {
    const missingStatus = new Client(response("terminate", { text: "done" }));
    await expect(new QwenGuiPlusAdapter({ apiKey: "key", assetReader: reader, httpClient: missingStatus }).generate(input(), { signal: new AbortController().signal })).rejects.toMatchObject({ code: "QWEN_INVALID_TOOL_CALL" });
    const unknown = new Client(response("fly", {}));
    await expect(new QwenGuiPlusAdapter({ apiKey: "key", assetReader: reader, httpClient: unknown }).generate(input(), { signal: new AbortController().signal })).rejects.toMatchObject({ code: "QWEN_UNAVAILABLE_TOOL" });
  });

  it("rejects malformed native calls, text-encoded calls and truncated responses", async () => {
    const native = new Client({ choices: [{ message: { content: "done", tool_calls: [{ id: "native", type: "function" }] } }] });
    await expect(new QwenGuiPlusAdapter({ apiKey: "key", assetReader: reader, httpClient: native }).generate(input(), { signal: new AbortController().signal })).rejects.toMatchObject({ code: "QWEN_INVALID_TOOL_CALL" });
    const xml = new Client({ choices: [{ message: { content: '<tool_call>{"name":"computer_use","arguments":{"action":"left_click","coordinate":244,570]}}</tool_call>' } }] });
    await expect(new QwenGuiPlusAdapter({ apiKey: "key", assetReader: reader, httpClient: xml }).generate(input(), { signal: new AbortController().signal })).rejects.toMatchObject({ code: "QWEN_UNTAGGED_TOOL_CALL" });
    const untagged = new Client({ choices: [{ message: { content: "```json\n{\"name\":\"computer_use\",\"arguments\":{\"action\":\"left_click\",\"coordinate\":[1,2]}}\n```" } }] });
    await expect(new QwenGuiPlusAdapter({ apiKey: "key", assetReader: reader, httpClient: untagged }).generate(input(), { signal: new AbortController().signal })).rejects.toMatchObject({ code: "QWEN_UNTAGGED_TOOL_CALL" });
    const truncated = new Client({ choices: [{ message: { content: "partial" }, finish_reason: "length" }] });
    await expect(new QwenGuiPlusAdapter({ apiKey: "key", assetReader: reader, httpClient: truncated }).generate(input(), { signal: new AbortController().signal })).rejects.toMatchObject({ code: "QWEN_INCOMPLETE_RESPONSE" });
  });

  it("re-encodes history into native calls using each call's viewport and preserves result IDs", async () => {
    const client = new Client(response("click", { coordinate: [10, 20] }));
    const call = { id: "call-1" as ToolCallId, name: "click", arguments: { x: 10, y: 20 } };
    const historyInput: ModelInput = {
      ...input(),
      messages: [
        ...input().messages,
        { role: "assistant", content: [{ type: "tool_call", call, viewport: { ...viewport, width: 400, height: 200 } }] },
        { role: "tool", content: [{ type: "tool_result", result: { callId: call.id, status: "completed", output: { ok: true } } }] },
      ],
    };
    await new QwenGuiPlusAdapter({ apiKey: "key", assetReader: reader, httpClient: client }).generate(historyInput, { signal: new AbortController().signal });
    const messages = client.body?.messages as Array<Record<string, unknown>>;
    expect(messages.find((message) => message.role === "tool")).toMatchObject({ tool_call_id: "call-1", content: JSON.stringify({ callId: call.id, status: "completed", output: { ok: true } }) });
    const assistant = messages.find((message) => message.role === "assistant");
    expect(typeof assistant?.content).toBe("string");
    expect(assistant?.tool_calls).toEqual([{ id: "call-1", type: "function", function: { name: "click", arguments: JSON.stringify({ coordinate: [10 * 1000 / 399, 20 * 1000 / 199] }) } }]);
  });

  it("derives a Workspace endpoint and surfaces HTTP errors", async () => {
    const client = new Client(response("type", { text: "hello" }));
    await new QwenGuiPlusAdapter({ apiKey: "key", workspaceId: "ws-demo", assetReader: reader, httpClient: client }).generate(input(), { signal: new AbortController().signal });
    expect(client.url).toBe("https://ws-demo.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions");
    const explicitClient = new Client(response("type", { text: "hello" }));
    await new QwenGuiPlusAdapter({ apiKey: "key", endpoint: "https://example.invalid/compatible-mode/v1/", assetReader: reader, httpClient: explicitClient }).generate(input(), { signal: new AbortController().signal });
    expect(explicitClient.url).toBe("https://example.invalid/compatible-mode/v1/chat/completions");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 429, json: async () => ({ message: "rate limited" }) })));
    try {
      await expect(new QwenGuiPlusAdapter({ apiKey: "key", assetReader: reader }).generate(input(), { signal: new AbortController().signal })).rejects.toMatchObject({ code: "QWEN_HTTP_429", retryable: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("offers only supported tools that are available, while always allowing finish and user input", async () => {
    const client = new Client(response("terminate", { status: "failure" }));
    const adapter = new QwenGuiPlusAdapter({ apiKey: "key", assetReader: reader, httpClient: client });
    await adapter.generate({ ...input(), tools: [] }, { signal: new AbortController().signal });
    expect(client.body?.tools).toMatchObject([
      { type: "function", function: { name: "terminate", parameters: { required: ["status"] } } },
      { type: "function", function: { name: "interact", parameters: { required: ["text"] } } },
    ]);
    const unavailable = new QwenGuiPlusAdapter({ apiKey: "key", assetReader: reader, httpClient: new Client(response("type", { text: "hello" })) });
    await expect(unavailable.generate({ ...input(), tools: [] }, { signal: new AbortController().signal })).rejects.toMatchObject({ code: "QWEN_UNAVAILABLE_TOOL" });
  });

  it("rejects malformed JSON without repair and refuses multiple native calls", async () => {
    const badCall = { id: "bad", type: "function", function: { name: "click", arguments: '{"coordinate":[244,570]' } };
    for (const [calls, code] of [[[badCall], "QWEN_INVALID_TOOL_CALL"], [[badCall, badCall], "QWEN_MULTIPLE_TOOL_CALLS"]] as const) {
      const adapter = new QwenGuiPlusAdapter({ apiKey: "key", assetReader: reader, httpClient: new Client({ choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: calls } }] }) });
      await expect(adapter.generate(input(), { signal: new AbortController().signal })).rejects.toMatchObject({ code });
    }
  });

  it("maps full-image preprocessing back to the Harness viewport and rejects out-of-range coordinates", async () => {
    const adapter = new QwenGuiPlusAdapter({ apiKey: "key", assetReader: reader, imagePreprocessor: async () => ({ bytes: new Uint8Array([1]), mediaType: "image/jpeg", viewport: { width: 400, height: 300, coordinateSpace: "physical" } }), httpClient: new Client(response("click", { coordinate: [500, 250] })) });
    await expect(adapter.generate(input(), { signal: new AbortController().signal })).resolves.toMatchObject({ calls: [{ arguments: { x: 399.5, y: 149.75 } }] });
    const bad = new QwenGuiPlusAdapter({ apiKey: "key", assetReader: reader, httpClient: new Client(response("click", { coordinate: [1001, 20] })) });
    await expect(bad.generate(input(), { signal: new AbortController().signal })).rejects.toMatchObject({ code: "QWEN_COORDINATE_OUT_OF_RANGE" });
  });

  it("surfaces a plain text finish but not an empty response or missing call", async () => {
    const adapterFor = (content: unknown, finish_reason: string) => new QwenGuiPlusAdapter({ apiKey: "key", assetReader: reader, httpClient: new Client({ choices: [{ finish_reason, message: { content } }] }) });
    await expect(adapterFor("done", "stop").generate(input(), { signal: new AbortController().signal })).resolves.toEqual({ type: "finish", summary: "done" });
    await expect(adapterFor(null, "stop").generate(input(), { signal: new AbortController().signal })).rejects.toMatchObject({ code: "QWEN_EMPTY_RESPONSE" });
    await expect(adapterFor("done", "tool_calls").generate(input(), { signal: new AbortController().signal })).rejects.toMatchObject({ code: "QWEN_INVALID_RESPONSE" });
  });

  it("does not post when image reading is aborted", async () => {
    const controller = new AbortController();
    const client = new Client(response("terminate", { status: "failure" }));
    const adapter = new QwenGuiPlusAdapter({ apiKey: "key", assetReader: { async read() { controller.abort(); return new Uint8Array([1]); } }, httpClient: client });
    await expect(adapter.generate(input(), { signal: controller.signal })).rejects.toBeDefined();
    expect(client.body).toBeUndefined();
  });
});

describe("Qwen3.8-Flash provider adapter", () => {
  it("uses the canonical per-tool schema and maps normalized coordinates", async () => {
    const client = new Client({
      choices: [{ finish_reason: "tool_calls", message: { content: "", reasoning_content: "locate the target", tool_calls: [{ id: "q38-call-1", type: "function", function: { name: "click", arguments: JSON.stringify({ x: 400, y: 500 }) } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    });
    const adapter = new Qwen38FlashAdapter({ apiKey: "key", assetReader: reader, httpClient: client, thinking: "low" });
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
    const adapter = new Qwen38FlashAdapter({ apiKey: "key", assetReader: reader, httpClient: firstClient, thinking: "low" });
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
    const secondClient = new Client({ choices: [{ finish_reason: "stop", message: { content: "done" } }] });
    const secondAdapter = new Qwen38FlashAdapter({ apiKey: "key", assetReader: reader, httpClient: secondClient, thinking: "low" });
    await secondAdapter.generate(historyInput, { signal: new AbortController().signal });
    const messages = secondClient.body?.messages as Array<Record<string, unknown>>;
    const assistant = messages.find((message) => message.role === "assistant");
    expect(assistant?.reasoning_content).toBe("step one");
    expect(assistant?.tool_calls).toEqual([{ id: "q38-call-1", type: "function", function: { name: "click", arguments: JSON.stringify({ x: 10, y: 20 }) } }]);
    expect(messages.find((message) => message.role === "tool")).toMatchObject({ tool_call_id: "q38-call-1" });
  });

  it("keeps actual-pixel coordinates in the physical viewport and rejects out-of-range values", async () => {
    const client = new Client({ choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "q38-pixel", type: "function", function: { name: "click", arguments: JSON.stringify({ x: 799, y: 599 }) } }] } }] });
    const adapter = new Qwen38FlashAdapter({ apiKey: "key", assetReader: reader, httpClient: client, thinking: "disabled", coordinateMode: "actual_pixels" });
    await expect(adapter.generate(input(), { signal: new AbortController().signal })).resolves.toMatchObject({ calls: [{ name: "click", arguments: { x: 799, y: 599 } }] });
    const tools = client.body?.tools as Array<{ function: { name: string; parameters: Record<string, unknown> } }>;
    expect(tools[0]).toMatchObject({ function: { name: "click", parameters: { properties: { x: { maximum: 799 }, y: { maximum: 599 } } } } });
    const bad = new Client({ choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "q38-bad", type: "function", function: { name: "click", arguments: JSON.stringify({ x: 800, y: 599 }) } }] } }] });
    await expect(new Qwen38FlashAdapter({ apiKey: "key", assetReader: reader, httpClient: bad, thinking: "disabled", coordinateMode: "actual_pixels" }).generate(input(), { signal: new AbortController().signal })).rejects.toMatchObject({ code: "QWEN_COORDINATE_OUT_OF_RANGE" });
  });

  it("maps normalized boundary coordinates to the last physical pixel", async () => {
    const client = new Client({ choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "q38-edge", type: "function", function: { name: "click", arguments: JSON.stringify({ x: 1000, y: 1000 }) } }] } }] });
    await expect(new Qwen38FlashAdapter({ apiKey: "key", assetReader: reader, httpClient: client, thinking: "disabled", coordinateMode: "normalized_1000" }).generate(input(), { signal: new AbortController().signal })).resolves.toMatchObject({ calls: [{ arguments: { x: 799, y: 599 } }] });
    const onePixelViewport: ModelInput = {
      ...input(),
      messages: [{ role: "user", content: [{ type: "image", asset, viewport: { width: 1, height: 1, coordinateSpace: "physical" } }] }],
    };
    const onePixelClient = new Client({ choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "q38-one", type: "function", function: { name: "click", arguments: JSON.stringify({ x: 1000, y: 1000 }) } }] } }] });
    await expect(new Qwen38FlashAdapter({ apiKey: "key", assetReader: reader, httpClient: onePixelClient, thinking: "disabled", coordinateMode: "normalized_1000" }).generate(onePixelViewport, { signal: new AbortController().signal })).resolves.toMatchObject({ calls: [{ arguments: { x: 0, y: 0 } }] });
  });

  it("maps actual coordinates from a resized presented image back to the Observation viewport", async () => {
    const client = new Client({ choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "q38-resized", type: "function", function: { name: "click", arguments: JSON.stringify({ x: 399, y: 299 }) } }] } }] });
    const adapter = new Qwen38FlashAdapter({
      apiKey: "key",
      assetReader: reader,
      httpClient: client,
      thinking: "disabled",
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
      await new Qwen38FlashAdapter({ apiKey: "key", assetReader: reader, httpClient: client, thinking }).generate(input(), { signal: new AbortController().signal });
      expect(client.body?.reasoning_effort).toBe(thinking);
      expect(client.body?.preserve_thinking).toBe(true);
      expect(client.body?.enable_thinking).toBeUndefined();
    }
  });

  it("accepts multiple independent native calls but rejects mixed control calls", async () => {
    const calls = ["click", "type"].map((name, index) => ({ id: `q38-call-${index + 1}`, type: "function", function: { name, arguments: JSON.stringify(name === "click" ? { x: 1, y: 2 } : { text: "hello" }) } }));
    const client = new Client({ choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: calls } }] });
    const adapter = new Qwen38FlashAdapter({ apiKey: "key", assetReader: reader, httpClient: client, thinking: "disabled" });
    await expect(adapter.generate(input(), { signal: new AbortController().signal })).resolves.toMatchObject({ type: "tool_calls", calls: [{ id: "q38-call-1" }, { id: "q38-call-2" }] });
    expect(client.body?.enable_thinking).toBe(false);
    expect(client.body?.preserve_thinking).toBe(false);
    const mixed = new Client({ choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [...calls, { id: "q38-control", type: "function", function: { name: "terminate", arguments: JSON.stringify({ status: "success" }) } }] } }] });
    await expect(new Qwen38FlashAdapter({ apiKey: "key", assetReader: reader, httpClient: mixed, thinking: "disabled" }).generate(input(), { signal: new AbortController().signal })).rejects.toMatchObject({ code: "QWEN_INVALID_TOOL_CALL" });
  });
});
