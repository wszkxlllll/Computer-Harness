#!/usr/bin/env node

/**
 * Bounded, offline metrics for one travel trial.
 *
 * This module intentionally reads only the trial manifest, the Runtime
 * summary, and the Runtime trajectory.  It never reads provider exchanges,
 * screenshots, goal text, manual-review.md, or action arguments.  The output
 * is evidence, not an evaluator: businessOutcome remains manual_pending.
 */

import { lstat, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const TRAVEL_RUN_ROOT = resolve(REPO_ROOT, "runs", "travel");

const GUI_TOOL_NAMES = new Set([
  "click",
  "double_click",
  "right_click",
  "type",
  "keypress",
  "hotkey",
  "scroll",
  "drag",
  "wait",
]);

const CONTEXT_BLOCK_NAMES = ["system", "goal", "tools", "plan", "memory"];
const MEMORY_RETRIEVAL_DEGRADED = new Set(["unavailable", "timed_out"]);
const MISSING = Symbol("missing");

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringOrNull(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function finiteNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function pathKey(value) {
  // The production target is Windows, where path comparison is
  // case-insensitive.  Lower-casing also makes the lexical check stable in
  // tests without ever allowing a `..` segment to pass through.
  return resolve(value).replaceAll("\\", "/").toLowerCase();
}

function pathInside(root, target) {
  const rootKey = pathKey(root);
  const targetKey = pathKey(target);
  const child = relative(rootKey, targetKey);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function resolveTrialInput(value, root) {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0") || value.includes("\r") || value.includes("\n")) {
    throw new Error("trial directory is invalid");
  }
  if (isAbsolute(value)) return resolve(value);
  // Accept both a repo-relative `runs/travel/<id>` and an id relative to the
  // configured root.  The first candidate is useful to the travel CLI; the
  // second keeps tests independent of cwd.
  const cwdCandidate = resolve(value);
  if (pathInside(root, cwdCandidate)) return cwdCandidate;
  return resolve(root, value);
}

async function resolveSafeTrialDirectory(trialDir, configuredRoot) {
  const root = resolve(configuredRoot);
  const directory = resolveTrialInput(trialDir, root);
  if (!pathInside(root, directory)) {
    throw new Error("trial directory must stay inside the travel run root");
  }
  let rootPhysical = root;
  let directoryPhysical = directory;
  try { rootPhysical = await realpath(root); } catch { /* the directory check below reports a missing root */ }
  try { directoryPhysical = await realpath(directory); } catch { /* stat below reports a missing trial */ }
  if (!pathInside(rootPhysical, directoryPhysical)) {
    throw new Error("trial directory resolves outside the travel run root");
  }
  const directoryStat = await stat(directory);
  if (!directoryStat.isDirectory()) throw new Error("trial directory is not a directory");
  return directory;
}

async function ensureOutputPathIsSafe(outputPath) {
  try {
    const existing = await lstat(outputPath);
    if (existing.isSymbolicLink()) throw new Error("metrics.json must not be a symbolic link");
    if (existing.isDirectory()) throw new Error("metrics.json must not be a directory");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

function addError(errors, code, path, extra = {}) {
  errors.push({ code, path, ...extra });
}

async function readJsonFile(filePath, relativePath, errors, required = true) {
  try {
    const entry = await lstat(filePath);
    if (entry.isSymbolicLink()) {
      addError(errors, "symlink_file", relativePath);
      return MISSING;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      addError(errors, "read_error", relativePath);
      return MISSING;
    }
  }
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      if (required) addError(errors, "missing_file", relativePath);
      return MISSING;
    }
    addError(errors, "read_error", relativePath);
    return MISSING;
  }
  try {
    return JSON.parse(text);
  } catch {
    addError(errors, "invalid_json", relativePath);
    return MISSING;
  }
}

async function readTrajectory(filePath, errors, relativePath = "runtime/trajectory.jsonl") {
  try {
    const entry = await lstat(filePath);
    if (entry.isSymbolicLink()) {
      addError(errors, "symlink_file", relativePath);
  return { present: false, events: [], parseErrors: 0, path: relativePath };
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      addError(errors, "read_error", relativePath);
      return { present: false, events: [], parseErrors: 0, path: relativePath };
    }
  }
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") addError(errors, "missing_file", relativePath);
    else addError(errors, "read_error", relativePath);
      return { present: false, events: [], parseErrors: 0, path: relativePath };
  }
  const events = [];
  let parseErrors = 0;
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0) continue;
    try {
      const value = JSON.parse(line);
      if (!isRecord(value) || typeof value.type !== "string") {
        parseErrors += 1;
        addError(errors, "invalid_event", relativePath, { line: index + 1 });
      } else {
        events.push(value);
      }
    } catch {
      parseErrors += 1;
      const isLastPhysicalLine = index === lines.length - 1 && !text.endsWith("\n") && !text.endsWith("\r");
      addError(errors, isLastPhysicalLine ? "truncated_jsonl" : "invalid_jsonl", relativePath, { line: index + 1 });
    }
  }
  const sequenceValues = events.map((event) => event.sequence);
  const hasSequence = sequenceValues.some((value) => Number.isSafeInteger(value));
  if (hasSequence) {
    const seen = new Set();
    const sorted = [];
    for (const value of sequenceValues) {
      if (!Number.isSafeInteger(value)) {
        addError(errors, "invalid_sequence", relativePath);
        continue;
      }
      if (seen.has(value)) addError(errors, "duplicate_sequence", relativePath, { sequence: value });
      seen.add(value);
      sorted.push(value);
    }
    sorted.sort((a, b) => a - b);
    if (sorted.length > 0 && sorted[0] !== 0) addError(errors, "sequence_gap", relativePath, { from: 0, to: sorted[0] });
    for (let index = 1; index < sorted.length; index += 1) {
      if (sorted[index] > sorted[index - 1] + 1) {
        addError(errors, "sequence_gap", relativePath, { from: sorted[index - 1], to: sorted[index] });
      }
    }
  }
  return { present: true, events, parseErrors, path: relativePath };
}

function parseTime(value) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function durationMs(start, end) {
  const a = parseTime(start);
  const b = parseTime(end);
  return a === null || b === null || b < a ? null : b - a;
}

function sumKnown(values) {
  const known = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  return known.length === 0 ? null : known.reduce((total, value) => total + value, 0);
}

function summaryForDurations(values) {
  const known = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (known.length === 0) return { count: 0, totalMs: null, averageMs: null, maxMs: null };
  const totalMs = known.reduce((total, value) => total + value, 0);
  return { count: known.length, totalMs, averageMs: totalMs / known.length, maxMs: Math.max(...known) };
}

function increment(map, key, amount = 1) {
  if (typeof key !== "string" || key.length === 0) return;
  map[key] = (map[key] ?? 0) + amount;
}

function incrementBoolean(map, key, amount = 1) {
  map[key ? "true" : "false"] = (map[key ? "true" : "false"] ?? 0) + amount;
}

function sortedEntries(map) {
  return Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)));
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function safeTrialMetadata(trial) {
  if (!isRecord(trial)) return null;
  const metadata = {};
  for (const key of ["trialId", "taskId", "familyId", "variantId", "manifestId", "split", "exposureMarker", "anchorDate"]) {
    const value = trial[key];
    if (typeof value === "string") metadata[key] = value;
  }
  if (typeof trial.exposed === "boolean") metadata.exposed = trial.exposed;
  return metadata;
}

function eventRunIds(events) {
  const values = [];
  for (const event of events) {
    if (typeof event.runId === "string") values.push(event.runId);
    if (isRecord(event.observation) && typeof event.observation.runId === "string") values.push(event.observation.runId);
    const trace = event.contextBudget?.trace;
    if (isRecord(trace) && typeof trace.runId === "string") values.push(trace.runId);
  }
  return uniqueStrings(values);
}

function addUsage(total, usage) {
  if (!isRecord(usage)) return;
  for (const key of ["inputTokens", "outputTokens", "totalTokens", "cacheReadTokens"]) {
    const value = finiteNonNegativeInteger(usage[key]);
    if (value !== null) total[key] = (total[key] ?? 0) + value;
  }
}

function normalizeUsage(total, fallback) {
  const result = {};
  for (const key of ["inputTokens", "outputTokens", "totalTokens", "cacheReadTokens"]) {
    result[key] = total[key] ?? (finiteNonNegativeInteger(fallback?.[key]) ?? null);
  }
  return result;
}

function createRequestMetrics(events) {
  const startsById = new Map();
  const records = [];
  const unmatched = { responses: 0, failures: 0 };
  let started = 0;
  let responses = 0;
  let failures = 0;
  for (const event of events) {
    if (event.type === "model.request.started") {
      started += 1;
      const requestId = stringOrNull(event.requestId);
      const record = { requestId, outcome: "pending", durationMs: null };
      records.push(record);
      if (requestId !== null) {
        const queue = startsById.get(requestId) ?? [];
        queue.push({ event, record });
        startsById.set(requestId, queue);
      }
    } else if (event.type === "model.response.received" || event.type === "model.request.failed") {
      const isFailure = event.type === "model.request.failed";
      if (isFailure) failures += 1; else responses += 1;
      const requestId = stringOrNull(event.requestId);
      const queue = requestId === null ? undefined : startsById.get(requestId);
      const pending = queue?.shift();
      if (pending === undefined) {
        unmatched[isFailure ? "failures" : "responses"] += 1;
      } else {
        pending.record.outcome = isFailure ? "failed" : "response";
        pending.record.durationMs = durationMs(pending.event.occurredAt, event.occurredAt);
      }
    }
  }
  const durations = records.filter((record) => record.outcome !== "pending").map((record) => record.durationMs);
  return {
    started,
    responses,
    failures,
    unmatched,
    durations: summaryForDurations(durations),
    records,
  };
}

function createActionMetrics(events) {
  const proposalsByCall = new Map();
  const startsByAction = new Map();
  const records = [];
  let proposed = 0;
  let started = 0;
  let completed = 0;
  let refused = 0;
  let failed = 0;
  let cancelled = 0;
  let rejected = 0;
  for (const event of events) {
    if (event.type === "action.proposed") {
      proposed += 1;
      const callId = stringOrNull(event.callId);
      const actionId = stringOrNull(event.action?.actionId);
      if (callId !== null && actionId !== null) proposalsByCall.set(callId, actionId);
    } else if (event.type === "action.execution.started") {
      started += 1;
      const actionId = stringOrNull(event.action?.actionId);
      const record = { actionId, outcome: "pending", durationMs: null };
      records.push(record);
      if (actionId !== null) {
        const queue = startsByAction.get(actionId) ?? [];
        queue.push({ event, record });
        startsByAction.set(actionId, queue);
      }
    } else if (event.type === "action.execution.completed" || event.type === "action.execution.failed") {
      const receipt = event.receipt;
      const actionId = stringOrNull(receipt?.actionId);
      const status = stringOrNull(receipt?.status);
      const queue = actionId === null ? undefined : startsByAction.get(actionId);
      const pending = queue?.shift();
      if (pending !== undefined) pending.record.durationMs = durationMs(pending.event.occurredAt, event.occurredAt);
      if (event.type === "action.execution.completed") {
        completed += 1;
        if (pending !== undefined) pending.record.outcome = "completed";
      } else if (status === "refused") {
        refused += 1;
        if (pending !== undefined) pending.record.outcome = "refused";
      } else if (status === "cancelled") {
        cancelled += 1;
        if (pending !== undefined) pending.record.outcome = "cancelled";
      } else {
        failed += 1;
        if (pending !== undefined) pending.record.outcome = "failed";
      }
    } else if (event.type === "tool.call.rejected" && typeof event.callId === "string" && proposalsByCall.has(event.callId)) {
      rejected += 1;
    }
  }
  const durations = records.filter((record) => record.outcome !== "pending").map((record) => record.durationMs);
  return {
    proposed,
    started,
    completed,
    refused,
    failed,
    cancelled,
    rejected,
    durations: summaryForDurations(durations),
    records,
    proposalsByCall,
  };
}

function createErrorMetrics(events) {
  const byCategory = {};
  const byCode = {};
  let runtime = 0;
  let provider = 0;
  let toolFailed = 0;
  let toolRejected = 0;
  for (const event of events) {
    if (event.type === "runtime.error") {
      runtime += 1;
      increment(byCategory, event.category);
    } else if (event.type === "model.request.failed") {
      provider += 1;
      increment(byCategory, event.category);
      increment(byCode, event.code);
    } else if (event.type === "tool.call.failed") {
      toolFailed += 1;
      increment(byCode, event.result?.error?.code);
    } else if (event.type === "tool.call.rejected") {
      toolRejected += 1;
    }
  }
  return {
    runtime,
    provider,
    toolFailed,
    toolRejected,
    total: runtime + provider + toolFailed + toolRejected,
    byCategory: sortedEntries(byCategory),
    byCode: sortedEntries(byCode),
  };
}

function isGuiCall(call) {
  return isRecord(call) && typeof call.name === "string" && GUI_TOOL_NAMES.has(call.name);
}

function createBatchMetrics(events) {
  const candidates = [];
  let modelTurns = 0;
  let multiCallTurns = 0;
  for (const event of events) {
    if (event.type !== "model.response.received" || event.turn?.type !== "tool_calls" || !Array.isArray(event.turn.calls)) continue;
    modelTurns += 1;
    const guiCalls = event.turn.calls.filter(isGuiCall);
    if (event.turn.calls.length > 1) multiCallTurns += 1;
    if (guiCalls.length > 1) {
      // The candidate is deliberately only a candidate.  This output does
      // not infer approval, execution, or any request saving.
      candidates.push({
        modelTurnEventId: stringOrNull(event.eventId),
        requestId: stringOrNull(event.requestId),
        guiCallCount: guiCalls.length,
        callIds: uniqueStrings(guiCalls.map((call) => call.id)),
        approved: null,
      });
    }
  }
  return {
    modelTurnsWithToolCalls: modelTurns,
    multiCallModelTurns: multiCallTurns,
    guiModelTurnCandidates: candidates.length,
    candidates,
    semantics: "GUI-only multi-call model turns are candidates; approval and savings are unknown.",
  };
}

function createContextMetrics(events) {
  const traces = [];
  const discardedByReason = {};
  const fixedBlocks = Object.fromEntries(CONTEXT_BLOCK_NAMES.map((name) => [name, { observed: 0, included: 0, estimatedTokens: 0 }]));
  const memory = {
    renderedAdmittedFactIds: [],
    renderedRevalidationFactIds: [],
    selectedAdmittedFactIds: [],
    selectedRevalidationFactIds: [],
    excludedIds: [],
    omittedIds: [],
    admittedCount: 0,
    revalidationCount: 0,
    excludedCount: 0,
    omittedCount: 0,
    excludedByReason: {},
    omittedByReason: {},
    retrievalMethod: {},
    retrievalSemanticStatus: {},
    retrievalDegradedCount: 0,
    retrievalDisabledCount: 0,
    retrievalNotNeededCount: 0,
    retrievalFallbackCount: 0,
    retrievalStateUnstableCount: 0,
  };
  const tokenSums = {
    estimatedInputTokens: [],
    estimatedFixedTextTokens: [],
    estimatedHistoryTextTokens: [],
    estimatedToolSchemaTokens: [],
    estimatedMemoryTokens: [],
    estimatedMonitorGuidanceTokens: [],
    historyEstimatedTokens: [],
    memoryEstimatedTokens: [],
    preparedEstimatedTextTokens: [],
    imageCount: [],
  };
  const observationIncluded = { true: 0, false: 0 };
  const guidanceIncluded = { true: 0, false: 0, omittedByBudget: 0 };
  const stablePrefixHashes = [];
  let selectedEventCount = 0;
  let projectedEventCount = 0;
  let discardedEventCount = 0;
  let authoritativeUserEventCount = 0;
  for (const event of events) {
    if (event.type !== "model.request.started") continue;
    const budget = isRecord(event.contextBudget) ? event.contextBudget : null;
    const trace = isRecord(budget?.trace) ? budget.trace : null;
    if (trace === null && budget === null) continue;
    traces.push({ event, budget, trace });
    if (budget !== null) {
      for (const key of ["estimatedInputTokens", "estimatedFixedTextTokens", "estimatedHistoryTextTokens", "estimatedToolSchemaTokens", "estimatedMemoryTokens", "estimatedMonitorGuidanceTokens", "imageCount"]) {
        if (typeof budget[key] === "number" && Number.isFinite(budget[key])) tokenSums[key].push(budget[key]);
      }
      if (typeof budget.monitorGuidanceIncluded === "boolean") incrementBoolean(guidanceIncluded, budget.monitorGuidanceIncluded);
    }
    if (trace === null) continue;
    if (typeof trace.stablePrefixHash === "string") stablePrefixHashes.push(trace.stablePrefixHash);
    if (Array.isArray(trace.selectedEventIds)) selectedEventCount += trace.selectedEventIds.length;
    if (Array.isArray(trace.projectedEventIds)) projectedEventCount += trace.projectedEventIds.length;
    if (Array.isArray(trace.discardedEvents)) {
      discardedEventCount += trace.discardedEvents.length;
      for (const discarded of trace.discardedEvents) increment(discardedByReason, discarded?.reason);
    }
    if (Array.isArray(trace.authoritativeUserEventIds)) authoritativeUserEventCount += trace.authoritativeUserEventIds.length;
    if (typeof trace.observationIncluded === "boolean") incrementBoolean(observationIncluded, trace.observationIncluded);
    if (typeof trace.monitorGuidanceIncluded === "boolean") incrementBoolean(guidanceIncluded, trace.monitorGuidanceIncluded);
    if (trace.monitorGuidanceOmittedReason === "budget") guidanceIncluded.omittedByBudget += 1;
    if (Array.isArray(trace.fixedBlocks)) {
      for (const block of trace.fixedBlocks) {
        if (!isRecord(block) || typeof block.name !== "string" || !fixedBlocks[block.name]) continue;
        const target = fixedBlocks[block.name];
        target.observed += 1;
        if (block.included === true) target.included += 1;
        if (typeof block.estimatedTokens === "number" && Number.isFinite(block.estimatedTokens)) target.estimatedTokens += block.estimatedTokens;
      }
    }
    for (const key of ["historyEstimatedTokens", "memoryEstimatedTokens"]) {
      if (typeof trace[key] === "number" && Number.isFinite(trace[key])) tokenSums[key].push(trace[key]);
    }
    const estimate = trace.preparedRequest?.estimate;
    if (isRecord(estimate)) {
      if (typeof estimate.estimatedTextTokens === "number" && Number.isFinite(estimate.estimatedTextTokens)) tokenSums.preparedEstimatedTextTokens.push(estimate.estimatedTextTokens);
      if (typeof estimate.imageCount === "number" && Number.isFinite(estimate.imageCount)) tokenSums.imageCount.push(estimate.imageCount);
    }
    const selection = trace.memorySelection;
    if (isRecord(selection)) {
      const admitted = Array.isArray(selection.admittedFactIds) ? selection.admittedFactIds : [];
      const revalidation = Array.isArray(selection.revalidationFactIds) ? selection.revalidationFactIds : [];
      const selectedAdmitted = Array.isArray(selection.selectedAdmittedFactIds) ? selection.selectedAdmittedFactIds : [];
      const selectedRevalidation = Array.isArray(selection.selectedRevalidationFactIds) ? selection.selectedRevalidationFactIds : [];
      memory.admittedCount += admitted.length;
      memory.revalidationCount += revalidation.length;
      memory.selectedAdmittedFactIds.push(...selectedAdmitted.filter((id) => typeof id === "string"));
      memory.selectedRevalidationFactIds.push(...selectedRevalidation.filter((id) => typeof id === "string"));
      memory.renderedAdmittedFactIds.push(...admitted.filter((id) => typeof id === "string"));
      memory.renderedRevalidationFactIds.push(...revalidation.filter((id) => typeof id === "string"));
      const excluded = Array.isArray(selection.excluded) ? selection.excluded : [];
      memory.excludedCount += excluded.length;
      for (const item of excluded) {
        if (typeof item?.id === "string") memory.excludedIds.push(item.id);
        increment(memory.excludedByReason, item?.reason);
      }
      const omitted = Array.isArray(selection.omitted) ? selection.omitted : [];
      memory.omittedCount += omitted.length;
      for (const item of omitted) {
        if (typeof item?.id === "string") memory.omittedIds.push(item.id);
        increment(memory.omittedByReason, item?.reason);
      }
    }
    const retrieval = trace.memoryRetrieval;
    if (isRecord(retrieval)) {
      increment(memory.retrievalMethod, retrieval.method);
      increment(memory.retrievalSemanticStatus, retrieval.semanticStatus);
      if (retrieval.semanticStatus === "disabled") memory.retrievalDisabledCount += 1;
      if (retrieval.semanticStatus === "not_needed") memory.retrievalNotNeededCount += 1;
      if (MEMORY_RETRIEVAL_DEGRADED.has(retrieval.semanticStatus) && retrieval.method === "hybrid") memory.retrievalDegradedCount += 1;
      if (retrieval.fallback === true || retrieval.degraded === true) memory.retrievalFallbackCount += 1;
      if (retrieval.stateStable === false) memory.retrievalStateUnstableCount += 1;
    }
  }
  const prefixSequence = uniqueStrings(stablePrefixHashes);
  let stablePrefixHashChanges = stablePrefixHashes.length > 0 ? 0 : null;
  for (let index = 1; index < stablePrefixHashes.length; index += 1) {
    if (stablePrefixHashes[index] !== stablePrefixHashes[index - 1]) stablePrefixHashChanges = (stablePrefixHashChanges ?? 0) + 1;
  }
  const hasTrace = traces.length > 0;
  const hasGuidanceEvidence = hasTrace || traces.some(({ budget }) => typeof budget?.monitorGuidanceIncluded === "boolean");
  const hasMemorySelection = traces.some(({ trace }) => isRecord(trace?.memorySelection));
  const hasMemoryRetrieval = traces.some(({ trace }) => isRecord(trace?.memoryRetrieval));
  const blockEvidence = hasTrace
    ? fixedBlocks
    : Object.fromEntries(CONTEXT_BLOCK_NAMES.map((name) => [name, null]));
  const memoryEvidence = hasMemorySelection ? {
    renderedAdmittedFactIds: uniqueStrings(memory.renderedAdmittedFactIds),
    renderedRevalidationFactIds: uniqueStrings(memory.renderedRevalidationFactIds),
    selectedAdmittedFactIds: uniqueStrings(memory.selectedAdmittedFactIds),
    selectedRevalidationFactIds: uniqueStrings(memory.selectedRevalidationFactIds),
    excludedIds: uniqueStrings(memory.excludedIds),
    omittedIds: uniqueStrings(memory.omittedIds),
    admittedCount: memory.admittedCount,
    revalidationCount: memory.revalidationCount,
    excludedCount: memory.excludedCount,
    omittedCount: memory.omittedCount,
    excludedByReason: sortedEntries(memory.excludedByReason),
    omittedByReason: sortedEntries(memory.omittedByReason),
  } : null;
  const retrievalEvidence = hasMemoryRetrieval ? {
    retrievalMethod: sortedEntries(memory.retrievalMethod),
    retrievalSemanticStatus: sortedEntries(memory.retrievalSemanticStatus),
    retrievalDegradedCount: memory.retrievalDegradedCount,
    retrievalDisabledCount: memory.retrievalDisabledCount,
    retrievalNotNeededCount: memory.retrievalNotNeededCount,
    retrievalFallbackCount: memory.retrievalFallbackCount,
    retrievalStateUnstableCount: memory.retrievalStateUnstableCount,
  } : null;
  return {
    traceCount: traces.length,
    selectedEventCount: hasTrace ? selectedEventCount : null,
    projectedEventCount: hasTrace ? projectedEventCount : null,
    discardedEventCount: hasTrace ? discardedEventCount : null,
    discardedByReason: hasTrace ? sortedEntries(discardedByReason) : null,
    authoritativeUserEventCount: hasTrace ? authoritativeUserEventCount : null,
    estimatedTokens: Object.fromEntries(Object.entries(tokenSums).map(([key, values]) => [key, sumKnown(values)])),
    stablePrefixHashes: stablePrefixHashes.length > 0 ? prefixSequence : null,
    stablePrefixHashDistinct: stablePrefixHashes.length > 0 ? prefixSequence.length : null,
    stablePrefixHashChanges,
    cacheHit: null,
    observationIncluded: hasTrace ? observationIncluded : null,
    monitorGuidanceIncluded: hasGuidanceEvidence ? guidanceIncluded : null,
    fixedBlocks: blockEvidence,
    planIncludedRequests: hasTrace ? (fixedBlocks.plan?.included ?? 0) : null,
    memory: hasMemorySelection || hasMemoryRetrieval
      ? { ...(memoryEvidence ?? {}), ...(retrievalEvidence ?? {}) }
      : null,
  };
}

function createToolModuleMetrics(events, actionMetrics) {
  const modules = {
    planning: { calls: 0, callsByName: {}, terminalCompleted: 0, terminalFailed: 0, terminalRejected: 0, updates: 0, updatesByOperation: {}, taskIds: [] },
    memory: { calls: 0, callsByName: {}, terminalCompleted: 0, terminalFailed: 0, terminalRejected: 0, updates: 0, updatesByOperation: {}, factOrEntityIds: [] },
  };
  const callModules = new Map();
  for (const event of events) {
    if (event.type === "tool.call.received") {
      const name = stringOrNull(event.call?.name);
      const module = name?.startsWith("task_") ? modules.planning : name?.startsWith("memory_") ? modules.memory : null;
      if (module !== null) {
        module.calls += 1;
        increment(module.callsByName, name);
        if (typeof event.call?.id === "string") callModules.set(event.call.id, module);
      }
    } else if (event.type === "tool.call.completed" || event.type === "tool.call.failed") {
      const callId = stringOrNull(event.result?.callId);
      const module = callId === null ? null : callModules.get(callId);
      if (module !== null && module !== undefined) {
        if (event.type === "tool.call.completed") module.terminalCompleted += 1;
        else module.terminalFailed += 1;
      }
    } else if (event.type === "tool.call.rejected") {
      const module = typeof event.callId === "string" ? callModules.get(event.callId) : undefined;
      if (module !== undefined) module.terminalRejected += 1;
    } else if (event.type === "planning.task.updated") {
      modules.planning.updates += 1;
      const operation = event.mutation?.operation;
      increment(modules.planning.updatesByOperation, operation);
      if (typeof event.mutation?.task?.id === "string") modules.planning.taskIds.push(event.mutation.task.id);
    } else if (event.type === "memory.updated") {
      modules.memory.updates += 1;
      const operation = event.mutation?.operation;
      increment(modules.memory.updatesByOperation, operation);
      const id = event.mutation?.fact?.id ?? event.mutation?.entity?.id ?? event.mutation?.factId ?? event.mutation?.entityId;
      if (typeof id === "string") modules.memory.factOrEntityIds.push(id);
    }
  }
  return {
    planning: {
      ...modules.planning,
      callsByName: sortedEntries(modules.planning.callsByName),
      updatesByOperation: sortedEntries(modules.planning.updatesByOperation),
      taskIds: uniqueStrings(modules.planning.taskIds),
    },
    memory: {
      ...modules.memory,
      callsByName: sortedEntries(modules.memory.callsByName),
      updatesByOperation: sortedEntries(modules.memory.updatesByOperation),
      factOrEntityIds: uniqueStrings(modules.memory.factOrEntityIds),
    },
    gui: {
      proposed: actionMetrics.proposed,
      started: actionMetrics.started,
      completed: actionMetrics.completed,
      refused: actionMetrics.refused,
      failed: actionMetrics.failed,
      cancelled: actionMetrics.cancelled,
      rejected: actionMetrics.rejected,
    },
  };
}

function createMonitorMetrics(events, context) {
  const byProposal = {};
  const byMode = {};
  const transitions = {};
  let candidates = 0;
  let guidance = 0;
  let helpRequested = 0;
  let suppressed = 0;
  for (const event of events) {
    if (event.type === "monitor.transition") {
      increment(transitions, event.transition);
      continue;
    }
    if (event.type !== "monitor.proposal") continue;
    increment(byProposal, event.proposal);
    increment(byMode, event.mode);
    if (event.proposal === "candidate") candidates += 1;
    else if (event.proposal === "guidance") guidance += 1;
    else if (event.proposal === "help_requested") helpRequested += 1;
    else if (event.proposal === "suppressed_by_execution_barrier") suppressed += 1;
  }
  return {
    proposals: candidates + guidance + helpRequested + suppressed,
    candidates,
    guidance,
    helpRequested,
    suppressed,
    byProposal: sortedEntries(byProposal),
    byMode: sortedEntries(byMode),
    transitions: sortedEntries(transitions),
    guidanceIncludedInContext: context.monitorGuidanceIncluded?.true ?? null,
    guidanceOmittedByBudget: context.monitorGuidanceIncluded?.omittedByBudget ?? null,
  };
}

function createGuardMetrics(events) {
  const decisions = {};
  const categories = {};
  const paths = {};
  const approvals = { requested: 0, resolved: 0, approved: 0, denied: 0, unresolved: 0 };
  const latencies = [];
  let evaluations = 0;
  let modelRequestCount = 0;
  const approvalRequests = new Set();
  const approvalResolutions = new Set();
  for (const event of events) {
    if (event.type === "action.guard.evaluated") {
      evaluations += 1;
      increment(decisions, event.decision);
      increment(paths, event.path);
      modelRequestCount += finiteNonNegativeInteger(event.modelRequestCount) ?? 0;
      if (Array.isArray(event.categories)) for (const category of event.categories) increment(categories, category);
      if (typeof event.latencyMs === "number" && Number.isFinite(event.latencyMs)) latencies.push(event.latencyMs);
    } else if (event.type === "approval.requested") {
      approvals.requested += 1;
      if (typeof event.requestId === "string") approvalRequests.add(event.requestId);
    } else if (event.type === "approval.resolved") {
      approvals.resolved += 1;
      if (event.approved === true) approvals.approved += 1; else approvals.denied += 1;
      if (typeof event.requestId === "string") approvalResolutions.add(event.requestId);
    }
  }
  approvals.unresolved = Math.max(0, approvalRequests.size - [...approvalRequests].filter((id) => approvalResolutions.has(id)).length);
  return {
    evaluations,
    decisions: sortedEntries(decisions),
    categories: sortedEntries(categories),
    paths: sortedEntries(paths),
    modelRequestCount,
    latency: summaryForDurations(latencies),
    approvals,
  };
}

function createHumanControlMetrics(events) {
  let pauses = 0;
  let resumes = 0;
  let userInputRequested = 0;
  let userInputReceived = 0;
  for (const event of events) {
    if (event.type === "run.paused") pauses += 1;
    else if (event.type === "run.resumed") resumes += 1;
    else if (event.type === "user.input.requested") userInputRequested += 1;
    else if (event.type === "user.input.received") userInputReceived += 1;
  }
  return { pauses, resumes, userInputRequested, userInputReceived };
}

function extractOutcome(summary, events) {
  const finished = [...events].reverse().find((event) => event.type === "run.finished");
  const runtimeOutcome = stringOrNull(summary?.runtimeOutcome) ?? stringOrNull(summary?.outcome) ?? stringOrNull(finished?.outcome);
  const modelReportedStatus = stringOrNull(summary?.modelReportedStatus) ?? stringOrNull(finished?.reportedStatus);
  return { runtimeOutcome, modelReportedStatus };
}

function buildMetrics({ trial, summary, trajectory }) {
  const allEvents = trajectory?.events ?? [];
  const runIds = uniqueStrings([
    ...eventRunIds(allEvents),
    stringOrNull(summary?.runId),
    stringOrNull(trial?.runId),
  ]);
  const conflictingRunIds = runIds.length > 1;
  // A run-id conflict means that counts from different runs must not be
  // presented as one trial.  Keep the IDs and file/event counts for diagnosis,
  // but null every event-derived metric until the artifacts are separated.
  const eventDataAvailable = trajectory?.present === true && !conflictingRunIds;
  const events = eventDataAvailable ? allEvents : [];
  const request = createRequestMetrics(events);
  const actions = createActionMetrics(events);
  const usageTotal = {};
  for (const event of events) {
    if (event.type === "model.response.received") addUsage(usageTotal, event.turn?.usage);
    if (event.type === "action.guard.evaluated") addUsage(usageTotal, event.usage);
  }
  const summaryUsage = isRecord(summary?.modelUsage) ? summary.modelUsage : null;
  const context = createContextMetrics(events);
  const outcomes = extractOutcome(isRecord(summary) ? summary : null, events);
  const runStarted = events.find((event) => event.type === "run.started");
  const runFinished = [...events].reverse().find((event) => event.type === "run.finished");
  const runDuration = durationMs(runStarted?.occurredAt, runFinished?.occurredAt);
  const errors = createErrorMetrics(events);
  const modules = createToolModuleMetrics(events, actions);
  const monitor = createMonitorMetrics(events, context);
  const guard = createGuardMetrics(events);
  const humanControl = createHumanControlMetrics(events);
  const knownUsage = normalizeUsage(usageTotal, summaryUsage);
  const runId = runIds.length === 1 ? runIds[0] : null;
  return {
    schemaVersion: 1,
    kind: "travel_metrics",
    collectedAt: new Date().toISOString(),
    trial: safeTrialMetadata(trial),
    runId,
    runtimeOutcome: outcomes.runtimeOutcome,
    modelReportedStatus: outcomes.modelReportedStatus,
    businessOutcome: { status: "manual_pending", success: null },
    dataQuality: {
      status: "complete",
      complete: true,
      errors: [],
      eventCount: eventDataAvailable ? events.length : null,
      parsedEventCount: trajectory?.present === true ? allEvents.length : null,
      runIds,
      eventDataIsolated: conflictingRunIds,
    },
    base: {
      requests: eventDataAvailable ? request : null,
      actions: eventDataAvailable ? {
        proposed: actions.proposed,
        started: actions.started,
        completed: actions.completed,
        refused: actions.refused,
        failed: actions.failed,
        cancelled: actions.cancelled,
        rejected: actions.rejected,
        durations: actions.durations,
      } : null,
      observations: eventDataAvailable ? events.filter((event) => event.type === "observation.created").length : null,
      errors: eventDataAvailable ? errors : null,
      usage: eventDataAvailable ? knownUsage : null,
      durations: eventDataAvailable ? {
        runMs: runDuration,
        requests: request.durations,
        actions: actions.durations,
      } : null,
    },
    usage: eventDataAvailable ? knownUsage : null,
    timing: eventDataAvailable ? {
      runMs: runDuration,
      requests: request.durations,
      actions: actions.durations,
    } : null,
    context: eventDataAvailable ? context : null,
    planning: eventDataAvailable ? modules.planning : null,
    memory: eventDataAvailable ? modules.memory : null,
    gui: eventDataAvailable ? modules.gui : null,
    batch: eventDataAvailable ? createBatchMetrics(events) : null,
    monitor: eventDataAvailable ? monitor : null,
    guard: eventDataAvailable ? guard : null,
    humanControl: eventDataAvailable ? humanControl : null,
  };
}

function finalizeDataQuality(metrics, errors, trajectory, trial, summary) {
  const trajectoryPath = trajectory?.path ?? "runtime/trajectory.jsonl";
  const summaryPath = trajectoryPath === "trajectory.jsonl" ? "summary.json" : "runtime/summary.json";
  if (!isRecord(trial) && !errors.some((error) => error.path === "trial.json")) addError(errors, "invalid_trial", "trial.json");
  if (summary === MISSING || !isRecord(summary)) {
    if (!errors.some((error) => error.path === summaryPath || error.path?.endsWith?.("/summary.json"))) addError(errors, summary === MISSING ? "missing_or_invalid_summary" : "invalid_summary", summaryPath);
  } else if (stringOrNull(summary.runtimeOutcome) === null && stringOrNull(summary.outcome) === null) {
    addError(errors, "summary_missing_runtime_outcome", summaryPath);
  }
  if (trajectory?.present !== true) {
    // readTrajectory already records the concrete missing/read error; this
    // branch only keeps the output explicitly partial when no trajectory is
    // available.
    if (!errors.some((error) => error.path === trajectoryPath || error.path?.endsWith?.("/trajectory.jsonl"))) addError(errors, "missing_or_invalid_trajectory", trajectoryPath);
  } else if (trajectory.events.length === 0) {
    addError(errors, "empty_trajectory", trajectoryPath);
  } else {
    const hasStarted = trajectory.events.some((event) => event.type === "run.started");
    const finishedEvents = trajectory.events.filter((event) => event.type === "run.finished");
    if (!hasStarted) addError(errors, "missing_run_started", trajectoryPath);
    if (finishedEvents.length === 0) addError(errors, "missing_run_finished", trajectoryPath);
    const summaryOutcome = stringOrNull(summary?.runtimeOutcome) ?? stringOrNull(summary?.outcome);
    const finishedOutcome = stringOrNull(finishedEvents.at(-1)?.outcome);
    if (summaryOutcome !== null && finishedOutcome !== null && summaryOutcome !== finishedOutcome) {
      addError(errors, "outcome_mismatch", summaryPath);
    }
  }
  if (metrics.dataQuality.runIds.length > 1) addError(errors, "conflicting_run_id", "runId", { values: metrics.dataQuality.runIds });
  metrics.dataQuality.errors = errors;
  metrics.dataQuality.status = errors.length === 0 ? "complete" : "partial";
  metrics.dataQuality.complete = errors.length === 0;
  // Once the trajectory is missing, all event-derived metrics are unknown.
  // A syntactically partial JSONL still retains the valid prefix above.
  return metrics;
}

/**
 * Pure aggregation entry point used by tests and by the travel CLI bridge.
 * It does not perform I/O and does not include any raw Runtime payload.
 */
export function collectMetrics({ trial = null, summary = null, events = [], trajectory = { present: true, events }, errors = [] } = {}) {
  const normalizedTrajectory = trajectory?.present === false
    ? { present: false, events: [], path: trajectory?.path ?? "runtime/trajectory.jsonl" }
    : { present: true, events: Array.isArray(events) ? events : [], path: trajectory?.path ?? "runtime/trajectory.jsonl" };
  return finalizeDataQuality(buildMetrics({ trial, summary, trajectory: normalizedTrajectory }), [...errors], normalizedTrajectory, trial, summary);
}

/**
 * Narrow reader for callers that keep Runtime artifacts directly in a Run
 * directory (for example the interactive TUI collector).  It deliberately
 * returns only parsed summary/trajectory data and the same redacted data
 * quality errors consumed by collectMetrics; it never reads provider files.
 */
export async function readMetricsArtifacts(runDirectory) {
  const directory = resolve(runDirectory);
  const errors = [];
  const summaryValue = await readJsonFile(resolve(directory, "summary.json"), "summary.json", errors);
  const trajectory = await readTrajectory(resolve(directory, "trajectory.jsonl"), errors, "trajectory.jsonl");
  return {
    summary: summaryValue === MISSING ? null : summaryValue,
    events: trajectory.events,
    trajectory,
    errors,
  };
}

/**
 * Read one prepared travel trial and write `<trialDir>/metrics.json`.
 * `options.root` is intended for isolated tests; production defaults to the
 * repository's ignored `runs/travel` root and rejects path escapes.
 */
export async function collectTrial(trialDir, options = {}) {
  // Accept the old bridge's object shape during the short migration window,
  // while keeping the public contract `collectTrial(trialDir)` explicit.
  let requestedDirectory = trialDir;
  let configuredRoot = options?.root ?? options?.runRoot ?? TRAVEL_RUN_ROOT;
  if (isRecord(trialDir)) {
    requestedDirectory = trialDir.trialDirectory ?? trialDir.trialDir;
    configuredRoot = trialDir.root ?? trialDir.runRoot ?? configuredRoot;
  }
  const directory = await resolveSafeTrialDirectory(requestedDirectory, configuredRoot);
  const errors = [];
  const trial = await readJsonFile(resolve(directory, "trial.json"), "trial.json", errors);
  const runtimeDirectory = resolve(directory, "runtime");
  // A runtime directory symlink could otherwise make fixed artifact reads
  // escape the trial root.  The trial directory itself was realpath-checked
  // above; only inspect runtime when it exists.
  try {
    const runtimePhysical = await realpath(runtimeDirectory);
    const trialPhysical = await realpath(directory);
    if (!pathInside(trialPhysical, runtimePhysical)) throw new Error("runtime directory resolves outside the trial directory");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const summary = await readJsonFile(resolve(runtimeDirectory, "summary.json"), "runtime/summary.json", errors);
  const trajectory = await readTrajectory(resolve(runtimeDirectory, "trajectory.jsonl"), errors);
  const metrics = buildMetrics({
    trial: trial === MISSING ? null : trial,
    summary: summary === MISSING ? null : summary,
    trajectory,
  });
  finalizeDataQuality(metrics, errors, trajectory, trial === MISSING ? null : trial, summary === MISSING ? null : summary);
  const outputPath = resolve(directory, "metrics.json");
  await ensureOutputPathIsSafe(outputPath);
  await writeFile(outputPath, `${JSON.stringify(metrics, null, 2)}\n`, "utf8");
  return metrics;
}

function parseCliArgs(argv) {
  let trialDir;
  let root;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--trial-dir") trialDir = argv[++index];
    else if (arg === "--root") root = argv[++index];
    else if (arg === "--help" || arg === "-h") return { help: true };
    else throw new Error(`unknown option: ${arg}`);
  }
  if (typeof trialDir !== "string" || trialDir.length === 0) throw new Error("--trial-dir requires a value");
  return { trialDir, root };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseCliArgs(argv);
  if (options.help) {
    process.stdout.write("Usage: node scripts/travel/metrics.mjs --trial-dir runs/travel/<trial-id> [--root <root>]\n");
    return;
  }
  const metrics = await collectTrial(options.trialDir, options.root === undefined ? {} : { root: options.root });
  process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`);
}

if (process.argv[1] !== undefined && pathKey(process.argv[1]) === pathKey(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
