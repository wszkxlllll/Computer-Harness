import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { captureRelayManifest, verifyRelayRelease, serializeRelayManifest, RUNTIME_FILES, WS_FILES, RELAY_PROFILE } from './relay-release-manifest.mjs';

const revision = 'c84d6d11b9cf884e697cab11a81d1a09b111e784';
const wsRoot = 'vendor/ws-8.21.3';
const digest = (m) => createHash('sha256').update(serializeRelayManifest(m)).digest('hex');
const metadata = {
  'apps/relay/package.json': { name: '@computer-harness/relay', type: 'module', dependencies: { ws: '8.21.3' } },
  'packages/protocol/package.json': { name: '@computer-harness/protocol', type: 'module', exports: { '.': { import: './dist/index.js' } } },
  'packages/relay-connector/package.json': { name: '@computer-harness/relay-connector', type: 'module', exports: { './protocol': './dist/protocol.js', './routing': './dist/routing.js' } },
  'packages/voice/package.json': { name: '@computer-harness/voice', type: 'module', exports: { '.': { import: './dist/index.js' } } },
};
const wsMetadata = { name: 'ws', version: '8.21.3', main: 'index.js', exports: { '.': { import: './wrapper.mjs', require: './index.js' } } };
async function write(root, path, content) { await fs.mkdir(dirname(join(root, path)), { recursive: true }); await fs.writeFile(join(root, path), content); }
async function link(root, path, target) {
  await fs.mkdir(dirname(join(root, path)), { recursive: true });
  await fs.symlink(relative(dirname(join(root, path)), join(root, target)), join(root, path));
}
async function release(t) {
  const temp = await fs.mkdtemp(join(tmpdir(), 'relay-manifest-fixture-'));
  const root = await fs.realpath(temp);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const path of RUNTIME_FILES) await write(root, path, metadata[path] ? JSON.stringify(metadata[path]) : `// synthetic ${path}\nthrow new Error('fixture must never import');\n`);
  for (const path of WS_FILES) await write(root, `${wsRoot}/${path}`, path === 'package.json' ? JSON.stringify(wsMetadata) : `synthetic ws ${path}\n`);
  for (const [path, target] of [
    ['apps/relay/node_modules/@computer-harness/relay-connector', 'packages/relay-connector'],
    ['apps/relay/node_modules/ws', wsRoot],
    ['packages/relay-connector/node_modules/@computer-harness/protocol', 'packages/protocol'],
    ['packages/relay-connector/node_modules/@computer-harness/voice', 'packages/voice'],
    ['packages/voice/node_modules/@computer-harness/protocol', 'packages/protocol'],
  ]) await link(root, path, target);
  const manifest = await captureRelayManifest({ releaseRoot: root, sourceRevision: revision, wsPackageRoot: wsRoot });
  return { root, manifest, verify: (m = manifest, pin = digest(m)) => verifyRelayRelease({ releaseRoot: root, expectedManifest: m, expectedManifestSha256: pin }) };
}
const clone = (v) => JSON.parse(JSON.stringify(v));

test('complete fixed profile matches independent bytes and layout without importing JS', async (t) => {
  const f = await release(t); const result = await f.verify();
  assert.equal(result.result, 'bytes_and_layout_match'); assert.equal(result.profile, RELAY_PROFILE);
  assert.equal(f.manifest.files.length, 15); assert.equal(f.manifest.ws.files.length, 19);
  assert.equal(result.runtimeLoaded, false); assert.equal(result.processAttested, false);
  assert.equal(result.provenanceScope, 'release-files-only'); assert.ok(!JSON.stringify(result).includes(f.root));
  // A separate candidate directory verifies against the externally frozen manifest.
  const candidate = await release(t);
  assert.equal((await candidate.verify(f.manifest, digest(f.manifest))).result, 'bytes_and_layout_match');
});

test('external digest is mandatory and candidate-generated replacement cannot match a frozen pin', async (t) => {
  const f = await release(t);
  assert.equal((await verifyRelayRelease({ releaseRoot: f.root, expectedManifest: f.manifest })).result, 'trusted_manifest_digest_required');
  await write(f.root, 'packages/relay-connector/dist/routing.js', '// old deployed routing\n');
  assert.equal((await f.verify()).result, 'runtime_bytes_mismatch');
  const candidateManifest = await captureRelayManifest({ releaseRoot: f.root, sourceRevision: revision, wsPackageRoot: wsRoot });
  assert.equal((await f.verify(candidateManifest, digest(f.manifest))).result, 'trusted_manifest_digest_mismatch');
});

test('required runtime and ws manifest sets reject omissions, duplicates, traversal, absolutes and extras', async (t) => {
  const f = await release(t);
  const cases = [m => m.files.pop(), m => { m.files[1] = m.files[0]; }, m => { m.files[0].path = '../secret'; },
    m => { m.files[0].path = '/private/config'; }, m => { m.files[0].path = 'apps\\relay\\secret'; },
    m => m.ws.files.pop(), m => { m.ws.files[1] = m.ws.files[0]; }, m => { m.ws.packageRoot = '../ws'; },
    m => { m.profile = 'loose-profile'; }, m => { m.files[0].sha256 = 'x'.repeat(64); },
    m => { m.extra = 'untrusted'; }, m => { m.ws.version = '8.0.0'; }];
  for (const mutate of cases) {
    const m = clone(f.manifest); mutate(m);
    const result = await f.verify(m, digest(f.manifest)); assert.equal(result.result, 'manifest_invalid');
    assert.ok(!JSON.stringify(result).includes('secret'));
  }
});

test('missing voice runtime refuses the release', async (t) => {
  const f = await release(t); await fs.unlink(join(f.root, 'packages/voice/dist/transcript.js'));
  assert.equal((await f.verify()).result, 'release_unavailable');
});

test('capture failures expose only a fixed category, without native path/body/cause', async (t) => {
  const f = await release(t); await fs.unlink(join(f.root, 'packages/voice/dist/transcript.js'));
  await assert.rejects(captureRelayManifest({ releaseRoot: f.root, sourceRevision: revision, wsPackageRoot: wsRoot }), error => {
    assert.equal(error.message, 'release_unavailable'); assert.equal(error.cause, undefined); assert.equal(error.path, undefined);
    assert.ok(!error.message.includes(f.root)); assert.ok(!error.message.includes('ENOENT'));
    return true;
  });
});

test('file and ancestor symlinks are refused even when pointing to identical in-root bytes', async (t) => {
  const f = await release(t); const path = 'apps/relay/dist/server.js';
  await write(f.root, 'duplicates/server.js', await fs.readFile(join(f.root, path)));
  await fs.unlink(join(f.root, path)); await link(f.root, path, 'duplicates/server.js');
  assert.equal((await f.verify()).result, 'layout_unsafe');
  const g = await release(t);
  await fs.rename(join(g.root, 'packages/voice/dist'), join(g.root, 'packages/voice/moved-dist'));
  await link(g.root, 'packages/voice/dist', 'packages/voice/moved-dist');
  assert.equal((await g.verify()).result, 'layout_unsafe');
});

test('workspace links must match exact package roots, not merely somewhere inside release', async (t) => {
  const f = await release(t); const path = 'packages/relay-connector/node_modules/@computer-harness/voice';
  await fs.unlink(join(f.root, path)); await link(f.root, path, 'packages/protocol');
  assert.equal((await f.verify()).result, 'link_mismatch');
  const g = await release(t); const outside = await fs.mkdtemp(join(tmpdir(), 'relay-manifest-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.unlink(join(g.root, path)); await fs.symlink(outside, join(g.root, path));
  assert.equal((await g.verify()).result, 'link_mismatch');
});

test('ws binding uses the trusted physical packageRoot and rejects a target drift', async (t) => {
  const f = await release(t); await fs.mkdir(join(f.root, 'other-ws'));
  await fs.unlink(join(f.root, 'apps/relay/node_modules/ws')); await link(f.root, 'apps/relay/node_modules/ws', 'other-ws');
  assert.equal((await f.verify()).result, 'link_mismatch');
});

test('actual symlink text may be absolute or relative when exact canonical targets remain bound', async (t) => {
  const f = await release(t); const path = 'apps/relay/node_modules/ws';
  await fs.unlink(join(f.root, path)); await fs.symlink(join(f.root, wsRoot), join(f.root, path));
  assert.equal((await f.verify()).result, 'bytes_and_layout_match');
  const g = await release(t); await fs.unlink(join(g.root, path));
  const canonical = relative(dirname(join(g.root, path)), join(g.root, wsRoot));
  await fs.symlink(`./${canonical}`, join(g.root, path));
  assert.equal((await g.verify()).result, 'bytes_and_layout_match');
});

test('metadata exports, names, module type and exact ws dependency are required', async (t) => {
  for (const [path, change] of [
    ['packages/relay-connector/package.json', m => { m.exports['./routing'] = './dist/old.js'; }],
    ['packages/protocol/package.json', m => { m.exports['.'].import = './old.js'; }],
    ['packages/voice/package.json', m => { m.type = 'commonjs'; }],
    ['apps/relay/package.json', m => { m.dependencies.ws = '^8.21.3'; }],
    ['apps/relay/package.json', m => { m.name = '@other/relay'; }],
  ]) {
    const f = await release(t); const m = clone(metadata[path]); change(m); await write(f.root, path, JSON.stringify(m));
    assert.equal((await f.verify()).result, 'metadata_mismatch');
  }
});

test('ws mixed version, changed bytes, missing file and extra file are refused', async (t) => {
  const f = await release(t); await write(f.root, `${wsRoot}/package.json`, JSON.stringify({ ...wsMetadata, version: '8.0.0' }));
  assert.equal((await f.verify()).result, 'ws_metadata_mismatch');
  const g = await release(t); await write(g.root, `${wsRoot}/lib/receiver.js`, 'mixed version');
  assert.equal((await g.verify()).result, 'ws_bytes_mismatch');
  const h = await release(t); await fs.unlink(join(h.root, wsRoot, 'wrapper.mjs'));
  assert.equal((await h.verify()).result, 'ws_tree_mismatch');
  const j = await release(t); await write(j.root, `${wsRoot}/hidden-secret`, 'must not be read');
  assert.equal((await j.verify()).result, 'ws_tree_mismatch');
});

test('ws files cannot be symlinks and package metadata exports must agree', async (t) => {
  const f = await release(t); await fs.unlink(join(f.root, wsRoot, 'browser.js'));
  await link(f.root, `${wsRoot}/browser.js`, `${wsRoot}/index.js`);
  assert.equal((await f.verify()).result, 'ws_tree_mismatch');
  const g = await release(t); const m = clone(wsMetadata); m.exports['.'].import = './index.js';
  await write(g.root, `${wsRoot}/package.json`, JSON.stringify(m));
  assert.equal((await g.verify()).result, 'ws_metadata_mismatch');
});

test('manifest entry order is canonical and malformed metadata yields only a fixed result', async (t) => {
  const f = await release(t); const m = clone(f.manifest); m.files.reverse(); m.ws.files.reverse();
  assert.equal(digest(m), digest(f.manifest)); assert.equal((await f.verify(m)).result, 'bytes_and_layout_match');
  await write(f.root, 'apps/relay/package.json', 'private broken content');
  const result = await f.verify(); assert.equal(result.result, 'metadata_mismatch');
  assert.ok(!JSON.stringify(result).includes('private broken content')); assert.ok(!JSON.stringify(result).includes(f.root));
});
