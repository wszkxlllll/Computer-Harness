import QRCode from "qrcode";
import { useEffect, useState } from "react";
import type { PairingChallenge } from "../types";
import { formatDate } from "../date-format";

interface PairingQrPanelProps {
  challenge?: PairingChallenge;
  hasActiveChallenge: boolean;
  busy: boolean;
  loading: boolean;
  onIssue: () => void;
}

export function PairingQrPanel({ challenge, hasActiveChallenge, busy, loading, onIssue }: PairingQrPanelProps) {
  const [qrImage, setQrImage] = useState<string>();
  const [qrError, setQrError] = useState(false);

  useEffect(() => {
    if (!challenge) {
      setQrImage(undefined);
      setQrError(false);
      return;
    }
    let current = true;
    void QRCode.toDataURL(challenge.pairingUrl, { width: 256, margin: 2, errorCorrectionLevel: "M" })
      .then((url) => { if (current) { setQrError(false); setQrImage(url); } })
      .catch(() => { if (current) { setQrError(true); setQrImage(undefined); } });
    return () => { current = false; };
  }, [challenge]);

  return (
    <section className="connect-main-panel" aria-labelledby="pairing-heading">
      <div className="section-kicker">一次性授权</div>
      <h2 id="pairing-heading">让手机扫码发起配对</h2>
      <p className="section-copy">二维码只包含短期配对凭据。扫描后仍要在电脑上确认，这一步不会自动授予访问权限。</p>
      <button className="button button-primary button-large" type="button" disabled={busy || loading} onClick={onIssue}>
        {challenge ? "生成新二维码" : "生成配对二维码"}
      </button>

      {challenge && (
        <div className="qr-display" aria-live="polite">
          {qrError
            ? <p className="notice notice-error" role="alert">无法在这台电脑上生成二维码。</p>
            : qrImage
            ? <img src={qrImage} alt="一次性手机配对二维码" width="256" height="256" />
            : <div className="qr-placeholder" role="status">正在生成二维码…</div>}
          <p className="qr-expires">有效至 {formatDate(challenge.expiresAt)}</p>
          {isLoopbackUrl(challenge.pairingUrl)
            ? <p className="notice notice-warning qr-warning">这个二维码指向本机地址。手机扫描时，localhost 会指向手机自己；当前仅能验证本地界面，不能完成手机连接。</p>
            : <p className="notice notice-warning qr-warning">公网中继尚未完成验证。请只在信任的手机上扫描；当前不保证不同网络间可达，也不代表正式扫码即用。</p>}
        </div>
      )}
      {!challenge && hasActiveChallenge && (
        <p className="field-hint">电脑上已有一个有效配对请求。刷新后不会再次显示旧二维码；生成新码可继续操作。</p>
      )}
    </section>
  );
}

function isLoopbackUrl(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname;
    return host === "localhost" || host === "::1" || host === "[::1]" || host.startsWith("127.");
  } catch {
    return true;
  }
}
