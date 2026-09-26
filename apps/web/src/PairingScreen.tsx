import { useEffect, useRef, useState } from "react";
import { ApiError, establishPairSession, getPairRequest, setPhoneCsrfToken, submitPairRequest } from "./api";
import { BrandHeader } from "./components/BrandHeader";
import { clearInitialPairingToken, getInitialPairingToken } from "./pairing-token";
import { shouldEstablishSession } from "./pairing-state";
import type { PairRequestStatus } from "./types";

const requestPromises = new Map<string, ReturnType<typeof submitPairRequest>>();

function submitTokenOnce(token: string) {
  const existing = requestPromises.get(token);
  if (existing) return existing;
  const pending = submitPairRequest(token, "手机浏览器").then((result) => {
    if (requestPromises.get(token) === pending) requestPromises.delete(token);
    return result;
  }).catch((error: unknown) => {
    if (requestPromises.get(token) === pending) requestPromises.delete(token);
    throw error;
  });
  requestPromises.set(token, pending);
  return pending;
}

export function PairingScreen() {
  const [activeToken, setActiveToken] = useState(() => getInitialPairingToken());
  const [requestId, setRequestId] = useState(() => activeToken ? undefined : readStoredRequestId());
  const [pairState, setPairState] = useState<PairRequestStatus["status"] | "starting" | "connected" | "error">(requestId ? "pending_local_confirmation" : activeToken ? "starting" : "error");
  const [message, setMessage] = useState<string>();
  const sessionPending = useRef(false);

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
    if (!requestId || pairState === "connected" || pairState === "rejected" || pairState === "expired" || pairState === "error") return;
    let stopped = false;

    async function poll() {
      try {
        const current = await getPairRequest(requestId!);
        if (stopped) return;
        setPairState(current.status);
        if (shouldEstablishSession(current.status) && !sessionPending.current) {
          sessionPending.current = true;
          try {
            const session = await establishPairSession(requestId!);
            if (stopped) return;
            setPhoneCsrfToken(session.csrfToken);
            clearStoredRequestId();
            setPairState("connected");
          } catch (caught) {
            sessionPending.current = false;
            if (!(caught instanceof ApiError && caught.status === 409) && !stopped) {
              setMessage(caught instanceof Error ? caught.message : "配对已确认，但无法建立手机会话。");
            }
          }
        }
      } catch (caught) {
        if (stopped) return;
        if (caught instanceof ApiError && (caught.status === 404 || caught.status === 410 || caught.code === "PAIRING_REQUEST_EXPIRED")) {
          setPairState("expired");
          setMessage(caught.message);
          return;
        }
        setMessage(caught instanceof Error ? caught.message : "连接电脑时遇到问题，正在重试。");
      }
    }

    void poll();
    const timer = window.setInterval(() => void poll(), 1600);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [pairState, requestId]);

  const heading = pairState === "connected"
    ? "手机已连接"
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

function readStoredRequestId(): string | undefined {
  const queryId = new URLSearchParams(window.location.search).get("request");
  if (queryId) return queryId;
  try {
    return window.sessionStorage.getItem("harness-pair-request") ?? undefined;
  } catch {
    return undefined;
  }
}

function storeRequestId(requestId: string) {
  try {
    window.sessionStorage.setItem("harness-pair-request", requestId);
  } catch {
    // The request ID is also kept in the URL for reload recovery.
  }
}

function clearStoredRequestId() {
  try {
    window.sessionStorage.removeItem("harness-pair-request");
  } catch {
    // Session storage may be disabled; the HttpOnly cookie remains authoritative.
  }
}
