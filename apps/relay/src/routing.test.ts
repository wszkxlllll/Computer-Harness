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

  it("requires opaque target tokens for run start and rejects OS handles or path fields", () => {
    const route = resolveAllowedApiRoute("POST", "/api/runs");
    expect(route).not.toBeNull();
    const baseBody = { commandId: "start_01", goal: "Open the selected application", targetToken: "a".repeat(32) };
    expect(isValidApiRequestBody(route!, baseBody)).toBe(true);
    expect(isValidApiRequestBody(route!, { commandId: baseBody.commandId, goal: baseBody.goal })).toBe(false);
    expect(isValidApiRequestBody(route!, { ...baseBody, pid: 1234 })).toBe(false);
    expect(isValidApiRequestBody(route!, { ...baseBody, hwnd: 5678 })).toBe(false);
    expect(isValidApiRequestBody(route!, { ...baseBody, path: "C:/private/document" })).toBe(false);
    expect(isValidApiRequestBody(route!, { ...baseBody, targetToken: "short" })).toBe(false);
    expect(isValidApiRequestBody(route!, { ...baseBody, goal: "" })).toBe(false);
  });
});
