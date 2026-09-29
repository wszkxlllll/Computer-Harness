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

    const readButton = screen.getByRole("button", { name: "朗读偏好说明" });
    fireEvent.click(readButton);
    await screen.findByText("已将这段说明交给接入的语音能力。");
    expect(readAloud).toHaveBeenCalledWith("你正在查看个人偏好。助手回答偏好会在开始新任务时加入该任务的 Context。");
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
