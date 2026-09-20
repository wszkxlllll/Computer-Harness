#!/usr/bin/env node

/**
 * Offline collector for an interactive travel TUI session.
 *
 * A TUI session contains independent `run-*` directories with Runtime's
 * summary.json and trajectory.jsonl directly inside each run directory.  The
 * collector never starts a Runtime/GUI/API process, reads stdin, or reads
 * provider exchanges.  It only derives local evidence and writes per-run
 * metadata, metrics, an optional raw-summary report, and a first-write-only
 * manual review template.
 */

import { lstat, readFile, readdir, realpath, unlink, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TRAVEL_RUN_ROOT,
  collectMetrics,
  readMetricsArtifacts,
} from "./metrics.mjs";

const SESSION_KIND = "travel_tui_session";
const RUN_DIRECTORY_PATTERN = /^run-[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const DEFAULT_POLL_INTERVAL_MS = 1500;
const DEFAULT_READY_FILE = "collector.ready";
const CONFIG_FIELDS = [
  "model",
  "computer",
  "computerTarget",
  "coordinateMode",
  "qwenCoordinateMode",
  "thinkingMode",
  "qwenThinking",
  "outputMode",
  "qwenOutputMode",
  "glmThinking",
  "planning",
  "memory",
  "memoryRetrieval",
  "batching",
  "contextMode",
  "contextMaxHistoryEvents",
  "contextMaxInputTokens",
  "monitor",
  "monitorMode",
  "riskProfile",
  "riskGuard",
  "riskModel",
  "cleanupDeadlineMs",
  "maxSteps",
  "maxModelRequests",
];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringOrNull(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function pathKey(value) {
  return resolve(value).replaceAll("\\", "/").toLowerCase();
}

function pathInside(root, target) {
  const child = relative(pathKey(root), pathKey(target));
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function resolveInputPath(value, root) {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0") || value.includes("\r") || value.includes("\n")) {
    throw new Error("session directory is invalid");
  }
  if (isAbsolute(value)) return resolve(value);
  const fromCwd = resolve(value);
  return pathInside(root, fromCwd) ? fromCwd : resolve(root, value);
}

async function safeDirectory(value, root, label) {
  const configuredRoot = resolve(root);
  const directory = resolveInputPath(value, configuredRoot);
  if (!pathInside(configuredRoot, directory)) throw new Error(`${label} must stay inside runs/travel`);
  let physicalRoot = configuredRoot;
  let physicalDirectory = directory;
  try { physicalRoot = await realpath(configuredRoot); } catch { /* stat below reports a missing root */ }
  try { physicalDirectory = await realpath(directory); } catch { /* stat below reports a missing directory */ }
  if (!pathInside(physicalRoot, physicalDirectory)) throw new Error(`${label} resolves outside runs/travel`);
  const entry = await lstat(directory);
  if (entry.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  if (!entry.isDirectory()) throw new Error(`${label} must be a directory`);
  return directory;
}

async function assertNoSymlink(filePath, label) {
  try {
    const entry = await lstat(filePath);
    if (entry.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
    if (entry.isDirectory()) throw new Error(`${label} must not be a directory`);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function safeWriteJson(filePath, value, label) {
  await assertNoSymlink(filePath, label);
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeManualReviewOnce(filePath, text) {
  const present = await assertNoSymlink(filePath, "manual-review.md");
  if (present) return false;
  try {
    await writeFile(filePath, text, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
}

async function readJson(filePath) {
  try {
    await assertNoSymlink(filePath, basename(filePath));
    return { value: JSON.parse(await readFile(filePath, "utf8")), error: null };
  } catch (error) {
    if (error?.code === "ENOENT") return { value: null, error: { code: "missing_file", path: basename(filePath) } };
    if (error?.message?.includes("symbolic link")) return { value: null, error: { code: "symlink_file", path: basename(filePath) } };
    return { value: null, error: { code: "invalid_json", path: basename(filePath) } };
  }
}

function safeValue(value, depth = 0) {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;
  if (depth >= 3) return null;
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => safeValue(item, depth + 1));
  if (!isRecord(value)) return null;
  return Object.fromEntries(Object.entries(value).slice(0, 64).map(([key, item]) => [key, safeValue(item, depth + 1)]));
}

function actualConfig(summary) {
  const config = {};
  for (const field of CONFIG_FIELDS) config[field] = isRecord(summary) && Object.hasOwn(summary, field) ? safeValue(summary[field]) : null;
  return config;
}

function eventRunIds(events) {
  return [...new Set(events.flatMap((event) => {
    const values = [];
    if (typeof event?.runId === "string") values.push(event.runId);
    if (typeof event?.observation?.runId === "string") values.push(event.observation.runId);
    return values;
  }))];
}

function terminalEvent(events) {
  return [...events].reverse().find((event) => event?.type === "run.finished");
}

function reportSource(summary, events) {
  if (isRecord(summary) && typeof summary.modelSummary === "string" && summary.modelSummary.trim().length > 0) return { source: "summary.modelSummary", text: summary.modelSummary };
  const terminal = terminalEvent(events);
  if (typeof terminal?.summary === "string" && terminal.summary.trim().length > 0) return { source: "run.finished.summary", text: terminal.summary };
  return null;
}

function goalSource(summary, events, runId) {
  if (typeof summary?.goal === "string") return { source: "summary.goal", text: summary.goal };
  if (runId === null) return null;
  const created = events.find((event) => event?.type === "run.created" && typeof event.goal === "string");
  return created === undefined ? null : { source: "run.created.goal", text: created.goal };
}

function taskIdFor(summary, session) {
  if (typeof summary?.taskId === "string" && summary.taskId.length > 0) return summary.taskId;
  if (typeof session?.taskId === "string" && session.taskId.length > 0) return session.taskId;
  return "unassigned";
}

function manualReviewText({ sessionId, runDirectory, runId, taskId }) {
  return [
    "# 出行 TUI Run 人工走查",
    "",
    `- session: ${sessionId ?? "unknown"}`,
    `- run directory: ${runDirectory}`,
    `- runId: ${runId ?? "unknown"}`,
    `- taskId: ${taskId}`,
    "- business outcome: pending_manual_review",
    "- runtime outcome is not business success.",
    "",
    "## 人工记录",
    "",
    "- 实际入口、客户端版本、初态与登录状态：待填写",
    "- 结果（完成/部分完成/未完成/环境阻塞/无法判断）：待填写",
    "- 约束错误、信息依据、人工介入与安全问题：待填写",
    "- 模块效果证据（Context/Memory/Plan/Batch/Monitor/Guard/CUA）：待填写",
    "- 业务成功：待人工判断；不要由 Runtime outcome 推断。",
    "",
  ].join("\n");
}

function reportText({ sessionId, runDirectory, runId, taskId, metrics, summary, report, conflict }) {
  const lines = [
    "# Travel TUI Run report",
    "",
    `- session: ${sessionId ?? "unknown"}`,
    `- run directory: ${runDirectory}`,
    `- runId: ${runId ?? "unknown"}`,
    `- taskId: ${taskId}`,
    `- runtimeOutcome: ${metrics.runtimeOutcome ?? "unknown"}`,
    `- modelReportedStatus: ${metrics.modelReportedStatus ?? "unknown"}`,
    `- dataQuality: ${metrics.dataQuality.status}`,
    `- dataQualityErrors: ${metrics.dataQuality.errors.map((error) => error.code).join(",") || "none"}`,
    `- original summary runId: ${summary?.runId ?? "unknown"}`,
    "",
    "## Raw model report",
    ...(conflict
      ? ["数据冲突，未导出原始回复。"]
      : report === null
        ? ["未产生最终回复，未导出原始回复。"]
        : [`<!-- source: ${report.source} -->`, report.text]),
  ];
  // report.text is intentionally inserted verbatim when IDs are consistent;
  // this is local evidence, not a claim that the task was correct.
  return lines.join("\n");
}

async function artifactSignature(runDirectory) {
  const parts = [];
  for (const name of ["summary.json", "trajectory.jsonl"]) {
    const path = join(runDirectory, name);
    try {
      const entry = await lstat(path);
      if (entry.isSymbolicLink()) parts.push(`${name}:symlink`);
      else parts.push(`${name}:${entry.size}:${entry.mtimeMs}`);
    } catch (error) {
      if (error?.code === "ENOENT") parts.push(`${name}:missing`);
      else parts.push(`${name}:error`);
    }
  }
  return parts.join("|");
}

async function requiredOutputsPresent(runDirectory) {
  for (const name of ["run-metadata.json", "metrics.json", "manual-review.md", "report.md"]) {
    if (!(await assertNoSymlink(join(runDirectory, name), name))) return false;
  }
  return true;
}

function safeRunResult({ runDirectory, runId, taskId, metrics, reportStatus, changed }) {
  return {
    runDirectory: basename(runDirectory),
    runId,
    taskId,
    runtimeOutcome: metrics.runtimeOutcome,
    modelReportedStatus: metrics.modelReportedStatus,
    dataQuality: metrics.dataQuality,
    reportStatus,
    changed,
  };
}

/** Collect one direct-artifact TUI Run without touching sibling Runs. */
export async function collectRun(runDirectory, { root = TRAVEL_RUN_ROOT, sessionId = null, session = null, force = true } = {}) {
  const directory = await safeDirectory(runDirectory, root, "run directory");
  const artifacts = await readMetricsArtifacts(directory);
  const summary = isRecord(artifacts.summary) ? artifacts.summary : null;
  const events = artifacts.events;
  const taskId = taskIdFor(summary, session);
  // ApplicationSession names each direct Run directory with that Run's ID.
  // Include the directory binding in the pure reducer so a copied summary
  // and trajectory cannot silently be accepted under the wrong Run folder.
  const trial = { trialId: basename(directory), taskId, runId: basename(directory) };
  const metrics = collectMetrics({
    trial,
    summary,
    events,
    trajectory: artifacts.trajectory,
    errors: artifacts.errors,
  });
  const runId = metrics.runId;
  const conflictingIds = metrics.dataQuality.runIds.length > 1 || metrics.dataQuality.eventDataIsolated === true;
  const report = conflictingIds ? null : reportSource(summary, events);
  const goal = conflictingIds ? null : goalSource(summary, events, runId);
  const metadata = {
    schemaVersion: 1,
    kind: "travel_tui_run_metadata",
    collectedAt: metrics.collectedAt,
    sessionId,
    runDirectory: basename(directory),
    runId,
    originalRunId: stringOrNull(summary?.runId),
    taskId,
    goal: goal?.text ?? null,
    goalSource: goal?.source ?? null,
    actualConfigSource: "summary.json",
    config: actualConfig(summary),
    runtimeOutcome: metrics.runtimeOutcome,
    modelReportedStatus: metrics.modelReportedStatus,
    businessOutcome: metrics.businessOutcome,
    dataQuality: metrics.dataQuality,
    report: {
      status: report === null ? (conflictingIds ? "data_conflict" : "missing_source") : "written",
      source: report?.source ?? null,
    },
  };
  await safeWriteJson(join(directory, "metrics.json"), metrics, "metrics.json");
  await safeWriteJson(join(directory, "run-metadata.json"), metadata, "run-metadata.json");
  await writeManualReviewOnce(join(directory, "manual-review.md"), manualReviewText({ sessionId, runDirectory: basename(directory), runId, taskId }));
  await assertNoSymlink(join(directory, "report.md"), "report.md");
  await writeFile(join(directory, "report.md"), reportText({ sessionId, runDirectory: basename(directory), runId, taskId, metrics, summary, report, conflict: conflictingIds }), "utf8");
  return { ...safeRunResult({ runDirectory: directory, runId, taskId, metrics, reportStatus: metadata.report.status, changed: true }), reportSource: report?.source ?? null };
}

async function readSession(sessionDirectory) {
  const result = await readJson(join(sessionDirectory, "session.json"));
  const errors = result.error === null ? [] : [result.error];
  if (!isRecord(result.value)) {
    if (result.error === null) errors.push({ code: "invalid_session", path: "session.json" });
    return { session: null, errors };
  }
  if (result.value.kind !== SESSION_KIND) errors.push({ code: "invalid_session_kind", path: "session.json" });
  return { session: result.value, errors };
}

async function enumerateRunDirectories(sessionDirectory, errors) {
  const entries = await readdir(sessionDirectory, { withFileTypes: true });
  const directories = [];
  for (const entry of entries) {
    if (!RUN_DIRECTORY_PATTERN.test(entry.name)) continue;
    const path = join(sessionDirectory, entry.name);
    if (entry.isSymbolicLink()) {
      errors.push({ code: "symlink_run_directory", path: entry.name });
      continue;
    }
    if (!entry.isDirectory()) continue;
    try {
      const physical = await realpath(path);
      const physicalSession = await realpath(sessionDirectory);
      if (!pathInside(physicalSession, physical)) {
        errors.push({ code: "run_directory_escape", path: entry.name });
        continue;
      }
      directories.push(path);
    } catch (error) {
      errors.push({ code: error?.code === "ENOENT" ? "missing_run_directory" : "run_directory_error", path: entry.name });
    }
  }
  return directories.sort((a, b) => a.localeCompare(b));
}

/**
 * Collect every direct `run-*` child independently.  `state` is only used by
 * watch mode to avoid rewriting unchanged output files.
 */
export async function collectSession(sessionDirectory, { root = TRAVEL_RUN_ROOT, state = null, force = false } = {}) {
  const directory = await safeDirectory(sessionDirectory, root, "session directory");
  const sessionResult = await readSession(directory);
  const errors = [...sessionResult.errors];
  const session = sessionResult.session;
  const runDirectories = await enumerateRunDirectories(directory, errors);
  if (runDirectories.length === 0) errors.push({ code: "no_run_directories", path: basename(directory) });
  const results = [];
  for (const runDirectory of runDirectories) {
    const source = await artifactSignature(runDirectory);
    const previous = state?.get(runDirectory);
    let shouldCollect = force || previous === undefined || previous.source !== source;
    if (!shouldCollect && previous !== undefined) {
      shouldCollect = !(await requiredOutputsPresent(runDirectory));
    }
    if (shouldCollect) {
      try {
        const result = await collectRun(runDirectory, { root, sessionId: stringOrNull(session?.sessionId), session, force: true });
        results.push(result);
        state?.set(runDirectory, { source, reportStatus: result.reportStatus, result: { ...result, changed: false } });
      } catch (error) {
        errors.push({ code: "run_collection_error", path: basename(runDirectory) });
        const fallback = { runDirectory: basename(runDirectory), runId: null, taskId: taskIdFor(null, session), runtimeOutcome: null, modelReportedStatus: null, dataQuality: { status: "partial", complete: false, errors: [{ code: "run_collection_error", path: basename(runDirectory) }] }, reportStatus: "error", changed: true };
        results.push(fallback);
        state?.set(runDirectory, { source, reportStatus: "error", result: { ...fallback, changed: false } });
      }
    } else {
      results.push({ ...previous.result, changed: false });
    }
  }
  const hasPartialRun = results.some((result) => result.dataQuality.status !== "complete");
  return {
    schemaVersion: 1,
    kind: "travel_tui_collection",
    collectedAt: new Date().toISOString(),
    session: {
      sessionId: stringOrNull(session?.sessionId),
      directory: basename(directory),
      taskId: taskIdFor(null, session),
    },
    dataQuality: {
      status: errors.length > 0 || hasPartialRun ? "partial" : "complete",
      complete: errors.length === 0 && !hasPartialRun,
      errors,
    },
    runs: results,
  };
}

async function pathExists(path) {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) throw new Error("stop-file must not be a symbolic link");
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

/** Poll until stop-file/SIGTERM, then collect one final time. */
export async function watchSession(sessionDirectory, { root = TRAVEL_RUN_ROOT, intervalMs = DEFAULT_POLL_INTERVAL_MS, stopFile, readyFile, onSignal } = {}) {
  const directory = await safeDirectory(sessionDirectory, root, "session directory");
  const interval = Number.isFinite(intervalMs) ? Math.min(2000, Math.max(1000, Math.floor(intervalMs))) : DEFAULT_POLL_INTERVAL_MS;
  const stopPath = stopFile === undefined ? join(directory, "stop-file") : resolveInputPath(stopFile, directory);
  if (!pathInside(directory, stopPath)) throw new Error("stop-file must stay inside the session directory");
  const readyPath = readyFile === undefined ? join(directory, DEFAULT_READY_FILE) : resolveInputPath(readyFile, directory);
  if (!pathInside(directory, readyPath)) throw new Error("ready-file must stay inside the session directory");
  await assertNoSymlink(readyPath, DEFAULT_READY_FILE);
  const state = new Map();
  let stopping = false;
  const requestStop = () => { stopping = true; onSignal?.(); };
  process.on("SIGTERM", requestStop);
  process.on("SIGINT", requestStop);
  try {
    // The marker appears only after a first successful pass, allowing a TUI
    // wrapper to confirm that this collector is alive before opening a GUI.
    await collectSession(directory, { root, state });
    await writeFile(readyPath, `${JSON.stringify({ kind: "travel_tui_collector_ready", pid: process.pid, startedAt: new Date().toISOString() })}\n`, { encoding: "utf8", flag: "w" });
    if (await pathExists(stopPath)) stopping = true;
    while (!stopping) {
      await collectSession(directory, { root, state });
      if (await pathExists(stopPath)) stopping = true;
      if (!stopping) await delay(interval);
    }
  } finally {
    process.off("SIGTERM", requestStop);
    process.off("SIGINT", requestStop);
    try {
      const entry = await lstat(readyPath);
      if (entry.isSymbolicLink()) throw new Error(`${DEFAULT_READY_FILE} must not be a symbolic link`);
      await unlink(readyPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return collectSession(directory, { root, force: true });
}

function parseOptionValue(args, index, name) {
  const current = args[index];
  if (current === name) return { value: args[index + 1], next: index + 2 };
  const prefix = `${name}=`;
  if (current.startsWith(prefix)) return { value: current.slice(prefix.length), next: index + 1 };
  return null;
}

export function parseCliArgs(argv) {
  const args = [...argv];
  let command = args.shift() ?? "help";
  if (command === "--watch") command = "watch";
  if (command === "--finalize") command = "collect";
  const options = { command, root: TRAVEL_RUN_ROOT, sessionDirectory: null, stopFile: undefined, readyFile: undefined, intervalMs: DEFAULT_POLL_INTERVAL_MS };
  for (let index = 0; index < args.length;) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") return { ...options, command: "help" };
    if (arg === "--no-stdin") { index += 1; continue; }
    let parsed = parseOptionValue(args, index, "--session-dir");
    if (parsed) { options.sessionDirectory = parsed.value; index = parsed.next; continue; }
    parsed = parseOptionValue(args, index, "--root");
    if (parsed) { options.root = parsed.value; index = parsed.next; continue; }
    parsed = parseOptionValue(args, index, "--stop-file");
    if (parsed) { options.stopFile = parsed.value; index = parsed.next; continue; }
    parsed = parseOptionValue(args, index, "--ready-file");
    if (parsed) { options.readyFile = parsed.value; index = parsed.next; continue; }
    parsed = parseOptionValue(args, index, "--interval-ms");
    if (parsed) { options.intervalMs = Number(parsed.value); index = parsed.next; continue; }
    throw new Error(`unknown option: ${arg}`);
  }
  if (options.command !== "help" && (typeof options.sessionDirectory !== "string" || options.sessionDirectory.length === 0)) {
    throw new Error(`${options.command} requires --session-dir`);
  }
  if (options.command !== "collect" && options.command !== "watch" && options.command !== "help") throw new Error(`unknown command: ${command}`);
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseCliArgs(argv);
  if (options.command === "help") {
    process.stdout.write("Usage: node scripts/travel/tui-collector.mjs collect|watch --session-dir runs/travel/tui-<id> [--root <root>] [--stop-file <path>] [--interval-ms 1000..2000]\n");
    return;
  }
  if (options.command === "collect") {
    const result = await collectSession(options.sessionDirectory, { root: options.root });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  // Watch is deliberately silent on stdout so it can be supervised beside a
  // TUI.  Diagnostics are represented in per-run files; only fatal errors
  // reach the CLI catch block below (stderr).
  await watchSession(options.sessionDirectory, { root: options.root, stopFile: options.stopFile, readyFile: options.readyFile, intervalMs: options.intervalMs });
}

if (process.argv[1] !== undefined && pathKey(process.argv[1]) === pathKey(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
