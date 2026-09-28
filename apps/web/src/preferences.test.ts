import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREFERENCES,
  PREFERENCES_STORAGE_KEY,
  PREFERENCES_VERSION,
  readPreferences,
  writePreferences,
  type PreferenceStorage,
} from "./preferences";

class MemoryStorage implements PreferenceStorage {
  values = new Map<string, string>();

  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

describe("versioned local preferences", () => {
  it("starts with bounded defaults when storage is empty or malformed", () => {
    const storage = new MemoryStorage();
    expect(readPreferences(storage)).toEqual(DEFAULT_PREFERENCES);
    storage.setItem(PREFERENCES_STORAGE_KEY, "{bad json");
    expect(readPreferences(storage)).toEqual(DEFAULT_PREFERENCES);
    storage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify({ version: 44, assistant: { profile: "ignored" } }));
    expect(readPreferences(storage)).toEqual(DEFAULT_PREFERENCES);
  });

  it("persists only the typed preference fields and restores them on read", () => {
    const storage = new MemoryStorage();
    const preferences = {
      version: PREFERENCES_VERSION,
      presentation: { layoutMode: "simple" as const, textSize: "large" as const, highContrast: true, reduceMotion: true },
      assistant: { responseDetail: "detailed" as const, stepExplanation: "more" as const, preferredLanguage: "en" as const },
      voice: { runNoticesEnabled: true, speechRate: "fast" as const },
    };
    expect(writePreferences(preferences, storage)).toBe(true);
    expect(readPreferences(storage)).toEqual(preferences);
    expect(JSON.parse(storage.getItem(PREFERENCES_STORAGE_KEY)!).assistant).toEqual(preferences.assistant);
  });

  it("validates each stored enum and boolean against a known set", () => {
    const storage = new MemoryStorage();
    storage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify({
      version: PREFERENCES_VERSION,
      presentation: { layoutMode: "profile", textSize: "giant", highContrast: "yes", reduceMotion: false },
      assistant: { responseDetail: "verbose_forever", stepExplanation: "more", preferredLanguage: "unknown" },
    }));
    expect(readPreferences(storage)).toEqual({
      ...DEFAULT_PREFERENCES,
      presentation: { ...DEFAULT_PREFERENCES.presentation, reduceMotion: false },
      assistant: { ...DEFAULT_PREFERENCES.assistant, stepExplanation: "more" },
    });
  });

  it("handles unavailable storage without throwing", () => {
    const failing = {
      getItem() { throw new Error("blocked"); },
      setItem() { throw new Error("blocked"); },
    };
    expect(readPreferences(failing)).toEqual(DEFAULT_PREFERENCES);
    expect(writePreferences(DEFAULT_PREFERENCES, failing)).toBe(false);
  });

  it("migrates version 1 preferences and keeps notification speech disabled by default", () => {
    const storage = new MemoryStorage();
    storage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify({
      version: 1,
      presentation: { layoutMode: "simple", textSize: "large", highContrast: true, reduceMotion: false },
      assistant: { responseDetail: "concise", stepExplanation: "more", preferredLanguage: "zh-CN" },
    }));
    const migrated = readPreferences(storage);
    expect(migrated).toEqual({
      ...DEFAULT_PREFERENCES,
      presentation: { layoutMode: "simple", textSize: "large", highContrast: true, reduceMotion: false },
      assistant: { responseDetail: "concise", stepExplanation: "more", preferredLanguage: "zh-CN" },
      voice: { runNoticesEnabled: false, speechRate: "normal" },
    });
    expect(writePreferences(migrated, storage)).toBe(true);
    expect(JSON.parse(storage.getItem(PREFERENCES_STORAGE_KEY)!).version).toBe(PREFERENCES_VERSION);
  });
});
