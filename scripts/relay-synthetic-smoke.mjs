#!/usr/bin/env node
import { randomBytes, randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HELP = `Usage:
  node scripts/relay-synthetic-smoke.mjs --help
  node scripts/relay-synthetic-smoke.mjs --self-test
  node scripts/relay-synthetic-smoke.mjs --relay-url https://relay.example --config PATH

Public mode uses a private JSON Relay config file. It accepts either the normal
Relay config shape {"publicOrigin":"https://…","hostCredentials":[{"hostId":"…","credential":"…"}]}
or a single-entry {"hostId":"…","credential":"…"} object. The first
hostCredentials entry is used. No credential or pairing/session token is
accepted as a command-line argument or written to output.
On non-Windows systems, public mode also requires the config file to have no
group/other permission bits. On Windows, restrict it with an ACL before use.

The Host identity must be registered on that Relay and must not be connected
elsewhere while this bounded synthetic check runs. It creates one temporary
paired device and one fixture Run, then revokes that device. The fixture uses a
fake Computer and Provider through the real ApplicationSession, Host HTTP API,
outbound Relay connector, and public Relay API; it does not use a physical
desktop or a model provider. It requires the workspace build outputs to exist.

Do not point this at a shared Host identity while its normal Host is connected.
Public mode requires HTTPS. --self-test starts an isolated local Relay and does
not read any config file or contact a public server.
`;

const HTTP_TIMEOUT_MS = 15_000;
const OPERATION_TIMEOUT_MS = 35_000;
const MAX_JSON_RESPONSE_BYTES = 1024 * 1024;
const MAX_ASSET_RESPONSE_BYTES = 8 * 1024 * 1024;
const FIXTURE_REPLY = "Synthetic Relay smoke completed entirely with fixture adapters.";
const FIXTURE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
  "base64",
);

let currentStage = "startup";
let currentHttpStatus;

class SmokeFailure extends Error {
  constructor(stage, statusCode, safeCode) {
    super("synthetic smoke failed");
    this.stage = stage;
    this.statusCode = statusCode;
    this.safeCode = safeCode;
  }
}

function parseArguments(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) return { help: true };
  if (argv.length === 1 && argv[0] === "--self-test") return { selfTest: true };

  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key !== "--relay-url" && key !== "--config") throw new Error("invalid arguments");
    const value = argv[index + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--") || values.has(key)) {
      throw new Error("invalid arguments");
    }
    values.set(key, value);
    index += 1;
  }
  if (values.size !== 2) throw new Error("invalid arguments");
  return { relayUrl: values.get("--relay-url"), configPath: values.get("--config") };
}

function relayOriginFromInput(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("invalid relay URL");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" ||
      url.pathname !== "/" && url.pathname !== "" || url.search !== "" || url.hash !== "") {
    throw new Error("public relay URL must be an HTTPS origin without credentials or a path");
  }
  return url.origin;
}

async function readPrivateHostCredential(configPath, expectedOrigin) {
  try {
    const metadata = await stat(configPath);
    if (!metadata.isFile()) throw new Error("not a file");
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) throw new Error("permissions too broad");
    const parsed = JSON.parse(await readFile(configPath, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid object");

    if (typeof parsed.publicOrigin === "string" && new URL(parsed.publicOrigin).origin !== expectedOrigin) {
      throw new Error("relay origin mismatch");
    }
    const entry = Array.isArray(parsed.hostCredentials) ? parsed.hostCredentials[0] : parsed;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error("missing identity");
    const { hostId, credential } = entry;
    if (typeof hostId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(hostId) ||
        typeof credential !== "string" || credential.length < 32 || credential.length > 4096 ||
        !/^[!-~]+$/u.test(credential) || credential.includes("REPLACE")) {
      throw new Error("invalid identity");
    }
    return { hostId, credential };
  } catch {
    throw new Error("private Relay config is unavailable or invalid");
  }
}

async function importRuntimeModules() {
  try {
    const [appRuntime, connectorModule, hostModule] = await Promise.all([
      import("../packages/app-runtime/dist/index.js"),
      import("../packages/relay-connector/dist/index.js"),
      import("../apps/host/dist/server.js"),
    ]);
    return { appRuntime, connectorModule, hostModule };
  } catch {
    throw new SmokeFailure("build-check");
  }
}

async function getFreeLoopbackPort() {
  const server = createHttpServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise((resolveClose) => server.close(resolveClose));
    throw new SmokeFailure("local-setup");
  }
  const port = address.port;
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error === undefined ? resolveClose() : rejectClose(error));
  });
  return port;
}

function createGate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

function waitWithTimeout(promise, timeoutMs, stage) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new SmokeFailure(stage)), timeoutMs);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function fixtureComputer(viewport) {
  const computerSession = {
    id: "synthetic-relay-smoke-session",
    backend: "synthetic-fixture",
    viewport,
    capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false },
    openedAt: new Date().toISOString(),
  };
  let observationCount = 0;
  return {
    async open() { return computerSession; },
    async observe() {
      observationCount += 1;
      return {
        capturedAt: new Date().toISOString(),
        viewport,
        screenshot: { mediaType: "image/png", data: new Uint8Array(FIXTURE_PNG) },
      };
    },
    async execute() { return { status: "completed" }; },
    async close() {},
  };
}

function fixtureProvider(gate, markStarted, incrementCallCount) {
  return {
    id: "synthetic-relay-smoke-provider",
    async generate(_input, { signal }) {
      const call = incrementCallCount();
      if (call === 1) {
        markStarted();
        if (signal?.aborted) throw signal.reason ?? new Error("fixture request aborted");
        let abortListener;
        const aborted = new Promise((_, reject) => {
          if (signal === undefined) return;
          abortListener = () => reject(signal.reason ?? new Error("fixture request aborted"));
          signal.addEventListener("abort", abortListener, { once: true });
        });
        try {
          await Promise.race([gate.promise, aborted]);
        } finally {
          if (signal !== undefined && abortListener !== undefined) signal.removeEventListener("abort", abortListener);
        }
      }
      return {
        type: "finish",
        summary: call === 1 ? "This pre-correction fixture reply must be invalidated." : FIXTURE_REPLY,
      };
    },
  };
}

function validateJsonObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function fetchResponse(url, init = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...init,
      redirect: "manual",
      signal: init.signal ?? AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch {
    throw new SmokeFailure(currentStage);
  }
  currentHttpStatus = response.status;
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new SmokeFailure(currentStage, response.status);
  }
  return response;
}

async function expectStatus(response, expectedStatus) {
  if (response.status !== expectedStatus) {
    const safeCode = await readSafeErrorCode(response);
    await response.body?.cancel().catch(() => undefined);
    throw new SmokeFailure(currentStage, response.status, safeCode);
  }
}

async function readSafeErrorCode(response) {
  const allowed = new Set([
    "session_required", "csrf_check_failed", "host_unavailable", "route_not_found",
    "invalid_request_body", "invalid_or_expired_pairing_token", "pairing_request_not_found",
    "SESSION_REQUIRED", "SESSION_INVALID", "CSRF_REJECTED", "INVALID_COMMAND",
    "WINDOW_TARGET_STALE", "RUN_BUSY", "STALE_SEQUENCE", "STALE_REQUEST",
  ]);
  try {
    const body = await readBoundedJsonValue(response.clone(), 16 * 1024);
    const code = body?.error?.code ?? body?.error;
    return typeof code === "string" && allowed.has(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

async function readBoundedBytes(response, limit) {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > limit) {
        await reader.cancel().catch(() => undefined);
        throw new SmokeFailure(currentStage, response.status);
      }
      chunks.push(Buffer.from(value));
    }
    return new Uint8Array(Buffer.concat(chunks, byteLength));
  } catch (error) {
    if (error instanceof SmokeFailure) throw error;
    throw new SmokeFailure(currentStage, response.status);
  } finally {
    try { reader.releaseLock(); } catch { /* stream already canceled */ }
  }
}

async function readBoundedJsonValue(response, limit = MAX_JSON_RESPONSE_BYTES) {
  let bytes;
  try { bytes = await readBoundedBytes(response, limit); } catch { throw new SmokeFailure(currentStage, response.status); }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new SmokeFailure(currentStage, response.status);
  }
}

async function readJson(response, expectedStatus) {
  await expectStatus(response, expectedStatus);
  const value = await readBoundedJsonValue(response);
  if (!validateJsonObject(value)) throw new SmokeFailure(currentStage, response.status);
  return value;
}

function makeHeaders({ origin, cookie, csrfToken, json }) {
  const headers = new Headers({
    Accept: "application/json",
    Origin: origin,
  });
  if (json) headers.set("Content-Type", "application/json");
  if (cookie !== undefined) headers.set("Cookie", cookie);
  if (csrfToken !== undefined) headers.set("X-CSRF-Token", csrfToken);
  return headers;
}

function extractRelayCookie(response) {
  const values = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter((value) => value !== null);
  for (const value of values) {
    const match = /(?:^|,\s*)(__Host-harness_relay_session|harness_relay_session)=([A-Za-z0-9_-]{32,128})(?:;|$)/u.exec(value);
    if (match !== null) return `${match[1]}=${match[2]}`;
  }
  return undefined;
}

async function pollJson(read, predicate, stage, timeoutMs = OPERATION_TIMEOUT_MS) {
  const expiresAt = Date.now() + timeoutMs;
  while (Date.now() < expiresAt) {
    currentStage = stage;
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new SmokeFailure(stage);
}

async function smokePairRunAndRevoke({ relayOrigin, hostId, credential, allowInsecureLocalhost, relayServer }) {
  const { appRuntime, connectorModule, hostModule } = await importRuntimeModules();
  const { ApplicationRemoteRunApi, ApplicationSession, InProcessEnvironmentOwner, createFileRemoteAssetReader } = appRuntime;
  const { HostRelayConnector } = connectorModule;
  const { createHostServer } = hostModule;
  const outputDir = await mkdtemp(join(tmpdir(), "harness-relay-synthetic-smoke-"));
  const modelGate = createGate();
  let markModelStarted;
  const modelStarted = new Promise((resolve) => { markModelStarted = resolve; });
  let modelCalls = 0;
  let session;
  let host;
  let connector;
  let relayCookie;
  let deviceId;
  let adminCsrfToken;
  let phoneCsrfTokenForCleanup;
  let hostOrigin;
  let hostPort;
  let didRevoke = false;
  let relayRevocationConfirmed = false;
  let pairingChallengeId;
  const viewport = { width: 64, height: 48, coordinateSpace: "physical" };
  const clientName = `Synthetic Relay ${randomBytes(6).toString("hex")}`;

  try {
    currentStage = "local-host-setup";
    hostPort = await getFreeLoopbackPort();
    hostOrigin = `http://127.0.0.1:${hostPort}`;
    session = new ApplicationSession({
      config: {
        model: "glm-5.3-flash",
        computer: {
          kind: "cua",
          socketPath: `synthetic-relay-smoke-${randomUUID()}`,
          screenshotDir: join(outputDir, "captures"),
        },
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
        cleanupDeadlineMs: 1_000,
      },
      owner: new InProcessEnvironmentOwner(),
      windowDiscovery: {
        async listWindows() {
          return [{ pid: 765432, windowId: 654321, appName: "Synthetic fixture", title: "Fixture window" }];
        },
      },
      dependencies: {
        createProvider: () => fixtureProvider(modelGate, markModelStarted, () => ++modelCalls),
        createComputer: async () => fixtureComputer(viewport),
      },
    });
    const api = new ApplicationRemoteRunApi({
      session,
      capabilities: { pause: true, resume: true, abort: true, correct: true, approval: true, windowHandoff: false },
      assetReaderForRun: (_runId, handle) => createFileRemoteAssetReader(join(handle.config.outputDir, "assets")),
    });
    host = createHostServer({
      api,
      allowedOrigins: [hostOrigin, relayOrigin],
      bridgeOrigin: relayOrigin,
      pairingUrlForToken: (token) => `${relayOrigin}/pair?token=${encodeURIComponent(token)}`,
      registerPairingToken: (registration) => {
        if (connector === undefined) throw new Error("connector unavailable");
        return connector.registerPairingToken(registration);
      },
      unregisterPairingToken: (pairingId) => connector?.unregisterPairingToken(pairingId),
      revokeDeviceSession: (revokedDeviceId) => connector?.revokeDeviceSession(revokedDeviceId),
      port: hostPort,
    });
    await host.listen();
    connector = new HostRelayConnector({
      relayUrl: relayOrigin,
      hostId,
      credential,
      allowInsecureLocalhost,
      handlers: host.relayHandler,
    });
    await connector.start();
    if (!connector.isConnected) throw new SmokeFailure("relay-connector-connect");

    currentStage = "local-admin-bootstrap";
    const localSessionResponse = await fetchResponse(`${hostOrigin}/api/local/session`, {
      headers: makeHeaders({ origin: hostOrigin }),
    });
    const localSession = await readJson(localSessionResponse, 200);
    if (typeof localSession.csrfToken !== "string" || localSession.csrfToken.length < 16) {
      throw new SmokeFailure(currentStage, localSessionResponse.status);
    }
    adminCsrfToken = localSession.csrfToken;

    currentStage = "pairing-challenge";
    const challengeResponse = await fetchResponse(`${hostOrigin}/api/local/pairing`, {
      method: "POST",
      headers: makeHeaders({ origin: hostOrigin, csrfToken: adminCsrfToken }),
    });
    const challenge = await readJson(challengeResponse, 200);
    if (typeof challenge.challengeId !== "string" || typeof challenge.pairingUrl !== "string" || typeof challenge.expiresAt !== "string") {
      throw new SmokeFailure(currentStage, challengeResponse.status);
    }
    pairingChallengeId = challenge.challengeId;
    let pairingUrl;
    try { pairingUrl = new URL(challenge.pairingUrl); } catch { throw new SmokeFailure(currentStage); }
    if (pairingUrl.origin !== relayOrigin || pairingUrl.pathname !== "/pair") throw new SmokeFailure(currentStage);
    const pairingToken = pairingUrl.searchParams.get("token");
    if (pairingToken === null || !/^[A-Za-z0-9_-]{32,128}$/u.test(pairingToken)) throw new SmokeFailure(currentStage);

    currentStage = "public-pair-request";
    const pairResponse = await fetchResponse(`${relayOrigin}/api/pair/requests`, {
      method: "POST",
      headers: makeHeaders({ origin: relayOrigin, json: true }),
      body: JSON.stringify({ token: pairingToken, clientName }),
    });
    const pair = await readJson(pairResponse, 202);
    if (typeof pair.requestId !== "string" || pair.status !== "pending_local_confirmation") {
      throw new SmokeFailure(currentStage, pairResponse.status);
    }
    const publicPairRequestId = pair.requestId;

    currentStage = "local-pair-approval";
    const localPairing = await pollJson(async () => {
      const response = await fetchResponse(`${hostOrigin}/api/local/pairing`, {
        headers: makeHeaders({ origin: hostOrigin }),
      });
      return readJson(response, 200);
    }, (value) => Array.isArray(value.requests) && value.requests.some((request) =>
      request?.clientName === clientName && request?.status === "pending"), currentStage);
    const localRequest = localPairing.requests.find((request) =>
      request?.clientName === clientName && request?.status === "pending");
    if (typeof localRequest?.requestId !== "string") throw new SmokeFailure(currentStage);
    const approvalResponse = await fetchResponse(`${hostOrigin}/api/local/pairing/requests/${encodeURIComponent(localRequest.requestId)}/confirm`, {
      method: "POST",
      headers: makeHeaders({ origin: hostOrigin, csrfToken: adminCsrfToken, json: true }),
      body: JSON.stringify({ approved: true, label: clientName }),
    });
    const approval = await readJson(approvalResponse, 200);
    if (approval.status !== "approved" || typeof approval.deviceId !== "string") {
      throw new SmokeFailure(currentStage, approvalResponse.status);
    }
    deviceId = approval.deviceId;

    currentStage = "public-pair-status";
    const publicPairStatus = await pollJson(async () => {
      const response = await fetchResponse(`${relayOrigin}/api/pair/requests/${encodeURIComponent(publicPairRequestId)}`, {
        headers: makeHeaders({ origin: relayOrigin }),
      });
      return readJson(response, 200);
    }, (value) => value.status === "approved", currentStage);
    if (publicPairStatus.status !== "approved") throw new SmokeFailure(currentStage);

    currentStage = "paired-session";
    const establishResponse = await fetchResponse(`${relayOrigin}/api/pair/requests/${encodeURIComponent(publicPairRequestId)}/session`, {
      method: "POST",
      headers: makeHeaders({ origin: relayOrigin, json: true }),
      body: "{}",
    });
    await readJson(establishResponse, 200);
    relayCookie = extractRelayCookie(establishResponse);
    if (relayCookie === undefined) throw new SmokeFailure(currentStage, establishResponse.status);
    const phoneSessionResponse = await fetchResponse(`${relayOrigin}/api/session`, {
      headers: makeHeaders({ origin: relayOrigin, cookie: relayCookie }),
    });
    const phoneSession = await readJson(phoneSessionResponse, 200);
    if (phoneSession.deviceId !== deviceId || typeof phoneSession.csrfToken !== "string" || phoneSession.csrfToken.length < 16) {
      throw new SmokeFailure(currentStage, phoneSessionResponse.status);
    }
    const phoneCsrfToken = phoneSession.csrfToken;
    phoneCsrfTokenForCleanup = phoneCsrfToken;

    currentStage = "window-selection";
    const windowResponse = await fetchResponse(`${relayOrigin}/api/windows`, {
      headers: makeHeaders({ origin: relayOrigin, cookie: relayCookie }),
    });
    const windowChoices = await readJson(windowResponse, 200);
    if (!Array.isArray(windowChoices.candidates) || windowChoices.candidates.length !== 1 ||
        typeof windowChoices.candidates[0]?.token !== "string" ||
        JSON.stringify(windowChoices).match(/"(?:pid|hwnd|windowId)"\s*:/iu) !== null) {
      throw new SmokeFailure(currentStage, windowResponse.status);
    }

    currentStage = "fixture-run-start";
    const startResponse = await fetchResponse(`${relayOrigin}/api/runs`, {
      method: "POST",
      headers: makeHeaders({ origin: relayOrigin, cookie: relayCookie, csrfToken: phoneCsrfToken, json: true }),
      body: JSON.stringify({
        commandId: randomUUID(),
        goal: "Complete the synthetic fixture without external actions.",
        targetToken: windowChoices.candidates[0].token,
      }),
    });
    const start = await readJson(startResponse, 202);
    if (typeof start.runId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(start.runId)) {
      throw new SmokeFailure(currentStage, startResponse.status);
    }
    const runId = start.runId;

    currentStage = "fixture-model-start";
    await waitWithTimeout(modelStarted, 10_000, currentStage);
    const running = await getRunSnapshot(relayOrigin, runId, relayCookie);
    if (running.status !== "running") throw new SmokeFailure(currentStage);
    currentStage = "fixture-pause-request";
    const pauseReceipt = await sendRunCommand({
      relayOrigin, runId, cookie: relayCookie, csrfToken: phoneCsrfToken,
      type: "pause", expectedSequence: running.sequence,
    });
    modelGate.release();
    currentStage = "fixture-pause-apply";
    await waitCommandApplied(relayOrigin, runId, pauseReceipt.commandId, relayCookie);
    currentStage = "fixture-pause-observed";
    const paused = await pollJson(
      () => getRunSnapshot(relayOrigin, runId, relayCookie),
      (value) => value.status === "paused",
      currentStage,
    );
    currentStage = "fixture-correction-apply";
    const correctionReceipt = await sendRunCommand({
      relayOrigin, runId, cookie: relayCookie, csrfToken: phoneCsrfToken,
      type: "correct", expectedSequence: paused.sequence,
      text: "Continue only the synthetic fixture and do not perform external actions.",
    });
    await waitCommandApplied(relayOrigin, runId, correctionReceipt.commandId, relayCookie);
    const corrected = await getRunSnapshot(relayOrigin, runId, relayCookie);
    if (corrected.status !== "paused") throw new SmokeFailure(currentStage);
    currentStage = "fixture-resume-apply";
    const resumeReceipt = await sendRunCommand({
      relayOrigin, runId, cookie: relayCookie, csrfToken: phoneCsrfToken,
      type: "resume", expectedSequence: corrected.sequence,
    });
    await waitCommandApplied(relayOrigin, runId, resumeReceipt.commandId, relayCookie);

    currentStage = "fixture-result";
    const completed = await pollJson(
      () => getRunSnapshot(relayOrigin, runId, relayCookie),
      (value) => value.status === "finished",
      currentStage,
    );
    if (completed.reply !== FIXTURE_REPLY || modelCalls < 2 || !completed.latestAssetId) {
      throw new SmokeFailure(currentStage);
    }
    const listResponse = await fetchResponse(`${relayOrigin}/api/runs`, {
      headers: makeHeaders({ origin: relayOrigin, cookie: relayCookie }),
    });
    const list = await readJson(listResponse, 200);
    if (!Array.isArray(list.runs) || !list.runs.some((run) => run.runId === runId && run.reply === FIXTURE_REPLY)) {
      throw new SmokeFailure(currentStage, listResponse.status);
    }
    const assetResponse = await fetchResponse(`${relayOrigin}/api/runs/${encodeURIComponent(runId)}/assets/${encodeURIComponent(completed.latestAssetId)}`, {
      headers: makeHeaders({ origin: relayOrigin, cookie: relayCookie }),
    });
    await expectStatus(assetResponse, 200);
    if (!assetResponse.headers.get("content-type")?.toLowerCase().includes("image/png")) {
      await assetResponse.body?.cancel().catch(() => undefined);
      throw new SmokeFailure(currentStage, assetResponse.status);
    }
    const assetBytes = await readBoundedBytes(assetResponse, MAX_ASSET_RESPONSE_BYTES);
    if (assetBytes.byteLength === 0) throw new SmokeFailure(currentStage, assetResponse.status);

    currentStage = "test-device-revocation";
    const revokeResponse = await fetchResponse(`${hostOrigin}/api/local/devices/${encodeURIComponent(deviceId)}`, {
      method: "DELETE",
      headers: makeHeaders({ origin: hostOrigin, csrfToken: adminCsrfToken }),
    });
    await expectStatus(revokeResponse, 204);
    didRevoke = true;
    await pollJson(async () => {
      const response = await fetchResponse(`${relayOrigin}/api/runs`, {
        headers: makeHeaders({ origin: relayOrigin, cookie: relayCookie }),
      });
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 401) relayRevocationConfirmed = true;
      return { status: response.status };
    }, (value) => value.status === 401, currentStage);

    process.stdout.write("[relay-synthetic-smoke] passed: local pairing approval, public session/API, selected-window fixture Run, pause/correction/resume, result and asset read, and test-device revocation.\n");
    if (relayServer !== undefined) process.stdout.write("[relay-synthetic-smoke] offline self-test only; no public server, real model, or physical desktop was used.\n");
  } finally {
    modelGate.release();
    if (hostOrigin !== undefined && adminCsrfToken !== undefined && deviceId === undefined) {
      try {
        const response = await fetch(`${hostOrigin}/api/local/devices`, {
          headers: makeHeaders({ origin: hostOrigin }),
          redirect: "manual",
          signal: AbortSignal.timeout(3_000),
        });
        const devices = response.status === 200 ? await response.json() : undefined;
        await response.body?.cancel().catch(() => undefined);
        const ownedDevice = Array.isArray(devices?.devices)
          ? devices.devices.find((entry) => entry?.label === clientName && typeof entry?.deviceId === "string")
          : undefined;
        if (ownedDevice !== undefined) deviceId = ownedDevice.deviceId;
      } catch {
        // Best-effort recovery by this invocation's unique synthetic label.
      }
    }
    if (deviceId !== undefined && !didRevoke && hostOrigin !== undefined) {
      try {
        const headers = makeHeaders({ origin: hostOrigin, csrfToken: adminCsrfToken });
        const response = await fetch(`${hostOrigin}/api/local/devices/${encodeURIComponent(deviceId)}`, {
          method: "DELETE", headers, redirect: "manual", signal: AbortSignal.timeout(3_000),
        });
        didRevoke = response.status === 204;
        await response.body?.cancel().catch(() => undefined);
      } catch {
        // Best-effort cleanup; never print request details or response bodies.
      }
    }
    if (deviceId === undefined && hostOrigin !== undefined && adminCsrfToken !== undefined) {
      try {
        const pairingResponse = await fetch(`${hostOrigin}/api/local/pairing`, {
          headers: makeHeaders({ origin: hostOrigin }),
          redirect: "manual",
          signal: AbortSignal.timeout(3_000),
        });
        const pairingState = pairingResponse.status === 200 ? await pairingResponse.json() : undefined;
        await pairingResponse.body?.cancel().catch(() => undefined);
        const pending = Array.isArray(pairingState?.requests)
          ? pairingState.requests.find((entry) => entry?.clientName === clientName && entry?.status === "pending" && typeof entry?.requestId === "string")
          : undefined;
        if (pending !== undefined) {
          const response = await fetch(`${hostOrigin}/api/local/pairing/requests/${encodeURIComponent(pending.requestId)}/confirm`, {
            method: "POST",
            headers: makeHeaders({ origin: hostOrigin, csrfToken: adminCsrfToken, json: true }),
            body: JSON.stringify({ approved: false }),
            redirect: "manual",
            signal: AbortSignal.timeout(3_000),
          });
          await response.body?.cancel().catch(() => undefined);
        }
      } catch {
        // Best-effort rejection for a phone request that was never locally approved.
      }
    }
    if (relayCookie !== undefined && phoneCsrfTokenForCleanup !== undefined && !relayRevocationConfirmed) {
      try {
        const response = await fetch(`${relayOrigin}/api/session`, {
          method: "DELETE",
          headers: makeHeaders({ origin: relayOrigin, cookie: relayCookie, csrfToken: phoneCsrfTokenForCleanup }),
          redirect: "manual",
          signal: AbortSignal.timeout(3_000),
        });
        relayRevocationConfirmed = response.status === 204 || response.status === 401;
        await response.body?.cancel().catch(() => undefined);
      } catch {
        // Best-effort Relay-side cleanup; never print request details or response bodies.
      }
    }
    if (pairingChallengeId !== undefined) connector?.unregisterPairingToken(pairingChallengeId);
    if (session?.activeRun !== undefined) {
      try { session.activeRun.controller.cancel("synthetic smoke cleanup"); } catch { /* already terminal */ }
      await session.waitForActiveRun().catch(() => undefined);
    }
    connector?.close();
    if (host !== undefined) await host.close().catch(() => undefined);
    if (session !== undefined) await session.close().catch(() => undefined);
    await rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function getRunSnapshot(relayOrigin, runId, cookie) {
  const response = await fetchResponse(`${relayOrigin}/api/runs/${encodeURIComponent(runId)}`, {
    headers: makeHeaders({ origin: relayOrigin, cookie }),
  });
  return readJson(response, 200);
}

async function sendRunCommand({ relayOrigin, runId, cookie, csrfToken, type, expectedSequence, text }) {
  const commandId = randomUUID();
  const command = {
    type,
    commandId,
    expectedSequence,
    ...(text === undefined ? {} : { text }),
  };
  const response = await fetchResponse(`${relayOrigin}/api/runs/${encodeURIComponent(runId)}/commands`, {
    method: "POST",
    headers: makeHeaders({ origin: relayOrigin, cookie, csrfToken, json: true }),
    body: JSON.stringify(command),
  });
  const body = await readJson(response, 202);
  if (body.receipt?.commandId !== commandId || body.receipt.status !== "accepted") {
    throw new SmokeFailure(currentStage, response.status);
  }
  return { commandId };
}

async function waitCommandApplied(relayOrigin, runId, commandId, cookie) {
  await pollJson(async () => {
    const response = await fetchResponse(`${relayOrigin}/api/runs/${encodeURIComponent(runId)}/commands/${encodeURIComponent(commandId)}`, {
      headers: makeHeaders({ origin: relayOrigin, cookie }),
    });
    return readJson(response, 200);
  }, (receipt) => receipt.status === "applied" || receipt.status === "rejected" || receipt.status === "outcome_unknown", currentStage);
  const response = await fetchResponse(`${relayOrigin}/api/runs/${encodeURIComponent(runId)}/commands/${encodeURIComponent(commandId)}`, {
    headers: makeHeaders({ origin: relayOrigin, cookie }),
  });
  const receipt = await readJson(response, 200);
  if (receipt.status !== "applied") throw new SmokeFailure(currentStage, response.status);
}

async function runPublicSmoke(relayUrl, configPath) {
  currentStage = "configuration";
  const relayOrigin = relayOriginFromInput(relayUrl);
  const { hostId, credential } = await readPrivateHostCredential(configPath, relayOrigin);
  currentStage = "relay-health";
  const health = await fetchResponse(`${relayOrigin}/healthz`, { headers: { Accept: "application/json" } });
  await expectStatus(health, 200);
  if (health.body !== null) await health.body.cancel().catch(() => undefined);
  process.stdout.write("[relay-synthetic-smoke] HTTPS Relay health check passed.\n");
  await smokePairRunAndRevoke({ relayOrigin, hostId, credential, allowInsecureLocalhost: false });
}

async function runOfflineSelfTest() {
  currentStage = "self-test-setup";
  const { createRelayServer } = await import("../apps/relay/dist/server.js").catch(() => {
    throw new SmokeFailure("build-check");
  });
  const relayPort = await getFreeLoopbackPort();
  const relayOrigin = `http://127.0.0.1:${relayPort}`;
  const hostId = `synthetic_${randomBytes(9).toString("hex")}`;
  const credential = randomBytes(32).toString("base64url");
  const relay = createRelayServer({
    publicOrigin: relayOrigin,
    listenHost: "127.0.0.1",
    listenPort: relayPort,
    hostCredentials: new Map([[hostId, credential]]),
    requestTimeoutMs: 10_000,
  });
  try {
    await relay.listen();
    const health = await fetchResponse(`${relayOrigin}/healthz`, { headers: { Accept: "application/json" } });
    await expectStatus(health, 200);
    if (health.body !== null) await health.body.cancel().catch(() => undefined);
    await smokePairRunAndRevoke({
      relayOrigin,
      hostId,
      credential,
      allowInsecureLocalhost: true,
      relayServer: relay,
    });
  } finally {
    await relay.close().catch(() => undefined);
  }
}

async function main() {
  let args;
  try {
    args = parseArguments(process.argv.slice(2));
  } catch {
    process.stderr.write("[relay-synthetic-smoke] invalid arguments; use --help.\n");
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  try {
    if (args.selfTest) await runOfflineSelfTest();
    else await runPublicSmoke(args.relayUrl, args.configPath);
  } catch (error) {
    if (error instanceof SmokeFailure) {
      process.stderr.write(`[relay-synthetic-smoke] failed during ${error.stage}${error.statusCode === undefined ? "" : ` (HTTP ${error.statusCode})`}${error.safeCode === undefined ? "" : ` [${error.safeCode}]`}; details suppressed.\n`);
    } else {
      process.stderr.write(`[relay-synthetic-smoke] failed during ${currentStage}; details suppressed.\n`);
    }
    process.exitCode = 1;
  }
}

await main();
