import { describe, expect, it, vi } from "vitest";
import type { AssetId, ToolCallId, Viewport } from "@computer-harness/protocol";
import type { AssetReader, ModelInput } from "@computer-harness/runtime";
import { FetchGlmHttpClient, GlmAdapter, type GlmHttpClient, type GlmProfile } from "./index.js";

const viewport: Viewport = { width: 800, height: 600, coordinateSpace: "physical" };
const asset = { assetId: "asset-1" as AssetId, relativePath: "screenshots/asset-1.png", mediaType: "image/png", byteLength: 3 };
const normalizedProfile: GlmProfile = { name: "test-normalized", thinking: "disabled", coordinateMode: "normalized_1000" };

class Reader implements AssetReader {
  public async read(_ref: typeof asset, signal: AbortSignal): Promise<Uint8Array> {
    signal.throwIfAborted();
    return new Uint8Array([1, 2, 3]);
  }
}

class Client implements GlmHttpClient {
  public body: Record<string, unknown> | undefined;
  public constructor(private readonly response: unknown) {}
  public async post(_url: string, body: Record<string, unknown>, _headers: Readonly<Record<string, string>>, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    this.body = body;
    return this.response;
  }
}

function input(): ModelInput {
  return {
    system: "system",
    messages: [{ role: "user", content: [
      { type: "text", text: "click" },
      { type: "image", asset, viewport },
    ] }],
    tools: [{ name: "click", description: "click", category: "computer", coordinate: { fields: ["x", "y"] }, inputSchema: { type: "object" } }],
  };
}

function inputWithoutImage(): ModelInput {
  return {
    system: "system",
    messages: [{ role: "user", content: [{ type: "text", text: "click" }] }],
    tools: [{ name: "click", description: "click", category: "computer", coordinate: { fields: ["x", "y"] }, inputSchema: { type: "object" } }],
  };
}

function inputWithControls(): ModelInput {
  return {
    ...input(),
    tools: [
      ...input().tools,
      { name: "terminate", description: "finish", category: "control", control: "finish", inputSchema: { type: "object" } },
      { name: "interact", description: "ask", category: "control", control: "user_input_required", inputSchema: { type: "object" } },
    ],
  };
}

describe("GLM provider adapter", () => {
  it("reads images, sends canonical tools, and maps normalized coordinates", async () => {
    const client = new Client({ choices: [{ message: { content: "", tool_calls: [{ id: "glm-call", type: "function", function: { name: "click", arguments: JSON.stringify({ x: 500, y: 250 }) } }] } }] });
    const adapter = new GlmAdapter({ apiKey: "key", profile: normalizedProfile, assetReader: new Reader(), httpClient: client });
    const turn = await adapter.generate(input(), { signal: new AbortController().signal });
    expect(turn).toEqual({ type: "tool_calls", calls: [{ id: "glm-call", name: "click", arguments: { x: 400, y: 150 } }] });
    expect(client.body?.tools).toEqual([{ type: "function", function: { name: "click", description: "click Coordinates x,y are normalized numbers from 0 to 1000.", parameters: { type: "object" } } }]);
    expect(client.body?.thinking).toEqual({ type: "disabled" });
    const messages = client.body?.messages as Array<Record<string, unknown>>;
    const userContent = messages[1]?.content as Array<Record<string, unknown>>;
    const imageBlock = userContent[1];
    expect((imageBlock?.image_url as { url?: string } | undefined)?.url).toMatch(/^data:image\/png;base64,/);
    expect(String((messages[0] as Record<string, unknown> | undefined)?.content)).toContain("normalized to 0..1000");
    expect(String((messages[0] as Record<string, unknown> | undefined)?.content)).not.toContain("Coordinates are pixels in the current image viewport");
  });

  it("rejects malformed, duplicate, and out-of-range provider output", async () => {
    const duplicate = new Client({ choices: [{ message: { tool_calls: [
      { id: "same", function: { name: "click", arguments: "{\"x\":1,\"y\":1}" } },
      { id: "same", function: { name: "click", arguments: "{\"x\":2,\"y\":2}" } },
    ] } }] });
    const adapter = new GlmAdapter({ apiKey: "key", profile: normalizedProfile, assetReader: new Reader(), httpClient: duplicate });
    await expect(adapter.generate(input(), { signal: new AbortController().signal })).rejects.toMatchObject({ code: "GLM_DUPLICATE_TOOL_CALL", retryable: true });
    const outOfRange = new Client({ choices: [{ message: { tool_calls: [{ id: "bad", function: { name: "click", arguments: "{\"x\":1001,\"y\":1}" } }] } }] });
    const second = new GlmAdapter({ apiKey: "key", profile: normalizedProfile, assetReader: new Reader(), httpClient: outOfRange });
    await expect(second.generate(input(), { signal: new AbortController().signal })).rejects.toThrow(/outside/);
  });

  it("rejects a function that was not offered in this run", async () => {
    const client = new Client({ choices: [{ message: { tool_calls: [{ id: "unknown", function: { name: "drag", arguments: "{}" } }] } }] });
    const adapter = new GlmAdapter({ apiKey: "key", profile: normalizedProfile, assetReader: new Reader(), httpClient: client });
    await expect(adapter.generate(input(), { signal: new AbortController().signal })).rejects.toMatchObject({ code: "GLM_UNAVAILABLE_TOOL" });
  });

  it("returns non-empty text as finish and honors abort before reading", async () => {
    const client = new Client({ choices: [{ message: { content: "finished" } }], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } });
    const adapter = new GlmAdapter({ apiKey: "key", profile: "glm-5.3-flash", assetReader: new Reader(), httpClient: client });
    expect(await adapter.generate(input(), { signal: new AbortController().signal })).toEqual({ type: "finish", summary: "finished", usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9 } });
    expect(client.body?.thinking).toEqual({ type: "enabled" });
    const messages = client.body?.messages as Array<Record<string, unknown>>;
    expect(String((messages[0] as Record<string, unknown> | undefined)?.content)).toContain("Coordinates are pixels");
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(adapter.generate(input(), { signal: controller.signal })).rejects.toThrow("cancelled");
  });

  it("maps control definitions from the shared tool projection", async () => {
    const client = new Client({ choices: [{ message: { tool_calls: [{ id: "finish-call", function: { name: "terminate", arguments: JSON.stringify({ status: "success", text: "done" }) } }] } }] });
    const adapter = new GlmAdapter({ apiKey: "key", profile: "glm-5.3-flash", assetReader: new Reader(), httpClient: client });
    await expect(adapter.generate(inputWithControls(), { signal: new AbortController().signal })).resolves.toMatchObject({ type: "finish", reportedStatus: "success", summary: "done" });
    expect((client.body?.tools as Array<Record<string, unknown>>).map((item) => (item.function as Record<string, unknown>).name)).toContain("terminate");
  });

  it("adds actual-pixel bounds to the Function Schema when a viewport is available", async () => {
    const client = new Client({ choices: [{ message: { tool_calls: [{ id: "pixel-call", function: { name: "click", arguments: "{\"x\":799,\"y\":599}" } }] } }] });
    const profile: GlmProfile = { name: "test-pixels", thinking: "disabled", coordinateMode: "actual_pixels" };
    const adapter = new GlmAdapter({ apiKey: "key", profile, assetReader: new Reader(), httpClient: client });
    const pixelInput: ModelInput = { ...input(), tools: [{ name: "click", description: "click", category: "computer", coordinate: { fields: ["x", "y"] }, inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"], additionalProperties: false } }] };
    await expect(adapter.generate(pixelInput, { signal: new AbortController().signal })).resolves.toMatchObject({ calls: [{ arguments: { x: 799, y: 599 } }] });
    expect(client.body?.tools).toMatchObject([{ function: { parameters: { properties: { x: { minimum: 0, maximum: 799 }, y: { minimum: 0, maximum: 599 } } } } }]);
  });

  it("does not pass normalized pixel coordinates through without an image viewport", async () => {
    const client = new Client({ choices: [{ message: { tool_calls: [{ id: "no-viewport", function: { name: "click", arguments: "{\"x\":500,\"y\":250}" } }] } }] });
    const adapter = new GlmAdapter({ apiKey: "key", profile: normalizedProfile, assetReader: new Reader(), httpClient: client });
    await expect(adapter.generate(inputWithoutImage(), { signal: new AbortController().signal })).rejects.toThrow(/image viewport/);
  });

  it("does not treat a truncated response as a normal finish", async () => {
    const client = new Client({ choices: [{ message: { content: "partial" }, finish_reason: "length" }] });
    const adapter = new GlmAdapter({ apiKey: "key", profile: "glm-5.3-flash", assetReader: new Reader(), httpClient: client });
    await expect(adapter.generate(input(), { signal: new AbortController().signal })).rejects.toMatchObject({ code: "GLM_INCOMPLETE_RESPONSE" });
  });

  it("encodes canonical pixel history back into the GLM profile coordinate space", async () => {
    const client = new Client({ choices: [{ message: { content: "done" } }] });
    const call = { id: "history-call" as ToolCallId, name: "click", arguments: { x: 400, y: 150 } };
    const history: ModelInput = {
      ...input(),
      messages: [
        ...input().messages,
        { role: "assistant", content: [{ type: "tool_call", call, viewport }] },
        { role: "tool", content: [{ type: "tool_result", result: { callId: call.id, status: "completed", output: { ok: true } } }] },
      ],
    };
    const adapter = new GlmAdapter({ apiKey: "key", profile: normalizedProfile, assetReader: new Reader(), httpClient: client });
    await adapter.generate(history, { signal: new AbortController().signal });
    const messages = client.body?.messages as Array<Record<string, unknown>>;
    const assistant = messages.find((message) => message.role === "assistant" && message.tool_calls !== undefined);
    const toolCall = (assistant?.tool_calls as Array<Record<string, unknown>> | undefined)?.[0];
    expect(JSON.parse(String((toolCall?.function as Record<string, unknown> | undefined)?.arguments))).toEqual({ x: 500, y: 250 });
    expect(messages.some((message) => message.role === "tool" && message.tool_call_id === call.id)).toBe(true);
  });

  it("preserves reasoning_content through a two-round tool continuation", async () => {
    const firstClient = new Client({
      choices: [{ message: {
        reasoning_content: "reason about the current frame",
        tool_calls: [{ id: "reasoning-call", function: { name: "click", arguments: JSON.stringify({ x: 400, y: 300 }) } }],
      } }],
    });
    const firstAdapter = new GlmAdapter({ apiKey: "key", profile: "glm-5.3-flash", assetReader: new Reader(), httpClient: firstClient });
    const first = await firstAdapter.generate(input(), { signal: new AbortController().signal });
    expect(first).toMatchObject({
      type: "tool_calls",
      continuation: { providerId: "glm-5.3-flash", kind: "reasoning_content", content: "reason about the current frame" },
    });
    if (first.type !== "tool_calls" || first.continuation === undefined) throw new Error("fixture did not produce a continuation");
    const call = first.calls[0];
    if (call === undefined) throw new Error("fixture did not produce a ToolCall");
    const secondClient = new Client({ choices: [{ message: { content: "done" } }] });
    const secondAdapter = new GlmAdapter({ apiKey: "key", profile: "glm-5.3-flash", assetReader: new Reader(), httpClient: secondClient });
    await secondAdapter.generate({
      ...input(),
      messages: [
        ...input().messages,
        { role: "assistant", content: [
          { type: "provider_continuation", continuation: first.continuation },
          { type: "tool_call", call, viewport },
        ] },
        { role: "tool", content: [{ type: "tool_result", result: { callId: call.id, status: "completed", output: { ok: true } } }] },
      ],
    }, { signal: new AbortController().signal });
    const messages = secondClient.body?.messages as Array<Record<string, unknown>>;
    const assistant = messages.find((message) => message.role === "assistant" && message.tool_calls !== undefined);
    expect(assistant?.reasoning_content).toBe("reason about the current frame");
    expect((assistant?.tool_calls as Array<Record<string, unknown>> | undefined)?.[0]).toMatchObject({ id: "reasoning-call" });
  });

  it("classifies the provider's 1305 overload response as retryable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: { code: "1305" } }),
    })));
    try {
      const adapter = new GlmAdapter({ apiKey: "key", profile: normalizedProfile, assetReader: new Reader() });
      await expect(adapter.generate(input(), { signal: new AbortController().signal })).rejects.toMatchObject({
        code: "1305",
        retryable: true,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("preserves a sanitized network cause code for diagnostics", async () => {
    const cause = Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw Object.assign(new TypeError("fetch failed https://user:password@example.test/path?api_key=secret-value Authorization: Bearer synthetic-token-123"), { cause });
    }));
    try {
      const adapter = new GlmAdapter({ apiKey: "key", profile: normalizedProfile, assetReader: new Reader() });
      let caught: unknown;
      try {
        await adapter.generate(input(), { signal: new AbortController().signal });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({
        code: "GLM_NETWORK_ERROR",
        retryable: true,
        message: expect.stringContaining("causeCode=ECONNRESET"),
      });
      const message = caught instanceof Error ? caught.message : String(caught);
      expect(message).toContain("api_key=[redacted]");
      expect(message).toContain("Authorization: [redacted]");
      expect(message).not.toContain("synthetic-token-123");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("applies one deadline to fetch and response-body reading", async () => {
    let observedSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, options: { signal: AbortSignal }) => {
      observedSignal = options.signal;
      return {
        ok: true,
        status: 200,
        json: () => new Promise<never>((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        }),
      };
    }));
    try {
      const adapter = new GlmAdapter({
        apiKey: "key",
        profile: normalizedProfile,
        assetReader: new Reader(),
        httpClient: new FetchGlmHttpClient({ requestTimeoutMs: 10 }),
      });
      await expect(adapter.generate(input(), { signal: new AbortController().signal })).rejects.toMatchObject({
        code: "GLM_REQUEST_TIMEOUT",
        retryable: true,
        retryMode: "same_input",
      });
      expect(observedSignal?.aborted).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("preserves user cancellation instead of classifying it as a retryable timeout", async () => {
    let observedSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, options: { signal: AbortSignal }) => {
      observedSignal = options.signal;
      if (options.signal.aborted) return Promise.reject(options.signal.reason);
      return new Promise<never>((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    }));
    try {
      const controller = new AbortController();
      const adapter = new GlmAdapter({
        apiKey: "key",
        profile: normalizedProfile,
        assetReader: new Reader(),
        httpClient: new FetchGlmHttpClient({ requestTimeoutMs: 1_000 }),
      });
      const request = adapter.generate(input(), { signal: controller.signal });
      controller.abort(new Error("user cancelled"));
      await expect(request).rejects.toThrow("user cancelled");
      expect(observedSignal?.aborted).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
