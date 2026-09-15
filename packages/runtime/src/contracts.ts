import type {
  ActionId,
  ActionIntent,
  AssetId,
  AssetRef,
  ComputerSessionDescriptor,
  EventId,
  JsonValue,
  ModelTurn,
  ModelContinuation,
  MemoryMutation,
  MemoryState,
  ObservationCapture,
  ObservationFrame,
  ObservationId,
  PlanState,
  PlanningTaskMutation,
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
    options?: ComputerExecuteOptions,
  ): Promise<import("@computer-harness/protocol").ActionReceipt>;
  close(session: ComputerSession): Promise<void>;
}

/** Runtime's current observation for a primitive; backend references stay private. */
export interface ComputerExecuteOptions {
  executionObservationId?: ObservationId;
}

export interface ModelToolSpec {
  name: string;
  description: string;
  inputSchema?: JsonValue;
  /** Functional category is metadata for Provider projection, not execution permission. */
  category?: ToolCategory;
  /** Only tools with declared coordinate fields may be transformed by a Provider. */
  coordinate?: CoordinateSemantics;
  /** Control tools map to a ModelTurn decision instead of a ToolCall execution. */
  control?: ControlKind;
}

export type ModelContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; asset: AssetRef; viewport: Viewport }
  /** Provider continuation data projected from the corresponding ModelTurn. */
  | { type: "provider_continuation"; continuation: ModelContinuation }
  /** Viewport of the observation that informed this call, when known. */
  | { type: "tool_call"; call: ToolCall; viewport?: Viewport }
  | { type: "tool_result"; result: ToolResult };

export interface ModelMessage {
  role: "user" | "assistant" | "tool";
  content: ModelContentBlock[];
}

export interface ModelInput {
  system: string;
  messages: ModelMessage[];
  tools: ModelToolSpec[];
  contextBudget?: ContextBudgetReport;
}

export interface ContextBudgetReport {
  mode: "raw" | "recent";
  estimatedInputTokens: number;
  estimatedFixedTextTokens?: number;
  estimatedHistoryTextTokens?: number;
  estimatedToolSchemaTokens?: number;
  imageCount?: number;
  selectedHistoryEvents: number;
  omittedHistoryEvents: number;
  maxHistoryEvents?: number;
  maxInputTokens?: number;
}

/** Immutable Run-level switches shared by Registry projection, Runtime and Context. */
export interface RunFeatureConfig {
  planning: "off" | "tasks-v1";
  memory: "off" | "facts-v1" | "entities-v1";
  batching: "off" | "same-control-input-v1";
}

export interface ProviderAdapter {
  readonly id: string;
  generate(
    input: ModelInput,
    options: { signal: AbortSignal },
  ): Promise<ModelTurn>;
}

export interface ContextCompileInput {
  runId: RunId;
  goal: string;
  latestObservation?: ObservationFrame;
  plan?: PlanState;
  recentEvents: readonly RuntimeEvent[];
  context?: ContextOptions;
  enabledCategories?: readonly ToolCategory[];
  enabledToolNames?: readonly string[];
  memory?: MemoryState;
  features?: RunFeatureConfig;
}

export interface ContextOptions {
  mode?: "raw" | "recent";
  maxHistoryEvents?: number;
  /** Approximate text/tool budget; image cost is reported by the Provider when available. */
  maxInputTokens?: number;
}

export interface ContextCompiler {
  compile(input: ContextCompileInput, signal: AbortSignal): Promise<ModelInput>;
}

/** Reads a persisted asset without exposing filesystem paths to Providers. */
export interface AssetReader {
  read(ref: AssetRef, signal: AbortSignal): Promise<Uint8Array>;
}

export type ToolCategory = "computer" | "planning" | "control" | "side";

export type ToolAudience = "main" | "advisor";

export type ControlKind = "finish" | "user_input_required";

export type CoordinateField = "x" | "y" | "fromX" | "fromY" | "toX" | "toY";

export interface CoordinateSemantics {
  readonly fields: readonly CoordinateField[];
}

export type GuiActionDraft =
  | { kind: "click"; point: Point }
  | { kind: "double_click"; point: Point }
  | { kind: "right_click"; point: Point }
  | { kind: "type"; text: string }
  | { kind: "keypress"; keys: string[] }
  | { kind: "scroll"; point: Point; direction: "up" | "down" | "left" | "right"; ticks: number }
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
  inputSchema: JsonValue;
  /** Omitted means the definition is available to the main Agent only. */
  audiences?: readonly ToolAudience[];
  coordinate?: CoordinateSemantics;
  /** Runtime argument validation; inputSchema only describes the model-facing shape. */
  validate: (args: JsonValue) => void;
}

export interface ComputerToolDefinition extends ToolDefinitionBase {
  category: "computer";
  toAction: (args: JsonValue, context: ToolExecutionContext) => GuiActionDraft;
}

export interface NonComputerToolDefinition extends ToolDefinitionBase {
  category: "planning" | "side";
  execute: (args: JsonValue, context: ToolExecutionContext) => Promise<JsonValue>;
  /** Optional Planning projection; only Planning tools may provide these hooks. */
  planMutationFromResult?: (output: JsonValue) => PlanningTaskMutation | undefined;
  afterPlanCommit?: (mutation: PlanningTaskMutation, context: ToolExecutionContext) => Promise<void>;
  /** Optional Run Memory projection; the Runtime commits it before materialization. */
  memoryMutationFromResult?: (output: JsonValue, context: ToolExecutionContext) => MemoryMutation | undefined;
  afterMemoryCommit?: (mutation: MemoryMutation, context: ToolExecutionContext) => Promise<void>;
}

export interface ControlToolDefinition extends ToolDefinitionBase {
  category: "control";
  control: ControlKind;
}

export type ToolDefinition = ComputerToolDefinition | NonComputerToolDefinition | ControlToolDefinition;

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
  checkActionBudget(snapshot: RunSnapshot): BudgetDecision;
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

