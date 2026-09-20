import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { CuaDriver, EndSessionInput, SetWindowFrameInput, StartSessionInput, type CuaDriverLike, type ToolResult } from "@trycua/cua-driver";

type Daemon = ChildProcessByStdio<null, Readable, Readable>;
type Frame = { x: number; y: number; width: number; height: number };
type WindowInfo = { pid: number; windowId: number; bounds?: Frame };
type Mode = "background" | "foreground";
type ScrollBy = "line" | "page";
type CaseName = "uncovered" | "covered";
type CaseSelection = "both" | CaseName;
type State = {
  event?: string | undefined;
  formActive?: boolean | undefined;
  focused?: boolean | undefined;
  eventSequence?: number | undefined;
  text?: string | undefined;
  textLength?: number | undefined;
  containsProbeText?: boolean | undefined;
  selectionLength?: number | undefined;
  firstVisibleLine?: number | undefined;
  lastVisibleLine?: number | undefined;
  dragCount?: number | undefined;
  dragStartX?: number | undefined;
  dragStartY?: number | undefined;
  dragEndX?: number | undefined;
  dragEndY?: number | undefined;
  lastKey?: string | undefined;
  lastModifiers?: string | undefined;
};

interface Options { binary: string; fixture: string; output: string; socket: string; mode: Mode; scrollBy: ScrollBy; caseSelection: CaseSelection; bringTargetFront: boolean; }

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function required(args: readonly string[], name: string): string {
  const value = option(args, name);
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function hasOption(args: readonly string[], name: string): boolean {
  return args.includes(name);
}

function normalizePipe(value: string): string {
  if (process.platform !== "win32") return value;
  const match = value.match(/^\\+\.\\+pipe\\+(.*)$/iu);
  return match?.[1] === undefined ? value : `\\\\.\\pipe\\${match[1].replace(/\\+/gu, "\\")}`;
}

function parseOptions(args: readonly string[]): Options {
  const mode = option(args, "--mode") ?? "background";
  if (mode !== "background" && mode !== "foreground") throw new Error("--mode must be background or foreground");
  const scrollBy = option(args, "--scroll-by") ?? "line";
  if (scrollBy !== "line" && scrollBy !== "page") throw new Error("--scroll-by must be line or page");
  const caseSelection = option(args, "--case") ?? "both";
  if (caseSelection !== "both" && caseSelection !== "uncovered" && caseSelection !== "covered") throw new Error("--case must be both, uncovered, or covered");
  return {
    binary: resolve(required(args, "--binary")),
    fixture: resolve(required(args, "--fixture")),
    output: resolve(required(args, "--output")),
    socket: normalizePipe(required(args, "--socket")),
    mode,
    scrollBy,
    caseSelection,
    bringTargetFront: hasOption(args, "--bring-target-front"),
  };
}

function structured(value: { structuredJson?: string }): Record<string, unknown> | undefined {
  if (typeof value.structuredJson !== "string") return undefined;
  try {
    const parsed = JSON.parse(value.structuredJson) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function numberField(value: unknown, key: string): number | undefined {
  const field = value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function parseState(raw: string): State {
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
    formActive: boolean("formActive"),
    focused: boolean("focused"),
    eventSequence: number("eventSequence"),
    text: values.get("text"),
    textLength: number("textLength"),
    containsProbeText: boolean("containsProbeText"),
    selectionLength: number("selectionLength"),
    firstVisibleLine: number("firstVisibleLine"),
    lastVisibleLine: number("lastVisibleLine"),
    dragCount: number("dragCount"),
    dragStartX: number("dragStartX"),
    dragStartY: number("dragStartY"),
    dragEndX: number("dragEndX"),
    dragEndY: number("dragEndY"),
    lastKey: values.get("lastKey"),
    lastModifiers: values.get("lastModifiers"),
  };
}

async function readState(path: string): Promise<State | undefined> {
  const raw = await readFile(path, "utf8").catch(() => undefined);
  return raw === undefined ? undefined : parseState(raw);
}

async function waitState(path: string, predicate: (state: State) => boolean, timeoutMs = 8_000): Promise<State | undefined> {
  const deadline = Date.now() + timeoutMs;
  let latest: State | undefined;
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
    return x === undefined || y === undefined || width === undefined || height === undefined
      ? []
      : [{ pid, windowId, bounds: { x, y, width, height } }];
  });
}

async function waitWindow(driver: CuaDriverLike, pid: number): Promise<WindowInfo> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const windows = windowsFrom(await call(driver, "list_windows", { pid, on_screen_only: true }));
    const match = windows.find((window) => window.pid === pid && window.bounds !== undefined);
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
    action: action === undefined ? null : {
      effect: String(action.effect),
      route: String(action.route),
      delivery: action.delivery === undefined ? null : {
        mode: String(action.delivery.mode),
        deliveredCount: action.delivery.deliveredCount ?? null,
      },
    },
  };
}

function stateEvidence(state: State | undefined): Record<string, unknown> | null {
  if (state === undefined) return null;
  return {
    event: state.event ?? null,
    eventSequence: state.eventSequence ?? null,
    formActive: state.formActive ?? null,
    focused: state.focused ?? null,
    firstVisibleLine: state.firstVisibleLine ?? null,
    lastVisibleLine: state.lastVisibleLine ?? null,
    textLength: state.textLength ?? null,
    containsProbeText: state.containsProbeText ?? null,
    selectionLength: state.selectionLength ?? null,
    dragCount: state.dragCount ?? null,
    dragStartX: state.dragStartX ?? null,
    dragStartY: state.dragStartY ?? null,
    dragEndX: state.dragEndX ?? null,
    dragEndY: state.dragEndY ?? null,
    lastKey: state.lastKey ?? null,
    lastModifiers: state.lastModifiers ?? null,
  };
}

function isScrollEvent(state: State | undefined): boolean {
  return state?.event === "v_scroll" || state?.event === "v_scroll_settled";
}

function lineDelta(after: State | undefined, before: State | undefined): number | null {
  if (after?.firstVisibleLine === undefined || before?.firstVisibleLine === undefined) return null;
  return after.firstVisibleLine - before.firstVisibleLine;
}

function pointInside(point: { x: number; y: number }, bounds: Frame | undefined): boolean {
  return bounds !== undefined
    && point.x >= bounds.x
    && point.x < bounds.x + bounds.width
    && point.y >= bounds.y
    && point.y < bounds.y + bounds.height;
}

function targetPoint(bounds: Frame | undefined): { x: number; y: number } {
  // CUA 0.22.2's window-target contract is window-local screenshot pixels.
  // Keep this in the editor body rather than using the outer-frame centre: the
  // latter is deliberately covered in the overlap case below.
  const viewportWidth = Math.max(1, (bounds?.width ?? 960) - 2);
  const viewportHeight = Math.max(1, (bounds?.height ?? 680) - 2);
  return {
    x: Math.min(120, Math.max(24, viewportWidth - 24)),
    y: Math.min(120, Math.max(48, viewportHeight - 48)),
  };
}

function uncoveredWitnessFrame(target: Frame | undefined): Frame {
  return {
    x: (target?.x ?? 240) + (target?.width ?? 960) + 80,
    y: target?.y ?? 180,
    width: 700,
    height: 450,
  };
}

function coveredWitnessFrame(target: Frame | undefined, point: { x: number; y: number }): Frame {
  return {
    x: (target?.x ?? 240) + point.x - 100,
    y: (target?.y ?? 180) + point.y - 80,
    width: 700,
    height: 450,
  };
}

async function waitForScrollOutcome(
  targetPath: string,
  witnessPath: string,
  targetBefore: State | undefined,
  witnessBefore: State | undefined,
  timeoutMs = 8_000,
): Promise<{ target: State | undefined; witness: State | undefined }> {
  const deadline = Date.now() + timeoutMs;
  let target: State | undefined;
  let witness: State | undefined;
  while (Date.now() < deadline) {
    target = await readState(targetPath);
    witness = await readState(witnessPath);
    const targetDelta = lineDelta(target, targetBefore);
    const witnessDelta = lineDelta(witness, witnessBefore);
    const targetEvent = isScrollEvent(target) && (target?.eventSequence ?? 0) > (targetBefore?.eventSequence ?? 0);
    const witnessEvent = isScrollEvent(witness) && (witness?.eventSequence ?? 0) > (witnessBefore?.eventSequence ?? 0);
    if ((targetDelta !== null && targetDelta > 0) || (witnessDelta !== null && witnessDelta !== 0) || targetEvent || witnessEvent) {
      // Give a deferred VScroll sample one UI turn to settle before recording
      // the twin oracles; no additional action is sent during this interval.
      await new Promise((done) => setTimeout(done, 150));
      return { target: await readState(targetPath), witness: await readState(witnessPath) };
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  return { target, witness };
}

async function killFixture(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  try { process.kill(pid); } catch { /* own fixture only */ }
}

async function runCase(
  driver: CuaDriverLike,
  options: Options,
  session: string,
  caseName: CaseName,
  output: string,
): Promise<Record<string, unknown>> {
  await mkdir(output, { recursive: true });
  const targetStatePath = join(output, "target-state.txt");
  const witnessStatePath = join(output, "witness-state.txt");
  const targetFrame: Frame = { x: 240, y: 180, width: 960, height: 680 };
  const safe: Record<string, unknown> = { case: caseName, ok: false, targetPidOwned: false, witnessPidOwned: false, actions: {} };
  let targetPid: number | undefined;
  let witnessPid: number | undefined;
  try {
    const targetLaunch = await bounded("target launch", call(driver, "launch_app", {
      path: options.fixture,
      additional_arguments: [targetStatePath, `matrix-${caseName}-target`, `DEV2 MATRIX ${caseName.toUpperCase()} TARGET`, String(targetFrame.x), String(targetFrame.y), String(targetFrame.width), String(targetFrame.height), "preload"],
      start_minimized: false,
      session,
    }));
    targetPid = numberField(structured(targetLaunch), "pid");
    if (targetPid === undefined || targetLaunch.isError) throw new Error(`${caseName} target launch failed`);
    let target = await waitWindow(driver, targetPid);
    await bounded("target frame", setFrame(driver, target, targetFrame, session));
    target = await waitWindow(driver, targetPid);

    const point = targetPoint(target.bounds);
    const initialWitnessFrame = uncoveredWitnessFrame(target.bounds);
    const witnessLaunch = await bounded("witness launch", call(driver, "launch_app", {
      path: options.fixture,
      additional_arguments: [witnessStatePath, `matrix-${caseName}-witness`, `DEV2 MATRIX ${caseName.toUpperCase()} WITNESS`, String(initialWitnessFrame.x), String(initialWitnessFrame.y), String(initialWitnessFrame.width), String(initialWitnessFrame.height)],
      start_minimized: false,
      session,
    }));
    witnessPid = numberField(structured(witnessLaunch), "pid");
    if (witnessPid === undefined || witnessLaunch.isError) throw new Error(`${caseName} witness launch failed`);
    let witness = await waitWindow(driver, witnessPid);
    await bounded("witness initial frame", setFrame(driver, witness, initialWitnessFrame, session));
    witness = await waitWindow(driver, witnessPid);

    const overlapFrame = coveredWitnessFrame(target.bounds, point);
    if (caseName === "covered") {
      await bounded("witness overlap frame", setFrame(driver, witness, overlapFrame, session));
      witness = await waitWindow(driver, witnessPid);
    }
    const witnessFront = await bounded("witness foreground", call(driver, "bring_to_front", { pid: witness.pid, window_id: witness.windowId, session }));
    const witnessBefore = await waitState(witnessStatePath, (state) => state.formActive === true);
    const targetBefore = await waitState(targetStatePath, (state) => state.formActive === false);
    const targetInput = { kind: "window" as const, pid: target.pid, window_id: target.windowId };
    const desktopPoint = {
      x: (target.bounds?.x ?? targetFrame.x) + point.x,
      y: (target.bounds?.y ?? targetFrame.y) + point.y,
    };
    const witnessCoversPoint = pointInside(desktopPoint, witness.bounds);
    const mode = options.mode;
    const actions = safe.actions as Record<string, unknown>;

    safe.targetPidOwned = target.pid === targetPid;
    safe.witnessPidOwned = witness.pid === witnessPid;
    safe.discovery = {
      targetPid: target.pid,
      witnessPid: witness.pid,
      targetWindowId: target.windowId,
      witnessWindowId: witness.windowId,
      targetBounds: target.bounds,
      witnessBounds: witness.bounds,
      targetFrameRequested: targetFrame,
      witnessFrameRequested: caseName === "covered" ? overlapFrame : initialWitnessFrame,
      witnessFront: safeTool(witnessFront),
      targetInactiveBefore: targetBefore?.formActive === false,
      witnessActiveBefore: witnessBefore?.formActive === true,
      coordinateContract: "window-local screenshot pixels (CUA 0.22.2 scroll x/y with pid/window_id)",
      estimatedClientViewport: { width: Math.max(0, (target.bounds?.width ?? targetFrame.width) - 2), height: Math.max(0, (target.bounds?.height ?? targetFrame.height) - 2) },
      targetPoint: point,
      desktopPoint,
      witnessCoversPoint,
    };

    const beforeClick = await readState(targetStatePath);
    const click = await bounded("click", call(driver, "click", { session, target: targetInput, x: point.x, y: point.y, delivery_mode: mode }));
    const clicked = await waitState(targetStatePath, (state) => (state.eventSequence ?? 0) > (beforeClick?.eventSequence ?? 0));
    actions.click = { receipt: safeTool(click), oracle: stateEvidence(clicked), observedCSharpClientPoint: clicked === undefined ? null : { x: clicked.dragStartX ?? null, y: clicked.dragStartY ?? null } };

    if (caseName === "uncovered") {
      const type = await bounded("type", call(driver, "type_text", { session, target: targetInput, text: "Computer-Harness probe EN | 中文输入", delivery_mode: mode }));
      const typed = await waitState(targetStatePath, (state) => state.containsProbeText === true);
      actions.type = { receipt: safeTool(type), oracle: stateEvidence(typed) };
    }

    let targetFrontVerified = false;
    if (caseName === "covered" && options.bringTargetFront) {
      const beforeTargetFront = await readState(targetStatePath);
      const beforeWitnessFront = await readState(witnessStatePath);
      const targetFront = await bounded("target foreground", call(driver, "bring_to_front", { pid: target.pid, window_id: target.windowId, session }));
      const targetAfterFront = await waitState(targetStatePath, (state) => state.formActive === true && (state.eventSequence ?? 0) > (beforeTargetFront?.eventSequence ?? 0));
      const witnessAfterFront = await waitState(witnessStatePath, (state) => state.formActive === false && (state.eventSequence ?? 0) > (beforeWitnessFront?.eventSequence ?? 0));
      targetFrontVerified = targetAfterFront?.formActive === true && witnessAfterFront?.formActive === false;
      actions.targetFront = {
        request: { pid: target.pid, window_id: target.windowId },
        receipt: safeTool(targetFront),
        targetBefore: stateEvidence(beforeTargetFront),
        targetAfter: stateEvidence(targetAfterFront),
        witnessBefore: stateEvidence(beforeWitnessFront),
        witnessAfter: stateEvidence(witnessAfterFront),
        verified: targetFrontVerified,
      };
      if (!targetFrontVerified) {
        safe.ok = false;
        safe.failure = { code: "target_front_unverified", message: "target foreground oracle did not become active while witness became inactive; scroll was refused" };
        safe.result = { expectation: "verify target active and witness inactive before sending covered scroll", targetFrontVerified: false, scrollSkipped: true };
        return safe;
      }
    }

    const beforeScrollTarget = await readState(targetStatePath);
    const beforeScrollWitness = await readState(witnessStatePath);
    const scroll = await bounded("scroll", call(driver, "scroll", {
      session,
      target: targetInput,
      x: point.x,
      y: point.y,
      direction: "down",
      by: options.scrollBy,
      amount: 1,
      delivery_mode: mode,
    }));
    const scrollAfter = await waitForScrollOutcome(targetStatePath, witnessStatePath, beforeScrollTarget, beforeScrollWitness);
    const afterScrollTarget = scrollAfter.target;
    const afterScrollWitness = scrollAfter.witness;
    const targetScrollDelta = lineDelta(afterScrollTarget, beforeScrollTarget);
    const witnessScrollDelta = lineDelta(afterScrollWitness, beforeScrollWitness);
    const targetScrollEvent = isScrollEvent(afterScrollTarget) && (afterScrollTarget?.eventSequence ?? 0) > (beforeScrollTarget?.eventSequence ?? 0);
    const witnessScrollEvent = isScrollEvent(afterScrollWitness) && (afterScrollWitness?.eventSequence ?? 0) > (beforeScrollWitness?.eventSequence ?? 0);
    actions.scroll = {
      request: { target: targetInput, x: point.x, y: point.y, direction: "down", by: options.scrollBy, amount: 1, delivery_mode: mode },
      receipt: safeTool(scroll),
      before: { target: stateEvidence(beforeScrollTarget), witness: stateEvidence(beforeScrollWitness) },
      after: { target: stateEvidence(afterScrollTarget), witness: stateEvidence(afterScrollWitness) },
      targetScrollDelta,
      witnessScrollDelta,
      targetScrollEvent,
      witnessScrollEvent,
      targetFocusAfter: afterScrollTarget?.focused ?? null,
      targetActiveAfter: afterScrollTarget?.formActive ?? null,
      witnessFocusAfter: afterScrollWitness?.focused ?? null,
      witnessActiveAfter: afterScrollWitness?.formActive ?? null,
    };

    let replacementOk = true;
    if (caseName === "uncovered") {
      const beforeCtrlA = await readState(targetStatePath);
      const ctrlA = await bounded("ctrl-a", call(driver, "hotkey", { session, target: targetInput, keys: ["CTRL", "A"], delivery_mode: mode }));
      const selected = await waitState(targetStatePath, (state) => (state.eventSequence ?? 0) > (beforeCtrlA?.eventSequence ?? 0) && (state.selectionLength ?? 0) > 0);
      const replacement = await bounded("replacement type", call(driver, "type_text", { session, target: targetInput, text: "REPLACED", delivery_mode: mode }));
      const replaced = await waitState(targetStatePath, (state) => state.text === "REPLACED" && (state.selectionLength ?? 0) === 0);
      replacementOk = replaced?.text === "REPLACED" && (replaced.selectionLength ?? 0) === 0;
      actions.ctrlA = { receipt: safeTool(ctrlA), oracle: stateEvidence(selected) };
      actions.replacement = { receipt: safeTool(replacement), oracle: stateEvidence(replaced) };

      const beforeDrag = await readState(targetStatePath);
      const drag = await bounded("drag", call(driver, "drag", {
        session,
        target: targetInput,
        from_x: point.x,
        from_y: point.y,
        to_x: point.x + 200,
        to_y: point.y + 60,
        delivery_mode: mode,
      }));
      const dragged = await waitState(targetStatePath, (state) => (state.dragCount ?? 0) > (beforeDrag?.dragCount ?? 0));
      actions.drag = { receipt: safeTool(drag), before: stateEvidence(beforeDrag), oracle: stateEvidence(dragged) };
    }

    const targetAfter = await readState(targetStatePath);
    const witnessAfter = await readState(witnessStatePath);
    const scrollOk = targetScrollDelta !== null && targetScrollDelta > 0 && !witnessScrollEvent && (witnessScrollDelta === null || witnessScrollDelta === 0);
    safe.ok = caseName === "uncovered" ? scrollOk && replacementOk : scrollOk && (!options.bringTargetFront || targetFrontVerified);
    safe.result = {
      expectation: caseName === "uncovered"
        ? "target scrolls at safe point before Ctrl+A/replacement; replacement remains exact"
        : "target scrolls at the same point while witness covers it; any witness scroll event is a failure",
      targetScrollOk: scrollOk,
      targetFrontVerified: options.bringTargetFront ? targetFrontVerified : null,
      witnessUntouched: !witnessScrollEvent && (witnessScrollDelta === null || witnessScrollDelta === 0),
      replacementOk,
    };
    safe.after = { target: stateEvidence(targetAfter), witness: stateEvidence(witnessAfter) };
  } catch (error) {
    safe.ok = false;
    safe.failure = { code: error instanceof Error ? error.name : "unknown", message: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240) };
  } finally {
    await killFixture(targetPid);
    await killFixture(witnessPid);
    safe.cleanup = { targetPid, witnessPid, fixtureKillRequested: targetPid !== undefined || witnessPid !== undefined };
  }
  return safe;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  await mkdir(options.output, { recursive: true });
  const setupSession = `window-matrix-${options.mode}-dual-case`;
  const safe: Record<string, unknown> = {
    probeVersion: "dev2-window-action-matrix-retest-0.2.0",
    daemonVersion: "0.22.2",
    mode: options.mode,
    scrollBy: options.scrollBy,
    caseSelection: options.caseSelection,
    bringTargetFront: options.bringTargetFront,
    interferenceFreeClaim: true,
    modelRequests: 0,
    userWindowTouched: false,
    cases: {},
    ok: false,
  };
  const daemon = spawn(options.binary, ["serve", "--socket", options.socket, "--no-overlay"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }) as Daemon;
  let driver: CuaDriverLike | undefined;
  let started = false;
  try {
    await waitDaemon(options.binary, options.socket, daemon);
    driver = CuaDriver.connect(options.socket);
    await bounded("setup start", driver.startSession(StartSessionInput.new({ session: setupSession }), { signal: new AbortController().signal }));
    started = true;
    const cases = safe.cases as Record<string, unknown>;
    const caseNames: CaseName[] = options.caseSelection === "both" ? ["uncovered", "covered"] : [options.caseSelection];
    for (const caseName of caseNames) {
      cases[caseName] = await runCase(driver, options, setupSession, caseName, join(options.output, `case-${caseName}`));
    }
    safe.ok = caseNames.every((caseName) => (cases[caseName] as Record<string, unknown>).ok === true);
  } catch (error) {
    safe.ok = false;
    safe.failure = { code: error instanceof Error ? error.name : "unknown", message: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240) };
  } finally {
    if (driver !== undefined && started) await bounded("setup end", driver.endSession(EndSessionInput.new({ session: setupSession }), { signal: new AbortController().signal }), 3_000).catch(() => undefined);
    if (driver !== undefined) await bounded("setup shutdown", driver.shutdown(), 3_000).catch(() => undefined);
    if (driver !== undefined) (driver as unknown as { uniffiDestroy?: () => void }).uniffiDestroy?.();
    const stopped = await runProcess(options.binary, ["stop", "--socket", options.socket]).catch(() => undefined);
    safe.cleanup = { daemonStopRequested: true, daemonStopCode: stopped?.code ?? null };
    await writeFile(join(options.output, "window-action-matrix-summary.json"), `${JSON.stringify(safe, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify({ ok: safe.ok === true, output: "<ignored-output>" }, null, 2)}\n`);
  if (safe.ok !== true) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
