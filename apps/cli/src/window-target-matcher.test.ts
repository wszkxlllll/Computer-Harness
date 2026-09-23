import { describe, expect, it } from "vitest";
import { matchGoalToWindow } from "./window-target-matcher.js";

describe("local goal to window matcher", () => {
  it("returns a unique exact application-name match", () => {
    const targets = [
      { pid: 1, windowId: 10, appName: "Google Chrome", title: "New Tab" },
      { pid: 2, windowId: 20, appName: "Visual Studio Code", title: "notes.ts" },
    ];

    expect(matchGoalToWindow("Open Google Chrome and inspect the current page", targets)).toMatchObject({
      kind: "matched",
      match: { target: targets[0], evidence: ["app: google chrome"] },
    });
  });

  it("recognizes a specific CJK window name after generic suffixes", () => {
    const targets = [
      { pid: 7, windowId: 70, appName: "浏览器", title: "项目管理查询结果页面" },
      { pid: 8, windowId: 80, appName: "浏览器", title: "笔记首页" },
    ];

    expect(matchGoalToWindow("整理项目管理查询结果", targets)).toMatchObject({
      kind: "matched",
      match: { target: targets[0], evidence: ["title: 项目管理"] },
    });
  });

  it.each([
    { goal: "Open the Microsoft Excel workbook", appName: "Microsoft Excel" },
    { goal: "Send a reply in Slack", appName: "Slack" },
    { goal: "Run the script in Windows Terminal", appName: "Windows Terminal" },
    { goal: "Open Google Chrome and inspect the page", appName: "Google Chrome" },
  ])("matches an exact everyday app identity for $appName", ({ goal, appName }) => {
    const target = { pid: 10, windowId: 100, appName, title: "Untitled" };
    expect(matchGoalToWindow(goal, [target])).toMatchObject({ kind: "matched", match: { target } });
  });

  it.each([
    { goal: "Open Chrome", appName: "Google Chrome" },
    { goal: "Open Excel workbook", appName: "Microsoft Excel" },
  ])("accepts a distinctive trailing app name when it is the goal's sole identity term", ({ goal, appName }) => {
    const target = { pid: 10, windowId: 100, appName, title: "Untitled" };
    expect(matchGoalToWindow(goal, [target])).toMatchObject({
      kind: "matched",
      match: { target, evidence: [`app suffix: ${appName.split(" ").at(-1)!.toLocaleLowerCase()}`] },
    });
  });

  it("accepts an exact two-character CJK application name as app identity", () => {
    const targets = [
      { pid: 1, windowId: 10, appName: "微信", title: "聊天" },
      { pid: 2, windowId: 20, appName: "浏览器", title: "新标签页" },
    ];

    expect(matchGoalToWindow("打开微信并查看消息", targets)).toMatchObject({
      kind: "matched",
      match: { target: targets[0], evidence: ["app: 微信"] },
    });
    expect(matchGoalToWindow("打开微信读书并阅读", [targets[0]!]).kind).toBe("none");
  });

  it("requires a complete longer CJK title identity instead of a partial brand mention", () => {
    const targets = [{ pid: 1, windowId: 10, appName: "浏览器", title: "携程旅行" }];

    expect(matchGoalToWindow("查看携程的订单", targets).kind).toBe("none");
  });

  it("does not auto-select when multiple visible windows confidently match", () => {
    const targets = [
      { pid: 1, windowId: 10, appName: "Google Chrome", title: "Chrome profile one" },
      { pid: 2, windowId: 20, appName: "Google Chrome", title: "Chrome profile two" },
    ];

    const result = matchGoalToWindow("Use Google Chrome to check the report", targets);
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") expect(result.candidates.map(({ target }) => target.windowId)).toEqual([10, 20]);
  });

  it("does not treat generic window or task language as a confident match", () => {
    const targets = [
      { pid: 1, windowId: 10, appName: "Browser", title: "New Tab" },
      { pid: 2, windowId: 20, appName: "Browser", title: "Untitled" },
    ];

    expect(matchGoalToWindow("Look at the browser window and search the page", targets).kind).toBe("none");
  });

  it("does not match a short Han location or task word from an arbitrary title", () => {
    const targets = [
      { pid: 1, windowId: 10, appName: "浏览器", title: "上海 — 订单列表" },
      { pid: 2, windowId: 20, appName: "Task Manager", title: "Processes" },
    ];

    expect(matchGoalToWindow("处理订单任务", targets).kind).toBe("none");
  });

  it("keeps two windows for the same named app ambiguous", () => {
    const targets = [
      { pid: 1, windowId: 10, appName: "Google Chrome", title: "Google — Orders" },
      { pid: 2, windowId: 20, appName: "Google Chrome", title: "Google — Calendar" },
    ];

    const result = matchGoalToWindow("Open Google Chrome and review the orders", targets);
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") expect(result.candidates.map(({ target }) => target.windowId)).toEqual([10, 20]);
  });

  it("rejects shared Latin words when they are not complete app or title identities", () => {
    const visualStudioCode = { pid: 1, windowId: 10, appName: "Visual Studio Code", title: "Chrome extension" };
    const googleChrome = { pid: 2, windowId: 20, appName: "Google Chrome", title: "New Tab" };

    expect(matchGoalToWindow("Open Chrome", [visualStudioCode]).kind).toBe("none");
    expect(matchGoalToWindow("Open Google Calendar", [googleChrome]).kind).toBe("none");
  });

  it("accepts complete leading title evidence", () => {
    const target = { pid: 1, windowId: 10, appName: "Visual Studio Code", title: "Chrome extension" };
    expect(matchGoalToWindow("Open the Chrome extension", [target])).toMatchObject({
      kind: "matched",
      match: { target, evidence: ["title: chrome extension"] },
    });
  });

  it("does not let a complete title override a different app named by the goal", () => {
    const target = {
      pid: 1,
      windowId: 10,
      appName: "Visual Studio Code",
      title: "Budget Report — Visual Studio Code",
    };

    expect(matchGoalToWindow("Open Budget Report in Microsoft Excel", [target]).kind).toBe("none");
    expect(matchGoalToWindow("Open Budget Report", [target])).toMatchObject({
      kind: "matched",
      match: { target, evidence: ["title: budget report"] },
    });
  });

  it("keeps only one confident candidate even when unrelated windows are visible", () => {
    const targets = [
      { pid: 1, windowId: 10, appName: "Slack", title: "General" },
      { pid: 2, windowId: 20, appName: "Notepad", title: "Untitled" },
      { pid: 3, windowId: 30, appName: "Calendar", title: "Today" },
    ];

    expect(matchGoalToWindow("Type the plan in Notepad", targets)).toMatchObject({
      kind: "matched",
      match: { target: targets[1] },
    });
  });
});
