import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { access, constants, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";
import { reconcileChildPageBlocks, removePageBlocksFromTree } from "./page-block-structure.js";
import { PAGE_STRUCTURE_CHANGED_CHANNEL } from "./collaboration-page-structure.js";


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME_PAGE_ID = "__home__";

import { DATABASE_URL, pool } from "@noty/core/db";
import { getSystemSettingsFromDb } from "@noty/core/settings";
import {
  createSession,
  hashPassword,
  normalizeRole,
  verifyCredentials,
  type AuthUser,
  type UserRole,
} from "@noty/core/users";

// 공유 모듈(@noty/core)로 옮긴 것들을 기존 import 경로("./db.js")로도 쓸 수 있게 다시 내보낸다.
export { DATABASE_URL, pool };
export * from "@noty/core/settings";
export {
  getUserBySessionToken,
  revokeSessionToken,
  canEditContent,
  type AuthUser,
  type UserRole,
} from "@noty/core/users";

/** page: 일반 문서, canvas: 캔버스 (본문 대신 카드·연결선을 Yjs 로 저장) */
export type PageKind = "page" | "canvas";

export interface PageRow {
  id: string;
  kind: PageKind;
  title: string;
  icon: string | null;
  pageWidth: string;
  parentId: string | null;
  order: number;
  createdAt: string;
  updatedAt: string;
}

/** 페이지 구조상 허용되지 않는 요청 (API 는 400 으로 응답) */
export class PageStructureError extends Error {}

/**
 * 캔버스는 페이지를 소유하지 않는다. 캔버스 아래에 페이지를 두면 하위 페이지 블록을 본문에 넣는
 * 기존 동작이 캔버스 문서를 건드리게 되므로 막는다. (캔버스 자체는 어느 페이지 아래에든 둘 수 있다)
 */
export const CANVAS_PARENT_ERROR = "캔버스 아래에는 페이지를 둘 수 없습니다. 캔버스에는 페이지를 카드로 올려 주세요.";

export function normalizePageWidth(raw: unknown): string {
  if (typeof raw !== "string") return "default";
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "full" || trimmed === "wide" || trimmed === "default") {
    return trimmed;
  }
  if (/^\d+$/.test(trimmed)) {
    const px = Math.min(1800, Math.max(560, Number(trimmed)));
    return String(px);
  }
  return "default";
}

export interface TrashedPageRow {
  id: string;
  title: string;
  icon: string | null;
  parentId: string | null;
  deletedAt: string;
  expiresAt: string;
  pageCount: number;
}

export interface PageLinkSummary {
  id: string;
  title: string;
}

export interface WorkspaceTabItem {
  id: string;
  pageId: string;
}

export interface WorkspaceLayoutState {
  tabs: WorkspaceTabItem[];
  activeTabId: string;
  splitTabIds: string[];
  splitRatios: number[];
}

export function extractInlineText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      const record = item as Record<string, unknown>;
      if (typeof record.text === "string") return record.text;
      if (Array.isArray(record.content)) return extractInlineText(record.content);
      return "";
    })
    .join("");
}

export function extractDocumentPlainText(blocks: readonly unknown[]): string {
  const parts: string[] = [];
  const visit = (items: readonly unknown[]) => {
    for (const value of items) {
      if (!value || typeof value !== "object") continue;
      const block = value as Record<string, unknown>;
      const inline = extractInlineText(block.content).trim();
      if (inline) parts.push(inline);
      if (Array.isArray(block.children)) {
        visit(block.children);
      }
    }
  };
  visit(blocks);
  return parts.join("\n");
}

/**
 * 본문 블록 트리에서 블록형 하위 페이지(`type: "page"`)의 pageId 목록만 추출합니다.
 */
export function extractPageBlockIds(blocks: readonly unknown[]): string[] {
  const ids = new Set<string>();
  const visit = (items: readonly unknown[]) => {
    for (const value of items) {
      if (!value || typeof value !== "object") continue;
      const block = value as Record<string, unknown>;
      if (block.type === "page" && block.props && typeof block.props === "object") {
        const pageId = (block.props as Record<string, unknown>).pageId;
        if (typeof pageId === "string" && pageId.trim()) {
          ids.add(pageId.trim());
        }
      }
      if (Array.isArray(block.children)) {
        visit(block.children);
      }
    }
  };
  visit(blocks);
  return Array.from(ids);
}

/**
 * 본문 블록 트리에서 모든 참조(`type: "page"` 블록 + 인라인 `type: "pageLink"`)의 pageId를 추출합니다.
 */
export function extractLinkedPageIds(blocks: readonly unknown[]): string[] {
  const linkedIds = new Set<string>(extractPageBlockIds(blocks));

  const inspectInline = (content: unknown) => {
    if (!Array.isArray(content)) return;
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const inline = item as Record<string, unknown>;
      if (inline.type === "pageLink" && inline.props && typeof inline.props === "object") {
        const pageId = (inline.props as Record<string, unknown>).pageId;
        if (typeof pageId === "string" && pageId.trim()) {
          linkedIds.add(pageId.trim());
        }
      }
      if (Array.isArray(inline.content)) {
        inspectInline(inline.content);
      }
    }
  };

  const inspectBlocks = (items: readonly unknown[]) => {
    for (const value of items) {
      if (!value || typeof value !== "object") continue;
      const block = value as Record<string, unknown>;
      inspectInline(block.content);
      if (Array.isArray(block.children)) {
        inspectBlocks(block.children);
      }
    }
  };

  inspectBlocks(blocks);
  return Array.from(linkedIds);
}

function appendPageBlockIfMissing(blocks: unknown[], childPageId: string): unknown[] {
  const existing = extractPageBlockIds(blocks);
  if (existing.includes(childPageId)) return blocks;

  return [
    ...blocks,
    {
      id: randomUUID(),
      type: "page",
      props: { pageId: childPageId },
      content: [],
      children: [],
    },
  ];
}

async function ensureParentPageLinks(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const res = await client.query(
      "SELECT id, parent_id FROM pages WHERE deleted_at IS NULL AND parent_id IS NOT NULL ORDER BY parent_id, id",
    );

    for (const row of res.rows) {
      const childPageId = String(row.id);
      const parentId = String(row.parent_id);
      await appendPageBlockToParentInTx(client, parentId, childPageId);
      await client.query(
        `INSERT INTO page_links (source_id, target_id)
         VALUES ($1, $2)
         ON CONFLICT (source_id, target_id) DO NOTHING`,
        [parentId, childPageId],
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * 서버가 클라이언트 편집과 무관하게 본문(blocks)을 직접 수정할 때 사용한다.
 * blocks_server_modified_at 을 갱신해 두면, 다음에 협업(Yjs) 문서를 처음 불러올 때
 * 오래된 Yjs 상태 대신 서버가 수정한 본문으로 다시 시드된다.
 */
async function writeServerModifiedBlocksInTx(
  client: PoolClient,
  pageId: string,
  blocks: readonly unknown[],
  invalidateCollaboration = true,
): Promise<void> {
  await client.query(
    `UPDATE pages
     SET blocks = $1::jsonb,
         plain_text = $2,
         updated_at = NOW(),
         blocks_server_modified_at = CASE WHEN $4::boolean THEN NOW() ELSE blocks_server_modified_at END
     WHERE id = $3`,
    [JSON.stringify(blocks), extractDocumentPlainText(blocks), pageId, invalidateCollaboration],
  );
}

async function listChildPageIdsInTx(client: PoolClient, parentId: string): Promise<string[]> {
  const res = await client.query(
    "SELECT id FROM pages WHERE parent_id = $1 AND deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC",
    [parentId],
  );
  return res.rows.map((row) => String(row.id));
}

/**
 * 부모 본문의 page 블록 구조를 사이드바 계층과 일치시킨다.
 * (자식이 아닌 page 블록 제거, 누락된 자식 추가, reorder 시 sort_order 순으로 재배치)
 */
async function reconcileParentPageBlocksInTx(
  client: PoolClient,
  parentId: string,
  options: { reorder: boolean },
): Promise<void> {
    const res = await client.query("SELECT blocks FROM pages WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [parentId]);
  if (!res.rowCount || res.rowCount === 0) return;
  const currentBlocks = Array.isArray(res.rows[0].blocks) ? (res.rows[0].blocks as unknown[]) : [];
  const childIds = await listChildPageIdsInTx(client, parentId);
  const { blocks: nextBlocks, changed } = reconcileChildPageBlocks(currentBlocks, childIds, options);
  if (changed) {
    await writeServerModifiedBlocksInTx(client, parentId, nextBlocks);
  }
  // 열려 있는 협업(Yjs) 문서에도 구조 변경(하위 페이지 추가/제거)을 반영하도록 알린다.
  // 트랜잭션 안의 pg_notify 는 COMMIT 때만 전달되므로 롤백되면 알리지 않는다.
  await notifyPageStructureChangedInTx(client, parentId);
}

async function notifyPageStructureChangedInTx(client: PoolClient, pageId: string): Promise<void> {
  await client.query("SELECT pg_notify($1, $2)", [PAGE_STRUCTURE_CHANGED_CHANNEL, pageId]);
}

async function appendPageBlockToParentInTx(
  client: PoolClient,
  parentId: string,
  childPageId: string,
  invalidateCollaboration = true,
): Promise<void> {
  const res = await client.query("SELECT blocks FROM pages WHERE id = $1 FOR UPDATE", [parentId]);
  if (!res.rowCount || res.rowCount === 0) return;
  const currentBlocks = Array.isArray(res.rows[0].blocks) ? (res.rows[0].blocks as unknown[]) : [];
  const nextBlocks = appendPageBlockIfMissing(currentBlocks, childPageId);
  await notifyPageStructureChangedInTx(client, parentId);
  if (nextBlocks !== currentBlocks) {
    if (invalidateCollaboration) {
      await writeServerModifiedBlocksInTx(client, parentId, nextBlocks);
    } else {
      const plainText = extractDocumentPlainText(nextBlocks);
      await client.query(
        `UPDATE pages
         SET blocks = $1::jsonb,
             plain_text = $2,
             updated_at = NOW()
         WHERE id = $3`,
        [JSON.stringify(nextBlocks), plainText, parentId],
      );
    }
  }
}

function mapPageRow(row: Record<string, unknown>): PageRow {
  return {
    id: String(row.id),
    kind: row.kind === "canvas" ? "canvas" : "page",
    title: String(row.title ?? "제목 없는 문서"),
    icon: row.icon ? String(row.icon) : null,
    pageWidth: normalizePageWidth(row.page_width),
    parentId: row.parent_id ? String(row.parent_id) : null,
    order: Number(row.sort_order ?? 0),
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at ?? new Date().toISOString()),
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : String(row.updated_at ?? new Date().toISOString()),
  };
}

export async function upsertPreissuedUser(
  username: string,
  password: string,
  displayName?: string,
  role: UserRole = "editor",
): Promise<AuthUser> {
  const cleanUsername = username.trim().toLowerCase();
  if (!cleanUsername || !password) {
    throw new Error("username and password are required");
  }
  const id = `user-${cleanUsername}`;
  const cleanDisplayName = displayName?.trim() || cleanUsername;
  const passwordHash = hashPassword(password);

  const res = await pool.query(
    `INSERT INTO users (id, username, password_hash, display_name, role)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (username) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           display_name = EXCLUDED.display_name,
           role = EXCLUDED.role
     RETURNING id, username, display_name, role`,
    [id, cleanUsername, passwordHash, cleanDisplayName, role],
  );
  const row = res.rows[0];
  const user: AuthUser = {
    id: String(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    role: normalizeRole(row.role),
  };
  await ensureUserWorkspace(user.id);
  return user;
}

export async function ensureUserWorkspace(userId: string): Promise<string> {
  // Yjs 동시 편집(협업)을 위해 워크스페이스 내 페이지 트리는 공유하며,
  // 각 계정별 탭/화면 분할 상태(user_workspace_state)는 userId별로 독립 저장합니다.
  await pool.query(
    "DELETE FROM pages WHERE id IN ('welcome-user-kalin', 'welcome-user-guest') AND EXISTS (SELECT 1 FROM pages WHERE id = 'welcome')",
  );

  const existing = await pool.query(
    "SELECT id FROM pages WHERE deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC LIMIT 1",
  );
  let firstPageId = existing.rows[0]?.id ? String(existing.rows[0].id) : "";

  // 문서가 없는 상태는 유효한 상태다. 이 경우 프론트엔드가 홈 화면을 보여준다.
  if (!firstPageId) return "";

  await pool.query(
    `INSERT INTO user_workspace_state (user_id, key, value)
     VALUES ($1, 'active_page_id', $2)
     ON CONFLICT (user_id, key) DO NOTHING`,
    [userId, firstPageId],
  );

  return firstPageId;
}

/** PGroonga(한국어 전문 검색) 사용 가능 여부. 없으면 키워드 검색은 ILIKE 로 동작한다. */
export let pgroongaAvailable = false;

/**
 * PGroonga 확장과 page_chunks 전문 검색 인덱스를 준비한다.
 * 확장이 없는 DB(공식 pgvector 이미지 등)에서도 서버는 그대로 동작해야 하므로 실패해도 넘어간다.
 * 토크나이저: 2글자 N-gram (형태소 분석 없이 한국어 부분 일치), NFKC 정규화(대소문자·전각 통일).
 */
async function ensureFullTextSearchIndex(): Promise<void> {
  try {
    await pool.query("CREATE EXTENSION IF NOT EXISTS pgroonga");
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_page_chunks_pgroonga ON page_chunks
         USING pgroonga (content)
         WITH (tokenizer = 'TokenNgram("unify_alphabet", false, "unify_digit", false)',
               normalizers = 'NormalizerNFKC150')`,
    );
    pgroongaAvailable = true;
  } catch (error) {
    pgroongaAvailable = false;
    console.warn(
      "[search] PGroonga 를 사용할 수 없어 기본 키워드 검색(ILIKE)으로 동작합니다:",
      error instanceof Error ? error.message : error,
    );
  }
}

export async function ensureSchema(): Promise<void> {
  const initSqlPath = path.join(__dirname, "sql", "init.sql");
  const sql = await readFile(initSqlPath, "utf8");
  await pool.query(sql);
  await ensureFullTextSearchIndex();

  // 만료된 휴지통 항목은 서버 시작 시 정리한다.
  await purgeExpiredTrash();

  // 서버 측 본문 수정 시각 컬럼 보장 (협업 Yjs 상태 무효화 판단용)
  await pool.query(
    "ALTER TABLE pages ADD COLUMN IF NOT EXISTS blocks_server_modified_at TIMESTAMPTZ",
  );
  await pool.query(
    "ALTER TABLE pages ADD COLUMN IF NOT EXISTS page_width VARCHAR(32) NOT NULL DEFAULT 'default'",
  );
  // 페이지 종류 (page / canvas)
  await pool.query("ALTER TABLE pages ADD COLUMN IF NOT EXISTS kind VARCHAR(16) NOT NULL DEFAULT 'page'");

  // 역할: admin(관리자) / editor(편집자) / viewer(읽기 전용).
  // 예전 'user' 역할은 편집자로 옮긴다. 역할은 어드민에서 관리하므로 서버 시작 때 덮어쓰지 않는다.
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'editor'");
  await pool.query("ALTER TABLE users ALTER COLUMN role SET DEFAULT 'editor'");
  await pool.query("UPDATE users SET role = 'editor' WHERE role NOT IN ('admin', 'editor', 'viewer')");
  // 비활성화된 계정은 로그인과 기존 세션이 모두 막힌다.
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ");

  // 첫 관리자 계정: 사용자가 한 명도 없을 때만 만든다.
  // 비밀번호는 NOTY_ADMIN_PASSWORD 로 정하고, 없으면 무작위로 만들어 서버 로그에 한 번만 보여 준다.
  // (그 뒤 계정은 어드민에서 관리한다)
  const userCount = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM users");
  // 어드민 설치 마법사로 설치한 경우 첫 관리자는 마법사가 만든다(NOTY_DISABLE_BOOTSTRAP_ADMIN=1).
  if (Number(userCount.rows[0]?.count || 0) === 0 && process.env.NOTY_DISABLE_BOOTSTRAP_ADMIN !== "1") {
    const username = (process.env.NOTY_ADMIN_USERNAME || "admin").trim().toLowerCase();
    const envPassword = process.env.NOTY_ADMIN_PASSWORD?.trim();
    const password = envPassword || randomBytes(12).toString("base64url");
    await pool.query(
      `INSERT INTO users (id, username, password_hash, display_name, role)
       VALUES ('user-admin', $1, $2, '관리자', 'admin')
       ON CONFLICT (username) DO NOTHING`,
      [username, hashPassword(password)],
    );
    if (envPassword) {
      console.log(`[setup] 첫 관리자 계정 '${username}' 을(를) NOTY_ADMIN_PASSWORD 로 만들었습니다.`);
    } else {
      console.log(
        `[setup] 첫 관리자 계정을 만들었습니다. 아이디: ${username} / 비밀번호: ${password}\n` +
          "[setup] 이 비밀번호는 다시 표시되지 않습니다. 로그인 후 어드민에서 바꿔 주세요.",
      );
    }
  }

  // 기존에 user_id 없이 생성된 페이지가 있다면 기본 계정(user-admin) 소유로 마이그레이션
  await pool.query("UPDATE pages SET user_id = 'user-admin' WHERE user_id IS NULL");

  // 기존 workspace_state 데이터를 user-admin 의 user_workspace_state 로 이관
  await pool.query(
    `INSERT INTO user_workspace_state (user_id, key, value, updated_at)
     SELECT 'user-admin', key, value, updated_at FROM workspace_state
     ON CONFLICT (user_id, key) DO NOTHING`,
  );

  // 기존 데이터 중 parent_id만 있고 부모 본문 링크가 없던 페이지를 복구
  await ensureParentPageLinks();

  // 각 사전 발급 계정의 workspace 상태만 초기화한다. 문서는 0개일 수 있다.
  const allUsers = await pool.query("SELECT id FROM users");
  for (const row of allUsers.rows) {
    await ensureUserWorkspace(String(row.id));
  }
}

export async function authenticateUserInDb(
  username: string,
  password: string,
): Promise<{ token: string; user: AuthUser } | null> {
  // 비밀번호 확인과 세션 발급은 공유 모듈(어드민 서버도 사용), 워크스페이스 준비는 메인 서버에서.
  const user = await verifyCredentials(username, password);
  if (!user) return null;
  await ensureUserWorkspace(user.id);
  const token = await createSession(user.id);
  return { token, user };
}

export async function getActivePageId(
  fallbackId: string,
  userId = "user-admin",
): Promise<string> {
  const res = await pool.query(
    "SELECT value FROM user_workspace_state WHERE user_id = $1 AND key = 'active_page_id'",
    [userId],
  );
  const candidate = res.rows[0]?.value ? String(res.rows[0].value) : fallbackId;
  const exists = await pool.query("SELECT 1 FROM pages WHERE id = $1 AND deleted_at IS NULL", [candidate]);
  return exists.rowCount && exists.rowCount > 0 ? candidate : fallbackId;
}

export async function setActivePageId(
  pageId: string,
  userId = "user-admin",
): Promise<void> {
  await pool.query(
    `INSERT INTO user_workspace_state (user_id, key, value, updated_at)
     VALUES ($1, 'active_page_id', $2, NOW())
     ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [userId, pageId],
  );
}

export async function getWorkspaceLayoutFromDb(
  validPageIds: Set<string>,
  fallbackPageId: string,
  userId = "user-admin",
): Promise<WorkspaceLayoutState> {
  const defaultTab: WorkspaceTabItem = {
    id: fallbackPageId ? "tab-initial" : "tab-home",
    pageId: fallbackPageId || HOME_PAGE_ID,
  };
  const fallbackLayout: WorkspaceLayoutState = {
    tabs: [defaultTab],
    activeTabId: defaultTab.id,
    splitTabIds: [defaultTab.id],
    splitRatios: [100],
  };

  try {
    const res = await pool.query(
      "SELECT value FROM user_workspace_state WHERE user_id = $1 AND key = 'layout_state'",
      [userId],
    );
    const raw = res.rows[0]?.value;
    if (!raw) return fallbackLayout;

    const parsed = JSON.parse(String(raw)) as Partial<WorkspaceLayoutState>;
    if (!Array.isArray(parsed.tabs)) return fallbackLayout;

    const seenTabIds = new Set<string>();
    let hasHomeTab = false;
    const validTabs = parsed.tabs.filter((t): t is WorkspaceTabItem => {
      if (
        !t ||
        typeof t.id !== "string" ||
        !t.id ||
        typeof t.pageId !== "string" ||
        seenTabIds.has(t.id)
      ) {
        return false;
      }
      const validPage =
        t.pageId === "" || t.pageId === HOME_PAGE_ID || validPageIds.has(t.pageId);
      if (t.pageId === HOME_PAGE_ID) {
        if (hasHomeTab) return false;
        hasHomeTab = true;
      }
      if (validPage) seenTabIds.add(t.id);
      return validPage;
    });
    if (validTabs.length === 0) {
      return fallbackLayout;
    }

    const tabIdSet = new Set(validTabs.map((t) => t.id));
    const activeTabId =
      typeof parsed.activeTabId === "string" && tabIdSet.has(parsed.activeTabId)
        ? parsed.activeTabId
        : validTabs[0].id;

    const rawSplitIds = Array.isArray(parsed.splitTabIds)
      ? parsed.splitTabIds.filter((id): id is string => typeof id === "string" && tabIdSet.has(id))
      : [];
    const uniqueSplitIds = Array.from(new Set(rawSplitIds)).slice(0, 3);
    let splitTabIds = uniqueSplitIds.length > 0 ? uniqueSplitIds : [activeTabId];
    if (!splitTabIds.includes(activeTabId)) {
      splitTabIds = [activeTabId, ...splitTabIds].slice(0, 3);
    }

    let splitRatios = Array.isArray(parsed.splitRatios)
      ? parsed.splitRatios.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 5)
      : [];
    if (splitRatios.length !== splitTabIds.length) {
      const equal = Number((100 / splitTabIds.length).toFixed(2));
      splitRatios = splitTabIds.map(() => equal);
    }

    return {
      tabs: validTabs,
      activeTabId,
      splitTabIds,
      splitRatios,
    };
  } catch {
    return fallbackLayout;
  }
}

export async function saveWorkspaceLayoutToDb(
  layoutState: WorkspaceLayoutState,
  userId = "user-admin",
): Promise<void> {
  await pool.query(
    `INSERT INTO user_workspace_state (user_id, key, value, updated_at)
     VALUES ($1, 'layout_state', $2, NOW())
     ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [userId, JSON.stringify(layoutState)],
  );

  const activeTab = layoutState.tabs.find((t) => t.id === layoutState.activeTabId) ?? layoutState.tabs[0];
  if (activeTab?.pageId && activeTab.pageId !== HOME_PAGE_ID) {
    await setActivePageId(activeTab.pageId, userId);
  }
}

export async function listPagesFromDb(userId = "user-admin"): Promise<{
  pages: PageRow[];
  activePageId: string;
  layoutState: WorkspaceLayoutState;
}> {
  await ensureUserWorkspace(userId);
  const res = await pool.query(
    `SELECT id, kind, title, icon, page_width, parent_id, sort_order, created_at, updated_at
     FROM pages
     WHERE deleted_at IS NULL
     ORDER BY sort_order ASC, created_at ASC`,
  );
  const pages = res.rows.map(mapPageRow);
  const firstId = pages[0]?.id ?? "";
  const activePageId = await getActivePageId(firstId, userId);
  const validPageIds = new Set(pages.map((p) => p.id));
  const layoutState = await getWorkspaceLayoutFromDb(validPageIds, activePageId, userId);
  return { pages, activePageId, layoutState };
}

export async function createPageInDb(
  options?: {
    parentId?: string | null;
    title?: string;
    insertIntoParentBlocks?: boolean;
    kind?: PageKind;
  },
  userId = "user-admin",
): Promise<{ page: PageRow; pages: PageRow[] }> {
  const kind: PageKind = options?.kind === "canvas" ? "canvas" : "page";
  const parentId =
    options?.parentId && options.parentId.trim() ? options.parentId.trim() : null;
  const title = options?.title?.trim() || (kind === "canvas" ? "제목 없는 캔버스" : "제목 없는 문서");
  const id = `page-${randomUUID().slice(0, 8)}`;

  // 캔버스는 본문 블록 대신 카드·연결선을 협업(Yjs) 문서에 저장한다.
  const initialBlocks = kind === "canvas" ? [] : [
    {
      type: "heading",
      props: { level: 1 },
      content: title,
    },
    {
      type: "paragraph",
      content: "",
    },
  ];

  const client = await pool.connect();
  let page: PageRow;
  try {
    await client.query("BEGIN");

    if (parentId) {
      const parent = await client.query("SELECT kind FROM pages WHERE id = $1 AND deleted_at IS NULL", [parentId]);
      if (!parent.rowCount) throw new Error("Parent page not found");
      if (parent.rows[0].kind === "canvas") throw new PageStructureError(CANVAS_PARENT_ERROR);
    }

    const orderRes = await client.query(
      `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order
       FROM pages
       WHERE deleted_at IS NULL AND (($1::text IS NULL AND parent_id IS NULL) OR parent_id = $1)`,
      [parentId],
    );
    const nextOrder = Number(orderRes.rows[0]?.next_order ?? 0);

    const insertRes = await client.query(
      `INSERT INTO pages (id, user_id, title, parent_id, sort_order, blocks, plain_text, kind)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
       RETURNING id, kind, title, icon, page_width, parent_id, sort_order, created_at, updated_at`,
      [id, userId, title, parentId, nextOrder, JSON.stringify(initialBlocks), title, kind],
    );
    page = mapPageRow(insertRes.rows[0]);

    // 부모 페이지가 있으면 부모 문서 본문(blocks)에도 자동으로 `page` 블록을 추가하고 page_links 연결
    if (parentId) {
      // 호출자가 전달한 insertIntoParentBlocks 값과 관계없이 부모 링크를 보장하되,
      // 호출자가 직접 부모 본문을 저장할 예정(insertIntoParentBlocks === false)이면 Yjs 상태를 무효화하지 않는다.
      await appendPageBlockToParentInTx(
        client,
        parentId,
        id,
        options?.insertIntoParentBlocks !== false,
      );
      await client.query(
        `INSERT INTO page_links (source_id, target_id)
         VALUES ($1, $2)
         ON CONFLICT (source_id, target_id) DO NOTHING`,
        [parentId, id],
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  await setActivePageId(id, userId);
  const { pages } = await listPagesFromDb(userId);
  return { page: page!, pages };
}

async function isDescendantInDb(
  targetParentId: string | null,
  pageId: string,
): Promise<boolean> {
  if (!targetParentId) return false;
  if (targetParentId === pageId) return true;

  const res = await pool.query(
    `WITH RECURSIVE ancestors AS (
       SELECT id, parent_id FROM pages WHERE id = $1
       UNION ALL
       SELECT p.id, p.parent_id
       FROM pages p
       INNER JOIN ancestors a ON p.id = a.parent_id
     )
     SELECT 1 FROM ancestors WHERE id = $2 LIMIT 1`,
    [targetParentId, pageId],
  );
  return Boolean(res.rowCount && res.rowCount > 0);
}

export async function updatePageInDb(
  payload: {
    id: string;
    title?: string;
    icon?: string | null;
    pageWidth?: string | null;
    parentId?: string | null;
    targetId?: string;
    placement?: "before" | "inside" | "after";
  },
  userId = "user-admin",
): Promise<{ pages: PageRow[] }> {
  const { id } = payload;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const currentRes = await client.query(
      "SELECT parent_id FROM pages WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
      [id],
    );
    if (!currentRes.rowCount || currentRes.rowCount === 0) {
      await client.query("ROLLBACK");
      const { pages } = await listPagesFromDb(userId);
      return { pages };
    }
    const oldParentId = currentRes.rows[0].parent_id
      ? String(currentRes.rows[0].parent_id)
      : null;

    if (typeof payload.title === "string") {
      const cleanTitle = payload.title.trim() || "제목 없는 문서";
      await client.query(
      "UPDATE pages SET title = $1, updated_at = NOW() WHERE id = $2 AND deleted_at IS NULL",
        [cleanTitle, id],
      );
    }

    if (payload.icon !== undefined) {
      const cleanIcon = payload.icon && payload.icon.trim() ? payload.icon.trim() : null;
      await client.query(
        "UPDATE pages SET icon = $1, updated_at = NOW() WHERE id = $2 AND deleted_at IS NULL",
        [cleanIcon, id],
      );
    }

    if (payload.pageWidth !== undefined) {
      const cleanWidth = normalizePageWidth(payload.pageWidth);
      await client.query(
        "UPDATE pages SET page_width = $1, updated_at = NOW() WHERE id = $2 AND deleted_at IS NULL",
        [cleanWidth, id],
      );
    }

    let nextParentId: string | null | undefined = undefined;
    const { targetId, placement } = payload;

    if (targetId && placement) {
      if (placement === "inside") {
        nextParentId = targetId;
      } else {
        const targetRes = await client.query(
          "SELECT parent_id FROM pages WHERE id = $1 AND deleted_at IS NULL",
          [targetId],
        );
        if (targetRes.rowCount && targetRes.rowCount > 0) {
          nextParentId = targetRes.rows[0].parent_id
            ? String(targetRes.rows[0].parent_id)
            : null;
        }
      }
    } else if ("parentId" in payload) {
      nextParentId = payload.parentId ?? null;
    }

    if (nextParentId !== undefined) {
      if (nextParentId) {
        const liveParent = await client.query(
          "SELECT kind FROM pages WHERE id = $1 AND deleted_at IS NULL",
          [nextParentId],
        );
        if (!liveParent.rowCount) throw new Error("Parent page not found");
        if (liveParent.rows[0].kind === "canvas") throw new PageStructureError(CANVAS_PARENT_ERROR);
      }
      const cycle = await isDescendantInDb(nextParentId, id);
      if (!cycle) {
        if (targetId && (placement === "before" || placement === "after")) {
          // 같은 부모 내 형제 페이지 목록 조회 후 순서 재배치
          const siblingsRes = await client.query(
            `SELECT id FROM pages
             WHERE deleted_at IS NULL AND (($1::text IS NULL AND parent_id IS NULL) OR parent_id = $1)
               AND id <> $2
             ORDER BY sort_order ASC, created_at ASC`,
            [nextParentId, id],
          );
          const orderedIds = siblingsRes.rows.map((r) => String(r.id));
          const targetIdx = orderedIds.indexOf(targetId);
          if (targetIdx === -1) {
            orderedIds.push(id);
          } else {
            const insertIdx = placement === "before" ? targetIdx : targetIdx + 1;
            orderedIds.splice(insertIdx, 0, id);
          }

          await client.query(
            "UPDATE pages SET parent_id = $1, updated_at = NOW() WHERE id = $2",
            [nextParentId, id],
          );

          for (let index = 0; index < orderedIds.length; index += 1) {
            await client.query(
              "UPDATE pages SET sort_order = $1 WHERE id = $2",
              [index, orderedIds[index]],
            );
          }
        } else if (nextParentId !== oldParentId) {
          const orderRes = await client.query(
            `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order
             FROM pages
             WHERE deleted_at IS NULL AND (($1::text IS NULL AND parent_id IS NULL) OR parent_id = $1)
               AND id <> $2`,
            [nextParentId, id],
          );
          const nextOrder = Number(orderRes.rows[0]?.next_order ?? 0);
          await client.query(
            "UPDATE pages SET parent_id = $1, sort_order = $2, updated_at = NOW() WHERE id = $3",
            [nextParentId, nextOrder, id],
          );
        }

        // 부모 계층이 변경된 경우 page_links 를 갱신하고, 기존/새 부모 본문의 page 블록 구조를
        // 사이드바 계층과 일치시킨다. (제거 · 추가 · sort_order 순서 재배치)
        if (nextParentId !== oldParentId) {
          if (oldParentId) {
            await client.query(
              "DELETE FROM page_links WHERE source_id = $1 AND target_id = $2",
              [oldParentId, id],
            );
          }
          if (nextParentId) {
            await client.query(
              `INSERT INTO page_links (source_id, target_id)
               VALUES ($1, $2)
               ON CONFLICT (source_id, target_id) DO NOTHING`,
              [nextParentId, id],
            );
          }
        }
        const affectedParentIds = new Set(
          [oldParentId, nextParentId].filter((value): value is string => Boolean(value)),
        );
        for (const parentId of affectedParentIds) {
          await reconcileParentPageBlocksInTx(client, parentId, { reorder: true });
        }
      }
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const { pages } = await listPagesFromDb(userId);
  return { pages };
}

/**
 * 에디터 본문에서 page 블록 순서를 바꿨을 때 사이드바(sort_order)에도 같은 순서를 반영한다.
 * 본문(blocks)은 클라이언트가 이미 해당 순서로 저장하므로 여기서는 건드리지 않는다.
 * 전달되지 않은 자식은 기존 순서를 유지한 채 뒤에 붙이고, 자식이 아닌 id 는 무시한다.
 */
export async function reorderChildPagesInDb(
  parentId: string,
  orderedIds: readonly string[],
  userId = "user-admin",
): Promise<{ pages: PageRow[] }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const parent = await client.query("SELECT id FROM pages WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [parentId]);
    if (!parent.rowCount) throw new Error("Parent page not found");
    const currentIds = await listChildPageIdsInTx(client, parentId);
    const currentSet = new Set(currentIds);
    const requested = Array.from(new Set(orderedIds.filter((id) => currentSet.has(id))));
    const requestedSet = new Set(requested);
    const finalOrder = [...requested, ...currentIds.filter((id) => !requestedSet.has(id))];

    for (let index = 0; index < finalOrder.length; index += 1) {
      await client.query("UPDATE pages SET sort_order = $1 WHERE id = $2", [
        index,
        finalOrder[index],
      ]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const { pages } = await listPagesFromDb(userId);
  return { pages };
}

export async function deletePageInDb(
  id: string,
  userId = "user-admin",
): Promise<{
  pages: PageRow[];
  nextActivePageId: string;
}> {
  return deletePagesBatchInDb([id], userId);
}

export async function deletePagesBatchInDb(
  ids: string[],
  userId = "user-admin",
): Promise<{
  pages: PageRow[];
  nextActivePageId: string;
}> {
  const cleanIds = Array.from(
    new Set(ids.filter((id) => typeof id === "string" && id.trim().length > 0)),
  );
  if (cleanIds.length === 0) {
    const { pages, activePageId } = await listPagesFromDb(userId);
    return { pages, nextActivePageId: activePageId };
  }

  const client = await pool.connect();
  let preferredParentId: string | null = null;
  try {
    await client.query("BEGIN");
    const roots = await client.query(
      "SELECT id, parent_id FROM pages WHERE id = ANY($1::text[]) AND deleted_at IS NULL FOR UPDATE",
      [cleanIds],
    );
    const selected = new Set(roots.rows.map((row) => String(row.id)));
    const rootRows = [] as Array<{ id: string; parentId: string | null }>;
    for (const row of roots.rows) {
      const id = String(row.id);
      let parentId = row.parent_id ? String(row.parent_id) : null;
      let covered = false;
      while (parentId) {
        if (selected.has(parentId)) { covered = true; break; }
        const ancestor = await client.query("SELECT parent_id FROM pages WHERE id = $1", [parentId]);
        parentId = ancestor.rows[0]?.parent_id ? String(ancestor.rows[0].parent_id) : null;
      }
      if (!covered) rootRows.push({ id, parentId: row.parent_id ? String(row.parent_id) : null });
    }
    preferredParentId = rootRows[0]?.parentId ?? null;
    const deletedIds = new Set<string>();
    for (const root of rootRows) {
      const result = await client.query(
        `WITH RECURSIVE subtree AS (
           SELECT id FROM pages WHERE id = $1 AND deleted_at IS NULL
           UNION ALL
           SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id WHERE p.deleted_at IS NULL
         )
         UPDATE pages SET deleted_at = NOW(), deleted_root_id = $1
         WHERE id IN (SELECT id FROM subtree) RETURNING id`,
        [root.id],
      );
      for (const row of result.rows) deletedIds.add(String(row.id));
    }

    if (deletedIds.size > 0) {
      const referencingRes = await client.query(
        "SELECT id, blocks FROM pages WHERE deleted_at IS NULL",
      );
      const modifiedParentIds: string[] = [];
      for (const row of referencingRes.rows) {
        const rowId = String(row.id);
        const blocks = Array.isArray(row.blocks) ? (row.blocks as unknown[]) : [];
        const cleaned = removePageBlocksFromTree(blocks, deletedIds);
        if (JSON.stringify(cleaned) !== JSON.stringify(blocks)) {
          await writeServerModifiedBlocksInTx(client, rowId, cleaned, false);
          modifiedParentIds.push(rowId);
        }
      }

      const affectedIds = new Set(modifiedParentIds);
      for (const root of rootRows) if (root.parentId && !deletedIds.has(root.parentId)) affectedIds.add(root.parentId);
      for (const pageId of affectedIds) {
        await client.query("SELECT pg_notify($1, $2)", [PAGE_STRUCTURE_CHANGED_CHANNEL, pageId]);
      }
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const { pages } = await listPagesFromDb(userId);
  const nextActivePageId = preferredParentId && pages.some((page) => page.id === preferredParentId)
    ? preferredParentId : pages[0]?.id ?? "";
  await setActivePageId(nextActivePageId, userId);
  return { pages, nextActivePageId };
}

export async function purgeExpiredTrash(): Promise<void> {
  await pool.query("DELETE FROM pages WHERE deleted_at < NOW() - INTERVAL '30 days'");
}

export async function listTrashFromDb(): Promise<TrashedPageRow[]> {
  await purgeExpiredTrash();
  const result = await pool.query(
    `SELECT root.id, root.title, root.icon, root.parent_id, root.deleted_at,
            root.deleted_at + INTERVAL '30 days' AS expires_at,
            COUNT(member.id)::int AS page_count
     FROM pages root JOIN pages member ON member.deleted_root_id = root.id
     WHERE root.deleted_at IS NOT NULL AND root.deleted_root_id = root.id
     GROUP BY root.id ORDER BY root.deleted_at DESC`,
  );
  return result.rows.map((row) => ({
    id: String(row.id), title: String(row.title), icon: row.icon ? String(row.icon) : null,
    parentId: row.parent_id ? String(row.parent_id) : null,
    deletedAt: new Date(row.deleted_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    pageCount: Number(row.page_count),
  }));
}

export async function restorePageFromTrash(id: string, userId = "user-admin"): Promise<{ pages: PageRow[] }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const root = await client.query(
      "SELECT parent_id FROM pages WHERE id = $1 AND deleted_at > NOW() - INTERVAL '30 days' AND deleted_root_id = id FOR UPDATE",
      [id],
    );
    if (!root.rowCount) throw new Error("복구할 페이지가 없거나 보관 기간이 지났습니다.");
    const parentId = root.rows[0].parent_id ? String(root.rows[0].parent_id) : null;
    const parent = parentId ? await client.query("SELECT 1 FROM pages WHERE id = $1 AND deleted_at IS NULL", [parentId]) : null;
    if (parentId && !parent?.rowCount) {
      await client.query("UPDATE pages SET parent_id = NULL WHERE id = $1", [id]);
    }
    await client.query(
      "UPDATE pages SET deleted_at = NULL, deleted_root_id = NULL WHERE deleted_root_id = $1",
      [id],
    );
    if (parentId && parent?.rowCount) {
      const parentBlocks = await client.query("SELECT blocks FROM pages WHERE id = $1 FOR UPDATE", [parentId]);
      const currentBlocks = Array.isArray(parentBlocks.rows[0]?.blocks) ? parentBlocks.rows[0].blocks as unknown[] : [];
      const nextBlocks = appendPageBlockIfMissing(currentBlocks, id);
      if (nextBlocks !== currentBlocks) await writeServerModifiedBlocksInTx(client, parentId, nextBlocks, false);
      await client.query("SELECT pg_notify($1, $2)", [PAGE_STRUCTURE_CHANGED_CHANNEL, parentId]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const { pages } = await listPagesFromDb(userId);
  return { pages };
}

export async function getBacklinksForPage(pageId: string): Promise<PageLinkSummary[]> {
  const res = await pool.query(
    `SELECT p.id, p.title
     FROM page_links pl
     INNER JOIN pages p ON p.id = pl.source_id
     WHERE pl.target_id = $1 AND p.deleted_at IS NULL
     ORDER BY p.updated_at DESC`,
    [pageId],
  );
  return res.rows.map((row) => ({
    id: String(row.id),
    title: String(row.title ?? "제목 없는 문서"),
  }));
}

export async function loadDocumentFromDb(
  pageId: string,
  userId = "user-admin",
): Promise<{
  blocks: unknown[] | null;
  path: string;
  backlinks: PageLinkSummary[];
}> {
  const res = await pool.query(
    "SELECT id, blocks FROM pages WHERE id = $1 AND deleted_at IS NULL",
    [pageId],
  );
  if (!res.rowCount || res.rowCount === 0) {
    return {
      blocks: null,
      path: `postgres://pages/${pageId}`,
      backlinks: [],
    };
  }

  await setActivePageId(pageId, userId);
  const backlinks = await getBacklinksForPage(pageId);
  return {
    blocks: Array.isArray(res.rows[0].blocks) ? (res.rows[0].blocks as unknown[]) : null,
    path: `postgres://pages/${pageId}`,
    backlinks,
  };
}

export async function saveDocumentToDb(
  pageId: string,
  blocks: readonly unknown[],
  title?: string,
  userId = "user-admin",
): Promise<{
  path: string;
  savedAt: string;
  pages: PageRow[];
  backlinks: PageLinkSummary[];
}> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 부모 페이지를 잠가 저장 중 구조 변경과 충돌하지 않도록 한다.
    const page = await client.query("SELECT id FROM pages WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [pageId]);
    if (!page.rowCount) throw new Error("Page not found");

    // 본문 page 블록 구조를 사이드바 계층에 맞춘다. 순서는 클라이언트 본문을 존중하고(reorder: false),
    // 자식이 아닌 page 블록 제거 · 누락 자식 추가만 수행한다.
    const childPageIds = await listChildPageIdsInTx(client, pageId);
    const reconciled = reconcileChildPageBlocks(Array.isArray(blocks) ? blocks : [], childPageIds, {
      reorder: false,
    });
    const nextBlocks = reconciled.blocks;

    const plainText = extractDocumentPlainText(nextBlocks);
    const cleanTitle = title?.trim();

    if (cleanTitle) {
      await client.query(
        `UPDATE pages
         SET blocks = $1::jsonb,
             plain_text = $2,
             title = $3,
             updated_at = NOW()
         WHERE id = $4`,
        [JSON.stringify(nextBlocks), plainText, cleanTitle, pageId],
      );
    } else {
      await client.query(
        `UPDATE pages
         SET blocks = $1::jsonb,
             plain_text = $2,
             updated_at = NOW()
         WHERE id = $3`,
        [JSON.stringify(nextBlocks), plainText, pageId],
      );
    }

    // 서버가 클라이언트 본문의 구조를 보정했다면 다음 Yjs 로드 시 보정된 본문으로 다시 시드되도록 표시하고,
    // 클라이언트가 보낸 본문이 이미 서버 계층과 일치한다면 이전 서버 수정 표시를 해제한다.
    await client.query(
      "UPDATE pages SET blocks_server_modified_at = CASE WHEN $2::boolean THEN NOW() ELSE NULL END WHERE id = $1",
      [pageId, reconciled.changed],
    );

    // 본문 내 page 블록 및 pageLink 인라인 참조를 추출해 page_links 그래프 테이블 동기화
    const linkedIds = Array.from(
      new Set([
        ...extractLinkedPageIds(nextBlocks),
        ...childPageIds,
      ]),
    ).filter((targetId) => targetId !== pageId);
    await client.query("DELETE FROM page_links WHERE source_id = $1", [pageId]);

    if (linkedIds.length > 0) {
      await client.query(
        `INSERT INTO page_links (source_id, target_id)
         SELECT $1, p.id
         FROM pages p
         WHERE p.id = ANY($2::text[]) AND p.deleted_at IS NULL
         ON CONFLICT (source_id, target_id) DO NOTHING`,
        [pageId, linkedIds],
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  await setActivePageId(pageId, userId);
  const { pages } = await listPagesFromDb(userId);
  const backlinks = await getBacklinksForPage(pageId);

  return {
    path: `postgres://pages/${pageId}`,
    savedAt: new Date().toISOString(),
    pages,
    backlinks,
  };
}
