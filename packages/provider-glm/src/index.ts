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
  ModelContentBlock,
  ModelInput,
  ModelMessage,
  ModelToolSpec,
  ProviderAdapter,
} from "@computer-harness/runtime";

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
    public readonly retryable = false,
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
    options.signal.throwIfAborted();
    const body = {
      model: this.profile.name,
      messages: await this.presentMessages(`${input.system}\n${profilePrompt(this.profile)}`, input.messages, options.signal),
      tools: input.tools.map((tool) => toGlmTool(tool, this.profile)),
      stream: false,
      thinking: { type: this.profile.thinking },
    } satisfies Record<string, unknown>;
    const response = await this.httpClient.post(
      this.endpoint,
      body,
      { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      options.signal,
    );
    options.signal.throwIfAborted();
    return this.parseResponse(response, input);
  }

  private async presentMessages(system: string, messages: readonly ModelMessage[], signal: AbortSignal): Promise<unknown[]> {
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
      for (const block of message.content) {
        if (block.type === "text") {
          content.push({ type: "text", text: block.text });
        } else if (block.type === "image") {
          const bytes = await this.assetReader.read(block.asset, signal);
          content.push({ type: "image_url", image_url: { url: toDataUrl(block.asset.mediaType, bytes) } });
        } else if (block.type === "tool_call") {
          toolCalls.push({
            id: block.call.id,
            type: "function",
            function: {
              name: block.call.name,
              arguments: JSON.stringify(encodeCoordinates(block.call, block.viewport, this.profile.coordinateMode)),
            },
          });
        }
      }
      const presented: Record<string, unknown> = { role: message.role, content };
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
        calls.push(mapCoordinates(parsed, latestViewport(input), this.profile.coordinateMode));
      }
      const assistantText = typeof message.content === "string" && message.content.trim().length > 0
        ? message.content
        : undefined;
      return assistantText === undefined
        ? { type: "tool_calls", calls, ...(usage === undefined ? {} : { usage }) }
        : { type: "tool_calls", calls, assistantText, ...(usage === undefined ? {} : { usage }) };
    }
    if (typeof message.content === "string" && message.content.trim().length > 0) {
      return { type: "finish", summary: message.content, ...(usage === undefined ? {} : { usage }) };
    }
    throw new GlmProviderError("GLM returned an empty assistant response", "GLM_EMPTY_RESPONSE");
  }
}

class FetchGlmHttpClient implements GlmHttpClient {
  public async post(
    url: string,
    body: Record<string, unknown>,
    headers: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new GlmProviderError(
        `GLM network request failed: ${error instanceof Error ? error.message : String(error)}`,
        "GLM_NETWORK_ERROR",
        true,
      );
    }
    const payload = await response.json().catch(() => undefined) as unknown;
    if (!response.ok) {
      const code = readErrorCode(payload);
      throw new GlmProviderError(
        `GLM HTTP ${response.status}${code === undefined ? "" : ` (${code})`}`,
        code ?? `GLM_HTTP_${response.status}`,
        code === "1305" || response.status === 429 || response.status >= 500,
      );
    }
    return payload;
  }
}

function toGlmTool(tool: ModelToolSpec, profile: GlmProfile): Record<string, unknown> {
  const coordinateHint = profile.coordinateMode === "normalized_1000"
    ? " Coordinates x/y/fromX/fromY/toX/toY are normalized numbers from 0 to 1000."
    : " Coordinates are pixels in the current image viewport.";
  return {
    type: "function",
    function: {
      name: tool.name,
      description: `${tool.description}${coordinateHint}`,
      parameters: addCoordinateBounds(tool.inputSchema ?? { type: "object", properties: {} }, profile.coordinateMode),
    },
  };
}

function toDataUrl(mediaType: string, bytes: Uint8Array): string {
  return `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
}

function readResponse(value: unknown): { message: { content?: unknown; tool_calls?: unknown }; finishReason?: string; usage?: ModelUsage } {
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

function mapCoordinates(call: { id: ToolCallId; name: string; arguments: JsonValue }, viewport: Viewport | undefined, mode: GlmCoordinateMode): ToolCall {
  if (mode !== "normalized_1000" || typeof call.arguments !== "object" || call.arguments === null || Array.isArray(call.arguments)) {
    return call;
  }
  const args = { ...(call.arguments as Record<string, JsonValue>) };
  const coordinateKeys = ["x", "y", "fromX", "fromY", "toX", "toY"];
  if (viewport === undefined && coordinateKeys.some((key) => args[key] !== undefined)) {
    throw new GlmProviderError("GLM normalized coordinates require an image viewport", "GLM_MISSING_VIEWPORT");
  }
  if (viewport === undefined) return call;
  for (const key of coordinateKeys) {
    const value = args[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1000) {
      throw new GlmProviderError(`GLM normalized coordinate ${key} is outside 0..1000`, "GLM_COORDINATE_OUT_OF_RANGE");
    }
    args[key] = value * (key.endsWith("X") || key === "x" ? viewport.width : viewport.height) / 1000;
  }
  return { ...call, arguments: args };
}

function encodeCoordinates(call: ToolCall, viewport: Viewport | undefined, mode: GlmCoordinateMode): JsonValue {
  if (mode !== "normalized_1000" || viewport === undefined || typeof call.arguments !== "object" || call.arguments === null || Array.isArray(call.arguments)) {
    return call.arguments;
  }
  const args = { ...(call.arguments as Record<string, JsonValue>) };
  const coordinateKeys = ["x", "y", "fromX", "fromY", "toX", "toY"];
  for (const key of coordinateKeys) {
    const value = args[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) return call.arguments;
    args[key] = value * (key.endsWith("X") || key === "x" ? 1000 / viewport.width : 1000 / viewport.height);
  }
  return args;
}

function addCoordinateBounds(schema: JsonValue, mode: GlmCoordinateMode): JsonValue {
  if (mode !== "normalized_1000" || typeof schema !== "object" || schema === null || Array.isArray(schema)) return schema;
  const record = schema as Record<string, JsonValue>;
  const properties = record.properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) return schema;
  const nextProperties = { ...(properties as Record<string, JsonValue>) };
  for (const key of ["x", "y", "fromX", "fromY", "toX", "toY"]) {
    const property = nextProperties[key];
    if (typeof property !== "object" || property === null || Array.isArray(property)) continue;
    nextProperties[key] = { ...(property as Record<string, JsonValue>), minimum: 0, maximum: 1000 };
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

function readErrorCode(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.error) || typeof value.error.code !== "string") return undefined;
  return value.error.code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).every(isJsonValue);
  return false;
}
