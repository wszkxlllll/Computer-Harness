import test from "node:test";
import assert from "node:assert/strict";
import { validateReceipts } from "./validate-b3-reset-receipts.mjs";

const baseReceipt = {
  schemaVersion: "member-b-b3-reset-receipt-v1",
  taskId: "MB-SHOP-F04-v1",
  instanceId: "SHOP-F04-v1",
  manifestId: "member-b-b3-shopping-development-v0",
  seedId: "shopping-b3-synthetic-v0",
  fixtureVersion: "member-b-b3-shopping-fixture-v0",
  controllerId: "cua-local-controller",
  observedAt: "2026-09-23T09:00:00.000Z",
  stateHash: "sha256:verified-empty-state",
  resetReceipt: {
    status: "completed",
    executed: true,
    method: "ui_reset_button",
    verifiedEmptyState: true,
  },
  provenance: { source: "environment-controller", runId: "local-reset-001" },
  evidenceRefs: ["screenshot:runs/member-b/reset-shop-f04-v1.png"],
};

test("accepts a controller receipt for a known binding", async () => {
  const output = await validateReceipts(baseReceipt);
  assert.equal(output.status, "passed");
  assert.equal(output.acceptedCount, 1);
});

test("rejects a receipt that only claims completed without provenance and empty-state proof", async () => {
  const output = await validateReceipts({
    ...baseReceipt,
    resetReceipt: { status: "completed", executed: true },
    provenance: { source: "manual-json" },
    evidenceRefs: [],
  });
  assert.equal(output.status, "blocked");
  assert.equal(output.rejectedCount, 1);
  assert.ok(output.results[0].errors.some((error) => error.includes("verifiedEmptyState")));
  assert.ok(output.results[0].errors.some((error) => error.includes("provenance.source")));
  assert.ok(output.results[0].errors.some((error) => error.includes("evidenceRefs")));
});

test("rejects an unknown task/instance instead of creating a new binding", async () => {
  const output = await validateReceipts({ ...baseReceipt, taskId: "MB-SHOP-F99-v1", instanceId: "SHOP-F99-v1" });
  assert.equal(output.status, "blocked");
  assert.match(output.results[0].errors[0], /aggregate development binding/u);
});

test("rejects a receipt whose seed or manifest is attached to the wrong instance", async () => {
  const output = await validateReceipts({ ...baseReceipt, seedId: "wrong-seed", manifestId: "wrong-manifest" });
  assert.equal(output.status, "blocked");
  assert.ok(output.results[0].errors.some((error) => error.includes("manifestId")));
  assert.ok(output.results[0].errors.some((error) => error.includes("seedId")));
});
