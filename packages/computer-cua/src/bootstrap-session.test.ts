import { describe, expect, it, vi } from "vitest";

const driverMock = vi.hoisted(() => ({ connect: vi.fn() }));

vi.mock("@trycua/cua-driver", () => ({
  CuaDriver: { connect: driverMock.connect },
  EndSessionInput: { new: (value: { session: string }) => value },
  StartSessionInput: { new: (value: { session: string }) => value },
}));

import { CuaBootstrapSessionError, openCuaBootstrapSession } from "./managed-browser-host.js";

function fixture(fixtureOptions: {
  readonly startError?: Error;
  readonly endError?: Error;
  readonly shutdownError?: Error;
  readonly neverEnd?: boolean;
  readonly neverShutdown?: boolean;
  readonly destroyError?: Error;
} = {}) {
  const calls: {
    start: number;
    end: number;
    shutdown: number;
    destroy: number;
    startInput?: unknown;
    startSignal?: AbortSignal;
    endInput?: unknown;
    endSignal?: AbortSignal;
    order: string[];
  } = { start: 0, end: 0, shutdown: 0, destroy: 0, order: [] };
  const driver = {
    async startSession(input: unknown, callOptions?: { signal?: AbortSignal }) {
      calls.start += 1;
      calls.order.push("start");
      calls.startInput = input;
      if (callOptions?.signal !== undefined) calls.startSignal = callOptions.signal;
      if (fixtureOptions.startError !== undefined) throw fixtureOptions.startError;
    },
    async endSession(input: unknown, callOptions?: { signal?: AbortSignal }) {
      calls.end += 1;
      calls.order.push("end");
      calls.endInput = input;
      if (callOptions?.signal !== undefined) calls.endSignal = callOptions.signal;
      if (fixtureOptions.endError !== undefined) throw fixtureOptions.endError;
      if (fixtureOptions.neverEnd === true) await new Promise<void>(() => undefined);
    },
    async shutdown(callOptions?: { signal?: AbortSignal }) {
      calls.shutdown += 1;
      calls.order.push("shutdown");
      if (callOptions?.signal === undefined) throw new TypeError("shutdown signal missing");
      if (fixtureOptions.shutdownError !== undefined) throw fixtureOptions.shutdownError;
      if (fixtureOptions.neverShutdown === true) await new Promise<void>(() => undefined);
    },
    uniffiDestroy() {
      calls.destroy += 1;
      calls.order.push("destroy");
      if (fixtureOptions.destroyError !== undefined) throw fixtureOptions.destroyError;
    },
  };
  driverMock.connect.mockReturnValue(driver);
  return { calls, driver };
}

describe("Cua bootstrap session cleanup certainty", () => {
  it("closes a started session once and keeps successful close idempotent", async () => {
    const rig = fixture();
    const session = await openCuaBootstrapSession("fixture.sock", "fixture-session", new AbortController().signal);

    await session.close();
    await session.close();

    expect(rig.calls).toMatchObject({
      start: 1,
      end: 1,
      shutdown: 1,
      destroy: 1,
      startInput: { session: "fixture-session" },
      endInput: { session: "fixture-session" },
    });
    expect(rig.calls.startSignal).toBeInstanceOf(AbortSignal);
    expect(rig.calls.endSignal).toBeInstanceOf(AbortSignal);
    expect(rig.calls.order).toEqual(["start", "end", "shutdown", "destroy"]);
  });

  it("surfaces endSession rejection and preserves the same rejected close result", async () => {
    const endError = new Error("endSession rejected");
    const rig = fixture({ endError });
    const session = await openCuaBootstrapSession("fixture.sock", "fixture-session", new AbortController().signal);

    const firstClose = session.close();
    const secondClose = session.close();
    expect(secondClose).toBe(firstClose);
    await expect(firstClose).rejects.toMatchObject({
      name: "CuaBootstrapSessionError",
      cleanupCertainty: "unknown",
      cause: endError,
    });
    expect(rig.calls).toMatchObject({ start: 1, end: 1, shutdown: 1, destroy: 1 });
  });

  it("attempts endSession after startSession rejects and confirms cleanup only when end succeeds", async () => {
    const startError = new Error("startSession response was lost");
    const rig = fixture({ startError });

    await expect(openCuaBootstrapSession("fixture.sock", "fixture-session", new AbortController().signal)).rejects.toMatchObject({
      name: "CuaBootstrapSessionError",
      cleanupCertainty: "confirmed",
      cause: startError,
    });
    expect(rig.calls).toMatchObject({ start: 1, end: 1, shutdown: 1, destroy: 1 });
  });

  it("keeps start failure cleanup unknown when the compensating endSession also rejects", async () => {
    const startError = new Error("startSession response was lost");
    const endError = new Error("endSession rejected");
    const rig = fixture({ startError, endError });

    const error = await openCuaBootstrapSession("fixture.sock", "fixture-session", new AbortController().signal).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: "CuaBootstrapSessionError", cleanupCertainty: "unknown" });
    expect((error as CuaBootstrapSessionError).cause).toBeInstanceOf(AggregateError);
    expect(((error as CuaBootstrapSessionError).cause as AggregateError).errors).toEqual([startError, endError]);
    expect(rig.calls).toMatchObject({ start: 1, end: 1, shutdown: 1, destroy: 1 });
  });

  it("bounds an unresolved endSession attempt and reports cleanup as unknown", async () => {
    vi.useFakeTimers();
    const startError = new Error("startSession response was lost");
    const rig = fixture({ startError, neverEnd: true });
    try {
      const opening = openCuaBootstrapSession("fixture.sock", "fixture-session", new AbortController().signal);
      const settled = opening.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await settled;
      expect(result).toHaveProperty("error", expect.objectContaining({ name: "CuaBootstrapSessionError", cleanupCertainty: "unknown" }));
      expect(rig.calls).toMatchObject({ start: 1, end: 1, shutdown: 1, destroy: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports local driver destruction failure even after endSession succeeds", async () => {
    const destroyError = new Error("driver destroy failed");
    const rig = fixture({ destroyError });
    const session = await openCuaBootstrapSession("fixture.sock", "fixture-session", new AbortController().signal);

    await expect(session.close()).rejects.toMatchObject({ name: "CuaBootstrapSessionError", cleanupCertainty: "unknown" });
    expect(rig.calls).toMatchObject({ start: 1, end: 1, shutdown: 1, destroy: 1 });
  });

  it("does not destroy the native handle if shutdown cannot be confirmed", async () => {
    vi.useFakeTimers();
    const rig = fixture({ neverShutdown: true });
    try {
      const session = await openCuaBootstrapSession("fixture.sock", "fixture-session", new AbortController().signal);
      const closing = session.close();
      const settled = closing.then(() => ({ ok: true }), (error: unknown) => ({ error }));
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(settled).resolves.toMatchObject({ error: { name: "CuaBootstrapSessionError", cleanupCertainty: "unknown" } });
      expect(rig.calls).toMatchObject({ start: 1, end: 1, shutdown: 1, destroy: 0 });
    } finally {
      vi.useRealTimers();
    }
  });
});
