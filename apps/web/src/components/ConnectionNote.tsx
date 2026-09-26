import type { FeedConnection } from "../hooks/useRunFeed";

export function ConnectionNote({ connection }: { connection: FeedConnection }) {
  const text = connection === "live"
    ? "电脑状态已连接"
    : connection === "reconnecting"
      ? "正在重新连接电脑…"
      : connection === "offline"
        ? "电脑暂时无法连接"
        : "正在连接电脑…";
  return <span className={`connection-note connection-${connection}`} role="status">{text}</span>;
}
