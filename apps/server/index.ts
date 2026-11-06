import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import {
  authenticateUserInDb,
  createPageInDb,
  deletePageInDb,
  deletePagesBatchInDb,
  ensureSchema,
  encryptStoredSecrets,
  PageStructureError,
  getEffectiveUploadsDir,
  getSystemSettingsFromDb,
  getUserBySessionToken,
  listPagesFromDb,
  listTrashFromDb,
  loadDocumentFromDb,
  purgeExpiredTrash,
  restorePageFromTrash,
  reorderChildPagesInDb,
  canEditContent,
  revokeSessionToken,
  saveDocumentToDb,
  saveWorkspaceLayoutToDb,
  updatePageInDb,
  type WorkspaceLayoutState,
} from "./db.js";
import { ensureCollectionInDb, getCollectionFromDb, listCollectionsFromDb } from "./collection-db.js";
import { AbortedError, buildRetrievalQuery, chatWithAI, streamChatWithAI, type AIChatRequest } from "./ai-chat.js";
import {
  registerAttachment,
  semanticSearch,
  startEmbeddingIndexer,
} from "./embeddings.js";
import { hybridSearch, retrieveSources } from "./search.js";
import { LoginThrottle, parseAllowedOrigins, resolveAllowedOrigin } from "@noty/core/http-security";
import { DEFAULT_UPLOADS_DIR } from "@noty/core/paths";
import { attachCollaborationProxy, serveWebApp } from "./web-gateway.js";
import { getCanvasSnapshot, getPagePreviews, getWorkspaceGraph } from "./graph.js";
import { createSignedUploadUrl, parseUploadFileName, UPLOADS_PREFIX, verifyUploadSignature } from "./file-access.js";
import {
  getDigestSummaries,
  getPageDigest,
  startDigestWorker,
} from "./digests.js";
import { findConcepts, getConceptArticlesForQuery, getConceptDetail, getPageConcepts, getWikiOverview } from "./wiki-concepts.js";

const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || "127.0.0.1";
const UPLOADS_DIR = DEFAULT_UPLOADS_DIR;
const MAX_BODY_BYTES = 30 * 1024 * 1024;

/** 읽기 전용 계정도 할 수 있는 쓰기 요청 */
const VIEWER_ALLOWED_WRITES: ReadonlyArray<readonly [string, string]> = [
  ["POST", "/api/auth/logout"],
  ["POST", "/api/ai/chat"],
  ["POST", "/api/ai/chat/stream"],
  // 내 탭·분할 레이아웃 (계정별 화면 상태)
  ["PUT", "/api/workspace-layout"],
  // 본문에 이미 있는 컬렉션 블록의 기록을 처음 열 때 만드는 요청 (내용 변경 없음)
  ["POST", "/api/collections"],
];

const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.CORS_ALLOWED_ORIGINS);
const loginThrottle = new LoginThrottle();

function setCorsHeaders(req: IncomingMessage, res: ServerResponse) {
  const origin = resolveAllowedOrigin(req.headers.origin, ALLOWED_ORIGINS);
  if (ALLOWED_ORIGINS.length > 0) res.setHeader("Vary", "Origin");
  if (!origin) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

/**
 * 접속한 쪽의 주소 (로그인 시도 제한용).
 * X-Forwarded-For 는 누구나 꾸며 보낼 수 있으므로 TRUST_PROXY=1(리버스 프록시 뒤)일 때만 믿는다.
 */
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
function clientIp(req: IncomingMessage): string {
  if (TRUST_PROXY) {
    const forwarded = req.headers["x-forwarded-for"];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress || "unknown";
}

function extractBearerToken(req: IncomingMessage): string | null {
  const raw = req.headers.authorization;
  if (!raw || typeof raw !== "string") return null;
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function readJsonBody<T = Record<string, unknown>>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new RangeError("Payload too large");
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as T) : ({} as T);
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const server = http.createServer(async (req, res) => {
  try {
    setCorsHeaders(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || `${HOST}:${PORT}`}`);
    const { pathname } = url;

    // 운영: 빌드된 웹 화면 (NOTY_WEB_DIST). /api, /uploads, /collab 은 아래에서 처리한다.
    if (await serveWebApp(req, res, pathname)) return;

    // 1. Health check (GET 및 wait-on의 HEAD 요청 모두 허용)
    if ((req.method === "GET" || req.method === "HEAD") && pathname === "/api/health") {
      sendJson(res, 200, {
        status: "ok",
        serverName: "Noty Workspace Server",
        version: "1.0.0",
      });
      return;
    }

    // 1.5. Auth: POST /api/auth/login (사전 발급된 계정으로만 로그인 허용)
    if (req.method === "POST" && pathname === "/api/auth/login") {
      const body = await readJsonBody<{ username?: string; password?: string }>(req);
      const username = body.username?.trim() || "";
      const password = body.password || "";
      if (!username || !password) {
        sendJson(res, 400, { error: "아이디와 비밀번호를 모두 입력해 주세요." });
        return;
      }
      const ip = clientIp(req);
      const retryAfter = loginThrottle.retryAfterSeconds(username, ip);
      if (retryAfter > 0) {
        res.setHeader("Retry-After", String(retryAfter));
        sendJson(res, 429, { error: `로그인 시도가 너무 많습니다. ${Math.ceil(retryAfter / 60)}분 뒤에 다시 시도해 주세요.` });
        return;
      }
      const auth = await authenticateUserInDb(username, password);
      if (!auth) {
        loginThrottle.recordFailure(username, ip);
        sendJson(res, 401, {
          error: "아이디 또는 비밀번호가 일치하지 않습니다.",
        });
        return;
      }
      loginThrottle.recordSuccess(username, ip);
      sendJson(res, 200, auth);
      return;
    }

    // 1.6. Auth: POST /api/auth/logout
    if (req.method === "POST" && pathname === "/api/auth/logout") {
      const token = extractBearerToken(req);
      if (token) {
        await revokeSessionToken(token);
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    // 1.7. Auth: GET /api/auth/me
    if (req.method === "GET" && pathname === "/api/auth/me") {
      const token = extractBearerToken(req);
      const user = token ? await getUserBySessionToken(token) : null;
      if (!user) {
        sendJson(res, 401, { error: "로그인이 필요하거나 세션이 만료되었습니다." });
        return;
      }
      sendJson(res, 200, { user });
      return;
    }

    // 6. 첨부 파일: GET /uploads/:fileName
    //    서명 주소(?exp=&sig=, /api/files/sign 으로 발급) 또는 로그인 토큰이 있어야 열린다.
    if ((req.method === "GET" || req.method === "HEAD") && pathname.startsWith(UPLOADS_PREFIX)) {
      const fileName = parseUploadFileName(pathname);
      if (!fileName) {
        sendJson(res, 400, { error: "Invalid file name" });
        return;
      }
      const signed = await verifyUploadSignature(fileName, url.searchParams.get("exp"), url.searchParams.get("sig"));
      if (!signed) {
        const token = extractBearerToken(req);
        const viewer = token ? await getUserBySessionToken(token) : null;
        if (!viewer) {
          sendJson(res, 401, { error: "파일을 보려면 로그인이 필요합니다." });
          return;
        }
      }
      const ext = path.extname(fileName).toLowerCase();
      const contentType = MIME_BY_EXT[ext] || "application/octet-stream";
      const candidates = [path.join(await getEffectiveUploadsDir(), fileName), path.join(UPLOADS_DIR, fileName)];
      for (const filePath of candidates) {
        const fileBuffer = await readFile(filePath).catch(() => null);
        if (!fileBuffer) continue;
        res.writeHead(200, {
          "Content-Type": contentType,
          "Content-Length": fileBuffer.length,
          // 서명 주소는 만료 전까지 같은 주소라 브라우저 캐시를 쓰되, 공용 캐시에는 남기지 않는다.
          "Cache-Control": "private, max-age=3600",
          "X-Content-Type-Options": "nosniff",
          // SVG 등을 직접 열어도 스크립트가 이 사이트 권한으로 돌지 않게 한다.
          // (PDF 는 sandbox 를 걸면 브라우저 내장 뷰어가 열리지 않아 제외)
          ...(ext === ".pdf" ? {} : { "Content-Security-Policy": "sandbox" }),
        });
        res.end(req.method === "HEAD" ? undefined : fileBuffer);
        return;
      }
      sendJson(res, 404, { error: "File not found" });
      return;
    }

    // 이후 모든 /api/* 엔드포인트는 인증된 세션 토큰 필수
    const bearerToken = extractBearerToken(req);
    const authUser = bearerToken ? await getUserBySessionToken(bearerToken) : null;
    if (!authUser) {
      sendJson(res, 401, { error: "인증이 필요합니다. 먼저 서버에 로그인해 주세요." });
      return;
    }

    // 읽기 전용(viewer) 계정: 보기와 AI 질문, 내 화면 상태 저장만 허용하고 나머지 쓰기 요청은 막는다.
    // (허용 목록 방식이라 새로 추가되는 쓰기 API 도 기본으로 막힌다.)
    if (req.method !== "GET" && req.method !== "HEAD" && !canEditContent(authUser.role)) {
      const allowed = VIEWER_ALLOWED_WRITES.some(([method, path]) => req.method === method && pathname === path);
      if (!allowed) {
        sendJson(res, 403, { error: "읽기 전용 계정은 페이지를 만들거나 수정할 수 없습니다." });
        return;
      }
    }

    if (pathname === "/api/collections") {
      if (req.method === "GET") {
        sendJson(res, 200, { collections: await listCollectionsFromDb(authUser.id) });
        return;
      }
      if (req.method === "POST") {
        const body = await readJsonBody<{ id?: string; ownerPageId?: string; initialData?: unknown }>(req);
        if (!body.id || !body.ownerPageId) {
          sendJson(res, 400, { error: "id and ownerPageId are required" });
          return;
        }
        const data = await ensureCollectionInDb(body.id, body.ownerPageId, body.initialData, authUser.id);
        sendJson(res, 200, { data });
        return;
      }
    }
    const collectionMatch = pathname.match(/^\/api\/collections\/(collection-[a-zA-Z0-9_-]+)$/);
    if (collectionMatch && req.method === "GET") {
      const data = await getCollectionFromDb(collectionMatch[1], authUser.id);
      sendJson(res, data ? 200 : 404, data ? { data } : { error: "Collection not found" });
      return;
    }

    // 2.1. 그래프 뷰: 페이지(점)와 링크(선)
    if (req.method === "GET" && pathname === "/api/graph") {
      sendJson(res, 200, await getWorkspaceGraph());
      return;
    }

    // 2.2. 캔버스 카드에 보여 줄 페이지 미리보기: GET /api/pages/previews?ids=a,b
    if (req.method === "GET" && pathname === "/api/pages/previews") {
      const ids = (url.searchParams.get("ids") || "").split(",").map((id) => id.trim()).filter(Boolean);
      sendJson(res, 200, { previews: await getPagePreviews(ids) });
      return;
    }

    // 2.3. 캔버스 내용(카드·선) 읽기 — 페이지 안 미리보기 블록용: GET /api/pages/:id/canvas
    const canvasMatch = pathname.match(/^\/api\/pages\/([^/]+)\/canvas$/);
    if (canvasMatch && req.method === "GET") {
      const snapshot = await getCanvasSnapshot(decodeURIComponent(canvasMatch[1]));
      sendJson(res, snapshot ? 200 : 404, snapshot ? { canvas: snapshot } : { error: "캔버스를 찾을 수 없습니다." });
      return;
    }

    // 2. Pages list & create (로그인한 계정별 개인 페이지 공간 분리)
    if (pathname === "/api/pages") {
      if (req.method === "GET") {
        const result = await listPagesFromDb(authUser.id);
        sendJson(res, 200, result);
        return;
      }
      if (req.method === "POST") {
        const body = await readJsonBody<{
          parentId?: string | null;
          title?: string;
          insertIntoParentBlocks?: boolean;
          kind?: "page" | "canvas";
        }>(req);
        const result = await createPageInDb(body, authUser.id);
        sendJson(res, 201, result);
        return;
      }
    }

    if (pathname === "/api/trash" && req.method === "GET") {
      sendJson(res, 200, { pages: await listTrashFromDb() });
      return;
    }
    const restoreMatch = pathname.match(/^\/api\/trash\/([^/]+)\/restore$/);
    if (restoreMatch && req.method === "POST") {
      const result = await restorePageFromTrash(decodeURIComponent(restoreMatch[1]), authUser.id);
      sendJson(res, 200, result);
      return;
    }

    // 2.5. Workspace layout state (tabs & split panes): PUT /api/workspace-layout
    if (pathname === "/api/workspace-layout" && req.method === "PUT") {
      const body = await readJsonBody<WorkspaceLayoutState>(req);
      if (body && Array.isArray(body.tabs)) {
        await saveWorkspaceLayoutToDb(body, authUser.id);
        sendJson(res, 200, { ok: true });
        return;
      }
      sendJson(res, 400, { error: "Invalid layout state" });
      return;
    }

    // 3. Page document load & save: /api/pages/:id/document
    const docMatch = pathname.match(/^\/api\/pages\/([^/]+)\/document$/);
    if (docMatch) {
      const pageId = decodeURIComponent(docMatch[1]);
      if (req.method === "GET") {
        const result = await loadDocumentFromDb(pageId, authUser.id);
        sendJson(res, 200, result);
        return;
      }
      if (req.method === "PUT") {
        const body = await readJsonBody<{ blocks?: unknown[]; title?: string }>(req);
        if (!Array.isArray(body.blocks)) {
          sendJson(res, 400, { error: "blocks array is required" });
          return;
        }
        const result = await saveDocumentToDb(pageId, body.blocks, body.title, authUser.id);
        sendJson(res, 200, result);
        return;
      }
    }

    // 3.3. LLM 위키 페이지 정리본: GET /api/pages/:id/digest
    const digestMatch = pathname.match(/^\/api\/pages\/([a-zA-Z0-9_-]+)\/digest$/);
    if (digestMatch && req.method === "GET") {
      const [digest, concepts] = await Promise.all([getPageDigest(digestMatch[1]), getPageConcepts(digestMatch[1])]);
      sendJson(res, 200, { ...digest, concepts });
      return;
    }

    // 3.30. LLM 위키 개요 (AI 패널 위키 탭): GET /api/wiki/overview
    if (req.method === "GET" && pathname === "/api/wiki/overview") {
      sendJson(res, 200, await getWikiOverview());
      return;
    }

    // 3.31. LLM 위키 개념: GET /api/wiki/concepts?q=&limit=, GET /api/wiki/concepts/:id
    if (req.method === "GET" && pathname === "/api/wiki/concepts") {
      const limit = Number(url.searchParams.get("limit") || 20);
      sendJson(res, 200, { concepts: await findConcepts(url.searchParams.get("q") || "", Number.isFinite(limit) ? limit : 20) });
      return;
    }
    const conceptMatch = pathname.match(/^\/api\/wiki\/concepts\/(concept-[a-f0-9]{16})$/);
    if (conceptMatch && req.method === "GET") {
      const detail = await getConceptDetail(conceptMatch[1]);
      if (!detail) {
        sendJson(res, 404, { error: "개념을 찾을 수 없습니다." });
        return;
      }
      sendJson(res, 200, detail);
      return;
    }

    // 3.4. Child page order (에디터 본문 page 블록 순서 → 사이드바 순서): PUT /api/pages/:id/children-order
    const childrenOrderMatch = pathname.match(/^\/api\/pages\/([^/]+)\/children-order$/);
    if (childrenOrderMatch && req.method === "PUT") {
      const parentId = decodeURIComponent(childrenOrderMatch[1]);
      const body = await readJsonBody<{ orderedIds?: unknown }>(req);
      if (!Array.isArray(body.orderedIds)) {
        sendJson(res, 400, { error: "orderedIds array is required" });
        return;
      }
      const orderedIds = body.orderedIds.filter((id): id is string => typeof id === "string");
      const result = await reorderChildPagesInDb(parentId, orderedIds, authUser.id);
      sendJson(res, 200, result);
      return;
    }

    // 3.5. Batch delete pages: POST /api/pages/batch-delete
    if (pathname === "/api/pages/batch-delete" && req.method === "POST") {
      const body = await readJsonBody<{ ids?: string[] }>(req);
      if (!Array.isArray(body.ids)) {
        sendJson(res, 400, { error: "ids array is required" });
        return;
      }
      const result = await deletePagesBatchInDb(body.ids, authUser.id);
      sendJson(res, 200, result);
      return;
    }

    // 4. Page metadata update & delete: /api/pages/:id
    const pageMatch = pathname.match(/^\/api\/pages\/([^/]+)$/);
    if (pageMatch) {
      const pageId = decodeURIComponent(pageMatch[1]);
      if (req.method === "PATCH") {
        const body = await readJsonBody<{
          title?: string;
          icon?: string | null;
          pageWidth?: string | null;
          parentId?: string | null;
          targetId?: string;
          placement?: "before" | "inside" | "after";
        }>(req);
        const result = await updatePageInDb({ id: pageId, ...body }, authUser.id);
        sendJson(res, 200, result);
        return;
      }
      if (req.method === "DELETE") {
        const result = await deletePageInDb(pageId, authUser.id);
        sendJson(res, 200, result);
        return;
      }
    }

    // 5.1. 첨부 파일 서명 주소 발급: GET /api/files/sign?url=/uploads/<파일>
    if (req.method === "GET" && pathname === "/api/files/sign") {
      const fileName = parseUploadFileName(url.searchParams.get("url") || "");
      if (!fileName) {
        sendJson(res, 400, { error: "/uploads/ 파일 주소가 아닙니다." });
        return;
      }
      sendJson(res, 200, await createSignedUploadUrl(fileName));
      return;
    }

    // 5. Attachment upload: POST /api/attachments
    if (req.method === "POST" && pathname === "/api/attachments") {
      const body = await readJsonBody<{
        name?: string;
        type?: string;
        base64?: string;
      }>(req);

      if (!body.name || !body.base64) {
        sendJson(res, 400, { error: "name and base64 are required" });
        return;
      }

      const bytes = Buffer.from(body.base64, "base64");
      const ext = path
        .extname(body.name)
        .toLowerCase()
        .replace(/[^a-z0-9.]/g, "")
        .slice(0, 12);
      const fileName = `${randomUUID()}${ext}`;
      const uploadsDir = await getEffectiveUploadsDir();
      await mkdir(uploadsDir, { recursive: true });
      await writeFile(path.join(uploadsDir, fileName), bytes);
      // 첨부파일 기록 → 인덱서가 텍스트를 추출해 검색/AI 참고에 쓴다.
      await registerAttachment({
        id: fileName,
        userId: authUser.id,
        originalName: body.name,
        mimeType: body.type || "",
        sizeBytes: bytes.length,
      }).catch((error) => console.error("[attachments] 기록 실패:", error));

      sendJson(res, 201, {
        name: body.name,
        type: body.type || "",
        size: bytes.length,
        url: `/uploads/${fileName}`,
      });
      return;
    }

    // 6.3. 통합 검색 (키워드 + 의미): GET /api/search?q=...&limit=20 (본인 문서만)
    if (req.method === "GET" && pathname === "/api/search") {
      const query = url.searchParams.get("q") || "";
      const limit = Number(url.searchParams.get("limit") || 20);
      try {
        sendJson(res, 200, await hybridSearch(authUser.id, query, Number.isFinite(limit) ? limit : 20));
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : "검색에 실패했습니다." });
      }
      return;
    }

    // 6.4. 시맨틱(벡터) 검색: GET /api/search/semantic?q=...&limit=10 (본인 문서만)
    if (req.method === "GET" && pathname === "/api/search/semantic") {
      const query = url.searchParams.get("q") || "";
      const limit = Number(url.searchParams.get("limit") || 10);
      try {
        const results = await semanticSearch(authUser.id, query, Number.isFinite(limit) ? limit : 10);
        sendJson(res, 200, { results });
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : "검색에 실패했습니다." });
      }
      return;
    }

    // 6.5. AI 어시스턴트: GET /api/ai/status, POST /api/ai/chat (로그인한 모든 사용자)
    if (req.method === "GET" && pathname === "/api/ai/status") {
      const config = await getSystemSettingsFromDb(false);
      const provider = config.ai.provider;
      sendJson(res, 200, {
        provider,
        model: config.ai.model,
        configured: Boolean(config.ai.model) && (provider === "ollama" || provider === "custom" || Boolean(config.ai.apiKey)),
      });
      return;
    }

    // 스트리밍 응답: NDJSON (한 줄에 하나의 이벤트)
    //   {"type":"sources","sources":[...]}  워크스페이스 참고 시 출처 목록 (맨 앞)
    //   {"type":"delta","text":"..."}  응답 텍스트 조각
    //   {"type":"done","provider","model","truncated"}  정상 종료
    //   {"type":"error","message":"..."}  오류 종료
    if (req.method === "POST" && pathname === "/api/ai/chat/stream") {
      const body = await readJsonBody<AIChatRequest>(req);
      const config = await getSystemSettingsFromDb(false);
      const abort = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) abort.abort();
      });
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders?.();
      const writeEvent = (event: Record<string, unknown>) => {
        if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(event)}\n`);
      };
      try {
        // 워크스페이스 참고: 관련 조각을 찾아 출처 목록을 먼저 보내고 프롬프트에 넣는다.
        let sources: Awaited<ReturnType<typeof retrieveSources>>["sources"] = [];
        let conceptArticles: Awaited<ReturnType<typeof getConceptArticlesForQuery>> = [];
        if (body.useWorkspace) {
          const retrievalQuery = buildRetrievalQuery(body.messages);
          // 질문과 맞는 개념의 종합 글(LLM 위키)을 먼저 찾고, 근거 조각을 함께 넣는다.
          conceptArticles = await getConceptArticlesForQuery(retrievalQuery).catch(() => []);
          const retrieved = await retrieveSources(authUser.id, retrievalQuery);
          sources = retrieved.sources;
          writeEvent({
            type: "sources",
            sources: sources.map(({ content: _content, ...meta }) => meta),
            ...(retrieved.semanticError ? { warning: `의미 검색 실패: ${retrieved.semanticError}` } : {}),
          });
        }
        // 출처 페이지의 LLM 정리본 요약을 함께 넣어 페이지 전체 맥락을 준다.
        const sourcePages = Array.from(new Map(sources.map((source) => [source.pageId, source.pageTitle])).entries());
        const summaries = await getDigestSummaries(sourcePages.map(([pageId]) => pageId));
        const pageSummaries = sourcePages
          .filter(([pageId]) => summaries.has(pageId))
          .map(([pageId, pageTitle]) => ({ pageTitle, summary: summaries.get(pageId)! }));
        const result = await streamChatWithAI(
          config.ai,
          body,
          (text) => writeEvent({ type: "delta", text }),
          abort.signal,
          sources,
          pageSummaries,
          conceptArticles,
        );
        writeEvent({ type: "done", ...result });
      } catch (error) {
        if (!(error instanceof AbortedError)) {
          writeEvent({ type: "error", message: error instanceof Error ? error.message : "AI 요청에 실패했습니다." });
        }
      }
      if (!res.writableEnded) res.end();
      return;
    }

    if (req.method === "POST" && pathname === "/api/ai/chat") {
      const body = await readJsonBody<AIChatRequest>(req);
      const config = await getSystemSettingsFromDb(false);
      try {
        const result = await chatWithAI(config.ai, body);
        sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, 502, { error: error instanceof Error ? error.message : "AI 요청에 실패했습니다." });
      }
      return;
    }

    // 관리 기능(계정·모델·시스템 설정)은 별도 포트의 어드민 서버(apps/admin)로 옮겼다.

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    if (error instanceof PageStructureError) {
      sendJson(res, 400, { error: error.message });
      return;
    }
    console.error("[server error]", error);
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
});

async function bootstrap() {
  let retries = 15;
  while (retries > 0) {
    try {
      await ensureSchema();
      // 예전에 평문으로 저장된 API 키 등을 암호화해 둔다.
      const sealed = await encryptStoredSecrets();
      if (sealed) console.log(`[settings] 평문으로 저장돼 있던 비밀값 ${sealed}건을 암호화했습니다.`);
      break;
    } catch (error) {
      retries -= 1;
      if (retries === 0) {
        console.error(
          "PostgreSQL(pgvector) 연결 실패. `npm run db:up`으로 Docker 컨테이너가 실행 중인지 확인해 주세요.",
          error,
        );
        process.exit(1);
      }
      console.log(`PostgreSQL 연결 대기 중... (남은 재시도: ${retries})`);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  attachCollaborationProxy(server);
  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(
        `\n[API Server] ${HOST}:${PORT} 포트를 이미 다른 프로그램이 쓰고 있어 시작하지 못했습니다.\n` +
          "  - 설치 마법사로 설치한 Noty(Docker)가 같은 포트를 쓰고 있다면: docker stop noty-api noty-collab noty-admin noty-db\n" +
          "  - 다른 개발 서버(npm run dev / dev:web:lan)가 이미 켜져 있다면 그쪽을 끄세요.\n" +
          `  - 확인: lsof -nP -iTCP:${PORT} -sTCP:LISTEN\n`,
      );
      process.exit(1);
    }
    throw error;
  });
  server.listen(PORT, HOST, () => {
    console.log(`[API Server] Listening on http://${HOST}:${PORT}`);
  });
  const trashCleanupTimer = setInterval(() => {
    void purgeExpiredTrash().catch((error) => console.error("[trash cleanup]", error));
  }, 24 * 60 * 60 * 1000);
  trashCleanupTimer.unref();
  startEmbeddingIndexer();
  startDigestWorker();
}

void bootstrap();
