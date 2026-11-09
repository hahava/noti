/// <reference types="vite/client" />

export type AuthUser = {
  id: string;
  username: string;
  displayName: string;
  /** admin: 관리자, editor: 편집자, viewer: 읽기 전용 */
  role: "admin" | "editor" | "viewer";
};

export type AIProvider = "openai" | "ollama" | "gemini" | "anthropic" | "custom";

export type AIProviderProfile = {
  model: string;
  apiKey: string;
  baseUrl: string;
};

export type AISystemSettings = {
  provider: AIProvider;
  model: string;
  apiKey: string;
  baseUrl: string;
  temperature: number;
  embeddingModel: string;
  profiles?: Partial<Record<AIProvider, AIProviderProfile>>;
};

/** 워크스페이스 참고 답변의 출처 (답변 본문의 [n] 과 연결) */
export type AIChatSource = {
  n: number;
  pageId: string;
  pageTitle: string;
  /** "제목 > 헤딩" 또는 "제목 > 📎 파일명 (3쪽)" */
  context: string;
  blockId: string | null;
  attachmentName: string | null;
};

export type AIChatMessage = {
  role: "user" | "assistant";
  content: string;
  /** 화면 표시용 (서버로 보낼 때는 제외) */
  sources?: AIChatSource[];
};

export type AIStatus = {
  provider: AIProvider;
  model: string;
  configured: boolean;
};

export type EmbeddingProvider = "ollama" | "openai" | "gemini" | "custom";

/** 백그라운드 작업(LLM 위키 정리 등)용 모델. mode = "same" 이면 채팅 설정을 그대로 쓴다. */
export type BackgroundAISettings = {
  mode: "same" | "custom";
  digestEnabled: boolean;
  provider: AIProvider;
  model: string;
  baseUrl: string;
  apiKey: string;
};

/** LLM 위키 페이지 정리본 */
export type PageDigest = {
  pageId: string;
  status: "done" | "skipped" | "failed";
  model: string;
  summary: string;
  keyPoints: string[];
  concepts: Array<{ name: string; description: string }>;
  decisions: string[];
  actionItems: string[];
  openQuestions: string[];
  truncated: boolean;
  error: string | null;
  generatedAt: string;
};

/** LLM 위키 개념 */
export type WikiConceptListItem = {
  id: string;
  name: string;
  pageCount: number;
  summary: string | null;
};

export type WikiConceptDetail = WikiConceptListItem & {
  article: {
    summary: string;
    points: Array<{ text: string; pageIds: string[] }>;
    conflicts: Array<{ text: string; pageIds: string[] }>;
  } | null;
  stale: boolean;
  articleGeneratedAt: string | null;
  mentions: Array<{ pageId: string; pageTitle: string; description: string }>;
};

export type WikiOverview = {
  conflicts: Array<{
    conceptId: string;
    conceptName: string;
    text: string;
    pages: Array<{ pageId: string; pageTitle: string }>;
  }>;
  concepts: WikiConceptListItem[];
  actionItems: Array<{ text: string; pageId: string; pageTitle: string }>;
  stats: { pagesWithDigest: number; concepts: number; conceptArticles: number };
};

export type DigestStatus = {
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
  lastGeneratedAt: string | null;
  pausedUntil: string | null;
};

export type ModelInfo = {
  id: string;
  label?: string;
  detail?: string;
};

export type ModelListResult = {
  models: ModelInfo[];
  message?: string;
};

export type EmbeddingSystemSettings = {
  enabled: boolean;
  provider: EmbeddingProvider;
  model: string;
  baseUrl: string;
  apiKey: string;
};

export type EmbeddingStatus = {
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
  lastIndexedAt: string | null;
  pausedUntil: string | null;
};

export type SemanticSearchHit = {
  pageId: string;
  pageTitle: string;
  blockId: string | null;
  kind: "chunk" | "file";
  attachmentId: string | null;
  attachmentName: string | null;
  content: string;
  score: number;
};

export type WorkspaceSearchResult = {
  pageId: string;
  pageTitle: string;
  pageIcon: string | null;
  /** "제목 > 헤딩" 또는 "제목 > 📎 파일명 (3쪽)" */
  context: string;
  snippet: string;
  blockId: string | null;
  attachmentId: string | null;
  attachmentName: string | null;
  matchedBy: Array<"keyword" | "semantic">;
  score: number;
};

export type WorkspaceSearchResponse = {
  results: WorkspaceSearchResult[];
  concepts?: WikiConceptListItem[];
  keywords: string[];
  engines: { keyword: "pgroonga" | "basic"; semantic: boolean };
  semanticError?: string;
};

export type StorageSystemSettings = {
  provider: "local" | "s3";
  localPath: string;
  maxFileSizeMb: number;
  s3Bucket?: string;
  s3Region?: string;
  s3Endpoint?: string;
};

export type RedisSystemSettings = {
  url: string;
  prefix: string;
  enabled: boolean;
};

export type DatabaseSystemSettings = {
  host: string;
  port: number;
  database: string;
  user: string;
  password?: string;
  ssl: boolean;
};

export type DistributedSystemSettings = {
  clusterMode: "single" | "distributed";
  syncMethod: "redis_pubsub" | "polling";
  nodeId: string;
  sharedStoragePath?: string;
};

export type SystemConfig = {
  ai: AISystemSettings;
  aiBackground: BackgroundAISettings;
  embedding: EmbeddingSystemSettings;
  storage: StorageSystemSettings;
  redis: RedisSystemSettings;
  database: DatabaseSystemSettings;
  distributed: DistributedSystemSettings;
  updatedAt?: string;
  updatedBy?: string;
};

export type ConnectionTestResult = {
  ok: boolean;
  message: string;
  version?: string;
  hasPgVector?: boolean;
  latencyMs?: number;
  absolutePath?: string;
  writable?: boolean;
  dims?: number;
};

export type SystemStatus = {
  nodeVersion: string;
  pid: number;
  uptimeSeconds: number;
  memoryMb: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
  };
  clusterMode: string;
  collabPort: number | string;
  serverPort: number | string;
};

/** 페이지 기록 한 건 (apps/server/db.ts listPageVersionsFromDb) */
export type PageVersionSummary = {
  id: string;
  title: string;
  editedAt: string;
};

export type AuthSession = {
  serverHost: string;
  token: string;
  user: AuthUser;
};

export type PageItem = {
  id: string;
  /** page: 문서, canvas: 캔버스 (없으면 page) */
  kind?: "page" | "canvas";
  title: string;
  icon?: string | null;
  pageWidth?: string | null;
  parentId: string | null;
  order: number;
  createdAt: string;
  updatedAt: string;
};

export type TrashedPageItem = {
  id: string;
  title: string;
  icon: string | null;
  parentId: string | null;
  deletedAt: string;
  expiresAt: string;
  pageCount: number;
};

export type PageLinkSummary = {
  id: string;
  title: string;
};

export type WorkspaceTabItem = {
  id: string;
  pageId: string;
};

export type WorkspaceLayoutState = {
  tabs: WorkspaceTabItem[];
  activeTabId: string;
  splitTabIds: string[];
  splitRatios: number[];
};

export type SaveResult = {
  path: string;
  savedAt: string;
  pages?: PageItem[];
  backlinks?: PageLinkSummary[];
};

export type SavedAttachment = {
  name: string;
  type: string;
  size: number;
  url: string;
};

declare global {
  /** Electron preload 가 여는 기능 (apps/desktop/preload.cjs). 웹 브라우저에서는 없다. */
  interface DesktopBridge {
    openServer?: (serverHost: string, session: AuthSession) => Promise<boolean>;
    takePendingSession?: () => AuthSession | null;
    leaveServer?: () => Promise<void>;
    [key: string]: unknown;
  }

  interface Window {
    desktop?: DesktopBridge;
  }
}

export {};
