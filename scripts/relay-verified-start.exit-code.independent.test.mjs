import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const sourceUrl = new URL('./relay-verified-start.mjs', import.meta.url);
const sourcePath = fileURLToPath(sourceUrl);
const { parseStartupArguments, startupExitCode } = await import(sourceUrl);
async function runCliMapping(initialCode, duringImportCode) {
  const source = await fs.readFile(sourcePath, 'utf8');
  const block = source.slice(source.indexOf('if (process.argv[1]')).replaceAll('import.meta.url', JSON.stringify(pathToFileURL(sourcePath).href));
  const processFixture = { exitCode: initialCode, argv: ['node', sourcePath, '--release-root', '/private/synthetic-release', '--manifest', '/private/external-manifest', '--manifest-pin', '/private/external-pin'] };
  const logs = [];
  await vm.runInNewContext(`(async () => { ${block} })()`, {
    process: processFixture, pathToFileURL, resolve, parseStartupArguments, startupExitCode,
    console: { log(value) { logs.push(value); } },
    startVerifiedRelay: async () => { if (duringImportCode !== undefined) processFixture.exitCode = duringImportCode; return { result: 'entry_import_requested', entryDispatched: true }; },
  });
  return { code: processFixture.exitCode, logs };
}
test('CLI dispatch success must preserve pre-existing nonzero exit code', async () => {
  assert.equal((await runCliMapping(7)).code, 7);
});
test('CLI dispatch success must preserve candidate failure code set during fake import', async () => {
  assert.equal((await runCliMapping(undefined, 9)).code, 9);
});
