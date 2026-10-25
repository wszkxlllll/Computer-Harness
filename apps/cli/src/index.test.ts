import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRun } from "@computer-harness/app-runtime";
import type { ComputerFactoryDependencies } from "@computer-harness/app-runtime";
import type { Computer, ModelInput } from "@computer-harness/runtime";
import type { ComputerSessionDescriptor, SurfaceRef, Viewport } from "@computer-harness/protocol";
import { parseArgs, toResolvedRunConfig } from "./index.js";
import { createRunSupervisionControl, type RunSupervisionControlSource } from "./run-supervision-control.js";

type CuaComputerModule = Awaited<ReturnType<NonNullable<ComputerFactoryDependencies["importCuaComputer"]>>>;
type CuaDriverComputerOptions = ConstructorParameters<CuaComputerModule["CuaDriverComputer"]>[0];

afterEach(() => vi.unstubAllEnvs());

function multilineProfileFixtureComputer(): Computer {
  const viewport: Viewport = { width: 1, height: 1, coordinateSpace: "physical" };
  const session: ComputerSessionDescriptor = {
    id: "cli-multiline-profile-session" as ComputerSessionDescriptor["id"],
    backend: "fixture",
    viewport,
    capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false },
    openedAt: "2026-10-15T00:00:00.000Z",
  };
  const surfaceRef: SurfaceRef = { surfaceId: "cli-multiline-profile-surface" as SurfaceRef["surfaceId"], generation: 1, kind: "desktop" };
  return {
    async open() { return session; },
    async observe() {
      return {
        capturedAt: "2026-10-15T00:00:00.000Z",
        viewport,
        surfaceRef,
        screenshot: { mediaType: "image/png", data: new Uint8Array([1, 2, 3]) },
      };
    },
    async execute(_session, action) { return { actionId: action.actionId, status: "completed" }; },
    async close() {},
  };
}

describe("CLI multiline type profile configuration", () => {
  const baseArgs = ["--goal", "Inspect the fixture", "--model", "glm-5.3-flash", "--computer", "cua", "--cua-socket", "fixture.sock"];

  it("defaults off, validates explicit profiles, and rejects CUA-only configuration for OSWorld", () => {
    const defaults = parseArgs(baseArgs);
    const explicitOff = parseArgs([...baseArgs, "--multiline-type-profile", "off"]);
    const foregroundCaret = parseArgs([...baseArgs, "--multiline-type-profile", "foreground-caret-v1"]);
    expect(defaults.multilineTypeProfile).toBe("off");
    expect(explicitOff.multilineTypeProfile).toBe("off");
    expect(foregroundCaret.multilineTypeProfile).toBe("foreground-caret-v1");
    expect(toResolvedRunConfig(defaults, defaults.goal!).computer).not.toHaveProperty("multilineTypeProfile");
    expect(toResolvedRunConfig(explicitOff, explicitOff.goal!).computer).not.toHaveProperty("multilineTypeProfile");
    expect(toResolvedRunConfig(foregroundCaret, foregroundCaret.goal!).computer).toMatchObject({
      kind: "cua",
      multilineTypeProfile: "foreground-caret-v1",
    });
    expect(() => parseArgs([...baseArgs, "--multiline-type-profile", "unknown"])).toThrow(/must be off or foreground-caret-v1/u);
    expect(() => parseArgs([
      "--goal", "Inspect the fixture", "--model", "glm-5.3-flash", "--computer", "osworld", "--osworld-bridge", "http://fixture.invalid",
      "--multiline-type-profile", "foreground-caret-v1",
    ])).toThrow(/only with --computer cua/u);
    expect(() => parseArgs(["--doctor", "--computer", "cua", "--cua-socket", "fixture.sock", "--multiline-type-profile", "off"]))
      .toThrow(/only for a Run or TUI session/u);
  });

  it("carries the CLI opt-in through createRun to its Computer factory and Provider type description", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-cli-multiline-profile-"));
    const options = parseArgs([...baseArgs, "--output", outputDir, "--multiline-type-profile", "foreground-caret-v1"]);
    const config = toResolvedRunConfig(options, options.goal!);
    const modelInputs: ModelInput[] = [];
    const provider = {
      id: "cli-multiline-profile-provider",
      async generate(input: ModelInput) {
        modelInputs.push(input);
        return { type: "finish" as const, summary: "fixture complete" };
      },
    };
    let receivedAdapterOptions: CuaDriverComputerOptions | undefined;
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    if (platformDescriptor === undefined || platformDescriptor.configurable !== true) {
      await rm(outputDir, { recursive: true, force: true });
      throw new Error("test runtime does not allow restoring a temporary process.platform override");
    }

    try {
      Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
      const fixtureComputer = multilineProfileFixtureComputer();
      class CapturingCuaDriverComputer implements Computer {
        public constructor(options: CuaDriverComputerOptions) { receivedAdapterOptions = options; }
        public open(...args: Parameters<Computer["open"]>) { return fixtureComputer.open(...args); }
        public observe(...args: Parameters<Computer["observe"]>) { return fixtureComputer.observe(...args); }
        public execute(...args: Parameters<Computer["execute"]>) { return fixtureComputer.execute(...args); }
        public close(...args: Parameters<Computer["close"]>) { return fixtureComputer.close(...args); }
      }
      const handle = await createRun(config, {
        createProvider: () => provider,
        computerFactoryDependencies: {
          windowRelationshipProbe: null,
          importCuaComputer: async () => ({ CuaDriverComputer: CapturingCuaDriverComputer }),
        },
      });
      await expect(handle.start()).resolves.toBe("succeeded");
      expect(receivedAdapterOptions).toMatchObject({ socketPath: "fixture.sock", multilineTypeProfile: "foreground-caret-v1" });
      const typeTool = modelInputs[0]?.tools.find((tool) => tool.name === "type");
      expect(typeTool?.description).toContain("foreground-caret-v1");
      expect(typeTool?.description).toContain("intended to insert at the current caret or replace the current selection");
      await handle.close();
    } finally {
      Object.defineProperty(process, "platform", platformDescriptor);
      expect(process.platform).toBe(platformDescriptor.value);
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});

describe("CLI window-switch configuration", () => {
  it("keeps the source-linked contract opt-in and validates an explicit bounded JSON contract", () => {
    const baseArgs = ["--goal", "Inspect the fixture", "--model", "glm-5.3-flash", "--computer", "cua", "--cua-socket", "fixture.sock"];
    const contract = { version: "source-linked-finish-v1", fields: [{ fieldId: "cpu", label: "CPU model", required: true }] };
    const ordinary = toResolvedRunConfig(parseArgs(baseArgs), "Inspect the fixture");
    const optedIn = toResolvedRunConfig(parseArgs([...baseArgs, "--source-linked-finish-contract", JSON.stringify(contract)]), "Inspect the fixture");
    expect(ordinary).not.toHaveProperty("sourceLinkedFinish");
    expect(optedIn.sourceLinkedFinish).toEqual(contract);
    expect(() => parseArgs([...baseArgs, "--source-linked-finish-contract", "{"])).toThrow(/valid JSON/u);
    expect(() => parseArgs([...baseArgs, "--source-linked-finish-contract", JSON.stringify({
      ...contract,
      fields: [{ ...contract.fields[0], answer: "M6" }],
    })])).toThrow(/invalid or duplicate field/u);
  });

  it("keeps desktop runs opt-in while allowing the switch flag without a bound window", () => {
    const baseArgs = ["--goal", "Inspect the open task", "--model", "glm-5.3-flash", "--computer", "cua", "--cua-socket", "fixture.sock"];
    const defaultOptions = parseArgs(baseArgs);
    const optedInOptions = parseArgs([...baseArgs, "--window-switch"]);

    expect(defaultOptions.windowSwitch).toBe(false);
    expect(optedInOptions.windowSwitch).toBe(true);
    const defaultConfig = toResolvedRunConfig(defaultOptions, "Inspect the open task");
    const optedInConfig = toResolvedRunConfig(optedInOptions, "Inspect the open task");
    expect(defaultConfig.windowSwitch).toBe("off");
    expect(optedInConfig.windowSwitch).toBe("opened-windows-v1");
    expect(optedInConfig.computer).not.toHaveProperty("windowTarget");
    expect(optedInConfig.computer).not.toHaveProperty("managedBrowserUrl");
  });

  it("passes the exact recovery target pair through the explicit native recovery opt-in", () => {
    const baseArgs = [
      "--goal", "Inspect the task after its window closes",
      "--model", "glm-5.3-flash",
      "--computer", "cua",
      "--cua-socket", "fixture.sock",
      "--window-switch",
      "--recover-bound-window-missing",
      "--cua-window-pid", "42", "--cua-window-id", "84",
      "--cua-recovery-window-pid", "43", "--cua-recovery-window-id", "85",
    ];

    const options = parseArgs(baseArgs);
    const config = toResolvedRunConfig(options, "Inspect the task after its window closes");

    expect(options.recoverBoundWindowMissing).toBe(true);
    expect(options.cuaWindowTarget).toEqual({ pid: 42, windowId: 84 });
    expect(options.cuaRecoveryWindowTarget).toEqual({ pid: 43, windowId: 85 });
    expect(config.windowSwitch).toBe("opened-windows-v1");
    expect(config.computer).toMatchObject({
      kind: "cua",
      recoverBoundWindowMissing: true,
      windowTarget: { pid: 42, windowId: 84 },
      recoveryWindowTarget: { pid: 43, windowId: 85 },
      windowSwitchAllowedTargets: [{ pid: 42, windowId: 84 }, { pid: 43, windowId: 85 }],
    });
  });

  it("grants one absolute saved-document path only with the exact native recovery scope", () => {
    const baseArgs = [
      "--goal", "Inspect the task after its saved document closes",
      "--model", "glm-5.3-flash",
      "--computer", "cua",
      "--cua-socket", "fixture.sock",
      "--window-switch",
      "--recover-bound-window-missing",
      "--cua-window-pid", "42", "--cua-window-id", "84",
      "--cua-recovery-window-pid", "43", "--cua-recovery-window-id", "85",
    ];
    const options = parseArgs([...baseArgs, "--grounding", "uia-catalog-v1", "--reopen-saved-document", "/tmp/one-run-output.txt"]);
    const config = toResolvedRunConfig(options, options.goal!);

    expect(config.computer).toMatchObject({
      kind: "cua",
      grounding: "uia-catalog-v1",
      reopenSavedDocumentGrant: {
        path: "/tmp/one-run-output.txt",
        expectedExecutableUrl: "file:///System/Applications/TextEdit.app/Contents/MacOS/TextEdit",
      },
    });
    expect(() => parseArgs([
      "--goal", "Inspect the task", "--model", "glm-5.3-flash", "--computer", "cua", "--cua-socket", "fixture.sock",
      "--reopen-saved-document", "/tmp/one-run-output.txt",
    ])).toThrow(/recovery|window-switch/u);
    expect(() => parseArgs([...baseArgs, "--reopen-saved-document", "relative/output.txt"])).toThrow(/absolute file path/u);
  });

  it("keeps hybrid saved-document recovery as an explicit direct-Run experiment", () => {
    const args = [
      "--goal", "Research the page and reopen the saved document",
      "--model", "glm-5.3-flash",
      "--computer", "cua",
      "--cua-socket", "fixture.sock",
      "--window-switch",
      "--recover-bound-window-missing",
      "--cua-window-pid", "42", "--cua-window-id", "84",
      "--cua-recovery-window-pid", "43", "--cua-recovery-window-id", "85",
      "--reopen-saved-document", "/tmp/one-run-output.txt",
      "--grounding", "hybrid-catalog-v1",
      "--managed-browser-url", "https://example.test/research",
    ];
    const options = parseArgs(args);
    const config = toResolvedRunConfig(options, options.goal!);
    expect(config.windowSwitch).toBe("opened-windows-v1");
    expect(config.computer).toMatchObject({
      kind: "cua",
      grounding: "hybrid-catalog-v1",
      managedBrowserCompanion: true,
      managedBrowserUrl: "https://example.test/research",
      managedBrowserProfileMode: "ephemeral",
      windowTarget: { pid: 42, windowId: 84 },
      recoveryWindowTarget: { pid: 43, windowId: 85 },
      windowSwitchAllowedTargets: [{ pid: 42, windowId: 84 }, { pid: 43, windowId: 85 }],
      recoverBoundWindowMissing: true,
      hybridNativeWebDocumentTargets: {
        primaryTarget: { pid: 42, windowId: 84 },
        recoveryTarget: { pid: 43, windowId: 85 },
      },
      reopenSavedDocumentGrant: { path: "/tmp/one-run-output.txt" },
    });

    expect(() => parseArgs(args.filter((value, index) => !(value === "--managed-browser-url" || args[index - 1] === "--managed-browser-url"))))
      .toThrow(/explicit URL|hybrid grounding/u);
    expect(() => parseArgs([...args, "--managed-browser-profile-mode", "persistent", "--managed-browser-profile-label", "Travel"]))
      .toThrow(/ephemeral/u);
    expect(() => parseArgs([...args, "--tui"]))
      .toThrow(/direct CUA Run|hybrid/u);
  });

  it("assembles the real CLI recovery config with the effective native window-switch setting", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-cli-recovery-assembly-"));
    const options = parseArgs([
      "--goal", "Inspect the task after its window closes",
      "--model", "glm-5.3-flash",
      "--computer", "cua",
      "--cua-socket", "fixture.sock",
      "--output", outputDir,
      "--window-switch",
      "--recover-bound-window-missing",
      "--cua-window-pid", "42", "--cua-window-id", "84",
      "--cua-recovery-window-pid", "43", "--cua-recovery-window-id", "85",
    ]);
    const config = toResolvedRunConfig(options, options.goal!);
    expect(config.computer).not.toHaveProperty("windowSwitch");

    let effectiveComputerConfig: unknown;
    const computer: Computer = {
      async open() { throw new Error("assembly test must not open a computer session"); },
      async observe() { throw new Error("assembly test must not observe"); },
      async execute() { throw new Error("assembly test must not execute"); },
      async close() {},
      async listWindows() { return { options: [], truncated: false, omittedCount: 0 }; },
    };
    const provider = {
      id: "fixture-provider",
      async generate() { throw new Error("assembly test must not generate a model turn"); },
    };
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    if (platformDescriptor === undefined || platformDescriptor.configurable !== true) {
      await rm(outputDir, { recursive: true, force: true });
      throw new Error("test runtime does not allow restoring a temporary process.platform override");
    }

    try {
      Object.defineProperty(process, "platform", { ...platformDescriptor, value: "darwin" });
      const handle = await createRun(config, {
        createProvider: async () => provider,
        createComputer: async ({ config: computerConfig }) => {
          effectiveComputerConfig = computerConfig;
          return computer;
        },
      });
      expect(effectiveComputerConfig).toMatchObject({
        kind: "cua",
        windowSwitch: "opened-windows-v1",
        windowDeliveryMode: "foreground",
        recoverBoundWindowMissing: true,
        windowTarget: { pid: 42, windowId: 84 },
        recoveryWindowTarget: { pid: 43, windowId: 85 },
        windowSwitchAllowedTargets: [{ pid: 42, windowId: 84 }, { pid: 43, windowId: 85 }],
      });
      await handle.close();
    } finally {
      Object.defineProperty(process, "platform", platformDescriptor);
      expect(process.platform).toBe(platformDescriptor.value);
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["missing recovery target", ["--cua-recovery-window-pid", "43"]],
    ["duplicate exact target", ["--cua-recovery-window-pid", "42", "--cua-recovery-window-id", "84"]],
  ] as const)("rejects recovery configuration with a %s", (_label, recoveryArgs) => {
    expect(() => parseArgs([
      "--goal", "Inspect the task",
      "--model", "glm-5.3-flash",
      "--computer", "cua",
      "--cua-socket", "fixture.sock",
      "--window-switch",
      "--recover-bound-window-missing",
      "--cua-window-pid", "42", "--cua-window-id", "84",
      ...recoveryArgs,
    ])).toThrow(/recovery|distinct|provided together/u);
  });

  it("projects standalone persistent-profile settings locally without a Host API dependency", () => {
    const options = parseArgs([
      "--goal", "Use the prepared browser",
      "--model", "glm-5.3-flash",
      "--computer", "cua",
      "--cua-socket", "fixture.sock",
      "--managed-browser-profile-mode", "persistent",
      "--managed-browser-profile-label", "Travel",
    ]);

    expect(options.managedBrowserProfileMode).toBe("persistent");
    const config = toResolvedRunConfig(options, "Use the prepared browser");
    expect(config.computer).toMatchObject({
      kind: "cua",
      managedBrowserProfileMode: "persistent",
      managedBrowserProfileLabel: "Travel",
    });
    expect((config.computer as { managedBrowserProfileRoot?: string }).managedBrowserProfileRoot).toMatch(/managed-browser-profiles/u);
    expect(config).not.toHaveProperty("hostApi");
  });

  it.each([
    ["native window", ["--cua-window-pid", "42", "--cua-window-id", "84"]],
    ["primary desktop", []],
  ] as const)("enables the managed-browser companion for an opted-in %s Run with local browser settings", (_initialTarget, initialTargetArgs) => {
    const options = parseArgs([
      "--goal", "Inspect the task",
      "--model", "glm-5.3-flash",
      "--computer", "cua",
      "--cua-socket", "fixture.sock",
      "--window-switch",
      "--managed-browser-url", "https://portal.example/start",
      "--managed-browser-profile-mode", "persistent",
      "--managed-browser-profile-label", "Travel",
      ...initialTargetArgs,
    ]);

    const config = toResolvedRunConfig(options, "Inspect the task");
    expect(config.windowSwitch).toBe("opened-windows-v1");
    expect(config.computer).toMatchObject({
      kind: "cua",
      managedBrowserCompanion: true,
      managedBrowserUrl: "https://portal.example/start",
      managedBrowserProfileMode: "persistent",
      managedBrowserProfileLabel: "Travel",
    });
    if (initialTargetArgs.length > 0) expect(config.computer).toHaveProperty("windowTarget", { pid: 42, windowId: 84 });
    else expect(config.computer).not.toHaveProperty("windowTarget");
  });

  it("leaves browser-initial Runs without a companion and does not fabricate one without local URL config", () => {
    const browserInitial = parseArgs([
      "--goal", "Use the managed browser",
      "--model", "glm-5.3-flash",
      "--computer", "cua",
      "--cua-socket", "fixture.sock",
      "--window-switch",
      "--grounding", "hybrid-catalog-v1",
      "--managed-browser-url", "https://portal.example/start",
    ]);
    const browserConfig = toResolvedRunConfig(browserInitial, "Use the managed browser");
    expect(browserConfig.windowSwitch).toBe("opened-windows-v1");
    expect(browserConfig.grounding).toBe("hybrid-catalog-v1");
    expect(browserConfig.computer).not.toHaveProperty("managedBrowserCompanion");

    const noLocalBrowser = parseArgs([
      "--goal", "Inspect the desktop",
      "--model", "glm-5.3-flash",
      "--computer", "cua",
      "--cua-socket", "fixture.sock",
      "--window-switch",
    ]);
    const desktopConfig = toResolvedRunConfig(noLocalBrowser, "Inspect the desktop");
    expect(desktopConfig.windowSwitch).toBe("opened-windows-v1");
    expect(desktopConfig.computer).not.toHaveProperty("managedBrowserCompanion");
  });

  it("rejects window switching for a non-CUA computer", () => {
    expect(() => parseArgs([
      "--goal", "Inspect the desktop",
      "--model", "glm-5.3-flash",
      "--computer", "osworld",
      "--osworld-bridge", "http://fixture.invalid",
      "--window-switch",
    ])).toThrow("--window-switch requires --computer cua");
  });
});

describe("CLI GLM request-timeout configuration", () => {
  const options = parseArgs([
    "--goal", "Inspect the open task",
    "--model", "glm-5.3-flash",
    "--computer", "cua",
    "--cua-socket", "fixture.sock",
  ]);

  it("leaves the runtime default unset when the environment override is absent", () => {
    vi.stubEnv("GLM_REQUEST_TIMEOUT_MS", undefined);
    expect(toResolvedRunConfig(options, "Inspect the open task")).not.toHaveProperty("glmRequestTimeoutMs");
  });

  it("forwards a valid environment override as a number", () => {
    vi.stubEnv("GLM_REQUEST_TIMEOUT_MS", "180000");
    expect(toResolvedRunConfig(options, "Inspect the open task").glmRequestTimeoutMs).toBe(180000);
  });

  it.each(["241000", "not-a-number"])("rejects invalid environment overrides (%s)", (value) => {
    vi.stubEnv("GLM_REQUEST_TIMEOUT_MS", value);
    expect(() => toResolvedRunConfig(options, "Inspect the open task")).toThrow(/request timeout/u);
  });

  it("does not apply a GLM-only override to Qwen runs", () => {
    vi.stubEnv("GLM_REQUEST_TIMEOUT_MS", "not-a-number");
    const qwenOptions = parseArgs([
      "--goal", "Inspect the open task",
      "--model", "qwen3.8-flash",
      "--computer", "cua",
      "--cua-socket", "fixture.sock",
      "--qwen-coordinate-mode", "normalized_1000",
    ]);
    expect(toResolvedRunConfig(qwenOptions, "Inspect the open task")).not.toHaveProperty("glmRequestTimeoutMs");
  });
});

describe("CLI DeepSeek Run configuration", () => {
  const baseArgs = ["--goal", "Inspect the open task", "--model", "deepseek-flash", "--computer", "cua", "--cua-socket", "fixture.sock"];

  it("selects DeepSeek without Qwen calibration and keeps Risk Guard selection explicit", () => {
    const options = parseArgs([...baseArgs, "--risk-guard", "layered", "--risk-model", "deepseek-flash"]);
    const config = toResolvedRunConfig(options, "Inspect the open task");
    expect(config.model).toBe("deepseek-flash");
    expect(config.riskModel).toBe("deepseek-flash");
    expect(config).not.toHaveProperty("qwenCoordinateMode");
    expect(config).not.toHaveProperty("qwenThinking");
    expect(() => parseArgs([...baseArgs, "--qwen-coordinate-mode", "actual_pixels"])).toThrow(/only valid with a Qwen model/u);
  });

  it("keeps private credentials out of configuration and forwards only provider overrides", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "private-fixture-key");
    vi.stubEnv("DEEPSEEK_BASE_URL", "https://api.deepseek.com/chat/completions");
    vi.stubEnv("DEEPSEEK_REQUEST_TIMEOUT_MS", "180000");
    vi.stubEnv("DEEPSEEK_MAX_OUTPUT_TOKENS", "8192");
    vi.stubEnv("GLM_REQUEST_TIMEOUT_MS", "not-a-number");
    const config = toResolvedRunConfig(parseArgs(baseArgs), "Inspect the open task");
    expect(config).toMatchObject({
      deepseekEndpoint: "https://api.deepseek.com/chat/completions",
      deepseekRequestTimeoutMs: 180000,
      deepseekMaxOutputTokens: 8192,
    });
    expect(config).not.toHaveProperty("glmRequestTimeoutMs");
    expect(JSON.stringify(config)).not.toContain("private-fixture-key");
  });

  it.each([
    ["DEEPSEEK_REQUEST_TIMEOUT_MS", "241000"],
    ["DEEPSEEK_REQUEST_TIMEOUT_MS", "not-a-number"],
    ["DEEPSEEK_MAX_OUTPUT_TOKENS", "0"],
    ["DEEPSEEK_MAX_OUTPUT_TOKENS", "131073"],
  ])("rejects invalid %s overrides", (name, value) => {
    vi.stubEnv(name, value);
    expect(() => toResolvedRunConfig(parseArgs(baseArgs), "Inspect the open task")).toThrow();
  });

  it("does not apply DeepSeek-only overrides to a GLM Run unless Risk Guard selects DeepSeek", () => {
    vi.stubEnv("DEEPSEEK_REQUEST_TIMEOUT_MS", "not-a-number");
    const glmArgs = [...baseArgs];
    glmArgs[3] = "glm-5.3-flash";
    expect(toResolvedRunConfig(parseArgs(glmArgs), "Inspect the open task")).not.toHaveProperty("deepseekRequestTimeoutMs");
    expect(() => toResolvedRunConfig(parseArgs([...glmArgs, "--risk-guard", "layered", "--risk-model", "deepseek-flash"]), "Inspect the open task")).toThrow();
  });
});

describe("CLI Ark Agent Plan Run configuration", () => {
  const baseArgs = ["--goal", "Inspect the open task", "--model", "deepseek-v4.1-flash", "--computer", "cua", "--cua-socket", "fixture.sock"];

  it.each(["off", "same", "deepseek-v4.1-flash"] as const)("selects Ark without Qwen calibration with risk model %s", (riskModel) => {
    const options = parseArgs([...baseArgs, "--risk-guard", "layered", "--risk-model", riskModel]);
    const config = toResolvedRunConfig(options, "Inspect the open task");
    expect(config.model).toBe("deepseek-v4.1-flash");
    expect(config.riskModel).toBe(riskModel);
    expect(config).not.toHaveProperty("qwenCoordinateMode");
    expect(config).not.toHaveProperty("qwenThinking");
    expect(() => parseArgs([...baseArgs, "--qwen-coordinate-mode", "actual_pixels"])).toThrow(/only valid with a Qwen model/u);
  });

  it("forwards only Ark overrides and keeps both provider keys out of configuration", () => {
    vi.stubEnv("ARK_API_KEY", "private-ark-fixture-key");
    vi.stubEnv("ARK_BASE_URL", "https://ark.cn-beijing.volces.com/api/plan/v3");
    vi.stubEnv("ARK_REQUEST_TIMEOUT_MS", "180000");
    vi.stubEnv("ARK_MAX_OUTPUT_TOKENS", "8192");
    vi.stubEnv("DEEPSEEK_API_KEY", "private-official-fixture-key");
    vi.stubEnv("DEEPSEEK_BASE_URL", "https://api.deepseek.com");
    vi.stubEnv("DEEPSEEK_REQUEST_TIMEOUT_MS", "invalid");
    vi.stubEnv("DEEPSEEK_MAX_OUTPUT_TOKENS", "invalid");
    vi.stubEnv("GLM_REQUEST_TIMEOUT_MS", "invalid");
    const config = toResolvedRunConfig(parseArgs(baseArgs), "Inspect the open task");
    expect(config).toMatchObject({
      arkEndpoint: "https://ark.cn-beijing.volces.com/api/plan/v3",
      arkRequestTimeoutMs: 180000,
      arkMaxOutputTokens: 8192,
    });
    for (const field of ["arkApiKey", "deepseekApiKey", "deepseekEndpoint", "deepseekRequestTimeoutMs", "deepseekMaxOutputTokens", "glmRequestTimeoutMs"]) {
      expect(config).not.toHaveProperty(field);
    }
    expect(JSON.stringify(config)).not.toContain("private-ark-fixture-key");
    expect(JSON.stringify(config)).not.toContain("private-official-fixture-key");
  });

  it.each([
    ["ARK_REQUEST_TIMEOUT_MS", "241000"],
    ["ARK_REQUEST_TIMEOUT_MS", "not-a-number"],
    ["ARK_MAX_OUTPUT_TOKENS", "0"],
    ["ARK_MAX_OUTPUT_TOKENS", "131073"],
  ])("validates %s only when the main or risk model selects Ark", (name, value) => {
    vi.stubEnv(name, value);
    expect(() => toResolvedRunConfig(parseArgs(baseArgs), "Inspect the open task")).toThrow();
    const officialArgs = [...baseArgs];
    officialArgs[3] = "deepseek-flash";
    expect(toResolvedRunConfig(parseArgs(officialArgs), "Inspect the open task")).not.toHaveProperty("arkRequestTimeoutMs");
    expect(() => toResolvedRunConfig(parseArgs([...officialArgs, "--risk-guard", "layered", "--risk-model", "deepseek-v4.1-flash"]), "Inspect the open task")).toThrow();
  });

  it.each([
    ["deepseek-flash", "deepseek-v4.1-flash"],
    ["deepseek-v4.1-flash", "deepseek-flash"],
  ])("keeps %s main-model settings independent from %s risk-model settings", (model, riskModel) => {
    vi.stubEnv("ARK_BASE_URL", "https://ark.cn-beijing.volces.com/api/plan/v3");
    vi.stubEnv("ARK_REQUEST_TIMEOUT_MS", "90000");
    vi.stubEnv("ARK_MAX_OUTPUT_TOKENS", "4096");
    vi.stubEnv("DEEPSEEK_BASE_URL", "https://api.deepseek.com");
    vi.stubEnv("DEEPSEEK_REQUEST_TIMEOUT_MS", "180000");
    vi.stubEnv("DEEPSEEK_MAX_OUTPUT_TOKENS", "8192");
    const args = [...baseArgs];
    args[3] = model;
    const config = toResolvedRunConfig(parseArgs([...args, "--risk-guard", "layered", "--risk-model", riskModel]), "Inspect the open task");
    expect(config).toMatchObject({
      model,
      riskModel,
      arkEndpoint: "https://ark.cn-beijing.volces.com/api/plan/v3",
      arkRequestTimeoutMs: 90000,
      arkMaxOutputTokens: 4096,
      deepseekEndpoint: "https://api.deepseek.com",
      deepseekRequestTimeoutMs: 180000,
      deepseekMaxOutputTokens: 8192,
    });
  });

  it.each(["glm-5.3-flash", "qwen3.8-flash", "deepseek-flash"])("does not forward Ark settings to an unrelated %s Run", (model) => {
    vi.stubEnv("ARK_BASE_URL", "https://ark.cn-beijing.volces.com/api/plan/v3");
    vi.stubEnv("ARK_REQUEST_TIMEOUT_MS", "invalid");
    vi.stubEnv("ARK_MAX_OUTPUT_TOKENS", "invalid");
    const args = [...baseArgs];
    args[3] = model;
    if (model === "qwen3.8-flash") args.push("--qwen-coordinate-mode", "normalized_1000");
    const config = toResolvedRunConfig(parseArgs(args), "Inspect the open task");
    expect(config.model).toBe(model);
    expect(config).not.toHaveProperty("arkEndpoint");
    expect(config).not.toHaveProperty("arkRequestTimeoutMs");
    expect(config).not.toHaveProperty("arkMaxOutputTokens");
  });
});

describe("CLI evaluation supervision with a real Runtime controller", () => {
  it("consumes a correction during an in-flight provider request and invalidates the old tool decision", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-cli-supervision-runtime-"));
    let releasePendingResponse: (() => void) | undefined;
    let resolvePendingCall: (() => void) | undefined;
    let resolveProviderStarted: (() => void) | undefined;
    const pendingResponseGate = new Promise<void>((resolve) => { releasePendingResponse = resolve; });
    const pendingCall = new Promise<void>((resolve) => { resolvePendingCall = resolve; });
    const providerStarted = new Promise<void>((resolve) => { resolveProviderStarted = resolve; });
    const args = [
      "--goal", "Inspect the fixture and respond after any live correction.",
      "--model", "glm-5.3-flash",
      "--computer", "cua",
      "--cua-socket", "supervision-fixture.sock",
      "--interactive",
      "--profile", "experiment",
      "--risk-guard", "off",
      "--confirm-risk-guard-off",
      "--output", outputDir,
    ];
    const options = parseArgs(args);
    const config = toResolvedRunConfig(options, options.goal!);
    let providerCalls = 0;
    const providerInputs: ModelInput[] = [];
    let computerActions = 0;
    let observationCount = 0;
    const provider = {
      id: "cli-supervision-offline-provider",
      async generate(input: ModelInput) {
        providerCalls += 1;
        providerInputs.push(input);
        if (providerCalls === 1) {
          return {
            type: "tool_calls" as const,
            calls: [{ id: "completed-progress-wait" as never, name: "wait", arguments: { durationMs: 1 } }],
          };
        }
        if (providerCalls === 2) {
          resolveProviderStarted?.();
          resolvePendingCall?.();
          await pendingResponseGate;
          return {
            type: "tool_calls" as const,
            calls: [{ id: "stale-click" as never, name: "click", arguments: { x: 10, y: 20 } }],
          };
        }
        return { type: "finish" as const, summary: "Fresh response after the correction." };
      },
    };
    const baseComputer = multilineProfileFixtureComputer();
    const computer: Computer = {
      open(...callArgs) { return baseComputer.open(...callArgs); },
      async observe(...callArgs) {
        observationCount += 1;
        return baseComputer.observe(...callArgs);
      },
      async execute(...callArgs) {
        computerActions += 1;
        return baseComputer.execute(...callArgs);
      },
      close(...callArgs) { return baseComputer.close(...callArgs); },
    };
    let handle: Awaited<ReturnType<typeof createRun>> | undefined;
    let control: ReturnType<typeof createRunSupervisionControl> | undefined;
    const source = new EventEmitter() as EventEmitter & RunSupervisionControlSource;
    const sent: unknown[] = [];
    source.connected = true;
    source.send = (message, callback) => {
      sent.push(structuredClone(message));
      callback?.(null);
      return true;
    };
    const waitFor = async (predicate: () => boolean, description: string): Promise<void> => {
      const deadline = Date.now() + 4_000;
      while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      if (!predicate()) throw new Error(`timed out waiting for ${description}`);
    };
    try {
      handle = await createRun(config, {
        createProvider: () => provider,
        createComputer: async () => computer,
      });
      control = createRunSupervisionControl(source, "dynamic");
      expect(control).toBeDefined();
      control!.attachController(handle.controller);
      source.emit("message", {
        type: "harness.supervision.start",
        packageId: "G01-C-20261018-a1b2c3d4",
        attemptId: "live-2026-10-18T00-00-00.000Z-a1b2c3d4",
        mode: "dynamic",
      });
      await control!.waitForInitialization();
      const outcomePromise = handle.start();
      let providerStartTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          pendingCall,
          new Promise<never>((_resolve, reject) => { providerStartTimeout = setTimeout(() => reject(new Error("offline provider did not reach the pending second request")), 3_000); }),
        ]);
      } finally {
        if (providerStartTimeout !== undefined) clearTimeout(providerStartTimeout);
      }
      await providerStarted;
      const eventsBeforeCorrection = handle.controller.getEvents();
      const sourceObservation = eventsBeforeCorrection.find((event) => event.type === "observation.created");
      const latestObservation = [...eventsBeforeCorrection].reverse().find((event) => event.type === "observation.created");
      expect(latestObservation?.type).toBe("observation.created");
      if (latestObservation?.type !== "observation.created") throw new Error("fixture Run did not commit an observation before the pending provider request");
      expect(sourceObservation?.type).toBe("observation.created");
      if (sourceObservation?.type !== "observation.created") throw new Error("fixture Run did not commit its initial screenshot");
      expect(latestObservation.sequence).toBeGreaterThan(sourceObservation.sequence);
      const actualRunId = handle.controller.getSnapshot().runId;
      const correctionText = "Reobserve the current screen and continue the original task without repeating an unconfirmed action.";
      source.emit("message", {
        type: "harness.supervision.command",
        commandId: "123e4567-e89b-42d3-a456-426614174111",
        packageId: "G01-C-20261018-a1b2c3d4",
        attemptId: "live-2026-10-18T00-00-00.000Z-a1b2c3d4",
        runId: actualRunId,
        command: "correct",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        evidenceSequence: sourceObservation.sequence,
        observationId: sourceObservation.observation.id,
        text: correctionText,
      });
      await waitFor(() => sent.some((message) => (message as { status?: string }).status === "queued"), "inbox queued receipt");
      expect(handle.controller.getEvents().some((event) => event.type === "user.input.received" && event.text === correctionText)).toBe(false);

      releasePendingResponse?.();
      await expect(outcomePromise).resolves.toBe("succeeded");
      await waitFor(() => sent.some((message) => (message as { status?: string }).status === "consumed"), "consumed receipt");

      const events = handle.controller.getEvents();
      expect(events.some((event) => event.type === "user.input.received" && event.text === correctionText)).toBe(true);
      expect(events.some((event) => event.type === "tool.call.rejected" && event.callId === "stale-click" && event.reason.includes("superseded by user correction"))).toBe(true);
      expect(events.some((event) => event.type === "action.execution.completed")).toBe(true);
      expect(events.some((event) => event.type === "action.execution.started" && event.action.kind === "click")).toBe(false);
      expect(computerActions).toBe(1);
      expect(observationCount).toBeGreaterThanOrEqual(3);
      expect(providerCalls).toBe(3);
      expect(JSON.stringify(providerInputs[2])).toContain(correctionText);
      expect(handle.controller.getSnapshot().summary).toBe("Fresh response after the correction.");
    } finally {
      releasePendingResponse?.();
      control?.dispose();
      if (handle !== undefined) await handle.close().catch(() => undefined);
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("queues a text correction during an executing GUI action and exposes it to the next provider input", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-cli-supervision-executing-action-"));
    let releaseAction: (() => void) | undefined;
    let resolveActionStarted: (() => void) | undefined;
    const actionGate = new Promise<void>((resolve) => { releaseAction = resolve; });
    const actionStarted = new Promise<void>((resolve) => { resolveActionStarted = resolve; });
    const args = [
      "--goal", "Inspect the fixture and respond after any live correction.",
      "--model", "glm-5.3-flash",
      "--computer", "cua",
      "--cua-socket", "supervision-executing-fixture.sock",
      "--interactive",
      "--profile", "experiment",
      "--risk-guard", "off",
      "--confirm-risk-guard-off",
      "--output", outputDir,
    ];
    const options = parseArgs(args);
    const config = toResolvedRunConfig(options, options.goal!);
    let providerCalls = 0;
    const providerInputs: ModelInput[] = [];
    let computerActions = 0;
    let observationCount = 0;
    const provider = {
      id: "cli-supervision-executing-action-provider",
      async generate(input: ModelInput) {
        providerInputs.push(input);
        providerCalls += 1;
        if (providerCalls === 1) {
          return {
            type: "tool_calls" as const,
            calls: [{ id: "in-flight-click" as never, name: "click", arguments: { x: 0, y: 0 } }],
          };
        }
        return { type: "finish" as const, summary: "Finished after consuming the correction." };
      },
    };
    const baseComputer = multilineProfileFixtureComputer();
    const computer: Computer = {
      open(...callArgs) { return baseComputer.open(...callArgs); },
      async observe(...callArgs) {
        observationCount += 1;
        return baseComputer.observe(...callArgs);
      },
      async execute(...callArgs) {
        computerActions += 1;
        resolveActionStarted?.();
        await actionGate;
        return baseComputer.execute(...callArgs);
      },
      close(...callArgs) { return baseComputer.close(...callArgs); },
    };
    let handle: Awaited<ReturnType<typeof createRun>> | undefined;
    let control: ReturnType<typeof createRunSupervisionControl> | undefined;
    const source = new EventEmitter() as EventEmitter & RunSupervisionControlSource;
    const sent: unknown[] = [];
    source.connected = true;
    source.send = (message, callback) => {
      sent.push(structuredClone(message));
      callback?.(null);
      return true;
    };
    const waitFor = async (predicate: () => boolean, description: string): Promise<void> => {
      const deadline = Date.now() + 4_000;
      while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      if (!predicate()) throw new Error(`timed out waiting for ${description}`);
    };
    try {
      handle = await createRun(config, {
        createProvider: () => provider,
        createComputer: async () => computer,
      });
      control = createRunSupervisionControl(source, "dynamic");
      expect(control).toBeDefined();
      control!.attachController(handle.controller);
      source.emit("message", {
        type: "harness.supervision.start",
        packageId: "G01-C-20261018-a1b2c3d4",
        attemptId: "live-2026-10-18T00-00-00.000Z-a1b2c3d4",
        mode: "dynamic",
      });
      await control!.waitForInitialization();
      const outcomePromise = handle.start();
      await Promise.race([
        actionStarted,
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("fixture GUI action did not enter execution")), 3_000)),
      ]);

      const sourceObservation = handle.controller.getEvents().find((event) => event.type === "observation.created");
      expect(sourceObservation?.type).toBe("observation.created");
      if (sourceObservation?.type !== "observation.created") throw new Error("fixture Run did not commit an observation before its action");
      const actualRunId = handle.controller.getSnapshot().runId;
      const correctionText = "After the current action completes, reobserve and continue without repeating an unconfirmed action.";
      source.emit("message", {
        type: "harness.supervision.command",
        commandId: "123e4567-e89b-42d3-a456-426614174112",
        packageId: "G01-C-20261018-a1b2c3d4",
        attemptId: "live-2026-10-18T00-00-00.000Z-a1b2c3d4",
        runId: actualRunId,
        command: "correct",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        evidenceSequence: sourceObservation.sequence,
        observationId: sourceObservation.observation.id,
        text: correctionText,
      });
      await waitFor(() => sent.some((message) => (message as { status?: string }).status === "queued"), "executing-action inbox queued receipt");
      expect(handle.controller.getEvents().some((event) => event.type === "user.input.received" && event.text === correctionText)).toBe(false);

      releaseAction?.();
      await expect(outcomePromise).resolves.toBe("succeeded");
      await waitFor(() => sent.some((message) => (message as { status?: string }).status === "consumed"), "executing-action consumed receipt");
      const events = handle.controller.getEvents();
      expect(events.filter((event) => event.type === "action.execution.completed")).toHaveLength(1);
      expect(events.filter((event) => event.type === "action.execution.started" && event.action.kind === "click")).toHaveLength(1);
      expect(events.some((event) => event.type === "user.input.received" && event.text === correctionText)).toBe(true);
      expect(observationCount).toBeGreaterThanOrEqual(2);
      expect(providerCalls).toBe(2);
      expect(JSON.stringify(providerInputs[1])).toContain(correctionText);
      expect(handle.controller.getSnapshot().summary).toBe("Finished after consuming the correction.");
      expect(computerActions).toBe(1);
    } finally {
      releaseAction?.();
      control?.dispose();
      if (handle !== undefined) await handle.close().catch(() => undefined);
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});

describe("CLI provider recovery configuration", () => {
  const options = parseArgs(["--goal", "Inspect the open task", "--model", "glm-5.3-flash", "--computer", "cua", "--cua-socket", "fixture.sock"]);

  it("defaults to off and exposes the bounded Run window in resolved configuration", () => {
    vi.stubEnv("HARNESS_PROVIDER_RECOVERY", undefined);
    vi.stubEnv("HARNESS_PROVIDER_RECOVERY_RUN_WINDOW_MS", undefined);
    expect(toResolvedRunConfig(options, "Inspect the open task")).toMatchObject({ providerRecovery: "off", providerRecoveryRunWindowMs: 900_000 });
  });

  it("accepts only the explicit opt-in enum and bounded integer window", () => {
    vi.stubEnv("HARNESS_PROVIDER_RECOVERY", "ambiguous-headers-once-v1");
    vi.stubEnv("HARNESS_PROVIDER_RECOVERY_RUN_WINDOW_MS", "240000");
    expect(toResolvedRunConfig(options, "Inspect the open task")).toMatchObject({ providerRecovery: "ambiguous-headers-once-v1", providerRecoveryRunWindowMs: 240_000 });
    vi.stubEnv("HARNESS_PROVIDER_RECOVERY", "always");
    expect(() => toResolvedRunConfig(options, "Inspect the open task")).toThrow(/HARNESS_PROVIDER_RECOVERY must be/u);
    vi.stubEnv("HARNESS_PROVIDER_RECOVERY", "off");
    vi.stubEnv("HARNESS_PROVIDER_RECOVERY_RUN_WINDOW_MS", "900001");
    expect(() => toResolvedRunConfig(options, "Inspect the open task")).toThrow(/RUN_WINDOW_MS must be/u);
  });
});
