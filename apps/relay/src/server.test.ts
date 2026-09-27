import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import type { RemoteRunApi } from "@computer-harness/app-runtime";
import { hashPairingToken, HostRelayConnector, type HostToRelayMessage } from "@computer-harness/relay-connector";
import { createRelayServer } from "./server.js";

interface FakeHostMessage {
  type?: string;
  [key: string]: unknown;
}

class FakeHost {
  readonly received: FakeHostMessage[] = [];
  private readonly waiters: Array<{ predicate: (message: FakeHostMessage) => boolean; resolve: (message: FakeHostMessage) => void }> = [];
  readonly connected: Promise<void>;
  readonly closed: Promise<void>;
  private resolveClosed: () => void = () => undefined;
  private socket: WebSocket;

  constructor(readonly endpoint: string, readonly hostId: string, readonly credential: string) {
    this.socket = new WebSocket(endpoint);
    this.closed = new Promise<void>((resolveClosed) => { this.resolveClosed = resolveClosed; });
    this.connected = new Promise<void>((resolveConnected, rejectConnected) => {
      this.socket.once("open", () => {
        this.send({ type: "host.hello", protocolVersion: 1, hostId, credential });
      });
        this.socket.on("message", (data) => {
          const message = JSON.parse(data.toString()) as FakeHostMessage;
        if (message.type === "relay.ready" && message.hostId === hostId) resolveConnected();
        this.received.push(message);
        for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
          const waiter = this.waiters[index];
          if (waiter !== undefined && waiter.predicate(message)) {
            this.waiters.splice(index, 1);
            waiter.resolve(message);
          }
        }
      });
      this.socket.once("error", rejectConnected);
    });
    this.socket.once("close", () => this.resolveClosed());
  }

  send(message: HostToRelayMessage | Record<string, unknown>): void {
    this.socket.send(JSON.stringify(message));
  }

  next(predicate: (message: FakeHostMessage) => boolean, timeoutMs = 3000): Promise<FakeHostMessage> {
    const existing = this.received.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise<FakeHostMessage>((resolveNext, rejectNext) => {
      const timer = setTimeout(() => rejectNext(new Error("timed out waiting for relay message")), timeoutMs);
      this.waiters.push({
        predicate,
        resolve: (message) => {
          clearTimeout(timer);
          resolveNext(message);
        },
      });
    });
  }

  async close(): Promise<void> {
    if (this.socket.readyState < WebSocket.CLOSING) this.socket.close(1000, "test done");
    await this.closed;
  }
}

const activeRelays: Array<Awaited<ReturnType<typeof startRelay>>> = [];
const activeHosts: FakeHost[] = [];
const activeConnectors: HostRelayConnector[] = [];

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test relay port unavailable");
  await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error === undefined ? resolveClose() : rejectClose(error)));
  return address.port;
}

async function startRelay(hostId: string, credential: string): Promise<{ relay: ReturnType<typeof createRelayServer>; origin: string; endpoint: string }> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const relay = createRelayServer({
    publicOrigin: origin,
    listenHost: "127.0.0.1",
    listenPort: port,
    hostCredentials: new Map([[hostId, credential]]),
    requestTimeoutMs: 2000,
  });
  await relay.listen();
  activeRelays.push({ relay, origin, endpoint: `ws://127.0.0.1:${port}/v1/host` });
  return { relay, origin, endpoint: `ws://127.0.0.1:${port}/v1/host` };
}

function startHost(endpoint: string, hostId: string, credential: string): FakeHost {
  const host = new FakeHost(endpoint, hostId, credential);
  activeHosts.push(host);
  return host;
}

function bridgeResponse(requestId: unknown, body: unknown, statusCode = 200): HostToRelayMessage {
  return {
    type: "bridge.response",
    requestId: String(requestId),
    statusCode,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(body),
  };
}

afterEach(async () => {
  for (const connector of activeConnectors.splice(0)) connector.close();
  for (const host of activeHosts.splice(0)) await host.close().catch(() => undefined);
  for (const { relay } of activeRelays.splice(0)) await relay.close().catch(() => undefined);
});

describe("local outbound relay transport", () => {
  it("pairs through a one-use token, binds the session to its Host, streams events, and fails closed on reconnect without replay", async () => {
    const hostId = "host_one";
    const credential = randomBytes(32).toString("base64url");
    const { relay, origin, endpoint } = await startRelay(hostId, credential);
    const host = startHost(endpoint, hostId, credential);
    await host.connected;

    const token = randomBytes(32).toString("base64url");
    host.send({
      type: "host.pairing.register",
      pairingId: "pairing_one",
      tokenHash: hashPairingToken(token),
      expiresAt: Date.now() + 60_000,
    });
    await host.next((message) => message.type === "relay.pairing.registered");

    const pairResponsePromise = fetch(`${origin}/api/pair/requests`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ token, clientName: "test phone" }),
    });
    const pairRequest = await host.next((message) => message.type === "bridge.request" && message.path === "/api/pair/requests");
    expect(pairRequest.body).toMatchObject({ token, clientName: "test phone" });
    host.send(bridgeResponse(pairRequest.requestId, { requestId: "host_pair_local", expiresAt: new Date(Date.now() + 60_000).toISOString() }, 202));
    const pairResponse = await pairResponsePromise;
    expect(pairResponse.status).toBe(202);
    const pairBody = await pairResponse.json() as { requestId: string; expiresAt: string; token?: string };
    expect(pairBody.requestId).not.toBe("host_pair_local");
    expect(pairBody.token).toBeUndefined();

    const statusPromise = fetch(`${origin}/api/pair/requests/${pairBody.requestId}`);
    const statusRequest = await host.next((message) => message.type === "bridge.request" && message.path === "/api/pair/requests/host_pair_local");
    host.send(bridgeResponse(statusRequest.requestId, { status: "approved" }));
    expect(await (await statusPromise).json()).toEqual({ status: "approved" });

    const sessionPromise = fetch(`${origin}/api/pair/requests/${pairBody.requestId}/session`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: "{}",
    });
    const sessionRequest = await host.next((message) => message.type === "bridge.request" && message.path === "/api/pair/requests/host_pair_local/session");
    const hostSessionToken = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(24).toString("base64url");
    host.send(bridgeResponse(sessionRequest.requestId, {
      deviceId: "phone_one",
      sessionToken: hostSessionToken,
      csrfToken,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    }));
    const sessionResponse = await sessionPromise;
    expect(sessionResponse.status).toBe(200);
    const sessionCookie = sessionResponse.headers.get("set-cookie");
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("SameSite=Strict");
    expect(sessionCookie).not.toContain(hostSessionToken);
    const relayCookie = sessionCookie.split(";")[0] ?? "";
    const sessionBody = await sessionResponse.json() as Record<string, unknown>;
    expect(sessionBody).toEqual({ csrfToken, expiresAt: expect.any(String) });
    expect(JSON.stringify(sessionBody)).not.toContain(hostSessionToken);

    const windowChoicesPromise = fetch(`${origin}/api/windows`, { headers: { Cookie: relayCookie } });
    const windowChoicesRequest = await host.next((message) => message.type === "bridge.request" && message.path === "/api/windows");
    expect(windowChoicesRequest).toMatchObject({ method: "GET", deviceId: "phone_one", sessionToken: hostSessionToken });
    const opaqueTargetToken = randomBytes(24).toString("base64url");
    const windowChoices = { candidates: [{ token: opaqueTargetToken, appName: "Browser", title: "Travel results" }], expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() };
    host.send(bridgeResponse(windowChoicesRequest.requestId, windowChoices));
    expect(await (await windowChoicesPromise).json()).toEqual(windowChoices);

    const sessionSnapshotPromise = fetch(`${origin}/api/session`, { headers: { Cookie: relayCookie } });
    const snapshotRequest = await host.next((message) => message.type === "bridge.request" && message.path === "/api/session");
    expect(snapshotRequest).toMatchObject({ deviceId: "phone_one", sessionToken: hostSessionToken });
    host.send(bridgeResponse(snapshotRequest.requestId, { authenticated: true, csrfToken }));
    expect(await (await sessionSnapshotPromise).json()).toEqual({ authenticated: true, csrfToken });

    const runsPromise = fetch(`${origin}/api/runs?limit=10`, { headers: { Cookie: relayCookie } });
    const runsRequest = await host.next((message) => message.type === "bridge.request" && message.path === "/api/runs?limit=10");
    host.send(bridgeResponse(runsRequest.requestId, { runs: [] }));
    expect(await (await runsPromise).json()).toEqual({ runs: [] });

    const eventsResponse = await fetch(`${origin}/api/runs/run_one/events?after=0`, { headers: { Cookie: relayCookie } });
    expect(eventsResponse.headers.get("content-type")).toContain("text/event-stream");
    const subscribe = await host.next((message) => message.type === "bridge.subscribe");
    expect(subscribe).toMatchObject({ deviceId: "phone_one", runId: "run_one", afterSequence: 0 });
    const reader = eventsResponse.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();
    let eventText = "";
    host.send({
      type: "bridge.event",
      subscriptionId: String(subscribe.subscriptionId),
      runId: "run_one",
      sequence: 1,
      event: { type: "run.progress", message: "connected" },
    });
    for (let attempt = 0; attempt < 5 && !eventText.includes("id: 1"); attempt += 1) {
      const chunk = await reader?.read();
      if (chunk?.done) break;
      eventText += decoder.decode(chunk?.value);
    }
    expect(eventText).toContain("id: 1");
    expect(eventText).toContain('"message":"connected"');

    await host.close();
    await reader?.cancel().catch(() => undefined);
    const reconnectedHost = startHost(endpoint, hostId, credential);
    await reconnectedHost.connected;
    const reconnectedRunsPromise = fetch(`${origin}/api/runs`, { headers: { Cookie: relayCookie } });
    const reconnectedRequest = await reconnectedHost.next((message) => message.type === "bridge.request" && message.path === "/api/runs");
    expect(reconnectedRequest.deviceId).toBe("phone_one");
    reconnectedHost.send(bridgeResponse(reconnectedRequest.requestId, { runs: [{ runId: "run_one" }] }));
    expect(await (await reconnectedRunsPromise).json()).toEqual({ runs: [{ runId: "run_one" }] });

    const requestCount = reconnectedHost.received.filter((message) => message.type === "bridge.request").length;
    const invalidRunStarts = [
      { commandId: "cmd_missing_target", goal: "start a run", pid: 1234, path: "C:/private" },
      { commandId: "cmd_auto_extra", goal: "start a run", target: { mode: "auto", targetToken: opaqueTargetToken } },
      { commandId: "cmd_redundant_target", goal: "start a run", targetToken: opaqueTargetToken, target: { mode: "auto" } },
      { commandId: "cmd_bad_window", goal: "start a run", target: { mode: "window", targetToken: "short" } },
      { commandId: "cmd_bad_browser", goal: "start a run", target: { mode: "browser", url: "ftp://example.com/" } },
    ];
    for (const body of invalidRunStarts) {
      const invalidRunStart = await fetch(`${origin}/api/runs`, {
        method: "POST",
        headers: { Origin: origin, Cookie: relayCookie, "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify(body),
      });
      expect(invalidRunStart.status, body.commandId).toBe(400);
    }
    expect(reconnectedHost.received.filter((message) => message.type === "bridge.request")).toHaveLength(requestCount);

    const acceptedRunStarts = [
      { commandId: "cmd_auto", goal: "start automatically", target: { mode: "auto" } },
      { commandId: "cmd_window", goal: "start on the selected window", target: { mode: "window", targetToken: opaqueTargetToken } },
      { commandId: "cmd_browser_default", goal: "start with a blank managed browser", target: { mode: "browser" } },
      { commandId: "cmd_browser_blank", goal: "start with a blank managed browser", target: { mode: "browser", url: "   " } },
      { commandId: "cmd_browser_about_blank", goal: "start with a blank managed browser", target: { mode: "browser", url: "about:blank" } },
      { commandId: "cmd_browser", goal: "start in the managed browser", target: { mode: "browser", url: "https://example.com/trips" } },
      { commandId: "cmd_legacy", goal: "start with the selected window", targetToken: opaqueTargetToken },
    ];
    for (const body of acceptedRunStarts) {
      const startPromise = fetch(`${origin}/api/runs`, {
        method: "POST",
        headers: { Origin: origin, Cookie: relayCookie, "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify(body),
      });
      const startRequest = await reconnectedHost.next((message) => {
        const requestBody = message.body as Record<string, unknown> | undefined;
        return message.type === "bridge.request"
          && message.method === "POST"
          && message.path === "/api/runs"
          && requestBody?.commandId === body.commandId;
      });
      expect(startRequest.body).toEqual(body);
      reconnectedHost.send(bridgeResponse(startRequest.requestId, { runId: `run_${body.commandId}`, status: "accepted" }, 202));
      const startResponse = await startPromise;
      expect(startResponse.status, body.commandId).toBe(202);
      expect(await startResponse.json()).toEqual({ runId: `run_${body.commandId}`, status: "accepted" });
    }

    const unknownOutcomePromise = fetch(`${origin}/api/runs`, {
      method: "POST",
      headers: { Origin: origin, Cookie: relayCookie, "Content-Type": "application/json", "x-csrf-token": csrfToken },
      body: JSON.stringify({ commandId: "cmd_one", goal: "start a run", targetToken: opaqueTargetToken }),
    });
    const inFlightCommand = await reconnectedHost.next((message) => {
      const requestBody = message.body as Record<string, unknown> | undefined;
      return message.type === "bridge.request"
        && message.method === "POST"
        && message.path === "/api/runs"
        && requestBody?.commandId === "cmd_one";
    });
    expect(inFlightCommand.body).toEqual({ commandId: "cmd_one", goal: "start a run", targetToken: opaqueTargetToken });
    await reconnectedHost.close();
    const unknownOutcome = await unknownOutcomePromise;
    expect(unknownOutcome.status).toBe(504);
    expect(unknownOutcome.headers.get("x-harness-outcome")).toBe("unknown");

    const finalHost = startHost(endpoint, hostId, credential);
    await finalHost.connected;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    expect(finalHost.received.some((message) => message.type === "bridge.request" && (message.body as Record<string, unknown> | undefined)?.commandId === "cmd_one")).toBe(false);

    const revokedEvents = await fetch(`${origin}/api/runs/run_one/events?after=1`, { headers: { Cookie: relayCookie } });
    const revokedEventReader = revokedEvents.body?.getReader();
    await revokedEventReader?.read();
    await finalHost.next((message) => message.type === "bridge.subscribe");

    const pendingWindowsPromise = fetch(`${origin}/api/windows`, { headers: { Cookie: relayCookie } });
    const pendingWindowsRequest = await finalHost.next((message) => message.type === "bridge.request" && message.path === "/api/windows");
    const lateCandidateToken = randomBytes(24).toString("base64url");
    finalHost.send({ type: "host.session.revoke", deviceId: "phone_one" });
    await finalHost.next((message) => message.type === "relay.session.revoked" && message.deviceId === "phone_one");
    finalHost.send(bridgeResponse(pendingWindowsRequest.requestId, {
      candidates: [{ token: lateCandidateToken, appName: "Private application", title: "Revoked-session label" }],
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    }));
    const lateWindowResponse = await pendingWindowsPromise;
    expect(lateWindowResponse.status).toBe(401);
    const lateWindowBody = await lateWindowResponse.json();
    expect(lateWindowBody).toEqual({ error: "session_required" });
    expect(JSON.stringify(lateWindowBody)).not.toContain(lateCandidateToken);
    expect(JSON.stringify(lateWindowBody)).not.toContain("Revoked-session label");

    const revokedStream = await Promise.race([
      revokedEventReader?.read(),
      new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => setTimeout(() => reject(new Error("revoked SSE remained open")), 1000)),
    ]);
    expect(revokedStream?.done).toBe(true);
    const revoked = await fetch(`${origin}/api/runs`, { headers: { Cookie: relayCookie } });
    expect(revoked.status).toBe(401);
  });

  it("refuses local API paths and hostile origins without contacting Host", async () => {
    const hostId = "host_guard";
    const credential = randomBytes(32).toString("base64url");
    const { relay, origin, endpoint } = await startRelay(hostId, credential);
    const host = startHost(endpoint, hostId, credential);
    await host.connected;
    const local = await fetch(`${origin}/api/local/health`);
    expect(local.status).toBe(404);
    const hostileOrigin = await fetch(`${origin}/api/pair/requests`, {
      method: "POST",
      headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
      body: JSON.stringify({ token: randomBytes(32).toString("base64url") }),
    });
    expect(hostileOrigin.status).toBe(403);
    expect(host.received.some((message) => message.type === "bridge.request")).toBe(false);
  });

  it("forwards cursor-ahead resync as an unsequenced control event over real WSS to SSE", async () => {
    const hostId = "host_resync";
    const credential = randomBytes(32).toString("base64url");
    const { origin, endpoint } = await startRelay(hostId, credential);
    const token = randomBytes(32).toString("base64url");
    const sessionToken = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(24).toString("base64url");
    const pairExpiresAt = new Date(Date.now() + 60_000).toISOString();
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const api: RemoteRunApi = {
      listRuns: () => [],
      getRun: () => undefined,
      listWindowTargets: async () => ({ candidates: [], expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }),
      startRun: async (_deviceId, _commandId, _goal, _targetToken) => { throw new Error("not used in relay SSE test"); },
      submitCommand: async () => { throw new Error("not used in relay SSE test"); },
      getCommandReceipt: () => undefined,
      subscribe: (_deviceId, runId, afterSequence, listener) => {
        listener({ type: "resync_required", runId, afterSequence, latestSequence: 10 });
        return { close: () => undefined };
      },
      getAsset: () => undefined,
    };
    const connector = new HostRelayConnector({
      relayUrl: origin,
      hostId,
      credential,
      allowInsecureLocalhost: true,
      handlers: {
        api,
        authorizeSession: (deviceId, candidate) => deviceId === "phone_resync" && candidate === sessionToken,
        request: async (request) => {
          if (request.method === "POST" && request.path === "/api/pair/requests") {
            return { statusCode: 202, body: { requestId: "host_pair_resync", status: "pending_local_confirmation", expiresAt: pairExpiresAt } };
          }
          if (request.method === "GET" && request.path === "/api/pair/requests/host_pair_resync") {
            return { statusCode: 200, body: { requestId: "host_pair_resync", status: "approved", expiresAt: pairExpiresAt } };
          }
          if (request.method === "POST" && request.path === "/api/pair/requests/host_pair_resync/session") {
            return { statusCode: 200, body: { deviceId: "phone_resync", sessionToken, csrfToken, expiresAt } };
          }
          return { statusCode: 404, body: { error: { code: "NOT_FOUND" } } };
        },
      },
    });
    activeConnectors.push(connector);
    await connector.start();
    await connector.registerPairingToken({ pairingId: "pairing_resync", tokenHash: hashPairingToken(token), expiresAt: Date.now() + 60_000 });

    const pairResponse = await fetch(`${origin}/api/pair/requests`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ token, clientName: "resync test phone" }),
    });
    expect(pairResponse.status, `pair create failed: ${JSON.stringify(await pairResponse.clone().json())}`).toBe(202);
    const pair = await pairResponse.json() as { requestId: string };
    const statusResponse = await fetch(`${origin}/api/pair/requests/${pair.requestId}`);
    const statusPayload = await statusResponse.json() as { status?: string; error?: unknown };
    expect(statusPayload, `pair status HTTP ${statusResponse.status}`).toMatchObject({ status: "approved" });

    const sessionResponse = await fetch(`${origin}/api/pair/requests/${pair.requestId}/session`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: "{}",
    });
    const sessionCookie = sessionResponse.headers.get("set-cookie")?.split(";")[0];
    expect(sessionCookie).toBeDefined();

    const stream = await fetch(`${origin}/api/runs/run_resync/events?after=999`, { headers: { Cookie: sessionCookie! } });
    expect(stream.status).toBe(200);
    const reader = stream.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();
    let text = "";
    for (let attempt = 0; attempt < 5 && !text.includes("event: resync_required"); attempt += 1) {
      const chunk = await reader?.read();
      if (chunk?.done) break;
      text += decoder.decode(chunk?.value);
    }
    expect(text).toContain("event: resync_required");
    expect(text).toContain('"afterSequence":999');
    expect(text).toContain('"latestSequence":10');
    expect(text).not.toMatch(/^id:/mu);
    await reader?.cancel();
  });
});
