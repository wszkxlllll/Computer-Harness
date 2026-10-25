import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { ActionId, AssetId, ComputerSessionId, EventId, ObservationId, RunId, RuntimeEvent, SurfaceId } from "@computer-harness/protocol";
import {
  createRunSupervisionControl,
  type RunSupervisionControlSource,
} from "./run-supervision-control.js";

class FakeController {
  public snapshot: Record<string, unknown> = {
    runId: "run-20261018-fixture",
    status: "running",
    latestObservationId: "obs-1",
    stepCount: 0,
  };
  public events: RuntimeEvent[] = [
    {
      schemaVersion: 2,
      runId: "run-20261018-fixture",
      eventId: "event-1",
      sequence: 1,
      occurredAt: "2026-10-18T00:00:00.000Z",
      type: "observation.created",
      observation: {
        id: "obs-1",
        runId: "run-20261018-fixture",
        computerSessionId: "session-1",
        surfaceRef: { surfaceId: "surface-1", generation: 1, kind: "desktop" },
        capturedAt: "2026-10-18T00:00:00.000Z",
        viewport: { width: 800, height: 600, coordinateSpace: "physical" },
        screenshot: { assetId: "asset-1", relativePath: "screenshots/asset-1.png", mediaType: "image/png", byteLength: 3 },
      },
    } as RuntimeEvent,
    {
      schemaVersion: 2,
      runId: "run-20261018-fixture",
      eventId: "event-2",
      sequence: 2,
      occurredAt: "2026-10-18T00:00:01.000Z",
      type: "model.request.started",
      providerId: "fixture",
    } as RuntimeEvent,
  ];
  public submitUserInput = vi.fn(async (text: string): Promise<void> => {
    this.events.push({
      schemaVersion: 2,
      runId: "run-20261018-fixture",
      eventId: `event-${this.events.length + 1}`,
      sequence: this.events.length + 1,
      occurredAt: "2026-10-18T00:00:02.000Z",
      type: "user.input.received",
      text,
    } as RuntimeEvent);
  });
  public cancel = vi.fn((_reason: string): void => undefined);
  public resolveApproval = vi.fn();

  public getSnapshot() {
    return structuredClone(this.snapshot) as never;
  }

  public getEvents() {
    return structuredClone(this.events);
  }

  public getEventsAfter(sequence: number) {
    return structuredClone(this.events.filter((event) => event.sequence > sequence));
  }
}

function sourceWithIpc() {
  const source = new EventEmitter() as EventEmitter & RunSupervisionControlSource;
  const sent: unknown[] = [];
  source.connected = true;
  source.send = (message, callback) => {
    sent.push(structuredClone(message));
    callback?.(null);
    return true;
  };
  return { source, sent };
}

function startMessage(mode: "observe" | "dynamic") {
  return {
    type: "harness.supervision.start",
    packageId: "G01-C-20261018-a1b2c3d4",
    attemptId: "live-2026-10-18T00-00-00.000Z-a1b2c3d4",
    mode,
  };
}

function correctionMessage(patch: Partial<Record<string, unknown>> = {}) {
  return {
    type: "harness.supervision.command",
    commandId: "123e4567-e89b-42d3-a456-426614174000",
    packageId: "G01-C-20261018-a1b2c3d4",
    attemptId: "live-2026-10-18T00-00-00.000Z-a1b2c3d4",
    runId: "run-20261018-fixture",
    command: "correct",
    createdAt: "2026-10-18T00:00:03.000Z",
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    evidenceSequence: 1,
    observationId: "obs-1",
    text: "请重新观察当前画面并继续原任务。",
    ...patch,
  };
}

describe("CLI evaluation supervision IPC", () => {
  it("completes the listener/start handshake and reports committed observations from the injected controller seam", async () => {
    const { source, sent } = sourceWithIpc();
    const control = createRunSupervisionControl(source, "dynamic")!;
    const controller = new FakeController();
    control.attachController(controller as never);
    expect(sent[0]).toMatchObject({ type: "harness.supervision.listener-ready", mode: "dynamic" });
    source.emit("message", startMessage("dynamic"));
    await expect(control.waitForInitialization()).resolves.toBeUndefined();
    expect(sent.at(-1)).toMatchObject({
      type: "harness.supervision.snapshot",
      packageId: "G01-C-20261018-a1b2c3d4",
      attemptId: "live-2026-10-18T00-00-00.000Z-a1b2c3d4",
      runId: "run-20261018-fixture",
      status: "running",
      currentSequence: 2,
      evidenceSequence: 1,
      latestObservation: { id: "obs-1", sequence: 1 },
    });
    control.dispose();
  });

  it("accepts an identified historical observation after later GUI events and consumes each command once", async () => {
    const { source, sent } = sourceWithIpc();
    const control = createRunSupervisionControl(source, "dynamic")!;
    const controller = new FakeController();
    control.attachController(controller as never);
    source.emit("message", startMessage("dynamic"));
    await control.waitForInitialization();

    const laterObservation: Extract<RuntimeEvent, { type: "observation.created" }> = {
      schemaVersion: 2,
      runId: "run-20261018-fixture" as RunId,
      eventId: "event-3" as EventId,
      sequence: 3,
      occurredAt: "2026-10-18T00:00:02.000Z",
      type: "observation.created",
      observation: {
        id: "obs-3" as ObservationId,
        runId: "run-20261018-fixture" as RunId,
        computerSessionId: "session-1" as ComputerSessionId,
        surfaceRef: { surfaceId: "surface-1" as SurfaceId, generation: 2, kind: "desktop" },
        capturedAt: "2026-10-18T00:00:02.000Z",
        viewport: { width: 800, height: 600, coordinateSpace: "physical" },
        screenshot: { assetId: "asset-3" as AssetId, relativePath: "screenshots/asset-3.png", mediaType: "image/png", byteLength: 3 },
      },
    };
    controller.events.push(laterObservation);
    const startedAction: Extract<RuntimeEvent, { type: "action.execution.started" }> = {
      schemaVersion: 2,
      runId: "run-20261018-fixture" as RunId,
      eventId: "event-4" as EventId,
      sequence: 4,
      occurredAt: "2026-10-18T00:00:03.000Z",
      type: "action.execution.started",
      action: { actionId: "action-4" as ActionId, kind: "click", basedOn: laterObservation.observation.id, point: { x: 10, y: 20 } },
    };
    controller.events.push(startedAction);
    controller.snapshot = { ...controller.snapshot, latestObservationId: "obs-3" };
    const firstCommand = correctionMessage();
    source.emit("message", firstCommand);
    source.emit("message", firstCommand);
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.submitUserInput).toHaveBeenCalledOnce();
    expect(controller.submitUserInput).toHaveBeenCalledWith("请重新观察当前画面并继续原任务。");
    expect(sent).toContainEqual(expect.objectContaining({ type: "harness.supervision.receipt", status: "queued" }));
    expect(sent).toContainEqual(expect.objectContaining({
      type: "harness.supervision.receipt",
      status: "consumed",
      reason: "user.input.received",
      eventSequence: 5,
    }));

    source.emit("message", correctionMessage({ commandId: "123e4567-e89b-42d3-a456-426614174008" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.submitUserInput).toHaveBeenCalledTimes(2);
    expect(sent).toContainEqual(expect.objectContaining({ type: "harness.supervision.receipt", status: "consumed", eventSequence: 6 }));
    control.dispose();
  });

  it("rejects a source sequence or observation ID that is not a committed observation in this Run", async () => {
    const { source, sent } = sourceWithIpc();
    const control = createRunSupervisionControl(source, "dynamic")!;
    const controller = new FakeController();
    control.attachController(controller as never);
    source.emit("message", startMessage("dynamic"));
    await control.waitForInitialization();
    controller.events.push({
      schemaVersion: 2,
      runId: "run-20261018-fixture",
      eventId: "event-3",
      sequence: 3,
      occurredAt: "2026-10-18T00:00:02.000Z",
      type: "model.response.received",
      turn: { type: "finish", summary: "fixture" },
    } as RuntimeEvent);
    source.emit("message", correctionMessage({ commandId: "123e4567-e89b-42d3-a456-426614174001" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.submitUserInput).toHaveBeenCalledOnce();

    controller.events.push({
      schemaVersion: 2,
      runId: "run-20261018-fixture" as RunId,
      eventId: "event-5" as EventId,
      sequence: 5,
      occurredAt: "2026-10-18T00:00:04.000Z",
      type: "action.execution.started",
      action: { actionId: "action-5" as ActionId, kind: "wait", durationMs: 1 },
    });
    source.emit("message", correctionMessage({
      commandId: "123e4567-e89b-42d3-a456-426614174002",
      evidenceSequence: 6,
      observationId: "obs-not-committed",
    }));
    await Promise.resolve();
    expect(sent).toContainEqual(expect.objectContaining({
      type: "harness.supervision.receipt",
      status: "rejected",
      reason: "correction-source-observation-not-committed-in-this-run",
    }));
    control.dispose();
  });

  it("rejects corrections in observe-only mode and never converts one to an approval answer", async () => {
    const { source, sent } = sourceWithIpc();
    const control = createRunSupervisionControl(source, "observe")!;
    const controller = new FakeController();
    control.attachController(controller as never);
    source.emit("message", startMessage("observe"));
    await control.waitForInitialization();
    source.emit("message", correctionMessage());
    await Promise.resolve();
    expect(controller.submitUserInput).not.toHaveBeenCalled();
    expect(controller.resolveApproval).not.toHaveBeenCalled();
    expect(sent).toContainEqual(expect.objectContaining({ type: "harness.supervision.receipt", status: "rejected", reason: "observe-only-run" }));

    control.dispose();
    const approvalSetup = sourceWithIpc();
    const approvalControl = createRunSupervisionControl(approvalSetup.source, "dynamic")!;
    const approvalController = new FakeController();
    approvalController.snapshot = { ...approvalController.snapshot, status: "waiting_approval", pendingApproval: { requestId: "approval-1" } };
    approvalControl.attachController(approvalController as never);
    approvalSetup.source.emit("message", startMessage("dynamic"));
    await approvalControl.waitForInitialization();
    approvalSetup.source.emit("message", correctionMessage({ commandId: "123e4567-e89b-42d3-a456-426614174003" }));
    await Promise.resolve();
    expect(approvalController.submitUserInput).not.toHaveBeenCalled();
    expect(approvalController.resolveApproval).not.toHaveBeenCalled();
    expect(approvalSetup.sent).toContainEqual(expect.objectContaining({
      type: "harness.supervision.receipt",
      status: "rejected",
      reason: "approval-pending; correction is not an approval response",
    }));
    approvalControl.dispose();
  });

  it("allows safety cancellation for observe-only runs and does not submit task input", async () => {
    const { source, sent } = sourceWithIpc();
    const control = createRunSupervisionControl(source, "observe")!;
    const controller = new FakeController();
    control.attachController(controller as never);
    source.emit("message", startMessage("observe"));
    await control.waitForInitialization();
    source.emit("message", {
      ...correctionMessage(),
      commandId: "123e4567-e89b-42d3-a456-426614174004",
      command: "cancel",
      evidenceSequence: undefined,
      observationId: undefined,
      text: undefined,
    });
    await Promise.resolve();
    expect(controller.cancel).toHaveBeenCalledWith("safety stop requested by evaluation supervisor");
    expect(controller.submitUserInput).not.toHaveBeenCalled();
    expect(sent).toContainEqual(expect.objectContaining({ type: "harness.supervision.receipt", status: "cancel-requested" }));
    control.dispose();
  });

  it("rejects expired, wrong-run, and terminal commands before touching the inbox", async () => {
    const { source, sent } = sourceWithIpc();
    const control = createRunSupervisionControl(source, "dynamic")!;
    const controller = new FakeController();
    control.attachController(controller as never);
    source.emit("message", startMessage("dynamic"));
    await control.waitForInitialization();
    source.emit("message", correctionMessage({
      commandId: "123e4567-e89b-42d3-a456-426614174005",
      expiresAt: "2020-01-01T00:00:00.000Z",
    }));
    source.emit("message", correctionMessage({
      commandId: "123e4567-e89b-42d3-a456-426614174006",
      runId: "run-from-another-attempt",
    }));
    await Promise.resolve();
    controller.snapshot = { ...controller.snapshot, status: "finished" };
    source.emit("message", correctionMessage({ commandId: "123e4567-e89b-42d3-a456-426614174007" }));
    await Promise.resolve();
    expect(controller.submitUserInput).not.toHaveBeenCalled();
    expect(sent).toContainEqual(expect.objectContaining({ type: "harness.supervision.receipt", status: "expired" }));
    expect(sent).toContainEqual(expect.objectContaining({ type: "harness.supervision.receipt", reason: "run-identity-mismatch" }));
    expect(sent).toContainEqual(expect.objectContaining({ type: "harness.supervision.receipt", reason: "run-terminal" }));
    control.dispose();
  });

  it("reports a diagnostic when the parent fails to complete the start handshake", async () => {
    vi.useFakeTimers();
    const { source } = sourceWithIpc();
    const control = createRunSupervisionControl(source, "dynamic")!;
    const waiting = control.waitForInitialization(25);
    const assertion = expect(waiting).rejects.toThrow(/handshake timed out/u);
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    control.dispose();
    vi.useRealTimers();
  });
});
