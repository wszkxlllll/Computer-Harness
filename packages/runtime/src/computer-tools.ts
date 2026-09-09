import type { JsonValue } from "@computer-harness/protocol";
import type { ComputerToolDefinition, GuiActionDraft } from "./contracts.js";
import { ToolRegistry } from "./tool-registry.js";

/**
 * The single model-facing Computer tool vocabulary for V1. Provider adapters
 * should derive their wire schemas from these definitions instead of copying
 * provider-specific tool lists.
 */
export function createDefaultComputerTools(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const definition of defaultComputerTools()) {
    registry.register(definition);
  }
  return registry;
}

export function defaultComputerTools(): readonly ComputerToolDefinition[] {
  return [
    {
      name: "click",
      description: "Click one point in the current screen observation.",
      category: "computer",
      coordinate: { fields: ["x", "y"] },
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "number", description: "Horizontal coordinate in the current observation coordinate space." },
          y: { type: "number", description: "Vertical coordinate in the current observation coordinate space." },
        },
        required: ["x", "y"],
        additionalProperties: false,
      },
      validate: (args) => { parsePoint(args, "click"); },
      toAction: (args) => ({ kind: "click", point: parsePoint(args, "click") }),
    },
    {
      name: "type",
      description: "Type text into the currently focused GUI control.",
      category: "computer",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", description: "Text to type into the currently focused GUI control." } },
        required: ["text"],
        additionalProperties: false,
      },
      validate: (args) => { parseText(args); },
      toAction: (args) => ({ kind: "type", text: parseText(args) }),
    },
    {
      name: "keypress",
      description: "Press exactly one key in the current GUI focus. Use hotkey for a simultaneous shortcut.",
      category: "computer",
      inputSchema: {
        type: "object",
        properties: {
          keys: {
            type: "array",
            description: "Exactly one key name, such as ENTER, ESC, or A. Use hotkey for a simultaneous shortcut.",
            items: { type: "string", minLength: 1 },
            minItems: 1,
            maxItems: 1,
          },
        },
        required: ["keys"],
        additionalProperties: false,
      },
      validate: (args) => { parseSingleKey(args); },
      toAction: (args) => ({ kind: "keypress", keys: parseSingleKey(args) }),
    },
    {
      name: "hotkey",
      description: "Press a keyboard shortcut such as CTRL+L or ALT+TAB.",
      category: "computer",
      inputSchema: {
        type: "object",
        properties: {
          keys: {
            type: "array",
            description: "Key names pressed together, such as [\"CTRL\", \"L\"] for a browser address-bar shortcut.",
            items: { type: "string", minLength: 1 },
            minItems: 1,
          },
        },
        required: ["keys"],
        additionalProperties: false,
      },
      validate: (args) => { parseKeys(args); },
      toAction: (args) => ({ kind: "keypress", keys: parseKeys(args) }),
    },
    {
      name: "scroll",
      description: "Scroll at a screen point by positive wheel ticks.",
      category: "computer",
      coordinate: { fields: ["x", "y"] },
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "number", description: "Horizontal coordinate where the scroll starts, in the current observation coordinate space." },
          y: { type: "number", description: "Vertical coordinate where the scroll starts, in the current observation coordinate space." },
          direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Direction of the scroll movement." },
          ticks: { type: "integer", minimum: 1, description: "Positive number of wheel ticks to send." },
        },
        required: ["x", "y", "direction", "ticks"],
        additionalProperties: false,
      },
      validate: (args) => { parseScroll(args); },
      toAction: (args) => ({ kind: "scroll", ...parseScroll(args) }),
    },
    {
      name: "drag",
      description: "Drag from one desktop point to another in the current observation.",
      category: "computer",
      coordinate: { fields: ["fromX", "fromY", "toX", "toY"] },
      inputSchema: {
        type: "object",
        properties: {
          fromX: { type: "number", description: "Horizontal drag start coordinate in the current observation coordinate space." },
          fromY: { type: "number", description: "Vertical drag start coordinate in the current observation coordinate space." },
          toX: { type: "number", description: "Horizontal drag end coordinate in the current observation coordinate space." },
          toY: { type: "number", description: "Vertical drag end coordinate in the current observation coordinate space." },
        },
        required: ["fromX", "fromY", "toX", "toY"],
        additionalProperties: false,
      },
      validate: (args) => { parseDrag(args); },
      toAction: (args) => ({ kind: "drag", ...parseDrag(args) }),
    },
    {
      name: "wait",
      description: "Wait for the GUI to settle for a non-negative duration in milliseconds.",
      category: "computer",
      inputSchema: {
        type: "object",
        properties: { durationMs: { type: "number", minimum: 0, description: "Non-negative time to wait in milliseconds before observing again." } },
        required: ["durationMs"],
        additionalProperties: false,
      },
      validate: (args) => { parseDuration(args); },
      toAction: (args) => ({ kind: "wait", durationMs: parseDuration(args) }),
    },
  ];
}

function asObject(value: JsonValue, name: string): Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} arguments must be an object`);
  }
  return value as Record<string, JsonValue>;
}

function numberField(object: Record<string, JsonValue>, key: string, name: string): number {
  const value = object[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name}.${key} must be a finite number`);
  }
  return value;
}

function parsePoint(value: JsonValue, name: string): { x: number; y: number } {
  const object = asObject(value, name);
  return { x: numberField(object, "x", name), y: numberField(object, "y", name) };
}

function parseText(value: JsonValue): string {
  const object = asObject(value, "type");
  if (typeof object.text !== "string") {
    throw new Error("type.text must be a string");
  }
  return object.text;
}

function parseKeys(value: JsonValue): string[] {
  const object = asObject(value, "keypress");
  if (!Array.isArray(object.keys) || object.keys.length === 0 || object.keys.some((key) => typeof key !== "string" || key.length === 0)) {
    throw new Error("keys must be a non-empty array of non-empty strings");
  }
  return object.keys as string[];
}

function parseSingleKey(value: JsonValue): string[] {
  const keys = parseKeys(value);
  if (keys.length !== 1) {
    throw new Error("keypress.keys must contain exactly one key; use hotkey for a shortcut");
  }
  return keys;
}

function parseScroll(value: JsonValue): Extract<GuiActionDraft, { kind: "scroll" }> extends infer T
  ? T extends { kind: "scroll" } ? Omit<T, "kind"> : never : never {
  const object = asObject(value, "scroll");
  const direction = object.direction;
  if (direction !== "up" && direction !== "down" && direction !== "left" && direction !== "right") {
    throw new Error("scroll.direction must be up, down, left, or right");
  }
  const ticks = numberField(object, "ticks", "scroll");
  if (!Number.isInteger(ticks) || ticks <= 0) {
    throw new Error("scroll.ticks must be a positive integer");
  }
  return {
    point: { x: numberField(object, "x", "scroll"), y: numberField(object, "y", "scroll") },
    direction,
    ticks,
  };
}

function parseDrag(value: JsonValue): { from: { x: number; y: number }; to: { x: number; y: number } } {
  const object = asObject(value, "drag");
  return {
    from: { x: numberField(object, "fromX", "drag"), y: numberField(object, "fromY", "drag") },
    to: { x: numberField(object, "toX", "drag"), y: numberField(object, "toY", "drag") },
  };
}

function parseDuration(value: JsonValue): number {
  const object = asObject(value, "wait");
  const durationMs = numberField(object, "durationMs", "wait");
  if (durationMs < 0) {
    throw new Error("wait.durationMs must be non-negative");
  }
  return durationMs;
}
