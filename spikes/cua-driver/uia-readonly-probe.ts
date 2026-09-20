import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { CuaDriver, EndSessionInput, StartSessionInput, type CuaDriverLike, type ToolResult } from "@trycua/cua-driver";

type JsonObject = Record<string, unknown>;
type Frame = { x: number; y: number; width: number; height: number };

interface Options {
  binary: string;
  output: string;
  socket: string;
  fixture?: string;
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
  const fixture = option(args, "--fixture");
  return {
    binary: resolve(required(args, "--binary")),
    output: resolve(required(args, "--output")),
    socket: normalizePipe(required(args, "--socket")),
    session: option(args, "--session") ?? "uia-readonly-probe",
    ...(fixture === undefined ? {} : { fixture: resolve(fixture) }),
  };
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function number(value: unknown, key: string): number | undefined {
  const candidate = object(value)?.[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function string(value: unknown, key: string): string | undefined {
  const candidate = object(value)?.[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function frame(value: unknown): Frame | undefined {
  const record = object(value);
  if (record === undefined) return undefined;
  const x = number(record, "x");
  const y = number(record, "y");
  const width = number(record, "width") ?? number(record, "w");
  const height = number(record, "height") ?? number(record, "h");
  return x === undefined || y === undefined || width === undefined || height === undefined ? undefined : { x, y, width, height };
}

function parseStructured(result: ToolResult): JsonObject | undefined {
  if (typeof result.structuredJson !== "string") return undefined;
  try { return object(JSON.parse(result.structuredJson)); } catch { return undefined; }
}

function errorCode(error: unknown): string | null {
  const value = object(error)?.code;
  return typeof value === "string" && /^[A-Z0-9_.:-]{1,80}$/u.test(value) ? value : null;
}

function resultSummary(result: ToolResult | undefined): JsonObject {
  if (result === undefined) return { returned: false };
  const structured = parseStructured(result);
  return {
    returned: true,
    isError: result.isError,
    errorCode: result.errorCode ?? null,
    degraded: result.degraded,
    imageCount: result.images.length,
    structuredLength: result.structuredJson?.length ?? 0,
    fieldPresence: structured === undefined ? [] : Object.keys(structured).sort(),
  };
}

function fixturePid(result: ToolResult): number | undefined {
  const pid = number(parseStructured(result), "pid");
  return pid === undefined || !Number.isInteger(pid) || pid <= 0 ? undefined : pid;
}

function windowId(result: ToolResult): number | undefined {
  const windows = parseStructured(result)?.windows;
  if (!Array.isArray(windows)) return undefined;
  for (const candidate of windows) {
    const id = number(candidate, "window_id");
    if (id !== undefined && Number.isInteger(id) && id > 0) return id;
  }
  return undefined;
}

function windows(result: ToolResult): Array<{ pid: number; windowId: number; bounds?: Frame }> {
  const values = parseStructured(result)?.windows;
  if (!Array.isArray(values)) return [];
  return values.flatMap((candidate) => {
    const pid = number(candidate, "pid");
    const window = number(candidate, "window_id");
    if (pid === undefined || window === undefined) return [];
    const bounds = frame(object(candidate)?.bounds);
    return [{ pid, windowId: window, ...(bounds === undefined ? {} : { bounds }) }];
  });
}

function safeElementSummary(value: unknown): JsonObject | undefined {
  const item = object(value);
  if (item === undefined) return undefined;
  const elementFrame = frame(item.frame);
  const role = string(item, "role");
  const name = string(item, "name") ?? string(item, "label") ?? string(item, "title");
  const stateKeys = ["enabled", "visible", "selected", "checked", "expanded", "focused", "editable", "value"]
    .filter((key) => item[key] !== undefined)
    .sort();
  // Never persist UIA values or raw names. The fixture uses fixed labels, but
  // the probe must remain safe if it is accidentally pointed at another owned
  // fixture in the future.
  return {
    role: role ?? null,
    namePresent: name !== undefined,
    nameLength: name?.length ?? 0,
    framePresent: elementFrame !== undefined,
    ...(elementFrame === undefined ? {} : { frame: elementFrame }),
    stateKeys,
  };
}

function summarizeWindowState(result: ToolResult | undefined): JsonObject {
  if (result === undefined) return { returned: false };
  const structured = parseStructured(result);
  const elements = structured?.elements;
  const safeElements = Array.isArray(elements) ? elements.flatMap((item) => {
    const safe = safeElementSummary(item);
    return safe === undefined ? [] : [safe];
  }) : [];
  const roleCounts: Record<string, number> = {};
  for (const item of safeElements) {
    const role = typeof item.role === "string" ? item.role : "unknown";
    roleCounts[role] = (roleCounts[role] ?? 0) + 1;
  }
  return {
    ...resultSummary(result),
    elementCount: safeElements.length,
    roleCounts,
    elements: safeElements,
    completeness: {
      complete: typeof structured?.complete === "boolean" ? structured.complete
        : typeof structured?.elements_complete === "boolean" ? structured.elements_complete : null,
      degraded: typeof structured?.degraded === "boolean" ? structured.degraded : null,
      truncated: typeof structured?.truncated === "boolean" ? structured.truncated : null,
      returnedElementCount: typeof structured?.returned_element_count === "number" ? structured.returned_element_count : null,
      totalElementCount: typeof structured?.total_element_count === "number" ? structured.total_element_count : null,
      snapshotIdPresent: typeof structured?.snapshot_id === "string" && structured.snapshot_id.length > 0,
      completenessPresent: structured?.complete !== undefined || structured?.elements_complete !== undefined
        || structured?.degraded !== undefined || structured?.truncated !== undefined,
    },
  };
}

function summarizeVerification(result: ToolResult | undefined): JsonObject {
  if (result === undefined) return { returned: false };
  const structured = parseStructured(result);
  const predicates = structured?.predicates;
  return {
    ...resultSummary(result),
    status: string(structured, "status") ?? null,
    stable: typeof structured?.stable === "boolean" ? structured.stable : null,
    samples: typeof structured?.samples === "number" ? structured.samples : null,
    predicateStatuses: Array.isArray(predicates) ? predicates.flatMap((item) => {
      const value = object(item);
      const status = value === undefined ? undefined : string(value, "status");
      return status === undefined ? [] : [status];
    }) : [],
  };
}

function inputSchemaSummary(parsedTools: unknown, wanted: readonly string[]): JsonObject {
  const values = Array.isArray(parsedTools) ? parsedTools : object(parsedTools)?.tools;
  if (!Array.isArray(values)) return {};
  return Object.fromEntries(values.flatMap((candidate) => {
    const item = object(candidate);
    const name = item === undefined ? undefined : string(item, "name");
    if (item === undefined || name === undefined || !wanted.includes(name)) return [];
    const schema = object(item.inputSchema) ?? object(item.input_schema) ?? object(item.parameters);
    const properties = schema === undefined ? undefined : object(schema.properties);
    const required = schema?.required;
    return [[name, {
      required: Array.isArray(required) ? required.filter((value): value is string => typeof value === "string") : [],
      properties: properties === undefined ? [] : Object.keys(properties).sort(),
    }]];
  }));
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
  throw new Error("owned fixture window was not discoverable");
}

async function compileFixture(output: string, source: string): Promise<string> {
  const executable = join(output, "uia-readonly-fixture.exe");
  const compiler = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
  const result = await runCli(compiler, [
    "/nologo", "/target:winexe", `/out:${executable}`,
    "/reference:System.dll", "/reference:System.Drawing.dll", "/reference:System.Windows.Forms.dll", source,
  ]);
  if (result.code !== 0) throw new Error(`UIA fixture compilation failed: ${result.stderr || result.stdout}`);
  return executable;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  await mkdir(options.output, { recursive: true });
  const source = fileURLToPath(new URL("./fixture/UiaReadonlyFixture.cs", import.meta.url));
  const fixture = options.fixture ?? await compileFixture(options.output, source);
  const daemon = spawn(options.binary, ["serve", "--socket", options.socket, "--no-overlay"], { windowsHide: true, stdio: "ignore" });
  const report: JsonObject = {
    probeVersion: "uia-readonly-0.1.0",
    daemonVersion: "0.22.2",
    modelRequests: 0,
    userWindowTouched: false,
    screenshotsPersisted: false,
    inputInvocations: 0,
    inventory: {},
    observations: {},
    lifecycle: {},
  };
  let driver: CuaDriverLike | undefined;
  let sessionStarted = false;
  let fixtureProcess: ChildProcess | undefined;
  let fixturePid: number | undefined;
  try {
    await waitForDaemon(options.binary, options.socket, daemon);
    driver = CuaDriver.connect(options.socket);
    const tools = await driver.listToolsJson({ signal: new AbortController().signal });
    let parsedTools: unknown;
    try { parsedTools = JSON.parse(tools) as unknown; } catch { parsedTools = undefined; }
    const names = (Array.isArray(parsedTools) ? parsedTools : object(parsedTools)?.tools) as unknown;
    const toolNames = Array.isArray(names) ? names.flatMap((item) => {
      const name = string(item, "name");
      return name === undefined ? [] : [name];
    }) : [];
    report.inventory = {
      toolCount: toolNames.length,
      required: Object.fromEntries(["list_windows", "get_window_state", "verify_state"].map((name) => [name, toolNames.includes(name)])),
      schemas: inputSchemaSummary(parsedTools, ["list_windows", "get_window_state", "verify_state"]),
      inputToolsInvoked: [],
    };
    await driver.startSession(StartSessionInput.new({ session: options.session }));
    sessionStarted = true;
    const launch = await driver.callTool("launch_app", JSON.stringify({ path: fixture, additional_arguments: [], start_minimized: false, session: options.session }));
    fixturePid = fixturePidFromLaunch(launch);
    if (fixturePid === undefined) throw new Error("owned fixture launch did not return a pid");
    const target = await waitForWindow(driver, fixturePid, options.session);
    const listed = await driver.callTool("list_windows", JSON.stringify({ pid: fixturePid, on_screen_only: true, session: options.session }));
    const full = await driver.callTool("get_window_state", JSON.stringify({ pid: fixturePid, window_id: target.windowId, include_screenshot: false, max_depth: 8, max_elements: 128, session: options.session }));
    const bounded = await driver.callTool("get_window_state", JSON.stringify({ pid: fixturePid, window_id: target.windowId, include_screenshot: false, max_depth: 8, max_elements: 10, session: options.session }));
    const verify = await driver.callTool("verify_state", JSON.stringify({
      pid: fixturePid,
      window_id: target.windowId,
      include_screenshot: false,
      expect: [
        { window: { exists: true } },
        { element: { exists: true, selector: { role: "ComboBox" } } },
      ],
      stable_samples: 1,
      timeout_ms: 0,
      session: options.session,
    }));
    const missing = await driver.callTool("get_window_state", JSON.stringify({ pid: fixturePid, window_id: target.windowId + 1, include_screenshot: false, max_elements: 2, session: options.session }));
    report.observations = {
      ownedWindow: { pidOwned: true, windowIdPresent: target.windowId > 0, bounds: target.bounds ?? null },
      listWindows: resultSummary(listed),
      full: summarizeWindowState(full),
      bounded: summarizeWindowState(bounded),
      verifyState: summarizeVerification(verify),
      invalidWindow: resultSummary(missing),
      screenshotContract: { requested: false, returnedImages: (parseStructured(full) === undefined ? null : full.images.length), persisted: false },
    };
    // Recreate only the owned fixture. This does not mutate a window or send
    // input; it checks that the old pid/window identity is no longer listed.
    try { process.kill(fixturePid); } catch { /* own fixture only */ }
    await new Promise((done) => setTimeout(done, 700));
    fixtureProcess = spawn(fixture, [], { windowsHide: true, stdio: "ignore" });
    await new Promise((done) => setTimeout(done, 700));
    const recreatedPid = fixtureProcess.pid;
    const oldAfterRecreate = await driver.callTool("list_windows", JSON.stringify({ pid: fixturePid, on_screen_only: true, session: options.session }));
    const staleState = await driver.callTool("get_window_state", JSON.stringify({ pid: fixturePid, window_id: target.windowId, include_screenshot: false, max_elements: 10, session: options.session }));
    report.lifecycle = {
      oldPidStillListedAfterOwnedFixtureReplacement: windows(oldAfterRecreate).some((item) => item.pid === fixturePid),
      oldStateAfterReplacement: resultSummary(staleState),
      replacementPidObserved: typeof recreatedPid === "number" && recreatedPid > 0,
      generationSignal: "not provided by read-only portable response; pid/window identity must be re-discovered",
    };
  } finally {
    if (fixtureProcess !== undefined && fixtureProcess.exitCode === null) fixtureProcess.kill();
    if (fixturePid !== undefined) {
      try { process.kill(fixturePid); } catch { /* own fixture only */ }
    }
    if (driver !== undefined) {
      if (sessionStarted) await driver.endSession(EndSessionInput.new({ session: options.session })).catch(() => undefined);
      await driver.shutdown().catch(() => undefined);
      (driver as unknown as { uniffiDestroy?: () => void }).uniffiDestroy?.();
    }
    await runCli(options.binary, ["stop", "--socket", options.socket]).catch(() => undefined);
    if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill();
  }
  await writeFile(join(options.output, "uia-readonly-summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const inventory = report.inventory as JsonObject;
  const required = inventory.required as JsonObject;
  const observations = report.observations as JsonObject;
  const full = observations.full as JsonObject;
  const ok = required.list_windows === true && required.get_window_state === true && required.verify_state === true
    && full.elementCount !== 0 && report.userWindowTouched === false && report.inputInvocations === 0 && report.modelRequests === 0;
  console.log(JSON.stringify({ ok, output: options.output, inventory: report.inventory, full: { elementCount: full.elementCount, roleCounts: full.roleCounts }, userWindowTouched: report.userWindowTouched, inputInvocations: report.inputInvocations }, null, 2));
  process.exitCode = ok ? 0 : 1;
}

function fixturePidFromLaunch(result: ToolResult): number | undefined {
  return number(parseStructured(result), "pid");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
