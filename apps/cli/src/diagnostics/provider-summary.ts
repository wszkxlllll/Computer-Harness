import { createHash } from "node:crypto";

/**
 * Safe provider diagnostics for the CLI's private recording path.
 *
 * This module is deliberately side-effect free. It never logs raw provider
 * content, tool arguments, URLs, headers, or error messages. Provider wire
 * formats stay provider-owned; this module only produces a bounded diagnostic
 * projection for the two recorder implementations.
 */

type DiagnosticShape = "undefined" | "null" | "string" | "number" | "boolean" | "array" | "object";

export interface ProviderArgumentSummary {
  shape: DiagnosticShape;
  serializedLength?: number;
  keyCount?: number;
  itemCount?: number;
  parse?: "valid_json" | "invalid_json";
  diagnosticCodes: string[];
}

export interface ProviderToolCallSummary {
  /** Stable opaque correlation value, never the provider-supplied id. */
  id: string | null;
  idLength: number;
  type: string | null;
  typeLength: number;
  name: string | null;
  nameLength: number;
  arguments: ProviderArgumentSummary;
  redactedFields: string[];
  diagnosticCodes: string[];
}

export interface ProviderSummaryOptions {
  /** Names from the request's actual tool schema, not from provider output. */
  allowedToolNames?: ReadonlySet<string> | readonly string[];
  /** Provider model selected by trusted local configuration. */
  trustedModel?: string;
}

interface SafeIdentifier {
  value: string | null;
  length: number;
  redacted: boolean;
}

interface OpaqueIdentifier {
  value: string | null;
  length: number;
  invalid: boolean;
  missing: boolean;
}

const OPAQUE_ID_PREFIX = "sha256:";

const TRUSTED_MODELS = new Set(["glm-5.3-flash", "qwen3.8-flash"]);
const ALLOWED_TOOL_TYPES = new Set(["function"]);
const ALLOWED_FINISH_REASONS = new Set(["stop", "tool_calls", "function_call", "length", "content_filter"]);
const ALLOWED_ERROR_NAMES = new Set([
  "Error",
  "AbortError",
  "TypeError",
  "TimeoutError",
  "FetchError",
  "DOMException",
  "GlmProviderError",
  "QwenProviderError",
]);
const ALLOWED_ERROR_CODES = new Set([
  "1305",
  "GLM_PROVIDER_ERROR",
  "GLM_INVALID_HISTORY",
  "GLM_INVALID_RESPONSE",
  "GLM_DUPLICATE_TOOL_CALL",
  "GLM_UNAVAILABLE_TOOL",
  "GLM_INVALID_TOOL_CALL",
  "GLM_EMPTY_RESPONSE",
  "GLM_INCOMPLETE_RESPONSE",
  "GLM_REQUEST_TIMEOUT",
  "GLM_NETWORK_ERROR",
  "GLM_MISSING_VIEWPORT",
  "GLM_COORDINATE_OUT_OF_RANGE",
  "QWEN_PROVIDER_ERROR",
  "QWEN_INVALID_HISTORY",
  "QWEN_DUPLICATE_TOOL_CALL",
  "QWEN_INVALID_TOOL_CALL",
  "QWEN_UNTAGGED_TOOL_CALL",
  "QWEN_INVALID_RESPONSE",
  "QWEN_UNCONFIRMED_FINISH",
  "QWEN_EMPTY_RESPONSE",
  "QWEN_REQUEST_TIMEOUT",
  "QWEN_NETWORK_ERROR",
  "QWEN_INVALID_PREPARED_IMAGE",
  "QWEN_INCOMPLETE_RESPONSE",
  "QWEN_COORDINATE_OUT_OF_RANGE",
  "QWEN_MISSING_VIEWPORT",
  "QWEN_UNAVAILABLE_TOOL",
]);
for (const prefix of ["GLM_HTTP_", "QWEN_HTTP_"]) {
  for (let status = 400; status <= 599; status += 1) ALLOWED_ERROR_CODES.add(`${prefix}${status}`);
}

/**
 * Extract request tool names from either OpenAI-native `tools` or Qwen strict
 * JSON's response schema. The local request schema is the only trusted source
 * for the response-name allowlist; malformed/control-bearing names are
 * omitted from both the output and that allowlist.
 */
export interface ProviderRequestToolProjection {
  toolNames: Array<string | null>;
  allowedToolNames: ReadonlySet<string>;
}

export function providerRequestToolProjection(body: Record<string, unknown>): ProviderRequestToolProjection {
  const names = readRequestToolNames(body);
  const allowedToolNames = new Set<string>();
  const toolNames = names.map((name) => {
    const safeName = safeRequestToolName(name);
    if (safeName === null) return null;
    allowedToolNames.add(safeName);
    return safeName;
  });
  return { toolNames, allowedToolNames };
}

export function trustedProviderModel(value: unknown): string | null {
  return typeof value === "string" && TRUSTED_MODELS.has(value) ? value : null;
}

export function summarizeProviderResponse(value: unknown, options: ProviderSummaryOptions = {}): Record<string, unknown> {
  if (!isPlainRecord(value)) return { shape: shapeOf(value), diagnosticCodes: ["response_not_object"] };

  const diagnostics = new Set<string>();
  const choices = value.choices;
  if (!Array.isArray(choices)) diagnostics.add("response_choices_missing");
  const choice = Array.isArray(choices) && isPlainRecord(choices[0]) ? choices[0] : undefined;
  if (choice === undefined && Array.isArray(choices) && choices.length > 0) diagnostics.add("response_choice_invalid");
  const message = choice !== undefined && isPlainRecord(choice.message) ? choice.message : undefined;
  if (message === undefined) diagnostics.add("response_message_missing");

  const allowedToolNames = normalizeAllowedToolNames(options.allowedToolNames);
  const native = summarizeNativeCalls(message?.tool_calls, diagnostics, allowedToolNames);
  const structuredProjection = summarizeStructuredContentProjection(message?.content, allowedToolNames);
  const structured = structuredProjection.summary;
  const structuredCalls = structuredProjection.calls;
  const calls = native.calls.length > 0 ? native.calls : structuredCalls;
  for (const code of native.diagnosticCodes) diagnostics.add(code);
  for (const code of readDiagnosticCodes(structured)) diagnostics.add(code);

  const trustedModel = trustedProviderModel(options.trustedModel);
  const rawModel = value.model;
  if (rawModel !== undefined && typeof rawModel !== "string") diagnostics.add("response_model_invalid");
  else if (typeof rawModel === "string" && trustedModel === null) diagnostics.add("response_model_untrusted");
  else if (typeof rawModel === "string" && trustedModel !== null && rawModel !== trustedModel) diagnostics.add("response_model_mismatch");

  const finishReason = allowlistedString(choice?.finish_reason, ALLOWED_FINISH_REASONS, "response_finish_reason", diagnostics);

  return {
    // A response cannot establish its own model identity. Only the trusted
    // request configuration may populate this field.
    model: trustedModel,
    modelLength: trustedModel?.length ?? 0,
    finishReason: finishReason.value,
    finishReasonLength: finishReason.length,
    contentLength: typeof message?.content === "string" ? message.content.length : 0,
    reasoningContentLength: typeof message?.reasoning_content === "string" ? message.reasoning_content.length : 0,
    toolCalls: calls,
    toolCallCount: calls.length,
    structuredContent: structured,
    usage: summarizeProviderUsage(value.usage),
    diagnosticCodes: [...diagnostics].sort(),
  };
}

export function summarizeStructuredContent(value: unknown, options: ProviderSummaryOptions = {}): Record<string, unknown> | null {
  return summarizeStructuredContentProjection(value, normalizeAllowedToolNames(options.allowedToolNames)).summary;
}

function summarizeStructuredContentProjection(value: unknown, allowedToolNames: ReadonlySet<string>): { summary: Record<string, unknown> | null; calls: ProviderToolCallSummary[] } {
  if (typeof value !== "string") return { summary: null, calls: [] };
  const contentLength = value.length;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return { summary: { json: false, contentLength, callCount: 0, diagnosticCodes: ["structured_invalid_json"] }, calls: [] };
  }
  if (!isPlainRecord(parsed)) {
    return { summary: {
      json: true,
      rootType: shapeOf(parsed),
      contentLength,
      callCount: 0,
      diagnosticCodes: ["structured_root_not_object"],
    }, calls: [] };
  }
  const callsValue = parsed.calls;
  if (callsValue === undefined) {
    return { summary: {
      json: true,
      rootType: "object",
      contentLength,
      keyCount: Object.keys(parsed).length,
      callCount: 0,
      diagnosticCodes: ["structured_calls_missing"],
    }, calls: [] };
  }
  if (!Array.isArray(callsValue)) {
    return { summary: {
      json: true,
      rootType: "object",
      contentLength,
      keyCount: Object.keys(parsed).length,
      callCount: 0,
      diagnosticCodes: ["structured_calls_not_array"],
    }, calls: [] };
  }
  const diagnostics = new Set<string>();
  const calls = callsValue.map((call) => normalizeFlatCall(call, diagnostics, allowedToolNames));
  return { summary: {
    json: true,
    rootType: "object",
    contentLength,
    keyCount: Object.keys(parsed).length,
    callCount: calls.length,
    diagnosticCodes: [...diagnostics].sort(),
  }, calls };
}

export function summarizeProviderArguments(value: unknown): ProviderArgumentSummary {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      const summary = summarizeArgumentValue(parsed);
      return {
        ...summary,
        serializedLength: value.length,
        parse: "valid_json",
        diagnosticCodes: summary.shape === "object"
          ? summary.diagnosticCodes
          : [...summary.diagnosticCodes, "native_arguments_not_object"],
      };
    } catch {
      return { shape: "string", serializedLength: value.length, parse: "invalid_json", diagnosticCodes: ["native_arguments_invalid_json"] };
    }
  }
  const summary = summarizeArgumentValue(value);
  return summary.shape === "object"
    ? summary
    : { ...summary, diagnosticCodes: [...summary.diagnosticCodes, "native_arguments_not_object"] };
}

export function summarizeProviderUsage(value: unknown): Record<string, unknown> | null {
  if (value === undefined) return null;
  if (!isPlainRecord(value)) return { shape: shapeOf(value), diagnosticCodes: ["usage_not_object"] };
  const knownKeys = new Set(["prompt_tokens", "completion_tokens", "total_tokens"]);
  const sourceKeys = Object.keys(value);
  const result: Record<string, unknown> = {
    shape: "object",
    fieldCount: sourceKeys.length,
    unknownFieldCount: sourceKeys.filter((key) => !knownKeys.has(key)).length,
  };
  for (const [source, target] of [["prompt_tokens", "promptTokens"], ["completion_tokens", "completionTokens"], ["total_tokens", "totalTokens"]] as const) {
    const item = value[source];
    if (typeof item === "number" && Number.isInteger(item) && item >= 0) result[target] = item;
  }
  const diagnosticCodes = new Set<string>();
  if (sourceKeys.some((key) => !knownKeys.has(key))) diagnosticCodes.add("usage_unknown_fields_omitted");
  if (sourceKeys.some((key) => knownKeys.has(key) && !(typeof value[key] === "number" && Number.isInteger(value[key]) && value[key] >= 0))) {
    diagnosticCodes.add("usage_invalid_fields_omitted");
  }
  if (diagnosticCodes.size > 0) result.diagnosticCodes = [...diagnosticCodes].sort();
  return result;
}

export function summarizeTransportError(error: unknown): Record<string, unknown> {
  const errorRecord = isPlainRecord(error) ? error : undefined;
  const rawName = error instanceof Error ? error.name : undefined;
  const diagnostics = new Set<string>();
  const name = allowlistedString(rawName, ALLOWED_ERROR_NAMES, "transport_error_name", diagnostics);
  const rawCode = errorRecord?.code;
  const code = allowlistedString(rawCode, ALLOWED_ERROR_CODES, "transport_error_code", diagnostics);
  const message = error instanceof Error && typeof error.message === "string" ? error.message : "";
  return {
    name: name.value,
    nameLength: name.length,
    code: code.value,
    codeLength: code.length,
    messageLength: message.length,
    messageShape: "string",
    errorShape: shapeOf(error),
    diagnosticCode: classifyTransportError(message),
    ...(diagnostics.size > 0 ? { diagnosticCodes: [...diagnostics].sort() } : {}),
    ...(name.value === null || code.value === null ? {
      redactedFields: [
        ...(name.value === null && rawName !== undefined ? ["name"] : []),
        ...(code.value === null && rawCode !== undefined ? ["code"] : []),
      ],
    } : {}),
  };
}

function summarizeNativeCalls(value: unknown, parentDiagnostics: Set<string>, allowedToolNames: ReadonlySet<string>): { calls: ProviderToolCallSummary[]; diagnosticCodes: string[] } {
  if (value === undefined) return { calls: [], diagnosticCodes: [] };
  if (!Array.isArray(value)) {
    parentDiagnostics.add("native_tool_calls_not_array");
    return { calls: [], diagnosticCodes: ["native_tool_calls_not_array"] };
  }
  const diagnostics = new Set<string>();
  const calls = value.map((call) => normalizeNativeCall(call, diagnostics, allowedToolNames));
  return { calls, diagnosticCodes: [...diagnostics] };
}

function normalizeNativeCall(value: unknown, diagnostics: Set<string>, allowedToolNames: ReadonlySet<string>): ProviderToolCallSummary {
  if (!isPlainRecord(value)) {
    diagnostics.add("native_tool_call_invalid");
    return emptyToolCall("native_tool_call_invalid");
  }
  const fn = isPlainRecord(value.function) ? value.function : undefined;
  if (fn === undefined) diagnostics.add("native_function_missing");
  const result = normalizeToolCall(value.id, value.type, fn?.name, fn?.arguments, "native", diagnostics, allowedToolNames);
  if (fn === undefined) result.diagnosticCodes = [...new Set([...result.diagnosticCodes, "native_function_missing"])].sort();
  return result;
}

function normalizeFlatCall(value: unknown, diagnostics: Set<string>, allowedToolNames: ReadonlySet<string>): ProviderToolCallSummary {
  if (!isPlainRecord(value)) {
    diagnostics.add("structured_call_invalid");
    return emptyToolCall("structured_call_invalid");
  }
  return normalizeToolCall(value.id, undefined, value.name, value.arguments, "structured", diagnostics, allowedToolNames);
}

function normalizeToolCall(
  idValue: unknown,
  typeValue: unknown,
  nameValue: unknown,
  argumentsValue: unknown,
  source: "native" | "structured",
  diagnostics: Set<string>,
  allowedToolNames: ReadonlySet<string>,
): ProviderToolCallSummary {
  const id = opaqueIdentifier(idValue);
  const type = allowlistedString(typeValue, ALLOWED_TOOL_TYPES, `${source}_type`, diagnostics);
  const name = requestScopedToolName(nameValue, allowedToolNames, source, diagnostics);
  const redactedFields = [
    ...(name.value === null && nameValue !== undefined ? ["name"] : []),
    ...(type.value === null && typeValue !== undefined ? ["type"] : []),
  ];
  const diagnosticCodes = [
    ...(id.missing ? [`${source}_id_missing`] : []),
    ...(id.invalid ? [`${source}_id_invalid`] : []),
    ...type.diagnosticCodes,
    ...name.diagnosticCodes,
  ];
  const argumentSummary = argumentsValue === undefined
    ? { shape: "undefined" as const, diagnosticCodes: [`${source}_arguments_missing`] }
    : source === "native"
      ? summarizeProviderArguments(argumentsValue)
      : summarizeStructuredArguments(argumentsValue);
  for (const code of [...diagnosticCodes, ...argumentSummary.diagnosticCodes]) diagnostics.add(code);
  return {
    id: id.value,
    idLength: id.length,
    type: type.value,
    typeLength: type.length,
    name: name.value,
    nameLength: name.length,
    arguments: argumentSummary,
    redactedFields,
    diagnosticCodes: [...new Set([...diagnosticCodes, ...argumentSummary.diagnosticCodes])].sort(),
  };
}

function emptyToolCall(code: string): ProviderToolCallSummary {
  return {
    id: null,
    idLength: 0,
    type: null,
    typeLength: 0,
    name: null,
    nameLength: 0,
    arguments: { shape: "undefined", diagnosticCodes: [code] },
    redactedFields: [],
    diagnosticCodes: [code],
  };
}

function summarizeArgumentValue(value: unknown): ProviderArgumentSummary {
  if (isPlainRecord(value)) return { shape: "object", keyCount: Object.keys(value).length, diagnosticCodes: [] };
  if (Array.isArray(value)) return { shape: "array", itemCount: value.length, diagnosticCodes: [] };
  return { shape: shapeOf(value), diagnosticCodes: [] };
}

function summarizeStructuredArguments(value: unknown): ProviderArgumentSummary {
  const summary = summarizeArgumentValue(value);
  if (summary.shape === "object") return summary;
  return {
    ...summary,
    ...(typeof value === "string" ? { serializedLength: value.length } : {}),
    diagnosticCodes: [...summary.diagnosticCodes, "structured_arguments_not_object"],
  };
}

function readDiagnosticCodes(value: Record<string, unknown> | null): string[] {
  if (value === null || !Array.isArray(value.diagnosticCodes)) return [];
  return value.diagnosticCodes.filter((item): item is string => typeof item === "string");
}

function classifyTransportError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("abort") || lower.includes("cancel")) return "aborted";
  if (lower.includes("timeout") || lower.includes("deadline")) return "timeout";
  if (lower.includes("http") || lower.includes("status")) return "http";
  if (lower.includes("network") || lower.includes("fetch") || lower.includes("socket") || lower.includes("econn")) return "network";
  return "transport_error";
}

function opaqueIdentifier(value: unknown): OpaqueIdentifier {
  if (value === undefined) return { value: null, length: 0, invalid: false, missing: true };
  if (typeof value !== "string" || value.length === 0) {
    return { value: null, length: typeof value === "string" ? value.length : 0, invalid: true, missing: false };
  }
  // Hash all non-empty strings, including control characters and token-like
  // values. No lexical heuristic can prove an opaque provider id harmless.
  const digest = createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
  return { value: `${OPAQUE_ID_PREFIX}${digest}`, length: value.length, invalid: false, missing: false };
}

function allowlistedString(
  value: unknown,
  allowed: ReadonlySet<string>,
  field: string,
  diagnostics: Set<string>,
): SafeIdentifier & { diagnosticCodes: string[] } {
  const diagnosticCodes: string[] = [];
  if (value === undefined) return { value: null, length: 0, redacted: false, diagnosticCodes };
  if (typeof value !== "string") {
    diagnosticCodes.push(`${field}_invalid`);
    diagnostics.add(`${field}_invalid`);
    return { value: null, length: 0, redacted: true, diagnosticCodes };
  }
  if (!allowed.has(value)) {
    diagnosticCodes.push(`${field}_unknown`);
    diagnostics.add(`${field}_unknown`);
    return { value: null, length: value.length, redacted: true, diagnosticCodes };
  }
  return { value, length: value.length, redacted: false, diagnosticCodes };
}

function requestScopedToolName(value: unknown, allowed: ReadonlySet<string>, source: "native" | "structured", diagnostics: Set<string>): SafeIdentifier & { diagnosticCodes: string[] } {
  if (value === undefined) {
    const diagnosticCodes = [`${source}_name_missing`];
    diagnostics.add(`${source}_name_missing`);
    return { value: null, length: 0, redacted: false, diagnosticCodes };
  }
  if (typeof value !== "string") {
    const diagnosticCodes = [`${source}_name_invalid`];
    diagnostics.add(`${source}_name_invalid`);
    return { value: null, length: 0, redacted: true, diagnosticCodes };
  }
  if (!allowed.has(value)) {
    const diagnosticCodes = [`${source}_name_unknown`];
    diagnostics.add(`${source}_name_unknown`);
    return { value: null, length: value.length, redacted: true, diagnosticCodes };
  }
  return { value, length: value.length, redacted: false, diagnosticCodes: [] };
}

function normalizeAllowedToolNames(value: ProviderSummaryOptions["allowedToolNames"]): ReadonlySet<string> {
  if (value === undefined) return new Set();
  const values: readonly string[] = Array.isArray(value) ? value : [...value];
  return new Set(values.filter((item): item is string => typeof item === "string"));
}

function safeRequestToolName(value: string): string | null {
  // The request schema is locally generated and is the sole trust source for
  // response names. Still reject malformed/control-bearing names before they
  // can reach JSONL or become the response allowlist.
  return value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(value) ? value : null;
}

function readRequestToolNames(body: Record<string, unknown>): string[] {
  const nativeTools = body.tools;
  if (Array.isArray(nativeTools)) {
    return nativeTools.flatMap((item) => {
      if (!isPlainRecord(item) || !isPlainRecord(item.function)) return [];
      return typeof item.function.name === "string" ? [item.function.name] : [];
    });
  }
  const responseFormat = isPlainRecord(body.response_format) ? body.response_format : undefined;
  const jsonSchema = responseFormat !== undefined && isPlainRecord(responseFormat.json_schema) ? responseFormat.json_schema : undefined;
  const schema = jsonSchema !== undefined && isPlainRecord(jsonSchema.schema) ? jsonSchema.schema : undefined;
  const properties = schema !== undefined && isPlainRecord(schema.properties) ? schema.properties : undefined;
  const calls = properties !== undefined && isPlainRecord(properties.calls) ? properties.calls : undefined;
  const items = calls !== undefined && isPlainRecord(calls.items) ? calls.items : undefined;
  const name = items !== undefined && isPlainRecord(items.properties) && isPlainRecord(items.properties.name)
    ? items.properties.name
    : undefined;
  return name !== undefined && Array.isArray(name.enum)
    ? name.enum.filter((item): item is string => typeof item === "string")
    : [];
}

function shapeOf(value: unknown): DiagnosticShape {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const type = typeof value;
  return type === "object" ? "object" : type as DiagnosticShape;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
