import { describe, expect, it, vi } from "vitest";
import { createHostServer } from "./server.js";
import type { VoiceInputCapabilities, VoiceInputSessionService, VoiceSessionUpdate } from "@computer-harness/voice";
import type { RemoteRunApi } from "@computer-harness/app-runtime";

const localOrigin = "http://localhost:4317";
const relayOrigin = "https://relay.example";

function createApi(): RemoteRunApi {
  return {
    listRuns: () => [],
    getRun: () => undefined,
    listWindowTargets: async () => ({ candidates: [], expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    startRun: async () => { throw new Error("not used"); },
    submitCommand: async () => { throw new Error("not used"); },
    getCommandReceipt: () => undefined,
    subscribe: () => ({ close: () => undefined }),
    getAsset: () => undefined,
  };
}

function createVoiceService() {
  const calls: Array<{ method: string; deviceId: string; sessionId?: string; chunkCount?: number }> = [];
  const capabilities: VoiceInputCapabilities = {
    available: true,
    provider: "qwen3-asr-flash-realtime",
    sampleRate: 16_000,
    channels: 1,
    chunkBytes: 3_200,
    maxDurationMs: 60_000,
  };
  const update = (sessionId: string): VoiceSessionUpdate => ({ sessionId, events: [], eventCursor: 0 });
  const service: VoiceInputSessionService = {
    capabilities: () => capabilities,
    start: async (deviceId, requestId) => {
      calls.push({ method: "start:" + requestId, deviceId });
      return update("voice-session-1");
    },
    append: async (deviceId, sessionId, chunks, _cursor) => {
      calls.push({ method: "append", deviceId, sessionId, chunkCount: chunks.length });
      return update(sessionId);
    },
    finish: async (deviceId, sessionId, _cursor) => {
      calls.push({ method: "finish", deviceId, sessionId });
      return update(sessionId);
    },
    cancel: async (deviceId, sessionId, _cursor) => {
      calls.push({ method: "cancel", deviceId, sessionId });
      return update(sessionId);
    },
    cancelDevice: vi.fn(async (deviceId) => { calls.push({ method: "cancelDevice", deviceId }); }),
    close: vi.fn(async () => undefined),
  };
  return { service, calls };
}

async function pair(host: ReturnType<typeof createHostServer>) {
  const localCsrf = (await host.server.inject({ method: "GET", url: "/api/local/session", headers: { origin: localOrigin } })).json<{ csrfToken: string }>().csrfToken;
  const challenge = (await host.server.inject({
    method: "POST", url: "/api/local/pairing", headers: { origin: localOrigin, "x-csrf-token": localCsrf }, payload: {},
  })).json<{ pairingUrl: string }>();
  const token = new URL(challenge.pairingUrl).searchParams.get("token")!;
  const request = (await host.server.inject({
    method: "POST", url: "/api/pair/requests", headers: { origin: relayOrigin }, payload: { token, clientName: "Voice test phone" },
  })).json<{ requestId: string }>();
  const approved = await host.server.inject({
    method: "POST", url: "/api/local/pairing/requests/" + request.requestId + "/confirm",
    headers: { origin: localOrigin, "x-csrf-token": localCsrf }, payload: { approved: true },
  });
  const deviceId = approved.json<{ deviceId: string }>().deviceId;
  const paired = await host.server.inject({
    method: "POST", url: "/api/pair/requests/" + request.requestId + "/session", headers: { origin: relayOrigin }, payload: {},
  });
  return {
    deviceId,
    requestId: request.requestId,
    localCsrf,
    csrfToken: paired.json<{ csrfToken: string }>().csrfToken,
    cookie: String(paired.headers["set-cookie"]).split(";")[0]!,
  };
}

describe("Host voice routes", () => {
  it("requires an authenticated paired session, CSRF for writes, and binds every operation to its device", async () => {
    const voice = createVoiceService();
    const host = createHostServer({ api: createApi(), allowedOrigins: [localOrigin, relayOrigin], bridgeOrigin: relayOrigin, voiceInput: voice.service });
    try {
      const unpaired = await host.server.inject({ method: "GET", url: "/api/voice/capabilities", headers: { origin: relayOrigin } });
      expect(unpaired.statusCode).toBe(401);
      const session = await pair(host);
      const headers = { origin: relayOrigin, cookie: session.cookie };

      const capabilities = await host.server.inject({ method: "GET", url: "/api/voice/capabilities", headers });
      expect(capabilities.statusCode).toBe(200);
      expect(capabilities.json()).toEqual(voice.service.capabilities());

      const noCsrf = await host.server.inject({ method: "POST", url: "/api/voice/sessions", headers, payload: { requestId: "voice-request-1" } });
      expect(noCsrf.statusCode).toBe(403);
      const started = await host.server.inject({
        method: "POST", url: "/api/voice/sessions", headers: { ...headers, "x-csrf-token": session.csrfToken }, payload: { requestId: "voice-request-1" },
      });
      expect(started.statusCode).toBe(201);
      expect(started.json()).toMatchObject({ sessionId: "voice-session-1" });

      const invalidChunk = await host.server.inject({
        method: "POST", url: "/api/voice/sessions/voice-session-1/audio",
        headers: { ...headers, "x-csrf-token": session.csrfToken },
        payload: { chunks: [{ sequence: 0, audio: "AQ==" }], afterEventSequence: 0 },
      });
      expect(invalidChunk.statusCode).toBe(400);

      const bridgeSessionResponse = await host.relayHandler.request({
        type: "bridge.request", requestId: "bridge-voice-session", method: "POST",
        path: "/api/pair/requests/" + session.requestId + "/session", body: {},
      });
      expect(bridgeSessionResponse.statusCode).toBe(200);
      const bridgeSession = bridgeSessionResponse.body as { deviceId: string; sessionToken: string; csrfToken: string };
      expect(bridgeSession.deviceId).toBe(session.deviceId);

      const wrongDevice = await host.relayHandler.request({
        type: "bridge.request", requestId: "bridge-wrong-device", method: "POST", path: "/api/voice/sessions/voice-session-1/finish",
        deviceId: "other-device", sessionToken: bridgeSession.sessionToken, csrfToken: bridgeSession.csrfToken,
        body: { afterEventSequence: 0 },
      });
      expect(wrongDevice.statusCode).toBe(401);

      const append = await host.relayHandler.request({
        type: "bridge.request", requestId: "bridge-voice-append", method: "POST", path: "/api/voice/sessions/voice-session-1/audio",
        deviceId: session.deviceId,
        sessionToken: bridgeSession.sessionToken,
        csrfToken: bridgeSession.csrfToken,
        body: {
          chunks: [
            { sequence: 0, audio: Buffer.alloc(3_200).toString("base64") },
            { sequence: 1, audio: Buffer.alloc(3_200).toString("base64") },
          ],
          afterEventSequence: 0,
        },
      });
      expect(append.statusCode).toBe(200);
      expect(voice.calls.find((call) => call.method === "append")?.chunkCount).toBe(2);
      const finish = await host.relayHandler.request({
        type: "bridge.request", requestId: "bridge-voice-finish", method: "POST", path: "/api/voice/sessions/voice-session-1/finish",
        deviceId: session.deviceId, sessionToken: bridgeSession.sessionToken, csrfToken: bridgeSession.csrfToken,
        body: { afterEventSequence: 0 },
      });
      expect(finish.statusCode).toBe(200);
      expect(voice.calls.map((call) => call.method)).toContain("append");
      expect(voice.calls.map((call) => call.method)).toContain("finish");
      expect(JSON.stringify(append.body)).not.toContain("DASHSCOPE_API_KEY");
    } finally {
      await host.close();
    }
  });
});
