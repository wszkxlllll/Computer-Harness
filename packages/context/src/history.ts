import type { RuntimeEvent, ToolCallId } from "@computer-harness/protocol";

export function selectHistoryEvents(events: readonly RuntimeEvent[], mode: "raw" | "recent", maxHistoryEvents: number): RuntimeEvent[] {
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

/** Keep the turn that caused the most recent dispatched GUI action intact. */
export function latestGuiHistoryGroup(events: readonly RuntimeEvent[]): RuntimeEvent[] {
  const execution = [...events].reverse().find((event) => event.type === "action.execution.started" && event.action.kind !== "wait");
  if (execution?.type !== "action.execution.started") return [];
  const proposed = events.find((event) => event.type === "action.proposed" && event.action.actionId === execution.action.actionId);
  if (proposed?.type !== "action.proposed") return [];
  const response = events.find((event) => event.type === "model.response.received" && event.turn.type === "tool_calls" && event.turn.calls.some((call) => call.id === proposed.callId));
  if (response?.type !== "model.response.received" || response.turn.type !== "tool_calls") return [];
  return [response, ...historyEventsForCalls(events, response.turn.calls.map((call) => call.id))];
}

/** A retained reasoning tool turn must carry its continuation and every result
 * together, including when its tools did not dispatch a GUI action. */
export function latestContinuationHistoryGroup(events: readonly RuntimeEvent[]): RuntimeEvent[] {
  const response = [...events].reverse().find((event) => event.type === "model.response.received");
  if (response?.type !== "model.response.received" || response.turn.type !== "tool_calls" || response.turn.continuation === undefined) return [];
  return [response, ...historyEventsForCalls(events, response.turn.calls.map((call) => call.id))];
}
export function findOldestEvictableHistoryGroup(events: readonly RuntimeEvent[]): RuntimeEvent[] {
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
