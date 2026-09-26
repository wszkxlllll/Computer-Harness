// @vitest-environment happy-dom
import { StrictMode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { establishPairSession, getPairRequest, getPhoneSession, setPhoneCsrfToken } from "./api";
import { PairingScreen } from "./PairingScreen";
import { ApiError, type PairRequestStatus, type PairSession } from "./types";

vi.mock("./api", async (importOriginal) => {
  const api = await importOriginal<typeof import("./api")>();
  return {
    ...api,
    establishPairSession: vi.fn(),
    getPairRequest: vi.fn(),
    getPhoneSession: vi.fn(),
    setPhoneCsrfToken: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("phone pairing screen", () => {
  it("keeps an approved session request alive in StrictMode and stops after connecting", async () => {
    vi.useFakeTimers();
    setStoredRequest("request-approved");
    const session = deferred<PairSession>();
    vi.mocked(getPairRequest).mockResolvedValue(pairStatus("approved"));
    vi.mocked(establishPairSession).mockReturnValue(session.promise);

    render(<StrictMode><PairingScreen /></StrictMode>);
    await flushEffects();

    expect(getPairRequest).toHaveBeenCalledTimes(1);
    expect(establishPairSession).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(getPairRequest).toHaveBeenCalledTimes(1);

    await act(async () => {
      session.resolve(phoneSession());
      await session.promise;
    });
    expect(screen.getByRole("heading", { name: "手机已连接" })).toBeDefined();
    expect(setPhoneCsrfToken).toHaveBeenCalledWith("csrf-token");
    expect(window.sessionStorage.getItem("harness-pair-request")).toBeNull();
    expect(new URL(window.location.href).searchParams.has("request")).toBe(false);

    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(getPairRequest).toHaveBeenCalledTimes(1);

    cleanup();
    vi.mocked(getPhoneSession).mockResolvedValue(phoneSession());
    render(<PairingScreen />);
    await flushEffects();
    expect(screen.getByRole("heading", { name: "手机已连接" })).toBeDefined();
    expect(getPhoneSession).toHaveBeenCalledTimes(1);
    expect(getPairRequest).toHaveBeenCalledTimes(1);
  });

  it("waits for each slow status request before starting the next poll", async () => {
    vi.useFakeTimers();
    setStoredRequest("request-slow");
    const firstPoll = deferred<PairRequestStatus>();
    vi.mocked(getPairRequest)
      .mockReturnValueOnce(firstPoll.promise)
      .mockResolvedValue(pairStatus("pending_local_confirmation"));

    render(<PairingScreen />);
    await flushEffects();
    expect(getPairRequest).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(getPairRequest).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstPoll.resolve(pairStatus("pending_local_confirmation"));
      await firstPoll.promise;
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(1599); });
    expect(getPairRequest).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(getPairRequest).toHaveBeenCalledTimes(2);
  });

  it("shares a late in-flight status response across unmount and remount", async () => {
    vi.useFakeTimers();
    setStoredRequest("request-remount");
    const lateStatus = deferred<PairRequestStatus>();
    const session = deferred<PairSession>();
    vi.mocked(getPairRequest).mockReturnValue(lateStatus.promise);
    vi.mocked(establishPairSession).mockReturnValue(session.promise);

    const firstMount = render(<PairingScreen />);
    await flushEffects();
    expect(getPairRequest).toHaveBeenCalledTimes(1);

    firstMount.unmount();
    render(<PairingScreen />);
    await flushEffects();
    expect(getPairRequest).toHaveBeenCalledTimes(1);

    await act(async () => {
      lateStatus.resolve(pairStatus("approved"));
      await lateStatus.promise;
    });
    expect(establishPairSession).toHaveBeenCalledTimes(1);

    await act(async () => {
      session.resolve(phoneSession());
      await session.promise;
    });
    expect(screen.getByRole("heading", { name: "手机已连接" })).toBeDefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(getPairRequest).toHaveBeenCalledTimes(1);
    expect(establishPairSession).toHaveBeenCalledTimes(1);
  });

  it("joins a pending session after remount instead of polling a consumed request", async () => {
    vi.useFakeTimers();
    setStoredRequest("request-consuming");
    const session = deferred<PairSession>();
    vi.mocked(getPairRequest)
      .mockResolvedValueOnce(pairStatus("approved", "request-consuming"))
      .mockRejectedValue(new ApiError("pairing_request_not_found", 404));
    vi.mocked(establishPairSession).mockReturnValue(session.promise);

    const firstMount = render(<PairingScreen />);
    await flushEffects();
    expect(getPairRequest).toHaveBeenCalledTimes(1);
    expect(establishPairSession).toHaveBeenCalledTimes(1);

    firstMount.unmount();
    render(<PairingScreen />);
    await flushEffects();
    expect(getPairRequest).toHaveBeenCalledTimes(1);
    expect(establishPairSession).toHaveBeenCalledTimes(1);

    await act(async () => {
      session.resolve(phoneSession());
      await session.promise;
    });
    expect(screen.getByRole("heading", { name: "手机已连接" })).toBeDefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(getPairRequest).toHaveBeenCalledTimes(1);
    expect(establishPairSession).toHaveBeenCalledTimes(1);
  });
});

function setStoredRequest(requestId: string) {
  window.sessionStorage.setItem("harness-pair-request", requestId);
  window.history.replaceState(null, "", `/pair?request=${encodeURIComponent(requestId)}`);
}

function pairStatus(status: PairRequestStatus["status"], requestId = "request-test"): PairRequestStatus {
  return { requestId, status, expiresAt: "2026-09-27T00:00:00.000Z" };
}

function phoneSession(): PairSession {
  return { csrfToken: "csrf-token", expiresAt: "2026-09-27T00:00:00.000Z" };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
