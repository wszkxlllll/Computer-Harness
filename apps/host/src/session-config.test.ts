import { describe, expect, it } from "vitest";
import { createHostSessionConfig, resolveHostRunProfileSettings, type HostArguments } from "./session-config.js";

const hostArguments: HostArguments = {
  envFile: "fixture.env",
  socket: "explicit-candidate-socket",
  model: "glm-5.3-flash",
  output: "unused-output",
  port: 4317,
  origins: ["http://localhost:4317"],
  maxSteps: 4,
  maxModelRequests: 4,
  glmMaxOutputTokens: 8192,
};

describe("Host-local Run profile configuration", () => {

  it("isolates DeepSeek settings from GLM thinking and budgets without exposing the private key", () => {
    const config = createHostSessionConfig({ ...hostArguments, model: "deepseek-flash" }, "fixture-output", {
      profileLabel: "fixture",
      profileRoot: "fixture-profile",
    }, {
      DEEPSEEK_API_KEY: "private-fixture-key",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com/chat/completions",
      DEEPSEEK_REQUEST_TIMEOUT_MS: "180000",
      DEEPSEEK_MAX_OUTPUT_TOKENS: "8192",
      GLM_THINKING: "invalid",
      GLM_REQUEST_TIMEOUT_MS: "invalid",
      GLM_MAX_INPUT_TOKENS: "invalid",
    });
    expect(config).toMatchObject({
      model: "deepseek-flash",
      deepseekEndpoint: "https://api.deepseek.com/chat/completions",
      deepseekRequestTimeoutMs: 180000,
      deepseekMaxOutputTokens: 8192,
    });
    expect(JSON.stringify(config)).not.toContain("private-fixture-key");
  });

  it.each([
    { DEEPSEEK_REQUEST_TIMEOUT_MS: "241000" },
    { DEEPSEEK_REQUEST_TIMEOUT_MS: "invalid" },
    { DEEPSEEK_MAX_OUTPUT_TOKENS: "0" },
    { DEEPSEEK_MAX_OUTPUT_TOKENS: "131073" },
  ])("rejects invalid DeepSeek request limits", (env) => {
    expect(() => createHostSessionConfig({ ...hostArguments, model: "deepseek-flash" }, "fixture-output", {
      profileLabel: "fixture",
      profileRoot: "fixture-profile",
    }, env)).toThrow();
  });

  it("keeps both local profiles off by default and accepts only their enums", () => {
    expect(resolveHostRunProfileSettings({})).toEqual({});
    expect(resolveHostRunProfileSettings({
      HARNESS_MULTILINE_TYPE_PROFILE: "off",
      HARNESS_OPERATION_GUIDANCE: "off",
    })).toEqual({});
    expect(resolveHostRunProfileSettings({
      HARNESS_MULTILINE_TYPE_PROFILE: "foreground-caret-v1",
      HARNESS_OPERATION_GUIDANCE: "catalog-v1",
    })).toEqual({ multilineTypeProfile: "foreground-caret-v1", operationGuidance: "catalog-v1" });

    for (const value of ["true", "foreground-caret-v2", "secret-looking-invalid-value"]) {
      let message = "";
      try {
        resolveHostRunProfileSettings({ HARNESS_MULTILINE_TYPE_PROFILE: value });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("HARNESS_MULTILINE_TYPE_PROFILE must be off or foreground-caret-v1");
      expect(message).not.toContain(value);
    }
    for (const value of ["true", "catalog-v2", "secret-looking-invalid-value"]) {
      let message = "";
      try {
        resolveHostRunProfileSettings({ HARNESS_OPERATION_GUIDANCE: value });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("HARNESS_OPERATION_GUIDANCE must be off or catalog-v1");
      expect(message).not.toContain(value);
    }
  });

});
