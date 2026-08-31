import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CuaDriver,
  EndSessionInput,
  StartSessionInput,
  type CuaDriverLike,
} from "@trycua/cua-driver";
import type {
  ActionIntent,
  ActionReceipt,
  ComputerSessionDescriptor,
  ObservationCapture,
  ObservationId,
  Viewport,
} from "@computer-harness/protocol";
import type { Computer, ComputerOpenOptions } from "@computer-harness/runtime";

const PRIMARY_DESKTOP = { kind: "desktop", display_id: "primary" } as const;

export type CuaDriverFactory = (socketPath: string) => CuaDriverLike;

export interface CuaDriverComputerOptions {
  /** Explicit daemon endpoint. The adapter never falls back to embedded CUA. */
  socketPath: string;
  /** Where action observations are written before Runtime persists them as assets. */
  screenshotDir: string;
  /** Optional stable label; a generated label is used when omitted. */
  sessionLabel?: string;
  /** Bound the cleanup-pending close path; no GUI action is retried. */
  cleanupWaitMs?: number;
  /** Test seam; production uses CuaDriver.connect. */
  driverFactory?: CuaDriverFactory;
}

interface PrivateSession {
  label: string;
  driver: CuaDriverLike;
  descriptor: ComputerSessionDescriptor;
  active: boolean;
}

interface PrivateObservation {
  sessionId: string;
}

interface DriverErrorDetails {
  message: string;
  tag?: string;
  errorCode?: string;
}

export class CuaDriverComputer implements Computer {
  private readonly options: Required<Pick<CuaDriverComputerOptions, "socketPath" | "screenshotDir" | "cleanupWaitMs">> & Omit<CuaDriverComputerOptions, "socketPath" | "screenshotDir" | "cleanupWaitMs">;
  private readonly observations = new Map<string, PrivateObservation>();
  private session: PrivateSession | undefined;

  public constructor(options: CuaDriverComputerOptions) {
    if (!options.socketPath.trim()) {
      throw new Error("CuaDriverComputer requires an explicit daemon socketPath");
    }
    this.options = {
      ...options,
      socketPath: options.socketPath,
      screenshotDir: options.screenshotDir,
      cleanupWaitMs: options.cleanupWaitMs ?? 5000,
    };
    if (!Number.isInteger(this.options.cleanupWaitMs) || this.options.cleanupWaitMs <= 0) {
      throw new Error("cleanupWaitMs must be a positive integer");
    }
  }

  public async open(options: ComputerOpenOptions, signal: AbortSignal): Promise<ComputerSessionDescriptor> {
    if (this.session !== undefined) {
      throw new Error(`computer session ${this.session.descriptor.id} is still retained; close it before opening another`);
    }
    signal.throwIfAborted();
    const driver = (this.options.driverFactory ?? ((socketPath) => CuaDriver.connect(socketPath)))(this.options.socketPath);
    const label = this.options.sessionLabel ?? `computer-harness-${Date.now()}`;
    try {
      await driver.startSession(StartSessionInput.new({ session: label }), { signal });
      const size = await callTool(driver, "get_screen_size", { session: label }, signal);
      const dimensions = readStructuredDimensions(size);
      if (dimensions === undefined) {
        throw new Error("CUA get_screen_size did not return width/height");
      }
      const viewport: Viewport = { ...dimensions, coordinateSpace: "physical" };
      if (options.viewport !== undefined &&
          (options.viewport.width !== viewport.width || options.viewport.height !== viewport.height || options.viewport.coordinateSpace !== viewport.coordinateSpace)) {
        throw new Error(`requested viewport ${options.viewport.width}x${options.viewport.height}/${options.viewport.coordinateSpace} does not match CUA primary desktop ${viewport.width}x${viewport.height}/${viewport.coordinateSpace}`);
      }
      const descriptor: ComputerSessionDescriptor = {
        id: label as ComputerSessionDescriptor["id"],
        backend: "cua-driver-daemon",
        viewport,
        capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false },
        openedAt: new Date().toISOString(),
      };
      this.session = { label, driver, descriptor, active: true };
      return descriptor;
    } catch (error) {
      await bestEffortCloseDriver(driver, label, this.options.cleanupWaitMs);
      throw normalizeDriverError(error, "open");
    }
  }

  public async observe(
    session: ComputerSessionDescriptor,
    observationId: ObservationId,
    signal: AbortSignal,
  ): Promise<ObservationCapture> {
    const current = this.requireSession(session);
    signal.throwIfAborted();
    await mkdir(this.options.screenshotDir, { recursive: true });
    const fileName = `${safeId(String(observationId))}.png`;
    const screenshotPath = join(this.options.screenshotDir, fileName);
    try {
      const result = await callTool(current.driver, "get_desktop_state", {
        session: current.label,
        screenshot_out_file: screenshotPath,
      }, signal);
      const dimensions = readStructuredScreenshotDimensions(result) ?? await readPngDimensions(screenshotPath);
      if (dimensions === undefined) {
        throw new Error("CUA get_desktop_state did not return screenshot dimensions");
      }
      if (dimensions.width !== current.descriptor.viewport.width || dimensions.height !== current.descriptor.viewport.height) {
        throw new Error(`CUA screenshot ${dimensions.width}x${dimensions.height} does not match opened viewport ${current.descriptor.viewport.width}x${current.descriptor.viewport.height}`);
      }
      const data = new Uint8Array(await readFile(screenshotPath));
      this.observations.set(String(observationId), { sessionId: String(session.id) });
      return {
        capturedAt: new Date().toISOString(),
        viewport: current.descriptor.viewport,
        screenshot: { mediaType: "image/png", data },
      };
    } catch (error) {
      const details = driverErrorDetails(error);
      if (details.tag === "Transport") {
        current.active = false;
      }
      throw normalizeDriverError(error, "observe");
    }
  }

  public async execute(
    session: ComputerSessionDescriptor,
    action: ActionIntent,
    signal: AbortSignal,
  ): Promise<ActionReceipt> {
    const current = this.requireSession(session);
    signal.throwIfAborted();
    if (action.kind !== "wait") {
      const observation = this.observations.get(String(action.basedOn));
      if (observation === undefined || observation.sessionId !== String(session.id)) {
        return refused(action.actionId, "OBSERVATION_NOT_FOUND", `action is based on unknown observation ${String(action.basedOn)}`);
      }
    }
    if (action.kind === "wait") {
      await waitWithAbort(action.durationMs, signal);
      return { actionId: action.actionId, status: "completed" };
    }
    const request = actionRequest(action, current.label);
    try {
      const result = await callTool(current.driver, request.name, request.arguments, signal);
      if (result.isError) {
        return refused(action.actionId, result.errorCode ?? "CUA_TOOL_REFUSED", result.text);
      }
      if (result.degraded) {
        return { actionId: action.actionId, status: "failed", driverCode: "CUA_DEGRADED", message: result.text };
      }
      return { actionId: action.actionId, status: "completed", ...(result.text ? { message: result.text } : {}) };
    } catch (error) {
      const details = driverErrorDetails(error);
      if (details.tag === "Transport") {
        current.active = false;
      }
      // A thrown transport/abort/unknown error may follow a real side effect.
      // Do not manufacture a terminal receipt and never retry here; Runtime
      // records the unresolved action as outcome_unknown. Only explicit
      // structured Tool errors are safe to classify as a refusal.
      if (details.tag === "Tool") {
        return refused(action.actionId, details.errorCode ?? "CUA_TOOL_REFUSED", details.message);
      }
      throw normalizeDriverError(error, "execute");
    }
  }

  public async close(session: ComputerSessionDescriptor): Promise<void> {
    const current = this.session;
    if (current === undefined || String(current.descriptor.id) !== String(session.id)) {
      throw new Error(`unknown CUA computer session ${String(session.id)}`);
    }
    this.observations.forEach((_value, key) => {
      if (_value.sessionId === String(session.id)) this.observations.delete(key);
    });
    try {
      let result;
      try {
        result = await current.driver.endSession(EndSessionInput.new({ session: current.label }));
      } catch (error) {
        const details = driverErrorDetails(error);
        if (details.errorCode !== "session_cleanup_pending" && !/session_cleanup_pending/i.test(details.message)) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, this.options.cleanupWaitMs));
        result = await current.driver.endSession(EndSessionInput.new({ session: current.label }));
      }
      if (!result.active) {
        current.active = false;
      } else {
        await new Promise((resolve) => setTimeout(resolve, this.options.cleanupWaitMs));
        result = await current.driver.endSession(EndSessionInput.new({ session: current.label }));
        current.active = result.active;
      }
      if (current.active) {
        throw new Error(`CUA session ${current.label} remained active after bounded close`);
      }
    } catch (error) {
      current.active = false;
      throw normalizeDriverError(error, "close");
    } finally {
      try { await current.driver.shutdown(); } catch { /* preserve close diagnostic */ }
      destroyDriver(current.driver);
      this.session = undefined;
    }
  }

  private requireSession(session: ComputerSessionDescriptor): PrivateSession {
    const current = this.session;
    if (current === undefined || String(current.descriptor.id) !== String(session.id)) {
      throw new Error(`unknown CUA computer session ${String(session.id)}`);
    }
    if (!current.active) {
      throw new Error(`CUA computer session ${String(session.id)} is inactive; open a new session`);
    }
    return current;
  }
}

function actionRequest(action: Exclude<ActionIntent, { kind: "wait" }>, session: string): { name: string; arguments: Record<string, unknown> } {
  switch (action.kind) {
    case "click":
      return { name: "click", arguments: { session, target: PRIMARY_DESKTOP, x: action.point.x, y: action.point.y, delivery_mode: "foreground" } };
    case "double_click":
      return { name: "click", arguments: { session, target: PRIMARY_DESKTOP, x: action.point.x, y: action.point.y, count: 2, delivery_mode: "foreground" } };
    case "right_click":
      return { name: "click", arguments: { session, target: PRIMARY_DESKTOP, x: action.point.x, y: action.point.y, button: "right", delivery_mode: "foreground" } };
    case "type":
      return { name: "type_text", arguments: { session, target: PRIMARY_DESKTOP, text: action.text, delivery_mode: "foreground" } };
    case "keypress":
      return action.keys.length === 1
        ? { name: "press_key", arguments: { session, target: PRIMARY_DESKTOP, key: action.keys[0], delivery_mode: "foreground" } }
        : { name: "hotkey", arguments: { session, target: PRIMARY_DESKTOP, keys: action.keys, delivery_mode: "foreground" } };
    case "scroll":
      return { name: "scroll", arguments: { session, target: PRIMARY_DESKTOP, x: action.point.x, y: action.point.y, direction: action.direction, by: "line", amount: action.ticks, delivery_mode: "foreground" } };
    case "drag":
      return { name: "drag", arguments: { session, target: PRIMARY_DESKTOP, from_x: action.from.x, from_y: action.from.y, to_x: action.to.x, to_y: action.to.y, delivery_mode: "foreground" } };
    default:
      return assertNever(action);
  }
}

async function callTool(driver: CuaDriverLike, name: string, input: Record<string, unknown>, signal: AbortSignal) {
  return driver.callTool(name, JSON.stringify(input), { signal });
}

function readStructuredDimensions(result: { structuredJson?: string }): { width: number; height: number } | undefined {
  if (typeof result.structuredJson !== "string") return undefined;
  try {
    const value = JSON.parse(result.structuredJson) as Record<string, unknown>;
    return dimensions(value.width, value.height);
  } catch { return undefined; }
}

function readStructuredScreenshotDimensions(result: { structuredJson?: string }): { width: number; height: number } | undefined {
  if (typeof result.structuredJson !== "string") return undefined;
  try {
    const value = JSON.parse(result.structuredJson) as Record<string, unknown>;
    return dimensions(value.screenshot_width, value.screenshot_height);
  } catch { return undefined; }
}

function dimensions(width: unknown, height: unknown): { width: number; height: number } | undefined {
  return typeof width === "number" && Number.isInteger(width) && width > 0 && typeof height === "number" && Number.isInteger(height) && height > 0
    ? { width, height }
    : undefined;
}

async function readPngDimensions(path: string): Promise<{ width: number; height: number } | undefined> {
  try {
    const bytes = await readFile(path);
    if (bytes.length < 24 || bytes.toString("ascii", 1, 4) !== "PNG" || bytes.toString("ascii", 12, 16) !== "IHDR") return undefined;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  } catch { return undefined; }
}

function safeId(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "_");
  return safe || "observation";
}

function refused(actionId: ActionReceipt["actionId"], driverCode: string, message: string): ActionReceipt {
  return { actionId, status: "refused", driverCode, message };
}

function driverErrorDetails(error: unknown): DriverErrorDetails {
  const message = error instanceof Error ? error.message : String(error);
  if (!error || typeof error !== "object") return { message };
  const record = error as Record<string, unknown>;
  const inner = record.inner && typeof record.inner === "object" ? record.inner as Record<string, unknown> : undefined;
  const innerMessage = typeof inner?.message === "string"
    ? inner.message
    : typeof inner?.reason === "string"
      ? inner.reason
      : message;
  return {
    message: innerMessage,
    ...(typeof record.tag === "string" ? { tag: record.tag } : {}),
    ...(typeof inner?.errorCode === "string" ? { errorCode: inner.errorCode } : {}),
  };
}

function normalizeDriverError(error: unknown, operation: string): Error {
  const details = driverErrorDetails(error);
  return new Error(`CUA ${operation} failed${details.errorCode ? ` [${details.errorCode}]` : ""}: ${details.message}`);
}

async function bestEffortCloseDriver(driver: CuaDriverLike, label: string, waitMs: number): Promise<void> {
  try {
    let result = await driver.endSession(EndSessionInput.new({ session: label }));
    if (result.active) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      await driver.endSession(EndSessionInput.new({ session: label }));
    }
  } catch { /* open failure remains primary */ }
  try { await driver.shutdown(); } catch { /* best effort */ }
  destroyDriver(driver);
}

function destroyDriver(driver: CuaDriverLike): void {
  const destroy = (driver as unknown as { uniffiDestroy?: () => void }).uniffiDestroy;
  destroy?.call(driver);
}

async function waitWithAbort(durationMs: number, signal: AbortSignal): Promise<void> {
  if (durationMs === 0) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("wait aborted"));
    };
    timer = setTimeout(() => {
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, durationMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function assertNever(value: never): never {
  throw new Error(`unsupported CUA action ${String(value)}`);
}
