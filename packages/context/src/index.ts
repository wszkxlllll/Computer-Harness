import type {
  ModelContentBlock,
  ModelInput,
  ModelMessage,
  ContextCompileInput,
  ContextCompiler,
} from "@computer-harness/runtime";
import type { PlanState, RuntimeEvent, ToolCallId, ToolResult } from "@computer-harness/protocol";
import { ToolRegistry } from "@computer-harness/runtime";

export interface DefaultContextCompilerOptions {
  systemPrompt?: string;
}

/**
 * The deliberately small, provider-neutral context projection used by V1.
 * It derives history from RuntimeEvents rather than maintaining a second
 * ToolResult or Snapshot authority.
 */
export class DefaultContextCompiler implements ContextCompiler {
  private readonly systemPrompt: string;

  public constructor(
    private readonly tools: ToolRegistry,
    options: DefaultContextCompilerOptions = {},
  ) {
    this.systemPrompt = options.systemPrompt ??
      "You are a GUI agent. Use the available tools and finish only when the task is complete. Do not claim completion before the requested state is visible. Observe is automatic; emit at most one Computer tool call per model turn. Follow the selected Provider's coordinate-unit instructions for the current image. type and keypress act on the current focus; hotkey is for a simultaneous shortcut. Never invent a tool result. Planning tools are optional: use them for handoff-sized phases, real blockers, or goal changes, not for every click. A planning task describes a phase goal and necessary unfinished work; completed is a declared plan state, not official task verification.";
  }

  public async compile(input: ContextCompileInput, signal: AbortSignal): Promise<ModelInput> {
    signal.throwIfAborted();
    const orderedEvents = [...input.recentEvents].sort((left, right) => left.sequence - right.sequence);
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
    for (const event of orderedEvents) {
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

    let currentViewport: import("@computer-harness/protocol").Viewport | undefined;
    for (const event of orderedEvents) {
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

    if (input.plan !== undefined && input.plan.tasks.length > 0) {
      messages.push({
        role: "user",
        content: [{ type: "text", text: formatPlan(input.plan) }],
      });
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
    return {
      system: this.systemPrompt,
      messages,
      tools: this.tools.modelTools(),
    };
  }
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
