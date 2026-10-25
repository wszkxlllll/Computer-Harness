import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Computer, ComputerSession, ModelInput, ProviderAdapter } from "@computer-harness/runtime";
import { MAX_WINDOW_PREVIEW_BYTES, type ComputerSessionId, type RunAssistantPreferencesSnapshot, type SurfaceId, type Viewport } from "@computer-harness/protocol";
import {
  ApplicationRemoteRunApi,
  ApplicationSession,
  createFileRemoteAssetReader,
  type ApplicationSessionConfig,
  type RemotePendingRequest,
  type RemoteRunEvent,
  type RemoteRunSnapshot,
  type RemoteSubscription,
} from "@computer-harness/app-runtime";
import { InProcessEnvironmentOwner } from "@computer-harness/app-runtime";
import { HostRelayConnector } from "@computer-harness/relay-connector";
import type { RelayBridgeRequest } from "@computer-harness/relay-connector/protocol";
import { createRelayServer } from "../../relay/src/server.js";
import * as webApi from "../../web/src/api.js";
import { createHostServer } from "./server.js";

const viewport: Viewport = { width: 16, height: 12, coordinateSpace: "physical" };
const surfaceRef = { surfaceId: "relay-roundtrip-desktop" as SurfaceId, generation: 1, kind: "desktop" as const };
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngDimensions(data: Uint8Array): { width: number; height: number } {
  const bytes = Buffer.from(data);
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("the screenshot fixture is not a PNG with an IHDR chunk");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1) throw new Error("the screenshot PNG has invalid dimensions");
  return { width, height };
}

function assertOnePixelPng(data: Uint8Array): void {
  expect(pngDimensions(data)).toEqual({ width: 1, height: 1 });
}

interface DiagnosticRunScreenshot {
  readonly fileName: string;
  readonly data: Buffer;
  readonly byteLength: number;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
}

interface DiagnosticRunScreenshotPair {
  readonly sourceDirectory: string;
  readonly initial: DiagnosticRunScreenshot;
  readonly updated: DiagnosticRunScreenshot;
  readonly inlineCandidatePreviews: {
    readonly first: DiagnosticRunScreenshot;
    readonly second: DiagnosticRunScreenshot;
  };
}

function screenshotMetadata(asset: DiagnosticRunScreenshot): Omit<DiagnosticRunScreenshot, "data"> {
  return {
    fileName: asset.fileName,
    byteLength: asset.byteLength,
    sha256: asset.sha256,
    width: asset.width,
    height: asset.height,
  };
}

async function readDiagnosticRunScreenshotPair(directoryInput: string | undefined): Promise<DiagnosticRunScreenshotPair | undefined> {
  if (directoryInput === undefined) return undefined;
  if (!/^[\x20-\x7e]+$/u.test(directoryInput)) throw new Error("the opt-in screenshot source path must be ASCII");

  const diagnosticsRoot = await realpath(resolve(process.cwd(), "runs/diagnostics"));
  const sourceDirectory = await realpath(resolve(directoryInput));
  const fromDiagnosticsRoot = relative(diagnosticsRoot, sourceDirectory);
  if (fromDiagnosticsRoot === "" || fromDiagnosticsRoot === ".." || fromDiagnosticsRoot.startsWith(`..${sep}`) || isAbsolute(fromDiagnosticsRoot)) {
    throw new Error("the opt-in screenshot source directory must stay below this repository's runs/diagnostics root");
  }

  const entries = await readdir(sourceDirectory, { withFileTypes: true });
  const candidates = await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".png"))
    .map(async (entry) => {
      const path = join(sourceDirectory, entry.name);
      const metadata = await stat(path);
      return { path, fileName: entry.name, modifiedAt: metadata.mtimeMs, byteLength: metadata.size };
    }));
  candidates.sort((left, right) => left.modifiedAt - right.modifiedAt || left.fileName.localeCompare(right.fileName));
  if (candidates.length < 2) throw new Error("the opt-in screenshot directory must contain at least two real PNG assets");

  const readAsset = async (candidate: typeof candidates[number]): Promise<DiagnosticRunScreenshot> => {
    if ((await stat(candidate.path)).size > 8 * 1024 * 1024) {
      throw new Error("the opt-in screenshot exceeds the existing Host asset limit");
    }
    const data = await readFile(candidate.path);
    if (data.byteLength > 8 * 1024 * 1024) throw new Error("the opt-in screenshot exceeds the existing Host asset limit");
    const dimensions = pngDimensions(data);
    return {
      fileName: candidate.fileName,
      data,
      byteLength: data.byteLength,
      sha256: createHash("sha256").update(data).digest("hex"),
      ...dimensions,
    };
  };
  const [initial, updated] = await Promise.all([readAsset(candidates[0]!), readAsset(candidates.at(-1)!)]);
  if (initial.sha256 === updated.sha256) throw new Error("the opt-in screenshot pair must contain two different PNG images");
  if (initial.width !== updated.width || initial.height !== updated.height) {
    throw new Error("the opt-in screenshot pair must have matching viewports");
  }

  if (initial.byteLength > MAX_WINDOW_PREVIEW_BYTES || updated.byteLength > MAX_WINDOW_PREVIEW_BYTES) {
    throw new Error("the opt-in real screenshot pair must fit the bounded inline preview contract");
  }

  return {
    sourceDirectory: fromDiagnosticsRoot.split(sep).join("/"),
    initial,
    updated,
    inlineCandidatePreviews: { first: initial, second: updated },
  };
}

async function webBundleFingerprint(): Promise<Record<string, unknown>> {
  const html = await readFile(join(webRoot, "index.html"));
  const referencedAssets = [...html.toString("utf8").matchAll(/(?:src|href)=["'](\/assets\/[^"']+\.(?:js|css))["']/gu)]
    .map((match) => match[1]!)
    .sort();
  if (referencedAssets.length === 0) throw new Error("the built Web entry did not reference hashed assets");
  const assets = await Promise.all(referencedAssets.map(async (path) => {
    const bytes = await readFile(join(webRoot, path.slice(1)));
    return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
  }));
  return {
    indexHtmlSha256: createHash("sha256").update(html).digest("hex"),
    assets,
  };
}

function containsPrivateWindowIdentityKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsPrivateWindowIdentityKey);
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(([key, child]) =>
    /^(?:pid|windowid|socketpath)$/iu.test(key) || containsPrivateWindowIdentityKey(child));
}

describe("window identity serialization assertions", () => {
  it("checks nested key names without treating opaque token values as private fields", () => {
    expect(containsPrivateWindowIdentityKey({ candidates: [{ token: "fixture-pID-windowId-socketPath-opaque" }] })).toBe(false);
    expect(containsPrivateWindowIdentityKey({ candidates: [{ identity: { target: { pid: 451 } } }] })).toBe(true);
    expect(containsPrivateWindowIdentityKey({ candidates: [{ identity: { target: { windowId: 894 } } }] })).toBe(true);
    expect(containsPrivateWindowIdentityKey({ candidates: [{ identity: { target: { socketPath: "/private/socket" } } }] })).toBe(true);
  });
});

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

function fixtureComputer(
  onClose?: () => Promise<void>,
  screenshots?: { readonly initial: Uint8Array; readonly updated: Uint8Array; readonly viewport: Viewport },
): Computer {
  const computerViewport = screenshots?.viewport ?? viewport;
  const computerSession: ComputerSession = {
    id: "relay-roundtrip-session" as ComputerSessionId,
    backend: "fixture",
    viewport: computerViewport,
    capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false },
    openedAt: new Date().toISOString(),
  };
  let observations = 0;
  return {
    async open() { return computerSession; },
    async observe() {
      observations += 1;
      const screenshotData = observations === 1
        ? screenshots?.initial ?? ONE_PIXEL_PNG
        : screenshots?.updated ?? screenshots?.initial ?? ONE_PIXEL_PNG;
      return {
        capturedAt: new Date().toISOString(),
        viewport: computerViewport,
        surfaceRef,
        screenshot: { mediaType: "image/png" as const, data: new Uint8Array(screenshotData) },
      };
    },
    async execute() { return { status: "completed" as const }; },
    async listWindows() { return { options: [], truncated: false, omittedCount: 0 }; },
    async close() { await onClose?.(); },
  } as unknown as Computer;
}

function fixtureProvider(options: { askFirst?: boolean; summary?: string; onModelInput?: (input: ModelInput) => void } = {}): ProviderAdapter {
  let requestCount = 0;
  return {
    id: "relay-roundtrip-provider",
    async generate(input: ModelInput) {
      options.onModelInput?.(input);
      requestCount += 1;
      if (options.askFirst === true && requestCount === 1) {
        return { type: "user_input_required", question: "查看截图更新后继续。" };
      }
      return { type: "finish", summary: options.summary ?? "The fixture task completed through the paired Web client." };
    },
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

async function listenWithPortCollisionRetry<T>(options: {
  readonly getPort: () => Promise<number>;
  readonly create: (port: number) => T;
  readonly listen: (fixture: T) => Promise<void>;
  readonly close: (fixture: T) => Promise<void>;
}): Promise<{ readonly fixture: T; readonly port: number }> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const port = await options.getPort();
    const fixture = options.create(port);
    try {
      await options.listen(fixture);
      return { fixture, port };
    } catch (error) {
      try {
        await options.close(fixture);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "failed to close a test server after listen failure", { cause: error });
      }
      if (!isAddressInUse(error) || attempt === 3) throw error;
    }
  }
  throw new Error("test server port allocation exhausted without a listen result");
}

function isAddressInUse(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { readonly code?: unknown }).code === "EADDRINUSE";
}

async function listenOnTcpPort(server: ReturnType<typeof createServer>, port: number): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

async function closeTcpServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error === undefined ? resolveClose() : rejectClose(error));
  });
}

describe("relay roundtrip test port binding", () => {
  it("retries real Relay and Host bindings on EADDRINUSE without restarting an already-listening Relay", async () => {
    const occupiedServer = createServer();
    await listenOnTcpPort(occupiedServer, 0);
    const occupiedAddress = occupiedServer.address();
    if (occupiedAddress === null || typeof occupiedAddress === "string") throw new Error("occupied fixture did not expose its TCP port");
    const occupiedPort = occupiedAddress.port;
    const relayFixtures: Array<{ readonly port: number; readonly relay: ReturnType<typeof createRelayServer> }> = [];
    const hostFixtures: Array<{ readonly port: number; readonly host: ReturnType<typeof createHostServer> }> = [];
    let successfulRelay: ReturnType<typeof createRelayServer> | undefined;
    let successfulHost: ReturnType<typeof createHostServer> | undefined;
    let relayPortRequest = 0;
    let hostPortRequest = 0;
    const getRelayPort = async () => relayPortRequest++ === 0 ? occupiedPort : await getFreePort();
    const getHostPort = async () => hostPortRequest++ === 0 ? occupiedPort : await getFreePort();
    try {
      const relayBinding = await listenWithPortCollisionRetry({
        getPort: getRelayPort,
        create: (port) => {
          const origin = `http://127.0.0.1:${String(port)}`;
          const relay = createRelayServer({
            publicOrigin: origin,
            listenHost: "127.0.0.1",
            listenPort: port,
            hostCredentials: new Map([["host_fixture", "fixture-credential"]]),
          });
          relayFixtures.push({ port, relay });
          return { port, origin, relay };
        },
        listen: async (fixture) => {
          await fixture.relay.listen();
          const address = fixture.relay.server.address();
          if (address === null || typeof address === "string" || address.port !== fixture.port) {
            throw new Error("Relay did not bind its configured fixture port");
          }
        },
        close: async (fixture) => await fixture.relay.close(),
      });
      successfulRelay = relayBinding.fixture.relay;
      expect(relayFixtures).toHaveLength(2);
      expect(relayFixtures[0]?.relay.server.listening).toBe(false);
      expect(relayBinding.port).not.toBe(occupiedPort);

      const relayOrigin = relayBinding.fixture.origin;
      const hostBinding = await listenWithPortCollisionRetry({
        getPort: getHostPort,
        create: (port) => {
          const origin = `http://localhost:${String(port)}`;
          const host = createHostServer({
            api: {} as unknown as Parameters<typeof createHostServer>[0]["api"],
            allowedOrigins: [origin, relayOrigin],
            bridgeOrigin: relayOrigin,
            port,
          });
          hostFixtures.push({ port, host });
          return { port, origin, host };
        },
        listen: async (fixture) => {
          const address = new URL(await fixture.host.listen());
          if (Number(address.port) !== fixture.port) throw new Error("Host did not bind its configured fixture port");
        },
        close: async (fixture) => await fixture.host.close(),
      });
      successfulHost = hostBinding.fixture.host;
      expect(hostFixtures).toHaveLength(2);
      expect(hostFixtures[0]?.host.server.server.listening).toBe(false);
      expect(hostBinding.port).not.toBe(occupiedPort);
      expect(relayFixtures).toHaveLength(2);
      expect(successfulRelay.server.listening).toBe(true);
      const relayHealth = await fetch(`${relayOrigin}/healthz`, { signal: AbortSignal.timeout(5_000) });
      expect(relayHealth.status).toBe(200);
      await expect(relayHealth.json()).resolves.toEqual({ status: "ok" });
      const hostileOrigin = await fetch(`${relayOrigin}/healthz`, {
        headers: { Origin: "http://127.0.0.1:1" },
        signal: AbortSignal.timeout(5_000),
      });
      expect(hostileOrigin.status).toBe(403);
      await expect(hostileOrigin.json()).resolves.toEqual({ error: "origin_check_failed" });
      expect(hostBinding.fixture.origin).toBe(`http://localhost:${String(hostBinding.port)}`);
    } finally {
      if (successfulHost !== undefined) await successfulHost.close().catch(() => undefined);
      if (successfulRelay !== undefined) await successfulRelay.close().catch(() => undefined);
      await closeTcpServer(occupiedServer);
    }
  }, 15_000);

  it("cleans up but does not retry a non-EADDRINUSE listen failure", async () => {
    const failure = new Error("fixture listen failed for a different reason");
    let portRequests = 0;
    let cleanupCalls = 0;
    await expect(listenWithPortCollisionRetry({
      getPort: async () => { portRequests += 1; return 12345; },
      create: (port) => ({ port }),
      listen: async () => { throw failure; },
      close: async () => { cleanupCalls += 1; },
    })).rejects.toBe(failure);
    expect(portRequests).toBe(1);
    expect(cleanupCalls).toBe(1);
  });
});

interface CdpEnvelope {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as CdpEnvelope;
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error !== undefined) pending.reject(new Error(message.error.message ?? "CDP request failed"));
      else pending.resolve(message.result ?? {});
    });
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("CDP connection closed"));
      }
      this.pending.clear();
    });
  }

  public static async connect(url: string): Promise<CdpConnection> {
    const socket = new WebSocket(url);
    try {
      await new Promise<void>((resolveOpen, rejectOpen) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          socket.removeEventListener("open", onOpen);
          socket.removeEventListener("error", onError);
          if (error === undefined) resolveOpen();
          else rejectOpen(error);
        };
        const onOpen = () => finish();
        const onError = () => finish(new Error("could not connect to the headless Edge DevTools endpoint"));
        const timer = setTimeout(() => finish(new Error("headless Edge DevTools connection timed out")), 5_000);
        socket.addEventListener("open", onOpen, { once: true });
        socket.addEventListener("error", onError, { once: true });
      });
    } catch (error) {
      socket.close();
      throw error;
    }
    return new CdpConnection(socket);
  }

  public call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const response = new Promise<Record<string, unknown>>((resolveResponse, rejectResponse) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectResponse(new Error(`headless Edge CDP ${method} timed out`));
      }, 5_000);
      this.pending.set(id, { resolve: resolveResponse, reject: rejectResponse, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectResponse(error instanceof Error ? error : new Error("CDP send failed"));
      }
    });
    return response;
  }

  public async evaluate<T>(expression: string): Promise<T> {
    const response = await this.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    const result = response.result as { value?: T } | undefined;
    if (response.exceptionDetails !== undefined) throw new Error("headless page evaluation failed");
    return result?.value as T;
  }

  public close(): void {
    this.socket.close();
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitForValue<T>(read: () => T | undefined | Promise<T | undefined>, description: string, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(40);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolveExit) => {
    const timeout = setTimeout(() => finish(false), timeoutMs);
    const onExit = () => finish(true);
    const finish = (exited: boolean) => {
      clearTimeout(timeout);
      child.off("exit", onExit);
      resolveExit(exited);
    };
    child.once("exit", onExit);
  });
}

async function waitForPageValue<T>(
  cdp: CdpConnection,
  expression: string,
  accept: (value: T) => boolean,
  description: string,
  timeoutMs = 8_000,
): Promise<T> {
  return waitForValue(async () => {
    try {
      const value = await cdp.evaluate<T | undefined>(expression);
      return value !== undefined && accept(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }, description, timeoutMs);
}

interface HeadlessProbeInput {
  readonly relayOrigin: string;
  readonly runId: string;
  readonly initialAssetId: string;
  readonly deviceId: string;
  readonly webBundleFingerprint: Record<string, unknown>;
  readonly session: ApplicationSession;
  readonly api: ApplicationRemoteRunApi;
  readonly relayCookie: string;
  readonly releasePendingCleanup: () => void;
  readonly observedWindowTargetLists: Array<Awaited<ReturnType<ApplicationRemoteRunApi["listWindowTargets"]>>>;
  readonly observedWindowPreviewProofs: Array<{
    readonly candidateToken: string;
    readonly previewToken: string;
    readonly capturedTarget: { readonly pid: number; readonly windowId: number };
    readonly imageSha256: string;
  }>;
  readonly hostStartTargets: Array<Parameters<ApplicationRemoteRunApi["startRun"]>[3]>;
  readonly sourceRunScreenshots?: {
    readonly sourceDirectory: string;
    readonly initial: Omit<DiagnosticRunScreenshot, "data">;
    readonly updated: Omit<DiagnosticRunScreenshot, "data">;
    readonly inlineCandidatePreviews: {
      readonly first: Omit<DiagnosticRunScreenshot, "data">;
      readonly second: Omit<DiagnosticRunScreenshot, "data">;
    };
  };
  readonly expectTransientThumbnailFailure: boolean;
}

async function runHeadlessMobileRelayProbe(input: HeadlessProbeInput): Promise<Record<string, unknown>> {
  const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  const tempRoot = await realpath(tmpdir());
  if (!/^[\x20-\x7e]+$/u.test(tempRoot)) throw new Error("headless Edge temporary root must be ASCII");
  if (!await access(edgePath).then(() => true, () => false)) throw new Error("headless Edge executable was not found");
  const profileDirectory = await mkdtemp(join(tempRoot, "harness-mobile-edge-"));
  const resolvedProfile = resolve(profileDirectory);
  if (!/^[\x20-\x7e]+$/u.test(resolvedProfile) || dirname(resolvedProfile) !== tempRoot || !resolvedProfile.includes("harness-mobile-edge-")) {
    throw new Error("headless Edge profile path must be an isolated ASCII temporary directory");
  }

  let child: ChildProcess | undefined;
  let cdp: CdpConnection | undefined;
  let browserCdp: CdpConnection | undefined;
  let remotePort: number | undefined;
  let profileRemoved = false;
  let browserExitConfirmed = false;
  let result: Record<string, unknown> = {};
  let inlineCandidatePreviewEvidence: Record<string, unknown> | undefined;
  let expectedInlineStartTarget: { readonly targetToken: string; readonly previewToken: string } | undefined;
  let edgeStdout = "";
  let edgeStderr = "";

  try {
    child = spawn(edgePath, [
      "--headless=new",
      "--disable-gpu",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-extensions",
      "--no-first-run",
      "--no-default-browser-check",
      "--edge-skip-compat-layer-relaunch",
      "--remote-allow-origins=*",
      "--remote-debugging-port=0",
      `--user-data-dir=${resolvedProfile}`,
      "--window-size=390,844",
      input.relayOrigin,
    ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { edgeStdout = `${edgeStdout}${chunk}`.slice(-2_000); });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { edgeStderr = `${edgeStderr}${chunk}`.slice(-2_000); });
    console.info("[headless-mobile-relay] spawned isolated Edge process");

    const activePortPath = join(resolvedProfile, "DevToolsActivePort");
    const activePortText = await waitForValue(async () => {
      if (child?.exitCode !== null && child?.exitCode !== undefined && child.exitCode !== 0) {
        throw new Error(`headless Edge exited early (${child.exitCode}); stderr=${edgeStderr.trim() || "(empty)"}; stdout=${edgeStdout.trim() || "(empty)"}`);
      }
      try { return await readFile(activePortPath, "utf8"); } catch { return undefined; }
    }, "headless Edge DevTools port", 15_000);
    const [portLine, browserPath] = activePortText.trim().split(/\r?\n/u);
    remotePort = Number(portLine);
    if (!Number.isInteger(remotePort) || remotePort < 1 || browserPath === undefined) throw new Error("headless Edge wrote an invalid DevTools port file");
    const browserWsUrl = `ws://127.0.0.1:${remotePort}${browserPath}`;
    browserCdp = await CdpConnection.connect(browserWsUrl);
    const targetsResponse = await fetch(`http://127.0.0.1:${remotePort}/json/list`, { signal: AbortSignal.timeout(5_000) });
    if (!targetsResponse.ok) throw new Error(`headless Edge target list failed with HTTP ${targetsResponse.status}`);
    const targets = await targetsResponse.json() as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
    const pageTarget = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl !== undefined);
    if (pageTarget?.webSocketDebuggerUrl === undefined) throw new Error("headless Edge did not expose its mobile page target");

    cdp = await CdpConnection.connect(pageTarget.webSocketDebuggerUrl);
    console.info("[headless-mobile-relay] connected to Edge DevTools");
    await cdp.call("Page.enable");
    await cdp.call("Runtime.enable");
    await cdp.call("Network.enable");
    await cdp.call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await cdp.call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    const separator = input.relayCookie.indexOf("=");
    const cookieName = input.relayCookie.slice(0, separator);
    const cookieValue = input.relayCookie.slice(separator + 1);
    if (separator < 1 || cookieName !== "harness_relay_session" || cookieValue.length === 0) {
      throw new Error("the local fixture did not produce the expected Relay session cookie");
    }
    await cdp.call("Network.setCookie", {
      name: cookieName,
      value: cookieValue,
      url: input.relayOrigin,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    });
    const cookieState = await cdp.call("Network.getCookies", { urls: [input.relayOrigin] });
    const browserCookies = cookieState.cookies as Array<{ name?: string; httpOnly?: boolean }> | undefined;
    const sessionCookieInBrowser = browserCookies?.some((cookie) => cookie.name === cookieName && cookie.httpOnly === true) ?? false;
    if (!sessionCookieInBrowser) throw new Error("headless Edge did not retain the isolated Relay session cookie");
    console.info("[headless-mobile-relay] isolated Relay cookie is stored in Edge");

    await cdp.call("Page.navigate", { url: `${input.relayOrigin}/run/${encodeURIComponent(input.runId)}` });
    let initialScreenshot: { width: number; height: number; src: string; viewportWidth: number; scrollWidth: number };
    let viewer: { width: number; height: number; src: string } | undefined;
    let thumbnailFailureRetry: Record<string, unknown> | undefined;
    if (input.expectTransientThumbnailFailure) {
      const failureState = await waitForPageValue<{ warning: boolean; retryAvailable: boolean }>(
        cdp,
        `(() => ({ warning: !!document.querySelector('.screenshot-panel .notice-warning'), retryAvailable: Array.from(document.querySelectorAll('.screenshot-panel button')).some(button => button.textContent?.trim() === '重试查看截图') }))()`,
        (value) => value.warning && value.retryAvailable,
        "the failed real screenshot thumbnail and its retry action",
      );
      if (!failureState.warning || !failureState.retryAvailable) throw new Error("the injected first asset-read failure did not reach the screenshot retry UI");
      await cdp.evaluate(`Array.from(document.querySelectorAll('.screenshot-panel button')).find(button => button.textContent?.trim() === '重试查看截图')?.click()`);
      viewer = await waitForPageValue<{ width: number; height: number; src: string }>(
        cdp,
        `(() => { const image = document.querySelector('.screenshot-viewer img'); return image && image.naturalWidth > 0 ? { width: image.naturalWidth, height: image.naturalHeight, src: image.src } : undefined; })()`,
        (value) => value.width > 0,
        "the real PNG to decode after the user retries the failed thumbnail",
      );
      initialScreenshot = {
        ...viewer,
        viewportWidth: await cdp.evaluate<number>("innerWidth"),
        scrollWidth: await cdp.evaluate<number>("document.documentElement.scrollWidth"),
      };
      thumbnailFailureRetry = {
        firstThumbnailLoadFailed: true,
        retryActionAvailable: true,
        retryLoadedSameAsset: new URL(viewer.src).pathname.includes(`/assets/${input.initialAssetId}`) && new URL(viewer.src).search === "",
      };
      if (thumbnailFailureRetry.retryLoadedSameAsset !== true) throw new Error("the screenshot retry did not reload the same asset URL");
    } else {
      initialScreenshot = await waitForPageValue<{ width: number; height: number; src: string; viewportWidth: number; scrollWidth: number }>(
        cdp,
        `(() => { const image = document.querySelector('.screenshot-panel img'); return image && image.naturalWidth > 0 ? { width: image.naturalWidth, height: image.naturalHeight, src: image.src, viewportWidth: innerWidth, scrollWidth: document.documentElement.scrollWidth } : undefined; })()`,
        (value) => value.width > 0,
        "the authenticated screenshot thumbnail to decode",
      );
    }
    const imageUrl = new URL(initialScreenshot.src);
    if (imageUrl.origin !== input.relayOrigin || !imageUrl.pathname.includes(`/assets/${input.initialAssetId}`)) {
      throw new Error("the mobile screenshot thumbnail did not use this Relay's same-origin run asset URL");
    }
    if (initialScreenshot.viewportWidth !== 390 || initialScreenshot.scrollWidth > initialScreenshot.viewportWidth) {
      throw new Error("the mobile viewport does not fit the screenshot panel without horizontal overflow");
    }
    console.info("[headless-mobile-relay] authenticated same-origin PNG decoded in the mobile viewport");
    const fetchImage = await cdp.evaluate<{ status: number; width: number; contentType: string; sha256: string }>(
      `fetch(${JSON.stringify(imageUrl.pathname)}, { cache: "no-store", credentials: "same-origin" }).then(async response => { const bytes = await response.arrayBuffer(); const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)); return { status: response.status, width: bytes.byteLength, contentType: response.headers.get("content-type") || "", sha256: Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("") }; })`,
    );
    if (fetchImage.status !== 200 || fetchImage.width < 24 || !fetchImage.contentType.includes("image/png")) {
      throw new Error("headless same-origin fetch did not receive the authenticated PNG asset");
    }
    if (input.sourceRunScreenshots !== undefined &&
        (fetchImage.width !== input.sourceRunScreenshots.initial.byteLength ||
         fetchImage.sha256 !== input.sourceRunScreenshots.initial.sha256 ||
         initialScreenshot.width !== input.sourceRunScreenshots.initial.width ||
         initialScreenshot.height !== input.sourceRunScreenshots.initial.height)) {
      throw new Error("the retried screenshot bytes or natural dimensions did not match the selected real Run PNG");
    }

    if (viewer === undefined) {
      await cdp.evaluate(`document.querySelector('.screenshot-open-button')?.click()`);
      viewer = await waitForPageValue<{ width: number; height: number; src: string }>(
        cdp,
        `(() => { const image = document.querySelector('.screenshot-viewer img'); return image && image.naturalWidth > 0 ? { width: image.naturalWidth, height: image.naturalHeight, src: image.src } : undefined; })()`,
        (value) => value.width > 0,
        "the full-screen screenshot viewer to decode",
      );
    }
    if (!viewer.src.includes(input.initialAssetId)) throw new Error("the full-screen viewer did not pin the opened screenshot asset");
    const beforeReply = input.api.getRun(input.deviceId, input.runId);
    if (beforeReply?.pendingRequest?.kind !== "user_input") throw new Error("the fixture Run was not waiting for its controlled user reply");
    await input.api.submitCommand(input.deviceId, input.runId, {
      commandId: "headless-mobile-screenshot-update",
      expectedSequence: beforeReply.sequence,
      type: "respond",
      requestId: beforeReply.pendingRequest.requestId,
      text: "Continue after the screenshot update.",
    });
    const terminal = await waitForValue(() => {
      const snapshot = input.api.getRun(input.deviceId, input.runId);
      return snapshot?.status === "finished" && snapshot.ownerState === "pending_cleanup" && snapshot.latestAssetId !== input.initialAssetId
        ? snapshot
        : undefined;
    }, "terminal state with pending cleanup and a newer screenshot", 10_000);
    const updateNotice = await waitForPageValue<string>(
      cdp,
      `document.querySelector('.viewer-new-image')?.textContent?.trim()`,
      (value) => value.includes("有更新截图"),
      "the pinned viewer's newer-screenshot notice",
    );
    if (!(await cdp.evaluate<boolean>(`document.querySelector('.screenshot-viewer img')?.src.includes(${JSON.stringify(input.initialAssetId)}) ?? false`))) {
      throw new Error("the full-screen viewer replaced its pinned image before close");
    }
    await cdp.evaluate(`document.querySelector('.screenshot-viewer button')?.click()`);
    await waitForPageValue<boolean>(cdp, `!document.querySelector('.screenshot-viewer')`, Boolean, "the screenshot viewer to close");
    const refreshedThumbnail = await waitForPageValue<{ src: string; width: number; height: number }>(
      cdp,
      `(() => { const image = document.querySelector('.screenshot-panel img'); return image && image.naturalWidth > 0 ? { src: image.src, width: image.naturalWidth, height: image.naturalHeight } : undefined; })()`,
      (image) => image.src.includes(terminal.latestAssetId!),
      "the new screenshot thumbnail after closing the viewer",
    );
    const updatedImageUrl = new URL(refreshedThumbnail.src);
    const updatedFetch = await cdp.evaluate<{ status: number; byteLength: number; contentType: string; sha256: string }>(
      `fetch(${JSON.stringify(updatedImageUrl.pathname)}, { cache: "no-store", credentials: "same-origin" }).then(async response => { const bytes = await response.arrayBuffer(); const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)); return { status: response.status, byteLength: bytes.byteLength, contentType: response.headers.get("content-type") || "", sha256: Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("") }; })`,
    );
    if (updatedFetch.status !== 200 || !updatedFetch.contentType.includes("image/png")) {
      throw new Error("the newer screenshot was not transferred as an authenticated PNG through Relay");
    }
    if (input.sourceRunScreenshots !== undefined &&
        (updatedFetch.byteLength !== input.sourceRunScreenshots.updated.byteLength ||
         updatedFetch.sha256 !== input.sourceRunScreenshots.updated.sha256 ||
         refreshedThumbnail.width !== input.sourceRunScreenshots.updated.width || refreshedThumbnail.height !== input.sourceRunScreenshots.updated.height)) {
      throw new Error("the newer Run screenshot did not preserve its source PNG bytes and natural dimensions");
    }

    await cdp.call("Page.navigate", { url: `${input.relayOrigin}/` });
    await waitForPageValue<boolean>(cdp, `Boolean(document.querySelector('#goal-input'))`, Boolean, "the mobile Home screen");
    const pendingOwnerUi = await waitForPageValue<{ warning: boolean; startDisabled: boolean }>(
      cdp,
      `(() => ({ warning: document.body.innerText.includes('电脑收尾尚未确认'), startDisabled: !!document.querySelector('button[type="submit"]')?.disabled }))()`,
      (value) => value.warning && value.startDisabled,
      "Home to block a new task while owner cleanup is pending",
    );
    input.releasePendingCleanup();
    console.info("[headless-mobile-relay] released the fixture Computer cleanup gate");
    try {
      await input.session.waitUntilIdleAfterTerminal();
    } catch (error) {
      const history = input.session.history.find((run) => run.runId === input.runId);
      throw new Error(`fixture cleanup boundary did not release (activeRun=${input.session.activeRun?.runId ?? "none"}, historyOwner=${history?.ownerState ?? "none"}): ${error instanceof Error ? error.message : String(error)}`);
    }
    const released = await waitForValue(() => {
      const snapshot = input.api.getRun(input.deviceId, input.runId);
      return snapshot?.ownerState === "released" ? snapshot : undefined;
    }, "the fixture owner to be released", 8_000);
    await waitForPageValue<boolean>(
      cdp,
      `(() => { const button = Array.from(document.querySelectorAll('button')).find(candidate => candidate.textContent?.trim() === '刷新列表'); return !!button && !button.disabled; })()`,
      Boolean,
      "the Home task-list refresh button to be ready",
    );
    await cdp.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent?.trim() === '刷新列表')?.click()`);
    try {
      await waitForPageValue<boolean>(
        cdp,
      `(() => { const goal = document.querySelector('#goal-input'); return !!goal && !goal.disabled && !document.body.innerText.includes('电脑收尾尚未确认'); })()`,
        Boolean,
      "Home to unlock task entry after confirmed owner release",
      );
    } catch (error) {
      const pageState = await cdp.evaluate<{ body: string; startDisabled: boolean; activeRun: string | null; refreshLabel: string | null }>(
        `({ body: document.body.innerText.slice(0, 1200), startDisabled: !!document.querySelector('button[type="submit"]')?.disabled, activeRun: document.querySelector('#active-run-title')?.textContent?.trim() || null, refreshLabel: Array.from(document.querySelectorAll('button')).find(button => button.textContent?.trim().includes('刷新'))?.textContent?.trim() || null })`,
      );
      const runSummaries = await cdp.evaluate<unknown>(
        `fetch('/api/runs', { cache: 'no-store' }).then(response => response.json())`,
      );
      throw new Error(`Home stayed blocked after owner release; page=${JSON.stringify(pageState)}; relayRuns=${JSON.stringify(runSummaries)}; ${error instanceof Error ? error.message : String(error)}`);
    }
    const secondGoal = "Headless next task after cleanup";
    await cdp.evaluate(`(() => { const details = document.querySelector('.target-mode-disclosure'); if (details instanceof HTMLDetailsElement) details.open = true; const desktop = document.querySelector('input[name="target-mode"][value="desktop"]'); desktop?.click(); const goal = document.querySelector('#goal-input'); if (!(goal instanceof HTMLTextAreaElement)) throw new Error('goal input is unavailable'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set; setter?.call(goal, ${JSON.stringify(secondGoal)}); goal.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(secondGoal)}, inputType: 'insertText' })); })()`);
    await waitForPageValue<boolean>(
      cdp,
      `document.querySelector('#goal-input')?.value === ${JSON.stringify(secondGoal)} && document.querySelector('input[name="target-mode"][value="desktop"]')?.checked === true && document.querySelector('button[type="submit"]')?.disabled === false`,
      Boolean,
      "the second fixture task form to be ready",
    );
    if (input.sourceRunScreenshots !== undefined) {
      const inlineSources = input.sourceRunScreenshots.inlineCandidatePreviews;
      const targetListCountBefore = input.observedWindowTargetLists.length;
      await cdp.evaluate("document.querySelector('input[name=target-mode][value=window]')?.click()");
      await waitForPageValue<number>(
        cdp,
        "document.querySelectorAll('.window-target-option').length",
        (count) => count === 2,
        "the two repeated-label candidates on the mobile Home screen",
      );
      if (input.observedWindowTargetLists.length <= targetListCountBefore) {
        throw new Error("the mobile Home screen did not fetch a fresh candidate token set");
      }
      const candidateList = input.observedWindowTargetLists.at(-1);
      const firstCandidate = candidateList?.candidates[0];
      const secondCandidate = candidateList?.candidates[1];
      if (firstCandidate?.previewRequired !== true || secondCandidate?.previewRequired !== true) {
        throw new Error("both same-label mobile candidates must require their own preview");
      }

      await cdp.evaluate("document.querySelectorAll('.window-target-option')[1]?.querySelector('button')?.click()");
      const failedPreviewState = await waitForPageValue<{
        readonly message: string;
        readonly confirmationVisible: boolean;
        readonly startDisabled: boolean;
      }>(
        cdp,
        "(() => { const row = document.querySelectorAll('.window-target-option')[1]; const warning = row?.querySelector('.notice-warning'); return warning ? { message: warning.textContent?.trim() || '', confirmationVisible: !!row.querySelector('.button-primary'), startDisabled: document.querySelector('button[type=submit]')?.disabled === true } : undefined; })()",
        (state) => state.message.includes("这张实时截图无法显示"),
        "a failed inline PNG to block candidate confirmation",
      );
      if (failedPreviewState.confirmationVisible || !failedPreviewState.startDisabled) {
        throw new Error("a failed candidate image left an unsafe confirm or start action available");
      }

      await cdp.evaluate("document.querySelectorAll('.window-target-option')[1]?.querySelector('button')?.click()");
      const retryLoaded = await waitForPageValue<{ readonly width: number; readonly height: number }>(
        cdp,
        "(() => { const image = document.querySelectorAll('.window-target-option')[1]?.querySelector('img'); return image && image.naturalWidth > 0 ? { width: image.naturalWidth, height: image.naturalHeight } : undefined; })()",
        (image) => image.width > 0,
        "the second candidate PNG to decode after retry",
      );
      if (retryLoaded.width !== inlineSources.second.width || retryLoaded.height !== inlineSources.second.height) {
        throw new Error("the retried second candidate did not decode the expected source PNG dimensions");
      }

      await cdp.evaluate("document.querySelectorAll('.window-target-option')[0]?.querySelector('button')?.click()");
      await waitForPageValue<{ readonly width: number; readonly height: number }>(
        cdp,
        "(() => { const image = document.querySelectorAll('.window-target-option')[0]?.querySelector('img'); return image && image.naturalWidth > 0 ? { width: image.naturalWidth, height: image.naturalHeight } : undefined; })()",
        (image) => image.width > 0,
        "the first candidate PNG to decode in its own row",
      );
      const renderedCandidateImages = await waitForPageValue<Array<{
        readonly index: number;
        readonly width: number;
        readonly height: number;
        readonly byteLength: number;
        readonly sha256: string;
        readonly pngDataUri: boolean;
      } | null>>(
        cdp,
        "Promise.all(Array.from(document.querySelectorAll('.window-target-option')).map(async (row, index) => { const image = row.querySelector('img'); if (!image || image.naturalWidth === 0) return null; const base64 = image.src.slice(image.src.indexOf(',') + 1); const binary = atob(base64); const bytes = Uint8Array.from(binary, character => character.charCodeAt(0)); const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)); return { index, width: image.naturalWidth, height: image.naturalHeight, byteLength: bytes.byteLength, sha256: Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join(''), pngDataUri: image.src.startsWith('data:image/png;base64,') }; }))",
        (images) => images.length === 2 && images.every((image) => image !== null),
        "both candidate inline PNG data URIs to decode and hash",
      );
      const firstRenderedImage = renderedCandidateImages[0];
      const secondRenderedImage = renderedCandidateImages[1];
      if (firstRenderedImage === null || secondRenderedImage === null ||
          firstRenderedImage === undefined || secondRenderedImage === undefined ||
          firstRenderedImage.index !== 0 || firstRenderedImage.sha256 !== inlineSources.first.sha256 ||
          firstRenderedImage.width !== inlineSources.first.width || firstRenderedImage.height !== inlineSources.first.height ||
          firstRenderedImage.byteLength !== inlineSources.first.byteLength || !firstRenderedImage.pngDataUri ||
          secondRenderedImage.index !== 1 || secondRenderedImage.sha256 !== inlineSources.second.sha256 ||
          secondRenderedImage.width !== inlineSources.second.width || secondRenderedImage.height !== inlineSources.second.height ||
          secondRenderedImage.byteLength !== inlineSources.second.byteLength || !secondRenderedImage.pngDataUri) {
        throw new Error("the mobile candidate rows did not render their distinct expected PNG bytes");
      }

      const failedImageSha256 = createHash("sha256").update(Buffer.concat([PNG_SIGNATURE, Buffer.from("not-a-png")])).digest("hex");
      const firstCandidateProof = [...input.observedWindowPreviewProofs].reverse().find((proof) =>
        proof.candidateToken === firstCandidate.token &&
        proof.capturedTarget.pid === 451 && proof.capturedTarget.windowId === 894 &&
        proof.imageSha256 === inlineSources.first.sha256);
      const failedSecondCandidateProof = [...input.observedWindowPreviewProofs].reverse().find((proof) =>
        proof.candidateToken === secondCandidate.token &&
        proof.capturedTarget.pid === 452 && proof.capturedTarget.windowId === 895 &&
        proof.imageSha256 === failedImageSha256);
      const secondCandidateProof = [...input.observedWindowPreviewProofs].reverse().find((proof) =>
        proof.candidateToken === secondCandidate.token &&
        proof.capturedTarget.pid === 452 && proof.capturedTarget.windowId === 895 &&
        proof.imageSha256 === inlineSources.second.sha256);
      if (firstCandidateProof === undefined || failedSecondCandidateProof === undefined || secondCandidateProof === undefined) {
        throw new Error("the candidate tokens, preview proof tokens, and exact fixture capture identities did not remain paired");
      }

      await cdp.evaluate("document.querySelectorAll('.window-target-option')[1]?.querySelector('.button-primary')?.click()");
      await waitForPageValue<boolean>(
        cdp,
        "document.querySelector('button[type=submit]')?.disabled === false",
        Boolean,
        "the confirmed second candidate to enable task start",
      );
      expectedInlineStartTarget = { targetToken: secondCandidate.token, previewToken: secondCandidateProof.previewToken };
      inlineCandidatePreviewEvidence = {
        failedImageBlockedConfirmationAndStart: true,
        retryReplacedFailedImage: failedSecondCandidateProof.candidateToken === secondCandidateProof.candidateToken &&
          failedSecondCandidateProof.previewToken !== secondCandidateProof.previewToken,
        firstCandidate: { row: 1, byteLength: firstRenderedImage.byteLength, width: firstRenderedImage.width, height: firstRenderedImage.height, sha256: firstRenderedImage.sha256 },
        secondCandidate: { row: 2, byteLength: secondRenderedImage.byteLength, width: secondRenderedImage.width, height: secondRenderedImage.height, sha256: secondRenderedImage.sha256 },
        bothImagesUsedPngDataUris: firstRenderedImage.pngDataUri && secondRenderedImage.pngDataUri,
        startSelectionBoundToSecondCandidateProof: false,
      };
    }
    await cdp.evaluate(`document.querySelector('button[type="submit"]')?.click()`);
    const secondRunPath = await waitForPageValue<string>(
      cdp,
      `location.pathname`,
      (path) => path.startsWith("/run/") && !path.endsWith(encodeURIComponent(input.runId)),
      "the UI to navigate to a second Run",
      10_000,
    );
    const secondRun = await waitForValue(() => input.api.listRuns(input.deviceId).find((run) => run.goal === secondGoal), "the second Run summary", 8_000);
    if (expectedInlineStartTarget !== undefined) {
      const submittedTarget = input.hostStartTargets.at(-1);
      if (submittedTarget?.mode !== "window" ||
          submittedTarget.targetToken !== expectedInlineStartTarget.targetToken ||
          submittedTarget.previewToken !== expectedInlineStartTarget.previewToken) {
        throw new Error("the mobile form did not submit the selected second candidate with its own preview proof token");
      }
      inlineCandidatePreviewEvidence = { ...inlineCandidatePreviewEvidence, startSelectionBoundToSecondCandidateProof: true };
    }
    await waitForPageValue<boolean>(
      cdp,
      `document.querySelector('#run-goal')?.textContent?.trim() === ${JSON.stringify(secondGoal)}`,
      Boolean,
      "the second Run goal to replace the prior Run view",
    );
    await waitForValue(() => {
      const snapshot = input.api.getRun(input.deviceId, secondRun.runId);
      return snapshot?.status === "finished" && snapshot.reply === "The next fixture task completed." ? snapshot : undefined;
    }, "the second Run to finish with its own result", 8_000);
    await cdp.evaluate(`document.querySelector('.refresh-run')?.click()`);
    await waitForPageValue<boolean>(
      cdp,
      `document.body.innerText.includes('The next fixture task completed.')`,
      Boolean,
      "the second Run's own terminal reply to refresh into its workspace",
    );
    const secondPageState = await cdp.evaluate<{ goal: string; bodyHasPriorGoal: boolean; bodyHasNextReply: boolean }>(
      `({ goal: document.querySelector('#run-goal')?.textContent?.trim() || '', bodyHasPriorGoal: document.body.innerText.includes('Update fixture screenshot after the question'), bodyHasNextReply: document.body.innerText.includes('The next fixture task completed.') })`,
    );
    if (secondPageState.goal !== secondGoal || secondPageState.bodyHasPriorGoal || !secondPageState.bodyHasNextReply) {
      throw new Error(`the second Run view did not isolate its own content: ${JSON.stringify(secondPageState)}`);
    }

    result = {
      browser: "Microsoft Edge headless",
      webBundleFingerprint: input.webBundleFingerprint,
      viewport: { width: 390, height: 844, mobile: true },
      relayOrigin: input.relayOrigin,
      relaySessionCookieStoredInBrowser: sessionCookieInBrowser,
      relayCookieAuthenticatedAssetFetchStatus: fetchImage.status,
      screenshotSameOrigin: true,
      screenshotHttpStatus: fetchImage.status,
      screenshotMediaType: fetchImage.contentType,
      screenshotTransferBytes: fetchImage.width,
      screenshotTransferSha256: fetchImage.sha256,
      screenshotDecodedNaturalSize: { width: initialScreenshot.width, height: initialScreenshot.height },
      fullScreenDecodedNaturalSize: { width: viewer.width, height: viewer.height },
      fullScreenPinnedAsset: input.initialAssetId,
      ...(thumbnailFailureRetry === undefined ? {} : {
        thumbnailFailureRetry: {
          ...thumbnailFailureRetry,
          injectedLocalAssetReaderFailure: input.expectTransientThumbnailFailure,
        },
      }),
      newerScreenshotNotice: updateNotice,
      thumbnailAfterClose: refreshedThumbnail.src,
      newerScreenshotDecodedNaturalSize: { width: refreshedThumbnail.width, height: refreshedThumbnail.height },
      newerScreenshotHttpStatus: updatedFetch.status,
      newerScreenshotTransferBytes: updatedFetch.byteLength,
      newerScreenshotTransferSha256: updatedFetch.sha256,
      ...(input.sourceRunScreenshots === undefined ? {} : { sourceRunScreenshots: input.sourceRunScreenshots }),
      ...(inlineCandidatePreviewEvidence === undefined ? {} : { inlineCandidatePreview: inlineCandidatePreviewEvidence }),
      validationScope: input.sourceRunScreenshots === undefined
        ? "The opt-in headless browser used the built-in one-pixel local fixture PNG."
        : "Real Run PNG bytes were copied from an allowlisted runs/diagnostics directory into a local fake Host/Relay/Provider/Computer fixture. Two distinct PNGs within the candidate-preview size limit also traversed the authenticated inline preview route into the built Web UI. No production service, real desktop, external provider API, or TTS was used.",
      actualProductionServiceUsed: false,
      externalProviderApiCalled: false,
      realDesktopAccessed: false,
      inlineCandidatePreviewValidated: inlineCandidatePreviewEvidence !== undefined,
      mobileTtsValidated: false,
      ownerPendingCleanupBlockedStart: pendingOwnerUi.startDisabled,
      ownerReleasedBeforeNextRun: released.ownerState === "released",
      nextRunId: secondRun.runId,
      nextRunPath: secondRunPath,
      nextRunOwnGoalAndReply: secondPageState,
    };
  } finally {
    if (browserCdp !== undefined) {
      await Promise.race([browserCdp.call("Browser.close").catch(() => undefined), delay(1_000)]);
      browserCdp.close();
    }
    if (cdp !== undefined) {
      cdp.close();
    }
    let browserEndpointClosed = remotePort === undefined;
    if (remotePort !== undefined) {
      try {
        await waitForValue(async () => {
          try {
            const response = await fetch(`http://127.0.0.1:${remotePort}/json/version`, { signal: AbortSignal.timeout(250) });
            return response.ok ? undefined : true;
          } catch {
            return true;
          }
        }, "headless Edge to close its DevTools endpoint", 5_000);
        browserEndpointClosed = true;
      } catch {
        browserEndpointClosed = false;
      }
    }
    if (child !== undefined && child.exitCode === null && child.pid !== undefined) {
      let exited = await waitForChildExit(child, 3_000);
      if (!exited) {
        spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 5_000 });
        exited = await waitForChildExit(child, 3_000);
      }
      if (!exited) {
        child.kill();
        exited = await waitForChildExit(child, 2_000);
      }
      browserExitConfirmed = exited && browserEndpointClosed;
    } else if (child !== undefined) {
      browserExitConfirmed = browserEndpointClosed;
    } else {
      browserExitConfirmed = browserEndpointClosed;
    }
    const parentPath = await realpath(dirname(resolvedProfile));
    if (parentPath !== tempRoot || dirname(resolvedProfile) !== parentPath || !basename(resolvedProfile).startsWith("harness-mobile-edge-")) {
      throw new Error("refusing to remove an unvalidated headless Edge profile path");
    }
    if (!browserExitConfirmed) throw new Error("headless Edge process exit was not confirmed; temporary profile retained");
    await rm(resolvedProfile, { recursive: true, force: true });
    profileRemoved = true;
  }

  if (!profileRemoved) throw new Error("headless Edge temporary profile cleanup was not confirmed");
  return { ...result, browserExitConfirmed, isolatedProfileRemoved: profileRemoved };
}

describe("built Web API through Host HTTP and the real Relay WSS bridge", () => {
  it("pairs locally, approves on the Host, runs a real ApplicationSession, and reads its result/assets through Relay", async () => {
    const hostId = "host_roundtrip";
    const credential = randomBytes(32).toString("base64url");
    let relayOrigin = "";
    let localOrigin = "";
    let hostWireOrigin = "";
    const headlessProbeEnabled = process.env.HARNESS_MOBILE_HEADLESS_RELAY_PROBE === "1";
    const screenshotDirectoryInput = process.env.HARNESS_MOBILE_HEADLESS_RELAY_ASSET_DIR;
    if (screenshotDirectoryInput !== undefined && !headlessProbeEnabled) {
      throw new Error("real Run screenshots may only be supplied to the explicit headless Relay probe");
    }
    const sourceRunScreenshots = headlessProbeEnabled ? await readDiagnosticRunScreenshotPair(screenshotDirectoryInput) : undefined;
    const outputDir = await mkdtemp(join(tmpdir(), "harness-mobile-roundtrip-"));
    if (headlessProbeEnabled && process.platform !== "win32") throw new Error("the opt-in headless mobile probe currently requires the installed Windows Edge binary");
    let resolveProbeCleanup!: () => void;
    const probeCleanupGate = new Promise<void>((resolveCleanup) => { resolveProbeCleanup = resolveCleanup; });
    let probeCleanupReleased = false;
    const releaseProbeCleanup = () => {
      if (probeCleanupReleased) return;
      probeCleanupReleased = true;
      resolveProbeCleanup();
    };
    let providerCount = 0;
    let computerCount = 0;
    let switchContractInputs: ModelInput[] | undefined;
    const createdComputerConfigs: ApplicationSessionConfig["computer"][] = [];
    let diagnosticAssetReadFailureInjected = false;
    let diagnosticLargeAssetReadSuccesses = 0;
    let diagnosticInlinePreviewFailureInjected = false;
    let diagnosticScreenshotRunId: string | undefined;
    let relay: ReturnType<typeof createRelayServer> | undefined;
    let session: ApplicationSession | undefined;
    let host: ReturnType<typeof createHostServer> | undefined;
    let connector: HostRelayConnector | undefined;
    let relayCookie: string | undefined;
  const bridgeRequests: RelayBridgeRequest[] = [];
  const hostStartPreferences: Array<RunAssistantPreferencesSnapshot | undefined> = [];
  const hostStartDeviceIds: string[] = [];
  const originalFetch = globalThis.fetch;
    const windowPreviewCaptures: Array<{ pid: number; windowId: number }> = [];
    let windowPreviewRequestCache: RequestCache | undefined;
    let windowPreviewResponseCacheControl: string | null = null;
    const observedWindowTargetLists: Array<Awaited<ReturnType<ApplicationRemoteRunApi["listWindowTargets"]>>> = [];
    const observedWindowPreviewProofs: Array<{
      candidateToken: string;
      previewToken: string;
      capturedTarget: { pid: number; windowId: number };
      imageSha256: string;
    }> = [];
    const hostStartTargets: Array<Parameters<ApplicationRemoteRunApi["startRun"]>[3]> = [];

    try {
      const relayBinding = await listenWithPortCollisionRetry({
        getPort: getFreePort,
        create: (port) => {
          const origin = `http://127.0.0.1:${String(port)}`;
          return {
            port,
            origin,
            relay: createRelayServer({
              publicOrigin: origin,
              listenHost: "127.0.0.1",
              listenPort: port,
              webRoot,
              hostCredentials: new Map([[hostId, credential]]),
              requestTimeoutMs: 5_000,
            }),
          };
        },
        listen: async (fixture) => {
          await fixture.relay.listen();
          const address = fixture.relay.server.address();
          if (address === null || typeof address === "string" || address.port !== fixture.port) {
            throw new Error("Relay did not bind the configured fixture endpoint");
          }
        },
        close: async (fixture) => await fixture.relay.close(),
      });
      relay = relayBinding.fixture.relay;
      relayOrigin = relayBinding.fixture.origin;
      session = new ApplicationSession({
        config: {
          ...sessionConfig(outputDir),
          computer: { kind: "cua", socketPath: "fixture-cua.sock", screenshotDir: join(outputDir, "driver-screenshots") },
          // A Web target which omits or disables switching must override this
          // enabled Host default all the way to the real Provider tool catalog.
          windowSwitch: "opened-windows-v1",
          ...(headlessProbeEnabled ? { cleanupDeadlineMs: 30_000 } : {}),
        },
        owner: new InProcessEnvironmentOwner(),
        windowDiscovery: {
          listWindows: async () => [
            { pid: 451, windowId: 894, appName: "Fixture app", title: "Fixture window" },
            { pid: 452, windowId: 895, appName: "Fixture app", title: "Fixture window" },
          ],
          captureWindowPreview: async (target) => {
            windowPreviewCaptures.push({ pid: target.pid, windowId: target.windowId });
            const candidate = target.pid === 451 && target.windowId === 894
              ? { pid: 451, windowId: 894, appName: "Fixture app", title: "Fixture window" }
              : target.pid === 452 && target.windowId === 895
                ? { pid: 452, windowId: 895, appName: "Fixture app", title: "Fixture window" }
                : undefined;
            if (candidate === undefined) throw new Error("preview was not bound to a listed candidate");
            const sourcePreview = sourceRunScreenshots === undefined
              ? undefined
              : target.pid === 451
                ? sourceRunScreenshots.inlineCandidatePreviews.first
                : sourceRunScreenshots.inlineCandidatePreviews.second;
            const injectImageDecodeFailure = headlessProbeEnabled && sourcePreview !== undefined &&
              target.pid === 452 && !diagnosticInlinePreviewFailureInjected;
            if (injectImageDecodeFailure) diagnosticInlinePreviewFailureInjected = true;
            return {
              target: candidate,
              capturedAt: new Date().toISOString(),
              viewport: sourcePreview === undefined
                ? { width: 1, height: 1 }
                : { width: sourcePreview.width, height: sourcePreview.height },
              mediaType: "image/png" as const,
              data: injectImageDecodeFailure ? Buffer.concat([PNG_SIGNATURE, Buffer.from("not-a-png")]) : sourcePreview?.data ?? ONE_PIXEL_PNG,
            };
          },
        },
        dependencies: {
          createProvider: () => {
            providerCount += 1;
            if (switchContractInputs !== undefined) {
              const inputs = switchContractInputs;
              return fixtureProvider({ askFirst: true, onModelInput: (input) => inputs.push(input) });
            }
            if (headlessProbeEnabled) console.info(`[headless-mobile-relay] creating fixture Provider ${providerCount}`);
            const askFirst = headlessProbeEnabled && providerCount === 2;
            if (headlessProbeEnabled) console.info(`[headless-mobile-relay] provider will ask first: ${askFirst}`);
            return fixtureProvider({
              askFirst,
              summary: providerCount === 3 ? "The next fixture task completed." : undefined,
            });
          },
          createComputer: async ({ config }) => {
            computerCount += 1;
            createdComputerConfigs.push(config);
            const isScreenshotUpdateRun = headlessProbeEnabled && computerCount === 2;
            const realScreenshots = isScreenshotUpdateRun && sourceRunScreenshots !== undefined
              ? {
                initial: sourceRunScreenshots.initial.data,
                updated: sourceRunScreenshots.updated.data,
                viewport: {
                  width: sourceRunScreenshots.initial.width,
                  height: sourceRunScreenshots.initial.height,
                  coordinateSpace: "physical" as const,
                },
              }
              : undefined;
            return fixtureComputer(isScreenshotUpdateRun ? () => probeCleanupGate : undefined, realScreenshots);
          },
        },
      });
      const api = new ApplicationRemoteRunApi({
        session,
        capabilities: { pause: true, resume: true, abort: true, correct: true, approval: true, windowHandoff: true },
        assetReaderForRun: (runId, handle) => {
          const reader = createFileRemoteAssetReader(join(handle.config.outputDir, "assets"));
          if (sourceRunScreenshots === undefined) return reader;
          return {
            async read(ref, signal) {
              const data = await reader.read(ref, signal);
              if (runId === diagnosticScreenshotRunId) {
                if (!diagnosticAssetReadFailureInjected) {
                  diagnosticAssetReadFailureInjected = true;
                  throw new Error("opt-in one-time local screenshot transport failure to exercise retry");
                }
                diagnosticLargeAssetReadSuccesses += 1;
              }
              return data;
            },
          };
        },
      });
      const originalListWindowTargets = api.listWindowTargets.bind(api);
      api.listWindowTargets = async (deviceId) => {
        const choices = await originalListWindowTargets(deviceId);
        observedWindowTargetLists.push(choices);
        return choices;
      };
      const originalPreviewWindowTarget = api.previewWindowTarget.bind(api);
      api.previewWindowTarget = async (deviceId, candidateToken, signal) => {
        const captureIndex = windowPreviewCaptures.length;
        const preview = await originalPreviewWindowTarget(deviceId, candidateToken, signal);
        const capturedTarget = windowPreviewCaptures[captureIndex];
        if (capturedTarget === undefined) throw new Error("candidate preview proof did not retain its capture identity");
        observedWindowPreviewProofs.push({
          candidateToken,
          previewToken: preview.previewToken,
          capturedTarget,
          imageSha256: createHash("sha256").update(Buffer.from(preview.dataBase64, "base64")).digest("hex"),
        });
        return preview;
      };
      const originalStartRun = api.startRun.bind(api);
      const hostRunNoticeContentOptIns: boolean[] = [];
      api.startRun = (deviceId, commandId, goal, target, assistantPreferences, runNoticeContentEnabled) => {
        hostStartTargets.push(target);
        hostStartDeviceIds.push(deviceId);
        hostStartPreferences.push(assistantPreferences);
        if (runNoticeContentEnabled === true) hostRunNoticeContentOptIns.push(true);
        return originalStartRun(deviceId, commandId, goal, target, assistantPreferences, runNoticeContentEnabled);
      };
      const hostBinding = await listenWithPortCollisionRetry({
        getPort: getFreePort,
        create: (port) => {
          const origin = `http://localhost:${String(port)}`;
          const wireOrigin = `http://127.0.0.1:${String(port)}`;
          return {
            port,
            origin,
            wireOrigin,
            host: createHostServer({
              api,
              allowedOrigins: [origin, relayOrigin],
              bridgeOrigin: relayOrigin,
              pairingUrlForToken: (token) => relayOrigin + "/pair?token=" + encodeURIComponent(token),
              registerPairingToken: (registration) => {
                if (connector === undefined) throw new Error("Relay connector has not been started.");
                return connector.registerPairingToken(registration);
              },
              unregisterPairingToken: (pairingId) => connector?.unregisterPairingToken(pairingId),
              revokeDeviceSession: (deviceId) => connector?.revokeDeviceSession(deviceId),
              staticRoot: webRoot,
              port,
            }),
          };
        },
        listen: async (fixture) => {
          const boundAddress = await fixture.host.listen();
          const address = new URL(boundAddress);
          if (Number(address.port) !== fixture.port) throw new Error("Host did not bind the configured fixture endpoint");
        },
        close: async (fixture) => await fixture.host.close(),
      });
      host = hostBinding.fixture.host;
      localOrigin = hostBinding.fixture.origin;
      hostWireOrigin = hostBinding.fixture.wireOrigin;
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
        if (url.pathname === "/api/windows/preview") {
          windowPreviewRequestCache = init?.cache;
          windowPreviewResponseCacheControl = response.headers.get("cache-control");
        }
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
      expect(windowChoices.candidates).toHaveLength(2);
      expect(windowChoices.candidates.every((candidate) => candidate.previewRequired === true)).toBe(true);
      expect(containsPrivateWindowIdentityKey(windowChoices)).toBe(false);
      const selectedWindow = windowChoices.candidates[0]!;
      const preview = await webApi.previewWindowTarget(selectedWindow.token);
      const expectedPreviewViewport = sourceRunScreenshots === undefined
        ? { width: 1, height: 1 }
        : { width: sourceRunScreenshots.inlineCandidatePreviews.first.width, height: sourceRunScreenshots.inlineCandidatePreviews.first.height };
      expect(preview).toMatchObject({ appName: "Fixture app", title: "Fixture window", mediaType: "image/png", viewport: expectedPreviewViewport });
      expect(JSON.stringify(preview, (key, value) => key === "dataBase64" ? undefined : value)).not.toMatch(/pid|windowId|socketPath/iu);
      expect(containsPrivateWindowIdentityKey(preview)).toBe(false);
      expect(windowPreviewCaptures).toEqual([{ pid: 451, windowId: 894 }]);
      expect(windowPreviewRequestCache).toBe("no-store");
      expect(windowPreviewResponseCacheControl).toContain("no-store");
      expect(windowPreviewCaptures).toHaveLength(1);
      expect(session.activeRun).toBeUndefined();
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
          targetToken: selectedWindow.token,
          previewToken: preview.previewToken,
        }, assistantPreferences, true);
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
        target: { mode: "window", targetToken: selectedWindow.token, previewToken: preview.previewToken },
        assistantPreferences,
        runNoticeContentEnabled: true,
      });
      expect(hostStartPreferences).toEqual([assistantPreferences]);
      expect(hostRunNoticeContentOptIns).toEqual([true]);
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

      // Transport-only seam: the API fixture below is already filtered. The
      // producer-to-API filtering contract is exercised in remote-run-api.test.
      const originalGetRun = api.getRun.bind(api);
      const originalSubscribe = api.subscribe.bind(api);
      const transportRequests = new Map<string, RemotePendingRequest>();
      for (const [scenario, action] of [
        ["visible", { operation: "select_option", kind: "select_option", groundingRef: "dom-ref", optionText: "Observed fixture variant", optionCharacterCount: 24, optionTextStatus: "visible" }],
        ["redacted", { operation: "select_option", kind: "select_option", groundingRef: "dom-ref", optionCharacterCount: 24, optionTextStatus: "redacted" }],
      ] as const) {
        const requestId = `transport-${scenario}-request`;
        transportRequests.set(scenario, {
          requestId,
          kind: "approval",
          reason: "Review fixture option.",
          requiresVisualReview: false,
          preview: { actions: [action] },
        });
      }
      api.getRun = async (deviceId, runId) => {
        const scenario = runId === "transport-visible" ? "visible" : runId === "transport-redacted" ? "redacted" : undefined;
        if (scenario === undefined) return originalGetRun(deviceId, runId);
        return {
          runId,
          goal: "Transport filtered approval preview",
          status: "waiting_approval",
          sequence: 7,
          pendingRequest: transportRequests.get(scenario),
          capabilities: { pause: false, resume: false, abort: false, correct: false, approval: true, windowHandoff: false },
        } satisfies RemoteRunSnapshot;
      };
      api.subscribe = (deviceId, runId, afterSequence, listener): RemoteSubscription => {
        const scenario = runId === "transport-visible" ? "visible" : runId === "transport-redacted" ? "redacted" : undefined;
        if (scenario === undefined) return originalSubscribe(deviceId, runId, afterSequence, listener);
        const request = transportRequests.get(scenario)!;
        const event: RemoteRunEvent = {
          type: "run.event",
          runId: runId as RemoteRunEvent["runId"],
          sequence: 8,
          data: { type: "run.pending_request", request },
        };
        if (afterSequence < event.sequence) listener(event);
        return { close() {} };
      };
      try {
        for (const scenario of ["visible", "redacted"] as const) {
          const runId = `transport-${scenario}`;
          const getSnapshot = await webApi.getRun(runId);
          const getRequest = getSnapshot.pendingRequest;
          expect(getRequest?.requestId).toBe(`transport-${scenario}-request`);
          const action = getRequest?.kind === "approval" ? getRequest.preview?.actions[0] : undefined;
          const response = await globalThis.fetch(webApi.runEventsUrl(runId, 0));
          expect(response.status).toBe(200);
          const reader = response.body?.getReader();
          if (reader === undefined) throw new Error("Relay SSE response has no body");
          let eventText = "";
          try {
            while (!eventText.includes("data: {")) {
              const chunk = await Promise.race([reader.read(), new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Relay SSE event timed out")), 2_000))]);
              if (chunk.done) break;
              eventText += new TextDecoder().decode(chunk.value);
            }
          } finally {
            await reader.cancel();
          }
          const dataLine = eventText.split("\n").find((line) => line.startsWith("data: "));
          if (dataLine === undefined) throw new Error("Relay SSE did not contain a run event");
          const streamed = JSON.parse(dataLine.slice("data: ".length)) as { type: string; data: { request: { requestId: string; preview: { actions: unknown[] } } } };
          expect(streamed.type).toBe("run.event");
          expect(streamed.data.request.requestId).toBe(getRequest?.requestId);
          expect(streamed.data.request.preview.actions[0]).toEqual(action);
          expect(eventText).not.toContain("PRIVATE_SYNTHETIC_SECRET");
          if (scenario === "redacted") expect(action).not.toHaveProperty("optionText");
        }
      } finally {
        api.getRun = originalGetRun;
        api.subscribe = originalSubscribe;
      }

      const assetResponse = await globalThis.fetch(webApi.runAssetUrl(accepted.runId, completed.latestAssetId!));
      expect(assetResponse.status).toBe(200);
      expect(assetResponse.headers.get("content-type")).toContain("image/png");
      const assetBytes = Buffer.from(await assetResponse.arrayBuffer());
      assertOnePixelPng(assetBytes);

      if (headlessProbeEnabled) {
        if (relayCookie === undefined) throw new Error("the opt-in headless mobile probe requires the isolated Relay fixture session");
        console.info("[headless-mobile-relay] finished the baseline Relay fixture task");
        const secondChoices = await webApi.listWindowTargets();
        const secondTarget = secondChoices.candidates[0];
        if (secondTarget === undefined) throw new Error("the headless probe fixture had no second window candidate");
        const secondPreview = await webApi.previewWindowTarget(secondTarget.token);
        const headlessRun = await webApi.createRun("Update fixture screenshot after the question", "headless-mobile-screenshot-update", {
          mode: "window",
          targetToken: secondTarget.token,
          previewToken: secondPreview.previewToken,
        });
        diagnosticScreenshotRunId = headlessRun.runId;
        console.info("[headless-mobile-relay] started the controlled screenshot-update Run");
        let waiting: ReturnType<typeof api.getRun> | undefined;
        try {
          waiting = await waitForValue(() => {
            const snapshot = api.getRun(hostStartDeviceIds.at(-1)!, headlessRun.runId);
            return snapshot?.status === "waiting_user" ? snapshot : undefined;
          }, "the second fixture Run to wait for user input");
        } catch (error) {
          const last = api.getRun(hostStartDeviceIds.at(-1)!, headlessRun.runId);
          throw new Error(`headless fixture Run did not wait for user input (status=${last?.status ?? "missing"}, outcome=${last?.outcome ?? "missing"}, error=${last?.error ?? "none"}): ${error instanceof Error ? error.message : String(error)}`);
        }
        console.info("[headless-mobile-relay] fixture Run is waiting for the screenshot update");
        if (waiting.latestAssetId === undefined || waiting.pendingRequest?.kind !== "user_input") {
          throw new Error("the headless fixture did not expose its initial screenshot and user question");
        }
        const evidence = await runHeadlessMobileRelayProbe({
          relayOrigin,
          runId: headlessRun.runId,
          initialAssetId: waiting.latestAssetId,
          deviceId: hostStartDeviceIds.at(-1)!,
          webBundleFingerprint: await webBundleFingerprint(),
          session,
          api,
          relayCookie,
          releasePendingCleanup: releaseProbeCleanup,
          observedWindowTargetLists,
          observedWindowPreviewProofs,
          hostStartTargets,
          expectTransientThumbnailFailure: sourceRunScreenshots !== undefined,
          ...(sourceRunScreenshots === undefined ? {} : {
            sourceRunScreenshots: {
              sourceDirectory: sourceRunScreenshots.sourceDirectory,
              initial: screenshotMetadata(sourceRunScreenshots.initial),
              updated: screenshotMetadata(sourceRunScreenshots.updated),
              inlineCandidatePreviews: {
                first: screenshotMetadata(sourceRunScreenshots.inlineCandidatePreviews.first),
                second: screenshotMetadata(sourceRunScreenshots.inlineCandidatePreviews.second),
              },
            },
          }),
        });
        if (sourceRunScreenshots !== undefined && (!diagnosticAssetReadFailureInjected || diagnosticLargeAssetReadSuccesses < 1)) {
          throw new Error("the opt-in large screenshot failure/retry path was not exercised through the local asset reader");
        }
        if (sourceRunScreenshots !== undefined && (!diagnosticInlinePreviewFailureInjected || evidence.inlineCandidatePreviewValidated !== true)) {
          throw new Error("the opt-in inline candidate image failure/retry path was not exercised in headless Edge");
        }
        const reportDirectory = resolve(process.cwd(), "runs/diagnostics");
        const reportName = sourceRunScreenshots === undefined
          ? `mobile-headless-relay-${Date.now()}.json`
          : `mobile-headless-real-run-screenshot-${Date.now()}.json`;
        const reportPath = resolve(reportDirectory, reportName);
        if (!reportPath.startsWith(`${reportDirectory}${process.platform === "win32" ? "\\" : "/"}`)) {
          throw new Error("headless mobile evidence path escaped the ignored diagnostics directory");
        }
        await writeFile(reportPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
        console.info(`[headless-mobile-relay] evidence saved to ${reportPath}`);
      }

      // Reuse the authenticated Web API -> Relay WSS -> Host HTTP path and
      // real Session/Factory above. These are configuration-contract tests:
      // every Provider and Computer is a local fixture, with no desktop or
      // external model access, and no direct call to session.startRun().
      for (const [name, target, expectedWindowSwitch] of [
        ["omitted", { mode: "desktop" as const }, "off"],
        ["false", { mode: "desktop" as const, switchWindows: false }, "off"],
        ["true", { mode: "desktop" as const, switchWindows: true }, "opened-windows-v1"],
      ] as const) {
        const modelInputs: ModelInput[] = [];
        switchContractInputs = modelInputs;
        const commandId = `desktop-switch-contract-${name}`;
        const started = await webApi.createRun("Inspect the desktop configuration", commandId, target);
        const waiting = await waitForValue(async () => {
          const snapshot = await webApi.getRun(started.runId);
          return snapshot.status === "waiting_user" ? snapshot : undefined;
        }, `the ${name} desktop switch fixture to wait for input`);
        const bridged = bridgeRequests.find((request) => request.method === "POST" && request.path === "/api/runs" && request.body?.commandId === commandId);
        expect(bridged?.body?.target).toEqual(target);
        expect(hostStartTargets.at(-1)).toEqual(name === "true" ? target : { mode: "desktop" });
        expect(session.activeRun?.config).toMatchObject({ windowSwitch: expectedWindowSwitch });
        expect(createdComputerConfigs.at(-1)).toMatchObject({ kind: "cua", windowSwitch: expectedWindowSwitch });
        expect(createdComputerConfigs.at(-1)).not.toHaveProperty("windowTarget");
        expect(waiting.pendingRequest?.kind).toBe("user_input");
        if (waiting.pendingRequest?.kind !== "user_input") throw new Error("fixture must expose its input request");
        await webApi.sendCommand(started.runId, `desktop-switch-continue-${name}`, {
          type: "respond", expectedSequence: waiting.sequence,
          requestId: waiting.pendingRequest.requestId, text: "Continue the local fixture.",
        });
        await session.waitForActiveRun();
        expect(modelInputs).toHaveLength(2);
        for (const input of modelInputs) {
          const toolNames = input.tools.map((tool) => tool.name);
          for (const tool of ["list_windows", "switch_window"]) {
            if (expectedWindowSwitch === "off") expect(toolNames).not.toContain(tool);
            else expect(toolNames).toContain(tool);
          }
        }
        const finished = await webApi.getRun(started.runId);
        expect(finished).toMatchObject({ status: "finished", outcome: "succeeded", ownerState: "released" });
        switchContractInputs = undefined;
      }

      await webApi.deletePhoneSession();
      await expect(webApi.listRuns()).rejects.toMatchObject({ status: 401 });
    } finally {
      releaseProbeCleanup();
      if (session?.activeRun !== undefined) {
        try { session.activeRun.controller.cancel("headless Relay fixture cleanup"); } catch { /* the fixture Run may finish between the status read and cancel */ }
        await session.waitForActiveRun().catch(() => undefined);
      }
      globalThis.fetch = originalFetch;
      webApi.setPhoneCsrfToken(undefined);
      webApi.setLocalCsrfToken(undefined);
      connector?.close();
      if (host !== undefined) await host.close().catch(() => undefined);
      if (session !== undefined) await session.close().catch(() => undefined);
      if (relay !== undefined) await relay.close().catch(() => undefined);
      await rm(outputDir, { recursive: true, force: true });
    }
  }, 15_000);
});
