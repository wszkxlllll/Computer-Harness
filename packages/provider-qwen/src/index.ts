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

export interface QwenImagePreprocessorInput {
  bytes: Uint8Array;
  mediaType: string;
  viewport: Viewport;
}

export interface QwenPreparedImage {
  bytes: Uint8Array;
  mediaType: string;
}

export type QwenCoordinateMode = "normalized_1000" | "actual_pixels";

/** May re-encode/resize the full image; cropping requires a different spatial contract. */
export type QwenImagePreprocessor =
  (input: QwenImagePreprocessorInput, signal: AbortSignal) => Promise<QwenPreparedImage>;

export interface QwenHttpClient {
  post(url: string, body: Record<string, unknown>, headers: Readonly<Record<string, string>>, signal: AbortSignal): Promise<unknown>;
}

export interface QwenAdapterOptions {
  apiKey: string;
  assetReader: AssetReader;
  /** Full endpoint or a compatible-mode base URL. */
  endpoint?: string;
  workspaceId?: string;
  model?: "gui-plus-2026-02-26";
  coordinateMode?: QwenCoordinateMode;
  imagePreprocessor?: QwenImagePreprocessor;
  httpClient?: QwenHttpClient;
}

export class QwenProviderError extends Error {
  public constructor(
    message: string,
    public readonly code = "QWEN_PROVIDER_ERROR",
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "QwenProviderError";
  }
}

export class QwenGuiPlusAdapter implements ProviderAdapter {
  public readonly id: string;
  private readonly apiKey: string;
  private readonly assetReader: AssetReader;
  private readonly endpoint: string;
  private readonly coordinateMode: QwenCoordinateMode;
  private readonly imagePreprocessor: QwenImagePreprocessor;
  private readonly httpClient: QwenHttpClient;

  public constructor(options: QwenAdapterOptions) {
    if (options.apiKey.trim().length === 0) throw new Error("Qwen apiKey must be non-empty");
    this.id = options.model ?? "gui-plus-2026-02-26";
    this.apiKey = options.apiKey;
    this.assetReader = options.assetReader;
    this.endpoint = resolveQwenEndpoint(options.endpoint, options.workspaceId);
    this.coordinateMode = options.coordinateMode ?? "normalized_1000";
    this.imagePreprocessor = options.imagePreprocessor ?? identityImagePreprocessor;
    this.httpClient = options.httpClient ?? new FetchQwenHttpClient();
  }

  public async generate(input: ModelInput, options: { signal: AbortSignal }): Promise<ModelTurn> {
    options.signal.throwIfAborted();
    const messages = await this.presentMessages(
      `${input.system}\n${buildGuiPlusSystemPrompt(this.coordinateMode)}`,
      input.messages,
      options.signal,
    );
    const body = {
      model: this.id,
      messages,
      tools: qwenFunctionTools(input, this.coordinateMode, latestViewport(input)),
      stream: false,
      temperature: 0,
      vl_high_resolution_images: true,
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
        const block = message.content.find((item) => item.type === "tool_result");
        if (block?.type === "tool_result") {
          result.push({
            role: "tool",
            tool_call_id: block.result.callId,
            content: JSON.stringify(block.result),
          });
        }
        continue;
      }
      const contentParts: unknown[] = [];
      const historicalCalls: unknown[] = [];
      for (const block of message.content) {
        if (block.type === "text") contentParts.push({ type: "text", text: block.text });
        else if (block.type === "image") {
          const bytes = await this.assetReader.read(block.asset, signal);
          const prepared = await this.imagePreprocessor({ bytes, mediaType: block.asset.mediaType, viewport: block.viewport }, signal);
          // Preprocessing may resize the full image, not crop/reframe it.
          // This model uses normalized coordinates, independent of pixel size.
          contentParts.push({ type: "image_url", image_url: { url: toDataUrl(prepared.mediaType, prepared.bytes) } });
        } else if (block.type === "tool_call") {
          historicalCalls.push(formatHistoricalCall(block, this.coordinateMode));
        }
      }
      if (message.role === "assistant") {
        const assistantText = contentParts
          .filter((part): part is { type: "text"; text: string } => isRecord(part) && part.type === "text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("\n");
        result.push({ role: "assistant", content: assistantText, ...(historicalCalls.length === 0 ? {} : { tool_calls: historicalCalls }) });
      } else {
        result.push({ role: message.role, content: contentParts });
      }
    }
    return result;
  }

  private parseResponse(value: unknown, input: ModelInput): ModelTurn {
    const response = readAssistantResponse(value);
    assertCompleteFinishReason(response.finishReason);
    const content = response.content;
    const usage = response.usage;
    if (response.calls.length > 1) {
      throw new QwenProviderError("GUI-Plus requires exactly one Function Calling tool call per response", "QWEN_MULTIPLE_TOOL_CALLS");
    }
    if (response.calls.length === 1) {
      const raw = response.calls[0];
      if (!isRecord(raw) || raw.type !== "function" || typeof raw.id !== "string" || raw.id.trim().length === 0 || !isRecord(raw.function) || typeof raw.function.name !== "string" || raw.function.name.trim().length === 0 || typeof raw.function.arguments !== "string") {
        throw new QwenProviderError("Qwen native function call requires id, function name, and JSON arguments", "QWEN_INVALID_TOOL_CALL");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.function.arguments) as unknown;
      } catch (error) {
        throw new QwenProviderError(`Qwen tool_call is not JSON: ${error instanceof Error ? error.message : String(error)}`, "QWEN_INVALID_TOOL_CALL");
      }
      const call = mapQwenToolCall(
        { name: raw.function.name, arguments: parsed },
        input,
        latestViewport(input),
        this.coordinateMode,
        raw.id as ToolCallId,
      );
      if (call.type === "finish") return { ...call, ...(usage === undefined ? {} : { usage }) };
      if (call.type === "user_input_required") return { ...call, ...(usage === undefined ? {} : { usage }) };
      const assistantText = content.trim();
      return assistantText.length === 0
        ? { type: "tool_calls", calls: [call.call], ...(usage === undefined ? {} : { usage }) }
        : { type: "tool_calls", calls: [call.call], assistantText, ...(usage === undefined ? {} : { usage }) };
    }
    if (/<\/?tool_call\b/iu.test(content) || /```[\s\S]*?(?:"name"|"type")\s*:\s*"computer_use"/iu.test(content) || looksLikeUntaggedComputerUseJson(content)) {
      throw new QwenProviderError(
        "Qwen returned a computer_use payload in text instead of native tool_calls",
        "QWEN_UNTAGGED_TOOL_CALL",
      );
    }
    if (response.finishReason === "tool_calls") throw new QwenProviderError("Qwen tool_calls finish reason has no calls", "QWEN_INVALID_RESPONSE");
    if (content.trim().length > 0) return { type: "finish", summary: content.trim(), ...(usage === undefined ? {} : { usage }) };
    throw new QwenProviderError("Qwen returned an empty assistant response", "QWEN_EMPTY_RESPONSE");
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

class FetchQwenHttpClient implements QwenHttpClient {
  public async post(url: string, body: Record<string, unknown>, headers: Readonly<Record<string, string>>, signal: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new QwenProviderError(
        `Qwen network request failed: ${error instanceof Error ? error.message : String(error)}`,
        "QWEN_NETWORK_ERROR",
        true,
      );
    }
    const payload = await response.json().catch(() => undefined) as unknown;
    if (!response.ok) {
      throw new QwenProviderError(
        `Qwen HTTP ${response.status}`,
        `QWEN_HTTP_${response.status}`,
        response.status === 429 || response.status >= 500,
      );
    }
    return payload;
  }
}

const identityImagePreprocessor: QwenImagePreprocessor = async (input, signal) => {
  signal.throwIfAborted();
  return input;
};

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

function qwenFunctionTools(input: ModelInput, coordinateMode: QwenCoordinateMode, viewport: Viewport | undefined): Record<string, unknown>[] {
  const names = new Set(input.tools.map((tool) => tool.name));
  const tools: Record<string, unknown>[] = input.tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: `${tool.description}${coordinateDescription(tool.name, coordinateMode, viewport)}`,
      parameters: qwenToolParameters(tool, coordinateMode, viewport),
    },
  }));
  if (!names.has("terminate")) {
    tools.push({
      type: "function",
      function: {
        name: "terminate",
        description: "Finish the GUI task and report whether the user goal is complete. Use failure when the goal is not complete; do not infer success from a tool receipt alone.",
        parameters: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["success", "failure"], description: "Whether the user goal is complete." },
            text: { type: "string", description: "Short explanation of the final status." },
          },
          required: ["status"],
          additionalProperties: false,
        },
      },
    });
  }
  if (!names.has("interact")) {
    tools.push({
      type: "function",
      function: {
        name: "interact",
        description: "Ask the user for information or confirmation when the GUI task cannot proceed safely without it.",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "The question or confirmation request shown to the user." },
          },
          required: ["text"],
          additionalProperties: false,
        },
      },
    });
  }
  return tools;
}

function qwenToolParameters(tool: ModelToolSpec, coordinateMode: QwenCoordinateMode, viewport: Viewport | undefined): JsonValue {
  const coordinate = qwenCoordinateArraySchema(coordinateMode, viewport);
  switch (tool.name) {
    case "click":
      return {
        type: "object",
        properties: { coordinate: { ...coordinate, description: `Target point as [x, y] in the current image viewport. ${String(coordinate.description)}` } },
        required: ["coordinate"],
        additionalProperties: false,
      };
    case "scroll":
      return {
        type: "object",
        properties: {
          coordinate: { ...coordinate, description: `Point where scrolling starts, as [x, y] in the current image viewport. ${String(coordinate.description)}` },
          pixels: { type: "integer", description: "Non-zero scroll amount. Positive values move up or right; negative values move down or left." },
          direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Scroll direction. Use up/down for vertical scrolling and left/right for horizontal scrolling." },
        },
        required: ["coordinate", "pixels", "direction"],
        additionalProperties: false,
      };
    case "drag":
      return {
        type: "object",
        properties: {
          coordinate: { ...coordinate, description: `Drag start point as [x, y] in the current image viewport. ${String(coordinate.description)}` },
          coordinate2: { ...coordinate, description: `Drag end point as [x, y] in the current image viewport. ${String(coordinate.description)}` },
        },
        required: ["coordinate", "coordinate2"],
        additionalProperties: false,
      };
    case "wait":
      return {
        type: "object",
        properties: { time: { type: "number", minimum: 0, description: "Non-negative wait duration in seconds." } },
        required: ["time"],
        additionalProperties: false,
      };
    default:
      return addQwenCoordinateDetails(tool.inputSchema ?? { type: "object", properties: {}, additionalProperties: false }, tool.name, coordinateMode, viewport);
  }
}

function qwenCoordinateArraySchema(coordinateMode: QwenCoordinateMode, viewport: Viewport | undefined): Record<string, JsonValue> {
  const maximum = coordinateMode === "normalized_1000"
    ? 1000
    : undefined;
  const description = coordinateMode === "normalized_1000"
    ? "Two numbers [x, y] normalized to 0..1000."
    : viewport === undefined
      ? "Two pixel numbers [x, y] in the current image viewport."
      : `Two pixel numbers [x, y] in the current image viewport (x 0-${viewport.width - 1}, y 0-${viewport.height - 1}).`;
  return {
    type: "array",
    description,
    items: { type: "number", minimum: 0, ...(maximum === undefined ? {} : { maximum }) },
    minItems: 2,
    maxItems: 2,
  };
}

function coordinateDescription(name: string, coordinateMode: QwenCoordinateMode, viewport: Viewport | undefined): string {
  if (!hasCoordinateField(name)) return "";
  return coordinateMode === "actual_pixels"
    ? viewport === undefined
      ? " Coordinates are pixels in the current image viewport."
      : ` Coordinates are pixels in the current image viewport (x 0-${viewport.width - 1}, y 0-${viewport.height - 1}).`
    : " Coordinates are normalized numbers from 0 to 1000 relative to the current image.";
}

function hasCoordinateField(name: string): boolean {
  return name === "click" || name === "scroll" || name === "drag";
}

function addQwenCoordinateDetails(schema: JsonValue, toolName: string, coordinateMode: QwenCoordinateMode, viewport: Viewport | undefined): JsonValue {
  if (!hasCoordinateField(toolName)) return schema;
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return schema;
  const record = schema as Record<string, JsonValue>;
  const properties = record.properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) return schema;
  const nextProperties = { ...(properties as Record<string, JsonValue>) };
  for (const key of ["x", "y", "fromX", "fromY", "toX", "toY"]) {
    const property = nextProperties[key];
    if (typeof property !== "object" || property === null || Array.isArray(property)) continue;
    const nextProperty = { ...(property as Record<string, JsonValue>) };
    nextProperty.description = coordinateMode === "actual_pixels"
      ? `${typeof nextProperty.description === "string" ? `${nextProperty.description} ` : ""}Pixel coordinate in the current image viewport.`
      : `${typeof nextProperty.description === "string" ? `${nextProperty.description} ` : ""}Normalized coordinate from 0 to 1000.`;
    const isX = key.endsWith("X") || key === "x";
    const maximum = coordinateMode === "normalized_1000" ? 1000 : isX ? viewport === undefined ? undefined : viewport.width - 1 : viewport === undefined ? undefined : viewport.height - 1;
    nextProperty.minimum = 0;
    if (maximum !== undefined) nextProperty.maximum = maximum;
    nextProperties[key] = nextProperty;
  }
  return { ...record, properties: nextProperties };
}

function buildGuiPlusSystemPrompt(coordinateMode: QwenCoordinateMode): string {
  const coordinateRule = coordinateMode === "actual_pixels"
    ? "Coordinates are pixels in the current image viewport."
    : "Coordinates are normalized from 0 to 1000 relative to the current image.";
  return `Use the available Function Calling tools for GUI actions. Emit at most one tool call per turn. ${coordinateRule} Observe is automatic after an action. Use terminate with status success or failure to finish; use interact with text to ask the user a question. A tool execution receipt is not proof of task completion.`;
}

function formatHistoricalCall(block: Extract<ModelContentBlock, { type: "tool_call" }>, coordinateMode: QwenCoordinateMode): unknown {
  const args = jsonRecord(block.call.arguments);
  if (args === undefined) throw new QwenProviderError("Historical tool arguments must be an object", "QWEN_INVALID_HISTORY");
  const wire = encodeQwenArguments(args, block.call.name, block.viewport, coordinateMode);
  return { id: block.call.id, type: "function", function: { name: block.call.name, arguments: JSON.stringify(wire) } };
}

function toDataUrl(mediaType: string, bytes: Uint8Array): string {
  return `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
}

function readAssistantResponse(value: unknown): { content: string; finishReason?: string; calls: unknown[]; usage?: ModelUsage } {
  if (!isRecord(value) || !Array.isArray(value.choices) || value.choices.length === 0) throw new QwenProviderError("Qwen response has no choices", "QWEN_INVALID_RESPONSE");
  const first = value.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) throw new QwenProviderError("Qwen response has no assistant message", "QWEN_INVALID_RESPONSE");
  const calls = first.message.tool_calls;
  if (calls !== undefined && !Array.isArray(calls)) throw new QwenProviderError("Qwen tool_calls must be an array", "QWEN_INVALID_RESPONSE");
  const content = first.message.content;
  if (content !== undefined && content !== null && typeof content !== "string") throw new QwenProviderError("Qwen response has invalid assistant text", "QWEN_INVALID_RESPONSE");
  if (first.finish_reason !== undefined && typeof first.finish_reason !== "string") throw new QwenProviderError("Qwen response has an invalid finish_reason", "QWEN_INVALID_RESPONSE");
  const usage = readUsage(value);
  return {
    content: typeof content === "string" ? content : "",
    calls: calls ?? [],
    ...(typeof first.finish_reason === "string" ? { finishReason: first.finish_reason } : {}),
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

type MappedQwenToolCall =
  | { type: "call"; call: ToolCall }
  | { type: "finish"; summary: string; reportedStatus: "success" | "failure" }
  | { type: "user_input_required"; question: string };

function mapQwenToolCall(
  value: { name: string; arguments: unknown },
  input: ModelInput,
  targetViewport: Viewport | undefined,
  coordinateMode: QwenCoordinateMode,
  generatedId: ToolCallId,
): MappedQwenToolCall {
  const args = jsonRecord(value.arguments);
  if (args === undefined) throw new QwenProviderError("Qwen function arguments must be an object", "QWEN_INVALID_TOOL_CALL");
  if (value.name === "terminate") {
    if (args.status !== "success" && args.status !== "failure") throw new QwenProviderError("Qwen terminate requires status success or failure", "QWEN_INVALID_TOOL_CALL");
    const summary = typeof args.text === "string" && args.text.trim().length > 0 ? args.text : `GUI-Plus terminated with ${args.status}`;
    return { type: "finish", summary, reportedStatus: args.status };
  }
  if (value.name === "interact") {
    if (typeof args.text !== "string" || args.text.trim().length === 0) throw new QwenProviderError("Qwen interact requires text", "QWEN_INVALID_TOOL_CALL");
    return { type: "user_input_required", question: args.text };
  }
  if (!input.tools.some((tool) => tool.name === value.name)) {
    throw new QwenProviderError(`Qwen selected a tool not offered by this run: ${value.name}`, "QWEN_UNAVAILABLE_TOOL");
  }
  return {
    type: "call",
    call: {
      id: generatedId,
      name: value.name,
      arguments: mapQwenArguments(args, value.name, targetViewport, coordinateMode),
    },
  };
}

/** Convert the provider's GUI-Plus wire arguments into the canonical Harness shape. */
function mapQwenArguments(
  args: Record<string, JsonValue>,
  toolName: string,
  targetViewport: Viewport | undefined,
  coordinateMode: QwenCoordinateMode,
): Record<string, JsonValue> {
  switch (toolName) {
    case "click": {
      const point = readQwenPoint(args.coordinate, "click.coordinate", targetViewport, coordinateMode);
      return { x: point.x, y: point.y };
    }
    case "drag": {
      const from = readQwenPoint(args.coordinate, "drag.coordinate", targetViewport, coordinateMode);
      const to = readQwenPoint(args.coordinate2, "drag.coordinate2", targetViewport, coordinateMode);
      return { fromX: from.x, fromY: from.y, toX: to.x, toY: to.y };
    }
    case "scroll": {
      const point = readQwenPoint(args.coordinate, "scroll.coordinate", targetViewport, coordinateMode);
      const pixels = readQwenPixels(args.pixels);
      const direction = readQwenDirection(args.direction, pixels);
      return { x: point.x, y: point.y, direction, ticks: Math.abs(pixels) };
    }
    case "wait": {
      const time = args.time;
      if (typeof time === "number" && Number.isFinite(time) && time >= 0) return { durationMs: time * 1000 };
      // Keep accepting canonical fixtures from callers that bypass the provider wire schema.
      const durationMs = args.durationMs;
      if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0) return { durationMs };
      throw new QwenProviderError("Qwen wait requires a non-negative time in seconds", "QWEN_INVALID_TOOL_CALL");
    }
    case "type":
      if (typeof args.text !== "string") throw new QwenProviderError("Qwen type requires text", "QWEN_INVALID_TOOL_CALL");
      return { text: args.text };
    case "keypress":
    case "hotkey":
      return { keys: readQwenKeys(args.keys, toolName) };
    default:
      // Planning and future provider-neutral tools retain their declared schema. Known
      // coordinate fields still use the generic normalized/pixel conversion as a fallback.
      return mapCoordinates(args, toolName, targetViewport, coordinateMode);
  }
}

function readQwenPoint(value: JsonValue | undefined, label: string, viewport: Viewport | undefined, coordinateMode: QwenCoordinateMode): { x: number; y: number } {
  if (!Array.isArray(value) || value.length !== 2) throw new QwenProviderError(`Qwen ${label} must be [x, y]`, "QWEN_INVALID_TOOL_CALL");
  const x = value[0];
  const y = value[1];
  if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) {
    throw new QwenProviderError(`Qwen ${label} must contain finite numbers`, "QWEN_INVALID_TOOL_CALL");
  }
  if (coordinateMode === "normalized_1000") {
    if (viewport === undefined) throw new QwenProviderError("Qwen normalized coordinates require an image viewport", "QWEN_MISSING_VIEWPORT");
    if (x < 0 || x > 1000 || y < 0 || y > 1000) throw new QwenProviderError(`Qwen normalized ${label} is outside 0..1000`, "QWEN_COORDINATE_OUT_OF_RANGE");
    return { x: x * viewport.width / 1000, y: y * viewport.height / 1000 };
  }
  if (viewport !== undefined && (x < 0 || x >= viewport.width || y < 0 || y >= viewport.height)) {
    throw new QwenProviderError(`Qwen pixel ${label} is outside the current viewport`, "QWEN_COORDINATE_OUT_OF_RANGE");
  }
  return { x, y };
}

function readQwenPixels(value: JsonValue | undefined): number {
  if (typeof value !== "number" || !Number.isInteger(value) || !Number.isFinite(value) || value === 0) {
    throw new QwenProviderError("Qwen scroll.pixels must be a non-zero integer", "QWEN_INVALID_TOOL_CALL");
  }
  return value;
}

function readQwenDirection(value: JsonValue | undefined, pixels: number): "up" | "down" | "left" | "right" {
  if (value === "up" || value === "down" || value === "left" || value === "right") return value;
  // Official GUI-Plus responses only carry signed pixels. Infer the vertical direction
  // for those responses while allowing our richer schema to preserve horizontal intent.
  return pixels > 0 ? "up" : "down";
}

function readQwenKeys(value: JsonValue | undefined, toolName: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((key) => typeof key !== "string" || key.length === 0)) {
    throw new QwenProviderError(`Qwen ${toolName} requires a non-empty keys array`, "QWEN_INVALID_TOOL_CALL");
  }
  if (toolName === "keypress" && value.length !== 1) {
    throw new QwenProviderError("Qwen keypress.keys must contain exactly one key; use hotkey for a shortcut", "QWEN_INVALID_TOOL_CALL");
  }
  return value as string[];
}

function mapCoordinates(
  args: Record<string, JsonValue>,
  toolName: string,
  targetViewport: Viewport | undefined,
  coordinateMode: QwenCoordinateMode,
): Record<string, JsonValue> {
  const coordinateKeys = toolName === "click" || toolName === "scroll"
    ? ["x", "y"]
    : toolName === "drag"
      ? ["fromX", "fromY", "toX", "toY"]
      : [];
  if (coordinateKeys.length === 0 || coordinateMode === "actual_pixels") return args;
  if (targetViewport === undefined) throw new QwenProviderError("Qwen normalized coordinates require an image viewport", "QWEN_MISSING_VIEWPORT");
  const next = { ...args };
  for (const key of coordinateKeys) {
    const value = next[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1000) {
      throw new QwenProviderError(`Qwen normalized coordinate ${key} is outside 0..1000`, "QWEN_COORDINATE_OUT_OF_RANGE");
    }
    const isX = key.endsWith("X") || key === "x";
    next[key] = value * (isX ? targetViewport.width : targetViewport.height) / 1000;
  }
  return next;
}

function encodeCoordinates(
  args: Record<string, JsonValue>,
  toolName: string,
  viewport: Viewport | undefined,
  coordinateMode: QwenCoordinateMode,
): Record<string, JsonValue> {
  const coordinateKeys = toolName === "click" || toolName === "scroll"
    ? ["x", "y"]
    : toolName === "drag"
      ? ["fromX", "fromY", "toX", "toY"]
      : [];
  if (coordinateKeys.length === 0 || coordinateMode === "actual_pixels") return args;
  if (viewport === undefined) throw new QwenProviderError("Historical normalized coordinates require a viewport", "QWEN_INVALID_HISTORY");
  const next = { ...args };
  for (const key of coordinateKeys) {
    const value = next[key];
    if (typeof value !== "number" || !Number.isFinite(value)) throw new QwenProviderError(`Historical coordinate ${key} must be finite`, "QWEN_INVALID_HISTORY");
    const isX = key.endsWith("X") || key === "x";
    next[key] = value * (isX ? 1000 / viewport.width : 1000 / viewport.height);
  }
  return next;
}

/** Convert canonical Harness calls back to the provider-native GUI-Plus schema for history. */
function encodeQwenArguments(
  args: Record<string, JsonValue>,
  toolName: string,
  viewport: Viewport | undefined,
  coordinateMode: QwenCoordinateMode,
): Record<string, JsonValue> {
  switch (toolName) {
    case "click": {
      const point = readCanonicalPoint(args, "x", "y", "click", viewport, coordinateMode);
      return { coordinate: [point.x, point.y] };
    }
    case "drag": {
      const from = readCanonicalPoint(args, "fromX", "fromY", "drag.from", viewport, coordinateMode);
      const to = readCanonicalPoint(args, "toX", "toY", "drag.to", viewport, coordinateMode);
      return { coordinate: [from.x, from.y], coordinate2: [to.x, to.y] };
    }
    case "scroll": {
      const point = readCanonicalPoint(args, "x", "y", "scroll", viewport, coordinateMode);
      const direction = args.direction;
      const ticks = args.ticks;
      if (direction !== "up" && direction !== "down" && direction !== "left" && direction !== "right") throw new QwenProviderError("Historical scroll direction is invalid", "QWEN_INVALID_HISTORY");
      if (typeof ticks !== "number" || !Number.isInteger(ticks) || ticks <= 0) throw new QwenProviderError("Historical scroll ticks must be a positive integer", "QWEN_INVALID_HISTORY");
      return { coordinate: [point.x, point.y], pixels: direction === "up" || direction === "right" ? ticks : -ticks, direction };
    }
    case "wait": {
      const durationMs = args.durationMs;
      if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) throw new QwenProviderError("Historical wait durationMs must be non-negative", "QWEN_INVALID_HISTORY");
      return { time: durationMs / 1000 };
    }
    default:
      return encodeCoordinates(args, toolName, viewport, coordinateMode);
  }
}

function readCanonicalPoint(
  args: Record<string, JsonValue>,
  xKey: string,
  yKey: string,
  label: string,
  viewport: Viewport | undefined,
  coordinateMode: QwenCoordinateMode,
): { x: number; y: number } {
  const x = args[xKey];
  const y = args[yKey];
  if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) throw new QwenProviderError(`Historical ${label} coordinates must be finite`, "QWEN_INVALID_HISTORY");
  if (coordinateMode === "normalized_1000") {
    if (viewport === undefined) throw new QwenProviderError("Historical normalized coordinates require a viewport", "QWEN_INVALID_HISTORY");
    return { x: x * 1000 / viewport.width, y: y * 1000 / viewport.height };
  }
  return { x, y };
}

function latestViewport(input: ModelInput): Viewport | undefined {
  for (let i = input.messages.length - 1; i >= 0; i -= 1) {
    const message = input.messages[i];
    if (message === undefined) continue;
    for (let j = message.content.length - 1; j >= 0; j -= 1) {
      const block = message.content[j];
      if (block?.type === "image") return block.viewport;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonRecord(value: unknown): Record<string, JsonValue> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined;
}
