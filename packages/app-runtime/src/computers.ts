import type { CuaDriverComputerOptions } from "@computer-harness/computer-cua";
import { OsworldBridgeClient, OsworldComputer } from "@computer-harness/computer-osworld";
import type { Computer } from "@computer-harness/runtime";

export type ComputerBackendConfig =
  | {
      kind: "cua";
      socketPath: string;
      screenshotDir: string;
      /** Explicit host-only opt-in; omitted keeps primary desktop behavior. */
      windowTarget?: { pid: number; windowId: number };
    }
  | {
      kind: "osworld";
      bridgeUrl: string;
    };

interface CuaComputerModule {
  CuaDriverComputer: new (options: CuaDriverComputerOptions) => Computer;
}

export interface ComputerFactoryDependencies {
  importCuaComputer?: () => Promise<CuaComputerModule>;
  /** Injected by the application boundary; no ambient environment read here. */
  osworldBridgeToken?: string;
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
        ...(dependencies.osworldBridgeToken === undefined ? {} : { token: dependencies.osworldBridgeToken }),
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
    ...(config.windowTarget === undefined ? {} : { windowTarget: config.windowTarget }),
  });
}
