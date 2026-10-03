import { DefaultRuntimePolicy } from "../../packages/runtime/dist/index.js";

export const SHANGHAI_PILOT_POLICY_ID = "shanghai-pilot-browser-shortcuts-v1";

const NAVIGATION_KEYS = new Set([
  "ENTER", "TAB", "ESC", "ESCAPE", "BACKSPACE", "SPACE",
  "UP", "DOWN", "LEFT", "RIGHT", "ARROWUP", "ARROWDOWN", "ARROWLEFT", "ARROWRIGHT",
  "PAGEUP", "PAGEDOWN", "HOME", "END",
]);

const SAFE_HOTKEYS = new Set([
  ["CTRL", "L"], ["CTRL", "F"], ["CTRL", "A"],
  ["ALT", "LEFT"], ["ALT", "RIGHT"], ["SHIFT", "TAB"],
].map((keys) => keys.sort().join("+")));

function normalizeKey(value) {
  return String(value).toUpperCase().replace(/[^A-Z0-9]/gu, "");
}

function isSystemKey(value) {
  return /^(?:(?:LEFT|RIGHT|L|R)?(?:WIN|WINDOWS|META|SUPER|OS|COMMAND|CMD)(?:LEFT|RIGHT|L|R)?)$/u.test(normalizeKey(value));
}

function policyDenial(call) {
  const args = call?.arguments && typeof call.arguments === "object" ? call.arguments : {};
  if (call?.name === "keypress" || call?.name === "hotkey") {
    const keys = Array.isArray(args.keys) ? args.keys.map(normalizeKey) : [];
    if (keys.some(isSystemKey)) return "pilot policy blocked OS/system key shortcuts";
    if (keys.length === 0 || keys.some((key) => !key)) return "pilot policy blocked an invalid key sequence";
    if (call.name === "keypress") {
      if (keys.length !== 1 || !NAVIGATION_KEYS.has(keys[0])) return "pilot policy allows only browser navigation keys";
      return undefined;
    }
    const canonical = [...keys].sort().join("+");
    if (!SAFE_HOTKEYS.has(canonical)) return "pilot policy allows only the configured browser-safe shortcuts";
    return undefined;
  }
  if (call?.name === "type" && typeof args.text === "string") {
    if (/[\u0000-\u001F\u007F]/u.test(args.text)) return "pilot policy blocked ASCII control characters in typed input";
    const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(args.text.trimStart())?.[1]?.toLowerCase();
    if (scheme !== undefined && scheme !== "http" && scheme !== "https") return "pilot policy allows only HTTP(S) URI schemes for typed navigation";
  }
  return undefined;
}

export class ShanghaiPilotRuntimePolicy extends DefaultRuntimePolicy {
  async evaluateToolCall(context) {
    const reason = policyDenial(context.call);
    if (reason !== undefined) return { decision: "deny", reason };
    return super.evaluateToolCall(context);
  }
}

export function createShanghaiPilotRuntimePolicy(config) {
  return new ShanghaiPilotRuntimePolicy(config.maxSteps, config.maxModelRequests);
}

export { policyDenial as shanghaiPilotPolicyDenial };
