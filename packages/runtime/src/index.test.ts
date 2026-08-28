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
  type RuntimePolicy,
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
  computer?: FakeComputer,
  registry = clickRegistry(),
  policy: RuntimePolicy = new DefaultRuntimePolicy(),
  overrides: {
    eventWriter?: (path: string) => RunEventWriter;
    assetStore?: AssetStore;
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
    contextCompiler: new DefaultContextCompiler(registry),
    toolRegistry: registry,
    policy,
    eventWriter: writer,
    assetStore: overrides.assetStore ?? new FileAssetStore(join(directory, "assets")),
    idFactory: new TestIds(),
    clock: { now: () => "2026-08-28T00:00:00.000Z" },
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
      { type: "tool_calls", calls: [clickCall("call-valid"), invalidClickCall("call-invalid")] },
      { type: "finish", summary: "done" },
    ]);
    const { controller, computer, directory } = await makeController(provider);

    await expect(controller.start("reject invalid arguments")).resolves.toBe("succeeded");
    const events = await readRuntimeEvents(join(directory, "trajectory.jsonl"));
    expect(computer.calls.filter((call) => call.startsWith("execute:")).length).toBe(0);
    expect(events.filter((event) => event.type === "tool.call.rejected")).toHaveLength(2);
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
    expect(controller.getEvents().some((event) => event.type === "user.input.received")).toBe(true);
    expect(reduceRuntimeEvents(await readRuntimeEvents(join(created.directory, "trajectory.jsonl")), runId)).toEqual(controller.getSnapshot());
    expect(provider.inputs[1]?.messages.some((message) =>
      message.content.some((content) => content.type === "text" && content.text.includes("Do not click")),
    )).toBe(true);
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
    await expect(closeRun.controller.start("close failure")).resolves.toBe("succeeded");

    await rm(openRun.directory, { recursive: true, force: true });
    await rm(observeRun.directory, { recursive: true, force: true });
    await rm(closeRun.directory, { recursive: true, force: true });
  });

  it("accepts a Driver-proven cancelled receipt without classifying it as unknown", async () => {
    const computer = new FakeComputer();
    computer.execute = async (_session, action) => ({
      actionId: action.actionId,
      status: "cancelled" as const,
      startedAt: "2026-08-28T00:00:10.000Z",
      endedAt: "2026-08-28T00:00:10.010Z",
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
