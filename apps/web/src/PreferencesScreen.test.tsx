// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreferencesScreen } from "./PreferencesScreen";
import { PreferencesProvider } from "./PreferencesContext";
import { PREFERENCES_STORAGE_KEY, DEFAULT_PREFERENCES, type UserPreferences } from "./preferences";
import type { VoiceCapabilities } from "./voice-capabilities";

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
  beforeEach(() => localStorage.clear());

  it("keeps assistant preferences separate from display preferences and stores them locally", async () => {
    renderPreferences();
    const contextNote = screen.getByText("仅保存在此浏览器；尚未连接助手 Context").closest("details") as HTMLDetailsElement;
    expect(contextNote.open).toBe(false);
    contextNote.open = true;
    expect(screen.getByText("这些选项不会改变当前任务、电脑操作或审批规则。")).toBeDefined();
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

    await waitFor(() => expect(document.documentElement.dataset.textSize).toBe("large"));
    const stored = JSON.parse(localStorage.getItem(PREFERENCES_STORAGE_KEY)!) as UserPreferences;
    expect(stored.presentation).toEqual({ layoutMode: "simple", textSize: "large", highContrast: true, reduceMotion: true });
    expect(stored.assistant).toEqual({ responseDetail: "detailed", stepExplanation: "more", preferredLanguage: "en" });
  });

  it("restores all known preferences to defaults", async () => {
    renderPreferences();
    fireEvent.click(screen.getByRole("radio", { name: /大字简洁/ }));
    fireEvent.click(screen.getByRole("radio", { name: "详细" }));
    fireEvent.click(screen.getByRole("button", { name: "恢复默认偏好" }));

    const layoutGroup = within(screen.getByRole("group", { name: "使用方式" }));
    await waitFor(() => expect((layoutGroup.getByRole("radio", { name: /^标准/ }) as HTMLInputElement).checked).toBe(true));
    const stored = JSON.parse(localStorage.getItem(PREFERENCES_STORAGE_KEY)!) as UserPreferences;
    expect(stored).toEqual(DEFAULT_PREFERENCES);
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

    const readButton = screen.getByRole("button", { name: "朗读偏好说明" });
    fireEvent.click(readButton);
    await screen.findByText("已将这段说明交给接入的语音能力。");
    expect(readAloud).toHaveBeenCalledWith("你正在查看个人偏好。这里的回答选项尚未连接到助手 Context。");
    fireEvent.click(screen.getByRole("button", { name: "语音输入测试" }));
    await screen.findByText("把这段文字当作本地预览");
    expect(localStorage.getItem(PREFERENCES_STORAGE_KEY)).toBeNull();
    expect(transcribeOnce).toHaveBeenCalledTimes(1);
  });

  it("keeps unavailable voice controls out of the way and does not expose fake actions", () => {
    renderPreferences();
    const voice = screen.getByText("语音功能 · 暂不可用").closest("details") as HTMLDetailsElement;
    expect(voice.open).toBe(false);
    expect(screen.queryByRole("button", { name: /朗读偏好说明/ })).toBeNull();
    voice.open = true;
    expect(screen.getByText(/不会调用浏览器语音或麦克风接口/)).toBeDefined();
    expect(screen.queryByRole("button", { name: /语音输入测试/ })).toBeNull();
  });
});
