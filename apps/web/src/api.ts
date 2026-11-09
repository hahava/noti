import type {
  AIChatMessage,
  AIChatSource,
  AIStatus,
  AuthSession,
  AuthUser,
  ConnectionTestResult,
  EmbeddingStatus,
  DigestStatus,
  PageDigest,
  WikiConceptDetail,
  WikiConceptListItem,
  WikiOverview,
  ModelListResult,
  SemanticSearchHit,
  WorkspaceSearchResponse,
  PageItem,
  TrashedPageItem,
  PageLinkSummary,
  PageVersionSummary,
  SavedAttachment,
  SaveResult,
  SystemConfig,
  SystemStatus,
  WorkspaceLayoutState,
} from "./vite-env";
import type { CollectionData } from "@noty/shared/collection-types";

const STORAGE_SERVER_HOST_KEY = "noty.serverHost";
const STORAGE_AUTH_TOKEN_KEY = "noty.authToken";
const STORAGE_AUTH_USER_KEY = "noty.authUser";

/**
 * 기본 서버 주소.
 * - VITE_API_BASE_URL 이 있으면 그 값.
 * - 운영 빌드를 웹(http/https)으로 열었으면 지금 주소(같은 서버의 리버스 프록시)를 쓴다.
 * - 그 외(개발, Electron file://)는 로컬 API.
 */
function resolveDefaultServerHost(): string {
  if (import.meta.env.VITE_API_BASE_URL) return import.meta.env.VITE_API_BASE_URL;
  if (import.meta.env.PROD && typeof window !== "undefined" && /^https?:$/.test(window.location.protocol)) {
    return window.location.origin;
  }
  return "http://127.0.0.1:4000";
}

const DEFAULT_SERVER_HOST = resolveDefaultServerHost();

export function normalizeServerHost(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return DEFAULT_SERVER_HOST;
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `http://${trimmed}`;
}

export function getStoredServerHost(): string {
  if (typeof window === "undefined") return DEFAULT_SERVER_HOST;
  const saved = window.localStorage.getItem(STORAGE_SERVER_HOST_KEY);
  return saved ? normalizeServerHost(saved) : DEFAULT_SERVER_HOST;
}

/**
 * 데스크톱 앱이 서버 화면을 띄울 때 넘겨준 로그인 세션을 이 주소의 저장소로 옮긴다.
 * (앱에 묶인 로그인 화면과 서버 화면은 주소가 달라 localStorage 를 같이 쓰지 못한다)
 */
function adoptDesktopSession(): void {
  const session = window.desktop?.takePendingSession?.();
  if (session && session.token && session.user && session.serverHost) {
    saveAuthSession(session);
  }
}

export function getStoredAuthSession(): AuthSession | null {
  if (typeof window === "undefined") return null;
  adoptDesktopSession();
  const rawHost = window.localStorage.getItem(STORAGE_SERVER_HOST_KEY);
  const token = window.localStorage.getItem(STORAGE_AUTH_TOKEN_KEY);
  const rawUser = window.localStorage.getItem(STORAGE_AUTH_USER_KEY);
  if (!rawHost || !token || !rawUser) return null;
  try {
    const user = JSON.parse(rawUser) as AuthUser;
    if (!user || !user.id || !user.username) return null;
    return {
      serverHost: normalizeServerHost(rawHost),
      token,
      user,
    };
  } catch {
    return null;
  }
}

export function saveAuthSession(session: AuthSession): void {
  if (typeof window === "undefined") return;
  const normalizedHost = normalizeServerHost(session.serverHost);
  window.localStorage.setItem(STORAGE_SERVER_HOST_KEY, normalizedHost);
  window.localStorage.setItem(STORAGE_AUTH_TOKEN_KEY, session.token);
  window.localStorage.setItem(STORAGE_AUTH_USER_KEY, JSON.stringify(session.user));
}

export function clearAuthSession(keepServerHost = true): void {
  if (typeof window === "undefined") return;
  if (!keepServerHost) {
    window.localStorage.removeItem(STORAGE_SERVER_HOST_KEY);
  }
  window.localStorage.removeItem(STORAGE_AUTH_TOKEN_KEY);
  window.localStorage.removeItem(STORAGE_AUTH_USER_KEY);
}

export class UnauthorizedApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnauthorizedApiError";
  }
}

async function requestJson<T>(
  url: string,
  init?: RequestInit,
  overrideHost?: string,
  overrideToken?: string,
): Promise<T> {
  const baseHost = overrideHost ? normalizeServerHost(overrideHost) : getStoredServerHost();
  const token =
    overrideToken !== undefined
      ? overrideToken
      : typeof window !== "undefined"
        ? window.localStorage.getItem(STORAGE_AUTH_TOKEN_KEY) || ""
        : "";

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...((init?.headers as Record<string, string>) || {}),
  };

  const response = await fetch(`${baseHost}${url}`, {
    ...init,
    headers,
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    const message = errorBody.error || `API request failed: ${response.status}`;
    if (response.status === 401) {
      throw new UnauthorizedApiError(message);
    }
    throw new Error(message);
  }

  return response.json() as Promise<T>;
}

export type AIChatStreamDone = { provider: string; model: string; truncated: boolean };

/**
 * AI 응답을 스트리밍으로 받는다. 서버는 NDJSON(한 줄에 이벤트 하나)으로 응답한다.
 * signal 로 중단하면 AbortError(name === "AbortError")를 던진다.
 */
async function streamAIChat(
  payload: { messages: AIChatMessage[]; pageTitle?: string; pageContext?: string; useWorkspace?: boolean },
  onDelta: (text: string) => void,
  signal?: AbortSignal,
  onSources?: (sources: AIChatSource[], warning?: string) => void,
): Promise<AIChatStreamDone> {
  const token = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_AUTH_TOKEN_KEY) || "" : "";
  const response = await fetch(`${getStoredServerHost()}/api/ai/chat/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    // 화면 표시용 필드(sources)는 빼고 보낸다.
    body: JSON.stringify({
      ...payload,
      messages: payload.messages.map(({ role, content }) => ({ role, content })),
    }),
    signal,
  });

  if (!response.ok || !response.body) {
    const errorBody = await response.json().catch(() => ({}));
    const message = errorBody.error || `API request failed: ${response.status}`;
    if (response.status === 401) throw new UnauthorizedApiError(message);
    throw new Error(message);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done: AIChatStreamDone | null = null;

  const handleLine = (line: string) => {
    if (!line.trim()) return;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.type === "delta" && typeof event.text === "string") onDelta(event.text);
    else if (event.type === "sources" && Array.isArray(event.sources)) onSources?.(event.sources, event.warning);
    else if (event.type === "done") done = { provider: event.provider, model: event.model, truncated: Boolean(event.truncated) };
    else if (event.type === "error") throw new Error(event.message || "AI 요청에 실패했습니다.");
  };

  try {
    while (true) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        handleLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
    handleLine(buffer + decoder.decode());
  } finally {
    reader.releaseLock();
  }

  if (!done) throw new Error("AI 응답이 중간에 끊겼습니다.");
  return done;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return window.btoa(binary);
}

/**
 * 첨부 파일(/uploads/*)은 로그인한 사용자만 열 수 있다. <img src> 는 헤더를 실을 수 없으므로
 * 서버에서 짧은 기간 유효한 서명 주소를 받아 쓴다. (BlockNote 의 resolveFileUrl 에 연결)
 * 서명 주소는 만료 10분 전까지 재사용해 같은 이미지를 여러 번 요청하지 않는다.
 */
const signedUploadCache = new Map<string, { promise: Promise<string>; expiresAt: number }>();
const SIGNED_URL_REFRESH_MARGIN_MS = 10 * 60 * 1000;

function getUploadPath(url: string): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url, getStoredServerHost());
    const host = new URL(getStoredServerHost());
    const sameServer = url.startsWith("/") || parsed.host === host.host || parsed.host === window.location.host;
    if (!sameServer || !parsed.pathname.startsWith("/uploads/")) return null;
    return parsed.pathname;
  } catch {
    return null;
  }
}

export function resolveUploadUrl(url: string): Promise<string> {
  const uploadPath = getUploadPath(url);
  if (!uploadPath) return Promise.resolve(url);

  const cached = signedUploadCache.get(uploadPath);
  if (cached && cached.expiresAt - SIGNED_URL_REFRESH_MARGIN_MS > Date.now()) return cached.promise;

  const entry = { expiresAt: Date.now() + SIGNED_URL_REFRESH_MARGIN_MS * 2, promise: Promise.resolve(url) };
  entry.promise = requestJson<{ url: string; expiresAt: string }>(`/api/files/sign?url=${encodeURIComponent(uploadPath)}`)
    .then((signed) => {
      entry.expiresAt = Date.parse(signed.expiresAt) || entry.expiresAt;
      return `${getStoredServerHost()}${signed.url}`;
    })
    .catch((error) => {
      signedUploadCache.delete(uploadPath);
      console.warn("[uploads] 서명 주소를 받지 못했습니다:", error);
      return url;
    });
  signedUploadCache.set(uploadPath, entry);
  return entry.promise;
}

export type GraphData = {
  nodes: { id: string; title: string; icon: string | null; kind: "page" | "canvas" }[];
  links: { source: string; target: string }[];
};

export type PagePreview = { title: string; icon: string | null; kind: string; excerpt: string; deleted: boolean };

export interface UserTemplateInput {
  name: string;
  icon: string;
  description: string;
  blocks?: unknown[];
}

export interface UserTemplateRecord extends Required<UserTemplateInput> {
  id: string;
  updatedAt: string;
}

export const workspaceApi = {
  getGraph: () => requestJson<GraphData>("/api/graph"),
  getCanvas: (pageId: string) =>
    requestJson<{ canvas: import("@noty/shared/canvas").CanvasData }>(`/api/pages/${encodeURIComponent(pageId)}/canvas`),
  getPagePreviews: (ids: readonly string[]) =>
    requestJson<{ previews: Record<string, PagePreview> }>(
      `/api/pages/previews?ids=${ids.map(encodeURIComponent).join(",")}`,
    ),

  listCollections: () =>
    requestJson<{ collections: Array<{ id: string; title: string; ownerPageTitle: string }> }>("/api/collections"),

  getCollection: (id: string) =>
    requestJson<{ data: CollectionData }>(`/api/collections/${encodeURIComponent(id)}`),

  ensureCollection: (id: string, ownerPageId: string, initialData: CollectionData) =>
    requestJson<{ data: CollectionData }>("/api/collections", {
      method: "POST",
      body: JSON.stringify({ id, ownerPageId, initialData }),
    }),

  checkServerHealth: async (serverHost: string) => {
    const normalized = normalizeServerHost(serverHost);
    const result = await requestJson<{
      status: string;
      serverName?: string;
      version?: string;
    }>("/api/health", { method: "GET" }, normalized, "");
    return {
      ...result,
      normalizedHost: normalized,
    };
  },

  login: async ({
    serverHost,
    username,
    password,
  }: {
    serverHost: string;
    username: string;
    password: string;
  }): Promise<AuthSession> => {
    const normalized = normalizeServerHost(serverHost);
    const result = await requestJson<{ token: string; user: AuthUser }>(
      "/api/auth/login",
      {
        method: "POST",
        body: JSON.stringify({ username, password }),
      },
      normalized,
      "",
    );
    const session: AuthSession = {
      serverHost: normalized,
      token: result.token,
      user: result.user,
    };
    saveAuthSession(session);
    return session;
  },

  getMe: async (session?: AuthSession): Promise<{ user: AuthUser }> =>
    requestJson<{ user: AuthUser }>(
      "/api/auth/me",
      { method: "GET" },
      session?.serverHost,
      session?.token,
    ),

  logout: async () => {
    try {
      await requestJson<{ ok: boolean }>("/api/auth/logout", { method: "POST" });
    } catch {
      // 서버 연결이 끊긴 상태에서도 로컬 로그아웃은 항상 진행
    } finally {
      clearAuthSession(true);
    }
  },

  listPages: () =>
    requestJson<{
      pages: PageItem[];
      activePageId: string;
      layoutState?: WorkspaceLayoutState;
    }>("/api/pages"),

  listPageVersions: (pageId: string) =>
    requestJson<{ versions: PageVersionSummary[] }>(`/api/pages/${encodeURIComponent(pageId)}/versions`),

  getPageVersion: (pageId: string, versionId: string) =>
    requestJson<{ version: PageVersionSummary & { blocks: unknown[] } }>(
      `/api/pages/${encodeURIComponent(pageId)}/versions/${encodeURIComponent(versionId)}`,
    ),

  /** 지금 본문을 기록으로 남기고, 되돌릴 본문(하위 페이지 구조를 지금에 맞춘 것)을 받는다. */
  restorePageVersion: (pageId: string, versionId: string) =>
    requestJson<{ blocks: unknown[] }>(
      `/api/pages/${encodeURIComponent(pageId)}/versions/${encodeURIComponent(versionId)}/restore`,
      { method: "POST" },
    ),

  saveWorkspaceLayout: (layoutState: WorkspaceLayoutState) =>
    requestJson<{ ok: boolean }>("/api/workspace-layout", {
      method: "PUT",
      body: JSON.stringify(layoutState),
    }),

  createPage: (options?: {
    parentId?: string | null;
    title?: string;
    insertIntoParentBlocks?: boolean;
    kind?: "page" | "canvas";
  }) =>
    requestJson<{ page: PageItem; pages: PageItem[] }>("/api/pages", {
      method: "POST",
      body: JSON.stringify(options ?? {}),
    }),

  updatePage: (payload: {
    id: string;
    title?: string;
    icon?: string | null;
    pageWidth?: string | null;
    parentId?: string | null;
    targetId?: string;
    placement?: "before" | "inside" | "after";
  }) =>
    requestJson<{ pages: PageItem[] }>(`/api/pages/${encodeURIComponent(payload.id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        title: payload.title,
        icon: payload.icon,
        pageWidth: payload.pageWidth,
        parentId: payload.parentId,
        targetId: payload.targetId,
        placement: payload.placement,
      }),
    }),

  listTemplates: () => requestJson<{ templates: UserTemplateRecord[] }>("/api/templates"),

  createTemplate: (input: UserTemplateInput) =>
    requestJson<{ template: UserTemplateRecord }>("/api/templates", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /** blocks 를 빼면 이름·아이콘·설명만 바뀐다 */
  updateTemplate: (id: string, input: UserTemplateInput) =>
    requestJson<{ template: UserTemplateRecord }>(`/api/templates/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),

  deleteTemplate: (id: string) =>
    requestJson<{ ok: true }>(`/api/templates/${encodeURIComponent(id)}`, { method: "DELETE" }),

  deletePage: (id: string) =>
    requestJson<{ pages: PageItem[]; nextActivePageId: string }>(
      `/api/pages/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    ),

  listTrash: () =>
    requestJson<{ pages: TrashedPageItem[] }>("/api/trash"),

  restorePage: (id: string) =>
    requestJson<{ pages: PageItem[] }>(`/api/trash/${encodeURIComponent(id)}/restore`, {
      method: "POST",
    }),

  reorderChildPages: (parentId: string, orderedIds: string[]) =>
    requestJson<{ pages: PageItem[] }>(
      `/api/pages/${encodeURIComponent(parentId)}/children-order`,
      {
        method: "PUT",
        body: JSON.stringify({ orderedIds }),
      },
    ),

  deletePages: (ids: string[]) =>
    requestJson<{ pages: PageItem[]; nextActivePageId: string }>(
      "/api/pages/batch-delete",
      {
        method: "POST",
        body: JSON.stringify({ ids }),
      },
    ),

  loadDocument: (id = "welcome") =>
    requestJson<{
      blocks: unknown[] | null;
      path: string;
      backlinks: PageLinkSummary[];
    }>(`/api/pages/${encodeURIComponent(id)}/document`),

  saveDocument: (
    blocks: readonly unknown[],
    options?: { id?: string; title?: string },
  ) => {
    const id = options?.id || "welcome";
    return requestJson<SaveResult>(
      `/api/pages/${encodeURIComponent(id)}/document`,
      {
        method: "PUT",
        body: JSON.stringify({
          blocks,
          title: options?.title,
        }),
      },
    );
  },

  saveAttachment: async ({
    name,
    type,
    bytes,
  }: {
    name: string;
    type: string;
    bytes: Uint8Array;
  }): Promise<SavedAttachment> => {
    const baseHost = getStoredServerHost();
    const result = await requestJson<SavedAttachment>("/api/attachments", {
      method: "POST",
      body: JSON.stringify({
        name,
        type,
        base64: uint8ArrayToBase64(bytes),
      }),
    });
    return {
      ...result,
      url: result.url.startsWith("http") ? result.url : `${baseHost}${result.url}`,
    };
  },

  getAIStatus: () => requestJson<AIStatus>("/api/ai/status"),

  chatWithAI: (payload: { messages: AIChatMessage[]; pageTitle?: string; pageContext?: string }) =>
    requestJson<{ reply: string; provider: string; model: string }>("/api/ai/chat", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  streamChatWithAI: streamAIChat,

  getPageDigest: (pageId: string) =>
    requestJson<{
      digest: PageDigest | null;
      stale: boolean;
      concepts: Array<{ id: string; name: string; pageCount: number }>;
    }>(`/api/pages/${encodeURIComponent(pageId)}/digest`),

  getWikiOverview: () => requestJson<WikiOverview>("/api/wiki/overview"),

  findWikiConcepts: (query = "", limit = 20) =>
    requestJson<{ concepts: WikiConceptListItem[] }>(
      `/api/wiki/concepts?q=${encodeURIComponent(query)}&limit=${limit}`,
    ),

  getWikiConcept: (conceptId: string) =>
    requestJson<WikiConceptDetail>(`/api/wiki/concepts/${encodeURIComponent(conceptId)}`),

  searchWorkspace: (query: string, limit = 20, signal?: AbortSignal) =>
    requestJson<WorkspaceSearchResponse>(`/api/search?q=${encodeURIComponent(query)}&limit=${limit}`, { signal }),

  semanticSearch: (query: string, limit = 10) =>
    requestJson<{ results: SemanticSearchHit[] }>(
      `/api/search/semantic?q=${encodeURIComponent(query)}&limit=${limit}`,
    ),
};
