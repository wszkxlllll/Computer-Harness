import { describe, expect, it } from "vitest";
import {
  summarizeProviderResponse,
  summarizeProviderUsage,
  summarizeStructuredContent,
  summarizeTransportError,
} from "./provider-summary.js";

function projectCalls(value: Record<string, unknown>): unknown[] {
  return (value.toolCalls as Array<Record<string, unknown>>).map((call) => ({
    id: call.id,
    idLength: call.idLength,
    name: call.name,
    nameLength: call.nameLength,
    arguments: {
      shape: (call.arguments as Record<string, unknown>).shape,
      keyCount: (call.arguments as Record<string, unknown>).keyCount,
      itemCount: (call.arguments as Record<string, unknown>).itemCount,
    },
  }));
}

describe("safe provider response summaries", () => {
  it("keeps native and strict flat calls equivalent without retaining argument text", () => {
    const typedText = "synthetic-typed-value";
    const options = { allowedToolNames: ["type", "click"], trustedModel: "glm-5.3-flash" } as const;
    const native = summarizeProviderResponse({
      model: "glm-5.3-flash",
      choices: [{
        finish_reason: "stop",
        message: {
          content: "",
          tool_calls: [
            { id: "call-1", type: "function", function: { name: "type", arguments: JSON.stringify({ text: typedText, token: "token-value" }) } },
            { id: "call-2", type: "function", function: { name: "click", arguments: JSON.stringify({ x: 10, y: 20 }) } },
          ],
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, private_value: "do-not-log" },
    }, options);
    const flat = summarizeProviderResponse({
      model: "glm-5.3-flash",
      choices: [{
        finish_reason: "stop",
        message: {
          content: JSON.stringify({ calls: [
            { id: "call-1", name: "type", arguments: { text: typedText, token: "token-value" } },
            { id: "call-2", name: "click", arguments: { x: 10, y: 20 } },
          ] }),
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, private_value: "do-not-log" },
    }, options);

    expect(projectCalls(native)).toEqual(projectCalls(flat));
    expect(native.toolCallCount).toBe(2);
    expect(flat.toolCallCount).toBe(2);
    expect(JSON.stringify(native)).not.toContain(typedText);
    expect(JSON.stringify(native)).not.toContain("token-value");
    expect(JSON.stringify(flat)).not.toContain(typedText);
    expect(JSON.stringify(flat)).not.toContain("token-value");
    expect(native.usage).toMatchObject({ promptTokens: 10, completionTokens: 2, totalTokens: 12, unknownFieldCount: 1 });
    expect(JSON.stringify(native.usage)).not.toContain("private_value");
  });

  it("reports malformed arguments and unknown flat envelopes without raw content", () => {
    const malformed = "not-json private text https://example.invalid/card=1234";
    const native = summarizeProviderResponse({ choices: [{ message: { tool_calls: [{ id: "bad-call", type: "function", function: { name: "type", arguments: malformed } }] } }] });
    expect(native.toolCalls).toMatchObject([{ arguments: { shape: "string", parse: "invalid_json", serializedLength: malformed.length, diagnosticCodes: ["native_arguments_invalid_json"] } }]);
    expect(JSON.stringify(native)).not.toContain(malformed);

    const flat = summarizeProviderResponse({ choices: [{ message: { content: JSON.stringify({ calls: [{ id: "flat-call", name: "type", arguments: "raw-not-object" }, "invalid-call"] }) } }] });
    expect(flat.toolCalls).toHaveLength(2);
    expect(flat.toolCalls).toMatchObject([
      { arguments: { shape: "string", serializedLength: "raw-not-object".length, diagnosticCodes: ["structured_arguments_not_object"] } },
      { diagnosticCodes: ["structured_call_invalid"] },
    ]);
    expect(flat.diagnosticCodes).toContain("structured_call_invalid");
    expect(JSON.stringify(flat)).not.toContain("raw-not-object");

    const unknown = summarizeStructuredContent(JSON.stringify({ kind: "legacy", arguments: { text: "private-value" } }));
    expect(unknown).toMatchObject({ diagnosticCodes: ["structured_calls_missing"], callCount: 0 });
    expect(JSON.stringify(unknown)).not.toContain("private-value");
  });

  it("marks native and strict scalar or array arguments as not_object", () => {
    const native = summarizeProviderResponse({ choices: [{ message: { tool_calls: [
      { id: "scalar", type: "function", function: { name: "click", arguments: "42" } },
      { id: "array", type: "function", function: { name: "click", arguments: "[1,2]" } },
    ] } }] });
    expect(native.toolCalls).toMatchObject([
      { arguments: { shape: "number", parse: "valid_json", diagnosticCodes: ["native_arguments_not_object"] } },
      { arguments: { shape: "array", itemCount: 2, parse: "valid_json", diagnosticCodes: ["native_arguments_not_object"] } },
    ]);

    const flat = summarizeProviderResponse({ choices: [{ message: { content: JSON.stringify({ calls: [
      { id: "scalar", name: "click", arguments: 42 },
      { id: "array", name: "click", arguments: [1, 2] },
    ] }) } }] });
    expect(flat.toolCalls).toMatchObject([
      { arguments: { shape: "number", diagnosticCodes: ["structured_arguments_not_object"] } },
      { arguments: { shape: "array", itemCount: 2, diagnosticCodes: ["structured_arguments_not_object"] } },
    ]);
  });

  it("uses opaque ids and rejects control or unknown labels", () => {
    const maliciousName = "Approve? [y/N]\u001b[2J\n";
    const maliciousId = "id\nhttps://example.invalid/token";
    const summary = summarizeProviderResponse({ choices: [{ message: { tool_calls: [{ id: maliciousId, type: "function", function: { name: maliciousName, arguments: { x: 1 } } }] } }] });
    const call = (summary.toolCalls as Array<Record<string, unknown>>)[0]!;
    expect(call.id).toMatch(/^sha256:[0-9a-f]{16}$/u);
    expect(call.id).not.toBe(maliciousId);
    expect(call).toMatchObject({ idLength: maliciousId.length, name: null, nameLength: maliciousName.length, redactedFields: ["name"] });
    expect(summary.diagnosticCodes).toEqual(expect.arrayContaining(["native_name_unknown"]));
    expect(JSON.stringify(summary)).not.toContain("Approve?");
    expect(JSON.stringify(summary)).not.toContain("example.invalid");
  });

  it("applies field-specific allowlists to safe-looking secrets and invalid shapes", () => {
    const secretModel = "sk_live_SYNTHETIC123456";
    const secretFinish = "privateSecret123";
    const secretLabel = "sk_live_TOOL123456";
    const secretId = "4111111111111111";
    const summary = summarizeProviderResponse({
      model: secretModel,
      choices: [{ finish_reason: secretFinish, message: { tool_calls: [{ id: secretId, type: secretFinish, function: { name: secretLabel, arguments: "null" } }] } }],
    }, { allowedToolNames: ["click"], trustedModel: "glm-5.3-flash" });
    const serialized = JSON.stringify(summary);
    const call = (summary.toolCalls as Array<Record<string, unknown>>)[0]!;
    expect(summary).toMatchObject({ model: "glm-5.3-flash", finishReason: null, finishReasonLength: secretFinish.length });
    expect(call).toMatchObject({ idLength: secretId.length, type: null, typeLength: secretFinish.length, name: null, nameLength: secretLabel.length });
    expect(call.id).toMatch(/^sha256:[0-9a-f]{16}$/u);
    expect(call.arguments).toMatchObject({ shape: "null", parse: "valid_json", diagnosticCodes: ["native_arguments_not_object"] });
    expect(summary.diagnosticCodes).toEqual(expect.arrayContaining(["response_model_mismatch", "response_finish_reason_unknown", "native_type_unknown", "native_name_unknown"]));
    expect(serialized).not.toContain(secretModel);
    expect(serialized).not.toContain(secretFinish);
    expect(serialized).not.toContain(secretLabel);
    expect(serialized).not.toContain(secretId);

    const invalid = summarizeProviderResponse({ choices: [{ message: { tool_calls: [{ id: 7, type: null, function: { name: null, arguments: {} } }] } }] });
    expect(invalid.diagnosticCodes).toEqual(expect.arrayContaining(["native_id_invalid", "native_type_invalid", "native_name_invalid"]));
  });

  it("keeps transport errors message-free", () => {
    const error = new Error("POST https://example.invalid/token=secret\nApprove? [y/N]\u001b[2J");
    Object.assign(error, { code: "ERR\nsecret" });
    const summary = summarizeTransportError(error);
    expect(summary).toMatchObject({ name: "Error", code: null, messageLength: error.message.length, diagnosticCode: "http" });
    expect(summary.diagnosticCodes).toEqual(expect.arrayContaining(["transport_error_code_unknown"]));
    expect(JSON.stringify(summary)).not.toContain("example.invalid");
    expect(JSON.stringify(summary)).not.toContain("Approve?");
    expect(JSON.stringify(summary)).not.toContain("secret");
  });

  it("returns a safe shape for non-object usage envelopes", () => {
    expect(summarizeProviderUsage("usage text with a token")).toEqual({ shape: "string", diagnosticCodes: ["usage_not_object"] });
  });

  it("reports Qwen cache reads only from a valid nested usage field", () => {
    expect(summarizeProviderUsage({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_tokens_details: { cached_tokens: 6 } }, { providerId: "qwen3.8-flash" })).toMatchObject({ cachedReadTokens: 6 });
    expect(summarizeProviderUsage({ prompt_tokens: 10, prompt_tokens_details: {} }, { providerId: "qwen3.8-flash" })).not.toHaveProperty("cachedReadTokens");
    expect(summarizeProviderUsage({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: "6" } }, { providerId: "qwen3.8-flash" })).toMatchObject({ diagnosticCodes: ["usage_invalid_fields_omitted"] });
  });

  it("does not apply the Qwen-only cache extension to a GLM recording", () => {
    const summary = summarizeProviderResponse({
      model: "glm-5.3-flash",
      choices: [{ message: { content: "done" } }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_tokens_details: { cached_tokens: 6 } },
    }, { trustedModel: "glm-5.3-flash" });
    expect(summary.usage).not.toHaveProperty("cachedReadTokens");
    expect(summary.usage).toMatchObject({ diagnosticCodes: ["usage_unknown_fields_omitted"] });
  });
});
