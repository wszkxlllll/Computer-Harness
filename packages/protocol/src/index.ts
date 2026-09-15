export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type RunId = Brand<string, "RunId">;
export type ComputerSessionId = Brand<string, "ComputerSessionId">;
export type ObservationId = Brand<string, "ObservationId">;
export type ActionId = Brand<string, "ActionId">;
export type ToolCallId = Brand<string, "ToolCallId">;
export type EventId = Brand<string, "EventId">;
export type AssetId = Brand<string, "AssetId">;

/** Shared task description used by Planning and future read-only consumers. */
export interface TaskSpec {
  subject: string;
  description?: string;
}

export type PlanningTaskStatus = "pending" | "in_progress" | "completed" | "blocked";

export interface PlanningTask extends TaskSpec {
  id: string;
  status: PlanningTaskStatus;
  blockedBy?: string[];
}

export interface PlanState {
  runId: RunId;
  tasks: PlanningTask[];
}

export type MemorySubject = { type: "run" } | { type: "entity"; entityId: string };

/** A small, run-scoped fact retained after raw history is compacted. */
export interface MemoryFact {
  id: string;
  /** Facts are normalized at the top level; this links one fact to an entity without nesting. */
  subject: MemorySubject;
  key: string;
  value: string;
  sourceEventId: EventId;
  status: "active" | "needs_check" | "superseded";
  relatedTaskIds?: string[];
  updatedSequence: number;
}

/** Optional entity representation built on top of facts; IDs are run-local. */
export interface MemoryEntity {
  id: string;
  type: string;
  description: string;
  sourceEventId: EventId;
  status: "active" | "stale" | "superseded";
  relatedTaskIds?: string[];
  updatedSequence: number;
}

export interface MemoryState {
  runId: RunId;
  facts: MemoryFact[];
  entities: MemoryEntity[];
}

export type MemoryMutation =
  | { operation: "upsert_fact"; fact: MemoryFact }
  | { operation: "supersede_fact"; factId: string; replacement?: MemoryFact }
  | { operation: "mark_fact_needs_check"; factId: string }
  | { operation: "upsert_entity"; entity: MemoryEntity }
  | { operation: "invalidate_entity"; entityId: string };

/** Pure state transition shared by the trajectory reducer and MemoryStore. */
export function reduceMemoryMutation(state: MemoryState, mutation: MemoryMutation): MemoryState {
  const next: MemoryState = {
    runId: state.runId,
    facts: state.facts.map((fact) => ({ ...fact, ...(fact.relatedTaskIds === undefined ? {} : { relatedTaskIds: [...fact.relatedTaskIds] }) })),
    entities: state.entities.map((entity) => ({
      ...entity,
      ...(entity.relatedTaskIds === undefined ? {} : { relatedTaskIds: [...entity.relatedTaskIds] }),
    })),
  };
  switch (mutation.operation) {
    case "upsert_fact": {
      const index = next.facts.findIndex((fact) => fact.id === mutation.fact.id);
      if (index < 0) next.facts.push(mutation.fact); else next.facts[index] = mutation.fact;
      return next;
    }
    case "supersede_fact": {
      const index = next.facts.findIndex((fact) => fact.id === mutation.factId);
      const existing = index >= 0 ? next.facts[index] : undefined;
      if (existing !== undefined) next.facts[index] = { ...existing, status: "superseded" };
      if (mutation.replacement !== undefined) next.facts.push(mutation.replacement);
      return next;
    }
    case "mark_fact_needs_check": {
      const index = next.facts.findIndex((fact) => fact.id === mutation.factId);
      const existing = index >= 0 ? next.facts[index] : undefined;
      if (existing !== undefined && existing.status !== "superseded") next.facts[index] = { ...existing, status: "needs_check" };
      return next;
    }
    case "upsert_entity": {
      const index = next.entities.findIndex((entity) => entity.id === mutation.entity.id);
      if (index < 0) next.entities.push(mutation.entity); else next.entities[index] = mutation.entity;
      return next;
    }
    case "invalidate_entity": {
      const index = next.entities.findIndex((entity) => entity.id === mutation.entityId);
      const existing = index >= 0 ? next.entities[index] : undefined;
      if (existing !== undefined) next.entities[index] = { ...existing, status: "stale" };
      return next;
    }
  }
}

export type PlanningTaskMutation =
  | { operation: "created"; task: PlanningTask }
  | { operation: "updated"; task: PlanningTask };

export interface Viewport {
  width: number;
  height: number;
  coordinateSpace: "physical" | "logical" | "reference";
}

export interface Point {
  x: number;
  y: number;
}

export interface AssetRef {
  assetId: AssetId;
  relativePath: string;
  mediaType: string;
  byteLength: number;
}

export interface ObservationFrame {
  id: ObservationId;
  runId: RunId;
  computerSessionId: ComputerSessionId;
  capturedAt: string;
  viewport: Viewport;
  screenshot: AssetRef;
}

/** Raw computer output before Runtime persists its screenshot asset. */
export interface ObservationCapture {
  capturedAt: string;
  viewport: Viewport;
  screenshot: {
    mediaType: "image/png" | "image/jpeg";
    data: Uint8Array;
  };
}

export interface ToolCall {
  id: ToolCallId;
  name: string;
  arguments: JsonValue;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ToolResult =
  | {
      callId: ToolCallId;
      status: "completed";
      output: JsonValue;
    }
  | {
      callId: ToolCallId;
      status: "failed";
      error: { code: string; message: string };
    }
  | {
      callId: ToolCallId;
      status: "rejected";
      error: { code: string; message: string };
    };

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/**
 * Provider-owned continuation data that must survive a subsequent request in
 * the same Run.  The protocol keeps the payload narrow and serializable; a
 * Provider Adapter decides whether it can consume a particular kind.
 */
export interface ModelContinuation {
  providerId: string;
  kind: "reasoning_content";
  content: string;
}

export type ModelTurn =
  | {
      type: "tool_calls";
      calls: ToolCall[];
      assistantText?: string;
      continuation?: ModelContinuation;
      usage?: ModelUsage;
    }
  | {
      type: "user_input_required";
      question: string;
      usage?: ModelUsage;
    }
  | {
      type: "finish";
      summary: string;
      /** Structured termination status supplied by providers that expose it. */
      reportedStatus?: "success" | "failure";
      usage?: ModelUsage;
    };

export interface GuiActionBase {
  actionId: ActionId;
  basedOn: ObservationId;
}

export type ActionIntent =
  | (GuiActionBase & { kind: "click"; point: Point })
  | (GuiActionBase & { kind: "double_click"; point: Point })
  | (GuiActionBase & { kind: "right_click"; point: Point })
  | (GuiActionBase & { kind: "type"; text: string })
  | (GuiActionBase & { kind: "keypress"; keys: string[] })
  | (GuiActionBase & {
      kind: "scroll";
      point: Point;
      direction: "up" | "down" | "left" | "right";
      /** Positive driver-independent wheel ticks; the Computer adapter chooses its unit mapping. */
      ticks: number;
    })
  | (GuiActionBase & { kind: "drag"; from: Point; to: Point })
  | { actionId: ActionId; kind: "wait"; durationMs: number };

export interface ActionReceipt {
  actionId: ActionId;
  status: "completed" | "refused" | "failed" | "cancelled";
  driverCode?: string;
  message?: string;
}

export interface ComputerCapabilities {
  screenshot: boolean;
  pointer: boolean;
  keyboard: boolean;
  accessibility: boolean;
}

/** Stable, serializable description of an opened Computer session. */
export interface ComputerSessionDescriptor {
  readonly id: ComputerSessionId;
  readonly backend: string;
  readonly viewport: Readonly<Viewport>;
  readonly capabilities: Readonly<ComputerCapabilities>;
  readonly openedAt: string;
}

export type RunStatus =
  | "created"
  | "starting"
  | "running"
  | "waiting_user"
  | "waiting_approval"
  | "paused"
  | "finished";

export type RunOutcome =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "budget_exhausted"
  | "outcome_unknown";

export interface RuntimeEventBase {
  eventId: EventId;
  runId: RunId;
  sequence: number;
  occurredAt: string;
}

export type RuntimeEventData =
  | { type: "run.created"; goal: string }
  | { type: "run.started" }
  | { type: "computer.open.started" }
  | { type: "computer.open.completed"; session: ComputerSessionDescriptor }
  | { type: "observation.created"; observation: ObservationFrame }
  | { type: "model.request.started"; providerId: string; contextBudget?: { mode: "raw" | "recent"; estimatedInputTokens: number; estimatedFixedTextTokens?: number; estimatedHistoryTextTokens?: number; estimatedToolSchemaTokens?: number; imageCount?: number; selectedHistoryEvents: number; omittedHistoryEvents: number; maxHistoryEvents?: number; maxInputTokens?: number } }
  | { type: "model.response.received"; turn: ModelTurn }
  | {
      type: "model.request.failed";
      category: string;
      message: string;
      code?: string;
      retryable?: boolean;
    }
  | { type: "tool.call.received"; call: ToolCall }
  | { type: "tool.call.rejected"; callId: ToolCallId; reason: string }
  | { type: "tool.call.completed"; result: Extract<ToolResult, { status: "completed" }> }
  | {
      type: "tool.call.failed";
      result: Extract<ToolResult, { status: "failed" }>;
    }
  | { type: "action.proposed"; callId: ToolCallId; action: ActionIntent; executionObservationId?: ObservationId }
  | { type: "action.execution.started"; action: ActionIntent; executionObservationId?: ObservationId }
  | { type: "action.execution.completed"; receipt: ActionReceipt }
  | { type: "action.execution.failed"; receipt: ActionReceipt }
  | { type: "planning.task.updated"; callId: ToolCallId; mutation: PlanningTaskMutation }
  | { type: "memory.updated"; callId: ToolCallId; mutation: MemoryMutation }
  | { type: "run.paused"; reason: string }
  | { type: "run.resumed" }
  | { type: "approval.requested"; requestId: string; callId: ToolCallId; reason: string }
  | { type: "approval.resolved"; requestId: string; approved: boolean }
  | { type: "user.input.requested"; question: string }
  | { type: "user.input.received"; text: string }
  | { type: "runtime.error"; category: string; message: string }
  | {
      type: "run.finished";
      outcome: RunOutcome;
      summary?: string;
      reportedStatus?: "success" | "failure";
    };

export type RuntimeEvent = RuntimeEventBase & RuntimeEventData;

export type RuntimeEventType = RuntimeEventData["type"];

/**
 * The runtime discriminator list is kept next to the event union so a newly
 * added event cannot silently be omitted from schema and compatibility tests.
 */
export const runtimeEventTypes = [
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
  "tool.call.completed",
  "tool.call.failed",
  "action.proposed",
  "action.execution.started",
  "action.execution.completed",
  "action.execution.failed",
  "planning.task.updated",
  "memory.updated",
  "run.paused",
  "run.resumed",
  "approval.requested",
  "approval.resolved",
  "user.input.requested",
  "user.input.received",
  "runtime.error",
  "run.finished",
] as const satisfies readonly RuntimeEventType[];

type MissingRuntimeEventTypes = Exclude<RuntimeEventType, (typeof runtimeEventTypes)[number]>;
type UnexpectedRuntimeEventTypes = Exclude<(typeof runtimeEventTypes)[number], RuntimeEventType>;
type RuntimeEventTypesAreComplete =
  [MissingRuntimeEventTypes, UnexpectedRuntimeEventTypes] extends [never, never] ? true : false;
const runtimeEventTypesAreComplete: RuntimeEventTypesAreComplete = true;

export type RuntimeEventDraft = RuntimeEventData & {
  runId: RunId;
  eventId?: EventId;
  occurredAt?: string;
};
