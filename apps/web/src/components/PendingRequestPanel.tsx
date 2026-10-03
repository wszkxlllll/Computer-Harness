import { useEffect, useRef, useState, type FormEvent } from "react";
import { canIgnoreWindow } from "../command-contract";
import { ApprovalActionParameters, ApprovalActionPreview } from "./ApprovalActionPreview";
import { ApprovalEvidencePanel } from "./ApprovalEvidencePanel";
import type { PendingRequestBase, WindowCandidate } from "../types";
import { VoiceInputControl } from "./VoiceInputControl";
import { appendVoiceInputText } from "../voice-input-text";
import type { VoiceAudioCaptureAdapter } from "@computer-harness/voice";

interface PendingRequestPanelProps {
  request: PendingRequestBase;
  runId?: string;
  latestAssetId?: string;
  busy?: boolean;
  canApprove?: boolean;
  canChooseWindow?: boolean;
  reviewBlocked?: boolean;
  voiceCaptureAdapterFactory?: (chunkBytes: number) => VoiceAudioCaptureAdapter;
  onApprove: (approved: boolean) => Promise<void>;
  onRespond: (text: string) => Promise<boolean>;
  onChooseWindow: (candidate: WindowCandidate) => Promise<void>;
  onIgnoreNewWindow: () => Promise<void>;
  onEvidenceViewerOpened?: (requestId: string) => void;
  onEvidenceViewerClosed?: (requestId: string, evidenceReviewed: boolean) => void;
}

export function PendingRequestPanel({
  request,
  runId,
  latestAssetId,
  busy = false,
  canApprove = true,
  canChooseWindow = true,
  reviewBlocked = false,
  voiceCaptureAdapterFactory,
  onApprove,
  onRespond,
  onChooseWindow,
  onIgnoreNewWindow,
  onEvidenceViewerOpened = () => undefined,
  onEvidenceViewerClosed = () => undefined,
}: PendingRequestPanelProps) {
  const [loadedEvidenceKey, setLoadedEvidenceKey] = useState<string>();
  const [announcement, setAnnouncement] = useState(`有一项待处理请求：${request.kind === "approval" ? "电脑请求你确认一项操作" : request.kind === "user_input" ? "电脑需要你补充信息" : "请选择电脑要继续使用的窗口"}。`);
  const announcedRequestIdentity = useRef(`${request.requestId}:${request.kind}`);
  const title = request.kind === "approval"
    ? "电脑请求你确认一项操作"
    : request.kind === "user_input"
      ? "电脑需要你补充信息"
      : "请选择电脑要继续使用的窗口";
  const actions = Array.isArray(request.preview?.actions) ? request.preview.actions : [];
  const isComputerActionApproval = request.kind === "approval"
    && (request.requiresVisualReview !== false || actions.length > 0);
  const evidence = request.preview?.evidence;
  const evidenceKey = evidence?.assetId ? `${request.requestId}:${evidence.assetId}` : undefined;
  const evidenceCanBeReviewed = Boolean(runId && evidenceKey);
  const evidenceLoaded = Boolean(evidenceKey && loadedEvidenceKey === evidenceKey);
  const canSubmitApproval = canApprove && !reviewBlocked && (!isComputerActionApproval || (evidenceCanBeReviewed && evidenceLoaded));
  const controlsDisabled = busy || reviewBlocked;

  useEffect(() => {
    const currentIdentity = `${request.requestId}:${request.kind}`;
    if (announcedRequestIdentity.current !== currentIdentity) {
      announcedRequestIdentity.current = currentIdentity;
      setAnnouncement(`当前请求已更新：${title}。请重新阅读后再决定。`);
    }
  }, [request.requestId, request.kind, title]);

  return (
    <section className="pending-panel" aria-labelledby="pending-title">
      <h2 id="pending-title">{title}</h2>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
      {request.kind === "approval" && request.reason && !isComputerActionApproval && <p className="pending-description">{request.reason}</p>}
      {request.kind === "approval" && ((isComputerActionApproval && request.reason) || actions.length > 0) && (
        <details className="approval-more-details">
          <summary>更多信息</summary>
          {isComputerActionApproval && request.reason && <p>{request.reason}</p>}
          {request.preview && <ApprovalActionParameters preview={request.preview} />}
        </details>
      )}
      {request.kind !== "approval" && request.reason && <p className="pending-description">{request.reason}</p>}
      {request.question && <p className="pending-description">{request.question}</p>}
      {request.description && <p className="pending-description">{request.description}</p>}
      {request.kind === "approval" && request.preview && <ApprovalActionPreview preview={request.preview} />}
      {request.kind === "approval" && evidence && evidenceCanBeReviewed && (
        <ApprovalEvidencePanel
          runId={runId!}
          requestId={request.requestId}
          evidence={evidence}
          latestAssetId={latestAssetId}
          onImageAvailabilityChange={(requestId, assetId, loaded) => {
            const currentKey = `${request.requestId}:${evidence.assetId}`;
            if (requestId !== request.requestId || assetId !== evidence.assetId) return;
            setLoadedEvidenceKey(loaded ? currentKey : undefined);
          }}
          onViewerOpened={onEvidenceViewerOpened}
          onViewerClosed={(requestId, didReview) => {
            onEvidenceViewerClosed(requestId, didReview);
          }}
        />
      )}
      {request.kind === "approval" && isComputerActionApproval && !evidenceCanBeReviewed && (
        <p className="notice notice-error approval-preview-fallback" role="alert">这项电脑操作没有可打开的请求绑定画面，无法核对目标；暂时不能批准。请刷新任务状态，或拒绝这项请求。</p>
      )}
      {request.kind === "approval" && !request.preview && (
        <p className="notice notice-warning approval-preview-fallback" role="note">电脑没有提供操作参数。请根据请求说明自行判断是否处理。</p>
      )}
      {request.kind === "approval" && isComputerActionApproval && evidenceCanBeReviewed && !evidenceLoaded && (
        <p className="approval-review-required" role="status">载入请求绑定的画面后，才可以批准这项电脑操作；你也可以拒绝请求。</p>
      )}
      {reviewBlocked && (
        <p className="notice notice-warning" role="alert">任务状态发生变化或无法刷新。请重新读取当前请求，再作决定或发送补充。</p>
      )}
      {request.kind === "approval" && busy && reviewBlocked && (
        <p className="field-hint" role="status">正在重新读取任务状态，当前决定暂不可用。</p>
      )}

      {request.kind === "approval" && canApprove && (
        <div className="decision-actions">
          <button className="button button-primary button-large" type="button" disabled={controlsDisabled || !canSubmitApproval} onClick={() => void onApprove(true)}>
            允许这项操作
          </button>
          <button className="button button-secondary button-large" type="button" disabled={controlsDisabled} onClick={() => void onApprove(false)}>
            拒绝
          </button>
        </div>
      )}
      {request.kind === "approval" && !canApprove && !reviewBlocked && (
        <p className="field-hint" role="status">电脑暂时没有提供处理这项确认的能力，请刷新任务状态。</p>
      )}

      {request.kind === "user_input" && <UserReplyForm key={request.requestId} busy={controlsDisabled} voiceCaptureAdapterFactory={voiceCaptureAdapterFactory} onSubmit={onRespond} />}

      {request.kind === "window_handoff" && canChooseWindow && (
        <div className="window-choice-list" role="group" aria-label="可选择的窗口">
          {(request.candidates ?? []).map((candidate) => (
            <button
              className="window-choice"
              key={candidate.token}
              type="button"
              disabled={controlsDisabled}
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
            <button className="button button-secondary button-large" type="button" disabled={controlsDisabled} onClick={() => void onIgnoreNewWindow()}>
              忽略这个新窗口，继续原目标
            </button>
          )}
        </div>
      )}
      {request.kind === "window_handoff" && !canChooseWindow && (
        <p className="field-hint" role="status">{reviewBlocked ? "任务状态未同步；请刷新状态后再选择窗口。" : "电脑暂时没有提供窗口选择，请刷新状态或停止任务。"}</p>
      )}
      {busy && <p className="quiet-note" role="status">正在等待电脑确认操作状态…</p>}
    </section>
  );
}

function UserReplyForm({ busy, voiceCaptureAdapterFactory, onSubmit }: { busy: boolean; voiceCaptureAdapterFactory?: (chunkBytes: number) => VoiceAudioCaptureAdapter; onSubmit: (text: string) => Promise<boolean> }) {
  const [text, setText] = useState("");
  const [voiceActive, setVoiceActive] = useState(false);
  const formDisabled = busy || voiceActive;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = text.trim();
    if (!value || formDisabled) return;
    if (await onSubmit(value)) setText("");
  }

  return (
    <form className="reply-form" onSubmit={submit}>
      <label htmlFor="request-reply">你的补充</label>
      <textarea id="request-reply" rows={3} value={text} onChange={(event) => setText(event.currentTarget.value)} required disabled={formDisabled} />
      <VoiceInputControl disabled={busy} onActiveChange={setVoiceActive} onTranscript={(recognized) => setText((current) => appendVoiceInputText(current, recognized))} createCaptureAdapter={voiceCaptureAdapterFactory} />
      <button className="button button-primary button-large" type="submit" disabled={formDisabled || !text.trim()}>发送补充</button>
    </form>
  );
}
