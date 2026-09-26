import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PairRequestView, PairedDeviceView } from "./contracts.js";

const PAIRING_TTL_MS = 90_000;
const REQUEST_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const MAX_PENDING_REQUESTS = 16;
const MAX_DEVICES = 32;
const MAX_RETAINED_REQUESTS = 64;

interface PairingChallenge {
  readonly challengeId: string;
  readonly tokenHash: string;
  readonly token: string;
  readonly pairingUrl: string;
  readonly expiresAt: number;
  consumed: boolean;
}

interface PairingRequest extends Omit<PairRequestView, "status" | "deviceId"> {
  status: PairRequestView["status"];
  deviceId?: string;
  readonly tokenHash: string;
}

interface PairedDevice extends Omit<PairedDeviceView, "lastSeenAt"> {
  lastSeenAt: string;
  sessionTokenHash: string;
  readonly csrfToken: string;
  readonly expiresAt: number;
  revoked: boolean;
}

export interface PairingSession {
  readonly deviceId: string;
  readonly label: string;
  readonly csrfToken: string;
  readonly expiresAt: string;
  readonly sessionToken: string;
}

export interface PairingState {
  readonly activeChallenge?: { readonly challengeId: string; readonly pairingUrl: string; readonly expiresAt: string };
  readonly requests: readonly PairRequestView[];
}

export interface PairingChallengeRegistration {
  readonly challengeId: string;
  readonly token: string;
  readonly tokenHash: string;
  readonly pairingUrl: string;
  readonly expiresAt: string;
}

export type PairingErrorCode = "PAIRING_TOKEN_INVALID" | "PAIRING_REQUEST_EXPIRED" | "PAIRING_REQUEST_NOT_FOUND" |
  "PAIRING_NOT_APPROVED" | "DEVICE_LIMIT_REACHED" | "PAIRING_BUSY" | "SESSION_INVALID" | "DEVICE_NOT_FOUND";

export class PairingError extends Error {
  public constructor(
    public readonly code: PairingErrorCode,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "PairingError";
  }
}

/** Ephemeral, one-use pairing and revocable session state owned by one Host process. */
export class PairingStore {
  private challenge: PairingChallenge | undefined;
  private readonly requests = new Map<string, PairingRequest>();
  private readonly devices = new Map<string, PairedDevice>();
  private readonly sessions = new Map<string, string>();
  private readonly localCsrfToken = randomToken(32);

  public get adminCsrfToken(): string {
    return this.localCsrfToken;
  }

  public createPairing(pairingUrlForToken: (token: string) => string, now = Date.now()): PairingChallengeRegistration {
    this.prune(now);
    const token = randomToken(32);
    const expiresAt = now + PAIRING_TTL_MS;
    const challenge: PairingChallenge = {
      challengeId: randomId(),
      token,
      tokenHash: hashSecret(token),
      pairingUrl: pairingUrlForToken(token),
      expiresAt,
      consumed: false,
    };
    this.challenge = challenge;
    return {
      challengeId: challenge.challengeId,
      token: challenge.token,
      tokenHash: challenge.tokenHash,
      pairingUrl: challenge.pairingUrl,
      expiresAt: new Date(challenge.expiresAt).toISOString(),
    };
  }

  public cancelChallenge(challengeId: string): void {
    if (this.challenge?.challengeId === challengeId) this.challenge = undefined;
  }

  public getState(now = Date.now()): PairingState {
    this.prune(now);
    const activeChallenge = this.challenge !== undefined && !this.challenge.consumed && this.challenge.expiresAt > now
      ? { challengeId: this.challenge.challengeId, pairingUrl: this.challenge.pairingUrl, expiresAt: new Date(this.challenge.expiresAt).toISOString() }
      : undefined;
    return {
      ...(activeChallenge === undefined ? {} : { activeChallenge }),
      requests: [...this.requests.values()].map((request) => this.toRequestView(request, now)),
    };
  }

  public requestPairing(token: string, clientName: string, now = Date.now()): PairRequestView {
    this.prune(now);
    const challenge = this.challenge;
    const tokenHash = hashSecret(token);
    if (challenge === undefined || challenge.expiresAt <= now || challenge.consumed || !safeEqual(tokenHash, challenge.tokenHash)) {
      throw new PairingError("PAIRING_TOKEN_INVALID", 404, "Pairing code is invalid or expired.");
    }
    const activeCount = [...this.requests.values()].filter((request) => request.status === "pending_local_confirmation" && Date.parse(request.expiresAt) > now).length;
    if (activeCount >= MAX_PENDING_REQUESTS) throw new PairingError("PAIRING_BUSY", 429, "Too many pending pairing requests.");
    challenge.consumed = true;
    const createdAt = new Date(now).toISOString();
    const request: PairingRequest = {
      requestId: randomId(),
      clientName: normalizeLabel(clientName, "Phone"),
      createdAt,
      expiresAt: new Date(now + REQUEST_TTL_MS).toISOString(),
      status: "pending_local_confirmation",
      tokenHash,
    };
    this.requests.set(request.requestId, request);
    return this.toRequestView(request, now);
  }

  public getRequest(requestId: string, now = Date.now()): PairRequestView | undefined {
    this.prune(now);
    const request = this.requests.get(requestId);
    return request === undefined ? undefined : this.toRequestView(request, now);
  }

  public confirmRequest(
    requestId: string,
    approved: boolean,
    label: string | undefined,
    now = Date.now(),
  ): PairRequestView {
    this.prune(now);
    const request = this.requests.get(requestId);
    if (request === undefined) throw new PairingError("PAIRING_REQUEST_NOT_FOUND", 404, "Pairing request was not found.");
    if (request.status === "expired" || Date.parse(request.expiresAt) <= now) {
      request.status = "expired";
      throw new PairingError("PAIRING_REQUEST_EXPIRED", 410, "Pairing request expired.");
    }
    if (request.status !== "pending_local_confirmation") {
      throw new PairingError("PAIRING_REQUEST_EXPIRED", 409, "Pairing request has already been resolved.");
    }
    if (!approved) {
      request.status = "rejected";
      return this.toRequestView(request, now);
    }
    if ([...this.devices.values()].filter((device) => !device.revoked && device.expiresAt > now).length >= MAX_DEVICES) {
      throw new PairingError("DEVICE_LIMIT_REACHED", 409, "This Host already has the maximum number of paired devices.");
    }
    const deviceId = randomId();
    const sessionToken = randomToken(32);
    const device: PairedDevice = {
      deviceId,
      label: normalizeLabel(label ?? request.clientName, "Phone"),
      createdAt: new Date(now).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
      sessionTokenHash: hashSecret(sessionToken),
      csrfToken: randomToken(32),
      expiresAt: now + SESSION_TTL_MS,
      revoked: false,
    };
    request.status = "approved";
    request.deviceId = deviceId;
    this.devices.set(deviceId, device);
    this.sessions.set(device.sessionTokenHash, deviceId);
    return this.toRequestView(request, now);
  }

  public issueSession(requestId: string, now = Date.now()): PairingSession {
    this.prune(now);
    const request = this.requests.get(requestId);
    if (request === undefined) throw new PairingError("PAIRING_REQUEST_NOT_FOUND", 404, "Pairing request was not found.");
    if (request.status !== "approved" || request.deviceId === undefined) {
      throw new PairingError("PAIRING_NOT_APPROVED", 409, "Pairing still requires approval on the Host computer.");
    }
    const device = this.devices.get(request.deviceId);
    if (device === undefined || device.revoked || device.expiresAt <= now) {
      throw new PairingError("SESSION_INVALID", 401, "Paired device session is no longer available.");
    }
    const sessionToken = randomToken(32);
    this.sessions.delete(device.sessionTokenHash);
    device.sessionTokenHash = hashSecret(sessionToken);
    this.sessions.set(device.sessionTokenHash, device.deviceId);
    device.lastSeenAt = new Date(now).toISOString();
    return {
      deviceId: device.deviceId,
      label: device.label,
      csrfToken: device.csrfToken,
      expiresAt: new Date(device.expiresAt).toISOString(),
      sessionToken,
    };
  }

  public authenticateSession(sessionToken: string | undefined, now = Date.now()): Omit<PairingSession, "sessionToken"> | undefined {
    if (sessionToken === undefined || sessionToken.length < 32 || sessionToken.length > 128) return undefined;
    const tokenHash = hashSecret(sessionToken);
    const deviceId = this.sessions.get(tokenHash);
    if (deviceId === undefined) return undefined;
    const device = this.devices.get(deviceId);
    if (device === undefined || device.revoked || device.expiresAt <= now || !safeEqual(device.sessionTokenHash, tokenHash)) {
      return undefined;
    }
    device.lastSeenAt = new Date(now).toISOString();
    return {
      deviceId: device.deviceId,
      label: device.label,
      csrfToken: device.csrfToken,
      expiresAt: new Date(device.expiresAt).toISOString(),
    };
  }

  public listDevices(now = Date.now()): readonly PairedDeviceView[] {
    this.prune(now);
    return [...this.devices.values()]
      .filter((device) => !device.revoked && device.expiresAt > now)
      .map(({ deviceId, label, createdAt, lastSeenAt }) => ({ deviceId, label, createdAt, lastSeenAt }));
  }

  public revokeDevice(deviceId: string): boolean {
    const device = this.devices.get(deviceId);
    if (device === undefined || device.revoked) return false;
    device.revoked = true;
    this.sessions.delete(device.sessionTokenHash);
    for (const request of this.requests.values()) {
      if (request.deviceId === deviceId) request.status = "rejected";
    }
    return true;
  }

  public isDeviceCsrfValid(deviceId: string, csrfToken: string | undefined): boolean {
    const device = this.devices.get(deviceId);
    if (device === undefined || device.revoked || csrfToken === undefined) return false;
    return safeEqual(device.csrfToken, csrfToken);
  }

  private prune(now: number): void {
    if (this.challenge !== undefined && this.challenge.expiresAt <= now) this.challenge = undefined;
    for (const [requestId, request] of this.requests) {
      if (request.status === "pending_local_confirmation" && Date.parse(request.expiresAt) <= now) request.status = "expired";
      const keepUntil = Date.parse(request.expiresAt) + SESSION_TTL_MS;
      if (keepUntil <= now || this.requests.size > MAX_RETAINED_REQUESTS) {
        this.requests.delete(requestId);
      }
    }
    for (const [deviceId, device] of this.devices) {
      if (device.expiresAt <= now || device.revoked) {
        this.sessions.delete(device.sessionTokenHash);
        this.devices.delete(deviceId);
      }
    }
  }

  private toRequestView(request: PairingRequest, now: number): PairRequestView {
    return {
      requestId: request.requestId,
      clientName: request.clientName,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
      status: request.status === "pending_local_confirmation" && Date.parse(request.expiresAt) <= now ? "expired" : request.status,
      ...(request.deviceId === undefined ? {} : { deviceId: request.deviceId }),
    };
  }
}

export function hashPairingToken(token: string): string {
  if (!/^[A-Za-z0-9_-]{32,128}$/u.test(token)) throw new PairingError("PAIRING_TOKEN_INVALID", 404, "Pairing code is invalid or expired.");
  return hashSecret(token);
}

function normalizeLabel(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  if (trimmed.length > 64 || /[\u0000-\u001f\u007f]/u.test(trimmed)) throw new PairingError("PAIRING_TOKEN_INVALID", 400, "Device label must contain 1 to 64 visible characters.");
  return trimmed;
}

function randomId(): string {
  return randomUUID().replaceAll("-", "");
}

function randomToken(byteLength: number): string {
  return randomBytes(byteLength).toString("base64url");
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}
