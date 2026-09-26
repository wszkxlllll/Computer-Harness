interface BrandHeaderProps {
  mode?: "phone" | "computer";
}

export function BrandHeader({ mode = "phone" }: BrandHeaderProps) {
  return (
    <header className="brand-header">
      <a className="brand-lockup" href="/" aria-label="Harness 控制台首页">
        <span className="brand-word">Harness</span>
      </a>
      {mode === "computer" && <a className="header-link" href="/">手机控制台</a>}
    </header>
  );
}
