import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, confirmPairingRequest, createPairingChallenge, getDevices, getLocalPairing, getLocalSession, revokeDevice } from "./api";
import { BrandHeader } from "./components/BrandHeader";
import { PairedDevicesPanel } from "./components/PairedDevicesPanel";
import { PairingQrPanel } from "./components/PairingQrPanel";
import { PairingRequestsPanel } from "./components/PairingRequestsPanel";
import type { LocalPairingState, PairedDevice, PairingChallenge, PairingRequest } from "./types";

const emptyPairing: LocalPairingState = { requests: [] };

export function ConnectPhoneScreen() {
  const localOnly = isLoopbackHost(window.location.hostname);
  const [pairing, setPairing] = useState<LocalPairingState>(emptyPairing);
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [challenge, setChallenge] = useState<PairingChallenge>();
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const refresh = useCallback(async () => {
    if (!localOnly) return;
    try {
      const [nextPairing, nextDevices] = await Promise.all([getLocalPairing(), getDevices()]);
      setPairing(nextPairing);
      setDevices(Array.isArray(nextDevices.devices) ? nextDevices.devices : []);
      setError(undefined);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "无法读取电脑连接状态。请在运行 Harness 的电脑上打开此页面。");
    } finally {
      setLoading(false);
    }
  }, [localOnly]);

  useEffect(() => {
    if (!localOnly) {
      setLoading(false);
      return;
    }
    void getLocalSession().then(refresh).catch((caught: unknown) => {
      setLoading(false);
      setError(caught instanceof Error ? caught.message : "电脑本机管理入口不可用。");
    });
    const timer = window.setInterval(() => void refresh(), 4000);
    return () => window.clearInterval(timer);
  }, [localOnly, refresh]);

  const activeRequests = useMemo(
    () => (pairing.requests ?? []).filter((item) => item.status === "pending"),
    [pairing.requests],
  );

  async function issueChallenge() {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      setChallenge(await createPairingChallenge());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "电脑没有生成新的二维码。");
    } finally {
      setBusy(false);
    }
  }

  async function decide(request: PairingRequest, approved: boolean, label?: string) {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await confirmPairingRequest(request.requestId, approved, label);
      setNotice(approved ? "手机已获授权。" : "配对请求已拒绝。");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "电脑没有确认这项配对请求。");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(device: PairedDevice) {
    const label = device.label || "这台手机";
    if (!window.confirm(`撤销“${label}”的连接？这台手机将不能再查看或控制电脑任务。`)) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await revokeDevice(device.deviceId);
      setNotice("手机连接已撤销。");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "没有撤销这台手机的连接。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <BrandHeader mode="computer" />
      <main className="page-shell connect-page">
        <p className="eyebrow">电脑端 · 连接管理</p>
        <h1 className="page-title">连接手机</h1>
        <div className="prototype-banner" role="note">
          <strong>本机原型</strong>
          <span>公网中继尚未部署，当前二维码不代表已支持跨网络扫码。普通用户流程无需 VPN；本机演示也不要求手动输入电脑 IP。</span>
        </div>

        {!localOnly && (
          <div className="notice notice-warning" role="alert">
            配对授权只能在运行 Harness 的电脑本机完成。请在那台电脑上打开连接管理页面。
          </div>
        )}

        {error && <div className="notice notice-error" role="alert">{error}</div>}
        {notice && <div className="notice notice-success" role="status">{notice}</div>}

        {localOnly && (
          <div className="connect-layout">
            <PairingQrPanel
              challenge={challenge}
              hasActiveChallenge={Boolean(pairing.activeChallenge)}
              busy={busy}
              loading={loading}
              onIssue={() => void issueChallenge()}
            />
            <PairingRequestsPanel requests={activeRequests} loading={loading} busy={busy} onDecide={(request, approved, label) => void decide(request, approved, label)} />
            <PairedDevicesPanel devices={devices} loading={loading} busy={busy} onRefresh={() => void refresh()} onRevoke={(device) => void revoke(device)} />
          </div>
        )}
      </main>
    </>
  );
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || host === "[::1]" || host.startsWith("127.");
}
