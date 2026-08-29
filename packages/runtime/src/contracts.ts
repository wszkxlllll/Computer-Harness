import type {
  ActionId,
  ActionIntent,
  AssetId,
  ComputerSessionDescriptor,
  EventId,
  JsonValue,
  ModelTurn,
  ObservationCapture,
  ObservationFrame,
  ObservationId,
  Point,
  RunId,
  RuntimeEvent,
  ToolCall,
  ToolCallId,
  ToolResult,
  Viewport,
} from "@computer-harness/protocol";
import type { RunSnapshot } from "@computer-harness/trajectory";

/** Runtime uses the serializable protocol description; adapter handles stay private. */
export type ComputerSession = ComputerSessionDescriptor;

export interface ComputerOpenOptions {
  viewport?: Viewport;
}

export interface Computer {
  open(options: ComputerOpenOptions, signal: AbortSignal): Promise<ComputerSession>;
  observe(
    session: ComputerSession,
    observationId: ObservationId,
    signal: AbortSignal,
  ): Promise<ObservationCapture>;
  execute(
    session: ComputerSession,
    action: ActionIntent,
    signal: AbortSignal,
  ): Promise<import("@computer-harness/protocol").ActionReceipt>;
  close(session: ComputerSession): Promise<void>;
}

export interface ModelToolSpec {
  name: string;
  description: string;
  inputSchema?: JsonValue;
}

export type ModelContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; asset: ObservationFrame["screenshot"] }
  | { type: "tool_result"; result: ToolResult };

export interface ModelMessage {
  role: "user" | "assistant" | "tool";
  content: ModelContentBlock[];
}

export interface ModelInput {
  system: string;
  messages: ModelMessage[];
  tools: ModelToolSpec[];
}

export interface ProviderProgressEvent {
  type: string;
  message?: string;
}

export interface ProviderAdapter {
  readonly id: string;
  generate(
    input: ModelInput,
    options: {
      signal: AbortSignal;
      onEvent?: (event: ProviderProgressEvent) => void;
    },
  ): Promise<ModelTurn>;
}

export interface ContextCompileInput {
  goal: string;
  snapshot: RunSnapshot;
  latestObservation?: ObservationFrame;
  recentEvents: readonly RuntimeEvent[];
  toolResults: readonly ToolResult[];
}

export interface ContextCompiler {
  compile(input: ContextCompileInput): Promise<ModelInput>;
}

export type ToolCategory = "computer" | "planning" | "control" | "side";

export type GuiActionDraft =
  | { kind: "click"; point: Point }
  | { kind: "double_click"; point: Point }
  | { kind: "right_click"; point: Point }
  | { kind: "type"; text: string }
  | { kind: "keypress"; keys: string[] }
  | { kind: "scroll"; deltaX: number; deltaY: number }
  | { kind: "drag"; from: Point; to: Point }
  | { kind: "wait"; durationMs: number };

export interface ToolExecutionContext {
  runId: RunId;
  session: ComputerSession;
  observation?: ObservationFrame;
  signal: AbortSignal;
}

interface ToolDefinitionBase {
  name: string;
  description: string;
  category: ToolCategory;
  inputSchema?: JsonValue;
  /** Runtime argument validation; inputSchema only describes the model-facing shape. */
  validate: (args: JsonValue) => void;
}

export interface ComputerToolDefinition extends ToolDefinitionBase {
  category: "computer";
  toAction: (args: JsonValue, context: ToolExecutionContext) => GuiActionDraft;
}

export interface NonComputerToolDefinition extends ToolDefinitionBase {
  category: Exclude<ToolCategory, "computer">;
  execute: (args: JsonValue, context: ToolExecutionContext) => Promise<JsonValue>;
}

export type ToolDefinition = ComputerToolDefinition | NonComputerToolDefinition;

export interface PolicyContext {
  call: ToolCall;
  tool: ToolDefinition;
  snapshot: RunSnapshot;
}

export type ToolPolicyDecision =
  | { decision: "allow" }
  | { decision: "deny"; reason: string }
  | { decision: "require_approval"; reason: string };

export interface BudgetDecision {
  allowed: boolean;
  reason?: string;
}

export interface FinishDecision {
  allowed: boolean;
  reason?: string;
}

export interface RuntimePolicy {
  evaluateToolCall(context: PolicyContext): Promise<ToolPolicyDecision>;
  checkBudget(snapshot: RunSnapshot): BudgetDecision;
  canFinish(snapshot: RunSnapshot): FinishDecision;
}

export interface Clock {
  now(): string;
}

export interface IdFactory {
  eventId(): EventId;
  observationId(): ObservationId;
  assetId(): AssetId;
  actionId(): ActionId;
}

