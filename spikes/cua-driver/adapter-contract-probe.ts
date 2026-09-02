import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { join, resolve } from "node:path";
import { CuaDriver, EndSessionInput, StartSessionInput, type CuaDriverLike } from "@trycua/cua-driver";
import { CuaDriverComputer } from "@computer-harness/computer-cua";
import type { ActionId, ComputerSessionDescriptor, ObservationId } from "@computer-harness/protocol";

type Daemon = ChildProcessByStdio<null, Readable, Readable>;

interface Options { binary: string; socket: string; fixture: string; output: string; }

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function required(args: string[], name: string): string {
  const value = option(args, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseOptions(args: string[]): Options {
  return {
    binary: resolve(required(args, "--binary")),
    socket: normalizePipe(required(args, "--socket")),
    fixture: resolve(required(args, "--fixture")),
    output: resolve(option(args, "--output") ?? "runs/adapter-contract"),
  };
}

function normalizePipe(value: string): string {
  if (process.platform !== "win32") return value;
  const match = value.match(/^\\+\.\\+pipe\\+(.*)$/i);
  if (!match || match[1] === undefined) return value;
  return `\\\\.\\pipe\\${match[1].replace(/\\+/g, "\\")}`;
}

function structured(value: { structuredJson?: string }): Record<string, unknown> | undefined {
  if (typeof value.structuredJson !== "string") return undefined;
  try {
    const parsed = JSON.parse(value.structuredJson) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

function numberField(value: unknown, key: string): number | undefined {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

async function run(binary: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(binary, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  return new Promise((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolveResult({ code, stdout, stderr }));
  });
}

async function waitReady(binary: string, socket: string, daemon: Daemon): Promise<void> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (daemon.exitCode !== null || daemon.signalCode !== null) throw new Error("daemon exited before readiness");
    const status = await run(binary, ["status", "--socket", socket]);
    if (status.code === 0 && /daemon is running/i.test(status.stdout)) return;
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error("daemon readiness timeout");
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  await mkdir(options.output, { recursive: true });
  const fixtureStatePath = join(options.output, "fixture-state.txt");
  const daemon = spawn(options.binary, ["serve", "--socket", options.socket, "--no-overlay"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  daemon.stdout.setEncoding("utf8");
  daemon.stderr.setEncoding("utf8");
  let daemonStdout = "";
  let daemonStderr = "";
  daemon.stdout.on("data", (chunk: string) => (daemonStdout += chunk));
  daemon.stderr.on("data", (chunk: string) => (daemonStderr += chunk));
  let raw: CuaDriverLike | undefined;
  let adapter: CuaDriverComputer | undefined;
  let openedSession: ComputerSessionDescriptor | undefined;
  let fixturePid: number | undefined;
  let stopped = false;
  try {
    await waitReady(options.binary, options.socket, daemon);
    raw = CuaDriver.connect(options.socket);
    const setupSession = "adapter-contract-setup";
    await raw.startSession(StartSessionInput.new({ session: setupSession }));
    const launch = await raw.callTool("launch_app", JSON.stringify({ path: options.fixture, additional_arguments: [fixtureStatePath], start_minimized: false, session: setupSession }));
    const launchJson = structured(launch);
    fixturePid = numberField(launchJson, "pid");
    if (fixturePid === undefined) throw new Error("fixture launch did not return a pid");
    const windows = await raw.callTool("list_windows", JSON.stringify({ pid: fixturePid, on_screen_only: true, session: setupSession }));
    const windowList = structured(windows)?.windows;
    const selected = Array.isArray(windowList) ? windowList.find((item) => item && typeof item === "object") as Record<string, unknown> | undefined : undefined;
    const windowId = numberField(selected, "window_id");
    if (windowId === undefined) throw new Error("fixture window lookup did not return a window_id");
    const bounds = selected?.bounds && typeof selected.bounds === "object" ? selected.bounds as Record<string, unknown> : undefined;
    const x = Math.round((numberField(bounds, "x") ?? 0) + Math.max(24, (numberField(bounds, "width") ?? 400) * 0.45));
    const y = Math.round((numberField(bounds, "y") ?? 0) + Math.max(100, (numberField(bounds, "height") ?? 300) * 0.45));
    await ensureForeground(raw, fixturePid, windowId, setupSession);
    adapter = new CuaDriverComputer({ socketPath: options.socket, screenshotDir: join(options.output, "screenshots"), sessionLabel: "adapter-contract", cleanupWaitMs: 2000 });
    const session = await adapter.open({}, new AbortController().signal);
    openedSession = session;
    const observationId = "adapter-observation-1" as ObservationId;
    const before = await adapter.observe(session, observationId, new AbortController().signal);
    // A desktop/foreground action requires the caller to establish the target
    // foreground immediately before the side effect. Observation itself must
    // not be assumed to preserve that OS-level focus state.
    await ensureForeground(raw, fixturePid, windowId, setupSession);
    const click = await adapter.execute(session, { actionId: "adapter-click-1" as ActionId, basedOn: observationId, kind: "click", point: { x, y } }, new AbortController().signal);
    const typeText = "Computer-Harness adapter";
    const type = await adapter.execute(session, { actionId: "adapter-type-1" as ActionId, basedOn: observationId, kind: "type", text: typeText }, new AbortController().signal);
    const afterObservationId = "adapter-observation-2" as ObservationId;
    const after = await adapter.observe(session, afterObservationId, new AbortController().signal);
    await ensureForeground(raw, fixturePid, windowId, setupSession);
    const dragTo = { x: x + 140, y: y + 36 };
    const drag = await adapter.execute(session, { actionId: "adapter-drag-1" as ActionId, basedOn: afterObservationId, kind: "drag", from: { x, y }, to: dragTo }, new AbortController().signal);
    await adapter.close(session);
    adapter = undefined;
    openedSession = undefined;
    await raw.endSession(EndSessionInput.new({ session: setupSession }));
    // RichTextBox normalizes the initial CRLF to one newline in its Text
    // property on this Windows fixture, so the baseline is six characters.
    const expectedTextLength = 6 + typeText.length;
    const state = await waitForFixtureText(fixtureStatePath, expectedTextLength);
    const textLength = Number(state.match(/(?:^|\n)textLength=(\d+)/)?.[1] ?? "0");
    const dragState = await waitForFixtureDrag(fixtureStatePath);
    const dragCount = Number(dragState.match(/(?:^|\n)dragCount=(\d+)/)?.[1] ?? "0");
    const summary = { ok: click.status === "completed" && type.status === "completed" && drag.status === "completed" && textLength >= expectedTextLength && dragCount > 0, backend: session.backend, viewport: session.viewport, point: { x, y }, dragTo, windowBounds: bounds, beforeBytes: before.screenshot.data.byteLength, afterBytes: after.screenshot.data.byteLength, clickStatus: click.status, clickMessage: click.message, typeStatus: type.status, typeMessage: type.message, dragStatus: drag.status, dragMessage: drag.message, expectedTextLength, fixtureStateTextLength: textLength, fixtureDragCount: dragCount };
    await writeFile(join(options.output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    if (!summary.ok) throw new Error(`adapter contract failed: ${JSON.stringify(summary)}`);
    console.log(JSON.stringify({ ok: true, output: options.output }, null, 2));
  } finally {
    if (adapter !== undefined) {
      if (openedSession !== undefined) {
        try { await adapter.close(openedSession); } catch { /* preserve primary error */ }
      }
    }
    if (raw !== undefined) {
      try { await raw.shutdown(); } catch { /* daemon stop remains authoritative */ }
      (raw as unknown as { uniffiDestroy?: () => void }).uniffiDestroy?.();
    }
    if (!stopped) {
      await run(options.binary, ["stop", "--socket", options.socket]).catch(() => undefined);
      stopped = true;
    }
    if (fixturePid !== undefined) {
      try { process.kill(fixturePid); } catch { /* already exited */ }
    }
    await writeFile(join(options.output, "daemon-stdout.log"), daemonStdout, "utf8");
    await writeFile(join(options.output, "daemon-stderr.log"), daemonStderr, "utf8");
  }
}

async function ensureForeground(driver: CuaDriverLike, pid: number, windowId: number, session: string): Promise<void> {
  const result = await driver.callTool("bring_to_front", JSON.stringify({ pid, window_id: windowId, session }));
  const landed = structured(result)?.landed_on_target;
  if (landed !== true) {
    throw new Error(`fixture foreground could not be established: ${result.text ?? "unknown result"}`);
  }
  await new Promise((done) => setTimeout(done, 250));
}

async function waitForFixtureText(path: string, expectedTextLength: number): Promise<string> {
  const deadline = Date.now() + 5000;
  let latest = "";
  while (Date.now() < deadline) {
    latest = await readFile(path, "utf8").catch(() => "");
    const textLength = Number(latest.match(/(?:^|\n)textLength=(\d+)/)?.[1] ?? "0");
    if (textLength >= expectedTextLength) return latest;
    await new Promise((done) => setTimeout(done, 100));
  }
  return latest;
}

async function waitForFixtureDrag(path: string): Promise<string> {
  const deadline = Date.now() + 5000;
  let latest = "";
  while (Date.now() < deadline) {
    latest = await readFile(path, "utf8").catch(() => "");
    const dragCount = Number(latest.match(/(?:^|\n)dragCount=(\d+)/)?.[1] ?? "0");
    if (dragCount > 0) return latest;
    await new Promise((done) => setTimeout(done, 100));
  }
  return latest;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
