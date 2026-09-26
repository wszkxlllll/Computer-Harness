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

/**
 * Optional Observation-bound grounding vocabulary. It is registered only for
 * a Run whose Computer explicitly provides the matching grounding mode.
 */
export interface GroundingComputerToolsOptions {
  /** Expose the managed-browser-only DOM select primitive. */
  readonly includeSelectOption?: boolean;
}

export function groundingComputerTools(options: GroundingComputerToolsOptions = {}): readonly ComputerToolDefinition[] {
  const tools: ComputerToolDefinition[] = [{
    name: "click_element",
    description: "Click the center of a named element from the current UIA grounding catalog. Use only after a fresh observation; after clicking, observe again before typing or using another element.",
    category: "computer",
    inputSchema: {
      type: "object",
      properties: {
        elementRef: {
          type: "string",
          minLength: 1,
          maxLength: 96,
          description: "Opaque element reference from the current observation's UIA catalog; it expires when the observation or window changes.",
        },
      },
      required: ["elementRef"],
      additionalProperties: false,
    },
    validate: (args) => { parseElementRef(args); },
    toAction: (args, context) => {
      const elementRef = parseElementRef(args);
      const observation = context.observation;
      const catalog = context.rawGrounding ?? observation?.grounding;
      if (catalog === undefined || catalog.completeness === "unknown") {
        throw new Error("GROUNDING_CATALOG_UNAVAILABLE: current observation has no usable UIA catalog");
      }
      if (observation !== undefined && (catalog.observationId !== observation.id || catalog.computerSessionId !== observation.computerSessionId)) {
        throw new Error("GROUNDING_CAPTURE_MISMATCH: current execution catalog is not bound to the observation/session");
      }
      const element = catalog.elements.find((candidate) => candidate.elementRef === elementRef);
      if (element === undefined) throw new Error(`GROUNDING_REF_NOT_FOUND: ${elementRef}`);
      if (element.state?.enabled === false) throw new Error(`GROUNDING_ELEMENT_DISABLED: ${elementRef}`);
      if (element.bbox === undefined || element.bbox.width <= 0 || element.bbox.height <= 0) {
        throw new Error(`GROUNDING_BBOX_UNAVAILABLE: ${elementRef}`);
      }
      return {
        kind: "click",
        point: {
          x: element.bbox.x + element.bbox.width / 2,
          y: element.bbox.y + element.bbox.height / 2,
        },
        groundingRef: elementRef,
      };
    },
  }];
  if (options.includeSelectOption === true) tools.push(selectOptionTool());
  return tools;
}

function selectOptionTool(): ComputerToolDefinition {
  return {
    name: "select_option",
    description: "Select one exact visible enabled option by optionText copied from the current observation's native HTML select options list (reported as combobox). ARIA comboboxes are not supported; never guess text or use an index/value. Use only after a fresh observation; this does not open the native popup.",
    category: "computer",
    groundingHint: {
      preferredRoles: ["select", "combobox"],
      preferredSources: ["dom"],
    },
    inputSchema: {
      type: "object",
      properties: {
        elementRef: {
          type: "string",
          minLength: 1,
          maxLength: 96,
          description: "Opaque select/combobox reference from the current managed-browser DOM observation; it expires when the observation, tab, or page generation changes.",
        },
        optionText: {
          type: "string",
          minLength: 1,
          maxLength: MAX_OPTION_TEXT_LENGTH,
          description: "Exact enabled optionText copied from the current observation's native-select options list; never guess or use an index/value.",
        },
      },
      required: ["elementRef", "optionText"],
      additionalProperties: false,
    },
    validate: (args) => { parseSelectOption(args); },
    toAction: (args, context) => {
      const { elementRef, optionText } = parseSelectOption(args);
      const observation = context.observation;
      const catalog = context.rawGrounding ?? observation?.grounding;
      if (catalog === undefined || catalog.completeness === "unknown") {
        throw new Error("GROUNDING_CATALOG_UNAVAILABLE: current observation has no usable managed-browser DOM catalog");
      }
      if (observation !== undefined && (catalog.observationId !== observation.id || catalog.computerSessionId !== observation.computerSessionId)) {
        throw new Error("GROUNDING_CAPTURE_MISMATCH: current execution catalog is not bound to the observation/session");
      }
      if (catalog.source !== "dom" && catalog.source !== "hybrid") {
        throw new Error("SELECT_OPTION_DOM_REQUIRED: select_option requires managed-browser DOM/hybrid grounding");
      }
      const element = catalog.elements.find((candidate) => candidate.elementRef === elementRef);
      if (element === undefined) throw new Error(`GROUNDING_REF_NOT_FOUND: ${elementRef}`);
      if (element.source !== "dom") throw new Error("SELECT_OPTION_DOM_REQUIRED: select_option requires a DOM element reference");
      const normalizedRole = normalizeGroundingRole(element.role);
      if (normalizedRole !== "select" && normalizedRole !== "combobox") {
        throw new Error("SELECT_OPTION_ROLE_UNSUPPORTED: element must be an explicit select or combobox");
      }
      if (element.state?.enabled === false) throw new Error(`GROUNDING_ELEMENT_DISABLED: ${elementRef}`);
      if (element.bbox === undefined || element.bbox.width <= 0 || element.bbox.height <= 0) {
        throw new Error(`GROUNDING_BBOX_UNAVAILABLE: ${elementRef}`);
      }
      const options = element.options;
      if (options === undefined) throw new Error("SELECT_OPTION_OPTIONS_UNAVAILABLE: current native select did not publish its bounded options list");
      if (element.optionsTruncated === true) throw new Error("SELECT_OPTION_OPTIONS_TRUNCATED: current native select options list is incomplete");
      const normalizedOptionText = normalizeOptionText(optionText);
      const matchingOptions = options.filter((option) => normalizeOptionText(option.text) === normalizedOptionText);
      if (matchingOptions.length === 0) throw new Error("SELECT_OPTION_OPTION_MISSING: optionText is not listed in the current observation");
      if (matchingOptions.length > 1) throw new Error("SELECT_OPTION_OPTION_AMBIGUOUS: optionText matches multiple listed options");
      if (matchingOptions[0]?.enabled !== true) throw new Error("SELECT_OPTION_OPTION_DISABLED: optionText is listed but disabled");
      return { kind: "select_option", groundingRef: elementRef, optionText };
    },
  };
}

const MAX_OPTION_TEXT_LENGTH = 160;

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

function parseElementRef(value: JsonValue): string {
  const object = asObject(value, "click_element");
  if (typeof object.elementRef !== "string" || object.elementRef.trim().length === 0 || object.elementRef.length > 96) {
    throw new Error("click_element.elementRef must be a non-empty string of at most 96 characters");
  }
  return object.elementRef;
}

function parseSelectOption(value: JsonValue): { elementRef: string; optionText: string } {
  const object = asObject(value, "select_option");
  const elementRef = object.elementRef;
  if (typeof elementRef !== "string" || elementRef.trim().length === 0 || elementRef.length > 96) {
    throw new Error("select_option.elementRef must be a non-empty string of at most 96 characters");
  }
  const optionText = object.optionText;
  if (typeof optionText !== "string" || optionText.trim().length === 0 || optionText.length > MAX_OPTION_TEXT_LENGTH) {
    throw new Error(`select_option.optionText must be a non-empty string of at most ${MAX_OPTION_TEXT_LENGTH} characters`);
  }
  return { elementRef, optionText: optionText.trim() };
}

function normalizeGroundingRole(role: string): string {
  return role.normalize("NFKC").toLocaleLowerCase().replace(/[\s_-]+/gu, "").trim();
}

function normalizeOptionText(value: string): string {
  return value.normalize("NFKC").replace(/[\u0000-\u001F\u007F]/gu, " ").replace(/\s+/gu, " ").trim();
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
