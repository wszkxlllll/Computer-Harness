import { setCuaSdkModuleLoaderForTests, type CuaSdkModule, type InputFactory } from "./cua-sdk-platform.js";
import type { CuaDriverLike } from "./cua-sdk-contract.js";

export function installFakeCuaSdkModuleForTests(connect?: (socketPath: string) => CuaDriverLike): void {
  const passThroughFactory = function passThroughFactory(this: unknown, partial: Record<string, unknown>): Record<string, unknown> {
    return { ...partial };
  };
  Object.assign(passThroughFactory, {
    new: (partial: Record<string, unknown>) => ({ ...partial }),
    create: (partial: Record<string, unknown>) => ({ ...partial }),
  });
  const inputFactory = passThroughFactory as unknown as InputFactory<unknown>;
  const module = {
    CuaDriver: {
      connect: connect ?? (() => { throw new Error("fake CUA SDK must not connect without a driver fixture"); }),
    },
    StartSessionInput: inputFactory,
    EndSessionInput: inputFactory,
    GetSessionInput: inputFactory,
    GetSessionStateInput: inputFactory,
    VerifyStateInput: inputFactory,
    StatePredicate: inputFactory,
    WindowPredicate: inputFactory,
    BoundsExpectation: inputFactory,
  } as unknown as CuaSdkModule;
  setCuaSdkModuleLoaderForTests(async () => module);
}
