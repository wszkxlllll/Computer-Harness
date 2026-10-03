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
            selectedWindowLabel: {
              status: "matched",
              source: "latest_list_windows_inventory",
              appName: "WPS",
              title: "Review draft - unsaved",
            },
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
    expect(document.querySelector(".approval-action-summary")?.textContent).toContain("点击");
    expect(screen.getByText("输入 12 字")).toBeDefined();
    expect(screen.getByText("按 Ctrl + L")).toBeDefined();
    expect(screen.getByText("(408, 667)")).toBeDefined();
    expect(screen.getByText("12 个字符（内容不显示）")).toBeDefined();
    expect(screen.getByText("CTRL + L")).toBeDefined();
    expect(screen.getByText("模型说明（未经验证）")).toBeDefined();
    expect(screen.getByText("The save button")).toBeDefined();
    expect(screen.getByText("Save the updated preferences")).toBeDefined();
    expect(screen.getByText("窗口目标核对信息（主机清单）")).toBeDefined();
    expect(screen.getByText("WPS · Review draft - unsaved")).toBeDefined();
    expect(screen.getByText(/选择时/)).toBeDefined();
    const moreDetails = screen.getByText("更多信息").closest("details") as HTMLDetailsElement;
    expect(moreDetails.open).toBe(false);
    moreDetails.open = true;
    expect(screen.getByText("This operation requires approval.")).toBeDefined();
    expect(screen.getByText("(408, 667)")).toBeDefined();
    expect(document.querySelectorAll(".approval-action-list > li")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "允许这项操作" })).toBeDefined();
    expect(screen.getByRole("button", { name: "拒绝" })).toBeDefined();
  });

  it("fails closed when a switch approval has no host-listed label", () => {
    render(
      <PendingRequestPanel
        request={{
          requestId: "approval-switch-unlisted",
          kind: "approval",
          reason: "Confirm the target.",
          preview: {
            actions: [{ operation: "switch_window", kind: "switch_window" }],
            selectedWindowLabel: { status: "unavailable", source: "unavailable" },
          },
        }}
        onApprove={vi.fn()}
        onRespond={vi.fn()}
        onChooseWindow={vi.fn()}
        onIgnoreNewWindow={vi.fn()}
      />,
    );

    expect(screen.getByText(/无法将目标与最近的主机窗口清单匹配/)).toBeDefined();
    expect(screen.getAllByText(/请求绑定截图可能仍显示原窗口/).length).toBeGreaterThan(0);
    expect(document.querySelector(".approval-preview-content")?.textContent).not.toContain("WPS");
  });

  it("gives a truthful fallback and keeps the approval decision available without a preview", () => {
    render(
      <PendingRequestPanel
        request={{ requestId: "approval-without-preview", kind: "approval", reason: "Approval is required.", requiresVisualReview: false }}
        onApprove={vi.fn()}
        onRespond={vi.fn()}
        onChooseWindow={vi.fn()}
        onIgnoreNewWindow={vi.fn()}
      />,
    );

    expect(screen.getByText("Approval is required.")).toBeDefined();
    expect(screen.getByText("电脑没有提供操作参数。请根据请求说明自行判断是否处理。")).toBeDefined();
    expect(screen.queryByText("模型说明（未经验证）")).toBeNull();
    expect((screen.getByRole("button", { name: "允许这项操作" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("button", { name: "拒绝" })).toBeDefined();
  });

  it("requires the request-bound image to load before approving computer actions", async () => {
    render(
      <PendingRequestPanel
        request={{
          requestId: "computer-approval-1",
          kind: "approval",
          reason: "Synthetic risk reason. Inspect the shown current screenshot before approving.",
          preview: {
            actions: [{ operation: "keypress", kind: "keypress", keys: ["ENTER"] }],
            evidence: {
              assetId: "bound-asset",
              observationId: "obs-evidence",
              decisionObservationId: "obs-decision",
              capturedAt: "2026-09-27T00:00:00.000Z",
              viewport: { width: 1280, height: 720, coordinateSpace: "physical" },
            },
            modelDeclaredEffect: { target: "Submit button", summary: "Send a form", verified: false },
          },
        }}
        runId="run-1"
        latestAssetId="newer-asset"
        onApprove={vi.fn()}
        onRespond={vi.fn()}
        onChooseWindow={vi.fn()}
        onIgnoreNewWindow={vi.fn()}
      />,
    );

    const approve = screen.getByRole("button", { name: "允许这项操作" }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(screen.getByText(/采集于请求提出前/)).toBeDefined();
    expect(screen.getByText(/请核对目标和画面/)).toBeDefined();
    expect(screen.getByText(/电脑无法证明机器焦点/)).toBeDefined();
    expect(screen.getByText(/读屏无法读取截图/)).toBeDefined();
    const actionDetails = screen.getByText("更多信息").closest("details") as HTMLDetailsElement;
    const evidenceDetails = screen.getByText("截图与坐标信息").closest("details") as HTMLDetailsElement;
    expect(actionDetails.open).toBe(false);
    expect(evidenceDetails.open).toBe(false);
    actionDetails.open = true;
    evidenceDetails.open = true;
    expect(screen.getByText(/没有叠加到截图/)).toBeDefined();
    expect(screen.getByText("模型说明（未经验证）")).toBeDefined();
    expect(screen.getByRole("button", { name: "拒绝" })).toBeDefined();
    const image = screen.getByRole("img", { name: /绑定的电脑画面/ });
    fireEvent.load(image);
    await waitFor(() => expect(approve.disabled).toBe(false));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps computer approval disabled and explains a screenshot load failure", async () => {
    render(
      <PendingRequestPanel
        request={{
          requestId: "computer-approval-image-failure",
          kind: "approval",
          preview: {
            actions: [{ operation: "click", kind: "click", points: [{ x: 9, y: 12 }] }],
            evidence: {
              assetId: "missing-image",
              observationId: "obs-evidence",
              decisionObservationId: "obs-decision",
              capturedAt: "2026-09-27T00:00:00.000Z",
              viewport: { width: 640, height: 480, coordinateSpace: "logical" },
            },
          },
        }}
        runId="run-1"
        onApprove={vi.fn()}
        onRespond={vi.fn()}
        onChooseWindow={vi.fn()}
        onIgnoreNewWindow={vi.fn()}
      />,
    );

    fireEvent.error(screen.getByRole("img", { name: /绑定的电脑画面/ }));
    expect(screen.getByText("绑定画面无法载入")).toBeDefined();
    expect(screen.getByRole("button", { name: "重新载入绑定画面" })).toBeDefined();
    expect((screen.getByRole("button", { name: "允许这项操作" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("fails closed when Runtime marks visual review required but preview projection is missing", () => {
    render(
      <PendingRequestPanel
        request={{ requestId: "missing-preview", kind: "approval", requiresVisualReview: true, reason: "A computer action needs visual review." }}
        runId="run-1"
        onApprove={vi.fn()}
        onRespond={vi.fn()}
        onChooseWindow={vi.fn()}
        onIgnoreNewWindow={vi.fn()}
      />,
    );
    expect(screen.getByText(/没有可打开的请求绑定画面/)).toBeDefined();
    expect((screen.getByRole("button", { name: "允许这项操作" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
