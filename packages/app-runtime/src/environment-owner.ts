import type { ComputerBackendConfig } from "./computers.js";

export type EnvironmentLeaseState = "active" | "pending_cleanup";

export interface EnvironmentLeaseInfo {
  readonly identity: string;
  readonly runId: string;
  readonly state: EnvironmentLeaseState;
  readonly reason?: string;
}

export interface EnvironmentLease {
  readonly identity: string;
  readonly runId: string;
  readonly state: EnvironmentLeaseState;
  markPending(reason: string): void;
  release(): void;
}

/**
 * A process-local owner registry. It is intentionally not a cross-process
 * lock: DEV-6 must add a persistent host/daemon owner before making that
 * claim. Different route identities remain independently usable.
 */
export class InProcessEnvironmentOwner {
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
    let reason: string | undefined;
    const lease: EnvironmentLease = {
      identity: normalizedIdentity,
      runId,
      get state() { return state; },
      markPending: (message: string) => {
        if (released) return;
        const held = this.leases.get(normalizedIdentity);
        if (held?.runId !== runId) return;
        state = "pending_cleanup";
        reason = message;
        this.leases.set(normalizedIdentity, { identity: normalizedIdentity, runId, state, reason });
      },
      release: () => {
        if (released) return;
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

export const inProcessEnvironmentOwner = new InProcessEnvironmentOwner();

export function createInProcessEnvironmentOwner(): InProcessEnvironmentOwner {
  return new InProcessEnvironmentOwner();
}

/** Derive a conservative, stable process-local identity from the backend route. */
export function environmentIdentityForConfig(config: ComputerBackendConfig): string {
  if (config.kind === "cua") {
    // CUA foreground input is attached to the local physical desktop. Its
    // named pipe is only a transport route, so changing the pipe cannot hand
    // the same desktop to a second Run. A separate backend/VM identity is not
    // available at this application boundary and is conservatively blocked.
    return `cua-local-physical-desktop:${process.platform}`;
  }
  return osworldRouteIdentity(config.bridgeUrl);
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
