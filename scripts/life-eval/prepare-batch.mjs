import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ROOT,
  MANAGED_BROWSER_LABEL_RE,
  SIX_DOMAIN_SUITE_ID,
  assertApiKeyEnvName,
  jsonText,
  manifestPathForSuite,
  parseFlags,
  parseIsoDate,
  suiteDefinition,
  verifyCuaDriverBinary,
} from "./common.mjs";
import { loadLocalConfig, parseStartArgs, prepareFromStartArgs } from "./start.mjs";
import { resolveRiskGuard } from "./prepare.mjs";

export const SIX_DOMAIN_TASK_ORDER = Object.freeze(["G01", "T03", "M02", "S02", "CM02", "CP02"]);
export const SIX_DOMAIN_ARM_CYCLE = Object.freeze(["A", "C", "D", "B"]);
const VALUE_FLAGS = new Set(["--suite", "--output-dir", "--profile-label", "--as-of-date", "--travel-date", "--api-key-env", "--cua-socket", "--task-ids", "--risk-guard"]);
const BOOLEAN_FLAGS = new Set(["--help"]);

export function parseBatchTaskIds(value) {
  const taskIds = value === undefined
    ? [...SIX_DOMAIN_TASK_ORDER]
    : Array.isArray(value)
      ? [...value]
      : typeof value === "string"
        ? value.split(",")
        : [];
  if (taskIds.length === 0 || taskIds.some((taskId) => typeof taskId !== "string" || taskId.trim() !== taskId || !SIX_DOMAIN_TASK_ORDER.includes(taskId))) {
    throw new Error(`--task-ids must be a comma-separated subset of ${SIX_DOMAIN_TASK_ORDER.join(",")}`);
  }
  if (new Set(taskIds).size !== taskIds.length) throw new Error("--task-ids must not contain duplicates");
  return taskIds;
}

export function parseBatchArgs(argv) {
  const args = parseFlags(argv, {
    valueFlags: VALUE_FLAGS,
    booleanFlags: BOOLEAN_FLAGS,
    required: ["--as-of-date", "--travel-date"],
  });
  if ((args["--suite"] ?? SIX_DOMAIN_SUITE_ID) !== SIX_DOMAIN_SUITE_ID) {
    throw new Error(`prepare-batch only supports ${SIX_DOMAIN_SUITE_ID}`);
  }
  args["--task-ids"] = parseBatchTaskIds(args["--task-ids"]);
  args["--risk-guard"] = resolveRiskGuard(args["--risk-guard"]);
  return args;
}

export function buildInterleavedOrder(taskIds = SIX_DOMAIN_TASK_ORDER) {
  const selectedTaskIds = parseBatchTaskIds(taskIds);
  return selectedTaskIds.flatMap((taskId) => {
    const taskIndex = SIX_DOMAIN_TASK_ORDER.indexOf(taskId);
    const rotation = taskIndex % SIX_DOMAIN_ARM_CYCLE.length;
    const armOrder = [
      ...SIX_DOMAIN_ARM_CYCLE.slice(rotation),
      ...SIX_DOMAIN_ARM_CYCLE.slice(0, rotation),
    ];
    return armOrder.map((variant) => ({ taskId, variant }));
  });
}

function assertSharedDateWindow(asOfDate, travelDate) {
  const asOfTime = parseIsoDate(asOfDate, "--as-of-date");
  const travelTime = parseIsoDate(travelDate, "--travel-date");
  const days = (travelTime - asOfTime) / 86_400_000;
  if (!Number.isInteger(days) || days < 1 || days > 7) {
    throw new Error("--travel-date must be 1 to 7 days after --as-of-date for every package in the batch");
  }
}

function createInitialBatch({ batchId, suiteId, outputRoot, asOfDate, travelDate, taskIds, riskGuard, order }) {
  const riskModel = riskGuard === "off" ? "off" : "same";
  return {
    schemaVersion: 1,
    kind: "life-eval-offline-batch",
    batchId,
    suiteId,
    status: "preparing_offline_packages",
    readiness: {
      offlinePreparation: "in_progress",
      liveExecution: "not_authorized_by_this_batch_manifest",
      guiPreflight: "pending_human_review",
      providerCalls: false,
      desktopControl: false,
      environmentFileRead: false,
    },
    createdAt: new Date().toISOString(),
    outputRoot,
    asOfDate,
    travelDate,
    taskOrder: [...taskIds],
    armCycle: [...SIX_DOMAIN_ARM_CYCLE],
    interleavePolicy: "For each selected task, rotate A-C-D-B by its canonical index in the full six-task order; adjacent transitions change one of supervision or Plan/Memory where possible.",
    riskPolicy: {
      riskGuard,
      riskModel,
      confirmRiskGuardOff: riskGuard === "off",
      riskModelRequestsEnabled: riskModel !== "off",
      riskRequestCapBehavior: riskModel === "off" ? "positive per-task CLI cap is retained but no risk-model requests are made" : "risk-model requests use the frozen per-task cap",
    },
    packages: order.map(({ taskId, variant }, index) => ({ index: index + 1, taskId, variant, packageId: null, packageDir: null, outputAttemptDir: null, humanPreflight: "pending", riskPolicy: null })),
  };
}

async function writeBatchManifest(batchFile, manifest) {
  await writeFile(batchFile, jsonText(manifest), { encoding: "utf8" });
}

export async function prepareSixDomainBatch(args, dependencies = {}) {
  const suiteId = args["--suite"] ?? SIX_DOMAIN_SUITE_ID;
  const suite = suiteDefinition(suiteId);
  if (suiteId !== SIX_DOMAIN_SUITE_ID) throw new Error(`prepare-batch only supports ${SIX_DOMAIN_SUITE_ID}`);
  assertSharedDateWindow(args["--as-of-date"], args["--travel-date"]);
  const taskIds = parseBatchTaskIds(args["--task-ids"]);
  const riskGuard = resolveRiskGuard(args["--risk-guard"]);
  const riskModel = riskGuard === "off" ? "off" : "same";

  const config = dependencies.config ?? await loadLocalConfig(dependencies.configPath);
  const outputRootInput = args["--output-dir"] ?? config.outputDir;
  if (typeof outputRootInput !== "string" || !isAbsolute(outputRootInput)) throw new Error("--output-dir must be an absolute path");
  const profileLabel = args["--profile-label"] ?? config.profileLabel;
  if (!MANAGED_BROWSER_LABEL_RE.test(profileLabel)) throw new Error("--profile-label must contain 1-64 letters, digits, dot, underscore, or hyphen");
  if (args["--cua-socket"] !== undefined && args["--cua-socket"].trim().length === 0) throw new Error("--cua-socket must not be empty");
  assertApiKeyEnvName(args["--api-key-env"] ?? config.arkApiKeyEnv ?? "ARK_API_KEY");
  const candidateDriver = {
    binaryPath: config.candidateDriverPath,
    sha256: config.candidateDriverSha256,
    version: config.candidateDriverVersion,
    sourceCommit: config.candidateDriverSource,
  };
  await verifyCuaDriverBinary(candidateDriver);
  const manifestPath = dependencies.manifestPath ?? manifestPathForSuite(suiteId, dependencies.root ?? ROOT);
  const manifestBytes = await readFile(manifestPath);
  const sourceManifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
  if (sourceManifest.suiteId !== suiteId || !Array.isArray(sourceManifest.tasks)) {
    throw new Error(`task manifest must contain the selected suite ${suiteId}`);
  }
  for (const taskId of taskIds) {
    if (!sourceManifest.tasks.some((task) => task.id === taskId)) throw new Error(`task manifest is missing required task ${taskId}`);
  }
  const t03 = taskIds.includes("T03") ? sourceManifest.tasks.find((task) => task.id === "T03") : undefined;
  if (t03?.requiredApps?.includes("WeChat") && t03.goal?.includes("{{WECHAT_CHAT}}")) {
    const chat = config.wechatChat;
    if (typeof chat !== "string" || chat.trim().length === 0 || chat.length > 120 || chat.trim() !== chat || /[\u0000-\u001f\u007f]/u.test(chat)) {
      throw new Error("six-domain batch requires the exact configured local WeChat target before any package is created");
    }
  }

  const outputRoot = resolve(outputRootInput);
  const batchId = `six-domain-${args["--as-of-date"].replaceAll("-", "")}-${args["--travel-date"].replaceAll("-", "")}-${randomUUID().slice(0, 8)}`;
  const order = buildInterleavedOrder(taskIds);
  const root = dependencies.root ?? ROOT;
  const batchDir = join(outputRoot, suiteId, "_batches", batchId);
  const batchFile = join(batchDir, "batch.json");
  await mkdir(join(outputRoot, suiteId, "_batches"), { recursive: true });
  await mkdir(batchDir, { recursive: false });
  const batch = createInitialBatch({ batchId, suiteId, outputRoot, asOfDate: args["--as-of-date"], travelDate: args["--travel-date"], taskIds, riskGuard, order });
  await writeBatchManifest(batchFile, batch);

  const prepareOne = dependencies.prepareOne ?? ((startArgs) => prepareFromStartArgs(startArgs, {
    ...dependencies,
    root,
    manifestPath,
    config,
  }));
  try {
    for (const item of batch.packages) {
      const rawArgs = [
        "--suite", suiteId,
        "--task-id", item.taskId,
        "--variant", item.variant,
        "--output-dir", args["--output-dir"] ?? config.outputDir,
        "--profile-label", args["--profile-label"] ?? config.profileLabel,
        "--as-of-date", args["--as-of-date"],
        "--travel-date", args["--travel-date"],
        "--risk-guard", riskGuard,
      ];
      for (const flag of ["--api-key-env", "--cua-socket"]) {
        if (args[flag] !== undefined) rawArgs.push(flag, args[flag]);
      }
      const startArgs = parseStartArgs(rawArgs);
      const prepared = await prepareOne(startArgs);
      item.packageId = prepared.packageId;
      item.packageDir = prepared.packageDir;
      item.outputAttemptDir = prepared.outputAttemptDir;
      item.humanPreflight = prepared.review?.preflight?.status === "pending" ? "pending_human_review" : "check_package_review";
      item.supervision = prepared.plan?.configuration?.supervision ?? null;
      if (prepared.plan?.configuration?.riskGuard !== undefined) {
        item.riskPolicy = {
          riskGuard: prepared.plan.configuration.riskGuard,
          riskModel: prepared.plan.configuration.riskModel,
          confirmRiskGuardOff: prepared.plan.configuration.confirmRiskGuardOff,
          riskModelRequestsEnabled: prepared.plan.configuration.riskModelRequestsEnabled,
          riskModelRequestLimitStatus: prepared.plan.configuration.riskModelRequestLimitStatus,
          maxRiskModelRequests: prepared.plan.configuration.maxRiskModelRequests,
          combinedRequestCeiling: prepared.plan.configuration.combinedRequestCeiling,
        };
      }
      item.planSha256 = prepared.review?.planSha256 ?? null;
      await writeBatchManifest(batchFile, batch);
    }
    batch.status = "offline_packages_prepared_gui_preflight_pending";
    batch.readiness.offlinePreparation = "prepared";
    batch.readiness.guiPreflight = "pending_human_review";
    batch.readiness.liveExecution = "not_authorized_by_this_batch_manifest";
    batch.completedAt = (dependencies.now?.() ?? new Date()).toISOString();
    await writeBatchManifest(batchFile, batch);
    return { batch, batchDir, batchFile };
  } catch (error) {
    batch.status = "partial_preparation_failed_artifacts_preserved";
    batch.failure = error instanceof Error ? error.message : String(error);
    batch.failedAt = (dependencies.now?.() ?? new Date()).toISOString();
    await writeBatchManifest(batchFile, batch);
    throw Object.assign(new Error(`batch preparation stopped; prior package artifacts were preserved: ${batchFile}`), { cause: error, batchFile, batch });
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === "--help") {
    process.stdout.write(`Usage: node scripts/life-eval/prepare-batch.mjs --as-of-date YYYY-MM-DD --travel-date YYYY-MM-DD [--suite ${SIX_DOMAIN_SUITE_ID}] [--task-ids ${SIX_DOMAIN_TASK_ORDER.join(",")}] [--risk-guard <layered|off>] [--output-dir <absolute>] [--profile-label <label>] [--api-key-env <ARK_API_KEY|HUOSHAN_API_KEY>] [--cua-socket <existing-socket>]\nDefaults to all 24 packages. --task-ids selects a comma-separated subset; arm rotation keeps each task's position in the full suite order. Risk Guard defaults to layered; off freezes --risk-model off and --confirm-risk-guard-off, with the positive risk request cap retained but inactive. Preparation does not run packages, inspect .env contents, start a GUI, or connect to CUA.\n`);
    return;
  }
  const args = parseBatchArgs(argv);
  const result = await prepareSixDomainBatch(args);
  process.stdout.write(`Offline batch manifest: ${result.batchFile}\n`);
  process.stdout.write(`Status: ${result.batch.status}; packages: ${result.batch.packages.length}; dates: ${result.batch.asOfDate}/${result.batch.travelDate}; risk: ${result.batch.riskPolicy.riskGuard}/${result.batch.riskPolicy.riskModel}; live readiness: GUI preflight pending\n`);
  for (const item of result.batch.packages) {
    process.stdout.write(`${String(item.index).padStart(2, "0")} ${item.taskId}/${item.variant} ${item.packageDir} [${item.humanPreflight}]\n`);
  }
  process.stdout.write("No model/API/GUI/CUA action was started; the batch manifest does not authorize live execution.\n");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
