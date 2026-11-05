import { useEffect, useState, type FormEvent } from "react";
import { adminApi, getToken, setToken, setUnauthorizedHandler, setupApi, type AdminUser, type SetupJob } from "./api";
import { AccountsPage } from "./AccountsPage";
import { ModelsPage } from "./ModelsPage";
import { SetupWizard } from "./SetupWizard";
import { SystemPage } from "./SystemPage";

type Section = "accounts" | "models" | "system";

const SECTIONS: Array<{ id: Section; label: string; description: string }> = [
  { id: "accounts", label: "계정", description: "계정·역할·로그인 관리" },
  { id: "models", label: "AI 모델", description: "채팅·백그라운드·임베딩 모델과 색인·위키 상태" },
  { id: "system", label: "시스템", description: "스토리지·Redis·DB 설정과 서버 상태" },
];

function LoginScreen({ onLogin }: { onLogin: (user: AdminUser) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { token, user } = await adminApi.login(username, password);
      setToken(token);
      onLogin(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "로그인에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <form className="login__card" onSubmit={submit}>
        <div className="login__brand">
          <span className="brand-mark">N</span>
          <div>
            <h1>Noty 어드민</h1>
            <p>관리자 계정으로 로그인하세요.</p>
          </div>
        </div>
        <label className="field">
          <span>아이디</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required />
        </label>
        <label className="field">
          <span>비밀번호</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        {error && <div className="alert alert--error">{error}</div>}
        <button type="submit" className="btn btn--primary" disabled={busy}>
          {busy ? "로그인 중…" : "로그인"}
        </button>
      </form>
    </main>
  );
}

export function App() {
  const [user, setUser] = useState<AdminUser | null>(null);
  const [checking, setChecking] = useState(true);
  const [setup, setSetup] = useState<{ required: boolean; job: SetupJob | null }>({ required: false, job: null });
  const [section, setSection] = useState<Section>("accounts");

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setToken(null);
      setUser(null);
    });
    (async () => {
      // 설치가 끝나지 않았으면 로그인 대신 설치 마법사를 보여 준다.
      const status = await setupApi.status().catch(() => null);
      if (status?.setupRequired) {
        setSetup({ required: true, job: status.job });
        return;
      }
      if (!getToken()) return;
      await adminApi
        .me()
        .then((res) => setUser(res.user))
        .catch(() => setToken(null));
    })().finally(() => setChecking(false));
  }, []);

  if (checking) return <main className="login"><div className="muted">확인 중…</div></main>;
  if (setup.required) return <SetupWizard initialJob={setup.job} onFinished={() => setSetup({ required: false, job: null })} />;
  if (!user) return <LoginScreen onLogin={setUser} />;

  const current = SECTIONS.find((item) => item.id === section)!;
  return (
    <div className="shell">
      <aside className="nav">
        <div className="nav__brand">
          <span className="brand-mark">N</span>
          <strong>Noty 어드민</strong>
        </div>
        <nav>
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`nav__item ${section === item.id ? "nav__item--active" : ""}`}
              onClick={() => setSection(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="nav__footer">
          <div className="nav__user">
            <strong>{user.displayName}</strong>
            <span>@{user.username}</span>
          </div>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={async () => {
              await adminApi.logout().catch(() => undefined);
              setToken(null);
              setUser(null);
            }}
          >
            로그아웃
          </button>
        </div>
      </aside>
      <main className="content">
        <header className="content__header">
          <h2>{current.label}</h2>
          <p>{current.description}</p>
        </header>
        {section === "accounts" && <AccountsPage currentUser={user} />}
        {section === "models" && <ModelsPage />}
        {section === "system" && <SystemPage />}
      </main>
    </div>
  );
}
