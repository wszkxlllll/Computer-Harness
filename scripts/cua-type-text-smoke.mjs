import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { join, resolve } from "node:path";
import { CuaDriverComputer, CuaWindowDiscovery } from "../packages/computer-cua/dist/index.js";

const TEST_TEXT = "test 0926";

function arg(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function required(name) {
  const value = arg(name);
  if (value === undefined || value.length === 0) throw new Error(`Missing ${name}`);
  return value;
}

function positiveInteger(name) {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function nonNegativeInteger(name) {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  return value;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    stdout.write([
      "Usage: node scripts/cua-type-text-smoke.mjs --socket <pipe> --pid <pid> --window-id <hwnd> --focus-x <x> --focus-y <y> --phase batch|paced --confirm-blank-synthetic-tab",
      "Run each phase separately on its own fresh, explicitly confirmed blank, unsaved synthetic Notepad tab.",
      "The phase leaves its synthetic text unsaved and does not clear, save, or switch tabs.",
      "Target-window PNGs and manifest are written under runs/diagnostics/cua-type-text-smoke/.",
    ].join("\n") + "\n");
    return;
  }

  if (!process.argv.includes("--confirm-blank-synthetic-tab")) {
    throw new Error("Select a fresh blank, unsaved synthetic Notepad tab with no user text, verify it visually, then pass --confirm-blank-synthetic-tab");
  }
  const phase = required("--phase");
  if (phase !== "batch" && phase !== "paced") throw new Error("--phase must be exactly 'batch' or 'paced'");

  const socketPath = required("--socket");
  const target = { pid: positiveInteger("--pid"), windowId: positiveInteger("--window-id") };
  const focusPoint = { x: nonNegativeInteger("--focus-x"), y: nonNegativeInteger("--focus-y") };
  const outputRoot = resolve("runs", "diagnostics", "cua-type-text-smoke");
  const timestamp = new Date().toISOString().replace(/[.:]/gu, "-");
  const runId = `${timestamp}-${phase}-${randomUUID()}`;
  const outputDir = join(outputRoot, runId);
  await mkdir(outputRoot, { recursive: true });
  await mkdir(outputDir);

  const manifestPath = join(outputDir, "manifest.json");
  const manifest = {
    schemaVersion: 1,
    runId,
    status: "starting",
    startedAt: new Date().toISOString(),
    phase,
    testText: TEST_TEXT,
    selectedWindowCaptureOnly: true,
    target: { ...target, appName: "Notepad" },
    focusPoint,
    observations: [],
    actions: [],
    cleanupErrors: [],
  };
  const saveManifest = async () => writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await saveManifest();
  stdout.write(`${JSON.stringify({ stage: "artifacts", runDirectory: outputDir, manifest: manifestPath, phase })}\n`);

  const signal = AbortSignal.timeout(120_000);
  let computer;
  let session;
  let runError;
  try {
    const discovery = new CuaWindowDiscovery({ socketPath });
    const windows = await discovery.listWindows(AbortSignal.timeout(10_000));
    const selected = windows.find((window) => window.target.pid === target.pid && window.target.windowId === target.windowId);
    if (selected === undefined || !/notepad/iu.test(selected.appName ?? "")) {
      throw new Error("The exact PID/HWND is not a currently listed Notepad window; no input sent");
    }

    computer = new CuaDriverComputer({
      socketPath,
      screenshotDir: join(outputDir, "driver-captures"),
      windowTarget: target,
      windowDeliveryMode: "foreground",
      sessionLabel: `type-smoke-${runId}`,
    });

    let observationNumber = 0;
    let actionNumber = 0;
    const observe = async (stage) => {
      const observationId = `${runId}-observation-${++observationNumber}`;
      const capture = await computer.observe(session, observationId, signal);
      const imageName = `${String(observationNumber).padStart(2, "0")}-${stage}.png`;
      const screenshotPath = join(outputDir, imageName);
      await writeFile(screenshotPath, capture.screenshot.data, { flag: "wx" });
      const observation = {
        stage,
        observationId,
        capturedAt: capture.capturedAt,
        viewport: capture.viewport,
        screenshot: imageName,
        mediaType: capture.screenshot.mediaType,
        byteLength: capture.screenshot.data.byteLength,
        sha256: sha256(capture.screenshot.data),
      };
      manifest.observations.push(observation);
      await saveManifest();
      stdout.write(`${JSON.stringify({ stage, screenshot: screenshotPath, viewport: capture.viewport, sha256: observation.sha256 })}\n`);
      return { id: observationId, capture };
    };
    const execute = async (stage, action) => {
      const receipt = await computer.execute(session, { actionId: `${runId}-${++actionNumber}-${stage}`, ...action }, signal);
      const summary = {
        stage,
        kind: action.kind,
        ...(action.kind === "type" ? { text: action.text } : {}),
        status: receipt.status,
        ...(receipt.driverCode === undefined ? {} : { driverCode: receipt.driverCode }),
        ...(receipt.message === undefined ? {} : { message: receipt.message }),
      };
      manifest.actions.push(summary);
      await saveManifest();
      stdout.write(`${JSON.stringify(summary)}\n`);
      if (receipt.status !== "completed") throw new Error(`${stage} did not complete; stopping without replay`);
      return receipt;
    };
    const wait = (stage, durationMs) => execute(stage, { kind: "wait", durationMs });
    const confirmVisualState = async (prompt, exactAnswer) => {
      const terminal = createInterface({ input: stdin, output: stdout });
      try {
        const answer = await terminal.question(`${prompt}\nType exactly "${exactAnswer}" to continue: `);
        if (answer.trim() !== exactAnswer) throw new Error("Visual confirmation did not match; no further input sent");
      } finally {
        terminal.close();
      }
    };

    session = await computer.open({}, signal);
    manifest.status = "running";
    manifest.backend = session.backend;
    manifest.viewport = session.viewport;
    await saveManifest();
    stdout.write(`${JSON.stringify({ stage: "opened", backend: session.backend, viewport: session.viewport })}\n`);

    let frame = await observe("before");
    await confirmVisualState(
      `Inspect the saved before PNG and live desktop. Confirm the exact target is a fresh blank, unsaved synthetic tab, with no user text. Artifacts: ${outputDir}`,
      "CONFIRM BLANK SYNTHETIC TAB",
    );

    await execute("focus-editor", { kind: "click", point: focusPoint, basedOn: frame.id });
    frame = await observe("focused");
    await confirmVisualState(
      `Inspect the saved focused PNG and live desktop. Confirm this is still the same blank synthetic tab and the editor has focus. Artifacts: ${outputDir}`,
      "CONFIRM FOCUSED BLANK SYNTHETIC TAB",
    );

    if (phase === "batch") {
      await execute("batch-text", { kind: "type", text: TEST_TEXT, basedOn: frame.id });
      await wait("batch-settle", 500);
      await observe("after-batch");
    } else {
      for (const [index, character] of [...TEST_TEXT].entries()) {
        await execute(`char-${index + 1}`, { kind: "type", text: character, basedOn: frame.id });
        await wait(`char-${index + 1}-settle`, 100);
        frame = await observe(`after-char-${String(index + 1).padStart(2, "0")}`);
      }
      await wait("paced-settle", 500);
      await observe("after-paced");
    }
    manifest.status = "completed";
  } catch (error) {
    manifest.status = "failed";
    manifest.error = messageOf(error);
    runError = error;
  } finally {
    if (session !== undefined && computer !== undefined) {
      try {
        await computer.close(session);
      } catch (error) {
        manifest.cleanupErrors.push({ operation: "computer.close", message: messageOf(error) });
      }
    }
    manifest.finishedAt = new Date().toISOString();
    try {
      await saveManifest();
    } catch (error) {
      manifest.cleanupErrors.push({ operation: "manifest.write", message: messageOf(error) });
    }
  }

  if (runError !== undefined) throw runError;
  if (manifest.cleanupErrors.length > 0) throw new Error(`Diagnostic ended with cleanup errors; inspect ${manifestPath}`);
  stdout.write(`${JSON.stringify({ stage: "finished", status: manifest.status, phase, runDirectory: outputDir, manifest: manifestPath })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
