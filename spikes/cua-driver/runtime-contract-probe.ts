import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { join, resolve } from "node:path";
import { CuaDriver, EndSessionInput, StartSessionInput, type CuaDriverLike } from "@trycua/cua-driver";
import { CuaDriverComputer } from "@computer-harness/computer-cua";
import { DefaultContextCompiler } from "@computer-harness/context";
import type { ActionId, EventId, ObservationId, RunId, ToolCall, ToolCallId } from "@computer-harness/protocol";
import {
  DefaultRuntimePolicy,
  RunController,
  ToolRegistry,
  validateActionIntent,
  type ProviderAdapter,
} from "@computer-harness/runtime";
import {
  FileAssetStore,
  JsonlRunEventWriter,
  readRuntimeEvents,
  reduceRuntimeEvents,
} from "@computer-harness/trajectory";

type Daemon = ChildProcessByStdio<null, Readable, Readable>;

interface Options { binary: string; socket: string; fixture: string; output: string; rounds: number; }

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function required(args: string[], name: string): string {
  const value = option(args, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function normalizePipe(value: string): string {
  if (process.platform !== "win32") return value;
  const match = value.match(/^\\+\.\\+pipe\\+(.*)$/i);
  return match?.[1] === undefined ? value : `\\\\.\\pipe\\${match[1].replace(/\\+/g, "\\")}`;
}

function parseOptions(args: string[]): Options {
  const rounds = Number(option(args, "--rounds") ?? "20");
  if (!Number.isInteger(rounds) || rounds < 1) throw new Error("--rounds must be a positive integer");
  return {
    binary: resolve(required(args, "--binary")),
    socket: normalizePipe(required(args, "--socket")),
    fixture: resolve(required(args, "--fixture")),
    output: resolve(option(args, "--output") ?? "runs/runtime-contract"),
    rounds,
  };
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

async function launchFixture(raw: CuaDriverLike, fixture: string, statePath: string, session: string): Promise<{ pid: number; windowId: number; x: number; y: number }> {
  const launch = await raw.callTool("launch_app", JSON.stringify({ path: fixture, additional_arguments: [statePath], start_minimized: false, session }));
  const launchJson = structured(launch);
  const pid = numberField(launchJson, "pid");
  if (pid === undefined) throw new Error("fixture launch did not return a pid");
  const windows = await raw.callTool("list_windows", JSON.stringify({ pid, on_screen_only: true, session }));
  const windowList = structured(windows)?.windows;
  const selected = Array.isArray(windowList) ? windowList.find((item) => item && typeof item === "object") as Record<string, unknown> | undefined : undefined;
  const windowId = numberField(selected, "window_id");
  if (windowId === undefined) throw new Error("fixture window lookup did not return window_id");
  const bounds = selected?.bounds && typeof selected.bounds === "object" ? selected.bounds as Record<string, unknown> : undefined;
  const x = Math.round((numberField(bounds, "x") ?? 0) + Math.max(24, (numberField(bounds, "width") ?? 400) * 0.45));
  const y = Math.round((numberField(bounds, "y") ?? 0) + Math.max(100, (numberField(bounds, "height") ?? 300) * 0.45));
  const foreground = await raw.callTool("bring_to_front", JSON.stringify({ pid, window_id: windowId, session }));
  if (structured(foreground)?.landed_on_target !== true) throw new Error("fixture foreground could not be established");
  await new Promise((done) => setTimeout(done, 250));
  return { pid, windowId, x, y };
}

function clickRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "click",
    description: "Click a point in the current observation.",
    category: "computer",
    inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] },
    validate: (args) => {
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("click arguments must be an object");
      const point = args as { x?: unknown; y?: unknown };
      if (typeof point.x !== "number" || !Number.isFinite(point.x) || typeof point.y !== "number" || !Number.isFinite(point.y)) throw new Error("click requires finite numeric x and y");
    },
    toAction: (args) => {
      const point = args as { x: number; y: number };
      return { kind: "click", point: { x: point.x, y: point.y } };
    },
  });
  return registry;
}

class SequenceIds {
  private event = 0;
  private observation = 0;
  private asset = 0;
  private action = 0;
  public eventId(): EventId { return `event-${this.event++}` as EventId; }
  public observationId(): ObservationId { return `observation-${this.observation++}` as ObservationId; }
  public assetId(): import("@computer-harness/protocol").AssetId { return `asset-${this.asset++}` as import("@computer-harness/protocol").AssetId; }
  public actionId(): ActionId { return `action-${this.action++}` as ActionId; }
}

class ClickProvider implements ProviderAdapter {
  public readonly id = "scripted-provider";
  private index = 0;
  public constructor(private readonly total: number, private readonly point: { x: number; y: number }, private readonly beforeFinish?: () => Promise<void>) {}
  public async generate(_input: import("@computer-harness/runtime").ModelInput): Promise<import("@computer-harness/protocol").ModelTurn> {
    if (this.index < this.total) {
      this.index += 1;
      if (this.beforeFinish !== undefined && this.index === 1) await this.beforeFinish();
      const call: ToolCall = { id: `call-${this.index}` as ToolCallId, name: "click", arguments: { x: this.point.x, y: this.point.y } };
      return { type: "tool_calls", calls: [call] };
    }
    return { type: "finish", summary: "scripted completion" };
  }
}

async function runRuntime(options: Options, binary: string, socket: string, daemon: Daemon, output: string, rounds: number, disconnect: boolean): Promise<Record<string, unknown>> {
  await mkdir(output, { recursive: true });
  const statePath = join(output, "fixture-state.txt");
  const raw = CuaDriver.connect(socket);
  const setupSession = disconnect ? "runtime-disconnect-setup" : "runtime-stability-setup";
  let fixturePid: number | undefined;
  let adapter: CuaDriverComputer | undefined;
  try {
    await raw.startSession(StartSessionInput.new({ session: setupSession }));
    const target = await launchFixture(raw, options.fixture, statePath, setupSession);
    fixturePid = target.pid;
    const runId = (disconnect ? "runtime-disconnect" : "runtime-stability") as RunId;
    const eventPath = join(output, "trajectory.jsonl");
    const adapterOutput = join(output, "adapter-screenshots");
    adapter = new CuaDriverComputer({ socketPath: socket, screenshotDir: adapterOutput, sessionLabel: disconnect ? "runtime-disconnect" : "runtime-stability", cleanupWaitMs: 1000 });
    const registry = clickRegistry();
    const provider = new ClickProvider(disconnect ? 1 : rounds, { x: target.x, y: target.y }, disconnect ? async () => { await run(binary, ["stop", "--socket", socket]); } : undefined);
    const writer = new JsonlRunEventWriter(eventPath, runId, { next: (() => { let n = 0; return () => `event-${n++}` as EventId; })() });
    const controller = new RunController({
      runId,
      provider,
      computer: adapter,
      contextCompiler: new DefaultContextCompiler(registry),
      toolRegistry: registry,
      policy: new DefaultRuntimePolicy(rounds + 2),
      eventWriter: writer,
      assetStore: new FileAssetStore(join(output, "assets")),
      idFactory: new SequenceIds(),
      clock: { now: () => "2026-08-30T00:00:00.000Z" },
    });
    const outcome = await controller.start(disconnect ? "disconnect during a click" : `perform ${rounds} safe clicks`);
    const events = await readRuntimeEvents(eventPath);
    const snapshot = reduceRuntimeEvents(events, runId);
    const observationEvents = events.filter((event): event is Extract<typeof event, { type: "observation.created" }> => event.type === "observation.created");
    const observations = observationEvents.map((event) => event.observation.id);
    const observationFiles = await readdir(join(output, "assets", "screenshots")).catch(() => [] as string[]);
    const started = events.filter((event) => event.type === "action.execution.started").length;
    const terminal = events.filter((event) => event.type === "action.execution.completed" || event.type === "action.execution.failed").length;
    const unknown = events.filter((event) => event.type === "runtime.error" && event.category === "unknown_side_effect").length;
    const eventTypes = events.map((event) => event.type);
    let currentObservationId: ObservationId | undefined;
    let actionsBoundToCurrentObservation = true;
    for (const event of events) {
      if (event.type === "observation.created") {
        currentObservationId = event.observation.id;
      } else if (event.type === "action.execution.started" && event.action.kind !== "wait") {
        actionsBoundToCurrentObservation = actionsBoundToCurrentObservation && event.action.basedOn === currentObservationId;
      }
    }
    const latestObservation = observationEvents.at(-1)?.observation;
    const staleObservation = observationEvents.at(0)?.observation;
    let oldObservationRejected = false;
    if (latestObservation !== undefined && staleObservation !== undefined && latestObservation.id !== staleObservation.id) {
      try {
        validateActionIntent({ actionId: "stale-check" as ActionId, basedOn: staleObservation.id, kind: "click", point: { x: 0, y: 0 } }, {
          observation: latestObservation,
          capabilities: snapshot.computerSession?.capabilities ?? { screenshot: true, pointer: true, keyboard: true, accessibility: false },
        });
      } catch {
        oldObservationRejected = true;
      }
    }
    const summary = disconnect
      ? {
          ok: outcome === "outcome_unknown" && unknown === 1 && started === 1 && terminal === 0 && eventTypes.at(-1) === "run.finished" && snapshot.outcome === "outcome_unknown",
          mode: "disconnect",
          outcome,
          started,
          terminal,
          unknownSideEffectErrors: unknown,
          finalEvent: eventTypes.at(-1),
          snapshotOutcome: snapshot.outcome,
        }
      : {
          ok: outcome === "succeeded" && snapshot.outcome === "succeeded" && started === rounds && terminal === rounds && observations.length === rounds + 1 && new Set(observations).size === observations.length && observationFiles.length === rounds + 1 && actionsBoundToCurrentObservation && oldObservationRejected,
          mode: "stability",
          rounds,
          outcome,
          started,
          terminal,
          observations: observations.length,
          uniqueObservations: new Set(observations).size,
          screenshotAssets: observationFiles.length,
          actionsBoundToCurrentObservation,
          oldObservationRejected,
          viewport: controller.getSnapshot().computerSession?.viewport,
          fixtureEventSequence: await fixtureEventSequence(statePath),
          finalEvent: eventTypes.at(-1),
        };
    await writeFile(join(output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    return summary;
  } finally {
    // RunController owns the adapter close path. This fallback only handles a
    // failure before the controller could create its session.
    await raw.endSession(EndSessionInput.new({ session: setupSession })).catch(() => undefined);
    await raw.shutdown().catch(() => undefined);
    (raw as unknown as { uniffiDestroy?: () => void }).uniffiDestroy?.();
    if (fixturePid !== undefined) try { process.kill(fixturePid); } catch { /* already exited */ }
    if (daemon.exitCode === null && daemon.signalCode === null) await run(binary, ["stop", "--socket", socket]).catch(() => undefined);
  }
}

async function fixtureEventSequence(path: string): Promise<number> {
  const content = await readFile(path, "utf8").catch(() => "");
  return Number(content.match(/(?:^|\n)eventSequence=(\d+)/)?.[1] ?? "0");
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  await mkdir(options.output, { recursive: true });
  const socket = options.socket;
  const daemon = spawn(options.binary, ["serve", "--socket", socket, "--no-overlay"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  daemon.stdout.setEncoding("utf8");
  daemon.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  daemon.stdout.on("data", (chunk: string) => (stdout += chunk));
  daemon.stderr.on("data", (chunk: string) => (stderr += chunk));
  try {
    await waitReady(options.binary, socket, daemon);
    const stability = await runRuntime(options, options.binary, socket, daemon, join(options.output, "stability"), options.rounds, false);
    // The successful and failure runs are intentionally separate daemon
    // lifecycles so a disconnect cannot contaminate the stability result.
    if (daemon.exitCode === null && daemon.signalCode === null) await run(options.binary, ["stop", "--socket", socket]).catch(() => undefined);
    const failureDaemon = spawn(options.binary, ["serve", "--socket", socket, "--no-overlay"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    failureDaemon.stdout.setEncoding("utf8");
    failureDaemon.stderr.setEncoding("utf8");
    failureDaemon.stdout.on("data", (chunk: string) => (stdout += chunk));
    failureDaemon.stderr.on("data", (chunk: string) => (stderr += chunk));
    await waitReady(options.binary, socket, failureDaemon);
    const disconnect = await runRuntime(options, options.binary, socket, failureDaemon, join(options.output, "disconnect"), 1, true);
    await writeFile(join(options.output, "summary.json"), `${JSON.stringify({ ok: stability.ok === true && disconnect.ok === true, stability, disconnect }, null, 2)}\n`, "utf8");
    await writeFile(join(options.output, "daemon-stdout.log"), stdout, "utf8");
    await writeFile(join(options.output, "daemon-stderr.log"), stderr, "utf8");
    if (stability.ok !== true || disconnect.ok !== true) throw new Error("runtime contract probe failed");
    console.log(JSON.stringify({ ok: true, output: options.output }, null, 2));
  } finally {
    await run(options.binary, ["stop", "--socket", socket]).catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
