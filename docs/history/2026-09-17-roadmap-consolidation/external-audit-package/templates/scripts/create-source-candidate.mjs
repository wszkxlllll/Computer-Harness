#!/usr/bin/env node
/**
 * Build a traceable SOURCE delivery candidate from the checked-out commit.
 * No installation, publishing, model invocation, or desktop interaction occurs.
 * Run from the repository root after a successful clean build/test job.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
async function jsonFile(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function main() {
  const root = process.cwd();
  if (resolve(git(['rev-parse', '--show-toplevel'])) !== resolve(root)) {
    throw new Error('Run this command from the repository root.');
  }
  // Includes tracked modifications only. Untracked build outputs are never archived.
  if (git(['status', '--porcelain', '--untracked-files=no']).length > 0) {
    throw new Error('Refusing a candidate with tracked, uncommitted changes.');
  }
  const commit = git(['rev-parse', 'HEAD']);
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error('Unexpected Git commit format.');
  const rootPackage = await jsonFile(join(root, 'package.json'));
  const cuaPackage = await jsonFile(join(root, 'packages/computer-cua/package.json'));
  const lockfile = await readFile(join(root, 'pnpm-lock.yaml'));
  const output = join(root, 'release-assets');
  // Never overwrite an earlier candidate silently.
  await mkdir(output);
  const archive = join(output, 'source.tar.gz');
  execFileSync('git', [
    'archive', '--format=tar.gz', '--prefix=Computer-Harness/', `--output=${archive}`, commit,
  ], { stdio: 'inherit' });
  const sourceBytes = await readFile(archive);
  const manifest = {
    format: 'computer-harness-source-candidate-v1',
    kind: 'source-only',
    repository: process.env.GITHUB_REPOSITORY ?? null,
    commit,
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    configuredPackageManager: rootPackage.packageManager ?? null,
    configuredCuaDriver: cuaPackage.dependencies?.['@trycua/cua-driver'] ?? null,
    lockfileSha256: sha256(lockfile),
    sourceArchiveSha256: sha256(sourceBytes),
    workflowRunId: process.env.GITHUB_RUN_ID ?? null,
    workflowRunAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    caveats: [
      'This is not an executable distribution or an installer.',
      'Only Git-tracked source from the recorded commit is archived.',
      'This script records provenance; it does not certify test or security results.',
      'Review tracked source for sensitive content before distributing the artifact.',
    ],
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(join(output, 'manifest.json'), manifestText, { encoding: 'utf8', flag: 'wx' });
  await writeFile(join(output, 'SHA256SUMS'), [
    `${sha256(sourceBytes)}  source.tar.gz`,
    `${sha256(Buffer.from(manifestText))}  manifest.json`,
    '',
  ].join('\n'), { encoding: 'utf8', flag: 'wx' });
  process.stdout.write(`Source candidate written to ${output}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
