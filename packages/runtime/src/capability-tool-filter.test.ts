import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { ActionIntent, ComputerSessionId, ObservationId, ObservationCapture, Viewport } from "@computer-harness/protocol";
import { FileAssetStore, JsonlRunEventWriter } from "@computer-harness/trajectory";
import { DefaultRuntimePolicy, RunController, createDefaultToolRegistry, type Computer, type ComputerOpenOptions, type ComputerSession, type ContextCompiler, type ModelInput, type ProviderAdapter } from "./index.js";

const viewport: Viewport = { width: 1, height: 1, coordinateSpace: "physical" };

class KeyboardlessComputer implements Computer {
  public readonly session: ComputerSession = {
    id: "keyboardless-window" as ComputerSessionId,
    backend: "fixture-window",
    viewport,
    capabilities: { screenshot: true, pointer: true, keyboard: false, accessibility: false },
    openedAt: "2026-09-18T00:00:00.000Z",
  };

  private observationCount = 0;

  public async open(_options: ComputerOpenOptions, _signal: AbortSignal): Promise<ComputerSession> { return this.session; }
  public async observe(_session: ComputerSession, _observationId: ObservationId, _signal: AbortSignal): Promise<ObservationCapture> {
    this.observationCount += 1;
    const observedViewport = this.observationCount < 2 ? viewport : { width: 2, height: 2, coordinateSpace: "physical" as const };
    return { capturedAt: "2026-09-18T00:00:00.000Z", viewport: observedViewport, screenshot: { mediaType: "image/png", data: new Uint8Array([1]) } };
  }
  public async execute(_session: ComputerSession, action: ActionIntent, _signal: AbortSignal): Promise<import("@computer-harness/protocol").ActionReceipt> {
    return { actionId: action.actionId, status: "completed" };
  }
  public async close(_session: ComputerSession): Promise<void> {}
}

class CapturingContextCompiler implements ContextCompiler {
  public toolNames: string[] = [];
  public viewports: Viewport[] = [];
  public constructor(private readonly registry: ReturnType<typeof createDefaultToolRegistry>) {}

  public async compile(input: Parameters<ContextCompiler["compile"]>[0], _signal: AbortSignal): Promise<ModelInput> {
    this.toolNames = this.registry.modelTools("main", {
      ...(input.enabledToolNames === undefined ? {} : { enabledToolNames: input.enabledToolNames }),
    }).map((tool) => tool.name);
    if (input.latestObservation !== undefined) this.viewports.push(input.latestObservation.viewport);
    return { system: "fixture", messages: [], tools: this.registry.modelTools("main", { enabledToolNames: input.enabledToolNames }) };
  }
}

describe("RunController capability tool filtering", () => {
  it("removes keyboard tools from the Provider input after a window session opens without keyboard capability", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-capability-tools-"));
    const registry = createDefaultToolRegistry();
    const compiler = new CapturingContextCompiler(registry);
    const controller = new RunController({
      runId: "capability-filter-run" as never,
      provider: { id: "fixture", async generate() { return { type: "finish", summary: "done" }; } } satisfies ProviderAdapter,
      computer: new KeyboardlessComputer(),
      contextCompiler: compiler,
      toolRegistry: registry,
      policy: new DefaultRuntimePolicy(),
      eventWriter: new JsonlRunEventWriter(join(directory, "trajectory.jsonl"), "capability-filter-run" as never),
      assetStore: new FileAssetStore(join(directory, "assets")),
      features: { planning: "off", memory: "off", batching: "off" },
    });
    try {
      await expect(controller.start("window fixture")).resolves.toBe("succeeded");
      expect(compiler.toolNames).toContain("click");
      expect(compiler.toolNames).not.toContain("type");
      expect(compiler.toolNames).not.toContain("keypress");
      expect(compiler.toolNames).not.toContain("hotkey");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("passes a fresh resized Observation viewport to the next Context/Provider compilation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-capability-viewport-"));
    const registry = createDefaultToolRegistry();
    const compiler = new CapturingContextCompiler(registry);
    let requests = 0;
    const controller = new RunController({
      runId: "capability-viewport-run" as never,
      provider: {
        id: "fixture",
        async generate() {
          requests += 1;
          return requests === 1
            ? { type: "tool_calls", calls: [{ id: "resize-click" as never, name: "click", arguments: { x: 0, y: 0 } }] }
            : { type: "finish", summary: "done" };
        },
      } satisfies ProviderAdapter,
      computer: new KeyboardlessComputer(),
      contextCompiler: compiler,
      toolRegistry: registry,
      policy: new DefaultRuntimePolicy(),
      eventWriter: new JsonlRunEventWriter(join(directory, "trajectory.jsonl"), "capability-viewport-run" as never),
      assetStore: new FileAssetStore(join(directory, "assets")),
      features: { planning: "off", memory: "off", batching: "off" },
    });
    try {
      await expect(controller.start("resizing fixture")).resolves.toBe("succeeded");
      expect(compiler.viewports).toEqual([
        { width: 1, height: 1, coordinateSpace: "physical" },
        { width: 2, height: 2, coordinateSpace: "physical" },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
