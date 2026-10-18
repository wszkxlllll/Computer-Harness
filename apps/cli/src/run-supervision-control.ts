import type { EventEmitter } from "node:events";
import type { RunController } from "@computer-harness/runtime";
import type { ObservationId, RuntimeEvent } from "@computer-harness/protocol";

export type CliSupervisionMode = "observe" | "dynamic";

export interface RunSupervisionControlSource extends EventEmitter {
  send?: (message: unknown, callback?: (error: Error | null) => void) => boolean;
  connected?: boolean;
}

interface SupervisionStartMessage {
  type: "harness.supervision.start";
  packageId: string;
  attemptId: string;
  mode: CliSupervisionMode;
}

interface SupervisionCommandMessage {
  type: "harness.supervision.command";
  commandId: string;
  packageId: string;
  attemptId: string;
  runId: string;
  command: "correct" | "cancel";
  createdAt: string;
  expiresAt: string;
  /** Sequence of the committed observation used as feedback source, not the current GUI evidence cursor. */
  evidenceSequence?: number;
  observationId?: string;
  text?: string;
}

interface SupervisionContext {
  readonly packageId: string;
  readonly attemptId: string;
}

interface SupervisionSnapshot {
  readonly runId: string;
  readonly status: string;
  readonly currentSequence: number;
  readonly evidenceSequence: number;
  readonly evidenceFresh: boolean;
  readonly latestObservation?: {
    readonly id: ObservationId;
    readonly sequence: number;
    readonly capturedAt: string;
    readonly screenshot: {
      readonly assetId: string;
      readonly relativePath: string;
      readonly mediaType: string;
      readonly byteLength: number;
    };
  };
  readonly pendingApprovalRequestId?: string;
  readonly pendingUserInputRequestId?: string;
  readonly terminal: boolean;
}

const COMMAND_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PACKAGE_ID_PATTERN = /^[A-Za-z0-9._-]{1,160}$/u;
const ATTEMPT_ID_PATTERN = /^live-[A-Za-z0-9._-]{1,96}$/u;
const MAX_CORRECTION_CHARACTERS = 4_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCliSupervisionMode(value: unknown): value is CliSupervisionMode {
  return value === "observe" || value === "dynamic";
}

function isStartMessage(value: unknown): value is SupervisionStartMessage {
  if (!isRecord(value)) return false;
  return value.type === "harness.supervision.start"
    && typeof value.packageId === "string"
    && PACKAGE_ID_PATTERN.test(value.packageId)
    && typeof value.attemptId === "string"
    && ATTEMPT_ID_PATTERN.test(value.attemptId)
    && isCliSupervisionMode(value.mode);
}

function isCommandMessage(value: unknown): value is SupervisionCommandMessage {
  if (!isRecord(value)) return false;
  if (value.type !== "harness.supervision.command"
      || typeof value.commandId !== "string"
      || !COMMAND_ID_PATTERN.test(value.commandId)
      || typeof value.packageId !== "string"
      || !PACKAGE_ID_PATTERN.test(value.packageId)
      || typeof value.attemptId !== "string"
      || !ATTEMPT_ID_PATTERN.test(value.attemptId)
      || typeof value.runId !== "string"
      || value.runId.length < 1
      || (value.command !== "correct" && value.command !== "cancel")
      || typeof value.createdAt !== "string"
      || !Number.isFinite(Date.parse(value.createdAt))
      || typeof value.expiresAt !== "string"
      || !Number.isFinite(Date.parse(value.expiresAt))) return false;
  if (value.evidenceSequence !== undefined
      && (typeof value.evidenceSequence !== "number" || !Number.isSafeInteger(value.evidenceSequence) || value.evidenceSequence < 1)) return false;
  if (value.observationId !== undefined && (typeof value.observationId !== "string" || value.observationId.length === 0)) return false;
  if (value.text !== undefined && typeof value.text !== "string") return false;
  return value.command === "cancel"
    || (Number.isSafeInteger(value.evidenceSequence) && typeof value.observationId === "string" && typeof value.text === "string");
}

export class RunSupervisionControl {
  private readonly onMessage = (message: unknown): void => {
    if (isStartMessage(message)) {
      if (message.mode !== this.expectedMode) {
        this.rejectStart?.(new Error("parent supervision mode does not match the child opt-in"));
        return;
      }
      if (this.context !== undefined && (this.context.packageId !== message.packageId || this.context.attemptId !== message.attemptId)) {
        this.rejectStart?.(new Error("parent attempted to rebind supervision to a different package or attempt"));
        return;
      }
      this.context = { packageId: message.packageId, attemptId: message.attemptId };
      this.mode = message.mode;
      this.startAccepted = true;
      clearInterval(this.readyRetryTimer);
      this.resolveStart?.();
      this.resolveStart = undefined;
      this.rejectStart = undefined;
      this.send({
        type: "harness.supervision.initialized",
        ...this.context,
        mode: message.mode,
      });
      if (this.controller !== undefined) this.reportSnapshot();
      return;
    }
    if (isCommandMessage(message)) void this.handleCommand(message);
  };

  private controller: RunController | undefined;
  private context: SupervisionContext | undefined;
  private mode: CliSupervisionMode | undefined;
  private readonly processedCommandIds = new Set<string>();
  private readonly pendingCorrectionIds = new Set<string>();
  private disposed = false;
  private lastSnapshotKey: string | undefined;
  private lastScannedSequence = -1;
  private currentSequence = 0;
  private evidenceSequence = 0;
  private latestObservation: SupervisionSnapshot["latestObservation"];
  private resolveStart: (() => void) | undefined;
  private rejectStart: ((error: Error) => void) | undefined;
  private readonly startPromise: Promise<void>;
  private readonly readyRetryTimer: ReturnType<typeof setInterval>;
  private startAccepted = false;

  public constructor(
    private readonly source: RunSupervisionControlSource,
    private readonly expectedMode: CliSupervisionMode,
  ) {
    if (typeof source.send !== "function") {
      throw new Error("Run supervision requires a Node.js IPC channel");
    }
    source.on("message", this.onMessage);
    this.startPromise = new Promise<void>((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
    });
    void this.startPromise.catch(() => undefined);
    this.sendListenerReady();
    this.readyRetryTimer = setInterval(() => {
      if (!this.startAccepted) this.sendListenerReady();
    }, 250);
  }

  public async waitForInitialization(timeoutMs = 5_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.startPromise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("evaluation supervision handshake timed out before the Run started")), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  public attachController(controller: RunController): void {
    this.controller = controller;
    this.reportSnapshot();
  }

  public reportSnapshot(): void {
    const context = this.context;
    const controller = this.controller;
    const mode = this.mode;
    if (this.disposed || context === undefined || controller === undefined || mode === undefined) return;
    const snapshot = this.snapshotController(controller);
    const snapshotKey = JSON.stringify({
      runId: snapshot.runId,
      status: snapshot.status,
      currentSequence: snapshot.currentSequence,
      evidenceSequence: snapshot.evidenceSequence,
      evidenceFresh: snapshot.evidenceFresh,
      observationId: snapshot.latestObservation?.id,
      pendingApprovalRequestId: snapshot.pendingApprovalRequestId,
      pendingUserInputRequestId: snapshot.pendingUserInputRequestId,
      terminal: snapshot.terminal,
    });
    if (snapshotKey === this.lastSnapshotKey) return;
    this.lastSnapshotKey = snapshotKey;
    this.send({
      type: "harness.supervision.snapshot",
      ...context,
      mode,
      ...snapshot,
      updatedAt: new Date().toISOString(),
    });
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.readyRetryTimer);
    this.source.removeListener("message", this.onMessage);
    this.controller = undefined;
    this.context = undefined;
    this.pendingCorrectionIds.clear();
    this.rejectStart?.(new Error("evaluation supervision was disposed before the Run started"));
    this.resolveStart = undefined;
    this.rejectStart = undefined;
  }

  private async handleCommand(message: SupervisionCommandMessage): Promise<void> {
    if (this.disposed || this.processedCommandIds.has(message.commandId)) return;
    this.processedCommandIds.add(message.commandId);
    const context = this.context;
    const controller = this.controller;
    if (context === undefined || controller === undefined) {
      this.receipt(message, "rejected", "run-not-ready");
      return;
    }
    if (message.packageId !== context.packageId || message.attemptId !== context.attemptId || message.runId !== controller.getSnapshot().runId) {
      this.receipt(message, "rejected", "run-identity-mismatch");
      return;
    }
    if (Date.parse(message.expiresAt) <= Date.now()) {
      this.receipt(message, "expired", "command-expired-before-runtime-inbox");
      return;
    }
    const snapshot = controller.getSnapshot();
    if (snapshot.status === "finished") {
      this.receipt(message, "rejected", "run-terminal");
      return;
    }
    if (message.command === "cancel") {
      if (snapshot.status === "created") {
        this.receipt(message, "rejected", "run-not-ready; controller has not started");
        return;
      }
      try {
        controller.cancel("safety stop requested by evaluation supervisor");
        this.receipt(message, "cancel-requested", "safety-stop; not a task correction");
      } catch (error) {
        this.receipt(message, "rejected", error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (this.mode !== "dynamic") {
      this.receipt(message, "rejected", "observe-only-run");
      return;
    }
    if (snapshot.status === "waiting_approval" || snapshot.pendingApproval !== undefined) {
      this.receipt(message, "rejected", "approval-pending; correction is not an approval response");
      return;
    }
    if (snapshot.status !== "running" && snapshot.status !== "paused" && snapshot.status !== "waiting_user") {
      this.receipt(message, "rejected", `run-status-does-not-accept-correction:${snapshot.status}`);
      return;
    }
    if ([...this.pendingCorrectionIds].length > 0) {
      this.receipt(message, "rejected", "another-correction-is-still-pending");
      return;
    }
    const current = this.snapshotController(controller);
    const sourceObservation = controller.getEventsAfter(-1).find((event) =>
      event.runId === current.runId
        && event.sequence === message.evidenceSequence
        && event.type === "observation.created"
        && event.observation.id === message.observationId);
    if (sourceObservation === undefined) {
      this.receipt(message, "rejected", "correction-source-observation-not-committed-in-this-run");
      return;
    }
    const text = message.text ?? "";
    if (text.trim().length === 0 || [...text].length > MAX_CORRECTION_CHARACTERS || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text)) {
      this.receipt(message, "rejected", `correction-text-must-be-1-${MAX_CORRECTION_CHARACTERS}-characters-without-control-bytes`);
      return;
    }
    const beforeSequence = current.currentSequence;
    let accepted: Promise<void>;
    try {
      accepted = controller.submitUserInput(text);
    } catch (error) {
      this.receipt(message, "rejected", error instanceof Error ? error.message : String(error));
      return;
    }
    this.pendingCorrectionIds.add(message.commandId);
    this.receipt(message, "queued", "accepted-by-RunController-inbox");
    void accepted.then(() => {
      const consumedEvent = controller.getEventsAfter(beforeSequence).find((event) =>
        event.sequence > beforeSequence && event.type === "user.input.received" && event.text === text);
      if (consumedEvent === undefined) {
        this.receipt(message, "failed", "controller-accepted-input-without-user.input.received-evidence");
      } else {
        this.receipt(message, "consumed", "user.input.received", consumedEvent.sequence);
      }
      this.pendingCorrectionIds.delete(message.commandId);
      this.reportSnapshot();
    }, (error: unknown) => {
      this.pendingCorrectionIds.delete(message.commandId);
      this.receipt(message, "failed", error instanceof Error ? error.message : String(error));
      this.reportSnapshot();
    });
  }

  private receipt(
    message: SupervisionCommandMessage,
    status: "rejected" | "expired" | "queued" | "consumed" | "failed" | "cancel-requested",
    reason: string,
    eventSequence?: number,
  ): void {
    const context = this.context;
    this.send({
      type: "harness.supervision.receipt",
      commandId: message.commandId,
      packageId: context?.packageId ?? message.packageId,
      attemptId: context?.attemptId ?? message.attemptId,
      runId: this.controller?.getSnapshot().runId ?? message.runId,
      command: message.command,
      status,
      reason,
      at: new Date().toISOString(),
      ...(eventSequence === undefined ? {} : { eventSequence }),
    });
  }

  private send(message: unknown): void {
    try {
      if (this.source.connected === false) return;
      this.source.send?.(message, (error) => {
        if (error) this.reportDiagnostic(`could not send supervision IPC message: ${error.message}`);
      });
    } catch (error) {
      this.reportDiagnostic(`could not send supervision IPC message: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private reportDiagnostic(message: string): void {
    process.stderr.write(`Run supervision: ${message}\n`);
  }

  private sendListenerReady(): void {
    this.send({ type: "harness.supervision.listener-ready", mode: this.expectedMode });
  }

  private snapshotController(controller: RunController): SupervisionSnapshot {
    const events = controller.getEventsAfter(this.lastScannedSequence);
    for (const event of events) {
      if (event.sequence <= this.lastScannedSequence) continue;
      this.lastScannedSequence = event.sequence;
      this.currentSequence = event.sequence;
      if (event.type === "observation.created") {
        this.evidenceSequence = event.sequence;
        this.latestObservation = {
          id: event.observation.id,
          sequence: event.sequence,
          capturedAt: event.observation.capturedAt,
          screenshot: {
            assetId: event.observation.screenshot.assetId,
            relativePath: event.observation.screenshot.relativePath,
            mediaType: event.observation.screenshot.mediaType,
            byteLength: event.observation.screenshot.byteLength,
          },
        };
      } else if (isGuiEvidenceEvent(event)) {
        this.evidenceSequence = event.sequence;
      }
    }
    const snapshot = controller.getSnapshot();
    if (snapshot.latestObservationId !== this.latestObservation?.id) this.latestObservation = undefined;
    return {
      runId: snapshot.runId,
      status: snapshot.status,
      currentSequence: this.currentSequence,
      evidenceSequence: this.evidenceSequence,
      evidenceFresh: this.latestObservation !== undefined && this.evidenceSequence === this.latestObservation.sequence,
      ...(this.latestObservation === undefined ? {} : { latestObservation: this.latestObservation }),
      ...(snapshot.pendingApproval === undefined ? {} : { pendingApprovalRequestId: snapshot.pendingApproval.requestId }),
      ...(snapshot.pendingUserInputRequestId === undefined ? {} : { pendingUserInputRequestId: snapshot.pendingUserInputRequestId }),
      terminal: snapshot.status === "finished",
    };
  }
}

export function createRunSupervisionControl(
  source: RunSupervisionControlSource,
  mode: CliSupervisionMode | undefined,
): RunSupervisionControl | undefined {
  if (mode === undefined) return undefined;
  return new RunSupervisionControl(source, mode);
}

export function isGuiEvidenceEvent(event: RuntimeEvent): boolean {
  return event.type === "observation.created"
    || event.type === "computer.surface.transitioned"
    || event.type === "action.execution.started"
    || event.type === "action.execution.completed"
    || event.type === "action.execution.failed"
    || event.type === "computer.window.handoff.completed"
    || event.type === "computer.window.handoff.ignored";
}
