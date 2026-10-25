import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { pathToFileURL, fileURLToPath } from 'node:url';
const CORE_URL = new URL('./direct-diagnostic-core.mjs', import.meta.url);
const { runDiagnostic } = await import(CORE_URL.href);
// Independent prepared inputs only. No target imports, I/O, assertions or runs.
// Adapt to the author's final frozen API before counting any actual tests.
const RAW_SENTINEL = 'PRIVATE_RAW_TITLE_ERROR_DO_NOT_REPORT_018';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const PROTOCOL = '2025-06-18';

function preflightReceipt(outcome, self, ax, screen) {
  return `{"schema":"harness.diagnostic_preflight.v1","outcome":"${outcome}","selfIdentityValidated":${self},"accessibility":${ax},"screenCapture":${screen},"principalVerified":false,"readyForDispatch":false}\n`;
}

const preflightCases = [];
for (const ax of [true, false, null]) {
  for (const screen of [true, false, null]) {
    const outcome = ax === true && screen === true ? 'observed_unverified'
      : ax === null || screen === null ? 'permission_status_unknown'
      : 'permissions_not_granted';
    preflightCases.push({
      label: `self-true-${ax}-${screen}`,
      stdout: preflightReceipt(outcome, true, ax, screen),
      exitCode: outcome === 'observed_unverified' ? 0 : 2,
    });
  }
}
for (const outcome of ['identity_unknown', 'identity_rejected', 'report_unknown', 'invalid_arguments']) {
  preflightCases.push({
    label: outcome, stdout: preflightReceipt(outcome, false, null, null),
    exitCode: outcome === 'invalid_arguments' ? 64 : 2,
  });
}

const tt = preflightCases[0].stdout;
const malformedPreflightCases = [
  { label: 'missing-LF', stdout: tt.slice(0, -1) },
  { label: 'extra-LF', stdout: `${tt}\n` },
  { label: 'duplicate-record', stdout: tt + tt },
  { label: 'wrong-ready', stdout: tt.replace('"readyForDispatch":false', '"readyForDispatch":true') },
  { label: 'extra-field', stdout: tt.replace('}\n', `,"text":"${RAW_SENTINEL}"}\n`) },
  { label: 'wrong-exit', stdout: tt, exitCode: 2 },
  { label: 'signalled', stdout: tt, exitCode: null, signal: 'SIGTERM' },
  { label: 'stderr', stdout: tt, stderr: RAW_SENTINEL },
  { label: '1024-not-canonical', stdout: 'x'.repeat(1024) },
  { label: '1025-over-cap', stdout: 'x'.repeat(1025) },
];

const bindingMutations = [
  'caller-self-authenticated-pin', 'different-artifact-digest',
  'different-preflight-source', 'different-review-source', 'different-epoch',
  'different-pid', 'different-window-id', 'expired-before-write',
  'symlink-endpoint', 'file-replaced-after-validation', 'mode-auto-chain',
];

const cancellationReasons = [null, 0, { marker: 'exact-object-identity' }];
const cancellationPoints = [
  'pre-spawn', 'initialize-write', 'bring-last-guard', 'approval-consumption',
  'result-getter', 'timer-cleanup', 'listener-cleanup', 'return-last-guard',
];

const lifecycleCases = [
  'EOF-without-exit', 'exit-before-close', 'close-before-complete-response',
  'TERM-synchronously-observes-exit', 'late-timer-after-close',
  'KILL-latch-reentry', 'unknown-retains-owner', 'never-exit-no-new-spawn',
];

// A single 8KiB chunk below the cumulative cap is LEGAL and processed in
// <=4KiB slices; only bytes exceeding the remaining total allowance refuse.
const streamBoundaries = [
  { label: '8KiB-single-chunk-legal', chunkBytes: 8192, totalBytes: 8192, cap: 65536, overBudget: false },
  { label: 'cumulative-exact-cap', chunkBytes: 8192, totalBytes: 65536, cap: 65536, overBudget: false },
  { label: 'cumulative-cap-plus-one', chunkBytes: 8192, totalBytes: 65537, cap: 65536, overBudget: true },
];

const clockCases = [
  'never-read-local-race', 'empty-flood-logical-expiry',
  'synchronous-write-crosses-deadline', 'parse-crosses-deadline',
  'late-resolve-no-success', 'late-reject-observed',
];


const tick = async () => { for (let i = 0; i < 200; i++) await Promise.resolve(); };
const init = { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'cua-driver', version: '0.22.2' }, instructions: '' } };
function receipt() {
  return { jsonrpc: '2.0', id: 2, result: { isError: false, content: [{ type: 'text', text: RAW_SENTINEL }], structuredContent: {
    pid: 42, window_id: 77, status: 'activated', activated: true, request_accepted: true, process_activated: true,
    exact_window_effect: { verified: true, focused: true, frontmost_ordinary: true },
    observed: { frontmost_pid: 42, workspace_frontmost_pid: 42, focused_window_id: 77, frontmost_ordinary_window_id: 77, front_process_matches_target: true,
      frontmost_window_diagnostic: { schema: 'cua.frontmost_window_diagnostic.v1', source: 'observe_exact_window_existing_visible_windows_snapshot', state: 'present', frontmost_window_pid: 42, frontmost_window_id: 77, layer: 0, z: 1, is_on_screen: true, target_pid_relation: 'same', target_window_id_relation: 'same' } },
  } } };
}
const stdout = (value) => ({ type: 'stdout', data: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value) + '\n') });

function fixture(mode = 'bring', options = {}) {
  const controller = new AbortController();
  let clock = 0, serial = 0;
  const timers = new Map(), queue = [], waiters = [];
  const seen = { spawn: [], writes: [], signals: [], retain: 0, end: 0, reads: 0, verify: 0, consume: [] };
  const state = { exitCode: null, signalCode: null, closed: false, ownership: 'owned' };
  const emit = (event) => {
    if (waiters.length) waiters.shift()(event); else queue.push(event);
  };
  const apply = (event) => {
    if (event.type === 'exit') { state.exitCode = event.code; state.signalCode = event.signal; }
    if (event.type === 'close') state.closed = true;
    return event;
  };
  const permission = {
    mode, epoch: 'fixed-epoch', artifactDigest: DIGEST_A, expiresAt: 100000,
    reviewed: true, reviewSource: { source: 'independent-review', sha256: 'd'.repeat(64) },
    preflightSource: { source: 'f018-new-artifact-preflight', sha256: 'e'.repeat(64) },
    preflight: { artifactDigest: DIGEST_A, source: 'trusted-preflight-record', reviewedBy: 'trusted-review-record', selfIdentityValidated: true, accessibility: true, screenCapture: true, outcome: 'observed_unverified' },
    pid: 42, windowId: 77, emergency: { term: false, kill: false },
  };
  Object.assign(permission, options.permission);
  const consumed = new Set();
  const permit = {
    read() { options.onPermitRead?.(permission, controller); return { ...permission }; },
    consume(label) {
      seen.consume.push(label);
      options.onConsume?.(label, permission, controller);
      if (consumed.has(label)) return false;
      consumed.add(label); return true;
    },
  };
  const child = {
    read() {
      seen.reads++;
      if (options.onRead) return Promise.resolve(options.onRead({ emit, clock, controller, seen })).then(apply);
      return (queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve) => waiters.push(resolve))).then(apply);
    },
    write(bytes) {
      const message = JSON.parse(bytes.toString('utf8'));
      seen.writes.push(message);
      options.onWrite?.(message, { emit, permission, controller, seen });
      if (message.method === 'initialize') emit(stdout(options.initialize ?? init));
      if (message.method === 'tools/call') emit(stdout(options.receipt ?? receipt()));
      return options.writeAck ?? true;
    },
    end() {
      seen.end++;
      options.onEnd?.({ emit, controller, seen, state });
      if (!options.pending) { emit({ type: 'exit', code: options.exitCode ?? 0, signal: null }); emit({ type: 'close' }); }
    },
    snapshot() { return { ...state }; },
    signal(kind) {
      seen.signals.push(kind);
      options.onSignal?.(kind, { emit, controller, seen, state });
    },
  };
  const ops = {
    now: () => clock,
    setTimer(callback, delay) { const id = ++serial; timers.set(id, { callback, at: clock + delay }); return id; },
    clearTimer(id) { timers.delete(id); options.onClearTimer?.(controller); },
    verifyArtifact() { seen.verify++; options.onVerify?.({ controller, seen }); return { verified: true, digest: options.digest ?? DIGEST_A }; },
    spawn(spec) {
      spec.beforeSpawn(); seen.spawn.push(spec); options.onSpawn?.({ controller, seen });
      if (mode === 'preflight') {
        const p = options.preflight ?? preflightCases[0];
        emit(stdout(p.stdout));
        if (p.stderr) emit({ type: 'stderr', data: Buffer.from(p.stderr) });
        emit({ type: 'exit', code: p.exitCode ?? 0, signal: p.signal ?? null }); emit({ type: 'close' });
      }
      return child;
    },
    retain(value) { assert.equal(value, child); seen.retain++; },
  };
  return {
    mode, controller, permission, seen, state, timers, emit,
    run: () => runDiagnostic({ mode, signal: controller.signal, permit }, ops),
    advance(ms) { clock += ms; for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.callback(); } },
    block(ms) { clock += ms; },
  };
}

test('all 13 preflight mappings and canonical-only malformed rejection', async () => {
  for (const value of preflightCases) {
    const f = fixture('preflight', { preflight: value }); const result = await f.run();
    assert.equal(result.cause, 'none', value.label); assert.equal(f.seen.spawn.length, 1); assert.equal(result.bringSent, false);
  }
  for (const value of malformedPreflightCases) {
    const f = fixture('preflight', { preflight: value }); const result = await f.run();
    assert.notEqual(result.cause, 'none', value.label); assert.equal(result.observation, null);
  }
});

test('single MCP bring, fixed args/environment and raw text never projected', async () => {
  const f = fixture(); const result = await f.run();
  assert.equal(result.cause, 'none'); assert.equal(result.cleanup, 'exit_and_close_observed');
  assert.deepEqual(f.seen.writes.map((v) => v.method), ['initialize', 'notifications/initialized', 'tools/call']);
  assert.deepEqual(f.seen.spawn[0].argv, ['mcp', '--direct']);
  assert.equal(JSON.stringify(result).includes(RAW_SENTINEL), false);
  assert.equal(result.principalVerified, false); assert.equal(result.readyForDispatch, false);
  assert.equal(f.timers.size, 0);
});

test('wrong protocol or contradictory initialize refuses before bring', async () => {
  for (const value of [
    { ...init, result: { ...init.result, protocolVersion: '2024-11-05' } },
    { ...init, error: { code: -1, message: RAW_SENTINEL } },
    { ...init, id: 2 },
  ]) {
    const f = fixture('bring', { initialize: value }); const result = await f.run();
    assert.notEqual(result.cause, 'none'); assert.equal(f.seen.writes.some((v) => v.method === 'tools/call'), false);
  }
});

test('digest and preflight digest cross binding refuse before spawn', async () => {
  for (const permission of [
    { artifactDigest: DIGEST_B },
    { preflight: { artifactDigest: DIGEST_B, selfIdentityValidated: true, accessibility: true, screenCapture: true, outcome: 'observed_unverified' } },
  ]) {
    const f = fixture('bring', { permission }); const result = await f.run();
    assert.notEqual(result.cause, 'none'); assert.equal(f.seen.spawn.length, 0);
  }
});

test('unreviewed source cannot self authenticate merely with reviewed boolean', async () => {
  const f = fixture('bring', { permission: { reviewSource: null, preflightSource: null,
    preflight: { artifactDigest: DIGEST_A, selfIdentityValidated: true, accessibility: true, screenCapture: true, outcome: 'observed_unverified' } } });
  const result = await f.run(); assert.notEqual(result.cause, 'none'); assert.equal(f.seen.spawn.length, 0);
});

test('reviewed source record drift at initialized callback blocks action', async () => {
  for (const key of ['preflightSource', 'reviewSource']) {
    const f = fixture('bring', { onWrite(message, { permission }) {
      if (message.method === 'notifications/initialized') permission[key].sha256 = DIGEST_B;
    } });
    const result = await f.run(); assert.equal(result.cause, 'permission_invalid'); assert.equal(result.bringSent, false);
  }
});

test('pre-cancel preserves null zero object and performs zero spawn', async () => {
  for (const reason of [null, 0, { exact: true }]) {
    const f = fixture(); f.controller.abort(reason);
    let caught; try { await f.run(); } catch (error) { caught = error; }
    assert.equal(caught, reason); assert.equal(f.seen.spawn.length, 0);
  }
});

test('consume side cancellation blocks final bring write and preserves raw reason', async () => {
  const reason = { exact: 'withdrawn-at-consume' };
  const f = fixture('bring', { onConsume(label, p, controller) { if (label === 'bring') controller.abort(reason); } });
  let caught; try { await f.run(); } catch (error) { caught = error; }
  assert.equal(caught, reason); assert.equal(f.seen.writes.some((v) => v.method === 'tools/call'), false);
});

test('partial write never retries action or initialize', async () => {
  const f = fixture('bring', { writeAck: false }); const result = await f.run();
  assert.notEqual(result.cause, 'none'); assert.equal(f.seen.writes.length, 1);
  assert.equal(f.seen.spawn.length, 1); assert.equal(f.seen.end, 1);
});

test('8KiB chunk under budget is valid, cumulative 64KiB boundary is shared', async () => {
  for (const total of [65536, 65537]) {
    const response = receipt(); const action = JSON.stringify(response) + '\n';
    const base = JSON.stringify(init) + '\n';
    const padding = total - Buffer.byteLength(base) - Buffer.byteLength(action);
    const initialize = { ...init, result: { ...init.result, instructions: 'x'.repeat(padding) } };
    const f = fixture('bring', { initialize }); const result = await f.run();
    if (total === 65536) assert.equal(result.cause, 'none');
    else assert.notEqual(result.cause, 'none');
  }
});

test('never read deadline settles locally and retains unexited owned child', async () => {
  const f = fixture('bring', { pending: true, onRead: () => new Promise(() => {}) });
  const promise = f.run(); await tick(); f.advance(30000); await tick(); f.advance(5000); await tick();
  const result = await promise; assert.equal(result.cleanup, 'pending'); assert.equal(f.seen.retain, 1);
  assert.equal(f.seen.signals.length, 0); assert.equal(f.seen.spawn.length, 1);
});

test('EOF alone cannot turn timeout into exit or release', async () => {
  const f = fixture('bring', { pending: true, onRead: () => ({ type: 'eof' }) });
  const promise = f.run(); await tick(); f.advance(30000); await tick(); f.advance(5000); await tick();
  const result = await promise; assert.equal(result.cleanup, 'pending'); assert.equal(result.observation, null);
});

test('mutable epoch and target snapshot cannot change at initialized callback', async () => {
  for (const key of ['epoch', 'pid', 'windowId']) {
    const f = fixture('bring', { onWrite(message, { permission }) {
      if (message.method === 'notifications/initialized') permission[key] = key === 'epoch' ? 'new-epoch' : 100;
    } });
    const result = await f.run(); assert.equal(result.cause, 'permission_invalid');
    assert.equal(f.seen.writes.some((v) => v.method === 'tools/call'), false);
  }
});

test('logical synchronous spawn overrun sends zero bring and still cleans child', async () => {
  let f; f = fixture('bring', { onSpawn() { f.block(30000); } });
  const result = await f.run(); assert.equal(result.cause, 'deadline');
  assert.equal(f.seen.writes.length, 0); assert.equal(result.cleanup, 'exit_and_close_observed');
});

test('empty stream logical expiry and late rejection cannot resume writes', async () => {
  let f; f = fixture('bring', { onRead() { f.block(1000); return { type: 'stdout', data: Buffer.alloc(0) }; } });
  const result = await f.run(); assert.equal(result.cause, 'deadline');
  assert.equal(result.cleanup, 'pending'); assert.equal(f.seen.writes.length, 1);
  let reject;
  const late = fixture('bring', { pending: true, onRead: () => new Promise((_yes, no) => { reject = no; }) });
  const promise = late.run(); await tick(); late.advance(30000); await tick(); late.advance(5000); await tick();
  assert.equal((await promise).cleanup, 'pending'); reject(new Error(RAW_SENTINEL)); await tick();
  assert.equal(late.seen.reads, 1); assert.equal(late.seen.writes.length, 1);
});

test('cleanup cancellation preserves reason and cannot return projected success', async () => {
  for (const reason of [null, 0, { at: 'end' }]) {
    const f = fixture('bring', { onEnd({ controller }) { controller.abort(reason); } });
    let caught; try { await f.run(); } catch (error) { caught = error; }
    assert.equal(caught, reason); assert.equal(f.seen.end, 1);
  }
});

test('SIGTERM exit callback precludes KILL and all late signals', async () => {
  const f = fixture('bring', { pending: true, permission: { emergency: { term: true, kill: true } },
    onEnd({ emit }) { emit({ type: 'eof' }); },
    onSignal(kind, { emit, state }) {
      assert.equal(kind, 'SIGTERM'); state.exitCode = 0;
      emit({ type: 'exit', code: 0, signal: null }); emit({ type: 'close' });
    } });
  const promise = f.run(); await tick(); f.advance(5000); await tick();
  const result = await promise; assert.equal(result.cleanup, 'exit_and_close_observed');
  assert.deepEqual(f.seen.signals, ['SIGTERM']); f.advance(60000); await tick();
  assert.deepEqual(f.seen.signals, ['SIGTERM']);
});

test('explicit emergency TERM/KILL each once retains still-live owner', async () => {
  const f = fixture('bring', { pending: true, permission: { emergency: { term: true, kill: true } } });
  const promise = f.run(); await tick(); f.advance(5000); await tick(); f.advance(5000); await tick(); f.advance(5000); await tick();
  const result = await promise; assert.deepEqual(f.seen.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(result.cleanup, 'pending'); assert.equal(f.seen.retain, 1); assert.equal(f.seen.spawn.length, 1);
});

test('kill-only emergency cannot skip reviewed TERM phase', async () => {
  const f = fixture('bring', { permission: { emergency: { term: false, kill: true } } });
  const result = await f.run(); assert.equal(result.cause, 'permission_invalid');
  assert.equal(f.seen.spawn.length, 0); assert.deepEqual(f.seen.signals, []);
});

test('synchronous write reentry with same permit cannot duplicate spawn or action', async () => {
  let second, f;
  f = fixture('bring', { onWrite(message) { if (message.method === 'initialize') second = f.run(); } });
  const first = await f.run(); assert.equal(first.cause, 'none');
  assert.equal((await second).cause, 'opportunity_consumed'); assert.equal(f.seen.spawn.length, 1);
  assert.equal(f.seen.writes.filter((v) => v.method === 'tools/call').length, 1);
});

test('duplicate response in one chunk and invalid UTF8 reject without raw output', async () => {
  for (const initial of [Buffer.from(JSON.stringify(init) + '\n' + JSON.stringify(init) + '\n'), Buffer.from([0xff, 10])]) {
    const f = fixture('bring', { onRead: (() => { let n = 0; return () => ++n === 1
      ? { type: 'stdout', data: initial } : n === 2 ? { type: 'exit', code: 0, signal: null } : { type: 'close' }; })() });
    const result = await f.run(); assert.notEqual(result.cause, 'none'); assert.equal(result.bringSent, false);
    assert.equal(JSON.stringify(result).includes(RAW_SENTINEL), false);
  }
});


// Read SOURCE only, evaluate with wholly fake fs/child_process/clock/process.
// The real CLI entry block is removed; no native candidate or real admission.
const sourcePath = fileURLToPath(new URL('./direct-diagnostic-cli.mjs', CORE_URL));
const source = fs.readFileSync(sourcePath, 'utf8').split("if (process.argv[1]")[0]
  .replace(/^import .*;\n/gm, '').replace(/export /g, '') + '\nglobalThis.api={createTrustedSources,ownedChild,main,readBoundedDescriptor,TRUST_ROOT};';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function sandbox(spawnFake, runFake) {
  const files = new Map(), descriptors = new Map(), offsets = new Map(); let fd = 100, ino = 1;
  const HOME = '/virtual/home', bundle = '/virtual/candidate/HarnessF005Diagnostic.app';
  const root = '/private/tmp/Direct-Combo-20261007.p4b1rC/approved-control';
  function error(code) { return Object.assign(new Error('FAKE_RAW_NOT_REPORT'), { code }); }
  const put = (name, bytes = null, type = 'file') => {
    for (let p = path.dirname(name); p !== '/'; p = path.dirname(p)) if (!files.has(p)) files.set(p, { ino: ino++, type: 'dir', bytes: Buffer.alloc(0) });
    files.set(name, { ino: ino++, type, bytes: bytes === null ? Buffer.alloc(0) : Buffer.from(bytes) });
  };
  put(root, null, 'dir'); put(HOME, null, 'dir');
  const required = ['Contents/Info.plist', 'Contents/MacOS/cua-driver-local', 'Contents/_CodeSignature/CodeResources'];
  const specs = required.map((relative) => { const bytes = Buffer.from('SYNTHETIC_' + relative); put(path.join(bundle, relative), bytes); return { path: relative, size: bytes.length, sha256: sha(bytes) }; });
  const artifact = { schema: 'harness.f018.artifact.v1', reviewedBy: 'coordinator-6', version: '0.22.2', bundleRoot: bundle, cdhash: 'c'.repeat(40), designatedRequirement: 'synthetic reviewed requirement', home: HOME, configSha256: 'absent', files: specs };
  const pinned = (name, value) => { const bytes = Buffer.from(JSON.stringify(value)); put(path.join(root, name + '.json'), bytes); put(path.join(root, name + '.sha256'), sha(bytes) + '\n'); };
  pinned('artifact', artifact);
  pinned('permit', { mode: 'bring', reviewed: true, artifactDigest: sha(Buffer.from(JSON.stringify(artifact))), epoch: 'epoch', expiresAtUtcMs: 110000 });
  const stat = (name) => {
    const v = files.get(name); if (!v) throw error('ENOENT');
    return { dev: 1n, ino: BigInt(v.ino), mode: 0o600n, uid: 501n, size: BigInt(v.bytes.length), mtimeNs: 1n, ctimeNs: 1n,
      isFile: () => v.type === 'file', isDirectory: () => v.type === 'dir', isSymbolicLink: () => v.type === 'link' };
  };
  const fakefs = {
    constants: fs.constants, lstatSync: stat, realpathSync: (name) => name,
    openSync(name, flags) {
      if (flags & fs.constants.O_CREAT) { if (files.has(name)) throw error('EEXIST'); put(name); }
      stat(name); const id = fd++; descriptors.set(id, name); offsets.set(id, 0); return id;
    },
    fstatSync: (id) => stat(descriptors.get(id)),
    readFileSync: () => { throw new Error('UNBOUNDED_FILE_READ_FORBIDDEN'); },
    readSync: (id, target, offset, length, position) => {
      const bytes = files.get(descriptors.get(id)).bytes;
      const start = position ?? offsets.get(id), amount = Math.max(0, Math.min(length, bytes.length - start));
      if (position === null) offsets.set(id, start + amount);
      bytes.copy(target, offset, start, start + amount); return amount;
    },
    closeSync: (id) => descriptors.delete(id),
    readdirSync: (dir) => [...files.keys()].filter((name) => path.dirname(name) === dir).map((name) => path.basename(name)),
  };
  let mono = 100;
  const listeners = new Map(); let keepers = 0;
  const context = { fs: fakefs, path, createHash, performance: { now: () => mono },
    spawn: spawnFake ?? (() => { throw new Error('REAL_SPAWN_FORBIDDEN'); }),
    process: { argv: [], env: { HOME }, on(name, fn) { listeners.set(name, fn); }, removeListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); } },
    Buffer, TextDecoder, AbortController, Date: { now: () => 100000 },
    setInterval() { keepers++; return { ref() {} }; }, setTimeout() { throw new Error('NATIVE_TIMER_FORBIDDEN'); }, clearTimeout() {},
    runDiagnostic: runFake ?? (() => { throw new Error('CLI_MAIN_FORBIDDEN'); }), fileURLToPath: () => { throw new Error('ENTRY_FORBIDDEN'); } };
  vm.runInNewContext(source, context, { timeout: 1000 });
  return { api: context.api, files, put, pinned, artifact, root, bundle, listeners, keepers: () => keepers, clock: (ms) => { mono += ms; } };
}

test('CLI trusted source fake: stable pins accepted, missing/drift/symlink refuse', () => {
  const s = sandbox(), sources = s.api.createTrustedSources();
  assert.equal(sources.verifyArtifact().verified, true);
  s.put(path.join(s.bundle, s.artifact.files[1].path), 'REPLACED');
  assert.equal(sources.verifyArtifact().verified, false);
  const missing = sandbox(); missing.files.delete(path.join(missing.root, 'artifact.sha256'));
  assert.equal(missing.api.createTrustedSources().verifyArtifact().verified, false);
  const link = sandbox(); link.put(path.join(link.bundle, 'Contents'), null, 'link');
  assert.equal(link.api.createTrustedSources().verifyArtifact().verified, false);
});

test('CLI markers are O_EXCL and UTC is converted once into monotonic validity', () => {
  const s = sandbox(), sources = s.api.createTrustedSources();
  assert.equal(sources.verifyArtifact().verified, true);
  const before = sources.permit.read(); s.clock(9999); const after = sources.permit.read();
  assert.equal(before.expiresAt, 10100); assert.equal(after.expiresAt, before.expiresAt);
  assert.equal(sources.permit.consume('attempt'), true);
  assert.equal(sources.permit.consume('attempt'), false);
  assert.equal(s.api.createTrustedSources().permit.consume('attempt'), false);
});

test('standard Node in-memory Readable cadence bounds the adapter queue', async () => {
  let generated = 0, consumed = 0, maximumQueued = 0;
  class Stream extends Readable {
    _read() { setImmediate(() => { if (!this.destroyed) this.push(Buffer.alloc(4096)); }); }
  }
  const cp = new EventEmitter(); cp.stdout = new Stream(); cp.stderr = new Stream(); cp.stdin = new EventEmitter();
  cp.exitCode = null; cp.signalCode = null; cp.kill = () => { throw new Error('SIGNAL_FORBIDDEN'); };
  cp.stdout.on('data', () => generated++); cp.stderr.on('data', () => generated++);
  const s = sandbox(() => cp);
  const child = s.api.ownedChild({ argv: ['mcp', '--direct'], env: {}, beforeSpawn() {} }, { verifyArtifact: () => ({ verified: true, executable: '/virtual/exe', home: '/virtual/home' }) });
  try {
    for (let i = 0; i < 100; i++) {
      await child.read(); consumed++; maximumQueued = Math.max(maximumQueued, generated - consumed);
    }
    assert.ok(maximumQueued <= 2, `standard Node queue=${maximumQueued}`);
  } finally { cp.stdout.destroy(); cp.stderr.destroy(); }
});

test('pending keeper main preserves SIGINT and SIGTERM cancellation handlers', async () => {
  const s = sandbox(undefined, async (_request, ops) => {
    ops.retain({ snapshot: () => ({ ownership: 'owned', closed: false }) });
    return { cleanup: 'pending', cause: 'cleanup_pending' };
  });
  // Expose only for fake VM invocation; no real fs/child/timer execution.
  // main is added by the final source exposure below.
  const result = await s.api.main(['bring']);
  assert.equal(result.cleanup, 'pending'); assert.equal(s.keepers(), 1);
  assert.equal(s.listeners.has('SIGINT'), true); assert.equal(s.listeners.has('SIGTERM'), true);
  s.listeners.get('SIGTERM')(); assert.equal(s.keepers(), 1);
});

test('raw Run rejection also retains keeper cancellation handlers', async () => {
  const s = sandbox(undefined, async (_request, ops) => { ops.retain({}); throw 0; });
  await s.api.main(['bring']); assert.equal(s.listeners.has('SIGTERM'), true);
});

test('completed fake main removes temporary signal handlers', async () => {
  const s = sandbox(undefined, async () => ({ cleanup: 'exit_and_close_observed', cause: 'none' }));
  await s.api.main(['bring']); assert.equal(s.listeners.size, 0);
});

test('descriptor growth reads at most cap plus one and short reads are not EOF', () => {
  const s = sandbox(); let offset = 0, requested = 0;
  const bytes = Buffer.from('1234567890');
  const reader = { readSync(_fd, buffer, position, length) {
    requested += length;
    const amount = Math.min(2, bytes.length - offset, length);
    bytes.copy(buffer, position, offset, offset + amount); offset += amount; return amount;
  } };
  assert.equal(s.api.readBoundedDescriptor(reader, 1, 10).toString(), '1234567890'); assert.equal(offset, 10);
  let produced = 0, maxAllocation = 0;
  const grows = { readSync(_fd, buffer, position, length) { maxAllocation = Math.max(maxAllocation, buffer.length); buffer.fill(120, position, position + length); produced += length; return length; } };
  assert.throws(() => s.api.readBoundedDescriptor(grows, 1, 10), /trusted_source_unknown/);
  assert.equal(produced, 11); assert.equal(maxAllocation, 11);
});

