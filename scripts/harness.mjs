#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, readFile } from "node:fs/promises";
import { constants as fsConstants, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_NODE = [22, 13, 0];
const EXPECTED_PNPM = "11.19.0";
const EXPECTED_CUA = "0.22.2";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localConfigPath = join(root, ".harness.local.json");

function usage() {
  return `Computer Harness local environment

Usage: pnpm harness <command> [options]

Commands:
  check             Check Node, pnpm, dependencies, build, CUA and browser
  setup             Install frozen dependencies, build and run offline tests
  daemon            Run the pinned CUA daemon in the foreground
  doctor            Start a private daemon, run the no-model Harness doctor, stop it
  probe-readonly    Start a private daemon and capture one local screenshot (no input)
  probe             Run the owned-browser click/type/scroll probe (requires --allow-input)
  dom-probe         Verify managed-browser DOM/hybrid mode; add --allow-input for click/type/scroll
  stop              Stop the configured private daemon
  permissions       Read the CUA app's macOS permission status without prompting
  help              Show this message

Options:
  --allow-input      Required for probe; it opens and controls only an owned browser profile
  --output <path>    Override the ignored local output directory

Machine-local overrides live in .harness.local.json (ignored by Git).
No command reads provider credentials or calls a model API.
`;
}

function option(args, name) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function commandPath(name) {
  const result = spawnSync(process.platform === "win32" ? "where.exe" : "which", [name], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/u)[0] : undefined;
}

function defaultBrowser() {
  const candidates = process.platform === "darwin"
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
      ]
    : process.platform === "win32"
      ? [
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        ]
      : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return candidates.find(existsSync);
}

function defaultSocket() {
  if (process.platform === "win32") return "\\\\.\\pipe\\computer-harness-local";
  return join(tmpdir(), `computer-harness-${typeof process.getuid === "function" ? process.getuid() : "local"}.sock`);
}

function resolveLocal(value) {
  return isAbsolute(value) ? value : resolve(root, value);
}

async function readConfig() {
  let local = {};
  if (existsSync(localConfigPath)) {
    const parsed = JSON.parse(await readFile(localConfigPath, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(".harness.local.json must contain one JSON object");
    }
    local = parsed;
  }
  const binary = typeof local.cuaBinary === "string" && local.cuaBinary.trim()
    ? resolveLocal(local.cuaBinary)
    : commandPath("cua-driver");
  const browser = typeof local.browser === "string" && local.browser.trim()
    ? resolveLocal(local.browser)
    : defaultBrowser();
  return {
    binary,
    browser,
    socket: typeof local.cuaSocket === "string" && local.cuaSocket.trim() ? local.cuaSocket : defaultSocket(),
    outputRoot: resolveLocal(typeof local.outputRoot === "string" && local.outputRoot.trim() ? local.outputRoot : "runs/local"),
  };
}

function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: root,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

function checked(file, args, label, options = {}) {
  const result = run(file, args, options);
  if (result.status !== 0) {
    const detail = options.inherit ? "" : `\n${result.stdout ?? ""}${result.stderr ?? ""}`.trimEnd();
    throw new Error(`${label} failed with exit code ${result.status}${detail}`);
  }
  return result;
}

function versionFrom(raw) {
  return raw.match(/(\d+\.\d+\.\d+)/u)?.[1];
}

function atLeast(actual, minimum) {
  const parts = actual.split(".").map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    const current = parts[index] ?? 0;
    if (current > minimum[index]) return true;
    if (current < minimum[index]) return false;
  }
  return true;
}

async function executable(path) {
  if (!path) return false;
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function inspect(config) {
  const nodeVersion = process.versions.node;
  const pnpmPath = commandPath("pnpm");
  const pnpmVersion = pnpmPath ? versionFrom(`${run(pnpmPath, ["--version"]).stdout}`) : undefined;
  const cuaReady = await executable(config.binary);
  const cuaResult = cuaReady ? run(config.binary, ["--version"]) : undefined;
  const cuaVersion = cuaResult ? versionFrom(`${cuaResult.stdout}${cuaResult.stderr}`) : undefined;
  const browserReady = await executable(config.browser);
  return {
    repository: root,
    platform: process.platform,
    architecture: process.arch,
    node: { version: nodeVersion, ok: atLeast(nodeVersion, EXPECTED_NODE), expected: ">=22.13.0" },
    pnpm: { path: pnpmPath ?? null, version: pnpmVersion ?? null, ok: pnpmVersion === EXPECTED_PNPM, expected: EXPECTED_PNPM },
    dependencies: { present: existsSync(join(root, "node_modules")) },
    build: { present: existsSync(join(root, "apps/cli/dist/index.js")) },
    cua: { path: config.binary ?? null, version: cuaVersion ?? null, ok: cuaVersion === EXPECTED_CUA, expected: EXPECTED_CUA },
    browser: { path: config.browser ?? null, ok: browserReady },
    socket: config.socket,
    outputRoot: config.outputRoot,
  };
}

function printCheck(report) {
  const mark = (ok) => ok ? "OK" : "NOT READY";
  console.log(`Repository : ${report.repository}`);
  console.log(`Host       : ${report.platform}/${report.architecture}`);
  console.log(`Node       : ${mark(report.node.ok)} ${report.node.version} (expected ${report.node.expected})`);
  console.log(`pnpm       : ${mark(report.pnpm.ok)} ${report.pnpm.version ?? "missing"} (expected ${report.pnpm.expected})`);
  console.log(`Dependencies: ${mark(report.dependencies.present)}`);
  console.log(`CLI build  : ${mark(report.build.present)}`);
  console.log(`CUA        : ${mark(report.cua.ok)} ${report.cua.version ?? "missing"} at ${report.cua.path ?? "unresolved"} (expected ${report.cua.expected})`);
  console.log(`Browser    : ${mark(report.browser.ok)} ${report.browser.path ?? "unresolved"}`);
  console.log(`Socket     : ${report.socket}`);
  console.log(`Output     : ${report.outputRoot}`);
}

async function requireCua(config) {
  const report = await inspect(config);
  if (!report.cua.ok) throw new Error(`CUA ${EXPECTED_CUA} is required; found ${report.cua.version ?? "nothing"} at ${report.cua.path ?? "no path"}`);
  return report;
}

function waitForDaemon(binary, socket, child) {
  return new Promise((resolveReady, reject) => {
    const deadline = Date.now() + 15_000;
    const poll = () => {
      if (child.exitCode !== null || child.signalCode !== null) return reject(new Error("CUA daemon exited before readiness"));
      const status = run(binary, ["status", "--socket", socket]);
      if (status.status === 0) return resolveReady();
      if (Date.now() >= deadline) return reject(new Error("CUA daemon readiness timed out"));
      setTimeout(poll, 250);
    };
    poll();
  });
}

async function stopDaemon(config) {
  if (!config.binary) return;
  run(config.binary, ["stop", "--socket", config.socket]);
}

async function withDaemon(config, task) {
  await requireCua(config);
  const child = spawn(config.binary, ["serve", "--socket", config.socket, "--no-overlay"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    await waitForDaemon(config.binary, config.socket, child);
    return await task();
  } finally {
    await stopDaemon(config);
    const deadline = Date.now() + 5_000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    if (child.exitCode === null && child.signalCode === null) child.kill();
    if (child.exitCode && stderr.trim()) process.stderr.write(stderr);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? "help";
  const config = await readConfig();
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(usage());
    return;
  }
  if (command === "check") {
    const report = await inspect(config);
    printCheck(report);
    if (!report.node.ok || !report.pnpm.ok || !report.dependencies.present || !report.build.present || !report.cua.ok || !report.browser.ok) process.exitCode = 1;
    return;
  }
  if (command === "setup") {
    const pnpm = commandPath("pnpm");
    if (!pnpm) throw new Error("pnpm was not found");
    checked(pnpm, ["install", "--frozen-lockfile"], "frozen dependency install", { inherit: true });
    checked(pnpm, ["run", "build"], "build", { inherit: true });
    checked(pnpm, ["test"], "offline tests", { inherit: true });
    printCheck(await inspect(config));
    return;
  }
  if (command === "daemon") {
    await requireCua(config);
    console.log(`Starting CUA ${EXPECTED_CUA} on ${config.socket}; press Ctrl+C to stop.`);
    const result = run(config.binary, ["serve", "--socket", config.socket, "--no-overlay"], { inherit: true });
    process.exitCode = result.status ?? 1;
    return;
  }
  if (command === "stop") {
    await requireCua(config);
    await stopDaemon(config);
    return;
  }
  if (command === "permissions") {
    if (!config.binary) throw new Error("cua-driver was not found");
    const result = run(config.binary, ["permissions", "status", "--json"], { inherit: true });
    process.exitCode = result.status ?? 1;
    return;
  }
  if (command === "doctor") {
    const cli = join(root, "apps/cli/dist/index.js");
    if (!existsSync(cli)) throw new Error("CLI is not built; run `pnpm harness setup` first");
    await withDaemon(config, async () => {
      const result = run(process.execPath, [cli, "--doctor", "--computer", "cua", "--cua-socket", config.socket, "--doctor-timeout-ms", "15000"], { inherit: true });
      if (result.status !== 0) process.exitCode = result.status ?? 1;
    });
    return;
  }
  if (command === "probe-readonly") {
    await requireCua(config);
    const output = resolveLocal(option(args, "--output") ?? join(config.outputRoot, `readonly-${Date.now()}`));
    await mkdir(output, { recursive: true });
    const probe = join(root, "spikes/cua-driver/probe-daemon.ts");
    const pnpm = commandPath("pnpm");
    checked(pnpm, ["--filter", "@computer-harness/cua-driver-spike", "exec", "tsx", probe, "--binary", config.binary, "--socket", config.socket, "--output", output], "read-only CUA probe", { inherit: true });
    return;
  }
  if (command === "probe") {
    if (!args.includes("--allow-input")) throw new Error("probe requires --allow-input because it clicks and types inside an owned browser fixture");
    await requireCua(config);
    if (!(await executable(config.browser))) throw new Error("a supported browser was not found; set browser in .harness.local.json");
    const output = resolveLocal(option(args, "--output") ?? join(config.outputRoot, `browser-probe-${Date.now()}`));
    await mkdir(output, { recursive: true });
    const probe = join(root, "spikes/cua-driver/browser-adapter-probe.ts");
    const pnpm = commandPath("pnpm");
    checked(pnpm, ["--filter", "@computer-harness/cua-driver-spike", "exec", "tsx", probe, "--allow-input", "--binary", config.binary, "--browser", config.browser, "--socket", config.socket, "--output", output], "owned-browser CUA probe", { inherit: true });
    return;
  }
  if (command === "dom-probe") {
    await requireCua(config);
    if (!(await executable(config.browser))) throw new Error("a supported browser was not found; set browser in .harness.local.json");
    const pilot = join(root, "scripts/managed-browser-dom-pilot.ts");
    const pnpm = commandPath("pnpm");
    await withDaemon(config, async () => {
      checked(pnpm, ["--filter", "@computer-harness/cua-driver-spike", "exec", "tsx", pilot, ...(args.includes("--allow-input") ? ["--allow-input"] : [])], "managed browser DOM probe", {
        inherit: true,
        env: { ...process.env, COMPUTER_HARNESS_CUA_SOCKET: config.socket },
      });
    });
    return;
  }
  throw new Error(`unknown command: ${command}\n\n${usage()}`);
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export { atLeast, defaultSocket, versionFrom };
