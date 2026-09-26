export interface VoiceCapabilities {
  readAloud?: (text: string) => void | Promise<void>;
  transcribeOnce?: () => string | undefined | Promise<string | undefined>;
}
