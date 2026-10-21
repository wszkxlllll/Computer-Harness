const START_LIMIT_MS = 30_000;
const CLEANUP_LIMIT_MS = 5_000;
const TOKEN_TTL_MS = 60_000;

const realClock = Object.freeze({
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer),
});

export function createDiagnosticLauncher({ adapter, clock = realClock, tokenTtlMs = TOKEN_TTL_MS }) {
  if (!adapter || typeof adapter.startCandidate !== 'function' || typeof adapter.inspect !== 'function'
    || typeof adapter.terminateExact !== 'function' || typeof adapter.waitForExit !== 'function'
    || typeof adapter.dispatchRunner !== 'function') throw new TypeError('lifecycle_adapter_incomplete');
  if (!clock || typeof clock.now !== 'function' || typeof clock.setTimeout !== 'function' || typeof clock.clearTimeout !== 'function') {
    throw new TypeError('clock_incomplete');
  }
  if (!Number.isSafeInteger(tokenTtlMs) || tokenTtlMs < 1 || tokenTtlMs > 300_000) throw new TypeError('invalid_token_ttl');

  const tokens = new WeakMap();
  let phase = 'idle';
  let candidate;
  let baseline;
  let permissions;
  let token;
  let tokenExpiresAt;
  let tokenTimer;
  let started = false;
  let dispatchPromise;
  let dispatchAbort;
  let dispatchSettled = true;
  let cleanupPromise;
  let startAbort;
  let generation = 0;
  let result = 'not_started';
  let cleanupState = 'not_started';

  function snapshot() {
    return Object.freeze({ phase, result, cleanupState, tokenExpiresAt, dispatchCount: started ? 1 : 0 });
  }

  async function start({ timeoutMs = START_LIMIT_MS } = {}) {
    if (phase !== 'idle') return snapshot();
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > START_LIMIT_MS) throw new TypeError('invalid_start_deadline');
    phase = 'starting';
    result = 'starting';
    const myGeneration = ++generation;
    startAbort = new AbortController();
    const deadlineAt = clock.now() + timeoutMs;
    let deadlineTimer;
    const deadlinePromise = new Promise((resolveDeadline) => {
      deadlineTimer = clock.setTimeout(() => {
        startAbort.abort();
        resolveDeadline('deadline');
      }, timeoutMs);
    });
    const operation = (async () => {
      const startedCandidate = await adapter.startCandidate({ signal: startAbort.signal, deadlineAt });
      candidate = startedCandidate;
      if (phase !== 'starting' || generation !== myGeneration || startAbort.signal.aborted || clock.now() >= deadlineAt) {
        await cleanupCandidate(startedCandidate);
        return;
      }
      const inspection = await adapter.inspect(startedCandidate, { signal: startAbort.signal });
      if (phase !== 'starting' || generation !== myGeneration || startAbort.signal.aborted || clock.now() >= deadlineAt) {
        await cleanupCandidate(startedCandidate);
        return;
      }
      baseline = normalizeIdentity(inspection?.identity);
      permissions = normalizePermissions(inspection?.permissions);
      if (baseline === undefined || permissions === undefined) {
        result = 'identity_or_permission_unknown';
        await stop('identity_or_permission_unknown');
        return;
      }
      phase = 'awaiting_review';
      result = 'awaiting_review';
      token = Object.freeze(Object.create(null));
      tokenExpiresAt = clock.now() + tokenTtlMs;
      tokens.set(token, { identity: fingerprint(baseline), permissions: fingerprint(permissions), expiresAt: tokenExpiresAt, used: false, generation: myGeneration });
      const issuedToken = token;
      tokenTimer = clock.setTimeout(() => {
        if (token === issuedToken && (phase === 'awaiting_review' || phase === 'rechecking')) void stop('review_token_expired');
      }, tokenTtlMs);
    })();
    operation.catch(() => {});
    const outcome = await Promise.race([operation.then(() => 'completed', () => 'failed'), deadlinePromise]);
    clock.clearTimeout(deadlineTimer);
    if (outcome === 'deadline' && phase === 'starting') {
      result = 'start_deadline';
      phase = 'stopping';
      generation += 1;
      startAbort.abort();
      if (candidate !== undefined) void cleanupCandidate(candidate);
      else {
        phase = 'pending_cleanup';
        cleanupState = 'start_unresolved';
      }
      return snapshot();
    }
    if (phase === 'starting') {
      result = 'start_failed';
      await stop('start_failed');
    }
    return snapshot();
  }

  async function review(reviewToken, decision) {
    if (phase !== 'awaiting_review' || started || dispatchPromise !== undefined) return snapshot();
    const record = (reviewToken !== null && typeof reviewToken === 'object') ? tokens.get(reviewToken) : undefined;
    if (record === undefined || reviewToken !== token || record.used || record.generation !== generation) {
      await stop('invalid_review_token');
      return snapshot();
    }
    record.used = true;
    tokens.delete(reviewToken);
    if (clock.now() >= record.expiresAt) {
      await stop('review_token_expired');
      return snapshot();
    }
    if (decision?.approved !== true || decision?.prompt !== false) {
      await stop('review_not_approved');
      return snapshot();
    }
    const myGeneration = generation;
    dispatchAbort = new AbortController();
    phase = 'rechecking';
    result = 'rechecking_identity_and_permissions';
    dispatchSettled = false;
    // Reserve before the first await: duplicate review/dispatch calls cannot race.
    dispatchPromise = (async () => {
      const freshValue = await adapter.inspect(candidate, { signal: dispatchAbort.signal });
      const freshIdentity = normalizeIdentity(freshValue?.identity);
      const freshPermissions = normalizePermissions(freshValue?.permissions);
      if (phase !== 'rechecking' || generation !== myGeneration || clock.now() >= record.expiresAt
        || freshIdentity === undefined || freshPermissions === undefined
        || fingerprint(freshIdentity) !== record.identity || fingerprint(freshPermissions) !== record.permissions) {
        return { stopReason: 'fresh_identity_or_permission_mismatch' };
      }
      if (started) return { stopReason: 'duplicate_dispatch' };
      token = undefined;
      started = true;
      if (tokenTimer !== undefined) clock.clearTimeout(tokenTimer);
      tokenTimer = undefined;
      phase = 'dispatching';
      result = 'runner_dispatch_started';
      await adapter.dispatchRunner({ candidate, identity: freshIdentity, permissions: freshPermissions, signal: dispatchAbort.signal });
      if (phase === 'dispatching' && generation === myGeneration) {
        phase = 'dispatched';
        result = 'runner_dispatched';
      }
      return {};
    })().finally(() => { dispatchSettled = true; });
    try {
      const dispatchResult = await dispatchPromise;
      if (dispatchResult?.stopReason && phase !== 'stopping' && phase !== 'pending_cleanup') await stop(dispatchResult.stopReason);
    } catch { if (phase !== 'stopping' && phase !== 'pending_cleanup') await stop('dispatch_failed'); }
    return snapshot();
  }

  async function stop(reason = 'stopped') {
    if (phase === 'released') return snapshot();
    if (phase === 'stopping' || phase === 'pending_cleanup') {
      if (cleanupPromise !== undefined) await cleanupPromise;
      return snapshot();
    }
    phase = 'stopping';
    result = safeCode(reason);
    generation += 1;
    if (token !== undefined) tokens.delete(token);
    token = undefined;
    if (tokenTimer !== undefined) clock.clearTimeout(tokenTimer);
    tokenTimer = undefined;
    try { startAbort?.abort(); } catch { /* stopping stays fail closed */ }
    try { dispatchAbort?.abort(); } catch { /* stop remains latched */ }
    if (candidate === undefined) {
      phase = 'pending_cleanup';
      cleanupState = 'identity_unknown';
      return snapshot();
    }
    await cleanupCandidate(candidate);
    return snapshot();
  }

  function cleanupCandidate(targetCandidate) {
    if (cleanupPromise !== undefined) return cleanupPromise;
    cleanupState = 'running';
    const deadlineAt = clock.now() + CLEANUP_LIMIT_MS;
    cleanupPromise = (async () => {
      try {
        if (started && !dispatchSettled && dispatchPromise !== undefined) {
          await waitSettledUntil(dispatchPromise, deadlineAt, clock);
        }
        let inspection = await awaitUntil(adapter.inspect(targetCandidate, {}), deadlineAt, clock);
        let currentIdentity = normalizeIdentity(inspection?.identity);
        if (currentIdentity === undefined) throw new Error('identity_unknown');
        if (baseline !== undefined && fingerprint(currentIdentity) !== fingerprint(baseline)) throw new Error('identity_changed');
        if (baseline === undefined) baseline = currentIdentity;
        for (const role of ['child', 'parent']) {
          if (clock.now() >= deadlineAt) throw new Error('cleanup_deadline');
          // The adapter contract requires this operation to recheck the exact
          // PID/start/executable identity synchronously before sending TERM.
          const terminated = adapter.terminateExact(targetCandidate, role, baseline, { signal: 'TERM', deadlineAt });
          if (terminated !== true || (terminated && typeof terminated.then === 'function')) throw new Error('identity_unknown');
          if (clock.now() >= deadlineAt) throw new Error('cleanup_deadline');
          const exited = await awaitUntil(adapter.waitForExit(targetCandidate, role, baseline, { deadlineAt }), deadlineAt, clock);
          if (exited !== true) throw new Error('exit_unconfirmed');
        }
        cleanupState = 'exit_confirmed';
        phase = 'released';
        result = 'stopped_and_released';
      } catch (error) {
        cleanupState = error?.message === 'identity_unknown' || error?.message === 'identity_changed' ? 'identity_unknown' : 'exit_unconfirmed';
        phase = 'pending_cleanup';
        result = 'cleanup_pending';
      }
    })();
    return cleanupPromise;
  }

  return Object.freeze({ start, review, stop, snapshot, getReviewToken: () => phase === 'awaiting_review' ? token : undefined });
}

function normalizeIdentity(value) {
  if (!isRecord(value)) return undefined;
  const c = value.child;
  const p = value.parent;
  const s = value.socket;
  if (!validProcess(c) || !validProcess(p) || c.pid === p.pid || c.parentPid !== p.pid || !isRecord(s)
    || typeof s.path !== 'string' || !s.path.startsWith('/private/tmp/') || s.path.includes('/../')
    || !validPositive(s.dev) || !validPositive(s.ino) || !validPositive(s.uid)
    || !Number.isInteger(s.mode) || s.mode < 0 || s.mode > 0o777 || (s.mode & 0o077) !== 0) return undefined;
  return freezeJson({
    child: { pid: c.pid, parentPid: c.parentPid, start: c.start, executable: { path: c.executable.path, sha256: c.executable.sha256.toLowerCase() } },
    parent: { pid: p.pid, start: p.start, executable: { path: p.executable.path, sha256: p.executable.sha256.toLowerCase() } },
    socket: { path: s.path, dev: s.dev, ino: s.ino, uid: s.uid, mode: s.mode },
  });
}

function normalizePermissions(permission) {
  if (!isRecord(permission)) return undefined;
  if (permission.pass !== true || permission.prompt !== false || !isRecord(permission.grants)
    || Object.keys(permission.grants).length === 0
    || permission.grants.accessibility !== true || permission.grants.screenCapture !== true
    || Object.keys(permission.grants).some((key) => !['accessibility', 'screenCapture', 'inputMonitoring', 'automation'].includes(key))
    || Object.values(permission.grants).some((grant) => grant !== true)) return undefined;
  return freezeJson({ pass: true, prompt: false, grants: permission.grants });
}

function validProcess(value) {
  return isRecord(value) && validPositive(value.pid) && safeIdentityToken(value.start)
    && isRecord(value.executable) && typeof value.executable.path === 'string'
    && value.executable.path.startsWith('/') && !value.executable.path.includes('/../')
    && /^[a-f0-9]{64}$/u.test(value.executable.sha256);
}
function validPositive(value) { return Number.isSafeInteger(value) && value > 0; }
function safeIdentityToken(value) { return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,96}$/u.test(value); }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function fingerprint(value) { return JSON.stringify(value); }
function freezeJson(value) { return Object.freeze(JSON.parse(JSON.stringify(value))); }
function safeCode(value) { return /^[a-z_]{1,48}$/u.test(value) ? value : 'stopped'; }

async function raceDeadline(promise, deadlineAt, clock) {
  const remaining = Math.max(0, deadlineAt - clock.now());
  let timer;
  try {
    return await Promise.race([
      promise.then(() => 'completed', () => 'failed'),
      new Promise((resolve) => { timer = clock.setTimeout(() => resolve('deadline'), remaining); }),
    ]);
  } finally { if (timer !== undefined) clock.clearTimeout(timer); }
}

async function awaitUntil(promise, deadlineAt, clock) {
  const outcome = await raceDeadline(Promise.resolve(promise), deadlineAt, clock);
  if (outcome !== 'completed' || clock.now() > deadlineAt) throw new Error(outcome === 'deadline' ? 'cleanup_deadline' : 'identity_unknown');
  // Propagate a synchronous async-operation failure only as a fixed category.
  return await promise;
}

async function waitSettledUntil(promise, deadlineAt, clock) {
  const outcome = await raceDeadline(Promise.resolve(promise).then(() => undefined, () => undefined), deadlineAt, clock);
  if (!['completed', 'failed'].includes(outcome) || clock.now() > deadlineAt) throw new Error('cleanup_deadline');
}
