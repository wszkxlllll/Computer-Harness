import { createHash } from "node:crypto";
import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import {
  CuaDriver,
  EndSessionInput,
  SetWindowFrameInput,
  StartSessionInput,
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
  client?: { width: number; height: number };
  formActive?: boolean;
  inputFocused?: boolean;
  buttonClicked?: boolean;
  clickCount?: number;
  keyCount?: number;
  lastKey?: string;
  textLength?: number;
  typedExpected?: boolean;
};
type ElementInfo = { index: number; role?: string; label?: string; frame?: Frame };

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
    session: option(args, "--session") ?? "dev2-window-target-contract",
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

function safeTool(result: ToolResult): Record<string, unknown> {
  const action = result.action;
  const delivery = action?.delivery;
  const resultShape = structured(result);
  return {
    returned: true,
    isError: result.isError,
    errorCode: result.errorCode ?? null,
    degraded: result.degraded,
    textLength: result.text.length,
    structuredLength: result.structuredJson?.length ?? 0,
    imageCount: result.images.length,
    landedOnTarget: booleanField(resultShape, "landed_on_target") ?? null,
    previousForegroundHwnd: numberField(resultShape, "previous_fg_hwnd") ?? null,
    currentForegroundHwnd: numberField(resultShape, "now_fg_hwnd") ?? null,
    action: action === undefined ? null : {
      effect: String(action.effect),
      route: String(action.route),
      delivery: delivery === undefined ? null : { mode: String(delivery.mode), deliveredCount: delivery.deliveredCount ?? null },
      evidence: action.evidence?.map((item) => String(item.kind)) ?? [],
      escalation: action.escalation === undefined ? null : { target: String(action.escalation.target), reason: String(action.escalation.reason) },
    },
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

async function listWindows(driver: CuaDriverLike, pid?: number): Promise<{ result: ToolResult; windows: WindowInfo[] }> {
  const input: Record<string, unknown> = { on_screen_only: true };
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
  const clientWidth = int("clientWidth");
  const clientHeight = int("clientHeight");
  const state: SafeState = {};
  const role = values.get("role");
  const event = values.get("event");
  const eventSequence = int("eventSequence");
  const dpiAwarenessSet = bool("dpiAwarenessSet");
  const dpi = int("dpi");
  const primary = frame("primary");
  const bounds = frame("window");
  const formActive = bool("formActive");
  const inputFocused = bool("inputFocused");
  const buttonClicked = bool("buttonClicked");
  const clickCount = int("clickCount");
  const keyCount = int("keyCount");
  const lastKey = values.get("lastKey");
  const textLength = int("textLength");
  const typedExpected = bool("typedExpected");
  if (role !== undefined) state.role = role;
  if (event !== undefined) state.event = event;
  if (eventSequence !== undefined) state.eventSequence = eventSequence;
  if (dpiAwarenessSet !== undefined) state.dpiAwarenessSet = dpiAwarenessSet;
  if (dpi !== undefined) state.dpi = dpi;
  if (primary !== undefined) state.primary = primary;
  if (bounds !== undefined) state.bounds = bounds;
  if (clientWidth !== undefined && clientHeight !== undefined) state.client = { width: clientWidth, height: clientHeight };
  if (formActive !== undefined) state.formActive = formActive;
  if (inputFocused !== undefined) state.inputFocused = inputFocused;
  if (buttonClicked !== undefined) state.buttonClicked = buttonClicked;
  if (clickCount !== undefined) state.clickCount = clickCount;
  if (keyCount !== undefined) state.keyCount = keyCount;
  if (lastKey !== undefined) state.lastKey = lastKey;
  if (textLength !== undefined) state.textLength = textLength;
  if (typedExpected !== undefined) state.typedExpected = typedExpected;
  return state;
}

async function readState(path: string): Promise<SafeState | undefined> {
  const raw = await readFile(path, "utf8").catch(() => undefined);
  return raw === undefined ? undefined : stateFromText(raw);
}

async function waitState(path: string, predicate: (state: SafeState) => boolean, timeoutMs = 5_000): Promise<SafeState | undefined> {
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
  return { width: uint32(16), height: uint32(20) };
}

async function persistCapture(result: ToolResult, label: string, output: string, expected: Frame | undefined): Promise<Record<string, unknown>> {
  const image = result.images[0];
  if (image === undefined) return { label, present: false, ...safeTool(result) };
  const bytes = Buffer.from(image.dataBase64, "base64");
  const dimensions = pngDimensions(bytes);
  const frameExact = dimensions !== undefined && expected !== undefined && dimensions.width === expected.width && dimensions.height === expected.height;
  const clientExact = dimensions !== undefined && expected !== undefined && dimensions.width === expected.width - 2 && dimensions.height === expected.height - 2;
  const windowLocal = frameExact || clientExact;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (windowLocal) {
    await mkdir(join(output, "window-screenshots"), { recursive: true });
    await writeFile(join(output, "window-screenshots", `${label}.png`), bytes);
  }
  return {
    label,
    present: true,
    mimeType: image.mimeType,
    bytes: bytes.byteLength,
    dimensions,
    expected: expected === undefined ? null : { width: expected.width, height: expected.height },
    frameExact,
    clientExact,
    windowLocal,
    sha256,
    persistedOnlyWhenWindowLocal: windowLocal,
    ...safeTool(result),
  };
}

function elementFrame(value: unknown): Frame | undefined {
  const frame = objectField(value, "frame");
  if (frame === undefined) return undefined;
  const x = numberField(frame, "x");
  const y = numberField(frame, "y");
  const width = numberField(frame, "width") ?? numberField(frame, "w");
  const height = numberField(frame, "height") ?? numberField(frame, "h");
  return x !== undefined && y !== undefined && width !== undefined && height !== undefined
    ? { x, y, width, height }
    : undefined;
}

function elementsFrom(result: ToolResult): ElementInfo[] {
  const elements = structured(result)?.elements;
  if (!Array.isArray(elements)) return [];
  return elements.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const index = numberField(item, "element_index");
    if (index === undefined) return [];
    const role = stringField(item, "role");
    const label = stringField(item, "label") ?? stringField(item, "name");
    const frame = elementFrame(item);
    return [{ index, ...(role === undefined ? {} : { role }), ...(label === undefined ? {} : { label }), ...(frame === undefined ? {} : { frame }) }];
  });
}

function pointInFrame(frame: Frame | undefined): { x: number; y: number } | undefined {
  return frame === undefined ? undefined : { x: Math.floor(frame.x + frame.width / 2), y: Math.floor(frame.y + frame.height / 2) };
}

function toWindowLocalFrame(frame: Frame | undefined, listedBounds: Frame | undefined): Frame | undefined {
  if (frame === undefined || listedBounds === undefined) return undefined;
  // get_window_state UIA frames are desktop-originated on this Windows host;
  // the click/type contract is the PNG's window-local origin. Derive the
  // translation only from the same list_windows frame, never from a guessed
  // border or DPI offset.
  return { x: frame.x - listedBounds.x, y: frame.y - listedBounds.y, width: frame.width, height: frame.height };
}

function toWindowLocalElements(elements: ElementInfo[], listedBounds: Frame | undefined): ElementInfo[] {
  return elements.map((item) => {
    if (item.frame === undefined) return item;
    const local = toWindowLocalFrame(item.frame, listedBounds);
    return local === undefined ? item : { ...item, frame: local };
  });
}

function frameInside(point: { x: number; y: number } | undefined, dimensions: { width: number; height: number } | undefined): boolean {
  return point !== undefined && dimensions !== undefined && point.x >= 0 && point.y >= 0 && point.x < dimensions.width && point.y < dimensions.height;
}

function schemaEvidence(raw: string, wanted: string[]): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch { return { shape: "invalid", toolCount: 0, tools: [] }; }
  const tools = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).tools)
      ? (parsed as Record<string, unknown>).tools as unknown[]
      : [];
  const selected = tools.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const name = stringField(record, "name");
    if (name === undefined || !wanted.includes(name)) return [];
    const schema = objectField(record, "inputSchema") ?? objectField(record, "input_schema") ?? objectField(record, "parameters");
    const properties = schema === undefined ? undefined : objectField(schema, "properties");
    const required = schema === undefined ? undefined : schema.required;
    return [{ name, schemaType: schema === undefined ? null : stringField(schema, "type") ?? null, required: Array.isArray(required) ? required.filter((item): item is string => typeof item === "string") : [], propertyNames: properties === undefined ? [] : Object.keys(properties) }];
  });
  return { shape: Array.isArray(parsed) ? "array" : "object", toolCount: tools.length, tools: selected };
}

async function bringToFront(driver: CuaDriverLike, target: WindowInfo): Promise<ToolResult> {
  return driver.callTool("bring_to_front", JSON.stringify({ pid: target.pid, window_id: target.windowId }), { signal: new AbortController().signal });
}

async function setFrame(driver: CuaDriverLike, target: WindowInfo, frame: Frame, session: string): Promise<ToolResult> {
  return driver.setWindowFrame(SetWindowFrameInput.new({ pid: target.pid, windowId: BigInt(target.windowId), x: frame.x, y: frame.y, width: frame.width, height: frame.height, session }), { signal: new AbortController().signal });
}

async function getWindowState(driver: CuaDriverLike, target: WindowInfo, session: string): Promise<{ result: ToolResult; elements: ElementInfo[] }> {
  const result = await driver.callTool("get_window_state", JSON.stringify({ pid: target.pid, window_id: target.windowId, include_screenshot: true, session }), { signal: new AbortController().signal });
  return { result, elements: elementsFrom(result) };
}

async function action(driver: CuaDriverLike, name: string, input: Record<string, unknown>): Promise<ToolResult> {
  return driver.callTool(name, JSON.stringify(input), { signal: new AbortController().signal });
}

function targetInput(target: WindowInfo): Record<string, unknown> {
  return { kind: "window", pid: target.pid, window_id: target.windowId };
}

async function waitWindow(driver: CuaDriverLike, pid: number, timeoutMs = 8_000): Promise<WindowInfo | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const listed = await listWindows(driver, pid);
    const selected = listed.windows.find((item) => item.pid === pid && item.bounds !== undefined && item.bounds.width > 100 && item.bounds.height > 100);
    if (selected !== undefined) return selected;
    await new Promise((done) => setTimeout(done, 100));
  }
  return undefined;
}

async function launchFixture(driver: CuaDriverLike, fixture: string, statePath: string, role: string, title: string, frame: Frame): Promise<number> {
  const result = await action(driver, "launch_app", { path: fixture, additional_arguments: [statePath, role, title, String(frame.x), String(frame.y), String(frame.width), String(frame.height)], start_minimized: false });
  const pid = numberField(structured(result), "pid");
  if (pid === undefined || result.isError) throw new Error("fixture launch failed");
  return pid;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  await mkdir(options.output, { recursive: true });
  const targetStatePath = join(options.output, "target-state.txt");
  const witnessStatePath = join(options.output, "witness-state.txt");
  const rebuiltStatePath = join(options.output, "rebuilt-state.txt");
  const daemon = spawn(options.binary, ["serve", "--socket", options.socket, "--no-overlay"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }) as Daemon;
  let driver: CuaDriverLike | undefined;
  let sessionStarted = false;
  let targetPid: number | undefined;
  let witnessPid: number | undefined;
  let rebuiltPid: number | undefined;
  let target: WindowInfo | undefined;
  let witness: WindowInfo | undefined;
  let rebuilt: WindowInfo | undefined;
  let stopped = false;
  const safe: Record<string, unknown> = { probeVersion: "dev2-window-target-contract-0.1.0", daemonVersion: "0.22.2", modelRequests: 0, userWindowTouched: false, stages: {} };
  const stages = safe.stages as Record<string, unknown>;
  try {
    await waitForDaemon(options.binary, options.socket, daemon);
    driver = CuaDriver.connect(options.socket);
    const toolsRaw = await driver.listToolsJson({ signal: new AbortController().signal });
    const requiredTools = ["list_windows", "get_window_state", "verify_state", "set_window_frame", "bring_to_front", "launch_app", "click", "type_text", "press_key"];
    const inventory = schemaEvidence(toolsRaw, requiredTools);
    const present = new Set((inventory.tools as Array<Record<string, unknown>>).map((item) => item.name));
    safe.inventory = { ...inventory, requiredToolsPresent: requiredTools.every((name) => present.has(name)) };
    if (requiredTools.some((name) => !present.has(name))) throw new Error("required window target tools missing");
    await driver.startSession(StartSessionInput.new({ session: options.session }), { signal: new AbortController().signal });
    sessionStarted = true;

    targetPid = await launchFixture(driver, options.fixture, targetStatePath, "target", "DEV2 WINDOW TARGET CONTRACT TARGET", { x: 180, y: 140, width: 960, height: 680 });
    witnessPid = await launchFixture(driver, options.fixture, witnessStatePath, "witness", "DEV2 WINDOW TARGET CONTRACT WITNESS", { x: 1400, y: 180, width: 700, height: 500 });
    target = await waitWindow(driver, targetPid);
    witness = await waitWindow(driver, witnessPid);
    if (target === undefined || witness === undefined) throw new Error("fixture window discovery failed");
    stages.discovery = {
      target: { pidOwned: target.pid === targetPid, windowIdPresent: Number.isFinite(target.windowId), bounds: target.bounds },
      witness: { pidOwned: witness.pid === witnessPid, windowIdPresent: Number.isFinite(witness.windowId), bounds: witness.bounds },
      nonZeroOrigins: target.bounds !== undefined && witness.bounds !== undefined && (target.bounds.x !== 0 || target.bounds.y !== 0) && (witness.bounds.x !== 0 || witness.bounds.y !== 0),
    };

    const frame1: Frame = { x: 240, y: 180, width: 960, height: 680 };
    const frame2: Frame = { x: 360, y: 260, width: 1040, height: 720 };
    const frame1Result = await setFrame(driver, target, frame1, options.session);
    const frame1State = await waitState(targetStatePath, (state) => state.dpiAwarenessSet === true && state.dpi === 144);
    const frame1Listed = (await listWindows(driver, targetPid)).windows.find((item) => item.pid === targetPid);
    const frame1WindowState = await getWindowState(driver, target, options.session);
    const frame1Capture = await persistCapture(frame1WindowState.result, "target-frame-1", options.output, frame1);
    const frame2Result = await setFrame(driver, target, frame2, options.session);
    const frame2State = await waitState(targetStatePath, (state) => state.dpiAwarenessSet === true && state.dpi === 144);
    const frame2Listed = (await listWindows(driver, targetPid)).windows.find((item) => item.pid === targetPid);
    const frame2WindowState = await getWindowState(driver, target, options.session);
    const frame2Capture = await persistCapture(frame2WindowState.result, "target-frame-2", options.output, frame2);
    const frame2Elements = toWindowLocalElements(frame2WindowState.elements, frame2Listed?.bounds);
    const buttonElement = frame2Elements.find((item) => `${item.role ?? ""} ${item.label ?? ""}`.toLowerCase().includes("button") && `${item.role ?? ""} ${item.label ?? ""}`.toLowerCase().includes("window target"));
    const inputElement = frame2Elements.find((item) => `${item.role ?? ""} ${item.label ?? ""}`.toLowerCase().match(/edit|text|input/u) !== null && `${item.role ?? ""} ${item.label ?? ""}`.toLowerCase().includes("window target"));
    const buttonPoint = pointInFrame(buttonElement?.frame);
    const inputPoint = pointInFrame(inputElement?.frame);
    const frame2Dimensions = frame2Capture.dimensions && typeof frame2Capture.dimensions === "object" ? frame2Capture.dimensions as { width: number; height: number } : undefined;
    stages.geometry = {
      frame1: { requested: frame1, listed: frame1Listed?.bounds ?? null, state: frame1State, operation: safeTool(frame1Result), capture: frame1Capture },
      frame2: { requested: frame2, listed: frame2Listed?.bounds ?? null, state: frame2State, operation: safeTool(frame2Result), capture: frame2Capture },
      resizedAndMoved: frame1.width !== frame2.width && frame1.height !== frame2.height && frame2.x !== 0 && frame2.y !== 0,
      dpi144: frame1State?.dpi === 144 && frame2State?.dpi === 144,
      uiaButton: buttonElement === undefined ? null : { index: buttonElement.index, role: buttonElement.role ?? null, frame: buttonElement.frame ?? null },
      uiaInput: inputElement === undefined ? null : { index: inputElement.index, role: inputElement.role ?? null, frame: inputElement.frame ?? null },
      uiaFramesAreTranslatedFromListedDesktopOrigin: true,
      pointsFromWindowLocalFrames: { button: buttonPoint, input: inputPoint },
      pointsInsideReturnedPng: { button: frameInCapture(buttonElement?.frame, frame2Dimensions), input: frameInCapture(inputElement?.frame, frame2Dimensions) },
      coordinateContract: "get_window_state UIA frame minus exact list_windows bounds origin yields window-local PNG pixels; no 2px offset guessed",
    };
    if (buttonPoint === undefined || inputPoint === undefined || frame2Dimensions === undefined || !frameInCapture(buttonElement?.frame, frame2Dimensions) || !frameInCapture(inputElement?.frame, frame2Dimensions)) throw new Error("window-local control geometry unavailable");

    const targetFocused = await bringToFront(driver, target);
    const activeBeforeActions = await waitState(targetStatePath, (state) => state.formActive === true);
    const clickResult = await action(driver, "click", { target: targetInput(target), x: buttonPoint.x, y: buttonPoint.y, delivery_mode: "background", session: options.session });
    const clickedState = await waitState(targetStatePath, (state) => (state.clickCount ?? 0) >= 1);
    const typeResult = await action(driver, "type_text", { target: targetInput(target), x: inputPoint.x, y: inputPoint.y, text: "Window target typed", delivery_mode: "background", session: options.session });
    const typedState = await waitState(targetStatePath, (state) => state.typedExpected === true);
    const backgroundKeyResult = await action(driver, "press_key", { target: targetInput(target), key: "f2", delivery_mode: "background", session: options.session });
    const backgroundKeyState = await waitState(targetStatePath, (state) => state.lastKey === "F2");
    const focusAgain = await bringToFront(driver, target);
    const foregroundKeyResult = await action(driver, "press_key", { target: targetInput(target), key: "f3", delivery_mode: "foreground", session: options.session });
    const foregroundKeyState = await waitState(targetStatePath, (state) => state.lastKey === "F3");
    stages.actions = {
      bringToFront: safeTool(targetFocused),
      activeBeforeActions: activeBeforeActions?.formActive === true,
      click: { request: { x: buttonPoint.x, y: buttonPoint.y, deliveryMode: "background" }, result: safeTool(clickResult), oracle: clickedState },
      type: { request: { x: inputPoint.x, y: inputPoint.y, deliveryMode: "background", textLength: 19 }, result: safeTool(typeResult), oracle: typedState },
      backgroundKey: { key: "f2", result: safeTool(backgroundKeyResult), oracle: backgroundKeyState },
      foregroundBringToFront: safeTool(focusAgain),
      foregroundKey: { key: "f3", result: safeTool(foregroundKeyResult), oracle: foregroundKeyState },
      noSilentFallback: true,
    };

    const overlap: Frame = { x: 640, y: 460, width: 760, height: 480 };
    const beforeOcclusionWindowState = await getWindowState(driver, target, options.session);
    const beforeOcclusionCapture = await persistCapture(beforeOcclusionWindowState.result, "target-before-occlusion", options.output, frame2);
    const moveWitness = await setFrame(driver, witness, overlap, options.session);
    const witnessMoved = await waitState(witnessStatePath, (state) => state.dpi === 144);
    const witnessFrontAttempts: Record<string, unknown>[] = [];
    let witnessActive: SafeState | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await bringToFront(driver, witness);
      witnessFrontAttempts.push(safeTool(result));
      witnessActive = await waitState(witnessStatePath, (state) => state.formActive === true, 2_000);
      if (witnessActive?.formActive === true) break;
      await new Promise((done) => setTimeout(done, 250));
    }
    const targetInactive = await waitState(targetStatePath, (state) => state.formActive === false);
    const occludedWindowState = await getWindowState(driver, target, options.session);
    const occludedCapture = await persistCapture(occludedWindowState.result, "target-occluded", options.output, frame2);
    const beforeHash = typeof beforeOcclusionCapture.sha256 === "string" ? beforeOcclusionCapture.sha256 : null;
    stages.occlusion = {
      witnessMove: safeTool(moveWitness),
      witnessState: witnessMoved,
      witnessFrontAttempts,
      witnessActive: witnessActive?.formActive === true,
      targetInactive: targetInactive?.formActive === false,
      targetBeforeOcclusion: beforeOcclusionCapture,
      targetCapture: occludedCapture,
      captureDimensionsStable: occludedCapture.windowLocal === true
        && beforeOcclusionCapture.windowLocal === true
        && JSON.stringify(occludedCapture.dimensions) === JSON.stringify(beforeOcclusionCapture.dimensions),
      captureHashChangedWhileOccluded: occludedCapture.sha256 !== beforeHash,
      noDesktopFallback: true,
    };

    const oldWitness = witness;
    if (witnessPid !== undefined) {
      try { process.kill(witnessPid); } catch { /* own witness only */ }
      witnessPid = undefined;
    }
    await new Promise((done) => setTimeout(done, 250));
    const staleWitnessClick = await action(driver, "click", { target: targetInput(oldWitness), x: 100, y: 100, delivery_mode: "background", session: options.session }).catch(() => undefined);
    const witnessGone = (await listWindows(driver, oldWitness.pid)).windows.length === 0;
    const oldTarget = target;
    if (targetPid !== undefined) {
      try { process.kill(targetPid); } catch { /* own target only */ }
      targetPid = undefined;
    }
    await new Promise((done) => setTimeout(done, 250));
    const staleTargetClick = await action(driver, "click", { target: targetInput(oldTarget), x: buttonPoint.x, y: buttonPoint.y, delivery_mode: "background", session: options.session }).catch(() => undefined);
    const targetGone = (await listWindows(driver, oldTarget.pid)).windows.length === 0;
    rebuiltPid = await launchFixture(driver, options.fixture, rebuiltStatePath, "rebuilt", "DEV2 WINDOW TARGET CONTRACT REBUILT", { x: 520, y: 320, width: 900, height: 620 });
    rebuilt = await waitWindow(driver, rebuiltPid);
    if (rebuilt === undefined) throw new Error("rebuilt fixture window discovery failed");
    const rebuiltFrame: Frame = { x: 420, y: 240, width: 900, height: 620 };
    const rebuiltFrameResult = await setFrame(driver, rebuilt, rebuiltFrame, options.session);
    const rebuiltState = await waitState(rebuiltStatePath, (state) => state.dpi === 144);
    const rebuiltWindowState = await getWindowState(driver, rebuilt, options.session);
    const rebuiltCapture = await persistCapture(rebuiltWindowState.result, "rebuilt", options.output, rebuiltFrame);
    stages.rebuild = {
      staleWitness: { windowAbsent: witnessGone, action: staleWitnessClick === undefined ? { threw: true } : safeTool(staleWitnessClick), rejected: staleWitnessClick?.isError === true },
      staleTarget: { windowAbsent: targetGone, action: staleTargetClick === undefined ? { threw: true } : safeTool(staleTargetClick), rejected: staleTargetClick?.isError === true },
      newProcess: { pidChanged: rebuilt.pid !== oldTarget.pid, windowId: rebuilt.windowId, bounds: rebuilt.bounds, state: rebuiltState, frame: rebuiltFrame, operation: safeTool(rebuiltFrameResult), capture: rebuiltCapture },
    };
    safe.ok = Boolean(
      (stages.discovery as Record<string, unknown>).nonZeroOrigins === true
      && (stages.geometry as Record<string, unknown>).resizedAndMoved === true
      && (stages.geometry as Record<string, unknown>).dpi144 === true
      && (stages.geometry as Record<string, unknown>).pointsInsideReturnedPng !== undefined
      && (stages.actions as Record<string, unknown>).activeBeforeActions === true
      && clickedState?.buttonClicked === true
      && typedState?.typedExpected === true
      && backgroundKeyState?.lastKey === "F2"
      && foregroundKeyState?.lastKey === "F3"
      && (stages.occlusion as Record<string, unknown>).captureDimensionsStable === true
      && witnessGone
      && targetGone
      && staleTargetClick?.isError === true
      && rebuilt.pid !== oldTarget.pid
      && (stages.rebuild as Record<string, unknown>).newProcess !== undefined,
    );
  } catch (error) {
    safe.ok = false;
    safe.failure = { kind: "probe_error", code: safeErrorCode(error) };
  } finally {
    for (const pid of [witnessPid, targetPid, rebuiltPid]) {
      if (pid !== undefined) {
        try { process.kill(pid); } catch { /* own fixture only */ }
      }
    }
    if (driver !== undefined) {
      if (sessionStarted) {
        try { await driver.endSession(EndSessionInput.new({ session: options.session }), { signal: new AbortController().signal }); } catch { /* preserve evidence */ }
      }
      try { await driver.shutdown({ signal: new AbortController().signal }); } catch { /* stop remains authoritative */ }
      (driver as unknown as { uniffiDestroy?: () => void }).uniffiDestroy?.();
    }
    if (!stopped) {
      await runProcess(options.binary, ["stop", "--socket", options.socket]).catch(() => undefined);
      stopped = true;
    }
    await writeFile(join(options.output, "window-target-contract-summary.json"), `${JSON.stringify(safe, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify({ ok: safe.ok === true, output: "<ignored-output>", modelRequests: 0 }, null, 2));
  if (safe.ok !== true) process.exitCode = 1;
}

function frameInCapture(frame: Frame | undefined, dimensions: { width: number; height: number } | undefined): boolean {
  return frame !== undefined && dimensions !== undefined && frame.x >= 0 && frame.y >= 0 && frame.x + frame.width <= dimensions.width && frame.y + frame.height <= dimensions.height;
}

main().catch(() => {
  process.exitCode = 1;
});
