import { pool } from "./db.js";

/**
 * 보안 기록: 로그인 시도와 잘못된 토큰 접근 (메인 서버·어드민 서버가 함께 쓴다)
 *  - 비밀번호는 절대 남기지 않는다. 아이디·IP·브라우저 정보(User-Agent)·결과만.
 *  - 잘못된 토큰 접근은 요청마다 한 줄이 아니라 IP·날짜별 횟수로 묶는다 (DB가 불어나지 않게).
 *  - 90일 지난 기록은 하루 한 번 지운다.
 */

export type AuthEventSource = "app" | "admin";
export type AuthEventResult = "success" | "bad_password" | "unknown_user" | "disabled" | "not_admin" | "throttled";

export const AUTH_EVENT_RESULTS: readonly AuthEventResult[] = ["success", "bad_password", "unknown_user", "disabled", "not_admin", "throttled"];
export const AUTH_EVENT_RETENTION_DAYS = 90;

export interface AuthEvent {
  id: number;
  at: string;
  source: AuthEventSource;
  username: string;
  ip: string;
  userAgent: string;
  result: AuthEventResult;
}

export interface AuthEventFilter {
  result?: AuthEventResult | "failure";
  username?: string;
  ip?: string;
  source?: AuthEventSource;
  /** 최근 며칠 (1~90) */
  days?: number;
  limit?: number;
  /** 이 id보다 오래된 것 (더 보기) */
  before?: number;
}

const clip = (value: unknown, max: number) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

let schemaReady: Promise<void> | null = null;
export function ensureAuthEventTables(): Promise<void> {
  schemaReady ??= (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS auth_events (
        id BIGSERIAL PRIMARY KEY,
        at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        source VARCHAR(10) NOT NULL,
        username TEXT NOT NULL DEFAULT '',
        ip TEXT NOT NULL DEFAULT '',
        user_agent TEXT NOT NULL DEFAULT '',
        result VARCHAR(20) NOT NULL
      )`);
    await pool.query("CREATE INDEX IF NOT EXISTS idx_auth_events_at ON auth_events(at DESC)");
    await pool.query("CREATE INDEX IF NOT EXISTS idx_auth_events_ip ON auth_events(ip, at DESC)");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS auth_token_probes (
        ip TEXT NOT NULL,
        day DATE NOT NULL DEFAULT CURRENT_DATE,
        count INTEGER NOT NULL DEFAULT 0,
        last_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_path TEXT NOT NULL DEFAULT '',
        user_agent TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (ip, day)
      )`);
  })().catch((error) => {
    schemaReady = null; // 다음 호출에서 다시 시도
    throw error;
  });
  return schemaReady;
}

let lastPurgeAt = 0;
async function purgeOld(now = Date.now()): Promise<void> {
  if (now - lastPurgeAt < 24 * 60 * 60 * 1000) return;
  lastPurgeAt = now;
  await pool.query(`DELETE FROM auth_events WHERE at < NOW() - ($1::int * INTERVAL '1 day')`, [AUTH_EVENT_RETENTION_DAYS]);
  await pool.query(`DELETE FROM auth_token_probes WHERE day < CURRENT_DATE - $1::int`, [AUTH_EVENT_RETENTION_DAYS]);
}

/** 로그인 실패 이유: 계정이 없는지, 꺼져 있는지, 비밀번호가 틀렸는지 (기록용, 사용자에게는 같은 문구) */
export async function classifyLoginFailure(username: string): Promise<AuthEventResult> {
  const res = await pool.query("SELECT disabled_at FROM users WHERE LOWER(username) = $1 LIMIT 1", [username.trim().toLowerCase()]);
  if (!res.rows[0]) return "unknown_user";
  return res.rows[0].disabled_at ? "disabled" : "bad_password";
}

/** 기록은 로그인 응답을 막거나 실패시키지 않는다 (DB 문제여도 로그인은 그대로) */
export async function recordAuthEvent(event: { source: AuthEventSource; username: string; ip: string; userAgent?: string; result: AuthEventResult }): Promise<void> {
  try {
    await ensureAuthEventTables();
    await pool.query("INSERT INTO auth_events (source, username, ip, user_agent, result) VALUES ($1, $2, $3, $4, $5)", [
      event.source,
      clip(event.username, 100),
      clip(event.ip, 64),
      clip(event.userAgent, 300),
      event.result,
    ]);
    await purgeOld();
  } catch (error) {
    console.warn("[security] 로그인 기록 실패:", error instanceof Error ? error.message : error);
  }
}

/** 만료됐거나 꾸며낸 토큰으로 들어온 요청: IP·날짜별 횟수만 올린다 */
export async function recordTokenProbe(probe: { ip: string; path: string; userAgent?: string }): Promise<void> {
  try {
    await ensureAuthEventTables();
    await pool.query(
      `INSERT INTO auth_token_probes (ip, count, last_path, user_agent) VALUES ($1, 1, $2, $3)
       ON CONFLICT (ip, day) DO UPDATE SET count = auth_token_probes.count + 1, last_at = NOW(), last_path = EXCLUDED.last_path, user_agent = EXCLUDED.user_agent`,
      [clip(probe.ip, 64), clip(probe.path, 200), clip(probe.userAgent, 300)],
    );
  } catch (error) {
    console.warn("[security] 토큰 접근 기록 실패:", error instanceof Error ? error.message : error);
  }
}

/** 필터를 SQL WHERE로 (값은 모두 매개변수로 넘긴다) */
export function buildAuthEventQuery(filter: AuthEventFilter): { where: string; params: unknown[]; limit: number } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const days = Math.min(Math.max(Math.floor(filter.days ?? 7), 1), AUTH_EVENT_RETENTION_DAYS);
  params.push(days);
  clauses.push(`at > NOW() - ($${params.length}::int * INTERVAL '1 day')`);
  if (filter.result === "failure") clauses.push("result <> 'success'");
  else if (filter.result && AUTH_EVENT_RESULTS.includes(filter.result)) {
    params.push(filter.result);
    clauses.push(`result = $${params.length}`);
  }
  if (filter.source === "app" || filter.source === "admin") {
    params.push(filter.source);
    clauses.push(`source = $${params.length}`);
  }
  if (filter.username?.trim()) {
    params.push(filter.username.trim().toLowerCase());
    clauses.push(`LOWER(username) = $${params.length}`);
  }
  if (filter.ip?.trim()) {
    params.push(filter.ip.trim());
    clauses.push(`ip = $${params.length}`);
  }
  if (filter.before && Number.isFinite(filter.before)) {
    params.push(Math.floor(filter.before));
    clauses.push(`id < $${params.length}`);
  }
  const limit = Math.min(Math.max(Math.floor(filter.limit ?? 100), 1), 500);
  return { where: clauses.join(" AND "), params, limit };
}

export async function listAuthEvents(filter: AuthEventFilter): Promise<AuthEvent[]> {
  await ensureAuthEventTables();
  const { where, params, limit } = buildAuthEventQuery(filter);
  const res = await pool.query(
    `SELECT id, at, source, username, ip, user_agent, result FROM auth_events WHERE ${where} ORDER BY id DESC LIMIT ${limit}`,
    params,
  );
  return res.rows.map((row) => ({
    id: Number(row.id),
    at: new Date(row.at).toISOString(),
    source: row.source,
    username: row.username,
    ip: row.ip,
    userAgent: row.user_agent,
    result: row.result,
  }));
}

export interface AuthSummary {
  /** 최근 24시간 */
  failures24h: number;
  successes24h: number;
  /** 최근 15분 안에 차단 응답을 받은 IP (지금 막혀 있을 가능성이 큼) */
  blockedIps: Array<{ ip: string; lastAt: string; attempts: number }>;
  /** 최근 7일 실패가 많은 IP */
  topFailingIps: Array<{ ip: string; failures: number; usernames: string[]; lastAt: string }>;
  /** 최근 7일 잘못된 토큰으로 들어온 IP */
  tokenProbes: Array<{ ip: string; count: number; lastAt: string; lastPath: string; userAgent: string }>;
}

export async function getAuthSummary(): Promise<AuthSummary> {
  await ensureAuthEventTables();
  const [counts, blocked, top, probes] = await Promise.all([
    pool.query(`SELECT COUNT(*) FILTER (WHERE result <> 'success') AS failures, COUNT(*) FILTER (WHERE result = 'success') AS successes
                  FROM auth_events WHERE at > NOW() - INTERVAL '24 hours'`),
    pool.query(`SELECT ip, MAX(at) AS last_at, COUNT(*) AS attempts FROM auth_events
                 WHERE result = 'throttled' AND at > NOW() - INTERVAL '15 minutes' GROUP BY ip ORDER BY last_at DESC LIMIT 20`),
    pool.query(`SELECT ip, COUNT(*) AS failures, (ARRAY_AGG(DISTINCT username))[1:5] AS usernames, MAX(at) AS last_at FROM auth_events
                 WHERE result <> 'success' AND at > NOW() - INTERVAL '7 days' GROUP BY ip ORDER BY failures DESC LIMIT 10`),
    pool.query(`SELECT ip, SUM(count) AS count, MAX(last_at) AS last_at, (ARRAY_AGG(last_path ORDER BY last_at DESC))[1] AS last_path,
                       (ARRAY_AGG(user_agent ORDER BY last_at DESC))[1] AS user_agent
                  FROM auth_token_probes WHERE day > CURRENT_DATE - 7 GROUP BY ip ORDER BY count DESC LIMIT 10`)
  ]);
  const iso = (value: unknown) => new Date(value as string).toISOString();
  return {
    failures24h: Number(counts.rows[0]?.failures ?? 0),
    successes24h: Number(counts.rows[0]?.successes ?? 0),
    blockedIps: blocked.rows.map((row) => ({ ip: row.ip, lastAt: iso(row.last_at), attempts: Number(row.attempts) })),
    topFailingIps: top.rows.map((row) => ({ ip: row.ip, failures: Number(row.failures), usernames: row.usernames ?? [], lastAt: iso(row.last_at) })),
    tokenProbes: probes.rows.map((row) => ({ ip: row.ip, count: Number(row.count), lastAt: iso(row.last_at), lastPath: row.last_path, userAgent: row.user_agent })),
  };
}
