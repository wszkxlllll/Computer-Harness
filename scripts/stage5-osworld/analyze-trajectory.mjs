#!/usr/bin/env node

/**
 * Offline Stage 5 trajectory statistics.
 *
 * This script only derives facts already present in trajectory.jsonl.  It does
 * not add runtime events, read screenshots into model context, or classify a
 * step as productive.  Consecutive identical action signatures are reported
 * as candidates for later review, not as ground-truth failures.  A rejected
 * ToolCall is counted as a GUI rejection only when an action.proposed event
 * links its callId; otherwise it remains non-GUI-or-unlinked rather than being
 * guessed from a tool name.
 */

import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

function parseArgs(argv) {
  const roots = [];
  let output;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      const value = argv[++i];
      if (!value) throw new Error("--root requires a directory or trajectory file");
      roots.push(value);
    } else if (arg === "--output") {
      output = argv[++i];
      if (!output) throw new Error("--output requires a JSON path");
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write("Usage: node scripts/stage5-osworld/analyze-trajectory.mjs --root <runs-dir> [--root <runs-dir>] [--output <report.json>]\n");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (roots.length === 0) throw new Error("at least one --root is required");
  return { roots, output };
}

async function collectTrajectories(input) {
  const info = await stat(input);
  if (info.isFile()) return basename(input) === "trajectory.jsonl" ? [resolve(input)] : [];
  const entries = await readdir(input, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "cache" || entry.name === "assets") continue;
    const child = join(input, entry.name);
    if (entry.isDirectory()) result.push(...await collectTrajectories(child));
    else if (entry.isFile() && entry.name === "trajectory.jsonl") result.push(resolve(child));
  }
  return result;
}

async function readEvents(filePath) {
  const text = await readFile(filePath, "utf8");
  const events = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`${filePath}:${index + 1} is not valid JSON: ${error.message}`);
    }
    if (!value || typeof value !== "object" || typeof value.type !== "string") {
      throw new Error(`${filePath}:${index + 1} is not a runtime event`);
    }
    events.push(value);
  }
  return events;
}

function timestamp(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : undefined;
}

function duration(start, end) {
  const a = timestamp(start);
  const b = timestamp(end);
  return a === undefined || b === undefined || b < a ? undefined : b - a;
}

function actionSignature(action) {
  if (!action || typeof action !== "object") return "invalid";
  const copy = { ...action };
  delete copy.actionId;
  delete copy.basedOn;
  return JSON.stringify(copy);
}

function sumUsage(events) {
  const usage = {};
  for (const event of events) {
    const next = event.type === "model.response.received" ? event.turn?.usage : undefined;
    if (!next || typeof next !== "object") continue;
    for (const key of ["inputTokens", "outputTokens", "totalTokens"]) {
      if (Number.isInteger(next[key]) && next[key] >= 0) {
        usage[key] = (usage[key] ?? 0) + next[key];
      }
    }
  }
  return Object.keys(usage).length === 0 ? null : usage;
}

function adjacentRepeats(actions) {
  let previous;
  let currentLength = 0;
  let repeatActions = 0;
  let repeatSegments = 0;
  let longestSegment = 0;
  for (const action of actions) {
    const signature = actionSignature(action);
    if (signature === previous) {
      currentLength += 1;
      repeatActions += 1;
    } else {
      if (currentLength > 1) repeatSegments += 1;
      longestSegment = Math.max(longestSegment, currentLength);
      previous = signature;
      currentLength = 1;
    }
  }
  if (currentLength > 1) repeatSegments += 1;
  longestSegment = Math.max(longestSegment, currentLength);
  return { repeatActions, repeatSegments, longestSegment };
}

function latencyMetrics(events) {
  const providerLatencies = [];
  const actionLatencies = [];
  const pendingProviders = [];
  const pendingActions = [];
  for (const event of events) {
    if (event.type === "model.request.started") pendingProviders.push(timestamp(event.occurredAt));
    if (event.type === "model.response.received" || event.type === "model.request.failed") {
      const start = pendingProviders.shift();
      const value = duration(start === undefined ? undefined : new Date(start).toISOString(), event.occurredAt);
      if (value !== undefined) providerLatencies.push(value);
    }
    if (event.type === "action.execution.started") pendingActions.push(timestamp(event.occurredAt));
    if (event.type === "action.execution.completed" || event.type === "action.execution.failed") {
      const start = pendingActions.shift();
      const value = duration(start === undefined ? undefined : new Date(start).toISOString(), event.occurredAt);
      if (value !== undefined) actionLatencies.push(value);
    }
  }
  const summary = (values) => values.length === 0 ? null : {
    count: values.length,
    totalMs: values.reduce((sum, value) => sum + value, 0),
    averageMs: values.reduce((sum, value) => sum + value, 0) / values.length,
    maxMs: Math.max(...values),
  };
  return { provider: summary(providerLatencies), computerAction: summary(actionLatencies) };
}

function summarize(filePath, events) {
  const started = events.find((event) => event.type === "run.started");
  const finished = [...events].reverse().find((event) => event.type === "run.finished");
  const actions = events.filter((event) => event.type === "action.execution.started").map((event) => event.action);
  const computerCallIds = new Set(
    events
      .filter((event) => event.type === "action.proposed" && typeof event.callId === "string")
      .map((event) => event.callId),
  );
  const rejectedCalls = events.filter((event) => event.type === "tool.call.rejected");
  const computerToolCallRejected = rejectedCalls.filter((event) => computerCallIds.has(event.callId)).length;
  const budgetRejected = rejectedCalls.filter((event) => /action budget exhausted/iu.test(event.reason ?? "")).length;
  const argumentRejected = rejectedCalls.filter((event) => /invalid arguments|invalid GUI action/iu.test(event.reason ?? "")).length;
  const actionReceipts = events.filter((event) => event.type === "action.execution.completed" || event.type === "action.execution.failed");
  return {
    runId: events.find((event) => typeof event.runId === "string")?.runId ?? null,
    source: filePath,
    eventCount: events.length,
    outcome: finished?.outcome ?? null,
    runtimeWallTimeMs: duration(started?.occurredAt, finished?.occurredAt) ?? null,
    actionAttempts: actions.length,
    actionCompleted: actionReceipts.filter((event) => event.type === "action.execution.completed").length,
    actionReceiptFailedOrRefused: actionReceipts.filter((event) => event.type === "action.execution.failed").length,
    toolCallRejected: events.filter((event) => event.type === "tool.call.rejected").length,
    budgetRejected,
    budgetRuntimeErrors: events.filter((event) => event.type === "runtime.error" && event.category === "budget").length,
    argumentRejected,
    otherRejected: rejectedCalls.length - budgetRejected - argumentRejected,
    toolExecutionFailed: events.filter((event) => event.type === "tool.call.failed").length,
    computerToolCallRejected,
    nonComputerOrUnlinkedToolCallRejected: rejectedCalls.length - computerToolCallRejected,
    providerRequests: events.filter((event) => event.type === "model.request.started").length,
    providerFailures: events.filter((event) => event.type === "model.request.failed").length,
    usage: sumUsage(events),
    repeatedActions: adjacentRepeats(actions),
    latency: latencyMetrics(events),
    evaluator: null,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const files = [...new Set((await Promise.all(options.roots.map((root) => collectTrajectories(resolve(root))))).flat())].sort();
  const runs = [];
  for (const filePath of files) runs.push(summarize(filePath, await readEvents(filePath)));
  const report = {
    schema: "stage5-trajectory-statistics-v1",
    generatedAt: new Date().toISOString(),
    sourceRoots: options.roots.map((root) => resolve(root)),
    semantics: {
      repeatedActions: "adjacent identical action signatures; candidate only, not ground-truth uselessness",
      evaluator: "not inferred from RuntimeEvent; attach an external evaluator result separately",
      visualChange: "not computed without an explicit screenshot-analysis input",
    },
    runs,
    totals: {
      runCount: runs.length,
      actionAttempts: runs.reduce((sum, run) => sum + run.actionAttempts, 0),
      providerRequests: runs.reduce((sum, run) => sum + run.providerRequests, 0),
      providerFailures: runs.reduce((sum, run) => sum + run.providerFailures, 0),
      toolCallRejected: runs.reduce((sum, run) => sum + run.toolCallRejected, 0),
      budgetRejected: runs.reduce((sum, run) => sum + run.budgetRejected, 0),
      budgetRuntimeErrors: runs.reduce((sum, run) => sum + run.budgetRuntimeErrors, 0),
      argumentRejected: runs.reduce((sum, run) => sum + run.argumentRejected, 0),
      toolExecutionFailed: runs.reduce((sum, run) => sum + run.toolExecutionFailed, 0),
      repeatedActions: runs.reduce((sum, run) => sum + run.repeatedActions.repeatActions, 0),
    },
  };
  if (options.output) {
    const output = resolve(options.output);
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${output}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
