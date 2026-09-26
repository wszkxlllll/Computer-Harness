import { randomBytes } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AssetId, AssetRef, ComputerWindowCandidate, JsonValue, RunOutcome, RuntimeEvent } from "@computer-harness/protocol";
import type { AssetReader } from "@computer-harness/runtime";
import type { ApplicationSession, WindowTargetInfo } from "./application-session.js";
import type { RunHandle } from "./config.js";
import type { EventFeedNotification, EventFeedSubscription } from "./event-feed.js";
import { approvalRequiresVisualReview, projectApprovalPreview } from "./approval-preview.js";
import {
  type RemoteAsset,
  type RemoteCommand,
  type RemoteCommandReceipt,
  type RemoteCommandStatus,
  type RemotePendingRequest,
  type RemoteRunApi,
  type RemoteRunCapabilities,
  type RemoteRunEvent,
  type RemoteRunSnapshot,
  type RemoteRunStatus,
  type RemoteStreamEvent,
  type RemoteSubscription,
  type RemoteWindowTargetLabel,
  type RemoteWindowTargetSet,
} from "./remote-control.js";

interface ManagedRemoteRun {
  readonly handle: RunHandle;
  readonly ownerDeviceId: string;
  readonly target: RemoteWindowTargetLabel;
  readonly startedAt: number;
  readonly eventCapacity: number;
  readonly events: RemoteRunEvent[];
  readonly subscriptions: Map<number, (event: RemoteStreamEvent) => void>;
  readonly assets: Map<string, AssetRef>;
  readonly candidates: Map<string, { requestId: string; candidate: ComputerWindowCandidate }>;
  readonly commandReceipts: Map<string, { fingerprint: string; receipt: RemoteCommandReceipt }>;
  readonly maxCommandReceipts: number;
  eventFeedSubscription?: EventFeedSubscription;
  nextSubscriptionId: number;
  sequence: number;
  rawSequence: number;
  lastPublicStatus: RemoteRunStatus;
  pendingInputRequestId?: string;
  pendingWindowRequestId?: string;
  candidateFingerprint?: string;
  reply?: string;
  lifecycleError?: boolean;
  commandQueue: Promise<void>;
  abortRequested: boolean;
}

interface StartRequest {
  readonly goal: string;
  readonly targetToken: string;
  readonly promise: Promise<RemoteRunSnapshot>;
}

interface WindowTargetSelection extends RemoteWindowTargetLabel {
  readonly pid: number;
  readonly windowId: number;
}

interface DeviceWindowCandidates {
  readonly expiresAt: number;
  readonly candidates: Map<string, WindowTargetSelection>;
}

const DEFAULT_MAX_RUNS = 50;
const DEFAULT_EVENT_CAPACITY = 256;
const DEFAULT_MAX_START_REQUESTS = 4096;
const DEFAULT_MAX_COMMANDS_PER_RUN = 1024;
const WINDOW_TARGET_TTL_MS = 10 * 60_000;
const WINDOW_DISCOVERY_TIMEOUT_MS = 15_000;
const MAX_WINDOW_TARGETS = 64;
const MAX_GOAL_CHARS = 20_000;
const MAX_REPLY_CHARS = 60_000;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;

/** Construct the existing write-once asset reader for one Host-owned Run. */
export function createFileRemoteAssetReader(rootDir: string): AssetReader {
  const allowedRoot = resolve(rootDir);
  return {
    async read(ref, signal) {
      signal.throwIfAborted();
      const segments = normalizeRemoteAssetPath(ref.relativePath);
      if (!Number.isSafeInteger(ref.byteLength) || ref.byteLength < 0) throw new Error("remote asset byte length is invalid");
      if (ref.byteLength > MAX_ASSET_BYTES) throw new Error("remote asset exceeds the transfer limit");
      const expectedByteLength = BigInt(ref.byteLength);
      const root = await realpath(allowedRoot);
      const destination = resolve(root, ...segments);
      if (!isContainedPath(root, destination)) throw new Error("remote asset path is outside its run asset directory");

      let componentPath = root;
      for (let index = 0; index < segments.length; index += 1) {
        componentPath = resolve(componentPath, segments[index]!);
        const component = await lstat(componentPath);
        if (component.isSymbolicLink()) throw new Error("remote asset path contains a symlink");
        if (index < segments.length - 1 && !component.isDirectory()) throw new Error("remote asset path contains a non-directory component");
      }

      const beforeOpen = await lstat(destination, { bigint: true });
      if (!beforeOpen.isFile() || beforeOpen.size !== expectedByteLength) throw new Error("remote asset metadata does not match its stored reference");
      // Portable Node APIs do not expose openat/O_NOFOLLOW on every target OS.
      // Rechecking the path after opening and reading from this handle narrows
      // local-writer races; it cannot eliminate a hostile local TOCTOU race.
      const file = await open(destination, "r");
      try {
        const [openedStat, resolvedPath] = await Promise.all([file.stat({ bigint: true }), realpath(destination)]);
        signal.throwIfAborted();
        // On Windows, lstat may expose an unknown device id (dev=0) even when
        // fstat on the opened handle reports the volume serial. Compare each
        // identity field independently when both calls provide it. BigInt
        // stats also preserve the full 64-bit file id.
        const deviceChanged = beforeOpen.dev !== 0n && openedStat.dev !== 0n && beforeOpen.dev !== openedStat.dev;
        const fileIdChanged = beforeOpen.ino !== 0n && openedStat.ino !== 0n && beforeOpen.ino !== openedStat.ino;
        if (!openedStat.isFile() || openedStat.size !== expectedByteLength || deviceChanged || fileIdChanged ||
            !isContainedPath(root, resolvedPath)) {
          throw new Error("remote asset changed while it was being opened");
        }
        const data = await file.readFile();
        signal.throwIfAborted();
        if (data.byteLength !== ref.byteLength || data.byteLength > MAX_ASSET_BYTES) throw new Error("remote asset byte length is invalid");
        return new Uint8Array(data);
      } finally {
        await file.close();
      }
    },
  };
}

export class RemoteRunApiError extends Error {
  public constructor(
    public readonly code: "RUN_NOT_FOUND" | "RUN_BUSY" | "STALE_SEQUENCE" | "STALE_REQUEST" | "INVALID_COMMAND" | "IDEMPOTENCY_CONFLICT" | "CAPACITY_REACHED" | "WINDOW_TARGET_STALE" | "WINDOW_DISCOVERY_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "RemoteRunApiError";
  }
}

export interface ApplicationRemoteRunApiOptions {
  readonly session: ApplicationSession;
  readonly capabilities: RemoteRunCapabilities;
  readonly assetReaderForRun?: (runId: string, handle: RunHandle) => AssetReader | undefined;
  readonly maxRuns?: number;
  readonly maxStartRequests?: number;
  readonly maxCommandsPerRun?: number;
  readonly eventCapacity?: number;
  readonly now?: () => number;
}

/** Adapts ApplicationSession and its committed feed into a redacted remote view. */
export class ApplicationRemoteRunApi implements RemoteRunApi {
  private readonly runs = new Map<string, ManagedRemoteRun>();
  private readonly startRequests = new Map<string, StartRequest>();
  private readonly windowCandidates = new Map<string, DeviceWindowCandidates>();
  private readonly session: ApplicationSession;
  private readonly capabilities: RemoteRunCapabilities;
  private readonly assetReaderForRun: ApplicationRemoteRunApiOptions["assetReaderForRun"];
  private readonly maxRuns: number;
  private readonly maxStartRequests: number;
  private readonly maxCommandsPerRun: number;
  private readonly eventCapacity: number;
  private readonly now: () => number;

  public constructor(options: ApplicationRemoteRunApiOptions) {
    this.session = options.session;
    this.capabilities = { ...options.capabilities };
    this.assetReaderForRun = options.assetReaderForRun;
    this.maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS;
    this.maxStartRequests = options.maxStartRequests ?? DEFAULT_MAX_START_REQUESTS;
    this.maxCommandsPerRun = options.maxCommandsPerRun ?? DEFAULT_MAX_COMMANDS_PER_RUN;
    this.eventCapacity = options.eventCapacity ?? DEFAULT_EVENT_CAPACITY;
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(this.maxRuns) || this.maxRuns < 1) throw new Error("maxRuns must be a positive integer");
    if (!Number.isInteger(this.maxStartRequests) || this.maxStartRequests < 1) throw new Error("maxStartRequests must be a positive integer");
    if (!Number.isInteger(this.maxCommandsPerRun) || this.maxCommandsPerRun < 1) throw new Error("maxCommandsPerRun must be a positive integer");
    if (!Number.isInteger(this.eventCapacity) || this.eventCapacity < 8) throw new Error("eventCapacity must be at least 8");
  }

  public listRuns(deviceId: string): readonly RemoteRunSnapshot[] {
    return [...this.runs.values()]
      .filter((record) => record.ownerDeviceId === deviceId)
      .sort((left, right) => right.startedAt - left.startedAt)
      .map((record) => this.snapshot(record));
  }

  public getRun(deviceId: string, runId: string): RemoteRunSnapshot | undefined {
    const record = this.runs.get(runId);
    return record === undefined || record.ownerDeviceId !== deviceId ? undefined : this.snapshot(record);
  }

  public async listWindowTargets(deviceId: string): Promise<RemoteWindowTargetSet> {
    // A refresh invalidates earlier choices even if the new inventory fails.
    this.windowCandidates.delete(deviceId);
    let windows: readonly WindowTargetInfo[];
    try {
      windows = await this.session.listWindowTargets(AbortSignal.timeout(WINDOW_DISCOVERY_TIMEOUT_MS));
    } catch (error) {
      const message = errorMessage(error);
      if (/active Run|no Run is active/iu.test(message)) {
        throw new RemoteRunApiError("RUN_BUSY", "Window choices are available only while the Host has no active Run.");
      }
      throw new RemoteRunApiError("WINDOW_DISCOVERY_FAILED", "The Host could not safely refresh visible desktop windows. Try again after the desktop is ready.");
    }
    const choices = new Map<string, WindowTargetSelection>();
    const candidates = windows.slice(0, MAX_WINDOW_TARGETS).map((window) => {
      const token = randomBytes(24).toString("base64url");
      const appName = boundedText(window.appName, 256);
      const title = boundedText(window.title, 512);
      const choice: WindowTargetSelection = {
        pid: window.pid,
        windowId: window.windowId,
        ...(appName === undefined ? {} : { appName }),
        ...(title === undefined ? {} : { title }),
      };
      choices.set(token, choice);
      return {
        token,
        ...(choice.appName === undefined ? {} : { appName: choice.appName }),
        ...(choice.title === undefined ? {} : { title: choice.title }),
      };
    });
    const expiresAt = this.now() + WINDOW_TARGET_TTL_MS;
    this.windowCandidates.set(deviceId, { expiresAt, candidates: choices });
    return { candidates, expiresAt: new Date(expiresAt).toISOString() };
  }

  public startRun(deviceId: string, commandId: string, goal: string, targetToken: string): Promise<RemoteRunSnapshot> {
    const cleanGoal = validateText(goal, MAX_GOAL_CHARS, "goal");
    const cleanCommandId = validateIdentifier(commandId, "commandId");
    const key = deviceId + "\u0000" + cleanCommandId;
    const existing = this.startRequests.get(key);
    if (existing !== undefined) {
      if (existing.goal !== cleanGoal || existing.targetToken !== targetToken) return Promise.reject(new RemoteRunApiError("IDEMPOTENCY_CONFLICT", "commandId was already used with different Run details"));
      return existing.promise;
    }
    if (this.startRequests.size >= this.maxStartRequests) {
      return Promise.reject(new RemoteRunApiError("CAPACITY_REACHED", "The Host reached its safe start-request limit. Existing command IDs remain protected from replay; restart the Host to begin a new deduplication epoch."));
    }
    let choice: WindowTargetSelection;
    try {
      validateWindowTargetToken(targetToken);
      choice = this.takeWindowTarget(deviceId, targetToken);
    } catch (error) {
      return Promise.reject(error);
    }
    let resolvePromise!: (snapshot: RemoteRunSnapshot) => void;
    let rejectPromise!: (error: unknown) => void;
    const promise = new Promise<RemoteRunSnapshot>((resolvePromiseValue, rejectPromiseValue) => {
      resolvePromise = resolvePromiseValue;
      rejectPromise = rejectPromiseValue;
    });
    // Reserve the idempotency key synchronously before fresh discovery yields.
    this.startRequests.set(key, { goal: cleanGoal, targetToken, promise });
    void this.createRun(deviceId, cleanGoal, choice)
      .then(resolvePromise, rejectPromise);
    return promise;
  }

  public async submitCommand(deviceId: string, runId: string, command: RemoteCommand): Promise<RemoteCommandReceipt> {
    const record = this.requireRun(runId, deviceId);
    validateIdentifier(command.commandId, "commandId");
    if (command.type === "correct" || command.type === "respond") validateText(command.text, 8_000, "text");
    const key = deviceId + "\u0000" + command.commandId;
    const fingerprint = stableJson(command);
    const existing = record.commandReceipts.get(key);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) throw new RemoteRunApiError("IDEMPOTENCY_CONFLICT", "commandId was already used with a different command");
      return { ...existing.receipt };
    }
    if (record.commandReceipts.size >= record.maxCommandReceipts) {
      throw new RemoteRunApiError("CAPACITY_REACHED", "This Run reached its safe command deduplication limit. Start a new Run rather than reusing an untracked command ID.");
    }
    if (command.expectedSequence !== record.sequence) throw new RemoteRunApiError("STALE_SEQUENCE", "Run state changed; refresh before sending this command.");

    const runtime = record.handle.controller.getSnapshot();
    const currentRequest = this.pendingRequest(record, runtime);
    const requestId = "requestId" in command ? command.requestId : undefined;
    if (command.type === "approve" || command.type === "reject" || command.type === "respond" || command.type === "window.confirm" || command.type === "window.ignore") {
      if (currentRequest?.requestId !== requestId) throw new RemoteRunApiError("STALE_REQUEST", "That request is no longer waiting for a response.");
    }
    if (command.type === "correct" && command.requestId !== undefined && currentRequest?.requestId !== command.requestId) {
      throw new RemoteRunApiError("STALE_REQUEST", "That request is no longer waiting for a correction.");
    }

    const acceptedAt = new Date(this.now()).toISOString();
    const acceptedReceipt: RemoteCommandReceipt = {
      commandId: command.commandId,
      runId: record.handle.runId,
      status: "accepted",
      acceptedAt,
    };
    record.commandReceipts.set(key, { fingerprint, receipt: acceptedReceipt });
    this.publish(record, { type: "run.command_receipt", commandId: command.commandId, status: "accepted" });
    const receiptWithSequence = { ...acceptedReceipt, sequence: record.sequence };
    record.commandReceipts.set(key, { fingerprint, receipt: receiptWithSequence });

    if (command.type === "abort") {
      try {
        record.handle.controller.cancel("aborted from paired device");
        record.abortRequested = true;
      } catch {
        this.finishReceipt(record, key, fingerprint, command.commandId, "rejected", "Run is already finished.");
      }
      return { ...(record.commandReceipts.get(key)?.receipt ?? receiptWithSequence) };
    }

    record.commandQueue = record.commandQueue.then(async () => {
      try {
        await this.applyCommand(record, command, currentRequest);
        this.finishReceipt(record, key, fingerprint, command.commandId, "applied");
      } catch (error) {
        const message = isExpectedStaleCommand(error)
          ? "Run state changed before the command took effect."
          : "The command could not be applied to the current Run.";
        this.finishReceipt(record, key, fingerprint, command.commandId, "rejected", message);
      }
    });
    void record.commandQueue.catch(() => undefined);
    return { ...receiptWithSequence };
  }

  public getCommandReceipt(deviceId: string, runId: string, commandId: string): RemoteCommandReceipt | undefined {
    const record = this.runs.get(runId);
    if (record === undefined || record.ownerDeviceId !== deviceId) return undefined;
    const entry = record.commandReceipts.get(deviceId + "\u0000" + commandId);
    return entry === undefined ? undefined : { ...entry.receipt };
  }

  public subscribe(
    deviceId: string,
    runId: string,
    afterSequence: number,
    listener: (event: RemoteStreamEvent) => void,
  ): RemoteSubscription {
    const record = this.requireRun(runId, deviceId);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new RemoteRunApiError("INVALID_COMMAND", "event cursor must be a non-negative safe integer");
    const firstSequence = record.events[0]?.sequence;
    if (afterSequence > record.sequence || (firstSequence !== undefined && afterSequence < firstSequence - 1)) {
      safeNotify(listener, { type: "resync_required", runId: record.handle.runId, afterSequence, latestSequence: record.sequence });
      return { close() {} };
    }
    for (const event of record.events) if (event.sequence > afterSequence) safeNotify(listener, structuredClone(event));
    const subscriptionId = record.nextSubscriptionId++;
    record.subscriptions.set(subscriptionId, listener);
    return { close: () => { record.subscriptions.delete(subscriptionId); } };
  }

  public async getAsset(deviceId: string, runId: string, assetId: string): Promise<RemoteAsset | undefined> {
    const record = this.runs.get(runId);
    if (record === undefined || record.ownerDeviceId !== deviceId) return undefined;
    const ref = record.assets.get(assetId);
    const reader = this.assetReaderForRun?.(runId, record.handle);
    if (ref === undefined || reader === undefined) return undefined;
    const data = await reader.read(ref, new AbortController().signal);
    if (data.byteLength > MAX_ASSET_BYTES) return undefined;
    return { data, mediaType: safeMediaType(ref.mediaType) };
  }

  private takeWindowTarget(deviceId: string, token: string): WindowTargetSelection {
    const set = this.windowCandidates.get(deviceId);
    if (set === undefined || set.expiresAt <= this.now()) {
      this.windowCandidates.delete(deviceId);
      throw new RemoteRunApiError("WINDOW_TARGET_STALE", "The window choice expired. Refresh the list and choose again.");
    }
    const choice = set.candidates.get(token);
    if (choice === undefined) throw new RemoteRunApiError("WINDOW_TARGET_STALE", "The window choice was already used or refreshed. Refresh the list and choose again.");
    set.candidates.delete(token);
    return choice;
  }

  private async createRun(deviceId: string, goal: string, target: WindowTargetSelection): Promise<RemoteRunSnapshot> {
    let currentWindows: readonly WindowTargetInfo[];
    try {
      currentWindows = await this.session.listWindowTargets(AbortSignal.timeout(WINDOW_DISCOVERY_TIMEOUT_MS));
    } catch {
      throw new RemoteRunApiError("WINDOW_DISCOVERY_FAILED", "The Host could not verify the selected desktop window. Refresh the list and try again.");
    }
    const stillPresent = currentWindows.some((window) =>
      window.pid === target.pid && window.windowId === target.windowId &&
      boundedText(window.appName, 256) === target.appName && boundedText(window.title, 512) === target.title);
    if (!stillPresent) throw new RemoteRunApiError("WINDOW_TARGET_STALE", "The selected window changed or closed. Refresh the list and choose again.");
    let handle: RunHandle;
    try {
      handle = await this.session.startRun(goal, {
        windowTarget: { pid: target.pid, windowId: target.windowId },
        windowDeliveryMode: "foreground",
      });
    } catch (error) {
      const message = errorMessage(error);
      if (/owned by run|environment .*locked|pending_cleanup|already has an active Run/iu.test(message)) {
        throw new RemoteRunApiError("RUN_BUSY", "The Host already has a Run or unresolved desktop cleanup.");
      }
      throw error;
    }
    const runtime = handle.controller.getSnapshot();
    const record: ManagedRemoteRun = {
      handle,
      ownerDeviceId: deviceId,
      target: {
        ...(target.appName === undefined ? {} : { appName: target.appName }),
        ...(target.title === undefined ? {} : { title: target.title }),
      },
      startedAt: this.now(),
      eventCapacity: this.eventCapacity,
      events: [],
      subscriptions: new Map(),
      assets: new Map(),
      candidates: new Map(),
      commandReceipts: new Map(),
      maxCommandReceipts: this.maxCommandsPerRun,
      nextSubscriptionId: 1,
      sequence: 0,
      rawSequence: -1,
      lastPublicStatus: mapStatus(runtime.status),
      commandQueue: Promise.resolve(),
      abortRequested: false,
    };
    this.runs.set(handle.runId, record);
    this.pruneRuns();
    for (const event of handle.controller.getEvents()) this.acceptRuntimeEvent(record, event);
    record.eventFeedSubscription = handle.eventFeed.subscribe({
      afterSequence: record.rawSequence,
      listener: (notification: EventFeedNotification) => {
        if (notification.type === "event") this.acceptRuntimeEvent(record, notification.event);
        else if (notification.status === "resync_required") this.publish(record, { type: "run.resync_required" });
      },
    });
    void this.watchCompletion(record);
    return this.snapshot(record);
  }

  private async watchCompletion(record: ManagedRemoteRun): Promise<void> {
    try {
      await this.session.waitForActiveRun();
    } catch {
      record.lifecycleError = true;
    }
    const runtime = record.handle.controller.getSnapshot();
    if (runtime.status === "finished") {
      if (runtime.outcome === "outcome_unknown") {
        for (const [key, value] of record.commandReceipts) {
          if (value.receipt.status === "accepted") this.finishReceipt(record, key, value.fingerprint, value.receipt.commandId, "outcome_unknown", "Run ended with an unresolved external side effect.");
        }
      } else if (record.abortRequested) {
        for (const [key, value] of record.commandReceipts) {
          if (value.receipt.status === "accepted") this.finishReceipt(record, key, value.fingerprint, value.receipt.commandId, "applied", "Abort request reached the Run; completed side effects were not undone.");
        }
      }
    } else {
      record.lifecycleError = true;
    }
    if (record.lifecycleError) {
      for (const [key, value] of record.commandReceipts) {
        if (value.receipt.status === "accepted") this.finishReceipt(record, key, value.fingerprint, value.receipt.commandId, "outcome_unknown", "Run completion could not be confirmed.");
      }
    }
    record.eventFeedSubscription?.unsubscribe();
    delete record.eventFeedSubscription;
  }

  private async applyCommand(record: ManagedRemoteRun, command: RemoteCommand, currentRequest: RemotePendingRequest | undefined): Promise<void> {
    const controller = record.handle.controller;
    switch (command.type) {
      case "pause":
        await controller.pause("paused from paired device");
        return;
      case "resume":
        await controller.resume();
        return;
      case "correct":
        await controller.submitUserInput(command.text, command.requestId);
        return;
      case "respond":
        if (currentRequest?.kind !== "user_input") throw new RemoteRunApiError("STALE_REQUEST", "No matching user input request is waiting.");
        await controller.submitUserInput(command.text, command.requestId);
        return;
      case "approve":
        await controller.resolveApproval(command.requestId, true);
        return;
      case "reject":
        await controller.resolveApproval(command.requestId, false);
        return;
      case "window.confirm": {
        const entry = record.candidates.get(command.candidateToken);
        if (entry === undefined || entry.requestId !== command.requestId || currentRequest?.kind !== "window_handoff") {
          throw new RemoteRunApiError("STALE_REQUEST", "Window candidate expired; refresh the pending request.");
        }
        await controller.handoffWindow(entry.candidate, command.requestId);
        return;
      }
      case "window.ignore":
        if (currentRequest?.kind !== "window_handoff") throw new RemoteRunApiError("STALE_REQUEST", "No matching window handoff is waiting.");
        await controller.ignoreNewWindowAndContinueOnCurrentTarget(command.requestId);
        return;
      case "abort":
        return;
    }
  }

  private acceptRuntimeEvent(record: ManagedRemoteRun, event: RuntimeEvent): void {
    if (event.sequence <= record.rawSequence || event.runId !== record.handle.runId) return;
    record.rawSequence = event.sequence;
    const runtime = record.handle.controller.getSnapshot();
    const status = mapStatus(runtime.status);
    if (event.type === "observation.created") record.assets.set(event.observation.screenshot.assetId, structuredClone(event.observation.screenshot));
    if (event.type === "user.input.requested") record.pendingInputRequestId = event.eventId;
    if (event.type === "user.input.received") delete record.pendingInputRequestId;
    if (event.type === "computer.window.handoff.requested") {
      record.pendingWindowRequestId = event.sourceActionId;
      delete record.candidateFingerprint;
      record.candidates.clear();
      void this.refreshWindowCandidates(record, event.sourceActionId);
    }
    if (event.type === "computer.window.handoff.completed" || event.type === "computer.window.handoff.ignored") {
      delete record.pendingWindowRequestId;
      delete record.candidateFingerprint;
      record.candidates.clear();
    }
    if (event.type === "run.finished") {
      const reply = boundedText(event.summary ?? runtime.summary, MAX_REPLY_CHARS);
      if (reply === undefined) delete record.reply;
      else record.reply = reply;
      record.eventFeedSubscription?.unsubscribe();
      delete record.eventFeedSubscription;
    }
    if (event.type === "runtime.error" && event.category === "cleanup") record.lifecycleError = true;
    if (status !== record.lastPublicStatus) {
      record.lastPublicStatus = status;
      this.publish(record, { type: "run.status", status });
    }
    const pending = this.pendingRequest(record, runtime);
    if (event.type === "approval.requested" || event.type === "approval.resolved" ||
        event.type === "user.input.requested" || event.type === "user.input.received" ||
        event.type === "computer.window.handoff.requested" || event.type === "computer.window.handoff.completed" ||
        event.type === "computer.window.handoff.ignored") {
      this.publish(record, { type: "run.pending_request", ...(pending === undefined ? { cleared: true } : { request: publicRequest(pending) }) });
    }
    const projected = projectRuntimeEvent(event, record.reply);
    if (projected !== undefined) this.publish(record, projected);
  }

  private async refreshWindowCandidates(record: ManagedRemoteRun, requestId: string): Promise<void> {
    try {
      const candidates = await record.handle.controller.listWindowHandoffCandidates(new AbortController().signal);
      const snapshot = record.handle.controller.getSnapshot();
      if (snapshot.pendingWindowHandoff?.sourceActionId !== requestId || snapshot.status !== "waiting_window") return;
      const fingerprint = JSON.stringify(candidates.map(candidateKey).sort());
      if (fingerprint === record.candidateFingerprint) return;
      record.candidateFingerprint = fingerprint;
      record.candidates.clear();
      for (const candidate of candidates.slice(0, 32)) {
        const token = randomBytes(24).toString("base64url");
        record.candidates.set(token, { requestId, candidate: structuredClone(candidate) });
      }
      const pending = this.pendingRequest(record, snapshot);
      if (pending !== undefined) this.publish(record, { type: "run.pending_request", request: publicRequest(pending) });
    } catch {
      // Keep the request pending; an unavailable picker never selects automatically.
    }
  }

  private pendingRequest(record: ManagedRemoteRun, snapshot: ReturnType<RunHandle["controller"]["getSnapshot"]>): RemotePendingRequest | undefined {
    if (snapshot.pendingApproval !== undefined) {
      const pending = snapshot.pendingApproval;
      const events = record.handle.controller.getEvents();
      const preview = projectApprovalPreview(events, pending.requestId, pending.callId);
      return {
        requestId: pending.requestId,
        kind: "approval",
        reason: boundedText(pending.reason, 2_000) ?? "Approval required.",
        requiresVisualReview: approvalRequiresVisualReview(events, pending.requestId, pending.callId),
        ...(preview === undefined ? {} : { preview }),
      };
    }
    if (snapshot.pendingUserQuestion !== undefined && record.pendingInputRequestId !== undefined) {
      return { requestId: record.pendingInputRequestId, kind: "user_input", question: boundedText(snapshot.pendingUserQuestion, 2_000) ?? "Input required." };
    }
    if (snapshot.pendingWindowHandoff !== undefined && record.pendingWindowRequestId === snapshot.pendingWindowHandoff.sourceActionId) {
      const candidates = [...record.candidates.entries()]
        .filter(([, entry]) => entry.requestId === snapshot.pendingWindowHandoff!.sourceActionId)
        .map(([token, entry]) => {
          const appName = boundedText(entry.candidate.appName, 256);
          const title = boundedText(entry.candidate.title, 512);
          return {
            token,
            ...(appName === undefined ? {} : { appName }),
            ...(title === undefined ? {} : { title }),
          };
        });
      return {
        requestId: snapshot.pendingWindowHandoff.sourceActionId,
        kind: "window_handoff",
        reasonCode: snapshot.pendingWindowHandoff.reasonCode,
        candidates,
      };
    }
    return undefined;
  }

  private snapshot(record: ManagedRemoteRun): RemoteRunSnapshot {
    const runtime = record.handle.controller.getSnapshot();
    const pendingRequest = this.pendingRequest(record, runtime);
    const active = runtime.status !== "finished";
    const latestAssetId = [...record.assets.values()].at(-1)?.assetId as AssetId | undefined;
    const reply = boundedText(record.reply ?? runtime.summary, MAX_REPLY_CHARS);
    return {
      runId: record.handle.runId,
      goal: boundedText(record.handle.config.goal, MAX_GOAL_CHARS) ?? "",
      status: mapStatus(runtime.status),
      sequence: record.sequence,
      ...(runtime.outcome === undefined ? {} : { outcome: runtime.outcome }),
      ...(record.lifecycleError ? { error: "Run completion or cleanup could not be confirmed." } : {}),
      ...(reply === undefined ? {} : { reply }),
      ...(pendingRequest === undefined ? {} : { pendingRequest }),
      target: { ...record.target },
      ...(latestAssetId === undefined ? {} : { latestAssetId }),
      capabilities: {
        pause: this.capabilities.pause && runtime.status === "running" && runtime.unresolvedActionId === undefined,
        resume: this.capabilities.resume && runtime.status === "paused",
        abort: this.capabilities.abort && active,
        correct: this.capabilities.correct && active && ["running", "paused", "waiting_user", "waiting_approval"].includes(runtime.status),
        approval: this.capabilities.approval && pendingRequest?.kind === "approval",
        windowHandoff: this.capabilities.windowHandoff && pendingRequest?.kind === "window_handoff",
      },
    };
  }

  private publish(record: ManagedRemoteRun, data: Readonly<Record<string, JsonValue>>): void {
    const event: RemoteRunEvent = {
      type: "run.event",
      runId: record.handle.runId,
      sequence: ++record.sequence,
      data: structuredClone(data),
    };
    record.events.push(event);
    if (record.events.length > record.eventCapacity) record.events.splice(0, record.events.length - record.eventCapacity);
    for (const listener of record.subscriptions.values()) safeNotify(listener, structuredClone(event));
  }

  private finishReceipt(
    record: ManagedRemoteRun,
    key: string,
    fingerprint: string,
    commandId: string,
    status: Exclude<RemoteCommandStatus, "accepted">,
    message?: string,
  ): void {
    const acceptedAt = record.commandReceipts.get(key)?.receipt.acceptedAt ?? new Date(this.now()).toISOString();
    this.publish(record, { type: "run.command_receipt", commandId, status, ...(message === undefined ? {} : { message }) });
    const receipt: RemoteCommandReceipt = {
      commandId,
      runId: record.handle.runId,
      status,
      acceptedAt,
      completedAt: new Date(this.now()).toISOString(),
      sequence: record.sequence,
      ...(message === undefined ? {} : { message }),
    };
    record.commandReceipts.set(key, { fingerprint, receipt });
  }

  private requireRun(runId: string, deviceId: string): ManagedRemoteRun {
    const record = this.runs.get(runId);
    if (record === undefined || record.ownerDeviceId !== deviceId) throw new RemoteRunApiError("RUN_NOT_FOUND", "Run was not found.");
    return record;
  }

  private pruneRuns(): void {
    const ordered = [...this.runs.entries()].sort((left, right) => left[1].startedAt - right[1].startedAt);
    while (ordered.length > this.maxRuns) {
      const index = ordered.findIndex(([, record]) => record.handle.controller.getSnapshot().status === "finished");
      if (index < 0) return;
      const [runId, record] = ordered.splice(index, 1)[0]!;
      record.eventFeedSubscription?.unsubscribe();
      record.subscriptions.clear();
      this.runs.delete(runId);
    }
  }
}

function projectRuntimeEvent(event: RuntimeEvent, reply: string | undefined): Readonly<Record<string, JsonValue>> | undefined {
  switch (event.type) {
    case "observation.created":
      return {
        type: "run.observation",
        assetId: event.observation.screenshot.assetId,
        mediaType: safeMediaType(event.observation.screenshot.mediaType),
        capturedAt: event.observation.capturedAt,
        viewport: { width: event.observation.viewport.width, height: event.observation.viewport.height },
      };
    case "user.input.received":
      return { type: "run.input_received" };
    case "run.finished":
      return { type: "run.reply", outcome: event.outcome, ...(reply === undefined ? {} : { reply }) };
    case "runtime.error":
    case "model.request.failed":
      return { type: "run.issue", category: safeIssueCategory(event.category) };
    default:
      return undefined;
  }
}

function publicRequest(request: RemotePendingRequest): JsonValue {
  if (request.kind === "approval") return {
    kind: request.kind,
    requestId: request.requestId,
    reason: request.reason,
    requiresVisualReview: request.requiresVisualReview,
    ...(request.preview === undefined ? {} : {
      preview: {
        actions: request.preview.actions.map((action) => ({
          operation: action.operation,
          kind: action.kind,
          ...(action.points === undefined ? {} : { points: action.points.map((point) => ({ x: point.x, y: point.y })) }),
          ...(action.keys === undefined ? {} : { keys: [...action.keys] }),
          ...(action.typedCharacterCount === undefined ? {} : { typedCharacterCount: action.typedCharacterCount }),
        })),
        ...(request.preview.evidence === undefined ? {} : {
          evidence: {
            assetId: request.preview.evidence.assetId,
            observationId: request.preview.evidence.observationId,
            decisionObservationId: request.preview.evidence.decisionObservationId,
            capturedAt: request.preview.evidence.capturedAt,
            viewport: {
              width: request.preview.evidence.viewport.width,
              height: request.preview.evidence.viewport.height,
              coordinateSpace: request.preview.evidence.viewport.coordinateSpace,
            },
          },
        }),
        ...(request.preview.modelDeclaredEffect === undefined ? {} : {
          modelDeclaredEffect: {
            target: request.preview.modelDeclaredEffect.target,
            summary: request.preview.modelDeclaredEffect.summary,
            verified: false,
          },
        }),
      },
    }),
  };
  if (request.kind === "user_input") return { kind: request.kind, requestId: request.requestId, question: request.question };
  return {
    kind: request.kind,
    requestId: request.requestId,
    reasonCode: request.reasonCode,
    candidates: request.candidates.map((candidate) => ({
      token: candidate.token,
      ...(candidate.appName === undefined ? {} : { appName: candidate.appName }),
      ...(candidate.title === undefined ? {} : { title: candidate.title }),
    })),
  };
}

function mapStatus(status: string): RemoteRunStatus {
  if (status === "starting") return "running";
  if (status === "created" || status === "running" || status === "waiting_user" ||
      status === "waiting_approval" || status === "waiting_window" || status === "paused" || status === "finished") return status;
  return "finished";
}

function safeIssueCategory(category: string): string {
  const allowed = new Set(["provider", "transport", "validation", "safety", "budget", "computer", "cleanup", "control"]);
  return allowed.has(category) ? category : "run";
}

function safeMediaType(value: string): string {
  if (!/^(?:image\/(?:png|jpeg|webp)|application\/pdf|text\/plain)$/iu.test(value)) return "application/octet-stream";
  return value.toLowerCase();
}

function candidateKey(candidate: ComputerWindowCandidate): string {
  return String(candidate.pid) + ":" + String(candidate.windowId) + ":" + (candidate.appName ?? "") + ":" + (candidate.title ?? "");
}

function boundedText(value: string | undefined, maxChars: number): string | undefined {
  if (value === undefined) return undefined;
  const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "").slice(0, maxChars);
  return clean.length === 0 ? undefined : clean;
}

function validateText(value: string, maxChars: number, name: string): string {
  if (typeof value !== "string") throw new RemoteRunApiError("INVALID_COMMAND", name + " must be text");
  const clean = value.trim();
  if (clean.length === 0 || clean.length > maxChars) throw new RemoteRunApiError("INVALID_COMMAND", name + " must contain 1 to " + String(maxChars) + " characters");
  return clean;
}

function validateIdentifier(value: string, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) throw new RemoteRunApiError("INVALID_COMMAND", name + " is invalid");
  return value;
}

function validateWindowTargetToken(value: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{32}$/u.test(value)) {
    throw new RemoteRunApiError("WINDOW_TARGET_STALE", "The window choice is invalid. Refresh the list and choose again.");
  }
}

function stableJson(value: unknown): string {
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  const record = value as Record<string, unknown>;
  return "{" + Object.keys(record).sort().map((key) => JSON.stringify(key) + ":" + stableJson(record[key])).join(",") + "}";
}

function safeNotify(listener: (event: RemoteStreamEvent) => void, event: RemoteStreamEvent): void {
  try {
    listener(event);
  } catch {
    // A network/UI subscriber never participates in Runtime control.
  }
}

function isExpectedStaleCommand(error: unknown): boolean {
  return error instanceof RemoteRunApiError && (error.code === "STALE_REQUEST" || error.code === "STALE_SEQUENCE");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeRemoteAssetPath(value: string): string[] {
  if (!value || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/u.test(value)) {
    throw new Error("remote asset reference is not a relative POSIX path");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error("remote asset reference contains an invalid path component");
  }
  return segments;
}

function isContainedPath(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(".." + sep) && !isAbsolute(relativePath);
}
