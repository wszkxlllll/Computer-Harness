import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { getRun, runEventsUrl } from "../api";
import { decideSequence, reconnectCursor } from "../event-sequence";
import type { PendingRequestBase, RemoteEvent, RunNotice, RunSnapshot } from "../types";

export type FeedConnection = "loading" | "live" | "reconnecting" | "offline";

const RECONNECT_WARNING_DELAY_MS = 12_000;
const RECONNECT_WARNING = "连接已中断超过 12 秒，正在自动重连。请检查手机网络；恢复后提示会自动消失。";

export interface RunFeedState {
  snapshot?: RunSnapshot;
  pendingRequestState?: { sequence: number; request?: PendingRequestBase };
  events: RemoteEvent[];
  notices: RunNotice[];
  connection: FeedConnection;
  error?: string;
  refresh: () => Promise<RunSnapshot>;
}

function decodePendingRequestUpdate(event: RemoteEvent): { request?: PendingRequestBase } | undefined {
  const data = event.data;
  if (!data || data.type !== "run.pending_request") return undefined;
  if (data.cleared === true && data.request === undefined) return {};
  const request = data.request;
  if (typeof request !== "object" || request === null || Array.isArray(request)) return undefined;
  const value = request as Record<string, unknown>;
  if (typeof value.requestId !== "string" || value.requestId.length === 0 || typeof value.kind !== "string") return undefined;
  return { request: { ...value, requestId: value.requestId, kind: value.kind } as PendingRequestBase };
}

function decodeNotice(event: RemoteEvent): RunNotice | undefined {
  const data = event.data;
  if (!data || data.type !== "run.notice" || typeof data.noticeId !== "string" ||
      typeof data.text !== "string" || !Number.isSafeInteger(data.eventSequence) ||
      (data.delivery !== "polite" && data.delivery !== "interrupt") ||
      !["progress", "approval", "question", "handoff", "error", "result"].includes(String(data.kind))) return undefined;
  const kind = data.kind as RunNotice["kind"];
  if ((kind === "approval" || kind === "question" || kind === "handoff") && typeof data.pendingRequestId !== "string") return undefined;
  return {
    noticeId: data.noticeId,
    kind,
    text: data.text,
    delivery: data.delivery,
    eventSequence: data.eventSequence as number,
    feedSequence: event.sequence,
    ...(typeof data.pendingRequestId === "string" ? { pendingRequestId: data.pendingRequestId } : {}),
  };
}

function decodeEvent(message: MessageEvent<string>, runId: string): RemoteEvent | undefined {
  try {
    const parsed = JSON.parse(message.data) as Partial<RemoteEvent> & { type?: string };
    const data = parsed.data && typeof parsed.data === "object" ? parsed.data as Record<string, unknown> : {};
    const eventType = typeof parsed.type === "string" ? parsed.type : "run.event";
    const innerType = typeof data.type === "string" ? data.type : undefined;
    const isResync = eventType === "resync_required"
      || eventType === "run.resync_required"
      || innerType === "resync_required"
      || innerType === "run.resync_required";
    if (typeof parsed.sequence !== "number" && !isResync) return undefined;
    return {
      runId: typeof parsed.runId === "string" ? parsed.runId : runId,
      sequence: typeof parsed.sequence === "number" ? parsed.sequence : -1,
      type: isResync ? "run.resync_required" : eventType,
      data,
    };
  } catch {
    return undefined;
  }
}

export function useRunFeed(runId: string): RunFeedState {
  const [snapshotState, setSnapshotState] = useState<{ runId: string; snapshot: RunSnapshot }>();
  const [pendingState, setPendingState] = useState<{ runId: string; sequence: number; request?: PendingRequestBase }>();
  const [eventState, setEventState] = useState<{ runId: string; events: RemoteEvent[] }>({ runId, events: [] });
  const [noticeState, setNoticeState] = useState<{ runId: string; notices: RunNotice[] }>({ runId, notices: [] });
  const [connectionState, setConnectionState] = useState<{ runId: string; connection: FeedConnection }>({ runId, connection: "loading" });
  const [errorState, setErrorState] = useState<{ runId: string; error?: string }>({ runId });
  const activeRunIdRef = useRef(runId);
  useLayoutEffect(() => { activeRunIdRef.current = runId; }, [runId]);
  const feedEpochRef = useRef(0);
  const snapshotRef = useRef<{ runId: string; snapshot: RunSnapshot } | undefined>(undefined);
  const lastSequenceRef = useRef<{ runId: string; sequence: number }>({ runId, sequence: -1 });
  const sourceRef = useRef<EventSource | undefined>(undefined);
  const restartFeedRef = useRef<{ runId: string; epoch: number; restart: (sequence: number) => void } | undefined>(undefined);
  const refreshQueuedRef = useRef(false);
  const refreshTimerRef = useRef<number | undefined>(undefined);
  const snapshot = snapshotState?.runId === runId ? snapshotState.snapshot : undefined;
  const events = eventState.runId === runId ? eventState.events : [];
  const connection = connectionState.runId === runId ? connectionState.connection : "loading";
  const error = errorState.runId === runId ? errorState.error : undefined;

  const acceptSnapshot = useCallback((next: RunSnapshot, expectedEpoch = feedEpochRef.current) => {
    if (activeRunIdRef.current !== runId || feedEpochRef.current !== expectedEpoch || next.runId !== runId) return;
    const currentSnapshot = snapshotRef.current?.runId === runId ? snapshotRef.current.snapshot : undefined;
    const lastSequence = lastSequenceRef.current.runId === runId ? lastSequenceRef.current.sequence : -1;
    if ((currentSnapshot && next.sequence < currentSnapshot.sequence) || next.sequence < lastSequence) return;
    snapshotRef.current = { runId, snapshot: next };
    lastSequenceRef.current = { runId, sequence: Math.max(lastSequence, next.sequence) };
    setSnapshotState({ runId, snapshot: next });
    setErrorState({ runId });
    setPendingState((current) => !current || current.runId !== runId || next.sequence >= current.sequence
      ? { runId, sequence: next.sequence, request: next.pendingRequest }
      : current);
  }, [runId]);

  const refresh = useCallback(async () => {
    const requestEpoch = feedEpochRef.current;
    if (activeRunIdRef.current === runId) setConnectionState({ runId, connection: "reconnecting" });
    try {
      const next = await getRun(runId);
      if (activeRunIdRef.current !== runId || feedEpochRef.current !== requestEpoch || next.runId !== runId) return next;
      acceptSnapshot(next, requestEpoch);
      const restart = restartFeedRef.current;
      if (restart?.runId === runId && restart.epoch === requestEpoch) restart.restart(reconnectCursor(next.sequence));
      return next;
    } catch (caught) {
      if (activeRunIdRef.current === runId && feedEpochRef.current === requestEpoch) {
        setConnectionState({ runId, connection: "offline" });
        setErrorState({ runId, error: caught instanceof Error ? caught.message : "暂时无法刷新任务状态。" });
      }
      throw caught;
    }
  }, [acceptSnapshot, runId]);

  useEffect(() => {
    const feedEpoch = ++feedEpochRef.current;
    let stopped = false;
    const seenNoticeIds = new Set<string>();
    let source: EventSource | undefined;
    let reconnectWarningTimer: number | undefined;
    let openFeed: (sequence: number) => void = () => undefined;
    const feedIsCurrent = () => !stopped && activeRunIdRef.current === runId && feedEpochRef.current === feedEpoch;

    const clearReconnectWarningTimer = () => {
      if (reconnectWarningTimer === undefined) return;
      window.clearTimeout(reconnectWarningTimer);
      reconnectWarningTimer = undefined;
    };

    const scheduleReconnectWarning = () => {
      if (reconnectWarningTimer !== undefined) return;
      reconnectWarningTimer = window.setTimeout(() => {
        reconnectWarningTimer = undefined;
        if (feedIsCurrent()) setErrorState({ runId, error: RECONNECT_WARNING });
      }, RECONNECT_WARNING_DELAY_MS);
    };

    const onMessage = (rawEvent: Event) => {
      const message = rawEvent as MessageEvent<string>;
      if (!feedIsCurrent()) return;
      const event = decodeEvent(message, runId);
      if (!event || event.runId !== runId) return;
      const payloadType = typeof event.data?.type === "string" ? event.data.type : event.type;
      const needsResync = event.type === "run.resync_required" || payloadType === "resync_required" || payloadType === "run.resync_required";
      if (needsResync) {
        setConnectionState({ runId, connection: "reconnecting" });
        source?.close();
        void getRun(runId).then((next) => {
          if (!feedIsCurrent() || next.runId !== runId) return;
          acceptSnapshot(next, feedEpoch);
          openFeed(next.sequence);
        }).catch(() => {
          if (feedIsCurrent()) {
            setConnectionState({ runId, connection: "offline" });
            setErrorState({ runId, error: "连接中断，尚未同步到最新状态。请检查网络后刷新。" });
          }
        });
        return;
      }
      const previous = lastSequenceRef.current.runId === runId ? lastSequenceRef.current.sequence : -1;
      const sequenceDecision = decideSequence(previous, event.sequence);
      if (sequenceDecision === "duplicate") return;
      if (sequenceDecision === "gap") {
        setConnectionState({ runId, connection: "reconnecting" });
        source?.close();
        void getRun(runId).then((next) => {
          if (!feedIsCurrent() || next.runId !== runId) return;
          acceptSnapshot(next, feedEpoch);
          openFeed(next.sequence);
        }).catch(() => {
          if (feedIsCurrent()) {
            setConnectionState({ runId, connection: "offline" });
            setErrorState({ runId, error: "连接中断，尚未同步到最新状态。请检查网络后刷新。" });
          }
        });
        return;
      }

      lastSequenceRef.current = { runId, sequence: event.sequence };
      const normalized = { ...event, type: payloadType };
      setEventState((current) => ({
        runId,
        events: [...(current.runId === runId ? current.events : []).filter((item) => item.sequence !== event.sequence), normalized].slice(-12),
      }));
      const pendingUpdate = decodePendingRequestUpdate(normalized);
      if (pendingUpdate !== undefined) {
        setPendingState((current) => !current || current.runId !== runId || event.sequence >= current.sequence
          ? { runId, sequence: event.sequence, ...pendingUpdate }
          : current);
      }
      const notice = decodeNotice(normalized);
      if (notice && !seenNoticeIds.has(notice.noticeId)) {
        seenNoticeIds.add(notice.noticeId);
        setNoticeState((current) => ({
          runId,
          notices: [...(current.runId === runId ? current.notices : []), notice].slice(-24),
        }));
      }

      if (!refreshQueuedRef.current) {
        refreshQueuedRef.current = true;
        refreshTimerRef.current = window.setTimeout(() => {
          refreshTimerRef.current = undefined;
          refreshQueuedRef.current = false;
          if (!feedIsCurrent()) return;
          void getRun(runId).then((next) => {
            if (feedIsCurrent() && next.runId === runId) acceptSnapshot(next, feedEpoch);
          }).catch(() => {
            if (feedIsCurrent()) setConnectionState({ runId, connection: "reconnecting" });
          });
        }, 250);
      }
    };

    openFeed = (sequence: number) => {
      if (!feedIsCurrent()) return;
      source?.close();
      source = new EventSource(runEventsUrl(runId, reconnectCursor(sequence)), { withCredentials: true });
      sourceRef.current = source;
      source.addEventListener("run.event", onMessage);
      source.addEventListener("resync_required", onMessage);
      source.addEventListener("run.resync_required", onMessage);
      source.onmessage = onMessage;
      source.onopen = () => {
        if (!feedIsCurrent()) return;
        clearReconnectWarningTimer();
        if (activeRunIdRef.current !== runId) return;
        setConnectionState({ runId, connection: "live" });
        setErrorState({ runId });
      };
      source.onerror = () => {
        if (!feedIsCurrent()) return;
        setConnectionState({ runId, connection: "reconnecting" });
        scheduleReconnectWarning();
      };
    };
    restartFeedRef.current = { runId, epoch: feedEpoch, restart: openFeed };

    async function initialize() {
      try {
        const initial = await getRun(runId);
        if (!feedIsCurrent() || initial.runId !== runId) return;
        acceptSnapshot(initial, feedEpoch);
        openFeed(initial.sequence);
      } catch (caught) {
        if (feedIsCurrent()) {
          setConnectionState({ runId, connection: "offline" });
          setErrorState({ runId, error: caught instanceof Error ? caught.message : "暂时无法读取任务状态。" });
        }
      }
    }

    const onOffline = () => {
      if (!feedIsCurrent()) return;
      setConnectionState({ runId, connection: "reconnecting" });
      scheduleReconnectWarning();
    };
    const onOnline = () => { void refresh().catch(() => undefined); };
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      if (navigator.onLine === false) onOffline();
      else onOnline();
    };

    void initialize();
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      clearReconnectWarningTimer();
      if (refreshTimerRef.current !== undefined) window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = undefined;
      refreshQueuedRef.current = false;
      source?.close();
      sourceRef.current?.close();
      if (restartFeedRef.current?.runId === runId && restartFeedRef.current.epoch === feedEpoch) restartFeedRef.current = undefined;
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [acceptSnapshot, refresh, runId]);

  return {
    snapshot,
    pendingRequestState: pendingState?.runId === runId
      ? { sequence: pendingState.sequence, ...(pendingState.request === undefined ? {} : { request: pendingState.request }) }
      : undefined,
    events,
    notices: noticeState.runId === runId ? noticeState.notices : [],
    connection,
    error,
    refresh,
  };
}
