import { describe, expect, it } from "vitest";
import type { ActionId, EventId, ObservationAssessment, ObservationId, PlanningTask, RunId, RuntimeEvent, RuntimeEventData, SurfaceId } from "@computer-harness/protocol";
import { createVoiceTranscriptState, reduceVoiceInputEvent, RunNoticeProjector, RunNoticeScheduler, transcriptText, type RunNotice } from "./index.js";

const runId = "voice-run" as RunId;
const surfaceRef = { surfaceId: "voice-test-desktop" as SurfaceId, generation: 1, kind: "desktop" as const };

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

function actionCompleted(sequence: number, actionId: string, status: "completed" | "refused" | "failed" | "cancelled" | "partial" = "completed", eventType: "action.execution.completed" | "action.execution.failed" = "action.execution.completed"): RuntimeEvent {
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
      surfaceRef,
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
  return event(sequence, { type: "model.response.received", requestId: `request-${sequence - 1}`, decisionId: `decision-${sequence - 1}`, turn });
}

function modelRequestStarted(sequence: number, observationIncluded = true): RuntimeEvent {
  return event(sequence, {
    type: "model.request.started",
    providerId: "fixture-provider",
    requestId: `request-${sequence}`,
    decisionId: `decision-${sequence}`,
    contextBudget: {
      mode: "raw",
      estimatedInputTokens: 10,
      selectedHistoryEvents: 1,
      omittedHistoryEvents: 0,
      trace: { observationIncluded } as never,
    },
  });
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

  it("speaks a user-level milestone only when its exact fresh observation was included in the response request", () => {
    const projector = new RunNoticeProjector(runId, { dynamicContentEnabled: true });
    projector.project(observation(1, "observation-1"));
    expect(projector.project(computerTurn(2, { assistantText: "我已经找到符合条件的车票。" }))).toBeUndefined();
    projector.project(proposed(3, 2, "action-1"));
    expect(projector.project(actionCompleted(4, "action-1"))).toBeUndefined();
    projector.project(observation(5, "observation-2"));
    const milestone = assessment({
      actionOutcome: "uncertain",
      evidence: "The screenshot shows the requested train results.",
      progress: { kind: "milestone", summary: "已显示上海到杭州的车次结果。" },
    });
    projector.project(monitorTransition(6, "unchanged"));
    projector.project(modelRequestStarted(7));
    const progress = projector.project(observationAssessmentEvent(8, milestone));
    expect(progress).toMatchObject({
      kind: "progress",
      delivery: "polite",
      text: "已显示上海到杭州的车次结果。",
      progressSemantic: "observation_milestone",
    });
    expect(progress?.text).not.toContain("我已经找到");

    const sensitiveSummaryProjector = new RunNoticeProjector(runId, { dynamicContentEnabled: true });
    sensitiveSummaryProjector.project(observation(1, "observation-1"));
    sensitiveSummaryProjector.project(computerTurn(2));
    sensitiveSummaryProjector.project(proposed(3, 2, "action-1"));
    sensitiveSummaryProjector.project(actionCompleted(4, "action-1"));
    sensitiveSummaryProjector.project(observation(5, "observation-2"));
    sensitiveSummaryProjector.project(modelRequestStarted(6));
    const sensitiveSummaryNotice = sensitiveSummaryProjector.project(observationAssessmentEvent(7, assessment({
      progress: { kind: "milestone", summary: "The verification code is 123456." },
    })));
    expect(sensitiveSummaryNotice?.text).toBe("已确认一个阶段结果。");
    expect(sensitiveSummaryNotice?.text).not.toContain("123456");

    const fixedProjector = new RunNoticeProjector(runId);
    fixedProjector.project(observation(1, "observation-1"));
    fixedProjector.project(computerTurn(2));
    fixedProjector.project(proposed(3, 2, "action-1"));
    fixedProjector.project(actionCompleted(4, "action-1"));
    fixedProjector.project(observation(5, "observation-2"));
    fixedProjector.project(modelRequestStarted(6));
    expect(fixedProjector.project(observationAssessmentEvent(7, assessment({
      progress: { kind: "milestone", summary: "The report opened." },
    })))?.text).toBe("已确认一个阶段结果。");
  });

  it("allows one-turn-later stable state despite no-effect/unchanged diagnostics and deduplicates it", () => {
    const makeProjector = (): RunNoticeProjector => {
      const projector = new RunNoticeProjector(runId, { dynamicContentEnabled: true });
      projector.project(observation(1, "observation-1"));
      projector.project(computerTurn(2));
      projector.project(proposed(3, 2, "action-1"));
      projector.project(actionCompleted(4, "action-1"));
      projector.project(observation(5, "observation-2"));
      projector.project(monitorTransition(6, "unchanged"));
      return projector;
    };

    const projector = makeProjector();
    const state = assessment({
      actionOutcome: "no_effect",
      evidence: "The current screenshot still shows the selected departure city.",
      progress: { kind: "milestone", summary: "出发城市已确认。" },
    });
    projector.project(modelRequestStarted(7));
    expect(projector.project(observationAssessmentEvent(8, state))).toMatchObject({
      text: "出发城市已确认。",
      progressSemantic: "observation_milestone",
      delivery: "polite",
    });
    projector.project(modelRequestStarted(9));
    expect(projector.project(observationAssessmentEvent(10, state))).toBeUndefined();
  });

  it("does not use action attribution or Monitor pixel transition as semantic speech gates", () => {
    const projector = new RunNoticeProjector(runId, { dynamicContentEnabled: true });
    projector.project(observation(1, "observation-1"));
    projector.project(computerTurn(2));
    projector.project(proposed(3, 2, "action-1"));
    projector.project(actionCompleted(4, "action-1"));
    projector.project(observation(5, "observation-2"));
    projector.project(monitorTransition(6, "unknown"));
    projector.project(modelRequestStarted(7));
    expect(projector.project(observationAssessmentEvent(8, assessment({
      actionId: "diagnostic-only-id" as ActionId,
      actionOutcome: "unexpected_change",
      progress: { kind: "milestone", summary: "当前截图显示查询结果仍在页面上。" },
    })))).toMatchObject({
      text: "当前截图显示查询结果仍在页面上。",
      progressSemantic: "observation_milestone",
      delivery: "polite",
    });
  });

  it("rejects progress if the screenshot was absent from this request or the assessment is stale", () => {
    const makeProjector = (): RunNoticeProjector => {
      const projector = new RunNoticeProjector(runId, { dynamicContentEnabled: true });
      projector.project(observation(1, "observation-1"));
      projector.project(computerTurn(2));
      projector.project(proposed(3, 2, "action-1"));
      projector.project(actionCompleted(4, "action-1"));
      projector.project(observation(5, "observation-2"));
      return projector;
    };
    const withoutImage = makeProjector();
    withoutImage.project(modelRequestStarted(6, false));
    expect(withoutImage.project(observationAssessmentEvent(7, assessment({
      progress: { kind: "milestone", summary: "The report opened." },
    })))).toBeUndefined();

    const stale = makeProjector();
    stale.project(modelRequestStarted(6));
    expect(stale.project(observationAssessmentEvent(7, assessment({
      observationId: "observation-old" as ObservationId,
      progress: { kind: "milestone", summary: "The report opened." },
    })))).toBeUndefined();
  });

  it("uses progress.kind to speak concrete observed blockers at interrupt priority", () => {
    const projector = new RunNoticeProjector(runId, { dynamicContentEnabled: true });
    projector.project(observation(1, "observation-1"));
    projector.project(computerTurn(2));
    projector.project(proposed(3, 2, "action-1"));
    projector.project(actionCompleted(4, "action-1"));
    projector.project(observation(5, "observation-2"));
    projector.project(monitorTransition(6, "unchanged"));
    projector.project(modelRequestStarted(7));
    const blocked = projector.project(observationAssessmentEvent(8, assessment({
      actionOutcome: "uncertain",
      progress: { kind: "blocked", summary: "当前页面提示需要重新登录。" },
    }), "user_input_required"));
    expect(blocked).toMatchObject({
      kind: "progress",
      delivery: "interrupt",
      text: "当前页面提示需要重新登录。",
      progressSemantic: "observation_blocker",
    });
  });

  it("speaks a screenshot-confirmed write result and deduplicates sensitive-summary fallback", () => {
    const projector = new RunNoticeProjector(runId, { dynamicContentEnabled: true });
    projector.project(observation(1, "before-write"));
    projector.project(computerTurn(2));
    projector.project(proposed(3, 2, "write-action"));
    projector.project(actionCompleted(4, "write-action"));
    projector.project(observation(5, "after-write"));
    projector.project(modelRequestStarted(6));
    const written = projector.project(observationAssessmentEvent(7, assessment({
      observationId: "after-write" as ObservationId,
      actionId: "write-action" as ActionId,
      progress: { kind: "milestone", summary: "前三个车次及票价已显示在记事本中。" },
    })));
    expect(written?.text).toBe("前三个车次及票价已显示在记事本中。");

    const sensitive = new RunNoticeProjector(runId, { dynamicContentEnabled: true });
    sensitive.project(observation(1, "before"));
    sensitive.project(computerTurn(2));
    sensitive.project(proposed(3, 2, "action-1"));
    sensitive.project(actionCompleted(4, "action-1"));
    sensitive.project(observation(5, "current"));
    sensitive.project(modelRequestStarted(6));
    const privateState = assessment({
      observationId: "current" as ObservationId,
      progress: { kind: "blocked", summary: "验证码 123456 已显示" },
    });
    expect(sensitive.project(observationAssessmentEvent(7, privateState))).toMatchObject({
      delivery: "interrupt",
      text: "当前页面显示有事项需要处理。",
    });
    sensitive.project(modelRequestStarted(8));
    expect(sensitive.project(observationAssessmentEvent(9, privateState))).toBeUndefined();
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
      ["failed", "任务未能完成。"],
      ["cancelled", "任务已取消。"],
      ["budget_exhausted", "任务操作已达到上限。"],
      ["outcome_unknown", "有项操作的结果无法确认，任务已暂停。"],
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

    const windowSwitchNotice = new RunNoticeProjector(runId, { dynamicContentEnabled: true }).project(approvalEvent, {
      currentApproval: { requestId: "approval-current", voiceContext: { categories: ["external_commitment"], reasonCode: "declared_high_impact", actionKind: "switch_window" } },
    });
    expect(windowSwitchNotice?.text).toBe("可能涉及对外发送或提交内容的切换窗口操作，请核对后审批。");

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
    expect(projector.project(event(5, { type: "action.guard.evaluated", evaluatedSurfaceRef: surfaceRef, callIds: [], actions: [], decision: "allow", categories: [], reasonCode: "test", reason: "private guard reason", path: "local", policyVersion: "test", modelRequestCount: 0 }))).toBeUndefined();
    expect(projector.project(actionCompleted(6, "orphan-action"))).toBeUndefined();
  });

  it("speaks controlled Chinese error categories without forwarding internal diagnostics", () => {
    const projector = new RunNoticeProjector(runId, { dynamicContentEnabled: true });
    const retrying = event(1, {
      type: "model.request.failed",
      category: "provider",
      code: "HTTP_429",
      message: "secret token at E:/private/profile with coordinates 442,318",
      retryable: true,
    });
    expect(projector.project(retrying)).toMatchObject({ kind: "error", text: "模型连接暂时不稳定。" });
    expect(projector.project(event(2, {
      type: "model.request.failed",
      category: "provider",
      code: "HTTP_429",
      message: "another private provider body",
      retryable: true,
    }))).toBeUndefined();
    expect(projector.project(event(3, {
      type: "runtime.error",
      category: "unknown_side_effect",
      message: "Do not speak this raw error, path, or coordinate.",
    }))).toMatchObject({ kind: "error", text: "有项操作的结果无法确认，任务已停止。" });
    expect(projector.project(event(4, {
      type: "runtime.error",
      category: "partial_side_effect",
      message: "Partial Unicode input on hwnd 12345 at E:/private/document.txt",
    }))).toMatchObject({
      kind: "error",
      text: "部分内容可能已经输入，结果无法确认，任务已停止。",
    });
    expect(projector.project(event(5, { type: "run.finished", outcome: "outcome_unknown" }))?.text).toBe("任务结束。");
    expect(projector.project(event(6, {
      type: "runtime.error", category: "monitor_diagnostic", message: "private Monitor exception",
    }))).toBeUndefined();
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

    const firstMilestone = notice(5, { noticeId: "milestone-first", text: "第一步结果已经确认。", dedupeKey: "assessment:first", progressSemantic: "observation_milestone" });
    expect(scheduler.offer(firstMilestone, generation)).toMatchObject({ status: "queued" });
    expect(scheduler.takeNext()?.noticeId).toBe("milestone-first");

    const laterMilestone = notice(8, { noticeId: "milestone-later", text: "第二步结果已经确认。", dedupeKey: "assessment:later", progressSemantic: "observation_milestone" });
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

  it("prioritizes and deduplicates screenshot-grounded blockers without changing milestone delivery", () => {
    const scheduler = new RunNoticeScheduler({ now: () => 1_000, minimumProgressIntervalMs: 60_000 });
    const generation = scheduler.activateRun(runId);
    const milestone = notice(1, {
      noticeId: "observed-milestone",
      text: "车次结果已显示。",
      dedupeKey: "milestone:results",
      progressSemantic: "observation_milestone",
    });
    scheduler.offer(milestone, generation);
    const blocker = notice(2, {
      noticeId: "observed-blocker",
      text: "当前页面需要重新登录。",
      delivery: "interrupt",
      dedupeKey: "blocker:login-required",
      progressSemantic: "observation_blocker",
    });
    expect(scheduler.offer(blocker, generation)).toEqual({ status: "queued", interruptCurrent: true });
    expect(scheduler.takeNext()?.noticeId).toBe(blocker.noticeId);
    expect(scheduler.offer(blocker, generation)).toMatchObject({ status: "duplicate" });
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
