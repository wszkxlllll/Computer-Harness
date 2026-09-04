import type {
  ActionId,
  ActionIntent,
  AssetId,
  EventId,
  JsonValue,
  ModelTurn,
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
  RuntimePolicy,
  ToolDefinition,
  ToolExecutionContext,
  ToolPolicyDecision,
} from "./contracts.js";
import { randomIdFactory, systemClock } from "./defaults.js";
import { validateActionIntent } from "./action-validation.js";
import { ToolRegistry } from "./tool-registry.js";

const MAX_PROVIDER_RETRIES = 3;
export interface RunControllerDependencies {
  runId: RunId;
  provider: ProviderAdapter;
  computer: Computer;
  contextCompiler: ContextCompiler;
  toolRegistry: ToolRegistry;
  policy: RuntimePolicy;
  eventWriter: RunEventWriter;
  assetStore: AssetStore;
  clock?: Clock;
  idFactory?: IdFactory;
  computerOpenOptions?: ComputerOpenOptions;
  onCleanupError?: (diagnostic: CleanupDiagnostic) => void;
}

export type CleanupOperation = "event_writer.flush" | "event_writer.close" | "computer.close";

export interface CleanupDiagnostic {
  operation: CleanupOperation;
  message: string;
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
}

type PreflightEntry = {
  call: ToolCall;
  definition?: ToolDefinition;
  decision?: ToolPolicyDecision;
  rejection?: string;
};

interface PendingToolTurn {
  session: ComputerSession;
  entries: readonly PreflightEntry[];
  nextIndex: number;
  invalidated: boolean;
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
  private readonly eventWriter: RunEventWriter;
  private readonly assetStore: AssetStore;
  private readonly clock: Clock;
  private readonly idFactory: IdFactory;
  private readonly computerOpenOptions: ComputerOpenOptions;
  private readonly onCleanupError: ((diagnostic: CleanupDiagnostic) => void) | undefined;
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
  private pendingToolTurn: PendingToolTurn | undefined;
  private pendingModelTurn: { turn: ModelTurn; invalidated?: boolean } | undefined;
  private pendingReobserve = false;

  public constructor(dependencies: RunControllerDependencies) {
    this.runId = dependencies.runId;
    this.provider = dependencies.provider;
    this.computer = dependencies.computer;
    this.contextCompiler = dependencies.contextCompiler;
    this.toolRegistry = dependencies.toolRegistry;
    this.policy = dependencies.policy;
    this.eventWriter = dependencies.eventWriter;
    this.assetStore = dependencies.assetStore;
    this.clock = dependencies.clock ?? systemClock;
    this.idFactory = dependencies.idFactory ?? randomIdFactory;
    this.computerOpenOptions = dependencies.computerOpenOptions ?? {};
    this.onCleanupError = dependencies.onCleanupError;
    this.snapshot = {
      runId: this.runId,
      status: "created",
      stepCount: 0,
      modelRequestCount: 0,
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

  private async run(goal: string): Promise<RunOutcome> {
    let session: ComputerSession | undefined;
    let outcome: RunOutcome = "failed";
    try {
      await this.commitEvent({ type: "run.created", goal });
      this.throwIfAborted();
      await this.commitEvent({ type: "run.started" });
      await this.commitEvent({ type: "computer.open.started" });
      session = await this.computer.open(this.computerOpenOptions, this.abortController.signal);
      await this.commitEvent({ type: "computer.open.completed", session });
      await this.observeAndCommit(session);

      while (this.snapshot.status !== "finished") {
        if (this.snapshot.status === "paused" || this.snapshot.status === "waiting_user" || this.snapshot.status === "waiting_approval") {
          await this.waitForControlCommand();
          if ((this.snapshot.status as string) === "running") {
            // A resume can release the waiter before a correction enqueued in
            // the same user turn is drained.  Apply queued control commands
            // before consuming any deferred decision or tool turn.
            await this.drainCommands();
            await this.refreshAfterUserInput(session);
          }
          if (this.pendingApproval !== undefined) {
            const pending = this.pendingApproval;
            this.pendingApproval = undefined;
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
              goal,
              recentEvents: this.events,
              ...(this.latestObservation === undefined ? {} : { latestObservation: this.latestObservation }),
            },
            this.abortController.signal,
          );
          this.throwIfAborted();
          let requestContext = context;
          let retryCount = 0;
          let providerFailed = false;
          turn = undefined;
          while (turn === undefined) {
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
            await this.commitEvent({ type: "model.request.started", providerId: this.provider.id });
            try {
              turn = await this.provider.generate(requestContext, { signal: this.abortController.signal });
            } catch (error) {
              const details = providerErrorDetails(error);
              const retry = !this.isAborted() && details.retryable === true && retryCount < MAX_PROVIDER_RETRIES;
              await this.commitEvent({
                type: "model.request.failed",
                category: this.isAborted() ? "cancelled" : "provider",
                message: providerFailureMessage(error, retry, retryCount + 1),
                ...details,
              });
              if (!retry) {
                outcome = this.isAborted() ? "cancelled" : "failed";
                providerFailed = true;
                break;
              }
              retryCount += 1;
              requestContext = addProviderRetryFeedback(context, error, retryCount, MAX_PROVIDER_RETRIES);
            }
          }
          if (providerFailed || turn === undefined) {
            break;
          }

          this.throwIfAborted();
          await this.commitEvent({ type: "model.response.received", turn });
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
          await this.commitEvent({
            type: "run.finished",
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
        await this.commitEvent({ type: "run.finished", outcome });
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
        await this.commitEvent({ type: "run.finished", outcome });
      }
      return outcome;
    } finally {
      this.commandInbox.close();
      try {
        await this.eventWriter.flush();
      } catch (error) {
        this.reportCleanupError({ operation: "event_writer.flush", message: errorMessage(error) });
      }
      try {
        await this.eventWriter.close();
      } catch (error) {
        this.reportCleanupError({ operation: "event_writer.close", message: errorMessage(error) });
      }
      if (session !== undefined) {
        try {
          await this.computer.close(session);
        } catch (error) {
          this.reportCleanupError({ operation: "computer.close", message: errorMessage(error) });
        }
      }
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
        if (this.snapshot.status === "waiting_approval") {
          throw new Error("user input cannot bypass pending approval");
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
      await this.executeComputerCall(pending.call, pending.definition, context);
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
      const definition = this.toolRegistry.get(call.name);
      if (definition === undefined) {
        preflight.push({ call, rejection: `unknown tool: ${call.name}` });
        continue;
      }
      try {
        definition.validate(call.arguments);
      } catch (error) {
        preflight.push({ call, definition, rejection: `invalid arguments: ${errorMessage(error)}` });
        continue;
      }
      const decision = await this.policy.evaluateToolCall({ call, tool: definition, snapshot: this.snapshot });
      if (decision.decision === "allow") {
        preflight.push({ call, definition, decision });
      } else if (decision.decision === "require_approval") {
        preflight.push({ call, definition, decision });
      } else {
        preflight.push({ call, definition, rejection: decision.reason });
      }
    }

    const computerCount = preflight.filter(
      (entry) => entry.rejection === undefined && entry.definition?.category === "computer",
    ).length;
    const hasApproval = preflight.some(
      (entry) => entry.rejection === undefined && entry.decision?.decision === "require_approval",
    );
    const groupRejection =
      computerCount > 1
        ? "a ModelTurn may contain at most one computer ToolCall"
        : preflight.find((entry) => entry.rejection !== undefined)?.rejection
          ?? (hasApproval && calls.length > 1 ? "approval cannot be combined with other ToolCalls in one turn" : undefined);

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
        };
      } else {
        await this.rejectPendingEntries(preflight, 0, "superseded by user correction");
      }
      return effects;
    }
    if (this.snapshot.status === "paused") {
      this.pendingToolTurn = { session, entries: preflight, nextIndex: 0, invalidated: false };
      return effects;
    }
    return this.executePendingEntries({ session, entries: preflight, nextIndex: 0, invalidated: false });
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
        await this.executeComputerCall(entry.call, entry.definition, context);
      } else {
        await this.executeNonComputerCall(entry.call, entry.definition, context);
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
  ): Promise<void> {
    this.throwIfAborted();
    const draft = definition.toAction(call.arguments, context);
    this.throwIfAborted();
    const action = makeActionIntent(this.idFactory.actionId(), this.snapshot.latestObservationId, draft);
    try {
      validateActionIntent(action, {
        capabilities: context.session.capabilities,
        ...(this.latestObservation === undefined ? {} : { observation: this.latestObservation }),
      });
    } catch (error) {
      // Deterministic GUI contract violations are a rejected ToolCall, not a
      // runtime crash. The model can observe the rejection and replan without
      // any action.proposed or driver side effect being recorded.
      await this.rejectToolCall(call.id, `invalid GUI action: ${errorMessage(error)}`);
      return;
    }
    if (this.callStates.get(call.id) !== "received") {
      throw new Error(`ToolCall ${call.id} is not available for action proposal`);
    }
    if (this.actionCallIds.has(action.actionId)) {
      throw new Error(`ActionId ${action.actionId} was already proposed`);
    }
    await this.commitEvent({ type: "action.proposed", callId: call.id, action });
    this.callStates.set(call.id, "proposed");
    this.actionCallIds.set(action.actionId, call.id);
    if (this.actionCallIds.get(action.actionId) !== call.id) {
      throw new Error(`action ${action.actionId} is not linked to ToolCall ${call.id}`);
    }
    this.throwIfAborted();
    await this.commitEvent({ type: "action.execution.started", action });
    this.callStates.set(call.id, "executing");

    let receipt: import("@computer-harness/protocol").ActionReceipt;
    try {
      receipt = await this.computer.execute(context.session, action, this.abortController.signal);
    } catch (error) {
      await this.commitEvent({
        type: "runtime.error",
        category: "unknown_side_effect",
        message: errorMessage(error),
      });
      await this.commitEvent({ type: "run.finished", outcome: "outcome_unknown" });
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

function providerErrorDetails(error: unknown): { code?: string; retryable?: boolean } {
  if (typeof error !== "object" || error === null) return {};
  const candidate = error as { code?: unknown; retryable?: unknown };
  return {
    ...(typeof candidate.code === "string" && candidate.code.length > 0 ? { code: candidate.code } : {}),
    ...(typeof candidate.retryable === "boolean" ? { retryable: candidate.retryable } : {}),
  };
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

