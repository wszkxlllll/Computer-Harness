import type { ActionGuardActionSummary, ActionId, EventId, ObservationAssessment, ObservationId, PlanningTask, RiskCategory, RunId, RuntimeEvent } from "@computer-harness/protocol";

export type RunNoticeKind = "progress" | "approval" | "question" | "error" | "result";
export type RunNoticeDelivery = "polite" | "interrupt";
export type RunNoticeProgressSemantic = "run_start" | "verified_milestone";

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
  /** Internal scheduler semantics; the Host explicitly omits this from the public RunNotice wire event. */
  readonly progressSemantic?: RunNoticeProgressSemantic;
}

export interface RunNoticeProjectorOptions {
  /** Defaults to fixed, safe status text; enable only when the current paired device opted in. */
  readonly dynamicContentEnabled?: boolean;
}

export interface RunNoticeProjectionContext {
  /** Guard data correlated to the exact callId on the live approval request. */
  readonly currentApproval?: {
    readonly requestId: string;
    readonly voiceContext?: ApprovalNoticeVoiceContext;
  };
}

export interface ApprovalNoticeVoiceContext {
  readonly categories: readonly RiskCategory[];
  readonly reasonCode: string;
  readonly actionKind?: ActionGuardActionSummary["kind"];
}

const MAX_NOTICE_CHARS = 320;
const MAX_DYNAMIC_TEXT_CHARS = 240;
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/gu;

interface AssessmentTransition {
  readonly actionId: ActionId;
  readonly observationId: ObservationId;
  readonly sourceActionEventId: EventId;
  readonly sourceObservationEventId: EventId;
  readonly transition: "changed" | "unchanged" | "unknown";
}

/**
 * Consume committed RuntimeEvents in order. Ordinary action completion is
 * silent; a milestone notice requires a current, action-bound assessment and
 * speaks its bounded summary only after explicit per-Run opt-in and filtering.
 */
export class RunNoticeProjector {
  private lastSequence = -1;
  private readonly planTasks = new Map<string, PlanningTask>();
  private latestObservationId: ObservationId | undefined;
  private latestObservationEventId: EventId | undefined;
  private observationActionId: ActionId | undefined;
  private lastActionId: ActionId | undefined;
  private lastActionReceiptEventId: EventId | undefined;
  private lastActionStatus: "completed" | "refused" | "failed" | "cancelled" | undefined;
  private readonly assessmentTransitions = new Map<ActionId, AssessmentTransition>();
  private readonly announcedAssessments = new Set<string>();
  private startNoticeProjected = false;
  private finished = false;
  private readonly dynamicContentEnabled: boolean;

  public constructor(private readonly runId: RunId, options: RunNoticeProjectorOptions = {}) {
    this.dynamicContentEnabled = options.dynamicContentEnabled ?? false;
  }

  public project(event: RuntimeEvent, context: RunNoticeProjectionContext = {}): RunNotice | undefined {
    if (this.finished || event.runId !== this.runId || event.sequence <= this.lastSequence) return undefined;
    this.lastSequence = event.sequence;

    switch (event.type) {
      case "run.created":
        if (this.startNoticeProjected) return undefined;
        this.startNoticeProjected = true;
        return this.notice(event, "progress", "任务已开始。", "polite", "run-start", "fixed", undefined, "run_start");
      case "planning.task.updated":
        return this.projectPlanning(event);
      case "observation.created":
        this.latestObservationId = event.observation.id;
        this.latestObservationEventId = event.eventId;
        this.observationActionId = this.lastActionStatus === undefined ? undefined : this.lastActionId;
        return undefined;
      case "model.response.received":
        return this.projectObservationAssessment(event);
      case "action.proposed": {
        this.latestObservationId = undefined;
        this.latestObservationEventId = undefined;
        this.observationActionId = undefined;
        this.lastActionId = event.action.actionId;
        this.lastActionReceiptEventId = undefined;
        this.lastActionStatus = undefined;
        return undefined;
      }
      case "action.execution.completed": {
        this.recordActionReceipt(event.receipt.actionId, event.receipt.status, event.eventId);
        return undefined;
      }
      case "action.execution.failed":
        this.recordActionReceipt(event.receipt.actionId, event.receipt.status, event.eventId);
        return undefined;
      case "monitor.transition":
        this.assessmentTransitions.set(event.actionId, {
          actionId: event.actionId,
          observationId: event.postObservationId,
          sourceActionEventId: event.sourceActionEventId,
          sourceObservationEventId: event.sourceObservationEventId,
          transition: event.transition,
        });
        while (this.assessmentTransitions.size > 64) {
          const first = this.assessmentTransitions.keys().next();
          if (first.done) break;
          this.assessmentTransitions.delete(first.value);
        }
        return undefined;
      case "approval.requested":
        return this.projectApproval(event, context);
      case "user.input.requested":
        return this.projectQuestion(event);
      case "user.input.received":
      case "approval.resolved":
        // The scheduler checks these notices against the live pending-request snapshot at dequeue time.
        return undefined;
      case "runtime.error":
      case "model.request.failed":
        return this.notice(event, "error", "任务遇到问题，请查看详情。", "interrupt", `error:${event.eventId}`, "fixed");
      case "run.finished": {
        this.finished = true;
        this.planTasks.clear();
        this.assessmentTransitions.clear();
        this.announcedAssessments.clear();
        const summary = safeDynamicText(event.summary);
        const dynamic = event.outcome === "succeeded" && summary !== undefined && this.dynamicContentEnabled;
        const text = dynamic ? summary : resultFallback(event.outcome);
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
    const subject = safeDynamicText(task.subject);
    const dynamic = subject !== undefined && this.dynamicContentEnabled;
    const text = dynamic ? subject : "任务有新进展。";
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
      || transition.sourceActionEventId !== this.lastActionReceiptEventId
      || transition.sourceObservationEventId !== this.latestObservationEventId
      || !assessmentAgreesWithTransition(rawAssessment, transition.transition)) return undefined;
    const dedupeKey = `${rawAssessment.observationId}:${rawAssessment.actionId}:${rawAssessment.progress.kind}`;
    if (this.announcedAssessments.has(dedupeKey)) return undefined;
    this.announcedAssessments.add(dedupeKey);
    while (this.announcedAssessments.size > 128) {
      const first = this.announcedAssessments.values().next();
      if (first.done) break;
      this.announcedAssessments.delete(first.value);
    }
    const summary = safeDynamicText(rawAssessment.progress.summary, MAX_DYNAMIC_TEXT_CHARS);
    const dynamic = summary !== undefined && this.dynamicContentEnabled;
    return this.notice(
      event,
      "progress",
      dynamic ? summary : "已确认一项进展，任务继续中。",
      "polite",
      `assessment:${dedupeKey}`,
      dynamic ? "dynamic" : "fixed",
      undefined,
      "verified_milestone",
    );
  }

  private projectApproval(
    event: Extract<RuntimeEvent, { type: "approval.requested" }>,
    context: RunNoticeProjectionContext,
  ): RunNotice {
    const pending = context.currentApproval;
    const voiceText = pending?.requestId === event.requestId && this.dynamicContentEnabled
      ? approvalVoiceText(pending.voiceContext)
      : undefined;
    const dynamic = voiceText !== undefined;
    return this.notice(
      event,
      "approval",
      dynamic ? voiceText : "有项操作需要审批，请核对后处理。",
      "interrupt",
      `approval:${event.requestId}`,
      dynamic ? "dynamic" : "fixed",
      event.requestId,
    );
  }

  private recordActionReceipt(actionId: ActionId, status: "completed" | "refused" | "failed" | "cancelled", eventId: EventId): void {
    this.latestObservationId = undefined;
    this.latestObservationEventId = undefined;
    this.observationActionId = undefined;
    this.lastActionId = actionId;
    this.lastActionReceiptEventId = eventId;
    this.lastActionStatus = status;
  }

  private projectQuestion(event: Extract<RuntimeEvent, { type: "user.input.requested" }>): RunNotice {
    const requestId = event.eventId as unknown as string;
    const question = safeDynamicText(event.question);
    const dynamic = question !== undefined && this.dynamicContentEnabled;
    const text = dynamic ? question : "我有个问题需要你回答，请查看任务。";
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
    progressSemantic?: RunNoticeProgressSemantic,
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
      ...(progressSemantic === undefined ? {} : { progressSemantic }),
    };
  }
}

export function candidateText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = value.replace(CONTROL_CHARACTERS, " ").replace(/\s+/gu, " ").trim();
  if (text.length === 0) return undefined;
  return text.slice(0, MAX_NOTICE_CHARS);
}

function safeDynamicText(value: string | undefined, maxChars = MAX_NOTICE_CHARS): string | undefined {
  if (value === undefined) return undefined;
  // Scan the full normalized value before truncating so a secret at the tail
  // cannot evade filtering by falling outside the spoken prefix.
  const text = value.replace(CONTROL_CHARACTERS, " ").replace(/\s+/gu, " ").trim();
  if (text.length === 0 || isPotentiallySensitive(text)) return undefined;
  return text.slice(0, Math.min(maxChars, MAX_DYNAMIC_TEXT_CHARS));
}

/** Known-pattern filter only. It is not a semantic privacy guarantee. */
export function isPotentiallySensitive(text: string): boolean {
  return [
    /(?:密码|口令|验证码|身份证|手机号|手机号码|电话号码|银行卡|卡号|支付|账户|账号|住址|家庭住址|订单号|隐私|密钥|password|passcode|verification\s+code|api[_ -]?key|secret|token|credit\s+card)/iu,
    /(?:social\s+security|ssn|phone\s+number|account\s+number|email\s+address|access\s+token|bearer\s+token)/iu,
    /(?:\+?86[\s-]?)?1[3-9]\d{9}/u,
    /\b\d{17}[\dXx]\b/u,
    /\b\d{15,19}\b/u,
    /\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/u,
    /https?:\/\/\S*(?:token|secret|session|auth|key)=/iu,
    /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|AKIA[0-9A-Z]{16}|Bearer\s+\S+)\b/u,
  ].some((pattern) => pattern.test(text));
}

function resultFallback(outcome: Extract<RuntimeEvent, { type: "run.finished" }>['outcome']): string {
  switch (outcome) {
    case "succeeded": return "任务已完成，可查看结果。";
    case "failed": return "任务未能完成，请查看详情。";
    case "cancelled": return "任务已取消。";
    case "budget_exhausted": return "任务达到执行上限，可查看进度。";
    case "outcome_unknown": return "有项操作结果未确认，请查看任务。";
  }
}

function approvalVoiceText(context: ApprovalNoticeVoiceContext | undefined): string | undefined {
  if (context === undefined) return undefined;
  const categoryLabels: Readonly<Record<RiskCategory, string>> = {
    external_commitment: "对外发送或提交内容",
    financial: "付款或财务操作",
    destructive: "删除或不可逆修改内容",
    privacy_account: "隐私、账户或凭据",
    intent_violation: "主机安全限制",
  };
  const categories = [...new Set(context.categories)];
  if (context.reasonCode === "protected_input" && !categories.includes("privacy_account")) categories.push("privacy_account");
  if (categories.length === 0 || categories.some((category) => !Object.hasOwn(categoryLabels, category))) {
    if (context.reasonCode === "declared_unknown" || context.reasonCode === "unknown_grounding_evidence_unavailable" || context.reasonCode === "model_unclear") {
      return "操作影响尚未确认，请核对请求后审批。";
    }
    return undefined;
  }

  const actionLabels: Readonly<Record<ActionGuardActionSummary["kind"], string>> = {
    click: "点击操作",
    double_click: "双击操作",
    right_click: "右键操作",
    scroll: "滚动操作",
    drag: "拖动操作",
    type: "输入操作",
    keypress: "键盘操作",
    select_option: "选择操作",
    wait: "等待操作",
  };
  const riskLabels = categories.map((category) => categoryLabels[category]);
  const riskText = riskLabels.length === 1
    ? riskLabels[0]!
    : `${riskLabels.slice(0, -1).join("、")}及${riskLabels.at(-1)}`;
  const actionText = context.actionKind !== undefined && Object.hasOwn(actionLabels, context.actionKind)
    ? actionLabels[context.actionKind]
    : "电脑操作";
  return `可能涉及${riskText}的${actionText}，请核对后审批。`;
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
