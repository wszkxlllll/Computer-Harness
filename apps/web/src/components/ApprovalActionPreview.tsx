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
  wait: "等待",
};

export function ApprovalActionPreview({ preview }: ApprovalActionPreviewProps) {
  const allActions = Array.isArray(preview.actions) ? preview.actions.filter((action) => action && typeof action === "object") : [];
  const actions = allActions.slice(0, 12);
  const effect = preview.modelDeclaredEffect;
  const modelTarget = typeof effect?.target === "string" ? effect.target.trim() : "";
  const modelSummary = typeof effect?.summary === "string" ? effect.summary.trim() : "";
  const hasModelEffect = Boolean(modelTarget || modelSummary);

  return (
    <div className="approval-preview-content">
      {actions.length > 0 ? (
        <section className="approval-action-preview" aria-labelledby="approval-action-preview-title">
          <h3 id="approval-action-preview-title">待确认的操作</h3>
          <p className="approval-preview-note">以下是本次请求的操作参数；位置和按键不代表目标内容已验证。</p>
          <ol className="approval-action-list">
            {actions.map((action, index) => <ActionPreviewItem key={`${action.operation}-${index}`} action={action} />)}
          </ol>
          {allActions.length > actions.length && (
            <p className="approval-preview-note">其余操作未在此处展开。</p>
          )}
        </section>
      ) : (
        <p className="notice notice-warning approval-preview-fallback" role="note">
          电脑未提供具体操作预览。请核对电脑当前画面；如果无法确认，请选择拒绝。
        </p>
      )}

      {hasModelEffect && (
        <section className="approval-model-effect" aria-labelledby="approval-model-effect-title">
          <h3 id="approval-model-effect-title">模型说明（未经验证）</h3>
          {modelTarget && <p><strong>模型声明的目标：</strong>{modelTarget}</p>}
          {modelSummary && <p><strong>模型给出的摘要：</strong>{modelSummary}</p>}
          <p className="approval-preview-note">目标和摘要由模型提出，未由电脑核实。</p>
        </section>
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
              <dt>位置（待核对）</dt>
              <dd>{points.map((point) => `(${point.x}, ${point.y})`).join(" · ")}</dd>
            </div>
          )}
          {keys.length > 0 && (
            <div>
              <dt>按键（待确认）</dt>
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
