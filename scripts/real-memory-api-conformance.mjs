#!/usr/bin/env node

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { DefaultContextCompiler } from "../packages/context/dist/index.js";
import { InMemoryMemoryStore, createMemoryTools } from "../packages/memory/dist/index.js";
import { GlmAdapter, FetchGlmHttpClient, glmProfiles } from "../packages/provider-glm/dist/index.js";
import { Qwen38FlashAdapter, FetchQwenHttpClient } from "../packages/provider-qwen/dist/index.js";
import { DefaultRuntimePolicy, RunController, createDefaultToolRegistry } from "../packages/runtime/dist/index.js";
import { FileAssetStore, JsonlRunEventWriter, readRuntimeEvents, reduceRuntimeEvents } from "../packages/trajectory/dist/index.js";

const PNG = makePng(64, 64);

function makePng(width, height) {
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]));
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const value of data) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

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
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const raw = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (process.env[key] === undefined) process.env[key] = raw;
  }
}

class RecordingClient {
  constructor(provider, path) {
    this.provider = provider;
    this.path = path;
    this.request = 0;
    this.inner = provider === "glm-5.3-flash" ? new FetchGlmHttpClient() : new FetchQwenHttpClient();
  }

  async post(url, body, headers, signal) {
    this.request += 1;
    const started = Date.now();
    try {
      const response = await this.inner.post(url, body, headers, signal);
      await appendFile(this.path, `${JSON.stringify({ provider: this.provider, request: this.request, latencyMs: Date.now() - started, model: body.model, toolNames: toolNames(body.tools), response: summarizeResponse(response) })}\n`, "utf8");
      return response;
    } catch (error) {
      await appendFile(this.path, `${JSON.stringify({ provider: this.provider, request: this.request, latencyMs: Date.now() - started, model: body.model, transportError: safeError(error) })}\n`, "utf8");
      throw error;
    }
  }
}

class FakeComputer {
  constructor() {
    this.session = {
      id: "memory-api-fake-session",
      backend: "fake-no-gui",
      viewport: { width: 64, height: 64, coordinateSpace: "physical" },
      capabilities: { screenshot: true, pointer: false, keyboard: false, accessibility: false },
      openedAt: new Date().toISOString(),
    };
  }

  async open(_options, signal) {
    signal.throwIfAborted();
    return this.session;
  }

  async observe(_session, _observationId, signal) {
    signal.throwIfAborted();
    return { capturedAt: new Date().toISOString(), viewport: this.session.viewport, screenshot: { mediaType: "image/png", data: PNG } };
  }

  async execute(_session, action, _signal) {
    return { actionId: action.actionId, status: "refused", driverCode: "FAKE_GUI_DISABLED", message: "memory API conformance never dispatches GUI actions" };
  }

  async close(_session) {}
}

function toolNames(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => item && typeof item === "object" && item.function && typeof item.function.name === "string" ? [item.function.name] : []);
}

function summarizeResponse(value) {
  const choice = value && typeof value === "object" && Array.isArray(value.choices) ? value.choices[0] : undefined;
  const message = choice && typeof choice.message === "object" ? choice.message : undefined;
  return {
    finishReason: choice && typeof choice.finish_reason === "string" ? choice.finish_reason : null,
    toolCalls: Array.isArray(message?.tool_calls) ? message.tool_calls.map((call) => ({ id: call?.id ?? null, name: call?.function?.name ?? null })) : [],
    contentLength: typeof message?.content === "string" ? message.content.length : 0,
    ...(typeof message?.content === "string" ? { contentPreview: message.content.slice(0, 240).replace(/\s+/gu, " ") } : {}),
    usage: value?.usage && typeof value.usage === "object" ? value.usage : null,
  };
}

function safeError(error) {
  return error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) };
}

function summarizeToolCalls(events) {
  return events.filter((event) => event.type === "model.response.received" && event.turn.type === "tool_calls")
    .flatMap((event) => event.turn.calls.map((call) => ({ name: call.name, arguments: redactArguments(call.arguments) })));
}

function redactArguments(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const key of ["key", "entityId", "factId", "type", "status"]) {
    if (typeof value[key] === "string") result[key] = value[key];
  }
  if (typeof value.value === "string") result.valueLength = value.value.length;
  if (typeof value.description === "string") result.descriptionLength = value.description.length;
  return result;
}

async function run(providerName, mode, envFile, output) {
  const runId = `memory-api-${providerName.replaceAll(".", "-")}-${mode}-${Date.now()}`;
  await mkdir(output, { recursive: true });
  await loadEnv(envFile);
  const exchanges = resolve(output, "provider-exchanges.jsonl");
  const client = new RecordingClient(providerName, exchanges);
  const memoryStore = new InMemoryMemoryStore();
  const registry = createDefaultToolRegistry();
  registry.registerMany(createMemoryTools(memoryStore, mode === "entities" ? "entities" : "facts"));
  const assetStore = new FileAssetStore(resolve(output, "assets"));
  const provider = providerName === "glm-5.3-flash"
    ? new GlmAdapter({ apiKey: process.env.ZHIPU_API_KEY ?? "", profile: { ...glmProfiles["glm-5.3-flash"], thinking: "disabled" }, assetReader: assetStore, httpClient: client, ...(process.env.GLM_ENDPOINT === undefined ? {} : { endpoint: process.env.GLM_ENDPOINT }) })
    : new Qwen38FlashAdapter({ apiKey: process.env.DASHSCOPE_API_KEY ?? "", assetReader: assetStore, httpClient: client, thinking: "low", coordinateMode: "normalized_1000", outputMode: "strict_json", ...(process.env.DASHSCOPE_ENDPOINT === undefined ? {} : { endpoint: process.env.DASHSCOPE_ENDPOINT }), ...(process.env.DASHSCOPE_WORKSPACE_ID === undefined ? {} : { workspaceId: process.env.DASHSCOPE_WORKSPACE_ID }) });
  const eventWriter = new JsonlRunEventWriter(resolve(output, "trajectory.jsonl"), runId);
  const compiler = new DefaultContextCompiler(registry, { features: { planning: "off", memory: mode === "entities" ? "entities-v1" : "facts-v1", batching: "off" } });
  const controller = new RunController({
    runId,
    provider,
    computer: new FakeComputer(),
    contextCompiler: compiler,
    toolRegistry: registry,
    enabledCategories: ["side", "control"],
    features: { planning: "off", memory: mode === "entities" ? "entities-v1" : "facts-v1", batching: "off" },
    policy: new DefaultRuntimePolicy(2, 12),
    eventWriter,
    assetStore,
  });
  const goal = mode === "entities"
    ? "Use only Run Memory tools and no GUI or planning tools. Create one entity of type document describing alpha-report.odt. Then in later turns write one fact linked to that entity, read the entity by id, invalidate the entity, and terminate successfully. Use the exact ids returned by prior tool results. Do not call memory_list unless needed."
    : "Use only Run Memory tools and no GUI or planning tools. Write one run-level fact with key target_document and value alpha-report.odt. In later turns read it by key, mark that fact needs_check using its returned id, and terminate successfully. Use the exact id returned by prior tool results.";
  const actualGoal = mode === "multi"
    ? "Use only Run Memory tools and no GUI or planning tools. In your first response, emit exactly two independent memory_write_fact tool calls in the same response: one with key first_fact and value one, and one with key second_fact and value two. Do not call memory_get or any other tool in that response. After both writes complete, terminate successfully."
    : goal;
  let outcome;
  try {
    outcome = await controller.start(actualGoal);
  } catch (error) {
    outcome = "threw";
    await appendFile(resolve(output, "harness-error.jsonl"), `${JSON.stringify(safeError(error))}\n`, "utf8");
  }
  const events = await readRuntimeEvents(resolve(output, "trajectory.jsonl"));
  const snapshot = reduceRuntimeEvents(events, runId);
  const summary = {
    provider: providerName,
    mode,
    runId,
    outcome,
    toolNames: registry.modelTools("main", { enabledCategories: ["side", "control"] }).map((tool) => tool.name),
    memory: snapshot.memory,
    modelCalls: summarizeToolCalls(events),
    eventCount: events.length,
    providerExchanges: exchanges,
  };
  await writeFile(resolve(output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return summary;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write("Usage: node scripts/real-memory-api-conformance.mjs --model glm-5.3-flash|qwen3.8-flash|all --mode facts|entities|multi|all --env-file <path> --output <dir>\n");
    return;
  }
  const model = required(argv, "--model");
  const mode = required(argv, "--mode");
  if (!["glm-5.3-flash", "qwen3.8-flash", "all"].includes(model)) throw new Error("--model must be glm-5.3-flash, qwen3.8-flash, or all");
  if (!["facts", "entities", "multi", "all"].includes(mode)) throw new Error("--mode must be facts, entities, multi, or all");
  const envFile = required(argv, "--env-file");
  const root = resolve(required(argv, "--output"));
  const models = model === "all" ? ["glm-5.3-flash", "qwen3.8-flash"] : [model];
  const modes = mode === "all" ? ["facts", "entities"] : [mode];
  const results = [];
  for (const providerName of models) for (const currentMode of modes) {
    results.push(await run(providerName, currentMode, envFile, resolve(root, `${providerName}-${currentMode}`)));
  }
  process.stdout.write(`${JSON.stringify(results.map((result) => ({ provider: result.provider, mode: result.mode, outcome: result.outcome, calls: result.modelCalls.length, eventCount: result.eventCount })), null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
