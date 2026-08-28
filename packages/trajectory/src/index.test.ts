import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  ActionId,
  AssetId,
  ComputerSessionId,
  EventId,
  ObservationId,
  RunId,
  RuntimeEvent,
  RuntimeEventData,
} from "@computer-harness/protocol";
import {
  FileAssetStore,
  JsonlRunEventWriter,
  initialRunSnapshot,
  readRuntimeEvents,
  reduceRunEvent,
  reduceRuntimeEvents,
} from "./index.js";

const runId = "run-test" as RunId;
const observationId = "observation-test" as ObservationId;
const actionId = "action-test" as ActionId;

function event(sequence: number, data: RuntimeEventData): RuntimeEvent {
  return {
    eventId: `event-${sequence}` as EventId,
    runId,
    sequence,
    occurredAt: `2026-01-01T00:00:0${sequence}.000Z`,
    ...data,
  };
}

function waitStarted(sequence = 0): RuntimeEvent {
  return event(sequence, {
    type: "action.execution.started",
    action: { actionId, kind: "wait", durationMs: 10 },
  });
}

function waitCompleted(sequence = 1): RuntimeEvent {
  return event(sequence, {
    type: "action.execution.completed",
    receipt: {
      actionId,
      status: "completed",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:00.010Z",
      durationMs: 10,
    },
  });
}

describe("RunSnapshot reducer", () => {
  it("is deterministic and leaves an unresolved side effect visible", () => {
    const events: RuntimeEvent[] = [
      event(0, { type: "run.created", goal: "test" }),
      waitStarted(1),
    ];

    const first = events.reduce(reduceRunEvent, initialRunSnapshot(runId));
    const second = events.reduce(reduceRunEvent, initialRunSnapshot(runId));
    expect(first).toEqual(second);
    expect(first.unresolvedActionId).toBe(actionId);
  });

  it("records the latest observation", () => {
    const observed = reduceRunEvent(
      initialRunSnapshot(runId),
      event(0, {
        type: "observation.created",
        observation: {
          id: observationId,
          runId,
          computerSessionId: "computer-test" as ComputerSessionId,
          capturedAt: "2026-01-01T00:00:00.000Z",
          viewport: { width: 100, height: 100, coordinateSpace: "physical" },
          screenshot: {
            assetId: "asset-test" as AssetId,
            relativePath: "assets/one.png",
            mediaType: "image/png",
            byteLength: 1,
          },
        },
      }),
    );
    expect(observed.latestObservationId).toBe(observationId);
  });

  it.each([
    ["completed", waitCompleted(1)],
    [
      "failed",
      event(1, {
        type: "action.execution.failed",
        receipt: {
          actionId,
          status: "failed",
          startedAt: "2026-01-01T00:00:00.000Z",
          endedAt: "2026-01-01T00:00:00.010Z",
          durationMs: 10,
        },
      }),
    ],
  ])("clears unresolved action after %s", (_label, terminal) => {
    const snapshot = reduceRuntimeEvents([waitStarted(0), terminal], runId);
    expect(snapshot.unresolvedActionId).toBeUndefined();
    expect(snapshot.stepCount).toBe(1);
  });

  it("rejects a terminal action without a matching started action", () => {
    expect(() => reduceRuntimeEvents([waitCompleted(0)], runId)).toThrow(
      /without action\.execution\.started/,
    );

    const otherAction = event(1, {
      type: "action.execution.completed",
      receipt: {
        actionId: "other-action" as ActionId,
        status: "completed",
        startedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(() => reduceRuntimeEvents([waitStarted(0), otherAction], runId)).toThrow(
      /does not match unresolved action/,
    );
  });

  it("clears and resolves approval state", () => {
    const approved = reduceRuntimeEvents(
      [
        event(0, { type: "approval.requested", requestId: "approval-1", reason: "confirm" }),
        event(1, { type: "approval.resolved", requestId: "approval-1", approved: true }),
      ],
      runId,
    );
    expect(approved.pendingApproval).toBeUndefined();
    expect(approved.status).toBe("running");

    const denied = reduceRuntimeEvents(
      [
        event(0, { type: "approval.requested", requestId: "approval-2", reason: "confirm" }),
        event(1, { type: "approval.resolved", requestId: "approval-2", approved: false }),
      ],
      runId,
    );
    expect(denied.pendingApproval).toBeUndefined();
    expect(denied.status).toBe("finished");
    expect(denied.outcome).toBe("cancelled");
  });

  it("rejects an approval resolution for another request", () => {
    expect(() =>
      reduceRuntimeEvents(
        [
          event(0, { type: "approval.requested", requestId: "approval-1", reason: "confirm" }),
          event(1, { type: "approval.resolved", requestId: "approval-2", approved: true }),
        ],
        runId,
      ),
    ).toThrow(/does not match pending approval/);
  });

  it("requires contiguous event sequences when rebuilding a snapshot", () => {
    expect(() => reduceRuntimeEvents([event(1, { type: "run.created", goal: "test" })], runId)).toThrow(
      /expected 0/,
    );
    expect(() =>
      reduceRuntimeEvents(
        [event(0, { type: "run.created", goal: "test" }), event(2, { type: "run.started" })],
        runId,
      ),
    ).toThrow(/expected 1/);
  });
});

describe("JsonlRunEventWriter", () => {
  it("serializes events with monotonic sequence numbers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-"));
    const filePath = join(directory, "trajectory.jsonl");
    const writer = new JsonlRunEventWriter(filePath, {
      next: (() => {
        let count = 0;
        return () => `event-${count++}` as EventId;
      })(),
    });

    await Promise.all([
      writer.append({ runId, type: "run.created", goal: "one" }),
      writer.append({ runId, type: "run.started" }),
    ]);
    await writer.close();

    const events = await readRuntimeEvents(filePath);
    expect(events.map((item) => item.sequence)).toEqual([0, 1]);
    expect((await readFile(filePath, "utf8")).split("\n").filter(Boolean)).toHaveLength(2);
    await rm(directory, { recursive: true, force: true });
  });

  it("refuses to append a new writer to an existing trajectory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-"));
    const filePath = join(directory, "trajectory.jsonl");
    const writer = new JsonlRunEventWriter(filePath);
    await writer.append({ runId, type: "run.created", goal: "one" });
    await writer.close();

    const reopened = new JsonlRunEventWriter(filePath);
    await expect(reopened.append({ runId, type: "run.started" })).rejects.toThrow(
      /trajectory file already exists/,
    );
    expect((await readRuntimeEvents(filePath)).map((item) => item.sequence)).toEqual([0]);
    await rm(directory, { recursive: true, force: true });
  });
});

describe("FileAssetStore", () => {
  it("writes an asset atomically and returns its reference", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-assets-"));
    const store = new FileAssetStore(directory);
    const reference = await store.put({
      assetId: "asset-1" as AssetId,
      relativePath: "screenshots/one.bin",
      mediaType: "application/octet-stream",
      data: new Uint8Array([1, 2, 3]),
    });

    expect(reference).toEqual({
      assetId: "asset-1",
      relativePath: "screenshots/one.bin",
      mediaType: "application/octet-stream",
      byteLength: 3,
    });
    expect(await readFile(join(directory, "screenshots/one.bin"))).toEqual(
      Buffer.from([1, 2, 3]),
    );
    expect(await readdir(join(directory, "screenshots"))).toEqual(["one.bin"]);
    await rm(directory, { recursive: true, force: true });
  });

  it("rejects paths outside the asset root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-assets-"));
    const store = new FileAssetStore(directory);
    await expect(
      store.put({
        assetId: "asset-1" as AssetId,
        relativePath: "../outside.bin",
        mediaType: "application/octet-stream",
        data: new Uint8Array([1]),
      }),
    ).rejects.toThrow(/relativePath contains an invalid segment/);
    await rm(directory, { recursive: true, force: true });
  });
});

describe("readRuntimeEvents", () => {
  it("reports malformed JSON and malformed event data with line numbers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-events-"));
    const filePath = join(directory, "trajectory.jsonl");
    await writeFile(filePath, "not-json\n", "utf8");
    await expect(readRuntimeEvents(filePath)).rejects.toThrow(/line 1/);

    await writeFile(
      filePath,
      JSON.stringify({
        eventId: "event-0",
        runId,
        sequence: 0,
        occurredAt: "2026-01-01T00:00:00.000Z",
        type: "run.created",
      }) + "\n",
      "utf8",
    );
    await expect(readRuntimeEvents(filePath)).rejects.toThrow(/goal must be a string/);
    await rm(directory, { recursive: true, force: true });
  });
});
