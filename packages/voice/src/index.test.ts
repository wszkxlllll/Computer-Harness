import { describe, expect, it } from "vitest";
import type { ActionId, EventId, PlanningTask, RunId, RuntimeEvent, RuntimeEventData } from "@computer-harness/protocol";
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
  it("holds model intent until the matching action completes and then phrases it as an attempt", () => {
    const projector = new RunNoticeProjector(runId, { dynamicContentEnabled: true });
    expect(projector.project(computerTurn(1, { assistantText: "打开搜索结果", summary: "查看搜索结果" }))).toBeUndefined();
    expect(projector.project(proposed(2, 1, "action-1"))).toBeUndefined();
    const completed = projector.project(actionCompleted(3, "action-1"));
    expect(completed).toMatchObject({ kind: "progress", delivery: "polite", text: "已执行本轮模型提出的操作，正在核对页面结果。" });
    expect(completed?.text).not.toContain("已完成");
    expect(completed?.text).not.toContain("打开搜索结果");

    expect(projector.project(computerTurn(4, { summary: "查看搜索结果" }))).toBeUndefined();
    expect(projector.project(proposed(5, 4, "action-2"))).toBeUndefined();
    const summaryFallback = projector.project(actionCompleted(6, "action-2"));
    expect(summaryFallback?.text).toBe("已执行模型声明的操作步骤，正在核对页面结果。");
    expect(summaryFallback?.text).not.toContain("查看搜索结果");
  });

  it("uses the current task map when another task becomes pending or completes", () => {
    const projector = new RunNoticeProjector(runId, { dynamicContentEnabled: true });
    expect(projector.project(event(1, {
      type: "planning.task.updated", callId: "plan-call-1" as never,
      mutation: { operation: "created", task: task("t1", "in_progress", "查询出发日期可用车次") },
    }))?.text).toContain("查询出发日期可用车次");
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
    const fallback = projector.project(actionCompleted(6, "action-plan"));
    expect(fallback?.text).toContain("查询出发日期可用车次");
    expect(fallback?.text).not.toContain("比较到达后的公交路线");
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
    expect(projector.project(actionCompleted(11, "success-action"))).toBeDefined();
  });

  it("emits exactly one fixed or dynamic notice per event, with dynamic content opt-in", () => {
    const fixedProjector = new RunNoticeProjector(runId);
    const dynamicProjector = new RunNoticeProjector(runId, { dynamicContentEnabled: true });
    const question = event(1, { type: "user.input.requested", question: "请选择上海还是杭州？" });
    const fixedQuestion = fixedProjector.project(question);
    const dynamicQuestion = dynamicProjector.project(question);
    expect(fixedQuestion?.text).toBe("我有一个问题需要你回答，请查看任务页面。");
    expect(dynamicQuestion?.text).toBe("请选择上海还是杭州？");
    expect(fixedQuestion).toBeDefined();
    expect(dynamicQuestion).toBeDefined();

    const sensitive = event(2, { type: "user.input.requested", question: "请确认验证码 123456" });
    expect(new RunNoticeProjector(runId, { dynamicContentEnabled: true }).project(sensitive)?.text)
      .toBe("我有一个问题需要你回答，请查看任务页面。");

    const final = event(3, { type: "run.finished", outcome: "succeeded", summary: "整理了两种车次方案。" });
    expect(fixedProjector.project(final)?.text).toBe("本次运行结束，请查看结果。");
    expect(dynamicProjector.project(final)?.text).toBe("本次运行提供的文字摘要：整理了两种车次方案。");
    expect(dynamicProjector.project(event(4, { type: "runtime.error", category: "late", message: "late" }))).toBeUndefined();
  });

  it("projects attention/terminal states and never projects Guard reasons or ordinary receipts", () => {
    const projector = new RunNoticeProjector(runId);
    expect(projector.project(event(1, {
      type: "approval.requested", requestId: "approval-1", callId: "call-1" as never, reason: "Payment requires approval",
    }))).toMatchObject({ kind: "approval", delivery: "interrupt", text: "有一项操作需要你审批，请查看审批详情。", pendingRequestId: "approval-1" });
    const question = projector.project(event(2, { type: "user.input.requested", question: "请回答" }));
    expect(question).toMatchObject({ kind: "question", delivery: "interrupt" });
    expect(question?.pendingRequestId).toBe("event-2");
    expect(projector.project(event(3, { type: "runtime.error", category: "network", message: "secret token details" }))).toMatchObject({ kind: "error", delivery: "interrupt" });
    expect(projector.project(event(4, { type: "run.finished", outcome: "succeeded", summary: "Never read directly" }))).toMatchObject({ kind: "result", delivery: "interrupt", text: "本次运行结束，请查看结果。" });
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

  it("lets urgent notices bypass progress cooldown and validates pending interaction IDs at dequeue", () => {
    const scheduler = new RunNoticeScheduler({ now: () => 1_000, minimumProgressIntervalMs: 60_000 });
    const generation = scheduler.activateRun(runId);
    scheduler.offer(notice(1), generation);
    const approval = notice(2, { kind: "approval", delivery: "interrupt", pendingRequestId: "approval-1", text: "请审批", dedupeKey: "approval-1" });
    expect(scheduler.offer(approval, generation)).toEqual({ status: "queued", interruptCurrent: true });
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
    scheduler.offer(notice(2), generation);
    const error = notice(3, { kind: "error", delivery: "interrupt", dedupeKey: "error-3" });
    scheduler.offer(error, generation);
    expect(scheduler.takeNext(new Set([pendingId(approval)]))?.noticeId).toBe(approval.noticeId);
    expect(scheduler.takeNext()?.noticeId).toBe(error.noticeId);

    scheduler.offer(notice(4), generation);
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
