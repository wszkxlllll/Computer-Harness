import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, relative as pathRelative, resolve } from "node:path";
import { z } from "zod";
import type {
  ActionId,
  AssetId,
  AssetRef,
  EventId,
  ObservationId,
  RunId,
  RunOutcome,
  RunStatus,
  RuntimeEvent,
  RuntimeEventDraft,
} from "@computer-harness/protocol";

export interface RunSnapshot {
  runId: RunId;
  status: RunStatus;
  outcome?: RunOutcome;
  stepCount: number;
  latestObservationId?: ObservationId;
  pendingApproval?: { requestId: string; reason: string };
  pendingUserQuestion?: string;
  unresolvedActionId?: ActionId;
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

  switch (event.type) {
    case "run.created":
      return { ...snapshot, status: "created" };
    case "run.started":
    case "computer.open.started":
      return { ...snapshot, status: "starting", startedAt: snapshot.startedAt ?? event.occurredAt };
    case "computer.open.completed":
      return snapshot;
    case "observation.created":
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
    case "action.proposed":
    case "runtime.error":
      return snapshot;
    case "action.execution.started":
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
      return { ...snapshot, status: "paused" };
    case "run.resumed":
      return { ...snapshot, status: "running" };
    case "approval.requested":
      if (snapshot.pendingApproval !== undefined) {
        throw new Error(
          `approval ${event.requestId} requested while approval ${snapshot.pendingApproval.requestId} is pending`,
        );
      }
      return {
        ...snapshot,
        status: "waiting_approval",
        pendingApproval: { requestId: event.requestId, reason: event.reason },
      };
    case "approval.resolved":
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
        return event.approved
          ? { ...withoutPendingApproval, status: "running" }
          : { ...withoutPendingApproval, status: "running" };
      }
    case "user.input.requested":
      if (snapshot.pendingUserQuestion !== undefined) {
        throw new Error("user input requested while another question is pending");
      }
      return {
        ...snapshot,
        status: "waiting_user",
        pendingUserQuestion: event.question,
      };
    case "user.input.received":
      {
        const { pendingUserQuestion: _pendingUserQuestion, ...withoutPendingUserQuestion } = snapshot;
        return { ...withoutPendingUserQuestion, status: "running" };
      }
    case "run.finished":
      return {
        ...snapshot,
        status: "finished",
        outcome: event.outcome,
        endedAt: event.occurredAt,
      };
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
  private closed = false;

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
    if (this.closed) {
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
    if (this.closed) {
      return;
    }
    await this.flush();
    this.closed = true;
    await this.fileHandle?.close();
    this.fileHandle = undefined;
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
const toolCallSchema = z.object({
  id: nonEmptyString,
  name: nonEmptyString,
  arguments: z.unknown(),
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
  status: z.enum(["completed", "refused", "failed", "cancelled", "outcome_unknown"]),
  startedAt: nonEmptyString,
  endedAt: nonEmptyString.optional(),
  durationMs: z.number().finite().nonnegative().optional(),
  driverCode: nonEmptyString.optional(),
  message: z.string().optional(),
});
const eventBaseSchema = {
  eventId: nonEmptyString,
  runId: nonEmptyString,
  sequence: z.number().int().nonnegative(),
  occurredAt: nonEmptyString,
};

export const runtimeEventSchema = z.discriminatedUnion("type", [
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
  z.object({ ...eventBaseSchema, type: z.literal("action.proposed"), action: actionIntentSchema }),
  z.object({ ...eventBaseSchema, type: z.literal("action.execution.started"), action: actionIntentSchema }),
  z.object({
    ...eventBaseSchema,
    type: z.literal("action.execution.completed"),
    receipt: actionReceiptSchema,
  }),
  z.object({ ...eventBaseSchema, type: z.literal("action.execution.failed"), receipt: actionReceiptSchema }),
  z.object({ ...eventBaseSchema, type: z.literal("run.paused"), reason: z.string() }),
  z.object({ ...eventBaseSchema, type: z.literal("run.resumed") }),
  z.object({
    ...eventBaseSchema,
    type: z.literal("approval.requested"),
    requestId: nonEmptyString,
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
