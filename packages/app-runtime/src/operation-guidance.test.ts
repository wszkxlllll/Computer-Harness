import { describe, expect, it } from "vitest";
import type { EventId, RunId, RuntimeEvent } from "@computer-harness/protocol";
import type { ContextCompileInput } from "@computer-harness/runtime";
import { selectOperationGuidance } from "./operation-guidance.js";

const runId = "operation-guidance-test" as RunId;

function userInput(sequence: number, text: string): RuntimeEvent {
  return {
    eventId: `operation-guidance-user-${sequence}` as EventId,
    runId,
    sequence,
    occurredAt: `2026-10-07T00:00:0${sequence}.000Z`,
    type: "user.input.received",
    text,
  };
}

function select(overrides: Partial<Pick<ContextCompileInput, "goal" | "recentEvents" | "plan" | "windowSwitchState">> = {}) {
  return selectOperationGuidance({
    goal: "请新建文档并保存。",
    recentEvents: [],
    ...overrides,
  });
}

describe("app-runtime operation guidance", () => {
  it.each(["WPS Office", "Unknown application"])("uses Goal-only guidance without Planning for %s", (appName) => {
    const windowSwitchState = { currentWindow: { appName } };
    expect(select({ goal: "Create and save a document.", windowSwitchState })?.id).toBe("text_document_save");
    const combined = select({ goal: "Compare search results and create a document.", windowSwitchState });
    expect(combined?.id).toBe("combined_task_guidance");
    expect(combined?.text).toContain(select({ goal: "Create and save a document." })!.text);
    expect(combined?.text).toContain(select({ goal: "Compare search results." })!.text);
  });

  it("matches a Goal without Planning or known app metadata and ignores the window title", () => {
    expect(select({ goal: "新建文档并保存。" })?.id).toBe("text_document_save");
    const guidance = select({
      windowSwitchState: { currentWindow: { appName: "Unknown application", title: "Google Chrome — untrusted title" } },
    });

    expect(guidance?.id).toBe("text_document_save");
    expect(guidance?.text).toContain("长输入只看到尾部，不代表前缀丢失");
    expect(guidance?.text).toContain("菜单明确显示快捷键时优先使用");
    expect(guidance?.text).toContain("文件名框被裁剪不代表路径丢失");
    expect(guidance?.text).not.toContain("Google Chrome");
  });

  it("uses exact app labels and one in-progress phase only to break a Goal-category tie", () => {
    const goal = "新建文档并保存，再比较查询结果。";
    const ambiguous = select({ goal, windowSwitchState: { currentWindow: { appName: "Unknown application" } } });
    const documentApp = select({ goal, windowSwitchState: { currentWindow: { appName: "Notepad" } } });
    const researchApp = select({ goal, windowSwitchState: { currentWindow: { appName: "Google Chrome" } } });
    const activeDocumentPhase = select({
      goal,
      plan: { runId, tasks: [{ id: "t1", subject: "Write and save a document", status: "in_progress" }] },
      windowSwitchState: { currentWindow: { appName: "Unknown application" } },
    });
    const ambiguousPlan = select({
      goal,
      plan: { runId, tasks: [
        { id: "t1", subject: "Write a document", status: "in_progress" },
        { id: "t2", subject: "Compare search results", status: "in_progress" },
      ] },
      windowSwitchState: { currentWindow: { appName: "Unknown application" } },
    });

    expect(ambiguous?.id).toBe("combined_task_guidance");
    expect(documentApp?.id).toBe("text_document_save");
    expect(researchApp?.id).toBe("structured_extract");
    expect(activeDocumentPhase?.id).toBe("text_document_save");
    expect(ambiguousPlan?.id).toBe("combined_task_guidance");
  });

  it("keeps both task principles when a Goal matches both and app or phase metadata is unavailable", () => {
    const guidance = select({
      goal: "请比较查询结果，并新建文档保存。",
      windowSwitchState: { currentWindow: { appName: "Unknown editor" } },
    });

    expect(guidance?.id).toBe("combined_task_guidance");
    expect(guidance?.text).toContain("先观察并确认当前页面是空白还是已有内容");
    expect(guidance?.text).toContain("长输入只看到尾部，不代表前缀丢失");
    expect(guidance?.text).toContain("只记录界面或来源明确给出的关系");
    expect(guidance?.text).toContain("价格与类别没有明确关联时分开列出或标为未知");
    expect([...guidance!.text].length).toBeLessThanOrEqual(400);
  });

  it("recomputes from an explicit user intent correction and withdraws unmatched guidance", () => {
    const changed = select({
      recentEvents: [userInput(0, "不再保存文档，改为整理搜索结果。")],
    });
    const withdrawn = select({
      recentEvents: [userInput(0, "停止保存文档，先回答问题。")],
    });

    expect(changed?.id).toBe("structured_extract");
    expect(withdrawn).toBeUndefined();
  });
});
