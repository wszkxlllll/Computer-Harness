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
import { DefaultContextCompiler } from "./index.js";

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
    const input = await compiler.compile({ goal: "open the app", recentEvents: events, latestObservation: latest }, new AbortController().signal);
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
  });

  it("rejects a shortcut that disagrees with the latest observation event and honors cancellation", async () => {
    const latest = observation("obs-latest");
    const other = observation("obs-other");
    const compiler = new DefaultContextCompiler(createDefaultComputerTools());
    const events = [event(0, { type: "observation.created", observation: latest })];
    await expect(compiler.compile({ goal: "goal", recentEvents: events, latestObservation: other }, new AbortController().signal)).rejects.toThrow(/latestObservation/);
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(compiler.compile({ goal: "goal", recentEvents: events }, controller.signal)).rejects.toThrow("cancelled");
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
    const input = await new DefaultContextCompiler(createDefaultComputerTools()).compile({ goal: "continue", recentEvents: events, latestObservation: first }, new AbortController().signal);
    expect(input.messages.some((message) => message.content.some((block) => block.type === "provider_continuation" && block.continuation.content === "keep this for GLM"))).toBe(true);
  });
});
