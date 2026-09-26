import { useState, type FormEvent } from "react";
import { WindowTargetPicker, type WindowTargetPickerProps } from "./WindowTargetPicker";

interface GoalComposerProps {
  disabled?: boolean;
  busy?: boolean;
  canStart: boolean;
  targetPicker: WindowTargetPickerProps;
  onSubmit: (goal: string, targetToken: string) => Promise<void>;
  error?: string;
}

export function GoalComposer({ disabled = false, busy = false, canStart, targetPicker, onSubmit, error }: GoalComposerProps) {
  const [goal, setGoal] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = goal.trim();
    const targetToken = targetPicker.selectedToken;
    if (!value || !targetToken || !canStart || disabled || busy) return;
    await onSubmit(value, targetToken);
  }

  return (
    <form className="goal-composer" onSubmit={submit}>
      <label htmlFor="goal-input">你想让电脑完成什么？</label>
      <p id="goal-help" className="field-hint">尽量说清目标、范围和你希望收到的结果。</p>
      <textarea
        id="goal-input"
        name="goal"
        rows={4}
        value={goal}
        onChange={(event) => setGoal(event.currentTarget.value)}
        placeholder="例如：搜索明天上海到杭州的上午高铁，整理三种合适车次并附上来源。"
        aria-describedby={error ? "goal-help goal-error" : "goal-help"}
        disabled={disabled || busy}
        required
      />
      {error && <p id="goal-error" className="inline-error" role="alert">{error}</p>}
      <WindowTargetPicker {...targetPicker} disabled={disabled || busy || targetPicker.disabled} />
      <div className="composer-footer">
        <span className="quiet-note">电脑会在需要你确认时停下来。</span>
        <button className="button button-primary button-large" type="submit" disabled={disabled || busy || !canStart || !goal.trim() || !targetPicker.selectedToken}>
          {busy ? "正在发送…" : "开始任务"}
        </button>
      </div>
    </form>
  );
}
