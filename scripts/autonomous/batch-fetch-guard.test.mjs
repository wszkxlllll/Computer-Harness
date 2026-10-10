import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import {
  createDurableFetchGuard,
  DEFAULT_BATCH_LIMITS,
  DEFAULT_RUN_RESERVATION,
  GLM_ENDPOINT,
  initializeBatch,
  installGuard,
} from "./batch-fetch-guard.mjs";

const request = (names = ["click"], patch = {}) => ({
  method: "POST",
  body: JSON.stringify({ model: "glm-5.3-flash", max_tokens: 8192, stream: false, thinking: { type: "enabled" }, tools: names.map((name) => ({ type: "function", function: { name } })), ...patch }),
});
async function fixture(t, { limits = DEFAULT_BATCH_LIMITS, reservation = DEFAULT_RUN_RESERVATION } = {}) {
  const parent = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "harness-a01-")));
  const root = join(parent, "private-batch");
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  initializeBatch(root, { batchId: "A01", reservationId: "T2-baseline", limits, reservation });
  const calls = [];
  const guard = createDurableFetchGuard({ root, batchId: "A01", reservationId: "T2-baseline", delegate: async (url, init) => { calls.push({ url, init }); return { ok: true }; } });
  return { root, calls, guard };
}

test("reserves a main and risk ceiling before the normal Run and enforces both global and Run caps", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 40; i += 1) await f.guard.fetch(GLM_ENDPOINT, request());
  for (let i = 0; i < 2; i += 1) await f.guard.fetch(GLM_ENDPOINT, request(["risk_classification"]));
  await assert.rejects(f.guard.fetch(GLM_ENDPOINT, request()), /FETCH_BUDGET_EXHAUSTED/);
  await assert.rejects(f.guard.fetch(GLM_ENDPOINT, request(["risk_classification"])), /FETCH_BUDGET_EXHAUSTED/);
  assert.equal(f.calls.length, 42);
  assert.deepEqual(JSON.parse(fs.readFileSync(join(f.root, "counter.json"), "utf8")).actual, { total: 42, main: 40, risk: 2 });
});

test("synchronous throw, rejection and timeout consume durable slots without refund", async (t) => {
  const f = await fixture(t, { reservation: { total: 3, main: 3, risk: 0 } });
  let attempt = 0;
  const guard = createDurableFetchGuard({ root: f.root, batchId: "A01", reservationId: "T2-baseline", delegate() {
    attempt += 1;
    if (attempt === 1) throw new Error("synthetic throw");
    if (attempt === 2) return Promise.reject(new Error("synthetic timeout"));
    return Promise.resolve({ ok: false });
  } });
  await assert.rejects(guard.fetch(GLM_ENDPOINT, request()), /synthetic throw/);
  await assert.rejects(guard.fetch(GLM_ENDPOINT, request()), /synthetic timeout/);
  assert.deepEqual(await guard.fetch(GLM_ENDPOINT, request()), { ok: false });
  await assert.rejects(guard.fetch(GLM_ENDPOINT, request()), /FETCH_BUDGET_EXHAUSTED/);
  assert.equal(JSON.parse(fs.readFileSync(join(f.root, "counter.json"), "utf8")).actual.total, 3);
});

test("a new Host guard after restart resumes the same durable monotonic count", async (t) => {
  const f = await fixture(t, { reservation: { total: 2, main: 2, risk: 0 } });
  await f.guard.fetch(GLM_ENDPOINT, request());
  const afterRestart = createDurableFetchGuard({ root: f.root, batchId: "A01", reservationId: "T2-baseline", delegate: async () => ({ ok: true }) });
  await afterRestart.fetch(GLM_ENDPOINT, request());
  await assert.rejects(afterRestart.fetch(GLM_ENDPOINT, request()), /FETCH_BUDGET_EXHAUSTED/);
  assert.equal(JSON.parse(fs.readFileSync(join(f.root, "counter.json"), "utf8")).actual.total, 2);
});

test("parallel callers serialize through the exclusive lock and cannot exceed the reservation", async (t) => {
  const f = await fixture(t, { reservation: { total: 1, main: 1, risk: 0 } });
  const second = createDurableFetchGuard({ root: f.root, batchId: "A01", reservationId: "T2-baseline", delegate: async () => ({ ok: true }) });
  const settled = await Promise.allSettled([f.guard.fetch(GLM_ENDPOINT, request()), second.fetch(GLM_ENDPOINT, request())]);
  assert.equal(settled.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(JSON.parse(fs.readFileSync(join(f.root, "counter.json"), "utf8")).actual.total, 1);
});

test("a rolled-back counter fails closed against its durable anchor", async (t) => {
  const f = await fixture(t, { reservation: { total: 2, main: 2, risk: 0 } });
  await f.guard.fetch(GLM_ENDPOINT, request());
  const state = JSON.parse(fs.readFileSync(join(f.root, "counter.json"), "utf8"));
  state.actual = { total: 0, main: 0, risk: 0 };
  fs.writeFileSync(join(f.root, "counter.json"), JSON.stringify(state) + "\n", { mode: 0o600 });
  const restarted = createDurableFetchGuard({ root: f.root, batchId: "A01", reservationId: "T2-baseline", delegate: async () => ({ ok: true }) });
  await assert.rejects(restarted.fetch(GLM_ENDPOINT, request()), /COUNTER_ROLLBACK_OR_LIMIT/);
});

test("unknown tools, endpoint changes and redirects are rejected without delegate calls", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.guard.fetch("https://example.invalid", request()), /FETCH_ENDPOINT_REFUSED/);
  await assert.rejects(f.guard.fetch(GLM_ENDPOINT, request(["unknown_tool"])), /FETCH_TOOLS_REFUSED/);
  await assert.rejects(f.guard.fetch(GLM_ENDPOINT, { ...request(), redirect: "follow" }), /FETCH_REQUEST_REFUSED/);
  assert.equal(f.calls.length, 0);
});

test("the complete default Host main-tool vocabulary is classified as main", async (t) => {
  const names = ["click", "double_click", "right_click", "type", "keypress", "hotkey", "scroll", "drag", "wait", "switch_window", "list_windows", "click_element", "select_option", "task_create", "task_update", "task_list", "task_get", "execution_segment_set", "memory_get", "memory_write_fact", "memory_mark_fact_needs_check", "memory_search", "memory_upsert_entity", "memory_list", "memory_invalidate_entity", "terminate", "interact"];
  const f = await fixture(t);
  await f.guard.fetch(GLM_ENDPOINT, request(names));
  assert.equal(f.calls.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(join(f.root, "counter.json"), "utf8")).actual.main, 1);
});

test("the installed fetch is non-writable and non-configurable", async (t) => {
  const f = await fixture(t);
  const target = { fetch: async () => ({ ok: true }) };
  installGuard(target, f.guard);
  assert.equal(Object.getOwnPropertyDescriptor(target, "fetch").writable, false);
  assert.equal(Object.getOwnPropertyDescriptor(target, "fetch").configurable, false);
  assert.throws(() => installGuard(target, f.guard), /FETCH_INSTALL_REFUSED/);
});
