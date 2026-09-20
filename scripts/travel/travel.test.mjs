import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  expandTasks,
  parseAnchorDate,
  parseCliArgs,
  prepareTask,
  readManifest,
  renderGoal,
  validateManifest,
} from "./travel.mjs";

test("manifest expands to stable T01..T20 without answer constants", async () => {
  const loaded = await readManifest();
  const validation = validateManifest(loaded.value);
  const tasks = expandTasks(loaded.value);
  assert.equal(validation.familyCount, 10);
  assert.equal(validation.variantCount, 20);
  assert.equal(tasks.length, 20);
  assert.equal(tasks[0].taskId, "T01");
  assert.equal(tasks[11].taskId, "T12");
  assert.equal(tasks[12].taskId, "T13");
  assert.equal(tasks[19].taskId, "T20");
  assert.equal(tasks.filter((task) => task.split === "development").length, 12);
  assert.equal(tasks.filter((task) => task.split === "heldout").length, 8);
  assert.ok(loaded.contentSha256.length === 64);
});

test("anchor date is strict and uses UTC calendar arithmetic", () => {
  assert.equal(parseAnchorDate("2026-09-20"), "2026-09-20");
  assert.throws(() => parseAnchorDate("2026-02-29"), /valid Shanghai calendar date/u);
  assert.throws(() => parseAnchorDate("2026-9-20"), /YYYY-MM-DD/u);
  assert.throws(() => parseCliArgs(["prepare", "--task", "../escape", "--anchor-date", "2026-09-20"]), /T01 through T20/u);
});

test("prepare creates a unique, non-executed trial with fixed exposure and UTF-8 artifacts", async () => {
  const loaded = await readManifest();
  const root = await mkdtemp(join(tmpdir(), "travel-prepare-"));
  try {
    const first = await prepareTask({ manifest: loaded.value, taskId: "T01", anchorDate: "2026-09-20", outputRoot: root, manifestContentSha256: loaded.contentSha256, codeCommit: "abcdef1234567", workingTreeDirty: false });
    const second = await prepareTask({ manifest: loaded.value, taskId: "T01", anchorDate: "2026-09-20", outputRoot: root, manifestContentSha256: loaded.contentSha256, codeCommit: "abcdef1234567", workingTreeDirty: false });
    assert.notEqual(first.trialId, second.trialId);
    const trial = JSON.parse(await readFile(join(first.trialDirectory, "trial.json"), "utf8"));
    const goal = await readFile(join(first.trialDirectory, "goal.txt"), "utf8");
    const review = await readFile(join(first.trialDirectory, "manual-review.md"), "utf8");
    assert.equal(trial.execution.status, "not_executed");
    assert.equal(trial.execution.apiCalled, false);
    assert.equal(trial.manualScoring.status, "missing_not_pass");
    assert.equal(trial.dates.travelDate, "2026-09-23");
    assert.equal(trial.manifestContentSha256, loaded.contentSha256);
    assert.match(trial.codeCommit, /^[0-9a-f]{7,64}$/iu);
    assert.equal(typeof trial.workingTreeDirty, "boolean");
    assert.deepEqual(trial.launcher.presetOptions, { planning: true, memory: "entities", memoryRetrieval: "lexical", batching: "same-control-input-v1", contextMode: "recent", monitor: "guidance" });
    assert.equal(trial.launcher.maxModelRequests, 100);
    assert.match(goal, /不预订/u);
    assert.match(review, /实际入口/u);
    assert.match(review, /Batch/u);
    assert.ok(!goal.includes("\ufffd") && !review.includes("\ufffd"));
    assert.equal((await readdir(root)).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("heldout preparation requires explicit exposure and records it", async () => {
  const loaded = await readManifest();
  const root = await mkdtemp(join(tmpdir(), "travel-heldout-"));
  try {
    await assert.rejects(
      prepareTask({ manifest: loaded.value, taskId: "T13", anchorDate: "2026-09-20", outputRoot: root }),
      /heldout tasks require --allow-heldout/u,
    );
    const prepared = await prepareTask({ manifest: loaded.value, taskId: "T13", anchorDate: "2026-09-20", allowHeldout: true, outputRoot: root });
    assert.equal(prepared.exposed, true);
    assert.equal(prepared.exposureMarker, "heldout_explicit");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("goal rendering keeps map date metadata without requiring an unused placeholder", async () => {
  const loaded = await readManifest();
  const task = expandTasks(loaded.value).find((candidate) => candidate.taskId === "T11");
  assert.ok(task);
  const goal = renderGoal(task, "2026-09-20");
  assert.match(goal, /人民广场/u);
  assert.match(goal, /不预订/u);
});
