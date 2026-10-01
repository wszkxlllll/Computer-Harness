import type { RemoteEvent } from "../types";

interface EventTimelineProps {
  events: RemoteEvent[];
  simplified?: boolean;
}

export function EventTimeline({ events, simplified = false }: EventTimelineProps) {
  const updates = events.flatMap((event) => {
    const label = eventLabel(event);
    return label ? [{ sequence: event.sequence, label }] : [];
  }).slice(-5).reverse();
  if (updates.length === 0) return null;
  if (simplified) {
    return (
      <details className="event-timeline event-timeline-simple">
        <summary>查看电脑最近的更新（{updates.length}）</summary>
        <ol aria-label="电脑最近的任务更新">
          {updates.map((update) => <li key={update.sequence}>{update.label}</li>)}
        </ol>
      </details>
    );
  }
  return (
    <section className="event-timeline" aria-labelledby="timeline-heading">
      <div className="section-kicker">任务进展</div>
      <h2 id="timeline-heading">电脑最近的更新</h2>
      <ol>
        {updates.map((update) => <li key={update.sequence}>{update.label}</li>)}
      </ol>
    </section>
  );
}

function eventLabel(event: RemoteEvent): string | undefined {
  if (event.type === "run.progress") return progressLabel(event.data);
  const labels: Record<string, string> = {
    "run.started": "电脑开始处理任务",
    "run.status": "电脑更新了任务状态",
    "run.pending_request": "电脑正在等待你的决定",
    "run.reply": "电脑更新了任务结果",
    "run.observation": "电脑更新了画面",
    "run.finished": "任务已结束",
    "run.paused": "任务已暂停",
    "run.resumed": "任务继续处理",
    "approval.requested": "需要你确认一项操作",
    "user.input.requested": "需要你补充信息",
    "computer.window.handoff.requested": "需要你选择一个窗口",
    "computer.window.handoff.completed": "电脑已切换到你选择的窗口",
    "observation.created": "电脑更新了画面",
    "action.execution.completed": "电脑完成了一步操作",
  };
  return labels[event.type];
}

function progressLabel(data: Record<string, unknown> | undefined): string {
  const phase = typeof data?.phase === "string" ? data.phase : "";
  const status = typeof data?.status === "string" ? data.status : "";
  if (phase === "model") {
    if (status === "started") return "模型正在分析当前画面";
    if (status === "completed") return "模型已完成一次判断";
    if (status === "failed") return data?.retryable === true ? "模型请求失败，系统正在处理" : "模型请求失败，任务可能结束";
  }
  if (phase === "action") {
    if (status === "proposed") return "电脑准备执行下一步操作";
    if (status === "started") return "电脑正在执行一步操作";
    if (status === "completed") return "电脑完成了一步操作";
    if (status === "failed") return "这一步操作未完成";
  }
  if (phase === "monitor") {
    if (status === "candidate" || status === "guidance") return "系统正在检查任务是否有进展";
    if (status === "help_requested") return "任务需要你检查当前画面";
    if (status === "transition") return "系统已记录操作后的画面变化";
  }
  return "任务正在处理";
}
