import { isAbsolute, resolve } from "node:path";
import type { HostNativeWebDocumentProfile } from "@computer-harness/app-runtime";

const PREFIX = "HARNESS_NATIVE_WEB_DOCUMENT_";
const KEYS = ["PROFILE_ID", "PRIMARY_PID", "PRIMARY_WINDOW_ID", "RECOVERY_PID", "RECOVERY_WINDOW_ID", "OUTPUT_PATH", "EXECUTABLE_URL"] as const;

export function resolveNativeWebDocumentProfileConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  osPlatform: NodeJS.Platform = process.platform,
): HostNativeWebDocumentProfile | undefined {
  const values = KEYS.map((key) => environment[PREFIX + key]?.trim());
  if (values.every((value) => value === undefined || value.length === 0)) return undefined;
  if (values.some((value) => value === undefined || value.length === 0)) throw new Error("T3 hybrid profile requires all HARNESS_NATIVE_WEB_DOCUMENT_* fields.");
  if (osPlatform !== "darwin") throw new Error("T3 hybrid profiles are supported only on Darwin.");
  const [profileId, rawPid, rawPrimary, rawRecovery, rawRecoveryWindow, outputPath, executableUrl] = values as string[];
  const primaryTarget = { pid: positive(rawPid!, "PRIMARY_PID"), windowId: positive(rawPrimary!, "PRIMARY_WINDOW_ID") };
  const recoveryTarget = { pid: positive(rawRecovery!, "RECOVERY_PID"), windowId: positive(rawRecoveryWindow!, "RECOVERY_WINDOW_ID") };
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(profileId!) || primaryTarget.pid !== recoveryTarget.pid || primaryTarget.windowId === recoveryTarget.windowId) {
    throw new Error("T3 hybrid profile requires an opaque id and two distinct windows in one TextEdit process.");
  }
  if (!isAbsolute(outputPath!) || outputPath!.includes("\0") || resolve(outputPath!) !== outputPath!) throw new Error("T3 hybrid output path must be canonical and absolute.");
  try {
    const url = new URL(executableUrl!);
    if (url.protocol !== "file:" || url.hostname || url.search || url.hash || url.href !== executableUrl || !url.pathname.endsWith("/TextEdit.app/Contents/MacOS/TextEdit")) throw new Error();
  } catch { throw new Error("T3 hybrid executable URL must identify the canonical TextEdit executable."); }
  return { profileId: profileId!, primaryTarget, recoveryTarget, outputPath: outputPath!, expectedExecutableUrl: executableUrl! };
}

function positive(value: string, field: string): number {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`T3 hybrid ${field} must be positive.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`T3 hybrid ${field} must be a safe integer.`);
  return parsed;
}
