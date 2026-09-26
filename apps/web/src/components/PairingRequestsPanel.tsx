import { useState } from "react";
import type { PairingRequest } from "../types";
import { formatDate } from "../date-format";

interface PairingRequestsPanelProps {
  requests: PairingRequest[];
  loading: boolean;
  busy: boolean;
  onDecide: (request: PairingRequest, approved: boolean, label?: string) => void;
}

export function PairingRequestsPanel({ requests, loading, busy, onDecide }: PairingRequestsPanelProps) {
  const [labels, setLabels] = useState<Record<string, string>>({});

  return (
    <section className="connect-side-panel" aria-labelledby="pending-heading">
      <div className="section-kicker">需要电脑确认</div>
      <h2 id="pending-heading">待处理请求</h2>
      {loading && <p className="loading-line" role="status">正在检查是否有手机请求…</p>}
      {!loading && requests.length === 0 && <p className="empty-inline">目前没有待处理请求。</p>}
      <ul className="approval-list">
        {requests.map((request) => (
          <li className="approval-item" key={request.requestId}>
            <div>
              <strong>{request.clientName || "一台手机"}</strong>
              <p>请求于 {formatDate(request.createdAt)} 发起</p>
              <p className="field-hint">确认后，这台手机才能查看任务、提交要求和处理待确认事项。</p>
              <label className="device-label-field" htmlFor={`device-label-${request.requestId}`}>授权后显示的名称</label>
              <input
                className="device-label-input"
                id={`device-label-${request.requestId}`}
                value={labels[request.requestId] ?? request.clientName ?? "我的手机"}
                maxLength={48}
                onChange={(event) => setLabels((current) => ({ ...current, [request.requestId]: event.currentTarget.value }))}
              />
            </div>
            <div className="decision-actions">
              <button className="button button-primary" type="button" disabled={busy} onClick={() => onDecide(request, true, labels[request.requestId] ?? request.clientName ?? "我的手机")}>允许这台手机</button>
              <button className="button button-secondary" type="button" disabled={busy} onClick={() => onDecide(request, false)}>拒绝</button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
