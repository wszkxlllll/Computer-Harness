import type { ModelContentBlock, ModelMessage } from "@computer-harness/runtime";
import type { ObservationFrame, ModelTurn, RuntimeEvent, ToolResult, Viewport } from "@computer-harness/protocol";

export function modelTurnMessage(
  turn: ModelTurn,
  viewport: Viewport | undefined,
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

export function toolResultMessage(result: ToolResult): ModelMessage {
  return { role: "tool", content: [{ type: "tool_result", result }] };
}

export function findLatestObservation(events: readonly RuntimeEvent[]): ObservationFrame | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "observation.created") {
      return event.observation;
    }
  }
  return undefined;
}
