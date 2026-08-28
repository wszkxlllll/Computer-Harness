import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  ActionId,
  ActionIntent,
  AssetId,
  ComputerSessionId,
  EventId,
  ModelTurn,
  ObservationId,
  RunId,
  ToolCall,
  ToolCallId,
  Viewport,
} from "@computer-harness/protocol";
import {
  FileAssetStore,
  JsonlRunEventWriter,
  readRuntimeEvents,
  reduceRuntimeEvents,
} from "@computer-harness/trajectory";
import {
  DefaultContextCompiler,
  DefaultRuntimePolicy,
  RunController,
  ToolRegistry,
  type Computer,
  type ComputerOpenOptions,
  type ComputerSession,
  type IdFactory,
  type ModelInput,
  type ProviderAdapter,
} from "./index.js";

const runId = "runtime-test" as RunId;
const sessionId = "fake-computer" as ComputerSessionId;
const viewport: Viewport = { width: 800, height: 600, coordinateSpace: "physical" };

class TestIds implements IdFactory {
  private count = 0;

  public eventId(): EventId {
    return `event-${this.count++}` as EventId;
  }

  public observationId(): ObservationId {
    return `observation-${this.count++}` as ObservationId;
  }

  public assetId(): AssetId {
    return `asset-${this.count++}` as AssetId;
  }

  public actionId(): ActionId {
    return `action-${this.count++}` as ActionId;
  }
}

class FakeComputer implements Computer {
  public readonly calls: string[] = [];
  public readonly session: ComputerSession = {
    id: sessionId,
    backend: "fake",
    status: "ready",
    viewport,
    capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false },
    openedAt: "2026-08-28T00:00:00.000Z",
  };
  private observationCount = 0;

  public async open(_options: ComputerOpenOptions, signal: AbortSignal): Promise<ComputerSession> {
    signal.throwIfAborted();
    this.calls.push("open");
    return this.session;
  }

  public async observe(
    _session: ComputerSession,
    observationId: ObservationId,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    this.calls.push(`observe:${observationId}`);
    this.observationCount += 1;
    return {
      capturedAt: `2026-08-28T00:00:0${this.observationCount}.000Z`,
      viewport,
      screenshot: { mediaType: "image/png" as const, data: new Uint8Array([this.observationCount]) },
    };
  }

  public async execute(
    _session: ComputerSession,
    action: ActionIntent,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    this.calls.push(`execute:${action.kind}`);
    return {
      actionId: action.actionId,
      status: "completed" as const,
      startedAt: "2026-08-28T00:00:10.000Z",
      endedAt: "2026-08-28T00:00:10.010Z",
      durationMs: 10,
    };
  }

  public async close(_session: ComputerSession): Promise<void> {
    this.calls.push("close");
  }
}

class ScriptedProvider implements ProviderAdapter {
  public readonly id = "fake-provider";
  public readonly inputs: ModelInput[] = [];

  public constructor(private readonly turns: ModelTurn[]) {}

  public async generate(input: ModelInput, options: { signal: AbortSignal }): Promise<ModelTurn> {
    options.signal.throwIfAborted();
    this.inputs.push(input);
    const turn = this.turns.shift();
    if (turn === undefined) {
      throw new Error("fake provider script exhausted");
    }
    return turn;
  }
}

function clickCall(callId: string): ToolCall {
  return {
    id: callId as ToolCallId,
    name: "click",
    arguments: { x: 40, y: 50 },
  };
}

function clickRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "click",
    description: "Click a point in the current observation.",
    category: "computer",
    toAction: (args) => {
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        throw new Error("click arguments must be an object");
      }
      const point = args as { x?: unknown; y?: unknown };
      if (typeof point.x !== "number" || typeof point.y !== "number") {
        throw new Error("click requires numeric x and y");
      }
      return { kind: "click", point: { x: point.x, y: point.y } };
    },
  });
  return registry;
}

async function makeController(
  provider: ProviderAdapter,
  computer = new FakeComputer(),
  registry = clickRegistry(),
) {
  const directory = await mkdtemp(join(tmpdir(), "computer-harness-runtime-"));
  const writer = new JsonlRunEventWriter(join(directory, "trajectory.jsonl"), runId, {
    next: (() => {
      let count = 0;
      return () => `writer-event-${count++}` as EventId;
    })(),
  });
  const controller = new RunController({
    runId,
    provider,
    computer,
    contextCompiler: new DefaultContextCompiler(registry),
    toolRegistry: registry,
    policy: new DefaultRuntimePolicy(),
    eventWriter: writer,
    assetStore: new FileAssetStore(join(directory, "assets")),
    idFactory: new TestIds(),
    clock: { now: () => "2026-08-28T00:00:00.000Z" },
  });
  return { controller, computer, directory };
}

describe("RunController S2-2 happy path", () => {
  it("persists observe → model → action → observe → finish and links the ToolCall", async () => {
    const provider = new ScriptedProvider([
      { type: "tool_calls", calls: [clickCall("call-1")] },
      { type: "finish", summary: "done" },
    ]);
    const { controller, computer, directory } = await makeController(provider);

    await expect(controller.start("click the button")).resolves.toBe("succeeded");
    const events = await readRuntimeEvents(join(directory, "trajectory.jsonl"));
    const snapshot = reduceRuntimeEvents(events, runId);
    expect(snapshot).toMatchObject({ status: "finished", outcome: "succeeded", stepCount: 1 });
    expect(computer.calls).toHaveLength(5);
    expect(computer.calls[0]).toBe("open");
    expect(computer.calls[1]).toMatch(/^observe:/);
    expect(computer.calls[2]).toBe("execute:click");
    expect(computer.calls[3]).toMatch(/^observe:/);
    expect(computer.calls[4]).toBe("close");
    expect(events.map((event) => event.type)).toContain("action.proposed");
    const proposed = events.find((event) => event.type === "action.proposed");
    expect(proposed?.type === "action.proposed" ? proposed.callId : undefined).toBe("call-1");
    expect(provider.inputs[1]?.messages.some((message) =>
      message.content.some((content) => content.type === "tool_result"),
    )).toBe(true);
    await rm(directory, { recursive: true, force: true });
  });

  it("returns ToolResult for a non-computer tool without creating an ActionIntent", async () => {
    const registry = clickRegistry();
    registry.register({
      name: "read_value",
      description: "Read a deterministic value.",
      category: "side",
      execute: async () => ({ value: 7 }),
    });
    const provider = new ScriptedProvider([
      {
        type: "tool_calls",
        calls: [{ id: "call-2" as ToolCallId, name: "read_value", arguments: null }],
      },
      { type: "finish", summary: "done" },
    ]);
    const { controller, computer, directory } = await makeController(provider, new FakeComputer(), registry);

    await expect(controller.start("read the value")).resolves.toBe("succeeded");
    const events = await readRuntimeEvents(join(directory, "trajectory.jsonl"));
    expect(events.some((event) => event.type === "tool.call.completed")).toBe(true);
    expect(events.some((event) => event.type === "action.proposed")).toBe(false);
    expect(computer.calls.filter((call) => call.startsWith("execute:")).length).toBe(0);
    await rm(directory, { recursive: true, force: true });
  });

  it("rejects multiple computer calls as one invalid group and performs none", async () => {
    const provider = new ScriptedProvider([
      { type: "tool_calls", calls: [clickCall("call-3"), clickCall("call-4")] },
      { type: "finish", summary: "done" },
    ]);
    const { controller, computer, directory } = await makeController(provider);

    await expect(controller.start("do both clicks")).resolves.toBe("succeeded");
    const events = await readRuntimeEvents(join(directory, "trajectory.jsonl"));
    expect(events.filter((event) => event.type === "tool.call.rejected")).toHaveLength(2);
    expect(events.some((event) => event.type === "action.proposed")).toBe(false);
    expect(computer.calls.filter((call) => call.startsWith("execute:")).length).toBe(0);
    await rm(directory, { recursive: true, force: true });
  });
});

describe("RunController cancellation and unknown side effects", () => {
  it("passes the root AbortSignal to an in-flight provider and finishes cancelled", async () => {
    let providerStarted: (() => void) | undefined;
    const providerReady = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    const provider: ProviderAdapter = {
      id: "blocking-provider",
      async generate(_input, { signal }) {
        providerStarted?.();
        return await new Promise<ModelTurn>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    };
    const { controller, directory } = await makeController(provider);
    const running = controller.start("cancel me");
    await providerReady;
    controller.cancel("test cancellation");

    await expect(running).resolves.toBe("cancelled");
    const events = await readRuntimeEvents(join(directory, "trajectory.jsonl"));
    expect(events.at(-1)).toMatchObject({ type: "run.finished", outcome: "cancelled" });
    await rm(directory, { recursive: true, force: true });
  });

  it("does not fabricate a terminal receipt when computer execution throws", async () => {
    const computer = new FakeComputer();
    computer.execute = async () => {
      computer.calls.push("execute:unknown");
      throw new Error("driver disconnected after side effect");
    };
    const provider = new ScriptedProvider([{ type: "tool_calls", calls: [clickCall("call-5")] }]);
    const { controller, directory } = await makeController(provider, computer);

    await expect(controller.start("unknown side effect")).resolves.toBe("outcome_unknown");
    const events = await readRuntimeEvents(join(directory, "trajectory.jsonl"));
    expect(events.some((event) => event.type === "action.execution.completed")).toBe(false);
    expect(events.some((event) => event.type === "action.execution.failed")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "run.finished", outcome: "outcome_unknown" });
    const snapshot = reduceRuntimeEvents(events, runId);
    expect(snapshot.unresolvedActionId).toBeDefined();
    await rm(directory, { recursive: true, force: true });
  });
});
