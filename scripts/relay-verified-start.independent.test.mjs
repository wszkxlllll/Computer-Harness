import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { captureRelayManifest, serializeRelayManifest, RUNTIME_FILES, WS_FILES } from './relay-release-manifest.mjs';
import { startVerifiedRelay, parseStartupArguments } from './relay-verified-start.mjs';

const ws = 'independent/ws';
const pin = manifest => createHash('sha256').update(serializeRelayManifest(manifest)).digest('hex');
const pkgs = {
  'apps/relay/package.json': { name: '@computer-harness/relay', type: 'module', dependencies: { ws: '8.21.3' } },
  'packages/protocol/package.json': { name: '@computer-harness/protocol', type: 'module', exports: { '.': { import: './dist/index.js' } } },
  'packages/voice/package.json': { name: '@computer-harness/voice', type: 'module', exports: { '.': { import: './dist/index.js' } } },
  'packages/relay-connector/package.json': { name: '@computer-harness/relay-connector', type: 'module', exports: { './protocol': './dist/protocol.js', './routing': './dist/routing.js' } },
};
async function write(root, path, bytes) { await fs.mkdir(dirname(join(root, path)), { recursive: true }); await fs.writeFile(join(root, path), bytes); }
async function fixture(t) {
  const top = await fs.realpath(await fs.mkdtemp('/private/tmp/F014-synthetic.'));
  t.after(() => fs.rm(top, { recursive: true, force: true }));
  const root = join(top, 'candidate'), external = join(top, 'trusted'); await fs.mkdir(root); await fs.mkdir(external);
  for (const path of RUNTIME_FILES) await write(root, path, pkgs[path] ? JSON.stringify(pkgs[path]) : "throw new Error('never import synthetic entry');\n");
  for (const path of WS_FILES) await write(root, `${ws}/${path}`, path === 'package.json' ? JSON.stringify({ name: 'ws', version: '8.21.3', main: 'index.js', exports: { '.': { import: './wrapper.mjs', require: './index.js' } } }) : `synthetic ${path}\n`);
  for (const [path, target] of [
    ['apps/relay/node_modules/@computer-harness/relay-connector', 'packages/relay-connector'],
    ['packages/relay-connector/node_modules/@computer-harness/protocol', 'packages/protocol'],
    ['packages/relay-connector/node_modules/@computer-harness/voice', 'packages/voice'],
    ['packages/voice/node_modules/@computer-harness/protocol', 'packages/protocol'], ['apps/relay/node_modules/ws', ws],
  ]) { await fs.mkdir(dirname(join(root, path)), { recursive: true }); await fs.symlink(relative(dirname(join(root, path)), join(root, target)), join(root, path)); }
  const manifest = await captureRelayManifest({ releaseRoot: root, sourceRevision: 'c84d6d11b9cf884e697cab11a81d1a09b111e784', wsPackageRoot: ws });
  const options = { releaseRoot: root, manifestPath: join(external, 'manifest.json'), pinPath: join(external, 'pin') };
  await fs.writeFile(options.manifestPath, JSON.stringify(manifest)); await fs.writeFile(options.pinPath, pin(manifest));
  const calls = [], importer = async url => { calls.push(url); };
  return { top, root, external, manifest, options, calls, run: extra => startVerifiedRelay({ ...options, importer, ...extra }) };
}
const rejected = (f, report) => { assert.equal(report.entryDispatched, false); assert.equal(f.calls.length, 0); assert.notEqual(report.result, 'entry_import_requested'); };

test('independent canonical pin permits reordered pretty manifest and fixed single fake entry', async t => {
  const f = await fixture(t), m = f.manifest;
  await fs.writeFile(f.options.manifestPath, JSON.stringify({ ws: { ...m.ws, files: [...m.ws.files].reverse() }, files: [...m.files].reverse(), sourceRevision: m.sourceRevision, algorithm: m.algorithm, schema: m.schema, profile: m.profile }, null, 4));
  const r = await f.run(); assert.equal(r.result, 'entry_import_requested'); assert.deepEqual(f.calls, [pathToFileURL(join(f.root, 'apps/relay/dist/index.js')).href]);
  assert.equal(r.serviceHealth, 'unverified'); assert.equal(r.processAttested, false); assert.equal(r.evidenceTiming, 'point-in-time');
});
test('independent lone CR is not the permitted optional LF pin', async t => {
  const f = await fixture(t); await fs.writeFile(f.options.pinPath, pin(f.manifest) + '\r');
  const r = await f.run(); assert.equal(r.result, 'pin_invalid'); rejected(f, r);
});
test('independent malformed pin bytes never reach importer', async t => {
  const f = await fixture(t);
  for (const bytes of [pin(f.manifest).toUpperCase(), pin(f.manifest) + '\r\n', pin(f.manifest) + ' ', pin(f.manifest) + '\n\n', Buffer.from([0xff]), '', 'a'.repeat(63)]) {
    await fs.writeFile(f.options.pinPath, bytes); rejected(f, await f.run());
  }
});
test('independent malformed manifest shape/UTF8/oversize has zero import and no raw error', async t => {
  const f = await fixture(t);
  for (const bytes of ['null', '[]', '{"private":"raw secret"}', '{broken private data', Buffer.from([0xff]), Buffer.alloc(65537, 32)]) {
    await fs.writeFile(f.options.manifestPath, bytes); const r = await f.run(); rejected(f, r); assert.ok(!JSON.stringify(r).includes('private')); assert.ok(!JSON.stringify(r).includes(f.top));
  }
});
test('independent exact 64KiB manifest and 65-byte LF pin pass', async t => {
  const f = await fixture(t), json = JSON.stringify(f.manifest); await fs.writeFile(f.options.manifestPath, json + ' '.repeat(65536 - Buffer.byteLength(json))); await fs.writeFile(f.options.pinPath, pin(f.manifest) + '\n');
  assert.equal((await f.run()).result, 'entry_import_requested'); assert.equal(f.calls.length, 1);
});
test('independent candidate-generated recapture cannot replace frozen external pin', async t => {
  const f = await fixture(t); await write(f.root, 'packages/relay-connector/dist/routing.js', 'changed');
  rejected(f, await f.run()); const forged = await captureRelayManifest({ releaseRoot: f.root, sourceRevision: f.manifest.sourceRevision, wsPackageRoot: ws });
  await fs.writeFile(f.options.manifestPath, JSON.stringify(forged)); const r = await f.run(); assert.equal(r.result, 'trusted_manifest_digest_mismatch'); rejected(f, r);
});
test('independent pin and manifest inside release are hard refused', async t => {
  const f = await fixture(t); await write(f.root, 'manifest', JSON.stringify(f.manifest)); await write(f.root, 'pin', pin(f.manifest));
  for (const extra of [{ manifestPath: join(f.root, 'manifest') }, { pinPath: join(f.root, 'pin') }]) { const r = await f.run(extra); assert.equal(r.result, 'trusted_source_inside_release'); rejected(f, r); }
});
test('independent symlink file and ancestor aliases are no-follow refused', async t => {
  const f = await fixture(t); await fs.symlink(f.external, join(f.top, 'alias')); await fs.symlink(f.options.pinPath, join(f.external, 'pin-alias'));
  for (const extra of [{ manifestPath: join(f.top, 'alias', 'manifest.json') }, { pinPath: join(f.external, 'pin-alias') }]) { const r = await f.run(extra); assert.equal(r.result, 'path_unsafe'); rejected(f, r); }
});
test('independent controlled tool root inside candidate refuses before any file access', async t => {
  const f = await fixture(t), root = dirname(dirname(fileURLToPath(import.meta.url)));
  const r = await f.run({ releaseRoot: root, fsApi: { lstat() { throw new Error('must not access repository root'); } } }); assert.equal(r.result, 'trusted_source_inside_release'); rejected(f, r);
});
test('independent directory masquerading as external pin is refused', async t => {
  const f = await fixture(t); const r = await f.run({ pinPath: f.external }); assert.equal(r.result, 'path_unsafe'); rejected(f, r);
});
test('independent final tool identity drift prevents importer', async t => {
  const f = await fixture(t), target = fileURLToPath(new URL('./relay-verified-start.mjs', import.meta.url)); let count = 0;
  const fsApi = { ...fs, lstat: async path => { const stat = await fs.lstat(path); if (path === target && ++count > 1) return new Proxy(stat, { get(obj, key) { if (key === 'ino') return obj.ino + 1; const value = obj[key]; return typeof value === 'function' ? value.bind(obj) : value; } }); return stat; } };
  const r = await f.run({ fsApi }); assert.equal(r.result, 'identity_changed'); rejected(f, r);
});
test('independent importer primitive failure is fixed and never implies health', async t => {
  const f = await fixture(t); let count = 0; const r = await f.run({ importer: async () => { count++; throw 'private path/config'; } });
  assert.equal(count, 1); assert.equal(r.result, 'entry_import_failed'); assert.equal(r.entryDispatched, true); assert.equal(r.serviceHealth, 'unverified'); assert.equal(r.cause, undefined); assert.ok(!JSON.stringify(r).includes('private path'));
});
test('independent CLI parser rejects missing duplicate extras wrong shape and entry override without executing CLI', () => {
  const good = ['--manifest-pin', '/private/pin', '--manifest', '/private/manifest', '--release-root', '/private/release']; assert.equal(parseStartupArguments(good).releaseRoot, '/private/release');
  for (const args of [undefined, null, {}, [], good.slice(2), [...good, '--entry', '/private/entry'], [...good.slice(0, 4), '--manifest', '/private/release'], ['--importer', '/private/pin', ...good.slice(2)], ['--release-root', '/', ...good.slice(0, 4)], ['--release-root', '/private/x/../release', ...good.slice(0, 4)], ['--release-root', 1, ...good.slice(0, 4)]]) assert.throws(() => parseStartupArguments(args), error => error.message === 'arguments_invalid');
});
