import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GlmHttpClient } from "@computer-harness/provider-glm";
import type { QwenHttpClient } from "@computer-harness/provider-qwen";
import { RecordingGlmHttpClient, RecordingQwenHttpClient } from "./recording-clients.js";

interface ForwardedRequest {
  url: string;
  body: Record<string, unknown>;
  headers: Readonly<Record<string, string>>;
  signal: AbortSignal;
}

class FakeGlmHttpClient implements GlmHttpClient {
  public calls = 0;
  public requests: ForwardedRequest[] = [];

  public constructor(private readonly response: unknown, private readonly failure?: unknown) {}

  public post(url: string, body: Record<string, unknown>, headers: Readonly<Record<string, string>>, signal: AbortSignal): Promise<unknown> {
    this.calls += 1;
    this.requests.push({ url, body, headers, signal });
    return this.failure === undefined ? Promise.resolve(this.response) : Promise.reject(this.failure);
  }
}

class FakeQwenHttpClient implements QwenHttpClient {
  public calls = 0;
  public requests: ForwardedRequest[] = [];

  public constructor(private readonly response: unknown, private readonly failure?: unknown) {}

  public post(url: string, body: Record<string, unknown>, headers: Readonly<Record<string, string>>, signal: AbortSignal): Promise<unknown> {
    this.calls += 1;
    this.requests.push({ url, body, headers, signal });
    return this.failure === undefined ? Promise.resolve(this.response) : Promise.reject(this.failure);
  }
}

async function readRecord(path: string): Promise<Record<string, unknown>> {
  const lines = (await readFile(path, "utf8")).trim().split(/\r?\n/);
  return JSON.parse(lines.at(-1)!) as Record<string, unknown>;
}

function expectForwarded(request: ForwardedRequest | undefined, url: string, body: Record<string, unknown>, headers: Readonly<Record<string, string>>, signal: AbortSignal): void {
  expect(request?.url).toBe(url);
  expect(request?.body).toBe(body);
  expect(request?.headers).toBe(headers);
  expect(request?.signal).toBe(signal);
}

describe("recording client diagnostic paths", () => {
  it("writes a safe GLM native multi-call projection through the recorder", async () => {
    const typedText = "typed-private-value";
    const response = {
      model: "glm-5.3-flash",
      choices: [{
        finish_reason: "tool_calls",
        message: {
          content: "",
          tool_calls: [
            { id: "native-1", type: "function", function: { name: "type", arguments: JSON.stringify({ text: typedText, token: "token-secret" }) } },
            { id: "native-2", type: "function", function: { name: "click", arguments: JSON.stringify({ x: 10, y: 20 }) } },
          ],
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_tokens_details: { cached_tokens: 6 }, private_value: "memory-secret" },
    };
    const fake = new FakeGlmHttpClient(response);
    const directory = await mkdtemp(join(tmpdir(), "harness-glm-diagnostic-"));
    const path = join(directory, "provider-exchanges.jsonl");
    const recorder = new RecordingGlmHttpClient(path, fake);
    const body = {
      model: "glm-5.3-flash",
      tools: [{ type: "function", function: { name: "type" } }, { type: "function", function: { name: "click" } }],
      messages: [{ role: "user", content: "private prompt https://example.invalid" }],
    };
    const url = "https://example.invalid/v1/chat?token=url-secret";
    const headers = { Authorization: "Bearer header-secret" };
    const signal = new AbortController().signal;
    await expect(recorder.post(url, body, headers, signal)).resolves.toBe(response);

    const record = await readRecord(path);
    const serialized = JSON.stringify(record);
    expect(fake.calls).toBe(1);
    expectForwarded(fake.requests[0], url, body, headers, signal);
    expect(record).toMatchObject({ provider: "glm", request: 1, requestedModel: "glm-5.3-flash", toolNames: ["type", "click"] });
    expect((record.response as Record<string, unknown>).toolCallCount).toBe(2);
    expect((record.response as Record<string, unknown>).usage).not.toHaveProperty("cachedReadTokens");
    expect((record.response as Record<string, unknown>).usage).toMatchObject({ diagnosticCodes: expect.arrayContaining(["usage_unknown_fields_omitted"]) });
    expect((record.response as Record<string, unknown>).toolCalls).toMatchObject([
      { id: expect.stringMatching(/^sha256:[0-9a-f]{16}$/u), name: "type", arguments: { shape: "object", parse: "valid_json" } },
      { id: expect.stringMatching(/^sha256:[0-9a-f]{16}$/u), name: "click", arguments: { shape: "object", parse: "valid_json" } },
    ]);
    expect(serialized).not.toContain(typedText);
    expect(serialized).not.toContain("token-secret");
    expect(serialized).not.toContain("memory-secret");
    expect(serialized).not.toContain("example.invalid");
    expect(serialized).not.toContain("header-secret");
  });

  it("writes a safe Qwen strict flat multi-call projection through the recorder", async () => {
    const typedText = "flat-private-value";
    const response = {
      model: "qwen3.8-flash",
      choices: [{
        finish_reason: "stop",
        message: {
          content: JSON.stringify({ calls: [
            { id: "flat-1", name: "type", arguments: { text: typedText, path: "C:/private/file.txt" } },
            { id: "flat-2", name: "click", arguments: { x: 10, y: 20 } },
          ] }),
        },
      }],
      usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23, prompt_tokens_details: { cached_tokens: 8 }, url: "https://example.invalid/secret" },
    };
    const fake = new FakeQwenHttpClient(response);
    const directory = await mkdtemp(join(tmpdir(), "harness-qwen-diagnostic-"));
    const path = join(directory, "provider-exchanges.jsonl");
    const recorder = new RecordingQwenHttpClient(path, "normalized_1000", "low", "strict_json", fake);
    const body = {
      model: "qwen3.8-flash",
      response_format: {
        type: "json_schema",
        json_schema: {
          schema: { type: "object", properties: { calls: { type: "array", items: { type: "object", properties: { name: { enum: ["type", "click"] } } } } } },
        },
      },
      messages: [{ role: "user", content: "private memory" }],
    };
    const url = "https://example.invalid/api?key=url-secret";
    const headers = { Authorization: "Bearer header-secret" };
    const signal = new AbortController().signal;
    await expect(recorder.post(url, body, headers, signal)).resolves.toBe(response);

    const record = await readRecord(path);
    const serialized = JSON.stringify(record);
    expect(fake.calls).toBe(1);
    expectForwarded(fake.requests[0], url, body, headers, signal);
    expect(record).toMatchObject({ provider: "qwen", request: 1, requestedModel: "qwen3.8-flash", coordinateMode: "normalized_1000", thinkingMode: "low", outputMode: "strict_json", toolNames: ["type", "click"] });
    expect((record.response as Record<string, unknown>).toolCallCount).toBe(2);
    expect((record.response as Record<string, unknown>).usage).toMatchObject({ cachedReadTokens: 8 });
    expect((record.response as Record<string, unknown>).toolCalls).toMatchObject([
      { id: expect.stringMatching(/^sha256:[0-9a-f]{16}$/u), name: "type", arguments: { shape: "object", keyCount: 2 } },
      { id: expect.stringMatching(/^sha256:[0-9a-f]{16}$/u), name: "click", arguments: { shape: "object", keyCount: 2 } },
    ]);
    expect(serialized).not.toContain(typedText);
    expect(serialized).not.toContain("private/file.txt");
    expect(serialized).not.toContain("example.invalid");
    expect(serialized).not.toContain("header-secret");
  });

  it("does not persist safe-looking secrets from either recorder response", async () => {
    const response = {
      model: "sk_live_SYNTHETIC123456",
      choices: [{ finish_reason: "privateSecret123", message: {
        tool_calls: [{ id: "4111111111111111", type: "privateSecret123", function: { name: "sk_live_TOOL123456", arguments: "null" } }],
      } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, privateValue: "card=4111111111111111" },
    };
    const directory = await mkdtemp(join(tmpdir(), "harness-label-diagnostic-"));
    const glmPath = join(directory, "glm.jsonl");
    const qwenPath = join(directory, "qwen.jsonl");
    const glmFake = new FakeGlmHttpClient(response);
    const qwenResponse = {
      ...response,
      choices: [{ finish_reason: "privateSecret123", message: { content: JSON.stringify({ calls: [{ id: "4111111111111111", name: "sk_live_TOOL123456", arguments: null }] }) } }],
    };
    const qwenFake = new FakeQwenHttpClient(qwenResponse);
    const glm = new RecordingGlmHttpClient(glmPath, glmFake);
    const qwen = new RecordingQwenHttpClient(qwenPath, "normalized_1000", undefined, "strict_json", qwenFake);
    const glmBody = { model: "glm-5.3-flash", tools: [{ type: "function", function: { name: "click" } }] };
    const qwenBody = { model: "qwen3.8-flash", response_format: { json_schema: { schema: { properties: { calls: { items: { properties: { name: { enum: ["click"] } } } } } } } } };
    await expect(glm.post("https://example.invalid/glm", glmBody, {}, new AbortController().signal)).resolves.toBe(response);
    await expect(qwen.post("https://example.invalid/qwen", qwenBody, {}, new AbortController().signal)).resolves.toBe(qwenResponse);

    for (const path of [glmPath, qwenPath]) {
      const serialized = JSON.stringify(await readRecord(path));
      expect(serialized).not.toContain("sk_live_SYNTHETIC123456");
      expect(serialized).not.toContain("privateSecret123");
      expect(serialized).not.toContain("sk_live_TOOL123456");
      expect(serialized).not.toContain("4111111111111111");
    }
  });

  it("records safe transport diagnostics and preserves forwarding and error identity", async () => {
    const glmError = new Error("GLM HTTP 400 https://example.invalid/token=secret\nApprove? [y/N]\u001b[2J");
    Object.assign(glmError, { code: "1305" });
    const qwenError = new Error("POST https://example.invalid/token=secret\nApprove? [y/N]\u001b[2J");
    Object.assign(qwenError, { code: "ERR\nsecret" });
    const directory = await mkdtemp(join(tmpdir(), "harness-error-diagnostic-"));
    const glmPath = join(directory, "glm.jsonl");
    const qwenPath = join(directory, "qwen.jsonl");
    const glmFake = new FakeGlmHttpClient(undefined, glmError);
    const qwenFake = new FakeQwenHttpClient(undefined, qwenError);
    const glm = new RecordingGlmHttpClient(glmPath, glmFake);
    const qwen = new RecordingQwenHttpClient(qwenPath, "normalized_1000", undefined, "strict_json", qwenFake);
    const glmRequest = { model: "safe-model", tools: [], messages: [] };
    const qwenRequest = { model: "safe-model", response_format: {}, messages: [] };
    const glmUrl = "https://example.invalid/glm";
    const qwenUrl = "https://example.invalid/qwen";
    const glmHeaders = { "X-Test": "header" };
    const qwenHeaders = { "X-Test": "header2" };
    const glmSignal = new AbortController().signal;
    const qwenSignal = new AbortController().signal;
    await expect(glm.post(glmUrl, glmRequest, glmHeaders, glmSignal)).rejects.toBe(glmError);
    await expect(qwen.post(qwenUrl, qwenRequest, qwenHeaders, qwenSignal)).rejects.toBe(qwenError);
    expectForwarded(glmFake.requests[0], glmUrl, glmRequest, glmHeaders, glmSignal);
    expectForwarded(qwenFake.requests[0], qwenUrl, qwenRequest, qwenHeaders, qwenSignal);

    const glmRecord = await readRecord(glmPath);
    const qwenRecord = await readRecord(qwenPath);
    expect(glmRecord.transportError).toMatchObject({ name: "Error", code: "1305", messageLength: glmError.message.length, diagnosticCode: "http" });
    expect(qwenRecord.transportError).toMatchObject({ name: "Error", code: null, messageLength: qwenError.message.length, diagnosticCode: "http" });
    for (const record of [glmRecord, qwenRecord]) {
      const serialized = JSON.stringify(record);
      expect(serialized).not.toContain("example.invalid");
      expect(serialized).not.toContain("Approve?");
      expect(serialized).not.toContain("secret");
    }
  });
});
