import { randomUUID } from "node:crypto";
import type {
  ActionId,
  ActionIntent,
  AssetId,
  ComputerCapabilities,
  ComputerSessionId,
  JsonValue,
  ModelTurn,
  ObservationCapture,
  ObservationFrame,
  ObservationId,
  Point,
  RunId,
  RunOutcome,
  RuntimeEvent,
  RuntimeEventData,
  ToolCall,
  ToolCallId,
  ToolResult,
  Viewport,
} from "@computer-harness/protocol";
import {
  type AssetStore,
  type RunEventWriter,
  type RunSnapshot,
  reduceRunEvent,
} from "@computer-harness/trajectory";

export interface ComputerSession {
  id: ComputerSessionId;
  backend: string;
  status: "opening" | "ready" | "closing" | "closed" | "failed";
  viewport: Viewport;
  capabilities: ComputerCapabilities;
  openedAt: string;
}

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
  ): Promise<import("@computer-harness/protocol").ActionReceipt>;
  close(session: ComputerSession): Promise<void>;
}

export interface ModelToolSpec {
  name: string;
  description: string;
  inputSchema?: JsonValue;
}

export type ModelContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; asset: ObservationFrame["screenshot"] }
  | { type: "tool_result"; result: ToolResult };

export interface ModelMessage {
  role: "user" | "assistant" | "tool";
  content: ModelContentBlock[];
}

export interface ModelInput {
  system: string;
  messages: ModelMessage[];
  tools: ModelToolSpec[];
}

export interface ProviderProgressEvent {
  type: string;
  message?: string;
}

export interface ProviderAdapter {
  readonly id: string;
  generate(
    input: ModelInput,
    options: {
      signal: AbortSignal;
      onEvent?: (event: ProviderProgressEvent) => void;
    },
  ): Promise<ModelTurn>;
}

export interface ContextCompileInput {
  goal: string;
  snapshot: RunSnapshot;
  latestObservation?: ObservationFrame;
  recentEvents: readonly RuntimeEvent[];
  toolResults: readonly ToolResult[];
}

export interface ContextCompiler {
  compile(input: ContextCompileInput): Promise<ModelInput>;
}

export type ToolCategory = "computer" | "planning" | "control" | "side";

export type GuiActionDraft =
  | { kind: "click"; point: Point }
  | { kind: "double_click"; point: Point }
  | { kind: "right_click"; point: Point }
  | { kind: "type"; text: string }
  | { kind: "keypress"; keys: string[] }
  | { kind: "scroll"; deltaX: number; deltaY: number }
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
  inputSchema?: JsonValue;
  validate?: (args: JsonValue) => void;
}

export interface ComputerToolDefinition extends ToolDefinitionBase {
  category: "computer";
  toAction: (args: JsonValue, context: ToolExecutionContext) => GuiActionDraft;
}

export interface NonComputerToolDefinition extends ToolDefinitionBase {
  category: Exclude<ToolCategory, "computer">;
  execute: (args: JsonValue, context: ToolExecutionContext) => Promise<JsonValue>;
}

export type ToolDefinition = ComputerToolDefinition | NonComputerToolDefinition;

export class ToolRegistry {
  private readonly definitions = new Map<string, ToolDefinition>();

  public register(definition: ToolDefinition): void {
    if (this.definitions.has(definition.name)) {
      throw new Error(`tool already registered: ${definition.name}`);
    }
    this.definitions.set(definition.name, definition);
  }

  public get(name: string): ToolDefinition | undefined {
    return this.definitions.get(name);
  }

  public list(): readonly ToolDefinition[] {
    return [...this.definitions.values()];
  }

  public modelTools(): ModelToolSpec[] {
    return this.list().map((definition) => {
      const base: ModelToolSpec = {
        name: definition.name,
        description: definition.description,
      };
      if (definition.inputSchema !== undefined) {
        base.inputSchema = definition.inputSchema;
      }
      return base;
    });
  }
}

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
  canFinish(snapshot: RunSnapshot): FinishDecision;
}

export class DefaultRuntimePolicy implements RuntimePolicy {
  public constructor(private readonly maxSteps = 100) {}

  public async evaluateToolCall(_context: PolicyContext): Promise<ToolPolicyDecision> {
    return { decision: "allow" };
  }

  public checkBudget(snapshot: RunSnapshot): BudgetDecision {
    if (snapshot.stepCount >= this.maxSteps) {
      return { allowed: false, reason: `step budget exhausted at ${this.maxSteps}` };
    }
    return { allowed: true };
  }

  public canFinish(_snapshot: RunSnapshot): FinishDecision {
    return { allowed: true };
  }
}

export class DefaultContextCompiler implements ContextCompiler {
  public constructor(private readonly tools: ToolRegistry) {}

  public async compile(input: ContextCompileInput): Promise<ModelInput> {
    const messages: ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: input.goal }] },
    ];
    if (input.latestObservation !== undefined) {
      messages.push({
        role: "user",
        content: [{ type: "image", asset: input.latestObservation.screenshot }],
      });
    }
    for (const result of input.toolResults) {
      messages.push({ role: "tool", content: [{ type: "tool_result", result }] });
    }
    return {
      system: "You are a GUI agent. Use the available tools and finish only when the task is complete.",
      messages,
      tools: this.tools.modelTools(),
    };
  }
}

export interface Clock {
  now(): string;
}

export interface IdFactory {
  eventId(): import("@computer-harness/protocol").EventId;
  observationId(): ObservationId;
  assetId(): AssetId;
  actionId(): ActionId;
}

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
};

export const randomIdFactory: IdFactory = {
  eventId: () => randomUUID() as import("@computer-harness/protocol").EventId,
  observationId: () => randomUUID() as ObservationId,
  assetId: () => randomUUID() as AssetId,
  actionId: () => randomUUID() as ActionId,
};

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
}

type CallState = "received" | "proposed" | "executing" | "completed" | "failed" | "rejected";

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
  private readonly abortController = new AbortController();
  private readonly events: RuntimeEvent[] = [];
  private readonly callStates = new Map<ToolCallId, CallState>();
  private readonly actionCallIds = new Map<ActionId, ToolCallId>();
  private readonly toolResults: ToolResult[] = [];
  private snapshot: RunSnapshot;
  private latestObservation: ObservationFrame | undefined;
  private nextSequence = 0;
  private startPromise: Promise<RunOutcome> | undefined;
  private started = false;

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
    this.snapshot = {
      runId: this.runId,
      status: "created",
      stepCount: 0,
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
    this.startPromise = this.run(goal);
    return this.startPromise;
  }

  public cancel(reason = "cancelled by caller"): void {
    this.abortController.abort(new Error(reason));
  }

  public getSnapshot(): RunSnapshot {
    return this.snapshot;
  }

  public getEvents(): readonly RuntimeEvent[] {
    return this.events;
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
      await this.commitEvent({ type: "computer.open.completed", computerSessionId: session.id });
      await this.observeAndCommit(session);

      while (this.snapshot.status === "running") {
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

        const context = await this.contextCompiler.compile({
          goal,
          snapshot: this.snapshot,
          recentEvents: this.events,
          toolResults: this.toolResults,
          ...(this.latestObservation === undefined ? {} : { latestObservation: this.latestObservation }),
        });
        await this.commitEvent({ type: "model.request.started", providerId: this.provider.id });

        let turn: ModelTurn;
        try {
          turn = await this.provider.generate(context, { signal: this.abortController.signal });
        } catch (error) {
          await this.commitEvent({
            type: "model.request.failed",
            category: this.isAborted() ? "cancelled" : "provider",
            message: errorMessage(error),
          });
          outcome = this.isAborted() ? "cancelled" : "failed";
          break;
        }

        await this.commitEvent({ type: "model.response.received", turn });
        if (turn.type === "finish") {
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
          outcome = "succeeded";
          break;
        }
        if (turn.type === "user_input_required") {
          throw new Error("user input is not implemented in S2-2; defer to S2-3");
        }
        await this.processToolCalls(session, turn.calls);
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
      try {
        await this.eventWriter.flush();
      } finally {
        await this.eventWriter.close().catch(() => undefined);
        if (session !== undefined) {
          await this.computer.close(session).catch(() => undefined);
        }
      }
    }
  }

  private async processToolCalls(session: ComputerSession, calls: readonly ToolCall[]): Promise<void> {
    if (calls.length === 0) {
      throw new Error("model returned an empty tool_calls turn");
    }
    for (const call of calls) {
      if (this.callStates.has(call.id)) {
        throw new Error(`duplicate ToolCall id: ${call.id}`);
      }
      this.callStates.set(call.id, "received");
      await this.commitEvent({ type: "tool.call.received", call });
    }

    const definitions = calls.map((call) => this.toolRegistry.get(call.name));
    const computerCount = definitions.filter((definition) => definition?.category === "computer").length;
    if (computerCount > 1) {
      for (const call of calls) {
        await this.rejectToolCall(call.id, "a ModelTurn may contain at most one computer ToolCall");
      }
      return;
    }

    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index];
      const definition = definitions[index];
      if (call === undefined) {
        continue;
      }
      if (definition === undefined) {
        await this.rejectToolCall(call.id, `unknown tool: ${call.name}`);
        continue;
      }
      try {
        definition.validate?.(call.arguments);
      } catch (error) {
        await this.rejectToolCall(call.id, `invalid arguments: ${errorMessage(error)}`);
        continue;
      }
      const decision = await this.policy.evaluateToolCall({
        call,
        tool: definition,
        snapshot: this.snapshot,
      });
      if (decision.decision === "deny") {
        await this.rejectToolCall(call.id, decision.reason);
        continue;
      }
      if (decision.decision === "require_approval") {
        await this.commitEvent({
          type: "approval.requested",
          requestId: this.idFactory.eventId(),
          callId: call.id,
          reason: decision.reason,
        });
        throw new Error("approval handling is not implemented in S2-2; defer to S2-3");
      }
      const context: ToolExecutionContext = {
        runId: this.runId,
        session,
        signal: this.abortController.signal,
        ...(this.latestObservation === undefined ? {} : { observation: this.latestObservation }),
      };
      if (definition.category === "computer") {
        await this.executeComputerCall(call, definition, context);
      } else {
        await this.executeNonComputerCall(call, definition, context);
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
      this.toolResults.push(result);
      this.callStates.set(call.id, "completed");
    } catch (error) {
      const result: ToolResult = {
        callId: call.id,
        status: "failed",
        error: { code: "TOOL_FAILED", message: errorMessage(error) },
      };
      await this.commitEvent({ type: "tool.call.failed", result });
      this.toolResults.push(result);
      this.callStates.set(call.id, "failed");
    }
  }

  private async executeComputerCall(
    call: ToolCall,
    definition: ComputerToolDefinition,
    context: ToolExecutionContext,
  ): Promise<void> {
    const draft = definition.toAction(call.arguments, context);
    const action = makeActionIntent(this.idFactory.actionId(), this.snapshot.latestObservationId, draft);
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
    await this.observeAndCommit(context.session);
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
    this.toolResults.push(result);
  }

  private async rejectToolCall(callId: ToolCallId, reason: string): Promise<void> {
    const result: ToolResult = {
      callId,
      status: "rejected",
      error: { code: "TOOL_REJECTED", message: reason },
    };
    await this.commitEvent({ type: "tool.call.rejected", callId, reason });
    this.toolResults.push(result);
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
    await this.commitEvent({ type: "observation.created", observation });
    this.latestObservation = observation;
    return observation;
  }

  private async commitEvent(data: RuntimeEventData): Promise<RuntimeEvent> {
    const draft = {
      ...data,
      runId: this.runId,
      eventId: this.idFactory.eventId(),
      occurredAt: this.clock.now(),
    } as import("@computer-harness/protocol").RuntimeEventDraft;
    const candidate = { ...draft, sequence: this.nextSequence } as RuntimeEvent;
    const nextSnapshot = reduceRunEvent(this.snapshot, candidate);
    const persisted = await this.eventWriter.append(draft);
    if (
      persisted.eventId !== candidate.eventId ||
      persisted.runId !== candidate.runId ||
      persisted.sequence !== candidate.sequence
    ) {
      throw new Error(`event writer returned an unexpected event boundary at sequence ${candidate.sequence}`);
    }
    this.snapshot = nextSnapshot;
    this.events.push(persisted);
    this.nextSequence += 1;
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
