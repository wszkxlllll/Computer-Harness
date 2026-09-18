import type {
  ModelInput,
  ModelMessage,
  ContextCompileInput,
  ContextCompiler,
  ContextBudgetReport,
  RunFeatureConfig,
} from "@computer-harness/runtime";
import { createHash } from "node:crypto";
import { decorateToolsWithActionEffects, ToolRegistry } from "@computer-harness/runtime";
import type { RuntimeEvent, ToolCallId, ToolResult } from "@computer-harness/protocol";
import { composeSystemPrompt, formatMemory, formatPlan } from "./projections.js";
import { findLatestObservation, modelTurnMessage, toolResultMessage } from "./messages.js";
import { estimateEventTokens, fitEventsToTokenBudget, isProjectableHistoryEvent } from "./budget.js";
import { selectHistoryEvents } from "./history.js";

export interface DefaultContextCompilerOptions {
  systemPrompt?: string;
  mode?: "raw" | "recent";
  maxHistoryEvents?: number;
  maxInputTokens?: number;
  memoryMaxTokens?: number;
  features?: RunFeatureConfig;
}
export class DefaultContextCompiler implements ContextCompiler {
  private readonly systemPrompt: string;
  private readonly mode: "raw" | "recent";
  private readonly maxHistoryEvents: number;
  private readonly maxInputTokens: number | undefined;
  private readonly memoryMaxTokens: number;
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
    this.memoryMaxTokens = options.memoryMaxTokens ?? 256;
    if (!Number.isInteger(this.memoryMaxTokens) || this.memoryMaxTokens < 1) {
      throw new Error("memoryMaxTokens must be a positive integer");
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
    const planText = features.planning !== "off" && input.plan !== undefined && input.plan.tasks.length > 0 ? formatPlan(input.plan) : undefined;
    const memoryProjection = features.memory !== "off" && input.memory !== undefined
      ? formatMemory(input.memory, input.plan, input.context?.memoryMaxTokens ?? this.memoryMaxTokens)
      : undefined;
    const memoryText = memoryProjection?.text;
    const toolText = JSON.stringify(tools);
    const fixedBlocks = [
      { name: "system" as const, text: systemPrompt, included: true },
      { name: "goal" as const, text: input.goal, included: true },
      { name: "tools" as const, text: toolText, included: true },
      { name: "plan" as const, text: planText ?? "", included: planText !== undefined },
      { name: "memory" as const, text: memoryText ?? "", included: memoryText !== undefined && memoryText.length > 0 },
    ];
    const fixedText = fixedBlocks.map((block) => block.text).join("\n");
    const estimatedFixedTextTokens = Math.ceil(fixedText.length / 4);
    const historyCandidates = selectHistoryEvents(orderedEvents, input.context?.mode ?? this.mode, input.context?.maxHistoryEvents ?? this.maxHistoryEvents);
    let selectedEvents = historyCandidates;
    const maxInputTokens = input.context?.maxInputTokens ?? this.maxInputTokens;
    const historyBudget = maxInputTokens === undefined ? undefined : maxInputTokens - estimatedFixedTextTokens;
    if (maxInputTokens !== undefined) {
      if (historyBudget === undefined || historyBudget < 0) throw new Error("Context fixed blocks exceed maxInputTokens");
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
      if (memoryProjection !== undefined && memoryProjection.text.length > 0) {
        messages.push({ role: "user", content: [{ type: "text", text: memoryProjection.text }] });
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
    const selectedIds = new Set(selectedEvents.map((event) => event.eventId));
    const candidateIds = new Set(historyCandidates.map((event) => event.eventId));
    const latestObservationEventId = latestObservation === undefined
      ? undefined
      : orderedEvents.find((event) => event.type === "observation.created" && event.observation.id === latestObservation.id)?.eventId;
    const projectedEventIds = [
      ...selectedEvents.filter(isProjectableHistoryEvent).map((event) => event.eventId),
      ...(latestObservationEventId === undefined ? [] : [latestObservationEventId]),
    ];
    const discardedEvents = [
      ...orderedEvents.filter((event) => !candidateIds.has(event.eventId)).map((event) => ({ eventId: event.eventId, reason: "history_limit" as const })),
      ...historyCandidates.filter((event) => !selectedIds.has(event.eventId)).map((event) => ({ eventId: event.eventId, reason: "input_budget" as const })),
    ];
    const memoryEstimatedTokens = memoryProjection?.estimatedTokens ?? 0;
    const trace = {
      compilerVersion: "context-v2-rft4",
      runId: input.runId,
      stablePrefixHash: createHash("sha256").update(JSON.stringify({ system: systemPrompt, tools })).digest("hex"),
      fixedBlocks: fixedBlocks.map((block) => ({ name: block.name, estimatedTokens: estimateTextTokens(block.text), included: block.included })),
      selectedEventIds: selectedEvents.map((event) => event.eventId),
      projectedEventIds,
      discardedEvents,
      authoritativeUserEventIds: orderedEvents.filter((event) => event.type === "user.input.received").map((event) => event.eventId),
      historyEstimatedTokens: estimatedHistoryTextTokens,
      ...(historyBudget === undefined || historyBudget < 0 ? {} : { historyBudgetTokens: historyBudget }),
      ...(memoryProjection === undefined ? {} : { memoryEstimatedTokens, memoryTruncated: memoryProjection.truncated }),
      observationIncluded: latestObservation !== undefined,
    };
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
      ...(memoryText === undefined ? {} : { estimatedMemoryTokens: memoryEstimatedTokens, memoryMaxTokens: input.context?.memoryMaxTokens ?? this.memoryMaxTokens }),
      trace,
    };
    return {
      system: systemPrompt,
      messages,
      tools,
      contextBudget: budget,
    };
  }
}

function estimateTextTokens(value: string): number {
  return Math.ceil(value.length / 4);
}
