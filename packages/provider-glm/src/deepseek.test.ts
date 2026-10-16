import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssetId, ToolCallId, Viewport } from "@computer-harness/protocol";
import { decorateToolsWithActionEffects, type ModelInput } from "@computer-harness/runtime";
import { DeepseekFlashAdapter, DeepseekProviderError, FetchDeepseekHttpClient, type DeepseekHttpClient, type DeepseekTransportEvidence } from "./index.js";

const viewport: Viewport = { width: 800, height: 600, coordinateSpace: "physical" };
const asset = { assetId: "image" as AssetId, relativePath: "screenshots/image.png", mediaType: "image/png", byteLength: 3 };
const reader = { async read() { return new Uint8Array([1, 2, 3]); } };
const signal = new AbortController().signal;

function input(): ModelInput {
  return {
    system: "Follow the shared Context contract.",
    messages: [{ role: "user", content: [{ type: "image", asset, viewport }] }],
    tools: [{ name: "click", description: "Click", category: "computer", coordinate: { fields: ["x", "y"] }, inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } } } }],
  };
}

function response(name: string, args: unknown, finishReason = "tool_calls"): unknown {
  return { model: "deepseek-flash", choices: [{ finish_reason: finishReason, message: { role: "assistant", content: null, tool_calls: [{ id: "call", type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] };
}

class Client implements DeepseekHttpClient {
  public requests: Array<{ url: string; body: Record<string, unknown>; headers: Readonly<Record<string, string>> }> = [];
  public constructor(private readonly value: unknown) {}
  public async post(url: string, body: Record<string, unknown>, headers: Readonly<Record<string, string>>): Promise<unknown> {
    this.requests.push({ url, body, headers });
    return this.value;
  }
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("official DeepSeek flash boundary", () => {
  it("sends official multimodal native tools with non-thinking actual pixels", async () => {
    const client = new Client(response("click", { x: 400, y: 150 }));
    const adapter = new DeepseekFlashAdapter({ apiKey: "fixture-key", assetReader: reader, httpClient: client });
    expect(adapter.id).toBe("deepseek-flash");
    await expect(adapter.generate(input(), { signal })).resolves.toEqual({ type: "tool_calls", calls: [{ id: "call", name: "click", arguments: { x: 400, y: 150 } }] });
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]).toMatchObject({
      url: "https://api.deepseek.com/chat/completions",
      headers: { Authorization: "Bearer fixture-key" },
      body: {
        model: "deepseek-flash", stream: false, thinking: { type: "disabled" }, max_tokens: 4096,
        messages: [{ role: "system", content: expect.stringContaining("DeepSeek GUI contract") }, { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AQID" } }] }],
        tools: [{ type: "function", function: { name: "click", parameters: { properties: { x: { maximum: 799 }, y: { maximum: 599 }, observationAssessment: { type: "object" } } } } }],
      },
    });
    expect(client.requests[0]?.body).not.toHaveProperty("reasoning_effort");
  });

  it.each(["https://api.deepseek.com", "https://api.deepseek.com/", "https://api.deepseek.com/chat/completions/"])("normalizes endpoint %s without changing the model", async (endpoint) => {
    const client = new Client(response("click", { x: 2, y: 3 }));
    await new DeepseekFlashAdapter({ apiKey: "fixture", assetReader: reader, httpClient: client, endpoint, maxOutputTokens: 123 }).generate(input(), { signal });
    expect(client.requests[0]).toMatchObject({ url: "https://api.deepseek.com/chat/completions", body: { model: "deepseek-flash", max_tokens: 123 } });
  });

  it.each(["assistant", "tool"] as const)("refuses image content in %s history before dispatch", async (role) => {
    const client = new Client(response("click", {}));
    const adapter = new DeepseekFlashAdapter({ apiKey: "fixture", assetReader: reader, httpClient: client });
    await expect(adapter.generate({ ...input(), messages: [{ role, content: [{ type: "image", asset, viewport }] }] }, { signal })).rejects.toMatchObject({ name: "DeepseekProviderError", code: "DEEPSEEK_INVALID_HISTORY", retryable: false });
    expect(client.requests).toHaveLength(0);
  });

  it("replays native tool history and results, but never disabled reasoning", async () => {
    const call = { id: "previous" as ToolCallId, name: "click", arguments: { x: 400, y: 150 } };
    const client = new Client(response("click", { x: 50, y: 60 }));
    const modelInput: ModelInput = { ...input(), messages: [
      ...input().messages,
      { role: "assistant", content: [{ type: "text", text: "Clicked." }, { type: "provider_continuation", continuation: { providerId: "deepseek-flash", kind: "reasoning_content", content: "private reasoning" } }, { type: "tool_call", call, viewport }] },
      { role: "tool", content: [{ type: "tool_result", result: { callId: call.id, status: "completed", output: { ok: true } } }] },
    ] };
    await new DeepseekFlashAdapter({ apiKey: "fixture", assetReader: reader, httpClient: client }).generate(modelInput, { signal });
    const messages = client.requests[0]?.body.messages as Array<Record<string, unknown>>;
    expect(messages[2]).toEqual({ role: "assistant", content: "Clicked.", tool_calls: [{ id: "previous", type: "function", function: { name: "click", arguments: JSON.stringify({ x: 400, y: 150 }) } }] });
    expect(messages[3]).toEqual({ role: "tool", tool_call_id: "previous", content: JSON.stringify({ callId: "previous", status: "completed", output: { ok: true } }) });
    expect(JSON.stringify(messages)).not.toContain("private reasoning");
  });

  it("preserves shared action-effect and observation-assessment semantics", async () => {
    const assessment = { observationId: "obs-current", actionId: "action-previous", actionOutcome: "expected_change", evidence: "The panel is visible." };
    const effect = { effects: ["financial"], target: "Confirm payment", summary: "Pay for the order" };
    const guarded: ModelInput = { ...input(), tools: decorateToolsWithActionEffects(input().tools) };
    const client = new Client(response("click", { x: 400, y: 150, _harnessEffect: effect, observationAssessment: assessment }));
    await expect(new DeepseekFlashAdapter({ apiKey: "fixture", assetReader: reader, httpClient: client }).generate(guarded, { signal })).resolves.toMatchObject({ type: "tool_calls", calls: [{ arguments: { x: 400, y: 150 }, declaredEffect: effect }], observationAssessment: assessment });
  });

  it("uses explicit terminate results and maps prompt cache hits without treating misses as writes", async () => {
    const resultEvidence = { version: "source-linked-finish-v1", fields: [{ fieldId: "cpu", disposition: "unknown", reason: "not_observed" }] };
    const value = response("terminate", { status: "failure", text: "The requested source could not be opened.", resultEvidence }) as Record<string, unknown>;
    value.usage = { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30, prompt_cache_hit_tokens: 15, prompt_cache_miss_tokens: 5 };
    const client = new Client(value);
    const controls: ModelInput = { ...input(), tools: [{ name: "terminate", description: "Finish", category: "control", control: "finish", inputSchema: { type: "object" } }] };
    await expect(new DeepseekFlashAdapter({ apiKey: "fixture", assetReader: reader, httpClient: client }).generate(controls, { signal })).resolves.toEqual({ type: "finish", reportedStatus: "failure", summary: "The requested source could not be opened.", resultEvidence, usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30, cacheReadTokens: 15 } });
  });

  it.each([
    ["unavailable tool", "DEEPSEEK_UNAVAILABLE_TOOL", {
      choices: [{ finish_reason: "tool_calls", message: { role: "assistant", tool_calls: [
        { id: "valid-click", type: "function", function: { name: "click", arguments: JSON.stringify({ x: 1, y: 2 }) } },
        { id: "unknown-call", type: "function", function: { name: "private-unoffered-tool", arguments: JSON.stringify({ secret: "private-payload" }) } },
      ] } }],
    }],
    ["invalid tool call", "DEEPSEEK_INVALID_TOOL_CALL", {
      choices: [{ finish_reason: "tool_calls", message: { role: "assistant", tool_calls: [{ id: "bad-args", type: "function", function: { name: "click", arguments: "private-payload-not-json" } }] } }],
    }],
    ["duplicate tool call", "DEEPSEEK_DUPLICATE_TOOL_CALL", {
      choices: [{ finish_reason: "tool_calls", message: { role: "assistant", tool_calls: [
        { id: "duplicate-id", type: "function", function: { name: "click", arguments: JSON.stringify({ x: 1, y: 2 }) } },
        { id: "duplicate-id", type: "function", function: { name: "click", arguments: JSON.stringify({ x: 3, y: 4 }) } },
      ] } }],
    }],
    ["empty response", "DEEPSEEK_EMPTY_RESPONSE", { choices: [{ finish_reason: "stop", message: { role: "assistant", content: null } }] }],
    ["invalid parsed response", "DEEPSEEK_INVALID_RESPONSE", { choices: [] }],
  ] as const)("allows finite feedback for a complete response with %s", async (_label, code, value) => {
    const adapter = new DeepseekFlashAdapter({ apiKey: "fixture", assetReader: reader, httpClient: new Client(value) });
    await expect(adapter.generate(input(), { signal })).rejects.toMatchObject({
      name: "DeepseekProviderError",
      code,
      retryable: true,
      retryMode: "feedback",
    });
  });

  it("only permits parsed response feedback after a complete successful JSON response", async () => {
    const cases = [
      { label: "HTTP 200 parsed shape error", ok: true, status: 200, retryable: true, retryMode: "feedback", code: "DEEPSEEK_INVALID_RESPONSE" },
      { label: "HTTP 500 response", ok: false, status: 500, retryable: true, retryMode: "same_input", code: "DEEPSEEK_HTTP_500" },
    ] as const;
    for (const item of cases) {
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: item.ok, status: item.status, json: async () => ({ choices: [] }) })));
      const adapter = new DeepseekFlashAdapter({ apiKey: "fixture", assetReader: reader });
      await expect(adapter.generate(input(), { signal })).rejects.toMatchObject({ code: item.code, retryable: item.retryable, retryMode: item.retryMode });
    }
  });

  it.each(["length", "content_filter", "insufficient_system_resource"])("does not execute truncated or interrupted %s tool decisions", async (finishReason) => {
    const client = new Client(response("click", { x: 400, y: 150 }, finishReason));
    await expect(new DeepseekFlashAdapter({ apiKey: "fixture", assetReader: reader, httpClient: client }).generate(input(), { signal })).rejects.toMatchObject({ name: "DeepseekProviderError", code: "DEEPSEEK_INCOMPLETE_RESPONSE", retryable: false });
    expect(client.requests).toHaveLength(1);
  });

  it("refuses plain text completion when explicit finish is offered", async () => {
    const client = new Client({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Done" } }] });
    await expect(new DeepseekFlashAdapter({ apiKey: "fixture", assetReader: reader, httpClient: client }).generate({ ...input(), tools: [{ name: "terminate", description: "Finish", category: "control", control: "finish" }] }, { signal })).rejects.toMatchObject({ code: "DEEPSEEK_INVALID_TOOL_CALL", retryable: true, retryMode: "feedback" });
  });

  it("keeps malformed argument payloads out of errors", async () => {
    const client = new Client({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", tool_calls: [{ id: "call", type: "function", function: { name: "click", arguments: "private-payload-not-json" } }] } }] });
    try {
      await new DeepseekFlashAdapter({ apiKey: "fixture", assetReader: reader, httpClient: client }).generate(input(), { signal });
      throw new Error("Expected provider failure");
    } catch (error) {
      expect(error).toBeInstanceOf(DeepseekProviderError);
      expect(error).toMatchObject({ code: "DEEPSEEK_INVALID_TOOL_CALL", retryable: true, retryMode: "feedback" });
      expect(String(error)).not.toContain("private-payload");
      expect(String(error)).not.toContain("GLM");
    }
  });

  it("does not accept another adapter's prepared request or dispatch after cancellation", async () => {
    const client = new Client(response("click", { x: 1, y: 2 }));
    const first = new DeepseekFlashAdapter({ apiKey: "fixture", assetReader: reader, httpClient: client });
    const second = new DeepseekFlashAdapter({ apiKey: "fixture", assetReader: reader, httpClient: client });
    const prepared = await first.prepare(input(), { signal });
    await expect(second.generatePrepared(prepared, { signal })).rejects.toMatchObject({ code: "DEEPSEEK_INVALID_PREPARED_REQUEST" });
    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);
    await expect(first.generatePrepared(prepared, { signal: controller.signal })).rejects.toBe(reason);
    expect(client.requests).toHaveLength(0);
  });

  it("preserves every tool result in a batched result message", async () => {
    const client = new Client(response("click", { x: 1, y: 2 }));
    const modelInput: ModelInput = { ...input(), messages: [
      ...input().messages,
      { role: "assistant", content: [
        { type: "tool_call", call: { id: "first" as ToolCallId, name: "click", arguments: { x: 1, y: 2 } }, viewport },
        { type: "tool_call", call: { id: "second" as ToolCallId, name: "click", arguments: { x: 3, y: 4 } }, viewport },
      ] },
      { role: "tool", content: [
        { type: "tool_result", result: { callId: "first" as ToolCallId, status: "completed", output: { ok: true } } },
        { type: "tool_result", result: { callId: "second" as ToolCallId, status: "failed", error: { code: "REFUSED", message: "Not permitted" } } },
      ] },
    ] };
    await new DeepseekFlashAdapter({ apiKey: "fixture", assetReader: reader, httpClient: client }).generate(modelInput, { signal });
    const messages = client.requests[0]?.body.messages as Array<Record<string, unknown>>;
    expect(messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id)).toEqual(["first", "second"]);
    expect(messages[2]?.content).toBeNull();
  });
});

describe("DeepSeek transport deadlines and privacy", () => {
  it.each(["headers", "body"])("settles non-cooperative %s at the request deadline without retry", async (phase) => {
    // The transport checks performance.now() as well as its setTimeout. Vitest's
    // default fake timer set omits performance, so include it to keep the
    // request deadline on one deterministic clock.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate", "Date", "performance"] });
    const never = new Promise<never>(() => {});
    let resolveFetchEntered!: () => void;
    let resolveBodyEntered!: () => void;
    const fetchEntered = new Promise<void>((resolve) => { resolveFetchEntered = resolve; });
    const bodyEntered = new Promise<void>((resolve) => { resolveBodyEntered = resolve; });
    const fetchStub = vi.fn(async () => {
      resolveFetchEntered();
      return phase === "headers"
        ? never
        : {
            ok: true,
            status: 200,
            json: () => {
              resolveBodyEntered();
              return never;
            },
          };
    });
    vi.stubGlobal("fetch", fetchStub);
    const evidence: DeepseekTransportEvidence[] = [];
    const pending = new FetchDeepseekHttpClient({ requestTimeoutMs: 10 }).post("https://fixture.invalid", {}, {}, signal, { payloadHash: "fixture", onTransportEvidence: (item) => evidence.push(item) });
    const rejected = expect(pending).rejects.toMatchObject({ name: "DeepseekProviderError", code: "DEEPSEEK_REQUEST_TIMEOUT", retryable: false, retryMode: "feedback" });
    await fetchEntered;
    expect(fetchStub).toHaveBeenCalledTimes(1);
    if (phase === "body") {
      await bodyEntered;
      expect(evidence).toContainEqual(expect.objectContaining({ stage: "headers_received", phase: "reading_body" }));
    } else {
      expect(evidence).toContainEqual(expect.objectContaining({ stage: "fetch_invoked", phase: "awaiting_headers" }));
    }
    await vi.advanceTimersByTimeAsync(11);
    await rejected;
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(evidence.at(-1)).toMatchObject({ outcome: "timeout", abortSource: "local_request_timeout", phase: phase === "headers" ? "awaiting_headers" : "reading_body" });
  });

  it("preserves Run cancellation reason even if fetch ignores its signal", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<never>(() => {})));
    const controller = new AbortController();
    const reason = new Error("Run cancelled");
    const pending = new FetchDeepseekHttpClient().post("https://fixture.invalid", {}, {}, controller.signal);
    const rejected = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    await rejected;
  });

  it("never exposes provider HTTP payloads, endpoint credentials, or network messages", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 429, json: async () => ({ error: { code: "private-code", message: "private response fixture-key" } }) })));
    await expect(new FetchDeepseekHttpClient().post("https://fixture.invalid", {}, {}, signal)).rejects.toMatchObject({ message: "DeepSeek HTTP 429", code: "DEEPSEEK_HTTP_429", retryable: true, retryMode: "same_input" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("secret URL https://fixture.invalid?token=fixture-key"); }));
    await expect(new FetchDeepseekHttpClient().post("https://fixture.invalid", {}, {}, signal)).rejects.toMatchObject({ message: "DeepSeek network request failed", code: "DEEPSEEK_NETWORK_ERROR", retryable: true, retryMode: "same_input" });
  });

  it.each([
    [400, false],
    [401, false],
    [429, true],
    [500, true],
    [503, true],
    [599, true],
  ] as const)("classifies HTTP %s with retryable=%s", async (status, retryable) => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status, json: async () => ({ error: { message: "private provider body" } }) })));
    await expect(new FetchDeepseekHttpClient().post("https://fixture.invalid", {}, {}, signal)).rejects.toMatchObject({
      code: `DEEPSEEK_HTTP_${status}`,
      retryable,
      retryMode: retryable ? "same_input" : "feedback",
    });
  });

  it("treats a response-body connection interruption as same-input transport retry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new TypeError("private socket reset details"); } })));
    await expect(new FetchDeepseekHttpClient().post("https://fixture.invalid", {}, {}, signal)).rejects.toMatchObject({
      message: "DeepSeek response body could not be read",
      code: "DEEPSEEK_NETWORK_ERROR",
      retryable: true,
      retryMode: "same_input",
    });
  });

  it.each([401, 200])("classifies unreadable JSON at HTTP %s without exposing its parse message", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: status === 200, status, json: async () => { throw new SyntaxError("private response payload"); } })));
    await expect(new FetchDeepseekHttpClient().post("https://fixture.invalid", {}, {}, signal)).rejects.toMatchObject({
      code: status === 200 ? "DEEPSEEK_INVALID_RESPONSE" : "DEEPSEEK_HTTP_401",
      message: status === 200 ? "DeepSeek response body is not valid JSON" : "DeepSeek HTTP 401",
      retryable: false,
    });
  });
});
