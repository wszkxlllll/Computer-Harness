import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  ActionId,
  AssetId,
  ComputerSessionId,
  ComputerSessionDescriptor,
  SurfaceId,
  SurfaceRef,
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
const desktopSurfaceRef: SurfaceRef = { surfaceId: "trajectory-desktop" as SurfaceId, generation: 1, kind: "desktop" };
const domSurfaceRef: SurfaceRef = {
  surfaceId: "trajectory-dom" as SurfaceId,
  generation: 1,
  kind: "dom",
  parentSurfaceId: "trajectory-browser-tab" as SurfaceId,
};
const session: ComputerSessionDescriptor = {
  id: "computer-test" as ComputerSessionId,
  backend: "fake",
  viewport: { width: 100, height: 100, coordinateSpace: "physical" },
  capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false },
  openedAt: "2026-01-01T00:00:00.000Z",
};

function event(sequence: number, data: RuntimeEventData): RuntimeEvent {
  // Post-open events in these reducer fixtures use historical call-site
  // sequence values beginning at 5. The live contract now inserts the
  // initial Surface transition at 4 and its Observation at 5.
  return eventAt(sequence >= 5 ? sequence + 1 : sequence, data);
}

function eventAt(sequence: number, data: RuntimeEventData): RuntimeEvent {
  return {
    eventId: `event-${sequence}` as EventId,
    runId,
    sequence,
    occurredAt: `2026-01-01T00:00:0${sequence}.000Z`,
    schemaVersion: 2,
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
    eventAt(4, { type: "computer.surface.transitioned", from: null, to: desktopSurfaceRef, reason: "initial_observation" }),
    eventAt(5, {
      type: "observation.created",
      observation: {
        id: observationId,
        runId,
        computerSessionId: "computer-test" as ComputerSessionId,
        surfaceRef: desktopSurfaceRef,
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

describe("switch_window session receipt contract", () => {
  const switchedSession: ComputerSessionDescriptor = {
    ...session,
    viewport: { width: 640, height: 480, coordinateSpace: "physical" },
  };
  const switchStarted = event(5, {
    type: "action.execution.started",
    action: { actionId, basedOn: observationId, kind: "switch_window", windowRef: "opaque-window-ref" },
  });

  it("updates the target viewport on the same ComputerSession and clears the old observation before recapture", () => {
    const started = reduceRuntimeEvents([...runningEvents(), switchStarted], runId);
    expect(started.latestObservationId).toBeUndefined();
    expect(started.unresolvedActionKind).toBe("switch_window");

    const completed = event(6, {
      type: "action.execution.completed",
      receipt: { actionId, status: "completed", sessionAfter: switchedSession },
    });
    const transition = reduceRuntimeEvents([...runningEvents(), switchStarted, completed], runId);
    expect(transition.computerSession).toEqual(switchedSession);
    expect(transition.latestObservationId).toBeUndefined();
    expect(transition.stepCount).toBe(1);

    const fresh = event(7, {
      type: "observation.created",
      observation: {
        id: "observation-after-switch" as ObservationId,
        runId,
        computerSessionId: switchedSession.id,
        surfaceRef: desktopSurfaceRef,
        capturedAt: "2026-01-01T00:00:07.000Z",
        viewport: switchedSession.viewport,
        screenshot: { assetId: "asset-after-switch" as AssetId, relativePath: "assets/after.png", mediaType: "image/png", byteLength: 1 },
      },
    });
    expect(reduceRunEvent(transition, fresh).latestObservationId).toBe("observation-after-switch");
  });

  it("clears stale observation even when switch activation fails or has unknown outcome", () => {
    const failed = event(6, {
      type: "action.execution.failed",
      receipt: { actionId, status: "failed", driverCode: "WINDOW_SWITCH_OUTCOME_UNKNOWN" },
    });
    const snapshot = reduceRuntimeEvents([...runningEvents(), switchStarted, failed], runId);
    expect(snapshot.computerSession).toEqual(session);
    expect(snapshot.latestObservationId).toBeUndefined();
    expect(snapshot.unresolvedActionId).toBeUndefined();
  });

  it("rejects missing, failed, non-switch, mismatched-action, cross-session, and cross-backend sessionAfter data", () => {
    const missingAfter = event(6, { type: "action.execution.completed", receipt: { actionId, status: "completed" } });
    expect(() => reduceRuntimeEvents([...runningEvents(), switchStarted, missingAfter], runId)).toThrow(/requires sessionAfter/u);

    const failedWithAfter = {
      eventId: "failed-with-session-after" as EventId,
      runId,
      sequence: 7,
      occurredAt: "2026-01-01T00:00:06.000Z",
      type: "action.execution.failed" as const,
      receipt: { actionId, status: "failed" as const, sessionAfter: switchedSession },
    };
    expect(runtimeEventSchema.safeParse(failedWithAfter).success).toBe(false);

    const clickStarted = event(5, {
      type: "action.execution.started",
      action: { actionId: clickActionId, basedOn: observationId, kind: "click", point: { x: 10, y: 20 } },
    });
    const clickWithAfter = event(6, {
      type: "action.execution.completed",
      receipt: { actionId: clickActionId, status: "completed", sessionAfter: switchedSession },
    });
    expect(() => reduceRuntimeEvents([...runningEvents(), clickStarted, clickWithAfter], runId)).toThrow(/only on a completed switch_window/u);

    const mismatchedAction = event(6, {
      type: "action.execution.completed",
      receipt: { actionId: "another-action" as ActionId, status: "completed", sessionAfter: switchedSession },
    });
    expect(() => reduceRuntimeEvents([...runningEvents(), switchStarted, mismatchedAction], runId)).toThrow(/does not match unresolved action/u);

    const wrongBackend = event(6, {
      type: "action.execution.completed",
      receipt: { actionId, status: "completed", sessionAfter: { ...switchedSession, backend: "other-backend" } },
    });
    expect(() => reduceRuntimeEvents([...runningEvents(), switchStarted, wrongBackend], runId)).toThrow(/active ComputerSession backend/u);

    const wrongSession = event(6, {
      type: "action.execution.completed",
      receipt: { actionId, status: "completed", sessionAfter: { ...switchedSession, id: "another-session" as ComputerSessionId } },
    });
    expect(() => reduceRuntimeEvents([...runningEvents(), switchStarted, wrongSession], runId)).toThrow(/active ComputerSession identity/u);
  });
});

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

  it("tracks a short-lived ExecutionSegment separately from global PlanState", () => {
    const segment = {
      id: "s1",
      objective: "筛选出发时间",
      steps: [{ id: "s1.1", intent: "展开筛选", allowedAction: "click" as const, completion: { kind: "element_present" as const, text: "08:00-10:00" } }],
      cursor: 0,
      status: "active" as const,
      sourceObservationId: observationId,
      computerSessionId: session.id,
      attemptedStepIds: [],
    };
    const snapshot = [
      ...runningEvents(),
      event(5, { type: "execution.segment.updated", source: "tool", callId, mutation: { operation: "set", segment } }),
      event(6, { type: "execution.segment.updated", source: "runtime", mutation: { operation: "step_attempted", segmentId: "s1", stepId: "s1.1" } }),
      event(7, { type: "execution.segment.updated", source: "runtime", mutation: { operation: "advanced", segmentId: "s1", cursor: 1, status: "completed" } }),
    ].reduce(reduceRunEvent, initialRunSnapshot(runId));
    expect(snapshot.plan.tasks).toEqual([]);
    expect(snapshot.executionSegment).toMatchObject({ id: "s1", cursor: 1, status: "completed", attemptedStepIds: ["s1.1"] });
  });

  it("rejects replayed completion evidence that has no attempted action", () => {
    const segment = {
      id: "s-unattempted",
      objective: "筛选出发时间",
      steps: [
        { id: "s-unattempted.1", intent: "展开筛选", allowedAction: "click" as const, completion: { kind: "element_present" as const, text: "发车时间" } },
      ],
      cursor: 0,
      status: "active" as const,
      sourceObservationId: observationId,
      computerSessionId: session.id,
      attemptedStepIds: [],
    };
    const events = [
      ...runningEvents(),
      event(5, { type: "execution.segment.updated", source: "tool", callId, mutation: { operation: "set", segment } }),
    ];
    expect(() => events.concat(event(6, { type: "execution.segment.updated", source: "runtime", mutation: { operation: "advanced", segmentId: segment.id, cursor: 1, status: "completed" } })).reduce(reduceRunEvent, initialRunSnapshot(runId))).toThrow(/cannot advance before an attempted action/u);
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

  it("records an explicit Surface transition and consumes it with the matching Observation", () => {
    const peerSurfaceRef: SurfaceRef = { surfaceId: "trajectory-peer" as SurfaceId, generation: 1, kind: "native_window" };
    const events = [
      ...runningEvents(),
      event(5, { type: "computer.surface.transitioned", from: desktopSurfaceRef, to: peerSurfaceRef, reason: "peer_switch" }),
      event(6, {
        type: "observation.created",
        observation: {
          id: "observation-peer" as ObservationId,
          runId,
          computerSessionId: session.id,
          surfaceRef: peerSurfaceRef,
          capturedAt: "2026-01-01T00:00:01.000Z",
          viewport: session.viewport,
          screenshot: { assetId: "asset-peer" as AssetId, relativePath: "assets/peer.png", mediaType: "image/png", byteLength: 1 },
        },
      }),
    ];

    const snapshot = reduceRuntimeEvents(events, runId);
    expect(snapshot.activeSurfaceRef).toEqual(peerSurfaceRef);
    expect(snapshot.pendingSurfaceTransition).toBeUndefined();
    expect(snapshot.surfaceLineage.at(-1)).toMatchObject({
      from: desktopSurfaceRef,
      to: peerSurfaceRef,
      reason: "peer_switch",
      eventId: "event-6",
    });
    const finished = reduceRuntimeEvents([...events, event(7, { type: "run.finished", outcome: "succeeded" })], runId);
    expect(finished.status).toBe("finished");
    expect(finished.pendingSurfaceTransition).toBeUndefined();
    expect(finished.surfaceGenerationHighWater[String(peerSurfaceRef.surfaceId)]).toBe(peerSurfaceRef.generation);
    expect(finished.surfaceLineage).toEqual(snapshot.surfaceLineage);
    expect(() => reduceRuntimeEvents([
      ...runningEvents(),
      event(5, { type: "computer.surface.transitioned", from: { ...desktopSurfaceRef, generation: 0 }, to: peerSurfaceRef, reason: "peer_switch" }),
    ], runId)).toThrow(/from does not match the active Surface lineage/u);
  });

  it("requires decoder marking for legacy fallback and rejects a v2 Observation without its transition", () => {
    const peer: SurfaceRef = { surfaceId: "v2-peer" as SurfaceId, generation: 1, kind: "native_window" };
    const changedObservation = event(5, {
      type: "observation.created",
      observation: {
        id: "missing-transition-observation" as ObservationId,
        runId,
        computerSessionId: session.id,
        surfaceRef: peer,
        capturedAt: "2026-01-01T00:00:01.000Z",
        viewport: session.viewport,
        screenshot: { assetId: "missing-transition-asset" as AssetId, relativePath: "assets/missing-transition.png", mediaType: "image/png", byteLength: 1 },
      },
    });
    expect(changedObservation.schemaVersion).toBe(2);
    expect(() => reduceRuntimeEvents([...runningEvents(), changedObservation], runId))
      .toThrow(/without a preceding computer\.surface\.transitioned/u);

    const active = reduceRuntimeEvents(runningEvents(), runId);
    const unmarkedLegacyObservation = {
      eventId: "unmarked-legacy-observation" as EventId,
      runId,
      sequence: 6,
      occurredAt: "2026-01-01T00:00:06.000Z",
      type: "observation.created" as const,
      observation: {
        id: "unmarked-legacy-frame" as ObservationId,
        runId,
        computerSessionId: session.id,
        surfaceRef: peer,
        capturedAt: "2026-01-01T00:00:01.000Z",
        viewport: session.viewport,
        screenshot: { assetId: "unmarked-legacy-asset" as AssetId, relativePath: "assets/unmarked.png", mediaType: "image/png", byteLength: 1 },
      },
    };
    expect(() => reduceRunEvent(active, unmarkedLegacyObservation)).toThrow(/without a preceding computer\.surface\.transitioned/u);
  });

  it("keeps per-Surface generations monotone across peers and rejects same-ID generation rollback", () => {
    const peerA4: SurfaceRef = { surfaceId: "peer-a" as SurfaceId, generation: 4, kind: "native_window" };
    const peerA1 = { ...peerA4, generation: 1 };
    const peerB1: SurfaceRef = { surfaceId: "peer-b" as SurfaceId, generation: 1, kind: "native_window" };
    const observation = (sequence: number, ref: SurfaceRef, id: string) => event(sequence, {
      type: "observation.created",
      observation: {
        id: id as ObservationId,
        runId,
        computerSessionId: session.id,
        surfaceRef: ref,
        capturedAt: "2026-01-01T00:00:01.000Z",
        viewport: session.viewport,
        screenshot: { assetId: `asset-${id}` as AssetId, relativePath: `assets/${id}.png`, mediaType: "image/png", byteLength: 1 },
      },
    });
    const peerA = event(5, { type: "computer.surface.transitioned", from: desktopSurfaceRef, to: peerA4, reason: "peer_switch" });
    const peerB = event(7, { type: "computer.surface.transitioned", from: peerA4, to: peerB1, reason: "peer_switch" });
    const peerAAgainAtOldGeneration = event(9, { type: "computer.surface.transitioned", from: peerB1, to: peerA1, reason: "peer_switch" });
    expect(() => reduceRuntimeEvents([
      ...runningEvents(),
      peerA,
      observation(6, peerA4, "peer-a-generation-4"),
      peerB,
      observation(8, peerB1, "peer-b-generation-1"),
      peerAAgainAtOldGeneration,
    ], runId)).toThrow(/generation high-water/u);

    const sameIdRollback = event(7, { type: "computer.surface.transitioned", from: peerA4, to: peerA1, reason: "generation_advanced" });
    expect(() => reduceRuntimeEvents([
      ...runningEvents(),
      peerA,
      observation(6, peerA4, "peer-a-generation-4-direct"),
      sameIdRollback,
    ], runId)).toThrow(/generation high-water/u);

    expect(() => reduceRuntimeEvents([
      ...runningEvents(),
      peerA,
      observation(6, peerA4, "peer-a-generation-4-observe"),
      observation(7, peerA1, "peer-a-generation-1-observe"),
    ], runId)).toThrow(/without a preceding computer\.surface\.transitioned/u);
  });

  it("validates parent facts for child push/pop and permits managed DOM peers without direct parent edges", () => {
    const parent: SurfaceRef = { surfaceId: "native-parent" as SurfaceId, generation: 1, kind: "native_window" };
    const child: SurfaceRef = {
      surfaceId: "overlay-child" as SurfaceId,
      generation: 1,
      kind: "overlay",
      parentSurfaceId: parent.surfaceId,
      admissionSource: "same_hwnd_overlay_root_proof",
    };
    const parentAfterPop: SurfaceRef = { ...parent, generation: 2 };
    const rootSibling: SurfaceRef = { surfaceId: "unrelated-root" as SurfaceId, generation: 1, kind: "native_window" };
    const observation = (sequence: number, ref: SurfaceRef, id: string) => event(sequence, {
      type: "observation.created",
      observation: {
        id: id as ObservationId,
        runId,
        computerSessionId: session.id,
        surfaceRef: ref,
        capturedAt: "2026-01-01T00:00:01.000Z",
        viewport: session.viewport,
        screenshot: { assetId: `asset-${id}` as AssetId, relativePath: `assets/${id}.png`, mediaType: "image/png", byteLength: 1 },
      },
    });

    const transitionToParent = event(5, { type: "computer.surface.transitioned", from: desktopSurfaceRef, to: parent, reason: "peer_switch" });
    const push = event(7, { type: "computer.surface.transitioned", from: parent, to: child, reason: "child_push" });
    const pop = event(9, { type: "computer.surface.transitioned", from: child, to: parentAfterPop, reason: "child_pop" });
    const legalChildCycle = reduceRuntimeEvents([
      ...runningEvents(),
      transitionToParent,
      observation(6, parent, "native-parent-observation"),
      push,
      observation(8, child, "overlay-child-observation"),
      pop,
      observation(10, parentAfterPop, "native-parent-restored"),
    ], runId);
    expect(legalChildCycle.activeSurfaceRef).toEqual(parentAfterPop);
    expect(legalChildCycle.surfaceLineage.map((entry) => entry.reason)).toEqual(["initial_observation", "peer_switch", "child_push", "child_pop"]);

    const unrelatedChildPop = event(7, { type: "computer.surface.transitioned", from: parent, to: rootSibling, reason: "child_pop" });
    expect(() => reduceRuntimeEvents([
      ...runningEvents(),
      transitionToParent,
      observation(6, parent, "parent-for-invalid-pop"),
      unrelatedChildPop,
    ], runId)).toThrow(/known direct child-to-parent/u);

    const domA: SurfaceRef = { surfaceId: "dom-a" as SurfaceId, generation: 1, kind: "dom", parentSurfaceId: "tab-a" as SurfaceId };
    const domB: SurfaceRef = { surfaceId: "dom-b" as SurfaceId, generation: 1, kind: "dom", parentSurfaceId: "tab-b" as SurfaceId };
    const domPeer = event(7, { type: "computer.surface.transitioned", from: domA, to: domB, reason: "peer_switch" });
    const domPeers = reduceRuntimeEvents([
      ...runningEvents(),
      event(5, { type: "computer.surface.transitioned", from: desktopSurfaceRef, to: domA, reason: "peer_switch" }),
      observation(6, domA, "managed-dom-a"),
      domPeer,
      observation(8, domB, "managed-dom-b"),
    ], runId);
    expect(domPeers.activeSurfaceRef).toEqual(domB);
  });

  it("persists Win32 transient admission source only on an owned native child lineage", () => {
    const parent: SurfaceRef = { surfaceId: "win32-parent" as SurfaceId, generation: 1, kind: "native_window" };
    const child: SurfaceRef = {
      surfaceId: "win32-dialog-child" as SurfaceId,
      generation: 1,
      kind: "native_window",
      parentSurfaceId: parent.surfaceId,
      admissionSource: "win32_relationship_probe",
    };
    const events = [
      ...runningEvents(),
      event(5, { type: "computer.surface.transitioned", from: desktopSurfaceRef, to: parent, reason: "peer_switch" }),
      event(6, { type: "observation.created", observation: {
        id: "win32-parent-observation" as ObservationId,
        runId,
        computerSessionId: session.id,
        surfaceRef: parent,
        capturedAt: "2026-01-01T00:00:01.000Z",
        viewport: session.viewport,
        screenshot: { assetId: "win32-parent-asset" as AssetId, relativePath: "assets/win32-parent.png", mediaType: "image/png", byteLength: 1 },
      } }),
      event(7, { type: "computer.surface.transitioned", from: parent, to: child, reason: "child_push" }),
      event(8, { type: "observation.created", observation: {
        id: "win32-child-observation" as ObservationId,
        runId,
        computerSessionId: session.id,
        surfaceRef: child,
        capturedAt: "2026-01-01T00:00:02.000Z",
        viewport: session.viewport,
        screenshot: { assetId: "win32-child-asset" as AssetId, relativePath: "assets/win32-child.png", mediaType: "image/png", byteLength: 1 },
      } }),
      event(9, {
        type: "action.guard.evaluated",
        evaluatedSurfaceRef: child,
        callIds: [callId],
        actions: [{ actionId: "win32-guard-action" as ActionId, kind: "wait", durationMs: 0 }],
        decision: "require_approval",
        categories: ["external_commitment"],
        reasonCode: "fixture_approval",
        reason: "fixture",
        path: "local",
        policyVersion: "fixture-v1",
        modelRequestCount: 0,
      }),
      event(10, {
        type: "approval.requested",
        requestId: "win32-dialog-approval",
        callId,
        reason: "fixture",
        evidence: {
          observationId: "win32-child-observation" as ObservationId,
          decisionObservationId: "win32-child-observation" as ObservationId,
          assetId: "win32-child-asset" as AssetId,
          capturedAt: "2026-01-01T00:00:02.000Z",
          viewport: session.viewport,
          surfaceRef: child,
        },
      }),
    ];

    expect(reduceRuntimeEvents(events, runId).activeSurfaceRef).toEqual(child);
    const invalidOverlay = { ...child, kind: "overlay" as const };
    expect(() => reduceRuntimeEvents([
      ...runningEvents(),
      event(5, { type: "computer.surface.transitioned", from: desktopSurfaceRef, to: parent, reason: "peer_switch" }),
      event(6, { type: "observation.created", observation: {
        id: "win32-invalid-parent" as ObservationId,
        runId,
        computerSessionId: session.id,
        surfaceRef: parent,
        capturedAt: "2026-01-01T00:00:01.000Z",
        viewport: session.viewport,
        screenshot: { assetId: "win32-invalid-parent-asset" as AssetId, relativePath: "assets/win32-invalid-parent.png", mediaType: "image/png", byteLength: 1 },
      } }),
      event(7, { type: "computer.surface.transitioned", from: parent, to: invalidOverlay, reason: "child_push" }),
    ], runId)).toThrow(/transient child_push requires its exact adapter admission source/u);
  });

  it("binds Guard and approval evidence to the transient Surface admission source", () => {
    const parent: SurfaceRef = { surfaceId: "admission-parent" as SurfaceId, generation: 1, kind: "native_window" };
    const child: SurfaceRef = {
      surfaceId: "admission-child" as SurfaceId,
      generation: 1,
      kind: "overlay",
      parentSurfaceId: parent.surfaceId,
      admissionSource: "same_hwnd_overlay_root_proof",
    };
    const unprovenChild: SurfaceRef = {
      surfaceId: child.surfaceId,
      generation: child.generation,
      kind: child.kind,
      parentSurfaceId: child.parentSurfaceId!,
    };
    const childObservationId = "admission-child-observation" as ObservationId;
    const activeChildEvents = [
      ...runningEvents(),
      eventAt(6, { type: "computer.surface.transitioned", from: desktopSurfaceRef, to: parent, reason: "peer_switch" }),
      eventAt(7, {
        type: "observation.created",
        observation: {
          id: "admission-parent-observation" as ObservationId,
          runId,
          computerSessionId: session.id,
          surfaceRef: parent,
          capturedAt: "2026-01-01T00:00:01.000Z",
          viewport: session.viewport,
          screenshot: { assetId: "admission-parent-asset" as AssetId, relativePath: "assets/admission-parent.png", mediaType: "image/png", byteLength: 1 },
        },
      }),
      eventAt(8, { type: "computer.surface.transitioned", from: parent, to: child, reason: "child_push" }),
      eventAt(9, {
        type: "observation.created",
        observation: {
          id: childObservationId,
          runId,
          computerSessionId: session.id,
          surfaceRef: child,
          capturedAt: "2026-01-01T00:00:02.000Z",
          viewport: session.viewport,
          screenshot: { assetId: "admission-child-asset" as AssetId, relativePath: "assets/admission-child.png", mediaType: "image/png", byteLength: 1 },
        },
      }),
    ];
    const guard = eventAt(10, {
      type: "action.guard.evaluated",
      evaluatedSurfaceRef: unprovenChild,
      callIds: [callId],
      actions: [{ actionId: "admission-guard-action" as ActionId, kind: "wait", durationMs: 0 }],
      decision: "allow",
      categories: [],
      reasonCode: "fixture_allow",
      reason: "fixture",
      path: "local",
      policyVersion: "test-v1",
      modelRequestCount: 0,
    });
    const approval = eventAt(10, {
      type: "approval.requested",
      requestId: "admission-approval",
      callId,
      reason: "confirm",
      evidence: {
        observationId: childObservationId,
        decisionObservationId: childObservationId,
        assetId: "admission-child-asset" as AssetId,
        capturedAt: "2026-01-01T00:00:02.000Z",
        viewport: session.viewport,
        surfaceRef: unprovenChild,
      },
    });

    expect(() => reduceRuntimeEvents([...activeChildEvents, guard], runId))
      .toThrow(/action\.guard\.evaluated SurfaceRef does not match/u);
    expect(() => reduceRuntimeEvents([...activeChildEvents, approval], runId))
      .toThrow(/approval\.requested evidence SurfaceRef does not match/u);
    expect(reduceRuntimeEvents(activeChildEvents, runId).activeSurfaceRef).toEqual(child);
  });

  it("clears only a matching proactive handoff and invalidates its old observation until a fresh capture", () => {
    const sourceActionId = "proactive-action" as ActionId;
    const waiting = reduceRuntimeEvents([
      ...runningEvents(),
      event(5, { type: "computer.window.handoff.requested", sourceActionId, reasonCode: "new_window_detected" }),
    ], runId);
    expect(waiting.status).toBe("waiting_window");
    const ignored = reduceRunEvent(waiting, event(6, { type: "computer.window.handoff.ignored", sourceActionId }));
    expect(ignored.status).toBe("running");
    expect(ignored.pendingWindowHandoff).toBeUndefined();
    expect(ignored.latestObservationId).toBeUndefined();
    expect(() => reduceRunEvent(
      reduceRuntimeEvents([
        ...runningEvents(),
        event(5, { type: "computer.window.handoff.requested", sourceActionId, reasonCode: "foreground_mismatch" }),
      ], runId),
      event(6, { type: "computer.window.handoff.ignored", sourceActionId }),
    )).toThrow(/only the matching proactive window detection may be ignored/u);
    const freshObservationId = "fresh-after-ignore" as ObservationId;
    const refreshed = reduceRunEvent(ignored, event(7, {
      type: "observation.created",
      observation: {
        id: freshObservationId,
        runId,
        computerSessionId: session.id,
        surfaceRef: desktopSurfaceRef,
        capturedAt: "2026-01-01T00:00:01.000Z",
        viewport: session.viewport,
        screenshot: { assetId: "asset-fresh" as AssetId, relativePath: "assets/fresh.png", mediaType: "image/png", byteLength: 1 },
      },
    }));
    expect(refreshed.latestObservationId).toBe(freshObservationId);
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
      [...runningEvents(), waitStarted(5), { ...terminal, sequence: 7 }],
      runId,
    );
    expect(snapshot.unresolvedActionId).toBeUndefined();
    expect(snapshot.stepCount).toBe(1);
  });

  it("rejects a terminal action without a matching started action", () => {
    expect(() => reduceRuntimeEvents([...runningEvents(), { ...waitCompleted(0), sequence: 6 }], runId)).toThrow(
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
        [...runningEvents(), waitStarted(5), { ...otherAction, sequence: 7 }],
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
    expect(waiting.pendingUserInputRequestId).toBe("event-6");

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
    expect(resumed.pendingUserInputRequestId).toBeUndefined();

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
        surfaceRef: desktopSurfaceRef,
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
    const serializedEvents = (await readFile(filePath, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { schemaVersion?: number });
    expect(serializedEvents).toHaveLength(2);
    expect(serializedEvents.map((item) => item.schemaVersion)).toEqual([2, 2]);
    await rm(directory, { recursive: true, force: true });
  });

  it("refuses to write replay-only unknown Surface references as new live trajectory data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-live-surface-writer-"));
    const filePath = join(directory, "trajectory.jsonl");
    const writer = new JsonlRunEventWriter(filePath, runId);
    try {
      await expect(writer.append({
        runId,
        type: "observation.created",
        observation: {
          id: observationId,
          runId,
          computerSessionId: session.id,
          surfaceRef: { surfaceId: "legacy-unknown-writer" as SurfaceId, generation: 0, kind: "unknown" },
          capturedAt: "2026-01-01T00:00:00.000Z",
          viewport: session.viewport,
          screenshot: { assetId: "legacy-writer-asset" as AssetId, relativePath: "assets/legacy-writer.png", mediaType: "image/png", byteLength: 1 },
        },
      })).rejects.toThrow("LEGACY_SURFACE_UNRESOLVED");
    } finally {
      await writer.close();
      await rm(directory, { recursive: true, force: true });
    }
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

  it("round-trips managed-browser select_option actions and receipts through JSONL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-select-option-trajectory-"));
    const filePath = join(directory, "trajectory.jsonl");
    const writer = new JsonlRunEventWriter(filePath, runId);
    const selectAction = { actionId: "select-action" as ActionId, basedOn: observationId, kind: "select_option" as const, groundingRef: "dom-select-1", optionText: "08:00" };
    await writer.append({ runId, type: "observation.created", observation: {
      id: observationId,
      runId,
      computerSessionId: session.id,
      surfaceRef: domSurfaceRef,
      capturedAt: "2026-01-01T00:00:00.000Z",
      viewport: session.viewport,
      screenshot: { assetId: "asset-select" as AssetId, relativePath: "assets/select.png", mediaType: "image/png", byteLength: 1 },
      grounding: {
        version: "grounding-catalog-v2",
        source: "dom",
        observationId,
        computerSessionId: session.id,
        surfaceRef: domSurfaceRef,
        completeness: "complete",
        degraded: false,
        maxElements: 16,
        elements: [{ elementRef: "dom-select-1", role: "combobox", source: "dom", bbox: { x: 1, y: 1, width: 10, height: 10, coordinateSpace: "physical" }, options: [{ text: "08:00", enabled: true }, { text: "09:00", enabled: false }], optionsTruncated: false }],
      },
    } });
    await writer.append({ runId, type: "action.proposed", callId, action: selectAction });
    await writer.append({ runId, type: "action.execution.started", action: selectAction });
    await writer.append({ runId, type: "action.execution.failed", receipt: { actionId: selectAction.actionId, status: "refused", driverCode: "SELECT_OPTION_OPTION_MISSING", message: "option not found" } });
    await writer.close();
    await expect(readRuntimeEvents(filePath)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "action.proposed", action: selectAction }),
      expect.objectContaining({ type: "action.execution.started", action: selectAction }),
      expect.objectContaining({ type: "action.execution.failed", receipt: expect.objectContaining({ actionId: selectAction.actionId, status: "refused" }) }),
    ]));
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
      event(0, { type: "computer.window.handoff.requested", sourceActionId: actionId, reasonCode: "new_window_detected" }),
      event(0, { type: "computer.window.handoff.completed", target: { pid: 1234, windowId: 5678 }, session }),
      event(0, { type: "computer.window.handoff.ignored", sourceActionId: actionId }),
      event(0, {
        type: "observation.created",
        observation: {
          id: observationId,
          runId,
          computerSessionId: "computer-test" as ComputerSessionId,
          surfaceRef: desktopSurfaceRef,
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
      event(0, {
        type: "computer.surface.transitioned",
        from: null,
        to: desktopSurfaceRef,
        reason: "initial_observation",
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
        action: { actionId: "select-action" as ActionId, basedOn: observationId, kind: "select_option", groundingRef: "dom-select-1", optionText: "08:00" },
      }),
      event(0, { type: "grounding.coordinate_coverage", actionId, observationId, mapping: "containment", matchedElementRef: "element-1", inHotProjection: true, normalizedDistance: 0 }),
      event(0, {
        type: "action.guard.evaluated",
        evaluatedSurfaceRef: desktopSurfaceRef,
        callIds: [callId],
        actions: [{ actionId: "select-action" as ActionId, basedOn: observationId, kind: "select_option", groundingRef: "dom-select-1", optionText: "08:00" }],
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
      event(0, { type: "execution.segment.updated", source: "tool", callId, mutation: { operation: "set", segment: { id: "s1", objective: "Open filters", steps: [{ id: "s1.1", intent: "Expand time filters", allowedAction: "click", completion: { kind: "element_present", text: "08:00-10:00" } }], cursor: 0, status: "active", sourceObservationId: observationId, computerSessionId: session.id, attemptedStepIds: [] } } }),
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
      event(0, {
        type: "monitor.transition",
        actionId,
        preObservationId: observationId,
        postObservationId: observationId,
        sourceActionEventId: "action-terminal" as EventId,
        sourceObservationEventId: "observation-post" as EventId,
        transition: "unchanged",
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

  it("migrates legacy Observation, Guard and approval evidence to a stable unknown Surface for replay only", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-legacy-surface-"));
    const filePath = join(directory, "legacy.jsonl");
    const legacyEvent = (sequence: number, data: Record<string, unknown>) => ({
      eventId: `legacy-event-${sequence}`,
      runId,
      sequence,
      occurredAt: `2026-01-01T00:00:0${sequence}.000Z`,
      ...data,
    });
    const legacyObservation = (sequence: number, id: string, assetId: string) => legacyEvent(sequence, {
      type: "observation.created",
      observation: {
        id,
        runId,
        computerSessionId: session.id,
        capturedAt: `2026-01-01T00:00:0${sequence}.000Z`,
        viewport: session.viewport,
        screenshot: { assetId, relativePath: `assets/${assetId}.png`, mediaType: "image/png", byteLength: 1 },
      },
    });
    const firstLegacyObservation = legacyObservation(4, "legacy-observation-1", "legacy-asset-1");
    const firstObservationData = (firstLegacyObservation as unknown as { observation: Record<string, unknown> }).observation;
    const legacyEvents: unknown[] = [
      legacyEvent(0, { type: "run.created", goal: "legacy replay" }),
      legacyEvent(1, { type: "run.started" }),
      legacyEvent(2, { type: "computer.open.started" }),
      legacyEvent(3, { type: "computer.open.completed", session }),
      {
        ...firstLegacyObservation,
        observation: {
          ...firstObservationData,
          grounding: {
            version: "grounding-catalog-v2",
            source: "dom",
            observationId: "legacy-observation-1",
            computerSessionId: session.id,
            completeness: "complete",
            degraded: false,
            maxElements: 1,
            elements: [],
          },
        },
      },
      legacyObservation(5, "legacy-observation-2", "legacy-asset-2"),
      legacyEvent(6, {
        type: "action.guard.evaluated",
        callIds: [callId],
        actions: [{ actionId: "legacy-guard-action", basedOn: "legacy-observation-1", kind: "click", point: { x: 1, y: 1 } }],
        decision: "allow",
        categories: [],
        reasonCode: "legacy-fixture",
        reason: "Legacy Guard record",
        path: "local",
        policyVersion: "legacy-v1",
        modelRequestCount: 0,
      }),
      {
        ...legacyEvent(7, { type: "approval.requested", requestId: "legacy-approval", callId, reason: "Legacy approval" }),
        evidence: {
          observationId: "legacy-observation-2",
          decisionObservationId: "legacy-observation-1",
          assetId: "legacy-asset-2",
          capturedAt: "2026-01-01T00:00:05.000Z",
          viewport: session.viewport,
        },
      },
    ];
    await writeFile(filePath, `${legacyEvents.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");

    try {
      const events = await readRuntimeEvents(filePath);
      const observations = events.filter((item): item is Extract<RuntimeEvent, { type: "observation.created" }> => item.type === "observation.created");
      expect(observations).toHaveLength(2);
      expect(observations[0]?.observation.surfaceRef).toMatchObject({ generation: 0, kind: "unknown" });
      expect(observations[1]?.observation.surfaceRef).toEqual(observations[0]?.observation.surfaceRef);
      expect(observations[0]?.observation.grounding?.surfaceRef).toEqual(observations[0]?.observation.surfaceRef);
      expect(events.find((item) => item.type === "action.guard.evaluated")).toMatchObject({ evaluatedSurfaceRef: observations[0]?.observation.surfaceRef });
      expect(events.find((item) => item.type === "approval.requested")).toMatchObject({ evidence: { surfaceRef: observations[0]?.observation.surfaceRef } });

      const snapshot = reduceRuntimeEvents(events, runId);
      expect(snapshot.activeSurfaceRef).toEqual(observations[0]?.observation.surfaceRef);
      expect(snapshot.surfaceLineage).toHaveLength(1);
      expect(snapshot.surfaceLineage[0]).toMatchObject({ reason: "legacy_observation", to: observations[0]?.observation.surfaceRef });
      expect(snapshot.status).toBe("waiting_approval");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not migrate an incomplete current-version Observation into a guessed desktop", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-current-surface-schema-"));
    const filePath = join(directory, "current.jsonl");
    const currentVersionWithoutSurface = {
      ...event(0, { type: "observation.created", observation: {} as never }),
      schemaVersion: 2,
      observation: {
        id: observationId,
        runId,
        computerSessionId: session.id,
        capturedAt: "2026-01-01T00:00:00.000Z",
        viewport: session.viewport,
        screenshot: { assetId: "asset-current" as AssetId, relativePath: "assets/current.png", mediaType: "image/png", byteLength: 1 },
      },
    };
    await writeFile(filePath, `${JSON.stringify(currentVersionWithoutSurface)}\n`, "utf8");
    try {
      await expect(readRuntimeEvents(filePath)).rejects.toThrow(/surfaceRef/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("replays a pre-Surface JSONL switch that changed ComputerSession IDs as an unknown alias only", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-legacy-switch-alias-"));
    const filePath = join(directory, "pre-surface-switch.jsonl");
    const legacyTargetSession: ComputerSessionDescriptor = {
      ...session,
      id: "legacy-window-session" as ComputerSessionId,
      viewport: { width: 640, height: 480, coordinateSpace: "physical" },
    };
    const legacyEvent = (sequence: number, data: Record<string, unknown>) => ({
      eventId: `legacy-switch-event-${sequence}`,
      runId,
      sequence,
      occurredAt: `2026-01-01T00:00:0${sequence}.000Z`,
      ...data,
    });
    const legacyEvents: unknown[] = [
      legacyEvent(0, { type: "run.created", goal: "replay an old target switch" }),
      legacyEvent(1, { type: "run.started" }),
      legacyEvent(2, { type: "computer.open.started" }),
      legacyEvent(3, { type: "computer.open.completed", session }),
      legacyEvent(4, {
        type: "observation.created",
        observation: {
          id: "legacy-source-observation",
          runId,
          computerSessionId: session.id,
          capturedAt: "2026-01-01T00:00:04.000Z",
          viewport: session.viewport,
          screenshot: { assetId: "legacy-source-asset", relativePath: "assets/legacy-source.png", mediaType: "image/png", byteLength: 1 },
        },
      }),
      legacyEvent(5, {
        type: "action.execution.started",
        action: { actionId: "legacy-switch-action", basedOn: "legacy-source-observation", kind: "switch_window", windowRef: "legacy-target-ref" },
      }),
      legacyEvent(6, {
        type: "action.execution.completed",
        receipt: { actionId: "legacy-switch-action", status: "completed", sessionAfter: legacyTargetSession },
      }),
      legacyEvent(7, {
        type: "observation.created",
        observation: {
          id: "legacy-target-observation",
          runId,
          computerSessionId: legacyTargetSession.id,
          capturedAt: "2026-01-01T00:00:07.000Z",
          viewport: legacyTargetSession.viewport,
          screenshot: { assetId: "legacy-target-asset", relativePath: "assets/legacy-target.png", mediaType: "image/png", byteLength: 1 },
        },
      }),
      legacyEvent(8, { type: "run.finished", outcome: "succeeded" }),
    ];
    await writeFile(filePath, `${legacyEvents.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");

    try {
      const events = await readRuntimeEvents(filePath);
      const observations = events.filter((item): item is Extract<RuntimeEvent, { type: "observation.created" }> => item.type === "observation.created");
      expect(observations.map((item) => item.observation.surfaceRef)).toMatchObject([
        { generation: 0, kind: "unknown" },
        { generation: 0, kind: "unknown" },
      ]);
      expect(observations[0]?.observation.surfaceRef).not.toEqual(observations[1]?.observation.surfaceRef);

      const snapshot = reduceRuntimeEvents(events, runId);
      expect(snapshot.status).toBe("finished");
      expect(snapshot.computerSession?.id).toBe(legacyTargetSession.id);
      expect(snapshot.legacyComputerSessionAliases).toEqual([{
        from: session.id,
        to: legacyTargetSession.id,
        eventId: "legacy-switch-event-6",
      }]);
      expect(snapshot.activeSurfaceRef).toEqual(observations[1]?.observation.surfaceRef);
      expect(snapshot.surfaceLineage.map((entry) => entry.reason)).toEqual(["legacy_observation", "legacy_session_alias"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
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
        surfaceRef: desktopSurfaceRef,
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
    expect(runtimeEventSchema.safeParse({
      ...observation,
      observation: { ...observation.observation, runId, surfaceRef: undefined },
    }).success).toBe(false);

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
      type: "computer.surface.transitioned",
      from: null,
      to: desktopSurfaceRef,
      reason: "initial_observation",
    });
    await writer.append({
      runId,
      type: "observation.created",
      observation: {
        id: observationId,
        runId,
        computerSessionId: "computer-integration" as ComputerSessionId,
        surfaceRef: desktopSurfaceRef,
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
