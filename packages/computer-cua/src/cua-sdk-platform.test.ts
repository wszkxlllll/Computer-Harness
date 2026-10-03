import { afterEach, describe, expect, it } from "vitest";
import {
  cuaSdkAliasForPlatform,
  cuaSdkVersionForPlatform,
  loadCuaSdkModule,
  setCuaSdkModuleLoaderForTests,
  type CuaSdkModule,
  type InputFactory,
} from "./cua-sdk-platform.js";

const factory = function factory(_partial: Record<string, unknown>): Record<string, unknown> {
  return {};
};
Object.assign(factory, { new: (partial: Record<string, unknown>) => partial, create: (partial: Record<string, unknown>) => partial });
const inputFactory = factory as unknown as InputFactory<unknown>;
const fakeModule = {
  CuaDriver: { connect: () => { throw new Error("not used"); } },
  StartSessionInput: inputFactory,
  EndSessionInput: inputFactory,
  GetSessionInput: inputFactory,
  GetSessionStateInput: inputFactory,
  VerifyStateInput: inputFactory,
  StatePredicate: inputFactory,
  WindowPredicate: inputFactory,
  BoundsExpectation: inputFactory,
} as unknown as CuaSdkModule;

afterEach(() => setCuaSdkModuleLoaderForTests(undefined));

describe("CUA SDK platform routing", () => {
  it("selects the accepted SDK pairing for each supported desktop platform", () => {
    expect(cuaSdkVersionForPlatform("win32")).toBe("0.22.2");
    expect(cuaSdkVersionForPlatform("darwin")).toBe("0.22.2");
    expect(cuaSdkVersionForPlatform("linux")).toBe("0.32.0");
    expect(cuaSdkAliasForPlatform("win32")).toBe("@trycua/cua-driver-0.22.2");
    expect(cuaSdkAliasForPlatform("darwin")).toBe("@trycua/cua-driver-0.22.2");
    expect(cuaSdkAliasForPlatform("linux")).toBe("@trycua/cua-driver-0.32.0");
  });

  it("caches by routed SDK alias so explicit platform loads cannot reuse the wrong SDK", async () => {
    const loadedAliases: string[] = [];
    setCuaSdkModuleLoaderForTests(async (alias) => {
      loadedAliases.push(alias);
      return fakeModule;
    });

    const [windows, macA, macB, linuxA, linuxB] = await Promise.all([
      loadCuaSdkModule("win32"),
      loadCuaSdkModule("darwin"),
      loadCuaSdkModule("darwin"),
      loadCuaSdkModule("linux"),
      loadCuaSdkModule("linux"),
    ]);

    expect(windows).toBe(macA);
    expect(macA).toBe(macB);
    expect(linuxA).toBe(linuxB);
    expect(loadedAliases).toEqual(["@trycua/cua-driver-0.22.2", "@trycua/cua-driver-0.32.0"]);
  });
});
