import { describe, expect, it, vi } from "vitest";
import type { EventId, RunId, RuntimeEvent } from "@computer-harness/protocol";
import { createRunEventFeed } from "./event-feed.js";

const runId = "feed-run" as RunId;

function event(sequence: number): RuntimeEvent {
  return {
    eventId: `event-${sequence}` as EventId,
    runId,
    sequence,
    occurredAt: "2026-09-17T00:00:00.000Z",
    type: "runtime.error",
    category: "fixture",
    message: `event ${sequence}`,
  };
}

async function flushDelivery(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("committed event feed", () => {
  it("enqueues without awaiting a throwing or slow listener and preserves committed order", async () => {
    const feed = createRunEventFeed();
    const seen: number[] = [];
    feed.subscribe({
      listener: async (notification) => {
        if (notification.type === "event") {
          seen.push(notification.event.sequence);
          await Promise.resolve();
          throw new Error("UI listener failed");
        }
      },
    });
    feed.publish(event(0));
    feed.publish(event(0));
    feed.publish(event(1));
    expect(seen).toEqual([]);
    expect(feed.latestSequence).toBe(1);
    await flushDelivery();
    expect(seen).toEqual([0, 1]);
    expect(feed.state).toBe("live");
    await expect(feed.resync(-1)).resolves.toMatchObject({ status: "ok", upToSequence: 1 });
  });

  it("marks a slow subscriber for resync when its bounded queue overflows", async () => {
    const feed = createRunEventFeed({ capacity: 2 });
    let release!: () => void;
    let started!: () => void;
    const listenerStarted = new Promise<void>((resolve) => { started = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const notifications: string[] = [];
    feed.subscribe({
      listener: async (notification) => {
        notifications.push(notification.type === "event" ? `event:${notification.event.sequence}` : notification.status);
        if (notification.type === "event" && notification.event.sequence === 0) {
          started();
          await hold;
        }
      },
    });
    feed.publish(event(0));
    await listenerStarted;
    feed.publish(event(1));
    feed.publish(event(2));
    feed.publish(event(3));
    expect(feed.state).toBe("resync_required");
    release();
    await flushDelivery();
    expect(notifications).toEqual(["event:0", "resync_required"]);
  });

  it("repairs the same subscriber through a deferred publish at the resync watermark", async () => {
    let releaseRead!: (events: readonly RuntimeEvent[]) => void;
    let readStarted!: () => void;
    const readReady = new Promise<void>((resolve) => { readStarted = resolve; });
    const readCommitted = vi.fn((afterSequence: number, upToSequence: number) => {
      readStarted();
      return new Promise<readonly RuntimeEvent[]>((resolve) => {
        releaseRead = resolve;
      });
    });
    const feed = createRunEventFeed({ capacity: 8, readCommitted });
    feed.publish(event(5));
    const notifications: string[] = [];
    feed.subscribe({
      afterSequence: -1,
      listener: (notification) => notifications.push(notification.type === "event" ? `event:${notification.event.sequence}` : notification.status),
    });
    await flushDelivery();
    expect(notifications).toEqual(["resync_required"]);
    const pending = feed.resync(-1);
    await readReady;
    feed.publish(event(6));
    releaseRead(Array.from({ length: 6 }, (_, index) => event(index)));
    await expect(pending).resolves.toMatchObject({ status: "ok", upToSequence: 5, events: Array.from({ length: 6 }, (_, index) => event(index)) });
    await flushDelivery();
    expect(notifications).toEqual(["resync_required", "event:0", "event:1", "event:2", "event:3", "event:4", "event:5", "event:6"]);
    expect(new Set(notifications.filter((item) => item.startsWith("event:")).map((item) => item.slice(6)))).toEqual(new Set(["0", "1", "2", "3", "4", "5", "6"]));
    expect(readCommitted).toHaveBeenCalledWith(-1, 5);
    expect(feed.state).toBe("live");
  });

  it("deduplicates replay subscriptions and exposes closed state", async () => {
    const feed = createRunEventFeed();
    feed.publish(event(0));
    const seen: number[] = [];
    feed.subscribe({
      afterSequence: 0,
      listener: (notification) => { if (notification.type === "event") seen.push(notification.event.sequence); },
    });
    feed.publish(event(0));
    feed.publish(event(1));
    await flushDelivery();
    expect(seen).toEqual([1]);
    feed.close();
    const closed: string[] = [];
    feed.subscribe({ listener: (notification) => { if (notification.type === "status") closed.push(notification.status); } });
    await flushDelivery();
    expect(closed).toEqual(["closed"]);
  });
});
