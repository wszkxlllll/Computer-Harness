import type {
  ActionId,
  ActionGuardDecision,
  ActionGuardPath,
  ActionIntent,
  AssetId,
  AssetRef,
  ComputerSessionDescriptor,
  ComputerSessionId,
  ContextTrace,
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
  PreparedRequestEstimate as ProtocolPreparedRequestEstimate,
  PreparedRequestMetadata,
  RunId,
  RiskCategory,
  RuntimeEvent,
  ToolCall,
  ToolCallId,
  ToolResult,
  Viewport,
} from "@computer-harness/protocol";
import type { RunSnapshot } from "@computer-harness/trajectory";
import type { MonitorPolicyMode } from "./monitor-policy.js";

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
  estimatedMemoryTokens?: number;
  memoryMaxTokens?: number;
  estimatedMonitorGuidanceTokens?: number;
  monitorGuidanceIncluded?: boolean;
  trace?: ContextTrace;
}

/** Immutable Run-level switches shared by Registry projection, Runtime and Context. */
export interface RunFeatureConfig {
  planning: "off" | "tasks-v1";
  memory: "off" | "facts-v1" | "entities-v1";
  batching: "off" | "same-control-input-v1";
  riskGuard?: "off" | "layered";
  monitor?: MonitorPolicyMode;
}

export interface ProviderAdapter {
  readonly id: string;
  generate(
    input: ModelInput,
    options: { signal: AbortSignal },
  ): Promise<ModelTurn>;
  prepare?(input: ModelInput, options: { signal: AbortSignal }): Promise<PreparedProviderRequest>;
  generatePrepared?(prepared: PreparedProviderRequest, options: { signal: AbortSignal }): Promise<ModelTurn>;
}

/** Provider-owned wire preparation metadata. The actual request body stays in
 * the adapter's private identity-keyed state and is never serialized. */
export type PreparedRequestEstimate = ProtocolPreparedRequestEstimate;

export interface PreparedProviderRequest extends PreparedRequestMetadata {
  readonly providerId: string;
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
  monitorGuidance?: MonitorGuidance;
}

export interface MonitorGuidance {
  readonly text: string;
  readonly fingerprint: string;
}

export interface ContextOptions {
  mode?: "raw" | "recent";
  maxHistoryEvents?: number;
  /** Approximate text/tool budget; image cost is reported by the Provider when available. */
  maxInputTokens?: number;
  /** Soft cap for memory text inside the Context fixed blocks. */
  memoryMaxTokens?: number;
}

/** Query sources allowed for automatic Memory recall; tool results are not user corrections. */
export interface MemoryRecallQuery {
  readonly runId: RunId;
  readonly computerSessionId?: ComputerSessionId;
  readonly originalGoal: string;
  readonly latestUserCorrections?: readonly string[];
  readonly explicitQuery?: string;
  readonly recentActionHints?: readonly string[];
}

export type MemoryRecallMatch = "exact" | "lexical" | "semantic";
export type MemoryRecallMethod = "lexical" | "hybrid";
export type MemoryRecallSemanticStatus = "used" | "disabled" | "not_needed" | "unavailable" | "timed_out";

export interface MemoryRecallRankedId {
  readonly id: string;
  readonly score: number;
  readonly match: MemoryRecallMatch;
  readonly reason?: "needs_check" | "short_lived_last_known";
}

/**
 * Runtime-facing read contract. It contains only IDs/ranking/status metadata;
 * the Context side joins IDs back to its canonical MemoryState snapshot.
 */
export interface MemoryRecallSelection {
  readonly method: MemoryRecallMethod;
  readonly semanticStatus: MemoryRecallSemanticStatus;
  readonly stateStable: boolean;
  readonly embeddingBudgetUsed: number;
  readonly embeddingBudgetLimit: number;
  readonly admitted: readonly MemoryRecallRankedId[];
  readonly revalidation: readonly MemoryRecallRankedId[];
  readonly excluded: readonly { kind: "fact"; id: string; reason: "superseded" | "scope_mismatch" | "entity_stale" | "entity_missing" }[];
}

export interface MemoryRecallService {
  search(state: MemoryState, query: MemoryRecallQuery, signal: AbortSignal): Promise<MemoryRecallSelection>;
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

export interface ActionCandidateGroup {
  calls: readonly ToolCall[];
  actions: readonly ActionIntent[];
  decisionObservation: ObservationFrame;
  session: ComputerSessionDescriptor;
}

export interface ActionPolicyContext {
  runId: RunId;
  goal: string;
  recentUserInputs: readonly string[];
  candidate: ActionCandidateGroup;
  snapshot: RunSnapshot;
}

export interface ActionPolicyDecision {
  decision: ActionGuardDecision;
  categories: readonly RiskCategory[];
  reasonCode: string;
  reason: string;
  path: ActionGuardPath;
  policyVersion: string;
  assessorId?: string;
  semanticEffects?: readonly import("@computer-harness/protocol").DeclaredActionEffect[];
  alignment?: "aligned" | "conflicts" | "unclear";
  modelRequestCount: number;
  latencyMs?: number;
  usage?: import("@computer-harness/protocol").ModelUsage;
}

export interface ActionPolicy {
  evaluate(context: ActionPolicyContext, signal: AbortSignal): Promise<ActionPolicyDecision>;
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

