// @vitest-environment happy-dom
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAssetUrl } from "../api";
import { ScreenshotPanel } from "./ScreenshotPanel";

afterEach(() => cleanup());

describe("authenticated screenshot viewer", () => {
  it("retries the same authenticated no-store PNG URL after a transient HTTP failure", async () => {
    const assetPath = runAssetUrl("run-http", "asset-http");
    const requests: Array<{ url?: string; cookie?: string }> = [];
    let attempt = 0;
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    const server = createServer((request, response) => {
      requests.push({ url: request.url, cookie: request.headers.cookie });
      response.setHeader("Cache-Control", "no-store");
      attempt += 1;
      if (attempt === 1) {
        response.statusCode = 503;
        response.end();
        return;
      }
      response.setHeader("Content-Type", "image/png");
      response.setHeader("Content-Length", String(png.byteLength));
      response.end(png);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("mock asset server did not bind a TCP port");

    try {
      const url = `http://127.0.0.1:${address.port}${assetPath}`;
      async function getAsset(): Promise<{ statusCode?: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
        return new Promise((resolve, reject) => {
          const request = httpRequest(url, { headers: { Cookie: "session=fixture" } }, (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () => resolve({
              statusCode: response.statusCode,
              headers: response.headers,
              body: Buffer.concat(chunks),
            }));
          });
          request.on("error", reject);
          request.end();
        });
      }
      const first = await getAsset();
      expect(first.statusCode).toBe(503);

      const second = await getAsset();
      expect(second.statusCode).toBe(200);
      expect(second.headers["content-type"]).toBe("image/png");
      expect(second.headers["cache-control"]).toBe("no-store");
      expect(second.body).toEqual(png);
      expect(requests).toEqual([
        { url: assetPath, cookie: "session=fixture" },
        { url: assetPath, cookie: "session=fixture" },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("announces thumbnail loading and lets the user retry a failed full-screen image", async () => {
    render(
      <ScreenshotPanel runId="run-retry" assetId="asset-retry" onViewerOpened={vi.fn()} onViewerClosed={vi.fn()} />,
    );

    expect(screen.getByText("正在载入最近截图…")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /全屏查看截图/ }));
    const firstImage = await screen.findByRole("img", { name: /最近一次观察到的桌面画面/ });
    expect(screen.getByText("正在载入截图…")).toBeDefined();

    fireEvent.error(firstImage);
    expect(screen.getByRole("alert").textContent).toContain("无法载入这张截图");
    const retryButton = screen.getByRole("button", { name: "重新载入截图" });
    fireEvent.click(retryButton);

    const retriedImage = await screen.findByRole("img", { name: /最近一次观察到的桌面画面/ });
    expect(retriedImage.getAttribute("src")).toBe("/api/runs/run-retry/assets/asset-retry");
    fireEvent.load(retriedImage);
    expect(screen.queryByRole("alert")).toBeNull();
  });

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
    const controls = screen.getByRole("group", { name: "截图缩放和平移控制" });
    expect(controls).toBeDefined();
    const zoomIn = within(controls).getByRole("button", { name: "放大截图" });
    const zoomOut = within(controls).getByRole("button", { name: "缩小截图" });
    expect(zoomIn.getAttribute("aria-controls")).toBe("screenshot-viewer-stage");
    expect(screen.getByRole("status", { name: "当前缩放比例 100%" })).toBeDefined();
    fireEvent.click(zoomIn);
    expect(screen.getByRole("status", { name: "当前缩放比例 125%" })).toBeDefined();
    expect(screen.getByRole("button", { name: "适合屏幕" })).toBeDefined();
    expect(screen.getByRole("button", { name: "向左平移截图" })).toBeDefined();
    const lastControl = screen.getByRole("button", { name: "向右平移截图" });
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(lastControl);
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "关闭" }));

    for (let index = 0; index < 8; index += 1) fireEvent.click(zoomOut);
    expect(screen.getByRole("status", { name: "当前缩放比例 50%" })).toBeDefined();
    expect((zoomOut as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "适合屏幕" }));
    expect(screen.getByRole("status", { name: "当前缩放比例 100%" })).toBeDefined();
    expect((zoomOut as HTMLButtonElement).disabled).toBe(false);
    for (let index = 0; index < 8; index += 1) fireEvent.click(zoomIn);
    expect(screen.getByRole("status", { name: "当前缩放比例 500%" })).toBeDefined();
    expect((zoomIn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "适合屏幕" }));

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
