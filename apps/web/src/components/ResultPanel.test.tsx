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

    fireEvent.click(expandButton);
    expect(screen.getByRole("button", { name: "收起结果" }).getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector(".result-copy")?.classList.contains("result-copy-expanded")).toBe(true);
  });
});
