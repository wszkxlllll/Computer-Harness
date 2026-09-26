#!/usr/bin/env node

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { DefaultContextCompiler } from "../packages/context/dist/index.js";
import { InMemoryMemoryStore, createMemoryTools } from "../packages/memory/dist/index.js";
import { InMemoryPlanStore, createPlanningTools } from "../packages/planning/dist/index.js";
import { Qwen38FlashAdapter, FetchQwenHttpClient } from "../packages/provider-qwen/dist/index.js";
import { DefaultRuntimePolicy, RunController, createDefaultToolRegistry } from "../packages/runtime/dist/index.js";
import { FileAssetStore, JsonlRunEventWriter, readRuntimeEvents, reduceRuntimeEvents } from "../packages/trajectory/dist/index.js";

const PNG = makePng(640, 360);
const SCENARIOS = ["terminate_first", "single_click", "single_type", "gui_batch", "state_multi", "composite", "memory_read", "planning_update"];

function makePng(width, height) {
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(scanlines)), pngChunk("IEND", Buffer.alloc(0))]));
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0); typeBytes.copy(chunk, 4); data.copy(chunk, 8); chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const value of data) { crc ^= value; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}

function value(argv, name) { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; }
function required(argv, name) { const result = value(argv, name); if (result === undefined || result.trim().length === 0) throw new Error(`${name} is required`); return result; }

async function loadEnv(path) {
  const text = await readFile(resolve(path), "utf8");
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim(); if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("="); if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim(); const raw = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (process.env[key] === undefined) process.env[key] = raw;
  }
}

function scenarioConfig(scenario) {
  const base = { planning: "off", memory: "off", batching: "off" };
  switch (scenario) {
    case "terminate_first": return { features: base, categories: ["control"], names: ["terminate"], goal: "Terminate immediately with success. Return one terminate call and no other calls." };
    case "single_click": return { features: base, categories: ["computer", "control"], names: ["click", "terminate"], goal: "First return exactly one click call with only x and y for the active text field. Then terminate successfully." };
    case "single_type": return { features: base, categories: ["computer", "control"], names: ["type", "terminate"], goal: "First return exactly one type call with only text=batch-ok. Then terminate successfully." };
    case "gui_batch": return { features: { ...base, batching: "same-control-input-v1" }, categories: ["computer", "control"], names: ["click", "type", "terminate"], goal: "First return exactly click then type in one calls array, with only x/y and text=batch-ok. Then terminate successfully." };
    case "state_multi": return { features: { planning: "tasks-v1", memory: "facts-v1", batching: "off" }, categories: ["planning", "side", "control"], names: ["task_create", "memory_write_fact", "terminate"], goal: "First return exactly task_create with only subject and description, then memory_write_fact with only key=batch_target and value=batch-ok in one calls array. Then terminate successfully." };
    case "composite": return { features: { planning: "tasks-v1", memory: "facts-v1", batching: "same-control-input-v1" }, categories: ["computer", "planning", "side", "control"], names: ["task_create", "memory_write_fact", "click", "type", "terminate"], goal: "First return exactly task_create, memory_write_fact, click, type in one calls array. Use only subject/description, key/value, x/y, and text=batch-ok. Then terminate successfully." };
    case "memory_read": return { features: { planning: "off", memory: "facts-v1", batching: "off" }, categories: ["side", "control"], names: ["memory_write_fact", "memory_get", "terminate"], goal: "Write fact key=batch_target value=batch-ok. In a later call read it by key=batch_target. Then terminate successfully." };
    case "planning_update": return { features: { planning: "tasks-v1", memory: "off", batching: "off" }, categories: ["planning", "control"], names: ["task_create", "task_update", "terminate"], goal: "Create one task with subject batch phase and description Execute batch-ok. In a later call update that task to completed using the returned taskId. Then terminate successfully." };
    default: throw new Error(`unknown scenario ${scenario}`);
  }
}

class RecordingClient {
  constructor(output) { this.output = output; this.request = 0; this.inner = new FetchQwenHttpClient(); }
  async post(url, body, headers, signal) {
    this.request += 1; const started = Date.now();
    const requestShape = structuredClone(body);
    if (Array.isArray(requestShape.messages)) {
      requestShape.messages = requestShape.messages.map((message) => ({
        ...message,
        content: Array.isArray(message.content)
          ? message.content.map((part) => part?.type === "image_url" ? { type: "image_url", image_url: { url: "<image-data-url>" } } : part)
          : message.content,
      }));
    }
    await writeFile(resolve(this.output, `request-${this.request}-shape.json`), `${JSON.stringify(requestShape, null, 2)}\n`, "utf8");
    try {
      const response = await this.inner.post(url, body, headers, signal);
      await appendFile(resolve(this.output, "provider-exchanges.jsonl"), `${JSON.stringify({ request: this.request, latencyMs: Date.now() - started, model: body.model, response: summarize(response) })}\n`, "utf8");
      return response;
    } catch (error) {
      await appendFile(resolve(this.output, "provider-exchanges.jsonl"), `${JSON.stringify({ request: this.request, latencyMs: Date.now() - started, model: body.model, error: error instanceof Error ? { name: error.name, code: error.code, message: error.message } : { message: String(error) } })}\n`, "utf8");
      throw error;
    }
  }
}

function summarize(value) {
  const choice = value && typeof value === "object" && Array.isArray(value.choices) ? value.choices[0] : undefined;
  const message = choice && typeof choice.message === "object" ? choice.message : undefined;
  return {
    finishReason: choice?.finish_reason ?? null,
    contentLength: typeof message?.content === "string" ? message.content.length : 0,
    content: typeof message?.content === "string" ? message.content : "",
    contentPreview: typeof message?.content === "string" ? message.content.slice(0, 500).replace(/\s+/gu, " ") : "",
    usage: value?.usage ?? null,
  };
}

class FakeComputer {
  constructor() { this.executions = []; this.observations = 0; this.session = { id: "flat-matrix-session", backend: "fake-no-gui", viewport: { width: 640, height: 360, coordinateSpace: "physical" }, capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false }, openedAt: new Date().toISOString() }; }
  async open(_options, signal) { signal.throwIfAborted(); return this.session; }
  async observe(_session, _id, signal) { signal.throwIfAborted(); this.observations += 1; return { capturedAt: new Date().toISOString(), viewport: this.session.viewport, screenshot: { mediaType: "image/png", data: PNG } }; }
  async execute(_session, action) { this.executions.push(action); return { actionId: action.actionId, status: "completed", message: "flat matrix fake action" }; }
  async close() {}
}

async function runOne(scenario, repeat, envFile, root) {
  const config = scenarioConfig(scenario);
  const output = resolve(root, scenario, `r${repeat}`);
  await mkdir(output, { recursive: true }); await loadEnv(envFile);
  const runId = `flat-matrix-${scenario}-${repeat}-${Date.now()}`;
  const planStore = new InMemoryPlanStore(); const memoryStore = new InMemoryMemoryStore();
  const registry = createDefaultToolRegistry();
  if (config.features.planning !== "off") registry.registerMany(createPlanningTools(planStore));
  if (config.features.memory !== "off") registry.registerMany(createMemoryTools(memoryStore, "facts"));
  const assetStore = new FileAssetStore(resolve(output, "assets")); const client = new RecordingClient(output);
  const provider = new Qwen38FlashAdapter({ apiKey: process.env.DASHSCOPE_API_KEY ?? "", assetReader: assetStore, httpClient: client, thinking: "low", coordinateMode: "normalized_1000", outputMode: "strict_json", ...(process.env.DASHSCOPE_ENDPOINT === undefined ? {} : { endpoint: process.env.DASHSCOPE_ENDPOINT }), ...(process.env.DASHSCOPE_WORKSPACE_ID === undefined ? {} : { workspaceId: process.env.DASHSCOPE_WORKSPACE_ID }) });
  const computer = new FakeComputer();
  const eventWriter = new JsonlRunEventWriter(resolve(output, "trajectory.jsonl"), runId);
  const controller = new RunController({ runId, provider, computer, contextCompiler: new DefaultContextCompiler(registry, { features: config.features }), toolRegistry: registry, enabledCategories: config.categories, enabledToolNames: config.names, features: config.features, batching: config.features.batching, policy: new DefaultRuntimePolicy(5, 12), eventWriter, assetStore });
  let outcome; let error;
  try { outcome = await controller.start(config.goal); } catch (caught) { outcome = "threw"; error = caught instanceof Error ? { name: caught.name, code: caught.code, message: caught.message } : { message: String(caught) }; }
  const events = await readRuntimeEvents(resolve(output, "trajectory.jsonl")); const snapshot = reduceRuntimeEvents(events, runId);
  const exchanges = await readFile(resolve(output, "provider-exchanges.jsonl"), "utf8").catch(() => "");
  const requestRecords = exchanges.trim() === "" ? [] : exchanges.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  const result = { scenario, repeat, outcome, ...(error === undefined ? {} : { error }), requests: requestRecords.length, retries: events.filter((event) => event.type === "model.request.failed").length, modelTurns: events.filter((event) => event.type === "model.response.received").length, actionCount: events.filter((event) => event.type === "action.execution.started").length, observations: computer.observations, promptTokens: requestRecords.reduce((sum, row) => sum + (row.response?.usage?.prompt_tokens ?? 0), 0), totalTokens: requestRecords.reduce((sum, row) => sum + (row.response?.usage?.total_tokens ?? 0), 0), latencyMs: requestRecords.reduce((sum, row) => sum + (row.latencyMs ?? 0), 0), planTasks: snapshot.plan.tasks.length, memoryFacts: snapshot.memory.facts.length };
  await writeFile(resolve(output, "summary.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8"); return result;
}

async function main() {
  const argv = process.argv.slice(2); const envFile = required(argv, "--env-file"); const root = resolve(required(argv, "--output")); const repeat = Number(value(argv, "--repeat") ?? "3");
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10) throw new Error("--repeat must be an integer from 1 to 10");
  const selected = value(argv, "--scenario") ?? "all"; const scenarios = selected === "all" ? SCENARIOS : selected.split(",");
  for (const scenario of scenarios) if (!SCENARIOS.includes(scenario)) throw new Error(`unknown scenario: ${scenario}`);
  const results = []; for (const scenario of scenarios) for (let index = 1; index <= repeat; index += 1) results.push(await runOne(scenario, index, envFile, root));
  await writeFile(resolve(root, "matrix-summary.json"), `${JSON.stringify(results, null, 2)}\n`, "utf8");
  const grouped = new Map();
  for (const row of results) grouped.set(row.scenario, [...(grouped.get(row.scenario) ?? []), row]);
  const summary = Object.fromEntries([...grouped.entries()].map(([scenario, rows]) => [scenario, { runs: rows.length, success: rows.filter((row) => row.outcome === "succeeded").length, successRate: rows.filter((row) => row.outcome === "succeeded").length / rows.length, avgPromptTokens: rows.reduce((sum, row) => sum + row.promptTokens, 0) / rows.length, avgLatencyMs: rows.reduce((sum, row) => sum + row.latencyMs, 0) / rows.length }]));
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1; });
