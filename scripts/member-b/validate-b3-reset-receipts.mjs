#!/usr/bin/env node

/**
 * Validate reset receipts emitted by an environment controller.
 *
 * This is intentionally an importer/validator, not a receipt generator:
 * it never opens a browser, clears storage, or turns a pending binding into a
 * completed one.  A receipt must carry controller provenance, a verified empty
 * state, a state hash, and visible evidence references before it can be passed
 * to the evaluator adapter.
 */

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BINDING_PATH = resolve(REPO_ROOT, "eval/member-b/b3-development-manifest.v0.json");
const RECEIPT_SCHEMA = "member-b-b3-reset-receipt-v1";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function parseArgs(argv) {
  const options = { input: undefined, outputDir: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") options.input = argv[++index];
    else if (arg === "--output-dir") options.outputDir = argv[++index];
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return "Usage: node scripts/member-b/validate-b3-reset-receipts.mjs --input <json> [--output-dir <dir>]";
}

function asReceiptList(value) {
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value.receipts)) return value.receipts;
  if (isRecord(value)) return [value];
  throw new Error("input must be a receipt object, an array, or { receipts: [] }");
}

function validIsoTimestamp(value) {
  return nonEmpty(value) && Number.isFinite(Date.parse(value));
}

function validateReceipt(receipt, bindings) {
  const errors = [];
  if (!isRecord(receipt)) return { status: "rejected", errors: ["receipt must be an object"] };
  const path = (field) => `receipt.${field}`;
  if (receipt.schemaVersion !== RECEIPT_SCHEMA) errors.push(`${path("schemaVersion")}: expected ${RECEIPT_SCHEMA}`);
  for (const field of ["taskId", "instanceId", "fixtureVersion", "controllerId", "stateHash"]) {
    if (!nonEmpty(receipt[field])) errors.push(`${path(field)}: required non-empty string`);
  }
  if (!validIsoTimestamp(receipt.observedAt)) errors.push(`${path("observedAt")}: expected ISO timestamp`);
  if (!isRecord(receipt.resetReceipt)) errors.push(`${path("resetReceipt")}: required object`);
  else {
    if (receipt.resetReceipt.status !== "completed") errors.push(`${path("resetReceipt.status")}: must be completed`);
    if (receipt.resetReceipt.executed !== true) errors.push(`${path("resetReceipt.executed")}: must be true`);
    if (!nonEmpty(receipt.resetReceipt.method)) errors.push(`${path("resetReceipt.method")}: required controller method`);
    if (receipt.resetReceipt.verifiedEmptyState !== true) errors.push(`${path("resetReceipt.verifiedEmptyState")}: must be true`);
  }
  if (!isRecord(receipt.provenance) || receipt.provenance.source !== "environment-controller") {
    errors.push(`${path("provenance.source")}: must be environment-controller`);
  }
  if (!Array.isArray(receipt.evidenceRefs) || !receipt.evidenceRefs.some(nonEmpty)) {
    errors.push(`${path("evidenceRefs")}: at least one visible evidence reference is required`);
  }
  const binding = bindings.find((item) => item.instanceId === receipt.instanceId && item.taskId === receipt.taskId);
  if (!binding) errors.push(`${path("instanceId")}: task/instance is not in the aggregate development binding`);
  else {
    if (binding.fixtureVersion !== receipt.fixtureVersion) errors.push(`${path("fixtureVersion")}: does not match aggregate binding`);
    if (binding.manifestId !== receipt.manifestId) errors.push(`${path("manifestId")}: does not match aggregate binding`);
    if (binding.seedId !== receipt.seedId) errors.push(`${path("seedId")}: does not match aggregate binding`);
  }
  return {
    status: errors.length === 0 ? "accepted" : "rejected",
    errors,
    identity: binding ? { taskId: binding.taskId, instanceId: binding.instanceId, fixtureVersion: binding.fixtureVersion } : undefined,
  };
}

export async function validateReceipts(input) {
  const aggregate = JSON.parse(await readFile(BINDING_PATH, "utf8"));
  const receipts = asReceiptList(input);
  const results = receipts.map((receipt) => validateReceipt(receipt, aggregate.bindings ?? []));
  return {
    schemaVersion: "member-b-b3-reset-receipt-validation-v1",
    status: results.every((result) => result.status === "accepted") ? "passed" : "blocked",
    receiptCount: receipts.length,
    acceptedCount: results.filter((result) => result.status === "accepted").length,
    rejectedCount: results.filter((result) => result.status === "rejected").length,
    results,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.input) {
    process.stdout.write(`${usage()}\n`);
    process.exit(options.help ? 0 : 2);
  }
  if (!existsSync(resolve(options.input))) throw new Error(`input file not found: ${options.input}`);
  const input = JSON.parse(await readFile(resolve(options.input), "utf8"));
  const output = await validateReceipts(input);
  if (options.outputDir) {
    await mkdir(resolve(options.outputDir), { recursive: true });
    await writeFile(resolve(options.outputDir, "reset-receipt-validation.json"), `${JSON.stringify(output, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
  if (output.status !== "passed") process.exitCode = 1;
}
