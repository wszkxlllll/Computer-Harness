import { useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { runAssetUrl } from "../api";
import type { ApprovalEvidence } from "../types";
import { ScreenshotViewer } from "./ScreenshotViewer";

interface ApprovalEvidencePanelProps {
  runId: string;
  requestId: string;
  evidence: ApprovalEvidence;
  latestAssetId?: string;
  onImageAvailabilityChange: (requestId: string, assetId: string, loaded: boolean) => void;
  onViewerOpened: (requestId: string) => void;
  onViewerClosed: (requestId: string, imageLoaded: boolean) => void;
}

export function ApprovalEvidencePanel({
  runId,
  requestId,
  evidence,
  latestAssetId,
  onImageAvailabilityChange,
  onViewerOpened,
  onViewerClosed,
}: ApprovalEvidencePanelProps) {
  const [openAssetId, setOpenAssetId] = useState<string>();
  const [openedRequestId, setOpenedRequestId] = useState<string>();
  const [openedIdentity, setOpenedIdentity] = useState<string>();
  const [openedCapturedAt, setOpenedCapturedAt] = useState<string>();
  const [loadedIdentity, setLoadedIdentity] = useState<string>();
  const [failedIdentity, setFailedIdentity] = useState<string>();
  const [retry, setRetry] = useState(0);
  const returnFocusRef = useRef<HTMLElement | undefined>(undefined);
  const identity = `${requestId}:${evidence.assetId}`;
  const validAsset = typeof evidence.assetId === "string" && evidence.assetId.trim().length > 0;
  const imageLoaded = loadedIdentity === identity;
  const thumbnailFailed = failedIdentity === identity;
  const capturedAt = typeof evidence.capturedAt === "string" && Number.isFinite(Date.parse(evidence.capturedAt))
    ? new Date(evidence.capturedAt).toLocaleString()
    : "采集时间不可用";
  const viewportValid = Number.isFinite(evidence.viewport?.width) && evidence.viewport.width > 0
    && Number.isFinite(evidence.viewport?.height) && evidence.viewport.height > 0;

  function openViewer(event: ReactMouseEvent<HTMLButtonElement>) {
    if (!validAsset) return;
    returnFocusRef.current = event.currentTarget;
    setOpenAssetId(evidence.assetId);
    setOpenedRequestId(requestId);
    setOpenedIdentity(identity);
    setOpenedCapturedAt(capturedAt);
    onViewerOpened(requestId);
  }

  function closeViewer(viewerImageLoaded: boolean) {
    const stillCurrent = openedIdentity === identity && openedRequestId === requestId;
    onViewerClosed(openedRequestId ?? requestId, viewerImageLoaded && stillCurrent);
    setOpenAssetId(undefined);
  }

  function handleLoaded() {
    setFailedIdentity(undefined);
    setLoadedIdentity(identity);
    onImageAvailabilityChange(requestId, evidence.assetId, true);
  }

  function handleFailed() {
    setFailedIdentity(identity);
    setLoadedIdentity(undefined);
    onImageAvailabilityChange(requestId, evidence.assetId, false);
  }

  return (
    <section className="approval-evidence" aria-labelledby="approval-evidence-title">
      <h3 id="approval-evidence-title">请求截图</h3>
      <p className="approval-preview-note">采集于请求提出前，不是实时画面。</p>
      {validAsset ? (
        <>
          <button className="approval-evidence-open" type="button" onClick={openViewer}>
            {thumbnailFailed ? (
              <span className="approval-evidence-thumbnail-error">绑定画面无法载入</span>
            ) : (
              <img
                key={`${identity}:${retry}`}
                src={runAssetUrl(runId, evidence.assetId)}
                alt="本次确认请求绑定的电脑画面。请在页面上视觉核对目标。"
                referrerPolicy="no-referrer"
                onLoad={handleLoaded}
                onError={handleFailed}
              />
            )}
            <span>{thumbnailFailed ? "打开原图重试" : "放大查看"}</span>
          </button>
          {thumbnailFailed && (
            <button className="text-button" type="button" onClick={() => { setFailedIdentity(undefined); setRetry((value) => value + 1); }}>
              重新载入绑定画面
            </button>
          )}
          <details className="approval-evidence-details">
            <summary>截图与坐标信息</summary>
            <dl className="approval-evidence-meta">
              <div><dt>采集时间</dt><dd><time dateTime={typeof evidence.capturedAt === "string" ? evidence.capturedAt : undefined}>{capturedAt}</time></dd></div>
              {viewportValid && <div><dt>画面尺寸</dt><dd>{evidence.viewport.width} × {evidence.viewport.height}（{coordinateSpaceText(evidence.viewport.coordinateSpace)}）</dd></div>}
              <div><dt>截图用途</dt><dd>绑定当前确认请求；不是实时图像。</dd></div>
            </dl>
            <p className="approval-preview-note">操作坐标按请求参数原样列出，没有叠加到截图；系统未证明坐标与此画面来自同一帧。</p>
          </details>
          <p className="approval-review-help">请核对目标和画面。键盘操作请看图确认焦点（电脑无法证明机器焦点）；读屏无法读取截图，无法视觉核对时请拒绝或在电脑端检查。</p>
          <p className={imageLoaded ? "approval-evidence-available" : "approval-evidence-unavailable"} role="status" aria-live="polite">
            {imageLoaded
              ? "截图已载入。"
              : "截图载入后才可允许操作。"}
          </p>
          {openAssetId && (
            <ScreenshotViewer
              runId={runId}
              assetId={openAssetId}
              title="本次请求绑定的电脑画面"
              alt={`电脑在提出${openedRequestId === requestId ? "当前" : "打开时的"}确认请求前的画面，采集于${openedCapturedAt ?? "采集时间不可用"}。`}
              newerAssetId={latestAssetId}
              notice={openedRequestId !== requestId || openedIdentity !== identity
                ? "确认请求已变化；此处仍显示打开时的截图。关闭后将重新读取状态。"
                : undefined}
              returnFocusElement={returnFocusRef.current}
              onClose={closeViewer}
            />
          )}
        </>
      ) : (
        <p className="notice notice-error" role="alert">电脑没有提供可用的请求绑定画面，因此暂时不能批准这项电脑操作。</p>
      )}
    </section>
  );
}

function coordinateSpaceText(space: ApprovalEvidence["viewport"]["coordinateSpace"]): string {
  if (space === "physical") return "物理像素";
  if (space === "logical") return "逻辑像素";
  return "参考坐标";
}
