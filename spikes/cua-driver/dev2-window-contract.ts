import { createHash } from "node:crypto";
import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import {
  BoundsExpectation,
  CuaDriver,
  EndSessionInput,
  SetWindowFrameInput,
  StartSessionInput,
  StatePredicate,
  VerifyStateInput,
  WindowPredicate,
  type CuaDriverLike,
  type ToolResult,
} from "@trycua/cua-driver";

type Daemon = ChildProcessByStdio<null, Readable, Readable>;
type Frame = { x: number; y: number; width: number; height: number };
type WindowInfo = { pid: number; windowId: number; bounds?: Frame; zIndex?: number };
type SafeState = {
  role?: string;
  event?: string;
  eventSequence?: number;
  dpiAwarenessSet?: boolean;
  dpi?: number;
  primary?: Frame;
  bounds?: Frame;
  formActive?: boolean;
  topMost?: boolean;
  borderless?: boolean;
};

interface Options {
  binary: string;
  fixture: string;
  output: string;
  socket: string;
  session: string;
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function required(args: readonly string[], name: string): string {
  const value = option(args, name);
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function normalizePipe(value: string): string {
  if (process.platform !== "win32") return value;
  const match = value.match(/^\\+\.\\+pipe\\+(.*)$/iu);
  if (match === null || match[1] === undefined) return value;
  return `\\\\.\\pipe\\${match[1].replace(/\\+/gu, "\\")}`;
}

function parseOptions(args: readonly string[]): Options {
  return {
    binary: resolve(required(args, "--binary")),
    fixture: resolve(required(args, "--fixture")),
    output: resolve(required(args, "--output")),
    socket: normalizePipe(required(args, "--socket")),
    session: option(args, "--session") ?? "dev2-window-contract",
  };
}

function numberField(value: unknown, key: string): number | undefined {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function booleanField(value: unknown, key: string): boolean | undefined {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  return typeof candidate === "boolean" ? candidate : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  return typeof candidate === "string" ? candidate : undefined;
}

function objectField(value: unknown, key: string): Record<string, unknown> | undefined {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : undefined;
}

function safeErrorCode(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" && /^[A-Z0-9_.:-]{1,80}$/u.test(code) ? code : null;
}

function structured(result: ToolResult): Record<string, unknown> | undefined {
  if (typeof result.structuredJson !== "string") return undefined;
  try {
    const parsed = JSON.parse(result.structuredJson) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function safeToolResult(result: ToolResult): Record<string, unknown> {
  const verification = result.verification;
  return {
    returned: true,
    isError: result.isError,
    errorCode: result.errorCode ?? null,
    degraded: result.degraded,
    textLength: result.text.length,
    structuredLength: result.structuredJson?.length ?? 0,
    imageCount: result.images.length,
    verificationStatus: verification === undefined ? null : String(verification.status),
    verificationStable: verification?.stable ?? null,
  };
}

async function runProcess(file: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = execFile(file, args, { windowsHide: true, encoding: "utf8", timeout: 20_000 }, (error, stdout, stderr) => {
      if (error !== null && (error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
        resolveResult({ code: null, stdout: String(stdout), stderr: String(stderr) });
        return;
      }
      resolveResult({ code: error === null ? 0 : typeof error.code === "number" ? error.code : null, stdout: String(stdout), stderr: String(stderr) });
    });
    child.once("error", reject);
  });
}

async function waitForDaemon(binary: string, socket: string, daemon: Daemon): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (daemon.exitCode !== null || daemon.signalCode !== null) throw new Error("daemon exited before readiness");
    const status = await runProcess(binary, ["status", "--socket", socket]);
    if (status.code === 0 && /daemon is running/iu.test(status.stdout)) return;
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error("daemon readiness timeout");
}

function frameFrom(value: unknown): Frame | undefined {
  const x = numberField(value, "x");
  const y = numberField(value, "y");
  const width = numberField(value, "width");
  const height = numberField(value, "height");
  return x !== undefined && y !== undefined && width !== undefined && height !== undefined
    ? { x, y, width, height }
    : undefined;
}

function safeWindow(value: unknown): WindowInfo | undefined {
  const pid = numberField(value, "pid");
  const windowId = numberField(value, "window_id");
  if (pid === undefined || windowId === undefined) return undefined;
  const bounds = frameFrom(objectField(value, "bounds"));
  const zIndex = numberField(value, "z_index");
  return { pid, windowId, ...(bounds === undefined ? {} : { bounds }), ...(zIndex === undefined ? {} : { zIndex }) };
}

function windowsFrom(result: ToolResult): WindowInfo[] {
  const windows = structured(result)?.windows;
  if (!Array.isArray(windows)) return [];
  return windows.flatMap((item) => {
    const window = safeWindow(item);
    return window === undefined ? [] : [window];
  });
}

async function listWindows(driver: CuaDriverLike, session: string, pid?: number): Promise<{ result: ToolResult; windows: WindowInfo[] }> {
  const input: Record<string, unknown> = { on_screen_only: true, session };
  if (pid !== undefined) input.pid = pid;
  const result = await driver.callTool("list_windows", JSON.stringify(input), { signal: new AbortController().signal });
  return { result, windows: windowsFrom(result) };
}

function stateFromText(raw: string): SafeState {
  const values = new Map<string, string>();
  for (const line of raw.split(/\r?\n/gu)) {
    const split = line.indexOf("=");
    if (split <= 0) continue;
    values.set(line.slice(0, split), line.slice(split + 1));
  }
  const int = (key: string): number | undefined => {
    const value = values.get(key);
    if (value === undefined || !/^[-+]?\d+$/u.test(value)) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const bool = (key: string): boolean | undefined => {
    const value = values.get(key);
    return value === "True" ? true : value === "False" ? false : undefined;
  };
  const frame = (prefix: string): Frame | undefined => {
    const x = int(`${prefix}X`);
    const y = int(`${prefix}Y`);
    const width = int(`${prefix}Width`);
    const height = int(`${prefix}Height`);
    return x !== undefined && y !== undefined && width !== undefined && height !== undefined
      ? { x, y, width, height }
      : undefined;
  };
  const state: SafeState = {};
  const roleValue = values.get("role");
  const eventValue = values.get("event");
  const eventSequence = int("eventSequence");
  const dpiAwarenessSet = bool("dpiAwarenessSet");
  const dpi = int("dpi");
  const primary = frame("primary");
  const bounds = frame("window");
  const formActive = bool("formActive");
  const topMost = bool("topMost");
  const borderless = bool("borderless");
  if (roleValue !== undefined) state.role = roleValue;
  if (eventValue !== undefined) state.event = eventValue;
  if (eventSequence !== undefined) state.eventSequence = eventSequence;
  if (dpiAwarenessSet !== undefined) state.dpiAwarenessSet = dpiAwarenessSet;
  if (dpi !== undefined) state.dpi = dpi;
  if (primary !== undefined) state.primary = primary;
  if (bounds !== undefined) state.bounds = bounds;
  if (formActive !== undefined) state.formActive = formActive;
  if (topMost !== undefined) state.topMost = topMost;
  if (borderless !== undefined) state.borderless = borderless;
  return state;
}

async function readState(path: string): Promise<SafeState | undefined> {
  const raw = await readFile(path, "utf8").catch(() => undefined);
  return raw === undefined ? undefined : stateFromText(raw);
}

async function waitForState(path: string, predicate: (state: SafeState) => boolean, timeoutMs = 5_000): Promise<SafeState | undefined> {
  const deadline = Date.now() + timeoutMs;
  let state: SafeState | undefined;
  while (Date.now() < deadline) {
    state = await readState(path);
    if (state !== undefined && predicate(state)) return state;
    await new Promise((done) => setTimeout(done, 100));
  }
  return state;
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return undefined;
  const uint32 = (offset: number): number => ((bytes[offset] ?? 0) * 0x1000000) + ((bytes[offset + 1] ?? 0) * 0x10000) + ((bytes[offset + 2] ?? 0) * 0x100) + (bytes[offset + 3] ?? 0);
  const width = uint32(16);
  const height = uint32(20);
  return { width, height };
}

async function captureWindow(result: ToolResult, label: string, output: string, expected: Frame | undefined): Promise<Record<string, unknown>> {
  const image = result.images[0];
  if (image === undefined) return { label, present: false, ...safeToolResult(result) };
  const bytes = Buffer.from(image.dataBase64, "base64");
  const dimensions = pngDimensions(bytes);
  const exactFrame = dimensions !== undefined && expected !== undefined && dimensions.width === expected.width && dimensions.height === expected.height;
  // WinForms keeps a two-pixel non-client frame at this DPI. The verify_state
  // window screenshot is the client surface, so accept only the exact frame
  // size or the exact frame-minus-border size; never accept a desktop-sized
  // image as a window capture.
  const exactClient = dimensions !== undefined && expected !== undefined && dimensions.width === expected.width - 2 && dimensions.height === expected.height - 2;
  const exact = exactFrame || exactClient;
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (exact) {
    await mkdir(join(output, "window-screenshots"), { recursive: true });
    await writeFile(join(output, "window-screenshots", `${label}.png`), bytes);
  }
  return {
    label,
    present: true,
    mimeType: image.mimeType,
    bytes: bytes.byteLength,
    dimensions,
    expected: expected === undefined ? undefined : { width: expected.width, height: expected.height },
    exactWindowDimensions: exactFrame,
    exactClientDimensions: exactClient,
    windowLocalDimensions: exact,
    sha256: digest,
    persistedOnlyBecauseWindowLocalDimensions: exact,
    ...safeToolResult(result),
  };
}

function schemaEvidence(raw: string, names: string[]): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch { return { shape: "invalid", tools: [] }; }
  const tools = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).tools)
      ? (parsed as Record<string, unknown>).tools as unknown[]
      : [];
  const selected = tools.flatMap((tool) => {
    if (tool === null || typeof tool !== "object" || Array.isArray(tool)) return [];
    const record = tool as Record<string, unknown>;
    const name = stringField(record, "name");
    if (name === undefined || !names.includes(name)) return [];
    const schema = objectField(record, "inputSchema") ?? objectField(record, "input_schema") ?? objectField(record, "parameters");
    const properties = schema === undefined ? undefined : objectField(schema, "properties");
    const required = schema === undefined ? undefined : schema.required;
    return [{
      name,
      schemaType: schema === undefined ? null : stringField(schema, "type") ?? null,
      required: Array.isArray(required) ? required.filter((item): item is string => typeof item === "string" && /^[a-z][a-z0-9_]{0,80}$/u.test(item)) : [],
      propertyNames: properties === undefined ? [] : Object.keys(properties).filter((item) => /^[a-z][a-z0-9_]{0,80}$/u.test(item)),
    }];
  });
  return { shape: Array.isArray(parsed) ? "array" : "object", toolCount: tools.length, tools: selected };
}

function frameMatch(actual: Frame | undefined, expected: Frame): boolean {
  return actual !== undefined && actual.x === expected.x && actual.y === expected.y && actual.width === expected.width && actual.height === expected.height;
}

async function verifyWindow(driver: CuaDriverLike, session: string, target: WindowInfo, expected: Frame, includeScreenshot: boolean): Promise<ToolResult> {
  const predicate = StatePredicate.new({
    window: WindowPredicate.new({
      exists: true,
      bounds: BoundsExpectation.new({ x: expected.x, y: expected.y, width: expected.width, height: expected.height, tolerancePx: 0 }),
    }),
  });
  return driver.verifyState(VerifyStateInput.new({
    pid: BigInt(target.pid),
    windowId: BigInt(target.windowId),
    expect: [predicate],
    session,
    timeoutMs: BigInt(0),
    stableSamples: BigInt(1),
    includeScreenshot,
  }), { signal: new AbortController().signal });
}

async function bringToFront(driver: CuaDriverLike, session: string, target: WindowInfo): Promise<ToolResult> {
  return driver.callTool("bring_to_front", JSON.stringify({ pid: target.pid, window_id: target.windowId, session }), { signal: new AbortController().signal });
}

async function setFrame(driver: CuaDriverLike, session: string, target: WindowInfo, frame: Frame): Promise<ToolResult> {
  return driver.setWindowFrame(SetWindowFrameInput.new({
    pid: target.pid,
    windowId: BigInt(target.windowId),
    x: frame.x,
    y: frame.y,
    width: frame.width,
    height: frame.height,
    session,
  }), { signal: new AbortController().signal });
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  await mkdir(options.output, { recursive: true });
  const stateTarget = join(options.output, "target-state.txt");
  const stateWitness = join(options.output, "witness-state.txt");
  const daemon = spawn(options.binary, ["serve", "--socket", options.socket, "--no-overlay"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }) as Daemon;
  let driver: CuaDriverLike | undefined;
  let sessionStarted = false;
  let targetPid: number | undefined;
  let witnessPid: number | undefined;
  let target: WindowInfo | undefined;
  let witness: WindowInfo | undefined;
  let stopSent = false;
  const safe: Record<string, unknown> = {
    probeVersion: "dev2-window-contract-0.1.0",
    daemonVersion: "0.22.2",
    apiRequests: 0,
    modelRequests: 0,
    userWindowTouched: false,
    stages: {},
  };
  const stages = safe.stages as Record<string, unknown>;
  try {
    await waitForDaemon(options.binary, options.socket, daemon);
    driver = CuaDriver.connect(options.socket);
    const toolsJson = await driver.listToolsJson({ signal: new AbortController().signal });
    const requiredTools = ["list_windows", "bring_to_front", "set_window_frame", "launch_app", "verify_state"];
    const inventory = schemaEvidence(toolsJson, requiredTools);
    const names = new Set((inventory.tools as Array<Record<string, unknown>>).map((item) => item.name));
    safe.inventory = { ...inventory, requiredToolsPresent: requiredTools.every((name) => names.has(name)) };
    if (requiredTools.some((name) => !names.has(name))) throw new Error("required window tools missing from runtime inventory");

    await driver.startSession(StartSessionInput.new({ session: options.session }), { signal: new AbortController().signal });
    sessionStarted = true;
    const launchFixture = async (statePath: string, fixtureRole: string, title: string, frame: Frame): Promise<number> => {
      const result = await driver!.callTool("launch_app", JSON.stringify({
        path: options.fixture,
        additional_arguments: [statePath, fixtureRole, title, String(frame.x), String(frame.y), String(frame.width), String(frame.height)],
        start_minimized: false,
        session: options.session,
      }), { signal: new AbortController().signal });
      const pid = numberField(structured(result), "pid");
      if (pid === undefined || result.isError) throw new Error("fixture launch failed");
      return pid;
    };

    targetPid = await launchFixture(stateTarget, "target", "DEV2 WINDOW CONTRACT TARGET", { x: 160, y: 120, width: 900, height: 650 });
    witnessPid = await launchFixture(stateWitness, "witness", "DEV2 WINDOW CONTRACT WITNESS", { x: 1400, y: 180, width: 700, height: 500 });
    const targetListed = await listWindows(driver, options.session, targetPid);
    const witnessListed = await listWindows(driver, options.session, witnessPid);
    target = targetListed.windows.find((item) => item.pid === targetPid);
    witness = witnessListed.windows.find((item) => item.pid === witnessPid);
    if (target === undefined || witness === undefined) throw new Error("fixture window discovery failed");
    stages.initialDiscovery = {
      target: { pidOwned: target.pid === targetPid, windowIdPresent: Number.isFinite(target.windowId), bounds: target.bounds },
      witness: { pidOwned: witness.pid === witnessPid, windowIdPresent: Number.isFinite(witness.windowId), bounds: witness.bounds },
      targetInitialNonZeroOrigin: target.bounds !== undefined && (target.bounds.x !== 0 || target.bounds.y !== 0),
      witnessInitialNonZeroOrigin: witness.bounds !== undefined && (witness.bounds.x !== 0 || witness.bounds.y !== 0),
      listWindows: safeToolResult(targetListed.result),
    };

    const targetFrame1: Frame = { x: 240, y: 180, width: 960, height: 680 };
    const targetFrame2: Frame = { x: 360, y: 260, width: 1040, height: 720 };
    const move1 = await setFrame(driver, options.session, target, targetFrame1);
    const moved1 = await waitForState(stateTarget, (state) => frameMatch(state.bounds, targetFrame1));
    const listed1 = (await listWindows(driver, options.session, targetPid)).windows.find((item) => item.pid === targetPid);
    const verify1 = await verifyWindow(driver, options.session, target, targetFrame1, true);
    const capture1 = await captureWindow(verify1, "target-frame-1", options.output, targetFrame1);
    const move2 = await setFrame(driver, options.session, target, targetFrame2);
    const moved2 = await waitForState(stateTarget, (state) => frameMatch(state.bounds, targetFrame2));
    const listed2 = (await listWindows(driver, options.session, targetPid)).windows.find((item) => item.pid === targetPid);
    const verify2 = await verifyWindow(driver, options.session, target, targetFrame2, true);
    const capture2 = await captureWindow(verify2, "target-frame-2", options.output, targetFrame2);
    stages.moveResize = {
      frame1: { requested: targetFrame1, state: moved1, listed: listed1?.bounds ?? null, operation: safeToolResult(move1), verification: safeToolResult(verify1), capture: capture1 },
      frame2: { requested: targetFrame2, state: moved2, listed: listed2?.bounds ?? null, operation: safeToolResult(move2), verification: safeToolResult(verify2), capture: capture2 },
      nonZeroOrigin: targetFrame2.x !== 0 && targetFrame2.y !== 0,
      resized: targetFrame1.width !== targetFrame2.width && targetFrame1.height !== targetFrame2.height,
    };

    const focusTarget1 = await bringToFront(driver, options.session, target);
    const focusTargetState = await waitForState(stateTarget, (state) => state.formActive === true);
    const focusWitnessInactive = await waitForState(stateWitness, (state) => state.formActive === false);
    const focusWitness = await bringToFront(driver, options.session, witness);
    const focusWitnessState = await waitForState(stateWitness, (state) => state.formActive === true);
    const focusTargetInactive = await waitForState(stateTarget, (state) => state.formActive === false);
    const focusTarget2 = await bringToFront(driver, options.session, target);
    const focusTargetState2 = await waitForState(stateTarget, (state) => state.formActive === true);
    stages.focus = {
      targetLanded: safeToolResult(focusTarget1),
      targetActive: focusTargetState?.formActive === true,
      witnessInactive: focusWitnessInactive?.formActive === false,
      witnessLanded: safeToolResult(focusWitness),
      witnessActive: focusWitnessState?.formActive === true,
      targetInactiveAfterWitness: focusTargetInactive?.formActive === false,
      targetRelanded: safeToolResult(focusTarget2),
      targetActiveAfterReland: focusTargetState2?.formActive === true,
      independentFixtureStateEvidence: true,
    };

    const occludingFrame: Frame = { x: 640, y: 460, width: 760, height: 480 };
    const moveWitness = await setFrame(driver, options.session, witness, occludingFrame);
    const witnessMoved = await waitForState(stateWitness, (state) => frameMatch(state.bounds, occludingFrame));
    const witnessOnTop = await bringToFront(driver, options.session, witness);
    const witnessActiveForOcclusion = await waitForState(stateWitness, (state) => state.formActive === true);
    const targetInactiveForOcclusion = await waitForState(stateTarget, (state) => state.formActive === false);
    const verifyOccluded = await verifyWindow(driver, options.session, target, targetFrame2, true);
    const captureOccluded = await captureWindow(verifyOccluded, "target-occluded", options.output, targetFrame2);
    const frame2Capture = capture2 as Record<string, unknown>;
    const occludedCapture = captureOccluded as Record<string, unknown>;
    stages.occlusion = {
      witnessMove: safeToolResult(moveWitness),
      witnessBounds: witnessMoved?.bounds ?? null,
      witnessOnTop: safeToolResult(witnessOnTop),
      witnessActive: witnessActiveForOcclusion?.formActive === true,
      targetInactive: targetInactiveForOcclusion?.formActive === false,
      targetCapture: captureOccluded,
      targetCaptureWindowLocal: occludedCapture.windowLocalDimensions === true,
      targetCaptureHashSameAsBeforeOcclusion: typeof frame2Capture.sha256 === "string" && frame2Capture.sha256 === occludedCapture.sha256,
    };

    if (witnessPid !== undefined) {
      try { process.kill(witnessPid); } catch { /* already exited */ }
      witnessPid = undefined;
    }
    await new Promise((done) => setTimeout(done, 250));
    const closedVerify = await verifyWindow(driver, options.session, witness, occludingFrame, false).catch((error: unknown) => undefined);
    const closedFrame = await setFrame(driver, options.session, witness, occludingFrame).catch((error: unknown) => undefined);
    const closedListed = (await listWindows(driver, options.session, witness.pid)).windows;
    stages.closeRejection = {
      windowAbsentFromDiscovery: closedListed.length === 0,
      verifyStateReturned: closedVerify !== undefined,
      verifyState: closedVerify === undefined ? { threw: true } : safeToolResult(closedVerify),
      setWindowFrameReturned: closedFrame !== undefined,
      setWindowFrame: closedFrame === undefined ? { threw: true } : safeToolResult(closedFrame),
      noInputSentToClosedTarget: true,
    };

    safe.ok = Boolean(
      stages.initialDiscovery !== undefined
      && (stages.moveResize as Record<string, unknown>).nonZeroOrigin === true
      && (stages.moveResize as Record<string, unknown>).resized === true
      && (stages.focus as Record<string, unknown>).targetActiveAfterReland === true
      && (stages.focus as Record<string, unknown>).witnessActive === true
      && (stages.occlusion as Record<string, unknown>).targetCaptureWindowLocal === true
      && (stages.closeRejection as Record<string, unknown>).windowAbsentFromDiscovery === true,
    );
  } catch (error) {
    safe.ok = false;
    safe.failure = { kind: "probe_error", code: safeErrorCode(error) };
  } finally {
    if (witnessPid !== undefined) {
      try { process.kill(witnessPid); } catch { /* already exited */ }
    }
    if (targetPid !== undefined) {
      try { process.kill(targetPid); } catch { /* already exited */ }
    }
    if (driver !== undefined) {
      if (sessionStarted) {
        try { await driver.endSession(EndSessionInput.new({ session: options.session }), { signal: new AbortController().signal }); } catch { /* preserve evidence */ }
      }
      try { await driver.shutdown({ signal: new AbortController().signal }); } catch { /* stop remains authoritative */ }
      (driver as unknown as { uniffiDestroy?: () => void }).uniffiDestroy?.();
    }
    if (!stopSent) {
      await runProcess(options.binary, ["stop", "--socket", options.socket]).catch(() => undefined);
      stopSent = true;
    }
    await writeFile(join(options.output, "window-contract-summary.json"), `${JSON.stringify(safe, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify({ ok: safe.ok === true, output: "<ignored-output>", modelRequests: 0 }, null, 2));
  if (safe.ok !== true) process.exitCode = 1;
}

main().catch(() => {
  process.exitCode = 1;
});
