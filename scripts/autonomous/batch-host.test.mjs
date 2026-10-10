import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const entrypoint = resolve(repositoryRoot, "scripts/autonomous/batch-host.mjs");

test("batch-host refuses an entry outside its fixed host/cli allowlist", () => {
  const result = spawnSync(process.execPath, [
    entrypoint,
    "--batch-root", resolve(repositoryRoot, "runs/unused-private-test"),
    "--batch-id", "offline-test",
    "--reservation-id", "offline-test",
    "--entry", "arbitrary",
    "--", "--goal", "must never be dispatched",
  ], { cwd: repositoryRoot, encoding: "utf8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ENTRY_REFUSED/u);
  assert.doesNotMatch(result.stdout, /must never be dispatched/u);
});
