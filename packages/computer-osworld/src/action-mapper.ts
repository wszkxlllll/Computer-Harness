import type { ActionIntent, Point, Viewport } from "@computer-harness/protocol";
import type { OsworldTypedAction } from "./bridge.js";

export class OsworldActionMappingError extends Error {
  public constructor(message: string, public readonly code = "OSWORLD_INVALID_ACTION") {
    super(message);
    this.name = "OsworldActionMappingError";
  }
}

export function mapActionIntent(action: ActionIntent, viewport: Viewport): OsworldTypedAction {
  switch (action.kind) {
    case "click":
      return { kind: "click", ...readPoint(action.point, "click", viewport) };
    case "double_click":
      return { kind: "double_click", ...readPoint(action.point, "double_click", viewport) };
    case "right_click":
      return { kind: "right_click", ...readPoint(action.point, "right_click", viewport) };
    case "type":
      if (typeof action.text !== "string") throw new OsworldActionMappingError("type.text must be a string");
      return { kind: "type", text: action.text };
    case "keypress":
      return mapKeys(action.keys);
    case "scroll":
      if (!Number.isInteger(action.ticks) || action.ticks <= 0) {
        throw new OsworldActionMappingError("scroll.ticks must be a positive integer");
      }
      return { kind: "scroll", ...readPoint(action.point, "scroll", viewport), direction: action.direction, ticks: action.ticks };
    case "drag": {
      const from = readPoint(action.from, "drag.from", viewport);
      const to = readPoint(action.to, "drag.to", viewport);
      return { kind: "drag", fromX: from.x, fromY: from.y, toX: to.x, toY: to.y };
    }
    case "wait":
      if (!Number.isFinite(action.durationMs) || action.durationMs < 0) {
        throw new OsworldActionMappingError("wait.durationMs must be a non-negative finite number");
      }
      return { kind: "wait", durationMs: action.durationMs };
    default:
      return assertNever(action);
  }
}

function mapKeys(keys: string[]): OsworldTypedAction {
  if (!Array.isArray(keys) || keys.length === 0 || keys.some((key) => typeof key !== "string" || key.length === 0)) {
    throw new OsworldActionMappingError("keypress.keys must be a non-empty array of non-empty strings");
  }
  return keys.length === 1
    ? { kind: "keypress", key: keys[0]! }
    : { kind: "hotkey", keys: [...keys] };
}

function readPoint(point: Point, label: string, viewport: Viewport): { x: number; y: number } {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new OsworldActionMappingError(`${label} coordinates must be finite`);
  }
  if (point.x < 0 || point.x >= viewport.width || point.y < 0 || point.y >= viewport.height) {
    throw new OsworldActionMappingError(`${label} point is outside the ${viewport.width}x${viewport.height} viewport`, "OSWORLD_COORDINATE_OUT_OF_RANGE");
  }
  return { x: point.x, y: point.y };
}

function assertNever(value: never): never {
  throw new OsworldActionMappingError(`unsupported action ${String(value)}`);
}
