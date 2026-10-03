import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { PassThrough, Writable } from "node:stream";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { startLocalScreenRecording } from "./local-screen-recorder.mjs";

function mockChild({ onWrite, closeCode = 0, failQWrite = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdinWrites = [];
  child.closed = false;
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      const text = chunk.toString("utf8");
      child.stdinWrites.push(text);
      onWrite?.(text);
      if (failQWrite && text.includes("q\n")) setImmediate(() => callback(new Error("synthetic async stdin failure")));
      else callback();
    },
  });
  child.close = (code = closeCode, signal = null) => {
    if (child.closed) return;
    child.closed = true;
    child.stdout.end();
    child.stderr.end();
    child.emit("close", code, signal);
  };
  child.kill = () => {
    setImmediate(() => child.close(143, "SIGTERM"));
    return true;
  };
  return child;
}

function makeSpawn({
  streams = [{ codec_type: "video", codec_name: "h264" }],
  ffmpegExitCode = 0,
  failStart = false,
  closeAfterFrame,
  processErrorAfterFrame = false,
  stderrErrorAfterFrame = false,
  stdinErrorOnWrite = false,
} = {}) {
  const calls = [];
  const children = [];
  const spawnProcess = (executable, args, options) => {
    calls.push({ executable, args, options });
    if (args.includes("-show_entries")) {
      const child = mockChild();
      children.push(child);
      setImmediate(() => {
        child.stdout.write(JSON.stringify({ streams }));
        child.stdout.end();
        setImmediate(() => child.close(0));
      });
      return child;
    }
    const child = mockChild({
      closeCode: ffmpegExitCode,
      failQWrite: stdinErrorOnWrite,
      onWrite: (text) => {
        if (!text.includes("q\n")) return;
        if (!stdinErrorOnWrite) {
          setImmediate(() => child.close(ffmpegExitCode));
        }
      },
    });
    children.push(child);
    setImmediate(() => {
      if (failStart) {
        child.emit("error", new Error("synthetic spawn failure"));
        child.close(1);
      } else {
        child.stderr.write("frame=1\n");
        if (closeAfterFrame !== undefined) setTimeout(() => child.close(closeAfterFrame), 10);
        if (processErrorAfterFrame) setTimeout(() => {
          child.emit("error", new Error("synthetic process failure after first frame"));
        }, 10);
        if (stderrErrorAfterFrame) setTimeout(() => {
          child.stderr.destroy(new Error("synthetic stderr failure after first frame"));
        }, 10);
      }
    });
    return child;
  };
  return { calls, children, spawnProcess };
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "local-screen-recorder-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("starts a no-audio desktop H.264 recorder and stops via stdin q then ffprobe", async (t) => {
  const directory = await temporaryDirectory(t);
  const outputPath = join(directory, "screen.mp4");
  const fake = makeSpawn();
  const recorder = await startLocalScreenRecording({
    outputPath, ffmpegPath: resolve(directory, "ffmpeg.exe"), ffprobePath: resolve(directory, "ffprobe.exe"), fps: 15,
    spawnProcess: fake.spawnProcess,
  });
  const firstCall = fake.calls[0];
  assert.equal(firstCall.options.shell, false);
  assert.equal(firstCall.options.windowsHide, true);
  assert.deepEqual(firstCall.options.stdio, ["pipe", "ignore", "pipe"]);
  assert.equal(firstCall.args[firstCall.args.indexOf("-framerate") + 1], "15");
  assert.ok(firstCall.args.includes("desktop"));
  assert.ok(firstCall.args.includes("-an"));
  assert.ok(firstCall.args.includes("-n"));

  const stopped = recorder.stop();
  assert.equal(recorder.stop(), stopped);
  const result = await stopped;
  assert.deepEqual(result, { outputPath, videoCodec: "h264", audioStreams: 0 });
  await recorder.health;
  assert.equal(fake.children[0].stdinWrites.join(""), "q\n");
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[1].options.shell, false);
  assert.ok(fake.calls[1].args.includes(outputPath));
});

test("refuses an existing MP4 without spawning a process", async (t) => {
  const directory = await temporaryDirectory(t);
  const outputPath = join(directory, "existing.mp4");
  await writeFile(outputPath, "fixture", { flag: "wx" });
  const fake = makeSpawn();
  await assert.rejects(
    startLocalScreenRecording({ outputPath, spawnProcess: fake.spawnProcess }),
    { code: "OUTPUT_EXISTS" },
  );
  assert.equal(fake.calls.length, 0);
});

test("does not swallow ffmpeg startup failure", async (t) => {
  const directory = await temporaryDirectory(t);
  const fake = makeSpawn({ failStart: true });
  await assert.rejects(
    startLocalScreenRecording({ outputPath: join(directory, "screen.mp4"), spawnProcess: fake.spawnProcess }),
    { code: "FFMPEG_SPAWN_FAILED" },
  );
  assert.equal(fake.calls.length, 1);
});

test("reports nonzero ffmpeg exit instead of probing a partial MP4", async (t) => {
  const directory = await temporaryDirectory(t);
  const fake = makeSpawn({ ffmpegExitCode: 3 });
  const recorder = await startLocalScreenRecording({ outputPath: join(directory, "screen.mp4"), spawnProcess: fake.spawnProcess });
  await assert.rejects(recorder.stop(), { code: "FFMPEG_STOP_FAILED" });
  await assert.rejects(recorder.health, { code: "FFMPEG_STOP_FAILED" });
  assert.equal(fake.calls.length, 1);
});

test("rejects an MP4 with an audio stream", async (t) => {
  const directory = await temporaryDirectory(t);
  const fake = makeSpawn({ streams: [
    { codec_type: "video", codec_name: "h264" },
    { codec_type: "audio", codec_name: "aac" },
  ] });
  const recorder = await startLocalScreenRecording({ outputPath: join(directory, "screen.mp4"), spawnProcess: fake.spawnProcess });
  await assert.rejects(recorder.stop(), { code: "MP4_STREAMS_INVALID" });
  await assert.rejects(recorder.health, { code: "MP4_STREAMS_INVALID" });
});

test("limits capture to the approved 15 or 20 fps settings", async (t) => {
  const directory = await temporaryDirectory(t);
  const fake = makeSpawn();
  await assert.rejects(
    startLocalScreenRecording({ outputPath: join(directory, "screen.mp4"), fps: 60, spawnProcess: fake.spawnProcess }),
    { code: "INVALID_FRAME_RATE" },
  );
  assert.equal(fake.calls.length, 0);
});

test("health promptly rejects if ffmpeg exits after first frame, including exit zero", async (t) => {
  const directory = await temporaryDirectory(t);
  for (const exitCode of [0, 9]) {
    const fake = makeSpawn({ closeAfterFrame: exitCode });
    const recorder = await startLocalScreenRecording({
      outputPath: join(directory, `early-${exitCode}.mp4`), spawnProcess: fake.spawnProcess,
    });
    await assert.rejects(recorder.health, { code: "FFMPEG_EXITED_EARLY" });
    await assert.rejects(recorder.stop(), { code: "FFMPEG_EXITED_EARLY" });
  }
});

test("early health rejection is handled while the runner is attaching its watcher", async (t) => {
  const directory = await temporaryDirectory(t);
  const fake = makeSpawn({ closeAfterFrame: 0 });
  const recorder = await startLocalScreenRecording({
    outputPath: join(directory, "handoff.mp4"), spawnProcess: fake.spawnProcess,
  });
  await new Promise((resolveResult) => setTimeout(resolveResult, 25));
  await assert.rejects(recorder.stop(), { code: "FFMPEG_EXITED_EARLY" });
  assert.equal(fake.children[0].closed, true);
});

test("health rejects promptly on ffmpeg process and stderr stream errors", async (t) => {
  const directory = await temporaryDirectory(t);
  const cases = [
    { name: "process", options: { processErrorAfterFrame: true }, code: "FFMPEG_PROCESS_ERROR" },
    { name: "stderr", options: { stderrErrorAfterFrame: true }, code: "FFMPEG_STDERR_ERROR" },
  ];
  for (const item of cases) {
    const fake = makeSpawn(item.options);
    const recorder = await startLocalScreenRecording({
      outputPath: join(directory, `${item.name}.mp4`), spawnProcess: fake.spawnProcess,
    });
    await assert.rejects(recorder.health, { code: item.code });
    await assert.rejects(recorder.stop(), { code: item.code });
    assert.equal(fake.children[0].closed, true, `${item.name} fault cleanup should await process close`);
  }
});

test("health and stop reject an asynchronous ffmpeg stdin error", async (t) => {
  const directory = await temporaryDirectory(t);
  const fake = makeSpawn({ stdinErrorOnWrite: true });
  const recorder = await startLocalScreenRecording({ outputPath: join(directory, "stdin-error.mp4"), spawnProcess: fake.spawnProcess });
  await assert.rejects(recorder.stop(), { code: "FFMPEG_STDIN_ERROR" });
  await assert.rejects(recorder.health, { code: "FFMPEG_STDIN_ERROR" });
  assert.equal(fake.children[0].closed, true);
});
