import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { RunOutcome, RunId, RuntimeEvent } from "@computer-harness/protocol";
import type { CleanupDiagnostic } from "@computer-harness/runtime";
import { reduceRuntimeEvents, readRuntimeEvents, type RunSnapshot } from "@computer-harness/trajectory";
import type { ResolvedRunConfig } from "./config.js";
import { glmProfiles } from "@computer-harness/provider-glm";

export interface RunReport {
  readonly runId: RunId;
  readonly outcome: RunOutcome;
  readonly summary: Record<string, unknown>;
  readonly snapshot: RunSnapshot;
  readonly events: RuntimeEvent[];
}

interface RunRecoveryReport {
  schemaVersion: 1;
  kind: "program_run_evidence";
  runId: RunId;
  source: "committed_runtime_events_and_reducer";
  businessResult: "not_assessed";
  runtimeOutcome: RunOutcome;
  modelReply: { status: "recorded" | "not_recorded"; reportedStatus: "success" | "failure" | null };
  notDeliveredNote: string | null;
  latestObservation: {
    sourceEventId: string;
    observationId: string;
    capturedAt: string | null;
    sourceUrl: null;
    sourceUrlStatus: "unknown_not_recorded";
  } | null;
  budget: {
    configured: { guiActions: number; modelRequests: number };
    observed: { guiActions: number; modelRequests: number };
    exhaustedKinds: Array<"gui_actions" | "model_requests" | "unknown">;
    evidenceEventIds: string[];
  };
  evidenceEvents: Array<{
    eventId: string;
    type: string;
    category?: string;
    code?: string;
    retryable?: boolean;
  }>;
  unknownSideEffects: { status: "none_recorded" | "unknown"; actionIds: string[] };
  planState?: { statusSource: "model_maintained_state_not_environment_verification"; tasks: Array<{ id: string; status: string; sourceEventId: string | null }> };
  memoryState?: {
    statusSource: "model_authored_memory_not_independently_verified";
    facts: Array<{ id: string; status: string; updatedSequence: number; sourceEventId: string | null }>;
    entities: Array<{ id: string; status: string; updatedSequence: number; sourceEventId: string | null }>;
  };
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
  const recoveryReport = buildRunRecoveryReport(config, snapshot, events, outcome);
  const fixture = await readFixtureResult(config.fixtureResult);
  const memoryRetrieval = config.memory === "off" ? "off" : config.memoryRetrieval ?? "lexical";
  const managedGrounding = config.grounding === "dom-catalog-v1" || config.grounding === "hybrid-catalog-v1";
  const externalComputer = config.computer.kind === "external" ? config.computer : undefined;
  const completedWindowHandoffs = events.filter((event): event is Extract<RuntimeEvent, { type: "computer.window.handoff.completed" }> => event.type === "computer.window.handoff.completed");
  const latestWindowHandoff = completedWindowHandoffs.at(-1);
  const finalWindow = latestWindowHandoff?.target;
  const startedSwitchEvents = events.filter((event): event is Extract<RuntimeEvent, { type: "action.execution.started" }> =>
    event.type === "action.execution.started" && event.action.kind === "switch_window");
  const switchActionIds = new Set(startedSwitchEvents.map((event) => event.action.actionId));
  const completedWindowSwitches = events.filter((event): event is Extract<RuntimeEvent, { type: "action.execution.completed" }> =>
    event.type === "action.execution.completed" && event.receipt.status === "completed" && switchActionIds.has(event.receipt.actionId) && event.receipt.sessionAfter !== undefined);
  const latestTargetInvalidatingSwitch = startedSwitchEvents.at(-1);
  const finalWindowHandoffIsCurrent = latestWindowHandoff !== undefined &&
    (latestTargetInvalidatingSwitch === undefined || latestWindowHandoff.sequence > latestTargetInvalidatingSwitch.sequence);
  const finalTargetUnknown = latestTargetInvalidatingSwitch !== undefined &&
    (latestWindowHandoff === undefined || latestWindowHandoff.sequence < latestTargetInvalidatingSwitch.sequence);
  const completedSwitchCount = completedWindowSwitches.length;
  const failedSwitchReceipts = events.filter((event): event is Extract<RuntimeEvent, { type: "action.execution.failed" }> =>
    event.type === "action.execution.failed" && switchActionIds.has(event.receipt.actionId));
  const windowSwitchMetrics = {
    proposed: events.filter((event) => event.type === "tool.call.received" && event.call.name === "switch_window").length,
    actionsStarted: switchActionIds.size,
    completed: completedSwitchCount,
    refused: failedSwitchReceipts.filter((event) => event.receipt.status === "refused").length,
    failed: failedSwitchReceipts.filter((event) => event.receipt.status === "failed").length,
    cancelled: failedSwitchReceipts.filter((event) => event.receipt.status === "cancelled").length,
  };
  const summary = {
    runId,
    goal: config.goal,
    model: typeof config.model === "string" ? config.model : { kind: config.model.kind, id: config.model.id },
    computer: externalComputer === undefined ? config.computer.kind : { kind: externalComputer.kind, id: externalComputer.id },
    computerTarget: externalComputer !== undefined
      ? { mode: "external", id: externalComputer.id }
      : config.computer.kind === "cua"
      ? config.computer.managedBrowserCompanion === true
        ? config.computer.windowTarget === undefined
          ? { mode: "desktop" }
          : { mode: "window", pid: config.computer.windowTarget.pid, windowId: config.computer.windowTarget.windowId, deliveryMode: config.computer.windowDeliveryMode ?? "foreground" }
        : managedGrounding
        ? { mode: "managed-browser", deliveryMode: config.computer.windowDeliveryMode ?? "foreground" }
        : config.computer.windowTarget === undefined
        ? { mode: "desktop" }
        : { mode: "window", pid: config.computer.windowTarget.pid, windowId: config.computer.windowTarget.windowId, deliveryMode: config.computer.windowDeliveryMode ?? "background" }
      : { mode: "osworld" },
    ...(finalTargetUnknown
      ? { finalComputerTarget: null }
      : finalWindowHandoffIsCurrent && finalWindow !== undefined
        ? { finalComputerTarget: { mode: "window", ...finalWindow } }
        : {}),
    maxSteps: config.maxSteps,
    maxModelRequests: config.maxModelRequests,
    coordinateMode: config.qwenCoordinateMode ?? null,
    thinkingMode: config.qwenThinking ?? null,
    outputMode: config.qwenOutputMode ?? null,
    glmThinking: config.glmThinking === "disabled" ? "enabled" : config.glmThinking ?? "enabled",
    glmMaxOutputTokens: config.glmMaxOutputTokens ?? glmProfiles["glm-5.3-flash"].maxOutputTokens ?? 8192,
    planning: config.planning,
    memory: config.memory,
    memoryRetrieval,
    batching: config.batching,
    monitor: config.monitor ?? "off",
    grounding: config.grounding ?? "off",
    windowHandoff: config.windowHandoff ?? "off",
    windowSwitch: config.windowSwitch ?? "off",
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
    recoveryReport,
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
      windowHandoffsRequested: events.filter((event) => event.type === "computer.window.handoff.requested").length,
      windowHandoffsCompleted: completedWindowHandoffs.length,
      windowSwitch: windowSwitchMetrics,
      providerFailed: events.filter((event) => event.type === "model.request.failed").length,
      runtimeErrors: events.filter((event) => event.type === "runtime.error").length,
      providerErrors: events
        .filter((event): event is Extract<RuntimeEvent, { type: "model.request.failed" }> => event.type === "model.request.failed")
        .map((event) => ({ category: event.category, code: event.code ?? null, retryable: event.retryable ?? null, message: event.message })),
      monitorTransitions: events
        .filter((event): event is Extract<RuntimeEvent, { type: "monitor.transition" }> => event.type === "monitor.transition")
        .reduce((counts, event) => ({ ...counts, [event.transition]: (counts[event.transition] ?? 0) + 1 }), {} as Record<string, number>),
    },
  } satisfies Record<string, unknown>;
  return { runId, outcome, summary, snapshot, events };
}

export async function writeRunReport(report: RunReport, outputDir: string): Promise<void> {
  await writeFile(resolve(outputDir, "summary.json"), `${JSON.stringify(report.summary, null, 2)}\n`, "utf8");
  await writeFile(resolve(outputDir, "report.md"), renderRunReport(report.summary), "utf8");
}

function buildRunRecoveryReport(
  config: ResolvedRunConfig,
  snapshot: RunSnapshot,
  events: readonly RuntimeEvent[],
  outcome: RunOutcome,
): RunRecoveryReport {
  const eventIds = new Set(events.map((event) => event.eventId));
  const latestObservationEvent = [...events].reverse().find((event) =>
    event.type === "observation.created" && event.observation.id === snapshot.latestObservationId);
  const latestObservation = latestObservationEvent?.type === "observation.created"
    ? {
        sourceEventId: latestObservationEvent.eventId,
        observationId: latestObservationEvent.observation.id,
        capturedAt: canonicalCapturedAt(latestObservationEvent.observation.capturedAt),
        sourceUrl: null,
        sourceUrlStatus: "unknown_not_recorded" as const,
      }
    : null;
  const planUpdates = new Map<string, string>();
  for (const event of events) {
    if (event.type === "planning.task.updated") planUpdates.set(event.mutation.task.id, event.eventId);
  }
  const budgetEvents = events.filter((event) => event.type === "runtime.error" && event.category === "budget");
  const exhaustedKinds = outcome !== "budget_exhausted"
    ? []
    : [...new Set(budgetEvents.flatMap((event) => event.type === "runtime.error" ? [budgetKind(event.message)] : []))];
  const evidenceEvents: RunRecoveryReport["evidenceEvents"] = [];
  for (const event of events) {
    if (event.type === "runtime.error") {
      evidenceEvents.push({ eventId: event.eventId, type: event.type, category: safeCode(event.category) });
      continue;
    }
    if (event.type === "model.request.failed") {
      evidenceEvents.push({
        eventId: event.eventId,
        type: event.type,
        category: safeCode(event.category),
        ...(event.code === undefined ? {} : { code: safeCode(event.code) }),
        ...(event.retryable === undefined ? {} : { retryable: event.retryable }),
      });
      continue;
    }
    if (event.type === "tool.call.failed") {
      evidenceEvents.push({ eventId: event.eventId, type: event.type, code: safeCode(event.result.error.code) });
      continue;
    }
    if (event.type === "action.execution.failed") evidenceEvents.push({ eventId: event.eventId, type: event.type });
  }
  const hasModelReply = typeof snapshot.summary === "string" && snapshot.summary.trim().length > 0;
  const unresolvedActionIds = snapshot.unresolvedActionId === undefined ? [] : [snapshot.unresolvedActionId];
  const noteParts: string[] = [];
  if (!hasModelReply) {
    noteParts.push(`No final model reply was recorded before the Runtime ended with ${outcome}.`);
    if (outcome === "budget_exhausted") {
      const kinds = exhaustedKinds.filter((kind) => kind !== "unknown");
      noteParts.push(kinds.length > 0
        ? `The committed budget error identifies ${kinds.join(" and ")} as exhausted; see the referenced Runtime error events.`
        : "The Run ended with budget_exhausted, but the exact exhausted budget is not recorded in a recognized Runtime error message.");
    } else if (evidenceEvents.length > 0) {
      noteParts.push("Recorded failure evidence is listed by event reference below; its original details remain in the trajectory.");
    }
  }
  if (outcome === "outcome_unknown" || unresolvedActionIds.length > 0) {
    noteParts.push("At least one side-effect outcome is unknown; inspect the referenced Run evidence before any further action. The program does not recommend replay.");
  }
  return {
    schemaVersion: 1,
    kind: "program_run_evidence",
    runId: snapshot.runId,
    source: "committed_runtime_events_and_reducer",
    businessResult: "not_assessed",
    runtimeOutcome: outcome,
    modelReply: { status: hasModelReply ? "recorded" : "not_recorded", reportedStatus: snapshot.reportedStatus ?? null },
    notDeliveredNote: noteParts.length === 0 ? null : noteParts.join(" "),
    latestObservation,
    budget: {
      configured: { guiActions: config.maxSteps, modelRequests: config.maxModelRequests },
      observed: { guiActions: snapshot.stepCount, modelRequests: snapshot.modelRequestCount },
      exhaustedKinds,
      evidenceEventIds: budgetEvents.map((event) => event.eventId),
    },
    evidenceEvents,
    unknownSideEffects: {
      status: outcome === "outcome_unknown" || unresolvedActionIds.length > 0 ? "unknown" : "none_recorded",
      actionIds: unresolvedActionIds,
    },
    ...(config.planning ? {
      planState: {
        statusSource: "model_maintained_state_not_environment_verification",
        tasks: snapshot.plan.tasks.map((task) => ({ id: task.id, status: task.status, sourceEventId: planUpdates.get(task.id) ?? null })),
      },
    } : {}),
    ...(config.memory === "off" ? {} : {
      memoryState: {
        statusSource: "model_authored_memory_not_independently_verified",
        facts: snapshot.memory.facts.map((fact) => ({
          id: fact.id,
          status: fact.status,
          updatedSequence: fact.updatedSequence,
          sourceEventId: eventIds.has(fact.sourceEventId) ? fact.sourceEventId : null,
        })),
        entities: snapshot.memory.entities.map((entity) => ({
          id: entity.id,
          status: entity.status,
          updatedSequence: entity.updatedSequence,
          sourceEventId: eventIds.has(entity.sourceEventId) ? entity.sourceEventId : null,
        })),
      },
    }),
  };
}

function budgetKind(message: string): "gui_actions" | "model_requests" | "unknown" {
  if (/\b(?:model request|model retry) budget exhausted\b/iu.test(message)) return "model_requests";
  if (/\b(?:GUI|computer|action) budget exhausted\b/iu.test(message)) return "gui_actions";
  return "unknown";
}

function safeCode(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/gu, "_").slice(0, 96) || "unknown";
}

function canonicalCapturedAt(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value ? value : null;
}

function renderRunReport(summary: Record<string, unknown>): string {
  const lines = ["# Run report", "", "## Model reply", ""];
  const modelSummary = summary.modelSummary;
  if (typeof modelSummary === "string" && modelSummary.trim().length > 0) {
    lines.push("<!-- source: summary.modelSummary; preserved verbatim -->", modelSummary);
  } else {
    lines.push("No final model reply was recorded.");
  }
  lines.push("", "## Program-generated Runtime evidence", "", "This section is generated from committed Runtime events and the replayed Run state. It is not a model reply or a business-success verification.");
  const recovery = summary.recoveryReport;
  if (!isRunRecoveryReport(recovery)) {
    lines.push("", "No compatible Runtime evidence report is available in this summary.");
    return `${lines.join("\n")}\n`;
  }
  lines.push(`- Runtime outcome: ${recovery.runtimeOutcome}`, `- Business result: ${recovery.businessResult}`);
  if (summary.windowSwitch === "off" || summary.windowSwitch === "opened-windows-v1") {
    const enabled = summary.windowSwitch === "opened-windows-v1";
    const metrics = isRecord(summary.metrics) && isRecord(summary.metrics.windowSwitch) ? summary.metrics.windowSwitch : undefined;
    lines.push(`- Model-selected window switching: ${enabled ? "enabled" : "disabled"}${metrics === undefined ? "" : `; proposed=${String(metrics.proposed ?? 0)}, started=${String(metrics.actionsStarted ?? 0)}, completed=${String(metrics.completed ?? 0)}, refused=${String(metrics.refused ?? 0)}`}.`);
    if (summary.finalComputerTarget === null) lines.push("- Final target: unknown after a model-selected window switch began without a newer verified target; no PID/HWND was inferred from its opaque reference.");
  }
  if (recovery.notDeliveredNote !== null) lines.push(`- Delivery note: ${recovery.notDeliveredNote}`);
  if (recovery.latestObservation !== null) {
    lines.push(`- Latest observation: ${recovery.latestObservation.observationId} from event ${recovery.latestObservation.sourceEventId}; capturedAt: ${recovery.latestObservation.capturedAt ?? "unknown"}; source URL: unknown (not recorded by the Observation schema).`);
  } else {
    lines.push("- Latest observation: unavailable in the committed event set.");
  }
  lines.push(`- Runtime budget: ${recovery.budget.observed.guiActions}/${recovery.budget.configured.guiActions} GUI actions; ${recovery.budget.observed.modelRequests}/${recovery.budget.configured.modelRequests} model requests.`);
  if (recovery.budget.exhaustedKinds.length > 0) lines.push(`- Exhausted budget evidence: ${recovery.budget.exhaustedKinds.join(", ")} (events: ${recovery.budget.evidenceEventIds.join(", ") || "unknown"}).`);
  if (recovery.unknownSideEffects.status === "unknown") lines.push(`- Side-effect outcome: unknown${recovery.unknownSideEffects.actionIds.length === 0 ? "" : ` for action ${recovery.unknownSideEffects.actionIds.join(", ")}`}.`);
  if (recovery.planState !== undefined) lines.push(`- Plan state references (not environment verification): ${recovery.planState.tasks.map((task) => `${task.id}:${task.status}@${task.sourceEventId ?? "unknown"}`).join(", ") || "none recorded"}.`);
  if (recovery.memoryState !== undefined) {
    const refs = [
      ...recovery.memoryState.facts.map((fact) => `fact ${fact.id}:${fact.status}@${fact.sourceEventId ?? "unknown"}`),
      ...recovery.memoryState.entities.map((entity) => `entity ${entity.id}:${entity.status}@${entity.sourceEventId ?? "unknown"}`),
    ];
    lines.push(`- Run Memory state references (model-authored, values omitted, not independently verified): ${refs.join(", ") || "none recorded"}.`);
  }
  if (recovery.evidenceEvents.length > 0) {
    lines.push(`- Failure/error event references: ${recovery.evidenceEvents.map((event) => `${event.eventId}:${event.type}${event.category === undefined ? "" : `(${event.category})`}${event.code === undefined ? "" : `/${event.code}`}`).join(", ")}.`);
  }
  return `${lines.join("\n")}\n`;
}

function isRunRecoveryReport(value: unknown): value is RunRecoveryReport {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== 1 || value.kind !== "program_run_evidence" || value.source !== "committed_runtime_events_and_reducer" ||
      typeof value.runId !== "string" ||
      !["succeeded", "failed", "cancelled", "budget_exhausted", "outcome_unknown"].includes(String(value.runtimeOutcome)) ||
      value.businessResult !== "not_assessed" || (value.notDeliveredNote !== null && typeof value.notDeliveredNote !== "string") ||
      !isRecord(value.modelReply) || !["recorded", "not_recorded"].includes(String(value.modelReply.status)) ||
      !(value.modelReply.reportedStatus === null || value.modelReply.reportedStatus === "success" || value.modelReply.reportedStatus === "failure") ||
      !isRecord(value.budget) || !isRecord(value.budget.configured) || !isRecord(value.budget.observed) ||
      !Array.isArray(value.budget.exhaustedKinds) || !Array.isArray(value.budget.evidenceEventIds) || !Array.isArray(value.evidenceEvents) ||
      !isRecord(value.unknownSideEffects) || !["none_recorded", "unknown"].includes(String(value.unknownSideEffects.status)) ||
      !Array.isArray(value.unknownSideEffects.actionIds) ||
      !(value.latestObservation === null || (isRecord(value.latestObservation) && typeof value.latestObservation.sourceEventId === "string" && typeof value.latestObservation.observationId === "string" &&
        (value.latestObservation.capturedAt === null || typeof value.latestObservation.capturedAt === "string") && value.latestObservation.sourceUrl === null &&
        value.latestObservation.sourceUrlStatus === "unknown_not_recorded"))) return false;
  if (value.planState !== undefined && (!isRecord(value.planState) || value.planState.statusSource !== "model_maintained_state_not_environment_verification" || !Array.isArray(value.planState.tasks))) return false;
  if (value.memoryState !== undefined && (!isRecord(value.memoryState) || value.memoryState.statusSource !== "model_authored_memory_not_independently_verified" || !Array.isArray(value.memoryState.facts) || !Array.isArray(value.memoryState.entities))) return false;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
