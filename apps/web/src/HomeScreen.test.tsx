// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRun, listRuns, listWindowTargets } from "./api";
import { HomeScreen } from "./HomeScreen";
import { ApiError } from "./types";

vi.mock("./api", async (importOriginal) => {
  const api = await importOriginal<typeof import("./api")>();
  return { ...api, createRun: vi.fn(), listRuns: vi.fn(), listWindowTargets: vi.fn() };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("home window-target selection", () => {
  beforeEach(() => {
    vi.mocked(listRuns).mockResolvedValue([]);
    vi.mocked(listWindowTargets).mockResolvedValue({
      candidates: [
        { token: "opaque-a", appName: "Browser", title: "Contacts" },
        { token: "opaque-b", appName: "Mail", title: "Inbox" },
      ],
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
  });

  it("requires a deliberate target selection and starts only that target", async () => {
    vi.mocked(createRun).mockRejectedValue(new ApiError("temporary failure", 503));
    render(<HomeScreen />);

    expect(screen.getByRole("heading", { name: "新任务" })).toBeDefined();
    expect(screen.queryByText(/电脑来完成/)).toBeNull();
    const goal = await screen.findByLabelText("想让电脑做什么？");
    const startButton = screen.getByRole("button", { name: "开始任务" });
    fireEvent.change(goal, { target: { value: "Compare the contacts" } });
    await screen.findByRole("radio", { name: /Browser.*Contacts/ });
    expect(startButton.hasAttribute("disabled")).toBe(true);
    expect(screen.queryByText("opaque-a")).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: /Browser.*Contacts/ }));
    expect(startButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(startButton);

    await waitFor(() => expect(createRun).toHaveBeenCalledWith("Compare the contacts", expect.any(String), "opaque-a"));
  });

  it("tracks the selected task tab when navigating to the recent-tasks anchor", () => {
    render(<HomeScreen />);
    const navigation = within(screen.getByRole("navigation", { name: "手机主导航" }));
    const newTask = navigation.getByRole("link", { name: "新任务" });
    const tasks = navigation.getByRole("link", { name: "任务" });
    const settings = navigation.getByRole("link", { name: "设置" });
    expect(newTask.getAttribute("aria-current")).toBe("page");
    expect(tasks.getAttribute("href")).toBe("/#recent-tasks");
    expect(settings.getAttribute("href")).toBe("/preferences");

    window.history.replaceState(null, "", "/#recent-tasks");
    fireEvent(window, new Event("hashchange"));
    expect(tasks.getAttribute("aria-current")).toBe("page");
    expect(newTask.getAttribute("aria-current")).toBeNull();
  });

  it("preserves the goal draft and requires re-selection after a stale-window error", async () => {
    vi.mocked(listWindowTargets)
      .mockResolvedValueOnce({
        candidates: [{ token: "expired-token", appName: "Browser", title: "Contacts" }],
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      })
      .mockResolvedValueOnce({
        candidates: [{ token: "fresh-token", appName: "Browser", title: "Contacts" }],
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      });
    vi.mocked(createRun).mockRejectedValue(new ApiError(
      "所选窗口已过期或发生变化。请刷新可用窗口并重新选择后再开始。",
      409,
      "WINDOW_TARGET_STALE",
    ));
    render(<HomeScreen />);

    const goal = await screen.findByLabelText("想让电脑做什么？");
    fireEvent.change(goal, { target: { value: "Keep this draft while refreshing" } });
    fireEvent.click(await screen.findByRole("radio", { name: /Browser.*Contacts/ }));
    fireEvent.click(screen.getByRole("button", { name: "开始任务" }));

    await screen.findByText("所选窗口已过期或发生变化。请刷新可用窗口并重新选择后再开始。");
    expect((goal as HTMLTextAreaElement).value).toBe("Keep this draft while refreshing");
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.getByRole("button", { name: "开始任务" }).hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "刷新窗口列表" }));
    await screen.findByRole("radio", { name: /Browser.*Contacts/ });
    expect((goal as HTMLTextAreaElement).value).toBe("Keep this draft while refreshing");
    expect(screen.getByRole("button", { name: "开始任务" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByText("fresh-token")).toBeNull();
  });
});
