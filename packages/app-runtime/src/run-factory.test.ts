import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HybridMemoryRecallService, InMemoryMemoryStore, type MemoryStore } from "@computer-harness/memory";
import type { RunId, ToolCallId, Viewport } from "@computer-harness/protocol";
import type { Computer, ProviderAdapter } from "@computer-harness/runtime";
import { createRun, writeRunReport, type ResolvedRunConfig } from "./index.js";

function config(outputDir: string): ResolvedRunConfig {
  return {
    runId: "app-runtime-test" as RunId,
    goal: "finish the fixture",
    model: "glm-5.3-flash",
    computer: { kind: "osworld", bridgeUrl: "http://fixture.invalid" },
    outputDir,
    maxSteps: 5,
    maxModelRequests: 5,
    planning: false,
    memory: "off",
    batching: "off",
    contextMode: "raw",
    contextMaxHistoryEvents: 10,
    riskProfile: "experiment",
    riskGuard: "off",
    riskModel: "off",
    riskMaxModelRequests: 2,
    riskTimeoutMs: 100,
    cleanupDeadlineMs: 100,
    glmThinking: "enabled",
  };
}

function fakeComputer(calls: { open: number; observe: number; close: number }): Computer {
  const viewport: Viewport = { width: 1, height: 1, coordinateSpace: "physical" };
  const session = {
    id: "fixture-session",
    backend: "fixture",
    viewport,
    capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false },
    openedAt: "2026-09-17T00:00:00.000Z",
  };
  return {
    async open() {
      calls.open += 1;
      return session;
    },
    async observe() {
      calls.observe += 1;
      return {
        capturedAt: "2026-09-17T00:00:00.000Z",
        viewport,
        screenshot: { mediaType: "image/png", data: new Uint8Array([1, 2, 3]) },
      };
    },
    async execute(_session, action) {
      return { actionId: action.actionId, status: "completed" };
    },
    async close() {
      calls.close += 1;
    },
  };
}

describe("app-runtime RunHandle", () => {
  it("assembles a fake Run without starting it, then closes Controller-owned resources once", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-app-runtime-"));
    const calls = { provider: 0, open: 0, observe: 0, close: 0 };
    const provider: ProviderAdapter = {
      id: "fixture-provider",
      async generate() {
        calls.provider += 1;
        return { type: "finish", summary: "fixture done", reportedStatus: "success" };
      },
    };
    try {
      const handle = await createRun(config(outputDir), {
        credentials: { glmApiKey: "must-not-be-serialized" },
        createProvider: (options) => {
          expect(options.credentials.glmApiKey).toBe("must-not-be-serialized");
          expect(options.config).not.toHaveProperty("credentials");
          return provider;
        },
        createComputer: () => Promise.resolve(fakeComputer(calls)),
      });
      expect(calls).toMatchObject({ provider: 0, open: 0, observe: 0, close: 0 });
      const outcome = await handle.start();
      expect(outcome).toBe("succeeded");
      expect(calls).toMatchObject({ provider: 1, open: 1, observe: 1, close: 1 });
      await expect(handle.start()).rejects.toThrow(/only start once/iu);
      const report = await handle.report();
      expect(report.summary).toMatchObject({ runId: "app-runtime-test", model: "glm-5.3-flash", computer: "osworld", runtimeOutcome: "succeeded" });
      expect(report.events.map((event) => event.type)).toEqual([
        "run.created",
        "run.started",
        "computer.open.started",
        "computer.open.completed",
        "observation.created",
        "model.request.started",
        "model.response.received",
        "run.finished",
      ]);
      expect(JSON.stringify(report.summary)).not.toContain("must-not-be-serialized");
      await writeRunReport(report, outputDir);
      expect(JSON.parse(await readFile(join(outputDir, "summary.json"), "utf8"))).toMatchObject({ runtimeOutcome: "succeeded" });
      await handle.close();
      expect(calls.close).toBe(1);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("reports the effective click-only tool allowlist for an explicit window target", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-app-runtime-window-tools-"));
    const calls = { open: 0, observe: 0, close: 0 };
    const windowConfig: ResolvedRunConfig = {
      ...config(outputDir),
      computer: { kind: "cua", socketPath: "fixture.sock", screenshotDir: "screenshots", windowTarget: { pid: 1234, windowId: 5678 } },
    };
    try {
      const handle = await createRun(windowConfig, {
        createProvider: () => ({ id: "fixture-provider", async generate() { return { type: "finish", summary: "window done" }; } }),
        createComputer: () => Promise.resolve(fakeComputer(calls)),
      });
      await expect(handle.start()).resolves.toBe("succeeded");
      const report = await handle.report();
      expect(report.summary.tools).toEqual(expect.arrayContaining(["click", "wait"]));
      expect(report.summary.tools).not.toContain("type");
      expect(report.summary.tools).not.toContain("scroll");
      await handle.close();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("materializes session-scoped Memory lifecycle updates through the app factory", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-app-runtime-memory-lifecycle-"));
    const store = new InMemoryMemoryStore();
    const retrieval = new HybridMemoryRecallService();
    const syncState = vi.spyOn(retrieval, "syncState");
    const provider: ProviderAdapter = {
      id: "fixture-memory-provider",
      calls: 0,
      async generate() {
        this.calls += 1;
        return this.calls === 1
          ? { type: "tool_calls", calls: [{ id: "session-fact-call" as ToolCallId, name: "memory_write_fact", arguments: { key: "window_state", value: "synthetic-last-known", scope: "computer_session", retentionClass: "short_lived" } }] }
          : { type: "finish", summary: "memory lifecycle checked", reportedStatus: "success" };
      },
    } as ProviderAdapter & { calls: number };
    try {
      const handle = await createRun({
        ...config(outputDir),
        runId: "app-runtime-memory-lifecycle" as RunId,
        goal: "write one synthetic session fact and finish",
        memory: "facts",
      }, {
        createProvider: () => provider,
        createMemoryStore: () => store,
        createMemoryRecallService: () => retrieval,
        createComputer: () => Promise.resolve(fakeComputer({ open: 0, observe: 0, close: 0 })),
      });
      await expect(handle.start()).resolves.toBe("succeeded");
      const state = await store.get("app-runtime-memory-lifecycle" as RunId);
      expect(state.facts).toMatchObject([{ status: "needs_check", statusReason: "scope_ended", scope: { kind: "computer_session", sessionId: "fixture-session" } }]);
      const report = await handle.report();
      expect(report.events.some((event) => event.type === "memory.updated" && event.source === "lifecycle" && event.callId === undefined)).toBe(true);
      expect(syncState.mock.calls.some(([next]) => next.facts.some((fact) => fact.statusReason === "scope_ended"))).toBe(true);
      await handle.close();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("fails the app Run when lifecycle Memory materialization is rejected", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-app-runtime-memory-lifecycle-failure-"));
    const backingStore = new InMemoryMemoryStore();
    const failingStore: MemoryStore = {
      get: (runId) => backingStore.get(runId),
      apply: async (runId, mutation) => {
        if (mutation.operation === "mark_fact_needs_check") throw new Error("injected app lifecycle store failure");
        return backingStore.apply(runId, mutation);
      },
      rebuild: (runId, mutations) => backingStore.rebuild(runId, mutations),
    };
    const provider: ProviderAdapter & { calls: number } = {
      id: "fixture-memory-provider-failure",
      calls: 0,
      async generate() {
        this.calls += 1;
        return this.calls === 1
          ? { type: "tool_calls", calls: [{ id: "session-fact-failure" as ToolCallId, name: "memory_write_fact", arguments: { key: "window_state", value: "synthetic-last-known", scope: "computer_session", retentionClass: "short_lived" } }] }
          : { type: "finish", summary: "memory lifecycle checked", reportedStatus: "success" };
      },
    };
    try {
      const handle = await createRun({
        ...config(outputDir),
        runId: "app-runtime-memory-lifecycle-failure" as RunId,
        goal: "write one synthetic session fact and finish",
        memory: "facts",
      }, {
        createProvider: () => provider,
        createMemoryStore: () => failingStore,
        createComputer: () => Promise.resolve(fakeComputer({ open: 0, observe: 0, close: 0 })),
      });
      await expect(handle.start()).resolves.toBe("failed");
      const report = await handle.report();
      expect(report.events).toContainEqual(expect.objectContaining({ type: "runtime.error", category: "memory_materialization_failed" }));
      expect(report.summary.runtimeOutcome).toBe("failed");
      expect((await backingStore.get("app-runtime-memory-lifecycle-failure" as RunId)).facts).toMatchObject([{ status: "active" }]);
      await handle.close();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("closes only the created writer when later computer construction fails", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-app-runtime-failure-"));
    const close = vi.fn(async () => undefined);
    const providerClose = vi.fn(async () => undefined);
    const computerError = new Error("computer fixture failed");
    const provider: ProviderAdapter & { close: () => Promise<void> } = {
      id: "fixture-provider",
      async generate() { return { type: "finish", summary: "unused" }; },
      close: providerClose,
    };
    const computerFactory = vi.fn(async () => { throw computerError; });
    try {
      await expect(createRun(config(outputDir), {
        createEventWriter: () => ({
          append: async () => { throw new Error("append must not run"); },
          flush: async () => undefined,
          close,
        }),
        createProvider: () => provider,
        createComputer: computerFactory,
      })).rejects.toBe(computerError);
      expect(close).toHaveBeenCalledOnce();
      expect(computerFactory).toHaveBeenCalledOnce();
      expect(providerClose).not.toHaveBeenCalled();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("closes the writer and does not construct a Computer when Provider creation fails", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-app-runtime-provider-failure-"));
    const close = vi.fn(async () => undefined);
    const providerError = new Error("provider fixture failed");
    const computerFactory = vi.fn(async () => fakeComputer({ open: 0, observe: 0, close: 0 }));
    try {
      await expect(createRun(config(outputDir), {
        createEventWriter: () => ({
          append: async () => { throw new Error("append must not run"); },
          flush: async () => undefined,
          close,
        }),
        createProvider: () => { throw providerError; },
        createComputer: computerFactory,
      })).rejects.toBe(providerError);
      expect(close).toHaveBeenCalledOnce();
      expect(computerFactory).not.toHaveBeenCalled();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("disposes a not-yet-started handle without touching an unstarted Computer", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-app-runtime-dispose-"));
    const calls = { open: 0, observe: 0, close: 0 };
    try {
      const handle = await createRun(config(outputDir), {
        createProvider: () => ({
          id: "fixture-provider",
          async generate() { return { type: "finish", summary: "unused" }; },
        }),
        createComputer: () => Promise.resolve(fakeComputer(calls)),
      });
      await handle.close();
      await handle.close();
      await expect(handle.start()).rejects.toThrow(/already closed/iu);
      expect(calls).toEqual({ open: 0, observe: 0, close: 0 });
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("derives report outcome from the committed trajectory instead of a caller claim", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-app-runtime-unknown-"));
    const calls = { open: 0, observe: 0, close: 0 };
    const provider: ProviderAdapter = {
      id: "fixture-provider",
      async generate() {
        return { type: "tool_calls", calls: [{ id: "click-call" as ToolCallId, name: "click", arguments: { x: 0, y: 0 } }] };
      },
    };
    const computer = fakeComputer(calls);
    computer.execute = async () => {
      throw new Error("fixture transport failed after dispatch");
    };
    try {
      const handle = await createRun(config(outputDir), {
        createProvider: () => provider,
        createComputer: () => Promise.resolve(computer),
      });
      let controllerOutcome: string | undefined;
      const externallyClaimed = await handle.start(async (controller, goal, markControllerStarted) => {
        const started = controller.start(goal);
        markControllerStarted();
        controllerOutcome = await started;
        return "succeeded";
      });
      expect(controllerOutcome).toBe("outcome_unknown");
      expect(externallyClaimed).toBe("succeeded");
      const report = await handle.report();
      expect(report.outcome).toBe("outcome_unknown");
      expect(report.summary).toMatchObject({ runtimeOutcome: "outcome_unknown" });
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("closes the writer once when a starter rejects before Controller ownership", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-app-runtime-starter-failure-"));
    const close = vi.fn(async () => undefined);
    const starterError = new Error("TUI requires an interactive terminal");
    try {
      const handle = await createRun(config(outputDir), {
        createEventWriter: () => ({
          append: async () => { throw new Error("append must not run"); },
          flush: async () => undefined,
          close,
        }),
        createProvider: () => ({
          id: "fixture-provider",
          async generate() { return { type: "finish", summary: "unused" }; },
        }),
        createComputer: () => Promise.resolve(fakeComputer({ open: 0, observe: 0, close: 0 })),
      });
      await expect(handle.start(async () => { throw starterError; })).rejects.toBe(starterError);
      await expect(handle.close()).rejects.toBe(starterError);
      await handle.close().catch(() => undefined);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("publishes committed events incrementally without letting a UI listener affect the Run", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-app-runtime-feed-"));
    const calls = { open: 0, observe: 0, close: 0 };
    try {
      const handle = await createRun(config(outputDir), {
        createProvider: () => ({ id: "fixture-provider", async generate() { return { type: "finish", summary: "feed done" }; } }),
        createComputer: () => Promise.resolve(fakeComputer(calls)),
      });
      const seen: number[] = [];
      handle.eventFeed.subscribe({
        listener: (notification) => {
          if (notification.type === "event") {
            seen.push(notification.event.sequence);
            throw new Error("TUI listener should be isolated");
          }
        },
      });
      await expect(handle.start()).resolves.toBe("succeeded");
      expect(seen.length).toBeGreaterThan(0);
      expect(seen).toEqual([...seen].sort((left, right) => left - right));
      expect(new Set(seen).size).toBe(seen.length);
      await handle.close();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
