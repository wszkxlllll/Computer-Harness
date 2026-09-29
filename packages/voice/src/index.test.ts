import { describe, expect, it } from "vitest";
import type { ActionId, EventId, ObservationAssessment, ObservationId, PlanningTask, RunId, RuntimeEvent, RuntimeEventData } from "@computer-harness/protocol";
import { createVoiceTranscriptState, reduceVoiceInputEvent, RunNoticeProjector, RunNoticeScheduler, transcriptText, type RunNotice } from "./index.js";

const runId = "voice-run" as RunId;

function event(sequence: number, data: RuntimeEventData, currentRunId = runId): RuntimeEvent {
  return {
    eventId: `event-${sequence}` as EventId,
    runId: currentRunId,
    sequence,
    occurredAt: "2026-09-29T00:00:00.000Z",
    ...data,
  } as RuntimeEvent;
}

function computerTurn(sequence: number, options: { assistantText?: string; summary?: string } = {}): RuntimeEvent {
  return event(sequence, {
    type: "model.response.received",
    turn: {
      type: "tool_calls",
      calls: [{
        id: `call-${sequence}` as never,
        name: "click",
        arguments: { x: 10, y: 20 },
        ...(options.summary === undefined ? {} : { declaredEffect: { effects: ["navigate"], target: "Results", summary: options.summary } }),
      }],
      ...(options.assistantText === undefined ? {} : { assistantText: options.assistantText }),
    },
  });
}

function proposed(sequence: number, callSequence: number, actionId: string): RuntimeEvent {
  return event(sequence, {
    type: "action.proposed",
    callId: `call-${callSequence}` as never,
    action: {
      actionId: actionId as ActionId,
      basedOn: "observation-1" as never,
      kind: "click",
      point: { x: 10, y: 20 },
    },
  });
}

function actionCompleted(sequence: number, actionId: string, status: "completed" | "refused" | "failed" | "cancelled" = "completed", eventType: "action.execution.completed" | "action.execution.failed" = "action.execution.completed"): RuntimeEvent {
  return event(sequence, {
    type: eventType,
    receipt: { actionId: actionId as ActionId, status },
  });
}

function observation(sequence: number, id: string): RuntimeEvent {
  return event(sequence, {
    type: "observation.created",
    observation: {
      id: id as ObservationId,
      runId,
      computerSessionId: "voice-session" as never,
      capturedAt: "2026-09-29T00:00:00.000Z",
      viewport: { width: 800, height: 600, coordinateSpace: "physical" },
      screenshot: { assetId: `asset-${id}` as never, relativePath: `screenshots/${id}.png`, mediaType: "image/png", byteLength: 1 },
    },
  });
}

function observationAssessmentEvent(sequence: number, assessment: ObservationAssessment, turnType: "tool_calls" | "finish" | "user_input_required" = "tool_calls"): RuntimeEvent {
  const observationAssessment = assessment;
  const turn = turnType === "tool_calls"
    ? { type: "tool_calls" as const, calls: [{ id: `next-${sequence}` as never, name: "click", arguments: { x: 12, y: 24 } }], observationAssessment }
    : turnType === "finish"
      ? { type: "finish" as const, summary: "finished", observationAssessment }
      : { type: "user_input_required" as const, question: "Continue?", observationAssessment };
  return event(sequence, { type: "model.response.received", turn });
}

function assessment(overrides: Partial<ObservationAssessment> = {}): ObservationAssessment {
  return {
    observationId: "observation-2" as ObservationId,
    actionId: "action-1" as ActionId,
    actionOutcome: "expected_change",
    evidence: "The visible result list is open.",
    ...overrides,
  };
}

function monitorTransition(
  sequence: number,
  transition: "changed" | "unchanged" | "unknown",
  sourceActionEventId: EventId = "event-4" as EventId,
  sourceObservationEventId: EventId = "event-5" as EventId,
): RuntimeEvent {
  return event(sequence, {
    type: "monitor.transition",
    actionId: "action-1" as ActionId,
    postObservationId: "observation-2" as ObservationId,
    sourceActionEventId,
    sourceObservationEventId,
    transition,
  });
}

function task(id: string, status: PlanningTask["status"], subject: string): PlanningTask {
  return { id, status, subject };
}

function notice(sequence: number, overrides: Partial<RunNotice> = {}): RunNotice {
  return {
    noticeId: `notice-${sequence}`,
    runId,
    eventId: `event-${sequence}` as EventId,
    eventSequence: sequence,
    kind: "progress",
    text: `正在处理第 ${sequence} 阶段。`,
    delivery: "polite",
    dedupeKey: `progress-${sequence}`,
    ...overrides,
  };
}

function pendingId(noticeValue: RunNotice): string {
  if (noticeValue.pendingRequestId === undefined) throw new Error("expected a pending request id");
  return noticeValue.pendingRequestId;
}

describe("voice input and transcript contracts", () => {
  it("keeps recording after a segment finalizes and applies newer segment revisions", () => {
    let state = createVoiceTranscriptState("capture-1");
    state = reduceVoiceInputEvent(state, { type: "state_changed", sessionId: "capture-1", state: "recording" });
    state = reduceVoiceInputEvent(state, {
      type: "transcript_updated",
      sessionId: "capture-1",
      segment: { segmentId: "s1", index: 0, revision: 0, text: "上海到杭州", state: "partial" },
    });
    state = reduceVoiceInputEvent(state, {
      type: "transcript_updated",
      sessionId: "capture-1",
      segment: { segmentId: "s1", index: 0, revision: 1, text: "上海到杭州，", state: "final" },
    });
    expect(state.status).toBe("recording");
    state = reduceVoiceInputEvent(state, {
      type: "transcript_updated",
      sessionId: "capture-1",
      segment: { segmentId: "s2", index: 1, revision: 0, text: "明天下午", state: "partial" },
    });
    state = reduceVoiceInputEvent(state, {
      type: "transcript_updated",
      sessionId: "capture-1",
      segment: { segmentId: "s2", index: 1, revision: 1, text: "周五下午", state: "partial" },
    });
    expect(transcriptText(state)).toBe("上海到杭州，周五下午");
    expect(state.segments.map((segment) => segment.revision)).toEqual([1, 1]);
  });

  it("does not downgrade a finalized segment and accepts fast stop during startup", () => {
    let state = createVoiceTranscriptState("capture-fast-stop");
    state = reduceVoiceInputEvent(state, { type: "state_changed", sessionId: "capture-fast-stop", state: "finalizing" });
    expect(state.status).toBe("finalizing");
    state = reduceVoiceInputEvent(state, { type: "state_changed", sessionId: "capture-fast-stop", state: "finished" });
    expect(state.status).toBe("finished");

    let recording = createVoiceTranscriptState("capture-final");
    recording = reduceVoiceInputEvent(recording, { type: "state_changed", sessionId: "capture-final", state: "recording" });
    recording = reduceVoiceInputEvent(recording, {
      type: "transcript_updated", sessionId: "capture-final",
      segment: { segmentId: "s1", index: 0, revision: 1, text: "已经确定", state: "final" },
    });
    const finalized = recording;
    recording = reduceVoiceInputEvent(recording, {
      type: "transcript_updated", sessionId: "capture-final",
      segment: { segmentId: "s1", index: 0, revision: 2, text: "partial downgrade", state: "partial" },
    });
    expect(recording).toBe(finalized);
  });

  it("ignores old revisions and events from stale or terminal sessions", () => {
    let state = createVoiceTranscriptState("capture-current");
    state = reduceVoiceInputEvent(state, { type: "state_changed", sessionId: "capture-current", state: "recording" });
    state = reduceVoiceInputEvent(state, {
      type: "transcript_updated",
      sessionId: "capture-current",
      segment: { segmentId: "s1", index: 0, revision: 2, text: "corrected", state: "final" },
    });
    const beforeOldRevision = state;
    state = reduceVoiceInputEvent(state, {
      type: "transcript_updated",
      sessionId: "capture-current",
      segment: { segmentId: "s1", index: 0, revision: 1, text: "stale", state: "partial" },
    });
    expect(state).toBe(beforeOldRevision);
    state = reduceVoiceInputEvent(state, {
      type: "transcript_updated",
      sessionId: "capture-old",
      segment: { segmentId: "s2", index: 1, revision: 0, text: "old run", state: "final" },
    });
    expect(state).toBe(beforeOldRevision);
    state = reduceVoiceInputEvent(state, { type: "state_changed", sessionId: "capture-current", state: "finalizing" });
    state = reduceVoiceInputEvent(state, { type: "state_changed", sessionId: "capture-current", state: "finished" });
    const finished = state;
    state = reduceVoiceInputEvent(state, {
      type: "transcript_updated",
      sessionId: "capture-current",
      segment: { segmentId: "s1", index: 0, revision: 3, text: "after finish", state: "final" },
    });
    expect(state).toBe(finished);
  });
});

describe("RuntimeEvent to RunNotice projection", () => {
  it("projects one fixed polite task-start notice per Run and none after terminal", () => {
    const projector = new RunNoticeProjector(runId, { dynamicContentEnabled: true });
    const created = event(1, { type: "run.created", goal: "private user goal" });
    const start = projector.project(created);
    expect(start).toMatchObject({ kind: "progress", delivery: "polite", text: "任务已开始。", progressSemantic: "run_start" });
    expect(start?.text).not.toContain("private user goal");
    expect(projector.project(created)).toBeUndefined();
    expect(projector.project(event(2, { type: "run.created", goal: "duplicate synthetic event" }))).toBeUndefined();
    expect(projector.project(event(3, { type: "run.finished", outcome: "succeeded", summary: "done" }))).toMatchObject({ kind: "result" });
    expect(projector.project(event(4, { type: "run.created", goal: "late event" }))).toBeUndefined();
  });

  it("does not announce ordinary successful GUI action completion", () => {
    const projector = new RunNoticeProjector(runId, { dynamicContentEnabled: true });
    expect(projector.project(computerTurn(1, { assistantText: "打开搜索结果", summary: "查看搜索结果" }))).toBeUndefined();
    expect(projector.project(proposed(2, 1, "action-1"))).toBeUndefined();
    expect(projector.project(actionCompleted(3, "action-1"))).toBeUndefined();

    expect(projector.project(computerTurn(4, { summary: "查看搜索结果" }))).toBeUndefined();
    expect(projector.project(proposed(5, 4, "action-2"))).toBeUndefined();
    expect(projector.project(actionCompleted(6, "action-2"))).toBeUndefined();
  });

  it("speaks a validated milestone summary only after its action and observation checks", () => {
    const projector = new RunNoticeProjector(runId, { dynamicContentEnabled: true });
    projector.project(observation(1, "observation-1"));
    projector.project(computerTurn(2));
    projector.project(proposed(3, 2, "action-1"));
    expect(projector.project(actionCompleted(4, "action-1"))).toBeUndefined();
    projector.project(observation(5, "observation-2"));

    const milestone = assessment({
      evidence: "A private verification code 123456 is visible in the model summary.",
      progress: { kind: "milestone", summary: "Search results page is open." },
    });
    // Monitor-off runs have no deterministic transition, so the model annotation stays silent.
    expect(projector.project(observationAssessmentEvent(6, milestone))).toBeUndefined();
    projector.project(monitorTransition(7, "changed"));
    const progress = projector.project(observationAssessmentEvent(8, milestone));
    expect(progress).toMatchObject({ kind: "progress", delivery: "polite", text: "Search results page is open.", progressSemantic: "verified_milestone" });
    expect(progress?.text).not.toContain("123456");

    const sensitiveSummaryProjector = new RunNoticeProjector(runId, { dynamicContentEnabled: true });
    sensitiveSummaryProjector.project(observation(1, "observation-1"));
    sensitiveSummaryProjector.project(computerTurn(2));
    sensitiveSummaryProjector.project(proposed(3, 2, "action-1"));
    sensitiveSummaryProjector.project(actionCompleted(4, "action-1"));
    sensitiveSummaryProjector.project(observation(5, "observation-2"));
    sensitiveSummaryProjector.project(monitorTransition(6, "changed"));
    const sensitiveSummaryNotice = sensitiveSummaryProjector.project(observationAssessmentEvent(7, assessment({
      progress: { kind: "milestone", summary: "The verification code is 123456." },
    })));
    expect(sensitiveSummaryNotice?.text).toBe("已确认一项进展，任务继续中。");
    expect(sensitiveSummaryNotice?.text).not.toContain("123456");

    const fixedProjector = new RunNoticeProjector(runId);
    fixedProjector.project(observation(1, "observation-1"));
    fixedProjector.project(computerTurn(2));
    fixedProjector.project(proposed(3, 2, "action-1"));
    fixedProjector.project(actionCompleted(4, "action-1"));
    fixedProjector.project(observation(5, "observation-2"));
    fixedProjector.project(monitorTransition(6, "changed"));
    expect(fixedProjector.project(observationAssessmentEvent(7, assessment({
      progress: { kind: "milestone", summary: "The report opened." },
    })))?.text).toBe("已确认一项进展，任务继续中。");
  });

  it("rejects stale observation/action bindings and semantic conflicts", () => {
    const makeProjector = (): RunNoticeProjector => {
      const projector = new RunNoticeProjector(runId);
      projector.project(observation(1, "observation-1"));
      projector.project(computerTurn(2));
      projector.project(proposed(3, 2, "action-1"));
      projector.project(actionCompleted(4, "action-1"));
      projector.project(observation(5, "observation-2"));
      return projector;
    };

    expect(makeProjector().project(observationAssessmentEvent(6, assessment({ observationId: "observation-old" as ObservationId, progress: { kind: "milestone", summary: "stale" } })))).toBeUndefined();
    expect(makeProjector().project(observationAssessmentEvent(6, assessment({ actionId: "action-old" as ActionId, progress: { kind: "milestone", summary: "stale" } })))).toBeUndefined();

    const conflicting = makeProjector();
    conflicting.project(monitorTransition(6, "unchanged"));
    expect(conflicting.project(observationAssessmentEvent(7, assessment({ progress: { kind: "milestone", summary: "unchanged screen" } })))).toBeUndefined();

    const unknown = makeProjector();
    unknown.project(monitorTransition(6, "unknown"));
    expect(unknown.project(observationAssessmentEvent(7, assessment({ progress: { kind: "milestone", summary: "unconfirmed change" } })))).toBeUndefined();
  });

  it("rejects Monitor transitions sourced from a different receipt or observation event", () => {
    const makeProjector = (): RunNoticeProjector => {
      const projector = new RunNoticeProjector(runId, { dynamicContentEnabled: true });
      projector.project(observation(1, "observation-1"));
      projector.project(computerTurn(2));
      projector.project(proposed(3, 2, "action-1"));
      projector.project(actionCompleted(4, "action-1"));
      projector.project(observation(5, "observation-2"));
      return projector;
    };
    const milestone = observationAssessmentEvent(7, assessment({
      progress: { kind: "milestone", summary: "The report opened." },
    }));

    const wrongReceipt = makeProjector();
    wrongReceipt.project(monitorTransition(6, "changed", "event-other-receipt" as EventId, "event-5" as EventId));
    expect(wrongReceipt.project(milestone)).toBeUndefined();

    const wrongObservation = makeProjector();
    wrongObservation.project(monitorTransition(6, "changed", "event-4" as EventId, "event-other-observation" as EventId));
    expect(wrongObservation.project(milestone)).toBeUndefined();
  });

  it("never speaks Monitor conclusions and only voices an expected-change milestone", () => {
    const projector = new RunNoticeProjector(runId);
    projector.project(observation(1, "observation-1"));
    projector.project(computerTurn(2));
    projector.project(proposed(3, 2, "action-1"));
    projector.project(actionCompleted(4, "action-1"));
    projector.project(observation(5, "observation-2"));
    projector.project(monitorTransition(6, "unchanged"));
    const unchangedBlocked = projector.project(observationAssessmentEvent(7, assessment({
      actionOutcome: "no_effect",
      progress: { kind: "blocked", summary: "The page did not change" },
    }), "user_input_required"));
    expect(unchangedBlocked).toBeUndefined();

    const unknownProjector = new RunNoticeProjector(runId);
    unknownProjector.project(observation(1, "observation-1"));
    unknownProjector.project(computerTurn(2));
    unknownProjector.project(proposed(3, 2, "action-1"));
    unknownProjector.project(actionCompleted(4, "action-1"));
    unknownProjector.project(observation(5, "observation-2"));
    unknownProjector.project(monitorTransition(6, "unknown"));
    expect(unknownProjector.project(observationAssessmentEvent(7, assessment({
      actionOutcome: "uncertain",
      progress: { kind: "blocked", summary: "The comparison is uncertain" },
    })))).toBeUndefined();

    const changedProjector = new RunNoticeProjector(runId);
    changedProjector.project(observation(1, "observation-1"));
    changedProjector.project(computerTurn(2));
    changedProjector.project(proposed(3, 2, "action-1"));
    changedProjector.project(actionCompleted(4, "action-1"));
    changedProjector.project(observation(5, "observation-2"));
    changedProjector.project(monitorTransition(6, "changed"));
    expect(changedProjector.project(observationAssessmentEvent(7, assessment({
      actionOutcome: "unexpected_change",
      progress: { kind: "blocked", summary: "The unexpected page is not the target" },
    })))).toBeUndefined();

    const unexpectedMilestoneProjector = new RunNoticeProjector(runId);
    unexpectedMilestoneProjector.project(observation(1, "observation-1"));
    unexpectedMilestoneProjector.project(computerTurn(2));
    unexpectedMilestoneProjector.project(proposed(3, 2, "action-1"));
    unexpectedMilestoneProjector.project(actionCompleted(4, "action-1"));
    unexpectedMilestoneProjector.project(observation(5, "observation-2"));
    unexpectedMilestoneProjector.project(monitorTransition(6, "changed"));
    expect(unexpectedMilestoneProjector.project(observationAssessmentEvent(7, assessment({
      actionOutcome: "unexpected_change",
      progress: { kind: "milestone", summary: "The screen changed unexpectedly" },
    })))).toBeUndefined();
  });

  it("uses the current task map when another task becomes pending or completes", () => {
    const projector = new RunNoticeProjector(runId, { dynamicContentEnabled: true });
    const phase = projector.project(event(1, {
      type: "planning.task.updated", callId: "plan-call-1" as never,
      mutation: { operation: "created", task: task("t1", "in_progress", "查询出发日期可用车次") },
    }));
    expect(phase?.text).toBe("查询出发日期可用车次");
    expect(phase?.text).not.toContain("已完成");
    expect(projector.project(event(2, {
      type: "planning.task.updated", callId: "plan-call-2" as never,
      mutation: { operation: "created", task: task("t2", "pending", "比较到达后的公交路线") },
    }))).toBeUndefined();
    expect(projector.project(event(3, {
      type: "planning.task.updated", callId: "plan-call-3" as never,
      mutation: { operation: "updated", task: task("t2", "completed", "比较到达后的公交路线") },
    }))).toBeUndefined();
    expect(projector.project(computerTurn(4))).toBeUndefined();
    expect(projector.project(proposed(5, 4, "action-plan"))).toBeUndefined();
    expect(projector.project(actionCompleted(6, "action-plan"))).toBeUndefined();
  });

  it("does not announce unexecuted, rejected, refused, failed, or cancelled actions", () => {
    const projector = new RunNoticeProjector(runId, { dynamicContentEnabled: true });
    expect(projector.project(computerTurn(1, { summary: "打开搜索结果" }))).toBeUndefined();
    expect(projector.project(event(2, { type: "tool.call.rejected", callId: "call-1" as never, reason: "policy" }))).toBeUndefined();

    expect(projector.project(computerTurn(3, { summary: "查看车次" }))).toBeUndefined();
    expect(projector.project(proposed(4, 3, "refused-action"))).toBeUndefined();
    expect(projector.project(actionCompleted(5, "refused-action", "refused"))).toBeUndefined();

    expect(projector.project(computerTurn(6, { summary: "展开详情" }))).toBeUndefined();
    expect(projector.project(proposed(7, 6, "failed-action"))).toBeUndefined();
    expect(projector.project(actionCompleted(8, "failed-action", "failed", "action.execution.failed"))).toBeUndefined();

    expect(projector.project(computerTurn(9, { summary: "选择日期" }))).toBeUndefined();
    expect(projector.project(proposed(10, 9, "success-action"))).toBeUndefined();
    expect(projector.project(actionCompleted(11, "success-action"))).toBeUndefined();
  });

  it("emits direct question and final text when safe, with natural fixed fallbacks", () => {
    const fixedProjector = new RunNoticeProjector(runId);
    const dynamicProjector = new RunNoticeProjector(runId, { dynamicContentEnabled: true });
    const question = event(1, { type: "user.input.requested", question: "请选择上海还是杭州？" });
    const fixedQuestion = fixedProjector.project(question);
    const dynamicQuestion = dynamicProjector.project(question);
    expect(fixedQuestion?.text).toBe("我有个问题需要你回答，请查看任务。");
    expect(dynamicQuestion?.text).toBe("请选择上海还是杭州？");
    expect(fixedQuestion).toBeDefined();
    expect(dynamicQuestion).toBeDefined();

    const sensitive = event(2, { type: "user.input.requested", question: "请确认验证码 123456" });
    expect(new RunNoticeProjector(runId, { dynamicContentEnabled: true }).project(sensitive)?.text)
      .toBe("我有个问题需要你回答，请查看任务。");

    const final = event(3, { type: "run.finished", outcome: "succeeded", summary: "整理了两种车次方案。" });
    expect(fixedProjector.project(final)?.text).toBe("任务已完成，可查看结果。");
    expect(dynamicProjector.project(final)?.text).toBe("整理了两种车次方案。");
    expect(dynamicProjector.project(event(4, { type: "runtime.error", category: "late", message: "late" }))).toBeUndefined();

    const unsuccessfulOutcomes = [
      ["failed", "任务未能完成，请查看详情。"],
      ["cancelled", "任务已取消。"],
      ["budget_exhausted", "任务达到执行上限，可查看进度。"],
      ["outcome_unknown", "有项操作结果未确认，请查看任务。"],
    ] as const;
    for (const [outcome, fallback] of unsuccessfulOutcomes) {
      expect(new RunNoticeProjector(runId, { dynamicContentEnabled: true }).project(event(1, {
        type: "run.finished",
        outcome,
        summary: "任务已完成并成功提交。",
      }))?.text).toBe(fallback);
    }
  });

  it("uses request-bound Guard categories instead of raw approval reasons", () => {
    const approvalEvent = event(1, {
      type: "approval.requested", requestId: "approval-current", callId: "call-1" as never,
      reason: "This English reason must never be spoken.",
    });
    const projector = new RunNoticeProjector(runId, { dynamicContentEnabled: true });
    expect(projector.project(approvalEvent, {
      currentApproval: { requestId: "approval-expired", voiceContext: { categories: ["external_commitment"], reasonCode: "declared_high_impact", actionKind: "click" } },
    })).toMatchObject({ text: "有项操作需要审批，请核对后处理。", kind: "approval" });

    const currentProjector = new RunNoticeProjector(runId, { dynamicContentEnabled: true });
    const currentNotice = currentProjector.project(approvalEvent, {
      currentApproval: { requestId: "approval-current", voiceContext: { categories: ["external_commitment"], reasonCode: "declared_high_impact", actionKind: "click" } },
    });
    expect(currentNotice?.text).toBe("可能涉及对外发送或提交内容的点击操作，请核对后审批。");
    expect(currentNotice?.text).not.toContain("This English reason");

    const privacy = new RunNoticeProjector(runId, { dynamicContentEnabled: true }).project(approvalEvent, {
      currentApproval: { requestId: "approval-current", voiceContext: { categories: ["privacy_account"], reasonCode: "protected_input", actionKind: "type" } },
    });
    expect(privacy?.text).toBe("可能涉及隐私、账户或凭据的输入操作，请核对后审批。");
  });

  it("speaks finite multi-category Guard context and uses Chinese fallbacks for unknown data", () => {
    const projector = new RunNoticeProjector(runId, { dynamicContentEnabled: true });
    const approvalEvent = event(1, {
      type: "approval.requested", requestId: "approval-long", callId: "call-1" as never, reason: "Pay and publish this immediately.",
    });
    expect(projector.project(approvalEvent, {
      currentApproval: { requestId: "approval-long", voiceContext: { categories: ["financial", "external_commitment"], reasonCode: "declared_high_impact", actionKind: "click" } },
    })?.text).toBe("可能涉及付款或财务操作及对外发送或提交内容的点击操作，请核对后审批。");
    expect(new RunNoticeProjector(runId, { dynamicContentEnabled: true }).project(event(2, {
      type: "approval.requested", requestId: "approval-destructive", callId: "call-2" as never, reason: "Delete the file permanently.",
    }), {
      currentApproval: { requestId: "approval-destructive", voiceContext: { categories: ["destructive"], reasonCode: "declared_high_impact", actionKind: "keypress" } },
    })?.text).toBe("可能涉及删除或不可逆修改内容的键盘操作，请核对后审批。");
    expect(new RunNoticeProjector(runId, { dynamicContentEnabled: true }).project(event(3, {
      type: "approval.requested", requestId: "approval-unknown", callId: "call-3" as never, reason: "Unknown category.",
    }), {
      currentApproval: { requestId: "approval-unknown", voiceContext: { categories: ["new_category" as never], reasonCode: "future_reason", actionKind: "click" } },
    })?.text).toBe("有项操作需要审批，请核对后处理。");
  });

  it("projects attention/terminal states and never projects Guard reasons or ordinary receipts", () => {
    const projector = new RunNoticeProjector(runId);
    expect(projector.project(event(1, {
      type: "approval.requested", requestId: "approval-1", callId: "call-1" as never, reason: "Payment requires approval",
    }))).toMatchObject({ kind: "approval", delivery: "interrupt", text: "有项操作需要审批，请核对后处理。", pendingRequestId: "approval-1" });
    const question = projector.project(event(2, { type: "user.input.requested", question: "请回答" }));
    expect(question).toMatchObject({ kind: "question", delivery: "interrupt" });
    expect(question?.pendingRequestId).toBe("event-2");
    expect(projector.project(event(3, { type: "runtime.error", category: "network", message: "secret token details" }))).toMatchObject({ kind: "error", delivery: "interrupt" });
    expect(projector.project(event(4, { type: "run.finished", outcome: "succeeded", summary: "Never read directly" }))).toMatchObject({ kind: "result", delivery: "interrupt", text: "任务已完成，可查看结果。" });
    expect(projector.project(event(5, { type: "action.guard.evaluated", callIds: [], actions: [], decision: "allow", categories: [], reasonCode: "test", reason: "private guard reason", path: "local", policyVersion: "test", modelRequestCount: 0 }))).toBeUndefined();
    expect(projector.project(actionCompleted(6, "orphan-action"))).toBeUndefined();
  });
});

describe("RunNoticeScheduler", () => {
  it("deduplicates admitted notices and allows the same rate-limited notice to retry", () => {
    let now = 10_000;
    const scheduler = new RunNoticeScheduler({ now: () => now, minimumProgressIntervalMs: 5_000 });
    const generation = scheduler.activateRun(runId);
    const first = notice(1);
    expect(scheduler.offer(first, generation)).toMatchObject({ status: "queued" });
    expect(scheduler.offer(first, generation)).toMatchObject({ status: "duplicate" });
    expect(scheduler.takeNext()?.noticeId).toBe("notice-1");

    const retryable = notice(2, { text: "第二条进度", dedupeKey: "second-progress" });
    expect(scheduler.offer(retryable, generation)).toMatchObject({ status: "rate_limited" });
    expect(scheduler.offer(retryable, generation)).toMatchObject({ status: "rate_limited" });
    now += 5_000;
    expect(scheduler.offer(retryable, generation)).toMatchObject({ status: "queued" });
    expect(scheduler.offer(retryable, generation)).toMatchObject({ status: "duplicate" });
  });

  it("does not let the run-start notice consume the first real progress interval", () => {
    const scheduler = new RunNoticeScheduler({ now: () => 1_000, minimumProgressIntervalMs: 12_000 });
    const generation = scheduler.activateRun(runId);
    const start = notice(0, { noticeId: "run-start", text: "任务已开始。", dedupeKey: "run-start", progressSemantic: "run_start" });
    expect(scheduler.offer(start, generation)).toMatchObject({ status: "queued" });
    expect(scheduler.takeNext()?.noticeId).toBe("run-start");

    const ordinaryPhase = notice(2, { noticeId: "phase-first", text: "正在检查页面。", dedupeKey: "phase:first" });
    expect(scheduler.offer(ordinaryPhase, generation)).toMatchObject({ status: "queued" });
    expect(scheduler.takeNext()?.noticeId).toBe("phase-first");

    const firstMilestone = notice(5, { noticeId: "milestone-first", text: "第一步结果已经确认。", dedupeKey: "assessment:first", progressSemantic: "verified_milestone" });
    expect(scheduler.offer(firstMilestone, generation)).toMatchObject({ status: "queued" });
    expect(scheduler.takeNext()?.noticeId).toBe("milestone-first");

    const laterMilestone = notice(8, { noticeId: "milestone-later", text: "第二步结果已经确认。", dedupeKey: "assessment:later", progressSemantic: "verified_milestone" });
    expect(scheduler.offer(laterMilestone, generation)).toMatchObject({ status: "queued" });
    expect(scheduler.takeNext()?.noticeId).toBe("milestone-later");
    expect(scheduler.offer(notice(9, { text: "再检查一处页面。", dedupeKey: "phase:later" }), generation)).toMatchObject({ status: "rate_limited" });
  });

  it("lets urgent notices bypass progress cooldown and validates pending interaction IDs at dequeue", () => {
    const scheduler = new RunNoticeScheduler({ now: () => 1_000, minimumProgressIntervalMs: 60_000 });
    const generation = scheduler.activateRun(runId);
    const taskStart = notice(0, { noticeId: "run-start", text: "任务已开始。", dedupeKey: "run-start", progressSemantic: "run_start" });
    scheduler.offer(taskStart, generation);
    const approval = notice(2, { kind: "approval", delivery: "interrupt", pendingRequestId: "approval-1", text: "请审批", dedupeKey: "approval-1" });
    expect(scheduler.offer(approval, generation)).toEqual({ status: "queued", interruptCurrent: true });
    const priorityScheduler = new RunNoticeScheduler();
    const priorityGeneration = priorityScheduler.activateRun(runId);
    priorityScheduler.offer(taskStart, priorityGeneration);
    priorityScheduler.offer(approval, priorityGeneration);
    expect(priorityScheduler.takeNext(new Set([pendingId(approval)]))?.noticeId).toBe(approval.noticeId);
    // A resolved/replaced request is omitted from the live snapshot and is never read aloud.
    expect(scheduler.takeNext(new Set())).toBeUndefined();

    const secondScheduler = new RunNoticeScheduler({ now: () => 1_000, minimumProgressIntervalMs: 60_000 });
    const secondGeneration = secondScheduler.activateRun(runId);
    const current = notice(3, { kind: "question", delivery: "interrupt", pendingRequestId: "question-3", text: "请回答", dedupeKey: "question-3" });
    secondScheduler.offer(current, secondGeneration);
    expect(secondScheduler.takeNext(new Set([pendingId(current)]))?.noticeId).toBe(current.noticeId);
  });

  it("drops polite progress on errors but keeps current interactions, while results replace all pending notices", () => {
    const scheduler = new RunNoticeScheduler({ maxQueueSize: 8 });
    const generation = scheduler.activateRun(runId);
    const approval = notice(1, { kind: "approval", delivery: "interrupt", pendingRequestId: "approval-1", dedupeKey: "approval-1" });
    scheduler.offer(approval, generation);
    scheduler.offer(notice(2, { text: "任务已开始。", dedupeKey: "progress-2" }), generation);
    const error = notice(3, { kind: "error", delivery: "interrupt", dedupeKey: "error-3" });
    scheduler.offer(error, generation);
    expect(scheduler.takeNext(new Set([pendingId(approval)]))?.noticeId).toBe(approval.noticeId);
    expect(scheduler.takeNext()?.noticeId).toBe(error.noticeId);

    scheduler.offer(notice(4, { text: "任务已开始。", dedupeKey: "progress-4" }), generation);
    const final = notice(5, { kind: "result", delivery: "interrupt", text: "Run ended", dedupeKey: "result-5" });
    expect(scheduler.offer(final, generation)).toMatchObject({ status: "queued", interruptCurrent: true });
    expect(scheduler.takeNext()?.noticeId).toBe(final.noticeId);
    expect(scheduler.takeNext()).toBeUndefined();
    expect(scheduler.offer(notice(6, { kind: "error", delivery: "interrupt" }), generation)).toMatchObject({ status: "stale" });
  });

  it("does not mark queue-full notices seen, allowing a retry after capacity becomes available", () => {
    const scheduler = new RunNoticeScheduler({ maxQueueSize: 1 });
    const generation = scheduler.activateRun(runId);
    const first = notice(1, { kind: "error", delivery: "interrupt", dedupeKey: "error-1" });
    const retryable = notice(2, { kind: "error", delivery: "interrupt", dedupeKey: "error-2" });
    expect(scheduler.offer(first, generation)).toMatchObject({ status: "queued" });
    expect(scheduler.offer(retryable, generation)).toMatchObject({ status: "queue_full" });
    expect(scheduler.takeNext()?.noticeId).toBe(first.noticeId);
    expect(scheduler.offer(retryable, generation)).toMatchObject({ status: "queued" });
  });

  it("drops late generations, foreign Runs, and out-of-order notices", () => {
    const scheduler = new RunNoticeScheduler();
    const oldGeneration = scheduler.activateRun(runId);
    const newRunId = "voice-run-2" as RunId;
    const newGeneration = scheduler.activateRun(newRunId);
    expect(scheduler.offer(notice(1), oldGeneration)).toMatchObject({ status: "stale" });
    expect(scheduler.offer(notice(2, { runId: newRunId }), newGeneration)).toMatchObject({ status: "queued" });
    expect(scheduler.offer(notice(1, { runId: newRunId }), newGeneration)).toMatchObject({ status: "stale" });
    expect(scheduler.takeNext()?.runId).toBe(newRunId);
    scheduler.clear();
    expect(scheduler.offer(notice(3, { runId: newRunId }), newGeneration)).toMatchObject({ status: "stale" });
  });
});
