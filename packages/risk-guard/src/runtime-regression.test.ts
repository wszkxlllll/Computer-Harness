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
  RuntimeEvent,
  RuntimeEventDraft,
  ToolCall,
  ToolCallId,
  Viewport,
} from "@computer-harness/protocol";
import type { AssetStore, RunEventWriter } from "@computer-harness/trajectory";
import { DefaultRuntimePolicy, RunController, ToolRegistry, type Computer, type ComputerOpenOptions, type ComputerSession, type ContextCompiler, type IdFactory, type ModelInput, type ModelMessage, type ProviderAdapter } from "@computer-harness/runtime";
import { LayeredRiskGuard } from "./index.js";

const runId = "risk-guard-regression" as RunId;
const sessionId = "risk-guard-computer" as ComputerSessionId;
const viewport: Viewport = { width: 800, height: 600, coordinateSpace: "physical" };

class FakeComputer implements Computer {
  public executeCalls = 0;
  private observationCount = 0;
  public readonly session: ComputerSession = {
    id: sessionId,
    backend: "fake",
    viewport,
    capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false },
    openedAt: "2026-09-17T00:00:00.000Z",
  };

  public async open(_options: ComputerOpenOptions, signal: AbortSignal): Promise<ComputerSession> {
    signal.throwIfAborted();
    return this.session;
  }

  public async observe(_session: ComputerSession, _observationId: ObservationId, signal: AbortSignal) {
    signal.throwIfAborted();
    this.observationCount += 1;
    return {
      capturedAt: `2026-09-17T00:00:0${this.observationCount}.000Z`,
      viewport,
      screenshot: { mediaType: "image/png" as const, data: new Uint8Array([this.observationCount]) },
    };
  }

  public async execute(_session: ComputerSession, _action: ActionIntent, signal: AbortSignal) {
    signal.throwIfAborted();
    this.executeCalls += 1;
    return { actionId: _action.actionId, status: "completed" as const };
  }

  public async close(_session: ComputerSession): Promise<void> {}
}

class ScriptedProvider implements ProviderAdapter {
  public readonly id = "risk-guard-regression-provider";
  public constructor(private readonly turns: ModelTurn[]) {}

  public async generate(_input: ModelInput, options: { signal: AbortSignal }): Promise<ModelTurn> {
    options.signal.throwIfAborted();
    const turn = this.turns.shift();
    if (turn === undefined) throw new Error("risk guard regression provider exhausted");
    return turn;
  }
}

class MemoryEventWriter implements RunEventWriter {
  public readonly events: RuntimeEvent[] = [];

  public async append(draft: RuntimeEventDraft): Promise<RuntimeEvent> {
    const event = { ...draft, eventId: draft.eventId ?? `writer-event-${this.events.length}` as EventId, sequence: this.events.length, occurredAt: draft.occurredAt ?? "2026-09-17T00:00:00.000Z" } as RuntimeEvent;
    this.events.push(event);
    return event;
  }

  public async flush(): Promise<void> {}
  public async close(): Promise<void> {}
}

class RegressionContextCompiler implements ContextCompiler {
  public async compile(input: Parameters<ContextCompiler["compile"]>[0], signal: AbortSignal): Promise<ModelInput> {
    signal.throwIfAborted();
    const messages: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: input.goal }] }];
    return { system: "risk guard regression context", messages, tools: [] };
  }
}

function idFactory(): IdFactory {
  let count = 0;
  return {
    eventId: () => `event-${count++}` as EventId,
    observationId: () => `observation-${count++}` as ObservationId,
    assetId: () => `asset-${count++}` as AssetId,
    actionId: () => `action-${count++}` as ActionId,
  };
}

function assetStore(): AssetStore {
  return {
    async put(input) {
      return { assetId: input.assetId, relativePath: input.relativePath, mediaType: input.mediaType, byteLength: input.data.length };
    },
  };
}

function registry(): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register({
    name: "type",
    description: "Type text into the current control.",
    category: "computer",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
    validate: (args) => {
      if (!isRecord(args) || typeof args.text !== "string") throw new Error("type.text must be a string");
    },
    toAction: (args) => ({ kind: "type", text: (args as { text: string }).text }),
  });
  tools.register({
    name: "hotkey",
    description: "Press a keyboard shortcut.",
    category: "computer",
    inputSchema: { type: "object", properties: { keys: { type: "array", items: { type: "string" } } }, required: ["keys"], additionalProperties: false },
    validate: (args) => {
      if (!isRecord(args) || !Array.isArray(args.keys) || args.keys.some((key) => typeof key !== "string")) throw new Error("hotkey.keys must be string[]");
    },
    toAction: (args) => ({ kind: "keypress", keys: (args as { keys: string[] }).keys }),
  });
  return tools;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeCall(id: string, effect: "unknown" | "observe" | "local_edit", target: string, summary: string): ToolCall {
  return {
    id: id as ToolCallId,
    name: "type",
    arguments: { text: "password=SYNTHETIC_ONLY" },
    declaredEffect: { effects: [effect], target, summary },
  };
}

function hotkeyCall(id: string): ToolCall {
  return {
    id: id as ToolCallId,
    name: "hotkey",
    arguments: { keys: ["CTRL", "ALT", "DELETE"] },
    declaredEffect: { effects: ["unknown"], target: "System shortcut", summary: "Use the shortcut" },
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not reached during the regression window");
}

function makeController(
  call: ToolCall,
  actionPolicy: LayeredRiskGuard,
): { controller: RunController; computer: FakeComputer; writer: MemoryEventWriter } {
  const computer = new FakeComputer();
  const writer = new MemoryEventWriter();
  const controller = new RunController({
    runId,
    provider: new ScriptedProvider([{ type: "tool_calls", calls: [call] }, { type: "finish", summary: "regression complete" }]),
    computer,
    contextCompiler: new RegressionContextCompiler(),
    toolRegistry: registry(),
    policy: new DefaultRuntimePolicy(8, 8),
    actionPolicy,
    eventWriter: writer,
    assetStore: assetStore(),
    idFactory: idFactory(),
    clock: { now: () => "2026-09-17T00:00:00.000Z" },
    features: { planning: "off", memory: "off", batching: "off", riskGuard: "layered" },
  });
  return { controller, computer, writer };
}

describe("DEV-1B Risk Guard through RunController", () => {
  it.each([
    ["unknown", typeCall("protected-unknown", "unknown", "Input", "Fill the field")],
    ["contradiction", typeCall("protected-contradiction", "observe", "Input", "Observe the field")],
    ["text ambiguity", typeCall("protected-text", "local_edit", "Confirm payment", "Click Confirm payment")],
  ] as const)("does not execute protected input when %s is reviewer-allowed", async (_label, call) => {
    let reviewerCalls = 0;
    const actionPolicy = new LayeredRiskGuard({
      assessor: {
        id: "low-risk-reviewer",
        async classify() {
          reviewerCalls += 1;
          return { effects: ["local_edit"], alignment: "aligned", evidence: "Synthetic low-risk review" };
        },
      },
    });
    const created = makeController(call, actionPolicy);
    const running = created.controller.start("fill a protected field");
    await waitUntil(() => created.controller.getSnapshot().status === "waiting_approval" || created.controller.getSnapshot().status === "finished");
    expect(created.controller.getSnapshot().status).toBe("waiting_approval");
    expect(created.computer.executeCalls).toBe(0);
    expect(reviewerCalls).toBe(0);
    expect(created.writer.events.find((event) => event.type === "action.guard.evaluated")).toMatchObject({
      decision: "require_approval",
      path: "local",
      reasonCode: "protected_input",
      modelRequestCount: 0,
    });
    const requestId = created.controller.getSnapshot().pendingApproval?.requestId;
    await created.controller.resolveApproval(requestId ?? "", false);
    await expect(running).resolves.toBe("succeeded");
    expect(created.computer.executeCalls).toBe(0);
  });

  it("keeps a host deny above reviewer allow and ordinary approval", async () => {
    let reviewerCalls = 0;
    const created = makeController(hotkeyCall("host-denied-shortcut"), new LayeredRiskGuard({
      forbiddenShortcuts: ["CTRL+ALT+DELETE"],
      assessor: {
        id: "low-risk-reviewer",
        async classify() {
          reviewerCalls += 1;
          return { effects: ["local_edit"], alignment: "aligned", evidence: "Synthetic low-risk review" };
        },
      },
    }));
    await expect(created.controller.start("use the configured shortcut")).resolves.toBe("succeeded");
    expect(created.computer.executeCalls).toBe(0);
    expect(reviewerCalls).toBe(0);
    expect(created.writer.events.find((event) => event.type === "action.guard.evaluated")).toMatchObject({
      decision: "deny",
      path: "local",
      reasonCode: "forbidden_shortcut",
      modelRequestCount: 0,
    });
    expect(created.writer.events.some((event) => event.type === "approval.requested")).toBe(false);
  });
});
