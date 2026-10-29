import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createWriteStream } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import {
  MANIFEST_PATH,
  ROOT,
  SHOPPING_COMMUNICATION_SUITE_ID,
  SIX_DOMAIN_SUITE_ID,
  SUITE_ID,
  VARIANTS,
  limitsFor,
  loadCliModule,
  manifestPathForSuite,
  pathExists,
  parseIsoDate,
  sha256,
  suiteDefinition,
} from "./common.mjs";
import {
  buildCliArgvTemplate,
  createPlan,
  parsePrepareArgs,
  renderGoal,
} from "./prepare.mjs";
import {
  assertFreezeMatches,
  assertLiveAuthorization,
  assertRiskPolicy,
  buildLiveAttemptRecord,
  buildLiveChildEnvironment,
  concreteArgv,
  parseSelectedEnvValue,
  parseRunArgs,
  runLive,
  runPackage,
} from "./run.mjs";
import { inspectSupervision, readSupervisionReceipt, submitSupervisionCommand } from "./supervision.mjs";

const token = "{{CUA_SOCKET}}";

test("prepare accepts explicit paths/profile/task/variant and rejects missing choices", () => {
  const options = parsePrepareArgs([
    "--output-dir", "E:\\life-eval-output",
    "--profile-label", "LifeEval-20261015",
    "--as-of-date", "2026-10-15",
    "--travel-date", "2026-10-20",
    "--task-id", "T01",
    "--variant", "B00",
    "--wechat-chat", "LifeEval test chat",
  ]);
  assert.equal(options["--task-id"], "T01");
  assert.equal(options["--variant"], "B00");
  assert.equal(options["--wechat-chat"], "LifeEval test chat");
  const arkOptions = parsePrepareArgs([
    "--suite", SHOPPING_COMMUNICATION_SUITE_ID,
    "--api-key-env", "HUOSHAN_API_KEY",
    "--env-file", "E:\\private\\life-eval.env",
    "--output-dir", "E:\\life-eval-output",
    "--profile-label", "LifeEval-Shopping",
    "--as-of-date", "2026-10-15",
    "--travel-date", "2026-10-16",
    "--task-id", "S01",
    "--variant", "B00",
  ]);
  assert.equal(arkOptions["--suite"], SHOPPING_COMMUNICATION_SUITE_ID);
  assert.equal(arkOptions["--api-key-env"], "HUOSHAN_API_KEY");
  assert.equal(arkOptions["--env-file"], "E:\\private\\life-eval.env");
  assert.throws(() => parsePrepareArgs(["--task-id", "G01"]), /--output-dir is required/u);
  assert.throws(() => parsePrepareArgs(["--suite", "unknown-suite"]), /--output-dir is required/u);
  assert.throws(() => parseIsoDate("2026-02-30", "--travel-date"), /calendar date/u);
});

test("only manifest goal text is projected; output and travel tokens are frozen per task attempt", () => {
  const rendered = renderGoal({ goal: "请于{{TRAVEL_DATE}}完成任务并保存到 {{OUTPUT_DIR}}/result.txt" }, "E:\\out\\T01\\B00\\attempt-1", "2026-10-20");
  assert.equal(rendered.usesTravelDate, true);
  assert.equal(rendered.goal, "请于2026-10-20完成任务并保存到 E:/out/T01/B00/attempt-1/result.txt");
  assert.throws(() => renderGoal({ goal: "{{OUTPUT_DIR}} {{UNKNOWN}}" }, "E:\\out", "2026-10-20"), /unresolved template/u);
  const wechat = renderGoal({ goal: "请在《{{WECHAT_CHAT}}》保留未发送草稿。" }, "E:\\out", "2026-10-20", "Research Test Chat");
  assert.equal(wechat.usesWechatChat, true);
  assert.equal(wechat.goal, "请在《Research Test Chat》保留未发送草稿。");
  assert.equal(renderGoal({ goal: "《{{WECHAT_CHAT}}》" }, "E:\\out", "2026-10-20", "User-selected chat").goal, "《User-selected chat》");
  assert.throws(() => renderGoal({ goal: "{{WECHAT_CHAT}}" }, "E:\\out", "2026-10-20"), /exact, non-empty/u);
});

test("variant planning/memory/retrieval options are the only changing CLI feature fields and parse as real CLI args", async () => {
  const cli = await loadCliModule();
  const priorTimeout = process.env.DEEPSEEK_REQUEST_TIMEOUT_MS;
  const priorOutputTokens = process.env.DEEPSEEK_MAX_OUTPUT_TOKENS;
  process.env.DEEPSEEK_REQUEST_TIMEOUT_MS = "90000";
  process.env.DEEPSEEK_MAX_OUTPUT_TOKENS = "4096";
  const task = { startUrl: "https://mzj.sh.gov.cn/", requiredApps: ["managed-browser"] };
  const limits = { modelRequests: 100, riskRequests: 20, actions: 80 };
  try {
    const argvByVariant = Object.fromEntries(Object.entries(VARIANTS).map(([variant]) => {
      const argvTemplate = buildCliArgvTemplate({
        goal: "检查公开网页并写入用户指定文件。",
        task,
        variant,
        limits,
        profileLabel: "LifeEval-20261015",
        runtimeOutputDir: "E:\\private\\runs\\runtime",
      });
      const argv = argvTemplate.map((value) => value === token ? "offline-cua-placeholder" : value);
      const parsed = cli.parseArgs(argv);
      const resolved = cli.toResolvedRunConfig(parsed, parsed.goal);
      return [variant, { argv, parsed, resolved }];
    }));

    assert.equal(argvByVariant.B00.parsed.planning, false);
    assert.equal(argvByVariant.B00.parsed.memory, "off");
    assert.equal(argvByVariant.P10.parsed.planning, true);
    assert.equal(argvByVariant.P10.parsed.memory, "off");
    assert.equal(argvByVariant.M01.parsed.planning, false);
    assert.equal(argvByVariant.M01.parsed.memory, "facts");
    assert.equal(argvByVariant.M01.parsed.memoryRetrieval, "lexical");
    assert.equal(argvByVariant.PM11.parsed.planning, true);
    assert.equal(argvByVariant.PM11.parsed.memory, "facts");
    assert.equal(argvByVariant.PM11.parsed.memoryRetrieval, "lexical");
    for (const { argv, parsed, resolved } of Object.values(argvByVariant)) {
      assert.equal(parsed.model, "deepseek-flash");
      assert.equal(parsed.multilineTypeProfile, "foreground-caret-v1");
      assert.equal(parsed.grounding, "off");
      assert.equal(parsed.risk.riskGuard, "layered");
      assert.equal(parsed.riskModel, "same");
      assert.equal(parsed.batching, "same-control-input-v1");
      assert.equal(parsed.contextMode, "recent");
      assert.equal(parsed.monitor, "shadow");
      assert.equal(parsed.windowSwitch, true);
      assert.equal(parsed.interactive, true);
      assert.equal(resolved.computer.grounding, "off");
      assert.equal(resolved.computer.multilineTypeProfile, "foreground-caret-v1");
      assert.equal(resolved.computer.managedBrowserUrl, task.startUrl);
      assert.equal(resolved.computer.managedBrowserCompanion, true);
      assert.equal(Object.hasOwn(resolved.computer, "windowTarget"), false);
      assert.equal(resolved.computer.managedBrowserProfileMode, "persistent");
      assert.equal(resolved.computer.managedBrowserProfileLabel, "LifeEval-20261015");
      assert.equal(resolved.windowSwitch, "opened-windows-v1");
      assert.equal(resolved.deepseekRequestTimeoutMs, 90_000);
      assert.equal(resolved.deepseekMaxOutputTokens, 4096);
      assert.equal(argv.includes("--env-file"), false);
      assert.equal(argv.includes("--sourceIds"), false);
      assert.equal(argv.includes("--checks"), false);
    }
    const base = argvByVariant.B00.argv.filter((value) => value !== "--planning");
    const featureNeutral = argvByVariant.P10.argv.filter((value) => value !== "--planning");
    assert.deepEqual(base, featureNeutral);
    for (const requiredApps of [["managed-browser", "WPS"], ["managed-browser", "WeChat"]]) {
      const argv = buildCliArgvTemplate({
        goal: "只核对窗口投影配置。",
        task: { ...task, requiredApps },
        variant: "B00",
        limits,
        profileLabel: "LifeEval-20261015",
        runtimeOutputDir: "E:\\private\\runs\\runtime",
      }).map((value) => value === token ? "offline-cua-placeholder" : value);
      const parsed = cli.parseArgs(argv);
      const resolved = cli.toResolvedRunConfig(parsed, parsed.goal);
      assert.equal(parsed.windowSwitch, true);
      assert.equal(resolved.windowSwitch, "opened-windows-v1");
    }
  } finally {
    if (priorTimeout === undefined) delete process.env.DEEPSEEK_REQUEST_TIMEOUT_MS;
    else process.env.DEEPSEEK_REQUEST_TIMEOUT_MS = priorTimeout;
    if (priorOutputTokens === undefined) delete process.env.DEEPSEEK_MAX_OUTPUT_TOKENS;
    else process.env.DEEPSEEK_MAX_OUTPUT_TOKENS = priorOutputTokens;
  }
});

test("Run uses the CUA socket placeholder only in preview and receipt gates live execution", () => {
  const options = parseRunArgs(["--package", "E:\\repo\\runs\\pkg"]);
  assert.equal(options["--live"], undefined);
  assert.throws(() => parseRunArgs(["--live"]), /--package is required/u);

  const plan = {
    packageId: "G01-B00-demo",
    packageDir: "E:\\repo\\runs\\pkg",
    task: { id: "G01", requiredApps: ["managed-browser"], activeInputs: [], outcomeMode: "response" },
    selection: { variant: "B00", profileLabel: "LifeEval" },
    cli: { argvTemplate: ["--goal", "中文目标", "--cua-socket", token] },
  };
  assert.deepEqual(concreteArgv(plan, "\\\\.\\pipe\\cua"), ["--goal", "中文目标", "--cua-socket", "\\\\.\\pipe\\cua"]);

  const review = {
    packageId: plan.packageId,
    profileLabel: "LifeEval",
    preflight: {
      status: "passed",
      checkedAt: "2026-10-15T10:00:00.000Z",
      operator: "operator",
      requiredApps: [{ app: "managed-browser", status: "passed" }],
      activeInputs: [],
    },
    firstSupervisedRunAccepted: false,
    batchAuthorized: false,
  };
  assert.doesNotThrow(() => assertLiveAuthorization(review, plan, true));
  assert.throws(() => assertLiveAuthorization(review, plan, false), /firstSupervisedRunAccepted/u);
  assert.throws(() => assertLiveAuthorization({ ...review, preflight: { ...review.preflight, status: "pending" } }, plan, true), /preflight.status=passed/u);
  assert.doesNotThrow(() => assertLiveAuthorization({
    ...review,
    firstSupervisedRunAccepted: true,
    batchAuthorized: true,
    authorizedTaskVariants: ["G01:B00"],
  }, plan, false));
  const candidatePlan = {
    ...plan,
    configuration: {
      cuaDriver: {
        binaryPath: "E:\\candidate-cua-driver.exe",
        sha256: "A".repeat(64),
        version: "0.22.2",
        sourceCommit: "7852ab1",
        verificationScope: "candidate-file-hash-only; running-daemon identity is not verified",
      },
    },
  };
  const daemonPreflightReview = {
    ...review,
    preflight: {
      ...review.preflight,
      cuaDaemon: {
        status: "passed",
        socketPath: "\\\\.\\pipe\\life-eval-fixture",
        binarySha256: "A".repeat(64),
        version: "0.22.2",
        sourceCommit: "7852ab1",
        identityConfirmed: true,
      },
    },
  };
  assert.throws(() => assertLiveAuthorization(daemonPreflightReview, candidatePlan, true, "\\\\.\\pipe\\other-socket"), /human confirmation.*selected CUA socket/u);
  assert.doesNotThrow(() => assertLiveAuthorization(daemonPreflightReview, candidatePlan, true, "\\\\.\\pipe\\life-eval-fixture"));
  assert.throws(() => assertLiveAuthorization({
    ...daemonPreflightReview,
    preflight: { ...daemonPreflightReview.preflight, cuaDaemon: { ...daemonPreflightReview.preflight.cuaDaemon, identityConfirmed: false } },
  }, candidatePlan, true, "\\\\.\\pipe\\life-eval-fixture"), /human confirmation.*selected CUA socket/u);
  const wechatPlan = {
    ...plan,
    task: {
      id: "T03",
      requiredApps: ["managed-browser", "WPS", "WeChat"],
      activeInputs: [],
      outcomeMode: "document",
      wechatChat: "文件传输助手",
      deliverables: [{ name: "T03-南京出行资料.docx", format: "docx" }],
    },
  };
  const wechatReview = {
    ...review,
    packageId: plan.packageId,
    preflight: {
      ...review.preflight,
      wechatChat: "文件传输助手",
      wechatTestChatAuthorized: false,
      requiredApps: [{ app: "managed-browser", status: "passed" }, { app: "WPS", status: "passed" }, { app: "WeChat", status: "passed" }],
    },
  };
  assert.throws(() => assertLiveAuthorization(wechatReview, wechatPlan, true), /wechatTestChatAuthorized=true/u);
  assert.throws(() => assertLiveAuthorization({
    ...wechatReview,
    preflight: { ...wechatReview.preflight, wechatChat: "其他联系人", wechatTestChatAuthorized: true },
  }, wechatPlan, true), /exact matching recipient/u);
  assert.doesNotThrow(() => assertLiveAuthorization({
    ...wechatReview,
    preflight: { ...wechatReview.preflight, wechatTestChatAuthorized: true },
  }, wechatPlan, true));
});

test("freeze check rejects a changed manifest or source/build fingerprint", () => {
  const plan = {
    schemaVersion: 1,
    suiteId: "life-business-20261015",
    packageDir: "E:\\repo\\runs\\pkg",
    configuration: {
      model: "deepseek-flash",
      batching: "same-control-input-v1",
      environment: { apiKeyEnvName: null, apiKeyTargetEnvName: null },
    },
    frozenState: {
      manifestSha256: sha256("manifest"),
      git: { head: "head" },
      sourceFingerprint: { sha256: "source-hash" },
      builtCliFingerprint: { sha256: "cli-hash" },
    },
  };
  assert.throws(() => assertFreezeMatches(plan, plan.packageDir, Buffer.from("changed"), { sha256: "source-hash" }, { sha256: "cli-hash" }), /manifest changed/u);
  assert.throws(() => assertFreezeMatches(plan, plan.packageDir, Buffer.from("manifest"), { sha256: "changed" }, { sha256: "cli-hash" }), /source fingerprint changed/u);
  assert.throws(() => assertFreezeMatches(plan, plan.packageDir, Buffer.from("manifest"), { sha256: "source-hash" }, { sha256: "cli-hash" }, { head: "new-head" }), /git source version changed/u);
});

test("manifest fixture contains nine identified tasks and no answer key is projected by argv builder", async () => {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.tasks.length, 9);
  assert.deepEqual(manifest.tasks.filter((task) => task.category === "government").map((task) => task.id), ["G01", "G02", "G03"]);
  assert.deepEqual(manifest.tasks.filter((task) => task.category === "travel").map((task) => task.id), ["T01", "T02", "T03"]);
  assert.deepEqual(manifest.tasks.filter((task) => task.category === "medical").map((task) => task.id), ["M01", "M02", "M03"]);
  const activeInputTasks = manifest.tasks.filter((task) => task.activeInputs.length > 0).map((task) => task.id);
  assert.deepEqual(activeInputTasks, []);
  assert.deepEqual(manifest.tasks.filter((task) => task.outcomeMode === "wechat-draft").map((task) => task.id), []);
  assert.deepEqual(manifest.tasks.filter((task) => task.outcomeMode === "document").map((task) => task.id), ["G03", "T03"]);
  assert.deepEqual(manifest.tasks.filter((task) => task.outcomeMode === "response").map((task) => task.id), ["G01", "G02", "T01", "T02", "M01", "M02", "M03"]);
  assert.deepEqual(manifest.tasks.filter((task) => task.requiredApps.includes("WeChat")).map((task) => task.id), ["T03"]);
  assert.deepEqual(manifest.tasks.filter((task) => task.requiredApps.some((app) => app !== "managed-browser")).map((task) => task.id), ["G03", "T03"]);
  const t02 = manifest.tasks.find((task) => task.id === "T02");
  assert.equal(t02.title, "高德上海虹桥至上海博物馆公共交通路线比较");
  assert.equal(t02.difficulty, "medium");
  assert.equal(t02.startUrl, "https://map.gaode.com/");
  assert.deepEqual(t02.allowedHosts, ["map.gaode.com", "www.amap.com"]);
  assert.deepEqual(t02.sourceIds, ["S-T4"]);
  assert.deepEqual(t02.requiredApps, ["managed-browser"]);
  assert.equal(t02.requiresLogin, false);
  assert.match(t02.goal, /上海虹桥站去上海博物馆（人民广场馆）/u);
  assert.match(t02.goal, /少换乘、少走路/u);
  assert.doesNotMatch(`${t02.title} ${t02.sourceLineage} ${t02.goal}`, /12306|重点旅客|需要登录|铁路规则/u);
  const t03 = manifest.tasks.find((task) => task.id === "T03");
  assert.equal(t03.outcomeMode, "document");
  assert.deepEqual(t03.requiredApps, ["managed-browser", "WPS", "WeChat"]);
  assert.deepEqual(t03.deliverables, [{ name: "T03-南京出行资料.docx", format: "docx" }]);
  assert.match(t03.goal, /通过微信发送给《\{\{WECHAT_CHAT\}\}》/u);
  assert.match(t03.goal, /只把这一份文件发给该会话，不向其他联系人发送，也不发送其他文件/u);
  assert.match(t03.checks.find((item) => item.id === "consumer").description, /分别人工核验文件与投递，不自动判分/u);
  assert.match(t03.checks.find((item) => item.id === "constraints").description, /只向指定微信会话发送这一个DOCX/u);
  assert.doesNotMatch(`${t03.title} ${t03.sourceLineage}`, /银行|电话预约/u);
  for (const taskId of ["T02", "M02"]) {
    const task = manifest.tasks.find((candidate) => candidate.id === taskId);
    assert.deepEqual(task.requiredApps, ["managed-browser"]);
    assert.equal(task.requiresLogin, false);
    assert.equal(task.outcomeMode, "response");
    assert.doesNotMatch(`${task.title} ${task.sourceLineage}`, /微信|wechat|draft/iu);
  }
  const inputsDir = join(ROOT, "eval", SUITE_ID, "inputs");
  const activeInputNames = await pathExists(inputsDir) ? (await readdir(inputsDir)).sort() : [];
  assert.deepEqual(activeInputNames, []);
  for (const category of ["government", "travel", "medical"]) {
    assert.deepEqual(manifest.tasks.filter((task) => task.category === category).map((task) => task.difficulty), ["easy", "medium", "hard"]);
  }
  for (const task of manifest.tasks) {
    assert.ok(["response", "document", "wechat-draft"].includes(task.outcomeMode));
    assert.equal(task.checks.reduce((sum, item) => sum + item.weight, 0), 100);
    assert.equal(task.checks.length, 5);
    assert.equal(task.goal.includes("{{OUTPUT_DIR}}"), task.outcomeMode === "document", `${task.id} output token matches its consumer`);
    assert.equal(task.goal.includes("{{WECHAT_CHAT}}"), task.id === "T03", `${task.id} chat target token matches its WeChat requirement`);
    assert.equal(task.goal.includes("{{TRAVEL_DATE}}"), ["T01", "T03"].includes(task.id));
    assert.doesNotMatch(task.goal, /评分|查阅日期|文件日期|停留在|结束时|每项注明|每组事实|至少两篇|分三节|保存对话框|文件名框|控件|运行轨迹|必须|必须逐/u, `${task.id} is a natural user request`);
    const argv = buildCliArgvTemplate({
      goal: task.goal.replaceAll("{{OUTPUT_DIR}}", "E:\\out\\${task.id}").replaceAll("{{TRAVEL_DATE}}", "2026-10-20").replaceAll("{{WECHAT_CHAT}}", "LifeEval test chat"),
      task,
      variant: "B00",
      limits: { modelRequests: 100, riskRequests: 20, actions: 80 },
      profileLabel: "LifeEval",
      runtimeOutputDir: "E:\\private\\runtime",
    });
    const goalIndex = argv.indexOf("--goal");
    assert.equal(argv[goalIndex + 1].includes(JSON.stringify(task.checks)), false);
    assert.equal(argv[goalIndex + 1].includes(JSON.stringify(task.sourceIds)), false);
    assert.equal(argv.includes("--window-switch"), true, `${task.id} starts on desktop with explicit window activation available`);
    assert.equal(argv[argv.indexOf("--grounding") + 1], "off");
    if (task.id === "T03") assert.equal(argv.includes("--window-switch"), true);
  }
});

test("six-task suite metadata, official start URLs, fixed Goals, Ark model, and disabled batching stay isolated", async () => {
  const manifestPath = manifestPathForSuite(SHOPPING_COMMUNICATION_SUITE_ID);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.suiteId, SHOPPING_COMMUNICATION_SUITE_ID);
  assert.deepEqual(manifest.tasks.map((task) => task.id), ["S01", "S02", "S03", "CM01", "CM02", "CM03"]);
  const cli = await loadCliModule();
  const expectedDefaults = {
    suiteId: SHOPPING_COMMUNICATION_SUITE_ID,
    model: "deepseek-v4.1-flash",
    provider: "ark",
    batching: "off",
    apiKeyTargetEnv: "ARK_API_KEY",
  };
  assert.equal(expectedDefaults.suiteId, manifest.suiteId);
  assert.equal(suiteDefinition(SHOPPING_COMMUNICATION_SUITE_ID).provider, expectedDefaults.provider);
  assert.equal(suiteDefinition(SHOPPING_COMMUNICATION_SUITE_ID).apiKeyTargetEnv, expectedDefaults.apiKeyTargetEnv);
  assert.throws(() => manifestPathForSuite("not-a-life-eval-suite"), /unsupported life-eval suite/u);
  for (const task of manifest.tasks) {
    for (const field of ["id", "difficulty", "title", "goal", "startUrl", "allowedHosts", "requiredApps", "requiresLogin", "sourceIds", "outcomeMode", "activeInputs", "deliverables", "checks"]) {
      assert.ok(Object.hasOwn(task, field), `${task.id} declares ${field}`);
    }
    const url = new URL(task.startUrl);
    assert.ok(["https:", "http:"].includes(url.protocol));
    assert.ok(task.allowedHosts.includes(url.hostname), `${task.id} start host is allowlisted`);
    assert.equal(task.checks.length, 5);
    assert.equal(task.checks.reduce((sum, check) => sum + check.weight, 0), 100);
    assert.equal(task.activeInputs.length, 0);
    if (task.outcomeMode === "document") assert.equal(task.goal.includes("\n"), true);
    if (task.id === "CM02") {
      const fixedGoal = renderGoal(task, "E:\\output\\CM02\\M01\\attempt", "2026-10-16").goal;
      assert.match(fixedGoal, /2026年11月4日至11月25日/u);
      assert.equal(fixedGoal.includes("2026-10-16"), false);
    }
    for (const variant of Object.keys(VARIANTS)) {
      const goal = renderGoal(task, `E:\\output\\${task.id}\\${variant}\\attempt`, "2026-10-16").goal;
      const argv = buildCliArgvTemplate({
        goal,
        task,
        variant,
        limits: limitsFor(task.difficulty),
        profileLabel: "LifeEval-Six",
        runtimeOutputDir: `E:\\private\\runs\\${task.id}\\${variant}`,
        envFilePath: "E:\\private\\life-eval.env",
        model: expectedDefaults.model,
        batching: expectedDefaults.batching,
      }).map((value) => value === token ? "offline-cua-placeholder" : value);
      const parsed = cli.parseArgs(argv);
      assert.equal(parsed.model, expectedDefaults.model);
      assert.equal(parsed.batching, "off");
      assert.equal(argv[argv.indexOf("--managed-browser-url") + 1], task.startUrl);
      assert.equal(parsed.planning, VARIANTS[variant].planning);
      assert.equal(parsed.memory, VARIANTS[variant].memory);
      assert.equal(parsed.memoryRetrieval, VARIANTS[variant].retrieval);
      assert.equal(JSON.stringify(argv).includes(JSON.stringify(task.sourceIds)), false);
      assert.equal(JSON.stringify(argv).includes(JSON.stringify(task.checks)), false);
      assert.equal(JSON.stringify(argv).includes("S-C1"), false);
    }
  }
  assert.equal(manifest.tasks.find((task) => task.id === "S03").goal.includes("\\n"), false);
  assert.equal(manifest.tasks.find((task) => task.id === "CM03").goal.includes("\\n"), false);
  assert.notEqual(manifestPathForSuite(SUITE_ID), manifestPath);
});

test("Ark key selection reads only the frozen allowlisted variable and never falls back to parent env", async () => {
  const envFilePath = join(tmpdir(), "life-eval-ark-key-fixture.env");
  const plan = {
    suiteId: SHOPPING_COMMUNICATION_SUITE_ID,
    configuration: {
      environment: {
        apiKeyEnvName: "HUOSHAN_API_KEY",
        apiKeyTargetEnvName: "ARK_API_KEY",
      },
    },
    cli: { envFilePath },
  };
  const envText = [
    "# offline fixture only",
    "UNRELATED_SECRET=fixture-unrelated-secret",
    "ARK_API_KEY=fixture-decoy-key",
    "HUOSHAN_API_KEY='fixture-selected-key'",
    "",
  ].join("\r\n");
  assert.equal(parseSelectedEnvValue(envText, "HUOSHAN_API_KEY"), "fixture-selected-key");
  assert.equal(parseSelectedEnvValue(envText, "ARK_API_KEY"), "fixture-decoy-key");

  const readPaths = [];
  const childEnv = await buildLiveChildEnvironment(plan, {
    parentEnv: {
      PATH: "fixture-path",
      ARK_API_KEY: "fixture-parent-ark-key",
      HUOSHAN_API_KEY: "fixture-parent-huoshan-key",
    },
    readEnvFile: async (path) => {
      readPaths.push(path);
      return Buffer.from(envText, "utf8");
    },
  });
  assert.deepEqual(readPaths, [envFilePath]);
  assert.equal(childEnv.ARK_API_KEY, "fixture-selected-key");
  assert.equal(childEnv.HUOSHAN_API_KEY, "");
  assert.equal(childEnv.PATH, "fixture-path");
  assert.equal(childEnv.ARK_REQUEST_TIMEOUT_MS, "90000");
  assert.equal(childEnv.ARK_MAX_OUTPUT_TOKENS, "4096");
  assert.equal(parseSelectedEnvValue("ARK_API_KEY=fixture-only-key\n", "ARK_API_KEY"), "fixture-only-key");

  assert.throws(() => parseSelectedEnvValue("ARK_API_KEY=fixture-parent-key\n", "HUOSHAN_API_KEY"), /environment variable is missing/u);
  assert.throws(() => parseSelectedEnvValue("HUOSHAN_API_KEY=fixture-one\nHUOSHAN_API_KEY=fixture-two\n", "HUOSHAN_API_KEY"), /environment variable is duplicated/u);
  assert.throws(() => parseSelectedEnvValue("HUOSHAN_API_KEY=  \n", "HUOSHAN_API_KEY"), /environment variable is empty/u);
  assert.throws(() => parseSelectedEnvValue("HUOSHAN_API_KEY=fixture-key\n", "DEEPSEEK_API_KEY"), /one of ARK_API_KEY, HUOSHAN_API_KEY/u);

  let missingKeyError;
  try {
    await buildLiveChildEnvironment(plan, {
      parentEnv: { ARK_API_KEY: "fixture-parent-ark-key", HUOSHAN_API_KEY: "fixture-parent-huoshan-key" },
      readEnvFile: async () => Buffer.from("ARK_API_KEY=fixture-decoy-key\n", "utf8"),
    });
  } catch (error) {
    missingKeyError = error;
  }
  assert.match(missingKeyError?.message ?? "", /environment variable is missing/u);
  assert.equal(missingKeyError.message.includes("fixture-parent-ark-key"), false);
  assert.equal(missingKeyError.message.includes("fixture-decoy-key"), false);

  let envReadWithoutFrozenPath = false;
  await assert.rejects(buildLiveChildEnvironment({ ...plan, cli: { envFilePath: null } }, {
    readEnvFile: async () => {
      envReadWithoutFrozenPath = true;
      return Buffer.from("HUOSHAN_API_KEY=fixture-selected-key", "utf8");
    },
  }), /requires a frozen env-file path/u);
  assert.equal(envReadWithoutFrozenPath, false);

  const canonicalPlan = {
    ...plan,
    configuration: { environment: { apiKeyEnvName: "ARK_API_KEY", apiKeyTargetEnvName: "ARK_API_KEY" } },
  };
  const canonicalChildEnv = await buildLiveChildEnvironment(canonicalPlan, {
    parentEnv: { ARK_API_KEY: "fixture-parent-ark-key", HUOSHAN_API_KEY: "fixture-parent-huoshan-key" },
    readEnvFile: async () => Buffer.from("ARK_API_KEY=fixture-file-ark-key\nHUOSHAN_API_KEY=fixture-decoy-huoshan-key\n", "utf8"),
  });
  assert.equal(canonicalChildEnv.ARK_API_KEY, "fixture-file-ark-key");
  assert.equal(canonicalChildEnv.HUOSHAN_API_KEY, "");
});

test("legacy DeepSeek key environment path does not read an env file or acquire Ark settings", async () => {
  let envRead = false;
  const parentEnv = { PATH: "fixture-path", DEEPSEEK_API_KEY: "fixture-deepseek-key" };
  const childEnv = await buildLiveChildEnvironment({
    suiteId: SUITE_ID,
    configuration: { environment: { apiKeyEnvName: null, apiKeyTargetEnvName: null } },
    cli: { envFilePath: null },
  }, {
    parentEnv,
    readEnvFile: async () => {
      envRead = true;
      throw new Error("must not read env file for the legacy suite");
    },
  });
  assert.equal(envRead, false);
  assert.equal(childEnv.DEEPSEEK_API_KEY, "fixture-deepseek-key");
  assert.equal(childEnv.DEEPSEEK_REQUEST_TIMEOUT_MS, "90000");
  assert.equal(childEnv.DEEPSEEK_MAX_OUTPUT_TOKENS, "4096");
  assert.equal(Object.hasOwn(childEnv, "ARK_API_KEY"), false);
  assert.equal(Object.hasOwn(childEnv, "ARK_REQUEST_TIMEOUT_MS"), false);
});

test("G01, G03, and M02 state only the user-relevant delegation, activation, phone, and SMS boundaries", async () => {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  const task = (id) => manifest.tasks.find((candidate) => candidate.id === id);
  const g01 = task("G01");
  assert.match(g01.goal, /本人和家人代办分别在社区受理点办理敬老卡时，官网列明要带哪些证件/u);
  assert.match(g01.goal, /领卡后本人是否还要另行激活银行卡的金融功能/u);
  assert.doesNotMatch(g01.goal, /银行代办|不确定|待核实/u);
  assert.match(g01.checks.find((item) => item.id === "facts").description, /社区受理点/u);
  assert.doesNotMatch(g01.checks.find((item) => item.id === "facts").description, /银行代办/u);

  const g03 = task("G03");
  assert.match(g03.goal, /本人到社区办理敬老卡要带什么/u);
  assert.match(g03.goal, /确认津贴领取渠道要带什么/u);
  assert.match(g03.goal, /领卡后本人如何激活金融账户/u);
  assert.doesNotMatch(g03.goal, /家人代办|不确定|待核实/u);
  assert.deepEqual(g03.sourceIds, ["S-G1", "S-G3", "S-G4", "S-G5"]);
  assert.equal(g03.allowedHosts.includes("zwdt.sh.gov.cn"), false);

  const m02 = task("M02");
  assert.match(m02.title, /电话预约/u);
  assert.match(m02.goal, /不熟悉智能手机，但能接电话和收短信/u);
  assert.match(m02.goal, /按华山医院官网公开的电话预约说明/u);
  assert.match(m02.goal, /用哪个电话预约、电话预约方式/u);
  assert.match(m02.goal, /到院要带什么/u);
  assert.match(m02.goal, /最晚什么时候、通过哪个渠道取消/u);
  assert.doesNotMatch(m02.goal, /没有手机|不能接电话|不能收短信|无短信|不确定|待核实|最新|现行/u);
  assert.match(m02.checks.find((item) => item.id === "facts").description, /电话预约号码/u);
  assert.match(m02.checks.find((item) => item.id === "facts").description, /最晚取消时间和取消渠道/u);
  assert.match(m02.checks.find((item) => item.id === "constraints").description, /没有拨打电话或替用户预约、取消/u);
});

test("actual prepare package produces a default dry-run and cleans only its own temporary artifacts", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "life-eval-runner-test-"));
  let packageDir;
  let packageId;
  try {
    const prepared = await createPlan({
      "--output-dir": tempRoot,
      "--profile-label": "LifeEval-Temporary",
      "--as-of-date": "2026-10-15",
      "--travel-date": "2026-10-20",
      "--task-id": "G03",
      "--variant": "B00",
    }, {
      root: ROOT,
      manifestPath: MANIFEST_PATH,
      now: () => new Date("2026-10-15T10:00:00.000Z"),
    });
    packageDir = prepared.packageDir;
    packageId = prepared.packageId;
    assert.equal(prepared.plan.suiteId, SUITE_ID);
    assert.equal(prepared.plan.configuration.model, "deepseek-flash");
    assert.equal(prepared.plan.configuration.batching, "same-control-input-v1");
    assert.equal(prepared.plan.task.id, "G03");
    assert.equal(prepared.plan.task.outcomeMode, "document");
    assert.equal(prepared.plan.configuration.windowSwitch, "opened-windows-v1");
    assert.equal(prepared.plan.configuration.grounding, "off");
    assert.equal(prepared.plan.configuration.requestedGrounding, "off");
    assert.equal(prepared.plan.configuration.managedBrowserCompanion, true);
    const groundingArg = prepared.plan.cli.argvTemplate.indexOf("--grounding");
    assert.notEqual(groundingArg, -1);
    assert.equal(prepared.plan.cli.argvTemplate[groundingArg + 1], "off");
    assert.equal(prepared.plan.configuration.initialCapture, "primary-desktop");
    assert.deepEqual(prepared.plan.task.activeInputs, []);
    assert.deepEqual(prepared.review.preflight.activeInputs, []);
    assert.match(prepared.plan.task.goal, /保存文件夹：/u);
    assert.match(prepared.plan.task.goal, /文件名：G03-长者办事资料\.docx/u);
    assert.equal(prepared.review.consumerReview.outcomeMode, "document");
    assert.equal(prepared.plan.selection.outputAttemptDir.startsWith(tempRoot), true);
    assert.equal((await stat(prepared.outputAttemptDir)).isDirectory(), true);
    assert.equal((await readdir(packageDir)).includes("plan.json"), true);

    let confirmationCalled = false;
    const result = await runPackage({ "--package": packageDir }, {
      root: ROOT,
      manifestPath: MANIFEST_PATH,
      confirm: async () => { confirmationCalled = true; },
    });
    assert.equal(result.mode, "dry-run");
    assert.equal(result.report.spawned, false);
    assert.equal(result.report.desktopAccess, false);
    assert.equal(result.report.modelAccess, false);
    assert.equal(result.report.networkAccess, false);
    assert.equal(result.report.envFileRead, false);
    assert.equal(result.report.providerEnabled, false);
    assert.equal(result.report.model, "deepseek-flash");
    assert.equal(result.report.outcomeMode, "document");
    assert.equal(confirmationCalled, false);
    const dryRunFiles = await import("node:fs/promises").then((fs) => fs.readdir(join(packageDir, "dry-runs")));
    assert.equal(dryRunFiles.length, 1);
    const dryRun = JSON.parse(await readFile(join(packageDir, "dry-runs", dryRunFiles[0]), "utf8"));
    assert.equal(dryRun.spawned, false);
    assert.equal(dryRun.argv.includes("--grounding"), true);
    assert.equal(dryRun.argv[dryRun.argv.indexOf("--grounding") + 1], "off");
    assert.equal(dryRun.argv.includes("--window-switch"), true);
    assert.equal(dryRun.argv.includes("--cua-window-pid"), false);
    assert.equal(dryRun.argv.includes("--cua-window-id"), false);
  } finally {
    try {
      if (packageDir !== undefined && packageId !== undefined) {
        const ownedPackage = join(ROOT, "runs", SUITE_ID, packageId);
        assert.equal(packageDir, ownedPackage, "cleanup target must be this test's exact generated package");
        await rm(ownedPackage, { recursive: true, force: false });
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
});

test("six-task package freezes Ark in its own suite path and dry-run does not read the configured key env file", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "life-eval-six-suite-test-"));
  const missingEnvFile = join(tempRoot, "not-read.env");
  let packageDir;
  let packageId;
  try {
    const prepared = await createPlan({
      "--suite": SHOPPING_COMMUNICATION_SUITE_ID,
      "--api-key-env": "HUOSHAN_API_KEY",
      "--env-file": missingEnvFile,
      "--output-dir": tempRoot,
      "--profile-label": "LifeEval-Six-Temporary",
      "--as-of-date": "2026-10-15",
      "--travel-date": "2026-10-16",
      "--task-id": "CM02",
      "--variant": "M01",
    }, {
      root: ROOT,
      manifestPath: manifestPathForSuite(SHOPPING_COMMUNICATION_SUITE_ID),
      now: () => new Date("2026-10-15T10:00:00.000Z"),
    });
    packageDir = prepared.packageDir;
    packageId = prepared.packageId;
    assert.equal(packageDir, join(ROOT, "runs", SHOPPING_COMMUNICATION_SUITE_ID, packageId));
    assert.notEqual(packageDir, join(ROOT, "runs", SUITE_ID, packageId));
    assert.equal(prepared.plan.suiteId, SHOPPING_COMMUNICATION_SUITE_ID);
    assert.equal(prepared.plan.task.startUrl, "https://support.apple.com/zh-cn/guide/calendar/icl1018/16.0/mac/26");
    assert.equal(prepared.plan.configuration.model, "deepseek-v4.1-flash");
    assert.equal(prepared.plan.configuration.batching, "off");
    assert.equal(prepared.plan.configuration.environment.apiKeyEnvName, "HUOSHAN_API_KEY");
    assert.equal(prepared.plan.configuration.environment.apiKeyTargetEnvName, "ARK_API_KEY");
    assert.equal(prepared.plan.cli.envFilePath, missingEnvFile);
    assert.equal(prepared.plan.cli.argvTemplate[prepared.plan.cli.argvTemplate.indexOf("--managed-browser-url") + 1], prepared.plan.task.startUrl);
    assert.equal(prepared.plan.cli.argvTemplate[prepared.plan.cli.argvTemplate.indexOf("--batching") + 1], "off");
    assert.equal(JSON.stringify(prepared.plan).includes("HUOSHAN_API_KEY="), false);
    assert.equal(prepared.review.preflight.status, "pending");

    const dryRun = await runPackage({ "--package": packageDir, "--suite": SHOPPING_COMMUNICATION_SUITE_ID }, { root: ROOT });
    assert.equal(dryRun.mode, "dry-run");
    assert.equal(dryRun.report.spawned, false);
    assert.equal(dryRun.report.desktopAccess, false);
    assert.equal(dryRun.report.modelAccess, false);
    assert.equal(dryRun.report.networkAccess, false);
    assert.equal(dryRun.report.envFileRead, false);
    assert.equal(dryRun.report.providerEnabled, false);
    assert.equal(dryRun.report.model, "deepseek-v4.1-flash");
    await assert.rejects(runPackage({ "--package": packageDir, "--suite": SUITE_ID }, { root: ROOT }), /does not match the package's frozen suite/u);
    await assert.rejects(readFile(missingEnvFile), { code: "ENOENT" });
  } finally {
    if (packageDir !== undefined && packageId !== undefined) {
      assert.equal(packageDir, join(ROOT, "runs", SHOPPING_COMMUNICATION_SUITE_ID, packageId));
      await rm(packageDir, { recursive: true, force: false });
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("legacy nine-task T03 prepares one DOCX plus an exact WeChat delivery target without authorizing or sending", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "life-eval-t03-wechat-test-"));
  let packageDir;
  let packageId;
  try {
    const prepared = await createPlan({
      "--output-dir": tempRoot,
      "--profile-label": "LifeEval-Temporary",
      "--as-of-date": "2026-10-15",
      "--travel-date": "2026-10-20",
      "--task-id": "T03",
      "--variant": "B00",
      "--wechat-chat": "文件传输助手",
    }, {
      root: ROOT,
      manifestPath: MANIFEST_PATH,
      now: () => new Date("2026-10-15T10:00:00.000Z"),
    });
    packageDir = prepared.packageDir;
    packageId = prepared.packageId;
    assert.equal(prepared.plan.task.outcomeMode, "document");
    assert.deepEqual(prepared.plan.task.requiredApps, ["managed-browser", "WPS", "WeChat"]);
    assert.equal(prepared.plan.task.wechatChat, "文件传输助手");
    assert.match(prepared.plan.task.goal, /微信发送给《文件传输助手》/u);
    assert.equal(prepared.plan.task.goal.includes("{{WECHAT_CHAT}}"), false);
    assert.equal(prepared.plan.configuration.windowSwitch, "opened-windows-v1");
    assert.deepEqual(prepared.review.preflight.requiredApps, [
      { app: "managed-browser", status: "pending" },
      { app: "WPS", status: "pending" },
      { app: "WeChat", status: "pending" },
    ]);
    assert.equal(prepared.review.preflight.wechatChat, "文件传输助手");
    assert.equal(prepared.review.preflight.wechatTestChatAuthorized, false);
    assert.deepEqual(prepared.review.deliverableReviews, [{ name: "T03-南京出行资料.docx", status: "pending", notes: "" }]);
    assert.deepEqual(prepared.review.consumerReview.wechatDelivery, {
      targetChat: "文件传输助手",
      fileName: "T03-南京出行资料.docx",
      status: "pending",
      reviewedAt: null,
      notes: "Human must separately verify the same saved file was sent to the exact target; this is not auto-scored.",
    });

    const result = await runPackage({ "--package": packageDir }, { root: ROOT, manifestPath: MANIFEST_PATH });
    assert.equal(result.mode, "dry-run");
    assert.equal(result.report.spawned, false);
    assert.equal(result.report.desktopAccess, false);
    assert.equal(result.report.modelAccess, false);
    assert.equal(result.report.networkAccess, false);
    const dryRunFiles = await readdir(join(packageDir, "dry-runs"));
    const dryRun = JSON.parse(await readFile(join(packageDir, "dry-runs", dryRunFiles[0]), "utf8"));
    assert.equal(dryRun.argv.includes("--window-switch"), true);
    const goalIndex = dryRun.argv.indexOf("--goal");
    assert.match(dryRun.argv[goalIndex + 1], /微信发送给《文件传输助手》/u);

    const attemptRecord = buildLiveAttemptRecord({
      plan: prepared.plan,
      review: prepared.review,
      attemptDir: join(packageDir, "attempts", "live-offline-fixture"),
      cuaSocket: "offline-cua-fixture",
      supervised: true,
      startedAt: "2026-10-15T10:00:00.000Z",
      argv: dryRun.argv,
    });
    assert.deepEqual(attemptRecord.consumerEvidence.expectedDeliverables, [join(prepared.outputAttemptDir, "T03-南京出行资料.docx")]);
    assert.deepEqual(attemptRecord.consumerEvidence.wechatDelivery, {
      targetChat: "文件传输助手",
      fileName: "T03-南京出行资料.docx",
      status: "pending_human_confirmation",
      automaticScoring: false,
      evidence: "Human separately verifies the saved document and its delivery to the exact target; runner does not inspect chats or send state.",
    });
    assert.match(attemptRecord.consumerEvidence.primaryEvidence, /separately verifies the saved document/u);
  } finally {
    if (packageDir !== undefined && packageId !== undefined) {
      const ownedPackage = join(ROOT, "runs", SUITE_ID, packageId);
      assert.equal(packageDir, ownedPackage, "cleanup target must be this test's exact generated package");
      await rm(ownedPackage, { recursive: true, force: false });
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("six-domain T03 prepares text-only WeChat delivery and records content/send evidence without authorizing or sending", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "life-eval-six-t03-text-wechat-test-"));
  let packageDir;
  let packageId;
  const manifestPath = manifestPathForSuite(SIX_DOMAIN_SUITE_ID);
  const manifestSnapshotPath = join(tempRoot, "six-domain-tasks.json");
  await writeFile(manifestSnapshotPath, await readFile(manifestPath));
  try {
    const prepared = await createPlan({
      "--suite": SIX_DOMAIN_SUITE_ID,
      "--api-key-env": "HUOSHAN_API_KEY",
      "--output-dir": tempRoot,
      "--profile-label": "LifeEval-Temporary",
      "--as-of-date": "2026-10-18",
      "--travel-date": "2026-10-20",
      "--task-id": "T03",
      "--variant": "A",
      "--wechat-chat": "文件传输助手",
    }, {
      root: ROOT,
      manifestPath: manifestSnapshotPath,
      now: () => new Date("2026-10-18T10:00:00.000Z"),
    });
    packageDir = prepared.packageDir;
    packageId = prepared.packageId;
    assert.equal(prepared.plan.task.outcomeMode, "response");
    assert.deepEqual(prepared.plan.task.requiredApps, ["managed-browser", "WeChat"]);
    assert.deepEqual(prepared.plan.task.deliverables, []);
    assert.equal(prepared.plan.task.wechatChat, "文件传输助手");
    assert.match(prepared.plan.task.goal, /微信会话《文件传输助手》/u);
    assert.match(prepared.plan.task.goal, /只向这个精确会话发送文字/u);
    assert.equal(prepared.review.preflight.wechatChat, "文件传输助手");
    assert.equal(prepared.review.preflight.wechatTestChatAuthorized, false);
    assert.deepEqual(prepared.review.preflight.requiredApps, [
      { app: "managed-browser", status: "pending" },
      { app: "WeChat", status: "pending" },
    ]);
    assert.deepEqual(prepared.review.deliverableReviews, []);
    assert.deepEqual(prepared.review.consumerReview.wechatDelivery, {
      targetChat: "文件传输助手",
      fileName: null,
      status: "pending",
      reviewedAt: null,
      notes: "Human must verify that the text message was sent to the exact target; no attachment is expected and delivery is not auto-scored.",
    });

    const result = await runPackage({ "--package": packageDir }, { root: ROOT, manifestPath: manifestSnapshotPath });
    assert.equal(result.mode, "dry-run");
    assert.equal(result.report.spawned, false);
    assert.equal(result.report.desktopAccess, false);
    assert.equal(result.report.modelAccess, false);
    assert.equal(result.report.networkAccess, false);
    const dryRunFiles = await readdir(join(packageDir, "dry-runs"));
    const dryRun = JSON.parse(await readFile(join(packageDir, "dry-runs", dryRunFiles[0]), "utf8"));
    assert.equal(dryRun.argv.includes("--window-switch"), true);
    const goalIndex = dryRun.argv.indexOf("--goal");
    assert.match(dryRun.argv[goalIndex + 1], /微信会话《文件传输助手》/u);

    const attemptRecord = buildLiveAttemptRecord({
      plan: prepared.plan,
      review: prepared.review,
      attemptDir: join(packageDir, "attempts", "live-offline-fixture"),
      cuaSocket: "offline-cua-fixture",
      supervised: true,
      startedAt: "2026-10-18T10:00:00.000Z",
      argv: dryRun.argv,
    });
    assert.equal(Object.hasOwn(attemptRecord.consumerEvidence, "expectedDeliverables"), false);
    assert.deepEqual(attemptRecord.consumerEvidence.wechatDelivery, {
      targetChat: "文件传输助手",
      fileName: null,
      status: "pending_human_confirmation",
      automaticScoring: false,
      evidence: "Human verifies the text message was sent to the exact target; no attachment is expected and the runner does not inspect chats or send state.",
    });
    assert.match(attemptRecord.consumerEvidence.primaryEvidence, /visible delivery of the text message to the exact WeChat target/u);
    assert.match(attemptRecord.consumerEvidence.primaryEvidence, /CLI output alone is not send evidence/u);

    const changedManifest = JSON.parse(await readFile(manifestSnapshotPath, "utf8"));
    changedManifest.tasks.find((task) => task.id === "T03").goal += " stale revision";
    await writeFile(manifestSnapshotPath, `${JSON.stringify(changedManifest, null, 2)}\n`, { encoding: "utf8" });
    await assert.rejects(
      runPackage({ "--package": packageDir }, { root: ROOT, manifestPath: manifestSnapshotPath }),
      /manifest changed/u,
      "prepared package must not be reusable after the six-domain T03 definition changes",
    );
  } finally {
    if (packageDir !== undefined && packageId !== undefined) {
      const ownedPackage = join(ROOT, "runs", SIX_DOMAIN_SUITE_ID, packageId);
      assert.equal(packageDir, ownedPackage, "cleanup target must be this test's exact generated package");
      await rm(ownedPackage, { recursive: true, force: false });
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("six-domain Risk Guard off is frozen in config, argv, limits, dry-run, and live-attempt metadata", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "life-eval-risk-off-test-"));
  let packageDir;
  let packageId;
  const manifestPath = manifestPathForSuite(SIX_DOMAIN_SUITE_ID);
  try {
    const prepared = await createPlan({
      "--suite": SIX_DOMAIN_SUITE_ID,
      "--api-key-env": "HUOSHAN_API_KEY",
      "--output-dir": tempRoot,
      "--profile-label": "LifeEval-Risk-Off",
      "--as-of-date": "2026-10-19",
      "--travel-date": "2026-10-22",
      "--task-id": "M02",
      "--variant": "A",
      "--risk-guard": "off",
    }, {
      root: ROOT,
      manifestPath,
      now: () => new Date("2026-10-18T17:00:00.000Z"),
    });
    packageDir = prepared.packageDir;
    packageId = prepared.packageId;
    const configuration = prepared.plan.configuration;
    const argvTemplate = prepared.plan.cli.argvTemplate;
    assert.equal(configuration.riskGuard, "off");
    assert.equal(configuration.riskModel, "off");
    assert.equal(configuration.confirmRiskGuardOff, true);
    assert.equal(configuration.riskModelRequestsEnabled, false);
    assert.equal(configuration.riskModelRequestLimitStatus, "inactive_risk_model_off");
    assert.equal(configuration.maxRiskModelRequests, 24);
    assert.equal(configuration.combinedRequestCeiling, 144);
    assert.equal(argvTemplate[argvTemplate.indexOf("--risk-guard") + 1], "off");
    assert.equal(argvTemplate.includes("--confirm-risk-guard-off"), true);
    assert.equal(argvTemplate[argvTemplate.indexOf("--risk-model") + 1], "off");
    assert.equal(argvTemplate[argvTemplate.indexOf("--risk-max-model-requests") + 1], "24");
    assert.doesNotThrow(() => assertRiskPolicy(prepared.plan));
    assert.throws(() => assertRiskPolicy({
      ...prepared.plan,
      configuration: { ...configuration, riskModel: "same" },
    }), /risk model does not match riskGuard/u);

    const cli = await loadCliModule();
    const concrete = argvTemplate.map((value) => value === token ? "offline-cua-placeholder" : value);
    const parsed = cli.parseArgs(concrete);
    const resolved = cli.toResolvedRunConfig(parsed, parsed.goal);
    assert.equal(parsed.risk.riskGuard, "off");
    assert.equal(parsed.riskModel, "off");
    assert.equal(resolved.riskGuard, "off");
    assert.equal(resolved.riskModel, "off");
    assert.equal(resolved.riskMaxModelRequests, 24);

    const dryRun = await runPackage({ "--package": packageDir, "--suite": SIX_DOMAIN_SUITE_ID }, { root: ROOT, manifestPath });
    assert.equal(dryRun.mode, "dry-run");
    assert.equal(dryRun.report.spawned, false);
    assert.equal(dryRun.report.networkAccess, false);
    assert.deepEqual(dryRun.report.riskPolicy, {
      riskGuard: "off",
      riskModel: "off",
      confirmRiskGuardOff: true,
      riskModelRequestsEnabled: false,
      riskModelRequestLimitStatus: "inactive_risk_model_off",
      maxRiskModelRequests: 24,
    });
    const dryRunFiles = await readdir(join(packageDir, "dry-runs"));
    const savedDryRun = JSON.parse(await readFile(join(packageDir, "dry-runs", dryRunFiles[0]), "utf8"));
    assert.equal(savedDryRun.argv.includes("--confirm-risk-guard-off"), true);
    assert.equal(savedDryRun.limits.riskModelRequestsEnabled, false);

    const attempt = buildLiveAttemptRecord({
      plan: prepared.plan,
      review: prepared.review,
      attemptDir: join(packageDir, "attempts", "live-risk-off-fixture"),
      cuaSocket: "offline-risk-off-socket",
      supervised: false,
      startedAt: "2026-10-18T17:00:00.000Z",
      argv: dryRun.report.argv,
    });
    assert.deepEqual(attempt.riskPolicy, {
      riskGuard: "off",
      riskModel: "off",
      confirmRiskGuardOff: true,
      riskModelRequestsEnabled: false,
      riskModelRequestLimitStatus: "inactive_risk_model_off",
      maxRiskModelRequests: 24,
    });
  } finally {
    if (packageDir !== undefined && packageId !== undefined) {
      const ownedPackage = join(ROOT, "runs", SIX_DOMAIN_SUITE_ID, packageId);
      assert.equal(packageDir, ownedPackage, "cleanup target must be this test's exact generated package");
      await rm(ownedPackage, { recursive: true, force: false });
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("candidate driver hash is frozen and rechecked before dry-run without reading the configured env file", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "life-eval-driver-freeze-test-"));
  const candidateDriverPath = join(tempRoot, "candidate-cua-driver.exe");
  const candidateDriverBytes = "fixture candidate driver binary bytes";
  const envFilePath = join(tempRoot, "not-read.env");
  await writeFile(candidateDriverPath, candidateDriverBytes, { encoding: "utf8", flag: "wx" });
  let packageDir;
  let packageId;
  try {
    const prepared = await createPlan({
      "--output-dir": tempRoot,
      "--profile-label": "LifeEval-Temporary",
      "--as-of-date": "2026-10-15",
      "--travel-date": "2026-10-20",
      "--task-id": "G01",
      "--variant": "B00",
    }, {
      root: ROOT,
      manifestPath: MANIFEST_PATH,
      now: () => new Date("2026-10-15T10:00:00.000Z"),
      candidateDriver: {
        binaryPath: candidateDriverPath,
        sha256: sha256(candidateDriverBytes),
        version: "0.22.2",
        sourceCommit: "7852ab1",
      },
      envFilePath,
    });
    packageDir = prepared.packageDir;
    packageId = prepared.packageId;
    assert.equal(prepared.plan.configuration.cuaDriver.sha256, sha256(candidateDriverBytes).toUpperCase());
    assert.equal(prepared.plan.configuration.cuaDriver.verificationScope.startsWith("candidate-file-hash-only"), true);
    assert.deepEqual(prepared.review.preflight.cuaDaemon, {
      status: "pending",
      socketPath: null,
      binarySha256: null,
      note: "Human must verify the already-running daemon behind the selected socket; candidate file hash alone does not establish daemon identity.",
    });
    assert.equal(prepared.plan.cli.envFilePath, envFilePath);
    assert.equal(prepared.plan.cli.argvTemplate[prepared.plan.cli.argvTemplate.indexOf("--env-file") + 1], envFilePath);
    assert.equal(await pathExists(envFilePath), false);

    const result = await runPackage({ "--package": packageDir }, { root: ROOT, manifestPath: MANIFEST_PATH });
    assert.equal(result.mode, "dry-run");
    assert.equal(result.report.envFileRead, false);
    assert.equal(result.report.spawned, false);

    await writeFile(candidateDriverPath, "tampered candidate driver", { encoding: "utf8" });
    await assert.rejects(runPackage({ "--package": packageDir }, { root: ROOT, manifestPath: MANIFEST_PATH }), /binary hash does not match/u);
  } finally {
    try {
      if (packageDir !== undefined && packageId !== undefined) {
        const ownedPackage = join(ROOT, "runs", SUITE_ID, packageId);
        assert.equal(packageDir, ownedPackage, "cleanup target must be this test's exact generated package");
        await rm(ownedPackage, { recursive: true, force: false });
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
});

test("live record builder captures the validated candidate/socket preflight without spawning", () => {
  const cuaSocket = "\\\\.\\pipe\\life-eval-record-fixture";
  const cuaDriver = {
    binaryPath: "E:\\candidate-cua-driver.exe",
    sha256: "A".repeat(64),
    version: "0.22.2",
    sourceCommit: "7852ab1",
    verificationScope: "candidate-file-hash-only; running-daemon identity is not verified",
  };
  const cuaDaemon = {
    status: "passed",
    socketPath: cuaSocket,
    binarySha256: cuaDriver.sha256,
    version: cuaDriver.version,
    sourceCommit: cuaDriver.sourceCommit,
    identityConfirmed: true,
  };
  const plan = {
    packageId: "G01-B00-record-fixture",
    task: { id: "G01", outcomeMode: "response", deliverables: [] },
    selection: { variant: "B00", outputAttemptDir: "E:\\life-eval-output\\G01\\B00\\attempt" },
    configuration: { cuaDriver },
    cli: { entry: "E:\\repo\\apps\\cli\\dist\\index.js", envFilePath: "E:\\private-fixture.env" },
  };
  const review = { preflight: { cuaDaemon } };
  const record = buildLiveAttemptRecord({
    plan,
    review,
    attemptDir: "E:\\repo\\runs\\pkg\\attempts\\live-fixture",
    cuaSocket,
    supervised: true,
    startedAt: "2026-10-15T10:00:00.000Z",
    argv: ["--goal", "offline fixture", "--cua-socket", cuaSocket],
  });

  assert.deepEqual(record.cuaDriver, cuaDriver);
  assert.deepEqual(record.cuaDaemonPreflight, cuaDaemon);
  assert.equal(record.cuaSocket, cuaSocket);
  assert.equal(record.envFilePath, plan.cli.envFilePath);
  assert.match(record.envPolicy, /live child CLI reads it via --env-file/u);
  assert.equal(record.consumerEvidence.outcomeMode, "response");
  assert.equal(record.final, null);
  assert.equal(Object.hasOwn(record, "spawned"), false);
});

test("Ctrl+C waits for child cleanup, keeps its output pipes open, and records the completed attempt", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "life-eval-cancel-report-test-"));
  let packageDir;
  let packageId;
  let child;
  const signalSource = new EventEmitter();
  let terminalOutput = "";
  const terminalStdout = new Writable({
    write(chunk, _encoding, callback) {
      terminalOutput += chunk.toString("utf8");
      callback();
    },
  });
  const terminalStderr = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  try {
    const prepared = await createPlan({
      "--output-dir": tempRoot,
      "--profile-label": "LifeEval-Cancel-Fixture",
      "--as-of-date": "2026-10-15",
      "--travel-date": "2026-10-20",
      "--task-id": "G01",
      "--variant": "B00",
    }, {
      root: ROOT,
      manifestPath: MANIFEST_PATH,
      now: () => new Date("2026-10-15T10:00:00.000Z"),
    });
    packageDir = prepared.packageDir;
    packageId = prepared.packageId;
    const plan = {
      ...prepared.plan,
      configuration: {
        ...prepared.plan.configuration,
        runTimeoutMs: 10,
        cleanupDeadlineMs: 1_000,
      },
    };

    const resultPromise = runLive({
      plan,
      review: prepared.review,
      packageDir,
      cuaSocket: "offline-cancel-fixture",
      supervised: true,
    }, {
      signalSource,
      terminalStdout,
      terminalStderr,
      spawnChild() {
        child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.exitCode = null;
        child.signalCode = null;
        child.killCalls = [];
        child.kill = (signal) => { child.killCalls.push(signal); return true; };
        setTimeout(() => {
          child.stdout.write("Runtime finished: cancelled\n");
          signalSource.emit("SIGINT");
          setTimeout(() => {
            child.stdout.end("Managed browser cleanup complete\n");
            child.stderr.end();
            child.exitCode = 1;
            child.emit("close", 1, null);
          }, 35);
        }, 0);
        return child;
      },
    });

    const result = await resultPromise;
    assert.equal(result.exitCode, 1);
    assert.equal(result.timedOut, false);
    assert.equal(result.terminationSignalSent, null);
    assert.equal(result.userInterruptSignalReceived, "SIGINT");
    assert.equal(result.userInterruptSignalCount, 1);
    assert.equal(result.userInterruptCleanupTimedOut, false);
    assert.deepEqual(result.userInterruptForcedTerminationSignalsSent, []);
    assert.equal(result.childCloseObserved, true);
    assert.deepEqual(child.killCalls, []);
    assert.equal(signalSource.listenerCount("SIGINT"), 0);
    assert.equal(terminalOutput.match(/Runner received Ctrl\+C/gu)?.length, 1);
    assert.match(terminalOutput, /Runner recorded one live attempt/gu);

    const recordText = await readFile(join(packageDir, "live-attempt.json"), "utf8");
    assert.doesNotMatch(recordText, /\uFFFD|\?{3,}/u);
    assert.match(recordText, /敬老卡/u);
    const record = JSON.parse(recordText);
    assert.equal(record.final.userInterruptSignalReceived, "SIGINT");
    assert.equal(record.final.userInterruptSignalCount, 1);
    assert.equal(record.final.timedOut, false);
    const stdoutLog = await readFile(record.stdoutLog, "utf8");
    assert.match(stdoutLog, /Runtime finished: cancelled/u);
    assert.match(stdoutLog, /Managed browser cleanup complete/u);
  } finally {
    terminalStdout.destroy();
    terminalStderr.destroy();
    if (packageDir !== undefined && packageId !== undefined) {
      const ownedPackage = join(ROOT, "runs", SUITE_ID, packageId);
      assert.equal(packageDir, ownedPackage, "cleanup target must be this test's exact generated package");
      await rm(ownedPackage, { recursive: true, force: false });
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("run timeout requests CLI cancellation over IPC and records bounded forced cleanup uncertainty", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "life-eval-run-timeout-ipc-test-"));
  let packageDir;
  let packageId;
  let child;
  const signalSource = new EventEmitter();
  const terminalStdout = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const terminalStderr = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  try {
    const prepared = await createPlan({
      "--output-dir": tempRoot,
      "--profile-label": "LifeEval-Timeout-Ipc",
      "--as-of-date": "2026-10-15",
      "--travel-date": "2026-10-20",
      "--task-id": "G01",
      "--variant": "B00",
    }, {
      root: ROOT,
      manifestPath: MANIFEST_PATH,
      now: () => new Date("2026-10-15T10:00:00.000Z"),
    });
    packageDir = prepared.packageDir;
    packageId = prepared.packageId;
    const plan = {
      ...prepared.plan,
      configuration: {
        ...prepared.plan.configuration,
        runTimeoutMs: 10,
        cleanupDeadlineMs: 10,
      },
    };

    const result = await runLive({
      plan,
      review: prepared.review,
      packageDir,
      cuaSocket: "offline-timeout-ipc-fixture",
      supervised: true,
    }, {
      signalSource,
      terminalStdout,
      terminalStderr,
      timeoutForceKillDelayMs: 5,
      userInterruptCloseObservationMs: 5,
      buildChildEnvironment: (selectedPlan) => buildLiveChildEnvironment(selectedPlan, {
        parentEnv: { ...process.env, HARNESS_LIFE_EVAL_SUPERVISION_MODE: "dynamic" },
      }),
      spawnChild(_executable, _args, options) {
        assert.deepEqual(options.stdio, ["inherit", "pipe", "pipe", "ipc"]);
        assert.equal(options.env.HARNESS_LIFE_EVAL_SUPERVISION_MODE, undefined, "legacy suite must strip inherited supervision opt-in");
        child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.exitCode = null;
        child.signalCode = null;
        child.connected = true;
        child.channel = { unrefCalls: 0, unref() { this.unrefCalls += 1; } };
        child.killCalls = [];
        child.unrefCalls = 0;
        child.sendCalls = [];
        child.send = (message, _sendHandle, _options, callback) => {
          child.sendCalls.push(message);
          callback(null);
          return true;
        };
        child.kill = (signal) => {
          child.killCalls.push(signal);
          if (signal === "SIGTERM") child.exitCode = 0;
          return true;
        };
        child.unref = () => { child.unrefCalls += 1; };
        return child;
      },
    });

    const expectedCancellationMessage = { type: "harness.cancel", reason: "run-timeout" };
    assert.deepEqual(child.sendCalls, [expectedCancellationMessage]);
    assert.deepEqual(child.killCalls, ["SIGTERM"]);
    assert.equal(child.unrefCalls, 1);
    assert.equal(child.channel.unrefCalls, 1);
    assert.equal(result.timedOut, true);
    assert.deepEqual(result.timeoutCancellationRequest, {
      type: "harness.cancel",
      reason: "run-timeout",
      sendReturn: true,
      completion: "sent",
    });
    assert.equal(result.timeoutCleanupDeadlineExceeded, true);
    assert.equal(result.terminationSignalSent, "SIGTERM");
    assert.equal(result.childCloseObserved, false);

    const record = JSON.parse(await readFile(join(packageDir, "live-attempt.json"), "utf8"));
    assert.deepEqual(record.final.timeoutCancellationRequest, result.timeoutCancellationRequest);
    assert.equal(record.final.timeoutCleanupDeadlineExceeded, true);
    assert.equal(record.final.terminationSignalSent, "SIGTERM");
    assert.equal(record.final.childCloseObserved, false);
  } finally {
    terminalStdout.destroy();
    terminalStderr.destroy();
    if (packageDir !== undefined && packageId !== undefined) {
      const ownedPackage = join(ROOT, "runs", SUITE_ID, packageId);
      assert.equal(packageDir, ownedPackage, "cleanup target must be this test's exact generated package");
      await rm(ownedPackage, { recursive: true, force: false });
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("run timeout reaches a real Node child over IPC and waits for cooperative cleanup", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "life-eval-run-timeout-cooperative-test-"));
  let packageDir;
  let packageId;
  let terminalOutput = "";
  const terminalStdout = new Writable({
    write(chunk, _encoding, callback) {
      terminalOutput += chunk.toString("utf8");
      callback();
    },
  });
  const terminalStderr = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  try {
    const prepared = await createPlan({
      "--output-dir": tempRoot,
      "--profile-label": "LifeEval-Timeout-Cooperative",
      "--as-of-date": "2026-10-15",
      "--travel-date": "2026-10-20",
      "--task-id": "G01",
      "--variant": "B00",
    }, {
      root: ROOT,
      manifestPath: MANIFEST_PATH,
      now: () => new Date("2026-10-15T10:00:00.000Z"),
    });
    packageDir = prepared.packageDir;
    packageId = prepared.packageId;
    const plan = {
      ...prepared.plan,
      configuration: {
        ...prepared.plan.configuration,
        runTimeoutMs: 2_000,
        cleanupDeadlineMs: 1_000,
      },
    };
    const childSource = [
      'process.stdout.write("FIXTURE_READY\\n");',
      'process.on("message", (message) => {',
      '  if (message?.type !== "harness.cancel" || message?.reason !== "run-timeout") return;',
      '  process.stdout.write("FIXTURE_CANCEL_ACCEPTED\\n");',
      '  setTimeout(() => process.stdout.write("FIXTURE_CLEANUP_COMPLETE\\n", () => {',
      '    if (process.connected) process.disconnect();',
      '    process.exit(0);',
      '  }), 10);',
      '});',
    ].join("\n");

    const result = await runLive({
      plan,
      review: prepared.review,
      packageDir,
      cuaSocket: "offline-timeout-ipc-cooperative-fixture",
      supervised: true,
    }, {
      terminalStdout,
      terminalStderr,
      spawnChild(executable, _args, options) {
        assert.deepEqual(options.stdio, ["inherit", "pipe", "pipe", "ipc"]);
        return spawn(executable, ["-e", childSource], options);
      },
    });

    assert.equal(result.timedOut, true);
    assert.deepEqual(result.timeoutCancellationRequest, {
      type: "harness.cancel",
      reason: "run-timeout",
      sendReturn: true,
      completion: "sent",
    });
    assert.equal(result.timeoutCleanupDeadlineExceeded, false);
    assert.equal(result.terminationSignalSent, null);
    assert.equal(result.childCloseObserved, true);
    assert.match(terminalOutput, /FIXTURE_READY/u);
    assert.match(terminalOutput, /FIXTURE_CANCEL_ACCEPTED/u);
    assert.match(terminalOutput, /FIXTURE_CLEANUP_COMPLETE/u);
    const record = JSON.parse(await readFile(join(packageDir, "live-attempt.json"), "utf8"));
    assert.equal(record.final.childCloseObserved, true);
    assert.equal(record.final.terminationSignalSent, null);
    assert.equal(record.final.timeoutCleanupDeadlineExceeded, false);
    const stdoutLog = await readFile(record.stdoutLog, "utf8");
    assert.match(stdoutLog, /FIXTURE_CANCEL_ACCEPTED/u);
    assert.match(stdoutLog, /FIXTURE_CLEANUP_COMPLETE/u);
  } finally {
    terminalStdout.destroy();
    terminalStderr.destroy();
    if (packageDir !== undefined && packageId !== undefined) {
      const ownedPackage = join(ROOT, "runs", SUITE_ID, packageId);
      assert.equal(packageDir, ownedPackage, "cleanup target must be this test's exact generated package");
      await rm(ownedPackage, { recursive: true, force: false });
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("repeated Ctrl+C does not restart cleanup deadline and records an unresolved child after forced signals", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "life-eval-cancel-timeout-test-"));
  let packageDir;
  let packageId;
  let child;
  const signalSource = new EventEmitter();
  let cleanupDeadlineCallback;
  let cleanupDeadlineHandle;
  let cleanupDeadlineSchedules = 0;
  let cleanupDeadlineCleared = false;
  let resolveSignalsObserved;
  const signalsObserved = new Promise((resolve) => { resolveSignalsObserved = resolve; });
  let terminalOutput = "";
  const terminalStdout = new Writable({
    write(chunk, _encoding, callback) {
      terminalOutput += chunk.toString("utf8");
      callback();
    },
  });
  const terminalStderr = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  try {
    const prepared = await createPlan({
      "--output-dir": tempRoot,
      "--profile-label": "LifeEval-Cancel-Timeout",
      "--as-of-date": "2026-10-15",
      "--travel-date": "2026-10-20",
      "--task-id": "G01",
      "--variant": "B00",
    }, {
      root: ROOT,
      manifestPath: MANIFEST_PATH,
      now: () => new Date("2026-10-15T10:00:00.000Z"),
    });
    packageDir = prepared.packageDir;
    packageId = prepared.packageId;
    const plan = {
      ...prepared.plan,
      configuration: {
        ...prepared.plan.configuration,
        runTimeoutMs: 10_000,
        cleanupDeadlineMs: 20,
      },
    };

    const resultPromise = runLive({
      plan,
      review: prepared.review,
      packageDir,
      cuaSocket: "offline-stuck-child-fixture",
      supervised: true,
    }, {
      signalSource,
      terminalStdout,
      terminalStderr,
      spawnChild() {
        child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.exitCode = null;
        child.signalCode = null;
        child.killCalls = [];
        child.unrefCalls = 0;
        child.kill = (signal) => { child.killCalls.push(signal); return true; };
        child.unref = () => { child.unrefCalls += 1; };
        setTimeout(() => {
          child.stdout.write("Child did not close after parent Ctrl+C\n");
          signalSource.emit("SIGINT");
          signalSource.emit("SIGINT");
          resolveSignalsObserved();
        }, 0);
        return child;
      },
      setUserInterruptCleanupTimeout(callback, delayMs) {
        cleanupDeadlineSchedules += 1;
        assert.equal(delayMs, 20);
        cleanupDeadlineCallback = callback;
        cleanupDeadlineHandle = { callback };
        return cleanupDeadlineHandle;
      },
      clearUserInterruptCleanupTimeout(handle) {
        assert.equal(handle, cleanupDeadlineHandle);
        cleanupDeadlineCleared = true;
      },
      userInterruptForceKillDelayMs: 5,
      userInterruptCloseObservationMs: 5,
    });

    await signalsObserved;
    assert.equal(cleanupDeadlineSchedules, 1, "a repeated Ctrl+C must count without restarting the grace deadline");
    cleanupDeadlineCallback();
    const result = await resultPromise;
    assert.equal(result.exitCode, null);
    assert.equal(result.signal, null);
    assert.equal(result.timedOut, false);
    assert.equal(result.terminationSignalSent, null);
    assert.equal(result.userInterruptSignalReceived, "SIGINT");
    assert.equal(result.userInterruptSignalCount, 2);
    assert.equal(result.userInterruptCleanupTimedOut, true);
    assert.deepEqual(result.userInterruptForcedTerminationSignalsSent, ["SIGTERM", "SIGKILL"]);
    assert.equal(result.childCloseObserved, false);
    assert.deepEqual(child.killCalls, ["SIGTERM", "SIGKILL"]);
    assert.equal(child.unrefCalls, 1);
    assert.equal(cleanupDeadlineCleared, true);
    const record = JSON.parse(await readFile(join(packageDir, "live-attempt.json"), "utf8"));
    assert.equal(record.final.userInterruptCleanupTimedOut, true);
    assert.deepEqual(record.final.userInterruptForcedTerminationSignalsSent, ["SIGTERM", "SIGKILL"]);
    assert.equal(record.final.childCloseObserved, false);
    const stdoutLog = await readFile(record.stdoutLog, "utf8");
    assert.match(stdoutLog, /Child did not close after parent Ctrl\+C/u);
    assert.match(terminalOutput, /Runner recorded one live attempt/gu);
  } finally {
    terminalStdout.destroy();
    terminalStderr.destroy();
    if (packageDir !== undefined && packageId !== undefined) {
      const ownedPackage = join(ROOT, "runs", SUITE_ID, packageId);
      assert.equal(packageDir, ownedPackage, "cleanup target must be this test's exact generated package");
      await rm(ownedPackage, { recursive: true, force: false });
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("child exit without a close event is bounded without sending another kill", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "life-eval-cancel-open-pipe-test-"));
  let packageDir;
  let packageId;
  let child;
  const signalSource = new EventEmitter();
  const terminalStdout = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const terminalStderr = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  try {
    const prepared = await createPlan({
      "--output-dir": tempRoot,
      "--profile-label": "LifeEval-Cancel-Open-Pipe",
      "--as-of-date": "2026-10-15",
      "--travel-date": "2026-10-20",
      "--task-id": "G01",
      "--variant": "B00",
    }, {
      root: ROOT,
      manifestPath: MANIFEST_PATH,
      now: () => new Date("2026-10-15T10:00:00.000Z"),
    });
    packageDir = prepared.packageDir;
    packageId = prepared.packageId;
    const plan = {
      ...prepared.plan,
      configuration: {
        ...prepared.plan.configuration,
        runTimeoutMs: 10_000,
        cleanupDeadlineMs: 15,
      },
    };

    const result = await runLive({
      plan,
      review: prepared.review,
      packageDir,
      cuaSocket: "offline-open-pipe-fixture",
      supervised: true,
    }, {
      signalSource,
      terminalStdout,
      terminalStderr,
      userInterruptForceKillDelayMs: 5,
      userInterruptCloseObservationMs: 5,
      spawnChild() {
        child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.exitCode = null;
        child.signalCode = null;
        child.killCalls = [];
        child.unrefCalls = 0;
        child.kill = (signal) => {
          child.killCalls.push(signal);
          if (signal === "SIGTERM") child.exitCode = 0;
          return true;
        };
        child.unref = () => { child.unrefCalls += 1; };
        setTimeout(() => signalSource.emit("SIGINT"), 0);
        return child;
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.signal, null);
    assert.equal(result.userInterruptCleanupTimedOut, true);
    assert.deepEqual(result.userInterruptForcedTerminationSignalsSent, ["SIGTERM"]);
    assert.equal(result.childCloseObserved, false);
    assert.deepEqual(child.killCalls, ["SIGTERM"]);
    assert.equal(child.unrefCalls, 1);
    const record = JSON.parse(await readFile(join(packageDir, "live-attempt.json"), "utf8"));
    assert.equal(record.final.childCloseObserved, false);
    assert.deepEqual(record.final.userInterruptForcedTerminationSignalsSent, ["SIGTERM"]);
  } finally {
    terminalStdout.destroy();
    terminalStderr.destroy();
    if (packageDir !== undefined && packageId !== undefined) {
      const ownedPackage = join(ROOT, "runs", SUITE_ID, packageId);
      assert.equal(packageDir, ownedPackage, "cleanup target must be this test's exact generated package");
      await rm(ownedPackage, { recursive: true, force: false });
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Ctrl+C after child exit but before close remains bounded when stdio is still open", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "life-eval-cancel-open-pipe-test-"));
  let packageDir;
  let packageId;
  let child;
  const signalSource = new EventEmitter();
  const terminalStdout = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const terminalStderr = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  try {
    const prepared = await createPlan({
      "--output-dir": tempRoot,
      "--profile-label": "LifeEval-Cancel-Open-Pipe",
      "--as-of-date": "2026-10-15",
      "--travel-date": "2026-10-20",
      "--task-id": "G01",
      "--variant": "B00",
    }, {
      root: ROOT,
      manifestPath: MANIFEST_PATH,
      now: () => new Date("2026-10-15T10:00:00.000Z"),
    });
    packageDir = prepared.packageDir;
    packageId = prepared.packageId;
    const plan = {
      ...prepared.plan,
      configuration: {
        ...prepared.plan.configuration,
        runTimeoutMs: 10_000,
        cleanupDeadlineMs: 15,
      },
    };

    const result = await runLive({
      plan,
      review: prepared.review,
      packageDir,
      cuaSocket: "offline-open-pipe-fixture",
      supervised: true,
    }, {
      signalSource,
      terminalStdout,
      terminalStderr,
      userInterruptCloseObservationMs: 5,
      spawnChild() {
        child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.exitCode = 0;
        child.signalCode = null;
        child.killCalls = [];
        child.unrefCalls = 0;
        child.kill = (signal) => { child.killCalls.push(signal); return true; };
        child.unref = () => { child.unrefCalls += 1; };
        setTimeout(() => signalSource.emit("SIGINT"), 0);
        return child;
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.signal, null);
    assert.equal(result.userInterruptCleanupTimedOut, false);
    assert.deepEqual(result.userInterruptForcedTerminationSignalsSent, []);
    assert.equal(result.childCloseObserved, false);
    assert.deepEqual(child.killCalls, []);
    assert.equal(child.unrefCalls, 1);
    const record = JSON.parse(await readFile(join(packageDir, "live-attempt.json"), "utf8"));
    assert.equal(record.final.childCloseObserved, false);
    assert.deepEqual(record.final.userInterruptForcedTerminationSignalsSent, []);
  } finally {
    terminalStdout.destroy();
    terminalStderr.destroy();
    if (packageDir !== undefined && packageId !== undefined) {
      const ownedPackage = join(ROOT, "runs", SUITE_ID, packageId);
      assert.equal(packageDir, ownedPackage, "cleanup target must be this test's exact generated package");
      await rm(ownedPackage, { recursive: true, force: false });
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("a late cleanup timer cannot mark an already closed child timed out while log flushing is slow", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "life-eval-cancel-slow-flush-test-"));
  let packageDir;
  let packageId;
  let child;
  const signalSource = new EventEmitter();
  let cleanupTimerCleared = false;
  let cleanupTimerFired = false;
  let terminalOutput = "";
  const terminalStdout = new Writable({
    write(chunk, _encoding, callback) {
      terminalOutput += chunk.toString("utf8");
      callback();
    },
  });
  const terminalStderr = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  try {
    const prepared = await createPlan({
      "--output-dir": tempRoot,
      "--profile-label": "LifeEval-Cancel-Slow-Flush",
      "--as-of-date": "2026-10-15",
      "--travel-date": "2026-10-20",
      "--task-id": "G01",
      "--variant": "B00",
    }, {
      root: ROOT,
      manifestPath: MANIFEST_PATH,
      now: () => new Date("2026-10-15T10:00:00.000Z"),
    });
    packageDir = prepared.packageDir;
    packageId = prepared.packageId;
    const plan = {
      ...prepared.plan,
      configuration: {
        ...prepared.plan.configuration,
        runTimeoutMs: 10_000,
        cleanupDeadlineMs: 20,
      },
    };

    const result = await runLive({
      plan,
      review: prepared.review,
      packageDir,
      cuaSocket: "offline-slow-log-flush-fixture",
      supervised: true,
    }, {
      signalSource,
      terminalStdout,
      terminalStderr,
      createLogStream(path, options) {
        const stream = createWriteStream(path, options);
        const end = stream.end.bind(stream);
        stream.end = (callback) => {
          assert.equal(cleanupTimerCleared, true, "cleanup timers should be cleared as soon as child close is observed");
          setTimeout(() => end(callback), 60);
          return stream;
        };
        return stream;
      },
      setUserInterruptCleanupTimeout(callback, delayMs) {
        assert.equal(delayMs, 20);
        return setTimeout(() => {
          cleanupTimerFired = true;
          callback();
        }, delayMs);
      },
      clearUserInterruptCleanupTimeout() {
        // Keep the already-scheduled callback to exercise the close-state guard
        // while the fake log streams delay their end callbacks.
        cleanupTimerCleared = true;
      },
      spawnChild() {
        child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.exitCode = null;
        child.signalCode = null;
        child.killCalls = [];
        child.kill = (signal) => { child.killCalls.push(signal); return true; };
        setTimeout(() => {
          signalSource.emit("SIGINT");
          setTimeout(() => {
            child.exitCode = 1;
            child.stdout.end("Run cancelled and child closed\n");
            child.stderr.end();
            child.emit("close", 1, null);
          }, 5);
        }, 0);
        return child;
      },
    });

    assert.equal(result.childCloseObserved, true);
    assert.equal(result.userInterruptCleanupTimedOut, false);
    assert.deepEqual(result.userInterruptForcedTerminationSignalsSent, []);
    assert.equal(cleanupTimerFired, true);
    assert.deepEqual(child.killCalls, []);
    const recordText = await readFile(join(packageDir, "live-attempt.json"), "utf8");
    assert.doesNotMatch(recordText, /\uFFFD|\?{3,}/u);
    assert.match(recordText, /敬老卡/u);
    const record = JSON.parse(recordText);
    assert.equal(record.final.childCloseObserved, true);
    assert.equal(record.final.userInterruptCleanupTimedOut, false);
    assert.match(await readFile(record.stdoutLog, "utf8"), /Run cancelled and child closed/u);
    assert.match(terminalOutput, /Runner recorded one live attempt/gu);
  } finally {
    terminalStdout.destroy();
    terminalStderr.destroy();
    if (packageDir !== undefined && packageId !== undefined) {
      const ownedPackage = join(ROOT, "runs", SUITE_ID, packageId);
      assert.equal(packageDir, ownedPackage, "cleanup target must be this test's exact generated package");
      await rm(ownedPackage, { recursive: true, force: false });
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("T02 and M02 prepare as browser-only goals on desktop-first capture with window activation available", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "life-eval-single-browser-test-"));
  const createdPackages = [];
  const common = {
    "--output-dir": tempRoot,
    "--profile-label": "LifeEval-Temporary",
    "--as-of-date": "2026-10-15",
    "--travel-date": "2026-10-20",
    "--task-id": "T02",
    "--variant": "B00",
  };
  try {
    for (const taskId of ["T02", "M02"]) {
      const prepared = await createPlan({ ...common, "--task-id": taskId }, {
        root: ROOT,
        manifestPath: MANIFEST_PATH,
        now: () => new Date("2026-10-15T10:00:00.000Z"),
      });
      createdPackages.push({ packageDir: prepared.packageDir, packageId: prepared.packageId });
      assert.equal(prepared.plan.task.outcomeMode, "response");
      assert.equal(prepared.plan.task.wechatChat, null);
      assert.equal(prepared.plan.task.goal.includes("{{WECHAT_CHAT}}"), false);
      assert.deepEqual(prepared.plan.task.requiredApps, ["managed-browser"]);
      if (taskId === "T02") {
        assert.equal(prepared.plan.task.startUrl, "https://map.gaode.com/");
        assert.deepEqual(prepared.plan.task.allowedHosts, ["map.gaode.com", "www.amap.com"]);
      }
      assert.equal(prepared.plan.configuration.windowSwitch, "opened-windows-v1");
      assert.equal(prepared.review.preflight.wechatChat, null);
      assert.equal(prepared.review.preflight.wechatTestChatAuthorized, null);
      const result = await runPackage({ "--package": prepared.packageDir }, { root: ROOT, manifestPath: MANIFEST_PATH });
      assert.equal(result.report.outcomeMode, "response");
      assert.equal(result.report.spawned, false);
      const dryRunFiles = await readdir(join(prepared.packageDir, "dry-runs"));
      const dryRun = JSON.parse(await readFile(join(prepared.packageDir, "dry-runs", dryRunFiles[0]), "utf8"));
      assert.equal(dryRun.argv.includes("--window-switch"), true);
      if (taskId === "T02") {
        const mapUrlIndex = dryRun.argv.indexOf("--managed-browser-url");
        assert.notEqual(mapUrlIndex, -1);
        assert.equal(dryRun.argv[mapUrlIndex + 1], "https://map.gaode.com/");
      }
    }
  } finally {
    for (const { packageDir, packageId } of createdPackages) {
      const ownedPackage = join(ROOT, "runs", SUITE_ID, packageId);
      assert.equal(packageDir, ownedPackage, "cleanup target must be this test's exact generated package");
      await rm(ownedPackage, { recursive: true, force: false });
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("six-domain runner completes the private parent-child IPC and helper correction receipt path offline", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "life-eval-supervision-parent-child-test-"));
  let packageDir;
  let packageId;
  let child;
  let terminalOutput = "";
  const terminalStdout = new Writable({ write(chunk, _encoding, callback) { terminalOutput += chunk.toString("utf8"); callback(); } });
  const terminalStderr = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  try {
    const prepared = await createPlan({
      "--suite": SIX_DOMAIN_SUITE_ID,
      "--api-key-env": "ARK_API_KEY",
      "--output-dir": tempRoot,
      "--profile-label": "LifeEval-Supervision-IPC",
      "--as-of-date": "2026-10-18",
      "--travel-date": "2026-10-19",
      "--task-id": "G01",
      "--variant": "C",
    }, {
      root: ROOT,
      manifestPath: manifestPathForSuite(SIX_DOMAIN_SUITE_ID),
      now: () => new Date("2026-10-18T10:00:00.000Z"),
    });
    packageDir = prepared.packageDir;
    packageId = prepared.packageId;
    const plan = {
      ...prepared.plan,
      configuration: { ...prepared.plan.configuration, runTimeoutMs: 10_000, cleanupDeadlineMs: 1_000 },
    };
    const outputBase = plan.cli.argvTemplate[plan.cli.argvTemplate.indexOf("--output") + 1];
    const actualRunId = "run-20261018-parent-child-fixture";
    const runtimeDir = join(outputBase, actualRunId);
    const screenshotRelativePath = "screenshots/supervision-fixture.png";
    const screenshotPath = join(runtimeDir, "assets", "screenshots", "supervision-fixture.png");
    await mkdir(join(runtimeDir, "assets", "screenshots"), { recursive: true });
    await writeFile(screenshotPath, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    const observation = {
      id: "observation-parent-child-1",
      runId: actualRunId,
      computerSessionId: "fixture-session",
      surfaceRef: { surfaceId: "fixture-surface", generation: 1, kind: "desktop" },
      capturedAt: "2026-10-18T10:00:01.000Z",
      viewport: { width: 800, height: 600, coordinateSpace: "physical" },
      screenshot: { assetId: "supervision-fixture", relativePath: screenshotRelativePath, mediaType: "image/png", byteLength: 4 },
    };
    const trajectoryPath = join(runtimeDir, "trajectory.jsonl");
    const events = [
      { schemaVersion: 2, runId: actualRunId, eventId: "event-created", sequence: 0, occurredAt: "2026-10-18T10:00:00.000Z", type: "run.created", goal: "fixture" },
      { schemaVersion: 2, runId: actualRunId, eventId: "event-started", sequence: 1, occurredAt: "2026-10-18T10:00:00.500Z", type: "run.started" },
      { schemaVersion: 2, runId: actualRunId, eventId: "event-observation", sequence: 2, occurredAt: "2026-10-18T10:00:01.000Z", type: "observation.created", observation },
      { schemaVersion: 2, runId: actualRunId, eventId: "event-provider", sequence: 3, occurredAt: "2026-10-18T10:00:02.000Z", type: "model.request.started", providerId: "fixture" },
    ];
    await writeFile(trajectoryPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
    const snapshot = {
      type: "harness.supervision.snapshot",
      packageId,
      attemptId: "pending-attempt-id",
      mode: "dynamic",
      runId: actualRunId,
      status: "running",
      currentSequence: 3,
      evidenceSequence: 2,
      evidenceFresh: true,
      latestObservation: { id: observation.id, sequence: 2, capturedAt: observation.capturedAt, screenshot: observation.screenshot },
      terminal: false,
      updatedAt: new Date().toISOString(),
    };
    let finishScheduled = false;
    const finishChild = () => {
      if (finishScheduled) return;
      finishScheduled = true;
      setTimeout(() => {
        child.emit("message", { ...snapshot, status: "finished", currentSequence: 4, terminal: true, updatedAt: new Date().toISOString() });
        child.stdout.end();
        child.stderr.end();
        child.exitCode = 0;
        child.connected = false;
        child.emit("close", 0, null);
      }, 40);
    };

    const runPromise = runLive({
      plan,
      review: prepared.review,
      packageDir,
      cuaSocket: "offline-supervision-ipc-fixture",
      supervised: true,
    }, {
      terminalStdout,
      terminalStderr,
      buildChildEnvironment: async () => ({ ...process.env }),
      spawnChild(_executable, _args, options) {
        assert.deepEqual(options.stdio, ["inherit", "pipe", "pipe", "ipc"]);
        assert.equal(options.env.HARNESS_LIFE_EVAL_SUPERVISION_MODE, "dynamic");
        child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.exitCode = null;
        child.signalCode = null;
        child.connected = true;
        child.kill = (signal) => {
          if (signal === "SIGTERM" || signal === "SIGKILL") {
            child.exitCode = signal === "SIGTERM" ? 143 : 137;
            child.stdout.end();
            child.stderr.end();
            child.emit("close", child.exitCode, null);
          }
          return true;
        };
        child.send = (message, _sendHandle, _sendOptions, callback) => {
          if (message.type === "harness.supervision.start") {
            snapshot.attemptId = message.attemptId;
            setImmediate(() => {
              child.emit("message", {
                type: "harness.supervision.initialized",
                packageId,
                attemptId: message.attemptId,
                mode: "dynamic",
              });
              setImmediate(() => child.emit("message", snapshot));
            });
          } else if (message.type === "harness.supervision.command" && message.command === "correct") {
            setImmediate(async () => {
              await appendFile(trajectoryPath, `${JSON.stringify({
                schemaVersion: 2,
                runId: actualRunId,
                eventId: "event-user-input",
                sequence: 4,
                occurredAt: new Date().toISOString(),
                type: "user.input.received",
                text: message.text,
              })}\n`, "utf8");
              const receipt = {
                type: "harness.supervision.receipt",
                commandId: message.commandId,
                packageId,
                attemptId: message.attemptId,
                runId: actualRunId,
                command: "correct",
                at: new Date().toISOString(),
              };
              child.emit("message", { ...receipt, status: "queued", reason: "accepted-by-RunController-inbox" });
              child.emit("message", { ...receipt, status: "consumed", reason: "user.input.received", eventSequence: 4 });
              finishChild();
            });
          }
          callback?.(null);
          return true;
        };
        setImmediate(() => child.emit("message", { type: "harness.supervision.listener-ready", mode: "dynamic" }));
        return child;
      },
    });

    let current;
    const readyDeadline = Date.now() + 4_000;
    while (Date.now() < readyDeadline) {
      try {
        current = await inspectSupervision(packageDir);
        if (current.runId === actualRunId && current.evidenceFresh === true && current.latestObservation?.id === observation.id) break;
      } catch {
        // The child has not published its first committed snapshot yet.
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    assert.equal(current?.runId, actualRunId);
    assert.equal(current?.evidenceSequence, 2);
    const textFile = join(tempRoot, "actual-correction.txt");
    await writeFile(textFile, "请回看当前页面，检查实际结果后再决定下一步。", "utf8");
    const command = await submitSupervisionCommand(packageDir, {
      command: "correct",
      runId: actualRunId,
      evidenceSequence: current.latestObservation.sequence,
      observationId: current.latestObservation.id,
      textFile,
      waitMs: 2_000,
    });
    assert.ok(command.status === "queued" || command.status === "consumed");
    let consumedReceipt = command.receipt;
    const consumedDeadline = Date.now() + 2_000;
    while (consumedReceipt?.status !== "consumed" && Date.now() < consumedDeadline) {
      consumedReceipt = await readSupervisionReceipt(packageDir, command.commandId);
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    assert.equal(consumedReceipt?.status, "consumed");
    assert.equal(consumedReceipt?.reason, "user.input.received");
    assert.equal(consumedReceipt?.eventSequence, 4);

    const final = await runPromise;
    assert.equal(final.supervision.listenerHandshake, "completed");
    assert.equal(final.supervision.runId, actualRunId);
    assert.equal((await readSupervisionReceipt(packageDir, command.commandId)).status, "consumed");
    const trajectoryText = await readFile(trajectoryPath, "utf8");
    assert.match(trajectoryText, /请回看当前页面/u);
    assert.doesNotMatch(trajectoryText, /\uFFFD|\?{3,}|_{2,}/u);
    assert.match(terminalOutput, /Runner recorded one live attempt/u);
  } finally {
    terminalStdout.destroy();
    terminalStderr.destroy();
    if (packageDir !== undefined && packageId !== undefined) {
      const ownedPackage = join(ROOT, "runs", SIX_DOMAIN_SUITE_ID, packageId);
      assert.equal(packageDir, ownedPackage, "cleanup target must be this test's exact generated package");
      await rm(ownedPackage, { recursive: true, force: false });
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});
