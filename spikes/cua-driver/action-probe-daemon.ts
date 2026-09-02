import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CuaDriver,
  EndSessionInput,
  GetDesktopStateInput,
  GetScreenSizeInput,
  StartSessionInput,
  type CuaDriverLike,
} from "@trycua/cua-driver";

type DaemonProcess = ChildProcessByStdio<null, Readable, Readable>;

interface Options {
  binary: string;
  output: string;
  session: string;
  socket: string;
  startupTimeoutMs: number;
}

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface OperationRecord {
  name: string;
  input: Record<string, unknown>;
  returned: boolean;
  succeeded: boolean;
  isError: boolean | null;
  errorCode: string | null;
  degraded: boolean | null;
  durationMs: number;
  effect?: string;
  route?: string;
  status?: string;
  error?: string;
  /** Structured inside the probe so lifecycle gates check cause, not just failure. */
  errorDetails?: ErrorDetails;
  fixtureState?: Record<string, string> | undefined;
  result?: unknown;
}

interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ErrorDetails {
  message: string;
  tag?: string;
  errorCode?: string;
  tool?: string;
  reason?: string;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function requiredOption(args: string[], name: string): string {
  const value = option(args, name);
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function normalizePipe(value: string): string {
  if (process.platform !== "win32") {
    return value;
  }
  const match = value.match(/^\\+\.\\+pipe\\+(.*)$/i);
  if (!match || match[1] === undefined) {
    return value;
  }
  return `\\\\.\\pipe\\${match[1].replace(/\\+/g, "\\")}`;
}

function parseOptions(args: string[]): Options {
  const timeout = Number(option(args, "--startup-timeout-ms") ?? "20000");
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new Error("--startup-timeout-ms must be a positive integer");
  }
  const session = option(args, "--session") ?? `action-probe-${Date.now()}`;
  return {
    binary: resolve(requiredOption(args, "--binary")),
    output: resolve(option(args, "--output") ?? join("runs", session)),
    session,
    socket: normalizePipe(requiredOption(args, "--socket")),
    startupTimeoutMs: timeout,
  };
}

function jsonSafe(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "bigint") {
    return `${value.toString()}n`;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  if (value instanceof Uint8Array) {
    return { byteLength: value.byteLength };
  }
  if (Array.isArray(value)) {
    const result = value.map((item) => jsonSafe(item, seen));
    seen.delete(value);
    return result;
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    // Raw screenshots can be very large; keep their presence and size, not the pixels.
    if (key === "dataBase64" && typeof item === "string") {
      output.dataBase64Bytes = item.length;
      continue;
    }
    output[key] = jsonSafe(item, seen);
  }
  seen.delete(value);
  return output;
}

function compactToolResult(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  const candidate = value as Record<string, unknown>;
  const result: Record<string, unknown> = {
    text: candidate.text,
    isError: candidate.isError,
    errorCode: candidate.errorCode,
    degraded: candidate.degraded,
    structuredJson: candidate.structuredJson,
    action: candidate.action,
    verification: candidate.verification,
  };
  if (typeof candidate.rawJson === "string") {
    result.rawJson = candidate.rawJson.length > 8000
      ? `${candidate.rawJson.slice(0, 8000)}...[truncated]`
      : candidate.rawJson;
  }
  if (Array.isArray(candidate.images)) {
    result.images = candidate.images.map((image) => {
      if (!image || typeof image !== "object") {
        return image;
      }
      const record = image as Record<string, unknown>;
      return {
        mimeType: record.mimeType,
        dataBase64Bytes: typeof record.dataBase64 === "string" ? record.dataBase64.length : 0,
      };
    });
  }
  return result;
}

function structuredObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = (value as Record<string, unknown>).structuredJson;
  if (typeof raw !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function numberField(value: unknown, key: string): number | undefined {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function screenshotDimensions(operation: OperationRecord): { width: number; height: number } | undefined {
  const structured = structuredObject(operation.result);
  const nestedScreenshot = operation.result && typeof operation.result === "object"
    ? (operation.result as Record<string, unknown>).screenshot
    : undefined;
  const nestedDimensions = nestedScreenshot && typeof nestedScreenshot === "object"
    ? (nestedScreenshot as Record<string, unknown>).dimensions
    : undefined;
  const width = numberField(structured, "screenshot_width")
    ?? numberField(nestedDimensions, "width");
  const height = numberField(structured, "screenshot_height")
    ?? numberField(nestedDimensions, "height");
  return width !== undefined && height !== undefined ? { width, height } : undefined;
}

function errorDetails(error: unknown): ErrorDetails {
  const message = error instanceof Error ? error.message : String(error);
  if (!error || typeof error !== "object") {
    return { message };
  }
  const record = error as Record<string, unknown>;
  const inner = record.inner && typeof record.inner === "object"
    ? record.inner as Record<string, unknown>
    : undefined;
  return {
    message,
    ...(typeof record.tag === "string" ? { tag: record.tag } : {}),
    ...(typeof inner?.errorCode === "string" ? { errorCode: inner.errorCode } : {}),
    ...(typeof inner?.tool === "string" ? { tool: inner.tool } : {}),
    ...(typeof inner?.reason === "string" ? { reason: inner.reason } : {}),
    ...(typeof inner?.message === "string" ? { message: inner.message } : {}),
  };
}

async function readFixtureState(path: string): Promise<Record<string, string> | undefined> {
  try {
    const content = await readFile(path, "utf8");
    const state: Record<string, string> = {};
    for (const line of content.split(/\r?\n/)) {
      const separator = line.indexOf("=");
      if (separator <= 0) continue;
      state[line.slice(0, separator)] = line.slice(separator + 1);
    }
    return state;
  } catch {
    return undefined;
  }
}

async function waitForFixtureState(
  path: string,
  predicate: (state: Record<string, string>) => boolean,
  timeoutMs = 3000,
): Promise<Record<string, string> | undefined> {
  const deadline = Date.now() + timeoutMs;
  let latest = await readFixtureState(path);
  while (Date.now() < deadline) {
    if (latest && predicate(latest)) {
      return latest;
    }
    await new Promise((done) => setTimeout(done, 100));
    latest = await readFixtureState(path);
  }
  return latest;
}

async function waitForFixtureStateStable(
  path: string,
  predicate: (state: Record<string, string>) => boolean,
  timeoutMs = 5000,
  stableForMs = 300,
): Promise<Record<string, string> | undefined> {
  const deadline = Date.now() + timeoutMs;
  let latest = await readFixtureState(path);
  let candidate: string | undefined;
  let stableSince: number | undefined;
  while (Date.now() < deadline) {
    if (latest && predicate(latest)) {
      const serialized = JSON.stringify(latest);
      if (serialized !== candidate) {
        candidate = serialized;
        stableSince = Date.now();
      } else if (stableSince !== undefined && Date.now() - stableSince >= stableForMs) {
        return latest;
      }
    } else {
      candidate = undefined;
      stableSince = undefined;
    }
    await new Promise((done) => setTimeout(done, 100));
    latest = await readFixtureState(path);
  }
  return latest;
}

function intState(state: Record<string, string> | undefined, key: string): number | undefined {
  const value = state?.[key];
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function boolState(state: Record<string, string> | undefined, key: string): boolean {
  return state?.[key] === "True" || state?.[key] === "true";
}

function classify(value: unknown): Pick<OperationRecord, "returned" | "succeeded" | "isError" | "errorCode" | "degraded" | "effect" | "route" | "status"> {
  if (value === undefined) {
    return { returned: false, succeeded: false, isError: null, errorCode: null, degraded: null };
  }
  if (!value || typeof value !== "object") {
    return { returned: true, succeeded: true, isError: null, errorCode: null, degraded: null };
  }
  const record = value as Record<string, unknown>;
  const isError = typeof record.isError === "boolean" ? record.isError : null;
  const errorCode = typeof record.errorCode === "string" ? record.errorCode : null;
  const degraded = typeof record.degraded === "boolean" ? record.degraded : null;
  const structured = structuredObject(value);
  const effect = typeof structured?.effect === "string" ? structured.effect : undefined;
  const route = typeof structured?.route === "string" ? structured.route : undefined;
  const status = typeof structured?.status === "string" ? structured.status : undefined;
  return {
    returned: true,
    succeeded: isError !== true && errorCode === null && degraded !== true,
    isError,
    errorCode,
    degraded,
    ...(effect === undefined ? {} : { effect }),
    ...(route === undefined ? {} : { route }),
    ...(status === undefined ? {} : { status }),
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(jsonSafe(value), null, 2)}\n`, "utf8");
}

function collectChild(child: DaemonProcess): Promise<ChildResult> {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  return new Promise((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveResult({ code, signal, stdout, stderr }));
  });
}

async function runCli(binary: string, args: string[]): Promise<ChildResult> {
  return collectChild(spawn(binary, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }));
}

async function waitForDaemon(options: Options, daemon: DaemonProcess): Promise<ChildResult> {
  const deadline = Date.now() + options.startupTimeoutMs;
  let last: ChildResult = { code: null, signal: null, stdout: "", stderr: "" };
  while (Date.now() < deadline) {
    if (daemon.exitCode !== null || daemon.signalCode !== null) {
      throw new Error(`daemon exited before readiness: ${last.stderr || "no stderr"}`);
    }
    last = await runCli(options.binary, ["status", "--socket", options.socket]);
    if (last.code === 0 && /daemon is running/i.test(last.stdout)) {
      return last;
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`daemon readiness timeout: ${last.stdout}\n${last.stderr}`);
}

async function stopDaemon(options: Options, daemon: DaemonProcess): Promise<ChildResult> {
  const stopped = await runCli(options.binary, ["stop", "--socket", options.socket]);
  if (stopped.code === 0 && daemon.exitCode === null && daemon.signalCode === null) {
    await new Promise<void>((done) => {
      const timer = setTimeout(done, 5000);
      daemon.once("close", () => {
        clearTimeout(timer);
        done();
      });
    });
  }
  if (daemon.exitCode === null && daemon.signalCode === null) {
    daemon.kill();
  }
  return stopped;
}

async function readPngDimensions(path: string): Promise<{ width: number; height: number } | undefined> {
  try {
    const bytes = await readFile(path);
    if (bytes.length < 24 || bytes.toString("ascii", 1, 4) !== "PNG" || bytes.toString("ascii", 12, 16) !== "IHDR") {
      return undefined;
    }
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  } catch {
    return undefined;
  }
}

async function compileFixture(output: string): Promise<string> {
  if (process.platform !== "win32") {
    throw new Error("the S3-1B action fixture currently requires Windows");
  }
  const source = fileURLToPath(new URL("./fixture/ProbeWindow.cs", import.meta.url));
  const executable = join(output, "computer-harness-fixture.exe");
  const compiler = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
  const result = await runCli(compiler, [
    "/nologo",
    "/target:winexe",
    `/out:${executable}`,
    "/reference:System.dll",
    "/reference:System.Drawing.dll",
    "/reference:System.Windows.Forms.dll",
    source,
  ]);
  if (result.code !== 0) {
    throw new Error(`fixture compilation failed: ${result.stderr || result.stdout}`);
  }
  return executable;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  await mkdir(options.output, { recursive: true });
  const fixtureExecutable = await compileFixture(options.output);
  const fixtureStatePath = join(options.output, "fixture-state.txt");
  const daemon = spawn(options.binary, ["serve", "--socket", options.socket, "--no-overlay"], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let daemonStdout = "";
  let daemonStderr = "";
  daemon.stdout.setEncoding("utf8");
  daemon.stderr.setEncoding("utf8");
  daemon.stdout.on("data", (chunk: string) => (daemonStdout += chunk));
  daemon.stderr.on("data", (chunk: string) => (daemonStderr += chunk));

  const records: OperationRecord[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  let driver: CuaDriverLike | undefined;
  let sessionStarted = false;
  let ended = false;
  let stopped = false;
  let pid: number | undefined;
  let fixtureOwned = false;
  let windowBounds: WindowBounds | undefined;
  let gateResults: Record<string, boolean> | undefined;
  let gatesPassed = false;

  const invoke = async (name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<OperationRecord> => {
    const started = Date.now();
    try {
      const value = await driver!.callTool(name, JSON.stringify(input), signal ? { signal } : undefined);
      const status = classify(value);
      const record: OperationRecord = {
        name,
        input,
        ...status,
        durationMs: Date.now() - started,
        result: compactToolResult(value),
      };
      records.push(record);
      return record;
    } catch (error) {
      const details = errorDetails(error);
      const record: OperationRecord = {
        name,
        input,
        returned: false,
        succeeded: false,
        isError: null,
        errorCode: null,
        degraded: null,
        durationMs: Date.now() - started,
        error: JSON.stringify(details),
        errorDetails: details,
        ...(details.errorCode === undefined ? {} : { errorCode: details.errorCode }),
      };
      records.push(record);
      return record;
    }
  };

  const capture = async (label: string): Promise<OperationRecord> => {
    const path = join(options.output, `${label}.png`);
    const operation = await invoke("get_desktop_state", { session: options.session, screenshot_out_file: path });
    const dimensions = await readPngDimensions(path);
    operation.result = { ...(operation.result as Record<string, unknown> | undefined), screenshot: { path, dimensions } };
    return operation;
  };

  const settleInput = async (): Promise<void> => {
    // SendInput is asynchronous at the application boundary. A short settle
    // window prevents a screenshot from being mistaken for a dropped action.
    await new Promise((done) => setTimeout(done, 500));
  };

  try {
    await waitForDaemon(options, daemon);
    driver = CuaDriver.connect(options.socket);
    const metadata = await driver.metadata();
    await writeJson(join(options.output, "metadata.json"), metadata);
    await driver.startSession(StartSessionInput.new({ session: options.session }));
    sessionStarted = true;

    const existing = await invoke("list_windows", { on_screen_only: true, session: options.session });
    const existingWindows = structuredObject(existing.result)?.windows;
    const existingFixture = Array.isArray(existingWindows)
      && existingWindows.some((item) => /computer harness probe fixture/i.test(String(item && typeof item === "object" ? `${(item as Record<string, unknown>).app_name ?? ""} ${(item as Record<string, unknown>).title ?? ""}` : "")));
    if (existingFixture) {
      throw new Error("refusing to run: a probe fixture window already exists; close it to keep the fixture isolated");
    }

    const launch = await invoke("launch_app", {
      path: fixtureExecutable,
      additional_arguments: [fixtureStatePath],
      start_minimized: false,
      session: options.session,
    });
    const launched = structuredObject(launch.result);
    const launchedPid = numberField(launched, "pid");
    const launchedWindows = Array.isArray(launched?.windows) ? launched.windows : [];
    if (launchedPid !== undefined) {
      pid = launchedPid;
      fixtureOwned = true;
      if (launchedWindows.length !== 1) {
        // Record unexpected multi-window behaviour, but the pre-launch guard
        // still makes the complete fixture process safe to clean up.
        warnings.push(`launch_app returned ${launchedWindows.length} probe fixture windows in the fixture process`);
      }
    }
    if (pid === undefined) {
      throw new Error("launch_app did not return one isolated probe fixture window");
    }

    let windowId: number | undefined;
    if (pid !== undefined) {
      const windowsRecord = await invoke("list_windows", { pid, on_screen_only: true, session: options.session });
      const listed = structuredObject(windowsRecord.result);
      const windows = Array.isArray(listed?.windows) ? listed.windows : [];
      const candidates = windows.filter((item) => item && typeof item === "object");
      const selected = candidates.sort((left, right) => (numberField(right, "z_index") ?? -1) - (numberField(left, "z_index") ?? -1))[0];
      windowId = numberField(selected, "window_id");
      const bounds = selected && typeof selected === "object" ? (selected as Record<string, unknown>).bounds : undefined;
      if (bounds && typeof bounds === "object") {
        const b = bounds as Record<string, unknown>;
        const values = [b.x, b.y, b.width, b.height];
        if (values.every((value) => typeof value === "number" && Number.isFinite(value))) {
          windowBounds = { x: b.x as number, y: b.y as number, width: b.width as number, height: b.height as number };
        }
      }
      await invoke("bring_to_front", { pid, ...(windowId === undefined ? {} : { window_id: windowId }), session: options.session });
    }

    const screenSize = await invoke("get_screen_size", { session: options.session });
    await settleInput();
    const fixtureBeforeState = await readFixtureState(fixtureStatePath);
    const before = await capture("before");
    const point = windowBounds
      ? {
          x: Math.round(windowBounds.x + Math.max(24, Math.min(220, windowBounds.width * 0.45))),
          y: Math.round(windowBounds.y + Math.max(100, Math.min(220, windowBounds.height * 0.45))),
        }
      : { x: 400, y: 300 };
    const desktopTarget = { kind: "desktop", display_id: "primary" };

    const click = await invoke("click", {
      session: options.session,
      target: desktopTarget,
      x: point.x,
      y: point.y,
      delivery_mode: "foreground",
    });
    click.fixtureState = await waitForFixtureState(fixtureStatePath, (state) => state.event === "mouse_up");
    const afterClick = await capture("after-click");
    const englishChinese = "Computer-Harness probe EN | 中文输入";
    const type = await invoke("type_text", {
      session: options.session,
      target: desktopTarget,
      text: englishChinese,
      delivery_mode: "foreground",
      delay_ms: 20,
    });
    type.fixtureState = await waitForFixtureState(fixtureStatePath, (state) => boolState(state, "containsProbeText"));
    const afterType = await capture("after-type");
    const pressBeforeState = await readFixtureState(fixtureStatePath);
    const press = await invoke("press_key", {
      session: options.session,
      target: desktopTarget,
      key: "left",
      delivery_mode: "foreground",
    });
    const pressInitialCaret = intState(pressBeforeState, "selectionStart");
    press.fixtureState = await waitForFixtureState(fixtureStatePath, (state) => {
      const caret = intState(state, "selectionStart");
      return state.lastKey === "Left" && caret !== undefined && (pressInitialCaret === undefined || caret !== pressInitialCaret);
    });
    const hotkeyBeforeState = await readFixtureState(fixtureStatePath);
    const hotkey = await invoke("hotkey", {
      session: options.session,
      target: desktopTarget,
      keys: ["ctrl", "a"],
      delivery_mode: "foreground",
    });
    hotkey.fixtureState = await waitForFixtureState(fixtureStatePath, (state) => state.lastKey === "A" && state.lastModifiers?.includes("Control") === true && (intState(state, "selectionLength") ?? 0) > 0);
    const longText = Array.from({ length: 40 }, (_, index) => `scroll-line-${index + 1}`).join("\n");
    const longType = await invoke("type_text", {
      session: options.session,
      target: desktopTarget,
      text: `\n${longText}`,
      delivery_mode: "foreground",
      delay_ms: 0,
    });
    longType.fixtureState = await waitForFixtureState(fixtureStatePath, (state) => (intState(state, "longLineCount") ?? 0) >= 40, 20000);
    const scrollReset = await invoke("hotkey", {
      session: options.session,
      target: desktopTarget,
      keys: ["ctrl", "home"],
      delivery_mode: "foreground",
    });
    scrollReset.fixtureState = await waitForFixtureStateStable(
      fixtureStatePath,
      (state) => intState(state, "firstVisibleLine") === 0,
      5000,
    );
    const scrollPageBeforeState = scrollReset.fixtureState ?? await readFixtureState(fixtureStatePath);
    const beforeLineForWait = intState(scrollPageBeforeState, "firstVisibleLine");
    const scrollPage = await invoke("scroll", {
      session: options.session,
      target: desktopTarget,
      x: point.x,
      y: point.y,
      direction: "down",
      by: "page",
      amount: 1,
      delivery_mode: "foreground",
    });
    scrollPage.fixtureState = await waitForFixtureStateStable(fixtureStatePath, (state) => {
      const current = intState(state, "firstVisibleLine");
      return current !== undefined && (beforeLineForWait === undefined || current !== beforeLineForWait);
    });
    const scrollLineBeforeState = await readFixtureState(fixtureStatePath);
    const pageLineForWait = intState(scrollLineBeforeState, "firstVisibleLine");
    const scrollLine = await invoke("scroll", {
      session: options.session,
      target: desktopTarget,
      x: point.x,
      y: point.y,
      direction: "up",
      by: "line",
      amount: 2,
      delivery_mode: "foreground",
    });
    scrollLine.fixtureState = await waitForFixtureStateStable(fixtureStatePath, (state) => {
      const current = intState(state, "firstVisibleLine");
      return current !== undefined && (pageLineForWait === undefined || current !== pageLineForWait);
    });
    const dragBeforeState = await readFixtureState(fixtureStatePath);
    const dragCountForWait = intState(dragBeforeState, "dragCount") ?? 0;
    const drag = await invoke("drag", {
      session: options.session,
      target: windowId === undefined || pid === undefined
        ? desktopTarget
        : { kind: "window", pid, window_id: windowId },
      from_x: windowBounds ? Math.max(24, Math.min(220, windowBounds.width * 0.45)) : 120,
      from_y: windowBounds ? Math.max(100, Math.min(220, windowBounds.height * 0.45)) : 160,
      to_x: (windowBounds ? Math.max(24, Math.min(220, windowBounds.width * 0.45)) : 120) + 180,
      to_y: windowBounds ? Math.max(100, Math.min(220, windowBounds.height * 0.45)) : 160,
      duration_ms: 150,
      steps: 8,
      delivery_mode: "foreground",
    });
    drag.fixtureState = await waitForFixtureState(fixtureStatePath, (state) => (intState(state, "dragCount") ?? 0) > dragCountForWait, 2000);
    const afterScrollDrag = await capture("after-scroll-drag");
    const fixtureAfterState = await readFixtureState(fixtureStatePath);
    const invalidCoordinate = await invoke("click", {
      session: options.session,
      target: desktopTarget,
      x: -1,
      y: -1,
      delivery_mode: "foreground",
    });

    const preAbortController = new AbortController();
    preAbortController.abort();
    const preAbortStarted = Date.now();
    let preAbort: OperationRecord;
    try {
      await driver.getScreenSize(GetScreenSizeInput.new({ session: options.session }), { signal: preAbortController.signal });
      preAbort = {
        name: "pre-abort:get_screen_size",
        input: { session: options.session },
        returned: true,
        succeeded: true,
        isError: false,
        errorCode: null,
        degraded: null,
        durationMs: Date.now() - preAbortStarted,
      };
    } catch (error) {
      const details = errorDetails(error);
      preAbort = {
        name: "pre-abort:get_screen_size",
        input: { session: options.session },
        returned: false,
        succeeded: false,
        isError: null,
        errorCode: null,
        degraded: null,
        durationMs: Date.now() - preAbortStarted,
        error: JSON.stringify(details),
        errorDetails: details,
        ...(details.errorCode === undefined ? {} : { errorCode: details.errorCode }),
      };
    }
    records.push(preAbort);

    const midAbortController = new AbortController();
    const midAbortPath = join(options.output, "mid-abort.png");
    const midAbortStarted = Date.now();
    const midAbortPromise = driver.getDesktopState(
      GetDesktopStateInput.new({ session: options.session, screenshotOutFile: midAbortPath }),
      { signal: midAbortController.signal },
    );
    setTimeout(() => midAbortController.abort(), 1);
    let midAbort: OperationRecord;
    try {
      const value = await midAbortPromise;
      midAbort = {
        name: "mid-abort:get_desktop_state",
        input: { session: options.session, screenshot_out_file: midAbortPath },
        returned: true,
        succeeded: true,
        isError: false,
        errorCode: null,
        degraded: null,
        durationMs: Date.now() - midAbortStarted,
        result: compactToolResult(value),
      };
    } catch (error) {
      const details = errorDetails(error);
      midAbort = {
        name: "mid-abort:get_desktop_state",
        input: { session: options.session, screenshot_out_file: midAbortPath },
        returned: false,
        succeeded: false,
        isError: null,
        errorCode: null,
        degraded: null,
        durationMs: Date.now() - midAbortStarted,
        error: JSON.stringify(details),
        errorDetails: details,
        ...(details.errorCode === undefined ? {} : { errorCode: details.errorCode }),
      };
    }
    records.push(midAbort);

    // End the action session before cleanup. This keeps the lifecycle gate
    // independent from process termination (and lets cleanup use a fresh
    // session if a driver treats kill_app as a session-affecting operation).
    const endAttempt = await invoke("end_session", { session: options.session });
    let endRecord = endAttempt;
    if (endAttempt.errorCode === "session_cleanup_pending") {
      // The daemon may finish an aborted read-only future asynchronously. A
      // single bounded retry observes the terminal cleanup state; it never
      // retries a GUI side effect.
      await settleInput();
      endRecord = await invoke("end_session", { session: options.session });
    }
    ended = endRecord.succeeded;
    const postEndStarted = Date.now();
    let postEnd: OperationRecord;
    try {
      const value = await driver.callTool("click", JSON.stringify({
        session: options.session,
        target: desktopTarget,
        x: point.x,
        y: point.y,
        delivery_mode: "foreground",
      }));
      const status = classify(value);
      postEnd = { name: "post-end:click", input: { session: options.session }, ...status, durationMs: Date.now() - postEndStarted, result: compactToolResult(value) };
    } catch (error) {
      const details = errorDetails(error);
      postEnd = { name: "post-end:click", input: { session: options.session }, returned: false, succeeded: false, isError: null, errorCode: details.errorCode ?? null, degraded: null, durationMs: Date.now() - postEndStarted, error: JSON.stringify(details), errorDetails: details };
    }
    records.push(postEnd);

    let kill: OperationRecord | undefined;
    let hostCleanup: { requested: boolean; succeeded: boolean; error?: string } = { requested: false, succeeded: false };
    if (pid !== undefined && fixtureOwned) {
      const cleanupSession = `${options.session}-cleanup`;
      try {
        await driver.startSession(StartSessionInput.new({ session: cleanupSession }));
        kill = await invoke("kill_app", { pid, session: cleanupSession });
        try {
          await driver.endSession(EndSessionInput.new({ session: cleanupSession }));
        } catch {
          // Cleanup is best effort; the main lifecycle evidence is retained.
        }
      } catch (error) {
        errors.push(`cleanup: ${error instanceof Error ? error.message : String(error)}`);
      }
      // Standard daemon policy intentionally refuses kill_app for a process
      // it cannot prove as runtime-owned. The PID came from this probe's
      // launch, so terminate exactly that fixture as host-side best effort.
      hostCleanup.requested = true;
      try {
        process.kill(pid);
        hostCleanup.succeeded = true;
      } catch (error) {
        hostCleanup.error = error instanceof Error ? error.message : String(error);
      }
    }

    const disconnectSession = `${options.session}-disconnect`;
    await driver.startSession(StartSessionInput.new({ session: disconnectSession }));
    const stopResult = await stopDaemon(options, daemon);
    stopped = true;
    const disconnectStarted = Date.now();
    let disconnect: OperationRecord;
    try {
      const value = await driver.getScreenSize(GetScreenSizeInput.new({ session: disconnectSession }));
      disconnect = { name: "post-disconnect:get_screen_size", input: { session: disconnectSession }, returned: true, succeeded: true, isError: false, errorCode: null, degraded: null, durationMs: Date.now() - disconnectStarted, result: compactToolResult(value) };
    } catch (error) {
      const details = errorDetails(error);
      disconnect = { name: "post-disconnect:get_screen_size", input: { session: disconnectSession }, returned: false, succeeded: false, isError: null, errorCode: details.errorCode ?? null, degraded: null, durationMs: Date.now() - disconnectStarted, error: JSON.stringify(details), errorDetails: details };
    }
    records.push(disconnect);

    await writeJson(join(options.output, "actions.json"), records);
    const beforeLine = intState(scrollPageBeforeState, "firstVisibleLine");
    const afterPageLine = intState(scrollPage.fixtureState, "firstVisibleLine");
    const afterLineLine = intState(scrollLine.fixtureState, "firstVisibleLine");
    const lineBefore = intState(scrollLineBeforeState, "firstVisibleLine");
    const pageDelta = beforeLine !== undefined && afterPageLine !== undefined
      ? afterPageLine - beforeLine
      : undefined;
    const lineDelta = lineBefore !== undefined && afterLineLine !== undefined
      ? afterLineLine - lineBefore
      : undefined;
    const beforeDragCount = intState(dragBeforeState, "dragCount") ?? 0;
    const afterDragCount = intState(drag.fixtureState, "dragCount") ?? 0;
    const pressBeforeCaret = intState(pressBeforeState, "selectionStart");
    const pressAfterCaret = intState(press.fixtureState, "selectionStart");
    const hotkeyAfterCaret = intState(hotkey.fixtureState, "selectionStart");
    const screenWidth = numberField(structuredObject(screenSize.result), "width");
    const screenHeight = numberField(structuredObject(screenSize.result), "height");
    const beforeDimensions = screenshotDimensions(before);
    const afterClickDimensions = screenshotDimensions(afterClick);
    const g1 = screenSize.succeeded
      && screenWidth !== undefined
      && screenHeight !== undefined
      && beforeDimensions !== undefined
      && afterClickDimensions !== undefined
      && beforeDimensions.width === screenWidth
      && beforeDimensions.height === screenHeight
      && afterClickDimensions.width === screenWidth
      && afterClickDimensions.height === screenHeight
      && boolState(type.fixtureState, "containsProbeText");
    const g2 = click.succeeded
      && drag.succeeded
      && afterDragCount > beforeDragCount
      && type.succeeded
      && boolState(type.fixtureState, "containsProbeText")
      && longType.succeeded
      && (intState(longType.fixtureState, "longLineCount") ?? 0) >= 40
      && press.succeeded
      && press.fixtureState?.lastKey === "Left"
      && pressBeforeCaret !== undefined
      && pressAfterCaret !== undefined
      && pressAfterCaret === pressBeforeCaret - 1
      && hotkey.succeeded
      && hotkey.fixtureState?.lastKey === "A"
      && hotkey.fixtureState?.lastModifiers?.includes("Control") === true
      && (intState(hotkey.fixtureState, "selectionLength") ?? 0) > 0
      && scrollPage.succeeded
      && scrollLine.succeeded
      && beforeLine !== undefined
      && afterPageLine !== undefined
      && afterLineLine !== undefined
      && pageDelta !== undefined
      && lineDelta !== undefined
      && pageDelta !== 0
      && lineDelta !== 0
      && Math.sign(pageDelta) === -Math.sign(lineDelta);
    const invalidResult = invalidCoordinate.result && typeof invalidCoordinate.result === "object"
      ? invalidCoordinate.result as Record<string, unknown>
      : undefined;
    const g3 = click.succeeded
      && type.succeeded
      && invalidCoordinate.returned
      && invalidCoordinate.isError === true
      && !invalidCoordinate.succeeded
      && typeof invalidResult?.text === "string";
    const endActive = structuredObject(endRecord.result)?.active;
    const postEndError = postEnd.errorDetails;
    const preAbortMessage = preAbort.errorDetails?.message ?? preAbort.error ?? "";
    const midAbortMessage = midAbort.errorDetails?.message ?? midAbort.error ?? "";
    const disconnectError = disconnect.errorDetails;
    const g4 = endRecord.succeeded
      && endActive === false
      && !postEnd.succeeded
      && postEndError?.tag === "Tool"
      && postEndError.tool === "click"
      && !preAbort.succeeded
      && /aborted/i.test(preAbortMessage)
      && !midAbort.succeeded
      && /aborted/i.test(midAbortMessage)
      && !disconnect.succeeded
      && disconnectError?.tag === "Transport";
    const gates = { g1, g2, g3, g4 };
    const probeOk = errors.length === 0 && Object.values(gates).every(Boolean);
    gateResults = gates;
    gatesPassed = probeOk;
    await writeJson(join(options.output, "gate-summary.json"), {
      ok: probeOk,
      gates,
      g1PrimaryDesktop: {
        clickReturned: click.returned,
        screenSize: screenSize.result,
        screenDimensions: { width: screenWidth, height: screenHeight },
        before: before.result,
        after: afterClick.result,
        fixtureStateBefore: fixtureBeforeState,
        fixtureStateAfterType: type.fixtureState,
        evidence: { typeTextObserved: boolState(type.fixtureState, "containsProbeText") },
      },
      g2ActionGroups: {
        pointer: { click: click.succeeded, drag: drag.succeeded, dragObserved: afterDragCount > beforeDragCount },
        keyboard: {
          typeText: type.succeeded,
          longTypeText: { returned: longType.returned, succeeded: longType.succeeded, longLineCount: intState(longType.fixtureState, "longLineCount") },
          pressKey: { returned: press.returned, succeeded: press.succeeded, observedKey: press.fixtureState?.lastKey, caretBefore: pressBeforeCaret, caretAfter: pressAfterCaret },
          hotkey: { returned: hotkey.returned, succeeded: hotkey.succeeded, observedKey: hotkey.fixtureState?.lastKey, observedModifiers: hotkey.fixtureState?.lastModifiers, caretBefore: intState(hotkeyBeforeState, "selectionStart"), caretAfter: hotkeyAfterCaret },
        },
        scroll: {
          reset: { returned: scrollReset.returned, succeeded: scrollReset.succeeded, firstVisibleLine: intState(scrollReset.fixtureState, "firstVisibleLine") },
          page: { returned: scrollPage.returned, succeeded: scrollPage.succeeded, firstVisibleLineBefore: beforeLine, firstVisibleLineAfter: afterPageLine, delta: pageDelta, stable: scrollPage.fixtureState !== undefined },
          line: { returned: scrollLine.returned, succeeded: scrollLine.succeeded, firstVisibleLineBefore: lineBefore, firstVisibleLineAfter: afterLineLine, delta: lineDelta, stable: scrollLine.fixtureState !== undefined },
          oppositeDirections: pageDelta !== undefined && lineDelta !== undefined && pageDelta !== 0 && lineDelta !== 0 && Math.sign(pageDelta) === -Math.sign(lineDelta),
        },
      },
      g3ResultMapping: {
        acceptedAction: click.succeeded,
        completedCandidate: click.succeeded && type.succeeded,
        explicitRefusalCandidate: !invalidCoordinate.succeeded,
        rawDriverJsonKeptPrivate: true,
      },
      g4Lifecycle: {
        normalEnd: {
          initial: { returned: endAttempt.returned, succeeded: endAttempt.succeeded, error: endAttempt.error ?? endAttempt.errorCode },
          final: { returned: endRecord.returned, succeeded: endRecord.succeeded, active: ended ? false : null, result: endRecord.result, error: endRecord.error ?? endRecord.errorCode },
        },
        postEndAction: { rejected: !postEnd.succeeded, error: postEnd.error ?? postEnd.errorCode, errorDetails: postEnd.errorDetails },
        preAbortReadOnly: { rejected: !preAbort.succeeded, error: preAbort.error ?? preAbort.errorCode, errorDetails: preAbort.errorDetails },
        midAbortReadOnly: { outcome: midAbort.succeeded ? "completed_before_abort_or_abort_ignored" : "rejected", error: midAbort.error ?? midAbort.errorCode, errorDetails: midAbort.errorDetails },
        daemonDisconnect: { rejected: !disconnect.succeeded, error: disconnect.error ?? disconnect.errorCode, errorDetails: disconnect.errorDetails },
      },
      screenshotFiles: [before.result, afterClick.result, afterType.result, afterScrollDrag.result],
      fixtureStateAfterActions: fixtureAfterState,
      cleanup: { killApp: kill?.succeeded ?? false, hostFixturePid: pid, hostCleanup, daemonStopCode: stopResult.code },
    });
    if (!probeOk) {
      errors.push(`mandatory gate failed: ${Object.entries(gates).filter(([, passed]) => !passed).map(([name]) => name).join(", ")}`);
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    if (driver) {
      if (sessionStarted && !ended) {
        try {
          await driver.endSession(EndSessionInput.new({ session: options.session }));
        } catch {
          // Preserve the primary probe error; cleanup diagnostics are in the daemon log.
        }
      }
      try {
        await driver.shutdown();
      } catch {
        // A disconnected daemon is the expected final state for G4.
      }
      const destroy = (driver as unknown as { uniffiDestroy?: () => void }).uniffiDestroy;
      destroy?.call(driver);
    }
    if (!stopped && daemon.exitCode === null && daemon.signalCode === null) {
      try {
        await stopDaemon(options, daemon);
      } catch (error) {
        errors.push(`daemon cleanup: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await writeFile(join(options.output, "daemon-stdout.log"), daemonStdout, "utf8");
    await writeFile(join(options.output, "daemon-stderr.log"), daemonStderr, "utf8");
    await writeJson(join(options.output, "probe-summary.json"), {
      probeVersion: "0.2.0-s3-1c",
      transport: "independent-daemon",
      session: options.session,
      binary: options.binary,
      ok: gatesPassed && errors.length === 0,
      gates: gateResults,
      screenshots: ["before.png", "after-click.png", "after-type.png", "after-scroll-drag.png"],
      operationCount: records.length,
      errors,
      warnings,
    });
  }

  const failed = errors.length > 0 || records.some((record) => record.name === "launch_app" && !record.succeeded);
  process.exitCode = failed ? 1 : 0;
  console.log(JSON.stringify({ ok: !failed, output: options.output, operationCount: records.length, errors, warnings }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
