import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, createRun, listRuns, listWindowTargets } from "./api";
import { shouldClearAfterFailure } from "./command-id-registry";
import { GoalComposer } from "./components/GoalComposer";
import { PhoneLayout } from "./components/PhoneLayout";
import { StatusLabel } from "./components/StatusLabel";
import type { RunStatus, RunSummary, WindowTarget } from "./types";

const activeStatuses = new Set<RunStatus>(["created", "running", "waiting_user", "waiting_window", "waiting_approval", "paused"]);

export function HomeScreen() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [listError, setListError] = useState<string>();
  const [windowTargets, setWindowTargets] = useState<WindowTarget[]>([]);
  const [windowExpiresAt, setWindowExpiresAt] = useState<string>();
  const [windowTargetsLoading, setWindowTargetsLoading] = useState(true);
  const [windowTargetsExpired, setWindowTargetsExpired] = useState(false);
  const [selectedTargetToken, setSelectedTargetToken] = useState<string>();
  const [windowTargetsError, setWindowTargetsError] = useState<string>();
  const commandIdByTarget = useRef(new Map<string, string>());
  const activeRun = runs.find((run) => activeStatuses.has(run.status));
  const windowExpiresAtMs = windowExpiresAt ? Date.parse(windowExpiresAt) : Number.NaN;
  const hasCurrentTarget = selectedTargetToken !== undefined && windowTargets.some((candidate) => candidate.token === selectedTargetToken);
  const canStart = !windowTargetsLoading
    && !windowTargetsExpired
    && !windowTargetsError
    && Number.isFinite(windowExpiresAtMs)
    && windowExpiresAtMs > Date.now()
    && hasCurrentTarget;

  const refresh = useCallback(async () => {
    setListError(undefined);
    try {
      const current = await listRuns();
      setRuns(current);
    } catch (caught) {
      setListError(caught instanceof Error ? caught.message : "暂时无法读取任务。");
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshWindowTargets = useCallback(async () => {
    setWindowTargetsLoading(true);
    setWindowTargetsError(undefined);
    setWindowTargetsExpired(false);
    setSelectedTargetToken(undefined);
    setWindowTargets([]);
    setWindowExpiresAt(undefined);
    try {
      const result = await listWindowTargets();
      if (!Number.isFinite(Date.parse(result.expiresAt)) || !Array.isArray(result.candidates)) {
        throw new Error("电脑返回的窗口列表格式无效。请刷新后重试。");
      }
      setWindowTargets(result.candidates.filter((candidate) => typeof candidate?.token === "string" && candidate.token.length > 0));
      setWindowExpiresAt(result.expiresAt);
    } catch (caught) {
      setWindowTargetsError(caught instanceof Error ? caught.message : "暂时无法读取窗口列表。请稍后重试。");
    } finally {
      setWindowTargetsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void refreshWindowTargets();
  }, [refreshWindowTargets]);

  useEffect(() => {
    if (!windowExpiresAt) return;
    const expiresAt = Date.parse(windowExpiresAt);
    if (!Number.isFinite(expiresAt)) return;
    const expireSelection = () => {
      setWindowTargetsExpired(true);
      setSelectedTargetToken(undefined);
      setWindowTargetsError("窗口列表已过期。请刷新列表并重新选择目标，再开始任务。");
    };
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      expireSelection();
      return;
    }
    const timer = window.setTimeout(expireSelection, remaining);
    return () => window.clearTimeout(timer);
  }, [windowExpiresAt]);

  async function start(goal: string, targetToken: string) {
    if (activeRun) return;
    if (!Number.isFinite(windowExpiresAtMs) || windowExpiresAtMs <= Date.now() || !windowTargets.some((candidate) => candidate.token === targetToken)) {
      setWindowTargetsExpired(true);
      setSelectedTargetToken(undefined);
      setWindowTargetsError("所选窗口已过期或已变化。请刷新列表并重新选择目标。");
      return;
    }

    setSending(true);
    setError(undefined);
    const actionKey = `${goal}\u0000${targetToken}`;
    const commandId = commandIdByTarget.current.get(actionKey) ?? crypto.randomUUID();
    commandIdByTarget.current.set(actionKey, commandId);
    try {
      const response = await createRun(goal, commandId, targetToken);
      commandIdByTarget.current.delete(actionKey);
      window.location.assign(`/run/${encodeURIComponent(response.runId)}`);
    } catch (caught) {
      if (shouldClearAfterFailure(caught)) commandIdByTarget.current.delete(actionKey);
      if (caught instanceof ApiError && caught.code === "WINDOW_TARGET_STALE") {
        setSelectedTargetToken(undefined);
        setWindowTargets([]);
        setWindowExpiresAt(undefined);
        setWindowTargetsExpired(true);
        setWindowTargetsError(caught.message);
      } else {
        setError(caught instanceof Error ? caught.message : "任务没有发送成功。网络恢复后可以再次尝试。");
      }
      setSending(false);
    }
  }

  return (
    <PhoneLayout active="new">
      <main className="page-shell home-page">
        <h1 id="home-title" className="task-page-title">新任务</h1>

        {activeRun && (
          <section className="active-run-row" aria-labelledby="active-run-title">
            <StatusLabel status={activeRun.status} compact />
            <div className="active-run-row-copy">
              <h2 id="active-run-title">正在处理的任务</h2>
              <p>{activeRun.goal}</p>
            </div>
            <a className="button button-secondary" href={`/run/${encodeURIComponent(activeRun.runId)}`}>查看任务</a>
          </section>
        )}

        <GoalComposer
          disabled={activeRun !== undefined}
          busy={sending}
          canStart={canStart}
          targetPicker={{
            candidates: windowTargets,
            expiresAt: windowExpiresAt,
            loading: windowTargetsLoading,
            expired: windowTargetsExpired,
            disabled: activeRun !== undefined || sending,
            selectedToken: selectedTargetToken,
            error: windowTargetsError,
            onSelect: setSelectedTargetToken,
            onRefresh: () => void refreshWindowTargets(),
          }}
          onSubmit={start}
          error={error}
        />
        {activeRun && <p className="field-hint">当前电脑一次处理一个任务；当前任务结束后即可开始新的任务。</p>}

        <section className="history-section" aria-labelledby="history-title">
          <span id="recent-tasks" className="anchor-target" aria-hidden="true" />
          <div className="history-heading">
            <div>
              <h2 id="history-title">最近的任务</h2>
            </div>
            <button className="text-button" type="button" disabled={loading} onClick={() => void refresh()}>
              {loading ? "正在更新…" : "刷新列表"}
            </button>
          </div>
          {listError && <p className="notice notice-error" role="alert">{listError}</p>}
          {loading && <p className="loading-line" role="status">正在读取任务列表…</p>}
          {!loading && !listError && runs.length === 0 && (
            <div className="empty-state">
              <p className="empty-title">这里还没有任务</p>
              <p>在上方写下一个目标，电脑会从这里开始处理。</p>
            </div>
          )}
          {runs.length > 0 && (
            <ul className="run-list">
              {runs.map((run) => <RunListItem key={run.runId} run={run} />)}
            </ul>
          )}
        </section>
      </main>
    </PhoneLayout>
  );
}

function RunListItem({ run }: { run: RunSummary }) {
  return (
    <li>
      <a className="run-list-item" href={`/run/${encodeURIComponent(run.runId)}`}>
        <span className="run-list-copy">
          <span className="run-list-goal">{run.goal}</span>
          {run.reply && <span className="run-list-result">{run.reply}</span>}
        </span>
        <StatusLabel status={run.status} compact />
        <span className="run-list-arrow" aria-hidden="true">→</span>
      </a>
    </li>
  );
}
