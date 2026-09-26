import { runAssetUrl } from "../api";

interface ScreenshotPanelProps {
  runId: string;
  assetId?: string;
}

export function ScreenshotPanel({ runId, assetId }: ScreenshotPanelProps) {
  return (
    <section className="screenshot-panel" aria-labelledby="screen-heading">
      <div className="section-kicker">电脑当前画面</div>
      <h2 id="screen-heading">最近一次截图</h2>
      {assetId ? (
        <a className="screenshot-link" href={runAssetUrl(runId, assetId)} target="_blank" rel="noreferrer">
          <img src={runAssetUrl(runId, assetId)} alt="电脑最近一次观察到的桌面画面；打开图片可查看大图。" referrerPolicy="no-referrer" />
          <span>打开大图</span>
        </a>
      ) : (
        <p className="empty-inline">电脑尚未提供可显示的截图。</p>
      )}
      <p className="field-hint">截图由电脑按任务状态更新，不是实时视频。</p>
    </section>
  );
}
