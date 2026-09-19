import { createHash } from "node:crypto";
import type {
  JsonValue,
  ModelUsage,
  ModelTurn,
  ToolCall,
  ToolCallId,
  Viewport,
  ModelContinuation,
} from "@computer-harness/protocol";
import type {
  AssetReader,
  ModelContentBlock,
  ModelInput,
  ModelMessage,
  ModelToolSpec,
  ProviderAdapter,
  PreparedProviderRequest,
  ControlKind,
  CoordinateField,
} from "@computer-harness/runtime";
import { encodeToolCallArguments, splitActionEffectArguments } from "@computer-harness/runtime";

export type GlmCoordinateMode = "normalized_1000" | "actual_pixels";

export type GlmProfileName = "glm-5.3-flash";

export interface GlmProfile {
  /** Provider model id; custom profiles may use another id explicitly. */
  readonly name: string;
  readonly thinking: "disabled" | "enabled";
  readonly coordinateMode: GlmCoordinateMode;
}

export const glmProfiles: Readonly<Record<GlmProfileName, GlmProfile>> = {
  "glm-5.3-flash": {
    name: "glm-5.3-flash",
    thinking: "enabled",
    coordinateMode: "actual_pixels",
  },
};

export interface GlmHttpClient {
  post(url: string, body: Record<string, unknown>, headers: Readonly<Record<string, string>>, signal: AbortSignal): Promise<unknown>;
}

export type GlmRetryMode = "same_input" | "feedback";

export interface FetchGlmHttpClientOptions {
  /** Maximum wall-clock time for fetch plus response-body consumption. */
  readonly requestTimeoutMs?: number;
}

export interface GlmAdapterOptions {
  apiKey: string;
  profile: GlmProfileName | GlmProfile;
  assetReader: AssetReader;
  endpoint?: string;
  httpClient?: GlmHttpClient;
}

export class GlmProviderError extends Error {
  public constructor(
    message: string,
    public readonly code = "GLM_PROVIDER_ERROR",
    public readonly retryable = isRetryableGlmErrorCode(code),
    public readonly retryMode: GlmRetryMode = "feedback",
  ) {
    super(message);
    this.name = "GlmProviderError";
  }
}

export class GlmAdapter implements ProviderAdapter {
  public readonly id: string;
  private readonly profile: GlmProfile;
  private readonly assetReader: AssetReader;
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly httpClient: GlmHttpClient;
  private readonly preparedRequests = new WeakMap<PreparedProviderRequest, { body: Record<string, unknown>; input: ModelInput }>();

  public constructor(options: GlmAdapterOptions) {
    if (options.apiKey.trim().length === 0) {
      throw new Error("GLM apiKey must be non-empty");
    }
    this.profile = typeof options.profile === "string" ? glmProfiles[options.profile] : options.profile;
    this.id = this.profile.name;
    this.assetReader = options.assetReader;
    this.endpoint = options.endpoint ?? "https://open.bigmodel.cn/api/paas/v4/chat/completions";
    this.apiKey = options.apiKey;
    this.httpClient = options.httpClient ?? new FetchGlmHttpClient();
  }

  public async generate(input: ModelInput, options: { signal: AbortSignal }): Promise<ModelTurn> {
    const prepared = await this.prepare(input, options);
    return this.generatePrepared(prepared, options);
  }

  public async prepare(input: ModelInput, options: { signal: AbortSignal }): Promise<PreparedProviderRequest> {
    options.signal.throwIfAborted();
    const snapshot = structuredClone(input);
    const body = {
      model: this.profile.name,
      messages: await this.presentMessages(`${snapshot.system}\n${profilePrompt(this.profile)}`, snapshot.messages, snapshot.tools, options.signal),
      tools: snapshot.tools.map((tool) => toGlmTool(tool, this.profile, latestViewport(snapshot))),
      stream: false,
      thinking: { type: this.profile.thinking },
    } satisfies Record<string, unknown>;
    const frozenBody = deepFreeze(body);
    const prepared: PreparedProviderRequest = Object.freeze({
      providerId: this.id,
      payloadHash: createHash("sha256").update(JSON.stringify(frozenBody)).digest("hex"),
      estimate: Object.freeze({
        estimatedTextTokens: estimateWireTextTokens(frozenBody),
        imageCount: countImages(snapshot),
        estimationMethod: "provider_projection",
      } as const),
    });
    this.preparedRequests.set(prepared, { body: frozenBody, input: snapshot });
    return prepared;
  }

  public async generatePrepared(prepared: PreparedProviderRequest, options: { signal: AbortSignal }): Promise<ModelTurn> {
    options.signal.throwIfAborted();
    if (prepared.providerId !== this.id || !Object.isFrozen(prepared)) {
      throw new GlmProviderError("GLM prepared request metadata is invalid", "GLM_INVALID_PREPARED_REQUEST");
    }
    const state = this.preparedRequests.get(prepared);
    if (state === undefined) {
      throw new GlmProviderError("GLM prepared request was not created by this adapter", "GLM_INVALID_PREPARED_REQUEST");
    }
    const response = await this.httpClient.post(
      this.endpoint,
      state.body,
      { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      options.signal,
    );
    options.signal.throwIfAborted();
    return this.parseResponse(response, state.input);
  }

  private async presentMessages(system: string, messages: readonly ModelMessage[], tools: readonly ModelToolSpec[], signal: AbortSignal): Promise<unknown[]> {
    const result: unknown[] = [{ role: "system", content: system }];
    for (const message of messages) {
      signal.throwIfAborted();
      if (message.role === "tool") {
        const resultBlock = message.content.find((block) => block.type === "tool_result");
        if (resultBlock?.type === "tool_result") {
          result.push({ role: "tool", tool_call_id: resultBlock.result.callId, content: JSON.stringify(resultBlock.result) });
        }
        continue;
      }
      const content: unknown[] = [];
      const toolCalls: unknown[] = [];
      let reasoningContent: string | undefined;
      for (const block of message.content) {
        if (block.type === "text") {
          content.push({ type: "text", text: block.text });
        } else if (block.type === "image") {
          const bytes = await this.assetReader.read(block.asset, signal);
          content.push({ type: "image_url", image_url: { url: toDataUrl(block.asset.mediaType, bytes) } });
        } else if (block.type === "provider_continuation") {
          if (block.continuation.providerId !== this.id || block.continuation.kind !== "reasoning_content") continue;
          if (reasoningContent !== undefined && reasoningContent !== block.continuation.content) {
            throw new GlmProviderError("GLM history contains conflicting reasoning continuations", "GLM_INVALID_HISTORY");
          }
          reasoningContent = block.continuation.content;
        } else if (block.type === "tool_call") {
          const tool = tools.find((item) => item.name === block.call.name);
          const historyArguments = encodeToolCallArguments(tool, block.call);
          toolCalls.push({
            id: block.call.id,
            type: "function",
            function: {
              name: block.call.name,
              arguments: JSON.stringify(encodeCoordinates({ ...block.call, arguments: historyArguments }, block.viewport, this.profile.coordinateMode, tool?.coordinate?.fields)),
            },
          });
        }
      }
      const presented: Record<string, unknown> = { role: message.role, content };
      if (reasoningContent !== undefined) {
        presented.reasoning_content = reasoningContent;
      }
      if (toolCalls.length > 0) {
        presented.tool_calls = toolCalls;
      }
      result.push(presented);
    }
    return result;
  }

  private parseResponse(value: unknown, input: ModelInput): ModelTurn {
    const response = readResponse(value);
    assertCompleteFinishReason(response.finishReason);
    const message = response.message;
    const usage = response.usage;
    const rawToolCalls = message.tool_calls;
    if (rawToolCalls !== undefined) {
      if (!Array.isArray(rawToolCalls) || rawToolCalls.length === 0) {
        throw new GlmProviderError("GLM returned an invalid tool_calls value", "GLM_INVALID_RESPONSE");
      }
      const ids = new Set<string>();
      const calls: ToolCall[] = [];
      for (const raw of rawToolCalls) {
        const parsed = readToolCall(raw);
        if (ids.has(parsed.id)) {
          throw new GlmProviderError(`GLM returned duplicate ToolCall id: ${parsed.id}`, "GLM_DUPLICATE_TOOL_CALL");
        }
        ids.add(parsed.id);
        if (!input.tools.some((tool) => tool.name === parsed.name)) {
          throw new GlmProviderError(`GLM selected a tool not offered by this run: ${parsed.name}`, "GLM_UNAVAILABLE_TOOL");
        }
        const tool = input.tools.find((item) => item.name === parsed.name);
        if (tool?.control !== undefined) {
          if (calls.length > 0 || rawToolCalls.length !== 1) {
            throw new GlmProviderError("GLM control calls cannot be mixed with other tool calls", "GLM_INVALID_TOOL_CALL");
          }
          const control = mapControlCall(tool.control, parsed.arguments, parsed.name);
          return control.type === "finish"
            ? { ...control, ...(usage === undefined ? {} : { usage }) }
            : { ...control, ...(usage === undefined ? {} : { usage }) };
        }
        let separated: ReturnType<typeof splitActionEffectArguments>;
        try {
          separated = splitActionEffectArguments(tool, parsed.arguments);
        } catch (error) {
          throw new GlmProviderError(`GLM action effect is invalid: ${error instanceof Error ? error.message : String(error)}`, "GLM_INVALID_TOOL_CALL");
        }
        const mapped = mapCoordinates({ ...parsed, arguments: separated.arguments }, latestViewport(input), this.profile.coordinateMode, tool?.coordinate?.fields);
        calls.push({ ...mapped, ...(separated.declaredEffect === undefined ? {} : { declaredEffect: separated.declaredEffect }) });
      }
      const assistantText = typeof message.content === "string" && message.content.trim().length > 0
        ? message.content
        : undefined;
      const continuation = reasoningContinuation(message.reasoning_content, this.id);
      return assistantText === undefined
        ? { type: "tool_calls", calls, ...(continuation === undefined ? {} : { continuation }), ...(usage === undefined ? {} : { usage }) }
        : { type: "tool_calls", calls, assistantText, ...(continuation === undefined ? {} : { continuation }), ...(usage === undefined ? {} : { usage }) };
    }
    if (typeof message.content === "string" && message.content.trim().length > 0) {
      if (message.reasoning_content !== undefined && typeof message.reasoning_content !== "string") {
        throw new GlmProviderError("GLM reasoning_content must be a string", "GLM_INVALID_RESPONSE");
      }
      return { type: "finish", summary: message.content, ...(usage === undefined ? {} : { usage }) };
    }
    throw new GlmProviderError("GLM returned an empty assistant response", "GLM_EMPTY_RESPONSE");
  }
}

export class FetchGlmHttpClient implements GlmHttpClient {
  private readonly requestTimeoutMs: number;

  public constructor(options: FetchGlmHttpClientOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 240_000;
    if (!Number.isInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new Error("GLM requestTimeoutMs must be a positive integer");
    }
  }

  public async post(
    url: string,
    body: Record<string, unknown>,
    headers: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const requestController = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      requestController.abort(new Error(`GLM request deadline exceeded after ${this.requestTimeoutMs}ms`));
    }, this.requestTimeoutMs);
    const abortRequest = () => requestController.abort(signal.reason);
    if (signal.aborted) {
      abortRequest();
    } else {
      signal.addEventListener("abort", abortRequest, { once: true });
    }
    try {
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: requestController.signal,
        });
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        if (timedOut) {
          throw new GlmProviderError(
            `GLM request timed out after ${this.requestTimeoutMs}ms`,
            "GLM_REQUEST_TIMEOUT",
            true,
            "same_input",
          );
        }
        throw new GlmProviderError(
          `GLM network request failed (${networkDiagnostic(error)})`,
          "GLM_NETWORK_ERROR",
          true,
          "same_input",
        );
      }
      const payload = await response.json().catch((error: unknown) => {
        if (signal.aborted) throw signal.reason ?? error;
        if (timedOut) {
          throw new GlmProviderError(
            `GLM response body timed out after ${this.requestTimeoutMs}ms`,
            "GLM_REQUEST_TIMEOUT",
            true,
            "same_input",
          );
        }
        throw new GlmProviderError(
          `GLM response body could not be read (${networkDiagnostic(error)})`,
          "GLM_NETWORK_ERROR",
          true,
          "same_input",
        );
      }) as unknown;
      if (!response.ok) {
        const code = readErrorCode(payload);
        const providerMessage = readErrorMessage(payload);
        const retryable = code === "1305" || response.status === 429 || response.status >= 500;
        throw new GlmProviderError(
          `GLM HTTP ${response.status}${code === undefined ? "" : ` (${code})`}${providerMessage === undefined ? "" : `: ${sanitizeDiagnosticText(providerMessage)}`}`,
          code ?? `GLM_HTTP_${response.status}`,
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

function countImages(input: ModelInput): number {
  return input.messages.reduce((total, message) => total + message.content.filter((block) => block.type === "image").length, 0);
}

function estimateWireTextTokens(body: unknown): number {
  const withoutImagePayload = stripImagePayload(body);
  return Math.ceil(JSON.stringify(withoutImagePayload).length / 4);
}

function stripImagePayload(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => stripImagePayload(item, parentKey));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    parentKey === "image_url" && key === "url" && typeof child === "string"
      ? "[image payload omitted]"
      : stripImagePayload(child, key),
  ]));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function networkDiagnostic(error: unknown): string {
  if (!(error instanceof Error)) return `type=${typeof error}; message=${sanitizeDiagnosticText(String(error))}`;
  const cause = isRecord(error.cause) ? error.cause : undefined;
  const causeCode = cause !== undefined && typeof cause.code === "string" ? cause.code : undefined;
  const causeName = cause !== undefined && typeof cause.name === "string" ? cause.name : undefined;
  const parts = [`name=${error.name}`];
  if (causeCode !== undefined) parts.push(`causeCode=${causeCode}`);
  if (causeName !== undefined) parts.push(`causeName=${causeName}`);
  if (error.message.trim().length > 0) parts.push(`message=${sanitizeDiagnosticText(error.message)}`);
  return parts.join("; ");
}

function sanitizeDiagnosticText(value: string): string {
  return value
    .slice(0, 240)
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/giu, "$1[redacted]")
    .replace(/(bearer\s+)[A-Za-z0-9._~+\-/]+=*/giu, "$1[redacted]")
    .replace(/([?&](?:api[_-]?key|access[_-]?token|auth(?:orization)?|token|secret|password|signature|sig)=)[^&\s]+/giu, "$1[redacted]")
    .replace(/((?:api[_-]?key|access[_-]?token|auth(?:orization)?|token|secret|password|signature|sig)\s*[:=]\s*)[^\s,;]+/giu, "$1[redacted]")
    .replace(/(https?:\/\/)[^/\s@]+@/giu, "$1[redacted]@");
}

function toGlmTool(tool: ModelToolSpec, profile: GlmProfile, viewport: Viewport | undefined): Record<string, unknown> {
  const coordinateHint = tool.coordinate === undefined
    ? ""
    : profile.coordinateMode === "normalized_1000"
      ? ` Coordinates ${tool.coordinate.fields.join(",")} are normalized numbers from 0 to 1000.`
      : viewport === undefined
        ? ` Coordinates ${tool.coordinate.fields.join(",")} are pixels in the current image viewport.`
        : ` Coordinates ${tool.coordinate.fields.join(",")} are pixels in the current image viewport.`;
  return {
    type: "function",
    function: {
      name: tool.name,
      description: `${tool.description}${coordinateHint}`,
      parameters: addCoordinateBounds(tool.inputSchema ?? { type: "object", properties: {} }, tool.coordinate?.fields, profile.coordinateMode, viewport),
    },
  };
}

function toDataUrl(mediaType: string, bytes: Uint8Array): string {
  return `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
}

function readResponse(value: unknown): { message: { content?: unknown; tool_calls?: unknown; reasoning_content?: unknown }; finishReason?: string; usage?: ModelUsage } {
  if (!isRecord(value) || !Array.isArray(value.choices) || value.choices.length === 0) {
    throw new GlmProviderError("GLM response has no choices", "GLM_INVALID_RESPONSE");
  }
  const first = value.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) {
    throw new GlmProviderError("GLM response has no assistant message", "GLM_INVALID_RESPONSE");
  }
  if (first.finish_reason !== undefined && typeof first.finish_reason !== "string") {
    throw new GlmProviderError("GLM response has an invalid finish_reason", "GLM_INVALID_RESPONSE");
  }
  const usage = readUsage(value);
  return {
    message: first.message,
    ...(typeof first.finish_reason === "string" ? { finishReason: first.finish_reason } : {}),
    ...(usage === undefined ? {} : { usage }),
  };
}

function reasoningContinuation(value: unknown, providerId: string): ModelContinuation | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new GlmProviderError("GLM reasoning_content must be a string", "GLM_INVALID_RESPONSE");
  }
  return { providerId, kind: "reasoning_content", content: value };
}

function assertCompleteFinishReason(reason: string | undefined): void {
  if (reason !== undefined && reason !== "stop" && reason !== "tool_calls" && reason !== "function_call") {
    throw new GlmProviderError(`GLM response ended with incomplete finish_reason: ${reason}`, "GLM_INCOMPLETE_RESPONSE");
  }
}

function readUsage(value: unknown): ModelUsage | undefined {
  if (!isRecord(value) || !isRecord(value.usage)) return undefined;
  const usage = value.usage;
  const inputTokens = usage.prompt_tokens;
  const outputTokens = usage.completion_tokens;
  const totalTokens = usage.total_tokens;
  const parsed = {
    ...(typeof inputTokens === "number" && Number.isInteger(inputTokens) && inputTokens >= 0 ? { inputTokens } : {}),
    ...(typeof outputTokens === "number" && Number.isInteger(outputTokens) && outputTokens >= 0 ? { outputTokens } : {}),
    ...(typeof totalTokens === "number" && Number.isInteger(totalTokens) && totalTokens >= 0 ? { totalTokens } : {}),
  };
  return Object.keys(parsed).length === 0 ? undefined : parsed;
}

function readToolCall(value: unknown): { id: ToolCallId; name: string; arguments: JsonValue } {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.trim().length === 0 || !isRecord(value.function) || typeof value.function.name !== "string") {
    throw new GlmProviderError("GLM returned a malformed ToolCall", "GLM_INVALID_TOOL_CALL");
  }
  const rawArgs = value.function.arguments;
  let args: unknown = rawArgs;
  if (typeof rawArgs === "string") {
    try {
      args = JSON.parse(rawArgs) as unknown;
    } catch (error) {
      throw new GlmProviderError(`GLM ToolCall arguments are not JSON: ${error instanceof Error ? error.message : String(error)}`, "GLM_INVALID_TOOL_CALL");
    }
  }
  if (!isJsonValue(args)) {
    throw new GlmProviderError("GLM ToolCall arguments are not JSON-safe", "GLM_INVALID_TOOL_CALL");
  }
  return { id: value.id as ToolCallId, name: value.function.name, arguments: args };
}

function mapCoordinates(call: { id: ToolCallId; name: string; arguments: JsonValue }, viewport: Viewport | undefined, mode: GlmCoordinateMode, fields: readonly CoordinateField[] | undefined): ToolCall {
  if (mode !== "normalized_1000" || fields === undefined || typeof call.arguments !== "object" || call.arguments === null || Array.isArray(call.arguments)) {
    return call;
  }
  const args = { ...(call.arguments as Record<string, JsonValue>) };
  if (viewport === undefined && fields.some((key) => args[key] !== undefined)) {
    throw new GlmProviderError("GLM normalized coordinates require an image viewport", "GLM_MISSING_VIEWPORT");
  }
  if (viewport === undefined) return call;
  for (const key of fields) {
    const value = args[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1000) {
      throw new GlmProviderError(`GLM normalized coordinate ${key} is outside 0..1000`, "GLM_COORDINATE_OUT_OF_RANGE");
    }
    args[key] = value * (key.endsWith("X") || key === "x" ? viewport.width : viewport.height) / 1000;
  }
  return { ...call, arguments: args };
}

function encodeCoordinates(call: ToolCall, viewport: Viewport | undefined, mode: GlmCoordinateMode, fields: readonly CoordinateField[] | undefined): JsonValue {
  if (mode !== "normalized_1000" || fields === undefined || viewport === undefined || typeof call.arguments !== "object" || call.arguments === null || Array.isArray(call.arguments)) {
    return call.arguments;
  }
  const args = { ...(call.arguments as Record<string, JsonValue>) };
  for (const key of fields) {
    const value = args[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) return call.arguments;
    args[key] = value * (key.endsWith("X") || key === "x" ? 1000 / viewport.width : 1000 / viewport.height);
  }
  return args;
}

function addCoordinateBounds(schema: JsonValue, fields: readonly CoordinateField[] | undefined, mode: GlmCoordinateMode, viewport: Viewport | undefined): JsonValue {
  if (fields === undefined) return schema;
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return schema;
  const record = schema as Record<string, JsonValue>;
  const properties = record.properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) return schema;
  const nextProperties = { ...(properties as Record<string, JsonValue>) };
  for (const key of fields) {
    const property = nextProperties[key];
    if (typeof property !== "object" || property === null || Array.isArray(property)) continue;
    const isX = key.endsWith("X") || key === "x";
    const maximum = mode === "normalized_1000" ? 1000 : isX ? viewport === undefined ? undefined : viewport.width - 1 : viewport === undefined ? undefined : viewport.height - 1;
    nextProperties[key] = { ...(property as Record<string, JsonValue>), minimum: 0, ...(maximum === undefined ? {} : { maximum }) };
  }
  return { ...record, properties: nextProperties };
}

function profilePrompt(profile: GlmProfile): string {
  return profile.coordinateMode === "normalized_1000"
    ? "GLM GUI contract: emit at most one Computer tool call per turn. Coordinates must be normalized to 0..1000 relative to the current image."
    : "GLM GUI contract: emit at most one Computer tool call per turn. Coordinates are pixels in the current image viewport.";
}

function latestViewport(input: ModelInput): Viewport | undefined {
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index];
    if (message === undefined) continue;
    for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = message.content[blockIndex];
      if (block?.type === "image") return block.viewport;
    }
  }
  return undefined;
}

function mapControlCall(control: ControlKind, argumentsValue: JsonValue, name: string): ModelTurn {
  if (typeof argumentsValue !== "object" || argumentsValue === null || Array.isArray(argumentsValue)) {
    throw new GlmProviderError(`GLM control ${name} arguments must be an object`, "GLM_INVALID_TOOL_CALL");
  }
  const args = argumentsValue as Record<string, JsonValue>;
  if (control === "finish") {
    if (args.status !== "success" && args.status !== "failure") throw new GlmProviderError("GLM terminate requires status success or failure", "GLM_INVALID_TOOL_CALL");
    return { type: "finish", summary: typeof args.text === "string" && args.text.trim().length > 0 ? args.text : `GLM terminated with ${args.status}`, reportedStatus: args.status };
  }
  if (typeof args.text !== "string" || args.text.trim().length === 0) throw new GlmProviderError("GLM interact requires text", "GLM_INVALID_TOOL_CALL");
  return { type: "user_input_required", question: args.text };
}

function readErrorCode(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.error) || typeof value.error.code !== "string") return undefined;
  return value.error.code;
}

function readErrorMessage(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.error) || typeof value.error.message !== "string" || value.error.message.trim().length === 0) return undefined;
  return value.error.message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRetryableGlmErrorCode(code: string): boolean {
  return code === "GLM_INVALID_RESPONSE"
    || code === "GLM_INVALID_TOOL_CALL"
    || code === "GLM_DUPLICATE_TOOL_CALL"
    || code === "GLM_UNAVAILABLE_TOOL"
    || code === "GLM_EMPTY_RESPONSE"
    || code === "GLM_INCOMPLETE_RESPONSE";
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).every(isJsonValue);
  return false;
}
