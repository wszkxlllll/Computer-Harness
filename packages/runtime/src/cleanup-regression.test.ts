import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionId, ActionIntent, AssetId, ComputerSessionId, EventId, ModelTurn, ObservationId, RunId, RuntimeEvent, RuntimeEventDraft, ToolCallId, Viewport } from "@computer-harness/protocol";
import { DefaultRuntimePolicy, RunController, ToolRegistry, type CleanupDiagnostic, type Computer, type ComputerOpenOptions, type ComputerSession, type ContextCompiler, type IdFactory, type ModelInput, type ProviderAdapter } from "./index.js";
import type { AssetStore, RunEventWriter } from "@computer-harness/trajectory";

const runId = "cleanup-regression" as RunId;
const sessionId = "cleanup-computer" as ComputerSessionId;
const viewport: Viewport = { width: 800, height: 600, coordinateSpace: "physical" };

class ScriptedProvider implements ProviderAdapter {
  public readonly id = "cleanup-regression-provider";

  public constructor(private readonly turns: ModelTurn[]) {}

  public async generate(_input: ModelInput, options: { signal: AbortSignal }): Promise<ModelTurn> {
    options.signal.throwIfAborted();
    const turn = this.turns.shift();
    if (turn === undefined) throw new Error("cleanup regression provider exhausted");
    return turn;
  }
}

class FinishContextCompiler implements ContextCompiler {
  public async compile(input: Parameters<ContextCompiler["compile"]>[0], signal: AbortSignal): Promise<ModelInput> {
    signal.throwIfAborted();
    return { system: "cleanup regression context", messages: [{ role: "user", content: [{ type: "text", text: input.goal }] }], tools: [] };
  }
}

class ControlledWriter implements RunEventWriter {
  public readonly events: RuntimeEvent[] = [];
  public flushCalls = 0;
  public closeCalls = 0;

  public constructor(private readonly flushMode: "normal" | "hang" = "normal", private readonly closeMode: "normal" | "hang" = "normal") {}

  public async append(draft: RuntimeEventDraft): Promise<RuntimeEvent> {
    const event = {
      ...draft,
      eventId: draft.eventId ?? `cleanup-event-${this.events.length}` as EventId,
      sequence: this.events.length,
      occurredAt: draft.occurredAt ?? "2026-09-17T00:00:00.000Z",
    } as RuntimeEvent;
    this.events.push(event);
    return event;
  }

  public async flush(): Promise<void> {
    this.flushCalls += 1;
    if (this.flushMode === "hang") await new Promise<void>(() => undefined);
  }

  public async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeMode === "hang") await new Promise<void>(() => undefined);
  }
}

class ControlledComputer implements Computer {
  public openCalls = 0;
  public observeCalls = 0;
  public executeCalls = 0;
  public closeCalls = 0;
  public closeMode: "normal" | "hang" | "late";
  private lateCloseResolve: (() => void) | undefined;

  public readonly session: ComputerSession = {
    id: sessionId,
    backend: "cleanup-fixture",
    viewport,
    capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false },
    openedAt: "2026-09-17T00:00:00.000Z",
  };

  public constructor(closeMode: "normal" | "hang" | "late" = "normal") {
    this.closeMode = closeMode;
  }

  public async open(_options: ComputerOpenOptions, signal: AbortSignal): Promise<ComputerSession> {
    signal.throwIfAborted();
    this.openCalls += 1;
    return this.session;
  }

  public async observe(_session: ComputerSession, _observationId: ObservationId, signal: AbortSignal) {
    signal.throwIfAborted();
    this.observeCalls += 1;
    return {
      capturedAt: "2026-09-17T00:00:00.000Z",
      viewport,
      screenshot: { mediaType: "image/png" as const, data: new Uint8Array([1]) },
    };
  }

  public async execute(_session: ComputerSession, action: ActionIntent, signal: AbortSignal) {
    signal.throwIfAborted();
    this.executeCalls += 1;
    return { actionId: action.actionId, status: "completed" as const };
  }

  public async close(_session: ComputerSession): Promise<void> {
    this.closeCalls += 1;
    if (this.closeMode === "hang") await new Promise<void>(() => undefined);
    if (this.closeMode === "late") await new Promise<void>((resolve) => { this.lateCloseResolve = resolve; });
  }

  public finishLateClose(): void {
    const resolve = this.lateCloseResolve;
    this.lateCloseResolve = undefined;
    resolve?.();
  }
}

class UnknownSideEffectComputer extends ControlledComputer {
  public override async execute(_session: ComputerSession, action: ActionIntent, signal: AbortSignal) {
    signal.throwIfAborted();
    this.executeCalls += 1;
    throw new Error(`driver response was lost after ${action.kind}`);
  }
}

const assets: AssetStore = {
  async put(input) {
    return { assetId: input.assetId, relativePath: input.relativePath, mediaType: input.mediaType, byteLength: input.data.length };
  },
};

function idFactory(): IdFactory {
  let index = 0;
  return {
    eventId: () => `cleanup-id-${index++}` as EventId,
    observationId: () => `cleanup-observation-${index++}` as ObservationId,
    assetId: () => `cleanup-asset-${index++}` as AssetId,
    actionId: () => `cleanup-action-${index++}` as ActionId,
  };
}

function clickRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "click",
    description: "Synthetic click.",
    category: "computer",
    inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"], additionalProperties: false },
    validate: (args) => {
      if (typeof args !== "object" || args === null || Array.isArray(args) || typeof (args as { x?: unknown }).x !== "number" || typeof (args as { y?: unknown }).y !== "number") throw new Error("click requires x/y");
    },
    toAction: (args) => ({ kind: "click", point: { x: (args as { x: number }).x, y: (args as { y: number }).y } }),
  });
  return registry;
}

function makeController(
  provider: ProviderAdapter,
  computer: Computer,
  writer: RunEventWriter,
  registry = clickRegistry(),
  cleanupDeadlineMs = 25,
  onCleanupError?: (diagnostic: CleanupDiagnostic) => void,
): RunController {
  return new RunController({
    runId,
    provider,
    computer,
    contextCompiler: new FinishContextCompiler(),
    toolRegistry: registry,
    policy: new DefaultRuntimePolicy(8, 8),
    eventWriter: writer,
    assetStore: assets,
    idFactory: idFactory(),
    clock: { now: () => "2026-09-17T00:00:00.000Z" },
    cleanupDeadlineMs,
    ...(onCleanupError === undefined ? {} : { onCleanupError }),
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RunController cleanup deadlines", () => {
  it("completes the normal cleanup path without diagnostics", async () => {
    const computer = new ControlledComputer();
    const writer = new ControlledWriter();
    const controller = makeController(new ScriptedProvider([{ type: "finish", summary: "done" }]), computer, writer);

    await expect(controller.start("normal cleanup")).resolves.toBe("succeeded");
    expect(computer.closeCalls).toBe(1);
    expect(writer.flushCalls).toBe(1);
    expect(writer.closeCalls).toBe(1);
  });

  it("bounds a hanging flush and preserves a session that was never safely closed", async () => {
    vi.useFakeTimers();
    const computer = new ControlledComputer();
    const writer = new ControlledWriter("hang");
    const diagnostics: CleanupDiagnostic[] = [];
    const controller = makeController(new ScriptedProvider([{ type: "finish", summary: "done" }]), computer, writer, clickRegistry(), 25, (diagnostic) => diagnostics.push(diagnostic));

    const outcome = controller.start("flush hangs");
    await vi.advanceTimersByTimeAsync(25);
    await expect(outcome).resolves.toBe("succeeded");
    expect(computer.closeCalls).toBe(0);
    expect(diagnostics).toEqual([
      { operation: "event_writer.flush", message: "cleanup deadline exceeded during event_writer.flush", status: "timed_out" },
      { operation: "event_writer.close", message: "cleanup deadline exceeded before event_writer.close", status: "timed_out" },
      { operation: "computer.close", message: "cleanup deadline exceeded before computer.close", status: "timed_out" },
    ]);
  });

  it("returns after a hanging Computer close, blocks same-instance reuse, and keeps the old outcome", async () => {
    vi.useFakeTimers();
    const computer = new ControlledComputer("hang");
    const diagnostics: CleanupDiagnostic[] = [];
    const controller = makeController(new ScriptedProvider([{ type: "finish", summary: "done" }]), computer, new ControlledWriter(), clickRegistry(), 25, (diagnostic) => diagnostics.push(diagnostic));
    const firstOutcome = controller.start("computer close hangs");
    await vi.advanceTimersByTimeAsync(25);
    await expect(firstOutcome).resolves.toBe("succeeded");
    expect(diagnostics).toContainEqual({ operation: "computer.close", message: "cleanup deadline exceeded during computer.close", status: "timed_out" });
    expect(controller.getSnapshot().outcome).toBe("succeeded");

    const secondComputer = computer;
    const second = makeController(new ScriptedProvider([{ type: "finish", summary: "must not open" }]), secondComputer, new ControlledWriter());
    await expect(second.start("reuse unresolved computer")).resolves.toBe("failed");
    expect(computer.openCalls).toBe(1);
  });

  it("does not let a late close completion rewrite the old terminal outcome", async () => {
    vi.useFakeTimers();
    const computer = new ControlledComputer("late");
    const controller = makeController(new ScriptedProvider([{ type: "finish", summary: "done" }]), computer, new ControlledWriter());
    const firstOutcome = controller.start("late cleanup");
    await vi.advanceTimersByTimeAsync(25);
    await expect(firstOutcome).resolves.toBe("succeeded");
    const snapshotBeforeLateCompletion = controller.getSnapshot();

    const blocked = makeController(new ScriptedProvider([{ type: "finish", summary: "blocked" }]), computer, new ControlledWriter());
    await expect(blocked.start("blocked while late close is pending")).resolves.toBe("failed");
    computer.finishLateClose();
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.getSnapshot()).toEqual(snapshotBeforeLateCompletion);

    computer.closeMode = "normal";
    const reusable = makeController(new ScriptedProvider([{ type: "finish", summary: "reusable" }]), computer, new ControlledWriter());
    await expect(reusable.start("reuse after close completed")).resolves.toBe("succeeded");
    expect(computer.openCalls).toBe(2);
  });

  it("keeps outcome_unknown when an unresolved action is followed by cleanup timeout", async () => {
    vi.useFakeTimers();
    const computer = new UnknownSideEffectComputer("hang");
    const writer = new ControlledWriter();
    const controller = makeController(new ScriptedProvider([
      { type: "tool_calls", calls: [{ id: "unknown-action-call" as ToolCallId, name: "click", arguments: { x: 10, y: 10 } }] },
    ]), computer, writer);
    const outcome = controller.start("unknown side effect");
    await vi.advanceTimersByTimeAsync(25);
    await expect(outcome).resolves.toBe("outcome_unknown");
    expect(controller.getEvents().some((event) => event.type === "run.finished" && event.outcome === "outcome_unknown")).toBe(true);
    expect(controller.getEvents().some((event) => event.type === "run.finished" && event.outcome === "cancelled")).toBe(false);
  });
});
