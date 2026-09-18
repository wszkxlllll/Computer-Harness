import { describe, expect, it, vi } from "vitest";
import type { Computer } from "@computer-harness/runtime";
import { createComputer } from "./computers.js";

describe("createComputer", () => {
  it("does not resolve the CUA module for the OSWorld backend", async () => {
    const importCuaComputer = vi.fn(async () => {
      throw new Error("native binding should not be loaded");
    });

    const computer = await createComputer(
      { kind: "osworld", bridgeUrl: "http://127.0.0.1:5000" },
      { importCuaComputer },
    );

    expect(computer).toBeDefined();
    expect(importCuaComputer).not.toHaveBeenCalled();
  });

  it("reports a CUA module load failure without exposing it as another backend failure", async () => {
    const bindingError = new Error("native binding unavailable");

    await expect(createComputer(
      { kind: "cua", socketPath: "fixture.sock", screenshotDir: "screenshots" },
      { importCuaComputer: async () => Promise.reject(bindingError) },
    )).rejects.toMatchObject({
      message: expect.stringContaining("native @trycua/cua-driver platform binding"),
      cause: bindingError,
    });
  });

  it("does not relabel constructor failures as native binding load failures", async () => {
    const constructorError = new Error("invalid CUA configuration");
    class FailingComputer {
      public constructor() {
        throw constructorError;
      }
    }

    await expect(createComputer(
      { kind: "cua", socketPath: "fixture.sock", screenshotDir: "screenshots" },
      { importCuaComputer: async () => ({ CuaDriverComputer: FailingComputer as unknown as new () => Computer }) },
    )).rejects.toBe(constructorError);
  });

  it("passes an explicit CUA window target without changing the default backend path", async () => {
    let received: Record<string, unknown> | undefined;
    class CapturingComputer {
      public constructor(options: Record<string, unknown>) {
        received = options;
      }
    }

    await createComputer(
      { kind: "cua", socketPath: "fixture.sock", screenshotDir: "screenshots", windowTarget: { pid: 1234, windowId: 5678 } },
      { importCuaComputer: async () => ({ CuaDriverComputer: CapturingComputer as unknown as new (options: Record<string, unknown>) => Computer }) },
    );

    expect(received).toMatchObject({ socketPath: "fixture.sock", screenshotDir: "screenshots", windowTarget: { pid: 1234, windowId: 5678 } });
  });
});
