import { describe, expect, it, vi } from "vitest";
import { Pcm16ChunkAssembler, Pcm16Resampler, SerialAudioUploadQueue, floatToPcm16 } from "./voice-pcm";

describe("voice PCM pipeline", () => {
  it("resamples continuous 48 kHz input to 16 kHz without losing frame phase", () => {
    const samples = Float32Array.from({ length: 4_800 }, (_value, index) => Math.sin(index / 19));
    const whole = new Pcm16Resampler(48_000);
    const wholeOutput = [...whole.process(samples), ...whole.finish()];
    const split = new Pcm16Resampler(48_000);
    const splitOutput = [
      ...split.process(samples.slice(0, 1_001)),
      ...split.process(samples.slice(1_001, 3_257)),
      ...split.process(samples.slice(3_257)),
      ...split.finish(),
    ];
    expect(wholeOutput).toHaveLength(1_600);
    expect(splitOutput).toEqual(wholeOutput);
  });

  it("converts float samples with clipping and assembles 100 ms PCM16 blocks plus a final tail", () => {
    expect([...floatToPcm16(Float32Array.from([-2, -1, 0, 1, 2]))]).toEqual([-32768, -32768, 0, 32767, 32767]);
    const assembler = new Pcm16ChunkAssembler(3_200);
    const first = assembler.append(new Int16Array(1_900).fill(12));
    expect(first).toHaveLength(1);
    expect(first[0]?.sequence).toBe(0);
    expect(first[0]?.data.byteLength).toBe(3_200);
    expect(assembler.append(new Int16Array(50))).toEqual([]);
    const tail = assembler.flush();
    expect(tail).toHaveLength(1);
    expect(tail[0]?.sequence).toBe(1);
    expect(tail[0]?.data.byteLength).toBe(700);
    expect(assembler.flush()).toEqual([]);
  });

  it("sends the first chunk immediately and batches ordered backlog under 350 ms simulated RTT", async () => {
    const batches: number[][] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const queue = new SerialAudioUploadQueue(
      async (chunks) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const sequences = chunks.map((chunk) => chunk.sequence);
        batches.push(sequences);
        await new Promise<void>((resolve) => setTimeout(resolve, 350));
        inFlight -= 1;
        return sequences;
      },
      () => undefined,
    );
    const firstChunk = { sequence: 0, data: new Uint8Array(3_200).fill(9) };
    queue.enqueue(firstChunk);
    expect(batches).toEqual([[0]]);
    expect(firstChunk.data.some((byte) => byte !== 0)).toBe(true);
    const observedBufferSizes: number[] = [];
    for (let sequence = 1; sequence < 12; sequence += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      queue.enqueue({ sequence, data: new Uint8Array(3_200).fill(9) });
      observedBufferSizes.push(queue.bufferedBytes);
    }
    await queue.flush();
    expect(batches.flat()).toEqual(Array.from({ length: 12 }, (_value, index) => index));
    expect(batches[0]).toEqual([0]);
    expect(batches.slice(1).every((batch) => batch.length <= 4)).toBe(true);
    expect(maxInFlight).toBe(1);
    expect(Math.max(...observedBufferSizes)).toBeLessThan(64_000);
    expect(queue.bufferedBytes).toBe(0);
    expect(firstChunk.data.every((byte) => byte === 0)).toBe(true);
  });

  it("applies bounded queue backpressure and aborts/zeroes in-flight audio on cancel", async () => {
    const firstChunk = { sequence: 0, data: new Uint8Array(3_200).fill(9) };
    const queue = new SerialAudioUploadQueue(async (_chunks, signal) => {
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    }, () => undefined);
    queue.enqueue(firstChunk);
    await Promise.resolve();
    queue.cancel();
    await expect(queue.flush()).rejects.toThrow(/cancelled|aborted/u);
    expect(firstChunk.data.every((byte) => byte === 0)).toBe(true);
    expect(queue.bufferedBytes).toBe(0);
  });

  it("rejects and clears a pending queue that exceeds the 64 KB budget", async () => {
    const abortSignal = vi.fn();
    const cancelled = new SerialAudioUploadQueue(async (_chunks, signal) => {
      signal.addEventListener("abort", abortSignal);
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      throw new Error("aborted");
    }, () => undefined);
    const chunks = Array.from({ length: 21 }, (_value, sequence) => ({ sequence, data: new Uint8Array(3_200).fill(1) }));
    for (const chunk of chunks.slice(0, 20)) cancelled.enqueue(chunk);
    expect(() => cancelled.enqueue(chunks[20]!)).toThrow(/backpressure/u);
    await Promise.resolve();
    expect(abortSignal).toHaveBeenCalled();
    await expect(cancelled.flush()).rejects.toThrow(/backpressure/u);
    expect(cancelled.bufferedBytes).toBe(0);
    expect(chunks.every((chunk) => chunk.data.every((byte) => byte === 0))).toBe(true);
  });
});
