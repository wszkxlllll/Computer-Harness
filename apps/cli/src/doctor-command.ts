import { inspectCuaCapabilities as inspectAppRuntimeCuaCapabilities, type CuaCapabilityReport } from "@computer-harness/app-runtime";

export interface DoctorCommandOptions {
  readonly socketPath: string;
  readonly timeoutMs: number;
}

export type DoctorRunner = (options: DoctorCommandOptions) => Promise<CuaCapabilityReport>;

const defaultDoctorRunner: DoctorRunner = async (options) => {
  // app-runtime keeps the native CUA package lazy: --help, OSWorld, and
  // ordinary CLI paths must not resolve the optional platform binding.
  try {
    return await inspectAppRuntimeCuaCapabilities(options);
  } catch {
    // Native binding/load/connection failures are represented as an explicit
    // unknown report rather than leaking paths, credentials, or stack text.
    return unknownReport("native_binding_or_connection");
  }
};

export function runCuaDoctor(options: DoctorCommandOptions, runner: DoctorRunner = defaultDoctorRunner): Promise<CuaCapabilityReport> {
  return runner(options);
}

function unknownReport(reasonCode: string): CuaCapabilityReport {
  const unknown = { status: "unknown" as const, reasonCode };
  return {
    schemaVersion: "cua-doctor-v1",
    backend: "cua-driver-daemon",
    declared: {
      sdkVersion: "0.22.2",
      expectedDriverContractVersion: "0.7.0",
      defaultObservation: "desktop",
      windowCapture: "not_integrated",
      tools: { windowDiscovery: "unknown", windowForeground: "unknown", windowCapture: "unknown" },
    },
    verified: { metadata: unknown, inventory: unknown, session: unknown, health: unknown, permissions: unknown },
    cleanup: unknown,
    status: "unknown",
  };
}
