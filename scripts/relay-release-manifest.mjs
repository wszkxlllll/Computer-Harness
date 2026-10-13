import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const RELAY_PROFILE = 'relay-runtime-c84d6d1-v1';
export const RUNTIME_FILES = Object.freeze([
  'apps/relay/dist/config.js', 'apps/relay/dist/index.js', 'apps/relay/dist/server.js',
  'apps/relay/package.json', 'packages/protocol/dist/index.js', 'packages/protocol/package.json',
  'packages/relay-connector/dist/protocol.js', 'packages/relay-connector/dist/routing.js',
  'packages/relay-connector/package.json', 'packages/voice/dist/contracts.js',
  'packages/voice/dist/index.js', 'packages/voice/dist/notice-scheduler.js',
  'packages/voice/dist/run-notices.js', 'packages/voice/dist/transcript.js', 'packages/voice/package.json',
].sort());
export const WS_FILES = Object.freeze([
  'LICENSE', 'README.md', 'browser.js', 'index.js', 'package.json', 'wrapper.mjs',
  'lib/buffer-util.js', 'lib/constants.js', 'lib/event-target.js', 'lib/extension.js',
  'lib/limiter.js', 'lib/permessage-deflate.js', 'lib/receiver.js', 'lib/sender.js',
  'lib/stream.js', 'lib/subprotocol.js', 'lib/validation.js', 'lib/websocket-server.js', 'lib/websocket.js',
].sort());
const WORKSPACE_LINKS = Object.freeze([
  ['apps/relay/node_modules/@computer-harness/relay-connector', 'packages/relay-connector'],
  ['packages/relay-connector/node_modules/@computer-harness/protocol', 'packages/protocol'],
  ['packages/relay-connector/node_modules/@computer-harness/voice', 'packages/voice'],
  ['packages/voice/node_modules/@computer-harness/protocol', 'packages/protocol'],
]);
const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha = (v) => createHash('sha256').update(v).digest('hex');
const hashShape = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const revisionShape = (v) => typeof v === 'string' && /^[a-f0-9]{40}$/u.test(v);
const fail = (code) => { throw new Error(code); };
const safeRelative = (v) => typeof v === 'string' && !isAbsolute(v) && !v.includes('\\') && !v.includes('\0')
  && v.length <= 240 && !v.split('/').some((part) => part === '' || part === '.' || part === '..');
const exactKeys = (obj, keys) => record(obj) && Object.keys(obj).length === keys.length
  && Object.keys(obj).every((key) => keys.includes(key));

// This generator produces review material. Its output never authenticates its own source.
export async function captureRelayManifest({ releaseRoot, sourceRevision, wsPackageRoot } = {}) {
  if (!revisionShape(sourceRevision) || !safeRelative(wsPackageRoot)) fail('capture_options_invalid');
  try {
    const root = await canonicalRoot(releaseRoot);
    const scanned = await scan(root, wsPackageRoot);
    return Object.freeze({ schema: 'harness.relay_release_manifest.v1', profile: RELAY_PROFILE,
      algorithm: 'sha256', sourceRevision, files: scanned.files,
      ws: { packageRoot: wsPackageRoot, version: '8.21.3', files: scanned.wsFiles, treeSha256: scanned.treeSha256 } });
  } catch (error) { throw new Error(safeCode(error)); }
}

export function serializeRelayManifest(value) {
  const manifest = normalizeManifest(value);
  return JSON.stringify(manifest);
}

export async function verifyRelayRelease({ releaseRoot, expectedManifest, expectedManifestSha256 } = {}) {
  let sourceRevision = null;
  let manifestSha256 = null;
  const report = (result) => Object.freeze({ profile: RELAY_PROFILE, sourceRevision,
    manifestSha256, result, provenanceScope: 'release-files-only', runtimeLoaded: false, processAttested: false });
  try {
    // The digest must be supplied from an independently reviewed, frozen source.
    if (!hashShape(expectedManifestSha256)) return report('trusted_manifest_digest_required');
    const expected = normalizeManifest(expectedManifest);
    sourceRevision = expected.sourceRevision;
    manifestSha256 = sha(JSON.stringify(expected));
    if (manifestSha256 !== expectedManifestSha256) return report('trusted_manifest_digest_mismatch');
    const root = await canonicalRoot(releaseRoot);
    const actual = await scan(root, expected.ws.packageRoot);
    if (JSON.stringify(actual.files) !== JSON.stringify(expected.files)) return report('runtime_bytes_mismatch');
    if (JSON.stringify(actual.wsFiles) !== JSON.stringify(expected.ws.files)
      || actual.treeSha256 !== expected.ws.treeSha256) return report('ws_bytes_mismatch');
    return report('bytes_and_layout_match');
  } catch (error) { return report(safeCode(error)); }
}

function normalizeManifest(value) {
  if (!exactKeys(value, ['schema', 'profile', 'algorithm', 'sourceRevision', 'files', 'ws'])
    || value.schema !== 'harness.relay_release_manifest.v1' || value.profile !== RELAY_PROFILE
    || value.algorithm !== 'sha256' || !revisionShape(value.sourceRevision)
    || !exactKeys(value.ws, ['packageRoot', 'version', 'files', 'treeSha256'])
    || !safeRelative(value.ws.packageRoot) || value.ws.version !== '8.21.3' || !hashShape(value.ws.treeSha256)) fail('manifest_invalid');
  return { schema: value.schema, profile: value.profile, algorithm: value.algorithm, sourceRevision: value.sourceRevision,
    files: normalizeEntries(value.files, RUNTIME_FILES), ws: { packageRoot: value.ws.packageRoot,
      version: value.ws.version, files: normalizeEntries(value.ws.files, WS_FILES), treeSha256: value.ws.treeSha256 } };
}

function normalizeEntries(entries, required) {
  if (!Array.isArray(entries) || entries.length !== required.length) fail('manifest_invalid');
  const seen = new Set();
  for (const entry of entries) {
    if (!exactKeys(entry, ['path', 'sha256']) || !safeRelative(entry.path) || !hashShape(entry.sha256)
      || seen.has(entry.path) || !required.includes(entry.path)) fail('manifest_invalid');
    seen.add(entry.path);
  }
  return entries.map(({ path, sha256 }) => ({ path, sha256 })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

async function canonicalRoot(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) === '/' || resolve(value) !== value) fail('release_root_invalid');
  const real = await fs.realpath(value);
  const stat = await fs.lstat(value);
  if (real !== value || stat.isSymbolicLink() || !stat.isDirectory()) fail('release_root_invalid');
  return real;
}

async function plainPath(root, path, finalKind) {
  if (!safeRelative(path)) fail('layout_unsafe');
  let current = root;
  const parts = path.split('/');
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory()
      : finalKind === 'file' ? !stat.isFile() : !stat.isDirectory())) fail('layout_unsafe');
  }
  if (await fs.realpath(current) !== current) fail('layout_unsafe');
  return current;
}

async function readPlainFile(root, path) {
  const full = await plainPath(root, path, 'file');
  const handle = await fs.open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 8_388_608) fail('file_unsafe');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const current = await fs.lstat(full);
    if (!current.isFile() || current.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino
      || after.dev !== current.dev || after.ino !== current.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail('file_changed');
    return bytes;
  } finally { await handle.close(); }
}

async function verifyLink(root, path, target) {
  await plainPath(root, dirname(path), 'directory');
  const stat = await fs.lstat(join(root, path));
  if (!stat.isSymbolicLink()) fail('link_mismatch');
  const canonicalTarget = await plainPath(root, target, 'directory');
  const originalText = await fs.readlink(join(root, path));
  if (await fs.realpath(join(root, path)) !== canonicalTarget) fail('link_mismatch');
  const after = await fs.lstat(join(root, path));
  if (!after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino
    || await fs.readlink(join(root, path)) !== originalText) fail('link_mismatch');
}

async function scan(root, wsPackageRoot) {
  await plainPath(root, wsPackageRoot, 'directory');
  for (const [path, target] of WORKSPACE_LINKS) await verifyLink(root, path, target);
  await verifyLink(root, 'apps/relay/node_modules/ws', wsPackageRoot);
  const files = []; const payloads = new Map();
  for (const path of RUNTIME_FILES) {
    const bytes = await readPlainFile(root, path);
    files.push({ path, sha256: sha(bytes) });
    if (path.endsWith('/package.json')) payloads.set(path, parseMetadata(bytes));
  }
  validateMetadata(payloads);
  const actualWs = await treeFiles(root, wsPackageRoot);
  if (JSON.stringify(actualWs) !== JSON.stringify([...WS_FILES].sort())) fail('ws_tree_mismatch');
  const wsFiles = []; const tree = createHash('sha256');
  for (const path of WS_FILES) {
    const bytes = await readPlainFile(root, `${wsPackageRoot}/${path}`);
    wsFiles.push({ path, sha256: sha(bytes) });
    tree.update(path); tree.update('\0'); tree.update(bytes); tree.update('\0');
    if (path === 'package.json') validateWsMetadata(parseMetadata(bytes));
  }
  // Recheck layout after byte reads; this is bounded point-in-time evidence, not atomic ownership.
  for (const [path, target] of WORKSPACE_LINKS) await verifyLink(root, path, target);
  await verifyLink(root, 'apps/relay/node_modules/ws', wsPackageRoot);
  return { files, wsFiles, treeSha256: tree.digest('hex') };
}

async function treeFiles(root, path) {
  const full = await plainPath(root, path, 'directory');
  const paths = [];
  async function visit(directory, prefix) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!safeRelative(rel) || entry.isSymbolicLink()) fail('ws_tree_mismatch');
      if (entry.isDirectory()) {
        // The reviewed tree has exactly one subdirectory, lib; extras never get read.
        if (rel !== 'lib') fail('ws_tree_mismatch');
        await plainPath(root, `${path}/${rel}`, 'directory');
        await visit(join(directory, entry.name), rel);
      } else if (entry.isFile()) paths.push(rel);
      else fail('ws_tree_mismatch');
    }
  }
  await visit(full, '');
  return paths.sort();
}

function parseMetadata(bytes) {
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!record(value)) fail('metadata_mismatch');
    return value;
  } catch { fail('metadata_mismatch'); }
}
function validateMetadata(p) {
  const names = [['apps/relay/package.json', '@computer-harness/relay'],
    ['packages/protocol/package.json', '@computer-harness/protocol'],
    ['packages/relay-connector/package.json', '@computer-harness/relay-connector'],
    ['packages/voice/package.json', '@computer-harness/voice']];
  if (names.some(([path, name]) => p.get(path)?.name !== name || p.get(path)?.type !== 'module')) fail('metadata_mismatch');
  const connector = p.get('packages/relay-connector/package.json');
  if (connector.exports?.['./protocol'] !== './dist/protocol.js' || connector.exports?.['./routing'] !== './dist/routing.js'
    || p.get('packages/protocol/package.json').exports?.['.']?.import !== './dist/index.js'
    || p.get('packages/voice/package.json').exports?.['.']?.import !== './dist/index.js'
    || p.get('apps/relay/package.json').dependencies?.ws !== '8.21.3') fail('metadata_mismatch');
}
function validateWsMetadata(value) {
  if (value.name !== 'ws' || value.version !== '8.21.3' || value.main !== 'index.js'
    || value.exports?.['.']?.import !== './wrapper.mjs' || value.exports?.['.']?.require !== './index.js') fail('ws_metadata_mismatch');
}
function safeCode(error) {
  const allowed = new Set(['manifest_invalid', 'release_root_invalid', 'layout_unsafe', 'file_unsafe',
    'file_changed', 'link_mismatch', 'ws_tree_mismatch', 'metadata_mismatch', 'ws_metadata_mismatch']);
  return allowed.has(error?.message) ? error.message : 'release_unavailable';
}
