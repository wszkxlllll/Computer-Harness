import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ComputerSessionId, RunId, RunOutcome, Viewport } from "@computer-harness/protocol";
import type { Computer, ComputerSession, RunController, ProviderAdapter } from "@computer-harness/runtime";
import type { RunHandle, ResolvedRunConfig } from "./config.js";
import { ApplicationSession, type ApplicationSessionConfig } from "./application-session.js";
import { createRun } from "./run-factory.js";
import { createRunEventFeed } from "./event-feed.js";
import { environmentIdentityForConfig, InProcessEnvironmentOwner } from "./environment-owner.js";

function baseConfig(outputDir: string, bridgeUrl = "http://fixture-a"): ApplicationSessionConfig {
  return {
    model: "glm-5.3-flash",
    computer: { kind: "osworld", bridgeUrl },
    outputDir,
    maxSteps: 2,
    maxModelRequests: 2,
    planning: false,
    memory: "off",
    batching: "off",
    contextMode: "raw",
    contextMaxHistoryEvents: 8,
    riskProfile: "experiment",
    riskGuard: "off",
    riskModel: "off",
    riskMaxModelRequests: 1,
    riskTimeoutMs: 100,
    cleanupDeadlineMs: 100,
  };
}

function fakeHandle(config: ResolvedRunConfig, outcome: RunOutcome): RunHandle {
  const snapshot = { runId: config.runId!, status: "finished" as const, outcome, stepCount: 0, modelRequestCount: 0, guardEvaluationCount: 0, riskModelRequestCount: 0, plan: { runId: config.runId!, tasks: [] }, memory: { runId: config.runId!, facts: [], entities: [] } };
  return {
    runId: config.runId!,
    config,
    controller: {} as RunController,
    eventFeed: createRunEventFeed(),
    start: vi.fn(async () => outcome),
    report: vi.fn(async () => ({ runId: config.runId!, outcome, summary: { cleanupDiagnostics: [] }, snapshot, events: [] })),
    close: vi.fn(async () => undefined),
  } as unknown as RunHandle;
}

describe("ApplicationSession", () => {
  it("creates independent Run directories and does not inherit the prior Run", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-session-"));
    const owner = new InProcessEnvironmentOwner();
    const handles: RunHandle[] = [];
    const createRun = vi.fn(async (config: ResolvedRunConfig) => {
      const handle = fakeHandle(config, "succeeded");
      handles.push(handle);
      return handle;
    });
    try {
      const session = new ApplicationSession({ config: baseConfig(outputDir), owner, createRun });
      await session.startRun("第一项任务");
      await session.waitForActiveRun();
      await session.startRun("第二项任务");
      await session.waitForActiveRun();
      expect(createRun).toHaveBeenCalledTimes(2);
      expect(handles[0]?.config.goal).toBe("第一项任务");
      expect(handles[1]?.config.goal).toBe("第二项任务");
      expect(handles[0]?.config.outputDir).not.toBe(handles[1]?.config.outputDir);
      expect(handles[0]?.config.outputDir.startsWith(outputDir)).toBe(true);
      expect(session.history.map((run) => run.goal)).toEqual(["第一项任务", "第二项任务"]);
      expect(session.inspectEnvironment()).toBeUndefined();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("wires the real createRun Controller into the session feed without an API or desktop", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-session-real-"));
    const owner = new InProcessEnvironmentOwner();
    const viewport: Viewport = { width: 2, height: 2, coordinateSpace: "physical" };
    const computerSession: ComputerSession = { id: "session-real" as ComputerSessionId, backend: "fixture", viewport, capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false }, openedAt: "2026-09-17T00:00:00.000Z" };
    const computer: Computer = {
      async open() { return computerSession; },
      async observe() { return { capturedAt: "2026-09-17T00:00:00.000Z", viewport, screenshot: { mediaType: "image/png" as const, data: new Uint8Array([1]) } }; },
      async execute() { throw new Error("fixture should not execute"); },
      async close() {},
    } as unknown as Computer;
    const provider: ProviderAdapter = { id: "fixture-provider", async generate() { return { type: "finish", summary: "done" }; } };
    try {
      const session = new ApplicationSession({
        config: baseConfig(outputDir),
        owner,
        dependencies: {
          createProvider: () => provider,
          createComputer: async () => computer,
        },
        createRun,
      });
      const handle = await session.startRun("assembled fixture task");
      const seen: string[] = [];
      handle.eventFeed.subscribe({ listener: (notification) => { if (notification.type === "event") seen.push(notification.event.type); } });
      await expect(session.waitForActiveRun()).resolves.toBe("succeeded");
      expect(seen).toContain("run.finished");
      expect(handle.config.outputDir).toContain(handle.runId);
      expect(session.inspectEnvironment()).toBeUndefined();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("holds one same-environment owner while a Run is active and allows a distinct route", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-session-owner-"));
    const owner = new InProcessEnvironmentOwner();
    let resolveRun!: (outcome: RunOutcome) => void;
    const activeOutcome = new Promise<RunOutcome>((resolve) => { resolveRun = resolve; });
    const createRun = vi.fn(async (config: ResolvedRunConfig) => {
      if (config.computer.kind === "osworld" && config.computer.bridgeUrl.endsWith("a")) {
        const handle = fakeHandle(config, "succeeded");
        handle.start = vi.fn(() => activeOutcome);
        return handle;
      }
      return fakeHandle(config, "succeeded");
    });
    try {
      const first = new ApplicationSession({ config: baseConfig(outputDir, "http://fixture-a"), owner, createRun });
      const second = new ApplicationSession({ config: baseConfig(outputDir, "http://fixture-a"), owner, createRun });
      const independent = new ApplicationSession({ config: baseConfig(outputDir, "http://fixture-b"), owner, createRun });
      await first.startRun("long task");
      expect(second.status).toBe("blocked");
      await expect(second.startRun("must wait")).rejects.toThrow(/owned by run/iu);
      await independent.startRun("independent task");
      await independent.waitForActiveRun();
      resolveRun("succeeded");
      await first.waitForActiveRun();
      expect(first.status).toBe("idle");
      await second.startRun("now allowed");
      await second.waitForActiveRun();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("keeps the environment blocked after an unknown external side effect", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-session-unknown-"));
    const owner = new InProcessEnvironmentOwner();
    const createRun = vi.fn(async (config: ResolvedRunConfig) => fakeHandle(config, "outcome_unknown"));
    try {
      const session = new ApplicationSession({ config: baseConfig(outputDir), owner, createRun });
      await session.startRun("uncertain task");
      await session.waitForActiveRun();
      expect(session.status).toBe("blocked");
      await expect(session.startRun("do not reuse")).rejects.toThrow(/pending_cleanup|owned by run/iu);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("shares a CUA local-desktop owner across renamed socket routes", () => {
    const owner = new InProcessEnvironmentOwner();
    const first = environmentIdentityForConfig({ kind: "cua", socketPath: "pipe-one", screenshotDir: "screens-one" });
    const renamed = environmentIdentityForConfig({ kind: "cua", socketPath: "pipe-two", screenshotDir: "screens-two" });
    expect(renamed).toBe(first);
    const lease = owner.acquire(first, "run-one");
    lease.markPending("unconfirmed cleanup");
    expect(() => owner.acquire(renamed, "run-two")).toThrow(/pending_cleanup/iu);
    expect(owner.inspect(first)?.state).toBe("pending_cleanup");
  });
});
