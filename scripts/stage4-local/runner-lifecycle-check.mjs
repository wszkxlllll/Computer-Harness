// Execute the actual runner control flow with in-memory files and fake children.
// No CUA/native driver, process, model request or desktop action may be launched.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import * as path from "node:path";
import * as url from "node:url";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const filename = url.fileURLToPath(new URL("../../spikes/cua-driver/stage4-local-runner.ts", import.meta.url));
const source = readFileSync(filename, "utf8");
const mainGuard = source.lastIndexOf("if (process.argv[1]");
assert(mainGuard >= 0, "runner entry guard changed; update this test boundary");
// Expose the entry only in this test VM; leave production exports unchanged.
const testSource = source.slice(0, mainGuard)
  .replaceAll("import.meta.url", JSON.stringify(url.pathToFileURL(filename).href))
  + "\nglobalThis.auditMain = main;";
const compiled = ts.transpileModule(testSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

async function runScenario(scenario) {
  const writes = new Map();
  const killedPids = [];
  let daemon, cliSpawns = 0, stateReads = 0, cancelInjected = false;
  const proc = new EventEmitter();
  Object.assign(proc, {
    platform: "win32", execPath: "mock-node",
    stdout: { write() {} }, stderr: { write() {} },
    kill(pid) { killedPids.push(pid); return true; },
    argv: ["mock-node", filename, "--binary", "mock-driver.exe", "--fixture", "mock-fixture.exe",
      "--task", "audit", "--model", "glm-5.3-flash", "--socket", "mock-pipe",
      "--output", "mock-output", "--env-file", "mock.env"],
  });
  function cancel() {
    if (!cancelInjected) { cancelInjected = true; proc.emit("SIGINT"); }
  }
  function makeChild() {
    const child = new EventEmitter();
    child.exitCode = null; child.signalCode = null;
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdout.setEncoding = child.stderr.setEncoding = () => {};
    child.finish = (code = 0, signal = null) => {
      child.exitCode = code; child.signalCode = signal;
      child.emit("close", code, signal);
    };
    child.kill = (signal = "SIGTERM") => {
      queueMicrotask(() => child.finish(null, signal)); return true;
    };
    return child;
  }
  const driver = {
    async startSession() {},
    async endSession(input, options) {
      if (input.session.startsWith("stage4-bootstrap-") && scenario === "cancel_at_bootstrap_end") cancel();
      if (input.session.startsWith("stage4-cleanup-") && scenario === "cleanup_end_hangs") {
        return new Promise((_, reject) => {
          const signal = options?.signal;
          if (signal?.aborted) reject(signal.reason);
          else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
    },
    async shutdown() {},
    async callTool(name, rawInput) {
      const input = JSON.parse(rawInput);
      let result = {};
      if (name === "launch_app") result = { pid: 12345 };
      if (name === "list_windows") result = { windows: input.pid ? [{ window_id: 1 }] : [] };
      if (name === "bring_to_front") result = { landed_on_target: scenario !== "foreground_refused" };
      return { isError: false, structuredJson: JSON.stringify(result) };
    },
  };
  const mocks = {
    "node:fs/promises": {
      async mkdir() {}, async readdir() { return []; }, async unlink() {},
      async writeFile(p, text) { writes.set(path.basename(p), text); },
      async readFile(p) {
        const name = path.basename(p);
        if (name === "stage-4-local-tasks-2026-08-31.json") return JSON.stringify({
          version: 1, models: ["glm-5.3-flash"], tasks: [{ id: "audit", goal: "audit",
            initialText: "READY\r\n", expectedText: "DONE", maxSteps: 12, maxModelRequests: 16 }],
        });
        if (name === "fixture-state.txt") {
          stateReads++;
          if (scenario === "cancel_at_final_state_read" && stateReads === 2) cancel();
          return scenario === "initial_mismatch" ? "text=WRONG\n" : "text=READY\\r\\n\n";
        }
        if (name === "summary.json" && scenario !== "cancel_during_cli") {
          return JSON.stringify({ runtimeOutcome: scenario === "task_failed" ? "failed" : "succeeded" });
        }
        if (name === "evaluation.json") return JSON.stringify({ success: scenario !== "task_failed" });
        throw Object.assign(new Error("mock file missing: " + name), { code: "ENOENT" });
      },
    },
    "node:child_process": {
      spawn(command, args) {
        const child = makeChild();
        if (args[0] === "serve") { daemon = child; return child; }
        const isCli = String(args[0]).endsWith("index.js");
        if (isCli) cliSpawns++;
        queueMicrotask(() => {
          if (isCli && scenario === "cancel_during_cli") { cancel(); return; }
          if (args[0] === "status") child.stdout.emit("data", "daemon is running");
          if (args[0] === "stop") {
            if (scenario === "stop_spawn_error") {
              child.emit("error", new Error("mock stop spawn error")); child.finish(1); return;
            }
            daemon.finish();
          }
          child.finish();
        });
        return child;
      },
    },
    "@trycua/cua-driver": {
      CuaDriver: { connect() { return driver; } },
      StartSessionInput: { new: (x) => x }, EndSessionInput: { new: (x) => x },
    },
  };
  const context = {
    exports: {}, process: proc, AbortController, AbortSignal,
    // Only shorten fake wait/cleanup timers, never actual application timers.
    setTimeout: (callback, ms) => setTimeout(callback, Math.min(ms, 20)), clearTimeout,
    require(id) {
      if (id in mocks) return mocks[id];
      if (id === "node:path" || id === "node:url") return require(id);
      throw new Error("unmocked runner dependency: " + id);
    },
  };
  vm.runInNewContext(compiled, context, { filename: "runner-lifecycle-test.js" });
  let timeout;
  try {
    await Promise.race([context.auditMain(), new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("runner stalled in " + scenario)), 2000);
    })]);
  } finally { clearTimeout(timeout); }
  assert(writes.has("runner.json"), scenario + ": missing final report");
  const report = JSON.parse(writes.get("runner.json"));
  const blocked = ["cancel_at_bootstrap_end", "cancel_at_final_state_read", "foreground_refused", "initial_mismatch"].includes(scenario);
  assert.equal(cliSpawns, blocked ? 0 : 1, scenario + ": unexpected model process launch");
  assert(killedPids.includes(12345), scenario + ": fixture was not cleaned up");
  assert(daemon.exitCode !== null || daemon.signalCode !== null, scenario + ": daemon leaked");
  assert.equal(report.status, ["normal", "task_failed"].includes(scenario) ? "completed" : "failed");
  if (scenario === "task_failed") {
    assert.equal(report.taskSuccess, false); assert.equal(report.runtimeOutcome, "failed");
  }
  if (scenario === "cancel_during_cli") assert.equal(report.runtime.status, "unavailable");
  if (scenario === "stop_spawn_error" || scenario === "cleanup_end_hangs") assert(report.cleanup.errors.length > 0);
  return { scenario, cliSpawns, status: report.status, passed: true };
}

const results = [];
for (const scenario of ["normal", "task_failed", "cancel_at_bootstrap_end", "cancel_at_final_state_read",
  "foreground_refused", "initial_mismatch", "cancel_during_cli", "cleanup_end_hangs", "stop_spawn_error"]) {
  results.push(await runScenario(scenario));
}
process.stdout.write(JSON.stringify(results, null, 2) + "\n");
