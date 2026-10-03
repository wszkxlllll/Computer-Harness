import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import type { RemoteRunApi } from "@computer-harness/app-runtime";
import { HostRelayConnector, type PairingTokenRegistration } from "./index.js";

interface FakeRelay {
  readonly origin: string;
  readonly port: number;
  readonly registrations: Map<string, number>;
  readonly server: Server;
  send(message: Record<string, unknown>): void;
  close(): Promise<void>;
}

const activeRelays: FakeRelay[] = [];
const activeConnectors: HostRelayConnector[] = [];

async function startFakeRelay(port = 0): Promise<FakeRelay> {
  const server = createServer();
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 12 * 1024 * 1024, perMessageDeflate: false });
  const registrations = new Map<string, number>();
  let connectedHost: WebSocket | undefined;
  let closed = false;
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/v1/host") {
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      connectedHost = websocket;
      websocket.once("close", () => {
        if (connectedHost === websocket) connectedHost = undefined;
      });
      websocket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        if (message.type === "host.hello") {
          websocket.send(JSON.stringify({ type: "relay.ready", protocolVersion: 1, hostId: message.hostId }));
        } else if (message.type === "host.pairing.register") {
          const pairingId = String(message.pairingId);
          const expiresAt = Number(message.expiresAt);
          registrations.set(pairingId, expiresAt);
          websocket.send(JSON.stringify({ type: "relay.pairing.registered", pairingId, expiresAt }));
        } else if (message.type === "host.pairing.unregister") {
          registrations.delete(String(message.pairingId));
        }
      });
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake relay port unavailable");
  const relay: FakeRelay = {
    origin: `http://127.0.0.1:${address.port}`,
    port: address.port,
    registrations,
    server,
    send: (message) => {
      if (connectedHost?.readyState !== WebSocket.OPEN) throw new Error("fake relay has no connected Host");
      connectedHost.send(JSON.stringify(message));
    },
    close: async () => {
      if (closed) return;
      closed = true;
      for (const client of websocketServer.clients) client.close(1001, "test relay restart");
      await new Promise<void>((resolveClose) => websocketServer.close(() => resolveClose()));
      if (server.listening) await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error === undefined ? resolveClose() : rejectClose(error)));
    },
  };
  activeRelays.push(relay);
  return relay;
}

function createRemoteApi(): RemoteRunApi {
  return {
    listRuns: () => [],
    getRun: () => undefined,
    listWindowTargets: async () => ({ candidates: [], expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }),
    startRun: async (_deviceId, _commandId, _goal, _targetToken) => { throw new Error("not used in connector test"); },
    submitCommand: async () => { throw new Error("not used in connector test"); },
    getCommandReceipt: () => undefined,
    subscribe: () => ({ close: () => undefined }),
    getAsset: () => undefined,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("condition timed out");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}

afterEach(async () => {
  for (const connector of activeConnectors.splice(0)) connector.close();
  for (const relay of activeRelays.splice(0)) await relay.close().catch(() => undefined);
});

describe("HostRelayConnector", () => {
  it("accepts the authenticated managed-browser preference PUT bridge request", async () => {
    const hostId = "connector_put_host";
    const credential = randomBytes(32).toString("base64url");
    const relay = await startFakeRelay();
    const requestHandler = vi.fn(async () => ({ statusCode: 200, body: { status: "unprepared", defaultSession: "temporary" } }));
    const connector = new HostRelayConnector({
      relayUrl: relay.origin,
      hostId,
      credential,
      allowInsecureLocalhost: true,
      handlers: {
        api: createRemoteApi(),
        request: requestHandler,
        authorizeSession: () => true,
      },
    });
    activeConnectors.push(connector);
    await connector.start();
    relay.send({
      type: "bridge.request",
      requestId: "preference_put_request",
      method: "PUT",
      path: "/api/managed-browser-profile/preference",
      deviceId: "phone_put",
      sessionToken: randomBytes(32).toString("base64url"),
      csrfToken: randomBytes(24).toString("base64url"),
      body: { defaultSession: "temporary" },
    });

    await waitFor(() => requestHandler.mock.calls.length === 1);
    expect(requestHandler).toHaveBeenCalledWith(expect.objectContaining({
      type: "bridge.request",
      requestId: "preference_put_request",
      method: "PUT",
      path: "/api/managed-browser-profile/preference",
      body: { defaultSession: "temporary" },
    }));
  });

  it("reconnects and re-registers pairing token hashes without exposing raw tokens", async () => {
    const hostId = "connector_test_host";
    const credential = randomBytes(32).toString("base64url");
    const firstRelay = await startFakeRelay();
    const statuses: string[] = [];
    const connector = new HostRelayConnector({
      relayUrl: firstRelay.origin,
      hostId,
      credential,
      allowInsecureLocalhost: true,
      handlers: {
        api: createRemoteApi(),
        request: async () => ({ statusCode: 200, body: { ok: true } }),
        authorizeSession: () => true,
      },
      onStatus: (status) => statuses.push(status),
    });
    activeConnectors.push(connector);
    await connector.start();
    const firstRegistration: PairingTokenRegistration = {
      pairingId: "pairing_first",
      tokenHash: randomBytes(32).toString("hex"),
      expiresAt: Date.now() + 60_000,
    };
    await connector.registerPairingToken(firstRegistration);
    expect(firstRelay.registrations.has(firstRegistration.pairingId)).toBe(true);

    const previousPort = firstRelay.port;
    await firstRelay.close();
    await waitFor(() => statuses.includes("disconnected"));
    const secondRegistration: PairingTokenRegistration = {
      pairingId: "pairing_second",
      tokenHash: randomBytes(32).toString("hex"),
      expiresAt: Date.now() + 60_000,
    };
    const pendingRegistration = connector.registerPairingToken(secondRegistration);
    const secondRelay = await startFakeRelay(previousPort);
    await pendingRegistration;
    await waitFor(() => statuses.filter((status) => status === "connected").length >= 2);
    expect(secondRelay.registrations.has(firstRegistration.pairingId)).toBe(true);
    expect(secondRelay.registrations.has(secondRegistration.pairingId)).toBe(true);
    expect(connector.isConnected).toBe(true);
    expect(statuses).toContain("disconnected");
  });
});
