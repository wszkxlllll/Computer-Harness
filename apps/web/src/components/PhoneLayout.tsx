import { useEffect, useState, type ReactNode } from "react";
import { BrandHeader } from "./BrandHeader";

export type PhoneSection = "new" | "tasks" | "settings";

export function PhoneLayout({ children, active }: { children: ReactNode; active: PhoneSection }) {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const syncHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, []);
  const current = active === "new" && hash === "#recent-tasks" ? "tasks" : active;

  return (
    <div className="phone-layout">
      <BrandHeader />
      {children}
      <nav className="phone-bottom-nav" aria-label="手机主导航">
        <a href="/#new-task" aria-current={current === "new" ? "page" : undefined}>
          <NavIcon kind="new" />
          <span>新任务</span>
        </a>
        <a href="/#recent-tasks" aria-current={current === "tasks" ? "page" : undefined}>
          <NavIcon kind="tasks" />
          <span>任务</span>
        </a>
        <a href="/preferences" aria-current={current === "settings" ? "page" : undefined}>
          <NavIcon kind="settings" />
          <span>设置</span>
        </a>
      </nav>
    </div>
  );
}

function NavIcon({ kind }: { kind: PhoneSection }) {
  if (kind === "new") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 5v14M5 12h14" />
      </svg>
    );
  }
  return kind === "tasks" ? (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="m3 6 1 1 2-2M3 12l1 1 2-2M3 18l1 1 2-2" />
    </svg>
  ) : (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
      <path d="m19.4 15 .1.1 1.1.9-1.1 1.9-1.3-.5a7.8 7.8 0 0 1-1.5.9l-.2 1.4h-2.2l-.2-1.4a7.8 7.8 0 0 1-1.5-.9l-1.3.5-1.1-1.9 1.1-.9a6.2 6.2 0 0 1 0-1.8l-1.1-.9 1.1-1.9 1.3.5a7.8 7.8 0 0 1 1.5-.9l.2-1.4h2.2l.2 1.4a7.8 7.8 0 0 1 1.5.9l1.3-.5 1.1 1.9-1.1.9a6.2 6.2 0 0 1 0 1.8Z" transform="translate(-1 -1) scale(.95)" />
    </svg>
  );
}
