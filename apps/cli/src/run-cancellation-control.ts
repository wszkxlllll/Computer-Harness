import type { EventEmitter } from "node:events";

export interface HarnessCancellationMessage {
  type: "harness.cancel";
  reason: "run-timeout";
}

export interface RunCancellationControlSource extends EventEmitter {
  send?: unknown;
  connected?: boolean;
  disconnect?: () => void;
}

export function isHarnessCancellationMessage(message: unknown): message is HarnessCancellationMessage {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return false;
  const candidate = message as Record<string, unknown>;
  const keys = Reflect.ownKeys(candidate);
  return keys.length === 2
    && keys.includes("type")
    && keys.includes("reason")
    && candidate.type === "harness.cancel"
    && candidate.reason === "run-timeout";
}

export class RunCancellationControl {
  private readonly onSigint = (): void => this.request("SIGINT");
  private readonly onMessage = (message: unknown): void => {
    if (isHarnessCancellationMessage(message)) this.request("cancelled by harness parent after run timeout");
  };
  private cancelController: ((reason: string) => void) | undefined;
  private pendingReason: string | undefined;
  private requestReceived = false;
  private controllerStarted = false;
  private disposed = false;

  public constructor(private readonly source: RunCancellationControlSource) {
    if (typeof source.send !== "function") {
      throw new Error("run cancellation control requires a Node.js IPC channel");
    }
    source.on("SIGINT", this.onSigint);
    source.on("message", this.onMessage);
  }

  public bindCancelController(cancelController: (reason: string) => void): void {
    this.cancelController = cancelController;
    this.applyPendingCancellation();
  }

  public markControllerStarted(): void {
    this.controllerStarted = true;
    this.applyPendingCancellation();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.source.removeListener("SIGINT", this.onSigint);
    this.source.removeListener("message", this.onMessage);
    if (this.source.connected === true) {
      try {
        this.source.disconnect?.();
      } catch {
        // Process shutdown can race a parent-side IPC disconnect.
      }
    }
    this.cancelController = undefined;
    this.pendingReason = undefined;
  }

  private request(reason: string): void {
    if (this.disposed || this.requestReceived) return;
    this.requestReceived = true;
    this.pendingReason = reason;
    this.applyPendingCancellation();
  }

  private applyPendingCancellation(): void {
    if (this.disposed || !this.controllerStarted || this.pendingReason === undefined || this.cancelController === undefined) return;
    const reason = this.pendingReason;
    this.pendingReason = undefined;
    try {
      this.cancelController(reason);
    } catch {
      // Ignore repeated or late cancellation after the Run has finished.
    }
  }
}

export function createRunCancellationControl(source: RunCancellationControlSource): RunCancellationControl | undefined {
  if (typeof source.send !== "function") return undefined;
  return new RunCancellationControl(source);
}
