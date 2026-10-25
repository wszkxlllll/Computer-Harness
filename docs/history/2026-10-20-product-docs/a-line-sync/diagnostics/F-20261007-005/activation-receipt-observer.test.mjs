import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createObservedCuaImporter, projectDiagnostic } from "./activation-receipt-observer.mjs";

const safeDiagnostic = {
  schema: "cua.frontmost_window_diagnostic.v1",
  source: "observe_exact_window_existing_visible_windows_snapshot",
  state: "present",
  frontmost_window_pid: 1312,
  frontmost_window_id: 1370,
  layer: 0,
  z: 9,
  is_on_screen: true,
  target_pid_relation: "same",
  target_window_id_relation: "different",
};

function resultFor(diagnostic, extras = {}) {
  return { status: "error", content: "PRIVATE_CONTENT_MARKER", structuredJson: JSON.stringify({
    status: "partial",
    pid: 1312,
    window_id: 7,
    observed: { frontmost_window_diagnostic: diagnostic, frontmost_ordinary_window_id: 1370, title: "PRIVATE_TITLE_MARKER" },
    secret: "PRIVATE_SECRET_MARKER",
    ...extras,
  }) };
}

async function makeFixture({ driver, driverFactory, onEvidence = () => {} }) {
  class BaseComputer {
    constructor(options) { this.options = { ...options, cleanupWaitMs: options.cleanupWaitMs ?? 5000 }; }
  }
  const importCuaComputer = async () => ({ CuaDriverComputer: BaseComputer, extraExport: "retained" });
  const importer = createObservedCuaImporter({
    importCuaComputer,
    connectDriver: () => driver,
    onEvidence,
  });
  const module = await importer();
  const computerOptions = { socketPath: "synthetic-socket", ...(driverFactory === undefined ? {} : { driverFactory }) };
  const computer = new module.CuaDriverComputer(computerOptions);
  return { module, computer, computerOptions };
}

test("bring_to_front passes through one exact call and returns the same result object with a safe projection", async () => {
  const input = JSON.stringify({ pid: 1312, window_id: 7 });
  const signal = new AbortController().signal;
  const nativeResult = resultFor(safeDiagnostic, { message: "PRIVATE_RAW_MARKER" });
  const nativePromise = Promise.resolve(nativeResult);
  const calls = [];
  const evidence = [];
  const driver = {
    callTool(name, args, options) {
      assert.equal(this, driver);
      calls.push([name, args, options]);
      return nativePromise;
    },
  };
  const { computer } = await makeFixture({ driver, onEvidence: (item) => evidence.push(item) });
  const connected = computer.options.driverFactory("synthetic-socket");
  const returnedPromise = connected.callTool("bring_to_front", input, { signal });
  assert.equal(returnedPromise, nativePromise);
  const returned = await returnedPromise;
  assert.equal(returned, nativeResult);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "bring_to_front");
  assert.equal(calls[0][1], input);
  assert.equal(calls[0][2].signal, signal);
  assert.deepEqual(evidence, [{ ...safeDiagnostic, target_pid: 1312, target_window_id: 7 }]);
  assert.equal(JSON.stringify(evidence).includes("PRIVATE_"), false);
});

test("all non-bring calls bypass parsing and preserve original Promise/result", async () => {
  let parsedOrObserved = 0;
  const nativeResult = { marker: true };
  Object.defineProperty(nativeResult, "structuredJson", { get() { throw new Error("must not inspect non-bring result"); } });
  const originalPromise = Promise.resolve(nativeResult);
  const driver = { callTool() { return originalPromise; } };
  const { computer } = await makeFixture({ driver, onEvidence: () => { parsedOrObserved += 1; } });
  const returnedPromise = computer.options.driverFactory("synthetic-socket").callTool("get_window_state", "{}", undefined);
  assert.equal(returnedPromise, originalPromise);
  assert.equal(await returnedPromise, nativeResult);
  assert.equal(parsedOrObserved, 0);
});

test("wrapped importer preserves computer options and invokes an existing driverFactory exactly once", async () => {
  const driver = { callTool() { return Promise.resolve({}); } };
  const factoryCalls = [];
  let expectedNormalizedOptions;
  const driverFactory = function existingFactory(socketPath) {
    assert.equal(this, expectedNormalizedOptions);
    assert.equal(this.socketPath, "synthetic-socket");
    assert.equal(this.cleanupWaitMs, 5000);
    this.receiverMarker = "normalized receiver";
    factoryCalls.push(socketPath);
    return driver;
  };
  const { computer, computerOptions } = await makeFixture({ driver, driverFactory });
  expectedNormalizedOptions = computer.options;
  assert.notEqual(computer.options, computerOptions);
  assert.equal(computer.options.socketPath, "synthetic-socket");
  assert.notEqual(computer.options.driverFactory, driverFactory);
  assert.equal(typeof computer.options.driverFactory, "function");
  const decoratedDriver = computer.options.driverFactory.call(computer.options, "synthetic-socket");
  assert.equal(computer.options.receiverMarker, "normalized receiver");
  await decoratedDriver.callTool("non-diagnostic", "{}", undefined);
  assert.deepEqual(factoryCalls, ["synthetic-socket"]);
});

test("native rejection identity, cancellation signal and call count are unchanged", async () => {
  const controller = new AbortController();
  const rejection = new Error("synthetic cancellation");
  controller.abort(rejection);
  let calls = 0;
  let receivedSignal;
  const driver = {
    callTool(name, args, options) {
      assert.equal(this, driver);
      assert.equal(name, "bring_to_front");
      assert.equal(args, "opaque-args");
      calls += 1;
      receivedSignal = options.signal;
      return Promise.reject(rejection);
    },
  };
  const { computer } = await makeFixture({ driver });
  const pending = computer.options.driverFactory("synthetic-socket").callTool("bring_to_front", "opaque-args", { signal: controller.signal });
  await assert.rejects(pending, (error) => error === rejection);
  assert.equal(receivedSignal, controller.signal);
  assert.equal(calls, 1);
});

test("synchronous native throw identity is preserved", async () => {
  const rejection = new Error("synchronous native failure");
  const driver = { callTool() { throw rejection; } };
  const { computer } = await makeFixture({ driver });
  assert.throws(() => computer.options.driverFactory("synthetic-socket").callTool("bring_to_front", "{}"), (error) => error === rejection);
});

test("driver lifecycle methods keep their original receiver and are not intercepted", async () => {
  const calls = [];
  const driver = {
    endSession(input, opts) { assert.equal(this, driver); calls.push(["endSession", input, opts]); return Promise.resolve("ended"); },
    shutdown(opts) { assert.equal(this, driver); calls.push(["shutdown", opts]); return Promise.resolve("shutdown"); },
    free() { assert.equal(this, driver); calls.push(["free"]); },
  };
  const { computer } = await makeFixture({ driver });
  const connected = computer.options.driverFactory("synthetic-socket");
  const opts = { marker: "same options" };
  const input = { marker: "same input" };
  assert.equal(await connected.endSession(input, opts), "ended");
  assert.equal(await connected.shutdown(opts), "shutdown");
  connected.free();
  assert.deepEqual(calls, [["endSession", input, opts], ["shutdown", opts], ["free"]]);
});

test("malformed, unknown, oversized and sink-throw diagnostics never alter native results", async () => {
  assert.equal(projectDiagnostic("{"), undefined);
  assert.equal(projectDiagnostic("x".repeat(4097)), undefined);
  assert.equal(projectDiagnostic("界".repeat(1400)), undefined);
  assert.equal(projectDiagnostic(JSON.stringify({ observed: { frontmost_window_diagnostic: { ...safeDiagnostic, source: "unknown" } } })), undefined);
  assert.equal(projectDiagnostic(JSON.stringify({ observed: { frontmost_window_diagnostic: { ...safeDiagnostic, frontmost_window_pid: -1 } } })), undefined);

  const legacyConflict = JSON.parse(resultFor(safeDiagnostic).structuredJson);
  legacyConflict.observed.frontmost_ordinary_window_id = 999;
  assert.equal(projectDiagnostic(JSON.stringify(legacyConflict)), undefined);
  const relationConflict = JSON.parse(resultFor(safeDiagnostic).structuredJson);
  relationConflict.observed.frontmost_window_diagnostic.target_window_id_relation = "same";
  assert.equal(projectDiagnostic(JSON.stringify(relationConflict)), undefined);
  const missingLegacyId = JSON.parse(resultFor(safeDiagnostic).structuredJson);
  delete missingLegacyId.observed.frontmost_ordinary_window_id;
  assert.equal(projectDiagnostic(JSON.stringify(missingLegacyId)), undefined);
  const invalidTargetId = JSON.parse(resultFor(safeDiagnostic).structuredJson);
  invalidTargetId.window_id = 0;
  assert.equal(projectDiagnostic(JSON.stringify(invalidTargetId)), undefined);
  const missingTargetPid = JSON.parse(resultFor(safeDiagnostic).structuredJson);
  delete missingTargetPid.pid;
  assert.equal(projectDiagnostic(JSON.stringify(missingTargetPid)), undefined);
  const relationPidConflict = JSON.parse(resultFor(safeDiagnostic).structuredJson);
  relationPidConflict.observed.frontmost_window_diagnostic.target_pid_relation = "different";
  assert.equal(projectDiagnostic(JSON.stringify(relationPidConflict)), undefined);
  const missingDiagnostic = JSON.parse(resultFor(safeDiagnostic).structuredJson);
  missingDiagnostic.observed.frontmost_window_diagnostic.state = "missing";
  assert.equal(projectDiagnostic(JSON.stringify(missingDiagnostic)), undefined);

  const nativeResult = resultFor(safeDiagnostic);
  const driver = { callTool() { return Promise.resolve(nativeResult); } };
  const { computer } = await makeFixture({ driver, onEvidence() { throw new Error("sink failure"); } });
  assert.equal(await computer.options.driverFactory("synthetic-socket").callTool("bring_to_front", "{}"), nativeResult);
});

test("asynchronous sink rejection is consumed without process failure or secret leakage", () => {
  const moduleUrl = new URL("./activation-receipt-observer.mjs", import.meta.url).href;
  const source = `
    import { createObservedCuaImporter } from ${JSON.stringify(moduleUrl)};
    const result = { structuredJson: ${JSON.stringify(resultFor(safeDiagnostic).structuredJson)} };
    const driver = { callTool() { return Promise.resolve(result); } };
    class Base { constructor(options) { this.options = options; } }
    const importer = createObservedCuaImporter({
      importCuaComputer: async () => ({ CuaDriverComputer: Base }),
      connectDriver: () => driver,
      onEvidence: () => Promise.reject(new Error("PRIVATE_ASYNC_SINK_MARKER")),
    });
    const module = await importer();
    const computer = new module.CuaDriverComputer({ socketPath: "synthetic" });
    const output = await computer.options.driverFactory("synthetic").callTool("bring_to_front", "{}");
    if (output !== result) process.exitCode = 2;
    await new Promise((resolve) => setTimeout(resolve, 25));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr.includes("PRIVATE_ASYNC_SINK_MARKER"), false);
  assert.equal(child.stdout.includes("PRIVATE_ASYNC_SINK_MARKER"), false);
});
