import { useState, type FormEvent } from "react";
import type { BrowserSiteChoice, RunTarget } from "../types";
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
  browserUrl: string;
  commonSiteChoices?: readonly BrowserSiteChoice[];
  onTargetModeChange: (mode: RunTarget["mode"]) => void;
  onBrowserUrlChange: (url: string) => void;
  targetPicker: WindowTargetPickerProps;
  voiceCaptureAdapterFactory?: (chunkBytes: number) => VoiceAudioCaptureAdapter;
  onSubmit: (goal: string, target: RunTarget) => Promise<void>;
  error?: string;
  setupRequired?: boolean;
}

export function GoalComposer({
  disabled = false,
  busy = false,
  canStart,
  targetMode,
  browserUrl,
  commonSiteChoices = [],
  onTargetModeChange,
  onBrowserUrlChange,
  targetPicker,
  voiceCaptureAdapterFactory,
  onSubmit,
  error,
  setupRequired = false,
}: GoalComposerProps) {
  const [goal, setGoal] = useState("");
  const [voiceActive, setVoiceActive] = useState(false);
  const [switchWindows, setSwitchWindows] = useState(false);
  const formDisabled = disabled || busy || voiceActive;
  const parsedBrowserUrl = browserUrl.trim();
  const browserUrlValid = !parsedBrowserUrl || isValidBrowserUrl(parsedBrowserUrl);
  const browserUrlInvalid = Boolean(parsedBrowserUrl) && !isValidBrowserUrl(parsedBrowserUrl);
  const validCommonSiteChoices = commonSiteChoices.flatMap((choice) => {
    const url = choice.url.trim();
    return choice.label.trim() && isValidBrowserUrl(url) ? [{ label: choice.label, url }] : [];
  });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = goal.trim();
    if (!value || !canStart || disabled || busy || voiceActive) return;
    if (targetMode === "window") {
      const targetToken = targetPicker.selectedToken;
      if (!targetToken) return;
      await onSubmit(value, { mode: "window", targetToken, ...(switchWindows ? { switchWindows: true } : {}) });
      return;
    }
    if (targetMode === "browser") {
      if (!browserUrlValid) return;
      await onSubmit(value, parsedBrowserUrl
        ? { mode: "browser", url: parsedBrowserUrl, ...(switchWindows ? { switchWindows: true } : {}) }
        : { mode: "browser", ...(switchWindows ? { switchWindows: true } : {}) });
      return;
    }
    if (targetMode === "desktop") {
      await onSubmit(value, { mode: "desktop", ...(switchWindows ? { switchWindows: true } : {}) });
      return;
    }
    await onSubmit(value, { mode: "auto", ...(switchWindows ? { switchWindows: true } : {}) });
  }

  function changeMode(mode: RunTarget["mode"]) {
    onTargetModeChange(mode);
  }

  const targetModeLabel: Record<RunTarget["mode"], string> = {
    auto: "自动选择（推荐）",
    window: "手动选择窗口",
    browser: "打开网站",
    desktop: "整个桌面（高级）",
  };

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
      {setupRequired && <a className="setup-required-link" href="/preferences">打开浏览器与登录状态设置</a>}

      <label className="preference-toggle" htmlFor="cross-window-run-switch">
        <span className="preference-toggle-copy">
          <strong>跨应用完成任务</strong>
          <span id="cross-window-run-switch-help">启用后，模型可以列出和切换已打开窗口；应用名和标题会发送给当前模型，可能包含文件名或个人信息。电脑也会按设置准备受管浏览器；浏览器页面内容可能用于本次任务。</span>
        </span>
        <input
          id="cross-window-run-switch"
          type="checkbox"
          role="switch"
          checked={switchWindows}
          onChange={(event) => setSwitchWindows(event.currentTarget.checked)}
          aria-describedby="cross-window-run-switch-help"
          disabled={formDisabled}
        />
      </label>

      <details className="target-mode-disclosure">
        <summary>选择起点 · {targetModeLabel[targetMode]}</summary>
        <fieldset className="target-mode-fieldset" disabled={formDisabled}>
          <legend>任务开始时使用的目标</legend>
          <div className="target-mode-options">
            <label className="target-mode-option">
              <input type="radio" name="target-mode" value="auto" checked={targetMode === "auto"} onChange={() => changeMode("auto")} />
              <span className="target-mode-copy"><strong>自动选择（推荐）</strong><span>电脑会尝试匹配唯一的操作窗口。</span></span>
            </label>
            <label className="target-mode-option">
              <input type="radio" name="target-mode" value="window" checked={targetMode === "window"} onChange={() => changeMode("window")} />
              <span className="target-mode-copy"><strong>手动选择窗口</strong><span>从电脑上当前可用的窗口中选择。</span></span>
            </label>
            <label className="target-mode-option">
              <input type="radio" name="target-mode" value="browser" checked={targetMode === "browser"} onChange={() => changeMode("browser")} />
              <span className="target-mode-copy"><strong>打开网站</strong><span>使用电脑设置的浏览器状态；起始网址可选。</span></span>
            </label>
            <label className="target-mode-option">
              <input type="radio" name="target-mode" value="desktop" checked={targetMode === "desktop"} onChange={() => changeMode("desktop")} />
              <span className="target-mode-copy"><strong>整个桌面（高级）</strong><span>捕获并操作当前完整桌面，可能包含其他窗口中的内容。</span></span>
            </label>
          </div>
        </fieldset>
      </details>

      {targetMode === "window" && <WindowTargetPicker {...targetPicker} disabled={formDisabled || targetPicker.disabled} />}

      {targetMode === "browser" && (
        <div className="browser-target-field">
          {validCommonSiteChoices.length > 0 && (
            <div className="browser-site-choice">
              <label htmlFor="browser-site-choice">常用网站（可选）</label>
              <select
                id="browser-site-choice"
                value={validCommonSiteChoices.some((choice) => choice.url === browserUrl) ? browserUrl : ""}
                onChange={(event) => onBrowserUrlChange(event.currentTarget.value)}
                aria-describedby="browser-site-choice-help"
                disabled={formDisabled}
              >
                <option value="">选择常用网站</option>
                {validCommonSiteChoices.map((choice, index) => (
                  <option key={`${choice.url}-${index}`} value={choice.url}>{choice.label}</option>
                ))}
              </select>
              <p id="browser-site-choice-help" className="field-hint">选择后会填入下方起始网址，仍可编辑。</p>
            </div>
          )}
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
          <p id="browser-target-help" className="field-hint">留空会打开空白页。浏览器状态使用电脑「浏览器与登录状态」设置的默认值。</p>
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
