import type {
  ModelContentBlock,
  ModelInput,
  ModelMessage,
  ContextCompileInput,
  ContextCompiler,
  ContextBudgetReport,
  RunFeatureConfig,
} from "@computer-harness/runtime";
import { decorateToolsWithActionEffects } from "@computer-harness/runtime";
import type { PlanState, RuntimeEvent, ToolCallId, ToolResult } from "@computer-harness/protocol";
import type { MemoryEntity, MemoryFact, MemoryState } from "@computer-harness/protocol";
import { ToolRegistry } from "@computer-harness/runtime";

export interface DefaultContextCompilerOptions {
  systemPrompt?: string;
  mode?: "raw" | "recent";
  maxHistoryEvents?: number;
  maxInputTokens?: number;
  features?: RunFeatureConfig;
}

export interface MemoryRecallLimits {
  maxIndexFacts?: number;
  maxIndexEntities?: number;
  maxHotFacts?: number;
  maxHotEntities?: number;
}

export interface MemoryContextSelection {
  indexFacts: readonly MemoryFact[];
  indexEntities: readonly MemoryEntity[];
  hotFacts: readonly MemoryFact[];
  hotEntities: readonly MemoryEntity[];
}

/**
 * The deliberately small, provider-neutral context projection used by V1.
 * It derives history from RuntimeEvents rather than maintaining a second
 * ToolResult or Snapshot authority.
 */
export class DefaultContextCompiler implements ContextCompiler {
  private readonly systemPrompt: string;
  private readonly mode: "raw" | "recent";
  private readonly maxHistoryEvents: number;
  private readonly maxInputTokens: number | undefined;
  private readonly features: RunFeatureConfig;

  public constructor(
    private readonly tools: ToolRegistry,
    options: DefaultContextCompilerOptions = {},
  ) {
    this.systemPrompt = options.systemPrompt ??
      "You are a GUI agent. Use the available tools and finish only when the task is complete. Do not claim completion before the requested state is visible. Observe is automatic. Follow the selected Provider's coordinate-unit instructions for the current image. type and keypress act on the current focus; hotkey is for a simultaneous shortcut. Never invent a tool result.";
    this.mode = options.mode ?? "raw";
    this.maxHistoryEvents = options.maxHistoryEvents ?? 80;
    if (!Number.isInteger(this.maxHistoryEvents) || this.maxHistoryEvents < 1) {
      throw new Error("maxHistoryEvents must be a positive integer");
    }
    this.maxInputTokens = options.maxInputTokens;
    if (this.maxInputTokens !== undefined && (!Number.isInteger(this.maxInputTokens) || this.maxInputTokens < 1)) {
      throw new Error("maxInputTokens must be a positive integer");
    }
    this.features = options.features ?? { planning: "tasks-v1", memory: "facts-v1", batching: "off" };
  }

  public async compile(input: ContextCompileInput, signal: AbortSignal): Promise<ModelInput> {
    signal.throwIfAborted();
    const orderedEvents = [...input.recentEvents].sort((left, right) => left.sequence - right.sequence);
    const features = input.features ?? this.features;
    const baseTools = this.tools.modelTools("main", {
      ...(input.enabledCategories === undefined ? {} : { enabledCategories: input.enabledCategories }),
      ...(input.enabledToolNames === undefined ? {} : { enabledToolNames: input.enabledToolNames }),
    });
    const tools = features.riskGuard === "layered" ? decorateToolsWithActionEffects(baseTools) : baseTools;
    const systemPrompt = composeSystemPrompt(this.systemPrompt, features);
    const fixedText = [
      systemPrompt,
      input.goal,
      JSON.stringify(tools),
      ...(features.planning !== "off" && input.plan !== undefined && input.plan.tasks.length > 0 ? [formatPlan(input.plan)] : []),
      ...(features.memory !== "off" && input.memory !== undefined ? [formatMemory(input.memory, input.plan) ?? ""] : []),
    ].join("\n");
    const estimatedFixedTextTokens = Math.ceil(fixedText.length / 4);
    let selectedEvents = selectHistoryEvents(orderedEvents, input.context?.mode ?? this.mode, input.context?.maxHistoryEvents ?? this.maxHistoryEvents);
    const maxInputTokens = input.context?.maxInputTokens ?? this.maxInputTokens;
    if (maxInputTokens !== undefined) {
      const historyBudget = maxInputTokens - estimatedFixedTextTokens;
      if (historyBudget < 0) throw new Error("Context fixed blocks exceed maxInputTokens");
      selectedEvents = fitEventsToTokenBudget(selectedEvents, historyBudget);
    }
    const latestEventObservation = findLatestObservation(orderedEvents);
    if (input.latestObservation !== undefined &&
      (latestEventObservation === undefined || input.latestObservation.id !== latestEventObservation.id)) {
      throw new Error("latestObservation must match the latest observation.created event");
    }
    const latestObservation = input.latestObservation ?? latestEventObservation;
    const messages: ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: input.goal }] },
    ];

    // Runtime events preserve occurrence order. Provider messages need one
    // additional invariant: a ToolCall must be closed by its ToolResult
    // before a later user correction is presented. Indexing results first lets
    // a rejection persisted after the correction still be projected next to
    // the call it closes, without rewriting the event history.
    const resultsByCallId = new Map<ToolCallId, ToolResult>();
    for (const event of selectedEvents) {
      if (event.type === "tool.call.completed" || event.type === "tool.call.failed") {
        resultsByCallId.set(event.result.callId, event.result);
      } else if (event.type === "tool.call.rejected") {
        resultsByCallId.set(event.callId, {
          callId: event.callId,
          status: "rejected",
          error: { code: "TOOL_REJECTED", message: event.reason },
        });
      }
    }
    const pendingCallIds: ToolCallId[] = [];
    const emittedResultIds = new Set<ToolCallId>();
    const emitResult = (result: ToolResult): void => {
      if (emittedResultIds.has(result.callId)) return;
      const pendingIndex = pendingCallIds.indexOf(result.callId);
      if (pendingIndex >= 0) pendingCallIds.splice(pendingIndex, 1);
      messages.push(toolResultMessage(result));
      emittedResultIds.add(result.callId);
    };
    const flushPendingResults = (): void => {
      for (const callId of [...pendingCallIds]) {
        const result = resultsByCallId.get(callId);
        if (result !== undefined) emitResult(result);
      }
    };

    let currentViewport: import("@computer-harness/protocol").Viewport | undefined = latestObservation?.viewport;
    for (const event of selectedEvents) {
      signal.throwIfAborted();
      switch (event.type) {
        case "observation.created":
          currentViewport = event.observation.viewport;
          break;
        case "model.response.received":
          messages.push(modelTurnMessage(event.turn, currentViewport));
          if (event.turn.type === "tool_calls") {
            pendingCallIds.push(...event.turn.calls.map((call) => call.id));
          }
          break;
        case "tool.call.completed":
          emitResult(event.result);
          break;
        case "tool.call.failed":
          emitResult(event.result);
          break;
        case "tool.call.rejected":
          emitResult({
            callId: event.callId,
            status: "rejected",
            error: { code: "TOOL_REJECTED", message: event.reason },
          });
          break;
        case "user.input.received":
          flushPendingResults();
          messages.push({ role: "user", content: [{ type: "text", text: event.text }] });
          break;
        default:
          break;
      }
    }
    flushPendingResults();

    if (features.planning !== "off" && input.plan !== undefined && input.plan.tasks.length > 0) {
      messages.push({
        role: "user",
        content: [{ type: "text", text: formatPlan(input.plan) }],
      });
    }

    if (features.memory !== "off" && input.memory !== undefined) {
      const memoryText = formatMemory(input.memory, input.plan);
      if (memoryText !== undefined) {
        messages.push({ role: "user", content: [{ type: "text", text: memoryText }] });
      }
    }

    if (latestObservation !== undefined) {
      messages.push({
        role: "user",
        content: [{
          type: "image",
          asset: latestObservation.screenshot,
          viewport: latestObservation.viewport,
        }],
      });
    }
    signal.throwIfAborted();
    const estimatedToolSchemaTokens = Math.ceil(JSON.stringify(tools).length / 4);
    const estimatedHistoryTextTokens = estimateEventTokens(selectedEvents);
    const estimatedInputTokens = estimatedFixedTextTokens + estimatedHistoryTextTokens;
    if (maxInputTokens !== undefined && estimatedInputTokens > maxInputTokens) {
      throw new Error("Context history exceeds maxInputTokens after selection");
    }
    const budget: ContextBudgetReport = {
      mode: input.context?.mode ?? this.mode,
      estimatedInputTokens,
      estimatedFixedTextTokens,
      estimatedHistoryTextTokens,
      estimatedToolSchemaTokens,
      imageCount: latestObservation === undefined ? 0 : 1,
      selectedHistoryEvents: selectedEvents.length,
      omittedHistoryEvents: Math.max(0, orderedEvents.length - selectedEvents.length),
      ...(input.context?.maxHistoryEvents === undefined && this.mode === "raw" ? {} : { maxHistoryEvents: input.context?.maxHistoryEvents ?? this.maxHistoryEvents }),
      ...(maxInputTokens === undefined ? {} : { maxInputTokens }),
    };
    return {
      system: systemPrompt,
      messages,
      tools,
      contextBudget: budget,
    };
  }
}

function selectHistoryEvents(events: readonly RuntimeEvent[], mode: "raw" | "recent", maxHistoryEvents: number): RuntimeEvent[] {
  if (mode === "raw" || events.length <= maxHistoryEvents) return [...events];
  const selected = new Set<number>();
  const responses = events.filter((event) => event.type === "model.response.received");
  const keptResponses = responses.slice(-Math.max(1, Math.floor(maxHistoryEvents / 4)));
  const keptCallIds = new Set<ToolCallId>();
  for (const event of keptResponses) {
    selected.add(event.sequence);
    if (event.turn.type === "tool_calls") for (const call of event.turn.calls) keptCallIds.add(call.id);
  }
  for (const event of events) {
    if (event.type === "tool.call.received" && keptCallIds.has(event.call.id)) selected.add(event.sequence);
    if ((event.type === "tool.call.completed" || event.type === "tool.call.failed") && keptCallIds.has(event.result.callId)) selected.add(event.sequence);
    if (event.type === "tool.call.rejected" && keptCallIds.has(event.callId)) selected.add(event.sequence);
    if (event.type === "user.input.received") selected.add(event.sequence);
  }
  return events.filter((event) => selected.has(event.sequence));
}

function fitEventsToTokenBudget(events: readonly RuntimeEvent[], maxTokens: number): RuntimeEvent[] {
  const authoritativeInputs = events.filter((event) => event.type === "user.input.received");
  if (estimateEventTokens(authoritativeInputs) > maxTokens) {
    throw new Error("Authoritative user inputs exceed maxInputTokens");
  }
  let retained = [...events];
  while (estimateEventTokens(retained) > maxTokens) {
    const group = findOldestEvictableHistoryGroup(retained);
    if (group.length === 0) throw new Error("Context history cannot fit maxInputTokens");
    const discarded = new Set(group);
    const next = retained.filter((event) => !discarded.has(event));
    if (next.length === retained.length) throw new Error("Context history cannot fit maxInputTokens");
    retained = next;
  }
  return retained;
}

function findOldestEvictableHistoryGroup(events: readonly RuntimeEvent[]): RuntimeEvent[] {
  for (const event of events) {
    if (event.type === "user.input.received") continue;
    if (event.type === "model.response.received") {
      const callIds = event.turn.type === "tool_calls" ? event.turn.calls.map((call) => call.id) : [];
      return [event, ...historyEventsForCalls(events, callIds)];
    }
    const callId = historyCallId(event);
    if (callId !== undefined) return historyEventsForCalls(events, [callId]);
    const actionIds = historyActionIds(event);
    if (actionIds.length > 0) return historyEventsForActions(events, actionIds);
    return [event];
  }
  return [];
}

function historyEventsForCalls(events: readonly RuntimeEvent[], callIds: readonly ToolCallId[]): RuntimeEvent[] {
  const callIdSet = new Set(callIds);
  const actionIds = new Set<string>();
  for (const event of events) {
    if (event.type === "action.proposed" && callIdSet.has(event.callId)) actionIds.add(event.action.actionId);
    if (event.type === "action.guard.evaluated" && event.callIds.some((id) => callIdSet.has(id))) {
      for (const action of event.actions) actionIds.add(action.actionId);
    }
  }
  return events.filter((event) => {
    const callId = historyCallId(event);
    if (callId !== undefined && callIdSet.has(callId)) return true;
    return historyActionIds(event).some((id) => actionIds.has(id));
  });
}

function historyEventsForActions(events: readonly RuntimeEvent[], actionIds: readonly string[]): RuntimeEvent[] {
  const actionIdSet = new Set(actionIds);
  return events.filter((event) => {
    return historyActionIds(event).some((id) => actionIdSet.has(id));
  });
}

function historyCallId(event: RuntimeEvent): ToolCallId | undefined {
  switch (event.type) {
    case "tool.call.received": return event.call.id;
    case "tool.call.completed":
    case "tool.call.failed": return event.result.callId;
    case "tool.call.rejected": return event.callId;
    case "action.proposed": return event.callId;
    default: return undefined;
  }
}

function historyActionIds(event: RuntimeEvent): readonly string[] {
  switch (event.type) {
    case "action.proposed":
    case "action.execution.started": return [event.action.actionId];
    case "action.execution.completed":
    case "action.execution.failed": return [event.receipt.actionId];
    case "action.guard.evaluated": return event.actions.map((action) => action.actionId);
    default: return [];
  }
}

function estimateEventTokens(events: readonly RuntimeEvent[]): number {
  return Math.ceil(events.reduce((total, event) => total + JSON.stringify(event).length, 0) / 4);
}

function estimateTokens(messages: readonly ModelMessage[]): number {
  let characters = 0;
  for (const message of messages) for (const content of message.content) {
    if (content.type === "text") characters += content.text.length;
    else if (content.type === "tool_call") characters += JSON.stringify(content.call).length;
    else if (content.type === "tool_result") characters += JSON.stringify(content.result).length;
    else if (content.type === "provider_continuation") characters += content.continuation.content.length;
  }
  return Math.ceil(characters / 4);
}

function formatPlan(plan: PlanState): string {
  const unfinished = plan.tasks.filter((task) => task.status !== "completed");
  const completedCount = plan.tasks.length - unfinished.length;
  const lines = unfinished.map((task) => {
    const description = task.description === undefined ? "" : ` — ${task.description}`;
    const blockedBy = task.blockedBy === undefined || task.blockedBy.length === 0 ? "" : ` (blocked by ${task.blockedBy.join(", ")})`;
    return `- [${task.status}] ${task.id}: ${task.subject}${description}${blockedBy}`;
  });
  if (lines.length === 0) {
    return `Current run plan (progress declaration, not proof of task completion): no unfinished phases; completed phases: ${completedCount}.`;
  }
  const completedSummary = completedCount === 0 ? "" : `\nCompleted phases: ${completedCount}.`;
  return `Current run plan (optional phase progress, not proof of task completion):\n${lines.join("\n")}${completedSummary}`;
}

function composeSystemPrompt(base: string, features: RunFeatureConfig): string {
  const sections = [base];
  if (features.planning !== "off") sections.push("Planning tools are optional: use them for handoff-sized phases, real blockers, or goal changes, not for every click. A planning task describes a phase goal and necessary unfinished work; completed is a declared plan state, not official task verification.");
  if (features.memory !== "off") sections.push(`Run Memory is enabled (${features.memory}). Write only durable facts or objects needed later in this Run; do not record every click or duplicate plan progress. Read details by id when the compact index is insufficient.`);
  if (features.riskGuard === "layered") sections.push("For every Computer tool call, include _harnessEffect with non-empty effects, target, and summary. Describe this call's immediate expected effect, not the eventual goal: ordinary browsing/navigation is navigate, ordinary reversible typing is local_edit, and final payment, sending/publishing/submission, irreversible deletion/overwrite, sensitive disclosure, or security changes use their matching effect. Use unknown when uncertain. Never include secrets or private content in target/summary, and never claim that an action is approved or safe.");
  if (features.batching === "off") {
    sections.push("Return at most one Computer tool call per model turn.");
  } else {
    sections.push("A model turn may contain up to two Plan/Memory write calls first, followed by one Computer call or one GUI batch. A GUI batch is only click→type, Ctrl+A→type, or click→Ctrl+A→type in the same already-active text control. Do not put read tools, Control decisions, Enter, Tab, submit, navigation, scroll, drag, wait, or state writes after/between GUI calls. Do not claim post-action success before the next observation.");
  }
  return sections.join(" ");
}

function formatMemory(memory: MemoryState, plan: PlanState | undefined): string | undefined {
  const selection = selectMemoryForContext(memory, plan);
  if (selection.indexFacts.length === 0 && selection.indexEntities.length === 0) return undefined;
  const hotFactIds = new Set(selection.hotFacts.map((fact) => fact.id));
  const hotEntityIds = new Set(selection.hotEntities.map((entity) => entity.id));
  const lines = ["Current run memory index (run-scoped facts, not proof of GUI state):"];
  for (const fact of selection.indexFacts) lines.push(`- fact ${fact.id}${fact.subject.type === "entity" ? ` (entity ${fact.subject.entityId})` : ""}: ${fact.key} [${fact.status}]${hotFactIds.has(fact.id) ? " [hot]" : ""}`);
  for (const entity of selection.indexEntities) lines.push(`- entity ${entity.id} (${entity.type}): ${entity.description} [${entity.status}]${hotEntityIds.has(entity.id) ? " [hot]" : ""}`);
  if (selection.hotFacts.length > 0) {
    lines.push("Hot facts:");
    for (const fact of selection.hotFacts) lines.push(`- ${fact.id}${fact.subject.type === "entity" ? ` (entity ${fact.subject.entityId})` : ""}: ${fact.key} = ${fact.value}${fact.status === "needs_check" ? " [needs_check]" : ""}`);
  }
  if (selection.hotEntities.length > 0) {
    lines.push("Hot entities:");
    for (const entity of selection.hotEntities) lines.push(`- ${entity.id}: ${entity.description}`);
  }
  return lines.join("\n");
}

/** Deterministic, bounded recall policy; it performs no I/O or model calls. */
export function selectMemoryForContext(
  memory: MemoryState,
  plan: PlanState | undefined,
  limits: MemoryRecallLimits = {},
): MemoryContextSelection {
  const maxIndexFacts = limits.maxIndexFacts ?? 20;
  const maxIndexEntities = limits.maxIndexEntities ?? 10;
  const maxHotFacts = limits.maxHotFacts ?? 8;
  const maxHotEntities = limits.maxHotEntities ?? 4;
  const taskPriority = new Map<string, number>();
  for (const task of plan?.tasks ?? []) {
    taskPriority.set(task.id, task.status === "in_progress" ? 4 : task.status === "pending" ? 3 : task.status === "blocked" ? 2 : 1);
  }
  const relevance = (ids: readonly string[] | undefined): number => Math.max(0, ...(ids ?? []).map((id) => taskPriority.get(id) ?? 0));
  const entityById = new Map(memory.entities.map((entity) => [entity.id, entity]));
  const factScore = (fact: MemoryFact): readonly number[] => [
    Math.max(relevance(fact.relatedTaskIds), fact.subject.type === "entity" ? relevance(entityById.get(fact.subject.entityId)?.relatedTaskIds) : 0),
    fact.status === "needs_check" ? 2 : 1,
    fact.updatedSequence,
  ];
  const entityScore = (entity: MemoryEntity): readonly number[] => [
    relevance(entity.relatedTaskIds),
    entity.updatedSequence,
  ];
  const compare = (left: readonly number[], right: readonly number[]): number => {
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      const difference = (right[index] ?? 0) - (left[index] ?? 0);
      if (difference !== 0) return difference;
    }
    return 0;
  };
  const activeFacts = memory.facts.filter((fact) => (fact.status === "active" || fact.status === "needs_check") && (fact.subject.type === "run" || entityById.get(fact.subject.entityId)?.status === "active")).sort((left, right) => compare(factScore(left), factScore(right)));
  const activeEntities = memory.entities.filter((entity) => entity.status === "active").sort((left, right) => compare(entityScore(left), entityScore(right)));
  const candidateFacts = activeFacts.slice(0, maxIndexFacts);
  const requiredEntityIds = [...new Set(candidateFacts.flatMap((fact) => fact.subject.type === "entity" ? [fact.subject.entityId] : []))];
  const indexEntities: MemoryEntity[] = [];
  for (const entityId of requiredEntityIds) {
    const entity = entityById.get(entityId);
    if (entity !== undefined && entity.status === "active" && indexEntities.length < maxIndexEntities) indexEntities.push(entity);
  }
  for (const entity of activeEntities) {
    if (indexEntities.length >= maxIndexEntities) break;
    if (!indexEntities.some((selected) => selected.id === entity.id)) indexEntities.push(entity);
  }
  const indexedEntityIds = new Set(indexEntities.map((entity) => entity.id));
  const indexFacts = candidateFacts.filter((fact) => fact.subject.type === "run" || indexedEntityIds.has(fact.subject.entityId));
  const hotFacts = indexFacts.slice(0, maxHotFacts);
  const hotFactEntityIds = new Set(hotFacts.flatMap((fact) => fact.subject.type === "entity" ? [fact.subject.entityId] : []));
  const hotEntities = [
    ...indexEntities.filter((entity) => hotFactEntityIds.has(entity.id)),
    ...indexEntities.filter((entity) => !hotFactEntityIds.has(entity.id)),
  ].slice(0, maxHotEntities);
  return {
    indexFacts,
    indexEntities,
    hotFacts,
    hotEntities,
  };
}

function modelTurnMessage(
  turn: import("@computer-harness/protocol").ModelTurn,
  viewport: import("@computer-harness/protocol").Viewport | undefined,
): ModelMessage {
  switch (turn.type) {
    case "tool_calls": {
      const content: ModelContentBlock[] = [];
      if (turn.assistantText !== undefined && turn.assistantText.trim().length > 0) {
        content.push({ type: "text", text: turn.assistantText });
      }
      if (turn.continuation !== undefined) {
        content.push({ type: "provider_continuation", continuation: turn.continuation });
      }
      for (const call of turn.calls) {
        content.push({ type: "tool_call", call, ...(viewport === undefined ? {} : { viewport }) });
      }
      return { role: "assistant", content };
    }
    case "user_input_required":
      return { role: "assistant", content: [{ type: "text", text: turn.question }] };
    case "finish":
      return {
        role: "assistant",
        content: [{ type: "text", text: turn.reportedStatus === undefined ? turn.summary : `${turn.summary} [reportedStatus=${turn.reportedStatus}]` }],
      };
  }
}

function toolResultMessage(result: ToolResult): ModelMessage {
  return { role: "tool", content: [{ type: "tool_result", result }] };
}

function findLatestObservation(events: readonly RuntimeEvent[]): import("@computer-harness/protocol").ObservationFrame | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "observation.created") {
      return event.observation;
    }
  }
  return undefined;
}
