import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { estimateEventTokens } from "./budget.js";
import type {
  AssetId,
  ActionId,
  ComputerSessionId,
  EventId,
  MemoryState,
  ObservationId,
  RunId,
  RunAssistantPreferencesSnapshot,
  RuntimeEvent,
  ToolCallId,
} from "@computer-harness/protocol";
import { createDefaultComputerTools } from "@computer-harness/runtime";
import { DefaultContextCompiler, selectMemoryForContext } from "./index.js";

const runId = "run-context" as RunId;
const sessionId = "session-context" as ComputerSessionId;
const viewport = { width: 800, height: 600, coordinateSpace: "physical" as const };

function event(sequence: number, data: RuntimeEvent["type"] extends never ? never : any): RuntimeEvent {
  return {
    eventId: `event-${sequence}` as EventId,
    runId,
    sequence,
    occurredAt: `2026-08-30T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    ...data,
  } as RuntimeEvent;
}

function observation(id: string) {
  return {
    id: id as ObservationId,
    runId,
    computerSessionId: sessionId,
    capturedAt: "2026-08-30T00:00:00.000Z",
    viewport,
    screenshot: {
      assetId: `${id}-asset` as AssetId,
      relativePath: `screenshots/${id}.png`,
      mediaType: "image/png",
      byteLength: 1,
    },
  };
}

describe("DefaultContextCompiler", () => {
  it("projects assistant ToolCall before its matching result and appends only the latest image", async () => {
    const first = observation("obs-1");
    const latest = observation("obs-2");
    const call = { id: "call-1" as ToolCallId, name: "click", arguments: { x: 10, y: 20 } };
    const events: RuntimeEvent[] = [
      event(0, { type: "run.created", goal: "ignored event goal" }),
      event(1, { type: "run.started" }),
      event(2, { type: "observation.created", observation: first }),
      event(3, { type: "model.response.received", turn: { type: "tool_calls", calls: [call] } }),
      event(4, { type: "tool.call.received", call }),
      event(5, { type: "tool.call.completed", result: { callId: call.id, status: "completed", output: { ok: true } } }),
      event(6, { type: "user.input.received", text: "Please continue" }),
      event(7, { type: "observation.created", observation: latest }),
    ];
    const compiler = new DefaultContextCompiler(createDefaultComputerTools());
    const input = await compiler.compile({ runId, goal: "open the app", recentEvents: events, latestObservation: latest }, new AbortController().signal);
    expect(input.messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "open the app" }] });
    expect(input.messages.filter((message) => message.content.some((block) => block.type === "image"))).toHaveLength(1);
    const assistant = input.messages.find((message) => message.role === "assistant");
    expect(assistant?.content.some((block) => block.type === "tool_call" && block.call.id === call.id)).toBe(true);
    const assistantIndex = input.messages.indexOf(assistant!);
    const resultIndex = input.messages.findIndex((message) => message.content.some((block) => block.type === "tool_result"));
    expect(assistantIndex).toBeLessThan(resultIndex);
    expect(input.messages.some((message) => message.content.some((block) => block.type === "text" && block.text === "Please continue"))).toBe(true);
    expect(input.messages.some((message) => message.content.some((block) => block.type === "image" && block.asset.assetId === latest.screenshot.assetId))).toBe(true);
    expect(input.messages.some((message) => message.content.some((block) => block.type === "image" && block.asset.assetId === first.screenshot.assetId))).toBe(false);
    expect(input.contextBudget?.trace?.projectedEventIds).toContain("event-7");
    expect(input.contextBudget?.trace?.projectedEventIds).not.toContain("event-1");
  });

  it("keeps current Observation/action assessment IDs in the dynamic observation message", async () => {
    const before = observation("assessment-before");
    const latest = observation("assessment-current");
    const actionId = "assessment-action" as ActionId;
    const events: RuntimeEvent[] = [
      event(0, { type: "observation.created", observation: before }),
      event(1, {
        type: "action.proposed",
        callId: "assessment-call" as ToolCallId,
        action: { actionId, basedOn: before.id, kind: "click", point: { x: 20, y: 30 } },
      }),
      event(2, { type: "action.execution.completed", receipt: { actionId, status: "completed" } }),
      event(3, { type: "observation.created", observation: latest }),
    ];
    const input = await new DefaultContextCompiler(createDefaultComputerTools()).compile({
      runId,
      goal: "continue from the current screen",
      recentEvents: events,
      latestObservation: latest,
      features: { planning: "off", memory: "off", batching: "off", monitor: "guidance" },
      monitorGuidance: { text: "Recheck the visible state before acting.", fingerprint: "monitor-guidance" },
    }, new AbortController().signal);
    const currentObservationMessage = input.messages.find((message) => message.content.some((block) =>
      block.type === "image" && block.asset.assetId === latest.screenshot.assetId));
    const dynamicText = currentObservationMessage?.content.filter((block) => block.type === "text").map((block) => block.text).join(" ") ?? "";
    expect(dynamicText).toContain("Observation ID assessment-current");
    expect(dynamicText).toContain("GUI action ID assessment-action");
    expect(JSON.stringify(input.messages)).toContain("Recheck the visible state before acting.");
    expect(input.system).not.toContain("assessment-current");
    expect(JSON.stringify(input.tools)).not.toContain("assessment-action");

    const compiler = new DefaultContextCompiler(createDefaultComputerTools());
    const mismatchedTransitions: RuntimeEvent[] = [
      event(4, {
        type: "monitor.transition", actionId: "other-action" as ActionId, postObservationId: latest.id,
        sourceActionEventId: "event-2" as EventId, sourceObservationEventId: "event-3" as EventId, transition: "changed",
      }),
      event(5, {
        type: "monitor.transition", actionId, postObservationId: "other-observation" as ObservationId,
        sourceActionEventId: "event-2" as EventId, sourceObservationEventId: "event-3" as EventId, transition: "unchanged",
      }),
      event(6, {
        type: "monitor.transition", actionId, postObservationId: latest.id,
        sourceActionEventId: "wrong-receipt" as EventId, sourceObservationEventId: "event-3" as EventId, transition: "unknown",
      }),
    ];
    const compileEvents = async (additionalEvents: readonly RuntimeEvent[]) => compiler.compile({
      runId,
      goal: "continue from the current screen",
      recentEvents: [...events, ...additionalEvents],
      latestObservation: latest,
      features: { planning: "off", memory: "off", batching: "off", monitor: "guidance" },
      monitorGuidance: { text: "Recheck the visible state before acting.", fingerprint: "monitor-guidance" },
    }, new AbortController().signal);
    const mismatched = await compileEvents(mismatchedTransitions);
    const mismatchedText = JSON.stringify(mismatched.messages);
    expect(mismatchedText).not.toContain("Runtime Monitor transition for this exact action/Observation");

    const exact = await compileEvents([
      ...mismatchedTransitions,
      event(7, {
        type: "monitor.transition", actionId, postObservationId: latest.id,
        sourceActionEventId: "event-2" as EventId, sourceObservationEventId: "event-3" as EventId, transition: "changed",
      }),
    ]);
    expect(JSON.stringify(exact.messages)).toContain("Runtime Monitor transition for this exact action/Observation: changed");
    expect(exact.contextBudget?.trace?.stablePrefixHash).toBe(input.contextBudget?.trace?.stablePrefixHash);
    expect(mismatched.contextBudget?.trace?.stablePrefixHash).toBe(input.contextBudget?.trace?.stablePrefixHash);
  });

  it("serializes prior ModelTurn assessments into assistant history", async () => {
    const latest = observation("assessment-history");
    const assessment = {
      observationId: latest.id,
      actionId: "historical-action" as ActionId,
      actionOutcome: "uncertain" as const,
      evidence: "The prior screen could not be compared confidently.",
      progress: { kind: "blocked" as const, summary: "Check the current page." },
    };
    const input = await new DefaultContextCompiler(createDefaultComputerTools()).compile({
      runId,
      goal: "continue",
      recentEvents: [
        event(0, { type: "model.response.received", turn: { type: "finish", summary: "Not finished yet", observationAssessment: assessment } }),
        event(1, { type: "observation.created", observation: latest }),
      ],
      latestObservation: latest,
    }, new AbortController().signal);
    const assistantText = input.messages.filter((message) => message.role === "assistant")
      .flatMap((message) => message.content.filter((block) => block.type === "text").map((block) => block.text)).join(" ");
    expect(assistantText).toContain("Prior model-reported ObservationAssessment (untrusted evidence)");
    expect(assistantText).toContain("historical-action");
    expect(assistantText).toContain("Check the current page.");
  });

  it("projects a bounded observation grounding catalog near the current image and records its budget trace", async () => {
    const latest = {
      ...observation("obs-grounding"),
      grounding: {
        version: "uia-catalog-v1" as const,
        source: "uia" as const,
        observationId: "obs-grounding" as ObservationId,
        computerSessionId: sessionId,
        completeness: "partial" as const,
        degraded: false,
        maxElements: 16,
        elements: [{
          elementRef: "uia-1",
          role: "ComboBox",
          name: "Departure time",
          bbox: { x: 100, y: 200, width: 80, height: 24, coordinateSpace: "physical" as const },
          state: { enabled: true, editable: false },
        }],
      },
    };
    const input = await new DefaultContextCompiler(createDefaultComputerTools()).compile({
      runId,
      goal: "choose a departure time",
      recentEvents: [event(0, { type: "observation.created", observation: latest })],
      latestObservation: latest,
    }, new AbortController().signal);
    const grounding = input.messages.find((message) => message.content.some((block) => block.type === "text" && block.text.includes("UIA grounding")));
    expect(grounding).toBeDefined();
    expect(grounding?.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("ref=uia-1") });
    expect(input.contextBudget?.trace?.grounding).toMatchObject({ present: true, projected: true, completeness: "partial", candidateElementCount: 1, projectedElementCount: 1 });
    expect(input.contextBudget?.estimatedGroundingTokens).toBeGreaterThan(0);
    expect(input.contextBudget?.groundingIncluded).toBe(true);
  });

  it("projects hybrid provenance and recovery trace through the same catalog", async () => {
    const latest = {
      ...observation("obs-hybrid-grounding"),
      grounding: {
        version: "grounding-catalog-v2" as const,
        source: "hybrid" as const,
        observationId: "obs-hybrid-grounding" as ObservationId,
        computerSessionId: sessionId,
        completeness: "partial" as const,
        degraded: false,
        maxElements: 16,
        elements: [{
          elementRef: "dom-1",
          role: "combobox",
          name: "Departure time",
          source: "dom" as const,
          browserRegion: "content" as const,
          bbox: { x: 100, y: 200, width: 80, height: 24, coordinateSpace: "physical" as const },
          state: { enabled: true },
          options: [{ text: "08:00", enabled: true }, { text: "09:00", enabled: false }],
          optionsTruncated: false,
        }],
        selection: {
          strategy: "bounded-fusion-v1" as const,
          candidateElementCount: 2,
          selectedElementRefs: ["dom-1"],
          truncated: true,
          reasons: [{ elementRef: "dom-1", codes: ["local_recovery_region", "dom_content_priority"] }],
          sourceCounts: { uia: 1, dom: 1 },
          deduplicatedElementCount: 1,
          recovery: { reason: "no_observed_change" as const, attempt: 1, regionApplied: true, localIntentApplied: true, localIntentSource: "user_correction" as const, actionId: "action-1" as ActionId },
        },
      },
    };
    const input = await new DefaultContextCompiler(createDefaultComputerTools()).compile({
      runId,
      goal: "choose a departure time",
      recentEvents: [event(0, { type: "observation.created", observation: latest })],
      latestObservation: latest,
    }, new AbortController().signal);
    const grounding = input.messages.find((message) => message.content.some((block) => block.type === "text" && block.text.includes("UIA+DOM grounding")));
    expect(grounding?.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("source=dom/content") });
    expect(grounding?.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("options=[08:00:enabled | 09:00:disabled]") });
    expect(input.contextBudget?.trace?.grounding).toMatchObject({ source: "hybrid", strategy: "bounded-fusion-v1", deduplicatedElementCount: 1, recovery: { reason: "no_observed_change", attempt: 1, localIntentSource: "user_correction" } });
  });

  it("rejects a shortcut that disagrees with the latest observation event and honors cancellation", async () => {
    const latest = observation("obs-latest");
    const other = observation("obs-other");
    const compiler = new DefaultContextCompiler(createDefaultComputerTools());
    const events = [event(0, { type: "observation.created", observation: latest })];
    await expect(compiler.compile({ runId, goal: "goal", recentEvents: events, latestObservation: other }, new AbortController().signal)).rejects.toThrow(/latestObservation/);
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(compiler.compile({ runId, goal: "goal", recentEvents: events }, controller.signal)).rejects.toThrow("cancelled");
  });

  it("projects a ModelTurn continuation into the assistant history", async () => {
    const first = observation("obs-continuation");
    const call = { id: "call-continuation" as ToolCallId, name: "click", arguments: { x: 10, y: 20 } };
    const events: RuntimeEvent[] = [
      event(0, { type: "run.created", goal: "ignored" }),
      event(1, { type: "run.started" }),
      event(2, { type: "observation.created", observation: first }),
      event(3, {
        type: "model.response.received",
        turn: {
          type: "tool_calls",
          calls: [call],
          continuation: { providerId: "glm-5.3-flash", kind: "reasoning_content", content: "keep this for GLM" },
        },
      }),
      event(4, { type: "tool.call.completed", result: { callId: call.id, status: "completed", output: { ok: true } } }),
    ];
    const input = await new DefaultContextCompiler(createDefaultComputerTools()).compile({ runId, goal: "continue", recentEvents: events, latestObservation: first }, new AbortController().signal);
    expect(input.messages.some((message) => message.content.some((block) => block.type === "provider_continuation" && block.continuation.content === "keep this for GLM"))).toBe(true);
  });

  it("injects the latest run plan after user corrections", async () => {
    const latest = observation("obs-plan");
    const events: RuntimeEvent[] = [
      event(0, { type: "run.created", goal: "ignored" }),
      event(1, { type: "run.started" }),
      event(2, { type: "observation.created", observation: latest }),
      event(3, { type: "user.input.received", text: "Use the other document" }),
    ];
    const input = await new DefaultContextCompiler(createDefaultComputerTools()).compile({
      runId,
      goal: "finish the document",
      recentEvents: events,
      latestObservation: latest,
      plan: { runId, tasks: [{ id: "task-1", subject: "Open Writer", description: "Use the other document", status: "in_progress" }] },
    }, new AbortController().signal);
    const planIndex = input.messages.findIndex((message) => message.content.some((block) => block.type === "text" && block.text.includes("Current run plan")));
    const correctionIndex = input.messages.findIndex((message) => message.content.some((block) => block.type === "text" && block.text === "Use the other document"));
    expect(planIndex).toBeGreaterThan(correctionIndex);
    expect(input.messages[planIndex]?.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("task-1") });
  });

  it("keeps complete tool history while summarizing only unfinished plan phases", async () => {
    const latest = observation("obs-plan-summary");
    const call = { id: "call-plan-summary" as ToolCallId, name: "task_update", arguments: { taskId: "t2", status: "in_progress" } };
    const input = await new DefaultContextCompiler(createDefaultComputerTools()).compile({
      runId,
      goal: "finish the document",
      recentEvents: [
        event(0, { type: "run.created", goal: "ignored" }),
        event(1, { type: "run.started" }),
        event(2, { type: "observation.created", observation: latest }),
        event(3, { type: "model.response.received", turn: { type: "tool_calls", calls: [call] } }),
        event(4, { type: "tool.call.completed", result: { callId: call.id, status: "completed", output: { task: { id: "t2", status: "in_progress" } } } }),
      ],
      latestObservation: latest,
      plan: {
        runId,
        tasks: [
          { id: "t1", subject: "Collect source", status: "completed" },
          { id: "t2", subject: "Write report", description: "Save the unfinished report", status: "in_progress" },
        ],
      },
    }, new AbortController().signal);
    const planText = input.messages
      .flatMap((message) => message.content)
      .find((block) => block.type === "text" && block.text.includes("Current run plan"));
    expect(planText).toMatchObject({ type: "text", text: expect.stringContaining("t2"), });
    expect(planText).toMatchObject({ type: "text", text: expect.not.stringContaining("t1: Collect source") });
    expect(input.messages.some((message) => message.content.some((block) => block.type === "tool_call" && block.call.id === call.id))).toBe(true);
    expect(input.messages.some((message) => message.content.some((block) => block.type === "tool_result" && block.result.callId === call.id))).toBe(true);
  });

  it("supports a bounded recent-history mode without dropping the latest image or call/result pair", async () => {
    const latest = observation("obs-recent");
    const oldCall = { id: "call-old" as ToolCallId, name: "click", arguments: { x: 10, y: 20 } };
    const newCall = { id: "call-new" as ToolCallId, name: "click", arguments: { x: 30, y: 40 } };
    const events: RuntimeEvent[] = [
      event(0, { type: "run.created", goal: "ignored" }),
      event(1, { type: "run.started" }),
      event(2, { type: "observation.created", observation: latest }),
      event(3, { type: "model.response.received", turn: { type: "tool_calls", calls: [oldCall] } }),
      event(4, { type: "tool.call.completed", result: { callId: oldCall.id, status: "completed", output: { ok: true } } }),
      event(5, { type: "model.response.received", turn: { type: "tool_calls", calls: [newCall] } }),
      event(6, { type: "tool.call.completed", result: { callId: newCall.id, status: "completed", output: { ok: true } } }),
    ];
    const input = await new DefaultContextCompiler(createDefaultComputerTools(), { mode: "recent", maxHistoryEvents: 3 }).compile({
      runId, goal: "recent", recentEvents: events, latestObservation: latest,
    }, new AbortController().signal);
    expect(input.contextBudget?.mode).toBe("recent");
    expect(input.contextBudget?.omittedHistoryEvents).toBeGreaterThan(0);
    expect(input.messages.some((message) => message.content.some((block) => block.type === "tool_call" && block.call.id === oldCall.id))).toBe(false);
    expect(input.messages.some((message) => message.content.some((block) => block.type === "tool_call" && block.call.id === newCall.id))).toBe(true);
    expect(input.messages.some((message) => message.content.some((block) => block.type === "tool_result" && block.result.callId === newCall.id))).toBe(true);
    expect(input.messages.some((message) => message.content.some((block) => block.type === "image" && block.asset.assetId === latest.screenshot.assetId))).toBe(true);
  });

  it("keeps authoritative user corrections while evicting a complete older call group", async () => {
    const latest = observation("obs-correction");
    const oldCall = { id: "call-old-correction" as ToolCallId, name: "click", arguments: { x: 10, y: 20 } };
    const newCall = { id: "call-new-correction" as ToolCallId, name: "click", arguments: { x: 30, y: 40 } };
    const events: RuntimeEvent[] = [
      event(0, { type: "observation.created", observation: latest }),
      event(1, { type: "model.response.received", turn: { type: "tool_calls", calls: [oldCall], assistantText: "x".repeat(5_000) } }),
      event(2, { type: "tool.call.received", call: oldCall }),
      event(3, { type: "user.input.received", text: "Do not send the order" }),
      event(4, { type: "tool.call.completed", result: { callId: oldCall.id, status: "completed", output: { ok: true } } }),
      event(5, { type: "model.response.received", turn: { type: "tool_calls", calls: [newCall] } }),
      event(6, { type: "tool.call.received", call: newCall }),
      event(7, { type: "tool.call.completed", result: { callId: newCall.id, status: "completed", output: { ok: true } } }),
    ];
    const compiler = new DefaultContextCompiler(createDefaultComputerTools(), { mode: "recent", maxHistoryEvents: 20 });
    const base = await compiler.compile({ runId, goal: "Submit a form", recentEvents: [] }, new AbortController().signal);
    const maxInputTokens = base.contextBudget!.estimatedFixedTextTokens! + 250;
    const input = await compiler.compile({
      runId,
      goal: "Submit a form",
      recentEvents: events,
      context: { mode: "recent", maxHistoryEvents: 20, maxInputTokens: maxInputTokens },
      latestObservation: latest,
    }, new AbortController().signal);
    const serialized = JSON.stringify(input.messages);
    expect(serialized).toContain("Do not send the order");
    expect(serialized).toContain(newCall.id);
    expect(serialized).not.toContain(oldCall.id);
    expect(input.contextBudget?.estimatedInputTokens).toBeLessThanOrEqual(maxInputTokens);
  });

  it("evicts a multi-call response as one complete group while retaining correction and the newer group", async () => {
    const latest = observation("obs-multi-call-correction");
    const oldCallOne = { id: "call-old-one" as ToolCallId, name: "click", arguments: { x: 10, y: 20 } };
    const oldCallTwo = { id: "call-old-two" as ToolCallId, name: "type", arguments: { text: "old" } };
    const newCall = { id: "call-new-complete" as ToolCallId, name: "click", arguments: { x: 30, y: 40 } };
    const events: RuntimeEvent[] = [
      event(0, { type: "observation.created", observation: latest }),
      event(1, { type: "model.response.received", turn: { type: "tool_calls", calls: [oldCallOne, oldCallTwo], assistantText: "x".repeat(5_000) } }),
      event(2, { type: "tool.call.received", call: oldCallOne }),
      event(3, { type: "user.input.received", text: "Keep the revised destination and do not send the old order" }),
      event(4, { type: "tool.call.received", call: oldCallTwo }),
      event(5, { type: "tool.call.completed", result: { callId: oldCallOne.id, status: "completed", output: { ok: true } } }),
      event(6, { type: "tool.call.completed", result: { callId: oldCallTwo.id, status: "completed", output: { ok: true } } }),
      event(7, { type: "model.response.received", turn: { type: "tool_calls", calls: [newCall] } }),
      event(8, { type: "tool.call.received", call: newCall }),
      event(9, { type: "tool.call.completed", result: { callId: newCall.id, status: "completed", output: { ok: true } } }),
    ];
    const compiler = new DefaultContextCompiler(createDefaultComputerTools(), { mode: "recent", maxHistoryEvents: 20 });
    const base = await compiler.compile({ runId, goal: "Submit the revised form", recentEvents: [] }, new AbortController().signal);
    const maxInputTokens = base.contextBudget!.estimatedFixedTextTokens! + 250;
    const input = await compiler.compile({
      runId,
      goal: "Submit the revised form",
      recentEvents: events,
      context: { mode: "recent", maxHistoryEvents: 20, maxInputTokens },
      latestObservation: latest,
    }, new AbortController().signal);
    const serialized = JSON.stringify(input.messages);
    expect(serialized).toContain("Keep the revised destination and do not send the old order");
    expect(serialized).toContain(newCall.id);
    expect(serialized).not.toContain(oldCallOne.id);
    expect(serialized).not.toContain(oldCallTwo.id);
    expect(input.messages.some((message) => message.content.some((block) => block.type === "tool_result" && block.result.callId === oldCallOne.id))).toBe(false);
    expect(input.messages.some((message) => message.content.some((block) => block.type === "tool_result" && block.result.callId === oldCallTwo.id))).toBe(false);
    expect(input.messages.some((message) => message.content.some((block) => block.type === "tool_result" && block.result.callId === newCall.id))).toBe(true);
    expect(input.contextBudget?.estimatedInputTokens).toBeLessThanOrEqual(maxInputTokens);
  });

  it("rejects one oversized authoritative history event instead of passing it through", async () => {
    const compiler = new DefaultContextCompiler(createDefaultComputerTools());
    const base = await compiler.compile({ runId, goal: "small goal", recentEvents: [] }, new AbortController().signal);
    const maxInputTokens = base.contextBudget!.estimatedFixedTextTokens! + 100;
    await expect(compiler.compile({
      runId,
      goal: "small goal",
      recentEvents: [event(0, { type: "user.input.received", text: "x".repeat(8_000) })],
      context: { maxInputTokens },
    }, new AbortController().signal)).rejects.toThrow(/authoritative|budget/i);
  });

  it("evicts one oversized optional model event as a complete group", async () => {
    const compiler = new DefaultContextCompiler(createDefaultComputerTools());
    const base = await compiler.compile({ runId, goal: "small goal", recentEvents: [] }, new AbortController().signal);
    const maxInputTokens = base.contextBudget!.estimatedFixedTextTokens! + 100;
    const input = await compiler.compile({
      runId,
      goal: "small goal",
      recentEvents: [event(0, { type: "model.response.received", turn: { type: "finish", summary: "x".repeat(8_000) } })],
      context: { maxInputTokens },
    }, new AbortController().signal);
    expect(JSON.stringify(input.messages)).not.toContain("x".repeat(100));
    expect(input.contextBudget?.omittedHistoryEvents).toBe(1);
    expect(input.contextBudget?.estimatedInputTokens).toBeLessThanOrEqual(maxInputTokens);
  });

  it("rejects an oversized fixed block even when history is empty", async () => {
    const compiler = new DefaultContextCompiler(createDefaultComputerTools());
    await expect(compiler.compile({
      runId,
      goal: "x".repeat(8_000),
      recentEvents: [],
      context: { maxInputTokens: 100 },
    }, new AbortController().signal)).rejects.toThrow(/fixed.*exceed|maxInputTokens/i);
  });

  it("injects only active Run Memory facts and keeps memory absent when empty", async () => {
    const latest = observation("obs-memory");
    const compiler = new DefaultContextCompiler(createDefaultComputerTools());
    const base = { runId, goal: "continue", recentEvents: [event(0, { type: "observation.created", observation: latest })] };
    const withMemory = await compiler.compile({
      ...base,
      memory: {
        runId,
        facts: [
          { id: "m1", subject: { type: "run" }, key: "target_file", value: "report.odt", sourceEventId: "event-1" as EventId, status: "active", updatedSequence: 1 },
          { id: "m2", subject: { type: "run" }, key: "old", value: "ignore", sourceEventId: "event-2" as EventId, status: "superseded", updatedSequence: 2 },
        ],
        entities: [],
      },
    }, new AbortController().signal);
    expect(withMemory.messages.some((message) => message.content.some((block) => block.type === "text" && block.text.includes("target_file")))).toBe(true);
    expect(withMemory.messages.some((message) => message.content.some((block) => block.type === "text" && block.text.includes("old = ignore")))).toBe(false);
    const empty = await compiler.compile(base, new AbortController().signal);
    expect(empty.messages.some((message) => message.content.some((block) => block.type === "text" && block.text.includes("Current run memory")))).toBe(false);
  });

  it("ranks memory by active task relevance, status and recency with bounded hot selection", () => {
    const memory = {
      runId,
      facts: [
        { id: "old", subject: { type: "run" as const }, key: "old", value: "1", sourceEventId: "e1" as EventId, status: "active" as const, updatedSequence: 1 },
        { id: "task", subject: { type: "run" as const }, key: "task", value: "2", sourceEventId: "e2" as EventId, status: "active" as const, relatedTaskIds: ["t1"], updatedSequence: 2 },
        { id: "check", subject: { type: "run" as const }, key: "check", value: "3", sourceEventId: "e3" as EventId, status: "needs_check" as const, updatedSequence: 3 },
      ],
      entities: [],
    };
    const selection = selectMemoryForContext(memory, { runId, tasks: [{ id: "t1", subject: "active phase", status: "in_progress" }] }, { maxIndexFacts: 2, maxHotFacts: 1 });
    expect(selection.indexFacts.map((fact) => fact.id)).toEqual(["task", "old"]);
    expect(selection.hotFacts.map((fact) => fact.id)).toEqual(["task"]);
    expect(selection.revalidationCandidates.map((candidate) => candidate.fact.id)).toEqual(["check"]);
  });

  it("composes feature-specific instructions without leaking disabled planning or batch semantics", async () => {
    const latest = observation("obs-features");
    const compiler = new DefaultContextCompiler(createDefaultComputerTools(), {
      features: { planning: "off", memory: "off", batching: "off" },
    });
    const off = await compiler.compile({ runId, goal: "baseline", recentEvents: [{ ...event(0, { type: "observation.created", observation: latest }) }], features: { planning: "off", memory: "off", batching: "off" } }, new AbortController().signal);
    expect(off.system).not.toContain("Planning tools");
    expect(off.system).not.toContain("Run Memory");
    expect(off.system).toContain("finish.summary is the user-facing answer");
    expect(off.system).toContain("Do not return only a status");
    expect(off.system).not.toContain("recalled Run Memory");
    expect(off.system).toContain("at most one Computer tool call");
    expect(off.system).not.toContain("same ModelTurn");
    expect(off.system).not.toContain("first GUI action");
    const batch = await compiler.compile({ runId, goal: "batch", recentEvents: [{ ...event(0, { type: "observation.created", observation: latest }) }], features: { planning: "tasks-v1", executionSegments: "segments-v1", memory: "facts-v1", batching: "same-control-input-v1" } }, new AbortController().signal);
    expect(batch.system).toContain("same ModelTurn as the first GUI action");
    expect(batch.system).toContain("one handoff-sized current phase");
    expect(batch.system).toContain("do not copy the original Goal");
    expect(batch.system).toContain("task_update with status completed followed by task_create");
    expect(batch.system).toContain("exactly the next handoff-sized phase");
    expect(batch.system).toContain("at most two Planning/Memory writes total");
    expect(batch.system).toContain("1-2 key facts in the same ModelTurn");
    expect(batch.system).toContain("do not write task-retention Memory");
    expect(batch.system).toContain("relatedTaskIds");
    expect(batch.system).toContain("same-turn writes alongside GUI");
    expect(batch.system).toContain("state writes");
    expect(batch.system).toContain("click→type");
    expect(batch.system).toContain("2-4 predictable click micro-steps");
    expect(batch.system).toContain("Call it immediately before the first GUI click");
    expect(batch.system).toContain("Do not create one for a simple one-click screen or every click");
    expect(batch.system).toContain("never use it for type/keypress/scroll/drag/wait");
    const planningOnly = await compiler.compile({ runId, goal: "planning only", recentEvents: [{ ...event(0, { type: "observation.created", observation: latest }) }], features: { planning: "tasks-v1", memory: "off", batching: "same-control-input-v1" } }, new AbortController().signal);
    expect(planningOnly.system).toContain("same ModelTurn as the first GUI action");
    expect(planningOnly.system).toContain("do not copy the original Goal");
    expect(planningOnly.system).not.toContain("Run Memory");
    expect(planningOnly.system).not.toContain("1-2 key facts");
    expect(planningOnly.system).not.toContain("2-4 predictable click micro-steps");
    const memoryOnly = await compiler.compile({ runId, goal: "memory only", recentEvents: [{ ...event(0, { type: "observation.created", observation: latest }) }], features: { planning: "off", memory: "facts-v1", batching: "same-control-input-v1" } }, new AbortController().signal);
    expect(memoryOnly.system).toContain("leave recent context");
    expect(memoryOnly.system).toContain("1-2 key facts in the same ModelTurn");
    expect(memoryOnly.system).toContain("Do not copy the original Goal or Plan");
    expect(memoryOnly.system).toContain("do not write task-retention Memory");
    expect(memoryOnly.system).toContain("relatedTaskIds");
    expect(memoryOnly.system).not.toContain("Planning tools");
    const guarded = await compiler.compile({ runId, goal: "guard", recentEvents: [{ ...event(0, { type: "observation.created", observation: latest }) }], features: { planning: "off", memory: "off", batching: "off", riskGuard: "layered" } }, new AbortController().signal);
    expect(guarded.system).toContain("_harnessEffect");
    expect(guarded.tools.find((tool) => tool.category === "computer")?.inputSchema).toMatchObject({ required: expect.arrayContaining(["_harnessEffect"]) });
    expect(guarded.tools.find((tool) => tool.category === "control")?.inputSchema).not.toMatchObject({ required: expect.arrayContaining(["_harnessEffect"]) });
  });

  it("keeps the completion contract aware of recalled Memory without requiring another model call", async () => {
    const latest = observation("obs-completion-memory");
    const compiler = new DefaultContextCompiler(createDefaultComputerTools());
    const input = await compiler.compile({
      runId,
      goal: "report the observed route and its caveats",
      recentEvents: [event(0, { type: "observation.created", observation: latest })],
      latestObservation: latest,
      memory: {
        runId,
        facts: [{
          id: "route-fact",
          subject: { type: "run" },
          key: "route",
          value: "Observed route; verify before acting",
          sourceEventId: "event-route" as EventId,
          status: "active",
          updatedSequence: 1,
        }],
        entities: [],
      },
    }, new AbortController().signal);

    expect(input.system).toContain("recalled Run Memory");
    expect(input.system).toContain("preserve their caveats");
    expect(JSON.stringify(input.messages)).toContain("route-fact");
    expect(input.messages.some((message) => message.content.some((block) => block.type === "text" && block.text.includes("Current run memory")))).toBe(true);
  });

  it("recalls active entity facts through the normalized subject link and hides stale entities", () => {
    const selection = selectMemoryForContext({
      runId,
      entities: [
        { id: "e1", type: "document", description: "report.odt", sourceEventId: "e1-source" as EventId, status: "active", updatedSequence: 2 },
        { id: "e2", type: "document", description: "old.odt", sourceEventId: "e2-source" as EventId, status: "stale", updatedSequence: 3 },
      ],
      facts: [
        { id: "f1", subject: { type: "entity", entityId: "e1" }, key: "saved", value: "false", sourceEventId: "f1-source" as EventId, status: "active", updatedSequence: 4 },
        { id: "f2", subject: { type: "entity", entityId: "e2" }, key: "saved", value: "true", sourceEventId: "f2-source" as EventId, status: "active", updatedSequence: 5 },
      ],
    }, undefined);
    expect(selection.indexFacts.map((fact) => fact.id)).toEqual(["f1"]);
    expect(selection.indexEntities.map((entity) => entity.id)).toEqual(["e1"]);
  });

  it("separates admitted, revalidation and excluded facts by scope/status", async () => {
    const selection = selectMemoryForContext({
      runId,
      entities: [{ id: "stale", type: "window", description: "old", sourceEventId: "entity-source" as EventId, status: "stale", updatedSequence: 1 }],
      facts: [
        { id: "stable", subject: { type: "run" }, key: "stable", value: "ok", sourceEventId: "stable-source" as EventId, status: "active", retentionClass: "stable", updatedSequence: 1 },
        { id: "short", subject: { type: "run" }, key: "short", value: "last", sourceEventId: "short-source" as EventId, status: "active", retentionClass: "short_lived", updatedSequence: 2 },
        { id: "check", subject: { type: "run" }, key: "check", value: "recheck", sourceEventId: "check-source" as EventId, status: "needs_check", statusReason: "manual_review", updatedSequence: 3 },
        { id: "wrong-session", subject: { type: "run" }, key: "wrong", value: "old", sourceEventId: "wrong-source" as EventId, status: "active", scope: { kind: "computer_session", sessionId: "other-session" as ComputerSessionId }, updatedSequence: 4 },
        { id: "stale-fact", subject: { type: "entity", entityId: "stale" }, key: "state", value: "old", sourceEventId: "stale-source" as EventId, status: "active", updatedSequence: 5 },
      ],
    }, undefined, {}, { runId, computerSessionId: sessionId });
    expect(selection.admittedFacts.map((fact) => fact.id)).toEqual(["stable"]);
    expect(selection.revalidationCandidates.map((candidate) => [candidate.fact.id, candidate.reason])).toEqual([["check", "needs_check"], ["short", "short_lived_last_known"]]);
    expect(selection.hotFacts.map((fact) => fact.id)).toEqual(["stable"]);
    expect(selection.excluded).toEqual(expect.arrayContaining([
      { kind: "fact", id: "wrong-session", reason: "scope_mismatch" },
      { kind: "fact", id: "stale-fact", reason: "entity_stale" },
      { kind: "entity", id: "stale", reason: "entity_stale" },
    ]));

    const compiler = new DefaultContextCompiler(createDefaultComputerTools());
    const compiled = await compiler.compile({
      runId,
      goal: "recheck",
      recentEvents: [event(0, { type: "observation.created", observation: observation("scope-observation") })],
      latestObservation: observation("scope-observation"),
      memory: { runId, facts: [...selection.admittedFacts, ...selection.revalidationCandidates.map((candidate) => candidate.fact)], entities: [], },
    }, new AbortController().signal);
    expect(compiled.contextBudget?.trace?.memorySelection).toMatchObject({ admittedFactIds: ["stable"], revalidationFactIds: ["check", "short"] });
    expect(compiled.messages.some((message) => message.content.some((block) => block.type === "text" && block.text.includes("Revalidation candidates")))).toBe(true);
  });

  it("keeps the compact entity index closed over selected entity facts", () => {
    const selection = selectMemoryForContext({
      runId,
      entities: [
        { id: "e-old", type: "document", description: "old", sourceEventId: "e-old-source" as EventId, status: "active", updatedSequence: 1 },
        { id: "e-hot", type: "document", description: "hot", sourceEventId: "e-hot-source" as EventId, status: "active", updatedSequence: 2 },
      ],
      facts: [{ id: "f-hot", subject: { type: "entity", entityId: "e-hot" }, key: "saved", value: "false", sourceEventId: "f-hot-source" as EventId, status: "active", updatedSequence: 3 }],
    }, undefined, { maxIndexFacts: 1, maxIndexEntities: 1, maxHotFacts: 1, maxHotEntities: 1 });
    expect(selection.indexFacts.map((fact) => fact.id)).toEqual(["f-hot"]);
    expect(selection.indexEntities.map((entity) => entity.id)).toEqual(["e-hot"]);
  });

  it("emits a safe trace for partitions, authority, stable prefix, and history裁剪", async () => {
    const compiler = new DefaultContextCompiler(createDefaultComputerTools(), { mode: "recent", maxHistoryEvents: 2 });
    const events = [
      event(0, { type: "run.started" }),
      event(1, { type: "user.input.received", text: "不要上传文件" }),
      event(2, { type: "model.response.received", turn: { type: "finish", summary: "old" } }),
      event(3, { type: "user.input.received", text: "继续查看" }),
    ];
    const first = await compiler.compile({ runId, goal: "goal one", recentEvents: events }, new AbortController().signal);
    const second = await compiler.compile({ runId, goal: "goal two", recentEvents: events }, new AbortController().signal);
    const trace = first.contextBudget?.trace;
    expect(trace).toMatchObject({ compilerVersion: "context-v2-rft4", runId, observationIncluded: false });
    expect(trace?.authoritativeUserEventIds).toEqual(["event-1", "event-3"]);
    expect(trace?.selectedEventIds).toContain("event-1");
    expect(trace?.projectedEventIds).toEqual(expect.arrayContaining(["event-1", "event-2", "event-3"]));
    expect(trace?.projectedEventIds).not.toContain("event-0");
    expect(trace?.discardedEvents).toEqual(expect.arrayContaining([{ eventId: "event-0", reason: "history_limit" }]));
    expect(trace?.stablePrefixHash).toBe(second.contextBudget?.trace?.stablePrefixHash);
    expect(trace?.stablePrefixHash).not.toContain("goal one");
  });

  it("projects user preferences late, keeps them below explicit requests, redacts trace, and accounts for budget", async () => {
    const compiler = new DefaultContextCompiler(createDefaultComputerTools());
    const latest = observation("assistant-preferences-observation");
    const preferences: RunAssistantPreferencesSnapshot = Object.freeze({
      version: 1,
      responseDetail: "detailed",
      stepExplanation: "more",
      preferredLanguage: "zh-CN",
      additionalGuidance: "Group the findings by topic.",
    });
    const input = await compiler.compile({
      runId,
      goal: "Give me a one sentence answer in English.",
      recentEvents: [
        event(0, { type: "user.input.received", text: "Correction: keep the answer in English and use one sentence." }),
        event(1, { type: "observation.created", observation: latest }),
      ],
      latestObservation: latest,
      assistantPreferences: preferences,
    }, new AbortController().signal);
    const preferenceMessage = input.messages[1]!;
    const preferenceTextBlock = preferenceMessage.content.find((block) => block.type === "text");
    const preferenceText = preferenceTextBlock?.type === "text" ? preferenceTextBlock.text : "";
    expect(preferenceMessage.role).toBe("user");
    expect(preferenceText).toContain("Give a thorough, organized final reply");
    expect(preferenceText).toContain("clear ordered steps");
    expect(preferenceText).toContain("Use Simplified Chinese");
    expect(preferenceText).toContain('"Group the findings by topic."');
    expect(preferenceText).toContain("explicit current user requests, later corrections");
    const correctionMessageIndex = input.messages.findIndex((message) => message.content.some((block) => block.type === "text" && block.text.includes("Correction: keep the answer")));
    expect(correctionMessageIndex).toBeGreaterThan(input.messages.indexOf(preferenceMessage));
    expect(input.messages.at(-1)?.content.some((block) => block.type === "image")).toBe(true);
    expect(input.system).toContain("Optional user response preferences");
    expect(input.system).not.toContain("Group the findings by topic.");
    const trace = input.contextBudget?.trace;
    expect(trace?.assistantPreferences).toMatchObject({
      projectionVersion: 1,
      included: true,
      estimatedTokens: Math.ceil(preferenceText.length / 4),
      responseDetail: "detailed",
      stepExplanation: "more",
      preferredLanguage: "zh-CN",
      additionalGuidancePresent: true,
      additionalGuidanceCharacters: "Group the findings by topic.".length,
      additionalGuidanceSha256: createHash("sha256").update("Group the findings by topic.", "utf8").digest("hex"),
    });
    expect(JSON.stringify(trace)).not.toContain("Group the findings by topic.");

    const changedPreferences = Object.freeze({ ...preferences, responseDetail: "concise" as const, additionalGuidance: "Keep the answer short." });
    const changed = await compiler.compile({
      runId,
      goal: "Give me a one sentence answer in English.",
      recentEvents: [
        event(0, { type: "user.input.received", text: "Correction: keep the answer in English and use one sentence." }),
        event(1, { type: "observation.created", observation: latest }),
      ],
      latestObservation: latest,
      assistantPreferences: changedPreferences,
    }, new AbortController().signal);
    expect(changed.contextBudget?.trace?.stablePrefixHash).toBe(trace?.stablePrefixHash);

    const base = await compiler.compile({ runId, goal: "budget", recentEvents: [] }, new AbortController().signal);
    const withPreferences = await compiler.compile({
      runId,
      goal: "budget",
      recentEvents: [],
      assistantPreferences: { ...preferences, additionalGuidance: "Long guidance. ".repeat(30) },
    }, new AbortController().signal);
    const candidateTokens = withPreferences.contextBudget?.trace?.assistantPreferences?.estimatedTokens ?? 0;
    expect(withPreferences.contextBudget?.estimatedInputTokens).toBe(base.contextBudget?.estimatedInputTokens! + candidateTokens);
    const omitted = await compiler.compile({
      runId,
      goal: "budget",
      recentEvents: [],
      assistantPreferences: { ...preferences, additionalGuidance: "Long guidance. ".repeat(30) },
      context: { maxInputTokens: base.contextBudget!.estimatedFixedTextTokens! + candidateTokens - 1 },
    }, new AbortController().signal);
    expect(omitted.contextBudget?.trace?.assistantPreferences).toMatchObject({ included: false, omittedReason: "budget", estimatedTokens: candidateTokens });
    expect(omitted.contextBudget?.estimatedInputTokens).toBe(base.contextBudget?.estimatedInputTokens);
    expect(JSON.stringify(omitted.messages)).not.toContain("Long guidance.");
    expect(omitted.contextBudget?.trace?.stablePrefixHash).toBe(trace?.stablePrefixHash);
  });

  it("omits preferences before reducing authoritative corrections or the current observation", async () => {
    const compiler = new DefaultContextCompiler(createDefaultComputerTools());
    const goal = "Continue with the user's correction.";
    const latest = observation("preference-budget-current-observation");
    const preferences = {
      version: 1 as const,
      responseDetail: "detailed" as const,
      stepExplanation: "more" as const,
      preferredLanguage: "zh-CN" as const,
      additionalGuidance: "Preserve the user's exact wording.",
    };
    const base = await compiler.compile({ runId, goal, recentEvents: [] }, new AbortController().signal);
    const preferenceOnly = await compiler.compile({ runId, goal, recentEvents: [], assistantPreferences: preferences }, new AbortController().signal);
    const preferenceTokens = preferenceOnly.contextBudget?.trace?.assistantPreferences?.estimatedTokens ?? 0;
    const correction = "Correction: " + "Keep the answer in English and exactly one sentence. ".repeat(8);
    const correctionEvent = event(0, { type: "user.input.received", text: correction });
    const correctionTokens = estimateEventTokens([correctionEvent]);
    const maxInputTokens = base.contextBudget!.estimatedFixedTextTokens! + correctionTokens + preferenceTokens - 1;
    expect(preferenceTokens).toBeLessThan(maxInputTokens - base.contextBudget!.estimatedFixedTextTokens!);
    expect(correctionTokens).toBeLessThan(maxInputTokens - base.contextBudget!.estimatedFixedTextTokens!);

    const compiled = await compiler.compile({
      runId,
      goal,
      recentEvents: [correctionEvent, event(1, { type: "observation.created", observation: latest })],
      latestObservation: latest,
      assistantPreferences: preferences,
      context: { maxInputTokens },
    }, new AbortController().signal);
    expect(compiled.contextBudget?.trace?.assistantPreferences).toMatchObject({
      included: false,
      omittedReason: "budget",
      estimatedTokens: preferenceTokens,
      additionalGuidancePresent: true,
    });
    expect(compiled.contextBudget?.estimatedInputTokens).toBeLessThanOrEqual(maxInputTokens);
    expect(compiled.messages.some((message) => message.content.some((block) => block.type === "text" && block.text === correction))).toBe(true);
    expect(compiled.messages.some((message) => message.content.some((block) => block.type === "image" && block.asset.assetId === latest.screenshot.assetId))).toBe(true);
    expect(JSON.stringify(compiled.contextBudget?.trace)).not.toContain("Preserve the user's exact wording.");
    expect(JSON.stringify(compiled.messages)).not.toContain("Preserve the user's exact wording.");
  });

  it("charges projected ObservationAssessment text against event and input budgets", async () => {
    const compiler = new DefaultContextCompiler(createDefaultComputerTools());
    const assessmentEvent = event(0, {
      type: "model.response.received",
      turn: {
        type: "finish",
        summary: "A bounded summary.",
        observationAssessment: {
          observationId: "assessment-observation",
          actionId: "assessment-action",
          actionOutcome: "uncertain",
          evidence: "e".repeat(240),
          progress: { kind: "blocked", summary: "p".repeat(160) },
        },
      },
    });
    const base = await compiler.compile({ runId, goal: "assessment budget", recentEvents: [] }, new AbortController().signal);
    const projected = await compiler.compile({ runId, goal: "assessment budget", recentEvents: [assessmentEvent] }, new AbortController().signal);
    const assistantMessage = projected.messages.find((message) => message.role === "assistant")!;
    const projectedTextCharacters = assistantMessage.content
      .filter((block) => block.type === "text")
      .reduce((total, block) => total + (block.type === "text" ? block.text.length : 0), 0);
    const estimatedEventTokens = estimateEventTokens([assessmentEvent]);
    expect(estimatedEventTokens).toBe(Math.ceil(projectedTextCharacters / 4));
    expect(projected.contextBudget?.estimatedHistoryTextTokens).toBe(estimatedEventTokens);

    const omitted = await compiler.compile({
      runId,
      goal: "assessment budget",
      recentEvents: [assessmentEvent],
      context: { maxInputTokens: base.contextBudget!.estimatedFixedTextTokens! + estimatedEventTokens - 1 },
    }, new AbortController().signal);
    expect(omitted.contextBudget?.trace?.discardedEvents).toContainEqual({ eventId: assessmentEvent.eventId, reason: "input_budget" });
    expect(JSON.stringify(omitted.messages)).not.toContain("e".repeat(80));
    expect(omitted.contextBudget?.estimatedInputTokens).toBeLessThanOrEqual(omitted.contextBudget?.maxInputTokens!);
  });

  it("keeps Memory under its soft quota while retaining authoritative input", async () => {
    const compiler = new DefaultContextCompiler(createDefaultComputerTools(), { memoryMaxTokens: 32 });
    const memory = {
      runId,
      facts: Array.from({ length: 12 }, (_, index) => ({
        id: `fact-${index}`,
        subject: { type: "run" as const },
        key: `key-${index}`,
        value: "值".repeat(20),
        sourceEventId: `event-${index}` as EventId,
        status: "active" as const,
        updatedSequence: index,
      })),
      entities: [],
    };
    const input = await compiler.compile({
      runId,
      goal: "continue",
      recentEvents: [event(0, { type: "user.input.received", text: "不要上传文件" })],
      memory,
      context: { memoryMaxTokens: 32 },
    }, new AbortController().signal);
    const memoryMessage = input.messages.find((message) => message.content.some((block) => block.type === "text" && block.text.includes("Current run memory index")));
    expect(memoryMessage).toBeDefined();
    expect(JSON.stringify(memoryMessage)).toContain("memory truncated; query by id");
    expect(input.contextBudget?.estimatedMemoryTokens).toBeLessThanOrEqual(32);
    expect(JSON.stringify(input.messages)).toContain("不要上传文件");
    expect(input.contextBudget?.trace?.authoritativeUserEventIds).toEqual(["event-0"]);

    const tiny = await compiler.compile({
      runId,
      goal: "continue",
      recentEvents: [],
      memory,
      context: { memoryMaxTokens: 1 },
    }, new AbortController().signal);
    expect(tiny.contextBudget?.trace?.memoryTruncated).toBe(true);
    expect(tiny.contextBudget?.estimatedMemoryTokens).toBe(0);
    expect(JSON.stringify(tiny.messages)).not.toContain("fact-0");
    expect(tiny.contextBudget?.trace?.memorySelection?.selectedAdmittedFactIds?.length).toBeGreaterThan(0);
    expect(tiny.contextBudget?.trace?.memorySelection?.admittedFactIds).toEqual([]);
    expect(tiny.contextBudget?.trace?.memorySelection?.omitted?.length).toBeGreaterThan(0);
  });

  it("does not report entity-only tiny-budget omissions as fact IDs", async () => {
    const compiler = new DefaultContextCompiler(createDefaultComputerTools());
    const tiny = await compiler.compile({
      runId,
      goal: "entity only",
      recentEvents: [],
      memory: {
        runId,
        facts: [],
        entities: [{ id: "entity-only", type: "window", description: "fixture", sourceEventId: "entity-source" as EventId, status: "active", updatedSequence: 1 }],
      },
      context: { memoryMaxTokens: 1 },
    }, new AbortController().signal);
    expect(tiny.contextBudget?.trace?.memorySelection?.omitted ?? []).toEqual([]);
    expect(tiny.contextBudget?.trace?.memorySelection?.selectedAdmittedFactIds ?? []).toEqual([]);
    expect(JSON.stringify(tiny.contextBudget?.trace?.memorySelection)).not.toContain("entity-only");
  });

  it("keeps Memory ToolResult partitions visible to the next Provider context", async () => {
    const compiler = new DefaultContextCompiler(createDefaultComputerTools());
    const toolResult = {
      admittedFacts: [{ id: "stable-fact", key: "target", value: "current" }],
      revalidationCandidates: [{ fact: { id: "last-known-fact", key: "target", value: "old" }, reason: "short_lived_last_known" }],
      entities: [],
    };
    const compiled = await compiler.compile({
      runId,
      goal: "inspect memory",
      recentEvents: [
        event(0, { type: "model.response.received", turn: { type: "tool_calls", calls: [{ id: "memory-call" as ToolCallId, name: "memory_get", arguments: { id: "last-known-fact" } }] } }),
        event(1, { type: "tool.call.completed", result: { callId: "memory-call" as ToolCallId, status: "completed", output: toolResult } }),
      ],
    }, new AbortController().signal);
    const serializedMessages = JSON.stringify(compiled.messages);
    expect(serializedMessages).toContain("admittedFacts");
    expect(serializedMessages).toContain("revalidationCandidates");
    expect(serializedMessages).not.toContain('"facts"');
  });

  it("does not charge non-projected Trace metadata to the model history budget", async () => {
    const compiler = new DefaultContextCompiler(createDefaultComputerTools());
    const base = await compiler.compile({ runId, goal: "budget", recentEvents: [] }, new AbortController().signal);
    const input = await compiler.compile({
      runId,
      goal: "budget",
      recentEvents: [event(0, {
        type: "model.request.started",
        providerId: "provider-test",
        preparedRequest: { payloadHash: "x".repeat(10_000) },
        contextBudget: {
          mode: "raw",
          estimatedInputTokens: 99_999,
          selectedHistoryEvents: 0,
          omittedHistoryEvents: 0,
          trace: {
            compilerVersion: "test",
            runId,
            stablePrefixHash: "trace-only".repeat(2_000),
            fixedBlocks: [],
            selectedEventIds: [],
            projectedEventIds: [],
            discardedEvents: [],
            authoritativeUserEventIds: [],
            historyEstimatedTokens: 0,
            observationIncluded: false,
          },
        },
      })],
      context: { maxInputTokens: base.contextBudget!.estimatedFixedTextTokens! + 1 },
    }, new AbortController().signal);
    expect(input.contextBudget?.estimatedHistoryTextTokens).toBe(0);
    expect(input.contextBudget?.estimatedInputTokens).toBeLessThanOrEqual(base.contextBudget!.estimatedFixedTextTokens! + 1);
  });

  it("keeps Monitor guidance dynamic and omits it when the input budget cannot admit it", async () => {
    const compiler = new DefaultContextCompiler(createDefaultComputerTools(), { features: { planning: "off", memory: "off", batching: "off", monitor: "guidance" } });
    const guidance = { text: "Review the current state before continuing.", fingerprint: "monitor-fingerprint" };
    const withGuidance = await compiler.compile({
      runId,
      goal: "goal",
      recentEvents: [],
      features: { planning: "off", memory: "off", batching: "off", monitor: "guidance" },
      monitorGuidance: guidance,
    }, new AbortController().signal);
    expect(JSON.stringify(withGuidance.messages)).toContain("Review the current state before continuing.");
    expect(withGuidance.contextBudget?.monitorGuidanceIncluded).toBe(true);
    expect(withGuidance.contextBudget?.trace?.monitorGuidanceIncluded).toBe(true);
    const base = await compiler.compile({ runId, goal: "goal", recentEvents: [], features: { planning: "off", memory: "off", batching: "off", monitor: "guidance" } }, new AbortController().signal);
    const omitted = await compiler.compile({
      runId,
      goal: "goal",
      recentEvents: [],
      features: { planning: "off", memory: "off", batching: "off", monitor: "guidance" },
      monitorGuidance: guidance,
      context: { maxInputTokens: base.contextBudget!.estimatedFixedTextTokens! + 1 },
    }, new AbortController().signal);
    expect(JSON.stringify(omitted.messages)).not.toContain("Review the current state before continuing.");
    expect(omitted.contextBudget?.monitorGuidanceIncluded).toBe(false);
    expect(omitted.contextBudget?.trace?.monitorGuidanceOmittedReason).toBe("budget");
  });

  it("uses the injected recall ranking in the actual ModelInput without treating tool results as user corrections", async () => {
    const queries: Array<{ originalGoal: string; latestUserCorrections?: readonly string[] }> = [];
    const recall = {
      async search(_state: MemoryState, query: { originalGoal: string; latestUserCorrections?: readonly string[] }) {
        queries.push(query);
        return {
          method: "lexical" as const,
          semanticStatus: "disabled" as const,
          stateStable: true,
          embeddingBudgetUsed: 0,
          embeddingBudgetLimit: 6,
          admitted: [
            { id: "preferred", score: 1, match: "lexical" as const },
            { id: "secondary", score: 0.5, match: "lexical" as const },
          ],
          revalidation: [],
          excluded: [],
        };
      },
    };
    const memory: MemoryState = {
      runId,
      facts: [
        { id: "secondary", subject: { type: "run" }, key: "secondary", value: "second", sourceEventId: "memory-secondary" as EventId, status: "active", scope: { kind: "run" }, retentionClass: "stable", updatedSequence: 2 },
        { id: "preferred", subject: { type: "run" }, key: "preferred", value: "first", sourceEventId: "memory-preferred" as EventId, status: "active", scope: { kind: "run" }, retentionClass: "stable", updatedSequence: 1 },
      ],
      entities: [],
    };
    const compiler = new DefaultContextCompiler(createDefaultComputerTools(), {
      memoryRecall: recall,
      features: { planning: "off", memory: "facts-v1", batching: "off" },
    });
    const compiled = await compiler.compile({
      runId,
      goal: "original goal",
      recentEvents: [
        event(1, { type: "user.input.received", text: "latest correction" }),
        event(2, { type: "tool.call.completed", result: { callId: "tool-result" as ToolCallId, status: "completed", output: { text: "untrusted tool result" } } }),
      ],
      memory,
      features: { planning: "off", memory: "facts-v1", batching: "off" },
    }, new AbortController().signal);
    const memoryText = compiled.messages.map((message) => JSON.stringify(message)).find((text) => text.includes("Current run memory")) ?? "";
    expect(memoryText.indexOf("preferred")).toBeGreaterThanOrEqual(0);
    expect(memoryText.indexOf("secondary")).toBeGreaterThan(memoryText.indexOf("preferred"));
    expect(queries).toEqual([{ runId, originalGoal: "original goal", latestUserCorrections: ["latest correction"] }]);
    expect(compiled.contextBudget?.trace?.memoryRetrieval).toMatchObject({ method: "lexical", semanticStatus: "disabled" });
    expect(compiled.contextBudget?.trace?.memoryRetrieval?.admitted).toEqual(expect.arrayContaining([{ id: "preferred", score: 1, match: "lexical" }]));
  });
});
