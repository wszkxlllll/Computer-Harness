// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { WebAudioCaptureAdapter, type VoiceAudioCaptureEnvironment } from "./web-audio-capture";

function fakeEnvironment(overrides: Partial<VoiceAudioCaptureEnvironment> = {}, respondToFlush = true) {
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const mediaDevices = { getUserMedia: vi.fn(async () => stream) };
  const portState: { current: ((event: MessageEvent<ArrayBuffer | { type: string }>) => void) | null } = { current: null };
  const port = {
    onmessage: null as ((event: MessageEvent<ArrayBuffer | { type: string }>) => void) | null,
    onmessageerror: null as (() => void) | null,
    postMessage: vi.fn((message: unknown) => {
      if (message === "harness-flush" && respondToFlush) portState.current?.({ data: { type: "harness-flushed" } } as MessageEvent);
    }),
    close: vi.fn(),
  };
  Object.defineProperty(port, "onmessage", {
    get: () => portState.current,
    set: (value: typeof portState.current) => { portState.current = value; },
  });
  const processor = { port, connect: vi.fn(), disconnect: vi.fn() } as unknown as AudioWorkletNode;
  const source = { connect: vi.fn(), disconnect: vi.fn() } as unknown as MediaStreamAudioSourceNode;
  const gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() } as unknown as GainNode;
  const context = {
    sampleRate: 16_000,
    audioWorklet: { addModule: vi.fn(async () => undefined) },
    destination: {},
    createMediaStreamSource: vi.fn(() => source),
    createGain: vi.fn(() => gain),
    resume: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  } as unknown as AudioContext;
  const createAudioContext = vi.fn(() => context);
  const environment: VoiceAudioCaptureEnvironment = {
    isSecureContext: true,
    mediaDevices,
    createAudioContext,
    createAudioWorkletNode: () => processor,
    createModuleUrl: () => "blob:voice-worklet",
    revokeModuleUrl: vi.fn(),
    ...overrides,
  };
  return { environment, track, mediaDevices, processor, context, createAudioContext };
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe("WebAudioCaptureAdapter", () => {
  it("does not request a microphone in an insecure context", async () => {
    const fixture = fakeEnvironment({ isSecureContext: false });
    await expect(new WebAudioCaptureAdapter(fixture.environment).start()).rejects.toMatchObject({ code: "secure_context_required" });
    expect(fixture.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it("resamples Worklet frames, flushes the tail before stop, and releases device resources", async () => {
    const fixture = fakeEnvironment();
    const capture = await new WebAudioCaptureAdapter(fixture.environment).start();
    const eventsPromise = collect(capture.events);
    const samples = new Float32Array(1_600).fill(0.25);
    fixture.processor.port.onmessage?.({ data: samples.buffer } as MessageEvent<ArrayBuffer>);
    await capture.stop();
    const events = await eventsPromise;
    const chunks = events.flatMap((event) => event.type === "audio_chunk" ? [event.chunk] : []);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ sequence: 0 });
    expect(chunks[0]?.data.byteLength).toBe(3_200);
    expect(events.at(-1)).toEqual({ type: "capture_stopped" });
    expect(fixture.track.stop).toHaveBeenCalledTimes(1);
    expect(fixture.processor.port.postMessage).toHaveBeenCalledWith("harness-flush");
    expect(fixture.processor.port.close).toHaveBeenCalledTimes(1);
    expect(fixture.context.close).toHaveBeenCalledTimes(1);
  });

  it("cancels without flushing buffered audio", async () => {
    const fixture = fakeEnvironment();
    const capture = await new WebAudioCaptureAdapter(fixture.environment).start();
    const eventsPromise = collect(capture.events);
    const samples = new Float32Array(100).fill(0.25);
    fixture.processor.port.onmessage?.({ data: samples.buffer } as MessageEvent<ArrayBuffer>);
    await capture.cancel();
    const events = await eventsPromise;
    expect(events.some((event) => event.type === "audio_chunk")).toBe(false);
    expect(fixture.track.stop).toHaveBeenCalledTimes(1);
    expect(fixture.context.close).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing Worklet flush acknowledgement instead of treating a truncated tail as complete", async () => {
    const fixture = fakeEnvironment({}, false);
    const capture = await new WebAudioCaptureAdapter(fixture.environment).start();
    const eventsPromise = collect(capture.events);
    fixture.processor.port.onmessage?.({ data: new Float32Array(100).buffer } as MessageEvent<ArrayBuffer>);
    await expect(capture.stop()).rejects.toMatchObject({ code: "capture_unavailable" });
    await capture.cancel();
    const events = await eventsPromise;
    expect(events.some((event) => event.type === "capture_stopped")).toBe(false);
    expect(events.some((event) => event.type === "audio_chunk")).toBe(false);
    expect(fixture.track.stop).toHaveBeenCalledTimes(1);
    expect(fixture.context.close).toHaveBeenCalledTimes(1);
  });

  it("cancels a stop waiting on Worklet flush without cleaning the audio graph twice", async () => {
    const fixture = fakeEnvironment({}, false);
    const capture = await new WebAudioCaptureAdapter(fixture.environment).start();
    const stopping = capture.stop();
    await Promise.resolve();
    await capture.cancel();
    await expect(stopping).rejects.toMatchObject({ code: "capture_unavailable" });
    expect(fixture.track.stop).toHaveBeenCalledTimes(1);
    expect(fixture.context.close).toHaveBeenCalledTimes(1);
  });

  it("maps a denied microphone permission to a stable safe error", async () => {
    const denied = new DOMException("raw browser message", "NotAllowedError");
    const fixture = fakeEnvironment({
      mediaDevices: { getUserMedia: vi.fn(async () => { throw denied; }) },
    });
    await expect(new WebAudioCaptureAdapter(fixture.environment).start()).rejects.toMatchObject({ code: "microphone_denied" });
    expect(fixture.createAudioContext).not.toHaveBeenCalled();
  });
});
