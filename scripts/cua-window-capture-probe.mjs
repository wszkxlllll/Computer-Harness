import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CuaDriverComputer } from "../packages/computer-cua/dist/index.js";
import { sanitizeTerminalText } from "../apps/cli/dist/terminal-output.js";

const { CuaDriver } = await import("../packages/computer-cua/node_modules/@trycua/cua-driver/dist/index.js");

function arg(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function required(name) {
  const value = arg(name);
  if (value === undefined || value.length === 0) throw new Error(`Missing ${name}`);
  return value;
}

function positiveInteger(name) {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function safeText(value, limit = 240) {
  if (typeof value !== "string") return undefined;
  return sanitizeTerminalText(value)
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/giu, "$1[redacted]")
    .replace(/(bearer\s+)[A-Za-z0-9._~+\-/]+=*/giu, "$1[redacted]")
    .replace(/([?&](?:api[_-]?key|access[_-]?token|auth(?:orization)?|token|secret|password|signature|sig)=)[^&\s]+/giu, "$1[redacted]")
    .replace(/((?:api[_-]?key|access[_-]?token|auth(?:orization)?|token|secret|password)\s*[:=]\s*)[^\s,;]+/giu, "$1[redacted]")
    .replace(/(https?:\/\/)[^/\s@]+@/giu, "$1[redacted]@")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[redacted-email]")
    .replace(/\b1\d{10}\b/gu, "[redacted-phone]")
    .replace(/\b[A-Z]:\\[^\s,;]+/giu, "[redacted-path]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, limit);
}

function safeErrorCode(value) {
  const sanitized = safeText(value, 64);
  return sanitized !== undefined && /^[A-Za-z0-9_.-]{1,64}$/u.test(sanitized)
    ? sanitized
    : sanitized === undefined ? undefined : "[redacted-code]";
}

function uint32be(buffer, offset) {
  return buffer.length >= offset + 4 ? buffer.readUInt32BE(offset) : undefined;
}

function imageSummary(images) {
  const list = Array.isArray(images) ? images : [];
  return {
    imageCount: list.length,
    images: list.slice(0, 4).map((image) => {
      const mimeType = safeText(image?.mimeType, 64) ?? "unknown";
      const dataBase64 = typeof image?.dataBase64 === "string" ? image.dataBase64 : "";
      const metadata = { mimeType, encodedChars: dataBase64.length };
      if (mimeType === "image/png" && dataBase64.length >= 32) {
        const header = Buffer.from(dataBase64.slice(0, 44), "base64");
        if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
          const width = uint32be(header, 16);
          const height = uint32be(header, 20);
          if (width !== undefined && height !== undefined) Object.assign(metadata, { width, height });
        }
      }
      return metadata;
    }),
    imagesTruncated: list.length > 4,
  };
}

function resultMetadata(tool, result, inputTargetMatches) {
  const metadata = {
    tool,
    inputTargetMatches,
    isError: result?.isError === true,
    degraded: result?.degraded === true,
    ...imageSummary(result?.images),
  };
  const errorCode = safeErrorCode(result?.errorCode);
  if (errorCode !== undefined) metadata.errorCode = errorCode;
  if (result?.isError === true) {
    const text = safeText(result?.text);
    if (text !== undefined) metadata.text = text;
  }
  const verification = result?.verification;
  if (verification !== undefined) {
    const status = verification.status;
    metadata.verification = {
      ...(typeof status === "string" || typeof status === "number" ? { status } : {}),
      stable: typeof verification.stable === "boolean" ? verification.stable : undefined,
    };
  }
  return metadata;
}

function positiveBound(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function exactWindowFromList(result, target) {
  if (typeof result?.structuredJson !== "string") return undefined;
  try {
    const parsed = JSON.parse(result.structuredJson);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.windows)) return undefined;
    const item = parsed.windows.find((window) =>
      window && typeof window === "object" &&
      window.pid === target.pid && window.window_id === target.windowId);
    if (item === undefined) return undefined;
    const bounds = item.bounds;
    if (!bounds || typeof bounds !== "object") return { pid: target.pid, windowId: target.windowId };
    const x = Number.isSafeInteger(bounds.x) ? bounds.x : undefined;
    const y = Number.isSafeInteger(bounds.y) ? bounds.y : undefined;
    const width = positiveBound(bounds.width);
    const height = positiveBound(bounds.height);
    return {
      pid: target.pid,
      windowId: target.windowId,
      ...(x === undefined ? {} : { x }),
      ...(y === undefined ? {} : { y }),
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
    };
  } catch {
    return undefined;
  }
}

function inputMatchesVerifyTarget(input, target) {
  try {
    return BigInt(input.pid) === BigInt(target.pid) && BigInt(input.windowId) === BigInt(target.windowId);
  } catch {
    return false;
  }
}

function inputMatchesToolTarget(name, input, target, session) {
  if (name === "list_windows") {
    return input?.pid === target.pid && input?.on_screen_only === true && input?.session === session;
  }
  return name === "get_window_state" && input?.pid === target.pid && input?.window_id === target.windowId &&
    input?.include_screenshot === true && input?.session === session;
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write("Usage: node scripts/cua-window-capture-probe.mjs --socket <pipe> --pid <pid> --window-id <hwnd>\nRuns one CuaDriverComputer.open/close capture path for the exact window in background mode. No input, activation, desktop capture, raw JSON, or image bytes are emitted.\n");
    return;
  }

  const socketPath = required("--socket");
  const target = { pid: positiveInteger("--pid"), windowId: positiveInteger("--window-id") };
  const runId = `${new Date().toISOString().replace(/[.:]/gu, "-")}-${randomUUID()}`;
  const outputDir = join(resolve("runs", "diagnostics", "cua-window-capture-probe"), runId);
  await mkdir(outputDir, { recursive: true });
  const manifestPath = join(outputDir, "probe.json");
  const sessionLabel = `cua-window-probe-${randomUUID()}`;
  const manifest = {
    schemaVersion: 1,
    runId,
    status: "starting",
    startedAt: new Date().toISOString(),
    target,
    sessionMode: "named",
    deliveryMode: "background",
    noInputCalls: true,
    noDesktopCaptureFallback: true,
    events: [],
  };
  const save = async () => writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const record = async (event) => {
    manifest.events.push({ occurredAt: new Date().toISOString(), ...event });
    await save();
    process.stdout.write(`${JSON.stringify(event)}\n`);
  };
  await save();
  process.stdout.write(`${JSON.stringify({ stage: "artifacts", outputDir, manifest: manifestPath, target })}\n`);

  const driverFactory = (path) => {
    const driver = CuaDriver.connect(path);
    return new Proxy(driver, {
      get(nativeDriver, property) {
        const original = Reflect.get(nativeDriver, property, nativeDriver);
        if (property === "verifyState") {
          return async (input, options) => {
            const inputTargetMatches = inputMatchesVerifyTarget(input, target);
            if (!inputTargetMatches) {
              await record({ stage: "blocked", tool: "verify_state", reason: "exact_target_mismatch" });
              throw new Error("probe blocked verify_state for a different target");
            }
            const result = await Reflect.apply(original, nativeDriver, [input, options]);
            await record({ stage: "tool_result", ...resultMetadata("verify_state", result, true) });
            return result;
          };
        }
        if (property === "callTool") {
          return async (name, inputJson, options) => {
            if (name !== "list_windows" && name !== "get_window_state") {
              await record({ stage: "blocked", tool: safeText(name, 64) ?? "unknown", reason: "not_read_only_target_capture" });
              throw new Error("probe allows only list_windows and get_window_state");
            }
            let input;
            try {
              input = JSON.parse(inputJson);
            } catch {
              await record({ stage: "blocked", tool: name, reason: "invalid_tool_arguments" });
              throw new Error("probe blocked invalid tool arguments");
            }
            const inputTargetMatches = inputMatchesToolTarget(name, input, target, sessionLabel);
            if (!inputTargetMatches) {
              await record({ stage: "blocked", tool: name, reason: "exact_target_or_session_mismatch" });
              throw new Error("probe blocked a non-exact target/session tool call");
            }
            const result = await Reflect.apply(original, nativeDriver, [name, inputJson, options]);
            if (name === "list_windows") {
              const exactWindow = exactWindowFromList(result, target);
              await record({
                stage: "window_inventory",
                tool: name,
                inputTargetMatches: true,
                isError: result?.isError === true,
                degraded: result?.degraded === true,
                exactTargetListed: exactWindow !== undefined,
                ...(exactWindow === undefined ? {} : { exactWindow }),
                ...(result?.isError === true && safeErrorCode(result?.errorCode) !== undefined ? { errorCode: safeErrorCode(result.errorCode) } : {}),
                ...(result?.isError === true && safeText(result?.text) !== undefined ? { text: safeText(result.text) } : {}),
              });
            } else {
              await record({ stage: "tool_result", ...resultMetadata(name, result, true) });
            }
            return result;
          };
        }
        return typeof original === "function" ? original.bind(nativeDriver) : original;
      },
    });
  };

  const computer = new CuaDriverComputer({
    socketPath,
    screenshotDir: join(outputDir, "unused-no-desktop-captures"),
    sessionLabel,
    windowTarget: target,
    windowDeliveryMode: "background",
    driverFactory,
  });
  let session;
  let runError;
  const signal = AbortSignal.timeout(90_000);
  try {
    session = await computer.open({}, signal);
    manifest.status = "opened";
    manifest.viewport = session.viewport;
    await save();
    process.stdout.write(`${JSON.stringify({ stage: "open_completed", viewport: session.viewport })}\n`);
  } catch (error) {
    manifest.status = "open_failed";
    manifest.error = safeText(error instanceof Error ? error.message : String(error));
    runError = error;
  } finally {
    if (session !== undefined) {
      try {
        await computer.close(session);
        manifest.closed = true;
      } catch (error) {
        manifest.closeError = safeText(error instanceof Error ? error.message : String(error));
      }
    }
    manifest.finishedAt = new Date().toISOString();
    await save();
  }

  process.stdout.write(`${JSON.stringify({ stage: "finished", status: manifest.status, runDirectory: outputDir, manifest: manifestPath })}\n`);
  if (runError !== undefined) process.exitCode = 1;
  if (manifest.closeError !== undefined) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${safeText(error instanceof Error ? error.message : String(error)) ?? "probe failed"}\n`);
  process.exitCode = 1;
});
