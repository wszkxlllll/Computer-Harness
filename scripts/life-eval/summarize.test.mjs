import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SIX_DOMAIN_SUITE_ID } from "./common.mjs";
import { summarizeLifeEvalPackage } from "./summarize.mjs";

const runId = "run-fixture-001";
const attemptId = "live-fixture-001";

function fixtureEvents() {
  return [
    { type: "run.started", sequence: 0, runId, occurredAt: "2026-10-18T02:00:00.000Z" },
    { type: "model.request.started", sequence: 1, runId, requestId: "request-1", occurredAt: "2026-10-18T02:00:01.000Z" },
    { type: "tool.call.received", sequence: 2, runId, call: { id: "plan-call", name: "task_create", arguments: { privateText: "PRIVATE_EVENT_SENTINEL" } } },
    { type: "planning.task.updated", sequence: 3, runId, callId: "plan-call", mutation: { operation: "created", task: { id: "plan-task-1" } } },
    { type: "tool.call.completed", sequence: 4, runId, result: { callId: "plan-call", status: "completed" } },
    { type: "tool.call.received", sequence: 5, runId, call: { id: "memory-call", name: "memory_write_fact", arguments: { privateText: "PRIVATE_EVENT_SENTINEL" } } },
    { type: "memory.updated", sequence: 6, runId, callId: "memory-call", mutation: { operation: "upsert_fact", fact: { id: "fact-1" } } },
    { type: "tool.call.completed", sequence: 7, runId, result: { callId: "memory-call", status: "completed" } },
    { type: "monitor.proposal", sequence: 8, runId, mode: "guidance", proposal: "candidate", reasonCodes: ["repeat"], guidanceText: "PRIVATE_MONITOR_SENTINEL" },
    { type: "monitor.transition", sequence: 9, runId, transition: "unchanged" },
    { type: "model.response.received", sequence: 10, runId, requestId: "request-1", occurredAt: "2026-10-18T02:00:02.000Z", turn: { usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16, cacheReadTokens: 2 } } },
    { type: "run.finished", sequence: 11, runId, occurredAt: "2026-10-18T02:00:03.000Z", outcome: "succeeded" },
  ];
}

async function writeFixture(root, { withRootSummary = true, rootSummaryRunId = runId, nestedSummary = false, withReceipts = true, providerExchangeText } = {}) {
  const packageId = "G01-C-20261019-fixture001";
  const packageDir = join(root, "runs", SIX_DOMAIN_SUITE_ID, packageId);
  const attemptDir = join(packageDir, "attempts", attemptId);
  const outputBase = join(packageDir, "runtime-output");
  const runtimeDir = join(outputBase, runId);
  await mkdir(attemptDir, { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  const plan = {
    schemaVersion: 1,
    suiteId: SIX_DOMAIN_SUITE_ID,
    packageId,
    packageDir,
    task: { id: "G01", goal: "DO_NOT_OUTPUT_PRIVATE_GOAL_SENTINEL" },
    selection: { variant: "C" },
    configuration: { monitor: "guidance", supervision: { mode: "dynamic", policyVersion: "evidence-triggered-no-scripted-corrections-v1" } },
    cli: { argvTemplate: ["--output", outputBase] },
  };
  const liveAttempt = {
    schemaVersion: 1,
    packageId,
    task: "G01",
    variant: "C",
    stdoutLog: join(attemptDir, "stdout.log"),
    supervision: { mode: "dynamic", attemptId, receiptFile: "supervision-receipts.jsonl" },
    final: { supervision: { mode: "dynamic", runId } },
  };
  await writeFile(join(packageDir, "plan.json"), `${JSON.stringify(plan)}\n`, "utf8");
  await writeFile(join(packageDir, "live-attempt.json"), `${JSON.stringify(liveAttempt)}\n`, "utf8");
  await writeFile(join(attemptDir, "stdout.log"), "fixture-only\n", "utf8");
  await writeFile(join(runtimeDir, "trajectory.jsonl"), `${fixtureEvents().map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  if (providerExchangeText !== undefined) await writeFile(join(runtimeDir, "provider-exchanges.jsonl"), providerExchangeText, "utf8");
  if (nestedSummary) {
    const summary = { runId, runtimeOutcome: "succeeded", modelUsage: { inputTokens: 12, outputTokens: 4, totalTokens: 16, cacheReadTokens: 2 }, trajectory: join(runtimeDir, "trajectory.jsonl"), goal: "PRIVATE_SUMMARY_SENTINEL" };
    await writeFile(join(runtimeDir, "summary.json"), `${JSON.stringify(summary)}\n`, "utf8");
  }
  if (withRootSummary) {
    const summary = { runId: rootSummaryRunId, runtimeOutcome: "succeeded", modelUsage: { inputTokens: 12, outputTokens: 4, totalTokens: 16, cacheReadTokens: 2 }, trajectory: join(runtimeDir, "trajectory.jsonl"), goal: "PRIVATE_STALE_SUMMARY_SENTINEL" };
    await writeFile(join(outputBase, "summary.json"), `${JSON.stringify(summary)}\n`, "utf8");
  }
  if (withReceipts) {
    const receipts = [
      { schemaVersion: 1, packageId, attemptId, runId, commandId: "command-1", command: "correct", status: "queued", reason: "PRIVATE_CORRECTION_SENTINEL", at: "2026-10-18T02:00:01.000Z" },
      { schemaVersion: 1, packageId, attemptId, runId, commandId: "command-1", command: "correct", status: "consumed", reason: "PRIVATE_CORRECTION_SENTINEL", at: "2026-10-18T02:00:02.000Z" },
      { schemaVersion: 1, packageId, attemptId, runId, commandId: "command-2", command: "correct", status: "queued", reason: "PRIVATE_CORRECTION_SENTINEL", at: "2026-10-18T02:00:02.100Z" },
      { schemaVersion: 1, packageId, attemptId, runId, commandId: "command-2", command: "correct", status: "failed", reason: "PRIVATE_CORRECTION_SENTINEL", at: "2026-10-18T02:00:02.200Z" },
      { schemaVersion: 1, packageId, attemptId, runId, commandId: "command-3", command: "cancel", status: "rejected", reason: "PRIVATE_CANCEL_SENTINEL", at: "2026-10-18T02:00:02.300Z" },
      { schemaVersion: 1, packageId, attemptId, runId, commandId: "command-4", command: "cancel", status: "cancel-requested", reason: "PRIVATE_CANCEL_SENTINEL", at: "2026-10-18T02:00:03.000Z" },
    ];
    await writeFile(join(attemptDir, "supervision-receipts.jsonl"), `${receipts.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  }
  return { packageDir, outputBase, runtimeDir, attemptDir };
}

test("summarizer reuses travel event aggregation and reports assistance without scoring business success", async () => {
  const root = await mkdtemp(join(tmpdir(), "life-eval-summarize-test-"));
  try {
    const fixture = await writeFixture(root);
    const result = await summarizeLifeEvalPackage(fixture.packageDir, attemptId, { root, now: () => new Date("2026-10-18T03:00:00.000Z") });
    const { report } = result;
    assert.equal(result.outputPath, join(fixture.packageDir, "analysis", attemptId, "metrics-report.json"));
    assert.equal(report.summarySelection.selectedPath, "runtime-output/summary.json");
    assert.equal(report.eventRunIdStatus, "matched");
    assert.equal(report.runtimeOutcome, "succeeded");
    assert.equal(report.businessReview.status, "unknown_not_scored");
    assert.equal(report.businessReview.score, null);
    assert.equal(report.trialMetadata.suppliedToTravelMetrics, false);
    assert.equal(report.metrics.trial, null);
    assert.equal(report.metricsDataQuality.status, "partial");
    assert.equal(report.metricsDataQuality.errors.some((item) => item.code === "invalid_trial"), true);
    assert.equal(report.moduleMetrics.planning.calls, 1);
    assert.equal(report.moduleMetrics.planning.updates, 1);
    assert.equal(report.moduleMetrics.memory.calls, 1);
    assert.equal(report.moduleMetrics.memory.updates, 1);
    assert.equal(report.moduleMetrics.monitor.candidates, 1);
    assert.equal(report.metrics.base.requests.started, 1);
    assert.equal(report.providerApiUsage.status, "missing");
    assert.equal(report.providerApiUsage.source, "unavailable");
    assert.equal(report.providerApiUsage.fallback.source, "Runtime successful-turn usage; excludes rejected/transport-failed API responses");
    assert.equal(report.turnUsage.totalTokens, 16);
    assert.equal(report.sources.providerExchanges, null);
    assert.equal(report.assistance.receiptEvidenceStatus, "complete", JSON.stringify(report.assistance));
    assert.equal(report.assistance.correctionsConsumed, 1);
    assert.equal(report.assistance.cancellations, 1);
    assert.equal(report.assistance.rawReceiptCount, 6);
    assert.equal(report.assistance.uniqueCommandCount, 4);
    assert.equal(report.assistance.commandReceiptCounts.correct.consumed, 1);
    assert.equal(report.assistance.commandReceiptCounts.correct.failed, 1);
    assert.equal(report.assistance.commandReceiptCounts.cancel.rejected, 1);
    assert.equal(report.assistance.commandReceiptCounts.cancel["cancel-requested"], 1);
    assert.equal(report.assistance.rawReceiptStatusCounts.queued, 2);
    assert.equal(report.assistance.classification, "assisted_after_consumed_correction");
    const text = await readFile(result.outputPath, "utf8");
    for (const sentinel of ["DO_NOT_OUTPUT_PRIVATE_GOAL_SENTINEL", "PRIVATE_EVENT_SENTINEL", "PRIVATE_MONITOR_SENTINEL", "PRIVATE_SUMMARY_SENTINEL", "PRIVATE_STALE_SUMMARY_SENTINEL", "PRIVATE_CORRECTION_SENTINEL", "PRIVATE_CANCEL_SENTINEL"]) {
      assert.equal(text.includes(sentinel), false);
    }
    const firstWrite = await readFile(result.outputPath, "utf8");
    await assert.rejects(summarizeLifeEvalPackage(fixture.packageDir, attemptId, { root }), { code: "EEXIST" });
    assert.equal(await readFile(result.outputPath, "utf8"), firstWrite);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("life-eval exposes provider-call usage and writes reanalysis under a fresh ID without replacing the prior report", async () => {
  const root = await mkdtemp(join(tmpdir(), "life-eval-summarize-api-usage-test-"));
  try {
    const exchanges = [
      {
        provider: "deepseek", request: 1, runId, decisionId: "one-decision", attempt: 1, latencyMs: 900,
        requestText: "PRIVATE_PROVIDER_REQUEST_SENTINEL",
        response: { diagnosticCodes: ["structured_invalid_json"], usage: { promptTokens: 7, completionTokens: 2, totalTokens: 9, cachedReadTokens: 4 } },
      },
      {
        provider: "deepseek", request: 2, runId, decisionId: "one-decision", attempt: 2, latencyMs: 500,
        response: { usage: { promptTokens: 8, completionTokens: 3, totalTokens: 11, cachedReadTokens: 5 } },
      },
    ];
    const fixture = await writeFixture(root, { providerExchangeText: `${exchanges.map((item) => JSON.stringify(item)).join("\n")}\n` });
    const first = await summarizeLifeEvalPackage(fixture.packageDir, attemptId, { root });
    assert.equal(first.report.providerApiUsage.status, "complete");
    assert.equal(first.report.providerApiUsage.calls.observed, 2);
    assert.equal(first.report.providerApiUsage.retryRecords, 1);
    assert.equal(first.report.providerApiUsage.totals.totalTokens, 20);
    assert.equal(first.report.providerApiUsage.totals.cacheReadTokens, 9);
    assert.equal(first.report.providerApiUsage.latency.totalMs, 1400);
    assert.equal(first.report.sources.providerExchanges, `runtime-output/${runId}/provider-exchanges.jsonl`);
    assert.equal(first.report.metrics.turnUsage.totalTokens, 16);
    assert.equal(first.report.attemptId, attemptId);
    assert.equal(first.report.analysisId, attemptId);
    const firstText = await readFile(first.outputPath, "utf8");
    assert.equal(firstText.includes("PRIVATE_PROVIDER_REQUEST_SENTINEL"), false);

    const reanalysisId = "live-fixture-001-metrics-v2";
    const second = await summarizeLifeEvalPackage(fixture.packageDir, attemptId, { root, analysisId: reanalysisId });
    assert.equal(second.outputPath, join(fixture.packageDir, "analysis", reanalysisId, "metrics-report.json"));
    assert.equal(second.report.attemptId, attemptId);
    assert.equal(second.report.analysisId, reanalysisId);
    assert.equal(second.report.providerApiUsage.calls.observed, 2, "one parsed line is counted once; same decision ID does not merge real calls");
    assert.equal(await readFile(first.outputPath, "utf8"), firstText, "previous analysis report remains unchanged");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assistance classification uses each command's last receipt and does not count rejected cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "life-eval-summarize-receipt-lifecycle-test-"));
  try {
    const fixture = await writeFixture(root);
    const recordPath = join(fixture.packageDir, "live-attempt.json");
    const liveAttempt = JSON.parse(await readFile(recordPath, "utf8"));
    const receipts = [
      { packageId: liveAttempt.packageId, attemptId, runId, commandId: "correction-1", command: "correct", status: "queued" },
      { packageId: liveAttempt.packageId, attemptId, runId, commandId: "correction-1", command: "correct", status: "failed" },
      { packageId: liveAttempt.packageId, attemptId, runId, commandId: "cancel-1", command: "cancel", status: "rejected" },
    ];
    await writeFile(join(fixture.attemptDir, "supervision-receipts.jsonl"), `${receipts.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
    const result = await summarizeLifeEvalPackage(fixture.packageDir, attemptId, { root });
    assert.equal(result.report.assistance.rawReceiptCount, 3);
    assert.equal(result.report.assistance.uniqueCommandCount, 2);
    assert.equal(result.report.assistance.correctionsConsumed, 0);
    assert.equal(result.report.assistance.cancellations, 0);
    assert.deepEqual(result.report.assistance.commandReceiptCounts.correct, { failed: 1 });
    assert.deepEqual(result.report.assistance.commandReceiptCounts.cancel, { rejected: 1 });
    assert.equal(result.report.assistance.classification, "no_correction_consumed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("summarizer rejects a stale output-root summary and leaves business and assistance unknown", async () => {
  const root = await mkdtemp(join(tmpdir(), "life-eval-summarize-mismatch-test-"));
  try {
    const fixture = await writeFixture(root, { rootSummaryRunId: "other-run-999", withReceipts: false });
    const result = await summarizeLifeEvalPackage(fixture.packageDir, attemptId, { root });
    assert.equal(result.report.summarySelection.selectedPath, null);
    assert.equal(result.report.summarySelection.outputRootCandidateStatus, "run_id_mismatch");
    assert.equal(result.report.metrics.runtimeOutcome, "succeeded", "Runtime outcome comes from the matching trajectory event only");
    assert.equal(result.report.metricsDataQuality.runIds.includes("other-run-999"), false);
    assert.equal(result.report.metricsDataQuality.errors.some((item) => item.code === "summary_run_id_mismatch"), true);
    assert.equal(result.report.businessReview.status, "unknown_not_scored");
    assert.equal(result.report.assistance.receiptEvidenceStatus, "missing");
    assert.equal(result.report.assistance.commandReceiptCounts, null);
    assert.equal(result.report.assistance.classification, "unknown_receipt_evidence_incomplete");
    const text = await readFile(result.outputPath, "utf8");
    assert.equal(text.includes("other-run-999"), false);
    assert.equal(text.includes("PRIVATE_STALE_SUMMARY_SENTINEL"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("summarizer prefers a matching Run-directory summary over a mismatched output-root summary", async () => {
  const root = await mkdtemp(join(tmpdir(), "life-eval-summarize-nested-summary-test-"));
  try {
    const fixture = await writeFixture(root, { rootSummaryRunId: "other-run-999", nestedSummary: true });
    const result = await summarizeLifeEvalPackage(fixture.packageDir, attemptId, { root });
    assert.equal(result.report.summarySelection.selectedPath, `runtime-output/${runId}/summary.json`);
    assert.equal(result.report.summarySelection.nestedCandidateStatus, "matched_run_and_trajectory");
    assert.equal(result.report.summarySelection.outputRootCandidateStatus, "run_id_mismatch");
    assert.equal(result.report.metricsDataQuality.runIds.includes("other-run-999"), false);
    assert.equal(result.report.runtimeOutcome, "succeeded");
    const text = await readFile(result.outputPath, "utf8");
    assert.equal(text.includes("PRIVATE_SUMMARY_SENTINEL"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
