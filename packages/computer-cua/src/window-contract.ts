import {
  BoundsExpectation,
  StatePredicate,
  VerifyStateInput,
  WindowPredicate,
  type CuaDriverLike,
  type ToolResult,
} from "@trycua/cua-driver";
import type { Viewport } from "@computer-harness/protocol";

/** Explicit host-owned identity; never model-facing. */
export interface CuaWindowTarget {
  readonly pid: number;
  readonly windowId: number;
}

export interface CuaWindowGeometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CuaWindowBinding {
  readonly target: CuaWindowTarget;
  readonly bounds: CuaWindowGeometry;
}

export interface CuaWindowCapture {
  readonly binding: CuaWindowBinding;
  readonly viewport: Viewport;
  readonly data: Uint8Array;
}

export class WindowContractError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "WindowContractError";
  }
}

export function validateWindowTarget(target: CuaWindowTarget): void {
  if (!Number.isSafeInteger(target.pid) || target.pid <= 0) {
    throw new Error("CUA window target pid must be a positive safe integer");
  }
  if (!Number.isSafeInteger(target.windowId) || target.windowId <= 0) {
    throw new Error("CUA window target windowId must be a positive safe integer");
  }
}

export async function discoverWindow(
  driver: CuaDriverLike,
  session: string,
  target: CuaWindowTarget,
  signal: AbortSignal,
): Promise<CuaWindowBinding> {
  const result = await driver.callTool("list_windows", JSON.stringify({
    on_screen_only: true,
    pid: target.pid,
    session,
  }), { signal });
  if (result.isError) throw new WindowContractError("WINDOW_TARGET_REFUSED", "configured CUA window target was refused");
  if (result.degraded) throw new WindowContractError("WINDOW_TARGET_UNKNOWN", "configured CUA window target is degraded");
  const windows = parseWindows(result);
  const match = windows.find((window) => window.target.pid === target.pid && window.target.windowId === target.windowId);
  if (match === undefined) throw new WindowContractError("WINDOW_TARGET_NOT_FOUND", "configured CUA window target was not found");
  return { target, bounds: match.bounds };
}

export async function captureWindow(
  driver: CuaDriverLike,
  session: string,
  binding: CuaWindowBinding,
  signal: AbortSignal,
): Promise<CuaWindowCapture> {
  const predicate = StatePredicate.new({
    window: WindowPredicate.new({
      exists: true,
      bounds: BoundsExpectation.new({
        x: binding.bounds.x,
        y: binding.bounds.y,
        width: binding.bounds.width,
        height: binding.bounds.height,
        tolerancePx: 0,
      }),
    }),
  });
  const result = await driver.verifyState(VerifyStateInput.new({
    pid: BigInt(binding.target.pid),
    windowId: BigInt(binding.target.windowId),
    expect: [predicate],
    session,
    timeoutMs: BigInt(0),
    stableSamples: BigInt(1),
    includeScreenshot: true,
  }), { signal });
  if (result.isError) throw new WindowContractError("WINDOW_CAPTURE_REFUSED", "configured CUA window capture was refused");
  if (result.degraded) throw new WindowContractError("WINDOW_CAPTURE_UNKNOWN", "configured CUA window capture is degraded");
  const verification = result.verification;
  if (verification === undefined || verification.status !== 0 || verification.stable !== true) {
    throw new WindowContractError("WINDOW_GEOMETRY_UNCONFIRMED", "configured CUA window geometry was not verified");
  }
  if (result.images.length !== 1 || result.images[0]?.mimeType !== "image/png") {
    throw new WindowContractError("WINDOW_CAPTURE_SCHEMA", "CUA window capture did not return one PNG image");
  }
  const data = decodeBase64Png(result.images[0].dataBase64);
  const dimensions = readPngDimensions(data);
  if (dimensions === undefined) throw new WindowContractError("WINDOW_CAPTURE_SCHEMA", "CUA window capture returned an invalid PNG");
  return {
    binding,
    viewport: { ...dimensions, coordinateSpace: "physical" },
    data,
  };
}

export function sameWindowGeometry(left: CuaWindowGeometry, right: CuaWindowGeometry): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

export function windowActionTarget(binding: CuaWindowBinding): { kind: "window"; pid: number; window_id: number } {
  return { kind: "window", pid: binding.target.pid, window_id: binding.target.windowId };
}

function parseWindows(result: ToolResult): CuaWindowBinding[] {
  const value = parseStructured(result.structuredJson);
  const windows = value?.windows;
  if (!Array.isArray(windows)) throw new WindowContractError("WINDOW_TARGET_SCHEMA", "CUA list_windows returned no structured windows");
  return windows.flatMap((item) => {
    if (!isRecord(item)) return [];
    const pid = positiveSafeInteger(item.pid);
    const windowId = positiveSafeInteger(item.window_id);
    const bounds = parseGeometry(item.bounds);
    if (pid === undefined || windowId === undefined || bounds === undefined) return [];
    return [{ target: { pid, windowId }, bounds }];
  });
}

function parseGeometry(value: unknown): CuaWindowGeometry | undefined {
  if (!isRecord(value)) return undefined;
  const x = integer(value.x);
  const y = integer(value.y);
  const width = positiveSafeInteger(value.width);
  const height = positiveSafeInteger(value.height);
  return x === undefined || y === undefined || width === undefined || height === undefined
    ? undefined
    : { x, y, width, height };
}

function positiveSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function parseStructured(value: string | undefined): Record<string, unknown> | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeBase64Png(value: string): Uint8Array {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    throw new WindowContractError("WINDOW_CAPTURE_SCHEMA", "CUA window capture returned invalid image data");
  }
  const data = new Uint8Array(Buffer.from(value, "base64"));
  if (data.length === 0) throw new WindowContractError("WINDOW_CAPTURE_SCHEMA", "CUA window capture returned empty image data");
  return data;
}

function readPngDimensions(data: Uint8Array): { width: number; height: number } | undefined {
  if (data.length < 24) return undefined;
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((value, index) => data[index] === value)) return undefined;
  if (data[12] !== 73 || data[13] !== 72 || data[14] !== 68 || data[15] !== 82) return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}
