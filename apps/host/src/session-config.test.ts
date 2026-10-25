import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ActionReceipt, ComputerSessionDescriptor, SurfaceId, Viewport } from "@computer-harness/protocol";
import type { Computer, ModelInput, ProviderAdapter } from "@computer-harness/runtime";
import { DefaultContextCompiler } from "../../../packages/context/src/index.js";
import { ApplicationSession } from "../../../packages/app-runtime/src/application-session.js";
import type { ComputerBackendConfig } from "../../../packages/app-runtime/src/computers.js";
import { InProcessEnvironmentOwner } from "../../../packages/app-runtime/src/environment-owner.js";
import { createHostSessionConfig, parseHostRiskMaxModelRequests, parseHostRiskTimeoutMs, resolveHostRunProfileSettings, type HostArguments } from "./session-config.js";

const hostArguments: HostArguments = {
  envFile: "fixture.env",
  socket: "explicit-candidate-socket",
  model: "glm-5.3-flash",
  output: "unused-output",
  port: 4317,
  origins: ["http://localhost:4317"],
  maxSteps: 4,
  maxModelRequests: 4,
  riskMaxModelRequests: 1,
  glmMaxOutputTokens: 8192,
};

describe("Host-local Run profile configuration", () => {
  it("bounds an explicit risk deadline while preserving the default and layered fallback", () => {
    expect(parseHostRiskTimeoutMs(undefined)).toBe(15_000);
    for (const value of [1_000, 60_000, 240_000]) {
      expect(parseHostRiskTimeoutMs(String(value))).toBe(value);
      const config = createHostSessionConfig({ ...hostArguments, riskTimeoutMs: value, riskMaxModelRequests: 8 }, "unused-output", {
        profileLabel: "risk-timeout-fixture", profileRoot: "risk-timeout-fixture-profile",
      }, {});
      expect(config).toMatchObject({ riskTimeoutMs: value, riskGuard: "layered", riskModel: "same", riskMaxModelRequests: 8 });
    }
    const defaultConfig = createHostSessionConfig(hostArguments, "unused-output", { profileLabel: "default", profileRoot: "fixture" }, {});
    expect(defaultConfig.riskTimeoutMs).toBe(15_000);
    for (const value of ["", "0", "999", "240001", "1.5", "NaN", "Infinity"]) {
      expect(() => parseHostRiskTimeoutMs(value)).toThrow(/--risk-timeout-ms must be an integer/u);
    }
    expect(() => createHostSessionConfig({ ...hostArguments, riskTimeoutMs: 0 }, "unused-output", {
      profileLabel: "invalid", profileRoot: "fixture",
    }, {})).toThrow(/--risk-timeout-ms/u);
  });

  it("defaults the explicit risk review bound to one and accepts only integer values from one through twelve", () => {
    expect(parseHostRiskMaxModelRequests(undefined)).toBe(1);
    expect(parseHostRiskMaxModelRequests("8")).toBe(8);
    expect(parseHostRiskMaxModelRequests("12")).toBe(12);
    for (const value of ["0", "13", "-1", "1.5", "NaN", "", "900000"]) {
      expect(() => parseHostRiskMaxModelRequests(value)).toThrow(/--risk-max-model-requests must be an integer from 1 to 12/u);
    }
  });

  it("passes the CLI risk review bound into layered Host session config without changing the main request bound", () => {
    for (const riskMaxModelRequests of [1, 8, 12]) {
      const config = createHostSessionConfig({ ...hostArguments, maxModelRequests: 40, riskMaxModelRequests }, "unused-output", {
        profileLabel: "risk-limit-fixture",
        profileRoot: "risk-limit-fixture-profile",
      }, {});
      expect(config.riskGuard).toBe("layered");
      expect(config.riskMaxModelRequests).toBe(riskMaxModelRequests);
      expect(config.maxModelRequests).toBe(40);
    }
  });

  it("keeps legacy programmatic HostArguments without the new optional field at the default of one", () => {
    const { riskMaxModelRequests: _riskMaxModelRequests, ...legacyHostArguments } = hostArguments;
    void _riskMaxModelRequests;
    const config = createHostSessionConfig(legacyHostArguments, "unused-output", {
      profileLabel: "legacy-risk-limit-fixture",
      profileRoot: "legacy-risk-limit-fixture-profile",
    }, {});
    expect(config.riskMaxModelRequests).toBe(1);
    expect(config.riskGuard).toBe("layered");
  });

  it("keeps both local profiles off by default and accepts only their enums", () => {
    expect(resolveHostRunProfileSettings({})).toEqual({ providerRecovery: "off", providerRecoveryRunWindowMs: 900_000 });
    expect(resolveHostRunProfileSettings({
      HARNESS_MULTILINE_TYPE_PROFILE: "off",
      HARNESS_OPERATION_GUIDANCE: "off",
    })).toEqual({ providerRecovery: "off", providerRecoveryRunWindowMs: 900_000 });
    expect(resolveHostRunProfileSettings({
      HARNESS_MULTILINE_TYPE_PROFILE: "foreground-caret-v1",
      HARNESS_OPERATION_GUIDANCE: "catalog-v1",
    })).toEqual({ multilineTypeProfile: "foreground-caret-v1", operationGuidance: "catalog-v1", providerRecovery: "off", providerRecoveryRunWindowMs: 900_000 });
    expect(resolveHostRunProfileSettings({
      HARNESS_PROVIDER_RECOVERY: "ambiguous-headers-once-v1",
      HARNESS_PROVIDER_RECOVERY_RUN_WINDOW_MS: "900000",
    })).toMatchObject({ providerRecovery: "ambiguous-headers-once-v1", providerRecoveryRunWindowMs: 900_000 });

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
    expect(() => resolveHostRunProfileSettings({ HARNESS_PROVIDER_RECOVERY: "always" })).toThrow(/HARNESS_PROVIDER_RECOVERY must be/u);
    for (const value of ["NaN", "900001", "0", "1.5"]) {
      expect(() => resolveHostRunProfileSettings({ HARNESS_PROVIDER_RECOVERY_RUN_WINDOW_MS: value })).toThrow(/RUN_WINDOW_MS must be/u);
    }
  });

  it("passes explicit Host env profiles through ApplicationSession and the real Run consumers", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-host-session-profile-"));
    const sessionConfig = createHostSessionConfig(hostArguments, outputDir, {
      profileLabel: "host-profile-fixture",
      profileRoot: join(outputDir, "profile"),
    }, {
      HARNESS_MULTILINE_TYPE_PROFILE: "foreground-caret-v1",
      HARNESS_OPERATION_GUIDANCE: "catalog-v1",
      HARNESS_PROVIDER_RECOVERY: "ambiguous-headers-once-v1",
      HARNESS_PROVIDER_RECOVERY_RUN_WINDOW_MS: "900000",
    });
    const viewport: Viewport = { width: 1, height: 1, coordinateSpace: "physical" };
    const surfaceRef = { surfaceId: "host-profile-desktop" as SurfaceId, generation: 1, kind: "desktop" as const };
    const computerSession: ComputerSessionDescriptor = {
      id: "host-profile-computer-session" as ComputerSessionDescriptor["id"],
      backend: "fixture-cua",
      viewport,
      capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false },
      openedAt: "2026-10-07T00:00:00.000Z",
    };
    const computer: Computer = {
      async open() { return computerSession; },
      async observe() {
        return {
          capturedAt: "2026-10-07T00:00:01.000Z",
          viewport,
          surfaceRef,
          screenshot: {
            mediaType: "image/png",
            data: new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp6kAAAAASUVORK5CYII=", "base64")),
          },
        };
      },
      async execute(_session, action) { return { actionId: action.actionId, status: "completed" } satisfies ActionReceipt; },
      async close() {},
    };
    const providerInputs: ModelInput[] = [];
    let providerRequestCount = 0;
    let receivedComputerConfig: ComputerBackendConfig | undefined;
    let selectedGuidance: { id: string; text: string } | undefined;
    const provider: ProviderAdapter = {
      id: "glm-5.3-flash",
      async generate(input) {
        providerRequestCount += 1;
        providerInputs.push(input);
        return { type: "finish", summary: "Host config fixture complete.", reportedStatus: "success" };
      },
    };
    const session = new ApplicationSession({
      config: sessionConfig,
      owner: new InProcessEnvironmentOwner(),
      dependencies: {
        createProvider: () => provider,
        createComputer: async ({ config }) => {
          receivedComputerConfig = config;
          return computer;
        },
        createContextCompiler: (tools, features) => {
          const compiler = new DefaultContextCompiler(tools, { features });
          return {
            async compile(input, signal) {
              selectedGuidance = input.operationGuidance;
              return compiler.compile(input, signal);
            },
          };
        },
      },
    });
    let handle: Awaited<ReturnType<typeof session.startRun>> | undefined;
    try {
      handle = await session.startRun("Create a new document and save it.");
      await waitForRunFinish(handle);
      await session.waitUntilIdleAfterTerminal();
      const report = await handle.report();

      expect(sessionConfig.providerRecovery).toBe("ambiguous-headers-once-v1");
      expect(sessionConfig.providerRecoveryRunWindowMs).toBe(900_000);
      expect(handle.config.providerRecovery).toBe("ambiguous-headers-once-v1");
      expect(handle.config.providerRecoveryRunWindowMs).toBe(900_000);
      expect(handle.controller.getEvents().at(-1)).toMatchObject({
        type: "run.finished",
        providerRecoveryState: { mode: "ambiguous-headers-once-v1", runWindowMs: 900_000, latchConsumed: false, attemptStarted: false, remoteOutcomeUnknown: false },
      });
      expect(report.summary).toMatchObject({
        providerRecovery: "ambiguous-headers-once-v1",
        providerRecoveryRunWindowMs: 900_000,
        providerRecoveryState: { latchConsumed: false, attemptStarted: false, remoteOutcomeUnknown: false },
      });
      expect(sessionConfig.computer.kind).toBe("cua");
      expect(sessionConfig.computer.kind === "cua" ? sessionConfig.computer.multilineTypeProfile : undefined).toBe("foreground-caret-v1");
      expect(sessionConfig.operationGuidance).toBe("catalog-v1");
      expect(receivedComputerConfig?.kind).toBe("cua");
      expect(receivedComputerConfig?.kind === "cua" ? receivedComputerConfig.multilineTypeProfile : undefined).toBe("foreground-caret-v1");
      expect(selectedGuidance?.id).toBe("text_document_save");
      expect(selectedGuidance?.text).toContain("菜单明确显示快捷键时优先使用");
      expect([...((selectedGuidance?.text) ?? "")].length).toBeLessThanOrEqual(400);
      expect(providerInputs).toHaveLength(1);
      expect(providerInputs[0]?.contextBudget?.trace?.operationGuidance).toMatchObject({ id: "text_document_save", included: true });
      const typeTool = providerInputs[0]?.tools.find((tool) => tool.name === "type");
      if (process.platform === "win32") expect(typeTool?.description).toContain("foreground-caret-v1");
      expect(providerRequestCount).toBe(1);
    } finally {
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});

async function waitForRunFinish(handle: Awaited<ReturnType<ApplicationSession["startRun"]>>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (handle.controller.getSnapshot().status !== "finished") {
    if (Date.now() >= deadline) throw new Error("fixture ApplicationSession Run did not finish within five seconds");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
