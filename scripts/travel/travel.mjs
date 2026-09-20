import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const MANIFEST_PATH = resolve(REPO_ROOT, "eval/travel/travel-candidate-manifest.v0.json");
export const TRAVEL_RUN_ROOT = resolve(REPO_ROOT, "runs/travel");
const TASK_ID_RE = /^T(?:0[1-9]|1[0-9]|20)$/u;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const VALID_CLIENTS = new Set(["railway12306", "ctrip", "amap"]);
const execFileAsync = promisify(execFile);
const PRESET_DESCRIPTORS = Object.freeze({
  baseline: Object.freeze({ planning: false, memory: "off", memoryRetrieval: "off", batching: "off", contextMode: "raw", monitor: "off" }),
  assisted: Object.freeze({ planning: true, memory: "facts", memoryRetrieval: "lexical", batching: "same-control-input-v1", contextMode: "recent", monitor: "shadow" }),
  research: Object.freeze({ planning: true, memory: "entities", memoryRetrieval: "lexical", batching: "same-control-input-v1", contextMode: "recent", monitor: "guidance" }),
});

export const COMMON_GOAL_BOUNDARY = [
  "通用边界：只查询、比较和准备行程草稿，不预订、候补、创建订单、支付、退改签或修改账号。",
  "出现登录、验证码或需要用户确认的页面时，请求用户处理；不要代替用户输入敏感信息。",
  "最终结果可以在回复中交付；只有任务明确要求文件时才新建文件，并且不得覆盖已有文件。",
].join("\n");

function fail(message) {
  throw new Error(`[travel] ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function arrayOfStrings(value) {
  return Array.isArray(value) && value.every((item) => nonEmptyString(item));
}

function pathKey(value) {
  return resolve(value).replaceAll("\\", "/").toLowerCase();
}

function pathInside(root, target) {
  const rootKey = pathKey(root);
  const targetKey = pathKey(target);
  const relativePath = relative(rootKey, targetKey);
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
}

function portablePath(value) {
  return value.replaceAll("\\", "/");
}

function repoRelative(value) {
  return portablePath(relative(REPO_ROOT, value));
}

function parseOptionValue(args, index, name) {
  const current = args[index];
  if (current === name) {
    if (args[index + 1] === undefined || args[index + 1].startsWith("--")) fail(`${name} requires a value`);
    return { value: args[index + 1], nextIndex: index + 2 };
  }
  const prefix = `${name}=`;
  if (current.startsWith(prefix)) {
    const value = current.slice(prefix.length);
    if (value.length === 0) fail(`${name} requires a value`);
    return { value, nextIndex: index + 1 };
  }
  return undefined;
}

export function parseAnchorDate(value) {
  if (!nonEmptyString(value) || !DATE_RE.test(value)) fail("--anchor-date must be YYYY-MM-DD");
  const [, yearText, monthText, dayText] = DATE_RE.exec(value);
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (year < 2000 || year > 2100) fail("--anchor-date year must be between 2000 and 2100");
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    fail("--anchor-date is not a valid Shanghai calendar date");
  }
  return value;
}

export function addUtcDays(anchorDate, offset) {
  parseAnchorDate(anchorDate);
  if (!Number.isInteger(offset) || Math.abs(offset) > 3660) fail("date offset must be an integer within +/-3660 days");
  const [year, month, day] = anchorDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + offset);
  const result = date.toISOString().slice(0, 10);
  parseAnchorDate(result);
  return result;
}

function resolveManifestPath(value = MANIFEST_PATH) {
  if (!nonEmptyString(value) || value.includes("\0") || value.includes("\r") || value.includes("\n")) fail("manifest path is invalid");
  const target = resolve(REPO_ROOT, value);
  if (!pathInside(REPO_ROOT, target)) fail("manifest path must stay inside the repository");
  return target;
}

function resolveTrialRoot(value = TRAVEL_RUN_ROOT) {
  if (!nonEmptyString(value) || value.includes("\0") || value.includes("\r") || value.includes("\n")) fail("trial path is invalid");
  return resolve(value);
}

function forbiddenManifestKeys(value, path = "manifest") {
  const forbidden = new Set(["answer", "goldAnswer", "expectedAnswer", "price", "fare", "inventory", "availability", "success", "score"]);
  const found = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => found.push(...forbiddenManifestKeys(item, `${path}[${index}]`)));
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (forbidden.has(key)) found.push(`${path}.${key}`);
      found.push(...forbiddenManifestKeys(item, `${path}.${key}`));
    }
  }
  return found;
}

export function validateManifest(manifest) {
  if (!isRecord(manifest)) fail("manifest root must be an object");
  const errors = [];
  if (manifest.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (manifest.status !== "draft_not_frozen") errors.push("status must remain draft_not_frozen");
  if (manifest.domain !== "travel_ticketing") errors.push("domain must be travel_ticketing");
  if (!isRecord(manifest.origin) || manifest.origin.city !== "Shanghai" || manifest.origin.calendar !== "Asia/Shanghai") {
    errors.push("origin must be Shanghai on the Asia/Shanghai calendar");
  }
  const families = Array.isArray(manifest.taskFamilies) ? manifest.taskFamilies : [];
  const split = isRecord(manifest.split) ? manifest.split : {};
  const development = Array.isArray(split.developmentFamilies) ? split.developmentFamilies : [];
  const heldout = Array.isArray(split.heldoutFamilies) ? split.heldoutFamilies : [];
  if (development.length !== 6 || heldout.length !== 4) errors.push("split must contain 6 development and 4 heldout families");
  if (families.length !== 10) errors.push("manifest must contain 10 task families");
  const familyIds = new Set();
  const partitionIds = new Set([...development, ...heldout]);
  if (partitionIds.size !== development.length + heldout.length) errors.push("split family IDs must be unique");
  let variantCount = 0;
  for (const family of families) {
    if (!isRecord(family) || !nonEmptyString(family.id)) {
      errors.push("each family must have an id");
      continue;
    }
    if (familyIds.has(family.id)) errors.push(`duplicate family id: ${family.id}`);
    familyIds.add(family.id);
    if (family.split !== "development" && family.split !== "heldout") errors.push(`${family.id} has invalid split`);
    if (family.split === "development" && !development.includes(family.id)) errors.push(`${family.id} is missing from development split`);
    if (family.split === "heldout" && !heldout.includes(family.id)) errors.push(`${family.id} is missing from heldout split`);
    if (!nonEmptyString(family.goalTemplate)) errors.push(`${family.id} must have a goalTemplate`);
    if (!arrayOfStrings(family.clients) || family.clients.some((client) => !VALID_CLIENTS.has(client))) errors.push(`${family.id} has invalid clients`);
    const selectedClients = Array.isArray(family.selectedClients) ? family.selectedClients : (Array.isArray(family.clients) && family.clients.length === 1 ? family.clients : []);
    if (!arrayOfStrings(selectedClients) || selectedClients.length === 0 || selectedClients.some((client) => !VALID_CLIENTS.has(client) || !family.clients.includes(client))) {
      errors.push(`${family.id} must declare fixed selectedClients from clients`);
    }
    if (!Array.isArray(family.variants) || family.variants.length !== 2) errors.push(`${family.id} must have exactly two variants`);
    const variantIds = new Set();
    for (const variant of Array.isArray(family.variants) ? family.variants : []) {
      variantCount += 1;
      if (!isRecord(variant) || !nonEmptyString(variant.id)) errors.push(`${family.id} has a variant without an id`);
      else if (variantIds.has(variant.id)) errors.push(`${family.id} has duplicate variant ${variant.id}`);
      else variantIds.add(variant.id);
      const offset = variant.travelDateOffsetDays ?? variant.dateOffsetDays;
      if (!Number.isInteger(offset) || offset < 1 || offset > 10) errors.push(`${family.id}/${variant.id ?? "?"} date offset must be 1..10`);
      if (variant.updatedDateOffsetDays !== undefined && (!Number.isInteger(variant.updatedDateOffsetDays) || variant.updatedDateOffsetDays < 1 || variant.updatedDateOffsetDays > 12)) {
        errors.push(`${family.id}/${variant.id ?? "?"} updated date offset must be 1..12`);
      }
    }
  }
  if (familyIds.size !== partitionIds.size || [...familyIds].some((id) => !partitionIds.has(id))) errors.push("split does not partition task families");
  if (variantCount !== 20) errors.push("manifest must expand to 20 instances");
  const forbidden = forbiddenManifestKeys(manifest);
  if (forbidden.length > 0) errors.push(`answer-like fields are forbidden: ${forbidden.join(", ")}`);
  const realMigration = manifest.entryTracks?.realMigration;
  if (!isRecord(realMigration) || realMigration.isRealClient !== true) errors.push("realMigration track must be explicitly marked real client");
  if (!Array.isArray(realMigration?.forbiddenActions) || !realMigration.forbiddenActions.includes("purchase") || !realMigration.forbiddenActions.includes("payment")) {
    errors.push("realMigration must forbid purchase and payment");
  }
  if (errors.length > 0) fail(`manifest validation failed:\n- ${errors.join("\n- ")}`);
  return { manifest, families, familyCount: families.length, variantCount };
}

export async function readManifest(manifestPath = MANIFEST_PATH) {
  const resolvedPath = resolveManifestPath(manifestPath);
  let raw;
  let parsed;
  try {
    raw = await readFile(resolvedPath, "utf8");
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`could not read manifest: ${error instanceof Error ? error.message : String(error)}`);
  }
  validateManifest(parsed);
  return { path: resolvedPath, value: parsed, contentSha256: sha256(raw) };
}

export function expandTasks(manifest) {
  const validated = validateManifest(manifest);
  let number = 0;
  return validated.families.flatMap((family) => family.variants.map((variant) => {
    number += 1;
    const selectedClients = family.selectedClients ?? family.clients;
    return {
      taskId: `T${String(number).padStart(2, "0")}`,
      familyId: family.id,
      variantId: variant.id,
      split: family.split,
      clients: [...family.clients],
      selectedClients: [...selectedClients],
      goalTemplate: family.goalTemplate,
      manualChecks: [...(family.manualChecks ?? [])],
      variant: { ...variant },
      manifestId: manifest.manifestId,
      originCity: manifest.origin.city,
      calendar: manifest.origin.calendar,
    };
  }));
}

function taskForId(manifest, taskId) {
  if (!TASK_ID_RE.test(taskId ?? "")) fail("--task must be T01 through T20");
  const task = expandTasks(manifest).find((candidate) => candidate.taskId === taskId.toUpperCase());
  if (task === undefined) fail(`unknown task: ${taskId}`);
  return task;
}

function derivedDates(task, anchorDate) {
  const travelOffset = task.variant.travelDateOffsetDays ?? task.variant.dateOffsetDays;
  const updatedOffset = task.variant.updatedDateOffsetDays;
  return {
    travelDate: Number.isInteger(travelOffset) ? addUtcDays(anchorDate, travelOffset) : null,
    updatedDate: Number.isInteger(updatedOffset) ? addUtcDays(anchorDate, updatedOffset) : null,
    travelDateOffsetDays: Number.isInteger(travelOffset) ? travelOffset : null,
    updatedDateOffsetDays: Number.isInteger(updatedOffset) ? updatedOffset : null,
  };
}

export function renderGoal(task, anchorDate) {
  parseAnchorDate(anchorDate);
  const dates = derivedDates(task, anchorDate);
  const values = {
    ...task.variant,
    taskId: task.taskId,
    familyId: task.familyId,
    origin: task.originCity,
    originCity: task.originCity,
    anchorDate,
    ...dates,
  };
  const placeholders = [...task.goalTemplate.matchAll(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/gu)].map((match) => match[1]);
  for (const key of placeholders) {
    if (values[key] === undefined || values[key] === null || String(values[key]).trim().length === 0) fail(`${task.taskId} goal placeholder ${key} has no value`);
  }
  const goal = task.goalTemplate.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/gu, (_match, key) => String(values[key]));
  return `${goal.trim()}\n\n${COMMON_GOAL_BOUNDARY}`;
}

function exposureFor(task, allowHeldout) {
  if (task.split === "heldout" && !allowHeldout) fail("heldout tasks require --allow-heldout");
  return {
    exposed: task.split === "heldout",
    marker: task.split === "heldout" ? "heldout_explicit" : "development_default",
  };
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function codeCommit() {
  try {
    const result = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, windowsHide: true });
    const value = String(result.stdout).trim();
    return /^[0-9a-f]{7,64}$/iu.test(value) ? value : "unknown";
  } catch {
    return "unknown";
  }
}

async function repositoryState() {
  const commit = await codeCommit();
  try {
    const result = await execFileAsync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, windowsHide: true });
    return { commit, workingTreeDirty: String(result.stdout).trim().length > 0 };
  } catch {
    return { commit, workingTreeDirty: null };
  }
}

function manualReviewText(task, trial) {
  const checks = [
    ...task.manualChecks,
    "确认实际入口来源，并保持受控 fixture 与真实迁移分轨。",
    "确认没有预订、候补、订单、支付、退改签或账号变更。",
    "确认未知余票、价格、路线或页面状态没有被编造成答案。",
  ];
  const moduleChecks = ["Context", "Plan", "Memory", "Batch", "Monitor", "Guard/Approval", "Pause/Resume/CUA"];
  return [
    "# 出行任务人工走查（待完成）",
    "",
    `- trial: ${trial.trialId}`,
    `- task: ${trial.taskId}`,
    `- split: ${trial.split}`,
    `- anchor date: ${trial.anchorDate} (${trial.calendar})`,
    "- execution: not_executed",
    "- calibration: not_calibrated",
    "- manual score: missing_not_pass",
    "",
    "## 人工反馈字段",
    "",
    "- 实际入口（URL或App/小程序名称、版本、浏览器）：待填写",
    "- 初态（打开位置、登录状态、预填筛选、缩放）：待填写",
    "- 人工可行性：待填写（可以/部分可以/不可以/未走查）",
    "- 结果：待填写（完成/部分完成/未完成/环境阻塞/无法判断）",
    "- 具体完成与遗漏：待填写",
    "- 关键约束错误项（日期/站点/时间/预算/席别）：待填写",
    "- 信息依据（编造/旧结果/估算保证）：待填写",
    "- 人工介入次数与原因（登录/验证码/纠正/代操作/审批）：待填写",
    "- 不必要步骤、交互体验、安全问题、截图或轨迹时间点：待填写",
    "",
    "## 任务检查",
    "",
    ...checks.map((check) => `- [ ] ${check}`),
    "",
    "## 模块效果记录",
    "",
    ...moduleChecks.flatMap((module) => [
      `### ${module}`,
      "- 帮助/害处/无法判断：待人工填写",
      "- 时间点或事件序号：待人工填写",
      "",
    ]),
    "## 结论",
    "",
    "- 业务成功：待人工判断（Runtime 成功不等于业务成功）。",
    "- 重复动作只能记录为候选，不得据此断言无意义。",
    "- 缺少人工评分不得记为通过。",
    "",
  ].join("\n");
}

function trialRecord(task, manifest, anchorDate, trialId, trialDirectory, options) {
  const exposure = exposureFor(task, options.allowHeldout === true);
  const dates = derivedDates(task, anchorDate);
  const goal = renderGoal(task, anchorDate);
  return {
    schemaVersion: 1,
    kind: "travel_trial",
    trialId,
    trialDirectory: repoRelative(trialDirectory),
    runtimeDirectory: portablePath(join(repoRelative(trialDirectory), "runtime")),
    manifestId: manifest.manifestId,
    manifestContentSha256: options.manifestContentSha256 ?? null,
    codeCommit: options.codeCommit ?? "unknown",
    workingTreeDirty: options.workingTreeDirty ?? null,
    taskId: task.taskId,
    familyId: task.familyId,
    variantId: task.variantId,
    split: task.split,
    exposed: exposure.exposed,
    exposureMarker: exposure.marker,
    originCity: task.originCity,
    calendar: task.calendar,
    anchorDate,
    dates,
    selectedClients: task.selectedClients,
    goal,
    tracks: {
      controlledFixture: "separate_offline_mechanism_only",
      realMigration: "not_started",
    },
    execution: {
      status: "not_executed",
      appStarted: false,
      apiCalled: false,
      desktopTouched: false,
      urlOpened: false,
    },
    calibration: { status: "not_calibrated" },
    manualScoring: { status: "missing_not_pass", businessSuccess: null },
    launcher: {
      preset: options.preset,
      presetOptions: PRESET_DESCRIPTORS[options.preset],
      model: options.model,
      maxSteps: options.maxSteps,
      maxModelRequests: options.maxModelRequests,
      interactive: true,
      profile: "live-interactive",
      riskGuard: options.preset === "research" ? "off" : "layered",
      outputDirectory: portablePath(join(repoRelative(trialDirectory), "runtime")),
    },
    artifacts: {
      goal: "goal.txt",
      trial: "trial.json",
      manualReview: "manual-review.md",
      runtimeSummary: "runtime/summary.json",
      runtimeTrajectory: "runtime/trajectory.jsonl",
      runtimeRunner: "runtime/runner.json",
      launcherRun: "launcher-run.json",
      metrics: "metrics.json",
    },
  };
}

async function createUniqueDirectory(root, taskId, anchorDate) {
  await mkdir(root, { recursive: true });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const trialId = `${taskId}-${anchorDate.replaceAll("-", "")}-${randomUUID().slice(0, 8)}`;
    const directory = join(root, trialId);
    try {
      await mkdir(directory, { recursive: false });
      return { trialId, directory };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  fail("could not allocate a unique travel trial directory");
}

export async function prepareTask({
  manifest,
  taskId,
  anchorDate,
  allowHeldout = false,
  outputRoot = TRAVEL_RUN_ROOT,
  preset = "research",
  model = "glm-5.3-flash",
  maxSteps = 100,
  maxModelRequests = 100,
  manifestContentSha256 = null,
  codeCommit: commit = "unknown",
  workingTreeDirty = null,
}) {
  if (!Number.isInteger(maxSteps) || maxSteps < 1) fail("maxSteps must be a positive integer");
  if (!Number.isInteger(maxModelRequests) || maxModelRequests < 1) fail("maxModelRequests must be a positive integer");
  if (preset !== "baseline" && preset !== "assisted" && preset !== "research") fail("preset must be baseline, assisted, or research");
  if (model !== "glm-5.3-flash" && model !== "qwen3.8-flash") fail("model must be glm-5.3-flash or qwen3.8-flash");
  parseAnchorDate(anchorDate);
  const task = taskForId(manifest, taskId);
  const targetRoot = resolveTrialRoot(outputRoot);
  const exposure = exposureFor(task, allowHeldout);
  const created = await createUniqueDirectory(targetRoot, task.taskId, anchorDate);
  const trial = trialRecord(task, manifest, anchorDate, created.trialId, created.directory, { allowHeldout, preset, model, maxSteps, maxModelRequests, manifestContentSha256, codeCommit: commit, workingTreeDirty });
  const goalText = `${trial.goal}\n`;
  await writeFile(join(created.directory, "goal.txt"), goalText, { encoding: "utf8", flag: "wx" });
  await writeFile(join(created.directory, "trial.json"), jsonText(trial), { encoding: "utf8", flag: "wx" });
  await writeFile(join(created.directory, "manual-review.md"), manualReviewText(task, trial), { encoding: "utf8", flag: "wx" });
  return { command: "prepare", status: "prepared", trialId: created.trialId, trialDirectory: created.directory, taskId: task.taskId, split: task.split, exposed: exposure.exposed, exposureMarker: exposure.marker, trial };
}

export async function collectTrial({ trialDirectory, runRoot = TRAVEL_RUN_ROOT } = {}) {
  const root = resolveTrialRoot(runRoot);
  const directory = resolveTrialRoot(trialDirectory);
  if (!pathInside(root, directory) || pathKey(directory) === pathKey(root)) fail("--trial-dir must stay inside a single travel trial directory");
  try {
    const module = await import("./metrics.mjs");
    if (typeof module.collectTrial !== "function") fail("metrics.mjs must export collectTrial(trialDirectory)");
    return await module.collectTrial(directory);
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
    return {
      schemaVersion: 1,
      kind: "travel_collection",
      status: "partial",
      trialDirectory: repoRelative(directory),
      businessOutcome: { status: "manual_pending", success: null },
      metrics: null,
      errors: ["metrics module not available; no runtime result was inferred"],
    };
  }
}

function listResult(manifest) {
  return {
    command: "list",
    status: "draft_not_frozen",
    manifestId: manifest.manifestId,
    taskCount: expandTasks(manifest).length,
    tasks: expandTasks(manifest).map((task) => ({ taskId: task.taskId, split: task.split, familyId: task.familyId, variantId: task.variantId, selectedClients: task.selectedClients })),
  };
}

function showResult(manifest, taskId, anchorDate, allowHeldout) {
  const task = taskForId(manifest, taskId);
  const exposure = exposureFor(task, allowHeldout);
  return {
    command: "show",
    status: "preview_only",
    taskId: task.taskId,
    split: task.split,
    exposed: exposure.exposed,
    exposureMarker: exposure.marker,
    familyId: task.familyId,
    variantId: task.variantId,
    selectedClients: task.selectedClients,
    anchorDate,
    dates: derivedDates(task, anchorDate),
    goal: renderGoal(task, anchorDate),
    manualChecks: task.manualChecks,
  };
}

export function parseCliArgs(argv) {
  const args = [...argv];
  const command = args.shift() ?? "help";
  const options = { command, manifestPath: MANIFEST_PATH, allowHeldout: false, preset: "research", model: "glm-5.3-flash", maxSteps: 100, maxModelRequests: 100, json: false };
  for (let index = 0; index < args.length;) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") { options.command = "help"; index += 1; continue; }
    if (arg === "--allow-heldout") { options.allowHeldout = true; index += 1; continue; }
    if (arg === "--json") { options.json = true; index += 1; continue; }
    let parsed = parseOptionValue(args, index, "--manifest");
    if (parsed) { options.manifestPath = parsed.value; index = parsed.nextIndex; continue; }
    parsed = parseOptionValue(args, index, "--task");
    if (parsed) {
      options.taskId = parsed.value.toUpperCase();
      if (!TASK_ID_RE.test(options.taskId)) fail("--task must be T01 through T20");
      index = parsed.nextIndex;
      continue;
    }
    parsed = parseOptionValue(args, index, "--anchor-date");
    if (parsed) { options.anchorDate = parsed.value; index = parsed.nextIndex; continue; }
    parsed = parseOptionValue(args, index, "--trial-dir");
    if (parsed) { options.trialDirectory = parsed.value; index = parsed.nextIndex; continue; }
    parsed = parseOptionValue(args, index, "--preset");
    if (parsed) { options.preset = parsed.value; index = parsed.nextIndex; continue; }
    parsed = parseOptionValue(args, index, "--model");
    if (parsed) { options.model = parsed.value; index = parsed.nextIndex; continue; }
    parsed = parseOptionValue(args, index, "--max-steps");
    if (parsed) { options.maxSteps = Number(parsed.value); index = parsed.nextIndex; continue; }
    parsed = parseOptionValue(args, index, "--max-model-requests");
    if (parsed) { options.maxModelRequests = Number(parsed.value); index = parsed.nextIndex; continue; }
    fail(`unknown option: ${arg}`);
  }
  if (options.command === "prepare" || options.command === "show" || options.command === "run") {
    if (!options.taskId) fail(`${options.command} requires --task`);
    if (!options.anchorDate) fail(`${options.command} requires --anchor-date`);
    options.anchorDate = parseAnchorDate(options.anchorDate);
  }
  if (options.command === "collect" && !options.trialDirectory) fail("collect requires --trial-dir");
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/travel/travel.mjs list",
    "  node scripts/travel/travel.mjs show --task T01 --anchor-date YYYY-MM-DD",
    "  node scripts/travel/travel.mjs prepare --task T01 --anchor-date YYYY-MM-DD [--allow-heldout]",
    "  node scripts/travel/travel.mjs collect --trial-dir runs/travel/<trial-id>",
    "",
    "All commands are offline except an explicit run through scripts/travel/run.ps1.",
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseCliArgs(argv);
  if (options.command === "help") { process.stdout.write(`${usage()}\n`); return; }
  let result;
  if (options.command === "collect") result = await collectTrial({ trialDirectory: options.trialDirectory });
  else {
    const loaded = await readManifest(options.manifestPath);
    const manifest = loaded.value;
    const manifestHash = loaded.contentSha256;
    if (options.command === "list") result = listResult(manifest);
    else if (options.command === "show") result = showResult(manifest, options.taskId, options.anchorDate, options.allowHeldout);
    else if (options.command === "prepare") {
      const state = await repositoryState();
      result = await prepareTask({ manifest, taskId: options.taskId, anchorDate: options.anchorDate, allowHeldout: options.allowHeldout, preset: options.preset, model: options.model, maxSteps: options.maxSteps, maxModelRequests: options.maxModelRequests, manifestContentSha256: manifestHash, codeCommit: state.commit, workingTreeDirty: state.workingTreeDirty });
    }
    else fail(`unknown command: ${options.command}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, options.json ? 0 : 2)}\n`);
}

if (process.argv[1] !== undefined && pathKey(process.argv[1]) === pathKey(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
