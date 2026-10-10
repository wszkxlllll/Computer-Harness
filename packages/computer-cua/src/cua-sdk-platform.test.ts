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

const resolverModule = { resolveLibPath: () => { throw new Error("resolver must not be called"); } };

function fakeRequire(resolverPath: string, calls: string[]): NodeJS.Require {
  const required = ((specifier: string) => {
    calls.push(`require:${specifier}`);
    return resolverModule;
  }) as NodeJS.Require;
  required.resolve = Object.assign((specifier: string) => {
    calls.push(`require.resolve:${specifier}`);
    return resolverPath;
  }, { paths: () => [] });
  return required;
}

function importDependencies(overrides: Partial<{
  resolve: (specifier: string) => string;
  realpath: (path: string) => Promise<string>;
  createRequire: (url: string) => NodeJS.Require;
  runtimePlatform: () => NodeJS.Platform;
  importModule: (url: string) => Promise<CuaSdkModule>;
}> = {}) {
  const entryPath = resolve("fixture", "sdk", "index.js");
  const calls: string[] = [];
  return {
    calls,
    dependencies: {
      resolve: (specifier: string) => pathToFileURL(entryPath).href,
      realpath: async (path: string) => path,
      createRequire: (url: string) => fakeRequire(resolve("fixture", "node_modules", "resolve-lib.js"), calls),
      runtimePlatform: () => "win32" as NodeJS.Platform,
      importModule: async () => fakeModule,
      ...overrides,
    },
  };
}

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
    const resolverPath = resolve("fixture", "规范 SDK", "node_modules", "@ubjs", "node", "resolve-lib.js");
    setCuaSdkModuleImportDependenciesForTests({
      resolve: (specifier) => {
        calls.push(`resolve:${specifier}`);
        return pathToFileURL(aliasEntryPath).href;
      },
      realpath: async (path) => {
        calls.push(`realpath:${path}`);
        return path === fileURLToPath(pathToFileURL(aliasEntryPath)) ? canonicalEntryPath : resolverPath;
      },
      createRequire: (url) => {
        calls.push(`createRequire:${url}`);
        return fakeRequire(resolverPath, calls);
      },
      runtimePlatform: () => "darwin",
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
      `createRequire:${pathToFileURL(canonicalEntryPath).href}`,
      "require.resolve:@ubjs/node/typescript/dist/resolve-lib.js",
      `realpath:${resolverPath}`,
      `require:${resolverPath}`,
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
      createRequire: () => { throw new Error("must not create require"); },
      runtimePlatform: () => "darwin",
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
      createRequire: () => { throw new Error("non-Darwin test route must not prime"); },
      runtimePlatform: () => "win32" as NodeJS.Platform,
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
        createRequire: () => { throw new Error("non-Darwin test route must not prime"); },
        runtimePlatform: () => "win32",
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

  it("primes only on the actual Darwin runtime, regardless of the requested shared alias", async () => {
    const calls: string[] = [];
    const entryPath = resolve("fixture", "canonical", "sdk", "index.js");
    const resolverPath = resolve("fixture", "canonical", "node_modules", "resolve-lib.js");
    const setup = importDependencies({
      resolve: () => pathToFileURL(entryPath).href,
      realpath: async (path) => path,
      runtimePlatform: () => "darwin",
      createRequire: (url) => {
        calls.push(`createRequire:${url}`);
        const req = fakeRequire(resolverPath, calls);
        return req;
      },
      importModule: async (url) => {
        calls.push(`import:${url}`);
        return fakeModule;
      },
    });
    setCuaSdkModuleImportDependenciesForTests(setup.dependencies);

    await expect(loadCuaSdkModule("win32")).resolves.toBe(fakeModule);
    expect(calls).toEqual([
      `createRequire:${pathToFileURL(entryPath).href}`,
      "require.resolve:@ubjs/node/typescript/dist/resolve-lib.js",
      `require:${resolverPath}`,
      `import:${pathToFileURL(entryPath).href}`,
    ]);
  });

  it("does not prime for explicit Darwin routing on a non-Darwin runtime", async () => {
    const setup = importDependencies({
      runtimePlatform: () => "linux",
      createRequire: () => { throw new Error("must not prime on Linux"); },
    });
    setCuaSdkModuleImportDependenciesForTests(setup.dependencies);
    await expect(loadCuaSdkModule("darwin")).resolves.toBe(fakeModule);
  });

  it.each([
    ["win32", "win32"],
    ["linux", "linux"],
  ] as const)("does not prime on the %s runtime", async (runtimePlatform, requestedPlatform) => {
    const setup = importDependencies({
      runtimePlatform: () => runtimePlatform,
      createRequire: () => { throw new Error("non-Darwin runtime must not prime"); },
    });
    setCuaSdkModuleImportDependenciesForTests(setup.dependencies);
    await expect(loadCuaSdkModule(requestedPlatform)).resolves.toBe(fakeModule);
  });

  it("fails closed before SDK import when resolver resolution, realpath, or require fails", async () => {
    const resolverPath = resolve("fixture", "resolver.js");
    for (const failure of ["resolution", "realpath", "require"] as const) {
      let importCalls = 0;
      const calls: string[] = [];
      const setup = importDependencies({
        runtimePlatform: () => "darwin",
        createRequire: () => {
          const required = ((specifier: string) => {
            calls.push(`require:${specifier}`);
            if (failure === "require") throw new Error("private failure");
            return resolverModule;
          }) as NodeJS.Require;
          required.resolve = Object.assign((specifier: string) => {
            calls.push(`require.resolve:${specifier}`);
            if (failure === "resolution") throw new Error("private failure");
            return resolverPath;
          }, { paths: () => [] });
          return required;
        },
        realpath: async (path) => {
          if (failure === "realpath" && path === resolverPath) throw new Error("private failure");
          return path;
        },
        importModule: async () => { importCalls += 1; return fakeModule; },
      });
      setCuaSdkModuleImportDependenciesForTests(setup.dependencies);
      await expect(loadCuaSdkModule("darwin")).rejects.toThrow("CUA SDK resolver preload failed");
      expect(importCalls).toBe(0);
      expect(calls.some((call) => call.includes("private failure"))).toBe(false);
    }
  });

  it("evicts a failed Darwin resolver-preload promise for a later explicit call", async () => {
    let requireAttempts = 0;
    let importCalls = 0;
    const resolverPath = resolve("fixture", "resolver.js");
    const setup = importDependencies({
      runtimePlatform: () => "darwin",
      createRequire: () => {
        requireAttempts += 1;
        if (requireAttempts === 1) {
          const required = (() => { throw new Error("private failure"); }) as unknown as NodeJS.Require;
          required.resolve = Object.assign(() => resolverPath, { paths: () => [] });
          return required;
        }
        return fakeRequire(resolverPath, setup.calls);
      },
      importModule: async () => { importCalls += 1; return fakeModule; },
    });
    setCuaSdkModuleImportDependenciesForTests(setup.dependencies);

    await expect(loadCuaSdkModule("darwin")).rejects.toThrow("CUA SDK resolver preload failed");
    await expect(loadCuaSdkModule("darwin")).resolves.toBe(fakeModule);
    expect(requireAttempts).toBe(2);
    expect(importCalls).toBe(1);
  });

  it("rejects unsafe resolver export shapes without invoking getters or proxies", async () => {
    let getterCalls = 0;
    let proxyCalls = 0;
    let importCalls = 0;
    const setup = importDependencies({
      runtimePlatform: () => "darwin",
      importModule: async () => { importCalls += 1; return fakeModule; },
    });
    const requireFactory = (moduleValue: unknown): NodeJS.Require => {
      const req = (() => moduleValue) as unknown as NodeJS.Require;
      req.resolve = Object.assign(() => resolve("fixture", "resolver.js"), { paths: () => [] });
      return req;
    };
    for (const moduleValue of [
      () => undefined,
      new Proxy({ resolveLibPath() {} }, { getOwnPropertyDescriptor(target, key) { proxyCalls += 1; return Reflect.getOwnPropertyDescriptor(target, key); } }),
      Object.defineProperty({}, "resolveLibPath", { get() { getterCalls += 1; return () => undefined; } }),
      Object.create(Object.defineProperty({}, "resolveLibPath", { get() { getterCalls += 1; return () => undefined; } })),
      { resolveLibPath: new Proxy(() => undefined, { apply() { proxyCalls += 1; return undefined; } }) },
      { resolveLibPath: undefined },
    ]) {
      setCuaSdkModuleImportDependenciesForTests({
        ...setup.dependencies,
        createRequire: () => requireFactory(moduleValue),
      });
      await expect(loadCuaSdkModule("darwin")).rejects.toThrow("CUA SDK resolver preload failed");
      expect(importCalls).toBe(0);
    }
    expect(getterCalls).toBe(0);
    expect(proxyCalls).toBe(0);
  });

  it("keeps the injected module loader ahead of resolver priming", async () => {
    let primingCalls = 0;
    setCuaSdkModuleImportDependenciesForTests(importDependencies({
      runtimePlatform: () => "darwin",
      createRequire: () => { primingCalls += 1; throw new Error("must not prime"); },
    }).dependencies);
    setCuaSdkModuleLoaderForTests(async () => fakeModule);
    await expect(loadCuaSdkModule("darwin")).resolves.toBe(fakeModule);
    expect(primingCalls).toBe(0);
  });
});
