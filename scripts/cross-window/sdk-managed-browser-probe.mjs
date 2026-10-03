#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_INVENTORY = 512;
const CALL_IDS = Object.freeze({
  initialList: "sdk-probe-list-initial",
  switchToWps: "sdk-probe-switch-to-wps",
  wpsList: "sdk-probe-list-wps",
  switchToBrowser: "sdk-probe-switch-to-browser",
});

export class ProbeFailure extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProbeFailure";
    this.code = code;
  }
}

export function parseProbeArgs(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) return { mode: "help" };
  if (argv.length === 1 && argv[0] === "--self-test") return { mode: "self-test" };
  const booleans = new Set(["--live", "--root-go-after-review", "--confirm-synthetic-only"]);
  const values = new Set(["--socket", "--managed-browser-url", "--native-target", "--fixture-title"]);
  const flags = new Set();
  const parsedValues = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (booleans.has(name)) {
      if (flags.has(name)) throw new ProbeFailure("DUPLICATE_ARGUMENT", name + " may be supplied only once.");
      flags.add(name);
      continue;
    }
    if (values.has(name)) {
      if (parsedValues.has(name)) throw new ProbeFailure("DUPLICATE_ARGUMENT", name + " may be supplied only once.");
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new ProbeFailure("MISSING_ARGUMENT_VALUE", name + " requires a value.");
      parsedValues.set(name, value);
      index += 1;
      continue;
    }
    throw new ProbeFailure("UNKNOWN_ARGUMENT", "Unknown argument " + name + ".");
  }
  if (!flags.has("--live")) throw new ProbeFailure("LIVE_MODE_GATED", "No SDK or computer action is permitted without --live after review.");
  if (!flags.has("--root-go-after-review")) throw new ProbeFailure("ROOT_GO_REQUIRED", "Live SDK actions require explicit root GO after the combined review.");
  if (!flags.has("--confirm-synthetic-only")) throw new ProbeFailure("SYNTHETIC_FIXTURE_CONFIRMATION_REQUIRED", "Live SDK actions require one newly created, saved ASCII WPS fixture and an ephemeral managed browser.");
  const socket = requiredValue(parsedValues, "--socket");
  if (!/^[A-Za-z0-9._:/\\-]{1,512}$/u.test(socket)) {
    throw new ProbeFailure("INVALID_SOCKET", "--socket must be an ASCII CUA pipe/path identifier.");
  }
  return {
    mode: "live",
    socket,
    managedBrowserUrl: validatePublicTestUrl(requiredValue(parsedValues, "--managed-browser-url")),
    nativeTarget: parseWindowTarget(requiredValue(parsedValues, "--native-target")),
    fixtureTitle: validateFixtureTitle(requiredValue(parsedValues, "--fixture-title")),
  };
}

export function parseWindowTarget(value) {
  if (typeof value !== "string" || !/^\d+:\d+$/u.test(value)) {
    throw new ProbeFailure("INVALID_TARGET", "--native-target must be positive PID:HWND safe integers.");
  }
  const [pidText, windowIdText] = value.split(":");
  const pid = Number(pidText);
  const windowId = Number(windowIdText);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(windowId) || windowId <= 0) {
    throw new ProbeFailure("INVALID_TARGET", "--native-target must be positive PID:HWND safe integers.");
  }
  return { pid, windowId };
}

export function validateFixtureTitle(value) {
  if (typeof value !== "string" || !/^HarnessProbe-[A-Za-z0-9._-]{1,64}(?:\.docx - WPS Office)?$/u.test(value)) {
    throw new ProbeFailure("UNSAFE_FIXTURE_TITLE", "--fixture-title must be an exact ASCII HarnessProbe-* name, optionally with the standard '.docx - WPS Office' title suffix.");
  }
  return value;
}

export function validatePublicTestUrl(value) {
  if (value === "about:blank") return value;
  if (typeof value !== "string" || value !== value.trim() || value.length > 512) {
    throw new ProbeFailure("INVALID_BROWSER_URL", "--managed-browser-url must be about:blank or a bounded public HTTP(S) URL.");
  }
  let url;
  try { url = new URL(value); }
  catch { throw new ProbeFailure("INVALID_BROWSER_URL", "--managed-browser-url must be about:blank or a complete public HTTP(S) URL."); }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const localHost = hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal");
  const ipLiteral = /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostname) || hostname.includes(":");
  if ((url.protocol !== "http:" && url.protocol !== "https:") || hostname.length === 0 || localHost || ipLiteral ||
      url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0) {
    throw new ProbeFailure("INVALID_BROWSER_URL", "Test URL must be public credential-free HTTP(S) with no query or fragment.");
  }
  return url.toString();
}

export function validateNativeFixtureInventory(windows, target, fixtureTitle) {
  if (!Array.isArray(windows) || windows.length === 0 || windows.length > MAX_INVENTORY) {
    throw new ProbeFailure("FIXTURE_INVENTORY_INVALID", "The read-only native inventory was empty or outside its safety bound.");
  }
  const matches = windows.filter((window) => isRecord(window) && window.pid === target.pid && window.windowId === target.windowId);
  if (matches.length !== 1) throw new ProbeFailure("FIXTURE_TARGET_NOT_UNIQUE", "The requested target must appear exactly once in the read-only inventory.");
  const window = matches[0];
  if (typeof window.appName !== "string" || !/wps/iu.test(window.appName) || window.title !== fixtureTitle) {
    throw new ProbeFailure("FIXTURE_TARGET_MISMATCH", "The exact target must be WPS and its title must exactly match --fixture-title.");
  }
  return Object.freeze({ verified: true, target: copyTarget(target) });
}

export function buildExactTargetScope(nativeTargets, ownedBrowserTarget) {
  if (!Array.isArray(nativeTargets) || nativeTargets.length !== 1 || !validTarget(nativeTargets[0]) || !validTarget(ownedBrowserTarget)) {
    throw new ProbeFailure("TARGET_SCOPE_INVALID", "The probe requires exactly one verified WPS fixture and one resolved owned-browser target.");
  }
  if (sameTarget(nativeTargets[0], ownedBrowserTarget)) throw new ProbeFailure("TARGET_SCOPE_COLLISION", "The owned-browser target must differ from the WPS fixture.");
  return [copyTarget(nativeTargets[0]), copyTarget(ownedBrowserTarget)];
}

export function validateWindowInventory(output, fixtureTitle, expectedCurrent) {
  if (!Array.isArray(output) || output.length !== 2) {
    throw new ProbeFailure("WINDOW_INVENTORY_SCOPE_MISMATCH", "Expected only the WPS fixture and this Run's managed browser in the exact host scope.");
  }
  const windows = output.map((entry) => {
    if (!isRecord(entry)) throw new ProbeFailure("WINDOW_INVENTORY_INVALID", "A listed window entry was not an object.");
    const allowed = new Set(["windowRef", "appName", "title", "isCurrent"]);
    if (Object.keys(entry).some((key) => !allowed.has(key))) {
      throw new ProbeFailure("WINDOW_INVENTORY_PRIVATE_FIELD", "The public inventory contained an unexpected host-private field.");
    }
    if (typeof entry.windowRef !== "string" || entry.windowRef.length === 0 || entry.windowRef.length > 128 ||
        typeof entry.isCurrent !== "boolean" ||
        (entry.appName !== undefined && (typeof entry.appName !== "string" || entry.appName.length > 120)) ||
        (entry.title !== undefined && (typeof entry.title !== "string" || entry.title.length > 256))) {
      throw new ProbeFailure("WINDOW_INVENTORY_INVALID", "A listed entry failed the bounded public-field shape check.");
    }
    return entry;
  });
  if (new Set(windows.map((window) => window.windowRef)).size !== windows.length) {
    throw new ProbeFailure("WINDOW_INVENTORY_DUPLICATE_REF", "The inventory contained duplicate opaque references.");
  }
  const matches = windows.filter((window) => typeof window.appName === "string" && /wps/iu.test(window.appName) && window.title === fixtureTitle);
  if (matches.length !== 1) throw new ProbeFailure("WINDOW_FIXTURE_NOT_LISTED", "The actual inventory did not identify exactly one matching WPS fixture.");
  const wps = matches[0];
  const browser = windows.find((window) => window !== wps);
  if (browser === undefined || (typeof browser.appName === "string" && /wps/iu.test(browser.appName))) {
    throw new ProbeFailure("WINDOW_BROWSER_NOT_LISTED", "The other scoped inventory entry was not the managed-browser target.");
  }
  const current = expectedCurrent === "wps" ? wps : browser;
  const other = current === wps ? browser : wps;
  if (current.isCurrent !== true || other.isCurrent !== false) {
    throw new ProbeFailure("WINDOW_CURRENT_BINDING_MISMATCH", "The active binding did not match the expected roundtrip phase.");
  }
  return { wps, browser };
}

export function findCompletedToolOutput(input, callId) {
  const results = [];
  for (const message of input?.messages ?? []) {
    for (const block of message?.content ?? []) {
      if (block?.type === "tool_result" && block.result?.callId === callId) results.push(block.result);
    }
  }
  if (results.length !== 1 || results[0]?.status !== "completed") {
    throw new ProbeFailure("EXPECTED_TOOL_RESULT_MISSING", "The scripted Provider did not receive the preceding completed call result.");
  }
  return results[0].output;
}

export function createScriptedProvider({ fixtureTitle, getHostCloseCount = () => 0 }) {
  let step = 0;
  const callNames = [];
  const labelSelections = [];
  const provider = {
    id: "sdk-cross-window-scripted-no-network",
    async generate(input, { signal }) {
      signal.throwIfAborted();
      if (getHostCloseCount() !== 0) throw new ProbeFailure("MANAGED_BROWSER_CLOSED_DURING_RUN", "The managed browser closed before Run cleanup.");
      const names = new Set((input?.tools ?? []).map((tool) => tool?.name));
      if (!names.has("list_windows") || !names.has("switch_window")) {
        throw new ProbeFailure("WINDOW_SWITCH_TOOLS_MISSING", "The opt-in Run did not project the shared window-switch tools.");
      }
      if (step === 0) {
        step += 1;
        callNames.push("list_windows");
        return { type: "tool_calls", calls: [{ id: CALL_IDS.initialList, name: "list_windows", arguments: {} }] };
      }
      if (step === 1) {
        const { wps, browser } = validateWindowInventory(findCompletedToolOutput(input, CALL_IDS.initialList), fixtureTitle, "browser");
        if (wps.isCurrent || !browser.isCurrent) throw new ProbeFailure("INITIAL_BINDING_MISMATCH", "The managed browser was not the initial active binding.");
        labelSelections.push("wps");
        step += 1;
        callNames.push("switch_window");
        return { type: "tool_calls", calls: [{ id: CALL_IDS.switchToWps, name: "switch_window", arguments: { windowRef: wps.windowRef } }] };
      }
      if (step === 2) {
        findCompletedToolOutput(input, CALL_IDS.switchToWps);
        step += 1;
        callNames.push("list_windows");
        return { type: "tool_calls", calls: [{ id: CALL_IDS.wpsList, name: "list_windows", arguments: {} }] };
      }
      if (step === 3) {
        const { wps, browser } = validateWindowInventory(findCompletedToolOutput(input, CALL_IDS.wpsList), fixtureTitle, "wps");
        if (!wps.isCurrent || browser.isCurrent) throw new ProbeFailure("WPS_BINDING_MISMATCH", "WPS was not the active binding after the first switch.");
        labelSelections.push("owned-browser");
        step += 1;
        callNames.push("switch_window");
        return { type: "tool_calls", calls: [{ id: CALL_IDS.switchToBrowser, name: "switch_window", arguments: { windowRef: browser.windowRef } }] };
      }
      if (step === 4) {
        findCompletedToolOutput(input, CALL_IDS.switchToBrowser);
        step += 1;
        return { type: "finish", summary: "Returned to the Run-owned managed browser. No document content was edited." };
      }
      throw new ProbeFailure("SCRIPTED_PROVIDER_SEQUENCE_EXHAUSTED", "The scripted Provider received an unexpected extra decision request.");
    },
    async close() {},
    getAudit() { return { step, callNames: [...callNames], labelSelections: [...labelSelections] }; },
  };
  return provider;
}

export async function runLiveProbe(parsed, adapters) {
  if (parsed?.mode !== "live") throw new ProbeFailure("LIVE_MODE_GATED", "runLiveProbe accepts only a fully gated live invocation.");
  const windows = await adapters.discoverNativeWindows(parsed);
  const fixture = validateNativeFixtureInventory(windows, parsed.nativeTarget, parsed.fixtureTitle);
  return adapters.runVerifiedFixture(parsed, fixture);
}

export async function dispatchProbe(argv, loadAdapters) {
  const parsed = parseProbeArgs(argv);
  if (parsed.mode === "help") return { mode: "help", text: helpText() };
  if (parsed.mode === "self-test") return { mode: "self-test", result: await runOfflineSelfTest() };
  if (typeof loadAdapters !== "function") throw new ProbeFailure("LIVE_ADAPTERS_UNAVAILABLE", "Live SDK adapters were not supplied.");
  const adapters = await loadAdapters();
  return { mode: "live", result: await runLiveProbe(parsed, adapters) };
}

export function auditRoundtripEvents(events, providerAudit, runtimeState, managedBrowserUrl) {
  const starts = events.filter((event) => event.type === "action.execution.started");
  const completions = events.filter((event) => event.type === "action.execution.completed" && event.receipt?.status === "completed");
  const switchStarts = starts.filter((event) => event.action?.kind === "switch_window");
  if (starts.length !== 2 || switchStarts.length !== 2 || completions.length !== 2) {
    throw new ProbeFailure("ACTION_AUDIT_MISMATCH", "Only two scripted switch_window actions may execute and complete.");
  }
  if (providerAudit.callNames.length !== 4 || providerAudit.callNames.some((name) => name !== "list_windows" && name !== "switch_window") ||
      providerAudit.labelSelections.join(",") !== "wps,owned-browser") {
    throw new ProbeFailure("PROVIDER_AUDIT_MISMATCH", "The Provider used an unexpected call or selected outside the actual inventory.");
  }
  const initialOpen = events.find((event) => event.type === "computer.open.completed");
  const initialId = initialOpen?.session?.id;
  if (initialId === undefined) throw new ProbeFailure("INITIAL_SESSION_MISSING", "The initial managed-browser Computer session was not committed.");
  const transitions = switchStarts.map((started) => {
    const completed = completions.find((event) => event.receipt.actionId === started.action.actionId);
    const sessionAfter = completed?.receipt?.sessionAfter;
    if (completed === undefined || sessionAfter === undefined || sessionAfter.backend !== initialOpen.session.backend) {
      throw new ProbeFailure("SWITCH_RECEIPT_INVALID", "A switch did not commit a same-backend sessionAfter descriptor.");
    }
    const created = events.find((event) => event.type === "observation.created" && event.sequence > completed.sequence &&
      event.observation.computerSessionId === sessionAfter.id);
    if (created === undefined || created.observation.id === started.action.basedOn) {
      throw new ProbeFailure("FRESH_OBSERVATION_MISSING", "A switch lacked a fresh observation on its new binding.");
    }
    return { sessionAfter, observation: created.observation };
  });
  if (transitions.some((transition) => transition.sessionAfter.id !== initialId)) {
    throw new ProbeFailure("SESSION_ID_CHANGED", "A cross-window transition replaced the run-scoped ComputerSession identity.");
  }
  const wpsGrounding = transitions[0]?.observation.grounding;
  const returnGrounding = transitions[1]?.observation.grounding;
  const nativeHasDom = wpsGrounding?.elements?.some((element) => element.source === "dom") === true;
  const returnHasDom = returnGrounding?.elements?.some((element) => element.source === "dom") === true;
  if (nativeHasDom) throw new ProbeFailure("NATIVE_DOM_GROUNDING_LEAK", "DOM grounding was present on the WPS binding.");
  const publicPage = managedBrowserUrl !== "about:blank";
  if (publicPage && !returnHasDom) throw new ProbeFailure("MANAGED_DOM_GROUNDING_MISSING", "The fresh returned browser observation had no DOM-sourced grounding element.");
  if (runtimeState.domRequests.length !== 2) {
    throw new ProbeFailure("DOM_TRANSPORT_TARGET_MISMATCH", "Managed-browser DOM transport must collect on the two browser observations and never on the intervening native-window observation.");
  }
  return {
    switchActions: switchStarts.length,
    freshPostSwitchObservations: transitions.length,
    computerSessions: 1,
    nativeBindingHasDomSource: nativeHasDom,
    managedReturnHasDomSource: returnHasDom,
    managedReturnDomVerified: publicPage && returnHasDom,
    managedDomCollections: runtimeState.domRequests.length,
  };
}

export function assertNoForbiddenActions(events) {
  const kinds = events.filter((event) => event.type === "action.execution.started").map((event) => event.action?.kind);
  if (kinds.length !== 2 || kinds.some((kind) => kind !== "switch_window")) {
    throw new ProbeFailure("FORBIDDEN_ACTION_EXECUTED", "The probe may execute switch_window only; all other Computer actions are forbidden.");
  }
  const names = events.filter((event) => event.type === "tool.call.received").map((event) => event.call?.name);
  if (names.some((name) => name !== "list_windows" && name !== "switch_window" && name !== "terminate")) {
    throw new ProbeFailure("FORBIDDEN_TOOL_CALLED", "The probe may call list_windows and switch_window only.");
  }
}

export function helpText() {
  return [
    "SDK managed-browser roundtrip probe",
    "",
    "Usage:",
    "  node scripts/cross-window/sdk-managed-browser-probe.mjs --help",
    "  node scripts/cross-window/sdk-managed-browser-probe.mjs --self-test",
    "  node scripts/cross-window/sdk-managed-browser-probe.mjs --live --root-go-after-review --confirm-synthetic-only --socket <ascii-cua-pipe> --managed-browser-url <about:blank-or-public-http(s)-url> --native-target <wps-pid:wps-window-id> --fixture-title \"HarnessProbe-WPS.docx - WPS Office\"",
    "",
    "Default and self-test modes are offline and create no SDK, CUA, browser, profile, or output-folder resources.",
    "Live mode first performs read-only CUA inventory and requires the exact WPS PID/HWND and exact saved HarnessProbe-* title. Only then it creates an ephemeral managed Edge profile and starts the actual app-runtime ApplicationSession/ManagedBrowserComputer/CuaDriverComputer stack.",
    "The scripted Provider uses actual list_windows ToolResults and may execute only two switch_window actions: managed browser -> WPS fixture -> the same Run-owned browser. It never calls a vendor/model API and never types, clicks, saves, or closes the WPS document.",
    "Use a newly created, saved blank WPS document safe to leave open. Never use an existing/personal document or browser profile. A public test page is required to verify DOM grounding; about:blank validates only binding roundtrip.",
    "Do not run live mode until the user-prepared WPS fixture is visible, combined review has passed, and root gives final GO.",
  ].join("\n");
}

export async function runOfflineSelfTest() {
  const gated = (args, code) => {
    try { parseProbeArgs(args); }
    catch (error) {
      if (error instanceof ProbeFailure && error.code === code) return;
      throw error;
    }
    throw new Error("expected " + code);
  };
  const liveArgs = ["--live", "--root-go-after-review", "--confirm-synthetic-only", "--socket", "\\\\.\\pipe\\fixture",
    "--managed-browser-url", "https://example.com/", "--native-target", "123:456", "--fixture-title", "HarnessProbe-offline-only"];
  gated(["--live"], "ROOT_GO_REQUIRED");
  gated(["--root-go-after-review"], "LIVE_MODE_GATED");
  gated([...liveArgs.slice(0, 6), "https://example.com/?x=1", ...liveArgs.slice(7)], "INVALID_BROWSER_URL");
  gated([...liveArgs.slice(0, 6), "https://localhost/", ...liveArgs.slice(7)], "INVALID_BROWSER_URL");
  gated([...liveArgs.slice(0, 10), "Existing personal document"], "UNSAFE_FIXTURE_TITLE");
  const parsed = parseProbeArgs(liveArgs);
  if (parsed.mode !== "live" || parsed.nativeTarget.pid !== 123 || parsed.nativeTarget.windowId !== 456) throw new Error("live argument guard failed");
  const wpsSuffixTitle = "HarnessProbe-WPS.docx - WPS Office";
  const wpsSuffixArgs = [...liveArgs.slice(0, -1), wpsSuffixTitle];
  if (parseProbeArgs(wpsSuffixArgs).fixtureTitle !== wpsSuffixTitle) throw new Error("standard WPS title suffix guard failed");
  expectFailure(() => validateFixtureTitle(wpsSuffixTitle + " - private document"), "UNSAFE_FIXTURE_TITLE");
  if (parseProbeArgs(["--help"]).mode !== "help") throw new Error("help must be the default safe mode");

  const target = { pid: 123, windowId: 456 };
  const owned = { pid: 789, windowId: 654 };
  const fixture = [{ ...target, appName: "WPS Office", title: "HarnessProbe-offline-only" }];
  if (!validateNativeFixtureInventory(fixture, target, "HarnessProbe-offline-only").verified) throw new Error("fixture validator failed");
  const exactScope = buildExactTargetScope([target], owned);
  if (exactScope.length !== 2 || !sameTarget(exactScope[0], target) || !sameTarget(exactScope[1], owned)) throw new Error("scope builder failed");
  expectFailure(() => validateNativeFixtureInventory([{ ...target, appName: "WPS Office", title: "other" }], target, "HarnessProbe-offline-only"), "FIXTURE_TARGET_MISMATCH");
  expectFailure(() => validateNativeFixtureInventory([...fixture, ...fixture], target, "HarnessProbe-offline-only"), "FIXTURE_TARGET_NOT_UNIQUE");
  expectFailure(() => buildExactTargetScope([target, owned], owned), "TARGET_SCOPE_INVALID");

  const startInventory = [
    { windowRef: "opaque-browser-1", appName: "Microsoft Edge", title: "safe page", isCurrent: true },
    { windowRef: "opaque-wps-1", appName: "WPS Office", title: "HarnessProbe-offline-only", isCurrent: false },
  ];
  const wpsInventory = [
    { windowRef: "opaque-browser-2", appName: "Microsoft Edge", title: "safe page", isCurrent: false },
    { windowRef: "opaque-wps-2", appName: "WPS Office", title: "HarnessProbe-offline-only", isCurrent: true },
  ];
  const provider = createScriptedProvider({ fixtureTitle: "HarnessProbe-offline-only" });
  const tools = [{ name: "list_windows" }, { name: "switch_window" }];
  const input = (result) => ({ tools, messages: [{ role: "tool", content: [{ type: "tool_result", result }] }] });
  const first = await provider.generate({ tools, messages: [] }, { signal: new AbortController().signal });
  if (first.calls[0]?.name !== "list_windows") throw new Error("scripted initial inventory call failed");
  const second = await provider.generate(input({ callId: CALL_IDS.initialList, status: "completed", output: startInventory }), { signal: new AbortController().signal });
  if (second.calls[0]?.name !== "switch_window" || second.calls[0]?.arguments.windowRef !== "opaque-wps-1") throw new Error("first switch did not use the real listed ref");
  const third = await provider.generate(input({ callId: CALL_IDS.switchToWps, status: "completed", output: { status: "completed" } }), { signal: new AbortController().signal });
  if (third.calls[0]?.name !== "list_windows") throw new Error("WPS inventory refresh missing");
  const fourth = await provider.generate(input({ callId: CALL_IDS.wpsList, status: "completed", output: wpsInventory }), { signal: new AbortController().signal });
  if (fourth.calls[0]?.name !== "switch_window" || fourth.calls[0]?.arguments.windowRef !== "opaque-browser-2") throw new Error("return switch did not use the fresh listed ref");
  const fifth = await provider.generate(input({ callId: CALL_IDS.switchToBrowser, status: "completed", output: { status: "completed" } }), { signal: new AbortController().signal });
  if (fifth.type !== "finish" || provider.getAudit().labelSelections.join(",") !== "wps,owned-browser") throw new Error("scripted finish/audit failed");
  expectFailure(() => validateWindowInventory([{ ...startInventory[0], pid: 33 }, startInventory[1]], "HarnessProbe-offline-only", "browser"), "WINDOW_INVENTORY_PRIVATE_FIELD");
  return { status: "passed", networkCalls: 0, computerActions: 0, liveBody: "implemented-not-run" };
}

async function loadProductionAdapters(parsed) {
  const [appRuntime, cua] = await Promise.all([
    import(new URL("../../packages/app-runtime/dist/index.js", import.meta.url).href),
    import(new URL("../../packages/computer-cua/dist/index.js", import.meta.url).href),
  ]);
  return {
    async discoverNativeWindows() {
      const discovery = appRuntime.createWindowTargetDiscovery({
        kind: "cua",
        socketPath: parsed.socket,
        screenshotDir: "unused-read-only-preflight",
      });
      if (discovery === undefined) throw new ProbeFailure("CUA_DISCOVERY_UNAVAILABLE", "Read-only CUA discovery could not be constructed.");
      return discovery.listAllWindows(new AbortController().signal);
    },
    async runVerifiedFixture(options, fixture) {
      return runVerifiedSdkRoundtrip(options, fixture, appRuntime, cua);
    },
  };
}

async function runVerifiedSdkRoundtrip(parsed, fixture, appRuntime, cua) {
  const outputRoot = join(resolve(process.cwd(), "runs", "diagnostics", "cross-window-sdk-probe"),
    new Date().toISOString().replace(/[:.]/gu, "-") + "-" + randomUUID().slice(0, 8));
  await mkdir(outputRoot, { recursive: true });
  const state = {
    ownedBrowserTarget: undefined,
    adapterConstructed: false,
    adapterConstructionCount: 0,
    ephemeralProfile: false,
    hostCloseCalls: 0,
    hostCloseFailures: 0,
    hostCleanupDiagnostics: [],
    hostCloseCallsDuringProvider: 0,
    domRequests: [],
    session: undefined,
    handle: undefined,
    provider: undefined,
  };
  const nativeScope = [fixture.target];

  class ProbeManagedBrowserHost extends cua.ManagedBrowserHost {
    async start(signal) {
      const record = await super.start(signal);
      state.ownedBrowserTarget = copyTarget(record.target.windowTarget);
      state.ephemeralProfile = record.profileMode === "ephemeral";
      if (!state.ephemeralProfile) throw new ProbeFailure("NON_EPHEMERAL_PROFILE", "Only an ephemeral managed-browser profile is allowed.");
      return record;
    }
    createTransport() {
      const transport = super.createTransport();
      return {
        kind: transport.kind,
        async collect(request, signal) {
          const result = await transport.collect(request, signal);
          state.domRequests.push({
            sessionId: String(request.computerSessionId),
            candidateCount: result.candidates.length,
            tabId: result.tabId,
            generation: result.generation,
          });
          return result;
        },
        ...(transport.selectOption === undefined ? {} : { selectOption: (request, signal) => transport.selectOption(request, signal) }),
      };
    }
    async close() {
      state.hostCloseCalls += 1;
      try {
        return await super.close();
      } catch (error) {
        state.hostCloseFailures += 1;
        throw error;
      }
    }
  }

  const computerFactoryDependencies = {
    createManagedBrowserHost(options) {
      if (options.profileMode !== "ephemeral") throw new ProbeFailure("NON_EPHEMERAL_PROFILE", "Only an ephemeral managed-browser profile is allowed.");
      return new ProbeManagedBrowserHost({
        ...options,
        onCleanupDiagnostic(kind) {
          state.hostCleanupDiagnostics.push(kind);
          options.onCleanupDiagnostic?.(kind);
        },
      });
    },
    async importCuaComputer() {
      const ActualCuaDriverComputer = cua.CuaDriverComputer;
      return {
        CuaDriverComputer: class ProbeScopedActualCuaDriverComputer extends ActualCuaDriverComputer {
          constructor(options) {
            if (state.adapterConstructed) throw new ProbeFailure("DUPLICATE_CUA_ADAPTER", "The Run may create only one actual CUA adapter.");
            if (!Array.isArray(options.windowSwitchAllowedTargets) || options.windowSwitchAllowedTargets.length !== 1 ||
                !sameTarget(options.windowSwitchAllowedTargets[0], fixture.target) || state.ownedBrowserTarget === undefined) {
              throw new ProbeFailure("TARGET_SCOPE_NOT_EXACT", "Expected the exact WPS scope and resolved owned-browser target.");
            }
            const scope = buildExactTargetScope(options.windowSwitchAllowedTargets, state.ownedBrowserTarget);
            state.adapterConstructed = true;
            state.adapterConstructionCount += 1;
            super({ ...options, windowSwitchAllowedTargets: scope });
          }
        },
      };
    },
  };

  const computer = {
    kind: "cua",
    socketPath: parsed.socket,
    screenshotDir: join(outputRoot, "screenshots"),
    windowDeliveryMode: "foreground",
    windowSwitch: "opened-windows-v1",
    windowSwitchAllowedTargets: nativeScope,
    grounding: "hybrid-catalog-v1",
    managedBrowserUrl: parsed.managedBrowserUrl,
    managedBrowserProfileMode: "ephemeral",
  };
  const config = {
    model: { kind: "external", id: "sdk-cross-window-scripted-no-network" },
    computer,
    outputDir: outputRoot,
    maxSteps: 8,
    maxModelRequests: 8,
    planning: false,
    memory: "off",
    batching: "off",
    contextMode: "raw",
    contextMaxHistoryEvents: 64,
    riskProfile: "experiment",
    riskGuard: "off",
    riskModel: "off",
    riskMaxModelRequests: 1,
    riskTimeoutMs: 1000,
    cleanupDeadlineMs: 20000,
    grounding: "hybrid-catalog-v1",
    windowSwitch: "opened-windows-v1",
    windowHandoff: "off",
  };
  const environmentIdentity = appRuntime.environmentIdentityForConfig(computer);
  if (!environmentIdentity.startsWith("cua-local-physical-desktop:")) {
    throw new ProbeFailure("PHYSICAL_DESKTOP_IDENTITY_MISSING", "The managed-browser Run did not resolve to the production physical-desktop lease identity.");
  }
  state.provider = createScriptedProvider({
    fixtureTitle: parsed.fixtureTitle,
    getHostCloseCount: () => state.hostCloseCalls,
    onTurn: () => { state.hostCloseCallsDuringProvider = Math.max(state.hostCloseCallsDuringProvider, state.hostCloseCalls); },
  });
  state.session = new appRuntime.ApplicationSession({
    config,
    owner: appRuntime.createDefaultEnvironmentOwner(),
    dependencies: {
      credentials: {},
      createProvider: () => state.provider,
      createComputer: async (options) => cleanupAwareComputer(
        await appRuntime.createComputer(options.config, computerFactoryDependencies),
        state,
      ),
    },
  });

  let summary;
  let failureCode;
  try {
    state.handle = await state.session.startRun(
      "Switch only between the newly created blank WPS fixture and this Run's managed browser, then return to the browser. Do not type, click, edit, save, submit, or close anything.",
    );
    const outcome = await state.session.waitForActiveRun();
    const events = state.handle.controller.getEvents();
    assertNoForbiddenActions(events);
    const report = await state.handle.report();
    const leaseInfo = state.session.inspectEnvironment();
    if (state.session.lastRun?.ownerState !== "released" || leaseInfo !== undefined ||
        !Array.isArray(report.summary.cleanupDiagnostics) || report.summary.cleanupDiagnostics.length !== 0 ||
        state.hostCloseFailures !== 0 || state.hostCleanupDiagnostics.length !== 0) {
      throw new ProbeFailure("CLEANUP_NOT_CONFIRMED", "Run, process-shared desktop lease, managed browser process, or ephemeral profile cleanup was not fully confirmed.");
    }
    if (outcome !== "succeeded") throw new ProbeFailure("RUN_DID_NOT_SUCCEED", "The SDK roundtrip did not finish successfully.");
    if (state.hostCloseCalls !== 1) throw new ProbeFailure("HOST_CLEANUP_MISMATCH", "The managed-browser Host was not closed exactly once after Run cleanup.");
    if (!state.adapterConstructed || state.adapterConstructionCount !== 1 || !state.ephemeralProfile) {
      throw new ProbeFailure("ACTUAL_ADAPTER_PATH_NOT_USED", "The actual managed-browser and CUA adapter stack was not used.");
    }
    if (state.hostCloseCallsDuringProvider !== 0) throw new ProbeFailure("HOST_CLOSED_BEFORE_CLEANUP", "The Host closed while the Provider was active.");
    const providerAudit = state.provider.getAudit();
    summary = {
      schemaVersion: 1,
      status: "passed",
      outcome,
      fixtureVerified: true,
      sdkPath: "ApplicationSession/ManagedBrowserComputer/CuaDriverComputer",
      profileMode: "ephemeral",
      ...auditRoundtripEvents(events, providerAudit, state, parsed.managedBrowserUrl),
      providerCalls: providerAudit.step,
      listWindowsCalls: providerAudit.callNames.filter((name) => name === "list_windows").length,
      switchWindowCalls: providerAudit.callNames.filter((name) => name === "switch_window").length,
      providerNetworkCalls: 0,
      outputContainsFixtureTitle: false,
      screenshotsOrPageBodiesPrinted: false,
    };
  } catch (error) {
    failureCode = safeFailureCode(error);
    summary = { schemaVersion: 1, status: "failed", fixtureVerified: true, failureCode, providerNetworkCalls: 0, screenshotsOrPageBodiesPrinted: false };
  } finally {
    await state.session.close().catch(() => undefined);
  }
  await writeFile(join(outputRoot, "sdk-probe-summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
  if (failureCode !== undefined) throw new ProbeFailure(failureCode, "The SDK roundtrip did not satisfy its safety/freshness assertions; only the redacted summary was written.");
  return summary;
}

export function cleanupAwareComputer(computer, state) {
  return new Proxy(computer, {
    get(target, property, receiver) {
      if (property === "close") {
        return async (session) => {
          await target.close(session);
          if (state.hostCloseFailures > 0 || state.hostCleanupDiagnostics.length > 0) {
            throw new ProbeFailure("MANAGED_HOST_CLEANUP_FAILED", "The managed browser process/profile cleanup reported an error.");
          }
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function requiredValue(values, name) {
  const value = values.get(name);
  if (typeof value !== "string" || value.length === 0) throw new ProbeFailure("MISSING_ARGUMENT_VALUE", name + " is required.");
  return value;
}

function validTarget(value) {
  return isRecord(value) && Number.isSafeInteger(value.pid) && value.pid > 0 && Number.isSafeInteger(value.windowId) && value.windowId > 0;
}

function copyTarget(value) {
  return { pid: value.pid, windowId: value.windowId };
}

function sameTarget(left, right) {
  return validTarget(left) && validTarget(right) && left.pid === right.pid && left.windowId === right.windowId;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function expectFailure(operation, code) {
  try { operation(); }
  catch (error) {
    if (error instanceof ProbeFailure && error.code === code) return;
    throw error;
  }
  throw new Error("expected " + code);
}

function safeFailureCode(error) {
  return error instanceof ProbeFailure && /^[A-Z0-9_]{1,64}$/u.test(error.code) ? error.code : "UNEXPECTED_FAILURE";
}

async function main(argv) {
  let parsed;
  try { parsed = parseProbeArgs(argv); }
  catch (error) {
    process.stderr.write(safeFailureCode(error) + "\n");
    process.exitCode = 2;
    return;
  }
  if (parsed.mode === "help") {
    process.stdout.write(helpText() + "\n");
    return;
  }
  if (parsed.mode === "self-test") {
    process.stdout.write(JSON.stringify(await runOfflineSelfTest(), null, 2) + "\n");
    return;
  }
  try {
    const result = await dispatchProbe(argv, () => loadProductionAdapters(parsed));
    process.stdout.write(JSON.stringify(result.result, null, 2) + "\n");
  } catch (error) {
    process.stderr.write(safeFailureCode(error) + "\n");
    process.exitCode = 1;
  }
}

  if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write("UNEXPECTED_FAILURE\n");
    process.exitCode = 1;
  });
}
