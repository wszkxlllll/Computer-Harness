import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";
import { CuaDriver, EndSessionInput, StartSessionInput, type CuaDriverLike } from "@trycua/cua-driver";

type ModelName = "glm-5.3-flash" | "qwen3.8-flash";
type QwenCoordinateMode = "normalized_1000" | "actual_pixels";
type QwenThinkingMode = "disabled" | "low" | "medium" | "xhigh";
type DaemonProcess = ChildProcessByStdio<null, Readable, Readable>;

interface FrozenTask {
  id: string;
  goal: string;
  expectedText: string;
  initialText: string;
  maxSteps: number;
  maxModelRequests: number;
}

interface TaskManifest {
  version: number;
  models: readonly ModelName[];
  tasks: readonly FrozenTask[];
}

interface Options {
  binary: string;
  fixture: string;
  tasks: string;
  taskId: string;
  model: ModelName;
  socket: string;
  output: string;
  envFile: string;
  qwenCoordinateMode?: QwenCoordinateMode;
  qwenThinking?: QwenThinkingMode;
  startupTimeoutMs: number;
  maxSteps?: number;
  maxModelRequests?: number;
}

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface RunningChild {
  child: ChildProcessByStdio<null, Readable, Readable>;
  result: Promise<ChildResult>;
}

type EvaluationResult =
  | { status: "available"; success: boolean; reason?: string }
  | { status: "unavailable"; reason: string };

type RuntimeResult =
  | { status: "available"; outcome: string }
  | { status: "unavailable"; reason: string };

interface RunnerResult {
  status: "completed" | "failed";
  taskId: string;
  model: ModelName;
  coordinateMode?: QwenCoordinateMode;
  thinkingMode?: QwenThinkingMode;
  output: string;
  fixtureState: string;
  cli: { code: number | null; signal: NodeJS.Signals | null; stdoutFile: string; stderrFile: string };
  evaluator: { code: number | null; stdoutFile: string; stderrFile: string; outputFile: string };
  taskSuccess: boolean | null;
  runtimeOutcome: string | null;
  evaluation: EvaluationResult;
  runtime: RuntimeResult;
  cleanup: { fixturePid: number | null; fixtureKillRequested: boolean; daemonStopCode: number | null; warnings: string[]; errors: string[] };
  error?: string;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function requiredOption(args: readonly string[], name: string): string {
  const value = option(args, name);
  if (value === undefined || value.trim().length === 0) throw new Error(name + " is required");
  return value;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(name + " must be a positive integer");
  return parsed;
}

function normalizePipe(value: string): string {
  if (process.platform !== "win32") return value;
  const match = value.match(/^\\+\.\\+pipe\\+(.*)$/i);
  return match?.[1] === undefined ? value : "\\\\.\\pipe\\" + match[1].replace(/\\+/g, "\\");
}

function parseOptions(args: readonly string[]): Options {
  const model = requiredOption(args, "--model") as ModelName;
  if (model !== "glm-5.3-flash" && model !== "qwen3.8-flash") {
    throw new Error("--model must be glm-5.3-flash or qwen3.8-flash");
  }
  const maxStepsValue = option(args, "--max-steps");
  const maxRequestsValue = option(args, "--max-model-requests");
  const coordinateModeValue = option(args, "--qwen-coordinate-mode");
  if (coordinateModeValue !== undefined && coordinateModeValue !== "normalized_1000" && coordinateModeValue !== "actual_pixels") {
    throw new Error("--qwen-coordinate-mode must be normalized_1000 or actual_pixels");
  }
  if (coordinateModeValue !== undefined && model !== "qwen3.8-flash") {
    throw new Error("--qwen-coordinate-mode is only valid with a Qwen model");
  }
  if (model === "qwen3.8-flash" && coordinateModeValue === undefined) {
    throw new Error("--qwen-coordinate-mode is required for qwen3.8-flash until coordinate calibration selects a mode");
  }
  const thinkingValue = option(args, "--qwen-thinking");
  if (thinkingValue !== undefined && thinkingValue !== "disabled" && thinkingValue !== "low" && thinkingValue !== "medium" && thinkingValue !== "xhigh") {
    throw new Error("--qwen-thinking must be disabled, low, medium, or xhigh");
  }
  if (thinkingValue !== undefined && model !== "qwen3.8-flash") {
    throw new Error("--qwen-thinking is only valid with qwen3.8-flash");
  }
  return {
    binary: resolve(requiredOption(args, "--binary")),
    fixture: resolve(requiredOption(args, "--fixture")),
    tasks: resolve(option(args, "--tasks") ?? join(repoRoot, "docs", "stage-4-local-tasks-2026-08-31.json")),
    taskId: requiredOption(args, "--task"),
    model,
    socket: normalizePipe(requiredOption(args, "--socket")),
    output: resolve(requiredOption(args, "--output")),
    envFile: resolve(requiredOption(args, "--env-file")),
    ...(coordinateModeValue === undefined ? {} : { qwenCoordinateMode: coordinateModeValue as QwenCoordinateMode }),
    ...(model === "qwen3.8-flash" ? { qwenThinking: (thinkingValue ?? "low") as QwenThinkingMode } : {}),
    startupTimeoutMs: positiveInteger(option(args, "--startup-timeout-ms"), 20000, "--startup-timeout-ms"),
    ...(maxStepsValue === undefined ? {} : { maxSteps: positiveInteger(maxStepsValue, 12, "--max-steps") }),
    ...(maxRequestsValue === undefined ? {} : { maxModelRequests: positiveInteger(maxRequestsValue, 16, "--max-model-requests") }),
  };
}

function collectChild(child: ChildProcessByStdio<null, Readable, Readable>): Promise<ChildResult> {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  return new Promise((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveResult({ code, signal, stdout, stderr }));
  });
}

function spawnExternal(command: string, args: readonly string[], cwd = repoRoot): RunningChild {
  const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  return { child, result: collectChild(child) };
}

async function runExternal(command: string, args: readonly string[], cwd = repoRoot, timeoutMs?: number): Promise<ChildResult> {
  const running = spawnExternal(command, args, cwd);
  if (timeoutMs === undefined) return running.result;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<ChildResult>((resolveResult, reject) => {
      timer = setTimeout(() => {
        void terminateChild(running.child, 2000).then(() => {
          resolveResult({ code: null, signal: null, stdout: "", stderr: `command timed out after ${timeoutMs}ms` });
        }, reject);
      }, timeoutMs);
    });
    return await Promise.race([running.result, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function terminateChild(child: ChildProcessByStdio<null, Readable, Readable>, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill("SIGINT"); } catch { /* continue with hard stop below */ }
  await waitForChildClose(child, graceMs);
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill(); } catch { /* already gone */ }
    await waitForChildClose(child, graceMs);
  }
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error("owned child process did not stop within the cleanup deadline");
  }
}

async function waitForChildClose(child: ChildProcessByStdio<null, Readable, Readable>, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveResult) => {
    const timer = setTimeout(resolveResult, timeoutMs);
    child.once("close", () => {
      clearTimeout(timer);
      resolveResult();
    });
  });
}

async function waitForDaemon(options: Options, daemon: DaemonProcess, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + options.startupTimeoutMs;
  let last: ChildResult = { code: null, signal: null, stdout: "", stderr: "" };
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (daemon.exitCode !== null || daemon.signalCode !== null) {
      throw new Error("CUA daemon exited before readiness: " + (last.stderr || "no stderr"));
    }
    last = await runExternal(options.binary, ["status", "--socket", options.socket], repoRoot, 2000);
    if (last.code === 0 && /daemon is running/i.test(last.stdout)) return;
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error("CUA daemon readiness timeout: " + last.stdout + "\n" + last.stderr);
}

async function stopDaemon(options: Options, daemon: DaemonProcess): Promise<ChildResult> {
  try {
    return await runExternal(options.binary, ["stop", "--socket", options.socket], repoRoot, 5000);
  } finally {
    // Even failure to launch the stop command must not abandon our daemon.
    await waitForChildClose(daemon, 5000);
    await terminateChild(daemon, 2000);
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function structuredObject(value: unknown): Record<string, unknown> | undefined {
  const candidate = record(value);
  if (typeof candidate?.structuredJson !== "string") return undefined;
  try {
    return record(JSON.parse(candidate.structuredJson));
  } catch {
    return undefined;
  }
}

export function foregroundConfirmed(value: unknown): boolean {
  return structuredObject(value)?.landed_on_target === true;
}

function numberField(value: unknown, key: string): number | undefined {
  const candidate = record(value)?.[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function encodeProbeText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

async function callTool(driver: CuaDriverLike, name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const value = signal === undefined
    ? await driver.callTool(name, JSON.stringify(input))
    : await driver.callTool(name, JSON.stringify(input), { signal });
  const candidate = record(value);
  if (candidate?.isError === true) {
    throw new Error(name + " refused: " + String(candidate.errorCode ?? candidate.text ?? "unknown error"));
  }
  return value;
}

async function waitForFile(path: string, signal: AbortSignal, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      await readFile(path);
      signal.throwIfAborted();
      return;
    } catch {
      signal.throwIfAborted();
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  throw new Error("fixture state file was not created: " + path);
}

async function assertFreshOutput(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  const entries = await readdir(path);
  if (entries.length > 0) throw new Error("run output directory must be empty to preserve prior evidence: " + path);
}

async function loadTask(path: string, taskId: string, model: ModelName): Promise<FrozenTask> {
  const manifest = JSON.parse(await readFile(path, "utf8")) as TaskManifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.models) || !Array.isArray(manifest.tasks)) {
    throw new Error("task manifest version, models, or tasks are invalid");
  }
  if (!manifest.models.includes(model)) throw new Error("model " + model + " is not in the frozen task manifest");
  const task = manifest.tasks.find((candidate) => candidate.id === taskId);
  if (task === undefined) throw new Error("task " + taskId + " is not in the frozen task manifest");
  if (task.initialText.length === 0 || task.expectedText.length === 0 || task.goal.trim().length === 0) {
    throw new Error("task " + taskId + " has empty goal or text");
  }
  if (!Number.isInteger(task.maxSteps) || task.maxSteps < 1 || !Number.isInteger(task.maxModelRequests) || task.maxModelRequests < 1) {
    throw new Error("task " + taskId + " has invalid budgets");
  }
  return task;
}

function startDaemon(options: Options): { daemon: DaemonProcess; logs: { stdout: string; stderr: string } } {
  const logs = { stdout: "", stderr: "" };
  const daemon = spawn(options.binary, ["serve", "--socket", options.socket, "--no-overlay"], {
    cwd: repoRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemon.stdout.setEncoding("utf8");
  daemon.stderr.setEncoding("utf8");
  daemon.stdout.on("data", (chunk: string) => (logs.stdout += chunk));
  daemon.stderr.on("data", (chunk: string) => (logs.stderr += chunk));
  daemon.on("error", (error) => {
    logs.stderr += `daemon process error: ${error instanceof Error ? error.message : String(error)}\n`;
  });
  return { daemon, logs };
}

async function launchFixture(
  options: Options,
  daemon: DaemonProcess,
  output: string,
  initialText: string,
  signal: AbortSignal,
  onPid: (pid: number) => void,
): Promise<{ pid: number; statePath: string }> {
  const statePath = join(output, "fixture-state.txt");
  const session = "stage4-bootstrap-" + Date.now();
  let driver: CuaDriverLike | undefined;
  try {
    try {
      await unlink(statePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await waitForDaemon(options, daemon, signal);
    driver = CuaDriver.connect(options.socket);
    await driver.startSession(StartSessionInput.new({ session }), { signal });
    const windowsValue = await callTool(driver, "list_windows", { session, on_screen_only: true }, signal);
    const windows = structuredObject(windowsValue)?.windows;
    if (Array.isArray(windows) && windows.some((item) => /computer harness probe fixture/i.test(JSON.stringify(item)))) {
      throw new Error("an existing probe fixture window is visible; close it before starting an isolated run");
    }
    const launchValue = await callTool(driver, "launch_app", {
      path: options.fixture,
      additional_arguments: [statePath],
      start_minimized: false,
      session,
    }, signal);
    const pid = numberField(structuredObject(launchValue), "pid");
    if (pid === undefined) throw new Error("launch_app did not return the isolated fixture pid");
    onPid(pid);
    const listedValue = await callTool(driver, "list_windows", { session, pid, on_screen_only: true }, signal);
    const listed = structuredObject(listedValue)?.windows;
    const selected = Array.isArray(listed) && listed.length > 0 ? record(listed[0]) : undefined;
    if (selected === undefined) throw new Error("isolated fixture window was not visible after launch");
    const windowId = numberField(selected, "window_id");
    const foreground = await callTool(driver, "bring_to_front", { session, pid, ...(windowId === undefined ? {} : { window_id: windowId }) }, signal);
    if (!foregroundConfirmed(foreground)) {
      throw new Error("isolated fixture was not confirmed in the foreground");
    }
    await driver.endSession(EndSessionInput.new({ session }), { signal });
    await driver.shutdown({ signal });
    driver = undefined;
    await waitForFile(statePath, signal, 5000);
    const initialStateLine = (await readFile(statePath, "utf8")).split(/\r?\n/).find((line) => line.startsWith("text="));
    if (initialStateLine !== "text=" + encodeProbeText(initialText)) {
      throw new Error("fixture did not start in the frozen initial text state");
    }
    return { pid, statePath };
  } catch (error) {
    if (driver !== undefined) {
      try { await driver.endSession(EndSessionInput.new({ session }), { signal: AbortSignal.timeout(2000) }); } catch { /* preserve primary error */ }
      try { await driver.shutdown({ signal: AbortSignal.timeout(2000) }); } catch { /* preserve primary error */ }
    }
    throw error;
  }
}

async function killFixture(options: Options, pid: number): Promise<{ warning?: string; error?: string }> {
  let driver: CuaDriverLike | undefined;
  const session = "stage4-cleanup-" + Date.now();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error("fixture cleanup timed out")), 5000);
  let cleanupWarning: string | undefined;
  let cleanupError: string | undefined;
  try {
    driver = CuaDriver.connect(options.socket);
    await driver.startSession(StartSessionInput.new({ session }), { signal: abort.signal });
    await callTool(driver, "kill_app", { session, pid }, abort.signal);
    await driver.endSession(EndSessionInput.new({ session }), { signal: abort.signal });
  } catch (error) {
    // The exact host-owned PID is the bounded fallback when the daemon is already gone.
    cleanupWarning = error instanceof Error ? error.message : String(error);
  } finally {
    if (driver !== undefined) {
      try { await driver.shutdown({ signal: abort.signal }); } catch (error) {
        cleanupError = appendError(cleanupError, "driver shutdown: " + String(error));
      }
    }
    clearTimeout(timer);
    try {
      process.kill(pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        cleanupError = cleanupError === undefined ? String(error) : cleanupError + "; " + String(error);
      }
    }
  }
  return { ...(cleanupWarning === undefined ? {} : { warning: cleanupWarning }), ...(cleanupError === undefined ? {} : { error: cleanupError }) };
}

function appendError(current: string | undefined, next: string): string {
  return current === undefined ? next : current + "; " + next;
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  const object = record(parsed);
  if (object === undefined) throw new Error("JSON root must be an object");
  return object;
}

export function parseEvaluationResult(value: unknown): EvaluationResult {
  const object = record(value);
  if (object === undefined) return { status: "unavailable", reason: "evaluation JSON root must be an object" };
  if (typeof object.success !== "boolean") return { status: "unavailable", reason: "evaluation.success must be boolean" };
  return typeof object.reason === "string"
    ? { status: "available", success: object.success, reason: object.reason }
    : { status: "available", success: object.success };
}

export function parseRuntimeResult(value: unknown): RuntimeResult {
  const object = record(value);
  if (object === undefined) return { status: "unavailable", reason: "summary JSON root must be an object" };
  if (typeof object.runtimeOutcome !== "string" || object.runtimeOutcome.length === 0) {
    return { status: "unavailable", reason: "summary.runtimeOutcome must be a non-empty string" };
  }
  return { status: "available", outcome: object.runtimeOutcome };
}

async function readEvaluationResult(path: string): Promise<EvaluationResult> {
  try {
    return parseEvaluationResult(await readJsonObject(path));
  } catch (error) {
    return { status: "unavailable", reason: `could not read evaluation: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function readRuntimeResult(path: string): Promise<RuntimeResult> {
  try {
    return parseRuntimeResult(await readJsonObject(path));
  } catch (error) {
    return { status: "unavailable", reason: `could not read runtime summary: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write("Usage: run:stage4-task --binary <cua-driver.exe> --fixture <ProbeWindow.exe> --task <task-id> --model <glm-5.3-flash|qwen3.8-flash> --socket <pipe> --output <dir> --env-file <.env> [--tasks <manifest>] [--qwen-coordinate-mode <normalized_1000|actual_pixels>] [--qwen-thinking <disabled|low|medium|xhigh>] [--max-steps N] [--max-model-requests N]\n");
    return;
  }
  const options = parseOptions(args);
  const task = await loadTask(options.tasks, options.taskId, options.model);
  await assertFreshOutput(options.output);
  const cliStdoutPath = join(options.output, "cli.stdout.log");
  const cliStderrPath = join(options.output, "cli.stderr.log");
  const evaluationPath = join(options.output, "evaluation.json");
  const evaluationStdoutPath = join(options.output, "evaluator.stdout.log");
  const evaluationStderrPath = join(options.output, "evaluator.stderr.log");
  const runAbort = new AbortController();
  const resources: {
    daemon: DaemonProcess | undefined;
    daemonLogs: { stdout: string; stderr: string };
    fixturePid: number | undefined;
    cli: RunningChild | undefined;
    stopRequested: boolean;
    cleanupWarnings: string[];
    cleanupErrors: string[];
  } = { daemon: undefined, daemonLogs: { stdout: "", stderr: "" }, fixturePid: undefined, cli: undefined, stopRequested: false, cleanupWarnings: [], cleanupErrors: [] };
  let daemonStopCode: number | null = null;
  let cliResult: ChildResult = { code: null, signal: null, stdout: "", stderr: "" };
  let evaluationResult: ChildResult = { code: null, signal: null, stdout: "", stderr: "" };
  let statePath = join(options.output, "fixture-state.txt");
  let errorMessage: string | undefined;
  const startedAt = new Date().toISOString();
  await Promise.all([
    writeFile(cliStdoutPath, "", "utf8"),
    writeFile(cliStderrPath, "", "utf8"),
    writeFile(evaluationStdoutPath, "", "utf8"),
    writeFile(evaluationStderrPath, "", "utf8"),
    writeFile(join(options.output, "daemon.stop.stdout.log"), "", "utf8"),
    writeFile(join(options.output, "daemon.stop.stderr.log"), "", "utf8"),
  ]);
  const onSigint = () => {
    if (resources.stopRequested) return;
    resources.stopRequested = true;
    runAbort.abort(new Error("runner interrupted by SIGINT"));
    if (resources.cli !== undefined) {
      void terminateChild(resources.cli.child, 2000).catch((error: unknown) => {
        resources.cleanupErrors.push("CLI interrupt: " + String(error));
      });
    }
  };
  process.on("SIGINT", onSigint);
  try {
    const daemon = startDaemon(options);
    resources.daemon = daemon.daemon;
    resources.daemonLogs = daemon.logs;
    const launched = await launchFixture(options, daemon.daemon, options.output, task.initialText, runAbort.signal, (pid) => {
      resources.fixturePid = pid;
    });
    statePath = launched.statePath;
    const cliPath = join(repoRoot, "apps", "cli", "dist", "index.js");
    const cliArgs = [
      cliPath, "--goal", task.goal, "--model", options.model, "--cua-socket", options.socket,
      "--output", options.output, "--env-file", options.envFile,
      "--max-steps", String(options.maxSteps ?? task.maxSteps),
      "--max-model-requests", String(options.maxModelRequests ?? task.maxModelRequests),
    ];
    if (options.qwenCoordinateMode !== undefined) {
      cliArgs.push("--qwen-coordinate-mode", options.qwenCoordinateMode);
    }
    if (options.qwenThinking !== undefined) {
      cliArgs.push("--qwen-thinking", options.qwenThinking);
    }
    // Bootstrap cleanup and state-file reads also yield: cancellation can arrive
    // after the final driver operation, before a model process exists to stop.
    runAbort.signal.throwIfAborted();
    const cli = spawnExternal(process.execPath, cliArgs);
    resources.cli = cli;
    try {
      cliResult = await cli.result;
    } finally {
      resources.cli = undefined;
    }
    await writeFile(cliStdoutPath, cliResult.stdout, "utf8");
    await writeFile(cliStderrPath, cliResult.stderr, "utf8");
    const evaluator = join(repoRoot, "scripts", "stage4-local", "evaluate-fixture.ps1");
    evaluationResult = await runExternal("pwsh.exe", [
      "-NoProfile", "-File", evaluator, "-StatePath", statePath,
      "-ExpectedText", task.expectedText, "-OutputPath", evaluationPath,
    ], repoRoot, 5000);
    await writeFile(evaluationStdoutPath, evaluationResult.stdout, "utf8");
    await writeFile(evaluationStderrPath, evaluationResult.stderr, "utf8");
    if (cliResult.code !== 0) errorMessage = "CLI exited with code " + String(cliResult.code);
    if (evaluationResult.code !== 0) errorMessage = (errorMessage === undefined ? "" : errorMessage + "; ") + "evaluator exited with code " + String(evaluationResult.code);
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  } finally {
    if (resources.cli !== undefined) {
      try { await terminateChild(resources.cli.child, 2000); } catch (error) { resources.cleanupErrors.push("CLI stop failed: " + String(error)); }
      try { cliResult = await resources.cli.result; } catch (error) { resources.cleanupErrors.push("CLI result unavailable: " + String(error)); }
      resources.cli = undefined;
    }
    if (resources.fixturePid !== undefined) {
      const fixtureCleanup = await killFixture(options, resources.fixturePid);
      if (fixtureCleanup.warning !== undefined) resources.cleanupWarnings.push("fixture CUA cleanup diagnostic: " + fixtureCleanup.warning);
      if (fixtureCleanup.error !== undefined) resources.cleanupErrors.push("fixture cleanup: " + fixtureCleanup.error);
    }
    if (resources.daemon !== undefined) {
      try {
        const stopped = await stopDaemon(options, resources.daemon);
        daemonStopCode = stopped.code;
        await writeFile(join(options.output, "daemon.stop.stdout.log"), stopped.stdout, "utf8");
        await writeFile(join(options.output, "daemon.stop.stderr.log"), stopped.stderr, "utf8");
      } catch (error) {
        const message = "daemon cleanup: " + (error instanceof Error ? error.message : String(error));
        resources.cleanupErrors.push(message);
        try { await writeFile(join(options.output, "daemon.stop.stderr.log"), message + "\n", "utf8"); } catch { /* runner.json retains the diagnostic */ }
      }
      try { await writeFile(join(options.output, "daemon.stdout.log"), resources.daemonLogs.stdout, "utf8"); } catch (error) { resources.cleanupErrors.push("daemon stdout log: " + String(error)); }
      try { await writeFile(join(options.output, "daemon.stderr.log"), resources.daemonLogs.stderr, "utf8"); } catch (error) { resources.cleanupErrors.push("daemon stderr log: " + String(error)); }
    }
    process.removeListener("SIGINT", onSigint);
  }
  if (resources.stopRequested) errorMessage = appendError(errorMessage, "runner interrupted by SIGINT");
  const evaluation = await readEvaluationResult(evaluationPath);
  const runtime = await readRuntimeResult(join(options.output, "summary.json"));
  if (cliResult.code !== null && cliResult.code !== 0 && errorMessage === undefined) {
    errorMessage = "CLI exited with code " + String(cliResult.code);
  }
  if (evaluationResult.code !== null && evaluationResult.code !== 0) {
    errorMessage = appendError(errorMessage, "evaluator exited with code " + String(evaluationResult.code));
  }
  if (evaluation.status === "unavailable") errorMessage = appendError(errorMessage, evaluation.reason);
  if (runtime.status === "unavailable") errorMessage = appendError(errorMessage, runtime.reason);
  for (const cleanupError of resources.cleanupErrors) errorMessage = appendError(errorMessage, cleanupError);
  const taskSuccess = evaluation.status === "available" ? evaluation.success : null;
  const result: RunnerResult = {
    status: errorMessage === undefined ? "completed" : "failed",
    taskId: task.id,
    model: options.model,
    ...(options.qwenCoordinateMode === undefined ? {} : { coordinateMode: options.qwenCoordinateMode }),
    ...(options.qwenThinking === undefined ? {} : { thinkingMode: options.qwenThinking }),
    output: options.output,
    fixtureState: statePath,
    cli: { code: cliResult.code, signal: cliResult.signal, stdoutFile: cliStdoutPath, stderrFile: cliStderrPath },
    evaluator: { code: evaluationResult.code, stdoutFile: evaluationStdoutPath, stderrFile: evaluationStderrPath, outputFile: evaluationPath },
    taskSuccess,
    runtimeOutcome: runtime.status === "available" ? runtime.outcome : null,
    evaluation,
    runtime,
    cleanup: { fixturePid: resources.fixturePid ?? null, fixtureKillRequested: resources.fixturePid !== undefined, daemonStopCode, warnings: resources.cleanupWarnings, errors: resources.cleanupErrors },
    ...(errorMessage === undefined ? {} : { error: errorMessage }),
  };
  await writeFile(join(options.output, "runner.json"), JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), ...result }, null, 2) + "\n", "utf8");
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exitCode = result.status === "completed" ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    process.stderr.write((error instanceof Error ? error.stack ?? error.message : String(error)) + "\n");
    process.exitCode = 1;
  });
}
