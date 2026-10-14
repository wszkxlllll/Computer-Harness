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

/** Recognize only a leading app-target phrase; later source/destination apps are not treated as the start target. */
export function explicitApplicationHint(goal: string): string | undefined {
  const normalized = goal.normalize("NFKC").toLocaleLowerCase();
  const chinesePrefix = normalized.match(/^(?:(?:请|麻烦)(?:帮我)?|帮我)?(?:切换到|访问|打开|查看|检查|使用|运行|在|用)\s*([\p{Script=Latin}\p{Number}]+)/u)?.[1];
  if (chinesePrefix !== undefined && chinesePrefix.length > 0) return chinesePrefix;
  const englishPrefix = normalized.match(/^(?:switch\s+to|open|use|using|launch)\s+(?:the\s+)?([\p{Script=Latin}\p{Number}]+)/u)?.[1];
  return englishPrefix || undefined;
}

export function appNameMatchesHint(appName: string | undefined, hint: string | undefined): boolean {
  if (hint === undefined) return false;
  const normalizedName = (appName ?? "").normalize("NFKC").toLocaleLowerCase();
  const terms: readonly string[] = normalizedName.match(/[\p{Script=Latin}\p{Number}]+/gu) ?? [];
  return terms.includes(hint);
}
