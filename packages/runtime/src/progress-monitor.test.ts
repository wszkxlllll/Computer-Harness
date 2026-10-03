import { describe, expect, it } from "vitest";
import type { ActionId, ActionIntent, ComputerSessionId, EventId, ObservationId, RunId, RuntimeEvent, SurfaceRef, ToolCallId } from "@computer-harness/protocol";
import { createProgressMonitorState, reduceProgressMonitor, shouldRejectRepeatedNoChange } from "./progress-monitor.js";

let sequence = 0;
const defaultSurfaceRef: SurfaceRef = { surfaceId: "monitor-desktop" as SurfaceRef["surfaceId"], generation: 1, kind: "desktop" };

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
  surfaceRef: SurfaceRef = defaultSurfaceRef,
): RuntimeEvent {
  return eventForRun(runId, {
    type: "observation.created",
    observation: {
      id: id as ObservationId,
      runId,
      computerSessionId: "fixture-session" as ComputerSessionId,
      surfaceRef,
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

function receipt(runId: RunId, actionId: string, status: "completed" | "refused" | "failed" | "cancelled" | "partial"): RuntimeEvent {
  return eventForRun(runId, {
    type: status === "completed" ? "action.execution.completed" : "action.execution.failed",
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

function transition(
  runId: RunId,
  actionId: string,
  postObservationId: string,
  transitionKind: "changed" | "unchanged" | "unknown",
  preObservationId = "observation-1",
): RuntimeEvent {
  return eventForRun(runId, {
    type: "monitor.transition",
    actionId: actionId as ActionId,
    preObservationId: preObservationId as ObservationId,
    postObservationId: postObservationId as ObservationId,
    sourceActionEventId: "action-terminal" as EventId,
    sourceObservationEventId: "observation-event" as EventId,
    transition: transitionKind,
  });
}

function assessmentResponse(
  runId: RunId,
  observationId: string,
  actionId: string,
  actionOutcome: "expected_change" | "no_effect" | "unexpected_change" | "uncertain",
): RuntimeEvent {
  return eventForRun(runId, {
    type: "model.response.received",
    turn: {
      type: "finish",
      summary: "done",
      observationAssessment: {
        observationId: observationId as ObservationId,
        actionId: actionId as ActionId,
        actionOutcome,
        evidence: "Visible state compared with the prior observation.",
      },
    },
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

  it("retains partial receipts in the repeated-failure status tail", () => {
    let state = createProgressMonitorState(runId, { refusalThreshold: 2 });
    state = reduceProgressMonitor(state, observation(runId, "partial-observation")).state;
    state = reduceProgressMonitor(state, typed(runId, "partial-1", "partial-observation", "first\nsecond")).state;
    state = reduceProgressMonitor(state, receipt(runId, "partial-1", "partial")).state;
    state = reduceProgressMonitor(state, typed(runId, "partial-2", "partial-observation", "first\nsecond")).state;
    const repeatedPartial = reduceProgressMonitor(state, receipt(runId, "partial-2", "partial"));

    expect(repeatedPartial.output.candidate).toBe(true);
    expect(repeatedPartial.output.reasons.map((reason) => reason.code)).toContain("repeated_failure");
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

  it("isolates repeated-action history across three Surfaces in one session and viewport", () => {
    const surface = (id: string, kind: SurfaceRef["kind"]): SurfaceRef => ({
      surfaceId: id as SurfaceRef["surfaceId"],
      generation: 1,
      kind,
    });
    let state = createProgressMonitorState(runId, { repeatThreshold: 2 });
    state = reduceProgressMonitor(state, observation(runId, "surface-a-observation", 800, 600, true, surface("surface-a", "native_window"))).state;
    state = reduceProgressMonitor(state, click(runId, "surface-a-action", "surface-a-observation", 10, 20)).state;
    state = reduceProgressMonitor(state, receipt(runId, "surface-a-action", "completed")).state;
    state = reduceProgressMonitor(state, observation(runId, "surface-b-observation", 800, 600, true, surface("surface-b", "overlay"))).state;
    state = reduceProgressMonitor(state, click(runId, "surface-b-action", "surface-b-observation", 20, 20)).state;
    state = reduceProgressMonitor(state, receipt(runId, "surface-b-action", "completed")).state;
    state = reduceProgressMonitor(state, observation(runId, "surface-c-observation", 800, 600, true, surface("surface-c", "native_window"))).state;
    const surfaceC = reduceProgressMonitor(state, click(runId, "surface-c-action", "surface-c-observation", 10, 20));

    expect(surfaceC.output.candidate).toBe(false);
    expect(surfaceC.output.reasons.map((reason) => reason.code)).not.toContain("action_cycle");
    expect(surfaceC.output.reasons.map((reason) => reason.code)).not.toContain("repeated_proposal");
    expect(surfaceC.output.reasons.map((reason) => reason.code)).not.toContain("repeated_action");
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

  it("emits post-action transition evidence and exposes the deterministic repeat guard", () => {
    let state = createProgressMonitorState(runId);
    state = reduceProgressMonitor(state, observation(runId, "observation-1")).state;
    state = reduceProgressMonitor(state, click(runId, "same-1", "observation-1", 10, 20)).state;
    state = reduceProgressMonitor(state, receipt(runId, "same-1", "completed")).state;
    state = reduceProgressMonitor(state, observation(runId, "observation-2")).state;
    const first = reduceProgressMonitor(state, transition(runId, "same-1", "observation-2", "unchanged"));
    expect(first.output.candidate).toBe(true);
    expect(first.output.reasons.map((reason) => reason.code)).toEqual(["no_observed_change"]);
    expect(first.output.evidence.map((item) => item.kind)).toContain("visual_transition_unchanged");

    const current = first.state;
    expect(shouldRejectRepeatedNoChange(current, { actionId: "next" as ActionId, kind: "click", basedOn: "observation-2" as ObservationId, point: { x: 10, y: 20 } })).toBe(true);
    expect(shouldRejectRepeatedNoChange(current, { actionId: "next" as ActionId, kind: "click", basedOn: "observation-2" as ObservationId, point: { x: 11, y: 20 } })).toBe(false);
    expect(shouldRejectRepeatedNoChange(current, { actionId: "next" as ActionId, kind: "click", basedOn: "observation-3" as ObservationId, point: { x: 10, y: 20 } })).toBe(false);
    expect(shouldRejectRepeatedNoChange(current, { actionId: "repeat-scroll" as ActionId, kind: "scroll", basedOn: "observation-2" as ObservationId, point: { x: 10, y: 20 }, direction: "down", ticks: 1 })).toBe(false);
    expect(shouldRejectRepeatedNoChange(current, { actionId: "repeat-type" as ActionId, kind: "type", basedOn: "observation-2" as ObservationId, text: "same input" })).toBe(false);
    expect(shouldRejectRepeatedNoChange(current, { actionId: "repeat-key" as ActionId, kind: "keypress", basedOn: "observation-2" as ObservationId, keys: ["ARROWDOWN"] })).toBe(false);
  });

  it("does not treat changed or unknown transition evidence as a no-change candidate", () => {
    let state = createProgressMonitorState(runId);
    state = reduceProgressMonitor(state, observation(runId, "observation-1")).state;
    state = reduceProgressMonitor(state, click(runId, "changed-1", "observation-1")).state;
    state = reduceProgressMonitor(state, receipt(runId, "changed-1", "completed")).state;
    state = reduceProgressMonitor(state, observation(runId, "observation-2")).state;
    const changed = reduceProgressMonitor(state, transition(runId, "changed-1", "observation-2", "changed"));
    expect(changed.output.candidate).toBe(false);
    expect(changed.output.evidence.map((item) => item.kind)).toContain("visual_transition_changed");

    state = changed.state;
    state = reduceProgressMonitor(state, observation(runId, "observation-2")).state;
    state = reduceProgressMonitor(state, click(runId, "unknown-1", "observation-2")).state;
    state = reduceProgressMonitor(state, receipt(runId, "unknown-1", "failed")).state;
    state = reduceProgressMonitor(state, observation(runId, "observation-3")).state;
    const unknown = reduceProgressMonitor(state, transition(runId, "unknown-1", "observation-3", "unknown", "observation-2"));
    expect(unknown.output.candidate).toBe(false);
    expect(unknown.output.evidence.map((item) => item.kind)).toContain("visual_transition_unknown");
  });

  it("does not trust a transition whose pre-observation binding does not match the action", () => {
    let state = createProgressMonitorState(runId);
    state = reduceProgressMonitor(state, observation(runId, "observation-1")).state;
    state = reduceProgressMonitor(state, click(runId, "forged-1", "observation-1")).state;
    state = reduceProgressMonitor(state, receipt(runId, "forged-1", "completed")).state;
    const forged = reduceProgressMonitor(state, transition(runId, "forged-1", "observation-2", "unchanged", "wrong-observation"));
    expect(forged.output.candidate).toBe(false);
    expect(forged.output.evidence.map((item) => item.kind)).toContain("visual_transition_unknown");
    expect(forged.output.evidence.map((item) => item.kind)).toContain("action_binding_unavailable");
    expect(shouldRejectRepeatedNoChange(forged.state, { actionId: "next" as ActionId, kind: "click", basedOn: "observation-2" as ObservationId, point: { x: 10, y: 20 } })).toBe(false);
  });

  it("reconciles assessments with the exact action, latest observation, receipt, and visual transition", () => {
    const stateFor = (transitionKind: "changed" | "unchanged" | "unknown", receiptStatus: "completed" | "failed" = "completed") => {
      let state = createProgressMonitorState(runId);
      state = reduceProgressMonitor(state, observation(runId, "assessment-before")).state;
      state = reduceProgressMonitor(state, click(runId, "assessment-action", "assessment-before")).state;
      state = reduceProgressMonitor(state, receipt(runId, "assessment-action", receiptStatus)).state;
      state = reduceProgressMonitor(state, observation(runId, "assessment-current")).state;
      state = reduceProgressMonitor(state, transition(runId, "assessment-action", "assessment-current", transitionKind, "assessment-before")).state;
      return state;
    };

    const noEffect = reduceProgressMonitor(stateFor("unchanged"), assessmentResponse(runId, "assessment-current", "assessment-action", "no_effect"));
    expect(noEffect.output.assessmentOutcome).toBe("no_effect");
    expect(noEffect.output.reasons.map((reason) => reason.code)).toContain("no_observed_change");
    expect(noEffect.output.evidence.map((item) => item.kind)).toContain("semantic_assessment");
    expect(noEffect.output.evidence.map((item) => item.kind)).toContain("visual_transition_unchanged");

    const unexpected = reduceProgressMonitor(stateFor("changed"), assessmentResponse(runId, "assessment-current", "assessment-action", "unexpected_change"));
    expect(unexpected.output.assessmentOutcome).toBe("unexpected_change");
    expect(unexpected.output.reasons.map((reason) => reason.code)).toContain("unexpected_change");

    const conflict = reduceProgressMonitor(stateFor("unchanged"), assessmentResponse(runId, "assessment-current", "assessment-action", "expected_change"));
    expect(conflict.output.assessmentOutcome).toBe("uncertain");
    expect(conflict.output.reasons.map((reason) => reason.code)).toContain("assessment_uncertain");

    const receiptError = reduceProgressMonitor(stateFor("unknown", "failed"), assessmentResponse(runId, "assessment-current", "assessment-action", "expected_change"));
    expect(receiptError.output.assessmentOutcome).toBe("uncertain");
    expect(receiptError.output.evidence.map((item) => item.kind)).toContain("visual_transition_unknown");

    const staleObservation = reduceProgressMonitor(stateFor("changed"), assessmentResponse(runId, "assessment-before", "assessment-action", "expected_change"));
    expect(staleObservation.output.assessmentOutcome).toBe("uncertain");
    const staleAction = reduceProgressMonitor(stateFor("changed"), assessmentResponse(runId, "assessment-current", "older-action", "expected_change"));
    expect(staleAction.output.assessmentOutcome).toBe("uncertain");
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
