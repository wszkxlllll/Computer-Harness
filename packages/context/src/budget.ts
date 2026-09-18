import type { ModelMessage } from "@computer-harness/runtime";
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
