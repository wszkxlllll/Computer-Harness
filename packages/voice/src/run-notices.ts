import type { ActionId, EventId, PlanningTask, RunId, RuntimeEvent, ToolCallId } from "@computer-harness/protocol";

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

const COMPUTER_TOOL_NAMES = new Set([
  "click", "type", "keypress", "hotkey", "scroll", "drag", "wait", "click_element", "select_option",
]);
const MAX_NOTICE_CHARS = 320;

interface ProgressCandidate {
  readonly text: string;
  readonly source: "assistant_text" | "declared_effect" | "planning";
}

/**
 * Consume committed RuntimeEvents in order. Provider responses only create
 * pending candidates; progress is projected after the matching action gets a
 * completed receipt. Dynamic text is opt-in and known-sensitive patterns
 * always fall back to a fixed notice.
 */
export class RunNoticeProjector {
  private lastSequence = -1;
  private readonly planTasks = new Map<string, PlanningTask>();
  private activePlanTaskId: string | undefined;
  private readonly pendingCalls = new Map<ToolCallId, ProgressCandidate>();
  private readonly pendingActions = new Map<ActionId, ProgressCandidate>();
  private finished = false;
  private readonly dynamicContentEnabled: boolean;

  public constructor(private readonly runId: RunId, options: RunNoticeProjectorOptions = {}) {
    this.dynamicContentEnabled = options.dynamicContentEnabled ?? false;
  }

  public project(event: RuntimeEvent): RunNotice | undefined {
    if (this.finished || event.runId !== this.runId || event.sequence <= this.lastSequence) return undefined;
    this.lastSequence = event.sequence;

    switch (event.type) {
      case "planning.task.updated":
        return this.projectPlanning(event);
      case "model.response.received":
        this.projectModelResponse(event);
        return undefined;
      case "action.proposed": {
        const candidate = this.pendingCalls.get(event.callId);
        this.pendingCalls.delete(event.callId);
        if (candidate !== undefined) this.pendingActions.set(event.action.actionId, candidate);
        return undefined;
      }
      case "action.execution.completed": {
        const candidate = this.pendingActions.get(event.receipt.actionId);
        this.pendingActions.delete(event.receipt.actionId);
        if (candidate === undefined || event.receipt.status !== "completed") return undefined;
        return this.projectCompletedAction(event, candidate);
      }
      case "action.execution.failed":
        this.pendingActions.delete(event.receipt.actionId);
        return undefined;
      case "tool.call.rejected":
        this.pendingCalls.delete(event.callId);
        return undefined;
      case "tool.call.failed":
        this.pendingCalls.delete(event.result.callId);
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
        this.pendingCalls.clear();
        this.pendingActions.clear();
        this.planTasks.clear();
        this.activePlanTaskId = undefined;
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
    if (task.status === "in_progress") this.activePlanTaskId = task.id;
    else if (this.activePlanTaskId === task.id) this.activePlanTaskId = latestInProgressTaskId(this.planTasks);

    if (task.status !== "in_progress" || (previous?.subject === task.subject && previous.status === task.status)) return undefined;
    const subject = candidateText(task.subject);
    const dynamic = subject !== undefined && this.dynamicContentEnabled && !isPotentiallySensitive(subject);
    const text = dynamic ? `当前阶段：${subject}` : "任务阶段已更新。";
    return this.notice(event, "progress", text, "polite", `phase:${task.id}:${event.eventId}`, dynamic ? "dynamic" : "fixed");
  }

  private projectModelResponse(event: Extract<RuntimeEvent, { type: "model.response.received" }>): void {
    if (event.turn.type !== "tool_calls") return;
    const activeTask = this.activePlanTask();
    const assistantText = candidateText(event.turn.assistantText);
    for (const call of event.turn.calls) {
      if (!COMPUTER_TOOL_NAMES.has(call.name)) continue;
      const declaredSummary = candidateText(call.declaredEffect?.summary);
      const candidate = assistantText !== undefined
        ? { text: assistantText, source: "assistant_text" as const }
        : declaredSummary !== undefined
          ? { text: declaredSummary, source: "declared_effect" as const }
          : activeTask === undefined
            ? undefined
            : { text: activeTask.subject, source: "planning" as const };
      if (candidate !== undefined) this.pendingCalls.set(call.id, candidate);
    }
  }

  private projectQuestion(event: Extract<RuntimeEvent, { type: "user.input.requested" }>): RunNotice {
    const requestId = event.eventId as unknown as string;
    const question = candidateText(event.question);
    const dynamic = question !== undefined && this.dynamicContentEnabled && !isPotentiallySensitive(question);
    const text = dynamic ? question : "我有一个问题需要你回答，请查看任务页面。";
    return this.notice(event, "question", text, "interrupt", `question:${event.eventId}`, dynamic ? "dynamic" : "fixed", requestId);
  }

  private projectCompletedAction(
    event: Extract<RuntimeEvent, { type: "action.execution.completed" }>,
    candidate: ProgressCandidate,
  ): RunNotice {
    const text = this.dynamicProgressText(candidate);
    const dynamic = text !== undefined;
    return this.notice(
      event,
      "progress",
      text ?? "操作已执行，正在核对页面结果。",
      "polite",
      `action-progress:${normalizeKey(candidate.text)}`,
      dynamic ? "dynamic" : "fixed",
    );
  }

  private dynamicProgressText(candidate: ProgressCandidate): string | undefined {
    if (!this.dynamicContentEnabled || isPotentiallySensitive(candidate.text)) return undefined;
    const safeCandidate = candidateText(candidate.text);
    if (safeCandidate === undefined) return undefined;
    if (candidate.source === "planning") return `当前阶段“${safeCandidate}”仍在进行；操作已执行，正在核对页面结果。`;
    if (candidate.source === "declared_effect") return "已执行模型声明的操作步骤，正在核对页面结果。";
    return "已执行本轮模型提出的操作，正在核对页面结果。";
  }

  private activePlanTask(): PlanningTask | undefined {
    return this.activePlanTaskId === undefined ? undefined : this.planTasks.get(this.activePlanTaskId);
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

function latestInProgressTaskId(tasks: ReadonlyMap<string, PlanningTask>): string | undefined {
  const inProgress = [...tasks.values()].filter((task) => task.status === "in_progress");
  return inProgress.at(-1)?.id;
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

function normalizeKey(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}
