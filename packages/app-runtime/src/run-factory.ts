import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { DefaultContextCompiler } from "@computer-harness/context";
import { createMemoryTools, FileMemoryStore, HybridMemoryRecallService, QwenTextEmbeddingProvider, type MemoryEmbeddingProvider } from "@computer-harness/memory";
import { createPlanningTools, FilePlanStore } from "@computer-harness/planning";
import type { MemoryMutation, RunId, RunOutcome } from "@computer-harness/protocol";
import { LayeredRiskGuard, ProviderRiskAssessor } from "@computer-harness/risk-guard";
import {
  DefaultRuntimePolicy,
  RunController,
  createDefaultToolRegistry,
  type ActionPolicy,
  type ContextCompiler,
  type ProviderAdapter,
  type RunFeatureConfig,
  type RuntimePolicy,
  type ToolRegistry,
} from "@computer-harness/runtime";
import { FileAssetStore, JsonlRunEventWriter, type AssetStore, type RunEventWriter } from "@computer-harness/trajectory";
import type { AssetReader } from "@computer-harness/runtime";
import { createComputer } from "./computers.js";
import { createProvider } from "./providers.js";
import { buildRunReport } from "./reporting.js";
import { createRunEventFeed, type CommittedEventFeed } from "./event-feed.js";
import type { MemoryRetrievalMode, ProviderCredentials, ResolvedRunConfig, RunDependencies, RunHandle } from "./config.js";

export async function createRun(input: ResolvedRunConfig, dependencies: RunDependencies = {}): Promise<RunHandle> {
  const runId = input.runId ?? generatedRunId();
  const config: ResolvedRunConfig = { ...input, runId, outputDir: resolve(input.outputDir) };
  const credentials = dependencies.credentials ?? {};
  let eventWriter: RunEventWriter | undefined;
  let eventFeed: CommittedEventFeed | undefined;
  let controller: RunController | undefined;
  try {
    await mkdir(config.outputDir, { recursive: true });
    const assetStore = (dependencies.createAssetStore ?? ((rootDir) => new FileAssetStore(rootDir)))(resolve(config.outputDir, "assets"));
    const assetReader = assetStore as AssetStore & AssetReader;
    eventWriter = (dependencies.createEventWriter ?? ((path, id) => new JsonlRunEventWriter(path, id)))(resolve(config.outputDir, "trajectory.jsonl"), runId);
    eventFeed = createRunEventFeed({
      runId,
      readCommitted: (afterSequence, upToSequence) => (controller?.getEventsAfter(afterSequence) ?? [])
        .filter((event) => event.sequence <= upToSequence),
    });
    const tools = dependencies.createToolRegistry?.() ?? createDefaultToolRegistry();
    let memoryMutationApplier: ((targetRunId: RunId, mutation: MemoryMutation) => Promise<void>) | undefined;
    const memoryRetrievalMode = resolveMemoryRetrievalMode(config);
    const configuredEmbeddingProvider = memoryRetrievalMode === "hybrid"
      ? dependencies.createMemoryEmbeddingProvider?.({ config, credentials })
      : undefined;
    const memoryRetrievalService = config.memory === "off" || memoryRetrievalMode === "off"
      ? undefined
      : (dependencies.createMemoryRecallService?.({
          config,
          credentials,
          ...(configuredEmbeddingProvider === undefined ? {} : { provider: configuredEmbeddingProvider }),
        }) ?? createMemoryRecallService(config, credentials, configuredEmbeddingProvider));
    if (config.planning) {
      const planRoot = resolve(config.outputDir, "plan-store");
      const planStore = (dependencies.createPlanStore ?? ((rootDir) => new FilePlanStore(rootDir)))(planRoot);
      tools.registerMany(createPlanningTools(planStore));
    }
    if (config.memory !== "off") {
      const memoryRoot = resolve(config.outputDir, "memory-store");
      const memoryStore = (dependencies.createMemoryStore ?? ((rootDir) => new FileMemoryStore(rootDir)))(memoryRoot);
      tools.registerMany(createMemoryTools(memoryStore, config.memory, {
        ...(memoryRetrievalService === undefined ? {} : { retrieval: memoryRetrievalService }),
      }));
      memoryMutationApplier = async (targetRunId, mutation) => {
        const next = await memoryStore.apply(targetRunId, mutation);
        memoryRetrievalService?.syncState(next);
      };
    }

    const providerFactory = dependencies.createProvider ?? createProvider;
    const provider = await providerFactory({
      model: config.model,
      config,
      assetReader,
      outputDir: config.outputDir,
      credentials,
    });
    if (config.riskModel !== "off" && config.riskModel !== "same") {
      await mkdir(resolve(config.outputDir, "risk-review"), { recursive: true });
    }
    const riskProvider = config.riskModel === "off"
      ? undefined
      : config.riskModel === "same"
        ? provider
        : await providerFactory({
            model: config.riskModel,
            config,
            assetReader,
            outputDir: resolve(config.outputDir, "risk-review"),
            credentials,
          });
    const actionPolicy = dependencies.createActionPolicy === undefined
      ? createActionPolicy(config, riskProvider)
      : dependencies.createActionPolicy(config, riskProvider);
    const features = featureConfig(config);
    const contextCompiler = dependencies.createContextCompiler?.(tools, features, config) ?? new DefaultContextCompiler(tools, {
      mode: config.contextMode,
      maxHistoryEvents: config.contextMaxHistoryEvents,
      features,
      ...(memoryMutationApplier === undefined ? {} : { memoryMutationApplier }),
      ...(config.contextMaxInputTokens === undefined ? {} : { maxInputTokens: config.contextMaxInputTokens }),
    });
    const computer = await (dependencies.createComputer ?? ((options) => createComputer(options.config, {
      ...dependencies.computerFactoryDependencies,
      ...(credentials.osworldBridgeToken === undefined ? {} : { osworldBridgeToken: credentials.osworldBridgeToken }),
    })))(
      {
        config: config.computer,
        credentials,
      },
    );
    const cleanupDiagnostics: import("@computer-harness/runtime").CleanupDiagnostic[] = [];
    const windowTargetToolNames = config.computer.kind === "cua" && config.computer.windowTarget !== undefined
      ? tools.list()
        .filter((definition) => definition.category !== "computer" || definition.name === "click" || definition.name === "wait")
        .map((definition) => definition.name)
      : undefined;
    controller = new RunController({
      runId,
      provider,
      computer,
      contextCompiler,
      toolRegistry: tools,
      policy: dependencies.createPolicy?.(config) ?? new DefaultRuntimePolicy(config.maxSteps, config.maxModelRequests),
      ...(actionPolicy === undefined ? {} : { actionPolicy }),
      eventWriter,
      assetStore,
      ...(dependencies.onCleanupError === undefined
        ? { onCleanupError: (diagnostic: import("@computer-harness/runtime").CleanupDiagnostic) => cleanupDiagnostics.push(diagnostic) }
        : { onCleanupError: (diagnostic: import("@computer-harness/runtime").CleanupDiagnostic) => { cleanupDiagnostics.push(diagnostic); dependencies.onCleanupError?.(diagnostic); } }),
      onEventCommitted: eventFeed.publish,
      batching: config.batching,
      cleanupDeadlineMs: config.cleanupDeadlineMs,
      features,
      ...(windowTargetToolNames === undefined ? {} : { enabledToolNames: windowTargetToolNames }),
      ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
      ...(dependencies.idFactory === undefined ? {} : { idFactory: dependencies.idFactory }),
    });
    return createRunHandle(config, runId, controller, eventWriter, eventFeed, cleanupDiagnostics);
  } catch (error) {
    eventFeed?.close();
    await eventWriter?.close().catch(() => undefined);
    throw error;
  }
}

function resolveMemoryRetrievalMode(config: ResolvedRunConfig): MemoryRetrievalMode {
  if (config.memory === "off") return "off";
  return config.memoryRetrieval ?? "lexical";
}

function createMemoryRecallService(
  config: ResolvedRunConfig,
  credentials: ProviderCredentials,
  configuredProvider: MemoryEmbeddingProvider | undefined,
): HybridMemoryRecallService {
  const mode = resolveMemoryRetrievalMode(config);
  let provider: MemoryEmbeddingProvider | undefined;
  if (mode === "hybrid") {
    provider = configuredProvider ?? createDefaultEmbeddingProvider(config, credentials);
    if (provider === undefined) throw new Error("memoryRetrieval hybrid requires an explicit embedding provider");
  }
  return new HybridMemoryRecallService(provider, {
    ...(config.memoryEmbeddingMaxRequests === undefined ? {} : { maxEmbeddingRequestsPerRun: config.memoryEmbeddingMaxRequests }),
    ...(config.memoryEmbeddingTimeoutMs === undefined ? {} : { deadlineMs: config.memoryEmbeddingTimeoutMs }),
  });
}

function createDefaultEmbeddingProvider(config: ResolvedRunConfig, credentials: ProviderCredentials): MemoryEmbeddingProvider {
  if (config.memoryEmbeddingEndpoint === undefined || config.memoryEmbeddingEndpoint.trim().length === 0) {
    throw new Error("memoryRetrieval hybrid requires --memory-embedding-endpoint or an injected endpoint");
  }
  if (credentials.memoryEmbeddingApiKey === undefined || credentials.memoryEmbeddingApiKey.trim().length === 0) {
    throw new Error("memoryRetrieval hybrid requires an independent memory embedding credential");
  }
  return new QwenTextEmbeddingProvider({
    endpoint: config.memoryEmbeddingEndpoint,
    apiKey: credentials.memoryEmbeddingApiKey,
  });
}

function createActionPolicy(config: ResolvedRunConfig, riskProvider: ProviderAdapter | undefined): ActionPolicy | undefined {
  if (config.riskGuard !== "layered") return undefined;
  return new LayeredRiskGuard({
    ...(riskProvider === undefined ? {} : { assessor: new ProviderRiskAssessor(riskProvider) }),
    maxModelRequests: config.riskMaxModelRequests,
    timeoutMs: config.riskTimeoutMs,
  });
}

function featureConfig(config: ResolvedRunConfig): RunFeatureConfig {
  return {
    planning: config.planning ? "tasks-v1" : "off",
    memory: config.memory === "off" ? "off" : config.memory === "facts" ? "facts-v1" : "entities-v1",
    batching: config.batching,
    riskGuard: config.riskGuard,
    monitor: config.monitor ?? "off",
  };
}

function generatedRunId(): RunId {
  return `run-${Date.now()}-${randomUUID().slice(0, 12)}` as RunId;
}

function createRunHandle(
  config: ResolvedRunConfig,
  runId: RunId,
  controller: RunController,
  eventWriter: RunEventWriter,
  eventFeed: CommittedEventFeed,
  cleanupDiagnostics: readonly import("@computer-harness/runtime").CleanupDiagnostic[],
): RunHandle {
  let startPromise: Promise<RunOutcome> | undefined;
  let completionPromise: Promise<RunOutcome> | undefined;
  let prestartCleanupPromise: Promise<void> | undefined;
  let controllerStarted = false;
  let closedBeforeStart = false;
  let feedClosed = false;
  const closeFeed = (): void => {
    if (feedClosed) return;
    feedClosed = true;
    eventFeed.close();
  };
  const closeBeforeControllerStart = (): Promise<void> => {
    prestartCleanupPromise ??= eventWriter.close();
    return prestartCleanupPromise;
  };
  return {
    runId,
    config,
    controller,
    eventFeed,
    start(starter = (current, goal, mark) => {
      const started = current.start(goal);
      mark();
      return started;
    }) {
      if (closedBeforeStart) return Promise.reject(new Error(`RunHandle for ${runId} is already closed`));
      if (startPromise !== undefined) return Promise.reject(new Error(`RunHandle for ${runId} can only start once`));
      const markControllerStarted = () => { controllerStarted = true; };
      const starterPromise = config.goal.trim().length === 0
        ? Promise.reject<RunOutcome>(new Error("RunController.start requires a non-empty goal"))
        : Promise.resolve().then(() => starter(controller, config.goal, markControllerStarted));
      startPromise = starterPromise;
      completionPromise = starterPromise.then(async (outcome) => {
        if (!controllerStarted) {
          await closeBeforeControllerStart().catch(() => undefined);
          closeFeed();
          throw new Error(`RunHandle for ${runId} starter completed without starting its Controller`);
        }
        return outcome;
      }, async (error: unknown) => {
        if (!controllerStarted) {
          await closeBeforeControllerStart().catch(() => undefined);
          closeFeed();
        }
        throw error;
      });
      return completionPromise;
    },
    report() {
      if (completionPromise === undefined) return Promise.reject(new Error(`RunHandle for ${runId} has not started`));
      return completionPromise.then(() => buildRunReport(config, runId, cleanupDiagnostics, controller.getEffectiveToolNames()));
    },
    async close() {
      if (completionPromise !== undefined) {
        try {
          await completionPromise;
        } finally {
          closeFeed();
        }
        return;
      }
      if (closedBeforeStart) return;
      closedBeforeStart = true;
      try {
        await eventWriter.close();
      } finally {
        closeFeed();
      }
    },
  };
}
