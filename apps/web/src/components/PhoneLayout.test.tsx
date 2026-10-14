// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PhoneLayout } from "./PhoneLayout";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("phone navigation landmarks", () => {
  it("names the main navigation and exposes one current destination", () => {
    render(<PhoneLayout active="settings"><main id="main-content" tabIndex={-1}><h1>设置</h1></main></PhoneLayout>);

    const navigation = screen.getByRole("navigation", { name: "手机主导航" });
    const links = within(navigation).getAllByRole("link");
    expect(links).toHaveLength(3);
    expect(within(navigation).getByRole("link", { name: "设置" }).getAttribute("aria-current")).toBe("page");
    expect(links.filter((link) => link.getAttribute("aria-current") !== null)).toHaveLength(1);
  });

  it("keeps skip navigation and page destinations keyboard-focusable", () => {
    render(<PhoneLayout active="tasks"><main id="main-content" tabIndex={-1}><h1>任务</h1></main></PhoneLayout>);

    const skipLink = screen.getByRole("link", { name: "跳到主要内容" }) as HTMLAnchorElement;
    expect(skipLink.getAttribute("href")).toBe("#main-content");
    skipLink.focus();
    expect(document.activeElement).toBe(skipLink);

    const taskLink = screen.getByRole("link", { name: "任务" }) as HTMLAnchorElement;
    expect(taskLink.tabIndex).toBe(0);
    taskLink.focus();
    expect(document.activeElement).toBe(taskLink);
  });
});
