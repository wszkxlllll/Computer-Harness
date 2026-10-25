import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, SIX_DOMAIN_SUITE_ID, SIX_DOMAIN_VARIANTS, SUITE_ID, manifestPathForSuite, pathExists, sha256 } from "./common.mjs";
import { buildInterleavedOrder, parseBatchArgs, prepareSixDomainBatch, SIX_DOMAIN_TASK_ORDER } from "./prepare-batch.mjs";

const fixtureConfig = {
  outputDir: "E:\\life-eval-output",
  profileLabel: "travel",
  wechatChat: "文件传输助手",
  cuaSocket: "offline-socket-fixture",
  candidateDriverPath: "E:\\cua\\candidate.exe",
  candidateDriverSha256: "A".repeat(64),
  candidateDriverVersion: "0.22.2",
  candidateDriverSource: "fixture-source",
  envFilePath: "E:\\private\\not-read.env",
  arkApiKeyEnv: "HUOSHAN_API_KEY",
};

async function fixtureConfigFor(outputRoot) {
  const candidateDriverPath = join(outputRoot, "candidate-driver.exe");
  const bytes = "fixture-only-batch-driver";
  await writeFile(candidateDriverPath, bytes, { encoding: "utf8", flag: "wx" });
  return { ...fixtureConfig, candidateDriverPath, candidateDriverSha256: sha256(bytes) };
}

test("batch requires an explicit shared date window and only accepts the new six-domain suite", async () => {
  const defaults = parseBatchArgs(["--as-of-date", "2026-10-18", "--travel-date", "2026-10-19"]);
  assert.deepEqual(defaults["--task-ids"], SIX_DOMAIN_TASK_ORDER);
  assert.equal(defaults["--risk-guard"], "layered");
  assert.throws(() => parseBatchArgs(["--travel-date", "2026-10-19"]), /--as-of-date is required/u);
  assert.throws(() => parseBatchArgs(["--as-of-date", "2026-10-18"]), /--travel-date is required/u);
  assert.throws(() => parseBatchArgs(["--suite", SUITE_ID, "--as-of-date", "2026-10-18", "--travel-date", "2026-10-19"]), /only supports/u);
  const invalidWindow = parseBatchArgs(["--as-of-date", "2026-10-18", "--travel-date", "2026-10-18"]);
  await assert.rejects(prepareSixDomainBatch(invalidWindow, { config: fixtureConfig }), /1 to 7 days/u);
  assert.throws(() => parseBatchArgs(["--as-of-date", "2026-10-18", "--travel-date", "2026-10-19", "--risk-guard", "disabled"]), /risk-guard must be off or layered/u);
});

test("interleaved order contains each task-arm pair exactly once and rotates the arm cycle", () => {
  assert.deepEqual(SIX_DOMAIN_TASK_ORDER, ["G01", "T03", "M02", "S02", "CM02", "CP02"]);
  const order = buildInterleavedOrder();
  assert.equal(order.length, 24);
  assert.deepEqual(order.slice(0, 8), [
    { taskId: "G01", variant: "A" },
    { taskId: "G01", variant: "C" },
    { taskId: "G01", variant: "D" },
    { taskId: "G01", variant: "B" },
    { taskId: "T03", variant: "C" },
    { taskId: "T03", variant: "D" },
    { taskId: "T03", variant: "B" },
    { taskId: "T03", variant: "A" },
  ]);
  assert.equal(new Set(order.map(({ taskId, variant }) => `${taskId}/${variant}`)).size, 24);
});

test("selected batches keep canonical arm rotation and propagate Risk Guard off to every package", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "life-eval-selected-batch-test-"));
  const seen = [];
  try {
    const config = await fixtureConfigFor(outputRoot);
    const taskIds = ["T03", "M02", "S02", "CM02", "CP02"];
    const args = parseBatchArgs([
      "--as-of-date", "2026-10-19",
      "--travel-date", "2026-10-22",
      "--output-dir", outputRoot,
      "--profile-label", "travel",
      "--task-ids", taskIds.join(","),
      "--risk-guard", "off",
    ]);
    const result = await prepareSixDomainBatch(args, {
      root: ROOT,
      manifestPath: manifestPathForSuite(SIX_DOMAIN_SUITE_ID),
      config,
      prepareOne: async (startArgs) => {
        seen.push(startArgs);
        const riskModel = startArgs["--risk-guard"] === "off" ? "off" : "same";
        return {
          packageId: `${startArgs["--task-id"]}-${startArgs["--variant"]}`,
          packageDir: join(outputRoot, `${startArgs["--task-id"]}-${startArgs["--variant"]}`),
          outputAttemptDir: join(outputRoot, SIX_DOMAIN_SUITE_ID, startArgs["--variant"], startArgs["--task-id"]),
          review: { preflight: { status: "pending" }, planSha256: "fixture-plan-hash" },
          plan: {
            configuration: {
              riskGuard: startArgs["--risk-guard"],
              riskModel,
              confirmRiskGuardOff: riskModel === "off",
              riskModelRequestsEnabled: riskModel !== "off",
              riskModelRequestLimitStatus: riskModel === "off" ? "inactive_risk_model_off" : "active",
              maxRiskModelRequests: 24,
              combinedRequestCeiling: 144,
              supervision: SIX_DOMAIN_VARIANTS[startArgs["--variant"]].supervision,
            },
          },
        };
      },
    });

    const order = buildInterleavedOrder(taskIds);
    assert.equal(result.batch.packages.length, 20);
    assert.deepEqual(result.batch.taskOrder, taskIds);
    assert.deepEqual(seen.map((item) => `${item["--task-id"]}/${item["--variant"]}`), order.map((item) => `${item.taskId}/${item.variant}`));
    assert.deepEqual(order.slice(0, 8), [
      { taskId: "T03", variant: "C" },
      { taskId: "T03", variant: "D" },
      { taskId: "T03", variant: "B" },
      { taskId: "T03", variant: "A" },
      { taskId: "M02", variant: "D" },
      { taskId: "M02", variant: "B" },
      { taskId: "M02", variant: "A" },
      { taskId: "M02", variant: "C" },
    ]);
    assert.ok(seen.every((item) => item["--risk-guard"] === "off"));
    assert.deepEqual(result.batch.riskPolicy, {
      riskGuard: "off",
      riskModel: "off",
      confirmRiskGuardOff: true,
      riskModelRequestsEnabled: false,
      riskRequestCapBehavior: "positive per-task CLI cap is retained but no risk-model requests are made",
    });
    assert.ok(result.batch.packages.every((item) => item.riskPolicy.riskModel === "off" && item.riskPolicy.confirmRiskGuardOff === true && item.riskPolicy.riskModelRequestsEnabled === false));
    assert.throws(() => parseBatchArgs([
      "--as-of-date", "2026-10-19", "--travel-date", "2026-10-22", "--task-ids", "T03,G99",
    ]), /comma-separated subset/u);
    assert.throws(() => parseBatchArgs([
      "--as-of-date", "2026-10-19", "--travel-date", "2026-10-22", "--task-ids", "T03,T03",
    ]), /duplicates/u);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("batch rejects a relative output path before creating its report directory", async () => {
  const relativeRoot = `relative-life-eval-output-${Math.random().toString(16).slice(2)}`;
  const args = parseBatchArgs([
    "--as-of-date", "2026-10-18",
    "--travel-date", "2026-10-19",
    "--output-dir", relativeRoot,
  ]);
  await assert.rejects(prepareSixDomainBatch(args, { config: fixtureConfig }), /--output-dir must be an absolute path/u);
  await assert.rejects(access(relativeRoot), { code: "ENOENT" });
});

test("batch freezes the same explicit dates into 24 offline packages and leaves GUI/live gates pending", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "life-eval-batch-test-"));
  const seen = [];
  try {
    const config = await fixtureConfigFor(outputRoot);
    const args = parseBatchArgs([
      "--suite", SIX_DOMAIN_SUITE_ID,
      "--as-of-date", "2026-10-18",
      "--travel-date", "2026-10-20",
      "--output-dir", outputRoot,
      "--profile-label", "travel",
    ]);
    const result = await prepareSixDomainBatch(args, {
      root: ROOT,
      manifestPath: manifestPathForSuite(SIX_DOMAIN_SUITE_ID),
      config,
      now: () => new Date("2026-10-18T02:00:00.000Z"),
      prepareOne: async (startArgs) => {
        seen.push(startArgs);
        const variant = startArgs["--variant"];
        return {
          packageId: `${startArgs["--task-id"]}-${variant}`,
          packageDir: join(outputRoot, `${startArgs["--task-id"]}-${variant}`),
          outputAttemptDir: join(outputRoot, SIX_DOMAIN_SUITE_ID, variant, startArgs["--task-id"]),
          review: { preflight: { status: "pending" }, planSha256: "fixture-plan-hash" },
          plan: { configuration: { supervision: SIX_DOMAIN_VARIANTS[variant].supervision } },
        };
      },
    });

    const order = buildInterleavedOrder();
    assert.equal(seen.length, 24);
    assert.equal(result.batch.status, "offline_packages_prepared_gui_preflight_pending");
    assert.equal(result.batch.asOfDate, "2026-10-18");
    assert.equal(result.batch.travelDate, "2026-10-20");
    assert.equal(result.batch.readiness.liveExecution, "not_authorized_by_this_batch_manifest");
    assert.equal(result.batch.readiness.guiPreflight, "pending_human_review");
    assert.equal(result.batch.readiness.providerCalls, false);
    assert.equal(result.batch.readiness.desktopControl, false);
    assert.equal(result.batch.readiness.environmentFileRead, false);
    assert.ok(seen.every((item) => item["--as-of-date"] === "2026-10-18" && item["--travel-date"] === "2026-10-20"));
    assert.deepEqual(seen.map((item) => `${item["--task-id"]}/${item["--variant"]}`), order.map((item) => `${item.taskId}/${item.variant}`));
    assert.deepEqual(result.batch.packages.map((item) => item.supervision.mode), order.map((item) => SIX_DOMAIN_VARIANTS[item.variant].supervision.mode));
    const saved = JSON.parse(await readFile(result.batchFile, "utf8"));
    assert.equal(saved.packages.length, 24);
    assert.equal(saved.packages.every((item) => item.humanPreflight === "pending_human_review"), true);
    assert.equal(await pathExists(result.batchFile), true);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("partial preparation records the failure and preserves prior package references", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "life-eval-batch-partial-test-"));
  let calls = 0;
  try {
    const config = await fixtureConfigFor(outputRoot);
    const args = parseBatchArgs([
      "--as-of-date", "2026-10-18",
      "--travel-date", "2026-10-19",
      "--output-dir", outputRoot,
    ]);
    await assert.rejects(prepareSixDomainBatch(args, {
      root: ROOT,
      manifestPath: manifestPathForSuite(SIX_DOMAIN_SUITE_ID),
      config,
      now: () => new Date("2026-10-18T02:00:00.000Z"),
      prepareOne: async (startArgs) => {
        calls += 1;
        if (calls === 2) throw new Error("fixture prepare failure");
        return {
          packageId: `${startArgs["--task-id"]}-${startArgs["--variant"]}`,
          packageDir: join(outputRoot, "first-package"),
          outputAttemptDir: join(outputRoot, "A", "G01"),
          review: { preflight: { status: "pending" }, planSha256: "fixture-plan-hash" },
          plan: { configuration: { supervision: SIX_DOMAIN_VARIANTS[startArgs["--variant"]].supervision } },
        };
      },
    }), /prior package artifacts were preserved/u);
    assert.equal(calls, 2);
    const batchParent = join(outputRoot, SIX_DOMAIN_SUITE_ID, "_batches");
    const { readdir } = await import("node:fs/promises");
    const [batchId] = await readdir(batchParent);
    const saved = JSON.parse(await readFile(join(batchParent, batchId, "batch.json"), "utf8"));
    assert.equal(saved.status, "partial_preparation_failed_artifacts_preserved");
    assert.equal(saved.packages[0].packageId, "G01-A");
    assert.equal(saved.packages[0].humanPreflight, "pending_human_review");
    assert.match(saved.failure, /fixture prepare failure/u);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});
