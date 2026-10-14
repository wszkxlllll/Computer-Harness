import { describe, expect, it } from "vitest";
import { filterInitialTargetWindowCandidates, hasExplicitApplicationIntent, matchGoalToWindow, targetsForExplicitApplicationIntent } from "./window-target-matcher.js";

describe("matchGoalToWindow", () => {
  it("removes only an adapter-attested direct child from the independent initial-target pool", () => {
    const parent = { pid: 27384, windowId: 0x98e1b34, appName: "Notepad.exe", title: "*CH-NOTEPAD - Notepad" };
    const popup = {
      pid: 27384,
      windowId: 0x991316,
      appName: "Notepad.exe",
      title: "主机弹出窗口",
      relationship: { kind: "owned_child" as const, owner: { pid: parent.pid, windowId: parent.windowId } },
    };
    const sibling = { pid: parent.pid, windowId: 0x1234, appName: "Notepad.exe", title: "A separate document" };
    const allInventory = [popup, parent, sibling];
    expect(filterInitialTargetWindowCandidates(allInventory)).toEqual([parent, sibling]);
    expect(allInventory).toHaveLength(3);
  });

  it("filters children only while their proven independent root remains eligible", () => {
    const root = { pid: 20, windowId: 200, appName: "App", title: "Root" };
    const child = {
      pid: 20,
      windowId: 201,
      appName: "App",
      title: "Child",
      relationship: { kind: "owned_child" as const, owner: { pid: 20, windowId: 200 } },
    };
    const nestedOwner = {
      pid: 20,
      windowId: 300,
      appName: "App",
      title: "Intermediate",
      relationship: { kind: "owned_child" as const, owner: { pid: 20, windowId: 200 } },
    };
    const nestedChild = {
      pid: 20,
      windowId: 301,
      appName: "App",
      title: "Nested",
      relationship: { kind: "owned_child" as const, owner: { pid: 20, windowId: 300 } },
    };
    const selfOwned = {
      pid: 20,
      windowId: 400,
      appName: "App",
      title: "Self",
      relationship: { kind: "owned_child" as const, owner: { pid: 20, windowId: 400 } },
    };
    const absentOwner = {
      pid: 20,
      windowId: 500,
      appName: "App",
      title: "Absent owner",
      relationship: { kind: "owned_child" as const, owner: { pid: 20, windowId: 501 } },
    };
    expect(filterInitialTargetWindowCandidates([root, child, nestedOwner, nestedChild, selfOwned, absentOwner]))
      .toEqual([root, nestedChild, selfOwned, absentOwner]);
    // If visibility projection omitted the owner, the child remains available
    // as a real visible candidate rather than emptying the initial target pool.
    expect(filterInitialTargetWindowCandidates([child])).toEqual([child]);
    expect(filterInitialTargetWindowCandidates([root, root, child])).toEqual([root, root, child]);
  });

  it("matches a complete Chinese app identity followed by a generic location particle", () => {
    const wechat = { pid: 102_140, windowId: 33_296_778, appName: "Weixin", title: "微信" };
    expect(matchGoalToWindow("在微信上给测试联系人发消息", [wechat])).toEqual({
      kind: "matched",
      match: { target: wechat },
    });
  });

  it("abstains when a Chinese app identity is only embedded in another word", () => {
    expect(matchGoalToWindow("在微信工作台上查看", [
      { pid: 1, windowId: 10, appName: "微信", title: "" },
    ])).toEqual({ kind: "none" });
  });

  it("uses Chinese word boundaries for another two-character title", () => {
    const settings = { pid: 2, windowId: 20, appName: "", title: "设置" };
    expect(matchGoalToWindow("在设置中更改显示选项", [settings])).toEqual({
      kind: "matched",
      match: { target: settings },
    });
    expect(matchGoalToWindow("在设置中心查看服务", [settings])).toEqual({ kind: "none" });
  });

  it("matches a task identity followed by recognized window-title context", () => {
    const target = { pid: 3, windowId: 30, title: "项目管理查询结果页面" };
    expect(matchGoalToWindow("整理项目管理查询结果", [target])).toEqual({
      kind: "matched",
      match: { target },
    });
  });

  it("treats an explicitly named application as a constraint instead of matching another window's task-content title", () => {
    const wps = { pid: 4, windowId: 40, appName: "WPS Office", title: "CW02.docx" };
    const notepad = { pid: 5, windowId: 50, appName: "Notepad", title: "周可轩" };
    expect(matchGoalToWindow("在wps写入周可轩我爱你，字体大小四号，并保存", [wps, notepad])).toEqual({
      kind: "matched",
      match: { target: wps },
    });
  });

  it.each([
    "请在WPS里打开报告并填写内容",
    "帮我在WPS里打开报告并填写内容",
    "用WPS打开报告并填写内容",
  ])("honors the explicitly named WPS app after common Chinese request prefixes: %s", (goal) => {
    const draft = { pid: 12, windowId: 120, appName: "WPS Office", title: "草稿.docx" };
    const report = { pid: 12, windowId: 121, appName: "WPS Office", title: "报告.docx" };
    const notepad = { pid: 13, windowId: 130, appName: "Notepad", title: "报告" };
    const targets = [draft, report, notepad];
    expect(hasExplicitApplicationIntent(goal)).toBe(true);
    expect(targetsForExplicitApplicationIntent(goal, targets)).toEqual([draft, report]);
    expect(matchGoalToWindow(goal, targets)).toEqual({
      kind: "matched",
      match: { target: report },
    });
  });

  it("does not turn a later app mention into an explicit target constraint", () => {
    expect(hasExplicitApplicationIntent("从WPS复制到记事本")).toBe(false);
  });

  it("abstains instead of selecting a content-title match when the requested application is absent", () => {
    const notepad = { pid: 6, windowId: 60, appName: "Notepad", title: "周可轩" };
    expect(matchGoalToWindow("在wps写入周可轩我爱你，字体大小四号，并保存", [notepad])).toEqual({ kind: "none" });
  });

  it("requires manual selection when an explicitly named app has multiple windows", () => {
    const first = { pid: 7, windowId: 70, appName: "WPS Office", title: "First.docx" };
    const second = { pid: 7, windowId: 71, appName: "WPS Office", title: "Second.docx" };
    expect(matchGoalToWindow("在wps写入内容", [first, second])).toEqual({ kind: "ambiguous" });
  });

  it("uses an explicitly named document title to disambiguate within that app", () => {
    const unrelatedWps = { pid: 10, windowId: 100, appName: "WPS Office", title: "草稿" };
    const requestedWps = { pid: 10, windowId: 101, appName: "WPS Office", title: "报告" };
    const notepad = { pid: 11, windowId: 110, appName: "Notepad", title: "报告" };
    expect(matchGoalToWindow("在wps打开报告", [unrelatedWps, requestedWps, notepad])).toEqual({
      kind: "matched",
      match: { target: requestedWps },
    });
  });

  it("recognizes explicit English application placement without allowing unrelated title matches", () => {
    const chrome = { pid: 8, windowId: 80, appName: "Google Chrome", title: "New Tab" };
    const notepad = { pid: 9, windowId: 90, appName: "Notepad", title: "Flight search" };
    expect(matchGoalToWindow("Search for flights in Chrome", [chrome, notepad])).toEqual({
      kind: "matched",
      match: { target: chrome },
    });
  });

  it("owns the automatic titled-sibling policy while keeping titled windows ambiguous", () => {
    const main = { pid: 10, windowId: 100, appName: "TextEdit", title: "Notes" };
    const saveSheet = { pid: 10, windowId: 101, appName: "TextEdit", title: undefined };
    expect(matchGoalToWindow("打开 TextEdit", [main, saveSheet])).toEqual({
      kind: "matched",
      match: { target: main },
    });
    expect(matchGoalToWindow("打开 TextEdit", [
      main,
      { pid: 10, windowId: 102, appName: "TextEdit", title: "Other" },
      saveSheet,
    ])).toEqual({ kind: "ambiguous" });
  });
});
