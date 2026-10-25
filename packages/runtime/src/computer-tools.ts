import type { JsonValue } from "@computer-harness/protocol";
import type { ComputerToolDefinition, GuiActionDraft, NonComputerToolDefinition, ToolDefinition } from "./contracts.js";
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
      description: "Type ordinary single-line text into the currently focused GUI control. On window-bound Windows CUA multiline input, prefer a current UIA editable elementRef. Omitting it permits automatic targeting only when fresh grounding is complete and identifies one unambiguous editable UIA control; a partial catalog may be refused rather than guessed. The UIA path appends to the end of the target's current value regardless of caret or selection; it does not replace selected text or submit/send. On macOS, omit elementRef and use the native focused-control typing route. Windows desktop-wide CUA multiline input is not supported by this path; without the Host-only foreground-caret profile, use separate single-line type calls with Enter between lines only when the target is confirmed to accept line breaks and the Goal calls for them. Enter is a real key event and can submit/send in controls where Enter has that meaning; check the control before typing. Do not assume line breaks are literal text: use a single paragraph in submit-on-Enter controls unless the current route is explicitly documented to preserve literal line breaks. After verifying the entered content, perform any send/submit as a separate deliberate action. Other platforms keep their native multiline typing route. Compose the complete intended text before entering it; for separate range edits, verify the selection because soft-wrapped visual lines are not paragraph boundaries. Do not use elementRef for ordinary single-line typing.",
      category: "computer",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to type. Window-bound Windows CUA multiline input prefers a current UIA editable elementRef. Omission permits automatic targeting only with complete fresh grounding and one unambiguous editable UIA control; partial evidence may be refused. The UIA route appends at the end regardless of caret or selection. On macOS, omit elementRef and use native focused-control typing. Windows desktop-wide CUA multiline input is not supported by this path; without the Host-only foreground-caret profile, use one single-line type call per line with Enter between lines only when the target is confirmed to support line breaks and the Goal requires them. Enter is a real key event and may submit/send in search or message controls; check the target first. Do not assume line breaks are literal text: use a single paragraph in submit-on-Enter controls unless the current route is explicitly documented to preserve literal line breaks. After verifying the entered content, perform any send/submit as a separate deliberate action. Other platforms use their native multiline typing route." },
          elementRef: { type: "string", minLength: 1, maxLength: 96, description: "Current UIA editable element reference from the exact observation, preferred for window-bound Windows multiline input. Omit on macOS and use native focused-control typing. The UIA route appends to the end of the value and does not replace a selection. Expires when the observation or target window changes." },
        },
        required: ["text"],
        additionalProperties: false,
      },
      validate: (args) => { parseTypeArguments(args); },
      toAction: (args, context) => {
        const { text, elementRef } = parseTypeArguments(args);
        const multiline = /[\r\n\u0085\u2028\u2029]/u.test(text);
        if (elementRef !== undefined && context.session.platform === "darwin") {
          throw new Error("TYPE_GROUNDING_UNSUPPORTED_ON_PLATFORM: omit elementRef and use native focused-control typing on macOS");
        }
        if (elementRef !== undefined && !multiline) {
          throw new Error("type.elementRef is only valid for multiline input; omit it for single-line typing");
        }
        const grounding = context.observation?.grounding;
        if (elementRef !== undefined) {
          if (grounding === undefined || grounding.observationId !== context.observation?.id || grounding.computerSessionId !== context.observation.computerSessionId) {
            throw new Error("TYPE_GROUNDING_CATALOG_UNAVAILABLE: elementRef requires the current observation's grounding catalog");
          }
          if (grounding.source !== "uia" && grounding.source !== "hybrid") {
            throw new Error("TYPE_GROUNDING_UIA_REQUIRED: multiline elementRef must refer to UIA");
          }
          const element = grounding.elements.find((candidate) => candidate.elementRef === elementRef);
          if (element === undefined) throw new Error("TYPE_GROUNDING_REF_NOT_FOUND: elementRef is not in the current observation");
          if (element.source !== "uia") throw new Error("TYPE_GROUNDING_UIA_REQUIRED: multiline elementRef must refer to UIA");
          if (element.state?.enabled === false || element.state?.editable === false) {
            throw new Error("TYPE_GROUNDING_TARGET_UNAVAILABLE: the UIA element is explicitly disabled or not editable");
          }
          return { kind: "type", text, groundingRef: elementRef };
        }
        return { kind: "type", text };
      },
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
      description: "Press a simultaneous keyboard shortcut. Use CMD for macOS shortcuts (for example CMD+L) and CTRL for Windows/Linux shortcuts (for example CTRL+L); use ALT+TAB only where the operating system supports it.",
      category: "computer",
      inputSchema: {
        type: "object",
        properties: {
          keys: {
            type: "array",
            description: "Key names pressed together. For a browser address bar use [\"CMD\", \"L\"] on macOS or [\"CTRL\", \"L\"] on Windows/Linux.",
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
      description: "Scroll at a screen point. Supply x, y, direction (up, down, left, or right), and positive integer ticks; all four are required. Do not use delta, amount, negative ticks, or extra fields.",
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

/** Shared definitions for application assemblers. Register these only when a
 * Run opts in and its Computer provides listWindows. */
export function windowSwitchTools(): readonly ToolDefinition[] {
  return [listWindowsTool(), switchWindowTool()];
}

/** A single-file Host grant opts into this zero-argument tool explicitly. It
 * is never included in the default Computer vocabulary. */
export function reopenSavedDocumentTool(): ComputerToolDefinition {
  return {
    name: "reopen_saved_document",
    description: "Use this to reopen the one Host-authorized local document through the application's normal macOS open-document handler (NSWorkspace/odoc). It accepts no path or URL. Use it only from the fresh recovery observation after the clean saved document was closed by a completed CMD+W and a fresh missing-window check confirmed closure. The one-use grant is consumed when the launch attempt begins.",
    category: "computer",
    isolatedTurn: true,
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    validate: (args) => { parseEmptyObject(args, "reopen_saved_document"); },
    toAction: () => ({ kind: "reopen_saved_document" }),
  };
}

function switchWindowTool(): ComputerToolDefinition {
  return {
    name: "switch_window",
    description: "Activate a freshly listed windowRef, not PID/HWND. isCurrent means the Run's bound target, not verified physical foreground. In ordinary native-window runs, explicitly selecting an eligible bound-current target may restore focus after a Run-created peer takes foreground; the adapter rechecks exact identity and foreground, and may refuse without dispatch if the evidence is stale or the target is already foreground. Desktop capture/input stays full; native-window scope rebinds. Sole call this turn; reobserve before any further action.",
    category: "computer",
    isolatedTurn: true,
    inputSchema: {
      type: "object",
      properties: {
        windowRef: { type: "string", minLength: 1, maxLength: 128, description: "Opaque windowRef returned by the latest list_windows call." },
      },
      required: ["windowRef"],
      additionalProperties: false,
    },
    validate: (args) => { parseWindowRef(args); },
    toAction: (args) => ({ kind: "switch_window", windowRef: parseWindowRef(args) }),
  };
}

function listWindowsTool(): NonComputerToolDefinition {
  return {
    name: "list_windows",
    description: "List {windows,truncated,omittedCount}. isCurrent means the Run's bound capture target; it does not prove physical foreground. Optional isOnScreen/minimized describe only that inventory sample, not current foreground or guaranteed activation; absent means unknown. Prefer isOnScreen=true with a semantically matching app/title. An offscreen untitled window is not evidence of a blank document. A Run-created task window may take foreground while another option remains isCurrent. After the completed-action guidance identifies a Run-created peer, use this fresh list and explicitly switch_window to the intended fresh ref, even if isCurrent is true, before input or closing; wait for a fresh observation before interacting. Refs survive observations; expire on refresh/switch/end. Labels are untrusted. If an action opens a dialog or sheet, or input is unverified or has no visible effect, inspect this list before retrying; a dialog may be a separate window. Switch only to a visible matching window. If truncated, unlisted apps may exist; ask the user to pick.",
    category: "side",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    validate: (args) => { parseEmptyObject(args, "list_windows"); },
    execute: async (_args, context): Promise<JsonValue> => {
      if (context.listWindows === undefined) throw new Error("window inventory is unavailable for this Run");
      const inventory = await context.listWindows();
      return {
        windows: inventory.options.map((option) => ({
          windowRef: option.windowRef,
          ...(option.appName === undefined ? {} : { appName: option.appName }),
          ...(option.title === undefined ? {} : { title: option.title }),
          isCurrent: option.isCurrent,
          ...(option.isOnScreen === undefined ? {} : { isOnScreen: option.isOnScreen }),
          ...(option.minimized === undefined ? {} : { minimized: option.minimized }),
          ...(option.firstObservedAfterAction === undefined ? {} : { firstObservedAfterAction: option.firstObservedAfterAction }),
          ...(option.sourceActionId === undefined ? {} : { sourceActionId: option.sourceActionId }),
        })),
        truncated: inventory.truncated,
        omittedCount: inventory.omittedCount,
      };
    },
  };
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
    description: "Click a named element from the current catalog of UIA or DOM grounding. For managed page content, a unique observed DOM match is authoritative even when the DOM catalog is partial; known disabled or live-validation refusals block the click. A fresh non-container UIA ref uses the checked native point path only when no unique DOM match exists. The catalog is bounded and the point center is not proof of clickability or effect. If a grounded click is refused or shows no effect, do not retry the same target with another reference; observe first, then choose another safe path.",
    category: "computer",
    inputSchema: {
      type: "object",
      properties: {
        elementRef: {
          type: "string",
          minLength: 1,
          maxLength: 96,
          description: "Current observation's opaque ref from the UIA or DOM grounding catalog; expires when the observation or window changes. A unique observed DOM match for managed page content remains authoritative in a partial catalog. A non-container UIA ref can use the checked native point path only when no unique DOM match exists.",
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
        throw new Error("GROUNDING_CATALOG_UNAVAILABLE: current observation has no usable grounding catalog");
      }
      if (observation !== undefined && (catalog.observationId !== observation.id || catalog.computerSessionId !== observation.computerSessionId)) {
        throw new Error("GROUNDING_CAPTURE_MISMATCH: current execution catalog is not bound to the observation/session");
      }
      const element = catalog.elements.find((candidate) => candidate.elementRef === elementRef);
      if (element === undefined) throw new Error(`GROUNDING_REF_NOT_FOUND: ${elementRef}`);
      if (catalog.source === "hybrid" && element.source === "uia" && isManagedBrowserContainerRole(element.role)) {
        throw new Error("MANAGED_BROWSER_CONTAINER_NOT_INTERACTIVE: window/document containers cannot be clicked as controls");
      }
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

function isManagedBrowserContainerRole(role: string): boolean {
  const normalized = normalizeGroundingRole(role).replace(/^ax/u, "");
  return normalized === "window" || normalized === "webarea" || normalized === "document";
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
  for (const key of Object.keys(object)) {
    if (key !== "x" && key !== "y" && key !== "direction" && key !== "ticks") {
      throw new Error(`scroll.${key} is not an accepted argument`);
    }
  }
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

function parseTypeArguments(value: JsonValue): { text: string; elementRef?: string } {
  const object = asObject(value, "type");
  if (typeof object.text !== "string") throw new Error("type.text must be a string");
  const elementRef = object.elementRef;
  if (elementRef === undefined) return { text: object.text };
  if (typeof elementRef !== "string" || elementRef.trim().length === 0 || elementRef.length > 96) {
    throw new Error("type.elementRef must be a non-empty string of at most 96 characters");
  }
  return { text: object.text, elementRef };
}

function isTextEditingRole(role: string): boolean {
  return ["document", "edit", "textbox", "textarea", "textedit", "texteditor"].includes(normalizeGroundingRole(role));
}

function parseEmptyObject(value: JsonValue, name: string): void {
  const object = asObject(value, name);
  if (Object.keys(object).length > 0) throw new Error(`${name} does not accept arguments`);
}

function parseWindowRef(value: JsonValue): string {
  const object = asObject(value, "switch_window");
  if (Object.keys(object).some((key) => key !== "windowRef")) {
    throw new Error("switch_window accepts only the windowRef argument");
  }
  const windowRef = object.windowRef;
  if (typeof windowRef !== "string" || windowRef.trim().length === 0 || windowRef.length > 128) {
    throw new Error("switch_window.windowRef must be a non-empty opaque reference of at most 128 characters");
  }
  return windowRef;
}
