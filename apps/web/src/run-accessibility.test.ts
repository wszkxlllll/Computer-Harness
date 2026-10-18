import { describe, expect, it } from "vitest";
import { RunAnnouncementCursor, pendingRequestAnnouncement } from "./run-accessibility";
import type { PendingRequestBase } from "./types";
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
    expect(announcement).toContain("还不能确定具体对象和影响，请先不要批准。");
    expect(announcement).not.toContain("任务状态已更新：等你确认操作");
  });

  it("reads the current approval plan as intended, unexecuted, and unverified without replacing the action list", () => {
    const cursor = new RunAnnouncementCursor("run-1");
    cursor.update(input());
    const pending: PendingRequestBase = {
      requestId: "approval-plan",
      kind: "approval",
      reason: "请核对这项操作。",
      requiresVisualReview: true,
      preview: {
        actions: [{ operation: "click", kind: "click" as const, points: [{ x: 12, y: 24 }] }],
        modelDeclaredEffect: { target: "Message editor", summary: "Send the prepared message", verified: false as const },
      },
    };

    const announcement = cursor.update(input({ status: "waiting_approval", pending }));

    expect(announcement).toContain("电脑打算按这份说明操作：「Send the prepared message」；目标：「Message editor」。");
    expect(announcement).toContain("这项操作还没执行；说明未经核实，仍需核对。");
    expect(announcement).toContain("待批准操作：点击。");
    expect(announcement).toContain("无法核对目标或后果时，请拒绝");
    expect(announcement).not.toContain("已执行结果");
    expect(announcement).not.toContain("已批准");
  });

  it("announces an updated plan on the same pending request and stays unclear when its data is incomplete", () => {
    const cursor = new RunAnnouncementCursor("run-1");
    const pending: PendingRequestBase = {
      requestId: "approval-plan-update",
      kind: "approval",
      requiresVisualReview: true,
      preview: { actions: [{ operation: "click", kind: "click" as const, points: [{ x: 12, y: 24 }] }] },
    };
    cursor.update(input({ status: "waiting_approval", pending }));

    const updated = cursor.update(input({
      status: "waiting_approval",
      pending: {
        ...pending,
        preview: {
          ...pending.preview!,
          modelDeclaredEffect: { target: "", summary: "", verified: false as const },
        },
      },
    }));
    expect(updated).toContain("还不能确定具体对象和影响，请先不要批准。");
    expect(updated).not.toContain("目标：「");

    const missing = pendingRequestAnnouncement({
      requestId: "approval-plan-missing",
      kind: "approval",
      preview: { actions: [] },
    });
    expect(missing).toContain("还不能确定具体对象和影响，请先不要批准。");
  });

  it("does not auto-read model plan fields flagged by the shared full-value privacy filter", () => {
    const unsafePlans = [
      { target: "Message editor", summary: `${"A".repeat(220)} verification code 123456`, verified: false as const },
      { target: "verification", summary: "code 123456", verified: false as const },
    ];

    for (const modelDeclaredEffect of unsafePlans) {
      const announcement = pendingRequestAnnouncement({
        requestId: "approval-sensitive-plan",
        kind: "approval",
        preview: { actions: [], modelDeclaredEffect },
      });
      expect(announcement).toContain("具体说明不适合自动朗读");
      expect(announcement).toContain("请在审批详情核对");
      expect(announcement).not.toContain("verification code");
      expect(announcement).not.toContain("123456");
    }
  });

  it("bounds safe plan fields with omission marks while retaining the fixed review disclaimer", () => {
    const target = "T".repeat(80);
    const summary = "S".repeat(130);
    const announcement = pendingRequestAnnouncement({
      requestId: "approval-long-plan",
      kind: "approval",
      preview: { actions: [], modelDeclaredEffect: { target, summary, verified: false } },
    });

    expect(announcement).toContain(`电脑打算按这份说明操作：「${"S".repeat(95)}…」；目标：「${"T".repeat(63)}…」。`);
    expect(announcement).toContain("这项操作还没执行；说明未经核实，仍需核对。");
    expect(announcement).not.toContain(summary);
    expect(announcement).not.toContain(target);
  });

  it("normalizes control characters before reading a safe model plan", () => {
    const announcement = pendingRequestAnnouncement({
      requestId: "approval-control-plan",
      kind: "approval",
      preview: {
        actions: [],
        modelDeclaredEffect: { target: "Message\u0000editor", summary: "Send\u200bthe prepared message", verified: false },
      },
    });

    expect(announcement).toContain("电脑打算按这份说明操作：「Send the prepared message」；目标：「Message editor」。");
    expect(announcement).not.toContain("\u0000");
    expect(announcement).not.toContain("\u200b");
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
