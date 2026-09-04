import { spawn } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OsworldBridgeClient, OsworldComputer } from "../../packages/computer-osworld/dist/index.js";

const execFileAsync = promisify(execFile);

function value(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function required(argv, name) {
  const result = value(argv, name);
  if (result === undefined || result.trim().length === 0) throw new Error(`${name} is required`);
  return result;
}

function requiredOrEnv(argv, name, envName) {
  const result = value(argv, name) ?? process.env[envName];
  if (result === undefined || result.trim().length === 0) throw new Error(`${name} is required (or set ${envName})`);
  return result;
}

function integer(argv, name, fallback) {
  const raw = value(argv, name);
  const result = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(result) || result < 0) throw new Error(`${name} must be a non-negative integer`);
  return result;
}

function parseAction(argv, observationId) {
  const kind = value(argv, "--action");
  if (kind === undefined) throw new Error("--action is required; use --action wait only for transport smoke");
  const actionId = "gate2-action-1";
  if (kind === "wait") return { actionId, kind, durationMs: integer(argv, "--duration-ms", 100) };
  const base = { actionId, basedOn: observationId };
  if (kind === "type") return { ...base, kind, text: required(argv, "--text") };
  if (kind === "keypress") return { ...base, kind, keys: [required(argv, "--key")] };
  if (kind === "hotkey") {
    const keys = required(argv, "--keys").split(",").map((key) => key.trim()).filter(Boolean);
    if (keys.length === 0) throw new Error("--keys must contain at least one comma-separated key");
    return { ...base, kind, keys };
  }
  const x = Number(required(argv, "--x"));
  const y = Number(required(argv, "--y"));
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("--x and --y must be finite numbers");
  if (kind === "click" || kind === "double_click" || kind === "right_click") return { ...base, kind, point: { x, y } };
  if (kind === "scroll") {
    const direction = value(argv, "--direction") ?? "down";
    if (!["up", "down", "left", "right"].includes(direction)) throw new Error("--direction must be up, down, left, or right");
    const ticks = integer(argv, "--ticks", 1);
    if (!Number.isInteger(ticks) || ticks < 1) throw new Error("--ticks must be a positive integer");
    return { ...base, kind, point: { x, y }, direction, ticks };
  }
  if (kind === "drag") {
    const toX = Number(required(argv, "--to-x"));
    const toY = Number(required(argv, "--to-y"));
    if (!Number.isFinite(toX) || !Number.isFinite(toY)) throw new Error("--to-x and --to-y must be finite numbers");
    return { ...base, kind, from: { x, y }, to: { x: toX, y: toY } };
  }
  throw new Error(`unsupported --action ${kind}`);
}

async function waitForReady(child) {
  let output = "";
  return new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`OSWorld bridge did not become ready: ${output}`)), 120_000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      const match = output.match(/READY (\d+)/u);
      if (match !== null) {
        clearTimeout(timer);
        resolveReady(Number(match[1]));
      }
    });
    child.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timer);
        reject(new Error(`OSWorld bridge exited with ${code}: ${output}`));
      }
    });
  });
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = await new Promise((resolveDone) => {
    const timer = setTimeout(() => resolveDone(false), 5_000);
    child.once("exit", () => { clearTimeout(timer); resolveDone(true); });
  });
  if (exited || child.exitCode !== null) return;
  child.kill("SIGKILL");
  await new Promise((resolveDone) => {
    const timer = setTimeout(resolveDone, 2_000);
    child.once("exit", () => { clearTimeout(timer); resolveDone(); });
  });
  if (child.exitCode === null) throw new Error("OSWorld bridge process did not terminate after forced stop");
}

async function assertFreshOutput(output) {
  try {
    const entries = await readdir(output);
    if (entries.length > 0) throw new Error(`output directory is not empty: ${output}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function gitCommit(root) {
  const result = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"]);
  const commit = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/iu.test(commit)) throw new Error(`could not resolve OSWorld commit for ${root}`);
  return commit;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write("Usage: node scripts/stage5-osworld/gate2-computer.mjs --osworld-root <path> --path-to-vm <vmx> --snapshot-name <verified snapshot> --task-id <id> --action <wait|click|double_click|right_click|type|keypress|hotkey|scroll|drag> [--python python] [--vmrun-path <vmrun.exe>] [--x <n> --y <n>] [--to-x <n> --to-y <n>] [--text <text>] [--key <key>] [--keys CTRL,L] [--output <dir>]\n");
    return;
  }
  const osworldRoot = resolve(required(argv, "--osworld-root"));
  const vmx = resolve(required(argv, "--path-to-vm"));
  const taskId = required(argv, "--task-id");
  const python = value(argv, "--python") ?? "python";
  const bridgeScript = resolve(value(argv, "--bridge-script") ?? fileURLToPath(new URL("../../integrations/osworld/bridge.py", import.meta.url)));
  const output = resolve(value(argv, "--output") ?? `runs/stage5-gate2-${Date.now()}`);
  await assertFreshOutput(output);
  const osworldCommit = await gitCommit(osworldRoot);
  const snapshotName = requiredOrEnv(argv, "--snapshot-name", "OSWORLD_SNAPSHOT_NAME");
  const vmrunPath = value(argv, "--vmrun-path");
  const action = parseAction(argv, "gate2-observation-1");
  const token = process.env.OSWORLD_BRIDGE_TOKEN;
  const child = spawn(python, [bridgeScript, "--osworld-root", osworldRoot, "--path-to-vm", vmx, "--snapshot-name", snapshotName, "--osworld-version", osworldCommit, ...(vmrunPath === undefined ? [] : ["--vmrun-path", resolve(vmrunPath)])], {
    env: { ...process.env, ...(token === undefined ? {} : { OSWORLD_BRIDGE_TOKEN: token }) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let client;
  let bridgePort;
  const summary = { gate: null, taskId, osworldCommit, snapshotName, bridgeTimeoutsMs: { computer: OsworldBridgeClient.computerRequestTimeoutMs, environment: OsworldBridgeClient.environmentRequestTimeoutMs }, output, health: null, reset: null, session: null, initialObservation: null, initialScreenshot: resolve(output, "initial.png"), action: null, receipt: null, postActionObservation: null, postActionScreenshot: resolve(output, "post-action.png"), evaluation: null, resetAfterEvaluate: null, resetAfterEvaluateSession: null, resetAfterEvaluateObservation: null, resetAfterEvaluateScreenshot: resolve(output, "reset-after-evaluate.png"), error: null, cleanupErrors: [] };
  try {
    bridgePort = await waitForReady(child);
    client = new OsworldBridgeClient({ baseUrl: `http://127.0.0.1:${bridgePort}`, ...(token === undefined ? {} : { token }) });
    summary.health = await client.health(new AbortController().signal);
    summary.reset = await client.reset(taskId, new AbortController().signal);
    const computer = new OsworldComputer({ bridge: client });
    const signal = new AbortController().signal;
    await mkdir(output, { recursive: true });
    const session = await computer.open({}, signal);
    summary.session = session;
    const initial = await computer.observe(session, "gate2-observation-1", signal);
    await writeFile(resolve(output, "initial.png"), initial.screenshot.data);
    summary.initialObservation = { capturedAt: initial.capturedAt, viewport: initial.viewport, byteLength: initial.screenshot.data.byteLength };
    summary.action = action;
    summary.gate = action.kind === "wait" ? "transport_smoke" : "gate2_computer_contract";
    summary.receipt = await computer.execute(session, action, signal);
    if (summary.receipt.status !== "completed") throw new Error(`Gate 2 action was not completed: ${summary.receipt.driverCode ?? "unknown"}`);
    const post = await computer.observe(session, "gate2-observation-2", signal);
    await writeFile(resolve(output, "post-action.png"), post.screenshot.data);
    summary.postActionObservation = { capturedAt: post.capturedAt, viewport: post.viewport, byteLength: post.screenshot.data.byteLength };
    await computer.close(session);
    summary.evaluation = await client.evaluate(signal);
    summary.resetAfterEvaluate = await client.reset(taskId, signal);
    const resetSession = await computer.open({}, signal);
    summary.resetAfterEvaluateSession = resetSession;
    const resetObservation = await computer.observe(resetSession, "gate2-observation-reset", signal);
    await writeFile(resolve(output, "reset-after-evaluate.png"), resetObservation.screenshot.data);
    summary.resetAfterEvaluateObservation = { capturedAt: resetObservation.capturedAt, viewport: resetObservation.viewport, byteLength: resetObservation.screenshot.data.byteLength };
    await computer.close(resetSession);
  } catch (error) {
    summary.error = { message: error instanceof Error ? error.message : String(error) };
  } finally {
    if (client !== undefined) {
      try { await client.close(new AbortController().signal); } catch (error) {
        summary.cleanupErrors.push({ operation: "bridge.close", message: error instanceof Error ? error.message : String(error) });
      }
    }
    try { await stop(child); } catch (error) {
      summary.cleanupErrors.push({ operation: "bridge.process", message: error instanceof Error ? error.message : String(error) });
    }
    await mkdir(output, { recursive: true });
    await writeFile(resolve(output, "gate2-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (summary.error !== null || summary.cleanupErrors.length > 0 || summary.receipt?.status !== "completed") process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
