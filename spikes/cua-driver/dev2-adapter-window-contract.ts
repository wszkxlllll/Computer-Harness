import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { CuaDriver, EndSessionInput, SetWindowFrameInput, StartSessionInput, type CuaDriverLike, type ToolResult } from "@trycua/cua-driver";
import { CuaDriverComputer } from "@computer-harness/computer-cua";
import type { ActionId, ObservationId } from "@computer-harness/protocol";

type Daemon = ChildProcessByStdio<null, Readable, Readable>;
type Frame = { x: number; y: number; width: number; height: number };
type WindowInfo = { pid: number; windowId: number; bounds?: Frame };
type SafeState = { clickCount?: number; typedExpected?: boolean; dpi?: number; formActive?: boolean };
type Element = { role?: string; label?: string; frame?: Frame };

interface Options { binary: string; fixture: string; output: string; socket: string; }

function option(args: readonly string[], name: string): string | undefined { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; }
function required(args: readonly string[], name: string): string { const value = option(args, name); if (!value) throw new Error(`${name} is required`); return value; }
function normalizePipe(value: string): string { const m = value.match(/^\\+\.\\+pipe\\+(.*)$/iu); return process.platform === "win32" && m?.[1] !== undefined ? `\\\\.\\pipe\\${m[1].replace(/\\+/gu, "\\")}` : value; }
function parseOptions(args: readonly string[]): Options { return { binary: resolve(required(args, "--binary")), fixture: resolve(required(args, "--fixture")), output: resolve(required(args, "--output")), socket: normalizePipe(required(args, "--socket")) }; }
function numberField(value: unknown, key: string): number | undefined { const v = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined; return typeof v === "number" && Number.isFinite(v) ? v : undefined; }
function stringField(value: unknown, key: string): string | undefined { const v = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined; return typeof v === "string" ? v : undefined; }
function objectField(value: unknown, key: string): Record<string, unknown> | undefined { const v = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined; return v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined; }
function structured(result: ToolResult): Record<string, unknown> | undefined { if (typeof result.structuredJson !== "string") return undefined; try { const v = JSON.parse(result.structuredJson) as unknown; return v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined; } catch { return undefined; } }
function safeTool(result: ToolResult): Record<string, unknown> { return { isError: result.isError, errorCode: result.errorCode ?? null, degraded: result.degraded, textLength: result.text.length, structuredLength: result.structuredJson?.length ?? 0 }; }
function frameFrom(value: unknown): Frame | undefined { const x = numberField(value, "x"); const y = numberField(value, "y"); const width = numberField(value, "width"); const height = numberField(value, "height"); return x !== undefined && y !== undefined && width !== undefined && height !== undefined ? { x, y, width, height } : undefined; }
function windowsFrom(result: ToolResult): WindowInfo[] { const list = structured(result)?.windows; if (!Array.isArray(list)) return []; return list.flatMap((item) => { if (!item || typeof item !== "object" || Array.isArray(item)) return []; const pid = numberField(item, "pid"); const windowId = numberField(item, "window_id"); const bounds = frameFrom(objectField(item, "bounds")); return pid !== undefined && windowId !== undefined ? [{ pid, windowId, ...(bounds === undefined ? {} : { bounds }) }] : []; }); }
function parseState(raw: string): SafeState { const values = new Map(raw.split(/\r?\n/gu).flatMap((line) => { const i = line.indexOf("="); return i <= 0 ? [] : [[line.slice(0, i), line.slice(i + 1)] as const]; })); const int = (k: string) => { const v = values.get(k); return v !== undefined && /^\d+$/u.test(v) ? Number(v) : undefined; }; const bool = (k: string) => values.get(k) === "True" ? true : values.get(k) === "False" ? false : undefined; const state: SafeState = {}; const clickCount = int("clickCount"); const typedExpected = bool("typedExpected"); const dpi = int("dpi"); const formActive = bool("formActive"); if (clickCount !== undefined) state.clickCount = clickCount; if (typedExpected !== undefined) state.typedExpected = typedExpected; if (dpi !== undefined) state.dpi = dpi; if (formActive !== undefined) state.formActive = formActive; return state; }
async function readState(path: string): Promise<SafeState | undefined> { const raw = await readFile(path, "utf8").catch(() => undefined); return raw === undefined ? undefined : parseState(raw); }
async function waitState(path: string, predicate: (state: SafeState) => boolean, timeoutMs = 5000): Promise<SafeState | undefined> { const end = Date.now() + timeoutMs; let latest: SafeState | undefined; while (Date.now() < end) { latest = await readState(path); if (latest !== undefined && predicate(latest)) return latest; await new Promise((done) => setTimeout(done, 100)); } return latest; }
async function runProcess(file: string, args: string[]): Promise<{ code: number | null; stdout: string }> { return new Promise((resolveResult, reject) => { const child = execFile(file, args, { windowsHide: true, encoding: "utf8", timeout: 20000 }, (error, stdout) => resolveResult({ code: error === null ? 0 : typeof error.code === "number" ? error.code : null, stdout: String(stdout) })); child.once("error", reject); }); }
async function waitDaemon(binary: string, socket: string, daemon: Daemon): Promise<void> { const end = Date.now() + 20000; while (Date.now() < end) { if (daemon.exitCode !== null) throw new Error("daemon exited"); const status = await runProcess(binary, ["status", "--socket", socket]); if (status.code === 0 && /daemon is running/iu.test(status.stdout)) return; await new Promise((done) => setTimeout(done, 250)); } throw new Error("daemon readiness timeout"); }
async function call(driver: CuaDriverLike, name: string, input: Record<string, unknown>): Promise<ToolResult> { return driver.callTool(name, JSON.stringify(input), { signal: new AbortController().signal }); }
async function list(driver: CuaDriverLike, pid: number): Promise<{ result: ToolResult; windows: WindowInfo[] }> { const result = await call(driver, "list_windows", { pid, on_screen_only: true }); return { result, windows: windowsFrom(result) }; }
async function waitWindow(driver: CuaDriverLike, pid: number): Promise<WindowInfo | undefined> { const end = Date.now() + 8000; while (Date.now() < end) { const found = (await list(driver, pid)).windows.find((item) => item.pid === pid && item.bounds !== undefined); if (found) return found; await new Promise((done) => setTimeout(done, 100)); } return undefined; }
async function setFrame(driver: CuaDriverLike, target: WindowInfo, frame: Frame, session: string): Promise<ToolResult> { return driver.setWindowFrame(SetWindowFrameInput.new({ pid: target.pid, windowId: BigInt(target.windowId), ...frame, session }), { signal: new AbortController().signal }); }
function elementsFrom(result: ToolResult): Element[] { const elements = structured(result)?.elements; if (!Array.isArray(elements)) return []; return elements.flatMap((item) => { if (!item || typeof item !== "object" || Array.isArray(item)) return []; const frame = objectField(item, "frame"); const role = stringField(item, "role"); const label = stringField(item, "label") ?? stringField(item, "name"); const x = numberField(frame, "x"); const y = numberField(frame, "y"); const width = numberField(frame, "width") ?? numberField(frame, "w"); const height = numberField(frame, "height") ?? numberField(frame, "h"); if (role === undefined && label === undefined) return []; return [{ ...(role === undefined ? {} : { role }), ...(label === undefined ? {} : { label }), ...(x !== undefined && y !== undefined && width !== undefined && height !== undefined ? { frame: { x, y, width, height } } : {}) }]; }); }
function localElementFrame(element: Element | undefined, windowBounds: Frame | undefined): Frame | undefined { if (element?.frame === undefined || windowBounds === undefined) return undefined; return { x: element.frame.x - windowBounds.x, y: element.frame.y - windowBounds.y, width: element.frame.width, height: element.frame.height }; }
function center(frame: Frame | undefined): { x: number; y: number } | undefined { return frame === undefined ? undefined : { x: Math.floor(frame.x + frame.width / 2), y: Math.floor(frame.y + frame.height / 2) }; }
function pngSize(data: Uint8Array): { width: number; height: number } | undefined { if (data.length < 24 || data[0] !== 137 || data[1] !== 80 || data[2] !== 78 || data[3] !== 71) return undefined; const read = (i: number) => (data[i] ?? 0) * 0x1000000 + (data[i + 1] ?? 0) * 0x10000 + (data[i + 2] ?? 0) * 0x100 + (data[i + 3] ?? 0); return { width: read(16), height: read(20) }; }
async function saveObservation(data: Uint8Array, label: string, output: string): Promise<Record<string, unknown>> { const dimensions = pngSize(data); await mkdir(join(output, "adapter-screenshots"), { recursive: true }); await writeFile(join(output, "adapter-screenshots", `${label}.png`), data); return { label, bytes: data.byteLength, dimensions, localOnly: true }; }
function actionId(value: string): ActionId { return value as ActionId; }
function observationId(value: string): ObservationId { return value as ObservationId; }

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  await mkdir(options.output, { recursive: true });
  const targetState = join(options.output, "fixture-state.txt");
  const setupLabel = "dev2-adapter-fixture-setup";
  const adapterLabel = "dev2-adapter-window-optin";
  const daemon = spawn(options.binary, ["serve", "--socket", options.socket, "--no-overlay"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }) as Daemon;
  let setupDriver: CuaDriverLike | undefined;
  let setupStarted = false;
  let adapter: CuaDriverComputer | undefined;
  let session: Awaited<ReturnType<CuaDriverComputer["open"]>> | undefined;
  let fixturePid: number | undefined;
  const safe: Record<string, unknown> = { probeVersion: "dev2-adapter-window-contract-0.1.0", modelRequests: 0, keyboardDispatched: false, userWindowTouched: false, stages: {} };
  const stages = safe.stages as Record<string, unknown>;
  try {
    await waitDaemon(options.binary, options.socket, daemon);
    setupDriver = CuaDriver.connect(options.socket);
    await setupDriver.startSession(StartSessionInput.new({ session: setupLabel }), { signal: new AbortController().signal });
    setupStarted = true;
    const launch = await call(setupDriver, "launch_app", { path: options.fixture, additional_arguments: [targetState, "adapter-target", "DEV2 ADAPTER TARGET", "180", "140", "960", "680"], start_minimized: false, session: setupLabel });
    fixturePid = numberField(structured(launch), "pid");
    if (fixturePid === undefined || launch.isError) throw new Error("fixture launch failed");
    const initialDiscovered = await waitWindow(setupDriver, fixturePid);
    if (initialDiscovered === undefined || initialDiscovered.bounds === undefined) throw new Error("fixture window not discovered");
    const initialFrame: Frame = { x: 240, y: 180, width: 960, height: 680 };
    const initialFrameOperation = await setFrame(setupDriver, initialDiscovered, initialFrame, setupLabel);
    const stableInitial = await waitWindow(setupDriver, fixturePid);
    if (stableInitial === undefined || stableInitial.bounds === undefined) throw new Error("fixture window did not stabilize after initial frame");
    const discovered: WindowInfo = { ...initialDiscovered, bounds: stableInitial.bounds };
    stages.discovery = { pidOwned: discovered.pid === fixturePid, windowIdPresent: true, bounds: discovered.bounds, initialFrame, initialFrameOperation: safeTool(initialFrameOperation) };
    adapter = new CuaDriverComputer({ socketPath: options.socket, screenshotDir: join(options.output, "adapter-observations"), sessionLabel: adapterLabel, windowTarget: { pid: discovered.pid, windowId: discovered.windowId }, cleanupWaitMs: 5000 });
    session = await adapter.open({}, new AbortController().signal);
    const observation1 = await adapter.observe(session, observationId("adapter-window-observation-1"), new AbortController().signal);
    const saved1 = await saveObservation(observation1.screenshot.data, "observation-1", options.output);
    const state1 = await readState(targetState);
    stages.openObserve = { descriptor: session, capabilities: session.capabilities, observationViewport: observation1.viewport, expectedWindowClientViewport: { width: initialFrame.width - 2, height: initialFrame.height - 2 }, observation: saved1, fixtureState: state1, productionAdapterWindowDeliveryMode: "background", productionAdapterKeyboardDisabled: session.capabilities.keyboard === false };
    const stateWindow = await call(setupDriver, "get_window_state", { pid: discovered.pid, window_id: discovered.windowId, include_screenshot: false, session: setupLabel });
    const elements = elementsFrom(stateWindow);
    const button = elements.find((item) => `${item.role ?? ""} ${item.label ?? ""}`.toLowerCase().includes("button") && `${item.role ?? ""} ${item.label ?? ""}`.toLowerCase().includes("window target"));
    const localButtonFrame = localElementFrame(button, discovered.bounds);
    const point1 = center(localButtonFrame);
    if (point1 === undefined) throw new Error("adapter button geometry unavailable");
    const firstClick = await adapter.execute(session, { actionId: actionId("adapter-window-click-1"), basedOn: observationId("adapter-window-observation-1"), kind: "click", point: point1 }, new AbortController().signal);
    const clicked1 = await waitState(targetState, (state) => (state.clickCount ?? 0) >= 1);
    stages.firstClick = { point: point1, receipt: firstClick, oracle: clicked1, noKeyboard: true };

    const frame2: Frame = { x: 360, y: 260, width: 1040, height: 720 };
    const moved = await setFrame(setupDriver, discovered, frame2, setupLabel);
    const staleClick = await adapter.execute(session, { actionId: actionId("adapter-window-stale-click"), basedOn: observationId("adapter-window-observation-1"), kind: "click", point: point1 }, new AbortController().signal);
    const observation2 = await adapter.observe(session, observationId("adapter-window-observation-2"), new AbortController().signal);
    const saved2 = await saveObservation(observation2.screenshot.data, "observation-2", options.output);
    const liveWindow = await waitWindow(setupDriver, discovered.pid);
    const freshStateWindow = liveWindow === undefined ? undefined : await call(setupDriver, "get_window_state", { pid: discovered.pid, window_id: discovered.windowId, include_screenshot: false, session: setupLabel });
    const freshElements = freshStateWindow === undefined ? [] : elementsFrom(freshStateWindow);
    const freshButton = freshElements.find((item) => `${item.role ?? ""} ${item.label ?? ""}`.toLowerCase().includes("button") && `${item.role ?? ""} ${item.label ?? ""}`.toLowerCase().includes("window target"));
    const point2 = center(localElementFrame(freshButton, liveWindow?.bounds));
    if (point2 === undefined) throw new Error("fresh adapter button geometry unavailable");
    const secondClick = await adapter.execute(session, { actionId: actionId("adapter-window-click-2"), basedOn: observationId("adapter-window-observation-2"), kind: "click", point: point2 }, new AbortController().signal);
    const clicked2 = await waitState(targetState, (state) => (state.clickCount ?? 0) >= 2);
    stages.moveResizeStaleFresh = { moveOperation: safeTool(moved), staleReceipt: staleClick, staleExpectedCode: "WINDOW_GEOMETRY_CHANGED", freshViewport: observation2.viewport, freshObservation: saved2, freshPoint: point2, secondReceipt: secondClick, oracle: clicked2 };
    if (fixturePid !== undefined) {
      try { process.kill(fixturePid); } catch { /* own fixture only */ }
      fixturePid = undefined;
    }
    await new Promise((done) => setTimeout(done, 250));
    const closedReceipt = await adapter.execute(session, { actionId: actionId("adapter-window-closed-click"), basedOn: observationId("adapter-window-observation-2"), kind: "click", point: point2 }, new AbortController().signal);
    stages.closeReject = { receipt: closedReceipt, expectedCodes: ["WINDOW_TARGET_NOT_FOUND", "WINDOW_TARGET_UNKNOWN"], refused: closedReceipt.status === "refused" };
    await adapter.close(session);
    adapter = undefined;
    session = undefined;
    safe.ok = Boolean(
      sessionDescriptorOk(stages.openObserve)
      && (stages.openObserve as Record<string, unknown>).observationViewport !== undefined
      && ((stages.openObserve as Record<string, unknown>).observationViewport as Record<string, unknown>).width === initialFrame.width - 2
      && ((stages.openObserve as Record<string, unknown>).observationViewport as Record<string, unknown>).height === initialFrame.height - 2
      && clicked1?.clickCount === 1
      && firstClick.status === "completed"
      && staleClick.status === "refused"
      && staleClick.driverCode === "WINDOW_GEOMETRY_CHANGED"
      && observation2.viewport.width !== observation1.viewport.width
      && clicked2?.clickCount === 2
      && secondClick.status === "completed"
      && closedReceipt.status === "refused"
      && closedReceipt.driverCode === "WINDOW_TARGET_NOT_FOUND",
    );
  } catch (error) {
    safe.ok = false;
    safe.failure = { kind: "probe_error", code: error instanceof Error ? error.name : "unknown" };
  } finally {
    if (fixturePid !== undefined) { try { process.kill(fixturePid); } catch { /* own fixture only */ } }
    if (adapter !== undefined && session !== undefined) { try { await adapter.close(session); } catch { /* preserve evidence */ } }
    if (setupDriver !== undefined) {
      if (setupStarted) { try { await setupDriver.endSession(EndSessionInput.new({ session: setupLabel }), { signal: new AbortController().signal }); } catch { /* preserve evidence */ } }
      try { await setupDriver.shutdown({ signal: new AbortController().signal }); } catch { /* stop remains authoritative */ }
      (setupDriver as unknown as { uniffiDestroy?: () => void }).uniffiDestroy?.();
    }
    await runProcess(options.binary, ["stop", "--socket", options.socket]).catch(() => undefined);
    await writeFile(join(options.output, "adapter-window-contract-summary.json"), `${JSON.stringify(safe, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify({ ok: safe.ok === true, output: "<ignored-output>", modelRequests: 0 }, null, 2));
  if (safe.ok !== true) process.exitCode = 1;
}

function sessionDescriptorOk(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const descriptor = (value as Record<string, unknown>).descriptor;
  const capabilities = (value as Record<string, unknown>).capabilities;
  return descriptor !== undefined && capabilities !== undefined;
}

main().catch(() => { process.exitCode = 1; });
