export function isValidBrowserUrl(value: string): boolean {
  const candidate = value.trim();
  if (!candidate || candidate.length > 2048) return false;
  if (!/^https?:\/\//i.test(candidate)) return false;
  try {
    const url = new URL(candidate);
    return (url.protocol === "http:" || url.protocol === "https:")
      && url.hostname.length > 0
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}
