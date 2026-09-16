import { describe, expect, it } from "vitest";
import type { ActionId, EventId, ObservationId, RunId, RuntimeEvent } from "@computer-harness/protocol";
import { initialRunSnapshot } from "@computer-harness/trajectory";
import { buildTuiFrame } from "./tui.js";

describe("TUI renderer", () => {
  it("renders status and does not expose typed action content", () => {
    const runId = "tui-run" as RunId;
    const snapshot = { ...initialRunSnapshot(runId), status: "running" as const };
    const events: RuntimeEvent[] = [{
      eventId: "event-1" as EventId,
      runId,
      sequence: 0,
      occurredAt: "2026-09-16T00:00:00.000Z",
      type: "action.execution.started" as const,
      action: { actionId: "action-1" as ActionId, kind: "type" as const, text: "private-value", basedOn: "observation-1" as ObservationId },
      executionObservationId: "observation-1" as ObservationId,
    }];
    const frame = buildTuiFrame(snapshot, events, "safe goal", { provider: "qwen", computer: "cua", output: "runs/test" }, { editMode: false, input: "", notice: "" });
    expect(frame).toContain("action.started: type");
    expect(frame).not.toContain("private-value");
  });
});
