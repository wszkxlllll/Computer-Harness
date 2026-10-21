import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createReadonlyEvidenceClient, validateEvidence } from './readonly-evidence-client.mjs';

const path = '/private/tmp/F009-independent.abc123/diagnostic.sock';
const expected = { pid: 401, parentPid: 400, executable: '/private/tmp/F009-independent.abc123/cua-driver-local' };
const meta = () => ({ ok: true, result: { pid: 401, embedded: false, driver_version: '0.22.2', contract_version: '1', tools_list_schema_version: '1', capability_version: '1', mcp_protocol_version: '1' } });
const perm = () => ({ ok: true, result: { structuredContent: { accessibility: true, screen_recording: true, screen_recording_capturable: null, direct_capture_status: 'not_checked', direct_capture_error: null, source: { pid: 401, responsible_ppid: 400, executable: expected.executable, attribution: 'driver-daemon' } } } });
const frame = (x) => Buffer.from(JSON.stringify(x) + '\n');
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function fake(reply) {
  let n = 0;
  const sockets = [], requests = [], timers = new Map();
  const clock = { value: 0, now() { return this.value; }, setTimeout(fn, ms) { timers.set(++n, { fn, at: this.value + ms }); return n; }, clearTimeout(id) { timers.delete(id); } };
  const fs = { realpath: async (p) => p, lstat: async (p) => ({ uid: 501, mode: p === path ? 0o140600 : 0o40700, dev: 7, ino: p === path ? 71 : 70, isSymbolicLink: () => false, isDirectory: () => p !== path, isSocket: () => p === path }) };
  const connect = () => {
    const s = new EventEmitter(); s.closed = 0; s.destroy = () => s.closed++;
    s.write = (line) => { const q = JSON.parse(line); requests.push(q); if (reply) reply(s, q, requests.length); else queueMicrotask(() => s.emit('data', frame(q.method === 'metadata' ? meta() : perm()))); };
    sockets.push(s); queueMicrotask(() => s.emit('connect')); return s;
  };
  const client = createReadonlyEvidenceClient({ fs, connect, clock, uid: 501 });
  return { fs, clock, sockets, requests, timers, inspect: (opts) => client.inspect({ socketPath: path, expected, ...opts }) };
}

test('duplicate connect while awaiting reply must not send same request twice', async () => {
  const f = fake(() => {}), abort = new AbortController();
  const p = f.inspect({ signal: abort.signal }); await flush(); assert.equal(f.requests.length, 1);
  f.sockets[0].emit('connect'); abort.abort(); await p; assert.equal(f.requests.length, 1);
});
test('clock passes deadline before timer delivery: no second request or usable evidence', async () => {
  let f; f = fake((s) => { f.clock.value = 30001; s.emit('data', frame(meta())); });
  const r = await f.inspect(); assert.equal(r.outcome, 'deadline_exceeded'); assert.equal(f.requests.length, 1); assert.equal(r.readyForDispatch, false); assert.equal(f.timers.size, 0);
});
test('deadline while connect pending: cancellation closes once and late connect cannot send', async () => {
  const f = fake(() => {}), original = f.clock.setTimeout.bind(f.clock); let stop;
  f.clock.setTimeout = (fn, ms) => { stop = fn; return original(fn, ms); };
  const p = f.inspect(); await flush(); f.clock.value = 30000; stop(); const r = await p;
  assert.equal(r.outcome, 'deadline_exceeded'); f.sockets[0].emit('connect'); assert.equal(f.requests.length, 1); assert.ok(f.sockets.every((s) => s.closed > 0));
});
test('abort during second filesystem identity check prevents permission request', async () => {
  const f = fake(), abort = new AbortController(); let calls = 0;
  f.fs.realpath = async (p) => { if (++calls === 2) abort.abort(); return p; };
  assert.equal((await f.inspect({ signal: abort.signal })).outcome, 'aborted'); assert.equal(f.requests.length, 1);
});
test('socket missing after permission cannot retain positive fields', async () => {
  const f = fake(), original = f.fs.lstat; let count = 0;
  f.fs.lstat = async (p) => { if (++count === 6) throw new Error('private ENOENT'); return original(p); };
  const r = await f.inspect(); assert.equal(r.outcome, 'evidence_unavailable'); assert.equal(r.identitySelfReportsMatch, false); assert.equal(r.accessibility, null); assert.equal(r.readyForDispatch, false);
});
test('invalid UTF8 split over chunks is refused', async () => {
  const f = fake((s) => queueMicrotask(() => { s.emit('data', Buffer.from([0xe4])); s.emit('data', Buffer.from([0xff, 10])); }));
  assert.equal((await f.inspect()).outcome, 'reply_invalid'); assert.equal(f.requests.length, 1);
});
test('fake bundle, source flags and true grants never produce permission ownership', () => {
  const p = perm(); p.result.structuredContent.source.bundle_id = 'com.trycua.driver.local'; p.result.structuredContent.source.disclaim_env = true;
  const r = validateEvidence({ metadata: meta(), permission: p, expected }); assert.equal(r.permissionOwnership, 'unverified'); assert.equal(r.readyForDispatch, false); assert.equal(r.identitySelfReportsMatch, true);
});
test('wrong metadata embedded and malformed isError never accepted', () => {
  for (const v of [1, 'false', null, {}, []]) { const p = perm(); p.result.isError = v; assert.equal(validateEvidence({ metadata: meta(), permission: p, expected }).outcome, 'permission_reply_invalid'); }
  const m = meta(); m.result.embedded = true; assert.equal(validateEvidence({ metadata: m, permission: perm(), expected }).outcome, 'metadata_identity_mismatch');
});
test('unknown caller options and identity fields rejected without effects', async () => {
  const f = fake(); assert.equal((await f.inspect({ method: 'shutdown' })).outcome, 'request_options_invalid');
  assert.equal((await f.inspect({ expected: { ...expected, signal: 'TERM' } })).outcome, 'expected_identity_invalid'); assert.equal(f.sockets.length, 0);
});
test('socket-close-without-frame does not retry', async () => {
  const f = fake((s) => queueMicrotask(() => s.emit('close'))); assert.equal((await f.inspect()).outcome, 'reply_incomplete'); assert.equal(f.sockets.length, 1); assert.equal(f.timers.size, 0);
});
test('invalid metadata must stop before permission request', async () => {
  const f = fake((s, q) => { const m = meta(); m.result.pid++; queueMicrotask(() => s.emit('data', frame(q.method === 'metadata' ? m : perm()))); });
  const result = await f.inspect(); assert.equal(result.outcome, 'metadata_identity_mismatch'); assert.equal(f.requests.length, 1);
});
test('contradictory successful error envelopes must not count as matching self reports', () => {
  const m = meta(); m.error = 'private error';
  assert.equal(validateEvidence({ metadata: m, permission: perm(), expected }).outcome, 'metadata_invalid');
  const p = perm(); p.error = 'private error';
  assert.equal(validateEvidence({ metadata: meta(), permission: p, expected }).outcome, 'permission_reply_invalid');
});
