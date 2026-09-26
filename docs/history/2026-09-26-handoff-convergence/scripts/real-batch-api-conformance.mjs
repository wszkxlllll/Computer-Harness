#!/usr/bin/env node

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { DefaultContextCompiler } from "../packages/context/dist/index.js";
import { InMemoryMemoryStore, createMemoryTools } from "../packages/memory/dist/index.js";
import { InMemoryPlanStore, createPlanningTools } from "../packages/planning/dist/index.js";
import { GlmAdapter, FetchGlmHttpClient, glmProfiles } from "../packages/provider-glm/dist/index.js";
import { Qwen38FlashAdapter, FetchQwenHttpClient } from "../packages/provider-qwen/dist/index.js";
import { DefaultRuntimePolicy, RunController, createDefaultToolRegistry } from "../packages/runtime/dist/index.js";
import { FileAssetStore, JsonlRunEventWriter, readRuntimeEvents, reduceRuntimeEvents } from "../packages/trajectory/dist/index.js";

const PNG = makePng(640, 360);

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

function redactBody(body) {
  const result = structuredClone(body);
  if (Array.isArray(result.messages)) {
    result.messages = result.messages.map((message) => {
      const next = { ...message };
      if (Array.isArray(next.content)) {
        next.content = next.content.map((part) => part?.type === "image_url" ? { type: "image_url", image_url: { url: "<image-data-url>" } } : part);
      }
      return next;
    });
  }
  return result;
}

function summarizeResponse(value) {
  const choice = value && typeof value === "object" && Array.isArray(value.choices) ? value.choices[0] : undefined;
  const message = choice && typeof choice.message === "object" ? choice.message : undefined;
  return {
    finishReason: choice && typeof choice.finish_reason === "string" ? choice.finish_reason : null,
    nativeToolCalls: Array.isArray(message?.tool_calls) ? message.tool_calls.map((call) => ({ id: call?.id ?? null, name: call?.function?.name ?? null })) : [],
    contentLength: typeof message?.content === "string" ? message.content.length : 0,
    contentPreview: typeof message?.content === "string" ? message.content.slice(0, 500).replace(/\s+/gu, " ") : undefined,
    usage: value?.usage && typeof value.usage === "object" ? value.usage : null,
  };
}

function safeError(error) {
  return error instanceof Error ? { name: error.name, code: error.code, message: error.message } : { message: String(error) };
}

class RecordingClient {
  constructor(provider, output) {
    this.provider = provider;
    this.output = output;
    this.request = 0;
    this.inner = provider === "glm-5.3-flash" ? new FetchGlmHttpClient() : new FetchQwenHttpClient();
  }

  async post(url, body, headers, signal) {
    this.request += 1;
    const started = Date.now();
    const shapePath = resolve(this.output, `request-${this.request}-shape.json`);
    await writeFile(shapePath, `${JSON.stringify({ provider: this.provider, url: url.replace(/https?:\/\/[^/]+/u, "<provider-host>"), headers: Object.fromEntries(Object.keys(headers).filter((key) => key.toLowerCase() !== "authorization").map((key) => [key, headers[key]])), body: redactBody(body) }, null, 2)}\n`, "utf8");
    try {
      const response = await this.inner.post(url, body, headers, signal);
      await appendFile(resolve(this.output, "provider-exchanges.jsonl"), `${JSON.stringify({ provider: this.provider, request: this.request, latencyMs: Date.now() - started, model: body.model, response: summarizeResponse(response) })}\n`, "utf8");
      return response;
    } catch (error) {
      await appendFile(resolve(this.output, "provider-exchanges.jsonl"), `${JSON.stringify({ provider: this.provider, request: this.request, latencyMs: Date.now() - started, model: body.model, error: safeError(error) })}\n`, "utf8");
      throw error;
    }
  }
}

class FakeComputer {
  constructor() {
    this.executions = [];
    this.observations = 0;
    this.session = {
      id: "batch-api-fake-session",
      backend: "fake-no-gui",
      viewport: { width: 640, height: 360, coordinateSpace: "physical" },
      capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false },
      openedAt: new Date().toISOString(),
    };
  }

  async open(_options, signal) {
    signal.throwIfAborted();
    return this.session;
  }

  async observe(_session, _observationId, signal) {
    signal.throwIfAborted();
    this.observations += 1;
    return { capturedAt: new Date().toISOString(), viewport: this.session.viewport, screenshot: { mediaType: "image/png", data: PNG } };
  }

  async execute(_session, action, _signal) {
    this.executions.push(action);
    return { actionId: action.actionId, status: "completed", message: "synthetic batch action accepted" };
  }

  async close(_session) {}
}

function summarizeCall(call) {
  return { id: call.id, name: call.name, arguments: call.arguments };
}

async function run(providerName, envFile, output, composite) {
  await mkdir(output, { recursive: true });
  await loadEnv(envFile);
  const runId = `batch-api-${providerName.replaceAll(".", "-")}-${Date.now()}`;
  const assetStore = new FileAssetStore(resolve(output, "assets"));
  const client = new RecordingClient(providerName, output);
  const provider = providerName === "glm-5.3-flash"
    ? new GlmAdapter({ apiKey: process.env.ZHIPU_API_KEY ?? "", profile: { ...glmProfiles["glm-5.3-flash"], thinking: "disabled" }, assetReader: assetStore, httpClient: client, ...(process.env.GLM_ENDPOINT === undefined ? {} : { endpoint: process.env.GLM_ENDPOINT }) })
    : new Qwen38FlashAdapter({ apiKey: process.env.DASHSCOPE_API_KEY ?? "", assetReader: assetStore, httpClient: client, thinking: "low", coordinateMode: "normalized_1000", outputMode: "strict_json", ...(process.env.DASHSCOPE_ENDPOINT === undefined ? {} : { endpoint: process.env.DASHSCOPE_ENDPOINT }), ...(process.env.DASHSCOPE_WORKSPACE_ID === undefined ? {} : { workspaceId: process.env.DASHSCOPE_WORKSPACE_ID }) });
  const registry = createDefaultToolRegistry();
  const features = composite
    ? { planning: "tasks-v1", memory: "facts-v1", batching: "same-control-input-v1" }
    : { planning: "off", memory: "off", batching: "same-control-input-v1" };
  const planStore = new InMemoryPlanStore();
  const memoryStore = new InMemoryMemoryStore();
  if (composite) {
    registry.registerMany(createPlanningTools(planStore));
    registry.registerMany(createMemoryTools(memoryStore, "facts"));
  }
  const compiler = new DefaultContextCompiler(registry, { features });
  const computer = new FakeComputer();
  const eventWriter = new JsonlRunEventWriter(resolve(output, "trajectory.jsonl"), runId);
  const controller = new RunController({
    runId,
    provider,
    computer,
    contextCompiler: compiler,
    toolRegistry: registry,
    enabledCategories: composite ? ["computer", "control", "planning", "side"] : ["computer", "control"],
    ...(composite ? { enabledToolNames: ["task_create", "memory_write_fact", "click", "type", "terminate"] } : {}),
    features,
    batching: "same-control-input-v1",
    policy: new DefaultRuntimePolicy(4, 8),
    eventWriter,
    assetStore,
  });
  const goal = composite
    ? "In your first response, emit exactly four calls in this order and in the same response: task_create with arguments containing only subject and description for one phase named batch phase; memory_write_fact with arguments containing only key=batch_target and value=batch-ok; click with only x and y; then type with only text=batch-ok. Do not add status, priority, category, source, confidence, relatedTaskIds, or any other fields. This is the allowed state-write prefix followed by the restricted same-control click-then-type GUI batch. Do not emit reads, terminate, planning or memory calls after the GUI calls. After all four calls execute, terminate with success in a later response."
    : "Use only the GUI tools. In your first response, emit exactly two computer calls in the same response: first click the active text field, then type the exact text batch-ok. This is the restricted same-control click-then-type sequence; do not emit terminate, planning, memory, or any other call in that response. After the two actions execute, terminate with success in a later response.";
  let outcome;
  let error;
  try {
    outcome = await controller.start(goal);
  } catch (caught) {
    outcome = "threw";
    error = safeError(caught);
  }
  const events = await readRuntimeEvents(resolve(output, "trajectory.jsonl"));
  const snapshot = reduceRuntimeEvents(events, runId);
  const modelTurns = events.filter((event) => event.type === "model.response.received").map((event) => event.turn.type === "tool_calls" ? { type: event.turn.type, calls: event.turn.calls.map(summarizeCall) } : { type: event.turn.type });
  const summary = {
    provider: providerName,
    composite,
    runId,
    outcome,
    ...(error === undefined ? {} : { error }),
    modelTurns,
    executions: computer.executions.map((action) => ({ kind: action.kind, ...(action.kind === "click" ? { x: action.point.x, y: action.point.y } : {}), ...(action.kind === "type" ? { textLength: action.text.length } : {}) })),
    observationCount: computer.observations,
    batchEvents: events.filter((event) => event.type === "action.execution.started" || event.type === "action.execution.completed" || event.type === "tool.call.rejected").map((event) => event.type),
    plan: snapshot.plan,
    memory: snapshot.memory,
  };
  await writeFile(resolve(output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return summary;
}

async function main() {
  const argv = process.argv.slice(2);
  const model = required(argv, "--model");
  if (!["glm-5.3-flash", "qwen3.8-flash", "all"].includes(model)) throw new Error("--model must be glm-5.3-flash, qwen3.8-flash, or all");
  const envFile = required(argv, "--env-file");
  const root = resolve(required(argv, "--output"));
  const composite = argv.includes("--composite");
  const models = model === "all" ? ["glm-5.3-flash", "qwen3.8-flash"] : [model];
  const results = [];
  for (const provider of models) results.push(await run(provider, envFile, resolve(root, provider), composite));
  process.stdout.write(`${JSON.stringify(results.map((result) => ({ provider: result.provider, composite: result.composite, outcome: result.outcome, executions: result.executions.length, modelTurns: result.modelTurns.length, error: result.error })), null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
