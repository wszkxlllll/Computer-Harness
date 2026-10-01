// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EventTimeline } from "./EventTimeline";

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
