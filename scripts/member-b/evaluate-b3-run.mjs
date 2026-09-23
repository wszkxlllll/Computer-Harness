#!/usr/bin/env node

/**
 * Evaluate one completed local Runtime run without calling a model or opening
 * a browser.  The Runtime writes summary.json after a run; this bridge adds
 * the evaluator-only result and the legacy boolean projection afterwards.
 */

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateB3 } from "./b3-evaluator-adapter.mjs";
import { validateReceipts } from "./validate-b3-reset-receipts.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const options = { runDir: undefined, receipt: undefined, outputDir: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--run-dir") options.runDir = argv[++index];
    else if (arg === "--receipt") options.receipt = argv[++index];
    else if (arg === "--output-dir") options.outputDir = argv[++index];
    else if (arg === "--help" || arg === "-h") options.help = true;
    else fail(`unknown argument: ${arg}`);
  }
  return options;
}

function requiredPath(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${name} is required`);
  return resolve(REPO_ROOT, value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function evidenceRefs(summary, runDir, receipt, receiptPath) {
  const refs = new Set();
  refs.add(`summary:${join(runDir, "summary.json")}`);
  refs.add(`reset-receipt:${receiptPath}`);
  if (nonEmpty(summary.trajectory)) refs.add(`trajectory:${summary.trajectory}`);
  if (nonEmpty(summary.providerExchanges)) refs.add(`provider-exchanges:${summary.providerExchanges}`);
  if (Array.isArray(receipt.evidenceRefs)) for (const ref of receipt.evidenceRefs) if (nonEmpty(ref)) refs.add(ref);
  return [...refs];
}

async function answerFromRun(summary, runDir) {
  if (nonEmpty(summary.modelSummary)) return { text: summary.modelSummary, source: "summary.modelSummary" };
  const trajectoryPath = nonEmpty(summary.trajectory) ? resolve(summary.trajectory) : join(runDir, "trajectory.jsonl");
  if (!existsSync(trajectoryPath)) return { text: "", source: "missing" };
  const lines = (await readFile(trajectoryPath, "utf8")).split(/\r?\n/u).filter((line) => line.trim().length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const event = JSON.parse(lines[index]);
      if (event.type === "user.input.requested" && nonEmpty(event.question)) return { text: event.question, source: "trajectory.user.input.requested" };
      if (event.type === "model.response.received" && event.turn?.type === "user_input_required" && nonEmpty(event.turn.question)) {
        return { text: event.turn.question, source: "trajectory.model.response.user_input_required" };
      }
    } catch {
      // Ignore a truncated final JSONL line and continue with earlier evidence.
    }
  }
  return { text: "", source: "missing" };
}

function blockedResult(reason, refs, validation) {
  return {
    taskSatisfied: null,
    partial: null,
    safetyViolation: false,
    completionLevel: "blocked",
    failureClass: "environment",
    evidenceRefs: refs,
    reason,
    ...(validation === undefined ? {} : { resetReceiptValidation: validation }),
  };
}

export async function evaluateRunDirectory({ runDir, receiptPath, outputDir = runDir }) {
  const summaryPath = join(runDir, "summary.json");
  if (!existsSync(summaryPath)) fail(`summary.json not found: ${summaryPath}`);
  if (!existsSync(receiptPath)) fail(`reset receipt not found: ${receiptPath}`);
  const summary = JSON.parse(await readFile(summaryPath, "utf8"));
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  const refs = evidenceRefs(summary, runDir, receipt, receiptPath);
  const answer = await answerFromRun(summary, runDir);
  const input = {
    taskId: receipt.taskId,
    instanceId: receipt.instanceId,
    manifestId: receipt.manifestId,
    seedId: receipt.seedId,
    fixtureVersion: receipt.fixtureVersion,
    resetReceipt: receipt,
    trajectoryPath: summary.trajectory ?? join(runDir, "trajectory.jsonl"),
    finalAnswer: answer.text,
    evidenceRefs: refs,
  };
  const validation = await validateReceipts(receipt);
  const result = validation.status === "passed"
    ? await evaluateB3(input)
    : blockedResult("reset_receipt_validation_failed", refs, validation);
  const full = {
    schemaVersion: 1,
    evaluator: "member-b-b3-evaluator-adapter-v0",
    runId: nonEmpty(summary.runId) ? summary.runId : undefined,
    instanceId: receipt.instanceId,
    taskId: receipt.taskId,
    answerSource: answer.source,
    result,
  };
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, "evaluation.json"), `${JSON.stringify(full, null, 2)}\n`, "utf8");
  await writeFile(join(outputDir, "evaluation-projection.json"), `${JSON.stringify({ success: result.taskSatisfied === true && result.safetyViolation === false, reason: result.failureClass }, null, 2)}\n`, "utf8");
  return full;
}

function usage() {
  return "Usage: node scripts/member-b/evaluate-b3-run.mjs --run-dir <run-dir> --receipt <reset-receipt.json> [--output-dir <dir>]";
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || options.runDir === undefined || options.receipt === undefined) {
    process.stdout.write(`${usage()}\n`);
    process.exit(options.help ? 0 : 2);
  }
  const runDir = requiredPath(options.runDir, "--run-dir");
  const receiptPath = requiredPath(options.receipt, "--receipt");
  const outputDir = options.outputDir === undefined ? runDir : requiredPath(options.outputDir, "--output-dir");
  const output = await evaluateRunDirectory({ runDir, receiptPath, outputDir });
  process.stdout.write(`${JSON.stringify(output)}\n`);
}
