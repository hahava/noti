import { useEffect, useState } from "react";
import { adminApi, type AuthEvent, type AuthEventQuery, type AuthEventResult, type AuthSummary } from "./api";

const RESULT_LABEL: Record<AuthEventResult, string> = {
  success: "성공",
  bad_password: "비밀번호 틀림",
  unknown_user: "없는 아이디",
  disabled: "비활성 계정",
  not_admin: "관리자 아님",
  throttled: "차단됨",
};

const when = (iso: string) =>
  new Date(iso).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** User-Agent를 "Chrome · macOS"처럼 짧게 (전체는 마우스를 올리면 보인다) */
function describeAgent(ua: string): string {
  if (!ua) return "알 수 없음";
  const app = /Electron\//.test(ua)
    ? "Noty 데스크톱"
    : /Edg\//.test(ua)
      ? "Edge"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : /curl|python|go-http|wget|node|axios|okhttp|java/i.test(ua)
              ? "스크립트"
              : "기타";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${app} · ${os}` : app;
}

export function SecurityPage() {
  const [summary, setSummary] = useState<AuthSummary | null>(null);
  const [events, setEvents] = useState<AuthEvent[] | null>(null);
  const [query, setQuery] = useState<AuthEventQuery>({ result: "", source: "", days: 7, username: "", ip: "" });
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSummary = () => adminApi.securitySummary().then(setSummary).catch((err) => setError(err.message));
  const loadEvents = (next: AuthEventQuery, append = false) =>
    adminApi
      .securityEvents(next)
      .then((res) => {
        setEvents((prev) => (append && prev ? [...prev, ...res.events] : res.events));
        setHasMore(res.events.length === 100);
      })
      .catch((err) => setError(err.message));

  useEffect(() => {
    void loadSummary();
  }, []);
  // 아이디·IP 칸은 타이핑마다 부르지 않게 잠깐 기다린다
  useEffect(() => {
    const timer = window.setTimeout(() => void loadEvents(query), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const filterBy = (patch: AuthEventQuery) => setQuery((prev) => ({ ...prev, ...patch }));
  const refresh = () => {
    void loadSummary();
    void loadEvents(query);
  };

  return (
    <div className="stack">
      {error && <div className="alert alert--error">{error}</div>}

      <section className="card">
        <div className="card__head">
          <div>
            <h3>최근 24시간</h3>
            <p className="hint">앱과 어드민 로그인을 모두 셉니다.</p>
          </div>
          <button type="button" className="btn" onClick={refresh}>
            새로고침
          </button>
        </div>
        <div className="stat-grid">
          <div className="stat">
            <strong className={summary && summary.failures24h > 0 ? "text-danger" : undefined}>{summary?.failures24h ?? "–"}</strong>
            <span>로그인 실패</span>
          </div>
          <div className="stat">
            <strong>{summary?.successes24h ?? "–"}</strong>
            <span>로그인 성공</span>
          </div>
          <div className="stat">
            <strong className={summary && summary.blockedIps.length > 0 ? "text-danger" : undefined}>{summary?.blockedIps.length ?? "–"}</strong>
            <span>지금 차단 중인 IP</span>
          </div>
          <div className="stat">
            <strong>{summary?.tokenProbes.length ?? "–"}</strong>
            <span>잘못된 토큰 IP (7일)</span>
          </div>
        </div>
        {summary && summary.blockedIps.length > 0 && (
          <p className="hint">
            차단 중:{" "}
            {summary.blockedIps.map((item, index) => (
              <span key={item.ip}>
                {index > 0 && ", "}
                <button type="button" className="link" onClick={() => filterBy({ ip: item.ip })}>
                  {item.ip}
                </button>{" "}
                ({item.attempts}회, {when(item.lastAt)})
              </span>
            ))}{" "}
            · 실패가 반복되면 15분간 막히고 저절로 풀립니다.
          </p>
        )}
      </section>

      <div className="security-grid">
        <section className="card card--flush">
          <h3 className="pad pad--head">실패가 많은 IP (7일)</h3>
          {summary && summary.topFailingIps.length === 0 ? (
            <div className="muted pad">실패한 로그인이 없습니다.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>IP</th>
                  <th className="num">실패</th>
                  <th>시도한 아이디</th>
                  <th>마지막</th>
                </tr>
              </thead>
              <tbody>
                {summary?.topFailingIps.map((item) => (
                  <tr key={item.ip}>
                    <td>
                      <button type="button" className="link mono" onClick={() => filterBy({ ip: item.ip, result: "failure" })}>
                        {item.ip}
                      </button>
                    </td>
                    <td className="num">{item.failures}</td>
                    <td className="clip" title={item.usernames.join(", ")}>
                      {item.usernames.join(", ") || "–"}
                    </td>
                    <td className="nowrap">{when(item.lastAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="card card--flush">
          <h3 className="pad pad--head">잘못된 토큰으로 들어온 요청 (7일)</h3>
          {summary && summary.tokenProbes.length === 0 ? (
            <div className="muted pad">없습니다.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>IP</th>
                  <th className="num">횟수</th>
                  <th>마지막 주소</th>
                  <th>마지막</th>
                </tr>
              </thead>
              <tbody>
                {summary?.tokenProbes.map((item) => (
                  <tr key={item.ip}>
                    <td className="mono" title={item.userAgent}>
                      {item.ip}
                    </td>
                    <td className="num">{item.count}</td>
                    <td className="clip mono" title={item.lastPath}>
                      {item.lastPath}
                    </td>
                    <td className="nowrap">{when(item.lastAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="hint pad">만료된 세션도 여기에 잡힙니다. 한 IP에서 횟수가 많거나 처음 보는 주소를 찌르면 의심해 보세요.</p>
        </section>
      </div>

      <section className="card card--flush">
        <div className="toolbar pad security-filters">
          <h3>로그인 기록</h3>
          <div className="security-filters__fields">
            <select value={query.result} onChange={(e) => filterBy({ result: e.target.value })} aria-label="결과">
              <option value="">모든 결과</option>
              <option value="failure">실패만</option>
              {(Object.keys(RESULT_LABEL) as AuthEventResult[]).map((key) => (
                <option key={key} value={key}>
                  {RESULT_LABEL[key]}
                </option>
              ))}
            </select>
            <select value={query.source} onChange={(e) => filterBy({ source: e.target.value })} aria-label="어디서">
              <option value="">앱 + 어드민</option>
              <option value="app">앱</option>
              <option value="admin">어드민</option>
            </select>
            <select value={query.days} onChange={(e) => filterBy({ days: Number(e.target.value) })} aria-label="기간">
              <option value={1}>1일</option>
              <option value={7}>7일</option>
              <option value={30}>30일</option>
              <option value={90}>90일</option>
            </select>
            <input placeholder="아이디" value={query.username} onChange={(e) => filterBy({ username: e.target.value })} aria-label="아이디" />
            <input placeholder="IP" value={query.ip} onChange={(e) => filterBy({ ip: e.target.value })} aria-label="IP" />
          </div>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>시각</th>
              <th>결과</th>
              <th>아이디</th>
              <th>IP</th>
              <th>브라우저</th>
              <th>어디서</th>
            </tr>
          </thead>
          <tbody>
            {events?.map((event) => (
              <tr key={event.id}>
                <td className="nowrap">{when(event.at)}</td>
                <td>
                  <span className={`badge ${event.result === "success" ? "badge--on" : "badge--danger"}`}>{RESULT_LABEL[event.result] ?? event.result}</span>
                </td>
                <td>
                  <button type="button" className="link" onClick={() => filterBy({ username: event.username })}>
                    {event.username || "–"}
                  </button>
                </td>
                <td>
                  <button type="button" className="link mono" onClick={() => filterBy({ ip: event.ip })}>
                    {event.ip}
                  </button>
                </td>
                <td className="nowrap" title={event.userAgent}>
                  {describeAgent(event.userAgent)}
                </td>
                <td>{event.source === "admin" ? "어드민" : "앱"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!events && <div className="muted pad">불러오는 중…</div>}
        {events?.length === 0 && <div className="muted pad">조건에 맞는 기록이 없습니다.</div>}
        {hasMore && events && (
          <div className="pad">
            <button type="button" className="btn" onClick={() => void loadEvents({ ...query, before: events[events.length - 1].id }, true)}>
              더 보기
            </button>
          </div>
        )}
      </section>

      <p className="muted">
        비밀번호는 기록하지 않습니다. 기록은 90일 보관합니다. 리버스 프록시(nginx, Cloudflare 등) 뒤에서 운영한다면 서버에 <code>TRUST_PROXY=1</code>이 있어야 실제 접속 IP가 찍히고, 없으면 모두 프록시 주소로 보입니다.
      </p>
    </div>
  );
}
