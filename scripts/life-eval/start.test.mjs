import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MANIFEST_PATH, ROOT, SHOPPING_COMMUNICATION_SUITE_ID, SUITE_ID, manifestPathForSuite, sha256 } from "./common.mjs";
import { renderGoal } from "./prepare.mjs";
import {
  beijingDate,
  buildNextCommands,
  buildPrepareOptions,
  loadLocalConfig,
  parseStartArgs,
  prepareFromStartArgs,
} from "./start.mjs";

const fixtureConfig = {
  outputDir: "E:\\life-eval-output",
  profileLabel: "travel",
  wechatChat: "指定测试会话",
  cuaSocket: "offline-socket-fixture",
  candidateDriverPath: join(tmpdir(), "life-eval-candidate-driver-fixture.exe"),
  candidateDriverSha256: "A".repeat(64),
  candidateDriverVersion: "0.22.2",
  candidateDriverSource: "7852ab1",
  envFilePath: join(tmpdir(), "life-eval-private-fixture.env"),
};

test("start derives today's Beijing date and tomorrow independent of host timezone", () => {
  const justAfterBeijingMidnight = new Date("2026-10-14T16:30:00.000Z");
  assert.equal(beijingDate(justAfterBeijingMidnight), "2026-10-15");
  const { prepareOptions } = buildPrepareOptions({ "--task-id": "T01", "--variant": "B00" }, { now: justAfterBeijingMidnight, config: fixtureConfig });
  assert.equal(prepareOptions["--as-of-date"], "2026-10-15");
  assert.equal(prepareOptions["--travel-date"], "2026-10-16");
});

test("start requires task and variant, applies local defaults, and keys chat injection to the goal token", () => {
  assert.throws(() => parseStartArgs(["--task-id", "G03"]), /--variant is required/u);
  const args = parseStartArgs(["--task-id", "G03", "--variant", "PM11"]);
  const standard = buildPrepareOptions(args, { now: new Date("2026-10-14T16:30:00.000Z"), config: fixtureConfig });
  assert.equal(standard.prepareOptions["--suite"], SUITE_ID);
  assert.equal(Object.hasOwn(standard.prepareOptions, "--api-key-env"), false);
  assert.equal(standard.prepareOptions["--output-dir"], fixtureConfig.outputDir);
  assert.equal(standard.prepareOptions["--profile-label"], fixtureConfig.profileLabel);
  assert.equal(standard.prepareOptions["--profile-label"], "travel");
  assert.equal(Object.hasOwn(standard.prepareOptions, "--wechat-chat"), false);

  const chatlessConfig = { outputDir: fixtureConfig.outputDir, profileLabel: fixtureConfig.profileLabel, cuaSocket: fixtureConfig.cuaSocket };
  const withoutChat = buildPrepareOptions(args, {
    now: new Date("2026-10-14T16:30:00.000Z"),
    config: chatlessConfig,
    task: { goal: "查公开信息并回答问题。", requiredApps: ["managed-browser"] },
  });
  assert.equal(Object.hasOwn(withoutChat.prepareOptions, "--wechat-chat"), false);
  const tokenTask = buildPrepareOptions({ "--task-id": "FUTURE", "--variant": "B00" }, {
    config: fixtureConfig,
    task: { goal: "把文件发送给《{{WECHAT_CHAT}}》。", requiredApps: ["managed-browser", "WPS", "WeChat"] },
  });
  assert.equal(tokenTask.prepareOptions["--wechat-chat"], fixtureConfig.wechatChat);
  assert.throws(() => buildPrepareOptions({ "--task-id": "FUTURE", "--variant": "B00" }, {
    config: chatlessConfig,
    task: { goal: "把文件发送给《{{WECHAT_CHAT}}》。", requiredApps: ["managed-browser", "WPS", "WeChat"] },
  }), /requires a configured local wechatChat/u);
  assert.throws(() => buildPrepareOptions({ "--task-id": "FUTURE", "--variant": "B00" }, {
    config: fixtureConfig,
    task: { goal: "把文件发送给《{{WECHAT_CHAT}}》。", requiredApps: ["managed-browser"] },
  }), /both require WeChat and declare/u);
  assert.throws(() => buildPrepareOptions({ "--task-id": "FUTURE", "--variant": "B00" }, {
    config: fixtureConfig,
    task: { goal: "查公开信息并回答问题。", requiredApps: ["managed-browser", "WeChat"] },
  }), /both require WeChat and declare/u);
  assert.throws(() => parseStartArgs(["--task-id", "T01", "--variant", "B00", "--wechat-chat", "other"]), /unknown option/u);
});

test("start accepts explicit output/date/socket overrides without connecting to the socket", () => {
  const args = parseStartArgs([
    "--task-id", "T03",
    "--variant", "M01",
    "--output-dir", "E:\\override-output",
    "--profile-label", "profile-override",
    "--travel-date", "2026-10-18",
    "--cua-socket", "\\\\.\\pipe\\cua-test",
  ]);
  const built = buildPrepareOptions(args, { now: new Date("2026-10-14T16:30:00.000Z"), config: fixtureConfig });
  assert.equal(built.prepareOptions["--travel-date"], "2026-10-18");
  assert.equal(built.prepareOptions["--output-dir"], "E:\\override-output");
  assert.equal(built.prepareOptions["--profile-label"], "profile-override");
  assert.equal(built.cuaSocket, "\\\\.\\pipe\\cua-test");
  assert.throws(() => buildPrepareOptions({ ...args, "--cua-socket": "   " }, { config: fixtureConfig }), /must not be empty/u);
});

test("start selects the six-task suite explicitly and freezes its configured Ark key-variable name", async () => {
  const manifestPath = manifestPathForSuite(SHOPPING_COMMUNICATION_SUITE_ID);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const task = manifest.tasks.find((candidate) => candidate.id === "S01");
  const config = { ...fixtureConfig, arkApiKeyEnv: "HUOSHAN_API_KEY" };
  const args = parseStartArgs(["--suite", SHOPPING_COMMUNICATION_SUITE_ID, "--task-id", "S01", "--variant", "B00"]);
  const built = buildPrepareOptions(args, { config, task, now: new Date("2026-10-14T16:30:00.000Z") });
  assert.equal(built.prepareOptions["--suite"], SHOPPING_COMMUNICATION_SUITE_ID);
  assert.equal(built.prepareOptions["--api-key-env"], "HUOSHAN_API_KEY");
  assert.equal(task.startUrl, "https://www.apple.com.cn/shop/product/mwvw3ch/a");
  assert.throws(() => buildPrepareOptions({ ...args, "--api-key-env": "DEEPSEEK_API_KEY" }, { config, task }), /one of ARK_API_KEY, HUOSHAN_API_KEY/u);
  assert.throws(() => buildPrepareOptions({ "--task-id": "G01", "--variant": "B00", "--api-key-env": "ARK_API_KEY" }, { config, task: { ...task, id: "G01" } }), /only for the Ark Agent Plan suite/u);
  assert.throws(() => buildPrepareOptions({ ...args, "--suite": "unknown-suite" }, { config, task }), /unsupported life-eval suite/u);
});

test("printed commands use the current Node executable and keep dry-run separate from pending live", () => {
  const currentNodeCommands = buildNextCommands("E:\\runs\\pkg", undefined, { root: "E:\\repo" });
  assert.ok(currentNodeCommands.dryRun.includes(`'${process.execPath.replaceAll("'", "''")}'`));
  const commands = buildNextCommands("E:\\runs\\package id", "\\\\.\\pipe\\cua-test", {
    root: "E:\\Harness-PR30-Fix-20261014",
    nodeExecutable: "C:\\Program Files\\node\\node.exe",
  });
  assert.match(commands.dryRun, /^& 'C:\\Program Files\\node\\node\.exe'/u);
  assert.match(commands.dryRun, /--package 'E:\\runs\\package id'$/u);
  assert.doesNotMatch(commands.dryRun, /--live/u);
  assert.match(commands.supervisedLive, /--live --confirm-desktop-control --supervised --cua-socket/u);
  assert.match(commands.supervisedLive, /'\\\\\.\\pipe\\cua-test'$/u);
  const pending = buildNextCommands("E:\\runs\\pkg", undefined, { root: "E:\\repo", nodeExecutable: "node.exe" });
  assert.match(pending.supervisedLive, /<填入已运行CUA daemon的实际socket>/u);
});

test("G03 and T03 separate the save folder from the filename in the projected goal", async () => {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  for (const [taskId, fileName] of [["G03", "G03-长者办事资料.docx"], ["T03", "T03-南京出行资料.docx"]]) {
    const task = manifest.tasks.find((candidate) => candidate.id === taskId);
    const rendered = renderGoal(task, `E:\\evaluation-output\\${taskId}\\B00\\attempt`, "2026-10-16", taskId === "T03" ? "文件传输助手" : undefined).goal;
    assert.match(rendered, /保存文件夹：E:\/evaluation-output\//u);
    assert.ok(rendered.includes(`文件名：${fileName}`));
    assert.ok(rendered.indexOf("保存文件夹：") < rendered.indexOf("文件名："));
    assert.doesNotMatch(rendered, /保存对话框|文件名框|重复粘贴/u);
    assert.equal(rendered.includes(`文件名：E:/evaluation-output/${taskId}`), false);
    assert.equal(rendered.includes("{{OUTPUT_DIR}}"), false);
  }
});

test("start creates only an offline plan and leaves human preflight pending", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "life-eval-start-test-"));
  const candidateDriverPath = join(outputRoot, "candidate-cua-driver.exe");
  const candidateDriverBytes = "fixture-only-cua-driver-bytes";
  await writeFile(candidateDriverPath, candidateDriverBytes, { encoding: "utf8", flag: "wx" });
  let packageId;
  let packageDir;
  try {
    const args = parseStartArgs(["--task-id", "T02", "--variant", "B00", "--output-dir", outputRoot]);
    const prepared = await prepareFromStartArgs(args, {
      root: ROOT,
      manifestPath: MANIFEST_PATH,
      now: () => new Date("2026-10-14T16:30:00.000Z"),
      config: {
        ...fixtureConfig,
        candidateDriverPath,
        candidateDriverSha256: sha256(candidateDriverBytes),
        envFilePath: join(outputRoot, "not-read.env"),
      },
    });
    packageId = prepared.packageId;
    packageDir = prepared.packageDir;
    assert.equal(prepared.plan.selection.asOfDate, "2026-10-15");
    assert.equal(prepared.plan.selection.travelDate, "2026-10-16");
    assert.equal(prepared.plan.selection.profileLabel, "travel");
    assert.equal(prepared.plan.selection.wechatChat, null);
    assert.equal(prepared.plan.configuration.windowSwitch, "opened-windows-v1");
    assert.equal(prepared.plan.configuration.multilineTypeProfile, "foreground-caret-v1");
    assert.equal(prepared.plan.configuration.cuaDriver.sha256, sha256(candidateDriverBytes).toUpperCase());
    assert.equal(prepared.plan.configuration.cuaDriver.verificationScope.startsWith("candidate-file-hash-only"), true);
    assert.equal(prepared.plan.cli.envFilePath, join(outputRoot, "not-read.env"));
    assert.equal(prepared.plan.cli.argvTemplate.includes("--multiline-type-profile"), true);
    assert.equal(prepared.plan.cli.argvTemplate.includes(join(outputRoot, "not-read.env")), true);
    assert.equal(prepared.plan.cli.argvTemplate.includes("--window-switch"), true);
    assert.equal(prepared.plan.cli.argvTemplate.includes("--cua-window-pid"), false);
    assert.equal(prepared.plan.cli.argvTemplate.includes("--cua-window-id"), false);
    assert.equal(prepared.review.preflight.status, "pending");
    assert.equal(prepared.review.preflight.cuaDaemon.status, "pending");
    assert.match(prepared.review.preflight.cuaDaemon.note, /does not establish daemon identity/u);
    assert.equal(prepared.review.preflight.wechatTestChatAuthorized, null);
    assert.equal(prepared.review.firstSupervisedRunAccepted, false);
    assert.equal(prepared.cuaSocket, fixtureConfig.cuaSocket);
  } finally {
    if (packageId !== undefined && packageDir !== undefined) {
      const ownedPackage = join(ROOT, "runs", SUITE_ID, packageId);
      assert.equal(packageDir, ownedPackage, "cleanup target must be this test's exact generated package");
      await rm(ownedPackage, { recursive: true, force: false });
    }
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("start freezes T03's configured WeChat recipient but never authorizes or sends", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "life-eval-start-t03-test-"));
  const candidateDriverPath = join(outputRoot, "candidate-cua-driver.exe");
  const candidateDriverBytes = "fixture-only-cua-driver-bytes";
  await writeFile(candidateDriverPath, candidateDriverBytes, { encoding: "utf8", flag: "wx" });
  let packageId;
  let packageDir;
  try {
    const args = parseStartArgs(["--task-id", "T03", "--variant", "B00", "--output-dir", outputRoot]);
    const prepared = await prepareFromStartArgs(args, {
      root: ROOT,
      manifestPath: MANIFEST_PATH,
      now: () => new Date("2026-10-14T16:30:00.000Z"),
      config: {
        ...fixtureConfig,
        candidateDriverPath,
        candidateDriverSha256: sha256(candidateDriverBytes),
        wechatChat: "文件传输助手",
      },
    });
    packageId = prepared.packageId;
    packageDir = prepared.packageDir;
    assert.equal(prepared.plan.task.id, "T03");
    assert.equal(prepared.plan.selection.wechatChat, "文件传输助手");
    assert.match(prepared.plan.task.goal, /微信发送给《文件传输助手》/u);
    assert.equal(prepared.plan.cli.argvTemplate.some((arg) => arg.includes("文件传输助手")), true);
    assert.equal(prepared.plan.configuration.windowSwitch, "opened-windows-v1");
    assert.equal(prepared.review.preflight.status, "pending");
    assert.equal(prepared.review.preflight.wechatChat, "文件传输助手");
    assert.equal(prepared.review.preflight.wechatTestChatAuthorized, false);
    assert.equal(prepared.review.firstSupervisedRunAccepted, false);
  } finally {
    if (packageId !== undefined && packageDir !== undefined) {
      const ownedPackage = join(ROOT, "runs", SUITE_ID, packageId);
      assert.equal(packageDir, ownedPackage, "cleanup target must be this test's exact generated package");
      await rm(ownedPackage, { recursive: true, force: false });
    }
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("start prepares the shopping suite under its own runs path without reading the env file", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "life-eval-start-shopping-test-"));
  const candidateDriverPath = join(outputRoot, "candidate-cua-driver.exe");
  const candidateDriverBytes = "fixture-only-shopping-cua-driver-bytes";
  await writeFile(candidateDriverPath, candidateDriverBytes, { encoding: "utf8", flag: "wx" });
  let packageId;
  let packageDir;
  try {
    const args = parseStartArgs(["--suite", SHOPPING_COMMUNICATION_SUITE_ID, "--task-id", "CM02", "--variant", "M01", "--output-dir", outputRoot]);
    const prepared = await prepareFromStartArgs(args, {
      root: ROOT,
      manifestPath: manifestPathForSuite(SHOPPING_COMMUNICATION_SUITE_ID),
      now: () => new Date("2026-10-14T16:30:00.000Z"),
      config: {
        ...fixtureConfig,
        arkApiKeyEnv: "HUOSHAN_API_KEY",
        candidateDriverPath,
        candidateDriverSha256: sha256(candidateDriverBytes),
        envFilePath: join(outputRoot, "not-read.env"),
      },
    });
    packageId = prepared.packageId;
    packageDir = prepared.packageDir;
    assert.equal(packageDir, join(ROOT, "runs", SHOPPING_COMMUNICATION_SUITE_ID, packageId));
    assert.equal(prepared.plan.suiteId, SHOPPING_COMMUNICATION_SUITE_ID);
    assert.equal(prepared.plan.task.id, "CM02");
    assert.equal(prepared.plan.task.startUrl, "https://support.apple.com/zh-cn/guide/calendar/icl1018/16.0/mac/26");
    assert.match(prepared.plan.task.goal, /2026年11月4日至11月25日/u);
    assert.equal(prepared.plan.configuration.model, "deepseek-v4.1-flash");
    assert.equal(prepared.plan.configuration.batching, "off");
    assert.equal(prepared.plan.configuration.planning, false);
    assert.equal(prepared.plan.configuration.memory, "facts");
    assert.equal(prepared.plan.configuration.environment.apiKeyEnvName, "HUOSHAN_API_KEY");
    assert.equal(prepared.plan.configuration.environment.apiKeyTargetEnvName, "ARK_API_KEY");
    assert.equal(Object.hasOwn(prepared.plan.configuration.environment, "apiKey"), false);
    assert.equal(Object.hasOwn(prepared.plan.configuration.environment, "apiKeyValue"), false);
    assert.equal(prepared.plan.cli.envFilePath, join(outputRoot, "not-read.env"));
    assert.equal(prepared.plan.cli.argvTemplate[prepared.plan.cli.argvTemplate.indexOf("--managed-browser-url") + 1], prepared.plan.task.startUrl);
    assert.equal(prepared.plan.cli.argvTemplate[prepared.plan.cli.argvTemplate.indexOf("--batching") + 1], "off");
    assert.equal(prepared.plan.cli.argvTemplate[prepared.plan.cli.argvTemplate.indexOf("--model") + 1], "deepseek-v4.1-flash");
    assert.equal(prepared.plan.cli.argvTemplate.some((arg) => arg.includes("S-C")), false);
    assert.equal(JSON.stringify(prepared.plan).includes("HUOSHAN_API_KEY="), false);
    assert.equal(prepared.review.preflight.status, "pending");
    await assert.rejects(readFile(prepared.plan.cli.envFilePath), { code: "ENOENT" });
  } finally {
    if (packageId !== undefined && packageDir !== undefined) {
      assert.equal(packageDir, join(ROOT, "runs", SHOPPING_COMMUNICATION_SUITE_ID, packageId));
      await rm(packageDir, { recursive: true, force: false });
    }
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("missing local config is a clear preparation error rather than guessed defaults", async () => {
  const missingPath = join(tmpdir(), "life-eval-local-config-does-not-exist.json");
  await assert.rejects(loadLocalConfig(missingPath), /local life-eval config not found/u);
});
