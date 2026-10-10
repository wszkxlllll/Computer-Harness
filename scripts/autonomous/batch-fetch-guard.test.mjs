import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import {
  createDurableFetchGuard,
  DEFAULT_BATCH_LIMITS,
  DEFAULT_RUN_RESERVATION,
  extendBatchReservation,
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

test("accepts a bounded custom batch cap and rejects caps above defaults before delegation", async (t) => {
  const bounded = await fixture(t, {
    limits: { total: 66, main: 60, risk: 6 },
    reservation: { total: 42, main: 40, risk: 2 },
  });
  for (let i = 0; i < 40; i += 1) await bounded.guard.fetch(GLM_ENDPOINT, request());
  for (let i = 0; i < 2; i += 1) await bounded.guard.fetch(GLM_ENDPOINT, request(["risk_classification"]));
  await assert.rejects(bounded.guard.fetch(GLM_ENDPOINT, request()), /FETCH_BUDGET_EXHAUSTED/);
  assert.equal(bounded.calls.length, 42);
  assert.deepEqual(JSON.parse(fs.readFileSync(join(bounded.root, "counter.json"), "utf8")).actual, { total: 42, main: 40, risk: 2 });

  const overLimit = await fixture(t, {
    limits: { total: 133, main: 121, risk: 12 },
    reservation: DEFAULT_RUN_RESERVATION,
  });
  await assert.rejects(overLimit.guard.fetch(GLM_ENDPOINT, request()), /COUNTER_IDENTITY_REFUSED/);
  assert.equal(overLimit.calls.length, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(join(overLimit.root, "counter.json"), "utf8")).actual, { total: 0, main: 0, risk: 0 });
});

test("allows the bounded GLM high reasoning profile and rejects max or unknown effort before delegation", async (t) => {
  const f = await fixture(t);
  await f.guard.fetch(GLM_ENDPOINT, request(["click"], { reasoning_effort: "high" }));
  assert.equal(f.calls.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(join(f.root, "counter.json"), "utf8")).actual, { total: 1, main: 1, risk: 0 });

  await assert.rejects(f.guard.fetch(GLM_ENDPOINT, request(["click"], { reasoning_effort: "max" })), /FETCH_PROFILE_REFUSED/);
  await assert.rejects(f.guard.fetch(GLM_ENDPOINT, request(["click"], { reasoning_effort: "unexpected" })), /FETCH_PROFILE_REFUSED/);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(join(f.root, "counter.json"), "utf8")).actual, { total: 1, main: 1, risk: 0 });
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

test("extends the same reservation cumulatively and hash-audits the change without changing actual or sequence", async (t) => {
  const f = await fixture(t);
  await f.guard.fetch(GLM_ENDPOINT, request());
  await f.guard.fetch(GLM_ENDPOINT, request(["risk_classification"]));
  const before = JSON.parse(fs.readFileSync(join(f.root, "counter.json"), "utf8"));
  const result = extendBatchReservation(f.root, {
    batchId: "A01",
    reservationId: "T2-baseline",
    reservation: { total: 84, main: 80, risk: 4 },
    reason: "Continue the same A01 validation batch",
  });
  const after = JSON.parse(fs.readFileSync(join(f.root, "counter.json"), "utf8"));
  const audit = fs.readFileSync(join(f.root, "audit.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const extension = audit.at(-1);
  assert.deepEqual(result, { reservation: { total: 84, main: 80, risk: 4 }, actual: { total: 2, main: 1, risk: 1 }, sequence: 2, reservationRevision: 1 });
  assert.equal(after.reservationId, before.reservationId);
  assert.deepEqual(after.actual, before.actual);
  assert.equal(after.sequence, before.sequence);
  assert.deepEqual(after.reservation, { total: 84, main: 80, risk: 4 });
  assert.equal(after.reservationRevision, 1);
  assert.match(after.reservationChainHash, /^[a-f0-9]{64}$/u);
  assert.equal(extension.kind, "reservation_extended");
  assert.deepEqual(extension.oldReservation, DEFAULT_RUN_RESERVATION);
  assert.deepEqual(extension.newReservation, { total: 84, main: 80, risk: 4 });
  assert.equal(extension.reason, "Continue the same A01 validation batch");
  assert.equal(extension.reservationChainHash, after.reservationChainHash);
  const anchorPath = join(f.root, "counter.anchor.json");
  const priorAnchor = JSON.parse(fs.readFileSync(anchorPath, "utf8"));
  fs.writeFileSync(anchorPath, JSON.stringify({ schema: priorAnchor.schema, batchId: priorAnchor.batchId, sequence: priorAnchor.sequence, chainHash: priorAnchor.chainHash, stateHash: priorAnchor.stateHash }) + "\n", { mode: 0o600 });
  const resumed = createDurableFetchGuard({ root: f.root, batchId: "A01", reservationId: "T2-baseline", delegate: async () => ({ ok: true }) });
  await resumed.fetch(GLM_ENDPOINT, request());
  const afterOldAnchorShape = JSON.parse(fs.readFileSync(join(f.root, "counter.json"), "utf8"));
  assert.equal(afterOldAnchorShape.sequence, 3);
  assert.equal(afterOldAnchorShape.reservationRevision, 1);
  extendBatchReservation(f.root, {
    batchId: "A01",
    reservationId: "T2-baseline",
    reservation: { total: 90, main: 86, risk: 4 },
    reason: "Continue same cumulative batch after old Host write",
  });
});

test("rejects reservation identity, decrement, no-op, and global-limit changes without altering counter state", async (t) => {
  const f = await fixture(t);
  await f.guard.fetch(GLM_ENDPOINT, request());
  const common = { batchId: "A01", reservationId: "T2-baseline", reason: "bounded test extension" };
  assert.throws(() => extendBatchReservation(f.root, { ...common, reservationId: "other-run", reservation: { total: 84, main: 80, risk: 4 } }), /COUNTER_IDENTITY_REFUSED/);
  extendBatchReservation(f.root, { ...common, reservation: { total: 84, main: 80, risk: 4 } });
  const before = fs.readFileSync(join(f.root, "counter.json"), "utf8");
  assert.throws(() => extendBatchReservation(f.root, { ...common, reservation: { total: 42, main: 40, risk: 2 } }), /RESERVATION_EXTENSION_REFUSED/);
  assert.throws(() => extendBatchReservation(f.root, { ...common, reservation: { total: 133, main: 121, risk: 12 } }), /RESERVATION_EXTENSION_REFUSED/);
  assert.throws(() => extendBatchReservation(f.root, { ...common, reservation: { total: 84, main: 80, risk: 4 } }), /RESERVATION_EXTENSION_REFUSED/);
  assert.equal(fs.readFileSync(join(f.root, "counter.json"), "utf8"), before);
});

test("refuses reservation extension when the exclusive lock is held or the audit chain was changed", async (t) => {
  const f = await fixture(t);
  const common = { batchId: "A01", reservationId: "T2-baseline", reservation: { total: 84, main: 80, risk: 4 }, reason: "bounded test extension" };
  fs.writeFileSync(join(f.root, "counter.lock"), "busy", { mode: 0o600, flag: "wx" });
  assert.throws(() => extendBatchReservation(f.root, common), /COUNTER_LOCK_BUSY_OR_STALE/);
  fs.unlinkSync(join(f.root, "counter.lock"));
  await f.guard.fetch(GLM_ENDPOINT, request());
  extendBatchReservation(f.root, common);
  const auditPath = join(f.root, "audit.jsonl");
  const lines = fs.readFileSync(auditPath, "utf8").trim().split("\n");
  const last = JSON.parse(lines.at(-1));
  last.reason = "tampered after extension";
  lines[lines.length - 1] = JSON.stringify(last);
  fs.writeFileSync(auditPath, `${lines.join("\n")}\n`, { mode: 0o600 });
  assert.throws(() => extendBatchReservation(f.root, { ...common, reservation: { total: 90, main: 86, risk: 4 } }), /COUNTER_AUDIT_REFUSED/);
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

test("allows only read-only loopback CDP metadata fetches without consuming model request budget", async (t) => {
  const f = await fixture(t);
  const signal = new AbortController().signal;
  await f.guard.fetch("http://127.0.0.1:9222/json/version", { signal });
  await f.guard.fetch("http://127.0.0.1:65535/json/list");
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls.map(({ url, init }) => ({ url, init: { method: init.method, redirect: init.redirect, signal: init.signal } })), [
    { url: "http://127.0.0.1:9222/json/version", init: { method: "GET", redirect: "error", signal } },
    { url: "http://127.0.0.1:65535/json/list", init: { method: "GET", redirect: "error", signal: undefined } },
  ]);
  assert.deepEqual(JSON.parse(fs.readFileSync(join(f.root, "counter.json"), "utf8")).actual, { total: 0, main: 0, risk: 0 });
});

test("rejects loopback CDP lookalikes, query data, unsafe methods and redirects", async (t) => {
  const f = await fixture(t);
  const refused = [
    ["http://localhost:9222/json/version", { method: "GET" }],
    ["http://127.0.0.1/json/version", { method: "GET" }],
    ["http://127.0.0.1:65536/json/version", { method: "GET" }],
    ["http://127.0.0.1:9222/json/version?token=x", { method: "GET" }],
    ["http://127.0.0.1:9222/json/%76ersion", { method: "GET" }],
    ["http://user@127.0.0.1:9222/json/version", { method: "GET" }],
    ["http://127.0.0.1:9222/json/version", { method: "POST", body: "payload" }],
    ["http://127.0.0.1:9222/json/list", { method: "GET", redirect: "follow" }],
    ["http://127.0.0.1:9222/json/list", { method: "GET", headers: { authorization: "x" } }],
  ];
  for (const [url, init] of refused) await assert.rejects(f.guard.fetch(url, init), /FETCH_ENDPOINT_REFUSED|FETCH_REQUEST_REFUSED/u);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(join(f.root, "counter.json"), "utf8")).actual, { total: 0, main: 0, risk: 0 });
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
