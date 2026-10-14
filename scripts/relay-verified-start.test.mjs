import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
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


import { startVerifiedRelay, parseStartupArguments, startupExitCode } from './relay-verified-start.mjs';
async function fixture(t) {
  const f = await release(t);
  const external = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'relay-start-trusted-')));
  t.after(() => fs.rm(external, { recursive: true, force: true }));
  const manifestPath = join(external, 'manifest.json'); const pinPath = join(external, 'manifest.pin');
  await fs.writeFile(manifestPath, JSON.stringify(f.manifest, null, 2));
  await fs.writeFile(pinPath, digest(f.manifest) + '\n');
  const options = { releaseRoot: f.root, manifestPath, pinPath };
  const calls = [];
  const importer = async url => { calls.push(url); };
  return { ...f, external, options, calls, importer, run: (extra = {}) => startVerifiedRelay({ ...options, importer, ...extra }) };
}
test('valid externally pinned release requests fixed entry once without service import', async t => {
  const f = await fixture(t); const report = await f.run();
  assert.equal(report.result, 'entry_import_requested'); assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].endsWith('/apps/relay/dist/index.js'));
  assert.equal(report.entryDispatched, true); assert.equal(report.serviceHealth, 'unverified');
  assert.equal(report.processAttested, false); assert.equal(report.evidenceTiming, 'point-in-time');
  assert.ok(!JSON.stringify(report).includes(f.root));
});
test('canonical pin accepts changed JSON formatting/key and entry order', async t => {
  const f = await fixture(t); const m = clone(f.manifest); m.files.reverse(); m.ws.files.reverse();
  await fs.writeFile(f.options.manifestPath, JSON.stringify({ ws: m.ws, files: m.files, sourceRevision: m.sourceRevision,
    algorithm: m.algorithm, profile: m.profile, schema: m.schema }, null, 4));
  await fs.writeFile(f.options.pinPath, digest(f.manifest));
  assert.equal((await f.run()).result, 'entry_import_requested'); assert.equal(f.calls.length, 1);
});
test('strict CLI parser requires all three unique flags and normalized explicit paths', () => {
  const good = ['--release-root','/private/release','--manifest','/private/manifest','--manifest-pin','/private/pin'];
  assert.deepEqual(parseStartupArguments(good), { releaseRoot: '/private/release', manifestPath: '/private/manifest', pinPath: '/private/pin' });
  for (const args of [[], good.slice(0, 4), [...good, '--entry','/other'], [...good.slice(0,4),'--manifest','/private/pin'],
    ['--release-root','relative',...good.slice(2)], ['--release-root','/private/../release',...good.slice(2)],
    ['--importer','/private/release',...good.slice(2)]]) assert.throws(() => parseStartupArguments(args), /arguments_invalid/);
});
test('pin rejects uppercase CRLF blank whitespace excess and malformed digests before import', async t => {
  const f = await fixture(t); const pin = digest(f.manifest);
  for (const value of [pin.toUpperCase(), pin+'\r\n', '', pin+' ', pin+'\n\n', '0'.repeat(63), 'g'.repeat(64)]) {
    await fs.writeFile(f.options.pinPath, value); assert.notEqual((await f.run()).result, 'entry_import_requested');
  }
  assert.equal(f.calls.length, 0);
});
test('missing or invalid or oversized external manifest never imports and never leaks bytes', async t => {
  const f = await fixture(t);
  for (const bytes of [Buffer.from([0xff]), Buffer.from('private invalid json'), Buffer.from('{}'), Buffer.alloc(65537, 0x20)]) {
    await fs.writeFile(f.options.manifestPath, bytes); const r = await f.run(); assert.equal(r.entryDispatched, false);
    assert.ok(!JSON.stringify(r).includes('private invalid json')); assert.ok(!JSON.stringify(r).includes(f.external));
  }
  await fs.unlink(f.options.manifestPath); assert.equal((await f.run()).result, 'startup_unavailable');
  assert.equal(f.calls.length, 0);
});
test('manifest or pin inside candidate is rejected regardless of valid bytes', async t => {
  const f = await fixture(t); await write(f.root, 'manifest.json', JSON.stringify(f.manifest));
  await write(f.root, 'pin', digest(f.manifest));
  assert.equal((await f.run({ manifestPath: join(f.root,'manifest.json') })).result, 'trusted_source_inside_release');
  assert.equal((await f.run({ pinPath: join(f.root,'pin') })).result, 'trusted_source_inside_release');
  assert.equal(f.calls.length, 0);
});
test('file or ancestor symlinks and candidate root symlinks are rejected', async t => {
  const f = await fixture(t); const linked = join(f.external, 'linked'); await fs.symlink(f.options.manifestPath, linked);
  assert.equal((await f.run({ manifestPath: linked })).result, 'path_unsafe');
  const ancestor = join(f.external, 'ancestor'); await fs.symlink(f.external, ancestor);
  assert.equal((await f.run({ manifestPath: join(ancestor,'manifest.json') })).result, 'path_unsafe');
  const rootlink = join(f.external,'release'); await fs.symlink(f.root, rootlink);
  assert.equal((await f.run({ releaseRoot: rootlink })).result, 'path_unsafe'); assert.equal(f.calls.length, 0);
});
test('F010 wrong pin and changed required byte both refuse with zero import', async t => {
  const f = await fixture(t); await fs.writeFile(f.options.pinPath,'0'.repeat(64));
  assert.equal((await f.run()).result, 'trusted_manifest_digest_mismatch');
  await fs.writeFile(f.options.pinPath,digest(f.manifest)); await write(f.root,'packages/voice/dist/index.js','changed');
  assert.equal((await f.run()).result,'runtime_bytes_mismatch'); assert.equal(f.calls.length,0);
});
test('final root and external-file identity changes fail before importer', async t => {
  for (const which of ['root','manifest','pin']) {
    const f = await fixture(t); const target = which === 'root' ? f.root : which === 'manifest' ? f.options.manifestPath : f.options.pinPath;
    let counts = 0; const api = { ...fs, lstat: async path => {
      const stat = await fs.lstat(path);
      if (path === target && ++counts >= (which === 'root' ? 2 : 3)) return new Proxy(stat, { get(obj,key) { if(key==='ino') return obj.ino+1; const value=obj[key]; return typeof value==='function' ? value.bind(obj) : value; } });
      return stat;
    }};
    assert.equal((await f.run({ fsApi: api })).result,'identity_changed'); assert.equal(f.calls.length,0);
  }
});
test('failed fake import yields only fixed failure and already-requested dispatch', async t => {
  const f = await fixture(t); const r = await f.run({ importer: async () => { throw new Error('private/config secret body'); } });
  assert.equal(r.result,'entry_import_failed'); assert.equal(r.entryDispatched,true); assert.equal(r.serviceHealth,'unverified');
  assert.ok(!JSON.stringify(r).includes('secret')); assert.equal(r.cause,undefined);
});
test('64KiB manifest boundary and 65-byte pin remain bounded and accepted', async t => {
  const f = await fixture(t); const json = JSON.stringify(f.manifest);
  await fs.writeFile(f.options.manifestPath, json + ' '.repeat(65536 - Buffer.byteLength(json)));
  assert.equal((await f.run()).result, 'entry_import_requested'); assert.equal(f.calls.length, 1);
});
test('candidate cannot enclose the controlled bootstrap or checker', async t => {
  const f = await fixture(t);
  const candidate = dirname(dirname(fileURLToPath(import.meta.url)));
  assert.equal((await f.run({ releaseRoot: candidate })).result, 'trusted_source_inside_release');
  assert.equal(f.calls.length, 0);
});
test('startup exit mapping preserves candidate exit status on import request', () => {
  for (const existing of [undefined, 0, 7, 9]) {
    assert.equal(startupExitCode('entry_import_requested', existing), existing);
  }
  for (const existing of [undefined, 0, 7]) {
    assert.equal(startupExitCode('entry_import_failed', existing), 1);
    assert.equal(startupExitCode('runtime_bytes_mismatch', existing), 1);
  }
});
