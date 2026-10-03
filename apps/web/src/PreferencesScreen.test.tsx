// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreferencesScreen } from "./PreferencesScreen";
import { PreferencesProvider } from "./PreferencesContext";
import { PREFERENCES_STORAGE_KEY, DEFAULT_PREFERENCES, type UserPreferences } from "./preferences";
import type { VoiceCapabilities } from "./voice-capabilities";
import {
  completeManagedBrowserLogin,
  getManagedBrowserProfileSettings,
  prepareManagedBrowserLogin,
  reloginManagedBrowser,
  setManagedBrowserDefaultSession,
} from "./api";
import { ApiError, type ManagedBrowserProfileSettings } from "./types";

vi.mock("./api", async (importOriginal) => {
  const api = await importOriginal<typeof import("./api")>();
  return {
    ...api,
    completeManagedBrowserLogin: vi.fn(),
    getManagedBrowserProfileSettings: vi.fn(),
    prepareManagedBrowserLogin: vi.fn(),
    reloginManagedBrowser: vi.fn(),
    setManagedBrowserDefaultSession: vi.fn(),
  };
});

const readyBrowserProfile: ManagedBrowserProfileSettings = {
  status: "ready",
  defaultSession: "saved",
  commands: { prepare: "prepare", complete: "complete", relogin: "relogin" },
};

const preparingBrowserProfile: ManagedBrowserProfileSettings = {
  ...readyBrowserProfile,
  status: "preparing",
  operationId: "11111111-1111-4111-8111-111111111111",
};

const cleanupFailedBrowserProfile: ManagedBrowserProfileSettings = {
  ...readyBrowserProfile,
  status: "cleanup_failed",
};

const reloginRequiredBrowserProfile: ManagedBrowserProfileSettings = {
  ...readyBrowserProfile,
  status: "relogin_required",
};

const unpreparedBrowserProfile: ManagedBrowserProfileSettings = {
  ...readyBrowserProfile,
  status: "unprepared",
};

function renderPreferences() {
  return render(<PreferencesProvider><PreferencesScreen /></PreferencesProvider>);
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.removeAttribute("data-layout");
  document.documentElement.removeAttribute("data-text-size");
  document.documentElement.removeAttribute("data-contrast");
  document.documentElement.removeAttribute("data-reduce-motion");
});

describe("personal preferences screen", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    vi.mocked(getManagedBrowserProfileSettings).mockResolvedValue(readyBrowserProfile);
    vi.mocked(setManagedBrowserDefaultSession).mockImplementation(async (defaultSession) => ({ ...readyBrowserProfile, defaultSession }));
    vi.mocked(prepareManagedBrowserLogin).mockResolvedValue(preparingBrowserProfile);
    vi.mocked(completeManagedBrowserLogin).mockResolvedValue(readyBrowserProfile);
    vi.mocked(reloginManagedBrowser).mockResolvedValue(preparingBrowserProfile);
  });

  it("keeps assistant preferences separate from display preferences and stores them locally", async () => {
    renderPreferences();
    expect(screen.getByText(/这些回答偏好只保存在此浏览器/)).toBeDefined();
    const displayGroup = within(screen.getByRole("group", { name: "使用方式" }));
    const textSizeGroup = within(screen.getByRole("group", { name: "文字大小" }));
    fireEvent.click(displayGroup.getByRole("radio", { name: /大字简洁/ }));
    await waitFor(() => {
      expect(document.documentElement.dataset.textSize).toBe("large");
      expect(document.documentElement.dataset.layout).toBe("simple");
    });
    fireEvent.click(textSizeGroup.getByRole("radio", { name: "标准" }));
    await waitFor(() => expect(document.documentElement.dataset.textSize).toBe("standard"));
    expect(document.documentElement.dataset.layout).toBe("simple");
    expect((displayGroup.getByRole("radio", { name: /大字简洁/ }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(textSizeGroup.getByRole("radio", { name: "大字" }));
    fireEvent.click(screen.getByRole("switch", { name: /高对比度/ }));
    fireEvent.click(screen.getByRole("switch", { name: /减少动画/ }));
    fireEvent.click(screen.getByRole("radio", { name: "详细" }));
    fireEvent.click(screen.getByRole("radio", { name: "多解释步骤" }));
    fireEvent.change(screen.getByLabelText("偏好语言"), { target: { value: "en" } });
    fireEvent.change(screen.getByLabelText("补充回答说明"), { target: { value: "Group findings by topic." } });

    await waitFor(() => expect(document.documentElement.dataset.textSize).toBe("large"));
    const stored = JSON.parse(localStorage.getItem(PREFERENCES_STORAGE_KEY)!) as UserPreferences;
    expect(stored.presentation).toEqual({ layoutMode: "simple", textSize: "large", highContrast: true, reduceMotion: true });
    expect(stored.assistant).toEqual({ responseDetail: "detailed", stepExplanation: "more", preferredLanguage: "en", additionalGuidance: "Group findings by topic." });
    expect(stored.voice).toEqual({ runNoticesEnabled: false, speechRate: "normal" });
  });

  it("restores all known preferences to defaults", async () => {
    renderPreferences();
    fireEvent.click(screen.getByRole("radio", { name: /大字简洁/ }));
    fireEvent.click(screen.getByRole("radio", { name: "详细" }));
    fireEvent.change(screen.getByLabelText("补充回答说明"), { target: { value: "Use numbered steps." } });
    fireEvent.click(screen.getByRole("button", { name: "恢复默认偏好" }));

    const layoutGroup = within(screen.getByRole("group", { name: "使用方式" }));
    await waitFor(() => expect((layoutGroup.getByRole("radio", { name: /^标准/ }) as HTMLInputElement).checked).toBe(true));
    const stored = JSON.parse(localStorage.getItem(PREFERENCES_STORAGE_KEY)!) as UserPreferences;
    expect(stored).toEqual(DEFAULT_PREFERENCES);
    expect((screen.getByLabelText("补充回答说明") as HTMLTextAreaElement).value).toBe("");
    expect((layoutGroup.getByRole("radio", { name: /^标准/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("radio", { name: /大字简洁/ }) as HTMLInputElement).checked).toBe(false);
  });

  it("uses only explicitly injected voice capabilities and keeps their input local to the page", async () => {
    const readAloud = vi.fn().mockResolvedValue(undefined);
    const transcribeOnce = vi.fn().mockResolvedValue("把这段文字当作本地预览");
    const capabilities: VoiceCapabilities = {
      readAloud,
      transcribeOnce,
    };
    render(<PreferencesProvider><PreferencesScreen voiceCapabilities={capabilities} /></PreferencesProvider>);
    fireEvent.click(screen.getByText("语音功能 · 已接入"));

    const readButton = screen.getByRole("button", { name: "测试语音播报" });
    fireEvent.click(readButton);
    await screen.findByText("语音播报测试已完成。");
    expect(readAloud).toHaveBeenCalledWith("语音播报测试正常。");
    fireEvent.click(screen.getByRole("button", { name: "语音输入测试" }));
    await screen.findByText("把这段文字当作本地预览");
    expect(localStorage.getItem(PREFERENCES_STORAGE_KEY)).toBeNull();
    expect(transcribeOnce).toHaveBeenCalledTimes(1);
  });

  it("lets an injected replaceable output adapter enable and save run-notice speech preferences", async () => {
    const capabilities: VoiceCapabilities = {
      createOutputAdapter: () => ({
        openSession: async () => ({
          enqueueText: async () => undefined,
          finish: async () => undefined,
          cancel: async () => undefined,
        }),
      }),
    };
    render(<PreferencesProvider><PreferencesScreen voiceCapabilities={capabilities} /></PreferencesProvider>);
    const enabled = screen.getByRole("switch", { name: /朗读任务关键通知/ }) as HTMLInputElement;
    expect(enabled.checked).toBe(false);
    expect(enabled.disabled).toBe(false);
    fireEvent.click(enabled);
    fireEvent.change(screen.getByLabelText("朗读速度"), { target: { value: "fast" } });
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem(PREFERENCES_STORAGE_KEY)!) as UserPreferences;
      expect(stored.voice).toEqual({ runNoticesEnabled: true, speechRate: "fast" });
    });
  });

  it("keeps unavailable voice controls out of the way and does not expose fake actions", () => {
    renderPreferences();
    const voice = screen.getByText("语音功能 · 暂不可用").closest("details") as HTMLDetailsElement;
    expect(voice.open).toBe(false);
    expect(screen.queryByRole("button", { name: /朗读偏好说明/ })).toBeNull();
    voice.open = true;
    expect(screen.getByText(/不会录音，也不会申请麦克风权限/)).toBeDefined();
    const noticeSwitch = screen.getByRole("switch", { name: /朗读任务关键通知/ }) as HTMLInputElement;
    expect(noticeSwitch.checked).toBe(false);
    expect(noticeSwitch.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /语音输入测试/ })).toBeNull();
  });

  it("loads managed-browser state and labels the local status and default-session choices", async () => {
    renderPreferences();

    expect(await screen.findByText("已准备（本机）")).toBeDefined();
    expect(screen.getByRole("group", { name: "新任务默认浏览器" })).toBeDefined();
    expect(screen.getByRole("radio", { name: /本机已准备的登录状态/ })).toBeDefined();
    expect(screen.getByRole("radio", { name: /临时空白浏览器/ })).toBeDefined();
    expect((screen.getByRole("radio", { name: /本机已准备的登录状态/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/登录状态仅保存在这台电脑/)).toBeDefined();
    const browserSection = screen.getByRole("region", { name: "浏览器与登录状态" });
    expect(within(browserSection).queryByRole("button", { name: /清除登录状态/ })).toBeNull();
    expect(getManagedBrowserProfileSettings).toHaveBeenCalledTimes(1);
  });

  it("saves the default and runs prepare, complete, and relogin through the profile API", async () => {
    renderPreferences();

    fireEvent.click(await screen.findByRole("radio", { name: /临时空白浏览器/ }));
    await waitFor(() => expect(setManagedBrowserDefaultSession).toHaveBeenCalledWith("temporary"));
    expect(await screen.findByText("之后的新任务将使用空白临时浏览器。")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "准备登录状态" }));
    expect(await screen.findByRole("button", { name: "我已在电脑完成登录" })).toBeDefined();
    expect(prepareManagedBrowserLogin).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("电脑端浏览器仍在准备。请完成登录后回到这里确认。")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "我已在电脑完成登录" }));
    await waitFor(() => expect(completeManagedBrowserLogin).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111"));
    expect(await screen.findByText("浏览器登录状态已保存在本机。网站可能会在以后要求重新登录。")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "重新登录" }));
    await waitFor(() => expect(reloginManagedBrowser).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("电脑端浏览器仍在准备。请完成登录后回到这里确认。")).toBeDefined();
  });

  it("reports a failed cleanup returned by completion without success copy", async () => {
    vi.mocked(getManagedBrowserProfileSettings).mockResolvedValue(preparingBrowserProfile);
    vi.mocked(completeManagedBrowserLogin).mockResolvedValue(cleanupFailedBrowserProfile);
    renderPreferences();

    fireEvent.click(await screen.findByRole("button", { name: "我已在电脑完成登录" }));
    expect(await screen.findByText(/电脑未能确认受管浏览器已关闭/)).toBeDefined();
    expect(screen.queryByText(/已完成|已保存在本机/)).toBeNull();
    expect(screen.getByText("清理状态未确认")).toBeDefined();
  });

  it("uses returned status messages for prepare and relogin instead of unconditional success", async () => {
    vi.mocked(prepareManagedBrowserLogin).mockResolvedValueOnce(cleanupFailedBrowserProfile);
    renderPreferences();

    fireEvent.click(await screen.findByRole("button", { name: "准备登录状态" }));
    expect(await screen.findByText(/电脑未能确认受管浏览器已关闭/)).toBeDefined();
    expect(screen.queryByText(/正在准备|登录状态已准备好|已保存在本机/)).toBeNull();

    cleanup();
    vi.clearAllMocks();
    vi.mocked(getManagedBrowserProfileSettings).mockResolvedValue(reloginRequiredBrowserProfile);
    vi.mocked(reloginManagedBrowser).mockResolvedValueOnce(unpreparedBrowserProfile);
    renderPreferences();

    fireEvent.click(await screen.findByRole("button", { name: "重新登录" }));
    expect(await screen.findByText("本机登录状态尚未准备。请在电脑端准备并登录受管浏览器。")).toBeDefined();
    expect(screen.queryByText(/登录状态已准备好|已保存在本机/)).toBeNull();
  });

  it("shows profile-operation errors without hiding them", async () => {
    vi.mocked(prepareManagedBrowserLogin).mockRejectedValueOnce(new ApiError("电脑控制服务暂时无法连接。", 0, "HOST_UNREACHABLE"));
    renderPreferences();

    fireEvent.click(await screen.findByRole("button", { name: "准备登录状态" }));
    expect((await screen.findByRole("alert")).textContent).toContain("电脑控制服务暂时无法连接。");
  });

  it("refreshes the displayed state after a stale profile operation", async () => {
    vi.mocked(prepareManagedBrowserLogin).mockRejectedValueOnce(new ApiError("状态已变化，请先刷新后再操作。", 409, "PROFILE_OPERATION_STALE"));
    vi.mocked(getManagedBrowserProfileSettings)
      .mockResolvedValueOnce(readyBrowserProfile)
      .mockResolvedValueOnce({ ...readyBrowserProfile, status: "relogin_required" });
    renderPreferences();

    fireEvent.click(await screen.findByRole("button", { name: "准备登录状态" }));
    await waitFor(() => expect(getManagedBrowserProfileSettings).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("需要重新登录")).toBeDefined();
  });

  it("labels, counts, stores, and lets the user clear additional guidance", async () => {
    renderPreferences();
    const guidance = screen.getByRole("textbox", { name: "补充回答说明" }) as HTMLTextAreaElement;
    expect(guidance.getAttribute("aria-describedby")).toContain("assistant-guidance-help");
    expect(screen.getByText(/每次最多 600 个字符/)).toBeDefined();
    expect((screen.getByRole("button", { name: "清空补充说明" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(guidance, { target: { value: "🙂".repeat(500) } });
    expect(screen.getByLabelText("500 / 600 个字符")).toBeDefined();
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem(PREFERENCES_STORAGE_KEY)!) as UserPreferences;
      expect([...stored.assistant.additionalGuidance]).toHaveLength(500);
    });

    fireEvent.click(screen.getByRole("button", { name: "清空补充说明" }));
    expect(guidance.value).toBe("");
    expect(screen.getByLabelText("0 / 600 个字符")).toBeDefined();
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem(PREFERENCES_STORAGE_KEY)!) as UserPreferences;
      expect(stored.assistant.additionalGuidance).toBe("");
    });
  });
});
