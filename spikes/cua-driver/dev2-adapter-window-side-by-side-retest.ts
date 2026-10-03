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
} from "@trycua/cua-driver-0.22.2";
import { CuaDriverComputer } from "@computer-harness/computer-cua";
import type { ActionId, ActionReceipt, ModelTurn, ObservationId, RunId, ToolCall } from "@computer-harness/protocol";
import {
  createDefaultComputerTools,
  DefaultRuntimePolicy,
  RunController,
  type ContextCompiler,
  type ModelInput,
  type ProviderAdapter,
} from "@computer-harness/runtime";
import { FileAssetStore, JsonlRunEventWriter } from "@computer-harness/trajectory";

type Daemon = ChildProcessByStdio<null, Readable, Readable>;
type Frame = { x: number; y: number; width: number; height: number };
type WindowInfo = { pid: number; windowId: number; bounds?: Frame };
type FixtureState = {
  event?: string | undefined;
  eventSequence?: number | undefined;
  formActive?: boolean | undefined;
  focused?: boolean | undefined;
  text?: string | undefined;
  textLength?: number | undefined;
  containsProbeText?: boolean | undefined;
  selectionLength?: number | undefined;
  firstVisibleLine?: number | undefined;
  lastVisibleLine?: number | undefined;
  longLineCount?: number | undefined;
  dragCount?: number | undefined;
  lastKey?: string | undefined;
};

interface Options { binary: string; fixture: string; output: string; socket: string; }

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

function structured(value: { structuredJson?: string }): Record<string, unknown> | undefined {
  if (typeof value.structuredJson !== "string") return undefined;
  try {
    const parsed = JSON.parse(value.structuredJson) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
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
    return value !== undefined && /^-?\d+$/u.test(value) ? Number(value) : undefined;
  };
  const boolean = (key: string): boolean | undefined => {
    const value = values.get(key);
    return value === "True" ? true : value === "False" ? false : undefined;
  };
  return {
    event: values.get("event"),
    eventSequence: number("eventSequence"),
    formActive: boolean("formActive"),
    focused: boolean("focused"),
    text: values.get("text"),
    textLength: number("textLength"),
    containsProbeText: boolean("containsProbeText"),
    selectionLength: number("selectionLength"),
    firstVisibleLine: number("firstVisibleLine"),
    lastVisibleLine: number("lastVisibleLine"),
    longLineCount: number("longLineCount"),
    dragCount: number("dragCount"),
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

async function bounded<T>(label: string, operation: Promise<T>, timeoutMs = 15_000): Promise<T> {
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
      resolveResult({ code: error === null ? 0 : typeof error.code === "number" ? error.code : null, stdout: String(stdout), stderr: String(stderr) });
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

async function call(driver: CuaDriverLike, name: string, input: Record<string, unknown>): Promise<ToolResult> {
  return driver.callTool(name, JSON.stringify(input), { signal: new AbortController().signal });
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
    const bounds = boundsValue as Record<string, unknown>;
    const x = numberField(bounds, "x");
    const y = numberField(bounds, "y");
    const width = numberField(bounds, "width");
    const height = numberField(bounds, "height");
    return x === undefined || y === undefined || width === undefined || height === undefined ? [] : [{ pid, windowId, bounds: { x, y, width, height } }];
  });
}

async function waitWindow(driver: CuaDriverLike, pid: number): Promise<WindowInfo> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const match = windowsFrom(await call(driver, "list_windows", { pid, on_screen_only: true })).find((item) => item.pid === pid && item.bounds !== undefined);
    if (match !== undefined) return match;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`window ${pid} was not discovered`);
}

async function setFrame(driver: CuaDriverLike, target: WindowInfo, frame: Frame, session: string): Promise<ToolResult> {
  return driver.setWindowFrame(SetWindowFrameInput.new({ pid: target.pid, windowId: BigInt(target.windowId), ...frame, session }), { signal: new AbortController().signal });
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
    action: action === undefined ? null : { effect: String(action.effect), route: String(action.route), delivery: action.delivery === undefined ? null : { mode: String(action.delivery.mode), deliveredCount: action.delivery.deliveredCount ?? null } },
  };
}

function safeReceipt(receipt: ActionReceipt): Record<string, unknown> {
  return { actionId: receipt.actionId, status: receipt.status, driverCode: receipt.driverCode ?? null, message: receipt.message ?? null };
}

function stateEvidence(state: FixtureState | undefined): Record<string, unknown> | null {
  if (state === undefined) return null;
  return {
    event: state.event ?? null,
    eventSequence: state.eventSequence ?? null,
    formActive: state.formActive ?? null,
    focused: state.focused ?? null,
    textLength: state.textLength ?? null,
    text: state.text ?? null,
    containsProbeText: state.containsProbeText ?? null,
    selectionLength: state.selectionLength ?? null,
    firstVisibleLine: state.firstVisibleLine ?? null,
    lastVisibleLine: state.lastVisibleLine ?? null,
    longLineCount: state.longLineCount ?? null,
    dragCount: state.dragCount ?? null,
    lastKey: state.lastKey ?? null,
  };
}

function screenshotHash(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function overlap(left: Frame | undefined, right: Frame | undefined): boolean {
  if (left === undefined || right === undefined) return true;
  return left.x < right.x + right.width && right.x < left.x + left.width && left.y < right.y + right.height && right.y < left.y + left.height;
}

function hasScrollEvent(state: FixtureState | undefined): boolean {
  return state?.event === "v_scroll" || state?.event === "v_scroll_settled";
}

function actionId(value: string): ActionId { return value as ActionId; }
function observationId(value: string): ObservationId { return value as ObservationId; }

class SideContextCompiler implements ContextCompiler {
  public constructor(private readonly tools: ReturnType<typeof createDefaultComputerTools>) {}
  public async compile(_input: Parameters<ContextCompiler["compile"]>[0], _signal: AbortSignal): Promise<ModelInput> {
    return { system: "side-by-side fixture approval probe", messages: [], tools: this.tools.modelTools() };
  }
}

class ScriptedProvider implements ProviderAdapter {
  public readonly id = "side-by-side-scripted-provider";
  private calls = 0;
  public constructor(private readonly point: { x: number; y: number }) {}
  public async generate(_input: ModelInput, options: { signal: AbortSignal }): Promise<ModelTurn> {
    options.signal.throwIfAborted();
    this.calls += 1;
    if (this.calls === 1) {
      const call: ToolCall = { id: "side-approval-click" as ToolCall["id"], name: "click", arguments: { x: this.point.x, y: this.point.y } };
      return { type: "tool_calls", calls: [call] };
    }
    return { type: "finish", summary: "side-by-side approval probe finished" };
  }
}

class ApprovalClickPolicy extends DefaultRuntimePolicy {
  public constructor(private readonly onApprovalRequested: () => void) { super(4, 4); }
  public override async evaluateToolCall(context: Parameters<DefaultRuntimePolicy["evaluateToolCall"]>[0]) {
    if (context.call.name === "click") {
      this.onApprovalRequested();
      return { decision: "require_approval" as const, reason: "side-by-side fixture click requires approval" };
    }
    return { decision: "allow" as const };
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 12_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error("approval probe condition timed out");
}

async function approvalProbe(
  output: string,
  socket: string,
  target: WindowInfo,
  targetStatePath: string,
  witnessStatePath: string,
  point: { x: number; y: number },
): Promise<Record<string, unknown>> {
  const approvalOutput = join(output, "approval");
  await mkdir(approvalOutput, { recursive: true });
  const computer = new CuaDriverComputer({
    socketPath: socket,
    screenshotDir: join(approvalOutput, "observations"),
    sessionLabel: "side-by-side-approval-adapter",
    windowTarget: { pid: target.pid, windowId: target.windowId },
    windowDeliveryMode: "foreground",
    cleanupWaitMs: 3_000,
  });
  let approvalRequested = false;
  const registry = createDefaultComputerTools();
  const runId = "side-by-side-approval-run" as RunId;
  const writer = new JsonlRunEventWriter(join(approvalOutput, "trajectory.jsonl"), runId);
  const controller = new RunController({
    runId,
    provider: new ScriptedProvider(point),
    computer,
    contextCompiler: new SideContextCompiler(registry),
    toolRegistry: registry,
    policy: new ApprovalClickPolicy(() => { approvalRequested = true; }),
    eventWriter: writer,
    assetStore: new FileAssetStore(join(approvalOutput, "assets")),
  });
  const beforeTarget = await readState(targetStatePath);
  const beforeWitness = await readState(witnessStatePath);
  let runResult: string | undefined;
  let failure: string | undefined;
  try {
    const running = controller.start("approve one click on the right fixture");
    await waitUntil(() => controller.getSnapshot().status === "waiting_approval" || controller.getSnapshot().status === "finished");
    const pending = controller.getSnapshot().pendingApproval;
    if (!approvalRequested || pending === undefined) throw new Error("scripted provider did not reach approval boundary");
    await controller.resolveApproval(pending.requestId, true);
    runResult = await running;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  const afterTarget = await waitState(targetStatePath, (state) => (state.eventSequence ?? 0) > (beforeTarget?.eventSequence ?? 0));
  const afterWitness = await readState(witnessStatePath);
  const events = controller.getEvents();
  const completed = events.some((event) => event.type === "tool.call.completed" && event.result.callId === ("side-approval-click" as ToolCall["id"]));
  return {
    approvalRequested,
    approvalResolved: events.some((event) => event.type === "approval.resolved" && event.approved === true),
    actionCompleted: completed,
    runResult: runResult ?? null,
    failure: failure ?? null,
    targetBefore: stateEvidence(beforeTarget),
    targetAfter: stateEvidence(afterTarget),
    witnessBefore: stateEvidence(beforeWitness),
    witnessAfter: stateEvidence(afterWitness),
    targetClickObserved: afterTarget !== undefined && (afterTarget.eventSequence ?? 0) > (beforeTarget?.eventSequence ?? 0),
    witnessTextUnchanged: afterWitness?.text === beforeWitness?.text,
    events: events.map((event) => event.type),
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  await mkdir(options.output, { recursive: true });
  const targetStatePath = join(options.output, "target-state.txt");
  const witnessStatePath = join(options.output, "witness-state.txt");
  const safe: Record<string, unknown> = {
    probeVersion: "dev2-adapter-window-side-by-side-retest-0.1.0",
    daemonVersion: "0.22.2",
    layout: "left-witness-right-target-non-overlap",
    productionAdapter: true,
    deliveryMode: "foreground",
    scrollBy: "line",
    modelRequests: 0,
    userWindowTouched: false,
    ok: false,
    stages: {},
  };
  const stages = safe.stages as Record<string, unknown>;
  const setupSession = "side-by-side-setup";
  const adapterSession = "side-by-side-adapter";
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
    const targetFrame: Frame = { x: 1000, y: 180, width: 960, height: 680 };
    const witnessFrame: Frame = { x: 100, y: 180, width: 700, height: 450 };
    const targetLaunch = await bounded("target launch", call(setupDriver, "launch_app", { path: options.fixture, additional_arguments: [targetStatePath, "side-right-target", "SIDE RIGHT TARGET", String(targetFrame.x), String(targetFrame.y), String(targetFrame.width), String(targetFrame.height), "preload"], start_minimized: false, session: setupSession }));
    targetPid = numberField(structured(targetLaunch), "pid");
    if (targetPid === undefined || targetLaunch.isError) throw new Error("target fixture launch failed");
    let target = await waitWindow(setupDriver, targetPid);
    await bounded("target frame", setFrame(setupDriver, target, targetFrame, setupSession));
    target = await waitWindow(setupDriver, targetPid);
    const witnessLaunch = await bounded("witness launch", call(setupDriver, "launch_app", { path: options.fixture, additional_arguments: [witnessStatePath, "side-left-witness", "SIDE LEFT CONTROL", String(witnessFrame.x), String(witnessFrame.y), String(witnessFrame.width), String(witnessFrame.height)], start_minimized: false, session: setupSession }));
    witnessPid = numberField(structured(witnessLaunch), "pid");
    if (witnessPid === undefined || witnessLaunch.isError) throw new Error("witness fixture launch failed");
    let witness = await waitWindow(setupDriver, witnessPid);
    await bounded("witness frame", setFrame(setupDriver, witness, witnessFrame, setupSession));
    witness = await waitWindow(setupDriver, witnessPid);
    const witnessFront = await bounded("witness foreground", call(setupDriver, "bring_to_front", { pid: witness.pid, window_id: witness.windowId, session: setupSession }));
    const targetBefore = await waitState(targetStatePath, (state) => state.formActive === false);
    const witnessBefore = await waitState(witnessStatePath, (state) => state.formActive === true);
    const point = { x: 120, y: 120 };
    const desktopPoint = { x: (target.bounds?.x ?? targetFrame.x) + point.x, y: (target.bounds?.y ?? targetFrame.y) + point.y };
    stages.discovery = {
      targetPidOwned: target.pid === targetPid,
      witnessPidOwned: witness.pid === witnessPid,
      targetPid: target.pid,
      targetWindowId: target.windowId,
      witnessPid: witness.pid,
      witnessWindowId: witness.windowId,
      targetBounds: target.bounds,
      witnessBounds: witness.bounds,
      nonOverlapping: !overlap(target.bounds, witness.bounds),
      targetFrameRequested: targetFrame,
      witnessFrameRequested: witnessFrame,
      targetPoint: point,
      desktopPoint,
      witnessFront: safeTool(witnessFront),
      targetInactiveBefore: targetBefore?.formActive === false,
      witnessActiveBefore: witnessBefore?.formActive === true,
      targetTextBefore: targetBefore?.text ?? null,
      witnessTextBefore: witnessBefore?.text ?? null,
    };
    adapter = new CuaDriverComputer({ socketPath: options.socket, screenshotDir: join(options.output, "adapter-observations"), sessionLabel: adapterSession, windowTarget: { pid: target.pid, windowId: target.windowId }, windowDeliveryMode: "foreground", cleanupWaitMs: 3_000 });
    adapterSessionDescriptor = await bounded("adapter open", adapter.open({}, new AbortController().signal));
    const focusObservationId = observationId("side-observation-before-focus");
    const beforeFocusObservation = await bounded("observe target before focus switch", adapter.observe(adapterSessionDescriptor, focusObservationId, new AbortController().signal));
    const beforeFocusWitness = await readState(witnessStatePath);
    const refocusWitness = await bounded("focus left witness", call(setupDriver, "bring_to_front", { pid: witness.pid, window_id: witness.windowId, session: setupSession }));
    const afterFocusObservation = await bounded("observe target after focus switch", adapter.observe(adapterSessionDescriptor, observationId("side-observation-after-focus"), new AbortController().signal));
    stages.focusSwitch = {
      witnessRefocus: safeTool(refocusWitness),
      targetBefore: stateEvidence(await readState(targetStatePath)),
      witnessAfter: stateEvidence(await readState(witnessStatePath)),
      targetScreenshotHashBefore: screenshotHash(beforeFocusObservation.screenshot.data),
      targetScreenshotHashAfter: screenshotHash(afterFocusObservation.screenshot.data),
      targetScreenshotHashSame: screenshotHash(beforeFocusObservation.screenshot.data) === screenshotHash(afterFocusObservation.screenshot.data),
      viewportBefore: beforeFocusObservation.viewport,
      viewportAfter: afterFocusObservation.viewport,
      note: "Hash is recorded as evidence only; focus/caret changes are not independently treated as a safety failure.",
    };
    let currentObservation = observationId("side-observation-after-focus");
    const targetInputBeforeActions = await readState(targetStatePath);
    const click = await bounded("adapter click", adapter.execute(adapterSessionDescriptor, { actionId: actionId("side-click"), basedOn: currentObservation, kind: "click", point }, new AbortController().signal));
    const clicked = await waitState(targetStatePath, (state) => (state.eventSequence ?? 0) > (targetInputBeforeActions?.eventSequence ?? 0));
    const witnessAfterClick = await readState(witnessStatePath);
    currentObservation = observationId("side-observation-after-click");
    await bounded("observe after click", adapter.observe(adapterSessionDescriptor, currentObservation, new AbortController().signal));
    const typeText = "Computer-Harness probe EN | 中文输入";
    const type = await bounded("adapter type", adapter.execute(adapterSessionDescriptor, { actionId: actionId("side-type"), basedOn: currentObservation, kind: "type", text: typeText }, new AbortController().signal));
    const typed = await waitState(targetStatePath, (state) => state.containsProbeText === true);
    const witnessAfterType = await readState(witnessStatePath);
    currentObservation = observationId("side-observation-after-type");
    await bounded("observe after type", adapter.observe(adapterSessionDescriptor, currentObservation, new AbortController().signal));
    const beforeScrollTarget = await readState(targetStatePath);
    const beforeScrollWitness = await readState(witnessStatePath);
    const scroll = await bounded("adapter scroll", adapter.execute(adapterSessionDescriptor, { actionId: actionId("side-scroll"), basedOn: currentObservation, kind: "scroll", point, direction: "down", ticks: 1 }, new AbortController().signal));
    const scrolled = scroll.status === "completed" ? await waitState(targetStatePath, (state) => (state.firstVisibleLine ?? 0) > (beforeScrollTarget?.firstVisibleLine ?? 0)) : undefined;
    const afterScrollTarget = await readState(targetStatePath);
    const afterScrollWitness = await readState(witnessStatePath);
    currentObservation = observationId("side-observation-after-scroll");
    await bounded("observe after scroll", adapter.observe(adapterSessionDescriptor, currentObservation, new AbortController().signal));
    const ctrlA = await bounded("adapter ctrl-a", adapter.execute(adapterSessionDescriptor, { actionId: actionId("side-ctrl-a"), basedOn: currentObservation, kind: "keypress", keys: ["CTRL", "A"] }, new AbortController().signal));
    const selected = await waitState(targetStatePath, (state) => (state.selectionLength ?? 0) > 0);
    const witnessAfterCtrlA = await readState(witnessStatePath);
    currentObservation = observationId("side-observation-after-ctrl-a");
    await bounded("observe after ctrl-a", adapter.observe(adapterSessionDescriptor, currentObservation, new AbortController().signal));
    const replacement = await bounded("adapter replacement", adapter.execute(adapterSessionDescriptor, { actionId: actionId("side-replacement"), basedOn: currentObservation, kind: "type", text: "REPLACED" }, new AbortController().signal));
    const replaced = await waitState(targetStatePath, (state) => state.text === "REPLACED" && (state.selectionLength ?? 0) === 0);
    const witnessAfterReplacement = await readState(witnessStatePath);
    currentObservation = observationId("side-observation-after-replacement");
    await bounded("observe after replacement", adapter.observe(adapterSessionDescriptor, currentObservation, new AbortController().signal));
    const beforeDrag = await readState(targetStatePath);
    const drag = await bounded("adapter drag", adapter.execute(adapterSessionDescriptor, { actionId: actionId("side-drag"), basedOn: currentObservation, kind: "drag", from: point, to: { x: point.x + 200, y: point.y + 60 } }, new AbortController().signal));
    const dragged = await waitState(targetStatePath, (state) => (state.dragCount ?? 0) > (beforeDrag?.dragCount ?? 0));
    const witnessAfterDrag = await readState(witnessStatePath);
    const witnessTextBefore = witnessBefore?.text;
    const witnessUnaffected = [witnessAfterClick, witnessAfterType, witnessAfterCtrlA, witnessAfterReplacement, witnessAfterDrag].every((state) => state?.text === witnessTextBefore);
    stages.actions = {
      target: { pid: target.pid, windowId: target.windowId },
      viewport: adapterSessionDescriptor.viewport,
      point,
      click: { receipt: safeReceipt(click), oracle: stateEvidence(clicked), witnessOracle: stateEvidence(witnessAfterClick) },
      type: { textLength: typeText.length, receipt: safeReceipt(type), oracle: stateEvidence(typed), witnessOracle: stateEvidence(witnessAfterType) },
      scroll: {
        receipt: safeReceipt(scroll),
        before: { target: stateEvidence(beforeScrollTarget), witness: stateEvidence(beforeScrollWitness) },
        after: { target: stateEvidence(afterScrollTarget), witness: stateEvidence(afterScrollWitness) },
        oracle: stateEvidence(scrolled),
        targetFirstVisibleLineBefore: beforeScrollTarget?.firstVisibleLine ?? null,
        targetFirstVisibleLineAfter: afterScrollTarget?.firstVisibleLine ?? null,
        witnessFirstVisibleLineBefore: beforeScrollWitness?.firstVisibleLine ?? null,
        witnessFirstVisibleLineAfter: afterScrollWitness?.firstVisibleLine ?? null,
        witnessUnchanged: afterScrollWitness?.firstVisibleLine === beforeScrollWitness?.firstVisibleLine && !hasScrollEvent(afterScrollWitness),
      },
      ctrlA: { receipt: safeReceipt(ctrlA), oracle: stateEvidence(selected), witnessOracle: stateEvidence(witnessAfterCtrlA) },
      replacement: { receipt: safeReceipt(replacement), oracle: stateEvidence(replaced), witnessOracle: stateEvidence(witnessAfterReplacement) },
      drag: { receipt: safeReceipt(drag), before: stateEvidence(beforeDrag), oracle: stateEvidence(dragged), witnessOracle: stateEvidence(witnessAfterDrag) },
      effectChecks: {
        click: clicked !== undefined,
        type: typed?.containsProbeText === true,
        ctrlA: (selected?.selectionLength ?? 0) > 0,
        replacement: replaced?.text === "REPLACED" && (replaced.selectionLength ?? 0) === 0,
        drag: (dragged?.dragCount ?? 0) > (beforeDrag?.dragCount ?? 0),
        witnessTextUnchanged: witnessUnaffected,
      },
    };
    await bounded("adapter close before approval", adapter.close(adapterSessionDescriptor), 5_000);
    adapter = undefined;
    adapterSessionDescriptor = undefined;
    stages.approval = await approvalProbe(options.output, options.socket, target, targetStatePath, witnessStatePath, point);
    const approval = stages.approval as Record<string, unknown>;
    const actionStage = stages.actions as Record<string, unknown>;
    const scrollStage = actionStage.scroll as Record<string, unknown>;
    const scrollReceipt = scrollStage.receipt as Record<string, unknown>;
    const clickReceipt = (actionStage.click as Record<string, unknown>).receipt as Record<string, unknown>;
    const typeReceipt = (actionStage.type as Record<string, unknown>).receipt as Record<string, unknown>;
    const ctrlReceipt = (actionStage.ctrlA as Record<string, unknown>).receipt as Record<string, unknown>;
    const replacementReceipt = (actionStage.replacement as Record<string, unknown>).receipt as Record<string, unknown>;
    const dragReceipt = (actionStage.drag as Record<string, unknown>).receipt as Record<string, unknown>;
    const effectChecks = actionStage.effectChecks as Record<string, unknown>;
    const targetFirstLineBefore = actionStage.targetFirstVisibleLineBefore;
    const targetFirstLineAfter = actionStage.targetFirstVisibleLineAfter;
    safe.ok = Boolean(
      (stages.discovery as Record<string, unknown>).targetPidOwned === true
      && (stages.discovery as Record<string, unknown>).witnessPidOwned === true
      && (stages.discovery as Record<string, unknown>).nonOverlapping === true
      && (stages.discovery as Record<string, unknown>).targetInactiveBefore === true
      && (stages.discovery as Record<string, unknown>).witnessActiveBefore === true
      && adapterSessionDescriptor === undefined
      && clickReceipt.status === "completed"
      && typeReceipt.status === "completed"
      && ctrlReceipt.status === "completed"
      && replacementReceipt.status === "completed"
      && dragReceipt.status === "completed"
      && effectChecks.click === true
      && effectChecks.type === true
      && effectChecks.ctrlA === true
      && effectChecks.replacement === true
      && effectChecks.drag === true
      && effectChecks.witnessTextUnchanged === true
      && scrollReceipt.status === "completed"
      && typeof targetFirstLineBefore === "number"
      && typeof targetFirstLineAfter === "number"
      && targetFirstLineAfter > targetFirstLineBefore
      && (scrollStage.witnessUnchanged as boolean) === true
      && (approval.approvalRequested as boolean) === true
      && (approval.approvalResolved as boolean) === true
      && (approval.actionCompleted as boolean) === true
      && (approval.targetClickObserved as boolean) === true
      && (approval.witnessTextUnchanged as boolean) === true
    );
  } catch (error) {
    safe.ok = false;
    safe.failure = { code: error instanceof Error ? error.name : "unknown", message: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240) };
  } finally {
    if (adapter !== undefined && adapterSessionDescriptor !== undefined) await bounded("adapter cleanup", adapter.close(adapterSessionDescriptor), 5_000).catch(() => undefined);
    if (targetPid !== undefined) { try { process.kill(targetPid); } catch { /* own fixture only */ } }
    if (witnessPid !== undefined) { try { process.kill(witnessPid); } catch { /* own fixture only */ } }
    if (setupDriver !== undefined) {
      if (setupStarted) await bounded("setup end", setupDriver.endSession(EndSessionInput.new({ session: setupSession }), { signal: new AbortController().signal }), 3_000).catch(() => undefined);
      await bounded("setup shutdown", setupDriver.shutdown(), 3_000).catch(() => undefined);
      (setupDriver as unknown as { uniffiDestroy?: () => void }).uniffiDestroy?.();
    }
    const stopped = await runProcess(options.binary, ["stop", "--socket", options.socket]).catch(() => undefined);
    safe.cleanup = { targetPid, witnessPid, daemonStopRequested: true, daemonStopCode: stopped?.code ?? null };
    await writeFile(join(options.output, "side-by-side-window-retest-summary.json"), `${JSON.stringify(safe, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify({ ok: safe.ok === true, output: "<ignored-output>", modelRequests: 0 }, null, 2)}\n`);
  if (safe.ok !== true) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
