/* 어드민 API 클라이언트 (같은 출처의 /api — 개발 중에는 Vite 가 어드민 서버로 넘긴다) */

export type UserRole = "admin" | "editor" | "viewer";
export type Vendor = "openai" | "anthropic" | "ollama" | "gemini" | "custom";
export type EmbeddingVendor = "ollama" | "openai" | "gemini" | "custom";

export interface AdminUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
}

export interface ManagedUser extends AdminUser {
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  activeSessions: number;
  pageCount: number;
}

export interface ChatSettings {
  provider: Vendor;
  model: string;
  apiKey: string;
  baseUrl: string;
  temperature: number;
  embeddingModel: string;
  profiles?: Partial<Record<Vendor, { model: string; apiKey: string; baseUrl: string }>>;
}

export interface BackgroundSettings {
  mode: "same" | "custom";
  digestEnabled: boolean;
  provider: Vendor;
  model: string;
  baseUrl: string;
  apiKey: string;
}

export interface EmbeddingSettings {
  enabled: boolean;
  provider: EmbeddingVendor;
  model: string;
  baseUrl: string;
  apiKey: string;
}

export interface SystemConfig {
  ai: ChatSettings;
  aiBackground: BackgroundSettings;
  embedding: EmbeddingSettings;
  storage: { provider: "local" | "s3"; localPath: string; maxFileSizeMb: number; s3Bucket?: string; s3Region?: string; s3Endpoint?: string };
  redis: { url: string; prefix: string; enabled: boolean };
  database: { host: string; port: number; database: string; user: string; password?: string; ssl: boolean };
  distributed: { clusterMode: "single" | "distributed"; syncMethod: string; nodeId: string; sharedStoragePath?: string };
  updatedAt?: string;
  updatedBy?: string;
}

export interface TestResult {
  ok: boolean;
  message: string;
}

export interface ModelInfo {
  id: string;
  label?: string;
  detail?: string;
}

export interface AdminStatus {
  indexing: {
    enabled: boolean;
    model: string;
    dims: number | null;
    totalPages: number;
    indexedPages: number;
    textIndexedPages: number;
    keywordEngine: "pgroonga" | "basic";
    failedPages: number;
    chunkCount: number;
    attachments: { done: number; pending: number; empty: number; unsupported: number; failed: number };
    lastError: string | null;
  };
  digests: {
    enabled: boolean;
    model: string;
    totalPages: number;
    done: number;
    skipped: number;
    failed: number;
    concepts: number;
    conceptArticles: number;
    multiPageConcepts: number;
    lastError: string | null;
  };
  database: { version: string; size: string };
  admin: { nodeVersion: string; uptimeSeconds: number; port: number; host: string };
}

const TOKEN_KEY = "noty.admin.token";

export function getToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // 저장소를 못 쓰면 이번 탭에서만 로그인 유지
  }
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** 401 이 오면 로그인 화면으로 돌아가도록 App 이 등록한다. */
let onUnauthorized: () => void = () => undefined;
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !path.endsWith("/auth/login")) onUnauthorized();
    throw new ApiError(res.status, data.error || `요청 실패 (${res.status})`);
  }
  return data as T;
}

const json = (body: unknown) => JSON.stringify(body);

/* ---- 설치 마법사 ---- */

export interface SetupEnvironment {
  docker: { available: boolean; version: string; gpu: boolean; os: string; error: string };
  ollama: { found: boolean; url: string; version?: string };
  ports: Record<string, boolean>;
  appImage: string;
  pending: boolean;
}

export interface SetupPlan {
  database: { mode: "docker"; port: number } | { mode: "external"; url: string };
  ollama: { mode: "docker"; gpu: boolean } | { mode: "external"; url: string } | { mode: "none" };
  models: { chat: string; embedding: string; pull: boolean };
  services: { mode: "docker" | "manual"; bind: "local" | "network"; apiPort: number; collabPort: number; publicUrl?: string };
  admin: { username: string; password: string; displayName?: string };
}

export type SetupStepStatus = "pending" | "running" | "done" | "skipped" | "failed";
export interface SetupJob {
  status: "running" | "done" | "failed";
  steps: { key: string; label: string; status: SetupStepStatus; detail?: string }[];
  log: string[];
  error?: string;
  manualEnv?: string;
  appUrl?: string;
}

let setupCode = "";
export function setSetupCode(code: string): void {
  setupCode = code.trim().toUpperCase();
}
const setupRequest = <T,>(path: string, init: RequestInit = {}) =>
  request<T>(path, { ...init, headers: { "X-Setup-Code": setupCode, ...(init.headers as Record<string, string> | undefined) } });

export const setupApi = {
  status: () => request<{ setupRequired: boolean; job: SetupJob | null }>("/api/setup/status"),
  verify: () => setupRequest<{ ok: true }>("/api/setup/verify", { method: "POST" }),
  environment: () => setupRequest<SetupEnvironment>("/api/setup/environment"),
  testDatabase: (url: string) =>
    setupRequest<{ ok: boolean; message: string; warnings: string[] }>("/api/setup/test-database", { method: "POST", body: json({ url }) }),
  testOllama: (url: string) =>
    setupRequest<{ ok: boolean; message: string; chatModels: string[]; embeddingModels: string[] }>("/api/setup/test-ollama", {
      method: "POST",
      body: json({ url }),
    }),
  install: (plan: SetupPlan) => setupRequest<{ job: SetupJob }>("/api/setup/install", { method: "POST", body: json(plan) }),
  job: () => setupRequest<{ job: SetupJob | null; setupRequired: boolean }>("/api/setup/job"),
};

export const adminApi = {
  login: (username: string, password: string) =>
    request<{ token: string; user: AdminUser }>("/api/auth/login", { method: "POST", body: json({ username, password }) }),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),
  me: () => request<{ user: AdminUser }>("/api/auth/me"),

  listUsers: () => request<{ users: ManagedUser[] }>("/api/users"),
  createUser: (input: { username: string; displayName: string; password: string; role: UserRole }) =>
    request<{ user: AdminUser }>("/api/users", { method: "POST", body: json(input) }),
  updateUser: (id: string, patch: { displayName?: string; role?: UserRole; disabled?: boolean }) =>
    request<{ user: AdminUser }>(`/api/users/${encodeURIComponent(id)}`, { method: "PATCH", body: json(patch) }),
  resetPassword: (id: string, password: string) =>
    request<{ ok: true }>(`/api/users/${encodeURIComponent(id)}/password`, { method: "POST", body: json({ password }) }),
  revokeSessions: (id: string) =>
    request<{ revoked: number }>(`/api/users/${encodeURIComponent(id)}/revoke-sessions`, { method: "POST" }),
  deleteUser: (id: string, transferTo: string) =>
    request<{ transferredPages: number }>(
      `/api/users/${encodeURIComponent(id)}?transferTo=${encodeURIComponent(transferTo)}`,
      { method: "DELETE" },
    ),

  getSettings: () => request<{ config: SystemConfig }>("/api/settings"),
  saveSettings: (config: Partial<SystemConfig>) =>
    request<{ config: SystemConfig }>("/api/settings", { method: "PUT", body: json({ config }) }),
  test: (payload: Record<string, unknown>) => request<TestResult>("/api/settings/test", { method: "POST", body: json(payload) }),
  listModels: (payload: { target: "chat" | "background" | "embedding"; provider: string; baseUrl?: string; apiKey?: string }) =>
    request<{ models: ModelInfo[]; message?: string }>("/api/models", { method: "POST", body: json(payload) }),

  status: () => request<AdminStatus>("/api/status"),
  reindex: () => request<unknown>("/api/indexing/reindex", { method: "POST" }),
  regenerateDigests: () => request<unknown>("/api/digests/regenerate", { method: "POST" }),
};
