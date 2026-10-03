import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, parsePcmInput, resolveInputFormat, resolveProbeProviderConfig } from "./probe-qwen-asr.mjs";

test("help and argument validation are offline", () => {
  assert.equal(parseArgs(["--help"]).help, true);
  assert.deepEqual(parseArgs(["--input", "clip.wav"]), { help: false, input: "clip.wav" });
  assert.deepEqual(parseArgs(["--input", "clip.data", "--format", "raw"]), {
    help: false, input: "clip.data", format: "raw",
  });
  assert.throws(() => parseArgs([]), { code: "input_required" });
  assert.throws(() => parseArgs(["--input", "a.wav", "--input", "b.wav"]), { code: "invalid_arguments" });
  assert.throws(() => parseArgs(["--input", "a.wav", "--format", "flac"]), { code: "invalid_arguments" });
});

test("accepts bounded raw PCM16 and infers supported extensions", () => {
  const raw = Buffer.alloc(3_200);
  assert.equal(parsePcmInput(raw, "raw").byteLength, 3_200);
  assert.equal(resolveInputFormat("test.wav"), "wav");
  assert.equal(resolveInputFormat("test.pcm"), "raw");
  assert.throws(() => parsePcmInput(Buffer.alloc(3_201), "raw"), { code: "invalid_audio" });
  assert.throws(() => parsePcmInput(Buffer.alloc(320_002), "raw"), { code: "invalid_audio" });
  assert.throws(() => resolveInputFormat("test.unknown"), { code: "format_required" });
});

test("accepts only mono 16 kHz PCM16 WAV and rejects unsupported WAV audio", () => {
  const valid = makeWav(Buffer.alloc(3_200));
  assert.equal(parsePcmInput(valid, "wav").byteLength, 3_200);
  assert.throws(() => parsePcmInput(makeWav(Buffer.alloc(3_200), { sampleRate: 48_000 }), "wav"), { code: "unsupported_wav_format" });
  assert.throws(() => parsePcmInput(Buffer.from("not a wave"), "wav"), { code: "invalid_wav" });
});

test("explicit endpoint ignores an unsafe workspace and never forwards it as a header value", () => {
  const normalizeWorkspaceId = (value) => /^[A-Za-z0-9-]{1,63}$/u.test(value ?? "") ? value : undefined;
  const resolveEndpoint = (endpoint, workspaceId) => endpoint?.trim()
    || (workspaceId ? `wss://${workspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime` : undefined);
  assert.deepEqual(resolveProbeProviderConfig("stale/invalid", "wss://custom.example/realtime", {
    normalizeWorkspaceId,
    resolveEndpoint,
  }), { endpoint: "wss://custom.example/realtime" });
  assert.throws(() => resolveProbeProviderConfig("stale/invalid", undefined, {
    normalizeWorkspaceId,
    resolveEndpoint,
  }), { code: "workspace_id_invalid" });
});

function makeWav(pcm, { sampleRate = 16_000, channels = 1, bitsPerSample = 16 } = {}) {
  const bytesPerSample = bitsPerSample / 8;
  const result = Buffer.alloc(44 + pcm.byteLength);
  result.write("RIFF", 0, "ascii");
  result.writeUInt32LE(36 + pcm.byteLength, 4);
  result.write("WAVE", 8, "ascii");
  result.write("fmt ", 12, "ascii");
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(channels, 22);
  result.writeUInt32LE(sampleRate, 24);
  result.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  result.writeUInt16LE(channels * bytesPerSample, 32);
  result.writeUInt16LE(bitsPerSample, 34);
  result.write("data", 36, "ascii");
  result.writeUInt32LE(pcm.byteLength, 40);
  pcm.copy(result, 44);
  return result;
}
