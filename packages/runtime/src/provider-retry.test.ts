import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComputerSession, ModelInput, ProviderAdapter } from "./contracts.js";
import { DefaultContextCompiler } from "../../context/src/index.js";
import { FileAssetStore, JsonlRunEventWriter } from "@computer-harness/trajectory";
import type { Computer, ComputerOpenOptions } from "./contracts.js";
import { createDefaultComputerTools, DefaultRuntimePolicy, RunController } from "./index.js";
import type { ComputerSessionId, EventId, ObservationId, RunId, SurfaceId, ToolCallId, Viewport } from "@computer-harness/protocol";

const viewport: Viewport = { width: 800, height: 600, coordinateSpace: "physical" };
const runId = "ark-provider-retry-test" as RunId;
const desktopSurface = { surfaceId: "ark-retry-desktop" as SurfaceId, generation: 1, kind: "desktop" as const };

class RetryTestComputer implements Computer {
  public executeCount = 0;
  private readonly session: ComputerSession = {
    id: "ark-retry-computer" as ComputerSessionId,
    backend: "fake",
    viewport,
    capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false },
    openedAt: "2026-10-18T00:00:00.000Z",
  };

  public async open(_options: ComputerOpenOptions, signal: AbortSignal): Promise<ComputerSession> {
    signal.throwIfAborted();
    return this.session;
  }

  public async observe(_session: ComputerSession, _observationId: ObservationId, signal: AbortSignal) {
    signal.throwIfAborted();
    return {
      capturedAt: "2026-10-18T00:00:00.000Z",
      viewport,
      surfaceRef: desktopSurface,
      screenshot: { mediaType: "image/png" as const, data: new Uint8Array([1]) },
    };
  }

  public async execute(_session: ComputerSession, action: import("@computer-harness/protocol").ActionIntent, signal: AbortSignal) {
    signal.throwIfAborted();
    this.executeCount += 1;
    return { actionId: action.actionId, status: "completed" as const };
  }

  public async close(_session: ComputerSession): Promise<void> {}
}

function arkRateLimitError(retryAfterMs: number, retryAfterState: "absent" | "invalid" | "accepted" | "too_long" = "accepted") {
  return Object.assign(new Error("Ark HTTP 429: Request rate limit exceeded."), {
    name: "ArkProviderError",
    code: "ARK_HTTP_429",
    retryable: true,
    retryMode: "same_input" as const,
    httpFailure: {
      httpStatus: 429,
      providerErrorCode: "TooManyRequests",
      providerErrorMessage: "Request rate limit exceeded.",
      retryAfterState,
      ...(retryAfterState === "accepted" ? { retryAfterMs } : {}),
    },
  });
}

async function createController(provider: ProviderAdapter, providerAttemptReserveMs = 90_000, runTimeoutMs?: number, finishReserveMs?: number) {
  const directory = await mkdtemp(join(tmpdir(), "harness-ark-provider-retry-"));
  const eventPath = join(directory, "trajectory.jsonl");
  let eventNumber = 0;
  const registry = createDefaultComputerTools();
  const computer = new RetryTestComputer();
  const controller = new RunController({
    runId,
    provider,
    computer,
    contextCompiler: new DefaultContextCompiler(registry, {
      features: { planning: "off", memory: "off", batching: "off" },
    }),
    toolRegistry: registry,
    policy: new DefaultRuntimePolicy(10, 10),
    providerAttemptReserveMs,
    ...(runTimeoutMs === undefined ? {} : { runTimeoutMs }),
    ...(finishReserveMs === undefined ? {} : { finishReserveMs }),
    eventWriter: new JsonlRunEventWriter(eventPath, runId, { next: () => `retry-event-${eventNumber++}` as EventId }),
    assetStore: new FileAssetStore(join(directory, "assets")),
  });
  return { controller, computer, directory };
}

function makeProvider(run: (input: ModelInput, requestNumber: number) => Promise<import("@computer-harness/protocol").ModelTurn> | import("@computer-harness/protocol").ModelTurn) {
  let calls = 0;
  const inputs: ModelInput[] = [];
  const provider: ProviderAdapter = {
    id: "deepseek-v4.1-flash",
    generate: async (input, { signal }) => {
      signal.throwIfAborted();
      inputs.push(input);
      return run(input, ++calls);
    },
  };
  return { provider, inputs, calls: () => calls };
}

afterEach(() => { vi.useRealTimers(); });

describe("bounded Ark provider retry delay", () => {
  it("honors Retry-After beyond the old delay cap, keeps same_input unchanged, and retains one retry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let resolveTimerRegistered!: () => void;
    const timerRegistered = new Promise<void>((resolve) => { resolveTimerRegistered = resolve; });
    const originalSetTimeout = globalThis.setTimeout;
    const timerSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
      if (delay === 6_000) resolveTimerRegistered();
      return originalSetTimeout(callback, delay, ...args);
    });
    const scripted = makeProvider((input, requestNumber) => {
      if (requestNumber === 1) throw arkRateLimitError(6_000);
      return { type: "finish", summary: "done" };
    });
    const created = await createController(scripted.provider);
    const running = created.controller.start("same request fixture");

    try {
      await timerRegistered;
      expect(scripted.calls()).toBe(1);
      await vi.advanceTimersByTimeAsync(5_999);
      expect(scripted.calls()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(running).resolves.toBe("succeeded");
      expect(scripted.calls()).toBe(2);
      expect(scripted.inputs[1]).toBe(scripted.inputs[0]);
      expect(created.controller.getEvents().filter((event) => event.type === "model.request.started")).toHaveLength(2);
    } finally {
      timerSpy.mockRestore();
      vi.useRealTimers();
      await rm(created.directory, { recursive: true, force: true });
    }
  });

  it("uses a two-second bounded delay when Ark supplies no Retry-After", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let resolveTimerRegistered!: () => void;
    const timerRegistered = new Promise<void>((resolve) => { resolveTimerRegistered = resolve; });
    const originalSetTimeout = globalThis.setTimeout;
    const timerSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
      if (delay === 2_000) resolveTimerRegistered();
      return originalSetTimeout(callback, delay, ...args);
    });
    const scripted = makeProvider((_input, requestNumber) => {
      if (requestNumber === 1) throw arkRateLimitError(0, "absent");
      return { type: "finish", summary: "done" };
    });
    const created = await createController(scripted.provider);
    const running = created.controller.start("default Ark delay fixture");
    try {
      await timerRegistered;
      expect(scripted.calls()).toBe(1);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(running).resolves.toBe("succeeded");
      expect(scripted.calls()).toBe(2);
    } finally {
      timerSpy.mockRestore();
      vi.useRealTimers();
      await rm(created.directory, { recursive: true, force: true });
    }
  });

  it("enforces the strict boundary in the 236502ms window for two 118001ms attempts", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let resolveTimerRegistered!: () => void;
    const timerRegistered = new Promise<void>((resolve) => { resolveTimerRegistered = resolve; });
    const originalSetTimeout = globalThis.setTimeout;
    const timerSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
      if (delay === 118_500) resolveTimerRegistered();
      return originalSetTimeout(callback, delay, ...args);
    });

    // 2 * 118001ms HTTP reserves + the 500ms base retry delay = 236502ms.
    // An equal 118501ms delay + reserve is rejected; one millisecond less is admissible.
    const boundaryScript = makeProvider((_input, requestNumber) => {
      if (requestNumber === 1) throw arkRateLimitError(118_501);
      return { type: "finish", summary: "must not cross the strict boundary" };
    });
    const boundary = await createController(boundaryScript.provider, 118_001);
    try {
      await expect(boundary.controller.start("retry equality boundary")).resolves.toBe("failed");
      expect(boundaryScript.calls()).toBe(1);
      expect(boundary.controller.getEvents().filter((event) => event.type === "model.request.started")).toHaveLength(1);
    } finally {
      await rm(boundary.directory, { recursive: true, force: true });
    }

    const scripted = makeProvider((_input, requestNumber) => {
      if (requestNumber === 1) throw arkRateLimitError(118_500);
      return { type: "finish", summary: "done" };
    });
    const created = await createController(scripted.provider, 118_001);
    const running = created.controller.start("retry window fixture");
    try {
      await timerRegistered;
      expect(scripted.calls()).toBe(1);
      await vi.advanceTimersByTimeAsync(118_499);
      expect(scripted.calls()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(running).resolves.toBe("succeeded");
      expect(scripted.calls()).toBe(2);
      expect(created.controller.getEvents().filter((event) => event.type === "model.request.started")).toHaveLength(2);
    } finally {
      timerSpy.mockRestore();
      vi.useRealTimers();
      await rm(created.directory, { recursive: true, force: true });
    }
  });

  it("aborts an explicitly time-limited Run without replaying prior GUI input", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let resolveSecondRequest!: () => void;
    const secondRequestStarted = new Promise<void>((resolve) => { resolveSecondRequest = resolve; });
    let requests = 0;
    const provider: ProviderAdapter = {
      id: "deadline-abort-provider",
      async generate(_input, { signal }) {
        requests += 1;
        if (requests === 1) return { type: "tool_calls", calls: [{ id: "one-click" as ToolCallId, name: "click", arguments: { x: 20, y: 30 } }] };
        resolveSecondRequest();
        return await new Promise((_, reject) => {
          const abort = () => reject(signal.reason ?? new Error("Run deadline aborted Provider"));
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
      },
    };
    const created = await createController(provider, 90_000, 5_000, 1_000);
    const running = created.controller.start("one click, then wait for the explicit Run deadline");
    try {
      await secondRequestStarted;
      expect(created.computer.executeCount).toBe(1);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(running).resolves.toBe("cancelled");
      expect(requests).toBe(2);
      expect(created.computer.executeCount).toBe(1);
      const events = created.controller.getEvents();
      expect(events.filter((event) => event.type === "action.execution.completed")).toHaveLength(1);
      expect(events.filter((event) => event.type === "model.request.started")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
      await rm(created.directory, { recursive: true, force: true });
    }
  });

  it("cancels the pending bounded wait without issuing another request", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let resolveTimerRegistered!: () => void;
    const timerRegistered = new Promise<void>((resolve) => { resolveTimerRegistered = resolve; });
    const originalSetTimeout = globalThis.setTimeout;
    const timerSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
      if (delay === 4_000) resolveTimerRegistered();
      return originalSetTimeout(callback, delay, ...args);
    });
    const scripted = makeProvider((_input, requestNumber) => {
      if (requestNumber === 1) throw arkRateLimitError(4_000);
      return { type: "finish", summary: "must not be requested" };
    });
    const created = await createController(scripted.provider);
    const running = created.controller.start("cancel waiting retry");
    try {
      await timerRegistered;
      created.controller.cancel("cancel Ark wait");
      await expect(running).resolves.toBe("cancelled");
      expect(scripted.calls()).toBe(1);
    } finally {
      timerSpy.mockRestore();
      vi.useRealTimers();
      await rm(created.directory, { recursive: true, force: true });
    }
  });

  it("fails closed when Retry-After exceeds the cap", async () => {
    const scripted = makeProvider(() => { throw arkRateLimitError(0, "too_long"); });
    const created = await createController(scripted.provider);
    try {
      await expect(created.controller.start("bounded delay fixture")).resolves.toBe("failed");
      expect(scripted.calls()).toBe(1);
    } finally {
      await rm(created.directory, { recursive: true, force: true });
    }
  });
});
