import { useEffect, useState } from "react";
import type { WindowTarget } from "../types";
import type { WindowCandidatePreview } from "../types";

export interface WindowTargetPickerProps {
  candidates: WindowTarget[];
  expiresAt?: string;
  omittedAmbiguousCount?: number;
  selectionNeedsConfirmation?: boolean;
  loading: boolean;
  expired?: boolean;
  disabled?: boolean;
  selectedToken?: string;
  selectedPreviewToken?: string;
  previews?: ReadonlyMap<string, WindowCandidatePreview>;
  previewLoadingToken?: string;
  previewErrors?: ReadonlyMap<string, string>;
  error?: string;
  onSelect: (token: string, previewToken?: string) => void;
  onPreview?: (token: string) => void;
  onRefresh: () => void;
}

export function WindowTargetPicker({
  candidates,
  expiresAt,
  omittedAmbiguousCount = 0,
  selectionNeedsConfirmation = false,
  loading,
  expired = false,
  disabled = false,
  selectedToken,
  selectedPreviewToken,
  previews,
  previewLoadingToken,
  previewErrors,
  error,
  onSelect,
  onPreview,
  onRefresh,
}: WindowTargetPickerProps) {
  const [currentTime, setCurrentTime] = useState(Date.now());
  const [loadedPreviewTokens, setLoadedPreviewTokens] = useState<Set<string>>(() => new Set());
  const [previewDisplayErrors, setPreviewDisplayErrors] = useState<Map<string, string>>(() => new Map());
  useEffect(() => {
    const nextExpiry = [...(previews?.values() ?? [])]
      .map((preview) => Date.parse(preview.expiresAt))
      .filter((expiresAt) => Number.isFinite(expiresAt) && expiresAt > Date.now())
      .sort((left, right) => left - right)[0];
    if (nextExpiry === undefined) return;
    const timer = window.setTimeout(() => setCurrentTime(Date.now()), Math.max(1, nextExpiry - Date.now() + 1));
    return () => window.clearTimeout(timer);
  }, [previews, currentTime]);

  useEffect(() => {
    const currentTokens = new Set([...(previews?.values() ?? [])].map((preview) => preview.previewToken));
    setLoadedPreviewTokens((current) => {
      const next = new Set([...current].filter((token) => currentTokens.has(token)));
      return next.size === current.size ? current : next;
    });
    setPreviewDisplayErrors((current) => {
      const next = new Map([...current].filter(([token]) => currentTokens.has(token)));
      return next.size === current.size ? current : next;
    });
  }, [previews]);

  return (
    <section className="window-target-section" aria-labelledby="window-target-heading">
      <div className="window-target-heading-row">
        <div>
          <h2 id="window-target-heading">操作窗口</h2>
          <p className="window-target-help sr-only">开始前会再次核对所选窗口。</p>
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

      {!loading && !error && omittedAmbiguousCount > 0 && (
        <p className="field-hint window-target-message" role="status">
          有 {omittedAmbiguousCount} 个候选未显示。最近截图不能代替这些窗口的实时预览；若列表没有可辨认目标，请在电脑整理窗口后刷新。
        </p>
      )}
      {!loading && !error && candidates.some((candidate) => candidate.previewRequired) && (
        <p className="field-hint window-target-message" role="status">标签重复或不完整的候选不会直接选中。请查看对应的真实窗口截图；看不清或仍无法区分时不要确认，请在电脑恢复窗口后刷新。</p>
      )}

      {!loading && !error && selectionNeedsConfirmation && (
        <p className="field-hint window-target-message" role="status">任务目标已更改，请重新点选窗口以确认新的起始目标。</p>
      )}

      {!loading && !error && candidates.length > 0 && (
        <fieldset className="window-target-fieldset" disabled={disabled || expired}>
          <legend>可选窗口（{candidates.length}）</legend>
          <div className="window-target-list">
            {candidates.map((candidate, index) => {
              const preview = previews?.get(candidate.token);
              const previewValid = preview !== undefined && Date.parse(preview.expiresAt) > currentTime;
              const previewLoaded = preview !== undefined && loadedPreviewTokens.has(preview.previewToken);
              const previewDisplayError = preview === undefined ? undefined : previewDisplayErrors.get(preview.previewToken);
              const loadingPreview = previewLoadingToken === candidate.token;
              const row = (
                <>
                  {!candidate.previewRequired && (
                    <input
                      id={`window-target-${index}`}
                      type="radio"
                      name="window-target"
                      value={String(index)}
                      checked={selectedToken === candidate.token}
                      onChange={() => onSelect(candidate.token)}
                      aria-describedby={expiresAt ? "window-target-expiry" : undefined}
                      disabled={disabled || expired}
                    />
                  )}
                  <span className="window-target-copy">
                    <span className="window-target-app">{candidate.appName?.trim() || "未命名应用"}</span>
                    <span className="window-target-title">{candidate.title?.trim() || "未命名窗口"}</span>
                    {candidate.relationship && <span className="window-target-title">{windowRelationshipLabel(candidate.relationship)}</span>}
                  </span>
                  {candidate.previewRequired && (
                    <span className="window-target-preview-controls">
                      <button className="button button-secondary" type="button" disabled={disabled || expired || loadingPreview || previewLoadingToken !== undefined} onClick={() => onPreview?.(candidate.token)}>
                        {loadingPreview ? "正在读取此窗口…" : preview === undefined ? "查看此窗口预览" : "重新读取预览"}
                      </button>
                      {loadingPreview && <span className="field-hint" role="status">正在从电脑读取这个精确窗口，不会激活或操作它。</span>}
                      {previewErrors?.get(candidate.token) && <span className="notice notice-warning" role="alert">{previewErrors.get(candidate.token)}</span>}
                      {preview && (
                        <span className="window-candidate-preview">
                          <span className="window-target-app">捕获时应用：{preview.appName?.trim() || "应用名不可用"}</span>
                          <span className="window-target-title">捕获时标题：{preview.title?.trim() || "窗口标题不可用"} · {formatCapturedAt(preview.capturedAt)}</span>
                          <span className="window-target-title">{preview.relationship ? windowRelationshipLabel(preview.relationship) : "捕获时关系未验证"}</span>
                          <img
                            src={`data:image/png;base64,${preview.dataBase64}`}
                            alt={`${preview.appName ?? "未知应用"}：${preview.title ?? "未知窗口"} 的实时窗口预览`}
                            onLoad={() => setLoadedPreviewTokens((current) => new Set(current).add(preview.previewToken))}
                            onError={() => {
                              setLoadedPreviewTokens((current) => {
                                const next = new Set(current);
                                next.delete(preview.previewToken);
                                return next;
                              });
                              setPreviewDisplayErrors((current) => new Map(current).set(preview.previewToken, "这张实时截图无法显示。请在电脑恢复目标窗口后刷新；仍看不清时不要选择。"));
                            }}
                          />
                          {previewDisplayError && <span className="notice notice-warning" role="alert">{previewDisplayError}</span>}
                          {previewValid && previewLoaded && previewDisplayError === undefined
                            ? <button className="button button-primary" type="button" disabled={disabled || expired} onClick={() => onSelect(candidate.token, preview.previewToken)}>
                              确认这是目标窗口
                            </button>
                            : previewValid
                              ? <span className="field-hint" role="status">截图成功显示后才能确认。画面不清楚或仍无法区分时请勿选择，并在电脑恢复窗口后刷新。</span>
                              : <span className="field-hint" role="status">此预览确认已过期。重新读取当前窗口后才能选择。</span>}
                        </span>
                      )}
                      {selectedToken === candidate.token && selectedPreviewToken === preview?.previewToken && previewValid && <span className="field-hint" role="status">已确认这个窗口作为任务起点。</span>}
                    </span>
                  )}
                </>
              );
              return candidate.previewRequired
                ? <div className="window-target-option window-target-preview-option" key={candidate.token}>{row}</div>
                : <label className="window-target-option" htmlFor={`window-target-${index}`} key={candidate.token}>{row}</label>;
            })}
          </div>
        </fieldset>
      )}

      {expiresAt && !expired && !error && (
        <p id="window-target-expiry" className="window-target-expiry sr-only" role="status">
          此窗口列表有效至 {formatExpiry(expiresAt)}。刷新后需要重新选择。
        </p>
      )}
    </section>
  );
}

function windowRelationshipLabel(relationship: NonNullable<WindowTarget["relationship"]>): string {
  if (relationship.kind === "scoped_peer") return "电脑已授权的另一窗口";
  const role = relationship.rootRole === "menu" ? "菜单" : relationship.rootRole === "dialog" ? "对话框" : relationship.rootRole === "popup" ? "弹出窗口" : "所属子窗口";
  const parent = [relationship.parentAppName, relationship.parentTitle].filter((value) => value?.trim()).join(" · ");
  return parent ? `属于 ${parent} 的${role}` : role;
}

function formatCapturedAt(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? `电脑读取于 ${new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date)}`
    : "读取时间未知";
}

function formatExpiry(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "短期有效";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);
}
