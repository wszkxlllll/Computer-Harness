import {
  VOICE_INPUT_MAX_BATCH_BYTES,
  VOICE_INPUT_MAX_BATCH_CHUNKS,
  VOICE_INPUT_MAX_CHUNK_BYTES,
  VOICE_INPUT_MAX_CHUNKS,
} from "@computer-harness/voice";
import { normalizeRunAssistantPreferencesSnapshot } from "@computer-harness/protocol";

export type RelayHttpMethod = "GET" | "POST" | "PUT" | "DELETE";
export type ApiResponseKind = "json" | "sse" | "asset";

export interface AllowedApiRoute {
  method: RelayHttpMethod;
  path: string;
  query: Readonly<Record<string, string>>;
  kind: ApiResponseKind;
  maxResponseBytes: number;
}

export const MAX_JSON_REQUEST_BYTES = 32 * 1024;
export const MAX_JSON_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_ASSET_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_SSE_EVENT_BYTES = 64 * 1024;
export const MAX_WIRE_MESSAGE_BYTES = 12 * 1024 * 1024;

const identifier = /^[A-Za-z0-9_-]{1,128}$/u;
const queryKeysByRoute = new Map<string, ReadonlySet<string>>([
  ["GET /api/runs", new Set(["after", "limit"])],
  ["GET /api/runs/:runId/events", new Set(["after"])],
]);

function parseQuery(searchParams: URLSearchParams, routeKey: string): Record<string, string> | null {
  const allowed = queryKeysByRoute.get(routeKey) ?? new Set<string>();
  const query: Record<string, string> = {};
  for (const [key, value] of searchParams) {
    if (!allowed.has(key) || Object.hasOwn(query, key) || value.length > 24) return null;
    if (key === "after" && !/^(?:0|[1-9][0-9]{0,18})$/u.test(value)) return null;
    if (key === "limit" && !/^(?:[1-9][0-9]{0,2})$/u.test(value)) return null;
    query[key] = value;
  }
  return query;
}

function identifyRoute(method: RelayHttpMethod, pathname: string): Omit<AllowedApiRoute, "query"> | null {
  if (method === "GET" && pathname === "/api/session") {
    return { method, path: pathname, kind: "json", maxResponseBytes: MAX_JSON_RESPONSE_BYTES };
  }
  if (method === "DELETE" && pathname === "/api/session") {
    return { method, path: pathname, kind: "json", maxResponseBytes: MAX_JSON_RESPONSE_BYTES };
  }
  if (method === "POST" && pathname === "/api/pair/requests") {
    return { method, path: pathname, kind: "json", maxResponseBytes: MAX_JSON_RESPONSE_BYTES };
  }

  if (method === "GET" && pathname === "/api/windows") {
    return { method, path: pathname, kind: "json", maxResponseBytes: MAX_JSON_RESPONSE_BYTES };
  }
  if (method === "GET" && pathname === "/api/managed-browser-profile") {
    return { method, path: pathname, kind: "json", maxResponseBytes: MAX_JSON_RESPONSE_BYTES };
  }
  if (method === "PUT" && pathname === "/api/managed-browser-profile/preference") {
    return { method, path: pathname, kind: "json", maxResponseBytes: MAX_JSON_RESPONSE_BYTES };
  }
  if (method === "POST" && /^\/api\/managed-browser-profile\/(prepare|complete|relogin)$/u.test(pathname)) {
    return { method, path: pathname, kind: "json", maxResponseBytes: MAX_JSON_RESPONSE_BYTES };
  }
  if (method === "GET" && pathname === "/api/voice/capabilities") {
    return { method, path: pathname, kind: "json", maxResponseBytes: MAX_JSON_RESPONSE_BYTES };
  }
  if (method === "POST" && pathname === "/api/voice/sessions") {
    return { method, path: pathname, kind: "json", maxResponseBytes: MAX_JSON_RESPONSE_BYTES };
  }
  const voiceAudioMatch = /^\/api\/voice\/sessions\/([A-Za-z0-9_-]{1,128})\/audio$/u.exec(pathname);
  if (voiceAudioMatch !== null && method === "POST") {
    return { method, path: pathname, kind: "json", maxResponseBytes: MAX_JSON_RESPONSE_BYTES };
  }
  const voiceControlMatch = /^\/api\/voice\/sessions\/([A-Za-z0-9_-]{1,128})\/(finish|cancel)$/u.exec(pathname);
  if (voiceControlMatch !== null && method === "POST") {
    return { method, path: pathname, kind: "json", maxResponseBytes: MAX_JSON_RESPONSE_BYTES };
  }

  const pairStatus = /^\/api\/pair\/requests\/([A-Za-z0-9_-]{1,128})$/u.exec(pathname);
  if (pairStatus !== null && method === "GET") {
    return { method, path: pathname, kind: "json", maxResponseBytes: MAX_JSON_RESPONSE_BYTES };
  }
  if (pairStatus !== null && method === "DELETE") {
    return { method, path: pathname, kind: "json", maxResponseBytes: MAX_JSON_RESPONSE_BYTES };
  }
  const pairSession = /^\/api\/pair\/requests\/([A-Za-z0-9_-]{1,128})\/session$/u.exec(pathname);
  if (pairSession !== null && method === "POST") {
    return { method, path: pathname, kind: "json", maxResponseBytes: MAX_JSON_RESPONSE_BYTES };
  }

  if (method === "GET" && pathname === "/api/runs") {
    return { method, path: pathname, kind: "json", maxResponseBytes: MAX_JSON_RESPONSE_BYTES };
  }
  if (method === "POST" && pathname === "/api/runs") {
    return { method, path: pathname, kind: "json", maxResponseBytes: MAX_JSON_RESPONSE_BYTES };
  }

  const runMatch = /^\/api\/runs\/([A-Za-z0-9_-]{1,128})$/u.exec(pathname);
  if (runMatch !== null && method === "GET") {
    return { method, path: pathname, kind: "json", maxResponseBytes: MAX_JSON_RESPONSE_BYTES };
  }
  const eventsMatch = /^\/api\/runs\/([A-Za-z0-9_-]{1,128})\/events$/u.exec(pathname);
  if (eventsMatch !== null && method === "GET") {
    return { method, path: pathname, kind: "sse", maxResponseBytes: Number.POSITIVE_INFINITY };
  }
  const commandsMatch = /^\/api\/runs\/([A-Za-z0-9_-]{1,128})\/commands$/u.exec(pathname);
  if (commandsMatch !== null && method === "POST") {
    return { method, path: pathname, kind: "json", maxResponseBytes: MAX_JSON_RESPONSE_BYTES };
  }
  const commandReceiptMatch = /^\/api\/runs\/([A-Za-z0-9_-]{1,128})\/commands\/([A-Za-z0-9_-]{1,128})$/u.exec(pathname);
  if (commandReceiptMatch !== null && method === "GET") {
    return { method, path: pathname, kind: "json", maxResponseBytes: MAX_JSON_RESPONSE_BYTES };
  }
  const assetMatch = /^\/api\/runs\/([A-Za-z0-9_-]{1,128})\/assets\/([A-Za-z0-9_-]{1,128})$/u.exec(pathname);
  if (assetMatch !== null && method === "GET") {
    return { method, path: pathname, kind: "asset", maxResponseBytes: MAX_ASSET_RESPONSE_BYTES };
  }
  return null;
}

/** Resolve the finite browser API surface that may cross the relay. */
export function resolveAllowedApiRoute(methodText: string, requestTarget: string): AllowedApiRoute | null {
  if (methodText !== "GET" && methodText !== "POST" && methodText !== "PUT" && methodText !== "DELETE") return null;
  if (requestTarget.length > 4096 || !requestTarget.startsWith("/")) return null;
  if (requestTarget.includes("\\") || requestTarget.includes("%") || requestTarget.includes("#")) return null;
  const rawPath = requestTarget.split("?", 1)[0] ?? "";
  if (rawPath.split("/").some((part) => part === "." || part === "..")) return null;

  let url: URL;
  try {
    url = new URL(requestTarget, "http://relay.invalid");
  } catch {
    return null;
  }
  if (url.origin !== "http://relay.invalid" || url.pathname.includes("//")) return null;
  if (url.pathname === "/api/local" || url.pathname.startsWith("/api/local/")) return null;
  if (url.pathname.split("/").some((part) => part === "." || part === "..")) return null;

  const method = methodText as RelayHttpMethod;
  const identified = identifyRoute(method, url.pathname);
  if (identified === null) return null;
  const routeKey = identified.path
    .replace(/^\/api\/runs\/[A-Za-z0-9_-]{1,128}(?=\/|$)/u, "/api/runs/:runId")
    .replace(/^\/api\/runs\/:runId\/commands\/[A-Za-z0-9_-]{1,128}$/u, "/api/runs/:runId/commands/:commandId")
    .replace(/^\/api\/pair\/requests\/[A-Za-z0-9_-]{1,128}(?=\/|$)/u, "/api/pair/requests/:requestId");
  const query = parseQuery(url.searchParams, `${method} ${routeKey}`);
  if (query === null) return null;
  return { ...identified, query };
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

function hasExactKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowedKeys.length && keys.every((key) => allowedKeys.includes(key));
}

function isValidAssistantPreferences(value: unknown): boolean {
  try {
    normalizeRunAssistantPreferencesSnapshot(value);
    return true;
  } catch {
    return false;
  }
}

function isValidWindowTargetToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32}$/u.test(value);
}

function isValidBrowserStartUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return true;
  if (trimmed !== value) return false;
  if (value === "about:blank") return true;
  if (!/^https?:\/\//iu.test(value)) return false;
  const authority = /^https?:\/\/([^/?#]*)/iu.exec(value)?.[1];
  if (authority === undefined || authority.length === 0 || authority.includes("@")) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && url.hostname.length > 0
      && url.username.length === 0
      && url.password.length === 0;
  } catch {
    return false;
  }
}

function isValidBrowserSessionMode(value: unknown): value is "temporary" | "saved" {
  return value === "temporary" || value === "saved";
}

function isValidOperationId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

function hasOptionalSwitchWindows(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return hasExactKeys(value, keys) ||
    (hasExactKeys(value, [...keys, "switchWindows"]) && typeof value.switchWindows === "boolean");
}

function isValidRunTarget(value: unknown): boolean {
  if (!isRecord(value) || typeof value.mode !== "string") return false;
  if (Object.hasOwn(value, "switchWindows") && typeof value.switchWindows !== "boolean") return false;
  if (value.mode === "auto") return hasOptionalSwitchWindows(value, ["mode"]);
  if (value.mode === "desktop") return hasOptionalSwitchWindows(value, ["mode"]);
  if (value.mode === "window") {
    return hasOptionalSwitchWindows(value, ["mode", "targetToken"]) && isValidWindowTargetToken(value.targetToken);
  }
  if (value.mode === "browser") {
    if (hasOptionalSwitchWindows(value, ["mode"])) return true;
    if (hasOptionalSwitchWindows(value, ["mode", "url"])) return isValidBrowserStartUrl(value.url);
    if (hasOptionalSwitchWindows(value, ["mode", "sessionMode"])) return isValidBrowserSessionMode(value.sessionMode);
    return hasOptionalSwitchWindows(value, ["mode", "sessionMode", "url"])
      && isValidBrowserSessionMode(value.sessionMode)
      && isValidBrowserStartUrl(value.url);
  }
  return false;
}

/** Validate the only route-specific browser start payload without accepting OS handles or paths. */
export function isValidApiRequestBody(route: AllowedApiRoute, body: JsonObject | undefined): boolean {
  if (route.method === "PUT" && route.path === "/api/managed-browser-profile/preference") {
    return body !== undefined && hasExactKeys(body, ["defaultSession"])
      && (body.defaultSession === "saved" || body.defaultSession === "temporary");
  }
  if (route.method === "POST" && /^\/api\/managed-browser-profile\/(?:prepare|relogin)$/u.test(route.path)) {
    return body !== undefined && Object.keys(body).length === 0;
  }
  if (route.method === "POST" && route.path === "/api/managed-browser-profile/complete") {
    return body !== undefined && hasExactKeys(body, ["operationId"]) && isValidOperationId(body.operationId);
  }
  if (route.method === "POST" && route.path === "/api/voice/sessions") {
    return body !== undefined && hasExactKeys(body, ["requestId"]) && isValidIdentifier(body.requestId);
  }
  if (route.method === "POST" && /^\/api\/voice\/sessions\/[A-Za-z0-9_-]{1,128}\/audio$/u.test(route.path)) {
    if (body === undefined || !hasExactKeys(body, ["chunks", "afterEventSequence"])
      || !Number.isSafeInteger(body.afterEventSequence) || (body.afterEventSequence as number) < 0
      || !Array.isArray(body.chunks) || body.chunks.length === 0 || body.chunks.length > VOICE_INPUT_MAX_BATCH_CHUNKS) return false;
    let totalBytes = 0;
    let previousSequence = -1;
    for (const value of body.chunks) {
      if (!isRecord(value) || !hasExactKeys(value, ["sequence", "audio"])
        || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0
        || (value.sequence as number) >= VOICE_INPUT_MAX_CHUNKS
        || (value.sequence as number) <= previousSequence
        || typeof value.audio !== "string" || value.audio.length === 0
        || value.audio.length > Math.ceil(VOICE_INPUT_MAX_CHUNK_BYTES / 3) * 4
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.audio)) return false;
      previousSequence = value.sequence as number;
      const decoded = Buffer.from(value.audio, "base64");
      const validChunk = decoded.byteLength > 0 && decoded.byteLength <= VOICE_INPUT_MAX_CHUNK_BYTES
        && decoded.byteLength % 2 === 0 && decoded.toString("base64") === value.audio;
      decoded.fill(0);
      if (!validChunk) return false;
      totalBytes += decoded.byteLength;
      if (totalBytes > VOICE_INPUT_MAX_BATCH_BYTES) return false;
    }
    return true;
  }
  if (route.method === "POST" && /^\/api\/voice\/sessions\/[A-Za-z0-9_-]{1,128}\/(?:finish|cancel)$/u.test(route.path)) {
    return body !== undefined && hasExactKeys(body, ["afterEventSequence"])
      && Number.isSafeInteger(body.afterEventSequence) && (body.afterEventSequence as number) >= 0;
  }
  if (route.method !== "POST" || route.path !== "/api/runs") return true;
  if (body === undefined) return false;
  const hasLegacyTarget = Object.hasOwn(body, "targetToken");
  const hasTaggedTarget = Object.hasOwn(body, "target");
  if (hasLegacyTarget === hasTaggedTarget) return false;
  const hasAssistantPreferences = Object.hasOwn(body, "assistantPreferences");
  const hasRunNoticeContentEnabled = Object.hasOwn(body, "runNoticeContentEnabled");
  const targetKeys = hasLegacyTarget ? ["commandId", "goal", "targetToken"] : ["commandId", "goal", "target"];
  const outerKeys = [
    ...targetKeys,
    ...(hasAssistantPreferences ? ["assistantPreferences"] : []),
    ...(hasRunNoticeContentEnabled ? ["runNoticeContentEnabled"] : []),
  ];
  if (!hasExactKeys(body, outerKeys)) return false;
  const validBase = isValidIdentifier(body.commandId)
    && typeof body.goal === "string"
    && body.goal.length > 0
    && body.goal.length <= 20_000;
  if (!validBase) return false;
  if (hasAssistantPreferences && !isValidAssistantPreferences(body.assistantPreferences)) return false;
  if (hasRunNoticeContentEnabled && typeof body.runNoticeContentEnabled !== "boolean") return false;
  return hasLegacyTarget
    ? isValidWindowTargetToken(body.targetToken)
    : isValidRunTarget(body.target);
}

/** Parse bounded JSON and reject values risky to pass across a process boundary. */
export function parseBoundedJson(bytes: Uint8Array, maxBytes = MAX_JSON_REQUEST_BYTES): JsonObject | null {
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) return null;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return null;
  }
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === undefined) continue;
    nodes += 1;
    if (nodes > 4096 || entry.depth > 16) return null;
    const current = entry.value;
    if (current === null || typeof current === "boolean") continue;
    if (typeof current === "string") {
      if (Buffer.byteLength(current, "utf8") > maxBytes) return null;
      continue;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) return null;
      continue;
    }
    if (Array.isArray(current)) {
      if (current.length > 512) return null;
      for (const item of current) stack.push({ value: item, depth: entry.depth + 1 });
      continue;
    }
    if (typeof current === "object") {
      const record = current as Record<string, unknown>;
      const keys = Object.keys(record);
      if (keys.length > 512) return null;
      for (const key of keys) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") return null;
        stack.push({ value: record[key], depth: entry.depth + 1 });
      }
      continue;
    }
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as JsonObject;
}

export function isSafeHeaderValue(value: string, maxBytes = 8 * 1024): boolean {
  return Buffer.byteLength(value, "utf8") <= maxBytes && !/[\r\n\0]/u.test(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isValidIdentifier(value: unknown): value is string {
  return typeof value === "string" && identifier.test(value);
}
