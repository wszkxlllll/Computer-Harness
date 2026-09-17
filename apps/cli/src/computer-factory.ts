import type { CuaDriverComputerOptions } from "@computer-harness/computer-cua";
import { OsworldBridgeClient, OsworldComputer } from "@computer-harness/computer-osworld";
import type { Computer } from "@computer-harness/runtime";

export type ComputerBackendConfig =
  | {
      kind: "cua";
      socketPath: string;
      screenshotDir: string;
    }
  | {
      kind: "osworld";
      bridgeUrl: string;
      token?: string;
    };

interface CuaComputerModule {
  CuaDriverComputer: new (options: CuaDriverComputerOptions) => Computer;
}

export interface ComputerFactoryDependencies {
  importCuaComputer?: () => Promise<CuaComputerModule>;
}

const defaultCuaImporter = (): Promise<CuaComputerModule> => import("@computer-harness/computer-cua");

/**
 * Select a Computer backend without resolving the native CUA binding for
 * backends that do not use it.
 */
export async function createComputer(
  config: ComputerBackendConfig,
  dependencies: ComputerFactoryDependencies = {},
): Promise<Computer> {
  if (config.kind === "osworld") {
    return new OsworldComputer({
      bridge: new OsworldBridgeClient({
        baseUrl: config.bridgeUrl,
        ...(config.token === undefined ? {} : { token: config.token }),
      }),
    });
  }

  const importCuaComputer = dependencies.importCuaComputer ?? defaultCuaImporter;
  let cuaModule: CuaComputerModule;
  try {
    cuaModule = await importCuaComputer();
  } catch (cause) {
    throw new Error(
      "Failed to load @computer-harness/computer-cua. The cua backend requires the native @trycua/cua-driver platform binding to be installed and loadable.",
      { cause },
    );
  }

  return new cuaModule.CuaDriverComputer({
    socketPath: config.socketPath,
    screenshotDir: config.screenshotDir,
  });
}
