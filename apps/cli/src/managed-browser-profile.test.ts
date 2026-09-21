import { describe, expect, it } from "vitest";
import { defaultManagedBrowserProfileRoot } from "./managed-browser-profile.js";

describe("managed browser profile root", () => {
  it("uses stable OS-local roots without depending on Run output", () => {
    expect(defaultManagedBrowserProfileRoot("win32", { LOCALAPPDATA: "C:\\LocalAppData" }, "C:\\Users\\fixture")).toBe("C:\\LocalAppData\\ComputerHarness\\managed-browser-profiles");
    expect(defaultManagedBrowserProfileRoot("linux", { XDG_STATE_HOME: "/state" }, "/home/fixture")).toBe("/state/computer-harness/managed-browser-profiles");
    expect(defaultManagedBrowserProfileRoot("linux", {}, "/home/fixture")).toBe("/home/fixture/.local/state/computer-harness/managed-browser-profiles");
  });
});
