import { createInterface } from "node:readline";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { CuaDriverComputer } from "@computer-harness/computer-cua";
import { OsworldBridgeClient, OsworldComputer } from "@computer-harness/computer-osworld";
import { DefaultContextCompiler } from "@computer-harness/context";
import type { RunId } from "@computer-harness/protocol";
import { FetchGlmHttpClient, GlmAdapter, glmProfiles, type GlmHttpClient, type GlmProfile, type GlmProfileName } from "@computer-harness/provider-glm";
import { FetchQwenHttpClient, Qwen38FlashAdapter, type Qwen38OutputMode, type Qwen38ThinkingMode, type QwenCoordinateMode, type QwenHttpClient } from "@computer-harness/provider-qwen";
import { createPlanningTools, FilePlanStore } from "@computer-harness/planning";
import { DefaultRuntimePolicy, RunController, createDefaultToolRegistry, type CleanupDiagnostic } from "@computer-harness/runtime";
import type { RunOutcome } from "@computer-harness/protocol";
import type { AssetReader } from "@computer-harness/runtime";
import { FileAssetStore, JsonlRunEventWriter, reduceRuntimeEvents, readRuntimeEvents } from "@computer-harness/trajectory";

type ModelName = GlmProfileName | "qwen3.8-flash";

interface CliOptions {
  goal: string;
  model: ModelName;
  computer: "cua" | "osworld";
  cuaSocket?: string;
  osworldBridge?: string;
  output: string;
  maxSteps: number;
  maxModelRequests: number;
  fixtureResult?: string;
  envFile?: string;
  screenshotDir?: string;
  qwenCoordinateMode?: QwenCoordinateMode;
  qwenThinking?: Qwen38ThinkingMode;
  qwenOutputMode?: Qwen38OutputMode;
  planning: boolean;
  interactive: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const goal = value("--goal");
  const model = value("--model") as ModelName | undefined;
  const computer = (value("--computer") ?? "cua") as "cua" | "osworld";
  if (goal === undefined || goal.trim().length === 0) throw new Error("--goal is required");
  if (model !== "glm-5.3-flash" && model !== "qwen3.8-flash") {
    throw new Error("--model must be glm-5.3-flash or qwen3.8-flash");
  }
  if (computer !== "cua" && computer !== "osworld") throw new Error("--computer must be cua or osworld");
  const cuaSocket = value("--cua-socket") ?? value("--socket");
  const osworldBridge = value("--osworld-bridge");
  if (computer === "cua" && (cuaSocket === undefined || cuaSocket.trim().length === 0)) throw new Error("--cua-socket is required when --computer cua");
  if (computer === "osworld" && (osworldBridge === undefined || osworldBridge.trim().length === 0)) throw new Error("--osworld-bridge is required when --computer osworld");
  const output = resolve(value("--output") ?? "runs/live-cli");
  const maxSteps = positiveInteger(value("--max-steps"), 30, "--max-steps");
  const maxModelRequests = positiveInteger(value("--max-model-requests"), 30, "--max-model-requests");
  const fixtureResult = value("--fixture-result");
  const envFile = value("--env-file");
  const screenshotDir = value("--screenshot-dir");
  const qwenCoordinateModeValue = value("--qwen-coordinate-mode");
  if (qwenCoordinateModeValue !== undefined && qwenCoordinateModeValue !== "normalized_1000" && qwenCoordinateModeValue !== "actual_pixels") {
    throw new Error("--qwen-coordinate-mode must be normalized_1000 or actual_pixels");
  }
  if (qwenCoordinateModeValue !== undefined && model !== "qwen3.8-flash") {
    throw new Error("--qwen-coordinate-mode is only valid with a Qwen model");
  }
  if (model === "qwen3.8-flash" && qwenCoordinateModeValue === undefined) {
    throw new Error("--qwen-coordinate-mode is required for qwen3.8-flash until coordinate calibration selects a mode");
  }
  const qwenThinkingValue = value("--qwen-thinking");
  if (qwenThinkingValue !== undefined && qwenThinkingValue !== "disabled" && qwenThinkingValue !== "low" && qwenThinkingValue !== "medium" && qwenThinkingValue !== "xhigh") {
    throw new Error("--qwen-thinking must be disabled, low, medium, or xhigh");
  }
  if (qwenThinkingValue !== undefined && model !== "qwen3.8-flash") {
    throw new Error("--qwen-thinking is only valid with qwen3.8-flash");
  }
  const qwenOutputModeValue = value("--qwen-output-mode");
  if (qwenOutputModeValue !== undefined && qwenOutputModeValue !== "native_tools" && qwenOutputModeValue !== "strict_json") {
    throw new Error("--qwen-output-mode must be native_tools or strict_json");
  }
  if (qwenOutputModeValue !== undefined && model !== "qwen3.8-flash") {
    throw new Error("--qwen-output-mode is only valid with qwen3.8-flash");
  }
  const interactive = argv.includes("--interactive");
  const planning = argv.includes("--planning");
  return {
    goal,
    model,
    computer,
    ...(cuaSocket === undefined ? {} : { cuaSocket }),
    ...(osworldBridge === undefined ? {} : { osworldBridge }),
    output,
    maxSteps,
    maxModelRequests,
    ...(fixtureResult === undefined ? {} : { fixtureResult: resolve(fixtureResult) }),
    ...(envFile === undefined ? {} : { envFile: resolve(envFile) }),
    ...(screenshotDir === undefined ? {} : { screenshotDir: resolve(screenshotDir) }),
    ...(qwenCoordinateModeValue === undefined ? {} : { qwenCoordinateMode: qwenCoordinateModeValue as QwenCoordinateMode }),
    ...(model === "qwen3.8-flash" ? { qwenThinking: (qwenThinkingValue ?? "low") as Qwen38ThinkingMode } : {}),
    ...(model === "qwen3.8-flash" ? { qwenOutputMode: (qwenOutputModeValue ?? "strict_json") as Qwen38OutputMode } : {}),
    planning,
    interactive,
  };
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write("Usage: computer-harness --goal <text> --model <glm-5.3-flash|qwen3.8-flash> --computer <cua|osworld> [--cua-socket <socket>|--osworld-bridge <url>] [--output <dir>] [--env-file <path>] [--fixture-result <json>] [--planning] [--qwen-coordinate-mode <normalized_1000|actual_pixels>] [--qwen-thinking <disabled|low|medium|xhigh>] [--qwen-output-mode <native_tools|strict_json>] [--interactive]\n");
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  if (options.envFile !== undefined) await loadEnvFile(options.envFile);
  const runId = (`run-${Date.now()}-${Math.random().toString(16).slice(2)}`) as RunId;
  await mkdir(options.output, { recursive: true });
  const assetStore = new FileAssetStore(resolve(options.output, "assets"));
  const eventWriter = new JsonlRunEventWriter(resolve(options.output, "trajectory.jsonl"), runId);
  const tools = createDefaultToolRegistry();
  const planStoreRoot = options.planning ? resolve(options.output, "plan-store") : undefined;
  if (planStoreRoot !== undefined) {
    tools.registerMany(createPlanningTools(new FilePlanStore(planStoreRoot)));
  }
  const assetReader = assetStore;
  const provider = makeProvider(options.model, assetReader, options.output, options.qwenCoordinateMode, options.qwenThinking, options.qwenOutputMode);
  const computer = options.computer === "cua"
    ? new CuaDriverComputer({
        socketPath: options.cuaSocket!,
        screenshotDir: options.screenshotDir ?? resolve(options.output, "driver-screenshots"),
      })
    : new OsworldComputer({
        bridge: new OsworldBridgeClient({
          baseUrl: options.osworldBridge!,
          ...(process.env.OSWORLD_BRIDGE_TOKEN === undefined ? {} : { token: process.env.OSWORLD_BRIDGE_TOKEN }),
        }),
      });
  const cleanupDiagnostics: CleanupDiagnostic[] = [];
  const controller = new RunController({
    runId,
    provider,
    computer,
    contextCompiler: new DefaultContextCompiler(tools),
    toolRegistry: tools,
    policy: new DefaultRuntimePolicy(options.maxSteps, options.maxModelRequests),
    eventWriter,
    assetStore,
    onCleanupError: (diagnostic) => cleanupDiagnostics.push(diagnostic),
  });
  const outcome = await runWithCliControls(controller, options.goal, options.interactive);
  const events = await readRuntimeEvents(resolve(options.output, "trajectory.jsonl"));
  const snapshot = reduceRuntimeEvents(events, runId);
  const fixture = await readFixtureResult(options.fixtureResult);
  const summary = {
    runId,
    model: options.model,
    computer: options.computer,
    coordinateMode: options.qwenCoordinateMode ?? null,
    thinkingMode: options.qwenThinking ?? null,
    outputMode: options.qwenOutputMode ?? null,
    glmThinking: process.env.GLM_THINKING === "disabled" || process.env.GLM_THINKING === "enabled" ? process.env.GLM_THINKING : "enabled",
    planning: options.planning,
    tools: tools.modelTools().map((tool) => tool.name),
    planStoreRoot: planStoreRoot ?? null,
    computerSession: snapshot.computerSession ?? null,
    runtimeOutcome: outcome,
    modelSummary: snapshot.summary ?? null,
    modelReportedStatus: snapshot.reportedStatus ?? null,
    modelUsage: snapshot.modelUsage ?? null,
    cleanupDiagnostics,
    fixture,
    trajectory: resolve(options.output, "trajectory.jsonl"),
    providerExchanges: resolve(options.output, "provider-exchanges.jsonl"),
    metrics: {
      steps: snapshot.stepCount,
      modelRequests: snapshot.modelRequestCount,
      eventCount: events.length,
      invalidToolCalls: events.filter((event) => event.type === "tool.call.rejected").length,
      rejectedToolCalls: events.filter((event) => event.type === "tool.call.rejected").length,
      budgetRejectedToolCalls: events.filter((event) => event.type === "tool.call.rejected" && /action budget exhausted/iu.test(event.reason)).length,
      budgetRuntimeErrors: events.filter((event) => event.type === "runtime.error" && event.category === "budget").length,
      argumentRejectedToolCalls: events.filter((event) => event.type === "tool.call.rejected" && /invalid arguments|invalid GUI action/iu.test(event.reason)).length,
      toolExecutionFailed: events.filter((event) => event.type === "tool.call.failed").length,
      providerFailed: events.filter((event) => event.type === "model.request.failed").length,
      runtimeErrors: events.filter((event) => event.type === "runtime.error").length,
      providerErrors: events
        .filter((event): event is Extract<typeof event, { type: "model.request.failed" }> => event.type === "model.request.failed")
        .map((event) => ({ category: event.category, code: event.code ?? null, retryable: event.retryable ?? null, message: event.message })),
    },
  };
  await writeFile(resolve(options.output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

function makeProvider(model: ModelName, assetReader: AssetReader, output: string, qwenCoordinateMode?: QwenCoordinateMode, qwenThinking?: Qwen38ThinkingMode, qwenOutputMode?: Qwen38OutputMode) {
  if (model === "qwen3.8-flash") {
    const key = process.env.DASHSCOPE_API_KEY;
    if (key === undefined || key.trim().length === 0) throw new Error("DASHSCOPE_API_KEY is required for qwen3.8-flash");
    const endpoint = process.env.DASHSCOPE_BASE_URL ?? process.env.DASHSCOPE_ENDPOINT;
    const workspaceId = process.env.DASHSCOPE_WORKSPACE_ID;
    return new Qwen38FlashAdapter({ apiKey: key, assetReader, httpClient: new RecordingQwenHttpClient(resolve(output, "provider-exchanges.jsonl"), qwenCoordinateMode ?? "normalized_1000", qwenThinking ?? "low", qwenOutputMode ?? "strict_json"), thinking: qwenThinking ?? "low", coordinateMode: qwenCoordinateMode ?? "normalized_1000", outputMode: qwenOutputMode ?? "strict_json", ...(endpoint === undefined ? {} : { endpoint }), ...(workspaceId === undefined ? {} : { workspaceId }) });
  }
  const key = process.env.ZHIPUAI_API_KEY ?? process.env.ZHIPU_API_KEY ?? process.env.GLM_API_KEY;
  if (key === undefined || key.trim().length === 0) throw new Error("ZHIPUAI_API_KEY is required for GLM profiles");
  const configuredThinking = process.env.GLM_THINKING;
  const profile: GlmProfile = {
    ...glmProfiles[model],
    thinking: configuredThinking === "disabled" ? "disabled" : "enabled",
  };
  return new GlmAdapter({ apiKey: key, profile, assetReader, httpClient: new RecordingGlmHttpClient(resolve(output, "provider-exchanges.jsonl")), ...(process.env.GLM_BASE_URL === undefined ? {} : { endpoint: process.env.GLM_BASE_URL }) });
}

class RecordingGlmHttpClient implements GlmHttpClient {
  private readonly inner = new FetchGlmHttpClient();
  private requestNumber = 0;

  public constructor(private readonly path: string) {}

  public async post(url: string, body: Record<string, unknown>, headers: Readonly<Record<string, string>>, signal: AbortSignal): Promise<unknown> {
    this.requestNumber += 1;
    const startedAt = Date.now();
    try {
      const response = await this.inner.post(url, body, headers, signal);
      await appendFile(this.path, `${JSON.stringify({
        provider: "glm",
        request: this.requestNumber,
        latencyMs: Date.now() - startedAt,
        requestedModel: typeof body.model === "string" ? body.model : null,
        toolNames: providerToolNames(body.tools),
        response: summarizeProviderResponse(response),
      })}\n`, "utf8");
      return response;
    } catch (error) {
      await appendFile(this.path, `${JSON.stringify({
        provider: "glm",
        request: this.requestNumber,
        latencyMs: Date.now() - startedAt,
        requestedModel: typeof body.model === "string" ? body.model : null,
        transportError: error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) },
      })}\n`, "utf8");
      throw error;
    }
  }
}

class RecordingQwenHttpClient implements QwenHttpClient {
  private readonly inner = new FetchQwenHttpClient();
  private requestNumber = 0;

  public constructor(
    private readonly path: string,
    private readonly coordinateMode: QwenCoordinateMode,
    private readonly thinkingMode?: Qwen38ThinkingMode,
    private readonly outputMode: Qwen38OutputMode = "strict_json",
  ) {}

  public async post(url: string, body: Record<string, unknown>, headers: Readonly<Record<string, string>>, signal: AbortSignal): Promise<unknown> {
    this.requestNumber += 1;
    const startedAt = Date.now();
    try {
      const response = await this.inner.post(url, body, headers, signal);
      await appendFile(this.path, `${JSON.stringify({
        request: this.requestNumber,
        latencyMs: Date.now() - startedAt,
        requestedModel: typeof body.model === "string" ? body.model : null,
        coordinateMode: this.coordinateMode,
        thinkingMode: this.thinkingMode ?? null,
        outputMode: this.outputMode,
        toolNames: providerToolNames(body.tools),
        response: summarizeProviderResponse(response),
      })}\n`, "utf8");
      return response;
    } catch (error) {
      await appendFile(this.path, `${JSON.stringify({
        request: this.requestNumber,
        latencyMs: Date.now() - startedAt,
        requestedModel: typeof body.model === "string" ? body.model : null,
        transportError: error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) },
      })}\n`, "utf8");
      throw error;
    }
  }
}

function providerToolNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => isPlainRecord(item) && isPlainRecord(item.function) && typeof item.function.name === "string" ? [item.function.name] : []);
}

function summarizeProviderResponse(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) return { shape: typeof value };
  const choice = Array.isArray(value.choices) && isPlainRecord(value.choices[0]) ? value.choices[0] : undefined;
  const message = choice !== undefined && isPlainRecord(choice.message) ? choice.message : undefined;
  const calls = message !== undefined && Array.isArray(message.tool_calls)
    ? message.tool_calls.map((call) => {
        const record = isPlainRecord(call) ? call : undefined;
        const fn = record !== undefined && isPlainRecord(record.function) ? record.function : undefined;
        return {
          id: record !== undefined && typeof record.id === "string" ? record.id : null,
          type: record !== undefined && typeof record.type === "string" ? record.type : null,
          name: fn !== undefined && typeof fn.name === "string" ? fn.name : null,
          arguments: fn !== undefined && typeof fn.arguments === "string" ? fn.arguments : null,
        };
      })
    : [];
  return {
    model: typeof value.model === "string" ? value.model : null,
    finishReason: choice !== undefined && typeof choice.finish_reason === "string" ? choice.finish_reason : null,
    contentLength: message !== undefined && typeof message.content === "string" ? message.content.length : 0,
    reasoningContentLength: message !== undefined && typeof message.reasoning_content === "string" ? message.reasoning_content.length : 0,
    toolCalls: calls,
    structuredContent: summarizeStructuredContent(message?.content),
    usage: isPlainRecord(value.usage) ? value.usage : null,
  };
}

function summarizeStructuredContent(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return { json: false };
  }
  if (!isPlainRecord(parsed)) return { json: true, rootType: Array.isArray(parsed) ? "array" : typeof parsed };
  return {
    json: true,
    kind: typeof parsed.kind === "string" ? parsed.kind : null,
    id: typeof parsed.id === "string" ? parsed.id : null,
    name: typeof parsed.name === "string" ? parsed.name : null,
    arguments: summarizeProviderArguments(parsed.arguments),
    textLength: typeof parsed.text === "string" ? parsed.text.length : 0,
  };
}

function summarizeProviderArguments(value: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(value)) return null;
  const result: Record<string, unknown> = {};
  for (const key of ["x", "y", "fromX", "fromY", "toX", "toY", "durationMs", "ticks", "direction", "status"]) {
    const item = value[key];
    if (typeof item === "number" || typeof item === "string") result[key] = item;
  }
  if (typeof value.text === "string") result.textLength = value.text.length;
  if (Array.isArray(value.keys)) result.keyCount = value.keys.length;
  return result;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadEnvFile(path: string): Promise<void> {
  const text = await readFile(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

async function runWithCliControls(controller: RunController, goal: string, interactive: boolean): Promise<RunOutcome> {
  let lastQuestion: string | undefined;
  const monitor = setInterval(() => {
    const snapshot = controller.getSnapshot();
    if (snapshot.status !== "waiting_user" || snapshot.pendingUserQuestion === lastQuestion) return;
    lastQuestion = snapshot.pendingUserQuestion;
    process.stdout.write(`User input required: ${snapshot.pendingUserQuestion}\n`);
    if (!interactive) {
      try {
        controller.cancel("non-interactive CLI cannot answer user input");
      } catch {
        // The run may have finished between the poll and cancellation.
      }
    }
  }, 100);
  const readline = interactive
    ? createInterface({ input: process.stdin, output: process.stdout })
    : undefined;
  const onLine = (line: string) => {
    if (controller.getSnapshot().status !== "waiting_user") {
      process.stdout.write("Input ignored: the run is not waiting for user input.\n");
      return;
    }
    void controller.submitUserInput(line).catch((error: unknown) => {
      process.stderr.write(`Could not submit user input: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  };
  readline?.on("line", onLine);
  const onSigint = () => {
    try {
      controller.cancel("SIGINT");
    } catch {
      // Ignore a second Ctrl+C after the run has already finished.
    }
  };
  process.once("SIGINT", onSigint);
  try {
    return await controller.start(goal);
  } finally {
    clearInterval(monitor);
    readline?.close();
    process.removeListener("SIGINT", onSigint);
  }
}

async function readFixtureResult(path: string | undefined): Promise<{ status: "not_configured" } | { status: "external_import"; success: boolean; reason?: string }> {
  if (path === undefined) return { status: "not_configured" };
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (typeof value !== "object" || value === null || typeof (value as { success?: unknown }).success !== "boolean") throw new Error("fixture result must be JSON with boolean success");
  const reason = (value as { reason?: unknown }).reason;
  return typeof reason === "string" ? { status: "external_import", success: (value as { success: boolean }).success, reason } : { status: "external_import", success: (value as { success: boolean }).success };
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
