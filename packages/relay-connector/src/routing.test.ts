import { describe, expect, it } from "vitest";
import { isValidApiRequestBody, resolveAllowedApiRoute, type JsonObject } from "./routing.js";

describe("managed browser profile relay routes", () => {
  it("allows only the profile read, prepare, complete, relogin, and preference commands", () => {
    expect(resolveAllowedApiRoute("GET", "/api/managed-browser-profile")?.method).toBe("GET");
    const prepare = resolveAllowedApiRoute("POST", "/api/managed-browser-profile/prepare");
    const complete = resolveAllowedApiRoute("POST", "/api/managed-browser-profile/complete");
    const relogin = resolveAllowedApiRoute("POST", "/api/managed-browser-profile/relogin");
    const preference = resolveAllowedApiRoute("PUT", "/api/managed-browser-profile/preference");
    expect(prepare).not.toBeNull();
    expect(complete).not.toBeNull();
    expect(relogin).not.toBeNull();
    expect(preference).not.toBeNull();
    expect(resolveAllowedApiRoute("DELETE", "/api/managed-browser-profile")).toBeNull();
    expect(resolveAllowedApiRoute("POST", "/api/managed-browser-profile/clear")).toBeNull();
    expect(resolveAllowedApiRoute("PUT", "/api/managed-browser-profile/prepare")).toBeNull();

    expect(isValidApiRequestBody(prepare!, {})).toBe(true);
    expect(isValidApiRequestBody(prepare!, { profileRoot: "C:\\client" })).toBe(false);
    expect(isValidApiRequestBody(relogin!, {})).toBe(true);
    expect(isValidApiRequestBody(complete!, { operationId: "11111111-1111-4111-8111-111111111111" })).toBe(true);
    expect(isValidApiRequestBody(complete!, { operationId: "not-an-operation" })).toBe(false);
    expect(isValidApiRequestBody(complete!, { operationId: "11111111-1111-4111-8111-111111111111", pid: 10 })).toBe(false);
    expect(isValidApiRequestBody(preference!, { defaultSession: "saved" })).toBe(true);
    expect(isValidApiRequestBody(preference!, { defaultSession: "temporary" })).toBe(true);
    expect(isValidApiRequestBody(preference!, { defaultSession: "saved", profileRoot: "C:\\client" })).toBe(false);
    expect(isValidApiRequestBody(preference!, { defaultSession: "other" } as JsonObject)).toBe(false);
  });

  it("validates the exact desktop switch opt-in without accepting unrelated target fields", () => {
    const runs = resolveAllowedApiRoute("POST", "/api/runs");
    if (runs === null) throw new Error("expected the run route");
    const request = (target: JsonObject): JsonObject => ({ commandId: "desktop-switch", goal: "Inspect the listed window", target });
    expect(isValidApiRequestBody(runs, request({ mode: "desktop" }))).toBe(true);
    expect(isValidApiRequestBody(runs, request({ mode: "desktop", switchWindows: false }))).toBe(true);
    expect(isValidApiRequestBody(runs, request({ mode: "desktop", switchWindows: true }))).toBe(true);
    expect(isValidApiRequestBody(runs, request({ mode: "desktop", switchWindows: "yes" } as JsonObject))).toBe(false);
    expect(isValidApiRequestBody(runs, request({ mode: "desktop", switchWindows: true, profileRoot: "C:\\client" }))).toBe(false);
    expect(isValidApiRequestBody(runs, request({ mode: "auto", switchWindows: true }))).toBe(true);
    expect(isValidApiRequestBody(runs, request({ mode: "window", targetToken: "T".repeat(32), switchWindows: true }))).toBe(true);
    expect(isValidApiRequestBody(runs, request({ mode: "browser", sessionMode: "saved", switchWindows: true }))).toBe(true);
  });
});
