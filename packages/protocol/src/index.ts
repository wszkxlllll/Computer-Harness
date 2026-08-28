export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type RunId = Brand<string, "RunId">;
export type ComputerSessionId = Brand<string, "ComputerSessionId">;
export type ObservationId = Brand<string, "ObservationId">;
export type ActionId = Brand<string, "ActionId">;
export type ToolCallId = Brand<string, "ToolCallId">;
export type EventId = Brand<string, "EventId">;
export type AssetId = Brand<string, "AssetId">;

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

export interface ToolCall {
  id: ToolCallId;
  name: string;
  arguments: unknown;
}

export type ModelTurn =
  | {
      type: "tool_calls";
      calls: ToolCall[];
      assistantText?: string;
    }
  | {
      type: "user_input_required";
      question: string;
    }
  | {
      type: "finish";
      summary: string;
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
  | (GuiActionBase & { kind: "scroll"; deltaX: number; deltaY: number })
  | (GuiActionBase & { kind: "drag"; from: Point; to: Point })
  | { actionId: ActionId; kind: "wait"; durationMs: number };

export interface ActionReceipt {
  actionId: ActionId;
  status: "completed" | "refused" | "failed" | "cancelled" | "outcome_unknown";
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  driverCode?: string;
  message?: string;
}

export interface ComputerCapabilities {
  screenshot: boolean;
  pointer: boolean;
  keyboard: boolean;
  accessibility: boolean;
}

export type RunStatus =
  | "created"
  | "starting"
  | "running"
  | "waiting_user"
  | "waiting_approval"
  | "paused"
  | "finishing"
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
  | { type: "computer.open.completed"; computerSessionId: ComputerSessionId }
  | { type: "observation.created"; observation: ObservationFrame }
  | { type: "model.request.started"; providerId: string }
  | { type: "model.response.received"; turn: ModelTurn }
  | { type: "model.request.failed"; category: string; message: string }
  | { type: "tool.call.received"; call: ToolCall }
  | { type: "tool.call.rejected"; callId: ToolCallId; reason: string }
  | { type: "action.proposed"; action: ActionIntent }
  | { type: "action.execution.started"; action: ActionIntent }
  | { type: "action.execution.completed"; receipt: ActionReceipt }
  | { type: "action.execution.failed"; receipt: ActionReceipt }
  | { type: "run.paused"; reason: string }
  | { type: "run.resumed" }
  | { type: "approval.requested"; requestId: string; callId: ToolCallId; reason: string }
  | { type: "approval.resolved"; requestId: string; approved: boolean }
  | { type: "user.input.requested"; question: string }
  | { type: "user.input.received"; text: string }
  | { type: "runtime.error"; category: string; message: string }
  | { type: "run.finished"; outcome: RunOutcome; summary?: string };

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
  "action.proposed",
  "action.execution.started",
  "action.execution.completed",
  "action.execution.failed",
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
