import { describe, expect, it } from "vitest";
import type { ActionIntent, AssetId, ComputerSessionId, EventId, ModelTurn, ObservationId, RunId, RuntimeEvent, RuntimeEventDraft, Viewport } from "@computer-harness/protocol";
import { DefaultRuntimePolicy, RunController, type Computer, type ComputerOpenOptions, type ComputerSession, type ModelInput, type ProviderAdapter } from "@computer-harness/runtime";
import { createDefaultComputerTools } from "@computer-harness/runtime";
import { DefaultContextCompiler } from "./index.js";

const runId = "context-runtime-regression" as RunId;
const sessionId = "context-runtime-computer" as ComputerSessionId;
const viewport: Viewport = { width: 800, height: 600, coordinateSpace: "physical" };

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
