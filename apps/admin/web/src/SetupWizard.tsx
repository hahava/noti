import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { setSetupCode, setupApi, type SetupEnvironment, type SetupJob, type SetupPlan } from "./api";

/**
 * 설치 마법사. 어드민을 처음 띄웠을 때(설치 설정 없음) 로그인 대신 나온다.
 * 자원마다 "이미 있는 것에 URL 로 연결" 또는 "이 서버에 Docker 로 만들기"를 고른다.
 */

type StepId = "code" | "environment" | "database" | "ai" | "services" | "admin" | "review" | "install";
const STEPS: { id: StepId; label: string }[] = [
  { id: "code", label: "설치 코드" },
  { id: "environment", label: "환경 확인" },
  { id: "database", label: "데이터베이스" },
  { id: "ai", label: "AI (Ollama)" },
  { id: "services", label: "서비스" },
  { id: "admin", label: "관리자" },
  { id: "review", label: "확인" },
  { id: "install", label: "설치" },
];

type Test = { ok: boolean; message: string; warnings?: string[] } | null;

function Choice({ checked, onSelect, title, children, disabled }: { checked: boolean; onSelect: () => void; title: string; children?: ReactNode; disabled?: boolean }) {
  return (
    <label className={`choice ${checked ? "choice--active" : ""} ${disabled ? "choice--disabled" : ""}`}>
      <input type="radio" checked={checked} onChange={onSelect} disabled={disabled} />
      <div>
        <strong>{title}</strong>
        {children && <div className="muted">{children}</div>}
      </div>
    </label>
  );
}

function TestLine({ test }: { test: Test }) {
  if (!test) return null;
  return (
    <div className="stack-sm">
      <span className={test.ok ? "text-ok" : "text-error"}>{test.message}</span>
      {test.warnings?.map((w) => (
        <span key={w} className="text-warn">
          {w}
        </span>
      ))}
    </div>
  );
}

export function SetupWizard({ initialJob, onFinished }: { initialJob: SetupJob | null; onFinished: () => void }) {
  const [step, setStep] = useState<StepId>(initialJob ? "install" : "code");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [env, setEnv] = useState<SetupEnvironment | null>(null);

  // 계획
  const [dbMode, setDbMode] = useState<"docker" | "external">("docker");
  const [dbPort, setDbPort] = useState(5433);
  const [dbUrl, setDbUrl] = useState("postgresql://noty:비밀번호@127.0.0.1:5432/noty");
  const [dbTest, setDbTest] = useState<Test>(null);

  const [ollamaMode, setOllamaMode] = useState<"external" | "docker" | "none">("external");
  const [ollamaUrl, setOllamaUrl] = useState("http://127.0.0.1:11434");
  const [gpu, setGpu] = useState(false);
  const [ollamaTest, setOllamaTest] = useState<(Test & { chatModels?: string[]; embeddingModels?: string[] }) | null>(null);
  const [chatModel, setChatModel] = useState("qwen3:8b");
  const [embeddingModel, setEmbeddingModel] = useState("bge-m3");
  const [pullModels, setPullModels] = useState(true);

  const [servicesMode, setServicesMode] = useState<"docker" | "manual">("docker");
  const [bind, setBind] = useState<"local" | "network">("local");
  const [apiPort, setApiPort] = useState(4000);
  const [collabPort, setCollabPort] = useState(4001);
  const [publicUrl, setPublicUrl] = useState("");

  const [adminName, setAdminName] = useState("admin");
  const [adminDisplay, setAdminDisplay] = useState("관리자");
  const [adminPassword, setAdminPassword] = useState("");
  const [adminPassword2, setAdminPassword2] = useState("");

  const [job, setJob] = useState<SetupJob | null>(initialJob);
  const logRef = useRef<HTMLPreElement>(null);

  const index = STEPS.findIndex((s) => s.id === step);
  const go = (id: StepId) => {
    setError(null);
    setStep(id);
  };
  const next = () => go(STEPS[Math.min(index + 1, STEPS.length - 1)].id);
  const back = () => go(STEPS[Math.max(index - 1, 0)].id);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : "요청에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };

  // 환경 확인 결과로 기본값을 고른다.
  const applyEnvironment = (result: SetupEnvironment) => {
    setEnv(result);
    if (!result.docker.available) {
      setDbMode("external");
      setServicesMode("manual");
      if (!result.ollama.found) setOllamaMode("external");
    }
    if (result.ollama.found) {
      setOllamaMode("external");
      setOllamaUrl(result.ollama.url);
    } else if (result.docker.available) {
      setOllamaMode("docker");
    }
    setGpu(result.docker.gpu);
  };

  // 설치 진행 상황
  useEffect(() => {
    if (step !== "install" || !job || job.status !== "running") return;
    const timer = window.setInterval(() => {
      setupApi
        .job()
        .then((res) => res.job && setJob(res.job))
        .catch(() => undefined);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [step, job?.status]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [job?.log.length]);

  const plan = (): SetupPlan => ({
    database: dbMode === "docker" ? { mode: "docker", port: dbPort } : { mode: "external", url: dbUrl.trim() },
    ollama: ollamaMode === "docker" ? { mode: "docker", gpu } : ollamaMode === "external" ? { mode: "external", url: ollamaUrl.trim() } : { mode: "none" },
    models: { chat: chatModel.trim(), embedding: embeddingModel.trim(), pull: pullModels },
    services: { mode: servicesMode, bind, apiPort, collabPort, publicUrl: publicUrl.trim() || undefined },
    admin: { username: adminName.trim(), displayName: adminDisplay.trim() || undefined, password: adminPassword },
  });

  const docker = env?.docker.available ?? false;

  let body: ReactNode = null;
  let footer: ReactNode = null;

  if (step === "code") {
    const submit = (event: FormEvent) => {
      event.preventDefault();
      void run(async () => {
        setSetupCode(code);
        await setupApi.verify();
        applyEnvironment(await setupApi.environment());
        next();
      });
    };
    body = (
      <form id="setup-code-form" onSubmit={submit} className="stack">
        <p>
          어드민을 처음 실행했습니다. 서버 콘솔(또는 설정 폴더의 <code>setup-code.txt</code>)에 나온 <strong>설치 코드</strong>를 입력하세요.
        </p>
        <pre className="code">docker logs noty-admin | grep "설치 코드"</pre>
        <label className="field">
          <span>설치 코드</span>
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXX-XXXX" autoFocus required />
        </label>
      </form>
    );
    footer = (
      <button type="submit" form="setup-code-form" className="btn btn--primary" disabled={busy || !code.trim()}>
        {busy ? "확인 중…" : "다음"}
      </button>
    );
  }

  if (step === "environment" && env) {
    const portRow = (port: number, label: string) => (
      <li key={port}>
        {env.ports[port] === null ? (
          <span className="muted">확인 불가</span>
        ) : (
          <span className={env.ports[port] ? "text-ok" : "text-warn"}>{env.ports[port] ? "비어 있음" : "사용 중"}</span>
        )}{" "}
        {port} — {label}
      </li>
    );
    body = (
      <div className="stack">
        <div className="check-list">
          <div className="check-item">
            <span className={docker ? "dot dot--ok" : "dot dot--off"} />
            <div>
              <strong>Docker {docker ? env.docker.version : "연결 안 됨"}</strong>
              <div className="muted">
                {docker
                  ? `${env.docker.os} · 이 서버에 DB·Ollama·서비스를 Docker 로 만들 수 있습니다.`
                  : `${env.docker.error} Docker 로 만들기 없이, 이미 있는 자원에 URL 로 연결하는 방식만 쓸 수 있습니다.`}
              </div>
            </div>
          </div>
          <div className="check-item">
            <span className={env.docker.gpu ? "dot dot--ok" : "dot dot--off"} />
            <div>
              <strong>NVIDIA GPU (Docker) {env.docker.gpu ? "사용 가능" : "없음"}</strong>
              <div className="muted">Ollama 를 Docker 로 만들 때만 필요합니다. 호스트에 직접 설치한 Ollama 는 상관없습니다.</div>
            </div>
          </div>
          <div className="check-item">
            <span className={env.ollama.found ? "dot dot--ok" : "dot dot--off"} />
            <div>
              <strong>Ollama {env.ollama.found ? `발견 (${env.ollama.version})` : "없음"}</strong>
              <div className="muted">{env.ollama.found ? `${env.ollama.url} 에서 응답합니다.` : "127.0.0.1:11434 에 Ollama 가 없습니다."}</div>
            </div>
          </div>
        </div>
        <div>
          <strong className="small">포트 (127.0.0.1)</strong>
          <ul className="port-list">
            {portRow(4000, "웹/API")}
            {portRow(4001, "협업")}
            {portRow(5433, "DB (Docker 로 만들 때)")}
            {portRow(11434, "Ollama")}
          </ul>
        </div>
        {env.networkMode === "bridge" && (
          <p className="muted small">
            Docker Desktop 방식으로 설치합니다. 이 컴퓨터의 127.0.0.1 주소(예: Ollama)를 적으면 컨테이너에서 닿는 주소로 자동으로 바꿔 연결합니다.
            포트가 겹치면 설치 단계에서 알려 줍니다.
          </p>
        )}
        {env.pending && <div className="alert alert--warn">이전에 끝나지 않은 설치가 있습니다. 같은 비밀값으로 이어서 진행합니다.</div>}
      </div>
    );
    footer = (
      <button type="button" className="btn btn--primary" onClick={next}>
        다음
      </button>
    );
  }

  if (step === "database") {
    body = (
      <div className="stack">
        <Choice checked={dbMode === "docker"} onSelect={() => setDbMode("docker")} title="이 서버에 Docker 로 만들기 (추천)" disabled={!docker}>
          Postgres 17 + pgvector + PGroonga(한국어 검색) 이미지를 만들고 127.0.0.1 에만 엽니다. 비밀번호는 자동으로 만듭니다.
        </Choice>
        {dbMode === "docker" && (
          <label className="field indent">
            <span>포트 (127.0.0.1)</span>
            <input type="number" value={dbPort} onChange={(e) => setDbPort(Number(e.target.value))} />
          </label>
        )}
        <Choice checked={dbMode === "external"} onSelect={() => setDbMode("external")} title="이미 있는 PostgreSQL 에 연결">
          pgvector 확장이 필요하고, PGroonga 가 있으면 한국어 키워드 검색이 좋아집니다.
        </Choice>
        {dbMode === "external" && (
          <div className="indent stack-sm">
            <label className="field">
              <span>연결 주소</span>
              <input value={dbUrl} onChange={(e) => setDbUrl(e.target.value)} placeholder="postgresql://user:password@host:5432/db" />
            </label>
            <div className="row">
              <button type="button" className="btn" disabled={busy} onClick={() => void run(async () => setDbTest(await setupApi.testDatabase(dbUrl.trim())))}>
                연결 테스트
              </button>
              <TestLine test={dbTest} />
            </div>
          </div>
        )}
      </div>
    );
    footer = (
      <button type="button" className="btn btn--primary" disabled={dbMode === "external" && !dbTest?.ok} onClick={next}>
        다음
      </button>
    );
  }

  if (step === "ai") {
    const models = ollamaTest?.ok ? ollamaTest : null;
    body = (
      <div className="stack">
        <Choice checked={ollamaMode === "external"} onSelect={() => setOllamaMode("external")} title="이미 있는 Ollama 에 URL 로 연결">
          같은 서버면 loopback(<code>http://127.0.0.1:11434</code>), 다른 GPU 서버면 그 주소.
        </Choice>
        {ollamaMode === "external" && (
          <div className="indent stack-sm">
            <label className="field">
              <span>Ollama 주소</span>
              <input value={ollamaUrl} onChange={(e) => setOllamaUrl(e.target.value)} />
            </label>
            <div className="row">
              <button type="button" className="btn" disabled={busy} onClick={() => void run(async () => setOllamaTest(await setupApi.testOllama(ollamaUrl.trim())))}>
                연결 테스트
              </button>
              <TestLine test={ollamaTest} />
            </div>
          </div>
        )}
        <Choice checked={ollamaMode === "docker"} onSelect={() => setOllamaMode("docker")} title="이 서버에 Docker 로 만들기" disabled={!docker}>
          ollama/ollama 컨테이너를 127.0.0.1:11434 에 띄웁니다.
        </Choice>
        {ollamaMode === "docker" && (
          <label className="switch indent">
            <input type="checkbox" checked={gpu} onChange={(e) => setGpu(e.target.checked)} disabled={!env?.docker.gpu} />
            NVIDIA GPU 사용 {env?.docker.gpu ? "" : "(Docker 에서 GPU 를 찾지 못함: NVIDIA Container Toolkit 필요)"}
          </label>
        )}
        <Choice checked={ollamaMode === "none"} onSelect={() => setOllamaMode("none")} title="지금은 설정하지 않기">
          설치 후 어드민 → AI 모델에서 OpenAI·Claude·Gemini 등을 연결할 수 있습니다.
        </Choice>

        {ollamaMode !== "none" && (
          <div className="card card--inner stack-sm">
            <div className="grid-2">
              <label className="field">
                <span>채팅·위키 정리 모델</span>
                <input list="setup-chat-models" value={chatModel} onChange={(e) => setChatModel(e.target.value)} />
                <datalist id="setup-chat-models">{models?.chatModels?.map((m) => <option key={m} value={m} />)}</datalist>
              </label>
              <label className="field">
                <span>임베딩(의미 검색) 모델</span>
                <input list="setup-embedding-models" value={embeddingModel} onChange={(e) => setEmbeddingModel(e.target.value)} />
                <datalist id="setup-embedding-models">{models?.embeddingModels?.map((m) => <option key={m} value={m} />)}</datalist>
              </label>
            </div>
            <label className="switch">
              <input type="checkbox" checked={pullModels} onChange={(e) => setPullModels(e.target.checked)} />
              Ollama 에 없는 모델은 설치하면서 받기
            </label>
          </div>
        )}
      </div>
    );
    footer = (
      <button type="button" className="btn btn--primary" disabled={ollamaMode === "external" && !ollamaTest?.ok} onClick={next}>
        다음
      </button>
    );
  }

  if (step === "services") {
    body = (
      <div className="stack">
        <Choice checked={servicesMode === "docker"} onSelect={() => setServicesMode("docker")} title="이 서버에 Docker 로 실행 (추천)" disabled={!docker}>
          웹/API(<code>noty-api</code>)와 협업(<code>noty-collab</code>) 컨테이너를 어드민과 같은 이미지로 띄웁니다.
        </Choice>
        <Choice checked={servicesMode === "manual"} onSelect={() => setServicesMode("manual")} title="직접 실행">
          필요한 환경변수를 보여 드리고, 서비스가 뜰 때까지 기다립니다.
        </Choice>
        <div className="grid-2">
          <label className="field">
            <span>웹/API 포트</span>
            <input type="number" value={apiPort} onChange={(e) => setApiPort(Number(e.target.value))} />
          </label>
          <label className="field">
            <span>협업 포트 (내부용)</span>
            <input type="number" value={collabPort} onChange={(e) => setCollabPort(Number(e.target.value))} />
          </label>
        </div>
        <div className="stack-sm">
          <strong className="small">접속 범위</strong>
          <Choice checked={bind === "local"} onSelect={() => setBind("local")} title="이 서버에서만 (127.0.0.1)">
            리버스 프록시나 VPN(Tailscale 등)으로 열 때. 가장 안전합니다.
          </Choice>
          <Choice checked={bind === "network"} onSelect={() => setBind("network")} title="같은 네트워크 전체 (0.0.0.0)">
            사내망·집 공유기 안에서 <code>http://서버주소:{apiPort}</code> 로 바로 접속할 때.
          </Choice>
        </div>
        <label className="field">
          <span>접속 주소 (선택)</span>
          <input value={publicUrl} onChange={(e) => setPublicUrl(e.target.value)} placeholder="https://noty.example.com" />
          <span className="hint">사용자가 브라우저로 여는 주소. 비워 두면 같은 주소에서 연 화면과 Electron 앱만 허용합니다.</span>
        </label>
      </div>
    );
    footer = (
      <button type="button" className="btn btn--primary" onClick={next}>
        다음
      </button>
    );
  }

  if (step === "admin") {
    const mismatch = adminPassword2.length > 0 && adminPassword !== adminPassword2;
    body = (
      <div className="stack">
        <p className="muted">Noty 와 어드민에 로그인할 첫 관리자 계정입니다. 다른 계정은 설치 후 어드민에서 만듭니다.</p>
        <div className="grid-2">
          <label className="field">
            <span>아이디</span>
            <input value={adminName} onChange={(e) => setAdminName(e.target.value)} autoComplete="username" />
          </label>
          <label className="field">
            <span>표시 이름</span>
            <input value={adminDisplay} onChange={(e) => setAdminDisplay(e.target.value)} />
          </label>
          <label className="field">
            <span>비밀번호 (8자 이상)</span>
            <input type="password" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} autoComplete="new-password" />
          </label>
          <label className="field">
            <span>비밀번호 확인</span>
            <input type="password" value={adminPassword2} onChange={(e) => setAdminPassword2(e.target.value)} autoComplete="new-password" />
          </label>
        </div>
        {mismatch && <span className="text-error">비밀번호가 서로 다릅니다.</span>}
      </div>
    );
    footer = (
      <button type="button" className="btn btn--primary" disabled={!adminName.trim() || adminPassword.length < 8 || adminPassword !== adminPassword2} onClick={next}>
        다음
      </button>
    );
  }

  if (step === "review") {
    const p = plan();
    const rows: [string, string][] = [
      ["데이터베이스", p.database.mode === "docker" ? `Docker 로 만들기 · 127.0.0.1:${p.database.port}` : `연결 · ${p.database.url.replace(/:[^:@/]+@/, ":****@")}`],
      [
        "Ollama",
        p.ollama.mode === "docker" ? `Docker 로 만들기 · ${p.ollama.gpu ? "GPU" : "CPU"}` : p.ollama.mode === "external" ? `연결 · ${p.ollama.url}` : "사용 안 함",
      ],
      ["모델", p.ollama.mode === "none" ? "-" : `채팅 ${p.models.chat} · 임베딩 ${p.models.embedding}${p.models.pull ? " · 없으면 받기" : ""}`],
      [
        "서비스",
        `${p.services.mode === "docker" ? "Docker 로 실행" : "직접 실행"} · ${p.services.bind === "local" ? "127.0.0.1" : "0.0.0.0"}:${p.services.apiPort}${p.services.publicUrl ? ` · ${p.services.publicUrl}` : ""}`,
      ],
      ["관리자", p.admin.username],
    ];
    body = (
      <div className="stack">
        <table className="table">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}>
                <th>{k}</th>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">설치를 시작하면 단계별 진행 상황이 나옵니다. 실패하면 원인을 보고 설정을 고쳐 다시 시도할 수 있습니다(데이터는 유지).</p>
      </div>
    );
    footer = (
      <button
        type="button"
        className="btn btn--primary"
        disabled={busy}
        onClick={() =>
          void run(async () => {
            const res = await setupApi.install(plan());
            setJob(res.job);
            go("install");
          })
        }
      >
        설치 시작
      </button>
    );
  }

  if (step === "install" && job) {
    body = (
      <div className="stack">
        <ol className="progress-steps">
          {job.steps.map((s) => (
            <li key={s.key} className={`progress-step progress-step--${s.status}`}>
              <span className="progress-step__icon">{{ pending: "○", running: "◐", done: "✓", skipped: "–", failed: "✕" }[s.status]}</span>
              <div>
                <strong>{s.label}</strong>
                {s.detail && <div className={s.status === "failed" ? "text-error pre-wrap" : "muted"}>{s.detail}</div>}
              </div>
            </li>
          ))}
        </ol>
        {job.manualEnv && job.status === "running" && (
          <div className="stack-sm">
            <strong className="small">api·collab 을 아래 환경변수로 실행해 주세요</strong>
            <pre className="code">{job.manualEnv}</pre>
          </div>
        )}
        <pre ref={logRef} className="code code--log">
          {job.log.join("\n") || "시작하는 중…"}
        </pre>
        {job.status === "done" && (
          <div className="alert alert--ok">
            설치가 끝났습니다. Noty: <strong>{job.appUrl}</strong> — 방금 만든 관리자 계정으로 로그인하세요.
          </div>
        )}
      </div>
    );
    footer =
      job.status === "done" ? (
        <button type="button" className="btn btn--primary" onClick={onFinished}>
          어드민 로그인
        </button>
      ) : job.status === "failed" ? (
        <button type="button" className="btn btn--primary" onClick={() => go(code ? "review" : "code")}>
          설정 고쳐서 다시 시도
        </button>
      ) : (
        <span className="muted">설치 중…</span>
      );
  }

  return (
    <main className="setup">
      <div className="setup__card">
        <header className="setup__header">
          <div className="login__brand">
            <span className="brand-mark">N</span>
            <div>
              <h1>Noty 설치</h1>
              <p>{STEPS[index].label}</p>
            </div>
          </div>
          <ol className="setup__steps">
            {STEPS.map((s, i) => (
              <li key={s.id} className={i < index ? "is-done" : i === index ? "is-current" : ""} title={s.label} />
            ))}
          </ol>
        </header>
        <section className="setup__body">{body}</section>
        {error && <div className="alert alert--error pre-wrap">{error}</div>}
        <footer className="setup__footer">
          {index > 0 && step !== "install" && (
            <button type="button" className="btn btn--ghost" onClick={back} disabled={busy}>
              이전
            </button>
          )}
          <span className="spacer" />
          {footer}
        </footer>
      </div>
    </main>
  );
}
