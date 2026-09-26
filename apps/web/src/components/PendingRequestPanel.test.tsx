// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PendingRequestPanel } from "./PendingRequestPanel";

afterEach(() => cleanup());

describe("pending request panel", () => {
  it("preserves a typed answer until the host confirms it was applied", async () => {
    const onRespond = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(
      <PendingRequestPanel
        request={{ requestId: "input-1", kind: "user_input", question: "Which date works?" }}
        onApprove={vi.fn()}
        onRespond={onRespond}
        onChooseWindow={vi.fn()}
        onIgnoreNewWindow={vi.fn()}
      />,
    );

    const input = screen.getByLabelText("你的补充") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Friday morning" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(onRespond).toHaveBeenCalledTimes(1));
    expect(input.value).toBe("Friday morning");

    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(onRespond).toHaveBeenCalledTimes(2));
    expect(input.value).toBe("");
  });

  it("keeps foreground-mismatch window handoffs out of the ignore path", () => {
    render(
      <PendingRequestPanel
        request={{ requestId: "window-1", kind: "window_handoff", reasonCode: "foreground_mismatch", candidates: [] }}
        onApprove={vi.fn()}
        onRespond={vi.fn()}
        onChooseWindow={vi.fn()}
        onIgnoreNewWindow={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "忽略这个新窗口，继续原目标" })).toBeNull();
  });

  it("keeps a generic guard reason actionable and shows the bound proposed action details", () => {
    render(
      <PendingRequestPanel
        request={{
          requestId: "approval-1",
          kind: "approval",
          reason: "This operation requires approval.",
          preview: {
            actions: [
              { operation: "click", kind: "click", points: [{ x: 408, y: 667 }] },
              { operation: "type", kind: "type", typedCharacterCount: 12 },
              { operation: "hotkey", kind: "keypress", keys: ["CTRL", "L"] },
            ],
            modelDeclaredEffect: {
              target: "The save button",
              summary: "Save the updated preferences",
              verified: false,
            },
          },
        }}
        onApprove={vi.fn()}
        onRespond={vi.fn()}
        onChooseWindow={vi.fn()}
        onIgnoreNewWindow={vi.fn()}
      />,
    );

    expect(screen.getByText("This operation requires approval.")).toBeDefined();
    expect(screen.getByText("点击")).toBeDefined();
    expect(screen.getByText("(408, 667)")).toBeDefined();
    expect(screen.getByText("12 个字符（内容不显示）")).toBeDefined();
    expect(screen.getByText("CTRL + L")).toBeDefined();
    expect(screen.getByText("模型说明（未经验证）")).toBeDefined();
    expect(screen.getByText("模型声明的目标：")).toBeDefined();
    expect(screen.getByText("模型给出的摘要：")).toBeDefined();
    expect(document.querySelectorAll(".approval-action-list > li")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "确认这项操作" })).toBeDefined();
    expect(screen.getByRole("button", { name: "拒绝" })).toBeDefined();
  });

  it("gives a truthful fallback and keeps the approval decision available without a preview", () => {
    render(
      <PendingRequestPanel
        request={{ requestId: "approval-without-preview", kind: "approval", reason: "Approval is required." }}
        onApprove={vi.fn()}
        onRespond={vi.fn()}
        onChooseWindow={vi.fn()}
        onIgnoreNewWindow={vi.fn()}
      />,
    );

    expect(screen.getByText("Approval is required.")).toBeDefined();
    expect(screen.getByText("电脑未提供具体操作预览。请核对电脑当前画面；如果无法确认，请选择拒绝。")).toBeDefined();
    expect(screen.queryByText("模型说明（未经验证）")).toBeNull();
    expect(screen.getByRole("button", { name: "确认这项操作" })).toBeDefined();
    expect(screen.getByRole("button", { name: "拒绝" })).toBeDefined();
  });
});
