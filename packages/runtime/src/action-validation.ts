import type {
  ActionIntent,
  ComputerCapabilities,
  ObservationFrame,
  Point,
} from "@computer-harness/protocol";

export interface ActionValidationContext {
  observation?: ObservationFrame;
  capabilities: ComputerCapabilities;
  /** Runtime-only current execution frame; action.basedOn remains the decision frame. */
  executionObservationId?: import("@computer-harness/protocol").ObservationId;
}

/**
 * Validate GUI invariants that are shared by every Computer backend.
 * Backend-specific checks (for example a CUA frame token) stay in the adapter.
 */
export function validateActionIntent(
  action: ActionIntent,
  context: ActionValidationContext,
): void {
  if (action.kind === "wait") {
    if (!Number.isFinite(action.durationMs) || action.durationMs < 0) {
      throw new Error("wait durationMs must be a finite non-negative number");
    }
    return;
  }

  const observation = context.observation;
  if (observation === undefined) {
    throw new Error(`GUI action ${action.actionId} requires a current observation`);
  }
  const executionObservationId = context.executionObservationId ?? observation.id;
  if (action.basedOn !== observation.id && context.executionObservationId === undefined) {
    throw new Error(
      `GUI action ${action.actionId} is based on ${action.basedOn}, not current observation ${observation.id}`,
    );
  }
  if (executionObservationId !== observation.id) {
    throw new Error(`execution observation ${executionObservationId} is not current observation ${observation.id}`);
  }
  if (
    !Number.isInteger(observation.viewport.width) ||
    !Number.isInteger(observation.viewport.height) ||
    observation.viewport.width <= 0 ||
    observation.viewport.height <= 0
  ) {
    throw new Error(
      `observation ${observation.id} has an invalid viewport ${observation.viewport.width}x${observation.viewport.height}`,
    );
  }

  switch (action.kind) {
    case "click":
    case "double_click":
    case "right_click":
      requireCapability(context.capabilities.pointer, action.kind, "pointer");
      assertPointInViewport(action.point, observation.viewport.width, observation.viewport.height, action.kind);
      return;
    case "drag":
      requireCapability(context.capabilities.pointer, action.kind, "pointer");
      assertPointInViewport(action.from, observation.viewport.width, observation.viewport.height, "drag.from");
      assertPointInViewport(action.to, observation.viewport.width, observation.viewport.height, "drag.to");
      return;
    case "scroll":
      requireCapability(context.capabilities.pointer, action.kind, "pointer");
      assertPointInViewport(action.point, observation.viewport.width, observation.viewport.height, "scroll");
      if (!["up", "down", "left", "right"].includes(action.direction)) {
        throw new Error(`scroll direction ${String(action.direction)} is invalid`);
      }
      if (!Number.isInteger(action.ticks) || action.ticks <= 0) {
        throw new Error("scroll ticks must be a positive integer");
      }
      return;
    case "type":
      requireCapability(context.capabilities.keyboard, action.kind, "keyboard");
      return;
    case "keypress":
      requireCapability(context.capabilities.keyboard, action.kind, "keyboard");
      if (action.keys.length === 0 || action.keys.some((key) => key.trim().length === 0)) {
        throw new Error("keypress requires at least one non-empty key");
      }
      return;
    default:
      return assertNever(action);
  }
}

function requireCapability(enabled: boolean, actionKind: string, capability: string): void {
  if (!enabled) {
    throw new Error(`${actionKind} requires Computer capability ${capability}`);
  }
}

function assertPointInViewport(point: Point, width: number, height: number, label: string): void {
  if (
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    point.x < 0 ||
    point.y < 0 ||
    point.x >= width ||
    point.y >= height
  ) {
    throw new Error(`${label} point (${point.x}, ${point.y}) is outside viewport ${width}x${height}`);
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled action kind: ${String(value)}`);
}
