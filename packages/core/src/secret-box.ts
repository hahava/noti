import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readInstallConfig } from "./config.js";
import { DATA_DIR } from "./paths.js";

/**
 * DB 에 저장하는 비밀값(AI API 키, DB 비밀번호)을 AES-256-GCM 으로 암호화한다.
 * DB 덤프나 백업이 새도 키가 같이 새지 않도록, 암호화 키는 DB 밖에 둔다.
 *
 * 키 우선순위: NOTY_SECRET_KEY 환경변수 → 설치 설정(secrets.settingsKey) → <데이터 폴더>/secret.key (없으면 만든다)
 * 저장 형식: "enc:v1:<iv>:<tag>:<암호문>" (base64url). 이 형식이 아닌 값은 예전 평문으로 보고 그대로 읽는다.
 * 키를 잃으면 저장된 API 키를 복구할 수 없다 (어드민에서 다시 입력하면 된다).
 */

const PREFIX = "enc:v1:";
let cachedKey: Buffer | null = null;

function deriveKey(material: string): Buffer {
  return createHash("sha256").update(material, "utf8").digest();
}

export function getSecretKey(): Buffer {
  if (cachedKey) return cachedKey;
  const fromEnv = process.env.NOTY_SECRET_KEY?.trim();
  const fromConfig = readInstallConfig()?.secrets.settingsKey;
  if (fromEnv || fromConfig) {
    cachedKey = deriveKey((fromEnv || fromConfig)!);
    return cachedKey;
  }
  const keyFile = path.join(DATA_DIR, "secret.key");
  if (!existsSync(keyFile)) {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(keyFile, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(keyFile, 0o600);
  }
  cachedKey = deriveKey(readFileSync(keyFile, "utf8").trim());
  return cachedKey;
}

/** 테스트용: 키 캐시를 비운다. */
export function resetSecretKeyCache(): void {
  cachedKey = null;
}

export function isSealed(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(PREFIX);
}

export function sealSecret(value: string | undefined | null): string {
  if (!value || isSealed(value)) return value || "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getSecretKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${PREFIX}${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${encrypted.toString("base64url")}`;
}

export function openSecret(value: string | undefined | null): string {
  if (!value) return "";
  if (!isSealed(value)) return value; // 예전 평문
  const [ivPart, tagPart, dataPart] = value.slice(PREFIX.length).split(":");
  try {
    const decipher = createDecipheriv("aes-256-gcm", getSecretKey(), Buffer.from(ivPart, "base64url"));
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(dataPart, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    console.error("[secret-box] 저장된 비밀값을 풀지 못했습니다. 암호화 키(NOTY_SECRET_KEY / secret.key)가 바뀌었는지 확인하세요. 어드민에서 다시 입력하면 됩니다.");
    return "";
  }
}

type SecretRow = Record<string, any>;

/** system_settings 의 한 줄(key, value)에서 비밀값 필드에 fn 을 적용한다. */
export function mapSettingSecrets(key: string, value: SecretRow, fn: (secret: string) => string): SecretRow {
  if (!value || typeof value !== "object") return value;
  const next: SecretRow = { ...value };
  if ((key === "ai" || key === "aiBackground" || key === "embedding") && typeof next.apiKey === "string") {
    next.apiKey = fn(next.apiKey);
  }
  if (key === "ai" && next.profiles && typeof next.profiles === "object") {
    next.profiles = Object.fromEntries(
      Object.entries(next.profiles as Record<string, SecretRow | null>).map(([name, profile]) => [
        name,
        profile && typeof profile.apiKey === "string" ? { ...profile, apiKey: fn(profile.apiKey) } : profile,
      ]),
    );
  }
  if (key === "database" && typeof next.password === "string") next.password = fn(next.password);
  return next;
}
