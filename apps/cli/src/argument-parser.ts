const VALUE_OPTIONS = new Set([
  "--goal",
  "--model",
  "--computer",
  "--cua-socket",
  "--socket",
  "--osworld-bridge",
  "--cua-window-pid",
  "--cua-window-id",
  "--managed-browser-url",
  "--managed-browser-profile-mode",
  "--managed-browser-profile-label",
  "--output",
  "--max-steps",
  "--max-model-requests",
  "--env-file",
  "--screenshot-dir",
  "--qwen-coordinate-mode",
  "--qwen-thinking",
  "--qwen-output-mode",
  "--profile",
  "--risk-guard",
  "--risk-model",
  "--risk-max-model-requests",
  "--risk-timeout-ms",
  "--cleanup-deadline-ms",
  "--doctor-timeout-ms",
  "--memory",
  "--memory-retrieval",
  "--memory-embedding-endpoint",
  "--batching",
  "--context-mode",
  "--context-max-events",
  "--context-max-tokens",
  "--fixture-result",
  "--monitor",
  "--grounding",
  "--window-selection",
]);

const FLAG_OPTIONS = new Set([
  "--doctor",
  "--prepare-managed-browser-profile",
  "--interactive",
  "--tui",
  "--planning",
  "--window-switch",
  "--confirm-risk-guard-off",
  "--allow-window-title-sharing",
  "--help",
  "-h",
]);

/**
 * Validate the CLI wire syntax before any option is consumed.  The CLI has
 * no positional arguments; a value must follow every value-taking option.
 * Keeping this list centralized makes removed options fail closed instead of
 * silently disappearing from the parsed configuration.
 */
export function validateCliArguments(rawArgv: readonly string[]): readonly string[] {
  const argv = rawArgv[0] === "--" ? rawArgv.slice(1) : rawArgv;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (!FLAG_OPTIONS.has(argument) && !VALUE_OPTIONS.has(argument)) {
      throw new Error(`unknown option or positional argument: ${argument}`);
    }
    if (VALUE_OPTIONS.has(argument)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      index += 1;
    }
  }
  return argv;
}
