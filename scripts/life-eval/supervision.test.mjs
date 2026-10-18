import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSupervisionBridge,
  inspectSupervision,
  readSupervision,
  readSupervisionReceipt,
  SUPERVISION_HELP,
  submitSupervisionCommand,
} from "./supervision.mjs";

const policyVersion = "evidence-triggered-no-scripted-corrections-v1";
const runId = "run-20261018-actual-controller-id";
const observationId = "observation-latest-1";
const screenshotRelativePath = "screenshots/asset-a1b2c3.png";

async function createPackage(tempRoot, { mode = "dynamic", variant = mode === "dynamic" ? "C" : "A", evidenceFresh = true } = {}) {
  const packageId = `G01-${variant}-20261018-a1b2c3d4`;
  const packageDir = join(tempRoot, packageId);
  const attemptId = "live-2026-10-18T00-00-00.000Z-a1b2c3d4";
  const attemptDir = join(packageDir, "attempts", attemptId);
  const outputBase = join(packageDir, "runtime-output");
  const outputAttemptDir = join(tempRoot, "documents", "G01", variant, packageId);
  const runtimeDir = join(outputBase, runId);
  const screenshotPath = join(runtimeDir, "assets", "screenshots", "asset-a1b2c3.png");
  await mkdir(join(attemptDir, "supervision-commands"), { recursive: true });
  await mkdir(join(runtimeDir, "assets", "screenshots"), { recursive: true });
  await mkdir(outputAttemptDir, { recursive: true });
  const plan = {
    schemaVersion: 1,
    suiteId: "life-business-six-domain-20261018",
    packageId,
    packageDir,
    selection: { variant, outputAttemptDir },
    cli: { argvTemplate: ["--goal", "Inspect", "--output", outputBase] },
    configuration: {
      monitor: "guidance",
      planning: variant === "B" || variant === "D",
      memory: variant === "B" || variant === "D" ? "facts" : "off",
      memoryRetrieval: variant === "B" || variant === "D" ? "lexical" : "off",
      supervision: { mode, policyVersion },
    },
  };
  const record = {
    packageId,
    stdoutLog: join(attemptDir, "stdout.log"),
    supervision: { mode, attemptId },
  };
  const observation = {
    id: observationId,
    runId,
    computerSessionId: "fixture-session",
    surfaceRef: { surfaceId: "surface-1", generation: 1, kind: "desktop" },
    capturedAt: "2026-10-18T00:00:01.000Z",
    viewport: { width: 800, height: 600, coordinateSpace: "physical" },
    screenshot: { assetId: "asset-a1b2c3", relativePath: screenshotRelativePath, mediaType: "image/png", byteLength: 4 },
  };
  const events = [
    { schemaVersion: 2, runId, eventId: "event-created", sequence: 0, occurredAt: "2026-10-18T00:00:00.000Z", type: "run.created", goal: "Inspect current page" },
    { schemaVersion: 2, runId, eventId: "event-started", sequence: 1, occurredAt: "2026-10-18T00:00:00.500Z", type: "run.started" },
    { schemaVersion: 2, runId, eventId: "event-observation", sequence: 2, occurredAt: "2026-10-18T00:00:01.000Z", type: "observation.created", observation },
    { schemaVersion: 2, runId, eventId: "event-provider", sequence: 3, occurredAt: "2026-10-18T00:00:02.000Z", type: "model.request.started", providerId: "fixture" },
  ];
  const state = {
    schemaVersion: 1,
    packageId,
    attemptId,
    mode,
    runId,
    status: "running",
    currentSequence: 3,
    evidenceSequence: 2,
    evidenceFresh,
    latestObservation: { id: observationId, sequence: 2, capturedAt: observation.capturedAt, screenshot: observation.screenshot },
    terminal: false,
    updatedAt: "2026-10-18T00:00:02.000Z",
  };
  await writeFile(join(packageDir, "plan.json"), `${JSON.stringify(plan)}\n`, "utf8");
  await writeFile(join(packageDir, "live-attempt.json"), `${JSON.stringify(record)}\n`, "utf8");
  await writeFile(join(attemptDir, "supervision-state.jsonl"), `${JSON.stringify(state)}\n`, "utf8");
  await writeFile(join(runtimeDir, "trajectory.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  await writeFile(screenshotPath, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  return { packageId, packageDir, attemptId, attemptDir, outputBase, outputAttemptDir, screenshotPath, plan, state };
}

async function appendLaterObservationAndAction(fixture) {
  const runtimeDir = join(fixture.outputBase, runId);
  const trajectoryPath = join(runtimeDir, "trajectory.jsonl");
  const events = (await readFile(trajectoryPath, "utf8")).trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  const sourceEvent = events.find((event) => event.type === "observation.created");
  assert.ok(sourceEvent);
  const observation = {
    ...sourceEvent.observation,
    id: "observation-latest-2",
    capturedAt: "2026-10-18T00:00:04.000Z",
    surfaceRef: { ...sourceEvent.observation.surfaceRef, generation: 2 },
    screenshot: { ...sourceEvent.observation.screenshot, assetId: "asset-c3d4", relativePath: "screenshots/asset-c3d4.png" },
  };
  const laterEvents = [
    { schemaVersion: 2, runId, eventId: "event-observation-later", sequence: 4, occurredAt: observation.capturedAt, type: "observation.created", observation },
    { schemaVersion: 2, runId, eventId: "event-action-started-later", sequence: 5, occurredAt: "2026-10-18T00:00:05.000Z", type: "action.execution.started", action: { kind: "wait", durationMs: 1 } },
  ];
  await writeFile(join(runtimeDir, "assets", "screenshots", "asset-c3d4.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(trajectoryPath, `${[...events, ...laterEvents].map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  fixture.state = {
    ...fixture.state,
    currentSequence: 5,
    evidenceSequence: 5,
    evidenceFresh: false,
    latestObservation: { id: observation.id, sequence: 4, capturedAt: observation.capturedAt, screenshot: observation.screenshot },
    updatedAt: "2026-10-18T00:00:05.000Z",
  };
  await writeFile(join(fixture.attemptDir, "supervision-state.jsonl"), `${JSON.stringify(fixture.state)}\n`, "utf8");
  return { evidenceSequence: sourceEvent.sequence, observationId: sourceEvent.observation.id };
}

async function writeCorrectionText(tempRoot) {
  const path = join(tempRoot, "correction.txt");
  await writeFile(path, "请重新查看当前结果页，说明你实际看到的内容后再继续原任务。", { encoding: "utf8" });
  const readBack = await readFile(path, "utf8");
  assert.match(readBack, /重新查看当前结果页/u);
  assert.doesNotMatch(readBack, /\uFFFD|\?{3,}|_{2,}/u);
  return path;
}

function fakeChild(onSend) {
  const child = new EventEmitter();
  child.connected = true;
  child.exitCode = null;
  child.signalCode = null;
  child.send = (message, _sendHandle, _options, callback) => {
    onSend(message);
    callback?.(null);
    return true;
  };
  return child;
}

async function waitForReceipt(packageDir, commandId, expectedStatus) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const receipt = await readSupervisionReceipt(packageDir, commandId);
    if (receipt.status === expectedStatus) return receipt;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  assert.fail(`receipt ${commandId} did not reach ${expectedStatus}`);
}

test("inspect/read uses the frozen package runtime-output RunId and never the document deliverable directory", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "life-eval-supervision-read-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const fixture = await createPackage(tempRoot);

  const inspected = await inspectSupervision(fixture.packageDir);
  assert.equal(inspected.packageId, fixture.packageId);
  assert.equal(inspected.runId, runId);
  assert.equal(inspected.status, "running");
  assert.equal(inspected.terminal, false);
  assert.equal(inspected.evidenceSequence, 2);
  assert.equal(inspected.evidenceFresh, true);
  assert.equal(inspected.latestObservation.id, observationId);
  const read = await readSupervision(fixture.packageDir, { afterSequence: 1, limit: 10 });
  assert.equal(read.trajectoryPath, join(fixture.outputBase, runId, "trajectory.jsonl"));
  assert.equal(read.latestScreenshotPath, fixture.screenshotPath);
  assert.notEqual(read.latestScreenshotPath, fixture.outputAttemptDir);
  assert.equal(read.events.some((event) => event.type === "observation.created"), true);
  assert.equal(read.events.some((event) => event.type === "model.request.started"), true);

  const firstPage = await readSupervision(fixture.packageDir, { afterSequence: -1, limit: 2 });
  const secondPage = await readSupervision(fixture.packageDir, { afterSequence: firstPage.cursor.nextSequence, limit: 2 });
  assert.deepEqual([...firstPage.events, ...secondPage.events].map((event) => event.sequence), [0, 1, 2, 3]);
  assert.equal(firstPage.cursor.hasMore, true);
  assert.equal(secondPage.cursor.hasMore, false);
  assert.equal(secondPage.cursor.runtimeCurrentSequence, 3);
  assert.equal(secondPage.cursor.controlSnapshotCurrentSequence, 3);
});

test("supervision help distinguishes live state, correction source, queue acceptance, and consumption", () => {
  assert.match(SUPERVISION_HELP, /current Run status.*running\/finished.*terminal flag/u);
  assert.match(SUPERVISION_HELP, /--evidence-sequence and --observation-id.*correction source/u);
  assert.match(SUPERVISION_HELP, /queued status means inbox acceptance, not consumption/u);
  assert.match(SUPERVISION_HELP, /only status consumed records a user\.input\.received event/u);
  assert.match(SUPERVISION_HELP, /Terminal Runs reject new corrections/u);
});

test("read keeps a legal concurrent control-snapshot and trajectory cursor difference", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "life-eval-supervision-concurrent-read-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const fixture = await createPackage(tempRoot);
  await appendLaterObservationAndAction(fixture);
  fixture.state = { ...fixture.state, currentSequence: 4, evidenceSequence: 4, evidenceFresh: true };
  await writeFile(join(fixture.attemptDir, "supervision-state.jsonl"), `${JSON.stringify(fixture.state)}\n`, "utf8");

  const read = await readSupervision(fixture.packageDir, { afterSequence: -1, limit: 10 });
  assert.equal(read.cursor.runtimeCurrentSequence, 5);
  assert.equal(read.cursor.controlSnapshotCurrentSequence, 4);
  assert.equal(read.state.currentSequence, 4);
});

test("dynamic helper writes an identity- and evidence-bound UTF-8 command file", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "life-eval-supervision-command-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const fixture = await createPackage(tempRoot);
  const textFile = await writeCorrectionText(tempRoot);
  const result = await submitSupervisionCommand(fixture.packageDir, {
    command: "correct",
    runId,
    evidenceSequence: fixture.state.latestObservation.sequence,
    observationId,
    textFile,
    waitMs: 0,
  });
  assert.equal(result.status, "submitted-to-evaluation-queue");
  const commandText = await readFile(result.commandPath, "utf8");
  assert.doesNotMatch(commandText, /\uFFFD|\?{3,}|_{2,}/u);
  const command = JSON.parse(commandText);
  assert.equal(command.packageId, fixture.packageId);
  assert.equal(command.attemptId, fixture.attemptId);
  assert.equal(command.runId, runId);
  assert.equal(command.evidenceSequence, 2);
  assert.equal(command.observationId, observationId);
  assert.match(command.text, /重新查看当前结果页/u);
  assert.equal((await readSupervisionReceipt(fixture.packageDir, result.commandId)).status, "pending-dispatch");
});

test("A/B reject corrections while C/D accept only a real same-Run observation source", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "life-eval-supervision-reject-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const textFile = await writeCorrectionText(tempRoot);
  const observe = await createPackage(tempRoot, { mode: "observe", variant: "A" });
  await assert.rejects(submitSupervisionCommand(observe.packageDir, {
    command: "correct", runId, evidenceSequence: 2, observationId, textFile, waitMs: 0,
  }), /observe-only/u);

  const stale = await createPackage(tempRoot, { mode: "dynamic", variant: "C", evidenceFresh: false });
  const source = await appendLaterObservationAndAction(stale);
  const acceptedHistoricalSource = await submitSupervisionCommand(stale.packageDir, {
    command: "correct", runId, ...source, textFile, waitMs: 0,
  });
  assert.equal(acceptedHistoricalSource.status, "submitted-to-evaluation-queue");
  assert.match(acceptedHistoricalSource.note, /only the correction source and may not show the current screen/u);
  await assert.rejects(submitSupervisionCommand(stale.packageDir, {
    command: "correct", runId, evidenceSequence: 6, observationId: "future-observation", textFile, waitMs: 0,
  }), /same committed observation in this Run/u);
  await assert.rejects(submitSupervisionCommand(stale.packageDir, {
    command: "correct", runId, evidenceSequence: source.evidenceSequence, observationId: "observation-from-another-run", textFile, waitMs: 0,
  }), /same committed observation in this Run/u);

  const observeB = await createPackage(tempRoot, { mode: "observe", variant: "B" });
  await assert.rejects(submitSupervisionCommand(observeB.packageDir, {
    command: "correct", runId, evidenceSequence: 2, observationId, textFile, waitMs: 0,
  }), /observe-only/u);

  const dynamicD = await createPackage(tempRoot, { mode: "dynamic", variant: "D" });
  const acceptedD = await submitSupervisionCommand(dynamicD.packageDir, {
    command: "correct", runId, evidenceSequence: 2, observationId, textFile, waitMs: 0,
  });
  assert.equal(acceptedD.status, "submitted-to-evaluation-queue");

  const approval = await createPackage(tempRoot, { mode: "dynamic", variant: "C" });
  const approvalState = { ...approval.state, status: "waiting_approval", pendingApprovalRequestId: "approval-1" };
  await writeFile(join(approval.attemptDir, "supervision-state.jsonl"), `${JSON.stringify(approvalState)}\n`, "utf8");
  await assert.rejects(submitSupervisionCommand(approval.packageDir, {
    command: "correct", runId, evidenceSequence: 2, observationId, textFile, waitMs: 0,
  }), /correct is not an approval answer/u);

  const terminal = await createPackage(tempRoot, { mode: "dynamic", variant: "C" });
  await writeFile(join(terminal.attemptDir, "supervision-state.jsonl"), `${JSON.stringify({ ...terminal.state, status: "finished", terminal: true })}\n`, "utf8");
  await assert.rejects(submitSupervisionCommand(terminal.packageDir, {
    command: "correct", runId, evidenceSequence: 2, observationId, textFile, waitMs: 0,
  }), /Run is terminal/u);
});

test("fake parent-child IPC delivers a correction and records queued before consumed in order", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "life-eval-supervision-ipc-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const fixture = await createPackage(tempRoot);
  const source = await appendLaterObservationAndAction(fixture);
  const bridge = await createSupervisionBridge({
    plan: fixture.plan,
    packageDir: fixture.packageDir,
    attemptDir: fixture.attemptDir,
    mode: "dynamic",
    startedAt: "2026-10-18T00:00:00.000Z",
  });
  assert.equal(await readFile(bridge.receiptsPath, "utf8"), "");
  const sentCommands = [];
  let child;
  child = fakeChild((message) => {
    if (message.type === "harness.supervision.start") {
      queueMicrotask(() => {
        void bridge.handleChildMessage({
          type: "harness.supervision.initialized",
          packageId: fixture.packageId,
          attemptId: fixture.attemptId,
          mode: "dynamic",
        }, child);
      });
    } else if (message.type === "harness.supervision.command") {
      sentCommands.push(message);
      queueMicrotask(() => {
        const common = {
          type: "harness.supervision.receipt",
          commandId: message.commandId,
          packageId: fixture.packageId,
          attemptId: fixture.attemptId,
          runId,
          command: "correct",
          at: new Date().toISOString(),
        };
        void bridge.handleChildMessage({ ...common, status: "queued", reason: "accepted-by-RunController-inbox" }, child);
        void bridge.handleChildMessage({ ...common, status: "consumed", reason: "user.input.received", eventSequence: 4 }, child);
      });
    }
  });
  await bridge.handleChildMessage({ type: "harness.supervision.listener-ready", mode: "dynamic" }, child);
  await bridge.waitForReady();
  await bridge.handleChildMessage({
    type: "harness.supervision.snapshot",
    packageId: fixture.packageId,
    attemptId: fixture.attemptId,
    mode: "dynamic",
    runId,
    status: "running",
    currentSequence: fixture.state.currentSequence,
    evidenceSequence: fixture.state.evidenceSequence,
    evidenceFresh: fixture.state.evidenceFresh,
    latestObservation: fixture.state.latestObservation,
    terminal: false,
    updatedAt: new Date().toISOString(),
  }, child);

  const textFile = await writeCorrectionText(tempRoot);
  const command = await submitSupervisionCommand(fixture.packageDir, {
    command: "correct", runId, ...source, textFile, waitMs: 0,
  });
  await bridge.pumpCommands(child);
  const receipt = await waitForReceipt(fixture.packageDir, command.commandId, "consumed");
  assert.equal(receipt.eventSequence, 4);
  const allReceipts = await readFile(bridge.receiptsPath, "utf8");
  const lines = allReceipts.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  const ownReceipts = lines.filter((item) => item.commandId === command.commandId);
  assert.deepEqual(ownReceipts.map((item) => item.status), ["queued", "consumed"]);
  assert.deepEqual(await readSupervisionReceipt(fixture.packageDir, command.commandId), receipt);
  const inspected = await inspectSupervision(fixture.packageDir);
  assert.deepEqual(inspected.activeQueuedCommandIds, []);

  const secondCommand = await submitSupervisionCommand(fixture.packageDir, {
    command: "correct", runId, ...source, textFile, waitMs: 0,
  });
  await bridge.pumpCommands(child);
  const secondReceipt = await waitForReceipt(fixture.packageDir, secondCommand.commandId, "consumed");
  assert.equal(secondReceipt.eventSequence, 4);
  const secondCommandReceipts = (await readFile(bridge.receiptsPath, "utf8"))
    .trim().split(/\r?\n/u).map((line) => JSON.parse(line)).filter((item) => item.commandId === secondCommand.commandId);
  assert.deepEqual(secondCommandReceipts.map((item) => item.status), ["queued", "consumed"]);

  const forgedCommands = [
    { commandId: "123e4567-e89b-42d3-a456-426614174010", evidenceSequence: 99, observationId: "future-observation" },
    { commandId: "123e4567-e89b-42d3-a456-426614174011", evidenceSequence: source.evidenceSequence, observationId: "observation-from-another-run" },
  ];
  for (const forged of forgedCommands) {
    await writeFile(join(bridge.commandsDir, `command-${forged.commandId}.json`), `${JSON.stringify({
      schemaVersion: 1,
      ...forged,
      packageId: fixture.packageId,
      attemptId: fixture.attemptId,
      runId,
      command: "correct",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      text: "Please reobserve and continue.",
    })}\n`, "utf8");
  }
  await bridge.pumpCommands(child);
  for (const forged of forgedCommands) {
    const receipt = await readSupervisionReceipt(fixture.packageDir, forged.commandId);
    assert.equal(receipt.status, "rejected");
    assert.equal(receipt.reason, "correction-source-observation-not-committed-in-this-run");
  }
  assert.equal(sentCommands.length, 2);

  await bridge.finalize({ terminalStatus: "finished" });
  assert.equal((await inspectSupervision(fixture.packageDir)).terminal, true);
  const terminalId = "123e4567-e89b-42d3-a456-426614174012";
  await writeFile(join(bridge.commandsDir, `command-${terminalId}.json`), `${JSON.stringify({
    schemaVersion: 1,
    commandId: terminalId,
    packageId: fixture.packageId,
    attemptId: fixture.attemptId,
    runId,
    command: "correct",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    evidenceSequence: source.evidenceSequence,
    observationId: source.observationId,
    text: "Please reobserve and continue.",
  })}\n`, "utf8");
  await bridge.pumpCommands(child);
  const terminalReceipt = await readSupervisionReceipt(fixture.packageDir, terminalId);
  assert.equal(terminalReceipt.status, "rejected");
  assert.equal(terminalReceipt.reason, "run-terminal");
});

test("expired queued commands never reach IPC and cancellation remains available in observe mode", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "life-eval-supervision-expiry-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const fixture = await createPackage(tempRoot, { mode: "observe", variant: "A" });
  const bridge = await createSupervisionBridge({ plan: fixture.plan, packageDir: fixture.packageDir, attemptDir: fixture.attemptDir, mode: "observe", startedAt: fixture.state.updatedAt });
  const sent = [];
  let child;
  child = fakeChild((message) => {
    sent.push(message);
    if (message.type === "harness.supervision.start") {
      queueMicrotask(() => {
        void bridge.handleChildMessage({
          type: "harness.supervision.initialized",
          packageId: fixture.packageId,
          attemptId: fixture.attemptId,
          mode: "observe",
        }, child);
      });
    }
  });
  await bridge.handleChildMessage({ type: "harness.supervision.listener-ready", mode: "observe" }, child);
  await bridge.waitForReady();
  await bridge.handleChildMessage({
    type: "harness.supervision.snapshot",
    packageId: fixture.packageId,
    attemptId: fixture.attemptId,
    mode: "observe",
    runId,
    status: "running",
    currentSequence: 3,
    evidenceSequence: 2,
    evidenceFresh: true,
    latestObservation: fixture.state.latestObservation,
    terminal: false,
    updatedAt: new Date().toISOString(),
  }, child);

  const expiredId = "123e4567-e89b-42d3-a456-426614174099";
  const unpublishedId = "123e4567-e89b-42d3-a456-426614174098";
  const nullId = "123e4567-e89b-42d3-a456-426614174097";
  const primitiveId = "123e4567-e89b-42d3-a456-426614174096";
  await writeFile(join(bridge.commandsDir, `.pending-${unpublishedId}.tmp`), `${JSON.stringify({
    schemaVersion: 1,
    commandId: unpublishedId,
    packageId: fixture.packageId,
    attemptId: fixture.attemptId,
    runId,
    command: "cancel",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  })}\n`, "utf8");
  await writeFile(join(bridge.commandsDir, `command-${expiredId}.json`), `${JSON.stringify({
    schemaVersion: 1,
    commandId: expiredId,
    packageId: fixture.packageId,
    attemptId: fixture.attemptId,
    runId,
    command: "cancel",
    createdAt: "2026-10-18T00:00:00.000Z",
    expiresAt: "2020-01-01T00:00:00.000Z",
  })}\n`, "utf8");
  await writeFile(join(bridge.commandsDir, `command-${nullId}.json`), "null\n", "utf8");
  await writeFile(join(bridge.commandsDir, `command-${primitiveId}.json`), "42\n", "utf8");
  await bridge.pumpCommands(child);
  const expired = await readSupervisionReceipt(fixture.packageDir, expiredId);
  assert.equal(expired.status, "expired");
  assert.equal(sent.some((message) => message.type === "harness.supervision.command"), false);
  assert.equal((await readSupervisionReceipt(fixture.packageDir, unpublishedId)).status, "not-found-or-not-yet-written");
  assert.equal((await readSupervisionReceipt(fixture.packageDir, nullId)).status, "rejected");
  assert.equal((await readSupervisionReceipt(fixture.packageDir, primitiveId)).status, "rejected");

  const cancel = await submitSupervisionCommand(fixture.packageDir, { command: "cancel", runId, waitMs: 0 });
  await bridge.pumpCommands(child);
  const cancelMessage = sent.find((message) => message.type === "harness.supervision.command");
  assert.equal(cancelMessage.command, "cancel");
  assert.equal(cancelMessage.runId, runId);
  assert.equal(cancel.status, "submitted-to-evaluation-queue");
  await bridge.finalize();
});

test("a package symlink cannot redirect the approved Runtime output root outside the package", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "life-eval-supervision-path-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const fixture = await createPackage(tempRoot);
  const planText = await readFile(join(fixture.packageDir, "plan.json"), "utf8");
  const plan = JSON.parse(planText);
  plan.cli.argvTemplate[plan.cli.argvTemplate.indexOf("--output") + 1] = fixture.outputAttemptDir;
  await writeFile(join(fixture.packageDir, "plan.json"), `${JSON.stringify(plan)}\n`, "utf8");
  await assert.rejects(inspectSupervision(fixture.packageDir), /package-owned runtime-output directory/u);
});
