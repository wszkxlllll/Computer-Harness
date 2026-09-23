#!/usr/bin/env node

/**
 * Offline audit for member-B development manifests.
 *
 * This checker intentionally does not import the Runtime, open a browser, call a
 * provider, or evaluate a business answer.  It checks only the data contract
 * needed before a B3 model run is allowed.  It accepts the planned candidate
 * manifest shape (taskFamilies + variants) and the current B2 flat task-card
 * shape (instances), which makes migration failures visible instead of silently
 * treating B2 as B3.
 */

import { readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DEFAULT_MANIFESTS = [
  // These are the additive B3 cards currently in the working tree.  The
  // planned candidate-manifest names do not exist yet, so defaulting to them
  // would hide the useful audit behind two misleading ENOENT errors.
  resolve(REPO_ROOT, "eval/member-b/b3-shopping-development.v0.json"),
  resolve(REPO_ROOT, "eval/member-b/b3-communication-task-cards.v0.json"),
];

const REQUIRED_DOMAINS = new Set(["shopping_after_sales", "communication_personal_affairs"]);
const REQUIRED_CALIBRATION = ["known_positive", "initial_state_negative", "partial_success", "critical_near_miss"];
const ANSWER_LEAK_KEYS = new Set(["answer", "goldAnswer", "expectedAnswer", "success", "score"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function parseArgs(argv) {
  const paths = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--manifest") {
      if (!nonEmpty(argv[i + 1])) throw new Error("--manifest requires a path");
      paths.push(resolve(process.cwd(), argv[i + 1]));
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      return { help: true, paths: [] };
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { help: false, paths: paths.length > 0 ? paths : DEFAULT_MANIFESTS };
}

function usage() {
  return [
    "Usage: node scripts/member-b/b3-audit.mjs [--manifest <path>]...",
    "",
    "Defaults to the current additive B3 shopping and communication card files.",
    "The command is read-only and exits non-zero when a B3 gate is not met.",
  ].join("\n");
}

function add(errors, path, message) {
  errors.push(`${path}: ${message}`);
}

function safeContractReference(key, value) {
  if (!["evaluator", "evaluation", "rubric"].includes(key)) return false;
  if (typeof value === "string") return /contract|adapter|rubric|^eval\//iu.test(value);
  if (!isRecord(value)) return false;
  const safeKeys = new Set(["contractRef", "adapter", "mode", "resultFields", "evidencePolicy"]);
  return Object.keys(value).every((childKey) => safeKeys.has(childKey));
}

function findAnswerLeak(value, path, hits = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findAnswerLeak(item, `${path}[${index}]`, hits));
  } else if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (ANSWER_LEAK_KEYS.has(key) && !safeContractReference(key, child)) hits.push(`${path}.${key}`);
      findAnswerLeak(child, `${path}.${key}`, hits);
    }
  }
  return hits;
}

function extractFamilies(manifest, errors, additiveB3 = false) {
  if (Array.isArray(manifest.taskFamilies)) return manifest.taskFamilies;
  if (Array.isArray(manifest.families)) return manifest.families;
  if (!additiveB3) add(errors, "manifest", "missing taskFamilies/families; cannot verify family split");
  return [];
}

function extractInstances(manifest, families, errors) {
  if (Array.isArray(manifest.instances)) return manifest.instances;
  const result = [];
  families.forEach((family, familyIndex) => {
    if (!isRecord(family) || !Array.isArray(family.variants)) return;
    family.variants.forEach((variant, variantIndex) => {
      result.push({
        ...(isRecord(variant) ? variant : {}),
        familyId: family.id,
        split: variant?.split ?? family.split,
        variantId: variant?.variantId ?? variant?.id,
        __familyIndex: familyIndex,
        __variantIndex: variantIndex,
      });
    });
  });
  if (result.length === 0) add(errors, "manifest", "no instances or family variants found");
  return result;
}

function calibrationKeys(instance, manifest) {
  const sources = [
    instance.calibration,
    instance.calibrationControls,
    manifest.calibration,
    manifest.calibrationControls,
  ].filter(isRecord);
  const keys = new Set();
  for (const source of sources) {
    const required = Array.isArray(source.requiredPerInstance) ? source.requiredPerInstance : [];
    required.forEach((key) => keys.add(key));
    for (const key of REQUIRED_CALIBRATION) if (source[key] !== undefined) keys.add(key);
  }
  return keys;
}

function instanceId(instance, index) {
  return instance.instanceId ?? instance.taskId ?? (instance.familyId && instance.variantId ? `${instance.familyId}/${instance.variantId}` : `index-${index + 1}`);
}

function fieldPresent(instance, names) {
  return names.some((name) => nonEmpty(instance[name]) || isRecord(instance[name]) || Array.isArray(instance[name]));
}

export function auditManifest(manifest, filePath) {
  const errors = [];
  const warnings = [];
  if (!isRecord(manifest)) return { file: filePath, errors: ["manifest: root must be an object"], warnings, counts: {} };

  if (manifest.schemaVersion !== 1) add(errors, "schemaVersion", "must be 1");
  if (!nonEmpty(manifest.manifestId)) add(errors, "manifestId", "must be a non-empty stable identifier");
  const declaredDomains = new Set([
    ...(nonEmpty(manifest.domain) ? [manifest.domain] : []),
    ...(Array.isArray(manifest.domains) ? manifest.domains.filter(nonEmpty) : []),
  ]);
  if (![...REQUIRED_DOMAINS].some((domain) => declaredDomains.has(domain))) add(errors, "domain/domains", "must identify shopping_after_sales or communication_personal_affairs");
  if (manifest.status === "draft_not_executable" || manifest.status === "manual_calibration_in_progress") {
    warnings.push(`manifest.status=${manifest.status}; this is a B2/preparation asset, not a frozen B3 candidate`);
  }

  const additiveB3 = (isRecord(manifest.instancePolicy) && manifest.instancePolicy.expectedTotal === 8)
    || (/\/b3-[^/]+\.json$/u.test(filePath) && Array.isArray(manifest.instances) && manifest.instances.length === 8);
  const families = extractFamilies(manifest, errors, additiveB3);
  const familyIds = new Set();
  const familySplit = new Map();
  for (const [index, family] of families.entries()) {
    const path = `families[${index}]`;
    if (!isRecord(family)) { add(errors, path, "must be an object"); continue; }
    if (!nonEmpty(family.id ?? family.familyId)) add(errors, path, "missing family id");
    const id = family.id ?? family.familyId;
    if (familyIds.has(id)) add(errors, path, `duplicate family id ${id}`);
    familyIds.add(id);
    if (family.split !== "development" && family.split !== "heldout") add(errors, `${path}.split`, "must be development or heldout");
    familySplit.set(id, family.split);
    if (!Array.isArray(family.variants) || family.variants.length !== 2) add(errors, path, "must contain exactly two variants");
  }

  const split = isRecord(manifest.split) ? manifest.split : {};
  const developmentFamilies = split.developmentFamilies ?? split.development;
  const heldoutFamilies = split.heldoutFamilies ?? split.heldout;
  if (!additiveB3 && (!Array.isArray(developmentFamilies) || developmentFamilies.length !== 6)) add(errors, "split.developmentFamilies", "must list exactly 6 development families");
  if (!additiveB3 && (!Array.isArray(heldoutFamilies) || heldoutFamilies.length !== 4)) add(errors, "split.heldoutFamilies", "must list exactly 4 heldout families");
  if (!additiveB3 && Array.isArray(developmentFamilies) && Array.isArray(heldoutFamilies)) {
    const listed = [...developmentFamilies, ...heldoutFamilies];
    if (new Set(listed).size !== listed.length) add(errors, "split", "development and heldout family lists overlap");
    for (const id of listed) if (!familyIds.has(id)) add(errors, "split", `unknown family ${id}`);
    for (const [id, value] of familySplit) {
      const expected = developmentFamilies.includes(id) ? "development" : heldoutFamilies.includes(id) ? "heldout" : null;
      if (expected !== value) add(errors, `family:${id}`, `split=${value} disagrees with split lists`);
    }
  }

  const instances = extractInstances(manifest, families, errors);
  const ids = new Set();
  const development = [];
  const byFamily = new Map();
  for (const [index, instance] of instances.entries()) {
    const path = `instances[${index}]`;
    const id = instanceId(instance, index);
    if (ids.has(id)) add(errors, path, `duplicate instance id ${id}`);
    ids.add(id);
    if (!nonEmpty(instance.familyId)) add(errors, `${path}.familyId`, "required for task/seed binding");
    if (!nonEmpty(instance.variantId ?? instance.id) && !nonEmpty(instance.instanceId ?? instance.taskId)) add(errors, `${path}.variantId`, "required for deterministic instance binding");
    const instanceSplit = instance.split ?? manifest.split;
    if (instanceSplit !== "development" && instanceSplit !== "heldout") add(errors, `${path}.split`, "must be development or heldout");
    if (instanceSplit === "development") development.push(instance);
    if (nonEmpty(instance.familyId)) byFamily.set(instance.familyId, (byFamily.get(instance.familyId) ?? 0) + 1);

    if (!fieldPresent(instance, ["goal", "goalTemplate"])) add(errors, path, "missing goal/goalTemplate");
    if (!fieldPresent(instance, ["reset", "resetMethod", "resetReceipt", "initialState"])) add(errors, path, "missing reset/initial-state contract");
    if (!fieldPresent(instance, ["evaluator", "evaluation", "rubric", "score", "expectedFields"])) add(errors, path, "missing evaluator/rubric contract");
    if (!fieldPresent(instance, ["cleanup", "cleanupMethod"])) add(errors, path, "missing cleanup contract");
    if (!fieldPresent(instance, ["urlPath", "fixture", "entry", "surface"])) add(errors, path, "missing fixture/entry surface binding");
    if (!Array.isArray(instance.allowed) || instance.allowed.length === 0) add(errors, `${path}.allowed`, "must list allowed actions");
    if (!Array.isArray(instance.forbidden) || instance.forbidden.length === 0) add(errors, `${path}.forbidden`, "must list forbidden actions");
    if (nonEmpty(instance.urlPath)) {
      const fixturePath = instance.urlPath.split("?", 1)[0].replace(/^\//u, "");
      const absoluteFixture = resolve(REPO_ROOT, fixturePath);
      if (!absoluteFixture.startsWith(`${REPO_ROOT}/`) || !requireFileExists(absoluteFixture)) add(errors, `${path}.urlPath`, `fixture file is missing: ${fixturePath}`);
    }
    const calibration = calibrationKeys(instance, manifest);
    for (const key of REQUIRED_CALIBRATION) if (!calibration.has(key)) add(errors, `${path}.calibration`, `missing ${key}`);
  }

  const expectedDevelopment = manifest.expectedDevelopmentInstanceCount ?? (additiveB3 ? manifest.instancePolicy?.expectedTotal ?? 8 : 12);
  if (development.length !== expectedDevelopment) add(errors, "instances", `found ${development.length} development instances; expected ${expectedDevelopment} (6 families × 2)`);
  for (const [familyId, count] of byFamily) {
    if (familySplit.get(familyId) === "development" && count !== 2) add(errors, `family:${familyId}`, `has ${count} instances; expected exactly 2`);
  }
  if (additiveB3) {
    if (!isRecord(manifest.instancePolicy) || manifest.instancePolicy.expectedTotal !== 8) add(errors, "instancePolicy", "additive B3 manifest must declare expectedTotal=8");
    if (byFamily.size !== 4) add(errors, "instancePolicy", `found ${byFamily.size} families; additive B3 manifest must contain 4 new development families`);
    for (const [familyId, count] of byFamily) if (count !== 2) add(errors, `family:${familyId}`, `has ${count} instances; expected exactly 2`);
  }
  const leakHits = findAnswerLeak(manifest, "manifest");
  if (leakHits.length > 0) add(errors, "manifest", `answer-like fields exposed: ${leakHits.join(", ")}`);

  if (manifest.syntheticOnly === false) warnings.push("syntheticOnly=false; do not include this asset in controlled-fixture B3 without a separate safety review");
  if (manifest.modelRunAuthorized === true) warnings.push("modelRunAuthorized=true; this audit does not authorize a model run");
  return {
    file: filePath,
    status: errors.length === 0 ? "passed" : "blocked",
    errors,
    warnings,
    counts: { families: families.length, instances: instances.length, developmentInstances: development.length, familyIds: familyIds.size },
  };
}

function requireFileExists(path) {
  // The audit is async for manifest input, but a synchronous existence check
  // keeps the per-instance validation readable and has no side effects.
  try { return statSync(path).isFile(); } catch { return false; }
}

async function load(path) {
  try {
    const raw = await readFile(path, "utf8");
    return auditManifest(JSON.parse(raw), path);
  } catch (error) {
    return { file: path, status: "blocked", errors: [`cannot read/parse manifest: ${error instanceof Error ? error.message : String(error)}`], warnings: [], counts: {} };
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) { process.stdout.write(`${usage()}\n`); return 0; }
  const results = await Promise.all(options.paths.map(load));
  const output = { schemaVersion: "member-b-b3-audit-v1", status: results.every((result) => result.status === "passed") ? "passed" : "blocked", manifests: results };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return output.status === "passed" ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
