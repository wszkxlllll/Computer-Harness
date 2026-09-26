import { useEffect, useRef, useState } from "react";
import { CorrectionForm } from "./components/CorrectionForm";
import { ConnectionNote } from "./components/ConnectionNote";
import { EventTimeline } from "./components/EventTimeline";
import { PendingRequestPanel } from "./components/PendingRequestPanel";
import { PhoneLayout } from "./components/PhoneLayout";
import { ResultPanel } from "./components/ResultPanel";
import { ScreenshotPanel } from "./components/ScreenshotPanel";
import { StatusLabel, statusTextFor } from "./components/StatusLabel";
import { usePreferences } from "./PreferencesContext";
import { useRunCommands } from "./hooks/useRunCommands";
import { useRunFeed } from "./hooks/useRunFeed";
import type { PendingRequestBase } from "./types";

interface RunWorkspaceProps {
  runId: string;
}

interface ViewerReview {
  requestId?: string;
  request?: PendingRequestBase;
}

export function RunWorkspace({ runId }: RunWorkspaceProps) {
  const { snapshot, events, connection, error, refresh } = useRunFeed(runId);
  const commands = useRunCommands({ runId, snapshot, refresh });
  const [viewerReview, setViewerReview] = useState<ViewerReview>();
  const [blockedRequestId, setBlockedRequestId] = useState<string>();
  const [refreshingAfterViewer, setRefreshingAfterViewer] = useState(false);
  const runHeadingRef = useRef<HTMLHeadingElement>(null);
  const { preferences } = usePreferences();
  const isTerminal = snapshot?.status === "finished";

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

  useEffect(() => {
    const currentRequestId = snapshot?.pendingRequest?.requestId;
    if (blockedRequestId && blockedRequestId !== "*" && currentRequestId && currentRequestId !== blockedRequestId) {
      setBlockedRequestId(currentRequestId);
    }
  }, [blockedRequestId, snapshot?.pendingRequest?.requestId]);

  if (!snapshot) {
    return (
      <PhoneLayout active="tasks">
        <main className="page-shell run-page">
          <div className="loading-panel" role="status">正在读取任务状态…</div>
          {error && <div className="notice notice-error" role="alert">{error}</div>}
          <a className="button button-secondary" href="/">返回任务列表</a>
        </main>
      </PhoneLayout>
    );
  }

  const currentPending = snapshot.pendingRequest;
  const pending = currentPending ?? (viewerReview?.request ? viewerReview.request : undefined);
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

  async function refreshManually() {
    const fresh = await commands.refreshStatus();
    if (fresh) setBlockedRequestId(undefined);
  }

  return (
    <PhoneLayout active="tasks">
      <main className="page-shell run-page">
        <a className="back-link" href="/">← 返回任务列表</a>
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          当前任务状态：{statusTextFor(snapshot.status)}。{pending ? "有一项待处理请求。" : "没有待处理请求。"}
        </p>
        <section className="run-heading" aria-labelledby="run-goal">
          <div className="run-heading-top">
            <StatusLabel status={snapshot.status} />
            <ConnectionNote connection={connection} />
            <button className="text-button refresh-run" type="button" onClick={() => void refreshManually()}>刷新任务状态</button>
          </div>
          <h1 ref={runHeadingRef} id="run-goal" tabIndex={-1}>{snapshot.goal}</h1>
          {(snapshot.target?.appName || snapshot.target?.title) && (
            <p className="run-target-label">
              <span>运行窗口</span>
              <strong>{[snapshot.target?.appName, snapshot.target?.title].filter((value) => value?.trim()).join(" · ")}</strong>
            </p>
          )}
          {snapshot.error && <p className="notice notice-error" role="alert">{snapshot.error}</p>}
        </section>

        {commands.notice && <div className={`notice notice-${commands.notice.tone}`} role="status" aria-live="polite">{commands.notice.text}</div>}
        {error && <div className="notice notice-warning" role="status">{error}</div>}
        {refreshingAfterViewer && <p className="notice notice-info" role="status">正在重新读取任务状态；暂不发送请求…</p>}

        {pending && (
          <PendingRequestPanel
            request={pending}
            runId={runId}
            latestAssetId={snapshot.latestAssetId}
            busy={commands.busyCommand !== undefined || refreshingAfterViewer}
            canApprove={snapshot.capabilities.approval === true && !refreshingAfterViewer}
            canChooseWindow={snapshot.capabilities.windowHandoff === true && !refreshingAfterViewer && !requestBlocked}
            reviewBlocked={requestBlocked}
            onApprove={commands.actOnApproval}
            onRespond={commands.answerRequest}
            onChooseWindow={commands.chooseWindow}
            onIgnoreNewWindow={commands.ignoreNewWindow}
            onEvidenceViewerOpened={rememberViewerRequest}
            onEvidenceViewerClosed={(requestId) => void refreshAfterViewer(requestId)}
          />
        )}

        {hasControls && !isTerminal && (
          <section className="control-panel" aria-label="任务控制">
            <div className="control-panel-copy">
              <strong>任务控制</strong>
              <span>状态只会在电脑回报后更新。</span>
            </div>
            <div className="control-actions">
              {snapshot.capabilities.pause && <button className="button button-secondary button-large" type="button" disabled={commands.busyCommand !== undefined} onClick={() => void commands.control("pause")}>暂停</button>}
              {snapshot.capabilities.resume && <button className="button button-primary button-large" type="button" disabled={commands.busyCommand !== undefined} onClick={() => void commands.control("resume")}>继续任务</button>}
              {snapshot.capabilities.abort && <button className="button button-danger-outline button-large" type="button" disabled={commands.busyCommand !== undefined} onClick={() => void commands.control("abort")}>停止任务</button>}
            </div>
            <p className="control-footnote">暂停或停止请求仍需电脑回报；停止不会撤销已经完成的操作。</p>
          </section>
        )}

        {canCorrect && <CorrectionForm disabled={commands.busyCommand !== undefined} onSubmit={commands.correct} />}

        <ResultPanel reply={snapshot.reply} outcome={snapshot.outcome} />
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
