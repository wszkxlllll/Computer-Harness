import { describe, expect, it, vi } from "vitest";
import type { RemoteRunApi, RemoteRunSnapshot } from "@computer-harness/app-runtime";
import type { AssetId, RunId } from "@computer-harness/protocol";
import { createHostServer } from "./server.js";

const localOrigin = "http://localhost:4317";
const relayOrigin = "https://relay.example";
const runId = "run-123456" as RunId;
const assetId = "asset-123456" as AssetId;
const targetToken = "T".repeat(32);

function snapshot(sequence = 0): RemoteRunSnapshot {
  return {
    runId,
    goal: "Find the saved itinerary",
    status: "running",
    sequence,
    capabilities: { pause: true, resume: false, abort: true, correct: true, approval: false, windowHandoff: false },
  };
}

function fakeApi(): RemoteRunApi {
  return {
    listRuns: () => [snapshot()],
    getRun: (_deviceId, id) => id === runId ? snapshot(0) : undefined,
    listWindowTargets: async () => ({
      candidates: [{ token: targetToken, appName: "Fixture app", title: "Fixture window" }],
      expiresAt: "2026-09-26T00:10:00.000Z",
    }),
    startRun: async (_deviceId, commandId, goal, _targetToken) => ({
      ...snapshot(),
      goal,
      runId: ("run-" + commandId) as RunId,
      target: { appName: "Fixture app", title: "Fixture window" },
    }),
    submitCommand: async (_deviceId, id, command) => ({
      runId: id as RunId,
      commandId: command.commandId,
      status: "accepted",
      acceptedAt: "2026-09-26T00:00:00.000Z",
      sequence: command.expectedSequence + 1,
    }),
    getCommandReceipt: async (_deviceId, id, commandId) => ({
      runId: id as RunId,
      commandId,
      status: "applied",
      acceptedAt: "2026-09-26T00:00:00.000Z",
      completedAt: "2026-09-26T00:00:01.000Z",
    }),
    subscribe: (_deviceId, id, _after, listener) => {
      listener({ type: "run.event", runId: id as RunId, sequence: 1, data: { type: "run.status", status: "running" } });
      return { close: vi.fn() };
    },
    getAsset: async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: "image/png" }),
  };
}

function jsonResponse<T>(response: { json(): T }): T {
  return response.json();
}

describe("Host HTTP boundary", () => {
  it("requires local confirmation, HttpOnly session cookies, CSRF, and revocable paired devices", async () => {
    const revoked: string[] = [];
    const host = createHostServer({
      api: fakeApi(),
      allowedOrigins: [localOrigin, relayOrigin],
      bridgeOrigin: relayOrigin,
      pairingUrlForToken: (token) => relayOrigin + "/pair?token=" + encodeURIComponent(token),
      revokeDeviceSession: (deviceId) => revoked.push(deviceId),
    });
    try {
      const localSession = await host.server.inject({ method: "GET", url: "/api/local/session", headers: { origin: localOrigin } });
      expect(localSession.statusCode).toBe(200);
      const localCsrfToken = jsonResponse<{ csrfToken: string }>(localSession).csrfToken;

      const createChallenge = await host.server.inject({
        method: "POST",
        url: "/api/local/pairing",
        headers: { origin: localOrigin, "x-csrf-token": localCsrfToken },
        payload: {},
      });
      expect(createChallenge.statusCode).toBe(200);
      const challenge = jsonResponse<{ challengeId: string; pairingUrl: string; expiresAt: string }>(createChallenge);
      const pairToken = new URL(challenge.pairingUrl).searchParams.get("token");
      expect(pairToken).toMatch(/^[A-Za-z0-9_-]{40,64}$/u);

      const pairRequestResponse = await host.server.inject({
        method: "POST",
        url: "/api/pair/requests",
        headers: { origin: relayOrigin },
        payload: { token: pairToken, clientName: "Kitchen phone" },
      });
      expect(pairRequestResponse.statusCode).toBe(202);
      const pairRequest = jsonResponse<{ requestId: string; status: string }>(pairRequestResponse);
      expect(pairRequest.status).toBe("pending_local_confirmation");

      const sessionBeforeApproval = await host.server.inject({
        method: "POST",
        url: "/api/pair/requests/" + pairRequest.requestId + "/session",
        headers: { origin: relayOrigin },
        payload: {},
      });
      expect(sessionBeforeApproval.statusCode).toBe(409);

      const localPairing = await host.server.inject({
        method: "GET",
        url: "/api/local/pairing",
        headers: { origin: localOrigin },
      });
      expect(jsonResponse<{ requests: Array<{ requestId: string; status: string }> }>(localPairing).requests)
        .toContainEqual(expect.objectContaining({ requestId: pairRequest.requestId, status: "pending" }));

      const deniedConfirm = await host.server.inject({
        method: "POST",
        url: "/api/local/pairing/requests/" + pairRequest.requestId + "/confirm",
        headers: { origin: localOrigin },
        payload: { approved: true, label: "Kitchen" },
      });
      expect(deniedConfirm.statusCode).toBe(403);

      const approved = await host.server.inject({
        method: "POST",
        url: "/api/local/pairing/requests/" + pairRequest.requestId + "/confirm",
        headers: { origin: localOrigin, "x-csrf-token": localCsrfToken },
        payload: { approved: true, label: "Kitchen" },
      });
      const deviceId = jsonResponse<{ deviceId: string; status: string }>(approved).deviceId;
      expect(approved.statusCode).toBe(200);
      expect(jsonResponse<{ status: string }>(approved).status).toBe("approved");

      const paired = await host.server.inject({
        method: "POST",
        url: "/api/pair/requests/" + pairRequest.requestId + "/session",
        headers: { origin: relayOrigin },
        payload: {},
      });
      expect(paired.statusCode).toBe(200);
      expect(paired.headers["set-cookie"]).toContain("HttpOnly");
      expect(paired.headers["set-cookie"]).toContain("SameSite=Strict");
      const pairedBody = jsonResponse<{ csrfToken: string; deviceId: string; sessionToken?: string }>(paired);
      expect(pairedBody.deviceId).toBe(deviceId);
      expect(pairedBody.csrfToken).toBeTruthy();
      expect(pairedBody.sessionToken).toBeUndefined();
      const cookie = String(paired.headers["set-cookie"]).split(";")[0];

      const phoneSession = await host.server.inject({
        method: "GET",
        url: "/api/session",
        headers: { origin: relayOrigin, cookie },
      });
      expect(jsonResponse<{ deviceId: string }>(phoneSession).deviceId).toBe(deviceId);

      const choicesResponse = await host.server.inject({
        method: "GET", url: "/api/windows", headers: { origin: relayOrigin, cookie },
      });
      expect(choicesResponse.statusCode).toBe(200);
      const choices = jsonResponse<{ candidates: Array<Record<string, unknown>>; expiresAt: string }>(choicesResponse);
      expect(choices.candidates).toEqual([{ token: targetToken, appName: "Fixture app", title: "Fixture window" }]);
      expect(JSON.stringify(choices)).not.toMatch(/pid|windowId/iu);

      const missingCsrf = await host.server.inject({
        method: "POST",
        url: "/api/runs",
        headers: { origin: relayOrigin, cookie },
        payload: { commandId: "start-1", goal: "Search a receipt", targetToken },
      });
      expect(missingCsrf.statusCode).toBe(403);

      const rawWindowIdentifier = await host.server.inject({
        method: "POST",
        url: "/api/runs",
        headers: { origin: relayOrigin, cookie, "x-csrf-token": pairedBody.csrfToken },
        payload: { commandId: "start-raw-window", goal: "Search a receipt", targetToken, pid: 451, windowId: 894 },
      });
      expect(rawWindowIdentifier.statusCode).toBe(400);

      const created = await host.server.inject({
        method: "POST",
        url: "/api/runs",
        headers: { origin: relayOrigin, cookie, "x-csrf-token": pairedBody.csrfToken },
        payload: { commandId: "start-1", goal: "Search a receipt", targetToken },
      });
      expect(created.statusCode).toBe(202);
      expect(jsonResponse<{ runId: string; status: string }>(created)).toMatchObject({ runId: "run-start-1", status: "running" });

      const list = await host.server.inject({ method: "GET", url: "/api/runs", headers: { origin: relayOrigin, cookie } });
      expect(jsonResponse<{ runs: RemoteRunSnapshot[] }>(list).runs).toHaveLength(1);

      const command = await host.server.inject({
        method: "POST",
        url: "/api/runs/" + runId + "/commands",
        headers: { origin: relayOrigin, cookie, "x-csrf-token": pairedBody.csrfToken },
        payload: { commandId: "pause-1", expectedSequence: 0, type: "pause" },
      });
      expect(command.statusCode).toBe(202);
      expect(jsonResponse<{ receipt: { status: string } }>(command).receipt.status).toBe("accepted");

      const receipt = await host.server.inject({
        method: "GET",
        url: "/api/runs/" + runId + "/commands/pause-1",
        headers: { origin: relayOrigin, cookie },
      });
      expect(jsonResponse<{ status: string }>(receipt).status).toBe("applied");

      const asset = await host.server.inject({
        method: "GET",
        url: "/api/runs/" + runId + "/assets/" + assetId,
        headers: { origin: relayOrigin, cookie },
      });
      expect(asset.headers["content-type"]).toBe("image/png");
      expect(asset.rawPayload).toEqual(Buffer.from([1, 2, 3]));

      const deviceDelete = await host.server.inject({
        method: "DELETE",
        url: "/api/local/devices/" + deviceId,
        headers: { origin: localOrigin, "x-csrf-token": localCsrfToken },
      });
      expect(deviceDelete.statusCode).toBe(204);
      expect(revoked).toEqual([deviceId]);
      const revokedSession = await host.server.inject({ method: "GET", url: "/api/session", headers: { origin: relayOrigin, cookie } });
      expect(revokedSession.statusCode).toBe(401);
    } finally {
      await host.close();
    }
  });

  it("routes Relay requests through the same allowlisted Host API and authorizes SSE with the Host session", async () => {
    const host = createHostServer({
      api: fakeApi(),
      allowedOrigins: [localOrigin, relayOrigin],
      bridgeOrigin: relayOrigin,
      pairingUrlForToken: (token) => relayOrigin + "/pair?token=" + encodeURIComponent(token),
    });
    try {
      const csrfResponse = await host.server.inject({ method: "GET", url: "/api/local/session", headers: { origin: localOrigin } });
      const localCsrf = jsonResponse<{ csrfToken: string }>(csrfResponse).csrfToken;
      const challengeResponse = await host.server.inject({
        method: "POST",
        url: "/api/local/pairing",
        headers: { origin: localOrigin, "x-csrf-token": localCsrf },
        payload: {},
      });
      const token = new URL(jsonResponse<{ pairingUrl: string }>(challengeResponse).pairingUrl).searchParams.get("token")!;

      const bridgePair = await host.relayHandler.request({
        type: "bridge.request",
        requestId: "bridge-pair",
        method: "POST",
        path: "/api/pair/requests",
        body: { token, clientName: "Phone through Relay" },
      });
      expect(bridgePair.statusCode).toBe(202);
      const pair = bridgePair.body as { requestId: string };

      const approval = await host.server.inject({
        method: "POST",
        url: "/api/local/pairing/requests/" + pair.requestId + "/confirm",
        headers: { origin: localOrigin, "x-csrf-token": localCsrf },
        payload: { approved: true, label: "Relay phone" },
      });
      const deviceId = jsonResponse<{ deviceId: string }>(approval).deviceId;

      const bridgeSession = await host.relayHandler.request({
        type: "bridge.request",
        requestId: "bridge-session",
        method: "POST",
        path: "/api/pair/requests/" + pair.requestId + "/session",
        body: {},
      });
      expect(bridgeSession.statusCode).toBe(200);
      const secret = bridgeSession.body as { deviceId: string; sessionToken: string; csrfToken: string };
      expect(secret.deviceId).toBe(deviceId);
      expect(secret.sessionToken).toMatch(/^[A-Za-z0-9_-]{40,64}$/u);
      expect(host.relayHandler.authorizeSession(deviceId, secret.sessionToken)).toBe(true);

      const bridgeRuns = await host.relayHandler.request({
        type: "bridge.request",
        requestId: "bridge-runs",
        method: "GET",
        path: "/api/runs",
        deviceId,
        sessionToken: secret.sessionToken,
      });
      expect(bridgeRuns.statusCode).toBe(200);
      const bridgeWindows = await host.relayHandler.request({
        type: "bridge.request",
        requestId: "bridge-windows",
        method: "GET",
        path: "/api/windows",
        deviceId,
        sessionToken: secret.sessionToken,
      });
      expect(bridgeWindows.statusCode).toBe(200);
      expect(JSON.stringify(bridgeWindows.body)).not.toMatch(/pid|windowId/iu);
      expect(host.relayHandler.authorizeSession("other-device", secret.sessionToken)).toBe(false);
      expect(host.relayHandler.authorizeSession(deviceId, "not-a-session")).toBe(false);
    } finally {
      await host.close();
    }
  });

  it("ends direct Host SSE subscriptions immediately when their paired device is revoked", async () => {
    let sendEvent: ((event: { type: "run.event"; runId: RunId; sequence: number; data: Record<string, unknown> }) => void) | undefined;
    let subscriptionClosed = false;
    const api: RemoteRunApi = {
      ...fakeApi(),
      subscribe: (_deviceId, id, _after, listener) => {
        sendEvent = (event) => { if (!subscriptionClosed) listener(event); };
        return { close: () => { subscriptionClosed = true; } };
      },
    };
    // Bind an ephemeral loopback port so this real-fetch SSE test can coexist with a developer Host.
    // The request Origin remains the exact already-allowlisted Relay origin; production Origin rules are unchanged.
    const host = createHostServer({ api, allowedOrigins: [localOrigin, relayOrigin], bridgeOrigin: relayOrigin, port: 0 });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const localCsrf = jsonResponse<{ csrfToken: string }>(await host.server.inject({
        method: "GET", url: "/api/local/session", headers: { origin: localOrigin },
      })).csrfToken;
      const challenge = jsonResponse<{ pairingUrl: string }>(await host.server.inject({
        method: "POST", url: "/api/local/pairing", headers: { origin: localOrigin, "x-csrf-token": localCsrf }, payload: {},
      }));
      const token = new URL(challenge.pairingUrl).searchParams.get("token")!;
      const pair = jsonResponse<{ requestId: string }>(await host.server.inject({
        method: "POST", url: "/api/pair/requests", headers: { origin: relayOrigin }, payload: { token, clientName: "SSE phone" },
      }));
      const approved = await host.server.inject({
        method: "POST", url: "/api/local/pairing/requests/" + pair.requestId + "/confirm",
        headers: { origin: localOrigin, "x-csrf-token": localCsrf }, payload: { approved: true },
      });
      const deviceId = jsonResponse<{ deviceId: string }>(approved).deviceId;
      const paired = await host.server.inject({
        method: "POST", url: "/api/pair/requests/" + pair.requestId + "/session", headers: { origin: relayOrigin }, payload: {},
      });
      const cookie = String(paired.headers["set-cookie"]).split(";")[0];
      const address = new URL(await host.listen());
      const response = await fetch(new URL("/api/runs/" + runId + "/events", address), {
        headers: { origin: relayOrigin, cookie, accept: "text/event-stream" },
      });
      expect(response.status).toBe(200);
      reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(": connected");

      const revoked = await host.server.inject({
        method: "DELETE", url: "/api/local/devices/" + deviceId,
        headers: { origin: localOrigin, "x-csrf-token": localCsrf },
      });
      expect(revoked.statusCode).toBe(204);
      expect(subscriptionClosed).toBe(true);
      sendEvent?.({ type: "run.event", runId, sequence: 1, data: { type: "run.status", status: "running" } });
      let closeTimer: NodeJS.Timeout | undefined;
      let closed: ReadableStreamReadResult<Uint8Array>;
      try {
        closed = await Promise.race([
          reader.read(),
          new Promise<never>((_resolve, reject) => { closeTimer = setTimeout(() => reject(new Error("revoked SSE did not close")), 2_000); }),
        ]);
      } finally {
        if (closeTimer !== undefined) clearTimeout(closeTimer);
      }
      expect(closed.done).toBe(true);
    } finally {
      await reader?.cancel().catch(() => undefined);
      await host.close();
    }
  });

  it("rechecks the paired session after async snapshot lookup before admitting an SSE subscription", async () => {
    let enteredGetRun: () => void = () => undefined;
    let releaseGetRun: (run: RemoteRunSnapshot | undefined) => void = () => undefined;
    const getRunEntered = new Promise<void>((resolve) => { enteredGetRun = resolve; });
    const delayedRun = new Promise<RemoteRunSnapshot | undefined>((resolve) => { releaseGetRun = resolve; });
    const baseApi = fakeApi();
    const subscribe = vi.fn(baseApi.subscribe);
    const api: RemoteRunApi = {
      ...baseApi,
      getRun: () => {
        enteredGetRun();
        return delayedRun;
      },
      subscribe,
    };
    const host = createHostServer({ api, allowedOrigins: [localOrigin, relayOrigin], bridgeOrigin: relayOrigin });
    try {
      const localCsrf = jsonResponse<{ csrfToken: string }>(await host.server.inject({
        method: "GET", url: "/api/local/session", headers: { origin: localOrigin },
      })).csrfToken;
      const challenge = jsonResponse<{ pairingUrl: string }>(await host.server.inject({
        method: "POST", url: "/api/local/pairing", headers: { origin: localOrigin, "x-csrf-token": localCsrf }, payload: {},
      }));
      const token = new URL(challenge.pairingUrl).searchParams.get("token")!;
      const pair = jsonResponse<{ requestId: string }>(await host.server.inject({
        method: "POST", url: "/api/pair/requests", headers: { origin: relayOrigin }, payload: { token, clientName: "Revocation race phone" },
      }));
      const approved = await host.server.inject({
        method: "POST", url: "/api/local/pairing/requests/" + pair.requestId + "/confirm",
        headers: { origin: localOrigin, "x-csrf-token": localCsrf }, payload: { approved: true },
      });
      const deviceId = jsonResponse<{ deviceId: string }>(approved).deviceId;
      const paired = await host.server.inject({
        method: "POST", url: "/api/pair/requests/" + pair.requestId + "/session", headers: { origin: relayOrigin }, payload: {},
      });
      const cookie = String(paired.headers["set-cookie"]).split(";")[0];

      const pendingSse = host.server.inject({
        method: "GET", url: "/api/runs/" + runId + "/events?after=0", headers: { origin: relayOrigin, cookie },
      });
      await getRunEntered;
      const revoked = await host.server.inject({
        method: "DELETE", url: "/api/local/devices/" + deviceId,
        headers: { origin: localOrigin, "x-csrf-token": localCsrf },
      });
      expect(revoked.statusCode).toBe(204);
      releaseGetRun(snapshot(0));
      const response = await pendingSse;
      expect(response.statusCode).toBe(401);
      expect(subscribe).not.toHaveBeenCalled();
    } finally {
      releaseGetRun(undefined);
      await host.close();
    }
  });

  it("does not return window labels when the paired device is revoked during async discovery", async () => {
    let enteredDiscovery: () => void = () => undefined;
    let releaseDiscovery: (value: { candidates: Array<{ token: string; appName: string; title: string }>; expiresAt: string }) => void = () => undefined;
    const discoveryStarted = new Promise<void>((resolve) => { enteredDiscovery = resolve; });
    const delayedCandidates = new Promise<{ candidates: Array<{ token: string; appName: string; title: string }>; expiresAt: string }>((resolve) => {
      releaseDiscovery = resolve;
    });
    const api: RemoteRunApi = {
      ...fakeApi(),
      listWindowTargets: () => {
        enteredDiscovery();
        return delayedCandidates;
      },
    };
    const host = createHostServer({ api, allowedOrigins: [localOrigin, relayOrigin], bridgeOrigin: relayOrigin });
    try {
      const localCsrf = jsonResponse<{ csrfToken: string }>(await host.server.inject({
        method: "GET", url: "/api/local/session", headers: { origin: localOrigin },
      })).csrfToken;
      const challenge = jsonResponse<{ pairingUrl: string }>(await host.server.inject({
        method: "POST", url: "/api/local/pairing", headers: { origin: localOrigin, "x-csrf-token": localCsrf }, payload: {},
      }));
      const token = new URL(challenge.pairingUrl).searchParams.get("token")!;
      const pair = jsonResponse<{ requestId: string }>(await host.server.inject({
        method: "POST", url: "/api/pair/requests", headers: { origin: relayOrigin }, payload: { token, clientName: "Window inventory race phone" },
      }));
      const approved = await host.server.inject({
        method: "POST", url: "/api/local/pairing/requests/" + pair.requestId + "/confirm",
        headers: { origin: localOrigin, "x-csrf-token": localCsrf }, payload: { approved: true },
      });
      const deviceId = jsonResponse<{ deviceId: string }>(approved).deviceId;
      const paired = await host.server.inject({
        method: "POST", url: "/api/pair/requests/" + pair.requestId + "/session", headers: { origin: relayOrigin }, payload: {},
      });
      const cookie = String(paired.headers["set-cookie"]).split(";")[0];

      const pendingWindows = host.server.inject({ method: "GET", url: "/api/windows", headers: { origin: relayOrigin, cookie } });
      await discoveryStarted;
      const revoked = await host.server.inject({
        method: "DELETE", url: "/api/local/devices/" + deviceId,
        headers: { origin: localOrigin, "x-csrf-token": localCsrf },
      });
      expect(revoked.statusCode).toBe(204);
      releaseDiscovery({ candidates: [{ token: targetToken, appName: "Secret title", title: "Secret window" }], expiresAt: "2026-09-26T00:10:00.000Z" });
      const response = await pendingWindows;
      expect(response.statusCode).toBe(401);
      expect(response.payload).not.toContain("Secret window");
    } finally {
      releaseDiscovery({ candidates: [], expiresAt: new Date().toISOString() });
      await host.close();
    }
  });
});
