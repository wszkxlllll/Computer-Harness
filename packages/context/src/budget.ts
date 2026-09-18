import type { RuntimeEvent } from "@computer-harness/protocol";
import { findOldestEvictableHistoryGroup } from "./history.js";

export function fitEventsToTokenBudget(events: readonly RuntimeEvent[], maxTokens: number): RuntimeEvent[] {
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
export function estimateEventTokens(events: readonly RuntimeEvent[]): number {
  return Math.ceil(events.reduce((total, event) => total + estimateProjectedEventCharacters(event), 0) / 4);
}

export function isProjectableHistoryEvent(event: RuntimeEvent): boolean {
  switch (event.type) {
    case "model.response.received":
    case "tool.call.completed":
    case "tool.call.failed":
    case "tool.call.rejected":
    case "user.input.received":
      return true;
    default:
      return false;
  }
}

function estimateProjectedEventCharacters(event: RuntimeEvent): number {
  switch (event.type) {
    case "model.response.received":
      if (event.turn.type === "tool_calls") {
        return (event.turn.assistantText?.length ?? 0)
          + event.turn.calls.reduce((total, call) => total + JSON.stringify(call).length, 0)
          + (event.turn.continuation?.content.length ?? 0);
      }
      return event.turn.type === "finish" ? event.turn.summary.length : event.turn.question.length;
    case "tool.call.completed":
    case "tool.call.failed":
      return JSON.stringify(event.result).length;
    case "tool.call.rejected":
      return JSON.stringify({ callId: event.callId, status: "rejected", error: { code: "TOOL_REJECTED", message: event.reason } }).length;
    case "user.input.received":
      return event.text.length;
    default:
      // run/control/observation/request/diagnostic events are not serialized
      // as ModelMessages by the Context compiler. In particular, Trace and
      // prepared metadata must not consume model history budget.
      return 0;
  }
}
