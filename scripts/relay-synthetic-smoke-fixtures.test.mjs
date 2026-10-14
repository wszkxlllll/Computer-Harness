import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ApplicationSession, InProcessEnvironmentOwner } from "../packages/app-runtime/dist/index.js";
import { createFixtureComputer, waitForFixtureModelStart } from "./relay-synthetic-smoke-fixtures.mjs";

test("invalid fixture Surface ends the real ApplicationSession before any Provider call", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "relay-synthetic-invalid-surface-"));
  const viewport = { width: 64, height: 48, coordinateSpace: "physical" };
  const invalidSurfaceRef = { surfaceId: "synthetic-invalid-surface", generation: 0, kind: "unknown" };
  let providerCalls = 0;
  const session = new ApplicationSession({
    config: {
      model: "glm-5.3-flash",
      computer: { kind: "cua", socketPath: "synthetic-invalid-surface", screenshotDir: join(outputDir, "captures") },
      outputDir,
      maxSteps: 4,
      maxModelRequests: 4,
      planning: false,
      memory: "off",
      memoryRetrieval: "off",
      batching: "off",
      contextMode: "raw",
      contextMaxHistoryEvents: 8,
      riskProfile: "experiment",
      riskGuard: "off",
      riskModel: "off",
      riskMaxModelRequests: 1,
      riskTimeoutMs: 100,
      cleanupDeadlineMs: 1_000,
    },
    owner: new InProcessEnvironmentOwner(),
    dependencies: {
      createProvider: () => ({
        id: "synthetic-provider-counter",
        async generate() { providerCalls += 1; return { type: "finish", summary: "unexpected" }; },
      }),
      createComputer: async () => createFixtureComputer(viewport, { surfaceRef: invalidSurfaceRef }),
    },
  });
  try {
    const handle = await session.startRun("Fail closed on invalid synthetic Surface evidence.");
    const terminalWait = await waitForFixtureModelStart({
      readSnapshot: async () => handle.controller.getSnapshot(),
      hasStarted: () => providerCalls > 0,
      timeoutMs: 10_000,
      pollIntervalMs: 10,
    });
    const outcome = await session.waitForActiveRun();
    assert.equal(terminalWait.kind, "terminal");
    assert.equal(terminalWait.outcome, "failed");
    assert.equal(outcome, "failed");
    assert.equal(providerCalls, 0);
  } finally {
    await session.close().catch(() => undefined);
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("model start wait clears its deadline timer without scheduling a poll for terminal outcomes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let setTimeoutCalls = 0;
  let clearTimeoutCalls = 0;
  t.mock.method(globalThis, "setTimeout", (...args) => {
    setTimeoutCalls += 1;
    return originalSetTimeout(...args);
  });
  t.mock.method(globalThis, "clearTimeout", (timer) => {
    clearTimeoutCalls += 1;
    return originalClearTimeout(timer);
  });
  for (const outcome of ["succeeded", "failed", "cancelled", "budget_exhausted", "outcome_unknown"]) {
    const timeoutsBefore = setTimeoutCalls;
    const clearsBefore = clearTimeoutCalls;
    let readCount = 0;
    const result = await waitForFixtureModelStart({
      readSnapshot: async ({ signal }) => {
        assert.equal(signal.aborted, false);
        readCount += 1;
        return { status: "finished", outcome };
      },
      hasStarted: () => false,
      timeoutMs: 10_000,
    });
    assert.deepEqual(result, { kind: "terminal", outcome });
    assert.equal(readCount, 1, `${outcome} should be observed from one terminal snapshot`);
    assert.equal(setTimeoutCalls - timeoutsBefore, 1, `${outcome} should schedule only its bounded read deadline`);
    assert.equal(clearTimeoutCalls - clearsBefore, 1, `${outcome} should clear its completed read deadline`);
  }
});

test("model start wait enforces its ten-second deadline when snapshot reading hangs", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const originalSetTimeout = globalThis.setTimeout;
  let setTimeoutCalls = 0;
  t.mock.method(globalThis, "setTimeout", (...args) => {
    setTimeoutCalls += 1;
    return originalSetTimeout(...args);
  });
  let readCount = 0;
  let requestSignal;
  const wait = waitForFixtureModelStart({
    readSnapshot: ({ signal }) => {
      readCount += 1;
      requestSignal = signal;
      return new Promise(() => {});
    },
    hasStarted: () => false,
    timeoutMs: 10_000,
  });
  await Promise.resolve();
  assert.equal(readCount, 1);
  assert.equal(setTimeoutCalls, 1, "one deadline timer bounds the pending snapshot read");
  t.mock.timers.tick(10_000);
  assert.deepEqual(await wait, { kind: "timeout" });
  assert.equal(setTimeoutCalls, 1, "timeout must return without scheduling another snapshot poll");
  assert.equal(requestSignal.aborted, true, "deadline aborts the pending snapshot request");
});
