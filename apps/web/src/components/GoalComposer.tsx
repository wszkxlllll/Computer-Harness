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
        disabled={disabled || busy}
        required
      />
      {error && <p id="goal-error" className="inline-error" role="alert">{error}</p>}
      <WindowTargetPicker {...targetPicker} disabled={disabled || busy || targetPicker.disabled} />
      <div className="composer-footer">
        <button className="button button-primary button-large" type="submit" disabled={disabled || busy || !canStart || !goal.trim() || !targetPicker.selectedToken}>
          {busy ? "正在发送…" : "开始任务"}
        </button>
      </div>
    </form>
  );
}
