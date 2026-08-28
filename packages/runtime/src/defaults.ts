import { randomUUID } from "node:crypto";
import type { ActionId, AssetId, EventId, ObservationId, ToolCall } from "@computer-harness/protocol";
import type { RunSnapshot } from "@computer-harness/trajectory";
import type {
  Clock,
  ContextCompileInput,
  ContextCompiler,
  IdFactory,
  ModelMessage,
  ModelInput,
  RuntimePolicy,
  ToolDefinition,
  ToolPolicyDecision,
} from "./contracts.js";
import { ToolRegistry } from "./tool-registry.js";

export class DefaultRuntimePolicy implements RuntimePolicy {
  public constructor(private readonly maxSteps = 100) {}

  public async evaluateToolCall(_context: { call: ToolCall; tool: ToolDefinition; snapshot: RunSnapshot }): Promise<ToolPolicyDecision> {
    return { decision: "allow" };
  }

  public checkBudget(snapshot: RunSnapshot): { allowed: boolean; reason?: string } {
    if (snapshot.stepCount >= this.maxSteps) {
      return { allowed: false, reason: `step budget exhausted at ${this.maxSteps}` };
    }
    return { allowed: true };
  }

  public canFinish(_snapshot: RunSnapshot): { allowed: boolean; reason?: string } {
    return { allowed: true };
  }
}

export class DefaultContextCompiler implements ContextCompiler {
  public constructor(private readonly tools: ToolRegistry) {}

  public async compile(input: ContextCompileInput): Promise<ModelInput> {
    const messages: ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: input.goal }] },
    ];
    if (input.latestObservation !== undefined) {
      messages.push({
        role: "user",
        content: [{ type: "image", asset: input.latestObservation.screenshot }],
      });
    }
    for (const result of input.toolResults) {
      messages.push({ role: "tool", content: [{ type: "tool_result", result }] });
    }
    const latestUserInput = [...input.recentEvents]
      .reverse()
      .find((event) => event.type === "user.input.received");
    if (latestUserInput?.type === "user.input.received") {
      messages.push({
        role: "user",
        content: [{ type: "text", text: `User correction or answer: ${latestUserInput.text}` }],
      });
    }
    return {
      system: "You are a GUI agent. Use the available tools and finish only when the task is complete.",
      messages,
      tools: this.tools.modelTools(),
    };
  }
}

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
};

export const randomIdFactory: IdFactory = {
  eventId: () => randomUUID() as EventId,
  observationId: () => randomUUID() as ObservationId,
  assetId: () => randomUUID() as AssetId,
  actionId: () => randomUUID() as ActionId,
};
