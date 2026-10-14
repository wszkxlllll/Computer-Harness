import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readBoundedDescriptor, cleanupCancelHandlers } from './direct-diagnostic-cli.mjs';
import { runDiagnostic, preflightTemplates, INITIALIZE, FIXED_ENV, projectDiagnostic } from './direct-diagnostic-core.mjs';
const D = 'a'.repeat(64);
const init = () => ({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'cua-driver', version: '0.22.2' }, instructions: 'Synthetic instructions' } });
const receipt = () => ({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'PRIVATE_NOT_RETAINED' }], isError: false, structuredContent: {
  pid: 42, window_id: 7, status: 'partial', activated: false, request_accepted: true, process_activated: true,
  exact_window_effect: { verified: false, focused: false, frontmost_ordinary: false },
  observed: { frontmost_pid: 42, workspace_frontmost_pid: 42, focused_window_id: 8, frontmost_ordinary_window_id: 8, front_process_matches_target: true,
    frontmost_window_diagnostic: { schema: 'cua.frontmost_window_diagnostic.v1', source: 'observe_exact_window_existing_visible_windows_snapshot', state: 'present', frontmost_window_pid: 42, frontmost_window_id: 8, layer: 0, z: 1, is_on_screen: true, target_pid_relation: 'same', target_window_id_relation: 'different', title: 'PRIVATE_NOT_RETAINED' } },
} } });
const out = (value) => ({ type: 'stdout', data: Buffer.from(JSON.stringify(value) + '\n') });
const exited = (code = 0) => [{ type: 'exit', code, signal: null }, { type: 'close' }];
function fixture(events = [out(init()), out(receipt()), ...exited()], changes = {}) {
  let now = 0, queue = [...events], pendingRead;
  const record = { writes: [], signals: [], spawn: 0, end: 0, retain: 0, reads: 0 };
  const controller = new AbortController();
  const p = { mode: 'bring', artifactDigest: D, epoch: 'e1', expiresAt: 1000000, reviewed: true, pid: 42, windowId: 7,
    preflightSource: { source: 'f018-new-artifact-preflight', sha256: 'b'.repeat(64) }, reviewSource: { source: 'independent-review', sha256: 'c'.repeat(64) },
    preflight: { artifactDigest: D, outcome: 'observed_unverified', selfIdentityValidated: true, accessibility: true, screenCapture: true }, emergency: { term: false, kill: false }, ...changes.permission };
  const stages = new Set();
  let snapshot = { ownership: 'owned', exitCode: null, signalCode: null, closed: false };
  const child = {
    read() { record.reads++; const event = queue.shift(); if (!event) return new Promise((resolve) => { pendingRead = resolve; });
      if (event.at !== undefined) now = event.at;
      if (event.type === 'exit') snapshot = { ...snapshot, exitCode: event.code, signalCode: event.signal };
      if (event.type === 'close') snapshot.closed = true;
      changes.onRead?.(event, controller, p); return Promise.resolve(event); },
    async write(bytes) { const value = JSON.parse(bytes.toString()); record.writes.push(value); changes.onWrite?.(value, controller, p); return changes.writeAck ?? true; },
    end() { record.end++; changes.onEnd?.(controller, p); }, snapshot() { return snapshot; },
    signal(kind) { record.signals.push(kind); changes.onSignal?.(kind); return true; },
  };
  const ops = {
    now: () => now, setTimer(fn, delay) { return setTimeout(() => { now += delay; fn(); }, 0); }, clearTimer: clearTimeout,
    verifyArtifact: () => changes.artifact ?? { verified: true, digest: D },
    spawn(options) { options.beforeSpawn(); record.spawn++; record.argv = options.argv; record.env = options.env; changes.onSpawn?.(controller, p); return child; },
    retain() { record.retain++; },
  };
  const permit = { read: () => p, consume(stage) { if (stages.has(stage)) return false; stages.add(stage); return true; } };
  return { record, controller, p, ops, permit, child, run: (mode = p.mode) => runDiagnostic({ mode, signal: controller.signal, permit }, ops), deliver(event) { const resolve = pendingRead; pendingRead = undefined; resolve?.(event); } };
}
test('one fixed initialize/notification/bring and private-free projection', async () => {
  const f = fixture(), result = await f.run(); assert.equal(result.cause, 'none'); assert.equal(result.observation.status, 'partial'); assert.equal(result.observation.diagnostic.frontmost_window_id, 8);
  assert.deepEqual(f.record.argv, ['mcp', '--direct']); assert.deepEqual(f.record.env, FIXED_ENV); assert.deepEqual(f.record.writes[0], INITIALIZE);
  assert.deepEqual(f.record.writes.map((r) => r.method), ['initialize', 'notifications/initialized', 'tools/call']); assert.equal(f.record.end, 1); assert.equal(f.record.spawn, 1);
  assert.equal(JSON.stringify(result).includes('PRIVATE_NOT_RETAINED'), false); assert.equal(result.readyForDispatch, false); assert.equal(result.principalVerified, false);
});
test('all thirteen canonical preflight templates require exact matching normal exit', async () => {
  assert.equal(preflightTemplates().length, 13);
  for (const v of preflightTemplates()) {
    const f = fixture([{ type: 'stdout', data: Buffer.from(v.text) }, ...exited(v.exitCode)], { permission: { mode: 'preflight' } });
    const r = await f.run(); assert.equal(r.cause, 'none'); assert.equal(f.record.writes.length, 0); assert.deepEqual(f.record.argv, ['diagnostic-preflight-only']);
  }
});
test('preflight wrong exit and noncanonical JSON are rejected', async () => {
  const v = preflightTemplates().find((v) => v.exitCode === 0);
  for (const events of [[{ type: 'stdout', data: Buffer.from(v.text) }, ...exited(2)], [{ type: 'stdout', data: Buffer.from(' ' + v.text) }, ...exited()]]) {
    const r = await fixture(events, { permission: { mode: 'preflight' } }).run(); assert.equal(r.cause, 'preflight_invalid');
  }
});
test('preabort preserves exact reasons with zero spawn', async () => {
  for (const reason of [null, 0, { synthetic: true }]) { const f = fixture(); f.controller.abort(reason); await assert.rejects(f.run(), (error) => error === reason); assert.equal(f.record.spawn, 0); }
});
test('unknown pins and permission failures dispatch nothing', async () => {
  for (const changes of [{ artifact: { verified: false } }, { permission: { reviewed: false } }, { permission: { preflight: null } }, { permission: { expiresAt: 0 } }]) {
    const f = fixture(undefined, changes); const r = await f.run(); assert.equal(r.spawned, false); assert.equal(f.record.writes.length, 0);
  }
});
test('initialize errors and contradictory envelopes never bring', async () => {
  for (const v of [{ ...init(), error: { message: 'PRIVATE_NOT_RETAINED' } }, { ...init(), id: 9 }, { ...init(), result: { ...init().result, protocolVersion: 'wrong' } }]) {
    const f = fixture([out(v), ...exited()]); const r = await f.run(); assert.equal(r.cause, 'initialize_invalid'); assert.equal(r.bringSent, false);
  }
});
test('partial write latch never retries', async () => {
  const f = fixture(undefined, { writeAck: false }); const r = await f.run(); assert.equal(r.cause, 'write_unknown'); assert.equal(f.record.writes.length, 1); assert.equal(f.record.spawn, 1);
});
test('withdrawn epoch at notification prevents action write', async () => {
  const f = fixture(undefined, { onWrite(value, _controller, p) { if (!value.id) p.epoch = 'withdrawn'; } }); const r = await f.run(); assert.equal(r.bringSent, false); assert.equal(f.record.writes.length, 2);
});
test('cancel during notification keeps raw Run reason and zero action write', async () => {
  const reason = { withdrawn: true }, f = fixture(undefined, { onWrite(value, c) { if (!value.id) c.abort(reason); } }); await assert.rejects(f.run(), (e) => e === reason); assert.equal(f.record.writes.length, 2);
});
test('never read times out with retained owned child and no retry', async () => {
  const f = fixture([]), r = await f.run(); assert.equal(r.cause, 'deadline'); assert.equal(r.cleanup, 'pending'); assert.equal(f.record.retain, 1); assert.equal(f.record.reads, 1); assert.equal(f.record.spawn, 1);
});
test('empty chunk flood is bounded without resetting deadline', async () => {
  const f = fixture([...Array.from({ length: 65 }, () => ({ type: 'stdout', data: Buffer.alloc(0) })), ...exited()]); const r = await f.run(); assert.equal(r.cause, 'empty_flood'); assert.equal(r.bringSent, false);
});
test('large Node chunk within budget is sliced and accepted', async () => {
  const v = init(); v.result.instructions = 'x'.repeat(8192); const f = fixture([out(v), out(receipt()), ...exited()]); assert.equal((await f.run()).cause, 'none');
});
test('cumulative stdout, malformed UTF8, duplicate and wrong ids fail closed', async () => {
  for (const events of [
    [{ type: 'stdout', data: Buffer.alloc(65537) }, ...exited()],
    [{ type: 'stdout', data: Buffer.from([0xff, 10]) }, ...exited()],
    [{ type: 'stdout', data: Buffer.concat([out(init()).data, out(init()).data]) }, ...exited()],
    [out(init()), out({ ...receipt(), id: 3 }), ...exited()],
  ]) { const r = await fixture(events).run(); assert.notEqual(r.cause, 'none'); assert.equal(r.observation, null); }
});
test('stderr raw text is rejected and not returned', async () => {
  const r = await fixture([{ type: 'stderr', data: Buffer.from('PRIVATE_NOT_RETAINED') }, ...exited()]).run(); assert.equal(r.cause, 'stderr_present'); assert.equal(JSON.stringify(r).includes('PRIVATE_NOT_RETAINED'), false);
});
test('deadline after response callback never revives success', async () => {
  const f = fixture([out(init()), { ...out(receipt()), at: 30000 }, ...exited()]); const r = await f.run(); assert.equal(r.cause, 'deadline'); assert.equal(r.observation, null);
});
test('EOF alone does not establish exit; missing close retains ownership', async () => {
  const f = fixture([out(init()), out(receipt()), { type: 'eof' }]); const r = await f.run(); assert.equal(r.cleanup, 'pending'); assert.equal(f.record.retain, 1);
});
test('TERM and KILL each at most once, no retries', async () => {
  const f = fixture([], { permission: { emergency: { term: true, kill: true } } }); const r = await f.run(); assert.equal(r.cleanup, 'pending'); assert.deepEqual(f.record.signals, ['SIGTERM', 'SIGKILL']); assert.equal(f.record.spawn, 1);
});
test('already exit and close produce zero signals', async () => {
  const f = fixture([out(init()), out(receipt()), ...exited()], { permission: { emergency: { term: true, kill: true } } }); await f.run(); assert.deepEqual(f.record.signals, []);
});
test('same permit cannot be used for another exec', async () => {
  const f = fixture(); await f.run(); const r = await f.run(); assert.equal(r.cause, 'opportunity_consumed'); assert.equal(f.record.spawn, 1);
});
test('F005 projector preserves only allowed numeric diagnostic', () => {
  const projected = projectDiagnostic(JSON.stringify(receipt().result.structuredContent)); assert.equal(projected.target_pid, 42); assert.equal('title' in projected, false);
  const s = receipt().result.structuredContent; s.observed.frontmost_window_diagnostic.target_window_id_relation = 'same'; assert.equal(projectDiagnostic(JSON.stringify(s)), undefined);
});
test('preflight also requires independently reviewed permission', async () => {
  const f = fixture([], { permission: { mode: 'preflight', reviewed: false } });
  assert.equal((await f.run()).cause, 'permission_invalid'); assert.equal(f.record.spawn, 0);
});
test('unknown owned-handle identity never signals and retains pending', async () => {
  const f = fixture([], { permission: { emergency: { term: true, kill: true } } });
  f.child.snapshot = () => ({ ownership: 'unknown', exitCode: null, signalCode: null, closed: false });
  const r = await f.run(); assert.equal(r.cleanup, 'pending'); assert.equal(f.record.retain, 1); assert.deepEqual(f.record.signals, []);
});
test('never-settling artifact check aborts with original reason and zero spawn', async () => {
  const f = fixture(), reason = { cancelled: true };
  f.ops.verifyArtifact = () => { queueMicrotask(() => f.controller.abort(reason)); return new Promise(() => {}); };
  await assert.rejects(f.run(), (error) => error === reason); assert.equal(f.record.spawn, 0);
});
test('late rejected read is handled and cannot resume the diagnostic', async () => {
  const f = fixture([]); let reject;
  f.child.read = () => { f.record.reads++; return new Promise((_resolve, no) => { reject = no; }); };
  const result = await f.run(); assert.equal(result.cause, 'deadline'); assert.equal(result.cleanup, 'pending');
  reject(new Error('PRIVATE_NOT_RETAINED')); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.record.reads, 1); assert.equal(f.record.writes.length, 1); assert.equal(result.observation, null);
});
test('cancel from cleanup callback still rejects rather than returning observed success', async () => {
  const reason = 0, f = fixture(undefined, { onEnd(c) { c.abort(reason); } });
  await assert.rejects(f.run(), (error) => error === reason); assert.equal(f.record.end, 1);
});
test('bring requires exact new preflight and independent review records before spawn', async () => {
  for (const permission of [{ preflightSource: null }, { reviewSource: null }, { reviewSource: 'reviewed' },
    { preflightSource: { source: 'old-artifact-preflight', sha256: 'b'.repeat(64) } },
    { reviewSource: { source: 'independent-review', sha256: 'c'.repeat(64), extra: true } }]) {
    const f = fixture(undefined, { permission }); const r = await f.run(); assert.equal(r.cause, 'permission_invalid'); assert.equal(f.record.spawn, 0);
  }
});
test('source record or preflight facts drifting after spawn forbid bring write', async () => {
  for (const change of [(p) => { p.preflightSource.sha256 = 'd'.repeat(64); }, (p) => { p.reviewSource.sha256 = 'd'.repeat(64); },
    (p) => { p.preflight.accessibility = false; }, (p) => { p.preflight.outcome = 'permissions_not_granted'; }]) {
    const f = fixture(undefined, { onWrite(value, _c, p) { if (!value.id) change(p); } });
    const r = await f.run(); assert.equal(r.cause, 'permission_invalid'); assert.equal(r.bringSent, false); assert.equal(f.record.writes.length, 2);
  }
});
test('bounded descriptor loops short reads through EOF and rejects growth after cap+1', () => {
  let position = 0, total = 0;
  const small = Buffer.from('synthetic');
  const fake = { readSync(_fd, buffer, offset, length) { const n = Math.min(2, length, small.length - position); small.copy(buffer, offset, position, position + n); position += n; total += n; return n; } };
  assert.deepEqual(readBoundedDescriptor(fake, 10, small.length), small); assert.equal(total, small.length);
  let growingTotal = 0;
  assert.throws(() => readBoundedDescriptor({ readSync(_fd, buffer, offset, length) { buffer.fill(1, offset, offset + length); growingTotal += length; return length; } }, 10, 65), /trusted_source_unknown/);
  assert.equal(growingTotal, 66);
});
test('pending keeper retains only abort handlers; normal completion removes them', () => {
  const processApi = new EventEmitter(), controller = new AbortController(); let calls = 0;
  const cancel = () => { calls++; controller.abort(0); };
  processApi.on('SIGINT', cancel); processApi.on('SIGTERM', cancel);
  cleanupCancelHandlers(processApi, cancel, true);
  processApi.emit('SIGINT'); processApi.emit('SIGTERM'); assert.equal(calls, 2); assert.equal(controller.signal.reason, 0);
  assert.equal(processApi.listenerCount('SIGINT'), 1); assert.equal(processApi.listenerCount('SIGTERM'), 1);
  cleanupCancelHandlers(processApi, cancel, false); assert.equal(processApi.listenerCount('SIGINT'), 0); assert.equal(processApi.listenerCount('SIGTERM'), 0);
});
test('kill-only emergency permission refuses before spawn and any signal', async () => {
  for (const mode of ['preflight', 'bring']) {
    const f = fixture([], { permission: { mode, emergency: { term: false, kill: true } } });
    assert.equal((await f.run()).cause, 'permission_invalid'); assert.equal(f.record.spawn, 0); assert.deepEqual(f.record.signals, []);
  }
});
