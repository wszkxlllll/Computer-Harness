import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnosticLauncher } from './diagnostic-launcher.mjs';

class FakeClock {
  value = 0;
  next = 0;
  timers = new Map();
  now = () => this.value;
  setTimeout = (fn, ms) => {
    const id = ++this.next;
    this.timers.set(id, { at: this.value + ms, fn });
    return id;
  };
  clearTimeout = (id) => this.timers.delete(id);
  async advance(ms) {
    this.value += ms;
    for (const [id, timer] of [...this.timers]) if (timer.at <= this.value) {
      this.timers.delete(id);
      timer.fn();
    }
    await flush();
  }
}

const goodInspection = () => ({
  identity: {
    child: { pid: 4101, parentPid: 4100, start: 'c-start-1', executable: { path: '/private/tmp/bin/cua-driver-local', sha256: 'a'.repeat(64) } },
    parent: { pid: 4100, start: 'p-start-1', executable: { path: '/private/tmp/bin/launcher', sha256: 'b'.repeat(64) } },
    socket: { path: '/private/tmp/F008-live-20261007.Abc123/diagnostic.sock', dev: 7, ino: 91, uid: 501, mode: 0o600 },
  },
  permissions: { pass: true, prompt: false, grants: { accessibility: true, screenCapture: true } },
});

function makeAdapter(overrides = {}) {
  const calls = [];
  const candidate = Object.freeze({ opaqueCandidate: true });
  const adapter = {
    async startCandidate({ signal }) { calls.push(['start', signal.aborted]); return candidate; },
    async inspect(_candidate) { calls.push(['inspect']); return goodInspection(); },
    terminateExact(_candidate, role, identity, options) { calls.push(['term', role, identity.child.pid, options.signal]); return true; },
    async waitForExit(_candidate, role, identity) { calls.push(['exit', role, identity.child.pid]); return true; },
    async dispatchRunner({ identity }) { calls.push(['dispatch', identity.child.pid]); },
    ...overrides,
  };
  return { adapter, calls, candidate };
}

const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
const fakeClock = () => {
  const value = new FakeClock();
  return { value, clock: { now: value.now, setTimeout: value.setTimeout, clearTimeout: value.clearTimeout } };
};

test('startup reaches awaiting_review but never dispatches automatically', async () => {
  const { adapter, calls } = makeAdapter();
  const launcher = createDiagnosticLauncher({ adapter, clock: fakeClock().clock });
  const state = await launcher.start();
  assert.equal(state.phase, 'awaiting_review');
  assert.equal(state.dispatchCount, 0);
  assert.equal(calls.some(([kind]) => kind === 'dispatch'), false);
  assert.ok(launcher.getReviewToken());
});

test('start deadline timer is armed before the lifecycle adapter is invoked', async () => {
  const fake = fakeClock();
  let timerCountAtCall = 0;
  const { adapter } = makeAdapter({ startCandidate: async () => { timerCountAtCall = fake.value.timers.size; return {}; } });
  const launcher = createDiagnosticLauncher({ adapter, clock: fake.clock });
  await launcher.start();
  assert.equal(timerCountAtCall, 1);
});

test('approval is token-bound, single-use, rechecks identity and dispatches at most once', async () => {
  const gate = Promise.withResolvers();
  let inspectCount = 0;
  const { adapter, calls } = makeAdapter({ inspect: async () => (++inspectCount === 1 ? goodInspection() : gate.promise) });
  const { clock } = fakeClock();
  const launcher = createDiagnosticLauncher({ adapter, clock });
  await launcher.start();
  const token = launcher.getReviewToken();
  const first = launcher.review(token, { approved: true, prompt: false });
  const second = await launcher.review(token, { approved: true, prompt: false });
  assert.equal(second.dispatchCount, 0);
  gate.resolve(goodInspection());
  const done = await first;
  assert.equal(done.phase, 'dispatched');
  assert.equal(calls.filter(([kind]) => kind === 'dispatch').length, 1);
  await launcher.review(token, { approved: true, prompt: false });
  assert.equal(calls.filter(([kind]) => kind === 'dispatch').length, 1);
});

test('false, unknown, prompted, or missing permission approval stops without dispatch', async (t) => {
  for (const decision of [undefined, { approved: false, prompt: false }, { approved: true, prompt: true }, { approved: true }]) {
    await t.test(JSON.stringify(decision), async () => {
      const { adapter, calls } = makeAdapter();
      const launcher = createDiagnosticLauncher({ adapter, clock: fakeClock().clock });
      await launcher.start();
      await launcher.review(launcher.getReviewToken(), decision);
      assert.equal(calls.some(([kind]) => kind === 'dispatch'), false);
      assert.deepEqual(calls.filter(([kind]) => kind === 'term').map(([, role]) => role), ['child', 'parent']);
      assert.equal(launcher.snapshot().phase, 'released');
    });
  }
});

test('missing, false, prompted, or incomplete permission snapshot stops but still cleans up known identities', async (t) => {
  for (const permissions of [undefined, { pass: false, prompt: false, grants: { accessibility: true, screenCapture: true } }, { pass: true, prompt: true, grants: { accessibility: true, screenCapture: true } }, { pass: true, prompt: false, grants: { automation: true } }]) {
    await t.test(JSON.stringify(permissions), async () => {
      const { adapter, calls } = makeAdapter({ inspect: async () => ({ ...goodInspection(), permissions }) });
      const launcher = createDiagnosticLauncher({ adapter, clock: fakeClock().clock });
      await launcher.start();
      assert.equal(launcher.snapshot().phase, 'released');
      assert.deepEqual(calls.filter(([kind]) => kind === 'term').map(([, role]) => role), ['child', 'parent']);
      assert.equal(calls.some(([kind]) => kind === 'dispatch'), false);
    });
  }
});

test('fresh identity or permission drift invalidates token and prevents dispatch', async () => {
  let inspections = 0;
  const { adapter, calls } = makeAdapter({ inspect: async () => {
    inspections += 1;
    const value = goodInspection();
    if (inspections > 1) value.identity.child.start = 'different-start';
    return value;
  } });
  const launcher = createDiagnosticLauncher({ adapter, clock: fakeClock().clock });
  await launcher.start();
  await launcher.review(launcher.getReviewToken(), { approved: true, prompt: false });
  assert.equal(calls.some(([kind]) => kind === 'dispatch'), false);
  assert.equal(launcher.snapshot().phase, 'pending_cleanup');
});

test('forged token is rejected and triggers bounded cleanup', async () => {
  const { adapter, calls } = makeAdapter();
  const launcher = createDiagnosticLauncher({ adapter, clock: fakeClock().clock });
  await launcher.start();
  await launcher.review(Object.freeze({}), { approved: true, prompt: false });
  assert.equal(calls.some(([kind]) => kind === 'dispatch'), false);
  assert.equal(launcher.snapshot().phase, 'released');
});

test('expired token is consumed and cannot dispatch', async () => {
  const fake = fakeClock();
  const { adapter, calls } = makeAdapter();
  const launcher = createDiagnosticLauncher({ adapter, clock: fake.clock, tokenTtlMs: 10 });
  await launcher.start();
  const token = launcher.getReviewToken();
  await fake.value.advance(10);
  await flush();
  await launcher.review(token, { approved: true, prompt: false });
  assert.equal(calls.some(([kind]) => kind === 'dispatch'), false);
  assert.equal(launcher.snapshot().phase, 'released');
});

test('start deadline aborts; a late child is cleaned up and can never dispatch', async () => {
  const { value, clock } = fakeClock();
  const gate = Promise.withResolvers();
  const { adapter, calls, candidate } = makeAdapter({ startCandidate: () => gate.promise });
  const launcher = createDiagnosticLauncher({ adapter, clock });
  const starting = launcher.start({ timeoutMs: 30 });
  await flush();
  await value.advance(30);
  const timedOut = await starting;
  assert.equal(timedOut.phase, 'pending_cleanup');
  gate.resolve(candidate);
  for (let i = 0; i < 30 && launcher.snapshot().phase !== 'released'; i += 1) await flush();
  assert.equal(calls.some(([kind]) => kind === 'dispatch'), false);
  assert.deepEqual(calls.filter(([kind]) => kind === 'term').map(([, role]) => role), ['child', 'parent']);
  assert.equal(launcher.snapshot().phase, 'released');
});

test('unknown identity or unconfirmed child exit reports pending and never signals the parent', async () => {
  const { adapter, calls } = makeAdapter({
    inspect: async () => ({ identity: null, permissions: goodInspection().permissions }),
  });
  const launcher = createDiagnosticLauncher({ adapter, clock: fakeClock().clock });
  const state = await launcher.start();
  assert.equal(state.phase, 'pending_cleanup');
  assert.equal(calls.some(([kind]) => kind === 'term'), false);
  assert.equal(state.cleanupState, 'identity_unknown');
});

test('child exit must be confirmed before parent TERM; child failure stays pending', async () => {
  const { adapter, calls } = makeAdapter({ waitForExit: async (_candidate, role) => role !== 'child' });
  const launcher = createDiagnosticLauncher({ adapter, clock: fakeClock().clock });
  await launcher.start();
  await launcher.stop('operator_stop');
  assert.deepEqual(calls.filter(([kind]) => kind === 'term').map(([, role]) => role), ['child']);
  assert.equal(launcher.snapshot().phase, 'pending_cleanup');
});

test('stop aborts and waits for an in-flight dispatcher; timeout stays pending after late completion', async () => {
  const fake = fakeClock();
  const gate = Promise.withResolvers();
  let dispatchSignal;
  const { adapter, calls } = makeAdapter({ dispatchRunner: ({ signal }) => { dispatchSignal = signal; return gate.promise; } });
  const launcher = createDiagnosticLauncher({ adapter, clock: fake.clock });
  await launcher.start();
  const reviewing = launcher.review(launcher.getReviewToken(), { approved: true, prompt: false });
  await flush();
  const stopping = launcher.stop('operator_stop');
  assert.equal(dispatchSignal.aborted, true);
  await fake.value.advance(5_000);
  await stopping;
  assert.equal(launcher.snapshot().phase, 'pending_cleanup');
  gate.resolve();
  await reviewing;
  assert.equal(launcher.snapshot().phase, 'pending_cleanup');
  assert.equal(calls.filter(([kind]) => kind === 'dispatch').length, 0);
});

test('dispatcher settling within cleanup deadline permits exact child then parent cleanup', async () => {
  const fake = fakeClock();
  const gate = Promise.withResolvers();
  let dispatchSignal;
  const { adapter, calls } = makeAdapter({ dispatchRunner: ({ signal }) => { dispatchSignal = signal; return gate.promise; } });
  const launcher = createDiagnosticLauncher({ adapter, clock: fake.clock });
  await launcher.start();
  const reviewing = launcher.review(launcher.getReviewToken(), { approved: true, prompt: false });
  await flush();
  const stopping = launcher.stop('operator_stop');
  assert.equal(dispatchSignal.aborted, true);
  gate.resolve();
  await reviewing;
  const final = await stopping;
  assert.equal(final.phase, 'released');
  assert.deepEqual(calls.filter(([kind]) => kind === 'term').map(([, role]) => role), ['child', 'parent']);
  assert.equal(calls.filter(([kind]) => kind === 'exit').length, 2);
});
