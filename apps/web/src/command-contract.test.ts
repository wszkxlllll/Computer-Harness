import { describe, expect, it } from "vitest";
import {
  approvalCommand,
  canIgnoreWindow,
  controlCommand,
  correctionCommand,
  ignoreWindowCommand,
  responseCommand,
  windowChoiceCommand,
} from "./command-contract";
import type { RunSnapshot } from "./types";

function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: "run-1",
    goal: "Find three options",
    status: "waiting_approval",
    sequence: 28,
    capabilities: { pause: true, resume: false, abort: true, correct: true, approval: true, windowHandoff: true },
    ...overrides,
  };
}

describe("request-bound commands", () => {
  it("binds approval to the current request and event sequence", () => {
    const current = snapshot({ pendingRequest: { requestId: "approval-2", kind: "approval", reason: "Open the result" } });
    expect(approvalCommand(current, "approval-2", true)).toEqual({
      expectedSequence: 28,
      type: "approve",
      requestId: "approval-2",
    });
    expect(approvalCommand(current, "approval-1", true)).toBeUndefined();
    expect(approvalCommand(snapshot({ capabilities: { approval: false } }), "approval-2", true)).toBeUndefined();
  });

  it("accepts only the current user-input request", () => {
    const current = snapshot({
      status: "waiting_user",
      pendingRequest: { requestId: "input-3", kind: "user_input", question: "Which date?" },
    });
    expect(responseCommand(current, "input-3", "  Friday  ")).toEqual({
      expectedSequence: 28,
      type: "respond",
      requestId: "input-3",
      text: "Friday",
    });
    expect(responseCommand(current, "input-2", "Friday")).toBeUndefined();
    expect(responseCommand(current, "input-3", " ")).toBeUndefined();
  });

  it("accepts only a currently listed window token and request", () => {
    const current = snapshot({
      status: "waiting_window",
      pendingRequest: {
        requestId: "window-7",
        kind: "window_handoff",
        reasonCode: "foreground_mismatch",
        candidates: [{ token: "candidate-1", appName: "Browser", title: "Search results" }],
      },
    });
    expect(windowChoiceCommand(current, "window-7", "candidate-1")).toEqual({
      expectedSequence: 28,
      type: "window.confirm",
      requestId: "window-7",
      candidateToken: "candidate-1",
    });
    expect(windowChoiceCommand(current, "window-6", "candidate-1")).toBeUndefined();
    expect(windowChoiceCommand(current, "window-7", "expired-candidate")).toBeUndefined();
  });

  it("allows ignoring only a newly detected incidental window", () => {
    const newWindow = snapshot({
      status: "waiting_window",
      pendingRequest: { requestId: "window-8", kind: "window_handoff", reasonCode: "new_window_detected" },
    });
    const foregroundMismatch = snapshot({
      status: "waiting_window",
      pendingRequest: { requestId: "window-9", kind: "window_handoff", reasonCode: "foreground_mismatch" },
    });
    expect(canIgnoreWindow(newWindow.pendingRequest!)).toBe(true);
    expect(ignoreWindowCommand(newWindow, "window-8")).toEqual({ expectedSequence: 28, type: "window.ignore", requestId: "window-8" });
    expect(ignoreWindowCommand(newWindow, "window-old")).toBeUndefined();
    expect(canIgnoreWindow(foregroundMismatch.pendingRequest!)).toBe(false);
    expect(ignoreWindowCommand(foregroundMismatch, "window-9")).toBeUndefined();
  });

  it("checks advertised capabilities before exposing controls or corrections", () => {
    const current = snapshot({ status: "running" });
    expect(controlCommand(current, "pause")).toEqual({ expectedSequence: 28, type: "pause" });
    expect(controlCommand(current, "resume")).toBeUndefined();
    expect(correctionCommand(current, "  Change the date  ")).toEqual({ expectedSequence: 28, type: "correct", text: "Change the date" });
    expect(correctionCommand(snapshot({ pendingRequest: { requestId: "approval-2", kind: "approval" } }), "change")).toBeUndefined();
  });
});
