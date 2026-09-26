#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { DefaultContextCompiler } from "../packages/context/dist/index.js";
import { GlmAdapter, glmProfiles } from "../packages/provider-glm/dist/index.js";
import { createDefaultToolRegistry } from "../packages/runtime/dist/index.js";

export const PROBE_VERSION = "glm-assistant-text-ab-v1";
export const MODEL = "glm-5.3-flash";
export const PROMPT_SENTENCE = "When calling a GUI tool, use assistant content in the concise format `Current: <action>; Next: <action or observe>`: describe the action being taken now, and describe the next action only when it is clearly predictable after success; otherwise write `Next: observe` and do not guess.";
export const TOOL_NAMES = Object.freeze(["click", "type", "scroll", "terminate"]);
export const MAX_REQUESTS = 24;
export const MAX_ASSISTANT_TEXT_CHARS = 2000;
export const DEFAULT_TIMEOUT_MS = 60_000;

const FEATURES = Object.freeze({ planning: "off", memory: "off", batching: "off" });
const SYNTHETIC_PNG = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
  0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137,
  0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 207, 192, 240,
  31, 0, 5, 0, 1, 255, 137, 153, 61, 29, 0, 0, 0, 0, 73, 69,
  78, 68, 174, 66, 96, 130,
]);

export function createScenarios() {
  return [
    {
      id: "focused-search-then-run",
      nextStepPredictable: true,
      goal: "Enter the query `open-source licenses` in the focused search field. After entering it, click Search.",
      expectedCurrent: { toolName: "type", targetRef: "query-input", arguments: { text: "open-source licenses" }, description: "Type the requested query into the focused search field." },
      expectedNext: { toolName: "click", targetRef: "search-button", description: "Click the visible Search button." },
      elements: [
        element("query-input", "Edit", "Search query", "Focused search field", { x: 150, y: 150, width: 430, height: 48 }, { focused: true, editable: true }),
        element("search-button", "Button", "Search", "Run the search", { x: 620, y: 150, width: 140, height: 48 }),
      ],
    },
    {
      id: "toggle-updates-and-save",
      nextStepPredictable: true,
      goal: "Turn on Email updates and save the settings. The Save changes button remains visible after the checkbox is toggled.",
      expectedCurrent: { toolName: "click", targetRef: "email-updates", description: "Click the unchecked Email updates checkbox." },
      expectedNext: { toolName: "click", targetRef: "save-button", description: "Click Save changes." },
      elements: [
        element("email-updates", "CheckBox", "Email updates", "Receive email updates", { x: 170, y: 230, width: 250, height: 46 }, { checked: false }),
        element("save-button", "Button", "Save changes", "Save the updated settings", { x: 720, y: 690, width: 180, height: 50 }),
      ],
    },
    {
      id: "choose-category-and-apply",
      nextStepPredictable: true,
      goal: "The Category menu is already open. Click the visible Workshops option, then click Apply filters.",
      expectedCurrent: { toolName: "click", targetRef: "workshops-option", description: "Select the visible Workshops option." },
      expectedNext: { toolName: "click", targetRef: "apply-filters", description: "Click Apply filters." },
      elements: [
        element("workshops-option", "Option", "Workshops", "Filter category Workshops", { x: 220, y: 340, width: 280, height: 42 }),
        element("apply-filters", "Button", "Apply filters", "Apply the selected filters", { x: 700, y: 690, width: 180, height: 50 }),
      ],
    },
    {
      id: "search-then-open-unknown-result",
      nextStepPredictable: false,
      nextStepUncertainty: "The result list is not loaded, so the matching result and its location cannot be known yet.",
      goal: "Click Search to look for `quartz`, then open the best matching result. The results have not loaded yet.",
      expectedCurrent: { toolName: "click", targetRef: "search-button", description: "Click Search to start the query." },
      expectedNext: null,
      elements: [
        element("query-input", "Edit", "Search query", "Search query currently contains quartz", { x: 150, y: 150, width: 430, height: 48 }, { editable: true }),
        element("search-button", "Button", "Search", "Run the search", { x: 620, y: 150, width: 140, height: 48 }),
        element("empty-results", "Text", "No results yet", "Results will appear after searching", { x: 150, y: 260, width: 500, height: 50 }),
      ],
    },
    {
      id: "scroll-incident-feed",
      nextStepPredictable: false,
      nextStepUncertainty: "The entries revealed by scrolling are not present in the current observation.",
      goal: "Scroll down through the incident feed to find the latest warning, then open it and summarize its cause. The additional entries are not visible yet.",
      expectedCurrent: { toolName: "scroll", targetRef: "incident-feed", arguments: { direction: "down" }, description: "Scroll down in the incident feed." },
      expectedNext: null,
      elements: [
        element("incident-feed", "List", "Incident feed", "Current incident entries; more entries are below", { x: 120, y: 180, width: 900, height: 500 }),
        element("visible-entry", "ListItem", "Routine check", "A visible synthetic incident entry", { x: 150, y: 220, width: 820, height: 70 }),
      ],
    },
    {
      id: "run-audit-then-review-flagged-record",
      nextStepPredictable: false,
      nextStepUncertainty: "The audit has not run, so the flagged record is unknown.",
      goal: "Click Run audit, then inspect the record it flags as anomalous. The audit has not been run yet.",
      expectedCurrent: { toolName: "click", targetRef: "run-audit", description: "Click Run audit." },
      expectedNext: null,
      elements: [
        element("run-audit", "Button", "Run audit", "Start the synthetic audit", { x: 720, y: 210, width: 190, height: 52 }),
        element("audit-status", "Text", "Not run", "No audit result is available yet", { x: 180, y: 300, width: 400, height: 48 }),
      ],
    },
  ];
}

function element(elementRef, role, name, description, bbox, state = {}) {
  return {
    elementRef,
    role,
    name,
    description,
    bbox: { ...bbox, coordinateSpace: "physical" },
    state: { enabled: true, focused: false, editable: false, ...state },
    source: "dom",
    browserRegion: "content",
  };
}

export function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals <= 0) continue;
    const key = trimmed.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) continue;
    let value = trimmed.slice(equals + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function parseArgs(argv) {
  const result = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--confirm-live-api" || key === "--help" || key === "--describe" || key === "--analyze-only") {
      result.set(key, true);
      continue;
    }
    if (typeof key !== "string" || !key.startsWith("--")) throw new Error(`unexpected argument: ${String(key)}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${key} requires a value`);
    result.set(key, value);
    index += 1;
  }
  return result;
}

export function getPositiveInt(args, key, fallback, minimum = 1) {
  const raw = args.get(key);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${key} must be an integer >= ${minimum}`);
  return value;
}

export function callMatchesExpected(call, expected, elements) {
  if (call === undefined || expected === null || call.name !== expected.toolName) return false;
  const args = call.arguments;
  if (args === null || typeof args !== "object" || Array.isArray(args)) return false;
  if (expected.toolName === "type") return args.text === expected.arguments?.text;
  const target = elements.find((item) => item.elementRef === expected.targetRef);
  if (target === undefined || typeof args.x !== "number" || typeof args.y !== "number") return false;
  const inside = args.x >= target.bbox.x && args.x <= target.bbox.x + target.bbox.width
    && args.y >= target.bbox.y && args.y <= target.bbox.y + target.bbox.height;
  if (expected.toolName === "click") return inside;
  if (expected.toolName === "scroll") return inside && args.direction === expected.arguments?.direction;
  if (expected.toolName === "terminate") return args.status === expected.arguments?.status;
  return false;
}

export function extractFormatLabels(content) {
  if (typeof content !== "string") return { hasCurrentLabel: false, hasNextLabel: false, nextSaysObserve: false, nextStartsWithObserve: false, nextText: null };
  const nextMatch = content.match(/\bNext\s*:\s*([^\r\n;]+)/iu);
  const nextText = nextMatch === null ? null : nextMatch[1].trim();
  return {
    hasCurrentLabel: /\bCurrent\s*:\s*\S/iu.test(content),
    hasNextLabel: nextText !== null && nextText.length > 0,
    nextSaysObserve: nextText !== null && /^observe[.!]?$/iu.test(nextText),
    nextStartsWithObserve: nextText !== null && /^observe\b/iu.test(nextText),
    nextText,
  };
}

export function metricSnapshot(rows) {
  const successful = rows.filter((row) => row.status === "ok");
  const nativeToolCalls = successful.filter((row) => row.finishReason === "tool_calls" && row.toolCallCount > 0);
  const httpSuccessMetrics = contentAndActionMetrics(successful);
  const nativeToolCallMetrics = contentAndActionMetrics(nativeToolCalls);
  return {
    attemptedRequestCount: rows.length,
    httpSuccessRequestCount: successful.length,
    transportOrHttpErrorCount: rows.length - successful.length,
    nativeToolCallCount: nativeToolCalls.length,
    nativeToolCallDefinition: "finishReason=tool_calls and toolCallCount>0",
    httpSuccessMetrics,
    nativeToolCallMetrics,
    semanticCurrentActionAccuracy: null,
    semanticNextActionAccuracy: null,
    semanticAccuracyNote: "Not automatically scored. Compare nextFieldText with expectedNextAction during manual review.",
  };
}

function contentAndActionMetrics(rows) {
  const labelled = rows.filter((row) => row.formatLabels?.hasCurrentLabel && row.formatLabels?.hasNextLabel);
  const predictable = rows.filter((row) => row.nextStepPredictable === true);
  const uncertain = rows.filter((row) => row.nextStepPredictable === false);
  const usages = rows.map((row) => row.usage?.total_tokens).filter(Number.isFinite);
  const latencies = rows.map((row) => row.latencyMs).filter(Number.isFinite);
  return {
    denominator: rows.length,
    contentPresenceRate: ratio(rows.filter((row) => typeof row.assistantText === "string" && row.assistantText.trim().length > 0).length, rows.length),
    formatComplianceRate: ratio(labelled.length, rows.length),
    predictableScenarioNextLabelPresenceRate: ratio(predictable.filter((row) => row.formatLabels?.hasNextLabel).length, predictable.length),
    uncertainScenarioExactObserveLabelRate: ratio(uncertain.filter((row) => row.formatLabels?.nextSaysObserve).length, uncertain.length),
    uncertainScenarioObservePrefixRate: ratio(uncertain.filter((row) => row.formatLabels?.nextStartsWithObserve).length, uncertain.length),
    safeAbstentionSemanticAccuracy: null,
    currentToolNameMatchRate: ratio(rows.filter((row) => row.currentToolNameMatch === true).length, rows.length),
    currentToolArgumentsMatchRate: ratio(rows.filter((row) => row.currentToolArgumentsMatch === true).length, rows.length),
    averageTotalTokens: mean(usages),
    medianTotalTokens: median(usages),
    averageLatencyMs: mean(latencies),
    medianLatencyMs: median(latencies),
    contentCharacters: {
      average: mean(rows.map((row) => row.assistantText).filter((value) => typeof value === "string").map((value) => value.length)),
      median: median(rows.map((row) => row.assistantText).filter((value) => typeof value === "string").map((value) => value.length)),
    },
  };
}

export function summarizeByVariant(rows) {
  return Object.fromEntries(["A", "B"].map((variant) => [variant, metricSnapshot(rows.filter((row) => row.variant === variant))]));
}

export function redactRequestBody(value) {
  if (Array.isArray(value)) return value.map(redactRequestBody);
  if (value === null || typeof value !== "object") return value;
  const record = value;
  if (typeof record.url === "string" && record.url.startsWith("data:")) {
    const comma = record.url.indexOf(",");
    return { ...record, url: `[omitted synthetic image payload; ${Buffer.byteLength(record.url.slice(comma + 1), "base64")} bytes]` };
  }
  const result = {};
  for (const [key, child] of Object.entries(record)) {
    if (/^(authorization|api[_-]?key|access[_-]?token|token|secret|password)$/iu.test(key)) result[key] = "[redacted]";
    else result[key] = redactRequestBody(child);
  }
  return result;
}

export function assertABBodiesDifferOnlyByPromptSentence(bodyA, bodyB, sentence = PROMPT_SENTENCE) {
  const a = structuredClone(bodyA);
  const b = structuredClone(bodyB);
  const aSystem = a.messages?.find((message) => message.role === "system");
  const bSystem = b.messages?.find((message) => message.role === "system");
  if (typeof aSystem?.content !== "string" || typeof bSystem?.content !== "string") throw new Error("paired request is missing a string system message");
  const marker = ` ${sentence}`;
  const first = bSystem.content.indexOf(marker);
  if (first < 0 || bSystem.content.indexOf(marker, first + marker.length) >= 0) throw new Error("B request must contain the prompt sentence exactly once");
  bSystem.content = `${bSystem.content.slice(0, first)}${bSystem.content.slice(first + marker.length)}`;
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error("A/B request bodies differ beyond the single system prompt sentence");
  return true;
}

export async function buildRunPlan(repeats = 2) {
  if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error("repeats must be a positive integer");
  const scenarios = createScenarios();
  if (scenarios.length * 2 * repeats > MAX_REQUESTS) throw new Error(`planned request count exceeds hard limit ${MAX_REQUESTS}`);
  const registry = createDefaultToolRegistry();
  const compiler = new DefaultContextCompiler(registry, { features: FEATURES });
  const plan = [];
  const requestExamples = [];
  for (let scenarioIndex = 0; scenarioIndex < scenarios.length; scenarioIndex += 1) {
    const scenario = scenarios[scenarioIndex];
    if (scenario === undefined) continue;
    const inputA = await compileScenario(compiler, scenario, "A");
    const inputB = await compileScenario(compiler, scenario, "B");
    const bodyA = await captureProductionBody(inputA);
    const bodyB = await captureProductionBody(inputB);
    bodyA.tool_choice = "auto";
    bodyB.tool_choice = "auto";
    assertABBodiesDifferOnlyByPromptSentence(bodyA, bodyB);
    for (const [variant, body] of [["A", bodyA], ["B", bodyB]]) {
      requestExamples.push({
        scenario: scenario.id,
        variant,
        requestSha256: hashJson(body),
        body: redactRequestBody(body),
      });
    }
    plan.push({ scenarioIndex, scenario, bodies: { A: bodyA, B: bodyB }, inputs: { A: inputA, B: inputB } });
  }
  return { scenarios, plan, requestExamples, plannedRequestCount: plan.length * 2 * repeats };
}

export async function validateStoredToolCalls(rows, plan) {
  const planByScenario = new Map(plan.map((item) => [item.scenario.id, item]));
  const validatedRows = [];
  for (const row of rows) {
    if (row.status !== "ok" || row.finishReason !== "tool_calls" || !Array.isArray(row.toolCalls) || row.toolCalls.length === 0) {
      validatedRows.push({ ...row, providerValidation: { status: "not_applicable" } });
      continue;
    }
    const item = planByScenario.get(row.scenario);
    const input = item?.inputs?.[row.variant];
    if (input === undefined) {
      validatedRows.push({ ...row, providerValidation: { status: "unavailable", reason: "matching compiled input was not found" } });
      continue;
    }
    const response = {
      choices: [{
        finish_reason: row.finishReason,
        message: {
          ...(row.contentType === "string" ? { content: row.assistantText } : {}),
          tool_calls: row.toolCalls.map((call, index) => ({
            id: typeof call.id === "string" && call.id.length > 0 ? call.id : `offline-call-${index}`,
            type: "function",
            function: {
              name: call.name,
              arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {}),
            },
          })),
        },
      }],
      ...(row.usage === null ? {} : { usage: row.usage }),
    };
    const adapter = new GlmAdapter({
      apiKey: "offline-validation-placeholder",
      profile: glmProfiles[MODEL],
      assetReader: { read: async (_asset, signal) => { signal.throwIfAborted(); return SYNTHETIC_PNG; } },
      httpClient: { post: async () => response },
    });
    try {
      const turn = await adapter.generate(input, { signal: new AbortController().signal });
      validatedRows.push({
        ...row,
        providerValidation: {
          status: "accepted",
          turnType: turn.type,
          toolNames: turn.type === "tool_calls" ? turn.calls.map((call) => call.name) : [],
        },
      });
    } catch (error) {
      validatedRows.push({
        ...row,
        providerValidation: {
          status: "rejected",
          errorCode: typeof error?.code === "string" ? error.code : null,
          errorName: typeof error?.name === "string" ? error.name : "Error",
        },
      });
    }
  }
  return validatedRows;
}

async function compileScenario(compiler, scenario, variant) {
  const runId = `assistant-text-probe-${scenario.id}`;
  const sessionId = `assistant-text-session-${scenario.id}`;
  const observationId = `assistant-text-observation-${scenario.id}`;
  const asset = {
    assetId: `assistant-text-asset-${scenario.id}`,
    relativePath: "synthetic-gui.png",
    mediaType: "image/png",
    byteLength: SYNTHETIC_PNG.byteLength,
  };
  const capturedAt = "2026-09-23T00:00:00.000Z";
  const observation = {
    id: observationId,
    runId,
    computerSessionId: sessionId,
    capturedAt,
    viewport: { width: 1200, height: 800, coordinateSpace: "physical" },
    screenshot: asset,
    grounding: {
      version: "grounding-catalog-v2",
      source: "dom",
      observationId,
      computerSessionId: sessionId,
      completeness: "complete",
      degraded: false,
      maxElements: 16,
      elements: scenario.elements,
    },
  };
  const event = {
    eventId: `assistant-text-event-${scenario.id}`,
    runId,
    sequence: 0,
    occurredAt: capturedAt,
    type: "observation.created",
    observation,
  };
  const input = await compiler.compile({
    runId,
    goal: scenario.goal,
    latestObservation: observation,
    recentEvents: [event],
    features: FEATURES,
    enabledToolNames: TOOL_NAMES,
  }, new AbortController().signal);
  if (variant === "B") input.system = `${input.system} ${PROMPT_SENTENCE}`;
  return input;
}

async function captureProductionBody(input) {
  let capturedBody;
  const captureClient = {
    async post(_url, body) {
      capturedBody = structuredClone(body);
      return { choices: [{ finish_reason: "stop", message: { content: "capture-only" } }] };
    },
  };
  const adapter = new GlmAdapter({
    apiKey: "local-capture-placeholder",
    profile: glmProfiles[MODEL],
    assetReader: { read: async (_asset, signal) => { signal.throwIfAborted(); return SYNTHETIC_PNG; } },
    httpClient: captureClient,
  });
  await adapter.generate(input, { signal: new AbortController().signal });
  if (capturedBody === undefined) throw new Error("failed to capture provider request body");
  if (capturedBody.model !== MODEL || capturedBody.thinking?.type !== "enabled" || capturedBody.stream !== false) {
    throw new Error("captured Provider body does not match the required GLM model/thinking/stream settings");
  }
  if (capturedBody.tools?.length !== TOOL_NAMES.length || !TOOL_NAMES.every((name) => capturedBody.tools.some((tool) => tool.function?.name === name))) {
    throw new Error("captured Provider body does not contain exactly click/type/scroll/terminate");
  }
  return capturedBody;
}

function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : Number((numerator / denominator).toFixed(4));
}

function mean(values) {
  return values.length === 0 ? null : Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return Number((sorted.length % 2 === 0 ? ((sorted[middle - 1] + sorted[middle]) / 2) : sorted[middle]).toFixed(2));
}

function safeText(value, limit) {
  if (typeof value !== "string") return value;
  const sanitized = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/giu, "Bearer [redacted]")
    .replace(/((?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*)[^\s,;]+/giu, "$1[redacted]");
  return sanitized.length <= limit ? sanitized : `${sanitized.slice(0, limit)} [truncated; original chars=${sanitized.length}]`;
}

function safeArguments(value) {
  if (typeof value === "string") {
    try {
      return safeArguments(JSON.parse(value));
    } catch {
      return safeText(value, 1200);
    }
  }
  if (Array.isArray(value)) return value.slice(0, 16).map(safeArguments);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 32).map(([key, child]) => [key, safeArguments(child)]));
  }
  return value;
}

function summarizeCalls(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map((call) => ({
    id: typeof call?.id === "string" ? safeText(call.id, 120) : null,
    name: typeof call?.function?.name === "string" ? safeText(call.function.name, 120) : null,
    arguments: safeArguments(call?.function?.arguments),
  }));
}

function numericUsage(usage) {
  if (usage === null || typeof usage !== "object") return null;
  const selected = {};
  for (const name of ["prompt_tokens", "completion_tokens", "total_tokens"]) {
    if (Number.isFinite(usage[name])) selected[name] = usage[name];
  }
  return Object.keys(selected).length === 0 ? null : selected;
}

function contentSummary(content) {
  if (typeof content === "string") return { contentType: "string", contentChars: content.length, assistantText: safeText(content, MAX_ASSISTANT_TEXT_CHARS), assistantTextTruncated: content.length > MAX_ASSISTANT_TEXT_CHARS };
  if (content === null || content === undefined) return { contentType: content === null ? "null" : "missing", contentChars: null, assistantText: null, assistantTextTruncated: false };
  return { contentType: Array.isArray(content) ? "array" : typeof content, contentChars: null, assistantText: null, assistantTextTruncated: false };
}

function summarizeResponse(scenario, variant, repetition, responseValue, latencyMs, httpStatus) {
  const message = responseValue?.choices?.[0]?.message;
  const content = contentSummary(message?.content);
  const calls = summarizeCalls(message?.tool_calls);
  const firstCall = calls[0];
  const formatLabels = extractFormatLabels(content.assistantText);
  return {
    probeVersion: PROBE_VERSION,
    scenario: scenario.id,
    nextStepPredictable: scenario.nextStepPredictable,
    nextStepUncertainty: scenario.nextStepUncertainty ?? null,
    expectedCurrentAction: scenario.expectedCurrent,
    expectedNextAction: scenario.expectedNext,
    variant,
    repetition,
    status: "ok",
    httpStatus,
    finishReason: typeof responseValue?.choices?.[0]?.finish_reason === "string" ? responseValue.choices[0].finish_reason : null,
    ...content,
    toolCalls: calls,
    toolCallCount: Array.isArray(message?.tool_calls) ? message.tool_calls.length : 0,
    currentToolNameMatch: firstCall?.name === scenario.expectedCurrent.toolName,
    currentToolArgumentsMatch: callMatchesExpected(firstCall, scenario.expectedCurrent, scenario.elements),
    formatLabels,
    usage: numericUsage(responseValue?.usage),
    latencyMs,
    semanticReview: { currentAction: "pending_manual_review", nextAction: "pending_manual_review" },
  };
}

async function loadConfiguration(args) {
  const envPath = resolve(args.get("--env-file") ?? ".env");
  let fileEnv = {};
  try {
    fileEnv = parseEnv(await readFile(envPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error("could not read the selected environment file");
  }
  const envValue = (name) => process.env[name] ?? fileEnv[name];
  const apiKey = envValue("ZHIPUAI_API_KEY") ?? envValue("ZHIPU_API_KEY") ?? envValue("GLM_API_KEY");
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) throw new Error("a GLM API key is not configured in the selected environment file or process environment");
  const endpoint = envValue("GLM_ENDPOINT") ?? envValue("GLM_BASE_URL") ?? "https://open.bigmodel.cn/api/paas/v4/chat/completions";
  let endpointUrl;
  try { endpointUrl = new URL(endpoint); } catch { throw new Error("GLM endpoint is not a valid URL"); }
  const timeoutMs = getPositiveInt(args, "--timeout-ms", DEFAULT_TIMEOUT_MS, 1000);
  const repeats = getPositiveInt(args, "--repeats", 2);
  const planned = createScenarios().length * 2 * repeats;
  if (planned > MAX_REQUESTS) throw new Error(`requested ${planned} calls, above the hard limit of ${MAX_REQUESTS}`);
  return { apiKey, endpoint: endpointUrl.toString(), endpointHost: endpointUrl.host, timeoutMs, repeats };
}

async function writeJsonFile(path, value) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path, serialized, "utf8");
  const reread = await readFile(path, "utf8");
  if (reread.includes("\uFFFD") || /\?{4,}/u.test(reread)) throw new Error("UTF-8 verification failed for generated JSON output");
  JSON.parse(reread);
}

async function runProbe(args) {
  if (!args.has("--confirm-live-api")) throw new Error("live GLM calls require --confirm-live-api");
  const configuration = await loadConfiguration(args);
  const { scenarios, plan, requestExamples, plannedRequestCount } = await buildRunPlan(configuration.repeats);
  const outputDir = resolve(args.get("--out") ?? `runs/glm-assistant-text-ab-probe-${new Date().toISOString().replace(/[-:.]/gu, "").replace("T", "-").replace("Z", "")}`);
  await mkdir(outputDir, { recursive: true });
  const config = {
    probeVersion: PROBE_VERSION,
    provider: "GLM",
    model: MODEL,
    thinking: "enabled",
    toolChoice: "auto",
    toolChoiceSource: "Added by the probe after capturing the production Provider body; the current production GLM Adapter omits this field and relies on the endpoint default.",
    toolNames: TOOL_NAMES,
    promptVariants: { A: "compiled production ContextCompiler system prompt", B: `A plus one sentence: ${PROMPT_SENTENCE}` },
    promptChangeOnly: PROMPT_SENTENCE,
    scenarioCount: scenarios.length,
    predictableScenarioCount: scenarios.filter((scenario) => scenario.nextStepPredictable).length,
    uncertainScenarioCount: scenarios.filter((scenario) => !scenario.nextStepPredictable).length,
    repeatsPerVariantAndScenario: configuration.repeats,
    plannedRequestCount,
    hardRequestLimit: MAX_REQUESTS,
    timeoutMsPerRequest: configuration.timeoutMs,
    endpointHost: configuration.endpointHost,
    desktopAccess: "none; synthetic screenshot and synthetic DOM grounding only",
    historicalBaseline: {
      assistantTextNonEmpty: 39,
      nativeToolCallTurns: 39,
      source: "user-provided existing T07/T09 GLM trajectory tally",
      verification: "not re-read by this probe",
      interpretation: "Treat this as Harness baseline; the 6/6 empty content result from a simplified wire probe does not describe the production Harness path.",
    },
    scenarios: scenarios.map((scenario) => ({
      id: scenario.id,
      nextStepPredictable: scenario.nextStepPredictable,
      nextStepUncertainty: scenario.nextStepUncertainty ?? null,
      expectedCurrentAction: scenario.expectedCurrent,
      expectedNextAction: scenario.expectedNext,
      goal: scenario.goal,
    })),
    requestExamples,
    outputSafety: "No API key, request Authorization header, reasoning_content, or raw image bytes are written.",
  };
  await writeJsonFile(resolve(outputDir, "config.json"), config);
  const rowsPath = resolve(outputDir, "rows.jsonl");
  const rows = [];
  await writeFile(rowsPath, "", "utf8");
  for (let repetition = 1; repetition <= configuration.repeats; repetition += 1) {
    for (const item of plan) {
      const variants = (item.scenarioIndex + repetition) % 2 === 0 ? ["A", "B"] : ["B", "A"];
      for (const variant of variants) {
        const body = item.bodies[variant];
        const startedAt = performance.now();
        let row;
        try {
          const response = await fetch(configuration.endpoint, {
            method: "POST",
            headers: { Authorization: `Bearer ${configuration.apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(configuration.timeoutMs),
          });
          const latencyMs = Math.round(performance.now() - startedAt);
          if (!response.ok) {
            row = {
              probeVersion: PROBE_VERSION,
              scenario: item.scenario.id,
              nextStepPredictable: item.scenario.nextStepPredictable,
              expectedCurrentAction: item.scenario.expectedCurrent,
              expectedNextAction: item.scenario.expectedNext,
              variant,
              repetition,
              status: "http_error",
              httpStatus: response.status,
              contentType: "unavailable",
              contentChars: null,
              assistantText: null,
              toolCalls: [],
              usage: null,
              latencyMs,
              errorBodySaved: false,
            };
          } else {
            let responseValue;
            try { responseValue = await response.json(); } catch { responseValue = null; }
            row = responseValue === null
              ? { probeVersion: PROBE_VERSION, scenario: item.scenario.id, nextStepPredictable: item.scenario.nextStepPredictable, expectedCurrentAction: item.scenario.expectedCurrent, expectedNextAction: item.scenario.expectedNext, variant, repetition, status: "invalid_json", httpStatus: response.status, contentType: "unavailable", contentChars: null, assistantText: null, toolCalls: [], usage: null, latencyMs, errorBodySaved: false }
              : summarizeResponse(item.scenario, variant, repetition, responseValue, latencyMs, response.status);
          }
        } catch (error) {
          row = {
            probeVersion: PROBE_VERSION,
            scenario: item.scenario.id,
            nextStepPredictable: item.scenario.nextStepPredictable,
            expectedCurrentAction: item.scenario.expectedCurrent,
            expectedNextAction: item.scenario.expectedNext,
            variant,
            repetition,
            status: error?.name === "TimeoutError" ? "timeout" : "transport_error",
            errorName: typeof error?.name === "string" ? error.name : "Error",
            contentType: "unavailable",
            contentChars: null,
            assistantText: null,
            toolCalls: [],
            usage: null,
            latencyMs: Math.round(performance.now() - startedAt),
            errorMessageSaved: false,
          };
        }
        rows.push(row);
        await appendFile(rowsPath, `${JSON.stringify(row)}\n`, "utf8");
      }
    }
  }
  const report = {
    probeVersion: PROBE_VERSION,
    model: MODEL,
    thinking: "enabled",
    toolChoice: "auto",
    toolChoiceSource: "Added by the probe after capturing the production Provider body; the current production GLM Adapter omits this field and relies on the endpoint default.",
    requestCount: rows.length,
    successfulRequestCount: rows.filter((row) => row.status === "ok").length,
    nativeToolCallCount: rows.filter((row) => row.status === "ok" && row.finishReason === "tool_calls" && row.toolCallCount > 0).length,
    desktopAccess: "none",
    historicalBaseline: config.historicalBaseline,
    byVariant: summarizeByVariant(rows),
    perScenario: scenarios.map((scenario) => ({
      scenario: scenario.id,
      nextStepPredictable: scenario.nextStepPredictable,
      expectedCurrentAction: scenario.expectedCurrent,
      expectedNextAction: scenario.expectedNext,
      rows: rows.filter((row) => row.scenario === scenario.id),
    })),
    semanticReview: "Specific post-success next-action accuracy remains pending manual review; no keyword-based accuracy score was applied.",
    outputFiles: ["config.json", "rows.jsonl", "summary.json"],
  };
  await writeJsonFile(resolve(outputDir, "summary.json"), report);
  process.stdout.write(`${JSON.stringify({ outputDir, ...report }, null, 2)}\n`);
}

async function analyzeExistingResults(args) {
  const outputDir = resolve(args.get("--out") ?? "runs/glm-assistant-text-ab-probe-20260923");
  const configPath = resolve(outputDir, "config.json");
  const rowsPath = resolve(outputDir, "rows.jsonl");
  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    throw new Error("analysis requires a readable config.json in --out");
  }
  const rowText = await readFile(rowsPath, "utf8");
  const rows = rowText.split(/\r?\n/u).filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
  const repeats = getPositiveInt(new Map([["--repeats", config.repeatsPerVariantAndScenario]]), "--repeats", 2);
  const { scenarios, plan } = await buildRunPlan(repeats);
  const labeledRows = rows.map((row) => ({ ...row, formatLabels: extractFormatLabels(row.assistantText) }));
  const validatedRows = await validateStoredToolCalls(labeledRows, plan);
  const validations = validatedRows.map((row) => row.providerValidation).filter((value) => value?.status !== "not_applicable");
  const providerParseValidation = {
    attempted: validations.length,
    accepted: validations.filter((value) => value.status === "accepted").length,
    rejected: validations.filter((value) => value.status === "rejected").length,
    unavailable: validations.filter((value) => value.status === "unavailable").length,
    note: "Saved response tool calls were reconstructed from the bounded, credential-redacted summaries and passed to the local production GlmAdapter parser; no external requests were made during this validation.",
  };
  const toolChoiceSource = "Added by the probe after capturing the production Provider body; the current production GLM Adapter omits this field and relies on the endpoint default.";
  config.toolChoiceSource = toolChoiceSource;
  config.offlineValidation = "Native tool-call responses were revalidated locally from the saved bounded summaries; no API requests were made during analysis.";
  await writeJsonFile(configPath, config);
  const validatedRowsPath = resolve(outputDir, "rows.validated.jsonl");
  await writeFile(validatedRowsPath, `${validatedRows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  const report = {
    probeVersion: config.probeVersion,
    model: config.model,
    thinking: config.thinking,
    toolChoice: config.toolChoice,
    toolChoiceSource,
    requestCount: rows.length,
    httpSuccessCount: rows.filter((row) => row.status === "ok").length,
    nativeToolCallCount: rows.filter((row) => row.status === "ok" && row.finishReason === "tool_calls" && row.toolCallCount > 0).length,
    historicalBaseline: config.historicalBaseline,
    byVariant: summarizeByVariant(validatedRows),
    providerParseValidation,
    perScenario: scenarios.map((scenario) => ({
      scenario: scenario.id,
      nextStepPredictable: scenario.nextStepPredictable,
      expectedCurrentAction: scenario.expectedCurrent,
      expectedNextAction: scenario.expectedNext,
      rows: validatedRows.filter((row) => row.scenario === scenario.id),
    })),
    semanticReview: "Specific post-success next-action accuracy and safe-abstention accuracy remain pending manual review. Content presence, format labels, exact/prefix observe markers, and tool-call agreement are reported separately; no keyword-based accuracy score is applied.",
    outputFiles: ["config.json", "rows.jsonl", "rows.validated.jsonl", "summary.json"],
  };
  await writeJsonFile(resolve(outputDir, "summary.json"), report);
  process.stdout.write(`${JSON.stringify({ outputDir, requestCount: report.requestCount, httpSuccessCount: report.httpSuccessCount, nativeToolCallCount: report.nativeToolCallCount, byVariant: report.byVariant, providerParseValidation, summaryFile: resolve(outputDir, "summary.json") }, null, 2)}\n`);
}

function printHelp() {
  process.stdout.write("Usage: node scripts/glm-assistant-text-ab-probe.mjs --confirm-live-api [--env-file .env] [--out runs/probe-dir] [--repeats 2] [--timeout-ms 60000]\n");
  process.stdout.write("       node scripts/glm-assistant-text-ab-probe.mjs --analyze-only [--out runs/probe-dir]\n");
  process.stdout.write("Runs paired GLM requests from production ContextCompiler/ToolRegistry/Provider request construction, using synthetic GUI observations only. Default design is 6 scenarios x 2 variants x 2 repeats = 24 calls.\n");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.has("--help")) printHelp();
    else if (args.has("--analyze-only")) await analyzeExistingResults(args);
    else if (args.has("--describe")) {
      process.stdout.write(`${JSON.stringify({ probeVersion: PROBE_VERSION, model: MODEL, toolNames: TOOL_NAMES, sentence: PROMPT_SENTENCE, scenarios: createScenarios().map(({ id, nextStepPredictable, expectedCurrent, expectedNext }) => ({ id, nextStepPredictable, expectedCurrent, expectedNext })), plannedRequests: 24, hardRequestLimit: MAX_REQUESTS }, null, 2)}\n`);
    } else await runProbe(args);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "probe failed"}\n`);
    process.exitCode = 1;
  }
}
