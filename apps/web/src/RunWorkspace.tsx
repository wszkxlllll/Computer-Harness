import { CorrectionForm } from "./components/CorrectionForm";
import { ConnectionNote } from "./components/ConnectionNote";
import { EventTimeline } from "./components/EventTimeline";
import { PendingRequestPanel } from "./components/PendingRequestPanel";
import { ResultPanel } from "./components/ResultPanel";
import { ScreenshotPanel } from "./components/ScreenshotPanel";
import { StatusLabel } from "./components/StatusLabel";
import { useRunCommands } from "./hooks/useRunCommands";
import { useRunFeed } from "./hooks/useRunFeed";

interface RunWorkspaceProps {
  runId: string;
}

export function RunWorkspace({ runId }: RunWorkspaceProps) {
  const { snapshot, events, connection, error, refresh } = useRunFeed(runId);
  const commands = useRunCommands({ runId, snapshot, refresh });
  const isTerminal = snapshot?.status === "finished";

  if (!snapshot) {
    return (
      <main className="page-shell">
        <div className="loading-panel" role="status">正在读取任务状态…</div>
        {error && <div className="notice notice-error" role="alert">{error}</div>}
        <a className="button button-secondary" href="/">返回任务列表</a>
      </main>
    );
  }

  const pending = snapshot.pendingRequest;
  const canCorrect = !isTerminal && snapshot.capabilities.correct === true && pending === undefined;
  const hasControls = snapshot.capabilities.pause || snapshot.capabilities.resume || snapshot.capabilities.abort;

  return (
    <main className="page-shell run-page">
      <a className="back-link" href="/">← 返回任务列表</a>
      <section className="run-heading" aria-labelledby="run-goal">
        <div className="run-heading-top">
          <StatusLabel status={snapshot.status} />
          <ConnectionNote connection={connection} />
          <button className="text-button refresh-run" type="button" onClick={() => void commands.refreshStatus()}>刷新状态</button>
        </div>
        <h1 id="run-goal">{snapshot.goal}</h1>
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

      {pending && (
        <PendingRequestPanel
          request={pending}
          busy={commands.busyCommand !== undefined}
          canApprove={snapshot.capabilities.approval === true}
          canChooseWindow={snapshot.capabilities.windowHandoff === true}
          onApprove={commands.actOnApproval}
          onRespond={commands.answerRequest}
          onChooseWindow={commands.chooseWindow}
          onIgnoreNewWindow={commands.ignoreNewWindow}
        />
      )}

      {hasControls && !isTerminal && (
        <section className="control-panel" aria-label="任务控制">
          <div className="control-panel-copy">
            <strong>电脑任务控制</strong>
            <span>状态只会在电脑回报后更新。</span>
          </div>
          <div className="control-actions">
            {snapshot.capabilities.pause && <button className="button button-secondary button-large" type="button" disabled={commands.busyCommand !== undefined} onClick={() => void commands.control("pause")}>暂停</button>}
            {snapshot.capabilities.resume && <button className="button button-primary button-large" type="button" disabled={commands.busyCommand !== undefined} onClick={() => void commands.control("resume")}>继续任务</button>}
            {snapshot.capabilities.abort && <button className="button button-danger button-large" type="button" disabled={commands.busyCommand !== undefined} onClick={() => void commands.control("abort")}>停止任务</button>}
          </div>
          <p className="control-footnote">暂停会等待电脑确认；停止不会撤销已经完成的操作。</p>
        </section>
      )}

      {canCorrect && <CorrectionForm disabled={commands.busyCommand !== undefined} onSubmit={commands.correct} />}

      <ResultPanel reply={snapshot.reply} outcome={snapshot.outcome} />
      <ScreenshotPanel runId={runId} assetId={snapshot.latestAssetId} />
      <EventTimeline events={events} />
    </main>
  );
}
