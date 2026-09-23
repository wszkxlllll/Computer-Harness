#!/usr/bin/env node

/**
 * Build a non-scoring checklist for the four manual calibration controls.
 * It deliberately contains no expected answers and never marks a control done.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BINDING_PATH = resolve(REPO_ROOT, "eval/member-b/b3-development-manifest.v0.json");
const OUTPUT = resolve(REPO_ROOT, "eval/member-b/b3-calibration-checklist.v0.json");
const controls = ["known_positive", "initial_state_negative", "partial_success", "critical_near_miss"];

const binding = JSON.parse(await readFile(BINDING_PATH, "utf8"));
const instances = (binding.bindings ?? []).map((item) => ({
  taskId: item.taskId,
  instanceId: item.instanceId,
  familyId: item.familyId,
  variantId: item.variantId,
  seedId: item.seedId,
  fixtureVersion: item.fixtureVersion,
  resetReceipt: { status: "pending", executed: false },
  controls: Object.fromEntries(controls.map((control) => [control, {
    status: "pending",
    taskSatisfied: null,
    partial: null,
    safetyViolation: null,
    completionLevel: null,
    failureClass: null,
    evidenceRefs: [],
  }])),
  reviewer: null,
  reviewedAt: null,
}));

const checklist = {
  schemaVersion: 1,
  checklistId: "member-b-b3-calibration-checklist-v0",
  status: "pending_manual_review",
  modelRunAuthorized: false,
  bindingManifest: "eval/member-b/b3-development-manifest.v0.json",
  evaluatorContract: "eval/member-b/b3-evaluator-contract.v0.json",
  controlsRequired: controls,
  instances,
};

if (instances.length !== 24 || new Set(instances.map((item) => item.instanceId)).size !== 24) {
  throw new Error(`expected 24 unique instances, found ${instances.length}`);
}
for (const item of instances) {
  if (item.resetReceipt.status !== "pending" || item.resetReceipt.executed !== false) throw new Error(`${item.instanceId}: reset must remain pending`);
  if (controls.some((control) => item.controls[control].status !== "pending")) throw new Error(`${item.instanceId}: calibration must remain pending`);
}
await writeFile(OUTPUT, `${JSON.stringify(checklist, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ status: "passed", output: "eval/member-b/b3-calibration-checklist.v0.json", instances: instances.length, controlsPerInstance: controls.length })}\n`);
