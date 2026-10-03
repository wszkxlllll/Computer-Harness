import { setCuaSdkModuleOverrideForTests, type CuaSdkModule } from "./cua-sdk-platform.js";

/**
 * Install a minimal SDK module override so tests exercise adapter logic
 * without loading the native binding. Input factories pass their partial
 * through unchanged, matching the SDK's generated `.new(partial)` behavior
 * closely enough for every adapter call site (which forwards the same
 * fields to the mocked driver).
 */
export function installFakeCuaSdkModuleForTests(): void {
  // A real function (not an arrow) so `new factory(partial)` works; the SDK's
  // generated factories are callable both ways and adapters use `new`.
  const passThroughInner = function passThroughFactory(this: unknown, partial: Record<string, unknown>): Record<string, unknown> {
    return { ...partial };
  };
  (passThroughInner as unknown as { new: unknown }).new = (partial: Record<string, unknown>): Record<string, unknown> => ({ ...partial });
  const passThrough = passThroughInner as unknown as CuaSdkModule["StartSessionInput"];
  const module = {
    CuaDriver: { connect: () => { throw new Error("fake SDK must not connect"); } },
    StartSessionInput: passThrough,
    EndSessionInput: passThrough,
    GetSessionInput: passThrough,
    GetSessionStateInput: passThrough,
    VerifyStateInput: passThrough,
    StatePredicate: passThrough,
    WindowPredicate: passThrough,
    BoundsExpectation: passThrough,
  } as unknown as CuaSdkModule;
  setCuaSdkModuleOverrideForTests(module);
}
