import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { normalizeRunAssistantPreferencesSnapshot, type RunAssistantPreferencesSnapshot, type RunId, type RunOutcome } from "@computer-harness/protocol";
import type { RunReport } from "./reporting.js";
import { createRun } from "./run-factory.js";
import {
  defaultEnvironmentOwner,
  environmentIdentityForConfig,
  type EnvironmentLease,
  type EnvironmentLeaseInfo,
  type EnvironmentOwner,
} from "./environment-owner.js";
import type { ResolvedRunConfig, RunDependencies, RunHandle } from "./config.js";

export type ApplicationSessionConfig = Omit<ResolvedRunConfig, "goal" | "runId" | "assistantPreferences">;

export interface WindowTargetInfo {
  readonly pid: number;
  readonly windowId: number;
  readonly appName?: string;
  readonly title?: string;
}

export interface WindowTargetDiscovery {
  listWindows(signal: AbortSignal): Promise<readonly WindowTargetInfo[]>;
  /** Includes minimized/off-screen top-level windows when the backend can
   * enumerate them. It remains read-only. */
  listAllWindows?(signal: AbortSignal): Promise<readonly WindowTargetInfo[]>;
  /** Restore/focus one exact identity selected from a fresh inventory. */
  activateWindow?(target: ApplicationSessionWindowTarget, signal: AbortSignal): Promise<void>;
}

export type ApplicationSessionWindowTarget = { pid: number; windowId: number };

/** Feature-only overrides selected by an interactive UI for the next Run. */
export type ApplicationSessionRunFeatureOverrides = Partial<Pick<
  ApplicationSessionConfig,
  "planning" | "memory" | "memoryRetrieval" | "batching" | "contextMode" | "contextMaxHistoryEvents" | "contextMaxInputTokens" | "riskGuard" | "monitor" | "grounding" | "windowHandoff"
>> & {
  windowTarget?: ApplicationSessionWindowTarget | null;
  windowDeliveryMode?: "background" | "foreground" | null;
  managedBrowserUrl?: string;
  managedBrowserProfileMode?: "ephemeral" | "persistent";
  managedBrowserProfileLabel?: string;
  /** Host-private and never projected to Provider or Run reports. */
  managedBrowserProfileRoot?: string;
};

/** Per-Run non-feature input kept separate from computer and Guard overrides. */
export interface ApplicationSessionRunOptions {
  readonly assistantPreferences?: RunAssistantPreferencesSnapshot;
}

export type ApplicationSessionStatus = "idle" | "running" | "blocked" | "closed";

export interface SessionRunRecord {
  readonly runId: RunId;
  readonly goal: string;
  readonly outputDir: string;
  readonly outcome?: RunOutcome;
  readonly error?: string;
  readonly ownerState?: "released" | "pending_cleanup";
}

export interface ApplicationSessionOptions {
  readonly config: ApplicationSessionConfig;
  readonly dependencies?: RunDependencies;
  readonly createRun?: typeof createRun;
  readonly owner?: EnvironmentOwner;
  readonly windowDiscovery?: WindowTargetDiscovery;
}

export function createApplicationSession(options: ApplicationSessionOptions): ApplicationSession {
  return new ApplicationSession(options);
}

/**
 * Owns one active Run at a time. A finished Run is never reopened: a later
 * goal gets fresh stores, a fresh Computer, and a fresh approval lifecycle.
 */
export class ApplicationSession {
  private readonly config: ApplicationSessionConfig;
  private readonly dependencies: RunDependencies;
  private readonly createRunFactory: typeof createRun;
  private readonly owner: EnvironmentOwner;
  private readonly environmentIdentity: string;
  private readonly windowDiscovery: WindowTargetDiscovery | undefined;
  private readonly records: SessionRunRecord[] = [];
  private active: { handle: RunHandle; lease: EnvironmentLease; completion: Promise<void>; record: SessionRunRecord } | undefined;
  private closed = false;
  private lastCompletion: Promise<void> | undefined;

  public constructor(options: ApplicationSessionOptions) {
    this.config = options.config;
    this.dependencies = options.dependencies ?? {};
    this.createRunFactory = options.createRun ?? createRun;
    this.owner = options.owner ?? defaultEnvironmentOwner;
    this.windowDiscovery = options.windowDiscovery;
    this.environmentIdentity = environmentIdentityForConfig(this.config.computer);
  }

  public get status(): ApplicationSessionStatus {
    if (this.closed) return "closed";
    if (this.active !== undefined) return "running";
    if (this.owner.inspect(this.environmentIdentity) !== undefined) return "blocked";
    return "idle";
  }

  public get activeRun(): RunHandle | undefined {
    return this.active?.handle;
  }

  public get lastRun(): SessionRunRecord | undefined {
    const record = this.records[this.records.length - 1];
    return record === undefined ? undefined : { ...record };
  }

  public get history(): readonly SessionRunRecord[] {
    return this.records.map((record) => ({ ...record }));
  }

  public get environmentId(): string {
    return this.environmentIdentity;
  }

  public inspectEnvironment(): EnvironmentLeaseInfo | undefined {
    return this.owner.inspect(this.environmentIdentity);
  }

  public async listWindowTargets(signal: AbortSignal): Promise<readonly WindowTargetInfo[]> {
    if (this.windowDiscovery === undefined) throw new Error("window discovery is unavailable for this ApplicationSession");
    if (this.closed) throw new Error("application session is closed");
    if (this.active !== undefined) throw new Error("window discovery is available only while no Run is active");
    return this.windowDiscovery.listWindows(signal);
  }

  public async listAllWindowTargets(signal: AbortSignal): Promise<readonly WindowTargetInfo[]> {
    if (this.windowDiscovery === undefined) throw new Error("window discovery is unavailable for this ApplicationSession");
    if (this.closed) throw new Error("ApplicationSession is closed");
    if (this.active !== undefined) throw new Error("window discovery is unavailable while an active Run owns the environment");
    return await (this.windowDiscovery.listAllWindows?.(signal) ?? this.windowDiscovery.listWindows(signal));
  }

  public async activateWindowTarget(target: ApplicationSessionWindowTarget, signal: AbortSignal): Promise<void> {
    if (this.windowDiscovery?.activateWindow === undefined) throw new Error("window activation is unavailable for this ApplicationSession");
    if (this.closed) throw new Error("ApplicationSession is closed");
    if (this.active !== undefined) throw new Error("window activation is unavailable while an active Run owns the environment");
    await this.windowDiscovery.activateWindow(target, signal);
  }

  public async startRun(
    goal: string,
    featureOverrides: ApplicationSessionRunFeatureOverrides = {},
    starter?: Parameters<RunHandle["start"]>[0],
    runOptions: ApplicationSessionRunOptions = {},
  ): Promise<RunHandle> {
    if (this.closed) throw new Error("application session is closed");
    if (goal.trim().length === 0) throw new Error("application session requires a non-empty goal");
    const assistantPreferences = runOptions.assistantPreferences === undefined
      ? undefined
      : normalizeRunAssistantPreferencesSnapshot(runOptions.assistantPreferences);
    await this.waitUntilIdleAfterTerminal();
    // waitUntilIdleAfterTerminal() is async even when the session was already
    // idle. The caller may close the session during that yield; do not acquire
    // a lease or invoke the Run factory after that close.
    if (this.closed) throw new Error("application session is closed");
    const runId = `run-${Date.now()}-${randomUUID().slice(0, 12)}` as RunId;
    const {
      windowTarget,
      windowDeliveryMode,
      managedBrowserUrl,
      managedBrowserProfileMode,
      managedBrowserProfileLabel,
      managedBrowserProfileRoot,
      ...featureConfig
    } = featureOverrides;
    const config: ResolvedRunConfig = {
      ...this.config,
      ...featureConfig,
      goal,
      runId,
      outputDir: resolve(this.config.outputDir, runId),
      ...(assistantPreferences === undefined
        ? {}
        : { assistantPreferences }),
    };
    if (config.computer.kind === "cua" && (windowTarget !== undefined || windowDeliveryMode !== undefined)) {
      if (windowTarget === null || windowDeliveryMode === null) {
        const { windowTarget: _windowTarget, ...desktopComputer } = config.computer;
        const { windowDeliveryMode: _windowDeliveryMode, ...desktopConfig } = desktopComputer;
        config.computer = desktopConfig;
      } else {
        config.computer = {
          ...config.computer,
          ...(windowTarget === undefined ? {} : { windowTarget }),
          ...(windowDeliveryMode === undefined ? {} : { windowDeliveryMode }),
        };
      }
    }
    if (managedBrowserUrl !== undefined) {
      if (config.computer.kind !== "cua") throw new Error("managed browser URL requires the CUA computer");
      config.computer = { ...config.computer, managedBrowserUrl };
    }
    if (managedBrowserProfileMode !== undefined || managedBrowserProfileLabel !== undefined || managedBrowserProfileRoot !== undefined) {
      if (config.computer.kind !== "cua") throw new Error("managed browser profile requires the CUA computer");
      config.computer = {
        ...config.computer,
        ...(managedBrowserProfileMode === undefined ? {} : { managedBrowserProfileMode }),
        ...(managedBrowserProfileLabel === undefined ? {} : { managedBrowserProfileLabel }),
        ...(managedBrowserProfileRoot === undefined ? {} : { managedBrowserProfileRoot }),
      };
    }
    const lease = this.owner.acquire(this.environmentIdentity, runId);
    let handle: RunHandle;
    try {
      handle = await this.createRunFactory(config, this.dependencies);
    } catch (error) {
      lease.release();
      throw error;
    }
    if (this.closed) {
      lease.release();
      await handle.close().catch(() => undefined);
      throw new Error("application session was closed while creating a Run");
    }
    const record: SessionRunRecord = { runId, goal, outputDir: config.outputDir };
    let completion: Promise<void>;
    try {
      const outcome = handle.start(starter);
      completion = this.finishRun(handle, lease, record, outcome);
    } catch (error) {
      lease.release();
      await handle.close().catch(() => undefined);
      throw error;
    }
    this.records.push(record);
    this.active = { handle, lease, completion, record };
    this.lastCompletion = completion;
    void completion.catch(() => undefined);
    return handle;
  }

  /**
   * Establish the start boundary for callers that need to do work before
   * constructing a new Run (for example target discovery). A Runtime
   * terminal snapshot may be public before Handle.close/report and lease
   * release finish, so terminal cleanup is awaited here. A non-terminal Run
   * and an unresolved owner lease fail closed immediately.
   */
  public async waitUntilIdleAfterTerminal(): Promise<void> {
    if (this.closed) throw new Error("application session is closed");
    const activeBeforeWait = this.active;
    if (activeBeforeWait !== undefined) {
      if (activeBeforeWait.handle.controller.getSnapshot().status !== "finished") {
        throw new Error("application session already has an active Run");
      }
      await activeBeforeWait.completion;
      // The session may have been closed while cleanup was pending. Do not
      // allow a caller that was waiting on cleanup to create resources after
      // close(), and re-check the owner barrier after the terminal promise.
      if (this.closed) throw new Error("application session is closed");
      if (this.active !== undefined) throw new Error("application session terminal cleanup is still pending");
    }
    const owner = this.owner.inspect(this.environmentIdentity);
    if (owner !== undefined) {
      throw new Error(`application session has unresolved desktop cleanup (pending_cleanup; environment is owned by run ${owner.runId})`);
    }
  }

  public async waitForActiveRun(): Promise<RunOutcome | undefined> {
    const completion = this.active?.completion ?? this.lastCompletion;
    if (completion === undefined) return this.lastRun?.outcome;
    await completion;
    return this.lastRun?.outcome;
  }

  public submitUserInput(text: string): Promise<void> {
    return this.requireActive().controller.submitUserInput(text);
  }

  public resolveApproval(approved: boolean): Promise<void> {
    const controller = this.requireActive().controller;
    const pending = controller.getSnapshot().pendingApproval;
    if (pending === undefined) return Promise.reject(new Error("no approval is waiting for resolution"));
    return controller.resolveApproval(pending.requestId, approved);
  }

  public pause(reason = "paused from application session"): Promise<void> {
    return this.requireActive().controller.pause(reason);
  }

  public resume(): Promise<void> {
    return this.requireActive().controller.resume();
  }

  public abort(reason = "aborted from application session"): void {
    this.requireActive().controller.cancel(reason);
  }

  /** Retain the process-local owner when the caller stops waiting for cleanup. */
  public markEnvironmentPending(reason = "cleanup was not confirmed"): void {
    this.active?.lease.markPending(reason);
  }

  public async close(): Promise<void> {
    this.closed = true;
    if (this.active !== undefined) await this.active.completion;
  }

  private requireActive(): RunHandle {
    if (this.active === undefined) throw new Error("application session has no active Run");
    return this.active.handle;
  }

  private async finishRun(
    handle: RunHandle,
    lease: EnvironmentLease,
    record: SessionRunRecord,
    outcomePromise: Promise<RunOutcome>,
  ): Promise<void> {
    try {
      const outcome = await outcomePromise;
      let report: RunReport | undefined;
      try {
        await handle.close();
        report = await handle.report();
      } catch (error) {
        lease.markPending(`Run cleanup/report was not confirmed: ${errorMessage(error)}`);
      }
      const cleanupDiagnostics = report === undefined ? [] : cleanupDiagnosticsFromReport(report);
      const safeToRelease = outcome !== "outcome_unknown" && cleanupDiagnostics.length === 0 && report !== undefined;
      if (safeToRelease && lease.state === "active") {
        lease.release();
        replaceRecord(this.records, record, { outcome, ownerState: "released" });
      } else {
        if (lease.state !== "pending_cleanup") {
          lease.markPending(outcome === "outcome_unknown" ? "Run has an unresolved/unknown external side effect" : "Run cleanup is not fully confirmed");
        }
        replaceRecord(this.records, record, { outcome, ownerState: "pending_cleanup" });
      }
    } catch (error) {
      // A rejected lifecycle promise does not prove whether a Computer
      // action was already dispatched. Keep the conservative owner barrier
      // until an explicit recovery/ownership feature can establish that
      // fact; releasing here could hand a late action to a new Run.
      await handle.close().catch(() => undefined);
      lease.markPending(`Run lifecycle failed before cleanup was confirmed: ${errorMessage(error)}`);
      replaceRecord(this.records, record, { error: errorMessage(error), ownerState: "pending_cleanup" });
    } finally {
      if (this.active?.handle === handle) this.active = undefined;
    }
  }
}

function cleanupDiagnosticsFromReport(report: RunReport): readonly unknown[] {
  const diagnostics = report.summary.cleanupDiagnostics;
  return Array.isArray(diagnostics) ? diagnostics : [];
}

function replaceRecord(records: SessionRunRecord[], target: SessionRunRecord, patch: Partial<SessionRunRecord>): void {
  const index = records.indexOf(target);
  if (index < 0) return;
  records[index] = { ...target, ...patch };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
