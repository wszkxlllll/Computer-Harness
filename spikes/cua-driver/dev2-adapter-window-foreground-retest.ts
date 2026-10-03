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
} from "@trycua/cua-driver-0.22.2";
import { CuaDriverComputer } from "@computer-harness/computer-cua";
import type { ActionId, ObservationId } from "@computer-harness/protocol";

type Daemon = ChildProcessByStdio<null, Readable, Readable>;
type Frame = { x: number; y: number; width: number; height: number };
type WindowInfo = { pid: number; windowId: number; bounds?: Frame };
type FixtureState = {
  event?: string | undefined;
  eventSequence?: number | undefined;
  formActive?: boolean | undefined;
  textLength?: number | undefined;
  text?: string | undefined;
  containsProbeText?: boolean | undefined;
  selectionLength?: number | undefined;
  dragCount?: number | undefined;
  longLineCount?: number | undefined;
  firstVisibleLine?: number | undefined;
  lastKey?: string | undefined;
};

interface Options {
  binary: string;
  fixture: string;
  output: string;
  socket: string;
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function required(args: readonly string[], name: string): string {
  const value = option(args, name);
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function normalizePipe(value: string): string {
  if (process.platform !== "win32") return value;
  const match = value.match(/^\\+\.\\+pipe\\+(.*)$/iu);
  return match?.[1] === undefined ? value : `\\\\.\\pipe\\${match[1].replace(/\\+/gu, "\\")}`;
}

function parseOptions(args: readonly string[]): Options {
  return {
    binary: resolve(required(args, "--binary")),
    fixture: resolve(required(args, "--fixture")),
    output: resolve(required(args, "--output")),
    socket: normalizePipe(required(args, "--socket")),
  };
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

function parseState(raw: string): FixtureState {
  const values = new Map(raw.split(/\r?\n/gu).flatMap((line) => {
    const index = line.indexOf("=");
    return index <= 0 ? [] : [[line.slice(0, index), line.slice(index + 1)] as const];
  }));
  const number = (key: string): number | undefined => {
    const value = values.get(key);
    return value !== undefined && /^\d+$/u.test(value) ? Number(value) : undefined;
  };
  const boolean = (key: string): boolean | undefined => {
    const value = values.get(key);
    return value === "True" ? true : value === "False" ? false : undefined;
  };
  return {
    event: values.get("event"),
    eventSequence: number("eventSequence"),
    formActive: boolean("formActive"),
    textLength: number("textLength"),
    text: values.get("text"),
    containsProbeText: boolean("containsProbeText"),
    selectionLength: number("selectionLength"),
    dragCount: number("dragCount"),
    longLineCount: number("longLineCount"),
    firstVisibleLine: number("firstVisibleLine"),
    lastKey: values.get("lastKey"),
  };
}

async function readState(path: string): Promise<FixtureState | undefined> {
  const raw = await readFile(path, "utf8").catch(() => undefined);
  return raw === undefined ? undefined : parseState(raw);
}

async function waitState(path: string, predicate: (state: FixtureState) => boolean, timeoutMs = 8_000): Promise<FixtureState | undefined> {
  const deadline = Date.now() + timeoutMs;
  let latest: FixtureState | undefined;
  while (Date.now() < deadline) {
    latest = await readState(path);
    if (latest !== undefined && predicate(latest)) return latest;
    await new Promise((done) => setTimeout(done, 100));
  }
  return latest;
}

async function bounded<T>(label: string, operation: Promise<T>, timeoutMs = 12_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function runProcess(file: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = execFile(file, args, { windowsHide: true, encoding: "utf8", timeout: 20_000 }, (error, stdout, stderr) => {
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
    if (daemon.exitCode !== null) throw new Error("private daemon exited before readiness");
    const status = await runProcess(binary, ["status", "--socket", socket]);
    if (status.code === 0 && /daemon is running/iu.test(status.stdout)) return;
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error("private daemon readiness timeout");
}

async function call(driver: CuaDriverLike, name: string, input: Record<string, unknown>, signal = new AbortController().signal): Promise<ToolResult> {
  return driver.callTool(name, JSON.stringify(input), { signal });
}

function safeTool(result: ToolResult | undefined): Record<string, unknown> | null {
  if (result === undefined) return null;
  const action = result.action;
  return {
    isError: result.isError,
    errorCode: result.errorCode ?? null,
    degraded: result.degraded,
    textLength: result.text.length,
    structuredLength: result.structuredJson?.length ?? 0,
    action: action === undefined ? null : {
      effect: String(action.effect),
      route: String(action.route),
      delivery: action.delivery === undefined ? null : { mode: String(action.delivery.mode), deliveredCount: action.delivery.deliveredCount ?? null },
    },
  };
}

function windowsFrom(result: ToolResult): WindowInfo[] {
  const windows = structured(result)?.windows;
  if (!Array.isArray(windows)) return [];
  return windows.flatMap((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    const pid = numberField(item, "pid");
    const windowId = numberField(item, "window_id");
    const boundsValue = item.bounds;
    if (pid === undefined || windowId === undefined || boundsValue === null || typeof boundsValue !== "object" || Array.isArray(boundsValue)) return [];
    const boundsRecord = boundsValue as Record<string, unknown>;
    const x = numberField(boundsRecord, "x");
    const y = numberField(boundsRecord, "y");
    const width = numberField(boundsRecord, "width");
    const height = numberField(boundsRecord, "height");
    return x === undefined || y === undefined || width === undefined || height === undefined
      ? []
      : [{ pid, windowId, bounds: { x, y, width, height } }];
  });
}

async function waitWindow(driver: CuaDriverLike, pid: number): Promise<WindowInfo> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const windows = windowsFrom(await call(driver, "list_windows", { pid, on_screen_only: true }));
    const target = windows.find((window) => window.pid === pid && window.bounds !== undefined);
    if (target !== undefined) return target;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`window ${pid} was not discovered`);
}

async function setFrame(driver: CuaDriverLike, target: WindowInfo, frame: Frame, session: string): Promise<ToolResult> {
  return driver.setWindowFrame(SetWindowFrameInput.new({ pid: target.pid, windowId: BigInt(target.windowId), ...frame, session }), { signal: new AbortController().signal });
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  await mkdir(options.output, { recursive: true });
  const targetStatePath = join(options.output, "target-state.txt");
  const witnessStatePath = join(options.output, "witness-state.txt");
  const safe: Record<string, unknown> = {
    probeVersion: "dev2-adapter-window-foreground-retest-0.1.0",
    interferenceFreeClaim: true,
    modelRequests: 0,
    userWindowTouched: false,
    stages: {},
  };
  const stages = safe.stages as Record<string, unknown>;
  const setupSession = "dev2-foreground-retest-setup";
  const adapterSession = "dev2-foreground-retest-adapter";
  const daemon = spawn(options.binary, ["serve", "--socket", options.socket, "--no-overlay"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }) as Daemon;
  let setupDriver: CuaDriverLike | undefined;
  let setupStarted = false;
  let adapter: CuaDriverComputer | undefined;
  let adapterSessionDescriptor: Awaited<ReturnType<CuaDriverComputer["open"]>> | undefined;
  let targetPid: number | undefined;
  let witnessPid: number | undefined;
  try {
    await waitDaemon(options.binary, options.socket, daemon);
    setupDriver = CuaDriver.connect(options.socket);
    await bounded("setup start", setupDriver.startSession(StartSessionInput.new({ session: setupSession }), { signal: new AbortController().signal }));
    setupStarted = true;
    const targetLaunch = await bounded("target launch", call(setupDriver, "launch_app", {
      path: options.fixture,
      additional_arguments: [targetStatePath, "foreground-target", "DEV2 FOREGROUND TARGET", "240", "180", "960", "680"],
      start_minimized: false,
      session: setupSession,
    }));
    targetPid = numberField(structured(targetLaunch), "pid");
    if (targetPid === undefined || targetLaunch.isError) throw new Error("target fixture launch failed");
    let target = await waitWindow(setupDriver, targetPid);
    const targetFrame: Frame = { x: 240, y: 180, width: 960, height: 680 };
    await bounded("target frame", setFrame(setupDriver, target, targetFrame, setupSession));
    target = await waitWindow(setupDriver, targetPid);
    const witnessLaunch = await bounded("witness launch", call(setupDriver, "launch_app", {
      path: options.fixture,
      additional_arguments: [witnessStatePath, "foreground-witness", "DEV2 FOREGROUND WITNESS", "420", "300", "700", "450"],
      start_minimized: false,
      session: setupSession,
    }));
    witnessPid = numberField(structured(witnessLaunch), "pid");
    if (witnessPid === undefined || witnessLaunch.isError) throw new Error("witness fixture launch failed");
    let witness = await waitWindow(setupDriver, witnessPid);
    const witnessFrame: Frame = { x: 420, y: 300, width: 700, height: 450 };
    await bounded("witness frame", setFrame(setupDriver, witness, witnessFrame, setupSession));
    witness = await waitWindow(setupDriver, witnessPid);
    const witnessFront = await bounded("witness foreground", call(setupDriver, "bring_to_front", { pid: witness.pid, window_id: witness.windowId, session: setupSession }));
    const witnessLanded = structured(witnessFront)?.landed_on_target === true;
    const witnessBefore = await waitState(witnessStatePath, (state) => state.formActive === true);
    const targetBefore = await waitState(targetStatePath, (state) => state.formActive === false);
    stages.discovery = {
      targetPidOwned: target.pid === targetPid,
      targetWindowId: target.windowId,
      witnessPidOwned: witness.pid === witnessPid,
      witnessWindowId: witness.windowId,
      targetBounds: target.bounds,
      witnessBounds: witness.bounds,
      witnessFront: safeTool(witnessFront),
      witnessLanded,
      targetInactiveBefore: targetBefore?.formActive === false,
      witnessActiveBefore: witnessBefore?.formActive === true,
    };

    adapter = new CuaDriverComputer({
      socketPath: options.socket,
      screenshotDir: join(options.output, "adapter-observations"),
      sessionLabel: adapterSession,
      windowTarget: { pid: target.pid, windowId: target.windowId },
      windowDeliveryMode: "foreground",
      cleanupWaitMs: 2_000,
    });
    adapterSessionDescriptor = await bounded("adapter open", adapter.open({}, new AbortController().signal));
    const observationId = "foreground-observation-1" as ObservationId;
    const observation = await bounded("target observe", adapter.observe(adapterSessionDescriptor, observationId, new AbortController().signal));
    const point = { x: Math.floor((target.bounds?.width ?? 960) / 2), y: Math.floor((target.bounds?.height ?? 680) / 2) };
    const click = await bounded("foreground click", adapter.execute(adapterSessionDescriptor, { actionId: "foreground-click" as ActionId, basedOn: observationId, kind: "click", point }, new AbortController().signal));
    const clicked = await waitState(targetStatePath, (state) => (state.eventSequence ?? 0) > (targetBefore?.eventSequence ?? 0));
    const witnessAfterClick = await readState(witnessStatePath);
    const targetAfterClick = await readState(targetStatePath);
    const afterClickObservationId = "foreground-observation-after-click" as ObservationId;
    await bounded("observe after click", adapter.observe(adapterSessionDescriptor, afterClickObservationId, new AbortController().signal));
    const typeText = "Computer-Harness probe EN | 中文输入";
    const type = await bounded("foreground type", adapter.execute(adapterSessionDescriptor, { actionId: "foreground-type" as ActionId, basedOn: afterClickObservationId, kind: "type", text: typeText }, new AbortController().signal));
    const typed = await waitState(targetStatePath, (state) => state.containsProbeText === true);
    const witnessAfterType = await readState(witnessStatePath);
    const targetAfterType = await readState(targetStatePath);
    const afterTypeObservationId = "foreground-observation-after-type" as ObservationId;
    await bounded("observe after type", adapter.observe(adapterSessionDescriptor, afterTypeObservationId, new AbortController().signal));
    const keypress = await bounded("foreground keypress", adapter.execute(adapterSessionDescriptor, { actionId: "foreground-key" as ActionId, basedOn: afterTypeObservationId, kind: "keypress", keys: ["F2"] }, new AbortController().signal));
    const keyed = await waitState(targetStatePath, (state) => state.lastKey === "F2");
    const witnessAfterKey = await readState(witnessStatePath);
    const targetAfterKey = await readState(targetStatePath);
    const afterKeyObservationId = "foreground-observation-after-key" as ObservationId;
    await bounded("observe after key", adapter.observe(adapterSessionDescriptor, afterKeyObservationId, new AbortController().signal));
    const hotkey = await bounded("foreground ctrl-a", adapter.execute(adapterSessionDescriptor, { actionId: "foreground-ctrl-a" as ActionId, basedOn: afterKeyObservationId, kind: "keypress", keys: ["CTRL", "A"] }, new AbortController().signal));
    const selected = await waitState(targetStatePath, (state) => (state.selectionLength ?? 0) > 0);
    const afterHotkeyObservationId = "foreground-observation-after-hotkey" as ObservationId;
    await bounded("observe after hotkey", adapter.observe(adapterSessionDescriptor, afterHotkeyObservationId, new AbortController().signal));
    const replacement = await bounded("foreground replacement", adapter.execute(adapterSessionDescriptor, { actionId: "foreground-replacement" as ActionId, basedOn: afterHotkeyObservationId, kind: "type", text: "REPLACED" }, new AbortController().signal));
    const replaced = await waitState(targetStatePath, (state) => state.text?.includes("REPLACED") === true && (state.selectionLength ?? 0) === 0);
    const afterReplacementObservationId = "foreground-observation-after-replacement" as ObservationId;
    await bounded("observe after replacement", adapter.observe(adapterSessionDescriptor, afterReplacementObservationId, new AbortController().signal));
    const beforeDrag = await readState(targetStatePath);
    const drag = await bounded("foreground drag", adapter.execute(adapterSessionDescriptor, { actionId: "foreground-drag" as ActionId, basedOn: afterReplacementObservationId, kind: "drag", from: { x: 280, y: 260 }, to: { x: 480, y: 320 } }, new AbortController().signal));
    const dragged = await waitState(targetStatePath, (state) => (state.dragCount ?? 0) > (beforeDrag?.dragCount ?? 0));
    stages.actions = {
      mode: "foreground",
      viewport: observation.viewport,
      click: { receipt: click, oracle: clicked, targetActiveAfter: targetAfterClick?.formActive === true, witnessActiveAfter: witnessAfterClick?.formActive === true },
      type: { textLength: typeText.length, receipt: type, oracle: typed, targetActiveAfter: targetAfterType?.formActive === true, witnessActiveAfter: witnessAfterType?.formActive === true },
      keypress: { key: "F2", receipt: keypress, oracle: keyed, targetActiveAfter: targetAfterKey?.formActive === true, witnessActiveAfter: witnessAfterKey?.formActive === true },
      hotkey: { keys: ["CTRL", "A"], receipt: hotkey, oracle: selected },
      replacement: { receipt: replacement, oracle: replaced },
      drag: { receipt: drag, before: beforeDrag, oracle: dragged },
    };
    safe.ok = Boolean(
      click.status === "completed"
      && clicked !== undefined
      && type.status === "completed"
      && typed?.containsProbeText === true
      && keypress.status === "completed"
      && keyed?.lastKey === "F2"
      && hotkey.status === "completed"
      && (selected?.selectionLength ?? 0) > 0
      && replacement.status === "completed"
      && replaced?.text?.includes("REPLACED") === true
      && drag.status === "completed"
      && (dragged?.dragCount ?? 0) > (beforeDrag?.dragCount ?? 0)
      && witnessBefore?.formActive === true
      && targetBefore?.formActive === false
      && witnessLanded
      && witnessAfterClick?.formActive === true
      && witnessAfterType?.formActive === true
      && witnessAfterKey?.formActive === true,
    );
  } catch (error) {
    safe.ok = false;
    safe.failure = {
      code: error instanceof Error ? error.name : "unknown",
      message: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240),
    };
  } finally {
    if (adapter !== undefined && adapterSessionDescriptor !== undefined) await bounded("adapter close", adapter.close(adapterSessionDescriptor), 3_000).catch(() => undefined);
    if (targetPid !== undefined) { try { process.kill(targetPid); } catch { /* own fixture only */ } }
    if (witnessPid !== undefined) { try { process.kill(witnessPid); } catch { /* own fixture only */ } }
    if (setupDriver !== undefined) {
      if (setupStarted) await bounded("setup end", setupDriver.endSession(EndSessionInput.new({ session: setupSession }), { signal: new AbortController().signal }), 3_000).catch(() => undefined);
      await bounded("setup shutdown", setupDriver.shutdown(), 3_000).catch(() => undefined);
      (setupDriver as unknown as { uniffiDestroy?: () => void }).uniffiDestroy?.();
    }
    await runProcess(options.binary, ["stop", "--socket", options.socket]).catch(() => undefined);
    safe.cleanup = { targetPid, witnessPid, daemonStopRequested: true };
    await writeFile(join(options.output, "foreground-retest-summary.json"), `${JSON.stringify(safe, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify({ ok: safe.ok === true, output: "<ignored-output>" }, null, 2)}\n`);
  if (safe.ok !== true) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
