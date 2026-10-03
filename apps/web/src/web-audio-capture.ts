import type {
  Pcm16AudioChunk,
  VoiceAudioCaptureAdapter,
  VoiceAudioCaptureSession,
  VoiceCaptureEvent,
} from "@computer-harness/voice";
import { Pcm16ChunkAssembler, Pcm16Resampler } from "./voice-pcm";

export class VoiceCaptureError extends Error {
  public constructor(public readonly code: "secure_context_required" | "microphone_denied" | "capture_unavailable") {
    super(code);
    this.name = "VoiceCaptureError";
  }
}

export interface VoiceAudioCaptureEnvironment {
  readonly isSecureContext: boolean;
  readonly mediaDevices: Pick<MediaDevices, "getUserMedia">;
  readonly createAudioContext: () => AudioContext;
  readonly createAudioWorkletNode: (context: AudioContext) => AudioWorkletNode;
  readonly createModuleUrl: () => string;
  readonly revokeModuleUrl: (url: string) => void;
}

/** Browser microphone capture and resampling. It never uploads or stores audio. */
export class WebAudioCaptureAdapter implements VoiceAudioCaptureAdapter {
  public constructor(
    private readonly environment: VoiceAudioCaptureEnvironment = createBrowserEnvironment(),
    private readonly chunkBytes = 3_200,
  ) {}

  public async start(options: { readonly signal?: AbortSignal } = {}): Promise<VoiceAudioCaptureSession> {
    if (!this.environment.isSecureContext) throw new VoiceCaptureError("secure_context_required");
    if (options.signal?.aborted) throw new VoiceCaptureError("capture_unavailable");
    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;
    let source: MediaStreamAudioSourceNode | undefined;
    let processor: AudioWorkletNode | undefined;
    let silentGain: GainNode | undefined;
    let moduleUrl: string | undefined;
    try {
      stream = await this.environment.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      if (options.signal?.aborted) throw new VoiceCaptureError("capture_unavailable");
      context = this.environment.createAudioContext();
      moduleUrl = this.environment.createModuleUrl();
      await context.audioWorklet.addModule(moduleUrl);
      this.environment.revokeModuleUrl(moduleUrl);
      moduleUrl = undefined;
      source = context.createMediaStreamSource(stream);
      processor = this.environment.createAudioWorkletNode(context);
      silentGain = context.createGain();
      silentGain.gain.value = 0;
      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(context.destination);
      const capture = new WebAudioCaptureSession(
        stream,
        context,
        source,
        processor,
        silentGain,
        new Pcm16Resampler(context.sampleRate),
        new Pcm16ChunkAssembler(this.chunkBytes),
      );
      await context.resume();
      return capture;
    } catch (error) {
      if (moduleUrl !== undefined) this.environment.revokeModuleUrl(moduleUrl);
      stream?.getTracks().forEach((track) => track.stop());
      source?.disconnect();
      processor?.disconnect();
      silentGain?.disconnect();
      await context?.close().catch(() => undefined);
      if (error instanceof VoiceCaptureError) throw error;
      if (isPermissionError(error)) throw new VoiceCaptureError("microphone_denied");
      throw new VoiceCaptureError("capture_unavailable");
    }
  }
}

class WebAudioCaptureSession implements VoiceAudioCaptureSession {
  private readonly channel = new CaptureEventChannel();
  public readonly events: AsyncIterable<VoiceCaptureEvent> = this.channel;
  private stopped = false;
  private tracksStopped = false;
  private sequence = 0;
  private flushProcessor: ((flushed: boolean) => void) | undefined;

  public constructor(
    private readonly stream: MediaStream,
    private readonly context: AudioContext,
    private readonly source: MediaStreamAudioSourceNode,
    private readonly processor: AudioWorkletNode,
    private readonly silentGain: GainNode,
    private readonly resampler: Pcm16Resampler,
    private readonly assembler: Pcm16ChunkAssembler,
  ) {
    this.processor.port.onmessage = (event: MessageEvent<ArrayBuffer | { type?: string }>) => {
      if (this.stopped) return;
      if (event.data === null || typeof event.data !== "object") return;
      if (!(event.data instanceof ArrayBuffer) && event.data.type === "harness-flushed") {
        this.flushProcessor?.(true);
        this.flushProcessor = undefined;
        return;
      }
      if (!(event.data instanceof ArrayBuffer)) return;
      const frame = new Float32Array(event.data);
      const resampled = this.resampler.process(frame);
      frame.fill(0);
      this.publish(this.assembler.append(resampled));
      resampled.fill(0);
    };
    this.processor.port.onmessageerror = () => this.fail();
  }

  public async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopTracks();
    this.source.disconnect();
    await this.waitForWorkletFlush();
    this.stopped = true;
    this.processor.port.onmessage = null;
    this.processor.port.onmessageerror = null;
    await this.cleanupGraph();
    const tailSamples = this.resampler.finish();
    this.publish(this.assembler.append(tailSamples));
    tailSamples.fill(0);
    this.publish(this.assembler.flush());
    this.channel.push({ type: "capture_stopped" });
    this.channel.close();
  }

  public async cancel(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.processor.port.onmessage = null;
    this.processor.port.onmessageerror = null;
    this.flushProcessor?.(false);
    this.flushProcessor = undefined;
    await this.cleanupGraph();
    this.resampler.clear();
    this.assembler.clear();
    this.channel.discardAndClose();
  }

  private publish(chunks: readonly Pcm16AudioChunk[]): void {
    for (const chunk of chunks) this.channel.push({ type: "audio_chunk", chunk: { ...chunk, sequence: this.sequence++ } });
  }

  private fail(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.flushProcessor?.(false);
    this.flushProcessor = undefined;
    void this.cleanupGraph();
    this.resampler.clear();
    this.assembler.clear();
    this.channel.push({ type: "capture_failed", errorCode: "capture_unavailable" });
    this.channel.discardAndClose();
  }

  private async cleanupGraph(): Promise<void> {
    this.stopTracks();
    this.source.disconnect();
    this.processor.disconnect();
    this.processor.port.close();
    this.silentGain.disconnect();
    await this.context.close().catch(() => undefined);
  }

  private stopTracks(): void {
    if (this.tracksStopped) return;
    this.tracksStopped = true;
    this.stream.getTracks().forEach((track) => track.stop());
  }

  private async waitForWorkletFlush(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: number;
      const finishOrReject = (flushed: boolean) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        this.flushProcessor = undefined;
        if (flushed) resolve();
        else reject(new VoiceCaptureError("capture_unavailable"));
      };
      timer = window.setTimeout(() => finishOrReject(false), 500);
      this.flushProcessor = (flushed) => finishOrReject(flushed);
      this.processor.port.postMessage("harness-flush");
    });
  }
}

class CaptureEventChannel implements AsyncIterable<VoiceCaptureEvent> {
  private readonly values: VoiceCaptureEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<VoiceCaptureEvent>) => void> = [];
  private ended = false;

  public push(value: VoiceCaptureEvent): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  public close(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  public discardAndClose(): void {
    for (const event of this.values) if (event.type === "audio_chunk") event.chunk.data.fill(0);
    this.values.length = 0;
    this.close();
  }

  public [Symbol.asyncIterator](): AsyncIterator<VoiceCaptureEvent> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<VoiceCaptureEvent>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

function createBrowserEnvironment(): VoiceAudioCaptureEnvironment {
  return {
    isSecureContext: window.isSecureContext,
    mediaDevices: navigator.mediaDevices,
    createAudioContext: () => new AudioContext({ latencyHint: "interactive" }),
    createAudioWorkletNode: (context) => new AudioWorkletNode(context, "harness-pcm-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: "explicit",
    }),
    createModuleUrl: () => new URL("/harness-pcm-capture-worklet.js", window.location.origin).toString(),
    revokeModuleUrl: () => undefined,
  };
}

function isPermissionError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "PermissionDeniedError");
}
