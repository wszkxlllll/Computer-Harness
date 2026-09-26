import { describe, expect, it } from "vitest";
import { PairingError, PairingStore } from "./pairing-store.js";

describe("PairingStore", () => {
  it("requires local confirmation, consumes the QR token once, and issues revocable sessions", () => {
    const store = new PairingStore();
    const challenge = store.createPairing((token) => "https://relay.example/pair?token=" + token, 1_000);
    expect(challenge.token).toMatch(/^[A-Za-z0-9_-]{40,64}$/u);
    expect(challenge.tokenHash).not.toBe(challenge.token);
    expect(Date.parse(challenge.expiresAt)).toBe(91_000);

    const request = store.requestPairing(challenge.token, "Kitchen phone", 2_000);
    expect(request.status).toBe("pending_local_confirmation");
    expect(() => store.issueSession(request.requestId, 2_001)).toThrow(
      expect.objectContaining({ code: "PAIRING_NOT_APPROVED" }),
    );
    expect(() => store.requestPairing(challenge.token, "Another phone", 2_002)).toThrow(
      expect.objectContaining({ code: "PAIRING_TOKEN_INVALID" }),
    );

    const approved = store.confirmRequest(request.requestId, true, "Kitchen", 3_000);
    expect(approved).toMatchObject({ status: "approved", clientName: "Kitchen phone" });
    const session = store.issueSession(request.requestId, 3_001);
    expect(store.authenticateSession(session.sessionToken, 3_002)).toMatchObject({
      deviceId: session.deviceId,
      csrfToken: session.csrfToken,
    });
    expect(store.isDeviceCsrfValid(session.deviceId, session.csrfToken)).toBe(true);
    expect(store.isDeviceCsrfValid(session.deviceId, "wrong-token")).toBe(false);
    expect(store.listDevices(3_002)).toHaveLength(1);

    expect(store.revokeDevice(session.deviceId)).toBe(true);
    expect(store.authenticateSession(session.sessionToken, 3_003)).toBeUndefined();
    expect(store.listDevices(3_003)).toHaveLength(0);
  });

  it("expires both one-use challenges and unconfirmed requests", () => {
    const store = new PairingStore();
    const challenge = store.createPairing((token) => "http://localhost/pair?token=" + token, 10_000);
    expect(() => store.requestPairing(challenge.token, "Phone", 100_001)).toThrow(
      expect.objectContaining({ code: "PAIRING_TOKEN_INVALID" }),
    );

    const second = store.createPairing((token) => "http://localhost/pair?token=" + token, 200_000);
    const request = store.requestPairing(second.token, "Phone", 200_001);
    const afterExpiry = store.getRequest(request.requestId, 500_002);
    expect(afterExpiry?.status).toBe("expired");
    expect(() => store.confirmRequest(request.requestId, true, undefined, 500_003)).toThrow(
      expect.objectContaining({ code: "PAIRING_REQUEST_EXPIRED" }),
    );
  });

  it("rejects malformed device labels and never returns a secret in device listings", () => {
    const store = new PairingStore();
    const challenge = store.createPairing((token) => "http://localhost/pair?token=" + token);
    const request = store.requestPairing(challenge.token, "Phone");
    expect(() => store.confirmRequest(request.requestId, true, "bad\nlabel")).toThrow(PairingError);

    store.confirmRequest(request.requestId, true, "Phone");
    const session = store.issueSession(request.requestId);
    const [device] = store.listDevices();
    expect(device).toMatchObject({ deviceId: session.deviceId, label: "Phone" });
    expect(JSON.stringify(device)).not.toContain(session.sessionToken);
    expect(JSON.stringify(device)).not.toContain(session.csrfToken);
  });
});
