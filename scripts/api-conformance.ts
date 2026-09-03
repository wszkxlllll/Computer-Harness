import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { DefaultContextCompiler } from "@computer-harness/context";
import { GlmAdapter, type GlmAdapterOptions, type GlmHttpClient } from "@computer-harness/provider-glm";
import { Qwen38FlashAdapter, QwenGuiPlusAdapter, type Qwen38AdapterOptions, type Qwen38ThinkingMode, type QwenAdapterOptions, type QwenHttpClient } from "@computer-harness/provider-qwen";
import type {
  AssetId,
  AssetRef,
  ComputerSessionId,
  EventId,
  ModelTurn,
  ObservationFrame,
  ObservationId,
  RunId,
  RuntimeEvent,
  ToolCall,
  ToolCallId,
  Viewport,
} from "@computer-harness/protocol";
import { createDefaultComputerTools, type AssetReader, type ModelInput } from "@computer-harness/runtime";

type ProviderName = "glm-5.3-flash" | "gui-plus-2026-02-26" | "qwen3.8-flash";

interface CliOptions {
  envFile: string;
  image: string;
  output: string;
  timeoutMs: number;
  model: ProviderName | "all";
  qwenThinking: Qwen38ThinkingMode;
}

interface RequestRecord {
  provider: ProviderName;
  request: number;
  url: string;
  model: string;
  topLevelKeys: string[];
  hasNativeTools: boolean;
  highResolutionFlag?: boolean;
  thinking?: unknown;
  reasoningEffort?: unknown;
  preserveThinking?: unknown;
  enableThinking?: unknown;
  messages: Array<{
    role: string;
    contentShape: string;
    textLength: number;
    imageCount: number;
    hasToolCalls: boolean;
    hasReasoningContent: boolean;
    reasoningContentLength: number;
  }>;
  responseShape?: { choiceCount: number; contentLength?: number; tagNames: string[]; openToolCallTags: number; closeToolCallTags: number; hasJsonFence: boolean; toolCallJson?: { length: number; firstChar: string; lastChar: string; parses: boolean; rootKeys: string[]; nameType?: string; typeValue?: string; argumentsType?: string; argumentKeys?: string[]; actionType?: string } };
  finishReason?: string;
  usage?: unknown;
  status: number;
}

interface ModelRunResult {
  provider: ProviderName;
  requests: RequestRecord[];
  turns: Array<Record<string, unknown>>;
  status: "ok" | "error" | "skipped";
  error?: { code: string; message: string; retryable?: boolean };
}

class StaticHttpError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "StaticHttpError";
  }
}

class RecordingHttpClient implements GlmHttpClient, QwenHttpClient {
  public readonly records: RequestRecord[] = [];
  private requestNumber = 0;

  public constructor(
    private readonly provider: ProviderName,
    private readonly timeoutMs: number,
  ) {}

  public async post(
    url: string,
    body: Record<string, unknown>,
    headers: Readonly<Record<string, string>>,
    parentSignal: AbortSignal,
  ): Promise<unknown> {
    const controller = new AbortController();
    const abort = (): void => controller.abort(parentSignal.reason);
    if (parentSignal.aborted) abort();
    else parentSignal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("static API request timed out")), this.timeoutMs);
    const request = this.requestNumber + 1;
    const record: RequestRecord = {
      provider: this.provider,
      request,
      url: safeUrl(url),
      model: typeof body.model === "string" ? body.model : "<missing>",
      topLevelKeys: Object.keys(body).sort(),
      hasNativeTools: Array.isArray(body.tools),
      ...(typeof body.vl_high_resolution_images === "boolean" ? { highResolutionFlag: body.vl_high_resolution_images } : {}),
      ...(body.thinking === undefined ? {} : { thinking: body.thinking }),
      ...(body.reasoning_effort === undefined ? {} : { reasoningEffort: body.reasoning_effort }),
      ...(body.preserve_thinking === undefined ? {} : { preserveThinking: body.preserve_thinking }),
      ...(body.enable_thinking === undefined ? {} : { enableThinking: body.enable_thinking }),
      messages: summarizeMessages(body.messages),
      status: 0,
    };
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      record.status = response.status;
      const payload = await response.json().catch(() => undefined) as unknown;
      record.responseShape = summarizeResponseShape(payload);
      const finishReason = readFinishReason(payload);
      if (finishReason !== undefined) record.finishReason = finishReason;
      const usage = sanitizeUsage(payload);
      if (usage !== undefined) record.usage = usage;
      this.records.push(record);
      this.requestNumber = request;
      if (!response.ok) {
        throw new StaticHttpError(`Provider returned HTTP ${response.status}`, `HTTP_${response.status}`, response.status, response.status === 429 || response.status >= 500);
      }
      return payload;
    } catch (error) {
      if (!this.records.includes(record)) this.records.push(record);
      this.requestNumber = request;
      if (controller.signal.aborted && !parentSignal.aborted) {
        throw new StaticHttpError("Provider request timed out", "STATIC_API_TIMEOUT", 0, true);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      parentSignal.removeEventListener("abort", abort);
    }
  }
}

class BytesAssetReader implements AssetReader {
  public constructor(private readonly bytes: Uint8Array) {}

  public async read(_ref: AssetRef, signal: AbortSignal): Promise<Uint8Array> {
    signal.throwIfAborted();
    return this.bytes;
  }
}

function parseArgs(argv: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith("--")) continue;
    const value = argv[index + 1];
    if (value !== undefined && !value.startsWith("--")) {
      values.set(token.slice(2), value);
      index += 1;
    }
  }
  const modelValue = values.get("model") ?? "all";
  if (modelValue !== "all" && modelValue !== "glm-5.3-flash" && modelValue !== "gui-plus-2026-02-26" && modelValue !== "qwen3.8-flash") {
    throw new Error(`unsupported --model: ${modelValue}`);
  }
  const timeoutValue = Number(values.get("timeout-ms") ?? "120000");
  if (!Number.isInteger(timeoutValue) || timeoutValue < 1000) throw new Error("--timeout-ms must be an integer >= 1000");
  const qwenThinking = values.get("qwen-thinking") ?? "low";
  if (qwenThinking !== "disabled" && qwenThinking !== "low" && qwenThinking !== "medium" && qwenThinking !== "xhigh") throw new Error("--qwen-thinking must be disabled, low, medium, or xhigh");
  return {
    envFile: resolve(values.get("env-file") ?? ".env"),
    image: resolve(values.get("image") ?? "runs/api-conformance/non-sensitive-ui.png"),
    output: resolve(values.get("output") ?? `runs/api-conformance/${new Date().toISOString().replace(/[-:.TZ]/g, "")}`),
    timeoutMs: timeoutValue,
    model: modelValue,
    qwenThinking,
  };
}

function parseEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u.exec(line);
    if (match === null) continue;
    const key = match[1];
    const raw = match[2] ?? "";
    if (key === undefined) continue;
    result[key] = raw.replace(/^(['"])(.*)\1$/u, "$2");
  }
  return result;
}

function envValue(env: Record<string, string>, key: string): string | undefined {
  const value = process.env[key] ?? env[key];
  return value?.trim() === "" ? undefined : value?.trim();
}

function makeAsset(imagePath: string, bytes: Uint8Array): AssetRef {
  return {
    assetId: "static-api-image" as AssetId,
    relativePath: basename(imagePath),
    mediaType: "image/png",
    byteLength: bytes.byteLength,
  };
}

function makeObservation(runId: RunId, sessionId: ComputerSessionId, observationId: string, asset: AssetRef, viewport: Viewport): ObservationFrame {
  return {
    id: observationId as ObservationId,
    runId,
    computerSessionId: sessionId,
    capturedAt: "2026-08-31T00:00:00.000Z",
    viewport,
    screenshot: asset,
  };
}

function makeEvent<T extends RuntimeEvent["type"]>(
  runId: RunId,
  sequence: number,
  type: T,
  data: Omit<Extract<RuntimeEvent, { type: T }>, "eventId" | "runId" | "sequence" | "occurredAt" | "type">,
): RuntimeEvent {
  return {
    eventId: `static-event-${sequence}` as EventId,
    runId,
    sequence,
    occurredAt: `2026-08-31T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    type,
    ...data,
  } as RuntimeEvent;
}

function baseEvents(runId: RunId, sessionId: ComputerSessionId, firstObservation: ObservationFrame): RuntimeEvent[] {
  return [
    makeEvent(runId, 0, "run.created", { goal: "Click the blue button in the synthetic UI once, then report whether the request was completed." }),
    makeEvent(runId, 1, "run.started", {}),
    makeEvent(runId, 2, "computer.open.started", {}),
    makeEvent(runId, 3, "computer.open.completed", {
      session: {
        id: sessionId,
        backend: "static-fixture",
        viewport: firstObservation.viewport,
        capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false },
        openedAt: firstObservation.capturedAt,
      },
    }),
    makeEvent(runId, 4, "observation.created", { observation: firstObservation }),
  ];
}

function summarizeMessages(value: unknown): RequestRecord["messages"] {
  if (!Array.isArray(value)) return [];
  return value.map((message) => {
    const record = isRecord(message) ? message : {};
    const content = record.content;
    const contentShape = Array.isArray(content) ? "array" : typeof content;
    let textLength = typeof content === "string" ? content.length : 0;
    let imageCount = 0;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (!isRecord(part)) continue;
        if (part.type === "text" && typeof part.text === "string") textLength += part.text.length;
        if (part.type === "image_url") imageCount += 1;
      }
    }
    return {
      role: typeof record.role === "string" ? record.role : "<missing>",
      contentShape,
      textLength,
      imageCount,
      hasToolCalls: Array.isArray(record.tool_calls) && record.tool_calls.length > 0,
      hasReasoningContent: typeof record.reasoning_content === "string",
      reasoningContentLength: typeof record.reasoning_content === "string" ? record.reasoning_content.length : 0,
    };
  });
}

function summarizeTurn(turn: ModelTurn): Record<string, unknown> {
  if (turn.type === "tool_calls") {
    return {
      type: turn.type,
      callCount: turn.calls.length,
      calls: turn.calls.map(summarizeCall),
      assistantTextLength: turn.assistantText?.length ?? 0,
      ...(turn.continuation === undefined ? {} : {
        continuation: { providerId: turn.continuation.providerId, kind: turn.continuation.kind, contentLength: turn.continuation.content.length },
      }),
      usage: turn.usage,
    };
  }
  if (turn.type === "finish") {
    return { type: turn.type, summaryLength: turn.summary.length, reportedStatus: turn.reportedStatus, usage: turn.usage };
  }
  return { type: turn.type, questionLength: turn.question.length, usage: turn.usage };
}

function summarizeCall(call: ToolCall): Record<string, unknown> {
  const args: Record<string, unknown> = typeof call.arguments === "object" && call.arguments !== null && !Array.isArray(call.arguments)
    ? call.arguments as Record<string, unknown>
    : {};
  const safeArgs: Record<string, unknown> = {};
  for (const key of ["x", "y", "fromX", "fromY", "toX", "toY", "durationMs", "action"]) {
    if (typeof args[key] === "number" || typeof args[key] === "string") safeArgs[key] = args[key];
  }
  if (typeof args.text === "string") safeArgs.textLength = args.text.length;
  if (Array.isArray(args.keys)) safeArgs.keyCount = args.keys.length;
  return { idPresent: call.id.length > 0, name: call.name, arguments: safeArgs };
}

function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    const host = url.hostname.endsWith(".maas.aliyuncs.com")
      ? "<workspace>.maas.aliyuncs.com"
      : url.hostname;
    return `${url.protocol}//${host}${url.pathname}`;
  } catch {
    return "<invalid-url>";
  }
}

function readFinishReason(value: unknown): string | undefined {
  if (!isRecord(value) || !Array.isArray(value.choices)) return undefined;
  const first = value.choices[0];
  if (!isRecord(first) || typeof first.finish_reason !== "string") return undefined;
  return first.finish_reason;
}

function summarizeResponseShape(value: unknown): NonNullable<RequestRecord["responseShape"]> {
  if (!isRecord(value) || !Array.isArray(value.choices)) return { choiceCount: 0, tagNames: [], openToolCallTags: 0, closeToolCallTags: 0, hasJsonFence: false };
  const first = value.choices[0];
  const message = isRecord(first) && isRecord(first.message) ? first.message : undefined;
  const content = message !== undefined && typeof message.content === "string" ? message.content : undefined;
  const tags = content === undefined ? [] : [...content.matchAll(/<\/?\s*([A-Za-z_][A-Za-z0-9_-]*)[^>]*>/gu)].map((match) => match[1]).filter((name): name is string => name !== undefined);
  const toolCallMatch = content?.match(/<\s*tool_call\s*>([\s\S]*?)<\/\s*tool_call\s*>/iu);
  const toolCallText = toolCallMatch?.[1]?.trim();
  let toolCallJson: NonNullable<NonNullable<RequestRecord["responseShape"]>["toolCallJson"]> | undefined;
  if (toolCallText !== undefined) {
    let parsed: unknown;
    try { parsed = JSON.parse(toolCallText) as unknown; } catch { parsed = undefined; }
    toolCallJson = {
      length: toolCallText.length,
      firstChar: toolCallText.slice(0, 1),
      lastChar: toolCallText.slice(-1),
      parses: parsed !== undefined,
      rootKeys: isRecord(parsed) ? Object.keys(parsed).sort() : [],
      ...(isRecord(parsed) && parsed.name !== undefined ? { nameType: typeof parsed.name } : {}),
      ...(isRecord(parsed) && typeof parsed.type === "string" ? { typeValue: parsed.type } : {}),
      ...(isRecord(parsed) && parsed.arguments !== undefined ? { argumentsType: typeof parsed.arguments } : {}),
      ...(isRecord(parsed) && isRecord(parsed.arguments) ? { argumentKeys: Object.keys(parsed.arguments).sort(), ...(typeof parsed.arguments.action === "string" ? { actionType: parsed.arguments.action } : {}) } : {}),
    };
  }
  return {
    choiceCount: value.choices.length,
    ...(content === undefined ? {} : { contentLength: content.length }),
    tagNames: [...new Set(tags)].slice(0, 12),
    openToolCallTags: content === undefined ? 0 : (content.match(/<\s*tool_call\b/giu) ?? []).length,
    closeToolCallTags: content === undefined ? 0 : (content.match(/<\/\s*tool_call\s*>/giu) ?? []).length,
    hasJsonFence: content === undefined ? false : /```\s*json/iu.test(content),
    ...(toolCallJson === undefined ? {} : { toolCallJson }),
  };
}

function sanitizeUsage(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.usage)) return undefined;
  const usage = value.usage;
  const result: Record<string, number> = {};
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"]) {
    if (typeof usage[key] === "number" && Number.isFinite(usage[key])) result[key] = usage[key] as number;
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): { code: string; message: string; retryable?: boolean } {
  if (isRecord(error)) {
    const code = typeof error.code === "string" ? error.code : "PROVIDER_ERROR";
    const message = error instanceof Error ? error.message : typeof error.message === "string" ? error.message : String(error);
    return { code, message: message.slice(0, 240), ...(typeof error.retryable === "boolean" ? { retryable: error.retryable } : {}) };
  }
  return { code: "PROVIDER_ERROR", message: String(error).slice(0, 240) };
}

async function runModel(
  provider: ProviderName,
  input: ModelInput,
  env: Record<string, string>,
  reader: AssetReader,
  timeoutMs: number,
  qwenThinking: Qwen38ThinkingMode,
  secondInput: (first: ModelTurn, firstCall: ToolCall) => Promise<ModelInput>,
): Promise<ModelRunResult> {
  const requests: RequestRecord[] = [];
  const turns: Array<Record<string, unknown>> = [];
  const client = new RecordingHttpClient(provider, timeoutMs);
  const apiKey = provider === "gui-plus-2026-02-26" || provider === "qwen3.8-flash"
    ? envValue(env, "DASHSCOPE_API_KEY")
    : envValue(env, "ZHIPUAI_API_KEY") ?? envValue(env, "ZHIPU_API_KEY") ?? envValue(env, "GLM_API_KEY");
  if (apiKey === undefined) return { provider, requests, turns, status: "skipped", error: { code: "MISSING_API_KEY", message: "provider key is not configured in the selected env file" } };
  let adapter: QwenGuiPlusAdapter | Qwen38FlashAdapter | GlmAdapter;
  if (provider === "gui-plus-2026-02-26") {
    const qwenOptions: QwenAdapterOptions = { apiKey, assetReader: reader, httpClient: client };
    const workspaceId = envValue(env, "DASHSCOPE_WORKSPACE_ID");
    const endpoint = envValue(env, "DASHSCOPE_ENDPOINT");
    if (workspaceId !== undefined) qwenOptions.workspaceId = workspaceId;
    if (endpoint !== undefined) qwenOptions.endpoint = endpoint;
    adapter = new QwenGuiPlusAdapter(qwenOptions);
  } else if (provider === "qwen3.8-flash") {
    const qwen38Options: Qwen38AdapterOptions = { apiKey, assetReader: reader, httpClient: client, thinking: qwenThinking, coordinateMode: "normalized_1000" };
    const workspaceId = envValue(env, "DASHSCOPE_WORKSPACE_ID");
    const endpoint = envValue(env, "DASHSCOPE_ENDPOINT");
    if (workspaceId !== undefined) qwen38Options.workspaceId = workspaceId;
    if (endpoint !== undefined) qwen38Options.endpoint = endpoint;
    adapter = new Qwen38FlashAdapter(qwen38Options);
  } else {
    const glmOptions: GlmAdapterOptions = { apiKey, profile: provider, assetReader: reader, httpClient: client };
    const endpoint = envValue(env, "GLM_ENDPOINT");
    if (endpoint !== undefined) glmOptions.endpoint = endpoint;
    adapter = new GlmAdapter(glmOptions);
  }
  const controller = new AbortController();
  try {
    const first = await adapter.generate(input, { signal: controller.signal });
    turns.push({ round: 1, ...summarizeTurn(first) });
    const firstCall = first.type === "tool_calls" ? first.calls[0] : undefined;
    if (firstCall !== undefined) {
      const second = await secondInput(first, firstCall);
      const secondTurn = await adapter.generate(second, { signal: controller.signal });
      turns.push({ round: 2, ...summarizeTurn(secondTurn), fixtureResult: "external_import" });
    } else {
      turns.push({ round: 2, skipped: true, reason: "first turn did not return a tool call" });
    }
    requests.push(...client.records);
    return { provider, requests, turns, status: "ok" };
  } catch (error) {
    requests.push(...client.records.filter((item) => !requests.includes(item)));
    return { provider, requests, turns, status: "error", error: describeError(error) };
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const imageBytes = new Uint8Array(await readFile(options.image));
  const imageMetadata = await stat(options.image);
  if (!imageMetadata.isFile() || imageBytes.byteLength === 0) throw new Error("--image must point to a non-empty regular file");
  const env = parseEnv(await readFile(options.envFile, "utf8"));
  const asset = makeAsset(options.image, imageBytes);
  const reader = new BytesAssetReader(imageBytes);
  const runId = "static-api-conformance" as RunId;
  const sessionId = "static-fixture-session" as ComputerSessionId;
  const viewport: Viewport = { width: 640, height: 360, coordinateSpace: "physical" };
  const firstObservation = makeObservation(runId, sessionId, "static-observation-1", asset, viewport);
  const secondObservation = makeObservation(runId, sessionId, "static-observation-2", asset, viewport);
  const compiler = new DefaultContextCompiler(createDefaultComputerTools());
  const firstInput = await compiler.compile({ goal: "Click the blue button in the synthetic UI once, then report whether the request was completed.", latestObservation: firstObservation, recentEvents: baseEvents(runId, sessionId, firstObservation) }, new AbortController().signal);
  const models: ProviderName[] = options.model === "all" ? ["glm-5.3-flash", "gui-plus-2026-02-26", "qwen3.8-flash"] : [options.model];
  const results: ModelRunResult[] = [];
  for (const provider of models) {
    const result = await runModel(provider, firstInput, env, reader, options.timeoutMs, options.qwenThinking, async (first, firstCall) => {
      const events = [
        ...baseEvents(runId, sessionId, firstObservation),
        makeEvent(runId, 5, "model.response.received", { turn: first }),
        makeEvent(runId, 6, "tool.call.completed", { result: { callId: firstCall.id, status: "completed", output: { fixture: "external_import", executed: false } } }),
        makeEvent(runId, 7, "observation.created", { observation: secondObservation }),
      ];
      return compiler.compile({ goal: "Click the blue button in the synthetic UI once, then report whether the request was completed.", latestObservation: secondObservation, recentEvents: events }, new AbortController().signal);
    });
    results.push(result);
  }
  await mkdir(options.output, { recursive: true });
  const summary = {
    kind: "static_api_conformance",
    protocol: "provider-adapter-v1",
    fixture: { kind: "synthetic_non_sensitive_image", fileName: basename(options.image), byteLength: imageBytes.byteLength, viewport },
    constraints: { noComputerExecute: true, noCua: true, maxRoundsPerProvider: 2, timeoutMs: options.timeoutMs, qwenThinking: options.qwenThinking },
    results,
  };
  await writeFile(resolve(options.output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ output: relative(process.cwd(), options.output), fixture: summary.fixture, results: results.map((result) => ({ provider: result.provider, status: result.status, requests: result.requests.length, turns: result.turns.length, error: result.error })) }, null, 2));
}

await main();
