import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  MANIFEST_PATH,
  ROOT,
  SUITE_ID,
  builtCliFingerprint,
  gitSummary,
  jsonText,
  loadCliParser,
  parseFlags,
  pathExists,
  sha256,
  sourceFingerprint,
  verifyCuaDriverBinary,
  validateCliArgv,
} from "./common.mjs";

const VALUE_FLAGS = new Set(["--package", "--cua-socket"]);
const BOOLEAN_FLAGS = new Set(["--live", "--confirm-desktop-control", "--supervised", "--help"]);
const CUA_SOCKET_TOKEN = "{{CUA_SOCKET}}";

export function parseRunArgs(argv) {
  return parseFlags(argv, {
    valueFlags: VALUE_FLAGS,
    booleanFlags: BOOLEAN_FLAGS,
    required: ["--package"],
  });
}

export function assertFreezeMatches(plan, packageDir, manifestBytes, currentSource, currentBuiltCli, currentGit) {
  if (plan.schemaVersion !== 1 || plan.suiteId !== SUITE_ID) throw new Error("unsupported plan schema/suite");
  if (typeof plan.frozenState?.git?.head !== "string") throw new Error("plan is missing its frozen git source version");
  if (resolve(plan.packageDir) !== resolve(packageDir)) throw new Error("package path does not match frozen plan");
  if (sha256(manifestBytes) !== plan.frozenState.manifestSha256) throw new Error("task manifest changed; prepare a new package");
  if (currentGit && currentGit.head !== plan.frozenState.git.head) throw new Error("git source version changed; prepare a new package");
  if (currentSource.sha256 !== plan.frozenState.sourceFingerprint.sha256) throw new Error("source fingerprint changed; prepare a new package");
  if (currentBuiltCli.sha256 !== plan.frozenState.builtCliFingerprint.sha256) throw new Error("built CLI fingerprint changed; prepare a new package");
}

export async function verifyActiveInputs(activeInputs, manifestPath) {
  if (!Array.isArray(activeInputs)) throw new Error("plan activeInputs must be an array");
  const suiteDir = dirname(manifestPath);
  for (const input of activeInputs) {
    if (typeof input.relativePath !== "string" || typeof input.sha256 !== "string") throw new Error("plan has an invalid frozen active input entry");
    const path = resolve(suiteDir, input.relativePath);
    const fromSuite = relative(suiteDir, path);
    if (fromSuite === ".." || fromSuite.startsWith(`..${sep}`) || isAbsolute(fromSuite) || resolve(input.path) !== path) {
      throw new Error(`active input path escaped or changed: ${input.relativePath}`);
    }
    const bytes = await readFile(path);
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (sha256(bytes) !== input.sha256 || bytes.byteLength !== input.bytes) {
      throw new Error(`active input changed since prepare: ${input.relativePath}`);
    }
  }
}

export async function loadAndVerifyPackage(packageDir, { manifestPath = MANIFEST_PATH, root = ROOT } = {}) {
  const absolutePackage = resolve(packageDir);
  const planPath = join(absolutePackage, "plan.json");
  const reviewPath = join(absolutePackage, "review.json");
  const planBytes = await readFile(planPath);
  const reviewBytes = await readFile(reviewPath);
  const plan = JSON.parse(planBytes.toString("utf8"));
  const review = JSON.parse(reviewBytes.toString("utf8"));
  if (review.packageId !== plan.packageId || review.profileLabel !== plan.selection.profileLabel) {
    throw new Error("review.json package/profile does not match frozen plan");
  }
  if (review.planSha256 !== sha256(planBytes)) throw new Error("plan.json changed after prepare; prepare a new package");
  const manifestBytes = await readFile(manifestPath);
  const [currentSource, currentBuiltCli] = await Promise.all([sourceFingerprint(root), builtCliFingerprint(root)]);
  const currentGit = gitSummary(root);
  assertFreezeMatches(plan, absolutePackage, manifestBytes, currentSource, currentBuiltCli, currentGit);
  await verifyCuaDriverBinary(plan.configuration?.cuaDriver);
  await verifyActiveInputs(plan.task.activeInputs, manifestPath);
  return { absolutePackage, plan, review };
}

export function concreteArgv(plan, cuaSocket) {
  if (!Array.isArray(plan.cli.argvTemplate)) throw new Error("plan does not contain the frozen CLI argv template");
  return plan.cli.argvTemplate.map((value) => value === CUA_SOCKET_TOKEN ? cuaSocket : value);
}

export function assertPreflight(review, plan, cuaSocket) {
  const preflight = review.preflight;
  if (!preflight || preflight.status !== "passed") throw new Error("live execution requires review.json preflight.status=passed");
  if (typeof preflight.checkedAt !== "string" || !Number.isFinite(Date.parse(preflight.checkedAt))) {
    throw new Error("live execution requires a human-filled preflight.checkedAt");
  }
  if (typeof preflight.operator !== "string" || preflight.operator.trim().length === 0) {
    throw new Error("live execution requires a human-filled preflight.operator");
  }
  const requiredApps = plan.task.requiredApps;
  if (!Array.isArray(preflight.requiredApps)) throw new Error("live execution requires per-app preflight statuses");
  for (const app of requiredApps) {
    const item = preflight.requiredApps.find((candidate) => candidate.app === app);
    if (!item || item.status !== "passed") throw new Error(`preflight is not passed for required app: ${app}`);
  }
  const activeInputs = plan.task.activeInputs ?? [];
  if (!Array.isArray(preflight.activeInputs)) throw new Error("live execution requires active-input preflight statuses");
  for (const input of activeInputs) {
    const item = preflight.activeInputs.find((candidate) => candidate.relativePath === input.relativePath);
    if (!item || item.status !== "passed" || item.sha256 !== input.sha256) {
      throw new Error(`preflight is not passed for active input: ${input.relativePath}`);
    }
  }
  const candidateDriver = plan.configuration?.cuaDriver;
  if (candidateDriver !== null && candidateDriver !== undefined) {
    const daemon = preflight.cuaDaemon;
    if (!daemon || daemon.status !== "passed" || daemon.socketPath !== cuaSocket ||
        daemon.binarySha256 !== candidateDriver.sha256 || daemon.version !== candidateDriver.version ||
        daemon.sourceCommit !== candidateDriver.sourceCommit || daemon.identityConfirmed !== true) {
      throw new Error("live execution requires human confirmation that the selected CUA socket is running the frozen candidate driver; file hash alone is not daemon identity");
    }
  }
  const requiresWechat = plan.task.requiredApps.includes("WeChat");
  if (requiresWechat) {
    if (typeof plan.task.wechatChat !== "string" || plan.task.wechatChat.length === 0 || preflight.wechatChat !== plan.task.wechatChat || preflight.wechatTestChatAuthorized !== true) {
      throw new Error("live WeChat task requires an exact matching recipient and human wechatTestChatAuthorized=true receipt");
    }
  } else if (preflight.wechatTestChatAuthorized === true) {
    throw new Error("WeChat authorization is not applicable to this task");
  }
}

export function assertLiveAuthorization(review, plan, supervised, cuaSocket) {
  assertPreflight(review, plan, cuaSocket);
  if (supervised) {
    if (review.firstSupervisedRunAccepted !== false) {
      throw new Error("--supervised is only for the first supervised Run while firstSupervisedRunAccepted=false");
    }
    return;
  }
  const key = `${plan.task.id}:${plan.selection.variant}`;
  if (review.firstSupervisedRunAccepted !== true || review.batchAuthorized !== true ||
      !Array.isArray(review.authorizedTaskVariants) || !review.authorizedTaskVariants.includes(key)) {
    throw new Error(`non-supervised Run requires firstSupervisedRunAccepted=true, batchAuthorized=true, and authorizedTaskVariants including ${key}`);
  }
}

function printDryRun(plan, argv, socketPlaceholder) {
  process.stdout.write(`${JSON.stringify({
    status: "dry-run; no CLI process, desktop, model, network, env-file, or credential access",
    packageId: plan.packageId,
    task: plan.task.id,
    outcomeMode: plan.task.outcomeMode,
    variant: plan.selection.variant,
    model: plan.configuration.model,
    deepseekEnabled: false,
    cuaDriver: plan.configuration.cuaDriver,
    runningCuaDaemonIdentity: "not verified by candidate binary hash; human socket preflight required",
    cuaSocket: socketPlaceholder ? "placeholder (supply --cua-socket for live)" : "provided; not contacted",
    argv,
    limits: {
      mainRequests: plan.configuration.maxModelRequests,
      riskRequests: plan.configuration.maxRiskModelRequests,
      combinedCeiling: plan.configuration.combinedRequestCeiling,
      actions: plan.configuration.maxActions,
      timeoutMs: plan.configuration.runTimeoutMs,
      outputTokens: plan.configuration.maxOutputTokens,
      requestTimeoutMs: plan.configuration.requestTimeoutMs,
    },
  }, null, 2)}\n`);
}

function consumerEvidence(plan, stdoutLog, stderrLog) {
  const base = {
    outcomeMode: plan.task.outcomeMode,
    humanReviewRequired: true,
    reviewLocation: "review.json#consumerReview and checkScores",
    stdoutLog,
    stderrLog,
    fullRawHttpWireCaptured: false,
  };
  if (plan.task.outcomeMode === "response") {
    return { ...base, primaryEvidence: "ordinary CLI response/logs and run trajectory; human verifies content and visible browser result page" };
  }
  if (plan.task.outcomeMode === "document") {
    const wechatDelivery = plan.task.requiredApps.includes("WeChat")
      ? {
          targetChat: plan.task.wechatChat,
          fileName: plan.task.deliverables[0]?.name ?? null,
          status: "pending_human_confirmation",
          automaticScoring: false,
          evidence: "Human separately verifies the saved document and its delivery to the exact target; runner does not inspect chats or send state.",
        }
      : null;
    return {
      ...base,
      expectedDeliverables: plan.task.deliverables.map((item) => join(plan.selection.outputAttemptDir, item.name)),
      ...(wechatDelivery === null ? {} : { wechatDelivery }),
      primaryEvidence: wechatDelivery === null
        ? "expected document path plus ordinary CLI logs/trajectory; human verifies the saved document and formatting"
        : "human separately verifies the saved document/formatting and confirms that the same file was sent to the exact WeChat target; neither outcome is auto-scored",
    };
  }
  return {
    ...base,
    targetWeChatTestChat: plan.task.wechatChat,
    primaryEvidence: "manual visible confirmation that the exact target contains an unsent draft; runner does not inspect chat history or send state",
  };
}

export function buildLiveAttemptRecord({ plan, review, attemptDir, cuaSocket, supervised, startedAt, argv }) {
  const stdoutLog = join(attemptDir, "stdout.log");
  const stderrLog = join(attemptDir, "stderr.log");
  return {
    schemaVersion: 1,
    packageId: plan.packageId,
    task: plan.task.id,
    variant: plan.selection.variant,
    outcomeMode: plan.task.outcomeMode,
    supervised,
    operatorConfirmation: "typed exact package/task/variant string in terminal",
    startedAt,
    executable: process.execPath,
    cliEntry: plan.cli.entry,
    cuaSocket,
    argv,
    shell: false,
    envFilePath: plan.cli.envFilePath ?? null,
    cuaDriver: plan.configuration.cuaDriver,
    cuaDaemonPreflight: review.preflight.cuaDaemon ?? null,
    envPolicy: plan.cli.envFilePath === null || plan.cli.envFilePath === undefined
      ? "runner does not read .env; inherit current environment and override only DeepSeek timeout/output-token caps in this child"
      : "runner does not read envFilePath; the live child CLI reads it via --env-file and receives only the bounded DeepSeek timeout/output-token overrides",
    stdoutLog,
    stderrLog,
    consumerEvidence: consumerEvidence(plan, stdoutLog, stderrLog),
    final: null,
  };
}

async function promptExactConfirmation(plan) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("live execution requires an interactive terminal for typed per-Run confirmation");
  }
  const expected = `${plan.packageId} ${plan.task.id}:${plan.selection.variant}`;
  process.stdout.write(`\nThis single Run can control the desktop and call DeepSeek. Type exactly:\n${expected}\n> `);
  const answer = await new Promise((resolveAnswer, reject) => {
    let text = "";
    const onData = (chunk) => {
      text += chunk.toString("utf8");
      const newline = text.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      resolveAnswer(text.slice(0, newline).replace(/\r$/u, ""));
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("terminal input closed before live confirmation"));
    };
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.pause();
    };
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
  });
  if (answer !== expected) throw new Error("live execution cancelled: typed confirmation did not match");
}

function tee(source, terminal, log) {
  source.on("data", (chunk) => {
    terminal.write(chunk);
    log.write(chunk);
  });
}

function watchForClose(child) {
  let resolveResult;
  let spawnError;
  let closeObserved = false;
  let settled = false;
  const promise = new Promise((resolve) => { resolveResult = resolve; });
  const settle = (result) => {
    if (settled) return false;
    settled = true;
    resolveResult({ ...result, spawnError });
    return true;
  };
  child.once("error", (error) => { spawnError = error; });
  child.once("close", (code, signal) => {
    closeObserved = true;
    settle({ code, signal, closeObserved: true });
  });
  return {
    promise,
    hasClosed: () => closeObserved,
    resolveWithoutClose: () => settle({ code: child.exitCode, signal: child.signalCode, closeObserved: false }),
  };
}

export async function runLive(
  { plan, review, packageDir, cuaSocket, supervised },
  {
    spawnChild = spawn,
    signalSource = process,
    terminalStdout = process.stdout,
    terminalStderr = process.stderr,
    createLogStream = createWriteStream,
    setUserInterruptCleanupTimeout = setTimeout,
    clearUserInterruptCleanupTimeout = clearTimeout,
    userInterruptForceKillDelayMs = 5_000,
    userInterruptCloseObservationMs = 1_000,
  } = {},
) {
  const attemptDir = join(packageDir, "attempts", `live-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`);
  await mkdir(join(packageDir, "attempts"), { recursive: true });
  await mkdir(attemptDir, { recursive: false });
  const liveRecordPath = join(packageDir, "live-attempt.json");
  const argv = concreteArgv(plan, cuaSocket);
  const parseArgs = await loadCliParser();
  validateCliArgv(parseArgs, argv);
  const startedAt = new Date().toISOString();
  const record = buildLiveAttemptRecord({ plan, review, attemptDir, cuaSocket, supervised, startedAt, argv });
  await writeFile(liveRecordPath, jsonText(record), { encoding: "utf8", flag: "wx" });

  const stdoutLog = createLogStream(record.stdoutLog, { flags: "wx" });
  const stderrLog = createLogStream(record.stderrLog, { flags: "wx" });
  const started = Date.now();
  let timedOut = false;
  let sentSignal = null;
  let terminateTimer;
  let killTimer;
  let userInterruptCleanupTimer;
  let userInterruptKillTimer;
  let userInterruptCloseConfirmationTimer;
  let timeout;
  let spawnError;
  let child;
  let childCloseWatcher;
  let userInterruptSignalReceived = null;
  let userInterruptSignalCount = 0;
  let userInterruptCleanupTimedOut = false;
  const userInterruptForcedTerminationSignalsSent = [];
  let signalListenerInstalled = false;
  const scheduleCloseConfirmation = () => {
    if (userInterruptCloseConfirmationTimer !== undefined) return;
    userInterruptCloseConfirmationTimer = setTimeout(() => {
      userInterruptCloseConfirmationTimer = undefined;
      if (childCloseWatcher?.hasClosed()) return;
      childCloseWatcher?.resolveWithoutClose();
    }, userInterruptCloseObservationMs);
  };
  const onSigint = () => {
    userInterruptSignalReceived ??= "SIGINT";
    userInterruptSignalCount += 1;
    if (userInterruptSignalCount === 1) {
      terminalStdout.write("\nRunner received Ctrl+C; waiting for the CLI process to close.\n");
    }
    // The terminal delivers Ctrl+C to processes attached to its console. Do
    // not forward it with child.kill(): on Windows that API force-terminates
    // the child and skips its asynchronous Run cleanup path.
    if (!timedOut) {
      if (timeout !== undefined) clearTimeout(timeout);
      if (terminateTimer !== undefined) clearTimeout(terminateTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (userInterruptCleanupTimer === undefined && child !== undefined && !childCloseWatcher?.hasClosed()) {
        userInterruptCleanupTimer = setUserInterruptCleanupTimeout(() => {
          if (childCloseWatcher?.hasClosed()) return;
          if (child.exitCode !== null || child.signalCode !== null) {
            scheduleCloseConfirmation();
            return;
          }
          userInterruptCleanupTimedOut = true;
          userInterruptForcedTerminationSignalsSent.push("SIGTERM");
          child.kill("SIGTERM");
          userInterruptKillTimer = setTimeout(() => {
            if (childCloseWatcher?.hasClosed()) return;
            if (child.exitCode !== null || child.signalCode !== null) {
              scheduleCloseConfirmation();
              return;
            }
            userInterruptForcedTerminationSignalsSent.push("SIGKILL");
            child.kill("SIGKILL");
            // A kill request does not prove that the child or its stdio has
            // closed. Bound the wrapper wait and retain that uncertainty in
            // the final record; this does not release any environment lease.
            scheduleCloseConfirmation();
          }, userInterruptForceKillDelayMs);
        }, plan.configuration.cleanupDeadlineMs);
      }
    }
  };
  const childEnv = {
    ...process.env,
    DEEPSEEK_REQUEST_TIMEOUT_MS: "90000",
    DEEPSEEK_MAX_OUTPUT_TOKENS: "4096",
  };
  try {
    signalSource.on("SIGINT", onSigint);
    signalListenerInstalled = true;
    child = spawnChild(process.execPath, [plan.cli.entry, ...argv], {
      cwd: ROOT,
      shell: false,
      windowsHide: true,
      stdio: ["inherit", "pipe", "pipe"],
      env: childEnv,
    });
    tee(child.stdout, terminalStdout, stdoutLog);
    tee(child.stderr, terminalStderr, stderrLog);
    child.once("error", (error) => { spawnError = error; });
    childCloseWatcher = watchForClose(child);
    if (userInterruptSignalCount === 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        sentSignal = "SIGINT";
        child.kill("SIGINT");
        terminateTimer = setTimeout(() => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          sentSignal = "SIGTERM";
          child.kill("SIGTERM");
          killTimer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              sentSignal = "SIGKILL";
              child.kill("SIGKILL");
            }
          }, 5_000);
        }, plan.configuration.cleanupDeadlineMs);
      }, plan.configuration.runTimeoutMs);
    }
    const result = await childCloseWatcher.promise;
    if (userInterruptCleanupTimer !== undefined) {
      clearUserInterruptCleanupTimeout(userInterruptCleanupTimer);
      userInterruptCleanupTimer = undefined;
    }
    if (userInterruptKillTimer !== undefined) {
      clearTimeout(userInterruptKillTimer);
      userInterruptKillTimer = undefined;
    }
    if (userInterruptCloseConfirmationTimer !== undefined) {
      clearTimeout(userInterruptCloseConfirmationTimer);
      userInterruptCloseConfirmationTimer = undefined;
    }
    if (result.closeObserved === false) {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref?.();
    }
    if (timeout !== undefined) clearTimeout(timeout);
    if (terminateTimer !== undefined) clearTimeout(terminateTimer);
    if (killTimer !== undefined) clearTimeout(killTimer);
    await Promise.all([
      new Promise((resolve) => stdoutLog.end(resolve)),
      new Promise((resolve) => stderrLog.end(resolve)),
    ]);
    const final = {
      outcomeMode: plan.task.outcomeMode,
      endedAt: new Date().toISOString(),
      elapsedMs: Date.now() - started,
      exitCode: result.code,
      signal: result.signal,
      timedOut,
      terminationSignalSent: sentSignal,
      userInterruptSignalReceived,
      userInterruptSignalCount,
      userInterruptCleanupTimedOut,
      userInterruptForcedTerminationSignalsSent,
      childCloseObserved: result.closeObserved,
      spawnError: spawnError === undefined && result.spawnError === undefined ? null : {
        name: (spawnError ?? result.spawnError).name,
        code: (spawnError ?? result.spawnError).code ?? null,
        message: (spawnError ?? result.spawnError).message,
      },
      businessSuccess: "not inferred from process exit code; requires human evidence review",
      consumerReviewRequired: true,
      consumerReviewPath: join(packageDir, "review.json"),
    };
    record.final = final;
    await writeFile(liveRecordPath, jsonText(record), { encoding: "utf8" });
    terminalStdout.write(`\nRunner recorded one live attempt: ${liveRecordPath}\n`);
    return final;
  } catch (error) {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGINT");
    stdoutLog.destroy();
    stderrLog.destroy();
    const final = {
      outcomeMode: plan.task.outcomeMode,
      endedAt: new Date().toISOString(),
      elapsedMs: Date.now() - started,
      exitCode: null,
      signal: null,
      timedOut,
      terminationSignalSent: sentSignal,
      userInterruptSignalReceived,
      userInterruptSignalCount,
      userInterruptCleanupTimedOut,
      userInterruptForcedTerminationSignalsSent,
      childCloseObserved: childCloseWatcher?.hasClosed() ?? null,
      spawnError: error instanceof Error ? { name: error.name, code: error.code ?? null, message: error.message } : { message: String(error) },
      businessSuccess: "not inferred; requires human evidence review",
      consumerReviewRequired: true,
      consumerReviewPath: join(packageDir, "review.json"),
    };
    record.final = final;
    await writeFile(liveRecordPath, jsonText(record), { encoding: "utf8" });
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (terminateTimer !== undefined) clearTimeout(terminateTimer);
    if (killTimer !== undefined) clearTimeout(killTimer);
    if (userInterruptCleanupTimer !== undefined) clearUserInterruptCleanupTimeout(userInterruptCleanupTimer);
    if (userInterruptKillTimer !== undefined) clearTimeout(userInterruptKillTimer);
    if (userInterruptCloseConfirmationTimer !== undefined) clearTimeout(userInterruptCloseConfirmationTimer);
    if (signalListenerInstalled) signalSource.removeListener("SIGINT", onSigint);
  }
}

export async function runPackage(options, { root = ROOT, manifestPath = MANIFEST_PATH, confirm = promptExactConfirmation } = {}) {
  if (!isAbsolute(options["--package"])) throw new Error("--package must be an absolute prepared package path");
  const { absolutePackage, plan, review } = await loadAndVerifyPackage(options["--package"], { root, manifestPath });
  const live = options["--live"] === true;
  if (!live && (options["--confirm-desktop-control"] === true || options["--supervised"] === true)) {
    throw new Error("--confirm-desktop-control and --supervised require --live");
  }
  if (!live) {
    const cuaSocket = options["--cua-socket"] ?? "dry-run-cua-socket-placeholder";
    const argv = concreteArgv(plan, cuaSocket);
    validateCliArgv(await loadCliParser(), argv);
    const dryRunsDir = join(absolutePackage, "dry-runs");
    await mkdir(dryRunsDir, { recursive: true });
    const dryRunPath = join(dryRunsDir, `dry-run-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}.json`);
    const report = {
      at: new Date().toISOString(),
      outcomeMode: plan.task.outcomeMode,
      consumerReviewPath: join(absolutePackage, "review.json"),
      spawned: false,
      desktopAccess: false,
      modelAccess: false,
      networkAccess: false,
      envFileRead: false,
      cuaSocketPlaceholder: options["--cua-socket"] === undefined,
      argv,
    };
    await writeFile(dryRunPath, jsonText(report), { encoding: "utf8", flag: "wx" });
    printDryRun(plan, argv, options["--cua-socket"] === undefined);
    process.stdout.write(`Saved dry-run record: ${dryRunPath}\n`);
    return { mode: "dry-run", report };
  }

  if (options["--confirm-desktop-control"] !== true) throw new Error("--live requires --confirm-desktop-control");
  if (plan.configuration?.cuaDriver === null || plan.configuration?.cuaDriver === undefined) {
    throw new Error("live execution requires a plan frozen with a verified candidate CUA driver binary");
  }
  if (typeof options["--cua-socket"] !== "string" || options["--cua-socket"].trim().length === 0) {
    throw new Error("--live requires --cua-socket with the actual already-running CUA daemon socket; runner does not start/restart it");
  }
  const supervised = options["--supervised"] === true;
  assertLiveAuthorization(review, plan, supervised, options["--cua-socket"]);
  if (await pathExists(join(absolutePackage, "live-attempt.json"))) {
    throw new Error("this package already has a live attempt; prepare a new package for another attempt");
  }
  await confirm(plan);
  const final = await runLive({ plan, review, packageDir: absolutePackage, cuaSocket: options["--cua-socket"], supervised });
  return { mode: "live", final };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === "--help") {
    process.stdout.write("Usage: node scripts/life-eval/run.mjs --package <absolute-package> [--cua-socket <existing-socket>] [--live --confirm-desktop-control [--supervised]]\nDefault is dry-run; live runs one task only and require a human review.json preflight receipt plus typed terminal confirmation.\n");
    return;
  }
  const options = parseRunArgs(argv);
  const result = await runPackage(options);
  if (result.mode === "live") {
    process.stdout.write(`${JSON.stringify({ status: "one-live-attempt-recorded", ...result.final }, null, 2)}\n`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
