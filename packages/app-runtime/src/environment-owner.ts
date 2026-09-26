import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, ftruncateSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ComputerBackendConfig } from "./computers.js";

export type EnvironmentLeaseState = "active" | "pending_cleanup";

export interface EnvironmentLeaseInfo {
  readonly identity: string;
  readonly runId: string;
  readonly state: EnvironmentLeaseState;
  readonly reason?: string;
  readonly ownerProcessId?: number;
}

export interface EnvironmentLease {
  readonly identity: string;
  readonly runId: string;
  readonly state: EnvironmentLeaseState;
  markPending(reason: string): void;
  release(): void;
}

export interface EnvironmentOwner {
  acquire(identity: string, runId: string): EnvironmentLease;
  inspect(identity: string): EnvironmentLeaseInfo | undefined;
}

export interface EnvironmentLeaseRecoveryRequest {
  readonly identity: string;
  readonly expectedRunId: string;
  readonly expectedLeaseHash: string;
  readonly expectedState: EnvironmentLeaseState;
  readonly operator: string;
  readonly inspectionNote: string;
  readonly externalStateInspected: true;
}

export interface EnvironmentLeaseRecoveryResult {
  readonly identity: string;
  readonly runId: string;
  readonly leaseHash: string;
  readonly ownerProcessId: number;
  readonly quarantinePath: string;
  readonly preparedAuditPath: string;
  readonly auditPath: string;
  readonly authorizedAt: string;
}

/** A process-local registry for tests and explicitly isolated environments. */
export class InProcessEnvironmentOwner implements EnvironmentOwner {
  private readonly leases = new Map<string, EnvironmentLeaseInfo>();

  public acquire(identity: string, runId: string): EnvironmentLease {
    const normalizedIdentity = normalizeIdentity(identity);
    const current = this.leases.get(normalizedIdentity);
    if (current !== undefined) {
      throw new Error(`environment ${normalizedIdentity} is owned by run ${current.runId} (${current.state})`);
    }
    this.leases.set(normalizedIdentity, { identity: normalizedIdentity, runId, state: "active" });
    let released = false;
    let state: EnvironmentLeaseState = "active";
    const lease: EnvironmentLease = {
      identity: normalizedIdentity,
      runId,
      get state() { return state; },
      markPending: (message: string) => {
        if (released || state === "pending_cleanup") return;
        const held = this.leases.get(normalizedIdentity);
        if (held?.runId !== runId) return;
        state = "pending_cleanup";
        this.leases.set(normalizedIdentity, { identity: normalizedIdentity, runId, state, reason: message });
      },
      release: () => {
        if (released || state === "pending_cleanup") return;
        released = true;
        const held = this.leases.get(normalizedIdentity);
        if (held?.runId === runId) this.leases.delete(normalizedIdentity);
      },
    };
    return lease;
  }

  public inspect(identity: string): EnvironmentLeaseInfo | undefined {
    const info = this.leases.get(normalizeIdentity(identity));
    return info === undefined ? undefined : { ...info };
  }
}

interface StoredEnvironmentLease {
  readonly version: 1;
  readonly identity: string;
  readonly runId: string;
  readonly state: EnvironmentLeaseState;
  readonly ownerProcessId: number;
  readonly token: string;
  readonly reason?: string;
}

interface StoredEnvironmentOperation {
  readonly version: 1;
  readonly identity: string;
  readonly operation: "acquire" | "recover";
  readonly ownerProcessId: number;
  readonly token: string;
  readonly startedAt: string;
}

interface EnvironmentOperationLockControl {
  preserveOnExit(): void;
}

/**
 * A cross-process lease stored under the current OS user's application state
 * directory. A dead active owner becomes pending_cleanup; it is never silently
 * removed because the previous Run may have left an external action uncertain.
 */
export class ProcessSharedEnvironmentOwner implements EnvironmentOwner {
  private readonly directory: string;

  public constructor(directory = defaultEnvironmentLeaseDirectory()) {
    this.directory = directory;
  }

  public acquire(identity: string, runId: string): EnvironmentLease {
    const normalizedIdentity = normalizeIdentity(identity);
    if (runId.trim().length === 0) throw new Error("Run ID must be non-empty");
    mkdirSync(this.directory, { recursive: true });
    return this.withIdentityOperation(normalizedIdentity, "acquire", () => this.acquireUnderOperation(normalizedIdentity, runId));
  }

  private acquireUnderOperation(normalizedIdentity: string, runId: string): EnvironmentLease {
    const leasePath = this.leasePath(normalizedIdentity);
    const token = randomUUID();
    const record: StoredEnvironmentLease = {
      version: 1,
      identity: normalizedIdentity,
      runId,
      state: "active",
      ownerProcessId: process.pid,
      token,
    };

    let descriptor: number;
    try {
      descriptor = openSync(leasePath, "wx", 0o600);
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      const current = this.readRecord(normalizedIdentity, leasePath);
      if (current === undefined) {
        throw new Error(`environment ${normalizedIdentity} has an unreadable owner lease at ${leasePath}; ownership state is unknown. Preserve this file for manual review; automatic recovery is refused.`);
      }
      const info = current.state === "active" && !isProcessAlive(current.ownerProcessId)
        ? this.markRecordPending(current, leasePath, "The previous owner process exited without confirming desktop cleanup; the external outcome is unknown.")
        : toLeaseInfo(current);
      throw ownerConflict(info, leasePath);
    }

    try {
      writeFileSync(descriptor, JSON.stringify(record), "utf8");
      // Ensure an acquired lease is durable before the caller can construct or
      // start a Run that might contact a physical desktop.
      fsyncSync(descriptor);
    } catch (error) {
      closeSync(descriptor);
      try { unlinkSync(leasePath); } catch { /* acquisition failed before Run creation */ }
      throw error;
    }
    closeSync(descriptor);

    let state: EnvironmentLeaseState = "active";
    let released = false;
    return {
      identity: normalizedIdentity,
      runId,
      get state() { return state; },
      markPending: (reason: string) => {
        if (released || state === "pending_cleanup") return;
        const current = this.readRecord(normalizedIdentity, leasePath);
        if (current?.token !== token) {
          state = "pending_cleanup";
          return;
        }
        const pending: StoredEnvironmentLease = {
          ...current,
          state: "pending_cleanup",
          reason: reason.trim() || "Cleanup was not confirmed.",
        };
        this.writeRecord(leasePath, pending);
        state = "pending_cleanup";
      },
      release: () => {
        if (released || state === "pending_cleanup") return;
        const current = this.readRecord(normalizedIdentity, leasePath);
        if (current?.token !== token || current.state !== "active") {
          throw new Error(`environment ${normalizedIdentity} lease changed before release; preserving the owner barrier at ${leasePath}`);
        }
        unlinkSync(leasePath);
        released = true;
      },
    };
  }

  public inspect(identity: string): EnvironmentLeaseInfo | undefined {
    const normalizedIdentity = normalizeIdentity(identity);
    const operationPath = this.operationPath(normalizedIdentity);
    if (existsSync(operationPath)) {
      const operation = this.readOperation(normalizedIdentity, operationPath);
      return operation === undefined
        ? {
            identity: normalizedIdentity,
            runId: "owner-operation:unknown",
            state: "pending_cleanup",
            reason: `An owner operation marker is unreadable at ${operationPath}; preserve it for manual review.`,
          }
        : {
            identity: normalizedIdentity,
            runId: `owner-operation:${operation.operation}`,
            state: "pending_cleanup",
            reason: `An unfinished ${operation.operation} operation marker exists at ${operationPath} for process ${operation.ownerProcessId}; do not clear it automatically.`,
            ownerProcessId: operation.ownerProcessId,
          };
    }
    const leasePath = this.leasePath(normalizedIdentity);
    if (!existsSync(leasePath)) return undefined;
    const current = this.readRecord(normalizedIdentity, leasePath);
    if (current === undefined) {
      return {
        identity: normalizedIdentity,
        runId: "unknown",
        state: "pending_cleanup",
        reason: `The owner lease is unreadable; ownership state is unknown. Preserve ${leasePath} for manual review; automatic recovery is refused.`,
      };
    }
    if (current.state === "active" && !isProcessAlive(current.ownerProcessId)) {
      return toLeaseInfo({
        ...current,
        state: "pending_cleanup",
        reason: "The previous owner process exited without confirming desktop cleanup; the external outcome is unknown.",
      });
    }
    return toLeaseInfo(current);
  }

  /**
   * Explicitly quarantine a reviewed physical-desktop lease. An active lease
   * is eligible only when its recorded owner process is gone and the caller
   * provides the exact lease hash and Run ID, an operator and inspection note,
   * and an explicit external-state inspection attestation.
   */
  public recoverLease(request: EnvironmentLeaseRecoveryRequest): EnvironmentLeaseRecoveryResult {
    const normalizedIdentity = normalizeIdentity(request.identity);
    if (!normalizedIdentity.startsWith("cua-local-physical-desktop:")) {
      throw new Error("only a physical CUA desktop lease can be recovered with this operation");
    }
    if (request.expectedState !== "active" && request.expectedState !== "pending_cleanup") {
      throw new Error("expectedState must be active or pending_cleanup");
    }
    if (request.externalStateInspected !== true) throw new Error("external desktop state must be explicitly inspected before recovery");
    const operator = request.operator.trim();
    const inspectionNote = request.inspectionNote.trim();
    if (operator.length === 0 || operator.length > 200) throw new Error("operator must contain 1-200 characters");
    if (inspectionNote.length === 0 || inspectionNote.length > 2000) throw new Error("inspectionNote must contain 1-2000 characters");
    if (request.expectedRunId.trim().length === 0) throw new Error("expectedRunId must be non-empty");

    const leaseHash = environmentLeaseHash(normalizedIdentity);
    if (!/^[a-f0-9]{64}$/u.test(request.expectedLeaseHash) || request.expectedLeaseHash !== leaseHash) {
      throw new Error("expectedLeaseHash does not match the SHA-256 hash of the normalized desktop identity");
    }
    mkdirSync(this.directory, { recursive: true });
    return this.withIdentityOperation(normalizedIdentity, "recover", (operationLock) => this.recoverUnderOperation({
      request,
      identity: normalizedIdentity,
      leaseHash,
      operator,
      inspectionNote,
      operationLock,
    }));
  }

  private recoverUnderOperation(options: {
    request: EnvironmentLeaseRecoveryRequest;
    identity: string;
    leaseHash: string;
    operator: string;
    inspectionNote: string;
    operationLock: EnvironmentOperationLockControl;
  }): EnvironmentLeaseRecoveryResult {
    const { request, identity, leaseHash, operator, inspectionNote, operationLock } = options;
    const leasePath = this.leasePath(identity);
    const current = this.readRecord(identity, leasePath);
    if (current === undefined) throw new Error(`no readable owner lease exists at ${leasePath}`);
    if (current.identity !== identity || current.runId !== request.expectedRunId || current.state !== request.expectedState) {
      throw new Error(`owner lease does not match the expected identity, Run ID, and state at ${leasePath}`);
    }
    if (isProcessAlive(current.ownerProcessId)) {
      throw new Error(`owner process ${current.ownerProcessId} is still alive; refusing to recover ${leasePath}`);
    }

    const recoveryId = randomUUID();
    const authorizedAt = new Date().toISOString();
    const quarantinePath = join(this.directory, `${leaseHash}.quarantine.${recoveryId}.json`);
    const preparedAuditPath = join(this.directory, `${leaseHash}.recovery.${recoveryId}.prepared.json`);
    const auditPath = join(this.directory, `${leaseHash}.recovery.${recoveryId}.committed.json`);
    const preparedAudit = {
      version: 1,
      action: "quarantine_physical_environment_lease" as const,
      status: "prepared" as const,
      recoveryId,
      identity,
      leaseHash,
      expectedRunId: request.expectedRunId,
      expectedState: request.expectedState,
      priorOwnerProcessId: current.ownerProcessId,
      operator,
      inspectionNote,
      externalStateInspected: true as const,
      authorizedAt,
      quarantineFile: basename(quarantinePath),
    };
    writeNewFileAtomically(preparedAuditPath, `${JSON.stringify(preparedAudit)}\n`);

    const latest = this.readRecord(identity, leasePath);
    if (latest?.token !== current.token || latest.runId !== request.expectedRunId || latest.state !== request.expectedState || isProcessAlive(latest.ownerProcessId)) {
      throw new Error(`owner lease changed or became active during recovery; preserving ${leasePath}`);
    }
    renameSync(leasePath, quarantinePath);
    try {
      writeNewFileAtomically(auditPath, `${JSON.stringify({ ...preparedAudit, status: "committed", quarantinedAt: new Date().toISOString() })}\n`);
    } catch (error) {
      try {
        if (existsSync(leasePath)) throw new Error(`a lease appeared at ${leasePath} while the recovery operation lock was held`);
        renameSync(quarantinePath, leasePath);
      } catch (rollbackError) {
        operationLock.preserveOnExit();
        throw new AggregateError(
          [error, rollbackError],
          `Recovery audit commit failed and the prior lease could not be restored. The operation marker remains at ${this.operationPath(identity)}; inspect ${quarantinePath} and ${preparedAuditPath}.`,
        );
      }
      throw error;
    }
    return {
      identity,
      runId: current.runId,
      leaseHash,
      ownerProcessId: current.ownerProcessId,
      quarantinePath,
      preparedAuditPath,
      auditPath,
      authorizedAt,
    };
  }

  private leasePath(identity: string): string {
    const key = environmentLeaseHash(identity);
    return join(this.directory, `${key}.json`);
  }

  private operationPath(identity: string): string {
    const key = environmentLeaseHash(identity);
    return join(this.directory, `${key}.operation.json`);
  }

  private withIdentityOperation<T>(
    identity: string,
    operation: StoredEnvironmentOperation["operation"],
    action: (control: EnvironmentOperationLockControl) => T,
  ): T {
    const operationPath = this.operationPath(identity);
    const token = randomUUID();
    let descriptor: number;
    try {
      descriptor = openSync(operationPath, "wx", 0o600);
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      const current = this.readOperation(identity, operationPath);
      const owner = current === undefined
        ? "its contents are unreadable"
        : `it records ${current.operation} by process ${current.ownerProcessId}`;
      throw new Error(`environment ${identity} has an unfinished owner operation marker at ${operationPath}; ${owner}. Preserve it for manual review; no stale-PID auto-release is performed.`);
    }

    const record: StoredEnvironmentOperation = {
      version: 1,
      identity,
      operation,
      ownerProcessId: process.pid,
      token,
      startedAt: new Date().toISOString(),
    };
    try {
      writeFileSync(descriptor, JSON.stringify(record), "utf8");
      fsyncSync(descriptor);
    } catch (error) {
      closeSync(descriptor);
      try { unlinkSync(operationPath); } catch { /* lease mutation has not started */ }
      throw error;
    }
    closeSync(descriptor);

    let preserve = false;
    try {
      return action({ preserveOnExit: () => { preserve = true; } });
    } finally {
      if (!preserve) {
        const current = this.readOperation(identity, operationPath);
        if (current?.token !== token) {
          throw new Error(`environment ${identity} owner operation marker changed; preserving ${operationPath}`);
        }
        unlinkSync(operationPath);
      }
    }
  }

  private readOperation(identity: string, operationPath: string): StoredEnvironmentOperation | undefined {
    let raw: string;
    try {
      raw = readFileSync(operationPath, "utf8");
    } catch {
      return undefined;
    }
    try {
      const value: unknown = JSON.parse(raw);
      if (typeof value !== "object" || value === null) return undefined;
      const candidate = value as Partial<StoredEnvironmentOperation>;
      if (candidate.version !== 1 || candidate.identity !== identity ||
        (candidate.operation !== "acquire" && candidate.operation !== "recover") ||
        !Number.isSafeInteger(candidate.ownerProcessId) || typeof candidate.token !== "string" || candidate.token.length === 0 ||
        typeof candidate.startedAt !== "string") return undefined;
      return candidate as StoredEnvironmentOperation;
    } catch {
      return undefined;
    }
  }

  private readRecord(identity: string, leasePath: string): StoredEnvironmentLease | undefined {
    let raw: string;
    try {
      raw = readFileSync(leasePath, "utf8");
    } catch {
      return undefined;
    }
    try {
      const value: unknown = JSON.parse(raw);
      if (typeof value !== "object" || value === null) return undefined;
      const candidate = value as Partial<StoredEnvironmentLease>;
      if (candidate.version !== 1 || candidate.identity !== identity || typeof candidate.runId !== "string" ||
        (candidate.state !== "active" && candidate.state !== "pending_cleanup") ||
        !Number.isSafeInteger(candidate.ownerProcessId) || typeof candidate.token !== "string" || candidate.token.length === 0 ||
        (candidate.reason !== undefined && typeof candidate.reason !== "string")) return undefined;
      return candidate as StoredEnvironmentLease;
    } catch {
      return undefined;
    }
  }

  private writeRecord(leasePath: string, record: StoredEnvironmentLease): void {
    const descriptor = openSync(leasePath, "r+");
    try {
      ftruncateSync(descriptor, 0);
      writeFileSync(descriptor, JSON.stringify(record), "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }

  private markRecordPending(record: StoredEnvironmentLease, leasePath: string, reason: string): EnvironmentLeaseInfo {
    const current = this.readRecord(record.identity, leasePath);
    if (current?.token !== record.token) return toLeaseInfo(record);
    const pending: StoredEnvironmentLease = { ...current, state: "pending_cleanup", reason };
    this.writeRecord(leasePath, pending);
    return toLeaseInfo(pending);
  }
}

/** Route only physical CUA desktops through the cross-process lease. */
class DefaultEnvironmentOwner implements EnvironmentOwner {
  private readonly local = new InProcessEnvironmentOwner();
  private readonly shared: ProcessSharedEnvironmentOwner;

  public constructor(sharedDirectory?: string) {
    this.shared = sharedDirectory === undefined
      ? new ProcessSharedEnvironmentOwner()
      : new ProcessSharedEnvironmentOwner(sharedDirectory);
  }

  public acquire(identity: string, runId: string): EnvironmentLease {
    return this.isPhysicalDesktop(identity)
      ? this.shared.acquire(identity, runId)
      : this.local.acquire(identity, runId);
  }

  public inspect(identity: string): EnvironmentLeaseInfo | undefined {
    return this.isPhysicalDesktop(identity)
      ? this.shared.inspect(identity)
      : this.local.inspect(identity);
  }

  private isPhysicalDesktop(identity: string): boolean {
    return normalizeIdentity(identity).startsWith("cua-local-physical-desktop:");
  }
}

export const inProcessEnvironmentOwner = new InProcessEnvironmentOwner();
export const defaultEnvironmentOwner: EnvironmentOwner = new DefaultEnvironmentOwner();

export function createInProcessEnvironmentOwner(): InProcessEnvironmentOwner {
  return new InProcessEnvironmentOwner();
}

export function createDefaultEnvironmentOwner(sharedDirectory?: string): EnvironmentOwner {
  return new DefaultEnvironmentOwner(sharedDirectory);
}

/** Derive a conservative, stable identity from the backend route. */
export function environmentIdentityForConfig(config: ComputerBackendConfig): string {
  if (config.kind === "external") return `external-computer:${config.id}`;
  if (config.kind === "cua") {
    // CUA foreground input is attached to the local physical desktop. Its
    // named pipe is only a transport route, so changing the pipe cannot hand
    // the same desktop to a second Run. A separate backend/VM identity is not
    // available at this application boundary and is conservatively blocked.
    return `cua-local-physical-desktop:${process.platform}`;
  }
  return osworldRouteIdentity(config.bridgeUrl);
}

function defaultEnvironmentLeaseDirectory(): string {
  const root = process.platform === "win32"
    ? process.env.LOCALAPPDATA || homedir()
    : homedir();
  const folder = process.platform === "darwin"
    ? join("Library", "Application Support", "ComputerHarness", "environment-leases")
    : process.platform === "win32"
      ? join("ComputerHarness", "environment-leases")
      : join(".local", "state", "computer-harness", "environment-leases");
  return join(root, folder);
}

export function environmentLeaseHash(identity: string): string {
  return createHash("sha256").update(normalizeIdentity(identity), "utf8").digest("hex");
}

function osworldRouteIdentity(bridgeUrl: string): string {
  try {
    const url = new URL(bridgeUrl);
    return `osworld-bridge:${url.protocol}//${url.host}${url.pathname.replace(/\/+$/u, "") || "/"}`;
  } catch {
    return `osworld-bridge:${bridgeUrl.trim().replace(/\/+$/u, "")}`;
  }
}

function normalizeIdentity(identity: string): string {
  const normalized = identity.trim();
  if (normalized.length === 0) throw new Error("environment identity must be non-empty");
  return normalized;
}

function toLeaseInfo(record: StoredEnvironmentLease): EnvironmentLeaseInfo {
  return {
    identity: record.identity,
    runId: record.runId,
    state: record.state,
    ...(record.reason === undefined ? {} : { reason: record.reason }),
    ownerProcessId: record.ownerProcessId,
  };
}

function ownerConflict(info: EnvironmentLeaseInfo, leasePath: string): Error {
  const explanation = info.state === "pending_cleanup"
    ? `; cleanup is unconfirmed${info.reason === undefined ? "" : `: ${info.reason}`}. Inspect the desktop and prior Run evidence; only after reconciling unknown side effects use the explicit recovery command with Run ID '${info.runId}' and lease hash '${environmentLeaseHash(info.identity)}'. Preserved lease: ${leasePath}`
    : "";
  return new Error(`environment ${info.identity} is owned by run ${info.runId} (${info.state})${explanation}`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is not signalable. Only ESRCH proves
    // it is gone, and even then the lease is retained as pending_cleanup.
    return !isNodeError(error, "ESRCH");
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function writeNewFileAtomically(targetPath: string, contents: string): void {
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporaryPath, "wx", 0o600);
  try {
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
  } catch (error) {
    closeSync(descriptor);
    try { unlinkSync(temporaryPath); } catch { /* preserve the primary failure */ }
    throw error;
  }
  closeSync(descriptor);
  try {
    renameSync(temporaryPath, targetPath);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch { /* preserve the primary failure */ }
    throw error;
  }
}
