import { describe, expect, it, vi } from "vitest";
import { RemoteRunApiError, type RemoteRunApi, type RemoteRunSnapshot, type RemoteRunTargetInput } from "@computer-harness/app-runtime";
import type { AssetId, RunAssistantPreferencesSnapshot, RunId } from "@computer-harness/protocol";
import { createHostServer } from "./server.js";
import { ManagedBrowserProfileServiceError, type ManagedBrowserProfileStateView } from "./managed-browser-profile-service.js";

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
    startRun: async (_deviceId, commandId, goal, _target) => ({
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
  it("exposes only the authenticated managed-profile contract and keeps commands idempotent", async () => {
    const operationId = "11111111-1111-4111-8111-111111111111";
    let state: ManagedBrowserProfileStateView = {
      status: "unprepared",
      defaultSession: "saved",
      commands: {
        prepare: "/api/managed-browser-profile/prepare",
        complete: "/api/managed-browser-profile/complete",
        relogin: "/api/managed-browser-profile/relogin",
      },
    };
    const profile = {
      getState: vi.fn(async () => state),
      setDefaultSession: vi.fn(async (value: unknown) => {
        state = { ...state, defaultSession: value as "saved" | "temporary" };
        return state;
      }),
      prepare: vi.fn(async () => {
        state = { ...state, status: "preparing", operationId };
        return state;
      }),
      complete: vi.fn(async (value: unknown) => {
        if (value !== operationId) throw new ManagedBrowserProfileServiceError(409, "PROFILE_OPERATION_STALE", "stale operation");
        const { operationId: _operationId, ...ready } = { ...state, status: "ready" as const };
        state = ready;
        return state;
      }),
      relogin: vi.fn(async () => {
        state = { ...state, status: "preparing", operationId };
        return state;
      }),
    };
    const host = createHostServer({
      api: fakeApi(),
      allowedOrigins: [localOrigin, relayOrigin],
      bridgeOrigin: relayOrigin,
      managedBrowserProfile: profile,
    });
    try {
      const unauthorized = await host.server.inject({ method: "GET", url: "/api/managed-browser-profile", headers: { origin: relayOrigin } });
      expect(unauthorized.statusCode).toBe(401);

      const localSession = await host.server.inject({ method: "GET", url: "/api/local/session", headers: { origin: localOrigin } });
      const localCsrf = jsonResponse<{ csrfToken: string }>(localSession).csrfToken;
      const challenge = jsonResponse<{ pairingUrl: string }>(await host.server.inject({
        method: "POST", url: "/api/local/pairing", headers: { origin: localOrigin, "x-csrf-token": localCsrf }, payload: {},
      }));
      const token = new URL(challenge.pairingUrl).searchParams.get("token");
      const pair = jsonResponse<{ requestId: string }>(await host.server.inject({
        method: "POST", url: "/api/pair/requests", headers: { origin: relayOrigin }, payload: { token, clientName: "Profile phone" },
      }));
      await host.server.inject({
        method: "POST", url: "/api/local/pairing/requests/" + pair.requestId + "/confirm",
        headers: { origin: localOrigin, "x-csrf-token": localCsrf }, payload: { approved: true },
      });
      const paired = await host.server.inject({ method: "POST", url: "/api/pair/requests/" + pair.requestId + "/session", headers: { origin: relayOrigin }, payload: {} });
      const cookie = String(paired.headers["set-cookie"]).split(";")[0];
      const pairedBody = jsonResponse<{ csrfToken: string; deviceId: string }>(paired);
      const csrf = pairedBody.csrfToken;
      const sessionToken = cookie.split("=")[1] ?? "";
      const headers = { origin: relayOrigin, cookie, "x-csrf-token": csrf };

      const status = await host.server.inject({ method: "GET", url: "/api/managed-browser-profile", headers });
      expect(status.statusCode).toBe(200);
      expect(jsonResponse(status)).toMatchObject({ status: "unprepared", defaultSession: "saved" });
      expect(JSON.stringify(status.json())).not.toMatch(/profileRoot|profileLabel|cookie|credential|pid|windowId/iu);

      const missingCsrf = await host.server.inject({
        method: "PUT", url: "/api/managed-browser-profile/preference", headers: { origin: relayOrigin, cookie }, payload: { defaultSession: "temporary" },
      });
      expect(missingCsrf.statusCode).toBe(403);
      expect(profile.setDefaultSession).not.toHaveBeenCalled();

      const extraPreferenceField = await host.server.inject({
        method: "PUT", url: "/api/managed-browser-profile/preference", headers, payload: { defaultSession: "temporary", profileRoot: "C:\\client" },
      });
      expect(extraPreferenceField.statusCode).toBe(400);
      const firstPreference = await host.server.inject({ method: "PUT", url: "/api/managed-browser-profile/preference", headers, payload: { defaultSession: "temporary" } });
      const repeatedPreference = await host.server.inject({ method: "PUT", url: "/api/managed-browser-profile/preference", headers, payload: { defaultSession: "temporary" } });
      expect(jsonResponse(firstPreference)).toMatchObject({ defaultSession: "temporary" });
      expect(jsonResponse(repeatedPreference)).toEqual(jsonResponse(firstPreference));
      expect(profile.setDefaultSession).toHaveBeenCalledTimes(2);

      const missingCommandCsrf = await host.server.inject({
        method: "POST", url: "/api/managed-browser-profile/prepare", headers: { origin: relayOrigin, cookie }, payload: {},
      });
      expect(missingCommandCsrf.statusCode).toBe(403);
      const prepareWithExtraField = await host.server.inject({ method: "POST", url: "/api/managed-browser-profile/prepare", headers, payload: { profileRoot: "C:\\client" } });
      expect(prepareWithExtraField.statusCode).toBe(400);

      const preparation = await host.server.inject({ method: "POST", url: "/api/managed-browser-profile/prepare", headers, payload: {} });
      const repeatedPreparation = await host.server.inject({ method: "POST", url: "/api/managed-browser-profile/prepare", headers, payload: {} });
      expect(preparation.statusCode).toBe(200);
      expect(jsonResponse<{ operationId: string }>(repeatedPreparation).operationId).toBe(operationId);

      const staleComplete = await host.server.inject({ method: "POST", url: "/api/managed-browser-profile/complete", headers, payload: { operationId: "22222222-2222-4222-8222-222222222222" } });
      expect(staleComplete.statusCode).toBe(409);
      const malformedComplete = await host.server.inject({ method: "POST", url: "/api/managed-browser-profile/complete", headers, payload: { operationId, profileRoot: "C:\\client" } });
      expect(malformedComplete.statusCode).toBe(400);
      const completed = await host.server.inject({ method: "POST", url: "/api/managed-browser-profile/complete", headers, payload: { operationId } });
      const repeatedComplete = await host.server.inject({ method: "POST", url: "/api/managed-browser-profile/complete", headers, payload: { operationId } });
      expect(jsonResponse(completed)).toMatchObject({ status: "ready", defaultSession: "temporary" });
      expect(jsonResponse(repeatedComplete)).toEqual(jsonResponse(completed));

      const relogin = await host.server.inject({ method: "POST", url: "/api/managed-browser-profile/relogin", headers, payload: {} });
      expect(jsonResponse(relogin)).toMatchObject({ status: "preparing", operationId });

      const bridgeStatus = await host.relayHandler.request({
        type: "bridge.request", requestId: "profile-bridge-status", method: "GET", path: "/api/managed-browser-profile",
        deviceId: pairedBody.deviceId, sessionToken,
      });
      expect(bridgeStatus.statusCode).toBe(200);
      expect(bridgeStatus.body).toMatchObject({ status: "preparing", defaultSession: "temporary" });
      const bridgeMissingCsrf = await host.relayHandler.request({
        type: "bridge.request", requestId: "profile-bridge-missing-csrf", method: "PUT", path: "/api/managed-browser-profile/preference",
        deviceId: pairedBody.deviceId, sessionToken, body: { defaultSession: "saved" },
      });
      expect(bridgeMissingCsrf.statusCode).toBe(403);
      const bridgePreference = await host.relayHandler.request({
        type: "bridge.request", requestId: "profile-bridge-preference", method: "PUT", path: "/api/managed-browser-profile/preference",
        deviceId: pairedBody.deviceId, sessionToken, csrfToken: csrf, body: { defaultSession: "saved" },
      });
      expect(bridgePreference.statusCode).toBe(200);
      const bridgePrepare = await host.relayHandler.request({
        type: "bridge.request", requestId: "profile-bridge-prepare", method: "POST", path: "/api/managed-browser-profile/prepare",
        deviceId: pairedBody.deviceId, sessionToken, csrfToken: csrf, body: {},
      });
      expect(bridgePrepare.statusCode).toBe(200);
      const bridgeComplete = await host.relayHandler.request({
        type: "bridge.request", requestId: "profile-bridge-complete", method: "POST", path: "/api/managed-browser-profile/complete",
        deviceId: pairedBody.deviceId, sessionToken, csrfToken: csrf, body: { operationId },
      });
      expect(bridgeComplete.statusCode).toBe(200);
      const bridgeRelogin = await host.relayHandler.request({
        type: "bridge.request", requestId: "profile-bridge-relogin", method: "POST", path: "/api/managed-browser-profile/relogin",
        deviceId: pairedBody.deviceId, sessionToken, csrfToken: csrf, body: {},
      });
      expect(bridgeRelogin.statusCode).toBe(200);
    } finally {
      await host.close();
    }
  });

  it("requires local confirmation, HttpOnly session cookies, CSRF, and revocable paired devices", async () => {
    const revoked: string[] = [];
    const api = fakeApi();
    const targetsReceived: RemoteRunTargetInput[] = [];
    const assistantPreferencesReceived: RunAssistantPreferencesSnapshot[] = [];
    const runNoticeContentOptIns: boolean[] = [];
    const host = createHostServer({
      api: {
        ...api,
        startRun: (deviceId, commandId, goal, target, assistantPreferences, runNoticeContentEnabled) => {
          targetsReceived.push(target);
          if (assistantPreferences !== undefined) assistantPreferencesReceived.push(assistantPreferences);
          if (runNoticeContentEnabled === true) runNoticeContentOptIns.push(true);
          if (typeof target !== "string" && target.mode === "auto" && goal === "Ambiguous goal") {
            return Promise.reject(new RemoteRunApiError("WINDOW_SELECTION_REQUIRED", "No single visible window confidently matches this goal. Choose a window manually."));
          }
          return api.startRun(deviceId, commandId, goal, target, assistantPreferences, runNoticeContentEnabled);
        },
      },
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

      const autoStart = await host.server.inject({
        method: "POST",
        url: "/api/runs",
        headers: { origin: relayOrigin, cookie, "x-csrf-token": pairedBody.csrfToken },
        payload: { commandId: "start-auto", goal: "Open a matching app", target: { mode: "auto" } },
      });
      expect(autoStart.statusCode).toBe(202);
      const autoSwitchStart = await host.server.inject({
        method: "POST",
        url: "/api/runs",
        headers: { origin: relayOrigin, cookie, "x-csrf-token": pairedBody.csrfToken },
        payload: { commandId: "start-auto-switch", goal: "Open a listed app", target: { mode: "auto", switchWindows: true } },
      });
      expect(autoSwitchStart.statusCode).toBe(202);
      const desktopStart = await host.server.inject({
        method: "POST",
        url: "/api/runs",
        headers: { origin: relayOrigin, cookie, "x-csrf-token": pairedBody.csrfToken },
        payload: { commandId: "start-desktop", goal: "Inspect a desktop popup", target: { mode: "desktop" } },
      });
      expect(desktopStart.statusCode).toBe(202);
      const desktopSwitchStart = await host.server.inject({
        method: "POST",
        url: "/api/runs",
        headers: { origin: relayOrigin, cookie, "x-csrf-token": pairedBody.csrfToken },
        payload: { commandId: "start-desktop-switch", goal: "Inspect a popup", target: { mode: "desktop", switchWindows: true } },
      });
      expect(desktopSwitchStart.statusCode).toBe(202);
      const desktopNoSwitchStart = await host.server.inject({
        method: "POST",
        url: "/api/runs",
        headers: { origin: relayOrigin, cookie, "x-csrf-token": pairedBody.csrfToken },
        payload: { commandId: "start-desktop-no-switch", goal: "Inspect a popup", target: { mode: "desktop", switchWindows: false } },
      });
      expect(desktopNoSwitchStart.statusCode).toBe(202);
      const malformedDesktopSwitchFlag = await host.server.inject({
        method: "POST",
        url: "/api/runs",
        headers: { origin: relayOrigin, cookie, "x-csrf-token": pairedBody.csrfToken },
        payload: { commandId: "start-desktop-malformed-switch", goal: "Inspect a popup", target: { mode: "desktop", switchWindows: "yes" } },
      });
      expect(malformedDesktopSwitchFlag.statusCode).toBe(400);
      const malformedSwitchFlag = await host.server.inject({
        method: "POST",
        url: "/api/runs",
        headers: { origin: relayOrigin, cookie, "x-csrf-token": pairedBody.csrfToken },
        payload: { commandId: "start-malformed-switch", goal: "Open a listed app", target: { mode: "auto", switchWindows: "yes" } },
      });
      expect(malformedSwitchFlag.statusCode).toBe(400);
      const browserStart = await host.server.inject({
        method: "POST",
        url: "/api/runs",
        headers: { origin: relayOrigin, cookie, "x-csrf-token": pairedBody.csrfToken },
        payload: { commandId: "start-browser", goal: "Check a page", target: { mode: "browser", url: "https://example.test/path" } },
      });
      expect(browserStart.statusCode).toBe(202);
      const blankBrowserStart = await host.server.inject({
        method: "POST",
        url: "/api/runs",
        headers: { origin: relayOrigin, cookie, "x-csrf-token": pairedBody.csrfToken },
        payload: { commandId: "start-browser-blank", goal: "Open a blank page", target: { mode: "browser" } },
      });
      expect(blankBrowserStart.statusCode).toBe(202);
      const emptyBrowserStart = await host.server.inject({
        method: "POST",
        url: "/api/runs",
        headers: { origin: relayOrigin, cookie, "x-csrf-token": pairedBody.csrfToken },
        payload: { commandId: "start-browser-empty", goal: "Open a blank page", target: { mode: "browser", url: " \t " } },
      });
      expect(emptyBrowserStart.statusCode).toBe(202);
      const savedBrowserStart = await host.server.inject({
        method: "POST",
        url: "/api/runs",
        headers: { origin: relayOrigin, cookie, "x-csrf-token": pairedBody.csrfToken },
        payload: { commandId: "start-browser-saved", goal: "Use a saved site", target: { mode: "browser", sessionMode: "saved" } },
      });
      expect(savedBrowserStart.statusCode).toBe(202);
      expect(targetsReceived).toEqual([
        targetToken,
        { mode: "auto" },
        { mode: "auto", switchWindows: true },
        { mode: "desktop" },
        { mode: "desktop", switchWindows: true },
        { mode: "desktop" },
        { mode: "browser", url: "https://example.test/path" },
        { mode: "browser" },
        { mode: "browser", url: " \t " },
        { mode: "browser", sessionMode: "saved" },
      ]);

      const assistantStart = await host.server.inject({
        method: "POST",
        url: "/api/runs",
        headers: { origin: relayOrigin, cookie, "x-csrf-token": pairedBody.csrfToken },
        payload: {
          commandId: "start-assistant-preferences",
          goal: "Summarize this page",
          target: { mode: "auto" },
          assistantPreferences: {
            version: 1,
            responseDetail: "detailed",
            stepExplanation: "more",
            preferredLanguage: "zh-CN",
            additionalGuidance: "  Keep\nrows\u0000 safely\u202E  ",
          },
        },
      });
      expect(assistantStart.statusCode).toBe(202);
      expect(assistantPreferencesReceived).toEqual([{
        version: 1,
        responseDetail: "detailed",
        stepExplanation: "more",
        preferredLanguage: "zh-CN",
        additionalGuidance: "Keep rows safely",
      }]);
      expect(Object.isFrozen(assistantPreferencesReceived[0])).toBe(true);

      const noticeOptInStart = await host.server.inject({
        method: "POST",
        url: "/api/runs",
        headers: { origin: relayOrigin, cookie, "x-csrf-token": pairedBody.csrfToken },
        payload: {
          commandId: "start-notice-content-opt-in",
          goal: "Check a page",
          target: { mode: "auto" },
          runNoticeContentEnabled: true,
        },
      });
      expect(noticeOptInStart.statusCode).toBe(202);
      expect(runNoticeContentOptIns).toEqual([true]);
      const invalidNoticeContentOptIn = await host.server.inject({
        method: "POST",
        url: "/api/runs",
        headers: { origin: relayOrigin, cookie, "x-csrf-token": pairedBody.csrfToken },
        payload: {
          commandId: "start-invalid-notice-content-opt-in",
          goal: "Check a page",
          target: { mode: "auto" },
          runNoticeContentEnabled: "true",
        },
      });
      expect(invalidNoticeContentOptIn.statusCode).toBe(400);
      expect(runNoticeContentOptIns).toEqual([true]);

      const invalidAssistantPreferences = [
        { version: 1, responseDetail: "detailed", stepExplanation: "more", preferredLanguage: "zh-CN", additionalGuidance: "fine", presentation: { textSize: "large" } },
        { version: 1, responseDetail: "detailed", stepExplanation: "more", preferredLanguage: "zh-CN", additionalGuidance: "x".repeat(601) },
        { version: 1, responseDetail: "verbose", stepExplanation: "more", preferredLanguage: "zh-CN", additionalGuidance: "fine" },
        { version: 1, responseDetail: "detailed", stepExplanation: "more", preferredLanguage: "zh-CN", additionalGuidance: 12 },
      ];
      for (const [index, assistantPreferences] of invalidAssistantPreferences.entries()) {
        const rejected = await host.server.inject({
          method: "POST",
          url: "/api/runs",
          headers: { origin: relayOrigin, cookie, "x-csrf-token": pairedBody.csrfToken },
          payload: { commandId: `start-invalid-prefs-${index}`, goal: "Check a page", target: { mode: "auto" }, assistantPreferences },
        });
        expect(rejected.statusCode).toBe(400);
      }
      const forbiddenPresentation = await host.server.inject({
        method: "POST",
        url: "/api/runs",
        headers: { origin: relayOrigin, cookie, "x-csrf-token": pairedBody.csrfToken },
        payload: { commandId: "start-presentation-prefs", goal: "Check a page", target: { mode: "auto" }, presentation: { textSize: "large" } },
      });
      expect(forbiddenPresentation.statusCode).toBe(400);
      expect(assistantPreferencesReceived).toHaveLength(1);

      const selectionRequired = await host.server.inject({
        method: "POST",
        url: "/api/runs",
        headers: { origin: relayOrigin, cookie, "x-csrf-token": pairedBody.csrfToken },
        payload: { commandId: "start-auto-abstain", goal: "Ambiguous goal", target: { mode: "auto" } },
      });
      expect(selectionRequired.statusCode).toBe(409);
      expect(jsonResponse<{ error: { code: string; message: string } }>(selectionRequired)).toEqual({
        error: { code: "WINDOW_SELECTION_REQUIRED", message: "No single visible window confidently matches this goal. Choose a window manually." },
      });

      const bothTargetFields = await host.server.inject({
        method: "POST",
        url: "/api/runs",
        headers: { origin: relayOrigin, cookie, "x-csrf-token": pairedBody.csrfToken },
        payload: { commandId: "start-both", goal: "Check a page", targetToken, target: { mode: "auto" } },
      });
      expect(bothTargetFields.statusCode).toBe(400);
      const unknownTargetField = await host.server.inject({
        method: "POST",
        url: "/api/runs",
        headers: { origin: relayOrigin, cookie, "x-csrf-token": pairedBody.csrfToken },
        payload: { commandId: "start-extra", goal: "Check a page", target: { mode: "browser", url: "https://example.test", profileRoot: "C:\\client" } },
      });
      expect(unknownTargetField.statusCode).toBe(400);
      const missingTarget = await host.server.inject({
        method: "POST",
        url: "/api/runs",
        headers: { origin: relayOrigin, cookie, "x-csrf-token": pairedBody.csrfToken },
        payload: { commandId: "start-missing", goal: "Check a page" },
      });
      expect(missingTarget.statusCode).toBe(400);

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
