import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  ActionId,
  AssetId,
  ComputerSessionId,
  ComputerSessionDescriptor,
  EventId,
  ObservationId,
  RunId,
  RuntimeEvent,
  RuntimeEventData,
  ToolCallId,
} from "@computer-harness/protocol";
import {
  FileAssetStore,
  JsonlRunEventWriter,
  initialRunSnapshot,
  readRuntimeEvents,
  reduceRunEvent,
  reduceRuntimeEvents,
  runtimeEventSchema,
} from "./index.js";
import { runtimeEventTypes } from "@computer-harness/protocol";

const runId = "run-test" as RunId;
const observationId = "observation-test" as ObservationId;
const actionId = "action-test" as ActionId;
const callId = "call-test" as ToolCallId;
const clickActionId = "click-action-test" as ActionId;
const session: ComputerSessionDescriptor = {
  id: "computer-test" as ComputerSessionId,
  backend: "fake",
  viewport: { width: 100, height: 100, coordinateSpace: "physical" },
  capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false },
  openedAt: "2026-01-01T00:00:00.000Z",
};

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

function runCreated(sequence = 0): RuntimeEvent {
  return event(sequence, { type: "run.created", goal: "test" });
}

function runStarted(sequence = 1): RuntimeEvent {
  return event(sequence, { type: "run.started" });
}

function runningEvents(): RuntimeEvent[] {
  return [
    runCreated(0),
    runStarted(1),
    event(2, { type: "computer.open.started" }),
    event(3, { type: "computer.open.completed", session }),
    event(4, {
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
  ];
}

function waitCompleted(sequence = 1): RuntimeEvent {
  return event(sequence, {
    type: "action.execution.completed",
    receipt: {
      actionId,
      status: "completed",
    },
  });
}

function clickStarted(sequence: number, basedOn: ObservationId = observationId): RuntimeEvent {
  return event(sequence, {
    type: "action.execution.started",
    action: {
      actionId: clickActionId,
      kind: "click",
      point: { x: 10, y: 20 },
      basedOn,
    },
  });
}

describe("RunSnapshot reducer", () => {
  it("projects Planning mutations into the run-isolated PlanState", () => {
    const task = { id: "task-1", subject: "Open Writer", status: "pending" as const };
    const events = [
      ...runningEvents(),
      event(5, { type: "planning.task.updated", callId, mutation: { operation: "created", task } }),
      event(6, { type: "planning.task.updated", callId, mutation: { operation: "updated", task: { ...task, status: "completed" as const } } }),
    ];
    const snapshot = events.reduce(reduceRunEvent, initialRunSnapshot(runId));
    expect(snapshot.plan).toEqual({ runId, tasks: [{ ...task, status: "completed" }] });
  });

  it("rebuilds Run Memory from its event stream", () => {
    const snapshot = [
      ...runningEvents(),
      event(5, { type: "memory.updated", callId, mutation: { operation: "upsert_fact", fact: { id: "m1", subject: { type: "run" }, key: "target", value: "report.odt", sourceEventId: "source-event" as EventId, status: "active", updatedSequence: 4 } } }),
      event(6, { type: "memory.updated", callId, mutation: { operation: "supersede_fact", factId: "m1" } }),
    ].reduce(reduceRunEvent, initialRunSnapshot(runId));
    expect(snapshot.memory.facts).toMatchObject([{ id: "m1", status: "superseded" }]);
    expect(snapshot.memory.facts[0]).toMatchObject({ scope: { kind: "run" }, retentionClass: "stable" });
  });

  it("does not turn partial provider cache observations into a false run total", () => {
    const cachedResponse = event(5, {
      type: "model.response.received",
      turn: { type: "finish", summary: "first", usage: { inputTokens: 10, cacheReadTokens: 6 } },
    });
    const uncachedResponse = event(6, {
      type: "model.response.received",
      turn: { type: "finish", summary: "second", usage: { inputTokens: 8 } },
    });
    const events = [...runningEvents(), cachedResponse, uncachedResponse];
    const snapshot = events.reduce(reduceRunEvent, initialRunSnapshot(runId));
    expect(cachedResponse).toMatchObject({ turn: { usage: { cacheReadTokens: 6 } } });
    expect(snapshot.modelUsage).toEqual({ inputTokens: 18 });
    expect(snapshot.modelUsage?.cacheReadTokens).toBeUndefined();
  });

  it("is deterministic and leaves an unresolved side effect visible", () => {
    const events: RuntimeEvent[] = [
      ...runningEvents(),
      waitStarted(5),
    ];

    const first = events.reduce(reduceRunEvent, initialRunSnapshot(runId));
    const second = events.reduce(reduceRunEvent, initialRunSnapshot(runId));
    expect(first).toEqual(second);
    expect(first.unresolvedActionId).toBe(actionId);
  });

  it("records the latest observation", () => {
    const observed = reduceRuntimeEvents(
      runningEvents(),
      runId,
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
        },
      }),
    ],
  ])("clears unresolved action after %s", (_label, terminal) => {
    const snapshot = reduceRuntimeEvents(
      [...runningEvents(), waitStarted(5), { ...terminal, sequence: 6 }],
      runId,
    );
    expect(snapshot.unresolvedActionId).toBeUndefined();
    expect(snapshot.stepCount).toBe(1);
  });

  it("rejects a terminal action without a matching started action", () => {
    expect(() => reduceRuntimeEvents([...runningEvents(), { ...waitCompleted(0), sequence: 5 }], runId)).toThrow(
      /without action\.execution\.started/,
    );

    const otherAction = event(1, {
      type: "action.execution.completed",
      receipt: {
        actionId: "other-action" as ActionId,
        status: "completed",
      },
    });
    expect(() =>
      reduceRuntimeEvents(
        [...runningEvents(), waitStarted(5), { ...otherAction, sequence: 6 }],
        runId,
      ),
    ).toThrow(/does not match unresolved action/);
  });

  it("clears and resolves approval state", () => {
    const approved = reduceRuntimeEvents(
      [
        ...runningEvents(),
        event(5, {
          type: "approval.requested",
          requestId: "approval-1",
          callId,
          reason: "confirm",
        }),
        event(6, { type: "approval.resolved", requestId: "approval-1", approved: true }),
      ],
      runId,
    );
    expect(approved.pendingApproval).toBeUndefined();
    expect(approved.status).toBe("running");

    const denied = reduceRuntimeEvents(
      [
        ...runningEvents(),
        event(5, {
          type: "approval.requested",
          requestId: "approval-2",
          callId,
          reason: "confirm",
        }),
        event(6, { type: "approval.resolved", requestId: "approval-2", approved: false }),
      ],
      runId,
    );
    expect(denied.pendingApproval).toBeUndefined();
    expect(denied.status).toBe("running");
    expect(denied.outcome).toBeUndefined();
  });

  it("rejects an approval resolution for another request", () => {
    expect(() =>
      reduceRuntimeEvents(
        [
          ...runningEvents(),
          event(5, {
            type: "approval.requested",
            requestId: "approval-1",
            callId,
            reason: "confirm",
          }),
          event(6, { type: "approval.resolved", requestId: "approval-2", approved: true }),
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

  it("tracks a pending user question and clears it on an answer or correction", () => {
    const waiting = reduceRuntimeEvents(
      [...runningEvents(), event(5, { type: "user.input.requested", question: "Where should I save it?" })],
      runId,
    );
    expect(waiting.status).toBe("waiting_user");
    expect(waiting.pendingUserQuestion).toBe("Where should I save it?");

    const resumed = reduceRuntimeEvents(
      [
        ...runningEvents(),
        event(5, { type: "user.input.requested", question: "Where should I save it?" }),
        event(6, { type: "user.input.received", text: "Save it in Documents." }),
      ],
      runId,
    );
    expect(resumed.status).toBe("running");
    expect(resumed.pendingUserQuestion).toBeUndefined();

    const corrected = reduceRuntimeEvents(
      [...runningEvents(), event(5, { type: "user.input.received", text: "Do not save yet." })],
      runId,
    );
    expect(corrected.status).toBe("running");
  });

  it("rejects lifecycle changes after finish and refuses ambiguous state changes", () => {
    const finished = reduceRuntimeEvents(
      [...runningEvents(), event(5, { type: "run.finished", outcome: "succeeded" })],
      runId,
    );
    expect(finished.status).toBe("finished");
    expect(() => reduceRunEvent(finished, event(6, { type: "run.resumed" }))).toThrow(/is finished/);

    expect(() =>
      reduceRuntimeEvents(
        [...runningEvents(), event(5, { type: "approval.requested", requestId: "a", callId, reason: "confirm" }), event(6, {
          type: "user.input.received",
          text: "bypass",
        })],
        runId,
      ),
    ).toThrow(/cannot bypass pending approval/);

    expect(() =>
      reduceRuntimeEvents(
        [...runningEvents(), waitStarted(5), event(6, { type: "run.finished", outcome: "succeeded" })],
        runId,
      ),
    ).toThrow(/GUI action is unresolved/);
  });

  it("requires observation ownership and receipt/event status agreement", () => {
    const foreignObservation = event(5, {
      type: "observation.created",
      observation: {
        id: "foreign-observation" as ObservationId,
        runId: "other-run" as RunId,
        computerSessionId: "computer-test" as ComputerSessionId,
        capturedAt: "2026-01-01T00:00:00.000Z",
        viewport: { width: 1, height: 1, coordinateSpace: "physical" },
        screenshot: {
          assetId: "asset-test" as AssetId,
          relativePath: "assets/one.png",
          mediaType: "image/png",
          byteLength: 1,
        },
      },
    }) as Extract<RuntimeEvent, { type: "observation.created" }>;
    expect(() => reduceRuntimeEvents([...runningEvents(), foreignObservation], runId)).toThrow(
      /belongs to run other-run/,
    );

    const mismatchedReceipt = event(6, {
      type: "action.execution.completed",
      receipt: {
        actionId,
        status: "failed",
      },
    });
    expect(() =>
      reduceRuntimeEvents([...runningEvents(), waitStarted(5), mismatchedReceipt], runId),
    ).toThrow(/must carry a completed receipt/);

    const foreignSessionObservation = {
      ...foreignObservation,
      observation: { ...foreignObservation.observation, runId, computerSessionId: "other-session" as ComputerSessionId },
    };
    expect(() => reduceRuntimeEvents([...runningEvents(), foreignSessionObservation], runId)).toThrow(
      /belongs to session other-session/,
    );
  });

  it("requires an open event before completing the computer session", () => {
    expect(() =>
      reduceRuntimeEvents(
        [
          runCreated(0),
          runStarted(1),
          event(2, { type: "computer.open.completed", session }),
        ],
        runId,
      ),
    ).toThrow(/requires computer\.open\.started/);
  });

  it("does not allow a model request before the run is running", () => {
    expect(() =>
      reduceRuntimeEvents(
        [runCreated(0), event(1, { type: "model.request.started", providerId: "provider-test" })],
        runId,
      ),
    ).toThrow(/model\.request\.started requires running status/);
  });

  it("rejects GUI actions based on an older observation and preserves unknown side effects", () => {
    expect(() => reduceRuntimeEvents([...runningEvents(), clickStarted(5, "old-observation" as ObservationId)], runId)).toThrow(
      /is based on old-observation, not latest observation/,
    );

    const unknown = reduceRuntimeEvents(
      [
        ...runningEvents(),
        waitStarted(5),
        event(6, { type: "run.finished", outcome: "outcome_unknown" }),
      ],
      runId,
    );
    expect(unknown.status).toBe("finished");
    expect(unknown.outcome).toBe("outcome_unknown");
    expect(unknown.unresolvedActionId).toBe(actionId);
  });

  it.each([
    ["type", { actionId: "type-action" as ActionId, kind: "type" as const, text: "hello", basedOn: observationId }],
    ["keypress", { actionId: "key-action" as ActionId, kind: "keypress" as const, keys: ["ENTER"], basedOn: observationId }],
  ])("requires an Observation binding for %s actions", (_kind, action) => {
    const started = event(5, { type: "action.execution.started", action });
    expect(() => reduceRuntimeEvents([...runningEvents(), started], runId)).not.toThrow();
    const unbound = { ...action, basedOn: "other-observation" as ObservationId };
    expect(() => reduceRuntimeEvents([...runningEvents(), event(5, { type: "action.execution.started", action: unbound })], runId)).toThrow(
      /is based on other-observation, not latest observation/,
    );
  });
});

describe("JsonlRunEventWriter", () => {
  it("serializes events with monotonic sequence numbers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-"));
    const filePath = join(directory, "trajectory.jsonl");
    const writer = new JsonlRunEventWriter(filePath, runId, {
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

  it("round-trips provider continuation data through JSONL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-continuation-"));
    const filePath = join(directory, "trajectory.jsonl");
    const writer = new JsonlRunEventWriter(filePath, runId);
    await writer.append({
      runId,
      type: "model.response.received",
      turn: {
        type: "tool_calls",
        calls: [{ id: callId, name: "click", arguments: { x: 10, y: 20 } }],
        continuation: {
          providerId: "glm-5.3-flash",
          kind: "reasoning_content",
          content: "preserve this exact continuation",
        },
      },
    });
    await writer.close();

    expect(await readRuntimeEvents(filePath)).toEqual([
      expect.objectContaining({
        type: "model.response.received",
        turn: expect.objectContaining({
          continuation: {
            providerId: "glm-5.3-flash",
            kind: "reasoning_content",
            content: "preserve this exact continuation",
          },
        }),
      }),
    ]);
    await rm(directory, { recursive: true, force: true });
  });

  it("refuses to append a new writer to an existing trajectory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-"));
    const filePath = join(directory, "trajectory.jsonl");
    const writer = new JsonlRunEventWriter(filePath, runId);
    await writer.append({ runId, type: "run.created", goal: "one" });
    await writer.close();

    const reopened = new JsonlRunEventWriter(filePath, runId);
    await expect(reopened.append({ runId, type: "run.started" })).rejects.toThrow(
      /trajectory file already exists/,
    );
    expect((await readRuntimeEvents(filePath)).map((item) => item.sequence)).toEqual([0]);
    await rm(directory, { recursive: true, force: true });
  });

  it("rejects events from a different run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-"));
    const filePath = join(directory, "trajectory.jsonl");
    const writer = new JsonlRunEventWriter(filePath, runId);
    await expect(
      writer.append({ runId: "other-run" as RunId, type: "run.created", goal: "wrong run" }),
    ).rejects.toThrow(/writer is bound to/);
    await writer.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("linearizes close before new appends and preserves already queued writes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-"));
    const filePath = join(directory, "trajectory.jsonl");
    const writer = new JsonlRunEventWriter(filePath, runId);

    const queued = writer.append({ runId, type: "run.created", goal: "one" });
    const closing = writer.close();
    await expect(writer.append({ runId, type: "run.started" })).rejects.toThrow(/writer is closed/);
    await queued;
    await closing;

    expect((await readRuntimeEvents(filePath)).map((item) => item.type)).toEqual(["run.created"]);
    await expect(writer.append({ runId, type: "run.started" })).rejects.toThrow(/writer is closed/);
    await rm(directory, { recursive: true, force: true });
  });

  it("makes concurrent close calls idempotent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-"));
    const filePath = join(directory, "trajectory.jsonl");
    const writer = new JsonlRunEventWriter(filePath, runId);
    const [first, second] = [writer.close(), writer.close()];
    await Promise.all([first, second]);
    await expect(writer.append({ runId, type: "run.created", goal: "late" })).rejects.toThrow(
      /writer is closed/,
    );
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

  it("rejects overwriting an existing asset and preserves the original bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-assets-"));
    const store = new FileAssetStore(directory);
    const input = {
      assetId: "asset-1" as AssetId,
      relativePath: "screenshots/one.bin",
      mediaType: "application/octet-stream",
      data: new Uint8Array([1]),
    };
    await store.put(input);
    await expect(store.put({ ...input, data: new Uint8Array([2]) })).rejects.toThrow(
      /asset already exists/,
    );
    expect(await readFile(join(directory, "screenshots/one.bin"))).toEqual(Buffer.from([1]));
    await rm(directory, { recursive: true, force: true });
  });
});

describe("readRuntimeEvents", () => {
  it("keeps the Zod discriminator set aligned with the protocol event list", () => {
    const effectsDefinition = runtimeEventSchema as unknown as {
      _def: {
        schema: {
          options: Array<{ shape: { type: { value: string } } }>;
        };
      };
    };
    expect(effectsDefinition._def.schema.options.map((option) => option.shape.type.value)).toEqual(
      runtimeEventTypes,
    );
  });

  it("round-trips the required fields of every current RuntimeEvent", () => {
    const fixtures: RuntimeEvent[] = [
      runCreated(0),
      runStarted(0),
      event(0, { type: "computer.open.started" }),
      event(0, { type: "computer.open.completed", session }),
      event(0, {
        type: "observation.created",
        observation: {
          id: observationId,
          runId,
          computerSessionId: "computer-test" as ComputerSessionId,
          capturedAt: "2026-01-01T00:00:00.000Z",
          viewport: { width: 1, height: 1, coordinateSpace: "physical" },
          screenshot: {
            assetId: "asset-test" as AssetId,
            relativePath: "assets/one.png",
            mediaType: "image/png",
            byteLength: 1,
          },
        },
      }),
      event(0, { type: "model.request.started", providerId: "provider-test" }),
      event(0, { type: "model.response.received", turn: { type: "finish", summary: "done", reportedStatus: "failure" } }),
      event(0, { type: "model.request.failed", category: "provider", message: "unavailable", code: "HTTP_429", retryable: true }),
      event(0, {
        type: "tool.call.received",
        call: { id: callId, name: "example", arguments: { nested: [true, 1, "ok", null] } },
      }),
      event(0, { type: "tool.call.rejected", callId, reason: "policy" }),
      event(0, {
        type: "tool.call.completed",
        result: { callId, status: "completed", output: { ok: true } },
      }),
      event(0, {
        type: "tool.call.failed",
        result: { callId, status: "failed", error: { code: "FAILED", message: "no" } },
      }),
      event(0, {
        type: "action.proposed",
        callId,
        action: { actionId, kind: "wait", durationMs: 1 },
      }),
      event(0, {
        type: "action.guard.evaluated",
        callIds: [callId],
        actions: [{ actionId, kind: "wait", durationMs: 1 }],
        decision: "allow",
        categories: [],
        reasonCode: "fixture_allow",
        reason: "fixture",
        path: "local",
        policyVersion: "test-v1",
        modelRequestCount: 0,
      }),
      event(0, { type: "action.execution.started", action: { actionId, kind: "wait", durationMs: 1 } }),
      event(0, {
        type: "action.execution.completed",
        receipt: { actionId, status: "completed" },
      }),
      event(0, {
        type: "action.execution.failed",
        receipt: { actionId, status: "failed" },
      }),
      event(0, { type: "planning.task.updated", callId, mutation: { operation: "created", task: { id: "task-1", subject: "Open the app", status: "pending" } } }),
      event(0, { type: "memory.updated", callId, mutation: { operation: "upsert_fact", fact: { id: "m1", subject: { type: "run" }, key: "target", value: "demo", sourceEventId: "event-source" as EventId, status: "active", updatedSequence: 12 } } }),
      event(0, {
        type: "monitor.proposal",
        mode: "guidance",
        proposal: "guidance",
        fingerprint: "monitor-fingerprint",
        sourceEventIds: ["event-source" as EventId],
        reasonCodes: ["repeated_action"],
        evidenceKinds: ["action_receipt"],
        modelDecisionCount: 1,
        guiActionCount: 2,
        guidanceText: "Review current state before continuing.",
      }),
      event(0, { type: "run.paused", reason: "operator" }),
      event(0, { type: "run.resumed" }),
      event(0, { type: "approval.requested", requestId: "approval-1", callId, reason: "confirm" }),
      event(0, { type: "approval.resolved", requestId: "approval-1", approved: true }),
      event(0, { type: "user.input.requested", question: "Where?" }),
      event(0, { type: "user.input.received", text: "Here." }),
      event(0, { type: "runtime.error", category: "runtime", message: "error" }),
      event(0, { type: "run.finished", outcome: "failed", summary: "failed", reportedStatus: "failure" }),
    ];

    expect(fixtures).toHaveLength(runtimeEventTypes.length);
    for (const fixture of fixtures) {
      const parsed = runtimeEventSchema.parse(JSON.parse(JSON.stringify(fixture)));
      expect(parsed).toEqual(fixture);
    }
  });

  it("rejects cross-field ownership and receipt mismatches at the schema boundary", () => {
    const lifecycleMemoryEvent = {
      eventId: "event-lifecycle",
      runId,
      sequence: 0,
      occurredAt: "2026-01-01T00:00:00.000Z",
      type: "memory.updated" as const,
      source: "lifecycle" as const,
      mutation: { operation: "mark_fact_needs_check" as const, factId: "fact-1", reason: "scope_ended" as const },
    };
    expect(runtimeEventSchema.parse(lifecycleMemoryEvent)).toEqual(lifecycleMemoryEvent);
    expect(runtimeEventSchema.safeParse({ ...lifecycleMemoryEvent, callId }).success).toBe(false);

    const observation = {
      eventId: "event-0",
      runId,
      sequence: 0,
      occurredAt: "2026-01-01T00:00:00.000Z",
      type: "observation.created" as const,
      observation: {
        id: observationId,
        runId: "other-run" as RunId,
        computerSessionId: "computer-test" as ComputerSessionId,
        capturedAt: "2026-01-01T00:00:00.000Z",
        viewport: { width: 1, height: 1, coordinateSpace: "physical" as const },
        screenshot: {
          assetId: "asset-test" as AssetId,
          relativePath: "assets/one.png",
          mediaType: "image/png",
          byteLength: 1,
        },
      },
    };
    expect(runtimeEventSchema.safeParse(observation).success).toBe(false);

    const failedAsCompleted = {
      eventId: "event-0",
      runId,
      sequence: 0,
      occurredAt: "2026-01-01T00:00:00.000Z",
      type: "action.execution.completed" as const,
      receipt: { actionId, status: "failed" },
    };
    expect(runtimeEventSchema.safeParse(failedAsCompleted).success).toBe(false);

    const rejectedAsFailed = {
      eventId: "event-0",
      runId,
      sequence: 0,
      occurredAt: "2026-01-01T00:00:00.000Z",
      type: "tool.call.failed" as const,
      result: {
        callId,
        status: "rejected" as const,
        error: { code: "POLICY", message: "denied" },
      },
    };
    expect(runtimeEventSchema.safeParse(rejectedAsFailed).success).toBe(false);

    const zeroViewportSession = {
      eventId: "event-0",
      runId,
      sequence: 0,
      occurredAt: "2026-01-01T00:00:00.000Z",
      type: "computer.open.completed" as const,
      session: {
        ...session,
        viewport: { width: 0, height: 100, coordinateSpace: "physical" as const },
      },
    };
    expect(runtimeEventSchema.safeParse(zeroViewportSession).success).toBe(false);
  });

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
    await expect(readRuntimeEvents(filePath)).rejects.toThrow(/goal/);

    await writeFile(
      filePath,
      JSON.stringify({
        eventId: "event-0",
        runId,
        sequence: 0,
        occurredAt: "2026-01-01T00:00:00.000Z",
        type: "observation.created",
        observation: { id: "o0" },
      }) + "\n",
      "utf8",
    );
    await expect(readRuntimeEvents(filePath)).rejects.toThrow(/observation/);

    const parsed = await writeAndReadUserInputEvents(filePath);
    expect(parsed.map((item) => item.type)).toEqual([
      "user.input.requested",
      "user.input.received",
    ]);
    await rm(directory, { recursive: true, force: true });
  });
});

describe("Event, Asset and Snapshot integration", () => {
  it("persists an asset before its observation event and rebuilds the snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-integration-"));
    const assetStore = new FileAssetStore(join(directory, "assets"));
    const asset = await assetStore.put({
      assetId: "asset-integration" as AssetId,
      relativePath: "screenshots/one.png",
      mediaType: "image/png",
      data: new Uint8Array([137, 80, 78, 71]),
    });
    const trajectoryPath = join(directory, "trajectory.jsonl");
    const writer = new JsonlRunEventWriter(trajectoryPath, runId);
    await writer.append({ runId, type: "run.created", goal: "observe" });
    await writer.append({ runId, type: "run.started" });
    await writer.append({ runId, type: "computer.open.started" });
    await writer.append({
      runId,
      type: "computer.open.completed",
      session: { ...session, id: "computer-integration" as ComputerSessionId },
    });
    await writer.append({
      runId,
      type: "observation.created",
      observation: {
        id: observationId,
        runId,
        computerSessionId: "computer-integration" as ComputerSessionId,
        capturedAt: "2026-01-01T00:00:00.000Z",
        viewport: { width: 1, height: 1, coordinateSpace: "physical" },
        screenshot: asset,
      },
    });
    await writer.close();

    const events = await readRuntimeEvents(trajectoryPath);
    const snapshot = reduceRuntimeEvents(events, runId);
    expect(snapshot.latestObservationId).toBe(observationId);
    expect(await readFile(join(directory, "assets", "screenshots", "one.png"))).toEqual(
      Buffer.from([137, 80, 78, 71]),
    );
    await rm(directory, { recursive: true, force: true });
  });
});

async function writeAndReadUserInputEvents(filePath: string): Promise<RuntimeEvent[]> {
  await writeFile(
    filePath,
    [
      event(0, { type: "user.input.requested", question: "Need a path" }),
      event(1, { type: "user.input.received", text: "Documents" }),
    ]
      .map((item) => JSON.stringify(item))
      .join("\n") + "\n",
    "utf8",
  );
  return readRuntimeEvents(filePath);
}
