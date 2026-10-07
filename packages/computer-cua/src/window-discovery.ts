import { randomUUID } from "node:crypto";
import { loadCuaSdkModule, type CuaDriverLike } from "./cua-sdk-platform.js";
import {
  captureWindowWithRetry,
  activateWindowTarget,
  listWindowInventory,
  validateWindowTarget,
  isLocalWindowsNamedPipeSocket,
  WindowContractError,
  type CuaWindowCapture,
  type CuaWindowInfo,
  type CuaWindowInventory,
  type CuaWindowTarget,
  type WindowCaptureRetryOptions,
} from "./window-contract.js";
import { captureVisibleWindowRegion } from "./windows-visible-window-capture.js";
import type { WindowRelationshipProbe } from "./window-relationship-probe.js";

/** Bounded source size for preview-only PNG normalization in app-runtime. */
const MAX_WINDOW_PREVIEW_SOURCE_BYTES = 16 * 1024 * 1024;

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
  /** Explicit DI seam; production enables this only for a local Windows pipe. */
  readonly foregroundVisibleCapture?: WindowCaptureRetryOptions["foregroundVisibleCapture"];
}

export class CuaWindowDiscoveryCleanupError extends Error {
  public constructor(message: string, public readonly cleanupErrors: readonly string[]) {
    super(message);
    this.name = "CuaWindowDiscoveryCleanupError";
  }
}

/**
 * Read-only host window inventory for a local picker. The temporary CUA
 * session never captures a screenshot, focuses a window, or dispatches input.
 */
export class CuaWindowDiscovery {
  private readonly options: CuaWindowDiscoveryOptions;
  private pendingCleanup: { driver: CuaDriverLike; session: string } | undefined;
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
      const foregroundVisibleCapture = this.options.foregroundVisibleCapture ??
        (process.platform === "win32" && this.options.driverFactory === undefined &&
          isLocalWindowsNamedPipeSocket(this.options.socketPath) ? captureVisibleWindowRegion : undefined);
      const captureOptions: WindowCaptureRetryOptions | undefined = foregroundVisibleCapture === undefined
        ? undefined
        : { foregroundVisibleCapture, foregroundVisibleCaptureMaxBytes: MAX_WINDOW_PREVIEW_SOURCE_BYTES };
      const capture = await captureWindowWithRetry(driver, session, target, signal, captureOptions, osPlatform);
      if (capture.binding.target.pid !== target.pid || capture.binding.target.windowId !== target.windowId) {
        throw new Error("window preview capture did not retain the exact candidate identity");
      }
      if (capture.data.byteLength > MAX_WINDOW_PREVIEW_SOURCE_BYTES) {
        throw new WindowContractError("WINDOW_PREVIEW_IMAGE_TOO_LARGE", "window preview source exceeds the bounded normalization size");
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
    const osPlatform = this.options.osPlatform ?? process.platform;
    await this.withSerializedOperation(() => this.withDriver(signal, async (driver, session) => {
      const inventory = await listWindowInventory(
        driver, session, signal, undefined, false, this.options.windowRelationshipProbe, osPlatform,
      );
      const matches = inventory.windows.filter((window) =>
        window.target.pid === target.pid && window.target.windowId === target.windowId);
      if (matches.length === 0 || matches[0]?.cuaListed === false) {
        throw new WindowContractError("WINDOW_TARGET_NOT_FOUND", "selected activation target is not discoverable by the CUA backend");
      }
      if (matches.length !== 1) {
        throw new WindowContractError("WINDOW_TARGET_SCHEMA", "selected activation target is ambiguous in the fresh inventory");
      }
      if (matches[0]!.noActivate === true) {
        throw new WindowContractError("WINDOW_TARGET_NOT_FOUND", "selected activation target is a known non-activating auxiliary window");
      }
      await activateWindowTarget(driver, session, target, signal);
    }), signal);
  }

  private async withDriver<T>(signal: AbortSignal, operation: (driver: CuaDriverLike, session: string) => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    await this.retryPendingCleanup();
    const sdkModule = await loadCuaSdkModule();
    const driver = this.options.driverFactory !== undefined
      ? this.options.driverFactory(this.options.socketPath)
      : sdkModule.CuaDriver.connect(this.options.socketPath);
    const session = this.options.sessionLabel ?? `computer-harness-window-picker-${randomUUID()}`;
    let value: T | undefined;
    let primaryError: unknown;
    try {
      await driver.startSession(sdkModule.StartSessionInput.new({ session }), { signal });
      value = await operation(driver, session);
    } catch (error) {
      primaryError = error;
    }

    const cleanupErrors = await this.cleanupDriver(driver, session);
    if (cleanupErrors.length > 0) {
      this.pendingCleanup = { driver, session };
      const primary = primaryError === undefined ? "window discovery failed" : errorMessage(primaryError);
      throw new CuaWindowDiscoveryCleanupError(`${primary}; window picker cleanup is not confirmed`, cleanupErrors);
    }
    if (primaryError !== undefined) throw primaryError;
    return value as T;
  }

  private async retryPendingCleanup(): Promise<void> {
    const pending = this.pendingCleanup;
    if (pending === undefined) return;
    const errors = await this.cleanupDriver(pending.driver, pending.session);
    if (errors.length > 0) {
      throw new CuaWindowDiscoveryCleanupError("previous window picker cleanup is still pending", errors);
    }
    this.pendingCleanup = undefined;
  }

  private async cleanupDriver(driver: CuaDriverLike, session: string): Promise<string[]> {
    const cleanupErrors: string[] = [];
    const cleanupSignal = AbortSignal.timeout(5_000);
    const sdkModule = await loadCuaSdkModule();
    let endResult: { active?: boolean } | undefined;
    try {
      endResult = await driver.endSession(sdkModule.EndSessionInput.new({ session }), { signal: cleanupSignal }) as { active?: boolean };
      if (endResult.active === true) {
        endResult = await driver.endSession(sdkModule.EndSessionInput.new({ session }), { signal: cleanupSignal }) as { active?: boolean };
      }
      if (endResult.active === true) cleanupErrors.push("window picker session remained active");
    } catch (error) {
      cleanupErrors.push(`endSession: ${errorMessage(error)}`);
    }
    try {
      await driver.shutdown({ signal: cleanupSignal });
    } catch (error) {
      cleanupErrors.push(`shutdown: ${errorMessage(error)}`);
    }
    if (cleanupErrors.length === 0) {
      const destroy = (driver as unknown as { uniffiDestroy?: () => void }).uniffiDestroy;
      destroy?.call(driver);
    }
    return cleanupErrors;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireExactPreviewCandidate(inventory: CuaWindowInventory, target: CuaWindowTarget): CuaWindowInfo {
  const matches = inventory.windows.filter((window) => window.target.pid === target.pid && window.target.windowId === target.windowId);
  if (matches.length === 0) throw new WindowContractError("WINDOW_TARGET_NOT_FOUND", "window preview candidate is missing from the fresh inventory");
  if (matches.length > 1) throw new WindowContractError("WINDOW_TARGET_SCHEMA", "window preview candidate is ambiguous in the fresh inventory");
  if (matches[0]!.cuaListed === false) {
    throw new WindowContractError("WINDOW_TARGET_NOT_FOUND", "window preview target is not discoverable by the CUA backend");
  }
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
