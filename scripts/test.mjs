import { spawnSync } from "node:child_process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const vitestArgs = ["exec", "vitest", "run"];
if (process.env.CI === "true") {
  vitestArgs.push("--reporter=default", "--reporter=junit", "--outputFile=.ci-reports/vitest.xml");
}

function run(command, args) {
  // Node 24+ on Windows cannot spawn a .cmd shim directly (EINVAL). Only
  // this script's fixed pnpm arguments are sent through cmd.exe.
  const executable = process.platform === "win32" && command.endsWith(".cmd") ? "cmd.exe" : command;
  const invocation = executable === "cmd.exe" ? ["/d", "/s", "/c", [command, ...args].join(" ")] : args;
  const result = spawnSync(executable, invocation, { stdio: "inherit" });
  if (result.error !== undefined) {
    console.error(result.error);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(pnpm, vitestArgs);
run(process.execPath, [
  "--test",
  "scripts/execution-segment-api-conformance-metrics.test.mjs",
  "scripts/travel/metrics.test.mjs",
  "scripts/travel/travel.test.mjs",
  "scripts/travel/tui-collector.test.mjs",
]);
