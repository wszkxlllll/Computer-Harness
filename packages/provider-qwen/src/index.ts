import type {
  JsonValue,
  ModelUsage,
  ModelTurn,
  ToolCall,
  ToolCallId,
  Viewport,
} from "@computer-harness/protocol";
import type {
  AssetReader,
  CoordinateField,
  ModelContentBlock,
  ModelInput,
  ModelMessage,
  ModelToolSpec,
  ProviderAdapter,
} from "@computer-harness/runtime";

export interface QwenImagePreprocessorInput {
  bytes: Uint8Array;
  mediaType: string;
  viewport: Viewport;
}

export interface QwenPreparedImage {
  bytes: Uint8Array;
  mediaType: string;
  /** Pixel viewport of the bytes actually presented to the model. */
  viewport: Viewport;
}

export type QwenCoordinateMode = "normalized_1000" | "actual_pixels";

/** May re-encode/resize the full image; cropping requires a different spatial contract. */
export type QwenImagePreprocessor =
  (input: QwenImagePreprocessorInput, signal: AbortSignal) => Promise<QwenPreparedImage>;

interface QwenImageSpace {
  /** Observation/Computer coordinate space used by canonical Harness actions. */
  source: Viewport;
  /** Pixel coordinate space of the image bytes sent to Qwen. */
  presented: Viewport;
}

interface QwenPresentedMessages {
  messages: unknown[];
  latestImageSpace?: QwenImageSpace;
}

export interface QwenHttpClient {
  post(url: string, body: Record<string, unknown>, headers: Readonly<Record<string, string>>, signal: AbortSignal): Promise<unknown>;
}

export type QwenRetryMode = "same_input" | "feedback";

export interface FetchQwenHttpClientOptions {
  /** Maximum wall-clock time for fetch plus response-body consumption. */
  readonly requestTimeoutMs?: number;
}

/** Thinking modes supported by the qwen3.8-flash profile. */
export type Qwen38ThinkingMode = "disabled" | "low" | "medium" | "xhigh";

/** Wire-level output protocols supported by the Qwen adapter. */
export type Qwen38OutputMode = "native_tools" | "strict_json";

export interface Qwen38AdapterOptions {
  apiKey: string;
  assetReader: AssetReader;
  /** Full endpoint or a compatible-mode base URL. */
  endpoint?: string;
  workspaceId?: string;
  coordinateMode?: QwenCoordinateMode;
  thinking?: Qwen38ThinkingMode;
  /** Defaults to the official strict JSON response format. */
  outputMode?: Qwen38OutputMode;
  imagePreprocessor?: QwenImagePreprocessor;
  httpClient?: QwenHttpClient;
}

export class QwenProviderError extends Error {
  public constructor(
    message: string,
    public readonly code = "QWEN_PROVIDER_ERROR",
    public readonly retryable = isRetryableQwenErrorCode(code),
    public readonly retryMode: QwenRetryMode = "feedback",
  ) {
    super(message);
    this.name = "QwenProviderError";
  }
}

/**
 * Provider profile for Qwen3.8-Flash's ordinary OpenAI-compatible Function
 * Calling interface. Its wire arguments stay aligned with the canonical
 * per-tool Harness schemas rather than a provider-specific coordinate format.
 */
export class Qwen38FlashAdapter implements ProviderAdapter {
  public readonly id = "qwen3.8-flash";
  private readonly apiKey: string;
  private readonly assetReader: AssetReader;
  private readonly endpoint: string;
  private readonly coordinateMode: QwenCoordinateMode;
  private readonly thinking: Qwen38ThinkingMode;
  private readonly outputMode: Qwen38OutputMode;
  private readonly imagePreprocessor: QwenImagePreprocessor;
  private readonly httpClient: QwenHttpClient;

  public constructor(options: Qwen38AdapterOptions) {
    if (options.apiKey.trim().length === 0) throw new Error("Qwen apiKey must be non-empty");
    this.apiKey = options.apiKey;
    this.assetReader = options.assetReader;
    this.endpoint = resolveQwenEndpoint(options.endpoint, options.workspaceId);
    this.coordinateMode = options.coordinateMode ?? "normalized_1000";
    this.thinking = options.thinking ?? "low";
    this.outputMode = options.outputMode ?? "strict_json";
    this.imagePreprocessor = options.imagePreprocessor ?? identityImagePreprocessor;
    this.httpClient = options.httpClient ?? new FetchQwenHttpClient();
  }

  public async generate(input: ModelInput, options: { signal: AbortSignal }): Promise<ModelTurn> {
    options.signal.throwIfAborted();
    const presentation = await this.presentMessages(input.system, input.messages, input.tools, options.signal);
    const body: Record<string, unknown> = {
      model: this.id,
      messages: presentation.messages,
      ...(this.outputMode === "strict_json"
        ? { response_format: qwen38ResponseFormat(input, this.coordinateMode, presentation.latestImageSpace?.presented) }
        : {
            tools: qwen38FunctionTools(input, this.coordinateMode, presentation.latestImageSpace?.presented),
            tool_choice: "auto",
            parallel_tool_calls: false,
          }),
      stream: false,
      temperature: 0,
      vl_high_resolution_images: true,
      ...(this.thinking === "disabled"
        ? { enable_thinking: false, preserve_thinking: false }
        : { reasoning_effort: this.thinking, preserve_thinking: true }),
    };
    const response = await this.httpClient.post(
      this.endpoint,
      body,
      { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      options.signal,
    );
    options.signal.throwIfAborted();
    return this.outputMode === "strict_json"
      ? this.parseStructuredResponse(response, input, presentation.latestImageSpace)
      : this.parseResponse(response, input, presentation.latestImageSpace);
  }

  private async presentMessages(system: string, messages: readonly ModelMessage[], tools: readonly ModelToolSpec[], signal: AbortSignal): Promise<QwenPresentedMessages> {
    const result: unknown[] = [{ role: "system", content: system }];
    let latestImageSpace: QwenImageSpace | undefined;
    for (const message of messages) {
      signal.throwIfAborted();
      if (message.role === "tool") {
        const block = message.content.find((item) => item.type === "tool_result");
        if (block?.type === "tool_result") {
          if (this.outputMode === "strict_json") {
            result.push({ role: "user", content: `Tool result for ${block.result.callId}: ${JSON.stringify(block.result)}` });
          } else {
            result.push({ role: "tool", tool_call_id: block.result.callId, content: JSON.stringify(block.result) });
          }
        }
        continue;
      }
      const contentParts: unknown[] = [];
      const historicalCalls: unknown[] = [];
      const strictHistoricalCalls: string[] = [];
      let reasoningContent: string | undefined;
      for (const block of message.content) {
        if (block.type === "text") {
          contentParts.push({ type: "text", text: block.text });
        } else if (block.type === "image") {
          const bytes = await this.assetReader.read(block.asset, signal);
          const prepared = validatePreparedImage(await this.imagePreprocessor({ bytes, mediaType: block.asset.mediaType, viewport: block.viewport }, signal));
          latestImageSpace = { source: block.viewport, presented: prepared.viewport };
          contentParts.push({ type: "image_url", image_url: { url: toDataUrl(prepared.mediaType, prepared.bytes) } });
        } else if (block.type === "provider_continuation") {
          if (block.continuation.providerId !== this.id || block.continuation.kind !== "reasoning_content") continue;
          if (reasoningContent !== undefined && reasoningContent !== block.continuation.content) {
            throw new QwenProviderError("Qwen history contains conflicting reasoning continuations", "QWEN_INVALID_HISTORY");
          }
          reasoningContent = block.continuation.content;
        } else if (block.type === "tool_call") {
          const tool = tools.find((item) => item.name === block.call.name);
          const historical = formatQwen38HistoricalCall(block, this.coordinateMode, latestImageSpace, tool?.coordinate?.fields);
          historicalCalls.push(historical);
          if (this.outputMode === "strict_json") {
            strictHistoricalCalls.push(JSON.stringify({
              kind: "tool_call",
              id: block.call.id,
              name: block.call.name,
              arguments: isRecord(historical) && isRecord(historical.function) && typeof historical.function.arguments === "string"
                ? JSON.parse(historical.function.arguments) as JsonValue
                : block.call.arguments,
            }));
          }
        }
      }
      const presented: Record<string, unknown> = {
        role: message.role,
        content: this.outputMode === "strict_json" && strictHistoricalCalls.length > 0
          ? [...contentParts.filter((part): part is { type: "text"; text: string } => isRecord(part) && part.type === "text" && typeof part.text === "string").map((part) => part.text), ...strictHistoricalCalls].join("\n")
          : message.role === "assistant"
          ? contentParts.filter((part): part is { type: "text"; text: string } => isRecord(part) && part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n")
          : contentParts,
      };
      if (reasoningContent !== undefined) presented.reasoning_content = reasoningContent;
      if (this.outputMode === "native_tools" && historicalCalls.length > 0) presented.tool_calls = historicalCalls;
      result.push(presented);
    }
    return { messages: result, ...(latestImageSpace === undefined ? {} : { latestImageSpace }) };
  }

  private parseResponse(value: unknown, input: ModelInput, imageSpace: QwenImageSpace | undefined): ModelTurn {
    const response = readAssistantResponse(value);
    assertCompleteFinishReason(response.finishReason);
    const usage = response.usage;
    const continuation = response.reasoningContent === undefined
      ? undefined
      : { providerId: this.id, kind: "reasoning_content" as const, content: response.reasoningContent };
    if (response.calls.length > 0) {
      const ids = new Set<string>();
      const mapped: MappedQwen38Call[] = [];
      for (const raw of response.calls) {
        const parsed = readQwen38RawCall(raw);
        if (ids.has(parsed.id)) throw new QwenProviderError(`Qwen returned duplicate ToolCall id: ${parsed.id}`, "QWEN_DUPLICATE_TOOL_CALL");
        ids.add(parsed.id);
        mapped.push(mapQwen38ToolCall(parsed, input, imageSpace, this.coordinateMode));
      }
      const control = mapped.filter((item) => item.type !== "call");
      if (control.length > 0) {
        if (mapped.length !== 1) throw new QwenProviderError("Qwen control calls cannot be mixed with other tool calls", "QWEN_INVALID_TOOL_CALL");
        const only = control[0]!;
        if (only.type === "finish") return { ...only, ...(usage === undefined ? {} : { usage }) };
        return { type: "user_input_required", question: only.question, ...(usage === undefined ? {} : { usage }) };
      }
      const calls = mapped.map((item) => {
        if (item.type !== "call") throw new QwenProviderError("Qwen control calls cannot be mixed with other tool calls", "QWEN_INVALID_TOOL_CALL");
        return item.call;
      });
      const assistantText = response.content.trim();
      return {
        type: "tool_calls",
        calls,
        ...(assistantText.length === 0 ? {} : { assistantText }),
        ...(continuation === undefined ? {} : { continuation }),
        ...(usage === undefined ? {} : { usage }),
      };
    }
    if (/<\/?tool_call\b/iu.test(response.content) || /```[\s\S]*?(?:"name"|"type")\s*:\s*"computer_use"/iu.test(response.content) || looksLikeUntaggedComputerUseJson(response.content)) {
      throw new QwenProviderError("Qwen returned a computer_use payload in text instead of native tool_calls", "QWEN_UNTAGGED_TOOL_CALL");
    }
    if (response.finishReason === "tool_calls") throw new QwenProviderError("Qwen tool_calls finish reason has no calls", "QWEN_INVALID_RESPONSE");
    if (response.content.trim().length > 0) {
      throw new QwenProviderError(
        "Qwen returned plain assistant text without an explicit terminate tool call",
        "QWEN_UNCONFIRMED_FINISH",
      );
    }
    throw new QwenProviderError("Qwen returned an empty assistant response", "QWEN_EMPTY_RESPONSE");
  }

  private parseStructuredResponse(value: unknown, input: ModelInput, imageSpace: QwenImageSpace | undefined): ModelTurn {
    const response = readAssistantResponse(value);
    assertCompleteFinishReason(response.finishReason);
    if (response.calls.length > 0) {
      throw new QwenProviderError("Qwen strict JSON mode returned native tool_calls; expected a JSON content envelope", "QWEN_INVALID_RESPONSE");
    }
    const text = response.content.trim();
    if (text.length === 0) throw new QwenProviderError("Qwen strict JSON mode returned empty content", "QWEN_EMPTY_RESPONSE");
    let envelope: unknown;
    try {
      envelope = JSON.parse(text) as unknown;
    } catch (error) {
      throw new QwenProviderError(`Qwen strict JSON content is not JSON: ${error instanceof Error ? error.message : String(error)}`, "QWEN_INVALID_RESPONSE");
    }
    if (!isRecord(envelope) || typeof envelope.kind !== "string") {
      throw new QwenProviderError("Qwen strict JSON response must contain a string kind", "QWEN_INVALID_RESPONSE");
    }
    const usage = response.usage;
    const envelopeArguments = isRecord(envelope.arguments) ? envelope.arguments : undefined;
    if (typeof envelope.id !== "string" || envelope.id.trim().length === 0 || typeof envelope.name !== "string" || envelopeArguments === undefined) {
      throw new QwenProviderError("Qwen strict JSON envelope requires id, name, and object arguments", "QWEN_INVALID_RESPONSE");
    }
    if (envelope.kind !== "tool_call") {
      throw new QwenProviderError(`Qwen strict JSON returned unsupported kind: ${envelope.kind}; expected tool_call`, "QWEN_INVALID_RESPONSE");
    }
    const call = mapQwen38ToolCall(
      { id: envelope.id as ToolCallId, name: envelope.name, arguments: envelopeArguments as Record<string, JsonValue> },
      input,
      imageSpace,
      this.coordinateMode,
    );
    if (call.type === "finish") {
      return { ...call, ...(usage === undefined ? {} : { usage }) };
    }
    if (call.type === "user_input_required") {
      return { ...call, ...(usage === undefined ? {} : { usage }) };
    }
    return {
      type: "tool_calls",
      calls: [call.call],
      ...(usage === undefined ? {} : { usage }),
    };
  }
}

function looksLikeUntaggedComputerUseJson(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) && parsed.name === "computer_use" && isRecord(parsed.arguments);
  } catch {
    return false;
  }
}

export class FetchQwenHttpClient implements QwenHttpClient {
  private readonly requestTimeoutMs: number;

  public constructor(options: FetchQwenHttpClientOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 240_000;
    if (!Number.isInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new Error("Qwen requestTimeoutMs must be a positive integer");
    }
  }

  public async post(url: string, body: Record<string, unknown>, headers: Readonly<Record<string, string>>, signal: AbortSignal): Promise<unknown> {
    const requestController = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      requestController.abort(new Error(`Qwen request deadline exceeded after ${this.requestTimeoutMs}ms`));
    }, this.requestTimeoutMs);
    const abortRequest = () => requestController.abort(signal.reason);
    if (signal.aborted) abortRequest();
    else signal.addEventListener("abort", abortRequest, { once: true });
    let response: Response;
    try {
      response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: requestController.signal });
    } catch (error) {
      try {
        if (signal.aborted) throw signal.reason ?? error;
        if (timedOut) throw new QwenProviderError(`Qwen request timed out after ${this.requestTimeoutMs}ms`, "QWEN_REQUEST_TIMEOUT", true, "same_input");
        throw new QwenProviderError(
          `Qwen network request failed: ${error instanceof Error ? error.message : String(error)}`,
          "QWEN_NETWORK_ERROR",
          true,
          "same_input",
        );
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abortRequest);
      }
    }
    try {
      const payload = await response.json().catch((error: unknown) => {
        if (signal.aborted) throw signal.reason ?? error;
        if (timedOut) throw new QwenProviderError(`Qwen response body timed out after ${this.requestTimeoutMs}ms`, "QWEN_REQUEST_TIMEOUT", true, "same_input");
        throw new QwenProviderError(`Qwen response body could not be read: ${error instanceof Error ? error.message : String(error)}`, "QWEN_NETWORK_ERROR", true, "same_input");
      }) as unknown;
      if (!response.ok) {
        const providerMessage = readQwenErrorMessage(payload);
        const retryable = response.status === 429 || response.status >= 500;
        throw new QwenProviderError(
          `Qwen HTTP ${response.status}${providerMessage === undefined ? "" : `: ${providerMessage.slice(0, 240)}`}`,
          `QWEN_HTTP_${response.status}`,
          retryable,
          retryable ? "same_input" : "feedback",
        );
      }
      return payload;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abortRequest);
    }
  }
}

function readQwenErrorMessage(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.error) || typeof value.error.message !== "string" || value.error.message.trim().length === 0) return undefined;
  return value.error.message;
}

const identityImagePreprocessor: QwenImagePreprocessor = async (input, signal) => {
  signal.throwIfAborted();
  return input;
};

function validatePreparedImage(image: QwenPreparedImage): QwenPreparedImage {
  const { width, height, coordinateSpace } = image.viewport;
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0 || coordinateSpace !== "physical") {
    throw new QwenProviderError("Qwen image preprocessor returned an invalid pixel viewport", "QWEN_INVALID_PREPARED_IMAGE");
  }
  if (image.bytes.byteLength === 0 || image.mediaType.trim().length === 0) {
    throw new QwenProviderError("Qwen image preprocessor returned empty image data", "QWEN_INVALID_PREPARED_IMAGE");
  }
  return image;
}

const QWEN_PUBLIC_ENDPOINT = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";

function resolveQwenEndpoint(explicit: string | undefined, workspaceId: string | undefined): string {
  const candidate = explicit?.trim();
  if (candidate !== undefined && candidate.length > 0) return normalizeEndpoint(candidate);
  const workspace = workspaceId?.trim();
  if (workspace !== undefined && workspace.length > 0) {
    return `https://${workspace}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions`;
  }
  return QWEN_PUBLIC_ENDPOINT;
}

function normalizeEndpoint(value: string): string {
  const endpoint = value.replace(/\/+$/, "");
  if (endpoint.endsWith("/chat/completions")) return endpoint;
  if (endpoint.endsWith("/v1")) return `${endpoint}/chat/completions`;
  return `${endpoint}/chat/completions`;
}

function toDataUrl(mediaType: string, bytes: Uint8Array): string {
  return `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
}

function readAssistantResponse(value: unknown): { content: string; finishReason?: string; calls: unknown[]; reasoningContent?: string; usage?: ModelUsage } {
  if (!isRecord(value) || !Array.isArray(value.choices) || value.choices.length === 0) throw new QwenProviderError("Qwen response has no choices", "QWEN_INVALID_RESPONSE");
  const first = value.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) throw new QwenProviderError("Qwen response has no assistant message", "QWEN_INVALID_RESPONSE");
  const calls = first.message.tool_calls;
  if (calls !== undefined && !Array.isArray(calls)) throw new QwenProviderError("Qwen tool_calls must be an array", "QWEN_INVALID_RESPONSE");
  const content = first.message.content;
  if (content !== undefined && content !== null && typeof content !== "string") throw new QwenProviderError("Qwen response has invalid assistant text", "QWEN_INVALID_RESPONSE");
  const reasoningContent = first.message.reasoning_content;
  if (reasoningContent !== undefined && typeof reasoningContent !== "string") throw new QwenProviderError("Qwen reasoning_content must be a string", "QWEN_INVALID_RESPONSE");
  if (first.finish_reason !== undefined && typeof first.finish_reason !== "string") throw new QwenProviderError("Qwen response has an invalid finish_reason", "QWEN_INVALID_RESPONSE");
  const usage = readUsage(value);
  return {
    content: typeof content === "string" ? content : "",
    calls: calls ?? [],
    ...(typeof first.finish_reason === "string" ? { finishReason: first.finish_reason } : {}),
    ...(typeof reasoningContent === "string" ? { reasoningContent } : {}),
    ...(usage === undefined ? {} : { usage }),
  };
}

function assertCompleteFinishReason(reason: string | undefined): void {
  if (reason !== undefined && reason !== "stop" && reason !== "tool_calls") {
    throw new QwenProviderError(`Qwen response ended with incomplete finish_reason: ${reason}`, "QWEN_INCOMPLETE_RESPONSE");
  }
}

function readUsage(value: unknown): ModelUsage | undefined {
  if (!isRecord(value) || !isRecord(value.usage)) return undefined;
  const usage = value.usage;
  const inputTokens = usage.prompt_tokens;
  const outputTokens = usage.completion_tokens;
  const totalTokens = usage.total_tokens;
  if (![inputTokens, outputTokens, totalTokens].some((item) => item !== undefined)) return undefined;
  const parsed = {
    ...(typeof inputTokens === "number" && Number.isInteger(inputTokens) && inputTokens >= 0 ? { inputTokens } : {}),
    ...(typeof outputTokens === "number" && Number.isInteger(outputTokens) && outputTokens >= 0 ? { outputTokens } : {}),
    ...(typeof totalTokens === "number" && Number.isInteger(totalTokens) && totalTokens >= 0 ? { totalTokens } : {}),
  };
  return Object.keys(parsed).length === 0 ? undefined : parsed;
}

type MappedQwen38Call =
  | { type: "call"; call: ToolCall }
  | { type: "finish"; summary: string; reportedStatus: "success" | "failure" }
  | { type: "user_input_required"; question: string };

function qwen38FunctionTools(input: ModelInput, coordinateMode: QwenCoordinateMode, viewport: Viewport | undefined): Record<string, unknown>[] {
  const tools = input.tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: `${tool.description}${qwen38CoordinateDescription(tool.coordinate?.fields, coordinateMode, viewport)}`,
      parameters: qwen38ToolParameters(tool, coordinateMode, viewport),
    },
  }));
  return tools;
}

function qwen38ResponseFormat(input: ModelInput, coordinateMode: QwenCoordinateMode, viewport: Viewport | undefined): Record<string, unknown> {
  const variants = input.tools.map((tool): JsonValue => ({
    type: "object",
    properties: {
      // All wire-level calls share one envelope. Control semantics are resolved
      // from the canonical ToolRegistry metadata after name/arguments parsing.
      kind: { type: "string", enum: ["tool_call"] },
      id: { type: "string", minLength: 1 },
      name: { type: "string", enum: [tool.name] },
      arguments: qwen38ToolParameters(tool, coordinateMode, viewport),
    },
    required: ["kind", "id", "name", "arguments"],
    additionalProperties: false,
  }));
  return {
    type: "json_schema",
    json_schema: {
      name: "qwen_model_turn",
      strict: true,
      schema: {
        type: "object",
        anyOf: variants,
      },
    },
  };
}

function qwen38ToolParameters(tool: ModelToolSpec, coordinateMode: QwenCoordinateMode, viewport: Viewport | undefined): JsonValue {
  const providedSchema = tool.inputSchema;
  const hasProperties = typeof providedSchema === "object" && providedSchema !== null && !Array.isArray(providedSchema)
    && typeof (providedSchema as Record<string, JsonValue>).properties === "object"
    && (providedSchema as Record<string, JsonValue>).properties !== null
    && !Array.isArray((providedSchema as Record<string, JsonValue>).properties);
  const schema = providedSchema === undefined || (tool.coordinate !== undefined && !hasProperties) ? qwen38FallbackSchema(tool.coordinate?.fields) : providedSchema;
  if (tool.coordinate === undefined) return schema;
  return addQwen38CoordinateBounds(schema, tool.coordinate.fields, coordinateMode, viewport);
}

function qwen38FallbackSchema(fields: readonly CoordinateField[] | undefined): JsonValue {
  if (fields === undefined) return { type: "object", properties: {}, additionalProperties: false };
  if (fields.length === 2 && fields.includes("x") && fields.includes("y")) {
    return { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"], additionalProperties: false };
  }
  if (fields.length === 4 && fields.includes("fromX") && fields.includes("fromY") && fields.includes("toX") && fields.includes("toY")) {
    return { type: "object", properties: { fromX: { type: "number" }, fromY: { type: "number" }, toX: { type: "number" }, toY: { type: "number" } }, required: ["fromX", "fromY", "toX", "toY"], additionalProperties: false };
  }
  return { type: "object", properties: {}, additionalProperties: false };
}

function addQwen38CoordinateBounds(schema: JsonValue, fields: readonly CoordinateField[], coordinateMode: QwenCoordinateMode, viewport: Viewport | undefined): JsonValue {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return schema;
  const record = schema as Record<string, JsonValue>;
  if (typeof record.properties !== "object" || record.properties === null || Array.isArray(record.properties)) return schema;
  const properties = { ...(record.properties as Record<string, JsonValue>) };
  for (const key of fields) {
    const property = properties[key];
    if (typeof property !== "object" || property === null || Array.isArray(property)) continue;
    const isX = key.endsWith("X") || key === "x";
    const max = coordinateMode === "normalized_1000" ? 1000 : viewport === undefined ? undefined : isX ? viewport.width - 1 : viewport.height - 1;
    const suffix = coordinateMode === "normalized_1000"
      ? "Normalized coordinate from 0 to 1000 relative to the current image."
      : viewport === undefined
        ? "Physical pixel coordinate in the current image viewport."
        : `Physical pixel coordinate in the current image viewport (range ${isX ? `0-${viewport.width - 1}` : `0-${viewport.height - 1}`}).`;
    properties[key] = {
      ...(property as Record<string, JsonValue>),
      description: `${typeof (property as Record<string, JsonValue>).description === "string" ? `${String((property as Record<string, JsonValue>).description)} ` : ""}${suffix}`,
      minimum: 0,
      ...(max === undefined ? {} : { maximum: max }),
    };
  }
  return { ...record, properties };
}

function qwen38CoordinateDescription(fields: readonly CoordinateField[] | undefined, coordinateMode: QwenCoordinateMode, viewport: Viewport | undefined): string {
  if (fields === undefined) return "";
  if (coordinateMode === "normalized_1000") return ` Coordinates ${fields.join(",")} are normalized numbers from 0 to 1000 relative to the current image.`;
  return viewport === undefined
    ? ` Coordinates ${fields.join(",")} are physical pixels in the current image viewport.`
    : ` Coordinates ${fields.join(",")} are physical pixels in the current image viewport.`;
}

function formatQwen38HistoricalCall(
  block: Extract<ModelContentBlock, { type: "tool_call" }>,
  coordinateMode: QwenCoordinateMode,
  imageSpace: QwenImageSpace | undefined,
  fields: readonly CoordinateField[] | undefined,
): unknown {
  const args = jsonRecord(block.call.arguments);
  if (args === undefined) throw new QwenProviderError("Qwen history tool arguments must be an object", "QWEN_INVALID_HISTORY");
  const wire = encodeQwen38Arguments(args, fields, block.viewport, presentedViewportForSource(block.viewport, imageSpace), coordinateMode);
  return { id: block.call.id, type: "function", function: { name: block.call.name, arguments: JSON.stringify(wire) } };
}

function encodeQwen38Arguments(
  args: Record<string, JsonValue>,
  fields: readonly CoordinateField[] | undefined,
  sourceViewport: Viewport | undefined,
  presentedViewport: Viewport | undefined,
  coordinateMode: QwenCoordinateMode,
): Record<string, JsonValue> {
  if (fields === undefined || sourceViewport === undefined) return args;
  const result = { ...args };
  for (const key of fields.filter((item) => item === "x" || item === "fromX" || item === "toX")) {
    const value = result[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      result[key] = coordinateMode === "normalized_1000"
        ? pixelToNormalized(value, sourceViewport.width)
        : scalePixel(value, sourceViewport.width, presentedViewport?.width ?? sourceViewport.width);
    }
  }
  for (const key of fields.filter((item) => item === "y" || item === "fromY" || item === "toY")) {
    const value = result[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      result[key] = coordinateMode === "normalized_1000"
        ? pixelToNormalized(value, sourceViewport.height)
        : scalePixel(value, sourceViewport.height, presentedViewport?.height ?? sourceViewport.height);
    }
  }
  return result;
}

function pixelToNormalized(value: number, size: number): number {
  return size <= 1 ? 0 : value * 1000 / (size - 1);
}

function normalizedToPixel(value: number, size: number): number {
  return size <= 1 ? 0 : value * (size - 1) / 1000;
}

function scalePixel(value: number, fromSize: number, toSize: number): number {
  return fromSize <= 1 || toSize <= 1 ? 0 : value * (toSize - 1) / (fromSize - 1);
}

function presentedViewportForSource(source: Viewport | undefined, imageSpace: QwenImageSpace | undefined): Viewport | undefined {
  return source !== undefined
    && imageSpace !== undefined
    && imageSpace.source.width === source.width
    && imageSpace.source.height === source.height
    && imageSpace.source.coordinateSpace === source.coordinateSpace
    ? imageSpace.presented
    : source;
}

function readQwen38RawCall(value: unknown): { id: ToolCallId; name: string; arguments: JsonValue } {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.trim().length === 0 || value.type !== "function" || !isRecord(value.function) || typeof value.function.name !== "string" || typeof value.function.arguments !== "string") {
    throw new QwenProviderError("Qwen native function call requires id, function name, and JSON arguments", "QWEN_INVALID_TOOL_CALL");
  }
  let args: unknown;
  try {
    args = JSON.parse(value.function.arguments) as unknown;
  } catch (error) {
    throw new QwenProviderError(`Qwen tool_call is not JSON: ${error instanceof Error ? error.message : String(error)}`, "QWEN_INVALID_TOOL_CALL");
  }
  if (!isJsonValue(args)) throw new QwenProviderError("Qwen tool arguments are not JSON-safe", "QWEN_INVALID_TOOL_CALL");
  return { id: value.id as ToolCallId, name: value.function.name, arguments: args };
}

function mapQwen38ToolCall(
  value: { id: ToolCallId; name: string; arguments: JsonValue },
  input: ModelInput,
  imageSpace: QwenImageSpace | undefined,
  coordinateMode: QwenCoordinateMode,
): MappedQwen38Call {
  const args = jsonRecord(value.arguments);
  if (args === undefined) throw new QwenProviderError("Qwen function arguments must be an object", "QWEN_INVALID_TOOL_CALL");
  const tool = input.tools.find((item) => item.name === value.name);
  if (tool === undefined) throw new QwenProviderError(`Qwen selected a tool not offered by this run: ${value.name}`, "QWEN_UNAVAILABLE_TOOL");
  if (tool.control === "finish") {
    if (args.status !== "success" && args.status !== "failure") throw new QwenProviderError(`${value.name} requires status success or failure`, "QWEN_INVALID_TOOL_CALL");
    return { type: "finish", summary: typeof args.text === "string" && args.text.trim().length > 0 ? args.text : `Qwen3.8 terminated with ${args.status}`, reportedStatus: args.status };
  }
  if (tool.control === "user_input_required") {
    if (typeof args.text !== "string" || args.text.trim().length === 0) throw new QwenProviderError(`${value.name} requires text`, "QWEN_INVALID_TOOL_CALL");
    return { type: "user_input_required", question: args.text };
  }
  return { type: "call", call: { id: value.id, name: value.name, arguments: mapQwen38Arguments(args, tool.coordinate?.fields, value.name, imageSpace, coordinateMode) } };
}

function mapQwen38Arguments(args: Record<string, JsonValue>, fields: readonly CoordinateField[] | undefined, toolName: string, imageSpace: QwenImageSpace | undefined, coordinateMode: QwenCoordinateMode): Record<string, JsonValue> {
  const coordinateKeys = fields ?? [];
  const result = { ...args };
  for (const key of coordinateKeys) {
    const value = result[key];
    if (typeof value !== "number" || !Number.isFinite(value)) throw new QwenProviderError(`Qwen ${toolName}.${key} must be a finite number`, "QWEN_INVALID_TOOL_CALL");
    const isX = key.endsWith("X") || key === "x";
    const presentedSize = imageSpace === undefined ? undefined : isX ? imageSpace.presented.width : imageSpace.presented.height;
    const max = coordinateMode === "normalized_1000" ? 1000 : presentedSize === undefined ? undefined : presentedSize - 1;
    if (value < 0 || (max !== undefined && value > max)) throw new QwenProviderError(`Qwen ${coordinateMode} coordinate ${toolName}.${key} is out of range`, "QWEN_COORDINATE_OUT_OF_RANGE");
    if (coordinateMode === "normalized_1000") {
      if (imageSpace === undefined) throw new QwenProviderError("Qwen normalized coordinates require an image viewport", "QWEN_MISSING_VIEWPORT");
      result[key] = normalizedToPixel(value, isX ? imageSpace.source.width : imageSpace.source.height);
    } else if (imageSpace !== undefined) {
      result[key] = scalePixel(
        value,
        isX ? imageSpace.presented.width : imageSpace.presented.height,
        isX ? imageSpace.source.width : imageSpace.source.height,
      );
    }
  }
  if (toolName === "type" && typeof result.text !== "string") throw new QwenProviderError("Qwen type requires text", "QWEN_INVALID_TOOL_CALL");
  if ((toolName === "keypress" || toolName === "hotkey") && (!Array.isArray(result.keys) || result.keys.some((key) => typeof key !== "string"))) throw new QwenProviderError(`Qwen ${toolName} requires string keys`, "QWEN_INVALID_TOOL_CALL");
  if (toolName === "scroll") {
    if (typeof result.direction !== "string" || !["up", "down", "left", "right"].includes(result.direction)) throw new QwenProviderError("Qwen scroll direction is invalid", "QWEN_INVALID_TOOL_CALL");
    if (typeof result.ticks !== "number" || !Number.isInteger(result.ticks) || result.ticks < 1) throw new QwenProviderError("Qwen scroll ticks must be a positive integer", "QWEN_INVALID_TOOL_CALL");
  }
  if (toolName === "wait" && (typeof result.durationMs !== "number" || !Number.isFinite(result.durationMs) || result.durationMs < 0)) throw new QwenProviderError("Qwen wait durationMs must be non-negative", "QWEN_INVALID_TOOL_CALL");
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRetryableQwenErrorCode(code: string): boolean {
  return code === "QWEN_INVALID_RESPONSE"
    || code === "QWEN_INVALID_TOOL_CALL"
    || code === "QWEN_DUPLICATE_TOOL_CALL"
    || code === "QWEN_UNAVAILABLE_TOOL"
    || code === "QWEN_UNTAGGED_TOOL_CALL"
    || code === "QWEN_UNCONFIRMED_FINISH"
    || code === "QWEN_EMPTY_RESPONSE";
}

function jsonRecord(value: unknown): Record<string, JsonValue> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === "object" && value !== null) return Object.values(value as Record<string, unknown>).every(isJsonValue);
  return false;
}
