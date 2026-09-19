import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { RunId, RunOutcome } from "@computer-harness/protocol";
import type { RunReport } from "./reporting.js";
import { createRun } from "./run-factory.js";
import {
  environmentIdentityForConfig,
  inProcessEnvironmentOwner,
  type EnvironmentLease,
  type EnvironmentLeaseInfo,
  type InProcessEnvironmentOwner,
} from "./environment-owner.js";
import type { ResolvedRunConfig, RunDependencies, RunHandle } from "./config.js";

export type ApplicationSessionConfig = Omit<ResolvedRunConfig, "goal" | "runId">;

/** Feature-only overrides selected by an interactive UI for the next Run. */
export type ApplicationSessionRunFeatureOverrides = Partial<Pick<
  ApplicationSessionConfig,
  "planning" | "memory" | "memoryRetrieval" | "batching" | "contextMode" | "contextMaxHistoryEvents" | "contextMaxInputTokens" | "monitor"
>>;

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
  readonly owner?: InProcessEnvironmentOwner;
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
  private readonly owner: InProcessEnvironmentOwner;
  private readonly environmentIdentity: string;
  private readonly records: SessionRunRecord[] = [];
  private active: { handle: RunHandle; lease: EnvironmentLease; completion: Promise<void>; record: SessionRunRecord } | undefined;
  private closed = false;
  private lastCompletion: Promise<void> | undefined;

  public constructor(options: ApplicationSessionOptions) {
    this.config = options.config;
    this.dependencies = options.dependencies ?? {};
    this.createRunFactory = options.createRun ?? createRun;
    this.owner = options.owner ?? inProcessEnvironmentOwner;
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

  public async startRun(goal: string, featureOverrides: ApplicationSessionRunFeatureOverrides = {}): Promise<RunHandle> {
    if (this.closed) throw new Error("application session is closed");
    if (goal.trim().length === 0) throw new Error("application session requires a non-empty goal");
    if (this.active !== undefined) throw new Error("application session already has an active Run");
    const runId = `run-${Date.now()}-${randomUUID().slice(0, 12)}` as RunId;
    const config: ResolvedRunConfig = {
      ...this.config,
      ...featureOverrides,
      goal,
      runId,
      outputDir: resolve(this.config.outputDir, runId),
    };
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
      const outcome = handle.start();
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
      if (safeToRelease) {
        lease.release();
        replaceRecord(this.records, record, { outcome, ownerState: "released" });
      } else {
        lease.markPending(outcome === "outcome_unknown" ? "Run has an unresolved/unknown external side effect" : "Run cleanup is not fully confirmed");
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
