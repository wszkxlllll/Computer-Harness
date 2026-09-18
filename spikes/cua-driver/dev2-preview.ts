import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CuaDriver, EndSessionInput, StartSessionInput, type CuaDriverLike, type ToolResult } from "@trycua/cua-driver";
import { CuaDriverComputer } from "@computer-harness/computer-cua";
import type { ActionId, ComputerSessionDescriptor, ObservationId, Viewport } from "@computer-harness/protocol";

interface Options {
  binary: string;
  fixture: string;
  output: string;
  session: string;
  socket: string;
  allowInput: boolean;
}

interface WindowInfo {
  pid: number;
  windowId: number;
  bounds: { x: number; y: number; width: number; height: number };
}

interface FixtureState {
  focused: boolean | undefined;
  textLength: number | undefined;
  eventSequence: number | undefined;
  event: string | undefined;
  text: string | undefined;
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
    session: option(args, "--session") ?? "dev2-preview",
    socket: normalizePipe(required(args, "--socket")),
    allowInput: args.includes("--allow-input"),
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
  if (windowId === undefined || x === undefined || y === undefined || width === undefined || height === undefined || width <= 0 || height <= 0) return undefined;
  return { pid: expectedPid, windowId, bounds: { x, y, width, height } };
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
  const focused = fields.get("focused");
  return {
    focused: focused === "True" ? true : focused === "False" ? false : undefined,
    textLength: integer("textLength"),
    eventSequence: integer("eventSequence"),
    event: fields.get("event"),
    text: fields.get("text"),
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
    await new Promise((done) => setTimeout(done, 100));
    latest = await fixtureState(path);
  }
  return latest;
}

async function waitForWindow(raw: CuaDriverLike, session: string, pid: number, signal: AbortSignal): Promise<WindowInfo> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await callTool(raw, "list_windows", { pid, on_screen_only: true, session }, signal);
    const window = readWindow(result, pid);
    if (window !== undefined) return window;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("fixture window was not found by exact launched pid");
}

async function ensureForeground(raw: CuaDriverLike, statePath: string, target: WindowInfo, session: string, signal: AbortSignal): Promise<WindowInfo> {
  const current = await waitForWindow(raw, session, target.pid, signal);
  if (current.windowId !== target.windowId) throw new Error("fixture window_id changed during focus check");
  const result = await callTool(raw, "bring_to_front", { pid: target.pid, window_id: target.windowId, session }, signal);
  if (structured(result)?.landed_on_target !== true) throw new Error("fixture did not report landed_on_target");
  const state = await waitForState(statePath, (value) => value.focused === true, 3000);
  if (state.focused !== true) throw new Error("fixture editor did not confirm focused=true");
  return current;
}

function centerPoint(target: WindowInfo): { x: number; y: number } {
  return {
    x: Math.round(target.bounds.x + target.bounds.width / 2),
    y: Math.round(target.bounds.y + Math.max(45, target.bounds.height / 2)),
  };
}

function viewportMatchesCapture(viewport: Viewport, observation: { viewport: Viewport; screenshot: { data: Uint8Array } }): boolean {
  return observation.viewport.width === viewport.width
    && observation.viewport.height === viewport.height
    && observation.viewport.coordinateSpace === "physical"
    && observation.screenshot.data.byteLength > 24;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (!options.allowInput) throw new Error("--allow-input is required for the fixture action gate");
  await mkdir(options.output, { recursive: true });
  const statePath = join(options.output, "fixture-state.txt");
  const screenshotDir = join(options.output, "screenshots");
  const signal = new AbortController().signal;
  const raw = CuaDriver.connect(options.socket);
  let setupStarted = false;
  let fixturePid: number | undefined;
  let adapter: CuaDriverComputer | undefined;
  let adapterSession: ComputerSessionDescriptor | undefined;
  let summary: Record<string, unknown> = { ok: false, probeVersion: "dev2-preview-0.1.0", inputAuthorized: true };
  try {
    await raw.startSession(StartSessionInput.new({ session: `${options.session}-setup` }), { signal });
    setupStarted = true;
    const launched = await callTool(raw, "launch_app", { path: options.fixture, additional_arguments: [statePath], start_minimized: false, session: `${options.session}-setup` }, signal);
    fixturePid = numberField(structured(launched), "pid");
    if (fixturePid === undefined) throw new Error("launch_app did not return a fixture pid");
    const target = await waitForWindow(raw, `${options.session}-setup`, fixturePid, signal);
    const initialState = await waitForState(statePath, (state) => state.textLength !== undefined, 5000);
    if (initialState.textLength === undefined) throw new Error("fixture did not write initial state");

    adapter = new CuaDriverComputer({ socketPath: options.socket, screenshotDir, sessionLabel: options.session, cleanupWaitMs: 3000 });
    adapterSession = await adapter.open({}, signal);
    const beforeObservationId = "dev2-before" as ObservationId;
    const before = await adapter.observe(adapterSession, beforeObservationId, signal);
    const captureMatchesViewport = viewportMatchesCapture(adapterSession.viewport, before);
    const initialTarget = await ensureForeground(raw, statePath, target, `${options.session}-setup`, signal);
    const point = centerPoint(initialTarget);
    const click = await adapter.execute(adapterSession, { actionId: "dev2-click" as ActionId, basedOn: beforeObservationId, kind: "click", point }, signal);
    const afterClickTarget = await ensureForeground(raw, statePath, target, `${options.session}-setup`, signal);
    const afterClickObservationId = "dev2-after-click" as ObservationId;
    const afterClick = await adapter.observe(adapterSession, afterClickObservationId, signal);
    const typeText = "LightSpeaker harness test";
    const type = await adapter.execute(adapterSession, { actionId: "dev2-type" as ActionId, basedOn: afterClickObservationId, kind: "type", text: typeText }, signal);
    const afterTypeObservationId = "dev2-after-type" as ObservationId;
    const afterType = await adapter.observe(adapterSession, afterTypeObservationId, signal);
    const finalState = await waitForState(statePath, (state) => state.text?.includes(typeText) === true, 5000);
    const typedByFixture = finalState.text?.includes(typeText) === true;
    summary = {
      ok: click.status === "completed" && type.status === "completed" && typedByFixture && captureMatchesViewport,
      probeVersion: "dev2-preview-0.1.0",
      inputAuthorized: true,
      daemonVersion: "0.22.2",
      session: { setupStarted, adapterOpened: true, backend: adapterSession.backend, viewport: adapterSession.viewport, capabilities: adapterSession.capabilities },
      fixture: { ownedPid: fixturePid, windowId: target.windowId, initialTextLength: initialState.textLength, finalTextLength: finalState.textLength ?? null, typedTextLength: typeText.length, typedByFixture, focusConfirmed: afterClickTarget.windowId === target.windowId },
      capture: { beforeBytes: before.screenshot.data.byteLength, afterClickBytes: afterClick.screenshot.data.byteLength, afterTypeBytes: afterType.screenshot.data.byteLength, matchesOpenedPhysicalViewport: captureMatchesViewport },
      actions: { clickStatus: click.status, clickMessagePresent: typeof click.message === "string", typeStatus: type.status, typeMessagePresent: typeof type.message === "string", point },
      boundaries: { noModelApi: true, noPrivateAppTarget: true, noVm: true, driverReceiptNotBusinessProof: true },
    };
    if (!typedByFixture) throw new Error("fixture state did not contain the fixed test string");
    if (!captureMatchesViewport) throw new Error("desktop capture did not match opened physical viewport");
  } finally {
    if (adapter !== undefined && adapterSession !== undefined) {
      try { await adapter.close(adapterSession); } catch { /* summary records failure via the outer error */ }
    }
    if (setupStarted) {
      try { await raw.endSession(EndSessionInput.new({ session: `${options.session}-setup` }), { signal }); } catch { /* daemon cleanup below remains authoritative */ }
    }
    try { await raw.shutdown({ signal }); } catch { /* preserve primary result */ }
    (raw as unknown as { uniffiDestroy?: () => void }).uniffiDestroy?.();
    if (fixturePid !== undefined) {
      try { process.kill(fixturePid); } catch { /* the fixture may already have exited */ }
    }
    await writeFile(join(options.output, "probe-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify(summary, null, 2));
  if (summary.ok !== true) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.name : "dev2_preview_error");
  process.exitCode = 1;
});
