import { randomUUID } from "node:crypto";
import type { ActionId, AssetId, EventId, ObservationId, ToolCall } from "@computer-harness/protocol";
import type { RunSnapshot } from "@computer-harness/trajectory";
import type {
  Clock,
  IdFactory,
  RuntimePolicy,
  ToolDefinition,
  ToolPolicyDecision,
} from "./contracts.js";

export class DefaultRuntimePolicy implements RuntimePolicy {
  public constructor(
    private readonly maxSteps = 100,
    private readonly maxModelRequests = 100,
  ) {}

  public async evaluateToolCall(_context: { call: ToolCall; tool: ToolDefinition; snapshot: RunSnapshot }): Promise<ToolPolicyDecision> {
    return { decision: "allow" };
  }

  public checkBudget(snapshot: RunSnapshot): { allowed: boolean; reason?: string } {
    if (snapshot.stepCount >= this.maxSteps) {
      return { allowed: false, reason: `step budget exhausted at ${this.maxSteps}` };
    }
    if (snapshot.modelRequestCount >= this.maxModelRequests) {
      return { allowed: false, reason: `model request budget exhausted at ${this.maxModelRequests}` };
    }
    return { allowed: true };
  }

  public canFinish(_snapshot: RunSnapshot): { allowed: boolean; reason?: string } {
    return { allowed: true };
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
