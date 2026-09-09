import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { GlmAdapter, glmProfiles } from "../packages/provider-glm/dist/index.js";
import { InMemoryPlanStore, createPlanningTools } from "../packages/planning/dist/index.js";
import { createDefaultToolRegistry } from "../packages/runtime/dist/index.js";

const [envPath, imagePath] = process.argv.slice(2);
if (envPath === undefined || imagePath === undefined) throw new Error("usage: node tmp-glm-latency-matrix.mjs <env> <png> [--rounds N]");
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/u)) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u);
  if (match !== null && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^['"]|['"]$/gu, "");
}
const apiKey = process.env.ZHIPUAI_API_KEY ?? process.env.ZHIPU_API_KEY ?? process.env.GLM_API_KEY;
if (apiKey === undefined || apiKey.trim().length === 0) throw new Error("missing GLM key");
const roundsFlag = process.argv.indexOf("--rounds");
const rounds = roundsFlag >= 0 ? Number(process.argv[roundsFlag + 1]) : 2;
if (!Number.isInteger(rounds) || rounds < 1) throw new Error("--rounds must be a positive integer");

const imageBytes = readFileSync(imagePath);
function readPngViewport(bytes) {
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47 || bytes.readUInt32BE(4) !== 0x0d0a1a0a) throw new Error("latency probe requires a PNG screenshot");
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) throw new Error("PNG viewport is invalid");
  return { width, height, coordinateSpace: "physical" };
}
const imageViewport = readPngViewport(imageBytes);
const asset = { assetId: "latency-probe-image", relativePath: "latency-probe.png", mediaType: "image/png", byteLength: imageBytes.byteLength };
const assetReader = { read: async () => new Uint8Array(imageBytes) };
const registry = createDefaultToolRegistry();
registry.registerMany(createPlanningTools(new InMemoryPlanStore()));
const input = {
  system: "You are a GUI agent. Observe the current desktop image and choose exactly one valid tool call. Coordinates are physical pixels in the current image viewport. Planning tools may track phase progress but do not replace GUI actions.",
  messages: [{ role: "user", content: [
    { type: "text", text: "Calculate the total sales in an underneath row called Total and display each month as bars. Then calculate month-on-month growth for Feb to Jun in a Growth row and show it in a line chart. Keep the task state and act on the current screen." },
    { type: "image", asset, viewport: imageViewport },
  ] }],
  tools: registry.modelTools(),
};

class CaptureClient {
  body;
  async post(_url, body) {
    this.body = structuredClone(body);
    return { choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "probe-call", type: "function", function: { name: "wait", arguments: JSON.stringify({ durationMs: 1 }) } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  }
}

const captureClient = new CaptureClient();
const captureAdapter = new GlmAdapter({ apiKey, profile: glmProfiles["glm-5.3-flash"], assetReader, httpClient: captureClient });
await captureAdapter.generate(input, { signal: new AbortController().signal });
if (captureClient.body === undefined) throw new Error("failed to capture Provider request body");
const baseBody = captureClient.body;
const endpoint = process.env.GLM_BASE_URL ?? process.env.GLM_ENDPOINT ?? "https://open.bigmodel.cn/api/paas/v4/chat/completions";

function meaningfulDelta(delta) {
  if (typeof delta?.content === "string" && delta.content.length > 0) return true;
  if (typeof delta?.reasoning_content === "string" && delta.reasoning_content.length > 0) return true;
  return Array.isArray(delta?.tool_calls) && delta.tool_calls.some((call) => typeof call?.id === "string" || typeof call?.function?.name === "string" || typeof call?.function?.arguments === "string");
}

function validateToolCalls(calls) {
  if (!Array.isArray(calls) || calls.length !== 1) return { valid: false, reason: "expected_exactly_one_tool_call" };
  const names = [];
  const ids = new Set();
  let controlCount = 0;
  let computerCount = 0;
  for (const call of calls) {
    if (typeof call?.id !== "string" || call.id.length === 0 || ids.has(call.id)) return { valid: false, reason: "tool_call_id_missing_or_duplicate" };
    ids.add(call.id);
    const name = call?.function?.name;
    if (typeof name !== "string" || name.length === 0) return { valid: false, reason: "tool_name_missing" };
    names.push(name);
    if (typeof call.function.arguments !== "string") return { valid: false, reason: "tool_arguments_not_string" };
    let args;
    try { args = JSON.parse(call.function.arguments); } catch { return { valid: false, reason: "tool_arguments_invalid_json" }; }
    const definition = registry.getForAudience(name, "main");
    if (definition === undefined) return { valid: false, reason: `unknown_tool:${name}` };
    try { definition.validate(args); } catch (error) { return { valid: false, reason: `tool_validation:${error instanceof Error ? error.message : String(error)}` }; }
    if (definition.category === "control") controlCount += 1;
    if (definition.category === "computer") computerCount += 1;
  }
  if (controlCount > 0 && computerCount > 0) return { valid: false, reason: "control_and_computer_mixed" };
  return { valid: true, names };
}

function validateJsonResponse(value) {
  const choice = Array.isArray(value?.choices) ? value.choices[0] : undefined;
  const message = choice?.message;
  if (choice === undefined || message === undefined) return { valid: false, reason: "choices_or_message_missing" };
  if (choice.finish_reason !== "tool_calls" && choice.finish_reason !== "function_call") return { valid: false, reason: `incomplete_finish_reason:${String(choice.finish_reason)}` };
  if (Array.isArray(message.tool_calls)) return { ...validateToolCalls(message.tool_calls), finishReason: choice.finish_reason, usage: value.usage ?? null, contentChars: typeof message.content === "string" ? message.content.length : 0, reasoningChars: typeof message.reasoning_content === "string" ? message.reasoning_content.length : 0, toolArgumentChars: message.tool_calls.reduce((total, call) => total + (typeof call?.function?.arguments === "string" ? call.function.arguments.length : 0), 0) };
  return { valid: false, reason: "tool_calls_missing", finishReason: choice.finish_reason, usage: value.usage ?? null, contentChars: typeof message.content === "string" ? message.content.length : 0, reasoningChars: typeof message.reasoning_content === "string" ? message.reasoning_content.length : 0 };
}

function appendStreamName(previous, fragment) {
  if (fragment.length === 0) return previous;
  if (previous.length === 0) return fragment;
  if (fragment === previous || previous.endsWith(fragment)) return previous;
  if (fragment.startsWith(previous)) return fragment;
  return `${previous}${fragment}`;
}

function parseSseText(text) {
  let finishReason;
  let sawDone = false;
  let malformedSse = false;
  let sseError;
  let contentChars = 0;
  let reasoningChars = 0;
  let toolArgumentChars = 0;
  const usageValues = [];
  const toolCalls = new Map();
  for (const line of text.split(/\r?\n/u)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") { sawDone = true; continue; }
    if (data.length === 0) continue;
    let value;
    try { value = JSON.parse(data); } catch { malformedSse = true; continue; }
    if (value?.error !== undefined) { sseError = "provider_sse_error"; continue; }
    if (value.usage !== undefined) usageValues.push(value.usage);
    const choice = Array.isArray(value.choices) ? value.choices[0] : undefined;
    if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
    const delta = choice?.delta;
    if (typeof delta?.content === "string") contentChars += delta.content.length;
    if (typeof delta?.reasoning_content === "string") reasoningChars += delta.reasoning_content.length;
    if (!Array.isArray(delta?.tool_calls)) continue;
    for (const call of delta.tool_calls) {
      if (!Number.isInteger(call?.index)) { malformedSse = true; continue; }
      const index = call.index;
      const previous = toolCalls.get(index) ?? { id: undefined, name: "", arguments: "" };
      const args = typeof call?.function?.arguments === "string" ? call.function.arguments : "";
      toolArgumentChars += args.length;
      toolCalls.set(index, { id: previous.id ?? call?.id, name: appendStreamName(previous.name, call?.function?.name ?? ""), arguments: `${previous.arguments}${args}` });
    }
  }
  const calls = [...toolCalls.values()].map((call) => ({ id: call.id, function: { name: call.name, arguments: call.arguments } }));
  const validation = validateToolCalls(calls);
  const validFinish = finishReason === "tool_calls" || finishReason === "function_call";
  const valid = sawDone && !malformedSse && sseError === undefined && validFinish && validation.valid;
  return { valid, reason: valid ? undefined : sseError ?? (malformedSse ? "malformed_sse" : validation.reason ?? (sawDone ? `invalid_finish:${String(finishReason)}` : "sse_done_missing")), finishReason, sawDone, sseError: sseError ?? null, toolNames: validation.valid ? validation.names : [], contentChars, reasoningChars, toolArgumentChars, usage: usageValues.at(-1) ?? null };
}

function runLocalFixtures() {
  const validJson = { choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "fixture-call", function: { name: "click", arguments: JSON.stringify({ x: 100, y: 100 }) } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  if (!validateJsonResponse(validJson).valid) throw new Error("fixture valid JSON ToolCall was rejected");
  const unknownJson = { choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "fixture-call", function: { name: "unknown_tool", arguments: "{}" } }] } }] };
  if (validateJsonResponse(unknownJson).valid || validateJsonResponse(unknownJson).reason !== "unknown_tool:unknown_tool") throw new Error("fixture unknown tool was accepted");
  const malformedSse = parseSseText("data: {not-json}\n\ndata: [DONE]\n");
  if (malformedSse.valid || malformedSse.reason !== "malformed_sse") throw new Error("fixture malformed SSE was accepted");
  const incompleteSse = parseSseText(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "fixture-call", function: { name: "click", arguments: JSON.stringify({ x: 100, y: 100 }) } }] } }] })}\n`);
  if (incompleteSse.valid || incompleteSse.reason !== "sse_done_missing") throw new Error("fixture incomplete SSE was accepted");
  return { validJson: true, unknownToolRejected: true, malformedSseRejected: true, incompleteSseRejected: true };
}

const fixtureChecks = runLocalFixtures();
if (process.argv.includes("--local-only")) {
  process.stdout.write(`${JSON.stringify({ localFixtures: fixtureChecks })}\n`);
  process.exit(0);
}

async function probe(stream, thinking) {
  const body = structuredClone(baseBody);
  body.stream = stream;
  body.thinking = { type: thinking ? "enabled" : "disabled" };
  const requestBytes = Buffer.byteLength(JSON.stringify(body), "utf8");
  const metadata = { endpointHost: new URL(endpoint).host, requestedThinking: body.thinking.type, requestedStream: body.stream };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("probe deadline")), 240_000);
  const started = performance.now();
  let phase = "headers";
  try {
    const response = await fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
    const headersMs = performance.now() - started;
    if (!response.ok) {
      const errorBody = await response.text();
      return { ...metadata, stream, thinking, requestBytes, status: response.status, headersMs: Math.round(headersMs), completeMs: Math.round(performance.now() - started), valid: false, reason: `http_${response.status}`, errorBodyLength: errorBody.length, errorStage: "body", fixtureChecks };
    }
    if (!stream) {
      phase = "body";
      const raw = await response.text();
      let value;
      try { value = JSON.parse(raw); } catch { value = undefined; }
      return { ...metadata, stream, thinking, requestBytes, status: response.status, headersMs: Math.round(headersMs), ttstMs: null, completeMs: Math.round(performance.now() - started), outputBytes: Buffer.byteLength(raw, "utf8"), ...validateJsonResponse(value), fixtureChecks };
    }
    phase = "body";
    const reader = response.body?.getReader();
    if (reader === undefined) return { ...metadata, stream, thinking, requestBytes, status: response.status, headersMs: Math.round(headersMs), completeMs: Math.round(performance.now() - started), valid: false, reason: "response_body_missing", errorStage: "body", fixtureChecks };
    const decoder = new TextDecoder();
    let pending = "";
    let sseText = "";
    let ttstMs = null;
    let bytes = 0;
    let finishReason;
    let contentSeen = false;
    let contentChars = 0;
    let reasoningChars = 0;
    let toolArgumentChars = 0;
    let sawDone = false;
    let malformedSse = false;
    let sseError;
    const toolCalls = new Map();
    const usageValues = [];
    const consumeLine = (line) => {
      if (!line.startsWith("data:")) return;
      const data = line.slice(5).trim();
      if (data === "[DONE]") { sawDone = true; return; }
      if (data.length === 0) return;
      let value;
      try { value = JSON.parse(data); } catch { malformedSse = true; return; }
      if (value?.error !== undefined) { sseError = "provider_sse_error"; return; }
      if (value.usage !== undefined) usageValues.push(value.usage);
      const choice = Array.isArray(value.choices) ? value.choices[0] : undefined;
      if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
      const delta = choice?.delta;
      if (typeof delta?.content === "string" && delta.content.length > 0) { contentSeen = true; contentChars += delta.content.length; }
      if (typeof delta?.reasoning_content === "string") reasoningChars += delta.reasoning_content.length;
      if (Array.isArray(delta?.tool_calls)) {
        for (const call of delta.tool_calls) {
          if (!Number.isInteger(call?.index)) { malformedSse = true; continue; }
          const index = call.index;
          const previous = toolCalls.get(index) ?? { id: undefined, name: "", arguments: "" };
          toolArgumentChars += typeof call?.function?.arguments === "string" ? call.function.arguments.length : 0;
          toolCalls.set(index, { id: previous.id ?? call?.id, name: appendStreamName(previous.name, call?.function?.name ?? ""), arguments: `${previous.arguments}${call?.function?.arguments ?? ""}` });
        }
      }
      if (ttstMs === null && meaningfulDelta(delta)) ttstMs = performance.now() - started;
    };
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      const decoded = decoder.decode(next.value, { stream: true });
      sseText += decoded;
      pending += decoded;
      const lines = pending.split(/\r?\n/u);
      pending = lines.pop() ?? "";
      for (const line of lines) consumeLine(line);
    }
    const tail = decoder.decode();
    sseText += tail;
    pending += tail;
    for (const line of pending.split(/\r?\n/u)) consumeLine(line);
    const parsedSse = parseSseText(sseText);
    return { ...metadata, stream, thinking, requestBytes, status: response.status, headersMs: Math.round(headersMs), ttstMs: ttstMs === null ? null : Math.round(ttstMs), completeMs: Math.round(performance.now() - started), bytes, ...parsedSse, fixtureChecks };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...metadata, stream, thinking, requestBytes, error: error instanceof Error ? { name: error.name, message } : { message }, errorStage: phase, timeout: message === "probe deadline", elapsedMs: Math.round(performance.now() - started), valid: false, fixtureChecks };
  } finally {
    clearTimeout(timeout);
  }
}

const orders = [
  [[true, true], [false, false], [false, true], [true, false]],
  [[true, false], [false, true], [false, false], [true, true]],
];
for (let round = 0; round < rounds; round += 1) {
  for (const [stream, thinking] of orders[round % orders.length]) {
    process.stdout.write(`${JSON.stringify({ round: round + 1, ...(await probe(stream, thinking)) })}\n`);
  }
}
