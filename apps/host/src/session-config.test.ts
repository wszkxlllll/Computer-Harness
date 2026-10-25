import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ActionReceipt, ComputerSessionDescriptor, SurfaceId, ToolCallId, Viewport } from "@computer-harness/protocol";
import type { Computer, ModelInput, ProviderAdapter } from "@computer-harness/runtime";
import { DefaultContextCompiler } from "../../../packages/context/src/index.js";
import { ApplicationSession } from "../../../packages/app-runtime/src/application-session.js";
import type { ComputerBackendConfig } from "../../../packages/app-runtime/src/computers.js";
import { InProcessEnvironmentOwner } from "../../../packages/app-runtime/src/environment-owner.js";
import { parseGlmImageMaxEdge, createHostSessionConfig, parseHostRiskGuard, parseHostRiskModel, parseHostRiskMaxModelRequests, parseHostRiskTimeoutMs, resolveHostRunProfileSettings, type HostArguments } from "./session-config.js";

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
  it("requires an explicit valid Host option to disable the layered Guard", () => {
    expect(parseHostRiskGuard(undefined)).toBe("layered");
    expect(parseHostRiskGuard("layered")).toBe("layered");
    expect(parseHostRiskGuard("off")).toBe("off");
    for (const value of ["", "layer", "OFF", "Layered", " off", "off ", "true", "secret-looking-invalid-value"]) {
      expect(() => parseHostRiskGuard(value)).toThrow("--risk-guard must be off or layered.");
    }
  });

  it("keeps risk Guard selection local to Host arguments and preserves the other session boundaries", () => {
    const profile = { profileLabel: "fixture", profileRoot: "fixture-profile" };
    const defaultConfig = createHostSessionConfig(hostArguments, "fixture-output", profile, {
      HARNESS_RISK_GUARD: "off",
    });
    expect(defaultConfig.riskGuard).toBe("layered");
    expect(createHostSessionConfig({ ...hostArguments, riskGuard: "layered" }, "fixture-output", profile, {})).toEqual(defaultConfig);
    for (const riskModel of [undefined, "off"] as const) {
      const config = createHostSessionConfig({
        ...hostArguments,
        riskGuard: "off",
        ...(riskModel === undefined ? {} : { riskModel }),
      }, "fixture-output", profile, {});
      expect(config).toEqual({ ...defaultConfig, riskGuard: "off", riskModel: "off" });
    }
    expect(() => createHostSessionConfig({
      ...hostArguments, riskGuard: "invalid" as NonNullable<HostArguments["riskGuard"]>,
    }, "fixture-output", profile, {})).toThrow("--risk-guard must be off or layered.");
  });

  it("rejects an active semantic risk model when the Host risk Guard is off", () => {
    expect(() => createHostSessionConfig({ ...hostArguments, riskGuard: "off", riskModel: "same" }, "fixture-output", {
      profileLabel: "fixture", profileRoot: "fixture-profile",
    }, {})).toThrow("--risk-model same requires --risk-guard layered; use --risk-model off or omit it when --risk-guard off.");
  });

  it("keeps semantic review opt-in while preserving layered local checks", () => {
    expect(parseHostRiskModel(undefined)).toBe("off");
    expect(parseHostRiskModel("off")).toBe("off");
    expect(parseHostRiskModel("same")).toBe("same");
    expect(createHostSessionConfig({ ...hostArguments, riskModel: "same" }, "fixture-output", {
      profileLabel: "fixture", profileRoot: "fixture-profile",
    }, {})).toMatchObject({ riskGuard: "layered", riskModel: "same" });
    for (const value of ["", "always", "secret-looking-invalid-value"]) {
      expect(() => parseHostRiskModel(value)).toThrow("--risk-model must be off or same.");
    }
  });

  it("bounds an explicit risk deadline while preserving the default and layered fallback", () => {
    expect(parseHostRiskTimeoutMs(undefined)).toBe(15_000);
    for (const value of [1_000, 60_000, 240_000]) {
      expect(parseHostRiskTimeoutMs(String(value))).toBe(value);
      const config = createHostSessionConfig({ ...hostArguments, riskModel: "same", riskTimeoutMs: value, riskMaxModelRequests: 8 }, "unused-output", {
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

  it("keeps the layered local Guard on while disabling semantic risk review by default", () => {
    const config = createHostSessionConfig(hostArguments, "fixture-output", {
      profileLabel: "fixture",
      profileRoot: "fixture-profile",
    }, {});

    expect(config).toMatchObject({
      riskProfile: "live-interactive",
      riskGuard: "layered",
      riskModel: "off",
      riskMaxModelRequests: 1,
    });
  });

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

  it("isolates Ark Agent Plan from official DeepSeek and GLM configuration", () => {
    const config = createHostSessionConfig({ ...hostArguments, model: "deepseek-v4.1-flash" }, "fixture-output", {
      profileLabel: "fixture",
      profileRoot: "fixture-profile",
    }, {
      ARK_API_KEY: "private-ark-fixture-key",
      ARK_BASE_URL: "https://ark.cn-beijing.volces.com/api/plan/v3",
      ARK_REQUEST_TIMEOUT_MS: "180000",
      ARK_MAX_OUTPUT_TOKENS: "8192",
      DEEPSEEK_API_KEY: "private-official-fixture-key",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com",
      DEEPSEEK_REQUEST_TIMEOUT_MS: "invalid",
      DEEPSEEK_MAX_OUTPUT_TOKENS: "invalid",
      GLM_THINKING: "invalid",
      GLM_REQUEST_TIMEOUT_MS: "invalid",
      GLM_MAX_INPUT_TOKENS: "invalid",
      GLM_MAX_WIRE_INPUT_TOKENS: "invalid",
    });
    expect(config).toMatchObject({
      model: "deepseek-v4.1-flash",
      riskModel: "off",
      arkEndpoint: "https://ark.cn-beijing.volces.com/api/plan/v3",
      arkRequestTimeoutMs: 180000,
      arkMaxOutputTokens: 8192,
      contextMaxInputTokens: 16_384,
      contextMaxWireInputTokens: 24_576,
    });
    for (const field of ["arkApiKey", "deepseekApiKey", "deepseekEndpoint", "deepseekRequestTimeoutMs", "deepseekMaxOutputTokens", "glmThinking", "glmRequestTimeoutMs", "qwenCoordinateMode"]) {
      expect(config).not.toHaveProperty(field);
    }
    expect(JSON.stringify(config)).not.toContain("private-ark-fixture-key");
    expect(JSON.stringify(config)).not.toContain("private-official-fixture-key");
  });

  it.each([
    { ARK_REQUEST_TIMEOUT_MS: "241000" },
    { ARK_REQUEST_TIMEOUT_MS: "invalid" },
    { ARK_MAX_OUTPUT_TOKENS: "0" },
    { ARK_MAX_OUTPUT_TOKENS: "131073" },
  ])("rejects invalid Ark request limits only for Ark", (env) => {
    const profile = { profileLabel: "fixture", profileRoot: "fixture-profile" };
    expect(() => createHostSessionConfig({ ...hostArguments, model: "deepseek-v4.1-flash" }, "fixture-output", profile, env)).toThrow();
    const official = createHostSessionConfig({ ...hostArguments, model: "deepseek-flash" }, "fixture-output", profile, env);
    expect(official).not.toHaveProperty("arkRequestTimeoutMs");
    expect(official).not.toHaveProperty("arkMaxOutputTokens");
  });

  it.each(["glm-5.3-flash", "qwen3.8-flash", "deepseek-flash"] as const)("does not forward Ark settings into a %s Host", (model) => {
    const config = createHostSessionConfig({ ...hostArguments, model }, "fixture-output", {
      profileLabel: "fixture",
      profileRoot: "fixture-profile",
    }, {
      ARK_BASE_URL: "https://ark.cn-beijing.volces.com/api/plan/v3",
      ARK_REQUEST_TIMEOUT_MS: "invalid",
      ARK_MAX_OUTPUT_TOKENS: "invalid",
    });
    expect(config.model).toBe(model);
    expect(config).not.toHaveProperty("arkEndpoint");
    expect(config).not.toHaveProperty("arkRequestTimeoutMs");
    expect(config).not.toHaveProperty("arkMaxOutputTokens");
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

  it.each([
    { goal: "Create a new document and save it.", guidanceId: "text_document_save", riskGuard: "layered" },
    {
      goal: "请比较两款商品的官网信息。查询完成后，回到我已经打开并准备好的文本编辑文稿，直接写入中文报告，不需要新建文稿。将报告保存为商品比较报告.txt，通过保存对话框选择本地桌面，不要输入绝对路径。保存后确认文件名和保存位置，保持文稿打开，不必关闭后重新打开。",
      guidanceId: "combined_task_guidance", riskGuard: "off",
    },
    { goal: "不需要新建文稿，保存当前文稿，不必关闭后重新打开。", guidanceId: "text_document_save", riskGuard: "off" },
  ] as const)("passes Host profiles and $guidanceId through the real Run consumers ($riskGuard)", async ({ goal, guidanceId, riskGuard }) => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-host-session-profile-"));
    const sessionConfig = createHostSessionConfig({ ...hostArguments, riskGuard, riskModel: "off" }, outputDir, {
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
      handle = await session.startRun(goal);
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
      expect(selectedGuidance?.id).toBe(guidanceId);
      expect(selectedGuidance?.text).toContain("菜单明确显示快捷键时优先使用");
      expect([...((selectedGuidance?.text) ?? "")].length).toBeLessThanOrEqual(400);
      expect(providerInputs).toHaveLength(1);
      expect(providerInputs[0]?.contextBudget?.trace?.operationGuidance).toMatchObject({ id: guidanceId, included: true });
      const modelText = providerInputs[0]?.messages.flatMap((message) => message.content)
        .filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? "";
      expect(modelText).toContain(selectedGuidance!.text);
      expect(modelText).toContain("Shift-Cmd-S可能Duplicate");
      expect(providerInputs[0]?.system).toContain("a translucent, fading or moving dialog");
      expect(providerInputs[0]?.system).toContain("terminate with the result instead of repeating Save");
      const clickTool = providerInputs[0]?.tools.find((tool) => tool.name === "click");
      expect(clickTool?.description).toContain("choose an interior point near its center");
      expect(clickTool?.description).toContain("Do not reuse a remembered location or nudge a failed point");
      const typeTool = providerInputs[0]?.tools.find((tool) => tool.name === "type");
      if (process.platform === "win32") expect(typeTool?.description).toContain("foreground-caret-v1");
      expect(providerRequestCount).toBe(1);
    } finally {
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it.each([
    { riskGuard: undefined, effect: "unknown" },
    { riskGuard: "layered", effect: "unknown" },
    { riskGuard: "off", effect: "unknown" },
    { riskGuard: "off", effect: "financial" },
    { riskGuard: "off", effect: "external_commitment" },
  ] as const)("applies Host risk Guard $riskGuard to a $effect action through ApplicationSession", async ({ riskGuard, effect }) => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-host-risk-review-off-"));
    const sessionConfig = createHostSessionConfig({
      ...hostArguments,
      ...(riskGuard === undefined ? {} : { riskGuard }),
    }, outputDir, {
      profileLabel: "host-risk-fixture",
      profileRoot: join(outputDir, "profile"),
    }, {});
    const viewport: Viewport = { width: 1, height: 1, coordinateSpace: "physical" };
    const surfaceRef = { surfaceId: "host-risk-desktop" as SurfaceId, generation: 1, kind: "desktop" as const };
    const computerSession: ComputerSessionDescriptor = {
      id: "host-risk-computer-session" as ComputerSessionDescriptor["id"],
      backend: "fixture-cua",
      viewport,
      capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false },
      openedAt: "2026-10-07T00:00:00.000Z",
    };
    const executedActions: Parameters<Computer["execute"]>[1][] = [];
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
      async execute(_session, action) {
        executedActions.push(action);
        return { actionId: action.actionId, status: "completed" } satisfies ActionReceipt;
      },
      async close() {},
    };
    const providerInputs: ModelInput[] = [];
    let providerRequestCount = 0;
    const provider: ProviderAdapter = {
      id: "glm-5.3-flash",
      async generate(input) {
        providerRequestCount += 1;
        providerInputs.push(input);
        if (providerRequestCount > 1) {
          return { type: "finish", summary: "Host risk Guard fixture complete.", reportedStatus: "success" };
        }
        return {
          type: "tool_calls",
          calls: [{
            id: "host-risk-unclear-action" as ToolCallId,
            name: "click",
            arguments: { x: 0, y: 0 },
            declaredEffect: { effects: [effect], target: "Fixture button", summary: "Click the fixture button" },
          }],
        };
      },
    };
    const session = new ApplicationSession({
      config: sessionConfig,
      owner: new InProcessEnvironmentOwner(),
      dependencies: {
        createProvider: () => provider,
        createComputer: async () => computer,
      },
    });
    try {
      const handle = await session.startRun("Check the Host default risk review boundary.");
      if (riskGuard === "off") {
        await waitForRunFinish(handle);
        await session.waitUntilIdleAfterTerminal();
        expect(handle.config).toMatchObject({ riskGuard: "off", riskModel: "off" });
        expect(executedActions).toHaveLength(1);
        expect(executedActions[0]).toMatchObject({ kind: "click", point: { x: 0, y: 0 } });
        expect(providerRequestCount).toBe(2);
        expect(providerInputs).toHaveLength(2);
        expect(handle.controller.getSnapshot().riskModelRequestCount).toBe(0);
        expect(handle.controller.getSnapshot().pendingApproval).toBeUndefined();
        const events = handle.controller.getEvents();
        expect(events.some((event) => event.type === "action.guard.evaluated" || event.type === "approval.requested")).toBe(false);
        expect((await handle.report()).summary).toMatchObject({ riskGuard: "off", riskModel: "off" });
        return;
      }

      await waitForRunApproval(handle);
      const guardEvent = handle.controller.getEvents().find((event) => event.type === "action.guard.evaluated");
      expect(sessionConfig).toMatchObject({ riskGuard: "layered", riskModel: "off" });
      expect(executedActions).toHaveLength(0);
      expect(providerInputs).toHaveLength(1);
      expect(providerRequestCount).toBe(1);
      expect(handle.controller.getSnapshot().riskModelRequestCount).toBe(0);
      expect(guardEvent).toMatchObject({
        type: "action.guard.evaluated",
        decision: "require_approval",
        path: "fallback",
        reasonCode: "semantic_review_unavailable",
        modelRequestCount: 0,
      });
      expect(handle.controller.getSnapshot().status).toBe("waiting_approval");
      expect(handle.controller.getSnapshot().pendingApproval).toBeDefined();
      expect(providerInputs[0]?.tools.find((tool) => tool.name === "click")?.inputSchema.required).toContain("_harnessEffect");
    } finally {
      session.activeRun?.controller.cancel("Host risk-review regression cleanup");
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

async function waitForRunApproval(handle: Awaited<ReturnType<ApplicationSession["startRun"]>>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (handle.controller.getSnapshot().status !== "waiting_approval") {
    if (Date.now() >= deadline) {
      const snapshot = handle.controller.getSnapshot();
      const eventTypes = handle.controller.getEvents().map((event) => event.type).join(", ");
      throw new Error(`fixture ApplicationSession Run did not request approval within five seconds (status=${snapshot.status}; events=${eventTypes})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}


describe("GLM full-frame presentation opt-in", () => {
  it("keeps the default unchanged and accepts an explicit bounded size", () => {
    expect(parseGlmImageMaxEdge(undefined)).toBeUndefined();
    expect(parseGlmImageMaxEdge("1600")).toBe(1600);
    expect(createHostSessionConfig(hostArguments, "unused-output", { profileLabel: "default", profileRoot: "fixture" }, {}).glmImageMaxEdge).toBeUndefined();
    expect(createHostSessionConfig(hostArguments, "unused-output", { profileLabel: "default", profileRoot: "fixture" }, { GLM_IMAGE_MAX_EDGE: "1600" }).glmImageMaxEdge).toBe(1600);
  });
  it.each(["", "NaN", "0", "319", "4097", "1600.5"])("rejects invalid presentation size %s", (value) => {
    expect(() => parseGlmImageMaxEdge(value)).toThrow(/GLM_IMAGE_MAX_EDGE/u);
  });
});
