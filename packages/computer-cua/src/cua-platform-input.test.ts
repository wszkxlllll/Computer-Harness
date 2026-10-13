import { describe, expect, it } from "vitest";
import type { ActionIntent, ObservationId } from "@computer-harness/protocol";
import {
  actionRequest,
  resolveMultilineTypeDispatch,
  type CuaWindowDeliveryMode,
} from "./cua-platform-input.js";
import type { CuaWindowBinding } from "./window-contract.js";

const binding: CuaWindowBinding = {
  target: { pid: 100, windowId: 200 },
  bounds: { x: 40, y: 50, width: 500, height: 400 },
};
const viewport = { width: 100, height: 100, coordinateSpace: "physical" } as const;
const desktopTarget = { kind: "desktop", display_id: "primary" } as const;

describe("CUA platform input decisions", () => {
  it("routes only ungrounded opted-in Windows multiline typing through foreground caret delivery", () => {
    const ungrounded: Extract<ActionIntent, { kind: "type" }> = {
      actionId: "multiline" as never,
      basedOn: "observation" as ObservationId,
      kind: "type",
      text: "first\nsecond",
    };
    const explicit: Extract<ActionIntent, { kind: "type" }> = { ...ungrounded, groundingRef: "element-1" as never };
    const singleLine: Extract<ActionIntent, { kind: "type" }> = { ...ungrounded, text: "single line" };

    expect(resolveMultilineTypeDispatch("win32", ungrounded, "foreground-caret-v1")).toBe("windows_foreground_caret");
    expect(resolveMultilineTypeDispatch("win32", explicit, "foreground-caret-v1")).toBe("windows_uia");
    expect(resolveMultilineTypeDispatch("win32", ungrounded, undefined)).toBe("windows_uia");
    expect(resolveMultilineTypeDispatch("win32", singleLine, "foreground-caret-v1")).toBe("standard");
    expect(resolveMultilineTypeDispatch("darwin", ungrounded, "foreground-caret-v1")).toBe("standard");
    expect(resolveMultilineTypeDispatch("linux", ungrounded, "foreground-caret-v1")).toBe("standard");
  });

  it("keeps Windows and macOS point projection on their existing coordinate contracts", () => {
    const click: Extract<ActionIntent, { kind: "click" }> = {
      actionId: "click" as never,
      basedOn: "observation" as ObservationId,
      kind: "click",
      point: { x: 20, y: 30 },
    };

    expect(actionRequest(click, "session", desktopTarget, binding, "foreground", viewport, "win32")).toMatchObject({
      name: "click",
      arguments: {
        target: { kind: "window", pid: binding.target.pid, window_id: binding.target.windowId },
        x: 100,
        y: 120,
        delivery_mode: "foreground",
      },
    });
    expect(actionRequest(click, "session", desktopTarget, binding, "foreground", viewport, "darwin")).toMatchObject({
      name: "click",
      arguments: { x: 20, y: 30, delivery_mode: "foreground" },
    });
  });

  it("maps foreground Windows chords to press_key and preserves native hotkeys elsewhere", () => {
    const windowsChord: Extract<ActionIntent, { kind: "keypress" }> = {
      actionId: "windows-chord" as never,
      basedOn: "observation" as ObservationId,
      kind: "keypress",
      keys: ["CTRL", "L"],
    };
    const macChord: Extract<ActionIntent, { kind: "keypress" }> = { ...windowsChord, keys: ["CMD", "L"] };

    expect(actionRequest(windowsChord, "session", desktopTarget, binding, "foreground", viewport, "win32")).toMatchObject({
      name: "press_key",
      arguments: { key: "L", modifiers: ["ctrl"], delivery_mode: "foreground" },
    });
    expect(actionRequest(windowsChord, "session", desktopTarget, binding, "background", viewport, "win32")).toMatchObject({
      name: "hotkey",
      arguments: { keys: ["CTRL", "L"], delivery_mode: "background" },
    });
    expect(actionRequest(macChord, "session", desktopTarget, binding, "foreground", viewport, "darwin")).toMatchObject({
      name: "hotkey",
      arguments: { keys: ["CMD", "L"], delivery_mode: "foreground" },
    });
  });

  it("keeps ordinary native type_text payloads free of UIA element references", () => {
    const action: Extract<ActionIntent, { kind: "type" }> = {
      actionId: "native-type" as never,
      basedOn: "observation" as ObservationId,
      kind: "type",
      text: "first\nsecond",
    };
    const request = actionRequest(action, "session", desktopTarget, binding, "foreground", viewport, "darwin");

    expect(request).toMatchObject({
      name: "type_text",
      arguments: {
        target: { kind: "window", pid: binding.target.pid, window_id: binding.target.windowId },
        text: action.text,
        delivery_mode: "foreground",
      },
    });
    expect(request.arguments).not.toHaveProperty("element_token");
    const mode: CuaWindowDeliveryMode = "foreground";
    expect(mode).toBe("foreground");
  });
});
