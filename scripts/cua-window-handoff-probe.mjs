#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ApplicationSession, createWindowTargetDiscovery } from "../packages/app-runtime/dist/index.js";

const PROVIDER_ID = "local-scripted-cua-window-handoff-probe";
const ROOT = resolve("runs", "diagnostics", "cua-window-handoff-probe");
const PHASE_TIMEOUT_MS = 5 * 60_000;
const CLEANUP_TIMEOUT_MS = 15_000;
const OPEN_TURN = {
  type: "tool_calls",
  calls: [{ id: "probe-open-dialog-once", name: "hotkey", arguments: { keys: ["CTRL", "O"] } }],
};
const FINISH_TURN = { type: "finish", summary: "bounded window-handoff diagnostic complete" };

class ProbeFailure extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function required(name) {
  const value = option(name);
  if (value === undefined || value.length === 0) throw new ProbeFailure("MISSING_ARGUMENT", `Missing ${name}`);
  return value;
}

function positiveInteger(name) {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value <= 0) throw new ProbeFailure("INVALID_TARGET", `${name} must be a positive safe integer`);
  return value;
}

function assertTty() {
  if (!stdin.isTTY || !stdout.isTTY) throw new ProbeFailure("TTY_REQUIRED", "This diagnostic requires an interactive TTY; no CUA call was made.");
}

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolveValue) => { resolvePromise = resolveValue; });
  return { promise, resolve: resolvePromise };
}

function waitForGate(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("provider turn aborted"));
  return new Promise((resolvePromise, rejectPromise) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      rejectPromise(signal.reason ?? new Error("provider turn aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolvePromise(value); },
      (error) => { signal.removeEventListener("abort", onAbort); rejectPromise(error); },
    );
  });
}

function withDeadline(operation, signal, deadlineAt, code, message) {
  if (signal?.aborted) throw signal.reason ?? new ProbeFailure("OPERATOR_ABORT", "Interrupted by operator.");
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw new ProbeFailure(code, message);
  const work = Promise.resolve().then(operation);
  let timer;
  let onAbort;
  const stopped = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ProbeFailure(code, message)), remainingMs);
    if (signal !== undefined) {
      onAbort = () => reject(signal.reason ?? new ProbeFailure("OPERATOR_ABORT", "Interrupted by operator."));
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  return Promise.race([work, stopped]).finally(() => {
    clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  });
}

function abortOnSignal(app, signal) {
  const abort = () => {
    if (app.status === "running") {
      try { app.abort("window-handoff diagnostic interrupted"); } catch { /* cleanup will retain ownership if needed */ }
    }
  };
  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

export async function cleanupSession(app, manifest, reason) {
  const deadlineAt = Date.now() + CLEANUP_TIMEOUT_MS;
  const pending = () => {
    try { app.markEnvironmentPending(reason); } catch { /* keep the diagnostic fail-closed */ }
    manifest.cleanupConfirmed = false;
    manifest.environmentPending = true;
    return false;
  };
  if (app.status === "running") {
    try { app.abort(reason); } catch { /* bounded wait below decides whether cleanup is known */ }
    try { await withDeadline(() => app.waitForActiveRun(), undefined, deadlineAt, "CLEANUP_TIMEOUT", "Run cleanup exceeded its deadline."); }
    catch { if (app.status === "running") return pending(); }
  }
  try { await withDeadline(() => app.close(), undefined, deadlineAt, "CLEANUP_TIMEOUT", "Session close exceeded its deadline."); }
  catch { return pending(); }
  if (manifest.runStartAttempted === false && manifest.preflightDiscoveryConfirmed !== true) return pending();
  const environment = app.inspectEnvironment();
  if (app.status === "closed" && app.activeRun === undefined && app.history.length === 0 &&
      manifest.runStartAttempted === false && manifest.preflightDiscoveryConfirmed === true) {
    // This session never acquired a Run lease. Closing it cannot release or
    // prove cleanup of another Run's existing owner barrier.
    manifest.cleanupScope = "no_run_started";
    manifest.cleanupConfirmed = true;
    manifest.environmentPending = environment?.state === "pending_cleanup";
    manifest.environmentBlocked = environment !== undefined;
    manifest.preexistingEnvironmentPending = manifest.environmentPending;
    manifest.preexistingEnvironmentBlocked = manifest.environmentBlocked;
    if (environment !== undefined) {
      manifest.preexistingEnvironmentRunId = environment.runId;
      manifest.preexistingEnvironmentReason = environment.reason ?? "Another Run still owns this environment.";
    }
    return true;
  }
  const confirmed = app.status === "closed" && app.activeRun === undefined && environment === undefined;
  if (!confirmed) return pending();
  manifest.cleanupConfirmed = true;
  manifest.environmentPending = false;
  return true;
}

class ScriptedProvider {
  constructor(turns, firstTurnGate) {
    this.id = PROVIDER_ID;
    this.turns = turns;
    this.firstTurnGate = firstTurnGate;
    this.calls = 0;
    this.firstCallReady = deferred();
  }

  async generate(_input, { signal }) {
    signal.throwIfAborted();
    this.calls += 1;
    if (this.calls === 1) {
      this.firstCallReady.resolve();
      if (this.firstTurnGate !== undefined) await waitForGate(this.firstTurnGate.promise, signal);
    }
    const turn = this.turns[this.calls - 1];
    if (turn === undefined) throw new ProbeFailure("SCRIPTED_PROVIDER_EXHAUSTED", "Scripted provider plan was exhausted; no action replay is allowed.");
    return structuredClone(turn);
  }

  async close() {}
}

function makeConfig(socketPath, outputDir) {
  return {
    model: { kind: "external", id: PROVIDER_ID },
    computer: { kind: "cua", socketPath, screenshotDir: join(outputDir, "computer-captures") },
    outputDir,
    maxSteps: 4,
    maxModelRequests: 3,
    planning: false,
    memory: "off",
    memoryRetrieval: "off",
    batching: "off",
    contextMode: "raw",
    contextMaxHistoryEvents: 12,
    riskProfile: "live-interactive",
    riskGuard: "off",
    riskModel: "off",
    riskMaxModelRequests: 1,
    riskTimeoutMs: 1000,
    cleanupDeadlineMs: 10_000,
    windowHandoff: "confirm-v1",
    grounding: "off",
  };
}

function makeSession(socketPath, outputDir, provider) {
  const config = makeConfig(socketPath, outputDir);
  const windowDiscovery = createWindowTargetDiscovery(config.computer);
  if (windowDiscovery === undefined) throw new ProbeFailure("WINDOW_DISCOVERY_UNAVAILABLE", "CUA window discovery is unavailable.");
  return new ApplicationSession({
    config,
    dependencies: { createProvider: () => provider },
    windowDiscovery,
  });
}

async function promptExact(terminal, prompt, expected, signal, deadlineAt) {
  const answer = await withDeadline(() => terminal.question(`${prompt}\nType exactly: ${expected}\n> `), signal, deadlineAt, "PHASE_TIMEOUT", "Diagnostic phase exceeded its deadline.");
  if (answer.trim() !== expected) throw new ProbeFailure("OPERATOR_CONFIRMATION_MISMATCH", "Confirmation did not match; stopping without another GUI action.");
}

function exactWindow(windows, target) {
  return windows.find((window) => window.pid === target.pid && window.windowId === target.windowId);
}

function isNotepad(window) {
  return /notepad/iu.test(window?.appName ?? "");
}

export async function preflightNotepadParent(app, parent, signal, deadlineAt, manifest) {
  const windows = await withDeadline(() => app.listAllWindowTargets(signal), signal, deadlineAt, "PHASE_TIMEOUT", "Diagnostic phase exceeded its deadline.");
  // A completed discovery has already closed its temporary driver session.
  manifest.preflightDiscoveryConfirmed = true;
  const selected = exactWindow(windows, parent);
  if (selected === undefined || !isNotepad(selected)) {
    throw new ProbeFailure("PARENT_NOT_EXACT_NOTEPAD", "The selected PID/HWND is not an exact Notepad window in the full inventory; no Run started.");
  }
  return selected;
}

function safeObservation(event, runOutputDir) {
  if (event?.type !== "observation.created") return undefined;
  const ref = event.observation.screenshot;
  if (typeof ref?.relativePath !== "string") return undefined;
  return {
    id: event.observation.id,
    computerSessionId: event.observation.computerSessionId,
    capturedAt: event.observation.capturedAt,
    assetRelativePath: ref.relativePath,
    assetPath: resolve(runOutputDir, "assets", ref.relativePath),
  };
}

function plainCandidate(candidate) {
  return { pid: candidate.pid, windowId: candidate.windowId };
}

function actionEvents(events) {
  return events.filter((event) => event.type === "action.execution.started");
}

function assertCompletedSingleOpenRun(events, providerCalls, handoffTarget, runOutputDir) {
  const computerOpen = events.find((event) => event.type === "computer.open.completed");
  const handoff = events.find((event) => event.type === "computer.window.handoff.completed");
  const observations = events.filter((event) => event.type === "observation.created");
  const actions = actionEvents(events);
  const hotkeyCalls = events.filter((event) => event.type === "tool.call.received" && event.call.name === "hotkey");
  if (computerOpen === undefined || handoff === undefined || providerCalls !== 2 || actions.length !== 1 || hotkeyCalls.length !== 1) {
    throw new ProbeFailure("HANDOFF_EVENT_SEQUENCE_INVALID", "Expected one Ctrl+O action, one confirmed handoff, one fresh capture turn, and no action replay.");
  }
  const action = actions[0].action;
  const keys = action.kind === "keypress" ? action.keys.map((key) => key.toUpperCase()) : [];
  if (keys.join("+") !== "CTRL+O") throw new ProbeFailure("UNEXPECTED_ACTION", "The scripted action was not exactly Ctrl+O.");
  if (handoff.target.pid !== handoffTarget.pid || handoff.target.windowId !== handoffTarget.windowId) {
    throw new ProbeFailure("HANDOFF_TARGET_MISMATCH", "Completed handoff target differed from the operator-confirmed HWND.");
  }
  if (computerOpen.session.id !== handoff.session.id || computerOpen.session.backend !== handoff.session.backend) {
    throw new ProbeFailure("HANDOFF_SESSION_ID_CHANGED", "Window handoff replaced the run-scoped ComputerSession identity or backend.");
  }
  const initialObservation = observations.find((event) => event.sequence < handoff.sequence && event.observation.computerSessionId === computerOpen.session.id);
  const dialogObservation = observations.find((event) => event.sequence > handoff.sequence && event.observation.computerSessionId === handoff.session.id);
  if (initialObservation === undefined || dialogObservation === undefined || initialObservation.observation.id === dialogObservation.observation.id) {
    throw new ProbeFailure("HANDOFF_CAPTURE_MISSING", "Expected distinct parent and post-handoff exact-window observations.");
  }
  const dialogCapture = safeObservation(dialogObservation, runOutputDir);
  if (dialogCapture === undefined) throw new ProbeFailure("HANDOFF_ASSET_MISSING", "Post-handoff observation did not contain a private screenshot asset reference.");
  return {
    parentSessionId: computerOpen.session.id,
    dialogSessionId: handoff.session.id,
    initialObservationId: initialObservation.observation.id,
    dialogObservation: dialogCapture,
    actionCount: actions.length,
    ctrlOActionCount: hotkeyCalls.length,
    providerCalls,
  };
}

function assertNoHiddenAction(events, runOutputDir) {
  if (actionEvents(events).length !== 0 || events.some((event) => event.type === "tool.call.received")) {
    throw new ProbeFailure("PARENT_OBSERVE_NOT_READ_ONLY", "Parent reselect phase unexpectedly emitted a tool/action call.");
  }
  const observations = events.filter((event) => event.type === "observation.created");
  if (observations.length !== 1) throw new ProbeFailure("PARENT_CAPTURE_COUNT_INVALID", "Expected exactly one fresh parent-window capture.");
  const capture = safeObservation(observations[0], runOutputDir);
  if (capture === undefined) throw new ProbeFailure("PARENT_ASSET_MISSING", "Parent observation did not contain a screenshot asset reference.");
  return capture;
}

function assertWithinDiagnosticsRoot(path) {
  const absolute = resolve(path);
  const rel = relative(ROOT, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ProbeFailure("MANIFEST_OUTSIDE_DIAGNOSTICS", "Handoff manifest must be inside this probe's ignored diagnostics directory.");
  }
  return absolute;
}

async function newOutputDir(phase) {
  await mkdir(ROOT, { recursive: true });
  const directory = join(ROOT, `${new Date().toISOString().replace(/[.:]/gu, "-")}-${phase}-${randomUUID()}`);
  await mkdir(directory, { recursive: false });
  return directory;
}

async function saveManifest(path, manifest) {
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function waitForController(controller, predicate, signal, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const snapshot = controller.getSnapshot();
    if (predicate(snapshot)) return snapshot;
    if (snapshot.status === "finished") return snapshot;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new ProbeFailure("CONTROLLER_WAIT_TIMEOUT", "Runtime did not reach the expected handoff state before timeout.");
}

async function runHandoff(options, terminal, signal) {
  const deadlineAt = Date.now() + PHASE_TIMEOUT_MS;
  const parent = { pid: positiveInteger("--pid"), windowId: positiveInteger("--window-id") };
  const outputDir = await newOutputDir("handoff");
  const manifestPath = join(outputDir, "probe.json");
  const manifest = {
    schemaVersion: 1,
    phase: "handoff",
    status: "starting",
    startedAt: new Date().toISOString(),
    parentTarget: parent,
    scriptedAction: "hotkey CTRL+O only",
    externalModelCalls: 0,
    actionReplayAllowed: false,
    screenshotsStoredPrivatelyByRuntime: true,
    runStartAttempted: false,
    preflightDiscoveryConfirmed: false,
  };
  await saveManifest(manifestPath, manifest);

  const socketPath = required("--socket");
  const config = makeConfig(socketPath, join(outputDir, "runs"));
  const discovery = createWindowTargetDiscovery(config.computer);
  if (discovery === undefined) throw new ProbeFailure("WINDOW_DISCOVERY_UNAVAILABLE", "CUA window discovery is unavailable.");
  const app = new ApplicationSession({
    config,
    dependencies: { createProvider: () => provider },
    windowDiscovery: discovery,
  });
  const firstTurnGate = deferred();
  const provider = new ScriptedProvider([OPEN_TURN, FINISH_TURN], firstTurnGate);
  const removeAbortListener = abortOnSignal(app, signal);
  let handle;
  let actionReleased = false;
  let cleanupConfirmed = false;
  try {
    await preflightNotepadParent(app, parent, signal, deadlineAt, manifest);
    manifest.parentListed = true;
    manifest.parentInventoryView = "all_top_level";
    manifest.parentAppVerifiedNotepad = true;
    await saveManifest(manifestPath, manifest);

    // Runtime's foreground open performs the one exact activation attempt
    // and fresh identity/capture checks; preflight does not activate twice.
    manifest.runStartAttempted = true;
    handle = await withDeadline(() => app.startRun(
      "Open the Notepad file picker once, hand off to the exact dialog, then finish without opening or saving a file.",
      { windowTarget: parent, windowDeliveryMode: "foreground", windowHandoff: "confirm-v1" },
    ), signal, deadlineAt, "PHASE_TIMEOUT", "Diagnostic phase exceeded its deadline.");
    await withDeadline(() => provider.firstCallReady.promise, signal, deadlineAt, "INITIAL_CAPTURE_TIMEOUT", "Run did not reach its first provider turn; no scripted input was released.");
    const initialEvent = handle.controller.getEvents().find((event) => event.type === "observation.created");
    const initialCapture = safeObservation(initialEvent, handle.config.outputDir);
    if (initialCapture === undefined || !(await stat(initialCapture.assetPath).then(() => true, () => false))) {
      throw new ProbeFailure("INITIAL_CAPTURE_MISSING", "Initial exact-target screenshot asset is unavailable; no scripted input was released.");
    }
    manifest.initialCapture = {
      observationId: initialCapture.id,
      computerSessionId: initialCapture.computerSessionId,
      assetRelativePath: initialCapture.assetRelativePath,
    };
    await saveManifest(manifestPath, manifest);
    await promptExact(
      terminal,
      `Review the private initial frame and live window. Confirm this is the fresh, blank, unsaved synthetic Notepad tab. Frame: ${initialCapture.assetPath}`,
      `CONFIRM BLANK UNSAVED SYNTHETIC NOTEPAD ${parent.pid}:${parent.windowId}`,
      signal,
      deadlineAt,
    );

    firstTurnGate.resolve();
    actionReleased = true;
    const snapshot = await withDeadline(() => waitForController(
      handle.controller,
      (current) => current.status === "waiting_window",
      signal,
      60_000,
    ), signal, deadlineAt, "PHASE_TIMEOUT", "Diagnostic phase exceeded its deadline.");
    if (snapshot.status !== "waiting_window" || snapshot.pendingWindowHandoff?.reasonCode !== "new_window_detected") {
      await withDeadline(() => app.waitForActiveRun(), signal, deadlineAt, "PHASE_TIMEOUT", "Diagnostic phase exceeded its deadline.").catch(() => undefined);
      throw new ProbeFailure("NO_NEW_WINDOW_HANDOFF", "Ctrl+O did not produce a Runtime waiting_window handoff. No target was guessed; cancel any visible dialog manually.");
    }
    const candidates = await withDeadline(() => handle.controller.listNewWindowHandoffCandidates(signal), signal, deadlineAt, "PHASE_TIMEOUT", "Diagnostic phase exceeded its deadline.");
    if (candidates.length === 0) throw new ProbeFailure("NO_NEW_WINDOW_CANDIDATE", "Runtime requested handoff but exposed no new exact-window candidate.");
    stdout.write("Newly surfaced exact-window candidates (titles intentionally hidden):\n");
    for (const candidate of candidates) stdout.write(`  pid=${candidate.pid} hwnd=${candidate.windowId} app=${String(candidate.appName ?? "unknown").slice(0, 64)}\n`);
    const selection = (await withDeadline(() => terminal.question("Enter the candidate PID:HWND you visually verified is the Notepad Open dialog: "), signal, deadlineAt, "PHASE_TIMEOUT", "Diagnostic phase exceeded its deadline.")).trim();
    const candidate = candidates.find((item) => `${item.pid}:${item.windowId}` === selection);
    if (candidate === undefined) throw new ProbeFailure("DIALOG_CANDIDATE_NOT_SELECTED", "Selection was not one of the newly surfaced candidates; no handoff performed.");
    await promptExact(terminal, "Confirm the selected exact target is the open file dialog. Do not choose a file or type a path.", `CONFIRM OPEN DIALOG ${candidate.pid}:${candidate.windowId}`, signal, deadlineAt);
    await withDeadline(() => handle.controller.handoffWindow(candidate, snapshot.pendingWindowHandoff.sourceActionId), signal, deadlineAt, "PHASE_TIMEOUT", "Diagnostic phase exceeded its deadline.");
    const outcome = await withDeadline(() => app.waitForActiveRun(), signal, deadlineAt, "PHASE_TIMEOUT", "Diagnostic phase exceeded its deadline.");
    if (outcome !== "succeeded") throw new ProbeFailure("HANDOFF_RUN_NOT_SUCCEEDED", "Run did not complete successfully after the confirmed exact-target handoff.");
    if (app.status !== "idle" || app.inspectEnvironment() !== undefined) throw new ProbeFailure("RUN_CLEANUP_UNCONFIRMED", "Runtime did not confirm cleanup/lease release; stop before cancelling or starting another phase.");
    cleanupConfirmed = true;

    const events = handle.controller.getEvents();
    const handoffEvent = events.find((event) => event.type === "computer.window.handoff.completed");
    if (handoffEvent?.type !== "computer.window.handoff.completed") throw new ProbeFailure("HANDOFF_EVENT_MISSING", "Runtime did not commit the handoff completion event.");
    const checks = assertCompletedSingleOpenRun(events, provider.calls, plainCandidate(candidate), handle.config.outputDir);
    manifest.status = "completed_dialog_open";
    manifest.finishedAt = new Date().toISOString();
    manifest.dialogTarget = plainCandidate(candidate);
    manifest.handoffRunId = handle.runId;
    manifest.outcome = outcome;
    manifest.runOutputDir = handle.config.outputDir;
    manifest.handoffChecks = checks;
    manifest.handoffRequestedCount = events.filter((event) => event.type === "computer.window.handoff.requested").length;
    manifest.handoffCompletedCount = events.filter((event) => event.type === "computer.window.handoff.completed").length;
    manifest.privateDialogCapture = {
      observationId: checks.dialogObservation.id,
      assetRelativePath: checks.dialogObservation.assetRelativePath,
    };
    manifest.cleanupConfirmed = cleanupConfirmed;
    await saveManifest(manifestPath, manifest);
  } catch (error) {
    manifest.status = "failed_closed";
    manifest.errorCode = error instanceof ProbeFailure ? error.code : "UNEXPECTED_ERROR";
    manifest.finishedAt = new Date().toISOString();
    manifest.operatorCleanupMayBeRequired = actionReleased;
    await saveManifest(manifestPath, manifest).catch(() => undefined);
    throw error instanceof ProbeFailure ? error : new ProbeFailure("UNEXPECTED_ERROR", "Probe stopped safely after an unexpected error; see private manifest.");
  } finally {
    cleanupConfirmed = await cleanupSession(app, manifest, "window-handoff diagnostic cleanup unconfirmed");
    removeAbortListener();
    if (!cleanupConfirmed && manifest.status === "completed_dialog_open") {
      manifest.status = "failed_closed";
      manifest.errorCode = "CLEANUP_UNCONFIRMED";
      manifest.operatorCleanupMayBeRequired = actionReleased;
      process.exitCode = 1;
    }
    manifest.finishedAt ??= new Date().toISOString();
    await saveManifest(manifestPath, manifest).catch(() => undefined);
    if (cleanupConfirmed && manifest.status === "completed_dialog_open") {
      stdout.write(`${JSON.stringify({ stage: "handoff_complete", outcome: manifest.outcome, parentTarget: parent, dialogTarget: manifest.dialogTarget, manifest: manifestPath })}\n`);
      stdout.write("The exact dialog remains open. This Run is finished and its CUA lease is released. The sole live owner should now press Escape once manually, then run --phase parent-observe with this manifest. Do not select/open/save a file.\n");
    } else if (!cleanupConfirmed) {
      stderr.write("Runtime cleanup was not confirmed; process-local environment ownership was retained. Do not cancel the dialog or start another probe.\n");
    } else if (manifest.preexistingEnvironmentBlocked) {
      stderr.write("This probe started no Run and closed its session; a pre-existing environment owner barrier remains. No lease was cleared.\n");
    }
  }
}

async function loadHandoffManifest(path) {
  const manifestPath = assertWithinDiagnosticsRoot(path);
  let value;
  try {
    value = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new ProbeFailure("HANDOFF_MANIFEST_INVALID", "Could not read the private handoff manifest.");
  }
  if (value?.schemaVersion !== 1 || value.phase !== "handoff" || value.status !== "completed_dialog_open" ||
      !isTarget(value.parentTarget) || !isTarget(value.dialogTarget) || value.cleanupConfirmed !== true) {
    throw new ProbeFailure("HANDOFF_MANIFEST_NOT_READY", "Manifest does not describe a completed, cleanup-confirmed dialog handoff.");
  }
  return { manifestPath, value };
}

function isTarget(value) {
  return value !== null && typeof value === "object" &&
    Number.isSafeInteger(value.pid) && value.pid > 0 &&
    Number.isSafeInteger(value.windowId) && value.windowId > 0;
}

async function runParentObserve(options, terminal, signal) {
  const deadlineAt = Date.now() + PHASE_TIMEOUT_MS;
  const { manifestPath: handoffManifestPath, value: handoff } = await loadHandoffManifest(required("--handoff-manifest"));
  const parent = handoff.parentTarget;
  const dialog = handoff.dialogTarget;
  const outputDir = await newOutputDir("parent-observe");
  const manifestPath = join(outputDir, "probe.json");
  const manifest = {
    schemaVersion: 1,
    phase: "parent-observe",
    status: "starting",
    startedAt: new Date().toISOString(),
    handoffManifestPath,
    parentTarget: parent,
    dialogTarget: dialog,
    externalModelCalls: 0,
    scriptedActions: 0,
    runStartAttempted: false,
    preflightDiscoveryConfirmed: false,
  };
  await saveManifest(manifestPath, manifest);

  const socketPath = required("--socket");
  const config = makeConfig(socketPath, join(outputDir, "runs"));
  const discovery = createWindowTargetDiscovery(config.computer);
  if (discovery === undefined) throw new ProbeFailure("WINDOW_DISCOVERY_UNAVAILABLE", "CUA window discovery is unavailable.");
  const app = new ApplicationSession({
    config,
    dependencies: { createProvider: () => new ScriptedProvider([FINISH_TURN]) },
    windowDiscovery: discovery,
  });
  const removeAbortListener = abortOnSignal(app, signal);
  try {
    const before = await withDeadline(() => app.listAllWindowTargets(signal), signal, deadlineAt, "PHASE_TIMEOUT", "Diagnostic phase exceeded its deadline.");
    manifest.preflightDiscoveryConfirmed = true;
    const parentWindow = exactWindow(before, parent);
    const dialogStillListed = exactWindow(before, dialog) !== undefined;
    if (parentWindow === undefined || !isNotepad(parentWindow) || dialogStillListed) {
      throw new ProbeFailure("DIALOG_CANCEL_NOT_CONFIRMED", "Read-only inventory did not show the Notepad parent with the exact dialog HWND absent.");
    }
    await promptExact(
      terminal,
      "Inventory confirms the dialog HWND is absent. Confirm the parent is still the same blank synthetic Notepad tab; this Run sends no GUI input.",
      `CONFIRM PARENT WINDOW ${parent.pid}:${parent.windowId} AND DIALOG CANCELLED`,
      signal,
      deadlineAt,
    );

    manifest.runStartAttempted = true;
    const handle = await withDeadline(() => app.startRun(
      "Observe only the exact Notepad parent window after the file dialog was manually cancelled; take no action.",
      { windowTarget: parent, windowDeliveryMode: "foreground", windowHandoff: "off" },
    ), signal, deadlineAt, "PHASE_TIMEOUT", "Diagnostic phase exceeded its deadline.");
    const outcome = await withDeadline(() => app.waitForActiveRun(), signal, deadlineAt, "PHASE_TIMEOUT", "Diagnostic phase exceeded its deadline.");
    if (outcome !== "succeeded") throw new ProbeFailure("PARENT_OBSERVE_FAILED", "Parent-only observation Run did not succeed.");
    if (app.status !== "idle" || app.inspectEnvironment() !== undefined) throw new ProbeFailure("PARENT_CLEANUP_UNCONFIRMED", "Parent observation Run cleanup/lease was not confirmed.");

    const events = handle.controller.getEvents();
    const parentCapture = assertNoHiddenAction(events, handle.config.outputDir);
    const after = await withDeadline(() => app.listAllWindowTargets(signal), signal, deadlineAt, "PHASE_TIMEOUT", "Diagnostic phase exceeded its deadline.");
    if (exactWindow(after, parent) === undefined || exactWindow(after, dialog) !== undefined) {
      throw new ProbeFailure("PARENT_RESELECT_POSTCHECK_FAILED", "Post-run inventory did not confirm parent present and dialog absent.");
    }
    manifest.status = "completed";
    manifest.outcome = outcome;
    manifest.finishedAt = new Date().toISOString();
    manifest.runId = handle.runId;
    manifest.runOutputDir = handle.config.outputDir;
    manifest.parentCapture = {
      observationId: parentCapture.id,
      computerSessionId: parentCapture.computerSessionId,
      assetRelativePath: parentCapture.assetRelativePath,
    };
    manifest.dialogAbsentBeforeAndAfter = true;
    manifest.parentPresentBeforeAndAfter = true;
    await saveManifest(manifestPath, manifest);
  } catch (error) {
    manifest.status = "failed_closed";
    manifest.errorCode = error instanceof ProbeFailure ? error.code : "UNEXPECTED_ERROR";
    manifest.finishedAt = new Date().toISOString();
    await saveManifest(manifestPath, manifest).catch(() => undefined);
    throw error instanceof ProbeFailure ? error : new ProbeFailure("UNEXPECTED_ERROR", "Parent-observe phase stopped safely; see private manifest.");
  } finally {
    const cleanupConfirmed = await cleanupSession(app, manifest, "parent-observe cleanup unconfirmed");
    removeAbortListener();
    if (!cleanupConfirmed && manifest.status === "completed") {
      manifest.status = "failed_closed";
      manifest.errorCode = "CLEANUP_UNCONFIRMED";
      process.exitCode = 1;
    }
    manifest.finishedAt ??= new Date().toISOString();
    await saveManifest(manifestPath, manifest).catch(() => undefined);
    if (manifest.status === "completed" && cleanupConfirmed) {
      stdout.write(`${JSON.stringify({ stage: "parent_reselected", outcome: manifest.outcome, parentTarget: parent, dialogAbsent: true, manifest: manifestPath })}\n`);
    } else if (!cleanupConfirmed) {
      stderr.write("Runtime cleanup was not confirmed; process-local environment ownership was retained. Do not start another probe.\n");
    } else if (manifest.preexistingEnvironmentBlocked) {
      stderr.write("This probe started no Run and closed its session; a pre-existing environment owner barrier remains. No lease was cleared.\n");
    }
  }
}

function parseMode() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) return { help: true };
  const phase = required("--phase");
  if (phase !== "handoff" && phase !== "parent-observe") throw new ProbeFailure("INVALID_PHASE", "--phase must be handoff or parent-observe.");
  if (phase === "handoff" && !process.argv.includes("--confirm-blank-unsaved-synthetic-notepad")) {
    throw new ProbeFailure("EXPLICIT_OPT_IN_REQUIRED", "Handoff phase requires --confirm-blank-unsaved-synthetic-notepad.");
  }
  if (phase === "parent-observe" && !process.argv.includes("--confirm-dialog-cancelled")) {
    throw new ProbeFailure("EXPLICIT_OPT_IN_REQUIRED", "Parent-observe phase requires --confirm-dialog-cancelled.");
  }
  return { phase };
}

async function main() {
  const mode = parseMode();
  if (mode.help) {
    stdout.write([
      "Usage:",
      "  node scripts/cua-window-handoff-probe.mjs --phase handoff --socket <pipe> --pid <notepad-pid> --window-id <parent-hwnd> --confirm-blank-unsaved-synthetic-notepad",
      "  node scripts/cua-window-handoff-probe.mjs --phase parent-observe --socket <pipe> --handoff-manifest <private-probe.json> --confirm-dialog-cancelled",
      "Uses ApplicationSession/RunController with a local scripted provider; no paid model or second runtime loop.",
      "Handoff phase sends only Ctrl+O, requires exact TTY confirmation for one new dialog HWND, captures it, then ends and releases the Run.",
      "The sole live owner manually presses Escape after that Run ends. Parent-observe verifies the dialog is absent and captures the exact parent without input.",
      "Screenshots are stored only by Runtime under ignored runs/diagnostics/; titles, file paths, image bytes and other-window inventories are not printed or copied to the probe manifest.",
    ].join("\n") + "\n");
    return;
  }
  assertTty();
  const terminal = createInterface({ input: stdin, output: stdout, crlfDelay: Infinity });
  const shutdown = new AbortController();
  const onSigInt = () => {
    if (!shutdown.signal.aborted) shutdown.abort(new ProbeFailure("OPERATOR_ABORT", "Interrupted by operator."));
    terminal.close();
  };
  process.on("SIGINT", onSigInt);
  try {
    if (mode.phase === "handoff") await runHandoff(mode, terminal, shutdown.signal);
    else await runParentObserve(mode, terminal, shutdown.signal);
  } finally {
    process.off("SIGINT", onSigInt);
    terminal.close();
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const code = error instanceof ProbeFailure ? error.code : "UNEXPECTED_ERROR";
    stderr.write(`CUA window handoff diagnostic stopped safely (${code}). No action will be retried.\n`);
    process.exitCode = 1;
  });
}
