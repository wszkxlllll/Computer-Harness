import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveNativeRecoveryProfileConfig } from "./native-recovery-profile-config.js";

const executableUrl = "file:///System/Applications/TextEdit.app/Contents/MacOS/TextEdit";
const configured = {
  HARNESS_NATIVE_RECOVERY_PROFILE_ID: "Opaque_Profile_1234567890",
  HARNESS_NATIVE_RECOVERY_PRIMARY_PID: "77",
  HARNESS_NATIVE_RECOVERY_PRIMARY_WINDOW_ID: "1101",
  HARNESS_NATIVE_RECOVERY_RECOVERY_PID: "77",
  HARNESS_NATIVE_RECOVERY_RECOVERY_WINDOW_ID: "1102",
  HARNESS_NATIVE_RECOVERY_OUTPUT_PATH: join(tmpdir(), "harness-native-recovery", "output.txt"),
  HARNESS_NATIVE_RECOVERY_EXECUTABLE_URL: executableUrl,
};

describe("Host native recovery profile startup config", () => {
  it("keeps the feature absent by default", () => {
    expect(resolveNativeRecoveryProfileConfig({}, "darwin")).toBeUndefined();
  });

  it("resolves one opaque profile with two distinct exact same-process windows", () => {
    expect(resolveNativeRecoveryProfileConfig(configured, "darwin")).toEqual({
      profileId: configured.HARNESS_NATIVE_RECOVERY_PROFILE_ID,
      primaryTarget: { pid: 77, windowId: 1101 },
      recoveryTarget: { pid: 77, windowId: 1102 },
      outputPath: configured.HARNESS_NATIVE_RECOVERY_OUTPUT_PATH,
      expectedExecutableUrl: executableUrl,
    });
  });

  it.each([
    [{ ...configured, HARNESS_NATIVE_RECOVERY_RECOVERY_PID: "78" }, /two distinct windows in one process/u],
    [{ ...configured, HARNESS_NATIVE_RECOVERY_RECOVERY_WINDOW_ID: "1101" }, /two distinct windows in one process/u],
    [{ ...configured, HARNESS_NATIVE_RECOVERY_OUTPUT_PATH: "relative.txt" }, /canonical absolute path/u],
    [{ ...configured, HARNESS_NATIVE_RECOVERY_EXECUTABLE_URL: "https://example.invalid/TextEdit.app/Contents/MacOS/TextEdit" }, /canonical TextEdit executable/u],
  ] as const)("rejects malformed profile configuration", (environment, message) => {
    expect(() => resolveNativeRecoveryProfileConfig(environment, "darwin")).toThrow(message);
  });

  it("rejects partial and non-Darwin configuration", () => {
    expect(() => resolveNativeRecoveryProfileConfig({ HARNESS_NATIVE_RECOVERY_PROFILE_ID: configured.HARNESS_NATIVE_RECOVERY_PROFILE_ID }, "darwin"))
      .toThrow(/requires all HARNESS_NATIVE_RECOVERY/u);
    expect(() => resolveNativeRecoveryProfileConfig(configured, "linux"))
      .toThrow(/only on Darwin/u);
  });
});
