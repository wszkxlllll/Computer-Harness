import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComputerSession, ModelInput, ProviderAdapter } from "./contracts.js";
import { DefaultContextCompiler } from "../../context/src/index.js";
import { FileAssetStore, JsonlRunEventWriter } from "@computer-harness/trajectory";
import type { Computer, ComputerOpenOptions } from "./contracts.js";
import { DefaultRuntimePolicy, RunController, ToolRegistry } from "./index.js";
import type { ComputerSessionId, EventId, ObservationId, RunId, SurfaceId, Viewport } from "@computer-harness/protocol";

const viewport: Viewport = { width: 800, height: 600, coordinateSpace: "physical" };
const runId = "ark-provider-retry-test" as RunId;
const desktopSurface = { surfaceId: "ark-retry-desktop" as SurfaceId, generation: 1, kind: "desktop" as const };

class RetryTestComputer implements Computer {
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

async function createController(provider: ProviderAdapter, providerAttemptReserveMs = 90_000) {
  const directory = await mkdtemp(join(tmpdir(), "harness-ark-provider-retry-"));
  const eventPath = join(directory, "trajectory.jsonl");
  let eventNumber = 0;
  const registry = new ToolRegistry();
  const controller = new RunController({
    runId,
    provider,
    computer: new RetryTestComputer(),
    contextCompiler: new DefaultContextCompiler(registry, {
      features: { planning: "off", memory: "off", batching: "off" },
    }),
    toolRegistry: registry,
    policy: new DefaultRuntimePolicy(10, 10),
    providerAttemptReserveMs,
    eventWriter: new JsonlRunEventWriter(eventPath, runId, { next: () => `retry-event-${eventNumber++}` as EventId }),
    assetStore: new FileAssetStore(join(directory, "assets")),
  });
  return { controller, directory };
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

  it("does not admit a delay that leaves too little of the existing retry window", async () => {
    const scripted = makeProvider((_input, requestNumber) => {
      if (requestNumber === 1) throw arkRateLimitError(2_000);
      return { type: "finish", summary: "done" };
    });
    const created = await createController(scripted.provider, 118_001);
    try {
      await expect(created.controller.start("retry window fixture")).resolves.toBe("failed");
      expect(scripted.calls()).toBe(1);
      expect(created.controller.getEvents().filter((event) => event.type === "model.request.started")).toHaveLength(1);
    } finally {
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
