import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { pool } from "./db.js";

/**
 * 사용자·세션·역할 (메인 API, 협업 서버, 어드민 서버가 함께 쓴다)
 *
 * 역할
 *  - admin  : 관리자. 모든 편집 + 어드민 접속
 *  - editor : 편집자. 페이지 보기·편집
 *  - viewer : 읽기 전용. 보기와 AI 질문만 (저장·이동·삭제·실시간 편집 불가)
 */

export type UserRole = "admin" | "editor" | "viewer";

export const USER_ROLES: readonly UserRole[] = ["admin", "editor", "viewer"];

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
}

export interface ManagedUser extends AuthUser {
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  activeSessions: number;
  pageCount: number;
}

const SESSION_TTL_DAYS = 30;
const MIN_PASSWORD_LENGTH = 8;
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,31}$/;

/** 예전 'user' 같은 값은 편집자로 본다. */
export function normalizeRole(value: unknown): UserRole {
  return value === "admin" || value === "viewer" ? value : "editor";
}

export function canEditContent(role: UserRole): boolean {
  return role !== "viewer";
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, keyHex] = storedHash.split(":");
  if (!salt || !keyHex) return false;
  const keyBuffer = Buffer.from(keyHex, "hex");
  const derivedBuffer = scryptSync(password, salt, 64);
  if (keyBuffer.length !== derivedBuffer.length) return false;
  return timingSafeEqual(keyBuffer, derivedBuffer);
}

function rowToUser(row: any): AuthUser {
  return {
    id: String(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    role: normalizeRole(row.role),
  };
}

/** 사용자 표의 공유 모듈 전용 컬럼을 보장한다 (어드민 서버가 먼저 떠도 동작하도록). */
export async function ensureUserColumns(): Promise<void> {
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ");
}

/** 아이디·비밀번호 확인. 비활성화된 계정은 null. */
export async function verifyCredentials(username: string, password: string): Promise<AuthUser | null> {
  const cleanUsername = username.trim().toLowerCase();
  if (!cleanUsername || !password) return null;
  const res = await pool.query(
    `SELECT id, username, password_hash, display_name, role, disabled_at
       FROM users WHERE LOWER(username) = $1 LIMIT 1`,
    [cleanUsername],
  );
  const row = res.rows[0];
  if (!row || row.disabled_at) return null;
  if (!verifyPassword(password, String(row.password_hash))) return null;
  return rowToUser(row);
}

export async function createSession(userId: string): Promise<string> {
  const token = `noty_${randomBytes(24).toString("hex")}`;
  await pool.query(
    `INSERT INTO user_sessions (token, user_id, expires_at)
     VALUES ($1, $2, NOW() + ($3::int * INTERVAL '1 day'))`,
    [token, userId, SESSION_TTL_DAYS],
  );
  await pool.query("UPDATE users SET last_login_at = NOW() WHERE id = $1", [userId]).catch(() => undefined);
  return token;
}

export async function getUserBySessionToken(token: string): Promise<AuthUser | null> {
  const cleanToken = token.trim();
  if (!cleanToken) return null;
  const res = await pool.query(
    `SELECT u.id, u.username, u.display_name, u.role
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token = $1 AND s.expires_at > NOW() AND u.disabled_at IS NULL
      LIMIT 1`,
    [cleanToken],
  );
  return res.rows[0] ? rowToUser(res.rows[0]) : null;
}

export async function revokeSessionToken(token: string): Promise<void> {
  const cleanToken = token.trim();
  if (!cleanToken) return;
  await pool.query("DELETE FROM user_sessions WHERE token = $1", [cleanToken]);
}

/* --------------------------------------------------------------------------
 * 계정 관리 (어드민)
 * ------------------------------------------------------------------------ */

export class UserAdminError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "UserAdminError";
  }
}

function validatePassword(password: string): void {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw new UserAdminError(`비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다.`);
  }
}

export async function listManagedUsers(): Promise<ManagedUser[]> {
  const res = await pool.query(
    `SELECT u.id, u.username, u.display_name, u.role, u.disabled_at, u.created_at, u.last_login_at,
            (SELECT COUNT(*) FROM user_sessions s WHERE s.user_id = u.id AND s.expires_at > NOW())::int AS active_sessions,
            (SELECT COUNT(*) FROM pages p WHERE p.user_id = u.id AND p.deleted_at IS NULL)::int AS page_count
       FROM users u
      ORDER BY u.created_at ASC, u.username ASC`,
  );
  return res.rows.map((row) => ({
    ...rowToUser(row),
    disabled: Boolean(row.disabled_at),
    createdAt: new Date(row.created_at).toISOString(),
    lastLoginAt: row.last_login_at ? new Date(row.last_login_at).toISOString() : null,
    activeSessions: Number(row.active_sessions),
    pageCount: Number(row.page_count),
  }));
}

async function countActiveAdmins(excludeUserId?: string): Promise<number> {
  const res = await pool.query(
    "SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin' AND disabled_at IS NULL AND id <> COALESCE($1, '')",
    [excludeUserId ?? null],
  );
  return Number(res.rows[0]?.count ?? 0);
}

/** 마지막으로 남은 활성 관리자를 없애는 변경은 막는다 (어드민에 아무도 못 들어가게 되므로). */
async function assertNotLastAdmin(userId: string): Promise<void> {
  const target = await pool.query("SELECT role, disabled_at FROM users WHERE id = $1", [userId]);
  const row = target.rows[0];
  if (!row) throw new UserAdminError("계정을 찾을 수 없습니다.", 404);
  if (row.role === "admin" && !row.disabled_at && (await countActiveAdmins(userId)) === 0) {
    throw new UserAdminError("마지막으로 남은 관리자 계정은 역할을 바꾸거나 비활성화·삭제할 수 없습니다.");
  }
}

export async function createManagedUser(input: {
  username: string;
  displayName?: string;
  password: string;
  role?: UserRole;
}): Promise<AuthUser> {
  const username = (input.username || "").trim().toLowerCase();
  if (!USERNAME_PATTERN.test(username)) {
    throw new UserAdminError("아이디는 영문 소문자·숫자로 시작하는 2~32자 (영문 소문자, 숫자, . _ -)여야 합니다.");
  }
  validatePassword(input.password);
  const role = normalizeRole(input.role);
  const displayName = (input.displayName || "").trim() || username;
  const exists = await pool.query("SELECT 1 FROM users WHERE LOWER(username) = $1", [username]);
  if (exists.rowCount) throw new UserAdminError("이미 있는 아이디입니다.", 409);
  const res = await pool.query(
    `INSERT INTO users (id, username, password_hash, display_name, role)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, username, display_name, role`,
    [`user-${username}`, username, hashPassword(input.password), displayName, role],
  );
  return rowToUser(res.rows[0]);
}

export async function updateManagedUser(
  userId: string,
  patch: { displayName?: string; role?: UserRole; disabled?: boolean },
): Promise<AuthUser> {
  const current = await pool.query("SELECT id FROM users WHERE id = $1", [userId]);
  if (!current.rowCount) throw new UserAdminError("계정을 찾을 수 없습니다.", 404);

  const demoting = patch.role !== undefined && normalizeRole(patch.role) !== "admin";
  if (demoting || patch.disabled === true) await assertNotLastAdmin(userId);

  if (patch.displayName !== undefined) {
    const displayName = patch.displayName.trim();
    if (!displayName) throw new UserAdminError("표시 이름을 입력해 주세요.");
    await pool.query("UPDATE users SET display_name = $2 WHERE id = $1", [userId, displayName]);
  }
  if (patch.role !== undefined) {
    await pool.query("UPDATE users SET role = $2 WHERE id = $1", [userId, normalizeRole(patch.role)]);
  }
  if (patch.disabled !== undefined) {
    await pool.query("UPDATE users SET disabled_at = CASE WHEN $2::boolean THEN NOW() ELSE NULL END WHERE id = $1", [
      userId,
      patch.disabled,
    ]);
    // 비활성화하면 이미 로그인한 세션도 바로 끊는다.
    if (patch.disabled) await pool.query("DELETE FROM user_sessions WHERE user_id = $1", [userId]);
  }
  const res = await pool.query("SELECT id, username, display_name, role FROM users WHERE id = $1", [userId]);
  return rowToUser(res.rows[0]);
}

export async function resetManagedUserPassword(userId: string, password: string): Promise<void> {
  validatePassword(password);
  const res = await pool.query("UPDATE users SET password_hash = $2 WHERE id = $1", [userId, hashPassword(password)]);
  if (!res.rowCount) throw new UserAdminError("계정을 찾을 수 없습니다.", 404);
  // 비밀번호를 바꾸면 기존 로그인은 모두 끊는다.
  await pool.query("DELETE FROM user_sessions WHERE user_id = $1", [userId]);
}

export async function revokeUserSessions(userId: string): Promise<number> {
  const res = await pool.query("DELETE FROM user_sessions WHERE user_id = $1", [userId]);
  return res.rowCount ?? 0;
}

/**
 * 계정 삭제. 공유 워크스페이스라 그 사용자가 만든 페이지는 지우지 않고 transferToUserId 에게 넘긴다.
 */
export async function deleteManagedUser(userId: string, transferToUserId: string): Promise<{ transferredPages: number }> {
  if (userId === transferToUserId) throw new UserAdminError("페이지를 넘겨받을 다른 계정을 선택해 주세요.");
  await assertNotLastAdmin(userId);
  const target = await pool.query("SELECT 1 FROM users WHERE id = $1 AND disabled_at IS NULL", [transferToUserId]);
  if (!target.rowCount) throw new UserAdminError("페이지를 넘겨받을 계정이 없거나 비활성화되어 있습니다.");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const moved = await client.query("UPDATE pages SET user_id = $2 WHERE user_id = $1", [userId, transferToUserId]);
    // 검색·임베딩 조각의 소유자 표시도 함께 옮긴다 (없는 표는 건너뜀).
    for (const table of ["page_chunks", "page_embeddings", "attachments"]) {
      const exists = await client.query("SELECT to_regclass($1) AS t", [`public.${table}`]);
      if (exists.rows[0]?.t) await client.query(`UPDATE ${table} SET user_id = $2 WHERE user_id = $1`, [userId, transferToUserId]);
    }
    await client.query("DELETE FROM users WHERE id = $1", [userId]);
    await client.query("COMMIT");
    return { transferredPages: moved.rowCount ?? 0 };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
