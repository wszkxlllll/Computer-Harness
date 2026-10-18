import { afterEach, describe, expect, it, vi } from "vitest";
import { FetchArkHttpClient, FetchDeepseekHttpClient, FetchGlmHttpClient } from "./index.js";

const signal = new AbortController().signal;

function failedResponse(status: number, payload: unknown, retryAfter?: string) {
  return {
    ok: false,
    status,
    headers: { get: (name: string) => name.toLowerCase() === "retry-after" ? retryAfter ?? null : null },
    json: async () => payload,
  };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Ark 429 diagnostics and retry advice", () => {
  it("extracts only safe public error fields and accepts a short Retry-After in seconds", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => failedResponse(429, {
      error: { code: "TooManyRequests", message: "Request rate limit exceeded." },
      request: { prompt: "private request body" },
    }, "2")));

    const error = await new FetchArkHttpClient().post("https://fixture.invalid", {}, {}, signal).catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      name: "ArkProviderError",
      code: "ARK_HTTP_429",
      retryable: true,
      retryMode: "same_input",
      httpFailure: {
        httpStatus: 429,
        providerErrorCode: "TooManyRequests",
        providerErrorMessage: "Request rate limit exceeded.",
        retryAfterState: "accepted",
        retryAfterMs: 2_000,
      },
    });
    expect(String(error)).not.toContain("private request body");
    expect(JSON.stringify(error)).not.toContain("private request body");
  });

  it("parses an HTTP-date Retry-After relative to the current clock", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-10-18T00:00:00.000Z"));
    vi.stubGlobal("fetch", vi.fn(async () => failedResponse(429, {
      error: { code: "rate_limit_exceeded", message: "Request rate limit exceeded." },
    }, "Sun, 18 Oct 2026 00:00:03 GMT")));

    await expect(new FetchArkHttpClient().post("https://fixture.invalid", {}, {}, signal)).rejects.toMatchObject({
      retryable: true,
      httpFailure: { retryAfterState: "accepted", retryAfterMs: 3_000 },
    });
  });

  it("keeps Retry-After metadata when a 429 body is unreadable without exposing the parse error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ...failedResponse(429, undefined, "1"),
      json: async () => { throw new SyntaxError("private raw response payload"); },
    })));
    const error = await new FetchArkHttpClient().post("https://fixture.invalid", {}, {}, signal).catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      code: "ARK_HTTP_429",
      retryable: true,
      httpFailure: { httpStatus: 429, retryAfterState: "accepted", retryAfterMs: 1_000 },
    });
    expect(String(error)).not.toContain("private raw response payload");
  });

  it.each([
    ["malformed", "sometime later", "invalid", true],
    ["six-second delay", "6", "accepted", true],
    ["delay beyond the Runtime retry window", "Sun, 18 Oct 2026 00:02:06 GMT", "too_long", false],
  ] as const)("handles a %s Retry-After without truncating it", async (_label, header, state, retryable) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-10-18T00:00:00.000Z"));
    vi.stubGlobal("fetch", vi.fn(async () => failedResponse(429, {
      error: { code: "TooManyRequests", message: "Request rate limit exceeded." },
    }, header)));

    await expect(new FetchArkHttpClient().post("https://fixture.invalid", {}, {}, signal)).rejects.toMatchObject({
      retryable,
      httpFailure: { retryAfterState: state },
    });
  });

  it.each([
    { code: "insufficient_quota", message: "Insufficient quota.", retryable: false },
    { code: "QuotaExceeded", message: "Per-minute quota exceeded.", retryable: true },
    { code: "RequestQuotaExceeded", message: "Requests per minute quota exceeded.", retryable: true },
    { code: "TPMQuotaExceeded", message: "Token quota exceeded per minute.", retryable: true },
    { code: "RPMLimitExceeded", message: "RPM limit exceeded.", retryable: true },
    { code: "RPMQuotaExhausted", message: "RPM quota exhausted.", retryable: true },
    { code: "account_quota_exhausted", message: "Account quota exhausted.", retryable: false },
    { code: "BillingAccountSuspended", message: "Billing account suspended.", retryable: false },
    { code: "InsufficientBalance", message: "Account balance is insufficient.", retryable: false },
    { code: "invalid_api_key", message: "Invalid API key.", retryable: false },
    { code: "opaque-error", message: "The request failed.", retryable: true },
  ])("distinguishes rate windows from permanent account failures: $code", async (providerError) => {
    vi.stubGlobal("fetch", vi.fn(async () => failedResponse(429, { error: providerError })));
    const error = await new FetchArkHttpClient().post("https://fixture.invalid", {}, {}, signal).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "ARK_HTTP_429", retryable: providerError.retryable, retryMode: providerError.retryable ? "same_input" : "feedback" });
    const serialized = `${String(error)} ${JSON.stringify(error)}`;
    expect(serialized).not.toMatch(/private-token|Authorization|API key|privatecode12345678901234567890/u);
  });
});

describe("other providers keep their HTTP 429 retry semantics", () => {
  it("keeps GLM HTTP 429 retryable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => failedResponse(429, { error: { message: "busy" } })));
    await expect(new FetchGlmHttpClient().post("https://fixture.invalid", {}, {}, signal)).rejects.toMatchObject({
      code: "GLM_HTTP_429", retryable: true, retryMode: "same_input",
    });
  });

  it("keeps official DeepSeek HTTP 429 retryable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => failedResponse(429, { error: { code: "private-code", message: "private body" } })));
    await expect(new FetchDeepseekHttpClient().post("https://fixture.invalid", {}, {}, signal)).rejects.toMatchObject({
      code: "DEEPSEEK_HTTP_429", retryable: true, retryMode: "same_input",
    });
  });
});
