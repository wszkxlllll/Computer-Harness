#!/usr/bin/env node

import assert from "node:assert/strict";
import { createDefaultToolRegistry, groundingComputerTools, windowSwitchTools } from "../../packages/runtime/dist/index.js";
import { createCrossWindowLifeTaskPolicy } from "./life-task-policy.mjs";

const outputPath = "E:\\MyDesktop\\output\\CW01-activity-memo.txt";
const registry = createDefaultToolRegistry();
registry.registerMany([...windowSwitchTools(), ...groundingComputerTools({ includeSelectOption: true })]);
const policy = createCrossWindowLifeTaskPolicy({
  maxSteps: 4,
  maxModelRequests: 7,
  toolRegistry: registry,
}, { outputFilePaths: [outputPath] });

function evaluate(name, argumentsValue, extra = {}) {
  const tool = extra.tool ?? registry.get(name) ?? { name, category: "computer", validate: () => undefined };
  const call = {
    id: `selftest-${name}`,
    name,
    arguments: argumentsValue,
    ...(extra.declaredEffect === undefined ? {} : { declaredEffect: extra.declaredEffect }),
  };
  return policy.evaluateToolCall({ call, tool, snapshot: {} });
}

assert.deepEqual(await evaluate("type", { text: "Activity memo\r\n- Review agenda\n- Follow up" }), { decision: "allow" });
assert.deepEqual(await evaluate("type", { text: "https://example.test/path" }), { decision: "allow" });

const approvedOutputPath = await evaluate("type", { text: "e:\\MYDESKTOP\\OUTPUT\\cw01-ACTIVITY-MEMO.txt" });
assert.equal(approvedOutputPath.decision, "require_approval");
assert.match(approvedOutputPath.reason, /Save As filename field/iu);
assert.match(approvedOutputPath.reason, /focus is not asserted/iu);

for (const text of [
  "E:\\MyDesktop\\output\\other.txt",
  "\\\\server\\share\\memo.txt",
  "E:relative.txt",
  "Text mentions E:\\MyDesktop\\other.txt",
]) {
  const result = await evaluate("type", { text });
  assert.equal(result.decision, "deny", `path should be denied: ${text}`);
}
assert.match((await evaluate("type", { text: "E:relative.txt" })).reason, /drive-relative/iu, "E: must be treated as a drive-relative path, not a URI");

for (const text of [
  "javascript:alert(1)",
  "shell:AppsFolder",
  "file:///C:/private.txt",
  "search-ms:query=test",
  "data:text/html,unsafe",
  "custom-scheme:payload",
]) {
  assert.equal((await evaluate("type", { text })).decision, "deny", `execution URI should be denied: ${text}`);
}

for (const text of ["line\tbreak", "nul\u0000byte", "del\u007fbyte", "form\u000cfeed"]) {
  assert.equal((await evaluate("type", { text })).decision, "deny", "non-LF/CR ASCII control should be denied");
}
assert.equal((await evaluate("type", { text: "x".repeat(12_001) })).decision, "deny");
assert.equal((await evaluate("type", { text: 42 })).decision, "deny");

for (const key of ["WIN", "Windows", "LWIN", "RWIN", "META", "MetaLeft", "MetaRight", "Super_L", "Command", "CMD", "GUI"] ) {
  assert.equal((await evaluate("keypress", { keys: [key] })).decision, "deny", `system key alias should be denied: ${key}`);
  assert.equal((await evaluate("hotkey", { keys: [key, "R"] })).decision, "deny", `system hotkey alias should be denied: ${key}+R`);
}

for (const keys of [["CTRL", "SHIFT", "P"], ["ALT", "F4"], ["CTRL", "ESC"], ["CTRL", "ALT", "DELETE"]]) {
  assert.equal((await evaluate("hotkey", { keys })).decision, "deny", `unknown/dangerous hotkey should be denied: ${keys.join("+")}`);
}
for (const keys of [["CTRL", "A"], ["CTRL", "F"], ["CTRL", "L"], ["ALT", "LEFT"], ["SHIFT", "TAB"]]) {
  assert.equal((await evaluate("hotkey", { keys })).decision, "allow", `safe navigation hotkey should be allowed: ${keys.join("+")}`);
}
assert.equal((await evaluate("hotkey", { keys: ["CTRL", "SHIFT", "S"] })).decision, "allow");
const ctrlS = await evaluate("hotkey", { keys: ["CTRL", "S"] });
assert.equal(ctrlS.decision, "require_approval");
assert.match(ctrlS.reason, /Host must verify/iu);
for (const key of ["ENTER", "ESC", "TAB", "ARROWLEFT", "ARROWDOWN", "PAGEUP", "HOME", "END"]) {
  assert.equal((await evaluate("keypress", { keys: [key] })).decision, "allow", `navigation key should be allowed: ${key}`);
}
assert.equal((await evaluate("keypress", { keys: ["BACKSPACE"] })).decision, "deny");

assert.equal((await evaluate("click", { x: 10, y: 20 })).decision, "require_approval");
assert.equal((await evaluate("click_element", { elementRef: "uia-target" })).decision, "require_approval");
assert.equal((await evaluate("select_option", { elementRef: "dom-select", optionText: "Memo" })).decision, "require_approval");
assert.equal((await evaluate("switch_window", { windowRef: "opaque-listed-ref" })).decision, "allow");
assert.equal((await evaluate("list_windows", {})).decision, "allow");
assert.equal((await evaluate("double_click", { x: 10, y: 20 })).decision, "deny");
assert.equal((await evaluate("terminal_exec", {})).decision, "deny");
assert.equal((await evaluate("unregistered_extension_tool", {})).decision, "deny");

// The shared effect declaration stays on ToolCall, not inside the switch/type arguments.
assert.equal((await evaluate("hotkey", { keys: ["CTRL", "L"] }, {
  declaredEffect: { effects: ["navigate"], target: "address bar", summary: "Focus browser address bar" },
})).decision, "allow");

assert.equal(policy.checkActionBudget({ stepCount: 4 }).allowed, false);
assert.equal(policy.checkBudget({ modelRequestCount: 7 }).allowed, false);
assert.equal(policy.canFinish({}).allowed, true);

assert.throws(() => createCrossWindowLifeTaskPolicy({}, { outputFilePaths: ["relative\\memo.txt"] }), /Windows absolute paths/iu);

process.stdout.write("CW01 life-task policy offline cases: PASS\n");
