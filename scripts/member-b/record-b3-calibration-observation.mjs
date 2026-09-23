#!/usr/bin/env node

/** Record a human observation without manufacturing a completed reset receipt. */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const checklistPath = resolve(repo, "eval/member-b/b3-calibration-checklist.v0.json");
const allowedControls = new Set(["known_positive", "initial_state_negative", "partial_success", "critical_near_miss"]);
const args = process.argv.slice(2);
function value(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
const instanceId = value("--instance");
const control = value("--control");
const evidence = value("--evidence");
const notes = value("--notes") ?? "";
if (!instanceId || !allowedControls.has(control) || !evidence) {
  throw new Error("Usage: ... --instance <id> --control <control> --evidence <ref> [--notes <text>]");
}
const checklist = JSON.parse(await readFile(checklistPath, "utf8"));
const item = checklist.instances?.find((candidate) => candidate.instanceId === instanceId);
if (!item) throw new Error(`unknown instance: ${instanceId}`);
if (item.resetReceipt?.status !== "pending" || item.resetReceipt?.executed !== false) throw new Error(`${instanceId}: reset receipt is not pending`);
const record = item.controls?.[control];
if (!record) throw new Error(`${instanceId}: missing control ${control}`);
record.status = "observed_pending_receipt";
record.evidenceRefs = [...new Set([...(record.evidenceRefs ?? []), evidence])];
record.notes = notes;
item.lastObservation = new Date().toISOString();
await writeFile(checklistPath, `${JSON.stringify(checklist, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ status: "recorded_observation", instanceId, control, resetReceipt: item.resetReceipt.status, evidenceRefs: record.evidenceRefs })}\n`);
