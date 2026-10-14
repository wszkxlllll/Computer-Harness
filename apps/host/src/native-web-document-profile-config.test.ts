import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveNativeWebDocumentProfileConfig } from "./native-web-document-profile-config.js";

const configured = {
  HARNESS_NATIVE_WEB_DOCUMENT_PROFILE_ID: "Opaque_Hybrid_Profile_12345",
  HARNESS_NATIVE_WEB_DOCUMENT_PRIMARY_PID: "77",
  HARNESS_NATIVE_WEB_DOCUMENT_PRIMARY_WINDOW_ID: "1101",
  HARNESS_NATIVE_WEB_DOCUMENT_RECOVERY_PID: "77",
  HARNESS_NATIVE_WEB_DOCUMENT_RECOVERY_WINDOW_ID: "1102",
  HARNESS_NATIVE_WEB_DOCUMENT_OUTPUT_PATH: join(tmpdir(), "hybrid-output", "itinerary.txt"),
  HARNESS_NATIVE_WEB_DOCUMENT_EXECUTABLE_URL: "file:///System/Applications/TextEdit.app/Contents/MacOS/TextEdit",
};

describe("Host T3 native-web-document startup config", () => {
  it("is absent by default and binds the exact native pair plus one output grant", () => {
    expect(resolveNativeWebDocumentProfileConfig({}, "darwin")).toBeUndefined();
    expect(resolveNativeWebDocumentProfileConfig(configured, "darwin")).toMatchObject({
      profileId: configured.HARNESS_NATIVE_WEB_DOCUMENT_PROFILE_ID,
      primaryTarget: { pid: 77, windowId: 1101 }, recoveryTarget: { pid: 77, windowId: 1102 },
      outputPath: configured.HARNESS_NATIVE_WEB_DOCUMENT_OUTPUT_PATH,
    });
  });

  it("rejects partial, non-Darwin, cross-process and noncanonical profiles", () => {
    expect(() => resolveNativeWebDocumentProfileConfig({ HARNESS_NATIVE_WEB_DOCUMENT_PROFILE_ID: configured.HARNESS_NATIVE_WEB_DOCUMENT_PROFILE_ID }, "darwin")).toThrow(/requires all/u);
    expect(() => resolveNativeWebDocumentProfileConfig(configured, "linux")).toThrow(/only on Darwin/u);
    expect(() => resolveNativeWebDocumentProfileConfig({ ...configured, HARNESS_NATIVE_WEB_DOCUMENT_RECOVERY_PID: "78" }, "darwin")).toThrow(/one TextEdit process/u);
    expect(() => resolveNativeWebDocumentProfileConfig({ ...configured, HARNESS_NATIVE_WEB_DOCUMENT_OUTPUT_PATH: "relative.txt" }, "darwin")).toThrow(/canonical/u);
  });
});
