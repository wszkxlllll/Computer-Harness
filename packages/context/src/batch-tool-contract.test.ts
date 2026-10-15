import { describe, expect, it } from "vitest";
import { createDefaultToolRegistry, groundingComputerTools, type RunFeatureConfig } from "@computer-harness/runtime";
import type { ComputerSessionDescriptor, ComputerSessionId, RunId } from "@computer-harness/protocol";
import { DefaultContextCompiler } from "./compiler.js";

const runId = "batch-tool-contract" as RunId;
const viewport = { width: 800, height: 600, coordinateSpace: "physical" as const };
const batching: RunFeatureConfig = { planning: "off", memory: "off", batching: "same-control-input-v1" };

function session(platform: NonNullable<ComputerSessionDescriptor["platform"]>): ComputerSessionDescriptor {
  return {
    id: "batch-session" as ComputerSessionId,
    backend: "cua-driver-daemon",
    platform,
    viewport,
    capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false },
    openedAt: "2026-10-14T00:00:00.000Z",
  };
}

async function compile(options: {
  readonly enabledToolNames?: readonly string[];
  readonly platform?: ComputerSessionDescriptor["platform"];
  readonly requestBudget?: { readonly limit: number; readonly remaining: number };
  readonly features?: RunFeatureConfig;
} = {}) {
  const registry = createDefaultToolRegistry();
  registry.registerMany(groundingComputerTools());
  const compiler = new DefaultContextCompiler(registry);
  return compiler.compile({
    runId,
    goal: "Use the current GUI state.",
    recentEvents: [],
    ...(options.enabledToolNames === undefined ? {} : { enabledToolNames: options.enabledToolNames }),
    ...(options.platform === undefined ? {} : { computerSession: session(options.platform) }),
    ...(options.requestBudget === undefined ? {} : { requestBudget: options.requestBudget }),
    features: options.features ?? batching,
  }, new AbortController().signal);
}

describe("batch guidance follows the current Registry projection", () => {
  it("keeps the complete safe batch contract for Windows tools and emits platform-specific select-all", async () => {
    const input = await compile({ platform: "win32" });
    expect(input.tools.map((tool) => tool.name)).toContain("click_element");
    expect(input.system).toContain("click→type");
    expect(input.system).toContain("Ctrl+A→type");
    expect(input.system).toContain("click→Ctrl+A→type");
    expect(input.system).toContain("hotkey with exact keys [CTRL, A]");
    expect(input.system).toContain("CMD/Meta+A is not supported in batches");
    expect(input.system).toContain("click_element cannot be included in a batch");
  });

  it("offers only click-then-type when hotkey is filtered out", async () => {
    const input = await compile({ enabledToolNames: ["click", "type", "terminate"] });
    expect(input.tools.map((tool) => tool.name).sort()).toEqual(["click", "terminate", "type"]);
    expect(input.system).toContain("A GUI batch is only click→type");
    expect(input.system).not.toContain("Ctrl+A");
    expect(input.system).not.toContain("hotkey with exact keys [CTRL, A]");
    expect(input.system).not.toContain("click_element");
  });

  it("offers select-all then type without inventing click sequences when click is filtered out", async () => {
    const input = await compile({ enabledToolNames: ["hotkey", "type", "terminate"] });
    expect(input.tools.map((tool) => tool.name).sort()).toEqual(["hotkey", "terminate", "type"]);
    expect(input.system).toContain("A GUI batch is only Ctrl+A→type");
    expect(input.system).toContain("hotkey with exact keys [CTRL, A]");
    expect(input.system).not.toContain("click→");
    expect(input.system).not.toContain("click_element");
  });

  it("keeps click_element single-call and removes batch guidance when no supported sequence remains", async () => {
    const input = await compile({ enabledToolNames: ["click_element"] });
    expect(input.tools.map((tool) => tool.name)).toEqual(["click_element"]);
    expect(input.system).toContain("one Computer call");
    expect(input.system).toContain("No multi-call GUI batch is available");
    expect(input.system).toContain("click_element cannot be included in a batch");
    expect(input.system).not.toContain("A GUI batch is only");
    expect(input.system).not.toContain("Ctrl+A");
  });

  it("uses Meta+A for macOS and preserves Planning/Memory write composition", async () => {
    const input = await compile({
      platform: "darwin",
      features: { planning: "tasks-v1", memory: "facts-v1", batching: "same-control-input-v1" },
    });
    expect(input.system).toContain("up to two Planning/Memory write calls first, followed by one Computer call or one GUI batch");
    expect(input.system).toContain("click→type");
    expect(input.system).toContain("CMD/Meta+A→type");
    expect(input.system).toContain("click→CMD/Meta+A→type");
    expect(input.system).toContain("hotkey with exact keys [CMD, A] (or [META, A])");
    expect(input.system).toContain("CTRL+A is not supported in batches");
    expect(input.system).toContain("do not write task-retention Memory");
  });

  it("does not leave batch claims after explicit tool filtering or finish-only reduction", async () => {
    const filtered = await compile({ enabledToolNames: ["terminate"] });
    expect(filtered.tools.map((tool) => tool.name)).toEqual(["terminate"]);
    expect(filtered.system).not.toContain("GUI batch");
    expect(filtered.system).not.toContain("Computer call");

    const finishOnly = await compile({ requestBudget: { limit: 6, remaining: 1 } });
    expect(finishOnly.tools.map((tool) => tool.name)).toEqual(["terminate"]);
    expect(finishOnly.system).not.toContain("GUI batch");
    expect(finishOnly.system).not.toContain("Computer call");
  });
});
