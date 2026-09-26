// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScreenshotPanel } from "./ScreenshotPanel";

afterEach(() => cleanup());

describe("authenticated screenshot viewer", () => {
  it("pins the opened same-origin asset while newer screenshots arrive and returns focus", async () => {
    const onViewerOpened = vi.fn();
    const onViewerClosed = vi.fn();
    const view = render(
      <ScreenshotPanel runId="run 1" assetId="asset-old" requestId="request-old" onViewerOpened={onViewerOpened} onViewerClosed={onViewerClosed} />,
    );

    const opener = screen.getByRole("button", { name: /全屏查看截图/ });
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "最近一次观察到的电脑画面" });
    const image = dialog.querySelector("img")!;
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "关闭" })));
    expect((opener as HTMLButtonElement).inert).toBe(true);
    expect(image.getAttribute("src")).toContain("/api/runs/run%201/assets/asset-old");
    expect(onViewerOpened).toHaveBeenCalledWith("request-old");
    expect(screen.getByRole("button", { name: "放大截图" })).toBeDefined();
    expect(screen.getByRole("button", { name: "适合屏幕" })).toBeDefined();
    expect(screen.getByRole("button", { name: "向左平移截图" })).toBeDefined();
    const lastControl = screen.getByRole("button", { name: "向右平移截图" });
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(lastControl);

    fireEvent.load(image);
    view.rerender(
      <ScreenshotPanel runId="run 1" assetId="asset-new" requestId="request-new" onViewerOpened={onViewerOpened} onViewerClosed={onViewerClosed} />,
    );
    expect(screen.getByText("有更新截图；当前画面保持不变。关闭后可查看新图。")).toBeDefined();
    expect(dialog.querySelector("img")?.getAttribute("src")).toContain("/api/runs/run%201/assets/asset-old");
    expect(document.querySelector('a[target="_blank"]')).toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onViewerClosed).toHaveBeenCalledWith("request-old", false);
    expect((opener as HTMLButtonElement).inert).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /全屏查看截图/ }));
  });
});
