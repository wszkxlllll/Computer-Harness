import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname, relative as pathRelative, resolve } from "node:path";
import { z } from "zod";
import { reduceMemoryMutation } from "@computer-harness/protocol";
import type {
  ActionId,
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
  pendingApproval?: { requestId: string; callId: ToolCallId; reason: string };
  pendingUserQuestion?: string;
  pendingUserInputRequestId?: EventId;
  pendingWindowHandoff?: { sourceActionId: ActionId; reasonCode: "foreground_mismatch" | "new_window_detected" };
  unresolvedActionId?: ActionId;
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

export function initialRunSnapshot(runId: RunId): RunSnapshot {
  return {
    runId,
    status: "created",
    stepCount: 0,
    modelRequestCount: 0,
    guardEvaluationCount: 0,
    riskModelRequestCount: 0,
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
          snapshot.computerSession.id === event.session.id || snapshot.computerSession.backend !== event.session.backend) {
        throw new Error("window handoff completion requires the pending Computer session");
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
      return {
        ...snapshot,
        status: snapshot.status === "starting" ? "running" : snapshot.status,
        latestObservationId: event.observation.id,
      };
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
      return {
        ...snapshot,
        status: "running",
        unresolvedActionId: event.action.actionId,
      };
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
        event.receipt.status !== "cancelled"
      ) {
        throw new Error(
          `failed action event must carry refused, failed, or cancelled receipt, got ${event.receipt.status}`,
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
        const { unresolvedActionId: _unresolvedActionId, ...withoutUnresolvedAction } = snapshot;
        return {
          ...withoutUnresolvedAction,
          status: "running",
          stepCount: snapshot.stepCount + 1,
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
        const { pendingApproval: _pendingApproval, pendingUserQuestion: _pendingUserQuestion, pendingWindowHandoff: _pendingWindowHandoff, ...withoutPending } =
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
      eventId: draft.eventId ?? this.idFactory.next(),
      sequence: this.nextSequence,
      occurredAt: draft.occurredAt ?? new Date().toISOString(),
    };
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
  z.object({ actionId: nonEmptyString, kind: z.literal("wait"), durationMs: z.number().finite().nonnegative() }),
]);
const actionReceiptSchema = z.object({
  actionId: nonEmptyString,
  status: z.enum(["completed", "refused", "failed", "cancelled"]),
  driverCode: nonEmptyString.optional(),
  message: z.string().optional(),
});
const completedActionReceiptSchema = actionReceiptSchema.extend({ status: z.literal("completed") });
const failedActionReceiptSchema = actionReceiptSchema.extend({
  status: z.enum(["refused", "failed", "cancelled"]),
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
  z.object({ actionId: nonEmptyString, kind: z.literal("wait"), durationMs: z.number().finite().nonnegative() }),
]);
const eventBaseSchema = {
  eventId: nonEmptyString,
  runId: nonEmptyString,
  sequence: z.number().int().nonnegative(),
  occurredAt: nonEmptyString,
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

export async function readRuntimeEvents(filePath: string): Promise<RuntimeEvent[]> {
  const content = await readFile(filePath, "utf8");
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
    events.push(parseRuntimeEvent(parsed, index + 1));
    return events;
  }, []);
}
