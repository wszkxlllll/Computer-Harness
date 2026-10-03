import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import {
  type EnvironmentLease,
  type EnvironmentOwner,
  inspectManagedBrowserProfile,
  prepareManagedBrowserProfile,
  ManagedBrowserPreparationError,
  type ManagedBrowserPreparationDependencies,
  type ManagedBrowserPreparationResult,
} from "@computer-harness/app-runtime";

export type ManagedBrowserDefaultSession = "saved" | "temporary";
export type ManagedBrowserProfileStatus = "unprepared" | "preparing" | "ready" | "in_use" | "relogin_required" | "cleanup_failed";

export interface ManagedBrowserProfileStateView {
  readonly status: ManagedBrowserProfileStatus;
  readonly defaultSession: ManagedBrowserDefaultSession;
  readonly commands: {
    readonly prepare: string;
    readonly complete: string;
    readonly relogin: string;
  };
  /** Opaque generation token required by complete; never identifies a profile or process. */
  readonly operationId?: string;
}

export interface ManagedBrowserProfilePersistedState {
  readonly version: 2;
  /** Opaque binding to the selected Host-local profile identity. */
  readonly profileIdentityHash: string;
  readonly defaultSession: ManagedBrowserDefaultSession;
  readonly readyConfirmed: boolean;
}

export interface LegacyManagedBrowserProfilePersistedState {
  readonly version: 1;
  readonly defaultSession: ManagedBrowserDefaultSession;
  readonly readyConfirmed: boolean;
}

export type LoadedManagedBrowserProfilePersistedState = ManagedBrowserProfilePersistedState | LegacyManagedBrowserProfilePersistedState;

export interface ManagedBrowserProfileStateStore {
  load(): Promise<LoadedManagedBrowserProfilePersistedState | undefined>;
  save(state: ManagedBrowserProfilePersistedState): Promise<void>;
}

export interface ManagedBrowserProfileServiceOptions {
  readonly socketPath: string;
  readonly profileLabel: string;
  readonly profileRoot: string;
  readonly environmentOwner: EnvironmentOwner;
  readonly environmentIdentity: string;
  readonly store?: ManagedBrowserProfileStateStore;
  readonly inspectProfile?: typeof inspectManagedBrowserProfile;
  readonly inspectProfileDirectory?: (profileRoot: string, profileLabel: string) => Promise<"present" | "missing" | "unsafe">;
  readonly prepareProfile?: typeof prepareManagedBrowserProfile;
  readonly preparationDependencies?: Omit<ManagedBrowserPreparationDependencies, "onReady" | "waitForContinue">;
}

export interface ManagedBrowserProfileController {
  getState(): Promise<ManagedBrowserProfileStateView>;
  setDefaultSession(value: unknown): Promise<ManagedBrowserProfileStateView>;
  prepare(): Promise<ManagedBrowserProfileStateView>;
  complete(operationId: unknown): Promise<ManagedBrowserProfileStateView>;
  relogin(): Promise<ManagedBrowserProfileStateView>;
  close?(): Promise<void>;
}

export class ManagedBrowserProfileServiceError extends Error {
  public constructor(
    public readonly statusCode: 400 | 409 | 503,
    public readonly code: "INVALID_REQUEST" | "PREPARE_BUSY" | "PROFILE_BUSY" | "PROFILE_NOT_READY" | "PROFILE_OPERATION_STALE" | "PROFILE_STATE_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "ManagedBrowserProfileServiceError";
  }
}

const STATE_FILE_NAME = "managed-browser-profile-state.json";
const COMMANDS = Object.freeze({
  prepare: "/api/managed-browser-profile/prepare",
  complete: "/api/managed-browser-profile/complete",
  relogin: "/api/managed-browser-profile/relogin",
});

/** Store local preference and explicit readiness confirmation beside the Host state. */
export function defaultManagedBrowserProfileStatePath(profileRoot: string): string {
  const resolvedProfileRoot = resolve(profileRoot);
  return resolve(dirname(resolvedProfileRoot), STATE_FILE_NAME);
}

export class FileManagedBrowserProfileStateStore implements ManagedBrowserProfileStateStore {
  public constructor(private readonly filePath: string) {
    if (!isAbsolute(filePath)) throw new Error("managed browser state file path must be absolute");
  }

  public async load(): Promise<LoadedManagedBrowserProfilePersistedState | undefined> {
    let info;
    try {
      info = await lstat(this.filePath);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("managed browser state file is not a regular file");
    if (info.size > 4_096) throw new Error("managed browser state file exceeds its size limit");
    const raw: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
    if (!isLoadedPersistedState(raw)) throw new Error("managed browser state file has an invalid format");
    return raw;
  }

  public async save(state: ManagedBrowserProfilePersistedState): Promise<void> {
    if (!isCurrentPersistedState(state)) throw new Error("managed browser state is invalid");
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = resolve(directory, `${basename(this.filePath)}.${randomUUID()}.tmp`);
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(temporaryPath, "wx", 0o600);
      await file.writeFile(JSON.stringify(state) + "\n", { encoding: "utf8" });
      await file.sync();
      await file.close();
      file = undefined;
      await rename(temporaryPath, this.filePath);
    } finally {
      await file?.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

interface PreparationOperation {
  readonly operationId: string;
  readonly wasReady: boolean;
  readonly desktopLease: EnvironmentLease;
  readonly continue: Deferred<"enter" | "interrupt">;
  readonly browserReady: Deferred<void>;
  readonly abortController: AbortController;
  task: Promise<void>;
  completeTask?: Promise<void>;
}

/** Coordinates phone commands with the Host-owned visible browser lifecycle. */
export class ManagedBrowserProfileService implements ManagedBrowserProfileController {
  private readonly store: ManagedBrowserProfileStateStore;
  private readonly inspectProfile: typeof inspectManagedBrowserProfile;
  private readonly prepareProfile: typeof prepareManagedBrowserProfile;
  private readonly inspectProfileDirectory: NonNullable<ManagedBrowserProfileServiceOptions["inspectProfileDirectory"]>;
  private readonly profileIdentityHash: string;
  private readonly lock: { tail: Promise<void> } = { tail: Promise.resolve() };
  private initialized = false;
  private initializationFailed = false;
  private defaultSession: ManagedBrowserDefaultSession = "saved";
  private readyConfirmed = false;
  private status: ManagedBrowserProfileStatus = "unprepared";
  private activePreparation: PreparationOperation | undefined;
  private lastCompletedOperationId: string | undefined;
  private runUseCount = 0;
  private closed = false;

  public constructor(private readonly options: ManagedBrowserProfileServiceOptions) {
    this.store = options.store ?? new FileManagedBrowserProfileStateStore(defaultManagedBrowserProfileStatePath(options.profileRoot));
    this.inspectProfile = options.inspectProfile ?? inspectManagedBrowserProfile;
    this.inspectProfileDirectory = options.inspectProfileDirectory ?? inspectManagedBrowserProfileDirectory;
    this.prepareProfile = options.prepareProfile ?? prepareManagedBrowserProfile;
    if (!/^[A-Za-z0-9._-]{1,64}$/u.test(options.profileLabel) || !isAbsolute(options.profileRoot) ||
        options.environmentIdentity.trim().length === 0) {
      throw new Error("managed browser profile service requires Host-owned profile configuration");
    }
    this.profileIdentityHash = managedBrowserProfileIdentityHash(options.profileRoot, options.profileLabel);
  }

  public getDefaultSession(): ManagedBrowserDefaultSession {
    return this.defaultSession;
  }

  public async getState(): Promise<ManagedBrowserProfileStateView> {
    return await this.exclusive(async () => {
      await this.initializeLocked();
      await this.refreshStatusLocked();
      return this.viewLocked();
    });
  }

  public async setDefaultSession(value: unknown): Promise<ManagedBrowserProfileStateView> {
    if (value !== "saved" && value !== "temporary") {
      throw new ManagedBrowserProfileServiceError(400, "INVALID_REQUEST", "defaultSession must be saved or temporary.");
    }
    const defaultSession = value as ManagedBrowserDefaultSession;
    return await this.exclusive(async () => {
      await this.initializeLocked();
      this.requireStateStore();
      const next = this.persistedState(this.readyConfirmed, defaultSession);
      try {
        await this.store.save(next);
      } catch {
        this.initializationFailed = true;
        this.status = "cleanup_failed";
        throw new ManagedBrowserProfileServiceError(503, "PROFILE_STATE_UNAVAILABLE", "Managed browser settings could not be saved.");
      }
      this.defaultSession = defaultSession;
      await this.refreshStatusLocked();
      return this.viewLocked();
    });
  }

  public async prepare(): Promise<ManagedBrowserProfileStateView> {
    return await this.beginOrReturnPreparation("prepare");
  }

  public async relogin(): Promise<ManagedBrowserProfileStateView> {
    return await this.beginOrReturnPreparation("relogin");
  }

  public async complete(operationId: unknown): Promise<ManagedBrowserProfileStateView> {
    if (typeof operationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(operationId)) {
      throw new ManagedBrowserProfileServiceError(400, "INVALID_REQUEST", "operationId is invalid.");
    }
    const completion = await this.exclusive(async () => {
      await this.initializeLocked();
      if (this.lastCompletedOperationId === operationId) return { task: undefined };
      const operation = this.activePreparation;
      if (operation === undefined || operation.operationId !== operationId) {
        throw new ManagedBrowserProfileServiceError(409, "PROFILE_OPERATION_STALE", "The profile preparation operation is no longer active.");
      }
      operation.completeTask ??= this.completeOperation(operation);
      return { task: operation.completeTask };
    });
    await completion.task;
    return await this.getState();
  }

  /** Reserve the saved profile before a Run creates any Computer or browser process. */
  public async acquireForRun(): Promise<() => Promise<void>> {
    return await this.exclusive(async () => {
      await this.initializeLocked();
      await this.refreshStatusLocked();
      if (this.status === "in_use" || this.activePreparation !== undefined) {
        throw new ManagedBrowserProfileServiceError(409, "PROFILE_BUSY", "The managed browser profile is already in use.");
      }
      if (this.status !== "ready") {
        throw new ManagedBrowserProfileServiceError(409, "PROFILE_NOT_READY", "The saved managed browser profile requires setup before this Run can start.");
      }
      this.runUseCount += 1;
      this.status = "in_use";
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await this.exclusive(async () => {
          this.runUseCount = Math.max(0, this.runUseCount - 1);
          await this.refreshStatusLocked();
        });
      };
    });
  }

  public async close(): Promise<void> {
    const closing = await this.exclusive(async () => {
      this.closed = true;
      const operation = this.activePreparation;
      if (operation === undefined) return { task: undefined };
      operation.continue.resolve("interrupt");
      operation.abortController.abort();
      return { task: operation.task };
    });
    await closing.task;
  }

  private async beginOrReturnPreparation(command: "prepare" | "relogin"): Promise<ManagedBrowserProfileStateView> {
    return await this.exclusive(async () => {
      await this.initializeLocked();
      await this.refreshStatusLocked();
      if (this.closed) throw new ManagedBrowserProfileServiceError(503, "PROFILE_STATE_UNAVAILABLE", "Managed browser service is closing.");
      if (this.activePreparation !== undefined) return this.viewLocked();
      if (this.status === "in_use") throw new ManagedBrowserProfileServiceError(409, "PREPARE_BUSY", "The Host desktop is already in use.");
      if (this.status === "cleanup_failed") throw new ManagedBrowserProfileServiceError(503, "PROFILE_STATE_UNAVAILABLE", "Managed browser state requires Host-side recovery.");
      if (command === "prepare" && this.status === "ready") return this.viewLocked();

      const wasReady = this.status === "ready";
      const operationId = randomUUID();
      let desktopLease: EnvironmentLease;
      try {
        desktopLease = this.options.environmentOwner.acquire(this.options.environmentIdentity, `managed-browser-profile-${operationId}`);
      } catch {
        let ownerState;
        try {
          ownerState = this.options.environmentOwner.inspect(this.options.environmentIdentity);
        } catch {
          ownerState = undefined;
          this.status = "cleanup_failed";
        }
        if (ownerState?.state === "active") {
          this.status = "in_use";
          throw new ManagedBrowserProfileServiceError(409, "PREPARE_BUSY", "The Host desktop is already in use.");
        }
        if (ownerState?.state === "pending_cleanup" || this.status === "cleanup_failed") {
          this.status = "cleanup_failed";
          throw new ManagedBrowserProfileServiceError(503, "PROFILE_STATE_UNAVAILABLE", "The Host desktop cleanup state is uncertain.");
        }
        this.status = "cleanup_failed";
        throw new ManagedBrowserProfileServiceError(503, "PROFILE_STATE_UNAVAILABLE", "The Host desktop could not be reserved safely.");
      }
      try {
        await this.store.save(this.persistedState(false));
      } catch {
        try {
          desktopLease.release();
        } catch {
          desktopLease.markPending("Managed browser setup did not start and desktop lease release could not be confirmed");
        }
        this.initializationFailed = true;
        this.status = "cleanup_failed";
        throw new ManagedBrowserProfileServiceError(503, "PROFILE_STATE_UNAVAILABLE", "Managed browser settings could not be saved.");
      }
      this.readyConfirmed = false;
      const operation: PreparationOperation = {
        operationId,
        wasReady,
        desktopLease,
        continue: createDeferred<"enter" | "interrupt">(),
        browserReady: createDeferred<void>(),
        abortController: new AbortController(),
        task: Promise.resolve(),
      };
      this.activePreparation = operation;
      this.status = "preparing";
      operation.task = this.runPreparation(operation);
      return this.viewLocked();
    });
  }

  private async completeOperation(operation: PreparationOperation): Promise<void> {
    await Promise.race([
      operation.browserReady.promise,
      operation.task,
    ]);
    if (this.activePreparation !== operation) return;
    operation.continue.resolve("enter");
    await operation.task;
  }

  private async runPreparation(operation: PreparationOperation): Promise<void> {
    let result: ManagedBrowserPreparationResult | undefined;
    let failed = false;
    let cleanupConfirmed = false;
    try {
      result = await this.prepareProfile({
        socketPath: this.options.socketPath,
        managedBrowserUrl: "about:blank",
        profileLabel: this.options.profileLabel,
        persistentProfileRoot: this.options.profileRoot,
        signal: operation.abortController.signal,
      }, {
        ...this.options.preparationDependencies,
        onReady: () => operation.browserReady.resolve(),
        waitForContinue: (signal) => waitForOperationContinue(operation.continue.promise, signal),
      });
    } catch (error) {
      failed = true;
      cleanupConfirmed = error instanceof ManagedBrowserPreparationError && error.cleanup === "confirmed";
    }
    await this.exclusive(async () => {
      if (this.activePreparation !== operation) return;
      this.activePreparation = undefined;
      const resultCleanupConfirmed = result?.profileRetention === "confirmed";
      if ((failed && !cleanupConfirmed) || (!failed && !resultCleanupConfirmed)) {
        try {
          operation.desktopLease.markPending("Managed browser preparation cleanup could not be confirmed");
        } catch {
          // Keep the active owner record when even pending-state persistence fails.
        }
        this.status = "cleanup_failed";
        return;
      }
      if (failed || result === undefined) {
        this.readyConfirmed = false;
        this.status = operation.wasReady ? "relogin_required" : "unprepared";
        try {
          operation.desktopLease.release();
        } catch {
          try {
            operation.desktopLease.markPending("Managed browser preparation desktop lease release could not be confirmed");
          } catch {
            // Keep the unresolved desktop owner record instead of releasing it.
          }
          this.status = "cleanup_failed";
        }
        return;
      }
      if (result.outcome !== "enter") {
        this.status = operation.wasReady ? "relogin_required" : "unprepared";
      } else {
        try {
          await this.store.save(this.persistedState(true));
          this.readyConfirmed = true;
          this.status = "ready";
          this.lastCompletedOperationId = operation.operationId;
        } catch {
          this.initializationFailed = true;
          this.status = "cleanup_failed";
        }
      }
      try {
        operation.desktopLease.release();
      } catch {
        try {
          operation.desktopLease.markPending("Managed browser preparation desktop lease release could not be confirmed");
        } catch {
          // Keep the unresolved desktop owner record instead of releasing it.
        }
        this.status = "cleanup_failed";
      }
    });
    operation.browserReady.resolve();
  }

  private async initializeLocked(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    try {
      const state = await this.store.load();
      if (state !== undefined) {
        this.defaultSession = state.defaultSession;
        const stateMatchesProfile = state.version === 2 && state.profileIdentityHash === this.profileIdentityHash;
        this.readyConfirmed = stateMatchesProfile && state.readyConfirmed;
        if (!stateMatchesProfile) await this.store.save(this.persistedState(false));
      }
    } catch {
      this.initializationFailed = true;
      this.status = "cleanup_failed";
    }
  }

  private async refreshStatusLocked(): Promise<void> {
    if (this.initializationFailed || this.status === "cleanup_failed") return;
    if (this.activePreparation !== undefined) {
      this.status = "preparing";
      return;
    }
    if (this.runUseCount > 0) {
      this.status = "in_use";
      return;
    }
    try {
      const desktopLease = this.options.environmentOwner.inspect(this.options.environmentIdentity);
      if (desktopLease !== undefined) {
        this.status = desktopLease.state === "active" ? "in_use" : "cleanup_failed";
        return;
      }
      const profileDirectory = await this.inspectProfileDirectory(this.options.profileRoot, this.options.profileLabel);
      if (profileDirectory === "unsafe") {
        this.status = "cleanup_failed";
        return;
      }
      if (profileDirectory === "missing") {
        if (this.readyConfirmed) {
          this.readyConfirmed = false;
          try {
            await this.store.save(this.persistedState(false));
          } catch {
            this.initializationFailed = true;
            this.status = "cleanup_failed";
            return;
          }
        }
        this.status = "unprepared";
        return;
      }
      const inspection = await this.inspectProfile(this.options.profileRoot, this.options.profileLabel);
      if (inspection.state === "active") this.status = "in_use";
      else if (inspection.state === "stale" || inspection.state === "unknown" || inspection.state === "unsafe") this.status = "cleanup_failed";
      else if (this.status === "relogin_required") this.status = "relogin_required";
      else this.status = this.readyConfirmed ? "ready" : "unprepared";
    } catch {
      this.status = "cleanup_failed";
    }
  }

  private persistedState(
    readyConfirmed: boolean,
    defaultSession = this.defaultSession,
  ): ManagedBrowserProfilePersistedState {
    return { version: 2, profileIdentityHash: this.profileIdentityHash, defaultSession, readyConfirmed };
  }

  private viewLocked(): ManagedBrowserProfileStateView {
    const operationId = this.activePreparation?.operationId;
    return {
      status: this.status,
      defaultSession: this.defaultSession,
      commands: COMMANDS,
      ...(operationId === undefined ? {} : { operationId }),
    };
  }

  private requireStateStore(): void {
    if (this.initializationFailed) {
      throw new ManagedBrowserProfileServiceError(503, "PROFILE_STATE_UNAVAILABLE", "Managed browser state is unavailable.");
    }
  }

  private async exclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    const previous = this.lock.tail;
    let release!: () => void;
    this.lock.tail = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolveValue) => { resolvePromise = resolveValue; });
  return { promise, resolve: resolvePromise };
}

async function waitForOperationContinue(
  promise: Promise<"enter" | "interrupt">,
  signal: AbortSignal,
): Promise<"enter" | "interrupt"> {
  if (signal.aborted) return "interrupt";
  return await new Promise((resolvePromise) => {
    let settled = false;
    const finish = (result: "enter" | "interrupt") => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolvePromise(result);
    };
    const onAbort = () => finish("interrupt");
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(finish);
    if (signal.aborted) finish("interrupt");
  });
}

function isCurrentPersistedState(value: unknown): value is ManagedBrowserProfilePersistedState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 4 && record.version === 2 &&
    typeof record.profileIdentityHash === "string" && /^[0-9a-f]{64}$/u.test(record.profileIdentityHash) &&
    (record.defaultSession === "saved" || record.defaultSession === "temporary") &&
    typeof record.readyConfirmed === "boolean";
}

function isLoadedPersistedState(value: unknown): value is LoadedManagedBrowserProfilePersistedState {
  if (isCurrentPersistedState(value)) return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 3 && record.version === 1 &&
    (record.defaultSession === "saved" || record.defaultSession === "temporary") &&
    typeof record.readyConfirmed === "boolean";
}

function managedBrowserProfileIdentityHash(profileRoot: string, profileLabel: string): string {
  const resolvedRoot = resolve(profileRoot);
  const identity = process.platform === "win32" ? resolvedRoot.toLowerCase() : resolvedRoot;
  return createHash("sha256").update(`managed-browser-profile-v1\u0000${identity}\u0000${profileLabel}`, "utf8").digest("hex");
}

async function inspectManagedBrowserProfileDirectory(
  profileRoot: string,
  profileLabel: string,
): Promise<"present" | "missing" | "unsafe"> {
  let rootInfo;
  try {
    rootInfo = await lstat(profileRoot);
  } catch (error) {
    if (isMissing(error)) return "missing";
    throw error;
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return "unsafe";
  let profileInfo;
  try {
    profileInfo = await lstat(resolve(profileRoot, profileLabel));
  } catch (error) {
    if (isMissing(error)) return "missing";
    throw error;
  }
  if (profileInfo.isSymbolicLink() || !profileInfo.isDirectory()) return "unsafe";
  return "present";
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}
