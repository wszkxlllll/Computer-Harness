import assert from "node:assert/strict";
import test from "node:test";
import {
  ProbeFailure,
  assertActionRefusal,
  assertCompletedSwitch,
  assertOpaqueWindowOption,
  parseProbeArgs,
  parseWindowTarget,
  selectUniqueWindowOption,
  validateCaptureViewport,
  validateFixtureTitle,
} from "./cua-probe.mjs";

const liveArgs = [
  "--live",
  "--root-go-after-review",
  "--confirm-close-fixture",
  "--socket", "\\\\.\\pipe\\cua-probe",
  "--initial-target", "100:1000",
  "--destination-target", "200:2000",
  "--close-target", "300:3000",
  "--allow-target", "100:1000",
  "--allow-target", "200:2000",
  "--allow-target", "300:3000",
  "--initial-app", "Notepad",
  "--initial-title", "HarnessProbe-Notepad-A",
  "--destination-app", "WPS",
  "--destination-title", "HarnessProbe-WPS-B",
  "--close-app", "WPS",
  "--close-title", "HarnessProbe-WPS-C",
];

test("target parser accepts positive PID/HWND pairs only", () => {
  assert.deepEqual(parseWindowTarget("42:9001"), { pid: 42, windowId: 9001 });
  assert.throws(() => parseWindowTarget("0:9001"), { code: "INVALID_TARGET" });
  assert.throws(() => parseWindowTarget("42:0"), { code: "INVALID_TARGET" });
  assert.throws(() => parseWindowTarget("42:9001:extra"), { code: "INVALID_TARGET" });
});

test("synthetic fixture labels reject user-document titles and non-ASCII data", () => {
  assert.equal(validateFixtureTitle("HarnessProbe-Notepad-A"), "HarnessProbe-Notepad-A");
  assert.throws(() => validateFixtureTitle("Quarterly Report - Alice"), { code: "UNSAFE_FIXTURE_LABEL" });
  assert.throws(() => validateFixtureTitle("HarnessProbe-测试"), { code: "UNSAFE_FIXTURE_LABEL" });
});

test("public window options contain only opaque refs and display metadata", () => {
  const option = {
    windowRef: "win-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    appName: "Notepad",
    title: "HarnessProbe-Notepad-A",
    isCurrent: true,
  };
  assert.equal(assertOpaqueWindowOption(option), option);
  assert.throws(() => assertOpaqueWindowOption({ ...option, pid: 42 }), { code: "WINDOW_OPTION_SCHEMA" });
  assert.throws(() => assertOpaqueWindowOption({ ...option, windowRef: "42:9001" }), { code: "WINDOW_OPTION_SCHEMA" });
});

test("selection requires one exact app/title/current match", () => {
  const options = [
    { windowRef: "win-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", appName: "Notepad", title: "HarnessProbe-Notepad-A", isCurrent: true },
    { windowRef: "win-11111111-2222-3333-4444-555555555555", appName: "WPS", title: "HarnessProbe-WPS-B", isCurrent: false },
  ];
  assert.equal(selectUniqueWindowOption(options, { appName: "WPS", title: "HarnessProbe-WPS-B", isCurrent: false }, "destination"), options[1]);
  assert.throws(() => selectUniqueWindowOption(options, { appName: "Missing", title: "HarnessProbe-Missing" }, "missing"), { code: "WINDOW_OPTION_AMBIGUOUS" });
  assert.throws(() => selectUniqueWindowOption([...options, { ...options[1], windowRef: options[0].windowRef }], { appName: "WPS", title: "HarnessProbe-WPS-B" }, "duplicate"), { code: "WINDOW_OPTION_AMBIGUOUS" });
});

test("successful switch receipts retain session identity and return an updated serializable descriptor", () => {
  const before = {
    id: "session-before",
    backend: "cua-driver-daemon",
    viewport: { width: 800, height: 600, coordinateSpace: "physical" },
    capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false },
    openedAt: "2026-10-02T00:00:00.000Z",
  };
  const after = {
    ...before,
    viewport: { width: 1024, height: 768, coordinateSpace: "physical" },
  };
  assert.equal(assertCompletedSwitch({ status: "completed", sessionAfter: after }, before), after);
  assert.throws(() => assertCompletedSwitch({ status: "refused", sessionAfter: after }, before), { code: "SWITCH_RECEIPT_INVALID" });
  assert.throws(() => assertCompletedSwitch({ status: "completed", sessionAfter: { ...after, id: "session-after" } }, before), { code: "SWITCH_SESSION_ID_CHANGED" });
  assert.throws(() => assertCompletedSwitch({ status: "completed", sessionAfter: { ...after, privateHandle: "bad" } }, before), { code: "SWITCH_SESSION_SCHEMA" });
});

test("ordinary resize observations accept the new viewport without the caller's stale descriptor", () => {
  const staleCallerViewport = { width: 800, height: 600, coordinateSpace: "physical" };
  const freshCaptureViewport = { width: 640, height: 480, coordinateSpace: "physical" };
  assert.equal(validateCaptureViewport(freshCaptureViewport), freshCaptureViewport);
  assert.throws(() => validateCaptureViewport(freshCaptureViewport, staleCallerViewport), { code: "SESSION_CAPTURE_VIEWPORT_MISMATCH" });
});

test("old coordinate-frame refusal remains distinct from a switch viewport mismatch", () => {
  const receipt = { actionId: "fixture", status: "refused", driverCode: "WINDOW_GEOMETRY_CHANGED" };
  assert.equal(assertActionRefusal(receipt, "WINDOW_GEOMETRY_CHANGED"), receipt);
  assert.throws(() => assertActionRefusal(receipt, "SESSION_CAPTURE_VIEWPORT_MISMATCH"), { code: "EXPECTED_REFUSAL_MISSING" });
});

test("live mode requires root GO, exact three-window scope, and close-fixture confirmation", () => {
  assert.throws(() => parseProbeArgs(["--live"]), { code: "ROOT_GO_REQUIRED" });
  const parsed = parseProbeArgs(liveArgs);
  assert.equal(parsed.mode, "live");
  assert.equal(parsed.allowedTargets.length, 3);
  assert.deepEqual(parsed.initial.target, { pid: 100, windowId: 1000 });
  assert.throws(() => parseProbeArgs(liveArgs.filter((value) => value !== "--confirm-close-fixture")), { code: "CLOSE_FIXTURE_CONFIRMATION_REQUIRED" });
  assert.throws(() => parseProbeArgs([...liveArgs, "--unexpected"]), { code: "UNKNOWN_ARGUMENT" });
  assert.ok(ProbeFailure);
});
