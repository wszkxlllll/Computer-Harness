import fs from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createDurableFetchGuard,
  DEFAULT_BATCH_LIMITS,
  DEFAULT_RUN_RESERVATION,
  initializeBatch,
  installGuard,
} from "./batch-fetch-guard.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const usage = "Usage: node scripts/autonomous/batch-host.mjs --batch-root <private-dir> --batch-id <id> --reservation-id <id> [--entry host|cli] [--initialize] -- <entry args...>";

function parse(args) {
  const values = new Map();
  let separator = args.indexOf("--");
  if (separator < 0) separator = args.length;
  const hostArgs = args.slice(separator + (separator < args.length ? 1 : 0));
  for (let i = 0; i < separator; i += 1) {
    const key = args[i];
    if (!key?.startsWith("--")) throw new Error(usage);
    if (key === "--initialize") { if (values.has(key)) throw new Error(usage); values.set(key, true); continue; }
    const value = args[++i];
    if (value === undefined || value.startsWith("--") || values.has(key)) throw new Error(usage);
    values.set(key, value);
  }
  const root = values.get("--batch-root"), batchId = values.get("--batch-id"), reservationId = values.get("--reservation-id");
  if (typeof root !== "string" || resolve(root) !== root || typeof batchId !== "string" || typeof reservationId !== "string") throw new Error(usage);
  const entry = values.get("--entry") ?? "host";
  if (entry !== "host" && entry !== "cli") throw new Error("ENTRY_REFUSED");
  return { root, batchId, reservationId, entry, initialize: values.get("--initialize") === true, hostArgs };
}

const options = parse(process.argv.slice(2));
if (options.initialize) {
  if (options.hostArgs.length > 0) throw new Error(usage);
  initializeBatch(options.root, { batchId: options.batchId, reservationId: options.reservationId, limits: DEFAULT_BATCH_LIMITS, reservation: DEFAULT_RUN_RESERVATION });
  process.stdout.write("A01 batch counter initialized; reserved main=40 risk=2 total=42; actual=0.\n");
  process.exit(0);
}

const entryPath = resolve(repositoryRoot, "apps", options.entry, "dist/index.js");
if (fs.realpathSync(entryPath) !== entryPath) throw new Error("ENTRY_PATH_REFUSED");
if (options.hostArgs.length === 0) throw new Error(usage);
const guard = createDurableFetchGuard({
  root: options.root,
  batchId: options.batchId,
  reservationId: options.reservationId,
  delegate: globalThis.fetch,
});
installGuard(globalThis, guard);
process.once("exit", () => guard.close());
process.argv = [process.execPath, entryPath, ...options.hostArgs];
await import(pathToFileURL(entryPath).href);
