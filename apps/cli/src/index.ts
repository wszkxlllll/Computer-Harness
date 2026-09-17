import { createInterface } from "node:readline";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { CuaDriverComputer } from "@computer-harness/computer-cua";
import { OsworldBridgeClient, OsworldComputer } from "@computer-harness/computer-osworld";
import { DefaultContextCompiler } from "@computer-harness/context";
import type { RunId } from "@computer-harness/protocol";
import { GlmAdapter, glmProfiles, type GlmProfile, type GlmProfileName } from "@computer-harness/provider-glm";
import { Qwen38FlashAdapter, type Qwen38OutputMode, type Qwen38ThinkingMode, type QwenCoordinateMode } from "@computer-harness/provider-qwen";
import { createPlanningTools, FilePlanStore } from "@computer-harness/planning";
import { createMemoryTools, FileMemoryStore, type MemoryToolMode } from "@computer-harness/memory";
import { DefaultRuntimePolicy, RunController, createDefaultToolRegistry, type CleanupDiagnostic } from "@computer-harness/runtime";
import { LayeredRiskGuard, ProviderRiskAssessor } from "@computer-harness/risk-guard";
import { runWithTuiControls } from "./tui.js";
import { RecordingGlmHttpClient, RecordingQwenHttpClient } from "./diagnostics/recording-clients.js";
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
  memory: "off" | MemoryToolMode;
  batching: "off" | "same-control-input-v1";
  contextMode: "raw" | "recent";
  contextMaxHistoryEvents: number;
  contextMaxInputTokens?: number;
  interactive: boolean;
  tui: boolean;
  riskGuard: "off" | "layered";
  riskModel: "off" | "same" | ModelName;
  riskMaxModelRequests: number;
  riskTimeoutMs: number;
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
  const tui = argv.includes("--tui");
  const interactive = argv.includes("--interactive") || tui;
  const riskGuardValue = value("--risk-guard") ?? "off";
  if (riskGuardValue !== "off" && riskGuardValue !== "layered") throw new Error("--risk-guard must be off or layered");
  const riskModelValue = value("--risk-model") ?? "off";
  if (riskModelValue !== "off" && riskModelValue !== "same" && riskModelValue !== "glm-5.3-flash" && riskModelValue !== "qwen3.8-flash") throw new Error("--risk-model must be off, same, glm-5.3-flash, or qwen3.8-flash");
  if (riskGuardValue === "off" && riskModelValue !== "off") throw new Error("--risk-model requires --risk-guard layered");
  const riskMaxModelRequests = positiveInteger(value("--risk-max-model-requests"), 20, "--risk-max-model-requests");
  const riskTimeoutMs = positiveInteger(value("--risk-timeout-ms"), 30_000, "--risk-timeout-ms");
  const planning = argv.includes("--planning");
  const memoryValue = value("--memory") ?? "off";
  if (memoryValue !== "off" && memoryValue !== "facts" && memoryValue !== "entities") throw new Error("--memory must be off, facts, or entities");
  const batchingValue = value("--batching") ?? "off";
  if (batchingValue !== "off" && batchingValue !== "same-control-input-v1") throw new Error("--batching must be off or same-control-input-v1");
  const contextModeValue = value("--context-mode") ?? "raw";
  if (contextModeValue !== "raw" && contextModeValue !== "recent") throw new Error("--context-mode must be raw or recent");
  const contextMaxHistoryEvents = positiveInteger(value("--context-max-events"), 80, "--context-max-events");
  const contextMaxInputTokensValue = value("--context-max-tokens");
  const contextMaxInputTokens = contextMaxInputTokensValue === undefined ? undefined : positiveInteger(contextMaxInputTokensValue, 1, "--context-max-tokens");
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
    memory: memoryValue as "off" | MemoryToolMode,
    batching: batchingValue as "off" | "same-control-input-v1",
    contextMode: contextModeValue as "raw" | "recent",
    contextMaxHistoryEvents,
    ...(contextMaxInputTokens === undefined ? {} : { contextMaxInputTokens }),
    interactive,
    tui,
    riskGuard: riskGuardValue,
    riskModel: riskModelValue as "off" | "same" | ModelName,
    riskMaxModelRequests,
    riskTimeoutMs,
  };
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write("Usage: computer-harness --goal <text> --model <glm-5.3-flash|qwen3.8-flash> --computer <cua|osworld> [--cua-socket <socket>|--osworld-bridge <url>] [--output <dir>] [--env-file <path>] [--fixture-result <json>] [--planning] [--memory <off|facts|entities>] [--batching <off|same-control-input-v1>] [--context-mode <raw|recent>] [--context-max-events <n>] [--context-max-tokens <n>] [--risk-guard <off|layered>] [--risk-model <off|same|glm-5.3-flash|qwen3.8-flash>] [--risk-max-model-requests <n>] [--risk-timeout-ms <n>] [--qwen-coordinate-mode <normalized_1000|actual_pixels>] [--qwen-thinking <disabled|low|medium|xhigh>] [--qwen-output-mode <native_tools|strict_json>] [--interactive|--tui]\n");
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
  const memoryStore = options.memory === "off" ? undefined : new FileMemoryStore(resolve(options.output, "memory-store"));
  if (memoryStore !== undefined) tools.registerMany(createMemoryTools(memoryStore, options.memory === "off" ? "facts" : options.memory));
  const features = {
    planning: options.planning ? "tasks-v1" as const : "off" as const,
    memory: options.memory === "off" ? "off" as const : options.memory === "facts" ? "facts-v1" as const : "entities-v1" as const,
    batching: options.batching,
    riskGuard: options.riskGuard,
  };
  const assetReader = assetStore;
  const provider = makeProvider(options.model, assetReader, options.output, options.qwenCoordinateMode, options.qwenThinking, options.qwenOutputMode);
  if (options.riskModel !== "off" && options.riskModel !== "same") await mkdir(resolve(options.output, "risk-review"), { recursive: true });
  const riskProvider = options.riskModel === "off"
    ? undefined
    : options.riskModel === "same"
      ? provider
      : makeProvider(options.riskModel, assetReader, resolve(options.output, "risk-review"), options.riskModel === "qwen3.8-flash" ? options.qwenCoordinateMode ?? "normalized_1000" : undefined, options.riskModel === "qwen3.8-flash" ? options.qwenThinking : undefined, options.riskModel === "qwen3.8-flash" ? options.qwenOutputMode : undefined);
  const actionPolicy = options.riskGuard === "layered"
    ? new LayeredRiskGuard({
        ...(riskProvider === undefined ? {} : { assessor: new ProviderRiskAssessor(riskProvider) }),
        maxModelRequests: options.riskMaxModelRequests,
        timeoutMs: options.riskTimeoutMs,
      })
    : undefined;
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
    contextCompiler: new DefaultContextCompiler(tools, { mode: options.contextMode, maxHistoryEvents: options.contextMaxHistoryEvents, features, ...(options.contextMaxInputTokens === undefined ? {} : { maxInputTokens: options.contextMaxInputTokens }) }),
    toolRegistry: tools,
    policy: new DefaultRuntimePolicy(options.maxSteps, options.maxModelRequests),
    ...(actionPolicy === undefined ? {} : { actionPolicy }),
    eventWriter,
    assetStore,
    onCleanupError: (diagnostic) => cleanupDiagnostics.push(diagnostic),
    batching: options.batching,
    features,
  });
  const outcome = options.tui
    ? await runWithTuiControls(controller, options.goal, { provider: options.model, computer: options.computer, output: options.output })
    : await runWithCliControls(controller, options.goal, options.interactive);
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
    memory: options.memory,
    batching: options.batching,
    riskGuard: options.riskGuard,
    riskModel: options.riskModel,
    contextMode: options.contextMode,
    contextMaxHistoryEvents: options.contextMaxHistoryEvents,
    contextMaxInputTokens: options.contextMaxInputTokens ?? null,
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
      guardEvaluations: snapshot.guardEvaluationCount,
      riskModelRequests: snapshot.riskModelRequestCount,
      approvalsRequested: events.filter((event) => event.type === "approval.requested").length,
      guardDecisions: events.filter((event) => event.type === "action.guard.evaluated").reduce((counts, event) => ({ ...counts, [event.decision]: (counts[event.decision] ?? 0) + 1 }), {} as Record<string, number>),
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
  let lastApprovalId: string | undefined;
  const monitor = setInterval(() => {
    const snapshot = controller.getSnapshot();
    if (snapshot.status === "waiting_user" && snapshot.pendingUserQuestion !== lastQuestion) {
      lastQuestion = snapshot.pendingUserQuestion;
      process.stdout.write(`User input required: ${snapshot.pendingUserQuestion}\n`);
      if (!interactive) {
        try { controller.cancel("non-interactive CLI cannot answer user input"); } catch { /* finished concurrently */ }
      }
    }
    if (snapshot.status === "waiting_approval" && snapshot.pendingApproval !== undefined && snapshot.pendingApproval.requestId !== lastApprovalId) {
      lastApprovalId = snapshot.pendingApproval.requestId;
      process.stdout.write(`Approval required (${snapshot.pendingApproval.requestId}): ${snapshot.pendingApproval.reason}\nApprove? [y/N]\n`);
      if (!interactive) void controller.resolveApproval(snapshot.pendingApproval.requestId, false).catch(() => undefined);
    }
  }, 100);
  const readline = interactive
    ? createInterface({ input: process.stdin, output: process.stdout })
    : undefined;
  const onLine = (line: string) => {
    const snapshot = controller.getSnapshot();
    if (snapshot.status === "waiting_approval" && snapshot.pendingApproval !== undefined) {
      const approved = /^(?:y|yes)$/iu.test(line.trim());
      void controller.resolveApproval(snapshot.pendingApproval.requestId, approved).catch((error: unknown) => {
        process.stderr.write(`Could not resolve approval: ${error instanceof Error ? error.message : String(error)}\n`);
      });
      return;
    }
    if (snapshot.status !== "waiting_user") {
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
