import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  CuaDriver,
  EndSessionInput,
  GetSessionInput,
  GetSessionStateInput,
  ListSessionsInput,
  StartSessionInput,
  type CuaDriverLike,
} from "@trycua/cua-driver";

interface ProbeOptions {
  outputDir: string;
  session: string;
  socketPath?: string;
}

interface ProbeError {
  operation: string;
  message: string;
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseOptions(args: string[]): ProbeOptions {
  const session = readOption(args, "--session") ?? `capability-probe-${Date.now()}`;
  const outputDir = resolve(readOption(args, "--output") ?? join("runs", session));
  const socketPath = readOption(args, "--socket");
  return socketPath === undefined ? { outputDir, session } : { outputDir, session, socketPath };
}

function jsonSafe(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "bigint") {
    return `${value.toString()}n`;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  if (value instanceof Uint8Array) {
    return { byteLength: value.byteLength };
  }
  if (Array.isArray(value)) {
    return value.map((item) => jsonSafe(item, seen));
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = jsonSafe(item, seen);
  }
  return output;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(jsonSafe(value), null, 2)}\n`, "utf8");
}

function parseInventory(raw: string): { shape: string; tools: unknown[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { shape: "non-json", tools: [] };
  }
  if (Array.isArray(parsed)) {
    return { shape: "array", tools: parsed };
  }
  if (parsed && typeof parsed === "object") {
    const tools = (parsed as Record<string, unknown>).tools;
    if (Array.isArray(tools)) {
      return { shape: "object.tools", tools };
    }
  }
  return { shape: typeof parsed, tools: [] };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  await mkdir(options.outputDir, { recursive: true });
  const errors: ProbeError[] = [];
  const startedAt = new Date().toISOString();
  const driver: CuaDriverLike = options.socketPath === undefined
    ? CuaDriver.create(undefined)
    : CuaDriver.connect(options.socketPath);
  const signal = new AbortController().signal;
  let sessionStarted = false;
  let reportBase: Record<string, unknown> | undefined;

  const record = async <T>(operation: string, task: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await task();
    } catch (error) {
      errors.push({ operation, message: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  };

  try {
    const metadata = await record("metadata", () => driver.metadata({ signal }));
    const toolsJson = await record("listToolsJson", () => driver.listToolsJson({ signal }));
    const inventory = toolsJson === undefined ? { shape: "unavailable", tools: [] } : parseInventory(toolsJson);
    await writeJson(join(options.outputDir, "metadata.json"), metadata ?? { unavailable: true });
    await writeJson(join(options.outputDir, "tools.json"), {
      rawJson: toolsJson ?? null,
      shape: inventory.shape,
      count: inventory.tools.length,
      tools: inventory.tools,
    });

    const start = await record("startSession", () =>
      driver.startSession(StartSessionInput.new({ session: options.session }), { signal }),
    );
    sessionStarted = start !== undefined;
    const typedSession = await record("getSession", () =>
      driver.getSession(GetSessionInput.new({ session: options.session }), { signal }),
    );
    const typedState = await record("getSessionState", () =>
      driver.getSessionState(GetSessionStateInput.new({ session: options.session }), { signal }),
    );
    const listedSessions = await record("listSessions", () =>
      driver.listSessions(ListSessionsInput.new({ limit: 20 }), { signal }),
    );
    const hostSessionsJson = await record("listHostSessionsJson", () =>
      driver.listHostSessionsJson({ signal }),
    );
    const genericSession = await record("callTool:get_session", () =>
      driver.callTool("get_session", JSON.stringify({ session: options.session }), { signal }),
    );
    const genericState = await record("callTool:get_session_state", () =>
      driver.callTool("get_session_state", JSON.stringify({ session: options.session }), { signal }),
    );
    const healthReport = await record("callTool:health_report", () =>
      driver.callTool("health_report", "{}", { signal }),
    );
    const permissionReport = await record("callTool:check_permissions", () =>
      driver.callTool("check_permissions", "{}", { signal }),
    );
    await writeJson(join(options.outputDir, "session-views.json"), {
      typedSession,
      typedState,
      listedSessions,
      hostSessionsJson,
      genericSession,
      genericState,
      healthReport,
      permissionReport,
    });

    reportBase = {
      probeVersion: "0.3.0-capabilities",
      startedAt,
      host: { platform: process.platform, arch: process.arch, node: process.version },
      transport: {
        mode: options.socketPath === undefined ? "embedded" : "daemon",
        socketPath: options.socketPath,
        available: driver.isAvailable(),
        executionMode: driver.executionMode(),
        runtimeScopePrefix: driver.runtimeScopePrefix(),
      },
      inventory: { shape: inventory.shape, count: inventory.tools.length },
      operations: {
        metadata: metadata !== undefined,
        listToolsJson: toolsJson !== undefined,
        startSession: start !== undefined,
        getSession: typedSession !== undefined,
        getSessionState: typedState !== undefined,
        listSessions: listedSessions !== undefined,
        listHostSessionsJson: hostSessionsJson !== undefined,
        genericGetSession: genericSession !== undefined,
        genericGetSessionState: genericState !== undefined,
        healthReport: healthReport !== undefined,
        checkPermissions: permissionReport !== undefined,
      },
      errors,
    };
  } finally {
    if (sessionStarted) {
      await record("endSession", () =>
        driver.endSession(EndSessionInput.new({ session: options.session }), { signal }).then(() => undefined),
      );
    }
    await record("shutdown", () => driver.shutdown({ signal }));
    const destroy = (driver as unknown as { uniffiDestroy?: () => void }).uniffiDestroy;
    destroy?.call(driver);
  }
  if (reportBase !== undefined) {
    reportBase.completedAt = new Date().toISOString();
    await writeJson(join(options.outputDir, "capability-report.json"), reportBase);
    const inventory = reportBase.inventory as { shape: string; count: number };
    console.log(JSON.stringify({
      ok: errors.length === 0,
      outputDir: options.outputDir,
      session: options.session,
      inventory,
      errors,
    }, null, 2));
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
