import { describe, expect, it, vi } from "vitest";
import type { QwenRealtimeConnection, QwenRealtimeEvent } from "@computer-harness/voice-provider-qwen";
import { createConfiguredVoiceProvider, resolveConfiguredVoiceEndpoint } from "./voice-provider-config.js";

function mockConnection() {
  const listeners = new Set<(event: unknown) => void>();
  const sent: QwenRealtimeEvent[] = [];
  const connection: QwenRealtimeConnection = {
    ready: Promise.resolve(),
    send(event) {
      sent.push(event);
      if (event.type === "session.update") queueMicrotask(() => {
        for (const listener of [...listeners]) listener(JSON.stringify({ type: "session.updated" }));
      });
    },
    onMessage(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    onError() { return () => undefined; },
    onClose() { return () => undefined; },
    close() {},
  };
  return { connection, sent };
}

describe("Host Qwen voice provider configuration", () => {
  it("prefers an explicit endpoint and derives Beijing WSS only from a safe workspace label", () => {
    expect(resolveConfiguredVoiceEndpoint({
      DASHSCOPE_REALTIME_ASR_ENDPOINT: "wss://custom.example/realtime",
      DASHSCOPE_WORKSPACE_ID: "ws-demo123",
    })).toBe("wss://custom.example/realtime");
    expect(resolveConfiguredVoiceEndpoint({
      DASHSCOPE_REALTIME_ASR_ENDPOINT: "wss://custom.example/realtime",
      DASHSCOPE_WORKSPACE_ID: "stale/invalid-workspace",
    })).toBe("wss://custom.example/realtime");
    expect(resolveConfiguredVoiceEndpoint({ DASHSCOPE_WORKSPACE_ID: "ws-demo123" }))
      .toBe("wss://ws-demo123.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime");
    expect(resolveConfiguredVoiceEndpoint({ DASHSCOPE_WORKSPACE_ID: "ws-demo.example.com" })).toBeUndefined();
    expect(resolveConfiguredVoiceEndpoint({ DASHSCOPE_WORKSPACE_ID: "ws-demo/evil" })).toBeUndefined();
    expect(resolveConfiguredVoiceEndpoint({})).toBeUndefined();
  });

  it("enables only when key and either explicit endpoint or safe workspace are present", () => {
    expect(createConfiguredVoiceProvider({ DASHSCOPE_API_KEY: "test-key" })).toBeUndefined();
    expect(createConfiguredVoiceProvider({ DASHSCOPE_API_KEY: "test-key", DASHSCOPE_WORKSPACE_ID: "invalid.host" })).toBeUndefined();
    expect(createConfiguredVoiceProvider({
      DASHSCOPE_API_KEY: "test-key",
      DASHSCOPE_WORKSPACE_ID: "ws-demo123",
    })?.capabilities()).toMatchObject({
      available: true,
      provider: "qwen3-asr-flash-realtime",
    });
    expect(createConfiguredVoiceProvider({
      DASHSCOPE_API_KEY: "test-key",
      DASHSCOPE_WORKSPACE_ID: "ws-demo123",
      DASHSCOPE_REALTIME_ASR_ENDPOINT: "ws://custom.example/realtime",
    })).toBeUndefined();
    const providerWithStaleWorkspace = createConfiguredVoiceProvider({
      DASHSCOPE_API_KEY: "test-key",
      DASHSCOPE_WORKSPACE_ID: "stale/invalid-workspace",
      DASHSCOPE_REALTIME_ASR_ENDPOINT: "wss://custom.example/realtime",
    });
    expect(providerWithStaleWorkspace?.capabilities()).toMatchObject({ available: true });
  });

  it("omits a stale unsafe workspace rather than sending it as a provider header", async () => {
    const { connection } = mockConnection();
    const connect = vi.fn(() => connection);
    const provider = createConfiguredVoiceProvider({
      DASHSCOPE_API_KEY: "test-key",
      DASHSCOPE_WORKSPACE_ID: "stale/invalid-workspace",
      DASHSCOPE_REALTIME_ASR_ENDPOINT: "wss://custom.example/realtime",
    }, { createConnection: connect });
    expect(provider).toBeDefined();
    const session = await provider!.start();
    expect(connect).toHaveBeenCalledWith("wss://custom.example/realtime?model=qwen3-asr-flash-realtime", {
      Authorization: "Bearer test-key",
      "OpenAI-Beta": "realtime=v1",
    });
    await session.cancel();
  });
});
