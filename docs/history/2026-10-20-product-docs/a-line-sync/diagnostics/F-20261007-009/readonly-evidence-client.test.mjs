import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createReadonlyEvidenceClient, validateEvidence } from './readonly-evidence-client.mjs';

const socketPath = '/private/tmp/F009-fixture.Abc123/diagnostic.sock';
const expected = () => ({ pid: 401, parentPid: 400, executable: '/private/tmp/F009-bin.Abc123/cua-driver-local' });
const metadata = () => ({ ok: true, result: { pid: 401, embedded: false,
  driver_version: '0.22.2', contract_version: '1', tools_list_schema_version: '1', capability_version: '1', mcp_protocol_version: '1' } });
const permission = () => ({ ok: true, result: { structuredContent: {
  accessibility: true, screen_recording: true, screen_recording_capturable: null,
  direct_capture_status: 'not_checked', direct_capture_error: null,
  source: { pid: 401, responsible_ppid: 400, executable: expected().executable, attribution: 'driver-daemon' },
} } });
const frame = (v) => Buffer.from(`${JSON.stringify(v)}\n`);
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
class Clock {
  value = 0; next = 0; timers = new Map();
  now = () => this.value;
  setTimeout = (fn, ms) => { const id = ++this.next; this.timers.set(id, { fn, at: this.value + ms }); return id; };
  clearTimeout = (id) => this.timers.delete(id);
  advance(ms) { this.value += ms; for (const [id, t] of [...this.timers]) if (t.at <= this.value) { this.timers.delete(id); t.fn(); } }
}
function fixture({ reply, fsChange } = {}) {
  const clock = new Clock();
  const sockets = []; const requests = []; let lstatCalls = 0;
  const fs = {
    realpath: async (path) => path,
    lstat: async (path) => {
      lstatCalls++;
      const parent = path !== socketPath;
      const stat = { uid: 501, mode: parent ? 0o40700 : 0o140600, dev: 7, ino: parent ? 70 : 71,
        isSymbolicLink: () => false, isDirectory: () => parent, isSocket: () => !parent };
      fsChange?.(stat, path, lstatCalls);
      return stat;
    },
  };
  const connect = ({ path }) => {
    assert.equal(path, socketPath);
    const s = new EventEmitter(); s.destroyed = false;
    s.destroy = () => { s.destroyed = true; };
    s.write = (text) => {
      const req = JSON.parse(text); requests.push(req);
      if (reply) reply(s, req, requests.length);
      else queueMicrotask(() => s.emit('data', frame(req.method === 'metadata' ? metadata() : permission())));
    };
    sockets.push(s); queueMicrotask(() => s.emit('connect'));
    return s;
  };
  const client = createReadonlyEvidenceClient({ fs, connect, clock, uid: 501 });
  return { client, clock, sockets, requests, fs, inspect: (opts = {}) => client.inspect({ socketPath, expected: expected(), ...opts }) };
}

test('matching self-reports remain unverified and only two fixed requests are sent', async () => {
  const f = fixture(); const result = await f.inspect();
  assert.equal(result.outcome, 'permission_ownership_unverified');
  assert.equal(result.readyForDispatch, false); assert.equal(result.permissionOwnership, 'unverified');
  assert.equal(result.identitySelfReportsMatch, true);
  assert.deepEqual(f.requests, [{ method: 'metadata' }, { method: 'call', name: 'check_permissions', args: { prompt: false, probe_direct_capture: false } }]);
  assert.ok(f.sockets.every((s) => s.destroyed)); assert.equal(f.clock.timers.size, 0);
  assert.ok(!JSON.stringify(result).includes('/private/'));
});

test('validator refuses caller, false grants, missing payload, wrong PID/PPID/path and capture probe', async (t) => {
  const cases = [
    ['caller_attribution', (p) => { p.result.structuredContent.source.attribution = 'caller'; }],
    ['permission_not_granted', (p) => { p.result.structuredContent.accessibility = false; }],
    ['permission_reply_invalid', (p) => { delete p.result.structuredContent; }],
    ['permission_reply_invalid', (p) => { p.result.isError = true; }],
    ['permission_identity_mismatch', (p) => { p.result.structuredContent.source.pid++; }],
    ['permission_identity_mismatch', (p) => { p.result.structuredContent.source.responsible_ppid++; }],
    ['permission_identity_mismatch', (p) => { p.result.structuredContent.source.executable = '/sensitive/path'; }],
    ['direct_probe_not_excluded', (p) => { p.result.structuredContent.screen_recording_capturable = true; }],
    ['direct_probe_not_excluded', (p) => { p.result.structuredContent.direct_capture_status = 'ready'; }],
    ['permission_attribution_unknown', (p) => { p.result.structuredContent.source.attribution = 'host'; }],
  ];
  for (const [outcome, mutate] of cases) await t.test(outcome, () => {
    const p = permission(); mutate(p);
    const result = validateEvidence({ metadata: metadata(), permission: p, expected: expected() });
    assert.equal(result.outcome, outcome); assert.equal(result.readyForDispatch, false);
    assert.ok(!JSON.stringify(result).includes('sensitive'));
  });
});

test('metadata fields and exact PID/embedded contract are required', () => {
  for (const mutate of [m => { m.result.pid++; }, m => { m.result.embedded = true; }, m => { delete m.result.contract_version; }, m => { m.ok = false; }]) {
    const m = metadata(); mutate(m);
    assert.notEqual(validateEvidence({ metadata: m, permission: permission(), expected: expected() }).outcome, 'permission_ownership_unverified');
  }
});

test('invalid metadata gates the second query and contradictory success envelopes are refused', async () => {
  for (const mutate of [m => { m.result.pid++; }, m => { m.error = 'private error text'; }, m => { m.exit_code = 1; }]) {
    const f = fixture({ reply: (s, req) => {
      const value = req.method === 'metadata' ? metadata() : permission(); mutate(value);
      queueMicrotask(() => s.emit('data', frame(value)));
    } });
    const result = await f.inspect(); assert.match(result.outcome, /^metadata_(invalid|identity_mismatch)$/u);
    assert.equal(f.requests.length, 1); assert.equal(f.sockets.length, 1); assert.equal(f.sockets[0].destroyed, true);
    assert.ok(!JSON.stringify(result).includes('private error text'));
  }
  for (const extra of [{ error: 'private' }, { exit_code: 1 }]) {
    const p = { ...permission(), ...extra };
    assert.equal(validateEvidence({ metadata: metadata(), permission: p, expected: expected() }).outcome, 'permission_reply_invalid');
  }
});

test('unsafe path, wrong deadline and identity are refused before filesystem/transport', async () => {
  const f = fixture(); f.fs.realpath = () => assert.fail('must not read');
  for (const path of ['/tmp/x.sock', '/private/tmp/x.sock', '/private/tmp/a/../b.sock', '/private/tmp/a//b.sock', '/private/tmp/a/\0b']) {
    assert.equal((await f.inspect({ socketPath: path })).outcome, 'endpoint_invalid');
  }
  assert.equal((await f.inspect({ timeoutMs: 30_001 })).outcome, 'deadline_invalid');
  assert.equal((await f.inspect({ expected: { ...expected(), pid: 0 } })).outcome, 'expected_identity_invalid');
  assert.equal((await f.inspect({ method: 'shutdown' })).outcome, 'request_options_invalid');
  assert.equal((await f.inspect({ params: {} })).outcome, 'request_options_invalid');
  assert.equal((await f.inspect({ expected: { ...expected(), tool: 'screenshot' } })).outcome, 'expected_identity_invalid');
  assert.equal(f.sockets.length, 0);
});

test('canonical parent, private mode, owner and socket type are required', async (t) => {
  for (const mutate of [s => { s.uid = 502; }, s => { s.mode |= 0o020; }, s => { s.isSymbolicLink = () => true; }, s => { s.isSocket = () => false; s.isDirectory = () => false; }]) await t.test('unsafe stat', async () => {
    const f = fixture({ fsChange: mutate });
    assert.match((await f.inspect()).outcome, /^endpoint_(parent|socket)_unsafe$/u); assert.equal(f.sockets.length, 0);
  });
  const f = fixture(); f.fs.realpath = async () => '/private/tmp/different';
  assert.equal((await f.inspect()).outcome, 'endpoint_not_canonical');
});

test('endpoint replacement between requests blocks second request and after reply blocks evidence', async () => {
  for (const threshold of [3, 5]) {
    const f = fixture({ fsChange: (s, _p, n) => { if (n >= threshold) s.ino++; } });
    assert.equal((await f.inspect()).outcome, 'endpoint_changed');
    assert.equal(f.requests.length, threshold === 3 ? 1 : 2);
  }
});

test('one total deadline includes both queries and closes a waiting socket', async () => {
  const f = fixture({ reply: (s, req) => {
    if (req.method === 'metadata') { f.clock.value = 29_000; queueMicrotask(() => s.emit('data', frame(metadata()))); }
  } });
  const pending = f.inspect(); await flush();
  assert.equal(f.requests.length, 2); f.clock.advance(1_000);
  assert.equal((await pending).outcome, 'deadline_exceeded');
  assert.ok(f.sockets.every(s => s.destroyed)); assert.equal(f.requests.length, 2);
});

test('deadline during filesystem work cannot connect after late resolution', async () => {
  const f = fixture(); const gate = Promise.withResolvers(); f.fs.realpath = () => gate.promise;
  const pending = f.inspect(); await flush(); f.clock.advance(30_000);
  assert.equal((await pending).outcome, 'deadline_exceeded');
  gate.resolve('/private/tmp/F009-fixture.Abc123'); await flush(); assert.equal(f.sockets.length, 0);
});

test('external and pre-existing abort stop transport and late events are ignored', async () => {
  const controller = new AbortController(); const f = fixture({ reply: () => {} });
  const pending = f.inspect({ signal: controller.signal }); await flush(); controller.abort();
  assert.equal((await pending).outcome, 'aborted'); assert.equal(f.sockets.length, 1);
  f.sockets[0].emit('connect'); f.sockets[0].emit('data', frame(metadata())); f.sockets[0].emit('error', new Error('secret'));
  assert.equal(f.requests.length, 1); assert.ok(f.sockets[0].destroyed);
  const g = fixture(); assert.equal((await g.inspect({ signal: controller.signal })).outcome, 'aborted'); assert.equal(g.sockets.length, 0);
});

test('repeated connect events before a reply cannot send the same request twice', async () => {
  const f = fixture({ reply: () => {} }); const abort = new AbortController();
  const pending = f.inspect({ signal: abort.signal }); await flush();
  assert.equal(f.requests.length, 1);
  f.sockets[0].emit('connect'); f.sockets[0].emit('connect');
  assert.equal(f.requests.length, 1);
  abort.abort(); assert.equal((await pending).outcome, 'aborted');
});

test('wire rejects oversized, multiple, malformed JSON, invalid UTF8 and incomplete responses without retry', async (t) => {
  const cases = [
    ['reply_too_large', s => s.emit('data', Buffer.alloc(65_537, 120))],
    ['reply_multiple_frames', s => s.emit('data', Buffer.concat([frame(metadata()), frame(metadata())]))],
    ['reply_invalid', s => s.emit('data', Buffer.from('{bad}\n'))],
    ['reply_invalid', s => s.emit('data', Buffer.from([0xff, 10]))],
    ['reply_incomplete', s => s.emit('end')],
    ['socket_error', s => s.emit('error', new Error('private raw body'))],
  ];
  for (const [outcome, action] of cases) await t.test(outcome, async () => {
    const f = fixture({ reply: s => queueMicrotask(() => action(s)) }); const result = await f.inspect();
    assert.equal(result.outcome, outcome); assert.equal(f.sockets.length, 1); assert.ok(f.sockets[0].destroyed);
    assert.ok(!JSON.stringify(result).includes('private raw body'));
  });
});

test('fragmented UTF8 framing accepts one reply up to the exact byte boundary', async () => {
  const f = fixture({ reply: (s, req) => {
    const body = req.method === 'metadata' ? metadata() : permission(); body.ignored = '中文';
    let bytes = frame(body);
    bytes = Buffer.concat([bytes.subarray(0, -1), Buffer.alloc(65_536 - bytes.length, 32), Buffer.from('\n')]);
    queueMicrotask(() => { for (let i = 0; i < bytes.length; i += 1023) s.emit('data', bytes.subarray(i, i + 1023)); });
  } });
  assert.equal((await f.inspect()).outcome, 'permission_ownership_unverified');
});

test('supplied expected identity is snapshotted before asynchronous work', async () => {
  const e = expected(); const f = fixture(); const pending = f.inspect({ expected: e }); e.pid = 999;
  assert.equal((await pending).identitySelfReportsMatch, true);
});
