import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { DefaultContextCompiler } from "@computer-harness/context";
import { createMemoryTools, FileMemoryStore, HybridMemoryRecallService, QwenTextEmbeddingProvider, type MemoryEmbeddingProvider } from "@computer-harness/memory";
import { createExecutionSegmentTools, createPlanningTools, FilePlanStore } from "@computer-harness/planning";
import type { MemoryMutation, RunId, RunOutcome } from "@computer-harness/protocol";
import { LayeredRiskGuard, ProviderRiskAssessor } from "@computer-harness/risk-guard";
import {
  DefaultRuntimePolicy,
  RunController,
  createDefaultToolRegistry,
  groundingComputerTools,
  type ActionPolicy,
  type CleanupDiagnostic,
  type CleanupOperation,
  type Computer,
  type ContextCompiler,
  type MemoryRecallService,
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
  const grounding = input.grounding ?? "off";
  const config: ResolvedRunConfig = {
    ...input,
    runId,
    grounding,
    outputDir: resolve(input.outputDir),
    computer: effectiveComputerConfig(input.computer, grounding),
  };
  validateExternalSelections(config, dependencies);
  if (!Number.isInteger(config.cleanupDeadlineMs) || config.cleanupDeadlineMs <= 0) {
    throw new Error("cleanupDeadlineMs must be a positive integer");
  }
  const managedGrounding = grounding === "dom-catalog-v1" || grounding === "hybrid-catalog-v1";
  if (managedGrounding) {
    if (config.computer.kind !== "cua") {
      throw new Error(`grounding ${grounding} requires the CUA computer and its explicit socket`);
    }
    if (!isManagedBrowserUrl(config.computer.managedBrowserUrl)) {
      throw new Error(`grounding ${grounding} requires an explicit managedBrowserUrl (http/https)`);
    }
    if (config.computer.socketPath.trim().length === 0) {
      throw new Error(`grounding ${grounding} requires a non-empty CUA socket`);
    }
    if (config.computer.windowTarget !== undefined) {
      throw new Error(`grounding ${grounding} owns its temporary browser window; omit the preselected CUA window target`);
    }
    const profileMode = config.computer.managedBrowserProfileMode ?? "ephemeral";
    if (profileMode !== "ephemeral" && profileMode !== "persistent") {
      throw new Error("managed browser profile mode must be ephemeral or persistent");
    }
    if (profileMode === "persistent" && (config.computer.managedBrowserProfileLabel === undefined || !/^[A-Za-z0-9._-]{1,64}$/u.test(config.computer.managedBrowserProfileLabel) || config.computer.managedBrowserProfileRoot === undefined || config.computer.managedBrowserProfileRoot.trim().length === 0)) {
      throw new Error("persistent managed browser mode requires a bounded profile label and explicit profile root");
    }
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
    if (config.grounding === "uia-catalog-v1") {
      if (config.computer.kind !== "cua" || config.computer.windowTarget === undefined) {
        throw new Error("grounding uia-catalog-v1 requires an explicit CUA window target");
      }
    }
    if (config.grounding !== "off") {
      tools.registerMany(groundingComputerTools({ includeSelectOption: managedGrounding }));
    }
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
    if (config.executionSegments === "segments-v1") {
      tools.registerMany(createExecutionSegmentTools());
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
    ownedProviders.push(provider);
    if (typeof config.model !== "string" && provider.id !== config.model.id) {
      throw new Error(`injected Provider id '${provider.id}' does not match configured external Provider '${config.model.id}'`);
    }
    if (config.riskGuard === "layered" && config.riskModel !== "off" && config.riskModel !== "same") {
      await mkdir(resolve(config.outputDir, "risk-review"), { recursive: true });
    }
    const riskProvider = config.riskGuard !== "layered" || config.riskModel === "off"
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
    if (riskProvider !== undefined && riskProvider !== provider) ownedProviders.push(riskProvider);
    const actionPolicy = dependencies.createActionPolicy === undefined
      ? createActionPolicy(config, riskProvider)
      : dependencies.createActionPolicy(config, riskProvider);
    const features = featureConfig(config);
    const contextMemoryRecall = memoryRetrievalService === undefined ? undefined : createContextMemoryRecall(memoryRetrievalService);
    const contextCompiler = dependencies.createContextCompiler?.(tools, features, config, contextMemoryRecall) ?? new DefaultContextCompiler(tools, {
      mode: config.contextMode,
      maxHistoryEvents: config.contextMaxHistoryEvents,
      features,
      ...(contextMemoryRecall === undefined ? {} : { memoryRecall: contextMemoryRecall }),
      ...(config.contextMaxInputTokens === undefined ? {} : { maxInputTokens: config.contextMaxInputTokens }),
    });
    const createdComputer = await (dependencies.createComputer ?? ((options) => createComputer(options.config, {
      ...dependencies.computerFactoryDependencies,
      ...(credentials.osworldBridgeToken === undefined ? {} : { osworldBridgeToken: credentials.osworldBridgeToken }),
    })))(
      {
        config: config.computer,
        credentials,
      },
    );
    computer = createdComputer;
    const windowTargetToolNames = config.computer.kind === "cua" && (config.computer.windowTarget !== undefined || managedGrounding)
      ? (() => {
        const allowedComputerTools = new Set(["click", "wait"]);
        if (config.computer.windowDeliveryMode === "foreground") {
          allowedComputerTools.add("type");
          allowedComputerTools.add("keypress");
          allowedComputerTools.add("hotkey");
          allowedComputerTools.add("drag");
          allowedComputerTools.add("scroll");
        }
        if (config.grounding !== "off") allowedComputerTools.add("click_element");
        if (managedGrounding) allowedComputerTools.add("select_option");
        return tools.list()
          .filter((definition) => definition.category !== "computer" || allowedComputerTools.has(definition.name))
          .map((definition) => definition.name);
      })()
      : undefined;
    controller = new RunController({
      runId,
      provider,
      computer: createdComputer,
      contextCompiler,
      toolRegistry: tools,
      policy: dependencies.createPolicy?.(config) ?? new DefaultRuntimePolicy(config.maxSteps, config.maxModelRequests),
      ...(actionPolicy === undefined ? {} : { actionPolicy }),
      eventWriter,
      assetStore,
      onCleanupError: recordCleanupError,
      onEventCommitted: eventFeed.publish,
      batching: config.batching,
      cleanupDeadlineMs: config.cleanupDeadlineMs,
      features,
      ...(memoryMutationApplier === undefined ? {} : { memoryMutationApplier }),
      ...(windowTargetToolNames === undefined ? {} : { enabledToolNames: windowTargetToolNames }),
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
    if (config.grounding !== "off") {
      throw new Error(`external Computer '${config.computer.id}' does not use app-managed CUA/UIA/DOM grounding; set grounding to off`);
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

/**
 * Normalize the single public Run grounding switch into the adapter config.
 * Application/TUI feature overrides change `config.grounding`; the Computer
 * factory must never consume a stale nested value from the previous Run.
 */
function effectiveComputerConfig(
  computer: ResolvedRunConfig["computer"],
  grounding: NonNullable<ResolvedRunConfig["grounding"]>,
): ResolvedRunConfig["computer"] {
  if (computer.kind !== "cua") return computer;
  const managedGrounding = grounding === "dom-catalog-v1" || grounding === "hybrid-catalog-v1";
  return {
    ...computer,
    grounding,
    ...(managedGrounding ? { windowDeliveryMode: "foreground" as const } : {}),
  };
}

function isManagedBrowserUrl(value: string | undefined): value is string {
  if (value === undefined || value.trim().length === 0) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname.length > 0;
  } catch {
    return false;
  }
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
