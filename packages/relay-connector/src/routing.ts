export type RelayHttpMethod = "GET" | "POST" | "DELETE";
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
  if (methodText !== "GET" && methodText !== "POST" && methodText !== "DELETE") return null;
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

/** Validate the only route-specific browser start payload without accepting OS handles or paths. */
export function isValidApiRequestBody(route: AllowedApiRoute, body: JsonObject | undefined): boolean {
  if (route.method !== "POST" || route.path !== "/api/runs") return true;
  if (body === undefined) return false;
  const keys = Object.keys(body);
  if (keys.length !== 3 || keys.some((key) => key !== "commandId" && key !== "goal" && key !== "targetToken")) return false;
  return isValidIdentifier(body.commandId)
    && typeof body.goal === "string"
    && body.goal.length > 0
    && body.goal.length <= 20_000
    && typeof body.targetToken === "string"
    && /^[A-Za-z0-9_-]{32}$/u.test(body.targetToken);
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
