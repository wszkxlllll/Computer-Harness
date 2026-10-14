import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { captureRelayManifest, verifyRelayRelease, serializeRelayManifest, RUNTIME_FILES, WS_FILES } from './relay-release-manifest.mjs';

const revision = 'c84d6d11b9cf884e697cab11a81d1a09b111e784';
const ws = 'isolated-runtime/ws-exact';
const hash = (v) => createHash('sha256').update(v).digest('hex');
const pin = (m) => hash(serializeRelayManifest(m));
const clone = (v) => JSON.parse(JSON.stringify(v));
const pkgs = {
  'apps/relay/package.json': { name: '@computer-harness/relay', type: 'module', dependencies: { ws: '8.21.3' } },
  'packages/protocol/package.json': { name: '@computer-harness/protocol', type: 'module', exports: { '.': { import: './dist/index.js' } } },
  'packages/voice/package.json': { name: '@computer-harness/voice', type: 'module', exports: { '.': { import: './dist/index.js' } } },
  'packages/relay-connector/package.json': { name: '@computer-harness/relay-connector', type: 'module', exports: { './protocol': './dist/protocol.js', './routing': './dist/routing.js' } },
};
const links = [
  ['apps/relay/node_modules/@computer-harness/relay-connector', 'packages/relay-connector'],
  ['packages/relay-connector/node_modules/@computer-harness/protocol', 'packages/protocol'],
  ['packages/relay-connector/node_modules/@computer-harness/voice', 'packages/voice'],
  ['packages/voice/node_modules/@computer-harness/protocol', 'packages/protocol'],
  ['apps/relay/node_modules/ws', ws],
];
async function write(root, path, bytes) { await fs.mkdir(dirname(join(root, path)), { recursive: true }); await fs.writeFile(join(root, path), bytes); }
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp('/private/tmp/F010-release-fixture.'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const path of RUNTIME_FILES) await write(root, path, pkgs[path] ? JSON.stringify(pkgs[path]) : "throw new Error('must never execute fixture');\n");
  for (const path of WS_FILES) await write(root, `${ws}/${path}`, path === 'package.json' ? JSON.stringify({ name: 'ws', version: '8.21.3', main: 'index.js', exports: { '.': { import: './wrapper.mjs', require: './index.js' } } }) : Buffer.from(`独立 fixture ${path}\n`));
  for (const [path, target] of links) { await fs.mkdir(dirname(join(root, path)), { recursive: true }); await fs.symlink(relative(dirname(join(root, path)), join(root, target)), join(root, path)); }
  const manifest = await captureRelayManifest({ releaseRoot: root, sourceRevision: revision, wsPackageRoot: ws });
  return { root, manifest, verify: (m = manifest, digest = pin(m)) => verifyRelayRelease({ releaseRoot: root, expectedManifest: m, expectedManifestSha256: digest }) };
}

test('independent tree digest uses exact ASCII path NUL bytes NUL sequence', async (t) => {
  const f = await fixture(t), h = createHash('sha256');
  for (const path of [...WS_FILES].sort()) { h.update(path); h.update(Buffer.from([0])); h.update(await fs.readFile(join(f.root, ws, path))); h.update(Buffer.from([0])); }
  assert.equal(f.manifest.ws.treeSha256, h.digest('hex'));
  assert.equal(f.manifest.files.filter((x) => x.path.endsWith('.js')).length, 11);
  assert.equal(f.manifest.files.filter((x) => x.path.endsWith('/package.json')).length, 4);
  assert.equal(f.manifest.ws.files.length, 19);
  const r = await f.verify(); assert.equal(r.result, 'bytes_and_layout_match'); assert.equal(r.runtimeLoaded, false); assert.equal(r.processAttested, false); assert.equal(r.provenanceScope, 'release-files-only');
});
test('candidate cannot replace trusted baseline digest after routing mutation', async (t) => {
  const f = await fixture(t), originalPin = pin(f.manifest);
  await write(f.root, 'packages/relay-connector/dist/routing.js', 'old routing bytes');
  assert.equal((await f.verify()).result, 'runtime_bytes_mismatch');
  const forged = await captureRelayManifest({ releaseRoot: f.root, sourceRevision: revision, wsPackageRoot: ws });
  assert.equal((await f.verify(forged, originalPin)).result, 'trusted_manifest_digest_mismatch');
});
test('manifest strict set and digest guards precede candidate filesystem access', async (t) => {
  const f = await fixture(t), root = '/private/tmp/does-not-exist-F010-independent';
  assert.equal((await verifyRelayRelease({ releaseRoot: root, expectedManifest: f.manifest })).result, 'trusted_manifest_digest_required');
  assert.equal((await verifyRelayRelease({ releaseRoot: root, expectedManifest: f.manifest, expectedManifestSha256: '0'.repeat(64) })).result, 'trusted_manifest_digest_mismatch');
  for (const change of [m => m.files.splice(0, 1), m => { m.files[1] = m.files[0]; }, m => { m.ws.packageRoot = '/external/ws'; }, m => { m.ws.packageRoot = 'x/../ws'; }, m => { m.files[0].extra = 'raw private'; }]) {
    const m = clone(f.manifest); change(m); assert.equal((await verifyRelayRelease({ releaseRoot: root, expectedManifest: m, expectedManifestSha256: pin(f.manifest) })).result, 'manifest_invalid');
  }
});
test('absolute link text is accepted only for the exact canonical in-root binding', async (t) => {
  const f = await fixture(t);
  for (const [path, target] of links) { await fs.unlink(join(f.root, path)); await fs.symlink(join(f.root, target), join(f.root, path)); }
  assert.equal((await f.verify()).result, 'bytes_and_layout_match');
  const [path] = links[0]; await fs.unlink(join(f.root, path)); await fs.symlink(join(f.root, 'packages/voice'), join(f.root, path));
  assert.equal((await f.verify()).result, 'link_mismatch');
});
test('canonical root aliases and ws package directory aliases are refused', async (t) => {
  const f = await fixture(t), aliases = await fs.realpath(await fs.mkdtemp('/private/tmp/F010-alias-fixture.'));
  t.after(() => fs.rm(aliases, { recursive: true, force: true })); await fs.symlink(f.root, join(aliases, 'release'));
  assert.equal((await verifyRelayRelease({ releaseRoot: join(aliases, 'release'), expectedManifest: f.manifest, expectedManifestSha256: pin(f.manifest) })).result, 'release_root_invalid');
  await fs.rename(join(f.root, ws), join(f.root, 'moved-ws')); await fs.symlink(join(f.root, 'moved-ws'), join(f.root, ws));
  assert.equal((await f.verify()).result, 'layout_unsafe');
});
test('ordinary link-shaped files and oversize runtime cannot be accepted', async (t) => {
  const f = await fixture(t), [path] = links[2]; await fs.unlink(join(f.root, path)); await write(f.root, path, 'packages/voice');
  assert.equal((await f.verify()).result, 'link_mismatch');
  const g = await fixture(t); await write(g.root, 'apps/relay/dist/config.js', Buffer.alloc(8388609));
  assert.equal((await g.verify()).result, 'file_unsafe');
});
test('ws extra nested directory and omitted LICENSE invalidate complete tree', async (t) => {
  const f = await fixture(t); await fs.mkdir(join(f.root, ws, 'extra'));
  assert.equal((await f.verify()).result, 'ws_tree_mismatch');
  const g = await fixture(t); await fs.unlink(join(g.root, ws, 'LICENSE'));
  assert.equal((await g.verify()).result, 'ws_tree_mismatch');
});
test('metadata invalid UTF8 never leaks bytes or filesystem path', async (t) => {
  const f = await fixture(t); await write(f.root, 'packages/protocol/package.json', Buffer.from([0xff, 0xff]));
  const r = await f.verify(); assert.equal(r.result, 'metadata_mismatch'); assert.ok(!JSON.stringify(r).includes(f.root)); assert.equal(r.runtimeLoaded, false);
});
test('capture missing file throws only a fixed public error category', async (t) => {
  const f = await fixture(t); await fs.unlink(join(f.root, 'packages/voice/dist/transcript.js'));
  await assert.rejects(captureRelayManifest({ releaseRoot: f.root, sourceRevision: revision, wsPackageRoot: ws }), (error) => error.message === 'release_unavailable');
});
