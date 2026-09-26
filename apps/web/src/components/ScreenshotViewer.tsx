import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { runAssetUrl } from "../api";

interface ScreenshotViewerProps {
  runId: string;
  assetId: string;
  title: string;
  alt: string;
  newerAssetId?: string;
  notice?: string;
  returnFocusElement?: HTMLElement;
  onClose: (imageLoaded: boolean) => void;
}

interface Point {
  x: number;
  y: number;
}

const MIN_SCALE = 0.5;
const MAX_SCALE = 5;

export function ScreenshotViewer({ runId, assetId, title, alt, newerAssetId, notice, returnFocusElement, onClose }: ScreenshotViewerProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const imageLoadedRef = useRef(false);
  const pointers = useRef(new Map<number, Point>());
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => { imageLoadedRef.current = imageLoaded; }, [imageLoaded]);

  useEffect(() => {
    const returnFocus = returnFocusElement ?? (document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
    const bodyOverflow = document.body.style.overflow;
    const inerted: Array<{ element: HTMLElement; wasInert: boolean }> = [];
    let branch: HTMLElement | null = backdropRef.current;
    while (branch?.parentElement) {
      const parent = branch.parentElement;
      for (const child of Array.from(parent.children)) {
        if (!(child instanceof HTMLElement) || child === branch) continue;
        inerted.push({ element: child, wasInert: child.inert });
        child.inert = true;
      }
      if (parent === document.body) break;
      branch = parent;
    }
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current(imageLoadedRef.current);
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = bodyOverflow;
      for (const item of inerted) item.element.inert = item.wasInert;
      if (returnFocus?.isConnected) returnFocus.focus();
      else document.querySelector<HTMLElement>("#run-goal")?.focus();
    };
  }, []);

  function close() {
    onCloseRef.current(imageLoaded);
  }

  function scaleBy(factor: number) {
    setScale((current) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, current * factor)));
  }

  function pointFromEvent(event: ReactPointerEvent<HTMLDivElement>): Point {
    return { x: event.clientX, y: event.clientY };
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, pointFromEvent(event));
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    const next = pointFromEvent(event);
    const otherPoints = [...pointers.current.entries()].filter(([id]) => id !== event.pointerId).map(([, point]) => point);
    if (otherPoints.length > 0) {
      const other = otherPoints[0];
      const oldDistance = Math.hypot(previous.x - other.x, previous.y - other.y);
      const newDistance = Math.hypot(next.x - other.x, next.y - other.y);
      if (oldDistance > 0) scaleBy(newDistance / oldDistance);
    } else {
      setOffset((current) => ({ x: current.x + next.x - previous.x, y: current.y + next.y - previous.y }));
    }
    pointers.current.set(event.pointerId, next);
  }

  function onPointerEnd(event: ReactPointerEvent<HTMLDivElement>) {
    pointers.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function onWheel(event: ReactWheelEvent<HTMLDivElement>) {
    event.preventDefault();
    scaleBy(event.deltaY < 0 ? 1.12 : 0.89);
  }

  function pan(dx: number, dy: number) {
    setOffset((current) => ({ x: current.x + dx, y: current.y + dy }));
  }

  function fit() {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }

  return (
    <div ref={backdropRef} className="screenshot-viewer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section
        ref={dialogRef}
        className="screenshot-viewer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="screenshot-viewer-title"
        tabIndex={-1}
      >
        <div className="screenshot-viewer-header">
          <div>
            <h2 id="screenshot-viewer-title">{title}</h2>
            <p>截图来自电脑最近一次观察，不是实时画面。</p>
          </div>
          <button className="button button-secondary" type="button" ref={closeButtonRef} onClick={close}>关闭</button>
        </div>

        {newerAssetId && newerAssetId !== assetId && (
          <p className="notice notice-info viewer-new-image" role="status" aria-live="polite">有更新截图；当前画面保持不变。关闭后可查看新图。</p>
        )}
        {notice && <p className="notice notice-warning viewer-notice">{notice}</p>}

        <div
          className="screenshot-viewer-stage"
          aria-label="截图画面。可拖动平移，也可双指缩放。"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onWheel={onWheel}
        >
          {!imageLoaded && !imageFailed && <p className="viewer-image-status" role="status">正在载入截图…</p>}
          {imageFailed ? (
            <p className="notice notice-error viewer-image-error" role="alert">无法载入这张截图。可能已过期或当前连接无权查看；无法据此核对画面。</p>
          ) : (
            <img
              className={`screenshot-viewer-image${imageLoaded ? " is-loaded" : ""}`}
              src={runAssetUrl(runId, assetId)}
              alt={alt}
              draggable={false}
              referrerPolicy="no-referrer"
              onLoad={() => { imageLoadedRef.current = true; setImageLoaded(true); }}
              onError={() => { imageLoadedRef.current = false; setImageLoaded(false); setImageFailed(true); }}
              style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
            />
          )}
        </div>

        <div className="screenshot-viewer-controls" aria-label="截图缩放和平移控制">
          <button className="button button-secondary" type="button" onClick={() => scaleBy(1 / 1.25)} aria-label="缩小截图">−</button>
          <span className="viewer-zoom-level" role="status" aria-live="polite">{Math.round(scale * 100)}%</span>
          <button className="button button-secondary" type="button" onClick={() => scaleBy(1.25)} aria-label="放大截图">＋</button>
          <button className="button button-secondary viewer-fit-button" type="button" onClick={fit}>适合屏幕</button>
          <div className="viewer-pan-controls" role="group" aria-label="平移截图">
            <button className="button button-secondary" type="button" onClick={() => pan(0, 48)} aria-label="向上平移截图">↑</button>
            <button className="button button-secondary" type="button" onClick={() => pan(0, -48)} aria-label="向下平移截图">↓</button>
            <button className="button button-secondary" type="button" onClick={() => pan(48, 0)} aria-label="向左平移截图">←</button>
            <button className="button button-secondary" type="button" onClick={() => pan(-48, 0)} aria-label="向右平移截图">→</button>
          </div>
        </div>
      </section>
    </div>
  );
}
