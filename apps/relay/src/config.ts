import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { isSafeHeaderValue, isValidIdentifier } from "@computer-harness/relay-connector/routing";
import type { RelayServerConfig } from "./server.js";

interface RelayConfigFile {
  publicOrigin?: unknown;
  listen?: unknown;
  webRoot?: unknown;
  requestTimeoutMs?: unknown;
  hostCredentials?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveConfigPath(value: string, baseDirectory: string): string {
  return isAbsolute(value) ? value : resolve(baseDirectory, value);
}

/** Read relay settings without printing or exposing host credentials. */
export async function loadRelayConfig(configPath: string): Promise<RelayServerConfig> {
  const absoluteConfigPath = resolve(configPath);
  const configStat = await stat(absoluteConfigPath);
  if (process.platform !== "win32" && (configStat.mode & 0o077) !== 0) {
    throw new Error("relay config permissions are too broad; restrict the file to its service account");
  }
  const text = await readFile(absoluteConfigPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("relay config is not valid JSON");
  }
  if (!isRecord(parsed)) throw new Error("relay config must be a JSON object");
  const config = parsed as RelayConfigFile;
  if (typeof config.publicOrigin !== "string" || config.publicOrigin.length > 512) {
    throw new Error("relay config requires publicOrigin");
  }
  const listen = isRecord(config.listen) ? config.listen : {};
  const listenHost = listen.host === undefined ? "127.0.0.1" : listen.host;
  const listenPort = listen.port === undefined ? 8787 : listen.port;
  if (typeof listenHost !== "string" || !isSafeHeaderValue(listenHost, 255)
    || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(listenHost)) {
    throw new Error("relay must bind to localhost behind a TLS reverse proxy");
  }
  if (!Number.isInteger(listenPort) || (listenPort as number) < 1 || (listenPort as number) > 65535) {
    throw new Error("relay listen port is invalid");
  }
  if (config.webRoot !== undefined && typeof config.webRoot !== "string") throw new Error("relay webRoot must be a path");
  if (config.requestTimeoutMs !== undefined
    && (!Number.isInteger(config.requestTimeoutMs) || (config.requestTimeoutMs as number) < 1000 || (config.requestTimeoutMs as number) > 120_000)) {
    throw new Error("relay requestTimeoutMs must be from 1000 to 120000");
  }
  if (!Array.isArray(config.hostCredentials) || config.hostCredentials.length < 1 || config.hostCredentials.length > 128) {
    throw new Error("relay config requires between 1 and 128 host credentials");
  }
  const hostCredentials = new Map<string, string>();
  const seenCredentials = new Set<string>();
  for (const entry of config.hostCredentials) {
    if (!isRecord(entry) || typeof entry.hostId !== "string" || !isValidIdentifier(entry.hostId)
      || typeof entry.credential !== "string" || !isSafeHeaderValue(entry.credential, 4096)
      || entry.credential.length < 32 || entry.credential.includes("REPLACE")) {
      throw new Error("relay host credentials contain an invalid entry");
    }
    if (hostCredentials.has(entry.hostId) || seenCredentials.has(entry.credential)) {
      throw new Error("relay host credential identities must be unique");
    }
    hostCredentials.set(entry.hostId, entry.credential);
    seenCredentials.add(entry.credential);
  }
  const baseDirectory = dirname(absoluteConfigPath);
  const webRoot = typeof config.webRoot === "string" ? resolveConfigPath(config.webRoot, baseDirectory) : undefined;
  return {
    publicOrigin: config.publicOrigin,
    listenHost,
    listenPort: listenPort as number,
    hostCredentials,
    ...(webRoot === undefined ? {} : { webRoot }),
    ...(config.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: config.requestTimeoutMs as number }),
  };
}
