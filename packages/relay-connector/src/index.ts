import { createHash } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import type { RemoteStreamEvent } from "@computer-harness/app-runtime";
import {
  MAX_ASSET_RESPONSE_BYTES,
  MAX_JSON_REQUEST_BYTES,
  MAX_JSON_RESPONSE_BYTES,
  MAX_SSE_EVENT_BYTES,
  MAX_WIRE_MESSAGE_BYTES,
  isRecord,
  isSafeHeaderValue,
  isValidIdentifier,
  parseBoundedJson,
  resolveAllowedApiRoute,
  type JsonObject,
} from "./routing.js";
import {
  RELAY_PROTOCOL_VERSION,
  type HostToRelayMessage,
  type HostPairingRegister,
  type HostSessionRevoke,
  type HostRequestHandler,
  type PairingTokenRegistration,
  type RelayBridgeEvent,
  type RelayBridgeRequest,
  type RelayBridgeResponse,
  type RelayBridgeSubscribe,
  type RelayBridgeUnsubscribe,
  type RelayPairingRegistered,
  type RelaySessionRevoked,
  type RelayProtocolError,
  type RelayToHostMessage,
} from "./protocol.js";

export * from "./protocol.js";
export * from "./routing.js";

const HOST_AUTH_TIMEOUT_MS = 10_000;
const DEFAULT_RECONNECT_MS = 500;
const MAX_RECONNECT_MS = 30_000;
const PAIRING_REGISTER_TIMEOUT_MS = 10_000;

export interface HostRelayConnectorOptions {
  relayUrl: string;
  hostId: string;
  credential: string;
  handlers: HostRequestHandler;
  allowInsecureLocalhost?: boolean;
  onStatus?: (status: "connecting" | "connected" | "disconnected" | "unauthorized") => void;
}

function websocketUrl(value: string, allowInsecureLocalhost: boolean): URL {
  const url = new URL(value);
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error("relay URL must not contain credentials, query parameters, or a fragment");
  }
  const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  const localHttp = url.protocol === "http:" && allowInsecureLocalhost && localHosts.has(url.hostname);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (localHttp) url.protocol = "ws:";
  else if (url.protocol !== "wss:" && url.protocol !== "ws:") throw new Error("relay URL must use HTTPS or WSS");
  if (url.protocol === "ws:") {
    if (!allowInsecureLocalhost || !localHosts.has(url.hostname)) {
      throw new Error("unencrypted relay connections are allowed only for explicit localhost development");
    }
  }
  if (url.pathname !== "/" && url.pathname !== "") throw new Error("relay URL must be an origin without a path");
  url.pathname = "/v1/host";
  return url;
}

function rawDataBytes(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data as ArrayBuffer);
}

function isSafeString(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && isSafeHeaderValue(value, maxBytes);
}

function validPairingRegistration(value: unknown): value is HostPairingRegister {
  return isRecord(value)
    && value.type === "host.pairing.register"
    && isValidIdentifier(value.pairingId)
    && typeof value.tokenHash === "string"
    && /^[a-f0-9]{64}$/u.test(value.tokenHash)
    && Number.isSafeInteger(value.expiresAt)
    && (value.expiresAt as number) > Date.now();
}

function validBridgeRequest(value: unknown): value is RelayBridgeRequest {
  if (!isRecord(value) || value.type !== "bridge.request" || !isValidIdentifier(value.requestId)) return false;
  if (value.method !== "GET" && value.method !== "POST" && value.method !== "DELETE") return false;
  if (typeof value.path !== "string" || resolveAllowedApiRoute(value.method, value.path) === null) return false;
  if (value.deviceId !== undefined && !isValidIdentifier(value.deviceId)) return false;
  if (value.sessionToken !== undefined && !isSafeString(value.sessionToken, 4096)) return false;
  if (value.csrfToken !== undefined && !isSafeString(value.csrfToken, 4096)) return false;
  if (value.body !== undefined) {
    if (!isRecord(value.body) || Buffer.byteLength(JSON.stringify(value.body), "utf8") > MAX_JSON_REQUEST_BYTES) return false;
  }
  return true;
}

function validBridgeSubscribe(value: unknown): value is RelayBridgeSubscribe {
  return isRecord(value)
    && value.type === "bridge.subscribe"
    && isValidIdentifier(value.subscriptionId)
    && isValidIdentifier(value.deviceId)
    && isSafeString(value.sessionToken, 4096)
    && isValidIdentifier(value.runId)
    && Number.isSafeInteger(value.afterSequence)
    && (value.afterSequence as number) >= 0;
}

function validBridgeUnsubscribe(value: unknown): value is RelayBridgeUnsubscribe {
  return isRecord(value) && value.type === "bridge.unsubscribe" && isValidIdentifier(value.subscriptionId);
}

function validProtocolError(value: unknown): value is RelayProtocolError {
  return isRecord(value)
    && value.type === "relay.error"
    && (value.code === "UNAUTHORIZED" || value.code === "INVALID_MESSAGE" || value.code === "HOST_BUSY" || value.code === "UNAVAILABLE");
}

function validReady(value: unknown, hostId: string): value is Extract<RelayToHostMessage, { type: "relay.ready" }> {
  return isRecord(value)
    && value.type === "relay.ready"
    && value.protocolVersion === RELAY_PROTOCOL_VERSION
    && value.hostId === hostId;
}

function validPairingRegistered(value: unknown): value is RelayPairingRegistered {
  return isRecord(value)
    && value.type === "relay.pairing.registered"
    && isValidIdentifier(value.pairingId)
    && Number.isSafeInteger(value.expiresAt);
}

function validSessionRevoked(value: unknown): value is RelaySessionRevoked {
  return isRecord(value)
    && value.type === "relay.session.revoked"
    && isValidIdentifier(value.deviceId)
    && (value.sessionTokenHash === undefined || (typeof value.sessionTokenHash === "string" && /^[a-f0-9]{64}$/u.test(value.sessionTokenHash)))
    && Number.isSafeInteger(value.revokedCount)
    && (value.revokedCount as number) >= 0;
}

function revocationKey(deviceId: string, sessionTokenHash?: string): string {
  return `${deviceId}\0${sessionTokenHash ?? "*"}`;
}

function parseRelayMessage(data: RawData): unknown {
  const bytes = rawDataBytes(data);
  if (bytes.byteLength > MAX_WIRE_MESSAGE_BYTES) return null;
  return parseBoundedJson(bytes, MAX_WIRE_MESSAGE_BYTES);
}

function validHostEvent(runId: string, sequence: number, event: JsonObject): boolean {
  return isValidIdentifier(runId)
    && Number.isSafeInteger(sequence)
    && sequence >= 0
    && Buffer.byteLength(JSON.stringify(event), "utf8") <= MAX_SSE_EVENT_BYTES;
}

export function hashPairingToken(token: string): string {
  if (!/^[A-Za-z0-9_-]{32,128}$/u.test(token)) throw new Error("pairing token must be URL-safe and at least 32 characters");
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Maintains one outbound authenticated WSS connection for a local Host. It
 * never buffers requests while offline and never retries a GUI command.
 */
export class HostRelayConnector {
  private readonly relayEndpoint: URL;
  private readonly pairingRegistrations = new Map<string, PairingTokenRegistration>();
  private readonly pendingRevocations = new Map<string, HostSessionRevoke>();
  private readonly subscriptionCleanup = new Map<string, () => void>();
  private socket: WebSocket | undefined;
  private started = false;
  private permanentlyRejected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectDelay = DEFAULT_RECONNECT_MS;
  private readyPromise: Promise<void> | undefined;
  private readonly pairingAckResolvers = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly options: HostRelayConnectorOptions) {
    if (!isValidIdentifier(options.hostId)) throw new Error("hostId must be a short opaque identifier");
    if (!isSafeString(options.credential, 4096) || options.credential.length < 32) {
      throw new Error("host relay credential must be at least 32 bytes");
    }
    this.relayEndpoint = websocketUrl(options.relayUrl, options.allowInsecureLocalhost === true);
  }

  get isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN && this.readyPromise === undefined;
  }

  async start(): Promise<void> {
    if (this.started) return this.readyPromise;
    if (this.permanentlyRejected) throw new Error("relay rejected this Host credential");
    this.started = true;
    this.options.onStatus?.("connecting");
    return this.connect(true);
  }

  close(): void {
    this.started = false;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.cleanupSubscriptions();
    for (const pairingId of this.pairingAckResolvers.keys()) {
      this.rejectPairingAck(pairingId, new Error("relay connector stopped before pairing registration completed"));
    }
    const socket = this.socket;
    this.socket = undefined;
    if (socket !== undefined && socket.readyState < WebSocket.CLOSING) socket.close(1000, "Host stopped");
    this.options.onStatus?.("disconnected");
  }

  registerPairingToken(registration: PairingTokenRegistration): Promise<void> {
    const expiresAt = registration.expiresAt;
    if (!isValidIdentifier(registration.pairingId)
      || !/^[a-f0-9]{64}$/u.test(registration.tokenHash)
      || !Number.isSafeInteger(expiresAt)
      || expiresAt <= Date.now()) {
      throw new Error("pairing registration is invalid or expired");
    }
    this.pairingRegistrations.set(registration.pairingId, { ...registration });
    const socket = this.socket;
    const completion = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pairingAckResolvers.delete(registration.pairingId);
        reject(new Error("relay did not acknowledge the pairing registration"));
      }, PAIRING_REGISTER_TIMEOUT_MS);
      this.pairingAckResolvers.set(registration.pairingId, { resolve, reject, timer });
    });
    if (socket !== undefined && socket.readyState === WebSocket.OPEN && this.readyPromise === undefined) {
      if (!this.send({ type: "host.pairing.register", ...registration })) {
        this.rejectPairingAck(registration.pairingId, new Error("relay connection is unavailable"));
      }
    } else if (!this.started) {
      this.pairingRegistrations.delete(registration.pairingId);
      this.rejectPairingAck(registration.pairingId, new Error("relay connector has not started"));
    }
    return completion;
  }

  unregisterPairingToken(pairingId: string): void {
    this.pairingRegistrations.delete(pairingId);
    if (this.isConnected) this.send({ type: "host.pairing.unregister", pairingId });
  }

  /** Revoke Relay-side cookies immediately, or retain the revocation for reconnect. */
  revokeDeviceSession(deviceId: string, sessionTokenHash?: string): boolean {
    if (!isValidIdentifier(deviceId) || (sessionTokenHash !== undefined && !/^[a-f0-9]{64}$/u.test(sessionTokenHash))) {
      throw new Error("device session revocation is invalid");
    }
    const message: HostSessionRevoke = {
      type: "host.session.revoke",
      deviceId,
      ...(sessionTokenHash === undefined ? {} : { sessionTokenHash }),
    };
    this.pendingRevocations.set(revocationKey(deviceId, sessionTokenHash), message);
    return this.isConnected && this.send(message);
  }

  private connect(initial: boolean): Promise<void> {
    const socket = new WebSocket(this.relayEndpoint, {
      handshakeTimeout: HOST_AUTH_TIMEOUT_MS,
      maxPayload: MAX_WIRE_MESSAGE_BYTES,
      perMessageDeflate: false,
      followRedirects: false,
    });
    this.socket = socket;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const authTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.terminate();
        reject(new Error("relay authentication timed out"));
      }, HOST_AUTH_TIMEOUT_MS);
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(authTimer);
        if (error !== undefined) reject(error);
        else resolve();
      };
      socket.on("open", () => {
        this.send({
          type: "host.hello",
          protocolVersion: RELAY_PROTOCOL_VERSION,
          hostId: this.options.hostId,
          credential: this.options.credential,
        }, socket);
      });
      socket.on("message", (data) => {
        const message = parseRelayMessage(data);
        if (validReady(message, this.options.hostId)) {
          this.readyPromise = undefined;
          this.reconnectDelay = DEFAULT_RECONNECT_MS;
          this.options.onStatus?.("connected");
          for (const registration of this.pairingRegistrations.values()) {
            if (registration.expiresAt <= Date.now()) {
              this.pairingRegistrations.delete(registration.pairingId);
              continue;
            }
            this.send({ type: "host.pairing.register", ...registration }, socket);
          }
          for (const revocation of this.pendingRevocations.values()) this.send(revocation, socket);
          finish();
          return;
        }
        if (validProtocolError(message) && message.code === "UNAUTHORIZED") {
          this.permanentlyRejected = true;
          this.options.onStatus?.("unauthorized");
          finish(new Error("relay rejected this Host credential"));
          socket.close(1008, "unauthorized");
          return;
        }
        if (validPairingRegistered(message)) {
          const registration = this.pairingRegistrations.get(message.pairingId);
          if (registration !== undefined && registration.expiresAt === message.expiresAt) {
            this.resolvePairingAck(message.pairingId);
          }
          return;
        }
        if (validSessionRevoked(message)) {
          this.pendingRevocations.delete(revocationKey(message.deviceId, message.sessionTokenHash));
          return;
        }
        if (validBridgeRequest(message)) {
          void this.handleRequest(message, socket);
          return;
        }
        if (validBridgeSubscribe(message)) {
          void this.handleSubscribe(message, socket);
          return;
        }
        if (validBridgeUnsubscribe(message)) {
          this.stopSubscription(message.subscriptionId);
          return;
        }
        if (isRecord(message) && message.type === "relay.pairing.consumed" && isValidIdentifier(message.pairingId)) {
          this.pairingRegistrations.delete(message.pairingId);
          return;
        }
        if (isRecord(message) && message.type === "relay.error") {
          if (message.code === "UNAUTHORIZED") this.permanentlyRejected = true;
          finish(new Error(`relay rejected a Host message: ${String(message.code)}`));
          socket.close(1008, "invalid relay message");
          return;
        }
        finish(new Error("relay sent an invalid protocol message"));
        socket.close(1002, "invalid protocol message");
      });
      socket.on("error", (error) => finish(error instanceof Error ? error : new Error("relay connection failed")));
      socket.on("close", () => {
        if (this.socket === socket) this.socket = undefined;
        this.cleanupSubscriptions();
        this.options.onStatus?.(this.permanentlyRejected ? "unauthorized" : "disconnected");
        finish(new Error("relay connection closed before authentication completed"));
        if (this.started && !this.permanentlyRejected) this.scheduleReconnect();
      });
    });
    const pending = this.readyPromise;
    if (pending === undefined) return Promise.resolve();
    return pending.catch((error: unknown) => {
      if (this.started && !this.permanentlyRejected) this.scheduleReconnect();
      if (initial) throw error;
    });
  }

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer !== undefined || this.permanentlyRejected) return;
    const jitter = 0.8 + Math.random() * 0.4;
    const delay = Math.floor(this.reconnectDelay * jitter);
    this.reconnectDelay = Math.min(MAX_RECONNECT_MS, this.reconnectDelay * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.started && !this.permanentlyRejected) void this.connect(false);
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private send(message: HostToRelayMessage, socket = this.socket): boolean {
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) return false;
    const serialized = JSON.stringify(message);
    if (Buffer.byteLength(serialized, "utf8") > MAX_WIRE_MESSAGE_BYTES) return false;
    socket.send(serialized, { compress: false }, (error) => {
      if (error !== null && error !== undefined) socket.terminate();
    });
    return true;
  }

  private async handleRequest(message: RelayBridgeRequest, socket: WebSocket): Promise<void> {
    let response: Omit<RelayBridgeResponse, "type" | "requestId">;
    try {
      const hostResponse = await this.options.handlers.request(message);
      const route = resolveAllowedApiRoute(message.method, message.path);
      if (route === null || !Number.isInteger(hostResponse.statusCode) || hostResponse.statusCode < 200 || hostResponse.statusCode > 599) {
        throw new Error("Host handler returned an invalid response");
      }
      const contentType = hostResponse.contentType ?? "application/json; charset=utf-8";
      if (!isSafeString(contentType, 128)) throw new Error("Host handler returned an invalid content type");
      if (route.kind === "asset") {
        if (hostResponse.statusCode >= 400 && hostResponse.bytes === undefined) {
          const body = JSON.stringify(hostResponse.body ?? {});
          if (Buffer.byteLength(body, "utf8") > MAX_JSON_RESPONSE_BYTES) throw new Error("Host error response exceeded its size limit");
          response = { statusCode: hostResponse.statusCode, contentType: "application/json; charset=utf-8", body };
          if (socket !== this.socket || socket.readyState !== WebSocket.OPEN) return;
          this.send({ type: "bridge.response", requestId: message.requestId, ...response }, socket);
          return;
        }
        if (hostResponse.bytes === undefined || hostResponse.body !== undefined) throw new Error("asset response must be bytes");
        const bytes = Buffer.from(hostResponse.bytes);
        if (bytes.byteLength > MAX_ASSET_RESPONSE_BYTES) {
          throw new Error("asset response exceeded its size limit");
        }
        response = { statusCode: hostResponse.statusCode, contentType, bodyBase64: bytes.toString("base64") };
      } else {
        if (hostResponse.bytes !== undefined) throw new Error("non-asset response cannot contain bytes");
        const body = JSON.stringify(hostResponse.body ?? {});
        const maxBytes = route.kind === "sse" ? MAX_SSE_EVENT_BYTES : MAX_JSON_RESPONSE_BYTES;
        if (Buffer.byteLength(body, "utf8") > maxBytes) throw new Error("Host response exceeded its size limit");
        response = { statusCode: hostResponse.statusCode, contentType, body };
      }
    } catch {
      response = {
        statusCode: 502,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify({ error: "host_response_invalid_or_unavailable" }),
      };
    }
    if (socket !== this.socket || socket.readyState !== WebSocket.OPEN) return;
    this.send({ type: "bridge.response", requestId: message.requestId, ...response }, socket);
  }

  private async handleSubscribe(message: RelayBridgeSubscribe, socket: WebSocket): Promise<void> {
    if (this.subscriptionCleanup.has(message.subscriptionId)) return;
    if (!this.options.handlers.authorizeSession(message.deviceId, message.sessionToken)) return;
    try {
      const subscription = this.options.handlers.api.subscribe(message.deviceId, message.runId, message.afterSequence, (event: RemoteStreamEvent) => {
        if (socket !== this.socket || socket.readyState !== WebSocket.OPEN) return;
        const serializedEvent = JSON.stringify(event);
        if (Buffer.byteLength(serializedEvent, "utf8") > MAX_SSE_EVENT_BYTES) return;
        if (event.type === "resync_required") {
          const eventBody: JsonObject = {
            type: "resync_required",
            runId: event.runId,
            afterSequence: event.afterSequence,
            latestSequence: event.latestSequence,
          };
          if (!isValidIdentifier(event.runId) || Buffer.byteLength(JSON.stringify(eventBody), "utf8") > MAX_SSE_EVENT_BYTES) return;
          this.send({ type: "bridge.event", subscriptionId: message.subscriptionId, runId: event.runId, control: "resync_required", event: eventBody }, socket);
          return;
        }
        const eventBody = event as unknown as JsonObject;
        if (!validHostEvent(event.runId, event.sequence, eventBody)) return;
        this.send({ type: "bridge.event", subscriptionId: message.subscriptionId, runId: event.runId, sequence: event.sequence, event: eventBody }, socket);
      });
      const cleanup = () => subscription.close();
      if (socket !== this.socket || socket.readyState !== WebSocket.OPEN) {
        cleanup();
        return;
      }
      this.subscriptionCleanup.set(message.subscriptionId, cleanup);
    } catch {
      // A failed subscription produces no events; the caller reconnects and fetches a fresh snapshot.
    }
  }

  private stopSubscription(subscriptionId: string): void {
    const cleanup = this.subscriptionCleanup.get(subscriptionId);
    if (cleanup === undefined) return;
    this.subscriptionCleanup.delete(subscriptionId);
    try {
      cleanup();
    } catch {
      // Cleanup is best effort and must not affect unrelated subscriptions.
    }
  }

  private resolvePairingAck(pairingId: string): void {
    const pending = this.pairingAckResolvers.get(pairingId);
    if (pending === undefined) return;
    this.pairingAckResolvers.delete(pairingId);
    clearTimeout(pending.timer);
    pending.resolve();
  }

  private rejectPairingAck(pairingId: string, error: Error): void {
    const pending = this.pairingAckResolvers.get(pairingId);
    if (pending === undefined) return;
    this.pairingAckResolvers.delete(pairingId);
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private cleanupSubscriptions(): void {
    for (const subscriptionId of this.subscriptionCleanup.keys()) this.stopSubscription(subscriptionId);
  }
}
