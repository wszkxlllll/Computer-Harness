import { spawn } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { OsworldBridgeClient } from "../../packages/computer-osworld/dist/index.js";

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
  const exited = await new Promise((done) => {
    const timer = setTimeout(() => done(false), 5_000);
    child.once("exit", () => { clearTimeout(timer); done(true); });
  });
  if (exited || child.exitCode !== null) return;
  child.kill("SIGKILL");
  await new Promise((done) => {
    const timer = setTimeout(done, 2_000);
    child.once("exit", () => { clearTimeout(timer); done(); });
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

async function runCli(cliPath, args, env) {
  const child = spawn(process.execPath, [cliPath, ...args], { env, stdio: "inherit" });
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit({ code: code ?? 1, signal }));
  });
}

function positiveInteger(value, fallback, name) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write("Usage: node scripts/stage5-osworld/run-task.mjs --osworld-root <path> --path-to-vm <vmx> --snapshot-name <verified snapshot> --task-id <id> [--model glm-5.3-flash|qwen3.8-flash] [--max-steps <n>] [--max-model-requests <n>] [--qwen-coordinate-mode normalized_1000|actual_pixels] [--qwen-thinking disabled|low|medium|xhigh] [--qwen-output-mode native_tools|strict_json] [--cli <dist/index.js>] [--python python] [--vmrun-path <vmrun.exe>] [--output <dir>] [--env-file <path>]\n");
    return;
  }
  const osworldRoot = resolve(required(argv, "--osworld-root"));
  const vmx = resolve(required(argv, "--path-to-vm"));
  const taskId = required(argv, "--task-id");
  const model = value(argv, "--model") ?? "glm-5.3-flash";
  if (model !== "glm-5.3-flash" && model !== "qwen3.8-flash") throw new Error("--model must be glm-5.3-flash or qwen3.8-flash");
  const qwenCoordinateMode = value(argv, "--qwen-coordinate-mode") ?? "normalized_1000";
  const qwenThinking = value(argv, "--qwen-thinking") ?? "low";
  const qwenOutputMode = value(argv, "--qwen-output-mode") ?? "strict_json";
  const maxSteps = positiveInteger(value(argv, "--max-steps"), 30, "--max-steps");
  const maxModelRequests = positiveInteger(value(argv, "--max-model-requests"), 30, "--max-model-requests");
  if (model === "qwen3.8-flash" && qwenCoordinateMode !== "normalized_1000" && qwenCoordinateMode !== "actual_pixels") throw new Error("--qwen-coordinate-mode must be normalized_1000 or actual_pixels");
  if (model === "qwen3.8-flash" && !["disabled", "low", "medium", "xhigh"].includes(qwenThinking)) throw new Error("--qwen-thinking must be disabled, low, medium, or xhigh");
  if (model === "qwen3.8-flash" && !["native_tools", "strict_json"].includes(qwenOutputMode)) throw new Error("--qwen-output-mode must be native_tools or strict_json");
  const python = value(argv, "--python") ?? "python";
  const cliPath = resolve(value(argv, "--cli") ?? "apps/cli/dist/index.js");
  const output = resolve(value(argv, "--output") ?? `runs/stage5-osworld/${taskId}-${Date.now()}`);
  await assertFreshOutput(output);
  const osworldCommit = await gitCommit(osworldRoot);
  const snapshotName = requiredOrEnv(argv, "--snapshot-name", "OSWORLD_SNAPSHOT_NAME");
  const vmrunPath = value(argv, "--vmrun-path");
  const envFile = value(argv, "--env-file");
  const token = process.env.OSWORLD_BRIDGE_TOKEN;
  const bridgeScript = resolve(value(argv, "--bridge-script") ?? fileURLToPath(new URL("../../integrations/osworld/bridge.py", import.meta.url)));
  const bridge = spawn(python, [bridgeScript, "--osworld-root", osworldRoot, "--path-to-vm", vmx, "--snapshot-name", snapshotName, "--osworld-version", osworldCommit, ...(vmrunPath === undefined ? [] : ["--vmrun-path", resolve(vmrunPath)])], {
    env: { ...process.env, ...(token === undefined ? {} : { OSWORLD_BRIDGE_TOKEN: token }) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const result = {
    taskId,
    osworldCommit,
    snapshotName,
    maxSteps,
    maxModelRequests,
    bridgeTimeoutsMs: { computer: OsworldBridgeClient.computerRequestTimeoutMs, environment: OsworldBridgeClient.environmentRequestTimeoutMs },
    model,
    output,
    bridgeHealth: null,
    reset: null,
    harnessExit: null,
    evaluation: null,
    bridgeError: null,
    harnessError: null,
    evaluationError: null,
    cleanupErrors: [],
  };
  let client;
  try {
    const port = await waitForReady(bridge);
    client = new OsworldBridgeClient({ baseUrl: `http://127.0.0.1:${port}`, ...(token === undefined ? {} : { token }) });
    const signal = new AbortController().signal;
    result.bridgeHealth = await client.health(signal);
    result.reset = await client.reset(taskId, signal);
    const cliArgs = [
      "--goal", result.reset.instruction,
      "--model", model,
      "--computer", "osworld",
      "--osworld-bridge", `http://127.0.0.1:${port}`,
      "--max-steps", String(maxSteps),
      "--max-model-requests", String(maxModelRequests),
      "--output", resolve(output, "harness"),
      ...(envFile === undefined ? [] : ["--env-file", resolve(envFile)]),
      ...(model === "qwen3.8-flash" ? ["--qwen-coordinate-mode", qwenCoordinateMode, "--qwen-thinking", qwenThinking, "--qwen-output-mode", qwenOutputMode] : []),
    ];
    try {
      result.harnessExit = await runCli(cliPath, cliArgs, process.env);
    } catch (error) {
      result.harnessError = { message: error instanceof Error ? error.message : String(error) };
    }
    try {
      result.evaluation = await client.evaluate(signal);
    } catch (error) {
      result.evaluationError = { message: error instanceof Error ? error.message : String(error) };
    }
  } catch (error) {
    result.bridgeError = { message: error instanceof Error ? error.message : String(error) };
  } finally {
    if (client !== undefined) {
      try { await client.close(new AbortController().signal); } catch (error) {
        result.cleanupErrors.push({ operation: "bridge.close", message: error instanceof Error ? error.message : String(error) });
      }
    }
    try { await stop(bridge); } catch (error) {
      result.cleanupErrors.push({ operation: "bridge.process", message: error instanceof Error ? error.message : String(error) });
    }
    await mkdir(output, { recursive: true });
    await writeFile(resolve(output, "runner.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.bridgeError !== null || result.harnessError !== null || result.evaluationError !== null || result.cleanupErrors.length > 0 || result.harnessExit?.code !== 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
