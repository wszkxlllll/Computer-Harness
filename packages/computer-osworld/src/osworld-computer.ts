import type {
  ActionIntent,
  ActionReceipt,
  ComputerCapabilities,
  ComputerSessionDescriptor,
  ComputerSessionId,
  ObservationCapture,
  ObservationId,
  Viewport,
} from "@computer-harness/protocol";
import { randomUUID } from "node:crypto";
import type { Computer, ComputerOpenOptions } from "@computer-harness/runtime";
import { mapActionIntent, OsworldActionMappingError } from "./action-mapper.js";
import type { OsworldBridge, OsworldBridgeCapture } from "./bridge.js";

export interface OsworldComputerOptions {
  bridge: OsworldBridge;
  /** Test seam; production generates a new identity for every open(). */
  sessionIdFactory?: () => ComputerSessionId;
  /** Test seam; production defaults to an ISO timestamp. */
  now?: () => string;
}

interface PrivateSession {
  descriptor: ComputerSessionDescriptor;
  active: boolean;
  keyboardKeys?: ReadonlySet<string>;
}

interface PendingCapture {
  sessionId: ComputerSessionId;
  /** Already decoded and validated; observe() must not decode it again. */
  capture: ObservationCapture;
}

export class OsworldComputer implements Computer {
  private readonly bridge: OsworldBridge;
  private readonly now: () => string;
  private readonly sessionIdFactory: () => ComputerSessionId;
  private session: PrivateSession | undefined;
  private latestObservationId: ObservationId | undefined;
  private pendingPostActionCapture: PendingCapture | undefined;

  public constructor(options: OsworldComputerOptions) {
    this.bridge = options.bridge;
    this.now = options.now ?? (() => new Date().toISOString());
    this.sessionIdFactory = options.sessionIdFactory ?? (() => `osworld-${randomUUID()}` as ComputerSessionId);
  }

  public async open(options: ComputerOpenOptions, signal: AbortSignal): Promise<ComputerSessionDescriptor> {
    if (this.session !== undefined) throw new Error(`OSWorld computer session ${String(this.session.descriptor.id)} is still retained; close it before opening another`);
    signal.throwIfAborted();
    const description = await this.bridge.describe(signal);
    const viewport = validateViewport(description.viewport);
    const capabilities = validateCapabilities(description.capabilities);
    if (!capabilities.screenshot) throw new Error("OSWorld bridge does not provide screenshot capability");
    if (description.guestScreenSize !== undefined && !sameScreenSize(description.guestScreenSize, viewport)) {
      throw new Error(`OSWorld guest screen size ${description.guestScreenSize.width}x${description.guestScreenSize.height} does not match viewport ${viewport.width}x${viewport.height}`);
    }
    if (options.viewport !== undefined && !sameViewport(options.viewport, viewport)) {
      throw new Error(`requested viewport ${options.viewport.width}x${options.viewport.height}/${options.viewport.coordinateSpace} does not match OSWorld viewport ${viewport.width}x${viewport.height}/${viewport.coordinateSpace}`);
    }
    const descriptor: ComputerSessionDescriptor = {
      id: this.sessionIdFactory(),
      backend: "osworld-desktop-env",
      viewport,
      capabilities,
      openedAt: this.now(),
    };
    this.session = {
      descriptor,
      active: true,
      ...(description.capabilities.keyboardKeys === undefined
        ? {}
        : { keyboardKeys: new Set(description.capabilities.keyboardKeys.map((key) => key.toLowerCase())) }),
    };
    return descriptor;
  }

  public async observe(session: ComputerSessionDescriptor, observationId: ObservationId, signal: AbortSignal): Promise<ObservationCapture> {
    const current = this.requireSession(session);
    signal.throwIfAborted();
    const pending = this.pendingPostActionCapture;
    this.pendingPostActionCapture = undefined;
    const result = pending?.sessionId === session.id
      ? pending.capture
      : materializeCapture(await this.bridge.observe(signal));
    if (result.viewport.width !== current.descriptor.viewport.width || result.viewport.height !== current.descriptor.viewport.height) {
      current.descriptor = { ...current.descriptor, viewport: result.viewport };
    }
    this.latestObservationId = observationId;
    return result;
  }

  public async execute(session: ComputerSessionDescriptor, action: ActionIntent, signal: AbortSignal): Promise<ActionReceipt> {
    const current = this.requireSession(session);
    signal.throwIfAborted();
    if (this.pendingPostActionCapture !== undefined) {
      return refused(action.actionId, "POST_ACTION_OBSERVATION_PENDING", "observe the completed action before issuing another action");
    }
    if (action.kind !== "wait" && this.latestObservationId === undefined) {
      return refused(action.actionId, "OBSERVATION_NOT_FOUND", `action is based on unknown observation ${String(action.basedOn)}`);
    }
    if (action.kind !== "wait" && action.basedOn !== this.latestObservationId) {
      return refused(action.actionId, "STALE_OBSERVATION", `action is based on stale observation ${String(action.basedOn)}`);
    }
    let mapped;
    try {
      mapped = mapActionIntent(action, current.descriptor.viewport, current.keyboardKeys);
    } catch (error) {
      if (error instanceof OsworldActionMappingError) return refused(action.actionId, error.code, error.message);
      throw error;
    }
    const result = await this.bridge.execute(mapped, signal);
    if (result.status === "refused") return refused(action.actionId, result.code, result.message);
    const postActionCapture = materializeCapture(result.postActionCapture);
    if (postActionCapture.viewport.width !== current.descriptor.viewport.width || postActionCapture.viewport.height !== current.descriptor.viewport.height) {
      current.descriptor = { ...current.descriptor, viewport: postActionCapture.viewport };
    }
    this.pendingPostActionCapture = { sessionId: session.id, capture: postActionCapture };
    return { actionId: action.actionId, status: "completed", ...(result.message === undefined ? {} : { message: result.message }) };
  }

  /** Logical close only; the outer runner owns DesktopEnv.evaluate()/close(). */
  public async close(session: ComputerSessionDescriptor): Promise<void> {
    const current = this.requireSession(session);
    current.active = false;
    this.latestObservationId = undefined;
    this.pendingPostActionCapture = undefined;
    this.session = undefined;
  }

  private requireSession(session: ComputerSessionDescriptor): PrivateSession {
    const current = this.session;
    if (current === undefined || current.descriptor.id !== session.id) {
      throw new Error(`unknown OSWorld computer session ${String(session.id)}`);
    }
    if (!current.active) throw new Error(`OSWorld computer session ${String(session.id)} is inactive; open a new session`);
    return current;
  }
}

function materializeCapture(capture: OsworldBridgeCapture): ObservationCapture {
  if (capture.mediaType !== "image/png") throw new Error("OSWorld bridge returned a non-PNG screenshot");
  const data = decodeBase64(capture.dataBase64);
  const dimensions = readPngDimensions(data);
  if (dimensions === undefined) throw new Error("OSWorld bridge returned invalid PNG screenshot data");
  if (dimensions.width !== capture.width || dimensions.height !== capture.height) throw new Error(`OSWorld PNG dimensions ${dimensions.width}x${dimensions.height} do not match bridge metadata ${capture.width}x${capture.height}`);
  if (capture.guestScreenSize !== undefined && !sameScreenSize(capture.guestScreenSize, { width: dimensions.width, height: dimensions.height })) {
    throw new Error(`OSWorld guest screen size ${capture.guestScreenSize.width}x${capture.guestScreenSize.height} does not match screenshot ${dimensions.width}x${dimensions.height}`);
  }
  if (typeof capture.capturedAt !== "string" || capture.capturedAt.trim().length === 0) throw new Error("OSWorld bridge returned an invalid capture timestamp");
  return {
    capturedAt: capture.capturedAt,
    viewport: { width: dimensions.width, height: dimensions.height, coordinateSpace: "physical" },
    screenshot: { mediaType: capture.mediaType, data },
  };
}

function decodeBase64(value: string): Uint8Array {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) throw new Error("OSWorld bridge returned invalid base64 screenshot data");
  const data = new Uint8Array(Buffer.from(value, "base64"));
  if (data.byteLength === 0) throw new Error("OSWorld bridge returned empty screenshot data");
  return data;
}

function readPngDimensions(data: Uint8Array): { width: number; height: number } | undefined {
  if (data.byteLength < 24) return undefined;
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((value, index) => data[index] === value)) return undefined;
  if (data[12] !== 73 || data[13] !== 72 || data[14] !== 68 || data[15] !== 82) return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function validateCapabilities(capabilities: { screenshot: boolean; pointer: boolean; keyboard: boolean; keyboardKeys?: string[] }): ComputerCapabilities {
  for (const key of ["screenshot", "pointer", "keyboard"] as const) {
    if (typeof capabilities[key] !== "boolean") throw new Error(`OSWorld bridge returned invalid capability ${key}`);
  }
  if (capabilities.keyboard && (capabilities.keyboardKeys === undefined || capabilities.keyboardKeys.length === 0 || capabilities.keyboardKeys.some((key) => typeof key !== "string" || key.length === 0))) {
    throw new Error("OSWorld bridge must advertise keyboardKeys when keyboard capability is enabled");
  }
  return { screenshot: capabilities.screenshot, pointer: capabilities.pointer, keyboard: capabilities.keyboard, accessibility: false };
}

function validateViewport(viewport: Viewport): Viewport {
  if (!Number.isInteger(viewport.width) || viewport.width <= 0 || !Number.isInteger(viewport.height) || viewport.height <= 0 || viewport.coordinateSpace !== "physical") {
    throw new Error("OSWorld bridge returned an invalid physical viewport");
  }
  return viewport;
}

function sameViewport(left: Viewport, right: Viewport): boolean {
  return left.width === right.width && left.height === right.height && left.coordinateSpace === right.coordinateSpace;
}

function sameScreenSize(left: { width: number; height: number }, right: { width: number; height: number }): boolean {
  return left.width === right.width && left.height === right.height;
}

function refused(actionId: ActionReceipt["actionId"], driverCode: string, message: string): ActionReceipt {
  return { actionId, status: "refused", driverCode, message };
}
