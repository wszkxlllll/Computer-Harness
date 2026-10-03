import type { Pcm16AudioChunk } from "@computer-harness/voice";
import { VOICE_INPUT_MAX_BATCH_CHUNKS } from "@computer-harness/voice";

/** Stateful linear resampling keeps sample phase continuous across AudioWorklet frames. */
export class Pcm16Resampler {
  private pending = new Float32Array(0);
  private position = 0;
  private readonly step: number;

  public constructor(private readonly inputSampleRate: number, private readonly outputSampleRate = 16_000) {
    if (!Number.isFinite(inputSampleRate) || inputSampleRate <= 0
      || !Number.isFinite(outputSampleRate) || outputSampleRate <= 0) {
      throw new Error("Audio sample rate is invalid.");
    }
    this.step = inputSampleRate / outputSampleRate;
  }

  public process(input: Float32Array): Int16Array {
    if (input.length === 0) return new Int16Array(0);
    const previous = this.pending;
    const joined = new Float32Array(previous.length + input.length);
    joined.set(previous);
    joined.set(input, previous.length);
    const output: number[] = [];
    while (this.position + 1 < joined.length) {
      const index = Math.floor(this.position);
      const fraction = this.position - index;
      const left = joined[index] ?? 0;
      const right = joined[index + 1] ?? left;
      output.push(toPcm16(left + (right - left) * fraction));
      this.position += this.step;
    }
    // Keep one source sample for interpolation with the next frame. When the
    // resampling step skips beyond the current block, retain that distance as
    // a phase offset instead of dropping samples that have not arrived yet.
    const consumed = Math.min(Math.floor(this.position), Math.max(0, joined.length - 1));
    this.pending = joined.slice(consumed);
    this.position -= consumed;
    previous.fill(0);
    joined.fill(0);
    return Int16Array.from(output);
  }

  public finish(): Int16Array {
    const output: number[] = [];
    while (this.pending.length > 0 && this.position < this.pending.length) {
      const index = Math.floor(this.position);
      const fraction = this.position - index;
      const left = this.pending[index] ?? 0;
      const right = this.pending[index + 1] ?? left;
      output.push(toPcm16(left + (right - left) * fraction));
      this.position += this.step;
    }
    this.pending.fill(0);
    this.pending = new Float32Array(0);
    this.position = 0;
    return Int16Array.from(output);
  }

  public clear(): void {
    this.pending.fill(0);
    this.pending = new Float32Array(0);
    this.position = 0;
  }
}

/** Converts resampled values into little-endian PCM16 chunks with stable sequence numbers. */
export class Pcm16ChunkAssembler {
  private readonly pending: Uint8Array;
  private offset = 0;
  private sequence = 0;

  public constructor(private readonly chunkBytes = 3_200) {
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 2 || chunkBytes % 2 !== 0) {
      throw new Error("PCM chunk size must contain complete 16-bit samples.");
    }
    this.pending = new Uint8Array(chunkBytes);
  }

  public append(samples: Int16Array): Pcm16AudioChunk[] {
    const chunks: Pcm16AudioChunk[] = [];
    const view = new DataView(this.pending.buffer);
    for (const sample of samples) {
      view.setInt16(this.offset, sample, true);
      this.offset += 2;
      if (this.offset === this.chunkBytes) {
        chunks.push({ sequence: this.sequence++, data: this.pending.slice() });
        this.pending.fill(0);
        this.offset = 0;
      }
    }
    return chunks;
  }

  public flush(): Pcm16AudioChunk[] {
    if (this.offset === 0) return [];
    const chunk = { sequence: this.sequence++, data: this.pending.slice(0, this.offset) };
    this.pending.fill(0);
    this.offset = 0;
    return [chunk];
  }

  public clear(): void {
    this.pending.fill(0);
    this.offset = 0;
  }
}

export class SerialAudioUploadQueue<T> {
  private readonly pending: Pcm16AudioChunk[] = [];
  private readonly ownedChunks = new Set<Pcm16AudioChunk>();
  private drainPromise: Promise<void> | undefined;
  private queuedBytes = 0;
  private activeAbort: AbortController | undefined;
  private error: unknown;
  private cancelled = false;
  private lastSequence = -1;

  public constructor(
    private readonly upload: (chunks: readonly Pcm16AudioChunk[], signal: AbortSignal) => Promise<T>,
    private readonly onUploaded: (result: T) => void,
    private readonly maxBufferedBytes = 64_000,
  ) {}

  public enqueue(chunk: Pcm16AudioChunk): void {
    if (this.cancelled) { chunk.data.fill(0); throw new Error("voice upload was cancelled"); }
    if (this.error !== undefined) { chunk.data.fill(0); throw this.error; }
    if (!Number.isSafeInteger(chunk.sequence) || chunk.sequence !== this.lastSequence + 1) {
      chunk.data.fill(0);
      throw new Error("voice chunks must be enqueued in sequence");
    }
    if (this.queuedBytes + chunk.data.byteLength > this.maxBufferedBytes) {
      chunk.data.fill(0);
      this.error = new Error("voice upload backpressure limit reached");
      this.activeAbort?.abort();
      this.discardAll();
      throw this.error;
    }
    this.lastSequence = chunk.sequence;
    this.queuedBytes += chunk.data.byteLength;
    this.ownedChunks.add(chunk);
    this.pending.push(chunk);
    this.startDrain();
  }

  public async flush(): Promise<void> {
    while (this.drainPromise !== undefined) await this.drainPromise;
    this.startDrain();
    while (this.drainPromise !== undefined) await this.drainPromise;
    if (this.error !== undefined) throw this.error;
    if (this.cancelled) throw new Error("voice upload was cancelled");
  }

  public cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.activeAbort?.abort();
    this.discardAll();
  }

  public get bufferedBytes(): number {
    return this.queuedBytes;
  }

  private startDrain(): void {
    if (this.drainPromise !== undefined || this.cancelled || this.error !== undefined || this.pending.length === 0) return;
    let tracked: Promise<void>;
    tracked = this.drain().catch((error: unknown) => {
      this.error ??= error;
      this.activeAbort?.abort();
      this.discardPending();
    }).finally(() => {
      if (this.drainPromise === tracked) this.drainPromise = undefined;
      if (this.pending.length > 0 && !this.cancelled && this.error === undefined) this.startDrain();
    });
    this.drainPromise = tracked;
  }

  private async drain(): Promise<void> {
    while (this.pending.length > 0 && !this.cancelled && this.error === undefined) {
      const batch = this.pending.splice(0, VOICE_INPUT_MAX_BATCH_CHUNKS);
      const controller = new AbortController();
      this.activeAbort = controller;
      try {
        const result = await this.upload(batch, controller.signal);
        if (!this.cancelled) this.onUploaded(result);
      } catch (error) {
        this.error ??= error;
        throw this.error;
      } finally {
        for (const chunk of batch) this.release(chunk);
        if (this.activeAbort === controller) this.activeAbort = undefined;
      }
    }
  }

  private discardPending(): void {
    for (const chunk of this.pending.splice(0)) this.release(chunk);
  }

  private discardAll(): void {
    this.pending.length = 0;
    for (const chunk of [...this.ownedChunks]) this.release(chunk);
  }

  private release(chunk: Pcm16AudioChunk): void {
    chunk.data.fill(0);
    if (!this.ownedChunks.delete(chunk)) return;
    this.queuedBytes -= chunk.data.byteLength;
  }
}

export function floatToPcm16(samples: Float32Array): Int16Array {
  const result = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) result[index] = toPcm16(samples[index] ?? 0);
  return result;
}

function toPcm16(value: number): number {
  const clamped = Math.max(-1, Math.min(1, value));
  return clamped < 0 ? Math.round(clamped * 32_768) : Math.round(clamped * 32_767);
}
