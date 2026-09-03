import { deflateSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import type { AssetId, AssetRef, JsonValue, Viewport } from "@computer-harness/protocol";
import { Qwen38FlashAdapter, type QwenHttpClient } from "@computer-harness/provider-qwen";
import type { AssetReader, ModelInput } from "@computer-harness/runtime";

type CoordinateMode = "normalized_1000" | "actual_pixels";

interface Fixture {
  id: string;
  width: number;
  height: number;
  target: { x: number; y: number; width: number; height: number };
}

interface Options {
  output: string;
  envFile: string;
  timeoutMs: number;
  planOnly: boolean;
  coordinateMode?: CoordinateMode;
}

interface RequestRecord {
  mode: CoordinateMode;
  fixture: string;
  model: string;
  status: number;
  requestKeys: string[];
  imageCount: number;
  toolNames: string[];
  responseModel?: string;
  responseFinishReason?: string;
  rawToolCalls?: Array<{ id: string | null; name: string | null; arguments: string | null }>;
  latencyMs?: number;
  usage?: unknown;
}

interface CalibrationClassification {
  apiSucceeded: boolean;
  toolCallParsed: boolean;
  coordinateInRange: boolean;
  localizationHit: boolean;
  overallPassed: boolean;
}

interface RunResult {
  fixture: string;
  mode: CoordinateMode;
  target: Fixture["target"];
  status: "ok" | "error";
  turn?: unknown;
  predictedPoint?: { x: number; y: number };
  hit?: boolean;
  classification: CalibrationClassification;
  requests: RequestRecord[];
  error?: { code: string; message: string };
}

const fixtures: readonly Fixture[] = [
  { id: "left-top", width: 640, height: 360, target: { x: 44, y: 48, width: 140, height: 84 } },
  { id: "center", width: 640, height: 360, target: { x: 250, y: 132, width: 140, height: 90 } },
  { id: "right-bottom", width: 640, height: 360, target: { x: 456, y: 238, width: 140, height: 84 } },
];

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseOptions(args: readonly string[]): Options {
  const timeout = Number(option(args, "--timeout-ms") ?? "120000");
  if (!Number.isInteger(timeout) || timeout < 1000) throw new Error("--timeout-ms must be an integer >= 1000");
  const coordinateMode = option(args, "--coordinate-mode");
  if (coordinateMode !== undefined && coordinateMode !== "actual_pixels" && coordinateMode !== "normalized_1000") throw new Error("--coordinate-mode must be actual_pixels or normalized_1000");
  return {
    output: resolve(option(args, "--output") ?? `runs/stage4-local/qwen38-coordinate-calibration-${new Date().toISOString().replace(/[-:.TZ]/g, "")}`),
    envFile: resolve(option(args, "--env-file") ?? ".env"),
    timeoutMs: timeout,
    planOnly: args.includes("--plan-only"),
    ...(coordinateMode === undefined ? {} : { coordinateMode: coordinateMode as CoordinateMode }),
  };
}

function parseEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u.exec(line);
    if (match === null) continue;
    const key = match[1];
    if (key !== undefined) result[key] = (match[2] ?? "").replace(/^(['"])(.*)\1$/u, "$2");
  }
  return result;
}

class BytesAssetReader implements AssetReader {
  public constructor(private readonly bytes: Uint8Array) {}
  public async read(_ref: AssetRef, signal: AbortSignal): Promise<Uint8Array> {
    signal.throwIfAborted();
    return this.bytes;
  }
}

class RecordingHttpClient implements QwenHttpClient {
  public readonly records: RequestRecord[] = [];
  public constructor(private readonly fixture: string, private readonly mode: CoordinateMode, private readonly timeoutMs: number) {}

  public async post(url: string, body: Record<string, unknown>, headers: Readonly<Record<string, string>>, parentSignal: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    const abort = (): void => controller.abort(parentSignal.reason);
    if (parentSignal.aborted) abort();
    else parentSignal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("Qwen38 calibration request timed out")), this.timeoutMs);
    const record: RequestRecord = {
      mode: this.mode,
      fixture: this.fixture,
      model: typeof body.model === "string" ? body.model : "<missing>",
      status: 0,
      requestKeys: Object.keys(body).sort(),
      imageCount: countImages(body.messages),
      toolNames: readToolNames(body.tools),
    };
    const startedAt = Date.now();
    try {
      const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
      record.status = response.status;
      const payload = await response.json().catch(() => undefined) as unknown;
      record.latencyMs = Date.now() - startedAt;
      if (isRecord(payload) && typeof payload.model === "string") record.responseModel = payload.model;
      if (isRecord(payload) && Array.isArray(payload.choices) && isRecord(payload.choices[0])) {
        const choice = payload.choices[0];
        if (typeof choice.finish_reason === "string") record.responseFinishReason = choice.finish_reason;
        const rawToolCalls = readRawToolCalls(choice.message);
        if (rawToolCalls !== undefined) record.rawToolCalls = rawToolCalls;
      }
      if (isRecord(payload) && isRecord(payload.usage)) record.usage = summarizeUsage(payload.usage);
      this.records.push(record);
      if (!response.ok) throw new Error(`Qwen HTTP ${response.status}`);
      return payload;
    } finally {
      clearTimeout(timer);
      parentSignal.removeEventListener("abort", abort);
    }
  }
}

async function runFixture(options: Options, env: Record<string, string>, fixture: Fixture, mode: CoordinateMode): Promise<RunResult> {
  const viewport: Viewport = { width: fixture.width, height: fixture.height, coordinateSpace: "physical" };
  const bytes = makeTargetPng(fixture.width, fixture.height, fixture.target);
  const asset: AssetRef = { assetId: `${fixture.id}-${mode}` as AssetId, relativePath: `fixtures/${fixture.id}.png`, mediaType: "image/png", byteLength: bytes.byteLength };
  const input: ModelInput = {
    system: "You are a GUI coordinate calibration model. Use the click Function Calling tool exactly once to click the bright yellow rectangle.",
    messages: [{ role: "user", content: [{ type: "text", text: "Click the bright yellow rectangle. Do not describe it in text; call click." }, { type: "image", asset, viewport }] }],
    tools: [{
      name: "click",
      description: "Click the center of the bright yellow rectangle visible in the current image.",
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "number", description: "Horizontal coordinate in the current observation coordinate space." },
          y: { type: "number", description: "Vertical coordinate in the current observation coordinate space." },
        },
        required: ["x", "y"],
        additionalProperties: false,
      },
    }],
  };
  const client = new RecordingHttpClient(fixture.id, mode, options.timeoutMs);
  const key = env.DASHSCOPE_API_KEY;
  if (key === undefined || key.trim().length === 0) return { fixture: fixture.id, mode, target: fixture.target, status: "error", classification: emptyClassification(), requests: [], error: { code: "MISSING_API_KEY", message: "DASHSCOPE_API_KEY is not configured" } };
  const adapter = new Qwen38FlashAdapter({
    apiKey: key,
    assetReader: new BytesAssetReader(bytes),
    httpClient: client,
    thinking: "disabled",
    coordinateMode: mode,
    ...(env.DASHSCOPE_WORKSPACE_ID === undefined ? {} : { workspaceId: env.DASHSCOPE_WORKSPACE_ID }),
    ...(env.DASHSCOPE_ENDPOINT === undefined ? {} : { endpoint: env.DASHSCOPE_ENDPOINT }),
  });
  try {
    const turn = await adapter.generate(input, { signal: new AbortController().signal });
    const callArguments = turn.type === "tool_calls" && turn.calls.length === 1 ? turn.calls[0]?.arguments : undefined;
    const predicted = isRecord(callArguments) && !Array.isArray(callArguments)
      ? pointFromArguments(callArguments as Record<string, JsonValue>)
      : undefined;
    return {
      fixture: fixture.id,
      mode,
      target: fixture.target,
      status: "ok",
      turn: summarizeTurn(turn),
      ...(predicted === undefined ? {} : { predictedPoint: predicted, hit: inTarget(predicted, fixture.target) }),
      classification: classifyCalibration(client.records, mode, viewport, fixture.target, predicted),
      requests: client.records,
    };
  } catch (error) {
    return { fixture: fixture.id, mode, target: fixture.target, status: "error", classification: classifyCalibration(client.records, mode, viewport, fixture.target), requests: client.records, error: describeError(error) };
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const modes = options.coordinateMode === undefined ? ["actual_pixels", "normalized_1000"] as const : [options.coordinateMode] as const;
  const plan = { kind: "qwen38_coordinate_calibration", model: "qwen3.8-flash", modes, fixtures: fixtures.map((fixture) => ({ id: fixture.id, width: fixture.width, height: fixture.height, target: fixture.target })), totalRuns: fixtures.length * modes.length, noCua: true, noDesktopSideEffects: true };
  await mkdir(options.output, { recursive: true });
  if (options.planOnly) {
    await writeFile(resolve(options.output, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ output: relative(process.cwd(), options.output), plan }, null, 2));
    return;
  }
  const env = parseEnv(await readFile(options.envFile, "utf8"));
  const fixtureDir = resolve(options.output, "fixtures");
  await mkdir(fixtureDir, { recursive: true });
  for (const fixture of fixtures) await writeFile(resolve(fixtureDir, `${fixture.id}.png`), makeTargetPng(fixture.width, fixture.height, fixture.target));
  const results: RunResult[] = [];
  for (const mode of modes) {
    for (const fixture of fixtures) {
      const result = await runFixture(options, env, fixture, mode);
      results.push(result);
      await writeFile(resolve(options.output, `${fixture.id}-${mode}.json`), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    }
  }
  const summary = {
    plan,
    results,
    metrics: Object.fromEntries(modes.map((mode) => {
      const selected = results.filter((result) => result.mode === mode);
      return [mode, {
        runs: selected.length,
        apiSucceeded: selected.filter((result) => result.classification.apiSucceeded).length,
        toolCallParsed: selected.filter((result) => result.classification.toolCallParsed).length,
        coordinateInRange: selected.filter((result) => result.classification.coordinateInRange).length,
        localizationHit: selected.filter((result) => result.classification.localizationHit).length,
        overallPassed: selected.filter((result) => result.classification.overallPassed).length,
      }];
    })),
  };
  await writeFile(resolve(options.output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ output: relative(process.cwd(), options.output), metrics: summary.metrics }, null, 2));
}

function emptyClassification(): CalibrationClassification {
  return { apiSucceeded: false, toolCallParsed: false, coordinateInRange: false, localizationHit: false, overallPassed: false };
}

function classifyCalibration(records: readonly RequestRecord[], mode: CoordinateMode, viewport: Viewport, target: Fixture["target"], predicted?: { x: number; y: number }): CalibrationClassification {
  const apiSucceeded = records.some((record) => record.status >= 200 && record.status < 300);
  const rawCalls = records.at(-1)?.rawToolCalls ?? [];
  const raw = rawCalls.length === 1 ? rawCalls[0] : undefined;
  const parsed = raw === undefined || raw.arguments === null ? undefined : parseRawArguments(raw.arguments);
  const parsedPoint = parsed !== undefined && typeof parsed.x === "number" && Number.isFinite(parsed.x) && typeof parsed.y === "number" && Number.isFinite(parsed.y)
    ? { x: parsed.x, y: parsed.y }
    : undefined;
  const toolCallParsed = raw?.id !== null && raw?.id !== undefined && raw?.name === "click" && parsedPoint !== undefined;
  const coordinateInRange = toolCallParsed && parsedPoint !== undefined
    ? mode === "normalized_1000"
      ? parsedPoint.x >= 0 && parsedPoint.x <= 1000 && parsedPoint.y >= 0 && parsedPoint.y <= 1000
      : parsedPoint.x >= 0 && parsedPoint.x < viewport.width && parsedPoint.y >= 0 && parsedPoint.y < viewport.height
    : false;
  const point = predicted ?? (parsedPoint === undefined ? undefined : decodeRawPoint(parsedPoint, mode, viewport));
  const localizationHit = coordinateInRange && point !== undefined && inTarget(point, target);
  return { apiSucceeded, toolCallParsed, coordinateInRange, localizationHit, overallPassed: apiSucceeded && toolCallParsed && coordinateInRange && localizationHit };
}

function parseRawArguments(value: string): Record<string, JsonValue> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) && !Array.isArray(parsed) ? parsed as Record<string, JsonValue> : undefined;
  } catch {
    return undefined;
  }
}

function decodeRawPoint(args: { x: number; y: number }, mode: CoordinateMode, viewport: Viewport): { x: number; y: number } {
  return mode === "normalized_1000"
    ? { x: args.x * (viewport.width - 1) / 1000, y: args.y * (viewport.height - 1) / 1000 }
    : { x: args.x, y: args.y };
}

function pointFromArguments(value: Record<string, JsonValue>): { x: number; y: number } | undefined {
  return typeof value.x === "number" && Number.isFinite(value.x) && typeof value.y === "number" && Number.isFinite(value.y) ? { x: value.x, y: value.y } : undefined;
}

function inTarget(point: { x: number; y: number }, target: Fixture["target"]): boolean {
  return point.x >= target.x && point.x <= target.x + target.width && point.y >= target.y && point.y <= target.y + target.height;
}

function summarizeTurn(turn: unknown): unknown {
  if (!isRecord(turn)) return turn;
  if (turn.type === "tool_calls" && Array.isArray(turn.calls)) return { type: "tool_calls", callCount: turn.calls.length, calls: turn.calls.map((call) => isRecord(call) ? { id: call.id, name: call.name, arguments: call.arguments } : null) };
  if (turn.type === "finish") return { type: "finish", summary: typeof turn.summary === "string" ? turn.summary : "" };
  return { type: typeof turn.type === "string" ? turn.type : "unknown" };
}

function describeError(error: unknown): { code: string; message: string } {
  if (isRecord(error)) return { code: typeof error.code === "string" ? error.code : "QWEN38_CALIBRATION_ERROR", message: error instanceof Error ? error.message : String(error.message ?? error).slice(0, 240) };
  return { code: "QWEN38_CALIBRATION_ERROR", message: String(error).slice(0, 240) };
}

function countImages(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  return value.reduce((count, item) => count + (isRecord(item) && Array.isArray(item.content) ? item.content.filter((part) => isRecord(part) && part.type === "image_url").length : 0), 0);
}

function readToolNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => isRecord(item) && isRecord(item.function) && typeof item.function.name === "string" ? [item.function.name] : []);
}

function readRawToolCalls(message: unknown): Array<{ id: string | null; name: string | null; arguments: string | null }> | undefined {
  if (!isRecord(message) || message.tool_calls === undefined) return undefined;
  if (!Array.isArray(message.tool_calls)) return [];
  return message.tool_calls.map((call) => {
    if (!isRecord(call)) return { id: null, name: null, arguments: null };
    const id = typeof call.id === "string" ? call.id : null;
    const functionValue = isRecord(call.function) ? call.function : undefined;
    const name = functionValue !== undefined && typeof functionValue.name === "string" ? functionValue.name : null;
    const rawArguments = functionValue?.arguments;
    const argumentsValue = typeof rawArguments === "string" ? rawArguments : rawArguments === undefined ? null : JSON.stringify(rawArguments);
    return { id, name, arguments: argumentsValue };
  });
}

function summarizeUsage(value: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === "number" && Number.isFinite(item))) as Record<string, number>;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function makeTargetPng(width: number, height: number, target: Fixture["target"]): Uint8Array {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      const inside = x >= target.x && x < target.x + target.width && y >= target.y && y < target.y + target.height;
      raw[offset] = inside ? 250 : 24;
      raw[offset + 1] = inside ? 214 : 28;
      raw[offset + 2] = inside ? 40 : 36;
      raw[offset + 3] = 255;
    }
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const chunk = (type: string, data: Uint8Array): Buffer => {
    const typeBytes = Buffer.from(type, "ascii");
    const payload = Buffer.concat([typeBytes, Buffer.from(data)]);
    const result = Buffer.alloc(12 + data.byteLength);
    result.writeUInt32BE(data.byteLength, 0); payload.copy(result, 4); result.writeUInt32BE(crc32(payload), 8 + data.byteLength);
    return result;
  };
  return new Uint8Array(Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())]));
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(value: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of value) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

await main();
