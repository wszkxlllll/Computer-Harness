import type {
  CuaCapabilityDoctorOptions,
  CuaCapabilityReport,
} from "@computer-harness/computer-cua";

export type {
  CuaCapabilityDoctorOptions,
  CuaCapabilityReport,
  CuaCapabilityStatus,
  CuaDeclaredToolCapabilities,
  CuaDoctorCheck,
} from "@computer-harness/computer-cua";

/**
 * Keep the optional native CUA binding lazy while exposing the application
 * boundary's explicit, read-only doctor command.
 */
export async function inspectCuaCapabilities(options: CuaCapabilityDoctorOptions): Promise<CuaCapabilityReport> {
  const { inspectCuaCapabilities: inspect } = await import("@computer-harness/computer-cua");
  return inspect(options);
}
