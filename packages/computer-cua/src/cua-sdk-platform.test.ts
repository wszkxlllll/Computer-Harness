import { afterEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  cuaSdkAliasForPlatform,
  cuaSdkVersionForPlatform,
  loadCuaSdkModule,
  setCuaSdkModuleImportDependenciesForTests,
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

afterEach(() => {
  setCuaSdkModuleLoaderForTests(undefined);
  setCuaSdkModuleImportDependenciesForTests(undefined);
});

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

  it("resolves the default route, canonicalizes its file entry, then imports exactly once", async () => {
    const calls: string[] = [];
    const aliasEntryPath = resolve("fixture", "别名 SDK", "node_modules", "@trycua", "cua-driver-0.22.2", "dist", "index.js");
    const canonicalEntryPath = resolve("fixture", "规范 SDK", "node_modules", ".pnpm", "cua-driver@0.22.2", "node_modules", "@trycua", "cua-driver", "dist", "index.js");
    setCuaSdkModuleImportDependenciesForTests({
      resolve: (specifier) => {
        calls.push(`resolve:${specifier}`);
        return pathToFileURL(aliasEntryPath).href;
      },
      realpath: async (path) => {
        calls.push(`realpath:${path}`);
        return canonicalEntryPath;
      },
      importModule: async (url) => {
        calls.push(`import:${url}`);
        return fakeModule;
      },
    });

    const [first, second] = await Promise.all([loadCuaSdkModule("darwin"), loadCuaSdkModule("darwin")]);

    expect(first).toBe(fakeModule);
    expect(second).toBe(fakeModule);
    expect(calls).toEqual([
      "resolve:@trycua/cua-driver-0.22.2",
      `realpath:${fileURLToPath(pathToFileURL(aliasEntryPath))}`,
      `import:${pathToFileURL(canonicalEntryPath).href}`,
    ]);
  });

  it("refuses non-file entries before realpath or import", async () => {
    let realpathCalls = 0;
    let importCalls = 0;
    setCuaSdkModuleImportDependenciesForTests({
      resolve: () => "https://example.invalid/sdk.js",
      realpath: async (path) => {
        realpathCalls += 1;
        return path;
      },
      importModule: async () => {
        importCalls += 1;
        return fakeModule;
      },
    });

    await expect(loadCuaSdkModule("darwin")).rejects.toThrow("CUA SDK entry must resolve to a file URL");
    expect(realpathCalls).toBe(0);
    expect(importCalls).toBe(0);
  });

  it("clears the prior default-route test dependencies when the seam is reset", async () => {
    const calls: string[] = [];
    const entryPath = resolve("fixture", "sdk", "index.js");
    const dependencies = (label: string) => ({
      resolve: (specifier: string) => {
        calls.push(`${label}:resolve:${specifier}`);
        return pathToFileURL(entryPath).href;
      },
      realpath: async (path: string) => {
        calls.push(`${label}:realpath:${path}`);
        return path;
      },
      importModule: async (url: string) => {
        calls.push(`${label}:import:${url}`);
        return fakeModule;
      },
    });
    setCuaSdkModuleImportDependenciesForTests(dependencies("stale"));
    setCuaSdkModuleImportDependenciesForTests(undefined);
    setCuaSdkModuleImportDependenciesForTests(dependencies("current"));

    await expect(loadCuaSdkModule("darwin")).resolves.toBe(fakeModule);
    expect(calls.every((call) => call.startsWith("current:"))).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it("evicts failed default resolution, realpath, and import promises for a later retry", async () => {
    for (const failure of ["resolve", "realpath", "import"] as const) {
      let resolveCalls = 0;
      let realpathCalls = 0;
      let importCalls = 0;
      const aliasPath = resolve("fixture", "sdk", "index.js");
      setCuaSdkModuleImportDependenciesForTests({
        resolve: () => {
          resolveCalls += 1;
          if (failure === "resolve") throw new Error("resolve failed");
          return pathToFileURL(aliasPath).href;
        },
        realpath: async (path) => {
          realpathCalls += 1;
          if (failure === "realpath") throw new Error("realpath failed");
          return path;
        },
        importModule: async () => {
          importCalls += 1;
          if (failure === "import") throw new Error("import failed");
          return fakeModule;
        },
      });

      await expect(loadCuaSdkModule("darwin")).rejects.toThrow();
      await expect(loadCuaSdkModule("darwin")).rejects.toThrow();
      expect(resolveCalls).toBe(2);
      expect(realpathCalls).toBe(failure === "resolve" ? 0 : 2);
      expect(importCalls).toBe(failure === "import" ? 2 : 0);
    }
  });
});
