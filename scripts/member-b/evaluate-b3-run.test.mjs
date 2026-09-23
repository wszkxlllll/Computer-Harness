import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateRunDirectory } from "./evaluate-b3-run.mjs";

async function makeFixture(instanceId = "COMM-F03-v1", receiptOverrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "member-b-evaluator-"));
  const aggregate = JSON.parse(await readFile("eval/member-b/b3-development-manifest.v0.json", "utf8"));
  const binding = aggregate.bindings.find((item) => item.instanceId === instanceId);
  const receipt = {
    schemaVersion: "member-b-b3-reset-receipt-v1",
    ...binding,
    controllerId: "test-controller",
    observedAt: "2026-09-23T09:00:00.000Z",
    stateHash: "sha256:test-empty-state",
    provenance: { source: "environment-controller", runId: "test-run" },
    evidenceRefs: ["screenshot:test.png"],
    resetReceipt: { status: "completed", executed: true, method: "ui_reset_button", verifiedEmptyState: true },
    ...receiptOverrides,
  };
  const runDir = join(root, "run");
  const receiptPath = join(root, "reset-receipt.json");
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "summary.json"), JSON.stringify({
    runId: "runtime-run-001",
    modelSummary: "已保存草稿，状态：未发送。主题测试材料确认，正文这是合成测试草稿：已收到测试材料，将在约定时间前完成核对。",
    trajectory: join(runDir, "trajectory.jsonl"),
  }));
  await writeFile(receiptPath, JSON.stringify(receipt));
  return { root, runDir, receiptPath };
}

test("writes a full evaluation and projection for a verified local run", async () => {
  const fixture = await makeFixture();
  const result = await evaluateRunDirectory(fixture);
  assert.equal(result.result.taskSatisfied, true);
  assert.equal(result.result.completionLevel, "draft_prepared");
  assert.ok(result.result.evidenceRefs.some((ref) => ref.startsWith("reset-receipt:")));
  const projection = JSON.parse(await readFile(join(fixture.runDir, "evaluation-projection.json"), "utf8"));
  assert.deepEqual(projection, { success: true, reason: "none" });
});

test("records an invalid reset receipt as an environment block", async () => {
  const fixture = await makeFixture({ resetReceipt: { status: "pending", executed: false } });
  const result = await evaluateRunDirectory(fixture);
  assert.equal(result.result.taskSatisfied, null);
  assert.equal(result.result.failureClass, "environment");
  assert.equal(result.result.reason, "reset_receipt_validation_failed");
  const projection = JSON.parse(await readFile(join(fixture.runDir, "evaluation-projection.json"), "utf8"));
  assert.deepEqual(projection, { success: false, reason: "environment" });
});

test("uses a user-input clarification from the trajectory when summary has no final answer", async () => {
  const fixture = await makeFixture("COMM-F09-v1");
  await writeFile(join(fixture.runDir, "summary.json"), JSON.stringify({
    runId: "runtime-run-clarification",
    modelSummary: null,
    trajectory: join(fixture.runDir, "trajectory.jsonl"),
  }));
  await writeFile(join(fixture.runDir, "trajectory.jsonl"), `${JSON.stringify({
    type: "user.input.requested",
    question: "候选安排一与候选安排二在10:30–11:00冲突；候选安排一还与已有的测试设备检查在10:00–10:30冲突。请确认最终采用哪一个安排，我不会自行选择。",
  })}\n`);
  const result = await evaluateRunDirectory({ ...fixture, receiptPath: fixture.receiptPath, outputDir: fixture.runDir });
  assert.equal(result.answerSource, "trajectory.user.input.requested");
  assert.equal(result.result.taskSatisfied, true);
});
