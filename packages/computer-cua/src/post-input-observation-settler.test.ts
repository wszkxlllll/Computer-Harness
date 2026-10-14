import { describe, expect, it } from "vitest";
import { settlePostInputObservation } from "./post-input-observation-settler.js";

describe("settlePostInputObservation", () => {
  it("waits from the input completion timestamp and returns only after two identical final PNGs", async () => {
    let clock = 0;
    const waits: number[] = [];
    const captureTimes: number[] = [];
    const samples = [
      { png: Uint8Array.of(1), value: "partial" },
      { png: Uint8Array.of(2), value: "settled" },
      { png: Uint8Array.of(2), value: "settled-latest" },
    ];
    let sampleIndex = 0;

    const value = await settlePostInputObservation({
      inputCompletedAt: 0,
      signal: new AbortController().signal,
      now: () => clock,
      wait: async (durationMs, signal) => {
        signal.throwIfAborted();
        waits.push(durationMs);
        clock += durationMs;
      },
      capture: async () => {
        captureTimes.push(clock);
        const sample = samples[sampleIndex++]!;
        clock += 25;
        return sample;
      },
    });

    expect(waits).toEqual([1_500, 250, 250]);
    expect(captureTimes).toEqual([1_500, 1_775, 2_050]);
    expect(value).toBe("settled-latest");
  });

  it("does not add the minimum grace again when earlier Computer work already consumed it", async () => {
    let clock = 1_800;
    const waits: number[] = [];
    const captureTimes: number[] = [];
    let captureCount = 0;

    const value = await settlePostInputObservation({
      inputCompletedAt: 0,
      signal: new AbortController().signal,
      now: () => clock,
      wait: async (durationMs, signal) => {
        signal.throwIfAborted();
        waits.push(durationMs);
        clock += durationMs;
      },
      capture: async () => {
        captureTimes.push(clock);
        captureCount += 1;
        clock += 25;
        return { png: Uint8Array.of(3), value: `frame-${captureCount}` };
      },
    });

    expect(waits).toEqual([250]);
    expect(captureTimes).toEqual([1_800, 2_075]);
    expect(value).toBe("frame-2");
  });

  it("returns the latest frame at the finite deadline when the screen keeps changing", async () => {
    let clock = 0;
    let captureCount = 0;
    const waits: number[] = [];

    const value = await settlePostInputObservation({
      inputCompletedAt: 0,
      signal: new AbortController().signal,
      now: () => clock,
      wait: async (durationMs, signal) => {
        signal.throwIfAborted();
        waits.push(durationMs);
        clock += durationMs;
      },
      capture: async () => {
        captureCount += 1;
        clock += 50;
        return { png: Uint8Array.of(captureCount), value: `frame-${captureCount}` };
      },
    });

    expect(clock).toBe(3_000);
    expect(captureCount).toBe(5);
    expect(value).toBe("frame-5");
    expect(waits).toEqual([1_500, 250, 250, 250, 250, 250]);
  });

  it("propagates Abort during the minimum delay before taking any frame", async () => {
    const controller = new AbortController();
    const reason = new Error("settling aborted");
    let captures = 0;

    await expect(settlePostInputObservation({
      inputCompletedAt: 0,
      signal: controller.signal,
      now: () => 0,
      wait: async (_durationMs, signal) => {
        controller.abort(reason);
        signal.throwIfAborted();
      },
      capture: async () => {
        captures += 1;
        return { png: Uint8Array.of(1), value: "not-returned" };
      },
    })).rejects.toBe(reason);

    expect(captures).toBe(0);
  });

  it("does not swallow Abort that arrives while a capture callback is completing", async () => {
    const controller = new AbortController();
    const reason = new Error("capture aborted");

    await expect(settlePostInputObservation({
      inputCompletedAt: 2_000,
      signal: controller.signal,
      now: () => 2_000,
      wait: async (_durationMs, signal) => signal.throwIfAborted(),
      capture: async () => {
        controller.abort(reason);
        return { png: Uint8Array.of(1), value: "not-returned" };
      },
    })).rejects.toBe(reason);
  });
});
