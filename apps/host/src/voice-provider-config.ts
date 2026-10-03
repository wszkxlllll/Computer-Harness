import {
  createQwenRealtimeVoiceProvider,
  normalizeQwenWorkspaceId,
  resolveQwenRealtimeEndpoint,
} from "@computer-harness/voice-provider-qwen";
import type { QwenRealtimeSocketFactory } from "@computer-harness/voice-provider-qwen";

export interface VoiceProviderEnvironment {
  readonly DASHSCOPE_API_KEY?: string;
  readonly DASHSCOPE_WORKSPACE_ID?: string;
  readonly DASHSCOPE_REALTIME_ASR_ENDPOINT?: string;
}

/** A configured endpoint wins; otherwise derive only from a safe workspace label. */
export function resolveConfiguredVoiceEndpoint(environment: VoiceProviderEnvironment): string | undefined {
  const explicitEndpoint = environment.DASHSCOPE_REALTIME_ASR_ENDPOINT?.trim();
  if (explicitEndpoint) return resolveQwenRealtimeEndpoint(explicitEndpoint);
  const safeWorkspaceId = normalizeQwenWorkspaceId(environment.DASHSCOPE_WORKSPACE_ID);
  return resolveQwenRealtimeEndpoint(undefined, safeWorkspaceId);
}

export function createConfiguredVoiceProvider(
  environment: VoiceProviderEnvironment = process.env as VoiceProviderEnvironment,
  options: { readonly createConnection?: QwenRealtimeSocketFactory } = {},
) {
  const apiKey = environment.DASHSCOPE_API_KEY?.trim();
  if (!apiKey) return undefined;
  const workspaceId = normalizeQwenWorkspaceId(environment.DASHSCOPE_WORKSPACE_ID);
  const endpoint = resolveConfiguredVoiceEndpoint({
    ...(workspaceId ? { DASHSCOPE_WORKSPACE_ID: workspaceId } : {}),
    ...(environment.DASHSCOPE_REALTIME_ASR_ENDPOINT === undefined
      ? {}
      : { DASHSCOPE_REALTIME_ASR_ENDPOINT: environment.DASHSCOPE_REALTIME_ASR_ENDPOINT }),
  });
  if (endpoint === undefined) return undefined;
  try {
    return createQwenRealtimeVoiceProvider({
      apiKey,
      endpoint,
      ...(workspaceId ? { workspaceId } : {}),
      ...(options.createConnection ? { createConnection: options.createConnection } : {}),
    });
  } catch {
    return undefined;
  }
}
