#!/usr/bin/env node

/** Build model-facing B3 candidate manifests from evaluator-only task cards. */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sources = [
  {
    input: "eval/member-b/b3-shopping-development.v0.json",
    output: "eval/member-b/b3-shopping-candidate.v0.json",
    manifestId: "member-b-b3-shopping-candidate-v0",
    domainKey: "domain",
  },
  {
    input: "eval/member-b/b3-communication-task-cards.v0.json",
    output: "eval/member-b/b3-communication-candidate.v0.json",
    manifestId: "member-b-b3-communication-candidate-v0",
    domainKey: "domains",
  },
];
const controls = ["known_positive", "initial_state_negative", "partial_success", "critical_near_miss"];

function candidateVariant(task, familyId) {
  return {
    instanceId: task.instanceId,
    familyId,
    variantId: task.instanceId.match(/-(v\d+)$/u)?.[1] ?? task.variantId,
    split: "development",
    surface: task.surface,
    urlPath: task.urlPath,
    goal: task.goal,
    allowed: task.allowed,
    forbidden: task.forbidden,
    reset: task.reset,
    cleanup: task.cleanup,
    evaluator: "eval/member-b/b3-evaluator-contract.v0.json",
    rubric: "member-b-b3-evaluator-adapter-v0",
  };
}

for (const source of sources) {
  const inputPath = resolve(REPO_ROOT, source.input);
  const outputPath = resolve(REPO_ROOT, source.output);
  const manifest = JSON.parse(await readFile(inputPath, "utf8"));
  const byFamily = new Map();
  for (const task of manifest.instances ?? []) {
    const familyId = task.familyId;
    if (!byFamily.has(familyId)) byFamily.set(familyId, []);
    byFamily.get(familyId).push(candidateVariant(task, familyId));
  }
  const taskFamilies = [...byFamily.entries()].map(([id, variants]) => ({ id, split: "development", variants }));
  const candidate = {
    schemaVersion: 1,
    manifestId: source.manifestId,
    status: "prepared_not_authorized",
    fixtureVersion: manifest.fixtureVersion,
    ...(source.domainKey === "domain" ? { domain: manifest.domain } : { domains: manifest.domains }),
    split: { developmentFamilies: taskFamilies.map((family) => family.id), heldoutFamilies: [] },
    syntheticOnly: true,
    modelRunAuthorized: false,
    instancePolicy: {
      families: taskFamilies.length,
      instancesPerFamily: 2,
      expectedTotal: taskFamilies.length * 2,
      heldoutExposure: "none",
    },
    expectedDevelopmentInstanceCount: taskFamilies.length * 2,
    calibration: {
      requiredPerInstance: controls,
      manualReviewRequired: true,
      modelRunBlockedUntilComplete: true,
    },
    evaluatorContract: "eval/member-b/b3-evaluator-contract.v0.json",
    taskFamilies,
  };
  await writeFile(outputPath, `${JSON.stringify(candidate, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ status: "built", output: source.output, families: taskFamilies.length, instances: taskFamilies.length * 2 })}\n`);
}
