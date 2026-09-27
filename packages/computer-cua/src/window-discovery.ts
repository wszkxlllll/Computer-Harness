import {
  CuaDriver,
  EndSessionInput,
  StartSessionInput,
  type CuaDriverLike,
} from "@trycua/cua-driver";
import { randomUUID } from "node:crypto";
import { activateWindowTarget, listWindowTargets, type CuaWindowInfo, type CuaWindowTarget } from "./window-contract.js";

export interface CuaWindowDiscoveryOptions {
  readonly socketPath: string;
  readonly sessionLabel?: string;
  readonly driverFactory?: (socketPath: string) => CuaDriverLike;
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
    const previousOperation = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolve) => { release = resolve; });
    await previousOperation;
    try {
      signal.throwIfAborted();
      return await this.withDriver(signal, (driver, session) => listWindowTargets(driver, session, signal, undefined, onScreenOnly));
    } finally {
      release();
    }
  }

  public async activateWindow(target: CuaWindowTarget, signal: AbortSignal): Promise<void> {
    const previousOperation = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolve) => { release = resolve; });
    await previousOperation;
    try {
      await this.withDriver(signal, (driver, session) => activateWindowTarget(driver, session, target, signal));
    } finally {
      release();
    }
  }

  private async withDriver<T>(signal: AbortSignal, operation: (driver: CuaDriverLike, session: string) => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    await this.retryPendingCleanup();
    const driver = (this.options.driverFactory ?? ((socketPath) => CuaDriver.connect(socketPath)))(this.options.socketPath);
    const session = this.options.sessionLabel ?? `computer-harness-window-picker-${randomUUID()}`;
    let value: T | undefined;
    let primaryError: unknown;
    try {
      await driver.startSession(StartSessionInput.new({ session }), { signal });
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
    let endResult: { active?: boolean } | undefined;
    try {
      endResult = await driver.endSession(EndSessionInput.new({ session }), { signal: cleanupSignal }) as { active?: boolean };
      if (endResult.active === true) {
        endResult = await driver.endSession(EndSessionInput.new({ session }), { signal: cleanupSignal }) as { active?: boolean };
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
