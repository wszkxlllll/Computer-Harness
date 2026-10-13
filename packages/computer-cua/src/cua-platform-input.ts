import type { ActionIntent, SwitchWindowAction, Viewport } from "@computer-harness/protocol";
import { windowActionTarget, type CuaWindowBinding, type CuaWindowGeometry } from "./window-contract.js";

export type CuaWindowDeliveryMode = "background" | "foreground";
export type CuaMultilineTypeProfile = "foreground-caret-v1";
export type CuaMultilineTypeDispatch = "standard" | "windows_foreground_caret" | "windows_uia";

export class WindowCoordinateMappingError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "WindowCoordinateMappingError";
  }
}

export function hasLineBreak(text: string): boolean {
  return /[\r\n\u0085\u2028\u2029]/u.test(text);
}

export function normalizeLogicalLineEndings(text: string): string {
  return text.replace(/\r\n|\r|\n/gu, "\n");
}

export function resolveMultilineTypeDispatch(
  platform: NodeJS.Platform,
  action: ActionIntent,
  profile: CuaMultilineTypeProfile | undefined,
): CuaMultilineTypeDispatch {
  if (platform !== "win32" || action.kind !== "type" || !hasLineBreak(action.text)) return "standard";
  return action.groundingRef === undefined && profile === "foreground-caret-v1"
    ? "windows_foreground_caret"
    : "windows_uia";
}

export function isBrowserShortcut(action: ActionIntent, key: string, platform: NodeJS.Platform): boolean {
  if (action.kind !== "keypress" || action.keys.length !== 2) return false;
  const keys = action.keys.map((part) => part.toUpperCase());
  const modifiers = platform === "darwin" ? ["CMD", "META"] : ["CTRL"];
  return keys.includes(key) && keys.some((part) => modifiers.includes(part));
}

export function actionRequest(
  action: Exclude<ActionIntent, { kind: "wait" } | SwitchWindowAction | { kind: "reopen_saved_document" }>,
  session: string,
  desktopTarget: { readonly kind: "desktop"; readonly display_id: string },
  windowBinding?: CuaWindowBinding,
  configuredDeliveryMode?: CuaWindowDeliveryMode,
  decisionViewport?: Viewport,
  platform: NodeJS.Platform = process.platform,
): { name: string; arguments: Record<string, unknown> } {
  const target = windowBinding === undefined ? desktopTarget : windowActionTarget(windowBinding);
  const deliveryMode = windowBinding === undefined ? "foreground" : configuredDeliveryMode ?? "background";
  const point = (value: { x: number; y: number }) => windowBinding === undefined
    ? value
    : mapWindowPoint(value, decisionViewport, windowBinding.bounds, platform);
  switch (action.kind) {
    case "click":
      return { name: "click", arguments: { session, target, ...point(action.point), delivery_mode: deliveryMode } };
    case "double_click":
      return { name: "click", arguments: { session, target, ...point(action.point), count: 2, delivery_mode: deliveryMode } };
    case "right_click":
      return { name: "click", arguments: { session, target, ...point(action.point), button: "right", delivery_mode: deliveryMode } };
    case "type":
      return { name: "type_text", arguments: { session, target, text: action.text, delivery_mode: deliveryMode } };
    case "keypress": {
      if (action.keys.length === 1) {
        return { name: "press_key", arguments: { session, target, key: action.keys[0], delivery_mode: deliveryMode } };
      }
      const foregroundChord = platform === "win32" && windowBinding !== undefined && deliveryMode === "foreground"
        ? foregroundPressKeyChord(action.keys)
        : undefined;
      return foregroundChord === undefined
        ? { name: "hotkey", arguments: { session, target, keys: action.keys, delivery_mode: deliveryMode } }
        : { name: "press_key", arguments: {
            session,
            target,
            key: foregroundChord.key,
            modifiers: foregroundChord.modifiers,
            delivery_mode: deliveryMode,
          } };
    }
    case "scroll":
      return { name: "scroll", arguments: { session, target, ...point(action.point), direction: action.direction, by: "line", amount: action.ticks, delivery_mode: deliveryMode } };
    case "drag": {
      const from = point(action.from);
      const to = point(action.to);
      return { name: "drag", arguments: { session, target, from_x: from.x, from_y: from.y, to_x: to.x, to_y: to.y, delivery_mode: deliveryMode } };
    }
    case "select_option":
      throw new WindowCoordinateMappingError("SELECT_OPTION_DOM_REQUIRED", "select_option must use managed-browser DOM delivery");
    default:
      return assertNever(action);
  }
}

/**
 * Validate image-local coordinates and apply the pinned platform contract.
 * The decision frame is the source of truth: an approved action may execute
 * against a later observation, but its coordinates were still produced from
 * action.basedOn. Geometry is checked by the caller before this projection.
 */
export function mapWindowPoint(
  point: { x: number; y: number },
  sourceViewport: Viewport | undefined,
  targetBounds: CuaWindowGeometry,
  platform: NodeJS.Platform,
): { x: number; y: number } {
  if (sourceViewport === undefined) {
    throw new WindowCoordinateMappingError("WINDOW_VIEWPORT_UNKNOWN", "window action has no source observation viewport");
  }
  if (sourceViewport.coordinateSpace !== "physical") {
    throw new WindowCoordinateMappingError("WINDOW_COORDINATE_SPACE_UNSUPPORTED", "window action requires a physical observation viewport");
  }
  if (!validDimension(sourceViewport.width) || !validDimension(sourceViewport.height)) {
    throw new WindowCoordinateMappingError("WINDOW_VIEWPORT_INVALID", "window action has an invalid source observation viewport");
  }
  if (!validDimension(targetBounds.width) || !validDimension(targetBounds.height)) {
    throw new WindowCoordinateMappingError("WINDOW_GEOMETRY_INVALID", "window action has invalid target geometry");
  }
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x >= sourceViewport.width || point.y >= sourceViewport.height) {
    throw new WindowCoordinateMappingError("WINDOW_COORDINATE_INVALID", `window action point (${point.x}, ${point.y}) is outside source viewport ${sourceViewport.width}x${sourceViewport.height}`);
  }
  return {
    // CUA 0.22.2 macOS click/scroll/drag consume get_window_state PNG pixels.
    // The driver reverses its per-window resize ratio and Retina backing
    // scale itself. A bounds projection here would apply a second transform.
    // Keep the historical Windows/Linux contract unchanged: Windows capture
    // through observation-only verify_state does not refresh its resize map.
    x: platform === "darwin" ? clampCoordinate(Math.round(point.x), sourceViewport.width) : clampCoordinate(Math.round(point.x * targetBounds.width / sourceViewport.width), targetBounds.width),
    y: platform === "darwin" ? clampCoordinate(Math.round(point.y), sourceViewport.height) : clampCoordinate(Math.round(point.y * targetBounds.height / sourceViewport.height), targetBounds.height),
  };
}

function foregroundPressKeyChord(keys: readonly string[]): { key: string; modifiers: string[] } | undefined {
  const modifiers: string[] = [];
  const baseKeys: string[] = [];
  const seenModifiers = new Set<string>();
  for (const key of keys) {
    const modifier = canonicalPressKeyModifier(key);
    if (modifier === undefined) {
      baseKeys.push(key);
      continue;
    }
    if (seenModifiers.has(modifier)) return undefined;
    seenModifiers.add(modifier);
    modifiers.push(modifier);
  }
  if (modifiers.length === 0 || baseKeys.length !== 1) return undefined;
  return { key: baseKeys[0]!, modifiers };
}

function canonicalPressKeyModifier(key: string): string | undefined {
  switch (key.toLowerCase()) {
    case "ctrl":
    case "control":
      return "ctrl";
    case "shift":
      return "shift";
    case "alt":
    case "menu":
    case "option":
      return "alt";
    case "win":
    case "windows":
    case "meta":
    case "cmd":
    case "command":
      return "win";
    default:
      return undefined;
  }
}

function validDimension(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function clampCoordinate(value: number, size: number): number {
  return Math.min(size - 1, Math.max(0, value));
}

function assertNever(value: never): never {
  throw new Error(`Unhandled CUA input action ${(value as { kind?: string }).kind ?? "<unknown>"}`);
}
