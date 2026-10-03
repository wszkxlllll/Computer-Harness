import path from "node:path";
import {
  createDefaultToolRegistry,
  DefaultRuntimePolicy,
  groundingComputerTools,
  windowSwitchTools,
} from "../../packages/runtime/dist/index.js";

const DEFAULT_MAX_TEXT_LENGTH = 12_000;
const NAVIGATION_KEYS = new Set([
  "ENTER", "TAB", "ESC", "ESCAPE", "UP", "DOWN", "LEFT", "RIGHT",
  "ARROWUP", "ARROWDOWN", "ARROWLEFT", "ARROWRIGHT", "PAGEUP", "PAGEDOWN", "HOME", "END",
]);
const SAFE_HOTKEYS = new Set([
  ["CTRL", "A"], ["CTRL", "F"], ["CTRL", "L"],
  ["ALT", "LEFT"], ["ALT", "RIGHT"], ["SHIFT", "TAB"],
  ["CTRL", "SHIFT", "S"],
].map((keys) => keys.sort().join("+")));
const SYSTEM_KEY_PATTERN = /^(?:(?:LEFT|RIGHT|L|R)?(?:WIN|WINDOWS|META|SUPER|OS|COMMAND|CMD|GUI)(?:LEFT|RIGHT|L|R)?)$/u;
const DANGEROUS_URI_PATTERN = /(?:^|[\s"'(=])(?:javascript|vbscript|shell|file|search-ms|search|data|ms-appinstaller|ms-settings|ms-explorer|ms-search|powershell|cmd|chrome|edge|about):/iu;
const DRIVE_RELATIVE_PATH_PATTERN = /(?:^|[\s"'(])([a-z]):(?![\\/])/iu;
const EMBEDDED_WINDOWS_PATH_PATTERN = /(?:^|[\s"'(])(?:[a-z]:[\\/]|\\\\[^\\/\s]+\\[^\\/\s]+|\\[^\\/\s]+)/iu;
const TERMINAL_TOOL_PATTERN = /^(?:terminal(?:[_-].*)?|run[_-]?command|exec(?:ute)?[_-]?shell|shell|powershell|cmd)$/iu;

/**
 * Creates a bounded CW life-task policy. This policy is not an OS sandbox and
 * does not infer focus: Host approval must verify the visible Save As target.
 */
export function createCrossWindowLifeTaskPolicy(config = {}, { outputFilePaths = [] } = {}) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) throw new TypeError("config must be an object");
  if (!Array.isArray(outputFilePaths)) throw new TypeError("outputFilePaths must be an array of absolute Windows paths");
  const allowedOutputPaths = new Set(outputFilePaths.map(normalizeConfiguredOutputPath));
  const normalizedConfig = {
    maxSteps: positiveInteger(config.maxSteps, undefined, "maxSteps"),
    maxModelRequests: positiveInteger(config.maxModelRequests, undefined, "maxModelRequests"),
  };
  const maxTextLength = positiveInteger(config.maxTextLength, DEFAULT_MAX_TEXT_LENGTH, "maxTextLength");
  const toolRegistry = getPolicyRegistry(config.toolRegistry);
  return new CrossWindowLifeTaskPolicy(normalizedConfig, toolRegistry, allowedOutputPaths, maxTextLength);
}

class CrossWindowLifeTaskPolicy extends DefaultRuntimePolicy {
  constructor(config, toolRegistry, allowedOutputPaths, maxTextLength) {
    super(config.maxSteps, config.maxModelRequests);
    this.toolRegistry = toolRegistry;
    this.allowedOutputPaths = allowedOutputPaths;
    this.maxTextLength = maxTextLength;
  }

  async evaluateToolCall(context) {
    const call = context?.call;
    const tool = context?.tool;
    if (call === undefined || typeof call.name !== "string" || tool?.name !== call.name) {
      return deny("life-task policy requires a call bound to its Registry tool");
    }
    if (TERMINAL_TOOL_PATTERN.test(call.name)) {
      return deny("life-task policy blocks terminal or shell execution");
    }
    const registered = this.toolRegistry.get(call.name);
    if (registered === undefined || registered.category !== tool.category) {
      return deny(`life-task policy blocks non-Registry tool: ${call.name}`);
    }
    try {
      registered.validate(call.arguments);
    } catch {
      return deny(`life-task policy blocks invalid ${call.name} arguments`);
    }

    if (registered.category === "control" && (call.name === "terminate" || call.name === "interact")) {
      return super.evaluateToolCall(context);
    }
    if (registered.category === "side" && call.name === "list_windows") {
      return super.evaluateToolCall(context);
    }
    if (registered.category !== "computer") {
      return deny(`life-task policy blocks unsupported Registry tool: ${call.name}`);
    }

    switch (call.name) {
      case "keypress": {
        const decision = evaluateKeypress(call.arguments);
        return decision ?? super.evaluateToolCall(context);
      }
      case "hotkey": {
        const decision = evaluateHotkey(call.arguments);
        return decision ?? super.evaluateToolCall(context);
      }
      case "type": {
        const decision = evaluateType(call.arguments, this.allowedOutputPaths, this.maxTextLength);
        return decision ?? super.evaluateToolCall(context);
      }
      case "switch_window":
      case "wait":
      case "scroll":
        return super.evaluateToolCall(context);
      case "click":
      case "click_element":
      case "select_option":
        return requireApproval("Host must inspect the screenshot and verify the exact click target.");
      default:
        return deny(`life-task policy blocks unsupported Computer action: ${call.name}`);
    }
  }
}

function getPolicyRegistry(configuredRegistry) {
  if (configuredRegistry !== undefined && typeof configuredRegistry?.get === "function") return configuredRegistry;
  const registry = createDefaultToolRegistry();
  registry.registerMany([...windowSwitchTools(), ...groundingComputerTools({ includeSelectOption: true })]);
  return registry;
}

function evaluateKeypress(argumentsValue) {
  const keys = argumentsValue?.keys;
  if (!Array.isArray(keys) || keys.length !== 1 || typeof keys[0] !== "string") {
    return deny("life-task policy allows exactly one navigation key");
  }
  const key = normalizeKey(keys[0]);
  if (isSystemKey(key)) return deny("life-task policy blocks OS/System key aliases");
  if (!NAVIGATION_KEYS.has(key)) return deny("life-task policy allows only navigation keys");
  return undefined;
}

function evaluateHotkey(argumentsValue) {
  const rawKeys = argumentsValue?.keys;
  if (!Array.isArray(rawKeys) || rawKeys.length === 0 || rawKeys.length > 3 || rawKeys.some((key) => typeof key !== "string")) {
    return deny("life-task policy blocks an invalid hotkey sequence");
  }
  const keys = rawKeys.map(normalizeKey);
  if (keys.some(isSystemKey)) return deny("life-task policy blocks OS/System key aliases");
  const canonical = [...new Set(keys.map(canonicalKey))].sort().join("+");
  if (canonical === "CTRL+S") {
    return requireApproval("Ctrl+S may save or overwrite; Host must verify the visible target. This policy does not auto-approve.");
  }
  if (!SAFE_HOTKEYS.has(canonical) || new Set(keys.map(canonicalKey)).size !== keys.length) {
    return deny("life-task policy blocks hotkeys outside the safe navigation and Save As allowlist");
  }
  return undefined;
}

function evaluateType(argumentsValue, allowedOutputPaths, maxTextLength) {
  const text = argumentsValue?.text;
  if (typeof text !== "string" || text.trim().length === 0) return deny("life-task policy requires non-empty text");
  if (text.length > maxTextLength) return deny(`life-task policy limits typed text to ${maxTextLength} characters`);
  if (/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    return deny("life-task policy allows only LF/CR among ASCII control characters");
  }

  const trimmed = text.trim();
  const normalizedPath = normalizeTypedAbsolutePath(trimmed);
  if (normalizedPath !== undefined) {
    if (allowedOutputPaths.has(normalizedPath)) {
      return requireApproval("Host must verify this exact path in the Save As filename field before approval; focus is not asserted.");
    }
    return deny("life-task policy blocks absolute paths other than an exact configured outputFilePaths match");
  }
  if (DRIVE_RELATIVE_PATH_PATTERN.test(trimmed)) {
    return deny("life-task policy blocks drive-relative Windows paths");
  }
  if (EMBEDDED_WINDOWS_PATH_PATTERN.test(text)) {
    return deny("life-task policy blocks embedded absolute or UNC Windows paths");
  }
  if (containsExecutableUri(trimmed)) {
    return deny("life-task policy blocks executable or non-HTTP(S) URI schemes");
  }
  return undefined;
}

function normalizeTypedAbsolutePath(value) {
  // Check Windows path semantics before URI schemes so `E:` is drive-relative,
  // not misread as a one-letter URI scheme.
  if (!path.win32.isAbsolute(value)) return undefined;
  if (!isFullyQualifiedWindowsPath(value)) return undefined;
  return normalizeWindowsPath(value);
}

function normalizeConfiguredOutputPath(value) {
  if (typeof value !== "string" || !path.win32.isAbsolute(value) || !isFullyQualifiedWindowsPath(value)) {
    throw new TypeError("outputFilePaths entries must be drive-rooted or UNC Windows absolute paths");
  }
  if (/[\\/]$/u.test(value)) throw new TypeError("outputFilePaths entries must identify files, not directories");
  return normalizeWindowsPath(value);
}

function isFullyQualifiedWindowsPath(value) {
  return /^[a-z]:[\\/]/iu.test(value) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/u.test(value);
}

function normalizeWindowsPath(value) {
  return path.win32.normalize(value).toLowerCase();
}

function containsExecutableUri(value) {
  if (DANGEROUS_URI_PATTERN.test(value)) return true;
  const scheme = /^([a-z][a-z0-9+.-]*):(\S)/iu.exec(value);
  if (scheme === null) return false;
  return scheme[1]?.toLowerCase() !== "http" && scheme[1]?.toLowerCase() !== "https";
}

function normalizeKey(value) {
  return value.toUpperCase().replace(/[^A-Z0-9]/gu, "");
}

function isSystemKey(value) {
  return SYSTEM_KEY_PATTERN.test(value);
}

function canonicalKey(value) {
  if (["CTRL", "CONTROL", "LCTRL", "RCTRL", "LEFTCTRL", "RIGHTCTRL", "LCONTROL", "RCONTROL", "LEFTCONTROL", "RIGHTCONTROL"].includes(value)) return "CTRL";
  if (["SHIFT", "LSHIFT", "RSHIFT", "LEFTSHIFT", "RIGHTSHIFT"].includes(value)) return "SHIFT";
  if (["ALT", "LALT", "RALT", "LEFTALT", "RIGHTALT"].includes(value)) return "ALT";
  return value;
}

function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function deny(reason) {
  return { decision: "deny", reason };
}

function requireApproval(reason) {
  return { decision: "require_approval", reason };
}
