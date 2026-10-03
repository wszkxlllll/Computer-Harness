import { spawn } from "node:child_process";
import { lstat, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const ffmpegDirectory = resolve(moduleDirectory, "../../.tools/ffmpeg/9.0.2/bin");
export const FFMPEG_PATH = resolve(ffmpegDirectory, "ffmpeg.exe");
export const FFPROBE_PATH = resolve(ffmpegDirectory, "ffprobe.exe");

function recorderError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.name = "LocalScreenRecorderError";
  error.code = code;
  return error;
}

async function requireNewMp4(outputPath) {
  if (typeof outputPath !== "string" || !isAbsolute(outputPath) || extname(outputPath).toLowerCase() !== ".mp4") {
    throw recorderError("INVALID_OUTPUT_PATH", "Recording output must be an absolute .mp4 path.");
  }
  try {
    await lstat(outputPath);
    throw recorderError("OUTPUT_EXISTS", "Refusing to overwrite an existing recording.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const parent = await stat(dirname(outputPath));
  if (!parent.isDirectory()) throw recorderError("OUTPUT_PARENT_INVALID", "Recording output parent is not a directory.");
}

function waitForExit(exitPromise, timeoutMs, child, code) {
  let timer;
  return Promise.race([
    exitPromise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(recorderError(code, "Recorder process did not exit before its deadline."));
      }, timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

function probeFinishedVideo(spawnProcess, ffprobePath, outputPath, timeoutMs) {
  return new Promise((resolveResult, rejectResult) => {
    let child;
    try {
      child = spawnProcess(ffprobePath, [
        "-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "json", outputPath,
      ], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      rejectResult(recorderError("FFPROBE_SPAWN_FAILED", "Could not start ffprobe.", error));
      return;
    }
    let stdout = "";
    let timer;
    child.stdout?.on("data", (chunk) => { if (stdout.length < 64_000) stdout += chunk.toString("utf8"); });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectResult(recorderError("FFPROBE_SPAWN_FAILED", "Could not start ffprobe.", error));
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      if (exitCode !== 0) {
        rejectResult(recorderError("FFPROBE_FAILED", "ffprobe did not validate the finished MP4."));
        return;
      }
      try {
        const streams = JSON.parse(stdout).streams;
        const video = Array.isArray(streams) ? streams.filter((stream) => stream?.codec_type === "video") : [];
        const audio = Array.isArray(streams) ? streams.filter((stream) => stream?.codec_type === "audio") : [];
        if (video.length !== 1 || video[0]?.codec_name !== "h264" || audio.length !== 0) {
          throw recorderError("MP4_STREAMS_INVALID", "Finished MP4 must contain one H.264 video stream and no audio.");
        }
        resolveResult({ outputPath, videoCodec: "h264", audioStreams: 0 });
      } catch (error) {
        rejectResult(error?.code ? error : recorderError("FFPROBE_OUTPUT_INVALID", "ffprobe returned invalid stream metadata.", error));
      }
    });
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      rejectResult(recorderError("FFPROBE_TIMEOUT", "ffprobe did not finish before its deadline."));
    }, timeoutMs);
    timer.unref?.();
  });
}

/** Starts local desktop video only; callers must stop it after Run cleanup. */
export async function startLocalScreenRecording({
  outputPath,
  ffmpegPath = FFMPEG_PATH,
  ffprobePath = FFPROBE_PATH,
  fps = 20,
  spawnProcess = spawn,
  startupTimeoutMs = 15_000,
  stopTimeoutMs = 20_000,
} = {}) {
  await requireNewMp4(outputPath);
  if (!isAbsolute(ffmpegPath) || !isAbsolute(ffprobePath)) {
    throw recorderError("INVALID_TOOL_PATH", "ffmpeg and ffprobe paths must be absolute.");
  }
  if (fps !== 15 && fps !== 20) throw recorderError("INVALID_FRAME_RATE", "Screen recording frame rate must be 15 or 20 fps.");
  const args = [
    "-hide_banner", "-loglevel", "error", "-progress", "pipe:2", "-stats_period", "0.25", "-nostats",
    "-f", "gdigrab", "-framerate", String(fps), "-i", "desktop", "-an",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", "-n", outputPath,
  ];
  let child;
  try {
    child = spawnProcess(ffmpegPath, args, { shell: false, windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
  } catch (error) {
    throw recorderError("FFMPEG_SPAWN_FAILED", "Could not start ffmpeg; Run must not start.", error);
  }

  let frameSeen = false;
  let stopRequested = false;
  let quitSent = false;
  let processClosed = false;
  let recorderFailure;
  let healthSettled = false;
  let progressBuffer = "";
  let resolveFirstFrame;
  let resolveFailureSignal;
  let resolveHealth;
  let rejectHealth;
  const firstFrame = new Promise((resolveResult) => {
    resolveFirstFrame = resolveResult;
  });
  const failureSignal = new Promise((resolveResult) => { resolveFailureSignal = resolveResult; });
  const health = new Promise((resolveResult, rejectResult) => {
    resolveHealth = resolveResult;
    rejectHealth = rejectResult;
  });
  // The runner can attach after start resolves; this prevents an early close
  // from becoming an unhandled rejection in that short handoff interval.
  health.catch(() => undefined);
  const fail = (error) => {
    if (recorderFailure !== undefined) return recorderFailure;
    recorderFailure = error;
    resolveFailureSignal(error);
    if (!healthSettled) {
      healthSettled = true;
      rejectHealth(error);
    }
    return error;
  };
  const exitPromise = new Promise((resolveExit) => {
    child.once("close", (code, signal) => {
      processClosed = true;
      resolveExit({ code, signal });
    });
  });
  child.once("error", (error) => {
    fail(recorderError(frameSeen ? "FFMPEG_PROCESS_ERROR" : "FFMPEG_SPAWN_FAILED", "ffmpeg emitted a process error.", error));
  });
  child.stderr?.once("error", (error) => {
    fail(recorderError("FFMPEG_STDERR_ERROR", "ffmpeg stderr stream failed.", error));
  });
  child.stdin?.on("error", (error) => {
    fail(recorderError("FFMPEG_STDIN_ERROR", "ffmpeg stdin stream failed.", error));
  });
  child.once("close", (code, signal) => {
    if (!frameSeen) {
      fail(recorderError("FFMPEG_START_FAILED", "ffmpeg exited before producing a frame."));
    } else if (!stopRequested || !quitSent) {
      fail(recorderError("FFMPEG_EXITED_EARLY", `ffmpeg closed unexpectedly (exit ${String(code)}).`));
    } else if (code !== 0) {
      fail(recorderError("FFMPEG_STOP_FAILED", `ffmpeg closed with exit ${String(code)}${signal ? `, signal ${signal}` : ""}.`));
    }
  });
  child.stderr?.on("data", (chunk) => {
    progressBuffer += chunk.toString("utf8");
    const lines = progressBuffer.split(/\r?\n/u);
    progressBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const match = /^frame=\s*(\d+)$/u.exec(line);
      if (match && Number(match[1]) > 0 && !frameSeen) {
        frameSeen = true;
        resolveFirstFrame();
      }
    }
    if (progressBuffer.length > 4096) progressBuffer = progressBuffer.slice(-4096);
  });
  let startupTimer;
  const startupDeadline = new Promise((_, reject) => {
    startupTimer = setTimeout(() => reject(recorderError("FFMPEG_START_TIMEOUT", "ffmpeg produced no frame before the startup deadline.")), startupTimeoutMs);
    startupTimer.unref?.();
  });
  try {
    await Promise.race([firstFrame, failureSignal.then((error) => { throw error; }), startupDeadline]);
    if (recorderFailure !== undefined) throw recorderFailure;
  } catch (error) {
    clearTimeout(startupTimer);
    const startupFailure = recorderFailure ?? fail(error?.code ? error : recorderError("FFMPEG_START_FAILED", "ffmpeg failed during startup.", error));
    try { child.kill("SIGTERM"); } catch { /* retain and report the startup failure below */ }
    try {
      await waitForExit(exitPromise, 3_000, child, "FFMPEG_CLEANUP_TIMEOUT");
    } catch (cleanupError) {
      throw recorderError("FFMPEG_START_CLEANUP_FAILED", "ffmpeg startup failed and child cleanup was not confirmed.", new AggregateError([startupFailure, cleanupError]));
    }
    throw startupFailure;
  }
  clearTimeout(startupTimer);

  let stopPromise;
  return {
    outputPath,
    health,
    stop() {
      if (stopPromise !== undefined) return stopPromise;
      stopPromise = (async () => {
        if (recorderFailure !== undefined) {
          if (!processClosed) {
            try { child.kill("SIGTERM"); } catch { /* cleanup result below remains authoritative */ }
            try {
              await waitForExit(exitPromise, stopTimeoutMs, child, "FFMPEG_FAILURE_CLEANUP_TIMEOUT");
            } catch (cleanupError) {
              throw recorderError("FFMPEG_FAILURE_CLEANUP_FAILED", "Recorder failed and its process cleanup was not confirmed.", new AggregateError([recorderFailure, cleanupError]));
            }
          }
          throw recorderFailure;
        }
        stopRequested = true;
        try {
          if (!child.stdin || child.stdin.destroyed) throw recorderError("FFMPEG_STDIN_UNAVAILABLE", "ffmpeg stdin is unavailable for graceful stop.");
          await new Promise((resolveQuit, rejectQuit) => {
            let settled = false;
            const cleanup = () => {
              child.stdin.removeListener("error", onError);
              child.stdin.removeListener("finish", onFinish);
            };
            const onError = (error) => {
              if (settled) return;
              settled = true;
              cleanup();
              rejectQuit(error);
            };
            const onFinish = () => {
              if (settled) return;
              settled = true;
              cleanup();
              resolveQuit();
            };
            child.stdin.once("error", onError);
            child.stdin.once("finish", onFinish);
            try {
              child.stdin.write("q\n", (error) => {
                if (settled) return;
                if (error) {
                  onError(error);
                  return;
                }
                if (recorderFailure !== undefined) {
                  onError(recorderFailure);
                  return;
                }
                try {
                  child.stdin.end();
                  quitSent = true;
                } catch (endError) {
                  onError(endError);
                }
              });
            } catch (writeError) {
              onError(writeError);
            }
          });
        } catch (error) {
          const stopFailure = recorderFailure ?? fail(recorderError("FFMPEG_STDIN_ERROR", "Could not send ffmpeg its graceful quit command.", error));
          try { child.kill("SIGTERM"); } catch { /* stopFailure remains observable */ }
          try { await waitForExit(exitPromise, 3_000, child, "FFMPEG_STOP_CLEANUP_TIMEOUT"); }
          catch (cleanupError) {
            throw recorderError("FFMPEG_STOP_CLEANUP_FAILED", "Graceful stop failed and child cleanup was not confirmed.", new AggregateError([stopFailure, cleanupError]));
          }
          throw stopFailure;
        }
        let exit;
        try {
          exit = await waitForExit(exitPromise, stopTimeoutMs, child, "FFMPEG_STOP_TIMEOUT");
        } catch (error) {
          throw recorderFailure ?? fail(error?.code ? error : recorderError("FFMPEG_STOP_FAILED", "ffmpeg did not stop successfully.", error));
        }
        if (recorderFailure !== undefined) throw recorderFailure;
        if (exit.code !== 0) throw fail(recorderError("FFMPEG_STOP_FAILED", `ffmpeg did not exit successfully (exit ${String(exit.code)}).`));
        let summary;
        try {
          summary = await probeFinishedVideo(spawnProcess, ffprobePath, outputPath, stopTimeoutMs);
        } catch (error) {
          throw fail(error?.code ? error : recorderError("FFPROBE_FAILED", "Could not verify the finished MP4.", error));
        }
        if (recorderFailure !== undefined) throw recorderFailure;
        if (!healthSettled) {
          healthSettled = true;
          resolveHealth();
        }
        return summary;
      })();
      return stopPromise;
    },
  };
}
