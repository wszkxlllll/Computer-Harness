import type { ApprovalActionPreview as ApprovalActionPreviewData, ApprovalActionPreviewItem } from "../types";

interface ApprovalActionPreviewProps {
  preview: ApprovalActionPreviewData;
}

const actionLabels: Record<string, string> = {
  click: "点击",
  double_click: "双击",
  right_click: "右键点击",
  type: "输入文本",
  keypress: "键盘操作",
  scroll: "滚动",
  switch_window: "切换窗口",
  wait: "等待",
};

export function ApprovalActionPreview({ preview }: ApprovalActionPreviewProps) {
  const allActions = Array.isArray(preview.actions) ? preview.actions.filter((action) => action && typeof action === "object") : [];
  const actions = allActions.slice(0, 16);
  const effect = preview.modelDeclaredEffect;
  const modelTarget = typeof effect?.target === "string" ? effect.target.trim() : "";
  const modelSummary = typeof effect?.summary === "string" ? effect.summary.trim() : "";
  const hasModelEffect = Boolean(modelTarget || modelSummary);

  return (
    <div className="approval-preview-content">
      {actions.length > 0 ? (
        <section className="approval-action-preview" aria-labelledby="approval-action-preview-title">
          <h3 id="approval-action-preview-title">待批准操作 · {allActions.length} 项</h3>
          <ul className="approval-action-summary" aria-label="操作内容">
            {actions.map((action, index) => <li key={`summary-${action.operation}-${index}`}>{actionSummary(action)}</li>)}
            {allActions.length > actions.length && <li>另有 {allActions.length - actions.length} 项，详见操作参数</li>}
          </ul>
        </section>
      ) : (
        <p className="notice notice-warning approval-preview-fallback" role="note">
          电脑未提供具体操作预览。请核对电脑当前画面；如果无法确认，请选择拒绝。
        </p>
      )}

      {preview.selectedWindowLabel && (
        <section className="approval-model-effect" aria-labelledby="approval-window-target-title">
          <h3 id="approval-window-target-title">窗口目标核对信息（主机清单）</h3>
          {preview.selectedWindowLabel.status === "matched" ? (
            <p>{[preview.selectedWindowLabel.appName, preview.selectedWindowLabel.title].filter((value) => value?.trim()).join(" · ") || "清单未提供可读名称。"}</p>
          ) : (
            <p>无法将目标与最近的主机窗口清单匹配；请求绑定截图可能仍显示原窗口。无法核验目标时请拒绝。</p>
          )}
          <p className="approval-preview-note">名称是选择时的主机清单记录，可能已变化或含不可信文本；请求绑定截图可能仍显示原窗口，并非目标窗口的实时画面。请先核验目标，不能确认时拒绝。</p>
        </section>
      )}

      {hasModelEffect && (
        <section className="approval-model-effect" aria-labelledby="approval-model-effect-title">
          <h3 id="approval-model-effect-title">模型说明（未经验证）</h3>
          {modelTarget && <p>{modelTarget}</p>}
          {modelSummary && <p>{modelSummary}</p>}
        </section>
      )}
    </div>
  );
}

export function ApprovalActionParameters({ preview }: ApprovalActionPreviewProps) {
  const allActions = Array.isArray(preview.actions) ? preview.actions.filter((action) => action && typeof action === "object") : [];
  const actions = allActions.slice(0, 16);
  if (actions.length === 0) return null;

  return (
    <div className="approval-action-parameters">
      <p className="approval-preview-note">这些是电脑请求执行的参数，不是已执行结果。位置和按键不证明目标内容或机器焦点。</p>
      <ol className="approval-action-list">
        {actions.map((action, index) => <ActionPreviewItem key={`${action.operation}-${index}`} action={action} />)}
      </ol>
      {allActions.length > actions.length && (
        <p className="approval-preview-note">另有 {allActions.length - actions.length} 项操作未在当前预览中展示。</p>
      )}
    </div>
  );
}

function ActionPreviewItem({ action }: { action: ApprovalActionPreviewItem }) {
  const points = (Array.isArray(action.points) ? action.points : [])
    .slice(0, 8)
    .filter((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y));
  const keys = (Array.isArray(action.keys) ? action.keys : [])
    .slice(0, 8)
    .filter((key) => typeof key === "string" && key.length > 0);
  const count = typeof action.typedCharacterCount === "number" && Number.isFinite(action.typedCharacterCount) && action.typedCharacterCount >= 0
    ? Math.floor(action.typedCharacterCount)
    : undefined;

  return (
    <li className="approval-action-item">
      <div className="approval-action-heading">
        <strong>{actionLabels[action.kind] ?? "电脑操作"}</strong>
        <code>{typeof action.operation === "string" ? action.operation.slice(0, 64) : "操作"}</code>
      </div>
      {(points.length > 0 || keys.length > 0 || count !== undefined) && (
        <dl className="approval-action-details">
          {points.length > 0 && (
            <div>
          <dt>位置（请求参数）</dt>
              <dd>{points.map((point) => `(${point.x}, ${point.y})`).join(" · ")}</dd>
            </div>
          )}
          {keys.length > 0 && (
            <div>
            <dt>按键（请求参数）</dt>
              <dd>{keys.map((key) => key.slice(0, 32)).join(" + ")}</dd>
            </div>
          )}
          {count !== undefined && (
            <div>
              <dt>拟输入</dt>
              <dd>{new Intl.NumberFormat("zh-CN").format(count)} 个字符（内容不显示）</dd>
            </div>
          )}
        </dl>
      )}
    </li>
  );
}

function actionSummary(action: ApprovalActionPreviewItem): string {
  if (action.kind === "type") {
    const count = action.typedCharacterCount;
    return typeof count === "number" && Number.isFinite(count) && count >= 0
      ? `输入 ${new Intl.NumberFormat("zh-CN").format(Math.floor(count))} 字`
      : "输入文本";
  }
  if (action.kind === "keypress") {
    const keys = (Array.isArray(action.keys) ? action.keys : [])
      .filter((key) => typeof key === "string" && key.length > 0)
      .slice(0, 8)
      .map((key) => displayKey(key));
    return keys.length > 0 ? `按 ${keys.join(" + ")}` : "键盘操作";
  }
  return actionLabels[action.kind] ?? "电脑操作";
}

function displayKey(key: string): string {
  const names: Record<string, string> = {
    ALT: "Alt",
    BACKSPACE: "Backspace",
    CTRL: "Ctrl",
    DELETE: "Delete",
    DOWN: "向下键",
    ENTER: "Enter",
    ESC: "Esc",
    LEFT: "向左键",
    META: "Meta",
    RIGHT: "向右键",
    SHIFT: "Shift",
    SPACE: "空格",
    TAB: "Tab",
    UP: "向上键",
  };
  return names[key.toUpperCase()] ?? key.slice(0, 32);
}
