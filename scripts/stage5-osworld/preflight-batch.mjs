import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OsworldBridgeClient, OsworldComputer } from "../../packages/computer-osworld/dist/index.js";

const execFileAsync = promisify(execFile);
const ID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu;

function value(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function required(argv, name) {
  const result = value(argv, name);
  if (result === undefined || result.trim().length === 0) throw new Error(`${name} is required`);
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
  if (process.platform === "win32" && child.pid !== undefined) {
    try { await execFileAsync("taskkill", ["/PID", String(child.pid), "/T", "/F"]); } catch { /* already exited */ }
    if (child.exitCode !== null) return;
  }
  child.kill("SIGTERM");
  await new Promise((resolveDone) => {
    const timer = setTimeout(resolveDone, 5_000);
    child.once("exit", () => { clearTimeout(timer); resolveDone(); });
  });
}

function candidateIds(documentText, includeReserve, selectedLabels) {
  try {
    const parsed = JSON.parse(documentText);
    if (Array.isArray(parsed?.tasks)) {
      const labels = selectedLabels === undefined ? undefined : new Set(selectedLabels);
      return parsed.tasks
        .filter((task) => task?.proposedSplit !== "reserve" || includeReserve)
        .filter((task) => labels === undefined || labels.has(task?.label))
        .map((task) => task?.taskId)
        .filter((taskId) => typeof taskId === "string" && taskId.length > 0);
    }
  } catch {
    // Keep compatibility with the original Markdown candidate document.
  }
  const primary = documentText.match(/## 首批 30 个正式候选[\s\S]*?(?=## 备用候选 10 个|$)/u)?.[0] ?? "";
  const reserve = documentText.match(/## 备用候选 10 个[\s\S]*/u)?.[0] ?? "";
  const text = includeReserve ? `${primary}\n${reserve}` : primary;
  return [...new Set(text.match(ID_RE) ?? [])];
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write("Usage: node scripts/stage5-osworld/preflight-batch.mjs --osworld-root <path> --path-to-vm <vmx> --snapshot-name <name> --candidate-doc <path> --python <python> --vmrun-path <vmrun> --output <dir> [--include-reserve] [--labels V06,V07]\n");
    return;
  }
  const osworldRoot = resolve(required(argv, "--osworld-root"));
  const vmx = resolve(required(argv, "--path-to-vm"));
  const snapshotName = required(argv, "--snapshot-name");
  const candidateDoc = resolve(required(argv, "--candidate-doc"));
  const python = required(argv, "--python");
  const vmrunPath = resolve(required(argv, "--vmrun-path"));
  const output = resolve(required(argv, "--output"));
  const includeReserve = argv.includes("--include-reserve");
  const labelsValue = value(argv, "--labels");
  const selectedLabels = labelsValue === undefined ? undefined : labelsValue.split(",").map((label) => label.trim()).filter(Boolean);
  const taskIds = candidateIds(await readFile(candidateDoc, "utf8"), includeReserve, selectedLabels);
  if (taskIds.length === 0) throw new Error("candidate document did not contain task IDs");
  await mkdir(output, { recursive: true });
  const osworldCommit = (await execFileAsync("git", ["-C", osworldRoot, "rev-parse", "HEAD"])).stdout.trim();
  const bridgeScript = resolve(fileURLToPath(new URL("../../integrations/osworld/bridge.py", import.meta.url)));
  const token = process.env.OSWORLD_BRIDGE_TOKEN;
  const child = spawn(python, [bridgeScript, "--osworld-root", osworldRoot, "--path-to-vm", vmx, "--snapshot-name", snapshotName, "--osworld-version", osworldCommit, "--vmrun-path", vmrunPath], {
    env: { ...process.env, ...(token === undefined ? {} : { OSWORLD_BRIDGE_TOKEN: token }) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const results = [];
  let client;
  try {
    const port = await waitForReady(child);
    client = new OsworldBridgeClient({ baseUrl: `http://127.0.0.1:${port}`, ...(token === undefined ? {} : { token }) });
    const health = await client.health(new AbortController().signal);
    for (const [index, taskId] of taskIds.entries()) {
      const row = { index: index + 1, taskId, status: "failed", reset: null, initial: null, wait: null, postAction: null, evaluation: null, resetAfterEvaluate: null, error: null };
      const taskOutput = resolve(output, `${String(index + 1).padStart(2, "0")}-${taskId}`);
      await mkdir(taskOutput, { recursive: true });
      try {
        const signal = new AbortController().signal;
        row.reset = await client.reset(taskId, signal);
        const computer = new OsworldComputer({ bridge: client });
        const session = await computer.open({}, signal);
        const initial = await computer.observe(session, `preflight-${index + 1}-initial`, signal);
        await writeFile(resolve(taskOutput, "initial.png"), initial.screenshot.data);
        row.initial = { viewport: initial.viewport, byteLength: initial.screenshot.data.byteLength, sessionId: session.id };
        row.wait = await computer.execute(session, { actionId: `preflight-${index + 1}-wait`, kind: "wait", durationMs: 100 }, signal);
        const post = await computer.observe(session, `preflight-${index + 1}-post`, signal);
        await writeFile(resolve(taskOutput, "post-action.png"), post.screenshot.data);
        row.postAction = { viewport: post.viewport, byteLength: post.screenshot.data.byteLength };
        await computer.close(session);
        row.evaluation = await client.evaluate(signal);
        row.resetAfterEvaluate = await client.reset(taskId, signal);
        const resetSession = await computer.open({}, signal);
        const resetObservation = await computer.observe(resetSession, `preflight-${index + 1}-reset`, signal);
        await writeFile(resolve(taskOutput, "reset-after-evaluate.png"), resetObservation.screenshot.data);
        await computer.close(resetSession);
        row.status = "pass";
      } catch (error) {
        row.error = { message: error instanceof Error ? error.message : String(error) };
      }
      results.push(row);
      await writeFile(resolve(taskOutput, "summary.json"), `${JSON.stringify(row, null, 2)}\n`, "utf8");
      process.stdout.write(`${JSON.stringify({ index: row.index, taskId, status: row.status, score: row.evaluation?.score ?? null, error: row.error })}\n`);
    }
    const summary = { kind: "osworld-candidate-dynamic-preflight", osworldRoot, osworldCommit, snapshotName, candidateDocument: candidateDoc, includeReserve, taskCount: taskIds.length, health, passed: results.filter((row) => row.status === "pass").length, failed: results.filter((row) => row.status !== "pass").length, results };
    await writeFile(resolve(output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    if (summary.failed > 0) process.exitCode = 1;
  } finally {
    if (client !== undefined) {
      try { await client.close(new AbortController().signal); } catch { /* cleanup is best effort */ }
    }
    await stop(child);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
