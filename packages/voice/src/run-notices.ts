import type { ActionId, EventId, ObservationAssessment, ObservationId, PlanningTask, RunId, RuntimeEvent } from "@computer-harness/protocol";

export type RunNoticeKind = "progress" | "approval" | "question" | "error" | "result";
export type RunNoticeDelivery = "polite" | "interrupt";

/** A transient, user-facing projection. It is not persisted as a RuntimeEvent. */
export interface RunNotice {
  readonly noticeId: string;
  readonly runId: RunId;
  readonly eventId: EventId;
  readonly eventSequence: number;
  readonly kind: RunNoticeKind;
  readonly text: string;
  readonly delivery: RunNoticeDelivery;
  readonly dedupeKey: string;
  /** Required for approval/question; consumers compare it with the current pending request before speaking. */
  readonly pendingRequestId?: string;
}

export interface RunNoticeProjectorOptions {
  /** Defaults to fixed, safe status text; enable only with explicit user preference. */
  readonly dynamicContentEnabled?: boolean;
}

const MAX_NOTICE_CHARS = 320;

interface AssessmentTransition {
  readonly actionId: ActionId;
  readonly observationId: ObservationId;
  readonly transition: "changed" | "unchanged" | "unknown";
}

/**
 * Consume committed RuntimeEvents in order. Ordinary action completion is
 * silent; a progress notice requires a current, action-bound assessment and
 * uses fixed wording so model-provided summaries are never spoken.
 */
export class RunNoticeProjector {
  private lastSequence = -1;
  private readonly planTasks = new Map<string, PlanningTask>();
  private latestObservationId: ObservationId | undefined;
  private observationActionId: ActionId | undefined;
  private lastActionId: ActionId | undefined;
  private lastActionStatus: "completed" | "refused" | "failed" | "cancelled" | undefined;
  private readonly assessmentTransitions = new Map<ActionId, AssessmentTransition>();
  private readonly announcedAssessments = new Set<string>();
  private startNoticeProjected = false;
  private finished = false;
  private readonly dynamicContentEnabled: boolean;

  public constructor(private readonly runId: RunId, options: RunNoticeProjectorOptions = {}) {
    this.dynamicContentEnabled = options.dynamicContentEnabled ?? false;
  }

  public project(event: RuntimeEvent): RunNotice | undefined {
    if (this.finished || event.runId !== this.runId || event.sequence <= this.lastSequence) return undefined;
    this.lastSequence = event.sequence;

    switch (event.type) {
      case "run.created":
        if (this.startNoticeProjected) return undefined;
        this.startNoticeProjected = true;
        return this.notice(event, "progress", "任务已开始。", "polite", "run-start", "fixed");
      case "planning.task.updated":
        return this.projectPlanning(event);
      case "observation.created":
        this.latestObservationId = event.observation.id;
        this.observationActionId = this.lastActionStatus === undefined ? undefined : this.lastActionId;
        return undefined;
      case "model.response.received":
        return this.projectObservationAssessment(event);
      case "action.proposed": {
        this.latestObservationId = undefined;
        this.observationActionId = undefined;
        this.lastActionId = event.action.actionId;
        this.lastActionStatus = undefined;
        return undefined;
      }
      case "action.execution.completed": {
        this.recordActionReceipt(event.receipt.actionId, event.receipt.status);
        return undefined;
      }
      case "action.execution.failed":
        this.recordActionReceipt(event.receipt.actionId, event.receipt.status);
        return undefined;
      case "monitor.transition":
        this.assessmentTransitions.set(event.actionId, {
          actionId: event.actionId,
          observationId: event.postObservationId,
          transition: event.transition,
        });
        while (this.assessmentTransitions.size > 64) {
          const first = this.assessmentTransitions.keys().next();
          if (first.done) break;
          this.assessmentTransitions.delete(first.value);
        }
        return undefined;
      case "approval.requested":
        return this.notice(event, "approval", "有一项操作需要你审批，请查看审批详情。", "interrupt", `approval:${event.requestId}`, "fixed", event.requestId);
      case "user.input.requested":
        return this.projectQuestion(event);
      case "user.input.received":
      case "approval.resolved":
        // The scheduler checks these notices against the live pending-request snapshot at dequeue time.
        return undefined;
      case "runtime.error":
      case "model.request.failed":
        return this.notice(event, "error", "任务遇到问题，请查看任务页面中的详情。", "interrupt", `error:${event.eventId}`, "fixed");
      case "run.finished": {
        this.finished = true;
        this.planTasks.clear();
        this.assessmentTransitions.clear();
        this.announcedAssessments.clear();
        const summary = candidateText(event.summary);
        const dynamic = summary !== undefined && this.dynamicContentEnabled && !isPotentiallySensitive(summary);
        const text = dynamic ? `本次运行提供的文字摘要：${summary}` : resultFallback(event.outcome);
        return this.notice(event, "result", text, "interrupt", `result:${event.outcome}`, dynamic ? "dynamic" : "fixed");
      }
      default:
        return undefined;
    }
  }

  private projectPlanning(event: Extract<RuntimeEvent, { type: "planning.task.updated" }>): RunNotice | undefined {
    const previous = this.planTasks.get(event.mutation.task.id);
    const task = structuredClone(event.mutation.task);
    this.planTasks.set(task.id, task);

    if (task.status !== "in_progress" || (previous?.subject === task.subject && previous.status === task.status)) return undefined;
    const subject = candidateText(task.subject);
    const dynamic = subject !== undefined && this.dynamicContentEnabled && !isPotentiallySensitive(subject);
    const text = dynamic ? `当前阶段：${subject}` : "任务阶段已更新。";
    return this.notice(event, "progress", text, "polite", `phase:${task.id}:${event.eventId}`, dynamic ? "dynamic" : "fixed");
  }

  private projectObservationAssessment(event: Extract<RuntimeEvent, { type: "model.response.received" }>): RunNotice | undefined {
    const rawAssessment: unknown = event.turn.observationAssessment;
    if (!isObservationAssessment(rawAssessment) || rawAssessment.progress === undefined
      || rawAssessment.observationId !== this.latestObservationId
      || rawAssessment.actionId !== this.observationActionId
      || rawAssessment.actionId !== this.lastActionId
      || this.lastActionStatus !== "completed") return undefined;
    const transition = this.assessmentTransitions.get(rawAssessment.actionId);
    if (transition === undefined || transition.observationId !== rawAssessment.observationId
      || !assessmentAgreesWithTransition(rawAssessment, transition.transition)) return undefined;
    const dedupeKey = `${rawAssessment.observationId}:${rawAssessment.actionId}:${rawAssessment.progress.kind}`;
    if (this.announcedAssessments.has(dedupeKey)) return undefined;
    this.announcedAssessments.add(dedupeKey);
    while (this.announcedAssessments.size > 128) {
      const first = this.announcedAssessments.values().next();
      if (first.done) break;
      this.announcedAssessments.delete(first.value);
    }
    return this.notice(
      event,
      "progress",
      "已确认一个阶段性进展，正在继续核对任务。",
      "polite",
      `assessment:${dedupeKey}`,
      "fixed",
    );
  }

  private recordActionReceipt(actionId: ActionId, status: "completed" | "refused" | "failed" | "cancelled"): void {
    this.latestObservationId = undefined;
    this.observationActionId = undefined;
    this.lastActionId = actionId;
    this.lastActionStatus = status;
  }

  private projectQuestion(event: Extract<RuntimeEvent, { type: "user.input.requested" }>): RunNotice {
    const requestId = event.eventId as unknown as string;
    const question = candidateText(event.question);
    const dynamic = question !== undefined && this.dynamicContentEnabled && !isPotentiallySensitive(question);
    const text = dynamic ? question : "我有一个问题需要你回答，请查看任务页面。";
    return this.notice(event, "question", text, "interrupt", `question:${event.eventId}`, dynamic ? "dynamic" : "fixed", requestId);
  }

  private notice(
    event: RuntimeEvent,
    kind: RunNoticeKind,
    text: string,
    delivery: RunNoticeDelivery,
    dedupeKey: string,
    variant: "dynamic" | "fixed",
    pendingRequestId?: string,
  ): RunNotice {
    return {
      noticeId: `${event.runId}:${event.eventId}:${kind}:${variant}`,
      runId: event.runId,
      eventId: event.eventId,
      eventSequence: event.sequence,
      kind,
      text: text.slice(0, MAX_NOTICE_CHARS),
      delivery,
      dedupeKey,
      ...(pendingRequestId === undefined ? {} : { pendingRequestId }),
    };
  }
}

export function candidateText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  if (text.length === 0) return undefined;
  return text.slice(0, MAX_NOTICE_CHARS);
}

/** Known-pattern filter only. It is not a semantic privacy guarantee. */
export function isPotentiallySensitive(text: string): boolean {
  return [
    /(?:密码|口令|验证码|身份证|手机号|手机号码|电话号码|银行卡|卡号|支付|账户|账号|住址|家庭住址|订单号|隐私|密钥|password|passcode|verification\s+code|api[_ -]?key|secret|token|credit\s+card)/iu,
    /(?:\+?86[\s-]?)?1[3-9]\d{9}/u,
    /\b\d{17}[\dXx]\b/u,
    /\b\d{15,19}\b/u,
    /\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/u,
    /https?:\/\/\S*(?:token|secret|session|auth|key)=/iu,
  ].some((pattern) => pattern.test(text));
}

function resultFallback(outcome: Extract<RuntimeEvent, { type: "run.finished" }>['outcome']): string {
  switch (outcome) {
    case "succeeded": return "本次运行结束，请查看结果。";
    case "failed": return "本次运行结束时遇到问题，请查看详情。";
    case "cancelled": return "本次运行已取消。";
    case "budget_exhausted": return "本次运行达到执行预算，请查看当前进度。";
    case "outcome_unknown": return "有一项操作的结果尚未确认，请先查看任务页面。";
  }
}

function isObservationAssessment(value: unknown): value is ObservationAssessment {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const assessment = value as Record<string, unknown>;
  if (Object.keys(assessment).some((key) => !["observationId", "actionId", "actionOutcome", "evidence", "progress"].includes(key))) return false;
  if (typeof assessment.observationId !== "string" || assessment.observationId.length === 0 || assessment.observationId.length > 128
    || typeof assessment.actionId !== "string" || assessment.actionId.length === 0 || assessment.actionId.length > 128
    || !["expected_change", "no_effect", "unexpected_change", "uncertain"].includes(String(assessment.actionOutcome))
    || typeof assessment.evidence !== "string" || assessment.evidence.trim().length === 0 || assessment.evidence.length > 240) return false;
  if (assessment.progress === undefined) return true;
  if (typeof assessment.progress !== "object" || assessment.progress === null || Array.isArray(assessment.progress)) return false;
  const progress = assessment.progress as Record<string, unknown>;
  return Object.keys(progress).every((key) => key === "kind" || key === "summary")
    && (progress.kind === "milestone" || progress.kind === "blocked")
    && typeof progress.summary === "string" && progress.summary.trim().length > 0 && progress.summary.length <= 160;
}

function assessmentAgreesWithTransition(
  assessment: ObservationAssessment,
  transition: "changed" | "unchanged" | "unknown",
): boolean {
  return assessment.progress?.kind === "milestone"
    && transition === "changed"
    && assessment.actionOutcome === "expected_change";
}
