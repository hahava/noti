import { useEffect, useRef, useState } from "react";
import { adminApi, type UpgradeInfo } from "./api";

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

const dateFormat = new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });

/** 시스템 화면의 업데이트 카드: 버전 확인 → (백업) → 업데이트 진행 상황 → 어드민 재시작 후 다시 연결 */
export function UpgradeCard() {
  const [info, setInfo] = useState<UpgradeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [backup, setBackup] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [starting, setStarting] = useState(false);
  const [checking, setChecking] = useState(false);
  // 어드민 교체 중이라 응답이 없는 상태 (업데이트 목표 버전)
  const [reconnectingTo, setReconnectingTo] = useState<string | null>(null);
  const [finishedVersion, setFinishedVersion] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement | null>(null);

  const load = async (refresh = false) => {
    const next = await adminApi.upgradeInfo(refresh);
    setInfo(next);
    setError(null);
    setSelected((prev) => prev || next.latestVersion || "");
    return next;
  };

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : "업데이트 정보를 불러오지 못했습니다."));
  }, []);

  const job = info?.job ?? null;
  const running = job?.status === "running";

  // 진행 중이면 2초마다 다시 읽는다. 어드민 단계까지 끝나면 어드민이 새로 뜰 때까지 기다린다.
  useEffect(() => {
    if (!running && !reconnectingTo) return;
    const timer = window.setInterval(async () => {
      try {
        const next = await load();
        if (next.job?.status === "done" && !reconnectingTo) {
          // 어드민 컨테이너를 찾지 못해 어드민 교체를 건너뛴 경우에는 바로 끝난다
          if (next.job.steps.find((s) => s.key === "admin")?.detail) setFinishedVersion(next.job.targetVersion);
          else setReconnectingTo(next.job.targetVersion);
        }
        // 새 어드민: 진행 기록이 없고 버전이 목표와 같다
        if (reconnectingTo && !next.job && next.adminVersion === reconnectingTo) {
          setFinishedVersion(reconnectingTo);
          setReconnectingTo(null);
        }
      } catch {
        // 어드민이 다시 시작되는 동안에는 응답이 없다
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [running, reconnectingTo]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [job?.log.length]);

  if (error) {
    return (
      <section className="card">
        <h3>업데이트</h3>
        <div className="alert alert--error">{error}</div>
      </section>
    );
  }
  if (!info) {
    return (
      <section className="card">
        <h3>업데이트</h3>
        <p className="muted">버전을 확인하는 중…</p>
      </section>
    );
  }

  const current = info.currentVersion;
  const isNewer = (v: string) => !current || compareVersions(v, current) > 0;
  const hasUpdate = Boolean(info.latestVersion && isNewer(info.latestVersion));
  const isDowngrade = Boolean(selected && current && compareVersions(selected, current) < 0);
  const isSame = Boolean(selected && current && selected === current);
  const notes = info.notes
    .filter((n) => selected && isNewer(n.version) && compareVersions(n.version, selected) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version));

  const start = async () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setStarting(true);
    try {
      await adminApi.startUpgrade(selected, backup);
      setFinishedVersion(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "업데이트를 시작하지 못했습니다.");
    } finally {
      setStarting(false);
      setConfirming(false);
    }
  };

  return (
    <section className="card">
      <div className="card__head">
        <h3>업데이트</h3>
        {info.supported && !running && !reconnectingTo && (
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            disabled={checking}
            onClick={() => {
              setChecking(true);
              load(true)
                .catch(() => undefined)
                .finally(() => setChecking(false));
            }}
          >
            {checking ? "확인 중…" : "새 버전 확인"}
          </button>
        )}
      </div>

      <div className="stat-grid">
        <div className="stat">
          <strong>{current ?? "알 수 없음"}</strong>
          <span>현재 버전</span>
        </div>
        <div className="stat">
          <strong>{info.latestVersion ?? "–"}</strong>
          <span>{hasUpdate ? "새 버전이 있습니다" : "최신 버전"}</span>
        </div>
      </div>

      {finishedVersion && <div className="alert alert--ok">{finishedVersion} 업데이트를 마쳤습니다.</div>}
      {!info.supported && <p className="hint">{info.reason}</p>}
      {info.checkError && <div className="alert alert--warn">{info.checkError}</div>}

      {reconnectingTo ? (
        <div className="alert alert--warn">어드민을 {reconnectingTo} 버전으로 다시 시작하는 중입니다. 잠시 기다리면 자동으로 다시 연결됩니다…</div>
      ) : job && (running || job.status === "failed") ? (
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
          <pre ref={logRef} className="code code--log">
            {job.log.join("\n") || "시작하는 중…"}
          </pre>
          {job.status === "failed" && (
            <div className="alert alert--error pre-wrap">
              업데이트에 실패했습니다. 실패한 서버는 이전 버전으로 되돌렸습니다.
              {"\n"}
              {job.error}
            </div>
          )}
        </div>
      ) : null}

      {info.supported && !running && !reconnectingTo && info.versions.length > 0 && (
        <div className="stack">
          <div className="form">
            <label className="field">
              <span>설치할 버전</span>
              <select
                value={selected}
                onChange={(e) => {
                  setSelected(e.target.value);
                  setConfirming(false);
                }}
              >
                {info.versions.map((v) => (
                  <option key={v} value={v}>
                    {v}
                    {v === info.latestVersion ? " (최신)" : ""}
                    {v === current ? " (현재)" : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {notes.length > 0 && (
            <details className="upgrade-notes" open>
              <summary>변경 사항</summary>
              {notes.map((n) => (
                <div key={n.version} className="upgrade-note">
                  <strong>
                    <a href={n.url} target="_blank" rel="noreferrer">
                      {n.name}
                    </a>
                  </strong>
                  <span className="muted"> · {dateFormat.format(new Date(n.publishedAt))}</span>
                  {n.body && <div className="pre-wrap small">{n.body}</div>}
                </div>
              ))}
            </details>
          )}

          {isDowngrade && (
            <div className="alert alert--warn">
              이전 버전으로 되돌립니다. DB 스키마는 그대로 두므로 데이터는 유지되지만, 새 버전에서만 있던 기능은 보이지 않습니다.
            </div>
          )}

          {info.databaseBackup ? (
            <label className="check">
              <input type="checkbox" checked={backup} onChange={(e) => setBackup(e.target.checked)} />
              업데이트 전에 DB 백업 (최근 5개 보관)
            </label>
          ) : (
            <p className="hint">외부 DB 를 쓰고 있습니다. 업데이트 전에 DB 를 직접 백업해 주세요.</p>
          )}

          <div className="actions">
            {confirming && <span className="muted">업데이트하는 동안 몇 초간 접속이 끊길 수 있습니다.</span>}
            <button type="button" className="btn btn--primary" disabled={!selected || isSame || starting} onClick={() => void start()}>
              {starting
                ? "시작하는 중…"
                : isSame
                  ? "현재 버전입니다"
                  : confirming
                    ? "확인 — 지금 업데이트"
                    : isDowngrade
                      ? `${selected}(으)로 되돌리기`
                      : `${selected}(으)로 업데이트`}
            </button>
          </div>
        </div>
      )}

      {(info.lastUpgrade || info.backups.length > 0) && (
        <p className="hint">
          {info.lastUpgrade &&
            `마지막 업데이트: ${info.lastUpgrade.from ?? "?"} → ${info.lastUpgrade.to} (${dateFormat.format(new Date(info.lastUpgrade.at))}). `}
          {info.backups.length > 0 && `DB 백업 ${info.backups.length}개 (최근: ${info.backups[0]}, 설정 볼륨의 backups 폴더).`}
        </p>
      )}
    </section>
  );
}
