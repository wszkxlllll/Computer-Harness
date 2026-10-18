import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, realpath, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { SIX_DOMAIN_SUITE_ID, variantsForSuite } from "./common.mjs";

const POLICY_VERSION = "evidence-triggered-no-scripted-corrections-v1";
const PACKAGE_ID_PATTERN = /^[A-Za-z0-9._-]{1,160}$/u;
const ATTEMPT_ID_PATTERN = /^live-[A-Za-z0-9._-]{1,96}$/u;
const RUN_ID_PATTERN = /^run-[A-Za-z0-9._-]{1,128}$/u;
const COMMAND_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const COMMAND_TTL_MS = 30_000;
const MAX_CORRECTION_BYTES = 16_000;
const MAX_EVENT_READ_COUNT = 250;

export const SUPERVISION_HELP = `Usage: node scripts/life-eval/supervision.mjs <inspect|read|correct|cancel|receipt> --package <absolute-package>
inspect reports the current Run status (including running/finished), terminal flag, latest observation, and queued command IDs.
correct requires --run-id plus --evidence-sequence and --observation-id for a committed observation from that same Run; it is only the correction source and may not show the current screen.
A returned queued status means inbox acceptance, not consumption. Confirm consumption with receipt --command-id <id>; only status consumed records a user.input.received event.
Terminal Runs reject new corrections. read shows recent Runtime events and receipts; cancel requests a safety stop and is not a task correction.`;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function childPath(root, path) {
  const value = relative(root, path);
  return value.length > 0 && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function parseJsonLines(text) {
  const lines = text.split(/\r?\n/u);
  const hasFinalNewline = /(?:\r?\n)$/u.test(text);
  if (!hasFinalNewline) lines.pop();
  const values = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim().length === 0) continue;
    try {
      values.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`invalid JSONL record at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return values;
}

async function appendJsonLine(path, value) {
  await open(path, "a").then(async (handle) => {
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    } finally {
      await handle.close();
    }
  });
}

async function readJsonLines(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return parseJsonLines(text);
}

function readOutputBaseFromPlan(plan, packageDir) {
  const argv = plan.cli?.argvTemplate;
  if (!Array.isArray(argv)) throw new Error("frozen plan does not contain a CLI argv template");
  const index = argv.indexOf("--output");
  if (index < 0 || typeof argv[index + 1] !== "string" || !isAbsolute(argv[index + 1])) {
    throw new Error("frozen CLI argv must contain one absolute runtime --output directory");
  }
  const outputBase = resolve(argv[index + 1]);
  if (resolve(plan.packageDir) !== packageDir || resolve(outputBase) !== resolve(packageDir, "runtime-output")) {
    throw new Error("frozen runtime-output directory is not the package-owned runtime-output directory");
  }
  return outputBase;
}

export function validateSupervisionPlan(plan) {
  const supervision = plan?.configuration?.supervision;
  if (supervision === undefined) return undefined;
  if (plan.suiteId !== SIX_DOMAIN_SUITE_ID) throw new Error("supervision IPC is available only for the frozen six-domain evaluation suite");
  if (!isRecord(supervision) || (supervision.mode !== "observe" && supervision.mode !== "dynamic") || supervision.policyVersion !== POLICY_VERSION) {
    throw new Error("frozen supervision configuration has an unsupported mode or policyVersion");
  }
  if (plan.configuration.monitor !== "guidance") throw new Error("six-domain supervision requires the frozen Monitor guidance setting");
  const variants = variantsForSuite(plan.suiteId);
  const expected = variants[plan.selection?.variant];
  if (expected === undefined
      || expected.supervision?.mode !== supervision.mode
      || expected.supervision?.policyVersion !== supervision.policyVersion
      || plan.configuration.planning !== expected.planning
      || plan.configuration.memory !== expected.memory
      || plan.configuration.memoryRetrieval !== expected.retrieval) {
    throw new Error("frozen variant does not match its planning, memory, and supervision settings");
  }
  return { mode: supervision.mode, policyVersion: supervision.policyVersion };
}

function validateAttemptIdentity({ plan, packageDir, attemptDir, packageId, mode }) {
  const absolutePackage = resolve(packageDir);
  const attemptId = basename(resolve(attemptDir));
  if (!isAbsolute(packageDir) || resolve(plan.packageDir) !== absolutePackage || packageId !== plan.packageId || !PACKAGE_ID_PATTERN.test(packageId)) {
    throw new Error("supervision package identity does not match the frozen plan");
  }
  if (!ATTEMPT_ID_PATTERN.test(attemptId) || resolve(dirname(resolve(attemptDir))) !== resolve(absolutePackage, "attempts")) {
    throw new Error("supervision attempt path is outside this package's live attempts directory");
  }
  const selected = validateSupervisionPlan(plan);
  if (selected?.mode !== mode) throw new Error("supervision mode does not match the frozen package");
  return { packageId, attemptId, absolutePackage, outputBase: readOutputBaseFromPlan(plan, absolutePackage) };
}

function validateSnapshotMessage(message, identity, mode, prior) {
  if (!isRecord(message)
      || message.type !== "harness.supervision.snapshot"
      || message.packageId !== identity.packageId
      || message.attemptId !== identity.attemptId
      || message.mode !== mode
      || typeof message.runId !== "string"
      || !RUN_ID_PATTERN.test(message.runId)
      || typeof message.status !== "string"
      || !Number.isSafeInteger(message.currentSequence)
      || message.currentSequence < 0
      || !Number.isSafeInteger(message.evidenceSequence)
      || message.evidenceSequence < 0
      || typeof message.evidenceFresh !== "boolean"
      || typeof message.terminal !== "boolean"
      || typeof message.updatedAt !== "string"
      || !Number.isFinite(Date.parse(message.updatedAt))) {
    throw new Error("CLI sent an invalid supervision snapshot");
  }
  if (prior?.runId !== undefined && prior.runId !== message.runId) throw new Error("CLI changed the actual RunId within one evaluation attempt");
  if (prior?.currentSequence !== undefined && message.currentSequence < prior.currentSequence) throw new Error("CLI supervision event sequence moved backwards");
  if (prior?.evidenceSequence !== undefined && message.evidenceSequence < prior.evidenceSequence) throw new Error("CLI supervision evidence sequence moved backwards");
  const latestObservation = message.latestObservation;
  if (latestObservation !== undefined) {
    if (!isRecord(latestObservation)
        || typeof latestObservation.id !== "string"
        || !Number.isSafeInteger(latestObservation.sequence)
        || latestObservation.sequence < 1
        || typeof latestObservation.capturedAt !== "string"
        || !isRecord(latestObservation.screenshot)
        || typeof latestObservation.screenshot.assetId !== "string"
        || typeof latestObservation.screenshot.relativePath !== "string"
        || typeof latestObservation.screenshot.mediaType !== "string"
        || !Number.isSafeInteger(latestObservation.screenshot.byteLength)
        || latestObservation.screenshot.byteLength < 1) {
      throw new Error("CLI sent an invalid latest observation reference");
    }
    validateRelativeScreenshotPath(latestObservation.screenshot.relativePath);
  }
  return {
    schemaVersion: 1,
    packageId: identity.packageId,
    attemptId: identity.attemptId,
    mode,
    runId: message.runId,
    status: message.status,
    currentSequence: message.currentSequence,
    evidenceSequence: message.evidenceSequence,
    evidenceFresh: message.evidenceFresh,
    ...(latestObservation === undefined ? {} : { latestObservation }),
    ...(typeof message.pendingApprovalRequestId === "string" ? { pendingApprovalRequestId: message.pendingApprovalRequestId } : {}),
    ...(typeof message.pendingUserInputRequestId === "string" ? { pendingUserInputRequestId: message.pendingUserInputRequestId } : {}),
    terminal: message.terminal,
    updatedAt: message.updatedAt,
  };
}

function validateRelativeScreenshotPath(path) {
  if (path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/u.test(path)) throw new Error("screenshot reference must be package-relative");
  const parts = path.split("/");
  if (parts.length !== 2 || parts[0] !== "screenshots" || !/^[-A-Za-z0-9._]+\.(?:png|jpg)$/iu.test(parts[1] ?? "")) {
    throw new Error("screenshot reference is outside the Runtime assets namespace");
  }
  return path;
}

function validateReceiptMessage(message, identity, mode) {
  const allowed = new Set(["rejected", "expired", "queued", "consumed", "failed", "cancel-requested"]);
  if (!isRecord(message)
      || message.type !== "harness.supervision.receipt"
      || message.packageId !== identity.packageId
      || message.attemptId !== identity.attemptId
      || typeof message.commandId !== "string"
      || !COMMAND_ID_PATTERN.test(message.commandId)
      || typeof message.runId !== "string"
      || !RUN_ID_PATTERN.test(message.runId)
      || (message.command !== "correct" && message.command !== "cancel")
      || !allowed.has(message.status)
      || typeof message.reason !== "string"
      || typeof message.at !== "string"
      || !Number.isFinite(Date.parse(message.at))) {
    throw new Error("CLI sent an invalid supervision receipt");
  }
  if (mode === "observe" && message.command === "correct" && message.status !== "rejected") {
    throw new Error("observe-only supervision returned a non-rejected correction receipt");
  }
  return {
    schemaVersion: 1,
    packageId: identity.packageId,
    attemptId: identity.attemptId,
    runId: message.runId,
    commandId: message.commandId,
    command: message.command,
    status: message.status,
    reason: message.reason,
    at: message.at,
    ...(Number.isSafeInteger(message.eventSequence) ? { eventSequence: message.eventSequence } : {}),
  };
}

async function publishNewCommand(directory, commandId, content) {
  const temporaryPath = join(directory, `.pending-${commandId}.tmp`);
  const publishedPath = join(directory, `command-${commandId}.json`);
  const handle = await open(temporaryPath, "wx");
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
  try {
    await link(temporaryPath, publishedPath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
  return publishedPath;
}

export async function createSupervisionBridge({ plan, packageDir, attemptDir, mode, startedAt }) {
  const identity = validateAttemptIdentity({ plan, packageDir, attemptDir, packageId: plan.packageId, mode });
  const runtimeContext = { packageDir: identity.absolutePackage, outputBase: identity.outputBase };
  const statePath = join(attemptDir, "supervision-state.jsonl");
  const commandsDir = join(attemptDir, "supervision-commands");
  const receiptsPath = join(attemptDir, "supervision-receipts.jsonl");
  await mkdir(commandsDir, { recursive: true });
  const receiptsHandle = await open(receiptsPath, "wx");
  await receiptsHandle.close();
  let latestState;
  let initialized = false;
  let startSent = false;
  let readyResolve;
  let readyReject;
  let pumping = false;
  let childMessageChain = Promise.resolve();
  let appendChain = Promise.resolve();
  const seenCommandIds = new Set();
  const activeCorrectionIds = new Set();
  const pendingCommands = new Map();
  const readiness = new Promise((resolveReady, rejectReady) => {
    readyResolve = resolveReady;
    readyReject = rejectReady;
  });
  void readiness.catch(() => undefined);

  function appendRecord(path, value) {
    const next = appendChain.then(() => appendJsonLine(path, value));
    appendChain = next.catch(() => undefined);
    return next;
  }

  await appendRecord(statePath, {
    schemaVersion: 1,
    packageId: identity.packageId,
    attemptId: identity.attemptId,
    mode,
    runId: null,
    status: "starting",
    currentSequence: 0,
    evidenceSequence: 0,
    terminal: false,
    updatedAt: startedAt,
  });

  async function appendReceipt(receipt) {
    await appendRecord(receiptsPath, receipt);
    if (receipt.command === "correct" && receipt.commandId !== undefined && receipt.status !== "queued") {
      activeCorrectionIds.delete(receipt.commandId);
    }
  }

  function send(child, message) {
    return new Promise((resolveSend) => {
      if (typeof child?.send !== "function" || child.connected === false) {
        resolveSend({ sent: false, error: "child IPC is unavailable" });
        return;
      }
      try {
        child.send(message, undefined, undefined, (error) => {
          resolveSend(error ? { sent: false, error: error.message } : { sent: true });
        });
      } catch (error) {
        resolveSend({ sent: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  async function handleChildMessageOrdered(message, child) {
    if (!isRecord(message)) return false;
    if (message.type === "harness.supervision.listener-ready") {
      if (message.mode !== mode) {
        const error = new Error("CLI supervision listener mode does not match the frozen package");
        readyReject(error);
        throw error;
      }
      if (startSent) return true;
      startSent = true;
      const sent = await send(child, {
        type: "harness.supervision.start",
        packageId: identity.packageId,
        attemptId: identity.attemptId,
        mode,
      });
      if (!sent.sent) {
        startSent = false;
        const error = new Error(`could not start evaluation supervision IPC: ${sent.error}`);
        readyReject(error);
        throw error;
      }
      return true;
    }
    if (message.type === "harness.supervision.initialized") {
      if (message.packageId !== identity.packageId || message.attemptId !== identity.attemptId || message.mode !== mode) {
        const error = new Error("CLI initialized supervision for the wrong package, attempt, or mode");
        readyReject(error);
        throw error;
      }
      initialized = true;
      readyResolve();
      return true;
    }
    if (message.type === "harness.supervision.snapshot") {
      if (!initialized) throw new Error("CLI sent a supervision snapshot before completing the handshake");
      const state = validateSnapshotMessage(message, identity, mode, latestState);
      latestState = state;
      await appendRecord(statePath, state);
      return true;
    }
    if (message.type === "harness.supervision.receipt") {
      const receipt = validateReceiptMessage(message, identity, mode);
      const command = pendingCommands.get(receipt.commandId);
      if (command !== undefined && command.command !== receipt.command) throw new Error("CLI receipt command type does not match its queued command");
      await appendReceipt(receipt);
      if (receipt.status !== "queued") pendingCommands.delete(receipt.commandId);
      return true;
    }
    return false;
  }

  function handleChildMessage(message, child) {
    const next = childMessageChain.then(() => handleChildMessageOrdered(message, child));
    childMessageChain = next.catch(() => undefined);
    return next;
  }

  async function pumpCommands(child) {
    if (!initialized || pumping) return;
    pumping = true;
    try {
      const names = (await readdir(commandsDir)).filter((name) => /^command-[0-9a-f-]{36}\.json$/iu.test(name)).sort();
      const commands = [];
      for (const name of names) {
        const commandId = name.slice("command-".length, -".json".length);
        if (seenCommandIds.has(commandId)) continue;
        const path = join(commandsDir, name);
        let message;
        try {
          message = JSON.parse(await readFile(path, "utf8"));
        } catch (error) {
          await appendReceipt({ schemaVersion: 1, packageId: identity.packageId, attemptId: identity.attemptId, commandId, command: "unknown", status: "rejected", reason: `invalid command file: ${error instanceof Error ? error.message : String(error)}`, at: new Date().toISOString() });
          seenCommandIds.add(commandId);
          continue;
        }
        commands.push({ commandId, path, message });
      }
      const creationKey = (message) => isRecord(message) && typeof message.createdAt === "string" ? message.createdAt : "";
      commands.sort((left, right) => creationKey(left.message).localeCompare(creationKey(right.message)) || left.commandId.localeCompare(right.commandId));
      for (const { commandId, message } of commands) {
        seenCommandIds.add(commandId);
        const invalid = !isRecord(message)
          || message.schemaVersion !== 1
          || message.commandId !== commandId
          || message.packageId !== identity.packageId
          || message.attemptId !== identity.attemptId
          || !["correct", "cancel"].includes(message.command)
          || typeof message.runId !== "string"
          || !RUN_ID_PATTERN.test(message.runId)
          || typeof message.createdAt !== "string"
          || !Number.isFinite(Date.parse(message.createdAt))
          || typeof message.expiresAt !== "string"
          || !Number.isFinite(Date.parse(message.expiresAt));
        const reject = async (status, reason) => {
          await appendReceipt({
            schemaVersion: 1,
            packageId: identity.packageId,
            attemptId: identity.attemptId,
            runId: latestState?.runId ?? (isRecord(message) ? message.runId ?? null : null),
            commandId,
            command: isRecord(message) ? message.command ?? "unknown" : "unknown",
            status,
            reason,
            at: new Date().toISOString(),
          });
        };
        if (invalid) {
          await reject("rejected", "command identity or shape is invalid");
          continue;
        }
        if (latestState?.terminal === true || latestState?.status === "finished") {
          await reject("rejected", "run-terminal");
          continue;
        }
        if (latestState?.runId === undefined || latestState.runId === null || latestState.status === "starting" || latestState.status === "created") {
          await reject("rejected", "run-not-ready; no active Runtime controller yet");
          continue;
        }
        if (message.runId !== latestState.runId) {
          await reject("rejected", "run-identity-mismatch");
          continue;
        }
        if (Date.parse(message.expiresAt) <= Date.now()) {
          await reject("expired", "command expired before it reached the CLI inbox");
          continue;
        }
        if (message.command === "correct" && mode !== "dynamic") {
          await reject("rejected", "observe-only-run");
          continue;
        }
        if (message.command === "correct" && activeCorrectionIds.size > 0) {
          await reject("rejected", "another-correction-is-still-pending");
          continue;
        }
        if (message.command === "correct" && (latestState.status === "waiting_approval" || latestState.pendingApprovalRequestId !== undefined)) {
          await reject("rejected", "approval-pending; correction is not an approval response");
          continue;
        }
        if (message.command === "correct") {
          if (!Number.isSafeInteger(message.evidenceSequence) || message.evidenceSequence < 1
              || typeof message.observationId !== "string" || message.observationId.length === 0) {
            await reject("rejected", "correction-source-observation-reference-is-invalid");
            continue;
          }
          const source = await readRuntimeEvents(runtimeContext, latestState, message.evidenceSequence - 1, 1);
          const committedSourceObservation = source.events.some((event) =>
            event.sequence === message.evidenceSequence
              && event.runId === latestState.runId
              && event.type === "observation.created"
              && event.observation?.id === message.observationId);
          if (source.runtimeCurrentSequence < message.evidenceSequence || !committedSourceObservation) {
            await reject("rejected", "correction-source-observation-not-committed-in-this-run");
            continue;
          }
        }
        if (message.command === "correct") activeCorrectionIds.add(commandId);
        pendingCommands.set(commandId, message);
        const sent = await send(child, { ...message, type: "harness.supervision.command" });
        if (!sent.sent) {
          pendingCommands.delete(commandId);
          activeCorrectionIds.delete(commandId);
          await reject("failed", `could not send command to CLI IPC: ${sent.error}`);
        }
      }
    } finally {
      pumping = false;
    }
  }

  async function waitForReady(timeoutMs = 5_500) {
    let timer;
    try {
      await Promise.race([
        readiness,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("evaluation supervision listener handshake timed out; the Run was not allowed to start")), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function finalize({ terminalStatus = "child-closed", at = new Date().toISOString() } = {}) {
    while (pumping) await new Promise((resolveWait) => setTimeout(resolveWait, 0));
    await childMessageChain;
    await appendChain;
    if (latestState !== undefined) {
      latestState = { ...latestState, terminal: true, wrapperStatus: terminalStatus, updatedAt: at };
      await appendRecord(statePath, latestState);
    } else {
      await appendRecord(statePath, {
        schemaVersion: 1,
        packageId: identity.packageId,
        attemptId: identity.attemptId,
        mode,
        runId: null,
        status: "supervision-failed-before-run-start",
        currentSequence: 0,
        evidenceSequence: 0,
        terminal: true,
        wrapperStatus: terminalStatus,
        updatedAt: at,
      });
    }
    for (const [commandId, message] of pendingCommands) {
      await appendReceipt({
        schemaVersion: 1,
        packageId: identity.packageId,
        attemptId: identity.attemptId,
        runId: latestState?.runId ?? message.runId,
        commandId,
        command: message.command,
        status: "not-consumed",
        reason: "CLI closed before a user.input.received receipt arrived; command will not be replayed",
        at,
      });
    }
    const commandNames = (await readdir(commandsDir)).filter((name) => /^command-[0-9a-f-]{36}\.json$/iu.test(name));
    for (const name of commandNames) {
      const commandId = name.slice("command-".length, -".json".length);
      if (seenCommandIds.has(commandId)) continue;
      seenCommandIds.add(commandId);
      let command;
      try {
        command = JSON.parse(await readFile(join(commandsDir, name), "utf8"));
      } catch {
        command = undefined;
      }
      await appendReceipt({
        schemaVersion: 1,
        packageId: identity.packageId,
        attemptId: identity.attemptId,
        runId: latestState?.runId ?? (isRecord(command) ? command.runId ?? null : null),
        commandId,
        command: isRecord(command) ? command.command ?? "unknown" : "unknown",
        status: "not-consumed",
        reason: "CLI closed before command dispatch; this attempt will not replay it",
        at,
      });
    }
    await appendChain;
    pendingCommands.clear();
    activeCorrectionIds.clear();
    return { statePath, commandsDir, receiptsPath, runId: latestState?.runId ?? null };
  }

  return {
    identity,
    statePath,
    commandsDir,
    receiptsPath,
    outputBase: identity.outputBase,
    waitForReady,
    handleChildMessage,
    pumpCommands,
    finalize,
    get latestState() { return latestState; },
  };
}

async function loadPackageSupervision(packageDirInput) {
  if (typeof packageDirInput !== "string" || !isAbsolute(packageDirInput)) throw new Error("--package requires an absolute prepared package path");
  const packageDir = resolve(packageDirInput);
  const [planBytes, recordBytes] = await Promise.all([
    readFile(join(packageDir, "plan.json")),
    readFile(join(packageDir, "live-attempt.json")),
  ]);
  const plan = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(planBytes));
  const record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(recordBytes));
  const mode = validateSupervisionPlan(plan)?.mode;
  if (mode === undefined) throw new Error("this package does not have a frozen supervision configuration");
  if (record.packageId !== plan.packageId || record.supervision?.mode !== mode || record.supervision?.attemptId !== basename(dirname(record.stdoutLog ?? ""))) {
    throw new Error("live attempt identity does not match the frozen supervision package");
  }
  const attemptId = record.supervision.attemptId;
  if (!ATTEMPT_ID_PATTERN.test(attemptId) || typeof record.stdoutLog !== "string") throw new Error("live-attempt.json has no valid supervision attempt identity");
  const attemptDir = resolve(packageDir, "attempts", attemptId);
  const attemptsRoot = resolve(packageDir, "attempts");
  if (!childPath(attemptsRoot, attemptDir) || resolve(dirname(record.stdoutLog)) !== attemptDir) {
    throw new Error("live attempt directory is not the package-owned attempts directory");
  }
  const actualPackage = await realpath(packageDir);
  const actualAttempt = await realpath(attemptDir);
  if (!childPath(actualPackage, actualAttempt)) throw new Error("live attempt resolves outside the package directory");
  const outputBase = readOutputBaseFromPlan(plan, packageDir);
  return {
    packageDir,
    plan,
    record,
    mode,
    packageId: plan.packageId,
    attemptId,
    attemptDir,
    outputBase,
    statePath: join(attemptDir, "supervision-state.jsonl"),
    commandsDir: join(attemptDir, "supervision-commands"),
    receiptsPath: join(attemptDir, "supervision-receipts.jsonl"),
  };
}

async function latestState(context) {
  const states = await readJsonLines(context.statePath);
  return states.at(-1);
}

async function latestReceipt(context, commandId) {
  const receipts = await readJsonLines(context.receiptsPath);
  return receipts.filter((receipt) => receipt.commandId === commandId).at(-1);
}

async function validateScreenshotFile(context, state) {
  const observation = state?.latestObservation;
  if (observation === undefined) return null;
  const relativePath = validateRelativeScreenshotPath(observation.screenshot.relativePath);
  const runtimeDir = resolve(context.outputBase, state.runId);
  if (!childPath(context.outputBase, runtimeDir)) throw new Error("actual Run output directory escaped the frozen runtime-output root");
  const assetRoot = resolve(runtimeDir, "assets");
  const screenshotPath = resolve(assetRoot, ...relativePath.split("/"));
  if (!childPath(assetRoot, screenshotPath)) throw new Error("screenshot reference escaped the Run assets directory");
  const actualPackage = await realpath(context.packageDir);
  const actualOutputBase = await realpath(context.outputBase);
  const actualRuntimeDir = await realpath(runtimeDir);
  const [actualAssetRoot, actualScreenshot] = await Promise.all([realpath(assetRoot), realpath(screenshotPath)]);
  if (relative(actualPackage, actualOutputBase) !== "runtime-output"
      || relative(actualOutputBase, actualRuntimeDir) !== state.runId
      || relative(actualRuntimeDir, actualAssetRoot) !== "assets") {
    throw new Error("runtime output or assets directory resolves outside the exact package-owned Run path");
  }
  if (!childPath(actualAssetRoot, actualScreenshot)) throw new Error("screenshot asset resolves outside the Run assets directory");
  const metadata = await stat(actualScreenshot);
  if (!metadata.isFile() || metadata.size !== observation.screenshot.byteLength) throw new Error("latest screenshot asset is missing or its size does not match the committed reference");
  return actualScreenshot;
}

async function readRuntimeEvents(context, state, afterSequence = 0, limit = 100) {
  if (state?.runId === undefined || state.runId === null) {
    return { events: [], latestScreenshotPath: null, trajectoryPath: null, nextSequence: afterSequence, hasMore: false, runtimeCurrentSequence: -1 };
  }
  const runtimeDir = resolve(context.outputBase, state.runId);
  if (!childPath(context.outputBase, runtimeDir)) throw new Error("actual Run output directory escaped the frozen runtime-output root");
  const actualPackage = await realpath(context.packageDir);
  const actualOutputBase = await realpath(context.outputBase);
  const actualRuntimeDir = await realpath(runtimeDir);
  if (relative(actualPackage, actualOutputBase) !== "runtime-output" || relative(actualOutputBase, actualRuntimeDir) !== state.runId) {
    throw new Error("runtime trajectory directory resolves outside the exact package-owned Run path");
  }
  const lexicalTrajectoryPath = join(runtimeDir, "trajectory.jsonl");
  const trajectoryPath = await realpath(lexicalTrajectoryPath);
  if (relative(actualRuntimeDir, trajectoryPath) !== "trajectory.jsonl") throw new Error("trajectory file resolves outside the exact Run directory");
  const events = await readJsonLines(trajectoryPath);
  const available = events.filter((event) => Number.isSafeInteger(event.sequence) && event.sequence > afterSequence);
  const selected = available.slice(0, Math.min(limit, MAX_EVENT_READ_COUNT));
  const nextSequence = selected.at(-1)?.sequence ?? afterSequence;
  const latestObservation = state.latestObservation === undefined
    ? undefined
    : events.findLast((event) => event.type === "observation.created" && event.observation?.id === state.latestObservation.id);
  if (state.latestObservation !== undefined && (latestObservation === undefined
      || latestObservation.sequence !== state.latestObservation.sequence
      || latestObservation.observation?.screenshot?.assetId !== state.latestObservation.screenshot.assetId)) {
    throw new Error("latest snapshot does not match the committed Runtime observation");
  }
  const latestScreenshotPath = await validateScreenshotFile(context, state);
  return {
    events: selected,
    latestScreenshotPath,
    trajectoryPath,
    nextSequence,
    hasMore: available.length > selected.length,
    runtimeCurrentSequence: events.at(-1)?.sequence ?? -1,
  };
}

export async function inspectSupervision(packageDir) {
  const context = await loadPackageSupervision(packageDir);
  const state = await latestState(context);
  const receipts = await readJsonLines(context.receiptsPath);
  const lastReceiptByCommand = new Map();
  for (const receipt of receipts) lastReceiptByCommand.set(receipt.commandId, receipt);
  const pending = [...lastReceiptByCommand.values()].filter((receipt) => receipt.status === "queued").map((receipt) => receipt.commandId);
  return {
    packageId: context.packageId,
    attemptId: context.attemptId,
    mode: context.mode,
    runId: state?.runId ?? null,
    status: state?.status ?? "not-started",
    currentSequence: state?.currentSequence ?? 0,
    evidenceSequence: state?.evidenceSequence ?? 0,
    evidenceFresh: state?.evidenceFresh ?? false,
    latestObservation: state?.latestObservation ?? null,
    pendingApprovalRequestId: state?.pendingApprovalRequestId ?? null,
    terminal: state?.terminal ?? false,
    activeQueuedCommandIds: pending,
    updatedAt: state?.updatedAt ?? null,
  };
}

export async function readSupervision(packageDir, { afterSequence = -1, limit = 100 } = {}) {
  if (!Number.isSafeInteger(afterSequence) || afterSequence < -1) throw new Error("--after-sequence must be -1 or a non-negative integer");
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer");
  const context = await loadPackageSupervision(packageDir);
  const state = await latestState(context);
  const runtime = await readRuntimeEvents(context, state, afterSequence, limit);
  const receipts = await readJsonLines(context.receiptsPath);
  return {
    packageId: context.packageId,
    attemptId: context.attemptId,
    mode: context.mode,
    state: state ?? null,
    latestScreenshotPath: runtime.latestScreenshotPath,
    trajectoryPath: runtime.trajectoryPath,
    events: runtime.events,
    cursor: {
      requestedAfterSequence: afterSequence,
      nextSequence: runtime.nextSequence,
      hasMore: runtime.hasMore,
      runtimeCurrentSequence: runtime.runtimeCurrentSequence,
      controlSnapshotCurrentSequence: state?.currentSequence ?? 0,
    },
    receipts: receipts.slice(-100),
  };
}

async function loadCorrectionText(path) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("--text-file requires an absolute UTF-8 file path");
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_CORRECTION_BYTES) throw new Error(`correction text exceeds ${MAX_CORRECTION_BYTES} UTF-8 bytes`);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/u, "").replace(/\r\n/gu, "\n");
  if (text.trim().length === 0) throw new Error("correction text file is empty");
  if ([...text].length > 4_000 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text)) throw new Error("correction text is too long or contains disallowed control bytes");
  return text;
}

export async function submitSupervisionCommand(packageDir, { command, runId, evidenceSequence, observationId, textFile, waitMs = 2_000 } = {}) {
  if (command !== "correct" && command !== "cancel") throw new Error("command must be correct or cancel");
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 10_000) throw new Error("--wait-ms must be between 0 and 10000");
  const context = await loadPackageSupervision(packageDir);
  const state = await latestState(context);
  if (state === undefined || state.runId === null) throw new Error("Run has not published its actual RunId yet");
  if (runId !== state.runId) throw new Error("--run-id must exactly match the current inspect result");
  if (state.terminal || state.status === "finished") throw new Error("Run is terminal; commands cannot be submitted");
  if (command === "correct") {
    if (context.mode !== "dynamic") throw new Error("observe-only package does not accept task corrections");
    if (state.status === "waiting_approval" || state.pendingApprovalRequestId !== undefined) throw new Error("approval is pending; correct is not an approval answer");
    if (state.status !== "running" && state.status !== "paused" && state.status !== "waiting_user") throw new Error(`Run status '${state.status}' does not accept a correction`);
    if (!Number.isSafeInteger(evidenceSequence) || evidenceSequence < 1 || typeof observationId !== "string" || observationId.length === 0) {
      throw new Error("--evidence-sequence and --observation-id must identify a committed observation used as the correction source");
    }
    const source = await readRuntimeEvents({ packageDir: context.packageDir, outputBase: context.outputBase }, state, evidenceSequence - 1, 1);
    const committedSourceObservation = source.events.some((event) =>
      event.sequence === evidenceSequence
        && event.runId === state.runId
        && event.type === "observation.created"
        && event.observation?.id === observationId);
    if (source.runtimeCurrentSequence < evidenceSequence || !committedSourceObservation) {
      throw new Error("--evidence-sequence and --observation-id must identify the same committed observation in this Run");
    }
  }
  const receipts = await readJsonLines(context.receiptsPath);
  const lastReceiptByCommand = new Map();
  for (const receipt of receipts) lastReceiptByCommand.set(receipt.commandId, receipt);
  if (command === "correct" && [...lastReceiptByCommand.values()].some((receipt) => receipt.command === "correct" && receipt.status === "queued")) {
    throw new Error("a correction is already queued in the real Run inbox");
  }
  const text = command === "correct" ? await loadCorrectionText(textFile) : undefined;
  const commandId = randomUUID();
  const createdAt = new Date();
  const message = {
    schemaVersion: 1,
    commandId,
    packageId: context.packageId,
    attemptId: context.attemptId,
    runId: state.runId,
    command,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + COMMAND_TTL_MS).toISOString(),
    ...(command === "correct" ? { evidenceSequence, observationId, text } : {}),
  };
  await mkdir(context.commandsDir, { recursive: true });
  const commandPath = await publishNewCommand(context.commandsDir, commandId, `${JSON.stringify(message)}\n`);
  const deadline = Date.now() + waitMs;
  let receipt;
  while (Date.now() < deadline) {
    receipt = await latestReceipt(context, commandId);
    if (receipt !== undefined) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(100, Math.max(1, deadline - Date.now()))));
  }
  return {
    commandId,
    command,
    status: receipt?.status ?? "submitted-to-evaluation-queue",
    receipt: receipt ?? null,
    note: receipt?.status === "queued"
      ? `queued in the Runtime inbox; observation ${evidenceSequence} is only the correction source and may not show the current screen; check the receipt later for user.input.received consumption`
      : command === "cancel" ? "safety stop request; not counted as a task correction" : `observation ${evidenceSequence} is only the correction source and may not show the current screen; command expires before CLI dispatch if it is not accepted promptly`,
    commandPath,
  };
}

export async function readSupervisionReceipt(packageDir, commandId) {
  if (typeof commandId !== "string" || !COMMAND_ID_PATTERN.test(commandId)) throw new Error("--command-id must be a UUID returned by correct or cancel");
  const context = await loadPackageSupervision(packageDir);
  const receipt = await latestReceipt(context, commandId);
  if (receipt !== undefined) return receipt;
  const commandPath = join(context.commandsDir, `command-${commandId}.json`);
  try {
    const command = JSON.parse(await readFile(commandPath, "utf8"));
    const expired = typeof command.expiresAt === "string" && Date.parse(command.expiresAt) <= Date.now();
    return { commandId, command: command.command, status: expired ? "expired-before-dispatch" : "pending-dispatch", expiresAt: command.expiresAt };
  } catch (error) {
    if (error?.code === "ENOENT") return { commandId, status: "not-found-or-not-yet-written" };
    throw error;
  }
}

function parseHelperArgs(argv) {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h") return { help: true };
  if (!["inspect", "read", "correct", "cancel", "receipt"].includes(command)) throw new Error(SUPERVISION_HELP);
  const valueFlags = new Set(["--package", "--after-sequence", "--limit", "--run-id", "--evidence-sequence", "--observation-id", "--text-file", "--wait-ms", "--command-id"]);
  const values = new Map();
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (!valueFlags.has(flag)) throw new Error(`unsupported supervision option: ${flag}`);
    if (values.has(flag)) throw new Error(`${flag} may be provided once`);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    values.set(flag, value);
    index += 1;
  }
  if (!values.has("--package")) throw new Error("--package is required");
  return { command, values };
}

function positiveIntegerValue(values, flag, fallback) {
  const raw = values.get(flag);
  if (raw === undefined) return fallback;
  const number = Number(raw);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${flag} must be a non-negative integer`);
  return number;
}

function sequenceValue(values, flag, fallback = -1) {
  const raw = values.get(flag);
  if (raw === undefined) return fallback;
  const number = Number(raw);
  if (!Number.isSafeInteger(number) || number < -1) throw new Error(`${flag} must be -1 or a non-negative integer`);
  return number;
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseHelperArgs(argv);
  if (parsed.help) {
    process.stdout.write(`${SUPERVISION_HELP}\n`);
    return;
  }
  const { command, values } = parsed;
  const packageDir = values.get("--package");
  let result;
  if (command === "inspect") {
    result = await inspectSupervision(packageDir);
  } else if (command === "read") {
    result = await readSupervision(packageDir, {
      afterSequence: sequenceValue(values, "--after-sequence"),
      limit: positiveIntegerValue(values, "--limit", 100),
    });
  } else if (command === "receipt") {
    result = await readSupervisionReceipt(packageDir, values.get("--command-id"));
  } else {
    result = await submitSupervisionCommand(packageDir, {
      command,
      runId: values.get("--run-id"),
      evidenceSequence: positiveIntegerValue(values, "--evidence-sequence", -1),
      observationId: values.get("--observation-id"),
      textFile: values.get("--text-file"),
      waitMs: positiveIntegerValue(values, "--wait-ms", 2_000),
    });
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
