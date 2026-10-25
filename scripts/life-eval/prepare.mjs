import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CLI_ENTRY,
  MANAGED_BROWSER_LABEL_RE,
  ROOT,
  SIX_DOMAIN_SUITE_ID,
  SUITE_ID,
  VARIANTS,
  assertApiKeyEnvName,
  builtCliFingerprint,
  gitSummary,
  jsonText,
  limitsFor,
  loadCliParser,
  manifestPathForSuite,
  parseFlags,
  parseIsoDate,
  sha256,
  suiteDefinition,
  variantsForSuite,
  sourceFingerprint,
  verifyCuaDriverBinary,
  validateCliArgv,
} from "./common.mjs";

const VALUE_FLAGS = new Set(["--output-dir", "--profile-label", "--travel-date", "--as-of-date", "--task-id", "--variant", "--wechat-chat", "--suite", "--api-key-env", "--env-file", "--risk-guard"]);
const BOOLEAN_FLAGS = new Set(["--help"]);
const CUA_SOCKET_TOKEN = "{{CUA_SOCKET}}";
const WECHAT_CHAT_TOKEN = "{{WECHAT_CHAT}}";

export function resolveRiskGuard(value) {
  const selected = value ?? "layered";
  if (selected !== "off" && selected !== "layered") throw new Error("--risk-guard must be off or layered");
  return selected;
}

export function parsePrepareArgs(argv) {
  const options = parseFlags(argv, {
    valueFlags: VALUE_FLAGS,
    booleanFlags: BOOLEAN_FLAGS,
    required: ["--output-dir", "--profile-label", "--travel-date", "--as-of-date", "--task-id", "--variant"],
  });
  if (options["--risk-guard"] !== undefined) options["--risk-guard"] = resolveRiskGuard(options["--risk-guard"]);
  return options;
}

function assertNoUnresolvedTemplate(value) {
  if (/\{\{[^}]+\}\}/u.test(value)) throw new Error("goal contains an unresolved template token");
}

export function renderGoal(task, outputAttemptDir, travelDate, wechatChat) {
  const goalPath = outputAttemptDir.replaceAll("\\", "/");
  let goal = task.goal.replaceAll("{{OUTPUT_DIR}}", goalPath);
  const usesTravelDate = goal.includes("{{TRAVEL_DATE}}");
  if (usesTravelDate) goal = goal.replaceAll("{{TRAVEL_DATE}}", travelDate);
  const usesWechatChat = goal.includes(WECHAT_CHAT_TOKEN);
  if (usesWechatChat) {
    if (typeof wechatChat !== "string" || wechatChat.trim().length === 0 || wechatChat.length > 120 || wechatChat.trim() !== wechatChat || /[\u0000-\u001f\u007f]/u.test(wechatChat)) {
      throw new Error("this task requires an exact, non-empty --wechat-chat value");
    }
    goal = goal.replaceAll(WECHAT_CHAT_TOKEN, wechatChat);
  }
  assertNoUnresolvedTemplate(goal);
  return { goal, usesTravelDate, usesWechatChat };
}

export function buildCliArgvTemplate({ goal, task, variant, variantConfig = VARIANTS[variant], limits, profileLabel, runtimeOutputDir, envFilePath, model = "deepseek-flash", batching = "same-control-input-v1", monitor = "shadow", riskGuard: requestedRiskGuard }) {
  const config = variantConfig;
  const riskGuard = resolveRiskGuard(requestedRiskGuard);
  const riskModel = riskGuard === "off" ? "off" : "same";
  const argv = [
    "--goal", goal,
    "--model", model,
    "--computer", "cua",
    "--cua-socket", CUA_SOCKET_TOKEN,
    "--multiline-type-profile", "foreground-caret-v1",
    "--window-selection", "local",
    "--grounding", "off",
    "--managed-browser-profile-mode", "persistent",
    "--managed-browser-profile-label", profileLabel,
    "--batching", batching,
    "--context-mode", "recent",
    "--context-max-events", "80",
    "--monitor", monitor,
    "--profile", "live-interactive",
    "--risk-guard", riskGuard,
    ...(riskGuard === "off" ? ["--confirm-risk-guard-off"] : []),
    "--risk-model", riskModel,
    "--risk-max-model-requests", String(limits.riskRequests),
    "--risk-timeout-ms", "90000",
    "--cleanup-deadline-ms", "15000",
    "--max-model-requests", String(limits.modelRequests),
    "--max-steps", String(limits.actions),
    "--output", runtimeOutputDir,
    "--memory", config.memory,
    "--memory-retrieval", config.retrieval,
    "--interactive",
  ];
  // Every Run starts on the primary desktop. Window activation remains
  // explicit, and the CUA adapter preserves that full-desktop Surface after
  // switch_window rather than binding capture to the selected window.
  argv.push("--window-switch");
  if (config.planning) argv.push("--planning");
  if (task.startUrl !== null && task.startUrl !== undefined) argv.push("--managed-browser-url", task.startUrl);
  if (envFilePath !== undefined) argv.push("--env-file", envFilePath);
  return argv;
}

function validateTask(task, manifest, suite) {
  if (manifest.schemaVersion !== 1 || manifest.suiteId !== suite.suiteId || !Array.isArray(manifest.tasks)) {
    throw new Error(`task manifest must be schemaVersion 1 for ${suite.suiteId}`);
  }
  if (!task || typeof task.id !== "string" || typeof task.goal !== "string" || task.goal.trim().length === 0) {
    throw new Error("selected task has no usable id/goal");
  }
  if (!Array.isArray(task.requiredApps) || !Array.isArray(task.deliverables) || !Array.isArray(task.checks)) {
    throw new Error(`task ${task.id} is missing requiredApps, deliverables, or checks`);
  }
  const requiresWechat = task.requiredApps.includes("WeChat");
  const hasWechatTarget = typeof task.goal === "string" && task.goal.includes(WECHAT_CHAT_TOKEN);
  if (requiresWechat !== hasWechatTarget) {
    throw new Error(`task ${task.id} must both require WeChat and include the exact chat target token`);
  }
  if (!["response", "document", "wechat-draft"].includes(task.outcomeMode)) throw new Error(`task ${task.id} has invalid outcomeMode`);
  if (!Array.isArray(task.activeInputs)) throw new Error(`task ${task.id} must declare activeInputs`);
  if (task.outcomeMode === "response" && task.deliverables.length !== 0) throw new Error(`response task ${task.id} must not require file deliverables`);
  if (task.outcomeMode === "document" && (task.deliverables.length !== 1 || task.deliverables[0]?.format !== "docx" || !task.requiredApps.includes("WPS"))) {
    throw new Error(`document task ${task.id} must require WPS and one DOCX deliverable`);
  }
  if (task.outcomeMode === "wechat-draft" && (task.deliverables.length !== 0 || !task.requiredApps.includes("WeChat") || !task.goal.includes(WECHAT_CHAT_TOKEN))) {
    throw new Error(`WeChat draft task ${task.id} must require WeChat, declare the chat token, and have no file deliverable`);
  }
  if (task.activeInputs.length > 0 && !task.requiredApps.includes("WPS")) throw new Error(`task ${task.id} has active inputs but does not require WPS`);
  const checkWeight = task.checks.reduce((sum, item) => sum + item.weight, 0);
  if (task.checks.length !== 5 || checkWeight !== 100) throw new Error(`task ${task.id} must have five weighted checks summing to 100`);
  if (task.startUrl !== null && task.startUrl !== undefined) {
    let url;
    try {
      url = new URL(task.startUrl);
    } catch {
      throw new Error(`task ${task.id} has an invalid startUrl`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`task ${task.id} startUrl must use http(s)`);
    if (url.username || url.password) throw new Error(`task ${task.id} startUrl must not contain credentials`);
  }
  if (!Array.isArray(task.allowedHosts) || task.allowedHosts.some((host) => typeof host !== "string" || host.trim() !== host)) {
    throw new Error(`task ${task.id} has invalid allowedHosts metadata`);
  }
}

export async function freezeActiveInputs(task, manifestPath) {
  const suiteDir = dirname(manifestPath);
  const results = [];
  for (const input of task.activeInputs) {
    if (typeof input !== "string" || input.trim() !== input || input.length === 0 || isAbsolute(input)) {
      throw new Error(`task ${task.id} has an invalid active input path`);
    }
    const path = resolve(suiteDir, input);
    const pathFromSuite = relative(suiteDir, path);
    if (pathFromSuite === ".." || pathFromSuite.startsWith(`..${sep}`) || isAbsolute(pathFromSuite)) {
      throw new Error(`task ${task.id} active input escapes the evaluation suite directory`);
    }
    const bytes = await readFile(path);
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    results.push({ relativePath: input, path, sha256: sha256(bytes), bytes: bytes.byteLength });
  }
  return results;
}

export async function createPlan(options, { root = ROOT, manifestPath, now = () => new Date(), candidateDriver, envFilePath } = {}) {
  const suite = suiteDefinition(options["--suite"] ?? SUITE_ID);
  const selectedManifestPath = manifestPath ?? manifestPathForSuite(suite.suiteId, root);
  const requestedEnvFilePath = options["--env-file"] ?? envFilePath;
  if (options["--env-file"] !== undefined && envFilePath !== undefined && resolve(options["--env-file"]) !== resolve(envFilePath)) {
    throw new Error("--env-file conflicts with configured envFilePath");
  }
  let apiKeyEnvName = null;
  if (suite.provider === "ark") {
    apiKeyEnvName = assertApiKeyEnvName(options["--api-key-env"] ?? "ARK_API_KEY");
  } else if (options["--api-key-env"] !== undefined) {
    throw new Error("--api-key-env is accepted only for the Ark Agent Plan suite");
  }
  const outputRootInput = options["--output-dir"];
  if (!isAbsolute(outputRootInput)) throw new Error("--output-dir must be an absolute path");
  const outputRoot = resolve(outputRootInput);
  const profileLabel = options["--profile-label"];
  if (!MANAGED_BROWSER_LABEL_RE.test(profileLabel)) throw new Error("--profile-label must contain 1-64 letters, digits, dot, underscore, or hyphen");
  const variant = options["--variant"];
  const suiteVariants = variantsForSuite(suite.suiteId);
  if (!Object.hasOwn(suiteVariants, variant)) throw new Error(`--variant must be one of ${Object.keys(suiteVariants).join(", ")}`);
  const variantConfig = suiteVariants[variant];
  const riskGuard = resolveRiskGuard(options["--risk-guard"]);
  const riskModel = riskGuard === "off" ? "off" : "same";
  const riskModelRequestsEnabled = riskModel !== "off";
  const asOfTime = parseIsoDate(options["--as-of-date"], "--as-of-date");
  const travelTime = parseIsoDate(options["--travel-date"], "--travel-date");
  const deltaDays = (travelTime - asOfTime) / 86_400_000;
  if (!Number.isInteger(deltaDays) || deltaDays < 1 || deltaDays > 7) {
    throw new Error("--travel-date must be 1 to 7 days after --as-of-date (this validates only the requested offset, not service availability)");
  }
  if (requestedEnvFilePath !== undefined && (typeof requestedEnvFilePath !== "string" || !isAbsolute(requestedEnvFilePath))) {
    throw new Error("configured envFilePath must be absolute");
  }
  const cuaDriver = await verifyCuaDriverBinary(candidateDriver);

  const manifestBytes = await readFile(selectedManifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.suiteId !== suite.suiteId || manifest.schemaVersion !== 1 || !Array.isArray(manifest.tasks)) {
    throw new Error(`task manifest must be schemaVersion 1 for ${suite.suiteId}`);
  }
  const task = manifest.tasks.find((candidate) => candidate.id === options["--task-id"]);
  if (!task) throw new Error(`task id not found: ${options["--task-id"]}`);
  validateTask(task, manifest, suite);
  const requiresWechat = task.requiredApps.includes("WeChat") && task.goal.includes(WECHAT_CHAT_TOKEN);
  const wechatChat = options["--wechat-chat"];
  if (requiresWechat) {
    if (typeof wechatChat !== "string" || wechatChat.trim().length === 0 || wechatChat.trim() !== wechatChat || /[\u0000-\u001f\u007f]/u.test(wechatChat)) {
      throw new Error("this WeChat task requires an exact, non-empty --wechat-chat recipient name");
    }
  } else if (wechatChat !== undefined) {
    throw new Error("--wechat-chat is accepted only for tasks that require WeChat and declare the chat target token");
  }
  const activeInputs = await freezeActiveInputs(task, selectedManifestPath);
  const limits = limitsFor(task.difficulty);
  const packageId = `${task.id}-${variant}-${options["--travel-date"].replaceAll("-", "")}-${randomUUID().slice(0, 8)}`;
  const packageDir = join(root, "runs", suite.suiteId, packageId);
  const outputAttemptDir = suite.suiteId === SIX_DOMAIN_SUITE_ID
    ? resolve(outputRoot, suite.suiteId, variant, task.id, packageId)
    : resolve(outputRoot, task.id, variant, packageId);
  const outputRelative = relative(outputRoot, outputAttemptDir);
  if (outputRelative.startsWith(`..${sep}`) || outputRelative === ".." || isAbsolute(outputRelative)) {
    throw new Error("computed attempt output directory escaped --output-dir");
  }
  const { goal, usesTravelDate, usesWechatChat } = renderGoal(task, outputAttemptDir, options["--travel-date"], wechatChat);
  const runtimeOutputDir = join(packageDir, "runtime-output");
  const argvTemplate = buildCliArgvTemplate({
    goal,
    task,
    variant,
    variantConfig,
    limits,
    profileLabel,
    runtimeOutputDir,
    envFilePath: requestedEnvFilePath,
    model: suite.model,
    batching: suite.batching,
    monitor: suite.suiteId === SIX_DOMAIN_SUITE_ID ? "guidance" : "shadow",
    riskGuard,
  });
  const parseArgs = await loadCliParser();
  validateCliArgv(parseArgs, argvTemplate.map((value) => value === CUA_SOCKET_TOKEN ? "dry-run-cua-socket-placeholder" : value));

  const gitState = gitSummary(root);
  const source = await sourceFingerprint(root);
  const builtCli = await builtCliFingerprint(root);
  const plan = {
    schemaVersion: 1,
    suiteId: suite.suiteId,
    packageId,
    preparedAt: now().toISOString(),
    packageDir,
    task: {
      id: task.id,
      category: task.category,
      difficulty: task.difficulty,
      title: task.title,
      goal,
      startUrl: task.startUrl ?? null,
      allowedHosts: [...task.allowedHosts],
      requiredApps: [...task.requiredApps],
      requiresLogin: task.requiresLogin,
      sourceIds: [...task.sourceIds],
      outcomeMode: task.outcomeMode,
      wechatChat: wechatChat ?? null,
      activeInputs,
      deliverables: task.deliverables.map((item) => ({ ...item })),
      checks: task.checks.map((item) => ({ ...item })),
    },
    selection: {
      variant,
      profileLabel,
      outputRoot,
      outputAttemptDir,
      asOfDate: options["--as-of-date"],
      travelDate: options["--travel-date"],
      travelDateAppliedToGoal: usesTravelDate,
      wechatChatAppliedToGoal: usesWechatChat,
      wechatChat: wechatChat ?? null,
      travelDateValidation: "calendar-day offset only; no transport-date/service availability verification",
    },
    configuration: {
      model: suite.model,
      providerEnabledByDefault: false,
      requestTimeoutMs: 90_000,
      maxOutputTokens: 4096,
      maxModelRequests: limits.modelRequests,
      maxRiskModelRequests: limits.riskRequests,
      combinedRequestCeiling: limits.totalModelRequests,
      maxActions: limits.actions,
      runTimeoutMs: limits.timeoutMs,
      riskTimeoutMs: 90_000,
      cleanupDeadlineMs: 15_000,
      planning: variantConfig.planning,
      memory: variantConfig.memory,
      memoryRetrieval: variantConfig.retrieval,
      batching: suite.batching,
      ...(suite.thinking === undefined ? {} : { thinking: suite.thinking }),
      multilineTypeProfile: "foreground-caret-v1",
      monitor: suite.suiteId === SIX_DOMAIN_SUITE_ID ? "guidance" : "shadow",
      ...(variantConfig.supervision === undefined ? {} : { supervision: { ...variantConfig.supervision } }),
      riskProfile: "live-interactive",
      riskGuard,
      riskModel,
      confirmRiskGuardOff: riskGuard === "off",
      riskModelRequestsEnabled,
      riskModelRequestLimitStatus: riskModelRequestsEnabled ? "active" : "inactive_risk_model_off",
      contextMode: "recent",
      contextMaxHistoryEvents: 80,
      windowSwitch: "opened-windows-v1",
      windowSelection: "local",
      grounding: "off",
      requestedGrounding: "off",
      managedBrowserCompanion: true,
      initialCapture: "primary-desktop",
      managedBrowserProfileMode: "persistent",
      cuaDriver,
      allowedHostsEnforcement: "not enforced by current CLI; informational for human review",
      nativeAppStartup: "manual; runner does not launch or preselect native application windows",
      environment: {
        envFilePath: requestedEnvFilePath ?? null,
        apiKeyEnvName,
        apiKeyTargetEnvName: suite.apiKeyTargetEnv,
        ...(suite.provider === "deepseek" ? {
          deepseekVariablesSetOnlyForLiveChild: {
            DEEPSEEK_REQUEST_TIMEOUT_MS: "90000",
            DEEPSEEK_MAX_OUTPUT_TOKENS: "4096",
          },
        } : {
          arkVariablesSetOnlyForLiveChild: {
            ARK_REQUEST_TIMEOUT_MS: "90000",
            ARK_MAX_OUTPUT_TOKENS: "4096",
          },
        }),
      },
    },
    cli: {
      entry: CLI_ENTRY,
      executable: process.execPath,
      argvTemplate,
      envFilePath: requestedEnvFilePath ?? null,
      cuaSocketToken: CUA_SOCKET_TOKEN,
      shell: false,
      stdin: "inherit for CLI approvals and user-input requests",
      stdoutStderr: "tee to terminal and private per-attempt logs",
    },
    frozenState: {
      manifestPath: selectedManifestPath,
      manifestSha256: sha256(manifestBytes),
      git: gitState,
      sourceFingerprint: source,
      builtCliFingerprint: builtCli,
      nodeVersion: process.version,
    },
  };
  const planBytes = Buffer.from(jsonText(plan), "utf8");
  const review = {
    schemaVersion: 1,
    packageId,
    profileLabel,
    planSha256: sha256(planBytes),
    preflight: {
      status: "pending",
      checkedAt: null,
      operator: null,
      requiredApps: task.requiredApps.map((app) => ({ app, status: "pending" })),
      activeInputs: activeInputs.map(({ relativePath, sha256: inputSha }) => ({ relativePath, sha256: inputSha, status: "pending" })),
      cuaDaemon: cuaDriver === null ? null : {
        status: "pending",
        socketPath: null,
        binarySha256: null,
        note: "Human must verify the already-running daemon behind the selected socket; candidate file hash alone does not establish daemon identity.",
      },
      wechatChat: wechatChat ?? null,
      wechatTestChatAuthorized: requiresWechat ? false : null,
      note: "Human must verify target apps/profile, open any listed input manually, and confirm any exact WeChat target and send authorization; runner does not open apps, select chats, read history, credentials, or browser profile data.",
    },
    firstSupervisedRunAccepted: false,
    batchAuthorized: false,
    authorizedTaskVariants: [],
    deliverableReviews: task.deliverables.map((item) => ({ name: item.name, status: "pending", notes: "" })),
    checkScores: task.checks.map((item) => ({ id: item.id, weight: item.weight, score: null, notes: "" })),
    consumerReview: {
      outcomeMode: task.outcomeMode,
      status: "pending",
      reviewer: null,
      reviewedAt: null,
      notes: "",
      ...(requiresWechat ? {
        wechatDelivery: {
          targetChat: wechatChat,
          fileName: task.deliverables[0]?.name ?? null,
          status: "pending",
          reviewedAt: null,
          notes: task.outcomeMode === "response"
            ? "Human must verify that the text message was sent to the exact target; no attachment is expected and delivery is not auto-scored."
            : task.outcomeMode === "document"
              ? "Human must separately verify the same saved file was sent to the exact target; this is not auto-scored."
              : "Human must verify that the exact target contains the unsent text draft; runner does not inspect chat history or send state.",
        },
      } : {}),
    },
  };

  await mkdir(join(root, "runs", suite.suiteId), { recursive: true });
  await mkdir(packageDir, { recursive: false });
  try {
    await mkdir(dirname(outputAttemptDir), { recursive: true });
    await mkdir(outputAttemptDir, { recursive: false });
    await writeFile(join(packageDir, "plan.json"), planBytes, { flag: "wx" });
    await writeFile(join(packageDir, "review.json"), jsonText(review), { encoding: "utf8", flag: "wx" });
  } catch (error) {
    // Keep any partially created package/output as an auditable failed prepare; never delete user data.
    try {
      await writeFile(join(packageDir, "prepare-failure.json"), jsonText({
        packageId,
        failedAt: now().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      }), { encoding: "utf8", flag: "wx" });
    } catch {
      // Preserve the original error if even the failure record cannot be written.
    }
    throw error;
  }
  return { packageId, packageDir, outputAttemptDir, plan, review };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === "--help") {
    process.stdout.write("Usage: node scripts/life-eval/prepare.mjs [--suite <suiteId>] --output-dir <absolute> --profile-label <label> --as-of-date YYYY-MM-DD --travel-date YYYY-MM-DD --task-id <suite task id> --variant <variant> [--risk-guard <layered|off>] [--api-key-env <ARK_API_KEY|HUOSHAN_API_KEY for Ark suite>] [--env-file <absolute>] [--wechat-chat <exact recipient name; only when the selected task requires WeChat>]\nOmitting --risk-guard preserves layered Risk Guard with --risk-model same. Selecting off freezes --risk-model off and --confirm-risk-guard-off; the positive risk request cap remains recorded but is inactive. Prepare never reads API-key values or the env file.\n");
    return;
  }
  const options = parsePrepareArgs(argv);
  const result = await createPlan(options);
  process.stdout.write(`${JSON.stringify({
    status: "prepared-offline",
    packageId: result.packageId,
    packageDir: result.packageDir,
    outputAttemptDir: result.outputAttemptDir,
    task: result.plan.task.id,
    variant: result.plan.selection.variant,
    model: result.plan.configuration.model,
    riskGuard: result.plan.configuration.riskGuard,
    riskModel: result.plan.configuration.riskModel,
    riskModelRequestsEnabled: result.plan.configuration.riskModelRequestsEnabled,
    providerEnabledByDefault: false,
    cliEntry: result.plan.cli.entry,
  }, null, 2)}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
