// F018: injected one-child stdio controller. Importing this module has no I/O.
const SCHEMA = 'harness.diagnostic_preflight.v1';
const MAX = 65536;
const LOCAL_TIMEOUT = Symbol('deadline');
const fail = (code) => { throw Object.assign(new Error(code), { safeCode: code }); };
const SAFE_CODES = new Set(['reply_invalid', 'receipt_invalid', 'receipt_unknown', 'initialize_invalid', 'permission_invalid', 'write_repeated', 'write_unknown', 'transport_invalid', 'stderr_present', 'empty_flood', 'stdout_limit', 'unexpected_frame', 'frame_invalid', 'exit_invalid', 'transport_error', 'early_exit', 'mode_invalid', 'opportunity_consumed', 'artifact_unknown', 'spawn_unknown', 'preflight_invalid', 'artifact_drift']);
function safeError(error) { try { return SAFE_CODES.has(error?.safeCode) ? error.safeCode : 'operation_unknown'; } catch { return 'operation_unknown'; } }
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const positive = (v, max = 0x7fffffff) => Number.isSafeInteger(v) && v > 0 && v <= max;
const digest = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const record = (v, source) => object(v) && Object.keys(v).length === 2 && v.source === source && digest(v.sha256);
const sameRecord = (a, b) => a.source === b.source && a.sha256 === b.sha256;
export const FIXED_ENV = Object.freeze({ CUA_DRIVER_RS_TELEMETRY_ENABLED: '0', CUA_DRIVER_RS_UPDATE_CHECK: '0' });
export const INITIALIZE = Object.freeze({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'harness-f018-diagnostic', version: '1' } } });

// Exact F013 serialization/order/exit map. No heuristic success promotion.
export function preflightTemplates() {
  const values = [];
  const add = (outcome, selfIdentityValidated, accessibility, screenCapture, exitCode) => values.push({
    text: JSON.stringify({ schema: SCHEMA, outcome, selfIdentityValidated, accessibility, screenCapture, principalVerified: false, readyForDispatch: false }) + '\n', exitCode,
  });
  for (const outcome of ['invalid_arguments', 'identity_unknown', 'identity_rejected', 'report_unknown']) add(outcome, false, null, null, outcome === 'invalid_arguments' ? 64 : 2);
  for (const ax of [true, false, null]) for (const sr of [true, false, null]) {
    const outcome = ax === null || sr === null ? 'permission_status_unknown' : ax && sr ? 'observed_unverified' : 'permissions_not_granted';
    add(outcome, true, ax, sr, outcome === 'observed_unverified' ? 0 : 2);
  }
  return values;
}

// Mechanical F005 projectDiagnostic adaptation; algorithm/limits unchanged.
const MAX_STRUCTURED_JSON_BYTES = 4096;
const MAX_PID = 0x7fffffff;
const MAX_U32 = 0xffffffff;
const DIAGNOSTIC_SCHEMA = 'cua.frontmost_window_diagnostic.v1';
const SOURCE = 'observe_exact_window_existing_visible_windows_snapshot';
const STATES = new Set(['present', 'missing', 'invalid']);
const RELATIONS = new Set(['same', 'different', 'unknown']);
function isSafeInt(value, min, max) { return Number.isSafeInteger(value) && value >= min && value <= max; }
export function projectDiagnostic(structuredJson) {
  if (typeof structuredJson !== 'string' || structuredJson.length > MAX_STRUCTURED_JSON_BYTES || Buffer.byteLength(structuredJson, 'utf8') > MAX_STRUCTURED_JSON_BYTES) return undefined;
  let parsed;
  try { parsed = JSON.parse(structuredJson); } catch { return undefined; }
  if (!object(parsed) || !object(parsed.observed) || !object(parsed.observed.frontmost_window_diagnostic)) return undefined;
  const observed = parsed.observed, diagnostic = observed.frontmost_window_diagnostic;
  if (diagnostic.schema !== DIAGNOSTIC_SCHEMA || diagnostic.source !== SOURCE || !STATES.has(diagnostic.state) || diagnostic.state !== 'present') return undefined;
  const { frontmost_window_pid: pid, frontmost_window_id: windowId, layer, z, is_on_screen: isOnScreen } = diagnostic;
  const targetPidRelation = diagnostic.target_pid_relation, targetWindowRelation = diagnostic.target_window_id_relation;
  if (!RELATIONS.has(targetPidRelation) || !RELATIONS.has(targetWindowRelation)) return undefined;
  const targetPid = parsed.pid, targetWindowId = parsed.window_id, legacyFrontmostWindowId = observed.frontmost_ordinary_window_id;
  if (!isSafeInt(pid, 1, MAX_PID) || !isSafeInt(windowId, 1, MAX_U32) || !isSafeInt(targetPid, 1, MAX_PID) || !isSafeInt(targetWindowId, 1, MAX_U32) || !isSafeInt(legacyFrontmostWindowId, 1, MAX_U32)
    || !Number.isInteger(layer) || layer < -128 || layer > 128 || !isSafeInt(z, 1, MAX_U32) || typeof isOnScreen !== 'boolean'
    || targetPidRelation !== (pid === targetPid ? 'same' : 'different') || targetWindowRelation !== (windowId === targetWindowId ? 'same' : 'different') || legacyFrontmostWindowId !== windowId) return undefined;
  return Object.freeze({ schema: DIAGNOSTIC_SCHEMA, source: SOURCE, state: diagnostic.state, target_pid: targetPid, target_window_id: targetWindowId, frontmost_window_pid: pid, frontmost_window_id: windowId, layer, z, is_on_screen: isOnScreen, target_pid_relation: targetPidRelation, target_window_id_relation: targetWindowRelation });
}

function projectReceipt(frame, target) {
  if (!object(frame) || frame.jsonrpc !== '2.0' || frame.id !== 2 || 'error' in frame || !object(frame.result)) fail('reply_invalid');
  const r = frame.result, s = r.structuredContent;
  if (typeof r.isError !== 'boolean' && r.isError !== undefined) fail('receipt_invalid');
  const d = projectDiagnostic(JSON.stringify(s));
  if (!d || d.target_pid !== target.pid || d.target_window_id !== target.windowId || !['activated', 'partial', 'failed'].includes(s.status)
    || typeof s.activated !== 'boolean' || typeof s.request_accepted !== 'boolean' || typeof s.process_activated !== 'boolean' || !object(s.exact_window_effect)) fail('receipt_unknown');
  const e = s.exact_window_effect;
  if (!['verified', 'focused', 'frontmost_ordinary'].every((key) => typeof e[key] === 'boolean')) fail('receipt_unknown');
  const observed = s.observed;
  const ids = {};
  for (const key of ['frontmost_pid', 'workspace_frontmost_pid', 'focused_window_id', 'frontmost_ordinary_window_id']) {
    const v = observed[key];
    if (v !== null && !positive(v, key.endsWith('pid') ? MAX_PID : MAX_U32)) fail('receipt_unknown');
    ids[key] = v;
  }
  if (observed.front_process_matches_target !== null && typeof observed.front_process_matches_target !== 'boolean') fail('receipt_unknown');
  return { status: s.status, isError: r.isError === true, activated: s.activated, requestAccepted: s.request_accepted, processActivated: s.process_activated,
    exactWindowEffect: { verified: e.verified, focused: e.focused, frontmostOrdinary: e.frontmost_ordinary }, observed: { ...ids, front_process_matches_target: observed.front_process_matches_target }, diagnostic: d };
}
function validateInitialize(frame) {
  if (!object(frame) || frame.jsonrpc !== '2.0' || frame.id !== 1 || 'error' in frame || !object(frame.result)) fail('initialize_invalid');
  const r = frame.result;
  if (r.protocolVersion !== '2025-06-18' || !object(r.capabilities) || !object(r.capabilities.tools) || Object.keys(r.capabilities).length !== 1 || Object.keys(r.capabilities.tools).length !== 0
    || !object(r.serverInfo) || r.serverInfo.name !== 'cua-driver' || r.serverInfo.version !== '0.22.2' || typeof r.instructions !== 'string') fail('initialize_invalid');
}

/** Ops: now,setTimer,clearTimer,verifyArtifact,spawn,retain; no defaults touch OS.
 * child: read()->event, write(bytes)->Promise<boolean>, end(), snapshot(), signal().
 * permit: read() fixed snapshot and consume('attempt'|'bring') boolean latches.
 * Cancel rejects the exact Run reason after cleanup; pending child is retained.
 */
export async function runDiagnostic({ mode, signal, permit }, ops) {
  signal.throwIfAborted();
  const started = ops.now(), deadline = started + 30000;
  let child, artifact, permission, projection, cause = 'none', stdoutBytes = 0, stderrBytes = 0, exit = null, closed = false, ended = false, term = false, kill = false;
  let sent = new Set(), writeInvoked = new Set(), consumeBring = false, pending = false;
  let readPending;
  const guard = (until = deadline, allowCancelled = false) => {
    if (!allowCancelled) signal.throwIfAborted();
    if (ops.now() >= until) throw LOCAL_TIMEOUT;
    if (!allowCancelled) signal.throwIfAborted();
  };
  const bounded = async (work, until, allowCancelled = false) => {
    guard(until, allowCancelled);
    let timer, listener;
    const interrupt = new Promise((_, reject) => {
      timer = ops.setTimer(() => reject(LOCAL_TIMEOUT), Math.max(0, until - ops.now()));
      if (!allowCancelled) { listener = () => reject(signal.reason); signal.addEventListener('abort', listener, { once: true }); if (signal.aborted) listener(); }
    });
    void interrupt.catch(() => {});
    try {
      const promise = Promise.resolve().then(() => { guard(until, allowCancelled); return work(); });
      void promise.catch(() => {});
      const result = await Promise.race([promise, interrupt]);
      guard(until, allowCancelled);
      return result;
    } finally {
      if (timer !== undefined) ops.clearTimer(timer);
      if (listener) signal.removeEventListener('abort', listener);
      if (!allowCancelled) signal.throwIfAborted();
    }
  };
  const checkPermit = (bring) => {
    const p = permit.read();
    guard();
    if (!object(p) || p.reviewed !== true || !digest(p.artifactDigest) || p.artifactDigest !== artifact.digest || typeof p.epoch !== 'string' || !p.epoch || p.epoch !== permission?.epoch
      || !Number.isFinite(p.expiresAt) || Math.min(p.expiresAt, permission.expiresAt) <= ops.now() || p.mode !== mode) fail('permission_invalid');
    if (p.emergency?.kill === true && p.emergency?.term !== true) fail('permission_invalid');
    if (bring && (!record(p.preflightSource, 'f018-new-artifact-preflight') || !record(p.reviewSource, 'independent-review')
      || !record(permission.preflightSource, 'f018-new-artifact-preflight') || !record(permission.reviewSource, 'independent-review')
      || !sameRecord(p.preflightSource, permission.preflightSource) || !sameRecord(p.reviewSource, permission.reviewSource)
      || !object(p.preflight) || !object(permission.preflight) || p.preflight.artifactDigest !== artifact.digest || p.preflight.selfIdentityValidated !== true || p.preflight.accessibility !== true || p.preflight.screenCapture !== true
      || p.preflight.outcome !== 'observed_unverified' || !['artifactDigest', 'outcome', 'selfIdentityValidated', 'accessibility', 'screenCapture'].every((k) => p.preflight[k] === permission.preflight[k])
      || !positive(p.pid) || !positive(p.windowId, MAX_U32) || p.pid !== permission.pid || p.windowId !== permission.windowId)) fail('permission_invalid');
    return p;
  };
  const writeOnce = async (label, value) => {
    guard();
    if (sent.has(label)) fail('write_repeated');
    sent.add(label); // Before callback/reentry/partial side effect.
    const ok = await bounded(() => {
      if (label === 'bring') checkPermit(true);
      guard();
      writeInvoked.add(label);
      return child.write(Buffer.from(JSON.stringify(value) + '\n'));
    }, deadline);
    if (ok !== true) fail('write_unknown');
  };
  const totalLimit = mode === 'preflight' ? 1024 : MAX;
  let buffer = Buffer.alloc(totalLimit), used = 0, frames = [], empties = 0;
  const accept = (event, cleanup = false) => {
    if (!object(event)) fail('transport_invalid');
    if (event.type === 'stderr') {
      if (!Buffer.isBuffer(event.data)) fail('transport_invalid');
      stderrBytes = Math.min(MAX + 1, stderrBytes + event.data.length);
      if (event.data.length) fail('stderr_present');
    } else if (event.type === 'stdout') {
      if (!Buffer.isBuffer(event.data)) fail('transport_invalid');
      if (!event.data.length) { if (++empties > 64) fail('empty_flood'); return; }
      empties = 0;
      if (event.data.length > totalLimit - stdoutBytes) fail('stdout_limit');
      stdoutBytes += event.data.length;
      if (cleanup && mode === 'bring') fail('unexpected_frame');
      for (let offset = 0; offset < event.data.length; offset += 4096) {
        const part = event.data.subarray(offset, Math.min(offset + 4096, event.data.length));
        part.copy(buffer, used); used += part.length;
        if (mode === 'bring') {
          let lf;
          while ((lf = buffer.subarray(0, used).indexOf(10)) >= 0) {
            let text, parsed;
            try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, lf)); parsed = JSON.parse(text); } catch { fail('frame_invalid'); }
            frames.push(parsed);
            buffer.copyWithin(0, lf + 1, used); used -= lf + 1;
            if (frames.length > 1) fail('unexpected_frame');
          }
        }
      }
    } else if (event.type === 'exit') {
      if (exit !== null) fail('exit_invalid');
      if ((!Number.isInteger(event.code) && event.code !== null) || (typeof event.signal !== 'string' && event.signal !== null)) fail('exit_invalid');
      exit = { code: event.code, signal: event.signal };
    } else if (event.type === 'close') closed = true;
    else if (event.type === 'error') fail('transport_error');
    else if (event.type !== 'eof') fail('transport_invalid');
  };
  const next = async (until = deadline, cleanup = false) => {
    const event = await bounded(() => {
      // A timed-out read still owns its original promise. Cleanup observes that
      // same read; it must not start an overlapping transport read or lose data.
      if (!readPending) {
        readPending = Promise.resolve(child.read()).finally(() => { readPending = undefined; });
        void readPending.catch(() => {});
      }
      return readPending;
    }, until, cleanup);
    guard(until, cleanup);
    try { accept(event, cleanup); } catch (error) {
      if (!cleanup) throw error;
      if (cause === 'none') { cause = safeError(error); projection = undefined; }
      // Keep observing exit/close after a protocol failure; raw data is neither
      // returned nor retained as evidence and never restores success.
    }
    guard(until, cleanup);
  };
  const readFrame = async () => {
    while (!frames.length) { if (exit || closed) fail('early_exit'); await next(); }
    const frame = frames.shift(); guard(); return frame;
  };
  const snapshot = () => {
    const s = child.snapshot();
    if (!object(s) || s.ownership !== 'owned') return null;
    if (s.closed) closed = true;
    return s;
  };
  const signalOnce = (kind) => {
    const s = snapshot();
    if (!s || closed || exit || s.exitCode !== null || s.signalCode !== null) return;
    if (kind === 'SIGTERM' ? term : kill) return;
    if (kind === 'SIGTERM') term = true; else kill = true;
    child.signal(kind); // Node owned handle, NOT audit-token/generation atomic.
  };
  try {
    if (!['preflight', 'bring'].includes(mode)) fail('mode_invalid');
    if (permit.consume('attempt') !== true) fail('opportunity_consumed');
    artifact = await bounded(() => ops.verifyArtifact(), deadline);
    if (!object(artifact) || !digest(artifact.digest) || artifact.verified !== true) fail('artifact_unknown');
    permission = structuredClone(permit.read()); guard();
    checkPermit(mode === 'bring');
    // spawn is deliberately synchronous: ownership cannot be lost to a late promise.
    child = ops.spawn({ argv: mode === 'preflight' ? ['diagnostic-preflight-only'] : ['mcp', '--direct'], env: FIXED_ENV,
      beforeSpawn() { checkPermit(mode === 'bring'); guard(); } });
    if (!object(child) || typeof child.read !== 'function' || typeof child.snapshot !== 'function') fail('spawn_unknown');
    guard();
    if (mode === 'preflight') {
      while (!closed) { await next(); }
      if (!exit || exit.signal !== null) fail('exit_invalid');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, used));
      const match = preflightTemplates().find((v) => v.text === text && v.exitCode === exit.code);
      if (!match) fail('preflight_invalid');
      const r = JSON.parse(text);
      projection = { outcome: r.outcome, selfIdentityValidated: r.selfIdentityValidated, accessibility: r.accessibility, screenCapture: r.screenCapture };
    } else {
      await writeOnce('initialize', INITIALIZE);
      validateInitialize(await readFrame()); guard();
      await writeOnce('initialized', { jsonrpc: '2.0', method: 'notifications/initialized' });
      // Recheck source pins and the exact permit/epoch/target immediately before
      // consuming and writing the single action. No await follows this final gate.
      const current = await bounded(() => ops.verifyArtifact(), deadline);
      if (current.verified !== true || current.digest !== artifact.digest) fail('artifact_drift');
      checkPermit(true); guard();
      if (consumeBring || permit.consume('bring') !== true) fail('opportunity_consumed');
      consumeBring = true;
      checkPermit(true); guard();
      await writeOnce('bring', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bring_to_front', arguments: { pid: permission.pid, window_id: permission.windowId } } });
      projection = projectReceipt(await readFrame(), permission);
      if (used || frames.length) fail('unexpected_frame');
      guard();
    }
  } catch (error) {
    cause = signal.aborted ? 'cancelled' : error === LOCAL_TIMEOUT ? 'deadline' : safeError(error);
    projection = undefined;
  } finally {
    buffer.fill(0); frames = [];
    if (child) {
      try { if (!ended) { ended = true; child.end(); } } catch { if (cause === 'none') cause = 'shutdown_unknown'; }
      let until = ops.now() + 5000;
      try {
        while (!(exit && closed)) { if (!snapshot()) break; await next(until, true); }
      } catch (error) {
        if (error !== LOCAL_TIMEOUT && cause === 'none') { cause = safeError(error); projection = undefined; }
        /* EOF/timeout/error never substitutes for observed exit+close. */
      }
      if (!(exit && closed) && permission?.emergency?.term === true) {
        try { signalOnce('SIGTERM'); } catch { /* Unknown signal result, no retry. */ }
        until = ops.now() + 5000;
        try { while (!(exit && closed)) { if (!snapshot()) break; await next(until, true); } } catch {}
      }
      if (!(exit && closed) && term && permission?.emergency?.kill === true) {
        try { signalOnce('SIGKILL'); } catch {}
        until = ops.now() + 5000;
        try { while (!(exit && closed)) { if (!snapshot()) break; await next(until, true); } } catch {}
      }
      pending = !(exit && closed);
      if (pending) ops.retain(child);
    }
  }
  signal.throwIfAborted();
  if (cause === 'none' && ops.now() >= deadline) { cause = 'deadline'; projection = undefined; }
  if (cause === 'none' && mode === 'bring' && (!exit || exit.code !== 0 || exit.signal !== null)) { cause = 'exit_invalid'; projection = undefined; }
  if (pending && cause === 'none') cause = 'cleanup_pending';
  signal.throwIfAborted();
  return Object.freeze({ mode, cause, observation: cause === 'none' ? projection : null, cleanup: pending ? 'pending' : child ? 'exit_and_close_observed' : 'not_spawned', spawned: !!child, bringSent: writeInvoked.has('bring'), termSent: term, killSent: kill,
    stdoutBytes, stderrBytes, principalVerified: false, readyForDispatch: false, permissionOwnership: 'unverified' });
}
