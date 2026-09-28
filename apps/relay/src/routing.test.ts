import { describe, expect, it } from "vitest";
import {
  MAX_ASSET_RESPONSE_BYTES,
  MAX_JSON_REQUEST_BYTES,
  isValidApiRequestBody,
  parseBoundedJson,
  resolveAllowedApiRoute,
} from "./routing.js";

describe("relay API route allowlist", () => {
  it("accepts only the mobile Host API routes and approved query parameters", () => {
    expect(resolveAllowedApiRoute("POST", "/api/pair/requests")?.path).toBe("/api/pair/requests");
    expect(resolveAllowedApiRoute("GET", "/api/windows")?.path).toBe("/api/windows");
    expect(resolveAllowedApiRoute("POST", "/api/windows")).toBeNull();
    expect(resolveAllowedApiRoute("GET", "/api/pair/requests/pair_123")?.path).toBe("/api/pair/requests/pair_123");
    expect(resolveAllowedApiRoute("POST", "/api/pair/requests/pair_123/session")?.path).toBe("/api/pair/requests/pair_123/session");
    expect(resolveAllowedApiRoute("GET", "/api/runs/run-1/events?after=12")?.query).toEqual({ after: "12" });
    expect(resolveAllowedApiRoute("GET", "/api/runs/run-1/assets/asset-1")?.maxResponseBytes).toBe(MAX_ASSET_RESPONSE_BYTES);
    expect(resolveAllowedApiRoute("POST", "/api/runs/run-1/commands")?.maxResponseBytes).toBeGreaterThan(0);
    expect(resolveAllowedApiRoute("GET", "/api/runs/run-1/commands/cmd-1")?.path).toBe("/api/runs/run-1/commands/cmd-1");
  });

  it("rejects local routes, unlisted verbs/routes, encoded paths, and unapproved queries", () => {
    for (const [method, path] of [
      ["GET", "/api/local/health"],
      ["POST", "/api/local/anything"],
      ["GET", "/api/runs/run-1/../local"],
      ["GET", "/api/runs/run-1%2fassets/a"],
      ["PUT", "/api/runs"],
      ["POST", "/api/runs/run-1/assets/a"],
      ["GET", "/api/runs/run-1/events?after=1&after=2"],
      ["GET", "/api/runs/run-1/events?path=C:%5Cprivate"],
      ["GET", "/api/runs/run-1/assets/a?path=anything"],
    ] as const) {
      expect(resolveAllowedApiRoute(method, path), `${method} ${path}`).toBeNull();
    }
  });

  it("bounds and validates JSON before a request is sent to a Host", () => {
    const encode = (value: string) => Buffer.from(value, "utf8");
    expect(parseBoundedJson(encode('{"goal":"find trains"}'))).toEqual({ goal: "find trains" });
    expect(parseBoundedJson(encode("[]"))).toBeNull();
    expect(parseBoundedJson(encode('{"constructor":{"prototype":{}}}'))).toBeNull();
    expect(parseBoundedJson(encode(`{"text":"${"x".repeat(MAX_JSON_REQUEST_BYTES)}"}`))).toBeNull();
    expect(parseBoundedJson(encode(`{"a":${"[".repeat(18)}0${"]".repeat(18)}}`))).toBeNull();
  });

  it("allowlists authenticated voice routes and bounds ordered adaptive PCM16 batches", () => {
    expect(resolveAllowedApiRoute("GET", "/api/voice/capabilities")?.path).toBe("/api/voice/capabilities");
    const startRoute = resolveAllowedApiRoute("POST", "/api/voice/sessions");
    const audioRoute = resolveAllowedApiRoute("POST", "/api/voice/sessions/session-1/audio");
    const finishRoute = resolveAllowedApiRoute("POST", "/api/voice/sessions/session-1/finish");
    const cancelRoute = resolveAllowedApiRoute("POST", "/api/voice/sessions/session-1/cancel");
    expect(resolveAllowedApiRoute("GET", "/api/voice/sessions/session-1/audio")).toBeNull();
    expect(resolveAllowedApiRoute("POST", "/api/voice/sessions/session-1/events")).toBeNull();
    expect(startRoute).not.toBeNull();
    expect(audioRoute).not.toBeNull();
    expect(finishRoute).not.toBeNull();
    expect(cancelRoute).not.toBeNull();
    expect(isValidApiRequestBody(startRoute!, { requestId: "start-1" })).toBe(true);
    expect(isValidApiRequestBody(startRoute!, { requestId: "start-1", apiKey: "secret" })).toBe(false);

    const audio = Buffer.alloc(3_200).toString("base64");
    const one = [{ sequence: 0, audio }];
    expect(isValidApiRequestBody(audioRoute!, { chunks: one, afterEventSequence: 2 })).toBe(true);
    expect(isValidApiRequestBody(audioRoute!, { chunks: [{ sequence: 0, audio: "AQ==" }], afterEventSequence: 2 })).toBe(false);
    expect(isValidApiRequestBody(audioRoute!, { chunks: [{ sequence: 0, audio: Buffer.alloc(4_098).toString("base64") }], afterEventSequence: 2 })).toBe(false);
    expect(isValidApiRequestBody(audioRoute!, { chunks: [{ sequence: 2, audio }, { sequence: 3, audio }], afterEventSequence: 2 })).toBe(true);
    expect(isValidApiRequestBody(audioRoute!, { chunks: [{ sequence: 2, audio }, { sequence: 2, audio }], afterEventSequence: 2 })).toBe(false);
    expect(isValidApiRequestBody(audioRoute!, { chunks: Array.from({ length: 5 }, (_, sequence) => ({ sequence, audio })), afterEventSequence: 2 })).toBe(false);
    expect(isValidApiRequestBody(audioRoute!, { chunks: [{ sequence: 1_200, audio }], afterEventSequence: 2 })).toBe(false);
    expect(isValidApiRequestBody(audioRoute!, { chunks: one, afterEventSequence: 2, deviceId: "raw-device" })).toBe(false);
    expect(isValidApiRequestBody(finishRoute!, { afterEventSequence: 3 })).toBe(true);
    expect(isValidApiRequestBody(cancelRoute!, { afterEventSequence: 3 })).toBe(true);
    expect(isValidApiRequestBody(finishRoute!, { afterEventSequence: 3, transcript: "do not accept caller text" })).toBe(false);
  });

  it("accepts legacy and tagged run targets while rejecting unsafe or ambiguous selectors", () => {
    const route = resolveAllowedApiRoute("POST", "/api/runs");
    expect(route).not.toBeNull();
    const base = { commandId: "start_01", goal: "Open the selected application" };
    const targetToken = "a".repeat(32);
    for (const body of [
      { ...base, targetToken },
      { ...base, target: { mode: "auto" } },
      { ...base, target: { mode: "window", targetToken } },
      { ...base, target: { mode: "browser" } },
      { ...base, target: { mode: "browser", url: "" } },
      { ...base, target: { mode: "browser", url: "   " } },
      { ...base, target: { mode: "browser", url: "about:blank" } },
      { ...base, target: { mode: "browser", url: "https://example.com/trips" } },
      { ...base, target: { mode: "browser", url: "http://localhost:3000/" } },
      { ...base, target: { mode: "browser", sessionMode: "temporary" } },
      { ...base, target: { mode: "browser", sessionMode: "saved" } },
      { ...base, target: { mode: "browser", sessionMode: "saved", url: "https://example.com/trips" } },
    ]) {
      expect(isValidApiRequestBody(route!, body), JSON.stringify(body)).toBe(true);
    }

    for (const body of [
      { ...base },
      { ...base, targetToken, target: { mode: "auto" } },
      { ...base, pid: 1234, targetToken },
      { ...base, hwnd: 5678, targetToken },
      { ...base, path: "C:/private/document", targetToken },
      { ...base, targetToken: "short" },
      { ...base, goal: "", targetToken },
      { ...base, target: null },
      { ...base, target: [] },
      { ...base, target: { mode: "unknown" } },
      { ...base, target: { mode: "auto", targetToken } },
      { ...base, target: { mode: "window", targetToken: "short" } },
      { ...base, target: { mode: "window", targetToken, pid: 1234 } },
      { ...base, target: { mode: "browser", url: "ftp://example.com/" } },
      { ...base, target: { mode: "browser", url: "example.com/trips" } },
      { ...base, target: { mode: "browser", url: "https:///trips" } },
      { ...base, target: { mode: "browser", url: "https://user:secret@example.com/" } },
      { ...base, target: { mode: "browser", url: " https://example.com/" } },
      { ...base, target: { mode: "browser", url: "https://example.com/ " } },
      { ...base, target: { mode: "browser", sessionMode: "unknown" } },
      { ...base, target: { mode: "browser", url: "about:blank#fragment" } },
      { ...base, target: { mode: "browser", url: `https://example.com/${"x".repeat(2048)}` } },
      { ...base, target: { mode: "browser", url: " ".repeat(2049) } },
      { ...base, target: { mode: "browser", url: "https://example.com/", profilePath: "C:/private" } },
    ]) {
      expect(isValidApiRequestBody(route!, body), JSON.stringify(body)).toBe(false);
    }
  });
});
