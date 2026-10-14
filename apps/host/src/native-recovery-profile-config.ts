import { isAbsolute, resolve } from "node:path";
import type { HostNativeRecoveryProfile } from "@computer-harness/app-runtime";

const PROFILE_ENVIRONMENT_KEYS = [
  "HARNESS_NATIVE_RECOVERY_PROFILE_ID",
  "HARNESS_NATIVE_RECOVERY_PRIMARY_PID",
  "HARNESS_NATIVE_RECOVERY_PRIMARY_WINDOW_ID",
  "HARNESS_NATIVE_RECOVERY_RECOVERY_PID",
  "HARNESS_NATIVE_RECOVERY_RECOVERY_WINDOW_ID",
  "HARNESS_NATIVE_RECOVERY_OUTPUT_PATH",
  "HARNESS_NATIVE_RECOVERY_EXECUTABLE_URL",
] as const;

export function resolveNativeRecoveryProfileConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  osPlatform: NodeJS.Platform = process.platform,
): HostNativeRecoveryProfile | undefined {
  const values = PROFILE_ENVIRONMENT_KEYS.map((key) => environment[key]?.trim());
  if (values.every((value) => value === undefined || value.length === 0)) return undefined;
  if (values.some((value) => value === undefined || value.length === 0)) {
    throw new Error("Native recovery profile configuration requires all HARNESS_NATIVE_RECOVERY_* fields.");
  }
  if (osPlatform !== "darwin") throw new Error("Native recovery profiles are supported only on Darwin.");
  const [profileId, rawPrimaryPid, rawPrimaryWindowId, rawRecoveryPid, rawRecoveryWindowId, outputPath, expectedExecutableUrl] = values as string[];
  const primaryTarget = {
    pid: parsePositiveInteger(rawPrimaryPid!, "HARNESS_NATIVE_RECOVERY_PRIMARY_PID"),
    windowId: parsePositiveInteger(rawPrimaryWindowId!, "HARNESS_NATIVE_RECOVERY_PRIMARY_WINDOW_ID"),
  };
  const recoveryTarget = {
    pid: parsePositiveInteger(rawRecoveryPid!, "HARNESS_NATIVE_RECOVERY_RECOVERY_PID"),
    windowId: parsePositiveInteger(rawRecoveryWindowId!, "HARNESS_NATIVE_RECOVERY_RECOVERY_WINDOW_ID"),
  };
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(profileId!) ||
      primaryTarget.pid !== recoveryTarget.pid || primaryTarget.windowId === recoveryTarget.windowId) {
    throw new Error("Native recovery profile requires an opaque id and two distinct windows in one process.");
  }
  if (!isAbsolute(outputPath!) || outputPath!.includes("\0") || resolve(outputPath!) !== outputPath!) {
    throw new Error("HARNESS_NATIVE_RECOVERY_OUTPUT_PATH must be one canonical absolute path.");
  }
  try {
    const executableUrl = new URL(expectedExecutableUrl!);
    if (executableUrl.protocol !== "file:" || executableUrl.hostname !== "" || executableUrl.search !== "" ||
        executableUrl.hash !== "" || executableUrl.href !== expectedExecutableUrl ||
        !executableUrl.pathname.endsWith("/TextEdit.app/Contents/MacOS/TextEdit")) {
      throw new Error();
    }
  } catch {
    throw new Error("HARNESS_NATIVE_RECOVERY_EXECUTABLE_URL must be a canonical TextEdit executable file URL.");
  }
  return { profileId: profileId!, primaryTarget, recoveryTarget, outputPath: outputPath!, expectedExecutableUrl: expectedExecutableUrl! };
}

function parsePositiveInteger(value: string, key: string): number {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${key} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${key} must be a safe positive integer.`);
  return parsed;
}
