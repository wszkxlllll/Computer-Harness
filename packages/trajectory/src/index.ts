import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, relative as pathRelative, resolve } from "node:path";
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
          : {
              ...withoutPendingApproval,
              status: "finished",
              outcome: "cancelled",
              endedAt: event.occurredAt,
            };
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
  private readonly idFactory: EventIdFactory;
  private fileHandle: Awaited<ReturnType<typeof open>> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private nextSequence = 0;
  private closed = false;

  public constructor(filePath: string, idFactory: EventIdFactory = randomEventIdFactory) {
    this.filePath = resolve(filePath);
    this.idFactory = idFactory;
  }

  public async append(draft: RuntimeEventDraft): Promise<RuntimeEvent> {
    if (this.closed) {
      throw new Error("event writer is closed");
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
      await rename(temporaryPath, destination);
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

function parseRuntimeEvent(value: unknown, lineNumber: number): RuntimeEvent {
  if (!isRecord(value)) {
    throw new Error(`invalid runtime event at line ${lineNumber}: expected an object`);
  }
  if (
    typeof value.eventId !== "string" ||
    typeof value.runId !== "string" ||
    !Number.isInteger(value.sequence) ||
    (value.sequence as number) < 0 ||
    typeof value.occurredAt !== "string" ||
    typeof value.type !== "string"
  ) {
    throw new Error(`invalid runtime event at line ${lineNumber}: malformed event base`);
  }
  if (!runtimeEventTypes.has(value.type as RuntimeEvent["type"])) {
    throw new Error(`invalid runtime event at line ${lineNumber}: unknown type ${value.type}`);
  }

  switch (value.type as RuntimeEvent["type"]) {
    case "run.created":
      requireString(value, "goal", lineNumber);
      break;
    case "computer.open.completed":
      requireString(value, "computerSessionId", lineNumber);
      break;
    case "observation.created":
      requireString(requireRecordField(value, "observation", lineNumber), "id", lineNumber);
      break;
    case "model.request.started":
      requireString(value, "providerId", lineNumber);
      break;
    case "model.response.received":
      requireRecordField(value, "turn", lineNumber);
      break;
    case "model.request.failed":
      requireString(value, "category", lineNumber);
      requireString(value, "message", lineNumber);
      break;
    case "tool.call.received":
      requireRecordField(value, "call", lineNumber);
      break;
    case "tool.call.rejected":
      requireString(value, "callId", lineNumber);
      requireString(value, "reason", lineNumber);
      break;
    case "action.proposed":
    case "action.execution.started":
      requireString(requireRecordField(value, "action", lineNumber), "actionId", lineNumber);
      break;
    case "action.execution.completed":
    case "action.execution.failed":
      requireString(requireRecordField(value, "receipt", lineNumber), "actionId", lineNumber);
      break;
    case "run.paused":
      requireString(value, "reason", lineNumber);
      break;
    case "approval.requested":
      requireString(value, "requestId", lineNumber);
      requireString(value, "reason", lineNumber);
      break;
    case "approval.resolved":
      requireString(value, "requestId", lineNumber);
      if (typeof value.approved !== "boolean") {
        throw new Error(`invalid runtime event at line ${lineNumber}: approved must be boolean`);
      }
      break;
    case "runtime.error":
      requireString(value, "category", lineNumber);
      requireString(value, "message", lineNumber);
      break;
    case "run.finished":
      if (!runOutcomes.has(value.outcome as RunOutcome)) {
        throw new Error(`invalid runtime event at line ${lineNumber}: unknown outcome`);
      }
      break;
    default:
      break;
  }
  return value as unknown as RuntimeEvent;
}

const runtimeEventTypes = new Set<RuntimeEvent["type"]>([
  "run.created",
  "run.started",
  "computer.open.started",
  "computer.open.completed",
  "observation.created",
  "model.request.started",
  "model.response.received",
  "model.request.failed",
  "tool.call.received",
  "tool.call.rejected",
  "action.proposed",
  "action.execution.started",
  "action.execution.completed",
  "action.execution.failed",
  "run.paused",
  "run.resumed",
  "approval.requested",
  "approval.resolved",
  "runtime.error",
  "run.finished",
]);

const runOutcomes = new Set<RunOutcome>([
  "succeeded",
  "failed",
  "cancelled",
  "budget_exhausted",
  "outcome_unknown",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireString(record: Record<string, unknown>, key: string, lineNumber: number): string {
  if (typeof record[key] !== "string") {
    throw new Error(`invalid runtime event at line ${lineNumber}: ${key} must be a string`);
  }
  return record[key] as string;
}

function requireRecordField(
  record: Record<string, unknown>,
  key: string,
  lineNumber: number,
): Record<string, unknown> {
  const value = record[key];
  if (!isRecord(value)) {
    throw new Error(`invalid runtime event at line ${lineNumber}: ${key} must be an object`);
  }
  return value;
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
