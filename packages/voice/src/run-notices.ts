import type { ActionGuardActionSummary, EventId, ObservationAssessment, ObservationId, PlanningTask, RiskCategory, RunId, RuntimeEvent } from "@computer-harness/protocol";

export type RunNoticeKind = "progress" | "approval" | "question" | "handoff" | "error" | "result";
export type RunNoticeDelivery = "polite" | "interrupt";
export type RunNoticeProgressSemantic = "run_start" | "observation_milestone" | "observation_blocker";

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
  readonly modelDeclaredEffect?: {
    readonly target: string;
    readonly summary: string;
  };
}

const MAX_NOTICE_CHARS = 320;
const MAX_DYNAMIC_TEXT_CHARS = 240;
const MAX_SPOKEN_MILESTONE_CHARS = 120;
const MAX_APPROVAL_PLAN_CHARS = 220;
const SAFE_MILESTONE_FALLBACK = "已确认一个阶段结果。";
const SAFE_BLOCKER_FALLBACK = "当前页面显示有事项需要处理。";
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/gu;

interface ModelObservationBinding {
  readonly observationId?: ObservationId;
  readonly included: boolean;
}

/**
 * Consume committed RuntimeEvents in order. Progress text is a bounded model
 * report about the exact fresh screenshot included in that response request;
 * action and Monitor assessments remain diagnostic and do not gate speech.
 */
export class RunNoticeProjector {
  private lastSequence = -1;
  private readonly planTasks = new Map<string, PlanningTask>();
  private readonly modelObservationBindings = new Map<string, ModelObservationBinding>();
  private latestObservationId: ObservationId | undefined;
  private readonly announcedAssessments = new Set<string>();
  private readonly announcedFailureKeys = new Set<string>();
  private startNoticeProjected = false;
  private finished = false;
  private failureNoticeProjected = false;
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
        return undefined;
      case "model.request.started":
        return this.recordModelRequestObservation(event);
      case "model.response.received":
        return this.projectObservationAssessment(event);
      case "action.proposed":
        // Do not reuse the pre-action screenshot for a later progress report.
        this.latestObservationId = undefined;
        return undefined;
      case "approval.requested":
        return this.projectApproval(event, context);
      case "user.input.requested":
        return this.projectQuestion(event);
      case "computer.window.handoff.requested":
        return this.notice(
          event,
          "handoff",
          "任务正在等待你选择或确认一个窗口。",
          "interrupt",
          `handoff:${event.sourceActionId}`,
          "fixed",
          event.sourceActionId,
        );
      case "user.input.received":
      case "approval.resolved":
        // The scheduler checks interactive notices against the live pending request at dequeue time.
        return undefined;
      case "runtime.error":
        return this.projectRuntimeError(event);
      case "model.request.failed":
        return this.projectModelRequestFailure(event);
      case "run.finished": {
        this.finished = true;
        this.planTasks.clear();
        this.modelObservationBindings.clear();
        this.announcedAssessments.clear();
        const summary = safeDynamicText(event.summary);
        const dynamic = event.outcome === "succeeded" && summary !== undefined && this.dynamicContentEnabled;
        const text = dynamic ? summary : resultFallback(event.outcome, this.failureNoticeProjected);
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
    const requestKey = modelRequestKey(event.requestId, event.decisionId);
    const requestObservation = requestKey === undefined ? undefined : this.modelObservationBindings.get(requestKey);
    if (requestKey !== undefined) this.modelObservationBindings.delete(requestKey);
    const rawAssessment: unknown = event.turn.observationAssessment;
    if (!isObservationAssessment(rawAssessment) || rawAssessment.progress === undefined
      || (rawAssessment.progress.kind !== "milestone" && rawAssessment.progress.kind !== "blocked")
      || rawAssessment.observationId !== this.latestObservationId) return undefined;
    if (requestObservation?.included !== true || requestObservation.observationId !== rawAssessment.observationId) return undefined;
    const summary = safeDynamicText(rawAssessment.progress.summary, MAX_SPOKEN_MILESTONE_CHARS);
    const contentKey = summary === undefined ? `fallback:${rawAssessment.progress.kind}` : `summary:${summary.toLocaleLowerCase("zh-CN")}`;
    const dedupeKey = `${rawAssessment.progress.kind}:${contentKey}`;
    if (this.announcedAssessments.has(dedupeKey)) return undefined;
    this.announcedAssessments.add(dedupeKey);
    while (this.announcedAssessments.size > 128) {
      const first = this.announcedAssessments.values().next();
      if (first.done) break;
      this.announcedAssessments.delete(first.value);
    }
    const dynamic = summary !== undefined && this.dynamicContentEnabled;
    const blocked = rawAssessment.progress.kind === "blocked";
    return this.notice(
      event,
      "progress",
      dynamic ? summary : blocked ? SAFE_BLOCKER_FALLBACK : SAFE_MILESTONE_FALLBACK,
      blocked ? "interrupt" : "polite",
      `assessment:${dedupeKey}`,
      dynamic ? "dynamic" : "fixed",
      undefined,
      blocked ? "observation_blocker" : "observation_milestone",
    );
  }

  private recordModelRequestObservation(event: Extract<RuntimeEvent, { type: "model.request.started" }>): undefined {
    const key = modelRequestKey(event.requestId, event.decisionId);
    if (key === undefined) return undefined;
    const included = event.contextBudget?.trace?.observationIncluded === true;
    this.modelObservationBindings.set(key, {
      ...(included && this.latestObservationId !== undefined ? { observationId: this.latestObservationId } : {}),
      included,
    });
    while (this.modelObservationBindings.size > 32) {
      const first = this.modelObservationBindings.keys().next();
      if (first.done) break;
      this.modelObservationBindings.delete(first.value);
    }
    return undefined;
  }

  private projectRuntimeError(event: Extract<RuntimeEvent, { type: "runtime.error" }>): RunNotice | undefined {
    const text = runtimeErrorVoiceText(event.category);
    if (text === undefined) return undefined;
    const dedupeKey = `runtime-error:${event.category}`;
    if (this.announcedFailureKeys.has(dedupeKey)) return undefined;
    this.rememberFailureKey(dedupeKey);
    this.failureNoticeProjected = true;
    return this.notice(event, "error", text, "interrupt", dedupeKey, "fixed");
  }

  private projectModelRequestFailure(event: Extract<RuntimeEvent, { type: "model.request.failed" }>): RunNotice | undefined {
    if (event.category === "cancelled") return undefined;
    const retryable = event.retryable === true;
    const dedupeKey = `model-error:${event.category}:${retryable ? "retryable" : "terminal"}`;
    if (this.announcedFailureKeys.has(dedupeKey)) return undefined;
    this.rememberFailureKey(dedupeKey);
    const text = retryable ? "模型连接暂时不稳定。" : modelRequestFailureVoiceText(event.category);
    if (!retryable) this.failureNoticeProjected = true;
    return this.notice(event, "error", text, "interrupt", dedupeKey, "fixed");
  }

  private rememberFailureKey(key: string): void {
    this.announcedFailureKeys.add(key);
    while (this.announcedFailureKeys.size > 32) {
      const first = this.announcedFailureKeys.values().next();
      if (first.done) break;
      this.announcedFailureKeys.delete(first.value);
    }
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
      dynamic ? voiceText : "还不能确定待审批操作的具体对象和影响，请先不要批准。",
      "interrupt",
      `approval:${event.requestId}`,
      dynamic ? "dynamic" : "fixed",
      event.requestId,
    );
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
  return truncateDynamicNotice(text, Math.max(1, Math.floor(Math.min(maxChars, MAX_DYNAMIC_TEXT_CHARS))));
}

function truncateDynamicNotice(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  // Leave room for an explicit omission mark. If no phrase boundary fits,
  // keep the bounded prefix rather than repeatedly backing up to an empty string.
  const boundary = lastNoticeBoundary(text, Math.max(1, maxChars - 2));
  if (boundary !== undefined) {
    const prefix = text.slice(0, boundary).trimEnd();
    const omissionMark = /[.!?,;:]$/u.test(prefix) ? " …" : "…";
    if (prefix && prefix.length + omissionMark.length <= maxChars) return `${prefix}${omissionMark}`;
  }

  const boundedPrefix = sliceWithoutSplittingSurrogatePair(text, maxChars - 1);
  const prefix = boundedPrefix.trimEnd();
  return `${prefix || boundedPrefix}…`;
}

function sliceWithoutSplittingSurrogatePair(text: string, maxEnd: number): string {
  let end = Math.min(maxEnd, text.length);
  if (end > 0 && end < text.length) {
    const previous = text.charCodeAt(end - 1);
    const next = text.charCodeAt(end);
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
  }
  return text.slice(0, end);
}

function lastNoticeBoundary(text: string, maxEnd: number): number | undefined {
  let boundary: number | undefined;
  for (let index = 0; index < maxEnd; index += 1) {
    const character = text[index]!;
    if (isSentenceBoundary(text, index, character) || ",，;；:：、—–".includes(character)) {
      boundary = index + 1;
    }
  }
  return boundary;
}

function isSentenceBoundary(text: string, index: number, character: string): boolean {
  if ("。！？".includes(character)) return true;
  if (character !== "." && character !== "!" && character !== "?") return false;
  if (character === "." && /\d/u.test(text[index - 1] ?? "") && /\d/u.test(text[index + 1] ?? "")) return false;

  let next = index + 1;
  while (/["'”’»)]/u.test(text[next] ?? "")) next += 1;
  return next >= text.length || /\s/u.test(text[next] ?? "");
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

function resultFallback(outcome: Extract<RuntimeEvent, { type: "run.finished" }>['outcome'], failureAlreadyExplained = false): string {
  switch (outcome) {
    case "succeeded": return "任务已完成，可查看结果。";
    case "failed": return "任务未能完成。";
    case "cancelled": return "任务已取消。";
    case "budget_exhausted": return failureAlreadyExplained ? "任务结束。" : "任务操作已达到上限。";
    case "outcome_unknown": return failureAlreadyExplained ? "任务结束。" : "任务已结束，操作结果仍待核实。";
  }
}

function runtimeErrorVoiceText(category: string): string | undefined {
  switch (category) {
    case "cancelled":
    case "monitor_diagnostic":
      return undefined;
    case "budget":
      return "任务操作已达到上限，暂时停止。";
    case "unknown_side_effect":
      return "有项操作的结果暂时无法确认，请查看当前任务状态。";
    case "partial_side_effect":
      return "操作可能已部分完成，结果暂时无法确认，请查看当前任务状态。";
    case "cleanup":
      return "任务结束时有资源未能清理。";
    case "finish_summary_invalid":
      return "任务结果缺少必要内容，无法确认完成。";
    case "finish_denied":
      return "目前还不能确认任务已完成。";
    case "planning_materialization_failed":
      return "任务阶段状态未能保存，执行已停止。";
    case "memory_materialization_failed":
      return "任务记录未能保存，执行已停止。";
    case "runtime":
      return "任务运行遇到问题，已停止。";
    default:
      return "任务遇到问题，请查看当前任务状态。";
  }
}

function modelRequestFailureVoiceText(category: string): string {
  switch (category) {
    case "provider":
      return "模型请求失败，任务无法继续。";
    case "cancelled":
      return "任务已取消。";
    default:
      return "模型请求未能完成，任务无法继续。";
  }
}

function approvalVoiceText(context: ApprovalNoticeVoiceContext | undefined): string | undefined {
  if (context === undefined) return undefined;
  const riskText = approvalRiskVoiceText(context);
  const plan = approvalPlanVoiceText(context.modelDeclaredEffect);
  if (plan.kind === "sensitive") {
    const notAutoRead = "具体说明不适合自动朗读，请在审批详情核对，或请可信任的人协助；核对前请不要批准。";
    return riskText === undefined ? notAutoRead : `${riskText} ${notAutoRead}`;
  }
  if (plan.kind === "unavailable") {
    const insufficientInformation = "还不能确定具体对象和影响，请先不要批准。";
    return riskText === undefined ? insufficientInformation : `${riskText} ${insufficientInformation}`;
  }
  return riskText === undefined ? plan.text : `${plan.text} ${riskText}`;
}

function approvalRiskVoiceText(context: ApprovalNoticeVoiceContext): string | undefined {
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
    switch_window: "切换窗口操作",
    reopen_saved_document: "重新打开文档操作",
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

function approvalPlanVoiceText(
  declaredEffect: ApprovalNoticeVoiceContext["modelDeclaredEffect"],
): { readonly kind: "ready"; readonly text: string } | { readonly kind: "sensitive" } | { readonly kind: "unavailable" } {
  if (declaredEffect === undefined || typeof declaredEffect.target !== "string" || typeof declaredEffect.summary !== "string") {
    return { kind: "unavailable" };
  }

  // Scan both full model-authored fields together and individually before any
  // bounded copy so a sensitive value split across the fields cannot be spoken.
  const fullPlan = `${declaredEffect.target}\n${declaredEffect.summary}`;
  const normalizedFullPlan = fullPlan.replace(CONTROL_CHARACTERS, " ").replace(/\s+/gu, " ").trim();
  if (isPotentiallySensitive(normalizedFullPlan)) return { kind: "sensitive" };
  if (safeDynamicText(fullPlan) === undefined) return { kind: "unavailable" };
  const target = safeDynamicText(declaredEffect.target, 64);
  const summary = safeDynamicText(declaredEffect.summary, 96);
  if (target === undefined || summary === undefined) return { kind: "unavailable" };
  const text = safeDynamicText(
    `电脑打算按这份说明操作：「${summary}」；目标：「${target}」。这项操作还没执行；说明仍需核对，请勿仅凭说明批准。`,
    MAX_APPROVAL_PLAN_CHARS,
  );
  return text === undefined ? { kind: "unavailable" } : { kind: "ready", text };
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

function modelRequestKey(requestId: string | undefined, decisionId: string | undefined): string | undefined {
  if (decisionId !== undefined && decisionId.length > 0) return `decision:${decisionId}`;
  if (requestId !== undefined && requestId.length > 0) return `request:${requestId}`;
  return undefined;
}
