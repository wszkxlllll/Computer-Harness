import { createContext, useContext } from "react";
import type { VoiceInputCapabilities, VoiceOutputAdapter } from "@computer-harness/voice";

export const VoiceInputCapabilitiesContext = createContext<VoiceInputCapabilities | undefined>(undefined);

export function useVoiceInputCapabilities(): VoiceInputCapabilities | undefined {
  return useContext(VoiceInputCapabilitiesContext);
}

export interface VoiceCapabilities {
  readAloud?: (text: string) => void | Promise<void>;
  transcribeOnce?: () => string | undefined | Promise<string | undefined>;
  /** Optional per-Web voice backend. Browser speech synthesis is used when omitted. */
  createOutputAdapter?: () => VoiceOutputAdapter;
}
