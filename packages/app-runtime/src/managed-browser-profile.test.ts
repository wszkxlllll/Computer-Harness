import { describe, expect, it } from "vitest";
import { resolveManagedBrowserProfileConfig } from "./managed-browser-profile.js";

describe("managed browser profile config", () => {
  it("uses a generic mobile label under the Harness-owned local data root by default", () => {
    expect(resolveManagedBrowserProfileConfig({}, "win32", "C:\\Users\\fixture")).toEqual({
      profileLabel: "mobile",
      profileRoot: "C:\\Users\\fixture\\AppData\\Local\\ComputerHarness\\managed-browser-profiles",
    });
  });

  it("uses a configured label while ignoring any client-like profile root value", () => {
    expect(resolveManagedBrowserProfileConfig({
      LOCALAPPDATA: "C:\\LocalData",
      HARNESS_MANAGED_BROWSER_PROFILE_LABEL: "saved.login",
      HARNESS_MANAGED_BROWSER_PROFILE_ROOT: "D:\\client-controlled",
    }, "win32", "C:\\Users\\fixture")).toEqual({
      profileLabel: "saved.login",
      profileRoot: "C:\\LocalData\\ComputerHarness\\managed-browser-profiles",
    });
  });

  it("rejects labels outside the bounded portable character set", () => {
    expect(() => resolveManagedBrowserProfileConfig({ HARNESS_MANAGED_BROWSER_PROFILE_LABEL: "../outside" }, "win32", "C:\\Users\\fixture"))
      .toThrow(/HARNESS_MANAGED_BROWSER_PROFILE_LABEL/u);
  });
});
