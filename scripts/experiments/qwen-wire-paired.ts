import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";

type ModelName = "gui-plus-2026-02-26";
type QwenCoordinateMode = "normalized_1000" | "actual_pixels";

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
  models: readonly string[];
  tasks: readonly FrozenTask[];
}

interface Options {
  binary: string;
  fixture: string;
  tasks: string;
  socketPrefix: string;
  output: string;
  envFile: string;
  startupTimeoutMs?: number;
  maxSteps?: number;
  maxModelRequests?: number;
  runTimeoutMs: number;
  planOnly: boolean;
}

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface PairRunResult {
  taskId: string;
  model: ModelName;
  coordinateMode?: QwenCoordinateMode;
  output: string;
  socket: string;
  child: { code: number | null; signal: NodeJS.Signals | null; timedOut: boolean; elapsedMs: number; stdoutFile: string; stderrFile: string };
  runner?: Record<string, unknown>;
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

function parseOptions(args: readonly string[]): Options {
  const runTimeoutMs = positiveInteger(option(args, "--run-timeout-ms"), 1_800_000, "--run-timeout-ms");
  const startupTimeoutValue = option(args, "--startup-timeout-ms");
  const maxStepsValue = option(args, "--max-steps");
  const maxRequestsValue = option(args, "--max-model-requests");
  return {
    binary: resolve(requiredOption(args, "--binary")),
    fixture: resolve(requiredOption(args, "--fixture")),
    tasks: resolve(option(args, "--tasks") ?? join(repoRoot, "docs", "stage-4-local-tasks-2026-08-31.json")),
    socketPrefix: option(args, "--socket-prefix") ?? defaultSocketPrefix(),
    output: resolve(requiredOption(args, "--output")),
    envFile: resolve(requiredOption(args, "--env-file")),
    ...(startupTimeoutValue === undefined ? {} : { startupTimeoutMs: positiveInteger(startupTimeoutValue, 20_000, "--startup-timeout-ms") }),
    ...(maxStepsValue === undefined ? {} : { maxSteps: positiveInteger(maxStepsValue, 12, "--max-steps") }),
    ...(maxRequestsValue === undefined ? {} : { maxModelRequests: positiveInteger(maxRequestsValue, 16, "--max-model-requests") }),
    runTimeoutMs,
    planOnly: args.includes("--plan-only"),
  };
}

function defaultSocketPrefix(): string {
  return process.platform === "win32"
    ? "\\\\.\\pipe\\computer-harness-stage4-qwen-pair"
    : join(repoRoot, "runs", "stage4-qwen-pair", "socket");
}

async function loadManifest(path: string): Promise<TaskManifest> {
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.models) || !Array.isArray(value.tasks)) {
    throw new Error("task manifest must be version 1 with models and tasks arrays");
  }
  if (!value.models.includes("gui-plus-2026-02-26")) {
    throw new Error("task manifest must include gui-plus-2026-02-26");
  }
  const tasks: FrozenTask[] = [];
  for (const raw of value.tasks) {
    if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.goal !== "string" || typeof raw.expectedText !== "string" || typeof raw.initialText !== "string" || !Number.isInteger(raw.maxSteps) || !Number.isInteger(raw.maxModelRequests)) {
      throw new Error("each task must contain id, goal, expectedText, initialText, maxSteps, and maxModelRequests");
    }
    if (raw.id.trim().length === 0 || raw.goal.trim().length === 0 || raw.expectedText.length === 0 || raw.initialText.length === 0 || raw.maxSteps < 1 || raw.maxModelRequests < 1) {
      throw new Error("task contains an empty field or invalid budget: " + raw.id);
    }
    tasks.push({
      id: raw.id,
      goal: raw.goal,
      expectedText: raw.expectedText,
      initialText: raw.initialText,
      maxSteps: raw.maxSteps,
      maxModelRequests: raw.maxModelRequests,
    });
  }
  if (tasks.length === 0) throw new Error("task manifest contains no tasks");
  return { version: 1, models: value.models as string[], tasks };
}

function collectChild(child: ChildProcessByStdio<null, Readable, Readable>): Promise<Omit<ChildResult, "timedOut">> {
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

async function waitForClose(child: ChildProcessByStdio<null, Readable, Readable>, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveResult) => {
    const timer = setTimeout(resolveResult, timeoutMs);
    child.once("close", () => {
      clearTimeout(timer);
      resolveResult();
    });
  });
}

async function terminateChild(child: ChildProcessByStdio<null, Readable, Readable>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill("SIGINT"); } catch { /* continue with the hard stop */ }
  await waitForClose(child, 2_000);
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill(); } catch { /* process may have exited between checks */ }
    await waitForClose(child, 2_000);
  }
}

async function runStage4(commandArgs: readonly string[], timeoutMs: number): Promise<ChildResult> {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const child = spawn(command, ["--dir", join(repoRoot, "spikes", "cua-driver"), "exec", "tsx", "stage4-local-runner.ts", ...commandArgs], {
    cwd: repoRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const result = collectChild(child);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<ChildResult>((resolveResult) => {
      timer = setTimeout(() => {
        void (async () => {
          await terminateChild(child);
          try {
            const completed = await result;
            resolveResult({ ...completed, stderr: `${completed.stderr}\nstage4 run timed out after ${timeoutMs}ms`, timedOut: true });
          } catch (error) {
            resolveResult({ code: null, signal: null, stdout: "", stderr: `stage4 run timed out after ${timeoutMs}ms; ${String(error)}`, timedOut: true });
          }
        })();
      }, timeoutMs);
    });
    const completed = await Promise.race([result, timeout]);
    return "timedOut" in completed ? completed : { ...completed, timedOut: false };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function assertFreshOutput(path: string): Promise<void> {
  try {
    const metadata = await stat(path);
    if (!metadata.isDirectory()) throw new Error("run output path is not a directory: " + path);
    if ((await readdir(path)).length > 0) throw new Error("run output directory is not empty: " + path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(path, { recursive: true });
  }
}

function socketFor(prefix: string, index: number): string {
  return `${prefix}-${Date.now()}-${index}`;
}

function stage4Args(options: Options, task: FrozenTask, model: ModelName, socket: string, output: string, coordinateMode?: QwenCoordinateMode): string[] {
  const args = [
    "--binary", options.binary,
    "--fixture", options.fixture,
    "--tasks", options.tasks,
    "--task", task.id,
    "--model", model,
    "--socket", socket,
    "--output", output,
    "--env-file", options.envFile,
    ...(options.startupTimeoutMs === undefined ? [] : ["--startup-timeout-ms", String(options.startupTimeoutMs)]),
    ...(options.maxSteps === undefined ? [] : ["--max-steps", String(options.maxSteps)]),
    ...(options.maxModelRequests === undefined ? [] : ["--max-model-requests", String(options.maxModelRequests)]),
  ];
  if (coordinateMode !== undefined) args.push("--qwen-coordinate-mode", coordinateMode);
  return args;
}

async function executePairRun(options: Options, task: FrozenTask, model: ModelName, coordinateMode: QwenCoordinateMode | undefined, index: number): Promise<PairRunResult> {
  const coordinateLabel = coordinateMode ?? "default";
  const output = resolve(options.output, task.id, model, coordinateLabel);
  await assertFreshOutput(output);
  const socket = socketFor(options.socketPrefix, index);
  const stdoutFile = join(output, "pair-child.stdout.log");
  const stderrFile = join(output, "pair-child.stderr.log");
  const startedAt = Date.now();
  const childResult = await runStage4(stage4Args(options, task, model, socket, output, coordinateMode), options.runTimeoutMs);
  const elapsedMs = Date.now() - startedAt;
  await writeFile(stdoutFile, childResult.stdout, "utf8");
  await writeFile(stderrFile, childResult.stderr, "utf8");
  let runner: Record<string, unknown> | undefined;
  let error: string | undefined;
  try {
    const parsed = JSON.parse(await readFile(join(output, "runner.json"), "utf8")) as unknown;
    if (!isRecord(parsed)) throw new Error("runner.json root is not an object");
    runner = parsed;
  } catch (readError) {
    error = "stage4 runner result unavailable: " + (readError instanceof Error ? readError.message : String(readError));
  }
  if (childResult.timedOut) error = appendError(error, `child timed out after ${options.runTimeoutMs}ms`);
  if (childResult.code !== 0 && childResult.code !== null) error = appendError(error, `child exited with code ${childResult.code}`);
  return {
    taskId: task.id,
    model,
    ...(coordinateMode === undefined ? {} : { coordinateMode }),
    output,
    socket,
    child: { code: childResult.code, signal: childResult.signal, timedOut: childResult.timedOut, elapsedMs, stdoutFile, stderrFile },
    ...(runner === undefined ? {} : { runner }),
    ...(error === undefined ? {} : { error }),
  };
}

function appendError(current: string | undefined, next: string): string {
  return current === undefined ? next : `${current}; ${next}`;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write("Usage: run:qwen-paired --binary <cua-driver.exe> --fixture <ProbeWindow.exe> --output <dir> --env-file <.env> [--tasks <manifest>] [--socket-prefix <prefix>] [--run-timeout-ms N] [--plan-only]\n");
    return;
  }
  const options = parseOptions(process.argv.slice(2));
  const manifest = await loadManifest(options.tasks);
  const planned: Array<{ task: FrozenTask; model: ModelName; coordinateMode?: QwenCoordinateMode }> = [];
  for (const task of manifest.tasks) {
    planned.push({ task, model: "gui-plus-2026-02-26", coordinateMode: "normalized_1000" });
    planned.push({ task, model: "gui-plus-2026-02-26", coordinateMode: "actual_pixels" });
  }
  await mkdir(options.output, { recursive: true });
  if (options.planOnly) {
    const plan = { kind: "stage4_qwen_coordinate_paired", manifest: options.tasks, totalRuns: planned.length, runs: planned.map((item) => ({ taskId: item.task.id, model: item.model, ...(item.coordinateMode === undefined ? {} : { coordinateMode: item.coordinateMode }) })) };
    process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
    return;
  }
  const results: PairRunResult[] = [];
  for (const [index, item] of planned.entries()) {
    const result = await executePairRun(options, item.task, item.model, item.coordinateMode, index);
    results.push(result);
    // Model/evaluator failure remains a completed diagnostic Run. Infrastructure,
    // timeout, missing result, or cleanup failure marks `error` and stops the batch.
    if (result.error !== undefined) break;
  }
  const summary = {
    kind: "stage4_qwen_coordinate_paired",
    version: 1,
    generatedAt: new Date().toISOString(),
    manifest: options.tasks,
    constraints: {
      fixedTaskManifest: true,
      fixedRuntimeAndPrompt: true,
      nativeFunctionCalling: true,
      coordinateModes: ["normalized_1000", "actual_pixels"],
      noXmlToolCalls: true,
      noRegexJsonRepair: true,
      sequentialRuns: true,
    },
    matrix: {
      tasks: manifest.tasks.length,
      plannedQwenRuns: planned.length,
      executedQwenRuns: results.length,
      stoppedEarly: results.length < planned.length,
    },
    results,
  };
  await writeFile(join(options.output, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
  process.stdout.write(JSON.stringify({ output: options.output, totalRuns: results.length, failedRuns: results.filter((result) => result.error !== undefined).length }, null, 2) + "\n");
  process.exitCode = results.some((result) => result.error !== undefined) ? 1 : 0;
}

main().catch((error: unknown) => {
  process.stderr.write((error instanceof Error ? error.stack ?? error.message : String(error)) + "\n");
  process.exitCode = 1;
});
