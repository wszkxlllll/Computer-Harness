import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { DefaultContextCompiler } from "../packages/context/dist/index.js";
import { GlmAdapter, FetchGlmHttpClient, glmProfiles } from "../packages/provider-glm/dist/index.js";
import { createExecutionSegmentTools, InMemoryPlanStore, createPlanningTools } from "../packages/planning/dist/index.js";
import { createDefaultToolRegistry } from "../packages/runtime/dist/index.js";
import { summarizeExecutionSegmentRows } from "./execution-segment-api-conformance-metrics.mjs";

const PROBE_VERSION = "glm-execution-segment-api-conformance-v1";
const MAX_REQUESTS = 12;
const PNG_1X1 = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
  0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137,
  0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 207, 192, 240,
  31, 0, 5, 0, 1, 255, 137, 153, 61, 29, 0, 0, 0, 0, 73, 69,
  78, 68, 174, 66, 96, 130,
]);

if (process.argv.includes("--help")) {
  process.stdout.write("Usage: node scripts/real-execution-segment-api-conformance.mjs --confirm-live-api [--env-file .env] [--out runs/execution-segment-api-conformance] [--timeout-ms 30000] [--thinking disabled|enabled]\n");
  process.stdout.write("Uses the production GLM adapter, Context compiler, ToolRegistry, and execution-segment prompt with a synthetic in-memory observation; it never opens or controls a desktop.\n");
  process.exit(0);
}
if (!process.argv.includes("--confirm-live-api")) {
  throw new Error("real execution-segment probe requires --confirm-live-api");
}

const args = parseArgs(process.argv.slice(2));
const envFile = resolve(args.get("--env-file") ?? ".env");
const outputDir = resolve(args.get("--out") ?? `runs/execution-segment-api-conformance-${stamp()}`);
const timeoutMs = parsePositiveInt(args.get("--timeout-ms") ?? "120000", "--timeout-ms");
const thinking = args.get("--thinking") ?? "disabled";
if (thinking !== "disabled" && thinking !== "enabled") throw new Error("--thinking must be disabled or enabled");
const env = parseEnv(await readFile(envFile, "utf8"));
const apiKey = envValue(env, "ZHIPUAI_API_KEY") ?? envValue(env, "ZHIPU_API_KEY") ?? envValue(env, "GLM_API_KEY");
if (apiKey === undefined) throw new Error("a GLM API key is not configured in the selected env file");

const scenarios = createScenarios();
const productionRows = await runVariant("production", scenarios, undefined, apiKey, timeoutMs, thinking);
let rows = productionRows;
if (productionRows.every((row) => Number(row.segmentCallCount ?? 0) === 0) && productionRows.some((row) => row.status === "ok")) {
  // This is intentionally a probe-only A/B sentence. It does not modify the
  // production compiler or provider prompt.
  const sentence = "When 2-4 stable click micro-steps are clearly predictable, you may call execution_segment_set in the same turn before the GUI actions.";
  const abRows = await runVariant("ab_minimal_segment_hint", scenarios, sentence, apiKey, timeoutMs, thinking);
  rows = [...productionRows, ...abRows];
}
if (rows.length > MAX_REQUESTS) throw new Error(`probe exceeded request limit: ${rows.length}`);

const summary = summarizeExecutionSegmentRows(rows);
const report = {
  probeVersion: PROBE_VERSION,
  provider: "glm-5.3-flash",
  thinking,
  promptSource: "DefaultContextCompiler + features.executionSegments=segments-v1",
  requestLimit: MAX_REQUESTS,
  requestCount: rows.filter((row) => row.status !== "skipped").length,
  desktopAccess: "none; synthetic ObservationFrame and in-memory AssetReader only",
  outputSafety: "rows contain redacted model-turn summaries only; no API key, image bytes, or reasoning content",
  summary,
};

await mkdir(outputDir, { recursive: true });
await writeFile(resolve(outputDir, "rows.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
await writeFile(resolve(outputDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
await writeFile(resolve(outputDir, "config.json"), `${JSON.stringify({
  probeVersion: PROBE_VERSION,
  provider: "glm-5.3-flash",
  thinking,
  featureConfig: { planning: "tasks-v1", executionSegments: "segments-v1", memory: "off", batching: "off", riskGuard: "off", monitor: "off" },
  scenarioCount: scenarios.length,
  promptVariants: [...new Set(rows.map((row) => row.promptVariant))],
  requestCount: rows.filter((row) => row.status !== "skipped").length,
  timeoutMs,
  desktopAccess: "none",
}, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

async function runVariant(promptVariant, scenariosToRun, promptSuffix, apiKeyValue, timeout, thinkingMode) {
  const rowsForVariant = [];
  const reader = { read: async (_ref, signal) => { signal.throwIfAborted(); return PNG_1X1; } };
  const adapter = new GlmAdapter({
    apiKey: apiKeyValue,
    profile: { ...glmProfiles["glm-5.3-flash"], thinking: thinkingMode },
    assetReader: reader,
    httpClient: new FetchGlmHttpClient({ requestTimeoutMs: timeout }),
    ...(envValue(env, "GLM_ENDPOINT") === undefined ? {} : { endpoint: envValue(env, "GLM_ENDPOINT") }),
  });
  for (const scenario of scenariosToRun) {
    const input = await compileScenario(scenario, promptSuffix);
    const startedAt = performance.now();
    let turn;
    let error;
    try {
      turn = await adapter.generate(input, { signal: AbortSignal.timeout(timeout + 1000) });
    } catch (caught) {
      error = describeError(caught);
    }
    const latencyMs = Math.round(performance.now() - startedAt);
    rowsForVariant.push(summarizeTurn({ scenario, promptVariant, turn, error, latencyMs, input }));
  }
  return rowsForVariant;
}

async function compileScenario(scenario, promptSuffix) {
  const registry = createDefaultToolRegistry();
  registry.registerMany(createPlanningTools(new InMemoryPlanStore()));
  registry.registerMany(createExecutionSegmentTools());
  const baseFeatures = { planning: "tasks-v1", executionSegments: "segments-v1", memory: "off", batching: "off", riskGuard: "off", monitor: "off" };
  const compiler = new DefaultContextCompiler(registry, { features: baseFeatures });
  const runId = `segment-probe-${scenario.id}`;
  const sessionId = `segment-probe-session-${scenario.id}`;
  const observationId = `segment-probe-observation-${scenario.id}`;
  const asset = { assetId: `segment-probe-asset-${scenario.id}`, relativePath: "synthetic-observation.png", mediaType: "image/png", byteLength: PNG_1X1.byteLength };
  const observation = {
    id: observationId,
    runId,
    computerSessionId: sessionId,
    capturedAt: "2026-09-24T00:00:00.000Z",
    viewport: { width: 1200, height: 800, coordinateSpace: "physical" },
    screenshot: asset,
    grounding: {
      version: "grounding-catalog-v2",
      source: "hybrid",
      observationId,
      computerSessionId: sessionId,
      completeness: "complete",
      degraded: false,
      maxElements: 16,
      elements: scenario.elements,
    },
  };
  const events = [{
    eventId: `segment-probe-event-${scenario.id}`,
    runId,
    sequence: 0,
    occurredAt: observation.capturedAt,
    type: "observation.created",
    observation,
  }];
  const compiled = await compiler.compile({
    runId,
    goal: scenario.goal,
    latestObservation: observation,
    recentEvents: events,
    features: baseFeatures,
  }, new AbortController().signal);
  if (promptSuffix !== undefined) compiled.system = `${compiled.system} ${promptSuffix}`;
  return compiled;
}

function summarizeTurn({ scenario, promptVariant, turn, error, latencyMs, input }) {
  const calls = turn?.type === "tool_calls" ? turn.calls : [];
  const segmentCalls = calls.filter((call) => call.name === "execution_segment_set");
  const otherCalls = calls.filter((call) => call.name !== "execution_segment_set");
  const segmentDefinition = input.tools.find((tool) => tool.name === "execution_segment_set");
  const segmentValidation = segmentCalls.map((call) => validateSegmentCall(call, segmentDefinition));
  const segmentArgsValid = segmentCalls.length === 0 ? null : segmentValidation.every((item) => item.valid);
  return {
    probeVersion: PROBE_VERSION,
    scenario: scenario.id,
    expectedCreate: scenario.expectedCreate,
    promptVariant,
    status: error === undefined ? "ok" : "error",
    turnType: turn?.type ?? null,
    segmentCallCount: segmentCalls.length,
    segmentArgsValid,
    segmentValidation,
    otherCallNames: otherCalls.map((call) => call.name),
    callCount: calls.length,
    assistantText: turn?.type === "tool_calls" ? boundedText(turn.assistantText) : null,
    latencyMs,
    usage: turn?.usage ?? {},
    error: error ?? null,
  };
}

function validateSegmentCall(call, definition) {
  if (definition === undefined) return { valid: false, error: "tool definition missing" };
  try {
    definition.validate(call.arguments);
    return { valid: true, argumentKeys: isRecord(call.arguments) ? Object.keys(call.arguments).sort() : [] };
  } catch (error) {
    return { valid: false, error: sanitizeText(error instanceof Error ? error.message : String(error)) };
  }
}

function createScenarios() {
  return [
    {
      id: "create-filter-chain",
      expectedCreate: true,
      goal: "In the currently open ticket search panel, click the date filter, then click the morning time option, then click the apply filter button.",
      elements: [element("date-filter", "Button", "日期筛选", "打开日期筛选"), element("morning", "Option", "上午", "选择上午车次"), element("apply-filter", "Button", "应用筛选", "应用当前筛选"), element("help", "Link", "帮助", "查看帮助")],
    },
    {
      id: "create-city-chain",
      expectedCreate: true,
      goal: "On the stable ticket search form, click the departure-city selector, then click Shanghai in the visible city list, then click the arrival-city selector.",
      elements: [element("departure", "ComboBox", "出发城市", "选择出发城市"), element("shanghai", "Option", "上海", "选择上海"), element("arrival", "ComboBox", "到达城市", "选择到达城市"), element("search", "Button", "搜索车票", "搜索车票")],
    },
    {
      id: "create-tab-chain",
      expectedCreate: true,
      goal: "In this stable single-page panel, click the train tab, then click the direct-train filter, then click the search button. Each click has visible completion text.",
      elements: [element("train-tab", "Tab", "火车", "切换到火车"), element("direct", "Checkbox", "直达", "只看直达车次"), element("search", "Button", "搜索", "开始搜索"), element("flight-tab", "Tab", "飞机", "切换到飞机")],
    },
    {
      id: "no-type",
      expectedCreate: false,
      goal: "The departure-city input is already focused. Type 上海 into it. Do not click other controls and do not create a click execution segment.",
      elements: [element("departure", "Edit", "出发城市", "输入出发城市", { focused: true, editable: true }), element("search", "Button", "搜索", "搜索车票")],
    },
    {
      id: "no-scroll",
      expectedCreate: false,
      goal: "Scroll down to reveal more train results. Scrolling is required; do not predefine a click-only execution segment.",
      elements: [element("results", "List", "车次结果", "当前车次结果"), element("help", "Link", "帮助", "查看帮助")],
    },
    {
      id: "no-sensitive-uncertain",
      expectedCreate: false,
      goal: "Review the checkout page and, only if the fare and passenger details are correct, submit the purchase. This is sensitive and uncertain; do not pre-authorize or batch clicks.",
      elements: [element("fare", "Text", "票价", "当前票价"), element("submit", "Button", "提交订单", "提交并支付"), element("cancel", "Button", "取消", "取消订单")],
    },
  ];
}

function element(elementRef, role, name, description, state = {}) {
  const hash = [...elementRef].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return {
    elementRef,
    role,
    name,
    description,
    bbox: { x: 80 + (hash % 600), y: 120 + (hash % 400), width: 140, height: 40, coordinateSpace: "physical" },
    state: { enabled: true, focused: false, editable: false, ...state },
    source: "dom",
    browserRegion: "content",
  };
}

function parseArgs(argv) {
  const result = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--confirm-live-api") continue;
    if (typeof key !== "string" || !key.startsWith("--")) throw new Error(`unexpected argument: ${String(key)}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${key} requires a value`);
    result.set(key, value);
    index += 1;
  }
  return result;
}

function parsePositiveInt(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1000) throw new Error(`${name} must be an integer >= 1000`);
  return parsed;
}

function parseEnv(text) {
  const result = {};
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals <= 0) continue;
    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    result[key] = value;
  }
  return result;
}

function envValue(env, key) {
  const value = process.env[key] ?? env[key];
  return value?.trim() === "" ? undefined : value?.trim();
}

function describeError(error) {
  const code = error && typeof error === "object" && typeof error.code === "string" ? error.code : "PROVIDER_ERROR";
  return { code, message: sanitizeText(error instanceof Error ? error.message : String(error)) };
}

function sanitizeText(value) {
  return value.slice(0, 240)
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/giu, "$1[redacted]")
    .replace(/(bearer\s+)[A-Za-z0-9._~+\-/]+=*/giu, "$1[redacted]")
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/giu, "$1[redacted]");
}

function boundedText(value) {
  if (typeof value !== "string") return null;
  return sanitizeText(value).slice(0, 240);
}

function stamp() {
  return new Date().toISOString().replace(/[-:TZ.]/gu, "").slice(0, 14);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
