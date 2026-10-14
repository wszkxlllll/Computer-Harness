import { describe, expect, it } from "vitest";
import { createDefaultToolRegistry, restrictToolNamesForCapabilities, windowSwitchTools, type ComputerCapabilities } from "@computer-harness/runtime";
import { prepareComputerRunAssembly, type ComputerBackendConfig } from "./computers.js";

const managedConfig = (): Extract<ComputerBackendConfig, { kind: "cua" }> => ({
  kind: "cua",
  socketPath: "fixture.sock",
  screenshotDir: "screenshots",
  managedBrowserUrl: "https://example.test",
});

function registryWithAssemblyTools(grounding: "off" | "dom-catalog-v1" | "hybrid-catalog-v1") {
  const registry = createDefaultToolRegistry();
  registry.registerMany(windowSwitchTools());
  const click = registry.get("click");
  if (click === undefined) throw new Error("default registry is missing click");
  registry.register({ ...click, name: "unverified_computer_tool" });
  const assembly = prepareComputerRunAssembly(managedConfig(), grounding, "off");
  registry.registerMany(assembly.groundingTools);
  const enabledToolNames = assembly.enabledToolNames(registry);
  if (enabledToolNames === undefined) throw new Error("fixture should have a window-scoped tool projection");
  return { assembly, registry, enabledToolNames };
}

const pointerAndKeyboard: ComputerCapabilities = { screenshot: true, pointer: true, keyboard: true, accessibility: false };
const noPointer: ComputerCapabilities = { ...pointerAndKeyboard, pointer: false };
const noKeyboard: ComputerCapabilities = { ...pointerAndKeyboard, keyboard: false };

describe("managed and window-scoped Computer tool exposure", () => {
  it.each(["dom-catalog-v1", "hybrid-catalog-v1"] as const)(
    "keeps raw click available as a foreground managed-browser candidate with %s grounding",
    (grounding) => {
      const { assembly, registry, enabledToolNames } = registryWithAssemblyTools(grounding);
      expect(assembly.config).toMatchObject({ grounding, windowDeliveryMode: "foreground" });
      expect(enabledToolNames).toEqual(expect.arrayContaining(["click", "wait", "type", "keypress", "hotkey", "click_element"]));
      expect(enabledToolNames).not.toContain("unverified_computer_tool");

      // Assembly only offers a candidate. Runtime still removes pointer or
      // keyboard actions when the opened session lacks that capability.
      expect(restrictToolNamesForCapabilities(registry, pointerAndKeyboard, enabledToolNames)).toContain("click");
      const pointerless = restrictToolNamesForCapabilities(registry, noPointer, enabledToolNames) ?? [];
      expect(pointerless).not.toContain("click");
      const keyboardless = restrictToolNamesForCapabilities(registry, noKeyboard, enabledToolNames) ?? [];
      expect(keyboardless).toContain("click");
      expect(keyboardless).not.toContain("type");
      expect(keyboardless).not.toContain("hotkey");
    },
  );

  it("keeps raw click on the native foreground path and preserves the background tool boundary", () => {
    const foregroundRegistry = createDefaultToolRegistry();
    const foregroundAssembly = prepareComputerRunAssembly({
      kind: "cua",
      socketPath: "fixture.sock",
      screenshotDir: "screenshots",
      windowTarget: { pid: 1234, windowId: 5678 },
      windowDeliveryMode: "foreground",
    }, "off");
    const foregroundNames = foregroundAssembly.enabledToolNames(foregroundRegistry) ?? [];
    expect(foregroundNames).toEqual(expect.arrayContaining(["click", "type", "hotkey", "wait"]));

    const backgroundAssembly = prepareComputerRunAssembly({
      kind: "cua",
      socketPath: "fixture.sock",
      screenshotDir: "screenshots",
      windowTarget: { pid: 1234, windowId: 5678 },
      windowDeliveryMode: "background",
    }, "off");
    const backgroundNames = backgroundAssembly.enabledToolNames(foregroundRegistry) ?? [];
    expect(backgroundNames).toEqual(expect.arrayContaining(["click", "wait"]));
    expect(backgroundNames).not.toContain("type");
    expect(backgroundNames).not.toContain("hotkey");
    expect(backgroundNames).not.toContain("keypress");
  });

  it("keeps opened-window native bindings foreground and permits the unbound desktop start", () => {
    const registry = createDefaultToolRegistry();
    registry.registerMany(windowSwitchTools());
    const bound = prepareComputerRunAssembly({
      kind: "cua",
      socketPath: "fixture.sock",
      screenshotDir: "screenshots",
      windowTarget: { pid: 1234, windowId: 5678 },
    }, "off", "opened-windows-v1");
    const boundNames = bound.enabledToolNames(registry) ?? [];
    expect(bound.config.windowDeliveryMode).toBe("foreground");
    expect(boundNames).toEqual(expect.arrayContaining(["click", "type", "hotkey", "switch_window"]));

    const desktop = prepareComputerRunAssembly({
      kind: "cua",
      socketPath: "fixture.sock",
      screenshotDir: "screenshots",
    }, "off", "opened-windows-v1");
    expect(desktop.config.windowDeliveryMode).toBe("foreground");
    expect(desktop.enabledToolNames(registry)).toBeUndefined();
  });

  it("keeps click and grounded-click options available together on a managed cross-window Run", () => {
    const registry = createDefaultToolRegistry();
    registry.registerMany(windowSwitchTools());
    const config = {
      ...managedConfig(),
      managedBrowserCompanion: true,
      windowSwitchAllowedTargets: [{ pid: 321, windowId: 654 }],
    };
    const assembly = prepareComputerRunAssembly(config, "hybrid-catalog-v1", "opened-windows-v1");
    registry.registerMany(assembly.groundingTools);
    const names = assembly.enabledToolNames(registry) ?? [];
    expect(names).toEqual(expect.arrayContaining(["click", "type", "hotkey", "click_element", "select_option", "switch_window"]));
  });
});
