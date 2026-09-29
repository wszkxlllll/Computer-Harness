import type { VoiceOutputAdapter, VoiceOutputCancelReason, VoiceOutputSession, VoiceSpeechRate } from "@computer-harness/voice";
import type { PendingRequestBase, RunNotice } from "./types";

export const VOICE_INPUT_STARTED_EVENT = "harness:voice-input-started";

interface SpeechSynthesisPort {
  speak(utterance: SpeechSynthesisUtterance): void;
  cancel(): void;
  getVoices?(): SpeechSynthesisVoice[];
  resume?(): void;
}

export interface BrowserSpeechEnvironment {
  readonly speechSynthesis: SpeechSynthesisPort;
  readonly createUtterance: (text: string) => SpeechSynthesisUtterance;
}

function browserEnvironment(): BrowserSpeechEnvironment | undefined {
  if (typeof window === "undefined" || !window.speechSynthesis || typeof SpeechSynthesisUtterance === "undefined") return undefined;
  return {
    speechSynthesis: window.speechSynthesis,
    createUtterance: (text) => new SpeechSynthesisUtterance(text),
  };
}

export function isBrowserSpeechOutputAvailable(): boolean {
  return browserEnvironment() !== undefined;
}

const immediateUtterances = new Set<SpeechSynthesisUtterance>();

/** Starts inside a direct user gesture, which unlocks speech in restrictive mobile WebViews. */
export function announceBrowserText(
  text: string,
  speechRate: VoiceSpeechRate,
  environment: BrowserSpeechEnvironment | undefined = browserEnvironment(),
): boolean {
  if (environment === undefined || text.trim().length === 0) return false;
  try {
    const utterance = environment.createUtterance(text.trim());
    configureMandarinUtterance(utterance, environment.speechSynthesis, speechRate);
    const release = () => immediateUtterances.delete(utterance);
    utterance.onend = release;
    utterance.onerror = release;
    immediateUtterances.add(utterance);
    environment.speechSynthesis.resume?.();
    environment.speechSynthesis.speak(utterance);
    return true;
  } catch {
    return false;
  }
}

/** Low-latency browser TTS adapter. It requires no microphone permission. */
export class BrowserSpeechOutput implements VoiceOutputAdapter {
  private readonly environment: BrowserSpeechEnvironment | undefined;

  public constructor(environment?: BrowserSpeechEnvironment | null) {
    this.environment = environment === null ? undefined : environment ?? browserEnvironment();
  }

  public isAvailable(): boolean {
    return this.environment !== undefined;
  }

  public async openSession(options: { readonly signal?: AbortSignal; readonly speechRate?: VoiceSpeechRate } = {}): Promise<VoiceOutputSession> {
    options.signal?.throwIfAborted();
    if (!this.environment) throw new Error("当前浏览器不支持语音播报。");
    return new BrowserSpeechSession(this.environment, options.speechRate ?? 1);
  }
}

interface PendingUtterance {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  settled: boolean;
}

class BrowserSpeechSession implements VoiceOutputSession {
  private closed = false;
  private lastSequence = -1;
  private readonly chunks = new Set<string>();
  private readonly pending = new Set<PendingUtterance>();
  // Some mobile WebViews stop an utterance when the JavaScript wrapper is
  // collected, even though it is still queued by speechSynthesis.
  private readonly activeUtterances = new Set<SpeechSynthesisUtterance>();
  private firstFailure?: Error;

  public constructor(private readonly environment: BrowserSpeechEnvironment, private readonly speechRate: VoiceSpeechRate) {}

  public enqueueText(chunk: { readonly chunkId: string; readonly sequence: number; readonly text: string }): Promise<void> {
    if (this.closed) return Promise.reject(new Error("语音输出会话已经结束。"));
    if (!Number.isSafeInteger(chunk.sequence) || chunk.sequence <= this.lastSequence || this.chunks.has(chunk.chunkId)) {
      return Promise.reject(new Error("语音文本分块顺序无效或重复。"));
    }
    const text = chunk.text.trim();
    if (!text) return Promise.resolve();
    this.lastSequence = chunk.sequence;
    this.chunks.add(chunk.chunkId);

    let resolvePromise!: () => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    let pending: PendingUtterance;
    const settle = (finish: () => void) => {
      if (pending.settled) return;
      pending.settled = true;
      this.pending.delete(pending);
      finish();
    };
    pending = {
      promise,
      resolve: () => settle(resolvePromise),
      reject: (error) => settle(() => rejectPromise(error)),
      settled: false,
    };
    try {
      const utterance = this.environment.createUtterance(text);
      configureMandarinUtterance(utterance, this.environment.speechSynthesis, this.speechRate);
      utterance.onend = () => {
        this.activeUtterances.delete(utterance);
        pending.resolve();
      };
      utterance.onerror = (event) => {
        this.activeUtterances.delete(utterance);
        const error = new Error(`浏览器语音播报失败：${event.error || "unknown"}`);
        this.firstFailure ??= error;
        pending.reject(error);
      };
      this.pending.add(pending);
      this.activeUtterances.add(utterance);
      this.environment.speechSynthesis.resume?.();
      this.environment.speechSynthesis.speak(utterance);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error("浏览器语音播报失败。");
      this.firstFailure ??= failure;
      pending.reject(failure);
    }
    return promise;
  }

  public async finish(): Promise<void> {
    this.closed = true;
    const results = await Promise.allSettled([...this.pending].map((item) => item.promise));
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    const failure = this.firstFailure ?? (rejected?.reason instanceof Error ? rejected.reason : undefined);
    if (failure) throw failure;
  }

  public async cancel(_reason: VoiceOutputCancelReason): Promise<void> {
    this.closed = true;
    this.environment.speechSynthesis.cancel();
    this.activeUtterances.clear();
    for (const item of [...this.pending]) item.resolve();
  }
}

/** Prefer Mainland Mandarin and never select Cantonese merely because it is the first zh-* voice. */
export function selectMandarinVoice(voices: readonly SpeechSynthesisVoice[]): SpeechSynthesisVoice | undefined {
  const score = (voice: SpeechSynthesisVoice): number => {
    const language = voice.lang.trim().toLowerCase().replaceAll("_", "-");
    const name = voice.name.trim().toLowerCase();
    if (language === "zh-cn") return 500;
    if (language.startsWith("zh-cn-")) return 480;
    if (language === "zh-hans" || language.startsWith("zh-hans-")) return 450;
    if (language === "zh-sg") return 420;
    if (/(mandarin|putonghua|普通话|国语|xiaoxiao|huihui|ting-ting)/iu.test(name)) return 400;
    if (language === "zh" || language.startsWith("cmn-")) return 300;
    if (language.startsWith("zh-hk") || language.startsWith("yue-") || /(cantonese|粤语|廣東話|广东话)/iu.test(name)) return -100;
    if (language.startsWith("zh-tw")) return 100;
    return 0;
  };
  return voices
    .map((voice, index) => ({ voice, index, score: score(voice) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)[0]?.voice;
}

function configureMandarinUtterance(
  utterance: SpeechSynthesisUtterance,
  synthesis: SpeechSynthesisPort,
  speechRate: VoiceSpeechRate,
): void {
  utterance.rate = speechRate;
  utterance.lang = "zh-CN";
  const voice = selectMandarinVoice(synthesis.getVoices?.() ?? []);
  if (voice !== undefined) utterance.voice = voice;
}

export interface RunNoticeSpeechOptions {
  readonly enabled: boolean;
  readonly speechRate: VoiceSpeechRate;
  readonly snapshotSequence?: number;
  readonly currentPendingRequest: () => PendingRequestBase | undefined;
}

export type RunNoticeDeliveryState = "handled" | "deferred";

/** Keeps SSE history from being replayed when speech is enabled mid-Run. */
export class RunNoticeCursor {
  private initialized = false;
  private wasEnabled = false;
  private baselineFeedSequence = -1;
  private readonly seenNoticeIds = new Set<string>();

  public constructor(private runId: string) {}

  public select(runId: string, notices: readonly RunNotice[], enabled: boolean): readonly RunNotice[] {
    if (runId !== this.runId) {
      this.runId = runId;
      this.initialized = false;
      this.wasEnabled = false;
      this.baselineFeedSequence = -1;
      this.seenNoticeIds.clear();
    }
    const latestSequence = notices.reduce((latest, notice) => Math.max(latest, notice.feedSequence ?? notice.eventSequence), this.baselineFeedSequence);
    if (!this.initialized) {
      this.initialized = true;
      this.wasEnabled = enabled;
      this.baselineFeedSequence = latestSequence;
      // The run-created notice is normally committed before navigation reaches
      // the Run page. Admit only that bounded start notice on first attach so
      // enabling speech before starting a Run produces audible confirmation
      // without replaying historical approvals, errors, or results.
      if (enabled) {
        const start = [...notices].reverse().find((notice) =>
          notice.kind === "progress" && notice.eventSequence === 0 && notice.text === "任务已开始。");
        return start === undefined || this.seenNoticeIds.has(start.noticeId) ? [] : [start];
      }
      return [];
    }
    if (!enabled || !this.wasEnabled) {
      this.wasEnabled = enabled;
      this.baselineFeedSequence = latestSequence;
      return [];
    }
    return notices.filter((notice) =>
      (notice.feedSequence ?? notice.eventSequence) > this.baselineFeedSequence && !this.seenNoticeIds.has(notice.noticeId));
  }

  public acknowledge(noticeId: string): void {
    this.seenNoticeIds.add(noticeId);
    while (this.seenNoticeIds.size > 512) this.seenNoticeIds.delete(this.seenNoticeIds.values().next().value as string);
  }
}

/** Bridges ordered Host notices to a replaceable output adapter for one Run. */
export class RunNoticeSpeechController {
  private generation = 0;
  private intentEpoch = 0;
  private sequence = 0;
  private terminal = false;
  private session?: VoiceOutputSession;
  private sessionPromise?: Promise<VoiceOutputSession>;
  private sessionRate?: VoiceSpeechRate;
  private preferredSpeechRate?: VoiceSpeechRate;
  private readonly seenNoticeIds = new Set<string>();
  private readonly inFlightNoticeIds = new Set<string>();
  private readonly pendingNoticeIds = new Map<string, string>();

  private adapter?: VoiceOutputAdapter;

  public constructor(
    private readonly adapterOrFactory: VoiceOutputAdapter | (() => VoiceOutputAdapter),
    private readonly onFailure: (message: string) => void,
  ) {}

  public async deliver(notice: RunNotice, options: RunNoticeSpeechOptions): Promise<RunNoticeDeliveryState> {
    if (this.seenNoticeIds.has(notice.noticeId)) return "handled";
    if (this.inFlightNoticeIds.has(notice.noticeId)) return "deferred";
    if (this.terminal) return "handled";
    if (notice.kind === "result") this.terminal = true;
    if (!options.enabled) {
      this.rememberNotice(notice.noticeId);
      return "handled";
    }
    this.setSpeechRate(options.speechRate);
    if (!this.matchesCurrentPending(notice, options.currentPendingRequest())) {
      if (this.pendingSnapshotMayBeStale(notice, options.snapshotSequence)) return "deferred";
      this.rememberNotice(notice.noticeId);
      return "handled";
    }
    this.inFlightNoticeIds.add(notice.noticeId);
    const intentEpoch = notice.delivery === "interrupt" ? ++this.intentEpoch : this.intentEpoch;

    try {
      if (notice.delivery === "interrupt") await this.cancelPlayback("interrupted");
      if (!this.isCurrentIntent(intentEpoch)) {
        this.rememberNotice(notice.noticeId);
        return "handled";
      }
      const generation = this.generation;
      const session = await this.getSession(generation, options.speechRate);
      if (!session || generation !== this.generation) return "deferred";
      if (!this.isCurrentIntent(intentEpoch) || !options.enabled) {
        this.rememberNotice(notice.noticeId);
        return "handled";
      }
      // Interaction notices can become stale while an adapter is being opened.
      if (!this.matchesCurrentPending(notice, options.currentPendingRequest())) {
        if (this.pendingSnapshotMayBeStale(notice, options.snapshotSequence)) {
          await this.cancelPlayback("interrupted");
          return "deferred";
        }
        this.rememberNotice(notice.noticeId);
        await this.cancelPlayback("interrupted");
        return "handled";
      }
      if (!this.isCurrentIntent(intentEpoch) || this.terminal && notice.kind !== "result") {
        this.rememberNotice(notice.noticeId);
        return "handled";
      }
      this.rememberNotice(notice.noticeId);
      if (notice.pendingRequestId) this.pendingNoticeIds.set(notice.noticeId, notice.pendingRequestId);
      const chunk = { chunkId: notice.noticeId, sequence: ++this.sequence, text: notice.text };
      const playback = session.enqueueText(chunk);
      if (notice.kind === "result") {
        void playback.then(() => session.finish()).then(
          () => this.releasePendingNotice(notice.noticeId),
          (error: unknown) => { this.releasePendingNotice(notice.noticeId); return this.fail(session, error); },
        );
      } else {
        void playback.then(
          () => this.releasePendingNotice(notice.noticeId),
          (error: unknown) => { this.releasePendingNotice(notice.noticeId); return this.fail(session, error); },
        );
      }
      return "handled";
    } catch (error) {
      this.onFailure(error instanceof Error ? error.message : "语音播报失败；通知文字仍保留在任务进展中。");
      await this.cancel("failed");
      this.rememberNotice(notice.noticeId);
      return "handled";
    } finally {
      this.inFlightNoticeIds.delete(notice.noticeId);
    }
  }

  public syncPendingRequest(current: PendingRequestBase | undefined): void {
    const liveId = current?.requestId;
    if ([...this.pendingNoticeIds.values()].some((requestId) => requestId !== liveId)) {
      void this.cancel("interrupted");
    }
  }

  public setSpeechRate(rate: VoiceSpeechRate): void {
    if (this.preferredSpeechRate === rate) return;
    this.preferredSpeechRate = rate;
    if (this.sessionRate !== undefined && this.sessionRate !== rate) void this.cancelPlayback("user");
  }

  public notifyUserStartedInput(): void {
    void this.cancel("user");
  }

  public async cancel(reason: VoiceOutputCancelReason): Promise<void> {
    this.intentEpoch += 1;
    await this.cancelPlayback(reason);
  }

  private async cancelPlayback(reason: VoiceOutputCancelReason): Promise<void> {
    this.generation += 1;
    this.sequence = 0;
    this.pendingNoticeIds.clear();
    const session = this.session;
    const opening = this.sessionPromise;
    this.session = undefined;
    this.sessionPromise = undefined;
    this.sessionRate = undefined;
    if (session) await session.cancel(reason).catch(() => undefined);
    else if (opening) void opening.then((lateSession) => lateSession.cancel(reason)).catch(() => undefined);
  }

  private async getSession(generation: number, speechRate: VoiceSpeechRate): Promise<VoiceOutputSession | undefined> {
    if (this.session) return this.session;
    if (!this.sessionPromise) {
      this.adapter ??= typeof this.adapterOrFactory === "function" ? this.adapterOrFactory() : this.adapterOrFactory;
      this.sessionPromise = this.adapter.openSession({ speechRate });
      this.sessionRate = speechRate;
    }
    const opening = this.sessionPromise;
    const session = await opening;
    if (generation !== this.generation) {
      await session.cancel("run_changed").catch(() => undefined);
      return undefined;
    }
    this.session = session;
    return session;
  }

  private async fail(session: VoiceOutputSession, error?: unknown): Promise<void> {
    if (this.session === session) {
      const detail = error instanceof Error ? `（${error.message}）` : "";
      this.onFailure(`语音播报未能播放${detail}；通知文字仍保留在任务进展中。`);
      await this.cancel("failed");
    }
  }

  private matchesCurrentPending(notice: RunNotice, pending: PendingRequestBase | undefined): boolean {
    if (notice.kind !== "approval" && notice.kind !== "question") return true;
    const expectedKind = notice.kind === "approval" ? "approval" : "user_input";
    return notice.pendingRequestId !== undefined && pending?.requestId === notice.pendingRequestId && pending.kind === expectedKind;
  }

  private pendingSnapshotMayBeStale(notice: RunNotice, snapshotSequence: number | undefined): boolean {
    return (notice.kind === "approval" || notice.kind === "question") && notice.feedSequence !== undefined &&
      (snapshotSequence === undefined || snapshotSequence < notice.feedSequence);
  }

  private isCurrentIntent(intentEpoch: number): boolean {
    return intentEpoch === this.intentEpoch;
  }

  private releasePendingNotice(noticeId: string): void {
    this.pendingNoticeIds.delete(noticeId);
  }

  private rememberNotice(noticeId: string): void {
    this.seenNoticeIds.add(noticeId);
    if (this.seenNoticeIds.size > 512) this.seenNoticeIds.delete(this.seenNoticeIds.values().next().value as string);
  }
}

export function notifyVoiceInputStarted(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(VOICE_INPUT_STARTED_EVENT));
}
