import { useState } from "react";
import { PhoneLayout } from "./components/PhoneLayout";
import { usePreferences } from "./PreferencesContext";
import { RUN_ASSISTANT_PREFERENCES_MAX_GUIDANCE_CHARS } from "./preferences";
import type { AssistantPreferences, DisplayPreset, PreferredLanguage, ResponseDetail, SpeechRate, StepExplanation, TextSize } from "./preferences";
import type { VoiceCapabilities } from "./voice-capabilities";
import { isBrowserSpeechOutputAvailable } from "./run-notice-speech";

export function PreferencesScreen({ voiceCapabilities }: { voiceCapabilities?: VoiceCapabilities }) {
  const { preferences, saved, setAssistant, setPresentation, setDisplayPreset, setVoice, reset } = usePreferences();
  const [message, setMessage] = useState("");
  const [voiceInputText, setVoiceInputText] = useState("");
  const [voiceMessage, setVoiceMessage] = useState("");
  const [voiceBusy, setVoiceBusy] = useState(false);
  const voiceOutputAvailable = voiceCapabilities?.createOutputAdapter !== undefined || isBrowserSpeechOutputAvailable();
  const preset: DisplayPreset | undefined = preferences.presentation.layoutMode === "simple" && preferences.presentation.textSize === "large"
    ? "large_simple"
    : preferences.presentation.layoutMode === "standard" && preferences.presentation.textSize === "standard"
      ? "standard"
      : undefined;

  function savePresentation<K extends keyof typeof preferences.presentation>(key: K, value: (typeof preferences.presentation)[K]) {
    setMessage(setPresentation(key, value) ? "偏好已保存到此浏览器。" : "偏好已更新，但浏览器未能保存。");
  }

  function saveDisplayPreset(value: DisplayPreset) {
    setMessage(setDisplayPreset(value) ? "显示方式和文字大小已保存到此浏览器。" : "显示方式已更新，但浏览器未能保存。");
  }

  function saveAssistant<K extends keyof AssistantPreferences>(key: K, value: AssistantPreferences[K]) {
    setMessage(setAssistant(key, value) ? "偏好已保存到此浏览器。" : "偏好已更新，但浏览器未能保存。");
  }

  function restoreDefaults() {
    setMessage(reset() ? "已恢复默认偏好，并保存到此浏览器。" : "已恢复默认偏好，但浏览器未能保存。");
  }

  async function readPreferenceHelp() {
    if (!voiceCapabilities?.readAloud || voiceBusy) return;
    setVoiceBusy(true);
    setVoiceMessage("");
    try {
      await voiceCapabilities.readAloud("你正在查看个人偏好。助手回答偏好会在开始新任务时加入该任务的 Context。");
      setVoiceMessage("已将这段说明交给接入的语音能力。");
    } catch {
      setVoiceMessage("语音读出没有启动。你仍可阅读页面上的说明。");
    } finally {
      setVoiceBusy(false);
    }
  }

  async function capturePreferenceText() {
    if (!voiceCapabilities?.transcribeOnce || voiceBusy) return;
    setVoiceBusy(true);
    setVoiceMessage("");
    try {
      const transcript = await voiceCapabilities.transcribeOnce();
      if (typeof transcript === "string" && transcript.trim()) {
        setVoiceInputText(transcript);
        setVoiceMessage("转写内容仅显示在此页面，没有保存或提交。");
      } else {
        setVoiceMessage("没有收到语音转写内容。");
      }
    } catch {
      setVoiceMessage("语音输入没有完成。没有内容发送给任务或助手。");
    } finally {
      setVoiceBusy(false);
    }
  }

  return (
    <PhoneLayout active="settings">
      <main className="page-shell preferences-page" aria-labelledby="preferences-title">
        <h1 id="preferences-title" className="page-title">设置</h1>

        <section className="preferences-section" aria-labelledby="display-preferences-title">
          <h2 id="display-preferences-title">显示与辅助</h2>
          <fieldset className="preference-choice-group">
            <legend>使用方式</legend>
            <PreferenceRadio<DisplayPreset>
              name="displayPreset"
              value="standard"
              selected={preset}
              title="标准"
              onChange={saveDisplayPreset}
            />
            <PreferenceRadio<DisplayPreset>
              name="displayPreset"
              value="large_simple"
              selected={preset}
              title="大字简洁"
              onChange={saveDisplayPreset}
            />
            {preset === undefined && <p className="field-hint">当前为自定义组合。你可以在下方单独调整文字大小。</p>}
          </fieldset>

          <fieldset className="preference-choice-group">
            <legend>文字大小</legend>
            <div className="preference-radio-row">
              <PreferenceRadio<TextSize>
                name="textSize"
                value="standard"
                selected={preferences.presentation.textSize}
                title="标准"
                onChange={(value) => savePresentation("textSize", value)}
                compact
              />
              <PreferenceRadio<TextSize>
                name="textSize"
                value="large"
                selected={preferences.presentation.textSize}
                title="大字"
                onChange={(value) => savePresentation("textSize", value)}
                compact
              />
            </div>
            <p className="field-hint sr-only">只调整页面文字尺寸；窄屏内容会自动换行。</p>
          </fieldset>

          <PreferenceToggle
            id="high-contrast"
            title="高对比度"
            description="加深文字和边界，减少浅色区分。"
            checked={preferences.presentation.highContrast}
            onChange={(value) => savePresentation("highContrast", value)}
          />
          <PreferenceToggle
            id="reduce-motion"
            title="减少动画"
            description="关闭装饰性过渡；浏览器的减少动态效果设置也会生效。"
            checked={preferences.presentation.reduceMotion}
            onChange={(value) => savePresentation("reduceMotion", value)}
          />
        </section>

        <section className="preferences-section assistant-preferences" aria-labelledby="assistant-preferences-title">
          <h2 id="assistant-preferences-title">助手回答偏好</h2>
          <p className="field-hint">这些回答偏好只保存在此浏览器。开始新任务时会随白名单发送给电脑端，并作为该 Run 的 Context 提交给已配置的模型；修改不会影响已开始的任务，也不会在设备间同步。它们不会改变电脑操作或审批规则。</p>

          <fieldset className="preference-choice-group">
            <legend>回答详略</legend>
            <div className="preference-radio-row">
              <PreferenceRadio<ResponseDetail> name="responseDetail" value="concise" selected={preferences.assistant.responseDetail} title="简短" onChange={(value) => saveAssistant("responseDetail", value)} compact />
              <PreferenceRadio<ResponseDetail> name="responseDetail" value="standard" selected={preferences.assistant.responseDetail} title="标准" onChange={(value) => saveAssistant("responseDetail", value)} compact />
              <PreferenceRadio<ResponseDetail> name="responseDetail" value="detailed" selected={preferences.assistant.responseDetail} title="详细" onChange={(value) => saveAssistant("responseDetail", value)} compact />
            </div>
          </fieldset>

          <fieldset className="preference-choice-group">
            <legend>步骤说明</legend>
            <div className="preference-radio-row">
              <PreferenceRadio<StepExplanation> name="stepExplanation" value="standard" selected={preferences.assistant.stepExplanation} title="按需说明" onChange={(value) => saveAssistant("stepExplanation", value)} compact />
              <PreferenceRadio<StepExplanation> name="stepExplanation" value="more" selected={preferences.assistant.stepExplanation} title="多解释步骤" onChange={(value) => saveAssistant("stepExplanation", value)} compact />
            </div>
          </fieldset>

          <div className="preference-language-row">
            <label className="preference-select-label" htmlFor="preferred-language">偏好语言</label>
            <select
              className="preference-select"
              id="preferred-language"
              value={preferences.assistant.preferredLanguage}
              onChange={(event) => saveAssistant("preferredLanguage", event.currentTarget.value as PreferredLanguage)}
            >
              <option value="follow_conversation">跟随当前对话</option>
              <option value="zh-CN">简体中文</option>
              <option value="en">English</option>
            </select>
          </div>

          <div className="assistant-guidance">
            <label htmlFor="assistant-additional-guidance">补充回答说明</label>
            <textarea
              id="assistant-additional-guidance"
              className="preference-textarea"
              value={preferences.assistant.additionalGuidance}
              maxLength={RUN_ASSISTANT_PREFERENCES_MAX_GUIDANCE_CHARS * 2}
              aria-describedby="assistant-guidance-help assistant-guidance-count"
              onChange={(event) => {
                const guidance = Array.from(event.currentTarget.value)
                  .slice(0, RUN_ASSISTANT_PREFERENCES_MAX_GUIDANCE_CHARS)
                  .join("");
                setMessage(setAssistant("additionalGuidance", guidance)
                  ? "补充说明已保存在此浏览器，并会用于下一次新任务。"
                  : "补充说明已更新，但浏览器未能保存。");
              }}
            />
            <div className="assistant-guidance-footer">
              <p id="assistant-guidance-help" className="field-hint">写下你希望回答采用的格式或解释方式。每次最多 {RUN_ASSISTANT_PREFERENCES_MAX_GUIDANCE_CHARS} 个字符；内容只保存在此浏览器，并仅用于之后开始的新任务。</p>
              <span id="assistant-guidance-count" className="guidance-counter" aria-label={`${[...preferences.assistant.additionalGuidance].length} / ${RUN_ASSISTANT_PREFERENCES_MAX_GUIDANCE_CHARS} 个字符`}>
                {[...preferences.assistant.additionalGuidance].length} / {RUN_ASSISTANT_PREFERENCES_MAX_GUIDANCE_CHARS}
              </span>
            </div>
            <button
              className="text-button guidance-clear"
              type="button"
              disabled={preferences.assistant.additionalGuidance.length === 0}
              onClick={() => setMessage(setAssistant("additionalGuidance", "")
                ? "补充说明已清除，并保存在此浏览器。"
                : "补充说明已清除，但浏览器未能保存。")}
            >
              清空补充说明
            </button>
          </div>
        </section>

        <details className="preferences-section voice-capability">
          <summary>语音功能 · {voiceCapabilities?.readAloud || voiceCapabilities?.transcribeOnce ? "已接入" : voiceOutputAvailable ? "任务播报可用" : "暂不可用"}</summary>
          <div className="voice-capability-content">
            <p>任务通知使用当前接入的语音合成；只有明确打开下方开关后才会朗读。此功能不会录音，也不会申请麦克风权限。</p>
            <fieldset className="preference-choice-group">
              <legend>任务通知播报</legend>
              <PreferenceToggle
                id="run-notices-speech"
                title="朗读任务关键通知"
                description="朗读任务进度、等待确认、错误和最终结果；审批或提问变化时会停止过期播报。"
                checked={preferences.voice.runNoticesEnabled}
                disabled={!voiceOutputAvailable}
                onChange={(value) => setMessage(setVoice("runNoticesEnabled", value) ? "语音偏好已保存到此浏览器。" : "语音偏好已更新，但浏览器未能保存。")}
              />
              {!voiceOutputAvailable && <p className="field-hint">当前环境不支持语音播报，任务通知仍会显示为文字。</p>}
            </fieldset>
            <div className="preference-language-row">
              <label className="preference-select-label" htmlFor="speech-rate">朗读速度</label>
              <select
                className="preference-select"
                id="speech-rate"
                value={preferences.voice.speechRate}
                disabled={!voiceOutputAvailable}
                onChange={(event) => setMessage(setVoice("speechRate", event.currentTarget.value as SpeechRate) ? "朗读速度已保存到此浏览器。" : "朗读速度已更新，但浏览器未能保存。")}
              >
                <option value="slow">慢</option>
                <option value="normal">标准</option>
                <option value="fast">稍快</option>
              </select>
            </div>
            {(voiceCapabilities?.readAloud || voiceCapabilities?.transcribeOnce) && (
              <div className="voice-actions">
                {voiceCapabilities.readAloud && (
                  <button className="button button-secondary" type="button" disabled={voiceBusy} onClick={() => void readPreferenceHelp()}>
                    朗读偏好说明
                  </button>
                )}
                {voiceCapabilities.transcribeOnce && (
                  <button className="button button-secondary" type="button" disabled={voiceBusy} onClick={() => void capturePreferenceText()}>
                    语音输入测试
                  </button>
                )}
              </div>
            )}
            {voiceInputText && <p className="voice-transcript"><strong>转写预览：</strong>{voiceInputText}</p>}
            <p className="preference-save-status" role="status" aria-live="polite">{voiceMessage}</p>
            <p className="field-hint">语音输入测试内容只显示在此页；不会提交任务或写入个人偏好。</p>
          </div>
        </details>

        <div className="preferences-footer">
          <button className="button button-secondary button-large" type="button" onClick={restoreDefaults}>恢复默认偏好</button>
          <p className="preference-save-status" role="status" aria-live="polite">{message || (saved === false ? "浏览器未能保存偏好。" : "")}</p>
        </div>
      </main>
    </PhoneLayout>
  );
}

function PreferenceRadio<T extends string>({
  name,
  value,
  selected,
  title,
  description,
  onChange,
  compact = false,
}: {
  name: string;
  value: T;
  selected: T | undefined;
  title: string;
  description?: string;
  onChange: (value: T) => void;
  compact?: boolean;
}) {
  const id = `${name}-${value}`;
  return (
    <label className={`preference-radio${compact ? " preference-radio-compact" : ""}`} htmlFor={id}>
      <input id={id} name={name} type="radio" value={value} checked={selected === value} onChange={() => onChange(value)} />
      <span className="preference-radio-copy">
        <strong>{title}</strong>
        {description && <span>{description}</span>}
      </span>
    </label>
  );
}

function PreferenceToggle({
  id,
  title,
  description,
  checked,
  disabled = false,
  onChange,
}: {
  id: string;
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="preference-toggle" htmlFor={id}>
      <span className="preference-toggle-copy">
        <strong>{title}</strong>
        <span className="sr-only">{description}</span>
      </span>
      <input id={id} type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(event) => onChange(event.currentTarget.checked)} />
    </label>
  );
}
