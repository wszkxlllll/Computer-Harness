// SOURCE ONLY for future tester execution. No child is spawned on import.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runDiagnostic } from './direct-diagnostic-core.mjs';

// Independently frozen by role (6), not generated from candidate/caller input.
// No such final signed manifest is currently supplied: real launch is refused.
export const TRUST_ROOT = '/private/tmp/Direct-Combo-20261007.p4b1rC/approved-control';
const hash = (b) => createHash('sha256').update(b).digest('hex');
const bad = () => { throw new Error('trusted_source_unknown'); };
const equal = (a, b) => ['dev', 'ino', 'mode', 'uid', 'size', 'mtimeNs', 'ctimeNs'].every((k) => a[k] === b[k]);
function plain(absolute) {
  if (typeof absolute !== 'string' || !path.isAbsolute(absolute) || path.normalize(absolute) !== absolute) bad();
  let p = path.parse(absolute).root;
  for (const component of absolute.slice(p.length).split('/')) {
    p = path.join(p, component);
    const s = fs.lstatSync(p, { bigint: true });
    if (s.isSymbolicLink()) bad();
  }
  if (fs.realpathSync(absolute) !== absolute) bad();
}
// Pure injected descriptor reader: cap+1 proves oversize without reading an
// unbounded growing file. Short reads are not EOF; only zero establishes EOF.
export function readBoundedDescriptor(fileSystem, fd, maximum) {
  const buffer = Buffer.alloc(maximum + 1);
  let used = 0;
  while (used < buffer.length) {
    const n = fileSystem.readSync(fd, buffer, used, buffer.length - used, null);
    if (!Number.isInteger(n) || n < 0 || n > buffer.length - used) bad();
    if (n === 0) return buffer.subarray(0, used);
    used += n;
  }
  bad();
}
function readPinned(file, maximum, expected) {
  plain(file);
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.size > BigInt(maximum)) bad();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!equal(before, fs.fstatSync(fd, { bigint: true }))) bad();
    const bytes = readBoundedDescriptor(fs, fd, maximum);
    if (bytes.length > maximum || !equal(before, fs.fstatSync(fd, { bigint: true })) || !equal(before, fs.lstatSync(file, { bigint: true }))) bad();
    if (expected && hash(bytes) !== expected) bad();
    return { bytes, identity: before };
  } finally { fs.closeSync(fd); }
}
function frozenJson(name) {
  const pinRead = readPinned(path.join(TRUST_ROOT, name + '.sha256'), 65), pin = pinRead.bytes;
  if (!/^[a-f0-9]{64}\n$/.test(pin.toString('utf8'))) bad();
  const value = readPinned(path.join(TRUST_ROOT, name + '.json'), 65536, pin.toString('utf8').slice(0, 64));
  if (!equal(pinRead.identity, fs.lstatSync(path.join(TRUST_ROOT, name + '.sha256'), { bigint: true }))) bad();
  return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value.bytes)), digest: hash(value.bytes), identity: value.identity,
    pinIdentity: pinRead.identity };
}
export function createTrustedSources() {
  let prior, fileIdentities, configIdentity, priorPermit, permitExpiry;
  const verifyArtifact = () => {
    try {
      const m = frozenJson('artifact');
      const a = m.value;
      if (a.schema !== 'harness.f018.artifact.v1' || a.reviewedBy !== 'coordinator-6' || a.version !== '0.22.2' || !Array.isArray(a.files) || a.files.length !== 3
        || !/^[a-f0-9]{40}$/.test(a.cdhash) || typeof a.designatedRequirement !== 'string' || !a.designatedRequirement || typeof a.bundleRoot !== 'string') bad();
      plain(a.bundleRoot);
      if (path.basename(a.bundleRoot) !== 'HarnessF005Diagnostic.app') bad();
      if (TRUST_ROOT === a.bundleRoot || TRUST_ROOT.startsWith(a.bundleRoot + '/')) bad();
      const required = ['Contents/Info.plist', 'Contents/MacOS/cua-driver-local', 'Contents/_CodeSignature/CodeResources'];
      const identities = [];
      for (let i = 0; i < required.length; i++) {
        const f = a.files[i];
        if (f.path !== required[i] || !/^[a-f0-9]{64}$/.test(f.sha256) || !Number.isSafeInteger(f.size) || f.size <= 0 || f.size > 268435456) bad();
        const r = readPinned(path.join(a.bundleRoot, f.path), f.size, f.sha256);
        if (r.bytes.length !== f.size) bad();
        identities.push(r.identity);
      }
      const inventory = [];
      const walk = (dir, prefix = '') => {
        for (const name of fs.readdirSync(dir)) {
          const rel = prefix + name, full = path.join(dir, name), s = fs.lstatSync(full);
          if (s.isSymbolicLink()) bad();
          if (s.isDirectory()) walk(full, rel + '/');
          else if (s.isFile()) inventory.push(rel); else bad();
        }
      };
      walk(a.bundleRoot);
      if (JSON.stringify(inventory.sort()) !== JSON.stringify([...required].sort())) bad();
      // Preserve the real HOME; do not manufacture an alternate permission home.
      if (typeof process.env.HOME !== 'string' || a.home !== process.env.HOME) bad();
      const config = path.join(a.home, '.cua-driver/config.json');
      let currentConfig;
      if (a.configSha256 === 'absent') {
        try { fs.lstatSync(config); bad(); } catch (error) { if (error.code !== 'ENOENT') bad(); }
      } else { if (!/^[a-f0-9]{64}$/.test(a.configSha256)) bad(); currentConfig = readPinned(config, 65536, a.configSha256).identity; }
      if (prior && (m.digest !== prior.digest || !equal(m.identity, prior.identity) || !equal(m.pinIdentity, prior.pinIdentity))) bad();
      if (fileIdentities && identities.some((s, i) => !equal(s, fileIdentities[i]))) bad();
      if (configIdentity && (!currentConfig || !equal(configIdentity, currentConfig))) bad();
      configIdentity = currentConfig;
      fileIdentities = identities;
      prior = m;
      return { verified: true, digest: m.digest, executable: path.join(a.bundleRoot, required[1]), home: a.home };
    } catch { return { verified: false }; }
  };
  const consumed = new Set();
  return { verifyArtifact, permit: {
    read() {
      try {
        const p = frozenJson('permit');
        if (!Number.isSafeInteger(p.value.expiresAtUtcMs)) bad();
        if (priorPermit && (p.digest !== priorPermit.digest || !equal(p.identity, priorPermit.identity) || !equal(p.pinIdentity, priorPermit.pinIdentity))) bad();
        if (permitExpiry === undefined) {
          const remaining = p.value.expiresAtUtcMs - Date.now();
          if (remaining <= 0 || remaining > 30000) bad();
          permitExpiry = performance.now() + remaining;
          priorPermit = p;
        }
        // Wall clock is used once for external UTC admission, never to reset
        // the locked monotonic authorization or operation deadlines.
        return { ...p.value, expiresAt: permitExpiry };
      } catch { return {}; }
    },
    consume(stage) {
      if (consumed.has(stage) || !['attempt', 'bring'].includes(stage)) return false;
      consumed.add(stage);
      try {
        const p = frozenJson('permit').value;
        if (!['preflight', 'bring'].includes(p.mode) || typeof p.epoch !== 'string' || !p.epoch || !/^[a-f0-9]{64}$/.test(p.artifactDigest)) return false;
        plain(TRUST_ROOT);
        // Durable O_EXCL marker makes a second CLI exec with the same reviewed
        // opportunity fail closed. This is not a retryable in-memory token.
        const name = hash(Buffer.from(JSON.stringify([p.mode, p.epoch, p.artifactDigest]))) + '.' + stage;
        const fd = fs.openSync(path.join(TRUST_ROOT, name), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.closeSync(fd);
        return true;
      } catch { return false; }
    },
  } };
}

function ownedChild(options, sources) {
  const a = sources.verifyArtifact();
  if (!a.verified) bad();
  options.beforeSpawn();
  const cp = spawn(a.executable, options.argv, { env: { ...options.env, HOME: a.home }, stdio: ['pipe', 'pipe', 'pipe'], shell: false, detached: false });
  const events = []; let waiter, closed = false, ownership = 'owned';
  const push = (event) => { if (waiter) { const take = waiter; waiter = undefined; take(event); } else events.push(event); };
  // Backpressure bounds queued data to at most the current chunk per stream.
  for (const [stream, type] of [[cp.stdout, 'stdout'], [cp.stderr, 'stderr']]) {
    stream.on('data', (data) => { stream.pause(); push({ type, data }); });
    stream.on('end', () => push({ type: 'eof' }));
    stream.on('error', () => push({ type: 'error' }));
  }
  cp.on('exit', (code, signal) => push({ type: 'exit', code, signal }));
  cp.on('close', () => { closed = true; push({ type: 'close' }); });
  cp.on('error', () => { ownership = 'unknown'; push({ type: 'error' }); });
  cp.stdin.on('error', () => push({ type: 'error' }));
  return {
    read() { const event = events.shift(); if (event) { cp.stdout.resume(); cp.stderr.resume(); return Promise.resolve(event); } return new Promise((resolve) => { waiter = resolve; cp.stdout.resume(); cp.stderr.resume(); }); },
    write(bytes) { return new Promise((resolve) => cp.stdin.write(bytes, (error) => resolve(!error))); },
    end() { cp.stdin.end(); },
    snapshot() { return { exitCode: cp.exitCode, signalCode: cp.signalCode, closed, ownership }; },
    signal(kind) { if (ownership !== 'owned' || closed || cp.exitCode !== null || cp.signalCode !== null) return false; return cp.kill(kind); },
  };
}
export function cleanupCancelHandlers(processApi, cancel, keeperPending) {
  if (!keeperPending) { processApi.removeListener('SIGINT', cancel); processApi.removeListener('SIGTERM', cancel); }
}
export async function main(args = process.argv.slice(2)) {
  if (args.length !== 1 || !['preflight', 'bring'].includes(args[0])) return { cause: 'arguments_invalid', principalVerified: false, readyForDispatch: false };
  const sources = createTrustedSources(), controller = new AbortController();
  let keeperPending = false;
  const cancel = () => controller.abort(new Error('operator_cancelled'));
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  try {
    return await runDiagnostic({ mode: args[0], signal: controller.signal, permit: sources.permit }, {
      now: () => performance.now(), setTimer: setTimeout, clearTimer: clearTimeout,
      verifyArtifact: sources.verifyArtifact, spawn: (options) => ownedChild(options, sources),
      retain(child) { keeperPending = true; const keeper = setInterval(() => { void child; }, 30000); keeper.ref(); },
    });
  } catch { return { cause: 'cancelled', principalVerified: false, readyForDispatch: false }; }
  finally { cleanupCancelHandlers(process, cancel, keeperPending); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await main();
  // EPIPE must not force-exit a retained keeper. Never forward raw exception data.
  process.stdout.on('error', () => {});
  process.stdout.write(JSON.stringify(result) + '\n', () => {});
  if (result.cause !== 'none') process.exitCode = 1;
}
