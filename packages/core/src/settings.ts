import { access, constants, mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import Redis from "ioredis";
import pg from "pg";
import { DATABASE_URL, pool } from "./db.js";
import { DEFAULT_UPLOADS_DIR } from "./paths.js";

const { Pool } = pg;



/* ==========================================================================
 * 시스템 관리자 설정 (System Admin Configurations & Distributed Coordination)
 * ========================================================================== */

export interface AISystemSettings {
  provider: "openai" | "ollama" | "gemini" | "anthropic" | "custom";
  model: string;
  apiKey: string;
  baseUrl: string;
  temperature: number;
  embeddingModel: string;
  /** 프로바이더별로 마지막으로 사용한 모델/키/엔드포인트 (프로바이더 전환 시 복원용) */
  profiles?: Partial<Record<AISystemSettings["provider"], AIProviderProfile>>;
}

export interface AIProviderProfile {
  model: string;
  apiKey: string;
  baseUrl: string;
}

/** 임베딩(벡터 검색) 설정. 채팅 프로바이더와 별개로 지정한다 (Claude 는 임베딩 API 가 없음). */
export interface EmbeddingSystemSettings {
  enabled: boolean;
  provider: "ollama" | "openai" | "gemini" | "custom";
  model: string;
  baseUrl: string;
  apiKey: string;
}

/**
 * 백그라운드 작업용 LLM (LLM 위키 정리본 생성 등 페이지마다 호출하는 작업).
 * 채팅용과 분리해서 비용이 적은 모델(예: 로컬 Ollama)을 쓸 수 있게 한다.
 * mode = "same" 이면 채팅 설정을 그대로 쓴다.
 */
export interface BackgroundAISettings {
  mode: "same" | "custom";
  /** LLM 위키 페이지 정리본 자동 생성 (호출 비용이 있어 기본은 꺼짐) */
  digestEnabled: boolean;
  provider: AISystemSettings["provider"];
  model: string;
  baseUrl: string;
  apiKey: string;
}

export interface StorageSystemSettings {
  provider: "local" | "s3";
  localPath: string;
  maxFileSizeMb: number;
  s3Bucket?: string;
  s3Region?: string;
  s3Endpoint?: string;
}

export interface RedisSystemSettings {
  url: string;
  prefix: string;
  enabled: boolean;
}

export interface DatabaseSystemSettings {
  host: string;
  port: number;
  database: string;
  user: string;
  password?: string;
  ssl: boolean;
}

export interface DistributedSystemSettings {
  clusterMode: "single" | "distributed";
  syncMethod: "redis_pubsub" | "polling";
  nodeId: string;
  sharedStoragePath?: string;
}

export interface SystemConfig {
  ai: AISystemSettings;
  aiBackground: BackgroundAISettings;
  embedding: EmbeddingSystemSettings;
  storage: StorageSystemSettings;
  redis: RedisSystemSettings;
  database: DatabaseSystemSettings;
  distributed: DistributedSystemSettings;
  updatedAt?: string;
  updatedBy?: string;
}

function parsePostgresUrl(connStr: string) {
  try {
    const u = new URL(connStr);
    return {
      host: u.hostname || "127.0.0.1",
      port: Number(u.port || 5432),
      database: u.pathname.replace(/^\//, "") || "notion_like",
      user: decodeURIComponent(u.username || "notion"),
      password: decodeURIComponent(u.password || ""),
      ssl: u.searchParams.get("sslmode") === "require" || u.searchParams.get("ssl") === "true",
    };
  } catch {
    return {
      host: process.env.POSTGRES_HOST || "127.0.0.1",
      port: Number(process.env.POSTGRES_PORT || 5434),
      database: process.env.POSTGRES_DB || "notion_like",
      user: process.env.POSTGRES_USER || "notion",
      password: process.env.POSTGRES_PASSWORD || "notion",
      ssl: false,
    };
  }
}

export function getDefaultSystemConfig(): SystemConfig {
  const parsedDb = parsePostgresUrl(DATABASE_URL);
  const defaultUploads = DEFAULT_UPLOADS_DIR;

  return {
    ai: {
      provider: (process.env.AI_PROVIDER as any) || "openai",
      model: process.env.AI_MODEL || "gpt-4o",
      apiKey: process.env.OPENAI_API_KEY || process.env.AI_API_KEY || "",
      baseUrl: process.env.AI_BASE_URL || "https://api.openai.com/v1",
      temperature: Number(process.env.AI_TEMPERATURE || 0.7),
      embeddingModel: process.env.AI_EMBEDDING_MODEL || "text-embedding-3-small",
    },
    aiBackground: {
      mode: process.env.AI_BACKGROUND_PROVIDER ? "custom" : "same",
      digestEnabled: process.env.AI_DIGEST_ENABLED === "true",
      provider: (process.env.AI_BACKGROUND_PROVIDER as AISystemSettings["provider"]) || "ollama",
      model: process.env.AI_BACKGROUND_MODEL || "qwen3:8b",
      baseUrl: process.env.AI_BACKGROUND_BASE_URL || "http://127.0.0.1:11434",
      apiKey: process.env.AI_BACKGROUND_API_KEY || "",
    },
    embedding: {
      enabled: process.env.EMBEDDING_ENABLED === "true",
      provider: (process.env.EMBEDDING_PROVIDER as EmbeddingSystemSettings["provider"]) || "ollama",
      model: process.env.EMBEDDING_MODEL || "bge-m3",
      baseUrl: process.env.EMBEDDING_BASE_URL || "http://127.0.0.1:11434",
      apiKey: process.env.EMBEDDING_API_KEY || "",
    },
    storage: {
      provider: (process.env.STORAGE_PROVIDER as any) || "local",
      localPath: defaultUploads,
      maxFileSizeMb: Number(process.env.MAX_FILE_SIZE_MB || 30),
      s3Bucket: process.env.S3_BUCKET || "",
      s3Region: process.env.S3_REGION || "ap-northeast-2",
      s3Endpoint: process.env.S3_ENDPOINT || "",
    },
    redis: {
      url: process.env.REDIS_URL || "redis://127.0.0.1:6380",
      prefix: process.env.COLLAB_REDIS_PREFIX || "noty:collaboration",
      enabled: Boolean(process.env.REDIS_URL),
    },
    database: {
      host: parsedDb.host,
      port: parsedDb.port,
      database: parsedDb.database,
      user: parsedDb.user,
      password: parsedDb.password,
      ssl: parsedDb.ssl,
    },
    distributed: {
      clusterMode: (process.env.COLLAB_MODE as any) || (process.env.REDIS_URL ? "distributed" : "single"),
      syncMethod: "redis_pubsub",
      nodeId: process.env.COLLAB_INSTANCE_NAME || `noty-node-${process.pid}`,
      sharedStoragePath: process.env.SHARED_STORAGE_PATH || "",
    },
  };
}

function maskSecret(secret?: string): string {
  if (!secret) return "";
  if (secret.length <= 8) return "********";
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

function isMaskedSecret(value: string | undefined): boolean {
  return Boolean(value) && (value!.includes("...") || /^\*+$/.test(value!));
}

/** 백그라운드 작업에 실제로 쓸 LLM 설정 (mode = "same" 이면 채팅 설정) */
export function resolveBackgroundAISettings(config: SystemConfig): AISystemSettings {
  if (config.aiBackground.mode !== "custom") return config.ai;
  const { provider, model, baseUrl, apiKey } = config.aiBackground;
  return { ...config.ai, provider, model, baseUrl, apiKey, profiles: undefined };
}

/**
 * 연결 테스트/모델 목록 조회 때 클라이언트가 보낸 마스킹된 키를 저장된 실제 키로 되돌린다.
 * target 에 따라 어느 설정의 키를 볼지 정한다.
 */
export async function resolveMaskedKeyFor(
  target: "chat" | "background" | "embedding",
  value: string | undefined,
): Promise<string> {
  if (!isMaskedSecret(value)) return value ?? "";
  if (target === "chat") return resolveMaskedAIKey(value);
  const current = await getSystemSettingsFromDb(false);
  const stored = target === "embedding" ? current.embedding.apiKey : current.aiBackground.apiKey;
  return maskSecret(stored) === value ? stored : "";
}

/** 클라이언트가 보낸 마스킹된 AI 키를 저장된 실제 키로 되돌린다 (연결 테스트용). */
export async function resolveMaskedAIKey(value: string | undefined): Promise<string> {
  if (!value || (!value.includes("...") && !/^\*+$/.test(value))) return value ?? "";
  const current = await getSystemSettingsFromDb(false);
  const candidates = [
    current.ai.apiKey,
    ...Object.values(current.ai.profiles ?? {}).map((profile) => profile?.apiKey || ""),
  ].filter(Boolean);
  return candidates.find((key) => maskSecret(key) === value) ?? "";
}

export async function getSystemSettingsFromDb(maskSecrets = true): Promise<SystemConfig> {
  const defaults = getDefaultSystemConfig();
  try {
    const res = await pool.query("SELECT key, value, updated_at, updated_by FROM system_settings");
    const map = new Map<string, { value: any; updatedAt: string; updatedBy?: string }>();
    for (const row of res.rows) {
      map.set(String(row.key), {
        value: row.value,
        updatedAt: new Date(row.updated_at).toISOString(),
        updatedBy: row.updated_by ? String(row.updated_by) : undefined,
      });
    }

    const aiRow = map.get("ai");
    const embeddingRow = map.get("embedding");
    const aiBackgroundRow = map.get("aiBackground");
    const storageRow = map.get("storage");
    const redisRow = map.get("redis");
    const dbRow = map.get("database");
    const distRow = map.get("distributed");

    const merged: SystemConfig = {
      ai: { ...defaults.ai, ...(aiRow?.value || {}) },
      aiBackground: { ...defaults.aiBackground, ...(aiBackgroundRow?.value || {}) },
      embedding: { ...defaults.embedding, ...(embeddingRow?.value || {}) },
      storage: { ...defaults.storage, ...(storageRow?.value || {}) },
      redis: { ...defaults.redis, ...(redisRow?.value || {}) },
      database: { ...defaults.database, ...(dbRow?.value || {}) },
      distributed: { ...defaults.distributed, ...(distRow?.value || {}) },
      updatedAt: aiRow?.updatedAt || storageRow?.updatedAt || redisRow?.updatedAt,
      updatedBy: aiRow?.updatedBy || storageRow?.updatedBy,
    };

    if (maskSecrets) {
      return {
        ...merged,
        ai: {
          ...merged.ai,
          apiKey: maskSecret(merged.ai.apiKey),
          profiles: merged.ai.profiles
            ? Object.fromEntries(
                Object.entries(merged.ai.profiles).map(([key, profile]) => [
                  key,
                  profile ? { ...profile, apiKey: maskSecret(profile.apiKey) } : profile,
                ]),
              )
            : undefined,
        },
        embedding: { ...merged.embedding, apiKey: maskSecret(merged.embedding.apiKey) },
        aiBackground: { ...merged.aiBackground, apiKey: maskSecret(merged.aiBackground.apiKey) },
        database: {
          ...merged.database,
          password: maskSecret(merged.database.password),
        },
      };
    }

    return merged;
  } catch (error) {
    console.warn("[SystemSettings] Failed to fetch system_settings from DB, using defaults:", error);
    return defaults;
  }
}

export async function saveSystemSettingsToDb(
  updates: Partial<SystemConfig>,
  userId: string,
): Promise<SystemConfig> {
  const current = await getSystemSettingsFromDb(false);
  const now = new Date();

  // 패스워드/API키가 마스킹(***) 상태로 전달되었을 경우 기존 값 유지
  const cleanUpdates = { ...updates };
  if (cleanUpdates.ai) {
    // 마스킹된 키(예: "sk-a...wxyz", "********")는 같은 마스크를 만드는 기존 실제 키로 되돌린다.
    const knownKeys = [
      current.ai.apiKey,
      ...Object.values(current.ai.profiles ?? {}).map((profile) => profile?.apiKey || ""),
    ].filter(Boolean);
    const restoreMasked = (value: string | undefined, fallback: string): string => {
      if (!value) return value ?? "";
      if (!value.includes("...") && !/^\*+$/.test(value)) return value;
      return knownKeys.find((key) => maskSecret(key) === value) ?? fallback;
    };
    cleanUpdates.ai = { ...cleanUpdates.ai };
    if (cleanUpdates.ai.apiKey !== undefined) {
      cleanUpdates.ai.apiKey = restoreMasked(cleanUpdates.ai.apiKey, current.ai.apiKey);
    }
    if (cleanUpdates.ai.profiles) {
      cleanUpdates.ai.profiles = Object.fromEntries(
        Object.entries(cleanUpdates.ai.profiles).map(([key, profile]) => [
          key,
          profile
            ? {
                ...profile,
                apiKey: restoreMasked(
                  profile.apiKey,
                  current.ai.profiles?.[key as AISystemSettings["provider"]]?.apiKey ?? "",
                ),
              }
            : profile,
        ]),
      );
    }
  }
  if (cleanUpdates.embedding) {
    cleanUpdates.embedding = { ...cleanUpdates.embedding };
    if (isMaskedSecret(cleanUpdates.embedding.apiKey)) cleanUpdates.embedding.apiKey = current.embedding.apiKey;
  }
  if (cleanUpdates.aiBackground) {
    cleanUpdates.aiBackground = { ...cleanUpdates.aiBackground };
    if (isMaskedSecret(cleanUpdates.aiBackground.apiKey)) cleanUpdates.aiBackground.apiKey = current.aiBackground.apiKey;
  }
  if (cleanUpdates.database?.password && cleanUpdates.database.password.includes("...")) {
    cleanUpdates.database.password = current.database.password;
  }

  const entries: [string, any][] = [];
  if (cleanUpdates.ai) entries.push(["ai", { ...current.ai, ...cleanUpdates.ai }]);
  if (cleanUpdates.embedding) entries.push(["embedding", { ...current.embedding, ...cleanUpdates.embedding }]);
  if (cleanUpdates.aiBackground) entries.push(["aiBackground", { ...current.aiBackground, ...cleanUpdates.aiBackground }]);
  if (cleanUpdates.storage) entries.push(["storage", { ...current.storage, ...cleanUpdates.storage }]);
  if (cleanUpdates.redis) entries.push(["redis", { ...current.redis, ...cleanUpdates.redis }]);
  if (cleanUpdates.database) entries.push(["database", { ...current.database, ...cleanUpdates.database }]);
  if (cleanUpdates.distributed) entries.push(["distributed", { ...current.distributed, ...cleanUpdates.distributed }]);

  for (const [key, val] of entries) {
    await pool.query(
      `INSERT INTO system_settings (key, value, updated_at, updated_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value,
             updated_at = EXCLUDED.updated_at,
             updated_by = EXCLUDED.updated_by`,
      [key, JSON.stringify(val), now, userId],
    );
  }

  return getSystemSettingsFromDb(true);
}

export async function getEffectiveUploadsDir(): Promise<string> {
  const config = await getSystemSettingsFromDb(false);
  const target = path.resolve(config.storage.localPath || DEFAULT_UPLOADS_DIR);
  try {
    await mkdir(target, { recursive: true });
  } catch {
    // ignore
  }
  return target;
}

export async function testDatabaseConnection(params: {
  host: string;
  port: number;
  database: string;
  user: string;
  password?: string;
  ssl?: boolean;
}): Promise<{ ok: boolean; message: string; version?: string; hasPgVector?: boolean; latencyMs?: number }> {
  const start = Date.now();
  const testPool = new Pool({
    host: params.host,
    port: params.port,
    database: params.database,
    user: params.user,
    password: params.password,
    ssl: params.ssl ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 3500,
  });

  try {
    const res = await testPool.query(
      "SELECT version(), (SELECT count(*) FROM pg_extension WHERE extname = 'vector') as has_vector",
    );
    const latencyMs = Date.now() - start;
    const row = res.rows[0];
    const versionStr = String(row?.version || "PostgreSQL");
    const hasVector = Number(row?.has_vector || 0) > 0;

    return {
      ok: true,
      message: `성공적으로 연결되었습니다 (${latencyMs}ms). pgvector: ${hasVector ? "설치됨" : "미설치"}`,
      version: versionStr.split(" on ")[0],
      hasPgVector: hasVector,
      latencyMs,
    };
  } catch (error: any) {
    return {
      ok: false,
      message: `연결 실패: ${error.message || String(error)}`,
    };
  } finally {
    await testPool.end().catch(() => undefined);
  }
}

export async function testRedisConnection(
  redisUrl: string,
): Promise<{ ok: boolean; message: string; latencyMs?: number }> {
  const start = Date.now();
  let client: Redis | null = null;
  try {
    client = new Redis(redisUrl, {
      connectTimeout: 3000,
      maxRetriesPerRequest: 1,
      lazyConnect: true,
    });
    await client.connect();
    const pong = await client.ping();
    const latencyMs = Date.now() - start;
    if (pong === "PONG") {
      return {
        ok: true,
        message: `Redis PING 성공 (${latencyMs}ms)`,
        latencyMs,
      };
    }
    return {
      ok: true,
      message: `Redis 응답 수신: ${pong} (${latencyMs}ms)`,
      latencyMs,
    };
  } catch (error: any) {
    return {
      ok: false,
      message: `Redis 연결 실패: ${error.message || String(error)}`,
    };
  } finally {
    if (client) {
      client.disconnect();
    }
  }
}

export async function testStorageDirectory(
  dirPath: string,
): Promise<{ ok: boolean; message: string; absolutePath: string; writable?: boolean }> {
  try {
    const abs = path.resolve(dirPath);
    await mkdir(abs, { recursive: true });
    await access(abs, constants.R_OK | constants.W_OK);

    const testFile = path.join(abs, `.noty-write-test-${Date.now()}.tmp`);
    await writeFile(testFile, "test-write");
    await unlink(testFile);

    return {
      ok: true,
      message: "디렉터리 접근 및 쓰기 테스트를 성공했습니다.",
      absolutePath: abs,
      writable: true,
    };
  } catch (error: any) {
    return {
      ok: false,
      message: `디렉터리 접근 실패: ${error.message || String(error)}`,
      absolutePath: path.resolve(dirPath),
      writable: false,
    };
  }
}

export async function testAIConnection(
  aiConfig: AISystemSettings,
): Promise<{ ok: boolean; message: string; latencyMs?: number }> {
  const start = Date.now();
  const provider = aiConfig.provider;
  const baseUrl = (aiConfig.baseUrl || "").replace(/\/+$/, "");

  try {
    if (provider === "ollama") {
      const url = `${baseUrl || "http://127.0.0.1:11434"}/api/tags`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      const latencyMs = Date.now() - start;
      if (res.ok) {
        const data = await res.json() as { models?: Array<{ name: string }> };
        const modelNames = data.models?.map((m) => m.name).slice(0, 3).join(", ") || "모델 없음";
        return {
          ok: true,
          message: `Ollama 연결 성공 (${latencyMs}ms). 로컬 모델: ${modelNames}`,
          latencyMs,
        };
      }
      return {
        ok: false,
        message: `Ollama 응답 오류 (HTTP ${res.status}): ${res.statusText}`,
      };
    }

    if (provider === "openai" || provider === "custom") {
      const url = `${baseUrl || "https://api.openai.com/v1"}/models`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4500);
      const headers: Record<string, string> = {};
      if (aiConfig.apiKey && !aiConfig.apiKey.includes("...")) {
        headers.Authorization = `Bearer ${aiConfig.apiKey}`;
      }
      const res = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timer);
      const latencyMs = Date.now() - start;
      if (res.ok) {
        return {
          ok: true,
          message: `API 엔드포인트 연결 성공 (${latencyMs}ms). 모델 '${aiConfig.model}' 사용 준비 완료.`,
          latencyMs,
        };
      }
      if (res.status === 401) {
        return {
          ok: false,
          message: "API Key 인증 실패 (401 Unauthorized). 올바른 API 키를 입력해 주세요.",
        };
      }
      return {
        ok: false,
        message: `API 응답 오류 (HTTP ${res.status}): ${res.statusText}`,
      };
    }

    if (provider === "anthropic") {
      const url = `${baseUrl || "https://api.anthropic.com"}/v1/models`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4500);
      const res = await fetch(url, {
        headers: { "x-api-key": aiConfig.apiKey || "", "anthropic-version": "2023-06-01" },
        signal: controller.signal,
      });
      clearTimeout(timer);
      const latencyMs = Date.now() - start;
      if (res.ok) {
        return {
          ok: true,
          message: `Claude API 연결 성공 (${latencyMs}ms). 모델 '${aiConfig.model}' 사용 준비 완료.`,
          latencyMs,
        };
      }
      if (res.status === 401) {
        return { ok: false, message: "Claude API Key 인증 실패 (401). 올바른 API 키를 입력해 주세요." };
      }
      return { ok: false, message: `Claude API 응답 오류 (HTTP ${res.status}): ${res.statusText}` };
    }

    // gemini: 모델 목록을 실제로 조회해서 키와 모델명을 확인한다.
    const { listModels } = await import("./ai-models.js");
    const result = await listModels({ provider: "gemini", baseUrl, apiKey: aiConfig.apiKey }, "chat");
    const latencyMs = Date.now() - start;
    if (result.models.length === 0) return { ok: false, message: result.message || "Gemini 모델 목록을 가져오지 못했습니다." };
    const found = result.models.some((model) => model.id === aiConfig.model);
    return {
      ok: found,
      message: found
        ? `Gemini 연결 성공 (${latencyMs}ms). 모델 '${aiConfig.model}' 사용 준비 완료.`
        : `Gemini 연결은 됐지만 '${aiConfig.model}' 모델을 찾을 수 없습니다.`,
      latencyMs,
    };
  } catch (error: any) {
    return {
      ok: false,
      message: `AI 연결 실패: ${error.message || String(error)}`,
    };
  }
}
