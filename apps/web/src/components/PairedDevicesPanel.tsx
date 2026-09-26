import type { PairedDevice } from "../types";
import { formatDate } from "../date-format";

interface PairedDevicesPanelProps {
  devices: PairedDevice[];
  loading: boolean;
  busy: boolean;
  onRefresh: () => void;
  onRevoke: (device: PairedDevice) => void;
}

export function PairedDevicesPanel({ devices, loading, busy, onRefresh, onRevoke }: PairedDevicesPanelProps) {
  return (
    <section className="devices-panel" aria-labelledby="devices-heading">
      <div className="devices-heading-row">
        <div>
          <div className="section-kicker">访问管理</div>
          <h2 id="devices-heading">已连接的手机</h2>
        </div>
        <button className="text-button" type="button" disabled={loading || busy} onClick={onRefresh}>刷新</button>
      </div>
      {loading && <p className="loading-line" role="status">正在读取已授权设备…</p>}
      {!loading && devices.length === 0 && <p className="empty-inline">还没有获授权的手机。</p>}
      {devices.length > 0 && (
        <ul className="device-list">
          {devices.map((device) => (
            <li className="device-row" key={device.deviceId}>
              <div className="device-avatar" aria-hidden="true">手机</div>
              <div className="device-copy">
                <strong>{device.label || "已授权手机"}</strong>
                <span>连接于 {formatDate(device.createdAt)}</span>
                <span>{device.lastSeenAt ? `最近活动 ${formatDate(device.lastSeenAt)}` : "尚无活动记录"}</span>
              </div>
              <button className="button button-danger-outline" type="button" disabled={busy} onClick={() => onRevoke(device)}>撤销连接</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
