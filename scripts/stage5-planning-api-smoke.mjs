#!/usr/bin/env node

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { DefaultContextCompiler } from "../packages/context/dist/index.js";
import { FilePlanStore, createPlanningTools } from "../packages/planning/dist/index.js";
import { GlmAdapter, FetchGlmHttpClient, glmProfiles } from "../packages/provider-glm/dist/index.js";
import { Qwen38FlashAdapter, FetchQwenHttpClient } from "../packages/provider-qwen/dist/index.js";
import { DefaultRuntimePolicy, RunController, createDefaultToolRegistry } from "../packages/runtime/dist/index.js";
import { FileAssetStore, JsonlRunEventWriter, readRuntimeEvents, reduceRuntimeEvents } from "../packages/trajectory/dist/index.js";

const FAKE_PNG = makePng(64, 64);

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

class FakeComputer {
  constructor() {
    this.executeCalls = 0;
    this.session = {
      id: "planning-api-fake-session",
      backend: "fake-no-gui",
      viewport: { width: 64, height: 64, coordinateSpace: "physical" },
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
    return {
      capturedAt: new Date().toISOString(),
      viewport: this.session.viewport,
      screenshot: { mediaType: "image/png", data: FAKE_PNG },
    };
  }

  async execute(_session, action, _signal) {
    this.executeCalls += 1;
    return { actionId: action.actionId, status: "refused", driverCode: "FAKE_GUI_DISABLED", message: "API planning smoke never dispatches GUI actions" };
  }

  async close(_session) {}
}

class RecordingGlmClient {
  constructor(path) { this.path = path; this.inner = new FetchGlmHttpClient(); this.request = 0; }
  async post(url, body, headers, signal) {
    this.request += 1;
    const started = Date.now();
    try {
      const response = await this.inner.post(url, body, headers, signal);
      await appendFile(this.path, `${JSON.stringify({ provider: "glm", request: this.request, latencyMs: Date.now() - started, model: body.model, toolNames: toolNames(body.tools), response: summarizeResponse(response) })}\n`, "utf8");
      return response;
    } catch (error) {
      await appendFile(this.path, `${JSON.stringify({ provider: "glm", request: this.request, latencyMs: Date.now() - started, model: body.model, transportError: safeError(error) })}\n`, "utf8");
      throw error;
    }
  }
}

class RecordingQwenClient {
  constructor(path) { this.path = path; this.inner = new FetchQwenHttpClient(); this.request = 0; }
  async post(url, body, headers, signal) {
    this.request += 1;
    const started = Date.now();
    try {
      const response = await this.inner.post(url, body, headers, signal);
      await appendFile(this.path, `${JSON.stringify({ provider: "qwen", request: this.request, latencyMs: Date.now() - started, model: body.model, toolNames: toolNames(body.tools), outputMode: body.response_format?.json_schema?.name === "qwen_model_turn" ? "strict_json" : "native_tools", response: summarizeResponse(response) })}\n`, "utf8");
      return response;
    } catch (error) {
      await appendFile(this.path, `${JSON.stringify({ provider: "qwen", request: this.request, latencyMs: Date.now() - started, model: body.model, transportError: safeError(error) })}\n`, "utf8");
      throw error;
    }
  }
}

function toolNames(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => item && typeof item === "object" && item.function && typeof item.function.name === "string" ? [item.function.name] : []);
}

function summarizeResponse(value) {
  if (!value || typeof value !== "object") return { shape: typeof value };
  const choice = Array.isArray(value.choices) ? value.choices[0] : undefined;
  const message = choice && typeof choice.message === "object" ? choice.message : undefined;
  return {
    finishReason: choice && typeof choice.finish_reason === "string" ? choice.finish_reason : null,
    toolCalls: Array.isArray(message?.tool_calls) ? message.tool_calls.map((call) => ({ id: call?.id ?? null, name: call?.function?.name ?? null })) : [],
    contentLength: typeof message?.content === "string" ? message.content.length : 0,
    usage: value.usage && typeof value.usage === "object" ? value.usage : null,
  };
}

function safeError(error) {
  return error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write("Usage: node scripts/stage5-planning-api-smoke.mjs --model glm-5.3-flash|qwen3.8-flash --env-file <path> --output <dir>\n");
    return;
  }
  const model = required(argv, "--model");
  if (model !== "glm-5.3-flash" && model !== "qwen3.8-flash") throw new Error("--model must be glm-5.3-flash or qwen3.8-flash");
  const envFile = required(argv, "--env-file");
  const output = resolve(required(argv, "--output"));
  await loadEnv(envFile);
  await mkdir(output, { recursive: true });
  const runId = `planning-api-${model.replaceAll(".", "-")}-${Date.now()}`;
  const registry = createDefaultToolRegistry();
  const planStore = new FilePlanStore(resolve(output, "plan-store"));
  registry.registerMany(createPlanningTools(planStore));
  const assetStore = new FileAssetStore(resolve(output, "assets"));
  const exchanges = resolve(output, "provider-exchanges.jsonl");
  const provider = model === "glm-5.3-flash"
    ? new GlmAdapter({ apiKey: process.env.ZHIPUAI_API_KEY ?? process.env.ZHIPU_API_KEY ?? process.env.GLM_API_KEY ?? "", profile: { ...glmProfiles["glm-5.3-flash"], thinking: process.env.GLM_THINKING === "disabled" ? "disabled" : "enabled" }, assetReader: assetStore, httpClient: new RecordingGlmClient(exchanges), ...(process.env.GLM_ENDPOINT === undefined ? {} : { endpoint: process.env.GLM_ENDPOINT }) })
    : new Qwen38FlashAdapter({ apiKey: process.env.DASHSCOPE_API_KEY ?? "", assetReader: assetStore, httpClient: new RecordingQwenClient(exchanges), thinking: "low", coordinateMode: "normalized_1000", outputMode: "strict_json", ...(process.env.DASHSCOPE_ENDPOINT === undefined ? {} : { endpoint: process.env.DASHSCOPE_ENDPOINT }), ...(process.env.DASHSCOPE_WORKSPACE_ID === undefined ? {} : { workspaceId: process.env.DASHSCOPE_WORKSPACE_ID }) });
  const eventWriter = new JsonlRunEventWriter(resolve(output, "trajectory.jsonl"), runId);
  const controller = new RunController({
    runId,
    provider,
    computer: new FakeComputer(),
    contextCompiler: new DefaultContextCompiler(registry),
    toolRegistry: registry,
    policy: new DefaultRuntimePolicy(6, 8),
    eventWriter,
    assetStore,
  });
  const outcome = await controller.start("Use planning tools only: create one task, update that same task to completed, then terminate successfully. Do not use any GUI tool.");
  const events = await readRuntimeEvents(resolve(output, "trajectory.jsonl"));
  const snapshot = reduceRuntimeEvents(events, runId);
  const summary = {
    model,
    runId,
    outcome,
    planning: true,
    toolNames: registry.modelTools().map((tool) => tool.name),
    plan: snapshot.plan,
    modelUsage: snapshot.modelUsage ?? null,
    modelCalls: events.filter((event) => event.type === "model.response.received" && event.turn.type === "tool_calls").flatMap((event) => event.turn.calls.map((call) => ({ name: call.name, arguments: call.arguments }))),
    eventCount: events.length,
    providerExchanges: exchanges,
  };
  await writeFile(resolve(output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
