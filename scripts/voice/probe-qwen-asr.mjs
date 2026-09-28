#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const PROVIDER_ID = "qwen3-asr-flash-realtime";
const SAMPLE_RATE = 16_000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
const CHUNK_BYTES = 3_200;
const MAX_AUDIO_MS = 10_000;
const MAX_AUDIO_BYTES = BYTES_PER_SECOND * MAX_AUDIO_MS / 1_000;
const MAX_INPUT_FILE_BYTES = MAX_AUDIO_BYTES + 64 * 1024;
const MAX_WALL_TIME_MS = 20_000;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const FINISH_TIMEOUT_MS = 8_000;

const HELP = `Qwen Realtime ASR short probe (real network/API call)

Usage:
  node --env-file=.env scripts/voice/probe-qwen-asr.mjs --input <file.wav|file.pcm> [--format wav|raw]

Input must be mono 16 kHz PCM16 little-endian WAV or raw PCM16 little-endian.
WAV is inferred from .wav; raw PCM is inferred from .pcm or .raw. Maximum audio
duration is 10 seconds. The entire probe has a 20-second deadline.

Environment (never printed):
  DASHSCOPE_API_KEY                   required
  DASHSCOPE_WORKSPACE_ID              required unless endpoint is overridden
  DASHSCOPE_REALTIME_ASR_ENDPOINT     optional; defaults to the Beijing workspace WSS endpoint

The probe sends 3,200-byte/100 ms chunks, waits for session.finished, prints
recognition metrics and the final transcript to the terminal, then closes the
session. Use only non-sensitive synthetic/test audio; do not use private
recordings because their transcription will be printed. It makes a real billable
provider request; do not run without explicit authorization.
`;

class ProbeFailure extends Error {
  constructor(code) {
    super(code);
    this.name = "ProbeFailure";
    this.code = code;
  }
}

export function parseArgs(argv) {
  let input;
  let format;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (token === "--input") {
      if (input !== undefined || argv[index + 1] === undefined || argv[index + 1].startsWith("--")) {
        throw new ProbeFailure("invalid_arguments");
      }
      input = argv[++index];
      continue;
    }
    if (token === "--format") {
      if (format !== undefined || !["wav", "raw"].includes(argv[index + 1])) {
        throw new ProbeFailure("invalid_arguments");
      }
      format = argv[++index];
      continue;
    }
    throw new ProbeFailure("invalid_arguments");
  }
  if (!help && input === undefined) throw new ProbeFailure("input_required");
  return { help, ...(input === undefined ? {} : { input }), ...(format === undefined ? {} : { format }) };
}

export function defaultEndpoint(workspaceId) {
  const safeWorkspaceId = validateWorkspaceId(workspaceId);
  return `wss://${safeWorkspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime`;
}

function validateWorkspaceId(workspaceId) {
  if (typeof workspaceId !== "string" || !/^[A-Za-z0-9-]{1,63}$/u.test(workspaceId)) {
    throw new ProbeFailure("workspace_id_required");
  }
  return workspaceId;
}

export function resolveInputFormat(inputPath, explicitFormat) {
  if (explicitFormat === "wav" || explicitFormat === "raw") return explicitFormat;
  const extension = extname(inputPath).toLowerCase();
  if (extension === ".wav") return "wav";
  if (extension === ".pcm" || extension === ".raw") return "raw";
  throw new ProbeFailure("format_required");
}

export function parsePcmInput(bytes, format) {
  if (!(bytes instanceof Uint8Array)) throw new ProbeFailure("invalid_audio");
  const pcm = format === "wav" ? extractWavePcm(bytes) : format === "raw" ? bytes : undefined;
  if (pcm === undefined || pcm.byteLength === 0 || pcm.byteLength % 2 !== 0 || pcm.byteLength > MAX_AUDIO_BYTES) {
    throw new ProbeFailure("invalid_audio");
  }
  return pcm;
}

function extractWavePcm(bytes) {
  if (bytes.byteLength < 44 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") {
    throw new ProbeFailure("invalid_wav");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riffEnd = view.getUint32(4, true) + 8;
  if (riffEnd < 12 || riffEnd > bytes.byteLength) throw new ProbeFailure("invalid_wav");

  let format;
  let pcm;
  let offset = 12;
  while (offset + 8 <= riffEnd) {
    const chunkId = ascii(bytes, offset, 4);
    const chunkLength = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLength;
    if (chunkEnd > riffEnd) throw new ProbeFailure("invalid_wav");
    if (chunkId === "fmt ") {
      if (format !== undefined || chunkLength < 16) throw new ProbeFailure("invalid_wav");
      format = {
        encoding: view.getUint16(chunkStart, true),
        channels: view.getUint16(chunkStart + 2, true),
        sampleRate: view.getUint32(chunkStart + 4, true),
        byteRate: view.getUint32(chunkStart + 8, true),
        blockAlign: view.getUint16(chunkStart + 12, true),
        bitsPerSample: view.getUint16(chunkStart + 14, true),
      };
    } else if (chunkId === "data") {
      if (pcm !== undefined) throw new ProbeFailure("invalid_wav");
      pcm = bytes.subarray(chunkStart, chunkEnd);
    }
    offset = chunkEnd + (chunkLength % 2);
  }

  if (offset !== riffEnd || format === undefined || pcm === undefined
    || format.encoding !== 1 || format.channels !== 1 || format.sampleRate !== SAMPLE_RATE
    || format.byteRate !== BYTES_PER_SECOND || format.blockAlign !== 2 || format.bitsPerSample !== 16) {
    throw new ProbeFailure("unsupported_wav_format");
  }
  return pcm;
}

function ascii(bytes, offset, length) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    printFailure(error);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  let sourceBytes;
  let session;
  let eventConsumer;
  let eventFailure;
  let deadlineTimer;
  const abortController = new AbortController();
  const startedAt = performance.now();
  const stats = { partialSegmentIds: new Set(), finalSegments: new Map(), terminalState: undefined };
  deadlineTimer = setTimeout(() => abortController.abort(), MAX_WALL_TIME_MS);
  try {
    const apiKey = process.env.DASHSCOPE_API_KEY?.trim();
    const workspaceRaw = process.env.DASHSCOPE_WORKSPACE_ID?.trim();
    const workspaceId = workspaceRaw === undefined || workspaceRaw.length === 0 ? undefined : validateWorkspaceId(workspaceRaw);
    if (!apiKey) throw new ProbeFailure("api_key_missing");
    const endpoint = process.env.DASHSCOPE_REALTIME_ASR_ENDPOINT?.trim()
      || defaultEndpoint(workspaceId);

    const inputPath = resolve(args.input);
    const inputInfo = await stat(inputPath).catch(() => { throw new ProbeFailure("input_unreadable"); });
    if (!inputInfo.isFile() || inputInfo.size > MAX_INPUT_FILE_BYTES) throw new ProbeFailure("input_too_large");
    sourceBytes = await readFile(inputPath).catch(() => { throw new ProbeFailure("input_unreadable"); });
    const inputFormat = resolveInputFormat(args.input, args.format);
    const pcm = parsePcmInput(sourceBytes, inputFormat);

    // Load only after --help and local argument/audio validation, so the help
    // path works without a built package or any credentials.
    const { createQwenRealtimeVoiceProvider } = await import("../../packages/voice-provider-qwen/dist/index.js")
      .catch(() => { throw new ProbeFailure("provider_not_built"); });
    const provider = createQwenRealtimeVoiceProvider({
      endpoint,
      apiKey,
      ...(workspaceId ? { workspaceId } : {}),
      handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
      finishTimeoutMs: FINISH_TIMEOUT_MS,
    });

    session = await provider.start({ signal: abortController.signal });
    eventConsumer = consumeEvents(session.events, stats).catch((error) => { eventFailure = error; });

    let sequence = 0;
    for (let offset = 0; offset < pcm.byteLength; offset += CHUNK_BYTES) {
      assertNotAborted(abortController.signal);
      if (eventFailure !== undefined) throw eventFailure;
      const end = Math.min(offset + CHUNK_BYTES, pcm.byteLength);
      const data = new Uint8Array(pcm.subarray(offset, end));
      try {
        await session.appendAudioChunk({ sequence, data });
      } finally {
        data.fill(0);
      }
      sequence += 1;
      if (end < pcm.byteLength) await delay(Math.ceil((end - offset) / (BYTES_PER_SECOND / 1_000)), abortController.signal);
    }

    await waitWithAbort(session.finish(), abortController.signal);
    await eventConsumer;
    assertNotAborted(abortController.signal);
    if (eventFailure !== undefined) throw eventFailure;
    if (stats.terminalState !== "finished") throw new ProbeFailure("session_not_finished");

    const elapsedMs = Math.round(performance.now() - startedAt);
    const finalTranscript = [...stats.finalSegments.values()]
      .sort((left, right) => left.index - right.index)
      .map((segment) => segment.text)
      .join("")
      .trim();
    process.stdout.write(`Provider: ${PROVIDER_ID}\n`);
    process.stdout.write(`Elapsed: ${elapsedMs} ms\n`);
    process.stdout.write(`Partial segments: ${stats.partialSegmentIds.size}\n`);
    process.stdout.write(`Final segments: ${stats.finalSegments.size}\n`);
    process.stdout.write(`Final transcript: ${finalTranscript || "(none)"}\n`);
    if (!finalTranscript) process.exitCode = 3;
  } catch (error) {
    abortController.abort();
    printFailure(error);
    process.exitCode = 1;
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    await session?.cancel().catch(() => undefined);
    await eventConsumer?.catch(() => undefined);
    sourceBytes?.fill(0);
  }
}

async function consumeEvents(events, stats) {
  for await (const event of events) {
    if (event.type === "state_changed") {
      if (event.state === "failed") throw new ProbeFailure("provider_failed");
      if (event.state === "finished" || event.state === "cancelled") stats.terminalState = event.state;
      continue;
    }
    const segment = event.segment;
    if (segment.state === "partial") stats.partialSegmentIds.add(segment.segmentId);
    else stats.finalSegments.set(segment.segmentId, segment);
  }
}

function delay(milliseconds, signal) {
  if (milliseconds <= 0) return Promise.resolve();
  if (signal.aborted) return Promise.reject(new ProbeFailure("probe_timeout"));
  return new Promise((resolveDelay, rejectDelay) => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      rejectDelay(new ProbeFailure("probe_timeout"));
    };
    function done() {
      signal.removeEventListener("abort", abort);
      resolveDelay();
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function waitWithAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(new ProbeFailure("probe_timeout"));
  return new Promise((resolvePromise, rejectPromise) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      rejectPromise(new ProbeFailure("probe_timeout"));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", abort); resolvePromise(value); },
      (error) => { signal.removeEventListener("abort", abort); rejectPromise(error); },
    );
  });
}

function assertNotAborted(signal) {
  if (signal.aborted) throw new ProbeFailure("probe_timeout");
}

function printFailure(error) {
  const code = error instanceof ProbeFailure ? error.code : safeProviderCode(error);
  process.stderr.write(`Probe failed: ${code}\n`);
  if (code === "invalid_arguments" || code === "input_required") process.stderr.write("Run with --help for usage.\n");
}

function safeProviderCode(error) {
  if (error && typeof error === "object" && ["provider_timeout", "provider_unavailable", "provider_protocol_error"].includes(error.code)) {
    return error.code;
  }
  return "probe_failed";
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
