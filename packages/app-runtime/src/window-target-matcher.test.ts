import { describe, expect, it } from "vitest";
import { matchGoalToWindow } from "./window-target-matcher.js";

describe("matchGoalToWindow", () => {
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

  it("ignores untitled auxiliary windows for automatic matching but keeps titled windows ambiguous", () => {
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
