import { readFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ApplicationRemoteRunApi,
  ApplicationSession,
  createFileRemoteAssetReader,
  createWindowTargetDiscovery,
  resolveManagedBrowserProfileConfig,
  type ApplicationSessionConfig,
  type ProviderCredentials,
  type ResolvedRunConfig,
} from "@computer-harness/app-runtime";
import { HostRelayConnector } from "@computer-harness/relay-connector";
import type { RunModel } from "@computer-harness/app-runtime";
import { createHostServer } from "./server.js";
import { HostVoiceSessionService } from "./voice-session-service.js";
import { createConfiguredVoiceProvider } from "./voice-provider-config.js";

interface HostArguments {
  envFile: string;
  socket: string;
  model: "glm-5.3-flash" | "qwen3.8-flash";
  output: string;
  port: number;
  origins: string[];
}

const hostDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(hostDirectory, "../../..");

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  await loadEnvFile(args.envFile);
  const credentials = readProviderCredentials();
  const outputDir = resolve(args.output);
  const managedBrowserProfile = resolveManagedBrowserProfileConfig();
  const config = createSessionConfig(args, outputDir, managedBrowserProfile);
  const windowDiscovery = createWindowTargetDiscovery(config.computer);
  if (windowDiscovery === undefined) throw new Error("Mobile Host requires the CUA backend's read-only window discovery.");
  const dependencies = {
    credentials,
  };
  // Do not pass an in-memory EnvironmentOwner override here. Host, TUI, and
  // direct CLI Runs share the process-wide lease implementation.
  const session = new ApplicationSession({
    config,
    dependencies,
    windowDiscovery,
  });
  const capabilities = {
    pause: true,
    resume: true,
    abort: true,
    correct: true,
    approval: true,
    windowHandoff: config.windowHandoff === "confirm-v1",
  } as const;
  const voiceProvider = createConfiguredVoiceProvider();
  const voiceInput = new HostVoiceSessionService(voiceProvider === undefined ? {} : { provider: voiceProvider });
  const api = new ApplicationRemoteRunApi({
    session,
    capabilities,
    runNotices: { enabled: true, dynamicContentEnabled: false },
    managedBrowserProfile,
    assetReaderForRun: (_runId, handle) =>
      createFileRemoteAssetReader(join(handle.config.outputDir, "assets")),
  });

  const relayUrl = process.env.HARNESS_RELAY_URL;
  const relayHostId = process.env.HARNESS_HOST_ID;
  const relayCredential = process.env.HARNESS_RELAY_CREDENTIAL;
  const relayPublicOrigin = process.env.HARNESS_RELAY_PUBLIC_ORIGIN;
  const relayValues = [relayUrl, relayHostId, relayCredential, relayPublicOrigin];
  const relayConfigured = relayValues.some((value) => value !== undefined && value.trim().length > 0);
  if (relayConfigured && relayValues.some((value) => value === undefined || value.trim().length === 0)) {
    throw new Error("Relay configuration requires HARNESS_RELAY_URL, HARNESS_HOST_ID, HARNESS_RELAY_CREDENTIAL, and HARNESS_RELAY_PUBLIC_ORIGIN.");
  }
  const relayOrigin = relayPublicOrigin === undefined ? undefined : new URL(relayPublicOrigin).origin;
  const origins = [...new Set([...args.origins, ...(relayOrigin === undefined ? [] : [relayOrigin])])];

  let relay: HostRelayConnector | undefined;
  const webRoot = resolve(repositoryRoot, "apps/web/dist");
  const host = createHostServer({
    api,
    allowedOrigins: origins,
    ...(relayOrigin === undefined ? {} : { bridgeOrigin: relayOrigin }),
    pairingUrlForToken: (token) => {
      const origin = relayOrigin ?? args.origins[0]!;
      return new URL("/pair?token=" + encodeURIComponent(token), origin).toString();
    },
    ...(relayHostId === undefined ? {} : {
      registerPairingToken: (registration) => {
        if (relay === undefined) throw new Error("Relay connector is unavailable.");
        return relay.registerPairingToken(registration);
      },
      unregisterPairingToken: (pairingId: string) => relay?.unregisterPairingToken(pairingId),
      revokeDeviceSession: (deviceId: string) => relay?.revokeDeviceSession(deviceId),
    }),
    voiceInput,
    staticRoot: webRoot,
    port: args.port,
  });

  if (relayUrl !== undefined && relayHostId !== undefined && relayCredential !== undefined) {
    relay = new HostRelayConnector({
      relayUrl,
      hostId: relayHostId,
      credential: relayCredential,
      allowInsecureLocalhost: true,
      handlers: host.relayHandler,
      onStatus: (status) => {
        if (status === "unauthorized") process.stderr.write("Relay rejected this Host identity; remote pairing is unavailable.\n");
      },
    });
  }

  const address = await host.listen();
  process.stdout.write("Computer Harness Host is listening on the local computer at " + address + ".\n");
  process.stdout.write("Remote pairing requires a configured and connected Relay; the loopback page alone is not phone-reachable.\n");
  if (relay !== undefined) {
    void relay.start().catch(() => {
      process.stderr.write("Relay is not connected; the Host will retry in the background.\n");
    });
  }

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    const active = session.activeRun;
    if (active !== undefined) {
      try {
        active.controller.cancel("Host process is shutting down");
      } catch {
        // It may have finished between reading activeRun and cancellation.
      }
    }
    relay?.close();
    await host.close().catch(() => undefined);
    await session.close().catch(() => undefined);
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
}

function parseArguments(argv: readonly string[]): HostArguments {
  const values = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]!;
    if (item === "--help" || item === "-h") {
      process.stdout.write("Usage: host --env-file <path> --socket <path> --model <glm-5.3-flash|qwen3.8-flash> --output <path> [--port 4317] [--origin <exact-origin> ...]\n");
      process.exit(0);
    }
    if (!item.startsWith("--")) throw new Error("Host arguments must use named options.");
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error("Missing value for " + item + ".");
    index += 1;
    const entries = values.get(item) ?? [];
    entries.push(value);
    values.set(item, entries);
  }
  const one = (key: string, fallback?: string): string | undefined => {
    const entries = values.get(key);
    if (entries !== undefined && entries.length > 1) throw new Error(key + " may be supplied only once.");
    return entries?.[0] ?? fallback;
  };
  const envFile = one("--env-file");
  const socket = one("--socket");
  const output = one("--output");
  const model = one("--model", "glm-5.3-flash");
  const rawPort = one("--port", "4317");
  if (envFile === undefined || socket === undefined || output === undefined) {
    throw new Error("--env-file, --socket, and --output are required.");
  }
  if (model !== "glm-5.3-flash" && model !== "qwen3.8-flash") throw new Error("--model must be glm-5.3-flash or qwen3.8-flash.");
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("--port must be an integer from 0 to 65535.");
  const origins = values.get("--origin") ?? ["http://localhost:" + (port === 0 ? "4317" : String(port))];
  if (origins.length === 0) throw new Error("At least one --origin is required.");
  return { envFile, socket, model, output, port, origins };
}

function createSessionConfig(
  args: HostArguments,
  outputDir: string,
  managedBrowserProfile: { readonly profileLabel: string; readonly profileRoot: string },
): ApplicationSessionConfig {
  const model: RunModel = args.model;
  const qwenModel = args.model === "qwen3.8-flash";
  const baseUrl = process.env.DASHSCOPE_BASE_URL ?? process.env.DASHSCOPE_ENDPOINT;
  const glmEndpoint = process.env.GLM_BASE_URL;
  return {
    model,
    computer: {
      kind: "cua",
      socketPath: args.socket,
      screenshotDir: resolve(outputDir, "driver-screenshots"),
      grounding: "off",
      managedBrowserProfileMode: "persistent",
      managedBrowserProfileLabel: managedBrowserProfile.profileLabel,
      managedBrowserProfileRoot: managedBrowserProfile.profileRoot,
    },
    outputDir,
    maxSteps: 100,
    maxModelRequests: 100,
    planning: true,
    memory: "facts",
    memoryRetrieval: "lexical",
    batching: "same-control-input-v1",
    contextMode: "recent",
    contextMaxHistoryEvents: 80,
    riskProfile: "live-interactive",
    riskGuard: "layered",
    riskModel: "same",
    riskMaxModelRequests: 1,
    riskTimeoutMs: 15_000,
    cleanupDeadlineMs: 5_000,
    monitor: "shadow",
    windowHandoff: "confirm-v1",
    glmThinking: process.env.GLM_THINKING === "disabled" ? "disabled" : "enabled",
    ...(glmEndpoint === undefined ? {} : { glmEndpoint }),
    ...(baseUrl === undefined ? {} : { qwenEndpoint: baseUrl }),
    ...(process.env.DASHSCOPE_WORKSPACE_ID === undefined ? {} : { qwenWorkspaceId: process.env.DASHSCOPE_WORKSPACE_ID }),
    ...(qwenModel ? {
      qwenCoordinateMode: "normalized_1000" as const,
      qwenThinking: "low" as const,
      qwenOutputMode: "strict_json" as const,
    } : {}),
  };
}

function readProviderCredentials(): ProviderCredentials {
  const glmApiKey = process.env.ZHIPUAI_API_KEY ?? process.env.ZHIPU_API_KEY ?? process.env.GLM_API_KEY;
  const qwenApiKey = process.env.DASHSCOPE_API_KEY;
  const memoryEmbeddingApiKey = process.env.MEMORY_EMBEDDING_API_KEY;
  const osworldBridgeToken = process.env.OSWORLD_BRIDGE_TOKEN;
  return {
    ...(glmApiKey === undefined ? {} : { glmApiKey }),
    ...(qwenApiKey === undefined ? {} : { qwenApiKey }),
    ...(memoryEmbeddingApiKey === undefined ? {} : { memoryEmbeddingApiKey }),
    ...(osworldBridgeToken === undefined ? {} : { osworldBridgeToken }),
  };
}

async function loadEnvFile(path: string): Promise<void> {
  const content = await readFile(path, "utf8");
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/gu, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown startup error";
  process.stderr.write("Computer Harness Host could not start: " + message + "\n");
  process.exitCode = 1;
});
