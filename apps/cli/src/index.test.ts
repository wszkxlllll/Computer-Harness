import { describe, expect, it } from "vitest";
import { parseArgs, toResolvedRunConfig } from "./index.js";

describe("CLI window-switch configuration", () => {
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
