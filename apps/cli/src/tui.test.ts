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
    const frame = buildTuiFrame(snapshot, events, "safe goal", { provider: "qwen", computer: "cua", output: "runs/test", profile: "live-interactive", riskGuard: "layered" }, { editMode: false, input: "", notice: "" });
    expect(frame).toContain("action.started: type");
    expect(frame).not.toContain("private-value");
  });

  it("strips terminal control sequences from untrusted UI text while retaining Chinese text", () => {
    const runId = "tui-terminal-run" as RunId;
    const snapshot = { ...initialRunSnapshot(runId), status: "running" as const };
    const injected = "中文\u001b[2J\u001b]0;FAKE-TITLE\u0007\u001b[31m\u001b[?25l\u2028line\u2029paragraph\u061cmark";
    const events: RuntimeEvent[] = [{
      eventId: "event-terminal" as EventId,
      runId,
      sequence: 0,
      occurredAt: "2026-09-16T00:00:00.000Z",
      type: "runtime.error" as const,
      category: injected,
      message: injected,
    }];
    const frame = buildTuiFrame(snapshot, events, injected, { provider: injected, computer: "cua", output: injected, profile: "live-interactive", riskGuard: "layered" }, { editMode: false, input: "", notice: injected });
    expect(frame).toContain("中文");
    expect(frame).not.toContain("\u001b");
    expect(frame).not.toContain("FAKE-TITLE");
    expect(frame).not.toContain("\u2028");
    expect(frame).not.toContain("\u2029");
    expect(frame).not.toContain("\u061c");
  });

  it("renders the resolved profile and actual Guard mode", () => {
    const runId = "tui-profile-run" as RunId;
    const frame = buildTuiFrame({ ...initialRunSnapshot(runId), status: "running" as const }, [], "safe goal", {
      provider: "glm",
      computer: "cua",
      output: "runs/test",
      profile: "live-interactive",
      riskGuard: "layered",
    }, { editMode: false, input: "", notice: "" });
    expect(frame).toContain("Profile: live-interactive");
    expect(frame).toContain("Risk Guard: ENABLED (layered)");
  });
});
