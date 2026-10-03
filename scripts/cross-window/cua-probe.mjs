#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OUTPUT_ROOT = resolve("runs", "diagnostics", "cross-window-cua-probe");
const OUTPUT_ROOT_RELATIVE = "runs/diagnostics/cross-window-cua-probe";
const FIXTURE_TITLE_PREFIX = "HarnessProbe-";
const IDENTITY_KEYS = new Set(["pid", "windowId"]);
const PUBLIC_WINDOW_KEYS = new Set(["windowRef", "appName", "title", "isCurrent"]);
const SESSION_KEYS = new Set(["id", "backend", "viewport", "capabilities", "openedAt"]);

export class ProbeFailure extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function parseWindowTarget(value, flagName = "target") {
  if (typeof value !== "string" || !/^\d+:\d+$/u.test(value)) {
    throw new ProbeFailure("INVALID_TARGET", `${flagName} must be PID:HWND using positive safe integers.`);
  }
  const [rawPid, rawWindowId] = value.split(":");
  const pid = Number(rawPid);
  const windowId = Number(rawWindowId);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(windowId) || windowId <= 0) {
    throw new ProbeFailure("INVALID_TARGET", `${flagName} must be PID:HWND using positive safe integers.`);
  }
  return { pid, windowId };
}

export function validateFixtureTitle(value, flagName = "title") {
  if (typeof value !== "string" || !/^HarnessProbe-[A-Za-z0-9._-]{1,72}$/u.test(value)) {
    throw new ProbeFailure("UNSAFE_FIXTURE_LABEL", `${flagName} must be an ASCII HarnessProbe-* test-fixture title.`);
  }
  return value;
}

export function selectUniqueWindowOption(options, expected, label) {
  const matches = options.filter((option) =>
    option.appName === expected.appName &&
    option.title === expected.title &&
    (expected.isCurrent === undefined || option.isCurrent === expected.isCurrent));
  if (matches.length !== 1) {
    throw new ProbeFailure("WINDOW_OPTION_AMBIGUOUS", `Expected one authorized ${label} window option; found ${matches.length}.`);
  }
  assertOpaqueWindowOption(matches[0]);
  return matches[0];
}

export function assertOpaqueWindowOption(option) {
  if (option === null || typeof option !== "object" || Array.isArray(option)) {
    throw new ProbeFailure("WINDOW_OPTION_SCHEMA", "Computer.listWindows returned an invalid option.");
  }
  const keys = Object.keys(option);
  if (keys.some((key) => !PUBLIC_WINDOW_KEYS.has(key)) ||
      keys.some((key) => IDENTITY_KEYS.has(key)) ||
      typeof option.windowRef !== "string" || !/^win-[0-9a-f-]{36}$/iu.test(option.windowRef) ||
      typeof option.isCurrent !== "boolean" ||
      option.appName !== undefined && typeof option.appName !== "string" ||
      option.title !== undefined && typeof option.title !== "string") {
    throw new ProbeFailure("WINDOW_OPTION_SCHEMA", "Computer.listWindows exposed an unexpected or non-opaque option shape.");
  }
  return option;
}

export function assertCompletedSwitch(receipt, previousSession) {
  if (receipt?.status !== "completed" || receipt.sessionAfter === undefined || receipt.sessionAfter === null) {
    throw new ProbeFailure("SWITCH_RECEIPT_INVALID", "A successful switch must return a verified sessionAfter descriptor.");
  }
  const sessionAfter = receipt.sessionAfter;
  if (String(sessionAfter.id) !== String(previousSession.id) || sessionAfter.backend !== previousSession.backend) {
    throw new ProbeFailure("SWITCH_SESSION_ID_CHANGED", "Switch receipt did not retain the active ComputerSession identity and backend.");
  }
  if (Object.keys(sessionAfter).some((key) => !SESSION_KEYS.has(key)) ||
      !Number.isSafeInteger(sessionAfter.viewport?.width) || sessionAfter.viewport.width <= 0 ||
      !Number.isSafeInteger(sessionAfter.viewport?.height) || sessionAfter.viewport.height <= 0 ||
      sessionAfter.viewport.coordinateSpace !== "physical" ||
      typeof sessionAfter.openedAt !== "string" || Number.isNaN(Date.parse(sessionAfter.openedAt))) {
    throw new ProbeFailure("SWITCH_SESSION_SCHEMA", "sessionAfter did not contain a minimal serializable Computer descriptor.");
  }
  try {
    JSON.parse(JSON.stringify(sessionAfter));
  } catch {
    throw new ProbeFailure("SWITCH_SESSION_SCHEMA", "sessionAfter was not serializable.");
  }
  return sessionAfter;
}

function optionValue(argv, name, required = true) {
  const index = argv.indexOf(name);
  if (index < 0) {
    if (required) throw new ProbeFailure("MISSING_ARGUMENT", `Missing ${name}.`);
    return undefined;
  }
  const value = argv[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new ProbeFailure("MISSING_ARGUMENT_VALUE", `${name} requires a value.`);
  }
  return value;
}

function repeatedValues(argv, name) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== name) continue;
    const value = argv[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      throw new ProbeFailure("MISSING_ARGUMENT_VALUE", `${name} requires a value.`);
    }
    values.push(value);
    index += 1;
  }
  return values;
}

function safeAppName(value, flagName) {
  if (typeof value !== "string" || !/^[A-Za-z0-9 ._-]{1,96}$/u.test(value)) {
    throw new ProbeFailure("INVALID_APP_LABEL", `${flagName} must be a bounded ASCII app label.`);
  }
  return value;
}

function assertKnownArguments(argv) {
  const valueFlags = new Set([
    "--socket", "--initial-target", "--destination-target", "--close-target", "--allow-target",
    "--initial-app", "--initial-title", "--destination-app", "--destination-title", "--close-app", "--close-title",
  ]);
  const booleanFlags = new Set(["--live", "--root-go-after-review", "--confirm-close-fixture"]);
  const seenSingle = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--allow-target") {
      index += 1;
      continue;
    }
    if (valueFlags.has(name)) {
      if (seenSingle.has(name)) throw new ProbeFailure("DUPLICATE_ARGUMENT", `${name} may be supplied only once.`);
      seenSingle.add(name);
      index += 1;
      continue;
    }
    if (booleanFlags.has(name)) {
      if (seenSingle.has(name)) throw new ProbeFailure("DUPLICATE_ARGUMENT", `${name} may be supplied only once.`);
      seenSingle.add(name);
      continue;
    }
    throw new ProbeFailure("UNKNOWN_ARGUMENT", `Unknown argument ${name}.`);
  }
}

export function parseProbeArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { mode: "help" };
  if (argv.includes("--selftest")) return { mode: "selftest" };
  if (!argv.includes("--live")) {
    throw new ProbeFailure("LIVE_MODE_GATED", "No live CUA calls are made without --live after root review and GO.");
  }
  if (!argv.includes("--root-go-after-review")) {
    throw new ProbeFailure("ROOT_GO_REQUIRED", "Live mode requires --root-go-after-review after the combined review.");
  }
  if (!argv.includes("--confirm-close-fixture")) {
    throw new ProbeFailure("CLOSE_FIXTURE_CONFIRMATION_REQUIRED", "Live mode requires explicit confirmation that the close target is a saved test fixture.");
  }
  assertKnownArguments(argv);

  const initialTarget = parseWindowTarget(optionValue(argv, "--initial-target"), "--initial-target");
  const destinationTarget = parseWindowTarget(optionValue(argv, "--destination-target"), "--destination-target");
  const closeTarget = parseWindowTarget(optionValue(argv, "--close-target"), "--close-target");
  const allowedTargets = repeatedValues(argv, "--allow-target").map((value, index) => parseWindowTarget(value, `--allow-target[${index + 1}]`));
  const targetKeys = [initialTarget, destinationTarget, closeTarget].map(identityKey);
  if (new Set(targetKeys).size !== 3) throw new ProbeFailure("TARGETS_MUST_BE_DISTINCT", "Initial, destination, and close-fixture targets must be three distinct windows.");
  if (allowedTargets.length !== 3 || new Set(allowedTargets.map(identityKey)).size !== 3 ||
      targetKeys.some((key) => !allowedTargets.some((target) => identityKey(target) === key))) {
    throw new ProbeFailure("EXACT_SCOPE_REQUIRED", "Pass exactly three --allow-target values, one for each declared test window.");
  }

  const initial = {
    target: initialTarget,
    appName: safeAppName(optionValue(argv, "--initial-app"), "--initial-app"),
    title: validateFixtureTitle(optionValue(argv, "--initial-title"), "--initial-title"),
  };
  const destination = {
    target: destinationTarget,
    appName: safeAppName(optionValue(argv, "--destination-app"), "--destination-app"),
    title: validateFixtureTitle(optionValue(argv, "--destination-title"), "--destination-title"),
  };
  const closeFixture = {
    target: closeTarget,
    appName: safeAppName(optionValue(argv, "--close-app"), "--close-app"),
    title: validateFixtureTitle(optionValue(argv, "--close-title"), "--close-title"),
  };
  if (new Set([initial.title, destination.title, closeFixture.title]).size !== 3) {
    throw new ProbeFailure("FIXTURE_TITLES_MUST_BE_DISTINCT", "Each test window needs a distinct synthetic HarnessProbe-* title.");
  }
  const socketPath = optionValue(argv, "--socket");
  if (!/^[A-Za-z0-9._:/\\-]{1,512}$/u.test(socketPath)) {
    throw new ProbeFailure("INVALID_SOCKET_PATH", "--socket must be an ASCII CUA pipe/path identifier.");
  }
  return {
    mode: "live",
    socketPath,
    initial,
    destination,
    closeFixture,
    allowedTargets,
  };
}

function identityKey(target) {
  return `${target.pid}:${target.windowId}`;
}

function sameIdentity(left, right) {
  return left?.pid === right?.pid && left?.windowId === right?.windowId;
}

function requireInventoryEntry(windows, role) {
  const entry = windows.find((window) => sameIdentity(window.target, role.target));
  if (entry === undefined || entry.appName !== role.appName || entry.title !== role.title) {
    throw new ProbeFailure("FIXTURE_TARGET_MISMATCH", `The exact ${role.title} fixture is not present in CUA inventory.`);
  }
  return entry;
}

export function assertActionRefusal(receipt, driverCode) {
  if ((receipt?.status !== "refused" && receipt?.status !== "failed") || receipt.driverCode !== driverCode ||
      Object.hasOwn(receipt, "sessionAfter")) {
    throw new ProbeFailure("EXPECTED_REFUSAL_MISSING", `Expected ${driverCode} without a session change.`);
  }
  return receipt;
}

export function validateCaptureViewport(captureViewport, expectedViewport) {
  if (expectedViewport !== undefined &&
      (captureViewport?.width !== expectedViewport.width || captureViewport?.height !== expectedViewport.height ||
       captureViewport?.coordinateSpace !== expectedViewport.coordinateSpace)) {
    throw new ProbeFailure("SESSION_CAPTURE_VIEWPORT_MISMATCH", "Fresh capture viewport differed from the just-committed session binding.");
  }
  if (!Number.isSafeInteger(captureViewport?.width) || captureViewport.width <= 0 ||
      !Number.isSafeInteger(captureViewport?.height) || captureViewport.height <= 0 ||
      captureViewport.coordinateSpace !== "physical") {
    throw new ProbeFailure("OBSERVATION_VIEWPORT_INVALID", "Capture did not return a valid physical viewport.");
  }
  return captureViewport;
}

function safeRoleName(value) {
  return /^[A-Za-z0-9._-]{1,72}$/u.test(value) ? value : "non-ascii-label";
}

function summarizeSession(session) {
  return {
    id: String(session.id),
    backend: session.backend,
    viewport: { ...session.viewport },
    capabilities: { ...session.capabilities },
    openedAt: session.openedAt,
  };
}

function parseWindowsForAudit(result) {
  if (typeof result?.structuredJson !== "string") return [];
  try {
    const data = JSON.parse(result.structuredJson);
    if (!Array.isArray(data?.windows)) return [];
    return data.windows.flatMap((window) => {
      if (!window || typeof window !== "object") return [];
      const pid = Number(window.pid);
      const windowId = Number(window.window_id);
      const bounds = window.bounds;
      if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(windowId) || windowId <= 0 ||
          !bounds || typeof bounds !== "object") return [];
      return [{
        pid,
        windowId,
        bounds: {
          x: Number.isSafeInteger(bounds.x) ? bounds.x : undefined,
          y: Number.isSafeInteger(bounds.y) ? bounds.y : undefined,
          width: Number.isSafeInteger(bounds.width) ? bounds.width : undefined,
          height: Number.isSafeInteger(bounds.height) ? bounds.height : undefined,
        },
      }];
    });
  } catch {
    return [];
  }
}

function isPositiveRect(rect) {
  return rect !== undefined && Number.isSafeInteger(rect.x) && Number.isSafeInteger(rect.y) &&
    Number.isSafeInteger(rect.width) && rect.width > 0 && Number.isSafeInteger(rect.height) && rect.height > 0;
}

function makeInstrumentedDriverFactory(CuaDriver, audit, sessionLabel, allowedTargets) {
  const allowed = new Set(allowedTargets.map(identityKey));
  return (socketPath) => {
    const driver = CuaDriver.connect(socketPath);
    return new Proxy(driver, {
      get(nativeDriver, property) {
        const original = Reflect.get(nativeDriver, property, nativeDriver);
        if (property === "verifyState") {
          return async (input, options) => {
            const target = { pid: Number(input?.pid), windowId: Number(input?.windowId) };
            if (!allowed.has(identityKey(target))) {
              audit.blockedToolAttempts.push("verify_state");
              throw new ProbeFailure("OUT_OF_SCOPE_CAPTURE", "Blocked a capture outside the explicit three-window scope.");
            }
            const result = await Reflect.apply(original, nativeDriver, [input, options]);
            audit.captures.push({
              target: identityKey(target),
              isError: result?.isError === true,
              degraded: result?.degraded === true,
              imageCount: Array.isArray(result?.images) ? result.images.length : 0,
              stable: result?.verification?.stable === true,
            });
            return result;
          };
        }
        if (property === "callTool") {
          return async (name, inputJson, options) => {
            let input;
            try { input = JSON.parse(inputJson); }
            catch {
              audit.blockedToolAttempts.push("invalid_arguments");
              throw new ProbeFailure("INVALID_DRIVER_ARGUMENTS", "Blocked invalid driver arguments.");
            }
            if (input?.session !== sessionLabel) {
              audit.blockedToolAttempts.push("wrong_session");
              throw new ProbeFailure("DRIVER_SESSION_MISMATCH", "Blocked a CUA call outside the private probe session.");
            }
            if (name === "list_windows") {
              if (typeof input.on_screen_only !== "boolean" || input.pid !== undefined && (!Number.isSafeInteger(input.pid) || input.pid <= 0)) {
                audit.blockedToolAttempts.push("invalid_inventory_filter");
                throw new ProbeFailure("INVALID_INVENTORY_FILTER", "Blocked an invalid window inventory request.");
              }
              const result = await Reflect.apply(original, nativeDriver, [name, inputJson, options]);
              const windows = parseWindowsForAudit(result);
              for (const window of windows) {
                if (allowed.has(identityKey(window))) audit.lastBounds.set(identityKey(window), window.bounds);
              }
              audit.inventories.push({
                onScreenOnly: input.on_screen_only,
                pidFilterPresent: input.pid !== undefined,
                returnedWindowCount: windows.length,
                allowedWindowCount: windows.filter((window) => allowed.has(identityKey(window))).length,
                isError: result?.isError === true,
                degraded: result?.degraded === true,
              });
              return result;
            }
            if (name === "bring_to_front") {
              const target = { pid: Number(input?.pid), windowId: Number(input?.window_id) };
              if (!allowed.has(identityKey(target))) {
                audit.blockedToolAttempts.push("out_of_scope_activation");
                throw new ProbeFailure("OUT_OF_SCOPE_ACTIVATION", "Blocked activation outside the explicit three-window scope.");
              }
              const result = await Reflect.apply(original, nativeDriver, [name, inputJson, options]);
              audit.activations.push({ target: identityKey(target), isError: result?.isError === true, degraded: result?.degraded === true });
              return result;
            }
            if (name === "get_window_state") {
              const target = { pid: Number(input?.pid), windowId: Number(input?.window_id) };
              if (!allowed.has(identityKey(target))) {
                audit.blockedToolAttempts.push("out_of_scope_window_state");
                throw new ProbeFailure("OUT_OF_SCOPE_WINDOW_STATE", "Blocked a window-state query outside the explicit scope.");
              }
              const result = await Reflect.apply(original, nativeDriver, [name, inputJson, options]);
              audit.windowStateReads.push({ target: identityKey(target), isError: result?.isError === true, degraded: result?.degraded === true });
              return result;
            }
            audit.blockedToolAttempts.push(name.replace(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 64));
            throw new ProbeFailure("INPUT_TOOL_BLOCKED", "The live probe blocks all application input tools.");
          };
        }
        return typeof original === "function" ? original.bind(nativeDriver) : original;
      },
    });
  };
}

async function createOutputDir() {
  await mkdir(OUTPUT_ROOT, { recursive: true });
  const runId = `${new Date().toISOString().replace(/[.:]/gu, "-")}-${randomUUID()}`;
  const directory = join(OUTPUT_ROOT, runId);
  await mkdir(directory, { recursive: false });
  return { directory, runId, relativeDirectory: `${OUTPUT_ROOT_RELATIVE}/${runId}` };
}

async function saveManifest(path, manifest) {
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  if (/[\uFFFD]|\?{3,}/u.test(text)) throw new ProbeFailure("MANIFEST_ENCODING_INVALID", "Probe manifest contains a text-encoding corruption marker.");
  await writeFile(path, text, "utf8");
  const roundTrip = await readFile(path, "utf8");
  if (roundTrip !== text) throw new ProbeFailure("MANIFEST_ROUNDTRIP_FAILED", "Probe manifest did not round-trip as UTF-8.");
}

function sameRect(left, right) {
  return left !== undefined && right !== undefined && left.x === right.x && left.y === right.y &&
    left.width === right.width && left.height === right.height;
}

async function promptExact(terminal, message, expected) {
  const answer = (await terminal.question(`${message}\nType exactly: ${expected}\n> `)).trim();
  if (answer !== expected) throw new ProbeFailure("OPERATOR_CONFIRMATION_MISMATCH", "Confirmation did not match; no further CUA action was attempted.");
}

async function observeWithoutPersistingScreenshot(computer, session, role, audit, signal, manifest, manifestPath, expectedViewport) {
  const observationId = `cross-window-${randomUUID()}`;
  const capture = await computer.observe(session, observationId, signal);
  const viewport = validateCaptureViewport(capture.viewport, expectedViewport);
  const record = {
    role,
    observationId,
    computerSessionId: String(session.id),
    capturedAt: capture.capturedAt,
    viewport: { ...viewport },
    screenshotBytesNotPersisted: capture.screenshot.data.byteLength > 0,
  };
  manifest.observations.push(record);
  await saveManifest(manifestPath, manifest);
  // Drop the only local screenshot-byte reference before returning.
  capture.screenshot.data.fill(0);
  return { id: observationId, viewport: record.viewport };
}

async function runLive(options) {
  if (!/^24\./u.test(process.versions.node)) {
    throw new ProbeFailure("NODE24_REQUIRED", "Live CUA mode requires the configured Node 24 runtime.");
  }
  if (!stdin.isTTY || !stdout.isTTY) throw new ProbeFailure("TTY_REQUIRED", "Live probe requires a local TTY; no CUA call was made.");
  const terminal = createInterface({ input: stdin, output: stdout, crlfDelay: Infinity });
  const abortController = new AbortController();
  const onSigInt = () => {
    if (!abortController.signal.aborted) abortController.abort(new ProbeFailure("OPERATOR_ABORT", "Interrupted by operator."));
    terminal.close();
  };
  process.on("SIGINT", onSigInt);
  let computer;
  let session;
  let manifestPath;
  let manifest;
  let failure;
  try {
    await promptExact(
      terminal,
      "This gated live probe activates only the three exact test HWNDs and blocks click/type/key input. Confirm the root-reviewed local test scope.",
      "ROOT GO CROSS-WINDOW CUA PROBE",
    );

    const output = await createOutputDir();
    manifestPath = join(output.directory, "probe.json");
    manifest = {
      schemaVersion: 1,
      runId: output.runId,
      status: "starting",
      startedAt: new Date().toISOString(),
      fixtureRoles: {
        initial: { appLabel: safeRoleName(options.initial.appName), target: identityKey(options.initial.target) },
        destination: { appLabel: safeRoleName(options.destination.appName), target: identityKey(options.destination.target) },
        closeFixture: { appLabel: safeRoleName(options.closeFixture.appName), target: identityKey(options.closeFixture.target) },
      },
      exactThreeWindowScope: true,
      windowTitlesPersisted: false,
      screenshotsPersisted: false,
      desktopCaptureAllowed: false,
      appInputToolsBlocked: true,
      inventories: [],
      activations: [],
      captures: [],
      windowStateReads: [],
      blockedToolAttempts: [],
      observations: [],
      checks: {},
    };
    await saveManifest(manifestPath, manifest);

    const [{ CuaDriverComputer, CuaWindowDiscovery }, { CuaDriver }] = await Promise.all([
      import("../../packages/computer-cua/dist/index.js"),
      import("../../packages/computer-cua/node_modules/@trycua/cua-driver/dist/index.js"),
    ]);
    const discovery = new CuaWindowDiscovery({ socketPath: options.socketPath, sessionLabel: `cross-window-preflight-${output.runId}` });
    const signal = AbortSignal.any([abortController.signal, AbortSignal.timeout(20 * 60_000)]);
    const fullInventory = await discovery.listWindows(signal, false);
    const onScreenInventory = await discovery.listWindows(signal, true);
    const initialEntry = requireInventoryEntry(fullInventory, options.initial);
    const destinationEntry = requireInventoryEntry(fullInventory, options.destination);
    const closeEntry = requireInventoryEntry(fullInventory, options.closeFixture);
    if (!onScreenInventory.some((window) => sameIdentity(window.target, options.initial.target))) {
      throw new ProbeFailure("INITIAL_TARGET_NOT_ON_SCREEN", "Initial test window is not in the fresh on-screen inventory; no session opened.");
    }
    const visibleKeys = new Set(onScreenInventory.map((window) => identityKey(window.target)));
    manifest.preflight = {
      requestedOnScreenOnly: [false, true],
      fullInventoryCount: fullInventory.length,
      onScreenInventoryCount: onScreenInventory.length,
      initialOnScreen: true,
      destinationInFullOnly: !visibleKeys.has(identityKey(destinationEntry.target)),
      closeFixtureInFullOnly: !visibleKeys.has(identityKey(closeEntry.target)),
      minimizedStateReported: false,
    };
    await saveManifest(manifestPath, manifest);

    const sessionLabel = `cross-window-cua-${output.runId}`;
    const audit = {
      inventories: manifest.inventories,
      activations: manifest.activations,
      captures: manifest.captures,
      windowStateReads: manifest.windowStateReads,
      blockedToolAttempts: manifest.blockedToolAttempts,
      lastBounds: new Map(),
    };
    computer = new CuaDriverComputer({
      socketPath: options.socketPath,
      screenshotDir: join(output.directory, "unused-targeted-captures"),
      sessionLabel,
      windowTarget: options.initial.target,
      windowDeliveryMode: "foreground",
      grounding: "off",
      windowSwitch: "opened-windows-v1",
      windowSwitchAllowedTargets: options.allowedTargets,
      driverFactory: makeInstrumentedDriverFactory(CuaDriver, audit, sessionLabel, options.allowedTargets),
    });
    session = await computer.open({}, signal);
    manifest.status = "opened";
    manifest.openedSession = summarizeSession(session);
    await saveManifest(manifestPath, manifest);

    const initialObservation = await observeWithoutPersistingScreenshot(computer, session, "initial", audit, signal, manifest, manifestPath, session.viewport);
    let optionsBefore = await computer.listWindows(session, signal);
    if (optionsBefore.length !== 3) throw new ProbeFailure("AUTHORIZED_OPTION_COUNT_MISMATCH", "Expected exactly the three host-authorized test windows.");
    const initialOption = selectUniqueWindowOption(optionsBefore, { appName: options.initial.appName, title: options.initial.title, isCurrent: true }, "initial");
    const firstDestination = selectUniqueWindowOption(optionsBefore, { appName: options.destination.appName, title: options.destination.title, isCurrent: false }, "destination");
    selectUniqueWindowOption(optionsBefore, { appName: options.closeFixture.appName, title: options.closeFixture.title, isCurrent: false }, "close fixture");

    optionsBefore = await computer.listWindows(session, signal);
    const freshDestination = selectUniqueWindowOption(optionsBefore, { appName: options.destination.appName, title: options.destination.title, isCurrent: false }, "refreshed destination");
    const activationCountBeforeStale = audit.activations.length;
    const staleRefreshReceipt = await computer.execute(session, {
      actionId: `probe-stale-refresh-${randomUUID()}`,
      basedOn: initialObservation.id,
      kind: "switch_window",
      windowRef: firstDestination.windowRef,
    }, signal);
    assertActionRefusal(staleRefreshReceipt, "WINDOW_REF_STALE");
    if (audit.activations.length !== activationCountBeforeStale) {
      throw new ProbeFailure("STALE_REF_ACTIVATED", "A ref from before list refresh caused window activation.");
    }
    manifest.checks.staleRefAfterListRefresh = "passed";

    const sourceObservation = await observeWithoutPersistingScreenshot(computer, session, "source-after-refresh", audit, signal, manifest, manifestPath);
    const destinationActivationStart = audit.activations.length;
    const destinationReceipt = await computer.execute(session, {
      actionId: `probe-switch-destination-${randomUUID()}`,
      basedOn: sourceObservation.id,
      kind: "switch_window",
      windowRef: freshDestination.windowRef,
    }, signal);
    session = assertCompletedSwitch(destinationReceipt, session);
    if (audit.activations.length !== destinationActivationStart + 1 ||
        audit.activations.at(-1)?.target !== identityKey(options.destination.target)) {
      throw new ProbeFailure("DESTINATION_ACTIVATION_MISMATCH", "Destination switch did not activate exactly its selected HWND once.");
    }
    const destinationObservation = await observeWithoutPersistingScreenshot(computer, session, "destination", audit, signal, manifest, manifestPath, session.viewport);
    manifest.switchSessions = [{ role: "destination", session: summarizeSession(session), observationId: destinationObservation.id }];
    manifest.checks.destinationFreshCapture = "passed";
    await saveManifest(manifestPath, manifest);

    let currentOptions = await computer.listWindows(session, signal);
    const returnOption = selectUniqueWindowOption(currentOptions, { appName: options.initial.appName, title: options.initial.title, isCurrent: false }, "return target");
    const returnStart = audit.activations.length;
    const returnReceipt = await computer.execute(session, {
      actionId: `probe-return-initial-${randomUUID()}`,
      basedOn: destinationObservation.id,
      kind: "switch_window",
      windowRef: returnOption.windowRef,
    }, signal);
    session = assertCompletedSwitch(returnReceipt, session);
    if (audit.activations.length !== returnStart + 1 || audit.activations.at(-1)?.target !== identityKey(options.initial.target)) {
      throw new ProbeFailure("RETURN_ACTIVATION_MISMATCH", "Return switch did not activate exactly the original HWND once.");
    }
    const sourceAgain = await observeWithoutPersistingScreenshot(computer, session, "initial-after-round-trip", audit, signal, manifest, manifestPath, session.viewport);
    manifest.switchSessions.push({ role: "initial-return", session: summarizeSession(session), observationId: sourceAgain.id });
    manifest.checks.nativeRoundTrip = "passed";
    currentOptions = await computer.listWindows(session, signal);

    const beforeResizeBounds = audit.lastBounds.get(identityKey(options.initial.target));
    if (!isPositiveRect(beforeResizeBounds)) throw new ProbeFailure("RESIZE_BASELINE_BOUNDS_MISSING", "No verified target bounds were observed before resize.");
    await promptExact(
      terminal,
      `Resize only the saved test window ${options.initial.title} with Sky. Do not edit or close its document. Return the initial window to the foreground before continuing.`,
      `RESIZED ${identityKey(options.initial.target)}`,
    );
    const postResizeObservation = await observeWithoutPersistingScreenshot(computer, session, "initial-after-resize", audit, signal, manifest, manifestPath);
    const afterResizeBounds = audit.lastBounds.get(identityKey(options.initial.target));
    if (!isPositiveRect(afterResizeBounds) || sameRect(beforeResizeBounds, afterResizeBounds)) {
      throw new ProbeFailure("RESIZE_NOT_OBSERVED", "The initial test target bounds did not change; no input was dispatched.");
    }
    let staleGeometryReceipt;
    try {
      staleGeometryReceipt = await computer.execute(session, {
        actionId: `probe-stale-geometry-${randomUUID()}`,
        basedOn: sourceAgain.id,
        kind: "click",
        point: { x: 1, y: 1 },
      }, signal, { executionObservationId: postResizeObservation.id });
    } catch (error) {
      if (audit.blockedToolAttempts.length > 0) {
        throw new ProbeFailure("RESIZE_GUARD_DID_NOT_REFUSE", "The geometry guard reached the probe's input blocker instead of refusing before dispatch.");
      }
      throw error;
    }
    assertActionRefusal(staleGeometryReceipt, "WINDOW_GEOMETRY_CHANGED");
    if (audit.blockedToolAttempts.length > 0) {
      throw new ProbeFailure("INPUT_TOOL_REACHED_DRIVER", "The stale-geometry guard did not stop before a native input call.");
    }
    manifest.checks.resizeInvalidatesOldCoordinates = "passed";
    manifest.resize = { before: beforeResizeBounds, after: afterResizeBounds };

    const closeOption = selectUniqueWindowOption(currentOptions, { appName: options.closeFixture.appName, title: options.closeFixture.title, isCurrent: false }, "close fixture");
    const activationCountBeforeClose = audit.activations.length;
    await promptExact(
      terminal,
      `Use Sky to close only the saved test fixture ${options.closeFixture.title} (${options.closeFixture.appName}). Do not close the app or any other window. If a save prompt appears, stop and do not save. Re-list windows in Sky and confirm this fixture is absent.`,
      `CLOSED ${identityKey(options.closeFixture.target)}`,
    );
    const sourceAfterClose = await observeWithoutPersistingScreenshot(computer, session, "initial-after-close-fixture", audit, signal, manifest, manifestPath);
    const closedTargetReceipt = await computer.execute(session, {
      actionId: `probe-closed-target-${randomUUID()}`,
      basedOn: sourceAfterClose.id,
      kind: "switch_window",
      windowRef: closeOption.windowRef,
    }, signal);
    assertActionRefusal(closedTargetReceipt, "WINDOW_SWITCH_STALE");
    if (audit.activations.length !== activationCountBeforeClose) {
      throw new ProbeFailure("CLOSED_TARGET_ACTIVATED", "The adapter attempted activation of a target absent from the fresh inventory.");
    }
    manifest.checks.closedNonCurrentTargetRejected = "passed";
    manifest.status = "completed";
    manifest.finishedAt = new Date().toISOString();
    await saveManifest(manifestPath, manifest);
  } catch (error) {
    failure = error;
    if (manifest !== undefined) {
      manifest.status = "failed_closed";
      manifest.errorCode = error instanceof ProbeFailure ? error.code : "UNEXPECTED_ERROR";
      manifest.finishedAt = new Date().toISOString();
      await saveManifest(manifestPath, manifest).catch(() => undefined);
    }
    throw error;
  } finally {
    if (computer !== undefined && session !== undefined) {
      try {
        await computer.close(session);
        if (manifest !== undefined) manifest.cleanupConfirmed = true;
      } catch {
        if (manifest !== undefined) {
          manifest.cleanupConfirmed = false;
          manifest.cleanupPending = true;
          manifest.status = "failed_closed";
          manifest.errorCode = "CLEANUP_UNCONFIRMED";
        }
        process.exitCode = 1;
      }
    }
    if (manifest !== undefined && manifestPath !== undefined) {
      manifest.finishedAt ??= new Date().toISOString();
      await saveManifest(manifestPath, manifest).catch(() => undefined);
      if (manifest.status !== "completed" || manifest.cleanupConfirmed !== true) process.exitCode = 1;
      else stdout.write(`${JSON.stringify({ stage: "completed", outputDirectory: `${OUTPUT_ROOT_RELATIVE}/${manifest.runId}`, minimizedStatusReported: false, screenshotsPersisted: false })}\n`);
    }
    process.off("SIGINT", onSigInt);
    terminal.close();
    if (failure !== undefined && process.exitCode === undefined) process.exitCode = 1;
  }
}

export async function runSelftest() {
  const start = parseWindowTarget("1234:5678", "fixture target");
  const title = validateFixtureTitle("HarnessProbe-Notepad-A", "fixture title");
  const options = [
    { windowRef: `win-${"a".repeat(8)}-${"b".repeat(4)}-${"c".repeat(4)}-${"d".repeat(4)}-${"e".repeat(12)}`, appName: "Notepad", title, isCurrent: true },
    { windowRef: `win-${"1".repeat(8)}-${"2".repeat(4)}-${"3".repeat(4)}-${"4".repeat(4)}-${"5".repeat(12)}`, appName: "WPS", title: "HarnessProbe-WPS-B", isCurrent: false },
  ];
  assertOpaqueWindowOption(options[0]);
  if (selectUniqueWindowOption(options, { appName: "Notepad", title, isCurrent: true }, "source") !== options[0]) {
    throw new ProbeFailure("SELFTEST_SELECTION_FAILED", "Unique option selection failed.");
  }
  const before = {
    id: "session-before",
    backend: "cua-driver-daemon",
    viewport: { width: 800, height: 600, coordinateSpace: "physical" },
    capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false },
    openedAt: new Date().toISOString(),
  };
  const after = { ...before, viewport: { width: 640, height: 480, coordinateSpace: "physical" } };
  if (assertCompletedSwitch({ status: "completed", sessionAfter: after }, before) !== after) {
    throw new ProbeFailure("SELFTEST_SESSION_FAILED", "Valid sessionAfter was rejected.");
  }
  let duplicateRejected = false;
  try { selectUniqueWindowOption([...options, { ...options[0], windowRef: options[1].windowRef }], { appName: "Notepad", title }, "duplicate"); }
  catch (error) { duplicateRejected = error instanceof ProbeFailure && error.code === "WINDOW_OPTION_AMBIGUOUS"; }
  if (!duplicateRejected) throw new ProbeFailure("SELFTEST_AMBIGUITY_FAILED", "Duplicate options were not rejected.");
  let unsafeTitleRejected = false;
  try { validateFixtureTitle("Quarterly Report - Alice"); }
  catch (error) { unsafeTitleRejected = error instanceof ProbeFailure && error.code === "UNSAFE_FIXTURE_LABEL"; }
  if (!unsafeTitleRejected) throw new ProbeFailure("SELFTEST_TITLE_FAILED", "A non-synthetic title was accepted.");
  let missingRootGateRejected = false;
  try { parseProbeArgs(["--live"]); }
  catch (error) { missingRootGateRejected = error instanceof ProbeFailure && error.code === "ROOT_GO_REQUIRED"; }
  if (!missingRootGateRejected) throw new ProbeFailure("SELFTEST_ROOT_GATE_FAILED", "Live mode did not require root GO.");
  const resizedCapture = { width: 640, height: 480, coordinateSpace: "physical" };
  if (validateCaptureViewport(resizedCapture) !== resizedCapture) {
    throw new ProbeFailure("SELFTEST_RESIZE_CAPTURE_FAILED", "An ordinary resize observation did not retain its fresh viewport.");
  }
  let switchViewportMismatchRejected = false;
  try { validateCaptureViewport(resizedCapture, before.viewport); }
  catch (error) { switchViewportMismatchRejected = error instanceof ProbeFailure && error.code === "SESSION_CAPTURE_VIEWPORT_MISMATCH"; }
  if (!switchViewportMismatchRejected) {
    throw new ProbeFailure("SELFTEST_SWITCH_VIEWPORT_FAILED", "A switch capture mismatch was not distinguished from ordinary resize.");
  }
  assertActionRefusal({ actionId: "fixture", status: "refused", driverCode: "WINDOW_GEOMETRY_CHANGED" }, "WINDOW_GEOMETRY_CHANGED");
  return { target: identityKey(start), fixtureTitle: title, checks: 7 };
}

function helpText() {
  return [
    "Usage:",
    "  node scripts/cross-window/cua-probe.mjs --help",
    "  node scripts/cross-window/cua-probe.mjs --selftest",
    "  node scripts/cross-window/cua-probe.mjs --live --root-go-after-review --confirm-close-fixture --socket <pipe> --initial-target PID:HWND --destination-target PID:HWND --close-target PID:HWND --allow-target PID:HWND --allow-target PID:HWND --allow-target PID:HWND --initial-app <name> --initial-title HarnessProbe-* --destination-app <name> --destination-title HarnessProbe-* --close-app <name> --close-title HarnessProbe-*",
    "Live mode requires a TTY and exact typed confirmation after the combined review and root GO.",
    "Live mode also requires the configured Node 24 runtime.",
    "It runs the project CUA adapter with an exact three-window host scope, verifies opaque refs, fresh captures, a native round trip, stale refs, resize invalidation, and a closed noncurrent target.",
    "The driver wrapper permits only list_windows, verify_state capture, get_window_state, and exact bring_to_front. All click/type/key input tools are blocked.",
    "The script pauses for Sky to resize the initial saved synthetic fixture and to close only the predeclared saved test fixture. Do not touch user documents or close an application.",
    "Screenshots remain in memory and are discarded. The ASCII-only manifest is written under ignored runs/diagnostics/cross-window-cua-probe/; window titles are never persisted.",
    "on_screen_only:false requests CUA's unfiltered top-level inventory. The script reports full-inventory-only candidates, never infers a minimized state from that flag.",
  ].join("\n") + "\n";
}

async function main() {
  const parsed = parseProbeArgs(process.argv.slice(2));
  if (parsed.mode === "help") {
    stdout.write(helpText());
    return;
  }
  if (parsed.mode === "selftest") {
    stdout.write(`${JSON.stringify({ status: "passed", ...await runSelftest() })}\n`);
    return;
  }
  await runLive(parsed);
}

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === modulePath) {
  main().catch((error) => {
    const code = error instanceof ProbeFailure ? error.code : "UNEXPECTED_ERROR";
    stderr.write(`Cross-window CUA probe stopped safely (${code}). No app input will be retried.\n`);
    process.exitCode = 1;
  });
}
