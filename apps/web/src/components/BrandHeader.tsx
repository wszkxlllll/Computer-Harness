interface BrandHeaderProps {
  mode?: "phone" | "computer";
}

export function BrandHeader({ mode = "phone" }: BrandHeaderProps) {
  return (
    <header className="brand-header">
      <a className="brand-lockup" href="/" aria-label="Harness 控制台首页">
        <span className="brand-mark" aria-hidden="true">H</span>
        <span className="brand-word">Harness</span>
      </a>
      <nav className="header-links" aria-label="主导航">
        {mode === "computer" ? (
          <a href="/">手机控制台</a>
        ) : (
          <a href="/connect">电脑端连接管理</a>
        )}
      </nav>
    </header>
  );
}
