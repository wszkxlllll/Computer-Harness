import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CuaDriver, EndSessionInput, StartSessionInput, type CuaDriverLike, type ToolResult } from "@trycua/cua-driver-0.22.2";
import { CuaDriverComputer } from "@computer-harness/computer-cua";
import { groundingComputerTools } from "@computer-harness/runtime";
import type { ActionIntent, GroundingCatalog, ObservationFrame, ObservationId, RunId, Viewport } from "@computer-harness/protocol";

type JsonObject = Record<string, unknown>;
type Frame = { x: number; y: number; width: number; height: number };

interface Options {
  binary: string;
  output: string;
  socket: string;
  session: string;
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
    output: resolve(required(args, "--output")),
    socket: normalizePipe(required(args, "--socket")),
    session: option(args, "--session") ?? "uia-grounding-production",
  };
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function structured(result: ToolResult): JsonObject | undefined {
  if (typeof result.structuredJson !== "string") return undefined;
  try { return object(JSON.parse(result.structuredJson)); } catch { return undefined; }
}

function number(value: unknown, key: string): number | undefined {
  const candidate = object(value)?.[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function frame(value: unknown): Frame | undefined {
  const record = object(value);
  if (record === undefined) return undefined;
  const x = number(record, "x");
  const y = number(record, "y");
  const width = number(record, "width") ?? number(record, "w");
  const height = number(record, "height") ?? number(record, "h");
  return x === undefined || y === undefined || width === undefined || height === undefined
    ? undefined
    : { x, y, width, height };
}

function windows(result: ToolResult): Array<{ pid: number; windowId: number; bounds?: Frame }> {
  const values = structured(result)?.windows;
  if (!Array.isArray(values)) return [];
  return values.flatMap((candidate) => {
    const pid = number(candidate, "pid");
    const windowId = number(candidate, "window_id");
    if (pid === undefined || windowId === undefined || !Number.isInteger(pid) || !Number.isInteger(windowId)) return [];
    const bounds = frame(object(candidate)?.bounds);
    return [{ pid, windowId, ...(bounds === undefined ? {} : { bounds }) }];
  });
}

function resultShape(result: ToolResult): JsonObject {
  const value = structured(result);
  return {
    isError: result.isError,
    degraded: result.degraded,
    errorCode: result.errorCode ?? null,
    imageCount: result.images.length,
    structuredFields: value === undefined ? [] : Object.keys(value).sort(),
  };
}

function summarizeCatalog(catalog: GroundingCatalog | undefined): JsonObject {
  if (catalog === undefined) return { present: false };
  const roleCounts: Record<string, number> = {};
  for (const element of catalog.elements) roleCounts[element.role] = (roleCounts[element.role] ?? 0) + 1;
  return {
    present: true,
    completeness: catalog.completeness,
    degraded: catalog.degraded,
    maxElements: catalog.maxElements,
    elementCount: catalog.elements.length,
    roleCounts,
    refs: catalog.elements.map((element) => ({
      refShape: /^uia-[0-9a-f]{12}-\d+$/u.test(element.elementRef),
      role: element.role,
      namePresent: element.name !== undefined,
      nameLength: element.name?.length ?? 0,
      bboxPresent: element.bbox !== undefined,
      stateKeys: element.state === undefined ? [] : Object.keys(element.state).sort(),
    })),
  };
}

function readOracle(text: string): { clicked: boolean; focused: boolean } {
  const entries = new Map(text.split(/\r?\n/u).flatMap((line) => {
    const separator = line.indexOf("=");
    return separator <= 0 ? [] : [[line.slice(0, separator), line.slice(separator + 1)]] as const;
  }));
  return { clicked: entries.get("clicked") === "True", focused: entries.get("focused") === "True" };
}

async function runCli(file: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((done, reject) => {
    execFile(file, args, { windowsHide: true, encoding: "utf8", timeout: 10_000 }, (error, stdout, stderr) => {
      if (error !== null && (error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
        done({ code: null, stdout: String(stdout), stderr: String(stderr) });
        return;
      }
      done({ code: error === null ? 0 : typeof error.code === "number" ? error.code : null, stdout: String(stdout), stderr: String(stderr) });
    }).once("error", reject);
  });
}

async function waitForDaemon(binary: string, socket: string, daemon: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (daemon.exitCode !== null || daemon.signalCode !== null) throw new Error("private daemon exited before readiness");
    const status = await runCli(binary, ["status", "--socket", socket]);
    if (status.code === 0 && /daemon is running/iu.test(status.stdout)) return;
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error("private daemon readiness timeout");
}

async function waitForWindow(driver: CuaDriverLike, pid: number, session: string): Promise<{ pid: number; windowId: number; bounds?: Frame }> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const listed = await driver.callTool("list_windows", JSON.stringify({ pid, on_screen_only: true, session }));
    const match = windows(listed).find((candidate) => candidate.pid === pid && candidate.windowId > 0);
    if (match !== undefined) return match;
    await new Promise((done) => setTimeout(done, 150));
  }
  throw new Error("owned UIA grounding fixture window was not discoverable");
}

async function compileFixture(output: string): Promise<string> {
  const executable = join(output, "uia-grounding-fixture.exe");
  const source = fileURLToPath(new URL("./fixture/UiaGroundingFixture.cs", import.meta.url));
  const compiler = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
  const result = await runCli(compiler, [
    "/nologo", "/target:winexe", `/out:${executable}`,
    "/reference:System.dll", "/reference:System.Drawing.dll", "/reference:System.Windows.Forms.dll", source,
  ]);
  if (result.code !== 0) throw new Error(`UIA grounding fixture compilation failed: ${result.stderr || result.stdout}`);
  return executable;
}

function observationFrame(
  runId: RunId,
  observationId: ObservationId,
  session: { id: string },
  capture: { capturedAt: string; viewport: Viewport; grounding?: GroundingCatalog },
): ObservationFrame {
  return {
    id: observationId,
    runId,
    computerSessionId: session.id as ObservationFrame["computerSessionId"],
    capturedAt: capture.capturedAt,
    viewport: capture.viewport,
    screenshot: { assetId: `${String(observationId)}-asset` as ObservationFrame["screenshot"]["assetId"], relativePath: `screenshots/${String(observationId)}.png`, mediaType: "image/png", byteLength: 1 },
    ...(capture.grounding === undefined ? {} : { grounding: capture.grounding }),
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  await mkdir(options.output, { recursive: true });
  const fixture = await compileFixture(options.output);
  const fixtureStatePath = join(options.output, "fixture-state.txt");
  const daemon = spawn(options.binary, ["serve", "--socket", options.socket, "--no-overlay"], { windowsHide: true, stdio: "ignore" });
  const report: JsonObject = {
    probeVersion: "uia-grounding-production-0.1.0",
    daemonVersion: "0.22.2",
    modelRequests: 0,
    userWindowTouched: false,
    screenshotsPersisted: false,
    productionActionCount: 0,
    setupToolCalls: [] as string[],
    productionCatalog: {},
    stale: {},
    disabled: {},
    oracle: {},
  };
  let setupDriver: CuaDriverLike | undefined;
  let setupSessionStarted = false;
  let fixturePid: number | undefined;
  let fixtureProcess: ChildProcess | undefined;
  let productionComputer: CuaDriverComputer | undefined;
  let productionSession: Awaited<ReturnType<CuaDriverComputer["open"]>> | undefined;
  try {
    await waitForDaemon(options.binary, options.socket, daemon);
    setupDriver = CuaDriver.connect(options.socket);
    await setupDriver.startSession(StartSessionInput.new({ session: `${options.session}-setup` }));
    setupSessionStarted = true;
    // Launch the owned fixture as a normal process instead of through launch_app.
    // The latter can scope the process/window to the setup CUA session, which
    // makes it invisible to the production CuaDriverComputer session we need to
    // exercise here.
    fixtureProcess = spawn(fixture, [fixtureStatePath], { windowsHide: true, stdio: "ignore" });
    fixturePid = fixtureProcess.pid;
    if (fixturePid === undefined) throw new Error("UIA grounding fixture process did not start");
    (report.setupToolCalls as string[]).push("spawn_fixture");
    const target = await waitForWindow(setupDriver, fixturePid, `${options.session}-setup`);
    (report.setupToolCalls as string[]).push("list_windows");
    await setupDriver.callTool("bring_to_front", JSON.stringify({ pid: fixturePid, window_id: target.windowId, session: `${options.session}-setup` }));
    (report.setupToolCalls as string[]).push("bring_to_front");
    // Confirm that the target is visible from an independent CUA session too.
    // This keeps a session-scoped list_windows regression distinguishable from
    // a production adapter/window-contract failure without persisting identity.
    const discoveryDriver = CuaDriver.connect(options.socket);
    const discoverySession = `${options.session}-discovery`;
    await discoveryDriver.startSession(StartSessionInput.new({ session: discoverySession }));
    try {
      const discovered = windows(await discoveryDriver.callTool("list_windows", JSON.stringify({
        on_screen_only: true,
        pid: fixturePid,
        session: discoverySession,
      })));
      report.productionDiscovery = {
        windowCount: discovered.length,
        matchingPidCount: discovered.filter((candidate) => candidate.pid === fixturePid).length,
        matchingTargetCount: discovered.filter((candidate) => candidate.pid === fixturePid && candidate.windowId === target.windowId).length,
      };
      console.log(JSON.stringify({ productionDiscovery: report.productionDiscovery }, null, 2));
    } finally {
      await discoveryDriver.endSession(EndSessionInput.new({ session: discoverySession })).catch(() => undefined);
      await discoveryDriver.shutdown().catch(() => undefined);
      (discoveryDriver as unknown as { uniffiDestroy?: () => void }).uniffiDestroy?.();
    }
    let productionDriver: CuaDriverLike | undefined;
    productionComputer = new CuaDriverComputer({
      socketPath: options.socket,
      screenshotDir: join(options.output, "driver-screenshots"),
      sessionLabel: `${options.session}-production`,
      windowTarget: { pid: fixturePid, windowId: target.windowId },
      windowDeliveryMode: "foreground",
      grounding: "uia-catalog-v1",
      driverFactory: (socketPath) => {
        productionDriver = CuaDriver.connect(socketPath);
        const driver = productionDriver;
        const callTool = driver.callTool.bind(driver) as unknown as (name: string, input: string, callOptions?: { signal: AbortSignal }) => Promise<ToolResult>;
        driver.callTool = async (name: string, input: string, callOptions?: { signal: AbortSignal }) => {
          const result = await callTool(name, input, callOptions);
          if (name === "list_windows") {
            const listed = windows(result);
            console.log(JSON.stringify({ productionListWindows: { count: listed.length, targetCount: listed.filter((candidate) => candidate.pid === fixturePid && candidate.windowId === target.windowId).length } }, null, 2));
          }
          return result;
        };
        return driver as unknown as import("@computer-harness/computer-cua").CuaDriverLike;
      },
    });
    productionSession = await productionComputer.open({}, new AbortController().signal);
    const postOpenDriver = CuaDriver.connect(options.socket);
    const postOpenSession = `${options.session}-post-open`;
    await postOpenDriver.startSession(StartSessionInput.new({ session: postOpenSession }));
    try {
      const postOpenWindows = windows(await postOpenDriver.callTool("list_windows", JSON.stringify({
        on_screen_only: true,
        pid: fixturePid,
        session: postOpenSession,
      })));
      console.log(JSON.stringify({ postOpenWindowCount: postOpenWindows.length, postOpenTargetCount: postOpenWindows.filter((candidate) => candidate.pid === fixturePid && candidate.windowId === target.windowId).length }, null, 2));
    } finally {
      await postOpenDriver.endSession(EndSessionInput.new({ session: postOpenSession })).catch(() => undefined);
      await postOpenDriver.shutdown().catch(() => undefined);
      (postOpenDriver as unknown as { uniffiDestroy?: () => void }).uniffiDestroy?.();
    }
    const runId = "uia-grounding-production-run" as RunId;
    const firstObservationId = "uia-production-observation-1" as ObservationId;
    const firstCapture = await productionComputer.observe(productionSession, firstObservationId, new AbortController().signal);
    const firstFrame = observationFrame(runId, firstObservationId, productionSession, firstCapture);
    const catalog = firstCapture.grounding;
    if (catalog === undefined) throw new Error("production CUA observation did not return a grounding catalog");
    const buttons = catalog.elements.filter((element) => element.role.toLowerCase().includes("button"));
    // The fixture's top-level title-bar close control is also exposed as a
    // Button. Select the owned content control rather than that chrome control.
    const enabledButton = buttons.find((element) => element.state?.enabled !== false && (element.bbox?.y ?? 0) > 50);
    const disabledElement = catalog.elements.find((element) => element.state?.enabled === false);
    if (enabledButton === undefined) {
      throw new Error(`production UIA catalog did not expose an enabled button: ${JSON.stringify({ catalog: summarizeCatalog(catalog), buttonStates: buttons.map((element) => element.state?.enabled ?? null) })}`);
    }
    const tool = groundingComputerTools()[0];
    if (tool === undefined || tool.category !== "computer") throw new Error("click_element tool definition unavailable");
    const action = tool.toAction({ elementRef: enabledButton.elementRef }, {
      runId,
      session: productionSession,
      observation: firstFrame,
      signal: new AbortController().signal,
    });
    console.log(JSON.stringify({
      productionViewport: productionSession.viewport,
      selectedBbox: enabledButton.bbox,
      selectedPoint: action.kind === "click" ? action.point : null,
    }, null, 2));
    const receipt = await productionComputer.execute(productionSession, {
      ...action,
      actionId: "uia-production-click" as ActionIntent["actionId"],
      basedOn: firstObservationId,
    } as ActionIntent, new AbortController().signal);
    report.productionActionCount = 1;
    const oracleDeadline = Date.now() + 5_000;
    let oracle = readOracle(await readFile(fixtureStatePath, "utf8").catch(() => ""));
    while (!oracle.clicked && Date.now() < oracleDeadline) {
      await new Promise((done) => setTimeout(done, 100));
      oracle = readOracle(await readFile(fixtureStatePath, "utf8").catch(() => ""));
    }
    const secondObservationId = "uia-production-observation-2" as ObservationId;
    let secondCapture;
    try {
      secondCapture = await productionComputer.observe(productionSession, secondObservationId, new AbortController().signal);
    } catch (error) {
      const afterActionWindows = windows(await setupDriver.callTool("list_windows", JSON.stringify({
        on_screen_only: true,
        pid: fixturePid,
        session: `${options.session}-setup`,
      })));
      console.log(JSON.stringify({
        afterActionWindowCount: afterActionWindows.length,
        afterActionTargetCount: afterActionWindows.filter((candidate) => candidate.pid === fixturePid && candidate.windowId === target.windowId).length,
        fixtureExitCode: fixtureProcess?.exitCode ?? null,
        fixtureSignal: fixtureProcess?.signalCode ?? null,
      }, null, 2));
      throw error;
    }
    const secondButton = secondCapture.grounding?.elements.find((element) => element.role.toLowerCase().includes("button") && element.state?.enabled !== false);
    const staleReceipt = await productionComputer.execute(productionSession, {
      ...action,
      actionId: "uia-production-stale" as ActionIntent["actionId"],
      basedOn: firstObservationId,
    } as ActionIntent, new AbortController().signal);
    const disabledBbox = disabledElement?.bbox;
    const disabledPoint = disabledBbox === undefined
      ? undefined
      : { x: disabledBbox.x + disabledBbox.width / 2, y: disabledBbox.y + disabledBbox.height / 2 };
    const disabledReceipt = disabledPoint === undefined
      ? undefined
      : await productionComputer.execute(productionSession, {
          actionId: "uia-production-disabled" as ActionIntent["actionId"],
          basedOn: secondObservationId,
          kind: "click",
          point: disabledPoint,
          groundingRef: secondCapture.grounding?.elements.find((element) => element.state?.enabled === false)?.elementRef ?? disabledElement?.elementRef ?? "",
        }, new AbortController().signal);
    report.productionCatalog = {
      sessionViewport: productionSession.viewport,
      first: summarizeCatalog(catalog),
      second: summarizeCatalog(secondCapture.grounding),
      selectedEnabledRefChanged: secondButton?.elementRef !== enabledButton.elementRef,
      selectedEnabledRole: enabledButton.role,
      selectedEnabledBboxPresent: enabledButton.bbox !== undefined,
      receipt: { status: receipt.status, driverCode: receipt.driverCode ?? null },
    };
    report.oracle = { clicked: oracle.clicked, focused: oracle.focused };
    report.stale = {
      oldRef: enabledButton.elementRef,
      newRef: secondButton?.elementRef ?? null,
      refChanged: secondButton?.elementRef !== enabledButton.elementRef,
      receipt: { status: staleReceipt.status, driverCode: staleReceipt.driverCode ?? null },
    };
    report.disabled = {
      refPresent: disabledElement !== undefined,
      stateEnabled: disabledElement?.state?.enabled ?? null,
      receipt: disabledReceipt === undefined ? null : { status: disabledReceipt.status, driverCode: disabledReceipt.driverCode ?? null },
      reason: disabledElement === undefined ? "real get_window_state did not expose an element with enabled=false" : null,
    };
    const coreOk = receipt.status === "completed"
      && oracle.clicked
      && staleReceipt.status === "refused"
      && staleReceipt.driverCode === "STALE_OBSERVATION"
      && secondButton?.elementRef !== enabledButton.elementRef;
    const disabledVerified = disabledReceipt !== undefined
      && disabledReceipt.status === "refused"
      && disabledReceipt.driverCode === "GROUNDING_ELEMENT_DISABLED";
    report.validation = { coreOk, disabledVerified, complete: coreOk && disabledVerified };
    report.ok = coreOk && disabledVerified;
  } finally {
    if (productionComputer !== undefined && productionSession !== undefined) await productionComputer.close(productionSession).catch(() => undefined);
    if (setupDriver !== undefined) {
      if (setupSessionStarted) await setupDriver.endSession(EndSessionInput.new({ session: `${options.session}-setup` })).catch(() => undefined);
      await setupDriver.shutdown().catch(() => undefined);
      (setupDriver as unknown as { uniffiDestroy?: () => void }).uniffiDestroy?.();
    }
    if (fixturePid !== undefined) {
      try { process.kill(fixturePid); } catch { }
    }
    if (fixtureProcess !== undefined && fixtureProcess.exitCode === null && fixtureProcess.signalCode === null) {
      try { fixtureProcess.kill(); } catch { }
    }
    await runCli(options.binary, ["stop", "--socket", options.socket]).catch(() => undefined);
    if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill();
    await rm(join(options.output, "driver-screenshots"), { recursive: true, force: true }).catch(() => undefined);
    await rm(join(options.output, "uia-grounding-fixture.exe"), { force: true }).catch(() => undefined);
    await rm(fixtureStatePath, { force: true }).catch(() => undefined);
  }
  await writeFile(join(options.output, "uia-grounding-production-summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ok: report.ok === true, output: options.output, modelRequests: report.modelRequests, productionActionCount: report.productionActionCount, stale: report.stale, disabled: report.disabled, oracle: report.oracle }, null, 2));
  process.exitCode = report.ok === true ? 0 : 1;
}

function statePath(output: string): string {
  return join(output, "fixture-state.txt");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
