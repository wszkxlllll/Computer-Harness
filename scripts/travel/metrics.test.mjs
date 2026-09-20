import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { collectTrial } from "./metrics.mjs";

const runId = "travel-run-a";

function occurredAt(second) {
  return `2026-01-01T00:00:${String(second).padStart(2, "0")}.000Z`;
}

function event(type, sequence, fields = {}, id = `event-${sequence}`, at = sequence) {
  return { type, runId, eventId: id, occurredAt: occurredAt(at), sequence, ...fields };
}

function action(actionId, kind = "click") {
  return kind === "type"
    ? { actionId, kind, basedOn: "observation-1", text: "typed-secret" }
    : { actionId, kind, basedOn: "observation-1", point: { x: 10, y: 20 } };
}

function completeEvents() {
  return [
    event("run.created", 0, { goal: "private goal text" }),
    event("run.started", 1),
    event("observation.created", 2, {
      observation: {
        id: "observation-1",
        runId,
        computerSessionId: "session-1",
        capturedAt: occurredAt(2),
        viewport: { width: 100, height: 100, coordinateSpace: "physical" },
        screenshot: { assetId: "asset-1", relativePath: "screenshots/private.png", mediaType: "image/png", byteLength: 1 },
      },
    }),
    event("model.request.started", 3, {
      requestId: "request-1",
      contextBudget: {
        mode: "recent",
        estimatedInputTokens: 100,
        estimatedFixedTextTokens: 20,
        estimatedHistoryTextTokens: 30,
        estimatedToolSchemaTokens: 10,
        estimatedMemoryTokens: 8,
        estimatedMonitorGuidanceTokens: 4,
        imageCount: 1,
        selectedHistoryEvents: 1,
        omittedHistoryEvents: 1,
        monitorGuidanceIncluded: true,
        trace: {
          compilerVersion: "test",
          runId,
          stablePrefixHash: "prefix-a",
          fixedBlocks: [
            { name: "system", estimatedTokens: 4, included: true },
            { name: "goal", estimatedTokens: 4, included: true },
            { name: "tools", estimatedTokens: 4, included: true },
            { name: "plan", estimatedTokens: 4, included: true },
            { name: "memory", estimatedTokens: 4, included: true },
          ],
          selectedEventIds: ["event-0"],
          projectedEventIds: ["event-0"],
          discardedEvents: [{ eventId: "old-event", reason: "history_limit" }],
          authoritativeUserEventIds: ["user-event-1"],
          historyEstimatedTokens: 30,
          memoryEstimatedTokens: 8,
          memorySelection: {
            admittedFactIds: ["fact-admitted"],
            revalidationFactIds: ["fact-recheck"],
            selectedAdmittedFactIds: ["fact-admitted"],
            selectedRevalidationFactIds: ["fact-recheck"],
            omitted: [{ id: "fact-omitted", class: "admitted", reason: "budget" }],
            excluded: [{ kind: "fact", id: "fact-old", reason: "superseded" }],
          },
          memoryRetrieval: {
            method: "hybrid",
            semanticStatus: "unavailable",
            stateStable: true,
            embeddingBudgetUsed: 0,
            embeddingBudgetLimit: 1,
            admitted: [{ id: "fact-admitted", score: 1, match: "exact" }],
            revalidation: [{ id: "fact-recheck", score: 0.5, match: "lexical", reason: "needs_check" }],
          },
          observationIncluded: true,
          monitorGuidanceIncluded: true,
          preparedRequest: { payloadHash: "payload-hash", estimate: { estimatedTextTokens: 90, imageCount: 1, estimationMethod: "context_report" } },
        },
      },
    }),
    event("model.response.received", 4, {
      requestId: "request-1",
      turn: {
        type: "tool_calls",
        assistantText: "private response text",
        calls: [
          { id: "memory-call", name: "memory_write_fact", arguments: { key: "private", value: "secret" } },
          { id: "plan-call", name: "task_create", arguments: { subject: "private phase" } },
          { id: "gui-call-1", name: "click", arguments: { x: 10, y: 20 } },
        ],
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      },
    }),
    event("tool.call.received", 5, { call: { id: "memory-call", name: "memory_write_fact", arguments: { key: "private", value: "secret" } } }),
    event("tool.call.completed", 6, { result: { callId: "memory-call", status: "completed", output: { value: "secret" } } }),
    event("memory.updated", 7, { callId: "memory-call", source: "tool", mutation: { operation: "upsert_fact", fact: { id: "fact-admitted" } } }),
    event("tool.call.received", 8, { call: { id: "plan-call", name: "task_create", arguments: { subject: "private phase" } } }),
    event("planning.task.updated", 9, { callId: "plan-call", mutation: { operation: "created", task: { id: "task-1", subject: "private" } } }),
    event("action.proposed", 10, { callId: "gui-call-1", action: action("action-1") }),
    event("action.guard.evaluated", 11, {
      callIds: ["gui-call-1"],
      actions: [{ actionId: "action-1", kind: "click", basedOn: "observation-1", point: { x: 10, y: 20 } }],
      decision: "require_approval",
      categories: ["financial"],
      reasonCode: "approval_needed",
      reason: "private guard reason",
      path: "model",
      policyVersion: "test",
      modelRequestCount: 1,
      latencyMs: 4,
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    }),
    event("approval.requested", 12, { requestId: "approval-1", callId: "gui-call-1", reason: "private approval reason" }),
    event("approval.resolved", 13, { requestId: "approval-1", approved: true }),
    event("action.execution.started", 14, { action: action("action-1") }),
    event("action.execution.completed", 15, { receipt: { actionId: "action-1", status: "completed", message: "private receipt" } }),
    event("model.request.started", 16, { requestId: "request-2", contextBudget: { mode: "raw", estimatedInputTokens: 40, selectedHistoryEvents: 1, omittedHistoryEvents: 0, trace: { compilerVersion: "test", runId, stablePrefixHash: "prefix-b", fixedBlocks: [], selectedEventIds: [], discardedEvents: [], authoritativeUserEventIds: [], observationIncluded: false } } }),
    event("model.response.received", 17, {
      requestId: "request-2",
      turn: {
        type: "tool_calls",
        calls: [
          { id: "gui-call-2", name: "click", arguments: { x: 1, y: 1 } },
          { id: "gui-call-3", name: "type", arguments: { text: "typed-secret" } },
        ],
        usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50 },
      },
    }),
    event("action.proposed", 18, { callId: "gui-call-2", action: action("action-2") }),
    event("action.proposed", 19, { callId: "gui-call-3", action: action("action-3", "type") }),
    event("action.execution.started", 20, { action: action("action-2") }),
    event("action.execution.failed", 21, { receipt: { actionId: "action-2", status: "refused", message: "private refusal" } }),
    event("monitor.transition", 22, { actionId: "action-1", postObservationId: "observation-2", sourceActionEventId: "event-action", sourceObservationEventId: "event-observation", transition: "unchanged" }),
    event("monitor.proposal", 23, { mode: "guidance", proposal: "candidate", fingerprint: "fingerprint", sourceEventIds: [], reasonCodes: ["repeat"], evidenceKinds: ["action"], modelDecisionCount: 1, guiActionCount: 1, guidanceText: "private guidance" }),
    event("monitor.proposal", 24, { mode: "guidance", proposal: "suppressed_by_execution_barrier", fingerprint: "fingerprint-2", sourceEventIds: [], reasonCodes: [], evidenceKinds: [], modelDecisionCount: 1, guiActionCount: 1 }),
    event("user.input.requested", 25, { question: "private question" }),
    event("user.input.received", 26, { text: "private answer" }),
    event("run.paused", 27, { reason: "private pause reason" }),
    event("run.resumed", 28),
    event("model.request.started", 29, {
      requestId: "request-3",
      contextBudget: {
        mode: "raw",
        selectedHistoryEvents: 0,
        omittedHistoryEvents: 0,
        trace: {
          compilerVersion: "test",
          runId,
          stablePrefixHash: "prefix-a",
          fixedBlocks: [],
          selectedEventIds: [],
          discardedEvents: [],
          authoritativeUserEventIds: [],
          observationIncluded: false,
        },
      },
    }),
    event("model.request.failed", 30, { requestId: "request-3", category: "provider", code: "TIMEOUT", message: "private provider message", retryable: true }),
    event("run.finished", 31, { outcome: "succeeded", summary: "private run summary", reportedStatus: "success" }),
  ];
}

async function makeTrial(root, { trial = {}, summary, trajectoryText, manual = "manual sentinel\n" } = {}) {
  const trialDirectory = join(root, "trial-1");
  await mkdir(join(trialDirectory, "runtime"), { recursive: true });
  await writeFile(join(trialDirectory, "trial.json"), `${JSON.stringify({ trialId: "trial-1", taskId: "T01", split: "development", ...trial })}\n`, "utf8");
  await writeFile(join(trialDirectory, "manual-review.md"), manual, "utf8");
  if (summary !== undefined) await writeFile(join(trialDirectory, "runtime", "summary.json"), `${JSON.stringify(summary)}\n`, "utf8");
  if (trajectoryText !== undefined) await writeFile(join(trialDirectory, "runtime", "trajectory.jsonl"), trajectoryText, "utf8");
  return trialDirectory;
}

async function readMetrics(trialDirectory) {
  return JSON.parse(await readFile(join(trialDirectory, "metrics.json"), "utf8"));
}

test("collects complete base and module evidence without raw payloads", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "travel-metrics-complete-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const manual = "manual content must remain unchanged\n";
  const trialDirectory = await makeTrial(root, {
    manual,
    summary: { runId, runtimeOutcome: "succeeded", modelReportedStatus: "success", modelUsage: { inputTokens: 999 } },
    trajectoryText: `${completeEvents().map((item) => JSON.stringify(item)).join("\n")}\n`,
  });
  const result = await collectTrial(trialDirectory, { root });
  const metrics = await readMetrics(trialDirectory);
  assert.deepEqual(metrics, result);
  assert.equal(metrics.dataQuality.status, "complete");
  assert.equal(metrics.runId, runId);
  assert.equal(metrics.runtimeOutcome, "succeeded");
  assert.equal(metrics.modelReportedStatus, "success");
  assert.equal(metrics.businessOutcome.status, "manual_pending");
  assert.equal(metrics.base.requests.started, 3);
  assert.equal(metrics.base.requests.responses, 2);
  assert.equal(metrics.base.requests.failures, 1);
  assert.equal(metrics.base.requests.durations.totalMs, 3000);
  assert.equal(metrics.base.actions.completed, 1);
  assert.equal(metrics.base.actions.refused, 1);
  assert.equal(metrics.base.observations, 1);
  assert.equal(metrics.context.memory.admittedCount, 1);
  assert.equal(metrics.context.memory.revalidationCount, 1);
  assert.equal(metrics.context.memory.excludedCount, 1);
  assert.equal(metrics.context.memory.retrievalDegradedCount, 1);
  assert.equal(metrics.context.planIncludedRequests, 1);
  assert.equal(metrics.planning.calls, 1);
  assert.equal(metrics.planning.updates, 1);
  assert.equal(metrics.memory.calls, 1);
  assert.equal(metrics.memory.updates, 1);
  assert.equal(metrics.monitor.candidates, 1);
  assert.equal(metrics.monitor.suppressed, 1);
  assert.equal(metrics.monitor.transitions.unchanged, 1);
  assert.equal(metrics.guard.decisions.require_approval, 1);
  assert.equal(metrics.guard.approvals.approved, 1);
  assert.equal(metrics.humanControl.userInputReceived, 1);
  assert.equal(metrics.humanControl.pauses, 1);
  assert.equal(metrics.batch.guiModelTurnCandidates, 1);
  assert.equal(metrics.batch.candidates[0].approved, null);
  assert.equal(metrics.context.cacheHit, null);
  assert.equal(metrics.context.stablePrefixHashChanges, 2);
  assert.equal(metrics.context.stablePrefixHashDistinct, 2);
  assert.equal(await readFile(join(trialDirectory, "manual-review.md"), "utf8"), manual);
  const serialized = JSON.stringify(metrics);
  assert.equal(serialized.includes("typed-secret"), false);
  assert.equal(serialized.includes("private response text"), false);
  assert.equal(serialized.includes("screenshots/private.png"), false);
});

test("keeps valid prefix and reports truncated trajectory plus missing summary as partial", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "travel-metrics-partial-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const trialDirectory = await makeTrial(root, {
    trajectoryText: `${JSON.stringify(event("run.created", 0, { goal: "private" }))}\n{"type":"model.request.started"`,
  });
  const result = await collectTrial(trialDirectory, { root });
  assert.equal(result.dataQuality.status, "partial");
  assert.ok(result.dataQuality.errors.some((item) => item.code === "truncated_jsonl"));
  assert.ok(result.dataQuality.errors.some((item) => item.path === "runtime/summary.json"));
  assert.equal(result.dataQuality.eventCount, 1);
  assert.equal(result.base.requests.started, 0);
  assert.equal(result.businessOutcome.success, null);
});

test("writes a partial metrics file when all runtime artifacts are missing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "travel-metrics-missing-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const trialDirectory = join(root, "trial-1");
  await mkdir(trialDirectory, { recursive: true });
  const result = await collectTrial(trialDirectory, { root });
  assert.equal(result.dataQuality.status, "partial");
  assert.equal(result.runId, null);
  assert.equal(result.base.requests, null);
  assert.ok(result.dataQuality.errors.filter((item) => item.code === "missing_file").length >= 3);
  assert.equal(await readFile(join(trialDirectory, "metrics.json"), "utf8").then((text) => text.includes("manual-review")), false);
});

test("marks conflicting trial, summary, and trajectory run IDs as partial", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "travel-metrics-conflict-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const trialDirectory = await makeTrial(root, {
    trial: { runId: "trial-run" },
    summary: { runId: "summary-run", runtimeOutcome: "failed" },
    trajectoryText: `${JSON.stringify(event("run.created", 0, { goal: "private" }))}\n`,
  });
  const result = await collectTrial(trialDirectory, { root });
  assert.equal(result.runId, null);
  assert.equal(result.dataQuality.status, "partial");
  assert.ok(result.dataQuality.errors.some((item) => item.code === "conflicting_run_id"));
  assert.deepEqual(await readFile(join(trialDirectory, "manual-review.md"), "utf8"), "manual sentinel\n");
});

test("rejects a trial path outside the configured root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "travel-metrics-root-"));
  const outside = await mkdtemp(join(tmpdir(), "travel-metrics-outside-"));
  t.after(async () => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]));
  await assert.rejects(() => collectTrial(outside, { root }), /inside the travel run root|outside the travel run root/u);
});

test("marks empty or structurally incomplete traces partial", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "travel-metrics-structure-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const trialDirectory = await makeTrial(root, {
    summary: { runId, runtimeOutcome: "failed" },
    trajectoryText: `${JSON.stringify(event("run.created", 0, { goal: "private" }))}\n${JSON.stringify(event("run.started", 1))}\n${JSON.stringify(event("run.finished", 3, { outcome: "succeeded" }))}\n${JSON.stringify(event("run.finished", 3, { outcome: "succeeded" }, "event-duplicate", 3))}\n`,
  });
  const result = await collectTrial(trialDirectory, { root });
  const codes = result.dataQuality.errors.map((item) => item.code);
  assert.ok(codes.includes("duplicate_sequence"));
  assert.ok(codes.includes("sequence_gap"));
  assert.ok(codes.includes("outcome_mismatch"));
  assert.equal(result.dataQuality.status, "partial");
});

test("does not follow an existing metrics.json symlink", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "travel-metrics-symlink-"));
  const outside = await mkdtemp(join(tmpdir(), "travel-metrics-target-"));
  t.after(async () => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]));
  const trialDirectory = await makeTrial(root, {
    summary: { runId, runtimeOutcome: "succeeded" },
    trajectoryText: `${completeEvents().map((item) => JSON.stringify(item)).join("\n")}\n`,
  });
  const target = join(outside, "external.json");
  await writeFile(target, "external sentinel\n", "utf8");
  try {
    await symlink(target, join(trialDirectory, "metrics.json"));
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip("symbolic links are unavailable in this Windows test environment");
      return;
    }
    throw error;
  }
  await assert.rejects(() => collectTrial(trialDirectory, { root }), /must not be a symbolic link/u);
  assert.equal(await readFile(target, "utf8"), "external sentinel\n");
});
