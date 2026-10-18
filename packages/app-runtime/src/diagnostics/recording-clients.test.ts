import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GlmHttpClient, GlmHttpDiagnostics, GlmTransportEvidence } from "@computer-harness/provider-glm";
import { ArkProviderError } from "@computer-harness/provider-glm";
import type { QwenHttpClient } from "@computer-harness/provider-qwen";
import { RecordingArkHttpClient, RecordingDeepseekHttpClient, RecordingGlmHttpClient, RecordingQwenHttpClient } from "./recording-clients.js";

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
  it("keeps Qwen outcomes and call count unchanged when every optional recording step fails", async () => {
    const response = { model: "qwen3.8-flash", choices: [] };
    const originalFailure = new Error("provider failure must survive recording");
    const successInner = new FakeQwenHttpClient(response);
    const failureInner = new FakeQwenHttpClient(undefined, originalFailure);
    const signal = new AbortController().signal;
    const missingDirectory = join(await mkdtemp(join(tmpdir(), "harness-qwen-recording-failure-")), "missing", "nested");
    const successRecorder = new RecordingQwenHttpClient(join(missingDirectory, "success.jsonl"), "normalized_1000", undefined, "strict_json", successInner);
    const failureRecorder = new RecordingQwenHttpClient(join(missingDirectory, "failure.jsonl"), "normalized_1000", undefined, "strict_json", failureInner);

    await expect(successRecorder.post("fixture", { model: "qwen3.8-flash" }, {}, signal)).resolves.toBe(response);
    const throwingBody = Object.defineProperty({}, "model", { get() { throw new Error("diagnostic projection failed"); } });
    await expect(failureRecorder.post("fixture", throwingBody, {}, signal)).rejects.toBe(originalFailure);
    expect(successInner.calls).toBe(1);
    expect(failureInner.calls).toBe(1);

    const getterResponse = { ok: true };
    const getterInner = new FakeQwenHttpClient(getterResponse);
    const getterRecorder = new RecordingQwenHttpClient(join(missingDirectory, "getter.jsonl"), "normalized_1000", undefined, "strict_json", getterInner);
    await expect(getterRecorder.post("fixture", throwingBody, {}, signal)).resolves.toBe(getterResponse);
    expect(getterInner.calls).toBe(1);

    const unprojectableResponse = Object.defineProperty({}, "choices", { get() { throw new Error("response summary failed"); } });
    const responseInner = new FakeQwenHttpClient(unprojectableResponse);
    const responseRecorder = new RecordingQwenHttpClient(join(missingDirectory, "response.jsonl"), "normalized_1000", undefined, "strict_json", responseInner);
    await expect(responseRecorder.post("fixture", { model: "qwen3.8-flash" }, {}, signal)).resolves.toBe(unprojectableResponse);
    expect(responseInner.calls).toBe(1);
  });

  it("persists only valid transport configuration fields on success and failure without changing outcomes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-glm-recorder-safe-transport-"));
    const successPath = join(directory, "success.jsonl");
    const failurePath = join(directory, "failure.jsonl");
    const response = { choices: [] };
    const originalFailure = new Error("private transport failure");
    const evidenceWithUnknowns = {
      stage: "fetch_invoked",
      outcome: "pending",
      phase: "awaiting_headers",
      elapsedMs: 12,
      deadlineMs: 120_000,
      serializedBodyBytes: 4096,
      abortSource: "run_cancelled",
      requestConfiguration: {
        stream: false,
        thinking: "enabled",
        reasoningEffort: "high",
        maxTokens: 8192,
        messageCount: 2,
        toolCount: 3,
        imageCount: 1,
        privateSetting: "PRIVATE_NESTED_MARKER",
      },
      url: "PRIVATE_URL_MARKER",
      body: "PRIVATE_BODY_MARKER",
      authorization: "PRIVATE_AUTH_MARKER",
    } as unknown as GlmTransportEvidence;
    const successInner: GlmHttpClient = {
      async post(_url, _body, _headers, _signal, diagnostics) {
        diagnostics?.onTransportEvidence?.(evidenceWithUnknowns);
        return response;
      },
    };
    const successRecorder = new RecordingGlmHttpClient(successPath, successInner);
    const callbackFailure = new Error("PRIVATE_CALLBACK_MARKER");
    await expect(successRecorder.post("private-url", {}, {}, new AbortController().signal, {
      payloadHash: "a".repeat(64),
      onTransportEvidence: () => { throw callbackFailure; },
    })).resolves.toBe(response);

    const failedInner: GlmHttpClient = {
      async post(_url, _body, _headers, _signal, diagnostics) {
        diagnostics?.onTransportEvidence?.({
          ...evidenceWithUnknowns,
          stage: "body_failed",
          outcome: "timeout",
          phase: "reading_body",
          elapsedMs: 120_012,
          httpStatus: 200,
          deadlineMs: 0,
          serializedBodyBytes: -1,
          abortSource: "network_error",
          requestConfiguration: { stream: false, messageCount: "PRIVATE_INVALID_COUNT" },
        } as unknown as GlmTransportEvidence);
        throw originalFailure;
      },
    };
    const failureRecorder = new RecordingGlmHttpClient(failurePath, failedInner);
    await expect(failureRecorder.post("private-url", {}, {}, new AbortController().signal, { payloadHash: "b".repeat(64) })).rejects.toBe(originalFailure);

    const successRecord = await readRecord(successPath);
    const failureRecord = await readRecord(failurePath);
    expect(successRecord.httpEvidence).toEqual({ source: "fetch", stages: [{
      stage: "fetch_invoked",
      outcome: "pending",
      phase: "awaiting_headers",
      elapsedMs: 12,
      deadlineMs: 120_000,
      serializedBodyBytes: 4096,
      abortSource: "run_cancelled",
      requestConfiguration: { stream: false, thinking: "enabled", reasoningEffort: "high", maxTokens: 8192, messageCount: 2, toolCount: 3, imageCount: 1 },
    }] });
    expect(failureRecord.httpEvidence).toEqual({ source: "fetch", stages: [{
      stage: "body_failed",
      outcome: "timeout",
      phase: "reading_body",
      elapsedMs: 120_012,
      httpStatus: 200,
    }] });
    const serialized = JSON.stringify([successRecord, failureRecord]);
    for (const marker of ["PRIVATE_NESTED_MARKER", "PRIVATE_URL_MARKER", "PRIVATE_BODY_MARKER", "PRIVATE_AUTH_MARKER", "PRIVATE_CALLBACK_MARKER", "PRIVATE_INVALID_COUNT"]) {
      expect(serialized).not.toContain(marker);
    }
  });

  it("keeps concurrent ordinals local, marks fake evidence unknown, and isolates logging failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-glm-recorder-boundaries-"));
    const path = join(directory, "provider-exchanges.jsonl");
    const response = { choices: [{ message: { content: "PRIVATE_RESPONSE" } }] };
    const pending: Array<(value: unknown) => void> = [];
    const inner: GlmHttpClient = {
      post(_url, _body, _headers, _signal, diagnostics) {
        if (_url === "malicious" || diagnostics?.payloadHash === "b".repeat(64)) {
          diagnostics.onTransportEvidence?.(null as unknown as GlmTransportEvidence);
          diagnostics.onTransportEvidence?.({ stage: "PRIVATE_STAGE", outcome: "success", phase: "complete", elapsedMs: 1, httpStatus: 200, headers: "PRIVATE_HEADER" } as unknown as GlmTransportEvidence);
          return Promise.resolve(response);
        }
        return new Promise((resolve) => pending.push(resolve));
      },
    };
    const recorder = new RecordingGlmHttpClient(path, inner);
    const signal = new AbortController().signal;
    const diag = (requestId: string, payloadHash = "a".repeat(64), onTransportEvidence?: (item: GlmTransportEvidence) => void, estimate?: GlmHttpDiagnostics["estimate"]): GlmHttpDiagnostics => ({ runId: "run-test", requestId, decisionId: "decision-test", attempt: 1, payloadHash, onTransportEvidence, estimate });
    const first = recorder.post("PRIVATE_URL", { model: "glm-5.3-flash" }, { Authorization: "PRIVATE_AUTH" }, signal, diag("first"));
    const second = recorder.post("PRIVATE_URL", { model: "glm-5.3-flash" }, { Authorization: "PRIVATE_AUTH" }, signal, diag("second"));
    pending[1]?.(response);
    await second;
    pending[0]?.(response);
    await first;
    await expect(recorder.post("malicious", { model: "glm-5.3-flash" }, {}, signal, diag("malicious", "b".repeat(64), () => { throw new Error("PRIVATE_CALLBACK"); }, { estimatedTextTokens: 1, imageCount: 0, estimationMethod: "PRIVATE_METHOD" as "provider_projection" }))).resolves.toBe(response);
    await expect(recorder.post("malicious", { model: "glm-5.3-flash" }, {}, signal, null as unknown as GlmHttpDiagnostics)).resolves.toBe(response);
    const records = (await readFile(path, "utf8")).trim().split(/\r?\n/u).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.slice(0, 2).map((record) => [record.request, record.requestId])).toEqual([[2, "second"], [1, "first"]]);
    expect(records.slice(0, 2).every((record) => JSON.stringify(record.httpEvidence) === JSON.stringify({ source: "unavailable", stages: [] }))).toBe(true);
    expect(records[2]?.httpEvidence).toEqual({ source: "unavailable", stages: [] });
    expect(records[2]).not.toHaveProperty("preparedEstimate");
    const serialized = JSON.stringify(records);
    expect(serialized).not.toMatch(/PRIVATE_(?:STAGE|HEADER|URL|AUTH|RESPONSE|CALLBACK)/u);
    await expect(new RecordingGlmHttpClient(join(directory, "missing", "record.jsonl"), { async post() { return response; } }).post("x", {}, {}, signal, diag("persist-success"))).resolves.toBe(response);
    const failure = new Error("PRIVATE_ORIGINAL_ERROR");
    await expect(new RecordingGlmHttpClient(join(directory, "missing", "error.jsonl"), { async post() { throw failure; } }).post("x", {}, {}, signal, diag("persist-failure"))).rejects.toBe(failure);
  });

  it("writes a safe GLM native multi-call projection through the recorder", async () => {
    const typedText = "typed-private-value";
    const response = {
      model: "glm-5.3-flash",
      choices: [{
        finish_reason: "tool_calls",
        message: {
          content: "I selected a target from the current UIA observation.",
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
    expect((record.response as Record<string, unknown>).structuredContent).toBeNull();
    expect((record.response as Record<string, unknown>).diagnosticCodes).not.toContain("structured_invalid_json");
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

  it("projects Ark nested cached tokens and redacts unsupported usage fields through its recorder", async () => {
    const response = {
      model: "deepseek-v4.1-flash",
      choices: [{ finish_reason: "stop", message: { content: "private response content" } }],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 3,
        total_tokens: 15,
        prompt_tokens_details: { cached_tokens: 9, private_nested: "NESTED_USAGE_SECRET" },
        prompt_cache_hit_tokens: 999,
        prompt_cache_miss_tokens: 888,
        private_usage_field: "UNKNOWN_USAGE_SECRET",
      },
    };
    const fake = new FakeGlmHttpClient(response);
    const directory = await mkdtemp(join(tmpdir(), "harness-ark-diagnostic-"));
    const path = join(directory, "provider-exchanges.jsonl");
    const recorder = new RecordingArkHttpClient(path, fake);
    const body = { model: "deepseek-v4.1-flash", tools: [] };
    const signal = new AbortController().signal;

    await expect(recorder.post("https://example.invalid/ark", body, {}, signal)).resolves.toBe(response);

    const record = await readRecord(path);
    const serialized = JSON.stringify(record);
    const usage = (record.response as Record<string, unknown>).usage as Record<string, unknown>;
    expect(fake.calls).toBe(1);
    expect(record).toMatchObject({ provider: "ark", requestedModel: "deepseek-v4.1-flash" });
    expect(usage).toMatchObject({ promptTokens: 12, completionTokens: 3, totalTokens: 15, cachedReadTokens: 9, unknownFieldCount: 3 });
    expect(usage.diagnosticCodes).toEqual(["usage_unknown_fields_omitted"]);
    expect(usage).not.toHaveProperty("cacheMissTokens");
    expect(usage).not.toHaveProperty("prompt_cache_hit_tokens");
    expect(serialized).not.toContain("NESTED_USAGE_SECRET");
    expect(serialized).not.toContain("UNKNOWN_USAGE_SECRET");
    expect(serialized).not.toContain("example.invalid");
  });

  it("omits invalid Ark nested cache counts without exposing unknown payloads", async () => {
    const response = {
      model: "deepseek-v4.1-flash",
      choices: [{ finish_reason: "stop", message: { content: "done" } }],
      usage: {
        prompt_tokens: 10,
        prompt_tokens_details: { cached_tokens: "10240", private_nested: "INVALID_USAGE_SECRET" },
        prompt_cache_miss_tokens: 123,
        private_usage_field: "UNKNOWN_USAGE_SECRET",
      },
    };
    const directory = await mkdtemp(join(tmpdir(), "harness-ark-invalid-usage-diagnostic-"));
    const path = join(directory, "provider-exchanges.jsonl");
    const recorder = new RecordingArkHttpClient(path, new FakeGlmHttpClient(response));

    await recorder.post("https://example.invalid/ark", { model: "deepseek-v4.1-flash", tools: [] }, {}, new AbortController().signal);

    const record = await readRecord(path);
    const serialized = JSON.stringify(record);
    const usage = (record.response as Record<string, unknown>).usage as Record<string, unknown>;
    expect(usage).not.toHaveProperty("cachedReadTokens");
    expect(usage).not.toHaveProperty("cacheMissTokens");
    expect(usage.diagnosticCodes).toEqual(["usage_invalid_fields_omitted", "usage_unknown_fields_omitted"]);
    expect(serialized).not.toContain("INVALID_USAGE_SECRET");
    expect(serialized).not.toContain("UNKNOWN_USAGE_SECRET");
    expect(serialized).not.toContain("example.invalid");
  });

  it("keeps official DeepSeek flat cache fields separate from Ark nested usage", async () => {
    const response = {
      model: "deepseek-flash",
      choices: [{ finish_reason: "stop", message: { content: "done" } }],
      usage: {
        prompt_tokens: 20,
        prompt_cache_hit_tokens: 6,
        prompt_cache_miss_tokens: 14,
        prompt_tokens_details: { cached_tokens: 999 },
        private_usage_field: "OFFICIAL_USAGE_SECRET",
      },
    };
    const directory = await mkdtemp(join(tmpdir(), "harness-deepseek-flat-usage-diagnostic-"));
    const path = join(directory, "provider-exchanges.jsonl");
    const recorder = new RecordingDeepseekHttpClient(path, new FakeGlmHttpClient(response));

    await recorder.post("https://example.invalid/deepseek", { model: "deepseek-flash", tools: [] }, {}, new AbortController().signal);

    const record = await readRecord(path);
    const serialized = JSON.stringify(record);
    const usage = (record.response as Record<string, unknown>).usage as Record<string, unknown>;
    expect(record).toMatchObject({ provider: "deepseek", requestedModel: "deepseek-flash" });
    expect(usage).toMatchObject({ promptTokens: 20, cachedReadTokens: 6, cacheMissTokens: 14, unknownFieldCount: 2 });
    expect(usage).not.toHaveProperty("prompt_tokens_details");
    expect(serialized).not.toContain("OFFICIAL_USAGE_SECRET");
    expect(serialized).not.toContain("example.invalid");
  });

  it("reports malformed assistant content for a Qwen request that actually requires strict JSON", async () => {
    const fake = new FakeQwenHttpClient({
      model: "qwen3.8-flash",
      choices: [{ finish_reason: "stop", message: { content: "not-json" } }],
    });
    const directory = await mkdtemp(join(tmpdir(), "harness-qwen-malformed-strict-diagnostic-"));
    const path = join(directory, "provider-exchanges.jsonl");
    const recorder = new RecordingQwenHttpClient(path, "normalized_1000", "low", "strict_json", fake);
    const body = {
      model: "qwen3.8-flash",
      response_format: { type: "json_schema", json_schema: { schema: { type: "object", properties: { calls: { type: "array" } } } } },
      messages: [{ role: "user", content: "synthetic request" }],
    };

    await expect(recorder.post("https://example.invalid/qwen", body, {}, new AbortController().signal)).resolves.toBeDefined();

    const record = await readRecord(path);
    expect((record.response as Record<string, unknown>).structuredContent).toMatchObject({
      json: false,
      diagnosticCodes: ["structured_invalid_json"],
    });
    expect((record.response as Record<string, unknown>).diagnosticCodes).toContain("structured_invalid_json");
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

  it("records only the allowlisted Ark 429 error fields and bounded Retry-After metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-ark-error-diagnostic-"));
    const arkPath = join(directory, "ark.jsonl");
    const failure = new ArkProviderError("Ark HTTP 429: Request rate limit exceeded.", "ARK_HTTP_429", true, "same_input");
    Object.assign(failure, { httpFailure: {
      httpStatus: 429,
      providerErrorCode: "TooManyRequests",
      providerErrorMessage: "Request rate limit exceeded.",
      retryAfterState: "accepted",
      retryAfterMs: 2_000,
    } });
    Object.assign(failure, { rawBody: "Authorization: Bearer private-token-123456789012345678901234" });
    const inner = new FakeGlmHttpClient(undefined, failure);
    const ark = new RecordingArkHttpClient(arkPath, inner);
    try {
      await expect(ark.post(
        "https://fixture.invalid/secret-path",
        { model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "private request body" }], tools: [] },
        { authorization: "private-header-token" },
        new AbortController().signal,
      )).rejects.toBe(failure);
      const record = await readRecord(arkPath);
      expect(record.transportError).toMatchObject({
        httpFailure: {
          httpStatus: 429,
          providerErrorCode: "TooManyRequests",
          providerErrorMessage: "Request rate limit exceeded.",
          retryAfterState: "accepted",
          retryAfterMs: 2_000,
        },
      });
      const serialized = JSON.stringify(record);
      expect(serialized).not.toMatch(/secret-path|private request body|private-header-token|private-token|rawBody|Authorization/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
