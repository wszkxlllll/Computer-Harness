import { deflateSync } from "node:zlib";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ActionId, ActionIntent, AssetRef, ComputerSessionId, EventId, ObservationId, RunId, RuntimeEvent, RuntimeEventDraft, ToolCallId, ModelTurn } from "@computer-harness/protocol";
import { createDefaultComputerTools, DefaultRuntimePolicy, RunController, type ContextCompiler, type ModelInput, type ProviderAdapter } from "@computer-harness/runtime";
import { OsworldBridgeClient } from "./bridge-client.js";
import type { OsworldBridge, OsworldBridgeCapture, OsworldBridgeDescription, OsworldBridgeExecuteResult, OsworldTypedAction } from "./bridge.js";
import { mapActionIntent } from "./action-mapper.js";
import { OsworldComputer } from "./osworld-computer.js";

const viewport = { width: 800, height: 600, coordinateSpace: "physical" as const };
const sessionId = "osworld-test-session" as ComputerSessionId;
const abortSignal = new AbortController().signal;

function capture(seed: number): OsworldBridgeCapture {
  return {
    mediaType: "image/png",
    dataBase64: Buffer.from(makePng(viewport.width, viewport.height, seed)).toString("base64"),
    width: viewport.width,
    height: viewport.height,
    capturedAt: "2026-09-04T00:00:00.000Z",
  };
}

function captureAt(width: number, height: number, seed: number): OsworldBridgeCapture {
  return {
    mediaType: "image/png",
    dataBase64: Buffer.from(makePng(width, height, seed)).toString("base64"),
    width,
    height,
    capturedAt: "2026-09-04T00:00:00.000Z",
  };
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of data) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(chunk, 4);
  Buffer.from(data).copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, Buffer.from(data)])), 8 + data.byteLength);
  return chunk;
}

function makePng(width: number, height: number, seed: number): Uint8Array {
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let row = 0; row < height; row += 1) {
    scanlines[row * (width * 4 + 1) + 1] = seed & 0xff;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", new Uint8Array()),
  ]));
}

class FakeBridge implements OsworldBridge {
  public readonly description: OsworldBridgeDescription = {
    viewport,
    capabilities: { screenshot: true, pointer: true, keyboard: true, keyboardKeys: ["ctrl", "a", "enter", "shift", "down"] },
  };
  public observeCalls = 0;
  public executeCalls: OsworldTypedAction[] = [];
  public nextExecuteResult: OsworldBridgeExecuteResult = { status: "completed", postActionCapture: capture(2) };
  public executeError: Error | undefined;

  public async describe(_signal: AbortSignal): Promise<OsworldBridgeDescription> {
    return this.description;
  }

  public async observe(_signal: AbortSignal): Promise<OsworldBridgeCapture> {
    this.observeCalls += 1;
    return capture(1);
  }

  public async execute(action: OsworldTypedAction, _signal: AbortSignal): Promise<OsworldBridgeExecuteResult> {
    this.executeCalls.push(action);
    if (this.executeError !== undefined) throw this.executeError;
    return this.nextExecuteResult;
  }
}

function computer(bridge: FakeBridge, ids: string[] = [String(sessionId)]): OsworldComputer {
  let index = 0;
  return new OsworldComputer({
    bridge,
    sessionIdFactory: () => (ids[index++] ?? `session-${index}`) as ComputerSessionId,
    now: () => "2026-09-04T00:00:00.000Z",
  });
}

function actionId(value: string): ActionId {
  return value as ActionId;
}

function observationId(value: string): ObservationId {
  return value as ObservationId;
}

type FakeBridgeProcess = ChildProcessByStdio<null, Readable, Readable>;

async function startFakeBridge(mode = "normal", serverToken?: string, clientToken?: string): Promise<{ child: FakeBridgeProcess; client: OsworldBridgeClient }> {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fake-bridge-process.mjs", import.meta.url))], {
    env: { ...process.env, FAKE_BRIDGE_MODE: mode, ...(serverToken === undefined ? {} : { FAKE_BRIDGE_TOKEN: serverToken }) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fake bridge did not start: ${output}`)), 5_000);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const match = output.match(/READY (\d+)/u);
      if (match !== null) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timer);
        reject(new Error(`fake bridge exited with ${code}: ${output}`));
      }
    });
  });
  const client = new OsworldBridgeClient({ baseUrl: `http://127.0.0.1:${port}`, requestTimeoutMs: 2_000, ...(clientToken === undefined ? {} : { token: clientToken }) });
  return { child, client };
}

async function stopFakeBridge(child: FakeBridgeProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 1_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

describe("OsworldComputer", () => {
  it("opens a physical session and materializes bridge screenshots", async () => {
    const bridge = new FakeBridge();
    const instance = computer(bridge);
    const session = await instance.open({}, abortSignal);
    expect(session).toMatchObject({ id: sessionId, backend: "osworld-desktop-env", viewport, capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false } });
    const observation = await instance.observe(session, observationId("obs-1"), abortSignal);
    expect(observation).toMatchObject({ capturedAt: capture(1).capturedAt, viewport, screenshot: { mediaType: "image/png" } });
    expect(observation.screenshot.data.byteLength).toBeGreaterThan(24);
    expect(bridge.observeCalls).toBe(1);
  });

  it("accepts whitespace keyboard keys advertised by OSWorld", async () => {
    const bridge = new FakeBridge();
    bridge.description.capabilities.keyboardKeys = ["ctrl", " ", "\t", "enter"];
    await expect(computer(bridge).open({}, abortSignal)).resolves.toMatchObject({
      capabilities: { keyboard: true },
    });
  });

  it("rejects a requested viewport or bridge description that cannot be used safely", async () => {
    const bridge = new FakeBridge();
    const instance = computer(bridge);
    await expect(instance.open({ viewport: { ...viewport, width: 640 } }, abortSignal)).rejects.toThrow("does not match OSWorld viewport");
    const noScreenshot = new FakeBridge();
    noScreenshot.description.capabilities.screenshot = false;
    await expect(computer(noScreenshot).open({}, abortSignal)).rejects.toThrow("does not provide screenshot capability");
  });

  it("uses the post-action screenshot exactly once and blocks actions until it is observed", async () => {
    const bridge = new FakeBridge();
    const instance = computer(bridge);
    const session = await instance.open({}, abortSignal);
    const initialId = observationId("initial");
    await instance.observe(session, initialId, abortSignal);
    const action: ActionIntent = { actionId: actionId("click-1"), basedOn: initialId, kind: "click", point: { x: 10, y: 20 } };
    const receipt = await instance.execute(session, action, abortSignal);
    expect(receipt).toMatchObject({ actionId: action.actionId, status: "completed" });
    expect(bridge.executeCalls).toEqual([{ kind: "click", x: 10, y: 20 }]);
    await expect(instance.execute(session, action, abortSignal)).resolves.toMatchObject({ status: "refused", driverCode: "POST_ACTION_OBSERVATION_PENDING" });
    const postAction = await instance.observe(session, observationId("post-action"), abortSignal);
    expect(postAction.screenshot.data.byteLength).toBeGreaterThan(24);
    expect(bridge.observeCalls).toBe(1);
    await instance.observe(session, observationId("fresh"), abortSignal);
    expect(bridge.observeCalls).toBe(2);
  });

  it("promotes a post-action viewport change to the next current coordinate space", async () => {
    const bridge = new FakeBridge();
    bridge.nextExecuteResult = { status: "completed", postActionCapture: captureAt(1024, 768, 9) };
    const instance = computer(bridge);
    const session = await instance.open({}, abortSignal);
    const initialId = observationId("viewport-initial");
    await instance.observe(session, initialId, abortSignal);
    await expect(instance.execute(session, { actionId: actionId("resize"), basedOn: initialId, kind: "click", point: { x: 10, y: 20 } }, abortSignal)).resolves.toMatchObject({ status: "completed" });
    const resizedId = observationId("viewport-resized");
    const resized = await instance.observe(session, resizedId, abortSignal);
    expect(resized.viewport).toEqual({ width: 1024, height: 768, coordinateSpace: "physical" });
    await expect(instance.execute(session, { actionId: actionId("new-space"), basedOn: resizedId, kind: "click", point: { x: 1000, y: 700 } }, abortSignal)).resolves.toMatchObject({ status: "completed" });
  });

  it("rejects stale observations and deterministic mapping failures before bridge side effects", async () => {
    const bridge = new FakeBridge();
    const instance = computer(bridge);
    const session = await instance.open({}, abortSignal);
    const stale: ActionIntent = { actionId: actionId("stale"), basedOn: observationId("missing"), kind: "click", point: { x: 10, y: 20 } };
    await expect(instance.execute(session, stale, abortSignal)).resolves.toMatchObject({ status: "refused", driverCode: "OBSERVATION_NOT_FOUND" });
    const initialId = observationId("initial");
    await instance.observe(session, initialId, abortSignal);
    await instance.observe(session, observationId("newer"), abortSignal);
    const oldObservationAction: ActionIntent = { actionId: actionId("old-observation"), basedOn: initialId, kind: "click", point: { x: 10, y: 20 } };
    await expect(instance.execute(session, oldObservationAction, abortSignal)).resolves.toMatchObject({ status: "refused", driverCode: "STALE_OBSERVATION" });
    expect(bridge.executeCalls).toHaveLength(0);
    const latestId = observationId("newer");
    const outside: ActionIntent = { actionId: actionId("outside"), basedOn: latestId, kind: "click", point: { x: viewport.width, y: 20 } };
    await expect(instance.execute(session, outside, abortSignal)).resolves.toMatchObject({ status: "refused", driverCode: "OSWORLD_COORDINATE_OUT_OF_RANGE" });
    expect(bridge.executeCalls).toHaveLength(0);
  });

  it("preserves explicit bridge refusal and propagates uncertain bridge failures", async () => {
    const bridge = new FakeBridge();
    const instance = computer(bridge);
    const session = await instance.open({}, abortSignal);
    const initialId = observationId("initial");
    await instance.observe(session, initialId, abortSignal);
    bridge.nextExecuteResult = { status: "refused", code: "OSWORLD_ACTION_REFUSED", message: "guest rejected action" };
    const action: ActionIntent = { actionId: actionId("refused"), basedOn: initialId, kind: "type", text: "hello" };
    await expect(instance.execute(session, action, abortSignal)).resolves.toMatchObject({ actionId: action.actionId, status: "refused", driverCode: "OSWORLD_ACTION_REFUSED" });
    bridge.nextExecuteResult = { status: "completed", postActionCapture: capture(3) };
    bridge.executeError = new Error("bridge disconnected after dispatch");
    await expect(instance.execute(session, { ...action, actionId: actionId("uncertain") }, abortSignal)).rejects.toThrow("bridge disconnected after dispatch");
  });

  it("rejects malformed PNGs, bridge dimension mismatches, and IHDR mismatches", async () => {
    const cases: Array<{ name: string; result: OsworldBridgeExecuteResult; message: string }> = [
      {
        name: "signature",
        result: { status: "completed", postActionCapture: { ...capture(1), dataBase64: Buffer.from("not a png", "ascii").toString("base64") } },
        message: "invalid PNG",
      },
      {
        name: "metadata",
        result: { status: "completed", postActionCapture: { ...capture(1), width: viewport.width - 1 } },
        message: "bridge metadata",
      },
      {
        name: "IHDR",
        result: { status: "completed", postActionCapture: { ...capture(1), dataBase64: Buffer.from(makePng(400, 300, 1)).toString("base64") } },
        message: "PNG dimensions",
      },
    ];
    for (const testCase of cases) {
      const bridge = new FakeBridge();
      bridge.nextExecuteResult = testCase.result;
      const instance = computer(bridge);
      const session = await instance.open({}, abortSignal);
      const observation = observationId(`validation-${testCase.name}`);
      await instance.observe(session, observation, abortSignal);
      const action: ActionIntent = { actionId: actionId(`validation-${testCase.name}`), basedOn: observation, kind: "click", point: { x: 10, y: 20 } };
      await expect(instance.execute(session, action, abortSignal)).rejects.toThrow(testCase.message);
      expect(bridge.executeCalls).toHaveLength(1);
    }
  });

  it("maps canonical actions to the private OSWorld action format", () => {
    const base = { actionId: actionId("map"), basedOn: observationId("obs") };
    expect(mapActionIntent({ ...base, kind: "click", point: { x: 1, y: 2 } }, viewport)).toEqual({ kind: "click", x: 1, y: 2 });
    expect(mapActionIntent({ ...base, kind: "double_click", point: { x: 1, y: 2 } }, viewport)).toEqual({ kind: "double_click", x: 1, y: 2 });
    expect(mapActionIntent({ ...base, kind: "right_click", point: { x: 1, y: 2 } }, viewport)).toEqual({ kind: "right_click", x: 1, y: 2 });
    expect(mapActionIntent({ ...base, kind: "type", text: "hello" }, viewport)).toEqual({ kind: "type", text: "hello" });
    expect(mapActionIntent({ ...base, kind: "keypress", keys: ["ENTER"] }, viewport)).toEqual({ kind: "keypress", key: "enter" });
    expect(mapActionIntent({ ...base, kind: "keypress", keys: ["CTRL", "A"] }, viewport)).toEqual({ kind: "hotkey", keys: ["ctrl", "a"] });
    expect(mapActionIntent({ ...base, kind: "scroll", point: { x: 1, y: 2 }, direction: "down", ticks: 3 }, viewport)).toEqual({ kind: "scroll", x: 1, y: 2, direction: "down", ticks: 3 });
    expect(mapActionIntent({ ...base, kind: "drag", from: { x: 1, y: 2 }, to: { x: 3, y: 4 } }, viewport)).toEqual({ kind: "drag", fromX: 1, fromY: 2, toX: 3, toY: 4 });
    expect(mapActionIntent({ actionId: actionId("wait"), kind: "wait", durationMs: 10 }, viewport)).toEqual({ kind: "wait", durationMs: 10 });
  });

  it("rejects a key that the OSWorld description does not advertise", () => {
    const base = { actionId: actionId("key-capability"), basedOn: observationId("obs") };
    expect(() => mapActionIntent({ ...base, kind: "keypress", keys: ["MENU"] }, viewport, new Set(["enter", "ctrl"]))).toThrow(/does not support key MENU/i);
  });

  it("clears all observation state on logical close and does not call environment lifecycle methods", async () => {
    const bridge = new FakeBridge();
    const instance = computer(bridge, ["session-1", "session-2"]);
    const session = await instance.open({}, abortSignal);
    await instance.observe(session, observationId("obs"), abortSignal);
    await instance.close(session);
    await expect(instance.observe(session, observationId("after-close"), abortSignal)).rejects.toThrow("unknown OSWorld computer session");
    const next = await instance.open({}, abortSignal);
    expect(next.id).toBe("session-2");
    await expect(instance.observe(session, observationId("old-session"), abortSignal)).rejects.toThrow("unknown OSWorld computer session");
    await expect(instance.execute(session, { actionId: actionId("old-action"), kind: "wait", durationMs: 0 }, abortSignal)).rejects.toThrow("unknown OSWorld computer session");
    await expect(instance.close(session)).rejects.toThrow("unknown OSWorld computer session");
  });

  it("records unknown outcome across Runtime when the OSWorld bridge fails after dispatch", async () => {
    const bridge = new FakeBridge();
    bridge.executeError = new Error("bridge disconnected after dispatch");
    const computerInstance = computer(bridge, ["runtime-session"]);
    const registry = createDefaultComputerTools();
    const provider: ProviderAdapter = {
      id: "osworld-test-provider",
      async generate(_input, options): Promise<ModelTurn> {
        options.signal.throwIfAborted();
        return {
          type: "tool_calls",
          calls: [{ id: "unknown-call" as ToolCallId, name: "click", arguments: { x: 10, y: 20 } }],
        };
      },
    };
    const contextCompiler: ContextCompiler = {
      async compile(input, signal): Promise<ModelInput> {
        signal.throwIfAborted();
        return {
          system: "cross-layer test",
          messages: [{ role: "user", content: [{ type: "text", text: input.goal }] }],
          tools: registry.modelTools(),
        };
      },
    };
    const runId = "osworld-unknown-run" as RunId;
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-osworld-gate1-"));
    try {
      const persistedEvents: RuntimeEvent[] = [];
      const eventWriter = {
        append: async (draft: RuntimeEventDraft): Promise<RuntimeEvent> => {
          const event = {
            ...draft,
            eventId: draft.eventId ?? (`event-${persistedEvents.length}` as EventId),
            sequence: persistedEvents.length,
            occurredAt: draft.occurredAt ?? "2026-09-04T00:00:00.000Z",
          } as RuntimeEvent;
          persistedEvents.push(event);
          return event;
        },
        flush: async (): Promise<void> => undefined,
        close: async (): Promise<void> => undefined,
      };
      const assetStore = {
        put: async (input: { assetId: import("@computer-harness/protocol").AssetId; relativePath: string; mediaType: string; data: Uint8Array }): Promise<AssetRef> => ({
          assetId: input.assetId,
          relativePath: input.relativePath,
          mediaType: input.mediaType,
          byteLength: input.data.byteLength,
        }),
      };
      const controller = new RunController({
        runId,
        provider,
        computer: computerInstance,
        contextCompiler,
        toolRegistry: registry,
        policy: new DefaultRuntimePolicy(),
        eventWriter,
        assetStore,
      });
      await expect(controller.start("click once")).resolves.toBe("outcome_unknown");
      const events = controller.getEvents();
      expect(events.some((event) => event.type === "action.execution.started")).toBe(true);
      expect(events.some((event) => event.type === "action.execution.completed" || event.type === "action.execution.failed")).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: "run.finished", outcome: "outcome_unknown" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("OsworldBridgeClient ↔ Fake DesktopEnv process transport", () => {
  it("validates and routes the complete bridge RPC surface", async () => {
    const { child, client } = await startFakeBridge();
    try {
      await expect(client.health(abortSignal)).resolves.toMatchObject({ status: "ok", protocolVersion: "1" });
      await expect(client.reset("fake-task", abortSignal)).resolves.toEqual({ taskId: "fake-task", instruction: "fake task" });
      await expect(client.describe(abortSignal)).resolves.toMatchObject({ viewport, capabilities: { screenshot: true, pointer: true, keyboard: true } });
      await expect(client.observe(abortSignal)).resolves.toMatchObject({ mediaType: "image/png", width: 800, height: 600 });
      await expect(client.execute({ kind: "click", x: 10, y: 20 }, abortSignal)).resolves.toMatchObject({ status: "completed", postActionCapture: { mediaType: "image/png" } });
      await expect(client.evaluate(abortSignal)).resolves.toEqual({ score: 1 });
      await expect(client.close(abortSignal)).resolves.toBeUndefined();
    } finally {
      await stopFakeBridge(child);
    }
  });

  it("rejects a response with a mismatched request identity", async () => {
    const { child, client } = await startFakeBridge("bad-envelope");
    try {
      await expect(client.health(abortSignal)).rejects.toThrow("invalid response envelope");
    } finally {
      await stopFakeBridge(child);
    }
  });

  it("rejects a syntactically valid RPC response with an invalid screenshot result", async () => {
    const { child, client } = await startFakeBridge("bad-capture");
    try {
      await expect(client.observe(abortSignal)).rejects.toThrow("screenshot result is invalid");
    } finally {
      await stopFakeBridge(child);
    }
  });

  it("requires loopback URLs and preserves bridge authentication boundaries", async () => {
    expect(() => new OsworldBridgeClient({ baseUrl: "http://192.168.0.2:9999" })).toThrow("HTTP loopback");
    const correct = await startFakeBridge("normal", "secret", "secret");
    try {
      await expect(correct.client.health(abortSignal)).resolves.toMatchObject({ status: "ok" });
    } finally {
      await stopFakeBridge(correct.child);
    }
    const wrong = await startFakeBridge("normal", "secret", "wrong");
    try {
      await expect(wrong.client.health(abortSignal)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    } finally {
      await stopFakeBridge(wrong.child);
    }
    const missing = await startFakeBridge("normal", "secret");
    try {
      await expect(missing.client.health(abortSignal)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    } finally {
      await stopFakeBridge(missing.child);
    }
  });

  it("rejects an unsupported bridge protocol version", async () => {
    const { child, client } = await startFakeBridge("bad-version");
    try {
      await expect(client.health(abortSignal)).rejects.toThrow("health result is invalid");
    } finally {
      await stopFakeBridge(child);
    }
  });
});
