import assert from "node:assert/strict";
import test from "node:test";
import { cleanupSession, preflightNotepadParent } from "./cua-window-handoff-probe.mjs";

const parent = { pid: 101, windowId: 202 };
const signal = new AbortController().signal;

test("Notepad preflight matches the complete inventory without foreground or visibility requirements", async () => {
  let visibleReads = 0;
  let allReads = 0;
  const window = { ...parent, appName: "Notepad", isOnScreen: false };
  const app = {
    async listWindowTargets() { visibleReads++; return []; },
    async listAllWindowTargets() { allReads++; return [window]; },
  };
  const manifest = {};
  assert.equal(await preflightNotepadParent(app, parent, signal, Date.now() + 1_000, manifest), window);
  assert.equal(visibleReads, 0);
  assert.equal(allReads, 1);
  assert.equal(manifest.preflightDiscoveryConfirmed, true);
});

test("preflight still rejects a wrong exact identity or non-Notepad process", async () => {
  for (const windows of [
    [{ ...parent, windowId: 303, appName: "Notepad" }],
    [{ ...parent, appName: "Other fixture" }],
  ]) {
    const manifest = {};
    await assert.rejects(preflightNotepadParent({ async listAllWindowTargets() { return windows; } }, parent, signal, Date.now() + 1_000, manifest),
      { code: "PARENT_NOT_EXACT_NOTEPAD" });
    assert.equal(manifest.preflightDiscoveryConfirmed, true);
  }
});

function sessionFixture(environment, history = []) {
  let markedPending = 0;
  const app = {
    status: environment === undefined ? "idle" : "blocked",
    activeRun: undefined,
    history,
    inspectEnvironment() { return environment; },
    async close() { this.status = "closed"; },
    markEnvironmentPending() { markedPending++; },
  };
  return { app, pendingCalls: () => markedPending };
}

const noRunManifest = () => ({ runStartAttempted: false, preflightDiscoveryConfirmed: true });

test("a no-Run session closes cleanly without inventing an environment pending state", async () => {
  const fixture = sessionFixture(undefined);
  const manifest = noRunManifest();
  assert.equal(await cleanupSession(fixture.app, manifest, "fixture cleanup"), true);
  assert.equal(manifest.cleanupConfirmed, true);
  assert.equal(manifest.cleanupScope, "no_run_started");
  assert.equal(manifest.environmentPending, false);
  assert.equal(manifest.environmentBlocked, false);
  assert.equal(fixture.pendingCalls(), 0);
});

test("no-Run cleanup preserves and separately reports a pre-existing unknown owner barrier", async () => {
  const environment = Object.freeze({ state: "pending_cleanup", runId: "previous-run", reason: "external outcome unknown" });
  const fixture = sessionFixture(environment);
  const manifest = noRunManifest();
  assert.equal(await cleanupSession(fixture.app, manifest, "fixture cleanup"), true);
  assert.equal(manifest.cleanupConfirmed, true);
  assert.equal(manifest.preexistingEnvironmentPending, true);
  assert.equal(manifest.environmentBlocked, true);
  assert.equal(manifest.preexistingEnvironmentRunId, environment.runId);
  assert.equal(manifest.preexistingEnvironmentReason, environment.reason);
  assert.equal(fixture.app.inspectEnvironment(), environment);
  assert.equal(fixture.pendingCalls(), 0);
});

test("a pre-existing active owner also stays blocked without being marked pending by this no-Run probe", async () => {
  const environment = Object.freeze({ state: "active", runId: "other-live-run", reason: "active owner" });
  const fixture = sessionFixture(environment);
  const manifest = noRunManifest();
  assert.equal(await cleanupSession(fixture.app, manifest, "fixture cleanup"), true);
  assert.equal(manifest.preexistingEnvironmentBlocked, true);
  assert.equal(manifest.environmentPending, false);
  assert.equal(fixture.pendingCalls(), 0);
});

test("unknown cleanup after a Run or Run-start attempt is never treated as no-Run cleanup", async () => {
  const environment = { state: "pending_cleanup", runId: "probe-run", reason: "unknown side effect" };
  for (const history of [[], [{ runId: "probe-run", outcome: "outcome_unknown" }]]) {
    const fixture = sessionFixture(environment, history);
    const manifest = { runStartAttempted: true, preflightDiscoveryConfirmed: true };
    assert.equal(await cleanupSession(fixture.app, manifest, "fixture cleanup"), false);
    assert.equal(manifest.cleanupConfirmed, false);
    assert.equal(manifest.environmentPending, true);
    assert.equal(fixture.pendingCalls(), 1);
  }
});

test("unconfirmed discovery cleanup or an active Run remains fail-closed", async () => {
  const fixture = sessionFixture(undefined);
  const manifest = { runStartAttempted: false, preflightDiscoveryConfirmed: false };
  assert.equal(await cleanupSession(fixture.app, manifest, "fixture cleanup"), false);
  assert.equal(manifest.cleanupConfirmed, false);

  const active = sessionFixture({ state: "active", runId: "probe-run" });
  active.app.status = "running";
  active.app.activeRun = { runId: "probe-run" };
  active.app.abort = () => {};
  active.app.waitForActiveRun = async () => { throw new Error("cleanup remains unknown"); };
  assert.equal(await cleanupSession(active.app, { runStartAttempted: true }, "fixture cleanup"), false);
  assert.equal(active.pendingCalls(), 1);
});
