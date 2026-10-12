import { createHash, randomBytes } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { MAX_WINDOW_PREVIEW_BYTES, normalizeRunAssistantPreferencesSnapshot, type RunAssistantPreferencesSnapshot } from "@computer-harness/protocol";
import type { AssetId, AssetRef, ComputerWindowCandidate, JsonValue, RunOutcome, RuntimeEvent } from "@computer-harness/protocol";
import type { AssetReader } from "@computer-harness/runtime";
import { inspectManagedBrowserProfile, readManagedBrowserStartupUrls } from "@computer-harness/computer-cua";
import type { ApplicationSession, ApplicationSessionRunFeatureOverrides, WindowTargetInfo, WindowTargetPreview } from "./application-session.js";
import type { RunHandle } from "./config.js";
import type { EventFeedNotification, EventFeedSubscription } from "./event-feed.js";
import { RunNoticeProjector, RunNoticeScheduler, type RunNoticeGeneration } from "@computer-harness/voice";
import { approvalRequiresVisualReview, projectApprovalPreview, projectApprovalVoiceContext } from "./approval-preview.js";
import { normalizeWindowPreviewPng, WindowPreviewImageError } from "./window-preview-image.js";
import { filterIndistinguishableWindowTargets, filterInitialTargetWindowCandidates, hasExplicitApplicationIntent, matchGoalToWindow, targetsForExplicitApplicationIntent } from "./window-target-matcher.js";
import type { WindowSelectionStrategy } from "./window-selection-jev.js";
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
  type RemoteRunTarget,
  type RemoteRunTargetInput,
  type RemoteBrowserSessionMode,
  type RemoteApprovalPreview,
  type RemoteStreamEvent,
  type RemoteSubscription,
  type RemoteWindowTargetLabel,
  type RemoteWindowCandidateRelationship,
  type RemoteWindowCandidatePreview,
  type RemoteWindowCandidate,
  type RemoteWindowTargetSet,
  type HostNativeRecoveryProfile,
} from "./remote-control.js";

interface ManagedRemoteRun {
  readonly handle: RunHandle;
  readonly ownerDeviceId: string;
  target: RemoteWindowTargetLabel;
  targetIdentity?: { readonly pid: number; readonly windowId: number };
  readonly startedAt: number;
  readonly eventCapacity: number;
  readonly events: RemoteRunEvent[];
  readonly subscriptions: Map<number, (event: RemoteStreamEvent) => void>;
  readonly assets: Map<string, AssetRef>;
  readonly releaseManagedBrowserUse?: () => Promise<void>;
  readonly candidates: Map<string, RemoteHandoffCandidate>;
  readonly windowInventory: Map<string, RemoteWindowTargetLabel>;
  readonly switchWindowRefs: Map<string, string>;
  pendingWindowInventoryCallId?: string;
  readonly commandReceipts: Map<string, { fingerprint: string; receipt: RemoteCommandReceipt }>;
  readonly maxCommandReceipts: number;
  readonly noticeProjector?: RunNoticeProjector;
  readonly noticeScheduler?: RunNoticeScheduler;
  readonly noticeGeneration?: RunNoticeGeneration;
  eventFeedSubscription?: EventFeedSubscription;
  nextSubscriptionId: number;
  sequence: number;
  rawSequence: number;
  lastPublicStatus: RemoteRunStatus;
  pendingInputRequestId?: string;
  pendingWindowRequestId?: string;
  windowCandidateRefresh?: WindowCandidateRefresh;
  omittedWindowCandidateCount?: number;
  candidateFingerprint?: string;
  reply?: string;
  lifecycleError?: boolean;
  commandQueue: Promise<void>;
  abortRequested: boolean;
}

interface WindowCandidateRefresh {
  readonly requestId: string;
  readonly controller: AbortController;
  settled: boolean;
}

interface StartRequest {
  readonly goal: string;
  readonly targetFingerprint: string;
  readonly assistantPreferencesFingerprint: string;
  readonly runNoticeContentEnabled: boolean;
  readonly promise: Promise<RemoteRunSnapshot>;
}

interface WindowTargetSelection extends RemoteWindowTargetLabel {
  readonly pid: number;
  readonly windowId: number;
  readonly previewRequired?: boolean;
  readonly relationship?: RemoteWindowCandidateRelationship;
  readonly previewToken?: string;
  readonly previewExpiresAt?: number;
}

interface RemoteHandoffCandidate {
  readonly requestId: string;
  readonly candidate: ComputerWindowCandidate;
  readonly previewRequired: boolean;
  readonly previewToken?: string;
  readonly previewExpiresAt?: number;
}

interface PresentableWindowCandidate {
  readonly candidate: ComputerWindowCandidate;
  readonly previewRequired: boolean;
}

interface DeviceWindowCandidates {
  readonly expiresAt: number;
  readonly candidates: Map<string, WindowTargetSelection>;
}

type ResolvedStartTarget =
  | { readonly mode: "desktop"; readonly switchWindows: boolean }
  | { readonly mode: "window"; readonly selection: WindowTargetSelection; readonly switchWindows: boolean }
  | { readonly mode: "native-recovery"; readonly profile: HostNativeRecoveryProfile }
  | { readonly mode: "browser"; readonly sessionMode: RemoteBrowserSessionMode; readonly url: string; readonly switchWindows: boolean };

export interface ManagedBrowserProfileRunCoordinator {
  getDefaultSession(): RemoteBrowserSessionMode;
  acquireForRun(): Promise<() => Promise<void>>;
}

interface ManagedBrowserProfileUseLease {
  readonly release: () => Promise<void>;
  transferred: boolean;
}

const DEFAULT_MAX_RUNS = 50;
const DEFAULT_EVENT_CAPACITY = 256;
const DEFAULT_MAX_START_REQUESTS = 4096;
const DEFAULT_MAX_COMMANDS_PER_RUN = 1024;
const WINDOW_TARGET_TTL_MS = 10 * 60_000;
const WINDOW_DISCOVERY_TIMEOUT_MS = 15_000;
const WINDOW_PREVIEW_TIMEOUT_MS = 8_000;
const WINDOW_HANDOFF_REFRESH_TIMEOUT_MS = 15_000;
const WINDOW_PREVIEW_PROOF_TTL_MS = 2 * 60_000;
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
    public readonly code: "RUN_NOT_FOUND" | "RUN_BUSY" | "STALE_SEQUENCE" | "STALE_REQUEST" | "INVALID_COMMAND" | "INVALID_TARGET" | "INVALID_ASSISTANT_PREFERENCES" | "IDEMPOTENCY_CONFLICT" | "CAPACITY_REACHED" | "WINDOW_TARGET_STALE" | "WINDOW_DISCOVERY_FAILED" | "WINDOW_SELECTION_REQUIRED" | "WINDOW_ACTIVATION_FAILED" | "WINDOW_PREVIEW_REQUIRED" | "WINDOW_PREVIEW_UNAVAILABLE" | "WINDOW_PREVIEW_CAPTURE_FAILED" | "WINDOW_PREVIEW_IMAGE_TOO_LARGE" | "WINDOW_PREVIEW_BUSY" | "NATIVE_RECOVERY_PROFILE_CONSUMED" | "MANAGED_BROWSER_UNAVAILABLE" | "MANAGED_BROWSER_PROFILE_UNAVAILABLE" | "MANAGED_BROWSER_SETUP_REQUIRED",
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
  /** Presence means the Host configured a persistent profile wholly outside client input. */
  readonly managedBrowserProfile?: { readonly profileLabel: string; readonly profileRoot: string };
  readonly managedBrowserProfileCoordinator?: ManagedBrowserProfileRunCoordinator;
  readonly inspectManagedBrowserProfile?: typeof inspectManagedBrowserProfile;
  readonly readManagedBrowserStartupUrls?: typeof readManagedBrowserStartupUrls;
  /** When omitted or disabled, the public remote event stream is unchanged. */
  readonly runNotices?: { readonly enabled: boolean; readonly dynamicContentEnabled?: boolean };
  /** Optional explicit semantic selector for initial target matching; never used to perform GUI actions. */
  readonly windowSelector?: WindowSelectionStrategy;
  /** One optional Host-owned native recovery profile. Never supplied by a remote client. */
  readonly nativeRecoveryProfile?: HostNativeRecoveryProfile;
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
  private readonly managedBrowserProfile: ApplicationRemoteRunApiOptions["managedBrowserProfile"];
  private readonly managedBrowserProfileCoordinator: ApplicationRemoteRunApiOptions["managedBrowserProfileCoordinator"];
  private readonly inspectManagedBrowserProfile: typeof inspectManagedBrowserProfile;
  private readonly readManagedBrowserStartupUrls: typeof readManagedBrowserStartupUrls;
  private readonly runNotices: ApplicationRemoteRunApiOptions["runNotices"];
  private readonly windowSelector: ApplicationRemoteRunApiOptions["windowSelector"];
  private readonly nativeRecoveryProfile: ApplicationRemoteRunApiOptions["nativeRecoveryProfile"];
  private consumedNativeRecoveryProfile?: { readonly deviceId: string; readonly commandId: string };
  private startInProgress = false;
  private windowPreviewInProgress = false;

  public constructor(options: ApplicationRemoteRunApiOptions) {
    this.session = options.session;
    this.capabilities = { ...options.capabilities };
    this.assetReaderForRun = options.assetReaderForRun;
    this.maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS;
    this.maxStartRequests = options.maxStartRequests ?? DEFAULT_MAX_START_REQUESTS;
    this.maxCommandsPerRun = options.maxCommandsPerRun ?? DEFAULT_MAX_COMMANDS_PER_RUN;
    this.eventCapacity = options.eventCapacity ?? DEFAULT_EVENT_CAPACITY;
    this.now = options.now ?? Date.now;
    this.managedBrowserProfile = options.managedBrowserProfile;
    this.managedBrowserProfileCoordinator = options.managedBrowserProfileCoordinator;
    this.inspectManagedBrowserProfile = options.inspectManagedBrowserProfile ?? inspectManagedBrowserProfile;
    this.readManagedBrowserStartupUrls = options.readManagedBrowserStartupUrls ?? readManagedBrowserStartupUrls;
    this.runNotices = options.runNotices?.enabled === true ? options.runNotices : undefined;
    this.windowSelector = options.windowSelector;
    this.nativeRecoveryProfile = options.nativeRecoveryProfile === undefined ? undefined : Object.freeze({
      ...options.nativeRecoveryProfile,
      primaryTarget: Object.freeze({ ...options.nativeRecoveryProfile.primaryTarget }),
      recoveryTarget: Object.freeze({ ...options.nativeRecoveryProfile.recoveryTarget }),
    });
    if (this.nativeRecoveryProfile !== undefined) {
      const profile = this.nativeRecoveryProfile;
      if (!/^[A-Za-z0-9_-]{16,128}$/u.test(profile.profileId) ||
          !validNativeTarget(profile.primaryTarget) || !validNativeTarget(profile.recoveryTarget) ||
          profile.primaryTarget.pid !== profile.recoveryTarget.pid ||
          profile.primaryTarget.windowId === profile.recoveryTarget.windowId ||
          !isAbsolute(profile.outputPath) || profile.outputPath.includes("\0") || resolve(profile.outputPath) !== profile.outputPath ||
          !isCanonicalTextEditExecutableUrl(profile.expectedExecutableUrl)) {
        throw new Error("native recovery profile requires one opaque id, exact same-process windows and canonical Host file/executable paths");
      }
    }
    if (this.managedBrowserProfile !== undefined &&
        (!/^[A-Za-z0-9._-]{1,64}$/u.test(this.managedBrowserProfile.profileLabel) || this.managedBrowserProfile.profileRoot.trim().length === 0)) {
      throw new Error("managed browser readiness requires a bounded profile label and explicit Host-owned profile root");
    }
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
      throw windowDiscoveryError(error, "The Host could not safely refresh visible desktop windows. Try again after the desktop is ready.");
    }
    const boundedWindows = windows.slice(0, MAX_WINDOW_TARGETS).map((window) => {
      const appName = boundedText(window.appName, 256);
      const title = boundedText(window.title, 512);
      return { window, appName, title, relationship: remoteRelationshipFromTarget(window.relationship), labelKey: windowTargetLabelKey(appName, title) };
    });
    const labelCounts = new Map<string, number>();
    for (const candidate of boundedWindows) labelCounts.set(candidate.labelKey, (labelCounts.get(candidate.labelKey) ?? 0) + 1);
    const choices = new Map<string, WindowTargetSelection>();
    const candidates = boundedWindows.map(({ window, appName, title, relationship, labelKey }) => {
      const previewRequired = labelCounts.get(labelKey)! > 1 || appName === undefined || title === undefined;
      const token = randomBytes(24).toString("base64url");
      const choice: WindowTargetSelection = {
        pid: window.pid,
        windowId: window.windowId,
        ...(appName === undefined ? {} : { appName }),
        ...(title === undefined ? {} : { title }),
        previewRequired,
        ...(relationship === undefined ? {} : { relationship }),
      };
      choices.set(token, choice);
      return {
        token,
        ...(choice.appName === undefined ? {} : { appName: choice.appName }),
        ...(choice.title === undefined ? {} : { title: choice.title }),
        ...(choice.relationship === undefined ? {} : { relationship: choice.relationship }),
        ...(previewRequired ? { previewRequired: true } : {}),
      } satisfies RemoteWindowCandidate;
    });
    const expiresAt = this.now() + WINDOW_TARGET_TTL_MS;
    this.windowCandidates.set(deviceId, { expiresAt, candidates: choices });
    return {
      candidates,
      expiresAt: new Date(expiresAt).toISOString(),
      ...(this.nativeRecoveryProfile === undefined || this.consumedNativeRecoveryProfile !== undefined ? {} : {
        nativeRecoveryProfile: { profileId: this.nativeRecoveryProfile.profileId, label: "Host TextEdit recovery" },
      }),
    };
  }

  public async previewWindowTarget(deviceId: string, candidateToken: string, signal?: AbortSignal): Promise<RemoteWindowCandidatePreview> {
    this.beginWindowPreview();
    try {
    validateWindowTargetToken(candidateToken);
    const targetSet = this.windowCandidates.get(deviceId);
    if (targetSet === undefined || targetSet.expiresAt <= this.now()) {
      this.windowCandidates.delete(deviceId);
      throw new RemoteRunApiError("WINDOW_TARGET_STALE", "The window preview expired. Refresh the list and choose again.");
    }
    const candidate = targetSet.candidates.get(candidateToken);
    if (candidate === undefined) throw new RemoteRunApiError("WINDOW_TARGET_STALE", "The window preview candidate was refreshed. Refresh the list and choose again.");
    if (candidate.previewRequired !== true) throw new RemoteRunApiError("INVALID_TARGET", "This candidate does not require a preview; select it from the refreshed window list.");
    const captureSignal = boundedPreviewSignal(signal);
    const preview = await this.captureWindowPreview({ pid: candidate.pid, windowId: candidate.windowId }, candidate.appName, captureSignal);
    if (this.windowCandidates.get(deviceId) !== targetSet || targetSet.expiresAt <= this.now() ||
        targetSet.candidates.get(candidateToken) !== candidate) {
      throw new RemoteRunApiError("WINDOW_TARGET_STALE", "The window list changed while the preview was being captured. Refresh and preview the current candidate.");
    }
    const previewToken = randomBytes(24).toString("base64url");
    const previewExpiresAt = Math.min(targetSet.expiresAt, this.now() + WINDOW_PREVIEW_PROOF_TTL_MS);
    targetSet.candidates.set(candidateToken, { ...candidate, previewToken, previewExpiresAt });
    return projectWindowCandidatePreview(preview, previewToken, new Date(previewExpiresAt).toISOString(), remoteRelationshipFromTarget(preview.target.relationship));
    } finally {
      this.windowPreviewInProgress = false;
    }
  }

  public async previewWindowHandoffCandidate(
    deviceId: string,
    runId: string,
    requestId: string,
    candidateToken: string,
    signal?: AbortSignal,
  ): Promise<RemoteWindowCandidatePreview> {
    this.beginWindowPreview();
    try {
    validateWindowTargetToken(candidateToken);
    const record = this.runs.get(runId);
    if (record === undefined || record.ownerDeviceId !== deviceId) throw new RemoteRunApiError("RUN_NOT_FOUND", "Run not found.");
    const candidate = record.candidates.get(candidateToken);
    if (candidate === undefined || candidate.requestId !== requestId || record.pendingWindowRequestId !== requestId ||
        record.handle.controller.getSnapshot().status !== "waiting_window") {
      throw new RemoteRunApiError("STALE_REQUEST", "This window candidate is no longer part of the waiting request. Refresh the task.");
    }
    if (candidate.previewRequired !== true) throw new RemoteRunApiError("INVALID_TARGET", "This candidate does not require a preview; use the current window request.");
    const captureSignal = boundedPreviewSignal(signal);
    const before = await this.listCurrentHandoffCandidate(record, candidate, requestId, captureSignal);
    const preview = await this.captureWindowPreview({ pid: candidate.candidate.pid, windowId: candidate.candidate.windowId }, candidate.candidate.appName, captureSignal);
    const after = await this.listCurrentHandoffCandidate(record, candidate, requestId, captureSignal);
    if (!sameComputerCandidate(before, after)) {
      throw new RemoteRunApiError("WINDOW_TARGET_STALE", "The window changed during preview. Refresh the task and inspect the new candidate.");
    }
    const current = record.candidates.get(candidateToken);
    if (current !== candidate || record.pendingWindowRequestId !== requestId || record.handle.controller.getSnapshot().status !== "waiting_window") {
      throw new RemoteRunApiError("STALE_REQUEST", "The waiting window request changed during preview. Refresh the task.");
    }
    const previewToken = randomBytes(24).toString("base64url");
    const previewExpiresAt = this.now() + WINDOW_PREVIEW_PROOF_TTL_MS;
    record.candidates.set(candidateToken, { ...candidate, previewToken, previewExpiresAt });
    return projectWindowCandidatePreview(preview, previewToken, new Date(previewExpiresAt).toISOString(), projectWindowRelationship(record, after));
    } finally {
      this.windowPreviewInProgress = false;
    }
  }

  private beginWindowPreview(): void {
    if (this.windowPreviewInProgress) {
      throw new RemoteRunApiError("WINDOW_PREVIEW_BUSY", "Another candidate preview is still being read. Wait or cancel it before starting another preview.");
    }
    this.windowPreviewInProgress = true;
  }

  private async captureWindowPreview(
    target: { readonly pid: number; readonly windowId: number },
    expectedAppName: string | undefined,
    signal: AbortSignal,
  ): Promise<WindowTargetPreview> {
    let preview: WindowTargetPreview;
    try {
      preview = await this.session.captureWindowTargetPreview(target, signal);
    } catch {
      throw new RemoteRunApiError("WINDOW_PREVIEW_UNAVAILABLE", "This exact window could not be previewed safely. Restore it on the computer, refresh the list, and try again.");
    }
    if (preview.target.pid !== target.pid || preview.target.windowId !== target.windowId) {
      throw new RemoteRunApiError("WINDOW_TARGET_STALE", "The screenshot no longer belongs to the exact selected window. Refresh the list and inspect the current candidate.");
    }
    if (preview.mediaType !== "image/png" || preview.data.byteLength === 0) {
      throw new RemoteRunApiError("WINDOW_PREVIEW_CAPTURE_FAILED", "The exact window preview did not contain a usable image. Restore the window, refresh, and try again.");
    }
    const appName = boundedText(preview.target.appName, 256);
    const normalizedExpectedApp = expectedAppName?.normalize("NFKC").toLocaleLowerCase();
    const normalizedPreviewApp = appName?.normalize("NFKC").toLocaleLowerCase();
    if (normalizedExpectedApp !== undefined && normalizedPreviewApp !== undefined && normalizedExpectedApp !== normalizedPreviewApp) {
      throw new RemoteRunApiError("WINDOW_TARGET_STALE", "The application behind this window changed. Refresh the list and inspect the new candidate.");
    }
    try {
      const normalized = normalizeWindowPreviewPng(preview.data, preview.viewport, signal);
      if (normalized.data.byteLength > MAX_WINDOW_PREVIEW_BYTES) {
        throw new RemoteRunApiError("WINDOW_PREVIEW_IMAGE_TOO_LARGE", "The exact window preview exceeds the safe image transfer limit after bounded thumbnail reduction. Resize the window and refresh before trying again.");
      }
      return { ...preview, data: normalized.data, viewport: normalized.viewport };
    } catch (error) {
      if (error instanceof RemoteRunApiError) throw error;
      if (error instanceof WindowPreviewImageError) {
        if (error.code === "WINDOW_PREVIEW_IMAGE_TOO_LARGE") {
          throw new RemoteRunApiError(error.code, "The exact window preview exceeds the safe image transfer limit after bounded thumbnail reduction. Resize the window and refresh before trying again.");
        }
        throw new RemoteRunApiError(error.code, "The exact window preview is not a usable PNG. Refresh the window list and retry its preview.");
      }
      throw error;
    }
  }

  private async listCurrentHandoffCandidate(
    record: ManagedRemoteRun,
    issued: RemoteHandoffCandidate,
    requestId: string,
    signal: AbortSignal,
  ): Promise<ComputerWindowCandidate> {
    if (record.pendingWindowRequestId !== requestId || record.handle.controller.getSnapshot().status !== "waiting_window") {
      throw new RemoteRunApiError("STALE_REQUEST", "The window handoff request is no longer waiting.");
    }
    let candidates: readonly ComputerWindowCandidate[];
    try {
      candidates = await record.handle.controller.listWindowHandoffCandidates(signal);
    } catch {
      throw new RemoteRunApiError("WINDOW_PREVIEW_UNAVAILABLE", "The waiting window candidate could not be refreshed safely. Refresh the task and try again.");
    }
    if (record.pendingWindowRequestId !== requestId || record.handle.controller.getSnapshot().status !== "waiting_window") {
      throw new RemoteRunApiError("STALE_REQUEST", "The window handoff request changed while it was being refreshed.");
    }
    const current = candidates.find((candidate) => candidate.pid === issued.candidate.pid && candidate.windowId === issued.candidate.windowId);
    if (current === undefined || !sameComputerCandidate(issued.candidate, current)) {
      throw new RemoteRunApiError("WINDOW_TARGET_STALE", "The exact window is no longer a candidate for this handoff. Refresh the task and inspect the new candidates.");
    }
    return current;
  }

  public startRun(
    deviceId: string,
    commandId: string,
    goal: string,
    targetInput: RemoteRunTargetInput,
    assistantPreferencesInput?: RunAssistantPreferencesSnapshot,
    runNoticeContentEnabledInput = false,
  ): Promise<RemoteRunSnapshot> {
    const cleanGoal = validateText(goal, MAX_GOAL_CHARS, "goal");
    const cleanCommandId = validateIdentifier(commandId, "commandId");
    if (typeof runNoticeContentEnabledInput !== "boolean") {
      return Promise.reject(new RemoteRunApiError("INVALID_COMMAND", "runNoticeContentEnabled must be a boolean."));
    }
    let assistantPreferences: RunAssistantPreferencesSnapshot | undefined;
    try {
      assistantPreferences = assistantPreferencesInput === undefined
        ? undefined
        : normalizeRunAssistantPreferencesSnapshot(assistantPreferencesInput);
    } catch (error) {
      return Promise.reject(new RemoteRunApiError("INVALID_ASSISTANT_PREFERENCES", errorMessage(error)));
    }
    let target: RemoteRunTarget;
    let managedBrowserDefaultSession: RemoteBrowserSessionMode;
    try {
      target = normalizeRemoteRunTarget(targetInput);
      managedBrowserDefaultSession = target.mode === "native-recovery"
        ? "temporary"
        : this.managedBrowserProfileCoordinator?.getDefaultSession() ?? "temporary";
      if (target.mode === "browser" && target.sessionMode === undefined) {
        if (managedBrowserDefaultSession === "temporary" && target.url === "about:blank") {
          const { url: _explicitBlank, ...browserTarget } = target;
          target = { ...browserTarget, sessionMode: managedBrowserDefaultSession };
        } else {
          target = { ...target, sessionMode: managedBrowserDefaultSession };
        }
      }
      if (target.mode === "browser" && target.sessionMode === "saved" && this.managedBrowserProfile === undefined) {
        throw new RemoteRunApiError("MANAGED_BROWSER_UNAVAILABLE", "This Host has no configured persistent managed-browser profile.");
      }
      if (target.mode !== "native-recovery" && target.mode !== "browser" && target.switchWindows === true && managedBrowserDefaultSession === "saved" && this.managedBrowserProfile === undefined) {
        throw new RemoteRunApiError("MANAGED_BROWSER_UNAVAILABLE", "This Host has no configured persistent managed-browser profile.");
      }
      if (target.mode === "desktop" && target.switchWindows === true && !this.session.supportsWindowSwitching) {
        throw new RemoteRunApiError("INVALID_TARGET", "This Host cannot list windows for a desktop Run with cross-window switching.");
      }
    } catch (error) {
      return Promise.reject(error);
    }
    const key = deviceId + "\u0000" + cleanCommandId;
    const companionSessionMode = target.mode === "browser" || target.mode === "native-recovery" || target.switchWindows !== true
      ? undefined
      : managedBrowserDefaultSession;
    const targetFingerprint = stableJson({ target, ...(companionSessionMode === undefined ? {} : { companionSessionMode }) });
    const assistantPreferencesFingerprint = createHash("sha256")
      .update(stableJson(assistantPreferences ?? null), "utf8")
      .digest("hex");
    const existing = this.startRequests.get(key);
    if (existing !== undefined) {
      if (existing.goal !== cleanGoal || existing.targetFingerprint !== targetFingerprint || existing.assistantPreferencesFingerprint !== assistantPreferencesFingerprint) {
        return Promise.reject(new RemoteRunApiError("IDEMPOTENCY_CONFLICT", "commandId was already used with different Run details"));
      }
      if (existing.runNoticeContentEnabled !== runNoticeContentEnabledInput) {
        return Promise.reject(new RemoteRunApiError("IDEMPOTENCY_CONFLICT", "commandId was already used with different Run details"));
      }
      return existing.promise;
    }
    if (this.startRequests.size >= this.maxStartRequests) {
      return Promise.reject(new RemoteRunApiError("CAPACITY_REACHED", "The Host reached its safe start-request limit. Existing command IDs remain protected from replay; restart the Host to begin a new deduplication epoch."));
    }
    let selectedTarget: WindowTargetSelection | undefined;
    if (target.mode === "native-recovery") {
      if (this.nativeRecoveryProfile === undefined || target.profileId !== this.nativeRecoveryProfile.profileId) {
        return Promise.reject(new RemoteRunApiError("INVALID_TARGET", "This Host has no matching native recovery profile."));
      }
      const consumed = this.consumedNativeRecoveryProfile;
      if (consumed !== undefined) {
        return Promise.reject(new RemoteRunApiError("NATIVE_RECOVERY_PROFILE_CONSUMED", "The Host native recovery profile has already been used. Do not replay an unknown start outcome."));
      }
      // Reserve the one-run profile synchronously with the idempotency request,
      // before any fresh inventory or Run factory awaits.
      this.consumedNativeRecoveryProfile = { deviceId, commandId: cleanCommandId };
    }
    try {
      if (target.mode === "window") {
        validateWindowTargetToken(target.targetToken);
        selectedTarget = this.takeWindowTarget(deviceId, target.targetToken, target.previewToken);
      }
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
    this.startRequests.set(key, { goal: cleanGoal, targetFingerprint, assistantPreferencesFingerprint, runNoticeContentEnabled: runNoticeContentEnabledInput, promise });
    void this.resolveTargetAndCreateRun(deviceId, cleanGoal, target, selectedTarget, assistantPreferences, runNoticeContentEnabledInput, managedBrowserDefaultSession)
      .then(resolvePromise, rejectPromise);
    return promise;
  }

  private async resolveTargetAndCreateRun(
    deviceId: string,
    goal: string,
    target: RemoteRunTarget,
    selectedTarget: WindowTargetSelection | undefined,
    assistantPreferences: RunAssistantPreferencesSnapshot | undefined,
    runNoticeContentEnabled: boolean,
    managedBrowserDefaultSession: RemoteBrowserSessionMode,
  ): Promise<RemoteRunSnapshot> {
    if (this.startInProgress) {
      throw new RemoteRunApiError("RUN_BUSY", "The Host is already resolving a target for another Run. Wait for it to finish starting.");
    }
    this.startInProgress = true;
    let profileUseLease: ManagedBrowserProfileUseLease | undefined;
    const companionSessionMode = target.mode !== "browser" && target.mode !== "native-recovery" && target.switchWindows === true
      ? managedBrowserDefaultSession
      : undefined;
    try {
      // A public Runtime `finished` event can precede ApplicationSession's
      // close/report/lease-release completion. Establish the shared session
      // boundary before saved-profile inspection or any window discovery so
      // every target mode observes the same single-owner lifecycle.
      try {
        await this.session.waitUntilIdleAfterTerminal();
      } catch (error) {
        const message = errorMessage(error);
        if (/already has an active Run|terminal cleanup|unresolved desktop cleanup|pending_cleanup|environment .*locked/iu.test(message)) {
          throw new RemoteRunApiError("RUN_BUSY", "The Host already has a Run or unresolved desktop cleanup.");
        }
        throw error;
      }
      const usesSavedProfile = target.mode === "browser"
        ? target.sessionMode === "saved"
        : companionSessionMode === "saved";
      if (usesSavedProfile && this.managedBrowserProfileCoordinator !== undefined) {
        profileUseLease = { release: await this.acquireManagedBrowserProfileUse(), transferred: false };
      }
      if (target.mode === "browser") {
        const profile = this.managedBrowserProfile;
        if (target.sessionMode === "saved") {
          if (profile === undefined) throw new RemoteRunApiError("MANAGED_BROWSER_UNAVAILABLE", "This Host has no configured persistent managed-browser profile.");
          let readiness: Awaited<ReturnType<typeof inspectManagedBrowserProfile>>;
          try {
            readiness = await this.inspectManagedBrowserProfile(profile.profileRoot, profile.profileLabel);
          } catch {
            throw new RemoteRunApiError(
              "MANAGED_BROWSER_PROFILE_UNAVAILABLE",
              "受管浏览器配置无法通过安全检查。任务尚未启动。请在电脑停止使用该配置的浏览器和 Harness Host，再运行 scripts/mobile.ps1 recover-browser-profile。",
            );
          }
          if (readiness.state !== "ready") {
            throw new RemoteRunApiError(
              "MANAGED_BROWSER_PROFILE_UNAVAILABLE",
              "受管浏览器配置当前被占用，或上次异常退出留下了运行标记。任务尚未启动。请先停止使用该配置的浏览器和 Harness Host，再在电脑运行 `scripts/mobile.ps1 recover-browser-profile`；命令会先检查占用状态，只归档运行标记，不会删除登录数据。",
            );
          }
          let url = target.url;
          if (url === undefined) {
            try {
              url = (await this.readManagedBrowserStartupUrls(resolve(profile.profileRoot, profile.profileLabel)))[0] ?? "about:blank";
            } catch {
              throw new RemoteRunApiError("MANAGED_BROWSER_PROFILE_UNAVAILABLE", "电脑端已登录网站清单无法安全读取。任务尚未启动，请检查受管浏览器配置后重试。");
            }
          }
          return await this.createRun(deviceId, goal, { mode: "browser", sessionMode: "saved", url, switchWindows: target.switchWindows === true }, assistantPreferences, runNoticeContentEnabled, profileUseLease);
        }
        return await this.createRun(deviceId, goal, { mode: "browser", sessionMode: "temporary", url: target.url ?? "about:blank", switchWindows: target.switchWindows === true }, assistantPreferences, runNoticeContentEnabled);
      }
      if (target.mode === "window") {
        if (selectedTarget === undefined) throw new RemoteRunApiError("WINDOW_TARGET_STALE", "The window choice is invalid. Refresh the list and choose again.");
        return await this.createRun(deviceId, goal, { mode: "window", selection: selectedTarget, switchWindows: target.switchWindows === true }, assistantPreferences, runNoticeContentEnabled, profileUseLease, companionSessionMode);
      }
      if (target.mode === "native-recovery") {
        const profile = this.nativeRecoveryProfile;
        if (profile === undefined || profile.profileId !== target.profileId) {
          throw new RemoteRunApiError("INVALID_TARGET", "This Host has no matching native recovery profile.");
        }
        let currentWindows: readonly WindowTargetInfo[];
        try {
          currentWindows = await this.session.listWindowTargets(AbortSignal.timeout(WINDOW_DISCOVERY_TIMEOUT_MS));
        } catch (error) {
          throw windowDiscoveryError(error, "The Host could not verify the native recovery windows. Refresh the window list and try again.");
        }
        const primaryMatches = currentWindows.filter((window) => sameWindowIdentity(window, profile.primaryTarget)).length;
        const recoveryMatches = currentWindows.filter((window) => sameWindowIdentity(window, profile.recoveryTarget)).length;
        if (primaryMatches !== 1 || recoveryMatches !== 1) {
          throw new RemoteRunApiError("WINDOW_TARGET_STALE", "A configured native recovery window changed or closed. The profile was consumed; reconfigure it on the Host.");
        }
        return await this.createRun(deviceId, goal, {
          mode: "native-recovery",
          profile,
        }, assistantPreferences, runNoticeContentEnabled);
      }
      if (target.mode === "desktop") {
        return await this.createRun(deviceId, goal, { mode: "desktop", switchWindows: target.switchWindows === true }, assistantPreferences, runNoticeContentEnabled, profileUseLease, companionSessionMode);
      }

      let currentWindows: readonly WindowTargetInfo[];
      try {
        currentWindows = await this.session.listAllWindowTargets(AbortSignal.timeout(WINDOW_DISCOVERY_TIMEOUT_MS));
      } catch (error) {
        throw windowDiscoveryError(error, "The Host could not safely match the goal to open windows. Refresh the list and try again.");
      }
      const initialTargetCandidates = filterInitialTargetWindowCandidates(currentWindows);
      if (initialTargetCandidates.length > MAX_WINDOW_TARGETS) {
        throw new RemoteRunApiError("WINDOW_SELECTION_REQUIRED", "Too many open windows can be matched safely. Choose a window manually.");
      }
      const match = matchGoalToWindow(goal, initialTargetCandidates);
      let window = match.kind === "matched" ? match.match.target : undefined;
      if (window === undefined && this.windowSelector !== undefined) {
        const selectorCandidates = filterIndistinguishableWindowTargets(targetsForExplicitApplicationIntent(goal, initialTargetCandidates));
        // An explicit Latin app constraint with no matching application is a
        // hard abstention; semantic selection must not substitute another app.
        if (!hasExplicitApplicationIntent(goal) || selectorCandidates.length > 0) {
          try {
            const decision = await this.windowSelector.select(
              goal,
              selectorCandidates,
              AbortSignal.timeout(WINDOW_DISCOVERY_TIMEOUT_MS),
              "initial",
            );
            if (decision.kind === "matched") {
              // Strategies only return a suggestion. Accept it only if it is
              // the exact candidate object from this inventory.
              window = selectorCandidates.find((candidate) => candidate === decision.target);
            }
          } catch {
            // Selection failures are a safe manual fallback, never a reason to
            // guess another target or to prevent an explicit user selection.
          }
        }
      }
      if (window === undefined) {
        const reason = match.kind === "ambiguous" ? "More than one open window matches the goal." : "No open window confidently matches the goal.";
        throw new RemoteRunApiError("WINDOW_SELECTION_REQUIRED", `${reason} Choose a window manually.`);
      }
      const visible = await this.session.listWindowTargets(AbortSignal.timeout(WINDOW_DISCOVERY_TIMEOUT_MS));
      const visibleByHandle = visible.find((candidate) => candidate.pid === window.pid && candidate.windowId === window.windowId);
      if (visibleByHandle !== undefined && !sameWindowIdentity(visibleByHandle, window)) {
        throw new RemoteRunApiError("WINDOW_TARGET_STALE", "The matched window changed while it was being selected. Refresh and try again.");
      }
      if (visibleByHandle === undefined) {
        try {
          await this.session.activateWindowTarget(
            { pid: window.pid, windowId: window.windowId },
            AbortSignal.timeout(WINDOW_DISCOVERY_TIMEOUT_MS),
          );
        } catch (error) {
          throw new RemoteRunApiError("WINDOW_ACTIVATION_FAILED", "The matched window could not be restored. Choose a currently visible window manually.");
        }
      }
      const appName = boundedText(window.appName, 256);
      const title = boundedText(window.title, 512);
      return await this.createRun(deviceId, goal, {
        mode: "window",
        selection: {
          pid: window.pid,
          windowId: window.windowId,
          ...(appName === undefined ? {} : { appName }),
          ...(title === undefined ? {} : { title }),
        },
        switchWindows: target.switchWindows === true,
      }, assistantPreferences, runNoticeContentEnabled, profileUseLease, companionSessionMode);
    } finally {
      if (profileUseLease !== undefined && !profileUseLease.transferred) await profileUseLease.release();
      this.startInProgress = false;
    }
  }

  private async acquireManagedBrowserProfileUse(): Promise<() => Promise<void>> {
    try {
      return await this.managedBrowserProfileCoordinator!.acquireForRun();
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
      if (code === "PROFILE_NOT_READY") {
        throw new RemoteRunApiError("MANAGED_BROWSER_SETUP_REQUIRED", "The saved managed browser needs setup before this Run can start.");
      }
      if (code === "PROFILE_BUSY") {
        throw new RemoteRunApiError("RUN_BUSY", "The managed browser profile is already in use.");
      }
      throw new RemoteRunApiError("MANAGED_BROWSER_PROFILE_UNAVAILABLE", "The saved managed browser could not be safely prepared for this Run.");
    }
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
    let consumeWindowPreviewFor: string | undefined;
    if (command.type === "window.confirm") {
      const candidate = record.candidates.get(command.candidateToken);
      if (candidate === undefined || candidate.requestId !== command.requestId || currentRequest?.kind !== "window_handoff") {
        throw new RemoteRunApiError("STALE_REQUEST", "Window candidate expired; refresh the pending request.");
      }
      if (candidate.previewRequired && (candidate.previewToken === undefined || candidate.previewExpiresAt === undefined ||
          candidate.previewExpiresAt <= this.now() || command.previewToken !== candidate.previewToken)) {
        throw new RemoteRunApiError("WINDOW_PREVIEW_REQUIRED", "Preview this exact window and confirm it before continuing the task.");
      }
      if (candidate.previewRequired) consumeWindowPreviewFor = command.candidateToken;
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
    if (consumeWindowPreviewFor !== undefined) {
      const candidate = record.candidates.get(consumeWindowPreviewFor);
      if (candidate !== undefined) record.candidates.set(consumeWindowPreviewFor, {
        requestId: candidate.requestId,
        candidate: candidate.candidate,
        previewRequired: candidate.previewRequired,
      });
    }

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

  private takeWindowTarget(deviceId: string, token: string, previewToken?: string): WindowTargetSelection {
    const set = this.windowCandidates.get(deviceId);
    if (set === undefined || set.expiresAt <= this.now()) {
      this.windowCandidates.delete(deviceId);
      throw new RemoteRunApiError("WINDOW_TARGET_STALE", "The window choice expired. Refresh the list and choose again.");
    }
    const choice = set.candidates.get(token);
    if (choice === undefined) throw new RemoteRunApiError("WINDOW_TARGET_STALE", "The window choice was already used or refreshed. Refresh the list and choose again.");
    if (choice.previewRequired === true && (choice.previewToken === undefined || choice.previewExpiresAt === undefined ||
        choice.previewExpiresAt <= this.now() || previewToken !== choice.previewToken)) {
      throw new RemoteRunApiError("WINDOW_PREVIEW_REQUIRED", "Preview this exact window and confirm it before starting the task.");
    }
    if (choice.previewRequired !== true && previewToken !== undefined) {
      throw new RemoteRunApiError("INVALID_TARGET", "A preview confirmation is not valid for this window choice.");
    }
    set.candidates.delete(token);
    return choice;
  }

  private async createRun(
    deviceId: string,
    goal: string,
    target: ResolvedStartTarget,
    assistantPreferences?: RunAssistantPreferencesSnapshot,
    runNoticeContentEnabled = false,
    profileUseLease?: ManagedBrowserProfileUseLease,
    companionSessionMode?: RemoteBrowserSessionMode,
  ): Promise<RemoteRunSnapshot> {
    let targetLabel: RemoteWindowTargetLabel;
    let featureOverrides: ApplicationSessionRunFeatureOverrides;
    const windowSwitch = target.mode === "native-recovery" || target.switchWindows ? "opened-windows-v1" as const : "off" as const;
    if (target.mode === "desktop") {
      targetLabel = { appName: "Primary desktop", title: "Entire foreground desktop" };
      featureOverrides = { windowTarget: null, grounding: "off", windowSwitch };
    } else if (target.mode === "window") {
      const selection = target.selection;
      let currentWindows: readonly WindowTargetInfo[];
      try {
        currentWindows = await this.session.listWindowTargets(AbortSignal.timeout(WINDOW_DISCOVERY_TIMEOUT_MS));
      } catch (error) {
        throw windowDiscoveryError(error, "The Host could not verify the selected desktop window. Refresh the list and try again.");
      }
      const currentTarget = currentWindows.find((window) => sameWindowIdentity(window, selection));
      if (currentTarget === undefined) throw new RemoteRunApiError("WINDOW_TARGET_STALE", "The selected window changed or closed. Refresh the list and choose again.");
      const currentAppName = boundedText(currentTarget.appName, 256);
      const currentTitle = boundedText(currentTarget.title, 512);
      targetLabel = {
        ...(currentAppName === undefined ? {} : { appName: currentAppName }),
        ...(currentTitle === undefined ? {} : { title: currentTitle }),
      };
      featureOverrides = {
        windowTarget: { pid: selection.pid, windowId: selection.windowId },
        windowDeliveryMode: "foreground",
        windowSwitch,
      };
    } else if (target.mode === "native-recovery") {
      targetLabel = { appName: "TextEdit", title: "Host-configured recovery document", provenance: "starting_target" };
      featureOverrides = {
        windowTarget: { ...target.profile.primaryTarget },
        windowDeliveryMode: "foreground",
        windowSwitch: "opened-windows-v1",
        windowHandoff: "confirm-v1",
        grounding: "uia-catalog-v1",
        nativeRecovery: {
          primaryTarget: { ...target.profile.primaryTarget },
          recoveryTarget: { ...target.profile.recoveryTarget },
          outputPath: target.profile.outputPath,
          expectedExecutableUrl: target.profile.expectedExecutableUrl,
        },
      };
    } else {
      const url = new URL(target.url ?? "about:blank");
      targetLabel = { appName: "Harness-managed browser", title: url.host || "New tab" };
      if (target.sessionMode === "saved") {
        if (this.managedBrowserProfile === undefined) throw new RemoteRunApiError("MANAGED_BROWSER_UNAVAILABLE", "This Host has no configured persistent managed-browser profile.");
        featureOverrides = {
          windowTarget: null,
          grounding: "hybrid-catalog-v1",
          managedBrowserUrl: target.url,
          managedBrowserProfileMode: "persistent",
          managedBrowserProfileLabel: this.managedBrowserProfile.profileLabel,
          managedBrowserProfileRoot: this.managedBrowserProfile.profileRoot,
          windowSwitch,
        };
      } else {
        featureOverrides = {
          windowTarget: null,
          grounding: "hybrid-catalog-v1",
          managedBrowserUrl: target.url,
          managedBrowserProfileMode: "ephemeral",
          windowSwitch,
        };
      }
    }
    if (companionSessionMode !== undefined && target.mode !== "browser") {
      featureOverrides = {
        ...featureOverrides,
        managedBrowserCompanion: true,
        managedBrowserUrl: "about:blank",
        managedBrowserProfileMode: companionSessionMode === "saved" ? "persistent" : "ephemeral",
        ...(companionSessionMode === "saved" && this.managedBrowserProfile !== undefined
          ? {
            managedBrowserProfileLabel: this.managedBrowserProfile.profileLabel,
            managedBrowserProfileRoot: this.managedBrowserProfile.profileRoot,
          }
          : {}),
      };
    }
    if (windowSwitch === "opened-windows-v1") {
      featureOverrides = { ...featureOverrides, windowHandoff: "confirm-v1" };
    }
    targetLabel = { ...targetLabel, provenance: "starting_target" };
    let handle: RunHandle;
    try {
      handle = await this.session.startRun(goal, featureOverrides, undefined,
        assistantPreferences === undefined ? {} : { assistantPreferences });
    } catch (error) {
      const message = errorMessage(error);
      if (/owned by run|environment .*locked|pending_cleanup|already has an active Run/iu.test(message)) {
        throw new RemoteRunApiError("RUN_BUSY", "The Host already has a Run or unresolved desktop cleanup.");
      }
      throw error;
    }
    const runtime = handle.controller.getSnapshot();
    const noticeOptions = this.runNotices;
    const noticeState = noticeOptions === undefined ? undefined : (() => {
      const scheduler = new RunNoticeScheduler();
      return {
        noticeProjector: new RunNoticeProjector(handle.runId, {
          dynamicContentEnabled: (noticeOptions.dynamicContentEnabled ?? false) && runNoticeContentEnabled,
        }),
        noticeScheduler: scheduler,
        noticeGeneration: scheduler.activateRun(handle.runId),
      };
    })();
    const record: ManagedRemoteRun = {
      handle,
      ownerDeviceId: deviceId,
      target: targetLabel,
      ...(target.mode === "window" ? { targetIdentity: { pid: target.selection.pid, windowId: target.selection.windowId } } : {}),
      startedAt: this.now(),
      eventCapacity: this.eventCapacity,
      events: [],
      subscriptions: new Map(),
      assets: new Map(),
      candidates: new Map(),
      windowInventory: new Map(),
      switchWindowRefs: new Map(),
      ...(profileUseLease === undefined ? {} : { releaseManagedBrowserUse: profileUseLease.release }),
      commandReceipts: new Map(),
      maxCommandReceipts: this.maxCommandsPerRun,
      ...(noticeState ?? {}),
      nextSubscriptionId: 1,
      sequence: 0,
      rawSequence: -1,
      lastPublicStatus: mapStatus(runtime.status),
      commandQueue: Promise.resolve(),
      abortRequested: false,
    };
    this.runs.set(handle.runId, record);
    if (profileUseLease !== undefined) profileUseLease.transferred = true;
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
    try {
      await record.releaseManagedBrowserUse?.();
    } catch {
      record.lifecycleError = true;
    }
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
    if (event.type === "tool.call.received" && event.call.name === "list_windows") {
      record.pendingWindowInventoryCallId = event.call.id;
      record.windowInventory.clear();
    } else if (event.type === "tool.call.completed" && event.result.callId === record.pendingWindowInventoryCallId) {
      const inventory = decodeWindowInventory(event.result.output);
      record.windowInventory.clear();
      for (const option of inventory) record.windowInventory.set(option.windowRef, option.label);
      delete record.pendingWindowInventoryCallId;
      const currentOptions = inventory.filter((option) => option.isCurrent);
      if (currentOptions.length === 1) {
        record.target = { ...currentOptions[0]!.label, provenance: "selected_target" };
        this.publish(record, { type: "run.target", target: remoteWindowTargetJson(record.target) });
      }
    } else if (event.type === "tool.call.failed" && event.result.callId === record.pendingWindowInventoryCallId) {
      delete record.pendingWindowInventoryCallId;
      record.windowInventory.clear();
    } else if (event.type === "tool.call.rejected" && event.callId === record.pendingWindowInventoryCallId) {
      delete record.pendingWindowInventoryCallId;
      record.windowInventory.clear();
    }
    if (event.type === "action.execution.started" && event.action.kind === "switch_window") {
      record.switchWindowRefs.set(event.action.actionId, event.action.windowRef);
      // Once activation may begin, the previous target is no longer safe to
      // present as current until a successful transition identifies the new one.
      record.target = { provenance: "unknown_after_switch" };
      delete record.targetIdentity;
      this.publish(record, { type: "run.target", target: remoteWindowTargetJson(record.target) });
    } else if (event.type === "action.execution.completed" && event.receipt.status === "completed" && event.receipt.sessionAfter !== undefined) {
      const windowRef = record.switchWindowRefs.get(event.receipt.actionId);
      const label = windowRef === undefined ? undefined : record.windowInventory.get(windowRef);
      record.target = label === undefined
        ? { provenance: "unknown_after_switch" }
        : { ...label, provenance: "selected_target" };
      record.switchWindowRefs.delete(event.receipt.actionId);
      record.windowInventory.clear();
      this.publish(record, { type: "run.target", target: remoteWindowTargetJson(record.target) });
    } else if (event.type === "action.execution.failed") {
      const wasWindowSwitch = record.switchWindowRefs.has(event.receipt.actionId);
      record.switchWindowRefs.delete(event.receipt.actionId);
      if (wasWindowSwitch) this.markTargetUnknownAfterWindowSwitch(record);
    }
    if (event.type === "runtime.error" && event.category === "unknown_side_effect" && record.switchWindowRefs.size > 0) {
      this.markTargetUnknownAfterWindowSwitch(record);
    }
    if (event.type === "observation.created") record.assets.set(event.observation.screenshot.assetId, structuredClone(event.observation.screenshot));
    if (event.type === "user.input.requested") record.pendingInputRequestId = event.eventId;
    if (event.type === "user.input.received") delete record.pendingInputRequestId;
    if (event.type === "computer.window.handoff.requested") {
      this.cancelWindowCandidateRefresh(record);
      record.pendingWindowRequestId = event.sourceActionId;
      delete record.omittedWindowCandidateCount;
      delete record.candidateFingerprint;
      record.candidates.clear();
      const refresh: WindowCandidateRefresh = {
        requestId: event.sourceActionId,
        controller: new AbortController(),
        settled: false,
      };
      record.windowCandidateRefresh = refresh;
      void this.refreshWindowCandidates(record, refresh);
    }
    if (event.type === "computer.window.handoff.completed") {
      record.targetIdentity = { pid: event.target.pid, windowId: event.target.windowId };
      const selected = [...record.candidates.values()].find((entry) =>
        entry.candidate.pid === event.target.pid && entry.candidate.windowId === event.target.windowId);
      const appName = boundedText(selected?.candidate.appName, 256);
      const title = boundedText(selected?.candidate.title, 512);
      record.target = {
        ...(appName === undefined ? {} : { appName }),
        ...(title === undefined ? {} : { title }),
        provenance: "selected_target",
      };
      this.publish(record, { type: "run.target", target: remoteWindowTargetJson(record.target) });
    }
    if (event.type === "computer.window.handoff.completed" || event.type === "computer.window.handoff.ignored") {
      this.cancelWindowCandidateRefresh(record);
      delete record.pendingWindowRequestId;
      delete record.omittedWindowCandidateCount;
      delete record.candidateFingerprint;
      record.candidates.clear();
      record.windowInventory.clear();
      delete record.pendingWindowInventoryCallId;
    }
    if (event.type === "run.finished") {
      this.cancelWindowCandidateRefresh(record);
      if (record.switchWindowRefs.size > 0) this.markTargetUnknownAfterWindowSwitch(record);
      const reply = boundedText(event.summary ?? runtime.summary, MAX_REPLY_CHARS);
      if (reply === undefined) delete record.reply;
      else record.reply = reply;
      record.windowInventory.clear();
      record.switchWindowRefs.clear();
      record.candidates.clear();
      delete record.pendingWindowRequestId;
      delete record.candidateFingerprint;
      delete record.omittedWindowCandidateCount;
      delete record.pendingWindowInventoryCallId;
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
      const waitingForWindowCandidates = event.type === "computer.window.handoff.requested" &&
        record.windowCandidateRefresh?.requestId === event.sourceActionId && !record.windowCandidateRefresh.settled;
      this.publish(record, {
        type: "run.pending_request",
        ...(waitingForWindowCandidates || pending === undefined ? { cleared: true } : { request: publicRequest(pending) }),
      });
    }
    const projected = projectRuntimeEvent(event, record.reply);
    if (projected !== undefined) this.publish(record, projected);
    this.projectAndPublishNotice(record, event);
  }

  private markTargetUnknownAfterWindowSwitch(record: ManagedRemoteRun): void {
    record.target = { provenance: "unknown_after_switch" };
    record.windowInventory.clear();
    record.switchWindowRefs.clear();
    delete record.pendingWindowInventoryCallId;
    this.publish(record, { type: "run.target", target: remoteWindowTargetJson(record.target) });
  }

  private projectAndPublishNotice(record: ManagedRemoteRun, event: RuntimeEvent): void {
    const projector = record.noticeProjector;
    const scheduler = record.noticeScheduler;
    const generation = record.noticeGeneration;
    if (projector === undefined || scheduler === undefined || generation === undefined) return;

    const runtimeSnapshot = record.handle.controller.getSnapshot();
    const approvalVoiceContext = event.type === "approval.requested"
      ? projectApprovalVoiceContext(record.handle.controller.getEvents(), event.requestId, event.callId)
      : undefined;
    const currentApproval = event.type === "approval.requested"
      ? {
          requestId: event.requestId,
          ...(approvalVoiceContext === undefined ? {} : { voiceContext: approvalVoiceContext }),
        }
      : undefined;
    const notice = projector.project(event, {
      ...(currentApproval === undefined ? {} : { currentApproval }),
    });
    if (notice !== undefined) scheduler.offer(notice, generation);

    const snapshot = runtimeSnapshot;
    const currentPendingRequestIds = new Set<string>();
    if (snapshot.pendingApproval !== undefined) currentPendingRequestIds.add(snapshot.pendingApproval.requestId);
    if (snapshot.pendingUserQuestion !== undefined && record.pendingInputRequestId !== undefined) {
      currentPendingRequestIds.add(record.pendingInputRequestId);
    }
    if (snapshot.pendingWindowHandoff !== undefined && record.pendingWindowRequestId === snapshot.pendingWindowHandoff.sourceActionId) {
      currentPendingRequestIds.add(snapshot.pendingWindowHandoff.sourceActionId);
    }

    let next = scheduler.takeNext(currentPendingRequestIds);
    while (next !== undefined) {
      this.publish(record, {
        type: "run.notice",
        noticeId: next.noticeId,
        kind: next.kind,
        text: next.text,
        delivery: next.delivery,
        eventSequence: next.eventSequence,
        ...(next.pendingRequestId === undefined ? {} : { pendingRequestId: next.pendingRequestId }),
      });
      next = scheduler.takeNext(currentPendingRequestIds);
    }
  }

  private cancelWindowCandidateRefresh(record: ManagedRemoteRun): void {
    record.windowCandidateRefresh?.controller.abort();
    delete record.windowCandidateRefresh;
  }

  private isCurrentWindowCandidateRefresh(record: ManagedRemoteRun, refresh: WindowCandidateRefresh): boolean {
    const snapshot = record.handle.controller.getSnapshot();
    return record.windowCandidateRefresh === refresh && record.pendingWindowRequestId === refresh.requestId &&
      !refresh.controller.signal.aborted && snapshot.status === "waiting_window" &&
      snapshot.pendingWindowHandoff?.sourceActionId === refresh.requestId;
  }

  private async refreshWindowCandidates(record: ManagedRemoteRun, refresh: WindowCandidateRefresh): Promise<void> {
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(new Error("window candidate refresh deadline exceeded")), WINDOW_HANDOFF_REFRESH_TIMEOUT_MS);
    const signal = AbortSignal.any([refresh.controller.signal, timeoutController.signal]);
    try {
      const candidates = await awaitWithAbortSignal(
        record.handle.controller.listWindowHandoffCandidates(signal),
        signal,
      );
      if (!this.isCurrentWindowCandidateRefresh(record, refresh)) return;
      const snapshot = record.handle.controller.getSnapshot();
      const fingerprint = JSON.stringify(candidates.map(candidate =>
        [candidateKey(candidate), candidate.handoffToken ?? null]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
      if (fingerprint === record.candidateFingerprint) {
        refresh.settled = true;
        const pending = this.pendingRequest(record, snapshot);
        if (pending !== undefined) this.publish(record, { type: "run.pending_request", request: publicRequest(pending) });
        return;
      }
      record.candidateFingerprint = fingerprint;
      record.candidates.clear();
      const presentable = filterPresentableWindowCandidates(candidates);
      const limited = presentable.slice(0, 32);
      const omittedCandidateCount = candidates.length - limited.length;
      if (omittedCandidateCount > 0) record.omittedWindowCandidateCount = omittedCandidateCount;
      else delete record.omittedWindowCandidateCount;
      for (const { candidate, previewRequired } of limited) {
        const token = randomBytes(24).toString("base64url");
        record.candidates.set(token, { requestId: refresh.requestId, candidate: structuredClone(candidate), previewRequired });
      }
      refresh.settled = true;
      const pending = this.pendingRequest(record, snapshot);
      if (pending !== undefined) this.publish(record, { type: "run.pending_request", request: publicRequest(pending) });
    } catch {
      if (!this.isCurrentWindowCandidateRefresh(record, refresh)) return;
      record.candidates.clear();
      delete record.omittedWindowCandidateCount;
      record.candidateFingerprint = JSON.stringify([]);
      refresh.settled = true;
      const snapshot = record.handle.controller.getSnapshot();
      const pending = this.pendingRequest(record, snapshot);
      // Keep the existing window handoff contract visible so the UI can offer
      // only its already-authorized recovery/cancel actions. Never select a
      // candidate based on an unavailable refresh.
      if (pending !== undefined) this.publish(record, { type: "run.pending_request", request: publicRequest(pending) });
    } finally {
      clearTimeout(timeout);
    }
  }

  private pendingRequest(record: ManagedRemoteRun, snapshot: ReturnType<RunHandle["controller"]["getSnapshot"]>): RemotePendingRequest | undefined {
    if (snapshot.pendingApproval !== undefined) {
      const pending = snapshot.pendingApproval;
      const events = record.handle.controller.getEvents();
      const preview = projectApprovalPreview(events, pending.requestId, pending.callId);
      const selectedWindowLabel = projectApprovalWindowLabel(events, pending.callId, record.windowInventory);
      return {
        requestId: pending.requestId,
        kind: "approval",
        reason: boundedText(pending.reason, 2_000) ?? "Approval required.",
        requiresVisualReview: approvalRequiresVisualReview(events, pending.requestId, pending.callId),
        ...(preview === undefined ? {} : {
          preview: {
            ...preview,
            ...(selectedWindowLabel === undefined ? {} : { selectedWindowLabel }),
          },
        }),
      };
    }
    if (snapshot.pendingUserQuestion !== undefined && record.pendingInputRequestId !== undefined) {
      return { requestId: record.pendingInputRequestId, kind: "user_input", question: boundedText(snapshot.pendingUserQuestion, 2_000) ?? "Input required." };
    }
    if (snapshot.pendingWindowHandoff !== undefined && record.pendingWindowRequestId === snapshot.pendingWindowHandoff.sourceActionId) {
      if (record.windowCandidateRefresh?.requestId === snapshot.pendingWindowHandoff.sourceActionId &&
          !record.windowCandidateRefresh.settled) return undefined;
      const candidates = [...record.candidates.entries()]
        .filter(([, entry]) => entry.requestId === snapshot.pendingWindowHandoff!.sourceActionId)
        .map(([token, entry]) => {
          const appName = boundedText(entry.candidate.appName, 256);
          const title = boundedText(entry.candidate.title, 512);
          const relationship = projectWindowRelationship(record, entry.candidate);
          return {
            token,
            ...(appName === undefined ? {} : { appName }),
            ...(title === undefined ? {} : { title }),
            ...(relationship === undefined ? {} : { relationship }),
            ...(entry.previewRequired ? { previewRequired: true } : {}),
          };
        });
      return {
        requestId: snapshot.pendingWindowHandoff.sourceActionId,
        kind: "window_handoff",
        reasonCode: snapshot.pendingWindowHandoff.reasonCode,
        candidates,
        ...(record.omittedWindowCandidateCount === undefined ? {} : { omittedCandidateCount: record.omittedWindowCandidateCount }),
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
    case "model.request.started": {
      const providerId = safeProgressToken(event.providerId);
      return {
        type: "run.progress",
        phase: "model",
        status: "started",
        ...(providerId === undefined ? {} : { providerId }),
        ...(event.attempt === undefined ? {} : { attempt: event.attempt }),
        ...(event.contextBudget === undefined ? {} : {
          context: {
            estimatedInputTokens: event.contextBudget.estimatedInputTokens,
            selectedHistoryEvents: event.contextBudget.selectedHistoryEvents,
            omittedHistoryEvents: event.contextBudget.omittedHistoryEvents,
            ...(event.contextBudget.maxInputTokens === undefined ? {} : { maxInputTokens: event.contextBudget.maxInputTokens }),
            ...(event.contextBudget.maxWireInputTokens === undefined ? {} : { maxWireInputTokens: event.contextBudget.maxWireInputTokens }),
          },
        }),
      };
    }
    case "model.response.received":
      return {
        type: "run.progress",
        phase: "model",
        status: "completed",
        ...(event.attempt === undefined ? {} : { attempt: event.attempt }),
        ...(event.turn.usage === undefined ? {} : { usage: modelUsageJson(event.turn.usage) }),
      };
    case "model.request.failed": {
      const code = safeProgressToken(event.code);
      return {
        type: "run.progress",
        phase: "model",
        status: "failed",
        category: safeIssueCategory(event.category),
        ...(code === undefined ? {} : { code }),
        ...(event.retryable === undefined ? {} : { retryable: event.retryable }),
      };
    }
    case "action.proposed":
      return {
        type: "run.progress",
        phase: "action",
        status: "proposed",
        kind: event.action.kind,
      };
    case "action.execution.started":
      return { type: "run.progress", phase: "action", status: "started", kind: event.action.kind };
    case "action.execution.completed":
      return { type: "run.progress", phase: "action", status: "completed", actionStatus: event.receipt.status };
    case "action.execution.failed":
      return { type: "run.progress", phase: "action", status: "failed", actionStatus: event.receipt.status };
    case "monitor.proposal":
      return {
        type: "run.progress",
        phase: "monitor",
        status: event.proposal,
        mode: event.mode,
        reasonCodes: event.reasonCodes.slice(0, 8).map((reason) => safeProgressToken(reason)).filter((reason): reason is string => reason !== undefined),
      };
    case "monitor.transition":
      return {
        type: "run.progress",
        phase: "monitor",
        status: "transition",
        transition: event.transition,
      };
    case "computer.surface.transitioned":
      return {
        type: "run.surface_transition",
        reason: event.reason,
        fromKind: event.from?.kind ?? null,
        toKind: event.to.kind,
        generation: event.to.generation,
      };
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
        ...(request.preview.selectedWindowLabel === undefined ? {} : {
          selectedWindowLabel: {
            status: request.preview.selectedWindowLabel.status,
            source: request.preview.selectedWindowLabel.source,
            ...(request.preview.selectedWindowLabel.appName === undefined ? {} : { appName: request.preview.selectedWindowLabel.appName }),
            ...(request.preview.selectedWindowLabel.title === undefined ? {} : { title: request.preview.selectedWindowLabel.title }),
          },
        }),
        ...(request.preview.evidence === undefined ? {} : {
          evidence: {
            assetId: request.preview.evidence.assetId,
            observationId: request.preview.evidence.observationId,
            decisionObservationId: request.preview.evidence.decisionObservationId,
            capturedAt: request.preview.evidence.capturedAt,
            surfaceRef: {
              surfaceId: request.preview.evidence.surfaceRef.surfaceId,
              generation: request.preview.evidence.surfaceRef.generation,
              kind: request.preview.evidence.surfaceRef.kind,
            },
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
    ...(request.omittedCandidateCount === undefined ? {} : { omittedCandidateCount: request.omittedCandidateCount }),
    candidates: request.candidates.map((candidate) => ({
      token: candidate.token,
      ...(candidate.appName === undefined ? {} : { appName: candidate.appName }),
      ...(candidate.title === undefined ? {} : { title: candidate.title }),
      ...(candidate.relationship === undefined ? {} : {
        relationship: {
          kind: candidate.relationship.kind,
          ...(candidate.relationship.kind === "owned_child" && candidate.relationship.rootRole !== undefined ? { rootRole: candidate.relationship.rootRole } : {}),
          ...(candidate.relationship.kind === "owned_child" && candidate.relationship.parentAppName !== undefined ? { parentAppName: candidate.relationship.parentAppName } : {}),
          ...(candidate.relationship.kind === "owned_child" && candidate.relationship.parentTitle !== undefined ? { parentTitle: candidate.relationship.parentTitle } : {}),
        },
      }),
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

function safeProgressToken(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  return /^[A-Za-z0-9._:-]{1,64}$/u.test(normalized) ? normalized : undefined;
}

function modelUsageJson(usage: NonNullable<Extract<RuntimeEvent, { type: "model.response.received" }>["turn"]["usage"]>): JsonValue {
  return {
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
  };
}

function safeMediaType(value: string): string {
  if (!/^(?:image\/(?:png|jpeg|webp)|application\/pdf|text\/plain)$/iu.test(value)) return "application/octet-stream";
  return value.toLowerCase();
}

function normalizeRemoteRunTarget(value: RemoteRunTargetInput): RemoteRunTarget {
  if (typeof value === "string") return { mode: "window", targetToken: value, switchWindows: false };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RemoteRunApiError("INVALID_TARGET", "target must be an auto, desktop, window, browser, or Host native recovery profile selection.");
  }
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, "switchWindows") && typeof record.switchWindows !== "boolean") {
    throw new RemoteRunApiError("INVALID_TARGET", "switchWindows must be a boolean.");
  }
  const switchWindows = record.switchWindows === true;
  if (record.mode === "auto" && targetHasExactKeys(record, ["mode"])) return { mode: "auto", switchWindows };
  if (record.mode === "desktop" && targetHasExactKeys(record, ["mode"])) return { mode: "desktop", switchWindows };
  if (record.mode === "window" &&
      (targetHasExactKeys(record, ["mode", "targetToken"]) || targetHasExactKeys(record, ["mode", "targetToken", "previewToken"])) &&
      typeof record.targetToken === "string" && (record.previewToken === undefined || isValidWindowPreviewToken(record.previewToken))) {
    return {
      mode: "window",
      targetToken: record.targetToken,
      ...(record.previewToken === undefined ? {} : { previewToken: record.previewToken }),
      switchWindows,
    };
  }
  if (record.mode === "native-recovery" && !Object.hasOwn(record, "switchWindows") && targetHasExactKeys(record, ["mode", "profileId"]) &&
      typeof record.profileId === "string" && /^[A-Za-z0-9_-]{16,128}$/u.test(record.profileId)) {
    return { mode: "native-recovery", profileId: record.profileId };
  }
  if (record.mode === "browser" && targetHasExactKeys(record, ["mode"])) {
    return { mode: "browser", switchWindows };
  }
  if (record.mode === "browser" && targetHasExactKeys(record, ["mode", "url"]) &&
      (record.url === undefined || typeof record.url === "string")) {
    return browserTargetWithNormalizedUrl(undefined, record.url, switchWindows);
  }
  if (record.mode === "browser" && targetHasExactKeys(record, ["mode", "sessionMode"]) && isBrowserSessionMode(record.sessionMode)) {
    return { mode: "browser", sessionMode: record.sessionMode, switchWindows };
  }
  if (record.mode === "browser" && targetHasExactKeys(record, ["mode", "sessionMode", "url"]) && isBrowserSessionMode(record.sessionMode) &&
      (record.url === undefined || typeof record.url === "string")) {
    return browserTargetWithNormalizedUrl(record.sessionMode, record.url, switchWindows);
  }
  throw new RemoteRunApiError("INVALID_TARGET", "target must contain only the fields for one supported selection mode.");
}

function validNativeTarget(value: { readonly pid: number; readonly windowId: number }): boolean {
  return Number.isSafeInteger(value.pid) && value.pid > 0 && Number.isSafeInteger(value.windowId) && value.windowId > 0;
}

function isCanonicalTextEditExecutableUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "file:" && url.hostname === "" && url.search === "" && url.hash === "" &&
      url.href === value && url.pathname.endsWith("/TextEdit.app/Contents/MacOS/TextEdit");
  } catch {
    return false;
  }
}

function boundedPreviewSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(WINDOW_PREVIEW_TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

function awaitWithAbortSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("operation aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  });
}

function isBrowserSessionMode(value: unknown): value is RemoteBrowserSessionMode {
  return value === "temporary" || value === "saved";
}

function browserTargetWithNormalizedUrl(sessionMode: RemoteBrowserSessionMode | undefined, rawUrl: unknown, switchWindows: boolean): RemoteRunTarget {
  if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) {
    return { mode: "browser", ...(sessionMode === undefined ? {} : { sessionMode }), switchWindows };
  }
  const url = normalizeManagedBrowserUrl(rawUrl);
  if (sessionMode === "temporary" && url === "about:blank") return { mode: "browser", sessionMode, switchWindows };
  return { mode: "browser", ...(sessionMode === undefined ? {} : { sessionMode }), url, switchWindows };
}

function normalizeManagedBrowserUrl(value: string): string {
  if (value.length > 2_048) {
    throw new RemoteRunApiError("INVALID_TARGET", "Managed browser URL must contain no more than 2048 characters.");
  }
  if (value.trim().length === 0) return "about:blank";
  if (value === "about:blank") return value;
  if (value !== value.trim()) throw new RemoteRunApiError("INVALID_TARGET", "Managed browser URL must not have surrounding whitespace.");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new RemoteRunApiError("INVALID_TARGET", "Managed browser URL must be a complete http(s) URL or exact about:blank.");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.hostname.length === 0 || parsed.username.length > 0 || parsed.password.length > 0) {
    throw new RemoteRunApiError("INVALID_TARGET", "Managed browser URL must be http(s), include a host, and contain no embedded credentials.");
  }
  return parsed.toString();
}

function targetHasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record).filter((key) => key !== "switchWindows");
  return keys.length === expected.length && keys.every((key) => expected.includes(key)) &&
    Object.keys(record).every((key) => key === "switchWindows" || expected.includes(key));
}

function decodeWindowInventory(value: JsonValue): Array<{ windowRef: string; label: RemoteWindowTargetLabel; isCurrent: boolean }> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !Array.isArray(value.windows)) return [];
  const options: Array<{ windowRef: string; label: RemoteWindowTargetLabel; isCurrent: boolean }> = [];
  for (const item of value.windows) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const option = item as Record<string, JsonValue>;
    if (typeof option.windowRef !== "string" || option.windowRef.length === 0 || typeof option.isCurrent !== "boolean") continue;
    const appName = typeof option.appName === "string" ? boundedText(option.appName, 256) : undefined;
    const title = typeof option.title === "string" ? boundedText(option.title, 512) : undefined;
    options.push({
      windowRef: option.windowRef,
      label: {
        ...(appName === undefined ? {} : { appName }),
        ...(title === undefined ? {} : { title }),
      },
      isCurrent: option.isCurrent,
    });
  }
  return options;
}

function remoteWindowTargetJson(target: RemoteWindowTargetLabel): JsonValue {
  return {
    ...(target.appName === undefined ? {} : { appName: target.appName }),
    ...(target.title === undefined ? {} : { title: target.title }),
    ...(target.provenance === undefined ? {} : { provenance: target.provenance }),
  };
}

function projectApprovalWindowLabel(
  events: readonly RuntimeEvent[],
  callId: string,
  inventory: ReadonlyMap<string, RemoteWindowTargetLabel>,
): NonNullable<RemoteApprovalPreview["selectedWindowLabel"]> | undefined {
  const callEvent = events.find((event) => event.type === "tool.call.received" && event.call.id === callId);
  if (callEvent?.type !== "tool.call.received" || callEvent.call.name !== "switch_window") return undefined;
  const args = callEvent.call.arguments;
  if (typeof args !== "object" || args === null || Array.isArray(args) || typeof args.windowRef !== "string") {
    return { status: "unavailable", source: "unavailable" };
  }
  const label = inventory.get(args.windowRef);
  if (label === undefined) return { status: "unavailable", source: "unavailable" };
  const appName = boundedText(label.appName, 256);
  const title = boundedText(label.title, 512);
  return {
    status: "matched",
    source: "latest_list_windows_inventory",
    ...(appName === undefined ? {} : { appName }),
    ...(title === undefined ? {} : { title }),
  };
}

function windowDiscoveryError(error: unknown, message: string): RemoteRunApiError {
  if (/active Run|no Run is active/iu.test(errorMessage(error))) {
    return new RemoteRunApiError("RUN_BUSY", "The Host already has a Run or unresolved desktop cleanup.");
  }
  return new RemoteRunApiError("WINDOW_DISCOVERY_FAILED", message);
}

function sameWindowIdentity(
  left: { readonly pid: number; readonly windowId: number; readonly appName?: string },
  right: { readonly pid: number; readonly windowId: number; readonly appName?: string },
): boolean {
  const leftAppName = boundedText(left.appName, 256)?.normalize("NFKC").toLocaleLowerCase();
  const rightAppName = boundedText(right.appName, 256)?.normalize("NFKC").toLocaleLowerCase();
  return left.pid === right.pid && left.windowId === right.windowId &&
    (leftAppName === undefined || rightAppName === undefined || leftAppName === rightAppName);
}

function windowTargetLabelKey(appName: string | undefined, title: string | undefined): string {
  const normalize = (value: string | undefined) => value?.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim() ?? "";
  return `${normalize(appName)}\u0000${normalize(title)}`;
}

function candidateKey(candidate: ComputerWindowCandidate): string {
  const relationship = candidate.relationship === undefined
    ? ""
    : candidate.relationship.kind === "owned_child"
      ? `:owned:${candidate.relationship.owner.pid}:${candidate.relationship.owner.windowId}:${candidate.relationship.rootRole ?? ""}`
      : ":scoped-peer";
  return String(candidate.pid) + ":" + String(candidate.windowId) + ":" + (candidate.appName ?? "") + ":" + (candidate.title ?? "") + relationship;
}

function filterPresentableWindowCandidates(candidates: readonly ComputerWindowCandidate[]): PresentableWindowCandidate[] {
  const bounded = candidates.map((candidate) => ({
    candidate,
    appName: boundedText(candidate.appName, 256),
    title: boundedText(candidate.title, 512),
  }));
  const labelCounts = new Map<string, number>();
  for (const entry of bounded) {
    const key = windowTargetLabelKey(entry.appName, entry.title);
    labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
  }
  return bounded.map(({ candidate, appName, title }) => ({
    candidate,
    // Duplicate labels and incomplete labels remain manual-only, but they
    // require a candidate-bound screenshot before the phone can use them.
    previewRequired: labelCounts.get(windowTargetLabelKey(appName, title))! > 1 || appName === undefined || title === undefined,
  }));
}

function projectWindowRelationship(
  record: ManagedRemoteRun,
  candidate: ComputerWindowCandidate,
): RemoteWindowCandidateRelationship | undefined {
  const relationship = candidate.relationship;
  if (relationship === undefined) return undefined;
  if (relationship.kind === "scoped_peer") return { kind: "scoped_peer" };
  return {
    kind: "owned_child",
    ...(relationship.rootRole === undefined ? {} : { rootRole: relationship.rootRole }),
    ...(!matchesTarget(relationship.owner, record.targetIdentity) || record.target.appName === undefined ? {} : { parentAppName: record.target.appName }),
    ...(!matchesTarget(relationship.owner, record.targetIdentity) || record.target.title === undefined ? {} : { parentTitle: record.target.title }),
  };
}

function remoteRelationshipFromTarget(relationship: WindowTargetInfo["relationship"]): RemoteWindowCandidateRelationship | undefined {
  if (relationship === undefined) return undefined;
  if (relationship.kind === "scoped_peer") return { kind: "scoped_peer" };
  return { kind: "owned_child", ...(relationship.rootRole === undefined ? {} : { rootRole: relationship.rootRole }) };
}

function projectWindowCandidatePreview(
  preview: WindowTargetPreview,
  previewToken: string,
  expiresAt: string,
  relationship: RemoteWindowCandidateRelationship | undefined,
): RemoteWindowCandidatePreview {
  const appName = boundedText(preview.target.appName, 256);
  const title = boundedText(preview.target.title, 512);
  return {
    previewToken,
    expiresAt,
    ...(appName === undefined ? {} : { appName }),
    ...(title === undefined ? {} : { title }),
    ...(relationship === undefined ? {} : { relationship }),
    capturedAt: preview.capturedAt,
    viewport: { width: preview.viewport.width, height: preview.viewport.height },
    mediaType: "image/png",
    dataBase64: Buffer.from(preview.data).toString("base64"),
  };
}

function sameComputerCandidate(left: ComputerWindowCandidate, right: ComputerWindowCandidate): boolean {
  const leftAppName = boundedText(left.appName, 256)?.normalize("NFKC").toLocaleLowerCase();
  const rightAppName = boundedText(right.appName, 256)?.normalize("NFKC").toLocaleLowerCase();
  return left.pid === right.pid && left.windowId === right.windowId &&
    (leftAppName === undefined || rightAppName === undefined || leftAppName === rightAppName);
}

function matchesTarget(
  owner: { readonly pid: number; readonly windowId: number },
  target: { readonly pid: number; readonly windowId: number } | undefined,
): boolean {
  return target !== undefined && owner.pid === target.pid && owner.windowId === target.windowId;
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

function isValidWindowPreviewToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32}$/u.test(value);
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
