import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MANAGED_BROWSER_LABEL_RE, ROOT, assertApiKeyEnvName, manifestPathForSuite, parseFlags, suiteDefinition } from "./common.mjs";
import { createPlan } from "./prepare.mjs";

export const LOCAL_CONFIG_PATH = join(ROOT, ".tools", "life-eval.local.json");

const VALUE_FLAGS = new Set(["--task-id", "--variant", "--output-dir", "--profile-label", "--as-of-date", "--travel-date", "--cua-socket", "--suite", "--api-key-env"]);
const BOOLEAN_FLAGS = new Set(["--help"]);

export function parseStartArgs(argv) {
  return parseFlags(argv, {
    valueFlags: VALUE_FLAGS,
    booleanFlags: BOOLEAN_FLAGS,
    required: ["--task-id", "--variant"],
  });
}

function addDays(isoDate, days) {
  const time = Date.parse(`${isoDate}T00:00:00.000Z`);
  if (!Number.isFinite(time)) throw new Error("could not calculate the Beijing calendar date");
  return new Date(time + days * 86_400_000).toISOString().slice(0, 10);
}

export function beijingDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const fields = Object.fromEntries(parts.filter((part) => part.type !== "literal").map(({ type, value }) => [type, value]));
  if (!fields.year || !fields.month || !fields.day) throw new Error("could not determine the Beijing calendar date");
  return `${fields.year}-${fields.month}-${fields.day}`;
}

export async function loadLocalConfig(configPath = LOCAL_CONFIG_PATH) {
  let bytes;
  try {
    bytes = await readFile(configPath);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`local life-eval config not found: ${configPath}; create the ignored .tools/life-eval.local.json first`);
    throw error;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    throw new Error(`local life-eval config is not valid UTF-8 JSON: ${configPath}`);
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("local life-eval config must be a JSON object");
  if (typeof config.outputDir !== "string" || !/^[A-Za-z]:[\\/]/u.test(config.outputDir)) {
    throw new Error("local life-eval config requires an absolute Windows outputDir");
  }
  if (typeof config.profileLabel !== "string" || !MANAGED_BROWSER_LABEL_RE.test(config.profileLabel)) {
    throw new Error("local life-eval config requires a valid profileLabel");
  }
  if (config.wechatChat !== undefined && (typeof config.wechatChat !== "string" || config.wechatChat.trim().length === 0 || config.wechatChat.trim() !== config.wechatChat || /[\u0000-\u001f\u007f]/u.test(config.wechatChat))) {
    throw new Error("local life-eval config wechatChat, when present, must be a non-empty exact name");
  }
  if (typeof config.cuaSocket !== "string" || config.cuaSocket.trim().length === 0) {
    throw new Error("local life-eval config requires a non-empty cuaSocket value");
  }
  if (typeof config.candidateDriverPath !== "string" || !isAbsolute(config.candidateDriverPath) ||
      typeof config.candidateDriverSha256 !== "string" || !/^[a-f0-9]{64}$/iu.test(config.candidateDriverSha256) ||
      typeof config.candidateDriverVersion !== "string" || config.candidateDriverVersion.trim().length === 0 ||
      typeof config.candidateDriverSource !== "string" || config.candidateDriverSource.trim().length === 0) {
    throw new Error("local life-eval config requires candidateDriverPath, candidateDriverSha256, candidateDriverVersion, and candidateDriverSource");
  }
  if (config.envFilePath !== undefined && (typeof config.envFilePath !== "string" || !isAbsolute(config.envFilePath))) {
    throw new Error("local life-eval config envFilePath, when present, must be absolute");
  }
  return config;
}

export function buildPrepareOptions(args, { now = new Date(), config, task } = {}) {
  if (!config) throw new Error("local life-eval config is required to build a plan");
  const suite = suiteDefinition(args["--suite"]);
  const asOfDate = beijingDate(now);
  const hasWechatTarget = typeof task?.goal === "string" && task.goal.includes("{{WECHAT_CHAT}}");
  const requiresWechat = Array.isArray(task?.requiredApps) && task.requiredApps.includes("WeChat");
  if (hasWechatTarget !== requiresWechat) {
    throw new Error("a task must both require WeChat and declare the exact chat target token");
  }
  const needsWechatChat = requiresWechat && hasWechatTarget;
  const cuaSocket = args["--cua-socket"];
  if (cuaSocket !== undefined && cuaSocket.trim().length === 0) throw new Error("--cua-socket must not be empty");
  const selectedAsOfDate = args["--as-of-date"] ?? asOfDate;
  const prepareOptions = {
    "--output-dir": args["--output-dir"] ?? config.outputDir,
    "--profile-label": args["--profile-label"] ?? config.profileLabel,
    "--as-of-date": selectedAsOfDate,
    "--travel-date": args["--travel-date"] ?? addDays(selectedAsOfDate, 1),
    "--task-id": args["--task-id"],
    "--variant": args["--variant"],
    "--suite": suite.suiteId,
  };
  if (suite.provider === "ark") {
    const selectedApiKeyEnv = args["--api-key-env"] ?? config.arkApiKeyEnv ?? "ARK_API_KEY";
    prepareOptions["--api-key-env"] = assertApiKeyEnvName(selectedApiKeyEnv);
  } else if (args["--api-key-env"] !== undefined) {
    throw new Error("--api-key-env is accepted only for the Ark Agent Plan suite");
  }
  if (needsWechatChat) {
    if (typeof config.wechatChat !== "string" || config.wechatChat.trim().length === 0) {
      throw new Error("this task goal requires a configured local wechatChat value");
    }
    prepareOptions["--wechat-chat"] = config.wechatChat;
  }
  return {
    prepareOptions,
    cuaSocket: cuaSocket ?? config.cuaSocket,
    candidateDriver: {
      binaryPath: config.candidateDriverPath,
      sha256: config.candidateDriverSha256,
      version: config.candidateDriverVersion,
      sourceCommit: config.candidateDriverSource,
    },
    envFilePath: config.envFilePath,
  };
}

function powershellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function buildNextCommands(packageDir, cuaSocket, { root = ROOT, nodeExecutable = process.execPath } = {}) {
  const runEntry = join(root, "scripts", "life-eval", "run.mjs");
  const prefix = `& ${powershellQuote(nodeExecutable)} ${powershellQuote(runEntry)} --package ${powershellQuote(packageDir)}`;
  const socket = cuaSocket ?? "<填入已运行CUA daemon的实际socket>";
  return {
    dryRun: prefix,
    supervisedLive: `${prefix} --live --confirm-desktop-control --supervised --cua-socket ${powershellQuote(socket)}`,
  };
}

export async function prepareFromStartArgs(args, dependencies = {}) {
  const config = dependencies.config ?? await loadLocalConfig(dependencies.configPath);
  const now = typeof dependencies.now === "function" ? dependencies.now() : dependencies.now ?? new Date();
  const suite = suiteDefinition(args["--suite"]);
  const manifestPath = dependencies.manifestPath ?? manifestPathForSuite(suite.suiteId, dependencies.root ?? ROOT);
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const task = manifest.tasks?.find((candidate) => candidate.id === args["--task-id"]);
  if (!task) throw new Error(`task id not found: ${args["--task-id"]}`);
  const { prepareOptions, cuaSocket, candidateDriver, envFilePath } = buildPrepareOptions(args, { now, config, task });
  const { config: _config, configPath: _configPath, ...planDependencies } = dependencies;
  const prepared = await createPlan(prepareOptions, { ...planDependencies, now: () => now, candidateDriver, envFilePath });
  return { ...prepared, cuaSocket };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === "--help") {
    process.stdout.write("Usage: node scripts/life-eval/start.mjs [--suite <suiteId>] --task-id <suite task id> --variant <variant for selected suite> [--api-key-env <ARK_API_KEY|HUOSHAN_API_KEY for Ark suite>] [--output-dir <absolute>] [--profile-label <label>] [--as-of-date YYYY-MM-DD] [--travel-date YYYY-MM-DD] [--cua-socket <existing-socket>]\nThe suite defaults to life-business-20261015. Output/profile/API-key environment-variable name/WeChat chat/existing CUA socket are read from ignored .tools/life-eval.local.json; supported values may be overridden. As-of date comes from Asia/Shanghai today and travel date defaults to tomorrow unless explicitly supplied. This creates an offline prepare package only.\n");
    return;
  }
  const args = parseStartArgs(argv);
  const prepared = await prepareFromStartArgs(args);
  const commands = buildNextCommands(prepared.packageDir, prepared.cuaSocket);
  process.stdout.write(`Prepared offline package: ${prepared.packageDir}\n`);
  process.stdout.write(`Suite/task/variant: ${prepared.plan.suiteId}/${prepared.plan.task.id}/${prepared.plan.selection.variant}; model: ${prepared.plan.configuration.model}; profile: ${prepared.plan.selection.profileLabel}\n`);
  process.stdout.write(`Output folder for this attempt: ${prepared.outputAttemptDir}\n`);
  process.stdout.write(`Candidate CUA driver file: version ${prepared.plan.configuration.cuaDriver.version}, source ${prepared.plan.configuration.cuaDriver.sourceCommit}, SHA-256 ${prepared.plan.configuration.cuaDriver.sha256} (file only; running-daemon identity remains pending human preflight).\n`);
  process.stdout.write(`Review receipt remains pending: ${join(prepared.packageDir, "review.json")}\n`);
  process.stdout.write("Next commands (not executed):\n");
  process.stdout.write(`Dry-run: ${commands.dryRun}\n`);
  if (prepared.plan.cli.envFilePath !== null) {
    process.stdout.write(`Frozen child CLI option (live only; not read by prepare/dry-run): --env-file ${powershellQuote(prepared.plan.cli.envFilePath)}\n`);
  }
  process.stdout.write(`Live only after human preflight/authorization and exact socket verification: ${commands.supervisedLive}\n`);
  process.stdout.write("No CLI, model, browser, GUI, CUA socket, API-key value, or env-file access was started by this entry.\n");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
