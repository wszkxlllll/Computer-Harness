// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PendingRequestPanel } from "./PendingRequestPanel";
import type { ApprovalEvidence, PendingRequestBase } from "../types";

const parentSurfaceRef = {
  surfaceId: "surface-1", generation: 1, kind: "native_window",
} satisfies ApprovalEvidence["surfaceRef"];

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("pending request panel", () => {
  it("deduplicates handoff candidates by token and labels parent context separately from an untitled child", () => {
    const onChooseWindow = vi.fn().mockResolvedValue(undefined);
    const child = {
      token: "I".repeat(32),
      appName: "Editor.exe",
      relationship: { kind: "owned_child" as const, rootRole: "dialog" as const, parentAppName: "Editor.exe", parentTitle: "Parent document" },
    };
    const peer = {
      token: "J".repeat(32),
      appName: "Editor.exe",
      title: "Second document",
      relationship: { kind: "scoped_peer" as const },
    };
    render(
      <PendingRequestPanel
        request={{ requestId: "window-deduplicate-token", kind: "window_handoff", candidates: [child, { ...child }, peer] }}
        runId="run-deduplicate-token"
        onApprove={vi.fn()}
        onRespond={vi.fn()}
        onChooseWindow={onChooseWindow}
        onIgnoreNewWindow={vi.fn()}
      />,
    );

    expect(document.querySelectorAll(".window-choice-preview-item")).toHaveLength(2);
    expect(screen.getAllByText("窗口标题不可用")).toHaveLength(1);
    expect(screen.getByText("当前 Editor.exe · Parent document 的对话框")).toBeDefined();
    expect(screen.getByText("电脑已授权的另一窗口")).toBeDefined();
    expect(screen.getAllByRole("button", { name: "查看此窗口的真实画面" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: /Editor\.exe.*Second document/u })).toBeDefined();
    expect(onChooseWindow).not.toHaveBeenCalled();
  });

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
    expect(onRespond).toHaveBeenNthCalledWith(1, "Friday morning");
    expect(input.value).toBe("Friday morning");

    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(onRespond).toHaveBeenCalledTimes(2));
    expect(onRespond).toHaveBeenNthCalledWith(2, "Friday morning");
    expect(input.value).toBe("");
  });

  it("passes the selected approval decision to the current request", () => {
    const onApprove = vi.fn().mockResolvedValue(undefined);
    render(
      <PendingRequestPanel
        request={{ requestId: "approval-decision", kind: "approval", reason: "Review this operation.", requiresVisualReview: false }}
        onApprove={onApprove}
        onRespond={vi.fn()}
        onChooseWindow={vi.fn()}
        onIgnoreNewWindow={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "允许这项操作" }));
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    expect(onApprove.mock.calls).toEqual([[true], [false]]);
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

  it("shows trusted relation labels and requires a real preview before choosing an indistinguishable candidate", () => {
    render(
      <PendingRequestPanel
        request={{
          requestId: "window-relations",
          kind: "window_handoff",
          reasonCode: "foreground_mismatch",
          candidates: [{
            token: "dialog-token",
            appName: "WPS Office",
            title: "Save As",
            previewRequired: true,
            relationship: { kind: "owned_child", rootRole: "dialog", parentAppName: "WPS Office", parentTitle: "Report.docx" },
          }],
        }}
        onApprove={vi.fn()}
        onRespond={vi.fn()}
        onChooseWindow={vi.fn()}
        onIgnoreNewWindow={vi.fn()}
      />,
    );

    expect(screen.getByText("当前 WPS Office · Report.docx 的对话框")).toBeDefined();
    expect(screen.getByRole("button", { name: "查看此窗口的真实画面" })).toBeDefined();
    expect(screen.getByText(/标签重复或不完整的候选需要先看对应的真实画面/)).toBeDefined();
  });

  it("requires reviewing a fresh candidate-bound screenshot before confirming a handoff", async () => {
    const preview = {
      previewToken: "P".repeat(32),
      appName: "Notepad.exe",
      title: "Untitled - Notepad",
      capturedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      viewport: { width: 320, height: 240 },
      mediaType: "image/png",
      dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(preview), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const candidate = { token: "C".repeat(32), appName: "Notepad.exe", title: "Untitled - Notepad", previewRequired: true };
    const onChooseWindow = vi.fn().mockResolvedValue(undefined);
    render(
      <PendingRequestPanel
        request={{ requestId: "window-preview-4", kind: "window_handoff", reasonCode: "foreground_mismatch", candidates: [candidate] }}
        runId="run-preview"
        onApprove={vi.fn()}
        onRespond={vi.fn()}
        onChooseWindow={onChooseWindow}
        onIgnoreNewWindow={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "查看此窗口的真实画面" }));
    const image = await screen.findByRole("img", { name: /Notepad\.exe.*Untitled - Notepad/u });
    expect(fetchMock).toHaveBeenCalledWith("/api/runs/run-preview/window-candidates/preview", expect.objectContaining({
      method: "POST",
      cache: "no-store",
      body: JSON.stringify({ requestId: "window-preview-4", candidateToken: candidate.token }),
    }));
    expect(onChooseWindow).not.toHaveBeenCalled();

    fireEvent.load(image);
    fireEvent.click(await screen.findByRole("button", { name: "确认这个窗口并继续任务" }));
    await waitFor(() => expect(onChooseWindow).toHaveBeenCalledWith(candidate, preview.previewToken));
  });

  it("lets the operator inspect a unique handoff candidate without making its preview mandatory", async () => {
    const preview = {
      previewToken: "V".repeat(32),
      appName: "Notepad.exe",
      title: "Notes",
      capturedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      viewport: { width: 320, height: 240 },
      mediaType: "image/png" as const,
      dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(preview), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const candidate = { token: "U".repeat(32), appName: "Notepad.exe", title: "Notes" };
    const onChooseWindow = vi.fn().mockResolvedValue(undefined);
    render(
      <PendingRequestPanel
        request={{ requestId: "window-optional-preview", kind: "window_handoff", reasonCode: "foreground_mismatch", candidates: [candidate] }}
        runId="run-optional-preview"
        onApprove={vi.fn()}
        onRespond={vi.fn()}
        onChooseWindow={onChooseWindow}
        onIgnoreNewWindow={vi.fn()}
      />,
    );

    const directChoice = screen.getByRole("button", { name: /Notepad\.exe.*Notes/u });
    fireEvent.click(screen.getByRole("button", { name: "查看此窗口的真实画面" }));
    const image = await screen.findByRole("img", { name: /Notepad\.exe.*Notes/u });
    expect(fetchMock).toHaveBeenCalledWith("/api/runs/run-optional-preview/window-candidates/preview", expect.objectContaining({
      method: "POST",
      cache: "no-store",
      body: JSON.stringify({ requestId: "window-optional-preview", candidateToken: candidate.token }),
    }));
    expect(onChooseWindow).not.toHaveBeenCalled();

    fireEvent.load(image);
    expect(await screen.findByText("可选预览已显示；选择此窗口仍按原有确认规则进行。")).toBeDefined();
    fireEvent.click(directChoice);
    await waitFor(() => expect(onChooseWindow).toHaveBeenCalledWith(candidate));
  });

  it("removes a previously confirmed screenshot as soon as it is refreshed and keeps it unavailable after refresh failure", async () => {
    const preview = {
      previewToken: "T".repeat(32),
      appName: "Notepad.exe",
      title: "Untitled - Notepad",
      capturedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      viewport: { width: 320, height: 240 },
      mediaType: "image/png" as const,
      dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    };
    let resolveRefresh!: (response: Response) => void;
    const pendingRefresh = new Promise<Response>((resolve) => { resolveRefresh = resolve; });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(preview), { status: 200 }))
      .mockReturnValueOnce(pendingRefresh);
    vi.stubGlobal("fetch", fetchMock);
    const candidate = { token: "F".repeat(32), appName: "Notepad.exe", title: "Untitled - Notepad", previewRequired: true };
    render(
      <PendingRequestPanel
        request={{ requestId: "window-preview-refresh-proof", kind: "window_handoff", candidates: [candidate] }}
        runId="run-preview-refresh-proof"
        onApprove={vi.fn()}
        onRespond={vi.fn()}
        onChooseWindow={vi.fn()}
        onIgnoreNewWindow={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "查看此窗口的真实画面" }));
    const image = await screen.findByRole("img");
    fireEvent.load(image);
    expect(await screen.findByRole("button", { name: "确认这个窗口并继续任务" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "重新读取窗口预览" }));
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByRole("button", { name: "确认这个窗口并继续任务" })).toBeNull();
    resolveRefresh(new Response(JSON.stringify({ error: { code: "WINDOW_PREVIEW_UNAVAILABLE" } }), { status: 503 }));
    expect(await screen.findByRole("alert")).toBeDefined();
    expect(screen.queryByRole("button", { name: "确认这个窗口并继续任务" })).toBeNull();
  });

  it("never substitutes an old candidate title for missing capture-time metadata or confirms a failed image", async () => {
    const preview = {
      previewToken: "R".repeat(32),
      capturedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      viewport: { width: 320, height: 240 },
      mediaType: "image/png" as const,
      dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(preview), { status: 200 })));
    render(
      <PendingRequestPanel
        request={{
          requestId: "window-preview-metadata",
          kind: "window_handoff",
          candidates: [{ token: "M".repeat(32), appName: "Old app label", title: "Old title", previewRequired: true }],
        }}
        runId="run-preview-metadata"
        onApprove={vi.fn()}
        onRespond={vi.fn()}
        onChooseWindow={vi.fn()}
        onIgnoreNewWindow={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "查看此窗口的真实画面" }));
    expect(await screen.findByText("捕获时应用：应用名不可用")).toBeDefined();
    expect(screen.getByText(/捕获时标题：窗口标题不可用/u)).toBeDefined();
    expect(screen.queryByText("捕获时应用：Old app label")).toBeNull();
    const image = screen.getByRole("img");
    fireEvent.error(image);
    expect(await screen.findByRole("alert")).toBeDefined();
    expect(screen.queryByRole("button", { name: "确认这个窗口并继续任务" })).toBeNull();
  });

  it("clears candidate screenshots when the same request refreshes to new candidate tokens", async () => {
    const preview = {
      previewToken: "S".repeat(32),
      appName: "Notepad.exe",
      title: "Untitled - Notepad",
      capturedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      viewport: { width: 320, height: 240 },
      mediaType: "image/png" as const,
      dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(preview), { status: 200 })));
    const request = { requestId: "window-preview-refresh", kind: "window_handoff", candidates: [{ token: "A".repeat(32), appName: "Notepad.exe", title: "Untitled - Notepad", previewRequired: true }] } satisfies PendingRequestBase;
    const onChooseWindow = vi.fn();
    const { rerender } = render(
      <PendingRequestPanel request={request} runId="run-preview-refresh" onApprove={vi.fn()} onRespond={vi.fn()} onChooseWindow={onChooseWindow} onIgnoreNewWindow={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "查看此窗口的真实画面" }));
    const image = await screen.findByRole("img");
    fireEvent.load(image);
    expect(await screen.findByRole("button", { name: "确认这个窗口并继续任务" })).toBeDefined();

    rerender(
      <PendingRequestPanel
        request={{ ...request, candidates: [{ ...request.candidates[0], token: "B".repeat(32) }] }}
        runId="run-preview-refresh"
        onApprove={vi.fn()}
        onRespond={vi.fn()}
        onChooseWindow={onChooseWindow}
        onIgnoreNewWindow={vi.fn()}
      />,
    );
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByRole("button", { name: "确认这个窗口并继续任务" })).toBeNull();
    await waitFor(() => {
      expect(screen.queryByRole("img")).toBeNull();
      expect(screen.queryByRole("button", { name: "确认这个窗口并继续任务" })).toBeNull();
    });
    expect(onChooseWindow).not.toHaveBeenCalled();
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
              surfaceRef: parentSurfaceRef,
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
              surfaceRef: parentSurfaceRef,
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
