#!/usr/bin/env node

/**
 * Build the model-facing B3 task view.
 *
 * Source task cards remain evaluator-only because they contain expected,
 * success, partial and nearMiss fields.  This projection keeps only the
 * instruction and safe entry metadata needed to launch a controlled run.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUTPUT = resolve(REPO_ROOT, "eval/member-b/b3-model-view.v0.json");
const SOURCES = [
  "eval/member-b/b2-task-cards.v0.json",
  "eval/member-b/b3-shopping-development.v0.json",
  "eval/member-b/b3-communication-task-cards.v0.json",
];
const FORBIDDEN_KEYS = new Set([
  "expected",
  "success",
  "partial",
  "nearMiss",
  "evaluator",
  "evaluation",
  "rubric",
  "score",
  "calibrationControls",
  "reset",
  "cleanup",
  "resetReceipt",
  "modelRunAuthorized",
]);

function findForbidden(value, path = "view", hits = []) {
  if (Array.isArray(value)) value.forEach((item, index) => findForbidden(item, `${path}[${index}]`, hits));
  else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) hits.push(`${path}.${key}`);
      findForbidden(child, `${path}.${key}`, hits);
    }
  }
  return hits;
}

const instances = [];
const sourceManifests = [];
for (const relativePath of SOURCES) {
  const path = resolve(REPO_ROOT, relativePath);
  const manifest = JSON.parse(await readFile(path, "utf8"));
  sourceManifests.push({
    path: relativePath,
    manifestId: manifest.manifestId,
    fixtureVersion: manifest.fixtureVersion,
  });
  for (const item of manifest.instances ?? []) {
    instances.push({
      instanceId: item.instanceId,
      familyId: item.familyId,
      variantId: item.instanceId?.match(/-(v\d+)$/u)?.[1] ?? null,
      surface: item.surface,
      urlPath: item.urlPath,
      goal: item.goal,
      allowed: item.allowed,
      forbidden: item.forbidden,
      syntheticOnly: true,
      safetyBoundary: "仅限本地合成测试；不得下单、付款、发送真实消息、写入个人日历或读取私人文件。",
    });
  }
}

const view = {
  schemaVersion: 1,
  viewId: "member-b-b3-model-view-v0",
  status: "prepared_not_authorized",
  sourceKind: "projection_from_evaluator_only_task_cards",
  sourceManifests,
  instances,
};

const leaks = findForbidden(view);
if (leaks.length > 0) throw new Error(`model view contains evaluator-only keys: ${leaks.join(", ")}`);
if (instances.length !== 24 || new Set(instances.map((item) => item.instanceId)).size !== 24) {
  throw new Error(`expected 24 unique model-view instances, found ${instances.length}`);
}
await writeFile(OUTPUT, `${JSON.stringify(view, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ status: "passed", output: "eval/member-b/b3-model-view.v0.json", instances: instances.length, answerLeakCount: leaks.length })}\n`);
