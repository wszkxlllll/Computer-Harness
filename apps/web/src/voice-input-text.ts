/** Preserve an existing draft while adding a separately recognized utterance. */
export function appendVoiceInputText(current: string, recognized: string): string {
  const text = recognized.trim();
  if (!text) return current;
  const draft = current.trimEnd();
  if (!draft) return text;
  return draft + "\n" + text;
}
