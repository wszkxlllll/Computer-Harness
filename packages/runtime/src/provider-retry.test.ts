import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComputerSession, ContextCompileInput, ModelInput, PreparedProviderRequest, ProviderAdapter } from "./contracts.js";
import { DefaultContextCompiler } from "../../context/src/index.js";
import { FileAssetStore, JsonlRunEventWriter } from "@computer-harness/trajectory";
import type { Computer, ComputerOpenOptions } from "./contracts.js";
import { createDefaultComputerTools, createDefaultToolRegistry, DefaultRuntimePolicy, RunController } from "./index.js";
import type { ActionIntent, AssetId, ComputerSessionId, EventId, ObservationId, RunId, RuntimeEvent, RuntimeEventData, RuntimeEventDraft, SurfaceId, ToolCallId, Viewport } from "@computer-harness/protocol";
import { ChatCompletionsAdapter } from "../../provider-glm/src/chat-completions.js";
import { ArkProviderError } from "../../provider-glm/src/ark.js";

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

class MemoryEventWriter {
  public readonly events: RuntimeEvent[] = [];

  public async append(draft: RuntimeEventDraft): Promise<RuntimeEvent> {
    const event = { ...draft, eventId: draft.eventId ?? `wire-event-${this.events.length}` as EventId, sequence: this.events.length, occurredAt: draft.occurredAt ?? "2026-09-17T00:00:00.000Z" } as RuntimeEvent;
    this.events.push(event);
    return event;
  }

  public async flush(): Promise<void> {}
  public async close(): Promise<void> {}
}

const assets = {
  async put(input: { assetId: AssetId; relativePath: string; mediaType: string; data: Uint8Array }) {
    return { assetId: input.assetId, relativePath: input.relativePath, mediaType: input.mediaType, byteLength: input.data.length };
  },
};

class RecordingComputer extends RetryTestComputer {
  public executions = 0;

  public override async execute(_session: ComputerSession, action: ActionIntent, signal: AbortSignal) {
    signal.throwIfAborted();
    this.executions += 1;
    return { actionId: action.actionId, status: "completed" as const };
  }
}

function historyEvent(sequence: number, data: RuntimeEventData): RuntimeEvent {
  return { ...data, runId, sequence, eventId: `history-${sequence}` as EventId, occurredAt: "2026-09-17T00:00:00.000Z" } as RuntimeEvent;
}

function inflatedHistory(): RuntimeEvent[] {
  const events: RuntimeEvent[] = [
    historyEvent(-100, { type: "user.input.received", text: "Correction one: keep the revised Goal." }),
    historyEvent(-99, { type: "user.input.received", text: "Correction two: do not repeat a completed click." }),
  ];
  for (let index = 0; index < 14; index += 1) {
    const callId = `old-call-${index}` as ToolCallId;
    events.push(
      historyEvent(-90 + index * 2, {
        type: "model.response.received",
        turn: {
          type: "tool_calls",
          calls: [{ id: callId, name: "click", arguments: { x: 1, y: 2 } }],
          assistantText: `old-${index}: ${'"\\'.repeat(1_800)}`,
          continuation: { providerId: "deepseek-v4.1-flash", kind: "reasoning_content", content: `old reasoning ${index}` },
        },
      }),
      historyEvent(-89 + index * 2, { type: "tool.call.completed", result: { callId, status: "completed", output: { text: '"\\'.repeat(1_800) } } }),
    );
  }
  return events;
}

function wireController(options: {
  history?: RuntimeEvent[];
  budgets?: boolean;
  beforePrepare?: (input: ModelInput, signal: AbortSignal, count: number) => void | Promise<void>;
  clickFirst?: boolean;
  runTimeoutMs?: number;
  finishReserveMs?: number;
} = {}) {
  const registry = createDefaultToolRegistry();
  const features = { planning: "off", memory: "off", batching: "off" } as const;
  const compiler = new DefaultContextCompiler(registry, {
    features,
    ...(options.budgets === false ? {} : { maxInputTokens: 16_384, maxWireInputTokens: 24_576 }),
  });
  const preparedInputs: ModelInput[] = [];
  const sentInputs: ModelInput[] = [];
  const compileInputs: ContextCompileInput[] = [];
  const bodies: Record<string, unknown>[] = [];
  const preparedInputsByRequest = new WeakMap<PreparedProviderRequest, ModelInput>();
  const adapter = new ChatCompletionsAdapter({
    apiKey: "offline-fixture",
    profile: { name: "deepseek-v4.1-flash", thinking: "low", coordinateMode: "actual_pixels", maxOutputTokens: 16_384 },
    assetReader: { async read() { return new Uint8Array([1]); } },
    httpClient: {
      async post(_url, body) {
        bodies.push(body);
        return options.clickFirst && bodies.length === 1
          ? { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, reasoning_content: "latest GUI reasoning", tool_calls: [{ id: "live-click", type: "function", function: { name: "click", arguments: '{"x":20,"y":30}' } }] } }] }
          : { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "finish-fixture", type: "function", function: { name: "terminate", arguments: JSON.stringify({ status: "success", text: "The offline budget scenario retained the required current evidence and completed its requested decision." }) } }] } }] };
      },
    },
  }, {
    label: "Ark", errorCodePrefix: "ARK", endpoint: "https://offline.invalid", requestTimeoutMs: 90_000,
    maxOutputTokens: 16_384, strictResponse: true, userImagesOnly: true,
    error: (message, code, retryable, retryMode) => new ArkProviderError(message, code, retryable, retryMode),
    isProviderError: (error) => error instanceof ArkProviderError,
  });
  const provider: ProviderAdapter = {
    id: adapter.id,
    generate: adapter.generate.bind(adapter),
    async prepare(input, { signal }) {
      preparedInputs.push(input);
      await options.beforePrepare?.(input, signal, preparedInputs.length);
      const prepared = await adapter.prepare(input, { signal });
      preparedInputsByRequest.set(prepared, input);
      return prepared;
    },
    async generatePrepared(prepared, requestOptions) {
      const input = preparedInputsByRequest.get(prepared);
      if (input === undefined) throw new Error("fixture request was not prepared");
      sentInputs.push(input);
      return adapter.generatePrepared(prepared, requestOptions);
    },
  };
  const writer = new MemoryEventWriter();
  const computer = new RecordingComputer();
  const controller = new RunController({
    runId, provider, computer, toolRegistry: registry, features,
    contextCompiler: {
      async compile(input, signal) {
        compileInputs.push(input);
        return compiler.compile({ ...input, recentEvents: [...(options.history ?? []), ...input.recentEvents] }, signal);
      },
    },
    policy: new DefaultRuntimePolicy(10, 10), eventWriter: writer, assetStore: assets,
    ...(options.runTimeoutMs === undefined ? {} : { runTimeoutMs: options.runTimeoutMs }),
    ...(options.finishReserveMs === undefined ? {} : { finishReserveMs: options.finishReserveMs }),
    clock: { now: () => "2026-09-17T00:00:00.000Z" },
  });
  return { controller, compiler, computer, preparedInputs, sentInputs, compileInputs, bodies, events: writer.events };
}

function budgetFeedback(input: ModelInput, code = "ARK_INPUT_TOO_LARGE") {
  const maxWireInputTokens = input.contextBudget?.maxWireInputTokens ?? 24_576;
  return Object.assign(new Error("offline preparation budget failure"), {
    code,
    inputBudget: {
      maxWireInputTokens,
      estimate: { estimatedTextTokens: maxWireInputTokens + 1, estimatedTotalTokens: maxWireInputTokens + 1, imageCount: 1, estimationMethod: "provider_projection" },
    },
  });
}

describe("Provider wire budget convergence through RunController", () => {
  it("refreshes closing tools when the finish boundary changes during failed local preparation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const startedAt = Date.now();
    const created = wireController({
      runTimeoutMs: 10_000,
      finishReserveMs: 2_000,
      beforePrepare(input, _signal, count) {
        if (count === 1) {
          vi.setSystemTime(startedAt + 9_000);
          throw budgetFeedback(input);
        }
      },
    });
    await expect(created.controller.start("Close from current evidence without new GUI work.")).resolves.toBe("succeeded");
    expect(created.sentInputs).toHaveLength(1);
    expect(created.preparedInputs[0]!.tools.some((tool) => tool.category === "computer")).toBe(true);
    expect(created.sentInputs[0]!.tools.map((tool) => tool.name)).toEqual(["terminate"]);
    expect(created.computer.executions).toBe(0);
    expect(created.events.filter((event) => event.type === "model.request.started")).toHaveLength(1);
  });

  it("locally trims inflated history, retaining corrections, paired tools, the latest GUI result and reasoning without replay", async () => {
    const created = wireController({ history: inflatedHistory(), clickFirst: true });
    await expect(created.controller.start("Keep this Goal and click once, then finish.")).resolves.toBe("succeeded");
    expect(created.preparedInputs.length).toBeGreaterThan(created.sentInputs.length);
    expect(created.sentInputs).toHaveLength(2);
    expect(created.bodies).toHaveLength(2);
    expect(created.computer.executions).toBe(1);
    expect(created.events.filter((event) => event.type === "model.request.started")).toHaveLength(2);
    expect(created.events.some((event) => event.type === "model.request.failed")).toBe(false);
    expect(created.compileInputs.some((input) => input.textTokenTarget !== undefined)).toBe(true);
    for (const input of created.sentInputs) {
      expect(input.contextBudget?.maxInputTokens).toBe(16_384);
      expect(input.contextBudget?.maxWireInputTokens).toBe(24_576);
      const text = input.messages.flatMap((message) => message.content.flatMap((block) => block.type === "text" ? [block.text] : [])).join("\n");
      expect(text).toContain("Keep this Goal");
      expect(text).toContain("Correction one");
      expect(text).toContain("Correction two");
      const calls = input.messages.flatMap((message) => message.content.flatMap((block) => block.type === "tool_call" ? [block.call.id] : []));
      const results = input.messages.flatMap((message) => message.content.flatMap((block) => block.type === "tool_result" ? [block.result.callId] : []));
      expect(results).toEqual(calls);
      expect(input.messages.flatMap((message) => message.content).filter((block) => block.type === "image")).toHaveLength(1);
    }
    const latest = created.sentInputs[1]!;
    expect(latest.messages.flatMap((message) => message.content).some((block) => block.type === "tool_result" && block.result.callId === "live-click" && block.result.status === "completed")).toBe(true);
    expect(latest.messages.flatMap((message) => message.content).some((block) => block.type === "provider_continuation" && block.continuation.content === "latest GUI reasoning")).toBe(true);
    for (const event of created.events) {
      if (event.type === "model.request.started") {
        expect(event.preparedRequest?.estimate?.estimatedTotalTokens).toBeLessThanOrEqual(24_576);
        expect(event.attempt).toBe(1);
      }
    }
    expect(created.bodies.every((body) => body.max_tokens === 16_384 && body.reasoning_effort === "low")).toBe(true);
  });

  it("measures intact required content and fails without sending when it alone exceeds the wire limit", async () => {
    const created = wireController();
    const baseline = await created.compiler.compile({ runId, goal: "", recentEvents: [] }, new AbortController().signal);
    const goal = '"\\'.repeat(Math.floor((16_384 - baseline.contextBudget!.estimatedInputTokens - 1_024) * 2));
    await expect(created.controller.start(goal)).resolves.toBe("failed");
    expect(created.preparedInputs.length).toBeGreaterThan(1);
    expect(created.sentInputs).toHaveLength(0);
    expect(created.bodies).toHaveLength(0);
    expect(created.computer.executions).toBe(0);
    expect(created.events.some((event) => event.type === "model.request.started")).toBe(false);
    expect(created.events.some((event) => event.type === "runtime.error" && event.category === "budget")).toBe(true);
    for (const input of created.preparedInputs) {
      expect(input.messages.some((message) => message.content.some((block) => block.type === "text" && block.text === goal))).toBe(true);
      expect(input.messages.flatMap((message) => message.content).some((block) => block.type === "image")).toBe(true);
    }
  });

  it("drains a correction arriving during failed preparation before any request is sent", async () => {
    let correction: Promise<void> | undefined;
    const created = wireController({
      history: inflatedHistory(),
      beforePrepare(input, _signal, count) {
        if (count === 1) {
          correction = created.controller.submitUserInput("New correction during wire preparation.");
          throw budgetFeedback(input);
        }
      },
    });
    await expect(created.controller.start("Correction boundary Goal")).resolves.toBe("succeeded");
    await correction;
    expect(created.sentInputs).toHaveLength(1);
    expect(created.computer.executions).toBe(0);
    expect(created.sentInputs[0]!.messages.some((message) => message.content.some((block) => block.type === "text" && block.text === "New correction during wire preparation."))).toBe(true);
    const observation = [...created.events].reverse().find((event) => event.type === "observation.created");
    if (observation?.type !== "observation.created") throw new Error("fixture has no observation");
    expect(created.sentInputs[0]!.messages.flatMap((message) => message.content).some((block) => block.type === "image" && block.asset.assetId === observation.observation.screenshot.assetId)).toBe(true);
  });

  it("cancels local convergence after one completed GUI action without another request or action", async () => {
    let reached!: () => void;
    const preparing = new Promise<void>((resolve) => { reached = resolve; });
    const created = wireController({
      clickFirst: true,
      async beforePrepare(input, signal, count) {
        if (count === 2) {
          reached();
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
          throw budgetFeedback(input);
        }
      },
    });
    const running = created.controller.start("One click, then cancellation.");
    await preparing;
    created.controller.cancel("cancel local preparation");
    await expect(running).resolves.toBe("cancelled");
    expect(created.sentInputs).toHaveLength(1);
    expect(created.computer.executions).toBe(1);
    expect(created.events.filter((event) => event.type === "model.request.started")).toHaveLength(1);
  });

  it("bounds local preparation even when a compiler cannot reduce required content", async () => {
    const created = wireController({ beforePrepare(input) { throw budgetFeedback(input); } });
    await expect(created.controller.start("Required Goal")).resolves.toBe("failed");
    expect(created.preparedInputs).toHaveLength(9);
    expect(created.sentInputs).toHaveLength(0);
    const targets = created.compileInputs.flatMap((input) => input.textTokenTarget === undefined ? [] : [input.textTokenTarget]);
    expect(targets).toHaveLength(8);
    expect(targets.every((target, index) => index === 0 || target < targets[index - 1]!)).toBe(true);
  });

  it.each(["ARK_INPUT_TOO_LARGE", "DEEPSEEK_INPUT_TOO_LARGE"])("classifies %s without guessing feedback from error text", async (code) => {
    const created = wireController({ beforePrepare() { throw Object.assign(new Error("budget failure"), { code }); } });
    await expect(created.controller.start("Goal")).resolves.toBe("failed");
    expect(created.preparedInputs).toHaveLength(1);
    expect(created.sentInputs).toHaveLength(0);
    expect(created.events.some((event) => event.type === "runtime.error" && event.category === "budget")).toBe(true);
  });

  it("keeps non-budget preparation errors and absent input budgets out of convergence", async () => {
    for (const budgets of [true, false]) {
      const created = wireController({
        budgets,
        beforePrepare(input) { throw budgetFeedback(input, budgets ? "ARK_INVALID_HISTORY" : "ARK_INPUT_TOO_LARGE"); },
      });
      await expect(created.controller.start("Goal")).resolves.toBe("failed");
      expect(created.preparedInputs).toHaveLength(1);
      expect(created.sentInputs).toHaveLength(0);
      if (budgets) expect(created.events.some((event) => event.type === "runtime.error" && event.category === "runtime")).toBe(true);
    }
  });
});
