import { useEffect, type ReactNode } from "react";

/** Focus the ready page title when available, otherwise the main landmark. Later updates do not refocus it. */
export function RouteFocusOnMount({ children }: { children: ReactNode }) {
  useEffect(() => {
    const main = document.getElementById("main-content");
    const title = main?.querySelector<HTMLElement>("h1[tabindex='-1']");
    (title ?? main)?.focus();
  }, []);

  return <>{children}</>;
}
