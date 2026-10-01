// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRun, listRuns, listWindowTargets } from "./api";
import { HomeScreen } from "./HomeScreen";
import { ApiError, type WindowTargetList } from "./types";

vi.mock("./api", async (importOriginal) => {
  const api = await importOriginal<typeof import("./api")>();
  return { ...api, createRun: vi.fn(), listRuns: vi.fn(), listWindowTargets: vi.fn() };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("home run-target selection", () => {
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

  it("submits an explicitly selected automatic target without loading or selecting a window", async () => {
    vi.mocked(createRun).mockRejectedValue(new ApiError("temporary failure", 503));
    vi.mocked(listWindowTargets).mockReturnValue(new Promise<WindowTargetList>(() => undefined));
    render(<HomeScreen />);

    expect(screen.getByRole("heading", { name: "新任务" })).toBeDefined();
    expect(screen.queryByText(/电脑来完成/)).toBeNull();
    const goal = await screen.findByLabelText("想让电脑做什么？");
    const startButton = screen.getByRole("button", { name: "开始任务" });
    fireEvent.change(goal, { target: { value: "Find a window automatically" } });
    fireEvent.click(screen.getByRole("radio", { name: /自动选择/ }));
    await screen.findByText("这里还没有任务");
    expect((screen.getByRole("radio", { name: /自动选择/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole("radio", { name: /Browser.*Contacts/ })).toBeNull();
    expect(startButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(startButton);

    await waitFor(() => expect(createRun).toHaveBeenCalledWith("Find a window automatically", expect.any(String), { mode: "auto" }));
    expect(listWindowTargets).not.toHaveBeenCalled();
  });

  it("rotates IDs after discovery failure and 409, but retains them after generic server errors", async () => {
    vi.mocked(createRun)
      .mockRejectedValueOnce(new ApiError("电脑暂时无法安全读取可用窗口。你可以改为手动选择窗口，或稍后重试。", 503, "WINDOW_DISCOVERY_FAILED"))
      .mockRejectedValueOnce(new ApiError("temporary host error", 503, "HOST_ERROR"))
      .mockRejectedValueOnce(new ApiError("temporary host error", 503, "HOST_ERROR"))
      .mockRejectedValueOnce(new ApiError("电脑正在处理另一个任务。请等待当前任务结束后再开始。", 409, "RUN_BUSY"))
      .mockRejectedValueOnce(new ApiError("temporary host error", 503, "HOST_ERROR"));
    render(<HomeScreen />);

    const goal = await screen.findByLabelText("想让电脑做什么？");
    fireEvent.change(goal, { target: { value: "Retry automatic discovery" } });
    await screen.findByText("这里还没有任务");
    const startButton = screen.getByRole("button", { name: "开始任务" });

    fireEvent.click(startButton);
    await screen.findByText("电脑暂时无法安全读取可用窗口。你可以改为手动选择窗口，或稍后重试。");
    await waitFor(() => expect((startButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(startButton);
    await waitFor(() => expect(createRun).toHaveBeenCalledTimes(2));
    await waitFor(() => expect((startButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(startButton);
    await waitFor(() => expect(createRun).toHaveBeenCalledTimes(3));
    await waitFor(() => expect((startButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(startButton);
    await waitFor(() => expect(createRun).toHaveBeenCalledTimes(4));
    await waitFor(() => expect((startButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(startButton);
    await waitFor(() => expect(createRun).toHaveBeenCalledTimes(5));

    const commandIds = vi.mocked(createRun).mock.calls.map(([, commandId]) => commandId);
    expect(commandIds[1]).not.toBe(commandIds[0]);
    expect(commandIds[2]).toBe(commandIds[1]);
    expect(commandIds[3]).toBe(commandIds[2]);
    expect(commandIds[4]).not.toBe(commandIds[3]);
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

  it("preserves the goal draft and requires re-selection after a stale manual target", async () => {
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
    fireEvent.click(screen.getByRole("radio", { name: /手动选择窗口/ }));
    fireEvent.click(await screen.findByRole("radio", { name: /Browser.*Contacts/ }));
    fireEvent.click(screen.getByRole("button", { name: "开始任务" }));

    await screen.findByText("所选窗口已过期或发生变化。请刷新可用窗口并重新选择后再开始。");
    expect((goal as HTMLTextAreaElement).value).toBe("Keep this draft while refreshing");
    expect(screen.queryByRole("radio", { name: /Browser.*Contacts/ })).toBeNull();
    expect(screen.getByRole("button", { name: "开始任务" }).hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "刷新窗口列表" }));
    await screen.findByRole("radio", { name: /Browser.*Contacts/ });
    expect((goal as HTMLTextAreaElement).value).toBe("Keep this draft while refreshing");
    expect(screen.getByRole("button", { name: "开始任务" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByText("fresh-token")).toBeNull();
  });

  it("submits an explicit browser URL without requesting window inventory", async () => {
    vi.mocked(createRun).mockRejectedValue(new ApiError("temporary failure", 503));
    render(<HomeScreen />);

    const goal = await screen.findByLabelText("想让电脑做什么？");
    fireEvent.change(goal, { target: { value: "Open this website" } });
    fireEvent.click(screen.getByRole("radio", { name: /打开网站（推荐）/ }));
    const url = screen.getByLabelText("起始网址（可选）");
    const startButton = screen.getByRole("button", { name: "开始任务" });
    fireEvent.change(url, { target: { value: "ftp://example.com" } });
    expect(startButton.hasAttribute("disabled")).toBe(true);
    fireEvent.change(url, { target: { value: "https://example.com/reports?q=1" } });
    await screen.findByText("这里还没有任务");
    expect(startButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(startButton);

    await waitFor(() => expect(createRun).toHaveBeenCalledWith("Open this website", expect.any(String), {
      mode: "browser",
      sessionMode: "temporary",
      url: "https://example.com/reports?q=1",
    }));
    expect(listWindowTargets).not.toHaveBeenCalled();
  });

  it("starts browser mode with no URL property when the optional field is blank", async () => {
    vi.mocked(createRun).mockRejectedValue(new ApiError("temporary failure", 503));
    render(<HomeScreen />);

    const goal = await screen.findByLabelText("想让电脑做什么？");
    fireEvent.change(goal, { target: { value: "Find the relevant website from the task" } });
    fireEvent.click(screen.getByRole("radio", { name: /打开网站（推荐）/ }));
    expect(screen.getByLabelText("起始网址（可选）").getAttribute("required")).toBeNull();
    await screen.findByText("这里还没有任务");
    const startButton = screen.getByRole("button", { name: "开始任务" });
    expect(startButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(startButton);

    await waitFor(() => expect(createRun).toHaveBeenCalledWith("Find the relevant website from the task", expect.any(String), { mode: "browser", sessionMode: "temporary" }));
    expect(listWindowTargets).not.toHaveBeenCalled();
  });

  it("submits the explicit saved browser session mode without exposing profile details", async () => {
    vi.mocked(createRun).mockRejectedValue(new ApiError("temporary failure", 503));
    render(<HomeScreen />);

    const goal = await screen.findByLabelText("想让电脑做什么？");
    fireEvent.change(goal, { target: { value: "Use the saved travel site" } });
    fireEvent.click(screen.getByRole("radio", { name: /打开网站（推荐）/ }));
    fireEvent.click(screen.getByRole("radio", { name: /使用已登录网站/ }));
    fireEvent.change(screen.getByLabelText("起始网址（可选）"), { target: { value: "https://travel.example/search" } });
    fireEvent.click(screen.getByRole("button", { name: "开始任务" }));

    await waitFor(() => expect(createRun).toHaveBeenCalledWith("Use the saved travel site", expect.any(String), {
      mode: "browser",
      sessionMode: "saved",
      url: "https://travel.example/search",
    }));
  });

  it("preserves the goal and opens a refreshed manual picker after ambiguous automatic matching", async () => {
    vi.mocked(listWindowTargets).mockResolvedValue({
      candidates: [{ token: "candidate-a", appName: "Browser", title: "Contacts" }],
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    vi.mocked(createRun).mockRejectedValue(new ApiError(
      "电脑无法唯一确定要操作的窗口。请从刷新后的列表中手动选择一个窗口。",
      409,
      "WINDOW_SELECTION_REQUIRED",
    ));
    render(<HomeScreen />);

    const goal = await screen.findByLabelText("想让电脑做什么？");
    fireEvent.change(goal, { target: { value: "Keep this goal after choosing a window" } });
    fireEvent.click(screen.getByRole("radio", { name: /自动选择/ }));
    await screen.findByText("这里还没有任务");
    fireEvent.click(screen.getByRole("button", { name: "开始任务" }));

    expect(await screen.findByRole("radio", { name: /Browser.*Contacts/ })).toBeDefined();
    expect((goal as HTMLTextAreaElement).value).toBe("Keep this goal after choosing a window");
    expect((screen.getByRole("radio", { name: /手动选择窗口/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("无法唯一确定");
    expect(screen.getByRole("button", { name: "开始任务" }).hasAttribute("disabled")).toBe(true);
    expect(createRun).toHaveBeenCalledWith("Keep this goal after choosing a window", expect.any(String), { mode: "auto" });
    expect(listWindowTargets).toHaveBeenCalledTimes(1);
  });

  it("blocks every target mode while an active Run exists", async () => {
    vi.mocked(listRuns).mockResolvedValue([{
      runId: "active-run",
      goal: "Existing work",
      status: "running",
    }]);
    render(<HomeScreen />);

    await screen.findByRole("heading", { name: "正在处理的任务" });
    expect(screen.getByRole("button", { name: "开始任务" }).hasAttribute("disabled")).toBe(true);
    for (const name of [/自动选择/, /手动选择窗口/, /打开网站（推荐）/]) {
      const modeInput = screen.getByRole("radio", { name }) as HTMLInputElement;
      expect((modeInput.closest("fieldset") as HTMLFieldSetElement).disabled).toBe(true);
    }
    expect(createRun).not.toHaveBeenCalled();
  });
});
