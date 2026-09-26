// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDevices, getLocalPairing, getLocalSession } from "./api";
import { ConnectPhoneScreen } from "./ConnectPhoneScreen";

vi.mock("./api", () => ({
  confirmPairingRequest: vi.fn(),
  createPairingChallenge: vi.fn(),
  getDevices: vi.fn(),
  getLocalPairing: vi.fn(),
  getLocalSession: vi.fn(),
  revokeDevice: vi.fn(),
}));

afterEach(() => cleanup());

describe("computer-side phone connection manager", () => {
  it("shows only requests waiting for local confirmation", async () => {
    vi.mocked(getLocalSession).mockResolvedValue(undefined);
    vi.mocked(getLocalPairing).mockResolvedValue({
      requests: [
        { requestId: "request-pending", clientName: "手机浏览器", status: "pending" },
        { requestId: "request-approved", clientName: "旧手机", status: "approved" },
      ],
    });
    vi.mocked(getDevices).mockResolvedValue({ devices: [] });
    render(<ConnectPhoneScreen />);

    const connectionGuide = screen.getByText("连接说明").closest("details") as HTMLDetailsElement;
    expect(connectionGuide.open).toBe(false);
    connectionGuide.open = true;
    expect(screen.getByText(/跨网络连接需该地址可达且 HTTPS 证书受手机信任/)).toBeDefined();
    expect(screen.queryByText(/公网中继尚未部署/)).toBeNull();
    await waitFor(() => expect(screen.getByText("手机浏览器")).toBeDefined());
    expect(screen.getByRole("button", { name: "允许这台手机" })).toBeDefined();
    expect(screen.getByRole("button", { name: "拒绝" })).toBeDefined();
    expect(screen.queryByText("旧手机")).toBeNull();
  });
});
