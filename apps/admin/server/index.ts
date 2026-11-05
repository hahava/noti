import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "@noty/core/db";
import { LoginThrottle } from "@noty/core/http-security";
import { listModels, type ModelPurpose, type ModelVendor } from "@noty/core/ai-models";
import { testEmbeddingConnection } from "@noty/core/embedding-client";
import {
  getDigestStats,
  getIndexingStatus,
  requestDigestRegeneration,
  requestFullReindex,
} from "@noty/core/maintenance";
import {
  getSystemSettingsFromDb,
  resolveMaskedAIKey,
  resolveMaskedKeyFor,
  saveSystemSettingsToDb,
  testAIConnection,
  testDatabaseConnection,
  testRedisConnection,
  testStorageDirectory,
  type SystemConfig,
} from "@noty/core/settings";
import {
  createManagedUser,
  createSession,
  deleteManagedUser,
  ensureUserColumns,
  getUserBySessionToken,
  listManagedUsers,
  resetManagedUserPassword,
  revokeSessionToken,
  revokeUserSessions,
  updateManagedUser,
  UserAdminError,
  verifyCredentials,
  type AuthUser,
} from "@noty/core/users";
import {
  getJob,
  initSetupMode,
  inspectEnvironment,
  setupRequired,
  startInstall,
  testDatabaseUrl,
  testOllamaUrl,
  verifySetupCode,
  type SetupPlan,
} from "./setup.js";

/**
 * Noty 어드민 서버 (메인 앱과 다른 포트)
 *  - 계정·역할 관리, 모델(채팅/백그라운드/임베딩) 설정, 검색 색인·LLM 위키 상태, 시스템 설정
 *  - 메인 서버와 같은 DB·공유 모듈(@noty/core)을 쓴다.
 *  - 기본은 127.0.0.1 에만 열린다 (ADMIN_HOST 로 바꿀 수 있음). admin 역할만 로그인할 수 있다.
 *  - 빌드된 어드민 화면(web/dist)이 있으면 같은 포트에서 함께 제공한다.
 */

const PORT = Number(process.env.ADMIN_PORT || 4010);
const HOST = process.env.ADMIN_HOST || "127.0.0.1";
const loginThrottle = new LoginThrottle();
const MAX_BODY_BYTES = 1024 * 1024;
const WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "dist");

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new HttpError(413, "요청이 너무 큽니다.");
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpError(400, "JSON 형식이 올바르지 않습니다.");
  }
}

function bearerToken(req: IncomingMessage): string | null {
  const match = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

async function requireAdmin(req: IncomingMessage): Promise<AuthUser> {
  const token = bearerToken(req);
  const user = token ? await getUserBySessionToken(token) : null;
  if (!user) throw new HttpError(401, "로그인이 필요합니다.");
  if (user.role !== "admin") throw new HttpError(403, "관리자만 어드민에 접근할 수 있습니다.");
  return user;
}

/* --------------------------------------------------------------------------
 * 정적 파일 (빌드된 어드민 화면)
 * ------------------------------------------------------------------------ */

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

async function serveStatic(pathname: string, res: ServerResponse): Promise<boolean> {
  const relative = decodeURIComponent(pathname).replace(/^\/+/, "") || "index.html";
  const filePath = path.resolve(WEB_DIST, relative);
  if (!filePath.startsWith(WEB_DIST)) return false;
  for (const candidate of [filePath, path.join(WEB_DIST, "index.html")]) {
    try {
      if (!(await stat(candidate)).isFile()) continue;
      res.writeHead(200, { "Content-Type": MIME[path.extname(candidate)] || "application/octet-stream" });
      res.end(await readFile(candidate));
      return true;
    } catch {
      // 다음 후보 (SPA: 없는 경로는 index.html)
    }
  }
  return false;
}

/* --------------------------------------------------------------------------
 * 라우팅
 * ------------------------------------------------------------------------ */

const VENDORS: ModelVendor[] = ["openai", "anthropic", "ollama", "gemini", "custom"];

async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<void> {
  const method = req.method || "GET";

  if (method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, { status: "ok", service: "noty-admin" });
    return;
  }

  /* ---- 설치 마법사 ---- */
  if (method === "GET" && pathname === "/api/setup/status") {
    sendJson(res, 200, { setupRequired: setupRequired(), job: getJob() });
    return;
  }
  if (pathname.startsWith("/api/setup/")) {
    // 설치가 끝나면 설치 API(와 Docker 제어)는 잠긴다. 진행 상황 조회만 남긴다.
    if (!setupRequired() && !(method === "GET" && pathname === "/api/setup/job")) {
      throw new HttpError(409, "이미 설치가 끝났습니다.");
    }
    const ip = req.socket.remoteAddress || "unknown";
    const retryAfter = loginThrottle.retryAfterSeconds("setup", ip);
    if (retryAfter > 0) throw new HttpError(429, `설치 코드 입력이 너무 많이 틀렸습니다. ${Math.ceil(retryAfter / 60)}분 뒤에 다시 시도해 주세요.`);
    if (setupRequired() && !verifySetupCode(String(req.headers["x-setup-code"] || ""))) {
      loginThrottle.recordFailure("setup", ip);
      throw new HttpError(401, "설치 코드가 올바르지 않습니다. 어드민 콘솔(또는 설정 폴더의 setup-code.txt)에서 확인하세요.");
    }
    await handleSetup(req, res, pathname, method);
    return;
  }
  if (setupRequired()) {
    throw new HttpError(503, "아직 설치가 끝나지 않았습니다. 설치 마법사를 먼저 진행해 주세요.");
  }

  // 로그인: 기존 계정·세션을 쓰되 admin 역할만 통과
  if (method === "POST" && pathname === "/api/auth/login") {
    const body = await readJsonBody<{ username?: string; password?: string }>(req);
    const username = body.username || "";
    const ip = req.socket.remoteAddress || "unknown";
    const retryAfter = loginThrottle.retryAfterSeconds(username, ip);
    if (retryAfter > 0) throw new HttpError(429, `로그인 시도가 너무 많습니다. ${Math.ceil(retryAfter / 60)}분 뒤에 다시 시도해 주세요.`);
    const user = await verifyCredentials(username, body.password || "");
    if (!user) {
      loginThrottle.recordFailure(username, ip);
      throw new HttpError(401, "아이디 또는 비밀번호가 올바르지 않습니다.");
    }
    loginThrottle.recordSuccess(username, ip);
    if (user.role !== "admin") throw new HttpError(403, "관리자 계정만 어드민에 로그인할 수 있습니다.");
    const token = await createSession(user.id);
    sendJson(res, 200, { token, user });
    return;
  }
  if (method === "POST" && pathname === "/api/auth/logout") {
    const token = bearerToken(req);
    if (token) await revokeSessionToken(token);
    sendJson(res, 200, { ok: true });
    return;
  }

  const admin = await requireAdmin(req);

  if (method === "GET" && pathname === "/api/auth/me") {
    sendJson(res, 200, { user: admin });
    return;
  }

  /* ---- 계정 ---- */
  if (pathname === "/api/users") {
    if (method === "GET") {
      sendJson(res, 200, { users: await listManagedUsers() });
      return;
    }
    if (method === "POST") {
      const body = await readJsonBody<{ username: string; displayName?: string; password: string; role?: any }>(req);
      sendJson(res, 201, { user: await createManagedUser(body) });
      return;
    }
  }
  const userMatch = pathname.match(/^\/api\/users\/([a-zA-Z0-9._-]+)(\/password|\/revoke-sessions)?$/);
  if (userMatch) {
    const [, userId, action] = userMatch;
    if (!action && method === "PATCH") {
      const body = await readJsonBody<{ displayName?: string; role?: any; disabled?: boolean }>(req);
      // 자기 자신을 비활성화하거나 관리자에서 내리면 어드민에서 바로 쫓겨나므로 막는다.
      if (userId === admin.id && (body.disabled === true || (body.role !== undefined && body.role !== "admin"))) {
        throw new HttpError(400, "자기 계정은 비활성화하거나 관리자 역할을 해제할 수 없습니다.");
      }
      sendJson(res, 200, { user: await updateManagedUser(userId, body) });
      return;
    }
    if (!action && method === "DELETE") {
      if (userId === admin.id) throw new HttpError(400, "자기 계정은 삭제할 수 없습니다.");
      const transferTo = url.searchParams.get("transferTo") || admin.id;
      sendJson(res, 200, await deleteManagedUser(userId, transferTo));
      return;
    }
    if (action === "/password" && method === "POST") {
      const body = await readJsonBody<{ password: string }>(req);
      await resetManagedUserPassword(userId, body.password);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (action === "/revoke-sessions" && method === "POST") {
      if (userId === admin.id) throw new HttpError(400, "지금 쓰고 있는 자기 세션은 여기서 끊을 수 없습니다.");
      sendJson(res, 200, { revoked: await revokeUserSessions(userId) });
      return;
    }
  }

  /* ---- 설정 (모델·시스템) ---- */
  if (pathname === "/api/settings") {
    if (method === "GET") {
      sendJson(res, 200, { config: await getSystemSettingsFromDb(true) });
      return;
    }
    if (method === "PUT") {
      const body = await readJsonBody<{ config?: Partial<SystemConfig> }>(req);
      if (!body.config || typeof body.config !== "object") throw new HttpError(400, "config 객체가 필요합니다.");
      // 메인 서버의 작업자는 설정이 바뀐 것을 스스로 감지해 다시 시도한다 (다른 프로세스).
      sendJson(res, 200, { config: await saveSystemSettingsToDb(body.config, admin.id) });
      return;
    }
  }

  if (method === "POST" && pathname === "/api/settings/test") {
    const body = await readJsonBody<{
      target: "postgres" | "redis" | "storage" | "ai" | "embedding";
      keyTarget?: "chat" | "background";
      database?: any;
      redis?: any;
      storage?: any;
      ai?: any;
      embedding?: any;
    }>(req);
    if (body.target === "postgres") {
      sendJson(res, 200, await testDatabaseConnection(body.database || {}));
      return;
    }
    if (body.target === "redis") {
      sendJson(res, 200, await testRedisConnection(body.redis?.url || ""));
      return;
    }
    if (body.target === "storage") {
      sendJson(res, 200, await testStorageDirectory(body.storage?.localPath || ""));
      return;
    }
    if (body.target === "ai") {
      const ai = { ...(body.ai || {}) };
      ai.apiKey = body.keyTarget === "background" ? await resolveMaskedKeyFor("background", ai.apiKey) : await resolveMaskedAIKey(ai.apiKey);
      sendJson(res, 200, await testAIConnection(ai));
      return;
    }
    if (body.target === "embedding") {
      const current = await getSystemSettingsFromDb(false);
      const embedding = { ...current.embedding, ...(body.embedding || {}) };
      embedding.apiKey = await resolveMaskedKeyFor("embedding", embedding.apiKey);
      sendJson(res, 200, await testEmbeddingConnection(embedding));
      return;
    }
    throw new HttpError(400, `알 수 없는 테스트 대상입니다: ${body.target}`);
  }

  if (method === "POST" && pathname === "/api/models") {
    const body = await readJsonBody<{ target?: "chat" | "background" | "embedding"; provider?: ModelVendor; baseUrl?: string; apiKey?: string }>(req);
    const target = body.target === "embedding" || body.target === "background" ? body.target : "chat";
    if (!body.provider || !VENDORS.includes(body.provider)) throw new HttpError(400, "지원하지 않는 프로바이더입니다.");
    const purpose: ModelPurpose = target === "embedding" ? "embedding" : "chat";
    try {
      const apiKey = await resolveMaskedKeyFor(target, body.apiKey);
      sendJson(res, 200, await listModels({ provider: body.provider, baseUrl: body.baseUrl, apiKey }, purpose));
    } catch (error) {
      sendJson(res, 200, { models: [], message: error instanceof Error ? error.message : "모델 목록을 불러오지 못했습니다." });
    }
    return;
  }

  /* ---- 상태 / 유지 작업 ---- */
  if (method === "GET" && pathname === "/api/status") {
    const [indexing, digests, db] = await Promise.all([
      getIndexingStatus(),
      getDigestStats(),
      pool.query<{ version: string; size: string }>(
        "SELECT version() AS version, pg_size_pretty(pg_database_size(current_database())) AS size",
      ),
    ]);
    sendJson(res, 200, {
      indexing,
      digests,
      database: { version: db.rows[0]?.version ?? "", size: db.rows[0]?.size ?? "" },
      admin: { nodeVersion: process.version, uptimeSeconds: Math.floor(process.uptime()), port: PORT, host: HOST },
    });
    return;
  }
  if (method === "POST" && pathname === "/api/indexing/reindex") {
    await requestFullReindex();
    sendJson(res, 200, await getIndexingStatus());
    return;
  }
  if (method === "POST" && pathname === "/api/digests/regenerate") {
    await requestDigestRegeneration();
    sendJson(res, 200, await getDigestStats());
    return;
  }

  throw new HttpError(404, "Not found");
}

async function handleSetup(req: IncomingMessage, res: ServerResponse, pathname: string, method: string): Promise<void> {
  if (method === "POST" && pathname === "/api/setup/verify") {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (method === "GET" && pathname === "/api/setup/environment") {
    sendJson(res, 200, await inspectEnvironment());
    return;
  }
  if (method === "POST" && pathname === "/api/setup/test-database") {
    const body = await readJsonBody<{ url?: string }>(req);
    sendJson(res, 200, await testDatabaseUrl(body.url || ""));
    return;
  }
  if (method === "POST" && pathname === "/api/setup/test-ollama") {
    const body = await readJsonBody<{ url?: string }>(req);
    sendJson(res, 200, await testOllamaUrl(body.url || ""));
    return;
  }
  if (method === "POST" && pathname === "/api/setup/install") {
    const plan = await readJsonBody<SetupPlan>(req);
    try {
      sendJson(res, 202, { job: await startInstall(plan) });
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (method === "GET" && pathname === "/api/setup/job") {
    sendJson(res, 200, { job: getJob(), setupRequired: setupRequired() });
    return;
  }
  throw new HttpError(404, "Not found");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const pathname = url.pathname;
  try {
    if (pathname.startsWith("/api/")) {
      await handleApi(req, res, pathname, url);
      return;
    }
    if ((req.method === "GET" || req.method === "HEAD") && (await serveStatic(pathname, res))) return;
    sendJson(res, 404, { error: "어드민 화면이 빌드되지 않았습니다. 개발 중에는 `npm run dev:admin` 으로 실행하세요." });
  } catch (error) {
    if (error instanceof HttpError) {
      sendJson(res, error.status, { error: error.message });
      return;
    }
    if (error instanceof UserAdminError) {
      sendJson(res, error.status, { error: error.message });
      return;
    }
    console.error("[admin] 요청 처리 오류:", error);
    sendJson(res, 500, { error: error instanceof Error ? error.message : "서버 오류" });
  }
});

async function bootstrap() {
  if (setupRequired()) {
    // 설치 전에는 DB 가 없을 수 있으므로 DB 작업 없이 설치 마법사만 연다.
    initSetupMode();
  } else {
    await ensureUserColumns();
  }
  server.listen(PORT, HOST, () => {
    console.log(`[Admin] http://${HOST}:${PORT} ${setupRequired() ? "(설치 모드)" : "(공유 DB: @noty/core)"}`);
  });
}

bootstrap().catch((error) => {
  console.error("[Admin] 시작 실패:", error);
  process.exit(1);
});
