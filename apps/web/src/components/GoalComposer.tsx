import { useState, type FormEvent } from "react";
import type { RunTarget } from "../types";
import { isValidBrowserUrl } from "../run-target";
import { WindowTargetPicker, type WindowTargetPickerProps } from "./WindowTargetPicker";
import { VoiceInputControl } from "./VoiceInputControl";
import type { VoiceAudioCaptureAdapter } from "@computer-harness/voice";
import { appendVoiceInputText } from "../voice-input-text";

interface GoalComposerProps {
  disabled?: boolean;
  busy?: boolean;
  canStart: boolean;
  targetMode: RunTarget["mode"];
  browserSessionMode: "temporary" | "saved";
  browserUrl: string;
  onTargetModeChange: (mode: RunTarget["mode"]) => void;
  onBrowserSessionModeChange: (mode: "temporary" | "saved") => void;
  onBrowserUrlChange: (url: string) => void;
  targetPicker: WindowTargetPickerProps;
  voiceCaptureAdapterFactory?: (chunkBytes: number) => VoiceAudioCaptureAdapter;
  onSubmit: (goal: string, target: RunTarget) => Promise<void>;
  error?: string;
}

export function GoalComposer({
  disabled = false,
  busy = false,
  canStart,
  targetMode,
  browserSessionMode,
  browserUrl,
  onTargetModeChange,
  onBrowserSessionModeChange,
  onBrowserUrlChange,
  targetPicker,
  voiceCaptureAdapterFactory,
  onSubmit,
  error,
}: GoalComposerProps) {
  const [goal, setGoal] = useState("");
  const [voiceActive, setVoiceActive] = useState(false);
  const formDisabled = disabled || busy || voiceActive;
  const parsedBrowserUrl = browserUrl.trim();
  const browserUrlValid = !parsedBrowserUrl || isValidBrowserUrl(parsedBrowserUrl);
  const browserUrlInvalid = Boolean(parsedBrowserUrl) && !isValidBrowserUrl(parsedBrowserUrl);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = goal.trim();
    if (!value || !canStart || disabled || busy || voiceActive) return;
    if (targetMode === "window") {
      const targetToken = targetPicker.selectedToken;
      if (!targetToken) return;
      await onSubmit(value, { mode: "window", targetToken });
      return;
    }
    if (targetMode === "browser") {
      if (!browserUrlValid) return;
      await onSubmit(value, parsedBrowserUrl
        ? { mode: "browser", sessionMode: browserSessionMode, url: parsedBrowserUrl }
        : { mode: "browser", sessionMode: browserSessionMode });
      return;
    }
    await onSubmit(value, { mode: "auto" });
  }

  return (
    <form id="new-task" className="goal-composer" onSubmit={submit}>
      <label htmlFor="goal-input">想让电脑做什么？</label>
      <p id="goal-help" className="sr-only">描述目标、范围和期望结果。</p>
      <textarea
        id="goal-input"
        name="goal"
        rows={4}
        value={goal}
        onChange={(event) => setGoal(event.currentTarget.value)}
        placeholder="写下任务内容…"
        aria-describedby={error ? "goal-help goal-error" : "goal-help"}
        disabled={formDisabled}
        required
      />
      <VoiceInputControl disabled={disabled || busy} onActiveChange={setVoiceActive} onTranscript={(text) => setGoal((current) => appendVoiceInputText(current, text))} createCaptureAdapter={voiceCaptureAdapterFactory} />
      {error && <p id="goal-error" className="inline-error" role="alert">{error}</p>}
      <fieldset className="target-mode-fieldset" disabled={formDisabled}>
        <legend>操作目标</legend>
        <div className="target-mode-options">
          <label className="target-mode-option">
            <input type="radio" name="target-mode" value="auto" checked={targetMode === "auto"} onChange={() => onTargetModeChange("auto")} />
            <span className="target-mode-copy"><strong>自动选择</strong><span>电脑会尝试匹配唯一的操作窗口。</span></span>
          </label>
          <label className="target-mode-option">
            <input type="radio" name="target-mode" value="window" checked={targetMode === "window"} onChange={() => onTargetModeChange("window")} />
            <span className="target-mode-copy"><strong>手动选择窗口</strong><span>从电脑上当前可用的窗口中选择。</span></span>
          </label>
          <label className="target-mode-option">
            <input type="radio" name="target-mode" value="browser" checked={targetMode === "browser"} onChange={() => onTargetModeChange("browser")} />
            <span className="target-mode-copy"><strong>打开网站</strong><span>让电脑上的浏览器打开一个地址。</span></span>
          </label>
        </div>
      </fieldset>

      {targetMode === "window" && <WindowTargetPicker {...targetPicker} disabled={formDisabled || targetPicker.disabled} />}

      {targetMode === "browser" && (
        <div className="browser-target-field">
          <fieldset className="browser-session-fieldset">
            <legend>浏览器状态</legend>
            <div className="target-mode-options browser-session-options">
              <label className="target-mode-option">
                <input type="radio" name="browser-session-mode" value="temporary" checked={browserSessionMode === "temporary"} onChange={() => onBrowserSessionModeChange("temporary")} />
                <span className="target-mode-copy"><strong>临时浏览</strong><span>使用新的临时配置，不读取电脑端保存的登录状态。</span></span>
              </label>
              <label className="target-mode-option">
                <input type="radio" name="browser-session-mode" value="saved" checked={browserSessionMode === "saved"} onChange={() => onBrowserSessionModeChange("saved")} />
                <span className="target-mode-copy"><strong>使用已登录网站</strong><span>使用电脑端准备好的登录状态。</span></span>
              </label>
            </div>
          </fieldset>
          <label htmlFor="browser-target-url">起始网址（可选）</label>
          <input
            id="browser-target-url"
            type="url"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={browserUrl}
            onChange={(event) => onBrowserUrlChange(event.currentTarget.value)}
            placeholder="https://example.com"
            aria-describedby={browserUrlInvalid ? "browser-target-help browser-target-error" : "browser-target-help"}
            aria-invalid={browserUrlInvalid}
            disabled={formDisabled}
          />
          <p id="browser-target-help" className="field-hint">{browserSessionMode === "saved" ? "留空时恢复电脑端准备好的网站；没有准备网站时安全打开空白页。填写网址时使用电脑端已准备的登录状态打开该网站。" : "留空会打开临时空白页，由助手根据任务访问网站。"}</p>
          {browserUrlInvalid && <p id="browser-target-error" className="inline-error" role="alert">请输入完整的 http:// 或 https:// 地址。</p>}
        </div>
      )}
      <div className="composer-footer">
        <button
          className="button button-primary button-large"
          type="submit"
          disabled={formDisabled || !canStart || !goal.trim() || (targetMode === "window" && !targetPicker.selectedToken) || (targetMode === "browser" && !browserUrlValid)}
        >
          {busy ? "正在发送…" : "开始任务"}
        </button>
      </div>
    </form>
  );
}
