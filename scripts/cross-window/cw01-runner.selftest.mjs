import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  Cw01RunnerError,
  extractCw01Goal,
  parseHostCommand,
  parseRunnerArgs,
  safeHandoffCandidates,
  selectCw01Targets,
  selectCw01TargetsFromInventories,
} from "./cw01-runner.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("CLI is inert without both live and root GO flags", () => {
  assert.deepEqual(parseRunnerArgs([]), { mode: "help" });
  assert.throws(() => parseRunnerArgs(["--live"]), { code: "ROOT_GO_REQUIRED" });
  assert.throws(() => parseRunnerArgs(["--root-go-after-review"]), { code: "LIVE_MODE_GATED" });
  assert.throws(() => parseRunnerArgs(["--live", "--live", "--root-go-after-review"]), { code: "DUPLICATE_ARGUMENT" });
  assert.deepEqual(parseRunnerArgs(["--live", "--root-go-after-review"]), { mode: "live" });
});

test("real CW01 card extracts the full goal and substitutes only the designated output path", async () => {
  const taskCard = await readFile(resolve(repoRoot, "docs/cross-window-life-task-cards-2026-10-02.md"), "utf8");
  const goal = extractCw01Goal(taskCard, "E:\\MyDesktop\\output\\CW01-活动备忘录.txt");
  assert.match(goal, /WPS《CW01-社区通知》/u);
  assert.match(goal, /空白记事本/u);
  assert.match(goal, /E:\\MyDesktop\\output\\CW01-活动备忘录\.txt/u);
  assert.match(goal, /不要把尚未保存说成已保存/u);
  assert.doesNotMatch(goal, /我指定的测试输出文件夹/u);
  assert.doesNotMatch(goal, /CW02|CW03/u);
});

test("target selection is unique, host-only, and rejects missing or duplicate fixtures", () => {
  const selected = selectCw01Targets([
    { pid: 123, windowId: 1, appName: "WPS Office", title: "CW01-社区通知.docx - WPS Office" },
    { pid: 456, windowId: 2, appName: "Notepad.exe", title: "Untitled - Notepad" },
    { pid: 789, windowId: 3, appName: "Edge", title: "private title not printed" },
  ]);
  assert.deepEqual(selected, { wps: { pid: 123, windowId: 1 }, notepad: { pid: 456, windowId: 2 } });
  assert.throws(() => selectCw01Targets([]), { code: "FIXTURE_TARGET_MISMATCH" });
  assert.throws(() => selectCw01Targets([
    { pid: 1, windowId: 1, appName: "WPS Office", title: "CW01-社区通知" },
    { pid: 2, windowId: 2, appName: "WPS Office", title: "CW01-社区通知 copy" },
    { pid: 3, windowId: 3, appName: "Notepad", title: "Untitled - Notepad" },
  ]), { code: "FIXTURE_TARGET_MISMATCH" });
  assert.throws(() => selectCw01Targets([
    { pid: 1, windowId: 1, appName: "WPS Office", title: "CW01-社区通知" },
    { pid: 2, windowId: 2, appName: "Notepad++", title: "无标题 - 记事本" },
  ]), { code: "FIXTURE_TARGET_MISMATCH" });
  assert.throws(() => selectCw01Targets([
    { pid: 1, windowId: 1, appName: "WPS Office", title: "CW01-社区通知" },
    { pid: 2, windowId: 2, appName: "msedge.exe", title: "Notepad" },
  ]), { code: "FIXTURE_TARGET_MISMATCH" });
  assert.throws(() => selectCw01Targets([
    { pid: 1, windowId: 1, appName: "WPS Office", title: "CW01-社区通知" },
    { pid: 2, windowId: 2, appName: "msedge.exe", title: "记事本" },
  ]), { code: "FIXTURE_TARGET_MISMATCH" });
});

test("full inventory may locate Notepad, but initial WPS must still be on-screen", () => {
  const wps = { pid: 123, windowId: 1, appName: "wps.exe", title: "CW01-社区通知.docx - WPS Office" };
  const notepad = { pid: 456, windowId: 2, appName: "C:\\Windows\\System32\\notepad.exe", title: "无标题 - 记事本" };
  assert.deepEqual(selectCw01TargetsFromInventories([wps], [wps, notepad]), {
    wps: { pid: 123, windowId: 1 },
    notepad: { pid: 456, windowId: 2 },
  });
  assert.throws(() => selectCw01TargetsFromInventories([], [wps, notepad]), { code: "INITIAL_WPS_NOT_ON_SCREEN" });
});

test("handoff picker exposes only fresh candidates matching the two exact task targets", () => {
  const allowed = [
    { target: { pid: 123, windowId: 1 }, label: "WPS CW01 synthetic notice" },
    { target: { pid: 456, windowId: 2 }, label: "blank Notepad fixture" },
  ];
  const candidates = safeHandoffCandidates([
    { pid: 456, windowId: 2, title: "Untitled - Notepad" },
    { pid: 999, windowId: 9, title: "private title not printed" },
  ], allowed);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].label, "blank Notepad fixture");
  assert.throws(() => safeHandoffCandidates({}, allowed), { code: "HANDOFF_INVENTORY_INVALID" });
});

test("stdin accepts only explicit current-request command shapes and bounded text", () => {
  assert.deepEqual(parseHostCommand(JSON.stringify({ kind: "approval", requestId: "a1", approved: false })), { kind: "approval", requestId: "a1", approved: false });
  assert.deepEqual(parseHostCommand(JSON.stringify({ kind: "handoff", sourceActionId: "switch-1", candidateIndex: 0 })), { kind: "handoff", sourceActionId: "switch-1", candidateIndex: 0 });
  assert.equal(parseHostCommand(JSON.stringify({ kind: "input", requestId: "q1", text: "Use the exact authorized output path." })).text, "Use the exact authorized output path.");
  assert.equal(parseHostCommand(JSON.stringify({ kind: "cancel" })).kind, "cancel");
  assert.throws(() => parseHostCommand("not-json"), { code: "INVALID_STDIN_JSON" });
  assert.throws(() => parseHostCommand(JSON.stringify({ kind: "approval", requestId: "a1", approved: "yes" })), { code: "INVALID_STDIN_APPROVAL" });
  assert.throws(() => parseHostCommand(JSON.stringify({ kind: "handoff", sourceActionId: "switch-1", pid: 789, windowId: 99 })), { code: "INVALID_STDIN_HANDOFF" });
  assert.throws(() => parseHostCommand(JSON.stringify({ kind: "input", requestId: "q1", text: "x".repeat(4001) })), { code: "INVALID_STDIN_INPUT" });
  assert.ok(Cw01RunnerError);
});
