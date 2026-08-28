import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, relative as pathRelative, resolve } from "node:path";
import { z } from "zod";
import type {
  ActionId,
  AssetId,
  AssetRef,
  ComputerSessionId,
  EventId,
  JsonValue,
  ObservationId,
  RunId,
  RunOutcome,
  RunStatus,
  RuntimeEvent,
  RuntimeEventDraft,
  ToolCallId,
} from "@computer-harness/protocol";

export interface RunSnapshot {
  runId: RunId;
  status: RunStatus;
  outcome?: RunOutcome;
  stepCount: number;
  latestObservationId?: ObservationId;
  pendingApproval?: { requestId: string; callId: ToolCallId; reason: string };
  pendingUserQuestion?: string;
  unresolvedActionId?: ActionId;
  createdAt?: string;
  computerOpenStartedAt?: string;
  computerSessionId?: ComputerSessionId;
  startedAt?: string;
  endedAt?: string;
}

export function initialRunSnapshot(runId: RunId): RunSnapshot {
  return { runId, status: "created", stepCount: 0 };
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
      return { ...snapshot, status: "created", createdAt: event.occurredAt };
    case "run.started":
      if (snapshot.status !== "created") {
        throw new Error(`run.started requires created status, got ${snapshot.status}`);
      }
      return { ...snapshot, status: "starting", startedAt: event.occurredAt };
    case "computer.open.started":
      if (snapshot.status !== "starting") {
        throw new Error(`computer.open.started requires starting status, got ${snapshot.status}`);
      }
      if (snapshot.computerOpenStartedAt !== undefined || snapshot.computerSessionId !== undefined) {
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
      if (snapshot.computerSessionId !== undefined) {
        throw new Error("computer.open.completed was already committed for this run");
      }
      return { ...snapshot, computerSessionId: event.computerSessionId };
    case "observation.created":
      if (event.observation.runId !== event.runId) {
        throw new Error(
          `observation ${event.observation.id} belongs to run ${event.observation.runId}, not ${event.runId}`,
        );
      }
      if (snapshot.status !== "starting" && snapshot.status !== "running") {
        throw new Error(`observation.created requires an active run, got ${snapshot.status}`);
      }
      if (snapshot.computerSessionId === undefined) {
        throw new Error("observation.created requires a completed computer.open");
      }
      if (event.observation.computerSessionId !== snapshot.computerSessionId) {
        throw new Error(
          `observation ${event.observation.id} belongs to session ${event.observation.computerSessionId}, not ${snapshot.computerSessionId}`,
        );
      }
      return {
        ...snapshot,
        status: snapshot.status === "starting" ? "running" : snapshot.status,
        latestObservationId: event.observation.id,
      };
    case "model.request.started":
    case "model.response.received":
    case "model.request.failed":
    case "tool.call.received":
    case "tool.call.rejected":
    case "tool.call.completed":
    case "tool.call.failed":
    case "action.proposed":
      if (snapshot.status !== "running") {
        throw new Error(`${event.type} requires running status, got ${snapshot.status}`);
      }
    case "runtime.error":
      return snapshot;
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
        if (event.action.basedOn !== snapshot.latestObservationId) {
          throw new Error(
            `action ${event.action.actionId} is based on ${event.action.basedOn}, not latest observation ${snapshot.latestObservationId}`,
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
      };
    case "user.input.received":
      if (snapshot.status === "waiting_approval") {
        throw new Error("user.input.received cannot bypass pending approval");
      }
      if (snapshot.status !== "waiting_user" && snapshot.status !== "running" && snapshot.status !== "paused") {
        throw new Error(`user.input.received requires running, paused, or waiting_user status, got ${snapshot.status}`);
      }
      {
        const { pendingUserQuestion: _pendingUserQuestion, ...withoutPendingUserQuestion } = snapshot;
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
      const { pendingApproval: _pendingApproval, pendingUserQuestion: _pendingUserQuestion, ...withoutPending } =
        snapshot;
      return {
        ...withoutPending,
        status: "finished",
        outcome: event.outcome,
        endedAt: event.occurredAt,
      };
    }
    default:
      return assertNever(event);
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled runtime event: ${String(value)}`);
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
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  coordinateSpace: z.enum(["physical", "logical", "reference"]),
});
const assetRefSchema = z.object({
  assetId: nonEmptyString,
  relativePath: nonEmptyString,
  mediaType: nonEmptyString,
  byteLength: z.number().int().nonnegative(),
});
const observationSchema = z.object({
  id: nonEmptyString,
  runId: nonEmptyString,
  computerSessionId: nonEmptyString,
  capturedAt: nonEmptyString,
  viewport: viewportSchema,
  screenshot: assetRefSchema,
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
const toolCallSchema = z.object({
  id: nonEmptyString,
  name: nonEmptyString,
  arguments: jsonValueSchema,
});
const modelTurnSchema = z.union([
  z.object({
    type: z.literal("tool_calls"),
    calls: z.array(toolCallSchema),
    assistantText: z.string().optional(),
  }),
  z.object({ type: z.literal("user_input_required"), question: nonEmptyString }),
  z.object({ type: z.literal("finish"), summary: nonEmptyString }),
]);
const actionBaseSchema = {
  actionId: nonEmptyString,
  basedOn: nonEmptyString,
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
    kind: z.literal("scroll"),
    deltaX: z.number().finite(),
    deltaY: z.number().finite(),
  }),
  z.object({ ...actionBaseSchema, kind: z.literal("drag"), from: pointSchema, to: pointSchema }),
  z.object({ actionId: nonEmptyString, kind: z.literal("wait"), durationMs: z.number().finite().nonnegative() }),
]);
const actionReceiptSchema = z.object({
  actionId: nonEmptyString,
  status: z.enum(["completed", "refused", "failed", "cancelled"]),
  startedAt: nonEmptyString,
  endedAt: nonEmptyString.optional(),
  durationMs: z.number().finite().nonnegative().optional(),
  driverCode: nonEmptyString.optional(),
  message: z.string().optional(),
});
const completedActionReceiptSchema = actionReceiptSchema.extend({ status: z.literal("completed") });
const failedActionReceiptSchema = actionReceiptSchema.extend({
  status: z.enum(["refused", "failed", "cancelled"]),
});
const eventBaseSchema = {
  eventId: nonEmptyString,
  runId: nonEmptyString,
  sequence: z.number().int().nonnegative(),
  occurredAt: nonEmptyString,
};

const runtimeEventUnionSchema = z.discriminatedUnion("type", [
  z.object({ ...eventBaseSchema, type: z.literal("run.created"), goal: nonEmptyString }),
  z.object({ ...eventBaseSchema, type: z.literal("run.started") }),
  z.object({ ...eventBaseSchema, type: z.literal("computer.open.started") }),
  z.object({
    ...eventBaseSchema,
    type: z.literal("computer.open.completed"),
    computerSessionId: nonEmptyString,
  }),
  z.object({ ...eventBaseSchema, type: z.literal("observation.created"), observation: observationSchema }),
  z.object({ ...eventBaseSchema, type: z.literal("model.request.started"), providerId: nonEmptyString }),
  z.object({ ...eventBaseSchema, type: z.literal("model.response.received"), turn: modelTurnSchema }),
  z.object({
    ...eventBaseSchema,
    type: z.literal("model.request.failed"),
    category: nonEmptyString,
    message: z.string(),
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
      status: z.enum(["failed", "rejected"]),
      error: z.object({ code: nonEmptyString, message: z.string() }),
    }),
  }),
  z.object({ ...eventBaseSchema, type: z.literal("action.proposed"), action: actionIntentSchema }),
  z.object({ ...eventBaseSchema, type: z.literal("action.execution.started"), action: actionIntentSchema }),
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
