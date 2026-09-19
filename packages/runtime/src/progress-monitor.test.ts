import { describe, expect, it } from "vitest";
import type { ActionId, ActionIntent, ComputerSessionId, EventId, ObservationId, RunId, RuntimeEvent, ToolCallId } from "@computer-harness/protocol";
import { createProgressMonitorState, reduceProgressMonitor } from "./progress-monitor.js";

let sequence = 0;

function eventForRun(runId: RunId, data: Record<string, unknown>): RuntimeEvent {
  const current = sequence++;
  return {
    eventId: `monitor-event-${current}` as EventId,
    runId,
    sequence: current,
    occurredAt: `2026-09-18T00:00:${String(current).padStart(2, "0")}Z`,
    ...data,
  } as unknown as RuntimeEvent;
}

function observation(
  runId: RunId,
  id: string,
  width = 800,
  height = 600,
  screenshot = true,
): RuntimeEvent {
  return eventForRun(runId, {
    type: "observation.created",
    observation: {
      id: id as ObservationId,
      runId,
      computerSessionId: "fixture-session" as ComputerSessionId,
      capturedAt: "2026-09-18T00:00:00Z",
      viewport: { width, height, coordinateSpace: "physical" },
      ...(screenshot
        ? { screenshot: { assetId: `asset-${id}`, relativePath: "ignored.png", mediaType: "image/png", byteLength: 1 } }
        : {}),
    },
  });
}

function click(runId: RunId, id: string, basedOn: string, x = 10, y = 20): RuntimeEvent {
  const action: ActionIntent = { actionId: id as ActionId, kind: "click", basedOn: basedOn as ObservationId, point: { x, y } };
  return eventForRun(runId, { type: "action.proposed", callId: `call-${id}` as ToolCallId, action });
}

function typed(runId: RunId, id: string, basedOn: string, text: string): RuntimeEvent {
  const action: ActionIntent = { actionId: id as ActionId, kind: "type", basedOn: basedOn as ObservationId, text };
  return eventForRun(runId, { type: "action.proposed", callId: `call-${id}` as ToolCallId, action });
}

function keypress(runId: RunId, id: string, basedOn: string, keys: string[]): RuntimeEvent {
  const action: ActionIntent = { actionId: id as ActionId, kind: "keypress", basedOn: basedOn as ObservationId, keys };
  return eventForRun(runId, { type: "action.proposed", callId: `call-${id}` as ToolCallId, action });
}

function receipt(runId: RunId, actionId: string, status: "completed" | "refused" | "failed" | "cancelled"): RuntimeEvent {
  return eventForRun(runId, {
    type: "action.execution.completed",
    receipt: { actionId: actionId as ActionId, status },
  });
}

function planningUpdate(runId: RunId): RuntimeEvent {
  return eventForRun(runId, {
    type: "planning.task.updated",
    callId: "plan-call" as ToolCallId,
    mutation: { operation: "created", task: { id: "task-1", subject: "private synthetic subject" } },
  });
}

function memoryUpdate(runId: RunId): RuntimeEvent {
  return eventForRun(runId, {
    type: "memory.updated",
    callId: "memory-call" as ToolCallId,
    mutation: { operation: "mark_fact_needs_check", factId: "fact-1" },
  });
}

describe("progress monitor foundation", () => {
  const runId = "monitor-run" as RunId;

  it("reports repeated actions as a candidate without a stop decision or typed payload", () => {
    let state = createProgressMonitorState(runId, { repeatThreshold: 3 });
    state = reduceProgressMonitor(state, observation(runId, "observation-1")).state;
    const first = reduceProgressMonitor(state, typed(runId, "type-1", "observation-1", "PRIVATE_TYPED_TEXT"));
    state = reduceProgressMonitor(first.state, receipt(runId, "type-1", "completed")).state;
    const second = reduceProgressMonitor(state, typed(runId, "type-2", "observation-1", "PRIVATE_TYPED_TEXT"));
    state = reduceProgressMonitor(second.state, receipt(runId, "type-2", "completed")).state;
    const third = reduceProgressMonitor(state, typed(runId, "type-3", "observation-1", "PRIVATE_TYPED_TEXT"));
    const thirdReceipt = reduceProgressMonitor(third.state, receipt(runId, "type-3", "completed"));

    expect(first.output.candidate).toBe(false);
    expect(second.output.candidate).toBe(false);
    expect(thirdReceipt.output.candidate).toBe(true);
    expect(thirdReceipt.output.reasons.map((reason) => reason.code)).toContain("repeated_action");
    expect(JSON.stringify(thirdReceipt.output)).not.toContain("PRIVATE_TYPED_TEXT");
    expect(JSON.stringify(thirdReceipt.state)).not.toContain("PRIVATE_TYPED_TEXT");
    expect("stop" in thirdReceipt.output).toBe(false);
  });

  it("detects A-B-A only inside one comparable session and viewport partition", () => {
    let state = createProgressMonitorState(runId);
    state = reduceProgressMonitor(state, observation(runId, "observation-1")).state;
    state = reduceProgressMonitor(state, click(runId, "a-1", "observation-1", 1, 1)).state;
    state = reduceProgressMonitor(state, receipt(runId, "a-1", "completed")).state;
    state = reduceProgressMonitor(state, click(runId, "b-1", "observation-1", 2, 2)).state;
    state = reduceProgressMonitor(state, receipt(runId, "b-1", "completed")).state;
    const cycleProposal = reduceProgressMonitor(state, click(runId, "a-2", "observation-1", 1, 1));
    const cycle = reduceProgressMonitor(cycleProposal.state, receipt(runId, "a-2", "completed"));
    expect(cycle.output.candidate).toBe(true);
    expect(cycle.output.reasons.map((reason) => reason.code)).toContain("action_cycle");

    state = reduceProgressMonitor(cycle.state, observation(runId, "observation-2", 1024, 768)).state;
    const differentPartition = reduceProgressMonitor(state, click(runId, "a-new", "observation-2", 1, 1));
    expect(differentPartition.output.candidate).toBe(false);
    expect(differentPartition.output.reasons).toHaveLength(0);
  });

  it("requires repeated explicit refusal before producing a refusal candidate", () => {
    let state = createProgressMonitorState(runId, { refusalThreshold: 2 });
    state = reduceProgressMonitor(state, observation(runId, "observation-1")).state;
    state = reduceProgressMonitor(state, click(runId, "refused-1", "observation-1")).state;
    state = reduceProgressMonitor(state, receipt(runId, "refused-1", "refused")).state;
    state = reduceProgressMonitor(state, click(runId, "refused-2", "observation-1")).state;
    const secondRefusal = reduceProgressMonitor(state, receipt(runId, "refused-2", "refused"));

    expect(secondRefusal.output.candidate).toBe(true);
    expect(secondRefusal.output.reasons.map((reason) => reason.code)).toContain("repeated_refusal");
  });

  it("does not equate same-length text or keys, and separates proposal repetition from execution repetition", () => {
    let state = createProgressMonitorState(runId, { repeatThreshold: 2 });
    state = reduceProgressMonitor(state, observation(runId, "observation-1")).state;
    state = reduceProgressMonitor(state, typed(runId, "text-a", "observation-1", "AA")).state;
    const differentText = reduceProgressMonitor(state, typed(runId, "text-b", "observation-1", "BB"));
    expect(differentText.output.candidate).toBe(false);

    state = reduceProgressMonitor(createProgressMonitorState(runId, { repeatThreshold: 2 }), observation(runId, "observation-2")).state;
    state = reduceProgressMonitor(state, keypress(runId, "key-a", "observation-2", ["A"])).state;
    const differentKey = reduceProgressMonitor(state, keypress(runId, "key-b", "observation-2", ["B"]));
    expect(differentKey.output.candidate).toBe(false);

    state = reduceProgressMonitor(createProgressMonitorState(runId, { repeatThreshold: 2 }), observation(runId, "observation-3")).state;
    state = reduceProgressMonitor(state, click(runId, "proposal-1", "observation-3")).state;
    const proposalRepeat = reduceProgressMonitor(state, click(runId, "proposal-2", "observation-3"));
    expect(proposalRepeat.output.reasons.map((reason) => reason.code)).toContain("repeated_proposal");
    expect(proposalRepeat.output.reasons.map((reason) => reason.code)).not.toContain("repeated_action");

    state = reduceProgressMonitor(createProgressMonitorState(runId, { repeatThreshold: 2 }), observation(runId, "observation-4")).state;
    state = reduceProgressMonitor(state, click(runId, "executed-1", "observation-4")).state;
    state = reduceProgressMonitor(state, receipt(runId, "executed-1", "completed")).state;
    state = reduceProgressMonitor(state, click(runId, "executed-2", "observation-4")).state;
    const executedRepeat = reduceProgressMonitor(state, receipt(runId, "executed-2", "completed"));
    expect(executedRepeat.output.reasons.map((reason) => reason.code)).toContain("repeated_action");
  });

  it("requires a consecutive signature tail rather than all-history frequency", () => {
    let state = createProgressMonitorState(runId, { repeatThreshold: 2 });
    state = reduceProgressMonitor(state, observation(runId, "observation-window")).state;
    state = reduceProgressMonitor(state, click(runId, "window-a1", "observation-window", 1, 1)).state;
    state = reduceProgressMonitor(state, click(runId, "window-b", "observation-window", 2, 2)).state;
    state = reduceProgressMonitor(state, click(runId, "window-c", "observation-window", 3, 3)).state;
    const separatedRepeat = reduceProgressMonitor(state, click(runId, "window-a2", "observation-window", 1, 1));
    expect(separatedRepeat.output.reasons.map((reason) => reason.code)).not.toContain("repeated_proposal");
    expect(separatedRepeat.output.reasons.map((reason) => reason.code)).not.toContain("repeated_action");
  });

  it("reports plan churn but does not infer a stall from a short task with no plan events", () => {
    let state = createProgressMonitorState(runId, { churnThreshold: 3 });
    const first = reduceProgressMonitor(state, planningUpdate(runId));
    state = first.state;
    const second = reduceProgressMonitor(state, memoryUpdate(runId));
    state = second.state;
    const third = reduceProgressMonitor(state, planningUpdate(runId));
    expect(first.output.candidate).toBe(false);
    expect(second.output.candidate).toBe(false);
    expect(third.output.candidate).toBe(true);
    expect(third.output.reasons.map((reason) => reason.code)).toContain("plan_memory_churn");

    const shortTask = reduceProgressMonitor(createProgressMonitorState(runId), click(runId, "short-action", "missing-observation"));
    expect(shortTask.output.candidate).toBe(false);
    expect(shortTask.output.evidence.map((item) => item.kind)).toContain("action_binding_unavailable");
  });

  it("marks missing visual feature evidence unknown without treating it as progress", () => {
    const result = reduceProgressMonitor(createProgressMonitorState(runId), observation(runId, "missing-image", 800, 600, false));
    expect(result.output.candidate).toBe(false);
    expect(result.output.evidence.map((item) => item.kind)).toContain("visual_feature_unavailable");
    expect(result.output.reasons).toHaveLength(0);
  });

  it("bounds observation/action history and resets it when the run changes", () => {
    let state = createProgressMonitorState(undefined, { maxObservations: 2, maxActionHistory: 2 });
    state = reduceProgressMonitor(state, observation(runId, "observation-1")).state;
    expect(state.runId).toBe(runId);
    state = reduceProgressMonitor(state, observation(runId, "observation-2")).state;
    state = reduceProgressMonitor(state, observation(runId, "observation-3")).state;
    expect(state.observations.size).toBe(2);
    state = reduceProgressMonitor(state, click(runId, "old-1", "observation-3")).state;
    state = reduceProgressMonitor(state, click(runId, "old-2", "observation-3")).state;
    state = reduceProgressMonitor(state, click(runId, "old-3", "observation-3")).state;
    expect(state.recentActions).toHaveLength(2);
    expect(state.actionRecords.size).toBe(2);

    const nextRun = "monitor-next-run" as RunId;
    const reset = reduceProgressMonitor(state, eventForRun(nextRun, { type: "run.created", goal: "synthetic" }));
    expect(reset.state.runId).toBe(nextRun);
    expect(reset.state.observations.size).toBe(0);
    expect(reset.state.recentActions).toHaveLength(0);
    const staleBinding = reduceProgressMonitor(reset.state, click(nextRun, "new-1", "observation-3"));
    expect(staleBinding.output.candidate).toBe(false);
    expect(staleBinding.output.evidence.map((item) => item.kind)).toContain("action_binding_unavailable");
  });

  it("surfaces unknown outcome as a candidate without a retry or execution instruction", () => {
    const result = reduceProgressMonitor(createProgressMonitorState(runId), eventForRun(runId, { type: "run.finished", outcome: "outcome_unknown" }));
    expect(result.output.candidate).toBe(true);
    expect(result.output.reasons.map((reason) => reason.code)).toEqual(["unknown_outcome"]);
    expect(result.output.evidence.map((item) => item.kind)).toEqual(["unknown_outcome"]);
    expect("retry" in result.output).toBe(false);
  });
});
