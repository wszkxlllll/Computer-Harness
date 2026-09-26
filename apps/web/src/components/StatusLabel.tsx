import type { RunStatus } from "../types";

const statusText: Record<RunStatus, string> = {
  created: "正在准备",
  running: "电脑正在处理",
  waiting_user: "等你补充信息",
  waiting_window: "等你选择窗口",
  waiting_approval: "等你确认操作",
  paused: "任务已暂停",
  finished: "任务已结束",
};

interface StatusLabelProps {
  status: RunStatus;
  compact?: boolean;
}

export function StatusLabel({ status, compact = false }: StatusLabelProps) {
  return (
    <span className={`status-label status-${status}${compact ? " status-compact" : ""}`}>
      <span className="status-dot" aria-hidden="true" />
      <span>{statusText[status]}</span>
    </span>
  );
}

export function statusTextFor(status: RunStatus): string {
  return statusText[status];
}
