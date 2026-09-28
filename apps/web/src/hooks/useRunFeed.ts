import { useCallback, useEffect, useRef, useState } from "react";
import { getRun, runEventsUrl } from "../api";
import { decideSequence, reconnectCursor } from "../event-sequence";
import type { RemoteEvent, RunSnapshot } from "../types";

export type FeedConnection = "loading" | "live" | "reconnecting" | "offline";

const RECONNECT_WARNING_DELAY_MS = 12_000;
const RECONNECT_WARNING = "连接已中断超过 12 秒，正在自动重连。请检查手机网络；恢复后提示会自动消失。";

export interface RunFeedState {
  snapshot?: RunSnapshot;
  events: RemoteEvent[];
  connection: FeedConnection;
  error?: string;
  refresh: () => Promise<RunSnapshot>;
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
  const [snapshot, setSnapshot] = useState<RunSnapshot>();
  const [events, setEvents] = useState<RemoteEvent[]>([]);
  const [connection, setConnection] = useState<FeedConnection>("loading");
  const [error, setError] = useState<string>();
  const snapshotRef = useRef<RunSnapshot | undefined>(undefined);
  const lastSequenceRef = useRef<number>(-1);
  const sourceRef = useRef<EventSource | undefined>(undefined);
  const restartFeedRef = useRef<((sequence: number) => void) | undefined>(undefined);
  const refreshQueuedRef = useRef(false);

  const acceptSnapshot = useCallback((next: RunSnapshot) => {
    if (snapshotRef.current && next.sequence < snapshotRef.current.sequence) return;
    snapshotRef.current = next;
    lastSequenceRef.current = Math.max(lastSequenceRef.current, next.sequence);
    setSnapshot(next);
    setError(undefined);
  }, []);

  const refresh = useCallback(async () => {
    setConnection("reconnecting");
    try {
      const next = await getRun(runId);
      acceptSnapshot(next);
      restartFeedRef.current?.(reconnectCursor(next.sequence));
      return next;
    } catch (caught) {
      setConnection("offline");
      setError(caught instanceof Error ? caught.message : "暂时无法刷新任务状态。");
      throw caught;
    }
  }, [acceptSnapshot, runId]);

  useEffect(() => {
    let stopped = false;
    let source: EventSource | undefined;
    let reconnectWarningTimer: number | undefined;
    let openFeed: (sequence: number) => void = () => undefined;

    const clearReconnectWarningTimer = () => {
      if (reconnectWarningTimer === undefined) return;
      window.clearTimeout(reconnectWarningTimer);
      reconnectWarningTimer = undefined;
    };

    const scheduleReconnectWarning = () => {
      if (reconnectWarningTimer !== undefined) return;
      reconnectWarningTimer = window.setTimeout(() => {
        reconnectWarningTimer = undefined;
        if (!stopped) setError(RECONNECT_WARNING);
      }, RECONNECT_WARNING_DELAY_MS);
    };

    const onMessage = (rawEvent: Event) => {
      const message = rawEvent as MessageEvent<string>;
      const event = decodeEvent(message, runId);
      if (!event || event.runId !== runId) return;
      const payloadType = typeof event.data?.type === "string" ? event.data.type : event.type;
      const needsResync = event.type === "run.resync_required" || payloadType === "resync_required" || payloadType === "run.resync_required";
      if (needsResync) {
        setConnection("reconnecting");
        source?.close();
        void getRun(runId).then((next) => {
          if (stopped) return;
          acceptSnapshot(next);
          openFeed(next.sequence);
        }).catch(() => {
          if (!stopped) {
            setConnection("offline");
            setError("连接中断，尚未同步到最新状态。请检查网络后刷新。");
          }
        });
        return;
      }
      const previous = lastSequenceRef.current;
      const sequenceDecision = decideSequence(previous, event.sequence);
      if (sequenceDecision === "duplicate") return;
      if (sequenceDecision === "gap") {
        setConnection("reconnecting");
        source?.close();
        void getRun(runId).then((next) => {
          if (stopped) return;
          acceptSnapshot(next);
          openFeed(next.sequence);
        }).catch(() => {
          if (!stopped) {
            setConnection("offline");
            setError("连接中断，尚未同步到最新状态。请检查网络后刷新。");
          }
        });
        return;
      }

      lastSequenceRef.current = event.sequence;
      const normalized = { ...event, type: payloadType };
      setEvents((current) => [...current.filter((item) => item.sequence !== event.sequence), normalized].slice(-12));

      if (!refreshQueuedRef.current) {
        refreshQueuedRef.current = true;
        window.setTimeout(() => {
          refreshQueuedRef.current = false;
          void getRun(runId).then((next) => {
            if (!stopped) acceptSnapshot(next);
          }).catch(() => {
            if (!stopped) setConnection("reconnecting");
          });
        }, 250);
      }
    };

    openFeed = (sequence: number) => {
      if (stopped) return;
      source?.close();
      source = new EventSource(runEventsUrl(runId, reconnectCursor(sequence)), { withCredentials: true });
      sourceRef.current = source;
      source.addEventListener("run.event", onMessage);
      source.addEventListener("resync_required", onMessage);
      source.addEventListener("run.resync_required", onMessage);
      source.onmessage = onMessage;
      source.onopen = () => {
        clearReconnectWarningTimer();
        setConnection("live");
        setError(undefined);
      };
      source.onerror = () => {
        setConnection("reconnecting");
        scheduleReconnectWarning();
      };
    };
    restartFeedRef.current = openFeed;

    async function initialize() {
      try {
        const initial = await getRun(runId);
        if (stopped) return;
        acceptSnapshot(initial);
        openFeed(initial.sequence);
      } catch (caught) {
        if (stopped) return;
        setConnection("offline");
        setError(caught instanceof Error ? caught.message : "暂时无法读取任务状态。");
      }
    }

    const onOffline = () => {
      setConnection("reconnecting");
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
      source?.close();
      sourceRef.current?.close();
      restartFeedRef.current = undefined;
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [acceptSnapshot, refresh, runId]);

  return { snapshot, events, connection, error, refresh };
}
