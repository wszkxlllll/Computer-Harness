import type {
  ModelContentBlock,
  ModelInput,
  ModelMessage,
  ContextCompileInput,
  ContextCompiler,
} from "@computer-harness/runtime";
import type { RuntimeEvent, ToolCallId, ToolResult } from "@computer-harness/protocol";
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
      "You are a GUI agent. Use the available tools and finish only when the task is complete. Do not claim completion before the requested state is visible. Observe is automatic; emit at most one Computer tool call per model turn. Follow the selected Provider's coordinate-unit instructions for the current image. type and keypress act on the current focus; hotkey is for a simultaneous shortcut. Never invent a tool result.";
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
