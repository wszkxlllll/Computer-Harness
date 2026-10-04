// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RemoteEvent } from "../types";
import { EventTimeline } from "./EventTimeline";

afterEach(() => cleanup());

describe("mobile event timeline", () => {
  it("shows model, action, and monitor progress events", () => {
    render(<EventTimeline events={[
      { runId: "run", sequence: 1, type: "run.progress", data: { phase: "model", status: "started" } },
      { runId: "run", sequence: 2, type: "run.progress", data: { phase: "action", status: "completed" } },
      { runId: "run", sequence: 3, type: "run.progress", data: { phase: "monitor", status: "help_requested" } },
    ]} />);

    expect(screen.getByText("模型正在分析当前画面")).toBeDefined();
    expect(screen.getByText("电脑完成了一步操作")).toBeDefined();
    expect(screen.getByText("任务需要你检查当前画面")).toBeDefined();
  });

  it("does not promise recovery for a non-retryable model failure", () => {
    render(<EventTimeline events={[{
      runId: "run",
      sequence: 1,
      type: "run.progress",
      data: { phase: "model", status: "failed", retryable: false },
    }]} />);

    expect(screen.getByText("模型请求失败，任务可能结束")).toBeDefined();
    expect(screen.queryByText("模型请求失败，系统正在处理")).toBeNull();
  });
});

describe("EventTimeline Surface transitions", () => {
  it("shows safe transition labels without exposing opaque Surface IDs", () => {
    const opaqueSurfaceId = "run-scoped-opaque-surface-token";
    const events: RemoteEvent[] = [
      {
        runId: "timeline-run",
        sequence: 1,
        type: "run.surface_transition",
        data: { reason: "peer_switch", fromKind: "desktop", toKind: "native_window", generation: 1, surfaceId: opaqueSurfaceId },
      },
      {
        runId: "timeline-run",
        sequence: 2,
        type: "run.surface_transition",
        data: { reason: "child_push", fromKind: "native_window", toKind: "overlay", generation: 1, surfaceId: opaqueSurfaceId },
      },
      {
        runId: "timeline-run",
        sequence: 3,
        type: "run.surface_transition",
        data: { reason: "child_pop", fromKind: "overlay", toKind: "native_window", generation: 2, surfaceId: opaqueSurfaceId },
      },
    ];

    render(<EventTimeline events={events} />);

    expect(screen.getByText("电脑切换了操作窗口")).toBeTruthy();
    expect(screen.getByText("电脑打开了弹窗或子界面")).toBeTruthy();
    expect(screen.getByText("电脑返回到父界面")).toBeTruthy();
    expect(document.body.textContent).not.toContain(opaqueSurfaceId);
  });
});
