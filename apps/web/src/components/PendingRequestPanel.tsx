import { useState, type FormEvent } from "react";
import { canIgnoreWindow } from "../command-contract";
import { ApprovalActionPreview } from "./ApprovalActionPreview";
import type { PendingRequestBase, WindowCandidate } from "../types";

interface PendingRequestPanelProps {
  request: PendingRequestBase;
  busy?: boolean;
  canApprove?: boolean;
  canChooseWindow?: boolean;
  onApprove: (approved: boolean) => Promise<void>;
  onRespond: (text: string) => Promise<boolean>;
  onChooseWindow: (candidate: WindowCandidate) => Promise<void>;
  onIgnoreNewWindow: () => Promise<void>;
}

export function PendingRequestPanel({
  request,
  busy = false,
  canApprove = true,
  canChooseWindow = true,
  onApprove,
  onRespond,
  onChooseWindow,
  onIgnoreNewWindow,
}: PendingRequestPanelProps) {
  const title = request.kind === "approval"
    ? "电脑请求你确认一项操作"
    : request.kind === "user_input"
      ? "电脑需要你补充信息"
      : "请选择电脑要继续使用的窗口";

  return (
    <section className="pending-panel" aria-labelledby="pending-title" aria-live="polite">
      <div className="section-kicker">需要你决定</div>
      <h2 id="pending-title">{title}</h2>
      {request.reason && <p className="pending-description">{request.reason}</p>}
      {request.question && <p className="pending-description">{request.question}</p>}
      {request.description && <p className="pending-description">{request.description}</p>}
      {request.kind === "approval" && (request.preview
        ? <ApprovalActionPreview preview={request.preview} />
        : <p className="notice notice-warning approval-preview-fallback" role="note">电脑未提供具体操作预览。请核对电脑当前画面；如果无法确认，请选择拒绝。</p>)}

      {request.kind === "approval" && canApprove && (
        <div className="decision-actions">
          <button className="button button-primary button-large" type="button" disabled={busy} onClick={() => void onApprove(true)}>
            确认这项操作
          </button>
          <button className="button button-secondary button-large" type="button" disabled={busy} onClick={() => void onApprove(false)}>
            拒绝
          </button>
        </div>
      )}
      {request.kind === "approval" && !canApprove && (
        <p className="field-hint" role="status">电脑暂时没有提供处理这项确认的能力，请刷新任务状态。</p>
      )}

      {request.kind === "user_input" && <UserReplyForm busy={busy} onSubmit={onRespond} />}

      {request.kind === "window_handoff" && canChooseWindow && (
        <div className="window-choice-list" role="group" aria-label="可选择的窗口">
          {(request.candidates ?? []).map((candidate) => (
            <button
              className="window-choice"
              key={candidate.token}
              type="button"
              disabled={busy}
              onClick={() => void onChooseWindow(candidate)}
            >
              <span className="window-choice-app">{candidate.appName || "电脑上的窗口"}</span>
              <span className="window-choice-title">{candidate.title || candidate.description || "窗口标题不可用"}</span>
              <span className="window-choice-arrow" aria-hidden="true">→</span>
            </button>
          ))}
          {(request.candidates ?? []).length === 0 && (
            <p className="field-hint">电脑还没有可供选择的窗口，请等待更新或停止任务。</p>
          )}
          {canIgnoreWindow(request) && (
            <button className="button button-secondary button-large" type="button" disabled={busy} onClick={() => void onIgnoreNewWindow()}>
              忽略这个新窗口，继续原目标
            </button>
          )}
        </div>
      )}
      {request.kind === "window_handoff" && !canChooseWindow && (
        <p className="field-hint" role="status">电脑暂时没有提供窗口选择，请刷新状态或停止任务。</p>
      )}
      {busy && <p className="quiet-note" role="status">正在等待电脑确认操作状态…</p>}
    </section>
  );
}

function UserReplyForm({ busy, onSubmit }: { busy: boolean; onSubmit: (text: string) => Promise<boolean> }) {
  const [text, setText] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = text.trim();
    if (!value || busy) return;
    if (await onSubmit(value)) setText("");
  }

  return (
    <form className="reply-form" onSubmit={submit}>
      <label htmlFor="request-reply">你的补充</label>
      <textarea id="request-reply" rows={3} value={text} onChange={(event) => setText(event.currentTarget.value)} required disabled={busy} />
      <button className="button button-primary button-large" type="submit" disabled={busy || !text.trim()}>发送补充</button>
    </form>
  );
}
