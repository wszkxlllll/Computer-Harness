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
  ObservationFrame,
  ObservationId,
  RunId,
  ToolCall,
  ToolCallId,
  Viewport,
  RuntimeEventDraft,
} from "@computer-harness/protocol";
import {
  type AssetStore,
  FileAssetStore,
  JsonlRunEventWriter,
  readRuntimeEvents,
  reduceRuntimeEvents,
  type RunEventWriter,
} from "@computer-harness/trajectory";
import {
  DefaultRuntimePolicy,
  RunController,
  ToolRegistry,
  type Computer,
  type ComputerOpenOptions,
  type ComputerSession,
  type IdFactory,
  type ModelInput,
  type ModelMessage,
  type ProviderAdapter,
  type RuntimePolicy,
  type ContextCompiler,
  validateActionIntent,
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
  ): Promise<import("@computer-harness/protocol").ObservationCapture> {
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
  ): Promise<import("@computer-harness/protocol").ActionReceipt> {
    signal.throwIfAborted();
    this.calls.push(`execute:${action.kind}`);
    return {
      actionId: action.actionId,
      status: "completed" as const,
    };
  }

  public async close(_session: ComputerSession): Promise<void> {
    this.calls.push("close");
  }
}

class ScriptedProvider implements ProviderAdapter {
  public readonly id = "fake-provider";
  public readonly inputs: ModelInput[] = [];

  public constructor(
    private readonly turns: ModelTurn[],
    private readonly onGenerate?: (count: number) => void,
  ) {}

  public async generate(input: ModelInput, options: { signal: AbortSignal }): Promise<ModelTurn> {
    options.signal.throwIfAborted();
    this.inputs.push(input);
    this.onGenerate?.(this.inputs.length);
    const turn = this.turns.shift();
    if (turn === undefined) {
      throw new Error("fake provider script exhausted");
    }
    return turn;
  }
}

/** Runtime tests use a local contract double; the real Context package is tested separately. */
class TestContextCompiler implements ContextCompiler {
  public constructor(private readonly registry: ToolRegistry) {}

  public async compile(input: Parameters<ContextCompiler["compile"]>[0], signal: AbortSignal): Promise<ModelInput> {
    signal.throwIfAborted();
    const messages: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: input.goal }] }];
    let viewport = input.latestObservation?.viewport;
    const orderedEvents = [...input.recentEvents].sort((left, right) => left.sequence - right.sequence);
    const resultsByCallId = new Map<string, ModelMessage["content"][number]>();
    for (const event of orderedEvents) {
      if (event.type === "tool.call.completed") resultsByCallId.set(event.result.callId, { type: "tool_result", result: event.result });
      else if (event.type === "tool.call.failed") resultsByCallId.set(event.result.callId, { type: "tool_result", result: event.result });
      else if (event.type === "tool.call.rejected") resultsByCallId.set(event.callId, { type: "tool_result", result: { callId: event.callId, status: "rejected", error: { code: "TOOL_REJECTED", message: event.reason } } });
    }
    const pendingCallIds: string[] = [];
    const emittedCallIds = new Set<string>();
    const flushPending = (): void => {
      for (const callId of [...pendingCallIds]) {
        const result = resultsByCallId.get(callId);
        if (result === undefined || emittedCallIds.has(callId)) continue;
        messages.push({ role: "tool", content: [result] });
        emittedCallIds.add(callId);
      }
      pendingCallIds.length = 0;
    };
    const emitResult = (callId: string, result: ModelMessage["content"][number]): void => {
      if (emittedCallIds.has(callId)) return;
      const pendingIndex = pendingCallIds.indexOf(callId);
      if (pendingIndex >= 0) pendingCallIds.splice(pendingIndex, 1);
      messages.push({ role: "tool", content: [result] });
      emittedCallIds.add(callId);
    };
    for (const event of orderedEvents) {
      signal.throwIfAborted();
      if (event.type === "observation.created") {
        viewport = event.observation.viewport;
      } else if (event.type === "model.response.received") {
        if (event.turn.type === "tool_calls") {
          const content: ModelMessage["content"] = [];
          if (event.turn.assistantText !== undefined) content.push({ type: "text", text: event.turn.assistantText });
          if (event.turn.continuation !== undefined) content.push({ type: "provider_continuation", continuation: event.turn.continuation });
          for (const call of event.turn.calls) content.push({ type: "tool_call", call, ...(viewport === undefined ? {} : { viewport }) });
          messages.push({ role: "assistant", content });
          pendingCallIds.push(...event.turn.calls.map((call) => call.id));
        } else if (event.turn.type === "finish") {
          messages.push({ role: "assistant", content: [{ type: "text", text: event.turn.summary }] });
        }
      } else if (event.type === "tool.call.completed") {
        emitResult(event.result.callId, { type: "tool_result", result: event.result });
      } else if (event.type === "tool.call.failed") {
        emitResult(event.result.callId, { type: "tool_result", result: event.result });
      } else if (event.type === "tool.call.rejected") {
        emitResult(event.callId, { type: "tool_result", result: { callId: event.callId, status: "rejected", error: { code: "TOOL_REJECTED", message: event.reason } } });
      } else if (event.type === "user.input.received") {
        flushPending();
        messages.push({ role: "user", content: [{ type: "text", text: event.text }] });
      }
    }
    flushPending();
    if (input.latestObservation !== undefined) {
      messages.push({ role: "user", content: [{ type: "image", asset: input.latestObservation.screenshot, viewport: input.latestObservation.viewport }] });
    }
    return { system: "runtime test context", messages, tools: this.registry.modelTools() };
  }
}

class DenyClickPolicy extends DefaultRuntimePolicy {
  public override async evaluateToolCall(context: Parameters<RuntimePolicy["evaluateToolCall"]>[0]) {
    if (context.call.name === "click") {
      return { decision: "deny" as const, reason: "click denied for test" };
    }
    return { decision: "allow" as const };
  }
}

class ApprovalClickPolicy extends DefaultRuntimePolicy {
  public constructor(private readonly onApproval: () => void) {
    super();
  }

  public override async evaluateToolCall(context: Parameters<RuntimePolicy["evaluateToolCall"]>[0]) {
    if (context.call.name === "click") {
      this.onApproval();
      return { decision: "require_approval" as const, reason: "click requires approval" };
    }
    return { decision: "allow" as const };
  }
}

class BatchCommandPolicy extends DefaultRuntimePolicy {
  private applied = false;

  public constructor(private readonly enqueue: () => void) {
    super();
  }

  public override async evaluateToolCall(context: Parameters<RuntimePolicy["evaluateToolCall"]>[0]) {
    if (!this.applied && context.call.name === "click") {
      this.applied = true;
      this.enqueue();
    }
    return { decision: "allow" as const };
  }
}

class FailingWriter implements RunEventWriter {
  public constructor(
    private readonly delegate: RunEventWriter,
    private readonly shouldFail: (draft: RuntimeEventDraft) => boolean,
  ) {}

  public async append(draft: RuntimeEventDraft) {
    if (this.shouldFail(draft)) {
      throw new Error(`injected append failure for ${draft.type}`);
    }
    return this.delegate.append(draft);
  }

  public flush(): Promise<void> {
    return this.delegate.flush();
  }

  public close(): Promise<void> {
    return this.delegate.close();
  }
}

class CleanupFailingWriter implements RunEventWriter {
  public constructor(private readonly delegate: RunEventWriter) {}

  public append(draft: RuntimeEventDraft) {
    return this.delegate.append(draft);
  }

  public async flush(): Promise<void> {
    await this.delegate.flush();
    throw new Error("injected flush failure");
  }

  public async close(): Promise<void> {
    await this.delegate.close();
    throw new Error("injected close failure");
  }
}

function clickCall(callId: string): ToolCall {
  return {
    id: callId as ToolCallId,
    name: "click",
    arguments: { x: 40, y: 50 },
  };
}

function invalidClickCall(callId: string): ToolCall {
  return {
    id: callId as ToolCallId,
    name: "click",
    arguments: { x: "not-a-number", y: 50 },
  };
}

function outOfBoundsClickCall(callId: string): ToolCall {
  return {
    id: callId as ToolCallId,
    name: "click",
    arguments: { x: 800, y: 50 },
  };
}

function clickRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "click",
    description: "Click a point in the current observation.",
    category: "computer",
    inputSchema: {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" } },
      required: ["x", "y"],
      additionalProperties: false,
    },
    validate: validateClickArgs,
    toAction: (args) => {
      const point = validateClickArgs(args);
      return { kind: "click", point: { x: point.x, y: point.y } };
    },
  });
  return registry;
}

function validateClickArgs(args: import("@computer-harness/protocol").JsonValue): { x: number; y: number } {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new Error("click arguments must be an object");
  }
  const point = args as { x?: unknown; y?: unknown };
  if (typeof point.x !== "number" || !Number.isFinite(point.x) || typeof point.y !== "number" || !Number.isFinite(point.y)) {
    throw new Error("click requires finite numeric x and y");
  }
  return { x: point.x, y: point.y };
}

async function makeController(
  provider: ProviderAdapter,
  computer?: FakeComputer,
  registry = clickRegistry(),
  policy: RuntimePolicy = new DefaultRuntimePolicy(),
  overrides: {
    eventWriter?: (path: string) => RunEventWriter;
    assetStore?: AssetStore;
    onCleanupError?: (diagnostic: { operation: "event_writer.flush" | "event_writer.close" | "computer.close"; message: string }) => void;
  } = {},
) {
  const activeComputer = computer ?? new FakeComputer();
  const directory = await mkdtemp(join(tmpdir(), "computer-harness-runtime-"));
  const eventPath = join(directory, "trajectory.jsonl");
  const writer = overrides.eventWriter?.(eventPath) ?? new JsonlRunEventWriter(eventPath, runId, {
    next: (() => {
      let count = 0;
      return () => `writer-event-${count++}` as EventId;
    })(),
  });
  const controller = new RunController({
    runId,
    provider,
    computer: activeComputer,
    contextCompiler: new TestContextCompiler(registry),
    toolRegistry: registry,
    policy,
    eventWriter: writer,
    assetStore: overrides.assetStore ?? new FileAssetStore(join(directory, "assets")),
    idFactory: new TestIds(),
    clock: { now: () => "2026-08-28T00:00:00.000Z" },
    ...(overrides.onCleanupError === undefined ? {} : { onCleanupError: overrides.onCleanupError }),
  });
  return { controller, computer: activeComputer, directory };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not reached during the deterministic test window");
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
    expect(controller.getSnapshot()).toEqual(snapshot);
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

  it("projects model request count and the finish summary separately from outcome", async () => {
    const provider = new ScriptedProvider([{ type: "finish", summary: "model says done", usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 } }]);
    const { controller } = await makeController(provider, undefined, clickRegistry(), new DefaultRuntimePolicy(10, 1));
    await expect(controller.start("finish now")).resolves.toBe("succeeded");
    expect(controller.getSnapshot()).toMatchObject({ modelRequestCount: 1, summary: "model says done", outcome: "succeeded", modelUsage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 } });
  });

  it("carries a provider continuation from one ModelTurn into the next context", async () => {
    const provider = new ScriptedProvider([
      {
        type: "tool_calls",
        calls: [clickCall("call-with-continuation")],
        continuation: { providerId: "fake-provider", kind: "reasoning_content", content: "retain this reasoning" },
      },
      { type: "finish", summary: "done" },
    ]);
    const { controller } = await makeController(provider);

    await expect(controller.start("preserve provider context")).resolves.toBe("succeeded");
    expect(provider.inputs[1]?.messages.some((message) => message.content.some((block) =>
      block.type === "provider_continuation" && block.continuation.content === "retain this reasoning",
    ))).toBe(true);
  });

  it("preserves a provider-reported failure as a failed run", async () => {
    const provider = new ScriptedProvider([{ type: "finish", summary: "the task is not complete", reportedStatus: "failure" }]);
    const { controller } = await makeController(provider, undefined, clickRegistry(), new DefaultRuntimePolicy(10, 1));
    await expect(controller.start("finish unsuccessfully")).resolves.toBe("failed");
    expect(controller.getSnapshot()).toMatchObject({ outcome: "failed", reportedStatus: "failure", summary: "the task is not complete" });
  });

  it("uses a model-request budget independently from the GUI step budget", async () => {
    const provider = new ScriptedProvider([
      { type: "tool_calls", calls: [{ id: "budget-1" as ToolCallId, name: "missing", arguments: null }] },
      { type: "tool_calls", calls: [{ id: "budget-2" as ToolCallId, name: "missing", arguments: null }] },
    ]);
    const { controller } = await makeController(provider, undefined, clickRegistry(), new DefaultRuntimePolicy(10, 2));
    await expect(controller.start("do not loop")).resolves.toBe("budget_exhausted");
    expect(controller.getSnapshot()).toMatchObject({ modelRequestCount: 2, stepCount: 0, outcome: "budget_exhausted" });
  });

  it("returns ToolResult for a non-computer tool without creating an ActionIntent", async () => {
    const registry = clickRegistry();
    registry.register({
      name: "read_value",
      description: "Read a deterministic value.",
      category: "side",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      validate: (args) => {
        if (args !== null) {
          throw new Error("read_value accepts null arguments");
        }
      },
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

  it("preflights an unknown tool before any GUI side effect", async () => {
    const provider = new ScriptedProvider([
      { type: "tool_calls", calls: [clickCall("call-unknown-click"), { id: "call-unknown" as ToolCallId, name: "missing", arguments: null }] },
      { type: "finish", summary: "done" },
    ]);
    const { controller, computer, directory } = await makeController(provider);

    await expect(controller.start("reject unknown tool")).resolves.toBe("succeeded");
    const events = await readRuntimeEvents(join(directory, "trajectory.jsonl"));
    expect(computer.calls.filter((call) => call.startsWith("execute:")).length).toBe(0);
    expect(events.filter((event) => event.type === "tool.call.rejected")).toHaveLength(2);
    await rm(directory, { recursive: true, force: true });
  });

  it("preflights invalid arguments before any GUI side effect", async () => {
    const provider = new ScriptedProvider([
      { type: "tool_calls", calls: [invalidClickCall("call-invalid")] },
      { type: "finish", summary: "done" },
    ]);
    const { controller, computer, directory } = await makeController(provider);

    await expect(controller.start("reject invalid arguments")).resolves.toBe("succeeded");
    const events = await readRuntimeEvents(join(directory, "trajectory.jsonl"));
    expect(computer.calls.filter((call) => call.startsWith("execute:")).length).toBe(0);
    expect(events.filter((event) => event.type === "tool.call.rejected")).toHaveLength(1);
    await rm(directory, { recursive: true, force: true });
  });

  it("rejects a GUI action outside the current Observation viewport", async () => {
    const provider = new ScriptedProvider([
      { type: "tool_calls", calls: [outOfBoundsClickCall("call-outside")] },
      { type: "finish", summary: "done after rejection" },
    ]);
    const { controller, computer, directory } = await makeController(provider);

    await expect(controller.start("reject an out-of-bounds click")).resolves.toBe("succeeded");
    expect(computer.calls.filter((call) => call.startsWith("execute:")).length).toBe(0);
    expect(controller.getEvents().some((event) => event.type === "action.proposed")).toBe(false);
    expect(controller.getEvents().some((event) => event.type === "tool.call.rejected" && event.reason.includes("outside viewport"))).toBe(true);
    await rm(directory, { recursive: true, force: true });
  });

  it("validates the whole turn before running a non-GUI call", async () => {
    let executions = 0;
    const registry = clickRegistry();
    registry.register({
      name: "record_call",
      description: "Record a deterministic call.",
      category: "planning",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      validate: (args) => {
        if (args !== null) {
          throw new Error("record_call accepts null arguments");
        }
      },
      execute: async () => {
        executions += 1;
        return { ok: true };
      },
    });
    const provider = new ScriptedProvider([
      {
        type: "tool_calls",
        calls: [
          { id: "call-record" as ToolCallId, name: "record_call", arguments: null },
          invalidClickCall("call-invalid-with-side-call"),
        ],
      },
      { type: "finish", summary: "done" },
    ]);
    const { controller, computer, directory } = await makeController(provider, new FakeComputer(), registry);

    await expect(controller.start("reject invalid mixed turn")).resolves.toBe("succeeded");
    expect(executions).toBe(0);
    expect(computer.calls.filter((call) => call.startsWith("execute:")).length).toBe(0);
    const rejected = controller.getEvents().filter((event) => event.type === "tool.call.rejected");
    expect(rejected).toHaveLength(2);
    expect(rejected.every((event) => event.type !== "tool.call.rejected" || event.reason.includes("invalid arguments"))).toBe(true);
    const receivedIds = controller.getEvents()
      .filter((event): event is Extract<typeof event, { type: "tool.call.received" }> => event.type === "tool.call.received")
      .map((event) => event.call.id);
    expect(rejected.map((event) => event.type === "tool.call.rejected" ? event.callId : undefined)).toEqual(receivedIds);
    await rm(directory, { recursive: true, force: true });
  });

  it("preflights a policy denial before any GUI side effect", async () => {
    const provider = new ScriptedProvider([
      { type: "tool_calls", calls: [clickCall("call-denied")] },
      { type: "finish", summary: "done" },
    ]);
    const { controller, computer, directory } = await makeController(
      provider,
      new FakeComputer(),
      clickRegistry(),
      new DenyClickPolicy(),
    );

    await expect(controller.start("reject denied action")).resolves.toBe("succeeded");
    const events = await readRuntimeEvents(join(directory, "trajectory.jsonl"));
    expect(computer.calls.filter((call) => call.startsWith("execute:")).length).toBe(0);
    expect(events.filter((event) => event.type === "tool.call.rejected")).toHaveLength(1);
    await rm(directory, { recursive: true, force: true });
  });

  it("rejects duplicate ToolCall ids before recording a partial turn", async () => {
    const provider = new ScriptedProvider([{ type: "tool_calls", calls: [clickCall("duplicate"), clickCall("duplicate")] }]);
    const { controller, computer, directory } = await makeController(provider);

    await expect(controller.start("reject duplicate calls")).resolves.toBe("failed");
    const events = await readRuntimeEvents(join(directory, "trajectory.jsonl"));
    expect(events.some((event) => event.type === "tool.call.received")).toBe(false);
    expect(computer.calls.filter((call) => call.startsWith("execute:")).length).toBe(0);
    await rm(directory, { recursive: true, force: true });
  });
});

describe("shared GUI Action validation", () => {
  const observation: ObservationFrame = {
    id: "validation-observation" as ObservationId,
    runId,
    computerSessionId: sessionId,
    capturedAt: "2026-08-28T00:00:00.000Z",
    viewport,
    screenshot: {
      assetId: "validation-asset" as AssetId,
      relativePath: "screenshots/validation.png",
      mediaType: "image/png",
      byteLength: 1,
    },
  };

  it("checks keyboard capability for type and keypress actions", async () => {
    expect(() => validateActionIntent({
      actionId: "type-action" as ActionId,
      basedOn: observation.id,
      kind: "type",
      text: "hello",
    }, { observation, capabilities: { screenshot: true, pointer: true, keyboard: false, accessibility: false } })).toThrow(/keyboard/);
    expect(() => validateActionIntent({
      actionId: "key-action" as ActionId,
      basedOn: observation.id,
      kind: "keypress",
      keys: ["ENTER"],
    }, { observation, capabilities: { screenshot: true, pointer: true, keyboard: false, accessibility: false } })).toThrow(/keyboard/);
  });

  it("rejects a GUI action bound to an older observation", () => {
    expect(() => validateActionIntent({
      actionId: "stale-action" as ActionId,
      basedOn: "older-observation" as ObservationId,
      kind: "click",
      point: { x: 10, y: 10 },
    }, { observation, capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false } })).toThrow(/not current observation/);
  });

  it("checks pointer capability and all drag endpoints", async () => {
    expect(() => validateActionIntent({
      actionId: "drag-action" as ActionId,
      basedOn: observation.id,
      kind: "drag",
      from: { x: 10, y: 10 },
      to: { x: 800, y: 10 },
    }, { observation, capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false } })).toThrow(/outside viewport/);
    expect(() => validateActionIntent({
      actionId: "scroll-action" as ActionId,
      basedOn: observation.id,
      kind: "scroll",
      point: { x: 100, y: 100 },
      direction: "down",
      ticks: 10,
    }, { observation, capabilities: { screenshot: true, pointer: false, keyboard: true, accessibility: false } })).toThrow(/pointer/);
    expect(() => validateActionIntent({
      actionId: "scroll-invalid-direction" as ActionId,
      basedOn: observation.id,
      kind: "scroll",
      point: { x: 100, y: 100 },
      direction: "diagonal" as "down",
      ticks: 1,
    }, { observation, capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false } })).toThrow(/direction/);
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
    expect(events.some((event) => event.type === "model.request.failed" && event.category === "cancelled" && event.message.includes("test cancellation"))).toBe(true);
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

  it("classifies cancellation during an unknown Computer execution as outcome_unknown", async () => {
    let executeStartedResolve: (() => void) | undefined;
    const executeStarted = new Promise<void>((resolve) => {
      executeStartedResolve = resolve;
    });
    const computer = new FakeComputer();
    computer.execute = async (_session, _action, signal) => {
      executeStartedResolve?.();
      return await new Promise<import("@computer-harness/protocol").ActionReceipt>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    const provider = new ScriptedProvider([{ type: "tool_calls", calls: [clickCall("call-cancel-during-action")] }]);
    const created = await makeController(provider, computer);
    const running = created.controller.start("cancel during action");
    await executeStarted;
    created.controller.cancel("cancel during unknown action");

    await expect(running).resolves.toBe("outcome_unknown");
    const events = created.controller.getEvents();
    expect(events.some((event) => event.type === "action.execution.started")).toBe(true);
    expect(events.some((event) => event.type === "action.execution.completed" || event.type === "action.execution.failed")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "run.finished", outcome: "outcome_unknown" });
    await rm(created.directory, { recursive: true, force: true });
  });
});

describe("RunController command inbox and control semantics", () => {
  it("waits for user input and forwards the answer to the next ModelTurn", async () => {
    let firstRequestResolve: (() => void) | undefined;
    const firstRequest = new Promise<void>((resolve) => {
      firstRequestResolve = resolve;
    });
    const provider = new ScriptedProvider(
      [{ type: "user_input_required", question: "Where should I save it?" }, { type: "finish", summary: "done" }],
      (count) => {
        if (count === 1) {
          firstRequestResolve?.();
        }
      },
    );
    const { controller, directory } = await makeController(provider);
    const running = controller.start("save the file");
    await firstRequest;
    await waitUntil(() => controller.getSnapshot().status === "waiting_user");

    await expect(controller.submitUserInput("Save it in Documents")).resolves.toBeUndefined();
    await expect(running).resolves.toBe("succeeded");
    expect(provider.inputs[1]?.messages.some((message) =>
      message.content.some((content) => content.type === "text" && content.text.includes("Documents")),
    )).toBe(true);
    const events = await readRuntimeEvents(join(directory, "trajectory.jsonl"));
    expect(controller.getSnapshot()).toEqual(reduceRuntimeEvents(events, runId));
    expect(events.map((event) => event.type)).toContain("user.input.requested");
    expect(events.map((event) => event.type)).toContain("user.input.received");
    await rm(directory, { recursive: true, force: true });
  });

  it("supersedes a GUI ToolCall when correction arrives before action started", async () => {
    let controller!: RunController;
    let correction: Promise<void> | undefined;
    const provider = new ScriptedProvider(
      [{ type: "tool_calls", calls: [clickCall("call-correction")] }, { type: "finish", summary: "done" }],
      (count) => {
        if (count === 1) {
          correction = controller.submitUserInput("Do not click that button");
        }
      },
    );
    const created = await makeController(provider);
    controller = created.controller;
    const running = controller.start("click the button");

    await expect(running).resolves.toBe("succeeded");
    await waitUntil(() => correction !== undefined);
    await expect(correction).resolves.toBeUndefined();
    expect(created.computer.calls.filter((call) => call.startsWith("execute:")).length).toBe(0);
    expect(created.computer.calls.filter((call) => call.startsWith("observe:")).length).toBe(2);
    expect(controller.getEvents().some((event) => event.type === "user.input.received")).toBe(true);
    expect(controller.getEvents().some((event) => event.type === "tool.call.rejected" && event.reason.includes("superseded"))).toBe(true);
    expect(reduceRuntimeEvents(await readRuntimeEvents(join(created.directory, "trajectory.jsonl")), runId)).toEqual(controller.getSnapshot());
    expect(provider.inputs[1]?.messages.some((message) =>
      message.content.some((content) => content.type === "text" && content.text.includes("Do not click")),
    )).toBe(true);
    expect(provider.inputs[1]?.messages.some((message) =>
      message.content.some((content) => content.type === "tool_result" && content.result.status === "rejected"),
    )).toBe(true);
    const correctedMessages = provider.inputs[1]?.messages ?? [];
    const correctedAssistantIndex = correctedMessages.findIndex((message) => message.role === "assistant");
    const correctedResultIndex = correctedMessages.findIndex((message) =>
      message.role === "tool" && message.content.some((content) => content.type === "tool_result" && content.result.callId === "call-correction"),
    );
    const correctionIndex = correctedMessages.findIndex((message) =>
      message.role === "user" && message.content.some((content) => content.type === "text" && content.text.includes("Do not click")),
    );
    expect(correctedAssistantIndex).toBeGreaterThanOrEqual(0);
    expect(correctedResultIndex).toBeGreaterThan(correctedAssistantIndex);
    expect(correctedResultIndex).toBeLessThan(correctionIndex);
    await rm(created.directory, { recursive: true, force: true });
  });

  it("pauses after a ModelTurn and resumes the same turn", async () => {
    let controller!: RunController;
    let pauseResult: Promise<void> | undefined;
    let pauseReadyResolve: (() => void) | undefined;
    const pauseReady = new Promise<void>((resolve) => {
      pauseReadyResolve = resolve;
    });
    const provider = new ScriptedProvider(
      [{ type: "tool_calls", calls: [clickCall("call-pause")] }, { type: "finish", summary: "done" }],
      (count) => {
        if (count === 1) {
          pauseResult = controller.pause("inspect before action");
          pauseReadyResolve?.();
        }
      },
    );
    const created = await makeController(provider);
    controller = created.controller;
    const running = controller.start("click after pause");
    await pauseReady;
    await expect(pauseResult as Promise<void>).resolves.toBeUndefined();
    await waitUntil(() => controller.getSnapshot().status === "paused");
    expect(created.computer.calls.filter((call) => call.startsWith("execute:")).length).toBe(0);

    await expect(controller.resume()).resolves.toBeUndefined();
    await expect(running).resolves.toBe("succeeded");
    expect(created.computer.calls.filter((call) => call.startsWith("execute:")).length).toBe(1);
    expect(reduceRuntimeEvents(await readRuntimeEvents(join(created.directory, "trajectory.jsonl")), runId)).toEqual(controller.getSnapshot());
    await rm(created.directory, { recursive: true, force: true });
  });

  it("uses the final status when pause and resume arrive in one FIFO drain", async () => {
    let controller!: RunController;
    let commandsDone!: Promise<void>;
    const provider = new ScriptedProvider([
      { type: "tool_calls", calls: [clickCall("call-same-drain")] },
      { type: "finish", summary: "done" },
    ]);
    const policy = new BatchCommandPolicy(() => {
      const paused = controller.pause("inspect");
      const resumed = controller.resume();
      commandsDone = Promise.all([paused, resumed]).then(() => undefined);
    });
    const created = await makeController(provider, new FakeComputer(), clickRegistry(), policy);
    controller = created.controller;
    const running = controller.start("pause then resume in one drain");
    await expect(running).resolves.toBe("succeeded");
    await expect(commandsDone).resolves.toBeUndefined();
    expect(created.computer.calls.filter((call) => call.startsWith("execute:")).length).toBe(1);
    expect(provider.inputs).toHaveLength(2);
    await rm(created.directory, { recursive: true, force: true });
  });

  it("keeps correction semantics when pause, correction, and resume share one drain", async () => {
    let controller!: RunController;
    let commandsDone!: Promise<void>;
    const provider = new ScriptedProvider([
      { type: "tool_calls", calls: [clickCall("call-corrected-drain")] },
      { type: "finish", summary: "done" },
    ]);
    const policy = new BatchCommandPolicy(() => {
      const paused = controller.pause("inspect");
      const corrected = controller.submitUserInput("Do not click");
      const resumed = controller.resume();
      commandsDone = Promise.all([paused, corrected, resumed]).then(() => undefined);
    });
    const created = await makeController(provider, new FakeComputer(), clickRegistry(), policy);
    controller = created.controller;
    const running = controller.start("pause, correct, then resume in one drain");
    await expect(running).resolves.toBe("succeeded");
    await expect(commandsDone).resolves.toBeUndefined();
    expect(created.computer.calls.filter((call) => call.startsWith("execute:")).length).toBe(0);
    expect(created.controller.getEvents().some((event) => event.type === "tool.call.rejected" && event.reason === "superseded by user correction")).toBe(true);
    expect(created.computer.calls.filter((call) => call.startsWith("observe:")).length).toBe(2);
    const correctedTurnMessages = provider.inputs[1]?.messages ?? [];
    expect(correctedTurnMessages.filter((message) =>
      message.role === "tool" && message.content.some((content) => content.type === "tool_result" && content.result.callId === "call-corrected-drain"),
    )).toHaveLength(1);
    expect(correctedTurnMessages.some((message) =>
      message.role === "user" && message.content.some((content) => content.type === "text" && content.text.includes("Do not click")),
    )).toBe(true);
    await rm(created.directory, { recursive: true, force: true });
  });

  it("keeps a same-batch correction across a later resume", async () => {
    let controller!: RunController;
    let commandsDone: Promise<void> | undefined;
    let notifyReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      notifyReady = resolve;
    });
    const provider = new ScriptedProvider(
      [{ type: "tool_calls", calls: [clickCall("call-paused-correction")] }, { type: "finish", summary: "done" }],
      (count) => {
        if (count === 1) {
          commandsDone = Promise.all([
            controller.pause("inspect"),
            controller.submitUserInput("Do not click"),
          ]).then(() => undefined);
          notifyReady();
        }
      },
    );
    const created = await makeController(provider);
    controller = created.controller;
    const running = controller.start("pause and correct before action");
    await ready;
    await expect(commandsDone).resolves.toBeUndefined();
    await waitUntil(() => controller.getSnapshot().status === "paused");
    expect(created.computer.calls.filter((call) => call.startsWith("execute:")).length).toBe(0);

    await expect(controller.resume()).resolves.toBeUndefined();
    await expect(running).resolves.toBe("succeeded");
    expect(created.computer.calls.filter((call) => call.startsWith("execute:")).length).toBe(0);
    expect(created.computer.calls.filter((call) => call.startsWith("observe:")).length).toBe(2);
    const rejected = created.controller.getEvents().filter((event) => event.type === "tool.call.rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ callId: "call-paused-correction", reason: "superseded by user correction" });
    const correctedTurnMessages = provider.inputs[1]?.messages ?? [];
    const correctedResult = correctedTurnMessages.find((message) =>
      message.role === "tool" && message.content.some((content) =>
        content.type === "tool_result" && content.result.callId === "call-paused-correction",
      ),
    );
    expect(correctedResult).toBeDefined();
    expect(correctedTurnMessages.some((message) =>
      message.role === "user" && message.content.some((content) =>
        content.type === "text" && content.text.includes("Do not click"),
      ),
    )).toBe(true);
    await rm(created.directory, { recursive: true, force: true });
  });

  it("does not consume a corrected finish turn after a later resume", async () => {
    let controller!: RunController;
    let commandsDone: Promise<void> | undefined;
    let notifyReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      notifyReady = resolve;
    });
    const provider = new ScriptedProvider(
      [{ type: "finish", summary: "stale finish" }, { type: "finish", summary: "corrected finish" }],
      (count) => {
        if (count === 1) {
          commandsDone = Promise.all([
            controller.pause("inspect"),
            controller.submitUserInput("Continue checking"),
          ]).then(() => undefined);
          notifyReady();
        }
      },
    );
    const created = await makeController(provider);
    controller = created.controller;
    const running = controller.start("pause and correct before finish");
    await ready;
    await expect(commandsDone).resolves.toBeUndefined();
    await waitUntil(() => controller.getSnapshot().status === "paused");

    await expect(controller.resume()).resolves.toBeUndefined();
    await expect(running).resolves.toBe("succeeded");
    expect(provider.inputs).toHaveLength(2);
    expect(controller.getSnapshot()).toMatchObject({ summary: "corrected finish" });
    expect(created.controller.getEvents().filter((event) => event.type === "tool.call.rejected")).toHaveLength(0);
    expect(created.computer.calls.filter((call) => call.startsWith("observe:")).length).toBe(2);
    await rm(created.directory, { recursive: true, force: true });
  });

  it("invalidates a deferred turn when correction follows resume without waiting", async () => {
    let controller!: RunController;
    let pauseReadyResolve!: () => void;
    const pauseReady = new Promise<void>((resolve) => {
      pauseReadyResolve = resolve;
    });
    const provider = new ScriptedProvider(
      [{ type: "tool_calls", calls: [clickCall("call-resume-then-correction")] }, { type: "finish", summary: "done" }],
      (count) => {
        if (count === 1) {
          void controller.pause("inspect").then(() => pauseReadyResolve());
        }
      },
    );
    const created = await makeController(provider);
    controller = created.controller;
    const running = controller.start("pause, resume, then correct");
    await pauseReady;
    await waitUntil(() => controller.getSnapshot().status === "paused");

    const resumed = controller.resume();
    const corrected = controller.submitUserInput("Change the target");
    await Promise.all([resumed, corrected]);
    await expect(running).resolves.toBe("succeeded");
    expect(created.computer.calls.filter((call) => call.startsWith("execute:")).length).toBe(0);
    expect(created.controller.getEvents().filter((event) => event.type === "tool.call.rejected")).toHaveLength(1);
    expect(provider.inputs).toHaveLength(2);
    const correctedMessages = provider.inputs[1]?.messages ?? [];
    expect(correctedMessages.some((message) =>
      message.role === "user" && message.content.some((content) =>
        content.type === "text" && content.text.includes("Change the target"),
      ),
    )).toBe(true);
    await rm(created.directory, { recursive: true, force: true });
  });

  it("invalidates remaining ToolCalls when correction follows resume without waiting", async () => {
    let controller!: RunController;
    let pauseDone: Promise<void> | undefined;
    let firstExecutedResolve!: () => void;
    const firstExecuted = new Promise<void>((resolve) => {
      firstExecutedResolve = resolve;
    });
    const executed: string[] = [];
    const registry = new ToolRegistry();
    registry.register({
      name: "first_side_effect",
      description: "Run the first deterministic side effect.",
      category: "planning",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      validate: (args) => {
        if (args !== null) throw new Error("first_side_effect accepts null arguments");
      },
      execute: async () => {
        executed.push("first");
        firstExecutedResolve();
        pauseDone = controller.pause("inspect after first call");
        return { executed: "first" };
      },
    });
    registry.register({
      name: "second_side_effect",
      description: "Run the second deterministic side effect.",
      category: "planning",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      validate: (args) => {
        if (args !== null) throw new Error("second_side_effect accepts null arguments");
      },
      execute: async () => {
        executed.push("second");
        return { executed: "second" };
      },
    });
    const provider = new ScriptedProvider([
      {
        type: "tool_calls",
        calls: [
          { id: "first-side-call" as ToolCallId, name: "first_side_effect", arguments: null },
          { id: "second-side-call" as ToolCallId, name: "second_side_effect", arguments: null },
        ],
      },
      { type: "finish", summary: "done" },
    ]);
    const created = await makeController(provider, undefined, registry);
    controller = created.controller;
    const running = controller.start("pause after one side effect, then correct");
    await firstExecuted;
    await expect(pauseDone).resolves.toBeUndefined();
    expect(controller.getSnapshot().status).toBe("paused");

    const resumed = controller.resume();
    const corrected = controller.submitUserInput("Change the target");
    await Promise.all([resumed, corrected]);
    await expect(running).resolves.toBe("succeeded");
    expect(executed).toEqual(["first"]);
    expect(created.controller.getEvents().filter((event) => event.type === "tool.call.rejected")).toHaveLength(1);
    expect(created.controller.getEvents().some((event) => event.type === "tool.call.rejected" && event.callId === "second-side-call")).toBe(true);
    await rm(created.directory, { recursive: true, force: true });
  });

  it("waits for approval, executes only after approval, and records the resolution", async () => {
    let approvalSeenResolve: (() => void) | undefined;
    const approvalSeen = new Promise<void>((resolve) => {
      approvalSeenResolve = resolve;
    });
    const provider = new ScriptedProvider([
      { type: "tool_calls", calls: [clickCall("call-approval")] },
      { type: "finish", summary: "done" },
    ]);
    const policy = new ApprovalClickPolicy(() => approvalSeenResolve?.());
    const created = await makeController(provider, new FakeComputer(), clickRegistry(), policy);
    const running = created.controller.start("click with approval");
    await approvalSeen;
    await waitUntil(() => created.controller.getSnapshot().status === "waiting_approval");
    const requestId = created.controller.getSnapshot().pendingApproval?.requestId;
    expect(requestId).toBeDefined();
    expect(created.computer.calls.filter((call) => call.startsWith("execute:")).length).toBe(0);

    await expect(created.controller.resolveApproval(requestId ?? "", true)).resolves.toBeUndefined();
    await expect(running).resolves.toBe("succeeded");
    expect(created.computer.calls.filter((call) => call.startsWith("execute:")).length).toBe(1);
    expect(created.controller.getEvents().some((event) => event.type === "approval.resolved")).toBe(true);
    expect(reduceRuntimeEvents(await readRuntimeEvents(join(created.directory, "trajectory.jsonl")), runId)).toEqual(created.controller.getSnapshot());
    await rm(created.directory, { recursive: true, force: true });
  });

  it("records approval denial as a terminal rejected ToolResult before replanning", async () => {
    let approvalSeenResolve: (() => void) | undefined;
    const approvalSeen = new Promise<void>((resolve) => {
      approvalSeenResolve = resolve;
    });
    const provider = new ScriptedProvider([
      { type: "tool_calls", calls: [clickCall("call-approval-denied")] },
      { type: "finish", summary: "done after denial" },
    ]);
    const policy = new ApprovalClickPolicy(() => approvalSeenResolve?.());
    const created = await makeController(provider, new FakeComputer(), clickRegistry(), policy);
    const running = created.controller.start("click only if approved");
    await approvalSeen;
    await waitUntil(() => created.controller.getSnapshot().status === "waiting_approval");
    const requestId = created.controller.getSnapshot().pendingApproval?.requestId;
    await expect(created.controller.resolveApproval(requestId ?? "", false)).resolves.toBeUndefined();
    await expect(running).resolves.toBe("succeeded");
    expect(created.computer.calls.filter((call) => call.startsWith("execute:")).length).toBe(0);
    const events = created.controller.getEvents();
    expect(events.some((event) => event.type === "approval.resolved" && event.approved === false)).toBe(true);
    expect(events.some((event) => event.type === "tool.call.rejected" && event.callId === "call-approval-denied")).toBe(true);
    expect(provider.inputs[1]?.messages.some((message) =>
      message.content.some((content) => content.type === "tool_result" && content.result.status === "rejected"),
    )).toBe(true);
    await rm(created.directory, { recursive: true, force: true });
  });

  it("cancels after a provider turn is returned but before it can cause a GUI side effect", async () => {
    let controller!: RunController;
    const provider = new ScriptedProvider(
      [{ type: "tool_calls", calls: [clickCall("call-cancel-before-start")] }],
      (count) => {
        if (count === 1) {
          queueMicrotask(() => controller.cancel("cancel after provider response"));
        }
      },
    );
    const created = await makeController(provider);
    controller = created.controller;
    const running = controller.start("cancel before click");

    await expect(running).resolves.toBe("cancelled");
    expect(created.computer.calls.filter((call) => call.startsWith("execute:")).length).toBe(0);
    expect(controller.getEvents().some((event) => event.type === "action.execution.started")).toBe(false);
    await rm(created.directory, { recursive: true, force: true });
  });

  it("does not repeat an already-started action when correction arrives during execution", async () => {
    let controller!: RunController;
    let correction!: Promise<void>;
    const computer = new FakeComputer();
    computer.execute = async (_session, action, signal) => {
      signal.throwIfAborted();
      computer.calls.push("execute:click");
      correction = controller.submitUserInput("The click already happened; continue from here");
      return {
        actionId: action.actionId,
        status: "completed" as const,
      };
    };
    const provider = new ScriptedProvider([
      { type: "tool_calls", calls: [clickCall("call-correction-after-start")] },
      { type: "finish", summary: "continued" },
    ]);
    const created = await makeController(provider, computer);
    controller = created.controller;
    const running = controller.start("click once");

    await expect(running).resolves.toBe("succeeded");
    await expect(correction).resolves.toBeUndefined();
    expect(computer.calls.filter((call) => call === "execute:click")).toHaveLength(1);
    expect(provider.inputs).toHaveLength(2);
    await rm(created.directory, { recursive: true, force: true });
  });

  it("rejects commands after the Run is finished", async () => {
    const provider = new ScriptedProvider([{ type: "finish", summary: "done" }]);
    const { controller, directory } = await makeController(provider);
    await expect(controller.start("finish now")).resolves.toBe("succeeded");
    await expect(controller.submitUserInput("too late")).rejects.toThrow("already finished");
    await expect(controller.pause()).rejects.toThrow("already finished");
    await expect(controller.resume()).rejects.toThrow("already finished");
    await expect(controller.resolveApproval("approval", true)).rejects.toThrow("already finished");
    await rm(directory, { recursive: true, force: true });
  });
});

describe("RunController S2-4 failure boundaries", () => {
  function jsonlWriter(path: string): RunEventWriter {
    return new JsonlRunEventWriter(path, runId, {
      next: (() => {
        let count = 0;
        return () => `writer-event-${count++}` as EventId;
      })(),
    });
  }

  it("does not execute when action.execution.started cannot be persisted", async () => {
    const provider = new ScriptedProvider([{ type: "tool_calls", calls: [clickCall("call-started-write")] }]);
    const computer = new FakeComputer();
    const created = await makeController(provider, computer, clickRegistry(), new DefaultRuntimePolicy(), {
      eventWriter: (path) => new FailingWriter(jsonlWriter(path), (draft) => draft.type === "action.execution.started"),
    });

    await expect(created.controller.start("started write fails")).resolves.toBe("failed");
    expect(computer.calls.filter((call) => call.startsWith("execute:")).length).toBe(0);
    const events = await readRuntimeEvents(join(created.directory, "trajectory.jsonl"));
    expect(events.some((event) => event.type === "action.execution.started")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "run.finished", outcome: "failed" });
    await rm(created.directory, { recursive: true, force: true });
  });

  it("does not retry a GUI action when its terminal Event cannot be persisted", async () => {
    const provider = new ScriptedProvider([{ type: "tool_calls", calls: [clickCall("call-terminal-write")] }]);
    const computer = new FakeComputer();
    const created = await makeController(provider, computer, clickRegistry(), new DefaultRuntimePolicy(), {
      eventWriter: (path) => new FailingWriter(jsonlWriter(path), (draft) => draft.type === "action.execution.completed"),
    });

    await expect(created.controller.start("terminal write fails")).resolves.toBe("outcome_unknown");
    expect(computer.calls.filter((call) => call.startsWith("execute:")).length).toBe(1);
    const events = await readRuntimeEvents(join(created.directory, "trajectory.jsonl"));
    expect(events.filter((event) => event.type === "action.execution.started")).toHaveLength(1);
    expect(events.some((event) => event.type === "action.execution.completed")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "run.finished", outcome: "outcome_unknown" });
    expect(reduceRuntimeEvents(events, runId).unresolvedActionId).toBeDefined();
    await rm(created.directory, { recursive: true, force: true });
  });

  it("does not create an observation Event when AssetStore.put fails", async () => {
    const provider = new ScriptedProvider([{ type: "finish", summary: "not reached" }]);
    const computer = new FakeComputer();
    const assetStore: AssetStore = {
      put: async () => {
        throw new Error("injected asset failure");
      },
    };
    const created = await makeController(provider, computer, clickRegistry(), new DefaultRuntimePolicy(), { assetStore });

    await expect(created.controller.start("asset failure")).resolves.toBe("failed");
    const events = await readRuntimeEvents(join(created.directory, "trajectory.jsonl"));
    expect(events.some((event) => event.type === "observation.created")).toBe(false);
    expect(provider.inputs).toHaveLength(0);
    await rm(created.directory, { recursive: true, force: true });
  });

  it("closes Action and ToolCall before failing on a post-action observation", async () => {
    class PostActionObserveFailComputer extends FakeComputer {
      private observationCalls = 0;

      public override async observe(session: ComputerSession, observationId: ObservationId, signal: AbortSignal) {
        this.observationCalls += 1;
        if (this.observationCalls === 2) {
          throw new Error("injected post-action observation failure");
        }
        return super.observe(session, observationId, signal);
      }
    }

    const computer = new PostActionObserveFailComputer();
    const created = await makeController(
      new ScriptedProvider([{ type: "tool_calls", calls: [clickCall("call-post-observe-failure")] }]),
      computer,
    );

    await expect(created.controller.start("fail after the click is applied")).resolves.toBe("failed");
    const events = await readRuntimeEvents(join(created.directory, "trajectory.jsonl"));
    const actionTerminalIndex = events.findIndex((event) => event.type === "action.execution.completed");
    const toolTerminalIndex = events.findIndex((event) => event.type === "tool.call.completed");
    const postObserveErrorIndex = events.findIndex((event) => event.type === "runtime.error" && event.message.includes("post-action observation"));
    expect(actionTerminalIndex).toBeGreaterThan(-1);
    expect(toolTerminalIndex).toBeGreaterThan(actionTerminalIndex);
    expect(postObserveErrorIndex).toBeGreaterThan(toolTerminalIndex);
    expect(events.at(-1)).toMatchObject({ type: "run.finished", outcome: "failed" });
    expect(computer.calls.filter((call) => call.startsWith("execute:")).length).toBe(1);
    expect(events.filter((event) => event.type === "action.execution.completed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "tool.call.completed")).toHaveLength(1);
    await rm(created.directory, { recursive: true, force: true });
  });

  it("records Provider failure without attempting another ModelTurn", async () => {
    const provider: ProviderAdapter = {
      id: "failing-provider",
      generate: async () => {
        throw new Error("injected provider failure");
      },
    };
    const created = await makeController(provider);

    await expect(created.controller.start("provider failure")).resolves.toBe("failed");
    expect(created.controller.getEvents().filter((event) => event.type === "model.request.started")).toHaveLength(1);
    expect(created.controller.getEvents().some((event) => event.type === "model.request.failed")).toBe(true);
    await rm(created.directory, { recursive: true, force: true });
  });

  it("separates open/observe/close failures from GUI action execution", async () => {
    class OpenFailComputer extends FakeComputer {
      public override async open(_options: ComputerOpenOptions, _signal: AbortSignal): Promise<ComputerSession> {
        throw new Error("injected open failure");
      }
    }
    class ObserveFailComputer extends FakeComputer {
      public override async observe(_session: ComputerSession, _id: ObservationId, _signal: AbortSignal): Promise<never> {
        throw new Error("injected observe failure");
      }
    }
    class CloseFailComputer extends FakeComputer {
      public override async close(_session: ComputerSession): Promise<void> {
        throw new Error("injected close failure");
      }
    }

    const openRun = await makeController(new ScriptedProvider([{ type: "finish", summary: "no" }]), new OpenFailComputer());
    await expect(openRun.controller.start("open failure")).resolves.toBe("failed");
    const openEvents = await readRuntimeEvents(join(openRun.directory, "trajectory.jsonl"));
    expect(openEvents.some((event) => event.type === "observation.created")).toBe(false);

    const observeRun = await makeController(new ScriptedProvider([{ type: "finish", summary: "no" }]), new ObserveFailComputer());
    await expect(observeRun.controller.start("observe failure")).resolves.toBe("failed");
    const observeEvents = await readRuntimeEvents(join(observeRun.directory, "trajectory.jsonl"));
    expect(observeEvents.some((event) => event.type === "observation.created")).toBe(false);

    const closeRun = await makeController(new ScriptedProvider([{ type: "finish", summary: "done" }]), new CloseFailComputer());
    const closeDiagnostics: Array<{ operation: string; message: string }> = [];
    const closeRunWithDiagnostics = await makeController(
      new ScriptedProvider([{ type: "finish", summary: "done" }]),
      new CloseFailComputer(),
      clickRegistry(),
      new DefaultRuntimePolicy(),
      { onCleanupError: (diagnostic) => closeDiagnostics.push(diagnostic) },
    );
    await expect(closeRun.controller.start("close failure")).resolves.toBe("succeeded");
    await expect(closeRunWithDiagnostics.controller.start("close failure with diagnostics")).resolves.toBe("succeeded");
    expect(closeDiagnostics).toEqual([{ operation: "computer.close", message: "injected close failure" }]);

    const writerDiagnostics: Array<{ operation: string; message: string }> = [];
    const writerRun = await makeController(
      new ScriptedProvider([{ type: "finish", summary: "done" }]),
      new FakeComputer(),
      clickRegistry(),
      new DefaultRuntimePolicy(),
      {
        eventWriter: (path) => new CleanupFailingWriter(jsonlWriter(path)),
        onCleanupError: (diagnostic) => writerDiagnostics.push(diagnostic),
      },
    );
    await expect(writerRun.controller.start("writer cleanup failure")).resolves.toBe("succeeded");
    expect(writerDiagnostics).toEqual([
      { operation: "event_writer.flush", message: "injected flush failure" },
      { operation: "event_writer.close", message: "injected close failure" },
    ]);

    await rm(openRun.directory, { recursive: true, force: true });
    await rm(observeRun.directory, { recursive: true, force: true });
    await rm(closeRun.directory, { recursive: true, force: true });
    await rm(closeRunWithDiagnostics.directory, { recursive: true, force: true });
    await rm(writerRun.directory, { recursive: true, force: true });
  });

  it("accepts a Driver-proven cancelled receipt without classifying it as unknown", async () => {
    const computer = new FakeComputer();
    computer.execute = async (_session, action) => ({
      actionId: action.actionId,
      status: "cancelled" as const,
      driverCode: "NOT_STARTED",
      message: "driver proved the click was not sent",
    });
    const created = await makeController(new ScriptedProvider([
      { type: "tool_calls", calls: [clickCall("call-cancelled-receipt")] },
      { type: "finish", summary: "done" },
    ]), computer);

    await expect(created.controller.start("cancelled receipt")).resolves.toBe("succeeded");
    const events = await readRuntimeEvents(join(created.directory, "trajectory.jsonl"));
    expect(events.some((event) => event.type === "action.execution.failed" && event.receipt.status === "cancelled")).toBe(true);
    expect(events.some((event) => event.type === "run.finished" && event.outcome === "outcome_unknown")).toBe(false);
    await rm(created.directory, { recursive: true, force: true });
  });
});
