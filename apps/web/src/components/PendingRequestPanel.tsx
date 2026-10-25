import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type FormEvent } from "react";
import { canIgnoreWindow } from "../command-contract";
import { previewWindowHandoffCandidate } from "../api";
import { ApprovalActionParameters, ApprovalActionPreview } from "./ApprovalActionPreview";
import { ApprovalEvidencePanel } from "./ApprovalEvidencePanel";
import type { PendingRequestBase, WindowCandidate, WindowCandidatePreview } from "../types";
import { VoiceInputControl } from "./VoiceInputControl";
import { appendVoiceInputText } from "../voice-input-text";
import type { VoiceAudioCaptureAdapter } from "@computer-harness/voice";
import { pendingRequestAnnouncement, pendingRequestKey } from "../run-accessibility";

interface PendingRequestPanelProps {
  request: PendingRequestBase;
  runId?: string;
  latestAssetId?: string;
  busy?: boolean;
  canApprove?: boolean;
  canChooseWindow?: boolean;
  reviewBlocked?: boolean;
  requestSyncPending?: boolean;
  announcementsManagedExternally?: boolean;
  voiceCaptureAdapterFactory?: (chunkBytes: number) => VoiceAudioCaptureAdapter;
  onVoiceActiveChange?: (active: boolean) => void;
  onFocusedElementChange?: (element?: HTMLElement) => void;
  onApprove: (approved: boolean) => Promise<void>;
  onRespond: (text: string) => Promise<boolean>;
  onChooseWindow: (candidate: WindowCandidate, previewToken?: string) => Promise<void>;
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
  requestSyncPending = false,
  announcementsManagedExternally = false,
  voiceCaptureAdapterFactory,
  onVoiceActiveChange,
  onFocusedElementChange,
  onApprove,
  onRespond,
  onChooseWindow,
  onIgnoreNewWindow,
  onEvidenceViewerOpened = () => undefined,
  onEvidenceViewerClosed = () => undefined,
}: PendingRequestPanelProps) {
  const [loadedEvidenceKey, setLoadedEvidenceKey] = useState<string>();
  const [windowPreviews, setWindowPreviews] = useState<Map<string, WindowCandidatePreview>>(() => new Map());
  const [windowPreviewErrors, setWindowPreviewErrors] = useState<Map<string, string>>(() => new Map());
  const [loadedWindowPreviewTokens, setLoadedWindowPreviewTokens] = useState<Set<string>>(() => new Set());
  const [windowPreviewDisplayErrors, setWindowPreviewDisplayErrors] = useState<Map<string, string>>(() => new Map());
  const [windowPreviewLoadingToken, setWindowPreviewLoadingToken] = useState<string>();
  const previewAbort = useRef<AbortController | undefined>(undefined);
  const sectionRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusedElementRef = useRef<HTMLElement | undefined>(undefined);
  const onFocusedElementChangeRef = useRef(onFocusedElementChange);
  onFocusedElementChangeRef.current = onFocusedElementChange;
  const [currentTime, setCurrentTime] = useState(Date.now());
  const handoffCandidatesByToken = new Map<string, WindowCandidate>();
  if (request.kind === "window_handoff") {
    for (const candidate of request.candidates ?? []) {
      if (!handoffCandidatesByToken.has(candidate.token)) handoffCandidatesByToken.set(candidate.token, candidate);
    }
  }
  const handoffCandidates = [...handoffCandidatesByToken.values()];
  const handoffCandidateKey = handoffCandidates.map((candidate) => candidate.token).join("\u0000");
  const handoffLabelCounts = new Map<string, number>();
  for (const candidate of handoffCandidates) {
    const key = windowCandidateLabelKey(candidate);
    handoffLabelCounts.set(key, (handoffLabelCounts.get(key) ?? 0) + 1);
  }
  const requiresCandidatePreview = (candidate: WindowCandidate): boolean =>
    candidate.previewRequired === true || !candidate.appName?.trim() || !candidate.title?.trim() ||
    (handoffLabelCounts.get(windowCandidateLabelKey(candidate)) ?? 0) > 1;
  const [announcement, setAnnouncement] = useState("");
  const requestAnnouncementKey = pendingRequestKey(request);
  const announcedRequestKey = useRef(requestAnnouncementKey);
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

  useLayoutEffect(() => {
    if (announcedRequestKey.current === requestAnnouncementKey) return;
    const previousKey = announcedRequestKey.current;
    announcedRequestKey.current = requestAnnouncementKey;
    if (!announcementsManagedExternally) {
      setAnnouncement(pendingRequestAnnouncement(request, previousKey !== undefined));
    }

    const focusedElement = focusedElementRef.current;
    if (previousKey !== undefined && focusedElement && !focusedElement.isConnected && document.activeElement === document.body) {
      headingRef.current?.focus();
    }
  }, [announcementsManagedExternally, request, requestAnnouncementKey]);

  useLayoutEffect(() => {
    previewAbort.current?.abort();
    previewAbort.current = undefined;
    setWindowPreviews(new Map());
    setWindowPreviewErrors(new Map());
    setLoadedWindowPreviewTokens(new Set());
    setWindowPreviewDisplayErrors(new Map());
    setWindowPreviewLoadingToken(undefined);
    return () => previewAbort.current?.abort();
  }, [request.requestId, runId, handoffCandidateKey]);

  useEffect(() => {
    const nextExpiry = [...windowPreviews.values()]
      .map((preview) => Date.parse(preview.expiresAt))
      .filter((expiresAt) => Number.isFinite(expiresAt) && expiresAt > Date.now())
      .sort((left, right) => left - right)[0];
    if (nextExpiry === undefined) return;
    const timer = window.setTimeout(() => setCurrentTime(Date.now()), Math.max(1, nextExpiry - Date.now() + 1));
    return () => window.clearTimeout(timer);
  }, [windowPreviews, currentTime]);

  useEffect(() => {
    const onWindowBlur = () => {
      focusedElementRef.current = undefined;
      onFocusedElementChangeRef.current?.(undefined);
    };
    window.addEventListener("blur", onWindowBlur);
    return () => window.removeEventListener("blur", onWindowBlur);
  }, []);

  function handleFocusCapture(event: FocusEvent<HTMLElement>) {
    if (!(event.target instanceof HTMLElement)) return;
    focusedElementRef.current = event.target;
    onFocusedElementChangeRef.current?.(event.target);
  }

  function handleBlurCapture(event: FocusEvent<HTMLElement>) {
    const nextTarget = event.relatedTarget;
    if (!(nextTarget instanceof Node) || event.currentTarget.contains(nextTarget) || nextTarget === document.body) return;
    focusedElementRef.current = undefined;
    onFocusedElementChangeRef.current?.(undefined);
  }

  async function previewCandidate(candidate: WindowCandidate) {
    if (runId === undefined) {
      setWindowPreviewErrors((current) => new Map(current).set(candidate.token, "无法确认这是当前任务的候选窗口，请刷新任务状态。"));
      return;
    }
    previewAbort.current?.abort();
    const controller = new AbortController();
    previewAbort.current = controller;
    const previousPreview = windowPreviews.get(candidate.token);
    setWindowPreviews((current) => {
      if (!current.has(candidate.token)) return current;
      const next = new Map(current);
      next.delete(candidate.token);
      return next;
    });
    if (previousPreview !== undefined) {
      setLoadedWindowPreviewTokens((current) => {
        if (!current.has(previousPreview.previewToken)) return current;
        const next = new Set(current);
        next.delete(previousPreview.previewToken);
        return next;
      });
      setWindowPreviewDisplayErrors((current) => {
        if (!current.has(previousPreview.previewToken)) return current;
        const next = new Map(current);
        next.delete(previousPreview.previewToken);
        return next;
      });
    }
    setWindowPreviewLoadingToken(candidate.token);
    setWindowPreviewErrors((current) => {
      const next = new Map(current);
      next.delete(candidate.token);
      return next;
    });
    try {
      const preview = await previewWindowHandoffCandidate(runId, request.requestId, candidate.token, controller.signal);
      if (controller.signal.aborted || previewAbort.current !== controller) return;
      setWindowPreviews((current) => new Map(current).set(candidate.token, preview));
      setWindowPreviewDisplayErrors((current) => {
        const next = new Map(current);
        next.delete(preview.previewToken);
        return next;
      });
    } catch (caught) {
      if (controller.signal.aborted || previewAbort.current !== controller) return;
      setWindowPreviewErrors((current) => new Map(current).set(candidate.token,
        `${caught instanceof Error ? caught.message : "无法预览此窗口。"} 请在电脑上恢复目标窗口后刷新；仍无法区分时请停止任务，不要仅凭相同标题选择。`));
    } finally {
      if (previewAbort.current === controller) {
        previewAbort.current = undefined;
        setWindowPreviewLoadingToken(undefined);
      }
    }
  }

  function renderCandidatePreview(
    candidate: WindowCandidate,
    candidateIndex: number,
    requiresConfirmation: boolean,
    candidateName: string,
    candidatePosition: string,
  ) {
    const preview = windowPreviews.get(candidate.token);
    if (preview === undefined) return null;
    const previewValid = Date.parse(preview.expiresAt) > currentTime;
    const previewLoaded = loadedWindowPreviewTokens.has(preview.previewToken);
    const previewDisplayError = windowPreviewDisplayErrors.get(preview.previewToken);
    return <div className="window-choice-preview-block">
      <span className="window-choice-app">捕获时应用：{preview.appName || "应用名不可用"}</span>
      <span className="window-choice-title">捕获时标题：{preview.title || "窗口标题不可用"} · {formatCapturedAt(preview.capturedAt)}</span>
      <span className="window-choice-title">{preview.relationship ? windowRelationshipLabel(preview.relationship) : "捕获时关系未验证"}</span>
      <img
        src={`data:image/png;base64,${preview.dataBase64}`}
        alt={`${preview.appName ?? "未知应用"}：${preview.title ?? "未知窗口"} 的实时窗口预览，第 ${candidateIndex + 1} 个候选`}
        onLoad={() => setLoadedWindowPreviewTokens((current) => new Set(current).add(preview.previewToken))}
        onError={() => {
          setLoadedWindowPreviewTokens((current) => {
            const next = new Set(current);
            next.delete(preview.previewToken);
            return next;
          });
          setWindowPreviewDisplayErrors((current) => new Map(current).set(preview.previewToken, "这张实时截图无法显示。请在电脑恢复目标窗口后刷新；仍看不清时请停止任务。"));
        }}
      />
      {previewDisplayError && <p className="notice notice-warning" role="alert">{previewDisplayError}</p>}
      {requiresConfirmation
        ? <>
          <p className="field-hint">请确认截图中显示的窗口就是本次要继续使用的窗口。若画面不清楚或不一致，请勿确认；无法区分时请在电脑恢复窗口后刷新，或停止任务。</p>
          {previewValid && previewLoaded && previewDisplayError === undefined
            ? <button
              className="button button-primary button-large"
              type="button"
              aria-label={`确认 ${candidateName}（${candidatePosition}）并继续任务`}
              disabled={controlsDisabled}
              onClick={() => void onChooseWindow(candidate, preview.previewToken)}
            >
              确认这个窗口并继续任务
            </button>
            : previewValid
              ? <p className="field-hint" role="status">实时截图成功显示后才能确认；截图看不清时不要选择。</p>
              : <p className="field-hint" role="status">此预览已过期。重新读取当前窗口后才能选择。</p>}
        </>
        : previewValid && previewLoaded && previewDisplayError === undefined
          ? <p className="field-hint" role="status">可选预览已显示；选择此窗口仍按原有确认规则进行。</p>
          : previewValid
            ? <p className="field-hint" role="status">正在载入可选预览；此窗口的选择不会因此改变。</p>
            : <p className="field-hint" role="status">此可选预览已过期。重新读取后可以查看当前画面。</p>}
    </div>;
  }

  return (
    <section ref={sectionRef} className="pending-panel" aria-labelledby="pending-title" onFocusCapture={handleFocusCapture} onBlurCapture={handleBlurCapture}>
      <h2 ref={headingRef} id="pending-title" tabIndex={-1}>{title}</h2>
      {!announcementsManagedExternally && <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>}
      {request.kind === "approval" && isComputerActionApproval && request.reason && (
        <div className="approval-request-reason">
          <p className="pending-description">{request.reason}</p>
          <p className="field-hint">这段文字说明本身不是屏幕证据；请核对下方与本次请求绑定的画面，无法核对时请拒绝。</p>
        </div>
      )}
      {request.kind === "approval" && request.reason && !isComputerActionApproval && <p className="pending-description">{request.reason}</p>}
      {request.kind === "approval" && (actions.length > 0 || request.preview !== undefined) && (
        <details className="approval-more-details" key={`approval-details:${request.requestId}`}>
          <summary>更多操作参数</summary>
          {request.preview && <ApprovalActionParameters preview={request.preview} />}
        </details>
      )}
      {request.kind !== "approval" && request.reason && <p className="pending-description">{request.reason}</p>}
      {request.question && <p className="pending-description">{request.question}</p>}
      {request.description && <p className="pending-description">{request.description}</p>}
      {request.kind === "approval" && request.preview && <ApprovalActionPreview key={`approval-preview:${request.requestId}`} preview={request.preview} />}
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
      {request.kind === "approval" && !isComputerActionApproval && !request.preview && (
        <p className="notice notice-warning approval-preview-fallback" role="note">电脑没有提供操作参数。请根据请求说明自行判断是否处理。</p>
      )}
      {request.kind === "approval" && isComputerActionApproval && evidenceCanBeReviewed && !evidenceLoaded && (
        <p className="approval-review-required" role="status">载入请求绑定的画面后，才可以批准这项电脑操作；你也可以拒绝请求。</p>
      )}
      {requestSyncPending && (
        <p className="field-hint" role={announcementsManagedExternally ? undefined : "status"}>
          电脑刚报告了新的待处理请求。正在同步当前状态；同步完成前不能处理。也可使用页面顶部的“刷新任务状态”重新读取。
        </p>
      )}
      {reviewBlocked && !requestSyncPending && (
        <p className="notice notice-warning" role="alert">任务状态发生变化或无法刷新。请重新读取当前请求，再作决定或发送补充。</p>
      )}
      {request.kind === "approval" && busy && reviewBlocked && !requestSyncPending && (
        <p className="field-hint" role="status">正在重新读取任务状态，当前决定暂不可用。</p>
      )}

      {request.kind === "approval" && canApprove && (
        <div className="decision-actions" key={`approval-decision:${request.requestId}`}>
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

      {request.kind === "user_input" && <UserReplyForm key={request.requestId} busy={controlsDisabled} voiceCaptureAdapterFactory={voiceCaptureAdapterFactory} onVoiceActiveChange={onVoiceActiveChange} onSubmit={onRespond} />}

      {request.kind === "window_handoff" && canChooseWindow && (
        <div className="window-choice-list" key={`window-choices:${request.requestId}`} role="group" aria-label="可选择的窗口">
          {handoffCandidates.some(requiresCandidatePreview) && (
            <p className="field-hint" role="status">标签重复或不完整的候选需要先看对应的真实画面。读屏名称和图片替代文字不能核实截图中的真实窗口内容；无法亲自核对时，请勿确认。若截图不清楚或仍无法区分，请在电脑恢复窗口后刷新，或停止任务。</p>
          )}
          {handoffCandidates.map((candidate, candidateIndex) => {
            const previewRequired = requiresCandidatePreview(candidate);
            const candidateName = candidate.restoreCurrentManagedBrowser === true
              ? "本任务的托管浏览器"
              : [candidate.appName, candidate.title || candidate.description]
              .filter((value) => value?.trim())
              .join(" · ") || "电脑上的窗口";
            const candidatePosition = `第 ${candidateIndex + 1} 个候选窗口`;
            const previewAction = windowPreviewLoadingToken === candidate.token
              ? "正在读取"
              : windowPreviews.has(candidate.token) ? "重新读取" : "查看";
            const candidateLabel = <>
              <span className="window-choice-app">{candidate.appName || "电脑上的窗口"}</span>
              <span className="window-choice-title">{candidate.title || candidate.description || "窗口标题不可用"}</span>
              {candidate.relationship && <span className="window-choice-title">{windowRelationshipLabel(candidate.relationship)}</span>}
            </>;
            const previewControls = <>
              <button className="button button-secondary" type="button" disabled={controlsDisabled || windowPreviewLoadingToken !== undefined} onClick={() => void previewCandidate(candidate)}>
                <span className="sr-only">{previewAction} {candidateName} 的真实画面，{candidatePosition}</span>
                <span aria-hidden="true">{windowPreviewLoadingToken === candidate.token ? "正在读取此窗口…" : windowPreviews.has(candidate.token) ? "重新读取窗口预览" : "查看此窗口的真实画面"}</span>
              </button>
              {windowPreviewLoadingToken === candidate.token && <p className="field-hint" role="status">正在读取这个精确候选，不会激活或操作它。</p>}
              {windowPreviewErrors.get(candidate.token) && <p className="notice notice-warning" role="alert">{windowPreviewErrors.get(candidate.token)}</p>}
              {renderCandidatePreview(candidate, candidateIndex, previewRequired, candidateName, candidatePosition)}
            </>;
            return previewRequired
              ? <div className="window-choice-preview-item" key={candidate.token} role="group" aria-label={`候选窗口：${candidateName}，${candidatePosition}`}>
                {candidateLabel}
                {previewControls}
              </div>
              : <div className="window-choice-preview-item" key={candidate.token} role="group" aria-label={`候选窗口：${candidateName}，${candidatePosition}`}>
                <button
                  className="window-choice"
                  type="button"
                  aria-label={candidate.restoreCurrentManagedBrowser === true
                    ? "恢复本任务的托管浏览器并继续"
                    : `选择 ${candidateName}，${candidatePosition}`}
                  disabled={controlsDisabled}
                  onClick={() => void onChooseWindow(candidate)}
                >
                  {candidate.restoreCurrentManagedBrowser === true
                    ? <><span className="window-choice-app">恢复本任务的托管浏览器</span><span className="window-choice-title">重新读取精确窗口并继续；刚才被拒绝的操作不会重放</span></>
                    : candidateLabel}
                  <span className="window-choice-arrow" aria-hidden="true">→</span>
                </button>
                {previewControls}
              </div>;
          })}
          {handoffCandidates.length === 0 && (
            <p className="field-hint">{request.omittedCandidateCount
              ? `有 ${request.omittedCandidateCount} 个候选超出安全显示上限，未显示。请在电脑整理窗口后刷新；仍没有可辨认目标时请停止任务。`
              : "电脑还没有可供选择的窗口，请等待更新或停止任务。"}</p>
          )}
          {(request.omittedCandidateCount ?? 0) > 0 && (
            <p className="field-hint" role="status">
              有 {request.omittedCandidateCount} 个候选超出安全显示上限，未显示。最近截图不是这些窗口的实时预览，不能用来确认它们。
            </p>
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

function windowRelationshipLabel(relationship: NonNullable<WindowCandidate["relationship"]>): string {
  if (relationship.kind === "scoped_peer") return "电脑已授权的另一窗口";
  const role = relationship.rootRole === "dialog" ? "对话框"
    : relationship.rootRole === "menu" ? "菜单"
      : relationship.rootRole === "popup" ? "弹出窗口"
        : "所属子窗口";
  const parent = [relationship.parentAppName, relationship.parentTitle].filter((value) => value?.trim()).join(" · ");
  return parent ? `当前 ${parent} 的${role}` : `当前目标的${role}`;
}

function windowCandidateLabelKey(candidate: WindowCandidate): string {
  const normalize = (value: string | undefined) => value?.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim() ?? "";
  return `${normalize(candidate.appName)}\u0000${normalize(candidate.title)}`;
}

function formatCapturedAt(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? `电脑读取于 ${new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date)}`
    : "读取时间未知";
}

function UserReplyForm({ busy, voiceCaptureAdapterFactory, onVoiceActiveChange, onSubmit }: { busy: boolean; voiceCaptureAdapterFactory?: (chunkBytes: number) => VoiceAudioCaptureAdapter; onVoiceActiveChange?: (active: boolean) => void; onSubmit: (text: string) => Promise<boolean> }) {
  const [text, setText] = useState("");
  const [voiceActive, setVoiceActive] = useState(false);
  const formDisabled = busy || voiceActive;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = text.trim();
    if (!value || formDisabled) return;
    if (await onSubmit(value)) setText("");
  }

  function updateVoiceActive(active: boolean) {
    setVoiceActive(active);
    onVoiceActiveChange?.(active);
  }

  return (
    <form className="reply-form" onSubmit={submit}>
      <label htmlFor="request-reply">你的补充</label>
      <textarea id="request-reply" rows={3} value={text} onChange={(event) => setText(event.currentTarget.value)} required disabled={formDisabled} />
      <VoiceInputControl disabled={busy} onActiveChange={updateVoiceActive} onTranscript={(recognized) => setText((current) => appendVoiceInputText(current, recognized))} createCaptureAdapter={voiceCaptureAdapterFactory} />
      <button className="button button-primary button-large" type="submit" disabled={formDisabled || !text.trim()}>发送补充</button>
    </form>
  );
}
