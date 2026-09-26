import { createHash } from "node:crypto";
import type {
  ActionId,
  ApprovalEvidence,
  ComputerWindowCandidate,
  ActionEffectDeclaration,
  ActionIntent,
  AssetId,
  EventId,
  GroundingBoundingBox,
  GroundingCatalog,
  GroundingRecoveryHint,
  JsonValue,
  ModelTurn,
  MemoryMutation,
  MemoryFact,
  ObservationTransition,
  ObservationFrame,
  ObservationId,
  RunId,
  RunOutcome,
  RuntimeEvent,
  RuntimeEventData,
  ToolCall,
  ToolCallId,
  ToolResult,
} from "@computer-harness/protocol";
import { memoryFactRetentionClass, memoryFactScope, sameMemoryFactContent, validateMemoryMutation } from "@computer-harness/protocol";
import {
  type AssetStore,
  type RunEventWriter,
  type RunSnapshot,
  reduceRunEvent,
} from "@computer-harness/trajectory";
import type {
  Clock,
  Computer,
  ComputerOpenOptions,
  ComputerSession,
  ComputerToolDefinition,
  ContextCompiler,
  GuiActionDraft,
  IdFactory,
  NonComputerToolDefinition,
  ModelInput,
  ModelMessage,
  MonitorGuidance,
  ProviderAdapter,
  PreparedProviderRequest,
  RuntimePolicy,
  ActionPolicy,
  ActionPolicyDecision,
  ToolDefinition,
  ToolExecutionContext,
  ToolAudience,
  ToolCategory,
  ToolPolicyDecision,
  ComputerExecuteOptions,
  RunFeatureConfig,
} from "./contracts.js";
import { randomIdFactory, systemClock } from "./defaults.js";
import { validateActionIntent } from "./action-validation.js";
import { restrictToolNamesForCapabilities, ToolRegistry } from "./tool-registry.js";
import type { CommittedEventListener } from "./committed-events.js";
import { createProgressMonitorState, reduceProgressMonitor, shouldRejectRepeatedNoChange, type ProgressMonitorState } from "./progress-monitor.js";
import { createMonitorPolicyState, reduceMonitorPolicy, type MonitorPolicyProposal, type MonitorPolicyState, type MonitorPolicyMode, type MonitorWorkClock } from "./monitor-policy.js";
import { DeterministicGroundingSelector, type GroundingSelector, type GroundingSelectionQuery, type GroundingStructuredToolHint } from "./grounding-selector.js";
import { finishSummaryRejectionReason } from "./finish-summary.js";

const MAX_PROVIDER_RETRIES = 1;
const PROVIDER_RETRY_BASE_DELAY_MS = 500;
const PROVIDER_RETRY_DELAY_CAP_MS = 5_000;
const PROVIDER_ATTEMPT_DEADLINE_MS = 240_000;
/** Covers the initial request, one retry and their bounded delay for the default HTTP clients. */
const MAX_PROVIDER_RETRY_WINDOW_MS = 480_000;
/** Once GUI actions are exhausted, allow only a small number of model decisions for finish/plan closure. */
const MAX_ACTION_BUDGET_CLOSE_TURNS = 2;
const DEFAULT_CLEANUP_DEADLINE_MS = 5_000;
const cleanupPendingComputers = new WeakSet<Computer>();
export interface RunControllerDependencies {
  runId: RunId;
  provider: ProviderAdapter;
  computer: Computer;
  contextCompiler: ContextCompiler;
  toolRegistry: ToolRegistry;
  policy: RuntimePolicy;
  /** Optional action-level policy. Omitted preserves the pre-Guard baseline. */
  actionPolicy?: ActionPolicy;
  eventWriter: RunEventWriter;
  assetStore: AssetStore;
  clock?: Clock;
  idFactory?: IdFactory;
  computerOpenOptions?: ComputerOpenOptions;
  /** Execution audience is explicit even when only the main Run exists today. */
  toolAudience?: ToolAudience;
  /** Runtime feature gates; omitted keeps all currently registered categories on. */
  enabledCategories?: readonly ToolCategory[];
  /** Optional per-run tool allow-list for independent Planning/Memory switches. */
  enabledToolNames?: readonly string[];
  /** Event-first Memory materialization for Runtime-owned lifecycle mutations. */
  memoryMutationApplier?: (runId: RunId, mutation: MemoryMutation) => Promise<void>;
  /** One immutable source for prompt, Runtime and Registry feature semantics. */
  features?: RunFeatureConfig;
  /** Disabled by default so the existing one-computer-call baseline is stable. */
  batching?: "off" | "same-control-input-v1";
  /** Runtime-owned, deterministic hot-element projection; Computer stays context-agnostic. */
  groundingSelector?: GroundingSelector;
  /** Total wall-clock budget shared by event-writer and Computer cleanup. */
  cleanupDeadlineMs?: number;
  onCleanupError?: (diagnostic: CleanupDiagnostic) => void;
  /**
   * Optional append-after-reduce notification. Observers are read-only and
   * are isolated from the run when their callback throws.
   */
  onEventCommitted?: CommittedEventListener;
  windowHandoff?: "off" | "confirm-v1";
}

export type CleanupOperation = "event_writer.flush" | "event_writer.close" | "computer.close" | "computer.dispose" | "provider.close" | "planning_module.close" | "memory_module.close";
export type CleanupDiagnosticStatus = "timed_out";

export interface CleanupDiagnostic {
  operation: CleanupOperation;
  message: string;
  status?: CleanupDiagnosticStatus;
}

class CleanupOperationFailure extends Error {
  public constructor(public readonly operation: CleanupOperation, public readonly original: unknown) {
    super(errorMessage(original), { cause: original });
  }
}

type CallState = "received" | "proposed" | "executing" | "completed" | "failed" | "rejected";

type RuntimeCommand =
  | {
      kind: "user_input";
      text: string;
      expectedPendingRequestId?: string;
      resolve: () => void;
      reject: (error: unknown) => void;
    }
  | {
      kind: "approval_resolution";
      requestId: string;
      approved: boolean;
      resolve: () => void;
      reject: (error: unknown) => void;
    }
  | {
      kind: "pause";
      reason: string;
      resolve: () => void;
      reject: (error: unknown) => void;
    }
  | {
      kind: "resume";
      resolve: () => void;
      reject: (error: unknown) => void;
    }
  | {
      kind: "window_handoff";
      candidate: ComputerWindowCandidate;
      expectedRequestId?: string;
      resolve: () => void;
      reject: (error: unknown) => void;
    }
  | {
      kind: "ignore_new_window";
      expectedRequestId?: string;
      resolve: () => void;
      reject: (error: unknown) => void;
    };

class CommandInbox {
  private readonly queue: RuntimeCommand[] = [];
  private readonly waiters: Array<{
    resolve: (command: RuntimeCommand) => void;
    reject: (error: unknown) => void;
    cleanup: () => void;
  }> = [];
  private closed = false;

  public enqueue(command: RuntimeCommand): void {
    if (this.closed) {
      command.reject(new Error("run command inbox is closed"));
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.cleanup();
      waiter.resolve(command);
      return;
    }
    this.queue.push(command);
  }

  public drain(): RuntimeCommand[] {
    return this.queue.splice(0, this.queue.length);
  }

  public take(signal: AbortSignal): Promise<RuntimeCommand> {
    const queued = this.queue.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    if (this.closed) {
      return Promise.reject(new Error("run command inbox is closed"));
    }
    return new Promise<RuntimeCommand>((resolve, reject) => {
      let abortHandler: (() => void) | undefined;
      const waiter = {
        resolve,
        reject,
        cleanup: () => {
          if (abortHandler !== undefined) {
            signal.removeEventListener("abort", abortHandler);
            abortHandler = undefined;
          }
        },
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        waiter.cleanup();
        reject(signal.reason ?? new Error("run aborted"));
      };
      abortHandler = onAbort;
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  public close(reason = new Error("run command inbox is closed")): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const command of this.queue.splice(0, this.queue.length)) {
      command.reject(reason);
    }
    for (const waiter of this.waiters.splice(0, this.waiters.length)) {
      waiter.cleanup();
      waiter.reject(reason);
    }
  }
}

interface PendingApproval {
  requestId: string;
  call: ToolCall;
  definition: ToolDefinition;
  session: ComputerSession;
  preparedAction?: PreparedComputerAction;
  executionObservationId?: ObservationId;
}

interface PreparedComputerAction {
  action: ActionIntent;
  decisionObservationId?: ObservationId;
}

interface ObservationFingerprint {
  readonly sessionId: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly viewport: ObservationFrame["viewport"];
  readonly digest: string;
}

interface LatestObservationFingerprint {
  readonly observationId: ObservationId;
  readonly fingerprint: ObservationFingerprint;
}

type PreflightEntry = {
  call: ToolCall;
  definition?: ToolDefinition;
  decision?: ToolPolicyDecision;
  rejection?: string;
  preparedAction?: PreparedComputerAction;
};

interface PendingToolTurn {
  session: ComputerSession;
  entries: readonly PreflightEntry[];
  nextIndex: number;
  invalidated: boolean;
  decisionObservationId?: ObservationId;
  batch?: boolean;
}

interface CommandEffects {
  correction: boolean;
}

export class RunController {
  private readonly runId: RunId;
  private readonly provider: ProviderAdapter;
  private readonly computer: Computer;
  private readonly windowHandoff: "off" | "confirm-v1";
  private activeComputerSession: ComputerSession | undefined;
  private readonly contextCompiler: ContextCompiler;
  private readonly toolRegistry: ToolRegistry;
  private readonly policy: RuntimePolicy;
  private readonly actionPolicy: ActionPolicy | undefined;
  private readonly eventWriter: RunEventWriter;
  private readonly assetStore: AssetStore;
  private readonly clock: Clock;
  private readonly idFactory: IdFactory;
  private readonly computerOpenOptions: ComputerOpenOptions;
  private readonly onCleanupError: ((diagnostic: CleanupDiagnostic) => void) | undefined;
  private readonly onEventCommitted: CommittedEventListener | undefined;
  private readonly toolAudience: ToolAudience;
  private readonly enabledCategories: ReadonlySet<ToolCategory>;
  private enabledToolNames: ReadonlySet<string> | undefined;
  private readonly memoryEnabled: boolean;
  private readonly planningEnabled: boolean;
  private readonly memoryMutationApplier: ((runId: RunId, mutation: MemoryMutation) => Promise<void>) | undefined;
  private readonly batching: "off" | "same-control-input-v1";
  private readonly groundingSelector: GroundingSelector;
  private readonly features: RunFeatureConfig;
  private readonly monitorMode: MonitorPolicyMode;
  private readonly cleanupDeadlineMs: number;
  private readonly abortController = new AbortController();
  private readonly events: RuntimeEvent[] = [];
  /** Full bounded adapter catalog for the latest observation; the model only sees the hot projection. */
  private readonly groundingCandidates = new Map<string, import("@computer-harness/protocol").GroundingCatalog>();
  private readonly callStates = new Map<ToolCallId, CallState>();
  private readonly actionCallIds = new Map<ActionId, ToolCallId>();
  private readonly commandInbox = new CommandInbox();
  /** Private, per-Run evidence for approval revalidation; never enters protocol or Provider Context. */
  private latestObservationFingerprint: LatestObservationFingerprint | undefined;
  private snapshot: RunSnapshot;
  private latestObservation: ObservationFrame | undefined;
  private nextSequence = 0;
  private started = false;
  private pendingApproval: PendingApproval | undefined;
  /** Approval accepted by the Inbox but not yet dispatched. */
  private approvedPendingApproval: PendingApproval | undefined;
  private pendingToolTurn: PendingToolTurn | undefined;
  private pendingModelTurn: { turn: ModelTurn; invalidated?: boolean } | undefined;
  private pendingReobserve = false;
  private actionBudgetExhausted = false;
  private actionBudgetCloseTurnsRemaining = MAX_ACTION_BUDGET_CLOSE_TURNS;
  private goal: string | undefined;
  private monitorState: ProgressMonitorState | undefined;
  private monitorPolicyState: MonitorPolicyState | undefined;
  private monitorWorkClock: MonitorWorkClock = { modelDecisionCount: 0, guiActionCount: 0 };
  private monitorPendingGuidance: MonitorGuidance | undefined;
  private monitorPendingHelp: Extract<MonitorPolicyProposal, { kind: "help_requested" }> | undefined;
  /** Short-lived local recall for the next GroundingCatalog projection. */
  private groundingRecoveryHint: GroundingRecoveryHint | undefined;
  private monitorProcessing = false;
  private monitorDiagnosticRecording = false;
  private monitorProposalCount = 0;
  private monitorLastPersistedKey: string | undefined;
  private monitorLastPartitionKey: string | undefined;
  private sessionMemoryScopeEnded = false;

  public constructor(dependencies: RunControllerDependencies) {
    this.runId = dependencies.runId;
    this.provider = dependencies.provider;
    this.computer = dependencies.computer;
    this.windowHandoff = dependencies.windowHandoff ?? "off";
    this.contextCompiler = dependencies.contextCompiler;
    this.toolRegistry = dependencies.toolRegistry;
    this.policy = dependencies.policy;
    this.actionPolicy = dependencies.actionPolicy;
    this.eventWriter = dependencies.eventWriter;
    this.assetStore = dependencies.assetStore;
    this.clock = dependencies.clock ?? systemClock;
    this.idFactory = dependencies.idFactory ?? randomIdFactory;
    this.computerOpenOptions = dependencies.computerOpenOptions ?? {};
    this.toolAudience = dependencies.toolAudience ?? "main";
    this.enabledCategories = new Set(dependencies.enabledCategories ?? ["computer", "planning", "control", "side"]);
    this.enabledToolNames = dependencies.enabledToolNames === undefined ? undefined : new Set(dependencies.enabledToolNames);
    this.memoryMutationApplier = dependencies.memoryMutationApplier;
    this.batching = dependencies.batching ?? "off";
    this.groundingSelector = dependencies.groundingSelector ?? new DeterministicGroundingSelector();
    this.features = dependencies.features ?? {
      planning: this.enabledCategories.has("planning") ? "tasks-v1" : "off",
      memory: this.enabledCategories.has("side") ? "facts-v1" : "off",
      batching: this.batching,
    };
    this.monitorMode = this.features.monitor ?? "off";
    if (this.monitorMode !== "off") {
      this.monitorState = createProgressMonitorState(this.runId);
      this.monitorPolicyState = createMonitorPolicyState({ mode: this.monitorMode });
    }
    this.cleanupDeadlineMs = dependencies.cleanupDeadlineMs ?? DEFAULT_CLEANUP_DEADLINE_MS;
    if (!Number.isInteger(this.cleanupDeadlineMs) || this.cleanupDeadlineMs <= 0) {
      throw new Error("cleanupDeadlineMs must be a positive integer");
    }
    this.memoryEnabled = this.features.memory !== "off" && this.enabledCategories.has("side");
    this.planningEnabled = this.features.planning !== "off" && this.enabledCategories.has("planning");
    this.onCleanupError = dependencies.onCleanupError;
    this.onEventCommitted = dependencies.onEventCommitted;
    this.snapshot = {
      runId: this.runId,
      status: "created",
      stepCount: 0,
      modelRequestCount: 0,
      guardEvaluationCount: 0,
      riskModelRequestCount: 0,
      plan: { runId: this.runId, tasks: [] },
      memory: { runId: this.runId, facts: [], entities: [] },
    };
  }

  public start(goal: string): Promise<RunOutcome> {
    if (goal.trim().length === 0) {
      return Promise.reject(new Error("RunController.start requires a non-empty goal"));
    }
    if (this.started) {
      return Promise.reject(new Error(`RunController for ${this.runId} can only start once`));
    }
    this.started = true;
    this.goal = goal;
    return this.run(goal);
  }

  public cancel(reason = "cancelled by caller"): void {
    if (!this.started) {
      throw new Error(`RunController for ${this.runId} has not started`);
    }
    if (this.snapshot.status === "finished") {
      throw new Error(`RunController for ${this.runId} is already finished`);
    }
    this.abortController.abort(new Error(reason));
  }

  public submitUserInput(text: string, expectedPendingRequestId?: string): Promise<void> {
    if (text.trim().length === 0) {
      return Promise.reject(new Error("submitUserInput requires non-empty text"));
    }
    return this.enqueueCommand((resolve, reject) => ({
      kind: "user_input",
      text,
      ...(expectedPendingRequestId === undefined ? {} : { expectedPendingRequestId }),
      resolve,
      reject,
    }));
  }

  public resolveApproval(requestId: string, approved: boolean): Promise<void> {
    if (requestId.trim().length === 0) {
      return Promise.reject(new Error("resolveApproval requires a requestId"));
    }
    return this.enqueueCommand((resolve, reject) => ({
      kind: "approval_resolution",
      requestId,
      approved,
      resolve,
      reject,
    }));
  }

  public pause(reason = "paused by caller"): Promise<void> {
    return this.enqueueCommand((resolve, reject) => ({ kind: "pause", reason, resolve, reject }));
  }

  public resume(): Promise<void> {
    return this.enqueueCommand((resolve, reject) => ({ kind: "resume", resolve, reject }));
  }

  public async listWindowHandoffCandidates(signal: AbortSignal): Promise<readonly ComputerWindowCandidate[]> {
    if (this.snapshot.status !== "waiting_window" || this.activeComputerSession === undefined || this.computer.listWindowHandoffCandidates === undefined) {
      throw new Error("no window handoff is waiting for candidate discovery");
    }
    return this.computer.listWindowHandoffCandidates(this.activeComputerSession, signal);
  }

  public async listNewWindowHandoffCandidates(signal: AbortSignal): Promise<readonly ComputerWindowCandidate[]> {
    if (this.snapshot.status !== "waiting_window" || this.activeComputerSession === undefined || this.computer.listWindowHandoffCandidates === undefined) {
      throw new Error("no window handoff is waiting for candidate discovery");
    }
    if (this.computer.listNewWindowHandoffCandidates === undefined) return [];
    return this.computer.listNewWindowHandoffCandidates(this.activeComputerSession, signal);
  }

  public handoffWindow(candidate: ComputerWindowCandidate, expectedRequestId?: string): Promise<void> {
    return this.enqueueCommand((resolve, reject) => ({
      kind: "window_handoff",
      candidate,
      ...(expectedRequestId === undefined ? {} : { expectedRequestId }),
      resolve,
      reject,
    }));
  }

  public ignoreNewWindowAndContinueOnCurrentTarget(expectedRequestId?: string): Promise<void> {
    return this.enqueueCommand((resolve, reject) => ({
      kind: "ignore_new_window",
      ...(expectedRequestId === undefined ? {} : { expectedRequestId }),
      resolve,
      reject,
    }));
  }

  public getSnapshot(): RunSnapshot {
    return structuredClone(this.snapshot);
  }

  public getEvents(): readonly RuntimeEvent[] {
    return this.events.map((event) => structuredClone(event));
  }

  /** Return only committed events after a sequence watermark. */
  public getEventsAfter(sequence: number): readonly RuntimeEvent[] {
    return this.events.filter((event) => event.sequence > sequence).map((event) => structuredClone(event));
  }

  /** Return the same model-tool projection used by ContextCompiler. */
  public getEffectiveToolNames(): readonly string[] {
    return this.toolRegistry.modelTools(this.toolAudience, {
      enabledCategories: [...this.enabledCategories],
      ...(this.enabledToolNames === undefined ? {} : { enabledToolNames: [...this.enabledToolNames] }),
    }).map((tool) => tool.name);
  }

  private async run(goal: string): Promise<RunOutcome> {
    let session: ComputerSession | undefined;
    let outcome: RunOutcome = "failed";
    try {
      await this.commitEvent({ type: "run.created", goal });
      this.throwIfAborted();
      await this.commitEvent({ type: "run.started" });
      await this.commitEvent({ type: "computer.open.started" });
      if (cleanupPendingComputers.has(this.computer)) {
        throw new Error("Computer instance has unresolved cleanup from an earlier Run");
      }
      session = await this.computer.open(this.computerOpenOptions, this.abortController.signal);
      this.activeComputerSession = session;
      const restrictedToolNames = restrictToolNamesForCapabilities(this.toolRegistry, session.capabilities, this.enabledToolNames === undefined ? undefined : [...this.enabledToolNames]);
      this.enabledToolNames = restrictedToolNames === undefined ? undefined : new Set(restrictedToolNames);
      await this.commitEvent({ type: "computer.open.completed", session });
      await this.observeAndCommit(session);

      while (this.snapshot.status !== "finished") {
        if (this.snapshot.status === "paused" || this.snapshot.status === "waiting_user" || this.snapshot.status === "waiting_approval" || this.snapshot.status === "waiting_window") {
          await this.waitForControlCommand();
          session = this.activeComputerSession ?? session;
          if ((this.snapshot.status as string) === "running") {
            // A resume can release the waiter before a correction enqueued in
            // the same user turn is drained.  Apply queued control commands
            // before consuming any deferred decision or tool turn.
            const controlEffects = await this.drainCommands();
            this.throwIfAborted();
            await this.refreshAfterUserInput(session);
            if (controlEffects.correction) {
              this.approvedPendingApproval = undefined;
            }
          }
          if (this.approvedPendingApproval !== undefined && (this.snapshot.status as string) === "running") {
            const pending = this.approvedPendingApproval;
            this.approvedPendingApproval = undefined;
            await this.executeApprovedCall(pending);
          }
          if ((this.snapshot.status as string) === "running" && this.pendingToolTurn !== undefined) {
            const pendingTurn = this.pendingToolTurn;
            this.pendingToolTurn = undefined;
            if (pendingTurn.invalidated) {
              await this.rejectPendingEntries(pendingTurn.entries, pendingTurn.nextIndex, "superseded by user correction");
            } else {
              await this.executePendingEntries(pendingTurn);
            }
          }
          continue;
        }

        const beforeTurn = await this.drainCommands();
        if ((this.snapshot.status as string) === "paused") {
          continue;
        }
        if (beforeTurn.correction) {
          continue;
        }
        await this.refreshAfterUserInput(session);
        this.throwIfAborted();
        if (this.actionBudgetExhausted && this.actionBudgetCloseTurnsRemaining <= 0) {
          await this.commitEvent({
            type: "runtime.error",
            category: "budget",
            message: "GUI action budget exhausted; closing decision limit reached",
          });
          outcome = "budget_exhausted";
          break;
        }
        const budget = this.policy.checkBudget(this.snapshot);
        if (!budget.allowed) {
          await this.commitEvent({
            type: "runtime.error",
            category: "budget",
            message: budget.reason ?? "runtime budget exhausted",
          });
          outcome = "budget_exhausted";
          break;
        }

        let turn: ModelTurn | undefined;
        const pendingModelTurn = this.pendingModelTurn;
        if (pendingModelTurn !== undefined) {
          this.pendingModelTurn = undefined;
          if (pendingModelTurn.invalidated) {
            if (pendingModelTurn.turn.type === "tool_calls") {
              await this.rejectModelTurn(pendingModelTurn.turn, "superseded by user correction");
            }
            continue;
          }
          turn = pendingModelTurn.turn;
        } else {
          if (turn === undefined) {
          const context = await this.contextCompiler.compile(
            {
              runId: this.runId,
              goal,
              recentEvents: this.events,
              enabledCategories: [...this.enabledCategories],
              ...(this.planningEnabled ? { plan: this.snapshot.plan } : {}),
              ...(this.snapshot.executionSegment === undefined ? {} : { executionSegment: this.snapshot.executionSegment }),
              ...(this.memoryEnabled ? { memory: this.snapshot.memory } : {}),
              ...(this.enabledToolNames === undefined ? {} : { enabledToolNames: [...this.enabledToolNames] }),
              features: this.features,
              ...(this.monitorPendingGuidance === undefined ? {} : { monitorGuidance: this.monitorPendingGuidance }),
               ...(this.latestObservation === undefined ? {} : { latestObservation: this.observationForContext(this.latestObservation) }),
            },
            this.abortController.signal,
          );
          this.throwIfAborted();
          // A user correction may arrive while the compiler is awaiting
          // assets or assembling a long context.  Do not send that stale
          // ModelInput to the Provider: consume the command, refresh the
          // observation if needed, and compile again from the new facts.
          const afterCompile = await this.drainCommands();
          if ((this.snapshot.status as string) === "paused" || afterCompile.correction) {
            if (afterCompile.correction) await this.refreshAfterUserInput(session);
            continue;
          }
          let requestContext = context;
          const decisionId = this.idFactory.eventId();
          const prepareProvider = this.provider.prepare?.bind(this.provider);
          const generatePrepared = this.provider.generatePrepared?.bind(this.provider);
          const canPrepareProvider = prepareProvider !== undefined && generatePrepared !== undefined;
          let prepared: PreparedProviderRequest | undefined;
          let retryCount = 0;
          let providerFailed = false;
          let decisionInvalidated = false;
          let requestIdForResponse: string | undefined;
          const retryWindowStartedAt = Date.now();
          let closeTurnConsumed = false;
          if (canPrepareProvider) {
            prepared = await prepareProvider(requestContext, { signal: this.abortController.signal });
            // Preparation may read assets or otherwise await provider-local
            // work.  Re-check the command barrier before any network attempt.
            const afterPrepare = await this.drainCommands();
            if ((this.snapshot.status as string) === "paused" || afterPrepare.correction) {
              if (afterPrepare.correction) await this.refreshAfterUserInput(session);
              decisionInvalidated = true;
            }
          }
          turn = undefined;
          while (turn === undefined && !decisionInvalidated) {
            if (retryCount > 0) {
              const retryBudget = this.policy.checkBudget(this.snapshot);
              if (!retryBudget.allowed) {
                await this.commitEvent({
                  type: "runtime.error",
                  category: "budget",
                  message: retryBudget.reason ?? "model retry budget exhausted",
                });
                outcome = "budget_exhausted";
                providerFailed = true;
                break;
              }
            }
            this.throwIfAborted();
            if (this.actionBudgetExhausted && !closeTurnConsumed) {
              this.actionBudgetCloseTurnsRemaining -= 1;
              closeTurnConsumed = true;
            }
            const attempt = retryCount + 1;
            const requestId = this.idFactory.eventId();
            requestIdForResponse = requestId;
            const preparedRequest = prepared === undefined ? undefined : {
              payloadHash: prepared.payloadHash,
              ...(prepared.estimate === undefined ? {} : { estimate: prepared.estimate }),
            };
            const contextBudget = requestContext.contextBudget === undefined || preparedRequest === undefined || requestContext.contextBudget.trace === undefined
              ? requestContext.contextBudget
              : {
                  ...requestContext.contextBudget,
                  trace: { ...requestContext.contextBudget.trace, preparedRequest },
                };
            await this.commitEvent({
              type: "model.request.started",
              providerId: this.provider.id,
              requestId,
              decisionId,
              attempt,
              ...(preparedRequest === undefined ? {} : { preparedRequest }),
              ...(contextBudget === undefined ? {} : { contextBudget }),
            });
            try {
              turn = prepared !== undefined && generatePrepared !== undefined
                ? await generatePrepared(prepared, { signal: this.abortController.signal })
                : await this.provider.generate(requestContext, { signal: this.abortController.signal });
            } catch (error) {
              const details = providerErrorDetails(error);
              const nextRetryCount = retryCount + 1;
              const retryDelayMs = providerRetryDelayMs(nextRetryCount);
              const retryWindowRemaining = MAX_PROVIDER_RETRY_WINDOW_MS - (Date.now() - retryWindowStartedAt);
              const retry = !this.isAborted()
                && details.retryable === true
                && retryCount < MAX_PROVIDER_RETRIES
                && retryWindowRemaining > retryDelayMs + PROVIDER_ATTEMPT_DEADLINE_MS;
              await this.commitEvent({
                type: "model.request.failed",
                category: this.isAborted() ? "cancelled" : "provider",
                message: providerFailureMessage(error, retry, retryCount + 1),
                requestId,
                decisionId,
                attempt,
                ...details,
              });
              if (!retry) {
                outcome = this.isAborted() ? "cancelled" : "failed";
                providerFailed = true;
                break;
              }
              retryCount = nextRetryCount;
              await waitBeforeProviderRetry(this.abortController.signal, retryCount);
              const retryEffects = await this.drainCommands();
              if ((this.snapshot.status as string) === "paused" || retryEffects.correction) {
                if (retryEffects.correction) await this.refreshAfterUserInput(session);
                decisionInvalidated = true;
                break;
              }
              if (providerErrorDetails(error).retryMode !== "same_input") {
                requestContext = addProviderRetryFeedback(context, error, retryCount, MAX_PROVIDER_RETRIES);
                if (canPrepareProvider) {
                  prepared = await prepareProvider(requestContext, { signal: this.abortController.signal });
                  const afterRetryPrepare = await this.drainCommands();
                  if ((this.snapshot.status as string) === "paused" || afterRetryPrepare.correction) {
                    if (afterRetryPrepare.correction) await this.refreshAfterUserInput(session);
                    decisionInvalidated = true;
                    break;
                  }
                }
              }
            }
          }
          if (decisionInvalidated) {
            continue;
          }
          if (providerFailed || turn === undefined) {
            break;
          }

          this.throwIfAborted();
          await this.commitEvent({
            type: "model.response.received",
            turn,
            ...(requestIdForResponse === undefined ? {} : { requestId: requestIdForResponse }),
            decisionId,
            attempt: retryCount + 1,
          });
          this.throwIfAborted();
          const afterResponse = await this.drainCommands();
          if ((this.snapshot.status as string) === "paused") {
            // A correction can arrive in the same command drain as pause.
            // The turn is stashed only after that drain, so carry the batch
            // marker forward instead of allowing the stale turn to execute
            // after a later resume.
            this.pendingModelTurn = { turn, invalidated: afterResponse.correction };
            continue;
          }
          if (afterResponse.correction) {
            if (turn.type === "tool_calls") {
              await this.rejectModelTurn(turn, "superseded by user correction");
            }
            continue;
          }
          }
        }
        if (turn.type === "finish") {
          const beforeFinish = await this.drainCommands();
          if ((this.snapshot.status as string) === "paused") {
            // Keep the same correction marker for a finish turn as for a
            // tool-call turn.  A paused turn must not be consumed as if no
            // correction happened merely because it has no GUI action.
            this.pendingModelTurn = { turn, invalidated: beforeFinish.correction };
            continue;
          }
          if (beforeFinish.correction) {
            continue;
          }
          // Provider adapters validate explicit terminate controls. Runtime
          // applies the same check when a provider supplies a structured
          // reportedStatus; plain textual finishes remain compatible with
          // providers that do not expose a terminate control.
          const finishSummaryError = turn.reportedStatus === undefined
            ? undefined
            : finishSummaryRejectionReason(turn.summary);
          if (finishSummaryError !== undefined) {
            await this.commitEvent({
              type: "runtime.error",
              category: "finish_summary_invalid",
              message: finishSummaryError,
            });
            outcome = "failed";
            break;
          }
          const finish = this.policy.canFinish(this.snapshot);
          if (!finish.allowed) {
            await this.commitEvent({
              type: "runtime.error",
              category: "finish_denied",
              message: finish.reason ?? "finish denied by runtime policy",
            });
            outcome = "failed";
            break;
          }
          outcome = turn.reportedStatus === "failure" ? "failed" : "succeeded";
          outcome = await this.commitRunFinished({
            outcome,
            summary: turn.summary,
            ...(turn.reportedStatus === undefined ? {} : { reportedStatus: turn.reportedStatus }),
          });
          break;
        }
        if (turn.type === "user_input_required") {
          await this.commitEvent({ type: "user.input.requested", question: turn.question });
          continue;
        }
        await this.processToolCalls(session, turn.calls);
        // A planning/memory-only turn does not create a new Observation. Give
        if ((this.snapshot.status as string) === "paused") {
          continue;
        }
        const latestEvent = this.events[this.events.length - 1];
        if (latestEvent?.type === "run.finished") {
          outcome = this.snapshot.outcome ?? "failed";
          break;
        }
      }

      if (this.snapshot.status !== "finished") {
        outcome = await this.commitRunFinished({ outcome });
      }
      return outcome;
    } catch (error) {
      if (this.snapshot.status !== "finished") {
        if (this.isAborted() && this.snapshot.unresolvedActionId === undefined) {
          await this.commitEvent({
            type: "runtime.error",
            category: "cancelled",
            message: errorMessage(error),
          });
          outcome = "cancelled";
        } else if (this.snapshot.unresolvedActionId !== undefined) {
          await this.commitEvent({
            type: "runtime.error",
            category: "unknown_side_effect",
            message: errorMessage(error),
          });
          outcome = "outcome_unknown";
        } else {
          await this.commitEvent({
            type: "runtime.error",
            category: "runtime",
            message: errorMessage(error),
          });
          outcome = "failed";
        }
        outcome = await this.commitRunFinished({ outcome });
      }
      return outcome;
    } finally {
      this.commandInbox.close();
      await this.cleanup(session);
      this.activeComputerSession = undefined;
    }
  }

  private async cleanup(session: ComputerSession | undefined): Promise<void> {
    const deadline = Date.now() + this.cleanupDeadlineMs;
    await this.cleanupOperation("event_writer.flush", () => this.eventWriter.flush(), deadline);
    await this.cleanupOperation("event_writer.close", () => this.eventWriter.close(), deadline);
    if (session !== undefined || this.computer.dispose !== undefined) {
      const operation = session === undefined ? "computer.dispose" : "computer.close";
      await this.cleanupOperation(operation, () => this.closeComputerResources(session), deadline, () => {
        cleanupPendingComputers.add(this.computer);
      });
    }
    this.latestObservationFingerprint = undefined;
  }

  private async closeComputerResources(session: ComputerSession | undefined): Promise<void> {
    let closeFailure: unknown;
    let hasCloseFailure = false;
    let disposeFailure: unknown;
    let hasDisposeFailure = false;
    if (session !== undefined) {
      try {
        await this.computer.close(session);
      } catch (error) {
        closeFailure = error;
        hasCloseFailure = true;
      }
    }
    if (this.computer.dispose !== undefined) {
      try {
        await this.computer.dispose();
      } catch (error) {
        disposeFailure = error;
        hasDisposeFailure = true;
      }
    }
    if (hasCloseFailure && hasDisposeFailure) {
      throw new AggregateError(
        [closeFailure, disposeFailure],
        `computer.close: ${errorMessage(closeFailure)}; computer.dispose: ${errorMessage(disposeFailure)}`,
      );
    }
    if (hasCloseFailure) throw closeFailure;
    if (hasDisposeFailure) throw new CleanupOperationFailure("computer.dispose", disposeFailure);
  }

  private async cleanupOperation(
    operation: CleanupOperation,
    work: () => Promise<void>,
    deadline: number,
    onTimeout?: () => void,
  ): Promise<void> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      onTimeout?.();
      this.reportCleanupError({ operation, message: `cleanup deadline exceeded before ${operation}`, status: "timed_out" });
      return;
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
    if (result.status === "completed") return;
    if (result.status === "failed") {
      const failedOperation = result.error instanceof CleanupOperationFailure ? result.error.operation : operation;
      const message = result.error instanceof CleanupOperationFailure ? errorMessage(result.error.original) : errorMessage(result.error);
      if (failedOperation === "computer.close" || failedOperation === "computer.dispose") cleanupPendingComputers.add(this.computer);
      this.reportCleanupError({ operation: failedOperation, message });
      return;
    }
    onTimeout?.();
    this.reportCleanupError({ operation, message: `cleanup deadline exceeded during ${operation}`, status: "timed_out" });
    if (operation === "computer.close" || operation === "computer.dispose") {
      void settled.then((lateResult) => {
        if (lateResult.status === "completed") cleanupPendingComputers.delete(this.computer);
      });
    }
  }

  private reportCleanupError(diagnostic: CleanupDiagnostic): void {
    try {
      this.onCleanupError?.(diagnostic);
    } catch {
      // Diagnostics must never replace the already determined RunOutcome.
    }
  }

  private enqueueCommand(factory: (resolve: () => void, reject: (error: unknown) => void) => RuntimeCommand): Promise<void> {
    if (!this.started) {
      return Promise.reject(new Error(`RunController for ${this.runId} has not started`));
    }
    if (this.snapshot.status === "finished") {
      return Promise.reject(new Error(`RunController for ${this.runId} is already finished`));
    }
    return new Promise<void>((resolve, reject) => {
      this.commandInbox.enqueue(factory(resolve, reject));
    });
  }

  private async drainCommands(): Promise<CommandEffects> {
    const effects: CommandEffects = { correction: false };
    for (const command of this.commandInbox.drain()) {
      try {
        const commandEffect = await this.applyCommand(command);
        effects.correction = effects.correction || commandEffect.correction;
        command.resolve();
      } catch (error) {
        command.reject(error);
      }
    }
    return effects;
  }

  private async waitForControlCommand(): Promise<void> {
    while (this.snapshot.status !== "finished") {
      this.throwIfAborted();
      const command = await this.commandInbox.take(this.abortController.signal);
      try {
        await this.applyCommand(command);
        command.resolve();
      } catch (error) {
        command.reject(error);
      }
      if (this.snapshot.status === "running") {
        return;
      }
    }
  }

  private async refreshAfterUserInput(session: ComputerSession): Promise<void> {
    if (!this.pendingReobserve || this.snapshot.status !== "running") {
      return;
    }
    this.pendingReobserve = false;
    await this.observeAndCommit(session);
  }

  private async rejectModelTurn(turn: Extract<ModelTurn, { type: "tool_calls" }>, reason: string): Promise<void> {
    for (const call of turn.calls) {
      if (this.callStates.has(call.id)) continue;
      this.callStates.set(call.id, "rejected");
      await this.commitEvent({ type: "tool.call.rejected", callId: call.id, reason });
    }
  }

  private async applyCommand(command: RuntimeCommand): Promise<CommandEffects> {
    // A correction/approval/explicit pause-resume changes the control
    // boundary.  Never carry a guidance or deferred-help proposal across it.
    if (command.kind === "user_input" || command.kind === "approval_resolution" || command.kind === "pause" || command.kind === "resume" || command.kind === "window_handoff" || command.kind === "ignore_new_window") {
      this.clearMonitorPendingRecommendations();
    }
    switch (command.kind) {
      case "user_input":
        if (command.expectedPendingRequestId !== undefined) {
          const currentApprovalId = this.snapshot.pendingApproval?.requestId;
          const currentQuestionId = this.snapshot.pendingUserInputRequestId;
          if (currentApprovalId !== command.expectedPendingRequestId && currentQuestionId !== command.expectedPendingRequestId) {
            throw new Error("user input request does not match the pending request");
          }
        }
        if (this.approvedPendingApproval !== undefined) {
          const approved = this.approvedPendingApproval;
          this.approvedPendingApproval = undefined;
          await this.rejectToolCall(approved.call.id, "superseded by user correction after approval");
        }
        if (this.snapshot.status === "waiting_approval") {
          const pending = this.pendingApproval;
          if (pending === undefined || this.snapshot.pendingApproval?.requestId !== pending.requestId) {
            throw new Error("pending approval has no executable ToolCall");
          }
          // A correction is a user decision, not an approval shortcut.
          // Linearize it at the Inbox point by revoking the candidate and
          // recording its rejection before accepting the new input. No GUI
          // action can start from the stale candidate after this point.
          await this.commitEvent({ type: "approval.resolved", requestId: pending.requestId, approved: false });
          this.pendingApproval = undefined;
          await this.rejectToolCall(pending.call.id, "superseded by user correction");
        }
        if (
          this.snapshot.status !== "waiting_user" &&
          this.snapshot.status !== "running" &&
          this.snapshot.status !== "paused"
        ) {
          throw new Error(`user input is not accepted while run is ${this.snapshot.status}`);
        }
        await this.commitEvent({ type: "user.input.received", text: command.text });
        if (this.snapshot.executionSegment?.status === "active") {
          await this.commitEvent({ type: "execution.segment.updated", source: "runtime", mutation: { operation: "invalidated", segmentId: this.snapshot.executionSegment.id, reason: "superseded_by_user_correction" } });
        }
        this.pendingReobserve = true;
        if (this.pendingModelTurn !== undefined) {
          // Invalidation follows the deferred decision, not the transient
          // run status.  A correction may be queued immediately after
          // resume, while the ModelTurn is still waiting to be consumed.
          this.pendingModelTurn = { ...this.pendingModelTurn, invalidated: true };
        }
        if (this.pendingToolTurn !== undefined) {
          // Apply the same rule to the remaining calls of a paused ToolTurn;
          // already-started actions are never rolled back here.
          this.pendingToolTurn = { ...this.pendingToolTurn, invalidated: true };
        }
        return { correction: true };
      case "approval_resolution":
        if (this.snapshot.status !== "waiting_approval" || this.snapshot.pendingApproval === undefined) {
          throw new Error("no approval is waiting for resolution");
        }
        if (this.snapshot.pendingApproval.requestId !== command.requestId) {
          throw new Error(`approval ${command.requestId} does not match pending approval ${this.snapshot.pendingApproval.requestId}`);
        }
        const pending = this.pendingApproval;
        if (pending === undefined || pending.requestId !== command.requestId) {
          throw new Error(`approval ${command.requestId} has no pending ToolCall`);
        }
        await this.commitEvent({
          type: "approval.resolved",
          requestId: command.requestId,
          approved: command.approved,
        });
        if (!command.approved) {
          this.pendingApproval = undefined;
          await this.rejectToolCall(pending.call.id, "approval denied");
        } else {
          this.pendingApproval = undefined;
          this.approvedPendingApproval = pending;
        }
        return { correction: false };
      case "pause":
        if (this.snapshot.status !== "running") {
          throw new Error(`pause requires running status, got ${this.snapshot.status}`);
        }
        if (this.snapshot.unresolvedActionId !== undefined) {
          throw new Error("pause is not allowed while a GUI action is unresolved");
        }
        await this.commitEvent({ type: "run.paused", reason: command.reason });
        return { correction: false };
      case "resume":
        if (this.snapshot.status !== "paused") {
          throw new Error(`resume requires paused status, got ${this.snapshot.status}`);
        }
        await this.commitEvent({ type: "run.resumed" });
        return { correction: false };
      case "window_handoff":
        if (this.snapshot.status !== "waiting_window" || this.activeComputerSession === undefined || this.computer.handoffWindow === undefined) {
          throw new Error("no window handoff is awaiting confirmation");
        }
        if (command.expectedRequestId !== undefined && this.snapshot.pendingWindowHandoff?.sourceActionId !== command.expectedRequestId) {
          throw new Error("window handoff request does not match the pending request");
        }
        {
          const session = await this.computer.handoffWindow(this.activeComputerSession, command.candidate, this.abortController.signal);
          try {
            await this.commitEvent({ type: "computer.window.handoff.completed", target: { pid: command.candidate.pid, windowId: command.candidate.windowId }, session });
          } catch (error) {
            // The private binding has changed. If the durable handoff event is
            // missing, fail closed instead of accepting another GUI command.
            this.abortController.abort(new Error("window handoff could not be recorded", { cause: error }));
            throw error;
          }
          this.activeComputerSession = session;
          this.latestObservation = undefined;
          this.latestObservationFingerprint = undefined;
          this.groundingCandidates.clear();
          this.groundingRecoveryHint = undefined;
          if (this.pendingModelTurn !== undefined) this.pendingModelTurn = { ...this.pendingModelTurn, invalidated: true };
          if (this.pendingToolTurn !== undefined) this.pendingToolTurn = { ...this.pendingToolTurn, invalidated: true };
          this.pendingReobserve = true;
          return { correction: true };
        }
      case "ignore_new_window":
        if (this.snapshot.status !== "waiting_window" || this.snapshot.pendingWindowHandoff?.reasonCode !== "new_window_detected" ||
            this.activeComputerSession === undefined) {
          throw new Error("only a proactively detected window may be ignored; foreground mismatch requires choosing a target or aborting");
        }
        if (command.expectedRequestId !== undefined && this.snapshot.pendingWindowHandoff.sourceActionId !== command.expectedRequestId) {
          throw new Error("window handoff request does not match the pending request");
        }
        {
          const session = this.activeComputerSession;
          const sourceActionId = this.snapshot.pendingWindowHandoff.sourceActionId;
          await this.commitEvent({ type: "computer.window.handoff.ignored", sourceActionId });
          // Drop every old frame/grounding reference before observing the
          // still-bound target. No action from the completed decision is replayed.
          this.latestObservation = undefined;
          this.latestObservationFingerprint = undefined;
          this.groundingCandidates.clear();
          this.groundingRecoveryHint = undefined;
          if (this.pendingModelTurn !== undefined) this.pendingModelTurn = { ...this.pendingModelTurn, invalidated: true };
          if (this.pendingToolTurn !== undefined) this.pendingToolTurn = { ...this.pendingToolTurn, invalidated: true };
          this.pendingReobserve = false;
          try {
            await this.observeAndCommit(session);
          } catch (error) {
            // The waiting frame was invalidated by the ignore decision; do
            // not let the Provider run without a replacement observation.
            this.abortController.abort(new Error("fresh observation after ignoring a newly surfaced window failed", { cause: error }));
            throw error;
          }
          return { correction: true };
        }
    }
  }

  private async requestApproval(candidate: Omit<PendingApproval, "requestId">, baseReason: string): Promise<void> {
    let preparedAction = candidate.preparedAction;
    let executionObservationId: ObservationId | undefined;
    let evidence: ApprovalEvidence | undefined;
    let actions: import("@computer-harness/protocol").ActionGuardActionSummary[] | undefined;
    let reason = baseReason;

    if (candidate.definition.category === "computer") {
      const decisionObservationId = preparedAction?.decisionObservationId ?? this.snapshot.latestObservationId;
      if (preparedAction === undefined) {
        try {
          preparedAction = this.prepareComputerAction(
            candidate.call,
            candidate.definition,
            {
              runId: this.runId,
              session: candidate.session,
              signal: this.abortController.signal,
              ...this.currentExecutionObservationContext(),
            },
            decisionObservationId,
          );
        } catch (error) {
          await this.rejectToolCall(candidate.call.id, `invalid GUI action before approval: ${errorMessage(error)}`);
          return;
        }
      }
      if (decisionObservationId === undefined) {
        await this.rejectToolCall(candidate.call.id, "approval evidence is unavailable; the computer action was not offered or executed");
        return;
      }
      const decisionObservation = this.events.find((event): event is Extract<RuntimeEvent, { type: "observation.created" }> =>
        event.type === "observation.created" && event.observation.id === decisionObservationId,
      )?.observation;
      if (decisionObservation === undefined) {
        await this.rejectToolCall(candidate.call.id, "the action's decision observation is unavailable; the computer action was not offered or executed");
        return;
      }
      if (preparedAction.action.kind !== "wait" && preparedAction.action.basedOn !== decisionObservationId) {
        await this.rejectToolCall(candidate.call.id, "the prepared action does not match its decision observation; the computer action was not offered or executed");
        return;
      }

      const beforeCapture = await this.drainCommands();
      if (beforeCapture.correction || this.snapshot.status !== "running") {
        await this.rejectToolCall(candidate.call.id, "approval request was superseded by a user control command before evidence capture; no computer action was executed");
        return;
      }

      let evidenceObservation: ObservationFrame;
      try {
        // Capture the exact frame before asking for approval so the user can
        // review the coordinate/action against the image that will be used at
        // dispatch. The action itself remains bound to its original decision
        // observation; the adapter receives this fresh execution observation.
        evidenceObservation = await this.observeAndCommit(candidate.session);
      } catch (error) {
        if (this.abortController.signal.aborted) throw error;
        if (!(error instanceof ObservationCaptureError)) throw error;
        this.pendingReobserve = true;
        await this.rejectToolCall(
          candidate.call.id,
          `approval screenshot could not be captured; the computer action was not offered or executed: ${errorMessage(error)}`,
        );
        return;
      }

      const afterCapture = await this.drainCommands();
      this.throwIfAborted();
      if (afterCapture.correction || this.snapshot.status !== "running") {
        await this.rejectToolCall(candidate.call.id, "approval request was superseded by a user control command during evidence capture; no computer action was executed");
        return;
      }
      if (this.activeComputerSession?.id !== candidate.session.id
        || this.snapshot.computerSession?.id !== candidate.session.id
        || decisionObservation.computerSessionId !== candidate.session.id
        || evidenceObservation.computerSessionId !== candidate.session.id) {
        await this.rejectToolCall(candidate.call.id, "computer session identity changed while preparing approval; the action must be proposed again on the current target");
        return;
      }
      if (!sameViewport(decisionObservation.viewport, evidenceObservation.viewport)) {
        await this.rejectToolCall(candidate.call.id, "computer viewport or coordinate space changed while preparing approval; the action must be proposed again against the current screen");
        return;
      }

      const executionObservation = this.currentExecutionObservation();
      try {
        if (executionObservation === undefined || executionObservation.id !== evidenceObservation.id) {
          throw new Error("fresh approval observation is not current");
        }
        validateActionIntent(preparedAction.action, {
          capabilities: candidate.session.capabilities,
          observation: executionObservation,
          executionObservationId: evidenceObservation.id,
        });
      } catch (error) {
        await this.rejectToolCall(candidate.call.id, `computer action is invalid against the exact approval screenshot: ${errorMessage(error)}`);
        return;
      }

      executionObservationId = evidenceObservation.id;
      evidence = {
        observationId: evidenceObservation.id,
        decisionObservationId,
        assetId: evidenceObservation.screenshot.assetId,
        capturedAt: evidenceObservation.capturedAt,
        viewport: { ...evidenceObservation.viewport },
      };
      actions = [summarizeGuardAction(preparedAction.action)];
      reason = approvalHumanReviewReason(baseReason, preparedAction.action);
    }

    this.throwIfAborted();
    const requestId = this.idFactory.eventId();
    await this.commitEvent({
      type: "approval.requested",
      requestId,
      callId: candidate.call.id,
      reason,
      requiresVisualReview: candidate.definition.category === "computer",
      ...(evidence === undefined ? {} : { evidence }),
      ...(actions === undefined ? {} : { actions }),
    });
    this.pendingApproval = {
      ...candidate,
      requestId,
      ...(preparedAction === undefined ? {} : { preparedAction }),
      ...(executionObservationId === undefined ? {} : { executionObservationId }),
    };
  }

  private async executeApprovedCall(pending: PendingApproval): Promise<void> {
    let context: ToolExecutionContext = {
      runId: this.runId,
      session: pending.session,
      signal: this.abortController.signal,
      ...this.currentExecutionObservationContext(),
    };
    if (pending.definition.category === "computer") {
      const observation = this.latestObservation;
      const executionObservationId = pending.executionObservationId;
      if (pending.preparedAction === undefined || executionObservationId === undefined
        || observation === undefined || observation.id !== executionObservationId
        || observation.computerSessionId !== pending.session.id
        || this.activeComputerSession?.id !== pending.session.id) {
        await this.rejectToolCall(
          pending.call.id,
          "the request-bound approval screenshot is no longer the current observation; the computer action was not executed",
        );
        return;
      }
      const commandEffects = await this.drainCommands();
      this.throwIfAborted();
      if (commandEffects.correction || this.snapshot.status !== "running") {
        await this.rejectToolCall(
          pending.call.id,
          "approval was superseded by a user control command; the computer action was not executed",
        );
        return;
      }
      context = { ...context, ...this.currentExecutionObservationContext() };
      await this.executeComputerCall(pending.call, pending.definition, context, undefined, pending.preparedAction);
    } else if (pending.definition.category === "control") {
      await this.rejectToolCall(pending.call.id, "control decisions must be mapped by the Provider, not executed as tools");
    } else {
      await this.executeNonComputerCall(pending.call, pending.definition, context);
    }
    await this.flushDeferredMonitorHelp();
  }

  private isToolEnabled(name: string): boolean {
    return this.enabledToolNames === undefined || this.enabledToolNames.has(name);
  }

  /** Internal execution view: the model still sees only the hot projection. */
  private currentExecutionObservationContext(): Pick<ToolExecutionContext, "observation" | "rawGrounding"> {
    const observation = this.latestObservation;
    if (observation === undefined) return {};
    const rawGrounding = this.groundingCandidates.get(String(observation.id));
    return {
      observation: this.observationForContext(observation),
      ...(rawGrounding === undefined ? {} : { rawGrounding }),
    };
  }

  private currentExecutionObservation(): ObservationFrame | undefined {
    const observation = this.latestObservation;
    if (observation === undefined) return undefined;
    const rawGrounding = this.groundingCandidates.get(String(observation.id));
    return rawGrounding === undefined ? this.observationForContext(observation) : { ...observation, grounding: rawGrounding };
  }

  /**
   * Bind only a semantically matching main-provider click to the current
   * local Segment step.  Segment intent is deliberately checked against the
   * observation's public grounding label; a coordinate without a grounded
   * label cannot silently claim that it attempted the step.
   */
  private matchCurrentExecutionSegmentAction(action: ActionIntent): { segmentId: string; stepId: string } | undefined {
    const segment = this.snapshot.executionSegment;
    if (segment === undefined || segment.status !== "active") return undefined;
    const step = segment.steps[segment.cursor];
    if (step === undefined || segment.attemptedStepIds.includes(step.id) || action.kind !== "click") return undefined;
    const sourceObservation = this.events.find((event): event is Extract<RuntimeEvent, { type: "observation.created" }> =>
      event.type === "observation.created" && event.observation.id === action.basedOn,
    )?.observation;
    const catalog = this.groundingCandidates.get(String(action.basedOn)) ?? sourceObservation?.grounding;
    if (catalog === undefined) return undefined;
    const candidates = catalog.elements.filter((element) => element.bbox !== undefined && element.bbox.width > 0 && element.bbox.height > 0 && element.state?.enabled !== false);
    const target = action.groundingRef === undefined
      ? candidates
        .filter((element) => pointInBox(action.point, element.bbox!))
        .sort((left, right) => boxArea(left.bbox!) - boxArea(right.bbox!))[0]
      : candidates.find((element) => element.elementRef === action.groundingRef);
    if (target === undefined) return undefined;
    const targetText = [target.name, target.description].filter((value): value is string => value !== undefined).join(" ");
    return executionSegmentTextMatches([step.intent, step.completion.text].join(" "), targetText)
      ? { segmentId: segment.id, stepId: step.id }
      : undefined;
  }

  /**
   * Advance only from observation-bound evidence.  Evidence by itself is not
   * an attempt: the current step must first be bound to a real main-provider
   * GUI action.  This prevents a pre-existing label on the page from making a
   * Segment advance before the model actually clicked it.
   */
  private async reconcileExecutionSegment(observation: ObservationFrame, catalog?: import("@computer-harness/protocol").GroundingCatalog): Promise<void> {
    const segment = this.snapshot.executionSegment;
    if (segment === undefined || segment.status !== "active") return;
    if (segment.computerSessionId !== observation.computerSessionId) {
      await this.commitEvent({ type: "execution.segment.updated", source: "runtime", mutation: { operation: "invalidated", segmentId: segment.id, reason: "computer_session_changed" } });
      return;
    }
    const sourceObservation = this.events.find((event): event is Extract<RuntimeEvent, { type: "observation.created" }> =>
      event.type === "observation.created" && event.observation.id === segment.sourceObservationId,
    )?.observation;
    if (sourceObservation !== undefined) {
      if (sourceObservation.viewport.width !== observation.viewport.width
        || sourceObservation.viewport.height !== observation.viewport.height
        || sourceObservation.viewport.coordinateSpace !== observation.viewport.coordinateSpace) {
        await this.commitEvent({ type: "execution.segment.updated", source: "runtime", mutation: { operation: "invalidated", segmentId: segment.id, reason: "observation_partition_changed" } });
        return;
      }
    }
    const step = segment.steps[segment.cursor];
    if (step === undefined) {
      await this.commitEvent({ type: "execution.segment.updated", source: "runtime", mutation: { operation: "advanced", segmentId: segment.id, cursor: segment.steps.length, status: "completed" } });
      return;
    }
    if (!segment.attemptedStepIds.includes(step.id)) return;
    const evidenceMatched = catalog === undefined ? false : executionEvidenceMatches(step.completion, catalog);
    if (!evidenceMatched) {
      await this.commitEvent({ type: "execution.segment.updated", source: "runtime", mutation: { operation: "invalidated", segmentId: segment.id, reason: "completion_evidence_not_observed" } });
      return;
    }
    const cursor = segment.cursor + 1;
    await this.commitEvent({
      type: "execution.segment.updated",
      source: "runtime",
      mutation: { operation: "advanced", segmentId: segment.id, cursor, status: cursor >= segment.steps.length ? "completed" : "active" },
    });
  }

  /** Redacted upper-bound diagnostic: could this coordinate click have been
   * represented by the authoritative grounding catalog? */
  private coordinateCoverageEvent(action: ActionIntent): Extract<RuntimeEventData, { type: "grounding.coordinate_coverage" }> | undefined {
    if (action.kind !== "click" && action.kind !== "double_click" && action.kind !== "right_click") return undefined;
    const observation = this.events.find((event): event is Extract<RuntimeEvent, { type: "observation.created" }> => event.type === "observation.created" && event.observation.id === action.basedOn)?.observation;
    if (observation === undefined) return undefined;
    const catalog = this.groundingCandidates.get(String(action.basedOn)) ?? observation.grounding;
    if (catalog === undefined) return undefined;
    const candidates = catalog.elements.filter((candidate) => candidate.bbox !== undefined && candidate.bbox.width > 0 && candidate.bbox.height > 0 && candidate.state?.enabled !== false);
    const containing = candidates.filter((candidate) => pointInBox(action.point, candidate.bbox!)).sort((left, right) => boxArea(left.bbox!) - boxArea(right.bbox!));
    const matched = containing[0];
    if (matched !== undefined) return {
      type: "grounding.coordinate_coverage",
      actionId: action.actionId,
      observationId: observation.id,
      decisionSource: "main_provider",
      mapping: "containment",
      matchedElementRef: matched.elementRef,
      inHotProjection: observation.grounding?.elements.some((candidate) => candidate.elementRef === matched.elementRef) === true,
      normalizedDistance: 0,
    };
    const nearest = candidates.map((candidate) => ({ candidate, distance: pointDistance(action.point, candidate.bbox!) })).sort((left, right) => left.distance - right.distance)[0];
    const normalizedDistance = nearest === undefined ? undefined : nearest.distance / Math.max(1, Math.hypot(observation.viewport.width, observation.viewport.height));
    if (nearest !== undefined && normalizedDistance !== undefined && normalizedDistance <= 0.12) return {
      type: "grounding.coordinate_coverage",
      actionId: action.actionId,
      observationId: observation.id,
      decisionSource: "main_provider",
      mapping: "nearest",
      matchedElementRef: nearest.candidate.elementRef,
      inHotProjection: observation.grounding?.elements.some((candidate) => candidate.elementRef === nearest.candidate.elementRef) === true,
      normalizedDistance,
    };
    return {
      type: "grounding.coordinate_coverage",
      actionId: action.actionId,
      observationId: observation.id,
      decisionSource: "main_provider",
      mapping: "none",
      inHotProjection: false,
      ...(normalizedDistance === undefined ? {} : { normalizedDistance }),
    };
  }

  /**
   * Project only the selected raw element's public metadata to ActionPolicy.
   * The evidence is explicitly untrusted: it helps a semantic assessor
   * understand what was selected, but it never authorizes the action or
   * changes the declared effect.
   */
  private groundingEvidenceForActions(actions: readonly ActionIntent[]): import("./contracts.js").GroundingEvidenceSummary[] {
    const evidence: import("./contracts.js").GroundingEvidenceSummary[] = [];
    for (const action of actions) {
      if (!("groundingRef" in action) || action.groundingRef === undefined) continue;
      const observation = this.events.find((event): event is Extract<RuntimeEvent, { type: "observation.created" }> =>
        event.type === "observation.created" && event.observation.id === action.basedOn)?.observation;
      const catalog = this.groundingCandidates.get(String(action.basedOn)) ?? observation?.grounding;
      const element = catalog?.elements.find((candidate) => candidate.elementRef === action.groundingRef);
      if (element === undefined) continue;
      evidence.push({
        role: boundedUIEvidence(element.role, 64),
        ...(element.name === undefined ? {} : { name: boundedUIEvidence(element.name, 160) }),
        ...(element.description === undefined ? {} : { description: boundedUIEvidence(element.description, 240) }),
        ...(element.source === undefined ? {} : { source: element.source }),
        ...(element.browserRegion === undefined ? {} : { browserRegion: element.browserRegion }),
        untrusted: true,
      });
    }
    return evidence;
  }

  private async processToolCalls(session: ComputerSession, calls: readonly ToolCall[]): Promise<CommandEffects> {
    if (calls.length === 0) {
      throw new Error("model returned an empty tool_calls turn");
    }
    const ids = new Set<ToolCallId>();
    for (const call of calls) {
      if (call.id.trim().length === 0) {
        throw new Error("ToolCall id must be non-empty");
      }
      if (ids.has(call.id) || this.callStates.has(call.id)) {
        throw new Error(`duplicate ToolCall id: ${call.id}`);
      }
      ids.add(call.id);
    }

    const preflight: PreflightEntry[] = [];
    for (const call of calls) {
      const definition = this.toolRegistry.getForAudience(call.name, this.toolAudience);
      if (definition === undefined) {
        preflight.push({ call, rejection: `tool is not available to ${this.toolAudience}: ${call.name}` });
        continue;
      }
      if (!this.enabledCategories.has(definition.category)) {
        preflight.push({ call, definition, rejection: `tool category ${definition.category} is disabled for this run` });
        continue;
      }
      if (this.enabledToolNames !== undefined && !this.enabledToolNames.has(definition.name)) {
        preflight.push({ call, definition, rejection: `tool ${definition.name} is disabled for this run` });
        continue;
      }
      try {
        definition.validate(call.arguments);
      } catch (error) {
        preflight.push({ call, definition, rejection: `invalid arguments: ${errorMessage(error)}` });
        continue;
      }
      if (definition.category === "control") {
        preflight.push({ call, definition, rejection: "control decisions must be returned as ModelTurn control results" });
        continue;
      }
      const decision = await this.policy.evaluateToolCall({ call, tool: definition, snapshot: this.snapshot });
      if (definition.category === "computer") {
        const actionBudget = this.policy.checkActionBudget(this.snapshot);
        if (!actionBudget.allowed) {
          this.actionBudgetExhausted = true;
          preflight.push({
            call,
            definition,
            rejection: actionBudget.reason ?? "computer action budget exhausted",
          });
          continue;
        }
      }
      if (decision.decision === "allow") {
        preflight.push({ call, definition, decision });
      } else if (decision.decision === "require_approval") {
        preflight.push({ call, definition, decision });
      } else {
        preflight.push({ call, definition, rejection: decision.reason });
      }
    }

    if (this.actionPolicy !== undefined) {
      const preparationContext: ToolExecutionContext = {
        runId: this.runId,
        session,
        signal: this.abortController.signal,
        ...this.currentExecutionObservationContext(),
      };
      for (const entry of preflight) {
        if (entry.rejection !== undefined || entry.definition?.category !== "computer") continue;
        try {
          entry.preparedAction = this.prepareComputerAction(entry.call, entry.definition, preparationContext, this.snapshot.latestObservationId);
        } catch (error) {
          entry.rejection = `invalid GUI action: ${errorMessage(error)}`;
        }
      }
    }

    const computerEntries = preflight.filter(
      (entry) => entry.rejection === undefined && entry.definition?.category === "computer",
    ).length;
    // Preserve the most specific schema/policy rejection when an entry is
    // already invalid; ordering is checked only after individual preflight.
    const orderRejection = preflight.some((entry) => entry.rejection !== undefined) ? undefined : validateCompositeCallOrder(preflight);
    const batchAllowed = this.batching !== "off" && computerEntries > 1 && orderRejection === undefined && isSameControlInputBatch(calls, preflight);
    const hasApproval = preflight.some(
      (entry) => entry.rejection === undefined && entry.decision?.decision === "require_approval",
    );
    const groupRejection = orderRejection
      ?? (computerEntries > 1 && !batchAllowed
        ? this.batching === "off" ? "a ModelTurn may contain at most one computer ToolCall" : "computer calls do not match the same-control input batch shape"
        : preflight.find((entry) => entry.rejection !== undefined)?.rejection
          ?? (hasApproval && calls.length > 1 ? "approval cannot be combined with other ToolCalls in one turn" : undefined));

    for (const call of calls) {
      this.callStates.set(call.id, "received");
      await this.commitEvent({ type: "tool.call.received", call });
    }

    if (groupRejection !== undefined) {
      for (const call of calls) {
        await this.rejectToolCall(call.id, groupRejection);
      }
      return { correction: false };
    }

    const computerPreflight = preflight.filter(
      (entry): entry is PreflightEntry & { definition: ComputerToolDefinition; preparedAction: PreparedComputerAction } =>
        entry.rejection === undefined && entry.definition?.category === "computer" && entry.preparedAction !== undefined,
    );
    if (this.actionPolicy !== undefined && computerPreflight.length > 0) {
      const decisionObservation = this.latestObservation;
      const goal = this.goal;
      if (decisionObservation === undefined || goal === undefined) throw new Error("action policy requires the active goal and observation");
      const guardDecision = await this.actionPolicy.evaluate({
        runId: this.runId,
        goal,
        recentUserInputs: this.events.filter((event): event is Extract<RuntimeEvent, { type: "user.input.received" }> => event.type === "user.input.received").slice(-4).map((event) => event.text),
        candidate: {
          calls: computerPreflight.map((entry) => entry.call),
          actions: computerPreflight.map((entry) => entry.preparedAction.action),
          decisionObservation,
          session,
          groundingEvidence: this.groundingEvidenceForActions(computerPreflight.map((entry) => entry.preparedAction.action)),
        },
        snapshot: this.getSnapshot(),
      }, this.abortController.signal);
      const afterGuard = await this.drainCommands();
      if (afterGuard.correction || this.snapshot.status === "paused") {
        if (this.snapshot.status === "paused") {
          this.pendingToolTurn = {
            session,
            entries: preflight,
            nextIndex: 0,
            invalidated: true,
            ...(batchAllowed ? { batch: true, decisionObservationId: this.snapshot.latestObservationId } : {}),
          };
        } else {
          await this.rejectPendingEntries(preflight, 0, "superseded by user correction during risk evaluation");
        }
        return afterGuard;
      }
      await this.commitGuardDecision(computerPreflight, guardDecision);
      if (guardDecision.decision === "deny") {
        for (const call of calls) await this.rejectToolCall(call.id, guardDecision.reason);
        return { correction: false };
      }
      if (guardDecision.decision === "require_approval") {
        if (calls.length !== 1 || computerPreflight.length !== 1) {
          const reason = `risk approval boundary: ${guardDecision.reason}; return the protected Computer action as the only call in the next turn`;
          for (const call of calls) await this.rejectToolCall(call.id, reason);
          return { correction: false };
        }
        const entry = computerPreflight[0]!;
        await this.requestApproval({
          call: entry.call,
          definition: entry.definition,
          session,
          preparedAction: entry.preparedAction,
        }, guardDecision.reason);
        return { correction: false };
      }
    }

    const approvalEntry = preflight.find(
      (entry) => entry.rejection === undefined && entry.decision?.decision === "require_approval",
    );
    if (approvalEntry !== undefined && approvalEntry.definition !== undefined && approvalEntry.decision?.decision === "require_approval") {
      await this.requestApproval({
        call: approvalEntry.call,
        definition: approvalEntry.definition,
        session,
        ...(approvalEntry.preparedAction === undefined ? {} : { preparedAction: approvalEntry.preparedAction }),
      }, approvalEntry.decision.reason);
      return { correction: false };
    }

    const effects = await this.drainCommands();
    if (effects.correction) {
      if (this.snapshot.status === "paused") {
        this.pendingToolTurn = {
          session,
          entries: preflight,
          nextIndex: 0,
          invalidated: true,
          ...(batchAllowed ? { batch: true, decisionObservationId: this.snapshot.latestObservationId } : {}),
        };
      } else {
        await this.rejectPendingEntries(preflight, 0, "superseded by user correction");
      }
      return effects;
    }
    if (this.snapshot.status === "paused") {
      this.pendingToolTurn = {
        session,
        entries: preflight,
        nextIndex: 0,
        invalidated: false,
        ...(batchAllowed ? { batch: true, decisionObservationId: this.snapshot.latestObservationId } : {}),
      };
      return effects;
    }
    return this.executePendingEntries({
      session,
      entries: preflight,
      nextIndex: 0,
      invalidated: false,
      ...(batchAllowed ? { batch: true, decisionObservationId: this.snapshot.latestObservationId } : {}),
    });
  }

  private async executePendingEntries(pendingTurn: PendingToolTurn): Promise<CommandEffects> {
    for (let index = pendingTurn.nextIndex; index < pendingTurn.entries.length; index += 1) {
      const entry = pendingTurn.entries[index];
      if (entry === undefined || entry.rejection !== undefined || entry.definition === undefined) {
        throw new Error("internal preflight state is incomplete");
      }
      const context: ToolExecutionContext = {
        runId: this.runId,
        session: pendingTurn.session,
        signal: this.abortController.signal,
        ...this.currentExecutionObservationContext(),
      };
      this.throwIfAborted();
      if (entry.definition.category === "computer") {
        if (pendingTurn.batch) {
          const actionBudget = this.policy.checkActionBudget(this.snapshot);
          if (!actionBudget.allowed) {
            this.actionBudgetExhausted = true;
            await this.rejectPendingEntries(pendingTurn.entries, index, actionBudget.reason ?? "computer action budget exhausted");
            return { correction: false };
          }
          const decision = await this.policy.evaluateToolCall({ call: entry.call, tool: entry.definition, snapshot: this.snapshot });
          if (decision.decision !== "allow") {
            await this.rejectToolCall(entry.call.id, decision.decision === "deny" ? decision.reason : `approval required inside a batch: ${decision.reason}`);
            await this.rejectPendingEntries(pendingTurn.entries, index + 1, `previous ToolCall ${entry.call.id} was not allowed; remaining calls were not executed`);
            return { correction: false };
          }
        }
        await this.executeComputerCall(
          entry.call,
          entry.definition,
          context,
          pendingTurn.decisionObservationId,
          entry.preparedAction,
          () => this.rejectPendingEntries(pendingTurn.entries, index + 1, "window handoff requested; remaining ToolCalls were not executed"),
        );
      } else if (entry.definition.category === "control") {
        await this.rejectToolCall(entry.call.id, "control decisions must be mapped by the Provider, not executed as tools");
      } else {
        await this.executeNonComputerCall(entry.call, entry.definition, context);
      }
      // Monitor help is deferred until the complete tool/action boundary has
      // settled.  In particular, an action receipt is followed by its
      // terminal ToolResult and post-action observation before status changes
      // to waiting_user.
      await this.flushDeferredMonitorHelp();
      if (this.snapshot.status === "waiting_window") {
        return { correction: false };
      }
      if (this.snapshot.status === "waiting_user") {
        // Stop a multi-tool turn at the Inbox boundary.  The completed entry
        // is not replayed; remaining entries resume from this watermark or
        // are invalidated by the subsequent user correction.
        this.pendingToolTurn = { ...pendingTurn, nextIndex: index + 1 };
        return { correction: false };
      }
      const callState = this.callStates.get(entry.call.id);
      if (callState === "failed" || callState === "rejected") {
        if (this.snapshot.status === "finished") return { correction: false };
        await this.rejectPendingEntries(pendingTurn.entries, index + 1, `previous ToolCall ${entry.call.id} did not complete; remaining calls were not executed`);
        return { correction: false };
      }
      const afterTool = await this.drainCommands();
      if (afterTool.correction) {
        if (this.snapshot.status === "paused") {
          this.pendingToolTurn = {
            ...pendingTurn,
            nextIndex: index + 1,
            invalidated: true,
          };
        } else {
          await this.rejectPendingEntries(pendingTurn.entries, index + 1, "superseded by user correction");
        }
        return afterTool;
      }
      if (this.snapshot.status === "paused") {
        this.pendingToolTurn = { ...pendingTurn, nextIndex: index + 1 };
        return afterTool;
      }
      if (this.snapshot.status === "finished") {
        return afterTool;
      }
    }
    return { correction: false };
  }

  private async rejectPendingEntries(
    entries: readonly PreflightEntry[],
    startIndex: number,
    reason: string,
  ): Promise<void> {
    for (let index = startIndex; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry !== undefined && this.callStates.get(entry.call.id) === "received") {
        await this.rejectToolCall(entry.call.id, reason);
      }
    }
  }

  private async executeNonComputerCall(
    call: ToolCall,
    definition: NonComputerToolDefinition,
    context: ToolExecutionContext,
  ): Promise<void> {
    try {
      const output = await definition.execute(call.arguments, context);
      if (definition.category === "planning" && definition.planMutationFromResult !== undefined) {
        const mutation = definition.planMutationFromResult(output);
        if (mutation !== undefined) {
          await this.commitEvent({ type: "planning.task.updated", callId: call.id, mutation });
          if (definition.afterPlanCommit !== undefined) {
            try {
              await definition.afterPlanCommit(mutation, context);
            } catch (error) {
              const result: ToolResult = {
                callId: call.id,
                status: "failed",
                error: { code: "PLAN_MATERIALIZATION_FAILED", message: errorMessage(error) },
              };
              await this.commitEvent({ type: "tool.call.failed", result });
              this.callStates.set(call.id, "failed");
              await this.commitEvent({
                type: "runtime.error",
                category: "planning_materialization_failed",
                message: errorMessage(error),
              });
              await this.commitRunFinished({ outcome: "failed" });
              return;
            }
          }
        }
      }
      if (definition.memoryMutationFromResult !== undefined) {
        const proposedMutation = definition.memoryMutationFromResult(output, context);
        const normalizedMutation = proposedMutation === undefined ? undefined : validateMemoryMutation(proposedMutation);
        const mutation = normalizedMutation === undefined
          ? undefined
          : validateMemoryMutation(this.attachMemoryProvenance(normalizedMutation, call.id));
        if (mutation !== undefined) {
          this.validateMemoryMutationReferences(mutation);
          await this.commitEvent({ type: "memory.updated", source: "tool", callId: call.id, mutation });
          if (definition.afterMemoryCommit !== undefined) {
            try {
              await definition.afterMemoryCommit(mutation, context);
            } catch (error) {
              const result: ToolResult = {
                callId: call.id,
                status: "failed",
                error: { code: "MEMORY_MATERIALIZATION_FAILED", message: errorMessage(error) },
              };
              await this.commitEvent({ type: "tool.call.failed", result });
              this.callStates.set(call.id, "failed");
              await this.commitEvent({ type: "runtime.error", category: "memory_materialization_failed", message: errorMessage(error) });
              await this.commitRunFinished({ outcome: "failed" });
              return;
            }
          }
        }
      }
      if (definition.executionSegmentMutationFromResult !== undefined) {
        const mutation = definition.executionSegmentMutationFromResult(output, context);
        if (mutation !== undefined) {
          await this.commitEvent({ type: "execution.segment.updated", source: "tool", callId: call.id, mutation });
        }
      }
      const result: ToolResult = { callId: call.id, status: "completed", output };
      await this.commitEvent({ type: "tool.call.completed", result });
      this.callStates.set(call.id, "completed");
    } catch (error) {
      const result: ToolResult = {
        callId: call.id,
        status: "failed",
        error: { code: "TOOL_FAILED", message: errorMessage(error) },
      };
      await this.commitEvent({ type: "tool.call.failed", result });
      this.callStates.set(call.id, "failed");
    }
  }

  private async executeComputerCall(
    call: ToolCall,
    definition: ComputerToolDefinition,
    context: ToolExecutionContext,
    decisionObservationId: ObservationId | undefined = this.snapshot.latestObservationId,
    prepared?: PreparedComputerAction,
    beforeWindowHandoff?: () => Promise<void>,
  ): Promise<void> {
    this.throwIfAborted();
    const executionObservationId = this.snapshot.latestObservationId;
    const preActionFingerprint = this.latestObservationFingerprint;
    let candidate: PreparedComputerAction;
    try {
      candidate = prepared ?? this.prepareComputerAction(call, definition, context, decisionObservationId);
      const action = candidate.action;
      const executionObservation = this.currentExecutionObservation();
      validateActionIntent(action, {
        capabilities: context.session.capabilities,
        ...(executionObservation === undefined ? {} : { observation: executionObservation }),
        ...(executionObservationId === undefined ? {} : { executionObservationId }),
      });
    } catch (error) {
      // Deterministic GUI contract violations are a rejected ToolCall, not a
      // runtime crash. The model can observe the rejection and replan without
      // any action.proposed or driver side effect being recorded.
      await this.rejectToolCall(call.id, `invalid GUI action: ${errorMessage(error)}`);
      return;
    }
    const action = candidate.action;
    const segmentBinding = this.matchCurrentExecutionSegmentAction(action);
    const activeSegment = this.snapshot.executionSegment;
    if (activeSegment?.status === "active" && segmentBinding === undefined) {
      // A real main-provider GUI action is a replan unless it semantically
      // targets the current Segment click step.  This is deliberately done
      // after action preparation/validation: rejected malformed calls do not
      // erase a still-valid local demand before they can execute anything.
      await this.commitEvent({ type: "execution.segment.updated", source: "runtime", mutation: { operation: "invalidated", segmentId: activeSegment.id, reason: "main_provider_replanned" } });
    }
    if (this.monitorMode === "guidance" && this.monitorState !== undefined && shouldRejectRepeatedNoChange(this.monitorState, action)) {
      await this.rejectToolCall(
        call.id,
        "Monitor blocked a repeated GUI action after an unchanged observation; re-observe and re-localize the target before trying a different action",
      );
      return;
    }
    if (this.callStates.get(call.id) !== "received") {
      throw new Error(`ToolCall ${call.id} is not available for action proposal`);
    }
    if (this.actionCallIds.has(action.actionId)) {
      throw new Error(`ActionId ${action.actionId} was already proposed`);
    }
    await this.commitEvent({
      type: "action.proposed",
      callId: call.id,
      action,
      ...(executionObservationId === undefined ? {} : { executionObservationId }),
    });
    const coordinateCoverage = this.coordinateCoverageEvent(action);
    if (coordinateCoverage !== undefined) await this.commitEvent(coordinateCoverage);
    this.callStates.set(call.id, "proposed");
    this.actionCallIds.set(action.actionId, call.id);
    if (this.actionCallIds.get(action.actionId) !== call.id) {
      throw new Error(`action ${action.actionId} is not linked to ToolCall ${call.id}`);
    }
    this.throwIfAborted();
    await this.commitEvent({
      type: "action.execution.started",
      action,
      ...(executionObservationId === undefined ? {} : { executionObservationId }),
    });
    if (segmentBinding !== undefined) {
      await this.commitEvent({
        type: "execution.segment.updated",
        source: "runtime",
        mutation: { operation: "step_attempted", segmentId: segmentBinding.segmentId, stepId: segmentBinding.stepId },
      });
    }
    this.callStates.set(call.id, "executing");

    let receipt: import("@computer-harness/protocol").ActionReceipt;
    try {
      const executeOptions: ComputerExecuteOptions = executionObservationId === undefined ? {} : { executionObservationId };
      receipt = await this.computer.execute(context.session, action, this.abortController.signal, {
        ...executeOptions,
        ...(this.windowHandoff === "confirm-v1" ? { detectNewWindowHandoff: true } : {}),
      });
    } catch (error) {
      await this.commitEvent({
        type: "runtime.error",
        category: "unknown_side_effect",
        message: errorMessage(error),
      });
      await this.commitRunFinished({ outcome: "outcome_unknown" });
      this.callStates.set(call.id, "executing");
      return;
    }

    let terminalActionEvent: RuntimeEvent;
    if (receipt.status === "completed") {
      terminalActionEvent = await this.commitEvent({ type: "action.execution.completed", receipt });
    } else {
      terminalActionEvent = await this.commitEvent({ type: "action.execution.failed", receipt });
    }
    const result: ToolResult =
      receipt.status === "completed"
        ? { callId: call.id, status: "completed", output: actionReceiptOutput(receipt) }
        : {
            callId: call.id,
            status: "failed",
            error: {
              code: receipt.driverCode ?? `ACTION_${receipt.status.toUpperCase()}`,
              message: receipt.message ?? `computer action ${receipt.status}`,
            },
          };
    if (result.status === "completed") {
      await this.commitEvent({ type: "tool.call.completed", result });
      this.callStates.set(call.id, "completed");
    } else {
      await this.commitEvent({ type: "tool.call.failed", result });
      this.callStates.set(call.id, "failed");
      if (this.snapshot.executionSegment?.status === "active") {
        await this.commitEvent({ type: "execution.segment.updated", source: "runtime", mutation: { operation: "invalidated", segmentId: this.snapshot.executionSegment.id, reason: "bound_computer_action_failed" } });
      }
    }
    if (receipt.status === "refused" && receipt.driverCode === "WINDOW_FOREGROUND_MISMATCH" &&
        this.windowHandoff === "confirm-v1" && this.computer.handoffWindow !== undefined && this.computer.listWindowHandoffCandidates !== undefined) {
      await beforeWindowHandoff?.();
      await this.commitEvent({ type: "computer.window.handoff.requested", sourceActionId: action.actionId, reasonCode: "foreground_mismatch" });
      return;
    }
    if (receipt.status === "completed" && action.kind !== "wait" && this.windowHandoff === "confirm-v1" &&
        this.computer.handoffWindow !== undefined && this.computer.listWindowHandoffCandidates !== undefined &&
        this.computer.detectNewWindowHandoffCandidates !== undefined) {
      // Action and ToolCall receipts are durable before this read-only diff.
      // A discovered window pauses the run; the completed action is never replayed.
      const surfaced = await this.computer.detectNewWindowHandoffCandidates(context.session, this.abortController.signal);
      this.throwIfAborted();
      if (surfaced.length > 0) {
        await beforeWindowHandoff?.();
        await this.commitEvent({ type: "computer.window.handoff.requested", sourceActionId: action.actionId, reasonCode: "new_window_detected" });
        return;
      }
    }
    // The action and ToolCall facts are durable before taking the follow-up
    // observation. If observing the post-action state fails, the Run can be
    // marked failed without leaving a completed action with a dangling call.
    const postObservation = await this.observeAndCommit(context.session);
    await this.commitMonitorTransition(
      action,
      receipt.status,
      preActionFingerprint,
      this.latestObservationFingerprint,
      terminalActionEvent.eventId,
      postObservation,
    );
  }

  private async commitMonitorTransition(
    action: ActionIntent,
    receiptStatus: import("@computer-harness/protocol").ActionReceipt["status"],
    preActionFingerprint: LatestObservationFingerprint | undefined,
    postActionFingerprint: LatestObservationFingerprint | undefined,
    sourceActionEventId: EventId,
    postObservation: ObservationFrame,
  ): Promise<void> {
    if (this.monitorMode === "off") return;
    const observationEvent = this.events[this.events.length - 1];
    if (observationEvent?.type !== "observation.created" || observationEvent.observation.id !== postObservation.id) {
      throw new Error("post-action observation was not the latest committed observation");
    }
    const transition: ObservationTransition = receiptStatus !== "completed"
      || preActionFingerprint === undefined
      || postActionFingerprint === undefined
      ? "unknown"
      : sameObservationFingerprint(preActionFingerprint.fingerprint, postActionFingerprint.fingerprint)
        ? "unchanged"
        : "changed";
    await this.commitEvent({
      type: "monitor.transition",
      actionId: action.actionId,
      ...(preActionFingerprint === undefined ? {} : { preObservationId: preActionFingerprint.observationId }),
      postObservationId: postObservation.id,
      sourceActionEventId,
      sourceObservationEventId: observationEvent.eventId,
      transition,
    });
  }

  private prepareComputerAction(
    call: ToolCall,
    definition: ComputerToolDefinition,
    context: ToolExecutionContext,
    decisionObservationId: ObservationId | undefined,
  ): PreparedComputerAction {
    this.throwIfAborted();
    const draft = definition.toAction(call.arguments, context);
    this.throwIfAborted();
    const executionObservationId = this.snapshot.latestObservationId;
    const action = makeActionIntent(this.idFactory.actionId(), decisionObservationId, draft);
    const executionObservation = this.currentExecutionObservation();
    validateActionIntent(action, {
      capabilities: context.session.capabilities,
      ...(executionObservation === undefined ? {} : { observation: executionObservation }),
      ...(executionObservationId === undefined ? {} : { executionObservationId }),
    });
    return { action, ...(decisionObservationId === undefined ? {} : { decisionObservationId }) };
  }

  private async commitGuardDecision(
    entries: readonly (PreflightEntry & { definition: ComputerToolDefinition; preparedAction: PreparedComputerAction })[],
    decision: ActionPolicyDecision,
  ): Promise<void> {
    await this.commitEvent({
      type: "action.guard.evaluated",
      callIds: entries.map((entry) => entry.call.id),
      actions: entries.map((entry) => summarizeGuardAction(entry.preparedAction.action)),
      decision: decision.decision,
      categories: [...decision.categories],
      reasonCode: decision.reasonCode,
      reason: decision.reason,
      path: decision.path,
      policyVersion: decision.policyVersion,
      ...(decision.assessorId === undefined ? {} : { assessorId: decision.assessorId }),
      ...(decision.semanticEffects === undefined ? {} : { semanticEffects: [...decision.semanticEffects] }),
      ...(decision.alignment === undefined ? {} : { alignment: decision.alignment }),
      modelRequestCount: decision.modelRequestCount,
      ...(decision.latencyMs === undefined ? {} : { latencyMs: decision.latencyMs }),
      ...(decision.usage === undefined ? {} : { usage: decision.usage }),
    });
  }

  private attachMemoryProvenance(mutation: MemoryMutation, callId: ToolCallId): MemoryMutation {
    const source = [...this.events].reverse().find((event) => event.type === "tool.call.received" && event.call.id === callId);
    const sourceEventId = source?.eventId ?? this.idFactory.eventId();
    const updatedSequence = source?.sequence ?? this.nextSequence;
    const stampFact = <T extends Pick<MemoryFact, "sourceEventId" | "updatedSequence"> & Partial<Pick<MemoryFact, "scope" | "retentionClass" | "statusReason">>>(fact: T): T => ({
      ...fact,
      scope: fact.scope ?? { kind: "run" },
      retentionClass: fact.retentionClass ?? "stable",
      sourceEventId,
      updatedSequence,
    });
    switch (mutation.operation) {
      case "upsert_fact": return { operation: "upsert_fact", fact: stampFact(mutation.fact) };
      case "supersede_fact": return { operation: "supersede_fact", factId: mutation.factId, ...(mutation.replacement === undefined ? {} : { replacement: stampFact(mutation.replacement) }) };
      case "mark_fact_needs_check": return mutation;
      case "upsert_entity": return { operation: "upsert_entity", entity: { ...mutation.entity, sourceEventId, updatedSequence } };
      case "invalidate_entity": return mutation;
    }
  }

  private validateMemoryMutationReferences(mutation: MemoryMutation): void {
    switch (mutation.operation) {
      case "upsert_fact":
        this.validateMemoryFact(mutation.fact);
        return;
      case "supersede_fact": {
        const existing = this.snapshot.memory.facts.find((fact) => fact.id === mutation.factId);
        if (existing === undefined || existing.status === "superseded") throw new Error(`Memory fact ${mutation.factId} does not exist or is superseded`);
        if (mutation.replacement !== undefined) {
          const replacement = mutation.replacement;
          if (replacement.id === mutation.factId) throw new Error("Memory replacement must have a distinct fact id");
          if (this.snapshot.memory.facts.some((fact) => fact.id === replacement.id) || this.snapshot.memory.entities.some((entity) => entity.id === replacement.id)) throw new Error(`Memory replacement id ${replacement.id} already exists`);
          this.validateMemoryFact(replacement);
        }
        return;
      }
      case "mark_fact_needs_check": {
        const existing = this.snapshot.memory.facts.find((fact) => fact.id === mutation.factId);
        if (existing === undefined || existing.status === "superseded") throw new Error(`Memory fact ${mutation.factId} does not exist or is superseded`);
        return;
      }
      case "upsert_entity": {
        const existing = this.snapshot.memory.entities.find((entity) => entity.id === mutation.entity.id);
        if (this.snapshot.memory.facts.some((fact) => fact.id === mutation.entity.id)) throw new Error(`Memory entity id ${mutation.entity.id} collides with a fact id`);
        if (existing !== undefined && existing.status !== "active") throw new Error(`Memory entity ${mutation.entity.id} is not active`);
        this.validateMemoryTaskLinks(mutation.entity.relatedTaskIds);
        return;
      }
      case "invalidate_entity": {
        const existing = this.snapshot.memory.entities.find((entity) => entity.id === mutation.entityId);
        if (existing === undefined || existing.status !== "active") throw new Error(`Memory entity ${mutation.entityId} does not exist or is not active`);
        return;
      }
    }
  }

  private validateMemoryFact(fact: import("@computer-harness/protocol").MemoryFact): void {
    if (this.snapshot.memory.entities.some((entity) => entity.id === fact.id)) throw new Error(`Memory fact id ${fact.id} collides with an entity id`);
    const existing = this.snapshot.memory.facts.find((item) => item.id === fact.id);
    if (existing !== undefined && existing.status === "superseded") throw new Error(`Memory fact id ${fact.id} is superseded`);
    if (existing !== undefined && !sameMemoryFactContent(existing, fact)) {
      throw new Error(`Memory fact id ${fact.id} already exists; changed content requires supersede_fact`);
    }
    const subject = fact.subject;
    const scope = memoryFactScope(fact);
    if (scope.kind === "computer_session" && (this.snapshot.computerSession === undefined || scope.sessionId !== this.snapshot.computerSession.id)) {
      throw new Error("Memory computer_session scope does not match the current Computer session");
    }
    if (memoryFactRetentionClass(fact) === "task" && (!this.planningEnabled || fact.relatedTaskIds === undefined || fact.relatedTaskIds.length === 0)) {
      throw new Error("Memory task retention requires Planning and relatedTaskIds");
    }
    if (subject.type === "entity") {
      const entity = this.snapshot.memory.entities.find((item) => item.id === subject.entityId);
      if (entity === undefined || entity.status !== "active") throw new Error(`Memory fact subject references an unknown or inactive entity ${subject.entityId}`);
    }
    this.validateMemoryTaskLinks(fact.relatedTaskIds);
  }

  private validateMemoryTaskLinks(relatedTaskIds: readonly string[] | undefined): void {
    if (relatedTaskIds === undefined || relatedTaskIds.length === 0) return;
    if (!this.planningEnabled) throw new Error("Memory relatedTaskIds require Planning to be enabled");
    const known = new Set(this.snapshot.plan.tasks.map((task) => task.id));
    const unknown = relatedTaskIds.filter((id) => !known.has(id));
    if (unknown.length > 0) throw new Error(`Memory relatedTaskIds reference unknown task(s): ${unknown.join(", ")}`);
  }

  private async rejectToolCall(callId: ToolCallId, reason: string): Promise<void> {
    const result: ToolResult = {
      callId,
      status: "rejected",
      error: { code: "TOOL_REJECTED", message: reason },
    };
    await this.commitEvent({ type: "tool.call.rejected", callId, reason });
    this.callStates.set(callId, "rejected");
  }

  private async observeAndCommit(session: ComputerSession): Promise<ObservationFrame> {
    const observationId = this.idFactory.observationId();
    const assetId = this.idFactory.assetId();
    let capture: import("@computer-harness/protocol").ObservationCapture;
    try {
      capture = await this.computer.observe(session, observationId, this.abortController.signal);
    } catch (error) {
      throw new ObservationCaptureError(error);
    }
    if (capture.grounding !== undefined) {
      if (capture.grounding.observationId !== observationId || capture.grounding.computerSessionId !== session.id) {
        throw new ObservationCaptureError(new Error("GROUNDING_CAPTURE_MISMATCH: grounding catalog is not bound to the current observation and computer session"));
      }
      this.groundingCandidates.set(String(observationId), capture.grounding);
      while (this.groundingCandidates.size > 4) {
        const oldest = this.groundingCandidates.keys().next().value;
        if (oldest === undefined) break;
        this.groundingCandidates.delete(oldest);
      }
    }
    const groundingQuery = capture.grounding === undefined ? undefined : this.groundingSelectionQuery(capture.grounding);
    const grounding = capture.grounding === undefined
      ? undefined
      : this.groundingSelector.select(capture.grounding, groundingQuery!);
    const extension = capture.screenshot.mediaType === "image/jpeg" ? "jpg" : "png";
    const asset = await this.assetStore.put({
      assetId,
      relativePath: `screenshots/${assetId}.${extension}`,
      mediaType: capture.screenshot.mediaType,
      data: capture.screenshot.data,
    });
    const observation: ObservationFrame = {
      id: observationId,
      runId: this.runId,
      computerSessionId: session.id,
      capturedAt: capture.capturedAt,
      viewport: capture.viewport,
      screenshot: asset,
      ...(grounding === undefined ? {} : { grounding }),
    };
    const persisted = await this.commitEvent({ type: "observation.created", observation });
    if (persisted.type !== "observation.created") {
      throw new Error("observation commit returned an unexpected event type");
    }
    this.latestObservation = persisted.observation;
    this.latestObservationFingerprint = {
      observationId,
      fingerprint: fingerprintObservation(session.id, capture),
    };
    // A completed GUI action must first become an attempted Segment step and
    // then be checked against fresh evidence.  Keeping this reconciliation at
    // the observation boundary makes the same rule hold for either Computer backend.
    if (capture.grounding !== undefined) {
      await this.reconcileExecutionSegment(persisted.observation, capture.grounding);
    } else {
      await this.reconcileExecutionSegment(persisted.observation);
    }
    return persisted.observation;
  }

  /**
   * Build the selector query from the same enabled Registry projection that
   * feeds Context/Provider. Structured hints are omitted unless the current
   * catalog advertises the corresponding backend source; in particular a
   * UIA-only/OSWorld catalog cannot manufacture a DOM select hint.
   */
  private groundingSelectionQuery(catalog: GroundingCatalog): GroundingSelectionQuery {
    const availableSources = catalog.source === "hybrid"
      ? new Set(["dom", "uia"])
      : new Set([catalog.source]);
    const hints: GroundingStructuredToolHint[] = [];
    for (const definition of this.toolRegistry.list()) {
      if (hints.length >= 8 || definition.category !== "computer" || !this.enabledCategories.has("computer") || !this.isToolEnabled(definition.name)) continue;
      const visible = this.toolRegistry.getForAudience(definition.name, this.toolAudience);
      const hint = visible?.category === "computer" ? visible.groundingHint : undefined;
      if (hint === undefined) continue;
      const preferredSources = hint.preferredSources.filter((source) => availableSources.has(source)).slice(0, 2);
      const preferredRoles = hint.preferredRoles.filter((role) => typeof role === "string" && role.trim().length > 0).slice(0, 8);
      if (preferredSources.length === 0 || preferredRoles.length === 0) continue;
      hints.push({ toolName: definition.name, preferredRoles, preferredSources });
    }
    const preferredRoles = [...new Set(hints.flatMap((hint) => hint.preferredRoles))].slice(0, 16);
    return {
      goal: this.goal ?? "",
      latestUserCorrections: this.events
        .filter((event): event is Extract<RuntimeEvent, { type: "user.input.received" }> => event.type === "user.input.received")
        .slice(-4)
        .map((event) => event.text),
      ...(() => {
        const activePlanText = this.snapshot.plan.tasks
          .filter((task) => task.status !== "completed")
          .map((task) => `${task.subject}: ${task.description}`)
          .join("\n");
        return activePlanText.length === 0 ? {} : { activePlanText };
      })(),
      ...(() => {
        const segment = this.snapshot.executionSegment;
        const step = segment?.status === "active" ? segment.steps[segment.cursor] : undefined;
        return step === undefined ? {} : { localExecutionIntent: `${segment?.objective ?? ""}: ${step.intent}` };
      })(),
      ...(preferredRoles.length === 0 ? {} : { preferredRoles }),
      ...(hints.length === 0 ? {} : { structuredToolHints: hints }),
      ...(this.groundingRecoveryHint === undefined ? {} : { recoveryHint: this.groundingRecoveryHint }),
    };
  }

  /**
   * Re-project the already committed latest catalog with the current
   * short-lived recovery hint.  This keeps the durable Observation immutable
   * while allowing the next Context request to prefer the failed-action
   * neighborhood; click_element refs remain valid because the adapter's
   * private map is observation/session bound and contains the same refs.
   */
  private observationForContext(observation: ObservationFrame): ObservationFrame {
    const segment = this.snapshot.executionSegment;
    const segmentStep = segment?.status === "active" ? segment.steps[segment.cursor] : undefined;
    if (this.groundingRecoveryHint === undefined && segmentStep === undefined) return observation;
    const candidates = this.groundingCandidates.get(String(observation.id));
    const sourceCatalog = candidates ?? observation.grounding;
    if (sourceCatalog === undefined) return observation;
    const grounding = this.groundingSelector.select(sourceCatalog, this.groundingSelectionQuery(sourceCatalog));
    return { ...observation, grounding };
  }

  private async commitRunFinished(data: { outcome: RunOutcome; summary?: string; reportedStatus?: "success" | "failure" }): Promise<RunOutcome> {
    let outcome = data.outcome;
    if (this.snapshot.executionSegment?.status === "active") {
      await this.commitEvent({ type: "execution.segment.updated", source: "runtime", mutation: { operation: "invalidated", segmentId: this.snapshot.executionSegment.id, reason: "run_finished" } });
    }
    try {
      await this.markSessionMemoryScopeEnded();
    } catch (error) {
      // Lifecycle events remain the replay authority, while Store failures
      // are explicit and do not masquerade as a fully materialized close.
      if (this.snapshot.status !== "finished") {
        await this.commitEvent({ type: "runtime.error", category: "memory_materialization_failed", message: `Memory scope cleanup incomplete: ${errorMessage(error)}` });
      }
      if (outcome === "succeeded") outcome = "failed";
    }
    await this.commitEvent({
      type: "run.finished",
      outcome,
      ...(data.summary === undefined ? {} : { summary: data.summary }),
      ...(data.reportedStatus === undefined ? {} : { reportedStatus: data.reportedStatus }),
    });
    this.groundingCandidates.clear();
    this.groundingRecoveryHint = undefined;
    return outcome;
  }

  private async markSessionMemoryScopeEnded(): Promise<void> {
    if (this.sessionMemoryScopeEnded || !this.memoryEnabled || this.snapshot.computerSession === undefined) return;
    const sessionId = this.snapshot.computerSession.id;
    const facts = this.snapshot.memory.facts.filter((fact) => {
      const scope = memoryFactScope(fact);
      return scope.kind === "computer_session" && scope.sessionId === sessionId && fact.status !== "superseded";
    });
    let firstError: unknown;
    for (const fact of facts) {
      const mutation: MemoryMutation = { operation: "mark_fact_needs_check", factId: fact.id, reason: "scope_ended" };
      const existingLifecycleEvent = [...this.events].reverse().find((event) => event.type === "memory.updated"
        && (event.source === "lifecycle" || event.callId === ("runtime:scope-ended" as ToolCallId))
        && event.mutation.operation === "mark_fact_needs_check"
        && event.mutation.factId === fact.id);
      try {
        if (existingLifecycleEvent === undefined) {
          await this.commitEvent({ type: "memory.updated", source: "lifecycle", mutation });
        }
        await this.memoryMutationApplier?.(this.runId, mutation);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) {
      throw firstError;
    }
    this.sessionMemoryScopeEnded = true;
  }

  private async commitEvent(data: RuntimeEventData): Promise<RuntimeEvent> {
    const draft = {
      ...data,
      runId: this.runId,
      eventId: this.idFactory.eventId(),
      occurredAt: this.clock.now(),
    } as import("@computer-harness/protocol").RuntimeEventDraft;
    const candidate = { ...draft, sequence: this.nextSequence } as RuntimeEvent;
    // Validate the proposed transition before touching the writer, but only
    // project the event that the writer actually persisted into live state.
    reduceRunEvent(this.snapshot, candidate);
    const persisted = await this.eventWriter.append(draft);
    if (
      persisted.eventId !== candidate.eventId ||
      persisted.runId !== candidate.runId ||
      persisted.sequence !== candidate.sequence
    ) {
      throw new Error(`event writer returned an unexpected event boundary at sequence ${candidate.sequence}`);
    }
    const nextSnapshot = reduceRunEvent(this.snapshot, persisted);
    this.snapshot = nextSnapshot;
    this.events.push(persisted);
    this.nextSequence = persisted.sequence + 1;
    try {
      this.onEventCommitted?.(structuredClone(persisted));
    } catch {
      // A UI/feed observer is never part of the execution result. The event
      // is already durable and reduced, so observer failure is isolated from
      // the Controller's scheduling path.
    }
    try {
      await this.processMonitorCommittedEvent(persisted);
    } catch (error) {
      // Monitor is diagnostic/control assistance, never the authority for a
      // durable business event.  A failed proposal append or policy callback
      // must not turn the already-committed action/tool event into a failed
      // Run.  Best-effort recording is itself isolated below.
      await this.recordMonitorDiagnosticFailure(error);
    }
    return persisted;
  }

  private async processMonitorCommittedEvent(event: RuntimeEvent): Promise<void> {
    if (this.monitorMode === "off" || this.monitorProcessing || event.type === "monitor.proposal" || this.monitorState === undefined || this.monitorPolicyState === undefined) return;
    this.monitorProcessing = true;
    try {
      if (event.type === "model.request.started" && event.attempt === 1) {
        this.monitorWorkClock = { ...this.monitorWorkClock, modelDecisionCount: this.monitorWorkClock.modelDecisionCount + 1 };
        this.monitorPendingGuidance = undefined;
      } else if (event.type === "action.execution.completed" || event.type === "action.execution.failed") {
        this.monitorWorkClock = { ...this.monitorWorkClock, guiActionCount: this.monitorWorkClock.guiActionCount + 1 };
      }
      const progress = reduceProgressMonitor(this.monitorState, event);
      this.monitorState = progress.state;
      this.updateGroundingRecoveryHint(event, progress.output);
      const executionBarrier = this.monitorExecutionBarrier();
      if (this.monitorBarrierClearsPendingRecommendations() || this.snapshot.status === "finished") {
        this.clearMonitorPendingRecommendations();
      }
      const partitionKey = this.monitorPartitionKey();
      if (this.monitorLastPartitionKey !== undefined && this.monitorLastPartitionKey !== partitionKey) {
        this.monitorLastPersistedKey = undefined;
        this.clearMonitorPendingRecommendations();
      }
      this.monitorLastPartitionKey = partitionKey;
      const policy = reduceMonitorPolicy(this.monitorPolicyState, {
        runId: this.runId,
        partitionKey,
        sequence: event.sequence,
        clock: this.monitorWorkClock,
        monitor: progress.output,
        ...(executionBarrier === undefined ? {} : { executionBarrier }),
        ...(this.snapshot.status === "finished" ? { terminal: true } : {}),
      });
      this.monitorPolicyState = policy.state;
      if (!this.shouldPersistMonitorProposal(policy.proposal, progress.output)) return;
      const proposalEvent = this.monitorProposalEvent(policy.proposal, progress.output, event.eventId);
      if (proposalEvent === undefined || this.monitorProposalCount >= 64) return;
      // The monitor still consumes control events to keep its in-memory state
      // and policy lifecycle coherent, but trajectory proposals are legal only
      // while the Run reducer is in `running`. In particular, approval and
      // user-input barriers must not produce a diagnostic by attempting to
      // append a proposal after the status has already changed.
      if (this.snapshot.status !== "running") {
        this.clearMonitorPendingRecommendations();
        return;
      }
      this.monitorProposalCount += 1;
      this.monitorLastPersistedKey = this.monitorProposalKey(policy.proposal, progress.output);
      await this.commitEvent(proposalEvent);
      if (policy.proposal.kind === "guidance") {
        this.monitorPendingGuidance = { text: policy.proposal.text, fingerprint: policy.proposal.fingerprint };
      } else if (policy.proposal.kind === "help_requested" && this.snapshot.status === "running" && this.monitorExecutionBarrier() === undefined) {
        // Do not transition status from inside action.execution.completed or
        // before the matching ToolResult/post-observation has been committed.
        // The owning tool-turn loop flushes this deferred request at its
        // atomic boundary.
        this.monitorPendingHelp = policy.proposal;
      }
    } finally {
      this.monitorProcessing = false;
    }
  }

  private async flushDeferredMonitorHelp(): Promise<void> {
    const pending = this.monitorPendingHelp;
    if (pending === undefined || this.snapshot.status !== "running" || this.monitorExecutionBarrier() !== undefined) return;
    this.monitorPendingHelp = undefined;
    try {
      await this.commitEvent({ type: "user.input.requested", question: `Monitor requests human review (${pending.reason}); confirm the current state before continuing.` });
    } catch (error) {
      // A diagnostic request is best effort.  If its own event cannot be
      // committed, leave the already-completed action outcome untouched.
      await this.recordMonitorDiagnosticFailure(error);
    }
  }

  private clearMonitorPendingRecommendations(): void {
    this.monitorPendingGuidance = undefined;
    this.monitorPendingHelp = undefined;
  }

  /**
   * Turn existing Monitor evidence into one bounded selector hint. This is a
   * consumer of the current Monitor path, not another retry/stop mechanism.
   * Regions are derived only from committed ActionIntent/Observation events.
   */
  private updateGroundingRecoveryHint(event: RuntimeEvent, output: import("./progress-monitor.js").ProgressMonitorOutput): void {
    if (event.type === "user.input.received") {
      // A correction changes the local intent and invalidates the failed
      // action's region.  Keep the correction in the normal selector query;
      // never combine it with the old actionId/bbox and let a delegated policy
      // request inherit that stale binding.
      this.groundingRecoveryHint = undefined;
      return;
    }
    if (event.type === "planning.task.updated" || event.type === "run.finished") {
      this.groundingRecoveryHint = undefined;
      return;
    }
    if (event.type === "observation.created") {
      // Every observation receives a new frame-bound grounding namespace.
      // A prior recovery region/action is therefore stale even when the
      // monitor fingerprint says the pixels are unchanged.
      this.groundingRecoveryHint = undefined;
      return;
    }
    if (event.type === "monitor.transition") {
      if (event.transition === "changed") {
        this.groundingRecoveryHint = undefined;
        return;
      }
      const reason = event.transition === "unchanged" ? "no_observed_change" : "unknown_outcome";
      const action = this.actionForId(event.actionId);
      this.setGroundingRecoveryHint(reason, event.actionId, action);
      return;
    }
    if (event.type === "action.execution.failed") {
      if (/WINDOW_GEOMETRY_CHANGED|GROUNDING_REF_STALE|WINDOW_TARGET/iu.test(event.receipt.driverCode ?? "")) {
        this.groundingRecoveryHint = undefined;
        return;
      }
      const action = this.actionForId(event.receipt.actionId);
      this.setGroundingRecoveryHint("repeated_failure", event.receipt.actionId, action);
      return;
    }
    if (event.type === "tool.call.rejected" && output.reasons.some((reason) => reason.code === "repeated_refusal")) {
      this.groundingRecoveryHint = undefined;
    }
  }

  private setGroundingRecoveryHint(
    reason: GroundingRecoveryHint["reason"],
    actionId: ActionId,
    action: ActionIntent | undefined,
  ): void {
    const region = action === undefined ? undefined : this.groundingRecoveryRegion(action);
    const prior = this.groundingRecoveryHint;
    const sameAction = prior?.actionId !== undefined && prior.actionId === actionId;
    const sameRegion = sameAction && region !== undefined && prior?.region !== undefined && groundingBoxesOverlap(region, prior.region) >= 0.45;
    const attempt = sameRegion && prior.reason === reason ? Math.min(16, prior.attempt + 1) : 1;
    // Monitor's own guidance/help budget remains authoritative. Grounding gets
    // at most three local attempts before it falls back to ordinary visual/UIA
    // selection; a human correction explicitly resets this small budget.
    if (attempt > 3) {
      this.groundingRecoveryHint = undefined;
      return;
    }
    const providerHint = prior?.localIntentSource === "user_correction" ? undefined : this.providerRecoveryIntent(actionId);
    this.groundingRecoveryHint = {
      actionId,
      reason,
      attempt,
      ...(region === undefined ? {} : { region }),
      ...(prior?.localIntentSource === "user_correction" && prior.localIntent !== undefined
        ? { localIntent: prior.localIntent, localIntentSource: "user_correction" as const }
        : providerHint === undefined ? {} : { localIntent: providerHint.text, localIntentSource: providerHint.source }),
    };
  }

  private providerRecoveryIntent(actionId: ActionId): { readonly text: string; readonly source: "declared_effect" | "provider_hint" } | undefined {
    const proposed = [...this.events].reverse().find((event): event is Extract<RuntimeEvent, { type: "action.proposed" }> =>
      event.type === "action.proposed" && event.action.actionId === actionId);
    const callId = this.actionCallIds.get(actionId) ?? proposed?.callId;
    if (callId === undefined) return undefined;
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const event = this.events[index];
      if (event?.type !== "model.response.received" || event.turn.type !== "tool_calls") continue;
      const call = event.turn.calls.find((candidate) => candidate.id === callId);
      if (call === undefined) continue;
      if (call.declaredEffect !== undefined) {
        const text = boundedRecoveryIntent(`${call.declaredEffect.target}: ${call.declaredEffect.summary}`);
        if (text !== undefined) return { text, source: "declared_effect" };
      }
      const assistantText = event.turn.assistantText === undefined ? undefined : boundedRecoveryIntent(event.turn.assistantText);
      if (assistantText !== undefined) return { text: assistantText, source: "provider_hint" };
      return undefined;
    }
    return undefined;
  }

  private actionForId(actionId: ActionId): ActionIntent | undefined {
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const event = this.events[index];
      if (event?.type === "action.execution.started" && event.action.actionId === actionId) return event.action;
      if (event?.type === "action.proposed" && event.action.actionId === actionId) return event.action;
    }
    return undefined;
  }

  private groundingRecoveryRegion(action: ActionIntent): GroundingBoundingBox | undefined {
    if (action.kind === "wait" || this.latestObservation === undefined) return undefined;
    const viewport = this.latestObservation.viewport;
    const point = action.kind === "click" || action.kind === "double_click" || action.kind === "right_click" || action.kind === "scroll"
      ? action.point
      : action.kind === "drag"
        ? { x: (action.from.x + action.to.x) / 2, y: (action.from.y + action.to.y) / 2 }
        : undefined;
    if (point === undefined) {
      if (action.groundingRef === undefined) return undefined;
      const boundObservation = this.events.find((event): event is Extract<RuntimeEvent, { type: "observation.created" }> =>
        event.type === "observation.created" && event.observation.id === action.basedOn);
      return boundObservation?.observation.grounding?.elements.find((element) => element.elementRef === action.groundingRef)?.bbox;
    }
    const width = Math.min(96, viewport.width);
    const height = Math.min(96, viewport.height);
    return {
      x: Math.max(0, Math.min(viewport.width - width, point.x - width / 2)),
      y: Math.max(0, Math.min(viewport.height - height, point.y - height / 2)),
      width,
      height,
      coordinateSpace: "physical",
    };
  }

  private monitorBarrierClearsPendingRecommendations(): boolean {
    return this.snapshot.outcome === "outcome_unknown"
      || this.isAborted()
      || this.snapshot.pendingApproval !== undefined
      || this.snapshot.pendingUserQuestion !== undefined;
  }

  private async recordMonitorDiagnosticFailure(error: unknown): Promise<void> {
    if (this.monitorDiagnosticRecording) return;
    this.monitorDiagnosticRecording = true;
    try {
      await this.commitEvent({
        type: "runtime.error",
        category: "monitor_diagnostic",
        message: `Monitor diagnostic unavailable: ${errorMessage(error)}`,
      });
    } catch {
      // A broken event writer cannot accept its own diagnostic; retaining the
      // committed business event is still the required fail-open boundary.
    } finally {
      this.monitorDiagnosticRecording = false;
    }
  }

  private monitorPartitionKey(): string {
    const session = this.snapshot.computerSession;
    const viewport = this.latestObservation?.viewport ?? session?.viewport;
    return session === undefined || viewport === undefined
      ? `run:${String(this.runId)}`
      : `session:${String(session.id)}|viewport:${viewport.coordinateSpace}:${viewport.width}x${viewport.height}`;
  }

  private monitorExecutionBarrier(): "unknown_outcome" | "pending_side_effect" | undefined {
    if (this.snapshot.outcome === "outcome_unknown") return "unknown_outcome";
    if (this.isAborted() || this.snapshot.pendingApproval !== undefined || this.snapshot.pendingUserQuestion !== undefined || this.snapshot.unresolvedActionId !== undefined) return "pending_side_effect";
    return undefined;
  }

  private shouldPersistMonitorProposal(proposal: MonitorPolicyProposal, output: import("./progress-monitor.js").ProgressMonitorOutput): boolean {
    if (proposal.kind === "guidance" || proposal.kind === "help_requested") return true;
    if (!output.candidate) return proposal.reason === "suppressed_by_execution_barrier";
    return proposal.reason === "candidate_observed" || proposal.reason === "shadow" || proposal.reason === "suppressed_by_execution_barrier";
  }

  private monitorProposalKey(proposal: MonitorPolicyProposal, output: import("./progress-monitor.js").ProgressMonitorOutput): string {
    const fingerprint = proposal.kind === "none" ? this.monitorPolicyState?.candidateFingerprint ?? output.eventIds.join(",") : proposal.fingerprint;
    const reason = proposal.kind === "none" ? proposal.reason : proposal.kind === "guidance" ? "guidance" : proposal.reason;
    return `${proposal.kind}:${reason}:${fingerprint}`;
  }

  private monitorProposalEvent(
    proposal: MonitorPolicyProposal,
    output: import("./progress-monitor.js").ProgressMonitorOutput,
    sourceEventId: EventId,
  ): Extract<RuntimeEventData, { type: "monitor.proposal" }> | undefined {
    const key = this.monitorProposalKey(proposal, output);
    if (key === this.monitorLastPersistedKey) return undefined;
    const fingerprint = proposal.kind === "none" ? this.monitorPolicyState?.candidateFingerprint ?? `event-${String(sourceEventId)}` : proposal.fingerprint;
    return {
      type: "monitor.proposal",
      mode: this.monitorMode === "guidance" ? "guidance" : "shadow",
      proposal: proposal.kind === "none"
        ? proposal.reason === "suppressed_by_execution_barrier" ? "suppressed_by_execution_barrier" : output.candidate ? "candidate" : "suppressed_by_execution_barrier"
        : proposal.kind,
      fingerprint,
      sourceEventIds: [...new Set([sourceEventId, ...output.eventIds])].slice(-12),
      reasonCodes: output.reasons.map((reason) => reason.code).slice(-8),
      evidenceKinds: output.evidence.map((item) => item.kind).slice(-8),
      modelDecisionCount: this.monitorWorkClock.modelDecisionCount,
      guiActionCount: this.monitorWorkClock.guiActionCount,
      ...(proposal.kind === "guidance" ? { guidanceText: proposal.text } : {}),
    };
  }

  private throwIfAborted(): void {
    if (this.abortController.signal.aborted) {
      throw this.abortController.signal.reason ?? new Error("run aborted");
    }
  }

  private isAborted(): boolean {
    return this.abortController.signal.aborted;
  }
}

function makeActionIntent(actionId: ActionId, basedOn: ObservationId | undefined, draft: GuiActionDraft): ActionIntent {
  if (draft.kind === "wait") {
    return { actionId, kind: "wait", durationMs: draft.durationMs };
  }
  if (basedOn === undefined) {
    throw new Error(`GUI action ${actionId} requires a current Observation`);
  }
  return { ...draft, actionId, basedOn } as ActionIntent;
}

function actionReceiptOutput(receipt: import("@computer-harness/protocol").ActionReceipt): JsonValue {
  const output: { actionId: string; status: string; message?: string } = {
    actionId: receipt.actionId,
    status: receipt.status,
  };
  if (receipt.message !== undefined) {
    output.message = receipt.message;
  }
  return output;
}

/** Capture failure is retryable at the approval boundary; asset/event
 * persistence failures are deliberately left as fatal Run errors. */
class ObservationCaptureError extends Error {
  public constructor(cause: unknown) {
    super(`computer observation failed: ${errorMessage(cause)}`);
    this.name = "ObservationCaptureError";
  }
}

function fingerprintObservation(
  sessionId: import("@computer-harness/protocol").ComputerSessionId,
  capture: import("@computer-harness/protocol").ObservationCapture,
): ObservationFingerprint {
  return {
    sessionId: String(sessionId),
    mediaType: capture.screenshot.mediaType,
    byteLength: capture.screenshot.data.byteLength,
    viewport: { ...capture.viewport },
    digest: createHash("sha256").update(capture.screenshot.data).digest("hex"),
  };
}

function sameObservationFingerprint(left: ObservationFingerprint, right: ObservationFingerprint): boolean {
  return left.sessionId === right.sessionId
    && left.mediaType === right.mediaType
    && left.byteLength === right.byteLength
    && left.viewport.width === right.viewport.width
    && left.viewport.height === right.viewport.height
    && left.viewport.coordinateSpace === right.viewport.coordinateSpace
    && left.digest === right.digest;
}

function sameViewport(left: ObservationFrame["viewport"], right: ObservationFrame["viewport"]): boolean {
  return left.width === right.width
    && left.height === right.height
    && left.coordinateSpace === right.coordinateSpace;
}

function approvalHumanReviewReason(reason: string, action: ActionIntent): string {
  const review = action.kind === "type" || action.kind === "keypress"
    ? "Inspect the shown current screenshot and independently verify the intended target and keyboard focus before approving this one action. The computer backend cannot verify which control has focus."
    : "Inspect the shown current screenshot and the displayed action coordinates before approving this one action.";
  return `${reason} ${review}`;
}

function pointInBox(point: { x: number; y: number }, box: GroundingBoundingBox): boolean {
  return point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height;
}

function executionEvidenceMatches(
  completion: import("@computer-harness/protocol").ExecutionSegmentStep["completion"],
  catalog: import("@computer-harness/protocol").GroundingCatalog,
): boolean {
  const expected = normalizeExecutionEvidenceText(completion.text);
  if (expected.length === 0) return false;
  return catalog.elements.some((element) => {
    const visible = normalizeExecutionEvidenceText([element.name, element.description].filter((value): value is string => value !== undefined).join(" "));
    if (!visible.includes(expected)) return false;
    if (completion.kind === "element_present") return true;
    if (completion.kind === "element_selected") return element.state?.selected === true;
    if (completion.kind === "element_expanded") return element.state?.expanded === true;
    return element.state?.focused === true;
  });
}

function normalizeExecutionEvidenceText(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]/gu, " ").replace(/\s+/gu, " ").trim().toLocaleLowerCase();
}

function executionSegmentTextMatches(queryText: string, targetText: string): boolean {
  const query = normalizeExecutionEvidenceText(queryText);
  const target = normalizeExecutionEvidenceText(targetText);
  if (query.length < 2 || target.length < 2) return false;
  if (query.includes(target) || target.includes(query)) return true;
  const targetTokens = new Set(executionSegmentTokens(target));
  const meaningfulQuery = executionSegmentTokens(query).filter((token) => !EXECUTION_SEGMENT_STOPWORDS.has(token));
  return meaningfulQuery.some((token) => targetTokens.has(token));
}

const EXECUTION_SEGMENT_STOPWORDS = new Set([
  "click", "double", "right", "open", "select", "choose", "expand", "focus", "press", "button", "control", "selector", "menu", "item", "station", "field", "option", "page", "window",
  "点击", "双击", "右键", "打开", "选择", "展开", "聚焦", "按钮", "控件", "下拉", "菜单", "项目",
]);

function executionSegmentTokens(value: string): string[] {
  const tokens: string[] = [];
  for (const match of value.matchAll(/[\p{Script=Han}]+|[^\p{Script=Han}\p{P}\p{S}\s]+/gu)) {
    const part = match[0]!;
    if (/^\p{Script=Han}+$/u.test(part)) {
      for (const size of [2, 3]) {
        if (part.length < size) continue;
        for (let index = 0; index <= part.length - size; index += 1) tokens.push(part.slice(index, index + size));
      }
    } else if (part.length >= 2) {
      tokens.push(part);
    }
  }
  return [...new Set(tokens)];
}

function boxArea(box: GroundingBoundingBox): number {
  return box.width * box.height;
}

function pointDistance(point: { x: number; y: number }, box: GroundingBoundingBox): number {
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  return Math.hypot(point.x - centerX, point.y - centerY);
}

function boundedRecoveryIntent(value: string): string | undefined {
  const normalized = value
    .replace(/[\u0000-\u001F\u007F]/gu, " ")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[redacted-email]")
    .replace(/\b1\d{10}\b/gu, "[redacted-phone]")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized.length === 0 ? undefined : normalized.slice(0, 160);
}

function boundedUIEvidence(value: string, limit: number): string {
  const normalized = value.replace(/[\u0000-\u001F\u007F]/gu, " ").replace(/\s+/gu, " ").trim();
  return normalized.slice(0, limit);
}

function groundingBoxesOverlap(
  left: GroundingBoundingBox,
  right: GroundingBoundingBox,
): number {
  const overlapWidth = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const overlapHeight = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  const intersection = overlapWidth * overlapHeight;
  const union = left.width * left.height + right.width * right.height - intersection;
  return union <= 0 ? 0 : intersection / union;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function providerErrorDetails(error: unknown): { code?: string; retryable?: boolean; retryMode?: "same_input" | "feedback" } {
  if (typeof error !== "object" || error === null) return {};
  const candidate = error as { code?: unknown; retryable?: unknown };
  return {
    ...(typeof candidate.code === "string" && candidate.code.length > 0 ? { code: candidate.code } : {}),
    ...(typeof candidate.retryable === "boolean" ? { retryable: candidate.retryable } : {}),
    ...((candidate as { retryMode?: unknown }).retryMode === "same_input" || (candidate as { retryMode?: unknown }).retryMode === "feedback"
      ? { retryMode: (candidate as { retryMode: "same_input" | "feedback" }).retryMode }
      : {}),
  };
}

function summarizeGuardAction(action: ActionIntent): import("@computer-harness/protocol").ActionGuardActionSummary {
  return action.kind === "type"
    ? { actionId: action.actionId, basedOn: action.basedOn, kind: "type", textLength: action.text.length }
    : action;
}

function isSameControlInputBatch(calls: readonly ToolCall[], entries: readonly PreflightEntry[]): boolean {
  if (entries.length !== calls.length) return false;
  const firstComputer = entries.findIndex((entry) => entry.definition?.category === "computer");
  if (firstComputer < 0) return false;
  const suffixCalls = calls.slice(firstComputer);
  const suffixEntries = entries.slice(firstComputer);
  if (suffixCalls.length < 2 || suffixCalls.length > 3 || suffixEntries.some((entry) => entry.rejection !== undefined || entry.definition?.category !== "computer")) return false;
  const names = suffixCalls.map((call) => call.name);
  const isType = (name: string) => name === "type";
  const isClick = (name: string) => name === "click";
  const isSelectAll = (call: ToolCall): boolean => {
    if (call.name !== "hotkey" || typeof call.arguments !== "object" || call.arguments === null || Array.isArray(call.arguments)) return false;
    const keys = (call.arguments as { keys?: unknown }).keys;
    return Array.isArray(keys) && keys.length === 2 && keys.every((key) => typeof key === "string") &&
      new Set(keys.map((key) => key.toUpperCase())).has("CTRL") && new Set(keys.map((key) => key.toUpperCase())).has("A");
  };
  if (names.length === 2) {
    return (isClick(names[0] ?? "") && isType(names[1] ?? "")) ||
      (isSelectAll(suffixCalls[0] as ToolCall) && isType(names[1] ?? ""));
  }

  return isClick(names[0] ?? "") && isSelectAll(suffixCalls[1] as ToolCall) && isType(names[2] ?? "");
}

/**
 * A composite turn is state-write prefix followed by GUI suffix. Read tools
 * cannot be useful before a GUI action because their result is unavailable to
 * later calls in the same model response; state writes after GUI would claim
 * facts before the post-action observation exists.
 */
function validateCompositeCallOrder(entries: readonly PreflightEntry[]): string | undefined {
  const firstComputer = entries.findIndex((entry) => entry.definition?.category === "computer");
  if (firstComputer < 0) return undefined;
  if (firstComputer > 2) return "a composite turn allows at most two Planning/Memory write calls before GUI actions";
  for (let index = 0; index < firstComputer; index += 1) {
    const definition = entries[index]?.definition;
    if (definition === undefined || definition.category === "control" || definition.category === "computer" ||
      (definition.planMutationFromResult === undefined && definition.memoryMutationFromResult === undefined && definition.executionSegmentMutationFromResult === undefined)) {
      return "only Planning/Memory/ExecutionSegment write calls may precede a GUI action; read tools must use a later ModelTurn";
    }
  }
  for (let index = firstComputer; index < entries.length; index += 1) {
    if (entries[index]?.definition?.category !== "computer") return "Planning/Memory writes cannot appear after or between GUI actions";
  }
  return undefined;
}

async function waitBeforeProviderRetry(signal: AbortSignal, retryCount: number): Promise<void> {
  const delayMs = providerRetryDelayMs(retryCount);
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("run aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("run aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  }

function providerRetryDelayMs(retryCount: number): number {
  return Math.min(
    PROVIDER_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, retryCount - 1)),
    PROVIDER_RETRY_DELAY_CAP_MS,
  );
}


function providerFailureMessage(error: unknown, retry: boolean, attempt: number): string {
  const reason = errorMessage(error);
  if (retry) return `${reason}; no tool was executed; retrying model request ${attempt}/${MAX_PROVIDER_RETRIES}`;
  const details = providerErrorDetails(error);
  return details.retryable === true && attempt > MAX_PROVIDER_RETRIES
    ? `${reason}; no tool was executed; retry limit reached after ${MAX_PROVIDER_RETRIES} retries`
    : reason;
}

function addProviderRetryFeedback(
  context: ModelInput,
  error: unknown,
  retryCount: number,
  maxRetries: number,
): ModelInput {
  const details = providerErrorDetails(error);
  const code = details.code === undefined ? "" : `[${details.code}] `;
  const feedback: ModelMessage = {
    role: "user",
    content: [{
      type: "text",
      text: `The previous model response was rejected before any tool was executed. Reason: ${code}${errorMessage(error)}. This is retry ${retryCount}/${maxRetries}; return one valid response that matches the supplied provider contract. Do not repeat the rejected representation or assume that any tool was executed.`,
    }],
  };
  return { ...context, messages: [...context.messages, feedback] };
}

