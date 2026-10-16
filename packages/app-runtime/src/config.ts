import type { HybridMemoryRecallService, MemoryEmbeddingProvider, MemoryRunModule, MemoryStore, MemoryToolMode } from "@computer-harness/memory";
import type { PlanStore, PlanningRunModule } from "@computer-harness/planning";
import type { RunAssistantPreferencesSnapshot, RunId, RunOutcome, SourceLinkedFinishContract } from "@computer-harness/protocol";
import type {
  ActionPolicy,
  AssetReader,
  Clock,
  ContextCompiler,
  IdFactory,
  ProviderAdapter,
  RunController,
  RunFeatureConfig,
  MonitorPolicyMode,
  MemoryRecallService,
  RuntimePolicy,
  ToolRegistry,
} from "@computer-harness/runtime";
import type { CleanupDiagnostic } from "@computer-harness/runtime";
import type { RunEventWriter } from "@computer-harness/trajectory";
import type { AssetStore } from "@computer-harness/trajectory";
import type { ComputerBackendConfig, ComputerFactoryDependencies } from "./computers.js";
import type { RunReport } from "./reporting.js";
import type { RunEventFeed } from "./event-feed.js";

export type AppRuntimeModel = "glm-5.3-flash" | "qwen3.8-flash" | "deepseek-flash" | "deepseek-v4.1-flash";
export const DEFAULT_GLM_REQUEST_TIMEOUT_MS = 90_000;
export const MIN_GLM_REQUEST_TIMEOUT_MS = 1_000;
export const MAX_GLM_REQUEST_TIMEOUT_MS = 240_000;

export function validateGlmRequestTimeoutMs(value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < MIN_GLM_REQUEST_TIMEOUT_MS || value > MAX_GLM_REQUEST_TIMEOUT_MS)) {
    throw new Error(`GLM request timeout must be an integer from ${MIN_GLM_REQUEST_TIMEOUT_MS} to ${MAX_GLM_REQUEST_TIMEOUT_MS} milliseconds`);
  }
}

export const DEFAULT_DEEPSEEK_REQUEST_TIMEOUT_MS = 90_000;
export const DEFAULT_DEEPSEEK_MAX_OUTPUT_TOKENS = 4096;
export const DEFAULT_ARK_REQUEST_TIMEOUT_MS = 90_000;
export const DEFAULT_ARK_MAX_OUTPUT_TOKENS = 4096;

export function validateDeepseekRequestTimeoutMs(value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1_000 || value > 240_000)) {
    throw new Error("DeepSeek request timeout must be an integer from 1000 to 240000 milliseconds");
  }
}

export function validateDeepseekMaxOutputTokens(value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 131072)) {
    throw new Error("DeepSeek max output tokens must be an integer from 1 to 131072");
  }
}
export type AppRuntimeRiskModel = "off" | "same" | AppRuntimeModel;
/** Explicit adapter identity for a Provider supplied by the application. */
export interface ExternalProviderDescriptor {
  readonly kind: "external";
  readonly id: string;
}
export type RunModel = AppRuntimeModel | ExternalProviderDescriptor;
export type MemoryRetrievalMode = "off" | "lexical" | "hybrid";

export interface PlanningRunModuleFactoryOptions {
  readonly runId: RunId;
  readonly rootDir: string;
}

export interface MemoryRunModuleFactoryOptions {
  readonly runId: RunId;
  readonly rootDir: string;
  readonly mode: MemoryToolMode;
  readonly config: ResolvedRunConfig;
  readonly credentials: ProviderCredentials;
}

/** JSON-safe configuration after CLI parsing and environment resolution. */
export interface ResolvedRunConfig {
  runId?: RunId;
  goal: string;
  model: RunModel;
  computer: ComputerBackendConfig;
  outputDir: string;
  maxSteps: number;
  maxModelRequests: number;
  planning: boolean;
  /** Explicit opt-in for the unfinished local execution-segment experiment. */
  executionSegments?: "off" | "segments-v1";
  memory: "off" | MemoryToolMode;
  /** Optional for backwards-compatible fixtures; app defaults to lexical when Memory is enabled. */
  memoryRetrieval?: MemoryRetrievalMode;
  memoryEmbeddingEndpoint?: string;
  memoryEmbeddingMaxRequests?: number;
  memoryEmbeddingTimeoutMs?: number;
  batching: "off" | "same-control-input-v1";
  contextMode: "raw" | "recent";
  contextMaxHistoryEvents: number;
  contextMaxInputTokens?: number;
  contextMaxWireInputTokens?: number;
  /** Opt-in to the bounded built-in operation-guidance catalog; defaults off. */
  operationGuidance?: "off" | "catalog-v1";
  /** Frozen, provider-neutral answer preferences for this Run only. */
  assistantPreferences?: RunAssistantPreferencesSnapshot;
  /** Explicit finite output field contract; absent preserves ordinary free-form finish behavior. */
  sourceLinkedFinish?: SourceLinkedFinishContract;
  riskProfile: "experiment" | "live-interactive";
  riskGuard: "off" | "layered";
  /** Defaults to off; DOM/hybrid require an explicit HTTP(S) URL or about:blank. */
  grounding?: "off" | "uia-catalog-v1" | "dom-catalog-v1" | "hybrid-catalog-v1";
  /** Interactive native-window handoff; off unless a host explicitly opts in. */
  windowHandoff?: "off" | "confirm-v1";
  /** Model-selected switching among already-open windows; off by default. */
  windowSwitch?: "off" | "opened-windows-v1";
  /** Narrow Darwin recovery target for a completed close followed by a missing bound window. */
  recoverBoundWindowMissing?: boolean;
  riskModel: AppRuntimeRiskModel;
  riskMaxModelRequests: number;
  riskTimeoutMs: number;
  cleanupDeadlineMs: number;
  qwenCoordinateMode?: "normalized_1000" | "actual_pixels";
  qwenThinking?: "disabled" | "low" | "medium" | "xhigh";
  qwenOutputMode?: "native_tools" | "strict_json";
  qwenEndpoint?: string;
  qwenWorkspaceId?: string;
  glmThinking?: "disabled" | "enabled" | "low" | "high" | "max";
  /** Total GLM completion/reasoning budget; defaults to 8192, bounded at 131072. */
  glmMaxOutputTokens?: number;
  glmEndpoint?: string;
  /** Bounded live-interactive deadline for one GLM request. */
  glmRequestTimeoutMs?: number;
  deepseekEndpoint?: string;
  /** Wall-clock deadline for one DeepSeek request; defaults to 90000ms. */
  deepseekRequestTimeoutMs?: number;
  /** Non-thinking DeepSeek completion budget; defaults to 4096. */
  deepseekMaxOutputTokens?: number;
  arkEndpoint?: string;
  /** Wall-clock deadline for one Ark Agent Plan request; defaults to 90000ms. */
  arkRequestTimeoutMs?: number;
  /** Non-thinking Ark completion budget; defaults to 4096. */
  arkMaxOutputTokens?: number;
  fixtureResult?: string;
  monitor?: MonitorPolicyMode;
}

/** Credentials are injected at the application boundary and never serialized. */
export interface ProviderCredentials {
  glmApiKey?: string;
  qwenApiKey?: string;
  deepseekApiKey?: string;
  arkApiKey?: string;
  /** Independent embedding credential; never serialized into ResolvedRunConfig. */
  memoryEmbeddingApiKey?: string;
  osworldBridgeToken?: string;
}

export interface ProviderFactoryOptions {
  model: RunModel;
  config: ResolvedRunConfig;
  assetReader: AssetReader;
  outputDir: string;
  credentials: ProviderCredentials;
  /** Offline transport seam; production defaults are created in providers.ts. */
  httpClients?: {
    glm?: ProviderHttpClient;
    qwen?: ProviderHttpClient;
    deepseek?: ProviderHttpClient;
    ark?: ProviderHttpClient;
  };
}

export interface ProviderHttpClient {
  post(url: string, body: Record<string, unknown>, headers: Readonly<Record<string, string>>, signal: AbortSignal): Promise<unknown>;
}

export type ProviderFactory = (options: ProviderFactoryOptions) => ProviderAdapter | Promise<ProviderAdapter>;

export interface ComputerFactoryOptions {
  config: ComputerBackendConfig;
  credentials: ProviderCredentials;
}

export type ComputerFactory = (options: ComputerFactoryOptions) => Promise<import("@computer-harness/runtime").Computer>;

export interface RunDependencies {
  credentials?: ProviderCredentials;
  /** Returned Providers belong to one Run; create fresh adapters and self-clean if construction rejects. */
  createProvider?: ProviderFactory;
  /** Returned Computers belong to one Run; self-clean rejected construction and use Computer.dispose for failed-open resources. */
  createComputer?: ComputerFactory;
  computerFactoryDependencies?: ComputerFactoryDependencies;
  createEventWriter?: (path: string, runId: RunId) => RunEventWriter;
  createAssetStore?: (rootDir: string) => AssetStore & AssetReader;
  /** Return a fresh Run-owned module. app-runtime calls its optional close() through bounded cleanup. */
  createPlanningModule?: (options: PlanningRunModuleFactoryOptions) => PlanningRunModule;
  /** Return a fresh Run-owned module; app-runtime closes it through bounded cleanup. */
  createMemoryModule?: (options: MemoryRunModuleFactoryOptions) => MemoryRunModule;
  /** Legacy persistence seam. Prefer createPlanningModule to replace tools, materialization and Context together. */
  createPlanStore?: (rootDir: string) => PlanStore;
  /** Legacy persistence seam. Prefer createMemoryModule to replace tools, materialization and Context together. */
  createMemoryStore?: (rootDir: string) => MemoryStore;
  /** Application-bound provider seam; Runtime does not construct a default Memory backend. */
  createMemoryEmbeddingProvider?: (options: {
    config: ResolvedRunConfig;
    credentials: ProviderCredentials;
  }) => MemoryEmbeddingProvider | undefined;
  /** Optional per-Run service seam for tests or a future local provider. */
  createMemoryRecallService?: (options: {
    config: ResolvedRunConfig;
    credentials: ProviderCredentials;
    provider?: MemoryEmbeddingProvider;
  }) => HybridMemoryRecallService | undefined;
  createToolRegistry?: () => ToolRegistry;
  createContextCompiler?: (tools: ToolRegistry, features: RunFeatureConfig, config: ResolvedRunConfig, memoryRecall?: MemoryRecallService) => ContextCompiler;
  createPolicy?: (config: ResolvedRunConfig) => RuntimePolicy;
  createActionPolicy?: (config: ResolvedRunConfig, provider: ProviderAdapter | undefined) => ActionPolicy | undefined;
  clock?: Clock;
  idFactory?: IdFactory;
  onCleanupError?: (diagnostic: CleanupDiagnostic) => void;
}

/**
 * Exact diagnostics that a RunHandle has cleared by completing its own late
 * Computer close/dispose work. Other cleanup diagnostics cannot be covered.
 */
export interface RunCloseConfirmation {
  readonly kind: "late-computer-cleanup-confirmed";
  readonly runId: RunId;
  readonly resolvedTimedOutComputerDiagnostics: readonly {
    readonly operation: "computer.close" | "computer.dispose";
    readonly message: string;
    readonly status: "timed_out";
  }[];
}

export interface RunHandle {
  readonly runId: RunId;
  readonly config: ResolvedRunConfig;
  readonly controller: RunController;
  /** Read-only committed events for UI/diagnostics consumers. */
  readonly eventFeed: RunEventFeed;
  start(starter?: (controller: RunController, goal: string, markControllerStarted: () => void) => Promise<RunOutcome>): Promise<RunOutcome>;
  report(): Promise<RunReport>;
  /**
   * Dispose before start or confirm all owned cleanup after start. A resolved
   * promise is positive cleanup confirmation. When its report retains a
   * timed-out Computer diagnostic that later succeeded, it returns that exact
   * diagnostic in a RunId-bound confirmation. Implementations, including
   * injected Run factories, must not cover other unresolved diagnostics.
   */
  close(): Promise<void | RunCloseConfirmation>;
}
