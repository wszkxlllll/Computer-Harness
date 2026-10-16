import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import {
  MANIFEST_PATH,
  ROOT,
  SUITE_ID,
  VARIANTS,
  loadCliModule,
  pathExists,
  parseIsoDate,
  sha256,
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
  buildLiveAttemptRecord,
  concreteArgv,
  parseRunArgs,
  runLive,
  runPackage,
} from "./run.mjs";

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
  assert.throws(() => parsePrepareArgs(["--task-id", "G01"]), /--output-dir is required/u);
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
  const taskCards = await readFile(join(ROOT, "docs", "life-business-task-cards-2026-10-15.md"), "utf8");
  const extractT03TaskCardGoal = (markdown) => {
    const lfMarkdown = markdown.replace(/\r\n?/gu, "\n");
    const t03Section = lfMarkdown.match(/## T03 ·[\s\S]*?(?=\n## |$)/u)?.[0];
    return t03Section?.match(/### 给Agent的完整需求\n\n```text\n([\s\S]*?)\n```/u)?.[1];
  };
  const normalizedTaskCards = taskCards.replace(/\r\n?/gu, "\n");
  const taskCardGoalFromLf = extractT03TaskCardGoal(normalizedTaskCards);
  const taskCardGoalFromCrlf = extractT03TaskCardGoal(normalizedTaskCards.replace(/\n/gu, "\r\n"));
  assert.equal(taskCardGoalFromLf, t03.goal, "LF T03 task card Goal must match the manifest exactly");
  assert.equal(taskCardGoalFromCrlf, t03.goal, "CRLF T03 task card Goal must match the manifest exactly");
  assert.equal(taskCardGoalFromCrlf, taskCardGoalFromLf, "T03 task card Goal extraction must be newline-invariant");
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
  const v0InputNames = (await readdir(join(ROOT, "eval", SUITE_ID, "history", "v0-inputs"))).sort();
  assert.deepEqual(v0InputNames, [
    "G01-准备清单.txt", "G02-签注准备页.txt", "T01-杭州出行备忘.txt", "T02-铁路规则对照.txt",
    "M01-来院便条.txt", "M02-就诊准备.txt", "M03-来院资料.txt",
  ].sort());
  const v1InputNames = (await readdir(join(ROOT, "eval", SUITE_ID, "history", "v1-inputs"))).sort();
  assert.deepEqual(v1InputNames, ["G03-长者办事资料.txt", "T03-南京出行资料.txt"].sort());
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
    assert.equal(prepared.plan.task.id, "G03");
    assert.equal(prepared.plan.task.outcomeMode, "document");
    assert.equal(prepared.plan.configuration.windowSwitch, "opened-windows-v1");
    assert.equal(prepared.plan.configuration.grounding, "hybrid-catalog-v1");
    assert.equal(prepared.plan.configuration.requestedGrounding, "off");
    assert.equal(prepared.plan.configuration.managedBrowserCompanion, true);
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

test("T03 prepares one DOCX plus an exact WeChat delivery target without authorizing or sending", async () => {
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
