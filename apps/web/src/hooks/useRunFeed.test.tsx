// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRun } from "../api";
import type { RemoteEvent, RunSnapshot } from "../types";
import { useRunFeed } from "./useRunFeed";

vi.mock("../api", () => ({
  getRun: vi.fn(),
  runEventsUrl: (runId: string, after: number) => `/api/runs/${runId}/events?after=${after}`,
}));

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, EventListener[]>();
  closed = false;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close() {
    this.closed = true;
  }

  open() {
    this.onopen?.(new Event("open"));
  }

  fail() {
    this.onerror?.(new Event("error"));
  }

  emit(event: unknown, type = "run.event") {
    const message = new MessageEvent(type, { data: JSON.stringify(event) });
    for (const listener of this.listeners.get(type) ?? []) listener(message);
    if (type === "message") this.onmessage?.(message as MessageEvent<string>);
  }
}

function snapshot(sequence: number): RunSnapshot {
  return {
    runId: "run-1",
    goal: "Find three options",
    status: "running",
    sequence,
    capabilities: { pause: true, resume: false, abort: true, correct: true },
  };
}

function Probe() {
  const feed = useRunFeed("run-1");
  return (
    <div>
      <span data-testid="sequence">{feed.snapshot?.sequence ?? -1}</span>
      <span data-testid="connection">{feed.connection}</span>
      <span data-testid="event-count">{feed.events.length}</span>
      <span data-testid="notice-count">{feed.notices.length}</span>
      <span data-testid="notice-kind">{feed.notices[0]?.kind ?? "none"}</span>
      <span data-testid="notice-pending-request-id">{feed.notices[0]?.pendingRequestId ?? "none"}</span>
      <span data-testid="pending-request-id">{feed.pendingRequestState?.request?.requestId ?? "none"}</span>
      <span data-testid="pending-state-sequence">{feed.pendingRequestState?.sequence ?? -1}</span>
      <button type="button" onClick={() => void feed.refresh().catch(() => undefined)}>refresh</button>
    </div>
  );
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.mocked(getRun).mockReset();
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("run feed reconnect", () => {
  it("deduplicates public notices by noticeId even if replay arrives at a new SSE sequence", async () => {
    vi.mocked(getRun).mockResolvedValue(snapshot(4));
    render(<Probe />);
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];
    const noticeData = {
      type: "run.notice",
      noticeId: "run-1:event-9:progress:fixed",
      kind: "progress",
      text: "操作已执行，正在核对页面结果。",
      delivery: "polite",
      eventSequence: 9,
    };
    act(() => source.emit({ runId: "run-1", sequence: 5, type: "run.event", data: noticeData }));
    act(() => source.emit({ runId: "run-1", sequence: 6, type: "run.event", data: noticeData }));
    expect(screen.getByTestId("notice-count").textContent).toBe("1");
  });

  it("applies pending-request SSE before the delayed GET snapshot and keeps it authoritative", async () => {
    vi.mocked(getRun).mockResolvedValue(snapshot(4));
    render(<Probe />);
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];
    vi.useFakeTimers();

    act(() => source.emit({
      runId: "run-1",
      sequence: 5,
      type: "run.event",
      data: { type: "run.pending_request", request: { requestId: "approval-A", kind: "approval", reason: "Review this action" } },
    }));
    act(() => source.emit({
      runId: "run-1",
      sequence: 6,
      type: "run.event",
      data: {
        type: "run.notice",
        noticeId: "approval-A-notice",
        kind: "approval",
        text: "请审批",
        delivery: "interrupt",
        eventSequence: 21,
        pendingRequestId: "approval-A",
      },
    }));

    expect(screen.getByTestId("sequence").textContent).toBe("4");
    expect(screen.getByTestId("pending-request-id").textContent).toBe("approval-A");
    expect(screen.getByTestId("pending-state-sequence").textContent).toBe("5");
    expect(screen.getByTestId("notice-count").textContent).toBe("1");

    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(getRun).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("pending-request-id").textContent).toBe("approval-A");
    expect(screen.getByTestId("pending-state-sequence").textContent).toBe("5");

    act(() => source.emit({
      runId: "run-1",
      sequence: 7,
      type: "run.event",
      data: { type: "run.pending_request", cleared: true },
    }));
    expect(screen.getByTestId("pending-request-id").textContent).toBe("none");
    expect(screen.getByTestId("pending-state-sequence").textContent).toBe("7");
  });

  it("decodes a window handoff notice only with its matching pending request ID", async () => {
    vi.mocked(getRun).mockResolvedValue(snapshot(4));
    render(<Probe />);
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];

    act(() => source.emit({
      runId: "run-1",
      sequence: 5,
      type: "run.event",
      data: { type: "run.pending_request", request: { requestId: "action-window-handoff", kind: "window_handoff", candidates: [] } },
    }));
    act(() => source.emit({
      runId: "run-1",
      sequence: 6,
      type: "run.event",
      data: {
        type: "run.notice",
        noticeId: "action-window-handoff-notice",
        kind: "handoff",
        text: "任务正在等待你选择或确认一个窗口。",
        delivery: "interrupt",
        eventSequence: 22,
        pendingRequestId: "action-window-handoff",
      },
    }));

    expect(screen.getByTestId("pending-request-id").textContent).toBe("action-window-handoff");
    expect(screen.getByTestId("notice-kind").textContent).toBe("handoff");
    expect(screen.getByTestId("notice-pending-request-id").textContent).toBe("action-window-handoff");

    act(() => source.emit({
      runId: "run-1",
      sequence: 7,
      type: "run.event",
      data: { type: "run.notice", noticeId: "unbound-window-handoff", kind: "handoff", text: "过期选窗通知。", delivery: "interrupt", eventSequence: 23 },
    }));
    expect(screen.getByTestId("notice-count").textContent).toBe("1");
  });

  it("deduplicates events and reflects native reconnect state", async () => {
    vi.mocked(getRun).mockResolvedValueOnce(snapshot(4)).mockResolvedValue(snapshot(5));
    render(<Probe />);
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];
    act(() => source.open());
    expect(screen.getByTestId("connection").textContent).toBe("live");

    const event: RemoteEvent = { runId: "run-1", sequence: 5, type: "run.event", data: { type: "run.status" } };
    act(() => {
      source.emit(event);
      source.emit(event);
    });
    expect(screen.getByTestId("event-count").textContent).toBe("1");

    act(() => source.fail());
    expect(screen.getByTestId("connection").textContent).toBe("reconnecting");
    act(() => source.open());
    expect(screen.getByTestId("connection").textContent).toBe("live");
  });

  it("refreshes the snapshot and resumes after its sequence when an event is missing", async () => {
    vi.mocked(getRun).mockResolvedValueOnce(snapshot(4)).mockResolvedValueOnce(snapshot(7));
    render(<Probe />);
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const first = FakeEventSource.instances[0];

    act(() => first.emit({ runId: "run-1", sequence: 6, type: "run.event", data: { type: "run.status" } }));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances[1].url).toBe("/api/runs/run-1/events?after=7");
    expect(screen.getByTestId("sequence").textContent).toBe("7");
  });

  it("handles a resync_required control event without a normal event sequence", async () => {
    vi.mocked(getRun).mockResolvedValueOnce(snapshot(4)).mockResolvedValueOnce(snapshot(9));
    render(<Probe />);
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() => FakeEventSource.instances[0].emit({
      type: "resync_required",
      runId: "run-1",
      afterSequence: 4,
      latestSequence: 9,
    }, "resync_required"));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(FakeEventSource.instances[1].url).toBe("/api/runs/run-1/events?after=9");
    expect(screen.getByTestId("sequence").textContent).toBe("9");
  });

  it("reopens after a failed resync when the user refreshes later", async () => {
    vi.mocked(getRun)
      .mockResolvedValueOnce(snapshot(4))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(snapshot(10));
    render(<Probe />);
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() => FakeEventSource.instances[0].emit({ runId: "run-1", sequence: 6, type: "run.event", data: { type: "run.status" } }));
    await waitFor(() => expect(screen.getByTestId("connection").textContent).toBe("offline"));

    fireEvent.click(screen.getByRole("button", { name: "refresh" }));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(FakeEventSource.instances[1].url).toBe("/api/runs/run-1/events?after=10");
    expect(screen.getByTestId("sequence").textContent).toBe("10");
  });
});
