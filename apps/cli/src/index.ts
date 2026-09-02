import { createInterface } from "node:readline";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { CuaDriverComputer } from "@computer-harness/computer-cua";
import { DefaultContextCompiler } from "@computer-harness/context";
import type { RunId } from "@computer-harness/protocol";
import { GlmAdapter, type GlmProfileName } from "@computer-harness/provider-glm";
import { QwenGuiPlusAdapter } from "@computer-harness/provider-qwen";
import { DefaultRuntimePolicy, RunController, createDefaultComputerTools, type CleanupDiagnostic } from "@computer-harness/runtime";
import type { RunOutcome } from "@computer-harness/protocol";
import type { AssetReader } from "@computer-harness/runtime";
import { FileAssetStore, JsonlRunEventWriter, reduceRuntimeEvents, readRuntimeEvents } from "@computer-harness/trajectory";

type ModelName = GlmProfileName | "gui-plus-2026-02-26";

interface CliOptions {
  goal: string;
  model: ModelName;
  socket: string;
  output: string;
  maxSteps: number;
  maxModelRequests: number;
  fixtureResult?: string;
  envFile?: string;
  screenshotDir?: string;
  interactive: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const goal = value("--goal");
  const model = value("--model") as ModelName | undefined;
  const socket = value("--cua-socket") ?? value("--socket");
  if (goal === undefined || goal.trim().length === 0) throw new Error("--goal is required");
  if (model !== "glm-5.3-flash" && model !== "gui-plus-2026-02-26") {
    throw new Error("--model must be glm-5.3-flash or gui-plus-2026-02-26");
  }
  if (socket === undefined || socket.trim().length === 0) throw new Error("--cua-socket is required");
  const output = resolve(value("--output") ?? "runs/live-cli");
  const maxSteps = positiveInteger(value("--max-steps"), 30, "--max-steps");
  const maxModelRequests = positiveInteger(value("--max-model-requests"), 30, "--max-model-requests");
  const fixtureResult = value("--fixture-result");
  const envFile = value("--env-file");
  const screenshotDir = value("--screenshot-dir");
  const interactive = argv.includes("--interactive");
  return {
    goal,
    model,
    socket,
    output,
    maxSteps,
    maxModelRequests,
    ...(fixtureResult === undefined ? {} : { fixtureResult: resolve(fixtureResult) }),
    ...(envFile === undefined ? {} : { envFile: resolve(envFile) }),
    ...(screenshotDir === undefined ? {} : { screenshotDir: resolve(screenshotDir) }),
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
    process.stdout.write("Usage: computer-harness --goal <text> --model <glm-5.3-flash|gui-plus-2026-02-26> --cua-socket <socket> [--output <dir>] [--env-file <path>] [--fixture-result <json>] [--interactive]\n");
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  if (options.envFile !== undefined) await loadEnvFile(options.envFile);
  const runId = (`run-${Date.now()}-${Math.random().toString(16).slice(2)}`) as RunId;
  await mkdir(options.output, { recursive: true });
  const assetStore = new FileAssetStore(resolve(options.output, "assets"));
  const eventWriter = new JsonlRunEventWriter(resolve(options.output, "trajectory.jsonl"), runId);
  const tools = createDefaultComputerTools();
  const assetReader = assetStore;
  const provider = makeProvider(options.model, assetReader);
  const computer = new CuaDriverComputer({
    socketPath: options.socket,
    screenshotDir: options.screenshotDir ?? resolve(options.output, "driver-screenshots"),
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
    computerSession: snapshot.computerSession ?? null,
    runtimeOutcome: outcome,
    modelSummary: snapshot.summary ?? null,
    modelReportedStatus: snapshot.reportedStatus ?? null,
    modelUsage: snapshot.modelUsage ?? null,
    cleanupDiagnostics,
    fixture,
    trajectory: resolve(options.output, "trajectory.jsonl"),
    metrics: {
      steps: snapshot.stepCount,
      modelRequests: snapshot.modelRequestCount,
      eventCount: events.length,
      invalidToolCalls: events.filter((event) => event.type === "tool.call.rejected").length,
      runtimeErrors: events.filter((event) => event.type === "runtime.error").length,
      providerErrors: events
        .filter((event): event is Extract<typeof event, { type: "model.request.failed" }> => event.type === "model.request.failed")
        .map((event) => ({ category: event.category, code: event.code ?? null, retryable: event.retryable ?? null, message: event.message })),
    },
  };
  await writeFile(resolve(options.output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

function makeProvider(model: ModelName, assetReader: AssetReader) {
  if (model === "gui-plus-2026-02-26") {
    const key = process.env.DASHSCOPE_API_KEY;
    if (key === undefined || key.trim().length === 0) throw new Error("DASHSCOPE_API_KEY is required for gui-plus-2026-02-26");
    const endpoint = process.env.DASHSCOPE_BASE_URL ?? process.env.DASHSCOPE_ENDPOINT;
    const workspaceId = process.env.DASHSCOPE_WORKSPACE_ID;
    return new QwenGuiPlusAdapter({ apiKey: key, assetReader, ...(endpoint === undefined ? {} : { endpoint }), ...(workspaceId === undefined ? {} : { workspaceId }) });
  }
  const key = process.env.ZHIPUAI_API_KEY ?? process.env.ZHIPU_API_KEY ?? process.env.GLM_API_KEY;
  if (key === undefined || key.trim().length === 0) throw new Error("ZHIPUAI_API_KEY is required for GLM profiles");
  return new GlmAdapter({ apiKey: key, profile: model, assetReader, ...(process.env.GLM_BASE_URL === undefined ? {} : { endpoint: process.env.GLM_BASE_URL }) });
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
