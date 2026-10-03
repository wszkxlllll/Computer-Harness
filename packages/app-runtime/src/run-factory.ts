import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { DefaultContextCompiler } from "@computer-harness/context";
import { createMemoryRunModule, FileMemoryStore, HybridMemoryRecallService, QwenTextEmbeddingProvider, type MemoryEmbeddingProvider, type MemoryRunModule } from "@computer-harness/memory";
import { createExecutionSegmentTools, createPlanningRunModule, FilePlanStore, type PlanningRunModule } from "@computer-harness/planning";
import type { MemoryMutation, RunId, RunOutcome } from "@computer-harness/protocol";
import { LayeredRiskGuard, ProviderRiskAssessor } from "@computer-harness/risk-guard";
import {
  DefaultRuntimePolicy,
  RunController,
  createDefaultToolRegistry,
  windowSwitchTools,
  type ActionPolicy,
  type CleanupDiagnostic,
  type CleanupOperation,
  type Computer,
  type ContextCompiler,
  type ContextCompileInput,
  type MemoryRecallService,
  type ProviderAdapter,
  type RunFeatureConfig,
  type RuntimePolicy,
  type ToolRegistry,
} from "@computer-harness/runtime";
import { FileAssetStore, JsonlRunEventWriter, type AssetStore, type RunEventWriter } from "@computer-harness/trajectory";
import type { AssetReader } from "@computer-harness/runtime";
import { createComputer, prepareComputerRunAssembly } from "./computers.js";
import { createProvider } from "./providers.js";
import { buildRunReport } from "./reporting.js";
import { createRunEventFeed, type CommittedEventFeed } from "./event-feed.js";
import type { MemoryRetrievalMode, ProviderCredentials, ResolvedRunConfig, RunDependencies, RunHandle } from "./config.js";

export async function createRun(input: ResolvedRunConfig, dependencies: RunDependencies = {}): Promise<RunHandle> {
  const runId = input.runId ?? generatedRunId();
  const browserInitialGrounding = input.grounding === "dom-catalog-v1" || input.grounding === "hybrid-catalog-v1";
  const companionRequested = input.computer.kind === "cua" && input.computer.managedBrowserCompanion === true;
  if (companionRequested && input.windowSwitch !== "opened-windows-v1") {
    throw new Error("managed browser companion requires the opened-windows-v1 Run opt-in");
  }
  if (companionRequested && browserInitialGrounding) {
    throw new Error("managed browser companion cannot also be the initial browser target");
  }
  const prepareManagedBrowserCompanion = companionRequested && input.windowSwitch === "opened-windows-v1";
  const grounding = prepareManagedBrowserCompanion ? "hybrid-catalog-v1" : input.grounding ?? "off";
  const inputComputer = prepareManagedBrowserCompanion && input.computer.kind === "cua"
    ? {
      ...input.computer,
      managedBrowserCompanion: true,
      managedBrowserUrl: input.computer.managedBrowserUrl ?? "about:blank",
    }
    : input.computer;
  const baseConfig: ResolvedRunConfig = {
    ...input,
    runId,
    grounding,
    windowSwitch: input.windowSwitch ?? "off",
    windowHandoff: input.windowHandoff ?? (input.windowSwitch === "opened-windows-v1" ? "confirm-v1" : "off"),
    outputDir: resolve(input.outputDir),
  };
  validateExternalSelections(baseConfig, dependencies);
  const computerAssembly = prepareComputerRunAssembly(inputComputer, grounding, baseConfig.windowSwitch);
  const config: ResolvedRunConfig = {
    ...baseConfig,
    computer: computerAssembly.config,
  };
  // The preference snapshot has one consumer: Context. Keep its private text
  // out of Provider, Memory, and policy factory configuration objects.
  const factoryConfig = withoutAssistantPreferences(config);
  validateRunModuleFactories(config, dependencies);
  if (!Number.isInteger(config.cleanupDeadlineMs) || config.cleanupDeadlineMs <= 0) {
    throw new Error("cleanupDeadlineMs must be a positive integer");
  }
  const credentials = dependencies.credentials ?? {};
  const cleanupDiagnostics: CleanupDiagnostic[] = [];
  const recordCleanupError = (diagnostic: CleanupDiagnostic): void => {
    cleanupDiagnostics.push(diagnostic);
    try {
      dependencies.onCleanupError?.(diagnostic);
    } catch {
      // Cleanup diagnostics must not replace the Run outcome or assembly error.
    }
  };
  const ownedProviders: ProviderAdapter[] = [];
  let computer: Computer | undefined;
  let eventWriter: RunEventWriter | undefined;
  let eventFeed: CommittedEventFeed | undefined;
  let controller: RunController | undefined;
  let planningModule: PlanningRunModule | undefined;
  let memoryModule: MemoryRunModule | undefined;
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
    const providerFactory = dependencies.createProvider ?? createProvider;
    const provider = await providerFactory({
      model: config.model,
      config: factoryConfig,
      assetReader,
      outputDir: config.outputDir,
      credentials,
    });
    ownedProviders.push(provider);
    if (typeof config.model !== "string" && provider.id !== config.model.id) {
      throw new Error(`injected Provider id '${provider.id}' does not match configured external Provider '${config.model.id}'`);
    }

    const tools = dependencies.createToolRegistry?.() ?? createDefaultToolRegistry();
    tools.registerMany(computerAssembly.groundingTools);
    let memoryMutationApplier: ((targetRunId: RunId, mutation: MemoryMutation) => Promise<void>) | undefined;
    const memoryRetrievalMode = resolveMemoryRetrievalMode(config);
    const usesCompleteMemoryModule = config.memory !== "off" && dependencies.createMemoryModule !== undefined;
    const configuredEmbeddingProvider = !usesCompleteMemoryModule && memoryRetrievalMode === "hybrid"
      ? dependencies.createMemoryEmbeddingProvider?.({ config: factoryConfig, credentials })
      : undefined;
    const memoryRetrievalService = config.memory === "off" || usesCompleteMemoryModule || memoryRetrievalMode === "off"
      ? undefined
      : (dependencies.createMemoryRecallService?.({
          config: factoryConfig,
          credentials,
          ...(configuredEmbeddingProvider === undefined ? {} : { provider: configuredEmbeddingProvider }),
        }) ?? createMemoryRecallService(factoryConfig, credentials, configuredEmbeddingProvider));
    if (config.planning) {
      const planRoot = resolve(config.outputDir, "plan-store");
      planningModule = dependencies.createPlanningModule?.({ runId, rootDir: planRoot })
        ?? createPlanningRunModule(runId, (dependencies.createPlanStore ?? ((rootDir) => new FilePlanStore(rootDir)))(planRoot));
      validatePlanningRunModule(planningModule, runId);
      tools.registerMany(coordinatePlanningTools(planningModule));
    }
    if (config.executionSegments === "segments-v1") {
      tools.registerMany(createExecutionSegmentTools());
    }
    if (config.memory !== "off") {
      const memoryRoot = resolve(config.outputDir, "memory-store");
      if (dependencies.createMemoryModule !== undefined) {
        memoryModule = dependencies.createMemoryModule({ runId, rootDir: memoryRoot, mode: config.memory, config: factoryConfig, credentials });
      } else {
        const memoryStore = (dependencies.createMemoryStore ?? ((rootDir) => new FileMemoryStore(rootDir)))(memoryRoot);
        memoryModule = createMemoryRunModule(runId, memoryStore, {
          mode: config.memory,
          ...(memoryRetrievalService === undefined ? {} : { retrieval: memoryRetrievalService, recall: createContextMemoryRecall(memoryRetrievalService) }),
        });
      }
      validateMemoryRunModule(memoryModule, runId);
      tools.registerMany(coordinateMemoryTools(memoryModule));
      memoryMutationApplier = async (targetRunId, mutation) => {
        assertModuleRunId(memoryModule!.runId, targetRunId, "Memory");
        const next = await memoryModule!.apply(structuredClone(mutation));
        assertModuleRunId(memoryModule!.runId, next.runId, "Memory mutation result");
      };
    }

    const createdComputer = await (dependencies.createComputer ?? ((options) => createComputer(options.config, {
      ...dependencies.computerFactoryDependencies,
      ...(credentials.osworldBridgeToken === undefined ? {} : { osworldBridgeToken: credentials.osworldBridgeToken }),
    })))(
      {
        config: computerAssembly.config,
        credentials,
      },
    );
    computer = createdComputer;
    if (config.windowSwitch === "opened-windows-v1" && createdComputer.listWindows === undefined) {
      throw new Error("windowSwitch opened-windows-v1 requires a Computer with listWindows support");
    }
    if (config.windowSwitch === "opened-windows-v1") tools.registerMany(windowSwitchTools());

    if (config.riskGuard === "layered" && config.riskModel !== "off" && config.riskModel !== "same") {
      await mkdir(resolve(config.outputDir, "risk-review"), { recursive: true });
    }
    const riskProvider = config.riskGuard !== "layered" || config.riskModel === "off"
      ? undefined
      : config.riskModel === "same"
        ? provider
        : await providerFactory({
            model: config.riskModel,
            config: factoryConfig,
            assetReader,
            outputDir: resolve(config.outputDir, "risk-review"),
            credentials,
          });
    if (riskProvider !== undefined && riskProvider !== provider) ownedProviders.push(riskProvider);
    const actionPolicy = dependencies.createActionPolicy === undefined
      ? createActionPolicy(factoryConfig, riskProvider)
      : dependencies.createActionPolicy(factoryConfig, riskProvider);
    const features = featureConfig(config);
    const contextMemoryRecall = memoryModule?.recall === undefined ? undefined : scopeMemoryRecall(memoryModule, runId);
    const baseContextCompiler = dependencies.createContextCompiler?.(tools, features, factoryConfig, contextMemoryRecall) ?? new DefaultContextCompiler(tools, {
      mode: config.contextMode,
      maxHistoryEvents: config.contextMaxHistoryEvents,
      features,
      ...(contextMemoryRecall === undefined ? {} : { memoryRecall: contextMemoryRecall }),
      ...(config.contextMaxInputTokens === undefined ? {} : { maxInputTokens: config.contextMaxInputTokens }),
    });
    const contextCompiler = projectModuleContext(baseContextCompiler, runId, planningModule, memoryModule);
    const enabledToolNames = computerAssembly.enabledToolNames(tools);
    controller = new RunController({
      runId,
      provider,
      computer: createdComputer,
      contextCompiler,
      toolRegistry: tools,
      policy: dependencies.createPolicy?.(factoryConfig) ?? new DefaultRuntimePolicy(config.maxSteps, config.maxModelRequests),
      ...(actionPolicy === undefined ? {} : { actionPolicy }),
      eventWriter,
      assetStore,
      onCleanupError: recordCleanupError,
      onEventCommitted: eventFeed.publish,
      batching: config.batching,
      windowHandoff: config.windowHandoff ?? "off",
      windowSwitch: config.windowSwitch ?? "off",
      ...(config.assistantPreferences === undefined ? {} : { assistantPreferences: config.assistantPreferences }),
      cleanupDeadlineMs: config.cleanupDeadlineMs,
      features,
      ...(memoryMutationApplier === undefined ? {} : { memoryMutationApplier }),
      ...(enabledToolNames === undefined ? {} : { enabledToolNames }),
      ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
      ...(dependencies.idFactory === undefined ? {} : { idFactory: dependencies.idFactory }),
    });
    return createRunHandle(
      config,
      runId,
      controller,
      eventFeed,
      cleanupDiagnostics,
      () => attemptOwnedCleanup(
        "event_writer.close",
        () => eventWriter!.close(),
        Date.now() + config.cleanupDeadlineMs,
        recordCleanupError,
      ),
      (includeComputer) => releaseAdapters({
        providers: ownedProviders,
        ...(computer === undefined ? {} : { computer }),
        ...(planningModule === undefined ? {} : { planningModule }),
        ...(memoryModule === undefined ? {} : { memoryModule }),
        includeComputer,
        deadlineMs: config.cleanupDeadlineMs,
        onCleanupError: recordCleanupError,
      }),
    );
  } catch (error) {
    eventFeed?.close();
    const cleanupFailures: unknown[] = [];
    if (eventWriter !== undefined) {
      cleanupFailures.push(...await attemptOwnedCleanup("event_writer.close", () => eventWriter!.close(), Date.now() + config.cleanupDeadlineMs, recordCleanupError));
    }
    cleanupFailures.push(...await releaseAdapters({
      providers: ownedProviders,
      ...(computer === undefined ? {} : { computer }),
      ...(planningModule === undefined ? {} : { planningModule }),
      ...(memoryModule === undefined ? {} : { memoryModule }),
      includeComputer: true,
      deadlineMs: config.cleanupDeadlineMs,
      onCleanupError: recordCleanupError,
    }));
    if (cleanupFailures.length > 0) {
      throw new AggregateError([error, ...cleanupFailures], "Run assembly failed and one or more owned resources did not close", { cause: error });
    }
    throw error;
  }
}

function validateRunModuleFactories(config: ResolvedRunConfig, dependencies: RunDependencies): void {
  if (config.planning && dependencies.createPlanningModule !== undefined && dependencies.createPlanStore !== undefined) {
    throw new Error("Planning is configured by both createPlanningModule and legacy createPlanStore; choose one Run-scoped entry");
  }
  if (config.memory !== "off" && dependencies.createMemoryModule !== undefined && (
    dependencies.createMemoryStore !== undefined
    || dependencies.createMemoryRecallService !== undefined
    || dependencies.createMemoryEmbeddingProvider !== undefined
  )) {
    throw new Error("Memory is configured by createMemoryModule and legacy Memory factories; choose one Run-scoped entry");
  }
}

function validatePlanningRunModule(module: PlanningRunModule, runId: RunId): void {
  if (module.runId !== runId) throw new Error(`PlanningRunModule for '${module.runId}' cannot be used by Run '${runId}'`);
  if (typeof module.apply !== "function" || typeof module.restoreFromEvents !== "function" || typeof module.projectContext !== "function") {
    throw new Error("PlanningRunModule must provide apply, restoreFromEvents, and projectContext");
  }
  if (!Array.isArray(module.tools) || module.tools.some((tool) => tool.category !== "planning")) {
    throw new Error("PlanningRunModule must provide planning-category tools");
  }
  if (module.tools.some((tool) => tool.planMutationFromResult !== undefined && tool.afterPlanCommit !== undefined)) {
    throw new Error("PlanningRunModule mutation tools must leave afterPlanCommit to app-runtime");
  }
}

function validateMemoryRunModule(module: MemoryRunModule, runId: RunId): void {
  if (module.runId !== runId) throw new Error(`MemoryRunModule for '${module.runId}' cannot be used by Run '${runId}'`);
  if (typeof module.apply !== "function" || typeof module.restoreFromEvents !== "function" || typeof module.projectContext !== "function") {
    throw new Error("MemoryRunModule must provide apply, restoreFromEvents, and projectContext");
  }
  if (module.recall !== undefined && typeof module.recall.search !== "function") {
    throw new Error("MemoryRunModule recall must provide search");
  }
  if (!Array.isArray(module.tools) || module.tools.some((tool) => tool.category !== "side")) {
    throw new Error("MemoryRunModule must provide side-category tools");
  }
  if (module.tools.some((tool) => tool.memoryMutationFromResult !== undefined && tool.afterMemoryCommit !== undefined)) {
    throw new Error("MemoryRunModule mutation tools must leave afterMemoryCommit to app-runtime");
  }
}

function coordinatePlanningTools(module: PlanningRunModule): readonly import("@computer-harness/runtime").NonComputerToolDefinition[] {
  return module.tools.map((tool) => ({
    ...tool,
    execute: async (args, context) => {
      assertModuleRunId(module.runId, context.runId, "Planning tool");
      return tool.execute(args, context);
    },
    ...(tool.planMutationFromResult === undefined ? {} : {
      afterPlanCommit: async (mutation, context) => {
        assertModuleRunId(module.runId, context.runId, "Planning");
        const next = await module.apply(structuredClone(mutation));
        assertModuleRunId(module.runId, next.runId, "Planning mutation result");
      },
    }),
  }));
}

function coordinateMemoryTools(module: MemoryRunModule): readonly import("@computer-harness/runtime").NonComputerToolDefinition[] {
  return module.tools.map((tool) => ({
    ...tool,
    execute: async (args, context) => {
      assertModuleRunId(module.runId, context.runId, "Memory tool");
      return tool.execute(args, context);
    },
    ...(tool.memoryMutationFromResult === undefined ? {} : {
      afterMemoryCommit: async (mutation, context) => {
        assertModuleRunId(module.runId, context.runId, "Memory");
        const next = await module.apply(structuredClone(mutation));
        assertModuleRunId(module.runId, next.runId, "Memory mutation result");
      },
    }),
  }));
}

function projectModuleContext(
  compiler: ContextCompiler,
  runId: RunId,
  planning: PlanningRunModule | undefined,
  memory: MemoryRunModule | undefined,
): ContextCompiler {
  if (planning === undefined && memory === undefined) return compiler;
  return {
    async compile(input: ContextCompileInput, signal: AbortSignal) {
      assertModuleRunId(runId, input.runId, "Context");
      let plan = input.plan;
      if (planning !== undefined && plan !== undefined) {
        assertModuleRunId(planning.runId, plan.runId, "Planning Context");
        plan = structuredClone(await planning.projectContext(structuredClone(plan)));
        assertModuleRunId(runId, plan.runId, "Planning Context projection");
      }
      let projectedMemory = input.memory;
      if (memory !== undefined && projectedMemory !== undefined) {
        assertModuleRunId(memory.runId, projectedMemory.runId, "Memory Context");
        projectedMemory = structuredClone(await memory.projectContext(
          structuredClone(projectedMemory),
          plan === undefined ? undefined : structuredClone(plan),
        ));
        assertModuleRunId(runId, projectedMemory.runId, "Memory Context projection");
      }
      return compiler.compile({
        ...input,
        ...(plan === undefined ? {} : { plan }),
        ...(projectedMemory === undefined ? {} : { memory: projectedMemory }),
      }, signal);
    },
  };
}

function scopeMemoryRecall(module: MemoryRunModule, runId: RunId): MemoryRecallService | undefined {
  if (module.recall === undefined) return undefined;
  return {
    search(state, query, signal) {
      assertModuleRunId(runId, query.runId, "Memory recall query");
      assertModuleRunId(runId, state.runId, "Memory recall state");
      return module.recall!.search(state, query, signal);
    },
  };
}

function assertModuleRunId(expected: RunId, actual: RunId, label: string): void {
  if (actual !== expected) throw new Error(`${label} for Run '${actual}' does not match module Run '${expected}'`);
}

function validateExternalSelections(config: ResolvedRunConfig, dependencies: RunDependencies): void {
  if (typeof config.model !== "string") {
    validateExternalId(config.model.id, "Provider");
    if (dependencies.createProvider === undefined) {
      throw new Error(`external Provider '${config.model.id}' requires RunDependencies.createProvider`);
    }
  }
  if (config.computer.kind === "external") {
    validateExternalId(config.computer.id, "Computer");
    if (dependencies.createComputer === undefined) {
      throw new Error(`external Computer '${config.computer.id}' requires RunDependencies.createComputer`);
    }
  }
}

function validateExternalId(id: string, label: string): void {
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(id)) {
    throw new Error(`external ${label} id must be 1-64 ASCII letters, digits, dots, underscores, or hyphens`);
  }
}

interface AdapterReleaseOptions {
  readonly providers: readonly ProviderAdapter[];
  readonly computer?: Computer;
  readonly planningModule?: PlanningRunModule;
  readonly memoryModule?: MemoryRunModule;
  readonly includeComputer: boolean;
  readonly deadlineMs: number;
  readonly onCleanupError: (diagnostic: CleanupDiagnostic) => void;
}

async function releaseAdapters(options: AdapterReleaseOptions): Promise<unknown[]> {
  const failures: unknown[] = [];
  const deadline = Date.now() + options.deadlineMs;
  if (options.includeComputer && options.computer?.dispose !== undefined) {
    failures.push(...await attemptOwnedCleanup(
      "computer.dispose",
      () => options.computer!.dispose!(),
      deadline,
      options.onCleanupError,
    ));
  }
  const closed = new Set<ProviderAdapter>();
  for (const provider of [...options.providers].reverse()) {
    if (provider.close === undefined || closed.has(provider)) continue;
    closed.add(provider);
    failures.push(...await attemptOwnedCleanup("provider.close", () => provider.close!(), deadline, options.onCleanupError));
  }
  const closedModules = new Set<object>();
  for (const entry of [
    { operation: "memory_module.close" as const, module: options.memoryModule },
    { operation: "planning_module.close" as const, module: options.planningModule },
  ]) {
    if (entry.module?.close === undefined || closedModules.has(entry.module)) continue;
    closedModules.add(entry.module);
    failures.push(...await attemptOwnedCleanup(entry.operation, () => entry.module!.close!(), deadline, options.onCleanupError));
  }
  return failures;
}

async function attemptOwnedCleanup(
  operation: CleanupOperation,
  work: () => Promise<void>,
  deadline: number,
  onCleanupError: (diagnostic: CleanupDiagnostic) => void,
): Promise<unknown[]> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    const error = new Error(`cleanup deadline exceeded before ${operation}`);
    onCleanupError({ operation, message: error.message, status: "timed_out" });
    return [error];
  }
  const settled = Promise.resolve().then(work).then(
    () => ({ status: "completed" as const }),
    (error: unknown) => ({ status: "failed" as const, error }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ status: "timed_out" }>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timed_out" }), remaining);
  });
  const result = await Promise.race([settled, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  if (result.status === "completed") return [];
  if (result.status === "failed") {
    const message = errorMessage(result.error);
    onCleanupError({ operation, message });
    return [result.error];
  }
  const error = new Error(`cleanup deadline exceeded during ${operation}`);
  onCleanupError({ operation, message: error.message, status: "timed_out" });
  return [error];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createContextMemoryRecall(service: HybridMemoryRecallService): MemoryRecallService {
  return {
    async search(state, query, signal) {
      const result = await service.search(state, query, signal);
      return {
        method: result.trace.method,
        semanticStatus: result.trace.semanticStatus,
        stateStable: result.trace.stateStable,
        embeddingBudgetUsed: result.trace.embeddingBudgetUsed,
        embeddingBudgetLimit: result.trace.embeddingBudgetLimit,
        admitted: result.trace.admitted,
        revalidation: result.trace.revalidation,
        excluded: result.trace.excluded,
      };
    },
  };
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
    executionSegments: config.executionSegments ?? "off",
    memory: config.memory === "off" ? "off" : config.memory === "facts" ? "facts-v1" : "entities-v1",
    batching: config.batching,
    riskGuard: config.riskGuard,
    monitor: config.monitor ?? "off",
  };
}

function withoutAssistantPreferences(config: ResolvedRunConfig): ResolvedRunConfig {
  const { assistantPreferences: _privateContextInput, ...factoryConfig } = config;
  if (factoryConfig.computer.kind !== "cua") return factoryConfig;
  const {
    windowSwitchAllowedTargets: _hostOnlyTargetScope,
    managedBrowserCompanion: _runOnlyBrowserCompanion,
    managedBrowserProfileRoot: _hostOnlyProfileRoot,
    managedBrowserProfileLabel: _hostOnlyProfileLabel,
    ...computer
  } = factoryConfig.computer;
  if (_hostOnlyTargetScope === undefined && _runOnlyBrowserCompanion === undefined && _hostOnlyProfileRoot === undefined &&
      _hostOnlyProfileLabel === undefined) return factoryConfig;
  return { ...factoryConfig, computer };
}

function generatedRunId(): RunId {
  return `run-${Date.now()}-${randomUUID().slice(0, 12)}` as RunId;
}

function createRunHandle(
  config: ResolvedRunConfig,
  runId: RunId,
  controller: RunController,
  eventFeed: CommittedEventFeed,
  cleanupDiagnostics: readonly CleanupDiagnostic[],
  closeOwnedEventWriter: () => Promise<unknown[]>,
  releaseOwnedAdapters: (includeComputer: boolean) => Promise<unknown[]>,
): RunHandle {
  let startPromise: Promise<RunOutcome> | undefined;
  let completionPromise: Promise<RunOutcome> | undefined;
  let prestartCleanupPromise: Promise<unknown[]> | undefined;
  let controllerStarted = false;
  let closedBeforeStart = false;
  let feedClosed = false;
  let ownedAdapterCleanupPromise: Promise<unknown[]> | undefined;
  const cleanupOwnedAdapters = (includeComputer: boolean): Promise<unknown[]> => {
    ownedAdapterCleanupPromise ??= releaseOwnedAdapters(includeComputer);
    return ownedAdapterCleanupPromise;
  };
  const closeFeed = (): void => {
    if (feedClosed) return;
    feedClosed = true;
    eventFeed.close();
  };
  const closeBeforeControllerStart = (): Promise<unknown[]> => {
    prestartCleanupPromise ??= closeOwnedEventWriter();
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
      const completion = starterPromise.then(async (outcome) => {
        if (!controllerStarted) {
          await closeBeforeControllerStart();
          closeFeed();
          throw new Error(`RunHandle for ${runId} starter completed without starting its Controller`);
        }
        return outcome;
      }, async (error: unknown) => {
        if (!controllerStarted) {
          await closeBeforeControllerStart();
          closeFeed();
        }
        throw error;
      });
      completionPromise = completion.finally(async () => {
        await cleanupOwnedAdapters(!controllerStarted);
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
      let failures: unknown[] = [];
      try {
        failures = await closeBeforeControllerStart();
      } finally {
        closeFeed();
      }
      failures.push(...await cleanupOwnedAdapters(true));
      if (failures.length > 0) {
        throw new AggregateError(failures, `RunHandle for ${runId} failed to close all owned resources`);
      }
    },
  };
}
