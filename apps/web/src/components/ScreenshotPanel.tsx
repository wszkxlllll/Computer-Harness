import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { runAssetUrl } from "../api";
import { ScreenshotViewer } from "./ScreenshotViewer";

interface ScreenshotPanelProps {
  runId: string;
  assetId?: string;
  requestId?: string;
  onViewerOpened: (requestId?: string) => void;
  onViewerClosed: (requestId?: string, evidenceReviewed?: boolean) => void;
}

export function ScreenshotPanel({ runId, assetId, requestId, onViewerOpened, onViewerClosed }: ScreenshotPanelProps) {
  const [openAssetId, setOpenAssetId] = useState<string>();
  const [openedRequestId, setOpenedRequestId] = useState<string>();
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const returnFocusRef = useRef<HTMLElement | undefined>(undefined);

  useEffect(() => setThumbnailFailed(false), [assetId]);

  function openViewer(event: ReactMouseEvent<HTMLButtonElement>) {
    if (!assetId) return;
    returnFocusRef.current = event.currentTarget;
    setOpenAssetId(assetId);
    setOpenedRequestId(requestId);
    onViewerOpened(requestId);
  }

  function closeViewer() {
    onViewerClosed(openedRequestId, false);
    setOpenAssetId(undefined);
  }

  return (
    <section className="screenshot-panel" aria-labelledby="screen-heading">
      <div className="section-kicker">电脑画面</div>
      <h2 id="screen-heading">最近一次截图</h2>
      {assetId ? (
        <>
          {thumbnailFailed ? (
            <p className="notice notice-warning" role="status">无法载入最近截图。任务仍可查看，但不能用这张缩略图核对画面。</p>
          ) : (
            <button className="screenshot-open-button" type="button" onClick={openViewer}>
              <img src={runAssetUrl(runId, assetId)} alt="最近一次观察到的电脑画面缩略图" referrerPolicy="no-referrer" onError={() => setThumbnailFailed(true)} />
              <span>全屏查看截图</span>
            </button>
          )}
          {thumbnailFailed && <button className="button button-secondary" type="button" onClick={openViewer}>重试查看截图</button>}
        </>
      ) : (
        <p className="empty-inline">电脑尚未提供可显示的截图。</p>
      )}
      <p className="field-hint">这是最近一次观察，不是实时画面，也不一定与当前确认请求绑定。</p>
      {openAssetId && (
        <ScreenshotViewer
          runId={runId}
          assetId={openAssetId}
          title="最近一次观察到的电脑画面"
          alt="电脑最近一次观察到的桌面画面；不是实时画面，也不一定与当前确认请求绑定。"
          newerAssetId={assetId}
          notice={openedRequestId !== requestId ? "当前确认请求状态已变化。截图仍固定显示打开时的画面；关闭后会重新读取任务状态。" : undefined}
          returnFocusElement={returnFocusRef.current}
          onClose={closeViewer}
        />
      )}
    </section>
  );
}
