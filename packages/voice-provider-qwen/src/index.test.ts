import { describe, expect, it, vi } from "vitest";
import type { QwenRealtimeConnection, QwenRealtimeEvent } from "./index.js";
import { createQwenRealtimeVoiceProvider } from "./index.js";

interface MockConnection extends QwenRealtimeConnection {
  readonly sent: QwenRealtimeEvent[];
  emit(value: unknown): void;
  fail(): void;
  closeCount: number;
}

function mockConnection(autoSession = true, autoFinish = true): MockConnection {
  const messages = new Set<(value: unknown) => void>();
  const errors = new Set<() => void>();
  const closes = new Set<() => void>();
  const sent: QwenRealtimeEvent[] = [];
  let closeCount = 0;
  return {
    ready: Promise.resolve(),
    sent,
    send(event) {
      sent.push(event);
      if (event.type === "session.update" && autoSession) queueMicrotask(() => this.emit({ type: "session.updated" }));
      if (event.type === "session.finish" && autoFinish) queueMicrotask(() => {
        this.emit({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "item-1",
          content_index: 0,
          transcript: "你好，帮我查一下车票。",
        });
        this.emit({ type: "session.finished" });
      });
    },
    onMessage(listener) { messages.add(listener); return () => messages.delete(listener); },
    onError(listener) { errors.add(listener); return () => errors.delete(listener); },
    onClose(listener) { closes.add(listener); return () => closes.delete(listener); },
    emit(value) { for (const listener of [...messages]) listener(JSON.stringify(value)); },
    fail() { for (const listener of [...errors]) listener(); },
    close() { closeCount += 1; for (const listener of [...closes]) listener(); },
    get closeCount() { return closeCount; },
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

describe("Qwen realtime voice provider", () => {
  it("publishes provider identity and its audio capabilities", () => {
    const provider = createQwenRealtimeVoiceProvider({
      endpoint: "wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime",
      apiKey: "test-key",
    });
    expect(provider.providerId).toBe("qwen3-asr-flash-realtime");
    expect(provider.capabilities()).toMatchObject({
      available: true,
      provider: provider.providerId,
      sampleRate: 16_000,
      chunkBytes: 3_200,
      maxDurationMs: 60_000,
    });
  });

  it("uses the configured workspace WebSocket and maps partial/final events until session.finished", async () => {
    const socket = mockConnection();
    const connect = vi.fn(() => socket);
    const provider = createQwenRealtimeVoiceProvider({
      endpoint: "wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime",
      apiKey: "test-key",
      workspaceId: "workspace-123",
      createConnection: connect,
    });
    const session = await provider.start();
    const eventsPromise = collect(session.events);

    await session.appendAudioChunk({ sequence: 0, data: new Uint8Array(3_200) });
    socket.emit({
      type: "conversation.item.input_audio_transcription.text",
      item_id: "item-1",
      content_index: 0,
      text: "查一下",
      stash: "上海到杭州",
    });
    await session.finish();
    const events = await eventsPromise;

    expect(connect).toHaveBeenCalledWith(
      "wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime",
      {
        Authorization: "Bearer test-key",
        "OpenAI-Beta": "realtime=v1",
        "X-DashScope-WorkSpace": "workspace-123",
      },
    );
    expect(socket.sent[0]).toMatchObject({
      type: "session.update",
      session: {
        modalities: ["text"],
        input_audio_format: "pcm",
        sample_rate: 16_000,
        input_audio_transcription: { language: "zh" },
        turn_detection: null,
      },
    });
    const append = socket.sent.find((event) => event.type === "input_audio_buffer.append");
    expect(append?.audio).toBe(Buffer.alloc(3_200).toString("base64"));
    expect(socket.sent.slice(-2).map((event) => event.type)).toEqual(["input_audio_buffer.commit", "session.finish"]);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "state_changed", state: "starting" }),
      expect.objectContaining({ type: "state_changed", state: "recording" }),
      expect.objectContaining({
        type: "transcript_updated",
        segment: expect.objectContaining({ text: "查一下上海到杭州", state: "partial", revision: 0 }),
      }),
      expect.objectContaining({
        type: "transcript_updated",
        segment: expect.objectContaining({ text: "你好，帮我查一下车票。", state: "final", revision: 1 }),
      }),
      expect.objectContaining({ type: "state_changed", state: "finalizing" }),
      expect.objectContaining({ type: "state_changed", state: "finished" }),
    ]));
  });

  it("does not resend identical chunks and rejects changed duplicates or out-of-order chunks", async () => {
    const socket = mockConnection();
    const session = await createQwenRealtimeVoiceProvider({
      endpoint: "wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime",
      apiKey: "test-key",
      createConnection: () => socket,
    }).start();
    const chunk = new Uint8Array(3_200);
    await session.appendAudioChunk({ sequence: 0, data: chunk });
    await session.appendAudioChunk({ sequence: 0, data: chunk });
    await expect(session.appendAudioChunk({ sequence: 2, data: chunk })).rejects.toMatchObject({ code: "provider_protocol_error" });
    await expect(session.appendAudioChunk({ sequence: 1_200, data: chunk })).rejects.toMatchObject({ code: "provider_protocol_error" });
    await expect(session.appendAudioChunk({ sequence: 0, data: new Uint8Array([1, 0]) })).rejects.toMatchObject({ code: "provider_protocol_error" });
    await expect(session.appendAudioChunk({ sequence: 1, data: new Uint8Array([1]) })).rejects.toMatchObject({ code: "provider_protocol_error" });
    expect(socket.sent.filter((event) => event.type === "input_audio_buffer.append")).toHaveLength(1);
    await session.cancel();
  });

  it("maps provider errors to a fixed safe code and closes the session", async () => {
    const socket = mockConnection();
    const session = await createQwenRealtimeVoiceProvider({
      endpoint: "wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime",
      apiKey: "test-key",
      createConnection: () => socket,
    }).start();
    const eventsPromise = collect(session.events);
    socket.emit({ type: "error", error: { message: "private provider details and credential" } });
    const events = await eventsPromise;
    expect(events.at(-1)).toMatchObject({ type: "state_changed", state: "failed", errorCode: "provider_unavailable" });
    expect(JSON.stringify(events)).not.toContain("private provider details");
    expect(socket.closeCount).toBe(1);
  });

  it("keeps multiple transcript segments ordered and does not end the session when one segment is final", async () => {
    const socket = mockConnection();
    const session = await createQwenRealtimeVoiceProvider({
      endpoint: "wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime",
      apiKey: "test-key",
      createConnection: () => socket,
    }).start();
    const eventsPromise = collect(session.events);
    socket.emit({ type: "conversation.item.input_audio_transcription.text", item_id: "item-a", content_index: 0, text: "上海", stash: "站" });
    socket.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "item-a", content_index: 0, transcript: "上海站" });
    socket.emit({ type: "conversation.item.input_audio_transcription.text", item_id: "item-b", content_index: 0, text: "杭州", stash: "东站" });
    socket.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "item-b", content_index: 0, transcript: "杭州东站" });
    await session.cancel();
    const events = await eventsPromise;
    const segments = events.flatMap((event) => event.type === "transcript_updated" ? [event.segment] : []);
    expect(segments.filter((segment) => segment.state === "final")).toMatchObject([
      { segmentId: "item-a:0", index: 0, text: "上海站" },
      { segmentId: "item-b:0", index: 1, text: "杭州东站" },
    ]);
    expect(events.some((event) => event.type === "state_changed" && event.state === "finished")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "state_changed", state: "cancelled" });
  });

  it("bounds the initial WebSocket handshake timeout", async () => {
    const socket = mockConnection(false);
    await expect(createQwenRealtimeVoiceProvider({
      endpoint: "wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime",
      apiKey: "test-key",
      handshakeTimeoutMs: 100,
      createConnection: () => socket,
    }).start()).rejects.toMatchObject({ code: "provider_timeout" });
    expect(socket.closeCount).toBe(1);
  });

  it("preserves provider_timeout when a connecting WebSocket teardown itself throws", async () => {
    const socket = mockConnection(false);
    socket.close = () => { throw new Error("socket cleanup failed"); };
    await expect(createQwenRealtimeVoiceProvider({
      endpoint: "wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime",
      apiKey: "test-key",
      handshakeTimeoutMs: 100,
      createConnection: () => socket,
    }).start()).rejects.toMatchObject({ code: "provider_timeout" });
  });

  it("waits for the provider terminal event and reports a bounded finish timeout", async () => {
    const socket = mockConnection(true, false);
    const session = await createQwenRealtimeVoiceProvider({
      endpoint: "wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime",
      apiKey: "test-key",
      finishTimeoutMs: 100,
      createConnection: () => socket,
    }).start();
    const eventsPromise = collect(session.events);
    await expect(session.finish()).rejects.toMatchObject({ code: "provider_timeout" });
    expect((await eventsPromise).at(-1)).toMatchObject({ type: "state_changed", state: "failed", errorCode: "provider_timeout" });
  });

  it("rejects an insecure endpoint before opening a transport", () => {
    expect(() => createQwenRealtimeVoiceProvider({ endpoint: "ws://remote.example/realtime", apiKey: "test-key" }))
      .toThrow("wss URL");
  });
});
