import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { CuaDriver, EndSessionInput, StartSessionInput, type CuaDriverLike, type ToolResult } from "@trycua/cua-driver";
import { CuaDriverComputer } from "@computer-harness/computer-cua";
import type { ComputerSessionDescriptor, ObservationId, Viewport } from "@computer-harness/protocol";

interface Options {
  repo: string;
 binary: string;
  fixture: string;
  python: string;
  ptyScript: string;
  node: string;
  envFile: string;
  socket: string;
  output: string;
  goFile: string;
  abortFile: string;
  session: string;
}

interface FixtureState {
  event: string | undefined;
  eventSequence: number | undefined;
  dpiAwarenessSet: boolean;
  dpi: number | undefined;
  primaryWidth: number | undefined;
  primaryHeight: number | undefined;
  windowX: number | undefined;
  windowY: number | undefined;
  windowWidth: number | undefined;
  windowHeight: number | undefined;
  clientWidth: number | undefined;
  clientHeight: number | undefined;
  topMost: boolean;
  borderless: boolean;
  showInTaskbar: boolean;
  formActive: boolean;
  inputFocused: boolean;
  buttonClicked: boolean;
  textLength: number | undefined;
  containsExpected: boolean;
}

interface WindowInfo {
  pid: number;
  windowId: number;
  bounds: { x: number; y: number; width: number; height: number };
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function required(args: readonly string[], name: string): string {
  const value = option(args, name);
  if (value === undefined || value.length === 0) throw new Error(name + " is required");
  return value;
}

function parseOptions(args: readonly string[]): Options {
  return {
    repo: resolve(required(args, "--repo")),
    binary: resolve(required(args, "--binary")),
    fixture: resolve(required(args, "--fixture")),
    python: required(args, "--python"),
    ptyScript: resolve(required(args, "--pty-script")),
    node: required(args, "--node"),
    envFile: required(args, "--env-file"),
    socket: required(args, "--socket"),
    output: resolve(required(args, "--output")),
    goFile: resolve(required(args, "--go-file")),
    abortFile: resolve(required(args, "--abort-file")),
    session: option(args, "--session") ?? "dev2-glm-" + Date.now(),
  };
}

function structured(result: ToolResult): Record<string, unknown> | undefined {
  if (typeof result.structuredJson !== "string") return undefined;
  try {
    const parsed = JSON.parse(result.structuredJson) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function numberField(value: unknown, key: string): number | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function boolField(value: string | undefined): boolean {
  return value === "True";
}

function readStateText(value: string): FixtureState {
  const fields = new Map<string, string>();
  for (const line of value.split(/\r?\n/u)) {
    const separator = line.indexOf("=");
    if (separator > 0) fields.set(line.slice(0, separator), line.slice(separator + 1));
  }
  const integer = (key: string): number | undefined => {
    const parsed = Number(fields.get(key));
    return Number.isInteger(parsed) ? parsed : undefined;
  };
  return {
    event: fields.get("event"),
    eventSequence: integer("eventSequence"),
    dpiAwarenessSet: boolField(fields.get("dpiAwarenessSet")),
    dpi: integer("dpi"),
    primaryWidth: integer("primaryWidth"),
    primaryHeight: integer("primaryHeight"),
    windowX: integer("windowX"),
    windowY: integer("windowY"),
    windowWidth: integer("windowWidth"),
    windowHeight: integer("windowHeight"),
    clientWidth: integer("clientWidth"),
    clientHeight: integer("clientHeight"),
    topMost: boolField(fields.get("topMost")),
    borderless: boolField(fields.get("borderless")),
    showInTaskbar: boolField(fields.get("showInTaskbar")),
    formActive: boolField(fields.get("formActive")),
    inputFocused: boolField(fields.get("inputFocused")),
    buttonClicked: boolField(fields.get("buttonClicked")),
    textLength: integer("textLength"),
    containsExpected: boolField(fields.get("containsExpected")),
  };
}

async function fixtureState(path: string): Promise<FixtureState> {
  return readStateText(await readFile(path, "utf8").catch(() => ""));
}

async function waitForState(path: string, predicate: (state: FixtureState) => boolean, timeoutMs = 5000): Promise<FixtureState> {
  const deadline = Date.now() + timeoutMs;
  let latest = await fixtureState(path);
  while (Date.now() < deadline) {
    if (predicate(latest)) return latest;
    await delay(100);
    latest = await fixtureState(path);
  }
  return latest;
}

function callTool(driver: CuaDriverLike, name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
  return driver.callTool(name, JSON.stringify(input), { signal });
}

function readWindow(result: ToolResult, expectedPid: number): WindowInfo | undefined {
  const root = structured(result);
  const windows = root?.windows;
  if (!Array.isArray(windows)) return undefined;
  const candidate = windows.find((item) => numberField(item, "pid") === expectedPid) as Record<string, unknown> | undefined;
  if (candidate === undefined) return undefined;
  const bounds = candidate.bounds;
  const x = numberField(bounds, "x");
  const y = numberField(bounds, "y");
  const width = numberField(bounds, "width");
  const height = numberField(bounds, "height");
  const windowId = numberField(candidate, "window_id");
  if (windowId === undefined || x === undefined || y === undefined || width === undefined || height === undefined) return undefined;
  return { pid: expectedPid, windowId, bounds: { x, y, width, height } };
}

async function waitForWindow(raw: CuaDriverLike, session: string, pid: number, signal: AbortSignal): Promise<WindowInfo> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await callTool(raw, "list_windows", { pid, on_screen_only: true, session }, signal);
    const window = readWindow(result, pid);
    if (window !== undefined) return window;
    await delay(100);
  }
  throw new Error("fixture window was not found by exact launched pid");
}

async function verifyWindow(raw: CuaDriverLike, session: string, target: WindowInfo, viewport: Viewport, signal: AbortSignal): Promise<boolean> {
  const current = await waitForWindow(raw, session, target.pid, signal);
  return current.windowId === target.windowId
    && current.bounds.x === 0
    && current.bounds.y === 0
    && current.bounds.width === viewport.width
    && current.bounds.height === viewport.height;
}

async function ensureForeground(raw: CuaDriverLike, statePath: string, target: WindowInfo, session: string, signal: AbortSignal): Promise<void> {
  const current = await waitForWindow(raw, session, target.pid, signal);
  if (current.windowId !== target.windowId) throw new Error("fixture window_id changed during focus check");
  const result = await callTool(raw, "bring_to_front", { pid: target.pid, window_id: target.windowId, session }, signal);
  if (structured(result)?.landed_on_target !== true) throw new Error("fixture did not report landed_on_target");
  const state = await waitForState(statePath, (value) => value.formActive, 3000);
  if (!state.formActive) throw new Error("fixture did not confirm active foreground state");
}

function validateFixtureState(state: FixtureState, viewport: Viewport): boolean {
  return state.dpiAwarenessSet
    && (state.dpi ?? 0) >= 96
    && state.primaryWidth === viewport.width
    && state.primaryHeight === viewport.height
    && state.windowX === 0
    && state.windowY === 0
    && state.windowWidth === viewport.width
    && state.windowHeight === viewport.height
    && state.topMost
    && state.borderless
    && !state.showInTaskbar
    && state.formActive;
}

function validateCapture(session: ComputerSessionDescriptor, screenshot: { viewport: Viewport; screenshot: { data: Uint8Array } }): boolean {
  return session.viewport.coordinateSpace === "physical"
    && screenshot.viewport.coordinateSpace === "physical"
    && screenshot.viewport.width === session.viewport.width
    && screenshot.viewport.height === session.viewport.height
    && screenshot.screenshot.data.byteLength > 1024;
}

async function waitForDaemon(binary: string, socket: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await execFileAsync(binary, ["status", "--socket", socket]);
      return;
    } catch {
      await delay(200);
    }
  }
  throw new Error("daemon did not become ready");
}

function execFileAsync(file: string, args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile(file, [...args], { windowsHide: true, timeout: 5000 }, (error) => {
      if (error === null) resolvePromise();
      else reject(error);
    });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function fileExists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

async function walkFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(root, path));
    else files.push(relative(root, path));
  }
  return files;
}

async function safeArtifactSummary(output: string): Promise<Record<string, unknown>> {
  const files = await walkFiles(output).catch(() => []);
  const artifactFiles: Array<{ path: string; bytes: number }> = [];
  const eventTypes: Record<string, number> = {};
  const diagnosticFiles: string[] = [];
  for (const relativePath of files) {
    const absolute = join(output, relativePath);
    const info = await stat(absolute).catch(() => undefined);
    if (info === undefined) continue;
    const safePath = relativePath.replace(/\\/gu, "/");
    artifactFiles.push({ path: safePath, bytes: info.size });
    if (/(?:provider|diagnostic)/iu.test(relativePath)) diagnosticFiles.push(safePath);
    if (!/\.(?:json|jsonl|ndjson)$/iu.test(relativePath) || info.size > 4_000_000) continue;
    const text = await readFile(absolute, "utf8").catch(() => "");
    for (const line of text.split(/\r?\n/u)) {
      if (line.trim().length === 0) continue;
      try {
        const value = JSON.parse(line) as unknown;
        if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
        const type = (value as Record<string, unknown>).type;
        if (typeof type === "string") eventTypes[type] = (eventTypes[type] ?? 0) + 1;
      } catch {
      }
    }
  }
  return { fileCount: artifactFiles.length, artifactFiles, eventTypes, diagnosticFiles };
}

function parseMetricLines(value: string): Record<string, string> {
  const metrics: Record<string, string> = {};
  for (const line of value.split(/\r?\n/u)) {
    const separator = line.indexOf("=");
    if (separator > 0) metrics[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return metrics;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  await mkdir(options.output, { recursive: true });
  const signal = new AbortController().signal;
  const setupSession = options.session + "-setup";
  const daemon = spawn(options.binary, ["serve", "--socket", options.socket, "--no-overlay"], {
    windowsHide: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  let raw: CuaDriverLike | undefined;
  let setupStarted = false;
  let adapter: CuaDriverComputer | undefined;
  let adapterSession: ComputerSessionDescriptor | undefined;
  let fixturePid: number | undefined;
  let target: WindowInfo | undefined;
  let child: ChildProcess | undefined;
  let unsafe = false;
  let unsafeReason: string | undefined;
  let monitorError: string | undefined;
  let stage = "init";
  let childOutput = "";
  let summary: Record<string, unknown> = { ok: false };
  try {
    stage = "wait_daemon";
    await waitForDaemon(options.binary, options.socket);
    raw = CuaDriver.connect(options.socket);
    stage = "start_setup_session";
    await raw.startSession(StartSessionInput.new({ session: setupSession }), { signal });
    setupStarted = true;
    const statePath = join(options.output, "fixture-state.txt");
    stage = "launch_fixture";
    const launched = await callTool(raw, "launch_app", {
      path: options.fixture,
      additional_arguments: [statePath],
      start_minimized: false,
      session: setupSession,
    }, signal);
    fixturePid = numberField(structured(launched), "pid");
    if (fixturePid === undefined) throw new Error("fixture launch did not return a pid");
    stage = "find_fixture_window";
    const launchedTarget = await waitForWindow(raw, setupSession, fixturePid, signal);
    target = launchedTarget;
    stage = "read_fixture_state";
    const initialState = await waitForState(statePath, (state) => state.eventSequence !== undefined, 5000);
    if (initialState.eventSequence === undefined) throw new Error("fixture state did not initialize");

    adapter = new CuaDriverComputer({
      socketPath: options.socket,
      screenshotDir: join(options.output, "screenshots"),
      sessionLabel: options.session,
      cleanupWaitMs: 5000,
    });
    stage = "open_adapter_session";
    const openedAdapterSession = await adapter.open({}, signal);
    adapterSession = openedAdapterSession;
    stage = "validate_fixture_state";
    if (!validateFixtureState(initialState, openedAdapterSession.viewport)) throw new Error("fixture is not a full-screen PMv2 topmost window");
    stage = "validate_window_bounds";
    if (!(await verifyWindow(raw, setupSession, launchedTarget, openedAdapterSession.viewport, signal))) {
      throw new Error("fixture target bounds do not match the physical viewport");
    }
    stage = "bring_fixture_foreground";
    await ensureForeground(raw, statePath, launchedTarget, setupSession, signal);
    stage = "capture_preflight";
    const before = await adapter.observe(openedAdapterSession, "dev2-glm-preflight" as ObservationId, signal);
    if (!validateCapture(openedAdapterSession, before)) throw new Error("preflight screenshot does not match the physical viewport");
    await writeFile(join(options.output, "preflight.png"), before.screenshot.data);
    const preflight = {
      ready: true,
      daemonVersion: "0.22.2",
      backend: openedAdapterSession.backend,
      viewport: openedAdapterSession.viewport,
      capabilities: openedAdapterSession.capabilities,
      fixture: { pidOwned: true, windowIdPresent: true, fullScreenBounds: true, dpiAwarenessSet: initialState.dpiAwarenessSet, topMost: initialState.topMost, borderless: initialState.borderless, formActive: initialState.formActive },
      capture: { bytes: before.screenshot.data.byteLength, physicalViewportMatch: true, localOnly: true },
      boundaries: { noModelApiBeforeGate: true, noPrivateAppTarget: true, noDesktopInputBeforeGate: true },
    };
    await writeFile(join(options.output, "preflight-safe.json"), JSON.stringify(preflight, null, 2) + "\n", "utf8");
    console.log("preflight_ready=true");
    console.log("waiting_for_local_visual_gate=true");
    const gateDeadline = Date.now() + 300_000;
    while (Date.now() < gateDeadline && !(await fileExists(options.goFile))) await delay(250);
    if (!(await fileExists(options.goFile))) throw new Error("local visual gate timed out");

    child = spawn(options.python, [
      options.ptyScript,
      options.repo,
      options.node,
      options.socket,
      options.output,
      options.envFile,
      options.abortFile,
    ], { cwd: options.repo, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", (chunk: Buffer) => { childOutput += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { childOutput += chunk.toString("utf8"); });
    const childExit = new Promise<number>((resolvePromise) => child?.once("close", (code) => resolvePromise(code ?? -1)));
    const activeTarget = launchedTarget;
    const activeAdapterSession = openedAdapterSession;
    let previousSequence = initialState.eventSequence ?? -1;
    let childCode: number | undefined;
    const runDeadline = Date.now() + 300_000;
    while (Date.now() < runDeadline && childCode === undefined) {
      childCode = await Promise.race([childExit, delay(250).then(() => undefined)]);
      const current = await fixtureState(statePath);
      if (current.eventSequence !== undefined && current.eventSequence !== previousSequence) {
        previousSequence = current.eventSequence;
        if (!current.formActive) {
          unsafe = true;
          unsafeReason = "fixture lost active foreground state during a state-changing action";
        }
        if (!(await verifyWindow(raw, setupSession, activeTarget, activeAdapterSession.viewport, signal))) {
          unsafe = true;
          unsafeReason = "fixture window identity or full-screen bounds changed during the run";
        }
      }
      if (unsafe && !(await fileExists(options.abortFile))) await writeFile(options.abortFile, "abort\n", "utf8");
      if (unsafe && childCode === undefined) childCode = await Promise.race([childExit, delay(500).then(() => undefined)]);
    }
    if (childCode === undefined) {
      unsafe = true;
      unsafeReason = "TUI child exceeded bounded run deadline";
      await writeFile(options.abortFile, "abort\n", "utf8");
      childCode = await Promise.race([childExit, delay(3000).then(() => undefined)]);
    }
    const finalState = await fixtureState(statePath);
    const ptyMetrics = parseMetricLines(childOutput);
    const artifacts = await safeArtifactSummary(options.output);
    summary = {
      ok: !unsafe && childCode === 0 && ptyMetrics.passed === "true" && finalState.buttonClicked && finalState.containsExpected,
      childExitCode: childCode,
      ptyMetrics: { passed: ptyMetrics.passed === "true", runMarker: ptyMetrics.run_marker === "true", runFinishedMarker: ptyMetrics.run_finished_marker === "true", approvalCount: Number(ptyMetrics.approval_count ?? "0"), cursorRestore: ptyMetrics.cursor_restore === "true", forcedTermination: ptyMetrics.forced_termination === "true" },
      fixture: { buttonClicked: finalState.buttonClicked, containsExpected: finalState.containsExpected, textLength: finalState.textLength ?? null, eventSequence: finalState.eventSequence ?? null, focusStillActive: finalState.formActive, fullScreen: validateFixtureState(finalState, activeAdapterSession.viewport) },
      safety: { unsafe, ...(unsafeReason === undefined ? {} : { unsafeReason }), monitorError, noPrivateAppTarget: true, noHarnessRetry: true },
      artifacts,
    };
    await writeFile(join(options.output, "run-safe-summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
  } catch (error) {
    monitorError = stage + ":" + (error instanceof Error ? error.name : "run_error");
    summary = { ok: false, safety: { unsafe: true, monitorError } };
    await writeFile(join(options.output, "run-safe-summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8").catch(() => undefined);
  } finally {
    if (child !== undefined && child.exitCode === null) {
      try { child.kill(); } catch { /* own child only */ }
    }
    if (adapter !== undefined && adapterSession !== undefined) await adapter.close(adapterSession).catch(() => undefined);
    if (raw !== undefined && setupStarted) {
      await raw.endSession(EndSessionInput.new({ session: setupSession }), { signal }).catch(() => undefined);
      await raw.shutdown({ signal }).catch(() => undefined);
      (raw as unknown as { uniffiDestroy?: () => void }).uniffiDestroy?.();
    }
    if (fixturePid !== undefined) {
      try { process.kill(fixturePid); } catch { /* own fixture only */ }
    }
    if (!daemon.killed && daemon.exitCode === null) {
      try { daemon.kill(); } catch { /* own daemon only */ }
    }
  }
  console.log(JSON.stringify(summary, null, 2));
  if (summary.ok !== true) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.name : "dev2_glm_tui_error");
  process.exitCode = 1;
});
