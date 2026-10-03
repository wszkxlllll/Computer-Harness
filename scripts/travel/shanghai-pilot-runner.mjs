#!/usr/bin/env node

import { copyFile, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { ApplicationSession, defaultManagedBrowserProfileRoot, writeRunReport } from "../../packages/app-runtime/dist/index.js";
import { collectRun } from "./tui-collector.mjs";
import { TRAVEL_RUN_ROOT } from "./metrics.mjs";
import { createShanghaiPilotRuntimePolicy, SHANGHAI_PILOT_POLICY_ID } from "./shanghai-pilot-policy.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST_PATH = resolve(REPO_ROOT, "eval/shanghai-pilot/manifest.json");
const TASK_DOC_PATH = resolve(REPO_ROOT, "docs/shanghai-government-travel-pilot-2026-10-01.md");
const CONFIG_PATH = resolve(REPO_ROOT, ".harness.local.psd1");
const APP_RUNTIME_DIST_PATH = resolve(REPO_ROOT, "packages/app-runtime/dist/index.js");
const RUNTIME_DIST_PATH = resolve(REPO_ROOT, "packages/runtime/dist/index.js");
const PILOT_ROOT = resolve(TRAVEL_RUN_ROOT, "shanghai-pilot-20261001");
const MINIMUM_NODE_VERSION = "22.13.0";

function dateInTimeZone(instant, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function safetySuffix(dateBasis) {
  return `安全边界（必须遵守）：仅查询公开信息并在最终回复中整理结果；不自动登录、不处理验证码、不输入个人信息、证件或账号资料；不预订、不候补、不下单、不付款、不发送消息、不提交政务/预约/申请资料、不修改账号。若页面要求这些操作才能继续，请报告阻塞并停止；任何可能产生未知副作用的动作先观察状态，结果未知时不得重放。若网站或入口访问失败，不反复尝试同一地址；记录环境阻塞并停止该入口，可换同事项其他官方来源继续；不可达不等于无结果。任务信息日期基准为${dateBasis.asOfDate}（${dateBasis.timeZone}）；题卡中明确写出的行程日期保持原样。精确观察时刻由Harness轨迹中的observation.capturedAt记录，不打开系统时钟或授时网页，不为查时间操作桌面；无法从轨迹确定的时刻记unknown。`;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} is required`);
  return value.trim();
}

function parseLocalSetting(text, name) {
  const match = new RegExp(`^\\s*${name}\\s*=\\s*'([^']*)'\\s*$`, "mu").exec(text);
  return match?.[1] ?? "";
}

function nodeVersionAtLeast(actual, minimum) {
  const actualParts = /^(\d+)\.(\d+)\.(\d+)$/u.exec(actual)?.slice(1, 4).map(Number);
  const minimumParts = minimum.split(".").map(Number);
  if (actualParts === undefined || actualParts.length !== minimumParts.length) return false;
  for (let index = 0; index < minimumParts.length; index += 1) {
    if (actualParts[index] > minimumParts[index]) return true;
    if (actualParts[index] < minimumParts[index]) return false;
  }
  return true;
}

function normalizedExecutablePath(path) {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

async function verifyNodeRuntime(localConfigText) {
  const configuredNodePath = requiredString(parseLocalSetting(localConfigText, "NodePath"), "local NodePath");
  const configuredExecutable = resolve(REPO_ROOT, configuredNodePath);
  const actualExecutable = process.execPath;
  const actualNodeVersion = process.versions.node;
  let configuredRealPath;
  let actualRealPath;
  try {
    [configuredRealPath, actualRealPath] = await Promise.all([
      realpath(configuredExecutable),
      realpath(actualExecutable),
    ]);
  } catch (error) {
    throw new Error(`Node preflight failed: configuredExecutable=${configuredExecutable}; actualNodeVersion=${actualNodeVersion}; actualExecutable=${actualExecutable}; detail=${error?.message ?? String(error)}`);
  }
  const runtime = {
    minimumSupportedVersion: MINIMUM_NODE_VERSION,
    configuredNodePath,
    configuredExecutable,
    configuredRealPath,
    actualNodeVersion,
    actualExecutable,
    actualRealPath,
    executableMatchesConfiguredPath: normalizedExecutablePath(configuredRealPath) === normalizedExecutablePath(actualRealPath),
    versionSupported: nodeVersionAtLeast(actualNodeVersion, MINIMUM_NODE_VERSION),
  };
  if (!runtime.executableMatchesConfiguredPath || !runtime.versionSupported) {
    throw new Error(`Node preflight failed: executableMatchesConfiguredPath=${runtime.executableMatchesConfiguredPath}; versionSupported=${runtime.versionSupported}; minimum=${MINIMUM_NODE_VERSION}; actualNodeVersion=${actualNodeVersion}; actualExecutable=${actualExecutable}; configuredExecutable=${configuredExecutable}`);
  }
  return runtime;
}

function parseOverrides(args) {
  const result = {};
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (seen.has(key)) throw new Error(`${key} may be provided only once`);
    seen.add(key);
    if (key === "--run-suffix") {
      const suffix = args[++index];
      if (typeof suffix !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/u.test(suffix)) {
        throw new Error("--run-suffix must contain 1-32 letters, digits, dot, underscore, or hyphen, and start with a letter or digit");
      }
      result.runSuffix = suffix;
      continue;
    }
    if (key !== "--max-steps" && key !== "--max-model-requests") throw new Error(`Unknown argument: ${key}`);
    const value = Number(args[++index]);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${key} must be a positive integer`);
    result[key === "--max-steps" ? "maxSteps" : "maxModelRequests"] = value;
  }
  return result;
}

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function loadEnvFile(path) {
  const text = await readFile(path, "utf8");
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/gu, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function readProviderCredentials() {
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

async function runWithInjectedRuntime({ goal, model, socket, envFile, profileMode, profileLabel, startupUrl, outputRoot, budget, onRunStarted }) {
  await loadEnvFile(envFile);
  const qwenEndpoint = process.env.DASHSCOPE_BASE_URL ?? process.env.DASHSCOPE_ENDPOINT;
  const glmThinking = new Set(["disabled", "enabled", "low", "high", "max"]).has(process.env.GLM_THINKING)
    ? process.env.GLM_THINKING
    : "enabled";
  const config = {
    model,
    computer: {
      kind: "cua",
      socketPath: socket,
      screenshotDir: resolve(outputRoot, "driver-screenshots"),
      grounding: "hybrid-catalog-v1",
      managedBrowserUrl: startupUrl,
      managedBrowserProfileMode: profileMode,
      managedBrowserProfileLabel: profileLabel,
      managedBrowserProfileRoot: defaultManagedBrowserProfileRoot(),
    },
    outputDir: outputRoot,
    maxSteps: budget.maxSteps,
    maxModelRequests: budget.maxModelRequests,
    planning: true,
    memory: "entities",
    memoryRetrieval: "lexical",
    batching: "same-control-input-v1",
    contextMode: "recent",
    contextMaxHistoryEvents: 80,
    riskProfile: "live-interactive",
    riskGuard: "off",
    riskModel: "off",
    riskMaxModelRequests: 20,
    riskTimeoutMs: 30_000,
    cleanupDeadlineMs: 5_000,
    monitor: "shadow",
    grounding: "hybrid-catalog-v1",
    glmThinking,
    ...(process.env.GLM_BASE_URL === undefined ? {} : { glmEndpoint: process.env.GLM_BASE_URL }),
    ...(qwenEndpoint === undefined ? {} : { qwenEndpoint }),
    ...(process.env.DASHSCOPE_WORKSPACE_ID === undefined ? {} : { qwenWorkspaceId: process.env.DASHSCOPE_WORKSPACE_ID }),
  };
  const session = new ApplicationSession({
    config,
    dependencies: {
      credentials: readProviderCredentials(),
      createPolicy: createShanghaiPilotRuntimePolicy,
    },
  });
  try {
    const handle = await session.startRun(goal, {}, (controller, activeGoal, markControllerStarted) =>
      runNonInteractiveController(controller, activeGoal, markControllerStarted));
    onRunStarted?.();
    await session.waitForActiveRun();
    const report = await handle.report();
    await writeRunReport(report, outputRoot);
    process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
  } finally {
    await session.close().catch(() => undefined);
  }
}

async function runNonInteractiveController(controller, goal, markControllerStarted) {
  let lastQuestion;
  let lastApprovalId;
  const monitor = setInterval(() => {
    const snapshot = controller.getSnapshot();
    if (snapshot.status === "waiting_user" && snapshot.pendingUserQuestion !== lastQuestion) {
      lastQuestion = snapshot.pendingUserQuestion;
      process.stdout.write("Run requested user input; cancelling in non-interactive pilot mode.\n");
      try { controller.cancel("non-interactive pilot cannot provide user input"); } catch { /* finished concurrently */ }
    }
    if (snapshot.status === "waiting_approval" && snapshot.pendingApproval !== undefined && snapshot.pendingApproval.requestId !== lastApprovalId) {
      lastApprovalId = snapshot.pendingApproval.requestId;
      process.stdout.write("Run requested approval; denying in non-interactive pilot mode.\n");
      void controller.resolveApproval(snapshot.pendingApproval.requestId, false).catch(() => undefined);
    }
  }, 100);
  const onSigint = () => {
    try { controller.cancel("SIGINT"); } catch { /* finished concurrently */ }
  };
  process.once("SIGINT", onSigint);
  try {
    markControllerStarted?.();
    return await controller.start(goal);
  } finally {
    clearInterval(monitor);
    process.removeListener("SIGINT", onSigint);
  }
}

async function main() {
  const [taskId, attemptValue, ...rest] = process.argv.slice(2);
  const attempt = Number(attemptValue);
  if (!/^(SG|ST)0[1-5]$/u.test(taskId ?? "")) throw new Error("Usage: shanghai-pilot-runner.mjs <SG01..SG05|ST01..ST05> <attempt 1|2> [--max-steps n] [--max-model-requests n] [--run-suffix label]");
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 2) throw new Error("attempt must be 1 or 2");

  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  const dateBasisTimeZone = requiredString(manifest.timezone, "manifest.timezone");
  const dateBasisInstant = new Date();
  const queryDateBasis = {
    asOfDate: dateInTimeZone(dateBasisInstant, dateBasisTimeZone),
    timeZone: dateBasisTimeZone,
    determinedAt: dateBasisInstant.toISOString(),
    source: "launcher host clock at task launch",
    manifestLocalDate: manifest.localDate ?? null,
  };
  const task = manifest.tasks?.[taskId];
  if (!task) throw new Error(`Task ${taskId} is not in the pilot manifest`);
  const taskDocument = await readFile(TASK_DOC_PATH, "utf8");
  const row = taskDocument.split(/\r?\n/u).find((line) => line.startsWith(`| ${taskId} / `));
  if (!row) throw new Error(`Task row ${taskId} is not in the UTF-8 task document`);
  const cells = row.split("|").slice(1, -1).map((cell) => cell.trim());
  const difficultyMatch = /^(SG|ST)0[1-5] \/ (easy|medium|hard)$/u.exec(cells[0] ?? "");
  if (!difficultyMatch || !cells[1]) throw new Error(`Task row ${taskId} has an invalid difficulty or goal cell`);
  const difficulty = difficultyMatch[2];
  const goal = `${cells[1]}\n\n${safetySuffix(queryDateBasis)}`;
  const overrides = parseOverrides(rest);
  const { runSuffix, ...budgetOverrides } = overrides;
  const budget = { ...manifest.budgetByDifficulty[difficulty], ...budgetOverrides };
  const localConfigText = await readFile(CONFIG_PATH, "utf8");
  const model = requiredString(parseLocalSetting(localConfigText, "Model"), "local Model");
  const socket = requiredString(parseLocalSetting(localConfigText, "CuaSocket"), "local CuaSocket");
  const envValue = requiredString(parseLocalSetting(localConfigText, "EnvFile"), "local EnvFile");
  const profileMode = requiredString(parseLocalSetting(localConfigText, "ManagedBrowserProfileMode"), "local ManagedBrowserProfileMode");
  const profileLabel = requiredString(parseLocalSetting(localConfigText, "ManagedBrowserProfileLabel"), "local ManagedBrowserProfileLabel");
  if (profileMode !== "persistent") throw new Error("The pilot requires the preconfigured persistent managed browser profile");
  const nodeRuntime = await verifyNodeRuntime(localConfigText);
  const sdkArtifacts = {};
  for (const artifactPath of [APP_RUNTIME_DIST_PATH, RUNTIME_DIST_PATH]) {
    const bytes = await readFile(artifactPath);
    if (bytes.length === 0) throw new Error(`Built SDK artifact is empty: ${relative(REPO_ROOT, artifactPath)}`);
    sdkArtifacts[relative(REPO_ROOT, artifactPath).split(sep).join("/")] = sha256(bytes);
  }

  const runRoot = resolve(PILOT_ROOT, `${taskId}-attempt${attempt}${runSuffix === undefined ? "" : `-${runSuffix}`}`);
  const runRootRel = relative(REPO_ROOT, runRoot).split(sep).join("/");
  if (!runRootRel.startsWith("runs/travel/")) throw new Error("Output directory escaped runs/travel");
  const existing = await readdir(runRoot).catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error));
  if (existing.length > 0) throw new Error(`Refusing to reuse non-empty output directory: ${runRootRel}`);
  await mkdir(runRoot, { recursive: true });
  const goalFile = resolve(runRoot, "goal.txt");
  await writeFile(goalFile, `${goal}\n`, "utf8");
  const goalReadBack = await readFile(goalFile, "utf8");
  if (goalReadBack.trimEnd() !== goal || goalReadBack.includes("\uFFFD") || /\?{3,}/u.test(goalReadBack)) {
    throw new Error("UTF-8 goal read-back failed or shows a replacement symptom");
  }

  const startedAt = new Date().toISOString();
  const requestedConfig = {
    entryMode: "non_interactive_app_runtime_sdk",
    model,
    computer: "cua",
    cuaSocket: socket,
    profile: "live-interactive",
    riskGuard: "off",
    planning: true,
    memory: "entities",
    memoryRetrieval: "lexical",
    batching: "same-control-input-v1",
    contextMode: "recent",
    contextMaxHistoryEvents: 80,
    monitor: "shadow",
    grounding: "hybrid-catalog-v1",
    queryDateBasis,
    managedBrowserProfileMode: profileMode,
    managedBrowserProfileLabel: profileLabel,
    maxSteps: budget.maxSteps,
    maxModelRequests: budget.maxModelRequests,
    runtimePolicy: SHANGHAI_PILOT_POLICY_ID,
    goalIncludesTrajectoryTimeInstruction: true,
  };
  const launchRecord = {
    schemaVersion: 1,
    kind: "shanghai_pilot_launch",
    pilotId: manifest.pilotId,
    taskId,
    domain: task.domain,
    difficulty,
    attempt,
    runSuffix: runSuffix ?? null,
    queryDateBasis,
    entryMode: "non_interactive_app_runtime_sdk",
    goalSource: "docs/shanghai-government-travel-pilot-2026-10-01.md",
    startupUrl: task.startupUrl,
    goalSha256: sha256(Buffer.from(goal, "utf8")),
    nodeRuntime,
    universalSafetySuffixApplied: true,
    runtimePolicy: SHANGHAI_PILOT_POLICY_ID,
    sdkArtifacts,
    startedAt,
    requestedConfig,
    buildArtifact: "packages/app-runtime/dist/index.js and packages/runtime/dist/index.js (built once before pilot; runner does not rebuild)",
  };
  await writeFile(resolve(runRoot, "launch.json"), `${JSON.stringify(launchRecord, null, 2)}\n`, "utf8");
  process.stdout.write(`Starting ${taskId} attempt ${attempt}; domain=${task.domain}; difficulty=${difficulty}; maxSteps=${budget.maxSteps}; maxModelRequests=${budget.maxModelRequests}; policy=${SHANGHAI_PILOT_POLICY_ID}; node=${nodeRuntime.actualNodeVersion}; executable=${nodeRuntime.actualExecutable}; output=${runRootRel}\n`);
  let runtimeStarted = false;
  let runtimeError;
  try {
    await runWithInjectedRuntime({
      goal,
      model,
      socket,
      envFile: resolve(REPO_ROOT, envValue),
      profileMode,
      profileLabel,
      startupUrl: task.startupUrl,
      outputRoot: runRoot,
      budget,
      onRunStarted: () => { runtimeStarted = true; },
    });
  } catch (error) {
    runtimeError = error;
    process.stderr.write(`AppRuntime SDK run failed: ${error?.message ?? String(error)}\n`);
  }
  const finishedAt = new Date().toISOString();

  const summaryPath = resolve(runRoot, "summary.json");
  let summary = null;
  try { summary = JSON.parse(await readFile(summaryPath, "utf8")); } catch { /* A missing summary is preserved as an explicit launch/runtime failure. */ }
  const entries = await readdir(runRoot, { withFileTypes: true });
  const runtimeRuns = entries.filter((entry) => entry.isDirectory() && /^run-[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(entry.name));
  if (summary !== null && runtimeRuns.length === 1) {
    const runtimeRunPath = resolve(runRoot, runtimeRuns[0].name);
    const nestedSummaryPath = resolve(runtimeRunPath, "summary.json");
    try {
      await readFile(nestedSummaryPath);
      throw new Error("Refusing to overwrite a Runtime summary inside the Run directory");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const rootSummary = await readFile(summaryPath);
    await copyFile(summaryPath, nestedSummaryPath);
    const nestedSummary = await readFile(nestedSummaryPath);
    if (sha256(rootSummary) !== sha256(nestedSummary)) throw new Error("Staged summary hash does not match the Runtime output");
    const runRel = relative(REPO_ROOT, runtimeRunPath).split(sep).join("/");
    const collected = await collectRun(runRel, { root: TRAVEL_RUN_ROOT, sessionId: null, force: true });

    const metadataPath = resolve(runtimeRunPath, "run-metadata.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    const runtimeTaskId = metadata.taskId;
    Object.assign(metadata, {
      kind: "shanghai_pilot_run_metadata",
      entryMode: "non_interactive_app_runtime_sdk",
      sessionId: null,
      pilotId: manifest.pilotId,
      taskId,
      runtimeTaskId,
      domain: task.domain,
      difficulty,
      attempt,
      runSuffix: runSuffix ?? null,
      queryDateBasis,
      goalSourceDocument: `docs/shanghai-government-travel-pilot-2026-10-01.md#${taskId}`,
      startupUrl: task.startupUrl,
      requestedConfig,
      runtimePolicy: SHANGHAI_PILOT_POLICY_ID,
      nodeRuntime,
      sdkArtifacts,
      collectorNote: "The AppRuntime SDK wrote summary.json at the task-attempt root and trajectory.jsonl in the Run directory. An identical SHA-256 summary copy was staged beside the trajectory for collectRun; the task-root summary remains unchanged.",
    });
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

    const metricsPath = resolve(runtimeRunPath, "metrics.json");
    const metrics = JSON.parse(await readFile(metricsPath, "utf8"));
    Object.assign(metrics.trial, { runtimeTaskId: metrics.trial.taskId, taskId, pilotId: manifest.pilotId, domain: task.domain, difficulty, attempt });
    await writeFile(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`, "utf8");

    const reportPath = resolve(runtimeRunPath, "report.md");
    let report = await readFile(reportPath, "utf8");
    report = report.replace(/^# Travel TUI Run report$/mu, "# Shanghai pilot Run report");
    report = report.replace(/^- entry mode: .*$/mu, "- entry mode: AppRuntime SDK (non-interactive)");
    report = report.replace(/^- session: .*$/mu, `- pilot: ${manifest.pilotId}`);
    report = report.replace(/^- taskId: .*$/mu, `- taskId: ${taskId} (Runtime taskId: ${runtimeTaskId})`);
    if (!report.includes("- entry mode:")) {
      report = report.replace(/^# Shanghai pilot Run report\n/u, `# Shanghai pilot Run report\n\n- entry mode: AppRuntime SDK (non-interactive)\n- domain / difficulty / attempt: ${task.domain} / ${difficulty} / ${attempt}\n- startup URL: ${task.startupUrl}\n`);
    }
    await writeFile(reportPath, report, "utf8");

    const manualPath = resolve(runtimeRunPath, "manual-review.md");
    const manual = [
      `# ${taskId} (${task.domain} ${difficulty}) manual review: attempt ${attempt}`,
      "",
      `- pilot: ${manifest.pilotId}`,
      `- Runtime Run: ${metadata.runId}`,
      "- entry: project AppRuntime SDK with the configured real Provider, Runtime and CUA",
      `- startup URL: ${task.startupUrl}`,
      `- actual outcome: ${summary.runtimeOutcome ?? "unknown"}; business result: pending manual review`,
      `- actual config: model=${metadata.config?.model ?? model}; monitor=${metadata.config?.monitor ?? "unknown"}; Guard=${metadata.config?.riskGuard ?? "unknown"}; steps=${metadata.config?.maxSteps ?? budget.maxSteps}; requests=${metadata.config?.maxModelRequests ?? budget.maxModelRequests}`,
      "",
      "## Manual review",
      "",
      "- observed page title / source URL / page date / observation time: pending",
      "- result (completed / partial / not completed / environment blocked / unknown): pending",
      "- screenshot paths and evidence: pending",
      "- information accuracy / omissions: pending",
      "- human interventions: pending",
      "- repeated action candidates: unknown unless directly evidenced",
      "- side effects / login / CAPTCHA / personal data: inspect before classifying",
      "- module effect (Context / Memory / Plan / Batch / Monitor / Guard / CUA): record observed evidence; do not infer net benefit",
      "",
      `- collector: ${collected.reportStatus}; data quality: ${collected.dataQuality.status}; Runtime outcome is not business success.`,
      "",
    ].join("\n");
    await writeFile(manualPath, manual, "utf8");
    for (const fileName of ["run-metadata.json", "report.md", "manual-review.md"]) {
      const text = await readFile(resolve(runtimeRunPath, fileName), "utf8");
      if (text.includes("\uFFFD") || /\?{3,}/u.test(text)) throw new Error(`UTF-8 read-back failed for ${fileName}`);
    }
    process.stdout.write(`Collected ${taskId} Run ${metadata.runId}; runtimeOutcome=${metadata.runtimeOutcome}; report=${collected.reportStatus}; dataQuality=${collected.dataQuality.status}\n`);
  } else {
    const failure = {
      ...launchRecord,
      status: summary === null ? (runtimeStarted ? "runtime_failure_or_missing_summary" : "sdk_launch_failure_or_missing_summary") : "collection_blocked",
      finishedAt,
      runtimeError: runtimeError?.message,
      runtimeStarted,
      summaryPresent: summary !== null,
      runtimeRunDirectories: runtimeRuns.map((entry) => entry.name),
    };
    await writeFile(resolve(runRoot, "launch-failure.json"), `${JSON.stringify(failure, null, 2)}\n`, "utf8");
    process.stderr.write(`Preserved ${taskId} attempt ${attempt}; could not safely collect a single direct Runtime Run.\n`);
    process.exitCode = 1;
  }
  if (runtimeError !== undefined) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`Shanghai pilot runner failed: ${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
});
