#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_API_REQUESTS = 12;
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_OUTPUT_TOKENS = 4096;
const EXPECTED_FIRST_CALLS = Object.freeze(["task_create", "memory_write_fact", "click", "hotkey", "type"]);
const EXPECTED_BASELINE_FIRST_CALLS = Object.freeze(["task_create", "memory_write_fact", "click"]);
const ALLOWED_BATCH_PREFIX_TOOLS = new Set(["task_create", "task_update", "memory_write_fact", "memory_mark_fact_needs_check"]);
const COMPUTER_TOOL_NAMES = new Set(["click", "type", "hotkey", "keypress", "scroll", "drag", "wait"]);
const PROBE_GOALS = Object.freeze({
  composite: [
  "Use only the synthetic form shown in the screenshot; this is a protocol probe, not a business task.",
  "Identify the visible input and nearby Search button from the screenshot. The input is already focused at the start, and its visible caret marks that focus; keep using this same control.",
  "In your first response, create one Planning task for this short inspection, then write one run-scoped stable Memory fact describing the visible synthetic controls.",
  "In that same response, use exactly one three-action same-control input batch: click inside the already focused input, press CTRL+A, then type exactly `probe`; do not spend a separate turn re-establishing focus.",
  "Do not press Enter, click the Search button, or use any other computer action.",
  "Inspect the next screenshot and finish in a separate turn with terminate. Do not claim any real-world or business result.",
  ].join(" "),
  baseline: [
    "Use only the synthetic form shown in the screenshot; this is a protocol probe, not a business task.",
    "Identify the visible input and nearby Search button from the screenshot. The input is already focused at the start, and its visible caret marks that focus; keep using this same control.",
    "In your first response, create one Planning task and write one run-scoped stable Memory fact describing the visible synthetic controls, then click the input exactly once.",
    "Do not type, press keys, click the Search button, or use any other computer action. Let Runtime capture its normal follow-up observation.",
    "In a later turn you may update the Planning task if appropriate, then finish in a separate turn with terminate. Do not claim any real-world or business result.",
  ].join(" "),
});
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const FONT = Object.freeze({
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01111", "10000", "10000", "10111", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
});

export class ProbeError extends Error {
  constructor(code, safeMessage) {
    super(safeMessage);
    this.name = "ProbeError";
    this.code = code;
  }
}

export function parseProbeArgs(argv) {
  if (argv.length === 0) return { mode: "offline", scenario: "composite" };
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) return { mode: "help" };
  let live = false;
  let offline = false;
  let envFile;
  let keyEnv;
  let scenario;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--live") {
      if (live) throw new ProbeError("DUPLICATE_ARGUMENT", "--live may be supplied only once.");
      live = true;
    } else if (token === "--offline") {
      if (offline) throw new ProbeError("DUPLICATE_ARGUMENT", "--offline may be supplied only once.");
      offline = true;
    } else if (token === "--env-file") {
      if (envFile !== undefined) throw new ProbeError("DUPLICATE_ARGUMENT", "--env-file may be supplied only once.");
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new ProbeError("MISSING_ARGUMENT_VALUE", "--env-file requires a path.");
      envFile = resolve(value);
      index += 1;
    } else if (token === "--key-env") {
      if (keyEnv !== undefined) throw new ProbeError("DUPLICATE_ARGUMENT", "--key-env may be supplied only once.");
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new ProbeError("MISSING_ARGUMENT_VALUE", "--key-env requires a supported variable name.");
      if (value !== "ARK_API_KEY" && value !== "HUOSHAN_API_KEY") throw new ProbeError("INVALID_KEY_ENV", "--key-env must be ARK_API_KEY or HUOSHAN_API_KEY.");
      keyEnv = value;
      index += 1;
    } else if (token === "--scenario") {
      if (scenario !== undefined) throw new ProbeError("DUPLICATE_ARGUMENT", "--scenario may be supplied only once.");
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new ProbeError("MISSING_ARGUMENT_VALUE", "--scenario requires baseline or composite.");
      if (value !== "baseline" && value !== "composite") throw new ProbeError("INVALID_SCENARIO", "--scenario must be baseline or composite.");
      scenario = value;
      index += 1;
    } else {
      throw new ProbeError("UNKNOWN_ARGUMENT", `Unknown argument ${String(token)}.`);
    }
  }
  if (live && offline) throw new ProbeError("CONFLICTING_MODE", "Choose either --live or --offline.");
  if (envFile !== undefined && !live) throw new ProbeError("LIVE_REQUIRED_FOR_ENV_FILE", "--env-file is accepted only with explicit --live.");
  if (keyEnv !== undefined && !live) throw new ProbeError("LIVE_REQUIRED_FOR_KEY_ENV", "--key-env is accepted only with explicit --live.");
  if (live && envFile === undefined) throw new ProbeError("ENV_FILE_REQUIRED", "Live mode requires an explicit --env-file.");
  const selectedScenario = scenario ?? "composite";
  return live
    ? { mode: "live", envFile, keyEnv: keyEnv ?? "ARK_API_KEY", scenario: selectedScenario }
    : { mode: "offline", scenario: selectedScenario };
}

/** Reads only the explicitly selected key name; unrelated entries are discarded and never used as fallback. */
export function parseProviderApiKeyEnv(contents, keyName = "ARK_API_KEY") {
  if (keyName !== "ARK_API_KEY" && keyName !== "HUOSHAN_API_KEY") {
    throw new ProbeError("INVALID_KEY_ENV", "The selected key variable is not supported by this probe.");
  }
  let found;
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${keyName}\\s*=\\s*(.*?)\\s*$`, "u");
  for (const line of contents.split(/\r?\n/u)) {
    const match = pattern.exec(line);
    if (match === null) continue;
    if (found !== undefined) throw new ProbeError(`DUPLICATE_${keyName}`, `The env file contains multiple ${keyName} entries.`);
    const raw = match[1] ?? "";
    const value = raw.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/u, (_whole, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted ?? "").trim();
    if (value.length === 0) throw new ProbeError(`${keyName}_MISSING`, `${keyName} is empty.`);
    found = value;
  }
  if (found === undefined) throw new ProbeError(`${keyName}_MISSING`, `The env file does not contain ${keyName}.`);
  return found;
}

export function parseArkApiKeyEnv(contents) {
  return parseProviderApiKeyEnv(contents, "ARK_API_KEY");
}

/** Project only bounded, numeric token/cache counters from a parsed response. */
export function collectUsageNumbers(response) {
  if (!isRecord(response) || !isRecord(response.usage)) return {};
  const result = {};
  const visit = (value, path, depth) => {
    if (Object.keys(result).length >= 32 || depth > 4) return;
    if (typeof value === "number") {
      const joined = path.join(".");
      if (Number.isSafeInteger(value) && value >= 0 && !/reasoning/iu.test(joined) && /token|cache|cached|prompt|completion|input|output/iu.test(joined)) {
        result[joined] = value;
      }
      return;
    }
    if (Array.isArray(value)) {
      value.slice(0, 8).forEach((item, index) => visit(item, [...path, String(index)], depth + 1));
      return;
    }
    if (!isRecord(value)) return;
    for (const key of Object.keys(value).sort().slice(0, 32)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(key) || /secret|token_value|api.?key|password|cookie|reasoning_content/iu.test(key)) continue;
      visit(value[key], [...path, key], depth + 1);
    }
  };
  visit(response.usage, [], 0);
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

/** Summarizes the wire shape without copying prompts, image data, URLs, or tool arguments. */
export function summarizeRequestBody(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const toolNames = [];
  let nativeFunctionToolCount = 0;
  for (const tool of tools) {
    if (!isRecord(tool) || tool.type !== "function" || !isRecord(tool.function) || typeof tool.function.name !== "string") continue;
    nativeFunctionToolCount += 1;
    if (/^[A-Za-z][A-Za-z0-9_]{0,79}$/u.test(tool.function.name)) toolNames.push(tool.function.name);
  }
  let imageCount = 0;
  let assistantToolCallCount = 0;
  let toolResultCount = 0;
  const priorToolCallNames = [];
  const messageRoles = [];
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const role = ["system", "user", "assistant", "tool"].includes(message.role) ? message.role : "other";
    messageRoles.push(role);
    if (role === "tool") toolResultCount += 1;
    if (Array.isArray(message.tool_calls)) {
      assistantToolCallCount += message.tool_calls.length;
      for (const call of message.tool_calls) {
        if (isRecord(call) && isRecord(call.function) && typeof call.function.name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,79}$/u.test(call.function.name)) {
          priorToolCallNames.push(call.function.name);
        }
      }
    }
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (isRecord(part) && part.type === "image_url") imageCount += 1;
      }
    }
  }
  return {
    model: body?.model === "deepseek-v4.1-flash" ? body.model : "other",
    thinking: isRecord(body?.thinking) && body.thinking.type === "disabled" ? "disabled" : "not_disabled",
    nativeFunctionToolCount,
    toolNames: [...new Set(toolNames)].sort(),
    messageRoles,
    imageCount,
    assistantToolCallCount,
    priorToolCallNames,
    toolResultCount,
  };
}

export function safeErrorCode(error) {
  if (error instanceof ProbeError) return error.code;
  const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
  if (code !== undefined && /^(?:ARK_[A-Z0-9_]{1,64}|HTTP_[0-9]{3}|REQUEST_ABORTED)$/u.test(code)) return code;
  if (isRecord(error) && error.name === "AbortError") return "REQUEST_ABORTED";
  return "PROBE_REQUEST_FAILED";
}

export function mentionsFixtureControls(text) {
  if (typeof text !== "string") return false;
  const normalized = text.normalize("NFKC").toLocaleLowerCase();
  const mentionsInput = /\binput\b|\bfield\b|text ?box|输入框|文本框|输入区域/u.test(normalized);
  const mentionsSearchButton = /\bsearch\b|搜索|查询/u.test(normalized) && /\bbutton\b|按钮/u.test(normalized);
  return mentionsInput && mentionsSearchButton;
}

export function reportedNetworkCallsOnFailure(mode, liveRunStarted, report) {
  if (mode !== "live" || !liveRunStarted) return 0;
  const requestCount = report?.requestCount;
  return Number.isSafeInteger(requestCount) && requestCount >= 0 ? requestCount : "unknown";
}

export function probeStatusFromChecks(checks) {
  return Object.keys(checks).length > 0 && Object.values(checks).every((passed) => passed === true) ? "passed" : "failed";
}

/** Require a single Runtime model response to contain the accepted GUI suffix and its exact completed receipts. */
export function hasSuccessfulThreeActionBatch(responseEvents, events, completedCallIds) {
  const proposedActionIds = new Map();
  const completedActionIds = new Set();
  for (const event of events) {
    if (event.type === "action.proposed" && typeof event.callId === "string" && typeof event.action?.actionId === "string") {
      proposedActionIds.set(event.callId, event.action.actionId);
    }
    if (event.type === "action.execution.completed" && event.receipt?.status === "completed" && typeof event.receipt.actionId === "string") {
      completedActionIds.add(event.receipt.actionId);
    }
  }
  for (const response of responseEvents) {
    if (response.turn?.type !== "tool_calls" || !Array.isArray(response.turn.calls)) continue;
    const calls = response.turn.calls;
    const firstComputer = calls.findIndex((call) => COMPUTER_TOOL_NAMES.has(call.name));
    if (firstComputer < 0 || firstComputer > 2) continue;
    if (calls.slice(0, firstComputer).some((call) => !ALLOWED_BATCH_PREFIX_TOOLS.has(call.name))) continue;
    const batch = calls.slice(firstComputer);
    if (JSON.stringify(batch.map((call) => call.name)) !== JSON.stringify(["click", "hotkey", "type"])) continue;
    if (!batch.every((call) => completedCallIds.has(call.id))) continue;
    const actionIds = batch.map((call) => proposedActionIds.get(call.id));
    if (actionIds.some((actionId) => actionId === undefined) || !actionIds.every((actionId) => completedActionIds.has(actionId))) continue;
    return true;
  }
  return false;
}

export function matchesScenarioFirstTurn(scenario, calls) {
  if (scenario !== "baseline" && scenario !== "composite") return false;
  const expected = scenario === "baseline" ? EXPECTED_BASELINE_FIRST_CALLS : EXPECTED_FIRST_CALLS;
  return JSON.stringify(calls.map((call) => call.name)) === JSON.stringify(expected);
}

export function hasCompletedActionReceiptForCall(callId, events, completedCallIds) {
  if (!completedCallIds.has(callId)) return false;
  const proposal = events.find((event) => event.type === "action.proposed" && event.callId === callId);
  if (proposal?.action?.actionId === undefined) return false;
  return events.some((event) => event.type === "action.execution.completed" &&
    event.receipt?.status === "completed" && event.receipt.actionId === proposal.action.actionId);
}

export function createSyntheticUiPng(value = "SAMPLE", focused = false) {
  if (value !== "SAMPLE" && value !== "probe") throw new ProbeError("INVALID_FIXTURE_VALUE", "Synthetic UI accepts only its predeclared fixture values.");
  if (typeof focused !== "boolean") throw new ProbeError("INVALID_FIXTURE_FOCUS", "Synthetic UI focus state must be boolean.");
  const width = 480;
  const height = 240;
  const pixels = Buffer.alloc(width * height * 4);
  fillRect(pixels, width, height, 0, 0, width, height, "#f2f4f7");
  fillRect(pixels, width, height, 45, 30, 390, 178, "#ffffff");
  fillRect(pixels, width, height, 45, 30, 390, 2, "#d3d9e1");
  fillRect(pixels, width, height, 45, 206, 390, 2, "#d3d9e1");
  fillRect(pixels, width, height, 45, 30, 2, 178, "#d3d9e1");
  fillRect(pixels, width, height, 433, 30, 2, 178, "#d3d9e1");
  drawText(pixels, width, height, 78, 53, "SYNTHETIC FORM", 2, "#26364a");
  drawText(pixels, width, height, 82, 88, "SEARCH", 2, "#485a70");
  fillRect(pixels, width, height, 80, 106, 280, 46, focused ? "#2f6fed" : "#64748b");
  fillRect(pixels, width, height, 82, 108, 276, 42, "#ffffff");
  drawText(pixels, width, height, 96, 121, value.toUpperCase(), 2, "#202a36");
  if (focused) fillRect(pixels, width, height, 99 + value.length * 12, 118, 2, 20, "#202a36");
  fillRect(pixels, width, height, 374, 106, 62, 46, "#2f6fed");
  drawText(pixels, width, height, 386, 121, "GO", 2, "#ffffff");
  return encodePng(width, height, pixels);
}

export async function runOfflineProbe(options = {}) {
  return runRuntimeProbe({ mode: "offline", apiKey: "offline-placeholder-not-a-credential", scenario: "composite", ...options });
}

export async function runLiveProbe(options) {
  if (typeof options?.apiKey !== "string" || options.apiKey.trim().length === 0) {
    throw new ProbeError("ARK_API_KEY_MISSING", "Live probe requires an Ark API key loaded from the explicit env file.");
  }
  return runRuntimeProbe({ mode: "live", scenario: "composite", ...options });
}

async function runRuntimeProbe({ mode, apiKey, scenario = "composite", outputDir = defaultOutputDir(mode, scenario) }) {
  if (scenario !== "baseline" && scenario !== "composite") throw new ProbeError("INVALID_SCENARIO", "Scenario must be baseline or composite.");
  const app = await import(pathToFileURL(join(REPO_ROOT, "packages", "app-runtime", "dist", "index.js")).href);
  const providerGlm = await import(pathToFileURL(join(REPO_ROOT, "packages", "provider-glm", "dist", "index.js")).href);
  const inner = mode === "offline"
    ? new ScriptedArkHttpClient(scenario)
    : new providerGlm.FetchArkHttpClient({ requestTimeoutMs: REQUEST_TIMEOUT_MS });
  const httpClient = new RecordingArkHttpClient(inner, MAX_API_REQUESTS);
  const computer = new SyntheticComputer();
  const runId = `ark-probe-${randomUUID()}`;
  const config = {
    runId,
    goal: PROBE_GOALS[scenario],
    model: "deepseek-v4.1-flash",
    computer: { kind: "external", id: "synthetic-ark-probe" },
    outputDir,
    maxSteps: 8,
    maxModelRequests: MAX_API_REQUESTS,
    planning: true,
    memory: "facts",
    batching: scenario === "composite" ? "same-control-input-v1" : "off",
    contextMode: "raw",
    contextMaxHistoryEvents: 96,
    riskProfile: "experiment",
    riskGuard: "off",
    riskModel: "off",
    riskMaxModelRequests: 1,
    riskTimeoutMs: 1000,
    cleanupDeadlineMs: 5000,
    monitor: "off",
    arkRequestTimeoutMs: REQUEST_TIMEOUT_MS,
    arkMaxOutputTokens: MAX_OUTPUT_TOKENS,
  };
  let handle;
  let runtimeOutcome;
  let runErrorCode;
  try {
    handle = await app.createRun(config, {
      credentials: { arkApiKey: apiKey },
      createProvider: (providerOptions) => app.createProvider({
        ...providerOptions,
        httpClients: { ark: httpClient },
      }),
      createComputer: async () => computer,
    });
    runtimeOutcome = await handle.start();
  } catch (error) {
    runErrorCode = safeErrorCode(error);
  }
  const events = handle?.controller.getEvents() ?? [];
  const snapshot = handle?.controller.getSnapshot();
  let cleanupErrorCode;
  if (handle !== undefined) {
    try { await handle.close(); } catch (error) { cleanupErrorCode = safeErrorCode(error); }
  }
  return buildProbeReport({
    mode,
    scenario,
    outputDir,
    records: httpClient.records,
    events,
    snapshot,
    runtimeOutcome,
    computer,
    ...(runErrorCode === undefined ? {} : { runErrorCode }),
    ...(cleanupErrorCode === undefined ? {} : { cleanupErrorCode }),
  });
}

function buildProbeReport({ mode, scenario, outputDir, records, events, snapshot, runtimeOutcome, computer, runErrorCode, cleanupErrorCode }) {
  const responseEvents = events.filter((event) => event.type === "model.response.received");
  const firstTurn = responseEvents[0]?.turn;
  const firstCalls = firstTurn?.type === "tool_calls" ? firstTurn.calls : [];
  const firstCallNames = firstCalls.map((call) => call.name);
  const finalTurn = responseEvents.at(-1)?.turn;
  const expectedActions = ["click", "keypress", "type"];
  const startedActions = events.filter((event) => event.type === "action.execution.started").map((event) => event.action.kind);
  const completedActions = events.filter((event) => event.type === "action.execution.completed" && event.receipt.status === "completed");
  const rejectedCalls = events.filter((event) => event.type === "tool.call.rejected");
  const runtimeErrors = events.filter((event) => event.type === "runtime.error");
  const planningTaskCount = Array.isArray(snapshot?.plan?.tasks) ? snapshot.plan.tasks.length : 0;
  const memoryFactCount = Array.isArray(snapshot?.memory?.facts) ? snapshot.memory.facts.length : 0;
  const mentionsControls = finalTurn?.type === "finish" && mentionsFixtureControls(finalTurn.summary);
  const completedCallIds = new Set(events
    .filter((event) => event.type === "tool.call.completed")
    .map((event) => event.result.callId));
  const firstCallsCompleted = firstCalls.every((call) => completedCallIds.has(call.id));
  const acceptedSameTurnBatch = hasSuccessfulThreeActionBatch(responseEvents, events, completedCallIds);
  const firstClickCall = firstCalls.find((call) => call.name === "click");
  const baselineClickReceiptCompleted = firstClickCall !== undefined && hasCompletedActionReceiptForCall(firstClickCall.id, events, completedCallIds);
  const initialRequest = records[0]?.requestSummary;
  const continuationRequest = records[1]?.requestSummary;
  const commonChecks = {
    liveRequestsBounded: records.length <= MAX_API_REQUESTS,
    requestCountMatchesRuntime: records.length >= 2 && records.length <= MAX_API_REQUESTS && snapshot?.modelRequestCount === records.length,
    defaultArkModelAndThinkingDisabled: records.length >= 2 && records.every((record) => record.requestSummary.model === "deepseek-v4.1-flash" && record.requestSummary.thinking === "disabled"),
    nativeFunctionToolProjection: (initialRequest?.nativeFunctionToolCount ?? 0) > 0 && initialRequest?.toolNames.includes("terminate") === true,
    initialAndFollowUpSyntheticScreenshots: (initialRequest?.imageCount ?? 0) >= 1 && (continuationRequest?.imageCount ?? 0) >= 1,
    planningTaskPersisted: planningTaskCount >= 1,
    memoryFactPersisted: memoryFactCount >= 1,
    modelResponseMentionsFixtureControls: mentionsControls,
    noToolRejections: rejectedCalls.length === 0,
    noRuntimeErrors: runtimeErrors.length === 0 && runErrorCode === undefined && cleanupErrorCode === undefined,
    syntheticComputerOnly: computer.outOfScopeActionCount === 0 && JSON.stringify(computer.actionKinds) === JSON.stringify(scenario === "baseline" ? ["click"] : expectedActions) && computer.observationCount >= 2,
    runtimeProtocolOutcomeSucceeded: runtimeOutcome === "succeeded" && snapshot?.outcome === "succeeded",
  };
  const checks = scenario === "composite"
    ? {
        ...commonChecks,
        exactlyTwoModelRequests: records.length === 2 && snapshot?.modelRequestCount === 2,
        firstTurnPlanMemoryAndAllowedInputBatch: matchesScenarioFirstTurn(scenario, firstCalls),
        allFirstTurnCallsReceivedCompletedResults: firstCalls.length === EXPECTED_FIRST_CALLS.length && firstCallsCompleted,
        runtimeAcceptedThreeActionBatch: acceptedSameTurnBatch && JSON.stringify(startedActions) === JSON.stringify(expectedActions) && completedActions.length === 3,
        continuationContainsPriorCallsAndReceipts: (continuationRequest?.assistantToolCallCount ?? 0) >= EXPECTED_FIRST_CALLS.length && (continuationRequest?.toolResultCount ?? 0) >= EXPECTED_FIRST_CALLS.length,
        terminateIsSeparateFinalDecision: finalTurn?.type === "finish" && finalTurn.reportedStatus === "success" && responseEvents.length === 2,
      }
    : {
        ...commonChecks,
        firstTurnPlanMemoryAndClick: matchesScenarioFirstTurn(scenario, firstCalls),
        allFirstTurnCallsReceivedCompletedResults: firstCalls.length === EXPECTED_BASELINE_FIRST_CALLS.length && firstCallsCompleted,
        oneCompletedFirstTurnClickReceipt: baselineClickReceiptCompleted && completedActions.length === 1,
        continuationContainsPriorCallsAndReceipts: (continuationRequest?.assistantToolCallCount ?? 0) >= EXPECTED_BASELINE_FIRST_CALLS.length && (continuationRequest?.toolResultCount ?? 0) >= EXPECTED_BASELINE_FIRST_CALLS.length,
        terminateIsSeparateFinalDecision: finalTurn?.type === "finish" && finalTurn.reportedStatus === "success" && responseEvents.length >= 2 && responseEvents.length === records.length && firstTurn?.type === "tool_calls",
      };
  const status = probeStatusFromChecks(checks);
  const compositeUnverified = mode === "live" && scenario === "composite" && !acceptedSameTurnBatch;
  return {
    schemaVersion: 1,
    kind: "provider_ark_protocol_conformance",
    status,
    protocolConformance: status,
    businessTaskOutcome: "not_assessed",
    mode,
    scenario,
    provider: "Ark Agent Plan / deepseek-v4.1-flash",
    evaluationScope: "Ark protocol only; no inference about GLM or Qwen.",
    transport: { protocol: "HTTPS", thinking: "disabled", maxOutputTokens: MAX_OUTPUT_TOKENS, requestTimeoutMs: REQUEST_TIMEOUT_MS, maxRequests: MAX_API_REQUESTS },
    requestCount: records.length,
    requests: records.map((record) => ({
      request: record.requestNumber,
      summary: record.requestSummary,
      elapsedMs: record.elapsedMs,
      ...(record.errorCode === undefined ? {} : { errorCode: record.errorCode }),
      usageNumericFields: record.usageNumericFields,
      cacheUsageFields: Object.fromEntries(Object.entries(record.usageNumericFields).filter(([key]) => /cache|cached/iu.test(key))),
    })),
    runtime: {
      outcome: runtimeOutcome ?? "not_completed",
      modelRequestCount: snapshot?.modelRequestCount ?? records.length,
      responseTurnTypes: responseEvents.map((event) => event.turn.type),
      firstTurnToolNames: firstCallNames,
      planningTaskCount,
      memoryFactCount,
      computerActionKinds: computer.actionKinds,
      syntheticObservationCount: computer.observationCount,
      ...(runErrorCode === undefined ? {} : { errorCode: runErrorCode }),
      ...(cleanupErrorCode === undefined ? {} : { cleanupErrorCode }),
      runtimeErrorCategories: runtimeErrors.map((event) => safeCategory(event.category)),
    },
    checks,
    evaluationLimitations: compositeUnverified ? ["P2: Ark same-turn composite batch was not demonstrated; this result does not assess GLM or Qwen."] : [],
    artifactDirectory: `runs/ark-conformance/${basename(outputDir)}`,
  };
}

class RecordingArkHttpClient {
  constructor(inner, maxRequests) {
    this.inner = inner;
    this.maxRequests = maxRequests;
    this.records = [];
  }

  async post(url, body, headers, signal, diagnostics) {
    if (this.records.length >= this.maxRequests) throw new ProbeError("ARK_PROBE_REQUEST_LIMIT", "Ark probe reached its hard request limit; no further request was sent.");
    const requestNumber = this.records.length + 1;
    const record = { requestNumber, requestSummary: summarizeRequestBody(body), elapsedMs: 0, usageNumericFields: {} };
    this.records.push(record);
    const startedAt = Date.now();
    try {
      const response = await this.inner.post(url, body, headers, signal, diagnostics);
      record.elapsedMs = Date.now() - startedAt;
      record.usageNumericFields = collectUsageNumbers(response);
      return response;
    } catch (error) {
      record.elapsedMs = Date.now() - startedAt;
      record.errorCode = safeErrorCode(error);
      throw error;
    }
  }
}

class ScriptedArkHttpClient {
  constructor(scenario) { this.scenario = scenario; this.requestNumber = 0; }

  async post(_url, _body, _headers, signal) {
    signal.throwIfAborted();
    this.requestNumber += 1;
    if (this.requestNumber === 1) {
      const calls = [
        toolCall("offline-plan", "task_create", {
          subject: "Inspect the synthetic form",
          description: this.scenario === "baseline"
            ? "Identify the visible controls, click the already focused synthetic input once, and inspect the next observation."
            : "Identify its visible controls, update only the synthetic input, and inspect the next observation.",
        }),
        toolCall("offline-memory", "memory_write_fact", {
          key: "synthetic_visible_controls",
          value: "Synthetic form with one input field and a nearby Search button.",
          scope: "run",
          retentionClass: "stable",
        }),
        toolCall("offline-click", "click", { x: 220, y: 128 }),
      ];
      if (this.scenario === "composite") {
        calls.push(
          toolCall("offline-select-all", "hotkey", { keys: ["CTRL", "A"] }),
          toolCall("offline-type", "type", { text: "probe" }),
        );
      }
      return responseWithCalls(calls, 1);
    }
    if (this.requestNumber === 2) {
      if (this.scenario === "baseline") {
        return responseWithCalls([
          toolCall("offline-plan-update", "task_update", { taskId: "t1", status: "in_progress" }),
        ], 2);
      }
      return responseWithCalls([
        toolCall("offline-terminate", "terminate", {
          status: "success",
          text: this.scenario === "baseline"
            ? "The synthetic screenshot showed an input beside a Search button. I inspected the next observation after one click. This is protocol conformance evidence, not a business-task result."
            : "The synthetic screenshot showed an input beside a Search button. I inspected the next synthetic observation after the requested field actions. This is protocol conformance evidence, not a business-task result.",
        }),
      ], 2);
    }
    if (this.requestNumber === 3 && this.scenario === "baseline") {
      return responseWithCalls([
        toolCall("offline-terminate", "terminate", {
          status: "success",
          text: "The synthetic screenshot showed an input beside a Search button. I inspected the next observation after one click. This is protocol conformance evidence, not a business-task result.",
        }),
      ], 3);
    }
    throw new ProbeError("OFFLINE_SCRIPT_EXHAUSTED", "The offline provider fixture has no response for an unexpected extra request.");
  }
}

class SyntheticComputer {
  constructor() {
    this.value = "SAMPLE";
    this.focused = true;
    this.selected = false;
    this.observationCount = 0;
    this.actionKinds = [];
    this.outOfScopeActionCount = 0;
    this.session = {
      id: "ark-probe-synthetic-session",
      backend: "synthetic-no-op",
      platform: "win32",
      viewport: { width: 480, height: 240, coordinateSpace: "physical" },
      capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false },
      openedAt: new Date().toISOString(),
    };
    this.surfaceRef = { surfaceId: "ark-probe-synthetic-surface", generation: 1, kind: "desktop" };
  }

  async open(_options, signal) {
    signal.throwIfAborted();
    return this.session;
  }

  async observe(_session, _observationId, signal) {
    signal.throwIfAborted();
    this.observationCount += 1;
    return {
      capturedAt: new Date().toISOString(),
      viewport: this.session.viewport,
      surfaceRef: this.surfaceRef,
      screenshot: { mediaType: "image/png", data: createSyntheticUiPng(this.value, this.focused) },
    };
  }

  async execute(_session, action, signal) {
    signal.throwIfAborted();
    this.actionKinds.push(action.kind);
    let allowed = false;
    if (action.kind === "click") {
      const x = action.point?.x;
      const y = action.point?.y;
      allowed = Number.isFinite(x) && Number.isFinite(y) && x >= 80 && x <= 360 && y >= 106 && y <= 152;
      if (allowed) this.focused = true;
    } else if (action.kind === "keypress") {
      const keys = action.keys.map((key) => key.toUpperCase());
      allowed = this.focused && keys.length === 2 && keys.includes("CTRL") && keys.includes("A");
      if (allowed) this.selected = true;
    } else if (action.kind === "type") {
      allowed = this.focused && this.selected && action.text === "probe";
      if (allowed) this.value = "probe";
    }
    if (!allowed) {
      this.outOfScopeActionCount += 1;
      return { actionId: action.actionId, status: "refused", driverCode: "ARK_PROBE_ACTION_OUT_OF_SCOPE", message: "Synthetic fixture refused an out-of-scope action." };
    }
    return { actionId: action.actionId, status: "completed" };
  }

  async close() {}
}

function responseWithCalls(calls, requestNumber) {
  return {
    choices: [{
      message: {
        role: "assistant",
        tool_calls: calls,
      },
      finish_reason: "tool_calls",
    }],
    usage: {
      prompt_tokens: 360 + requestNumber * 20,
      completion_tokens: 42,
      total_tokens: 402 + requestNumber * 20,
      prompt_cache_hit_tokens: 120,
      prompt_tokens_details: { cached_tokens: 96, cache_miss_tokens: 144 },
      completion_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

function toolCall(id, name, args) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function defaultOutputDir(mode, scenario = "composite") {
  return join(REPO_ROOT, "runs", "ark-conformance", `${mode}-${scenario}-${new Date().toISOString().replace(/[-:.TZ]/gu, "")}-${randomUUID().slice(0, 8)}`);
}

export async function writeProbeReport(report) {
  const targetDirectory = resolve(REPO_ROOT, report.artifactDirectory);
  await mkdir(targetDirectory, { recursive: true });
  await writeFile(join(targetDirectory, "probe-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return "runs/ark-conformance/" + basename(targetDirectory) + "/probe-report.json";
}

export function helpText() {
  return [
    "Ark Agent Plan protocol conformance probe (synthetic Computer only)",
    "",
    "Usage:",
    "  node scripts/provider-ark-conformance.mjs                 # offline end-to-end Runtime/Provider fixture",
    "  node scripts/provider-ark-conformance.mjs --offline",
    "  node scripts/provider-ark-conformance.mjs --offline --scenario baseline|composite",
    "  node scripts/provider-ark-conformance.mjs --live --env-file <explicit-env-file> [--key-env ARK_API_KEY|HUOSHAN_API_KEY] [--scenario baseline|composite]",
    "",
    "Live mode reads only the selected key from the specified UTF-8 env file. --key-env defaults to ARK_API_KEY; HUOSHAN_API_KEY must be explicitly selected and is a probe-local alias, not an app-runtime setting. There is no fallback. Live mode is capped at 12 requests with a 90-second per-request timeout.",
    "The default scenario is composite, which requires the Planning/Memory + click/CTRL+A/type batch in one response. Baseline separately checks Planning/Memory + one click, with later bounded turns allowed; it does not prove the composite batch.",
    "The probe uses a synthetic PNG and a no-op Computer; it does not open a GUI, read a profile, or assess business-task success.",
    "Sanitized reports are written under the ignored runs/ark-conformance/ directory.",
  ].join("\n");
}

async function main(argv) {
  let options;
  let report;
  let liveRunStarted = false;
  try {
    options = parseProbeArgs(argv);
    if (options.mode === "help") {
      process.stdout.write(`${helpText()}\n`);
      return;
    }
    const apiKey = options.mode === "live"
      ? parseProviderApiKeyEnv(await readFile(options.envFile, "utf8"), options.keyEnv)
      : "offline-placeholder-not-a-credential";
    const runOptions = { mode: options.mode, apiKey, scenario: options.scenario, outputDir: defaultOutputDir(options.mode, options.scenario) };
    liveRunStarted = options.mode === "live";
    report = options.mode === "live" ? await runLiveProbe(runOptions) : await runOfflineProbe(runOptions);
    const artifact = await writeProbeReport(report);
    process.stdout.write(`${JSON.stringify({ status: report.status, mode: report.mode, requestCount: report.requestCount, businessTaskOutcome: report.businessTaskOutcome, artifact })}\n`);
    if (report.status !== "passed") process.exitCode = 1;
  } catch (error) {
    const code = error instanceof ProbeError ? error.code : options?.mode === "live" ? safeErrorCode(error) : "OFFLINE_PROBE_FAILED";
    const networkCalls = reportedNetworkCallsOnFailure(options?.mode, liveRunStarted, report);
    process.stderr.write(`${JSON.stringify({ status: "failed", errorCode: code, networkCalls })}\n`);
    process.exitCode = 1;
  }
}

function encodePng(width, height, pixels) {
  const rowBytes = width * 4;
  const raw = Buffer.alloc(height * (rowBytes + 1));
  for (let y = 0; y < height; y += 1) {
    const target = y * (rowBytes + 1);
    raw[target] = 0;
    pixels.copy(raw, target + 1, y * rowBytes, (y + 1) * rowBytes);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function fillRect(pixels, width, height, x, y, rectWidth, rectHeight, color) {
  const [red, green, blue] = parseColor(color);
  for (let row = Math.max(0, y); row < Math.min(height, y + rectHeight); row += 1) {
    for (let column = Math.max(0, x); column < Math.min(width, x + rectWidth); column += 1) {
      const offset = (row * width + column) * 4;
      pixels[offset] = red;
      pixels[offset + 1] = green;
      pixels[offset + 2] = blue;
      pixels[offset + 3] = 255;
    }
  }
}

function drawText(pixels, width, height, x, y, text, scale, color) {
  let cursor = x;
  for (const character of text) {
    if (character === " ") { cursor += 4 * scale; continue; }
    const glyph = FONT[character];
    if (glyph === undefined) { cursor += 6 * scale; continue; }
    glyph.forEach((row, rowIndex) => {
      for (let column = 0; column < row.length; column += 1) {
        if (row[column] === "1") fillRect(pixels, width, height, cursor + column * scale, y + rowIndex * scale, scale, scale, color);
      }
    });
    cursor += 6 * scale;
  }
}

function parseColor(value) {
  const normalized = value.replace(/^#/u, "");
  return [0, 2, 4].map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16));
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeCategory(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_-]{0,63}$/u.test(value) ? value : "other";
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
