import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyRelayRelease } from './relay-release-manifest.mjs';

const BOOTSTRAP = fileURLToPath(import.meta.url);
const CHECKER = fileURLToPath(new URL('./relay-release-manifest.mjs', import.meta.url));
const fail = (code) => { throw new Error(code); };
const inside = (root, path) => path === root || path.startsWith(`${root}${sep}`);
const normalized = (path) => typeof path === 'string' && isAbsolute(path) && path !== '/'
  && !path.includes('\0') && resolve(path) === path;
const identity = (stat) => ({ dev: stat.dev, ino: stat.ino, size: stat.size,
  mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, directory: stat.isDirectory() });
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.directory === b.directory
  && (a.directory || a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs);

async function plainSnapshot(api, path, kind) {
  if (!normalized(path)) fail('path_invalid');
  const chain = []; let current = path;
  while (true) {
    const stat = await api.lstat(current);
    if (stat.isSymbolicLink() || (current === path && kind === 'file' ? !stat.isFile() : !stat.isDirectory())) fail('path_unsafe');
    chain.push({ path: current, id: identity(stat) });
    if (current === '/') break;
    current = dirname(current);
  }
  if (await api.realpath(path) !== path) fail('path_unsafe');
  return chain;
}
async function recheck(api, snapshot) {
  for (const { path, id } of snapshot) {
    const stat = await api.lstat(path);
    if (stat.isSymbolicLink() || !same(id, identity(stat))) fail('identity_changed');
  }
}
async function boundedExternalRead(api, path, max) {
  const snapshot = await plainSnapshot(api, path, 'file');
  const handle = await api.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || !same(snapshot[0].id, identity(before)) || before.size > max) fail('external_file_unsafe');
    // Do not let a racing grow turn readFile into an unbounded allocation.
    const buffer = Buffer.alloc(max + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > max || length !== before.size) fail('external_file_unsafe');
    const after = await handle.stat();
    if (!same(identity(before), identity(after))) fail('identity_changed');
    await recheck(api, snapshot);
    return { bytes: buffer.subarray(0, length), snapshot };
  } finally { await handle.close(); }
}

// The injectable importer is a library-only test seam, never a CLI option.
// fsApi supports synthetic race fixtures; ordinary callers use Node's filesystem.
export async function startVerifiedRelay({ releaseRoot, manifestPath, pinPath,
  importer = (url) => import(url), fsApi = fs } = {}) {
  let verification = null; let entryDispatched = false;
  const report = (result) => Object.freeze({ result, profile: verification?.profile ?? null,
    sourceRevision: verification?.sourceRevision ?? null, manifestSha256: verification?.manifestSha256 ?? null,
    provenanceScope: 'release-files-only', evidenceTiming: 'point-in-time', entryDispatched,
    serviceHealth: 'unverified', processAttested: false });
  try {
    if (![releaseRoot, manifestPath, pinPath].every(normalized) || typeof importer !== 'function') fail('options_invalid');
    if ([manifestPath, pinPath, BOOTSTRAP, CHECKER].some(path => inside(releaseRoot, path))) fail('trusted_source_inside_release');
    const root = await plainSnapshot(fsApi, releaseRoot, 'directory');
    const bootstrap = await plainSnapshot(fsApi, BOOTSTRAP, 'file');
    const checker = await plainSnapshot(fsApi, CHECKER, 'file');
    const manifest = await boundedExternalRead(fsApi, manifestPath, 65_536);
    const pin = await boundedExternalRead(fsApi, pinPath, 65);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(pin.bytes);
    if (!/^[a-f0-9]{64}\n?$/u.test(text)) fail('pin_invalid');
    let parsed;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifest.bytes)); }
    catch { fail('manifest_invalid'); }
    verification = await verifyRelayRelease({ releaseRoot, expectedManifest: parsed, expectedManifestSha256: text.trimEnd() });
    if (verification.result !== 'bytes_and_layout_match') return report(verification.result);
    for (const snapshot of [root, bootstrap, checker, manifest.snapshot, pin.snapshot]) await recheck(fsApi, snapshot);
    // Fixed entry only. Rechecks bound observations, not an atomic verify-to-load guarantee.
    entryDispatched = true;
    await importer(pathToFileURL(join(releaseRoot, 'apps/relay/dist/index.js')).href);
    return report('entry_import_requested');
  } catch (error) {
    const allowed = ['options_invalid', 'path_invalid', 'path_unsafe', 'identity_changed',
      'external_file_unsafe', 'trusted_source_inside_release', 'pin_invalid', 'manifest_invalid'];
    return report(entryDispatched ? 'entry_import_failed' : allowed.includes(error?.message) ? error.message : 'startup_unavailable');
  }
}

export function parseStartupArguments(args) {
  const mapping = { '--release-root': 'releaseRoot', '--manifest': 'manifestPath', '--manifest-pin': 'pinPath' };
  const result = {};
  if (!Array.isArray(args) || args.length !== 6) fail('arguments_invalid');
  for (let index = 0; index < args.length; index += 2) {
    const key = Object.hasOwn(mapping, args[index]) ? mapping[args[index]] : null;
    if (!key || Object.hasOwn(result, key) || !normalized(args[index + 1])) fail('arguments_invalid');
    result[key] = args[index + 1];
  }
  if (Object.keys(result).length !== 3) fail('arguments_invalid');
  return result;
}

// A successfully requested import does not erase an exit status already set by
// the candidate's asynchronous main. Import resolution is not service health.
export function startupExitCode(result, currentExitCode) {
  return result === 'entry_import_requested' ? currentExitCode : 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  let options;
  try { options = parseStartupArguments(process.argv.slice(2)); }
  catch { console.log(JSON.stringify({ result: 'arguments_invalid', entryDispatched: false, serviceHealth: 'unverified' })); process.exitCode = 2; }
  if (options) {
    const report = await startVerifiedRelay(options);
    console.log(JSON.stringify(report));
    process.exitCode = startupExitCode(report.result, process.exitCode);
  }
}
