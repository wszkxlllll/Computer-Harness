import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ProbeFailure,
  assertNoForbiddenActions,
  auditRoundtripEvents,
  buildExactTargetScope,
  cleanupAwareComputer,
  dispatchProbe,
  parseProbeArgs,
  runLiveProbe,
  runOfflineSelfTest,
  validateFixtureTitle,
  validateNativeFixtureInventory,
  validateWindowInventory,
} from "./sdk-managed-browser-probe.mjs";

const liveArgs = [
  "--live", "--root-go-after-review", "--confirm-synthetic-only",
  "--socket", "\\\\.\\pipe\\offline-fixture",
  "--managed-browser-url", "https://example.com/",
  "--native-target", "123:456",
  "--fixture-title", "HarnessProbe-offline-only",
];

test("default/help and self-test paths never load SDK adapters", async () => {
  let adapterLoads = 0;
  const loadAdapters = async () => { adapterLoads += 1; throw new Error("must remain offline"); };
  assert.deepEqual(parseProbeArgs([]), { mode: "help" });
  assert.equal((await dispatchProbe([], loadAdapters)).mode, "help");
  assert.equal((await dispatchProbe(["--help"], loadAdapters)).mode, "help");
  assert.deepEqual((await dispatchProbe(["--self-test"], loadAdapters)).result, {
    status: "passed",
    networkCalls: 0,
    computerActions: 0,
    liveBody: "implemented-not-run",
  });
  assert.equal(adapterLoads, 0);
  assert.deepEqual(await runOfflineSelfTest(), {
    status: "passed",
    networkCalls: 0,
    computerActions: 0,
    liveBody: "implemented-not-run",
  });
});

test("malformed and ungated invocations do not create SDK or CUA resources", async () => {
  let adapterLoads = 0;
  const loadAdapters = async () => { adapterLoads += 1; return {}; };
  await assert.rejects(dispatchProbe(["--live"], loadAdapters), { code: "ROOT_GO_REQUIRED" });
  await assert.rejects(dispatchProbe(["--live", "--root-go-after-review"], loadAdapters), { code: "SYNTHETIC_FIXTURE_CONFIRMATION_REQUIRED" });
  await assert.rejects(dispatchProbe([...liveArgs, "--socket", "\\\\.\\pipe\\other"], loadAdapters), { code: "DUPLICATE_ARGUMENT" });
  assert.equal(adapterLoads, 0);
});

test("read-only fixture mismatch fails before the verified Run/profile factory", async () => {
  const parsed = parseProbeArgs(liveArgs);
  let verifiedFactoryCalls = 0;
  const adapters = {
    async discoverNativeWindows() {
      return [{ pid: 123, windowId: 456, appName: "WPS Office", title: "unrelated-existing-document" }];
    },
    async runVerifiedFixture() { verifiedFactoryCalls += 1; },
  };
  await assert.rejects(runLiveProbe(parsed, adapters), { code: "FIXTURE_TARGET_MISMATCH" });
  assert.equal(verifiedFactoryCalls, 0);
});

test("production app-runtime managed-browser assembly forwards only the explicit switch and keeps Host until close", async () => {
  const appRuntime = await import(new URL("../../packages/app-runtime/dist/index.js", import.meta.url).href);
  const fixtureTarget = { pid: 123, windowId: 456 };
  const ownedTarget = { pid: 789, windowId: 654 };
  const browserTarget = {
    browser: "edge",
    delivery: "foreground",
    profileId: "offline-profile-marker",
    tabId: "offline-tab-marker",
    generation: "offline-generation-marker",
    windowTarget: ownedTarget,
  };
  const browserSession = {
    id: "offline-browser-binding",
    backend: "fake-cua",
    viewport: { width: 20, height: 20, coordinateSpace: "physical" },
    capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: true },
    openedAt: "2026-10-02T00:00:00.000Z",
  };
  const nativeSession = { ...browserSession };
  const lifecycle = { hostStart: 0, hostClose: 0, bootstrapClose: 0, delegateClose: 0, actionRefs: [] };
  const host = {
    async start() {
      lifecycle.hostStart += 1;
      return {
        target: browserTarget,
        processId: 789,
        profileId: browserTarget.profileId,
        tabId: browserTarget.tabId,
        generation: browserTarget.generation,
        profileMode: "ephemeral",
      };
    },
    createTransport() { return { kind: "managed-loopback-cdp-v1", async collect() { return { candidates: [] }; } }; },
    async close() { lifecycle.hostClose += 1; },
  };
  const delegateOptionsSeen = [];
  class FakeDelegate {
    constructor(options) { delegateOptionsSeen.push(options); }
    async open() { return browserSession; }
    async listWindows() {
      return { options: [
        { windowRef: "offline-browser-ref", appName: "Microsoft Edge", title: "safe page", isCurrent: true },
        { windowRef: "offline-wps-ref", appName: "WPS Office", title: "HarnessProbe-offline-only", isCurrent: false },
      ], truncated: false, omittedCount: 0 };
    }
    async execute(session, action) {
      lifecycle.actionRefs.push(action.windowRef);
      return { actionId: action.actionId, status: "completed", sessionAfter: nativeSession };
    }
    async observe(session) {
      assert.equal(session.id, nativeSession.id);
      return { capturedAt: "2026-10-02T00:00:01.000Z", viewport: session.viewport, screenshot: { mediaType: "image/png", data: new Uint8Array([1]) } };
    }
    async close() { lifecycle.delegateClose += 1; }
  }
  const bootstrap = { driver: {}, label: "offline-bootstrap", async close() { lifecycle.bootstrapClose += 1; } };
  const computer = await appRuntime.createComputer({
    kind: "cua",
    socketPath: "offline-unused",
    screenshotDir: "offline-unused",
    windowDeliveryMode: "foreground",
    windowSwitch: "opened-windows-v1",
    windowSwitchAllowedTargets: [fixtureTarget],
    grounding: "hybrid-catalog-v1",
    managedBrowserUrl: "about:blank",
    managedBrowserProfileMode: "ephemeral",
  }, {
    createManagedBrowserHost(options) {
      assert.equal(options.profileMode, "ephemeral");
      return host;
    },
    async openCuaBootstrapSession() { return bootstrap; },
    async importCuaComputer() {
      return {
        CuaDriverComputer: class ProbeScopeDelegate extends FakeDelegate {
          constructor(options) {
            super(options);
          }
        },
      };
    },
  });
  const signal = new AbortController().signal;
  const session = await computer.open({}, signal);
  const inventory = await computer.listWindows(session, signal);
  assert.equal(validateWindowInventory(inventory, "HarnessProbe-offline-only", "browser").wps.windowRef, "offline-wps-ref");
  const action = { actionId: "offline-switch", basedOn: "offline-observation", kind: "switch_window", windowRef: "offline-wps-ref" };
  const receipt = await computer.execute(session, action, signal);
  assert.equal(receipt.sessionAfter, nativeSession);
  assert.deepEqual(lifecycle.actionRefs, ["offline-wps-ref"]);
  assert.deepEqual(delegateOptionsSeen[0]?.windowSwitchAllowedTargets, [fixtureTarget, ownedTarget]);
  assert.equal(lifecycle.hostClose, 0, "switching away must not close the managed-browser Host");
  await computer.observe(nativeSession, "offline-native-observation", signal);
  await computer.close(nativeSession);
  assert.deepEqual(lifecycle, { hostStart: 1, hostClose: 1, bootstrapClose: 1, delegateClose: 1, actionRefs: ["offline-wps-ref"] });
});

test("Host cleanup failure becomes a Runtime diagnostic and leaves the ApplicationSession owner pending", async () => {
  const appRuntime = await import(new URL("../../packages/app-runtime/dist/index.js", import.meta.url).href);
  const outputDir = await mkdtemp(join(tmpdir(), "harness-cross-window-cleanup-selftest-"));
  const state = { hostCloseFailures: 0, hostCleanupDiagnostics: [] };
  const target = { pid: 789, windowId: 654 };
  const sessionDescriptor = {
    id: "offline-cleanup-session",
    backend: "fake-cua",
    viewport: { width: 2, height: 2, coordinateSpace: "physical" },
    capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: true },
    openedAt: "2026-10-02T00:00:00.000Z",
  };
  const managedTarget = {
    browser: "edge",
    delivery: "foreground",
    windowTarget: target,
    profileId: "cleanup-test-profile",
    tabId: "cleanup-test-tab",
    generation: "cleanup-test-generation",
  };
  let hostCloseCalls = 0;
  let delegateCloseCalls = 0;
  const owner = new appRuntime.InProcessEnvironmentOwner();
  const config = {
    model: { kind: "external", id: "cleanup-selftest" },
    computer: {
      kind: "cua",
      socketPath: "offline-unused",
      screenshotDir: join(outputDir, "screens"),
      windowDeliveryMode: "foreground",
      windowSwitch: "opened-windows-v1",
      grounding: "hybrid-catalog-v1",
      managedBrowserUrl: "about:blank",
      managedBrowserProfileMode: "ephemeral",
    },
    outputDir,
    maxSteps: 2,
    maxModelRequests: 2,
    planning: false,
    memory: "off",
    batching: "off",
    contextMode: "raw",
    contextMaxHistoryEvents: 16,
    riskProfile: "experiment",
    riskGuard: "off",
    riskModel: "off",
    riskMaxModelRequests: 1,
    riskTimeoutMs: 100,
    cleanupDeadlineMs: 2_000,
    grounding: "hybrid-catalog-v1",
    windowSwitch: "opened-windows-v1",
    windowHandoff: "off",
  };
  const computerDependencies = {
    createManagedBrowserHost(options) {
      return {
        async start() {
          return { target: managedTarget, processId: target.pid, profileId: managedTarget.profileId, tabId: managedTarget.tabId, generation: managedTarget.generation, profileMode: "ephemeral" };
        },
        createTransport() {
          return { kind: "managed-loopback-cdp-v1", async collect() { return { candidates: [] }; } };
        },
        async close() {
          hostCloseCalls += 1;
          state.hostCleanupDiagnostics.push("profile_cleanup_failed");
          options.onCleanupDiagnostic?.("profile_cleanup_failed");
          throw new Error("offline synthetic Host cleanup failure");
        },
      };
    },
    async openCuaBootstrapSession() {
      return { driver: {}, label: "offline-cleanup-bootstrap", async close() {} };
    },
    async importCuaComputer() {
      return {
        CuaDriverComputer: class FakeManagedDelegate {
          constructor() {}
          async open() { return sessionDescriptor; }
          async observe(session) {
            return {
              capturedAt: "2026-10-02T00:00:00.000Z",
              viewport: session.viewport,
              screenshot: { mediaType: "image/png", data: new Uint8Array([1]) },
            };
          }
          async execute() { throw new Error("the cleanup fixture does not execute computer actions"); }
          async listWindows() { return { options: [], truncated: false, omittedCount: 0 }; }
          async close() { delegateCloseCalls += 1; }
        },
      };
    },
  };
  const session = new appRuntime.ApplicationSession({
    config,
    owner,
    dependencies: {
      credentials: {},
      createProvider: () => ({ id: "cleanup-selftest", async generate() { return { type: "finish", summary: "offline cleanup check" }; } }),
      createComputer: async ({ config: computerConfig }) => cleanupAwareComputer(
        await appRuntime.createComputer(computerConfig, computerDependencies),
        state,
      ),
    },
  });
  try {
    const handle = await session.startRun("Offline cleanup lifecycle assertion");
    await session.waitForActiveRun();
    const report = await handle.report();
    assert.ok(report.summary.cleanupDiagnostics.length > 0);
    assert.equal(session.lastRun?.ownerState, "pending_cleanup");
    assert.equal(session.inspectEnvironment()?.state, "pending_cleanup");
    assert.equal(hostCloseCalls, 1);
    assert.equal(delegateCloseCalls, 1);
    assert.equal(state.hostCleanupDiagnostics.length, 1);
  } finally {
    await session.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("fixture and target scope are exact and reject duplicates or scope broadening", () => {
  const fixture = { pid: 123, windowId: 456, appName: "WPS Office", title: "HarnessProbe-offline-only" };
  assert.equal(validateNativeFixtureInventory([fixture], { pid: 123, windowId: 456 }, fixture.title).verified, true);
  const actualWpsTitle = "HarnessProbe-WPS.docx - WPS Office";
  assert.equal(validateFixtureTitle(actualWpsTitle), actualWpsTitle);
  assert.equal(validateNativeFixtureInventory([
    { pid: 123, windowId: 456, appName: "wps.exe", title: actualWpsTitle },
  ], { pid: 123, windowId: 456 }, actualWpsTitle).verified, true);
  assert.throws(() => validateFixtureTitle(actualWpsTitle + " - other document"), { code: "UNSAFE_FIXTURE_TITLE" });
  assert.throws(() => validateNativeFixtureInventory([
    { pid: 123, windowId: 456, appName: "wps.exe", title: actualWpsTitle + " - other document" },
  ], { pid: 123, windowId: 456 }, actualWpsTitle), { code: "FIXTURE_TARGET_MISMATCH" });
  assert.throws(() => validateNativeFixtureInventory([fixture, fixture], { pid: 123, windowId: 456 }, fixture.title), { code: "FIXTURE_TARGET_NOT_UNIQUE" });
  assert.throws(() => validateNativeFixtureInventory([{ ...fixture, appName: "Edge" }], { pid: 123, windowId: 456 }, fixture.title), { code: "FIXTURE_TARGET_MISMATCH" });
  assert.deepEqual(buildExactTargetScope([{ pid: 123, windowId: 456 }], { pid: 789, windowId: 654 }), [
    { pid: 123, windowId: 456 },
    { pid: 789, windowId: 654 },
  ]);
  assert.throws(() => buildExactTargetScope([{ pid: 123, windowId: 456 }, { pid: 4, windowId: 5 }], { pid: 789, windowId: 654 }), { code: "TARGET_SCOPE_INVALID" });
});

test("scripted Provider uses only the actual completed ToolResult inventories and fresh refs", async () => {
  const result = await runOfflineSelfTest();
  assert.equal(result.status, "passed");
  const initial = validateWindowInventory([
    { windowRef: "first-browser-ref", appName: "Microsoft Edge", title: "safe page", isCurrent: true },
    { windowRef: "first-wps-ref", appName: "WPS Office", title: "HarnessProbe-offline-only", isCurrent: false },
  ], "HarnessProbe-offline-only", "browser");
  const refreshed = validateWindowInventory([
    { windowRef: "fresh-browser-ref", appName: "Microsoft Edge", title: "safe page", isCurrent: false },
    { windowRef: "fresh-wps-ref", appName: "WPS Office", title: "HarnessProbe-offline-only", isCurrent: true },
  ], "HarnessProbe-offline-only", "wps");
  assert.notEqual(initial.browser.windowRef, refreshed.browser.windowRef);
  assert.equal(initial.wps.windowRef, "first-wps-ref");
  assert.equal(refreshed.browser.windowRef, "fresh-browser-ref");
  assert.throws(() => validateWindowInventory([
    { windowRef: "ref", appName: "WPS Office", title: "HarnessProbe-offline-only", isCurrent: false, pid: 123 },
    { windowRef: "browser", appName: "Microsoft Edge", isCurrent: true },
  ], "HarnessProbe-offline-only", "browser"), { code: "WINDOW_INVENTORY_PRIVATE_FIELD" });
});

test("roundtrip audit requires fresh sessionAfter observations and grounding changes", () => {
  const session = (id) => ({ id, backend: "cua-driver", viewport: { width: 100, height: 100, coordinateSpace: "physical" }, capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: true }, openedAt: "2026-10-02T00:00:00.000Z" });
  const observation = (id, computerSessionId, elements) => ({ id, computerSessionId, grounding: { elements } });
  const events = [
    { type: "computer.open.completed", sequence: 1, session: session("browser-start") },
    { type: "observation.created", sequence: 2, observation: observation("obs-browser-start", "browser-start", [{ source: "dom" }]) },
    { type: "tool.call.received", sequence: 3, call: { name: "list_windows" } },
    { type: "action.execution.started", sequence: 4, action: { actionId: "switch-one", kind: "switch_window", basedOn: "obs-browser-start" } },
    { type: "action.execution.completed", sequence: 5, receipt: { actionId: "switch-one", status: "completed", sessionAfter: session("browser-start") } },
    { type: "observation.created", sequence: 6, observation: observation("obs-wps", "browser-start", [{ source: "uia" }]) },
    { type: "tool.call.received", sequence: 7, call: { name: "switch_window" } },
    { type: "action.execution.started", sequence: 8, action: { actionId: "switch-two", kind: "switch_window", basedOn: "obs-wps" } },
    { type: "action.execution.completed", sequence: 9, receipt: { actionId: "switch-two", status: "completed", sessionAfter: session("browser-start") } },
    { type: "observation.created", sequence: 10, observation: observation("obs-browser-return", "browser-start", [{ source: "dom" }]) },
  ];
  assertNoForbiddenActions(events);
  const result = auditRoundtripEvents(
    events,
    { callNames: ["list_windows", "switch_window", "list_windows", "switch_window"], labelSelections: ["wps", "owned-browser"] },
    { domRequests: [{ sessionId: "browser-start" }, { sessionId: "browser-start" }] },
    "https://example.com/",
  );
  assert.equal(result.switchActions, 2);
  assert.equal(result.freshPostSwitchObservations, 2);
  assert.equal(result.computerSessions, 1);
  assert.equal(result.nativeBindingHasDomSource, false);
  assert.equal(result.managedReturnDomVerified, true);
  assert.throws(() => auditRoundtripEvents(events.slice(0, -1), {
    callNames: ["list_windows", "switch_window", "list_windows", "switch_window"],
    labelSelections: ["wps", "owned-browser"],
  }, { domRequests: [{ sessionId: "browser-start" }, { sessionId: "browser-start" }] }, "https://example.com/"), { code: "FRESH_OBSERVATION_MISSING" });
  assert.throws(() => assertNoForbiddenActions([
    ...events,
    { type: "action.execution.started", action: { kind: "type" } },
  ]), { code: "FORBIDDEN_ACTION_EXECUTED" });
});
