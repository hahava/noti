import { useEffect, useState } from "react";
import { adminApi, type AdminStatus, type SystemConfig } from "./api";
import { UpgradeCard } from "./UpgradeCard";

type Message = { ok: boolean; text: string } | null;

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}시간 ${m}분` : `${m}분`;
}

export function SystemPage() {
  const [config, setConfig] = useState<SystemConfig | null>(null);
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, Message>>({});
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    adminApi.getSettings().then((res) => setConfig(res.config)).catch((err) => setError(err.message));
    adminApi.status().then(setStatus).catch(() => undefined);
  }, []);

  if (error) return <div className="alert alert--error">{error}</div>;
  if (!config) return <div className="muted">불러오는 중…</div>;

  const setMessage = (key: string, message: Message) => setMessages((prev) => ({ ...prev, [key]: message }));

  const run = async (key: string, action: () => Promise<Message>) => {
    setBusy(key);
    setMessage(key, null);
    try {
      setMessage(key, await action());
    } catch (err) {
      setMessage(key, { ok: false, text: err instanceof Error ? err.message : "요청에 실패했습니다." });
    } finally {
      setBusy(null);
    }
  };

  const save = (key: string, patch: Partial<SystemConfig>) =>
    run(key, async () => {
      const res = await adminApi.saveSettings(patch);
      setConfig(res.config);
      return { ok: true, text: "저장했습니다." };
    });
  const test = (key: string, payload: Record<string, unknown>) =>
    run(key, async () => {
      const res = await adminApi.test(payload);
      return { ok: res.ok, text: res.message };
    });

  const { storage, redis, database } = config;

  return (
    <div className="stack">
      {status && (
        <section className="card">
          <h3>서버 상태</h3>
          <div className="stat-grid">
            <div className="stat"><strong>{status.database.size}</strong><span>DB 크기</span></div>
            <div className="stat"><strong>{status.indexing.totalPages}</strong><span>페이지</span></div>
            <div className="stat"><strong>{formatUptime(status.admin.uptimeSeconds)}</strong><span>어드민 실행 시간</span></div>
            <div className="stat"><strong>{status.admin.nodeVersion}</strong><span>Node.js</span></div>
          </div>
          <p className="hint">{status.database.version.split(" on ")[0]} · 어드민 {status.admin.host}:{status.admin.port}</p>
        </section>
      )}

      <UpgradeCard />

      <section className="card">
        <h3>파일 스토리지</h3>
        <div className="form">
          <label className="field">
            <span>업로드 폴더</span>
            <input value={storage.localPath} onChange={(e) => setConfig({ ...config, storage: { ...storage, localPath: e.target.value } })} />
          </label>
          <label className="field">
            <span>최대 파일 크기 (MB)</span>
            <input
              type="number"
              min={1}
              value={storage.maxFileSizeMb}
              onChange={(e) => setConfig({ ...config, storage: { ...storage, maxFileSizeMb: Number(e.target.value) || 1 } })}
            />
          </label>
        </div>
        <div className="actions">
          {messages.storage && <span className={messages.storage.ok ? "text-ok" : "text-error"}>{messages.storage.text}</span>}
          <button type="button" className="btn" disabled={busy !== null} onClick={() => void test("storage", { target: "storage", storage })}>
            쓰기 테스트
          </button>
          <button type="button" className="btn btn--primary" disabled={busy !== null} onClick={() => void save("storage", { storage })}>
            저장
          </button>
        </div>
      </section>

      <section className="card">
        <h3>Redis (분산 협업)</h3>
        <div className="form">
          <label className="field">
            <span>URL</span>
            <input value={redis.url} onChange={(e) => setConfig({ ...config, redis: { ...redis, url: e.target.value } })} />
          </label>
          <label className="field">
            <span>키 접두어</span>
            <input value={redis.prefix} onChange={(e) => setConfig({ ...config, redis: { ...redis, prefix: e.target.value } })} />
          </label>
        </div>
        <p className="hint">협업 서버의 실제 Redis 연결은 서버 시작 시 환경변수(REDIS_URL)로 정해집니다. 여기 값은 기록과 연결 테스트용입니다.</p>
        <div className="actions">
          {messages.redis && <span className={messages.redis.ok ? "text-ok" : "text-error"}>{messages.redis.text}</span>}
          <button type="button" className="btn" disabled={busy !== null} onClick={() => void test("redis", { target: "redis", redis })}>
            연결 테스트
          </button>
          <button type="button" className="btn btn--primary" disabled={busy !== null} onClick={() => void save("redis", { redis })}>
            저장
          </button>
        </div>
      </section>

      <section className="card">
        <h3>데이터베이스</h3>
        <div className="form">
          <label className="field"><span>호스트</span><input value={database.host} onChange={(e) => setConfig({ ...config, database: { ...database, host: e.target.value } })} /></label>
          <label className="field"><span>포트</span><input type="number" value={database.port} onChange={(e) => setConfig({ ...config, database: { ...database, port: Number(e.target.value) } })} /></label>
          <label className="field"><span>DB 이름</span><input value={database.database} onChange={(e) => setConfig({ ...config, database: { ...database, database: e.target.value } })} /></label>
          <label className="field"><span>사용자</span><input value={database.user} onChange={(e) => setConfig({ ...config, database: { ...database, user: e.target.value } })} /></label>
          <label className="field"><span>비밀번호</span><input type="password" value={database.password ?? ""} onChange={(e) => setConfig({ ...config, database: { ...database, password: e.target.value } })} /></label>
        </div>
        <p className="hint">서버의 실제 DB 연결은 환경변수(DATABASE_URL)로 정해집니다. 여기서는 다른 DB 로의 연결 가능 여부를 확인할 수 있습니다.</p>
        <div className="actions">
          {messages.database && <span className={messages.database.ok ? "text-ok" : "text-error"}>{messages.database.text}</span>}
          <button type="button" className="btn" disabled={busy !== null} onClick={() => void test("database", { target: "postgres", database })}>
            연결 테스트
          </button>
        </div>
      </section>
    </div>
  );
}
