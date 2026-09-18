import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ApplicationSession, createRun, writeRunReport, type AppRuntimeModel, type ProviderCredentials, type ResolvedRunConfig } from "@computer-harness/app-runtime";
import type { RunOutcome } from "@computer-harness/protocol";
import type { RunController } from "@computer-harness/runtime";
import { runApplicationTui } from "./tui.js";
import { runCuaDoctor } from "./doctor-command.js";
import { resolveCliModel } from "./cli-model.js";
import { resolveRiskConfig, type ResolvedRiskConfig } from "./config.js";
import { sanitizeTerminalText } from "./terminal-output.js";
import { resolveCuaWindowTargetOptions } from "./window-target-options.js";

type ModelName = AppRuntimeModel;
type MemoryToolMode = "facts" | "entities";
type QwenCoordinateMode = "normalized_1000" | "actual_pixels";
type Qwen38ThinkingMode = "disabled" | "low" | "medium" | "xhigh";
type Qwen38OutputMode = "native_tools" | "strict_json";

interface CliOptions {
  doctor: boolean;
  goal?: string;
  model: ModelName;
  computer: "cua" | "osworld";
  cuaSocket?: string;
  cuaWindowTarget?: { pid: number; windowId: number };
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
  risk: ResolvedRiskConfig;
  riskModel: "off" | "same" | ModelName;
  riskMaxModelRequests: number;
  riskTimeoutMs: number;
  cleanupDeadlineMs: number;
  doctorTimeoutMs: number;
}

function parseArgs(rawArgv: readonly string[]): CliOptions {
  // pnpm's `start -- ...` forwards the separator as a literal argv entry;
  // treat it as transport syntax, not as a CLI option.
  const argv = rawArgv[0] === "--" ? rawArgv.slice(1) : rawArgv;
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const doctor = argv.includes("--doctor");
  const goal = value("--goal");
  const tui = argv.includes("--tui");
  const modelValue = value("--model");
  const model = resolveCliModel(modelValue, doctor) as ModelName;
  const computer = (value("--computer") ?? "cua") as "cua" | "osworld";
  if ((goal === undefined || goal.trim().length === 0) && !tui && !doctor) throw new Error("--goal is required unless --tui opens the interactive home or --doctor runs a read-only CUA diagnostic");
  if (doctor && goal !== undefined) throw new Error("--doctor cannot be combined with --goal");
  if (doctor && (tui || argv.includes("--interactive"))) throw new Error("--doctor cannot be combined with --tui or --interactive");
  if (computer !== "cua" && computer !== "osworld") throw new Error("--computer must be cua or osworld");
  if (doctor && computer !== "cua") throw new Error("--doctor currently supports only --computer cua");
  const cuaSocket = value("--cua-socket") ?? value("--socket");
  const osworldBridge = value("--osworld-bridge");
  if (computer === "cua" && (cuaSocket === undefined || cuaSocket.trim().length === 0)) throw new Error("--cua-socket is required when --computer cua");
  if (computer === "osworld" && (osworldBridge === undefined || osworldBridge.trim().length === 0)) throw new Error("--osworld-bridge is required when --computer osworld");
  const cuaWindowPidValue = value("--cua-window-pid");
  const cuaWindowIdValue = value("--cua-window-id");
  const cuaWindowTarget = resolveCuaWindowTargetOptions({ pid: cuaWindowPidValue, windowId: cuaWindowIdValue, computer, doctor });
  const output = resolve(value("--output") ?? "runs/live-cli");
  const maxSteps = positiveInteger(value("--max-steps"), 30, "--max-steps");
  const maxModelRequests = positiveInteger(value("--max-model-requests"), 30, "--max-model-requests");
  const fixtureResult = value("--fixture-result");
  const envFile = value("--env-file");
  if (doctor && envFile !== undefined) throw new Error("--doctor does not read --env-file or provider credentials");
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
  const interactive = argv.includes("--interactive") || tui;
  const profileValue = value("--profile");
  const riskGuardValue = value("--risk-guard");
  const risk = resolveRiskConfig({
    ...(profileValue === undefined ? {} : { profile: profileValue }),
    ...(riskGuardValue === undefined ? {} : { riskGuard: riskGuardValue }),
    interactive,
    tui,
    confirmRiskGuardOff: argv.includes("--confirm-risk-guard-off"),
  });
  const riskModelValue = value("--risk-model") ?? "off";
  if (riskModelValue !== "off" && riskModelValue !== "same" && riskModelValue !== "glm-5.3-flash" && riskModelValue !== "qwen3.8-flash") throw new Error("--risk-model must be off, same, glm-5.3-flash, or qwen3.8-flash");
  if (risk.riskGuard === "off" && riskModelValue !== "off") throw new Error("--risk-model requires --risk-guard layered");
  const riskMaxModelRequests = positiveInteger(value("--risk-max-model-requests"), 20, "--risk-max-model-requests");
  const riskTimeoutMs = positiveInteger(value("--risk-timeout-ms"), 30_000, "--risk-timeout-ms");
  const cleanupDeadlineMs = positiveInteger(value("--cleanup-deadline-ms"), 5_000, "--cleanup-deadline-ms");
  const doctorTimeoutMs = positiveInteger(value("--doctor-timeout-ms"), 2_000, "--doctor-timeout-ms");
  if (!doctor && argv.includes("--doctor-timeout-ms")) throw new Error("--doctor-timeout-ms requires --doctor");
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
    doctor,
    ...(goal === undefined ? {} : { goal }),
    model,
    computer,
    ...(cuaSocket === undefined ? {} : { cuaSocket }),
    ...(cuaWindowTarget === undefined ? {} : { cuaWindowTarget }),
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
    risk,
    riskModel: riskModelValue as "off" | "same" | ModelName,
    riskMaxModelRequests,
    riskTimeoutMs,
    cleanupDeadlineMs,
    doctorTimeoutMs,
  };
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write("Usage: computer-harness --doctor --computer cua --cua-socket <socket> [--doctor-timeout-ms <n>]\n   or: computer-harness [--goal <text>] --model <glm-5.3-flash|qwen3.8-flash> --computer <cua|osworld> [--cua-socket <socket>|--osworld-bridge <url>] [--cua-window-pid <n> --cua-window-id <n>] [--output <dir>] [--env-file <path>] [--fixture-result <json>] [--planning] [--memory <off|facts|entities>] [--batching <off|same-control-input-v1>] [--context-mode <raw|recent>] [--context-max-events <n>] [--context-max-tokens <n>] [--profile <experiment|live-interactive>] [--risk-guard <off|layered>] [--confirm-risk-guard-off] [--risk-model <off|same|glm-5.3-flash|qwen3.8-flash>] [--risk-max-model-requests <n>] [--risk-timeout-ms <n>] [--cleanup-deadline-ms <n>] [--qwen-coordinate-mode <normalized_1000|actual_pixels>] [--qwen-thinking <disabled|low|medium|xhigh>] [--qwen-output-mode <native_tools|strict_json>] [--interactive|--tui]\nWhen --tui is used without --goal, the home screen accepts a pasted goal and starts fresh Runs. --doctor performs only redacted CUA daemon checks and never reads provider credentials. CUA window flags are explicit host opt-in; keyboard input remains disabled until focus delivery is independently verified.\n");
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  if (options.doctor) {
    const report = await runCuaDoctor({ socketPath: options.cuaSocket!, timeoutMs: options.doctorTimeoutMs });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.status !== "supported") process.exitCode = 1;
    return;
  }
  if (options.envFile !== undefined) await loadEnvFile(options.envFile);
  if (options.tui) {
    const config = toResolvedRunConfig(options, options.goal ?? "");
    const { goal: _goal, runId: _runId, ...sessionConfig } = config;
    const session = new ApplicationSession({
      config: sessionConfig,
      dependencies: { credentials: readProviderCredentials() },
    });
    await runApplicationTui(session, {
      provider: options.model,
      computer: options.computer,
      output: options.output,
      profile: options.risk.profile,
      riskGuard: options.risk.riskGuard,
    }, options.goal === undefined ? {} : { initialGoal: options.goal });
    return;
  }
  const config = toResolvedRunConfig(options, options.goal!);
  const handle = await createRun(config, { credentials: readProviderCredentials() });
  try {
    await handle.start((controller, goal, markControllerStarted) => runWithCliControls(controller, goal, options.interactive, markControllerStarted));
    const report = await handle.report();
    await writeRunReport(report, config.outputDir);
    process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function toResolvedRunConfig(options: CliOptions, goal: string): ResolvedRunConfig {
  const qwenEndpoint = process.env.DASHSCOPE_BASE_URL ?? process.env.DASHSCOPE_ENDPOINT;
  return {
    goal,
    model: options.model,
    computer: options.computer === "cua"
      ? {
          kind: "cua",
          socketPath: options.cuaSocket!,
          screenshotDir: options.screenshotDir ?? resolve(options.output, "driver-screenshots"),
          ...(options.cuaWindowTarget === undefined ? {} : { windowTarget: options.cuaWindowTarget }),
        }
      : {
          kind: "osworld",
          bridgeUrl: options.osworldBridge!,
        },
    outputDir: options.output,
    maxSteps: options.maxSteps,
    maxModelRequests: options.maxModelRequests,
    planning: options.planning,
    memory: options.memory,
    batching: options.batching,
    contextMode: options.contextMode,
    contextMaxHistoryEvents: options.contextMaxHistoryEvents,
    ...(options.contextMaxInputTokens === undefined ? {} : { contextMaxInputTokens: options.contextMaxInputTokens }),
    riskProfile: options.risk.profile,
    riskGuard: options.risk.riskGuard,
    riskModel: options.riskModel,
    riskMaxModelRequests: options.riskMaxModelRequests,
    riskTimeoutMs: options.riskTimeoutMs,
    cleanupDeadlineMs: options.cleanupDeadlineMs,
    ...(options.qwenCoordinateMode === undefined ? {} : { qwenCoordinateMode: options.qwenCoordinateMode }),
    ...(options.qwenThinking === undefined ? {} : { qwenThinking: options.qwenThinking }),
    ...(options.qwenOutputMode === undefined ? {} : { qwenOutputMode: options.qwenOutputMode }),
    ...(qwenEndpoint === undefined ? {} : { qwenEndpoint }),
    ...(process.env.DASHSCOPE_WORKSPACE_ID === undefined ? {} : { qwenWorkspaceId: process.env.DASHSCOPE_WORKSPACE_ID }),
    glmThinking: process.env.GLM_THINKING === "disabled" || process.env.GLM_THINKING === "enabled" ? process.env.GLM_THINKING : "enabled",
    ...(process.env.GLM_BASE_URL === undefined ? {} : { glmEndpoint: process.env.GLM_BASE_URL }),
    ...(options.fixtureResult === undefined ? {} : { fixtureResult: options.fixtureResult }),
  };
}

function readProviderCredentials(): ProviderCredentials {
  const glmApiKey = process.env.ZHIPUAI_API_KEY ?? process.env.ZHIPU_API_KEY ?? process.env.GLM_API_KEY;
  const qwenApiKey = process.env.DASHSCOPE_API_KEY;
  const osworldBridgeToken = process.env.OSWORLD_BRIDGE_TOKEN;
  return {
    ...(glmApiKey === undefined ? {} : { glmApiKey }),
    ...(qwenApiKey === undefined ? {} : { qwenApiKey }),
    ...(osworldBridgeToken === undefined ? {} : { osworldBridgeToken }),
  };
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

async function runWithCliControls(controller: RunController, goal: string, interactive: boolean, markControllerStarted?: () => void): Promise<RunOutcome> {
  let lastQuestion: string | undefined;
  let lastApprovalId: string | undefined;
  const monitor = setInterval(() => {
    const snapshot = controller.getSnapshot();
    if (snapshot.status === "waiting_user" && snapshot.pendingUserQuestion !== lastQuestion) {
      lastQuestion = snapshot.pendingUserQuestion;
      process.stdout.write(`User input required: ${sanitizeTerminalText(snapshot.pendingUserQuestion ?? "Response required")}\n`);
      if (!interactive) {
        try { controller.cancel("non-interactive CLI cannot answer user input"); } catch { /* finished concurrently */ }
      }
    }
    if (snapshot.status === "waiting_approval" && snapshot.pendingApproval !== undefined && snapshot.pendingApproval.requestId !== lastApprovalId) {
      lastApprovalId = snapshot.pendingApproval.requestId;
      process.stdout.write(`Approval required (${sanitizeTerminalText(snapshot.pendingApproval.requestId)}): ${sanitizeTerminalText(snapshot.pendingApproval.reason)}\nApprove? [y/N]\n`);
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
        process.stderr.write(`Could not resolve approval: ${sanitizeTerminalText(error instanceof Error ? error.message : String(error))}\n`);
      });
      return;
    }
    if (snapshot.status !== "waiting_user") {
      process.stdout.write("Input ignored: the run is not waiting for user input.\n");
      return;
    }
    void controller.submitUserInput(line).catch((error: unknown) => {
      process.stderr.write(`Could not submit user input: ${sanitizeTerminalText(error instanceof Error ? error.message : String(error))}\n`);
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
    markControllerStarted?.();
    return await controller.start(goal);
  } finally {
    clearInterval(monitor);
    readline?.close();
    process.removeListener("SIGINT", onSigint);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${sanitizeTerminalText(error instanceof Error ? error.stack ?? error.message : String(error))}\n`);
  process.exitCode = 1;
});
