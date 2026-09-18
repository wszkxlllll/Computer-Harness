import { describe, expect, it } from "vitest";
import type {
  AssetId,
  ComputerSessionId,
  EventId,
  ObservationId,
  RunId,
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
    expect(off.system).toContain("at most one Computer tool call");
    const batch = await compiler.compile({ runId, goal: "batch", recentEvents: [{ ...event(0, { type: "observation.created", observation: latest }) }], features: { planning: "tasks-v1", memory: "facts-v1", batching: "same-control-input-v1" } }, new AbortController().signal);
    expect(batch.system).toContain("state writes");
    expect(batch.system).toContain("click→type");
    const guarded = await compiler.compile({ runId, goal: "guard", recentEvents: [{ ...event(0, { type: "observation.created", observation: latest }) }], features: { planning: "off", memory: "off", batching: "off", riskGuard: "layered" } }, new AbortController().signal);
    expect(guarded.system).toContain("_harnessEffect");
    expect(guarded.tools.find((tool) => tool.category === "computer")?.inputSchema).toMatchObject({ required: expect.arrayContaining(["_harnessEffect"]) });
    expect(guarded.tools.find((tool) => tool.category === "control")?.inputSchema).not.toMatchObject({ required: expect.arrayContaining(["_harnessEffect"]) });
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
});
