// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PairingQrPanel } from "./PairingQrPanel";

vi.mock("qrcode", () => ({ default: { toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,qr") } }));

afterEach(cleanup);

describe("pairing QR status copy", () => {
  it("describes HTTPS remote availability conditionally without claiming deployment status", () => {
    render(<PairingQrPanel
      challenge={{ challengeId: "challenge", pairingUrl: "https://relay.example/pair?token=short-lived", expiresAt: "2026-09-27T00:00:00.000Z" }}
      hasActiveChallenge={false}
      busy={false}
      loading={false}
      onIssue={vi.fn()}
    />);

    expect(screen.getByText(/请确认对应的 Relay 可从手机访问/)).toBeDefined();
    expect(screen.getByText(/HTTPS 证书受手机信任/)).toBeDefined();
    expect(screen.queryByText(/尚未完成验证|尚未部署/)).toBeNull();
  });

  it("warns when the QR code points back to the phone itself", () => {
    render(<PairingQrPanel
      challenge={{ challengeId: "challenge", pairingUrl: "http://localhost:4317/pair?token=short-lived", expiresAt: "2026-09-27T00:00:00.000Z" }}
      hasActiveChallenge={false}
      busy={false}
      loading={false}
      onIssue={vi.fn()}
    />);

    expect(screen.getByText(/localhost 会指向手机自己/)).toBeDefined();
  });

  it("warns that remote HTTP does not protect pairing data", () => {
    render(<PairingQrPanel
      challenge={{ challengeId: "challenge", pairingUrl: "http://relay.example/pair?token=short-lived", expiresAt: "2026-09-27T00:00:00.000Z" }}
      hasActiveChallenge={false}
      busy={false}
      loading={false}
      onIssue={vi.fn()}
    />);

    expect(screen.getByText(/非本机 HTTP 地址/)).toBeDefined();
    expect(screen.getByText(/未受 HTTPS 保护/)).toBeDefined();
  });
});
