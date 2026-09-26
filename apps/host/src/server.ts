import { createHash, randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { RemoteRunApiError, type RemoteCommand, type RemoteRunApi } from "@computer-harness/app-runtime";
import type { HostRequestHandler, PairingTokenRegistration, RelayBridgeRequest } from "@computer-harness/relay-connector/protocol";
import { resolveAllowedApiRoute } from "@computer-harness/relay-connector/routing";
import type { PairRequestView, PairedDeviceView } from "./contracts.js";
import { PairingError, PairingStore, hashPairingToken } from "./pairing-store.js";

const DEFAULT_PORT = 4317;
const JSON_BODY_LIMIT = 32 * 1024;
const ASSET_LIMIT = 8 * 1024 * 1024;
const MAX_PAIRING_REQUESTS_PER_MINUTE = 10;
const SESSION_COOKIE = "harness_session";
const SSE_HEARTBEAT_MS = 15_000;
const MAX_TIMEOUT_DELAY_MS = 2_147_000_000;
const MAX_SSE_CLIENTS = 32;
const MAX_SSE_CLIENTS_PER_DEVICE = 3;

export class HostHttpError extends Error {
  public constructor(public readonly statusCode: number, public readonly code: string, message: string) {
    super(message);
    this.name = "HostHttpError";
  }
}

export interface HostServerOptions {
  readonly api: RemoteRunApi;
  /** Exact browser Origins allowed to use the loopback Host API. */
  readonly allowedOrigins: readonly string[];
  /** The public Relay origin used by the authenticated bridge, when enabled. */
  readonly bridgeOrigin?: string;
  /** The QR link must come from configured public Relay or local UI origin, never the Host header. */
  readonly pairingUrlForToken?: (token: string) => string;
  readonly registerPairingToken?: (registration: PairingTokenRegistration) => void | Promise<void>;
  readonly unregisterPairingToken?: (pairingId: string) => void;
  readonly revokeDeviceSession?: (deviceId: string) => void;
  readonly pairing?: PairingStore;
  readonly staticRoot?: string;
  readonly port?: number;
}

export interface HostServerHandle {
  readonly server: FastifyInstance;
  readonly pairing: PairingStore;
  readonly relayHandler: HostRequestHandler;
  listen(): Promise<string>;
  close(): Promise<void>;
}

export function createHostServer(options: HostServerOptions): HostServerHandle {
  const allowedOrigins = new Set(options.allowedOrigins.map(validateOrigin));
  if (allowedOrigins.size === 0) throw new Error("Host requires at least one explicit allowed Origin");
  const localOrigins = new Set([...allowedOrigins].filter(isLoopbackOrigin));
  if (localOrigins.size === 0) throw new Error("Host local administration requires an explicit loopback Origin");
  const bridgeOrigin = options.bridgeOrigin === undefined ? undefined : validateOrigin(options.bridgeOrigin);
  if (bridgeOrigin !== undefined && !allowedOrigins.has(bridgeOrigin)) {
    throw new Error("bridgeOrigin must also be present in allowedOrigins");
  }
  const pairingUrlForToken = options.pairingUrlForToken ?? ((token: string) => {
    const origin = bridgeOrigin ?? [...localOrigins][0]!;
    return new URL("/pair?token=" + encodeURIComponent(token), origin).toString();
  });
  const pairing = options.pairing ?? new PairingStore();
  const server = fastify({ logger: false, bodyLimit: JSON_BODY_LIMIT, disableRequestLogging: true });
  const bridgeSecret = randomBytes(32).toString("base64url");
  const pairingRate = new Map<string, { windowStartedAt: number; count: number }>();
  const pairingIdsByTokenHash = new Map<string, string>();
  const activeStreams = new Map<string, Map<string, Set<() => void>>>();
  let streamCount = 0;
  const staticRoot = options.staticRoot === undefined ? undefined : resolve(options.staticRoot);

  const closeDeviceStreams = (deviceId: string): void => {
    const bySession = activeStreams.get(deviceId);
    if (bySession === undefined) return;
    for (const streams of bySession.values()) for (const close of [...streams]) close();
  };

  const closeSessionStreams = (deviceId: string, sessionKey: string): void => {
    const streams = activeStreams.get(deviceId)?.get(sessionKey);
    if (streams === undefined) return;
    for (const close of [...streams]) close();
  };

  server.addHook("onRequest", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Cross-Origin-Resource-Policy", "same-origin");
  });

  server.setErrorHandler((error, request, reply) => {
    if (error instanceof HostHttpError) {
      void reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof PairingError) {
      void reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof RemoteRunApiError) {
      const status = error.code === "RUN_NOT_FOUND" ? 404
        : error.code === "INVALID_COMMAND" ? 400
          : error.code === "CAPACITY_REACHED" ? 429
            : error.code === "WINDOW_DISCOVERY_FAILED" ? 503
          : 409;
      void reply.code(status).send({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof Error && /body|payload|content-type|json/iu.test(error.message)) {
      void reply.code(400).send({ error: { code: "INVALID_REQUEST", message: "Request body is invalid." } });
      return;
    }
    void reply.code(500).send({ error: { code: "HOST_ERROR", message: "The Host could not complete the request." } });
  });

  const bridgeHandler: HostRequestHandler = {
    api: options.api,
    authorizeSession: (deviceId, sessionToken) => pairing.authenticateSession(sessionToken)?.deviceId === deviceId,
    async request(request: RelayBridgeRequest) {
      const route = resolveAllowedApiRoute(request.method, request.path);
      if (route === null || route.kind === "sse") {
        return { statusCode: 404, contentType: "application/json; charset=utf-8", body: { error: { code: "ROUTE_NOT_FOUND", message: "Route is unavailable." } } };
      }
      const headers: Record<string, string> = {
        origin: bridgeOrigin ?? [...allowedOrigins][0]!,
        "x-harness-bridge": bridgeSecret,
        "sec-fetch-site": "same-origin",
      };
      if (request.sessionToken !== undefined) headers.cookie = SESSION_COOKIE + "=" + request.sessionToken;
      if (request.deviceId !== undefined) headers["x-harness-device-id"] = request.deviceId;
      if (request.csrfToken !== undefined) headers["x-csrf-token"] = request.csrfToken;
      const injected = await server.inject({
        method: request.method,
        url: request.path,
        headers,
        ...(request.body === undefined ? {} : { payload: request.body }),
      });
      const contentType = injected.headers["content-type"]?.toString() ?? "application/json; charset=utf-8";
      if (route.kind === "asset") {
        const bytes = injected.rawPayload;
        if (bytes.byteLength > ASSET_LIMIT) {
          return { statusCode: 413, contentType: "application/json; charset=utf-8", body: { error: { code: "ASSET_TOO_LARGE", message: "Asset exceeds the transfer limit." } } };
        }
        return { statusCode: injected.statusCode, contentType, bytes: new Uint8Array(bytes) };
      }
      if (injected.statusCode === 204 || injected.payload.length === 0) {
        return { statusCode: injected.statusCode, contentType };
      }
      let body: unknown;
      try {
        body = injected.json();
      } catch {
        body = { error: { code: "HOST_ERROR", message: "The Host returned an invalid response." } };
      }
      return { statusCode: injected.statusCode, contentType, body };
    },
  };

  const assertLoopback = (request: FastifyRequest): void => {
    const remoteAddress = request.raw.socket.remoteAddress ?? request.ip;
    if (!isLoopbackAddress(remoteAddress)) throw new HostHttpError(403, "LOCAL_ONLY", "This control surface is available only on the Host computer.");
  };

  const assertLocalOrigin = (request: FastifyRequest, requireOrigin: boolean): void => {
    const fetchSite = request.headers["sec-fetch-site"];
    if (fetchSite === "cross-site") throw new HostHttpError(403, "ORIGIN_REJECTED", "Cross-site local requests are not allowed.");
    const origin = request.headers.origin;
    if (origin === undefined && !requireOrigin) return;
    if (origin === undefined || !localOrigins.has(origin)) throw new HostHttpError(403, "ORIGIN_REJECTED", "Request Origin is not allowed.");
  };

  const assertPublicOrigin = (request: FastifyRequest, requireOrigin: boolean): void => {
    const fetchSite = request.headers["sec-fetch-site"];
    if (fetchSite === "cross-site") throw new HostHttpError(403, "ORIGIN_REJECTED", "Cross-site requests are not allowed.");
    const origin = request.headers.origin;
    if (origin === undefined && !requireOrigin) return;
    if (origin === undefined || !allowedOrigins.has(origin)) throw new HostHttpError(403, "ORIGIN_REJECTED", "Request Origin is not allowed.");
  };

  const adminRequest = (request: FastifyRequest, write: boolean): void => {
    assertLoopback(request);
    assertLocalOrigin(request, write);
    if (write && !safeEqual(request.headers["x-csrf-token"], pairing.adminCsrfToken)) {
      throw new HostHttpError(403, "CSRF_REJECTED", "Local request verification failed.");
    }
  };

  const browserSession = (request: FastifyRequest, write: boolean): { deviceId: string; csrfToken: string; sessionKey: string; expiresAt: string } => {
    assertLoopback(request);
    assertPublicOrigin(request, write);
    const token = parseCookie(request.headers.cookie, SESSION_COOKIE);
    const session = pairing.authenticateSession(token);
    if (session === undefined) throw new HostHttpError(401, "SESSION_REQUIRED", "Pair this device with the Host computer first.");
    const isBridge = request.headers["x-harness-bridge"] === bridgeSecret;
    const forwardedDeviceId = request.headers["x-harness-device-id"];
    if (isBridge && forwardedDeviceId !== undefined && forwardedDeviceId !== session.deviceId) {
      throw new HostHttpError(401, "SESSION_INVALID", "Paired device session is invalid.");
    }
    const csrfHeader = request.headers["x-csrf-token"];
    const csrfToken = typeof csrfHeader === "string" ? csrfHeader : undefined;
    if (write && (!pairing.isDeviceCsrfValid(session.deviceId, csrfToken) ||
        !safeEqual(csrfToken, session.csrfToken))) {
      throw new HostHttpError(403, "CSRF_REJECTED", "Request verification failed.");
    }
    return {
      deviceId: session.deviceId,
      csrfToken: session.csrfToken,
      sessionKey: hashSessionToken(token!),
      expiresAt: session.expiresAt,
    };
  };

  const revalidateBrowserSession = (
    request: FastifyRequest,
    session: { deviceId: string; sessionKey: string },
  ): void => {
    const token = parseCookie(request.headers.cookie, SESSION_COOKIE);
    const current = pairing.authenticateSession(token);
    if (current === undefined || current.deviceId !== session.deviceId || hashSessionToken(token!) !== session.sessionKey) {
      throw new HostHttpError(401, "SESSION_INVALID", "Paired device session is no longer valid.");
    }
  };

  const checkPairRequestRate = (request: FastifyRequest): void => {
    const key = request.ip;
    const now = Date.now();
    const existing = pairingRate.get(key);
    if (existing === undefined || now - existing.windowStartedAt >= 60_000) {
      pairingRate.set(key, { windowStartedAt: now, count: 1 });
      return;
    }
    existing.count += 1;
    if (existing.count > MAX_PAIRING_REQUESTS_PER_MINUTE) throw new HostHttpError(429, "PAIRING_RATE_LIMIT", "Too many pairing attempts. Try again shortly.");
  };

  const bodyObject = (value: unknown): Record<string, unknown> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new HostHttpError(400, "INVALID_REQUEST", "A JSON object is required.");
    }
    return value as Record<string, unknown>;
  };

  const requiredString = (body: Record<string, unknown>, field: string, maxLength: number): string => {
    const value = body[field];
    if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
      throw new HostHttpError(400, "INVALID_REQUEST", "Field " + field + " is invalid.");
    }
    return value;
  };

  const pathId = (request: FastifyRequest, key: string): string => {
    const params = request.params as Record<string, unknown>;
    const value = params[key];
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
      throw new HostHttpError(404, "NOT_FOUND", "Resource was not found.");
    }
    return value;
  };

  const bridge = (request: FastifyRequest): boolean => request.headers["x-harness-bridge"] === bridgeSecret;

  const createPairing = async (request: FastifyRequest) => {
    adminRequest(request, true);
    const previous = pairing.getState().activeChallenge;
    if (previous !== undefined) {
      options.unregisterPairingToken?.(previous.challengeId);
    }
    const challenge = pairing.createPairing(pairingUrlForToken);
    pairingIdsByTokenHash.set(challenge.tokenHash, challenge.challengeId);
    try {
      await options.registerPairingToken?.({
        pairingId: challenge.challengeId,
        tokenHash: challenge.tokenHash,
        expiresAt: Date.parse(challenge.expiresAt),
      });
    } catch {
      pairing.cancelChallenge(challenge.challengeId);
      pairingIdsByTokenHash.delete(challenge.tokenHash);
      throw new HostHttpError(503, "RELAY_UNAVAILABLE", "The pairing route is not ready. Check the Relay connection and try again.");
    }
    return { challengeId: challenge.challengeId, pairingUrl: challenge.pairingUrl, expiresAt: challenge.expiresAt };
  };

  server.get("/api/local/session", async (request) => {
    adminRequest(request, false);
    return { csrfToken: pairing.adminCsrfToken };
  });

  server.post("/api/local/pairing", async (request) => createPairing(request));

  server.get("/api/local/pairing", async (request) => {
    adminRequest(request, false);
    const state = pairing.getState();
    return {
      ...(state.activeChallenge === undefined ? {} : {
        activeChallenge: {
          challengeId: state.activeChallenge.challengeId,
          expiresAt: state.activeChallenge.expiresAt,
        },
      }),
      requests: state.requests.map(localPairRequest),
    };
  });

  server.post<{ Params: { requestId: string } }>("/api/local/pairing/requests/:requestId/confirm", async (request) => {
    adminRequest(request, true);
    const requestId = pathId(request, "requestId");
    const body = bodyObject(request.body);
    if (typeof body.approved !== "boolean") throw new HostHttpError(400, "INVALID_REQUEST", "approved must be a boolean.");
    const label = body.label === undefined ? undefined : requiredString(body, "label", 64);
    const result = pairing.confirmRequest(requestId, body.approved, label);
    return {
      requestId: result.requestId,
      status: result.status === "pending_local_confirmation" ? "pending" : result.status,
      ...(result.deviceId === undefined ? {} : { deviceId: result.deviceId }),
    };
  });

  server.get("/api/local/devices", async (request) => {
    adminRequest(request, false);
    return { devices: pairing.listDevices() satisfies readonly PairedDeviceView[] };
  });

  server.delete<{ Params: { deviceId: string } }>("/api/local/devices/:deviceId", async (request, reply) => {
    adminRequest(request, true);
    const deviceId = pathId(request, "deviceId");
    if (!pairing.revokeDevice(deviceId)) throw new HostHttpError(404, "DEVICE_NOT_FOUND", "Paired device was not found.");
    closeDeviceStreams(deviceId);
    options.revokeDeviceSession?.(deviceId);
    return reply.code(204).send();
  });

  server.post("/api/pair/requests", async (request, reply) => {
    assertLoopback(request);
    assertPublicOrigin(request, true);
    checkPairRequestRate(request);
    const body = bodyObject(request.body);
    const token = requiredString(body, "token", 128);
    const clientName = requiredString(body, "clientName", 64);
    const tokenHash = hashPairingToken(token);
    const result = pairing.requestPairing(token, clientName);
    const pairingId = pairingIdsByTokenHash.get(tokenHash);
    if (pairingId !== undefined) {
      pairingIdsByTokenHash.delete(tokenHash);
      options.unregisterPairingToken?.(pairingId);
    }
    return reply.code(202).send(result);
  });

  server.get<{ Params: { requestId: string } }>("/api/pair/requests/:requestId", async (request) => {
    assertLoopback(request);
    assertPublicOrigin(request, false);
    const requestId = pathId(request, "requestId");
    const result = pairing.getRequest(requestId);
    if (result === undefined) throw new HostHttpError(404, "PAIRING_REQUEST_NOT_FOUND", "Pairing request was not found.");
    return result;
  });

  server.post<{ Params: { requestId: string } }>("/api/pair/requests/:requestId/session", async (request, reply) => {
    assertLoopback(request);
    assertPublicOrigin(request, true);
    const requestId = pathId(request, "requestId");
    const session = pairing.issueSession(requestId);
    // Session issuance rotates the device credential. Any SSE stream bound to
    // the prior credential must be ended before the new one is exposed.
    closeDeviceStreams(session.deviceId);
    const isBridge = bridge(request);
    if (isBridge) {
      return {
        deviceId: session.deviceId,
        sessionToken: session.sessionToken,
        csrfToken: session.csrfToken,
        expiresAt: session.expiresAt,
      };
    }
    setSessionCookie(reply, session.sessionToken, session.expiresAt, isSecureOrigin(request.headers.origin));
    return {
      deviceId: session.deviceId,
      deviceName: session.label,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
    };
  });

  server.get("/api/session", async (request) => {
    const session = browserSession(request, false);
    const details = pairing.authenticateSession(parseCookie(request.headers.cookie, SESSION_COOKIE));
    if (details === undefined) throw new HostHttpError(401, "SESSION_REQUIRED", "This device is no longer paired.");
    return { deviceId: session.deviceId, deviceName: details.label, csrfToken: details.csrfToken, expiresAt: details.expiresAt };
  });

  server.delete("/api/session", async (request, reply) => {
    const session = browserSession(request, true);
    pairing.revokeDevice(session.deviceId);
    closeSessionStreams(session.deviceId, session.sessionKey);
    closeDeviceStreams(session.deviceId);
    options.revokeDeviceSession?.(session.deviceId);
    clearSessionCookie(reply, isSecureOrigin(request.headers.origin));
    return reply.code(204).send();
  });

  server.get("/api/runs", async (request) => {
    const session = browserSession(request, false);
    const runs = await options.api.listRuns(session.deviceId);
    return { runs };
  });

  server.get("/api/windows", async (request) => {
    const session = browserSession(request, false);
    const choices = await options.api.listWindowTargets(session.deviceId);
    revalidateBrowserSession(request, session);
    return choices;
  });

  server.post("/api/runs", async (request, reply) => {
    const session = browserSession(request, true);
    const body = bodyObject(request.body);
    if (Object.keys(body).some((key) => key !== "commandId" && key !== "goal" && key !== "targetToken")) {
      throw new HostHttpError(400, "INVALID_REQUEST", "Only commandId, goal, and targetToken are accepted.");
    }
    const commandId = requiredString(body, "commandId", 128);
    const goal = requiredString(body, "goal", 20_000);
    const targetToken = requiredString(body, "targetToken", 128);
    const run = await options.api.startRun(session.deviceId, commandId, goal, targetToken);
    return reply.code(202).send({ runId: run.runId, status: run.status });
  });

  server.get<{ Params: { runId: string } }>("/api/runs/:runId", async (request) => {
    const session = browserSession(request, false);
    const runId = pathId(request, "runId");
    const run = await options.api.getRun(session.deviceId, runId);
    if (run === undefined) throw new HostHttpError(404, "RUN_NOT_FOUND", "Run was not found.");
    return run;
  });

  server.get<{ Params: { runId: string; commandId: string } }>("/api/runs/:runId/commands/:commandId", async (request) => {
    const session = browserSession(request, false);
    const runId = pathId(request, "runId");
    const commandId = pathId(request, "commandId");
    const receipt = await options.api.getCommandReceipt(session.deviceId, runId, commandId);
    if (receipt === undefined) throw new HostHttpError(404, "COMMAND_NOT_FOUND", "Command receipt was not found.");
    return receipt;
  });

  server.post<{ Params: { runId: string } }>("/api/runs/:runId/commands", async (request, reply) => {
    const session = browserSession(request, true);
    const runId = pathId(request, "runId");
    const command = parseCommand(request.body);
    const receipt = await options.api.submitCommand(session.deviceId, runId, command);
    return reply.code(202).send({ receipt });
  });

  server.get<{ Params: { runId: string; assetId: string } }>("/api/runs/:runId/assets/:assetId", async (request, reply) => {
    const session = browserSession(request, false);
    const runId = pathId(request, "runId");
    const assetId = pathId(request, "assetId");
    const asset = await options.api.getAsset(session.deviceId, runId, assetId);
    if (asset === undefined) throw new HostHttpError(404, "ASSET_NOT_FOUND", "Run asset was not found.");
    if (asset.data.byteLength > ASSET_LIMIT) throw new HostHttpError(413, "ASSET_TOO_LARGE", "Asset exceeds the transfer limit.");
    return reply.type(asset.mediaType).header("Content-Length", String(asset.data.byteLength)).send(Buffer.from(asset.data));
  });

  server.get<{ Params: { runId: string }; Querystring: { after?: string } }>("/api/runs/:runId/events", async (request, reply) => {
    const session = browserSession(request, false);
    const runId = pathId(request, "runId");
    const headerCursor = request.headers["last-event-id"];
    const queryCursor = request.query.after;
    const rawCursor = typeof headerCursor === "string" ? headerCursor : queryCursor ?? "0";
    if (!/^(?:0|[1-9][0-9]{0,15})$/u.test(rawCursor) || !Number.isSafeInteger(Number(rawCursor))) {
      throw new HostHttpError(400, "INVALID_EVENT_CURSOR", "Event cursor must be a non-negative safe integer.");
    }
    const afterSequence = Number(rawCursor);
    const run = await options.api.getRun(session.deviceId, runId);
    if (run === undefined) throw new HostHttpError(404, "RUN_NOT_FOUND", "Run was not found.");
    revalidateBrowserSession(request, session);
    const deviceStreams = activeStreams.get(session.deviceId) ?? new Map<string, Set<() => void>>();
    const streams = deviceStreams.get(session.sessionKey) ?? new Set<() => void>();
    const deviceStreamCount = [...deviceStreams.values()].reduce((total, active) => total + active.size, 0);
    if (streamCount >= MAX_SSE_CLIENTS || deviceStreamCount >= MAX_SSE_CLIENTS_PER_DEVICE) {
      throw new HostHttpError(429, "SSE_LIMIT", "Too many live event connections are open for this device.");
    }
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    response.flushHeaders?.();
    response.write(": connected\n\n");
    const writeEvent = (event: { type: string; runId: string; sequence?: number; afterSequence?: number; latestSequence?: number; data?: unknown }): void => {
      if (response.destroyed || response.writableEnded) return;
      if (event.type === "resync_required") {
        response.write("event: resync_required\ndata: " + JSON.stringify(event) + "\n\n");
        return;
      }
      const sequence = event.sequence ?? 0;
      response.write("id: " + String(sequence) + "\nevent: run.event\ndata: " + JSON.stringify(event) + "\n\n");
    };
    const subscription = options.api.subscribe(session.deviceId, runId, afterSequence, (event) => {
      if (event.type === "resync_required") writeEvent(event);
      else writeEvent(event);
    });
    const heartbeat = setInterval(() => {
      if (response.destroyed || response.writableEnded) return;
      if (response.writableLength > 512 * 1024) {
        response.destroy();
        return;
      }
      response.write(": keepalive\n\n");
    }, SSE_HEARTBEAT_MS);
    heartbeat.unref?.();
    let disposed = false;
    let expiration: NodeJS.Timeout | undefined;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      clearInterval(heartbeat);
      if (expiration !== undefined) clearTimeout(expiration);
      subscription.close();
      streams.delete(dispose);
      streamCount = Math.max(0, streamCount - 1);
      if (streams.size === 0) deviceStreams.delete(session.sessionKey);
      if (deviceStreams.size === 0) activeStreams.delete(session.deviceId);
    };
    const terminate = () => {
      if (!response.writableEnded && !response.destroyed) response.end();
      dispose();
    };
    const scheduleExpiration = (): void => {
      if (disposed) return;
      const remaining = Date.parse(session.expiresAt) - Date.now();
      if (remaining <= 0) {
        terminate();
        return;
      }
      expiration = setTimeout(scheduleExpiration, Math.min(remaining, MAX_TIMEOUT_DELAY_MS));
      expiration.unref?.();
    };
    scheduleExpiration();
    streams.add(terminate);
    streamCount += 1;
    deviceStreams.set(session.sessionKey, streams);
    activeStreams.set(session.deviceId, deviceStreams);
    response.on("close", dispose);
    request.raw.on("aborted", terminate);
    if (response.destroyed || response.writableEnded) terminate();
  });

  server.get("/", async (_request, reply) => serveStatic(staticRoot, "/", reply));
  server.get("/*", async (request, reply) => {
    const url = request.raw.url ?? "/";
    if (url === "/api" || url.startsWith("/api/")) throw new HostHttpError(404, "NOT_FOUND", "Route was not found.");
    return serveStatic(staticRoot, url.split("?")[0] ?? "/", reply);
  });

  const relayHandler: HostRequestHandler = {
    api: options.api,
    request: bridgeHandler.request,
    authorizeSession: (deviceId, sessionToken) => pairing.authenticateSession(sessionToken)?.deviceId === deviceId,
  };

  return {
    server,
    pairing,
    relayHandler,
    async listen() {
      const address = await server.listen({ port: options.port ?? DEFAULT_PORT, host: "127.0.0.1" });
      return address;
    },
    async close() {
      for (const bySession of activeStreams.values()) {
        for (const subscriptions of bySession.values()) for (const close of [...subscriptions]) close();
      }
      await server.close();
    },
  };
}

function parseCommand(value: unknown): RemoteCommand {
  const body = bodyRecord(value);
  const type = body.type;
  const commandId = bodyString(body.commandId, "commandId", 128);
  const expectedSequence = body.expectedSequence;
  if (!Number.isSafeInteger(expectedSequence) || Number(expectedSequence) < 0) {
    throw new HostHttpError(400, "INVALID_COMMAND", "expectedSequence must be a non-negative safe integer.");
  }
  const base = { commandId, expectedSequence: Number(expectedSequence) };
  if (type === "pause" || type === "resume" || type === "abort") return { ...base, type };
  if (type === "approve" || type === "reject") return { ...base, type, requestId: bodyString(body.requestId, "requestId", 128) };
  if (type === "respond" || type === "correct") {
    const requestId = body.requestId === undefined ? undefined : bodyString(body.requestId, "requestId", 128);
    const text = bodyString(body.text, "text", 8_000);
    if (type === "respond" && requestId === undefined) throw new HostHttpError(400, "INVALID_COMMAND", "respond requires requestId.");
    return {
      ...base,
      type,
      ...(requestId === undefined ? {} : { requestId }),
      text,
    } as RemoteCommand;
  }
  if (type === "window.confirm") {
    return {
      ...base,
      type,
      requestId: bodyString(body.requestId, "requestId", 128),
      candidateToken: bodyString(body.candidateToken, "candidateToken", 128),
    };
  }
  if (type === "window.ignore") {
    return { ...base, type, requestId: bodyString(body.requestId, "requestId", 128) };
  }
  throw new HostHttpError(400, "INVALID_COMMAND", "Command type is not supported.");
}

function bodyRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HostHttpError(400, "INVALID_REQUEST", "A JSON object is required.");
  return value as Record<string, unknown>;
}

function bodyString(value: unknown, key: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new HostHttpError(400, "INVALID_REQUEST", "Field " + key + " is invalid.");
  }
  return value;
}

function localPairRequest(request: PairRequestView): Record<string, unknown> {
  return {
    requestId: request.requestId,
    clientName: request.clientName,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    status: request.status === "pending_local_confirmation" ? "pending" : request.status,
    ...(request.deviceId === undefined ? {} : { deviceId: request.deviceId }),
  };
}

async function serveStatic(root: string | undefined, requestPath: string, reply: FastifyReply): Promise<FastifyReply> {
  if (root === undefined) {
    return reply.code(503).send({ error: { code: "WEB_NOT_BUILT", message: "Build apps/web before opening the Host console." } });
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(requestPath);
  } catch {
    return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Page was not found." } });
  }
  if (pathname.includes("\\") || pathname.includes("\0") || pathname.split("/").some((part) => part === "." || part === "..")) {
    return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Page was not found." } });
  }
  const relativePath = pathname === "/" || pathname === "/pair" ? "index.html" : pathname.replace(/^\/+/, "");
  let filePath = resolve(root, relativePath);
  const rootPrefix = root.endsWith(sep) ? root : root + sep;
  if (filePath !== root && !filePath.startsWith(rootPrefix)) {
    return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Page was not found." } });
  }
  try {
    if (!(await stat(filePath)).isFile()) throw new Error("not a regular file");
  } catch {
    if (relativePath.includes(".")) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Page was not found." } });
    filePath = resolve(root, "index.html");
  }
  const data = await readFile(filePath);
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
  reply.type(contentType).header("Content-Length", String(data.byteLength));
  if (extension === ".html") {
    reply.header("Cache-Control", "no-store");
    reply.header("Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  } else {
    reply.header("Cache-Control", "public, max-age=300, immutable");
  }
  return reply.send(data);
}

function parseCookie(rawCookie: string | string[] | undefined, name: string): string | undefined {
  if (rawCookie === undefined || Array.isArray(rawCookie) || Buffer.byteLength(rawCookie, "utf8") > 8 * 1024) return undefined;
  for (const segment of rawCookie.split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 0 || segment.slice(0, separator).trim() !== name) continue;
    const value = segment.slice(separator + 1).trim();
    return /^[A-Za-z0-9_-]{32,128}$/u.test(value) ? value : undefined;
  }
  return undefined;
}

function setSessionCookie(reply: FastifyReply, token: string, expiresAt: string, secure: boolean): void {
  const maxAge = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
  reply.header("Set-Cookie", SESSION_COOKIE + "=" + token + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" + String(maxAge) + (secure ? "; Secure" : ""));
}

function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  reply.header("Set-Cookie", SESSION_COOKIE + "=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0" + (secure ? "; Secure" : ""));
}

function isSecureOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return false;
  try {
    return new URL(origin).protocol === "https:";
  } catch {
    return false;
  }
}

function safeEqual(left: string | string[] | undefined, right: string): boolean {
  if (typeof left !== "string" || left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function validateOrigin(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "" ||
      url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("Allowed Origin must be a scheme and host only.");
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new Error("HTTP Origins are permitted only on loopback.");
  }
  return url.origin;
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    return isLoopbackHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function isLoopbackAddress(value: string): boolean {
  const address = value.toLowerCase().replace(/^::ffff:/u, "");
  return address === "::1" || address === "127.0.0.1" || address.startsWith("127.");
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return host === "localhost" || host === "::1" || host === "127.0.0.1" || host.startsWith("127.");
}
