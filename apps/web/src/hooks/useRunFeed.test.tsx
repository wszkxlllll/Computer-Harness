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
  vi.unstubAllGlobals();
});

describe("run feed reconnect", () => {
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
