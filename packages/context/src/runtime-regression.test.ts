import { describe, expect, it } from "vitest";
import type { ActionIntent, AssetId, ComputerSessionId, EventId, ModelTurn, ObservationId, RunId, RuntimeEvent, RuntimeEventDraft, SurfaceId, SurfaceRef, ToolCallId, Viewport } from "@computer-harness/protocol";
import { DefaultRuntimePolicy, RunController, type Computer, type ComputerOpenOptions, type ComputerSession, type ModelInput, type ProviderAdapter } from "@computer-harness/runtime";
import { createDefaultComputerTools } from "@computer-harness/runtime";
import { DefaultContextCompiler } from "./index.js";

const runId = "context-runtime-regression" as RunId;
const sessionId = "context-runtime-computer" as ComputerSessionId;
const viewport: Viewport = { width: 800, height: 600, coordinateSpace: "physical" };
const surfaceRef: SurfaceRef = { surfaceId: "context-runtime-desktop" as SurfaceId, generation: 1, kind: "desktop" };

class FakeComputer implements Computer {
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
      surfaceRef,
      screenshot: { mediaType: "image/png" as const, data: new Uint8Array([this.observationCount]) },
    };
  }

  public async execute(_session: ComputerSession, _action: ActionIntent, _signal: AbortSignal): Promise<import("@computer-harness/protocol").ActionReceipt> {
    throw new Error("context budget regression must not execute GUI actions");
  }

  public async close(_session: ComputerSession): Promise<void> {}
}

class CountingProvider implements ProviderAdapter {
  public readonly id = "context-budget-regression-provider";
  public requests = 0;

  public async generate(_input: ModelInput, _options: { signal: AbortSignal }): Promise<ModelTurn> {
    this.requests += 1;
    throw new Error("provider must not be called when Context fixed budget overflows");
  }
}

class MemoryEventWriter {
  public readonly events: RuntimeEvent[] = [];

  public async append(draft: RuntimeEventDraft): Promise<RuntimeEvent> {
    const event = { ...draft, eventId: draft.eventId ?? `event-${this.events.length}` as EventId, sequence: this.events.length, occurredAt: draft.occurredAt ?? "2026-09-17T00:00:00.000Z" } as RuntimeEvent;
    this.events.push(event);
    return event;
  }

  public async flush(): Promise<void> {}
  public async close(): Promise<void> {}
}

const assets = {
  async put(input: { assetId: AssetId; relativePath: string; mediaType: string; data: Uint8Array }) {
    return { assetId: input.assetId as AssetId, relativePath: input.relativePath, mediaType: input.mediaType, byteLength: input.data.length };
  },
};

describe("Context budget through RunController", () => {
  it("does not request a Provider when the fixed Context block is over budget with no history", async () => {
    const provider = new CountingProvider();
    const writer = new MemoryEventWriter();
    const controller = new RunController({
      runId,
      provider,
      computer: new FakeComputer(),
      contextCompiler: new DefaultContextCompiler(createDefaultComputerTools(), { maxInputTokens: 100 }),
      toolRegistry: createDefaultComputerTools(),
      policy: new DefaultRuntimePolicy(4, 4),
      eventWriter: writer,
      assetStore: assets,
      features: { planning: "off", memory: "off", batching: "off" },
      clock: { now: () => "2026-09-17T00:00:00.000Z" },
    });

    await expect(controller.start("x".repeat(8_000))).resolves.toBe("failed");
    expect(provider.requests).toBe(0);
    expect(writer.events.some((event) => event.type === "model.request.started")).toBe(false);
  });
});

// In-memory Runtime/Context contract coverage only: no Native GUI, network
// Provider, or claim that a later real screenshot has finished painting.
describe("Zero-duration observation refresh through RunController", () => {
  async function runRefresh(failPostWaitCapture: boolean) {
    class RefreshComputer extends FakeComputer {
      public readonly actions: ActionIntent[] = [];
      public observationAttempts = 0;

      public override async observe(session: ComputerSession, observationId: ObservationId, signal: AbortSignal) {
        this.observationAttempts += 1;
        if (failPostWaitCapture && this.observationAttempts === 3) throw new Error("injected post-wait capture failure");
        return super.observe(session, observationId, signal);
      }

      public override async execute(_session: ComputerSession, action: ActionIntent, signal: AbortSignal): Promise<import("@computer-harness/protocol").ActionReceipt> {
        signal.throwIfAborted();
        this.actions.push(action);
        return { actionId: action.actionId, status: "completed" };
      }
    }

    const computer = new RefreshComputer();
    const writer = new MemoryEventWriter();
    const inputs: ModelInput[] = [];
    const savedImages = new Map<AssetId, Uint8Array>();
    const provider: ProviderAdapter = {
      id: "in-memory-observation-refresh-provider",
      async generate(input, { signal }): Promise<ModelTurn> {
        signal.throwIfAborted();
        inputs.push(structuredClone(input));
        if (inputs.length === 1) return {
          type: "tool_calls",
          calls: [{ id: "save-shortcut" as ToolCallId, name: "hotkey", arguments: { keys: ["CMD", "S"] }, declaredEffect: { effects: ["navigate"], target: "TextEdit", summary: "Open the save dialog" } }],
        };
        if (inputs.length === 2) return {
          type: "tool_calls",
          calls: [{ id: "refresh-once" as ToolCallId, name: "wait", arguments: { durationMs: 0 }, declaredEffect: { effects: ["observe"], target: "TextEdit", summary: "Read the current screen" } }],
        };
        return { type: "finish", reportedStatus: "success", summary: "The in-memory refreshed observation reached the next decision." };
      },
    };
    const tools = createDefaultComputerTools();
    const controller = new RunController({
      runId,
      provider,
      computer,
      contextCompiler: new DefaultContextCompiler(tools),
      toolRegistry: tools,
      policy: new DefaultRuntimePolicy(4, 4),
      eventWriter: writer,
      assetStore: {
        async put(input) {
          savedImages.set(input.assetId, input.data.slice());
          return assets.put(input);
        },
      },
      batching: "same-control-input-v1",
      // Exercise the production effect schema projection; this fixture does
      // not instantiate the separate LayeredGuard or a semantic reviewer.
      features: { planning: "off", memory: "off", batching: "same-control-input-v1", riskGuard: "layered", monitor: "shadow" },
    });
    const outcome = await controller.start("Open the save dialog once, then separately refresh with wait(0).");
    const observations = writer.events.filter((event) => event.type === "observation.created");
    const requests = writer.events.filter((event) => event.type === "model.request.started");
    return { computer, controller, inputs, observations, outcome, requests, savedImages, writer };
  }

  it("sends a newly persisted image to the next Provider decision after one CMD+S and one canonical wait(0)", async () => {
    const { computer, controller, inputs, observations, outcome, requests, savedImages, writer } = await runRefresh(false);
    expect(outcome).toBe("succeeded");
    expect(computer.actions.map((action) => action.kind)).toEqual(["keypress", "wait"]);
    expect(computer.actions[0]).toMatchObject({ keys: ["CMD", "S"] });
    expect(computer.actions[1]).toMatchObject({ durationMs: 0 });
    expect(computer.observationAttempts).toBe(3);
    expect(observations).toHaveLength(3);
    expect(inputs).toHaveLength(3);
    expect(requests).toHaveLength(3);
    expect(new Set(observations.map((event) => event.observation.id)).size).toBe(3);
    expect(savedImages.size).toBe(3);

    for (const [index, event] of observations.entries()) {
      const blocks = inputs[index]!.messages.flatMap((message) => message.content);
      const images = blocks.filter((block) => block.type === "image");
      expect(images).toHaveLength(1);
      expect(images[0]).toMatchObject({ asset: event.observation.screenshot });
      expect(savedImages.get(event.observation.screenshot.assetId)).toEqual(new Uint8Array([index + 1]));
      expect(blocks.some((block) => block.type === "text" && block.text.includes(`Observation ID ${event.observation.id}`))).toBe(true);
      expect(event.sequence).toBeLessThan(requests[index]!.sequence);
    }
    expect(inputs[1]!.tools.find((tool) => tool.name === "wait")?.inputSchema).toMatchObject({
      required: ["durationMs", "_harnessEffect"],
      properties: { durationMs: { minimum: 0 } },
    });
    for (const [index, callId] of ["save-shortcut", "refresh-once"].entries()) {
      const action = writer.events.find((event) => event.type === "action.execution.completed" && event.receipt.actionId === computer.actions[index]!.actionId);
      const result = writer.events.find((event) => event.type === "tool.call.completed" && event.result.callId === callId);
      expect(action).toBeDefined();
      expect(result).toBeDefined();
      expect(action!.sequence).toBeLessThan(result!.sequence);
      expect(result!.sequence).toBeLessThan(observations[index + 1]!.sequence);
    }
    expect(inputs[2]!.messages.flatMap((message) => message.content)).toContainEqual(expect.objectContaining({
      type: "tool_result", result: expect.objectContaining({ callId: "refresh-once", status: "completed" }),
    }));
    expect(controller.getSnapshot()).toMatchObject({ stepCount: 2, modelRequestCount: 3 });
  });

  it("fails after a post-wait capture error without sending the old image again or replaying CMD+S", async () => {
    const { computer, inputs, observations, outcome, requests, savedImages, writer } = await runRefresh(true);
    expect(outcome).toBe("failed");
    expect(computer.actions.map((action) => action.kind)).toEqual(["keypress", "wait"]);
    expect(computer.actions[0]).toMatchObject({ keys: ["CMD", "S"] });
    expect(computer.actions[1]).toMatchObject({ durationMs: 0 });
    expect(computer.observationAttempts).toBe(3);
    expect(observations).toHaveLength(2);
    expect(savedImages.size).toBe(2);
    expect(inputs).toHaveLength(2);
    expect(requests).toHaveLength(2);
    const waitAction = writer.events.find((event) => event.type === "action.execution.completed" && event.receipt.actionId === computer.actions[1]!.actionId);
    const waitResult = writer.events.find((event) => event.type === "tool.call.completed" && event.result.callId === "refresh-once");
    const captureError = writer.events.find((event) => event.type === "runtime.error" && event.message.includes("injected post-wait capture failure"));
    expect(waitAction).toBeDefined();
    expect(waitResult).toBeDefined();
    expect(captureError).toBeDefined();
    expect(waitAction!.sequence).toBeLessThan(waitResult!.sequence);
    expect(waitResult!.sequence).toBeLessThan(captureError!.sequence);
    expect(writer.events.filter((event) => event.sequence > waitResult!.sequence).some((event) =>
      event.type === "observation.created" || event.type === "model.request.started" || event.type === "action.execution.started",
    )).toBe(false);
    expect(writer.events.at(-1)).toMatchObject({ type: "run.finished", outcome: "failed" });
  });
});
