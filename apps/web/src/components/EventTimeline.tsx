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
  if (event.type === "run.notice" && typeof event.data?.text === "string") return event.data.text.slice(0, 320);
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
