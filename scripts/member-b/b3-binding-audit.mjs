#!/usr/bin/env node

/**
 * Read-only binding audit for the member-B B2+B3 development pool.
 *
 * This checker deliberately reads metadata and identity fields only.  It does
 * not expose goals, expected answers, scoring rules, or source seed contents
 * to a runner/model, and it never opens a browser or executes a reset.
 *
 * The aggregate manifest is a pre-run binding ledger.  Every resetReceipt must
 * remain pending here; a completed receipt can only be emitted by the
 * environment controller after a real reset and must not be fabricated in
 * this static asset.
 */

import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, relative } from "node:path";
import process from "node:process";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DEFAULT_MANIFEST = resolve(REPO_ROOT, "eval/member-b/b3-development-manifest.v0.json");
const REQUIRED_BINDING_KEYS = [
  "taskId",
  "familyId",
  "variantId",
  "seedId",
  "manifestId",
  "fixtureVersion",
  "instanceId",
  "split",
  "sourceKey",
  "resetReceipt",
];
const ANSWER_OR_TASK_CONTENT_KEYS = new Set([
  "goal",
  "goalTemplate",
  "allowed",
  "forbidden",
  "expected",
  "success",
  "partial",
  "nearMiss",
  "evaluator",
  "evaluation",
  "rubric",
  "score",
  "expectedFields",
]);
const EXPECTED_SOURCE_COUNTS = new Map([
  ["b2-shopping", 4],
  ["b2-communication", 4],
  ["b3-shopping", 8],
  ["b3-communication", 8],
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function add(errors, path, message) {
  errors.push(`${path}: ${message}`);
}

function exists(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function repoPath(relativePath) {
  if (!nonEmpty(relativePath) || relativePath.startsWith("/") || relativePath.includes("..")) return null;
  const resolved = resolve(REPO_ROOT, relativePath);
  if (!resolved.startsWith(`${REPO_ROOT}/`)) return null;
  return resolved;
}

function loadJson(path, errors, label) {
  try {
    const value = JSON.parse(requireText(path));
    if (!isRecord(value)) add(errors, label, "JSON root must be an object");
    return value;
  } catch (error) {
    add(errors, label, `cannot read/parse: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

// This synchronous helper is intentionally limited to metadata-sized JSON.
// It keeps source loading deterministic while the public audit remains async.
function requireText(path) {
  // eslint-disable-next-line no-sync
  return readFileSync(path, "utf8");
}

function findForbiddenKeys(value, path, hits = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findForbiddenKeys(item, `${path}[${index}]`, hits));
  } else if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (ANSWER_OR_TASK_CONTENT_KEYS.has(key)) hits.push(`${path}.${key}`);
      findForbiddenKeys(child, `${path}.${key}`, hits);
    }
  }
  return hits;
}

function manifestDomains(manifest) {
  return new Set([
    ...(nonEmpty(manifest?.domain) ? [manifest.domain] : []),
    ...(Array.isArray(manifest?.domains) ? manifest.domains.filter(nonEmpty) : []),
  ]);
}

function variantFromInstanceId(instanceId) {
  const match = /-(v\d+)$/u.exec(instanceId ?? "");
  return match?.[1] ?? null;
}

function fixturePathFromUrl(urlPath) {
  if (!nonEmpty(urlPath)) return null;
  return urlPath.split("?", 1)[0].replace(/^\//u, "");
}

function indexSeed(seed) {
  const families = Array.isArray(seed?.families) ? seed.families : [];
  const result = new Map();
  for (const family of families) {
    const familyId = family?.familyId ?? family?.id;
    for (const variant of Array.isArray(family?.variants) ? family.variants : []) {
      const variantId = variant?.variantId ?? variant?.id;
      const key = `${familyId}/${variantId}`;
      result.set(key, variant);
    }
  }
  return result;
}

function indexCards(manifest) {
  return new Map((Array.isArray(manifest?.instances) ? manifest.instances : [])
    .filter((instance) => nonEmpty(instance?.instanceId))
    .map((instance) => [instance.instanceId, instance]));
}

function auditAggregate(aggregate, aggregatePath) {
  const errors = [];
  const warnings = [];
  const counts = {
    sourceManifests: 0,
    bindings: 0,
    developmentBindings: 0,
    families: 0,
    pendingResetReceipts: 0,
    completedResetReceipts: 0,
  };

  if (!isRecord(aggregate)) return { status: "blocked", errors: ["aggregate: root must be an object"], warnings, counts };
  if (aggregate.schemaVersion !== 1) add(errors, "schemaVersion", "must be 1");
  if (aggregate.kind !== "member-b-development-binding") add(errors, "kind", "must be member-b-development-binding");
  if (aggregate.manifestId !== "member-b-b3-development-binding-v0") add(errors, "manifestId", "unexpected stable binding manifest ID");
  if (aggregate.status !== "manual_calibration_in_progress") add(errors, "status", "must remain manual_calibration_in_progress before calibration");
  if (aggregate.split !== "development") add(errors, "split", "must be development");
  if (aggregate.syntheticOnly !== true) add(errors, "syntheticOnly", "must be true");
  if (aggregate.modelRunAuthorized !== false) add(errors, "modelRunAuthorized", "must be false in this pre-run asset");

  const policy = aggregate.resetReceiptPolicy;
  if (!isRecord(policy) || policy.mode !== "pending_only" || policy.executedReceiptRequiredBeforeRun !== true || policy.forbidSyntheticCompletion !== true) {
    add(errors, "resetReceiptPolicy", "must require pending-only pre-run state and a real environment receipt before execution");
  }

  const calibration = aggregate.calibrationPolicy;
  const requiredControls = ["known_positive", "initial_state_negative", "partial_success", "critical_near_miss"];
  if (!isRecord(calibration) || calibration.status !== "pending_for_all_bindings" || calibration.manualReviewRequired !== true || calibration.modelRunBlockedUntilComplete !== true || JSON.stringify(calibration.requiredControlsPerInstance) !== JSON.stringify(requiredControls)) {
    add(errors, "calibrationPolicy", "must require all four manual controls for every binding before model execution");
  }
  const evaluator = aggregate.evaluatorContract;
  const requiredResultFields = ["taskSatisfied", "partial", "safetyViolation", "completionLevel", "failureClass", "evidenceRefs"];
  if (!isRecord(evaluator) || evaluator.status !== "not_connected" || evaluator.modelRunBlockedUntilConnected !== true || JSON.stringify(evaluator.requiredResultFields) !== JSON.stringify(requiredResultFields)) {
    add(errors, "evaluatorContract", "must keep model execution blocked until an evaluator exposes the required result fields");
  }

  const sources = Array.isArray(aggregate.sourceManifests) ? aggregate.sourceManifests : [];
  counts.sourceManifests = sources.length;
  if (sources.length !== 4) add(errors, "sourceManifests", "must contain the four B2/B3 domain sources");
  const sourceByKey = new Map();
  const sourceContext = new Map();
  for (const [index, source] of sources.entries()) {
    const path = `sourceManifests[${index}]`;
    if (!isRecord(source)) { add(errors, path, "must be an object"); continue; }
    if (!nonEmpty(source.sourceKey)) add(errors, `${path}.sourceKey`, "required");
    if (sourceByKey.has(source.sourceKey)) add(errors, `${path}.sourceKey`, `duplicate ${source.sourceKey}`);
    sourceByKey.set(source.sourceKey, source);
    for (const key of ["manifestPath", "manifestId", "seedPath", "seedId", "fixturePath", "fixtureVersion", "domain"]) {
      if (!nonEmpty(source[key])) add(errors, `${path}.${key}`, "required");
    }
    if (source.split !== "development") add(errors, `${path}.split`, "must be development");

    const manifestPath = repoPath(source.manifestPath);
    const seedPath = repoPath(source.seedPath);
    const fixturePath = repoPath(source.fixturePath);
    if (!manifestPath || !exists(manifestPath)) add(errors, `${path}.manifestPath`, "source manifest file is missing or escapes repository");
    if (!seedPath || !exists(seedPath)) add(errors, `${path}.seedPath`, "source seed file is missing or escapes repository");
    if (!fixturePath || !exists(fixturePath)) add(errors, `${path}.fixturePath`, "fixture file is missing or escapes repository");

    const sourceManifest = manifestPath && exists(manifestPath) ? loadJson(manifestPath, errors, `${path}.manifestPath`) : null;
    const seed = seedPath && exists(seedPath) ? loadJson(seedPath, errors, `${path}.seedPath`) : null;
    if (sourceManifest) {
      if (sourceManifest.manifestId !== source.manifestId) add(errors, `${path}.manifestId`, `does not match source manifest (${sourceManifest.manifestId ?? "missing"})`);
      if (sourceManifest.fixtureVersion !== source.fixtureVersion) add(errors, `${path}.fixtureVersion`, `does not match source manifest (${sourceManifest.fixtureVersion ?? "missing"})`);
      if (sourceManifest.split !== "development") add(errors, `${path}.manifest.split`, "source manifest must be development");
      if (!manifestDomains(sourceManifest).has(source.domain)) add(errors, `${path}.domain`, `source manifest does not declare ${source.domain}`);
      const cards = indexCards(sourceManifest);
      if (cards.size === 0) add(errors, `${path}.manifestPath`, "source manifest has no flat instances");
      if (fixturePath) {
        for (const [instanceId, instance] of cards) {
          const actualFixture = fixturePathFromUrl(instance.urlPath);
          if (actualFixture !== source.fixturePath) add(errors, `${path}.manifestPath#${instanceId}`, `urlPath fixture ${actualFixture ?? "missing"} does not match ${source.fixturePath}`);
        }
      }
      sourceContext.set(source.sourceKey, { source, sourceManifest, cards, seed, seedIndex: indexSeed(seed) });
    }
    if (seed) {
      if (seed.seedId !== source.seedId) add(errors, `${path}.seedId`, `does not match source seed (${seed.seedId ?? "missing"})`);
      if (seed.domain !== source.domain) add(errors, `${path}.domain`, `does not match source seed (${seed.domain ?? "missing"})`);
      const seedFamilies = Array.isArray(seed.families) ? seed.families : [];
      const seedIsDevelopment = seed.split === "development"
        || (seed.split === undefined && seedFamilies.length > 0 && seedFamilies.every((family) => family?.split === "development"));
      if (!seedIsDevelopment) add(errors, `${path}.seed.split`, "source seed must be development (top-level or every family)");
    }
  }

  const bindings = Array.isArray(aggregate.bindings) ? aggregate.bindings : [];
  counts.bindings = bindings.length;
  if (bindings.length !== 24) add(errors, "bindings", `must contain exactly 24 development bindings; found ${bindings.length}`);
  const taskIds = new Set();
  const instanceIds = new Set();
  const familyVariants = new Set();
  const sourceCounts = new Map();
  const familyIds = new Set();
  for (const [index, binding] of bindings.entries()) {
    const path = `bindings[${index}]`;
    if (!isRecord(binding)) { add(errors, path, "must be an object"); continue; }
    for (const key of REQUIRED_BINDING_KEYS) if (!(key in binding)) add(errors, `${path}.${key}`, "required");
    for (const key of ["taskId", "familyId", "variantId", "seedId", "manifestId", "fixtureVersion", "instanceId", "sourceKey"]) {
      if (!nonEmpty(binding[key])) add(errors, `${path}.${key}`, "must be a non-empty string");
    }
    if (binding.split !== "development") add(errors, `${path}.split`, "must be development");
    if (binding.taskId !== `MB-${binding.instanceId}`) add(errors, `${path}.taskId`, "must be the stable MB-<instanceId> binding ID");
    if (variantFromInstanceId(binding.instanceId) !== binding.variantId) add(errors, `${path}.variantId`, "must match the vN suffix in instanceId");
    if (taskIds.has(binding.taskId)) add(errors, `${path}.taskId`, `duplicate ${binding.taskId}`);
    if (instanceIds.has(binding.instanceId)) add(errors, `${path}.instanceId`, `duplicate ${binding.instanceId}`);
    if (familyVariants.has(`${binding.familyId}/${binding.variantId}`)) add(errors, `${path}`, `duplicate family/variant ${binding.familyId}/${binding.variantId}`);
    taskIds.add(binding.taskId); instanceIds.add(binding.instanceId); familyVariants.add(`${binding.familyId}/${binding.variantId}`); familyIds.add(binding.familyId);
    sourceCounts.set(binding.sourceKey, (sourceCounts.get(binding.sourceKey) ?? 0) + 1);
    const context = sourceContext.get(binding.sourceKey);
    if (!context) { add(errors, `${path}.sourceKey`, `unknown source ${binding.sourceKey}`); continue; }
    const { source, cards, seedIndex } = context;
    for (const key of ["seedId", "manifestId", "fixtureVersion"]) if (binding[key] !== source[key]) add(errors, `${path}.${key}`, `does not match source ${key}=${source[key]}`);
    const card = cards.get(binding.instanceId);
    if (!card) { add(errors, `${path}.instanceId`, "not present in source task-card manifest"); continue; }
    if (card.familyId !== binding.familyId) add(errors, `${path}.familyId`, `does not match source card ${card.familyId ?? "missing"}`);
    const seedVariant = seedIndex.get(`${binding.familyId}/${binding.variantId}`);
    if (!seedVariant) add(errors, `${path}`, "family/variant is not present in source seed");
    else if (nonEmpty(seedVariant.instanceId) && seedVariant.instanceId !== binding.instanceId) add(errors, `${path}.instanceId`, `does not match source seed ${seedVariant.instanceId}`);

    const receipt = binding.resetReceipt;
    if (!isRecord(receipt) || receipt.status !== "pending" || receipt.executed !== false || receipt.reason !== "requires_environment_controller") {
      add(errors, `${path}.resetReceipt`, "must remain exactly pending/not-executed until the environment controller runs reset");
    } else {
      counts.pendingResetReceipts += 1;
    }
    for (const forbiddenKey of ["initialStateHash", "resetAt", "environmentVersion", "receiptId", "completedAt"]) {
      if (forbiddenKey in (receipt ?? {})) add(errors, `${path}.resetReceipt.${forbiddenKey}`, "must not be fabricated in the static binding asset");
    }
    if (receipt?.status === "completed" || receipt?.executed === true) counts.completedResetReceipts += 1;
  }
  counts.developmentBindings = bindings.filter((binding) => binding?.split === "development").length;
  counts.families = familyIds.size;
  for (const [sourceKey, expected] of EXPECTED_SOURCE_COUNTS) {
    if (sourceCounts.get(sourceKey) !== expected) add(errors, `bindings/${sourceKey}`, `expected ${expected} bindings; found ${sourceCounts.get(sourceKey) ?? 0}`);
  }
  for (const [sourceKey, actual] of sourceCounts) if (!EXPECTED_SOURCE_COUNTS.has(sourceKey)) add(errors, "bindings.sourceKey", `unexpected source ${sourceKey} (${actual} bindings)`);
  if (familyIds.size !== 12) add(errors, "bindings", `expected 12 families across B2+B3; found ${familyIds.size}`);
  for (const familyVariant of familyVariants) {
    const count = bindings.filter((binding) => `${binding.familyId}/${binding.variantId}` === familyVariant).length;
    if (count !== 1) add(errors, `bindings/${familyVariant}`, `expected exactly one binding; found ${count}`);
  }

  const leakHits = findForbiddenKeys(aggregate, "aggregate");
  if (leakHits.length > 0) add(errors, "aggregate", `answer/task content keys must not enter the binding manifest: ${leakHits.join(", ")}`);
  if (counts.completedResetReceipts > 0) add(errors, "resetReceipt", "completed receipts are forbidden in this pre-run aggregate");
  if (counts.pendingResetReceipts !== bindings.length) add(errors, "resetReceipt", `only ${counts.pendingResetReceipts}/${bindings.length} bindings are pending-only`);

  if (aggregate.status === "manual_calibration_in_progress") warnings.push("manual calibration is still required; this audit does not authorize a model run");
  warnings.push("reset receipts are pending placeholders; no reset was executed by this read-only audit");
  return {
    status: errors.length === 0 ? "passed" : "blocked",
    aggregate: relative(REPO_ROOT, aggregatePath),
    errors,
    warnings,
    counts,
  };
}

function parseArgs(argv) {
  let manifest = DEFAULT_MANIFEST;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--manifest") {
      if (!nonEmpty(argv[index + 1])) throw new Error("--manifest requires a path");
      manifest = resolve(process.cwd(), argv[index + 1]); index += 1;
    } else if (arg === "--help" || arg === "-h") {
      return { help: true, manifest };
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { help: false, manifest };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write("Usage: node scripts/member-b/b3-binding-audit.mjs [--manifest <path>]\n");
    return 0;
  }
  const errors = [];
  if (!exists(options.manifest)) add(errors, "manifest", `file is missing: ${options.manifest}`);
  const aggregate = errors.length === 0 ? loadJson(options.manifest, errors, "manifest") : null;
  const result = errors.length > 0 ? { status: "blocked", aggregate: relative(REPO_ROOT, options.manifest), errors, warnings: [], counts: {} } : auditAggregate(aggregate, options.manifest);
  process.stdout.write(`${JSON.stringify({ schemaVersion: "member-b-b3-binding-audit-v1", ...result }, null, 2)}\n`);
  return result.status === "passed" ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
