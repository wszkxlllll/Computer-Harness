import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SIX_DOMAIN_SUITE_ID } from "./common.mjs";
import { collectMetrics, readMetricsArtifacts } from "../travel/metrics.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pathInside(root, target) {
  const child = relative(root, target);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function pathKey(value) {
  return resolve(value).replaceAll("\\", "/").toLowerCase();
}

async function readJsonObject(path) {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) return { status: "symlink_rejected", value: null };
    if (!entry.isFile()) return { status: "not_a_file", value: null };
    const bytes = await readFile(path);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = JSON.parse(text);
    if (!isRecord(value)) return { status: "invalid_object", value: null };
    return { status: "parsed", value };
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "missing", value: null };
    if (error instanceof SyntaxError || error instanceof TypeError) return { status: "invalid_json_or_encoding", value: null };
    throw error;
  }
}

async function readSummaryCandidate(path, relativePath, runId, trajectoryPath) {
  const parsed = await readJsonObject(path);
  if (parsed.status !== "parsed") return { status: parsed.status, path: relativePath, value: null };
  const summary = parsed.value;
  if (summary.runId !== runId) return { status: "run_id_mismatch", path: relativePath, value: null };
  if (typeof summary.trajectory === "string") {
    if (!isAbsolute(summary.trajectory) || pathKey(summary.trajectory) !== pathKey(trajectoryPath)) {
      return { status: "trajectory_path_mismatch", path: relativePath, value: null };
    }
  }
  return {
    status: typeof summary.trajectory === "string" ? "matched_run_and_trajectory" : "matched_run_id_trajectory_unrecorded",
    path: relativePath,
    value: summary,
  };
}

async function readReceiptCounts(receiptsPath, { packageId, attemptId, runId }) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(receiptsPath));
  } catch (error) {
    const status = error?.code === "ENOENT" ? "missing" : "unreadable";
    return { status, rawReceiptCount: null, uniqueCommandCount: null, byCommand: null, rawByStatus: null, correctionsConsumed: null, cancellations: null };
  }
  const rawByStatus = {};
  const errors = [];
  const latestByCommandId = new Map();
  let rawReceiptCount = 0;
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0) continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      errors.push({ code: "invalid_receipt_json", line: index + 1 });
      continue;
    }
    if (!isRecord(item)
        || item.packageId !== packageId
        || item.attemptId !== attemptId
        || item.runId !== runId
        || typeof item.commandId !== "string"
        || (item.command !== "correct" && item.command !== "cancel")
        || typeof item.status !== "string") {
      errors.push({ code: "invalid_or_mismatched_receipt", line: index + 1 });
      continue;
    }
    rawReceiptCount += 1;
    rawByStatus[item.status] = (rawByStatus[item.status] ?? 0) + 1;
    latestByCommandId.set(item.commandId, { command: item.command, status: item.status });
  }
  const byCommand = { correct: {}, cancel: {} };
  let correctionsConsumed = 0;
  let cancellations = 0;
  for (const finalReceipt of latestByCommandId.values()) {
    byCommand[finalReceipt.command][finalReceipt.status] = (byCommand[finalReceipt.command][finalReceipt.status] ?? 0) + 1;
    if (finalReceipt.command === "correct" && finalReceipt.status === "consumed") correctionsConsumed += 1;
    if (finalReceipt.command === "cancel" && finalReceipt.status === "cancel-requested") cancellations += 1;
  }
  return {
    status: errors.length === 0 ? "complete" : "partial",
    rawReceiptCount,
    uniqueCommandCount: latestByCommandId.size,
    byCommand,
    rawByStatus,
    correctionsConsumed,
    cancellations,
    ...(errors.length === 0 ? {} : { errors }),
  };
}

function classifyAssistance(receipts) {
  if (receipts.status !== "complete") return "unknown_receipt_evidence_incomplete";
  const pendingCorrections = receipts.byCommand.correct.queued ?? 0;
  if (receipts.correctionsConsumed > 0 && pendingCorrections > 0) return "assisted_with_additional_correction_pending";
  if (receipts.correctionsConsumed > 0) return "assisted_after_consumed_correction";
  if (pendingCorrections > 0) return "unknown_correction_delivery_pending";
  const correctCount = Object.values(receipts.byCommand.correct).reduce((sum, count) => sum + count, 0);
  if (correctCount > 0) return "no_correction_consumed";
  return "autonomous_no_correction_recorded";
}

function addError(errors, code, path, extra = {}) {
  errors.push({ code, path, ...extra });
}

export async function summarizeLifeEvalPackage(packagePath, attemptId, options = {}) {
  const { root = REPO_ROOT, now = () => new Date() } = options;
  const analysisId = options.analysisId ?? attemptId;
  if (typeof packagePath !== "string" || !isAbsolute(packagePath)) throw new Error("--package must be an absolute path");
  if (typeof attemptId !== "string" || !ATTEMPT_ID_PATTERN.test(attemptId)) throw new Error("--attempt-id is invalid");
  if (typeof analysisId !== "string" || !ATTEMPT_ID_PATTERN.test(analysisId)) throw new Error("--analysis-id is invalid");

  const packageDir = resolve(packagePath);
  const suiteRunRoot = resolve(root, "runs", SIX_DOMAIN_SUITE_ID);
  if (!pathInside(suiteRunRoot, packageDir)) throw new Error(`package must be inside runs/${SIX_DOMAIN_SUITE_ID}`);
  const packagePhysical = await realpath(packageDir);
  const suitePhysical = await realpath(suiteRunRoot);
  if (!pathInside(suitePhysical, packagePhysical)) throw new Error("package resolves outside the six-domain run directory");

  const planPath = join(packageDir, "plan.json");
  const attemptDir = join(packageDir, "attempts", attemptId);
  const recordPath = join(packageDir, "live-attempt.json");
  const [planResult, recordResult] = await Promise.all([readJsonObject(planPath), readJsonObject(recordPath)]);
  if (planResult.value === null || recordResult.value === null) throw new Error("package plan or selected live-attempt record is missing or invalid");
  const plan = planResult.value;
  const record = recordResult.value;
  if (plan.suiteId !== SIX_DOMAIN_SUITE_ID || pathKey(plan.packageDir) !== pathKey(packageDir) || record.packageId !== plan.packageId || record.task !== plan.task?.id || record.variant !== plan.selection?.variant) {
    throw new Error("package and live-attempt identities do not match");
  }
  const frozenSupervision = plan.configuration?.supervision;
  if (!isRecord(frozenSupervision) || !["observe", "dynamic"].includes(frozenSupervision.mode) || record.supervision?.mode !== frozenSupervision.mode) {
    throw new Error("six-domain package has no matching frozen supervision record");
  }
  if (record.supervision?.attemptId !== attemptId || record.supervision?.receiptFile !== "supervision-receipts.jsonl") {
    throw new Error("live-attempt supervision receipt path does not match its package attempt");
  }
  const attemptPhysical = await realpath(attemptDir);
  if (!pathInside(packagePhysical, attemptPhysical) || pathKey(record.stdoutLog) !== pathKey(join(attemptDir, "stdout.log"))) {
    throw new Error("live-attempt stdout log does not bind to the selected package attempt directory");
  }
  const runId = record.final?.supervision?.runId;
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId) || record.final?.supervision?.mode !== frozenSupervision.mode) {
    throw new Error("live-attempt record does not contain a valid actual Runtime RunId");
  }

  const outputIndex = plan.cli?.argvTemplate?.indexOf("--output") ?? -1;
  const outputBase = outputIndex < 0 ? null : plan.cli.argvTemplate[outputIndex + 1];
  const expectedOutputBase = join(packageDir, "runtime-output");
  if (typeof outputBase !== "string" || pathKey(outputBase) !== pathKey(expectedOutputBase)) {
    throw new Error("frozen CLI output path is not this package's runtime-output directory");
  }
  const outputBaseEntry = await lstat(outputBase).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (outputBaseEntry?.isSymbolicLink()) throw new Error("package runtime-output directory must not be a symbolic link");
  if (outputBaseEntry !== null) {
    const outputBasePhysical = await realpath(outputBase);
    if (!pathInside(packagePhysical, outputBasePhysical)) throw new Error("runtime-output resolves outside the prepared package");
  }
  const runtimeDir = join(outputBase, runId);
  const runtimeEntry = await lstat(runtimeDir).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (runtimeEntry?.isSymbolicLink()) throw new Error("Run output directory must not be a symbolic link");
  if (runtimeEntry !== null) {
    const runtimePhysical = await realpath(runtimeDir);
    if (!pathInside(packagePhysical, runtimePhysical)) throw new Error("Run output directory resolves outside the prepared package");
  }
  const nestedSummaryPath = join(runtimeDir, "summary.json");
  const rootSummaryPath = join(outputBase, "summary.json");
  const trajectoryPath = join(runtimeDir, "trajectory.jsonl");
  const [nestedSummary, rootSummary] = await Promise.all([
    readSummaryCandidate(nestedSummaryPath, `runtime-output/${runId}/summary.json`, runId, trajectoryPath),
    readSummaryCandidate(rootSummaryPath, "runtime-output/summary.json", runId, trajectoryPath),
  ]);
  if (nestedSummary.status === "symlink_rejected") throw new Error("Run summary file must not be a symbolic link");
  const selectedSummary = nestedSummary.value !== null ? nestedSummary : rootSummary.value !== null ? rootSummary : null;

  const artifacts = await readMetricsArtifacts(runtimeDir, { includeSummary: false });
  const trajectoryErrors = artifacts.errors.filter((error) => !String(error.path ?? "").endsWith("summary.json"));
  const collectorErrors = [...trajectoryErrors];
  if (selectedSummary === null) {
    const mismatch = [nestedSummary, rootSummary].find((candidate) => candidate.status === "run_id_mismatch" || candidate.status === "trajectory_path_mismatch");
    const mismatchCode = mismatch?.status === "run_id_mismatch"
      ? "summary_run_id_mismatch"
      : mismatch?.status === "trajectory_path_mismatch"
        ? "summary_trajectory_path_mismatch"
        : "missing_or_invalid_summary";
    addError(
      collectorErrors,
      mismatchCode,
      mismatch?.path ?? "runtime-output/summary.json",
    );
  }
  const metrics = collectMetrics({
    trial: null,
    summary: selectedSummary?.value ?? null,
    events: artifacts.events,
    trajectory: { ...artifacts.trajectory, path: `runtime-output/${runId}/trajectory.jsonl` },
    providerExchanges: { ...artifacts.providerExchanges, path: `runtime-output/${runId}/provider-exchanges.jsonl` },
    errors: collectorErrors,
  });
  const receiptCounts = await readReceiptCounts(join(attemptDir, record.supervision.receiptFile), {
    packageId: plan.packageId,
    attemptId,
    runId,
  });
  const eventRunIdStatus = metrics.runId === runId ? "matched" : metrics.runId === null ? "not_observed_or_conflicting" : "mismatch";
  const analysisRoot = join(packageDir, "analysis");
  await mkdir(analysisRoot, { recursive: true });
  const analysisRootPhysical = await realpath(analysisRoot);
  if (!pathInside(packagePhysical, analysisRootPhysical)) throw new Error("analysis directory resolves outside the prepared package");
  const reportDir = join(analysisRoot, analysisId);
  await mkdir(reportDir, { recursive: false });
  const reportDirPhysical = await realpath(reportDir);
  if (!pathInside(packagePhysical, reportDirPhysical)) throw new Error("attempt analysis directory resolves outside the prepared package");
  const outputPath = join(reportDir, "metrics-report.json");

  const report = {
    schemaVersion: 1,
    kind: "life_eval_metrics_report",
    collectedAt: now().toISOString(),
    suiteId: plan.suiteId,
    packageId: plan.packageId,
    taskId: plan.task.id,
    variant: plan.selection.variant,
    attemptId,
    analysisId,
    runId,
    runtimeOutcome: metrics.runtimeOutcome,
    modelReportedStatus: metrics.modelReportedStatus,
    turnUsage: metrics.turnUsage,
    providerApiUsage: metrics.providerApiUsage,
    eventRunIdStatus,
    summarySelection: {
      selectedPath: selectedSummary?.path ?? null,
      nestedCandidateStatus: nestedSummary.status,
      outputRootCandidateStatus: rootSummary.status,
      matchingRunIdRequired: true,
      trajectoryPathRequiredWhenPresent: true,
    },
    trialMetadata: {
      status: "not_applicable_to_life_eval_package",
      suppliedToTravelMetrics: false,
      reason: "No travel trial.json was synthesized; collector dataQuality partial status is preserved.",
    },
    businessReview: {
      status: "unknown_not_scored",
      score: null,
      success: null,
      reviewFileRead: false,
    },
    assistance: {
      supervisionMode: frozenSupervision.mode,
      receiptEvidenceStatus: receiptCounts.status,
      commandReceiptCounts: receiptCounts.rawReceiptCount === null ? null : receiptCounts.byCommand,
      rawReceiptStatusCounts: receiptCounts.rawReceiptCount === null ? null : receiptCounts.rawByStatus,
      rawReceiptCount: receiptCounts.rawReceiptCount,
      uniqueCommandCount: receiptCounts.uniqueCommandCount,
      correctionsConsumed: receiptCounts.correctionsConsumed,
      cancellations: receiptCounts.cancellations,
      classification: classifyAssistance(receiptCounts),
      ...(receiptCounts.errors === undefined ? {} : { receiptErrors: receiptCounts.errors }),
    },
    metricsDataQuality: metrics.dataQuality,
    moduleMetrics: {
      planning: metrics.planning,
      memory: metrics.memory,
      monitor: metrics.monitor,
    },
    metrics,
    sources: {
      trajectory: `runtime-output/${runId}/trajectory.jsonl`,
      summary: selectedSummary?.path ?? null,
      providerExchanges: artifacts.providerExchanges.present ? `runtime-output/${runId}/provider-exchanges.jsonl` : null,
      supervisionReceipts: `attempts/${attemptId}/supervision-receipts.jsonl`,
      collector: "scripts/travel/metrics.mjs collectMetrics + readMetricsArtifacts",
    },
  };
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return { outputPath, report };
}

function parseArgs(argv) {
  const values = {};
  const valueFlags = new Set(["--package", "--attempt-id", "--analysis-id"]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (!valueFlags.has(flag)) throw new Error(`unknown option: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    if (values[flag] !== undefined) throw new Error(`${flag} may only be supplied once`);
    values[flag] = value;
    index += 1;
  }
  if (typeof values["--package"] !== "string") throw new Error("--package is required");
  if (typeof values["--attempt-id"] !== "string") throw new Error("--attempt-id is required");
  return values;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write("Usage: node scripts/life-eval/summarize.mjs --package <absolute-package-path> --attempt-id <live-attempt-id> [--analysis-id <new-report-id>]\nReads the package-owned Runtime trajectory/summary, redacted provider exchanges, and supervision receipts. Writes one new metrics report under package-owned analysis/; use a fresh --analysis-id to preserve an earlier report. It never overwrites an existing report, scores the task, or reads .env.\n");
    return;
  }
  const result = await summarizeLifeEvalPackage(args["--package"], args["--attempt-id"], {
    analysisId: args["--analysis-id"] ?? args["--attempt-id"],
  });
  process.stdout.write(`Metrics report written: ${result.outputPath}\n`);
  process.stdout.write(`Runtime outcome: ${result.report.runtimeOutcome ?? "unknown"}; business review: unknown_not_scored; assistance: ${result.report.assistance.classification}\n`);
}

if (process.argv[1] !== undefined && pathKey(process.argv[1]) === pathKey(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
