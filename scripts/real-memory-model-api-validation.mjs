#!/usr/bin/env node

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DefaultContextCompiler } from "../packages/context/dist/index.js";
import { InMemoryMemoryStore, HybridMemoryRecallService, createMemoryTools } from "../packages/memory/dist/index.js";
import { GlmAdapter, FetchGlmHttpClient, glmProfiles } from "../packages/provider-glm/dist/index.js";
import { Qwen38FlashAdapter, FetchQwenHttpClient } from "../packages/provider-qwen/dist/index.js";
import { DefaultRuntimePolicy, RunController, createDefaultToolRegistry } from "../packages/runtime/dist/index.js";
import { JsonlRunEventWriter, readRuntimeEvents } from "../packages/trajectory/dist/index.js";

const MAX_HTTP_REQUESTS = 3;
const REQUEST_TIMEOUT_MS = 60_000;
const SYNTHETIC_SESSION_ID = "memory-model-api-synthetic-session";
const SYNTHETIC_PNG = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAEklEQVR4nGNgGAWjYBSMAggAAAQQAAFVN1rQAAAAAElFTkSuQmCC", "base64"));

function value(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function required(argv, name) {
  const result = value(argv, name);
  if (result === undefined || result.trim().length === 0) throw new Error(`${name} is required`);
  return result;
}

async function loadEnv(path) {
  const text = await readFile(resolve(path), "utf8");
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let raw = trimmed.slice(separator + 1).trim();
    if ((raw.startsWith("\"") && raw.endsWith("\"")) || (raw.startsWith("'") && raw.endsWith("'"))) raw = raw.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = raw;
  }
}

function safeText(value, limit = 240) {
  return String(value)
    .slice(0, limit)
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/giu, "$1[redacted]")
    .replace(/(bearer\s+)[A-Za-z0-9._~+\-/]+=*/giu, "$1[redacted]")
    .replace(/([?&](?:api[_-]?key|access[_-]?token|auth(?:orization)?|token|secret|password|signature|sig)=)[^&\s]+/giu, "$1[redacted]")
    .replace(/((?:api[_-]?key|access[_-]?token|auth(?:orization)?|token|secret|password|signature|sig)\s*[:=]\s*)[^\s,;]+/giu, "$1[redacted]");
}

function safeError(error) {
  if (!(error instanceof Error)) return { name: "Error", message: safeText(error) };
  const candidate = error;
  const code = typeof candidate.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/u.test(candidate.code) ? candidate.code : undefined;
  return { name: candidate.name, ...(code === undefined ? {} : { code }), message: safeText(candidate.message) };
}

function toolNames(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) => tool && typeof tool === "object" && tool.function && typeof tool.function.name === "string" ? [tool.function.name] : []);
}

function bodySummary(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const strictNames = body?.response_format?.json_schema?.schema?.properties?.calls?.items?.properties?.name?.enum;
  const presentedTools = body?.tools ?? (Array.isArray(strictNames) ? strictNames.map((name) => ({ function: { name } })) : []);
  const toolResultCallIds = messages.flatMap((message) => {
    if (!message || typeof message !== "object") return [];
    if (message.role === "tool" && typeof message.tool_call_id === "string") return [message.tool_call_id];
    return [];
  });
  return {
    model: typeof body?.model === "string" ? body.model : "unknown",
    toolNames: toolNames(presentedTools),
    messageCount: messages.length,
    messageRoles: messages.map((message) => message && typeof message === "object" && typeof message.role === "string" ? message.role : "unknown"),
    toolResultCallIds,
    bodyTextLength: JSON.stringify(body ?? {}).length,
    hasMemorySearch: JSON.stringify(body ?? {}).includes("memory_search"),
    hasMemoryGet: JSON.stringify(body ?? {}).includes("memory_get"),
  };
}

function summarizeResponse(value) {
  const choice = value && typeof value === "object" && Array.isArray(value.choices) ? value.choices[0] : undefined;
  const message = choice && typeof choice.message === "object" ? choice.message : undefined;
  return {
    finishReason: choice && typeof choice.finish_reason === "string" ? choice.finish_reason : null,
    toolCalls: Array.isArray(message?.tool_calls) ? message.tool_calls.map((call) => ({ id: call?.id ?? null, name: call?.function?.name ?? null })) : [],
    contentLength: typeof message?.content === "string" ? message.content.length : 0,
    usage: value?.usage && typeof value.usage === "object" ? value.usage : null,
  };
}

class RecordingHttpClient {
  constructor(provider, inner, path, maxRequests) {
    this.provider = provider;
    this.inner = inner;
    this.path = path;
    this.maxRequests = maxRequests;
    this.requestCount = 0;
    this.attempts = [];
  }

  async post(url, body, headers, signal) {
    if (this.requestCount >= this.maxRequests) throw new Error("MODEL_PROTOCOL_HTTP_BUDGET_EXHAUSTED");
    this.requestCount += 1;
    const request = this.requestCount;
    const started = Date.now();
    const summary = bodySummary(body);
    try {
      const response = await this.inner.post(url, body, headers, signal);
      const attempt = { provider: this.provider, request, latencyMs: Date.now() - started, requestShape: summary, response: summarizeResponse(response) };
      this.attempts.push(attempt);
      await appendFile(this.path, `${JSON.stringify(attempt)}\n`, "utf8");
      return response;
    } catch (error) {
      const attempt = { provider: this.provider, request, latencyMs: Date.now() - started, requestShape: summary, error: safeError(error) };
      this.attempts.push(attempt);
      await appendFile(this.path, `${JSON.stringify(attempt)}\n`, "utf8");
      throw error;
    }
  }
}

class SyntheticAssetStore {
  constructor() {
    this.assets = new Map();
  }

  async put(input) {
    this.assets.set(input.assetId, input.data);
    return { assetId: input.assetId, relativePath: input.relativePath, mediaType: input.mediaType, byteLength: input.data.length };
  }

  async read(ref) {
    return this.assets.get(ref.assetId) ?? new Uint8Array([0]);
  }
}

class SyntheticComputer {
  constructor() {
    this.session = {
      id: SYNTHETIC_SESSION_ID,
      backend: "synthetic-memory-only",
      viewport: { width: 1, height: 1, coordinateSpace: "physical" },
      capabilities: { screenshot: true, pointer: false, keyboard: false, accessibility: false },
      openedAt: "2026-09-18T00:00:00.000Z",
    };
  }

  async open(_options, signal) {
    signal.throwIfAborted();
    return this.session;
  }

  async observe(_session, _observationId, signal) {
    signal.throwIfAborted();
    return { capturedAt: "2026-09-18T00:00:00.000Z", viewport: this.session.viewport, screenshot: { mediaType: "image/png", data: SYNTHETIC_PNG } };
  }

  async execute(_session, action, _signal) {
    return { actionId: action.actionId, status: "refused", driverCode: "SYNTHETIC_MEMORY_ONLY", message: "GUI execution is disabled for this probe" };
  }

  async close(_session) {}
}

class SeedThenNoRetryProvider {
  constructor(live, providerName) {
    this.id = live.id;
    this.live = live;
    this.providerName = providerName;
    this.seeded = false;
  }

  async generate(input, options) {
    options.signal.throwIfAborted();
    if (!this.seeded) {
      this.seeded = true;
      return {
        type: "tool_calls",
        calls: [
          { id: "synthetic-seed-admitted", name: "memory_write_fact", arguments: { key: "current_task_fact", value: "ADMITTED_SYNTHETIC_FACT", retentionClass: "stable" } },
          { id: "synthetic-seed-recheck", name: "memory_write_fact", arguments: { key: "old_task_fact", value: "RECHECK_ONLY_OLD_FACT", retentionClass: "short_lived" } },
        ],
      };
    }
    try {
      return await this.live.generate(input, options);
    } catch (error) {
      // RunController has a retry loop for retryable ProviderErrors.  This
      // probe deliberately converts transport/parse failure to one bounded,
      // non-retryable diagnostic so no automatic retry can consume budget.
      const details = safeError(error);
      const wrapped = new Error(`${this.providerName} model protocol failure: ${details.code ?? details.name}`);
      Object.assign(wrapped, { retryable: false, code: `MODEL_PROTOCOL_${this.providerName.toUpperCase()}_FAILED` });
      throw wrapped;
    }
  }
}

function redactToolArguments(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const key of ["query", "id", "key", "view"]) if (typeof value[key] === "string") result[key] = value[key];
  return result;
}

function summarizeMemoryOutput(output) {
  if (!output || typeof output !== "object" || Array.isArray(output)) return undefined;
  const result = output;
  const summarizeFact = (entry) => {
    const fact = entry && typeof entry === "object" && entry.fact && typeof entry.fact === "object" ? entry.fact : entry;
    if (!fact || typeof fact !== "object") return undefined;
    return {
      id: typeof fact.id === "string" ? fact.id : undefined,
      key: typeof fact.key === "string" ? fact.key : undefined,
      status: typeof fact.status === "string" ? fact.status : undefined,
      retentionClass: typeof fact.retentionClass === "string" ? fact.retentionClass : undefined,
      reason: entry && typeof entry.reason === "string" ? entry.reason : undefined,
    };
  };
  return {
    admittedFacts: Array.isArray(result.admittedFacts) ? result.admittedFacts.map(summarizeFact).filter(Boolean) : [],
    revalidationCandidates: Array.isArray(result.revalidationCandidates) ? result.revalidationCandidates.map(summarizeFact).filter(Boolean) : [],
    diagnostics: result.diagnostics && typeof result.diagnostics === "object" ? {
      actualMethod: result.diagnostics.actualMethod,
      semanticStatus: result.diagnostics.semanticStatus,
      lexicalHitCount: result.diagnostics.lexicalHitCount,
    } : undefined,
  };
}

function createRecallService() {
  return new HybridMemoryRecallService(undefined, { maxCandidates: 8, maxAdmittedFacts: 4, maxRevalidationFacts: 2, deadlineMs: 750 });
}

function createMemoryRecallAdapter(service) {
  return {
    async search(state, query, signal) {
      const result = await service.search(state, query, signal);
      return {
        method: result.trace.method,
        semanticStatus: result.trace.semanticStatus,
        stateStable: result.trace.stateStable,
        embeddingBudgetUsed: result.trace.embeddingBudgetUsed,
        embeddingBudgetLimit: result.trace.embeddingBudgetLimit,
        admitted: result.trace.admitted,
        revalidation: result.trace.revalidation,
        excluded: result.trace.excluded,
      };
    },
  };
}

function summarizeEvents(events, requestCount, attempts, maxRequests) {
  const toolCalls = events
    .filter((event) => event.type === "model.response.received" && event.turn.type === "tool_calls")
    .flatMap((event) => event.turn.calls.map((call) => ({ name: call.name, arguments: redactToolArguments(call.arguments) })));
  const toolResults = events
    .filter((event) => event.type === "tool.call.completed" && ["memory_search", "memory_get"].includes(event.result.callId))
    .map((event) => summarizeMemoryOutput(event.result.output))
    .filter(Boolean);
  const memoryResults = events
    .filter((event) => event.type === "tool.call.completed" && event.result.status === "completed")
    .map((event) => ({ callId: event.result.callId, output: summarizeMemoryOutput(event.result.output) }))
    .filter((entry) => entry.output !== undefined);
  const finishes = events
    .filter((event) => event.type === "model.response.received" && event.turn.type === "finish")
    .map((event) => ({ summary: safeText(event.turn.summary), reportedStatus: event.turn.reportedStatus ?? null, usage: event.turn.usage ?? null }));
  return {
    httpRequestCount: requestCount,
    httpBudgetLimit: maxRequests,
    httpAttempts: attempts,
    modelRequestStarted: events.filter((event) => event.type === "model.request.started").length,
    toolCalls,
    memoryResults,
    finishes,
    turnPolicy: {
      planningEnabled: false,
      computerActionEvents: events.filter((event) => event.type === "action.execution.started" || event.type === "action.proposed").length,
      memorySearchCalled: toolCalls.some((call) => call.name === "memory_search"),
      memoryGetCalled: toolCalls.some((call) => call.name === "memory_get"),
      noGuiExecution: !events.some((event) => event.type === "action.execution.started" || event.type === "action.proposed"),
    },
  };
}

async function runProvider(providerName, envFile, outputRoot, maxRequests) {
  await loadEnv(envFile);
  const providerDir = resolve(outputRoot, providerName);
  await mkdir(providerDir, { recursive: true });
  const runId = `memory-model-api-${providerName.replaceAll(".", "-")}`;
  const attemptsPath = resolve(providerDir, "http-attempts.jsonl");
  const assets = new SyntheticAssetStore();
  const retrieval = createRecallService();
  const memoryStore = new InMemoryMemoryStore();
  const registry = createDefaultToolRegistry();
  registry.registerMany(createMemoryTools(memoryStore, "facts", { retrieval }));
  const contextCompiler = new DefaultContextCompiler(registry, {
    memoryRecall: createMemoryRecallAdapter(retrieval),
    features: { planning: "off", memory: "facts-v1", batching: "off" },
    maxHistoryEvents: 24,
    maxInputTokens: 8_000,
  });
  const client = providerName === "glm-5.3-flash"
    ? new RecordingHttpClient(providerName, new FetchGlmHttpClient({ requestTimeoutMs: REQUEST_TIMEOUT_MS }), attemptsPath, maxRequests)
    : new RecordingHttpClient(providerName, new FetchQwenHttpClient({ requestTimeoutMs: REQUEST_TIMEOUT_MS }), attemptsPath, maxRequests);
  const assetReader = assets;
  const live = providerName === "glm-5.3-flash"
    ? new GlmAdapter({ apiKey: process.env.ZHIPU_API_KEY ?? "", profile: { ...glmProfiles["glm-5.3-flash"], thinking: "disabled" }, assetReader, httpClient: client, ...(process.env.GLM_ENDPOINT === undefined ? {} : { endpoint: process.env.GLM_ENDPOINT }) })
    : new Qwen38FlashAdapter({ apiKey: process.env.DASHSCOPE_API_KEY ?? "", assetReader, httpClient: client, thinking: "low", outputMode: "strict_json", ...(process.env.DASHSCOPE_ENDPOINT === undefined ? {} : { endpoint: process.env.DASHSCOPE_ENDPOINT }), ...(process.env.DASHSCOPE_WORKSPACE_ID === undefined ? {} : { workspaceId: process.env.DASHSCOPE_WORKSPACE_ID }) });
  const provider = new SeedThenNoRetryProvider(live, providerName);
  const writer = new JsonlRunEventWriter(resolve(providerDir, "trajectory.jsonl"), runId);
  const controller = new RunController({
    runId,
    provider,
    computer: new SyntheticComputer(),
    contextCompiler,
    toolRegistry: registry,
    enabledCategories: ["side", "control"],
    features: { planning: "off", memory: "facts-v1", batching: "off" },
    policy: new DefaultRuntimePolicy(12, 4),
    eventWriter: writer,
    assetStore: assets,
  });
  const goal = "Synthetic Memory protocol validation with Planning disabled. There is no current Plan or GUI task. First call memory_search with query `task fact` for a non-current task. The search result must distinguish admitted current facts from the old revalidation candidate. On the next turn, answer and finish using only an admitted fact; never state the revalidation old value as a current fact. Do not call computer tools. Do not call memory_get unless the search result is insufficient.";
  let outcome = "threw";
  let harnessError;
  const startedAt = Date.now();
  try {
    outcome = await controller.start(goal);
  } catch (error) {
    harnessError = safeError(error);
  }
  const events = await readRuntimeEvents(resolve(providerDir, "trajectory.jsonl"));
  const summary = {
    provider: providerName,
    outcome,
    latencyMs: Date.now() - startedAt,
    ...(harnessError === undefined ? {} : { harnessError }),
    ...summarizeEvents(events, client.requestCount, client.attempts, maxRequests),
    runFinished: events.filter((event) => event.type === "run.finished").map((event) => ({ outcome: event.outcome, summary: event.summary ?? null })),
    syntheticSeed: { admittedKey: "current_task_fact", revalidationKey: "old_task_fact", revalidationClass: "short_lived" },
    noRealDesktop: true,
  };
  await writeFile(resolve(providerDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return summary;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write("Usage: node scripts/real-memory-model-api-validation.mjs --model glm-5.3-flash|qwen3.8-flash|all --env-file <path> --output <dir> [--max-http-requests 1..3]\n");
    return;
  }
  const model = required(argv, "--model");
  const envFile = required(argv, "--env-file");
  const output = resolve(required(argv, "--output"));
  const maxRequestsText = value(argv, "--max-http-requests");
  const maxRequests = maxRequestsText === undefined ? MAX_HTTP_REQUESTS : Number(maxRequestsText);
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > MAX_HTTP_REQUESTS) {
    throw new Error(`--max-http-requests must be an integer from 1 to ${MAX_HTTP_REQUESTS}`);
  }
  if (!["glm-5.3-flash", "qwen3.8-flash", "all"].includes(model)) throw new Error("--model must be glm-5.3-flash, qwen3.8-flash, or all");
  const providers = model === "all" ? ["glm-5.3-flash", "qwen3.8-flash"] : [model];
  const results = [];
  for (const provider of providers) results.push(await runProvider(provider, envFile, output, maxRequests));
  process.stdout.write(`${JSON.stringify(results.map((result) => ({ provider: result.provider, outcome: result.outcome, httpRequestCount: result.httpRequestCount, memorySearchCalled: result.turnPolicy.memorySearchCalled, noGuiExecution: result.turnPolicy.noGuiExecution })), null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
