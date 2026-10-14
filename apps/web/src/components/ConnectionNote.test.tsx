// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectionNote } from "./ConnectionNote";

afterEach(() => cleanup());

describe("connection note announcements", () => {
  it("remains a status message by default for standalone uses", () => {
    render(<ConnectionNote connection="offline" />);
    expect(screen.getByRole("status").textContent).toBe("电脑暂时无法连接");
  });

  it("can leave the shared Run live region as the only connection announcer", () => {
    render(<ConnectionNote connection="live" announce={false} />);
    expect(screen.getByText("电脑状态已连接")).toBeDefined();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
