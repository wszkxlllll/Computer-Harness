import type { WindowTarget } from "../types";

export interface WindowTargetPickerProps {
  candidates: WindowTarget[];
  expiresAt?: string;
  loading: boolean;
  expired?: boolean;
  disabled?: boolean;
  selectedToken?: string;
  error?: string;
  onSelect: (token: string) => void;
  onRefresh: () => void;
}

export function WindowTargetPicker({
  candidates,
  expiresAt,
  loading,
  expired = false,
  disabled = false,
  selectedToken,
  error,
  onSelect,
  onRefresh,
}: WindowTargetPickerProps) {
  return (
    <section className="window-target-section" aria-labelledby="window-target-heading">
      <div className="window-target-heading-row">
        <div>
          <h2 id="window-target-heading">选择运行窗口</h2>
          <p className="window-target-help">电脑会在开始前再次核对这个窗口；不会自动选择其他窗口。</p>
        </div>
        <button className="button button-secondary" type="button" disabled={disabled || loading} onClick={onRefresh}>
          {loading ? "正在刷新…" : "刷新窗口列表"}
        </button>
      </div>

      {error && <p className="notice notice-warning window-target-message" role="alert">{error}</p>}
      {loading && <p className="loading-line window-target-message" role="status">正在读取电脑上可用的窗口…</p>}
      {!loading && !error && candidates.length === 0 && (
        <p className="empty-inline window-target-message" role="status">没有可选窗口。请先在电脑上打开要使用的应用，再刷新列表。</p>
      )}

      {!loading && !error && candidates.length > 0 && (
        <fieldset className="window-target-fieldset" disabled={disabled || expired}>
          <legend>可用窗口（{candidates.length}）</legend>
          <div className="window-target-list">
            {candidates.map((candidate, index) => (
              <label className="window-target-option" htmlFor={`window-target-${index}`} key={candidate.token}>
                <input
                  id={`window-target-${index}`}
                  type="radio"
                  name="window-target"
                  value={String(index)}
                  checked={selectedToken === candidate.token}
                  onChange={() => onSelect(candidate.token)}
                  aria-describedby={expiresAt ? "window-target-expiry" : undefined}
                />
                <span className="window-target-copy">
                  <span className="window-target-app">{candidate.appName?.trim() || "未命名应用"}</span>
                  <span className="window-target-title">{candidate.title?.trim() || "未命名窗口"}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {expiresAt && !expired && !error && (
        <p id="window-target-expiry" className="window-target-expiry" role="status">
          此窗口列表有效至 {formatExpiry(expiresAt)}。刷新后需要重新选择。
        </p>
      )}
    </section>
  );
}

function formatExpiry(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "短期有效";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);
}
