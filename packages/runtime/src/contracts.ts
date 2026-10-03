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
  ExecutionSegment,
  ExecutionSegmentMutation,
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
  RunAssistantPreferencesSnapshot,
  RunId,
  SurfaceRef,
  RiskCategory,
  RuntimeEvent,
  GroundingBrowserRegion,
  GroundingElementSource,
  ComputerWindowCandidate,
  ComputerWindowOption,
  ModelUsage,
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
  /** Optional, read-only picker surface during an explicit window handoff. */
  listWindowHandoffCandidates?(session: ComputerSession, signal: AbortSignal): Promise<readonly ComputerWindowCandidate[]>;
  /** Optional subset proven to have surfaced since the prior target observation. */
  listNewWindowHandoffCandidates?(session: ComputerSession, signal: AbortSignal): Promise<readonly ComputerWindowCandidate[]>;
  /** Optional read-only diff after a successful opted-in foreground action. */
  detectNewWindowHandoffCandidates?(session: ComputerSession, signal: AbortSignal): Promise<readonly ComputerWindowCandidate[]>;
  /** Optional read-only inventory of opened windows. References are opaque
   * Adapter-owned values and remain valid until the next inventory refresh,
   * a successful switch, or Run cleanup. */
  listWindows?(session: ComputerSession, signal: AbortSignal): Promise<readonly ComputerWindowOption[]>;
  /** Rebind the same host ComputerSession only after a host-confirmed handoff. */
  handoffWindow?(session: ComputerSession, candidate: ComputerWindowCandidate, signal: AbortSignal): Promise<ComputerSession>;
  /**
   * Release Computer-owned resources acquired outside an open session, or
   * during a failed open. RunController invokes this after close when present.
   */
  dispose?(): Promise<void>;
}

/** Runtime's current observation for a primitive; backend references stay private. */
export interface ComputerExecuteOptions {
  executionObservationId?: ObservationId;
  /** Enables adapter-private pre/post visible-window diffing on supported native foreground targets. */
  detectNewWindowHandoff?: boolean;
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
  estimatedGroundingTokens?: number;
  groundingIncluded?: boolean;
  trace?: ContextTrace;
}

/** Immutable Run-level switches shared by Registry projection, Runtime and Context. */
export interface RunFeatureConfig {
  planning: "off" | "tasks-v1";
  executionSegments?: "off" | "segments-v1";
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
  /** Optional Run-owned resource cleanup, called after the Run completes. */
  close?(): Promise<void>;
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
  executionSegment?: ExecutionSegment;
  recentEvents: readonly RuntimeEvent[];
  context?: ContextOptions;
  enabledCategories?: readonly ToolCategory[];
  enabledToolNames?: readonly string[];
  memory?: MemoryState;
  features?: RunFeatureConfig;
  monitorGuidance?: MonitorGuidance;
  assistantPreferences?: RunAssistantPreferencesSnapshot;
  /** Current serializable binding and its capabilities, independent of the
   * latest screenshot viewport. */
  computerSession?: ComputerSessionDescriptor;
  /** Dynamic data from the last explicit window inventory. These references
   * are omitted after a refresh or target transition until rediscovered. */
  windowSwitchState?: {
    readonly currentWindow?: { readonly appName?: string; readonly title?: string };
    readonly options?: readonly ComputerWindowOption[];
  };
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
  | { kind: "click"; point: Point; groundingRef?: string }
  | { kind: "double_click"; point: Point }
  | { kind: "right_click"; point: Point }
  | { kind: "type"; text: string; groundingRef?: string }
  | { kind: "keypress"; keys: string[] }
  | { kind: "select_option"; groundingRef: string; optionText: string }
  | { kind: "scroll"; point: Point; direction: "up" | "down" | "left" | "right"; ticks: number }
  | { kind: "drag"; from: Point; to: Point }
  | { kind: "switch_window"; windowRef: string }
  | { kind: "wait"; durationMs: number };

export interface ToolExecutionContext {
  runId: RunId;
  session: ComputerSession;
  observation?: ObservationFrame;
  /** Authoritative internal catalog for execution; never projected to Providers. */
  rawGrounding?: import("@computer-harness/protocol").GroundingCatalog;
  /** Runtime-owned read bridge; no Computer adapter or private handle is
   * exposed to tool definitions or Providers. */
  listWindows?: () => Promise<readonly ComputerWindowOption[]>;
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
  /**
   * Optional observation-grounding preference for a structured-control tool.
   * Runtime intersects it with the currently enabled ToolRegistry and catalog
   * source before adding a bounded hint to the selector query.
   */
  groundingHint?: {
    readonly preferredRoles: readonly string[];
    readonly preferredSources: readonly GroundingElementSource[];
  };
  /** When true, this action must be the only ToolCall in its ModelTurn. */
  isolatedTurn?: boolean;
  toAction: (args: JsonValue, context: ToolExecutionContext) => GuiActionDraft;
}

export interface NonComputerToolDefinition extends ToolDefinitionBase {
  category: "planning" | "side";
  execute: (args: JsonValue, context: ToolExecutionContext) => Promise<JsonValue>;
  /** Optional Planning projection; only Planning tools may provide these hooks. */
  planMutationFromResult?: (output: JsonValue) => PlanningTaskMutation | undefined;
  afterPlanCommit?: (mutation: PlanningTaskMutation, context: ToolExecutionContext) => Promise<void>;
  /** Optional short-lived local execution mutation. This is deliberately
   * separate from global PlanningTask progress. */
  executionSegmentMutationFromResult?: (output: JsonValue, context: ToolExecutionContext) => ExecutionSegmentMutation | undefined;
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
  /** Bounded, untrusted UI evidence for actions grounded to current elements. */
  groundingEvidence?: readonly GroundingEvidenceSummary[];
}

export interface GroundingEvidenceSummary {
  readonly role: string;
  readonly name?: string;
  readonly description?: string;
  readonly source?: GroundingElementSource;
  readonly browserRegion?: GroundingBrowserRegion;
  readonly untrusted: true;
}

export interface ActionPolicyContext {
  runId: RunId;
  goal: string;
  recentUserInputs: readonly string[];
  /** Exact Surface incarnation evaluated by the Guard; opaque IDs are not prompt semantics. */
  evaluatedSurfaceRef: SurfaceRef;
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

