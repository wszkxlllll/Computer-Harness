import type {
  ActionId,
  ActionIntent,
  AssetId,
  EventId,
  JsonValue,
  ModelTurn,
  MemoryMutation,
  MemoryFact,
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
  /** Total wall-clock budget shared by event-writer and Computer cleanup. */
  cleanupDeadlineMs?: number;
  onCleanupError?: (diagnostic: CleanupDiagnostic) => void;
  /**
   * Optional append-after-reduce notification. Observers are read-only and
   * are isolated from the run when their callback throws.
   */
  onEventCommitted?: CommittedEventListener;
}

export type CleanupOperation = "event_writer.flush" | "event_writer.close" | "computer.close";
export type CleanupDiagnosticStatus = "timed_out";

export interface CleanupDiagnostic {
  operation: CleanupOperation;
  message: string;
  status?: CleanupDiagnosticStatus;
}

type CallState = "received" | "proposed" | "executing" | "completed" | "failed" | "rejected";

type RuntimeCommand =
  | {
      kind: "user_input";
      text: string;
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
}

interface PreparedComputerAction {
  action: ActionIntent;
  decisionObservationId?: ObservationId;
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
  private readonly features: RunFeatureConfig;
  private readonly cleanupDeadlineMs: number;
  private readonly abortController = new AbortController();
  private readonly events: RuntimeEvent[] = [];
  private readonly callStates = new Map<ToolCallId, CallState>();
  private readonly actionCallIds = new Map<ActionId, ToolCallId>();
  private readonly commandInbox = new CommandInbox();
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
  private sessionMemoryScopeEnded = false;

  public constructor(dependencies: RunControllerDependencies) {
    this.runId = dependencies.runId;
    this.provider = dependencies.provider;
    this.computer = dependencies.computer;
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
    this.features = dependencies.features ?? {
      planning: this.enabledCategories.has("planning") ? "tasks-v1" : "off",
      memory: this.enabledCategories.has("side") ? "facts-v1" : "off",
      batching: this.batching,
    };
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

  public submitUserInput(text: string): Promise<void> {
    if (text.trim().length === 0) {
      return Promise.reject(new Error("submitUserInput requires non-empty text"));
    }
    return this.enqueueCommand((resolve, reject) => ({
      kind: "user_input",
      text,
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
      const restrictedToolNames = restrictToolNamesForCapabilities(this.toolRegistry, session.capabilities, this.enabledToolNames === undefined ? undefined : [...this.enabledToolNames]);
      this.enabledToolNames = restrictedToolNames === undefined ? undefined : new Set(restrictedToolNames);
      await this.commitEvent({ type: "computer.open.completed", session });
      await this.observeAndCommit(session);

      while (this.snapshot.status !== "finished") {
        if (this.snapshot.status === "paused" || this.snapshot.status === "waiting_user" || this.snapshot.status === "waiting_approval") {
          await this.waitForControlCommand();
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
          const context = await this.contextCompiler.compile(
            {
              runId: this.runId,
              goal,
              recentEvents: this.events,
              enabledCategories: [...this.enabledCategories],
              ...(this.planningEnabled ? { plan: this.snapshot.plan } : {}),
              ...(this.memoryEnabled ? { memory: this.snapshot.memory } : {}),
              ...(this.enabledToolNames === undefined ? {} : { enabledToolNames: [...this.enabledToolNames] }),
              features: this.features,
              ...(this.latestObservation === undefined ? {} : { latestObservation: this.latestObservation }),
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
          await this.commitRunFinished({
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
        await this.commitRunFinished({ outcome });
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
        await this.commitRunFinished({ outcome });
      }
      return outcome;
    } finally {
      this.commandInbox.close();
      await this.cleanup(session);
    }
  }

  private async cleanup(session: ComputerSession | undefined): Promise<void> {
    const deadline = Date.now() + this.cleanupDeadlineMs;
    await this.cleanupOperation("event_writer.flush", () => this.eventWriter.flush(), deadline);
    await this.cleanupOperation("event_writer.close", () => this.eventWriter.close(), deadline);
    if (session !== undefined) {
      await this.cleanupOperation("computer.close", () => this.computer.close(session), deadline, () => {
        cleanupPendingComputers.add(this.computer);
      });
    }
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
      if (operation === "computer.close") cleanupPendingComputers.add(this.computer);
      this.reportCleanupError({ operation, message: errorMessage(result.error) });
      return;
    }
    onTimeout?.();
    this.reportCleanupError({ operation, message: `cleanup deadline exceeded during ${operation}`, status: "timed_out" });
    if (operation === "computer.close") {
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
    switch (command.kind) {
      case "user_input":
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
    }
  }

  private async executeApprovedCall(pending: PendingApproval): Promise<void> {
    const context: ToolExecutionContext = {
      runId: this.runId,
      session: pending.session,
      signal: this.abortController.signal,
      ...(this.latestObservation === undefined ? {} : { observation: this.latestObservation }),
    };
    if (pending.definition.category === "computer") {
      if (pending.preparedAction !== undefined) {
        const originalId = pending.preparedAction.decisionObservationId;
        if (originalId !== undefined && this.snapshot.latestObservationId !== originalId) {
          await this.rejectToolCall(pending.call.id, "approval context was superseded inside the Harness; observe the current screen and propose the action again");
          return;
        }
      }
      await this.executeComputerCall(pending.call, pending.definition, context, undefined, pending.preparedAction);
    } else if (pending.definition.category === "control") {
      await this.rejectToolCall(pending.call.id, "control decisions must be mapped by the Provider, not executed as tools");
    } else {
      await this.executeNonComputerCall(pending.call, pending.definition, context);
    }
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
        ...(this.latestObservation === undefined ? {} : { observation: this.latestObservation }),
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
        const requestId = this.idFactory.eventId();
        await this.commitEvent({ type: "approval.requested", requestId, callId: entry.call.id, reason: guardDecision.reason });
        this.pendingApproval = { requestId, call: entry.call, definition: entry.definition, session, preparedAction: entry.preparedAction };
        return { correction: false };
      }
    }

    const approvalEntry = preflight.find(
      (entry) => entry.rejection === undefined && entry.decision?.decision === "require_approval",
    );
    if (approvalEntry !== undefined && approvalEntry.definition !== undefined && approvalEntry.decision?.decision === "require_approval") {
      const requestId = this.idFactory.eventId();
      await this.commitEvent({
        type: "approval.requested",
        requestId,
        callId: approvalEntry.call.id,
        reason: approvalEntry.decision.reason,
      });
      this.pendingApproval = {
        requestId,
        call: approvalEntry.call,
        definition: approvalEntry.definition,
        session,
        ...(approvalEntry.preparedAction === undefined ? {} : { preparedAction: approvalEntry.preparedAction }),
      };
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
        ...(this.latestObservation === undefined ? {} : { observation: this.latestObservation }),
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
        await this.executeComputerCall(entry.call, entry.definition, context, pendingTurn.decisionObservationId, entry.preparedAction);
      } else if (entry.definition.category === "control") {
        await this.rejectToolCall(entry.call.id, "control decisions must be mapped by the Provider, not executed as tools");
      } else {
        await this.executeNonComputerCall(entry.call, entry.definition, context);
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
          await this.commitEvent({ type: "memory.updated", callId: call.id, mutation });
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
  ): Promise<void> {
    this.throwIfAborted();
    const executionObservationId = this.snapshot.latestObservationId;
    let candidate: PreparedComputerAction;
    try {
      candidate = prepared ?? this.prepareComputerAction(call, definition, context, decisionObservationId);
      const action = candidate.action;
      validateActionIntent(action, {
        capabilities: context.session.capabilities,
        ...(this.latestObservation === undefined ? {} : { observation: this.latestObservation }),
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
    this.callStates.set(call.id, "executing");

    let receipt: import("@computer-harness/protocol").ActionReceipt;
    try {
      const executeOptions: ComputerExecuteOptions = executionObservationId === undefined ? {} : { executionObservationId };
      receipt = await this.computer.execute(context.session, action, this.abortController.signal, executeOptions);
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

    if (receipt.status === "completed") {
      await this.commitEvent({ type: "action.execution.completed", receipt });
    } else {
      await this.commitEvent({ type: "action.execution.failed", receipt });
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
    }
    // The action and ToolCall facts are durable before taking the follow-up
    // observation. If observing the post-action state fails, the Run can be
    // marked failed without leaving a completed action with a dangling call.
    await this.observeAndCommit(context.session);
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
    validateActionIntent(action, {
      capabilities: context.session.capabilities,
      ...(this.latestObservation === undefined ? {} : { observation: this.latestObservation }),
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
    const capture = await this.computer.observe(session, observationId, this.abortController.signal);
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
    };
    const persisted = await this.commitEvent({ type: "observation.created", observation });
    if (persisted.type !== "observation.created") {
      throw new Error("observation commit returned an unexpected event type");
    }
    this.latestObservation = persisted.observation;
    return persisted.observation;
  }

  private async commitRunFinished(data: { outcome: RunOutcome; summary?: string; reportedStatus?: "success" | "failure" }): Promise<void> {
    await this.markSessionMemoryScopeEnded();
    await this.commitEvent({
      type: "run.finished",
      outcome: data.outcome,
      ...(data.summary === undefined ? {} : { summary: data.summary }),
      ...(data.reportedStatus === undefined ? {} : { reportedStatus: data.reportedStatus }),
    });
  }

  private async markSessionMemoryScopeEnded(): Promise<void> {
    if (this.sessionMemoryScopeEnded || !this.memoryEnabled || this.snapshot.computerSession === undefined) return;
    this.sessionMemoryScopeEnded = true;
    const sessionId = this.snapshot.computerSession.id;
    const facts = this.snapshot.memory.facts.filter((fact) => {
      const scope = memoryFactScope(fact);
      return scope.kind === "computer_session" && scope.sessionId === sessionId && fact.status !== "superseded";
    });
    for (const fact of facts) {
      const mutation: MemoryMutation = { operation: "mark_fact_needs_check", factId: fact.id, reason: "scope_ended" };
      await this.commitEvent({ type: "memory.updated", callId: "runtime:scope-ended" as ToolCallId, mutation });
      await this.memoryMutationApplier?.(this.runId, mutation);
    }
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
    return persisted;
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
      (definition.planMutationFromResult === undefined && definition.memoryMutationFromResult === undefined)) {
      return "only Planning/Memory write calls may precede a GUI action; read tools must use a later ModelTurn";
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

