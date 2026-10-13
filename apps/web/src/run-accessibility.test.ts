import { describe, expect, it } from "vitest";
import { RunAnnouncementCursor } from "./run-accessibility";
import type { RunAnnouncementInput } from "./run-accessibility";

function input(overrides: Partial<RunAnnouncementInput> = {}): RunAnnouncementInput {
  return {
    runId: "run-1",
    status: "running",
    connection: "live",
    ...overrides,
  };
}

describe("Run accessibility announcements", () => {
  it("keeps the first snapshot silent and announces only meaningful status or progress changes", () => {
    const cursor = new RunAnnouncementCursor("run-1");
    const initial = input({ progressText: "电脑正在整理结果。" });
    expect(cursor.update(initial)).toBe("");

    expect(cursor.update({ ...initial, status: "paused" })).toBe("任务状态已更新：任务已暂停。");
    expect(cursor.update({ ...initial, status: "paused" })).toBe("");
    expect(cursor.update({ ...initial, status: "paused", progressText: "已整理两项结果。" }))
      .toBe("最近进展：已整理两项结果。");
    expect(cursor.update({ ...initial, status: "paused", progressText: "已整理两项结果。" })).toBe("");
  });

  it("announces a new approval with its reason, action summary, and visual review boundary", () => {
    const cursor = new RunAnnouncementCursor("run-1");
    cursor.update(input());

    const announcement = cursor.update(input({
      status: "waiting_approval",
      pending: {
        requestId: "approval-1",
        kind: "approval",
        reason: "请确认是否保存这些设置。",
        preview: {
          actions: [
            { operation: "click", kind: "click", points: [{ x: 20, y: 30 }] },
            { operation: "type", kind: "type", typedCharacterCount: 6 },
          ],
        },
      },
    }));

    expect(announcement).toContain("有一项待处理确认。");
    expect(announcement).toContain("原因：请确认是否保存这些设置。");
    expect(announcement).toContain("待批准操作：点击；输入 6 字。");
    expect(announcement).toContain("文字说明和操作摘要不能核实电脑当前画面");
    expect(announcement).not.toContain("任务状态已更新：等你确认操作");
  });

  it("announces a same-kind replacement when the request identity or its text changes", () => {
    const cursor = new RunAnnouncementCursor("run-1");
    const first = {
      requestId: "input-1",
      kind: "user_input",
      question: "应该使用哪个日期？",
    } as const;
    cursor.update(input({ status: "waiting_user", pending: first }));

    const replacement = cursor.update(input({
      status: "waiting_user",
      pending: { ...first, requestId: "input-2", question: "请确认新的送达地址。" },
    }));
    expect(replacement).toContain("电脑的补充请求已更新。");
    expect(replacement).toContain("请确认新的送达地址。");

    const revisedSameRequest = cursor.update(input({
      status: "waiting_user",
      pending: { ...first, requestId: "input-2", question: "请补充一个新的日期。" },
    }));
    expect(revisedSameRequest).toContain("电脑的补充请求已更新。");
    expect(revisedSameRequest).toContain("请补充一个新的日期。");
  });

  it("announces terminal unknown outcomes and errors without claiming success", () => {
    const cursor = new RunAnnouncementCursor("run-1");
    cursor.update(input());

    const announcement = cursor.update(input({
      status: "finished",
      outcome: "outcome_unknown",
      snapshotError: "电脑没有确认最后一步是否完成。",
    }));

    expect(announcement).toContain("任务已结束。结果状态：结果待确认。");
    expect(announcement).toContain("任务结果说明已显示在任务结果中。");
    expect(announcement).toContain("原因：电脑没有确认最后一步是否完成。");
    expect(announcement).not.toContain("已完成");
  });

  it("combines connection and command updates in the same semantic message", () => {
    const cursor = new RunAnnouncementCursor("run-1");
    cursor.update(input());

    const announcement = cursor.update(input({
      connection: "offline",
      feedError: "暂时无法刷新任务状态。",
      commandNotice: "已发送暂停请求，等待电脑回执。",
    }));
    expect(announcement).toContain("手机与电脑的任务状态连接中断。");
    expect(announcement).toContain("电脑上的任务可能仍在继续");
    expect(announcement).toContain("读取说明：暂时无法刷新任务状态。");
    expect(announcement).toContain("已发送暂停请求，等待电脑回执。");
  });

  it("resets its baseline when the user navigates to another Run", () => {
    const cursor = new RunAnnouncementCursor("run-1");
    cursor.update(input());
    expect(cursor.update(input({ runId: "run-2", status: "finished", outcome: "succeeded" }))).toBe("");
    expect(cursor.update(input({ runId: "run-2", status: "running" })))
      .toBe("任务状态已更新：电脑正在处理。");
  });
});
