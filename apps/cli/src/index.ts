import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ApplicationSession, ProcessSharedEnvironmentOwner, createWindowTargetDiscovery, environmentIdentityForConfig, prepareManagedBrowserProfile, recoverStaleManagedBrowserProfile, resolveManagedBrowserProfileConfig, writeRunReport, type AppRuntimeModel, type MemoryRetrievalMode, type ProviderCredentials, type ResolvedRunConfig } from "@computer-harness/app-runtime";
import type { RunOutcome } from "@computer-harness/protocol";
import type { RunController } from "@computer-harness/runtime";
import type { MonitorPolicyMode } from "@computer-harness/runtime";
import { runApplicationTui, type TuiFeatureSelection } from "./tui.js";
import { runCuaDoctor } from "./doctor-command.js";
import { resolveCliModel } from "./cli-model.js";
import { resolveRiskConfig, type ResolvedRiskConfig } from "./config.js";
import { sanitizeTerminalText } from "./terminal-output.js";
import { resolveCuaWindowTargetOptions } from "./window-target-options.js";
import { defaultManagedBrowserProfileRoot } from "./managed-browser-profile.js";
import { validateCliArguments } from "./argument-parser.js";
import { createJevWindowSelector } from "./window-selection-jev.js";

type ModelName = AppRuntimeModel;
type MemoryToolMode = "facts" | "entities";
type QwenCoordinateMode = "normalized_1000" | "actual_pixels";
type Qwen38ThinkingMode = "disabled" | "low" | "medium" | "xhigh";
type Qwen38OutputMode = "native_tools" | "strict_json";

interface CliOptions {
  doctor: boolean;
  prepareManagedBrowserProfile: boolean;
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
  memoryRetrieval: MemoryRetrievalMode;
  memoryEmbeddingEndpoint?: string;
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
  monitor: MonitorPolicyMode;
  grounding: TuiFeatureSelection["grounding"];
  windowSelection: "local" | "jev";
  /** Explicit URL for the host-owned temporary browser; never a profile/debug endpoint. */
  managedBrowserUrl?: string;
  managedBrowserProfileMode: "ephemeral" | "persistent";
  managedBrowserProfileLabel?: string;
  managedBrowserProfileRoot?: string;
}

function parseArgs(rawArgv: readonly string[]): CliOptions {
  // pnpm's `start -- ...` forwards the separator as a literal argv entry;
  // treat it as transport syntax, not as a CLI option.
  const argv = validateCliArguments(rawArgv);
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const doctor = argv.includes("--doctor");
  const prepareManagedBrowserProfileValue = argv.includes("--prepare-managed-browser-profile");
  const goal = value("--goal");
  const tui = argv.includes("--tui");
  const modelValue = value("--model");
  const model = resolveCliModel(modelValue, doctor || prepareManagedBrowserProfileValue) as ModelName;
  const monitorValue = value("--monitor") ?? "off";
  if (monitorValue !== "off" && monitorValue !== "shadow" && monitorValue !== "guidance") throw new Error("--monitor must be off, shadow, or guidance");
  if (doctor && monitorValue !== "off") throw new Error("--doctor does not run Monitor");
  const groundingValue = value("--grounding") ?? "off";
  if (groundingValue !== "off" && groundingValue !== "auto" && groundingValue !== "uia-catalog-v1" && groundingValue !== "dom-catalog-v1" && groundingValue !== "hybrid-catalog-v1") {
    throw new Error("--grounding must be off, auto, uia-catalog-v1, dom-catalog-v1, or hybrid-catalog-v1");
  }
  const computer = (value("--computer") ?? "cua") as "cua" | "osworld";
  const windowSelectionValue = value("--window-selection") ?? "local";
  if (windowSelectionValue !== "local" && windowSelectionValue !== "jev") throw new Error("--window-selection must be local or jev");
  if (windowSelectionValue === "jev" && (!tui || computer !== "cua" || !argv.includes("--allow-window-title-sharing"))) {
    throw new Error("Jev window selection requires --tui --computer cua and explicit --allow-window-title-sharing");
  }
  if (argv.includes("--allow-window-title-sharing") && windowSelectionValue !== "jev") throw new Error("--allow-window-title-sharing requires --window-selection jev");
  if (groundingValue === "auto" && (!tui || computer !== "cua")) throw new Error("--grounding auto is available only with --tui --computer cua");
  if ((goal === undefined || goal.trim().length === 0) && !tui && !doctor && !prepareManagedBrowserProfileValue) throw new Error("--goal is required unless --tui opens the interactive home, --doctor runs a read-only CUA diagnostic, or --prepare-managed-browser-profile is used");
  if (doctor && goal !== undefined) throw new Error("--doctor cannot be combined with --goal");
  if (prepareManagedBrowserProfileValue && (doctor || tui || argv.includes("--interactive"))) throw new Error("--prepare-managed-browser-profile cannot be combined with --doctor, --tui, or --interactive");
  if (prepareManagedBrowserProfileValue && goal !== undefined) throw new Error("--prepare-managed-browser-profile does not accept --goal");
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
  if (groundingValue === "uia-catalog-v1" && (computer !== "cua" || cuaWindowTarget === undefined)) {
    throw new Error("--grounding uia-catalog-v1 requires --computer cua and an explicit --cua-window-pid/--cua-window-id target");
  }
  const managedBrowserUrlValue = value("--managed-browser-url");
  const managedBrowserUrl = managedBrowserUrlValue === undefined ? undefined : validateManagedBrowserUrl(managedBrowserUrlValue);
  const managedGrounding = groundingValue === "dom-catalog-v1" || groundingValue === "hybrid-catalog-v1";
  if (managedGrounding && computer !== "cua") {
    throw new Error(`--grounding ${groundingValue} requires --computer cua and the shared CUA socket`);
  }
  if (managedGrounding && managedBrowserUrl === undefined) {
    throw new Error(`--grounding ${groundingValue} requires --managed-browser-url <http(s)-url>`);
  }
  if (managedGrounding && cuaWindowTarget !== undefined) {
    throw new Error(`--grounding ${groundingValue} owns its temporary managed-browser window; omit --cua-window-pid/--cua-window-id`);
  }
  const managedBrowserProfileModeValue = value("--managed-browser-profile-mode") ?? "ephemeral";
  if (managedBrowserProfileModeValue !== "ephemeral" && managedBrowserProfileModeValue !== "persistent") {
    throw new Error("--managed-browser-profile-mode must be ephemeral or persistent");
  }
  const managedBrowserProfileLabel = value("--managed-browser-profile-label");
  if (managedBrowserProfileModeValue === "persistent" && (managedBrowserProfileLabel === undefined || !/^[A-Za-z0-9._-]{1,64}$/u.test(managedBrowserProfileLabel))) {
    throw new Error("persistent managed browser mode requires --managed-browser-profile-label <label> (letters, digits, . _ -)");
  }
  if (managedBrowserProfileModeValue === "ephemeral" && managedBrowserProfileLabel !== undefined) {
    throw new Error("--managed-browser-profile-label requires --managed-browser-profile-mode persistent");
  }
  if (prepareManagedBrowserProfileValue) {
    if (computer !== "cua") throw new Error("--prepare-managed-browser-profile requires --computer cua");
    if (managedBrowserUrl === undefined) throw new Error("--prepare-managed-browser-profile requires --managed-browser-url <http(s)-url>");
    if (managedBrowserProfileModeValue !== "persistent" || managedBrowserProfileLabel === undefined) {
      throw new Error("--prepare-managed-browser-profile requires persistent mode and --managed-browser-profile-label <label>");
    }
  }
  if (doctor && groundingValue !== "off") throw new Error("--doctor does not run grounding");
  const output = resolve(value("--output") ?? "runs/live-cli");
  const maxSteps = positiveInteger(value("--max-steps"), 100, "--max-steps");
  const maxModelRequests = positiveInteger(value("--max-model-requests"), 100, "--max-model-requests");
  const fixtureResult = value("--fixture-result");
  const envFile = value("--env-file");
  if (doctor && envFile !== undefined) throw new Error("--doctor does not read --env-file or provider credentials");
  if (prepareManagedBrowserProfileValue && envFile !== undefined) throw new Error("--prepare-managed-browser-profile does not read --env-file or provider credentials");
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
  const memoryRetrievalValue = value("--memory-retrieval") ?? (memoryValue === "off" ? "off" : "lexical");
  if (memoryRetrievalValue !== "off" && memoryRetrievalValue !== "lexical" && memoryRetrievalValue !== "hybrid") throw new Error("--memory-retrieval must be off, lexical, or hybrid");
  if (memoryValue === "off" && memoryRetrievalValue !== "off") throw new Error("--memory-retrieval requires --memory facts or entities");
  const memoryEmbeddingEndpoint = value("--memory-embedding-endpoint");
  if (memoryRetrievalValue === "hybrid" && (memoryEmbeddingEndpoint === undefined || memoryEmbeddingEndpoint.trim().length === 0)) throw new Error("--memory-embedding-endpoint is required for hybrid Memory retrieval");
  const batchingValue = value("--batching") ?? "off";
  if (batchingValue !== "off" && batchingValue !== "same-control-input-v1") throw new Error("--batching must be off or same-control-input-v1");
  const contextModeValue = value("--context-mode") ?? "raw";
  if (contextModeValue !== "raw" && contextModeValue !== "recent") throw new Error("--context-mode must be raw or recent");
  const contextMaxHistoryEvents = positiveInteger(value("--context-max-events"), 80, "--context-max-events");
  const contextMaxInputTokensValue = value("--context-max-tokens");
  const contextMaxInputTokens = contextMaxInputTokensValue === undefined ? undefined : positiveInteger(contextMaxInputTokensValue, 1, "--context-max-tokens");
  return {
    doctor,
    prepareManagedBrowserProfile: prepareManagedBrowserProfileValue,
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
    memoryRetrieval: memoryRetrievalValue as MemoryRetrievalMode,
    ...(memoryEmbeddingEndpoint === undefined ? {} : { memoryEmbeddingEndpoint }),
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
    monitor: monitorValue,
    grounding: groundingValue as CliOptions["grounding"],
    windowSelection: windowSelectionValue,
    ...(managedBrowserUrl === undefined ? {} : { managedBrowserUrl }),
    managedBrowserProfileMode: managedBrowserProfileModeValue,
    ...(managedBrowserProfileLabel === undefined ? {} : { managedBrowserProfileLabel }),
    ...(managedBrowserProfileModeValue === "persistent" ? { managedBrowserProfileRoot: defaultManagedBrowserProfileRoot() } : {}),
  };
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

async function main(): Promise<void> {
  if (process.argv.includes("--recover-managed-browser-profile")) {
    if (process.argv.length !== 3) throw new Error("--recover-managed-browser-profile is a standalone local recovery command.");
    const profile = resolveManagedBrowserProfileConfig();
    const result = await recoverStaleManagedBrowserProfile(profile.profileRoot, profile.profileLabel);
    process.stdout.write(`Archived stale managed-browser runtime markers: ${result.archivedMarkers.join(", ")}. Login data was not modified. Archive id: ${result.archiveId}.\n`);
    return;
  }
  if (process.argv.includes("--recover-environment")) {
    await runEnvironmentLeaseRecovery(process.argv.slice(2));
    return;
  }
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    validateCliArguments(process.argv.slice(2));
    process.stdout.write("TUI-only: --grounding auto selects UIA for native windows, DOM + UIA for a selected Harness-managed browser, and off for desktop.\n");
    process.stdout.write("TUI-only: --window-selection jev requires --allow-window-title-sharing and TYPESAFE_API_KEY; default is local.\n");
    process.stdout.write("Usage: computer-harness --doctor --computer cua --cua-socket <socket> [--doctor-timeout-ms <n>]\n   or: computer-harness --prepare-managed-browser-profile --computer cua --cua-socket <socket> --managed-browser-url <http(s)-url> --managed-browser-profile-mode persistent --managed-browser-profile-label <label>\n   or: computer-harness [--goal <text>] --model <glm-5.3-flash|qwen3.8-flash> --computer <cua|osworld> [--cua-socket <socket>|--osworld-bridge <url>] [--cua-window-pid <n> --cua-window-id <n>] [--grounding <off|uia-catalog-v1|dom-catalog-v1|hybrid-catalog-v1>] [--managed-browser-url <http(s)-url>] [--managed-browser-profile-mode <ephemeral|persistent>] [--managed-browser-profile-label <label>] [--monitor <off|shadow|guidance>] [--output <dir>] [--env-file <path>] [--fixture-result <json>] [--planning] [--memory <off|facts|entities>] [--memory-retrieval <off|lexical|hybrid>] [--memory-embedding-endpoint <https-endpoint>] [--batching <off|same-control-input-v1>] [--context-mode <raw|recent>] [--context-max-events <n>] [--context-max-tokens <n>] [--profile <experiment|live-interactive>] [--risk-guard <off|layered>] [--confirm-risk-guard-off] [--risk-model <off|same|glm-5.3-flash|qwen3.8-flash>] [--risk-max-model-requests <n>] [--risk-timeout-ms <n>] [--cleanup-deadline-ms <n>] [--qwen-coordinate-mode <normalized_1000|actual_pixels>] [--qwen-thinking <disabled|low|medium|xhigh>] [--qwen-output-mode <native_tools|strict_json>] [--interactive|--tui]\n");
    process.stdout.write("Recovery only: --recover-environment --recovery-identity <cua-local-physical-desktop:platform> --recovery-run-id <exact-run-id> --recovery-lease-hash <64-hex> --recovery-state <active|pending_cleanup> --recovery-operator <name> --recovery-inspection-note <evidence> --external-state-inspected\n");
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  if (options.doctor) {
    const report = await runCuaDoctor({ socketPath: options.cuaSocket!, timeoutMs: options.doctorTimeoutMs });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.status !== "supported") process.exitCode = 1;
    return;
  }
  if (options.prepareManagedBrowserProfile) {
    const abort = new AbortController();
    const onSigint = () => abort.abort(new Error("managed browser preparation interrupted"));
    process.once("SIGINT", onSigint);
    try {
      const result = await prepareManagedBrowserProfile({
        socketPath: options.cuaSocket!,
        managedBrowserUrl: options.managedBrowserUrl!,
        profileLabel: options.managedBrowserProfileLabel!,
        persistentProfileRoot: options.managedBrowserProfileRoot!,
        signal: abort.signal,
      }, {
        onReady: (ready) => process.stdout.write(`Managed browser ready: profile-label=${ready.profileLabel} url-host=${ready.urlHost}. Complete manual login in the visible managed window; press Enter to close it and retain the profile.\n`),
      });
      const outcome = result.outcome === "enter" ? "finished" : "interrupted";
      const retention = result.profileRetention === "confirmed"
        ? "persistent profile retained"
        : "persistent profile retention is unconfirmed; do not rely on this login until a new preparation succeeds";
      process.stdout.write(`Managed browser preparation ${outcome}; ${retention}.\n`);
      if (result.cleanupDiagnostics.length > 0) {
        process.stderr.write(`Managed browser cleanup diagnostics: ${result.cleanupDiagnostics.join(", ")}.\n`);
      }
    } finally {
      process.removeListener("SIGINT", onSigint);
    }
    return;
  }
  if (options.envFile !== undefined) await loadEnvFile(options.envFile);
  if (options.tui) {
    const windowSelector = options.windowSelection === "jev"
      ? createJevWindowSelector(process.env.TYPESAFE_API_KEY ?? "")
      : undefined;
    const config = toResolvedRunConfig(options, options.goal ?? "");
    const { goal: _goal, runId: _runId, ...sessionConfig } = config;
    const windowDiscovery = createWindowTargetDiscovery(sessionConfig.computer);
    const session = new ApplicationSession({
      config: sessionConfig,
      dependencies: { credentials: readProviderCredentials() },
      ...(windowDiscovery === undefined ? {} : { windowDiscovery }),
    });
    await runApplicationTui(session, {
      provider: options.model,
      computer: options.computer,
      output: options.output,
      ...(options.cuaWindowTarget === undefined ? {} : { cuaWindowTarget: options.cuaWindowTarget }),
      ...(sessionConfig.computer.kind === "cua" && sessionConfig.computer.windowTarget !== undefined && sessionConfig.computer.windowDeliveryMode !== undefined
        ? { cuaWindowDeliveryMode: sessionConfig.computer.windowDeliveryMode }
        : {}),
      windowSelectionAvailable: windowDiscovery !== undefined,
      profile: options.risk.profile,
      riskGuard: options.risk.riskGuard,
      ...(options.managedBrowserUrl === undefined ? {} : { managedBrowserUrl: options.managedBrowserUrl }),
      managedBrowserProfileMode: options.managedBrowserProfileMode,
      ...(options.managedBrowserProfileLabel === undefined ? {} : { managedBrowserProfileLabel: options.managedBrowserProfileLabel }),
      features: {
        planning: options.planning,
        memory: options.memory,
        memoryRetrieval: options.memoryRetrieval,
        batching: options.batching,
        contextMode: options.contextMode,
        riskGuard: options.risk.riskGuard,
        monitor: options.monitor,
        grounding: options.grounding,
      } satisfies TuiFeatureSelection,
      embeddingReady: options.memoryEmbeddingEndpoint !== undefined && (process.env.MEMORY_EMBEDDING_API_KEY?.trim().length ?? 0) > 0,
    }, {
      ...(options.goal === undefined ? {} : { initialGoal: options.goal }),
      ...(windowSelector === undefined ? {} : { windowSelector }),
    });
    return;
  }
  const config = toResolvedRunConfig(options, options.goal!);
  const { goal, runId: _runId, ...sessionConfig } = config;
  const session = new ApplicationSession({
    config: sessionConfig,
    dependencies: { credentials: readProviderCredentials() },
  });
  try {
    const handle = await session.startRun(
      goal,
      {},
      (controller, activeGoal, markControllerStarted) => runWithCliControls(controller, activeGoal, options.interactive, markControllerStarted),
    );
    await session.waitForActiveRun();
    const report = await handle.report();
    await writeRunReport(report, config.outputDir);
    process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
  } finally {
    await session.close().catch(() => undefined);
  }
}

async function runEnvironmentLeaseRecovery(rawArgs: readonly string[]): Promise<void> {
  const valueOptions = new Set([
    "--recovery-identity",
    "--recovery-run-id",
    "--recovery-lease-hash",
    "--recovery-state",
    "--recovery-operator",
    "--recovery-inspection-note",
  ]);
  const values = new Map<string, string>();
  let hasCommand = false;
  let hasExternalStateAttestation = false;
  for (let index = 0; index < rawArgs.length; index += 1) {
    const argument = rawArgs[index];
    if (argument === "--recover-environment") {
      if (hasCommand) throw new Error("--recover-environment must be provided once");
      hasCommand = true;
      continue;
    }
    if (argument === "--external-state-inspected") {
      if (hasExternalStateAttestation) throw new Error("--external-state-inspected must be provided once");
      hasExternalStateAttestation = true;
      continue;
    }
    if (argument === undefined || !valueOptions.has(argument)) throw new Error(`unsupported recovery argument: ${argument ?? "<missing>"}`);
    if (values.has(argument)) throw new Error(`${argument} must be provided once`);
    const value = rawArgs[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith("--")) throw new Error(`${argument} requires a non-empty value`);
    values.set(argument, value);
    index += 1;
  }
  if (!hasCommand) throw new Error("--recover-environment is required");
  if (!hasExternalStateAttestation) throw new Error("--external-state-inspected is required after inspecting current desktop and prior Run evidence");
  for (const name of valueOptions) if (!values.has(name)) throw new Error(`${name} is required for recovery`);

  const identity = values.get("--recovery-identity")!;
  const expectedIdentity = environmentIdentityForConfig({ kind: "cua", socketPath: "recovery-check", screenshotDir: "recovery-check" });
  if (identity !== expectedIdentity) throw new Error(`recovery identity must match this OS physical desktop (${expectedIdentity})`);
  const expectedRunId = values.get("--recovery-run-id")!;
  if (!/^[a-zA-Z0-9._-]{1,160}$/u.test(expectedRunId)) throw new Error("--recovery-run-id must contain only letters, digits, dot, underscore, or hyphen");
  if (!/^[a-f0-9]{64}$/u.test(values.get("--recovery-lease-hash")!)) throw new Error("--recovery-lease-hash must be 64 lowercase hexadecimal characters");
  const expectedState = values.get("--recovery-state");
  if (expectedState !== "active" && expectedState !== "pending_cleanup") throw new Error("--recovery-state must be active or pending_cleanup");
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("lease recovery requires an interactive terminal for the final confirmation");

  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  let answer: string;
  try {
    answer = await new Promise<string>((resolveAnswer) => {
      terminal.question(`After confirming the prior Run is disconnected and external state is reconciled, type RECOVER ${expectedRunId}: `, resolveAnswer);
    });
  } finally {
    terminal.close();
  }
  if (answer.trim() !== `RECOVER ${expectedRunId}`) throw new Error("recovery confirmation did not match the expected Run ID");

  const result = new ProcessSharedEnvironmentOwner().recoverLease({
    identity,
    expectedRunId,
    expectedLeaseHash: values.get("--recovery-lease-hash")!,
    expectedState,
    operator: values.get("--recovery-operator")!,
    inspectionNote: values.get("--recovery-inspection-note")!,
    externalStateInspected: true,
  });
  process.stdout.write(`Lease quarantine created for Run ${result.runId}; prior lease preserved at ${result.quarantinePath}. Audit record: ${result.auditPath}. The prior Run outcome is unchanged and is not reported as successful.\n`);
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
          grounding: options.grounding === "auto" ? "off" : options.grounding,
          ...(options.managedBrowserUrl === undefined ? {} : { managedBrowserUrl: options.managedBrowserUrl }),
          managedBrowserProfileMode: options.managedBrowserProfileMode,
          ...(options.managedBrowserProfileLabel === undefined ? {} : { managedBrowserProfileLabel: options.managedBrowserProfileLabel }),
          ...(options.managedBrowserProfileRoot === undefined ? {} : { managedBrowserProfileRoot: options.managedBrowserProfileRoot }),
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
    memoryRetrieval: options.memoryRetrieval,
    ...(options.memoryEmbeddingEndpoint === undefined ? {} : { memoryEmbeddingEndpoint: options.memoryEmbeddingEndpoint }),
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
    monitor: options.monitor,
    grounding: options.grounding === "auto" ? "off" : options.grounding,
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

function validateManagedBrowserUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error("--managed-browser-url must be an explicit http(s) URL");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("--managed-browser-url must be an explicit http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:" || parsed.hostname.length === 0) {
    throw new Error("--managed-browser-url must be an explicit http(s) URL");
  }
  return trimmed;
}

function readProviderCredentials(): ProviderCredentials {
  const glmApiKey = process.env.ZHIPUAI_API_KEY ?? process.env.ZHIPU_API_KEY ?? process.env.GLM_API_KEY;
  const qwenApiKey = process.env.DASHSCOPE_API_KEY;
  const memoryEmbeddingApiKey = process.env.MEMORY_EMBEDDING_API_KEY;
  const osworldBridgeToken = process.env.OSWORLD_BRIDGE_TOKEN;
  return {
    ...(glmApiKey === undefined ? {} : { glmApiKey }),
    ...(qwenApiKey === undefined ? {} : { qwenApiKey }),
    ...(memoryEmbeddingApiKey === undefined ? {} : { memoryEmbeddingApiKey }),
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
