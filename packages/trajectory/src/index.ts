import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname, relative as pathRelative, resolve } from "node:path";
import { z } from "zod";
import { reduceMemoryMutation } from "@computer-harness/protocol";
import type {
  ActionId,
  ActionIntent,
  AssetId,
  AssetRef,
  ComputerSessionDescriptor,
  EventId,
  JsonValue,
  ObservationId,
  RunId,
  RunOutcome,
  RunStatus,
  PlanState,
  ExecutionSegment,
  MemoryState,
  RuntimeEvent,
  RuntimeEventDraft,
  SurfaceId,
  SurfaceRef,
  SurfaceTransitionReason,
  ToolCallId,
  ModelUsage,
} from "@computer-harness/protocol";

export interface RunSnapshot {
  runId: RunId;
  goal?: string;
  status: RunStatus;
  outcome?: RunOutcome;
  stepCount: number;
  modelRequestCount: number;
  guardEvaluationCount: number;
  riskModelRequestCount: number;
  latestObservationId?: ObservationId;
  activeSurfaceRef?: SurfaceRef;
  surfaceLineage: SurfaceLineageEntry[];
  pendingSurfaceTransition?: SurfaceRef;
  /** Run-lifetime high-water marks; preserved in finished snapshots for deterministic replay/audit. */
  surfaceGenerationHighWater: Record<string, number>;
  /** Immutable direct-parent fact per SurfaceId; never projected into Provider Context. */
  surfaceParentsById: Record<string, string | null>;
  /** Decoder-only compatibility aliases; they do not authorize live session reuse. */
  legacyComputerSessionAliases: Array<{ readonly from: string; readonly to: string; readonly eventId: EventId }>;
  pendingApproval?: { requestId: string; callId: ToolCallId; reason: string };
  pendingUserQuestion?: string;
  pendingUserInputRequestId?: EventId;
  pendingWindowHandoff?: { sourceActionId: ActionId; reasonCode: "foreground_mismatch" | "new_window_detected" };
  unresolvedActionId?: ActionId;
  /** Internal reducer binding used to validate kind-specific terminal receipt data. */
  unresolvedActionKind?: ActionIntent["kind"];
  createdAt?: string;
  computerOpenStartedAt?: string;
  computerSession?: ComputerSessionDescriptor;
  startedAt?: string;
  endedAt?: string;
  summary?: string;
  reportedStatus?: "success" | "failure";
  modelUsage?: ModelUsage;
  plan: PlanState;
  executionSegment?: ExecutionSegment;
  memory: MemoryState;
}

export interface SurfaceLineageEntry {
  readonly from: SurfaceRef | null;
  readonly to: SurfaceRef;
  readonly reason: SurfaceTransitionReason | "legacy_observation" | "legacy_session_alias";
  readonly eventId?: EventId;
}

/** Only objects returned by readRuntimeEvents can enter the pre-v2 replay compatibility paths. */
const decoderMarkedLegacyEvents = new WeakSet<object>();

export function initialRunSnapshot(runId: RunId): RunSnapshot {
  return {
    runId,
    status: "created",
    stepCount: 0,
    modelRequestCount: 0,
    guardEvaluationCount: 0,
    riskModelRequestCount: 0,
    surfaceLineage: [],
    surfaceGenerationHighWater: {},
    surfaceParentsById: {},
    legacyComputerSessionAliases: [],
    plan: { runId, tasks: [] },
    memory: { runId, facts: [], entities: [] },
  };
}

export function reduceRunEvent(snapshot: RunSnapshot, event: RuntimeEvent): RunSnapshot {
  if (event.runId !== snapshot.runId) {
    throw new Error(`event ${event.eventId} belongs to another run`);
  }

  if (snapshot.status === "finished") {
    throw new Error(`run ${snapshot.runId} is finished and cannot accept ${event.type}`);
  }

  if (event.type !== "run.created" && snapshot.createdAt === undefined) {
    throw new Error(`event ${event.type} cannot precede run.created`);
  }
  if (snapshot.pendingSurfaceTransition !== undefined && event.type !== "observation.created" &&
      event.type !== "runtime.error" && event.type !== "run.finished") {
    throw new Error("computer.surface.transitioned must be followed immediately by its matching Observation");
  }

  switch (event.type) {
    case "run.created":
      if (snapshot.createdAt !== undefined || snapshot.status !== "created") {
        throw new Error(`run ${snapshot.runId} was already created`);
      }
      return { ...snapshot, status: "created", goal: event.goal, createdAt: event.occurredAt };
    case "run.started":
      if (snapshot.status !== "created") {
        throw new Error(`run.started requires created status, got ${snapshot.status}`);
      }
      return { ...snapshot, status: "starting", startedAt: event.occurredAt };
    case "computer.open.started":
      if (snapshot.status !== "starting") {
        throw new Error(`computer.open.started requires starting status, got ${snapshot.status}`);
      }
      if (snapshot.computerOpenStartedAt !== undefined || snapshot.computerSession !== undefined) {
        throw new Error("computer.open.started was already committed for this run");
      }
      return { ...snapshot, computerOpenStartedAt: event.occurredAt };
    case "computer.open.completed":
      if (snapshot.status !== "starting") {
        throw new Error(`computer.open.completed requires starting status, got ${snapshot.status}`);
      }
      if (snapshot.computerOpenStartedAt === undefined) {
        throw new Error("computer.open.completed requires computer.open.started");
      }
      if (snapshot.computerSession !== undefined) {
        throw new Error("computer.open.completed was already committed for this run");
      }
      return { ...snapshot, computerSession: event.session };
    case "computer.window.handoff.requested":
      if (snapshot.status !== "running" || snapshot.unresolvedActionId !== undefined || snapshot.computerSession === undefined) {
        throw new Error("window handoff requires a settled action in a running Computer session");
      }
      return { ...snapshot, status: "waiting_window", pendingWindowHandoff: { sourceActionId: event.sourceActionId, reasonCode: event.reasonCode } };
    case "computer.window.handoff.completed":
      if (snapshot.status !== "waiting_window" || snapshot.pendingWindowHandoff === undefined || snapshot.computerSession === undefined ||
          snapshot.computerSession.id !== event.session.id || snapshot.computerSession.backend !== event.session.backend) {
        throw new Error("window handoff completion must retain the active ComputerSession identity");
      }
      {
        const { pendingWindowHandoff: _pendingWindowHandoff, latestObservationId: _latestObservationId, ...rest } = snapshot;
        return { ...rest, status: "running", computerSession: event.session };
      }
    case "computer.window.handoff.ignored":
      if (snapshot.status !== "waiting_window" || snapshot.pendingWindowHandoff?.reasonCode !== "new_window_detected" ||
          snapshot.pendingWindowHandoff.sourceActionId !== event.sourceActionId) {
        throw new Error("only the matching proactive window detection may be ignored");
      }
      {
        const { pendingWindowHandoff: _pendingWindowHandoff, latestObservationId: _latestObservationId, ...rest } = snapshot;
        return { ...rest, status: "running" };
      }
    case "observation.created":
      if (event.observation.runId !== event.runId) {
        throw new Error(
          `observation ${event.observation.id} belongs to run ${event.observation.runId}, not ${event.runId}`,
        );
      }
      if (snapshot.status !== "starting" && snapshot.status !== "running") {
        throw new Error(`observation.created requires an active run, got ${snapshot.status}`);
      }
      if (snapshot.computerSession === undefined) {
        throw new Error("observation.created requires a completed computer.open");
      }
      if (event.observation.computerSessionId !== snapshot.computerSession.id) {
        throw new Error(
          `observation ${event.observation.id} belongs to session ${event.observation.computerSessionId}, not ${snapshot.computerSession.id}`,
        );
      }
      {
        const observedSurfaceRef = event.observation.surfaceRef;
        const pendingTransition = snapshot.pendingSurfaceTransition;
        const activeSurfaceRef = snapshot.activeSurfaceRef;
        const changed = activeSurfaceRef === undefined || !sameSurfaceRef(activeSurfaceRef, observedSurfaceRef);
        if (pendingTransition !== undefined) {
          if (!sameSurfaceRef(pendingTransition, observedSurfaceRef)) {
            throw new Error("observation surfaceRef does not match the pending computer.surface.transitioned event");
          }
        } else if (changed) {
          if (!isDecoderMarkedLegacyEvent(event) || event.schemaVersion === 2) {
            throw new Error("Observation Surface changed without a preceding computer.surface.transitioned event");
          }
        }
        const tracked = trackSurfaceRef(snapshot, observedSurfaceRef);
        const { pendingSurfaceTransition: _pendingSurfaceTransition, ...snapshotWithoutPendingSurfaceTransition } = snapshot;
        return {
          ...snapshotWithoutPendingSurfaceTransition,
          status: snapshot.status === "starting" ? "running" : snapshot.status,
          latestObservationId: event.observation.id,
          activeSurfaceRef: observedSurfaceRef,
          surfaceGenerationHighWater: tracked.surfaceGenerationHighWater,
          surfaceParentsById: tracked.surfaceParentsById,
          surfaceLineage: changed && pendingTransition === undefined
            ? [...snapshot.surfaceLineage, { from: activeSurfaceRef ?? null, to: observedSurfaceRef, reason: "legacy_observation" }]
            : snapshot.surfaceLineage,
        };
      }
    case "computer.surface.transitioned": {
      if (snapshot.status !== "starting" && snapshot.status !== "running") {
        throw new Error(`computer.surface.transitioned requires an active run, got ${snapshot.status}`);
      }
      if (snapshot.computerSession === undefined) throw new Error("computer.surface.transitioned requires a completed computer.open");
      if (snapshot.pendingSurfaceTransition !== undefined) throw new Error("computer.surface.transitioned is waiting for its matching Observation");
      const expectedFrom = snapshot.activeSurfaceRef;
      if (event.from === null ? expectedFrom !== undefined : expectedFrom === undefined || !sameSurfaceRef(event.from, expectedFrom)) {
        throw new Error("computer.surface.transitioned.from does not match the active Surface lineage");
      }
      if (!isValidSurfaceTransition(event.from, event.to, event.reason)) {
        const fromLabel = event.from === null ? "none" : `${event.from.kind}@${event.from.generation}`;
        throw new Error(`computer.surface.transitioned contains an invalid from/to/reason combination (${event.reason}: ${fromLabel} -> ${event.to.kind}@${event.to.generation})`);
      }
      validateSurfaceTransition(snapshot, event.from, event.to, event.reason);
      const fromTracking = event.from === null ? snapshot : trackSurfaceRef(snapshot, event.from);
      const toTracking = trackSurfaceRef(fromTracking, event.to);
      return {
        ...snapshot,
        activeSurfaceRef: event.to,
        pendingSurfaceTransition: event.to,
        surfaceGenerationHighWater: toTracking.surfaceGenerationHighWater,
        surfaceParentsById: toTracking.surfaceParentsById,
        surfaceLineage: [...snapshot.surfaceLineage, { from: event.from, to: event.to, reason: event.reason, eventId: event.eventId }],
      };
    }
    case "model.request.started":
      if (snapshot.status !== "running") {
        throw new Error(`${event.type} requires running status, got ${snapshot.status}`);
      }
      return { ...snapshot, modelRequestCount: snapshot.modelRequestCount + 1 };
    case "model.response.received":
      if (snapshot.status !== "running") {
        throw new Error(`${event.type} requires running status, got ${snapshot.status}`);
      }
      return {
        ...snapshot,
        ...(event.turn.usage === undefined ? {} : { modelUsage: addUsage(snapshot.modelUsage, event.turn.usage) }),
      };
    case "model.request.failed":
    case "tool.call.received":
    case "tool.call.rejected":
    case "tool.call.completed":
    case "tool.call.failed":
    case "action.proposed":
      if (snapshot.status !== "running") {
        throw new Error(`${event.type} requires running status, got ${snapshot.status}`);
      }
    case "grounding.coordinate_coverage":
      if (snapshot.status !== "running") {
        throw new Error(`${event.type} requires running status, got ${snapshot.status}`);
      }
    case "runtime.error":
      return snapshot;
    case "action.guard.evaluated":
      if (snapshot.status !== "running") {
        throw new Error(`action.guard.evaluated requires running status, got ${snapshot.status}`);
      }
      if (snapshot.activeSurfaceRef === undefined || !sameSurfaceRef(event.evaluatedSurfaceRef, snapshot.activeSurfaceRef)) {
        throw new Error("action.guard.evaluated SurfaceRef does not match the active Surface lineage");
      }
      if (snapshot.unresolvedActionId !== undefined || snapshot.pendingApproval !== undefined || snapshot.pendingUserQuestion !== undefined) {
        throw new Error("action.guard.evaluated is not allowed while another action or interaction is pending");
      }
      if (event.callIds.length === 0 || event.actions.length === 0) {
        throw new Error("action.guard.evaluated requires calls and actions");
      }
      return {
        ...snapshot,
        guardEvaluationCount: snapshot.guardEvaluationCount + 1,
        riskModelRequestCount: snapshot.riskModelRequestCount + event.modelRequestCount,
      };
    case "action.execution.started":
      if (snapshot.status !== "running") {
        throw new Error(`action.execution.started requires running status, got ${snapshot.status}`);
      }
      if (snapshot.pendingApproval !== undefined || snapshot.pendingUserQuestion !== undefined) {
        throw new Error("action.execution.started is not allowed while user input or approval is pending");
      }
      if (event.action.kind !== "wait") {
        if (snapshot.latestObservationId === undefined) {
          throw new Error(`action ${event.action.actionId} requires a current observation`);
        }
        const executionObservationId = event.executionObservationId ?? event.action.basedOn;
        if (executionObservationId !== snapshot.latestObservationId) {
          if (event.executionObservationId === undefined) {
            throw new Error(
              `action ${event.action.actionId} is based on ${event.action.basedOn}, not latest observation ${snapshot.latestObservationId}`,
            );
          }
          throw new Error(
            `action ${event.action.actionId} executes against ${executionObservationId}, not latest observation ${snapshot.latestObservationId}`,
          );
        }
      }
      if (snapshot.unresolvedActionId !== undefined) {
        throw new Error(
          `action ${event.action.actionId} started while action ${snapshot.unresolvedActionId} is unresolved`,
        );
      }
      const nextSnapshot: RunSnapshot = {
        ...snapshot,
        status: "running",
        unresolvedActionId: event.action.actionId,
        unresolvedActionKind: event.action.kind,
      };
      if (event.action.kind === "switch_window") delete nextSnapshot.latestObservationId;
      return nextSnapshot;
    case "action.execution.completed":
    case "action.execution.failed":
      if (snapshot.status !== "running") {
        throw new Error(`action terminal event requires running status, got ${snapshot.status}`);
      }
      if (event.type === "action.execution.completed" && event.receipt.status !== "completed") {
        throw new Error(
          `completed action event must carry a completed receipt, got ${event.receipt.status}`,
        );
      }
      if (
        event.type === "action.execution.failed" &&
        event.receipt.status !== "refused" &&
        event.receipt.status !== "failed" &&
        event.receipt.status !== "cancelled" &&
        event.receipt.status !== "partial"
      ) {
        throw new Error(
          `failed action event must carry refused, failed, cancelled, or partial receipt, got ${event.receipt.status}`,
        );
      }
      if (snapshot.unresolvedActionId === undefined) {
        throw new Error(
          `action ${event.receipt.actionId} has a terminal event without action.execution.started`,
        );
      }
      if (snapshot.unresolvedActionId !== event.receipt.actionId) {
        throw new Error(
          `terminal action ${event.receipt.actionId} does not match unresolved action ${snapshot.unresolvedActionId}`,
        );
      }
      {
        const switchingWindow = snapshot.unresolvedActionKind === "switch_window";
        const sessionAfter = "sessionAfter" in event.receipt ? event.receipt.sessionAfter : undefined;
        if (event.type === "action.execution.completed" && switchingWindow && sessionAfter === undefined) {
          throw new Error("a completed switch_window action requires sessionAfter");
        }
        if (sessionAfter !== undefined && (event.type !== "action.execution.completed" || !switchingWindow)) {
          throw new Error("sessionAfter is valid only on a completed switch_window receipt");
        }
        let nextComputerSession = snapshot.computerSession;
        let nextActiveSurfaceRef = snapshot.activeSurfaceRef;
        let nextSurfaceLineage = snapshot.surfaceLineage;
        let nextGenerationHighWater = snapshot.surfaceGenerationHighWater;
        let nextSurfaceParents = snapshot.surfaceParentsById;
        let nextLegacySessionAliases = snapshot.legacyComputerSessionAliases;
        if (sessionAfter !== undefined) {
          if (snapshot.computerSession === undefined || sessionAfter.backend !== snapshot.computerSession.backend) {
            throw new Error("switch_window sessionAfter must retain the active ComputerSession backend");
          }
          if (sessionAfter.id !== snapshot.computerSession.id) {
            if (!isDecoderMarkedLegacyEvent(event)) {
              throw new Error("switch_window sessionAfter must retain the active ComputerSession identity");
            }
            const aliasSurfaceRef = legacyUnknownSurfaceRef(String(snapshot.runId), String(sessionAfter.id));
            const aliasTracking = trackSurfaceRef(snapshot, aliasSurfaceRef);
            nextComputerSession = sessionAfter;
            nextActiveSurfaceRef = aliasSurfaceRef;
            nextSurfaceLineage = [...snapshot.surfaceLineage, {
              from: snapshot.activeSurfaceRef ?? null,
              to: aliasSurfaceRef,
              reason: "legacy_session_alias",
              eventId: event.eventId,
            }];
            nextGenerationHighWater = aliasTracking.surfaceGenerationHighWater;
            nextSurfaceParents = aliasTracking.surfaceParentsById;
            nextLegacySessionAliases = [
              ...snapshot.legacyComputerSessionAliases,
              { from: String(snapshot.computerSession.id), to: String(sessionAfter.id), eventId: event.eventId },
            ];
          } else {
            nextComputerSession = sessionAfter;
          }
        }
        const withoutUnresolvedAction = { ...snapshot };
        delete withoutUnresolvedAction.unresolvedActionId;
        delete withoutUnresolvedAction.unresolvedActionKind;
        if (switchingWindow) delete withoutUnresolvedAction.latestObservationId;
        return {
          ...withoutUnresolvedAction,
          status: "running",
          stepCount: snapshot.stepCount + 1,
          ...(nextComputerSession === undefined ? {} : { computerSession: nextComputerSession }),
          ...(nextActiveSurfaceRef === undefined ? {} : { activeSurfaceRef: nextActiveSurfaceRef }),
          surfaceLineage: nextSurfaceLineage,
          surfaceGenerationHighWater: nextGenerationHighWater,
          surfaceParentsById: nextSurfaceParents,
          legacyComputerSessionAliases: nextLegacySessionAliases,
        };
      }
    case "planning.task.updated": {
      if (snapshot.status !== "running") {
        throw new Error(`planning.task.updated requires running status, got ${snapshot.status}`);
      }
      const previous = snapshot.plan.tasks;
      const index = previous.findIndex((task) => task.id === event.mutation.task.id);
      if (event.mutation.operation === "created") {
        if (index >= 0) throw new Error(`planning task ${event.mutation.task.id} already exists`);
      } else if (index < 0) {
        throw new Error(`planning task ${event.mutation.task.id} does not exist`);
      }
      const tasks = [...previous];
      if (event.mutation.operation === "created") tasks.push(event.mutation.task);
      else tasks[index] = event.mutation.task;
      return { ...snapshot, plan: { runId: snapshot.runId, tasks } };
    }
    case "execution.segment.updated": {
      if (snapshot.status !== "running") {
        throw new Error(`execution.segment.updated requires running status, got ${snapshot.status}`);
      }
      const mutation = event.mutation;
      if (mutation.operation === "set") {
        if (mutation.segment.steps.length < 1 || mutation.segment.steps.length > 4) throw new Error("execution segment must contain 1..4 steps");
        return { ...snapshot, executionSegment: mutation.segment };
      }
      const current = snapshot.executionSegment;
      if (current === undefined || current.id !== mutation.segmentId) throw new Error(`execution segment ${mutation.segmentId} is not active`);
      if (mutation.operation === "step_attempted") {
        if (current.steps[current.cursor]?.id !== mutation.stepId) throw new Error(`execution segment step ${mutation.stepId} is not current`);
        return { ...snapshot, executionSegment: { ...current, attemptedStepIds: [...new Set([...current.attemptedStepIds, mutation.stepId])] } };
      }
      if (mutation.operation === "advanced") {
        if (mutation.cursor < current.cursor || mutation.cursor > current.steps.length) throw new Error("execution segment cursor is invalid");
        if (mutation.cursor > current.cursor) {
          const currentStep = current.steps[current.cursor];
          if (currentStep !== undefined && !current.attemptedStepIds.includes(currentStep.id)) {
            throw new Error(`execution segment step ${currentStep.id} cannot advance before an attempted action`);
          }
        }
        return { ...snapshot, executionSegment: { ...current, cursor: mutation.cursor, status: mutation.status } };
      }
      return { ...snapshot, executionSegment: { ...current, status: "invalidated", invalidReason: mutation.reason } };
    }
    case "memory.updated":
      if (snapshot.status !== "running") {
        throw new Error(`memory.updated requires running status, got ${snapshot.status}`);
      }
      return { ...snapshot, memory: reduceMemoryMutation(snapshot.memory, event.mutation) };
    case "monitor.proposal":
      if (snapshot.status !== "running") {
        throw new Error(`monitor.proposal requires running status, got ${snapshot.status}`);
      }
      return snapshot;
    case "monitor.transition":
      if (snapshot.status !== "running") {
        throw new Error(`monitor.transition requires running status, got ${snapshot.status}`);
      }
      if (snapshot.latestObservationId !== event.postObservationId) {
        throw new Error(
          `monitor.transition must reference the latest observation ${snapshot.latestObservationId ?? "<none>"}, got ${event.postObservationId}`,
        );
      }
      return snapshot;
    case "run.paused":
      if (snapshot.status !== "running") {
        throw new Error(`run.paused requires running status, got ${snapshot.status}`);
      }
      if (snapshot.unresolvedActionId !== undefined) {
        throw new Error("run.paused is not allowed while a GUI action is unresolved");
      }
      return { ...snapshot, status: "paused" };
    case "run.resumed":
      if (snapshot.status !== "paused") {
        throw new Error(`run.resumed requires paused status, got ${snapshot.status}`);
      }
      return { ...snapshot, status: "running" };
    case "approval.requested":
      if (snapshot.status !== "running") {
        throw new Error(`approval.requested requires running status, got ${snapshot.status}`);
      }
      if (event.evidence !== undefined && (snapshot.activeSurfaceRef === undefined || !sameSurfaceRef(event.evidence.surfaceRef, snapshot.activeSurfaceRef))) {
        throw new Error("approval.requested evidence SurfaceRef does not match the active Surface lineage");
      }
      if (snapshot.pendingUserQuestion !== undefined || snapshot.unresolvedActionId !== undefined) {
        throw new Error("approval.requested is not allowed while another interaction is pending");
      }
      if (snapshot.pendingApproval !== undefined) {
        throw new Error(
          `approval ${event.requestId} requested while approval ${snapshot.pendingApproval.requestId} is pending`,
        );
      }
      return {
        ...snapshot,
        status: "waiting_approval",
        pendingApproval: { requestId: event.requestId, callId: event.callId, reason: event.reason },
      };
    case "approval.resolved":
      if (snapshot.status !== "waiting_approval") {
        throw new Error(`approval.resolved requires waiting_approval status, got ${snapshot.status}`);
      }
      if (snapshot.pendingApproval === undefined) {
        throw new Error(`approval ${event.requestId} resolved without approval.requested`);
      }
      if (snapshot.pendingApproval.requestId !== event.requestId) {
        throw new Error(
          `approval ${event.requestId} does not match pending approval ${snapshot.pendingApproval.requestId}`,
        );
      }
      {
        const { pendingApproval: _pendingApproval, ...withoutPendingApproval } = snapshot;
        return { ...withoutPendingApproval, status: "running" };
      }
    case "user.input.requested":
      if (snapshot.status !== "running") {
        throw new Error(`user.input.requested requires running status, got ${snapshot.status}`);
      }
      if (snapshot.pendingApproval !== undefined || snapshot.unresolvedActionId !== undefined) {
        throw new Error("user.input.requested is not allowed while another interaction is pending");
      }
      if (snapshot.pendingUserQuestion !== undefined) {
        throw new Error("user input requested while another question is pending");
      }
      return {
        ...snapshot,
        status: "waiting_user",
        pendingUserQuestion: event.question,
        pendingUserInputRequestId: event.eventId,
      };
    case "user.input.received":
      if (snapshot.status === "waiting_approval") {
        throw new Error("user.input.received cannot bypass pending approval");
      }
      if (snapshot.status !== "waiting_user" && snapshot.status !== "running" && snapshot.status !== "paused") {
        throw new Error(`user.input.received requires running, paused, or waiting_user status, got ${snapshot.status}`);
      }
      {
        const {
          pendingUserQuestion: _pendingUserQuestion,
          pendingUserInputRequestId: _pendingUserInputRequestId,
          ...withoutPendingUserQuestion
        } = snapshot;
        return {
          ...withoutPendingUserQuestion,
          status: snapshot.status === "waiting_user" ? "running" : snapshot.status,
        };
      }
    case "run.finished": {
      if (snapshot.unresolvedActionId !== undefined && event.outcome !== "outcome_unknown") {
        throw new Error("run.finished is not allowed while a GUI action is unresolved");
      }
      if (
        event.outcome === "succeeded" &&
        (snapshot.status !== "running" ||
          snapshot.pendingApproval !== undefined ||
          snapshot.pendingUserQuestion !== undefined)
      ) {
        throw new Error("a succeeded run must be running with no pending interaction");
      }
      // Session close releases backend bindings in the Computer adapter and
      // has no trajectory deletion event. Keep high-water/parent facts and
      // lineage immutable for replay/audit; only an unconsumed transition is
      // cleared when the Run becomes terminal.
      const {
          pendingApproval: _pendingApproval,
          pendingUserQuestion: _pendingUserQuestion,
          pendingWindowHandoff: _pendingWindowHandoff,
          pendingSurfaceTransition: _pendingSurfaceTransition,
          ...withoutPending
        } =
        snapshot;
      return {
        ...withoutPending,
        status: "finished",
        outcome: event.outcome,
        endedAt: event.occurredAt,
        ...(event.summary === undefined ? {} : { summary: event.summary }),
        ...(event.reportedStatus === undefined ? {} : { reportedStatus: event.reportedStatus }),
      };
    }
    default:
      return assertNever(event);
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled runtime event: ${String(value)}`);
}

function addUsage(previous: ModelUsage | undefined, next: ModelUsage): ModelUsage {
  // Cache reads remain on each ModelTurn. A run-level sum would silently
  // treat a response that omitted provider cache details as a zero, so the
  // normalized snapshot intentionally does not claim aggregate coverage.
  return {
    ...(previous?.inputTokens === undefined && next.inputTokens === undefined ? {} : { inputTokens: (previous?.inputTokens ?? 0) + (next.inputTokens ?? 0) }),
    ...(previous?.outputTokens === undefined && next.outputTokens === undefined ? {} : { outputTokens: (previous?.outputTokens ?? 0) + (next.outputTokens ?? 0) }),
    ...(previous?.totalTokens === undefined && next.totalTokens === undefined ? {} : { totalTokens: (previous?.totalTokens ?? 0) + (next.totalTokens ?? 0) }),
  };
}

export interface EventIdFactory {
  next(): EventId;
}

export const randomEventIdFactory: EventIdFactory = {
  next: () => randomUUID() as EventId,
};

export interface RunEventWriter {
  append(draft: RuntimeEventDraft): Promise<RuntimeEvent>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

/** Current durable JSONL event schema. Unversioned/v1 logs use the explicit legacy reader migration. */
export const RUNTIME_EVENT_SCHEMA_VERSION = 2 as const;

export class JsonlRunEventWriter implements RunEventWriter {
  private readonly filePath: string;
  private readonly runId: RunId;
  private readonly idFactory: EventIdFactory;
  private fileHandle: Awaited<ReturnType<typeof open>> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private nextSequence = 0;
  private state: "open" | "closing" | "closed" = "open";
  private closePromise: Promise<void> | undefined;

  public constructor(
    filePath: string,
    runId: RunId,
    idFactory: EventIdFactory = randomEventIdFactory,
  ) {
    this.filePath = resolve(filePath);
    this.runId = runId;
    this.idFactory = idFactory;
  }

  public async append(draft: RuntimeEventDraft): Promise<RuntimeEvent> {
    if (this.state !== "open") {
      throw new Error("event writer is closed");
    }
    if (draft.runId !== this.runId) {
      throw new Error(`event belongs to run ${draft.runId}; writer is bound to ${this.runId}`);
    }
    const event: RuntimeEvent = {
      ...draft,
      schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
      eventId: draft.eventId ?? this.idFactory.next(),
      sequence: this.nextSequence,
      occurredAt: draft.occurredAt ?? new Date().toISOString(),
    };
    assertLiveSurfaceBindings(event);
    this.nextSequence += 1;
    let result: RuntimeEvent | undefined;
    this.queue = this.queue.then(async () => {
      const handle = await this.ensureHandle();
      await handle.appendFile(`${JSON.stringify(event)}\n`, "utf8");
      result = event;
    });
    await this.queue;
    return result as RuntimeEvent;
  }

  public async flush(): Promise<void> {
    await this.queue;
  }

  public async close(): Promise<void> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }
    if (this.state === "closed") {
      return;
    }

    // Linearization point: once close is called, no new append may enter the
    // queue. Appends that already entered remain ahead of the close barrier.
    this.state = "closing";
    this.closePromise = (async () => {
      try {
        await this.flush();
      } finally {
        const handle = this.fileHandle;
        this.fileHandle = undefined;
        try {
          await handle?.close();
        } finally {
          this.state = "closed";
        }
      }
    })();
    return this.closePromise;
  }

  private async ensureHandle(): Promise<NonNullable<JsonlRunEventWriter["fileHandle"]>> {
    if (!this.fileHandle) {
      await mkdir(dirname(this.filePath), { recursive: true });
      try {
        // A trajectory path belongs to one Run. Refuse to silently append a new
        // writer from sequence 0 to an existing Run; resume is a separate API.
        this.fileHandle = await open(this.filePath, "wx");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`trajectory file already exists: ${this.filePath}`);
        }
        throw error;
      }
    }
    return this.fileHandle;
  }
}

export function reduceRuntimeEvents(events: readonly RuntimeEvent[], runId: RunId): RunSnapshot {
  let snapshot = initialRunSnapshot(runId);
  let expectedSequence = 0;
  for (const event of events) {
    if (event.runId !== runId) {
      throw new Error(`event ${event.eventId} belongs to another run`);
    }
    if (event.sequence !== expectedSequence) {
      throw new Error(
        `event ${event.eventId} has sequence ${event.sequence}; expected ${expectedSequence}`,
      );
    }
    snapshot = reduceRunEvent(snapshot, event);
    expectedSequence += 1;
  }
  return snapshot;
}

function sameSurfaceRef(left: SurfaceRef, right: SurfaceRef): boolean {
  return left.surfaceId === right.surfaceId && left.generation === right.generation && left.kind === right.kind &&
    left.parentSurfaceId === right.parentSurfaceId && left.admissionSource === right.admissionSource;
}

function isDecoderMarkedLegacyEvent(event: RuntimeEvent): boolean {
  return decoderMarkedLegacyEvents.has(event);
}

function trackSurfaceRef(
  snapshot: Pick<RunSnapshot, "surfaceGenerationHighWater" | "surfaceParentsById">,
  ref: SurfaceRef,
): Pick<RunSnapshot, "surfaceGenerationHighWater" | "surfaceParentsById"> {
  const surfaceId = String(ref.surfaceId);
  const parentId = ref.parentSurfaceId === undefined ? null : String(ref.parentSurfaceId);
  if (ref.parentSurfaceId === ref.surfaceId) throw new Error("Surface cannot be its own parent");
  if (ref.kind === "unknown" && parentId !== null) throw new Error("legacy unknown Surface cannot claim a parent lineage");
  if ((ref.kind === "browser_tab" || ref.kind === "dom" || ref.kind === "overlay") && parentId === null) {
    throw new Error(`${ref.kind} SurfaceRef requires its registry parentSurfaceId`);
  }
  if (ref.kind === "desktop" && parentId !== null) throw new Error("desktop SurfaceRef cannot have a parent");
  const knownParent = snapshot.surfaceParentsById[surfaceId];
  if (knownParent !== undefined && knownParent !== parentId) {
    throw new Error(`Surface ${surfaceId} changed its immutable parent lineage`);
  }
  const knownGeneration = snapshot.surfaceGenerationHighWater[surfaceId];
  if (knownGeneration !== undefined && ref.generation < knownGeneration) {
    throw new Error(`Surface ${surfaceId} generation regressed from high-water ${knownGeneration} to ${ref.generation}`);
  }
  const surfaceParentsById = { ...snapshot.surfaceParentsById, [surfaceId]: parentId };
  const visited = new Set<string>([surfaceId]);
  let ancestor = parentId;
  while (ancestor !== null) {
    if (visited.has(ancestor)) throw new Error("Surface parent lineage contains a cycle");
    visited.add(ancestor);
    ancestor = surfaceParentsById[ancestor] ?? null;
  }
  return {
    surfaceParentsById,
    surfaceGenerationHighWater: {
      ...snapshot.surfaceGenerationHighWater,
      [surfaceId]: Math.max(knownGeneration ?? -1, ref.generation),
    },
  };
}

function validateSurfaceTransition(
  snapshot: RunSnapshot,
  from: SurfaceRef | null,
  to: SurfaceRef,
  reason: SurfaceTransitionReason,
): void {
  const toId = String(to.surfaceId);
  const highWater = snapshot.surfaceGenerationHighWater[toId];
  if (from === null) {
    if (reason !== "initial_observation" || highWater !== undefined) {
      throw new Error("initial_observation is only valid for the first generation of the initial Surface");
    }
    return;
  }
  const fromId = String(from.surfaceId);
  const fromHighWater = snapshot.surfaceGenerationHighWater[fromId];
  if (fromHighWater !== undefined && from.generation < fromHighWater) {
    throw new Error(`transition source Surface ${fromId} is below its generation high-water`);
  }
  if (highWater !== undefined && to.generation <= highWater) {
    throw new Error(`transition target Surface ${toId} must advance beyond generation high-water ${highWater}`);
  }

  const childPush = to.parentSurfaceId === from.surfaceId;
  const childPop = from.parentSurfaceId === to.surfaceId && snapshot.surfaceParentsById[fromId] === toId;
  const directParentRelation = childPush || childPop;
  switch (reason) {
    case "initial_observation":
      throw new Error("initial_observation requires a null source Surface");
    case "generation_advanced":
      if (from.surfaceId !== to.surfaceId || from.kind !== to.kind || from.parentSurfaceId !== to.parentSurfaceId ||
          from.admissionSource !== to.admissionSource || to.generation <= from.generation) {
        throw new Error("generation_advanced requires the same Surface lineage and a higher generation");
      }
      return;
    case "child_push":
      if (from.surfaceId === to.surfaceId || !childPush) {
        throw new Error("child_push target parentSurfaceId must equal the active source SurfaceId");
      }
      if ((to.kind === "overlay" && to.admissionSource !== "same_hwnd_overlay_root_proof") ||
          (to.kind === "native_window" && to.admissionSource !== "owned_transient_window_root_proof" &&
            to.admissionSource !== "win32_relationship_probe")) {
        throw new Error("transient child_push requires its exact adapter admission source");
      }
      return;
    case "child_pop":
      if (from.surfaceId === to.surfaceId || !childPop) {
        throw new Error("child_pop requires a known direct child-to-parent Surface lineage");
      }
      if ((from.kind === "overlay" && from.admissionSource !== "same_hwnd_overlay_root_proof") ||
          (from.kind === "native_window" && from.parentSurfaceId !== undefined &&
            from.admissionSource !== "owned_transient_window_root_proof" && from.admissionSource !== "win32_relationship_probe")) {
        throw new Error("transient child_pop requires its exact adapter admission source");
      }
      return;
    case "peer_switch":
      if (from.surfaceId === to.surfaceId || directParentRelation) {
        throw new Error("peer_switch requires distinct, non-parent/child Surface peers");
      }
      return;
    case "surface_changed":
      if (from.surfaceId === to.surfaceId || directParentRelation) {
        throw new Error("surface_changed requires distinct non-parent/child Surfaces");
      }
      return;
  }
}

function isValidSurfaceTransition(
  from: SurfaceRef | null,
  to: SurfaceRef,
  reason: SurfaceTransitionReason,
): boolean {
  if (from === null) return reason === "initial_observation";
  if (sameSurfaceRef(from, to)) return false;
  return true;
}

function assertLiveSurfaceRef(value: SurfaceRef | undefined, label: string): asserts value is SurfaceRef {
  if (value === undefined || typeof value.surfaceId !== "string" || value.surfaceId.trim().length === 0 ||
      !Number.isSafeInteger(value.generation) || value.generation < 1 || value.kind === "unknown") {
    throw new Error(`LEGACY_SURFACE_UNRESOLVED: new trajectory event ${label} requires a live generation-bound SurfaceRef`);
  }
}

function assertLiveSurfaceBindings(event: RuntimeEvent): void {
  switch (event.type) {
    case "observation.created":
      assertLiveSurfaceRef(event.observation.surfaceRef, "observation.created");
      if (event.observation.grounding !== undefined) assertLiveSurfaceRef(event.observation.grounding.surfaceRef, "GroundingCatalog");
      return;
    case "computer.surface.transitioned":
      if (event.from !== null) assertLiveSurfaceRef(event.from, "computer.surface.transitioned.from");
      assertLiveSurfaceRef(event.to, "computer.surface.transitioned.to");
      return;
    case "action.guard.evaluated":
      assertLiveSurfaceRef(event.evaluatedSurfaceRef, "action.guard.evaluated");
      return;
    case "approval.requested":
      if (event.evidence !== undefined) assertLiveSurfaceRef(event.evidence.surfaceRef, "approval.requested.evidence");
      return;
    default:
      return;
  }
}

export interface AssetStore {
  put(input: {
    assetId: AssetId;
    relativePath: string;
    mediaType: string;
    data: Uint8Array;
  }): Promise<AssetRef>;
}

export class FileAssetStore implements AssetStore {
  private readonly rootDir: string;

  public constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
  }

  public async put(input: {
    assetId: AssetId;
    relativePath: string;
    mediaType: string;
    data: Uint8Array;
  }): Promise<AssetRef> {
    const relativePath = normalizeAssetPath(input.relativePath);
    const destination = resolve(this.rootDir, relativePath);
    const relativeToRoot = relativePathFromRoot(this.rootDir, destination);
    if (relativeToRoot !== relativePath) {
      throw new Error(`asset path escapes root directory: ${input.relativePath}`);
    }

    await mkdir(dirname(destination), { recursive: true });
    const temporaryPath = `${destination}.tmp-${randomUUID()}`;
    try {
      await open(temporaryPath, "wx").then(async (handle) => {
        try {
          await handle.writeFile(input.data);
        } finally {
          await handle.close();
        }
      });
      // A hard link publishes the fully-written temporary file atomically and
      // fails if the destination already exists; this preserves write-once
      // asset semantics on both Windows and POSIX filesystems.
      try {
        await link(temporaryPath, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`asset already exists: ${destination}`);
        }
        throw error;
      }
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }

    return {
      assetId: input.assetId,
      relativePath,
      mediaType: input.mediaType,
      byteLength: input.data.byteLength,
    };
  }

  public async read(ref: AssetRef, signal: AbortSignal): Promise<Uint8Array> {
    signal.throwIfAborted();
    const relativePath = normalizeAssetPath(ref.relativePath);
    const destination = resolve(this.rootDir, relativePath);
    if (relativePathFromRoot(this.rootDir, destination) !== relativePath) {
      throw new Error(`asset path escapes root directory: ${ref.relativePath}`);
    }
    const metadata = await stat(destination);
    signal.throwIfAborted();
    if (!metadata.isFile()) {
      throw new Error(`asset is not a regular file: ${ref.relativePath}`);
    }
    if (metadata.size !== ref.byteLength) {
      throw new Error(`asset byte length mismatch for ${ref.assetId}: expected ${ref.byteLength}, got ${metadata.size}`);
    }
    signal.throwIfAborted();
    const data = await readFile(destination, { signal });
    signal.throwIfAborted();
    return new Uint8Array(data);
  }
}

function normalizeAssetPath(value: string): string {
  if (!value || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new Error(`asset relativePath must use a non-empty POSIX-relative path: ${value}`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`asset relativePath contains an invalid segment: ${value}`);
  }
  return segments.join("/");
}

function relativePathFromRoot(rootDir: string, destination: string): string {
  return pathRelative(rootDir, destination).replaceAll("\\", "/");
}

const nonEmptyString = z.string().min(1);
const pointSchema = z.object({ x: z.number().finite(), y: z.number().finite() });
const viewportSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  coordinateSpace: z.enum(["physical", "logical", "reference"]),
});
const surfaceRefSchema = z.object({
  surfaceId: nonEmptyString.max(128),
  generation: z.number().int().nonnegative(),
  kind: z.enum(["desktop", "native_window", "browser_tab", "dom", "overlay", "unknown"]),
  parentSurfaceId: nonEmptyString.max(128).optional(),
  admissionSource: z.enum(["same_hwnd_overlay_root_proof", "owned_transient_window_root_proof", "win32_relationship_probe"]).optional(),
}).superRefine((value, context) => {
  if (value.kind === "unknown" ? value.generation !== 0 : value.generation < 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["generation"], message: "only a legacy unknown Surface may use generation 0" });
  }
  if (value.parentSurfaceId === value.surfaceId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["parentSurfaceId"], message: "Surface cannot be its own parent" });
  }
  if ((value.admissionSource === "same_hwnd_overlay_root_proof" && value.kind !== "overlay") ||
      ((value.admissionSource === "owned_transient_window_root_proof" || value.admissionSource === "win32_relationship_probe") &&
        (value.kind !== "native_window" || value.parentSurfaceId === undefined))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["admissionSource"], message: "admission source does not match its transient Surface kind/parent" });
  }
});
const computerSessionSchema = z.object({
  id: nonEmptyString,
  backend: nonEmptyString,
  viewport: viewportSchema,
  capabilities: z.object({
    screenshot: z.boolean(),
    pointer: z.boolean(),
    keyboard: z.boolean(),
    accessibility: z.boolean(),
  }),
  openedAt: nonEmptyString,
});
const computerWindowIdentitySchema = z.object({
  pid: z.number().int().positive(),
  windowId: z.number().int().positive(),
});
const assetRefSchema = z.object({
  assetId: nonEmptyString,
  relativePath: nonEmptyString,
  mediaType: nonEmptyString,
  byteLength: z.number().int().nonnegative(),
});
const groundingBoundingBoxSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
  coordinateSpace: z.literal("physical"),
});
const groundingElementStateSchema = z.object({
  enabled: z.boolean().optional(),
  focused: z.boolean().optional(),
  editable: z.boolean().optional(),
  expanded: z.boolean().optional(),
  selected: z.boolean().optional(),
  valuePresent: z.boolean().optional(),
});
const groundingOptionSchema = z.object({
  text: nonEmptyString.max(160),
  enabled: z.boolean(),
});
const groundingElementSchema = z.object({
  elementRef: nonEmptyString.max(96),
  role: nonEmptyString.max(64),
  name: z.string().max(160).optional(),
  description: z.string().max(240).optional(),
  bbox: groundingBoundingBoxSchema.optional(),
  state: groundingElementStateSchema.optional(),
  source: z.enum(["uia", "dom"]).optional(),
  browserRegion: z.enum(["content", "chrome", "unknown"]).optional(),
  options: z.array(groundingOptionSchema).max(32).optional(),
  optionsTruncated: z.boolean().optional(),
});
const groundingSelectionTraceSchema = z.object({
  strategy: z.enum(["deterministic-lexical-v1", "bounded-fusion-v1"]),
  candidateElementCount: z.number().int().nonnegative(),
  selectedElementRefs: z.array(nonEmptyString.max(96)).max(16),
  truncated: z.boolean(),
  reasons: z.array(z.object({
    elementRef: nonEmptyString.max(96),
    codes: z.array(nonEmptyString.max(64)).max(8),
  })).max(16),
  sourceCounts: z.object({ uia: z.number().int().nonnegative().optional(), dom: z.number().int().nonnegative().optional() }).optional(),
  deduplicatedElementCount: z.number().int().nonnegative().optional(),
  recovery: z.object({
    reason: z.enum(["no_observed_change", "repeated_failure", "repeated_refusal", "unknown_outcome", "action_stall"]),
    attempt: z.number().int().min(1).max(3),
    regionApplied: z.boolean(),
    localIntentApplied: z.boolean(),
    localIntentSource: z.enum(["user_correction", "active_plan", "goal_background", "declared_effect", "provider_hint"]).optional(),
    actionId: nonEmptyString.optional(),
  }).optional(),
});
const groundingCatalogSchema = z.object({
  version: z.enum(["uia-catalog-v1", "grounding-catalog-v2"]),
  source: z.enum(["uia", "dom", "hybrid"]),
  observationId: nonEmptyString,
  computerSessionId: nonEmptyString,
  surfaceRef: surfaceRefSchema,
  completeness: z.enum(["complete", "partial", "unknown"]),
  degraded: z.boolean(),
  maxElements: z.number().int().positive().max(256),
  elements: z.array(groundingElementSchema).max(256),
  selection: groundingSelectionTraceSchema.optional(),
});
const observationSchema = z.object({
  id: nonEmptyString,
  runId: nonEmptyString,
  computerSessionId: nonEmptyString,
  surfaceRef: surfaceRefSchema,
  capturedAt: nonEmptyString,
  viewport: viewportSchema,
  screenshot: assetRefSchema,
  grounding: groundingCatalogSchema.optional(),
});
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);
const modelUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
});
const modelContinuationSchema = z.object({
  providerId: nonEmptyString,
  kind: z.literal("reasoning_content"),
  content: z.string(),
});
const observationAssessmentSchema = z.object({
  observationId: nonEmptyString.max(128),
  actionId: nonEmptyString.max(128),
  actionOutcome: z.enum(["expected_change", "no_effect", "unexpected_change", "uncertain"]),
  evidence: nonEmptyString.max(240),
  progress: z.object({
    kind: z.enum(["milestone", "blocked"]),
    summary: nonEmptyString.max(160),
  }).optional(),
});
const toolCallSchema = z.object({
  id: nonEmptyString,
  name: nonEmptyString,
  arguments: jsonValueSchema,
  declaredEffect: z.object({
    effects: z.array(z.enum(["observe", "navigate", "local_edit", "destructive", "financial", "external_commitment", "sensitive_disclosure", "security_change", "unknown"])).min(1),
    target: nonEmptyString.max(120),
    summary: nonEmptyString.max(240),
  }).optional(),
});
const modelTurnSchema = z.union([
  z.object({
    type: z.literal("tool_calls"),
    calls: z.array(toolCallSchema),
    assistantText: z.string().optional(),
    observationAssessment: observationAssessmentSchema.optional(),
    usage: modelUsageSchema.optional(),
    continuation: modelContinuationSchema.optional(),
  }),
  z.object({ type: z.literal("user_input_required"), question: nonEmptyString, observationAssessment: observationAssessmentSchema.optional(), usage: modelUsageSchema.optional() }),
  z.object({
    type: z.literal("finish"),
    summary: nonEmptyString,
    reportedStatus: z.enum(["success", "failure"]).optional(),
    observationAssessment: observationAssessmentSchema.optional(),
    usage: modelUsageSchema.optional(),
  }),
]);
const actionBaseSchema = {
  actionId: nonEmptyString,
  basedOn: nonEmptyString,
  groundingRef: nonEmptyString.max(96).optional(),
};
const actionIntentSchema = z.discriminatedUnion("kind", [
  z.object({ ...actionBaseSchema, kind: z.literal("click"), point: pointSchema }),
  z.object({ ...actionBaseSchema, kind: z.literal("double_click"), point: pointSchema }),
  z.object({ ...actionBaseSchema, kind: z.literal("right_click"), point: pointSchema }),
  z.object({ ...actionBaseSchema, kind: z.literal("type"), text: z.string() }),
  z.object({
    ...actionBaseSchema,
    kind: z.literal("keypress"),
    keys: z.array(nonEmptyString).min(1),
  }),
  z.object({
    ...actionBaseSchema,
    kind: z.literal("select_option"),
    groundingRef: nonEmptyString.max(96),
    optionText: nonEmptyString.max(160),
  }),
  z.object({
    ...actionBaseSchema,
    kind: z.literal("scroll"),
    point: pointSchema,
    direction: z.enum(["up", "down", "left", "right"]),
    ticks: z.number().int().positive(),
  }),
  z.object({ ...actionBaseSchema, kind: z.literal("drag"), from: pointSchema, to: pointSchema }),
  z.object({ ...actionBaseSchema, kind: z.literal("switch_window"), windowRef: nonEmptyString.max(128) }),
  z.object({ actionId: nonEmptyString, kind: z.literal("wait"), durationMs: z.number().finite().nonnegative() }),
]);
const actionReceiptSchema = z.object({
  actionId: nonEmptyString,
  status: z.enum(["completed", "refused", "failed", "cancelled", "partial"]),
  driverCode: nonEmptyString.optional(),
  message: z.string().optional(),
  sessionAfter: computerSessionSchema.optional(),
});
const completedActionReceiptSchema = actionReceiptSchema.extend({ status: z.literal("completed") });
const failedActionReceiptSchema = actionReceiptSchema.omit({ sessionAfter: true }).extend({
  status: z.enum(["refused", "failed", "cancelled", "partial"]),
  sessionAfter: z.never().optional(),
});
const planningTaskSchema = z.object({
  id: nonEmptyString,
  subject: nonEmptyString,
  description: z.string().optional(),
  status: z.enum(["pending", "in_progress", "completed", "blocked"]),
  blockedBy: z.array(nonEmptyString).optional(),
});
const executionSegmentStepSchema = z.object({
  id: nonEmptyString,
  intent: nonEmptyString.max(240),
  allowedAction: z.literal("click"),
  completion: z.object({
    kind: z.enum(["element_present", "element_selected", "element_expanded", "element_focused"]),
    text: nonEmptyString.max(160),
  }),
});
const executionSegmentSchema = z.object({
  id: nonEmptyString,
  objective: nonEmptyString.max(320),
  steps: z.array(executionSegmentStepSchema).min(1).max(4),
  cursor: z.number().int().nonnegative(),
  status: z.enum(["active", "completed", "invalidated"]),
  sourceObservationId: nonEmptyString,
  computerSessionId: nonEmptyString,
  attemptedStepIds: z.array(nonEmptyString).max(4),
  invalidReason: z.string().max(240).optional(),
});
const executionSegmentMutationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("set"), segment: executionSegmentSchema }),
  z.object({ operation: z.literal("step_attempted"), segmentId: nonEmptyString, stepId: nonEmptyString }),
  z.object({ operation: z.literal("advanced"), segmentId: nonEmptyString, cursor: z.number().int().nonnegative(), status: z.enum(["active", "completed"]) }),
  z.object({ operation: z.literal("invalidated"), segmentId: nonEmptyString, reason: nonEmptyString.max(240) }),
]);
const memoryFactSchema = z.object({
  id: nonEmptyString,
  subject: z.union([
    z.object({ type: z.literal("run") }),
    z.object({ type: z.literal("entity"), entityId: nonEmptyString }),
  ]).default({ type: "run" }),
  key: nonEmptyString,
  value: z.string(),
  sourceEventId: nonEmptyString,
  status: z.enum(["active", "needs_check", "superseded"]),
  scope: z.union([
    z.object({ kind: z.literal("run") }),
    z.object({ kind: z.literal("computer_session"), sessionId: nonEmptyString }),
  ]).optional(),
  retentionClass: z.enum(["stable", "task", "short_lived"]).optional(),
  statusReason: z.enum(["manual_review", "scope_ended"]).optional(),
  relatedTaskIds: z.array(nonEmptyString).optional(),
  updatedSequence: z.number().int().nonnegative(),
});
const memoryEntitySchema = z.object({
  id: nonEmptyString,
  type: nonEmptyString,
  description: z.string(),
  sourceEventId: nonEmptyString.default("legacy:entity-source"),
  status: z.enum(["active", "stale", "superseded"]),
  relatedTaskIds: z.array(nonEmptyString).optional(),
  updatedSequence: z.number().int().nonnegative(),
});
const memoryMutationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("upsert_fact"), fact: memoryFactSchema }),
  z.object({ operation: z.literal("supersede_fact"), factId: nonEmptyString, replacement: memoryFactSchema.optional() }),
  z.object({ operation: z.literal("mark_fact_needs_check"), factId: nonEmptyString, reason: z.enum(["manual_review", "scope_ended"]).optional() }),
  z.object({ operation: z.literal("upsert_entity"), entity: memoryEntitySchema }),
  z.object({ operation: z.literal("invalidate_entity"), entityId: nonEmptyString }),
]);
const actionGuardSummarySchema = z.discriminatedUnion("kind", [
  z.object({ ...actionBaseSchema, kind: z.literal("click"), point: pointSchema }),
  z.object({ ...actionBaseSchema, kind: z.literal("double_click"), point: pointSchema }),
  z.object({ ...actionBaseSchema, kind: z.literal("right_click"), point: pointSchema }),
  z.object({ ...actionBaseSchema, kind: z.literal("type"), textLength: z.number().int().nonnegative() }),
  z.object({ ...actionBaseSchema, kind: z.literal("keypress"), keys: z.array(nonEmptyString).min(1) }),
  z.object({ ...actionBaseSchema, kind: z.literal("select_option"), groundingRef: nonEmptyString.max(96), optionText: nonEmptyString.max(160) }),
  z.object({ ...actionBaseSchema, kind: z.literal("scroll"), point: pointSchema, direction: z.enum(["up", "down", "left", "right"]), ticks: z.number().int().positive() }),
  z.object({ ...actionBaseSchema, kind: z.literal("drag"), from: pointSchema, to: pointSchema }),
  z.object({ ...actionBaseSchema, kind: z.literal("switch_window"), windowRef: nonEmptyString.max(128) }),
  z.object({ actionId: nonEmptyString, kind: z.literal("wait"), durationMs: z.number().finite().nonnegative() }),
]);
const eventBaseSchema = {
  eventId: nonEmptyString,
  runId: nonEmptyString,
  sequence: z.number().int().nonnegative(),
  occurredAt: nonEmptyString,
  schemaVersion: z.union([z.literal(1), z.literal(2)]).optional(),
};
const contextTraceSchema = z.object({
  compilerVersion: nonEmptyString,
  runId: nonEmptyString,
  stablePrefixHash: nonEmptyString,
  fixedBlocks: z.array(z.object({
    name: z.enum(["system", "goal", "tools", "plan", "execution_segment", "memory"]),
    estimatedTokens: z.number().int().nonnegative(),
    included: z.boolean(),
  })),
  selectedEventIds: z.array(nonEmptyString),
  projectedEventIds: z.array(nonEmptyString).optional(),
  discardedEvents: z.array(z.object({ eventId: nonEmptyString, reason: z.enum(["history_limit", "input_budget"]) })),
  authoritativeUserEventIds: z.array(nonEmptyString),
  historyEstimatedTokens: z.number().int().nonnegative(),
  historyBudgetTokens: z.number().int().nonnegative().optional(),
  memoryEstimatedTokens: z.number().int().nonnegative().optional(),
  memoryTruncated: z.boolean().optional(),
  memorySelection: z.object({
    admittedFactIds: z.array(nonEmptyString),
    revalidationFactIds: z.array(nonEmptyString),
    selectedAdmittedFactIds: z.array(nonEmptyString).optional(),
    selectedRevalidationFactIds: z.array(nonEmptyString).optional(),
    omitted: z.array(z.object({ id: nonEmptyString, class: z.enum(["admitted", "revalidation"]), reason: z.enum(["budget", "not_rendered"]) })).optional(),
    excluded: z.array(z.object({ kind: z.enum(["fact", "entity"]), id: nonEmptyString, reason: z.enum(["superseded", "scope_mismatch", "entity_stale", "entity_missing"]) })),
  }).optional(),
  memoryRetrieval: z.object({
    method: z.enum(["lexical", "hybrid"]),
    semanticStatus: z.enum(["used", "disabled", "not_needed", "unavailable", "timed_out"]),
    stateStable: z.boolean(),
    embeddingBudgetUsed: z.number().int().nonnegative(),
    embeddingBudgetLimit: z.number().int().nonnegative(),
    admitted: z.array(z.object({ id: nonEmptyString, score: z.number().finite(), match: z.enum(["exact", "lexical", "semantic"]) })),
    revalidation: z.array(z.object({ id: nonEmptyString, score: z.number().finite(), match: z.enum(["exact", "lexical", "semantic"]), reason: z.enum(["needs_check", "short_lived_last_known"]).optional() })),
  }).optional(),
  grounding: z.object({
    present: z.boolean(),
    projected: z.boolean(),
    truncated: z.boolean(),
    completeness: z.enum(["complete", "partial", "unknown"]),
    candidateElementCount: z.number().int().nonnegative(),
    projectedElementCount: z.number().int().nonnegative(),
    estimatedTokens: z.number().int().nonnegative(),
    strategy: z.enum(["deterministic-lexical-v1", "bounded-fusion-v1", "adapter-bounded-v1"]).optional(),
    source: z.enum(["uia", "dom", "hybrid"]).optional(),
    sourceCounts: z.object({ uia: z.number().int().nonnegative().optional(), dom: z.number().int().nonnegative().optional() }).optional(),
    deduplicatedElementCount: z.number().int().nonnegative().optional(),
    selectedElementRefs: z.array(nonEmptyString.max(96)).max(16).optional(),
    selectionReasons: z.array(z.object({
      elementRef: nonEmptyString.max(96),
      codes: z.array(nonEmptyString.max(64)).max(8),
    })).max(16).optional(),
    recovery: z.object({
      reason: z.enum(["no_observed_change", "repeated_failure", "repeated_refusal", "unknown_outcome", "action_stall"]),
      attempt: z.number().int().min(1).max(3),
      regionApplied: z.boolean(),
      localIntentApplied: z.boolean(),
      localIntentSource: z.enum(["user_correction", "active_plan", "goal_background", "declared_effect", "provider_hint"]).optional(),
      actionId: nonEmptyString.optional(),
    }).optional(),
  }).optional(),
  assistantPreferences: z.object({
    projectionVersion: z.literal(1),
    included: z.boolean(),
    omittedReason: z.literal("budget").optional(),
    estimatedTokens: z.number().int().nonnegative(),
    responseDetail: z.enum(["concise", "standard", "detailed"]),
    stepExplanation: z.enum(["standard", "more"]),
    preferredLanguage: z.enum(["follow_conversation", "zh-CN", "en"]),
    additionalGuidancePresent: z.boolean(),
    additionalGuidanceCharacters: z.number().int().nonnegative(),
    additionalGuidanceSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  }).optional(),
  observationIncluded: z.boolean(),
  monitorGuidanceIncluded: z.boolean().optional(),
  monitorGuidanceOmittedReason: z.literal("budget").optional(),
  preparedRequest: z.object({
    payloadHash: nonEmptyString,
    estimate: z.object({
      estimatedTextTokens: z.number().int().nonnegative(),
      imageCount: z.number().int().nonnegative(),
      estimationMethod: z.enum(["context_report", "provider_projection"]),
    }).optional(),
  }).optional(),
});

const runtimeEventUnionSchema = z.discriminatedUnion("type", [
  z.object({ ...eventBaseSchema, type: z.literal("run.created"), goal: nonEmptyString }),
  z.object({ ...eventBaseSchema, type: z.literal("run.started") }),
  z.object({ ...eventBaseSchema, type: z.literal("computer.open.started") }),
  z.object({
    ...eventBaseSchema,
    type: z.literal("computer.open.completed"),
    session: computerSessionSchema,
  }),
  z.object({ ...eventBaseSchema, type: z.literal("computer.window.handoff.requested"), sourceActionId: nonEmptyString, reasonCode: z.enum(["foreground_mismatch", "new_window_detected"]) }),
  z.object({ ...eventBaseSchema, type: z.literal("computer.window.handoff.completed"), target: computerWindowIdentitySchema, session: computerSessionSchema }),
  z.object({ ...eventBaseSchema, type: z.literal("computer.window.handoff.ignored"), sourceActionId: nonEmptyString }),
  z.object({ ...eventBaseSchema, type: z.literal("observation.created"), observation: observationSchema }),
  z.object({
    ...eventBaseSchema,
    type: z.literal("computer.surface.transitioned"),
    from: surfaceRefSchema.nullable(),
    to: surfaceRefSchema,
    reason: z.enum(["initial_observation", "peer_switch", "child_push", "child_pop", "generation_advanced", "surface_changed"]),
  }),
  z.object({
    ...eventBaseSchema,
    type: z.literal("model.request.started"),
    providerId: nonEmptyString,
    requestId: nonEmptyString.optional(),
    decisionId: nonEmptyString.optional(),
    attempt: z.number().int().positive().optional(),
    preparedRequest: z.object({
      payloadHash: nonEmptyString,
      estimate: z.object({
        estimatedTextTokens: z.number().int().nonnegative(),
        imageCount: z.number().int().nonnegative(),
        estimationMethod: z.enum(["context_report", "provider_projection"]),
      }).optional(),
    }).optional(),
    contextBudget: z.object({
      mode: z.enum(["raw", "recent"]),
      estimatedInputTokens: z.number().int().nonnegative(),
      estimatedFixedTextTokens: z.number().int().nonnegative().optional(),
      estimatedHistoryTextTokens: z.number().int().nonnegative().optional(),
      estimatedToolSchemaTokens: z.number().int().nonnegative().optional(),
      imageCount: z.number().int().nonnegative().optional(),
      selectedHistoryEvents: z.number().int().nonnegative(),
      omittedHistoryEvents: z.number().int().nonnegative(),
      maxHistoryEvents: z.number().int().positive().optional(),
      maxInputTokens: z.number().int().positive().optional(),
      estimatedMemoryTokens: z.number().int().nonnegative().optional(),
      memoryMaxTokens: z.number().int().positive().optional(),
      estimatedMonitorGuidanceTokens: z.number().int().nonnegative().optional(),
      monitorGuidanceIncluded: z.boolean().optional(),
      estimatedGroundingTokens: z.number().int().nonnegative().optional(),
      groundingIncluded: z.boolean().optional(),
      trace: contextTraceSchema.optional(),
    }).optional(),
  }),
  z.object({ ...eventBaseSchema, type: z.literal("model.response.received"), requestId: nonEmptyString.optional(), decisionId: nonEmptyString.optional(), attempt: z.number().int().positive().optional(), turn: modelTurnSchema }),
  z.object({
    ...eventBaseSchema,
    type: z.literal("model.request.failed"),
    category: nonEmptyString,
    message: z.string(),
    code: nonEmptyString.optional(),
    retryable: z.boolean().optional(),
    requestId: nonEmptyString.optional(),
    decisionId: nonEmptyString.optional(),
    attempt: z.number().int().positive().optional(),
  }),
  z.object({ ...eventBaseSchema, type: z.literal("tool.call.received"), call: toolCallSchema }),
  z.object({
    ...eventBaseSchema,
    type: z.literal("tool.call.rejected"),
    callId: nonEmptyString,
    reason: z.string(),
  }),
  z.object({
    ...eventBaseSchema,
    type: z.literal("tool.call.completed"),
    result: z.object({
      callId: nonEmptyString,
      status: z.literal("completed"),
      output: jsonValueSchema,
    }),
  }),
  z.object({
    ...eventBaseSchema,
    type: z.literal("tool.call.failed"),
    result: z.object({
      callId: nonEmptyString,
      status: z.literal("failed"),
      error: z.object({ code: nonEmptyString, message: z.string() }),
    }),
  }),
  z.object({
    ...eventBaseSchema,
    type: z.literal("action.proposed"),
    callId: nonEmptyString,
    action: actionIntentSchema,
    executionObservationId: nonEmptyString.optional(),
  }),
  z.object({
    ...eventBaseSchema,
    type: z.literal("grounding.coordinate_coverage"),
    actionId: nonEmptyString,
    observationId: nonEmptyString,
    decisionSource: z.literal("main_provider").optional(),
    mapping: z.enum(["containment", "nearest", "none"]),
    matchedElementRef: nonEmptyString.max(96).optional(),
    inHotProjection: z.boolean(),
    normalizedDistance: z.number().finite().nonnegative().optional(),
  }),
  z.object({
    ...eventBaseSchema,
    type: z.literal("action.guard.evaluated"),
    evaluatedSurfaceRef: surfaceRefSchema,
    callIds: z.array(nonEmptyString).min(1),
    actions: z.array(actionGuardSummarySchema).min(1),
    decision: z.enum(["allow", "require_approval", "deny"]),
    categories: z.array(z.enum(["destructive", "financial", "external_commitment", "privacy_account", "intent_violation"])),
    reasonCode: nonEmptyString,
    reason: z.string(),
    path: z.enum(["local", "model", "fallback"]),
    policyVersion: nonEmptyString,
    assessorId: nonEmptyString.optional(),
    semanticEffects: z.array(z.enum(["observe", "navigate", "local_edit", "destructive", "financial", "external_commitment", "sensitive_disclosure", "security_change", "unknown"])).optional(),
    alignment: z.enum(["aligned", "conflicts", "unclear"]).optional(),
    modelRequestCount: z.number().int().nonnegative(),
    latencyMs: z.number().finite().nonnegative().optional(),
    usage: modelUsageSchema.optional(),
  }),
  z.object({ ...eventBaseSchema, type: z.literal("action.execution.started"), action: actionIntentSchema, executionObservationId: nonEmptyString.optional() }),
  z.object({
    ...eventBaseSchema,
    type: z.literal("action.execution.completed"),
    receipt: completedActionReceiptSchema,
  }),
  z.object({
    ...eventBaseSchema,
    type: z.literal("action.execution.failed"),
    receipt: failedActionReceiptSchema,
  }),
  z.object({
    ...eventBaseSchema,
    type: z.literal("planning.task.updated"),
    callId: nonEmptyString,
    mutation: z.discriminatedUnion("operation", [
      z.object({ operation: z.literal("created"), task: planningTaskSchema }),
      z.object({ operation: z.literal("updated"), task: planningTaskSchema }),
    ]),
  }),
  z.object({
    ...eventBaseSchema,
    type: z.literal("execution.segment.updated"),
    callId: nonEmptyString.optional(),
    source: z.enum(["tool", "runtime"]),
    mutation: executionSegmentMutationSchema,
  }),
  z.object({
    ...eventBaseSchema,
    type: z.literal("memory.updated"),
    callId: nonEmptyString.optional(),
    source: z.enum(["tool", "lifecycle"]).optional(),
    mutation: memoryMutationSchema,
  }),
  z.object({
    ...eventBaseSchema,
    type: z.literal("monitor.proposal"),
    mode: z.enum(["shadow", "guidance"]),
    proposal: z.enum(["candidate", "guidance", "help_requested", "suppressed_by_execution_barrier"]),
    fingerprint: nonEmptyString,
    sourceEventIds: z.array(nonEmptyString).max(12),
    reasonCodes: z.array(nonEmptyString).max(8),
    evidenceKinds: z.array(nonEmptyString).max(8),
    modelDecisionCount: z.number().int().nonnegative(),
    guiActionCount: z.number().int().nonnegative(),
    guidanceText: z.string().max(240).optional(),
  }),
  z.object({
    ...eventBaseSchema,
    type: z.literal("monitor.transition"),
    actionId: nonEmptyString,
    preObservationId: nonEmptyString.optional(),
    postObservationId: nonEmptyString,
    sourceActionEventId: nonEmptyString,
    sourceObservationEventId: nonEmptyString,
    transition: z.enum(["changed", "unchanged", "unknown"]),
  }),
  z.object({ ...eventBaseSchema, type: z.literal("run.paused"), reason: z.string() }),
  z.object({ ...eventBaseSchema, type: z.literal("run.resumed") }),
  z.object({
    ...eventBaseSchema,
    type: z.literal("approval.requested"),
    requestId: nonEmptyString,
    callId: nonEmptyString,
    reason: z.string(),
    requiresVisualReview: z.boolean().optional(),
    evidence: z.object({
      observationId: nonEmptyString,
      decisionObservationId: nonEmptyString,
      assetId: nonEmptyString,
      capturedAt: nonEmptyString,
      viewport: viewportSchema,
      surfaceRef: surfaceRefSchema,
    }).optional(),
    actions: z.array(actionGuardSummarySchema).optional(),
  }),
  z.object({
    ...eventBaseSchema,
    type: z.literal("approval.resolved"),
    requestId: nonEmptyString,
    approved: z.boolean(),
  }),
  z.object({ ...eventBaseSchema, type: z.literal("user.input.requested"), question: nonEmptyString }),
  z.object({ ...eventBaseSchema, type: z.literal("user.input.received"), text: z.string() }),
  z.object({ ...eventBaseSchema, type: z.literal("runtime.error"), category: nonEmptyString, message: z.string() }),
  z.object({
    ...eventBaseSchema,
    type: z.literal("run.finished"),
    outcome: z.enum(["succeeded", "failed", "cancelled", "budget_exhausted", "outcome_unknown"]),
    summary: z.string().optional(),
    reportedStatus: z.enum(["success", "failure"]).optional(),
  }),
]);

export const runtimeEventSchema = runtimeEventUnionSchema.superRefine((event, context) => {
  if (event.schemaVersion === 2) {
    const refs: Array<{ path: (string | number)[]; value: z.infer<typeof surfaceRefSchema> }> = [];
    if (event.type === "observation.created") {
      refs.push({ path: ["observation", "surfaceRef"], value: event.observation.surfaceRef });
      if (event.observation.grounding !== undefined) refs.push({ path: ["observation", "grounding", "surfaceRef"], value: event.observation.grounding.surfaceRef });
    } else if (event.type === "computer.surface.transitioned") {
      if (event.from !== null) refs.push({ path: ["from"], value: event.from });
      refs.push({ path: ["to"], value: event.to });
    } else if (event.type === "action.guard.evaluated") {
      refs.push({ path: ["evaluatedSurfaceRef"], value: event.evaluatedSurfaceRef });
    } else if (event.type === "approval.requested" && event.evidence !== undefined) {
      refs.push({ path: ["evidence", "surfaceRef"], value: event.evidence.surfaceRef });
    }
    for (const { path, value } of refs) {
      if (value.kind === "unknown") {
        context.addIssue({ code: z.ZodIssueCode.custom, path, message: "schemaVersion 2 cannot contain replay-only unknown SurfaceRefs" });
      }
      if ((value.kind === "browser_tab" || value.kind === "dom" || value.kind === "overlay") && value.parentSurfaceId === undefined) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [...path, "parentSurfaceId"], message: `${value.kind} SurfaceRef requires parentSurfaceId in schemaVersion 2` });
      }
      if (value.kind === "desktop" && value.parentSurfaceId !== undefined) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [...path, "parentSurfaceId"], message: "desktop SurfaceRef cannot have parentSurfaceId" });
      }
    }
  }
  if (event.type === "observation.created" && event.observation.runId !== event.runId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["observation", "runId"],
      message: "observation.runId must match event.runId",
    });
  }
  if (event.type === "memory.updated") {
    if (event.source === "lifecycle" && event.callId !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["callId"], message: "lifecycle memory.updated must not masquerade as a ToolCall" });
    }
    if (event.source !== "lifecycle" && event.callId === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["callId"], message: "tool memory.updated requires callId" });
    }
  }
});

function parseRuntimeEvent(value: unknown, lineNumber: number): RuntimeEvent {
  const result = runtimeEventSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.length ? ` (${issue.path.join(".")})` : "";
    throw new Error(
      `invalid runtime event at line ${lineNumber}: ${issue?.message ?? "schema validation failed"}${path}`,
    );
  }
  return result.data as unknown as RuntimeEvent;
}

interface LegacySurfaceDecodeState {
  readonly lastSessionByRun: Map<string, string>;
  readonly sessionByObservation: Map<string, string>;
}

function legacyUnknownSurfaceRef(runId: string, sessionId: string): SurfaceRef {
  const digest = createHash("sha256").update(`${runId}\u0000${sessionId}`).digest("hex").slice(0, 24);
  return { surfaceId: `legacy-unknown-${digest}` as SurfaceId, generation: 0, kind: "unknown" };
}

function migrateLegacyRuntimeEvent(value: unknown, state: LegacySurfaceDecodeState, lineNumber: number): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const event = value as Record<string, unknown>;
  const version = event.schemaVersion;
  if (version !== undefined && (typeof version !== "number" || version < 1 || version > RUNTIME_EVENT_SCHEMA_VERSION)) {
    throw new Error(`unsupported runtime event schema version at line ${lineNumber}`);
  }
  if (version === RUNTIME_EVENT_SCHEMA_VERSION) return value;

  const runId = typeof event.runId === "string" ? event.runId : "unresolved-run";
  if (event.type === "computer.open.completed" && isRecord(event.session) && typeof event.session.id === "string") {
    state.lastSessionByRun.set(runId, event.session.id);
  }
  if (event.type === "observation.created" && isRecord(event.observation)) {
    const observation = event.observation;
    const observationId = typeof observation.id === "string" ? observation.id : undefined;
    const sessionId = typeof observation.computerSessionId === "string"
      ? observation.computerSessionId
      : state.lastSessionByRun.get(runId) ?? "unresolved-session";
    const ref = !requiresLegacyUnknownSurface(observation.surfaceRef)
      ? observation.surfaceRef as unknown as SurfaceRef
      : legacyUnknownSurfaceRef(runId, sessionId);
    const grounding = isRecord(observation.grounding) &&
      (requiresLegacyUnknownSurface(observation.grounding.surfaceRef) || !sameUntrustedSurfaceRef(observation.grounding.surfaceRef, ref))
      ? { ...observation.grounding, surfaceRef: ref }
      : observation.grounding;
    const migratedObservation = {
      ...observation,
      surfaceRef: ref,
      ...(grounding === undefined ? {} : { grounding }),
    };
    if (observationId !== undefined) {
      const key = `${runId}\u0000${observationId}`;
      state.sessionByObservation.set(key, sessionId);
    }
    state.lastSessionByRun.set(runId, sessionId);
    return { ...event, observation: migratedObservation };
  }
  if (event.type === "approval.requested" && isRecord(event.evidence) && requiresLegacyUnknownSurface(event.evidence.surfaceRef)) {
    const decisionId = typeof event.evidence.decisionObservationId === "string" ? event.evidence.decisionObservationId : undefined;
    const sessionId = decisionId === undefined
      ? state.lastSessionByRun.get(runId) ?? "unresolved-session"
      : state.sessionByObservation.get(`${runId}\u0000${decisionId}`) ?? state.lastSessionByRun.get(runId) ?? "unresolved-session";
    return {
      ...event,
      evidence: { ...event.evidence, surfaceRef: legacyUnknownSurfaceRef(runId, sessionId) },
    };
  }
  if (event.type === "action.guard.evaluated" && requiresLegacyUnknownSurface(event.evaluatedSurfaceRef)) {
    return {
      ...event,
      evaluatedSurfaceRef: legacyUnknownSurfaceRef(runId, state.lastSessionByRun.get(runId) ?? "unresolved-session"),
    };
  }
  return value;
}

function requiresLegacyUnknownSurface(value: unknown): boolean {
  if (!isRecord(value) || typeof value.surfaceId !== "string" || value.surfaceId.trim().length === 0 ||
      typeof value.generation !== "number" || !Number.isSafeInteger(value.generation) || typeof value.kind !== "string") return true;
  if (value.parentSurfaceId !== undefined && (typeof value.parentSurfaceId !== "string" ||
      value.parentSurfaceId.trim().length === 0 || value.parentSurfaceId === value.surfaceId)) return true;
  if (value.admissionSource !== undefined && value.admissionSource !== "same_hwnd_overlay_root_proof" &&
      value.admissionSource !== "owned_transient_window_root_proof" && value.admissionSource !== "win32_relationship_probe") return true;
  if ((value.admissionSource === "same_hwnd_overlay_root_proof" && value.kind !== "overlay") ||
      ((value.admissionSource === "owned_transient_window_root_proof" || value.admissionSource === "win32_relationship_probe") &&
        (value.kind !== "native_window" || value.parentSurfaceId === undefined))) return true;
  if (value.kind === "unknown") return value.generation !== 0 || value.parentSurfaceId !== undefined;
  if (value.kind !== "desktop" && value.kind !== "native_window" && value.kind !== "browser_tab" && value.kind !== "dom" && value.kind !== "overlay") return true;
  if (value.generation < 1) return true;
  if ((value.kind === "browser_tab" || value.kind === "dom" || value.kind === "overlay") && value.parentSurfaceId === undefined) return true;
  return value.kind === "desktop" && value.parentSurfaceId !== undefined;
}

function sameUntrustedSurfaceRef(value: unknown, ref: SurfaceRef): boolean {
  return isRecord(value) && value.surfaceId === ref.surfaceId && value.generation === ref.generation &&
    value.kind === ref.kind && value.parentSurfaceId === ref.parentSurfaceId &&
    value.admissionSource === ref.admissionSource;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readRuntimeEvents(filePath: string): Promise<RuntimeEvent[]> {
  const content = await readFile(filePath, "utf8");
  const state: LegacySurfaceDecodeState = {
    lastSessionByRun: new Map(),
    sessionByObservation: new Map(),
  };
  return content.split("\n").reduce<RuntimeEvent[]>((events, line, index) => {
    if (line.trim().length === 0) {
      return events;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(
        `invalid JSON in runtime event at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const sourceVersion = isRecord(parsed) ? parsed.schemaVersion : undefined;
    const migrated = migrateLegacyRuntimeEvent(parsed, state, index + 1);
    const event = parseRuntimeEvent(migrated, index + 1);
    if (sourceVersion === undefined || sourceVersion === 1) decoderMarkedLegacyEvents.add(event);
    events.push(event);
    return events;
  }, []);
}
