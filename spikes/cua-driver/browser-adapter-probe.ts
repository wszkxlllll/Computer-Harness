import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";
import {
  CuaDriver,
  EndSessionInput,
  SetWindowFrameInput,
  StartSessionInput,
  type CuaDriverLike,
  type ToolResult,
} from "@trycua/cua-driver-0.22.2";
import { CuaDriverComputer } from "@computer-harness/computer-cua";
import type { ActionId, ActionIntent, ComputerSessionDescriptor, ObservationId } from "@computer-harness/protocol";

type Daemon = ChildProcessByStdio<null, Readable, Readable>;
type Frame = { x: number; y: number; width: number; height: number };
type WindowInfo = { pid: number; windowId: number; bounds: Frame };

const PROBE_TEXT = "CUA synthetic browser input";
const REPLACEMENT_TEXT = "CUA replaced value";
const SETUP_SESSION = "browser-adapter-probe-setup";
const ADAPTER_SESSION = "browser-adapter-probe-adapter";

interface Options {
  binary: string;
  browser: string;
  output: string;
  socket: string;
  allowInput: boolean;
}

interface OracleRecord {
  event: string;
  serial: number;
  inputLength: number;
  matchesProbe: boolean;
  matchesReplacement: boolean;
  selectionLength: number;
  scrollY: number;
  activeInput: boolean;
}

interface OracleState {
  latest?: OracleRecord;
  reports: number;
}

interface SafeReceipt {
  status: string;
  driverCode: string | null;
  messageLength: number;
}

interface Summary {
  probeVersion: string;
  ok: boolean;
  allowInput: boolean;
  browserPath: string;
  socketConfigured: boolean;
  modelRequests: number;
  userWindowTouched: boolean;
  layout?: {
    screen: Frame;
    requestedTarget: Frame;
    actualTarget: Frame;
    targetRightHalf: boolean;
    targetWindowId: number;
    targetPidOwned: boolean;
  };
  observation?: {
    viewport: { width: number; height: number; coordinateSpace: string };
    bytes: number;
    windowLocal: boolean;
  };
  actions?: Record<string, unknown>;
  oracle?: {
    reports: number;
    clickFocused: boolean;
    typedProbe: boolean;
    ctrlASelected: boolean;
    replacedValue: boolean;
    scrolled: boolean;
    finalScrollY: number;
  };
  cleanup?: {
    browserPid?: number;
    profileDirectoryRemoved: boolean;
    daemonStopRequested: boolean;
  };
  failure?: { name: string; message: string };
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function required(args: readonly string[], name: string): string {
  const value = option(args, name);
  if (value === undefined || value.trim().length === 0) throw new Error(`${name} is required`);
  return value;
}

function normalizePipe(value: string): string {
  if (process.platform !== "win32") return value;
  const match = value.match(/^\\+\.\\+pipe\\+(.*)$/iu);
  return match?.[1] === undefined ? value : `\\\\.\\pipe\\${match[1].replace(/\\+/gu, "\\")}`;
}

function parseOptions(args: readonly string[]): Options {
  const allowInput = args.includes("--allow-input");
  if (!allowInput) {
    throw new Error("refusing to launch a GUI or send input without explicit --allow-input (root must notify before running)");
  }
  const binary = resolve(required(args, "--binary"));
  const browser = resolve(option(args, "--browser") ?? defaultBrowserPath());
  if (process.platform === "win32" && (![binary, browser].every((value) => /^[\x00-\x7f]*$/u.test(value)))) {
    throw new Error("binary and browser paths must be ASCII-only on Windows for this probe");
  }
  return {
    allowInput,
    binary,
    browser,
    output: resolve(option(args, "--output") ?? `runs/browser-adapter-${Date.now()}`),
    socket: normalizePipe(required(args, "--socket")),
  };
}

function defaultBrowserPath(): string {
  const candidates = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? "msedge.exe";
}

function structured(result: { structuredJson?: string }): Record<string, unknown> | undefined {
  if (typeof result.structuredJson !== "string") return undefined;
  try {
    const value = JSON.parse(result.structuredJson) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function numberField(value: unknown, key: string): number | undefined {
  const field = value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function readFrame(value: unknown): Frame | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const x = numberField(record, "x");
  const y = numberField(record, "y");
  const width = numberField(record, "width");
  const height = numberField(record, "height");
  return x === undefined || y === undefined || width === undefined || height === undefined
    ? undefined
    : { x, y, width, height };
}

function windowsFrom(result: ToolResult): WindowInfo[] {
  const windows = structured(result)?.windows;
  if (!Array.isArray(windows)) return [];
  return windows.flatMap((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    const pid = numberField(item, "pid");
    const windowId = numberField(item, "window_id");
    const bounds = readFrame(item.bounds);
    return pid === undefined || windowId === undefined || bounds === undefined ? [] : [{ pid, windowId, bounds }];
  });
}

function safeReceipt(result: { status: string; driverCode?: string; message?: string }): SafeReceipt {
  return {
    status: result.status,
    driverCode: result.driverCode ?? null,
    messageLength: result.message?.length ?? 0,
  };
}

async function runProcess(file: string, args: readonly string[], timeoutMs = 20_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = execFile(file, [...args], { windowsHide: true, encoding: "utf8", timeout: timeoutMs }, (error, stdout, stderr) => {
      resolveResult({
        code: error === null ? 0 : typeof error.code === "number" ? error.code : null,
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
    child.once("error", reject);
  });
}

async function waitDaemon(binary: string, socket: string, daemon: Daemon): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (daemon.exitCode !== null || daemon.signalCode !== null) throw new Error("private CUA daemon exited before readiness");
    const status = await runProcess(binary, ["status", "--socket", socket]);
    if (status.code === 0 && /daemon is running/iu.test(status.stdout)) return;
    await delay(250);
  }
  throw new Error("private CUA daemon readiness timeout");
}

async function call(driver: CuaDriverLike, name: string, input: Record<string, unknown>): Promise<ToolResult> {
  return driver.callTool(name, JSON.stringify(input), { signal: new AbortController().signal });
}

async function waitWindow(driver: CuaDriverLike, pid: number): Promise<WindowInfo> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const windows = windowsFrom(await call(driver, "list_windows", { pid, on_screen_only: true, session: SETUP_SESSION }));
    const target = windows.find((window) => window.pid === pid && window.bounds.width > 0 && window.bounds.height > 0);
    if (target !== undefined) return target;
    await delay(100);
  }
  throw new Error("owned browser window was not discoverable");
}

async function readScreenSize(driver: CuaDriverLike): Promise<Frame> {
  const result = await call(driver, "get_screen_size", { session: SETUP_SESSION });
  const value = structured(result);
  const width = numberField(value, "width");
  const height = numberField(value, "height");
  if (width === undefined || height === undefined || width <= 0 || height <= 0) throw new Error("screen size was not returned");
  return { x: 0, y: 0, width, height };
}

async function startFixtureServer(state: OracleState, fixtureHtml: string): Promise<{ server: Server; url: string }> {
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method === "GET" && (path === "/" || path === "/browser-adapter-fixture.html")) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(fixtureHtml);
      return;
    }
    if (request.method === "POST" && path === "/oracle") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const record = parseOracle(Buffer.concat(chunks).toString("utf8"));
      if (record !== undefined) {
        state.reports += 1;
        state.latest = record;
      }
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return;
    }
    response.writeHead(404);
    response.end();
  };
  const server = createServer((request, response) => { void handle(request, response); });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture server did not expose a TCP port");
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

function parseOracle(raw: string): OracleRecord | undefined {
  try {
    const value = JSON.parse(raw) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const event = typeof record.event === "string" ? record.event : undefined;
    const serial = typeof record.serial === "number" ? record.serial : undefined;
    const text = typeof record.value === "string" ? record.value : undefined;
    const selectionStart = typeof record.selectionStart === "number" ? record.selectionStart : undefined;
    const selectionEnd = typeof record.selectionEnd === "number" ? record.selectionEnd : undefined;
    const scrollY = typeof record.scrollY === "number" ? record.scrollY : undefined;
    const activeId = typeof record.activeId === "string" ? record.activeId : undefined;
    if (event === undefined || serial === undefined || text === undefined || selectionStart === undefined || selectionEnd === undefined || scrollY === undefined || activeId === undefined) return undefined;
    return {
      event,
      serial,
      inputLength: text.length,
      matchesProbe: text === PROBE_TEXT,
      matchesReplacement: text === REPLACEMENT_TEXT,
      selectionLength: Math.max(0, selectionEnd - selectionStart),
      scrollY: Math.max(0, Math.round(scrollY)),
      activeInput: activeId === "probe-input",
    };
  } catch {
    return undefined;
  }
}

async function waitOracle(state: OracleState, predicate: (record: OracleRecord) => boolean, timeoutMs = 8_000): Promise<OracleRecord | undefined> {
  const deadline = Date.now() + timeoutMs;
  let latest = state.latest;
  while (Date.now() < deadline) {
    latest = state.latest;
    if (latest !== undefined && predicate(latest)) return latest;
    await delay(100);
  }
  return latest;
}

async function killOwnedProcess(pid: number | undefined): Promise<void> {
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    await runProcess("taskkill.exe", ["/PID", String(pid), "/T", "/F"], 10_000).catch(() => undefined);
    return;
  }
  try { process.kill(pid); } catch { /* already exited */ }
}

async function stopDaemon(binary: string, socket: string, daemon: Daemon): Promise<void> {
  await runProcess(binary, ["stop", "--socket", socket], 10_000).catch(() => undefined);
  const deadline = Date.now() + 5_000;
  while (daemon.exitCode === null && daemon.signalCode === null && Date.now() < deadline) await delay(100);
  if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill();
}

async function cleanupSetupDriver(driver: CuaDriverLike, started: boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  if (started) {
    let ended = false;
    for (let attempt = 0; attempt < 3 && Date.now() < deadline; attempt += 1) {
      try {
        const remaining = Math.max(1, deadline - Date.now());
        const result = await Promise.race([
          driver.endSession(EndSessionInput.new({ session: SETUP_SESSION }), { signal: new AbortController().signal }),
          new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("setup cleanup timeout")), remaining)),
        ]);
        if (!result.active) {
          ended = true;
          break;
        }
      } catch {
        // A cleanup-pending response is retried within this bounded window.
      }
      await delay(75);
    }
    if (!ended) throw new Error("setup CUA session cleanup was not confirmed");
  }
  const remaining = Math.max(1, deadline - Date.now());
  await Promise.race([
    driver.shutdown({ signal: new AbortController().signal }),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("setup shutdown timeout")), remaining)),
  ]);
  (driver as unknown as { uniffiDestroy?: () => void }).uniffiDestroy?.();
}

type GuiAction = Exclude<ActionIntent, { kind: "wait" }>;
type ActionPayload =
  | Omit<Extract<GuiAction, { kind: "click" }>, "actionId" | "basedOn">
  | Omit<Extract<GuiAction, { kind: "type" }>, "actionId" | "basedOn">
  | Omit<Extract<GuiAction, { kind: "keypress" }>, "actionId" | "basedOn">
  | Omit<Extract<GuiAction, { kind: "scroll" }>, "actionId" | "basedOn">;

function action(actionId: string, basedOn: ObservationId, value: ActionPayload): GuiAction {
  return { actionId: actionId as ActionId, basedOn, ...value } as GuiAction;
}

function safeError(error: unknown): { name: string; message: string } {
  const name = error instanceof Error ? error.name : "UnknownError";
  const message = error instanceof Error ? error.message : String(error);
  return { name: name.slice(0, 80), message: message.slice(0, 240) };
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, durationMs));
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  await mkdir(options.output, { recursive: true });
  const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "browser-adapter-fixture.html");
  const fixtureHtml = await readFile(fixturePath, "utf8");
  const state: OracleState = { reports: 0 };
  const summary: Summary = {
    probeVersion: "browser-adapter-probe-0.1.0",
    ok: false,
    allowInput: options.allowInput,
    browserPath: options.browser,
    socketConfigured: true,
    modelRequests: 0,
    userWindowTouched: false,
  };
  const profileDir = await mkdtemp(join(tmpdir(), "cua-browser-profile-"));
  if (process.platform === "win32" && !/^[\x00-\x7f]*$/u.test(profileDir)) {
    await rm(profileDir, { recursive: true, force: true });
    throw new Error("the OS temporary directory is not ASCII-only; refusing external browser launch");
  }
  const fixtureServer = await startFixtureServer(state, fixtureHtml);
  const daemon = spawn(options.binary, ["serve", "--socket", options.socket, "--no-overlay"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }) as Daemon;
  let setupDriver: CuaDriverLike | undefined;
  let setupStarted = false;
  let adapter: CuaDriverComputer | undefined;
  let adapterSession: ComputerSessionDescriptor | undefined;
  let browserPid: number | undefined;
  let daemonStopRequested = false;
  try {
    await waitDaemon(options.binary, options.socket, daemon);
    setupDriver = CuaDriver.connect(options.socket);
    await setupDriver.startSession(StartSessionInput.new({ session: SETUP_SESSION }), { signal: new AbortController().signal });
    setupStarted = true;
    const launch = await call(setupDriver, "launch_app", {
      path: options.browser,
      additional_arguments: [
        "--new-window",
        "--app=" + fixtureServer.url,
        "--user-data-dir=" + profileDir,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-features=Translate",
      ],
      start_minimized: false,
      session: SETUP_SESSION,
    });
    browserPid = numberField(structured(launch), "pid");
    if (launch.isError || browserPid === undefined) throw new Error("owned browser launch was refused");
    const screen = await readScreenSize(setupDriver);
    const targetRequest: Frame = {
      x: Math.floor(screen.width / 2),
      y: 0,
      width: screen.width - Math.floor(screen.width / 2),
      height: screen.height,
    };
    let target = await waitWindow(setupDriver, browserPid);
    const frameResult = await setupDriver.setWindowFrame(SetWindowFrameInput.new({
      pid: target.pid,
      windowId: BigInt(target.windowId),
      ...targetRequest,
      session: SETUP_SESSION,
    }), { signal: new AbortController().signal });
    if (frameResult.isError || frameResult.degraded) throw new Error("owned browser frame request was refused");
    target = await waitWindow(setupDriver, browserPid);
    const targetRightHalf = target.bounds.x >= targetRequest.x - 12 && target.bounds.width >= Math.floor(screen.width * 0.35);
    summary.layout = {
      screen,
      requestedTarget: targetRequest,
      actualTarget: target.bounds,
      targetRightHalf,
      targetWindowId: target.windowId,
      targetPidOwned: target.pid === browserPid,
    };
    if (!targetRightHalf) throw new Error("owned browser did not land in the right-half layout");
    const loaded = await waitOracle(state, (record) => record.event === "load" || record.event === "ready", 12_000);
    if (loaded === undefined) throw new Error("loopback browser fixture did not report readiness");
    const foreground = await call(setupDriver, "bring_to_front", { pid: target.pid, window_id: target.windowId, session: SETUP_SESSION });
    if (foreground.isError || structured(foreground)?.landed_on_target !== true) throw new Error("owned browser could not be brought to the foreground");
    await delay(250);
    adapter = new CuaDriverComputer({
      socketPath: options.socket,
      screenshotDir: join(options.output, "adapter-observations"),
      sessionLabel: ADAPTER_SESSION,
      windowTarget: { pid: target.pid, windowId: target.windowId },
      windowDeliveryMode: "foreground",
      cleanupWaitMs: 3_000,
    });
    adapterSession = await adapter.open({}, new AbortController().signal);
    const observationId = "browser-observation-0" as ObservationId;
    const before = await adapter.observe(adapterSession, observationId, new AbortController().signal);
    summary.observation = {
      viewport: before.viewport,
      bytes: before.screenshot.data.byteLength,
      windowLocal: before.viewport.width < screen.width && before.viewport.height <= screen.height,
    };
    if (!summary.observation.windowLocal) throw new Error("window-target observation was not window-local");
    const point = {
      x: Math.floor(before.viewport.width / 2),
      y: Math.max(260, Math.min(340, Math.floor(before.viewport.height * 0.2))),
    };
    const click = await adapter.execute(adapterSession, action("browser-click", observationId, { kind: "click", point }), new AbortController().signal);
    const clickOracle = await waitOracle(state, (record) => record.activeInput, 5_000);
    if (click.status !== "completed" || clickOracle?.activeInput !== true) throw new Error("browser click oracle did not confirm the input focus");
    const afterClickId = "browser-observation-after-click" as ObservationId;
    await adapter.observe(adapterSession, afterClickId, new AbortController().signal);
    const type = await adapter.execute(adapterSession, action("browser-type", afterClickId, { kind: "type", text: PROBE_TEXT }), new AbortController().signal);
    const typedOracle = await waitOracle(state, (record) => record.matchesProbe && record.activeInput, 5_000);
    if (type.status !== "completed" || typedOracle?.matchesProbe !== true) throw new Error("browser type oracle did not confirm the synthetic value");
    const afterTypeId = "browser-observation-after-type" as ObservationId;
    await adapter.observe(adapterSession, afterTypeId, new AbortController().signal);
    const ctrlA = await adapter.execute(adapterSession, action("browser-ctrl-a", afterTypeId, { kind: "keypress", keys: ["CTRL", "A"] }), new AbortController().signal);
    const selectedOracle = await waitOracle(state, (record) => record.matchesProbe && record.selectionLength >= PROBE_TEXT.length, 5_000);
    if (ctrlA.status !== "completed" || selectedOracle === undefined || selectedOracle.selectionLength < PROBE_TEXT.length) throw new Error("browser Ctrl+A oracle did not confirm selection");
    const afterCtrlAId = "browser-observation-after-ctrl-a" as ObservationId;
    await adapter.observe(adapterSession, afterCtrlAId, new AbortController().signal);
    const replacement = await adapter.execute(adapterSession, action("browser-replace", afterCtrlAId, { kind: "type", text: REPLACEMENT_TEXT }), new AbortController().signal);
    const replacedOracle = await waitOracle(state, (record) => record.matchesReplacement && record.selectionLength === 0, 5_000);
    if (replacement.status !== "completed" || replacedOracle?.matchesReplacement !== true) throw new Error("browser replacement oracle did not confirm the value");
    const afterReplaceId = "browser-observation-after-replace" as ObservationId;
    await adapter.observe(adapterSession, afterReplaceId, new AbortController().signal);
    const scroll = await adapter.execute(adapterSession, action("browser-scroll", afterReplaceId, { kind: "scroll", point, direction: "down", ticks: 8 }), new AbortController().signal);
    const scrolledOracle = await waitOracle(state, (record) => record.scrollY > 0, 5_000);
    summary.actions = {
      click: safeReceipt(click),
      type: safeReceipt(type),
      ctrlA: safeReceipt(ctrlA),
      replacement: safeReceipt(replacement),
      scroll: safeReceipt(scroll),
    };
    summary.oracle = {
      reports: state.reports,
      clickFocused: clickOracle?.activeInput === true,
      typedProbe: typedOracle?.matchesProbe === true,
      ctrlASelected: selectedOracle !== undefined && selectedOracle.selectionLength >= PROBE_TEXT.length,
      replacedValue: replacedOracle?.matchesReplacement === true && replacedOracle.selectionLength === 0,
      scrolled: scrolledOracle !== undefined && scrolledOracle.scrollY > 0,
      finalScrollY: scrolledOracle?.scrollY ?? state.latest?.scrollY ?? 0,
    };
    summary.ok = click.status === "completed"
      && type.status === "completed"
      && ctrlA.status === "completed"
      && replacement.status === "completed"
      && scroll.status === "completed"
      && summary.oracle.clickFocused
      && summary.oracle.typedProbe
      && summary.oracle.ctrlASelected
      && summary.oracle.replacedValue
      && summary.oracle.scrolled;
    if (!summary.ok) throw new Error("browser adapter action oracle did not confirm every effect");
  } catch (error) {
    summary.failure = safeError(error);
  } finally {
    if (adapter !== undefined && adapterSession !== undefined) await adapter.close(adapterSession).catch(() => undefined);
    await killOwnedProcess(browserPid);
    if (setupDriver !== undefined) {
      await cleanupSetupDriver(setupDriver, setupStarted).catch(() => undefined);
    }
    if (daemon.exitCode === null && daemon.signalCode === null) {
      daemonStopRequested = true;
      await stopDaemon(options.binary, options.socket, daemon);
    }
    await new Promise<void>((resolveClose) => fixtureServer.server.close(() => resolveClose()));
    let profileDirectoryRemoved = false;
    try {
      await rm(profileDir, { recursive: true, force: true });
      profileDirectoryRemoved = true;
    } catch {
      profileDirectoryRemoved = false;
    }
    summary.cleanup = {
      ...(browserPid === undefined ? {} : { browserPid }),
      profileDirectoryRemoved,
      daemonStopRequested,
    };
    await writeFile(join(options.output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify({ ok: summary.ok, output: "<ignored-output>" })}\n`);
  if (!summary.ok) process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
