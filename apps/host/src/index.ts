import { readFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ApplicationRemoteRunApi,
  ApplicationSession,
  createFileRemoteAssetReader,
  createWindowTargetDiscovery,
  defaultEnvironmentOwner,
  environmentIdentityForConfig,
  resolveManagedBrowserProfileConfig,
  type ProviderCredentials,
} from "@computer-harness/app-runtime";
import { HostRelayConnector } from "@computer-harness/relay-connector";
import { createHostServer } from "./server.js";
import { glmReasoningEffort, parseGlmInputBudgets, parseGlmOutputBudget, parseGlmRequestTimeoutMs, readGlmThinking } from "./glm-output-budget.js";
import { ManagedBrowserProfileService } from "./managed-browser-profile-service.js";
import { HostVoiceSessionService } from "./voice-session-service.js";
import { createConfiguredVoiceProvider } from "./voice-provider-config.js";
import { resolveHostWindowSelector } from "./window-selection-config.js";
import { createHostSessionConfig, parseHostRiskMaxModelRequests, parseHostRiskTimeoutMs, type HostArguments } from "./session-config.js";
import { resolveHostSourceLinkedFinishContract } from "./source-linked-finish-config.js";

const hostDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(hostDirectory, "../../..");
const DEFAULT_MAX_STEPS = 160;
const DEFAULT_MAX_MODEL_REQUESTS = 48;
const MAX_CONFIGURED_STEPS = 500;
const MAX_CONFIGURED_MODEL_REQUESTS = 256;

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  await loadEnvFile(args.envFile);
  const credentials = readProviderCredentials();
  const outputDir = resolve(args.output);
  const managedBrowserProfile = resolveManagedBrowserProfileConfig();
  const baseConfig = createHostSessionConfig(args, outputDir, managedBrowserProfile, process.env);
  const sourceLinkedFinish = resolveHostSourceLinkedFinishContract(process.env);
  const config = { ...baseConfig, ...(sourceLinkedFinish === undefined ? {} : { sourceLinkedFinish }) };
  const windowSelector = resolveHostWindowSelector(process.env);
  if (args.model === "glm-5.3-flash") process.stdout.write(`GLM configuration: max_tokens=${args.glmMaxOutputTokens} thinking=${config.glmThinking} reasoning_effort=${glmReasoningEffort(config.glmThinking)} maxInputTokens=${config.contextMaxInputTokens} maxWireInputTokens=${config.contextMaxWireInputTokens} requestTimeoutMs=${config.glmRequestTimeoutMs} requestTimeoutSource=${process.env.GLM_REQUEST_TIMEOUT_MS === undefined ? "default" : "environment"} endpointSource=${config.glmEndpoint === undefined ? "default" : "environment"}\n`);
  process.stdout.write(`Risk configuration: guard=${config.riskGuard} model=${config.riskModel} maxModelRequests=${config.riskMaxModelRequests} timeoutMs=${config.riskTimeoutMs}\n`);
  const environmentOwner = defaultEnvironmentOwner;
  const environmentIdentity = environmentIdentityForConfig(config.computer);
  const managedBrowserProfileService = new ManagedBrowserProfileService({
    socketPath: args.socket,
    profileLabel: managedBrowserProfile.profileLabel,
    profileRoot: managedBrowserProfile.profileRoot,
    environmentOwner,
    environmentIdentity,
  });
  await managedBrowserProfileService.getState();
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
    owner: environmentOwner,
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
    // The Host permits safe dynamic notice text; each phone must explicitly
    // opt in when starting the Run. Sensitive text is still redacted by the projector.
    runNotices: { enabled: true, dynamicContentEnabled: true },
    managedBrowserProfile,
    managedBrowserProfileCoordinator: managedBrowserProfileService,
    ...(windowSelector === undefined ? {} : { windowSelector }),
    assetReaderForRun: (_runId, handle) =>
      createFileRemoteAssetReader(join(handle.config.outputDir, "assets")),
    onRunStarted: (receipt) => {
      process.stdout.write(`${JSON.stringify({ type: "run.start.receipt", ...receipt })}\n`);
    },
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
    managedBrowserProfile: managedBrowserProfileService,
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
      process.stdout.write("Usage: host --env-file <path> --socket <path> --model <glm-5.3-flash|qwen3.8-flash> --output <path> [--port 4317] [--origin <exact-origin> ...] [--max-model-requests 48] [--max-steps 160] [--glm-max-output-tokens 8192] [--risk-max-model-requests 1..12 (default 1)] [--risk-timeout-ms 1000..240000 (default 15000)]\n");
      process.stdout.write("--risk-max-model-requests bounds layered semantic review requests only; it does not change the main model-request budget.\n");
      process.stdout.write("Optional local env-file settings: HARNESS_MULTILINE_TYPE_PROFILE=off|foreground-caret-v1; HARNESS_OPERATION_GUIDANCE=off|catalog-v1; HARNESS_PROVIDER_RECOVERY=off|ambiguous-headers-once-v1 (default off); HARNESS_PROVIDER_RECOVERY_RUN_WINDOW_MS=1..900000 (default 900000).\n");
      process.stdout.write("foreground-caret-v1 is only for an explicitly verified candidate CUA socket; it is not a general stock CUA 0.22 compatibility claim.\n");
      process.stdout.write("Optional Run result contract: HARNESS_SOURCE_LINKED_FINISH_CONTRACT may contain a bounded source-linked-finish-v1 JSON field contract.\n");
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
  const rawMaxSteps = one("--max-steps", String(DEFAULT_MAX_STEPS));
  const rawMaxModelRequests = one("--max-model-requests", String(DEFAULT_MAX_MODEL_REQUESTS));
  const rawRiskMaxModelRequests = one("--risk-max-model-requests");
  const riskTimeoutMs = parseHostRiskTimeoutMs(one("--risk-timeout-ms"));
  if (envFile === undefined || socket === undefined || output === undefined) {
    throw new Error("--env-file, --socket, and --output are required.");
  }
  if (model !== "glm-5.3-flash" && model !== "qwen3.8-flash") throw new Error("--model must be glm-5.3-flash or qwen3.8-flash.");
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("--port must be an integer from 0 to 65535.");
  const origins = values.get("--origin") ?? ["http://localhost:" + (port === 0 ? "4317" : String(port))];
  if (origins.length === 0) throw new Error("At least one --origin is required.");
  const maxSteps = parseBoundedPositiveInteger(rawMaxSteps, "--max-steps", MAX_CONFIGURED_STEPS);
  const maxModelRequests = parseBoundedPositiveInteger(rawMaxModelRequests, "--max-model-requests", MAX_CONFIGURED_MODEL_REQUESTS);
  const riskMaxModelRequests = parseHostRiskMaxModelRequests(rawRiskMaxModelRequests);
  const glmMaxOutputTokens = parseGlmOutputBudget(one("--glm-max-output-tokens"));
  return { envFile, socket, model, output, port, origins, maxSteps, maxModelRequests, riskMaxModelRequests, riskTimeoutMs, glmMaxOutputTokens };
}

function parseBoundedPositiveInteger(raw: string | undefined, option: string, maximum: number): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${option} must be a positive integer no greater than ${maximum}.`);
  }
  return value;
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
