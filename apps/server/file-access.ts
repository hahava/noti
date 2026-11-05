import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { pool } from "./db.js";

/**
 * 첨부 파일(/uploads/*) 접근 제어.
 *
 * <img src> 나 다운로드 링크는 Authorization 헤더를 실을 수 없으므로, 로그인한 사용자에게
 * 짧은 기간만 유효한 서명 주소(/uploads/<파일>?exp=..&sig=..)를 발급한다.
 * - 서명 키는 system_settings 에 한 번 만들어 저장한다(서버를 여러 대 띄워도 같은 키를 쓴다).
 * - 만료 시각을 1시간 단위로 맞춰, 같은 시간대에는 같은 주소가 나와 브라우저 캐시가 그대로 쓰인다.
 */

const SECRET_KEY = "file_url_secret";
const BUCKET_SECONDS = 60 * 60;
export const UPLOADS_PREFIX = "/uploads/";

let secretPromise: Promise<Buffer> | null = null;

async function loadSecret(): Promise<Buffer> {
  const fromEnv = process.env.FILE_URL_SECRET?.trim();
  if (fromEnv) return Buffer.from(fromEnv, "utf8");

  const candidate = randomBytes(32).toString("base64url");
  // 처음 만든 서버의 키가 저장되고, 동시에 시작한 다른 서버도 저장된 값을 읽어 같은 키를 쓴다.
  await pool.query(
    `INSERT INTO system_settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING`,
    [SECRET_KEY, JSON.stringify({ secret: candidate })],
  );
  const res = await pool.query<{ value: { secret?: string } }>("SELECT value FROM system_settings WHERE key = $1", [SECRET_KEY]);
  const secret = res.rows[0]?.value?.secret;
  if (!secret) throw new Error("파일 서명 키를 불러오지 못했습니다.");
  return Buffer.from(secret, "utf8");
}

function getSecret(): Promise<Buffer> {
  if (!secretPromise) {
    secretPromise = loadSecret().catch((error) => {
      secretPromise = null;
      throw error;
    });
  }
  return secretPromise;
}

function sign(secret: Buffer, fileName: string, exp: number): string {
  return createHmac("sha256", secret).update(`${fileName}\n${exp}`).digest("base64url");
}

/** /uploads/<파일> (또는 그 앞에 서버 주소가 붙은 형태) 에서 파일 이름만 꺼낸다. 아니면 null. */
export function parseUploadFileName(url: string): string | null {
  let pathname = url;
  try {
    pathname = new URL(url, "http://local").pathname;
  } catch {
    return null;
  }
  if (!pathname.startsWith(UPLOADS_PREFIX)) return null;
  const raw = decodeURIComponent(pathname.slice(UPLOADS_PREFIX.length));
  // 하위 경로나 상위 경로 이동은 허용하지 않는다.
  if (!raw || raw.includes("/") || raw.includes("\\") || raw.startsWith(".")) return null;
  return raw;
}

export async function createSignedUploadUrl(fileName: string, nowMs = Date.now()): Promise<{ url: string; expiresAt: string }> {
  const secret = await getSecret();
  const nowSeconds = Math.floor(nowMs / 1000);
  // 최소 1시간, 최대 2시간 유효. 같은 시간대에는 같은 주소가 나온다.
  const exp = (Math.floor(nowSeconds / BUCKET_SECONDS) + 2) * BUCKET_SECONDS;
  const sig = sign(secret, fileName, exp);
  return {
    url: `${UPLOADS_PREFIX}${encodeURIComponent(fileName)}?exp=${exp}&sig=${sig}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

export async function verifyUploadSignature(
  fileName: string,
  expRaw: string | null,
  sigRaw: string | null,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!expRaw || !sigRaw) return false;
  const exp = Number(expRaw);
  if (!Number.isInteger(exp) || exp * 1000 < nowMs) return false;
  const expected = Buffer.from(sign(await getSecret(), fileName, exp));
  const given = Buffer.from(sigRaw);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
