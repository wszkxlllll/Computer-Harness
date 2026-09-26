import { loadRelayConfig } from "./config.js";
import { createRelayServer } from "./server.js";

async function main(): Promise<void> {
  const configPath = process.env.RELAY_CONFIG_FILE;
  if (configPath === undefined || configPath.length === 0) {
    throw new Error("set RELAY_CONFIG_FILE to a private JSON configuration file");
  }
  const config = await loadRelayConfig(configPath);
  const relay = createRelayServer(config);
  await relay.listen();
  const address = relay.server.address();
  const bound = typeof address === "object" && address !== null ? `${address.address}:${address.port}` : "unknown";
  process.stdout.write(`Harness relay listening on ${bound}; public origin ${new URL(config.publicOrigin).origin}\n`);
  const stop = () => {
    void relay.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown startup error";
  process.stderr.write(`Harness relay could not start: ${message}\n`);
  process.exitCode = 1;
});
