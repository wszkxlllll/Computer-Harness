import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const SUITE_ID = "life-business-20261015";
export const SHOPPING_COMMUNICATION_SUITE_ID = "life-business-shopping-communication-20261016";
export const SIX_DOMAIN_SUITE_ID = "life-business-six-domain-20261018";
export const SUITE_DEFINITIONS = Object.freeze({
  [SUITE_ID]: Object.freeze({
    suiteId: SUITE_ID,
    model: "deepseek-flash",
    provider: "deepseek",
    batching: "same-control-input-v1",
    apiKeyTargetEnv: null,
  }),
  [SHOPPING_COMMUNICATION_SUITE_ID]: Object.freeze({
    suiteId: SHOPPING_COMMUNICATION_SUITE_ID,
    model: "deepseek-v4.1-flash",
    provider: "ark",
    batching: "off",
    apiKeyTargetEnv: "ARK_API_KEY",
  }),
  [SIX_DOMAIN_SUITE_ID]: Object.freeze({
    suiteId: SIX_DOMAIN_SUITE_ID,
    model: "deepseek-v4.1-flash",
    provider: "ark",
    batching: "off",
    apiKeyTargetEnv: "ARK_API_KEY",
    thinking: "disabled",
  }),
});
export const API_KEY_ENV_NAMES = Object.freeze(["ARK_API_KEY", "HUOSHAN_API_KEY"]);
export const MANIFEST_PATH = join(ROOT, "eval", SUITE_ID, "tasks.json");
export const CLI_ENTRY = join(ROOT, "apps", "cli", "dist", "index.js");
export const MANAGED_BROWSER_LABEL_RE = /^[A-Za-z0-9._-]{1,64}$/u;
export const VARIANTS = Object.freeze({
  B00: Object.freeze({ planning: false, memory: "off", retrieval: "off" }),
  P10: Object.freeze({ planning: true, memory: "off", retrieval: "off" }),
  M01: Object.freeze({ planning: false, memory: "facts", retrieval: "lexical" }),
  PM11: Object.freeze({ planning: true, memory: "facts", retrieval: "lexical" }),
});
export const SIX_DOMAIN_VARIANTS = Object.freeze({
  A: Object.freeze({ planning: false, memory: "off", retrieval: "off", supervision: Object.freeze({ mode: "observe", policyVersion: "evidence-triggered-no-scripted-corrections-v1" }) }),
  B: Object.freeze({ planning: true, memory: "facts", retrieval: "lexical", supervision: Object.freeze({ mode: "observe", policyVersion: "evidence-triggered-no-scripted-corrections-v1" }) }),
  C: Object.freeze({ planning: false, memory: "off", retrieval: "off", supervision: Object.freeze({ mode: "dynamic", policyVersion: "evidence-triggered-no-scripted-corrections-v1" }) }),
  D: Object.freeze({ planning: true, memory: "facts", retrieval: "lexical", supervision: Object.freeze({ mode: "dynamic", policyVersion: "evidence-triggered-no-scripted-corrections-v1" }) }),
});
export const LIMITS = Object.freeze({
  easy: Object.freeze({ modelRequests: 100, riskRequests: 20, actions: 80, timeoutMs: 15 * 60_000 }),
  medium: Object.freeze({ modelRequests: 120, riskRequests: 24, actions: 100, timeoutMs: 20 * 60_000 }),
  hard: Object.freeze({ modelRequests: 180, riskRequests: 36, actions: 150, timeoutMs: 30 * 60_000 }),
});

export function suiteDefinition(suiteId = SUITE_ID) {
  if (typeof suiteId !== "string" || !Object.hasOwn(SUITE_DEFINITIONS, suiteId)) {
    throw new Error(`unsupported life-eval suite; expected one of ${Object.keys(SUITE_DEFINITIONS).join(", ")}`);
  }
  return SUITE_DEFINITIONS[suiteId];
}

export function variantsForSuite(suiteId = SUITE_ID) {
  return suiteId === SIX_DOMAIN_SUITE_ID ? SIX_DOMAIN_VARIANTS : VARIANTS;
}

export function manifestPathForSuite(suiteId = SUITE_ID, root = ROOT) {
  const suite = suiteDefinition(suiteId);
  return join(root, "eval", suite.suiteId, "tasks.json");
}

export function assertApiKeyEnvName(value) {
  if (!API_KEY_ENV_NAMES.includes(value)) {
    throw new Error(`--api-key-env must be one of ${API_KEY_ENV_NAMES.join(", ")}`);
  }
  return value;
}

export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

/** Hash UTF-8 text after normalizing platform line endings to the Git LF form. */
export function sha256CanonicalText(text) {
  if (typeof text !== "string") throw new TypeError("canonical text SHA-256 input must be a string");
  return sha256(text.replace(/\r\n?/gu, "\n"));
}

export async function verifyCuaDriverBinary(candidate) {
  if (candidate === undefined || candidate === null) return null;
  if (typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("candidate CUA driver fingerprint must be an object");
  if (typeof candidate.binaryPath !== "string" || !isAbsolute(candidate.binaryPath)) {
    throw new Error("candidate CUA driver binaryPath must be absolute");
  }
  if (typeof candidate.sha256 !== "string" || !/^[a-f0-9]{64}$/iu.test(candidate.sha256)) {
    throw new Error("candidate CUA driver sha256 must be 64 hexadecimal characters");
  }
  if (typeof candidate.version !== "string" || candidate.version.trim().length === 0 ||
      typeof candidate.sourceCommit !== "string" || candidate.sourceCommit.trim().length === 0) {
    throw new Error("candidate CUA driver version and sourceCommit are required");
  }
  const binaryPath = resolve(candidate.binaryPath);
  const actualSha256 = sha256(await readFile(binaryPath)).toUpperCase();
  if (actualSha256 !== candidate.sha256.toUpperCase()) {
    throw new Error("candidate CUA driver binary hash does not match the configured SHA-256");
  }
  return {
    binaryPath,
    sha256: actualSha256,
    version: candidate.version,
    sourceCommit: candidate.sourceCommit,
    verificationScope: "candidate-file-hash-only; running-daemon identity is not verified",
  };
}

export function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export function parseFlags(argv, { valueFlags, booleanFlags, required = [] }) {
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (valueFlags.has(flag)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      if (values[flag] !== undefined) throw new Error(`${flag} may only be supplied once`);
      values[flag] = value;
      i += 1;
      continue;
    }
    if (booleanFlags.has(flag)) {
      if (values[flag] === true) throw new Error(`${flag} may only be supplied once`);
      values[flag] = true;
      continue;
    }
    throw new Error(`unknown option: ${flag}`);
  }
  for (const flag of required) {
    if (values[flag] === undefined) throw new Error(`${flag} is required`);
  }
  return values;
}

export function parseIsoDate(value, flagName) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error(`${flagName} must use YYYY-MM-DD`);
  }
  const time = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) {
    throw new Error(`${flagName} is not a calendar date`);
  }
  return time;
}

export async function loadCliParser() {
  const module = await loadCliModule();
  return module.parseArgs;
}

export async function loadCliModule() {
  if (!(await pathExists(CLI_ENTRY))) throw new Error(`built CLI not found: ${CLI_ENTRY}`);
  const module = await import(pathToFileURL(CLI_ENTRY).href);
  if (typeof module.parseArgs !== "function") throw new Error("built CLI does not export parseArgs");
  if (typeof module.toResolvedRunConfig !== "function") throw new Error("built CLI does not export toResolvedRunConfig");
  return module;
}

export function validateCliArgv(parseArgs, argv) {
  parseArgs(argv);
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.error) throw new Error(`git ${args[0]} failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  return result.stdout;
}

function gitBuffer(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "buffer", windowsHide: true });
  if (result.error) throw new Error(`git ${args[0]} failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString("utf8").trim() || `exit ${result.status}`}`);
  return result.stdout;
}

export function gitSummary(root = ROOT) {
  return {
    head: git(root, ["rev-parse", "HEAD"]).trim(),
    branch: git(root, ["branch", "--show-current"]).trim(),
    statusShort: git(root, ["status", "--short"]).trimEnd(),
    diffStat: git(root, ["diff", "--stat", "HEAD"]).trimEnd(),
  };
}

function isExcludedPath(path) {
  const parts = path.split(/[\\/]+/u);
  if (parts.some((part) => part === ".git" || part === "node_modules" || part === "dist" || part === "runs" || part === ".tools")) return true;
  if (parts.some((part) => /^\.env(?:\.|$)/u.test(part))) return true;
  return false;
}

function isSourceFile(path) {
  const extension = extname(path).toLowerCase();
  return [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".jsonc", ".yaml", ".yml", ".ps1"].includes(extension);
}

export async function sourceFingerprint(root = ROOT) {
  const paths = new Set();
  const tracked = gitBuffer(root, ["ls-files", "-co", "--exclude-standard", "-z", "--", "apps", "packages", "scripts"]);
  for (const item of tracked.toString("utf8").split("\0")) {
    if (item && !isExcludedPath(item) && isSourceFile(item)) paths.add(item.replaceAll("\\", "/"));
  }
  for (const item of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "vitest.config.ts"]) {
    if (await pathExists(join(root, item))) paths.add(item);
  }
  const hash = createHash("sha256");
  const sorted = [...paths].sort((a, b) => a.localeCompare(b, "en"));
  for (const path of sorted) {
    hash.update(path, "utf8").update("\0");
    hash.update(await readFile(join(root, path))).update("\0");
  }
  return { sha256: hash.digest("hex"), fileCount: sorted.length };
}

async function walkFiles(directory, root, output = []) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return output;
    throw error;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) await walkFiles(full, root, output);
    else if (entry.isFile()) output.push(relative(root, full).split(sep).join("/"));
  }
  return output;
}

export async function builtCliFingerprint(root = ROOT) {
  const directories = [join(root, "apps", "cli", "dist")];
  for (const entry of await readdir(join(root, "packages"), { withFileTypes: true })) {
    if (entry.isDirectory()) directories.push(join(root, "packages", entry.name, "dist"));
  }
  const paths = [];
  for (const directory of directories) await walkFiles(directory, root, paths);
  paths.sort((a, b) => a.localeCompare(b, "en"));
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(path, "utf8").update("\0");
    hash.update(await readFile(join(root, path))).update("\0");
  }
  return { sha256: hash.digest("hex"), fileCount: paths.length };
}

export function limitsFor(difficulty) {
  const limits = LIMITS[difficulty];
  if (limits === undefined) throw new Error(`unsupported task difficulty: ${String(difficulty)}`);
  return { ...limits, totalModelRequests: limits.modelRequests + limits.riskRequests };
}
