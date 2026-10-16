import { describe, expect, it } from "vitest";
import type { EventId, RunId } from "@computer-harness/protocol";
import { createMonitorPolicyState, reduceMonitorPolicy, serializeMonitorProposal, type MonitorPolicyInput, type MonitorWorkClock } from "./monitor-policy.js";

const runId = "monitor-policy-run" as RunId;

function candidate(eventId = "candidate-event"): MonitorPolicyInput["monitor"] {
  return {
    candidate: true,
    reasons: [{ code: "repeated_action", eventIds: [eventId as EventId] }],
    evidence: [{ kind: "action_receipt", eventIds: [eventId as EventId] }],
    eventIds: [eventId as EventId],
  };
}

function unchangedTransition(eventId = "transition-event"): MonitorPolicyInput["monitor"] {
  return {
    candidate: true,
    reasons: [{ code: "no_observed_change", eventIds: [eventId as EventId] }],
    evidence: [{ kind: "visual_transition_unchanged", eventIds: [eventId as EventId] }],
    eventIds: [eventId as EventId],
  };
}

function input(
  sequence: number,
  clock: MonitorWorkClock,
  monitor: MonitorPolicyInput["monitor"] = { candidate: false, reasons: [], evidence: [], eventIds: [] },
  overrides: Partial<Pick<MonitorPolicyInput, "runId" | "partitionKey" | "executionBarrier" | "terminal" | "guidanceText">> = {},
): MonitorPolicyInput {
  return { runId, partitionKey: "session-a|viewport-800x600", sequence, clock, monitor, ...overrides };
}

describe("MonitorPolicy", () => {
  it("keeps off and shadow side-effect free", () => {
    const off = reduceMonitorPolicy(createMonitorPolicyState(), input(1, { modelDecisionCount: 1, guiActionCount: 0 }, candidate()));
    expect(off.proposal).toEqual({ kind: "none", reason: "disabled" });
    const shadowState = createMonitorPolicyState({ mode: "shadow" });
    const first = reduceMonitorPolicy(shadowState, input(1, { modelDecisionCount: 1, guiActionCount: 0 }, candidate()));
    const second = reduceMonitorPolicy(first.state, input(2, { modelDecisionCount: 2, guiActionCount: 0 }, candidate("new-event")));
    expect(first.proposal).toEqual({ kind: "none", reason: "shadow" });
    expect(second.proposal).toEqual({ kind: "none", reason: "shadow" });
    expect(second.state.guidanceCount).toBe(0);
    let agedShadow = first.state;
    for (let sequence = 2; sequence < 12; sequence += 1) {
      agedShadow = reduceMonitorPolicy(agedShadow, input(sequence, { modelDecisionCount: sequence, guiActionCount: 0 })).state;
    }
    expect(agedShadow.candidateFingerprint).toBeUndefined();
    expect(reduceMonitorPolicy(agedShadow, input(12, { modelDecisionCount: 12, guiActionCount: 0 }, candidate())).proposal.kind).toBe("none");
  });

  it("proposes bounded guidance by work counters, not event sequence noise", () => {
    let state = createMonitorPolicyState({ mode: "guidance", cooldownWorkUnits: 2, maxGuidanceCount: 2 });
    const first = reduceMonitorPolicy(state, input(10, { modelDecisionCount: 1, guiActionCount: 0 }, candidate()));
    state = first.state;
    expect(first.proposal).toEqual({ kind: "none", reason: "candidate_observed" });

    const traceOnly = reduceMonitorPolicy(state, input(11, { modelDecisionCount: 1, guiActionCount: 0 }, candidate("different-event")));
    expect(traceOnly.proposal).toEqual({ kind: "none", reason: "candidate_observed" });
    state = traceOnly.state;

    const guidance = reduceMonitorPolicy(state, input(12, { modelDecisionCount: 2, guiActionCount: 0 }, candidate("third-event")));
    expect(guidance.proposal.kind).toBe("guidance");
    if (guidance.proposal.kind === "guidance") {
      expect(guidance.proposal.text.length).toBeLessThanOrEqual(240);
      expect(guidance.proposal.text).not.toContain("third-event");
    }
    state = guidance.state;
    const cooldown = reduceMonitorPolicy(state, input(13, { modelDecisionCount: 3, guiActionCount: 0 }, candidate("fourth-event")));
    expect(cooldown.proposal).toEqual({ kind: "none", reason: "guidance_cooldown" });
    const secondGuidance = reduceMonitorPolicy(state, input(14, { modelDecisionCount: 4, guiActionCount: 0 }, candidate("fifth-event")));
    expect(secondGuidance.proposal.kind).toBe("guidance");
  });

  it("waits for a meaningful candidate or assessment before injecting a prompt", () => {
    const state = createMonitorPolicyState({ mode: "guidance", cooldownWorkUnits: 2 });
    const first = reduceMonitorPolicy(state, input(1, { modelDecisionCount: 1, guiActionCount: 1 }, unchangedTransition()));
    expect(first.proposal).toEqual({ kind: "none", reason: "candidate_observed" });
    const later = reduceMonitorPolicy(first.state, input(2, { modelDecisionCount: 3, guiActionCount: 1 }, unchangedTransition()));
    expect(later.proposal.kind).toBe("guidance");
    if (later.proposal.kind === "guidance") {
      expect(later.proposal.text).toContain("screenshot appeared unchanged");
      expect(later.proposal.text).not.toContain("transition-event");
    }

    const assessmentEventId = "assessment-evidence" as EventId;
    const assessed = reduceMonitorPolicy(first.state, input(2, { modelDecisionCount: 2, guiActionCount: 1 }, {
      ...unchangedTransition(assessmentEventId),
      assessmentOutcome: "no_effect",
      evidence: [
        ...unchangedTransition(assessmentEventId).evidence,
        { kind: "semantic_assessment", eventIds: [assessmentEventId] },
      ],
    }, { guidanceText: "Earlier model report (untrusted): \"the input looked empty\". Check the newest image." }));
    expect(assessed.proposal.kind).toBe("guidance");
    if (assessed.proposal.kind === "guidance") expect(assessed.proposal.text).toContain("the input looked empty");
  });

  it("uses supplied bounded guidance and does not prompt for uncertainty alone", () => {
    const eventId = "assessment-uncertain" as EventId;
    const uncertain: MonitorPolicyInput["monitor"] = {
      candidate: true,
      assessmentOutcome: "uncertain",
      reasons: [{ code: "assessment_uncertain", eventIds: [eventId] }],
      evidence: [
        { kind: "semantic_assessment", eventIds: [eventId] },
        { kind: "visual_transition_unknown", eventIds: [eventId] },
      ],
      eventIds: [eventId],
    };
    const first = reduceMonitorPolicy(
      createMonitorPolicyState({ mode: "guidance", cooldownWorkUnits: 1 }),
      input(1, { modelDecisionCount: 1, guiActionCount: 1 }, uncertain, { guidanceText: "Untrusted report; inspect the newest image before choosing a next step." }),
    );
    expect(first.proposal).toEqual({ kind: "none", reason: "candidate_observed" });
    const sameEpisode = reduceMonitorPolicy(
      first.state,
      input(2, { modelDecisionCount: 2, guiActionCount: 1 }, uncertain, { guidanceText: "Untrusted report; inspect the newest image before choosing a next step." }),
    );
    expect(sameEpisode.proposal.kind).not.toBe("guidance");
  });

  it("suppresses guidance after its bounded budget and never requests user input", () => {
    let state = createMonitorPolicyState({ mode: "guidance", maxCandidateAgeWorkUnits: 2, maxGuidanceCount: 1, cooldownWorkUnits: 1 });
    state = reduceMonitorPolicy(state, input(1, { modelDecisionCount: 1, guiActionCount: 0 }, candidate())).state;
    const guidance = reduceMonitorPolicy(state, input(2, { modelDecisionCount: 2, guiActionCount: 0 }, candidate()));
    state = guidance.state;
    const budget = reduceMonitorPolicy(state, input(3, { modelDecisionCount: 3, guiActionCount: 0 }, candidate()));
    expect(budget.proposal).toEqual({ kind: "none", reason: "guidance_budget_exhausted" });
    expect(budget.state.guidanceCount).toBe(1);
    expect(JSON.stringify(budget.proposal)).not.toMatch(/help|retry|waiting_user/iu);

    const staleState = createMonitorPolicyState({ mode: "guidance", maxCandidateAgeWorkUnits: 1 });
    const staleCandidate = reduceMonitorPolicy(staleState, input(1, { modelDecisionCount: 1, guiActionCount: 0 }, candidate()));
    const stale = reduceMonitorPolicy(staleCandidate.state, input(2, { modelDecisionCount: 3, guiActionCount: 0 }));
    expect(stale.proposal).toEqual({ kind: "none", reason: "no_candidate" });
    expect(stale.state.candidateFingerprint).toBeUndefined();
  });

  it("restores the bounded budget only after changed evidence or age expiry", () => {
    let state = createMonitorPolicyState({ mode: "guidance", maxCandidateAgeWorkUnits: 4, maxGuidanceCount: 1, cooldownWorkUnits: 1 });
    state = reduceMonitorPolicy(state, input(1, { modelDecisionCount: 1, guiActionCount: 0 }, candidate())).state;
    const first = reduceMonitorPolicy(state, input(2, { modelDecisionCount: 2, guiActionCount: 0 }, candidate()));
    expect(first.proposal.kind).toBe("guidance");
    state = first.state;

    const differentReason = reduceMonitorPolicy(state, input(4, { modelDecisionCount: 4, guiActionCount: 1 }, unchangedTransition("new-reason")));
    expect(differentReason.proposal).toEqual({ kind: "none", reason: "guidance_budget_exhausted" });
    expect(differentReason.state.guidanceCount).toBe(1);

    const changed = reduceMonitorPolicy(differentReason.state, input(5, { modelDecisionCount: 4, guiActionCount: 1 }, {
      candidate: false,
      reasons: [],
      evidence: [{ kind: "visual_transition_changed", eventIds: ["changed" as EventId] }],
      eventIds: ["changed" as EventId],
    }));
    expect(changed.state.guidanceCount).toBe(0);
    const freshEpisode = reduceMonitorPolicy(changed.state, input(6, { modelDecisionCount: 5, guiActionCount: 1 }, candidate("fresh-candidate")));
    expect(freshEpisode.proposal).toEqual({ kind: "none", reason: "candidate_observed" });
    const freshGuidance = reduceMonitorPolicy(freshEpisode.state, input(7, { modelDecisionCount: 6, guiActionCount: 1 }, candidate("fresh-candidate")));
    expect(freshGuidance.proposal.kind).toBe("guidance");
  });

  it("lets execution barriers suppress monitor proposals and never turns unknown into waiting_user", () => {
    let state = createMonitorPolicyState({ mode: "guidance" });
    state = reduceMonitorPolicy(state, input(1, { modelDecisionCount: 1, guiActionCount: 0 }, candidate())).state;
    const suppressed = reduceMonitorPolicy(state, input(2, { modelDecisionCount: 2, guiActionCount: 0 }, candidate(), { executionBarrier: "unknown_outcome" }));
    expect(suppressed.proposal).toEqual({ kind: "none", reason: "suppressed_by_execution_barrier" });
    expect(JSON.stringify(suppressed.proposal)).not.toContain("retry");
    expect(JSON.stringify(suppressed.proposal)).not.toContain("waiting_user");
  });

  it("suppresses Monitor output during a normal action while retaining the current episode", () => {
    const initial = reduceMonitorPolicy(
      createMonitorPolicyState({ mode: "guidance", cooldownWorkUnits: 2 }),
      input(1, { modelDecisionCount: 1, guiActionCount: 1 }, unchangedTransition()),
    );
    const inFlight = reduceMonitorPolicy(initial.state, input(
      2,
      { modelDecisionCount: 2, guiActionCount: 1 },
      unchangedTransition("in-flight-transition"),
      { executionBarrier: "action_in_flight" },
    ));
    expect(inFlight.proposal).toEqual({ kind: "none", reason: "suppressed_by_execution_barrier" });
    expect(inFlight.state.candidateClock).toEqual(initial.state.candidateClock);
    expect(inFlight.state.guidanceCount).toBe(0);

    const settled = reduceMonitorPolicy(inFlight.state, input(3, { modelDecisionCount: 2, guiActionCount: 2 }, unchangedTransition("settled-transition")));
    expect(settled.proposal.kind).toBe("guidance");
  });

  it("is idempotent for replay/out-of-order input and resets across run or partition", () => {
    let state = createMonitorPolicyState({ mode: "guidance" });
    const first = reduceMonitorPolicy(state, input(5, { modelDecisionCount: 1, guiActionCount: 0 }, candidate()));
    state = first.state;
    const replay = reduceMonitorPolicy(state, input(5, { modelDecisionCount: 2, guiActionCount: 0 }, candidate()));
    expect(replay.proposal).toEqual({ kind: "none", reason: "replayed" });
    expect(replay.state).toEqual(state);
    const old = reduceMonitorPolicy(state, input(4, { modelDecisionCount: 3, guiActionCount: 0 }, candidate()));
    expect(old.proposal).toEqual({ kind: "none", reason: "out_of_order" });
    expect(old.state).toEqual(state);

    const partition = reduceMonitorPolicy(state, input(6, { modelDecisionCount: 1, guiActionCount: 0 }, candidate(), { partitionKey: "session-b|viewport-800x600" }));
    expect(partition.state.guidanceCount).toBe(0);
    expect(partition.proposal).toEqual({ kind: "none", reason: "candidate_observed" });
    const nextRun = reduceMonitorPolicy(partition.state, input(1, { modelDecisionCount: 0, guiActionCount: 0 }, candidate(), { runId: "monitor-policy-next" as RunId }));
    expect(nextRun.state.runId).toBe("monitor-policy-next");
    expect(nextRun.state.lastSequence).toBe(1);
  });

  it("serializes only the bounded policy proposal shape", () => {
    const state = createMonitorPolicyState({ mode: "guidance" });
    const result = reduceMonitorPolicy(state, input(1, { modelDecisionCount: 1, guiActionCount: 0 }, candidate()));
    expect(serializeMonitorProposal(result.proposal)).toEqual({ kind: "none", reason: "candidate_observed" });
  });
});
