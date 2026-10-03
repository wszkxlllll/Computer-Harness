import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import {
  MAX_ASSET_RESPONSE_BYTES,
  MAX_JSON_REQUEST_BYTES,
  MAX_JSON_RESPONSE_BYTES,
  MAX_SSE_EVENT_BYTES,
  MAX_WIRE_MESSAGE_BYTES,
  isRecord,
  isValidApiRequestBody,
  isSafeHeaderValue,
  isValidIdentifier,
  parseBoundedJson,
  resolveAllowedApiRoute,
  type AllowedApiRoute,
  type JsonObject,
} from "@computer-harness/relay-connector/routing";
import {
  RELAY_PROTOCOL_VERSION,
  type HostHello,
  type HostPairingRegister,
  type RelayBridgeEvent,
  type RelayBridgeRequest,
  type RelayBridgeResponse,
  type RelayBridgeSubscribe,
  type RelayBridgeUnsubscribe,
  type RelayToHostMessage,
} from "@computer-harness/relay-connector/protocol";

const HOST_HELLO_TIMEOUT_MS = 10_000;
const MAX_PENDING_PER_HOST = 32;
const MAX_COOKIE_HEADER_BYTES = 8 * 1024;
const MAX_PAIRING_TTL_MS = 10 * 60 * 1000;
const MAX_SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const SSE_HEARTBEAT_MS = 15_000;
const MAX_SSE_BACKPRESSURE_BYTES = 512 * 1024;
const MAX_HOST_BACKPRESSURE_BYTES = 2 * 1024 * 1024;

export interface RelayServerConfig {
  publicOrigin: string;
  listenHost?: string;
  listenPort?: number;
  webRoot?: string;
  hostCredentials: ReadonlyMap<string, string>;
  requestTimeoutMs?: number;
}

interface PairingRoute {
  hostId: string;
  pairingId: string;
  tokenHash: string;
  expiresAt: number;
}

interface PairRequestRoute {
  hostId: string;
  hostRequestId: string;
  expiresAt: number;
}

interface HostSessionRoute {
  hostId: string;
  deviceId: string;
  sessionToken: string;
  sessionTokenHash: string;
  csrfToken: string;
  expiresAt: number;
}

interface SseSubscriber {
  subscriptionId: string;
  deviceId: string;
  runId: string;
  response: ServerResponse;
  sessionCookieHash: string;
  lastSequence: number;
  heartbeat: ReturnType<typeof setInterval>;
}

interface PendingRequest {
  response: ServerResponse;
  timer: ReturnType<typeof setTimeout>;
  route: AllowedApiRoute;
  publicRequestId?: string;
  pairRequest?: PairRequestRoute;
  creatingPairRequest: boolean;
  creatingSession: boolean;
  sessionCookieHash?: string;
}

interface HostPeer {
  hostId: string;
  socket: WebSocket;
  authenticated: boolean;
  helloTimer: ReturnType<typeof setTimeout>;
  pairings: Map<string, PairingRoute>;
  pending: Map<string, PendingRequest>;
  subscriptions: Map<string, SseSubscriber>;
  messageWindowStart: number;
  messagesInWindow: number;
}

interface HostEnvelope {
  type?: unknown;
  [key: string]: unknown;
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeEqual(leftText: string, rightText: string): boolean {
  const left = Buffer.from(leftText, "utf8");
  const right = Buffer.from(rightText, "utf8");
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function rawDataBytes(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data as ArrayBuffer);
}

function parseWireMessage(data: RawData): HostEnvelope | null {
  const bytes = rawDataBytes(data);
  if (bytes.byteLength > MAX_WIRE_MESSAGE_BYTES) return null;
  const value = parseBoundedJson(bytes, MAX_WIRE_MESSAGE_BYTES);
  return isRecord(value) ? value as HostEnvelope : null;
}

function isHostHello(value: HostEnvelope): value is HostEnvelope & HostHello {
  return value.type === "host.hello"
    && Number.isSafeInteger(value.protocolVersion)
    && typeof value.hostId === "string"
    && isValidIdentifier(value.hostId)
    && typeof value.credential === "string"
    && isSafeHeaderValue(value.credential, 4096)
    && value.credential.length >= 32;
}

function isoDateMillis(value: unknown): number | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validHostPairingRegister(value: HostEnvelope): value is HostEnvelope & HostPairingRegister {
  return value.type === "host.pairing.register"
    && isValidIdentifier(value.pairingId)
    && typeof value.tokenHash === "string"
    && /^[a-f0-9]{64}$/u.test(value.tokenHash)
    && Number.isSafeInteger(value.expiresAt)
    && (value.expiresAt as number) > Date.now()
    && (value.expiresAt as number) <= Date.now() + MAX_PAIRING_TTL_MS;
}

function isValidBridgeResponse(value: HostEnvelope): value is HostEnvelope & RelayBridgeResponse {
  if (value.type !== "bridge.response" || !isValidIdentifier(value.requestId)) return false;
  if (!Number.isInteger(value.statusCode) || (value.statusCode as number) < 200 || (value.statusCode as number) > 599) return false;
  if (typeof value.contentType !== "string" || !isSafeHeaderValue(value.contentType, 128)) return false;
  if (value.body !== undefined && typeof value.body !== "string") return false;
  if (value.bodyBase64 !== undefined && typeof value.bodyBase64 !== "string") return false;
  if (value.body !== undefined && value.bodyBase64 !== undefined) return false;
  return true;
}

function isValidBridgeEvent(value: HostEnvelope): value is HostEnvelope & RelayBridgeEvent {
  if (value.type !== "bridge.event" || !isValidIdentifier(value.subscriptionId) || !isValidIdentifier(value.runId) || !isRecord(value.event)) return false;
  if (value.control === "resync_required") {
    return value.sequence === undefined
      && value.event.type === "resync_required"
      && value.event.runId === value.runId
      && Number.isSafeInteger(value.event.afterSequence)
      && Number(value.event.afterSequence) >= 0
      && Number.isSafeInteger(value.event.latestSequence)
      && Number(value.event.latestSequence) >= 0;
  }
  return value.control === undefined
    && Number.isSafeInteger(value.sequence)
    && (value.sequence as number) >= 0;
}

function isValidPairingUnregister(value: HostEnvelope): value is HostEnvelope & { type: "host.pairing.unregister"; pairingId: string } {
  return value.type === "host.pairing.unregister" && isValidIdentifier(value.pairingId);
}

function isValidSessionRevoke(value: HostEnvelope): boolean {
  return value.type === "host.session.revoke"
    && isValidIdentifier(value.deviceId)
    && (value.sessionTokenHash === undefined || (typeof value.sessionTokenHash === "string" && /^[a-f0-9]{64}$/u.test(value.sessionTokenHash)));
}

function isSessionRevoke(value: HostEnvelope): value is HostEnvelope & { deviceId: string; sessionTokenHash?: string } {
  return isValidSessionRevoke(value);
}

function routeIdentifier(path: string, expression: RegExp): string | null {
  return expression.exec(path)?.[1] ?? null;
}

function safeJsonBytes(body: JsonObject): Buffer {
  return Buffer.from(JSON.stringify(body), "utf8");
}

function jsonResponseBody(value: unknown): JsonObject | null {
  if (!isRecord(value)) return null;
  return value as JsonObject;
}

function cookieTokenFromRequest(request: IncomingMessage, cookieName: string): string | null {
  const cookieHeader = request.headers.cookie;
  if (cookieHeader === undefined || Buffer.byteLength(cookieHeader, "utf8") > MAX_COOKIE_HEADER_BYTES) return null;
  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rawValueParts] = part.trim().split("=");
    if (rawName !== cookieName) continue;
    const value = rawValueParts.join("=");
    if (!/^[A-Za-z0-9_-]{32,128}$/u.test(value)) return null;
    return value;
  }
  return null;
}

function parseExpiresAt(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  return isoDateMillis(value);
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength) || Number(contentLength) > MAX_JSON_REQUEST_BYTES) {
      request.resume();
      throw new RelayHttpError(413, "request_too_large");
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += bytes.byteLength;
    if (total > MAX_JSON_REQUEST_BYTES) {
      request.resume();
      throw new RelayHttpError(413, "request_too_large");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

class RelayHttpError extends Error {
  constructor(readonly statusCode: number, readonly code: string) {
    super(code);
  }
}

function headersForSecurity(cacheControl = "no-store"): Record<string, string> {
  return {
    "Cache-Control": cacheControl,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
}

function isJsonContentType(value: unknown): value is string {
  return typeof value === "string" && /^application\/json(?:\s*;|$)/iu.test(value);
}

function isAllowedAssetContentType(value: string): boolean {
  return value === "image/png" || value === "image/jpeg" || value === "image/webp" || value === "image/gif"
    || value === "application/pdf" || value === "application/octet-stream" || value === "text/plain";
}

function normalisePublicOrigin(value: string): URL {
  const url = new URL(value);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== ""
    || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("RELAY_PUBLIC_ORIGIN must be an origin without a path, query, or fragment");
  }
  if (url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("HTTP is permitted only for localhost development; public relay origins must use HTTPS");
  }
  return url;
}

export interface RelayServerHandle {
  server: Server;
  listen(): Promise<void>;
  close(): Promise<void>;
}

/** Create a no-log allowlisted HTTPS/WSS relay endpoint for outbound Hosts. */
export function createRelayServer(config: RelayServerConfig): RelayServerHandle {
  const publicOrigin = normalisePublicOrigin(config.publicOrigin);
  const listenHost = config.listenHost ?? "127.0.0.1";
  const listenPort = config.listenPort ?? 8787;
  const requestTimeoutMs = config.requestTimeoutMs ?? 45_000;
  const webRoot = config.webRoot === undefined ? undefined : resolve(config.webRoot);
  const cookieName = publicOrigin.protocol === "https:" ? "__Host-harness_relay_session" : "harness_relay_session";
  const peers = new Map<string, HostPeer>();
  const pairingByHash = new Map<string, PairingRoute>();
  const pairingByPublicId = new Map<string, PairRequestRoute>();
  const sessionsByCookieHash = new Map<string, HostSessionRoute>();
  const sessionExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const websocketServer = new WebSocketServer({
    noServer: true,
    clientTracking: true,
    maxPayload: MAX_WIRE_MESSAGE_BYTES,
    perMessageDeflate: false,
  });

  const sendToHost = (peer: HostPeer, message: RelayToHostMessage): boolean => {
    if (peer.socket.readyState !== WebSocket.OPEN || peers.get(peer.hostId) !== peer) return false;
    if (peer.socket.bufferedAmount > MAX_HOST_BACKPRESSURE_BYTES) return false;
    const serialized = JSON.stringify(message);
    if (Buffer.byteLength(serialized, "utf8") > MAX_WIRE_MESSAGE_BYTES) return false;
    peer.socket.send(serialized, { compress: false }, (error) => {
      if (error !== null && error !== undefined) peer.socket.terminate();
    });
    return true;
  };

  const endSubscriber = (peer: HostPeer, subscriber: SseSubscriber, shouldUnsubscribe = true): void => {
    if (!peer.subscriptions.delete(subscriber.subscriptionId)) return;
    clearInterval(subscriber.heartbeat);
    if (shouldUnsubscribe && peers.get(peer.hostId) === peer && peer.socket.readyState === WebSocket.OPEN) {
      sendToHost(peer, { type: "bridge.unsubscribe", subscriptionId: subscriber.subscriptionId });
    }
    if (!subscriber.response.writableEnded) subscriber.response.end();
  };

  const closeSessionSubscribers = (cookieHash: string): void => {
    for (const peer of peers.values()) {
      for (const subscriber of [...peer.subscriptions.values()]) {
        if (subscriber.sessionCookieHash === cookieHash) endSubscriber(peer, subscriber);
      }
    }
  };

  const clearSession = (cookieHash: string): void => {
    sessionsByCookieHash.delete(cookieHash);
    const expiryTimer = sessionExpiryTimers.get(cookieHash);
    if (expiryTimer !== undefined) clearTimeout(expiryTimer);
    sessionExpiryTimers.delete(cookieHash);
    closeSessionSubscribers(cookieHash);
  };

  const scheduleSessionExpiry = (cookieHash: string, expiresAt: number): void => {
    const delay = Math.min(Math.max(0, expiresAt - Date.now()), 2_147_000_000);
    const timer = setTimeout(() => {
      sessionExpiryTimers.delete(cookieHash);
      const session = sessionsByCookieHash.get(cookieHash);
      if (session === undefined) return;
      if (session.expiresAt <= Date.now()) clearSession(cookieHash);
      else scheduleSessionExpiry(cookieHash, session.expiresAt);
    }, delay);
    timer.unref?.();
    sessionExpiryTimers.set(cookieHash, timer);
  };

  const writeJson = (response: ServerResponse, statusCode: number, value: JsonObject, extraHeaders: Record<string, string> = {}): void => {
    if (response.writableEnded) return;
    const body = safeJsonBytes(value);
    response.writeHead(statusCode, {
      ...headersForSecurity(),
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(body.byteLength),
      ...extraHeaders,
    });
    response.end(body);
  };

  const writeError = (response: ServerResponse, statusCode: number, code: string, extraHeaders: Record<string, string> = {}): void => {
    writeJson(response, statusCode, { error: code }, extraHeaders);
  };

  const expiredSessionCookieHeader = (): Record<string, string> => {
    const secure = publicOrigin.protocol === "https:" ? "; Secure" : "";
    return { "Set-Cookie": `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}` };
  };

  const cleanupPending = (peer: HostPeer, requestId: string, outcomeUnknown: boolean): void => {
    const pending = peer.pending.get(requestId);
    if (pending === undefined) return;
    peer.pending.delete(requestId);
    clearTimeout(pending.timer);
    if (pending.sessionCookieHash !== undefined && pending.route.method === "DELETE" && pending.route.path === "/api/session") {
      clearSession(pending.sessionCookieHash);
    }
    if (!pending.response.writableEnded && !pending.response.destroyed) {
      const extra = outcomeUnknown ? { "X-Harness-Outcome": "unknown" } : {};
      writeError(pending.response, outcomeUnknown ? 504 : 503, outcomeUnknown ? "outcome_unknown_refresh_state" : "host_disconnected", extra);
    }
  };

  const dispatch = (
    peer: HostPeer,
    request: Omit<RelayBridgeRequest, "type" | "requestId">,
    response: ServerResponse,
    route: AllowedApiRoute,
    options: Pick<PendingRequest, "creatingPairRequest" | "creatingSession" | "publicRequestId" | "pairRequest" | "sessionCookieHash">,
  ): void => {
    if (peer.socket.readyState !== WebSocket.OPEN || peers.get(peer.hostId) !== peer) {
      writeError(response, 503, "host_unavailable");
      return;
    }
    if (peer.pending.size >= MAX_PENDING_PER_HOST) {
      writeError(response, 503, "host_busy");
      return;
    }
    const requestId = randomUUID();
    const timer = setTimeout(() => cleanupPending(peer, requestId, request.method === "POST"), requestTimeoutMs);
    const pending: PendingRequest = { response, timer, route, ...options };
    peer.pending.set(requestId, pending);
    response.on("close", () => {
      if (response.writableEnded) return;
      const current = peer.pending.get(requestId);
      if (current === undefined) return;
      peer.pending.delete(requestId);
      clearTimeout(current.timer);
      // A browser disconnect does not cancel or replay a request already sent to Host.
    });
    const sent = sendToHost(peer, { type: "bridge.request", requestId, ...request });
    if (!sent) cleanupPending(peer, requestId, request.method === "POST");
    timer.unref?.();
  };

  const processHostResponse = (peer: HostPeer, responseMessage: RelayBridgeResponse): void => {
    const pending = peer.pending.get(responseMessage.requestId);
    if (pending === undefined) return;
    peer.pending.delete(responseMessage.requestId);
    clearTimeout(pending.timer);
    const response = pending.response;
    if (response.writableEnded || response.destroyed) return;
    if (pending.route.method === "GET"
      && pending.sessionCookieHash !== undefined
      && !sessionsByCookieHash.has(pending.sessionCookieHash)) {
      writeError(response, 401, "session_required", expiredSessionCookieHeader());
      return;
    }
    const statusCode = responseMessage.statusCode;
    const invalidatedSessionHeaders = statusCode === 401 && pending.sessionCookieHash !== undefined
      ? expiredSessionCookieHeader()
      : {};
    if (Object.keys(invalidatedSessionHeaders).length > 0 && pending.sessionCookieHash !== undefined) {
      clearSession(pending.sessionCookieHash);
    }
    if (pending.route.kind === "asset") {
      if (statusCode >= 400 && responseMessage.bodyBase64 === undefined && responseMessage.body !== undefined) {
        const errorBytes = Buffer.from(responseMessage.body, "utf8");
        const errorBody = isJsonContentType(responseMessage.contentType)
          ? parseBoundedJson(errorBytes, MAX_JSON_RESPONSE_BYTES)
          : null;
        if (errorBody === null || errorBytes.byteLength > MAX_JSON_RESPONSE_BYTES) {
          writeError(response, 502, "invalid_host_asset_error");
          return;
        }
        writeJson(response, statusCode, errorBody, invalidatedSessionHeaders);
        return;
      }
      if (responseMessage.body !== undefined || responseMessage.bodyBase64 === undefined || !isAllowedAssetContentType(responseMessage.contentType)) {
        writeError(response, 502, "invalid_host_asset_response");
        return;
      }
      const bytes = Buffer.from(responseMessage.bodyBase64, "base64");
      if (bytes.byteLength > MAX_ASSET_RESPONSE_BYTES || bytes.toString("base64") !== responseMessage.bodyBase64) {
        writeError(response, 502, "host_asset_too_large");
        return;
      }
      response.writeHead(statusCode, {
        ...headersForSecurity(),
        "Content-Type": responseMessage.contentType,
        "Content-Length": String(bytes.byteLength),
        ...invalidatedSessionHeaders,
        ...(responseMessage.contentType.startsWith("image/") ? {} : { "Content-Disposition": "attachment; filename=\"run-asset\"" }),
      });
      response.end(bytes);
      return;
    }
    if (responseMessage.bodyBase64 !== undefined) {
      writeError(response, 502, "invalid_host_json_response");
      return;
    }
    const bodyText = responseMessage.body ?? "";
    const bodyBytes = Buffer.from(bodyText, "utf8");
    if (bodyBytes.byteLength > MAX_JSON_RESPONSE_BYTES || !isJsonContentType(responseMessage.contentType)) {
      writeError(response, 502, "invalid_host_json_response");
      return;
    }
    let body = bodyText.length === 0 ? null : parseBoundedJson(bodyBytes, MAX_JSON_RESPONSE_BYTES);
    if (bodyText.length > 0 && body === null) {
      writeError(response, 502, "invalid_host_json_response");
      return;
    }

    if (pending.creatingPairRequest && statusCode >= 200 && statusCode < 300) {
      if (body === null || typeof body.requestId !== "string" || !isValidIdentifier(body.requestId)) {
        writeError(response, 502, "invalid_pairing_response");
        return;
      }
      const hostRequestId = body.requestId;
      const relayRequestId = randomUUID();
      const expiresAt = parseExpiresAt(body.expiresAt) ?? Date.now() + MAX_PAIRING_TTL_MS;
      const status = body.status === "pending_local_confirmation" ? body.status : "pending_local_confirmation";
      if (expiresAt <= Date.now() || expiresAt > Date.now() + MAX_PAIRING_TTL_MS) {
        writeError(response, 502, "invalid_pairing_expiry");
        return;
      }
      pairingByPublicId.set(relayRequestId, { hostId: peer.hostId, hostRequestId, expiresAt });
      body = { requestId: relayRequestId, status, expiresAt: new Date(expiresAt).toISOString() };
    }

    if (pending.pairRequest !== undefined && pending.publicRequestId !== undefined && body !== null
      && typeof body.requestId === "string" && body.requestId === pending.pairRequest.hostRequestId) {
      body.requestId = pending.publicRequestId;
    }

    let extraHeaders: Record<string, string> = invalidatedSessionHeaders;
    if (pending.creatingSession && statusCode >= 200 && statusCode < 300) {
      if (body === null
        || !isValidIdentifier(body.deviceId)
        || typeof body.sessionToken !== "string"
        || !/^[A-Za-z0-9_-]{32,256}$/u.test(body.sessionToken)
        || typeof body.csrfToken !== "string"
        || !/^[A-Za-z0-9_-]{16,256}$/u.test(body.csrfToken)) {
        writeError(response, 502, "invalid_session_response");
        return;
      }
      const expiresAt = parseExpiresAt(body.expiresAt);
      if (expiresAt === null || expiresAt <= Date.now() || expiresAt > Date.now() + MAX_SESSION_TTL_MS) {
        writeError(response, 502, "invalid_session_expiry");
        return;
      }
      const relayCookie = randomBytes(32).toString("base64url");
      const relayCookieHash = hashSecret(relayCookie);
      const sessionToken = body.sessionToken;
      for (const [existingCookieHash, existingSession] of sessionsByCookieHash) {
        if (existingSession.hostId === peer.hostId && existingSession.deviceId === body.deviceId) {
          clearSession(existingCookieHash);
        }
      }
      sessionsByCookieHash.set(relayCookieHash, {
        hostId: peer.hostId,
        deviceId: body.deviceId,
        sessionToken,
        sessionTokenHash: hashSecret(sessionToken),
        csrfToken: body.csrfToken,
        expiresAt,
      });
      scheduleSessionExpiry(relayCookieHash, expiresAt);
      delete body.sessionToken;
      body = { csrfToken: body.csrfToken, expiresAt: new Date(expiresAt).toISOString() };
      if (pending.publicRequestId !== undefined) pairingByPublicId.delete(pending.publicRequestId);
      const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
      const secure = publicOrigin.protocol === "https:" ? "; Secure" : "";
      extraHeaders = { "Set-Cookie": `${cookieName}=${relayCookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}` };
    }

    if (pending.route.method === "DELETE" && pending.publicRequestId !== undefined && statusCode >= 200 && statusCode < 300) {
      pairingByPublicId.delete(pending.publicRequestId);
    }

    if (pending.sessionCookieHash !== undefined && pending.route.path === "/api/session" && body !== null) {
      const session = sessionsByCookieHash.get(pending.sessionCookieHash);
      if (session !== undefined && typeof body.csrfToken === "string" && /^[A-Za-z0-9_-]{16,256}$/u.test(body.csrfToken)) {
        session.csrfToken = body.csrfToken;
      }
    }
    if (pending.route.method === "DELETE" && pending.route.path === "/api/session" && statusCode >= 200 && statusCode < 300) {
      if (pending.sessionCookieHash !== undefined) clearSession(pending.sessionCookieHash);
      const secure = publicOrigin.protocol === "https:" ? "; Secure" : "";
      extraHeaders = { "Set-Cookie": `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}` };
    }
    if (body === null) {
      response.writeHead(statusCode, { ...headersForSecurity(), "Content-Length": "0", ...extraHeaders });
      response.end();
      return;
    }
    const bytes = safeJsonBytes(body);
    response.writeHead(statusCode, {
      ...headersForSecurity(),
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(bytes.byteLength),
      ...extraHeaders,
    });
    response.end(bytes);
  };

  const closePeer = (peer: HostPeer, code: number, reason: string): void => {
    clearTimeout(peer.helloTimer);
    if (peers.get(peer.hostId) === peer) peers.delete(peer.hostId);
    for (const [requestId] of peer.pending) cleanupPending(peer, requestId, true);
    for (const subscriber of [...peer.subscriptions.values()]) endSubscriber(peer, subscriber, false);
    for (const [hash, pairing] of pairingByHash) {
      if (pairing.hostId === peer.hostId) pairingByHash.delete(hash);
    }
    if (peer.socket.readyState < WebSocket.CLOSING) peer.socket.close(code, reason);
  };

  const handleHostMessage = (peer: HostPeer, value: HostEnvelope | null): void => {
    if (value === null) {
      peer.socket.close(1009, "message too large or invalid JSON");
      return;
    }
    const now = Date.now();
    if (now - peer.messageWindowStart >= 1000) {
      peer.messageWindowStart = now;
      peer.messagesInWindow = 0;
    }
    peer.messagesInWindow += 1;
    if (peer.messagesInWindow > 600) {
      peer.socket.close(1008, "message rate exceeded");
      return;
    }
    if (!peer.authenticated) {
      if (!isHostHello(value) || value.protocolVersion !== RELAY_PROTOCOL_VERSION) {
        peer.socket.send(JSON.stringify({ type: "relay.error", code: "INVALID_MESSAGE" }));
        peer.socket.close(1008, "invalid host hello");
        return;
      }
      const configuredCredential = config.hostCredentials.get(value.hostId);
      if (configuredCredential === undefined || !safeEqual(configuredCredential, value.credential)) {
        peer.socket.send(JSON.stringify({ type: "relay.error", code: "UNAUTHORIZED" }));
        peer.socket.close(1008, "unauthorized");
        return;
      }
      const existing = peers.get(value.hostId);
      if (existing !== undefined && existing !== peer) closePeer(existing, 1012, "Host connection replaced");
      peer.authenticated = true;
      peer.hostId = value.hostId;
      clearTimeout(peer.helloTimer);
      peers.set(peer.hostId, peer);
      peer.socket.send(JSON.stringify({ type: "relay.ready", protocolVersion: RELAY_PROTOCOL_VERSION, hostId: peer.hostId }));
      return;
    }
    if (peers.get(peer.hostId) !== peer) {
      peer.socket.close(1012, "Host connection is no longer active");
      return;
    }

    if (value.type === "host.pairing.register" && validHostPairingRegister(value)) {
      const prior = peer.pairings.get(value.pairingId);
      if (prior !== undefined) pairingByHash.delete(prior.tokenHash);
      const collision = pairingByHash.get(value.tokenHash);
      if (collision !== undefined && collision.hostId !== peer.hostId) {
        peer.socket.send(JSON.stringify({ type: "relay.error", code: "INVALID_MESSAGE" }));
        return;
      }
      const pairing: PairingRoute = {
        hostId: peer.hostId,
        pairingId: value.pairingId,
        tokenHash: value.tokenHash,
        expiresAt: value.expiresAt,
      };
      peer.pairings.set(value.pairingId, pairing);
      pairingByHash.set(value.tokenHash, pairing);
      peer.socket.send(JSON.stringify({ type: "relay.pairing.registered", pairingId: value.pairingId, expiresAt: value.expiresAt }));
      return;
    }
    if (isValidPairingUnregister(value)) {
      const pairing = peer.pairings.get(value.pairingId);
      if (pairing !== undefined) {
        peer.pairings.delete(value.pairingId);
        pairingByHash.delete(pairing.tokenHash);
      }
      return;
    }
    if (isSessionRevoke(value)) {
      let revokedCount = 0;
      for (const [cookieHash, session] of sessionsByCookieHash) {
        if (session.hostId !== peer.hostId || session.deviceId !== value.deviceId) continue;
        if (value.sessionTokenHash !== undefined && session.sessionTokenHash !== value.sessionTokenHash) continue;
        clearSession(cookieHash);
        revokedCount += 1;
      }
      peer.socket.send(JSON.stringify({
        type: "relay.session.revoked",
        deviceId: value.deviceId,
        ...(value.sessionTokenHash === undefined ? {} : { sessionTokenHash: value.sessionTokenHash }),
        revokedCount,
      }));
      return;
    }
    if (isValidBridgeResponse(value)) {
      processHostResponse(peer, value);
      return;
    }
    if (isValidBridgeEvent(value)) {
      const subscriber = peer.subscriptions.get(value.subscriptionId);
      if (subscriber === undefined || subscriber.runId !== value.runId) return;
      const data = JSON.stringify(value.event);
      if (Buffer.byteLength(data, "utf8") > MAX_SSE_EVENT_BYTES || subscriber.response.writableLength > MAX_SSE_BACKPRESSURE_BYTES) {
        endSubscriber(peer, subscriber);
        return;
      }
      if (value.control === "resync_required") {
        subscriber.response.write(`event: resync_required\ndata: ${data}\n\n`);
        return;
      }
      if (typeof value.sequence !== "number") return;
      if (value.sequence <= subscriber.lastSequence) return;
      subscriber.lastSequence = value.sequence;
      subscriber.response.write(`id: ${value.sequence}\ndata: ${data}\n\n`);
      return;
    }
    if (value.type === "host.hello") {
      // A connection cannot change Host identities after it is authenticated.
      peer.socket.close(1008, "host identity cannot change");
      return;
    }
    peer.socket.send(JSON.stringify({ type: "relay.error", code: "INVALID_MESSAGE" }));
  };

  const handleWebSocketUpgrade = (request: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): void => {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", publicOrigin);
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== "/v1/host" || url.search !== "" || request.headers.origin !== undefined) {
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      const peer: HostPeer = {
        hostId: "pending",
        socket: websocket,
        authenticated: false,
        helloTimer: setTimeout(() => websocket.close(1008, "host hello timeout"), HOST_HELLO_TIMEOUT_MS),
        pairings: new Map(),
        pending: new Map(),
        subscriptions: new Map(),
        messageWindowStart: Date.now(),
        messagesInWindow: 0,
      };
      websocket.on("message", (data) => handleHostMessage(peer, parseWireMessage(data)));
      websocket.on("close", () => closePeer(peer, 1000, "Host disconnected"));
      websocket.on("error", () => closePeer(peer, 1011, "Host socket error"));
    });
  };

  const checkOrigin = (request: IncomingMessage): boolean => {
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== publicOrigin.origin) return false;
    if ((request.method === "POST" || request.method === "PUT" || request.method === "DELETE") && origin !== publicOrigin.origin) return false;
    const host = request.headers.host;
    if (host === undefined || host.toLowerCase() !== publicOrigin.host.toLowerCase()) return false;
    return true;
  };

  const readJsonBody = async (request: IncomingMessage, required: boolean): Promise<JsonObject | undefined> => {
    if (request.method === "GET") {
      const contentLength = request.headers["content-length"];
      if ((contentLength !== undefined && contentLength !== "0") || request.headers["transfer-encoding"] !== undefined) {
        request.resume();
        throw new RelayHttpError(400, "request_body_not_allowed");
      }
      return undefined;
    }
    const contentLength = request.headers["content-length"];
    const hasBody = (contentLength !== undefined && contentLength !== "0") || request.headers["transfer-encoding"] !== undefined;
    if ((request.method === "POST" || hasBody) && !isJsonContentType(request.headers["content-type"])) {
      request.resume();
      throw new RelayHttpError(415, "application_json_required");
    }
    const bytes = await readRequestBody(request);
    if (bytes.byteLength === 0) {
      if (required) throw new RelayHttpError(400, "json_body_required");
      return undefined;
    }
    const body = parseBoundedJson(bytes, MAX_JSON_REQUEST_BYTES);
    if (body === null) throw new RelayHttpError(400, "invalid_json_body");
    return body;
  };

  const expirePairRequestIfNeeded = (requestId: string): PairRequestRoute | null => {
    const pairing = pairingByPublicId.get(requestId);
    if (pairing === undefined) return null;
    if (pairing.expiresAt <= Date.now()) {
      pairingByPublicId.delete(requestId);
      return null;
    }
    return pairing;
  };

  const getSession = (request: IncomingMessage): { cookieHash: string; session: HostSessionRoute } | null => {
    const token = cookieTokenFromRequest(request, cookieName);
    if (token === null) return null;
    const cookieHash = hashSecret(token);
    const session = sessionsByCookieHash.get(cookieHash);
    if (session === undefined) return null;
    if (session.expiresAt <= Date.now()) {
      clearSession(cookieHash);
      return null;
    }
    return { cookieHash, session };
  };

  const serveEvents = (request: IncomingMessage, response: ServerResponse, route: AllowedApiRoute, sessionCookieHash: string, session: HostSessionRoute): void => {
    const peer = peers.get(session.hostId);
    if (peer === undefined || peer.socket.readyState !== WebSocket.OPEN) {
      writeError(response, 503, "host_unavailable");
      return;
    }
    const runId = routeIdentifier(route.path, /^\/api\/runs\/([A-Za-z0-9_-]{1,128})\/events$/u);
    if (runId === null) {
      writeError(response, 404, "route_not_found");
      return;
    }
    const lastEventId = request.headers["last-event-id"];
    const fromHeader = typeof lastEventId === "string" && /^(?:0|[1-9][0-9]{0,18})$/u.test(lastEventId) ? Number(lastEventId) : undefined;
    if (lastEventId !== undefined && fromHeader === undefined) {
      writeError(response, 400, "invalid_event_cursor");
      return;
    }
    const afterSequence = fromHeader ?? Number(route.query.after ?? "0");
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      writeError(response, 400, "invalid_event_cursor");
      return;
    }
    const subscriptionId = randomUUID();
    const subscriber: SseSubscriber = {
      subscriptionId,
      deviceId: session.deviceId,
      runId,
      response,
      sessionCookieHash,
      lastSequence: afterSequence,
      heartbeat: setInterval(() => {
        if (response.writableEnded || response.destroyed || response.writableLength > MAX_SSE_BACKPRESSURE_BYTES) {
          endSubscriber(peer, subscriber);
          return;
        }
        response.write(": keepalive\n\n");
      }, SSE_HEARTBEAT_MS),
    };
    subscriber.heartbeat.unref?.();
    peer.subscriptions.set(subscriptionId, subscriber);
    response.writeHead(200, {
      ...headersForSecurity(),
      "Content-Type": "text/event-stream; charset=utf-8",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();
    response.write(": connected\n\n");
    response.on("close", () => endSubscriber(peer, subscriber));
    const sent = sendToHost(peer, {
      type: "bridge.subscribe",
      subscriptionId,
      deviceId: session.deviceId,
      sessionToken: session.sessionToken,
      runId,
      afterSequence,
    });
    if (!sent) endSubscriber(peer, subscriber, false);
  };

  const handleApi = async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> => {
    const route = resolveAllowedApiRoute(request.method ?? "", request.url ?? "");
    if (route === null) {
      request.resume();
      writeError(response, 404, "route_not_found");
      return;
    }
    const isPairCreate = route.method === "POST" && route.path === "/api/pair/requests";
    const pairRequestId = routeIdentifier(route.path, /^\/api\/pair\/requests\/([A-Za-z0-9_-]{1,128})(?:\/session)?$/u);
    const isPairRoute = route.path.startsWith("/api/pair/requests/");
    const isPairSession = route.path.endsWith("/session") && route.method === "POST";
    const isPairStatus = isPairRoute;

    const body = await readJsonBody(request, request.method === "POST");
    if (isPairCreate) {
      if (body === undefined || typeof body.token !== "string" || !/^[A-Za-z0-9_-]{32,128}$/u.test(body.token)) {
        writeError(response, 401, "invalid_or_expired_pairing_token");
        return;
      }
      const tokenHash = hashSecret(body.token);
      const pairing = pairingByHash.get(tokenHash);
      if (pairing === undefined || pairing.expiresAt <= Date.now()) {
        pairingByHash.delete(tokenHash);
        writeError(response, 401, "invalid_or_expired_pairing_token");
        return;
      }
      const peer = peers.get(pairing.hostId);
      if (peer === undefined || peer.socket.readyState !== WebSocket.OPEN) {
        writeError(response, 503, "host_unavailable");
        return;
      }
      pairingByHash.delete(tokenHash);
      peer.pairings.delete(pairing.pairingId);
      sendToHost(peer, { type: "relay.pairing.consumed", pairingId: pairing.pairingId });
      const forwardedPath = `${route.path}${url.search}`;
      dispatch(peer, {
        method: route.method,
        path: forwardedPath,
        ...(body === undefined ? {} : { body }),
      }, response, route, { creatingPairRequest: true, creatingSession: false });
      return;
    }

    if (isPairStatus) {
      if (pairRequestId === null) {
        writeError(response, 404, "pairing_request_not_found");
        return;
      }
      const pairRequest = expirePairRequestIfNeeded(pairRequestId);
      if (pairRequest === null) {
        writeError(response, 404, "pairing_request_not_found");
        return;
      }
      const peer = peers.get(pairRequest.hostId);
      if (peer === undefined || peer.socket.readyState !== WebSocket.OPEN) {
        writeError(response, 503, "host_unavailable");
        return;
      }
      const hostPath = route.path.replace(pairRequestId, pairRequest.hostRequestId);
      dispatch(peer, { method: route.method, path: `${hostPath}${url.search}`, ...(body === undefined ? {} : { body }) }, response, route, {
        creatingPairRequest: false,
        creatingSession: isPairSession,
        publicRequestId: pairRequestId,
        pairRequest,
      });
      return;
    }

    const selectedSession = getSession(request);
    if (selectedSession === null) {
      writeError(response, 401, "session_required", expiredSessionCookieHeader());
      return;
    }
    const { cookieHash: sessionCookieHash, session } = selectedSession;
    const csrfHeader = request.headers["x-csrf-token"];
    if ((route.method === "POST" || route.method === "PUT" || route.method === "DELETE")
      && (typeof csrfHeader !== "string" || !safeEqual(csrfHeader, session.csrfToken))) {
      writeError(response, 403, "csrf_check_failed");
      return;
    }
    if (!isValidApiRequestBody(route, body)) {
      writeError(response, 400, "invalid_request_body");
      return;
    }
    const peer = peers.get(session.hostId);
    if (peer === undefined || peer.socket.readyState !== WebSocket.OPEN) {
      writeError(response, 503, "host_unavailable");
      return;
    }
    if (route.kind === "sse") {
      serveEvents(request, response, route, sessionCookieHash, session);
      return;
    }
    const hostPath = `${route.path}${url.search}`;
    dispatch(peer, {
      method: route.method,
      path: hostPath,
      deviceId: session.deviceId,
      sessionToken: session.sessionToken,
      ...(typeof csrfHeader === "string" ? { csrfToken: csrfHeader } : {}),
      ...(body === undefined ? {} : { body }),
    }, response, route, {
      creatingPairRequest: false,
      creatingSession: false,
      sessionCookieHash,
    });
  };

  const serveWeb = async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> => {
    if (webRoot === undefined) {
      writeError(response, 503, "web_client_not_built");
      return;
    }
    let relativePath = url.pathname === "/" || url.pathname === "/pair" ? "index.html" : url.pathname.replace(/^\//u, "");
    if (relativePath.includes("\\") || relativePath.includes("%") || relativePath.split("/").some((part) => part === "." || part === "..")) {
      writeError(response, 404, "not_found");
      return;
    }
    let filePath = resolve(webRoot, relativePath);
    const rootPrefix = webRoot.endsWith(sep) ? webRoot : `${webRoot}${sep}`;
    if (filePath !== webRoot && !filePath.startsWith(rootPrefix)) {
      writeError(response, 404, "not_found");
      return;
    }
    try {
      await access(filePath);
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) throw new Error("not a file");
    } catch {
      if (relativePath.includes(".")) {
        writeError(response, 404, "not_found");
        return;
      }
      filePath = resolve(webRoot, "index.html");
    }
    const extension = extname(filePath).toLowerCase();
    const contentType = extension === ".html" ? "text/html; charset=utf-8"
      : extension === ".js" || extension === ".mjs" ? "text/javascript; charset=utf-8"
        : extension === ".css" ? "text/css; charset=utf-8"
          : extension === ".svg" ? "image/svg+xml"
            : extension === ".png" ? "image/png"
              : extension === ".jpg" || extension === ".jpeg" ? "image/jpeg"
                : extension === ".webp" ? "image/webp"
                  : extension === ".ico" ? "image/x-icon"
                    : "application/octet-stream";
    const isHtml = extension === ".html";
    const policy = isHtml
      ? "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
      : undefined;
    response.writeHead(200, {
      ...headersForSecurity(isHtml ? "no-store" : "public, max-age=300, immutable"),
      "Content-Type": contentType,
      ...(policy === undefined ? {} : { "Content-Security-Policy": policy }),
      "Content-Length": String((await stat(filePath)).size),
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    const stream = createReadStream(filePath);
    stream.on("error", () => {
      if (!response.headersSent) writeError(response, 404, "not_found");
      else response.destroy();
    });
    stream.pipe(response);
  };

  const handleHttpRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const rawTarget = request.url ?? "/";
    let url: URL;
    try {
      url = new URL(rawTarget, publicOrigin);
    } catch {
      writeError(response, 400, "invalid_request_target");
      return;
    }
    if (url.origin !== publicOrigin.origin || url.pathname.includes("\\") || url.pathname.includes("%")) {
      request.resume();
      writeError(response, 400, "invalid_request_target");
      return;
    }
    if (!checkOrigin(request)) {
      request.resume();
      writeError(response, 403, "origin_check_failed");
      return;
    }
    if (url.pathname === "/healthz" && request.method === "GET") {
      writeJson(response, 200, { status: "ok" });
      return;
    }
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      if (url.pathname === "/api/local" || url.pathname.startsWith("/api/local/")) {
        request.resume();
        writeError(response, 404, "route_not_found");
        return;
      }
      try {
        await handleApi(request, response, url);
      } catch (error) {
        if (error instanceof RelayHttpError) {
          writeError(response, error.statusCode, error.code);
          return;
        }
        writeError(response, 500, "relay_request_failed");
      }
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      request.resume();
      writeError(response, 404, "not_found");
      return;
    }
    await serveWeb(request, response, url);
  };

  const server = createServer((request, response) => {
    // This service intentionally has no request/access logger. Pairing codes,
    // cookies, task bodies, and screenshots must never enter access logs.
    void handleHttpRequest(request, response);
  });
  server.on("upgrade", handleWebSocketUpgrade);
  server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"));

  const pruneExpired = setInterval(() => {
    const now = Date.now();
    for (const [hash, pairing] of pairingByHash) if (pairing.expiresAt <= now) pairingByHash.delete(hash);
    for (const [id, pairing] of pairingByPublicId) if (pairing.expiresAt <= now) pairingByPublicId.delete(id);
    for (const [hash, session] of sessionsByCookieHash) if (session.expiresAt <= now) clearSession(hash);
  }, 60_000);
  pruneExpired.unref?.();

  return {
    server,
    listen: () => new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(listenPort, listenHost, () => {
        server.off("error", rejectListen);
        resolveListen();
      });
    }),
    close: async () => {
      clearInterval(pruneExpired);
      for (const peer of peers.values()) closePeer(peer, 1001, "relay shutting down");
      for (const cookieHash of [...sessionsByCookieHash.keys()]) clearSession(cookieHash);
      for (const websocket of websocketServer.clients) websocket.close(1001, "relay shutting down");
      await new Promise<void>((resolveClose) => websocketServer.close(() => resolveClose()));
      if (server.listening) await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error === undefined ? resolveClose() : rejectClose(error)));
    },
  };
}
