import { randomUUID } from "node:crypto";
import { isProxy } from "node:util/types";
import { loadCuaSdkModule, type CuaDriverLike } from "./cua-sdk-platform.js";
import {
  captureWindowWithRetry,
  activateWindowTarget,
  listWindowInventory,
  validateWindowTarget,
  type CuaWindowCapture,
  type CuaWindowInfo,
  type CuaWindowInventory,
  type CuaWindowTarget,
} from "./window-contract.js";
import type { WindowRelationshipProbe } from "./window-relationship-probe.js";

export interface CuaWindowPreviewCapture {
  readonly capture: CuaWindowCapture;
  /** Fresh post-capture metadata from the same temporary session. */
  readonly inventory: CuaWindowInventory;
  readonly capturedAt: string;
}

export interface CuaWindowDiscoveryOptions {
  readonly socketPath: string;
  readonly sessionLabel?: string;
  readonly driverFactory?: (socketPath: string) => CuaDriverLike;
  readonly windowRelationshipProbe?: WindowRelationshipProbe;
  readonly osPlatform?: NodeJS.Platform;
}

export class CuaWindowDiscoveryCleanupError extends Error {
  public constructor(message: string, public readonly cleanupErrors: readonly string[]) {
    super(message);
    this.name = "CuaWindowDiscoveryCleanupError";
  }
}

type LifecycleStage = "loadSDK" | "connect" | "start" | "operation" | "cleanupLoadSDK" | "endSession" | "shutdown" | "destroy";
type LifecycleStageState = "not_started" | "in_progress" | "succeeded" | "failed" | "not_available";
type LifecycleErrorKind = "none" | "load_sdk_failed" | "connect_failed" | "start_failed" | "operation_failed"
  | "cleanup_load_sdk_failed" | "end_session_failed" | "session_active" | "shutdown_failed" | "destroy_failed" | "cleanup_unknown";
type LifecycleExceptionKind = "none" | "abort" | "timeout" | "type_error" | "module_not_found" | "dlopen" | "protocol" | "transport" | "unknown";
function exceptionKind(error: unknown): LifecycleExceptionKind {
  // Never invoke user getters, proxy traps, message, stack or SDK imports.
  if (error === null || typeof error !== "object" || isProxy(error)) return "unknown";
  try {
    const data = (key: string): unknown => {
      const descriptor = Object.getOwnPropertyDescriptor(error, key);
      return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
    };
    const code = data("code"), tag = data("tag"), name = data("name");
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") return "module_not_found";
    if (code === "ERR_DLOPEN_FAILED") return "dlopen";
    if (tag === "Protocol") return "protocol";
    if (tag === "Transport") return "transport";
    if (name === "AbortError") return "abort";
    if (name === "TimeoutError") return "timeout";
    if (Object.getPrototypeOf(error) === TypeError.prototype) return "type_error";
    if (Object.getPrototypeOf(error) === DOMException.prototype) {
      const nativeName = Object.getOwnPropertyDescriptor(DOMException.prototype, "name")?.get?.call(error);
      if (nativeName === "AbortError") return "abort";
      if (nativeName === "TimeoutError") return "timeout";
    }
  } catch { /* Unknown evidence must never replace the original failure. */ }
  return "unknown";
}
/** Closed scalar evidence only: no session, endpoint, SDK error or window data. */
export interface CuaWindowDiscoveryLifecycleSnapshot {
  readonly sequence: number;
  readonly phase: LifecycleStage | "idle" | "retryPendingCleanup" | "complete";
  readonly outcome: "idle" | "in_progress" | "succeeded" | "failed_cleanup_not_started" | "failed_cleanup_confirmed" | "failed_cleanup_unconfirmed";
  readonly primaryFailed: boolean;
  readonly cleanup: "not_started" | "confirmed" | "unconfirmed";
  readonly pendingCleanup: boolean;
  readonly errorKind: LifecycleErrorKind;
  readonly cleanupErrorKind: LifecycleErrorKind;
  readonly primaryExceptionKind: LifecycleExceptionKind;
  readonly cleanupExceptionKind: LifecycleExceptionKind;
  readonly loadSDK: LifecycleStageState;
  readonly connect: LifecycleStageState;
  readonly start: LifecycleStageState;
  readonly operation: LifecycleStageState;
  readonly cleanupLoadSDK: LifecycleStageState;
  readonly endSession: LifecycleStageState;
  readonly shutdown: LifecycleStageState;
  readonly destroy: LifecycleStageState;
  readonly cleanupAttempts: number;
  /** Per cleanup invocation; original endSession limit remains two. */
  readonly endSessionAttempts: number;
  readonly complete: boolean;
}
function initialLifecycle(sequence = 0): CuaWindowDiscoveryLifecycleSnapshot {
  return { sequence, phase: "idle", outcome: "idle", primaryFailed: false, cleanup: "not_started", pendingCleanup: false,
    errorKind: "none", cleanupErrorKind: "none", primaryExceptionKind: "none", cleanupExceptionKind: "none", loadSDK: "not_started", connect: "not_started", start: "not_started", operation: "not_started",
    cleanupLoadSDK: "not_started", endSession: "not_started", shutdown: "not_started", destroy: "not_started", cleanupAttempts: 0, endSessionAttempts: 0, complete: false };
}

/**
 * Read-only host window inventory for a local picker. The temporary CUA
 * session never captures a screenshot, focuses a window, or dispatches input.
 */
export class CuaWindowDiscovery {
  private readonly options: CuaWindowDiscoveryOptions;
  private pendingCleanup: { driver: CuaDriverLike; session: string } | undefined;
  private lifecycle = initialLifecycle();
  /**
   * A picker owns a native driver and temporary session for its whole
   * lifecycle. Serialize the lifecycle, including cleanup retries, so an
   * Esc/reopen race cannot orphan two failed cleanup sessions.
   */
  private operationTail: Promise<void> = Promise.resolve();

  public constructor(options: CuaWindowDiscoveryOptions) {
    if (!options.socketPath.trim()) throw new Error("CuaWindowDiscovery requires an explicit daemon socketPath");
    this.options = options;
  }

  public getLifecycleSnapshot(): CuaWindowDiscoveryLifecycleSnapshot {
    return Object.freeze({ ...this.lifecycle, pendingCleanup: this.pendingCleanup !== undefined });
  }

  private mark(patch: Partial<CuaWindowDiscoveryLifecycleSnapshot>): void {
    this.lifecycle = { ...this.lifecycle, ...patch };
  }
  private stage(stage: LifecycleStage, state: LifecycleStageState): void {
    this.mark({ phase: stage, [stage]: state });
  }
  private failure(kind: LifecycleErrorKind, primary: boolean, error?: unknown): void {
    this.mark({ errorKind: this.lifecycle.errorKind === "none" ? kind : this.lifecycle.errorKind,
      ...(primary ? { primaryFailed: true, primaryExceptionKind: exceptionKind(error) }
        : { cleanupErrorKind: this.lifecycle.cleanupErrorKind === "none" ? kind : this.lifecycle.cleanupErrorKind,
          cleanupExceptionKind: this.lifecycle.cleanupExceptionKind === "none" ? exceptionKind(error) : this.lifecycle.cleanupExceptionKind }) });
  }
  private finish(): void {
    this.mark({ phase: "complete", complete: true, outcome: this.lifecycle.primaryFailed || this.lifecycle.cleanup !== "confirmed"
      ? this.lifecycle.cleanup === "confirmed" ? "failed_cleanup_confirmed" : this.lifecycle.cleanup === "not_started" ? "failed_cleanup_not_started" : "failed_cleanup_unconfirmed"
      : "succeeded" });
  }

  public async listWindows(signal: AbortSignal, onScreenOnly = true): Promise<readonly CuaWindowInfo[]> {
    return this.withSerializedOperation(async () => (await this.listInventoryOnce(signal, onScreenOnly)).windows, signal);
  }

  /**
   * Return one read-only inventory snapshot with its completeness and source
   * attestation intact. Consumers that make relationship-based decisions must
   * inspect these fields from the same snapshot as the owner rows.
   */
  public async listInventory(signal: AbortSignal, onScreenOnly = true): Promise<CuaWindowInventory> {
    return this.withSerializedOperation(() => this.listInventoryOnce(signal, onScreenOnly), signal);
  }

  /**
   * Capture one exact candidate for a host picker. This read-only path uses a
   * temporary session, checks the same PID/HWND before and after capture, and
   * never activates, dispatches input, creates a Surface, or writes an asset.
   */
  public async captureWindowPreview(target: CuaWindowTarget, signal: AbortSignal): Promise<CuaWindowPreviewCapture> {
    validateWindowTarget(target);
    const osPlatform = this.options.osPlatform ?? process.platform;
    return this.withSerializedOperation(() => this.withDriver(signal, async (driver, session) => {
      const before = await listWindowInventory(driver, session, signal, undefined, true, this.options.windowRelationshipProbe, osPlatform);
      requireExactPreviewCandidate(before, target);
      const capture = await captureWindowWithRetry(driver, session, target, signal, undefined, osPlatform);
      if (capture.binding.target.pid !== target.pid || capture.binding.target.windowId !== target.windowId) {
        throw new Error("window preview capture did not retain the exact candidate identity");
      }
      if (capture.data.byteLength > MAX_WINDOW_PREVIEW_BYTES) {
        throw new Error("window preview exceeds the bounded image size");
      }
      const inventory = await listWindowInventory(driver, session, signal, undefined, true, this.options.windowRelationshipProbe, osPlatform);
      const after = requireExactPreviewCandidate(inventory, target);
      const beforeCandidate = requireExactPreviewCandidate(before, target);
      if (beforeCandidate.appName !== undefined && after.appName !== undefined &&
          normalizeWindowLabel(beforeCandidate.appName) !== normalizeWindowLabel(after.appName)) {
        throw new Error("window preview candidate application changed during capture");
      }
      signal.throwIfAborted();
      return { capture, inventory, capturedAt: new Date().toISOString() };
    }), signal);
  }

  private async listInventoryOnce(signal: AbortSignal, onScreenOnly: boolean): Promise<CuaWindowInventory> {
    signal.throwIfAborted();
    return this.withDriver(signal, (driver, session) => listWindowInventory(
      driver,
      session,
      signal,
      undefined,
      onScreenOnly,
      this.options.windowRelationshipProbe,
      this.options.osPlatform ?? process.platform,
    ));
  }

  private withSerializedOperation<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    const previousOperation = this.operationTail;
    let started = false;
    const currentOperation = previousOperation.then(() => {
      signal.throwIfAborted();
      started = true;
      return operation();
    });
    this.operationTail = currentOperation.then(() => undefined, () => undefined);
    return settleBeforeAbort(currentOperation, signal, () => started);
  }

  public async activateWindow(target: CuaWindowTarget, signal: AbortSignal): Promise<void> {
    validateWindowTarget(target);
    await this.withSerializedOperation(() => this.withDriver(signal, (driver, session) => activateWindowTarget(driver, session, target, signal)), signal);
  }

  private async withDriver<T>(signal: AbortSignal, operation: (driver: CuaDriverLike, session: string) => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    this.lifecycle = { ...initialLifecycle(this.lifecycle.sequence + 1), outcome: "in_progress" };
    try { await this.retryPendingCleanup(); } catch (error) { this.finish(); throw error; }
    // A previous owner's confirmed retry is not cleanup of a new driver that
    // has not yet been loaded/connected. Keep only the cumulative attempt count.
    this.mark({ cleanup: "not_started", cleanupLoadSDK: "not_started", endSession: "not_started", shutdown: "not_started", destroy: "not_started", endSessionAttempts: 0 });
    this.stage("loadSDK", "in_progress");
    let sdkModule: Awaited<ReturnType<typeof loadCuaSdkModule>>;
    try { sdkModule = await loadCuaSdkModule(); this.stage("loadSDK", "succeeded"); }
    catch (error) { this.stage("loadSDK", "failed"); this.failure("load_sdk_failed", true, error); this.finish(); throw error; }
    this.stage("connect", "in_progress");
    let driver: CuaDriverLike;
    try {
      driver = this.options.driverFactory !== undefined
        ? this.options.driverFactory(this.options.socketPath)
        : sdkModule.CuaDriver.connect(this.options.socketPath);
      this.stage("connect", "succeeded");
    } catch (error) { this.stage("connect", "failed"); this.failure("connect_failed", true, error); this.finish(); throw error; }
    const session = this.options.sessionLabel ?? `computer-harness-window-picker-${randomUUID()}`;
    let value: T | undefined;
    let primaryError: unknown;
    try {
      this.stage("start", "in_progress");
      await driver.startSession(sdkModule.StartSessionInput.new({ session }), { signal });
      this.stage("start", "succeeded");
      this.stage("operation", "in_progress");
      value = await operation(driver, session);
      this.stage("operation", "succeeded");
    } catch (error) {
      const failedStart = this.lifecycle.start !== "succeeded";
      this.stage(failedStart ? "start" : "operation", "failed");
      this.failure(failedStart ? "start_failed" : "operation_failed", true, error);
      primaryError = error;
    }

    let cleanupErrors: string[];
    try { cleanupErrors = await this.cleanupDriver(driver, session); }
    catch (error) {
      // Retain the same owner after unexpected loader/destroy failure. Preserve
      // the original thrown value and existing call count; never retry here.
      this.pendingCleanup = { driver, session };
      this.mark({ cleanup: "unconfirmed" }); this.failure("cleanup_unknown", false, error); this.finish();
      throw error;
    }
    if (cleanupErrors.length > 0) {
      this.pendingCleanup = { driver, session };
      this.mark({ cleanup: "unconfirmed" }); this.finish();
      const primary = primaryError === undefined ? "window discovery failed" : errorMessage(primaryError);
      throw new CuaWindowDiscoveryCleanupError(`${primary}; window picker cleanup is not confirmed`, cleanupErrors);
    }
    this.finish();
    if (primaryError !== undefined) throw primaryError;
    return value as T;
  }

  private async retryPendingCleanup(): Promise<void> {
    const pending = this.pendingCleanup;
    if (pending === undefined) return;
    this.mark({ phase: "retryPendingCleanup" });
    let errors: string[];
    try { errors = await this.cleanupDriver(pending.driver, pending.session); }
    catch (error) { this.mark({ cleanup: "unconfirmed" }); this.failure("cleanup_unknown", false, error); throw error; }
    if (errors.length > 0) {
      throw new CuaWindowDiscoveryCleanupError("previous window picker cleanup is still pending", errors);
    }
    this.pendingCleanup = undefined;
  }

  private async cleanupDriver(driver: CuaDriverLike, session: string): Promise<string[]> {
    this.mark({ cleanup: "unconfirmed", cleanupAttempts: this.lifecycle.cleanupAttempts + 1, endSessionAttempts: 0,
      endSession: "not_started", shutdown: "not_started", destroy: "not_started" });
    const cleanupErrors: string[] = [];
    const cleanupSignal = AbortSignal.timeout(5_000);
    this.stage("cleanupLoadSDK", "in_progress");
    let sdkModule: Awaited<ReturnType<typeof loadCuaSdkModule>>;
    try { sdkModule = await loadCuaSdkModule(); this.stage("cleanupLoadSDK", "succeeded"); }
    catch (error) { this.stage("cleanupLoadSDK", "failed"); this.failure("cleanup_load_sdk_failed", false, error); throw error; }
    let endResult: { active?: boolean } | undefined;
    try {
      this.stage("endSession", "in_progress"); this.mark({ endSessionAttempts: 1 });
      endResult = await driver.endSession(sdkModule.EndSessionInput.new({ session }), { signal: cleanupSignal }) as { active?: boolean };
      if (endResult.active === true) {
        this.mark({ endSessionAttempts: 2 });
        endResult = await driver.endSession(sdkModule.EndSessionInput.new({ session }), { signal: cleanupSignal }) as { active?: boolean };
      }
      if (endResult.active === true) { this.stage("endSession", "failed"); this.failure("session_active", false); cleanupErrors.push("window picker session remained active"); }
      else this.stage("endSession", "succeeded");
    } catch (error) {
      this.stage("endSession", "failed"); this.failure("end_session_failed", false, error);
      cleanupErrors.push(`endSession: ${errorMessage(error)}`);
    }
    try {
      this.stage("shutdown", "in_progress");
      await driver.shutdown({ signal: cleanupSignal });
      this.stage("shutdown", "succeeded");
    } catch (error) {
      this.stage("shutdown", "failed"); this.failure("shutdown_failed", false, error);
      cleanupErrors.push(`shutdown: ${errorMessage(error)}`);
    }
    if (cleanupErrors.length === 0) {
      this.stage("destroy", "in_progress");
      try {
        const destroy = (driver as unknown as { uniffiDestroy?: () => void }).uniffiDestroy;
        destroy?.call(driver);
        this.stage("destroy", destroy === undefined || destroy === null ? "not_available" : "succeeded");
      } catch (error) { this.stage("destroy", "failed"); this.failure("destroy_failed", false, error); throw error; }
      this.mark({ cleanup: "confirmed" });
    }
    return cleanupErrors;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const MAX_WINDOW_PREVIEW_BYTES = 1_048_576;

function requireExactPreviewCandidate(inventory: CuaWindowInventory, target: CuaWindowTarget): CuaWindowInfo {
  const matches = inventory.windows.filter((window) => window.target.pid === target.pid && window.target.windowId === target.windowId);
  if (matches.length !== 1) throw new Error("window preview candidate is missing or ambiguous in the fresh inventory");
  return matches[0]!;
}

function normalizeWindowLabel(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase();
}

function settleBeforeAbort<T>(operation: Promise<T>, signal: AbortSignal, hasStarted: () => boolean): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("window preview was cancelled"));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      if (settled || hasStarted()) return;
      settled = true;
      cleanup();
      reject(signal.reason ?? new Error("window preview was cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then((value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }, (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
}
