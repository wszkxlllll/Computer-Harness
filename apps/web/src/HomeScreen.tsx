import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, createRun, listRuns, listWindowTargets, previewWindowTarget } from "./api";
import { shouldClearAfterFailure } from "./command-id-registry";
import { GoalComposer } from "./components/GoalComposer";
import { PhoneLayout } from "./components/PhoneLayout";
import { StatusLabel } from "./components/StatusLabel";
import type { BrowserSiteChoice, RunStatus, RunSummary, RunTarget, WindowCandidatePreview, WindowTarget } from "./types";
import { isValidBrowserUrl } from "./run-target";
import { usePreferences } from "./PreferencesContext";
import { toRunAssistantPreferencesSnapshot } from "./preferences";
import { announceBrowserText } from "./run-notice-speech";
import { navigateWithinApp } from "./navigation";

const activeStatuses = new Set<RunStatus>(["created", "running", "waiting_user", "waiting_window", "waiting_approval", "paused"]);

export function HomeScreen({ commonSiteChoices = [] }: { commonSiteChoices?: readonly BrowserSiteChoice[] }) {
  const { preferences } = usePreferences();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [listError, setListError] = useState<string>();
  const [windowTargets, setWindowTargets] = useState<WindowTarget[]>([]);
  const [windowPreviews, setWindowPreviews] = useState<Map<string, WindowCandidatePreview>>(() => new Map());
  const [windowPreviewErrors, setWindowPreviewErrors] = useState<Map<string, string>>(() => new Map());
  const [windowPreviewLoadingToken, setWindowPreviewLoadingToken] = useState<string>();
  const [omittedAmbiguousWindowCount, setOmittedAmbiguousWindowCount] = useState(0);
  const [goalDraft, setGoalDraft] = useState("");
  const [windowExpiresAt, setWindowExpiresAt] = useState<string>();
  const [windowTargetsLoading, setWindowTargetsLoading] = useState(false);
  const [windowTargetsExpired, setWindowTargetsExpired] = useState(false);
  const [selectedTargetToken, setSelectedTargetToken] = useState<string>();
  const [selectedWindowPreviewToken, setSelectedWindowPreviewToken] = useState<string>();
  const [windowSelectionGoal, setWindowSelectionGoal] = useState<string>();
  const [windowSelectionNeedsConfirmation, setWindowSelectionNeedsConfirmation] = useState(false);
  const [windowTargetsError, setWindowTargetsError] = useState<string>();
  // Web tasks are the safest default for phone-driven work: the managed
  // browser provides observation-bound DOM actions instead of unverified native
  // coordinate clicks. Native windows remain available via the explicit picker.
  const [targetMode, setTargetMode] = useState<RunTarget["mode"]>("browser");
  const [browserUrl, setBrowserUrl] = useState("");
  const [browserSetupRequired, setBrowserSetupRequired] = useState(false);
  const commandIdByTarget = useRef(new Map<string, string>());
  const startInFlight = useRef(false);
  const previewAbortController = useRef<AbortController | undefined>(undefined);
  const activeRun = runs.find((run) => activeStatuses.has(run.status)) ??
    runs.find((run) => run.status === "finished" && run.ownerState === "pending_cleanup");
  const activeRunAwaitingCleanup = activeRun?.status === "finished" && activeRun.ownerState === "pending_cleanup";
  const windowExpiresAtMs = windowExpiresAt ? Date.parse(windowExpiresAt) : Number.NaN;
  const hasCurrentTarget = selectedTargetToken !== undefined && windowTargets.some((candidate) => candidate.token === selectedTargetToken);
  const selectedTargetCandidate = windowTargets.find((candidate) => candidate.token === selectedTargetToken);
  const selectedPreview = selectedTargetToken === undefined ? undefined : windowPreviews.get(selectedTargetToken);
  const selectedPreviewIsCurrent = selectedPreview !== undefined && Date.parse(selectedPreview.expiresAt) > Date.now() && selectedWindowPreviewToken === selectedPreview.previewToken;
  const canStart = !loading && !listError && !activeRun && !sending && (
    targetMode === "auto"
    || targetMode === "desktop"
    || (targetMode === "browser" && (!browserUrl.trim() || isValidBrowserUrl(browserUrl)))
    || (targetMode === "window"
      && !windowTargetsLoading
      && !windowTargetsExpired
      && !windowTargetsError
      && Number.isFinite(windowExpiresAtMs)
      && windowExpiresAtMs > Date.now()
      && hasCurrentTarget
      && (selectedTargetCandidate?.previewRequired !== true || selectedPreviewIsCurrent)
      && !windowSelectionNeedsConfirmation
      && windowSelectionGoal === goalDraft.trim())
  );

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
    previewAbortController.current?.abort();
    previewAbortController.current = undefined;
    setWindowTargetsLoading(true);
    setWindowTargetsError(undefined);
    setWindowTargetsExpired(false);
    setSelectedTargetToken(undefined);
    setWindowSelectionGoal(undefined);
    setWindowTargets([]);
    setWindowPreviews(new Map());
    setWindowPreviewErrors(new Map());
    setWindowPreviewLoadingToken(undefined);
    setSelectedWindowPreviewToken(undefined);
    setOmittedAmbiguousWindowCount(0);
    setWindowExpiresAt(undefined);
    try {
      const result = await listWindowTargets();
      if (!Number.isFinite(Date.parse(result.expiresAt)) || !Array.isArray(result.candidates) ||
          result.omittedAmbiguousCount !== undefined && (!Number.isSafeInteger(result.omittedAmbiguousCount) || result.omittedAmbiguousCount < 0)) {
        throw new Error("电脑返回的窗口列表格式无效。请刷新后重试。");
      }
      setWindowTargets(result.candidates.filter((candidate) => typeof candidate?.token === "string" && candidate.token.length > 0));
      setOmittedAmbiguousWindowCount(result.omittedAmbiguousCount ?? 0);
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

  useEffect(() => () => previewAbortController.current?.abort(), []);

  useEffect(() => {
    if (!windowExpiresAt) return;
    const expiresAt = Date.parse(windowExpiresAt);
    if (!Number.isFinite(expiresAt)) return;
    const expireSelection = () => {
      setWindowTargetsExpired(true);
      setSelectedTargetToken(undefined);
      setSelectedWindowPreviewToken(undefined);
      setWindowPreviews(new Map());
      setWindowPreviewErrors(new Map());
      setWindowSelectionGoal(undefined);
      setWindowSelectionNeedsConfirmation(false);
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

  useEffect(() => {
    if (selectedPreview === undefined) return;
    const expiresAt = Date.parse(selectedPreview.expiresAt);
    if (!Number.isFinite(expiresAt)) return;
    const expireProof = () => setSelectedWindowPreviewToken(undefined);
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      expireProof();
      return;
    }
    const timer = window.setTimeout(expireProof, remaining + 1);
    return () => window.clearTimeout(timer);
  }, [selectedPreview?.expiresAt, selectedWindowPreviewToken]);

  function changeTargetMode(mode: RunTarget["mode"]) {
    setTargetMode(mode);
    setError(undefined);
    setBrowserSetupRequired(false);
    if (mode !== "window") {
      setSelectedTargetToken(undefined);
      setSelectedWindowPreviewToken(undefined);
      setWindowSelectionGoal(undefined);
      setWindowSelectionNeedsConfirmation(false);
      previewAbortController.current?.abort();
      previewAbortController.current = undefined;
      setWindowPreviews(new Map());
      setWindowPreviewErrors(new Map());
      setWindowPreviewLoadingToken(undefined);
    }
    if (mode === "window") void refreshWindowTargets();
  }

  function changeGoalDraft(value: string) {
    setGoalDraft(value);
    if (targetMode === "window" && selectedTargetToken !== undefined && windowSelectionGoal !== value.trim()) {
      setSelectedTargetToken(undefined);
      setWindowSelectionGoal(undefined);
      setWindowSelectionNeedsConfirmation(true);
    }
  }

  async function start(goal: string, target: RunTarget) {
    if (loading || listError || activeRun || sending || startInFlight.current) return;
    if (target.mode === "window") {
      const targetToken = target.targetToken;
      if (!Number.isFinite(windowExpiresAtMs) || windowExpiresAtMs <= Date.now() || !windowTargets.some((candidate) => candidate.token === targetToken)) {
        setWindowTargetsExpired(true);
        setSelectedTargetToken(undefined);
        setWindowSelectionGoal(undefined);
        setWindowTargetsError("所选窗口已过期或已变化。请刷新列表并重新选择目标。");
        return;
      }
      if (windowSelectionGoal !== goal.trim()) {
        setSelectedTargetToken(undefined);
        setWindowSelectionGoal(undefined);
        setWindowSelectionNeedsConfirmation(true);
        return;
      }
      const selected = windowTargets.find((candidate) => candidate.token === targetToken);
      const preview = windowPreviews.get(targetToken);
      if (selected?.previewRequired === true && (preview === undefined || selectedWindowPreviewToken !== preview.previewToken || Date.parse(preview.expiresAt) <= Date.now())) {
        setError("请重新查看这个精确窗口的预览，并确认后再开始任务。");
        return;
      }
      if (selected?.previewRequired === true && preview !== undefined) target = { ...target, previewToken: preview.previewToken };
    }
    if (target.mode === "browser" && target.url !== undefined && !isValidBrowserUrl(target.url)) return;

    startInFlight.current = true;
    let actionKey: string | undefined;
    try {
      setSending(true);
      setError(undefined);
      setBrowserSetupRequired(false);
      if (preferences.voice.runNoticesEnabled) {
        const rate = preferences.voice.speechRate === "slow" ? 0.85 : preferences.voice.speechRate === "fast" ? 1.15 : 1;
        announceBrowserText("正在发送任务。", rate);
      }
      const assistantPreferences = toRunAssistantPreferencesSnapshot(preferences.assistant);
      actionKey = JSON.stringify([goal, target, assistantPreferences, preferences.voice.runNoticesEnabled]);
      const commandId = commandIdByTarget.current.get(actionKey) ?? crypto.randomUUID();
      commandIdByTarget.current.set(actionKey, commandId);
      const response = await createRun(goal, commandId, target, assistantPreferences, preferences.voice.runNoticesEnabled);
      navigateWithinApp(`/run/${encodeURIComponent(response.runId)}`);
      commandIdByTarget.current.delete(actionKey);
    } catch (caught) {
      if (actionKey !== undefined && (shouldClearAfterFailure(caught) || (caught instanceof ApiError && caught.code === "WINDOW_DISCOVERY_FAILED"))) {
        commandIdByTarget.current.delete(actionKey);
      }
      if (caught instanceof ApiError && caught.code === "WINDOW_SELECTION_REQUIRED" && target.mode === "auto") {
        setTargetMode("window");
        setSelectedTargetToken(undefined);
        setError(caught.message);
        void refreshWindowTargets();
      } else if (caught instanceof ApiError && caught.code === "WINDOW_TARGET_STALE" && target.mode === "window") {
        previewAbortController.current?.abort();
        previewAbortController.current = undefined;
        setSelectedTargetToken(undefined);
        setSelectedWindowPreviewToken(undefined);
        setWindowSelectionGoal(undefined);
        setWindowSelectionNeedsConfirmation(false);
        setWindowTargets([]);
        setWindowPreviews(new Map());
        setWindowPreviewErrors(new Map());
        setWindowPreviewLoadingToken(undefined);
        setOmittedAmbiguousWindowCount(0);
        setWindowExpiresAt(undefined);
        setWindowTargetsExpired(true);
        setWindowTargetsError(caught.message);
      } else if (caught instanceof ApiError && caught.code === "MANAGED_BROWSER_SETUP_REQUIRED") {
        setBrowserSetupRequired(true);
        setError(caught.message);
      } else {
        setError(caught instanceof Error ? caught.message : "任务没有发送成功。网络恢复后可以再次尝试。");
        if (caught instanceof ApiError && caught.code === "RUN_BUSY") void refresh();
      }
    } finally {
      startInFlight.current = false;
      setSending(false);
    }
  }

  async function previewWindow(candidateToken: string) {
    const requiresPreviewConfirmation = windowTargets.find((candidate) => candidate.token === candidateToken)?.previewRequired === true;
    previewAbortController.current?.abort();
    const controller = new AbortController();
    previewAbortController.current = controller;
    if (requiresPreviewConfirmation) {
      setSelectedTargetToken(undefined);
      setSelectedWindowPreviewToken(undefined);
      setWindowSelectionGoal(undefined);
    }
    setWindowPreviews((current) => {
      const next = new Map(current);
      next.delete(candidateToken);
      return next;
    });
    setWindowPreviewLoadingToken(candidateToken);
    setWindowPreviewErrors((current) => {
      const next = new Map(current);
      next.delete(candidateToken);
      return next;
    });
    try {
      const preview = await previewWindowTarget(candidateToken, controller.signal);
      if (controller.signal.aborted || previewAbortController.current !== controller) return;
      setWindowPreviews((current) => new Map(current).set(candidateToken, preview));
      if (requiresPreviewConfirmation && selectedTargetToken === candidateToken) setSelectedWindowPreviewToken(undefined);
    } catch (caught) {
      if (controller.signal.aborted || previewAbortController.current !== controller) return;
      setWindowPreviewErrors((current) => new Map(current).set(candidateToken, caught instanceof Error ? caught.message : "无法读取这个精确窗口，请在电脑恢复后刷新列表。"));
    } finally {
      if (previewAbortController.current === controller) {
        previewAbortController.current = undefined;
        setWindowPreviewLoadingToken(undefined);
      }
    }
  }

  return (
    <PhoneLayout active="new">
      <main id="main-content" className="page-shell home-page" tabIndex={-1}>
        <h1 id="home-title" className="task-page-title" tabIndex={-1}>新任务</h1>

        {activeRun && (
          <section className="active-run-row" aria-labelledby="active-run-title">
            <StatusLabel status={activeRun.status} compact />
            <div className="active-run-row-copy">
              <h2 id="active-run-title">{activeRunAwaitingCleanup ? "电脑收尾尚未确认" : "正在处理的任务"}</h2>
              <p>{activeRun.goal}</p>
            </div>
            <a className="button button-secondary" href={`/run/${encodeURIComponent(activeRun.runId)}`}>查看任务</a>
          </section>
        )}
        {activeRunAwaitingCleanup && (
          <p className="notice notice-warning" role="status">
            任务已结束，但电脑尚未确认资源清理；确认前不会发送新任务。刷新任务列表；如果持续如此，请在电脑端检查 Harness 状态。
          </p>
        )}

        <GoalComposer
          disabled={activeRun !== undefined}
          busy={sending}
          canStart={canStart}
          targetMode={targetMode}
          browserUrl={browserUrl}
          commonSiteChoices={commonSiteChoices}
          onTargetModeChange={changeTargetMode}
          onGoalChange={changeGoalDraft}
          onBrowserUrlChange={setBrowserUrl}
          targetPicker={{
            candidates: windowTargets,
            expiresAt: windowExpiresAt,
            omittedAmbiguousCount: omittedAmbiguousWindowCount,
            selectionNeedsConfirmation: windowSelectionNeedsConfirmation,
            loading: windowTargetsLoading,
            expired: windowTargetsExpired,
            disabled: activeRun !== undefined || sending,
            selectedToken: selectedTargetToken,
            selectedPreviewToken: selectedWindowPreviewToken,
            previews: windowPreviews,
            previewErrors: windowPreviewErrors,
            previewLoadingToken: windowPreviewLoadingToken,
            error: windowTargetsError,
            onPreview: (token) => void previewWindow(token),
            onSelect: (token, previewToken) => {
              setSelectedTargetToken(token);
              setSelectedWindowPreviewToken(previewToken);
              setWindowSelectionGoal(goalDraft.trim());
              setWindowSelectionNeedsConfirmation(false);
            },
            onRefresh: () => void refreshWindowTargets(),
          }}
          onSubmit={start}
          error={error}
          setupRequired={browserSetupRequired}
        />
        {activeRun && !activeRunAwaitingCleanup && <p className="field-hint">当前电脑一次处理一个任务；当前任务结束后即可开始新的任务。</p>}

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
