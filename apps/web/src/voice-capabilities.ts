import type { VoiceOutputAdapter } from "@computer-harness/voice";

export interface VoiceCapabilities {
  readAloud?: (text: string) => void | Promise<void>;
  transcribeOnce?: () => string | undefined | Promise<string | undefined>;
  /** Optional per-Web voice backend. Browser speech synthesis is used when omitted. */
  createOutputAdapter?: () => VoiceOutputAdapter;
}
