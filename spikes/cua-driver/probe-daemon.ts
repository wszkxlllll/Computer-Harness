import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join, resolve } from "node:path";
import {
  CuaDriver,
  EndSessionInput,
  GetDesktopStateInput,
  GetScreenSizeInput,
  StartSessionInput,
} from "@trycua/cua-driver";

interface ProbeOptions {
  binaryPath: string;
  outputDir: string;
  session: string;
  socketPath: string;
  startupTimeoutMs: number;
}

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function requiredOption(args: string[], name: string): string {
  const value = option(args, name);
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function normalizeWindowsNamedPipe(value: string): string {
  if (process.platform !== "win32") {
    return value;
  }
  // Nested pnpm/PowerShell forwarding can double each backslash. Keep the
  // canonical Windows named-pipe spelling expected by cua-driver.
  const match = value.match(/^\\+\.\\+pipe\\+(.*)$/i);
  if (!match) {
    return value;
  }
  return `\\\\.\\pipe\\${match[1].replace(/\\+/g, "\\")}`;
}

function parseOptions(args: string[]): ProbeOptions {
  const session = option(args, "--session") ?? `daemon-probe-${Date.now()}`;
  const startupTimeoutMs = Number(option(args, "--startup-timeout-ms") ?? "20000");
  if (!Number.isInteger(startupTimeoutMs) || startupTimeoutMs <= 0) {
    throw new Error("--startup-timeout-ms must be a positive integer");
  }
  return {
    binaryPath: resolve(requiredOption(args, "--binary")),
    outputDir: resolve(option(args, "--output") ?? join("runs", session)),
    session,
    socketPath: normalizeWindowsNamedPipe(requiredOption(args, "--socket")),
    startupTimeoutMs,
  };
}

function serializableToolResult(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  const candidate = value as Record<string, unknown>;
  const images = Array.isArray(candidate.images)
    ? candidate.images.map((image) => {
        if (!image || typeof image !== "object") {
          return image;
        }
        const record = image as Record<string, unknown>;
        return {
          mimeType: record.mimeType,
          dataBase64Bytes: typeof record.dataBase64 === "string" ? record.dataBase64.length : 0,
        };
      })
    : undefined;
  return {
    text: candidate.text,
    isError: candidate.isError,
    errorCode: candidate.errorCode,
    degraded: candidate.degraded,
    structuredJson: candidate.structuredJson,
    rawJson: candidate.rawJson,
    images,
    action: candidate.action,
    verification: candidate.verification,
  };
}

function parseJsonField(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const raw = (result as Record<string, unknown>).structuredJson;
  if (typeof raw !== "string") {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

async function readPngDimensions(path: string): Promise<{ width: number; height: number }> {
  const bytes = await readFile(path);
  if (bytes.length < 24 || bytes.toString("ascii", 1, 4) !== "PNG" || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error(`not a PNG with an IHDR header: ${path}`);
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function collectChild(child: ChildProcessWithoutNullStreams): Promise<ChildResult> {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  return new Promise((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveResult({ code, signal, stdout, stderr }));
  });
}

async function runCli(binaryPath: string, args: string[]): Promise<ChildResult> {
  return collectChild(spawn(binaryPath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }));
}

async function waitForDaemon(options: ProbeOptions, daemon: ChildProcessWithoutNullStreams): Promise<ChildResult> {
  const deadline = Date.now() + options.startupTimeoutMs;
  let last: ChildResult = { code: null, signal: null, stdout: "", stderr: "" };
  while (Date.now() < deadline) {
    if (daemon.exitCode !== null || daemon.signalCode !== null) {
      throw new Error(`daemon exited before readiness: ${last.stderr || "no stderr"}`);
    }
    last = await runCli(options.binaryPath, ["status", "--socket", options.socketPath]);
    if (last.code === 0 && /daemon is running/i.test(last.stdout)) {
      return last;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`daemon readiness timeout: ${last.stdout}\n${last.stderr}`);
}

async function stopDaemon(options: ProbeOptions, daemon: ChildProcessWithoutNullStreams): Promise<ChildResult> {
  const stopResult = await runCli(options.binaryPath, ["stop", "--socket", options.socketPath]);
  if (stopResult.code === 0 && daemon.exitCode === null && daemon.signalCode === null) {
    await new Promise<void>((resolveExit) => {
      const timer = setTimeout(resolveExit, 5000);
      daemon.once("close", () => {
        clearTimeout(timer);
        resolveExit();
      });
    });
  }
  if (daemon.exitCode === null && daemon.signalCode === null) {
    daemon.kill();
  }
  return stopResult;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  await mkdir(options.outputDir, { recursive: true });
  const daemon = spawn(options.binaryPath, ["serve", "--socket", options.socketPath, "--no-overlay"], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let daemonStdout = "";
  let daemonStderr = "";
  daemon.stdout.setEncoding("utf8");
  daemon.stderr.setEncoding("utf8");
  daemon.stdout.on("data", (chunk: string) => (daemonStdout += chunk));
  daemon.stderr.on("data", (chunk: string) => (daemonStderr += chunk));
  let driver: ReturnType<typeof CuaDriver.connect> | undefined;
  let ended = false;
  let stopResult: ChildResult | undefined;
  try {
    const status = await waitForDaemon(options, daemon);
    await writeFile(join(options.outputDir, "daemon-status.txt"), status.stdout, "utf8");
    driver = CuaDriver.connect(options.socketPath);
    const metadata = await driver.metadata();
    await writeFile(join(options.outputDir, "metadata.json"), JSON.stringify({
      probeVersion: "0.2.0-daemon",
      startedAt: new Date().toISOString(),
      host: { platform: process.platform, arch: process.arch, node: process.version },
      driver: metadata,
      options,
    }, null, 2), "utf8");
    await driver.startSession(StartSessionInput.new({ session: options.session }));
    const screenSize = await driver.getScreenSize(GetScreenSizeInput.new({ session: options.session }));
    await writeFile(join(options.outputDir, "screen-size.json"), JSON.stringify(serializableToolResult(screenSize), null, 2), "utf8");
    const screenshotPath = join(options.outputDir, "desktop.png");
    const desktop = await driver.getDesktopState(GetDesktopStateInput.new({ session: options.session, screenshotOutFile: screenshotPath }));
    await writeFile(join(options.outputDir, "desktop.json"), JSON.stringify(serializableToolResult(desktop), null, 2), "utf8");
    const dimensions = await readPngDimensions(screenshotPath);
    const reported = parseJsonField(desktop);
    await writeFile(join(options.outputDir, "comparison.json"), JSON.stringify({
      png: dimensions,
      reported: {
        screenWidth: reported?.screen_width,
        screenHeight: reported?.screen_height,
        screenshotWidth: reported?.screenshot_width,
        screenshotHeight: reported?.screenshot_height,
        scaleFactor: reported?.scale_factor,
      },
      inputExecuted: false,
    }, null, 2), "utf8");
    await driver.endSession(EndSessionInput.new({ session: options.session }));
    ended = true;
    console.log(JSON.stringify({ ok: true, outputDir: options.outputDir, session: options.session, dimensions, inputExecuted: false }, null, 2));
  } finally {
    await writeFile(join(options.outputDir, "daemon-stdout.log"), daemonStdout, "utf8");
    await writeFile(join(options.outputDir, "daemon-stderr.log"), daemonStderr, "utf8");
    if (driver) {
      try {
        if (!ended) {
          await driver.endSession(EndSessionInput.new({ session: options.session }));
        }
      } catch {
        // Preserve the original probe error.
      }
      try {
        await driver.shutdown();
      } finally {
        const destroy = (driver as unknown as { uniffiDestroy?: () => void }).uniffiDestroy;
        destroy?.call(driver);
      }
    }
    if (daemon.exitCode === null && daemon.signalCode === null) {
      stopResult = await stopDaemon(options, daemon);
    }
    if (stopResult) {
      await writeFile(join(options.outputDir, "daemon-stop.json"), JSON.stringify(stopResult, null, 2), "utf8");
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
