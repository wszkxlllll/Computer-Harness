import assert from "node:assert/strict";
import { createShanghaiPilotRuntimePolicy, shanghaiPilotPolicyDenial } from "./shanghai-pilot-policy.mjs";

const policy = createShanghaiPilotRuntimePolicy({ maxSteps: 4, maxModelRequests: 7 });
const blockedKeys = ["WIN", "Windows", "META", "Super_L", "OS", "LWIN", "RWIN", "MetaRight", "Command", "CMD", "F12", "MENU"];
for (const key of blockedKeys) {
  assert.ok(shanghaiPilotPolicyDenial({ name: "keypress", arguments: { keys: [key] } }), `keypress ${key} should be denied`);
}

const blockedShortcuts = [["WIN", "R"], ["CTRL", "SHIFT", "P"], ["ALT", "TAB"], ["CTRL", "ESC"], ["ALT", "F4"]];
for (const keys of blockedShortcuts) {
  assert.ok(shanghaiPilotPolicyDenial({ name: "hotkey", arguments: { keys } }), `${keys.join("+")} should be denied`);
}
assert.equal(shanghaiPilotPolicyDenial({ name: "hotkey", arguments: { keys: ["CTRL", "L"] } }), undefined);
assert.equal(shanghaiPilotPolicyDenial({ name: "keypress", arguments: { keys: ["ENTER"] } }), undefined);

const blockedUris = [
  ["java", "script"].join("") + ":alert(1)",
  "data:text/html,x",
  "file:///C:/x",
  ["ms", "-settings"].join("") + ":",
  ["power", "shell"].join("") + ":Start-Process",
  "cmd:/c",
  "shell:AppsFolder",
  "search-ms:query=test",
  "ms-appinstaller:source=x",
  "chrome://settings",
  "edge://settings",
  "about:blank",
  "vbscript:msgbox(1)",
  "custom-scheme:payload",
];
for (const text of blockedUris) {
  assert.ok(shanghaiPilotPolicyDenial({ name: "type", arguments: { text } }), `URI input should be denied: ${text}`);
}
for (const text of ["ABC train options", "上海站到杭州 08:00", "https://example.test/?cmd:query", "http://example.test/page"]) {
  assert.equal(shanghaiPilotPolicyDenial({ name: "type", arguments: { text } }), undefined, `ordinary query should remain allowed: ${text}`);
}
assert.ok(shanghaiPilotPolicyDenial({ name: "type", arguments: { text: "java\tscript:alert(1)" } }));
assert.ok(shanghaiPilotPolicyDenial({ name: "type", arguments: { text: "harmless\nmultiline" } }));

assert.deepEqual(await policy.evaluateToolCall({
  call: { name: "hotkey", arguments: { keys: ["META", "R"] } },
  tool: {},
  snapshot: {},
}), { decision: "deny", reason: "pilot policy blocked OS/system key shortcuts" });
assert.deepEqual(await policy.evaluateToolCall({
  call: { name: "hotkey", arguments: { keys: ["CTRL", "L"] } },
  tool: {},
  snapshot: {},
}), { decision: "allow" });
assert.equal(policy.checkActionBudget({ stepCount: 4 }).allowed, false);
assert.equal(policy.checkBudget({ modelRequestCount: 7 }).allowed, false);
assert.equal(policy.canFinish({}).allowed, true);

process.stdout.write("Shanghai pilot policy offline cases: PASS\n");
