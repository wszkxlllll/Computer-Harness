import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRun } from "@computer-harness/app-runtime";
import type { Computer } from "@computer-harness/runtime";
import { parseArgs, toResolvedRunConfig } from "./index.js";

afterEach(() => vi.unstubAllEnvs());

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

  it("leaves absent overrides to runtime defaults", () => {
    vi.stubEnv("DEEPSEEK_REQUEST_TIMEOUT_MS", undefined);
    vi.stubEnv("DEEPSEEK_MAX_OUTPUT_TOKENS", undefined);
    const config = toResolvedRunConfig(parseArgs(baseArgs), "Inspect the open task");
    expect(config).not.toHaveProperty("deepseekRequestTimeoutMs");
    expect(config).not.toHaveProperty("deepseekMaxOutputTokens");
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
