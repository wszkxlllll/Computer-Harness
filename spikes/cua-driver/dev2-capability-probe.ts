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

interface Options {
  output: string;
  session: string;
  socket: string;
}

interface OperationSummary {
  returned: boolean;
  shape: string;
  isError: boolean | null;
  errorCode: string | null;
  degraded: boolean | null;
  textLength: number;
  structuredLength: number;
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function required(args: readonly string[], name: string): string {
  const value = option(args, name);
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function normalizePipe(value: string): string {
  if (process.platform !== "win32") return value;
  const match = value.match(/^\\+\.\\+pipe\\+(.*)$/iu);
  if (match === null || match[1] === undefined) return value;
  return `\\\\.\\pipe\\${match[1].replace(/\\+/gu, "\\")}`;
}

function parseOptions(args: readonly string[]): Options {
  const output = resolve(option(args, "--output") ?? join("runs", "dev2-capabilities"));
  const session = option(args, "--session") ?? "dev2-capabilities";
  return { output, session, socket: normalizePipe(required(args, "--socket")) };
}

function shapeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  return typeof value;
}

function operationSummary(value: unknown): OperationSummary {
  if (value === undefined) {
    return { returned: false, shape: "undefined", isError: null, errorCode: null, degraded: null, textLength: 0, structuredLength: 0 };
  }
  if (typeof value !== "object" || value === null) {
    return { returned: true, shape: shapeOf(value), isError: null, errorCode: null, degraded: null, textLength: 0, structuredLength: 0 };
  }
  const record = value as Record<string, unknown>;
  return {
    returned: true,
    shape: shapeOf(value),
    isError: typeof record.isError === "boolean" ? record.isError : null,
    errorCode: typeof record.errorCode === "string" ? record.errorCode : null,
    degraded: typeof record.degraded === "boolean" ? record.degraded : null,
    textLength: typeof record.text === "string" ? record.text.length : 0,
    structuredLength: typeof record.structuredJson === "string" ? record.structuredJson.length : 0,
  };
}

function inventorySummary(raw: string | undefined): { shape: string; count: number; names: string[] } {
  if (raw === undefined) return { shape: "unavailable", count: 0, names: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { shape: "non-json", count: 0, names: [] };
  }
  const tools = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).tools)
      ? (parsed as Record<string, unknown>).tools as unknown[]
      : [];
  const names = tools.flatMap((tool) => {
    if (tool === null || typeof tool !== "object" || Array.isArray(tool)) return [];
    const record = tool as Record<string, unknown>;
    return typeof record.name === "string" ? [record.name] : [];
  });
  return { shape: Array.isArray(parsed) ? "array" : tools.length > 0 ? "object.tools" : shapeOf(parsed), count: tools.length, names };
}

function errorCode(error: unknown): string | null {
  if (error === null || typeof error !== "object" || Array.isArray(error)) return null;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" ? code : null;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  await mkdir(options.output, { recursive: true });
  const startedAt = new Date().toISOString();
  const errors: Array<{ operation: string; code: string | null }> = [];
  const operations: Record<string, OperationSummary> = {};
  const record = async <T>(name: string, task: () => Promise<T>): Promise<T | undefined> => {
    try {
      const result = await task();
      operations[name] = operationSummary(result);
      return result;
    } catch (error) {
      operations[name] = { returned: false, shape: "error", isError: null, errorCode: errorCode(error), degraded: null, textLength: 0, structuredLength: 0 };
      errors.push({ operation: name, code: errorCode(error) });
      return undefined;
    }
  };

  const driver: CuaDriverLike = CuaDriver.connect(options.socket);
  let started = false;
  let toolsJson: string | undefined;
  try {
    await record("metadata", () => driver.metadata({ signal: new AbortController().signal }));
    toolsJson = await record("listToolsJson", () => driver.listToolsJson({ signal: new AbortController().signal }));
    const start = await record("startSession", () => driver.startSession(StartSessionInput.new({ session: options.session }), { signal: new AbortController().signal }));
    started = start !== undefined;
    await record("getSession", () => driver.getSession(GetSessionInput.new({ session: options.session }), { signal: new AbortController().signal }));
    await record("getSessionState", () => driver.getSessionState(GetSessionStateInput.new({ session: options.session }), { signal: new AbortController().signal }));
    await record("listSessions", () => driver.listSessions(ListSessionsInput.new({ limit: 20 }), { signal: new AbortController().signal }));
    await record("listHostSessionsJson", () => driver.listHostSessionsJson({ signal: new AbortController().signal }));
    await record("getSessionGeneric", () => driver.callTool("get_session", JSON.stringify({ session: options.session }), { signal: new AbortController().signal }));
    await record("getSessionStateGeneric", () => driver.callTool("get_session_state", JSON.stringify({ session: options.session }), { signal: new AbortController().signal }));
    await record("healthReport", () => driver.callTool("health_report", "{}", { signal: new AbortController().signal }));
    await record("checkPermissions", () => driver.callTool("check_permissions", "{}", { signal: new AbortController().signal }));
  } finally {
    if (started) await record("endSession", () => driver.endSession(EndSessionInput.new({ session: options.session }), { signal: new AbortController().signal }).then(() => undefined));
    await record("shutdown", () => driver.shutdown({ signal: new AbortController().signal }));
    (driver as unknown as { uniffiDestroy?: () => void }).uniffiDestroy?.();
  }

  const inventory = inventorySummary(toolsJson);
  const report = {
    probeVersion: "dev2-capabilities-0.1.0",
    startedAt,
    completedAt: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, node: process.version },
    transport: { mode: "daemon", socketProvided: true },
    inventory,
    operations,
    errors,
    // No provider text, window titles, paths, or raw tool result fields are
    // persisted in this summary.
  };
  await writeFile(join(options.output, "capability-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const ok = errors.length === 0 && inventory.count > 0 && Object.entries(operations).every(([name, status]) => name === "endSession" || name === "shutdown" || (status.returned && status.isError !== true));
  process.exitCode = ok ? 0 : 1;
  console.log(JSON.stringify({ ok, output: options.output, inventory, errors }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.name : "probe_error");
  process.exitCode = 1;
});
