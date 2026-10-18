import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  ActionIntent,
  AssetId,
  ComputerSessionId,
  EventId,
  ModelTurn,
  ObservationId,
  RunId,
  SurfaceId,
} from "@computer-harness/protocol";
import { FileAssetStore, JsonlRunEventWriter } from "@computer-harness/trajectory";
import {
  DefaultRuntimePolicy,
  RunController,
  ToolRegistry,
  type Computer,
  type ComputerOpenOptions,
  type ComputerSession,
} from "./index.js";
import type { ContextCompileInput, ContextCompiler, IdFactory, ModelInput, ModelMessage, ProviderAdapter } from "./contracts.js";

const runId = "monitor-changed-handoff" as RunId;
const sessionId = "monitor-changed-session" as ComputerSessionId;
const viewport = { width: 800, height: 600, coordinateSpace: "physical" as const };

class MonitorIds implements IdFactory {
  private nextValue = 0;
  private next(prefix: string): string { return `${prefix}-${this.nextValue++}`; }
  public eventId(): EventId { return this.next("event") as EventId; }
  public observationId(): ObservationId { return this.next("observation") as ObservationId; }
  public assetId(): AssetId { return this.next("asset") as AssetId; }
  public actionId(): import("@computer-harness/protocol").ActionId { return this.next("action") as import("@computer-harness/protocol").ActionId; }
}

class ChangingComputer implements Computer {
  private observationCount = 0;
  public readonly session: ComputerSession = {
    id: sessionId,
    backend: "fake",
    viewport,
    capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false },
    openedAt: "2026-10-18T00:00:00.000Z",
  };

  public async open(_options: ComputerOpenOptions, signal: AbortSignal): Promise<ComputerSession> {
    signal.throwIfAborted();
    return this.session;
  }

  public async observe(_session: ComputerSession, _observationId: ObservationId, signal: AbortSignal) {
    signal.throwIfAborted();
    this.observationCount += 1;
    return {
      capturedAt: `2026-10-18T00:00:${String(this.observationCount).padStart(2, "0")}.000Z`,
      viewport,
      surfaceRef: { surfaceId: "monitor-changed-desktop" as SurfaceId, generation: 1, kind: "desktop" as const },
      screenshot: { mediaType: "image/png" as const, data: Uint8Array.of(this.observationCount) },
    };
  }

  public async execute(_session: ComputerSession, action: ActionIntent, signal: AbortSignal) {
    signal.throwIfAborted();
    return { actionId: action.actionId, status: "completed" as const };
  }

  public async close(_session: ComputerSession): Promise<void> {}
}

class RepeatingTargetProvider implements ProviderAdapter {
  public readonly id = "monitor-guidance-test-provider";
  public readonly inputs: ModelInput[] = [];
  private actionCount = 0;

  public async generate(input: ModelInput, options: { signal: AbortSignal }): Promise<ModelTurn> {
    options.signal.throwIfAborted();
    this.inputs.push(input);
    if (this.actionCount >= 6) return { type: "finish", summary: "Done." };
    this.actionCount += 1;
    return {
      type: "tool_calls",
      calls: [{
        id: `repeat-call-${this.actionCount}` as import("@computer-harness/protocol").ToolCallId,
        name: "click",
        arguments: { x: 100 + this.actionCount * 7, y: 180 },
        declaredEffect: {
          effects: ["navigate"],
          target: "Official site search field",
          summary: `Reopen the search control, attempt ${this.actionCount}`,
        },
      }],
    };
  }
}

class MonitorContextCompiler implements ContextCompiler {
  public readonly inputs: ContextCompileInput[] = [];
  public constructor(private readonly registry: ToolRegistry) {}

  public async compile(input: ContextCompileInput, signal: AbortSignal): Promise<ModelInput> {
    signal.throwIfAborted();
    this.inputs.push(structuredClone(input));
    const messages: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: input.goal }] }];
    if (input.latestObservation !== undefined) {
      messages.push({ role: "user", content: [{ type: "image", asset: input.latestObservation.screenshot, viewport: input.latestObservation.viewport }] });
    }
    if (input.monitorGuidance !== undefined) {
      messages.push({ role: "user", content: [{ type: "text", text: `Low-confidence Monitor note; verify the current state before acting: ${input.monitorGuidance.text}` }] });
    }
    return { system: "Monitor integration fixture.", messages, tools: this.registry.modelTools("main") };
  }
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
    validate(args) {
      if (typeof args !== "object" || args === null || Array.isArray(args)
        || typeof (args as { x?: unknown }).x !== "number" || typeof (args as { y?: unknown }).y !== "number") {
        throw new Error("click requires numeric coordinates");
      }
    },
    toAction(args) {
      const point = args as { x: number; y: number };
      return { kind: "click", point: { x: point.x, y: point.y } };
    },
  });
  return registry;
}

describe("RunController changed-screen Monitor delivery", () => {
  it("reprojects a bounded target hint on the newest image after a changed transition", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-monitor-guidance-"));
    const registry = clickRegistry();
    const provider = new RepeatingTargetProvider();
    const compiler = new MonitorContextCompiler(registry);
    const ids = new MonitorIds();
    const controller = new RunController({
      runId,
      provider,
      computer: new ChangingComputer(),
      contextCompiler: compiler,
      toolRegistry: registry,
      policy: new DefaultRuntimePolicy(),
      eventWriter: new JsonlRunEventWriter(join(directory, "trajectory.jsonl"), runId, { next: () => ids.eventId() }),
      assetStore: new FileAssetStore(join(directory, "assets")),
      idFactory: ids,
      clock: { now: () => "2026-10-18T00:00:00.000Z" },
      features: { planning: "off", memory: "off", batching: "off", riskGuard: "off", monitor: "guidance" },
    });

    try {
      await expect(controller.start("Inspect the current site and report what is visible.")).resolves.toBe("succeeded");
      const changedTransitions = controller.getEvents().filter((event) => event.type === "monitor.transition" && event.transition === "changed");
      expect(changedTransitions.length).toBeGreaterThanOrEqual(4);
      const guidanceInputs = provider.inputs.filter((input) => input.messages.some((message) => message.content.some((block) =>
        block.type === "text" && block.text.includes("Model-declared target"),
      )));
      expect(guidanceInputs.length).toBeGreaterThan(0);
      const compiledGuidance = compiler.inputs.find((input) => input.monitorGuidance?.text.includes("Model-declared target"))?.monitorGuidance;
      expect(compiledGuidance?.text.length).toBeLessThanOrEqual(240);
      const guidance = guidanceInputs[0]?.messages.flatMap((message) => message.content).find((block) =>
        block.type === "text" && block.text.includes("Model-declared target"),
      );
      expect(guidance?.type).toBe("text");
      if (guidance?.type === "text") {
        expect(guidance.text).toContain("Official site search field");
        expect(guidance.text).toContain("Recheck newest image");
        expect(guidance.text.length).toBeLessThanOrEqual(320);
      }
      expect(controller.getSnapshot().status).toBe("finished");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
