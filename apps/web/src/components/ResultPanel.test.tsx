// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ResultPanel } from "./ResultPanel";

const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");

afterEach(() => {
  cleanup();
  if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, "scrollHeight", originalScrollHeight);
  if (originalClientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", originalClientHeight);
});

describe("run result panel", () => {
  it.each([
    ["succeeded", "已完成", "任务已完成，但电脑没有返回文字结果。"],
    ["failed", "未完成", "任务没有完成。"],
    ["cancelled", "已停止", "任务已停止。"],
    ["budget_exhausted", "已达到本次限制", "任务未完成：已达到本次任务限制。"],
    ["outcome_unknown", "结果待确认", "还不能确认任务是否完成。"],
    ["new_outcome_from_future", "结果待核实", "还不能确认任务是否完成。"],
    ["future_outcome", "结果待核实", "还不能确认任务是否完成。"],
  ])("explains a %s outcome even when no reply was returned", (outcome, label, fallback) => {
    const { rerender } = render(<ResultPanel outcome={outcome} />);
    expect(screen.getByRole("heading", { name: "任务结果" })).toBeDefined();
    expect(screen.getByText(label)).toBeDefined();
    expect(screen.getByText(fallback)).toBeDefined();
    expect(screen.queryByText("电脑返回的内容")).toBeNull();

    rerender(<ResultPanel outcome={outcome} error="本次操作未能完成。" />);
    const reason = document.querySelector(".result-error-details") as HTMLDetailsElement;
    expect(reason.open).toBe(false);
    expect(reason.textContent).toContain("本次操作未能完成。");
    expect(screen.getByText(fallback)).toBeDefined();
    rerender(<ResultPanel />);
    expect(screen.queryByRole("region", { name: "任务结果" })).toBeNull();
  });

  it("shows an error detail for a whitespace-only reply", () => {
    render(<ResultPanel reply="   " outcome="failed" error="保存结果没有得到确认。" />);
    expect(document.querySelector(".result-copy")).toBeNull();
    expect(screen.getByText("任务没有完成。")).toBeTruthy();
    expect(document.querySelector(".result-error-details")?.textContent).toContain("保存结果没有得到确认。");
  });

  it("offers the full reply only when the collapsed panel actually clips it", () => {
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.classList.contains("result-copy") && (this.textContent?.length ?? 0) > 120 ? 500 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() { return this.classList.contains("result-copy") ? 255 : 0; },
    });

    const { rerender } = render(<ResultPanel reply="A short result." outcome="succeeded" />);
    expect(screen.queryByRole("button", { name: "查看完整结果" })).toBeNull();

    const longReply = "A useful result with details. ".repeat(12);
    rerender(<ResultPanel reply={longReply} outcome="succeeded" />);
    const expandButton = screen.getByRole("button", { name: "查看完整结果" });
    expect(expandButton.getAttribute("aria-expanded")).toBe("false");
    expect(expandButton.getAttribute("aria-controls")).toBe("run-result-copy");
    expect(document.getElementById(expandButton.getAttribute("aria-controls")!)?.textContent).toContain(longReply);

    fireEvent.click(expandButton);
    expect(screen.getByRole("button", { name: "收起结果" }).getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector(".result-copy")?.classList.contains("result-copy-expanded")).toBe(true);
  });
});
