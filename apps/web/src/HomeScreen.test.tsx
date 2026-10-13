// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRun, listRuns, listWindowTargets, previewWindowTarget } from "./api";
import { HomeScreen } from "./HomeScreen";
import { GoalComposer } from "./components/GoalComposer";
import { ApiError, type BrowserSiteChoice, type WindowCandidatePreview, type WindowTargetList } from "./types";
import { PreferencesProvider } from "./PreferencesContext";
import { PREFERENCES_STORAGE_KEY } from "./preferences";

vi.mock("./api", async (importOriginal) => {
  const api = await importOriginal<typeof import("./api")>();
  return { ...api, createRun: vi.fn(), listRuns: vi.fn(), listWindowTargets: vi.fn(), previewWindowTarget: vi.fn() };
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

function renderHome(commonSiteChoices?: readonly BrowserSiteChoice[]) {
  return render(<PreferencesProvider><HomeScreen commonSiteChoices={commonSiteChoices} /></PreferencesProvider>);
}

function openStartSelection() {
  const disclosure = document.querySelector(".target-mode-disclosure") as HTMLDetailsElement | null;
  if (disclosure !== null && !disclosure.open) fireEvent.click(disclosure.querySelector("summary")!);
}

function chooseStartMode(name: RegExp) {
  openStartSelection();
  fireEvent.click(screen.getByRole("radio", { name }));
}

const defaultAssistantPreferences = {
  version: 1 as const,
  responseDetail: "standard" as const,
  stepExplanation: "standard" as const,
  preferredLanguage: "follow_conversation" as const,
  additionalGuidance: "",
};

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
    renderHome();

    expect(screen.getByRole("heading", { name: "新任务" })).toBeDefined();
    expect(screen.queryByText(/电脑来完成/)).toBeNull();
    const goal = await screen.findByLabelText("想让电脑做什么？");
    const startButton = screen.getByRole("button", { name: "开始任务" });
    fireEvent.change(goal, { target: { value: "Find a window automatically" } });
    chooseStartMode(/自动选择/);
    await screen.findByText("这里还没有任务");
    expect(screen.getByText(/选择起点 · 自动选择/)).toBeDefined();
    openStartSelection();
    expect((screen.getByRole("radio", { name: /自动选择/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole("radio", { name: /Browser.*Contacts/ })).toBeNull();
    expect(startButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(startButton);

    await waitFor(() => expect(createRun).toHaveBeenCalledWith("Find a window automatically", expect.any(String), { mode: "auto" }, defaultAssistantPreferences, false));
    expect(listWindowTargets).not.toHaveBeenCalled();
  });

  it("keeps the document loaded when it opens the newly created Run", async () => {
    vi.mocked(createRun).mockResolvedValue({ runId: "run-created", status: "created" });
    renderHome();

    fireEvent.change(await screen.findByLabelText("想让电脑做什么？"), { target: { value: "Check a task" } });
    await screen.findByText("这里还没有任务");
    fireEvent.click(screen.getByRole("button", { name: "开始任务" }));

    await waitFor(() => expect(window.location.pathname).toBe("/run/run-created"));
  });

  it("focuses a failed submission message and associates it with the submit control", async () => {
    vi.mocked(createRun).mockRejectedValue(new ApiError("电脑暂时不可用", 503, "HOST_ERROR"));
    renderHome();

    const goal = await screen.findByLabelText("想让电脑做什么？");
    fireEvent.change(goal, { target: { value: "Read this notice" } });
    await screen.findByText("这里还没有任务");
    expect(screen.getByRole("form", { name: "新任务表单" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "开始任务" }));

    const error = await screen.findByRole("alert");
    await waitFor(() => expect(document.activeElement).toBe(error));
    expect(screen.getByRole("button", { name: "开始任务" }).getAttribute("aria-describedby")).toBe("goal-error");
    expect(goal.getAttribute("aria-describedby")).toBe("goal-help");
  });

  it("submits an explicit entire-desktop target without window discovery", async () => {
    vi.mocked(createRun).mockRejectedValue(new ApiError("temporary failure", 503));
    renderHome();

    const goal = await screen.findByLabelText("想让电脑做什么？");
    fireEvent.change(goal, { target: { value: "Inspect a transient desktop popup" } });
    chooseStartMode(/整个桌面/);
    await screen.findByText("这里还没有任务");
    fireEvent.click(screen.getByRole("button", { name: "开始任务" }));

    await waitFor(() => expect(createRun).toHaveBeenCalledWith(
      "Inspect a transient desktop popup",
      expect.any(String),
      { mode: "desktop" },
      defaultAssistantPreferences,
      false,
    ));
    expect(listWindowTargets).not.toHaveBeenCalled();
  });

  it("keeps Host-prepared recovery experiments out of the phone target choices", async () => {
    renderHome();
    await screen.findByLabelText("想让电脑做什么？");
    openStartSelection();
    expect(screen.getAllByRole("radio").map((radio) => (radio as HTMLInputElement).value))
      .toEqual(["auto", "window", "browser", "desktop"]);
    expect(listWindowTargets).not.toHaveBeenCalled();
  });


  it.each([
    ["auto", /自动选择/, { mode: "auto" }],
    ["window", /手动选择窗口/, { mode: "window", targetToken: "opaque-a" }],
    ["browser", /打开网站/, { mode: "browser" }],
    ["desktop", /整个桌面（高级）/, { mode: "desktop" }],
  ] as const)("offers the same accessible cross-app switch for %s and submits it with that target", async (_name, modeLabel, expectedTarget) => {
    vi.mocked(createRun).mockRejectedValue(new ApiError("temporary failure", 503));
    renderHome();

    const goal = await screen.findByLabelText("想让电脑做什么？");
    fireEvent.change(goal, { target: { value: `Run in ${_name} mode` } });
    const switchInput = screen.getByRole("switch", { name: /允许切换其他应用/ }) as HTMLInputElement;
    expect(switchInput.checked).toBe(false);
    expect(switchInput.getAttribute("aria-describedby")).toBe("cross-window-run-switch-help");
    expect(screen.getByText(/窗口名称、标题和相关网页内容可能随本次任务发送给所选服务/)).toBeDefined();
    fireEvent.click(switchInput);

    chooseStartMode(modeLabel);
    if (_name === "window") fireEvent.click(await screen.findByRole("radio", { name: /Browser.*Contacts/ }));

    await screen.findByText("这里还没有任务");
    if (_name === "browser") {
      expect(screen.queryByRole("radio", { name: /本机已准备|临时空白/ })).toBeNull();
      expect(screen.getByText(/电脑会打开网站，并按页面上的内容完成任务/)).toBeDefined();
      expect(screen.getByText(/是否沿用登录状态，按电脑上的浏览器设置决定/)).toBeDefined();
    }
    fireEvent.click(screen.getByRole("button", { name: "开始任务" }));

    await waitFor(() => expect(createRun).toHaveBeenCalledWith(
      `Run in ${_name} mode`,
      expect.any(String),
      { ...expectedTarget, switchWindows: true },
      defaultAssistantPreferences,
      false,
    ));
  });

  it("freezes only assistant preferences into the new Run request", async () => {
    localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify({
      version: 3,
      presentation: { layoutMode: "simple", textSize: "large", highContrast: true, reduceMotion: true },
      assistant: {
        responseDetail: "detailed",
        stepExplanation: "more",
        preferredLanguage: "en",
        additionalGuidance: "Group findings by topic.",
      },
      voice: { runNoticesEnabled: true, speechRate: "fast" },
    }));
    vi.mocked(createRun).mockRejectedValue(new ApiError("temporary failure", 503));
    renderHome();

    fireEvent.change(await screen.findByLabelText("想让电脑做什么？"), { target: { value: "Summarize this page" } });
    await screen.findByText("这里还没有任务");
    fireEvent.click(screen.getByRole("button", { name: "开始任务" }));

    await waitFor(() => expect(createRun).toHaveBeenCalledWith("Summarize this page", expect.any(String), { mode: "browser" }, {
      version: 1,
      responseDetail: "detailed",
      stepExplanation: "more",
      preferredLanguage: "en",
      additionalGuidance: "Group findings by topic.",
    }, true));
  });

  it("rotates IDs after discovery failure and 409, but retains them after generic server errors", async () => {
    vi.mocked(createRun)
      .mockRejectedValueOnce(new ApiError("电脑暂时无法安全读取可用窗口。你可以改为手动选择窗口，或稍后重试。", 503, "WINDOW_DISCOVERY_FAILED"))
      .mockRejectedValueOnce(new ApiError("temporary host error", 503, "HOST_ERROR"))
      .mockRejectedValueOnce(new ApiError("temporary host error", 503, "HOST_ERROR"))
      .mockRejectedValueOnce(new ApiError("电脑暂时无法开始新任务：现有任务尚未结束，或资源收尾尚未确认。请刷新任务列表后再试。", 409, "RUN_BUSY"))
      .mockRejectedValueOnce(new ApiError("temporary host error", 503, "HOST_ERROR"));
    renderHome();

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
    renderHome();
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
    renderHome();

    const goal = await screen.findByLabelText("想让电脑做什么？");
    fireEvent.change(goal, { target: { value: "Keep this draft while refreshing" } });
    chooseStartMode(/手动选择窗口/);
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
    renderHome();

    const goal = await screen.findByLabelText("想让电脑做什么？");
    fireEvent.change(goal, { target: { value: "Open this website" } });
    chooseStartMode(/打开网站/);
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
      url: "https://example.com/reports?q=1",
    }, defaultAssistantPreferences, false));
    expect(listWindowTargets).not.toHaveBeenCalled();
  });

  it("starts browser mode with no URL property when the optional field is blank", async () => {
    vi.mocked(createRun).mockRejectedValue(new ApiError("temporary failure", 503));
    renderHome();

    const goal = await screen.findByLabelText("想让电脑做什么？");
    fireEvent.change(goal, { target: { value: "Find the relevant website from the task" } });
    chooseStartMode(/打开网站/);
    expect(screen.getByLabelText("起始网址（可选）").getAttribute("required")).toBeNull();
    await screen.findByText("这里还没有任务");
    const startButton = screen.getByRole("button", { name: "开始任务" });
    expect(startButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(startButton);

    await waitFor(() => expect(createRun).toHaveBeenCalledWith("Find the relevant website from the task", expect.any(String), { mode: "browser" }, defaultAssistantPreferences, false));
    expect(listWindowTargets).not.toHaveBeenCalled();
  });

  it("hides the common-site selector when no choices are injected", async () => {
    renderHome();

    await screen.findByText("这里还没有任务");
    chooseStartMode(/打开网站/);

    expect(screen.queryByLabelText("常用网站（可选）")).toBeNull();
    expect(screen.getByLabelText("起始网址（可选）")).toBeDefined();
  });

  it("omits invalid and credential-bearing common-site URLs", async () => {
    renderHome([
      { label: "Unsupported scheme", url: "javascript:alert(1)" },
      { label: "Credential URL", url: "https://user:secret@example.com" },
    ]);

    await screen.findByText("这里还没有任务");
    chooseStartMode(/打开网站/);

    expect(screen.queryByLabelText("常用网站（可选）")).toBeNull();
    expect(screen.getByLabelText("起始网址（可选）")).toBeDefined();
  });

  it("uses an injected common-site choice without sending browser profile preference", async () => {
    vi.mocked(createRun).mockRejectedValue(new ApiError("temporary failure", 503));
    renderHome([{ label: "测试门户", url: "https://portal.example/reports" }]);

    const goal = await screen.findByLabelText("想让电脑做什么？");
    fireEvent.change(goal, { target: { value: "Open the portal" } });
    chooseStartMode(/打开网站/);
    await screen.findByText("这里还没有任务");

    const commonSite = screen.getByLabelText("常用网站（可选）");
    fireEvent.change(commonSite, { target: { value: "https://portal.example/reports" } });
    expect((screen.getByLabelText("起始网址（可选）") as HTMLInputElement).value).toBe("https://portal.example/reports");
    expect(createRun).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "开始任务" }));
    await waitFor(() => expect(createRun).toHaveBeenCalledWith("Open the portal", expect.any(String), {
      mode: "browser",
      url: "https://portal.example/reports",
    }, defaultAssistantPreferences, false));
    expect(listWindowTargets).not.toHaveBeenCalled();
  });

  it("allows editing a selected browser URL while profile selection stays in Settings", async () => {
    vi.mocked(createRun).mockRejectedValue(new ApiError("temporary failure", 503));
    renderHome([{ label: "Known site", url: "https://known.example/" }]);

    fireEvent.change(await screen.findByLabelText("想让电脑做什么？"), { target: { value: "Open a different page" } });
    chooseStartMode(/打开网站/);
    await screen.findByText("这里还没有任务");
    fireEvent.change(screen.getByLabelText("常用网站（可选）"), { target: { value: "https://known.example/" } });

    const url = screen.getByLabelText("起始网址（可选）") as HTMLInputElement;
    expect(url.value).toBe("https://known.example/");
    fireEvent.change(url, { target: { value: "https://manual.example/page" } });
    expect(url.value).toBe("https://manual.example/page");
    expect((screen.getByLabelText("常用网站（可选）") as HTMLSelectElement).value).toBe("");
    expect(createRun).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "开始任务" }));
    await waitFor(() => expect(createRun).toHaveBeenCalledWith("Open a different page", expect.any(String), {
      mode: "browser",
      url: "https://manual.example/page",
    }, defaultAssistantPreferences, false));
  });

  it("disables the injected selector while the composer is active or busy", () => {
    const commonSiteChoices = [{ label: "Known site", url: "https://known.example/" }];
    const targetPicker = { candidates: [], loading: false, onSelect: vi.fn(), onRefresh: vi.fn() };

    for (const state of [{ disabled: true }, { busy: true }]) {
      const view = render(
        <GoalComposer
          {...state}
          canStart={false}
          targetMode="browser"
          browserUrl=""
          commonSiteChoices={commonSiteChoices}
          onTargetModeChange={vi.fn()}
          onBrowserUrlChange={vi.fn()}
          targetPicker={targetPicker}
          onSubmit={vi.fn(async () => undefined)}
        />,
      );

      expect((screen.getByLabelText("常用网站（可选）") as HTMLSelectElement).disabled).toBe(true);
      expect((screen.getByLabelText("起始网址（可选）") as HTMLInputElement).disabled).toBe(true);
      view.unmount();
    }
  });

  it("links to browser settings when the Host requires saved-profile setup", async () => {
    vi.mocked(createRun).mockRejectedValue(new ApiError("需要先准备受管浏览器", 409, "MANAGED_BROWSER_SETUP_REQUIRED"));
    renderHome();

    const goal = await screen.findByLabelText("想让电脑做什么？");
    fireEvent.change(goal, { target: { value: "Use the saved travel site" } });
    chooseStartMode(/打开网站/);
    fireEvent.change(screen.getByLabelText("起始网址（可选）"), { target: { value: "https://travel.example/search" } });
    fireEvent.click(screen.getByRole("button", { name: "开始任务" }));

    await screen.findByRole("link", { name: "打开浏览器与登录状态设置" });
    expect(createRun).toHaveBeenCalledWith("Use the saved travel site", expect.any(String), {
      mode: "browser",
      url: "https://travel.example/search",
    }, defaultAssistantPreferences, false);
  });

  it("preserves the goal and opens a refreshed manual picker after ambiguous automatic matching", async () => {
    vi.mocked(listWindowTargets).mockResolvedValue({
      candidates: [{ token: "candidate-a", appName: "Browser", title: "Contacts" }],
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      omittedAmbiguousCount: 2,
    });
    vi.mocked(createRun).mockRejectedValue(new ApiError(
      "电脑无法唯一确定要操作的窗口。请从刷新后的列表中手动选择一个窗口。",
      409,
      "WINDOW_SELECTION_REQUIRED",
    ));
    renderHome();

    const goal = await screen.findByLabelText("想让电脑做什么？");
    fireEvent.change(goal, { target: { value: "Keep this goal after choosing a window" } });
    chooseStartMode(/自动选择/);
    await screen.findByText("这里还没有任务");
    fireEvent.click(screen.getByRole("button", { name: "开始任务" }));

    expect(await screen.findByRole("radio", { name: /Browser.*Contacts/ })).toBeDefined();
    expect(screen.getByText(/有 2 个候选未显示/u)).toBeDefined();
    expect((goal as HTMLTextAreaElement).value).toBe("Keep this goal after choosing a window");
    openStartSelection();
    expect((screen.getByRole("radio", { name: /手动选择窗口/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("无法唯一确定");
    expect(screen.getByRole("button", { name: "开始任务" }).hasAttribute("disabled")).toBe(true);
    expect(createRun).toHaveBeenCalledWith("Keep this goal after choosing a window", expect.any(String), { mode: "auto" }, defaultAssistantPreferences, false);
    expect(listWindowTargets).toHaveBeenCalledTimes(1);
  });

  it("requires a fresh manual window confirmation when the goal changes and warns when the chosen app differs", async () => {
    vi.mocked(listWindowTargets).mockResolvedValue({
      candidates: [
        { token: "notepad-token", appName: "Notepad", title: "Notes" },
        { token: "wps-token", appName: "WPS Office", title: "Report.docx" },
      ],
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    vi.mocked(createRun).mockResolvedValue({ runId: "manual-run", status: "running" });
    renderHome();

    const goal = await screen.findByLabelText("想让电脑做什么？");
    fireEvent.change(goal, { target: { value: "Open the previous task" } });
    await screen.findByText("这里还没有任务");
    chooseStartMode(/手动选择窗口/);
    fireEvent.click(await screen.findByRole("radio", { name: /Notepad.*Notes/ }));

    fireEvent.change(goal, { target: { value: "请在WPS里写入新内容" } });
    expect(screen.getByText("任务目标已更改，请重新点选窗口以确认新的起始目标。" )).toBeDefined();
    expect((screen.getByRole("button", { name: "开始任务" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("radio", { name: /Notepad.*Notes/ }));
    expect(screen.getByText(/任务开头提到了 wps，但当前手选窗口是 Notepad/u)).toBeDefined();
    expect((screen.getByRole("button", { name: "开始任务" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "开始任务" }));

    await waitFor(() => expect(createRun).toHaveBeenCalledWith(
      "请在WPS里写入新内容",
      expect.any(String),
      { mode: "window", targetToken: "notepad-token" },
      defaultAssistantPreferences,
      false,
    ));
  });

  it("requires viewing and explicitly confirming an exact live preview for repeated window labels", async () => {
    vi.mocked(listWindowTargets).mockResolvedValue({
      candidates: [
        { token: "duplicate-a", appName: "Notepad.exe", title: "Untitled - Notepad", previewRequired: true },
        { token: "duplicate-b", appName: "Notepad.exe", title: "Untitled - Notepad", previewRequired: true },
      ],
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    const preview: WindowCandidatePreview = {
      previewToken: "P".repeat(32),
      appName: "Notepad.exe",
      title: "Untitled - Notepad",
      capturedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      viewport: { width: 320, height: 240 },
      mediaType: "image/png",
      dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    };
    const failedSecondPreview: WindowCandidatePreview = { ...preview, previewToken: "Q".repeat(32), dataBase64: "bm90LWEtcG5n" };
    const secondPreview: WindowCandidatePreview = { ...preview, previewToken: "R".repeat(32) };
    let resolveSecondPreviewRetry!: (value: WindowCandidatePreview) => void;
    const pendingSecondPreviewRetry = new Promise<WindowCandidatePreview>((resolve) => { resolveSecondPreviewRetry = resolve; });
    vi.mocked(previewWindowTarget)
      .mockResolvedValueOnce(preview)
      .mockResolvedValueOnce(failedSecondPreview)
      .mockReturnValueOnce(pendingSecondPreviewRetry);
    vi.mocked(createRun).mockResolvedValue({ runId: "previewed-run", status: "running" });
    renderHome();

    const goal = await screen.findByLabelText("想让电脑做什么？");
    fireEvent.change(goal, { target: { value: "在 Notepad 中查看当前窗口" } });
    await screen.findByText("这里还没有任务");
    chooseStartMode(/手动选择窗口/);
    expect(await screen.findByRole("group", { name: "候选列表第 1 项（当前顺序，不代表窗口身份）；应用：Notepad.exe；窗口标题：Untitled - Notepad" })).toBeDefined();
    expect(screen.getByRole("group", { name: "候选列表第 2 项（当前顺序，不代表窗口身份）；应用：Notepad.exe；窗口标题：Untitled - Notepad" })).toBeDefined();
    expect(document.getElementById("window-target-visual-limit")?.textContent).toContain("读屏无法读取截图，也无法由截图文字验证窗口身份");
    const previewButtons = await screen.findAllByRole("button", { name: /查看此窗口预览，候选列表第/u });
    const previewButton = previewButtons[0];
    if (previewButton === undefined) throw new Error("expected a candidate preview action");
    expect(previewButton.getAttribute("aria-describedby")).toBe("window-target-visual-limit");
    expect((screen.getByRole("button", { name: "开始任务" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(previewButton);
    const firstImage = await screen.findByRole("img", { name: /列表第 1 项.*Notepad\.exe.*Untitled - Notepad/u });
    expect(createRun).not.toHaveBeenCalled();

    fireEvent.load(firstImage);
    const firstConfirmation = await screen.findByRole("button", { name: /确认这是目标窗口，候选列表第 1 项/u });
    fireEvent.click(firstConfirmation);
    expect((screen.getByRole("button", { name: "开始任务" }) as HTMLButtonElement).disabled).toBe(false);

    const secondPreviewButton = screen.getByRole("button", { name: /查看此窗口预览，候选列表第 2 项/u });
    fireEvent.click(secondPreviewButton);
    expect((screen.getByRole("button", { name: "开始任务" }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(screen.getAllByRole("img", { name: /列表第 .* 项.*Notepad\.exe.*Untitled - Notepad/u })).toHaveLength(2));
    const images = screen.getAllByRole("img", { name: /列表第 .* 项.*Notepad\.exe.*Untitled - Notepad/u });
    const secondImage = images[1];
    if (secondImage === undefined) throw new Error("expected the second candidate screenshot");
    fireEvent.error(secondImage);
    expect(await screen.findByText("这张实时截图无法显示。请在电脑恢复目标窗口后刷新；仍看不清时不要选择。")).toBeDefined();
    expect(screen.getAllByRole("button", { name: /确认这是目标窗口，候选列表第/u })).toHaveLength(1);
    expect((screen.getByRole("button", { name: "开始任务" }) as HTMLButtonElement).disabled).toBe(true);
    expect(createRun).not.toHaveBeenCalled();

    const retryButtons = screen.getAllByRole("button", { name: /重新读取预览，候选列表第/u });
    const secondCandidateRetry = retryButtons[1];
    if (secondCandidateRetry === undefined) throw new Error("expected a retry action for the failed second candidate");
    fireEvent.click(secondCandidateRetry);
    await waitFor(() => expect(screen.getAllByRole("img", { name: /列表第 .* 项.*Notepad\.exe.*Untitled - Notepad/u })).toHaveLength(1));
    expect((screen.getByRole("button", { name: "开始任务" }) as HTMLButtonElement).disabled).toBe(true);
    resolveSecondPreviewRetry(secondPreview);
    await waitFor(() => expect(screen.getAllByRole("img", { name: /列表第 .* 项.*Notepad\.exe.*Untitled - Notepad/u })).toHaveLength(2));
    const retriedImages = screen.getAllByRole("img", { name: /列表第 .* 项.*Notepad\.exe.*Untitled - Notepad/u });
    const retriedSecondImage = retriedImages[1];
    if (retriedSecondImage === undefined) throw new Error("expected the retried second candidate screenshot");
    fireEvent.load(retriedSecondImage);
    const confirmations = await screen.findAllByRole("button", { name: /确认这是目标窗口，候选列表第/u });
    expect(confirmations).toHaveLength(2);
    expect((screen.getByRole("button", { name: "开始任务" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(confirmations[1]!);
    expect((screen.getByRole("button", { name: "开始任务" }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "开始任务" }));
    await waitFor(() => expect(createRun).toHaveBeenCalledWith(
      "在 Notepad 中查看当前窗口",
      expect.any(String),
      { mode: "window", targetToken: "duplicate-b", previewToken: secondPreview.previewToken },
      defaultAssistantPreferences,
      false,
    ));
    expect(vi.mocked(previewWindowTarget).mock.calls.map(([candidateToken]) => candidateToken)).toEqual([
      "duplicate-a",
      "duplicate-b",
      "duplicate-b",
    ]);
  });

  it("offers an optional preview for a unique window without changing direct selection", async () => {
    vi.mocked(listWindowTargets).mockResolvedValue({
      candidates: [{ token: "unique-window", appName: "Notepad.exe", title: "Notes" }],
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    const preview: WindowCandidatePreview = {
      previewToken: "P".repeat(32),
      appName: "Notepad.exe",
      title: "Notes",
      capturedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      viewport: { width: 320, height: 240 },
      mediaType: "image/png",
      dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    };
    vi.mocked(previewWindowTarget).mockResolvedValue(preview);
    vi.mocked(createRun).mockResolvedValue({ runId: "optional-preview-run", status: "running" });
    renderHome();

    const goal = await screen.findByLabelText("想让电脑做什么？");
    fireEvent.change(goal, { target: { value: "在 Notepad 中查看当前窗口" } });
    await screen.findByText("这里还没有任务");
    chooseStartMode(/手动选择窗口/);
    const targetRadio = await screen.findByRole("radio", { name: /Notepad\.exe.*Notes/u });
    targetRadio.focus();
    fireEvent.keyDown(targetRadio, { key: " ", code: "Space" });
    targetRadio.click();
    fireEvent.keyUp(targetRadio, { key: " ", code: "Space" });
    expect(document.activeElement).toBe(targetRadio);
    expect((targetRadio as HTMLInputElement).checked).toBe(true);

    const startButton = screen.getByRole("button", { name: "开始任务" }) as HTMLButtonElement;
    expect(startButton.disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /查看此窗口预览，候选列表第 1 项/u }));
    const image = await screen.findByRole("img", { name: /列表第 1 项.*Notepad\.exe.*Notes/u });
    expect(previewWindowTarget).toHaveBeenCalledWith("unique-window", expect.any(AbortSignal));
    expect(startButton.disabled).toBe(false);
    expect(createRun).not.toHaveBeenCalled();

    fireEvent.load(image);
    expect(await screen.findByText("可选预览已显示；此窗口仍可按标签直接选择。")).toBeDefined();
    fireEvent.click(startButton);
    await waitFor(() => expect(createRun).toHaveBeenCalledWith(
      "在 Notepad 中查看当前窗口",
      expect.any(String),
      { mode: "window", targetToken: "unique-window" },
      defaultAssistantPreferences,
      false,
    ));
  });

  it("blocks every target mode while an active Run exists", async () => {
    vi.mocked(listRuns).mockResolvedValue([{
      runId: "active-run",
      goal: "Existing work",
      status: "running",
    }]);
    renderHome();

    await screen.findByRole("heading", { name: "正在处理的任务" });
    expect(screen.getByRole("button", { name: "开始任务" }).hasAttribute("disabled")).toBe(true);
    openStartSelection();
    for (const name of [/自动选择/, /手动选择窗口/, /打开网站/, /整个桌面/]) {
      const modeInput = screen.getByRole("radio", { name }) as HTMLInputElement;
      expect((modeInput.closest("fieldset") as HTMLFieldSetElement).disabled).toBe(true);
    }
    expect(createRun).not.toHaveBeenCalled();
  });

  it("blocks new tasks while terminal cleanup is pending and reopens after refresh confirms release", async () => {
    vi.mocked(listRuns)
      .mockResolvedValueOnce([{ runId: "cleanup-run", goal: "Finished work", status: "finished", ownerState: "pending_cleanup" }])
      .mockResolvedValueOnce([{ runId: "cleanup-run", goal: "Finished work", status: "finished", ownerState: "released" }]);
    vi.mocked(createRun).mockResolvedValue({ runId: "after-cleanup", status: "created" });
    renderHome();

    const goal = await screen.findByLabelText("想让电脑做什么？");
    fireEvent.change(goal, { target: { value: "Start after cleanup" } });
    await screen.findByRole("heading", { name: "电脑收尾尚未确认" });
    const startButton = screen.getByRole("button", { name: "开始任务" }) as HTMLButtonElement;
    expect(startButton.disabled).toBe(true);
    expect(screen.getByText(/确认前不会发送新任务/)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "刷新列表" }));
    await waitFor(() => expect(startButton.disabled).toBe(false));
    expect(screen.queryByRole("heading", { name: "电脑收尾尚未确认" })).toBeNull();
    fireEvent.click(startButton);
    await waitFor(() => expect(createRun).toHaveBeenCalledWith(
      "Start after cleanup",
      expect.any(String),
      { mode: "browser" },
      defaultAssistantPreferences,
      false,
    ));
  });

  it("keeps legacy finished summaries without ownerState compatible", async () => {
    vi.mocked(listRuns).mockResolvedValue([{
      runId: "legacy-finished-run",
      goal: "Finished on an older Host",
      status: "finished",
    }]);
    vi.mocked(createRun).mockResolvedValue({ runId: "legacy-next", status: "created" });
    renderHome();

    fireEvent.change(await screen.findByLabelText("想让电脑做什么？"), { target: { value: "Continue using the older Host" } });
    await screen.findByText("Finished on an older Host");
    const startButton = screen.getByRole("button", { name: "开始任务" }) as HTMLButtonElement;
    expect(startButton.disabled).toBe(false);
    fireEvent.click(startButton);
    await waitFor(() => expect(createRun).toHaveBeenCalled());
  });
});
