export function formatDate(raw?: string): string {
  if (!raw) return "时间未知";
  const value = new Date(raw);
  return Number.isNaN(value.getTime()) ? "时间未知" : new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(value);
}
