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
    expect(guidance?.text).toContain("仅见尾部≠前缀丢失");
    expect(guidance?.text).toContain("菜单明确显示快捷键时优先使用");
    expect(guidance?.text).toContain("文件名框裁剪≠路径丢失");
    expect(guidance?.text).not.toContain("Google Chrome");
  });

  it("uses exact app labels and one in-progress phase only to break a Goal-category tie", () => {
    const goal = "新建文档并保存，再比较查询结果。";
    const ambiguous = select({ goal, windowSwitchState: { currentWindow: { appName: "Unknown application" } } });
    const documentApp = select({ goal, windowSwitchState: { currentWindow: { appName: "Notepad" } } });
    const textEditApp = select({ goal, windowSwitchState: { currentWindow: { appName: "TextEdit" } } });
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
    expect(textEditApp?.id).toBe("text_document_save");
    expect(researchApp?.id).toBe("structured_extract");
    expect(activeDocumentPhase?.id).toBe("text_document_save");
    expect(ambiguousPlan?.id).toBe("combined_task_guidance");
  });

  it("keeps exact-text and TextEdit save-stage advice generic rather than rewriting the requested body", () => {
    const withFinalLf = select({ goal: "Create and save a document containing exactly draft-body\n" });
    const withoutFinalLf = select({ goal: "Create and save a document containing exactly draft-body, with no final LF." });
    expect(withFinalLf).toEqual(withoutFinalLf);
    expect(withFinalLf?.text).toContain("保留原文空白与末尾LF");
    expect(withFinalLf?.text).toContain("分清目录输入/文件名/标题");
    expect(withFinalLf?.text).toContain("输入全名含后缀");
    expect(withFinalLf?.text).toContain("先辨面板类型：名称/标签/位置弹层无保存按钮≠保存框");
    expect(withFinalLf?.text).toContain("未见字段/按钮不臆造");
    expect(withFinalLf?.text).toContain("Shift-Cmd-S可能Duplicate");
    expect(withFinalLf?.text).toContain("核目录/全名再保存");
    expect(withFinalLf?.text).toContain("内容正确≠精确路径");
    expect(withFinalLf?.text).toContain("过渡不明时独立wait(0)一次，仍不明则报告未确认，不重复Enter");
    expect(withFinalLf?.text).toContain("Cmd+S未必重开面板");
    expect(withFinalLf?.text).toContain("标题不单独证明保存");
    expect(withFinalLf?.text).toContain('macOS关闭用["CMD","W"]；["W"]只输入字符');
    expect([...withFinalLf!.text].length).toBeLessThanOrEqual(325);
    expect(withFinalLf?.text).not.toContain("draft-body");
  });

  it("keeps both task principles when a Goal matches both and app or phase metadata is unavailable", () => {
    const guidance = select({
      goal: "请比较查询结果，并新建文档保存。",
      windowSwitchState: { currentWindow: { appName: "Unknown editor" } },
    });

    expect(guidance?.id).toBe("combined_task_guidance");
    expect(guidance?.text).toContain("编辑前核内容");
    expect(guidance?.text).toContain("仅见尾部≠前缀丢失");
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

  it.each([
    "不需要新建文稿，直接保存当前文稿。",
    "不要新建，编辑已有报告并保存。",
    "保存当前文档，不需要新建文档。",
    "不需要新建；将报告保存到桌面。不使用终端，不重复未知的输入或保存。",
    "Don't create a new document, save the current document.",
    "Save the current document. Do not create a new one.",
    "No need to create a document; instead edit and save the existing report.",
  ])("keeps explicit document work despite a local creation prohibition: %s", (goal) => {
    expect(select({ goal })?.id).toBe("text_document_save");
    expect(select({ goal: "Compare search results.", recentEvents: [userInput(0, goal)] })?.id).toBe("text_document_save");
  });

  it.each([
    "不用新建，也不用保存文稿。",
    "不需要保存文稿了，先回答问题。",
    "停止保存文稿，先回答问题。",
    "Do not create or save a document.",
    "Do not create, edit, or save a document.",
    "不要新建，编辑，或保存文稿。",
    "保存当前文稿，等等，停止保存文稿，先回答问题。",
    "写一份报告，但不要保存报告。",
    "Create a report, but do not save the report.",
    "No need to save the report. Answer the question instead.",
  ])("does not revive document guidance for fully negated work or a cancellation: %s", (text) => {
    expect(select({ goal: text })).toBeUndefined();
    expect(select({ recentEvents: [userInput(0, text)] })).toBeUndefined();
  });

  it.each(["不要新建文档。", "不需要新建文稿。", "Do not create a new document."])("keeps an existing save Goal when the correction only prohibits creation: %s", (text) => {
    expect(select({ goal: text })).toBeUndefined();
    expect(select({ goal: "保存当前文稿。", recentEvents: [userInput(0, text)] })?.id).toBe("text_document_save");
  });

  it.each(["不要保存旧报告，改为保存当前文稿。", "Do not save the old report; instead save the current document."])("restores guidance after an explicit later save request: %s", (text) => {
    expect(select({ goal: text })?.id).toBe("text_document_save");
    expect(select({ recentEvents: [userInput(0, text)] })?.id).toBe("text_document_save");
  });

  it("keeps research and save guidance with an existing-document goal and a pending research plan", () => {
    const goal = "比较官网两款商品。查询完成后，回到已打开的文本编辑文稿，直接写入中文报告，不需要新建文稿。将报告保存到桌面。不必关闭后重新打开。不使用终端，不重复未知的输入或保存。";
    const guidance = select({
      goal,
      plan: { runId, tasks: [{ id: "t1", subject: "查询商品信息", status: "pending" }] },
    });
    expect(guidance?.id).toBe("combined_task_guidance");
    expect(guidance?.text).toContain("Shift-Cmd-S可能Duplicate");
    expect(guidance?.text).toContain("只记录界面或来源明确给出的关系");
    expect(select({ goal, windowSwitchState: { currentWindow: { appName: "文本编辑" } } })?.id).toBe("text_document_save");
  });
});
