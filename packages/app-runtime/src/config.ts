import type { HybridMemoryRecallService, MemoryEmbeddingProvider, MemoryStore, MemoryToolMode } from "@computer-harness/memory";
import type { PlanStore } from "@computer-harness/planning";
import type { RunId, RunOutcome } from "@computer-harness/protocol";
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

export type AppRuntimeModel = "glm-5.3-flash" | "qwen3.8-flash";
export type AppRuntimeRiskModel = "off" | "same" | AppRuntimeModel;
export type MemoryRetrievalMode = "off" | "lexical" | "hybrid";

/** JSON-safe configuration after CLI parsing and environment resolution. */
export interface ResolvedRunConfig {
  runId?: RunId;
  goal: string;
  model: AppRuntimeModel;
  computer: ComputerBackendConfig;
  outputDir: string;
  maxSteps: number;
  maxModelRequests: number;
  planning: boolean;
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
  riskProfile: "experiment" | "live-interactive";
  riskGuard: "off" | "layered";
  riskModel: AppRuntimeRiskModel;
  riskMaxModelRequests: number;
  riskTimeoutMs: number;
  cleanupDeadlineMs: number;
  qwenCoordinateMode?: "normalized_1000" | "actual_pixels";
  qwenThinking?: "disabled" | "low" | "medium" | "xhigh";
  qwenOutputMode?: "native_tools" | "strict_json";
  qwenEndpoint?: string;
  qwenWorkspaceId?: string;
  glmThinking?: "disabled" | "enabled";
  glmEndpoint?: string;
  fixtureResult?: string;
  monitor?: MonitorPolicyMode;
}

/** Credentials are injected at the application boundary and never serialized. */
export interface ProviderCredentials {
  glmApiKey?: string;
  qwenApiKey?: string;
  /** Independent embedding credential; never serialized into ResolvedRunConfig. */
  memoryEmbeddingApiKey?: string;
  osworldBridgeToken?: string;
}

export interface ProviderFactoryOptions {
  model: AppRuntimeModel;
  config: ResolvedRunConfig;
  assetReader: AssetReader;
  outputDir: string;
  credentials: ProviderCredentials;
  /** Offline transport seam; production defaults are created in providers.ts. */
  httpClients?: {
    glm?: ProviderHttpClient;
    qwen?: ProviderHttpClient;
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
  createProvider?: ProviderFactory;
  createComputer?: ComputerFactory;
  computerFactoryDependencies?: ComputerFactoryDependencies;
  createEventWriter?: (path: string, runId: RunId) => RunEventWriter;
  createAssetStore?: (rootDir: string) => AssetStore & AssetReader;
  createPlanStore?: (rootDir: string) => PlanStore;
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

export interface RunHandle {
  readonly runId: RunId;
  readonly config: ResolvedRunConfig;
  readonly controller: RunController;
  /** Read-only committed events for UI/diagnostics consumers. */
  readonly eventFeed: RunEventFeed;
  start(starter?: (controller: RunController, goal: string, markControllerStarted: () => void) => Promise<RunOutcome>): Promise<RunOutcome>;
  report(): Promise<RunReport>;
  /** Dispose before start or wait for Controller-owned cleanup after start. */
  close(): Promise<void>;
}
