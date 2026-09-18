import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { RunOutcome, RunId, RuntimeEvent } from "@computer-harness/protocol";
import type { CleanupDiagnostic } from "@computer-harness/runtime";
import { reduceRuntimeEvents, readRuntimeEvents, type RunSnapshot } from "@computer-harness/trajectory";
import type { ResolvedRunConfig } from "./config.js";

export interface RunReport {
  readonly runId: RunId;
  readonly outcome: RunOutcome;
  readonly summary: Record<string, unknown>;
  readonly snapshot: RunSnapshot;
  readonly events: RuntimeEvent[];
}

export async function buildRunReport(
  config: ResolvedRunConfig,
  runId: RunId,
  cleanupDiagnostics: readonly CleanupDiagnostic[],
  toolNames: readonly string[],
): Promise<RunReport> {
  const events = await readRuntimeEvents(resolve(config.outputDir, "trajectory.jsonl"));
  const snapshot = reduceRuntimeEvents(events, runId);
  if (snapshot.status !== "finished" || snapshot.outcome === undefined) {
    throw new Error(`RunReport for ${runId} requires a finished trajectory with an outcome`);
  }
  const outcome = snapshot.outcome;
  const fixture = await readFixtureResult(config.fixtureResult);
  const summary = {
    runId,
    model: config.model,
    computer: config.computer.kind,
    coordinateMode: config.qwenCoordinateMode ?? null,
    thinkingMode: config.qwenThinking ?? null,
    outputMode: config.qwenOutputMode ?? null,
    glmThinking: config.glmThinking ?? "enabled",
    planning: config.planning,
    memory: config.memory,
    batching: config.batching,
    cleanupDeadlineMs: config.cleanupDeadlineMs,
    riskProfile: config.riskProfile,
    riskGuard: config.riskGuard,
    riskModel: config.riskModel,
    contextMode: config.contextMode,
    contextMaxHistoryEvents: config.contextMaxHistoryEvents,
    contextMaxInputTokens: config.contextMaxInputTokens ?? null,
    tools: [...toolNames],
    planStoreRoot: config.planning ? resolve(config.outputDir, "plan-store") : null,
    computerSession: snapshot.computerSession ?? null,
    runtimeOutcome: outcome,
    modelSummary: snapshot.summary ?? null,
    modelReportedStatus: snapshot.reportedStatus ?? null,
    modelUsage: snapshot.modelUsage ?? null,
    cleanupDiagnostics: [...cleanupDiagnostics],
    fixture,
    trajectory: resolve(config.outputDir, "trajectory.jsonl"),
    providerExchanges: resolve(config.outputDir, "provider-exchanges.jsonl"),
    metrics: {
      steps: snapshot.stepCount,
      modelRequests: snapshot.modelRequestCount,
      guardEvaluations: snapshot.guardEvaluationCount,
      riskModelRequests: snapshot.riskModelRequestCount,
      approvalsRequested: events.filter((event) => event.type === "approval.requested").length,
      guardDecisions: events
        .filter((event) => event.type === "action.guard.evaluated")
        .reduce((counts, event) => ({ ...counts, [event.decision]: (counts[event.decision] ?? 0) + 1 }), {} as Record<string, number>),
      eventCount: events.length,
      invalidToolCalls: events.filter((event) => event.type === "tool.call.rejected").length,
      rejectedToolCalls: events.filter((event) => event.type === "tool.call.rejected").length,
      budgetRejectedToolCalls: events.filter((event) => event.type === "tool.call.rejected" && /action budget exhausted/iu.test(event.reason)).length,
      budgetRuntimeErrors: events.filter((event) => event.type === "runtime.error" && event.category === "budget").length,
      argumentRejectedToolCalls: events.filter((event) => event.type === "tool.call.rejected" && /invalid arguments|invalid GUI action/iu.test(event.reason)).length,
      toolExecutionFailed: events.filter((event) => event.type === "tool.call.failed").length,
      providerFailed: events.filter((event) => event.type === "model.request.failed").length,
      runtimeErrors: events.filter((event) => event.type === "runtime.error").length,
      providerErrors: events
        .filter((event): event is Extract<RuntimeEvent, { type: "model.request.failed" }> => event.type === "model.request.failed")
        .map((event) => ({ category: event.category, code: event.code ?? null, retryable: event.retryable ?? null, message: event.message })),
    },
  } satisfies Record<string, unknown>;
  return { runId, outcome, summary, snapshot, events };
}

export async function writeRunReport(report: RunReport, outputDir: string): Promise<void> {
  await writeFile(resolve(outputDir, "summary.json"), `${JSON.stringify(report.summary, null, 2)}\n`, "utf8");
}

async function readFixtureResult(path: string | undefined): Promise<{ status: "not_configured" } | { status: "external_import"; success: boolean; reason?: string }> {
  if (path === undefined) return { status: "not_configured" };
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (typeof value !== "object" || value === null || typeof (value as { success?: unknown }).success !== "boolean") {
    throw new Error("fixture result must be JSON with boolean success");
  }
  const record = value as { success: boolean; reason?: unknown };
  return typeof record.reason === "string"
    ? { status: "external_import", success: record.success, reason: record.reason }
    : { status: "external_import", success: record.success };
}
