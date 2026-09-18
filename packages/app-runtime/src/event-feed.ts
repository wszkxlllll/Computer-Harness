import type { RunId, RuntimeEvent } from "@computer-harness/protocol";

export type EventFeedState = "live" | "resync_required" | "closed";

export type EventFeedListener = (notification: EventFeedNotification) => void | Promise<void>;

export type EventFeedNotification =
  | { type: "event"; event: RuntimeEvent }
  | {
      type: "status";
      status: "resync_required" | "closed";
      afterSequence: number;
      latestSequence: number;
      reason: string;
    };

export interface EventFeedSubscription {
  unsubscribe(): void;
}

export interface EventFeedResyncResult {
  status: "ok" | "resync_required";
  requestedAfterSequence: number;
  upToSequence: number;
  events: readonly RuntimeEvent[];
  reason?: string;
}

export interface RunEventFeed {
  readonly state: EventFeedState;
  readonly latestSequence: number;
  subscribe(options: {
    afterSequence?: number;
    listener: EventFeedListener;
  }): EventFeedSubscription;
  /** Re-read committed events through a captured sequence watermark. */
  resync(afterSequence: number): Promise<EventFeedResyncResult>;
  close(): void;
}

export interface CommittedEventFeed extends RunEventFeed {
  /** Runtime calls this only after append and reducer projection succeed. */
  publish(event: RuntimeEvent): void;
}

export interface CreateRunEventFeedOptions {
  runId?: RunId;
  capacity?: number;
  readCommitted?: (
    afterSequence: number,
    upToSequence: number,
  ) => readonly RuntimeEvent[] | Promise<readonly RuntimeEvent[]>;
}

interface SubscriptionState {
  readonly id: number;
  readonly listener: EventFeedListener;
  lastDeliveredSequence: number;
  lastQueuedSequence: number;
  queue: EventFeedNotification[];
  queuedEventCount: number;
  deferred: RuntimeEvent[];
  deferredSequences: Set<number>;
  delivering: boolean;
  needsResync: boolean;
  resyncing: boolean;
  deferredOverflow: boolean;
}

const DEFAULT_EVENT_FEED_CAPACITY = 128;

/**
 * Build a bounded, read-only committed-event transport for a single Run.
 * Runtime only enqueues a notification here; delivery awaits each
 * subscriber separately so a slow Promise cannot block Controller.commitEvent.
 */
export function createRunEventFeed(options: CreateRunEventFeedOptions = {}): CommittedEventFeed {
  const capacity = options.capacity ?? DEFAULT_EVENT_FEED_CAPACITY;
  if (!Number.isInteger(capacity) || capacity < 1) throw new Error("event feed capacity must be a positive integer");

  let state: EventFeedState = "live";
  let latestSequence = -1;
  let history: RuntimeEvent[] = [];
  let historyStart = 0;
  let nextSubscriptionId = 1;
  let activeResync: Promise<EventFeedResyncResult> | undefined;
  const subscriptions = new Map<number, SubscriptionState>();

  const scheduleDelivery = (subscription: SubscriptionState): void => {
    if (subscription.delivering || !subscriptions.has(subscription.id)) return;
    subscription.delivering = true;
    queueMicrotask(() => { void drain(subscription); });
  };

  const drain = async (subscription: SubscriptionState): Promise<void> => {
    try {
      while (subscriptions.has(subscription.id) && subscription.queue.length > 0) {
        const notification = subscription.queue.shift()!;
        if (notification.type === "event") subscription.queuedEventCount -= 1;
        try {
          await subscription.listener(notification);
        } catch {
          // UI/feed observers never decide Runtime state. A rejected or
          // throwing listener only loses its own rendering step.
        }
        if (notification.type === "event") {
          subscription.lastDeliveredSequence = Math.max(subscription.lastDeliveredSequence, notification.event.sequence);
        }
        if (notification.type === "status" && notification.status === "closed") {
          subscriptions.delete(subscription.id);
          break;
        }
      }
    } finally {
      subscription.delivering = false;
      if (subscriptions.has(subscription.id) && subscription.queue.length > 0) scheduleDelivery(subscription);
    }
  };

  const enqueueStatus = (subscription: SubscriptionState, status: Extract<EventFeedNotification, { type: "status" }>): void => {
    subscription.queue = subscription.queue.filter((notification) => notification.type !== "status" || notification.status === "closed");
    subscription.queuedEventCount = 0;
    subscription.queue.push(status);
    scheduleDelivery(subscription);
  };

  const markResyncRequired = (subscription: SubscriptionState, reason: string): void => {
    if (subscription.needsResync || state === "closed") return;
    subscription.needsResync = true;
    subscription.deferred = [];
    subscription.deferredSequences.clear();
    subscription.deferredOverflow = false;
    // Drop queued business notifications. The authoritative replay starts
    // from lastDeliveredSequence; the status remains visible to the UI.
    subscription.queue = subscription.queue.filter((notification) => notification.type === "status" && notification.status === "closed");
    subscription.queuedEventCount = 0;
    subscription.lastQueuedSequence = subscription.lastDeliveredSequence;
    state = "resync_required";
    enqueueStatus(subscription, {
      type: "status",
      status: "resync_required",
      afterSequence: subscription.lastDeliveredSequence,
      latestSequence,
      reason,
    });
  };

  const appendPublishedHistory = (event: RuntimeEvent): void => {
    const copy = structuredClone(event);
    if (history.length < capacity) {
      history.push(copy);
      return;
    }
    history[historyStart] = copy;
    historyStart = (historyStart + 1) % capacity;
  };

  const historySnapshot = (): RuntimeEvent[] => {
    if (historyStart === 0) return [...history];
    return [...history.slice(historyStart), ...history.slice(0, historyStart)];
  };

  const mergeHistory = (event: RuntimeEvent): void => {
    const current = historySnapshot();
    if (current.some((known) => known.sequence === event.sequence)) return;
    history = [...current, structuredClone(event)].sort((left, right) => left.sequence - right.sequence).slice(-capacity);
    historyStart = 0;
  };

  const enqueueEvent = (subscription: SubscriptionState, event: RuntimeEvent, allowDuringResync = false): void => {
    if (subscription.needsResync && !allowDuringResync) {
      if (subscription.resyncing) {
        if (subscription.deferred.length < capacity) {
          if (!subscription.deferredSequences.has(event.sequence)) {
            subscription.deferred.push(structuredClone(event));
            subscription.deferredSequences.add(event.sequence);
          }
        } else {
          subscription.deferredOverflow = true;
        }
      }
      return;
    }
    if (event.sequence <= subscription.lastQueuedSequence) return;
    if (event.sequence !== subscription.lastQueuedSequence + 1) {
      markResyncRequired(subscription, `subscriber missed sequence ${subscription.lastQueuedSequence + 1}`);
      return;
    }
    if (subscription.queuedEventCount >= capacity) {
      markResyncRequired(subscription, `subscriber queue exceeded capacity ${capacity}`);
      return;
    }
    subscription.lastQueuedSequence = event.sequence;
    subscription.queue.push({ type: "event", event: structuredClone(event) });
    subscription.queuedEventCount += 1;
    scheduleDelivery(subscription);
  };

  const publish = (event: RuntimeEvent): void => {
    // This function intentionally does no listener call and no await. It is
    // the constant-time notification boundary used by Runtime.commitEvent.
    if (state === "closed" || event.sequence <= latestSequence || (options.runId !== undefined && event.runId !== options.runId)) return;
    if (latestSequence >= 0 && event.sequence !== latestSequence + 1) {
      state = "resync_required";
      for (const subscription of subscriptions.values()) {
        markResyncRequired(subscription, `committed sequence jumped from ${latestSequence} to ${event.sequence}`);
      }
    }
    latestSequence = event.sequence;
    appendPublishedHistory(event);
    for (const subscription of subscriptions.values()) enqueueEvent(subscription, event);
  };

  const subscribe = (subscribeOptions: {
    afterSequence?: number;
    listener: EventFeedListener;
  }): EventFeedSubscription => {
    const afterSequence = validateSequence(subscribeOptions.afterSequence ?? -1, "afterSequence");
    const id = nextSubscriptionId++;
    const subscription: SubscriptionState = {
      id,
      listener: subscribeOptions.listener,
      lastDeliveredSequence: afterSequence,
      lastQueuedSequence: afterSequence,
      queue: [],
      queuedEventCount: 0,
      deferred: [],
      deferredSequences: new Set<number>(),
      delivering: false,
      needsResync: false,
      resyncing: false,
      deferredOverflow: false,
    };
    subscriptions.set(id, subscription);
    if (state === "closed") {
      enqueueStatus(subscription, {
        type: "status",
        status: "closed",
        afterSequence,
        latestSequence,
        reason: "event feed is closed",
      });
    } else {
      const availableHistory = historySnapshot();
      const firstSequence = availableHistory[0]?.sequence;
      if (firstSequence !== undefined && afterSequence < firstSequence - 1) {
        markResyncRequired(subscription, `requested sequence ${afterSequence} is older than feed window ${firstSequence}`);
      } else {
        for (const event of availableHistory) {
          if (event.sequence <= subscription.lastQueuedSequence) continue;
          if (event.sequence !== subscription.lastQueuedSequence + 1) {
            markResyncRequired(subscription, `requested sequence has a gap before ${event.sequence}`);
            break;
          }
          if (subscription.queuedEventCount >= capacity) {
            markResyncRequired(subscription, `subscriber queue exceeded capacity ${capacity}`);
            break;
          }
          subscription.lastQueuedSequence = event.sequence;
          subscription.queue.push({ type: "event", event: structuredClone(event) });
          subscription.queuedEventCount += 1;
        }
        scheduleDelivery(subscription);
      }
    }
    return {
      unsubscribe: () => {
        subscriptions.delete(id);
      },
    };
  };

  const performResync = async (afterSequence: number): Promise<EventFeedResyncResult> => {
    const requestedAfterSequence = validateSequence(afterSequence, "afterSequence");
    if (state === "closed") {
      return {
        status: "resync_required",
        requestedAfterSequence,
        upToSequence: latestSequence,
        events: [],
        reason: "event feed is closed",
      };
    }
    const upToSequence = latestSequence;
    for (const subscription of subscriptions.values()) {
      if (subscription.needsResync) subscription.resyncing = true;
    }
    if (requestedAfterSequence >= upToSequence) {
      completeSubscriberResync([], upToSequence);
      return { status: "ok", requestedAfterSequence, upToSequence, events: [] };
    }
    let sourceEvents: readonly RuntimeEvent[];
    try {
      sourceEvents = options.readCommitted === undefined
        ? historySnapshot()
        : await options.readCommitted(requestedAfterSequence, upToSequence);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failSubscriberResync(reason);
      return { status: "resync_required", requestedAfterSequence, upToSequence, events: [], reason };
    }
    const orderedEvents = sourceEvents
      .filter((event) => options.runId === undefined || event.runId === options.runId)
      .filter((event) => event.sequence > requestedAfterSequence && event.sequence <= upToSequence)
      .sort((left, right) => left.sequence - right.sequence);
    const events: RuntimeEvent[] = [];
    for (const event of orderedEvents) {
      const previous = events.at(-1);
      if (previous?.sequence === event.sequence) {
        if (JSON.stringify(previous) !== JSON.stringify(event)) {
          const reason = `committed event history contains conflicting sequence ${event.sequence}`;
          failSubscriberResync(reason);
          return { status: "resync_required", requestedAfterSequence, upToSequence, events: [], reason };
        }
        continue;
      }
      events.push(event);
    }
    let expectedSequence = requestedAfterSequence + 1;
    for (const event of events) {
      if (event.sequence !== expectedSequence) {
        const reason = `committed event history is missing sequence ${expectedSequence}`;
        failSubscriberResync(reason);
        return { status: "resync_required", requestedAfterSequence, upToSequence, events: [], reason };
      }
      expectedSequence += 1;
    }
    if (expectedSequence <= upToSequence) {
      const reason = `committed event history is missing sequence ${expectedSequence}`;
      failSubscriberResync(reason);
      return { status: "resync_required", requestedAfterSequence, upToSequence, events: [], reason };
    }
    for (const event of events) {
      mergeHistory(event);
    }
    completeSubscriberResync(events, upToSequence);
    return {
      status: "ok",
      requestedAfterSequence,
      upToSequence,
      events: events.map((event) => structuredClone(event)),
    };
  };

  const resync = (afterSequence: number): Promise<EventFeedResyncResult> => {
    if (activeResync !== undefined) return activeResync;
    activeResync = performResync(afterSequence).finally(() => { activeResync = undefined; });
    return activeResync;
  };

  function completeSubscriberResync(events: readonly RuntimeEvent[], upToSequence: number): void {
    for (const subscription of subscriptions.values()) {
      if (!subscription.resyncing) continue;
      subscription.resyncing = false;
      if (state === "closed") continue;
      if (subscription.deferredOverflow) {
        subscription.deferred = [];
        subscription.deferredSequences.clear();
        subscription.needsResync = true;
        enqueueStatus(subscription, {
          type: "status",
          status: "resync_required",
          afterSequence: subscription.lastDeliveredSequence,
          latestSequence,
          reason: `events arrived faster than the resync queue capacity ${capacity}`,
        });
        continue;
      }
      subscription.needsResync = false;
      subscription.lastQueuedSequence = Math.max(subscription.lastQueuedSequence, subscription.lastDeliveredSequence);
      for (const event of events) enqueueEvent(subscription, event, true);
      const deferred = subscription.deferred
        .filter((event) => event.sequence > upToSequence)
        .sort((left, right) => left.sequence - right.sequence);
      subscription.deferred = [];
      subscription.deferredSequences.clear();
      for (const event of deferred) enqueueEvent(subscription, event, true);
      scheduleDelivery(subscription);
    }
    if (state !== "closed") {
      state = [...subscriptions.values()].some((subscription) => subscription.needsResync || subscription.resyncing) ? "resync_required" : "live";
    }
  }

  function failSubscriberResync(reason: string): void {
    for (const subscription of subscriptions.values()) {
      if (!subscription.resyncing) continue;
      subscription.resyncing = false;
      subscription.deferred = [];
      subscription.deferredOverflow = false;
      enqueueStatus(subscription, {
        type: "status",
        status: "resync_required",
        afterSequence: subscription.lastDeliveredSequence,
        latestSequence,
        reason,
      });
    }
    if (state !== "closed") state = "resync_required";
  }

  const close = (): void => {
    if (state === "closed") return;
    state = "closed";
    for (const subscription of subscriptions.values()) {
      enqueueStatus(subscription, {
        type: "status",
        status: "closed",
        afterSequence: subscription.lastDeliveredSequence,
        latestSequence,
        reason: "event feed closed",
      });
    }
  };

  return {
    get state() { return state; },
    get latestSequence() { return latestSequence; },
    subscribe,
    resync,
    close,
    publish,
  };
}

export const createEventFeed = createRunEventFeed;

function validateSequence(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < -1) throw new Error(`${label} must be an integer greater than or equal to -1`);
  return value;
}
