import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  createRunCancellationControl,
  isHarnessCancellationMessage,
  type RunCancellationControlSource,
} from "./run-cancellation-control.js";

function sourceWithIpc() {
  const source = new EventEmitter() as EventEmitter & RunCancellationControlSource;
  source.send = () => true;
  source.connected = true;
  source.disconnect = vi.fn(() => { source.connected = false; });
  return source;
}

describe("CLI run cancellation control", () => {
  it("accepts only the exact harness cancellation message shape", () => {
    expect(isHarnessCancellationMessage({ type: "harness.cancel", reason: "run-timeout" })).toBe(true);
    expect(isHarnessCancellationMessage({ type: "harness.cancel", reason: "run-timeout", goal: "ignored" })).toBe(false);
    expect(isHarnessCancellationMessage({ type: "harness.cancel", reason: "user-input" })).toBe(false);
    expect(isHarnessCancellationMessage(null)).toBe(false);
    expect(isHarnessCancellationMessage(["harness.cancel", "run-timeout"])).toBe(false);
  });

  it("queues cancellation until the controller starts and keeps handlers through cleanup", () => {
    const source = sourceWithIpc();
    const control = createRunCancellationControl(source)!;
    const cancel = vi.fn();

    expect(source.listenerCount("SIGINT")).toBe(1);
    expect(source.listenerCount("message")).toBe(1);
    source.emit("message", { type: "harness.cancel", reason: "run-timeout", goal: "ignored" });
    expect(cancel).not.toHaveBeenCalled();
    source.emit("message", { type: "harness.cancel", reason: "run-timeout" });
    control.bindCancelController(cancel);
    expect(cancel).not.toHaveBeenCalled();

    control.markControllerStarted();
    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith("cancelled by harness parent after run timeout");

    source.emit("SIGINT");
    source.emit("message", { type: "harness.cancel", reason: "run-timeout" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(source.listenerCount("SIGINT")).toBe(1);
    expect(source.listenerCount("message")).toBe(1);

    control.dispose();
    expect(source.listenerCount("SIGINT")).toBe(0);
    expect(source.listenerCount("message")).toBe(0);
    expect(source.disconnect).toHaveBeenCalledOnce();
    source.emit("SIGINT");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("leaves processes without an IPC channel on their existing cancellation path", () => {
    const source = new EventEmitter() as EventEmitter & RunCancellationControlSource;
    expect(createRunCancellationControl(source)).toBeUndefined();
    expect(source.listenerCount("SIGINT")).toBe(0);
    expect(source.listenerCount("message")).toBe(0);
  });
});
