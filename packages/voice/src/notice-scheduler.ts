import type { RunId } from "@computer-harness/protocol";
import type { RunNotice } from "./run-notices.js";

export type RunNoticeGeneration = number & { readonly __brand: "RunNoticeGeneration" };
export type NoticeOfferStatus = "queued" | "duplicate" | "rate_limited" | "stale" | "queue_full";

export interface NoticeOfferResult {
  readonly status: NoticeOfferStatus;
  /** TTS consumers cancel current playback when this is true, then take the urgent notice. */
  readonly interruptCurrent: boolean;
}

export interface RunNoticeSchedulerOptions {
  readonly minimumProgressIntervalMs?: number;
  readonly maxQueueSize?: number;
  readonly now?: () => number;
}

interface QueuedNotice {
  readonly notice: RunNotice;
  readonly generation: RunNoticeGeneration;
}

const DEFAULT_PROGRESS_INTERVAL_MS = 12_000;
const DEFAULT_MAX_QUEUE_SIZE = 16;
const MAX_SEEN_KEYS = 512;

/**
 * In-memory per-active-Run admission and priority queue. High-priority
 * interaction/result notices bypass progress cooldown. Result is terminal
 * and replaces all queued work. Dynamic text opt-in is enforced by the
 * projector before a notice is created.
 */
export class RunNoticeScheduler {
  private activeRunId?: RunId;
  private generation = 0;
  private latestEventSequence = -1;
  private lastProgressAt: number | undefined;
  private terminal = false;
  private queue: QueuedNotice[] = [];
  private readonly seenNoticeIds = new Set<string>();
  private readonly seenDedupeKeys = new Set<string>();
  private readonly minimumProgressIntervalMs: number;
  private readonly maxQueueSize: number;
  private readonly now: () => number;

  public constructor(options: RunNoticeSchedulerOptions = {}) {
    this.minimumProgressIntervalMs = options.minimumProgressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
    this.maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.minimumProgressIntervalMs) || this.minimumProgressIntervalMs < 0) {
      throw new Error("minimumProgressIntervalMs must be a non-negative integer");
    }
    if (!Number.isSafeInteger(this.maxQueueSize) || this.maxQueueSize < 1) {
      throw new Error("maxQueueSize must be a positive integer");
    }
  }

  /** Start a new delivery generation and invalidate queued notices from older Runs. */
  public activateRun(runId: RunId): RunNoticeGeneration {
    this.generation += 1;
    this.activeRunId = runId;
    this.latestEventSequence = -1;
    this.lastProgressAt = undefined;
    this.terminal = false;
    this.queue = [];
    this.seenNoticeIds.clear();
    this.seenDedupeKeys.clear();
    return this.generation as RunNoticeGeneration;
  }

  public offer(notice: RunNotice, generation: RunNoticeGeneration): NoticeOfferResult {
    if (generation !== this.generation || notice.runId !== this.activeRunId || this.terminal) return { status: "stale", interruptCurrent: false };
    const dedupeKey = `${notice.runId}:${notice.dedupeKey}`;
    if (this.seenNoticeIds.has(notice.noticeId) || this.seenDedupeKeys.has(dedupeKey)) return { status: "duplicate", interruptCurrent: false };
    if (!Number.isSafeInteger(notice.eventSequence) || notice.eventSequence < this.latestEventSequence) return { status: "stale", interruptCurrent: false };

    const isPoliteProgress = notice.kind === "progress" && notice.delivery === "polite";
    const cooldownApplies = isPoliteProgress && notice.progressSemantic === undefined;
    if (cooldownApplies && this.lastProgressAt !== undefined &&
        this.now() - this.lastProgressAt < this.minimumProgressIntervalMs) {
      // Do not remember a rate-limited notice; it can be retried after cooldown.
      return { status: "rate_limited", interruptCurrent: false };
    }

    const interruptCurrent = notice.delivery === "interrupt";
    if (notice.kind === "result") {
      // A terminal result is the only notice that may follow Run completion.
      this.queue = [];
    } else if (notice.kind === "error") {
      // Errors outrank progress but leave potentially current approval/question notices queued.
      this.queue = this.queue.filter((item) => item.notice.delivery !== "polite");
    } else if (interruptCurrent) {
      this.queue = this.queue.filter((item) => item.notice.delivery === "interrupt");
    }

    if (this.queue.length >= this.maxQueueSize) {
      const politeIndex = this.queue.findIndex((item) => item.notice.delivery === "polite");
      if (politeIndex >= 0) this.queue.splice(politeIndex, 1);
      else return { status: "queue_full", interruptCurrent };
    }

    const queued = { notice: structuredClone(notice), generation };
    if (interruptCurrent) {
      const firstPolite = this.queue.findIndex((item) => item.notice.delivery === "polite");
      this.queue.splice(firstPolite < 0 ? this.queue.length : firstPolite, 0, queued);
    } else {
      this.queue.push(queued);
    }

    // Admission/dedupe state changes only after an item is actually queued.
    this.latestEventSequence = Math.max(this.latestEventSequence, notice.eventSequence);
    this.remember(this.seenNoticeIds, notice.noticeId);
    this.remember(this.seenDedupeKeys, dedupeKey);
    if (cooldownApplies) this.lastProgressAt = this.now();
    if (notice.kind === "result") this.terminal = true;
    return { status: "queued", interruptCurrent };
  }

  /**
   * Approval/question/handoff notices require current Host request IDs at consumption
   * time. With no matching pending request they are discarded without speech.
   */
  public takeNext(currentPendingRequestIds: ReadonlySet<string> = new Set()): RunNotice | undefined {
    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      if (next.generation !== this.generation || next.notice.runId !== this.activeRunId) continue;
      if ((next.notice.kind === "approval" || next.notice.kind === "question" || next.notice.kind === "handoff") &&
          (next.notice.pendingRequestId === undefined || !currentPendingRequestIds.has(next.notice.pendingRequestId))) continue;
      return structuredClone(next.notice);
    }
    return undefined;
  }

  /** Invalidate current playback and release all per-Run queue/dedupe state. */
  public clear(): void {
    this.generation += 1;
    delete this.activeRunId;
    this.latestEventSequence = -1;
    this.lastProgressAt = undefined;
    this.terminal = false;
    this.queue = [];
    this.seenNoticeIds.clear();
    this.seenDedupeKeys.clear();
  }

  private remember(set: Set<string>, value: string): void {
    set.add(value);
    while (set.size > MAX_SEEN_KEYS) set.delete(set.values().next().value as string);
  }
}
