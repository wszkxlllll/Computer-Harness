import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { ActionIntent, ComputerSessionId, ObservationId, ObservationCapture, SurfaceId, Viewport } from "@computer-harness/protocol";
import { FileAssetStore, JsonlRunEventWriter } from "@computer-harness/trajectory";
import { DefaultRuntimePolicy, RunController, createDefaultToolRegistry, windowSwitchTools, type Computer, type ComputerOpenOptions, type ComputerSession, type ContextCompiler, type ModelInput, type ProviderAdapter } from "./index.js";

const viewport: Viewport = { width: 1, height: 1, coordinateSpace: "physical" };
const surfaceRef = { surfaceId: "capability-filter-desktop" as SurfaceId, generation: 1, kind: "desktop" as const };

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
    return { capturedAt: "2026-09-18T00:00:00.000Z", viewport: observedViewport, surfaceRef, screenshot: { mediaType: "image/png", data: new Uint8Array([1]) } };
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
  it.each(["browser_tab", "dom"] as const)("filters raw click on %s and refreshes capabilities after switches", async (browserKind) => {
    const directory = await mkdtemp(join(tmpdir(), "harness-surface-capabilities-"));
    const registry = createDefaultToolRegistry();
    registry.registerMany(windowSwitchTools());
    const compiler = new CapturingContextCompiler(registry);
    const firstSession = new KeyboardlessComputer().session;
    let target = "native";
    let generation = 1;
    let requests = 0;
    const executed: string[] = [];
    const computer: Computer = {
      async open() { return firstSession; },
      async listWindows() { return ["native", "managed"].map((windowRef) => ({ windowRef, isCurrent: target === windowRef })); },
      async observe() {
        return { capturedAt: "2026-10-03T00:00:00Z", viewport,
          surfaceRef: { surfaceId: target as SurfaceId, generation, kind: target === "managed" ? browserKind : "native_window", ...(target === "managed" ? { parentSurfaceId: "browser-root" as SurfaceId } : {}) },
          screenshot: { mediaType: "image/png", data: new Uint8Array([target === "managed" ? 2 : 1]) } };
      },
      async execute(_session, action) {
        executed.push(action.kind);
        if (action.kind === "switch_window") {
          target = action.windowRef;
          generation += 1;
          return { actionId: action.actionId, status: "completed", sessionAfter: { ...firstSession, capabilities: { ...firstSession.capabilities, keyboard: true } } };
        }
        return { actionId: action.actionId, status: "completed" };
      },
      async close() {},
    };
    const controller = new RunController({
      runId: "surface-capabilities" as never, computer, contextCompiler: compiler, toolRegistry: registry,
      windowSwitch: "opened-windows-v1", policy: new DefaultRuntimePolicy(),
      eventWriter: new JsonlRunEventWriter(join(directory, "trajectory.jsonl"), "surface-capabilities" as never),
      assetStore: new FileAssetStore(join(directory, "assets")), features: { planning: "off", memory: "off", batching: "off" },
      provider: { id: "surface-fixture", async generate(input) {
        requests += 1;
        const names = input.tools.map((tool) => tool.name);
        if (requests <= 2 || requests >= 6) expect(names).toContain("click");
        else expect(names).not.toContain("click");
        if (requests <= 2) expect(names).not.toContain("type");
        else expect(names).toContain("type");
        if (requests === 7) return { type: "finish", summary: "Checked native and managed tools." };
        const call = requests === 1 || requests === 4 ? { name: "list_windows", arguments: {} }
          : requests === 2 || requests === 5 ? { name: "switch_window", arguments: { windowRef: requests === 2 ? "managed" : "native" } }
          : { name: "click", arguments: { x: 0, y: 0 } };
        return { type: "tool_calls", calls: [{ id: `call-${requests}` as never, ...call }] };
      } },
    });
    try {
      const outcome = await controller.start("Check tool availability across surfaces");
      expect(outcome, JSON.stringify(controller.getEvents().filter((event) => event.type === "runtime.error" || event.type === "model.request.failed" || event.type === "tool.call.rejected"))).toBe("succeeded");
      expect(executed).toEqual(["switch_window", "switch_window", "click"]);
      expect(controller.getEvents().filter((event) => event.type === "tool.call.rejected")).toHaveLength(1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

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
