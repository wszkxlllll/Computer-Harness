import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { collectSession, parseCliArgs, watchSession } from "./tui-collector.mjs";

function at(second) {
  return `2026-02-01T00:00:${String(second).padStart(2, "0")}.000Z`;
}

function event(runId, type, sequence, fields = {}) {
  return { type, runId, eventId: `${runId}-event-${sequence}`, sequence, occurredAt: at(sequence), ...fields };
}

function trajectory(runId, goal, outcome, finalText) {
  return [
    event(runId, "run.created", 0, { goal }),
    event(runId, "run.started", 1),
    event(runId, "model.request.started", 2, { requestId: `${runId}-request` }),
    event(runId, "model.response.received", 3, { requestId: `${runId}-request`, turn: { type: "finish", summary: finalText ?? "", reportedStatus: outcome === "succeeded" ? "success" : "failure", usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } } }),
    event(runId, "run.finished", 4, { outcome, summary: finalText }),
  ].map((item) => JSON.stringify(item)).join("\n") + "\n";
}

async function makeSession(root) {
  const sessionDirectory = join(root, "tui-session");
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(join(sessionDirectory, "session.json"), JSON.stringify({ schemaVersion: 1, kind: "travel_tui_session", sessionId: "session-1", preset: "baseline" }) + "\n", "utf8");
  return sessionDirectory;
}

async function makeRun(sessionDirectory, name, { runId, goal, outcome = "succeeded", finalText, summary = {}, includeSummary = true, manual } = {}) {
  const runDirectory = join(sessionDirectory, name);
  await mkdir(runDirectory, { recursive: true });
  if (includeSummary) {
    await writeFile(join(runDirectory, "summary.json"), `${JSON.stringify({ runId, runtimeOutcome: outcome, modelReportedStatus: outcome === "succeeded" ? "success" : "failure", goal, modelSummary: finalText, ...summary })}\n`, "utf8");
  }
  await writeFile(join(runDirectory, "trajectory.jsonl"), trajectory(runId, goal, outcome, finalText), "utf8");
  if (manual !== undefined) await writeFile(join(runDirectory, "manual-review.md"), manual, "utf8");
  return runDirectory;
}

test("collects two direct-artifact runs independently and uses actual summary config", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "travel-tui-collector-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sessionDirectory = await makeSession(root);
  const first = await makeRun(sessionDirectory, "run-first-id", {
    runId: "run-first-id",
    goal: "goal one",
    finalText: "raw final one",
    summary: { memory: "facts", monitor: "shadow", maxSteps: 7, maxModelRequests: 8, computerTarget: { mode: "window", pid: 1234, windowId: 5678 } },
    manual: "human first review\n",
  });
  const second = await makeRun(sessionDirectory, "run-second-id", {
    runId: "run-second-id",
    goal: "goal two",
    outcome: "failed",
    finalText: "terminal fallback",
    summary: { memory: "entities", monitor: "guidance", maxSteps: 9, maxModelRequests: 10, modelSummary: "" },
  });
  const collection = await collectSession(sessionDirectory, { root });
  assert.equal(collection.runs.length, 2);
  assert.equal(collection.runs[0].runId, "run-first-id");
  assert.equal(collection.runs[1].runId, "run-second-id");

  const firstMetadata = JSON.parse(await readFile(join(first, "run-metadata.json"), "utf8"));
  const secondMetadata = JSON.parse(await readFile(join(second, "run-metadata.json"), "utf8"));
  assert.equal(firstMetadata.taskId, "unassigned");
  assert.equal(firstMetadata.goal, "goal one");
  assert.equal(firstMetadata.goalSource, "summary.goal");
  assert.equal(firstMetadata.config.memory, "facts");
  assert.equal(firstMetadata.config.monitor, "shadow");
  assert.equal(firstMetadata.config.maxSteps, 7);
  assert.deepEqual(firstMetadata.config.computerTarget, { mode: "window", pid: 1234, windowId: 5678 });
  assert.equal(secondMetadata.goal, "goal two");
  assert.equal(secondMetadata.config.memory, "entities");
  assert.equal(secondMetadata.config.monitor, "guidance");
  assert.equal(firstMetadata.config.memory === "baseline", false);
  assert.equal(await readFile(join(first, "manual-review.md"), "utf8"), "human first review\n");
  assert.equal((await readFile(join(first, "report.md"), "utf8")).includes("raw final one"), true);
  assert.equal((await readFile(join(second, "report.md"), "utf8")).includes("terminal fallback"), true);
  assert.equal(await readFile(join(first, "metrics.json"), "utf8").then((text) => text.includes("runtime/")), false);
  assert.equal(await readFile(join(first, "summary.json"), "utf8").then((text) => text.includes("modelSummary")), true);
});

test("updates a run after summary appears without overwriting manual review", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "travel-tui-update-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sessionDirectory = await makeSession(root);
  const runDirectory = await makeRun(sessionDirectory, "run-late-id", {
    runId: "run-late-id",
    goal: "late goal",
    includeSummary: false,
    manual: "human-edited review\n",
  });
  const first = await collectSession(sessionDirectory, { root });
  assert.equal(first.runs[0].dataQuality.status, "partial");
  assert.equal((await readFile(join(runDirectory, "report.md"), "utf8")).includes("未产生最终回复"), true);
  await writeFile(join(runDirectory, "summary.json"), `${JSON.stringify({ runId: "run-late-id", runtimeOutcome: "succeeded", modelReportedStatus: "success", goal: "late goal", memory: "facts", modelSummary: "late raw reply" })}\n`, "utf8");
  const second = await collectSession(sessionDirectory, { root });
  assert.equal(second.runs[0].dataQuality.status, "complete");
  const metadata = JSON.parse(await readFile(join(runDirectory, "run-metadata.json"), "utf8"));
  assert.equal(metadata.config.memory, "facts");
  assert.equal(await readFile(join(runDirectory, "manual-review.md"), "utf8"), "human-edited review\n");
  assert.equal((await readFile(join(runDirectory, "report.md"), "utf8")).includes("late raw reply"), true);
  await writeFile(join(runDirectory, "trajectory.jsonl"), trajectory("wrong-id", "copied goal", "succeeded", "copied raw"), "utf8");
  await collectSession(sessionDirectory, { root });
  const replacedReport = await readFile(join(runDirectory, "report.md"), "utf8");
  assert.equal(replacedReport.includes("数据冲突，未导出原始回复。"), true);
  assert.equal(replacedReport.includes("late raw reply"), false);
  assert.equal(await readFile(join(runDirectory, "manual-review.md"), "utf8"), "human-edited review\n");
});

test("marks missing summary and conflicting IDs without mixing raw reports", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "travel-tui-quality-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sessionDirectory = await makeSession(root);
  const missing = await makeRun(sessionDirectory, "run-missing-id", { runId: "run-missing-id", goal: "missing summary", includeSummary: false });
  const conflict = await makeRun(sessionDirectory, "run-conflict-dir", {
    runId: "event-id",
    goal: "conflict goal",
    finalText: "must not mix",
    summary: { runId: "summary-id" },
  });
  const collection = await collectSession(sessionDirectory, { root });
  assert.equal(collection.dataQuality.status, "partial");
  const missingMetrics = JSON.parse(await readFile(join(missing, "metrics.json"), "utf8"));
  assert.equal(missingMetrics.dataQuality.status, "partial");
  assert.equal((await readFile(join(missing, "metrics.json"), "utf8")).includes("runtime/"), false);
  assert.equal((await readFile(join(missing, "report.md"), "utf8")).includes("未产生最终回复"), true);
  const conflictMetrics = JSON.parse(await readFile(join(conflict, "metrics.json"), "utf8"));
  assert.equal(conflictMetrics.runId, null);
  assert.equal(conflictMetrics.base.requests, null);
  assert.equal(conflictMetrics.dataQuality.runIds.includes("run-conflict-dir"), true);
  const conflictReport = await readFile(join(conflict, "report.md"), "utf8");
  assert.equal(conflictReport.includes("数据冲突，未导出原始回复。"), true);
  assert.equal(conflictReport.includes("must not mix"), false);
});

test("watch creates and removes ready marker, then performs final collection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "travel-tui-watch-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sessionDirectory = await makeSession(root);
  const runDirectory = await makeRun(sessionDirectory, "run-watch-id", { runId: "run-watch-id", goal: "watch goal", finalText: "watch reply" });
  const stopFile = join(sessionDirectory, "stop-now");
  const readyFile = join(sessionDirectory, "ready-now");
  await writeFile(stopFile, "stop\n", "utf8");
  const result = await watchSession(sessionDirectory, { root, stopFile, readyFile, intervalMs: 1000 });
  assert.equal(result.runs[0].runId, "run-watch-id");
  assert.equal(await readFile(join(runDirectory, "metrics.json")).then(() => true), true);
  await assert.rejects(() => readFile(readyFile), { code: "ENOENT" });
});

test("CLI exposes collect/watch and accepts wrapper no-stdin compatibility", () => {
  assert.equal(parseCliArgs(["collect", "--session-dir", "tui-x"]).command, "collect");
  assert.equal(parseCliArgs(["watch", "--session-dir", "tui-x", "--no-stdin"]).command, "watch");
  assert.equal(parseCliArgs(["--finalize", "--session-dir", "tui-x"]).command, "collect");
  assert.equal(parseCliArgs(["--watch", "--session-dir", "tui-x"]).command, "watch");
});
