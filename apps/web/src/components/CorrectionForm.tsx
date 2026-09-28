import { useState, type FormEvent } from "react";
import { VoiceInputControl } from "./VoiceInputControl";
import { appendVoiceInputText } from "../voice-input-text";
import type { VoiceAudioCaptureAdapter } from "@computer-harness/voice";

interface CorrectionFormProps {
  disabled?: boolean;
  voiceCaptureAdapterFactory?: (chunkBytes: number) => VoiceAudioCaptureAdapter;
  onSubmit: (text: string) => Promise<boolean>;
}

export function CorrectionForm({ disabled = false, voiceCaptureAdapterFactory, onSubmit }: CorrectionFormProps) {
  const [text, setText] = useState("");
  const [voiceActive, setVoiceActive] = useState(false);
  const formDisabled = disabled || voiceActive;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = text.trim();
    if (!value || disabled || voiceActive) return;
    if (await onSubmit(value)) setText("");
  }

  return (
    <form className="correction-form" onSubmit={submit}>
      <label htmlFor="correction-input">补充或修正任务要求</label>
      <p className="field-hint" id="correction-help">例如：“把预算上限改为 300 元”或“先不要打开付款页面”。</p>
      <textarea id="correction-input" aria-describedby="correction-help" rows={2} value={text} onChange={(event) => setText(event.currentTarget.value)} disabled={formDisabled} />
      <VoiceInputControl disabled={disabled} onActiveChange={setVoiceActive} onTranscript={(recognized) => setText((current) => appendVoiceInputText(current, recognized))} createCaptureAdapter={voiceCaptureAdapterFactory} />
      <button className="button button-secondary" type="submit" disabled={formDisabled || !text.trim()}>发送补充要求</button>
    </form>
  );
}
