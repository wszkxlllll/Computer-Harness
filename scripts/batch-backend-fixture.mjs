#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { OsworldComputer } from "../packages/computer-osworld/dist/index.js";
import { DefaultContextCompiler } from "../packages/context/dist/index.js";
import { DefaultRuntimePolicy, RunController, createDefaultToolRegistry } from "../packages/runtime/dist/index.js";
import { FileAssetStore, JsonlRunEventWriter, readRuntimeEvents } from "../packages/trajectory/dist/index.js";

const WIDTH = 640;
const HEIGHT = 360;
const PNG = makePng(WIDTH, HEIGHT);

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

class ScriptedProvider {
  constructor() {
    this.id = "backend-fixture-provider";
    this.turns = [
      { type: "tool_calls", calls: [
        { id: "fixture-click", name: "click", arguments: { x: 320, y: 180 } },
        { id: "fixture-type", name: "type", arguments: { text: "batch-ok" } },
      ] },
      { type: "finish", summary: "batch fixture complete" },
    ];
  }

  async generate(_input, { signal }) {
    signal.throwIfAborted();
    const turn = this.turns.shift();
    if (turn === undefined) throw new Error("fixture provider exhausted");
    return turn;
  }
}

function driverResult(overrides = {}) {
  return { text: "ok", images: [], isError: false, degraded: false, rawJson: "{}", ...overrides };
}

function makeCuaDriver() {
  const calls = [];
  const driver = {
    async startSession() { return { active: true, revived: false }; },
    async endSession() { return { active: false }; },
    async shutdown() {},
    async callTool(name, inputJson) {
      const input = JSON.parse(inputJson);
      calls.push({ name, input });
      if (name === "get_screen_size") return driverResult({ structuredJson: JSON.stringify({ width: WIDTH, height: HEIGHT }) });
      if (name === "get_desktop_state") {
        await writeFile(String(input.screenshot_out_file), PNG);
        return driverResult({ structuredJson: JSON.stringify({ screenshot_width: WIDTH, screenshot_height: HEIGHT }) });
      }
      return driverResult();
    },
  };
  return { driver, calls };
}

function makeOsworldBridge() {
  const calls = [];
  const capture = () => ({ mediaType: "image/png", dataBase64: Buffer.from(PNG).toString("base64"), width: WIDTH, height: HEIGHT, capturedAt: new Date().toISOString() });
  const bridge = {
    async describe() { return { viewport: { width: WIDTH, height: HEIGHT, coordinateSpace: "physical" }, capabilities: { screenshot: true, pointer: true, keyboard: true, keyboardKeys: ["ctrl", "a"] } }; },
    async observe() { calls.push({ kind: "observe" }); return capture(); },
    async execute(action) { calls.push({ kind: "execute", action }); return { status: "completed", postActionCapture: capture() }; },
  };
  return { bridge, calls };
}

// computer-cua loads the native cua driver binding at module scope; import it
// lazily so the osworld fixture also runs on hosts without that binding.
async function loadCuaDriverComputer() {
  const module = await import("../packages/computer-cua/dist/index.js");
  return module.CuaDriverComputer;
}

async function runBackend(name, root) {
  const output = resolve(root, name);
  await mkdir(output, { recursive: true });
  const runId = `batch-backend-${name}`;
  const assetStore = new FileAssetStore(resolve(output, "assets"));
  const registry = createDefaultToolRegistry();
  const features = { planning: "off", memory: "off", batching: "same-control-input-v1" };
  const computerParts = name === "cua"
    ? makeCuaDriver()
    : makeOsworldBridge();
  const computer = name === "cua"
    ? new (await loadCuaDriverComputer())({ socketPath: "fixture-socket", screenshotDir: resolve(output, "screenshots"), sessionLabel: "fixture-cua", driverFactory: () => computerParts.driver })
    : new OsworldComputer({ bridge: computerParts.bridge, sessionIdFactory: () => "fixture-osworld" });
  const eventWriter = new JsonlRunEventWriter(resolve(output, "trajectory.jsonl"), runId);
  const controller = new RunController({
    runId,
    provider: new ScriptedProvider(),
    computer,
    contextCompiler: new DefaultContextCompiler(registry, { features }),
    toolRegistry: registry,
    features,
    batching: "same-control-input-v1",
    policy: new DefaultRuntimePolicy(4, 4),
    eventWriter,
    assetStore,
  });
  const outcome = await controller.start("Complete one same-control click then type batch fixture.");
  const events = await readRuntimeEvents(resolve(output, "trajectory.jsonl"));
  const result = {
    backend: name,
    outcome,
    actionStarted: events.filter((event) => event.type === "action.execution.started").length,
    actionCompleted: events.filter((event) => event.type === "action.execution.completed").length,
    observations: events.filter((event) => event.type === "observation.created").length,
    calls: computerParts.calls,
  };
  await writeFile(resolve(output, "summary.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

const output = resolve(process.argv[2] ?? "runs/api-conformance/batch-backend-fixture-20260915");
const results = [await runBackend("cua", output), await runBackend("osworld", output)];
process.stdout.write(`${JSON.stringify(results.map((result) => ({ backend: result.backend, outcome: result.outcome, actionStarted: result.actionStarted, actionCompleted: result.actionCompleted, observations: result.observations })), null, 2)}\n`);
