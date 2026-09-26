import { useEffect, useState } from "react";
import { ApiError, setPhoneCsrfToken } from "./api";
import { BrandHeader } from "./components/BrandHeader";
import { clearInitialPairingToken, getInitialPairingToken } from "./pairing-token";
import { shouldEstablishSession } from "./pairing-state";
import { clearPairRequestReference, establishPairSessionOnce, getPairRequestOnce, getPendingPairSession, getPhoneSessionOnce, hasEstablishedPairSession, readStoredRequestId, storeRequestId, submitTokenOnce } from "./pairing-session";
import type { PairRequestStatus } from "./types";

export function PairingScreen() {
  const [activeToken, setActiveToken] = useState(() => getInitialPairingToken());
  const [requestId, setRequestId] = useState(() => activeToken ? undefined : readStoredRequestId());
  const [hasPairingContext] = useState(() => Boolean(activeToken || requestId));
  const [pairState, setPairState] = useState<PairRequestStatus["status"] | "starting" | "checking" | "connected" | "error">(requestId ? "pending_local_confirmation" : activeToken ? "starting" : "checking");
  const [message, setMessage] = useState<string>();

  useEffect(() => {
    if (!activeToken || requestId) return;
    let cancelled = false;
    void submitTokenOnce(activeToken).then((result) => {
      clearInitialPairingToken();
      if (cancelled) return;
      setRequestId(result.requestId);
      setPairState(result.status);
      storeRequestId(result.requestId);
      setActiveToken(undefined);
      const safeUrl = `/pair?request=${encodeURIComponent(result.requestId)}`;
      window.history.replaceState(null, "", safeUrl);
    }).catch((caught: unknown) => {
      clearInitialPairingToken();
      if (cancelled) return;
      setActiveToken(undefined);
      setPairState("error");
      setMessage(caught instanceof ApiError && (caught.status === 404 || caught.code === "invalid_or_expired_pairing_token" || caught.code === "PAIRING_TOKEN_INVALID")
        ? "这个二维码已过期或已使用。请让电脑生成一张新的二维码。"
        : caught instanceof Error ? caught.message : "无法发起配对，请确认网络后重新扫描电脑上的二维码。");
    });
    return () => { cancelled = true; };
  }, [activeToken, requestId]);

  useEffect(() => {
    if (hasPairingContext || activeToken || requestId) return;
    let cancelled = false;
    void getPhoneSessionOnce().then((session) => {
      if (cancelled) return;
      setPhoneCsrfToken(session.csrfToken);
      setPairState("connected");
    }).catch((caught: unknown) => {
      if (cancelled) return;
      setPhoneCsrfToken(undefined);
      setPairState("error");
      setMessage(caught instanceof ApiError && caught.status === 401
        ? "请扫描电脑生成的配对二维码，以连接手机。"
        : caught instanceof Error ? caught.message : "暂时无法确认手机连接状态。请检查网络后重试。");
    });
    return () => { cancelled = true; };
  }, [activeToken, hasPairingContext, requestId]);

  useEffect(() => {
    if (!requestId) return;
    const currentRequestId = requestId;
    let stopped = false;
    let terminal = false;
    let pollTimer: number | undefined;
    let polling = false;

    async function completePendingSession(): Promise<boolean> {
      if (hasEstablishedPairSession(currentRequestId)) {
        if (stopped) return true;
        terminal = true;
        setPairState("connected");
        return true;
      }
      const pendingSession = getPendingPairSession(currentRequestId);
      if (!pendingSession) return false;
      try {
        await pendingSession;
      } catch {
        return false;
      }
      if (stopped) return true;
      terminal = true;
      setPairState("connected");
      return true;
    }

    async function poll() {
      if (stopped || terminal || polling) return;
      polling = true;
      try {
        if (await completePendingSession()) return;
        if (stopped) return;
        const current = await getPairRequestOnce(currentRequestId);
        if (stopped) return;
        setPairState(current.status);
        if (current.status === "rejected" || current.status === "expired") {
          terminal = true;
          clearPairRequestReference(currentRequestId);
          return;
        }
        if (shouldEstablishSession(current.status)) {
          try {
            await establishPairSessionOnce(currentRequestId);
            if (stopped) return;
            terminal = true;
            setPairState("connected");
          } catch (caught) {
            if (!(caught instanceof ApiError && caught.status === 409) && !stopped) {
              setMessage(caught instanceof Error ? caught.message : "配对已确认，但无法建立手机会话。");
            }
          }
        }
      } catch (caught) {
        if (stopped) return;
        if (caught instanceof ApiError && (caught.status === 404 || caught.status === 410 || caught.code === "PAIRING_REQUEST_EXPIRED")) {
          if (await completePendingSession()) return;
          if (stopped) return;
          terminal = true;
          clearPairRequestReference(currentRequestId);
          setPairState("expired");
          setMessage(caught.message);
          return;
        }
        setMessage(caught instanceof Error ? caught.message : "连接电脑时遇到问题，正在重试。");
      } finally {
        polling = false;
        if (!stopped && !terminal) pollTimer = window.setTimeout(() => void poll(), 1600);
      }
    }

    void poll();
    return () => {
      stopped = true;
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
    };
  }, [requestId]);

  const heading = pairState === "connected"
    ? "手机已连接"
    : pairState === "checking"
      ? "正在确认手机连接"
    : pairState === "rejected"
      ? "电脑没有授权这台手机"
      : pairState === "expired"
        ? "配对请求已过期"
        : pairState === "error"
          ? "无法连接这台电脑"
          : "等待电脑确认";

  return (
    <>
      <BrandHeader />
      <main className="page-shell narrow-page">
        <p className="eyebrow">连接 Harness</p>
        <h1 className="page-title">{heading}</h1>
        {pairState === "starting" && <div className="loading-panel" role="status">正在向电脑发送配对请求…</div>}
        {pairState === "checking" && <div className="loading-panel" role="status">正在确认手机连接状态…</div>}
        {pairState === "pending_local_confirmation" && (
          <div className="pair-state-box" role="status" aria-live="polite">
            <span className="pair-state-mark" aria-hidden="true">…</span>
            <p>配对请求已发送。请在电脑的“连接手机”页面确认。</p>
            <p className="field-hint">扫码本身不会授权控制电脑。确认后，手机会自动进入任务列表。</p>
            <p className="field-hint">如果扫码应用内的浏览器无法打开页面，请使用“在系统浏览器中打开”后重试。</p>
          </div>
        )}
        {pairState === "connected" && (
          <div className="pair-state-box pair-state-success" role="status">
            <span className="pair-state-mark" aria-hidden="true">✓</span>
            <p>这台手机已获授权，可以查看电脑任务并作出确认。</p>
            <a className="button button-primary button-large" href="/">打开任务列表</a>
          </div>
        )}
        {(pairState === "rejected" || pairState === "expired" || pairState === "error") && (
          <div className="notice notice-warning" role="alert">
            {message || (pairState === "rejected" ? "你可以重新扫描电脑生成的二维码，再次发起配对。" : "请返回电脑端生成新的配对二维码后重试。")}
          </div>
        )}
        {message && pairState === "pending_local_confirmation" && <p className="notice notice-warning" role="status">{message}</p>}
        <a className="text-button back-link" href="/">返回控制台</a>
      </main>
    </>
  );
}
