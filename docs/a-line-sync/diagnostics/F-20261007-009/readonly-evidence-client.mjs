import * as nativeFs from 'node:fs/promises';
import { createConnection } from 'node:net';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';

const MAX_REPLY_BYTES = 65_536;
const systemClock = Object.freeze({ now: () => performance.now(), setTimeout, clearTimeout });
const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const positive = (v) => Number.isSafeInteger(v) && v > 0;
const fail = (code) => { throw new Error(code); };
// Paths are checked separately because the leading slash creates an empty part.
function canonicalShape(path) {
  return typeof path === 'string' && path.startsWith('/') && !path.includes('\0')
    && !path.slice(1).split('/').some((part) => part === '' || part === '.' || part === '..');
}

export function validateEvidence({ metadata, permission, expected }) {
  const result = {
    schema: 'harness.readonly_evidence.v1', outcome: 'permission_ownership_unverified',
    permissionOwnership: 'unverified', readyForDispatch: false,
    identitySelfReportsMatch: false, accessibility: null, screenCapture: null,
  };
  const denied = (outcome) => Object.freeze({ ...result, outcome });
  if (!record(expected) || !positive(expected.pid) || !positive(expected.parentPid)
    || Object.keys(expected).some((key) => !['pid', 'parentPid', 'executable'].includes(key))
    || expected.pid === expected.parentPid || !canonicalShape(expected.executable)) return denied('expected_identity_invalid');
  const metadataIssue = validateMetadata(metadata, expected);
  if (metadataIssue) return denied(metadataIssue);
  if (!record(permission) || permission.ok !== true || !record(permission.result)
    || Object.hasOwn(permission, 'error') || Object.hasOwn(permission, 'exit_code')
    || ![undefined, false].includes(permission.result.isError) || !record(permission.result.structuredContent)) return denied('permission_reply_invalid');
  const p = permission.result.structuredContent;
  if (p.screen_recording_capturable !== null || p.direct_capture_status !== 'not_checked'
    || p.direct_capture_error !== null) return denied('direct_probe_not_excluded');
  if (typeof p.accessibility !== 'boolean' || typeof p.screen_recording !== 'boolean'
    || !record(p.source)) return denied('permission_reply_invalid');
  if (p.source.pid !== expected.pid || p.source.responsible_ppid !== expected.parentPid
    || p.source.executable !== expected.executable) return denied('permission_identity_mismatch');
  result.identitySelfReportsMatch = true;
  result.accessibility = p.accessibility;
  result.screenCapture = p.screen_recording;
  if (p.source.attribution === 'caller') return denied('caller_attribution');
  if (p.source.attribution !== 'driver-daemon') return denied('permission_attribution_unknown');
  if (!p.accessibility || !p.screen_recording) return denied('permission_not_granted');
  // Neither a daemon's own JSON nor its bundle-path heuristic proves peer or TCC ownership.
  return Object.freeze(result);
}

export function createReadonlyEvidenceClient({ fs = nativeFs, connect = createConnection,
  clock = systemClock, uid = process.getuid?.() } = {}) {
  if (!positive(uid) || !fs || !['lstat', 'realpath'].every((name) => typeof fs[name] === 'function')
    || typeof connect !== 'function' || !clock || !['now', 'setTimeout', 'clearTimeout'].every((name) => typeof clock[name] === 'function')) {
    throw new TypeError('dependencies_invalid');
  }
  return Object.freeze({
    async inspect(options = {}) {
      if (!record(options) || Object.keys(options).some((key) => !['socketPath', 'expected', 'timeoutMs', 'signal'].includes(key))) {
        return summary('request_options_invalid');
      }
      const { socketPath, expected, timeoutMs = 30_000, signal } = options;
      if (!canonicalShape(socketPath) || !socketPath.startsWith('/private/tmp/')
        || dirname(socketPath) === '/private/tmp' || Buffer.byteLength(socketPath) > 100) return summary('endpoint_invalid');
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) return summary('deadline_invalid');
      // Validate supplied identity before any filesystem or socket effect.
      if (validateEvidence({ expected }).outcome === 'expected_identity_invalid') return summary('expected_identity_invalid');
      const boundExpected = Object.freeze({ pid: expected.pid, parentPid: expected.parentPid, executable: expected.executable });
      if (signal !== undefined && (typeof signal.addEventListener !== 'function'
        || typeof signal.removeEventListener !== 'function' || typeof signal.aborted !== 'boolean')) return summary('abort_signal_invalid');
      const abort = new AbortController();
      let reason = 'aborted';
      const deadlineAt = clock.now() + timeoutMs;
      let timer;
      let rejectAbort;
      const interrupted = new Promise((_, reject) => { rejectAbort = reject; });
      const stop = (code) => {
        if (abort.signal.aborted) return;
        reason = code;
        abort.abort(code);
        rejectAbort(new Error(code));
      };
      const externalAbort = () => stop('aborted');
      const check = () => {
        if (abort.signal.aborted) fail(reason);
        if (!Number.isFinite(clock.now()) || clock.now() >= deadlineAt) { stop('deadline_exceeded'); fail(reason); }
      };
      const context = { fs, uid, check };
      signal?.addEventListener('abort', externalAbort, { once: true });
      timer = clock.setTimeout(() => stop('deadline_exceeded'), timeoutMs);
      if (signal?.aborted) stop('aborted');
      const operation = (async () => {
        check();
        const before = await socketIdentity(socketPath, context);
        const metadata = await request(socketPath, { method: 'metadata' }, { connect, signal: abort.signal, check });
        check();
        const metadataIssue = validateMetadata(metadata, boundExpected);
        if (metadataIssue) return summary(metadataIssue);
        const middle = await socketIdentity(socketPath, context);
        if (!sameIdentity(before, middle)) fail('endpoint_changed');
        // No arbitrary method, tool, args, SDK connection, or automatic retry is exposed.
        const permission = await request(socketPath,
          { method: 'call', name: 'check_permissions', args: { prompt: false, probe_direct_capture: false } },
          { connect, signal: abort.signal, check });
        check();
        const after = await socketIdentity(socketPath, context);
        if (!sameIdentity(before, after)) fail('endpoint_changed');
        return validateEvidence({ metadata, permission, expected: boundExpected });
      })();
      try { return await Promise.race([operation, interrupted]); }
      catch (error) { return summary(safeCode(error)); }
      finally {
        clock.clearTimeout(timer);
        signal?.removeEventListener('abort', externalAbort);
        // Latch cancellation so late filesystem results cannot open another connection.
        if (!abort.signal.aborted) abort.abort();
      }
    },
  });
}

function validateMetadata(metadata, expected) {
  if (!record(metadata) || metadata.ok !== true || !record(metadata.result)
    || Object.hasOwn(metadata, 'error') || Object.hasOwn(metadata, 'exit_code')
    || !positive(metadata.result.pid) || typeof metadata.result.embedded !== 'boolean'
    || !['driver_version', 'contract_version', 'tools_list_schema_version', 'capability_version', 'mcp_protocol_version']
      .every((key) => typeof metadata.result[key] === 'string' && /^[A-Za-z0-9._:+-]{1,96}$/u.test(metadata.result[key]))) return 'metadata_invalid';
  if (metadata.result.pid !== expected.pid || metadata.result.embedded !== false) return 'metadata_identity_mismatch';
  return undefined;
}

async function socketIdentity(path, { fs, uid, check }) {
  check();
  const parent = dirname(path);
  const realParent = await fs.realpath(parent); check();
  if (realParent !== parent) fail('endpoint_not_canonical');
  const p = await fs.lstat(parent); check();
  if (p.isSymbolicLink() || !p.isDirectory() || p.uid !== uid || (p.mode & 0o777) !== 0o700) fail('endpoint_parent_unsafe');
  const s = await fs.lstat(path); check();
  if (s.isSymbolicLink() || !s.isSocket() || s.uid !== uid || (s.mode & 0o777) !== 0o600
    || !positive(s.dev) || !positive(s.ino) || !positive(p.dev) || !positive(p.ino)) fail('endpoint_socket_unsafe');
  return { parent: { dev: p.dev, ino: p.ino, uid: p.uid, mode: p.mode },
    socket: { dev: s.dev, ino: s.ino, uid: s.uid, mode: s.mode } };
}
const sameIdentity = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function request(path, value, { connect, signal, check }) {
  return new Promise((resolve, reject) => {
    let socket;
    let settled = false;
    let sent = false;
    let chunks = [];
    let total = 0;
    const close = () => { try { socket?.destroy(); } catch { /* never replace fixed result with socket text */ } };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      close();
      if (error) reject(new Error(error)); else resolve(result);
    };
    const onAbort = () => finish(signal.reason === 'deadline_exceeded' ? 'deadline_exceeded' : 'aborted');
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      check();
      socket = connect({ path });
      // Keep an error listener after settlement: late errors must never escape.
      socket.on('error', () => finish('socket_error'));
      socket.on('end', () => finish('reply_incomplete'));
      socket.on('close', () => finish('reply_incomplete'));
      socket.on('connect', () => {
        if (settled || signal.aborted) { close(); return; }
        if (sent) return;
        sent = true;
        try { check(); socket.write(`${JSON.stringify(value)}\n`); }
        catch { finish('socket_error'); }
      });
      socket.on('data', (chunk) => {
        if (settled) return;
        try {
          check();
          const bytes = Buffer.from(chunk);
          total += bytes.length;
          if (total > MAX_REPLY_BYTES) return finish('reply_too_large');
          chunks.push(bytes);
          const reply = Buffer.concat(chunks, total);
          const newline = reply.indexOf(10);
          if (newline < 0) return;
          if (newline !== reply.length - 1) return finish('reply_multiple_frames');
          // Fatal UTF-8 decoding rejects corrupt wire bytes instead of accepting replacements.
          const body = new TextDecoder('utf-8', { fatal: true }).decode(reply.subarray(0, newline));
          const parsed = JSON.parse(body);
          if (!record(parsed)) return finish('reply_invalid');
          chunks = [];
          finish(undefined, parsed);
        } catch { finish('reply_invalid'); }
      });
      if (settled || signal.aborted) { close(); finish('aborted'); }
    } catch { finish('socket_error'); }
  });
}

function summary(outcome) {
  return Object.freeze({ schema: 'harness.readonly_evidence.v1', outcome,
    permissionOwnership: 'unverified', readyForDispatch: false,
    identitySelfReportsMatch: false, accessibility: null, screenCapture: null });
}
function safeCode(error) {
  const allowed = new Set(['aborted', 'deadline_exceeded', 'endpoint_not_canonical', 'endpoint_parent_unsafe',
    'endpoint_socket_unsafe', 'endpoint_changed', 'socket_error', 'reply_incomplete', 'reply_too_large',
    'reply_multiple_frames', 'reply_invalid']);
  return allowed.has(error?.message) ? error.message : 'evidence_unavailable';
}
