import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CuaDriver, EndSessionInput, StartSessionInput, type CuaDriverLike, type ToolResult } from "@trycua/cua-driver";

type RecordValue = Record<string, unknown>;
type Frame = { x: number; y: number; width: number; height: number };

interface Options {
  output: string;
  socket: string;
  session: string;
  pid: number;
  windowId: number;
}

const DEPTHS = [8, 16, 24, 32] as const;
const ELEMENT_LIMITS = [128, 256, 512] as const;

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function required(args: readonly string[], name: string): string {
  const value = option(args, name);
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function integer(args: readonly string[], name: string): number {
  const value = Number(required(args, name));
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function parseOptions(args: readonly string[]): Options {
  return {
    output: resolve(required(args, "--output")),
    socket: required(args, "--socket"),
    session: option(args, "--session") ?? `uia-edge-depth-${Date.now()}`,
    pid: integer(args, "--pid"),
    windowId: integer(args, "--window-id"),
  };
}

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}

function structured(result: ToolResult): RecordValue | undefined {
  if (typeof result.structuredJson !== "string") return undefined;
  try { return record(JSON.parse(result.structuredJson) as unknown); } catch { return undefined; }
}

function numberField(value: unknown, key: string): number | undefined {
  const candidate = record(value)?.[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function boolField(value: unknown, key: string): boolean | null {
  const candidate = record(value)?.[key];
  return typeof candidate === "boolean" ? candidate : null;
}

function stringField(value: unknown, key: string): string | undefined {
  const candidate = record(value)?.[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function frame(value: unknown): Frame | undefined {
  const x = numberField(value, "x");
  const y = numberField(value, "y");
  const width = numberField(value, "width") ?? numberField(value, "w");
  const height = numberField(value, "height") ?? numberField(value, "h");
  return x === undefined || y === undefined || width === undefined || height === undefined
    ? undefined
    : { x, y, width, height };
}

function errorCode(result: ToolResult): string | null {
  const value = result.errorCode;
  return typeof value === "string" && /^[A-Z0-9_.:-]{1,80}$/u.test(value) ? value : null;
}

function redactErrorText(result: ToolResult): string | null {
  if (!result.isError && errorCode(result) === null) return null;
  return errorCode(result) ?? (result.isError ? "tool_error" : "tool_degraded");
}

function summarizeList(result: ToolResult, expectedPid: number, expectedWindowId: number): RecordValue {
  const root = structured(result);
  const windows = root?.windows;
  let targetPresent = false;
  let pidMatchCount = 0;
  let windowIdMatchCount = 0;
  if (Array.isArray(windows)) {
    for (const item of windows) {
      if (numberField(item, "pid") === expectedPid) pidMatchCount += 1;
      if (numberField(item, "window_id") === expectedWindowId) windowIdMatchCount += 1;
    }
    targetPresent = pidMatchCount > 0 && windowIdMatchCount > 0;
  }
  return {
    returned: true,
    isError: result.isError,
    errorCode: errorCode(result),
    targetPresent,
    windowCount: Array.isArray(windows) ? windows.length : null,
    pidMatchCount,
    windowIdMatchCount,
  };
}

function summarizeState(result: ToolResult, depth: number, maxElements: number): RecordValue {
  const root = structured(result);
  const elements = Array.isArray(root?.elements) ? root.elements : [];
  const roleCounts: Record<string, number> = {};
  const stateKeyCounts: Record<string, number> = {};
  let frameCount = 0;
  let editCount = 0;
  let editChromeTopCount = 0;
  let editContentAreaCount = 0;
  let editUnknownRegionCount = 0;
  for (const item of elements) {
    const value = record(item);
    const role = stringField(value, "role") ?? "unknown";
    roleCounts[role] = (roleCounts[role] ?? 0) + 1;
    const elementFrame = frame(value?.frame);
    if (elementFrame !== undefined) {
      frameCount += 1;
      if (role.toLowerCase() === "edit") {
        editCount += 1;
        if (elementFrame.y < 120) editChromeTopCount += 1;
        else if (elementFrame.y >= 120) editContentAreaCount += 1;
        else editUnknownRegionCount += 1;
      }
    } else if (role.toLowerCase() === "edit") {
      editCount += 1;
      editUnknownRegionCount += 1;
    }
    const state = record(value?.state);
    const stateKeys = new Set<string>(state === undefined ? [] : Object.keys(state));
    for (const key of ["enabled", "visible", "selected", "checked", "expanded", "focused", "editable", "value", "is_enabled", "is_visible", "is_selected", "is_checked", "is_expanded", "is_focused", "is_editable"]) {
      if (value?.[key] !== undefined) stateKeys.add(key);
    }
    for (const key of stateKeys) stateKeyCounts[key] = (stateKeyCounts[key] ?? 0) + 1;
  }
  const total = numberField(root, "total_element_count") ?? numberField(root, "total_elements");
  const returned = numberField(root, "returned_element_count") ?? elements.length;
  const complete = boolField(root, "complete");
  const elementsComplete = boolField(root, "elements_complete");
  const truncated = boolField(root, "truncated");
  const degraded = boolField(root, "degraded");
  return {
    depth,
    maxElements,
    returned: true,
    isError: result.isError,
    errorCode: errorCode(result),
    errorClass: redactErrorText(result),
    elementCount: elements.length,
    returnedElementCount: returned,
    totalElementCount: total,
    elementsComplete,
    complete,
    truncated,
    degraded,
    roleCounts,
    selectedRoleCounts: Object.fromEntries(["Edit", "Document", "Pane", "WebView"].map((role) => [role, roleCounts[role] ?? 0])),
    frameCoverage: { present: frameCount, missing: elements.length - frameCount },
    stateKeyCounts,
    editRegions: { total: editCount, chromeTop: editChromeTopCount, contentArea: editContentAreaCount, unknown: editUnknownRegionCount },
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  await mkdir(options.output, { recursive: true });
  const driver: CuaDriverLike = CuaDriver.connect(options.socket);
  const signal = new AbortController().signal;
  await driver.startSession(StartSessionInput.new({ session: options.session }), { signal });
  try {
    const list = await driver.callTool("list_windows", JSON.stringify({ pid: options.pid, on_screen_only: true, session: options.session }), { signal });
    const observations: RecordValue[] = [];
    for (const depth of DEPTHS) {
      for (const maxElements of ELEMENT_LIMITS) {
        const result = await driver.callTool("get_window_state", JSON.stringify({
          pid: options.pid,
          window_id: options.windowId,
          include_screenshot: false,
          max_depth: depth,
          max_elements: maxElements,
          session: options.session,
        }), { signal });
        observations.push(summarizeState(result, depth, maxElements));
      }
    }
    const report = {
      probeVersion: "uia-edge-depth-0.1.0",
      driver: "trycua/cua-driver-0.22.2",
      readOnly: true,
      modelRequests: 0,
      inputInvocations: 0,
      screenshotsRequested: false,
      persistedNamesValuesRawTree: false,
      target: summarizeList(list, options.pid, options.windowId),
      matrix: { depths: DEPTHS, maxElements: ELEMENT_LIMITS, observations },
    };
    await writeFile(`${options.output}/uia-edge-depth-summary.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({
      output: options.output,
      targetPresentInList: (report.target as RecordValue).targetPresent,
      list: report.target,
      observationCount: observations.length,
      errors: observations.filter((item) => item.errorCode !== null).length,
      elementCounts: observations.map((item) => ({ depth: item.depth, maxElements: item.maxElements, elementCount: item.elementCount, totalElementCount: item.totalElementCount, selectedRoleCounts: item.selectedRoleCounts, editRegions: item.editRegions, errorCode: item.errorCode })),
    }, null, 2));
  } finally {
    await driver.endSession(EndSessionInput.new({ session: options.session }), { signal }).catch(() => undefined);
    (driver as unknown as { uniffiDestroy?: () => void }).uniffiDestroy?.();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
