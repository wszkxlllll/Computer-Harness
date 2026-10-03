#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { mkdir, lstat, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CONFIG_PATH = resolve(REPO_ROOT, ".harness.local.psd1");
const TASK_CARD_PATH = resolve(REPO_ROOT, "docs/cross-window-life-task-cards-2026-10-02.md");
const EVIDENCE_ROOT = resolve(REPO_ROOT, "runs/cross-window-life-task");
const TASK_ID = "CW01";
const OUTPUT_FILE = "E:\\MyDesktop\\output\\CW01-活动备忘录.txt";
const POLICY_VERSION = "scripts/cross-window/life-task-policy.mjs";
const MAX_TEXT_INPUT = 4_000;
let activeSigintHandler;

export class Cw01RunnerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "Cw01RunnerError";
    this.code = code;
  }
}

export function parseRunnerArgs(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) return { mode: "help" };
  if (argv.length === 1 && argv[0] === "--self-test") return { mode: "self-test" };
  const accepted = new Set(["--live", "--root-go-after-review"]);
  const flags = new Set();
  for (const arg of argv) {
    if (!accepted.has(arg)) throw new Cw01RunnerError("UNKNOWN_ARGUMENT", "Unknown runner argument.");
    if (flags.has(arg)) throw new Cw01RunnerError("DUPLICATE_ARGUMENT", "Runner flags may be supplied only once.");
    flags.add(arg);
  }
  if (!flags.has("--live")) throw new Cw01RunnerError("LIVE_MODE_GATED", "No SDK, recording, or computer action is permitted without --live.");
  if (!flags.has("--root-go-after-review")) throw new Cw01RunnerError("ROOT_GO_REQUIRED", "Live CW01 requires explicit root GO after the code and recorder review.");
  return { mode: "live" };
}

export function selectCw01Targets(windows) {
  if (!Array.isArray(windows)) throw new Cw01RunnerError("WINDOW_INVENTORY_INVALID", "Fresh CUA window inventory was invalid.");
  const wps = windows.filter((window) => isPositiveTarget(window) && isCw01Wps(window));
  const notepads = windows.filter((window) => isPositiveTarget(window) && isNotepad(window));
  if (wps.length !== 1 || notepads.length !== 1) {
    throw new Cw01RunnerError("FIXTURE_TARGET_MISMATCH", "Fresh inventory must contain exactly one CW01 WPS window and one Notepad window.");
  }
  const wpsTarget = projectTarget(wps[0]);
  const notepadTarget = projectTarget(notepads[0]);
  if (sameTarget(wpsTarget, notepadTarget)) throw new Cw01RunnerError("DUPLICATE_FIXTURE_TARGET", "WPS and Notepad must be distinct host windows.");
  return { wps: wpsTarget, notepad: notepadTarget };
}

export function selectCw01TargetsFromInventories(onScreenWindows, openedWindows) {
  if (!Array.isArray(onScreenWindows)) throw new Cw01RunnerError("WINDOW_INVENTORY_INVALID", "Fresh on-screen CUA window inventory was invalid.");
  const selected = selectCw01Targets(openedWindows);
  if (!onScreenWindows.some((window) => isPositiveTarget(window) && sameTarget(projectTarget(window), selected.wps))) {
    throw new Cw01RunnerError("INITIAL_WPS_NOT_ON_SCREEN", "The initial CW01 WPS target is not in the fresh on-screen inventory.");
  }
  return selected;
}

export function parseHostCommand(line) {
  let value;
  try { value = JSON.parse(line); } catch { throw new Cw01RunnerError("INVALID_STDIN_JSON", "Expected one JSON command per input line."); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Cw01RunnerError("INVALID_STDIN_COMMAND", "Host input must be a JSON object.");
  if (value.kind === "input") {
    if (typeof value.requestId !== "string" || value.requestId.length === 0 || typeof value.text !== "string" || value.text.trim().length === 0 || value.text.length > MAX_TEXT_INPUT) {
      throw new Cw01RunnerError("INVALID_STDIN_INPUT", "Input needs the current requestId and 1-4000 characters.");
    }
    return { kind: "input", requestId: value.requestId, text: value.text };
  }
  if (value.kind === "approval") {
    if (typeof value.requestId !== "string" || value.requestId.length === 0 || typeof value.approved !== "boolean") {
      throw new Cw01RunnerError("INVALID_STDIN_APPROVAL", "Approval needs the current requestId and a boolean approved value.");
    }
    return { kind: "approval", requestId: value.requestId, approved: value.approved };
  }
  if (value.kind === "handoff") {
    if (typeof value.sourceActionId !== "string" || value.sourceActionId.length === 0 || !Number.isSafeInteger(value.candidateIndex) || value.candidateIndex < 0) {
      throw new Cw01RunnerError("INVALID_STDIN_HANDOFF", "Handoff needs the current sourceActionId and a listed candidateIndex.");
    }
    return { kind: "handoff", sourceActionId: value.sourceActionId, candidateIndex: value.candidateIndex };
  }
  if (value.kind === "cancel") return { kind: "cancel" };
  throw new Cw01RunnerError("INVALID_STDIN_COMMAND", "Supported commands are input, approval, handoff, and cancel.");
}

export function safeHandoffCandidates(candidates, allowedTargets) {
  if (!Array.isArray(candidates)) throw new Cw01RunnerError("HANDOFF_INVENTORY_INVALID", "The CUA picker returned an invalid candidate list.");
  return candidates.flatMap((candidate) => {
    const target = projectTarget(candidate);
    const label = allowedTargets.find((item) => sameTarget(item.target, target))?.label;
    return label === undefined ? [] : [{ candidate, label }];
  });
}

export function extractCw01Goal(documentText, outputFile = OUTPUT_FILE) {
  if (typeof documentText !== "string") throw new Cw01RunnerError("TASK_CARD_INVALID", "CW01 task card was not UTF-8 text.");
  const start = documentText.search(/^## CW01\b/mu);
  const nextTask = start < 0 ? -1 : documentText.indexOf("\n## CW02", start + 1);
  const taskSection = start < 0 ? undefined : documentText.slice(start, nextTask < 0 ? documentText.length : nextTask);
  const goal = /### 完整 Goal\s*```text\r?\n([\s\S]*?)\r?\n```/u.exec(taskSection ?? "")?.[1];
  if (goal === undefined || !goal.includes("我指定的测试输出文件夹")) {
    throw new Cw01RunnerError("TASK_CARD_GOAL_MISSING", "Could not find the exact CW01 goal in the task card.");
  }
  return goal.replace("我指定的测试输出文件夹", outputFile);
}

function isPositiveTarget(window) {
  return window !== null && typeof window === "object" && Number.isSafeInteger(window.pid) && window.pid > 0 && Number.isSafeInteger(window.windowId) && window.windowId > 0;
}

function isCw01Wps(window) {
  const appName = String(window.appName ?? "");
  const title = String(window.title ?? "");
  return title.includes("CW01-社区通知") && (/wps/i.test(appName) || /wps/i.test(title));
}

function isNotepad(window) {
  const rawAppName = String(window.appName ?? "").trim();
  if (rawAppName.length > 0) {
    const appName = win32.basename(rawAppName).replace(/\.exe$/iu, "").trim().toLowerCase();
    return appName === "notepad" || appName === "windows notepad" || appName === "记事本";
  }
  const title = String(window.title ?? "");
  return /(?:^|[\s—-])notepad(?:$|[\s—-])/iu.test(title) || /记事本/u.test(title);
}

function projectTarget(window) {
  if (!isPositiveTarget(window)) throw new Cw01RunnerError("WINDOW_TARGET_INVALID", "Window identity must contain positive safe PID and HWND integers.");
  return { pid: window.pid, windowId: window.windowId };
}

function sameTarget(left, right) {
  return left?.pid === right?.pid && left?.windowId === right?.windowId;
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) throw new Cw01RunnerError("LOCAL_CONFIG_MISSING", `Local ${name} is required.`);
  return value.trim();
}

function readLocalSetting(text, name) {
  const match = new RegExp(`^\\s*${name}\\s*=\\s*'([^']*)'\\s*$`, "mu").exec(text);
  return match?.[1] ?? "";
}

async function loadLocalConfig() {
  const text = await readFile(CONFIG_PATH, "utf8");
  const nodePath = requireString(readLocalSetting(text, "NodePath"), "NodePath");
  const envFileSetting = requireString(readLocalSetting(text, "EnvFile"), "EnvFile");
  const socketPath = requireString(readLocalSetting(text, "CuaSocket"), "CuaSocket");
  const envFile = resolve(REPO_ROOT, envFileSetting);
  const configuredNode = resolve(REPO_ROOT, nodePath);
  const [configuredReal, actualReal] = await Promise.all([realpath(configuredNode), realpath(process.execPath)]);
  if ((process.platform === "win32" ? configuredReal.toLowerCase() : configuredReal) !== (process.platform === "win32" ? actualReal.toLowerCase() : actualReal)) {
    throw new Cw01RunnerError("NODE_PATH_MISMATCH", "Runner must use the configured Node executable.");
  }
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Cw01RunnerError("NODE_VERSION_UNSUPPORTED", "Runner requires Node 22.13 or newer.");
  return { socketPath, envFile };
}

async function loadConfiguredCredentials(envFile) {
  const text = await readFile(envFile, "utf8");
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/gu, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
  const key = process.env.ZHIPUAI_API_KEY ?? process.env.ZHIPU_API_KEY ?? process.env.GLM_API_KEY;
  if (typeof key !== "string" || key.trim().length === 0) throw new Cw01RunnerError("GLM_CREDENTIAL_MISSING", "No GLM credential is available in the configured environment file.");
  return { glmApiKey: key };
}

async function requireNewOutputTarget() {
  if (process.platform !== "win32" || !win32.isAbsolute(OUTPUT_FILE) || !isAbsolute(OUTPUT_FILE)) {
    throw new Cw01RunnerError("OUTPUT_PATH_INVALID", "The authorized CW01 output path must be an absolute Windows path.");
  }
  let parent;
  try { parent = await stat(dirname(OUTPUT_FILE)); } catch { throw new Cw01RunnerError("OUTPUT_DIRECTORY_MISSING", "The user-designated CW01 output directory is unavailable."); }
  if (!parent.isDirectory()) throw new Cw01RunnerError("OUTPUT_DIRECTORY_INVALID", "The user-designated CW01 output path is not a directory.");
  try {
    await lstat(OUTPUT_FILE);
    throw new Cw01RunnerError("OUTPUT_EXISTS", "Refusing to overwrite an existing CW01 output file.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function createRunRoot() {
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  return resolve(EVIDENCE_ROOT, `CW01-${stamp}-${randomUUID().slice(0, 8)}`);
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function sanitizeCode(error) {
  if (typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/u.test(error.code)) return error.code;
  return "UNCLASSIFIED_FAILURE";
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function waitForHostInput(controller, allowedTargets, interventions) {
  const reader = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  const controllerAbort = new AbortController();
  let pendingCandidates = [];
  let currentWindowRequest = "";
  let lastStatusKey = "";
  let stopMonitoring = false;
  const commandQueue = [];
  let wakeQueue;
  const wake = () => { wakeQueue?.(); wakeQueue = undefined; };
  reader.on("line", (line) => {
    try { commandQueue.push(parseHostCommand(line)); }
    catch (error) { emit({ event: "stdin_rejected", code: sanitizeCode(error) }); }
    wake();
  });

  const statusLoop = (async () => {
    while (!stopMonitoring) {
      const snapshot = controller.getSnapshot();
      const pendingId = snapshot.pendingApproval?.requestId ?? snapshot.pendingUserInputRequestId ?? snapshot.pendingWindowHandoff?.sourceActionId ?? "";
      const statusKey = `${snapshot.status}:${pendingId}`;
      if (statusKey !== lastStatusKey) {
        lastStatusKey = statusKey;
        if (snapshot.status === "waiting_user") {
          emit({ event: "waiting_user", requestId: snapshot.pendingUserInputRequestId, question: bounded(snapshot.pendingUserQuestion, 1_200) });
        } else if (snapshot.status === "waiting_approval") {
          emit({ event: "waiting_approval", requestId: snapshot.pendingApproval?.requestId, reason: bounded(snapshot.pendingApproval?.reason, 1_200), decisionRequired: true });
        } else if (snapshot.status === "waiting_window" && snapshot.pendingWindowHandoff !== undefined) {
          const sourceActionId = snapshot.pendingWindowHandoff.sourceActionId;
          emit({ event: "waiting_window", sourceActionId, reasonCode: snapshot.pendingWindowHandoff.reasonCode, discovery: "pending" });
          try {
            pendingCandidates = safeHandoffCandidates(
              await controller.listWindowHandoffCandidates(controllerAbort.signal),
              allowedTargets,
            );
            currentWindowRequest = sourceActionId;
            emit({
              event: "window_candidates",
              sourceActionId,
              candidates: pendingCandidates.map((item, candidateIndex) => ({ candidateIndex, label: item.label })),
              note: "Only the two exact pre-authorized task windows can be selected.",
            });
          } catch (error) {
            currentWindowRequest = sourceActionId;
            pendingCandidates = [];
            emit({ event: "window_handoff_unavailable", sourceActionId, code: sanitizeCode(error), action: "stopping_without_scope_expansion" });
            try { controller.cancel("explicit task window scope cannot authorize this handoff"); } catch { /* terminal race */ }
          }
        } else if (snapshot.status === "finished") {
          emit({ event: "finished", outcome: snapshot.outcome, stepCount: snapshot.stepCount, modelRequestCount: snapshot.modelRequestCount });
        } else {
          emit({ event: "status", status: snapshot.status, stepCount: snapshot.stepCount, modelRequestCount: snapshot.modelRequestCount });
        }
      }

      const command = commandQueue.shift();
      if (command !== undefined) {
        try {
          const current = controller.getSnapshot();
          if (command.kind === "cancel") {
            if (current.status !== "finished") controller.cancel("explicit host cancellation");
            interventions.push({ kind: "cancel", at: new Date().toISOString() });
          } else if (command.kind === "input") {
            if (current.status !== "waiting_user" || current.pendingUserInputRequestId !== command.requestId) {
              throw new Cw01RunnerError("STALE_USER_INPUT", "Input does not match the current waiting request.");
            }
            await controller.submitUserInput(command.text, command.requestId);
            interventions.push({ kind: "user_input", requestId: command.requestId, textLength: command.text.length, textSha256: sha256(command.text), at: new Date().toISOString() });
          } else if (command.kind === "approval") {
            if (current.status !== "waiting_approval" || current.pendingApproval?.requestId !== command.requestId) {
              throw new Cw01RunnerError("STALE_APPROVAL", "Approval does not match the current pending request.");
            }
            await controller.resolveApproval(command.requestId, command.approved);
            interventions.push({ kind: "approval", requestId: command.requestId, approved: command.approved, at: new Date().toISOString() });
          } else if (command.kind === "handoff") {
            if (current.status !== "waiting_window" || current.pendingWindowHandoff?.sourceActionId !== command.sourceActionId || command.sourceActionId !== currentWindowRequest) {
              throw new Cw01RunnerError("STALE_WINDOW_HANDOFF", "Handoff does not match the current picker request.");
            }
            const selected = pendingCandidates[command.candidateIndex];
            if (selected === undefined || !allowedTargets.some((item) => sameTarget(item.target, projectTarget(selected.candidate)))) {
              throw new Cw01RunnerError("WINDOW_TARGET_NOT_ALLOWED", "Only a freshly listed exact task target can be selected.");
            }
            await controller.handoffWindow(selected.candidate, command.sourceActionId);
            interventions.push({ kind: "window_handoff", sourceActionId: command.sourceActionId, label: selected.label, at: new Date().toISOString() });
          }
          emit({ event: "stdin_command_applied", kind: command.kind });
        } catch (error) {
          emit({ event: "stdin_command_rejected", kind: command.kind, code: sanitizeCode(error) });
        }
      }
      if (controller.getSnapshot().status === "finished") break;
      await new Promise((resolveWake) => {
        const timer = setTimeout(resolveWake, 200);
        wakeQueue = () => { clearTimeout(timer); resolveWake(); };
      });
    }
  })();

  return {
    async stop() {
      stopMonitoring = true;
      controllerAbort.abort();
      reader.close();
      wake();
      await statusLoop;
    },
  };
}

function bounded(text, maxLength) {
  if (typeof text !== "string") return undefined;
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

async function runLive() {
  const local = await loadLocalConfig();
  const credentials = await loadConfiguredCredentials(local.envFile);
  await requireNewOutputTarget();
  const taskCard = await readFile(TASK_CARD_PATH, "utf8");
  const goal = extractCw01Goal(taskCard);
  if (goal.includes("\uFFFD") || /\?{3,}/u.test(goal)) throw new Cw01RunnerError("TASK_CARD_ENCODING_INVALID", "CW01 task card failed UTF-8 read-back validation.");

  const runRoot = createRunRoot();
  await mkdir(EVIDENCE_ROOT, { recursive: true });
  await mkdir(runRoot, { recursive: false });
  const appRuntime = await import(pathToFileURL(resolve(REPO_ROOT, "packages/app-runtime/dist/index.js")).href);
  const computerConfig = {
    kind: "cua",
    socketPath: local.socketPath,
    screenshotDir: join(runRoot, "screenshots"),
    windowDeliveryMode: "foreground",
    windowSwitch: "opened-windows-v1",
    grounding: "uia-catalog-v1",
  };
  const environmentIdentity = appRuntime.environmentIdentityForConfig(computerConfig);
  if (appRuntime.defaultEnvironmentOwner.inspect(environmentIdentity) !== undefined) {
    throw new Cw01RunnerError("DESKTOP_OWNER_OCCUPIED", "The production shared desktop owner is active or pending cleanup; no Run was started.");
  }
  const discovery = appRuntime.createWindowTargetDiscovery(computerConfig);
  if (discovery === undefined) throw new Cw01RunnerError("CUA_DISCOVERY_UNAVAILABLE", "The local CUA window discovery service is unavailable.");
  const visibleWindows = await discovery.listWindows(new AbortController().signal);
  if (typeof discovery.listAllWindows !== "function") throw new Cw01RunnerError("CUA_FULL_INVENTORY_UNAVAILABLE", "The host could not verify the explicitly prepared second task window.");
  const openedWindows = await discovery.listAllWindows(new AbortController().signal);
  const selected = selectCw01TargetsFromInventories(visibleWindows, openedWindows);
  const allowedTargets = [
    { target: selected.wps, label: "WPS CW01 synthetic notice" },
    { target: selected.notepad, label: "blank Notepad fixture" },
  ];
  emit({ event: "preflight_passed", taskId: TASK_ID, initialTargetSelection: "host_unique_CW01_title_match", matchedWps: true, matchedNotepad: true, onScreenWindowCount: visibleWindows.length, openedWindowCount: openedWindows.length, scopeTargetCount: allowedTargets.length, requestLimit: 100, stepLimit: 100 });

  const recordingPath = join(runRoot, "cw01-desktop.mp4");
  const policyModule = await import("./life-task-policy.mjs");
  if (typeof policyModule.createCrossWindowLifeTaskPolicy !== "function") {
    throw new Cw01RunnerError("TASK_POLICY_UNAVAILABLE", "The reviewed CW task policy export is unavailable.");
  }
  const runComputer = {
    ...computerConfig,
    windowTarget: selected.wps,
    windowSwitchAllowedTargets: [selected.wps, selected.notepad],
  };
  const session = new appRuntime.ApplicationSession({
    config: {
      model: "glm-5.3-flash",
      computer: runComputer,
      outputDir: runRoot,
      maxSteps: 100,
      maxModelRequests: 100,
      planning: true,
      memory: "entities",
      memoryRetrieval: "lexical",
      batching: "same-control-input-v1",
      contextMode: "recent",
      contextMaxHistoryEvents: 80,
      riskProfile: "live-interactive",
      riskGuard: "off",
      riskModel: "off",
      riskMaxModelRequests: 20,
      riskTimeoutMs: 30_000,
      cleanupDeadlineMs: 20_000,
      grounding: "uia-catalog-v1",
      windowSwitch: "opened-windows-v1",
      windowHandoff: "confirm-v1",
      monitor: "guidance",
      glmThinking: "enabled",
    },
    windowDiscovery: discovery,
    dependencies: {
      credentials,
      createPolicy: (resolvedConfig) => policyModule.createCrossWindowLifeTaskPolicy(resolvedConfig, { outputFilePaths: [OUTPUT_FILE] }),
    },
  });

  if (session.inspectEnvironment() !== undefined) {
    throw new Cw01RunnerError("DESKTOP_OWNER_OCCUPIED", "The production shared desktop owner changed during preflight; no Run was started.");
  }
  let recorder;
  let recordingAttempted = false;
  let handle;
  let hostInput;
  let runtimeOutcome;
  let runErrorCode;
  let recorderFailure;
  let interrupted = false;
  const interventions = [];
  const startedAt = new Date().toISOString();
  const onSigint = () => {
    if (interrupted) return;
    interrupted = true;
    if (handle !== undefined && handle.controller.getSnapshot().status !== "finished") {
      try { session.abort("SIGINT: host requested the CW01 Run to stop"); } catch { /* terminal race */ }
    }
    emit({ event: "interrupt_received", runStarted: handle !== undefined });
  };
  activeSigintHandler = onSigint;
  process.on("SIGINT", onSigint);
  try {
    await requireNewOutputTarget();
    const { startLocalScreenRecording } = await import("./local-screen-recorder.mjs");
    recordingAttempted = true;
    recorder = await startLocalScreenRecording({ outputPath: recordingPath, fps: 20 });
    if (recorder.health === undefined || typeof recorder.health.then !== "function") {
      throw new Cw01RunnerError("RECORDER_HEALTH_UNAVAILABLE", "Recorder health monitoring is required before starting the Runtime.");
    }
    void recorder.health.then(
      () => undefined,
      (error) => {
        recorderFailure = error;
        runErrorCode ??= sanitizeCode(error);
        if (handle !== undefined && handle.controller.getSnapshot().status !== "finished") {
          try { session.abort("screen recorder failed during CW01 Run"); } catch { /* terminal race */ }
        }
      },
    );
    emit({ event: "recording_started", audioStreams: 0, fps: 20 });
    if (interrupted) throw new Cw01RunnerError("INTERRUPTED_BEFORE_RUN", "Host interrupted after recording started but before Runtime start.");
    await Promise.resolve();
    if (recorderFailure !== undefined) throw new Cw01RunnerError("RECORDER_FAILED_BEFORE_RUN", "Screen recording failed before the Runtime was started.");
    const runOverrides = {
      windowTarget: selected.wps,
      windowDeliveryMode: "foreground",
      windowSwitch: "opened-windows-v1",
      windowHandoff: "confirm-v1",
    };
    // ApplicationSession is the production path: its default owner uses the
    // cross-process physical-desktop lease; no process-local lease override.
    handle = await session.startRun(goal, runOverrides);
    emit({ event: "run_started", runId: handle.runId, taskId: TASK_ID, model: "glm-5.3-flash", initialTargetSelection: "host_preselected_WPS", outputFile: OUTPUT_FILE, runtimePolicy: POLICY_VERSION, monitor: "guidance", planning: true, memory: "entities", batching: "same-control-input-v1", riskGuard: "off" });
    if (recorderFailure !== undefined || interrupted) {
      try { session.abort("recording or host interruption during Run startup"); } catch { /* terminal race */ }
      throw new Cw01RunnerError(recorderFailure === undefined ? "INTERRUPTED_DURING_RUN_START" : "RECORDER_FAILED_DURING_RUN_START", "Run startup completed after a stop condition; aborting without replay.");
    }
    hostInput = await waitForHostInput(handle.controller, allowedTargets, interventions);
    runtimeOutcome = await session.waitForActiveRun();
  } catch (error) {
    runErrorCode = sanitizeCode(error);
    emit({ event: "run_error", code: runErrorCode, inputStarted: handle !== undefined });
    if (handle !== undefined && handle.controller.getSnapshot().status !== "finished") {
      try { session.abort("runner stopped after an unrecoverable CW01 error"); } catch { /* terminal race */ }
      runtimeOutcome = await session.waitForActiveRun().catch(() => undefined);
    }
  } finally {
    await hostInput?.stop().catch(() => undefined);
    await session.close().catch(() => undefined);
  }

  let recordingResult;
  if (recorder !== undefined) {
    try {
      recordingResult = await recorder.stop();
      emit({ event: "recording_finished", videoCodec: recordingResult.videoCodec, audioStreams: recordingResult.audioStreams });
    } catch (error) {
      runErrorCode ??= sanitizeCode(error);
      emit({ event: "recording_failed", code: sanitizeCode(error) });
    }
  }

  let reportStatus = "not_started";
  if (handle !== undefined) {
    try {
      const report = await handle.report();
      await appRuntime.writeRunReport(report, runRoot);
      reportStatus = "written";
    } catch (error) {
      runErrorCode ??= sanitizeCode(error);
      reportStatus = "failed";
    }
  }
  const summary = {
    schemaVersion: 1,
    kind: "cross_window_life_task_run",
    taskId: TASK_ID,
    entryMode: "production_application_session",
    startedAt,
    finishedAt: new Date().toISOString(),
    runtimeOutcome: runtimeOutcome ?? null,
    runId: handle?.runId ?? null,
    runErrorCode: runErrorCode ?? null,
    reportStatus,
    ownerState: session.lastRun?.ownerState ?? null,
    leaseStateAfterRun: session.inspectEnvironment()?.state ?? "released_or_not_acquired",
    runtimeConfig: { model: "glm-5.3-flash", maxSteps: 100, maxModelRequests: 100, planning: true, memory: "entities", batching: "same-control-input-v1", monitor: "guidance", riskGuard: "off", windowSwitch: "opened-windows-v1", windowHandoff: "confirm-v1", grounding: "uia-catalog-v1" },
    initialTargetSelection: "host_unique_CW01_title_match; model-requested switches are separate Runtime actions",
    selectedTargets: allowedTargets.map((item) => item.label),
    authorizedOutputFile: OUTPUT_FILE,
    outputFileExistsAfterRun: await lstat(OUTPUT_FILE).then(() => true, () => false),
    operatorInterventions: interventions,
    recording: recordingResult === undefined
      ? { status: recordingAttempted ? "failed" : "not_started", ...(recordingAttempted ? { path: relative(REPO_ROOT, recordingPath).split(sep).join("/") } : {}) }
      : { status: "validated", health: recorderFailure === undefined ? "healthy" : "failed", videoCodec: recordingResult.videoCodec, audioStreams: recordingResult.audioStreams, path: relative(REPO_ROOT, recordingPath).split(sep).join("/") },
  };
  await writeFile(resolve(runRoot, "cw01-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  const readBack = await readFile(resolve(runRoot, "cw01-summary.json"), "utf8");
  if (readBack.includes("\uFFFD") || /\?{3,}/u.test(readBack)) throw new Cw01RunnerError("UTF8_READBACK_FAILED", "CW01 summary did not pass UTF-8 read-back validation.");
  emit({ event: "summary_written", evidenceDir: relative(REPO_ROOT, runRoot).split(sep).join("/"), runtimeOutcome: summary.runtimeOutcome, reportStatus, ownerState: summary.ownerState, outputSaved: summary.outputFileExistsAfterRun, interventionCount: interventions.length, runErrorCode: summary.runErrorCode });
}

export async function dispatchRunner(argv) {
  const parsed = parseRunnerArgs(argv);
  if (parsed.mode === "help") {
    process.stdout.write("CW01-only production AppRuntime runner. Live use requires --live --root-go-after-review after root/reviewer GO. Reads only CW01 task card; exact output is E:\\MyDesktop\\output\\CW01-活动备忘录.txt; only the fresh WPS CW01 and Notepad targets are in scope. Host controls use one JSON object per stdin line: {kind:'input',requestId,text}, {kind:'approval',requestId,approved}, {kind:'handoff',sourceActionId,candidateIndex}, or {kind:'cancel'}.\n");
    return;
  }
  if (parsed.mode === "self-test") {
    process.stdout.write("CW01 runner offline self-tests are in cw01-runner.selftest.mjs.\n");
    return;
  }
  try {
    await runLive();
  } finally {
    if (activeSigintHandler !== undefined) {
      process.removeListener("SIGINT", activeSigintHandler);
      activeSigintHandler = undefined;
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  dispatchRunner(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`CW01 runner stopped safely: ${sanitizeCode(error)}\n`);
    process.exitCode = 1;
  });
}
