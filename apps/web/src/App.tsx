import { useEffect, useState, type ReactNode } from "react";
import { ApiError, getPhoneSession, setPhoneCsrfToken } from "./api";
import { BrandHeader } from "./components/BrandHeader";
import { ConnectPhoneScreen } from "./ConnectPhoneScreen";
import { HomeScreen } from "./HomeScreen";
import { PairingScreen } from "./PairingScreen";
import { PreferencesScreen } from "./PreferencesScreen";
import { PreferencesProvider } from "./PreferencesContext";
import { RunWorkspace } from "./RunWorkspace";
import type { VoiceCapabilities } from "./voice-capabilities";

const pathname = window.location.pathname;

export function App({ voiceCapabilities }: { voiceCapabilities?: VoiceCapabilities }) {
  return (
    <PreferencesProvider>
      <AppRoutes voiceCapabilities={voiceCapabilities} />
    </PreferencesProvider>
  );
}

function AppRoutes({ voiceCapabilities }: { voiceCapabilities?: VoiceCapabilities }) {
  if (pathname === "/connect") return <ConnectPhoneScreen />;
  if (pathname === "/pair") return <PairingScreen />;
  if (pathname === "/preferences") return <PhoneSessionGate><PreferencesScreen voiceCapabilities={voiceCapabilities} /></PhoneSessionGate>;
  const runMatch = pathname.match(/^\/run\/([^/]+)\/?$/);
  if (runMatch) return <PhoneSessionGate><RunWorkspace runId={decodeURIComponent(runMatch[1])} voiceCapabilities={voiceCapabilities} /></PhoneSessionGate>;
  return <PhoneSessionGate><HomeScreen /></PhoneSessionGate>;
}

function PhoneSessionGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"loading" | "ready" | "unpaired" | "offline">("loading");
  const [error, setError] = useState<string>();

  async function connect() {
    setState("loading");
    setError(undefined);
    try {
      const session = await getPhoneSession();
      setPhoneCsrfToken(session.csrfToken);
      setState("ready");
    } catch (caught) {
      setPhoneCsrfToken(undefined);
      if (caught instanceof ApiError && caught.status === 401) {
        setState("unpaired");
      } else {
        setState("offline");
        setError(caught instanceof Error ? caught.message : "暂时无法连接电脑。");
      }
    }
  }

  useEffect(() => { void connect(); }, []);

  if (state === "ready") return <>{children}</>;
  if (state === "loading") {
    return <main className="page-shell"><div className="loading-panel" role="status">正在连接你的电脑…</div></main>;
  }
  return (
    <>
      <BrandHeader />
      <main className="page-shell narrow-page">
        <p className="eyebrow">手机控制台</p>
        <h1 className="page-title">{state === "unpaired" ? "先连接你的电脑" : "电脑暂时没有响应"}</h1>
        <div className={`notice ${state === "unpaired" ? "notice-info" : "notice-warning"}`} role={state === "offline" ? "alert" : "status"}>
          {state === "unpaired"
            ? "请在运行 Harness 的电脑上打开“连接手机”，扫描一次性二维码，并等待电脑本机确认。"
            : error || "电脑服务暂时不可达。确认电脑已开机并运行 Harness，再重新连接。"}
        </div>
        <div className="gate-actions">
          <button className="button button-primary button-large" type="button" onClick={() => void connect()}>重新连接</button>
          <a className="button button-secondary button-large" href="/connect">电脑端连接说明</a>
        </div>
      </main>
    </>
  );
}
