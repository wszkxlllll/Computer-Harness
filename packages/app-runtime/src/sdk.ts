import type { ResolvedRunConfig, RunDependencies, RunHandle } from "./config.js";
import { createRun } from "./run-factory.js";

/** A Run factory assembled with application-owned adapters and policies. */
export type RunFactory = (config: ResolvedRunConfig) => Promise<RunHandle>;

/**
 * Capture the application dependency factories once and invoke them for each
 * Run. Applications should have the Provider and Computer factories return
 * fresh, Run-owned adapter instances.
 */
export function createRunFactory(dependencies: RunDependencies = {}): RunFactory {
  const capturedDependencies = copyDependencies(dependencies);

  return (config) => createRun(config, copyDependencies(capturedDependencies));
}

function copyDependencies(dependencies: RunDependencies): RunDependencies {
  return {
    ...dependencies,
    ...(dependencies.credentials === undefined ? {} : { credentials: { ...dependencies.credentials } }),
    ...(dependencies.computerFactoryDependencies === undefined
      ? {}
      : { computerFactoryDependencies: { ...dependencies.computerFactoryDependencies } }),
  };
}
