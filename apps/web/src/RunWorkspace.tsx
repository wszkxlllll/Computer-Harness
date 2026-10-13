import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent } from "react";
import { CorrectionForm } from "./components/CorrectionForm";
import { ConnectionNote } from "./components/ConnectionNote";
import { EventTimeline, eventLabel } from "./components/EventTimeline";
import { PendingRequestPanel } from "./components/PendingRequestPanel";
import { PhoneLayout } from "./components/PhoneLayout";
import { ResultPanel } from "./components/ResultPanel";
import { ScreenshotPanel } from "./components/ScreenshotPanel";
import { statusTextFor } from "./components/StatusLabel";
import { usePreferences } from "./PreferencesContext";
import { useRunCommands } from "./hooks/useRunCommands";
import { useRunFeed } from "./hooks/useRunFeed";
import type { PendingRequestBase, RemoteEvent, RunNotice } from "./types";
import { BrowserSpeechOutput, RunNoticeCursor, RunNoticeSpeechController, VOICE_INPUT_STARTED_EVENT } from "./run-notice-speech";
import { RunAnnouncementCursor } from "./run-accessibility";
import type { VoiceCapabilities } from "./voice-capabilities";
import type { VoiceSpeechRate } from "@computer-harness/voice";

interface RunWorkspaceProps {
  runId: string;
  voiceCapabilities?: VoiceCapabilities;
}

interface ViewerReview {
  requestId?: string;
  request?: PendingRequestBase;
}

export function RunWorkspace({ runId, voiceCapabilities }: RunWorkspaceProps) {
  const { snapshot, pendingRequestState, events, notices, connection, error, refresh } = useRunFeed(runId);
  const commands = useRunCommands({ runId, snapshot, refresh });
  const [viewerReview, setViewerReview] = useState<ViewerReview>();
  const [blockedRequestId, setBlockedRequestId] = useState<string>();
  const [refreshingAfterViewer, setRefreshingAfterViewer] = useState(false);
  const [retryingSnapshot, setRetryingSnapshot] = useState(false);
  const [voiceOutputMessage, setVoiceOutputMessage] = useState<string>();
  const [runAnnouncement, setRunAnnouncement] = useState("");
  const [activeVoiceInputs, setActiveVoiceInputs] = useState<ReadonlySet<string>>(() => new Set());
  const runHeadingRef = useRef<HTMLHeadingElement>(null);
  const initialSnapshotFocusHandledRef = useRef(false);
  const recoverableControlFocusRef = useRef<HTMLElement | undefined>(undefined);
  const focusedPendingElementRef = useRef<HTMLElement | undefined>(undefined);
  const previousPendingIdentityRef = useRef<string | undefined>(undefined);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const pendingRequestStateRef = useRef(pendingRequestState);
  pendingRequestStateRef.current = pendingRequestState;
  const pendingStateAheadOfSnapshot = Boolean(
    snapshot && pendingRequestState && pendingRequestState.sequence > snapshot.sequence,
  );
  const snapshotPending = snapshot?.pendingRequest;
  const currentPending = pendingStateAheadOfSnapshot ? pendingRequestState?.request : snapshotPending;
  const pendingRequestStale = pendingStateAheadOfSnapshot && !samePendingCommandTarget(currentPending, snapshotPending);
  const currentSpeechPendingRequest = () => pendingRequestStateRef.current === undefined
    ? snapshotRef.current?.pendingRequest
    : pendingRequestStateRef.current.request;
  const { preferences } = usePreferences();
  const autoNoticesEnabledRef = useRef(preferences.voice.runNoticesEnabled);
  const speechRate: VoiceSpeechRate = preferences.voice.speechRate === "slow"
    ? 0.85
    : preferences.voice.speechRate === "fast" ? 1.15 : 1;
  const speechController = useMemo(() => new RunNoticeSpeechController(
    () => voiceCapabilities?.createOutputAdapter?.() ?? new BrowserSpeechOutput(),
    setVoiceOutputMessage,
  ), [runId, voiceCapabilities]);
  const noticeCursor = useMemo(() => new RunNoticeCursor(runId), [runId]);
  const announcementCursor = useMemo(() => new RunAnnouncementCursor(runId), [runId]);
  const speechLifecycleRef = useRef(new Map<RunNoticeSpeechController, number>());
  const isTerminal = snapshot?.status === "finished";
  const voiceInputActive = activeVoiceInputs.size > 0;
  const latestProgressNotice = latestNoticeOfKind(notices, "progress");
  const latestProgressEvent = events.reduce<RemoteEvent | undefined>((latest, event) =>
    event.type === "run.progress" && (latest === undefined || event.sequence > latest.sequence) ? event : latest,
  undefined);
  const latestProgressText = selectLatestProgressText(latestProgressNotice, latestProgressEvent);

  useEffect(() => {
    if (!snapshot) return;
    const message = announcementCursor.update({
      runId,
      status: snapshot.status,
      connection,
      pending: currentPending,
      pendingSyncPending: pendingRequestStale,
      progressText: latestProgressText,
      outcome: snapshot.outcome,
      reply: snapshot.reply,
      snapshotError: snapshot.error,
      feedError: error,
      commandNotice: commands.notice?.text,
    });
    if (message) setRunAnnouncement(message);
  }, [announcementCursor, commands.notice?.text, connection, currentPending, error, latestProgressText, pendingRequestStale, runId, snapshot]);

  useLayoutEffect(() => {
    const previousIdentity = previousPendingIdentityRef.current;
    const currentIdentity = currentPending
      ? `${currentPending.requestId}:${currentPending.kind}`
      : undefined;
    if (previousIdentity && !currentIdentity) {
      const focusedElement = focusedPendingElementRef.current;
      if (focusedElement && !focusedElement.isConnected && document.activeElement === document.body) {
        focusedPendingElementRef.current = undefined;
        runHeadingRef.current?.focus();
      }
    }
    previousPendingIdentityRef.current = currentIdentity;
  }, [currentPending?.kind, currentPending?.requestId, pendingStateAheadOfSnapshot]);

  useLayoutEffect(() => {
    if (!snapshot || initialSnapshotFocusHandledRef.current) return;
    initialSnapshotFocusHandledRef.current = true;
    const main = document.getElementById("main-content");
    const modalOpen = document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
    if (document.activeElement === main && !modalOpen) runHeadingRef.current?.focus();
  }, [snapshot]);

  useLayoutEffect(() => {
    const focusedControl = recoverableControlFocusRef.current;
    if (!focusedControl || focusedControl.isConnected || document.activeElement !== document.body) return;
    recoverableControlFocusRef.current = undefined;
    runHeadingRef.current?.focus();
  });

  useEffect(() => {
    const clearRunControlFocus = () => { recoverableControlFocusRef.current = undefined; };
    window.addEventListener("blur", clearRunControlFocus);
    return () => window.removeEventListener("blur", clearRunControlFocus);
  }, []);

  useEffect(() => {
    const lifecycle = (speechLifecycleRef.current.get(speechController) ?? 0) + 1;
    speechLifecycleRef.current.set(speechController, lifecycle);
    return () => {
      // React StrictMode performs a setup/cleanup/setup probe. Defer disposal one microtask
      // so that probe setup can renew this controller before a real unmount cancels it.
      queueMicrotask(() => {
        if (speechLifecycleRef.current.get(speechController) !== lifecycle) return;
        speechLifecycleRef.current.delete(speechController);
        void speechController.cancel("run_changed");
      });
    };
  }, [speechController]);

  useEffect(() => {
    speechController.setSpeechRate(speechRate);
    const newNotices = noticeCursor.select(runId, notices, preferences.voice.runNoticesEnabled);
    if (!preferences.voice.runNoticesEnabled) {
      if (autoNoticesEnabledRef.current) void speechController.cancel("user");
      autoNoticesEnabledRef.current = false;
      return;
    }
    autoNoticesEnabledRef.current = true;
    for (const notice of newNotices) {
      void speechController.deliver(notice, {
        enabled: preferences.voice.runNoticesEnabled,
        speechRate,
        snapshotSequence: pendingRequestStateRef.current?.sequence ?? snapshotRef.current?.sequence,
        currentPendingRequest: currentSpeechPendingRequest,
      }).then((state) => {
        if (state === "handled") noticeCursor.acknowledge(notice.noticeId);
      });
    }
  }, [notices, noticeCursor, pendingRequestState?.request?.requestId, pendingRequestState?.request?.kind, pendingRequestState?.sequence, preferences.voice.runNoticesEnabled, runId, snapshot?.pendingRequest?.requestId, snapshot?.pendingRequest?.kind, snapshot?.sequence, speechController, speechRate]);

  useEffect(() => {
    speechController.syncPendingRequest(currentSpeechPendingRequest());
  }, [speechController, pendingRequestState?.request?.requestId, pendingRequestState?.request?.kind, pendingRequestState?.sequence, snapshot?.pendingRequest?.requestId, snapshot?.pendingRequest?.kind]);

  useEffect(() => {
    const onTextInput = (event: Event) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.matches("input, textarea, select, [contenteditable='true']")) {
        speechController.notifyUserStartedInput();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.matches("input, textarea, [contenteditable='true']") &&
          event.key.length === 1) speechController.notifyUserStartedInput();
    };
    const onVoiceInputStarted = () => speechController.notifyUserStartedInput();
    document.addEventListener("input", onTextInput, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener(VOICE_INPUT_STARTED_EVENT, onVoiceInputStarted);
    return () => {
      document.removeEventListener("input", onTextInput, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener(VOICE_INPUT_STARTED_EVENT, onVoiceInputStarted);
    };
  }, [speechController]);

  useEffect(() => {
    if (!snapshot || !viewerReview) return;
    const liveRequest = snapshot.pendingRequest;
    const sameRequest = Boolean(liveRequest
      && liveRequest.requestId === viewerReview.requestId
      && (!viewerReview.request || liveRequest.kind === viewerReview.request.kind));
    const noRequestWasOpen = viewerReview.requestId === undefined && viewerReview.request === undefined && liveRequest === undefined;
    if (sameRequest || noRequestWasOpen) return;

    setViewerReview(undefined);
    if (liveRequest) {
      setBlockedRequestId(liveRequest.requestId);
      commands.setNotice({ text: "你查看截图期间，待处理请求已变化。旧请求操作已停用，请先查看当前请求及其绑定画面。", tone: "warning" });
    } else {
      setBlockedRequestId(undefined);
    }
    window.requestAnimationFrame(() => runHeadingRef.current?.focus());
  }, [viewerReview, snapshot?.pendingRequest, commands.setNotice]);

  async function refreshManually() {
    if (retryingSnapshot) return;
    setRetryingSnapshot(true);
    try {
      const fresh = await commands.refreshStatus();
      if (fresh) setBlockedRequestId(undefined);
    } finally {
      setRetryingSnapshot(false);
    }
  }

  useEffect(() => {
    const currentRequestId = snapshot?.pendingRequest?.requestId;
    if (blockedRequestId && blockedRequestId !== "*" && currentRequestId && currentRequestId !== blockedRequestId) {
      setBlockedRequestId(currentRequestId);
    }
  }, [blockedRequestId, snapshot?.pendingRequest?.requestId]);

  if (!snapshot) {
    return (
      <PhoneLayout active="tasks">
        <main id="main-content" className="page-shell run-page" aria-label="任务状态" tabIndex={-1} onFocusCapture={handleMainFocusCapture} onBlurCapture={handleMainBlurCapture}>
          {error
            ? <div className="notice notice-error" role="alert">
              <p>暂时无法读取这项任务的最新状态。任务目前情况未知；连接中断不代表任务已经停止。</p>
              <details className="run-error-details">
                <summary>查看原因</summary>
                <p>{error}</p>
              </details>
              <button className="button button-secondary button-large run-retry" type="button" disabled={retryingSnapshot} onClick={() => void refreshManually()}>
                {retryingSnapshot ? "正在重新读取…" : "重试读取任务状态"}
              </button>
            </div>
            : <div className="loading-panel" role="status">正在读取任务状态…</div>}
          <a className="button button-secondary" href="/">返回任务列表</a>
        </main>
      </PhoneLayout>
    );
  }

  const pending = currentPending ?? (!pendingStateAheadOfSnapshot && viewerReview?.request ? viewerReview.request : undefined);
  const requestBlocked = blockedRequestId === "*" || Boolean(pending && blockedRequestId === pending.requestId);
  const canCorrect = !isTerminal && snapshot.capabilities.correct === true && currentPending === undefined;
  const hasControls = snapshot.capabilities.pause || snapshot.capabilities.resume || snapshot.capabilities.abort;

  function rememberViewerRequest(requestId?: string) {
    const request = currentPending;
    setViewerReview({ requestId, request: request?.requestId === requestId ? request : undefined });
  }

  async function refreshAfterViewer(requestId?: string) {
    setRefreshingAfterViewer(true);
    const fresh = await commands.refreshStatus();
    setRefreshingAfterViewer(false);
    setViewerReview(undefined);
    if (!fresh) {
      setBlockedRequestId(requestId ?? "*");
      return;
    }
    const nextRequestId = fresh.pendingRequest?.requestId;
    if (nextRequestId && nextRequestId !== requestId) {
      setBlockedRequestId(nextRequestId);
      commands.setNotice({ text: "你查看截图期间，待处理请求已变化。旧请求操作已停用，请先查看当前请求及其绑定画面。", tone: "warning" });
    } else {
      setBlockedRequestId(undefined);
    }
  }

  const currentProgressSpeechText = [
    `当前任务状态：${statusTextFor(snapshot.status)}。`,
    latestProgressText
      ? `最近一次进展：${latestProgressText}。这条进展来自电脑上一次回报，可能早于当前状态。`
      : "电脑目前没有可朗读的文字进展。",
    connection === "offline" || connection === "reconnecting"
      ? "手机与电脑暂时断开连接，电脑任务可能仍在继续；恢复连接后才能读取最新状态。"
      : undefined,
  ].filter((part): part is string => Boolean(part)).join(" ");
  const resultSpeechText = snapshot.reply
    ? `电脑返回的任务结果。${snapshot.reply}`
    : undefined;

  function speakManually(text: string) {
    if (voiceInputActive) return;
    setVoiceOutputMessage(undefined);
    void speechController.speakText(text, speechRate);
  }

  function updateVoiceInputActive(inputId: string, active: boolean) {
    setActiveVoiceInputs((current) => {
      if (current.has(inputId) === active) return current;
      const next = new Set(current);
      if (active) next.add(inputId);
      else next.delete(inputId);
      return next;
    });
  }

  function handleMainFocusCapture(event: FocusEvent<HTMLElement>) {
    const target = event.target;
    recoverableControlFocusRef.current = target instanceof HTMLElement && isRecoverableRunControl(target) ? target : undefined;
  }

  function handleMainBlurCapture(event: FocusEvent<HTMLElement>) {
    const nextTarget = event.relatedTarget;
    if (!(nextTarget instanceof Node) || nextTarget === document.body) return;
    recoverableControlFocusRef.current = nextTarget instanceof HTMLElement && isRecoverableRunControl(nextTarget)
      ? nextTarget
      : undefined;
  }

  return (
    <PhoneLayout active="tasks">
      <main id="main-content" className="page-shell run-page" aria-labelledby="run-goal" tabIndex={-1} onFocusCapture={handleMainFocusCapture} onBlurCapture={handleMainBlurCapture}>
        <a className="back-link" href="/">← 返回任务列表</a>
        <p className="sr-only" data-run-announcement="true" role="status" aria-live="polite" aria-atomic="true">{runAnnouncement}</p>
        <section className="run-heading" aria-labelledby="run-goal">
          <div className="run-heading-top">
            <ConnectionNote connection={connection} announce={false} />
            <button className="text-button refresh-run" type="button" disabled={retryingSnapshot} onClick={() => void refreshManually()}>
              {retryingSnapshot ? "正在读取…" : "刷新任务状态"}
            </button>
          </div>
          <h1 ref={runHeadingRef} id="run-goal" tabIndex={-1}>{snapshot.goal}</h1>
          {(snapshot.target?.appName || snapshot.target?.title || snapshot.target?.provenance === "unknown_after_switch" || snapshot.target?.provenance === "selected_target") && (
            <p className="run-target-label">
              <span>{snapshot.target?.provenance === "starting_target" ? "起始目标" : snapshot.target?.provenance === "selected_target" ? "最近确认目标" : snapshot.target?.provenance === "unknown_after_switch" ? "当前目标" : "运行目标"}</span>
              <strong>{snapshot.target?.provenance === "unknown_after_switch"
                ? "目标无法确认；请查看运行结果。"
                : [snapshot.target?.appName, snapshot.target?.title].filter((value) => value?.trim()).join(" · ") || "已确认窗口，名称不可用。"}</strong>
              {snapshot.target?.provenance === "selected_target" && <small>窗口名称来自最近一次选择时的主机清单，可能已变化；请以当前画面为准。</small>}
            </p>
          )}
          {snapshot.error && !(snapshot.status === "finished" && snapshot.outcome && !snapshot.reply) && (
            <details className="run-error-details">
              <summary>查看原因</summary>
              <p>{snapshot.error}</p>
            </details>
          )}
          {snapshot.status === "finished" && snapshot.ownerState === "pending_cleanup" && (
            <p className="notice notice-warning" role="status">
              任务已结束，但电脑尚未确认资源清理。请刷新任务状态；确认前不会开始新任务。若持续未确认，请在电脑端检查 Harness 状态。
            </p>
          )}
        </section>

        <section className="run-activity-panel" aria-labelledby="run-activity-title">
          <h2 id="run-activity-title" className="run-activity-heading">任务进度</h2>
          <p className="run-activity-current-status">
            <strong>{statusTextFor(snapshot.status)}</strong>
          </p>
          {latestProgressText
            ? <p className="run-activity-copy">上次进展：{latestProgressText}</p>
            : <p className="run-activity-copy">上次进展：暂无文字记录。</p>}
          {(connection === "offline" || connection === "reconnecting") && (
            <p className="run-activity-disconnected">
              手机与电脑连接暂时中断。电脑上的任务可能仍在继续；恢复连接后会读取最新状态。
            </p>
          )}
          <details className="run-activity-details">
            <summary>状态说明</summary>
            <p>进展文字可能早于当前状态。刷新只读取最新状态，不会重新开始任务。</p>
          </details>
          <RunSpeechActions
            voiceInputActive={voiceInputActive}
            hasResult={Boolean(resultSpeechText)}
            onReadProgress={() => speakManually(currentProgressSpeechText)}
            onReadResult={() => { if (resultSpeechText) speakManually(resultSpeechText); }}
            onStop={() => void speechController.cancel("user")}
          />
        </section>

        {commands.notice && <div className={`notice notice-${commands.notice.tone}`}>{commands.notice.text}</div>}
        {voiceOutputMessage && <p className="notice notice-warning" role="status" aria-live="polite">{voiceOutputMessage}</p>}
        {error && <div className="notice notice-warning">{error}</div>}
        {refreshingAfterViewer && <p className="notice notice-info" role="status">正在重新读取任务状态；暂不发送请求…</p>}

        {pending && (
          <PendingRequestPanel
            request={pending}
            announcementsManagedExternally
            runId={runId}
            latestAssetId={snapshot.latestAssetId}
            busy={commands.busyCommand !== undefined || refreshingAfterViewer || pendingRequestStale}
            canApprove={snapshot.capabilities.approval === true && !refreshingAfterViewer}
            canChooseWindow={snapshot.capabilities.windowHandoff === true && !refreshingAfterViewer && !requestBlocked}
            reviewBlocked={requestBlocked || pendingRequestStale}
            requestSyncPending={pendingRequestStale}
            onApprove={commands.actOnApproval}
            onRespond={commands.answerRequest}
            onChooseWindow={commands.chooseWindow}
            onIgnoreNewWindow={commands.ignoreNewWindow}
            onEvidenceViewerOpened={rememberViewerRequest}
            onEvidenceViewerClosed={(requestId) => void refreshAfterViewer(requestId)}
            onFocusedElementChange={(element) => { focusedPendingElementRef.current = element; }}
            onVoiceActiveChange={(active) => updateVoiceInputActive(`request:${pending.requestId}`, active)}
          />
        )}

        {hasControls && !isTerminal && (
          <section className="control-panel" aria-label="任务控制">
            <div className="control-panel-copy">
              <strong>任务控制</strong>
              <span>状态只会在电脑回报后更新。</span>
            </div>
            <div className="control-actions">
              {snapshot.capabilities.pause && <button className="button button-secondary button-large" type="button" disabled={commands.busyCommand !== undefined} onClick={() => void commands.control("pause")}>暂停任务</button>}
              {snapshot.capabilities.resume && <button className="button button-primary button-large" type="button" disabled={commands.busyCommand !== undefined} onClick={() => void commands.control("resume")}>继续任务</button>}
              {snapshot.capabilities.abort && <button className="button button-danger-outline button-large" type="button" disabled={commands.busyCommand !== undefined} onClick={() => void commands.control("abort")}>停止任务</button>}
            </div>
            <p className="control-footnote">暂停或停止请求仍需电脑回报；停止不会撤销已经完成的操作。</p>
          </section>
        )}

        {canCorrect && <CorrectionForm disabled={commands.busyCommand !== undefined} onVoiceActiveChange={(active) => updateVoiceInputActive("correction", active)} onSubmit={commands.correct} />}

        <ResultPanel reply={snapshot.reply} outcome={snapshot.outcome} error={snapshot.error} />
        {!(pending?.kind === "approval" && (pending.requiresVisualReview !== false || (pending.preview?.actions?.length ?? 0) > 0)) && (
          <ScreenshotPanel
            runId={runId}
            assetId={snapshot.latestAssetId}
            requestId={snapshot.pendingRequest?.requestId}
            onViewerOpened={rememberViewerRequest}
            onViewerClosed={(requestId) => void refreshAfterViewer(requestId)}
          />
        )}
        <EventTimeline events={events} simplified={preferences.presentation.layoutMode === "simple"} />
      </main>
    </PhoneLayout>
  );
}

function latestNoticeOfKind(notices: readonly RunNotice[], kind: RunNotice["kind"]): RunNotice | undefined {
  return notices.reduce<RunNotice | undefined>((latest, notice) => {
    if (notice.kind !== kind) return latest;
    const sequence = notice.feedSequence ?? notice.eventSequence;
    const latestSequence = latest?.feedSequence ?? latest?.eventSequence ?? -1;
    return sequence > latestSequence ? notice : latest;
  }, undefined);
}

function selectLatestProgressText(
  notice: RunNotice | undefined,
  event: RemoteEvent | undefined,
): string | undefined {
  const noticeSequence = notice?.feedSequence ?? notice?.eventSequence ?? -1;
  const eventSequence = event?.sequence ?? -1;
  if (notice && noticeSequence >= eventSequence) return notice.text;
  return event ? eventLabel(event) : notice?.text;
}

function samePendingCommandTarget(
  rendered: PendingRequestBase | undefined,
  snapshotPending: PendingRequestBase | undefined,
): boolean {
  if (!rendered || !snapshotPending) return rendered === snapshotPending;
  if (rendered.requestId !== snapshotPending.requestId || rendered.kind !== snapshotPending.kind) return false;
  if (rendered.kind === "approval") return approvalEvidenceKey(rendered) === approvalEvidenceKey(snapshotPending);
  if (rendered.kind === "window_handoff") {
    const renderedTokens = (rendered.candidates ?? []).map((candidate) => candidate.token).join("\u0000");
    const snapshotTokens = (snapshotPending.candidates ?? []).map((candidate) => candidate.token).join("\u0000");
    return rendered.reasonCode === snapshotPending.reasonCode && renderedTokens === snapshotTokens;
  }
  return true;
}

function isRecoverableRunControl(element: HTMLElement): boolean {
  return element.matches(".refresh-run, .run-retry, .control-panel button, .correction-form textarea, .correction-form button");
}

function approvalEvidenceKey(request: PendingRequestBase): string {
  const evidence = request.preview?.evidence;
  if (!evidence) return "";
  return [
    evidence.assetId,
    evidence.observationId,
    evidence.decisionObservationId,
    evidence.surfaceRef.surfaceId,
    evidence.surfaceRef.generation,
  ].join("\u0000");
}

interface RunSpeechActionsProps {
  voiceInputActive: boolean;
  hasResult: boolean;
  onReadProgress: () => void;
  onReadResult: () => void;
  onStop: () => void;
}

export function RunSpeechActions({ voiceInputActive, hasResult, onReadProgress, onReadResult, onStop }: RunSpeechActionsProps) {
  return (
    <div className="run-speech-actions" aria-label="语音辅助">
      <button className="button button-secondary" type="button" disabled={voiceInputActive} onClick={onReadProgress}>
        听听进度
      </button>
      {hasResult && (
        <button className="button button-secondary" type="button" disabled={voiceInputActive} onClick={onReadResult}>
          朗读结果
        </button>
      )}
      <button className="button button-secondary" type="button" onClick={onStop}>
        停止朗读
      </button>
    </div>
  );
}
