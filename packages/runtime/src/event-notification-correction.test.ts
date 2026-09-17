import { describe, expect, it } from "vitest";
import type {
  ActionIntent,
  AssetId,
  AssetRef,
  ComputerSessionId,
  EventId,
  ModelTurn,
  ObservationCapture,
  ObservationId,
  RunId,
  RuntimeEvent,
  RuntimeEventDraft,
  ToolCall,
  ToolCallId,
  Viewport,
} from "@computer-harness/protocol";
import type { AssetStore, RunEventWriter } from "@computer-harness/trajectory";
import {
  DefaultRuntimePolicy,
  RunController,
  ToolRegistry,
  type ActionPolicy,
  type Computer,
  type ComputerOpenOptions,
  type ComputerSession,
  type ContextCompiler,
  type IdFactory,
  type ModelInput,
  type ProviderAdapter,
} from "./index.js";

const runId = "event-notification-run" as RunId;
const viewport: Viewport = { width: 800, height: 600, coordinateSpace: "physical" };

class MemoryWriter implements RunEventWriter {
  public readonly events: RuntimeEvent[] = [];

  public async append(draft: RuntimeEventDraft): Promise<RuntimeEvent> {
    const event = { ...draft, eventId: draft.eventId ?? (`event-${this.events.length}` as EventId), sequence: this.events.length } as RuntimeEvent;
    this.events.push(event);
    return event;
  }

  public async flush(): Promise<void> {}
  public async close(): Promise<void> {}
}

class MemoryAssets implements AssetStore {
  public async put(input: { assetId: AssetId; relativePath: string; mediaType: string; data: Uint8Array }): Promise<AssetRef> {
    return { assetId: input.assetId, relativePath: input.relativePath, mediaType: input.mediaType, byteLength: input.data.byteLength };
  }
}

class FakeComputer implements Computer {
  public executeCount = 0;
  private readonly session: ComputerSession = { id: "event-session" as ComputerSessionId, backend: "fake", viewport, capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false }, openedAt: "2026-09-17T00:00:00.000Z" };

  public async open(_options: ComputerOpenOptions, _signal: AbortSignal): Promise<ComputerSession> { return this.session; }
  public async observe(_session: ComputerSession, _observationId: ObservationId, _signal: AbortSignal): Promise<ObservationCapture> {
    return { capturedAt: "2026-09-17T00:00:00.000Z", viewport, screenshot: { mediaType: "image/png", data: new Uint8Array([1]) } };
  }
  public async execute(_session: ComputerSession, _action: ActionIntent, _signal: AbortSignal): Promise<import("@computer-harness/protocol").ActionReceipt> {
    this.executeCount += 1;
    return { actionId: _action.actionId, status: "completed" };
  }
  public async close(_session: ComputerSession): Promise<void> {}
}

class FixedIds implements IdFactory {
  private counter = 0;
  public eventId(): EventId { return `event-${this.counter++}` as EventId; }
  public observationId(): ObservationId { return `observation-${this.counter++}` as ObservationId; }
  public assetId(): AssetId { return `asset-${this.counter++}` as AssetId; }
  public actionId(): import("@computer-harness/protocol").ActionId { return `action-${this.counter++}` as import("@computer-harness/protocol").ActionId; }
}

function clickRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "click",
    description: "Click a point.",
    category: "computer",
    inputSchema: { type: "object" },
    validate: () => undefined,
    toAction: (args) => {
      const point = args as { x: number; y: number };
      return { kind: "click", point: { x: point.x, y: point.y } };
    },
  });
  return registry;
}

class FixtureContext implements ContextCompiler {
  public constructor(private readonly registry: ToolRegistry) {}
  public async compile(_input: Parameters<ContextCompiler["compile"]>[0], _signal: AbortSignal): Promise<ModelInput> {
    return { system: "fixture", messages: [], tools: this.registry.modelTools() };
  }
}

function controllerFixture(
  provider: ProviderAdapter,
  computer: FakeComputer,
  actionPolicy?: ActionPolicy,
  onEventCommitted?: (event: RuntimeEvent) => void,
): { controller: RunController; writer: MemoryWriter } {
  const writer = new MemoryWriter();
  const registry = clickRegistry();
  const controller = new RunController({
    runId,
    provider,
    computer,
    contextCompiler: new FixtureContext(registry),
    toolRegistry: registry,
    policy: new DefaultRuntimePolicy(4, 4),
    ...(actionPolicy === undefined ? {} : { actionPolicy }),
    eventWriter: writer,
    assetStore: new MemoryAssets(),
    idFactory: new FixedIds(),
    clock: { now: () => "2026-09-17T00:00:00.000Z" },
    ...(onEventCommitted === undefined ? {} : { onEventCommitted }),
  });
  return { controller, writer };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let count = 0; count < 500; count += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("fixture condition was not reached");
}

describe("committed event boundary and approval correction", () => {
  it("isolates a throwing committed-event observer from the Controller result", async () => {
    const computer = new FakeComputer();
    const fixture = controllerFixture({ id: "finish-provider", async generate() { return { type: "finish", summary: "done" }; } }, computer, undefined, () => { throw new Error("listener failed"); });
    await expect(fixture.controller.start("finish normally")).resolves.toBe("succeeded");
    expect(fixture.writer.events.at(-1)).toMatchObject({ type: "run.finished", outcome: "succeeded" });
    expect(computer.executeCount).toBe(0);
  });

  it("revokes a pending approval before accepting a correction and never executes the stale action", async () => {
    const computer = new FakeComputer();
    const call: ToolCall = { id: "approval-call" as ToolCallId, name: "click", arguments: { x: 10, y: 20 } };
    const turns: ModelTurn[] = [
      { type: "tool_calls", calls: [call] },
      { type: "finish", summary: "corrected" },
    ];
    const actionPolicy: ActionPolicy = { async evaluate() { return { decision: "require_approval", categories: ["external_commitment"], reasonCode: "fixture_approval", reason: "fixture approval", path: "local", policyVersion: "fixture", modelRequestCount: 0 }; } };
    const fixture = controllerFixture({ id: "approval-provider", async generate(_input, { signal }) { signal.throwIfAborted(); const turn = turns.shift(); if (turn === undefined) throw new Error("fixture provider exhausted"); return turn; } }, computer, actionPolicy);
    const running = fixture.controller.start("perform the controlled action");
    await waitUntil(() => fixture.controller.getSnapshot().status === "waiting_approval");
    const requestId = fixture.controller.getSnapshot().pendingApproval?.requestId;
    await fixture.controller.submitUserInput("Do not perform it; finish safely");
    await expect(running).resolves.toBe("succeeded");
    expect(computer.executeCount).toBe(0);
    expect(fixture.writer.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "approval.resolved", requestId, approved: false }),
      expect.objectContaining({ type: "tool.call.rejected", callId: call.id, reason: expect.stringContaining("superseded") }),
    ]));
  });

  it("does not dispatch after approve and correction are queued in the same Controller turn", async () => {
    const computer = new FakeComputer();
    const call: ToolCall = { id: "approve-then-correct" as ToolCallId, name: "click", arguments: { x: 10, y: 20 } };
    const turns: ModelTurn[] = [{ type: "tool_calls", calls: [call] }, { type: "finish", summary: "safe correction" }];
    const actionPolicy: ActionPolicy = { async evaluate() { return { decision: "require_approval", categories: ["external_commitment"], reasonCode: "fixture_approval", reason: "fixture approval", path: "local", policyVersion: "fixture", modelRequestCount: 0 }; } };
    const fixture = controllerFixture({ id: "approve-correction-provider", async generate(_input, { signal }) { signal.throwIfAborted(); const turn = turns.shift(); if (turn === undefined) throw new Error("fixture provider exhausted"); return turn; } }, computer, actionPolicy);
    const running = fixture.controller.start("approve then correct");
    await waitUntil(() => fixture.controller.getSnapshot().status === "waiting_approval");
    const requestId = fixture.controller.getSnapshot().pendingApproval?.requestId;
    const approval = fixture.controller.resolveApproval(requestId ?? "", true);
    const correction = fixture.controller.submitUserInput("Do not execute the approved action");
    await expect(approval).resolves.toBeUndefined();
    await expect(correction).resolves.toBeUndefined();
    await expect(running).resolves.toBe("succeeded");
    expect(computer.executeCount).toBe(0);
    expect(fixture.writer.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "approval.resolved", requestId, approved: true }),
      expect.objectContaining({ type: "tool.call.rejected", callId: call.id, reason: expect.stringContaining("after approval") }),
    ]));
  });

  it("keeps Abort ahead of an approved-but-not-dispatched action", async () => {
    const computer = new FakeComputer();
    const call: ToolCall = { id: "approve-then-abort" as ToolCallId, name: "click", arguments: { x: 10, y: 20 } };
    const actionPolicy: ActionPolicy = { async evaluate() { return { decision: "require_approval", categories: ["external_commitment"], reasonCode: "fixture_approval", reason: "fixture approval", path: "local", policyVersion: "fixture", modelRequestCount: 0 }; } };
    const fixture = controllerFixture({ id: "approve-abort-provider", async generate(_input, { signal }) { signal.throwIfAborted(); return { type: "tool_calls", calls: [call] }; } }, computer, actionPolicy);
    const running = fixture.controller.start("approve then abort");
    await waitUntil(() => fixture.controller.getSnapshot().status === "waiting_approval");
    const requestId = fixture.controller.getSnapshot().pendingApproval?.requestId;
    const approval = fixture.controller.resolveApproval(requestId ?? "", true);
    fixture.controller.cancel("abort wins before dispatch");
    await expect(approval).resolves.toBeUndefined();
    await expect(running).resolves.toBe("cancelled");
    expect(computer.executeCount).toBe(0);
    expect(fixture.writer.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "approval.resolved", requestId, approved: true }),
    ]));
  });
});
