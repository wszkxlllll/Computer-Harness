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
  private readonly imagePreprocessor: QwenImagePreprocessor;
  private readonly httpClient: QwenHttpClient;

  public constructor(options: QwenAdapterOptions) {
    if (options.apiKey.trim().length === 0) throw new Error("Qwen apiKey must be non-empty");
    this.id = options.model ?? "gui-plus-2026-02-26";
    this.apiKey = options.apiKey;
    this.assetReader = options.assetReader;
    this.endpoint = resolveQwenEndpoint(options.endpoint, options.workspaceId);
    this.imagePreprocessor = options.imagePreprocessor ?? identityImagePreprocessor;
    this.httpClient = options.httpClient ?? new FetchQwenHttpClient();
  }

  public async generate(input: ModelInput, options: { signal: AbortSignal }): Promise<ModelTurn> {
    options.signal.throwIfAborted();
    const computerUseTool = qwenComputerUseTool(input);
    const messages = await this.presentMessages(
      `${input.system}\n${buildGuiPlusSystemPrompt()}`,
      input.messages,
      options.signal,
    );
    const body = {
      model: this.id,
      messages,
      tools: [computerUseTool],
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
          historicalCalls.push(formatHistoricalCall(block));
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
      throw new QwenProviderError("GUI-Plus requires exactly one computer_use call per response", "QWEN_MULTIPLE_TOOL_CALLS");
    }
    if (response.calls.length === 1) {
      const raw = response.calls[0];
      if (!isRecord(raw) || raw.type !== "function" || typeof raw.id !== "string" || raw.id.trim().length === 0 || !isRecord(raw.function) || raw.function.name !== "computer_use" || typeof raw.function.arguments !== "string") {
        throw new QwenProviderError("Qwen native call requires id, function name computer_use and JSON arguments", "QWEN_INVALID_TOOL_CALL");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.function.arguments) as unknown;
      } catch (error) {
        throw new QwenProviderError(`Qwen tool_call is not JSON: ${error instanceof Error ? error.message : String(error)}`, "QWEN_INVALID_TOOL_CALL");
      }
      const call = mapComputerUse(
        { name: raw.function.name, arguments: parsed },
        latestViewport(input),
        raw.id as ToolCallId,
      );
      if (call.name === "__finish__") {
        const finishArgs = jsonRecord(call.arguments);
        if (finishArgs === undefined || typeof finishArgs.summary !== "string") {
          throw new QwenProviderError("Qwen terminate did not produce a summary", "QWEN_INVALID_TOOL_CALL");
        }
        const reportedStatus = finishArgs.reportedStatus;
        if (reportedStatus !== "success" && reportedStatus !== "failure") {
          throw new QwenProviderError("Qwen terminate requires status success or failure", "QWEN_INVALID_TOOL_CALL");
        }
        return { type: "finish", summary: finishArgs.summary, reportedStatus, ...(usage === undefined ? {} : { usage }) };
      }
      if (call.name === "__user_input_required__") {
        const userArgs = jsonRecord(call.arguments);
        if (userArgs === undefined || typeof userArgs.question !== "string") {
          throw new QwenProviderError("Qwen interact requires text", "QWEN_INVALID_TOOL_CALL");
        }
        return { type: "user_input_required", question: userArgs.question, ...(usage === undefined ? {} : { usage }) };
      }
      if (!input.tools.some((tool) => tool.name === call.name)) {
        throw new QwenProviderError(`Qwen selected a tool not offered by this run: ${call.name}`, "QWEN_UNAVAILABLE_TOOL");
      }
      const assistantText = content.trim();
      return assistantText.length === 0
        ? { type: "tool_calls", calls: [call], ...(usage === undefined ? {} : { usage }) }
        : { type: "tool_calls", calls: [call], assistantText, ...(usage === undefined ? {} : { usage }) };
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

function qwenComputerUseTool(input: ModelInput): Record<string, unknown> {
  const available = new Set(input.tools.map((tool) => tool.name));
  const actions = [
    ...(available.has("keypress") || available.has("hotkey") ? ["key"] : []),
    ...(available.has("type") ? ["type"] : []),
    ...(available.has("click") ? ["left_click"] : []),
    ...(available.has("wait") ? ["wait"] : []),
    "terminate", "interact",
  ];
  return {
    type: "function",
    function: {
      name: "computer_use",
      description: `Perform one GUI action or end/hand off the task. Available actions: ${actions.join(", ")}. Coordinates are normalized numbers from 0 to 1000 in the supplied image. key uses keys; type uses text; left_click uses coordinate; wait uses time in seconds; terminate requires status=success or failure and may include text; interact requires text. Use only the available actions.`,
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: actions },
          coordinate: { type: "array", items: { type: "number", minimum: 0, maximum: 1000 }, minItems: 2, maxItems: 2 },
          keys: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
          text: { type: "string" },
          time: { type: "number", minimum: 0 },
          status: { type: "string", enum: ["success", "failure"] },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  };
}

function buildGuiPlusSystemPrompt(): string {
  return "Use the native computer_use function for GUI actions. Emit at most one call per turn; do not serialize calls as XML or Markdown text. Coordinates are normalized from 0 to 1000 relative to the current image, not image pixels. Observe is automatic after an action. Use terminate with status success or failure to finish; use interact with text to ask the user a question. A tool execution receipt is not proof of task completion.";
}

function formatHistoricalCall(block: Extract<ModelContentBlock, { type: "tool_call" }>): unknown {
  const args = jsonRecord(block.call.arguments);
  if (args === undefined) throw new QwenProviderError("Historical tool arguments must be an object", "QWEN_INVALID_HISTORY");
  let wire: Record<string, unknown>;
  switch (block.call.name) {
    case "click": {
      if (block.viewport === undefined || typeof args.x !== "number" || typeof args.y !== "number") {
        throw new QwenProviderError("Historical click requires its own viewport and coordinates", "QWEN_INVALID_HISTORY");
      }
      wire = { action: "left_click", coordinate: [args.x * 1000 / block.viewport.width, args.y * 1000 / block.viewport.height] };
      break;
    }
    case "type": wire = { action: "type", text: args.text }; break;
    case "keypress":
    case "hotkey": wire = { action: "key", keys: args.keys }; break;
    case "wait": {
      if (typeof args.durationMs !== "number") throw new QwenProviderError("Historical wait requires durationMs", "QWEN_INVALID_HISTORY");
      wire = { action: "wait", time: args.durationMs / 1000 };
      break;
    }
    default: throw new QwenProviderError(`Historical tool is unsupported: ${block.call.name}`, "QWEN_INVALID_HISTORY");
  }
  return { id: block.call.id, type: "function", function: { name: "computer_use", arguments: JSON.stringify(wire) } };
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

function mapComputerUse(
  value: unknown,
  targetViewport: Viewport | undefined,
  generatedId: ToolCallId,
): ToolCall {
  if (!isRecord(value) || value.name !== "computer_use" || !isRecord(value.arguments)) throw new QwenProviderError("Qwen tool_call must contain name computer_use and arguments", "QWEN_INVALID_TOOL_CALL");
  const args = value.arguments;
  if (typeof args.action !== "string") throw new QwenProviderError("Qwen computer_use requires action", "QWEN_INVALID_TOOL_CALL");
  const action = args.action;
  if (action === "terminate") {
    if (args.status !== "success" && args.status !== "failure") throw new QwenProviderError("Qwen terminate requires status success or failure", "QWEN_INVALID_TOOL_CALL");
    const summary = typeof args.text === "string" && args.text.trim().length > 0 ? args.text : `GUI-Plus terminated with ${args.status}`;
    return { id: generatedId, name: "__finish__", arguments: { summary, reportedStatus: args.status } };
  }
  if (action === "interact") {
    if (typeof args.text !== "string" || args.text.trim().length === 0) throw new QwenProviderError("Qwen interact requires text", "QWEN_INVALID_TOOL_CALL");
    return { id: generatedId, name: "__user_input_required__", arguments: { question: args.text } };
  }
  if (action === "left_click") {
    return { id: generatedId, name: "click", arguments: mapCoordinate(args.coordinate, targetViewport) };
  }
  if (action === "type") {
    if (typeof args.text !== "string") throw new QwenProviderError("Qwen type action requires text", "QWEN_INVALID_TOOL_CALL");
    return { id: generatedId, name: "type", arguments: { text: args.text } };
  }
  if (action === "key") {
    if (!Array.isArray(args.keys) || args.keys.length === 0 || args.keys.some((key) => typeof key !== "string" || key.length === 0)) throw new QwenProviderError("Qwen key action requires keys", "QWEN_INVALID_TOOL_CALL");
    return { id: generatedId, name: args.keys.length === 1 ? "keypress" : "hotkey", arguments: { keys: args.keys } };
  }
  if (action === "wait") {
    if (typeof args.time !== "number" || !Number.isFinite(args.time) || args.time < 0) throw new QwenProviderError("Qwen wait action requires non-negative time in seconds", "QWEN_INVALID_TOOL_CALL");
    return { id: generatedId, name: "wait", arguments: { durationMs: args.time * 1000 } };
  }
  throw new QwenProviderError(`Qwen action is unsupported: ${action}`, "QWEN_UNSUPPORTED_ACTION");
}

function mapCoordinate(
  value: unknown,
  targetViewport: Viewport | undefined,
): { x: number; y: number } {
  if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "number" || typeof value[1] !== "number" || !Number.isFinite(value[0]) || !Number.isFinite(value[1])) throw new QwenProviderError("Qwen coordinate must be [x,y]", "QWEN_INVALID_TOOL_CALL");
  if (targetViewport === undefined) throw new QwenProviderError("Qwen coordinates require an image viewport", "QWEN_MISSING_VIEWPORT");
  if (value[0] < 0 || value[0] > 1000 || value[1] < 0 || value[1] > 1000) throw new QwenProviderError("Qwen normalized coordinate is outside 0..1000", "QWEN_COORDINATE_OUT_OF_RANGE");
  return {
    x: value[0] * targetViewport.width / 1000,
    y: value[1] * targetViewport.height / 1000,
  };
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

function jsonRecord(value: JsonValue): Record<string, JsonValue> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined;
}
