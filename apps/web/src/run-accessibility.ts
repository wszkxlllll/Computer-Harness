import type { ApprovalActionPreviewItem, PendingRequestBase, RunOutcome, RunStatus } from "./types";
import { statusTextFor } from "./components/StatusLabel";

export type RunAnnouncementConnection = "loading" | "live" | "reconnecting" | "offline";

export interface RunAnnouncementInput {
  runId: string;
  status: RunStatus;
  connection: RunAnnouncementConnection;
  pending?: PendingRequestBase;
  pendingSyncPending?: boolean;
  progressText?: string;
  outcome?: RunOutcome;
  reply?: string;
  snapshotError?: string;
  feedError?: string;
  commandNotice?: string;
}

interface RunAnnouncementSnapshot extends RunAnnouncementInput {
  pendingKey?: string;
  resultKey?: string;
}

/** Produces one concise announcement for meaningful Run changes, never for the initial snapshot or feed cursor churn. */
export class RunAnnouncementCursor {
  private runId: string;
  private previous?: RunAnnouncementSnapshot;
  private announcedPendingKey?: string;
  private readonly announcedProgressText = new Set<string>();

  public constructor(runId: string) {
    this.runId = runId;
  }

  public update(input: RunAnnouncementInput): string {
    if (input.runId !== this.runId) {
      this.runId = input.runId;
      this.previous = undefined;
      this.announcedPendingKey = undefined;
      this.announcedProgressText.clear();
    }

    const current = snapshotForAnnouncements(input);
    if (!this.previous) {
      this.previous = current;
      if (current.progressText) this.announcedProgressText.add(current.progressText);
      return "";
    }

    const previous = this.previous;
    this.previous = current;
    const messages: string[] = [];
    const pendingChanged = current.pendingKey !== previous.pendingKey;
    const resultChanged = current.resultKey !== previous.resultKey && current.status === "finished";
    const terminalChanged = current.status === "finished" && (previous.status !== "finished" || resultChanged);

    if (pendingChanged && current.pending) {
      messages.push(pendingRequestAnnouncement(current.pending, previous.pending !== undefined));
      this.announcedPendingKey = current.pendingKey;
    } else if (pendingChanged && previous.pending && !terminalChanged && current.status === previous.status) {
      messages.push(current.pendingSyncPending
        ? "电脑更新了待处理请求。正在同步最新任务状态。"
        : `待处理请求已结束。当前任务状态：${statusTextFor(current.status)}。`);
      this.announcedPendingKey = undefined;
    }

    if (terminalChanged) {
      messages.push(terminalAnnouncement(current.outcome, current.reply, current.snapshotError));
    } else if (
      current.status !== previous.status &&
      !pendingChanged &&
      !(current.pendingKey !== undefined && current.pendingKey === this.announcedPendingKey)
    ) {
      messages.push(`任务状态已更新：${statusTextFor(current.status)}。`);
    }

    const progressText = current.progressText?.trim();
    if (progressText && progressText !== previous.progressText && !this.announcedProgressText.has(progressText)) {
      this.announcedProgressText.add(progressText);
      messages.push(`最近进展：${progressText}`);
      while (this.announcedProgressText.size > 64) {
        this.announcedProgressText.delete(this.announcedProgressText.values().next().value as string);
      }
    }

    if (current.connection !== previous.connection && current.connection !== "loading") {
      messages.push(connectionAnnouncement(current.connection, current.feedError));
    } else if (current.feedError && current.feedError !== previous.feedError) {
      messages.push(`暂时无法读取最新任务状态：${current.feedError}`);
    }

    if (current.commandNotice && current.commandNotice !== previous.commandNotice) {
      messages.push(current.commandNotice);
    }

    return [...new Set(messages.filter(Boolean))].join(" ");
  }
}

export function pendingRequestAnnouncement(request: PendingRequestBase, replaced = false): string {
  if (request.kind === "approval") {
    const actions = Array.isArray(request.preview?.actions) ? request.preview.actions : [];
    const context = [request.reason, request.description]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value))
      .filter((value, index, values) => values.indexOf(value) === index);
    const actionText = actions.length > 0
      ? `待批准操作：${actions.slice(0, 16).map(actionSummary).join("；")}${actions.length > 16 ? `；另有 ${actions.length - 16} 项` : ""}。`
      : "电脑没有提供具体操作摘要。";
    const needsVisualReview = request.requiresVisualReview !== false || actions.length > 0;
    const reviewBoundary = needsVisualReview
      ? "文字说明和操作摘要不能核实电脑当前画面；无法核对目标或后果时，请拒绝或请可信任的人协助。"
      : "请阅读请求说明后再决定。";
    return `${replaced ? "当前待处理请求已更换。" : "有一项待处理确认。"}${context.length ? `原因：${context.join(" ")}。` : "请求没有提供原因。"}${actionText}${reviewBoundary}`;
  }

  if (request.kind === "user_input") {
    const context = [request.question, request.reason, request.description]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value))
      .filter((value, index, values) => values.indexOf(value) === index);
    return `${replaced ? "电脑的补充请求已更新。" : "电脑需要你补充信息。"}${context.length ? `问题或说明：${context.join(" ")}` : "电脑没有提供问题说明。"}`;
  }

  if (request.kind === "window_handoff") {
    const visibleCount = request.candidates?.length ?? 0;
    const omittedCount = request.omittedCandidateCount ?? 0;
    const candidateText = visibleCount > 0
      ? `当前显示 ${visibleCount} 个候选窗口。`
      : omittedCount > 0
        ? `没有显示可选窗口；另有 ${omittedCount} 个候选超出安全显示上限。`
        : "当前没有可选窗口。";
    const context = [request.reason, request.description]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value))
      .filter((value, index, values) => values.indexOf(value) === index);
    return `${replaced ? "窗口选择请求已更新。" : "任务正在等待你选择一个窗口。"}${context.length ? `${context.join(" ")}。` : ""}${candidateText}请核对候选窗口后再选择。`;
  }

  const title = typeof request.title === "string" && request.title.trim() ? request.title.trim() : "电脑需要你处理一项请求";
  const context = [request.reason, request.question, request.description]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index);
  return `${replaced ? "待处理请求已更换。" : "有一项待处理请求。"}${title}。${context.join(" ")}`.trim();
}

function snapshotForAnnouncements(input: RunAnnouncementInput): RunAnnouncementSnapshot {
  const resultKey = input.status === "finished"
    ? [input.outcome ?? "unknown", input.reply ?? "", input.snapshotError ?? ""].join("\u0000")
    : undefined;
  return {
    ...input,
    progressText: input.progressText?.trim() || undefined,
    feedError: input.feedError?.trim() || undefined,
    commandNotice: input.commandNotice?.trim() || undefined,
    pendingKey: pendingRequestKey(input.pending),
    resultKey,
  };
}

export function pendingRequestKey(request: PendingRequestBase | undefined): string | undefined {
  if (!request) return undefined;
  const fields = [request.requestId, request.kind, request.title, request.reason, request.question, request.description];
  const actionSummaries = (request.preview?.actions ?? []).slice(0, 16).map(actionSummary);
  const candidateLabels = (request.candidates ?? []).map((candidate) => [candidate.appName, candidate.title, candidate.description].filter(Boolean).join(" "));
  return [...fields, ...actionSummaries, ...candidateLabels, request.omittedCandidateCount].map((value) => value ?? "").join("\u0000");
}

function actionSummary(action: ApprovalActionPreviewItem): string {
  if (action.kind === "click") return "点击";
  if (action.kind === "double_click") return "双击";
  if (action.kind === "right_click") return "右键点击";
  if (action.kind === "type") {
    const count = action.typedCharacterCount;
    return typeof count === "number" && Number.isFinite(count) && count >= 0
      ? `输入 ${new Intl.NumberFormat("zh-CN").format(Math.floor(count))} 字`
      : "输入文本";
  }
  if (action.kind === "keypress") {
    const keys = action.keys?.filter((key) => typeof key === "string" && key.length > 0).slice(0, 8) ?? [];
    return keys.length ? `按 ${keys.join(" + ")}` : "键盘操作";
  }
  if (action.kind === "scroll") return "滚动";
  if (action.kind === "switch_window") return "切换窗口";
  if (action.kind === "wait") return "等待";
  return "电脑操作";
}

function terminalAnnouncement(outcome: RunOutcome | undefined, reply: string | undefined, error: string | undefined): string {
  const outcomeLabel = outcome === "succeeded" ? "已完成"
    : outcome === "failed" ? "未完成"
      : outcome === "cancelled" ? "已停止"
        : outcome === "budget_exhausted" ? "已达到本次限制"
          : outcome === "outcome_unknown" ? "结果待确认" : "结果待核实";
  const resultText = reply?.trim()
    ? "电脑返回的文字结果已显示在任务结果中。"
    : "任务结果说明已显示在任务结果中。";
  const errorText = error?.trim() ? `原因：${error.trim()}` : "";
  return `任务已结束。结果状态：${outcomeLabel}。${resultText}${errorText}`;
}

function connectionAnnouncement(connection: RunAnnouncementConnection, feedError?: string): string {
  const text = connection === "live"
    ? "手机与电脑的任务状态连接已恢复。任务是否完成仍以电脑回报为准。"
    : connection === "offline"
      ? "手机与电脑的任务状态连接中断。电脑上的任务可能仍在继续；连接恢复后才能读取最新状态。"
      : "手机正在重新连接电脑的任务状态。电脑上的任务可能仍在继续。";
  return feedError ? `${text}读取说明：${feedError}` : text;
}
