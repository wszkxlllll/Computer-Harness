import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Computer, ComputerSession, ProviderAdapter } from "@computer-harness/runtime";
import type { ComputerSessionId, RunAssistantPreferencesSnapshot, Viewport } from "@computer-harness/protocol";
import {
  ApplicationRemoteRunApi,
  ApplicationSession,
  createFileRemoteAssetReader,
  type ApplicationSessionConfig,
} from "@computer-harness/app-runtime";
import { InProcessEnvironmentOwner } from "@computer-harness/app-runtime";
import { HostRelayConnector } from "@computer-harness/relay-connector";
import type { RelayBridgeRequest } from "@computer-harness/relay-connector/protocol";
import { createRelayServer } from "../../relay/src/server.js";
import * as webApi from "../../web/src/api.js";
import { createHostServer } from "./server.js";

const viewport: Viewport = { width: 16, height: 12, coordinateSpace: "physical" };
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");

function sessionConfig(outputDir: string): ApplicationSessionConfig {
  return {
    model: "glm-5.3-flash",
    computer: { kind: "osworld", bridgeUrl: "http://fixture.invalid" },
    outputDir,
    maxSteps: 4,
    maxModelRequests: 4,
    planning: false,
    memory: "off",
    memoryRetrieval: "off",
    batching: "off",
    contextMode: "raw",
    contextMaxHistoryEvents: 8,
    riskProfile: "experiment",
    riskGuard: "off",
    riskModel: "off",
    riskMaxModelRequests: 1,
    riskTimeoutMs: 100,
    cleanupDeadlineMs: 100,
  };
}

function fixtureComputer(): Computer {
  const computerSession: ComputerSession = {
    id: "relay-roundtrip-session" as ComputerSessionId,
    backend: "fixture",
    viewport,
    capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false },
    openedAt: new Date().toISOString(),
  };
  let observations = 0;
  return {
    async open() { return computerSession; },
    async observe() {
      observations += 1;
      return {
        capturedAt: new Date().toISOString(),
        viewport,
        screenshot: { mediaType: "image/png" as const, data: new Uint8Array([0x52, 0x54, observations]) },
      };
    },
    async execute() { return { status: "completed" as const }; },
    async close() {},
  } as unknown as Computer;
}

function fixtureProvider(): ProviderAdapter {
  return {
    id: "relay-roundtrip-provider",
    async generate() { return { type: "finish", summary: "The fixture task completed through the paired Web client." }; },
  } as unknown as ProviderAdapter;
}

async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("could not allocate an integration-test port");
  await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error === undefined ? resolveClose() : rejectClose(error)));
  return address.port;
}

describe("built Web API through Host HTTP and the real Relay WSS bridge", () => {
  it("pairs locally, approves on the Host, runs a real ApplicationSession, and reads its result/assets through Relay", async () => {
    const hostId = "host_roundtrip";
    const credential = randomBytes(32).toString("base64url");
    const relayPort = await getFreePort();
    const relayOrigin = "http://127.0.0.1:" + String(relayPort);
    const hostPort = await getFreePort();
    const localOrigin = "http://localhost:" + String(hostPort);
    const hostWireOrigin = "http://127.0.0.1:" + String(hostPort);
    const outputDir = await mkdtemp(join(tmpdir(), "harness-mobile-roundtrip-"));
    const relay = createRelayServer({
      publicOrigin: relayOrigin,
      listenHost: "127.0.0.1",
      listenPort: relayPort,
      webRoot,
      hostCredentials: new Map([[hostId, credential]]),
      requestTimeoutMs: 5_000,
    });
    let session: ApplicationSession | undefined;
    let host: ReturnType<typeof createHostServer> | undefined;
    let connector: HostRelayConnector | undefined;
    let relayCookie: string | undefined;
    const bridgeRequests: RelayBridgeRequest[] = [];
    const hostStartPreferences: Array<RunAssistantPreferencesSnapshot | undefined> = [];
    const originalFetch = globalThis.fetch;

    try {
      await relay.listen();
      session = new ApplicationSession({
        config: sessionConfig(outputDir),
        owner: new InProcessEnvironmentOwner(),
        windowDiscovery: {
          listWindows: async () => [{ pid: 451, windowId: 894, appName: "Fixture app", title: "Fixture window" }],
        },
        dependencies: {
          createProvider: () => fixtureProvider(),
          createComputer: async () => fixtureComputer(),
        },
      });
      const api = new ApplicationRemoteRunApi({
        session,
        capabilities: { pause: true, resume: true, abort: true, correct: true, approval: true, windowHandoff: true },
        assetReaderForRun: (_runId, handle) => createFileRemoteAssetReader(join(handle.config.outputDir, "assets")),
      });
      const originalStartRun = api.startRun.bind(api);
      api.startRun = (deviceId, commandId, goal, target, assistantPreferences) => {
        hostStartPreferences.push(assistantPreferences);
        return originalStartRun(deviceId, commandId, goal, target, assistantPreferences);
      };
      host = createHostServer({
        api,
        allowedOrigins: [localOrigin, relayOrigin],
        bridgeOrigin: relayOrigin,
        pairingUrlForToken: (token) => relayOrigin + "/pair?token=" + encodeURIComponent(token),
        registerPairingToken: (registration) => {
          if (connector === undefined) throw new Error("Relay connector has not been started.");
          return connector.registerPairingToken(registration);
        },
        unregisterPairingToken: (pairingId) => connector?.unregisterPairingToken(pairingId),
        revokeDeviceSession: (deviceId) => connector?.revokeDeviceSession(deviceId),
        staticRoot: webRoot,
        port: hostPort,
      });
      await host.listen();
      const hostRelayHandler = host.relayHandler;
      connector = new HostRelayConnector({
        relayUrl: relayOrigin,
        hostId,
        credential,
        allowInsecureLocalhost: true,
        handlers: {
          ...hostRelayHandler,
          request: async (request: RelayBridgeRequest) => {
            bridgeRequests.push(request);
            return hostRelayHandler.request(request);
          },
        },
      });
      await connector.start();

      const hostPage = await originalFetch(hostWireOrigin + "/");
      const relayPage = await originalFetch(relayOrigin + "/");
      expect(hostPage.status).toBe(200);
      expect(relayPage.status).toBe(200);
      expect(await hostPage.text()).toContain("<html");
      expect(await relayPage.text()).toContain("<html");

      globalThis.fetch = async (input, init) => {
        const inputText = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const path = new URL(inputText, localOrigin).pathname;
        const isLocal = path.startsWith("/api/local/");
        const targetOrigin = isLocal ? hostWireOrigin : relayOrigin;
        const url = new URL(inputText, targetOrigin);
        const method = (init?.method ?? "GET").toUpperCase();
        const headers = new Headers(init?.headers);
        headers.set("Origin", isLocal ? localOrigin : relayOrigin);
        if (!isLocal && relayCookie !== undefined) headers.set("Cookie", relayCookie);
        const response = await originalFetch(url, { ...init, headers });
        if (!isLocal && method === "POST" && /\/api\/pair\/requests\/[^/]+\/session$/u.test(url.pathname) && response.ok) {
          relayCookie = response.headers.get("set-cookie")?.split(";")[0];
        }
        return response;
      };

      await webApi.getLocalSession();
      const challenge = await webApi.createPairingChallenge();
      expect(challenge.pairingUrl).toContain(relayOrigin + "/pair?token=");
      const token = new URL(challenge.pairingUrl).searchParams.get("token");
      expect(token).toMatch(/^[A-Za-z0-9_-]{40,64}$/u);

      const pair = await webApi.submitPairRequest(token!, "Integration phone");
      expect(pair.status).toBe("pending_local_confirmation");
      const localState = await webApi.getLocalPairing();
      const pending = localState.requests?.find((request) => request.clientName === "Integration phone");
      expect(pending?.status).toBe("pending");
      await webApi.confirmPairingRequest(pending!.requestId, true, "Integration phone");
      expect((await webApi.getPairRequest(pair.requestId)).status).toBe("approved");

      const phoneSession = await webApi.establishPairSession(pair.requestId);
      expect(phoneSession.csrfToken).toBeTruthy();
      expect(relayCookie).toMatch(/^harness_relay_session=[A-Za-z0-9_-]{40,64}$/u);
      webApi.setPhoneCsrfToken(phoneSession.csrfToken);
      expect((await webApi.getPhoneSession()).csrfToken).toBe(phoneSession.csrfToken);

      const windowChoices = await webApi.listWindowTargets();
      expect(windowChoices.candidates).toHaveLength(1);
      expect(JSON.stringify(windowChoices)).not.toMatch(/pid|windowId/iu);
      const assistantPreferences: RunAssistantPreferencesSnapshot = {
        version: 1,
        responseDetail: "detailed",
        stepExplanation: "more",
        preferredLanguage: "zh-CN",
        additionalGuidance: "Group findings by topic.",
      };
      let accepted: { runId: string; status: string };
      try {
        accepted = await webApi.createRun("Complete a fixture task", "web-start-roundtrip", {
          mode: "window",
          targetToken: windowChoices.candidates[0]!.token,
        }, assistantPreferences);
      } catch (error) {
        const apiError = error as { status?: number; code?: string };
        throw new Error("Fixture run start failed with HTTP " + String(apiError.status) + " " + String(apiError.code));
      }
      expect(accepted.runId).toBeTruthy();
      const bridgedStart = bridgeRequests.find((request) => request.method === "POST"
        && request.path === "/api/runs"
        && request.body?.commandId === "web-start-roundtrip");
      expect(bridgedStart?.body).toEqual({
        commandId: "web-start-roundtrip",
        goal: "Complete a fixture task",
        target: { mode: "window", targetToken: windowChoices.candidates[0]!.token },
        assistantPreferences,
      });
      expect(hostStartPreferences).toEqual([assistantPreferences]);
      await session.waitForActiveRun();

      const bridgedRunCountBeforeInvalidStarts = bridgeRequests.filter((request) => request.method === "POST" && request.path === "/api/runs").length;
      for (const [index, invalidPreferences] of [
        { ...assistantPreferences, version: 2 },
        { ...assistantPreferences, presentation: { textSize: "large" } },
      ].entries()) {
        const invalidStart = await originalFetch(relayOrigin + "/api/runs", {
          method: "POST",
          headers: {
            Origin: relayOrigin,
            Cookie: relayCookie!,
            "Content-Type": "application/json",
            "x-csrf-token": phoneSession.csrfToken,
          },
          body: JSON.stringify({
            commandId: `invalid-preferences-${index}`,
            goal: "This request must stop at Relay",
            target: { mode: "auto" },
            assistantPreferences: invalidPreferences,
          }),
        });
        expect(invalidStart.status).toBe(400);
      }
      expect(bridgeRequests.filter((request) => request.method === "POST" && request.path === "/api/runs")).toHaveLength(bridgedRunCountBeforeInvalidStarts);
      expect(hostStartPreferences).toHaveLength(1);

      const summaries = await webApi.listRuns();
      expect(summaries).toHaveLength(1);
      const completed = await webApi.getRun(accepted.runId);
      expect(completed.status).toBe("finished");
      expect(completed.reply).toBe("The fixture task completed through the paired Web client.");
      expect(completed.latestAssetId).toBeTruthy();

      const assetResponse = await globalThis.fetch(webApi.runAssetUrl(accepted.runId, completed.latestAssetId!));
      expect(assetResponse.status).toBe(200);
      expect(assetResponse.headers.get("content-type")).toContain("image/png");
      expect((await assetResponse.arrayBuffer()).byteLength).toBeGreaterThan(0);

      await webApi.deletePhoneSession();
      await expect(webApi.listRuns()).rejects.toMatchObject({ status: 401 });
    } finally {
      globalThis.fetch = originalFetch;
      webApi.setPhoneCsrfToken(undefined);
      webApi.setLocalCsrfToken(undefined);
      connector?.close();
      if (host !== undefined) await host.close().catch(() => undefined);
      if (session !== undefined) await session.close().catch(() => undefined);
      await relay.close().catch(() => undefined);
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
