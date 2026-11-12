import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type DragEvent,
  type SetStateAction,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  BlockNoteEditor,
  BlockNoteSchema,
  combineByGroup,
  createCodeBlockSpec,
  createExtension,
  insertOrUpdateBlockForSlashMenu,
  type PartialBlock,
} from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { codeBlockOptions, syntaxHighlighter } from "@blocknote/code-block";
import { filterSuggestionItems } from "@blocknote/core/extensions";
import { ko } from "@blocknote/core/locales";
import {
  createReactDiagramBlockSpec,
  getDiagramSlashMenuItems,
  locales as diagramLocales,
} from "@blocknote/diagram-block";
import {
  createReactInlineMathSpec,
  createReactMathBlockSpec,
  getMathSlashMenuItems,
  locales as mathLocales,
} from "@blocknote/math-block";
import {
  getMultiColumnSlashMenuItems,
  locales as multiColumnLocales,
  multiColumnDropCursor,
  withMultiColumn,
} from "@blocknote/xl-multi-column";
import { BlockNoteView } from "@blocknote/mantine";
import { PageHistoryModal, PreviewBlocks } from "./PageHistory";
import { LinkPasteMenu, createBookmarkBlockSpec, createEmbedBlockSpec, createTocBlockSpec, getLinkBlockSlashMenuItems, type LinkPasteState } from "./LinkBlocks";
import { safeHttpUrl } from "./link-embeds";
import { NotionImportDialog } from "./NotionImport";
import { TemplatePanel, TemplateSaveDialog, TemplateSvgIcon } from "./TemplatePanel";
import { USER_TEMPLATE_CATEGORY, clearLegacyUserTemplates, takeLegacyUserTemplates, type PageTemplate } from "./templates";
import type { UserTemplateRecord } from "./api";
import {
  createReactBlockSpec,
  createReactInlineContentSpec,
  FormattingToolbar,
  FormattingToolbarController,
  getDefaultReactSlashMenuItems,
  getFormattingToolbarItems,
  SuggestionMenuController,
  useCreateBlockNote,
  type DefaultReactSuggestionItem,
} from "@blocknote/react";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { resolveCollaborationWsUrl } from "./collaboration-url";
import * as Y from "yjs";
import {
  clearAuthSession,
  getStoredAuthSession,
  getStoredServerHost,
  normalizeServerHost,
  resolveUploadUrl,
  UnauthorizedApiError,
  workspaceApi,
} from "./api";
import {
  CollectionActionsContext,
  createCollectionBlockSpec,
  createDefaultCollectionData,
  type CollectionActionsContextValue,
} from "./CollectionBlock";
import { collectionMap, readCollectionMap } from "@noty/shared/collection-yjs";
import {
  createCalloutBlockSpec,
  getCalloutSlashMenuItems,
} from "./CalloutBlock";
import {
  HomeDashboard,
  HOME_PAGE_ID,
  HomeSvgIcon,
} from "./HomeDashboard";
import { AIChatPanel, AISparkleSvgIcon, AskAIToolbarButton, blocksToPlainText } from "./AIChatPanel";
import { createAIEditorBridge, type AIEditorBridge } from "./ai-markdown";
import { AIProviderSettings } from "./AIProviderSettings";
import { revealBlockWhenReady, SearchHitContent, useWorkspaceSearch } from "./WorkspaceSearch";
import { CanvasPane, CanvasPreview } from "./CanvasPane";
import { GraphView } from "./GraphView";
import type {
  AuthSession,
  PageItem,
  TrashedPageItem,
  WorkspaceLayoutState,
  WorkspaceTabItem,
} from "./vite-env";

const isElectronMac =
  typeof window !== "undefined" &&
  Boolean(window.desktop) &&
  /Mac|iPod|iPhone|iPad/.test(navigator.platform);

const collaborationEnabled = import.meta.env.VITE_COLLABORATION_ENABLED !== "false";

const COLLABORATION_USER_COLORS = [
  "#2383e2",
  "#0f7b6c",
  "#9b51e0",
  "#d9730d",
  "#dfab01",
  "#e03e3e",
  "#ad1a72",
  "#448361",
];

function getUserCollaborationColor(username: string): string {
  let hash = 0;
  for (let i = 0; i < username.length; i += 1) {
    hash = (hash * 31 + username.charCodeAt(i)) >>> 0;
  }
  return COLLABORATION_USER_COLORS[hash % COLLABORATION_USER_COLORS.length];
}

/* ==========================================================================
 * Thin stroke SVG icons
 * ========================================================================== */
function DocSvgIcon({ hasChildren = false }: { hasChildren?: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4 2.25h5.2L12.5 5.5v8.25A1.25 1.25 0 0 1 11.25 15h-7.25A1.25 1.25 0 0 1 2.75 13.75v-10.25A1.25 1.25 0 0 1 4 2.25Z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
      <path
        d="M9 2.5v3.25h3.25"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {hasChildren && (
        <>
          <line x1="5.2" y1="8.2" x2="10.2" y2="8.2" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" />
          <line x1="5.2" y1="10.8" x2="8.8" y2="10.8" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

function CanvasSvgIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.75" y="2.25" width="5.5" height="4.5" rx="1.1" stroke="currentColor" strokeWidth="1.25" />
      <rect x="8.75" y="9.25" width="5.5" height="4.5" rx="1.1" stroke="currentColor" strokeWidth="1.25" />
      <path d="M7.25 4.5h2.5a1.5 1.5 0 0 1 1.5 1.5v3.25" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

function GraphSvgIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="4" cy="4.5" r="2" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="12" cy="4" r="1.6" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="9" cy="12" r="2.2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5.8 5.3 7.9 10M5.9 4.3l4.5-.2M11.4 5.4l-1.5 4.6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

function PageIconOrDoc({
  icon,
  hasChildren = false,
  kind,
}: {
  icon?: string | null;
  hasChildren?: boolean;
  kind?: PageItem["kind"];
}) {
  if (icon && icon.trim()) {
    return <span className="page-emoji-icon">{icon}</span>;
  }
  if (kind === "canvas") return <CanvasSvgIcon />;
  return <DocSvgIcon hasChildren={hasChildren} />;
}

const EMOJI_GROUPS: { label: string; emojis: string[] }[] = [
  {
    label: "자주 쓰는 아이콘",
    emojis: ["📝", "📄", "📌", "💡", "🚀", "✨", "🔥", "✅", "⭐", "🎯", "📚", "🗂️"],
  },
  {
    label: "업무 · 프로젝트",
    emojis: ["💼", "📅", "📊", "📈", "📋", "🧭", "🛠️", "⚙️", "🧪", "🔍", "📣", "🏆"],
  },
  {
    label: "개발 · 기술",
    emojis: ["💻", "🖥️", "⌨️", "🐛", "🧩", "🗄️", "🔐", "🌐", "⚡", "🤖", "📦", "🔗"],
  },
  {
    label: "일상 · 아이디어",
    emojis: ["🌱", "☕", "🎨", "🎵", "🎬", "🏠", "✈️", "💬", "❤️", "🍀", "🌙", "☀️"],
  },
];

const ALL_EMOJIS = EMOJI_GROUPS.flatMap((group) => group.emojis);

function ChevronSvgIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={`chevron-svg ${expanded ? "chevron-svg--expanded" : ""}`}
    >
      <path
        d="M6 3.75L10.25 8L6 12.25"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MoreDotsSvgIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="3.5" cy="8" r="1.2" />
      <circle cx="8" cy="8" r="1.2" />
      <circle cx="12.5" cy="8" r="1.2" />
    </svg>
  );
}

function PlusSvgIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 3.25v9.5M3.25 8h9.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SearchSvgIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.35" />
      <path d="M10.5 10.5L13.5 13.5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  );
}

function CollapseSidebarSvgIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M7.5 4.25L4 8l3.5 3.75M11.5 4.25L8 8l3.5 3.75"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SidebarToggleSvgIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="2.75" width="12" height="10.5" rx="1.75" stroke="currentColor" strokeWidth="1.25" />
      <line x1="6.25" y1="2.75" x2="6.25" y2="13.25" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  );
}

function CloseSvgIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4.25 4.25L11.75 11.75M11.75 4.25L4.25 11.75"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SplitPaneSvgIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="2.75" width="12" height="10.5" rx="1.75" stroke="currentColor" strokeWidth="1.25" />
      <line x1="8" y1="2.75" x2="8" y2="13.25" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  );
}

function SettingsGearSvgIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="2.1" stroke="currentColor" strokeWidth="1.25" />
      <path
        d="M8 1.9v1.35M8 12.75v1.35M1.9 8h1.35M12.75 8h1.35M3.68 3.68l.96.96M11.36 11.36l.96.96M12.32 3.68l-.96.96M4.64 11.36l-.96.96"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  );
}

function TrashSvgIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.75 4.25h10.5M6.25 4.25V2.9c0-.36.29-.65.65-.65h2.2c.36 0 .65.29.65.65v1.35M4.1 4.25l.65 8.6c.04.5.45.9.95.9h4.6c.5 0 .91-.4.95-.9l.65-8.6"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckSvgIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3.5 8.25L6.6 11.35L12.75 4.75"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CollectionSvgIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="2.5" width="12" height="11" rx="1.6" stroke="currentColor" strokeWidth="1.25" />
      <line x1="2" y1="6.2" x2="14" y2="6.2" stroke="currentColor" strokeWidth="1.25" />
      <line x1="6.4" y1="6.2" x2="6.4" y2="13.5" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function HistorySvgIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.75v2.5H5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 5.25V8l2 1.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PageWidthSvgIcon({ isFull = false }: { isFull?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <line x1="2.25" y1="3" x2="2.25" y2="13" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <line x1="13.75" y1="3" x2="13.75" y2="13" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      {isFull ? (
        <>
          <path d="M4.2 8h7.6M6 6.1L4.1 8 6 9.9M10 6.1L11.9 8 10 9.9" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : (
        <>
          <rect x="4.75" y="4.25" width="6.5" height="7.5" rx="1" stroke="currentColor" strokeWidth="1.2" />
        </>
      )}
    </svg>
  );
}

function normalizePageWidthValue(raw?: string | null): string {
  if (!raw || typeof raw !== "string") return "default";
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

function resolvePageMaxWidthCss(pageWidth?: string | null): string {
  const norm = normalizePageWidthValue(pageWidth);
  if (norm === "full") return "100%";
  if (norm === "wide") return "1080px";
  if (norm === "default") return "760px";
  return `${norm}px`;
}

function resolvePageNumericWidth(pageWidth?: string | null): number {
  const norm = normalizePageWidthValue(pageWidth);
  if (norm === "wide") return 1080;
  if (norm === "default" || norm === "full") return 760;
  return Number(norm) || 760;
}

function getPageWidthShortLabel(pageWidth?: string | null): string {
  const norm = normalizePageWidthValue(pageWidth);
  if (norm === "full") return "전체 너비";
  if (norm === "wide") return "넓게 (1080px)";
  if (norm === "default") return "기본 (760px)";
  return `${norm}px`;
}

export interface SelectPageOptions {
  newTab?: boolean;
  split?: boolean;
  targetTabId?: string;
}

interface WorkspacePagesContextValue {
  pagesById: Map<string, PageItem>;
  pagesByParent: Map<string | null, PageItem[]>;
  onSelectPage: (pageId: string, options?: SelectPageOptions) => void;
}

const WorkspacePagesContext = createContext<WorkspacePagesContextValue>({
  pagesById: new Map(),
  pagesByParent: new Map(),
  onSelectPage: () => {},
});

/**
 * 노션 스타일 본문 일체형 '페이지 블록' (`type: "page"`)
 */
function PageBlockRow({ pageId }: { pageId: string }) {
  const { pagesById, pagesByParent, onSelectPage } = useContext(WorkspacePagesContext);
  const target = pagesById.get(pageId);
  const subCount = (pagesByParent.get(pageId) ?? []).length;

  if (!target) {
    return (
      <div className="bn-page-block bn-page-block--missing" contentEditable={false}>
        <span className="bn-page-block__icon">
          <DocSvgIcon />
        </span>
        <span className="bn-page-block__title">문서를 찾을 수 없음</span>
      </div>
    );
  }

  // 캔버스는 본문 안에서 보기 전용 미리보기로 보여 준다 (누르면 캔버스가 열림)
  if (target.kind === "canvas") {
    return <CanvasPreview pageId={pageId} pagesById={pagesById} onOpen={() => onSelectPage(pageId, {})} />;
  }

  return (
    <div
      className="bn-page-block"
      contentEditable={false}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onSelectPage(pageId, {
          newTab: event.metaKey || event.ctrlKey,
          split: event.altKey,
        });
      }}
    >
      <span className="bn-page-block__icon">
        <PageIconOrDoc icon={target.icon} hasChildren={subCount > 0} kind={target.kind} />
      </span>
      <span className="bn-page-block__title">{target.title || "제목 없는 문서"}</span>
      {subCount > 0 && <span className="bn-page-block__meta">{subCount}</span>}
      <span className="bn-page-block__arrow" aria-hidden="true">
        →
      </span>
    </div>
  );
}

const createPageBlockSpec = createReactBlockSpec(
  {
    type: "page",
    propSchema: {
      pageId: {
        default: "",
      },
    },
    content: "none",
  } as const,
  {
    render: (props) => <PageBlockRow pageId={props.block.props.pageId} />,
  },
);

/**
 * 문장 중간에 다른 페이지를 참조할 때 쓰는 인라인 멘션 (`@페이지이름`)
 */
function PageLinkPill({ pageId }: { pageId: string }) {
  const { pagesById, onSelectPage } = useContext(WorkspacePagesContext);
  const target = pagesById.get(pageId);

  if (!target) return null;

  return (
    <span
      className="bn-page-link"
      contentEditable={false}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onSelectPage(pageId, {
          newTab: event.metaKey || event.ctrlKey,
          split: event.altKey,
        });
      }}
    >
      <span className="bn-page-link__icon">
        <PageIconOrDoc icon={target.icon} kind={target.kind} />
      </span>
      <span className="bn-page-link__title">{target.title || "제목 없는 문서"}</span>
    </span>
  );
}

const PageLinkInline = createReactInlineContentSpec(
  {
    type: "pageLink",
    propSchema: {
      pageId: {
        default: "",
      },
    },
    content: "none",
  } as const,
  {
    render: (props) => <PageLinkPill pageId={props.inlineContent.props.pageId} />,
  },
);

const codeLanguageAliases = new Map<string, string>();
for (const [language, details] of Object.entries(codeBlockOptions.supportedLanguages)) {
  codeLanguageAliases.set(language, language);
  for (const alias of details.aliases ?? []) codeLanguageAliases.set(alias, language);
}

function normalizeStoredBlocks(blocks: unknown[]): PartialBlock<any, any, any>[] {
  return blocks.map((value) => {
    if (!value || typeof value !== "object") return value as PartialBlock<any, any, any>;

    const block = value as Record<string, unknown>;
    const props =
      block.props && typeof block.props === "object"
        ? { ...(block.props as Record<string, unknown>) }
        : undefined;

    if (block.type === "codeBlock" && props && typeof props.language === "string") {
      props.language = codeLanguageAliases.get(props.language.toLowerCase()) ?? "text";
    }

    return {
      ...block,
      ...(props ? { props } : {}),
      ...(Array.isArray(block.children)
        ? { children: normalizeStoredBlocks(block.children) }
        : {}),
    } as PartialBlock<any, any, any>;
  });
}

function extractInlineText(content: unknown): string {
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

/** 제목(첫 블록) 아래가 비어 있는지: 빈 문단만 있으면 비어 있다고 본다 */
function isDocumentBodyEmpty(blocks: readonly any[]): boolean {
  return blocks
    .slice(1)
    .every((block) => block?.type === "paragraph" && !extractInlineText(block.content).trim() && !block.children?.length);
}

function extractDocumentTitle(blocks: readonly unknown[]): string | undefined {
  for (const value of blocks) {
    if (!value || typeof value !== "object") continue;
    const block = value as Record<string, unknown>;
    if (block.type === "page") continue;
    const text = extractInlineText(block.content).trim();
    if (text) return text.slice(0, 80);
  }
  return undefined;
}

function isDescendantPage(
  pages: readonly PageItem[],
  targetParentId: string | null,
  pageId: string,
): boolean {
  let currentId = targetParentId;
  const visited = new Set<string>();
  while (currentId) {
    if (currentId === pageId) return true;
    if (visited.has(currentId)) break;
    visited.add(currentId);
    const parent = pages.find((item) => item.id === currentId);
    currentId = parent ? parent.parentId : null;
  }
  return false;
}

/**
 * 클립보드 텍스트나 링크 href에서 내부 페이지 ID를 추출합니다.
 * 예: `notion-like://page/page-1234abcd`, `/pages/page-1234abcd`, `#page-1234abcd`
 */
function parseInternalPageId(
  rawText: string,
  pagesById: ReadonlyMap<string, PageItem>,
): string | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;

  const customSchemeMatch = trimmed.match(/^(?:noty|notion-like):\/\/page\/([a-zA-Z0-9_-]+)$/);
  if (customSchemeMatch && pagesById.has(customSchemeMatch[1])) {
    return customSchemeMatch[1];
  }

  const pathOrHashMatch = trimmed.match(/(?:\/pages\/|#\/?|\/)([a-zA-Z0-9_-]+)$/);
  if (pathOrHashMatch && pagesById.has(pathOrHashMatch[1])) {
    return pathOrHashMatch[1];
  }

  if (pagesById.has(trimmed)) {
    return trimmed;
  }

  return null;
}

const initialDocument: PartialBlock<any, any, any>[] = [
  {
    type: "heading",
    props: { level: 1 },
    content: "나의 문서 편집기",
  },
  {
    type: "paragraph",
    content:
      "여기에 입력해 보세요. /페이지 를 입력하면 본문 안에 하위 페이지 블록이 생성됩니다.",
  },
  {
    type: "bulletListItem",
    content: "블록을 드래그해서 순서를 바꾸거나 좌우 다단으로 나눌 수 있습니다.",
  },
  {
    type: "codeBlock",
    props: { language: "typescript" },
    content: 'const message: string = "Hello, BlockNote + PostgreSQL(pgvector)!";',
  },
];

const schema = withMultiColumn(
  BlockNoteSchema.create().extend({
    blockSpecs: {
      codeBlock: createCodeBlockSpec(codeBlockOptions),
      mathBlock: createReactMathBlockSpec(),
      diagram: createReactDiagramBlockSpec(),
      page: createPageBlockSpec(),
      collection: createCollectionBlockSpec(),
      callout: createCalloutBlockSpec(),
      toc: createTocBlockSpec(),
      bookmark: createBookmarkBlockSpec(),
      embed: createEmbedBlockSpec(),
    },
    inlineContentSpecs: {
      math: createReactInlineMathSpec(),
      pageLink: PageLinkInline,
    },
  }),
);

function resolveCodeBlockLanguage(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    return codeBlockOptions.defaultLanguage || "text";
  }
  return codeLanguageAliases.get(normalized) ?? "text";
}

function findInlineBacktickOpenPos(
  state: any,
  blockStart: number,
  textBeforeClosing: string,
  closingPos: number,
  closingChar: string,
  codeMarkType: any,
): number | null {
  if (textBeforeClosing.length < 2) return null;
  const lastIdx = textBeforeClosing.length - 1;
  const charBeforeClosing = textBeforeClosing[lastIdx];
  if (charBeforeClosing === "`" || charBeforeClosing === "₩") {
    return null;
  }

  for (let i = lastIdx - 1; i >= 0; i--) {
    const ch = textBeforeClosing[i];
    if (ch === "\ufffc" || ch === "\n") break;
    if (ch !== "`" && ch !== "₩") continue;

    const prevCh = i > 0 ? textBeforeClosing[i - 1] : "";
    if (prevCh === "`" || prevCh === "₩") {
      return null;
    }

    const openPos = blockStart + i;
    if (state.doc.rangeHasMark(openPos, closingPos, codeMarkType)) {
      return null;
    }

    const innerText = textBeforeClosing.slice(i + 1);
    if (!innerText) return null;

    // 한글 입력 상태에서 `₩...₩` 로 입력한 경우 통화 표기(`₩10,000 ~ ₩20,000`)와 구분
    if (ch === "₩" && closingChar === "₩") {
      if (innerText.trim() !== innerText) return null;
      if (/^\d[\d,]*\s*(?:원)?\s*[-~]/.test(innerText)) return null;
    }

    return openPos;
  }

  return null;
}

/**
 * 노션 스타일 백틱(`코드` 인라인 코드 & ``` 코드 블록) 완벽 지원 확장
 * - 영문 `` `코드` `` 뿐만 아니라 한글 IME 조합 직후 닫는 백틱, 맥 한글 자판 `₩코드₩` / `` `코드₩ `` 지원
 * - 텍스트 드래그 선택 후 `` ` `` 또는 `⌘E` 입력 시 인라인 코드 토글
 * - 줄 시작에서 ```` ``` ````(또는 `₩₩₩`) 입력 후 `Enter` 또는 `Space` 입력 시 코드 블록으로 즉시 전환
 */
const backtickSupportExtension = createExtension(({ editor }) => ({
  key: "noty-backtick-support",
  runsBefore: ["code-block-keyboard-shortcuts"],
  inputRules: [
    {
      find: /^(?:```|₩₩₩)(.*?)\s$/,
      replace: ({ match }) => ({
        type: "codeBlock",
        props: {
          language: resolveCodeBlockLanguage(match[1] ?? ""),
        },
        content: [],
      }),
    },
  ],
  mount({ dom, signal }) {
    const tryConvertBlockToCodeBlock = (
      view: any,
      requireExactEnd: boolean,
    ): boolean => {
      const { state } = view;
      const { selection } = state;
      if (!selection.empty) return false;
      const { $from } = selection;
      if ($from.parent.type.spec.code) return false;

      const block = editor.getTextCursorPosition().block;
      if (!block || block.type === "codeBlock") return false;

      const parentText: string = $from.parent.textContent ?? "";
      if (requireExactEnd && $from.parentOffset !== $from.parent.content.size) {
        return false;
      }

      const fenceMatch = parentText.match(/^(?:```|₩₩₩)([a-zA-Z0-9_+#.-]*)\s*$/);
      if (!fenceMatch) return false;

      const language = resolveCodeBlockLanguage(fenceMatch[1] ?? "");
      editor.updateBlock(block.id, {
        type: "codeBlock",
        props: { language },
        content: "",
      } as any);
      editor.setTextCursorPosition(block.id, "start");
      return true;
    };

    const tryConvertCommittedInlineBacktick = (view: any): boolean => {
      if (view.composing) return false;
      const { state } = view;
      const { selection } = state;
      if (!selection.empty) return false;
      const { $from } = selection;
      if ($from.parent.type.spec.code) return false;

      const codeMarkType = state.schema.marks.code;
      if (!codeMarkType) return false;

      const blockStart = $from.start();
      const cursorPos = $from.pos;
      if (cursorPos - blockStart < 3) return false;

      const textUpToCursor = state.doc.textBetween(
        blockStart,
        cursorPos,
        "\ufffc",
        "\ufffc",
      );
      if (textUpToCursor.length !== cursorPos - blockStart) return false;

      const closingChar = textUpToCursor[textUpToCursor.length - 1];
      if (closingChar !== "`" && closingChar !== "₩") return false;

      const closePos = cursorPos - 1;
      if (state.doc.rangeHasMark(closePos, cursorPos, codeMarkType)) {
        return false;
      }

      const afterChar = state.doc.textBetween(
        cursorPos,
        Math.min(cursorPos + 1, $from.end()),
        "\ufffc",
        "\ufffc",
      );
      if (afterChar === "`" || afterChar === "₩") return false;

      const openPos = findInlineBacktickOpenPos(
        state,
        blockStart,
        textUpToCursor.slice(0, -1),
        closePos,
        closingChar,
        codeMarkType,
      );
      if (openPos === null) return false;

      const tr = state.tr;
      tr.delete(closePos, closePos + 1);
      tr.delete(openPos, openPos + 1);
      tr.addMark(openPos, closePos - 1, codeMarkType.create());
      tr.removeStoredMark(codeMarkType);
      view.dispatch(tr);
      return true;
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const view = editor.prosemirrorView;
      if (!view) return;

      // 1. ⌘E / Ctrl+E 로 선택 영역 인라인 코드 토글
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "e") {
        const { state } = view;
        if (!state.selection.$from.parent.type.spec.code) {
          event.preventDefault();
          event.stopPropagation();
          editor.toggleStyles({ code: true });
          return;
        }
      }

      // 2. 텍스트를 드래그 선택한 상태에서 백틱(`) 입력 시 인라인 코드로 감싸기/해제
      if (
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        (event.key === "`" || (event.code === "Backquote" && event.key === "₩"))
      ) {
        const { state } = view;
        if (!state.selection.empty && !state.selection.$from.parent.type.spec.code) {
          event.preventDefault();
          event.stopPropagation();
          editor.toggleStyles({ code: true });
          return;
        }
      }

      // 3. ``` 또는 ```ts 입력 후 Enter / Space 시 코드 블록 전환
      if (
        !event.isComposing &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey
      ) {
        if (event.key === "Enter") {
          if (tryConvertBlockToCodeBlock(view, false)) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
        } else if (event.key === " ") {
          if (tryConvertBlockToCodeBlock(view, true)) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
        } else if (event.key === "ArrowRight") {
          // 인라인 코드 오른쪽 끝에서 오른쪽 화살표 키를 누르면 인라인 코드 밖으로 커서 탈출
          const { state } = view;
          const { selection } = state;
          const codeMarkType = state.schema.marks.code;
          if (selection.empty && codeMarkType) {
            const { $from } = selection;
            const hasCodeMark = (state.storedMarks || $from.marks()).some(
              (m: any) => m.type === codeMarkType,
            );
            const nextHasCode =
              $from.pos < $from.end() &&
              state.doc.rangeHasMark($from.pos, $from.pos + 1, codeMarkType);
            if (hasCodeMark && !nextHasCode) {
              event.preventDefault();
              event.stopPropagation();
              view.dispatch(state.tr.removeStoredMark(codeMarkType));
              return;
            }
          }
        }
      }
    };

    const handleBeforeInput = (event: InputEvent) => {
      if (event.isComposing) return;
      if (event.inputType !== "insertText") return;
      const inserted = event.data;
      if (inserted !== "`" && inserted !== "₩") return;

      const view = editor.prosemirrorView;
      if (!view) return;
      const { state } = view;
      const { selection } = state;
      const { $from } = selection;
      if ($from.parent.type.spec.code) return;

      if (!selection.empty) {
        if (inserted === "`") {
          event.preventDefault();
          event.stopPropagation();
          editor.toggleStyles({ code: true });
        }
        return;
      }

      const codeMarkType = state.schema.marks.code;
      if (!codeMarkType) return;

      const blockStart = $from.start();
      const cursorPos = $from.pos;
      if (cursorPos - blockStart < 2) return;

      const textBefore = state.doc.textBetween(
        blockStart,
        cursorPos,
        "\ufffc",
        "\ufffc",
      );
      if (textBefore.length !== cursorPos - blockStart) return;

      const afterChar = state.doc.textBetween(
        cursorPos,
        Math.min(cursorPos + 1, $from.end()),
        "\ufffc",
        "\ufffc",
      );
      if (afterChar === "`" || afterChar === "₩") return;

      const openPos = findInlineBacktickOpenPos(
        state,
        blockStart,
        textBefore,
        cursorPos,
        inserted,
        codeMarkType,
      );
      if (openPos === null) return;

      event.preventDefault();
      event.stopPropagation();

      const tr = state.tr;
      tr.delete(openPos, openPos + 1);
      tr.addMark(openPos, cursorPos - 1, codeMarkType.create());
      tr.removeStoredMark(codeMarkType);
      view.dispatch(tr);
    };

    const handlePostInput = () => {
      queueMicrotask(() => {
        const view = editor.prosemirrorView;
        if (!view) return;
        tryConvertCommittedInlineBacktick(view);
      });
    };

    let lastSyntheticDropAt = -Infinity;

    const normalizeGutterDragEvent = (event: globalThis.DragEvent) => {
      const blockGroup = dom.firstElementChild as HTMLElement | null;
      if (!blockGroup) return;
      const rect = blockGroup.getBoundingClientRect();
      if (rect.width <= 0) return;

      const isSynthetic = Boolean((event as any).synthetic);
      if (!isSynthetic && event.type === "drop" && performance.now() - lastSyntheticDropAt < 80) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }

      if (isSynthetic && event.type === "drop") {
        lastSyntheticDropAt = performance.now();
      }

      // 좌측 드래그 핸들(⋮⋮) 거터 영역에서 위아래로 블록을 이동할 때,
      // SideMenu 합성 이벤트가 clientX 를 blockGroup.left 로 고정해 다단(column) 생성으로 오인되는 현상을 방지
      if (isSynthetic || event.clientX <= rect.left + 4) {
        const safeClientX = Math.min(rect.left + 16, rect.right - 16);
        try {
          (event as any).clientX = safeClientX;
        } catch {
          // 네이티브 DragEvent 의 getter 전용 속성인 경우 프로퍼티 재정의
        }
        if (event.clientX <= rect.left + 4) {
          try {
            Object.defineProperty(event, "clientX", {
              value: safeClientX,
              configurable: true,
            });
          } catch {
            // ignore
          }
        }
      }
    };

    dom.addEventListener("dragover", normalizeGutterDragEvent as EventListener, {
      capture: true,
      signal,
    });
    dom.addEventListener("drop", normalizeGutterDragEvent as EventListener, {
      capture: true,
      signal,
    });
    dom.addEventListener("keydown", handleKeyDown, { capture: true, signal });
    dom.addEventListener("beforeinput", handleBeforeInput as EventListener, {
      capture: true,
      signal,
    });
    dom.addEventListener("input", handlePostInput, { signal });
    dom.addEventListener("compositionend", handlePostInput, { signal });
  },
}));

type SaveState = "loading" | "saved" | "saving" | "error";
type DropPlacement = "before" | "inside" | "after";

interface DropIndicator {
  targetId: string;
  placement: DropPlacement;
}

interface ContextMenuState {
  page: PageItem;
  x: number;
  y: number;
}

interface EmojiPickerState {
  pageId: string;
  x: number;
  y: number;
}

interface PageWidthMenuState {
  pageId: string;
  x: number;
  y: number;
}

interface EditorPageBlockRef {
  block: any;
  pageId: string;
}

/** 에디터 문서에서 `page` 블록을 문서 순서대로(다단 등 중첩 포함) 수집한다. */
function collectEditorPageBlocks(blocks: readonly any[]): EditorPageBlockRef[] {
  const refs: EditorPageBlockRef[] = [];
  const visit = (items: readonly any[]) => {
    for (const block of items) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "page" && typeof block.props?.pageId === "string") {
        refs.push({ block, pageId: block.props.pageId });
      }
      if (Array.isArray(block.children) && block.children.length > 0) {
        visit(block.children);
      }
    }
  };
  visit(blocks);
  return refs;
}

/** 동시 시드 등으로 같은 id 의 블록이 두 번 생긴 경우, 뒤쪽 중복 블록을 수집한다. */
function collectDuplicateBlocks(blocks: readonly any[]): any[] {
  const seen = new Set<string>();
  const duplicates: any[] = [];
  const visit = (items: readonly any[]) => {
    for (const block of items) {
      if (!block || typeof block !== "object") continue;
      if (typeof block.id === "string") {
        if (seen.has(block.id)) {
          duplicates.push(block);
          continue;
        }
        seen.add(block.id);
      }
      if (Array.isArray(block.children) && block.children.length > 0) {
        visit(block.children);
      }
    }
  };
  visit(blocks);
  return duplicates;
}

/** 이전 삭제 로직이 모든 일반 블록 아래에 붙였던 빈 문단만 식별한다. */
function collectDeletionArtifactParagraphs(blocks: readonly any[]): any[] {
  const textBlocks = blocks.filter((block) =>
    block?.type === "heading" || block?.type === "paragraph",
  );
  if (textBlocks.length < 2 || textBlocks.length !== blocks.length) return [];
  if (!textBlocks.some((block) => extractInlineText(block.content).trim())) return [];
  if (!textBlocks.every((block) => {
    const children = block.children;
    if (!Array.isArray(children) || children.length !== 1) return false;
    const child = children[0];
    return child?.type === "paragraph" &&
      extractInlineText(child.content).trim() === "" &&
      (!Array.isArray(child.children) || child.children.length === 0);
  })) return [];
  return textBlocks.map((block) => block.children[0]);
}

function getOrderedChildPageIds(pages: readonly PageItem[], parentId: string): string[] {
  return pages
    .filter((page) => page.parentId === parentId)
    .sort(
      (a, b) =>
        (a.order ?? 0) - (b.order ?? 0) || String(a.createdAt).localeCompare(String(b.createdAt)),
    )
    .map((page) => page.id);
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

interface EditorPaneProps {
  authSession: AuthSession;
  /** 페이지 기록 창을 이 창에서 열지 */
  isHistoryOpen: boolean;
  onCloseHistory: () => void;
  pageId: string;
  pageWidth?: string | null;
  pages: PageItem[];
  pagesById: Map<string, PageItem>;
  initialContent: PartialBlock<any, any, any>[];
  onSelectPage: (id: string) => void;
  onInsertPageBlockAndOpen: (
    parentId: string,
    getUpdatedParentBlocks: (newChildId: string) => readonly unknown[],
    kind?: "page" | "canvas",
  ) => Promise<void>;
  onSaveBlocks: (pageId: string, blocks: readonly unknown[], title?: string) => void;
  onTitlePreviewChange: (pageId: string, title: string) => void;
  onReorderChildPages: (parentId: string, orderedIds: string[]) => void;
  onRequestPagesRefresh: () => void;
  onTrashPageBlocks: (parentId: string, childIds: string[], blocks: readonly unknown[], title?: string) => Promise<void>;
  onOpenOrCreateCollectionRowPage: CollectionActionsContextValue["onOpenOrCreateRowPage"];
  onSyncPageWidthFromYjs?: (pageId: string, pageWidth: string) => void;
  /** 템플릿 패널에서 마우스를 올린 템플릿 — 본문 아래에 반투명하게 미리 보여 준다 */
  templatePreview?: PageTemplate | null;
  /** nonce 가 바뀔 때마다 이 템플릿을 본문에 적용한다 */
  templateApplyRequest?: { template: PageTemplate; nonce: number } | null;
  onOpenTemplates?: () => void;
  /** 활성 탭의 편집기만 AI 패널에 연결한다 (선택 부분 바꾸기·페이지에 넣기) */
  onAIBridgeChange?: Dispatch<SetStateAction<AIEditorBridge | null>>;
  /** 서식 도구 모음의 ✦ 버튼: 선택한 채로 AI 패널을 연다 */
  onAskAI?: () => void;
}

function EditorPane({
  authSession,
  isHistoryOpen,
  onCloseHistory,
  pageId,
  pageWidth,
  pages,
  pagesById,
  initialContent,
  onSelectPage,
  onInsertPageBlockAndOpen,
  onSaveBlocks,
  onTitlePreviewChange,
  onReorderChildPages,
  onRequestPagesRefresh,
  onTrashPageBlocks,
  onOpenOrCreateCollectionRowPage,
  onSyncPageWidthFromYjs,
  templatePreview,
  templateApplyRequest,
  onOpenTemplates,
  onAIBridgeChange,
  onAskAI,
}: EditorPaneProps) {
  // 읽기 전용 계정: 보기만 한다 (편집·구조 보정·저장을 하지 않음. 서버도 같은 기준으로 막는다).
  const readOnly = authSession.user.role === "viewer";
  const suppressOnChangeRef = useRef(false);
  const reconcilingRef = useRef(false);
  const observedPageBlockIdsRef = useRef<Set<string>>(new Set());
  const pendingTrashIdsRef = useRef<Set<string>>(new Set());
  const pendingRemovalCheckIdsRef = useRef<Set<string>>(new Set());
  const removalCheckTimerRef = useRef<number | undefined>(undefined);
  const pagesByIdRef = useRef(pagesById);
  pagesByIdRef.current = pagesById;
  const onSelectPageRef = useRef(onSelectPage);
  onSelectPageRef.current = onSelectPage;
  // 사이드바 계층 기준 이 페이지의 자식 목록(sort_order 순). 구조가 바뀔 때만 새 배열이 된다.
  const childPageIdsKey = getOrderedChildPageIds(pages, pageId).join("\u0000");
  const childPageIds = useMemo(
    () => (childPageIdsKey ? childPageIdsKey.split("\u0000") : []),
    [childPageIdsKey],
  );
  const childPageIdsRef = useRef(childPageIds);
  childPageIdsRef.current = childPageIds;
  useEffect(() => {
    for (const id of pendingTrashIdsRef.current) {
      if (!childPageIds.includes(id)) pendingTrashIdsRef.current.delete(id);
    }
    for (const id of pendingRemovalCheckIdsRef.current) {
      if (!childPageIds.includes(id)) pendingRemovalCheckIdsRef.current.delete(id);
    }
  }, [childPageIds]);
  useEffect(() => () => window.clearTimeout(removalCheckTimerRef.current), []);

  const collaborationDoc = useMemo(() => new Y.Doc(), [pageId]);
  // 협업 서버가 이 문서 접속을 거부하면, 빈 Yjs 문서로 편집하다가 DB 본문을 덮어쓰지 않도록
  // 협업 없이 DB 본문(initialContent)으로 편집기를 다시 연다.
  const [collaborationRejectedPageId, setCollaborationRejectedPageId] = useState<string | null>(null);
  // 웹 주소를 붙여 넣은 직후 띄우는 "링크 / 북마크 / 임베드" 메뉴
  const [linkPaste, setLinkPaste] = useState<LinkPasteState | null>(null);
  const collaborationRejected = collaborationRejectedPageId === pageId;
  const collaborationProvider = useMemo(() => {
    if (!collaborationEnabled || collaborationRejected) return null;
    return new HocuspocusProvider({
      url: resolveCollaborationWsUrl(authSession.serverHost),
      name: `page:${pageId}`,
      document: collaborationDoc,
      token: authSession.token,
      onAuthenticationFailed: ({ reason }) => {
        console.error(`[collaboration:${pageId}] authentication failed: ${reason}`);
        setCollaborationRejectedPageId(pageId);
      },
      onDisconnect: () => {
        console.warn(`[collaboration:${pageId}] disconnected`);
      },
    });
  }, [pageId, collaborationDoc, authSession.serverHost, authSession.token, collaborationRejected]);

  useEffect(() => {
    return () => {
      collaborationProvider?.destroy();
      collaborationDoc.destroy();
    };
  }, [collaborationProvider, collaborationDoc]);

  const normalizedPageWidth = normalizePageWidthValue(pageWidth);
  const pageWidthRef = useRef(normalizedPageWidth);
  pageWidthRef.current = normalizedPageWidth;
  const onSyncPageWidthFromYjsRef = useRef(onSyncPageWidthFromYjs);
  onSyncPageWidthFromYjsRef.current = onSyncPageWidthFromYjs;

  // Yjs 메타 맵을 통해 페이지 가로 사이즈(pageWidth)를 실시간 동기화
  useEffect(() => {
    const metaMap = collaborationDoc.getMap<string>("noty-page-meta");
    const applyRemoteWidth = () => {
      const remoteRaw = metaMap.get("pageWidth");
      if (typeof remoteRaw !== "string") return;
      const remoteWidth = normalizePageWidthValue(remoteRaw);
      if (remoteWidth !== pageWidthRef.current) {
        pageWidthRef.current = remoteWidth;
        onSyncPageWidthFromYjsRef.current?.(pageId, remoteWidth);
      }
    };
    const observer = (event: Y.YMapEvent<string>) => {
      if (event.transaction.local) return;
      if (event.keysChanged.has("pageWidth")) {
        applyRemoteWidth();
      }
    };
    metaMap.observe(observer);
    return () => {
      metaMap.unobserve(observer);
    };
  }, [collaborationDoc, pageId]);

  useEffect(() => {
    const metaMap = collaborationDoc.getMap<string>("noty-page-meta");
    const currentYjsWidth = metaMap.get("pageWidth");
    if (currentYjsWidth !== normalizedPageWidth) {
      metaMap.set("pageWidth", normalizedPageWidth);
    }
  }, [collaborationDoc, normalizedPageWidth]);

  const editorOptions: any = {
      initialContent,
      schema,
      dropCursor: multiColumnDropCursor,
      extensions: [syntaxHighlighter, backtickSupportExtension()],
      dictionary: {
        ...ko,
        math: mathLocales.ko,
        diagram: diagramLocales.ko,
        multi_column: multiColumnLocales.ko,
      },
      links: {
        isValidLink: (href: string) =>
          /^(https?:|mailto:|tel:|(?:noty|notion-like):\/\/page\/)/i.test(href),
        onClick: (event: any) => {
          const anchor = (event.target as HTMLElement | null)?.closest("a");
          const href = anchor?.getAttribute("href") ?? "";
          const targetPageId = parseInternalPageId(href, pagesByIdRef.current);
          if (targetPageId) {
            event.preventDefault();
            onSelectPageRef.current(targetPageId);
            return true;
          }
          return false;
        },
      },
      pasteHandler: ({ event, editor: currentEditor, defaultPasteHandler }: any) => {
        const plain = event.clipboardData?.getData("text/plain") ?? "";
        const targetPageId = parseInternalPageId(plain, pagesByIdRef.current);
        if (targetPageId) {
          currentEditor.insertInlineContent([
            {
              type: "pageLink",
              props: { pageId: targetPageId },
            },
            " ",
          ] as any);
          return true;
        }
        // 웹 주소 하나만 붙여 넣으면 링크로 넣고, 북마크·임베드로 바꿀지 고르는 메뉴를 띄운다
        const pastedUrl = /^\S+$/.test(plain.trim()) ? safeHttpUrl(plain.trim()) : null;
        const cursorBlock = (() => {
          try {
            return currentEditor.getTextCursorPosition().block;
          } catch {
            return null;
          }
        })();
        if (pastedUrl && cursorBlock && cursorBlock.type !== "codeBlock" && window.getSelection()?.isCollapsed !== false) {
          currentEditor.insertInlineContent([{ type: "link", href: pastedUrl, content: pastedUrl }, " "] as any);
          requestAnimationFrame(() => {
            const range = window.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0) : null;
            const rect = range?.getBoundingClientRect();
            if (rect) setLinkPaste({ blockId: cursorBlock.id, url: pastedUrl, x: rect.left, y: rect.bottom });
          });
          return true;
        }
        return defaultPasteHandler();
      },
      uploadFile: async (file: File) => {
        const saved = await workspaceApi.saveAttachment({
          name: file.name,
          type: file.type,
          bytes: new Uint8Array(await file.arrayBuffer()),
        });
        return saved.url;
      },
      resolveFileUrl: resolveUploadUrl,
    };

  const editor = useCreateBlockNote(
    collaborationProvider
      ? withCollaboration({
          ...editorOptions,
          collaboration: {
            provider: {
              awareness: collaborationProvider.awareness ?? undefined,
            },
            fragment: collaborationDoc.getXmlFragment("document-store"),
            user: {
              name: `${authSession.user.displayName} (@${authSession.user.username})`,
              color: getUserCollaborationColor(authSession.user.username),
            },
            showCursorLabels: "activity",
          },
        })
      : editorOptions,
    [
      pageId,
      collaborationProvider,
      authSession.user.username,
      authSession.user.displayName,
    ],
  ) as any;

  const [isBodyEmpty, setIsBodyEmpty] = useState(() => isDocumentBodyEmpty(editor.document));
  const [appliedTemplate, setAppliedTemplate] = useState<string | null>(null);
  useEffect(() => {
    if (!appliedTemplate) return;
    const timer = window.setTimeout(() => setAppliedTemplate(null), 6000);
    return () => window.clearTimeout(timer);
  }, [appliedTemplate]);

  // 템플릿 적용: 본문이 비었으면 제목 아래를 통째로 채우고, 아니면 커서 블록 뒤에 끼워 넣는다.
  // 편집기 API 로 바꾸므로 실시간 협업·저장·실행 취소가 평소처럼 이어진다.
  const lastTemplateNonceRef = useRef(templateApplyRequest?.nonce);
  useEffect(() => {
    if (!templateApplyRequest || templateApplyRequest.nonce === lastTemplateNonceRef.current || readOnly) return;
    lastTemplateNonceRef.current = templateApplyRequest.nonce;
    const { template } = templateApplyRequest;
    const blocks = template.blocks as any[];
    const doc = editor.document;
    const [first, ...rest] = doc;
    editor.transact(() => {
      if (!first) {
        editor.replaceBlocks(doc, [{ type: "heading", props: { level: 1 }, content: template.name }, ...blocks]);
        return;
      }
      if (Array.isArray(first.content) && !extractInlineText(first.content).trim()) {
        editor.updateBlock(first, { content: template.name });
      }
      if (isDocumentBodyEmpty(doc)) {
        if (rest.length > 0) editor.replaceBlocks(rest, blocks);
        else editor.insertBlocks(blocks, first, "after");
        return;
      }
      let anchor = doc[doc.length - 1];
      try {
        anchor = editor.getTextCursorPosition().block;
      } catch {
        // 커서가 없으면 문서 끝에 붙인다
      }
      editor.insertBlocks(blocks, anchor, "after");
    });
    setAppliedTemplate(template.name);
  }, [templateApplyRequest]);

  useEffect(() => {
    if (!onAIBridgeChange || readOnly) return;
    const bridge = createAIEditorBridge(editor, pageId);
    onAIBridgeChange(bridge);
    return () => onAIBridgeChange((current) => (current === bridge ? null : current));
  }, [editor, pageId, onAIBridgeChange, readOnly]);

  const isEditorReady = () =>
    editor.document.length > 0 && (!collaborationProvider || collaborationProvider.synced);

  const blocksWithCollectionSnapshots = (): readonly unknown[] => {
    const materialize = (blocks: readonly any[]): any[] =>
      blocks.map((block) => {
        const children = Array.isArray(block.children)
          ? materialize(block.children)
          : block.children;
        if (block.type !== "collection" || !collaborationProvider ||
          (typeof block.props?.dataJson === "string" && (() => {
            try { return Boolean(JSON.parse(block.props.dataJson).collectionId); } catch { return false; }
          })())) {
          return { ...block, children };
        }
        const shared = readCollectionMap(collectionMap(collaborationDoc, block.id));
        return shared
          ? {
              ...block,
              children,
              props: { ...block.props, dataJson: JSON.stringify(shared) },
            }
          : { ...block, children };
      });
    return materialize(editor.document);
  };

  /**
   * 본문의 page 블록 구조를 사이드바 계층(parentId + order)과 일치시킨다.
   * - 자식이 아닌 페이지를 가리키는 page 블록, 중복 page 블록 제거
   * - 본문에 없는 자식 페이지는 맨 끝에 추가
   * - reorder: page 블록이 놓인 자리는 그대로 두고 자리별 pageId 를 sort_order 순으로 바꿔 끼움
   * 에디터(=Yjs) 에 직접 반영하므로 협업 중인 다른 창에도 같은 결과가 전파된다.
   */
  const reconcileChildPageBlocks = (options: { reorder: boolean }) => {
    if (readOnly || reconcilingRef.current || suppressOnChangeRef.current) return;
    if (!isEditorReady()) return;

    const childIds = childPageIdsRef.current.filter((id) => !pendingTrashIdsRef.current.has(id));
    const childSet = new Set(childIds);
    reconcilingRef.current = true;
    try {
      const duplicates = collectDuplicateBlocks(editor.document);
      if (duplicates.length > 0) {
        editor.removeBlocks(duplicates);
      }

      const deletionArtifacts = collectDeletionArtifactParagraphs(editor.document);
      if (deletionArtifacts.length > 0) {
        editor.removeBlocks(deletionArtifacts);
      }

      const seen = new Set<string>();
      const toRemove: any[] = [];
      for (const ref of collectEditorPageBlocks(editor.document)) {
        if (!childSet.has(ref.pageId) || seen.has(ref.pageId)) {
          toRemove.push(ref.block);
        } else {
          seen.add(ref.pageId);
        }
      }
      if (toRemove.length > 0) {
        editor.removeBlocks(toRemove);
      }

      const missingChildIds = childIds.filter(
        (childId) => !seen.has(childId) && !pendingRemovalCheckIdsRef.current.has(childId),
      );
      if (missingChildIds.length > 0 && editor.document.length > 0) {
        const lastBlock = editor.document[editor.document.length - 1];
        const lastContent = lastBlock.content;
        const lastBlockIsEmptyParagraph =
          lastBlock.type === "paragraph" &&
          (lastContent === "" || !lastContent || (Array.isArray(lastContent) && lastContent.length === 0));
        editor.insertBlocks(
          missingChildIds.map((childId) => ({
            type: "page",
            props: { pageId: childId },
            content: [],
            children: [],
          })),
          lastBlock,
          lastBlockIsEmptyParagraph ? "before" : "after",
        );
      }

      if (options.reorder) {
        collectEditorPageBlocks(editor.document).forEach((ref, index) => {
          const desiredId = childIds[index];
          if (desiredId && ref.pageId !== desiredId) {
            editor.updateBlock(ref.block, { props: { pageId: desiredId } });
          }
        });
      }

    } finally {
      observedPageBlockIdsRef.current = new Set([
        ...collectEditorPageBlocks(editor.document).map((ref) => ref.pageId),
        ...pendingRemovalCheckIdsRef.current,
      ]);
      reconcilingRef.current = false;
    }
  };

  /**
   * 사용자가 에디터 안에서 page 블록 순서를 바꾼 경우(자식 집합은 같고 순서만 다름)
   * 사이드바 순서도 본문 순서에 맞춘다.
   */
  const syncSidebarOrderFromDocument = () => {
    if (!isEditorReady()) return;
    const childIds = childPageIdsRef.current;
    const docOrder = Array.from(
      new Set(collectEditorPageBlocks(editor.document).map((ref) => ref.pageId)),
    );
    if (docOrder.length !== childIds.length) return;
    const childSet = new Set(childIds);
    if (!docOrder.every((id) => childSet.has(id))) return;
    if (sameStringArray(docOrder, childIds)) return;
    childPageIdsRef.current = docOrder;
    onReorderChildPages(pageId, docOrder);
  };

  /**
   * 다른 사용자가 바꾼 본문(Yjs 원격 변경)의 page 블록 구조가 내 사이드바와 다르면
   * 내 페이지 목록이 오래된 것일 수 있으므로 서버에서 다시 받아온다. (원격 변경은 직접 보정하지 않아 핑퐁 방지)
   */
  const pagesRefreshTimerRef = useRef<number | undefined>(undefined);
  const requestPagesRefreshIfStructureDiffers = () => {
    const docOrder = Array.from(
      new Set(collectEditorPageBlocks(editor.document).map((ref) => ref.pageId)),
    );
    if (sameStringArray(docOrder, childPageIdsRef.current)) return;
    window.clearTimeout(pagesRefreshTimerRef.current);
    pagesRefreshTimerRef.current = window.setTimeout(() => onRequestPagesRefresh(), 600);
  };
  useEffect(() => () => window.clearTimeout(pagesRefreshTimerRef.current), []);

  // 사이드바 구조(자식 목록/순서)가 바뀌면 열린 본문에 바로 반영한다. (페이지 이동·순서 변경)
  useEffect(() => {
    reconcileChildPageBlocks({ reorder: true });
  }, [editor, childPageIds]);

  const initialContentRef = useRef(initialContent);
  initialContentRef.current = initialContent;

  useEffect(() => {
    if (!collaborationProvider) return;
    let cancelled = false;
    let timerId: number | undefined;
    const fragment = collaborationDoc.getXmlFragment("document-store");

    // 같은 문서를 여러 창(분할 창/다른 사용자)이 동시에 열었을 때 모두가 시드하면 본문이 중복되므로
    // awareness 상 clientID 가 가장 작은 참여자만 시드한다. (일정 시간 뒤에도 비어 있으면 직접 시드)
    const isSeedLeader = () => {
      const awareness = collaborationProvider.awareness;
      if (!awareness) return true;
      const myId = collaborationDoc.clientID;
      return Array.from(awareness.getStates().keys()).every((id) => id >= myId);
    };

    const trySeed = (attempt: number) => {
      if (cancelled) return;
      const content = initialContentRef.current;
      if (fragment.length === 0 && content.length > 0) {
        if (!isSeedLeader() && attempt < 5) {
          timerId = window.setTimeout(() => trySeed(attempt + 1), 400);
          return;
        }
        suppressOnChangeRef.current = true;
        try {
          editor.replaceBlocks(editor.document, content as any);
        } finally {
          suppressOnChangeRef.current = false;
        }
      }
      // 동기화 직후 저장된 Yjs 본문이 사이드바 구조와 어긋나 있으면 보정
      reconcileChildPageBlocks({ reorder: true });
    };

    const handleSynced = ({ state }: { state: boolean }) => {
      if (!state) return;
      window.clearTimeout(timerId);
      timerId = window.setTimeout(() => trySeed(0), 150);
    };
    collaborationProvider.on("synced", handleSynced);
    if (collaborationProvider.synced) {
      handleSynced({ state: true });
    }
    return () => {
      cancelled = true;
      window.clearTimeout(timerId);
      collaborationProvider.off("synced", handleSynced);
    };
  }, [collaborationProvider, collaborationDoc, editor]);

  const getPageBlockSlashItem = (): DefaultReactSuggestionItem => ({
    title: "페이지",
    subtext: "현재 위치에 하위 페이지 블록을 만들고 들어갑니다",
    aliases: ["page", "subpage", "페이지", "하위페이지", "문서"],
    group: "기본 블록",
    icon: <DocSvgIcon />,
    onItemClick: () => {
      void onInsertPageBlockAndOpen(pageId, (newChildId) => {
        if (!childPageIdsRef.current.includes(newChildId)) {
          childPageIdsRef.current = [...childPageIdsRef.current, newChildId];
        }
        observedPageBlockIdsRef.current.add(newChildId);
        suppressOnChangeRef.current = true;
        try {
          insertOrUpdateBlockForSlashMenu(editor, {
            type: "page",
            props: { pageId: newChildId },
          } as any);
        } finally {
          suppressOnChangeRef.current = false;
        }
        return editor.document;
      });
    },
  });

  const getCanvasBlockSlashItem = (): DefaultReactSuggestionItem => ({
    title: "캔버스",
    subtext: "현재 위치에 하위 캔버스를 만들고 엽니다 (본문에는 미리보기로 보임)",
    aliases: ["canvas", "whiteboard", "캔버스", "화이트보드", "보드판"],
    group: "기본 블록",
    icon: <CanvasSvgIcon />,
    onItemClick: () => {
      void onInsertPageBlockAndOpen(
        pageId,
        (newChildId) => {
          if (!childPageIdsRef.current.includes(newChildId)) {
            childPageIdsRef.current = [...childPageIdsRef.current, newChildId];
          }
          observedPageBlockIdsRef.current.add(newChildId);
          suppressOnChangeRef.current = true;
          try {
            insertOrUpdateBlockForSlashMenu(editor, {
              type: "page",
              props: { pageId: newChildId },
            } as any);
          } finally {
            suppressOnChangeRef.current = false;
          }
          return editor.document;
        },
        "canvas",
      );
    },
  });

  const getCollectionBlockSlashItem = (): DefaultReactSuggestionItem => ({
    title: "컬렉션",
    subtext: "속성을 직접 만들고 표·보드·캘린더·갤러리로 보는 데이터베이스",
    aliases: [
      "collection",
      "database",
      "table",
      "kanban",
      "board",
      "컬렉션",
      "데이터베이스",
      "표",
      "칸반",
      "보드",
    ],
    group: "기본 블록",
    icon: <CollectionSvgIcon />,
    onItemClick: () => {
      insertOrUpdateBlockForSlashMenu(editor, {
        type: "collection",
        props: {
          dataJson: JSON.stringify(createDefaultCollectionData("컬렉션")),
        },
      } as any);
    },
  });

  const getLinkedCollectionSlashItem = (): DefaultReactSuggestionItem => ({
    title: "연결된 데이터베이스",
    subtext: "다른 페이지의 데이터베이스를 현재 페이지에 연결합니다",
    aliases: ["연결된 컬렉션", "linked database"],
    group: "기본 블록",
    icon: <CollectionSvgIcon />,
    onItemClick: () => {
      insertOrUpdateBlockForSlashMenu(editor, {
        type: "collection",
        props: {
          dataJson: JSON.stringify({ ...createDefaultCollectionData("컬렉션"), pendingLink: true }),
        },
      } as any);
    },
  });

  const getPageMentionItems = (query: string): DefaultReactSuggestionItem[] => {
    const otherPages = pages.filter((item) => item.id !== pageId);
    const items: DefaultReactSuggestionItem[] = otherPages.map((target) => ({
      title: target.title || "제목 없는 문서",
      subtext: "문장 내 페이지 멘션",
      aliases: [target.title, target.id],
      group: "페이지 멘션",
      icon: <PageIconOrDoc icon={target.icon} />,
      onItemClick: () => {
        editor.insertInlineContent([
          {
            type: "pageLink",
            props: { pageId: target.id },
          },
          " ",
        ] as any);
      },
    }));

    return filterSuggestionItems(items, query);
  };

  return (
    <CollectionActionsContext.Provider
      value={{
        parentPageId: pageId,
        collaborationDoc: collaborationProvider ? collaborationDoc : undefined,
        collaborationProvider,
        onCollectionDataChange: () =>
          onSaveBlocks(
            pageId,
            blocksWithCollectionSnapshots(),
            extractDocumentTitle(editor.document),
          ),
        onOpenOrCreateRowPage: onOpenOrCreateCollectionRowPage,
      }}
    >
    <section
      className={`page ${normalizedPageWidth === "full" ? "page--full-width" : "page--constrained"}`}
      style={{ "--page-max-width": resolvePageMaxWidthCss(normalizedPageWidth) } as React.CSSProperties}
    >
      <div className="page__content">
      {collaborationRejected && (
        <div className="page__collab-notice" role="status">
          실시간 동기화 서버에 연결하지 못해 이 페이지를 혼자 편집 모드로 열었습니다. 변경 내용은 저장되지만 다른
          창이나 사용자와 실시간으로 공유되지 않습니다.
        </div>
      )}
      {readOnly && (
        <div className="page__collab-notice" role="status">
          읽기 전용 계정입니다. 페이지를 보고 AI에게 질문할 수 있지만, 수정·이동·삭제는 할 수 없습니다.
        </div>
      )}
      {linkPaste && !readOnly && <LinkPasteMenu editor={editor} state={linkPaste} onClose={() => setLinkPaste(null)} />}
      {isHistoryOpen && (
        <PageHistoryModal pageId={pageId} editor={editor} readOnly={readOnly} onClose={onCloseHistory} />
      )}
      <BlockNoteView
        editor={editor}
        editable={!readOnly}
        onChange={(_currentEditor: any, context: any) => {
          setIsBodyEmpty(isDocumentBodyEmpty(editor.document));
          if (suppressOnChangeRef.current || readOnly) return;
          // 구조 보정(reconcile) 도중 발생한 변경은 저장만 하고 다시 보정하지 않는다.
          if (!reconcilingRef.current) {
            let changes: any[] = [];
            try {
              changes = context?.getChanges?.() ?? [];
            } catch {
              changes = [];
            }
            const isRemoteOnly =
              changes.length > 0 &&
              changes.every((change) => change?.source?.type === "yjs-remote");
            if (isRemoteOnly) {
              observedPageBlockIdsRef.current = new Set(collectEditorPageBlocks(editor.document).map((ref) => ref.pageId));
              requestPagesRefreshIfStructureDiffers();
            } else {
              const currentIds = new Set(collectEditorPageBlocks(editor.document).map((ref) => ref.pageId));
              for (const id of currentIds) {
                pendingRemovalCheckIdsRef.current.delete(id);
              }
              const removedIds = [...observedPageBlockIdsRef.current].filter(
                (id) => childPageIdsRef.current.includes(id) && !currentIds.has(id) && !pendingTrashIdsRef.current.has(id),
              );
              if (removedIds.length > 0) {
                removedIds.forEach((id) => pendingRemovalCheckIdsRef.current.add(id));
                observedPageBlockIdsRef.current = new Set([
                  ...currentIds,
                  ...pendingRemovalCheckIdsRef.current,
                ]);
                window.clearTimeout(removalCheckTimerRef.current);
                removalCheckTimerRef.current = window.setTimeout(() => {
                  const liveIds = new Set(collectEditorPageBlocks(editor.document).map((ref) => ref.pageId));
                  for (const id of liveIds) {
                    pendingRemovalCheckIdsRef.current.delete(id);
                  }
                  const trulyRemovedIds = [...pendingRemovalCheckIdsRef.current].filter(
                    (id) =>
                      childPageIdsRef.current.includes(id) &&
                      !liveIds.has(id) &&
                      !pendingTrashIdsRef.current.has(id),
                  );
                  pendingRemovalCheckIdsRef.current.clear();
                  if (trulyRemovedIds.length === 0) {
                    observedPageBlockIdsRef.current = liveIds;
                    return;
                  }
                  trulyRemovedIds.forEach((id) => pendingTrashIdsRef.current.add(id));
                  observedPageBlockIdsRef.current = liveIds;
                  const blocks = blocksWithCollectionSnapshots();
                  const latestTitle = extractDocumentTitle(editor.document);
                  void onTrashPageBlocks(pageId, trulyRemovedIds, blocks, latestTitle).catch((error) => {
                    console.error("Failed to move page blocks to trash", error);
                    trulyRemovedIds.forEach((id) => pendingTrashIdsRef.current.delete(id));
                    reconcileChildPageBlocks({ reorder: false });
                  });
                }, 150);
                return;
              }
              observedPageBlockIdsRef.current = currentIds;
              syncSidebarOrderFromDocument();
              reconcileChildPageBlocks({ reorder: false });
            }
          }
          const title = extractDocumentTitle(editor.document);
          if (title) {
            onTitlePreviewChange(pageId, title);
          }
          // Yjs는 실시간 동기화를 담당하고 REST 스냅샷은 페이지 전환/재접속 시
          // 최신 본문을 복원하는 안전망으로 사용한다.
          onSaveBlocks(pageId, blocksWithCollectionSnapshots(), title);
        }}
        slashMenu={false}
        formattingToolbar={false}
        theme="light"
      >
        <FormattingToolbarController
          formattingToolbar={() => (
            <FormattingToolbar>
              {[...getFormattingToolbarItems(), ...(onAskAI && !readOnly ? [<AskAIToolbarButton key="ask-ai" onClick={onAskAI} />] : [])]}
            </FormattingToolbar>
          )}
        />
        <SuggestionMenuController
          triggerCharacter="/"
          getItems={async (query) =>
            filterSuggestionItems(
              combineByGroup(
                getDefaultReactSlashMenuItems(editor),
                [
                  getPageBlockSlashItem(),
                  getCanvasBlockSlashItem(),
                  getCollectionBlockSlashItem(),
                  getLinkedCollectionSlashItem(),
                ],
                getCalloutSlashMenuItems(editor),
                getLinkBlockSlashMenuItems(editor),
                getMultiColumnSlashMenuItems(editor),
                getMathSlashMenuItems(editor),
                getDiagramSlashMenuItems(editor),
              ),
              query,
            )
          }
        />
        <SuggestionMenuController
          triggerCharacter="@"
          getItems={async (query) => getPageMentionItems(query)}
        />
      </BlockNoteView>
      {templatePreview ? (
        <div className="template-ghost" aria-hidden="true">
          <div className="template-ghost__label">
            {templatePreview.icon} {templatePreview.name} 미리보기 · 누르면{" "}
            {isBodyEmpty ? "이 페이지에 적용" : "커서 위치에 삽입"}
          </div>
          <PreviewBlocks blocks={templatePreview.blocks as any[]} />
        </div>
      ) : (
        isBodyEmpty &&
        !readOnly &&
        onOpenTemplates && (
          <button type="button" className="template-start-hint" onClick={onOpenTemplates}>
            <TemplateSvgIcon />
            템플릿에서 시작
          </button>
        )
      )}
      {appliedTemplate && (
        <div className="template-toast" role="status">
          <span>“{appliedTemplate}” 템플릿을 적용했어요</span>
          <button
            type="button"
            onClick={() => {
              editor.undo();
              setAppliedTemplate(null);
            }}
          >
            실행 취소
          </button>
        </div>
      )}
      </div>
    </section>
    </CollectionActionsContext.Provider>
  );
}

/**
 * 캔버스 페이지 카드 안의 편집기: 페이지 화면과 같은 EditorPane 을 그대로 쓴다
 * (같은 블록 스키마·실시간 협업·저장 흐름이라 카드에서 고친 내용이 페이지와 항상 같다).
 */
function CanvasCardEditor({
  pageId,
  contextValue,
  editorProps,
}: {
  pageId: string;
  contextValue: WorkspacePagesContextValue;
  editorProps: Omit<EditorPaneProps, "pageId" | "initialContent" | "isHistoryOpen" | "onCloseHistory">;
}) {
  const [blocks, setBlocks] = useState<PartialBlock<any, any, any>[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    workspaceApi
      .loadDocument(pageId)
      .then(({ blocks: loaded }) => {
        if (cancelled) return;
        setBlocks(
          loaded
            ? normalizeStoredBlocks(loaded)
            : [
                { type: "heading", props: { level: 1 }, content: editorProps.pagesById.get(pageId)?.title || "제목 없는 문서" },
                { type: "paragraph", content: "" },
              ],
        );
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [pageId]);
  if (failed) return <div className="center-message">문서를 불러오지 못했습니다.</div>;
  if (!blocks) return <div className="center-message">불러오는 중…</div>;
  return (
    <WorkspacePagesContext.Provider value={contextValue}>
      <CollectionActionsContext.Provider value={{ parentPageId: pageId, onOpenOrCreateRowPage: editorProps.onOpenOrCreateCollectionRowPage }}>
        <EditorPane {...editorProps} pageId={pageId} initialContent={blocks} isHistoryOpen={false} onCloseHistory={() => undefined} />
      </CollectionActionsContext.Provider>
    </WorkspacePagesContext.Provider>
  );
}

interface PageTreeNodeProps {
  page: PageItem;
  pagesByParent: Map<string | null, PageItem[]>;
  activePageId: string;
  expandedIds: Set<string>;
  editingId: string | null;
  editingTitle: string;
  dropIndicator: DropIndicator | null;
  depth: number;
  isMultiSelectMode: boolean;
  selectedPageIds: Set<string>;
  onToggleSelectPage: (pageId: string, shiftKey: boolean) => void;
  onSelect: (id: string, options?: SelectPageOptions) => void;
  onToggleExpand: (id: string) => void;
  onStartRename: (page: PageItem) => void;
  onChangeEditingTitle: (value: string) => void;
  onCommitRename: (id: string) => void;
  onCancelRename: () => void;
  onCreateChild: (parentId: string) => void;
  onOpenContextMenu: (page: PageItem, x: number, y: number) => void;
  onOpenEmojiPicker: (pageId: string, x: number, y: number) => void;
  onDragStartPage: (id: string) => void;
  onUpdateDropIndicator: (indicator: DropIndicator | null) => void;
  onDropPage: (targetId: string, placement: DropPlacement) => void;
}

function PageTreeNode({
  page,
  pagesByParent,
  activePageId,
  expandedIds,
  editingId,
  editingTitle,
  dropIndicator,
  depth,
  isMultiSelectMode,
  selectedPageIds,
  onToggleSelectPage,
  onSelect,
  onToggleExpand,
  onStartRename,
  onChangeEditingTitle,
  onCommitRename,
  onCancelRename,
  onCreateChild,
  onOpenContextMenu,
  onOpenEmojiPicker,
  onDragStartPage,
  onUpdateDropIndicator,
  onDropPage,
}: PageTreeNodeProps) {
  const children = pagesByParent.get(page.id) ?? [];
  const hasChildren = children.length > 0;
  const isExpanded = expandedIds.has(page.id);
  const isActive = page.id === activePageId;
  const isEditing = editingId === page.id;
  const isSelected = selectedPageIds.has(page.id);
  const showCheckbox = isMultiSelectMode || selectedPageIds.size > 0;

  const isDropBefore =
    dropIndicator?.targetId === page.id && dropIndicator.placement === "before";
  const isDropInside =
    dropIndicator?.targetId === page.id && dropIndicator.placement === "inside";
  const isDropAfter =
    dropIndicator?.targetId === page.id && dropIndicator.placement === "after";

  const handleRowClick = (event: ReactMouseEvent) => {
    if (isEditing) return;
    if (event.shiftKey || showCheckbox) {
      event.preventDefault();
      onToggleSelectPage(page.id, event.shiftKey);
      return;
    }
    onSelect(page.id, {
      newTab: event.metaKey || event.ctrlKey,
      split: event.altKey,
    });
  };

  const handleAuxClick = (event: ReactMouseEvent) => {
    if (isEditing) return;
    if (event.button === 1) {
      event.preventDefault();
      onSelect(page.id, { newTab: true });
    }
  };

  const handleToggle = (event: ReactMouseEvent) => {
    event.stopPropagation();
    onToggleExpand(page.id);
  };

  const handleAddSubpage = (event: ReactMouseEvent) => {
    event.stopPropagation();
    onCreateChild(page.id);
  };

  const handleMoreButtonClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    onOpenContextMenu(page, rect.left, rect.bottom + 4);
  };

  const handleContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onOpenContextMenu(page, event.clientX, event.clientY);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      onCommitRename(page.id);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onCancelRename();
    }
  };

  const handleDragStart = (event: DragEvent<HTMLDivElement>) => {
    if (isEditing) {
      event.preventDefault();
      return;
    }
    event.stopPropagation();
    event.dataTransfer.effectAllowed = "copyMove";
    event.dataTransfer.setData("text/plain", page.id);
    // 캔버스에 끌어다 놓으면 페이지 카드가 된다
    event.dataTransfer.setData("application/x-noty-page", page.id);
    onDragStartPage(page.id);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";

    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientY - rect.top) / Math.max(rect.height, 1);
    // 캔버스 안(하위)으로는 넣지 않고 위·아래로만 놓는다
    const placement: DropPlacement =
      page.kind === "canvas"
        ? ratio < 0.5
          ? "before"
          : "after"
        : ratio < 0.25
          ? "before"
          : ratio > 0.75
            ? "after"
            : "inside";

    if (
      dropIndicator?.targetId !== page.id ||
      dropIndicator.placement !== placement
    ) {
      onUpdateDropIndicator({ targetId: page.id, placement });
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const placement =
      dropIndicator?.targetId === page.id ? dropIndicator.placement : page.kind === "canvas" ? "after" : "inside";
    onDropPage(page.id, placement);
  };

  return (
    <li className="tree-node">
      <div
        className={[
          "tree-item",
          isActive ? "tree-item--active" : "",
          isSelected ? "tree-item--selected" : "",
          isDropBefore ? "tree-item--drop-before" : "",
          isDropInside ? "tree-item--drop-inside" : "",
          isDropAfter ? "tree-item--drop-after" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        style={{ paddingLeft: `${8 + depth * 18}px` }}
        onClick={handleRowClick}
        onAuxClick={handleAuxClick}
        onContextMenu={handleContextMenu}
        draggable={!isEditing && !showCheckbox}
        onDragStart={handleDragStart}
        onDragEnd={() => {
          onDragStartPage("");
          onUpdateDropIndicator(null);
        }}
        onDragOver={handleDragOver}
        onDragLeave={() => {
          if (dropIndicator?.targetId === page.id) onUpdateDropIndicator(null);
        }}
        onDrop={handleDrop}
      >
        {showCheckbox && (
          <button
            type="button"
            className={`tree-checkbox ${isSelected ? "tree-checkbox--checked" : ""}`}
            onClick={(event) => {
              event.stopPropagation();
              onToggleSelectPage(page.id, event.shiftKey);
            }}
            aria-label={isSelected ? "선택 해제" : "페이지 선택"}
          >
            {isSelected && <CheckSvgIcon />}
          </button>
        )}

        {hasChildren && (
          <button
            type="button"
            className="ds-btn ds-btn--ghost ds-btn--icon tree-chevron-btn"
            onClick={handleToggle}
            aria-label={isExpanded ? "하위 페이지 접기" : "하위 페이지 펼치기"}
          >
            <ChevronSvgIcon expanded={isExpanded} />
          </button>
        )}

        <button
          type="button"
          className="tree-slot-static tree-slot-emoji-trigger"
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            onOpenEmojiPicker(page.id, rect.left, rect.bottom + 4);
          }}
          title="아이콘 변경"
          aria-label="페이지 아이콘 변경"
        >
          <PageIconOrDoc icon={page.icon} hasChildren={hasChildren} kind={page.kind} />
        </button>

        {isEditing ? (
          <input
            type="text"
            className="tree-rename-input"
            value={editingTitle}
            autoFocus
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => onChangeEditingTitle(event.target.value)}
            onBlur={() => onCommitRename(page.id)}
            onKeyDown={handleKeyDown}
          />
        ) : (
          <span className="tree-title">{page.title || "제목 없는 문서"}</span>
        )}

        {!isEditing && (
          <div className="tree-actions">
            <button
              type="button"
              className="ds-btn ds-btn--ghost ds-btn--icon tree-action-btn"
              onClick={(event) => {
                event.stopPropagation();
                onSelect(page.id, { split: true });
              }}
              title="우측 분할 화면으로 열기 (⌥+클릭)"
              aria-label="우측 분할 화면으로 열기"
            >
              <SplitPaneSvgIcon />
            </button>
            <button
              type="button"
              className="ds-btn ds-btn--ghost ds-btn--icon tree-action-btn"
              onClick={handleMoreButtonClick}
              title="삭제, 이름 바꾸기 등…"
              aria-label="더보기"
            >
              <MoreDotsSvgIcon />
            </button>
            {/* 캔버스 아래에는 페이지를 두지 않는다 (페이지는 카드로 올린다) */}
            {page.kind !== "canvas" && (
              <button
                type="button"
                className="ds-btn ds-btn--ghost ds-btn--icon tree-action-btn"
                data-requires-edit
                onClick={handleAddSubpage}
                title="하위 페이지 추가"
                aria-label="하위 페이지 추가"
              >
                <PlusSvgIcon />
              </button>
            )}
          </div>
        )}
      </div>

      {hasChildren && isExpanded && (
        <ul className="tree-list">
          {children.map((child) => (
            <PageTreeNode
              key={child.id}
              page={child}
              pagesByParent={pagesByParent}
              activePageId={activePageId}
              expandedIds={expandedIds}
              editingId={editingId}
              editingTitle={editingTitle}
              dropIndicator={dropIndicator}
              depth={depth + 1}
              isMultiSelectMode={isMultiSelectMode}
              selectedPageIds={selectedPageIds}
              onToggleSelectPage={onToggleSelectPage}
              onSelect={onSelect}
              onToggleExpand={onToggleExpand}
              onStartRename={onStartRename}
              onChangeEditingTitle={onChangeEditingTitle}
              onCommitRename={onCommitRename}
              onCancelRename={onCancelRename}
              onCreateChild={onCreateChild}
              onOpenContextMenu={onOpenContextMenu}
              onOpenEmojiPicker={onOpenEmojiPicker}
              onDragStartPage={onDragStartPage}
              onUpdateDropIndicator={onUpdateDropIndicator}
              onDropPage={onDropPage}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

interface DocumentRecord {
  pageId: string;
  revision: number;
  blocks: PartialBlock<any, any, any>[];
  path: string;
}

function createTabId(): string {
  return `tab-${Math.random().toString(36).slice(2, 10)}`;
}

function equalizeSplitRatios(count: number): number[] {
  if (count <= 1) return [100];
  if (count === 2) return [50, 50];
  const base = Number((100 / count).toFixed(2));
  const list = Array.from({ length: count }, () => base);
  const sum = list.reduce((a, b) => a + b, 0);
  list[count - 1] = Number((list[count - 1] + (100 - sum)).toFixed(2));
  return list;
}

function buildBreadcrumbsForPage(
  pageId: string,
  pagesById: Map<string, PageItem>,
): PageItem[] {
  const trail: PageItem[] = [];
  let current = pagesById.get(pageId);
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    trail.unshift(current);
    current = current.parentId ? pagesById.get(current.parentId) : undefined;
  }
  return trail;
}

function collectAncestorPageIds(
  pageId: string,
  pagesById: Map<string, PageItem>,
): string[] {
  const ancestors: string[] = [];
  const visited = new Set<string>();
  let current = pagesById.get(pageId);

  while (current?.parentId && !visited.has(current.parentId)) {
    visited.add(current.parentId);
    ancestors.push(current.parentId);
    current = pagesById.get(current.parentId);
  }

  return ancestors;
}

export default function App() {
  // 서버 호스트 및 사전 발급 계정 로그인 세션 상태
  const [authSession, setAuthSession] = useState<AuthSession | null>(() =>
    getStoredAuthSession(),
  );
  // 읽기 전용 계정: 페이지 생성·이동·삭제·이름 변경 같은 쓰기 동작을 화면에서 막는다 (서버도 막음).
  const isReadOnlyUser = authSession?.user.role === "viewer";
  const [loginServerHost, setLoginServerHost] = useState<string>(() =>
    getStoredServerHost(),
  );
  const [loginUsername, setLoginUsername] = useState<string>("");
  const [loginPassword, setLoginPassword] = useState<string>("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState<boolean>(false);
  const [serverPingStatus, setServerPingStatus] = useState<
    "idle" | "checking" | "ok" | "error"
  >("idle");
  const [serverPingMessage, setServerPingMessage] = useState<string>("");

  const [pages, setPages] = useState<PageItem[]>([]);
  const [documentsByPageId, setDocumentsByPageId] = useState<Record<string, DocumentRecord>>({});
  const [saveStatesByPageId, setSaveStatesByPageId] = useState<Record<string, SaveState>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isWorkspaceReady, setIsWorkspaceReady] = useState(false);

  // 마지막으로 작업하던 페이지 ID (개인 홈 대시보드 표시용)
  const [lastActivePageId, setLastActivePageId] = useState<string | null>(null);

  // 노션 데스크톱 스타일 멀티 탭 & 1~3단 분할 뷰 상태
  const [tabs, setTabs] = useState<WorkspaceTabItem[]>([
    { id: "tab-home", pageId: HOME_PAGE_ID },
  ]);
  const [activeTabId, setActiveTabId] = useState<string>("tab-home");
  const [splitTabIds, setSplitTabIds] = useState<string[]>(["tab-home"]);
  const [splitRatios, setSplitRatios] = useState<number[]>([100]);

  // 탭 드래그 & 분할 리사이즈 상태
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [resizingSplitIndex, setResizingSplitIndex] = useState<number | null>(null);
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const splitResizeStartRef = useRef<{
    index: number;
    startX: number;
    initialRatios: number[];
  } | null>(null);

  // 사이드바 상태 (열림/닫힘, 드래그 리사이즈 폭)
  const [isSidebarOpen, setIsSidebarOpen] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth > 820 : true,
  );
  const [sidebarWidth, setSidebarWidth] = useState<number>(240);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let wasNarrow = window.innerWidth <= 820;
    const handleResize = () => {
      const isNarrow = window.innerWidth <= 820;
      if (isNarrow !== wasNarrow) {
        wasNarrow = isNarrow;
        setIsSidebarOpen(!isNarrow);
      }
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // 검색 모달 (⌘K) 및 설정 모달 (⌘,), 관리자 모달 상태
  const [isSearchModalOpen, setIsSearchModalOpen] = useState(false);
  const [isGraphOpen, setIsGraphOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  // 우측 AI 어시스턴트 패널 (⌘J)
  const [isAIPanelOpen, setIsAIPanelOpen] = useState(false);
  // 우측 템플릿 패널 (AI 패널과 같은 자리라 하나만 연다)
  const [isTemplatePanelOpen, setIsTemplatePanelOpen] = useState(false);
  const [templatePreview, setTemplatePreview] = useState<PageTemplate | null>(null);
  const [templateApplyRequest, setTemplateApplyRequest] = useState<{ template: PageTemplate; nonce: number } | null>(null);
  const [aiEditorBridge, setAIEditorBridge] = useState<AIEditorBridge | null>(null);
  const [aiFocusNonce, setAIFocusNonce] = useState(0);
  const openAIForSelection = useCallback(() => {
    setIsAIPanelOpen(true);
    setAIFocusNonce((n) => n + 1);
  }, []);
  useEffect(() => {
    if (isAIPanelOpen) setIsTemplatePanelOpen(false);
  }, [isAIPanelOpen]);
  useEffect(() => {
    if (!isTemplatePanelOpen) setTemplatePreview(null);
  }, [isTemplatePanelOpen]);
  const openTemplatePanel = () => {
    setIsAIPanelOpen(false);
    setIsTemplatePanelOpen(true);
  };
  const [isImportOpen, setIsImportOpen] = useState(false);
  // 가져오기를 마친 뒤 열 페이지: 새 페이지 목록이 들어온 다음에 연다
  const [pendingOpenPageId, setPendingOpenPageId] = useState<string | null>(null);
  const [userTemplates, setUserTemplates] = useState<PageTemplate[]>([]);
  const toPageTemplate = (record: UserTemplateRecord): PageTemplate => ({ ...record, category: USER_TEMPLATE_CATEGORY });
  // 로그인하면 내 템플릿을 불러온다. 서버 저장 전에 이 브라우저에 저장해 둔 템플릿이 있으면 한 번 서버로 옮긴다.
  useEffect(() => {
    setUserTemplates([]);
    if (!authSession) return;
    let cancelled = false;
    (async () => {
      const legacy = isReadOnlyUser ? [] : takeLegacyUserTemplates();
      if (legacy.length > 0) {
        // 오래된 것부터 올려야 목록(최신순)이 예전 순서와 같다
        for (const t of [...legacy].reverse()) {
          await workspaceApi.createTemplate({ name: t.name, icon: t.icon, description: t.description ?? "", blocks: t.blocks });
        }
        clearLegacyUserTemplates();
      }
      const { templates } = await workspaceApi.listTemplates();
      if (!cancelled) setUserTemplates(templates.map(toPageTemplate));
    })().catch((error) => console.error("Failed to load templates", error));
    return () => {
      cancelled = true;
    };
  }, [authSession?.token, authSession?.serverHost]);
  // 템플릿 저장 창: 새로 저장 / 덮어쓰기는 페이지 본문(blocks)을, 이름 바꾸기는 기존 템플릿만 들고 연다.
  const [templateDialog, setTemplateDialog] = useState<{
    template?: PageTemplate;
    blocks?: unknown[];
    initial: { name: string; icon: string; description: string };
  } | null>(null);
  /** 열린 편집기의 미저장 변경까지 저장한 뒤 서버의 최신 본문을 읽는다 */
  const loadBlocksForTemplate = async (pageId: string): Promise<unknown[]> => {
    await flushAllPendingSaves();
    const { blocks } = await workspaceApi.loadDocument(pageId);
    return blocks ?? [];
  };
  const openSaveTemplateDialog = async (pageId: string, template?: PageTemplate) => {
    try {
      const blocks = await loadBlocksForTemplate(pageId);
      const page = pagesById.get(pageId);
      setTemplateDialog({
        template,
        blocks,
        initial: template
          ? { name: template.name, icon: template.icon, description: template.description }
          : { name: page?.title || "새 템플릿", icon: page?.icon || "📄", description: "" },
      });
    } catch (error) {
      console.error("Failed to read page for template", error);
    }
  };
  const [aiConceptRequest, setAIConceptRequest] = useState<{ id: string; nonce: number } | null>(null);
  const [aiStatusVersion, setAIStatusVersion] = useState(0);
  const [isTrashOpen, setIsTrashOpen] = useState(false);
  const [trashPages, setTrashPages] = useState<TrashedPageItem[]>([]);
  const [trashError, setTrashError] = useState<string | null>(null);
  const [trashBusyId, setTrashBusyId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchSelectedIndex, setSearchSelectedIndex] = useState(0);

  // 트리 및 컨텍스트 메뉴 상태
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set(["welcome"]));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState<string>("");
  const [draggingPageId, setDraggingPageId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [emojiPicker, setEmojiPicker] = useState<EmojiPickerState | null>(null);
  const [pageWidthMenu, setPageWidthMenu] = useState<PageWidthMenuState | null>(null);
  // 페이지 기록 창을 연 분할 창(탭) id
  const [historyTabId, setHistoryTabId] = useState<string | null>(null);
  const closeHistory = useCallback(() => setHistoryTabId(null), []);
  const [customEmojiInput, setCustomEmojiInput] = useState<string>("");

  // 사이드바 다중 선택 및 일괄 삭제 상태
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);
  const [selectedPageIds, setSelectedPageIds] = useState<Set<string>>(() => new Set());
  const lastSelectedPageIdRef = useRef<string | null>(null);

  // 페이지별 독립 자동 저장 큐 (다중 분할 창 동시 편집 지원)
  const pendingSavesRef = useRef<
    Map<
      string,
      {
        blocks: readonly unknown[];
        title?: string;
        timerId?: number;
      }
    >
  >(new Map());
  const pendingTitleSavesRef = useRef<Map<string, number>>(new Map());
  const pendingPageWidthSavesRef = useRef<Map<string, number>>(new Map());
  const saveVersionsRef = useRef<Map<string, number>>(new Map());
  const layoutSaveTimerRef = useRef<number | undefined>(undefined);

  const activeTab = useMemo(
    () => tabs.find((item) => item.id === activeTabId) ?? tabs[0],
    [tabs, activeTabId],
  );
  const activePageId = activeTab?.pageId ?? "welcome";

  const flushPendingSaveForPage = async (pageId: string) => {
    if (!pageId || !pageId.trim()) return;
    const entry = pendingSavesRef.current.get(pageId);
    if (!entry) return;
    if (entry.timerId !== undefined) {
      window.clearTimeout(entry.timerId);
    }
    pendingSavesRef.current.delete(pageId);

    try {
      setSaveStatesByPageId((prev) => ({ ...prev, [pageId]: "saving" }));
      const result = await workspaceApi.saveDocument(entry.blocks, {
        id: pageId,
        title: entry.title,
      });
      if (result.pages) {
        setPages(result.pages);
      }
      setSaveStatesByPageId((prev) => ({ ...prev, [pageId]: "saved" }));
    } catch (error) {
      console.error(error);
      setSaveStatesByPageId((prev) => ({ ...prev, [pageId]: "error" }));
    }
  };

  const flushAllPendingSaves = async () => {
    const pageIds = Array.from(pendingSavesRef.current.keys());
    await Promise.all(pageIds.map((id) => flushPendingSaveForPage(id)));
  };

  const loadPageContent = async (
    pageId: string,
    fallbackTitle?: string,
    options?: { keepRevision?: boolean },
  ) => {
    if (!pageId || !pageId.trim()) return;
    setSaveStatesByPageId((prev) => ({ ...prev, [pageId]: "loading" }));
    try {
      const { blocks, path } = await workspaceApi.loadDocument(pageId);
      const defaultBlocks: PartialBlock<any, any, any>[] =
        pageId === "welcome"
          ? initialDocument
          : [
              {
                type: "heading",
                props: { level: 1 },
                content: fallbackTitle || "제목 없는 문서",
              },
              {
                type: "paragraph",
                content: "",
              },
            ];
      setDocumentsByPageId((prev) => ({
        ...prev,
        [pageId]: {
          pageId,
          // keepRevision: 이미 열린 에디터를 다시 마운트하지 않고 캐시만 최신화한다.
          // (열린 에디터의 page 블록 구조는 EditorPane 의 reconcile 이 직접 맞춘다.)
          revision:
            options?.keepRevision && prev[pageId]
              ? prev[pageId].revision
              : (prev[pageId]?.revision ?? 0) + 1,
          blocks: blocks ? normalizeStoredBlocks(blocks) : defaultBlocks,
          path,
        },
      }));
      setSaveStatesByPageId((prev) => ({ ...prev, [pageId]: "saved" }));
    } catch (error) {
      console.error(error);
      setLoadError("API 서버 또는 PostgreSQL 데이터베이스에서 문서를 불러오지 못했습니다.");
    }
  };

  const handleCheckServerHost = async (targetHost = loginServerHost) => {
    setServerPingStatus("checking");
    setServerPingMessage("서버 연결 확인 중…");
    try {
      const res = await workspaceApi.checkServerHealth(targetHost);
      setLoginServerHost(res.normalizedHost);
      setServerPingStatus("ok");
      setServerPingMessage(
        `${res.serverName || "Noty Server"} 연결됨 (${res.normalizedHost})`,
      );
      return true;
    } catch (error) {
      setServerPingStatus("error");
      setServerPingMessage(
        error instanceof Error
          ? `서버에 연결할 수 없습니다 (${normalizeServerHost(targetHost)})`
          : "서버 연결 실패",
      );
      return false;
    }
  };

  const handleLoginSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const cleanHost = normalizeServerHost(loginServerHost);
    const cleanUser = loginUsername.trim();
    if (!cleanHost) {
      setLoginError("연결할 서버 호스트 주소를 입력해 주세요.");
      return;
    }
    if (!cleanUser || !loginPassword) {
      setLoginError("발급받은 아이디와 비밀번호를 입력해 주세요.");
      return;
    }

    setIsLoggingIn(true);
    setLoginError(null);
    try {
      const session = await workspaceApi.login({
        serverHost: cleanHost,
        username: cleanUser,
        password: loginPassword,
      });
      // 데스크톱 앱의 로그인 화면(앱에 묶인 file://)이면, 서버가 제공하는 최신 웹 화면으로 옮겨 간다.
      if (window.location.protocol === "file:" && window.desktop?.openServer) {
        const moved = await window.desktop.openServer(session.serverHost, session).catch(() => false);
        if (moved) {
          // 세션은 서버 화면으로 넘겼다. 여기(file://)에 남기면 로그아웃 후 돌아왔을 때 옛 세션으로 열린다.
          clearAuthSession(true);
          return;
        }
      }
      setLoginServerHost(session.serverHost);
      setLoginPassword("");
      setPages([]);
      setDocumentsByPageId({});
      setSaveStatesByPageId({});
      setLoadError(null);
      setIsWorkspaceReady(false);
      setAuthSession(session);
    } catch (error) {
      console.error(error);
      setLoginError(
        error instanceof Error
          ? error.message
          : "로그인에 실패했습니다. 서버 호스트 주소와 계정 정보를 확인해 주세요.",
      );
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    try {
      await flushAllPendingSaves();
    } catch {
      // ignore flush error during logout
    }
    await workspaceApi.logout();
    // 데스크톱 앱의 서버 화면이면 앱에 묶인 로그인 화면으로 돌아간다 (그 밖에서는 아무 일도 하지 않음).
    await window.desktop?.leaveServer?.().catch(() => undefined);
    setIsSettingsModalOpen(false);
    setIsSearchModalOpen(false);
    setContextMenu(null);
    setEmojiPicker(null);
    setPages([]);
    setDocumentsByPageId({});
    setSaveStatesByPageId({});
    setLoadError(null);
    setIsWorkspaceReady(false);
    setLoginError(null);
    setAuthSession(null);
  };

  // 로그인 세션이 있을 때만 초기 페이지 목록 및 PostgreSQL 탭/분할 레이아웃 복원
  useEffect(() => {
    if (!authSession) {
      setIsWorkspaceReady(false);
      return;
    }

    let cancelled = false;
    setLoadError(null);
    setIsWorkspaceReady(false);

    workspaceApi
      .getMe(authSession)
      .then(() => workspaceApi.listPages())
      .then(async ({ pages: loadedPages, activePageId: initialActiveId, layoutState }) => {
        if (cancelled) return;
        setPages(loadedPages);

        if (loadedPages.length === 0) {
          const homeTab: WorkspaceTabItem = { id: "tab-home", pageId: HOME_PAGE_ID };
          setLastActivePageId(null);
          setExpandedIds(new Set());
          setTabs([homeTab]);
          setActiveTabId(homeTab.id);
          setSplitTabIds([homeTab.id]);
          setSplitRatios([100]);
          setDocumentsByPageId({});
          setSaveStatesByPageId({});
          setIsWorkspaceReady(true);
          return;
        }

        const validMap = new Map(loadedPages.map((p) => [p.id, p]));
        const fallbackCandidate =
          loadedPages.find((item) => item.id === initialActiveId) || loadedPages[0];
        const fallbackId = fallbackCandidate ? fallbackCandidate.id : "welcome";

        // 마지막으로 작업하던 페이지 ID 복원
        const storedLastPage =
          localStorage.getItem(`noty_last_page_${authSession.user.id}`) ||
          initialActiveId ||
          (fallbackCandidate ? fallbackCandidate.id : null);
        if (storedLastPage) {
          setLastActivePageId(storedLastPage);
        }
        // 사이드바는 접힌 채로 시작하고, 마지막으로 보던 페이지까지의 경로만 펼친다.
        setExpandedIds(new Set(storedLastPage ? collectAncestorPageIds(storedLastPage, validMap) : []));

        let initialTabs: WorkspaceTabItem[];
        let initialActiveTabId: string;
        let initialSplitTabIds: string[];
        let initialSplitRatios: number[];

        if (layoutState && layoutState.tabs.length > 0) {
          const seenTabIds = new Set<string>();
          let restoredHomeTab = false;
          initialTabs = layoutState.tabs.filter((tab) => {
            if (!tab.id || seenTabIds.has(tab.id)) return false;
            if (tab.pageId === HOME_PAGE_ID) {
              if (restoredHomeTab) return false;
              restoredHomeTab = true;
            }
            seenTabIds.add(tab.id);
            return (
              tab.pageId === "" ||
              tab.pageId === HOME_PAGE_ID ||
              validMap.has(tab.pageId)
            );
          });
          const hasHomeTab = initialTabs.some((t) => t.pageId === HOME_PAGE_ID);
          if (!hasHomeTab) {
            const homeTabId = seenTabIds.has("tab-home") ? createTabId() : "tab-home";
            initialTabs = [{ id: homeTabId, pageId: HOME_PAGE_ID }, ...initialTabs];
          }
          const initialTabIds = new Set(initialTabs.map((tab) => tab.id));
          initialActiveTabId = initialTabIds.has(layoutState.activeTabId)
            ? layoutState.activeTabId
            : initialTabs[0].id;
          initialSplitTabIds = Array.from(
            new Set(
              (layoutState.splitTabIds ?? []).filter((tabId) => initialTabIds.has(tabId)),
            ),
          ).slice(0, 3);
          if (!initialSplitTabIds.includes(initialActiveTabId)) {
            initialSplitTabIds = [initialActiveTabId, ...initialSplitTabIds].slice(0, 3);
          }
          if (initialSplitTabIds.length === 0) {
            initialSplitTabIds = [initialActiveTabId];
          }
          initialSplitRatios =
            layoutState.splitRatios?.length === initialSplitTabIds.length
              ? layoutState.splitRatios
              : equalizeSplitRatios(initialSplitTabIds.length);
        } else {
          const homeTab: WorkspaceTabItem = { id: "tab-home", pageId: HOME_PAGE_ID };
          initialTabs = [homeTab];
          initialActiveTabId = homeTab.id;
          initialSplitTabIds = [homeTab.id];
          initialSplitRatios = [100];
        }

        setTabs(initialTabs);
        setActiveTabId(initialActiveTabId);
        setSplitTabIds(initialSplitTabIds);
        setSplitRatios(initialSplitRatios);

        const pagesToLoad = new Set<string>();
        for (const tab of initialTabs) {
          if (
            tab.pageId &&
            tab.pageId !== HOME_PAGE_ID &&
            (initialSplitTabIds.includes(tab.id) || tab.id === initialActiveTabId)
          ) {
            pagesToLoad.add(tab.pageId);
          }
        }
        await Promise.all(
          Array.from(pagesToLoad).map((pid) => loadPageContent(pid, validMap.get(pid)?.title)),
        );
        if (!cancelled) {
          setIsWorkspaceReady(true);
        }
      })
      .catch((error: unknown) => {
        console.error(error);
        if (cancelled) return;
        if (error instanceof UnauthorizedApiError) {
          clearAuthSession(true);
          setAuthSession(null);
          setLoginError("세션이 만료되었거나 유효하지 않습니다. 다시 로그인해 주세요.");
          return;
        }
        setLoadError(
          `서버(${authSession.serverHost})에 연결하지 못했습니다. 서버 실행 상태를 확인하거나 다른 서버 호스트로 로그인해 주세요.`,
        );
      });

    return () => {
      cancelled = true;
      for (const entry of pendingSavesRef.current.values()) {
        if (entry.timerId !== undefined) window.clearTimeout(entry.timerId);
      }
      for (const timerId of pendingTitleSavesRef.current.values()) {
        window.clearTimeout(timerId);
      }
      window.clearTimeout(layoutSaveTimerRef.current);
    };
  }, [authSession?.token, authSession?.serverHost]);

  // 화면에 표시되는 탭의 문서가 아직 로드되지 않았다면 즉시 로드
  useEffect(() => {
    if (!isWorkspaceReady) return;
    for (const tabId of splitTabIds) {
      const tab = tabs.find((t) => t.id === tabId);
      if (tab && tab.pageId && !documentsByPageId[tab.pageId]) {
        const pageMeta = pages.find((p) => p.id === tab.pageId);
        void loadPageContent(tab.pageId, pageMeta?.title);
      }
    }
  }, [isWorkspaceReady, splitTabIds, tabs, documentsByPageId, pages]);

  // 탭 및 분할 뷰 상태 변경 시 PostgreSQL(workspace_state)에 디바운스 저장
  useEffect(() => {
    if (!isWorkspaceReady) return;
    window.clearTimeout(layoutSaveTimerRef.current);
    const payload: WorkspaceLayoutState = {
      tabs,
      activeTabId,
      splitTabIds,
      splitRatios,
    };
    layoutSaveTimerRef.current = window.setTimeout(() => {
      void workspaceApi.saveWorkspaceLayout(payload).catch((err) => console.error(err));
    }, 350);
  }, [isWorkspaceReady, tabs, activeTabId, splitTabIds, splitRatios]);

  // 사이드바 우측 경계선 드래그 리사이즈
  useEffect(() => {
    if (!isResizingSidebar) return;

    const handleMouseMove = (event: MouseEvent) => {
      const nextWidth = Math.min(420, Math.max(190, event.clientX));
      setSidebarWidth(nextWidth);
    };

    const handleMouseUp = () => {
      setIsResizingSidebar(false);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizingSidebar]);

  // 분할 패널(2단 / 3단) 사이 경계선 드래그 리사이즈
  useEffect(() => {
    if (resizingSplitIndex === null) return;

    const handleMouseMove = (event: MouseEvent) => {
      const startInfo = splitResizeStartRef.current;
      const container = splitContainerRef.current;
      if (!startInfo || !container) return;

      const rect = container.getBoundingClientRect();
      if (rect.width <= 0) return;

      const deltaPercent = ((event.clientX - startInfo.startX) / rect.width) * 100;
      const idx = startInfo.index;
      const nextRatios = [...startInfo.initialRatios];
      if (idx < 0 || idx + 1 >= nextRatios.length) return;

      const minRatio = 18;
      const combined = startInfo.initialRatios[idx] + startInfo.initialRatios[idx + 1];
      const leftRatio = Math.min(
        combined - minRatio,
        Math.max(minRatio, startInfo.initialRatios[idx] + deltaPercent),
      );
      const rightRatio = combined - leftRatio;

      nextRatios[idx] = Number(leftRatio.toFixed(2));
      nextRatios[idx + 1] = Number(rightRatio.toFixed(2));
      setSplitRatios(nextRatios);
    };

    const handleMouseUp = () => {
      setResizingSplitIndex(null);
      splitResizeStartRef.current = null;
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [resizingSplitIndex]);

  const pagesById = useMemo(() => {
    const map = new Map<string, PageItem>();
    for (const page of pages) map.set(page.id, page);
    return map;
  }, [pages]);

  const pagesByParent = useMemo(() => {
    const map = new Map<string | null, PageItem[]>();
    for (const page of pages) {
      const parentKey = page.parentId && pagesById.has(page.parentId) ? page.parentId : null;
      const group = map.get(parentKey) ?? [];
      group.push(page);
      map.set(parentKey, group);
    }
    for (const group of map.values()) {
      group.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    }
    return map;
  }, [pages, pagesById]);

  const visibleTreePageIds = useMemo(() => {
    const ordered: string[] = [];
    const visit = (parentId: string | null) => {
      const list = pagesByParent.get(parentId) ?? [];
      for (const item of list) {
        ordered.push(item.id);
        if (expandedIds.has(item.id)) {
          visit(item.id);
        }
      }
    };
    visit(null);
    return ordered;
  }, [pagesByParent, expandedIds]);

  const filteredModalPages = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return pages;
    return pages.filter((page) => page.title.toLowerCase().includes(q));
  }, [pages, searchQuery]);

  // ⌘K: 제목 일치(즉시) + 본문·파일 내용(서버 통합 검색)을 하나의 목록으로 키보드 탐색한다.
  const workspaceSearch = useWorkspaceSearch(isSearchModalOpen ? searchQuery : "");
  const searchModalItems = useMemo(() => {
    const hasQuery = searchQuery.trim().length > 0;
    const titleItems = (hasQuery ? filteredModalPages.slice(0, 8) : filteredModalPages).map((page) => ({
      type: "page" as const,
      key: `page:${page.id}`,
      pageId: page.id,
      page,
    }));
    const contentItems = hasQuery
      ? (workspaceSearch.response?.results ?? [])
          .filter((result) => pagesById.has(result.pageId))
          .map((result) => ({
            type: "content" as const,
            key: `content:${result.pageId}`,
            pageId: result.pageId,
            result,
          }))
      : [];
    // LLM 위키 개념 (여러 페이지를 종합한 정리)
    const conceptItems = hasQuery
      ? (workspaceSearch.response?.concepts ?? []).map((concept) => ({
          type: "concept" as const,
          key: `concept:${concept.id}`,
          concept,
        }))
      : [];
    return { titleItems, conceptItems, contentItems, all: [...titleItems, ...conceptItems, ...contentItems] };
  }, [filteredModalPages, pagesById, searchQuery, workspaceSearch.response]);

  const openSearchItem = (
    item: (typeof searchModalItems.all)[number],
    options: { newTab?: boolean; split?: boolean },
  ) => {
    setIsSearchModalOpen(false);
    if (item.type === "concept") {
      setIsAIPanelOpen(true);
      setAIConceptRequest({ id: item.concept.id, nonce: Date.now() });
      return;
    }
    void handleSelectPage(item.pageId, options);
    if (item.type === "content" && item.result.blockId) revealBlockWhenReady(item.result.blockId);
  };

  // 새 탭 열기 (pageId가 빈 문자열이면 페이지 선택 화면으로 시작)
  const handleOpenInNewTab = async (pageId = "", activate = true) => {
    if (pageId) {
      const target = pagesById.get(pageId);
      if (!target) return;
      if (!documentsByPageId[pageId]) {
        void loadPageContent(pageId, target.title);
      }
    }
    const newTab: WorkspaceTabItem = { id: createTabId(), pageId };
    setTabs((prev) => [...prev, newTab]);
    if (activate) {
      setSplitTabIds((prev) => {
        if (prev.length <= 1) return [newTab.id];
        const idx = prev.indexOf(activeTabId);
        if (idx === -1) return [...prev.slice(0, -1), newTab.id];
        const copy = [...prev];
        copy[idx] = newTab.id;
        return copy;
      });
      setActiveTabId(newTab.id);
    }
  };

  // 우측에 새로운 분할 창 추가 (다른 열린 탭이 있으면 우선 배치, 없으면 페이지 선택 창 오픈)
  const handleAddSplitPane = (afterTabId?: string) => {
    const visiblePageIds = new Set(
      splitTabIds
        .map((id) => tabs.find((t) => t.id === id)?.pageId)
        .filter((pid): pid is string => Boolean(pid)),
    );

    const otherOpenTab = tabs.find(
      (t) =>
        !splitTabIds.includes(t.id) &&
        (!t.pageId || !visiblePageIds.has(t.pageId)),
    );

    let chosenTab: WorkspaceTabItem;
    if (otherOpenTab) {
      chosenTab = otherOpenTab;
      if (chosenTab.pageId && !documentsByPageId[chosenTab.pageId]) {
        void loadPageContent(
          chosenTab.pageId,
          pagesById.get(chosenTab.pageId)?.title,
        );
      }
    } else {
      chosenTab = { id: createTabId(), pageId: "" };
      const created = chosenTab;
      setTabs((prev) => [...prev, created]);
    }

    const chosenTabId = chosenTab.id;
    setSplitTabIds((prev) => {
      if (prev.includes(chosenTabId)) return prev;
      let next: string[];
      if (prev.length >= 3) {
        next = [...prev.slice(0, 2), chosenTabId];
      } else if (afterTabId && prev.includes(afterTabId)) {
        const idx = prev.indexOf(afterTabId);
        next = [...prev.slice(0, idx + 1), chosenTabId, ...prev.slice(idx + 1)];
      } else {
        next = [...prev, chosenTabId];
      }
      setSplitRatios(equalizeSplitRatios(next.length));
      return next;
    });
    setActiveTabId(chosenTabId);
  };

  // 특정 페이지를 우측 분할 화면(최대 3단)으로 나란히 열기
  const handleOpenInSplitPane = async (pageId: string, afterTabId?: string, knownPage?: PageItem) => {
    const target = knownPage ?? pagesById.get(pageId);
    if (!target) return;
    if (!documentsByPageId[pageId]) {
      void loadPageContent(pageId, target.title);
    }

    // 현재 분할 창 중 빈 선택 대기 창(pageId === "")이 있으면 그 자리에 바로 열기
    const emptySplitTab = splitTabIds
      .map((id) => tabs.find((t) => t.id === id))
      .find((t): t is WorkspaceTabItem => Boolean(t && t.pageId === ""));
    if (emptySplitTab) {
      setTabs((prev) =>
        prev.map((t) => (t.id === emptySplitTab.id ? { ...t, pageId } : t)),
      );
      setActiveTabId(emptySplitTab.id);
      return;
    }

    // 이미 해당 페이지가 분할 화면 중 하나에 열려 있으면 그 창으로 포커스
    const alreadyVisibleTab = splitTabIds
      .map((id) => tabs.find((t) => t.id === id))
      .find((t): t is WorkspaceTabItem => Boolean(t && t.pageId === pageId));
    if (alreadyVisibleTab && splitTabIds.length > 1) {
      setActiveTabId(alreadyVisibleTab.id);
      return;
    }

    // 이미 열린 탭 중 현재 분할 화면에 떠 있지 않은 탭이 있으면 재사용, 없으면 새 탭 생성
    let targetTab = tabs.find(
      (t) => t.pageId === pageId && !splitTabIds.includes(t.id),
    );
    if (!targetTab) {
      targetTab = { id: createTabId(), pageId };
      const createdTab = targetTab;
      setTabs((prev) => [...prev, createdTab]);
    }

    const chosenTabId = targetTab.id;
    setSplitTabIds((prev) => {
      if (prev.includes(chosenTabId)) return prev;
      let next: string[];
      if (prev.length >= 3) {
        next = [...prev.slice(0, 2), chosenTabId];
      } else if (afterTabId && prev.includes(afterTabId)) {
        const idx = prev.indexOf(afterTabId);
        next = [...prev.slice(0, idx + 1), chosenTabId, ...prev.slice(idx + 1)];
      } else {
        next = [...prev, chosenTabId];
      }
      setSplitRatios(equalizeSplitRatios(next.length));
      return next;
    });
    setActiveTabId(chosenTabId);
  };

  // 탭 바에서 특정 탭을 분할 화면에 추가/제거 토글
  const handleToggleTabInSplit = (tabId: string) => {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;
    if (tab.pageId && !documentsByPageId[tab.pageId]) {
      void loadPageContent(tab.pageId, pagesById.get(tab.pageId)?.title);
    }

    if (splitTabIds.includes(tabId)) {
      if (splitTabIds.length <= 1) return;
      const next = splitTabIds.filter((id) => id !== tabId);
      setSplitTabIds(next);
      setSplitRatios(equalizeSplitRatios(next.length));
      if (activeTabId === tabId) {
        setActiveTabId(next[next.length - 1]);
      }
    } else {
      const next =
        splitTabIds.length >= 3
          ? [...splitTabIds.slice(0, 2), tabId]
          : [...splitTabIds, tabId];
      setSplitTabIds(next);
      setSplitRatios(equalizeSplitRatios(next.length));
      setActiveTabId(tabId);
    }
  };

  // 분할된 개별 창만 닫기 (빈 선택 창이었으면 탭도 함께 정리)
  const handleCloseSplitPane = (tabId: string) => {
    if (splitTabIds.length <= 1) return;
    const closingTab = tabs.find((t) => t.id === tabId);
    if (closingTab?.pageId && closingTab.pageId !== HOME_PAGE_ID) {
      void flushPendingSaveForPage(closingTab.pageId);
    }
    const next = splitTabIds.filter((id) => id !== tabId);
    setSplitTabIds(next);
    setSplitRatios(equalizeSplitRatios(next.length));
    if (closingTab && closingTab.pageId === "" && tabs.length > 1) {
      setTabs((prev) => prev.filter((t) => t.id !== tabId));
    }
    if (activeTabId === tabId) {
      setActiveTabId(next[next.length - 1]);
    }
  };

  // 탭 바에서 탭 클릭
  const handleClickTab = (tabId: string) => {
    void flushAllPendingSaves();
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;
    if (tab.pageId && !documentsByPageId[tab.pageId]) {
      void loadPageContent(tab.pageId, pagesById.get(tab.pageId)?.title);
    }

    if (splitTabIds.length <= 1) {
      setSplitTabIds([tabId]);
      setSplitRatios([100]);
      setActiveTabId(tabId);
      return;
    }

    if (splitTabIds.includes(tabId)) {
      setActiveTabId(tabId);
      return;
    }

    // 다중 분할 상태에서 분할에 없는 탭을 클릭하면 현재 포커스된 분할 창을 해당 탭으로 교체
    setSplitTabIds((prev) => {
      const idx = prev.indexOf(activeTabId);
      if (idx === -1) return [tabId, ...prev.slice(1)];
      const next = [...prev];
      next[idx] = tabId;
      return next;
    });
    setActiveTabId(tabId);
  };

  // 탭 닫기 (× 버튼 또는 ⌘W)
  const handleCloseTab = (tabId: string, event?: ReactMouseEvent) => {
    event?.stopPropagation();
    if (tabs.length <= 1) return;

    const closingIndex = tabs.findIndex((t) => t.id === tabId);
    if (closingIndex === -1) return;

    const closingTab = tabs[closingIndex];
    if (closingTab.pageId && closingTab.pageId !== HOME_PAGE_ID) {
      void flushPendingSaveForPage(closingTab.pageId);
    }

    const nextTabs = tabs.filter((t) => t.id !== tabId);
    const fallbackTab = nextTabs[Math.max(0, closingIndex - 1)] ?? nextTabs[0];

    setTabs(nextTabs);
    setSplitTabIds((prev) => {
      const filtered = prev.filter((id) => id !== tabId);
      const nextSplit = filtered.length > 0 ? filtered : [fallbackTab.id];
      setSplitRatios(equalizeSplitRatios(nextSplit.length));
      if (activeTabId === tabId) {
        setActiveTabId(nextSplit[nextSplit.length - 1]);
      }
      return nextSplit;
    });
  };

  // 개인 홈 대시보드로 이동 (기존 홈 탭이 있으면 전환, 없으면 현재 탭을 홈으로)
  const handleOpenHome = () => {
    if (activeTab?.pageId && activeTab.pageId !== HOME_PAGE_ID) {
      void flushPendingSaveForPage(activeTab.pageId);
    }
    const existingHomeTab = tabs.find((t) => t.pageId === HOME_PAGE_ID);
    if (existingHomeTab) {
      setActiveTabId(existingHomeTab.id);
      if (!splitTabIds.includes(existingHomeTab.id)) {
        if (splitTabIds.length <= 1) {
          setSplitTabIds([existingHomeTab.id]);
          setSplitRatios([100]);
        } else {
          setSplitTabIds((prev) => {
            const idx = prev.indexOf(activeTabId);
            if (idx === -1) return [existingHomeTab.id, ...prev.slice(1)];
            const next = [...prev];
            next[idx] = existingHomeTab.id;
            return next;
          });
        }
      }
    } else {
      void handleSelectPage(HOME_PAGE_ID);
    }
  };

  // 페이지 선택 (일반 클릭: 현재 활성 탭/창에서 이동, ⌘+클릭: 새 탭, ⌥+클릭: 우측 분할 창)
  useEffect(() => {
    if (pendingOpenPageId && pagesById.has(pendingOpenPageId)) {
      setPendingOpenPageId(null);
      void handleSelectPage(pendingOpenPageId);
    }
  }, [pendingOpenPageId, pagesById]);

  const handleSelectPage = async (nextId: string, options?: SelectPageOptions) => {
    if (nextId !== HOME_PAGE_ID) {
      const target = pagesById.get(nextId);
      if (!target) return;
      expandPagePath(nextId);
      lastSelectedPageIdRef.current = nextId;
      setLastActivePageId(nextId);
      if (authSession) {
        localStorage.setItem(`noty_last_page_${authSession.user.id}`, nextId);
      }
    }

    if (options?.split) {
      if (nextId === HOME_PAGE_ID) return;
      await handleOpenInSplitPane(nextId, options.targetTabId ?? activeTabId);
      return;
    }

    if (options?.newTab) {
      await handleOpenInNewTab(nextId, true);
      return;
    }

    const targetTabId = options?.targetTabId ?? activeTabId;
    const currentTab = tabs.find((t) => t.id === targetTabId) ?? activeTab;
    if (!currentTab) return;

    setActiveTabId(currentTab.id);
    if (currentTab.pageId === nextId && (nextId === HOME_PAGE_ID || documentsByPageId[nextId])) return;

    if (currentTab.pageId && currentTab.pageId !== HOME_PAGE_ID) {
      await flushPendingSaveForPage(currentTab.pageId);
    }
    setTabs((prev) =>
      prev.map((item) => (item.id === currentTab.id ? { ...item, pageId: nextId } : item)),
    );
    if (nextId !== HOME_PAGE_ID && !documentsByPageId[nextId]) {
      const target = pagesById.get(nextId);
      await loadPageContent(nextId, target?.title);
    }
  };

  // 전역 단축키 (⌘K 검색, ⌘\ 사이드바, ⌘T 새 탭, ⌘W 탭 닫기)
  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setIsSearchModalOpen((prev) => !prev);
        setSearchQuery("");
        setSearchSelectedIndex(0);
      } else if ((event.metaKey || event.ctrlKey) && event.key === "\\") {
        event.preventDefault();
        setIsSidebarOpen((prev) => !prev);
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "t") {
        event.preventDefault();
        void handleOpenInNewTab("", true);
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "w") {
        if (tabs.length > 1) {
          event.preventDefault();
          handleCloseTab(activeTabId);
        }
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") {
        event.preventDefault();
        setIsAIPanelOpen((prev) => !prev);
      } else if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        setIsSettingsModalOpen((prev) => !prev);
      } else if (event.key === "Escape") {
        setContextMenu(null);
        setEmojiPicker(null);
        setPageWidthMenu(null);
        setIsSearchModalOpen(false);
        setIsSettingsModalOpen(false);
        if (isMultiSelectMode || selectedPageIds.size > 0) {
          setIsMultiSelectMode(false);
          setSelectedPageIds(new Set());
        }
      }
    };

    const handleGlobalClick = () => {
      setContextMenu(null);
      setEmojiPicker(null);
      setPageWidthMenu(null);
    };

    window.addEventListener("keydown", handleGlobalKeyDown);
    window.addEventListener("click", handleGlobalClick);
    return () => {
      window.removeEventListener("keydown", handleGlobalKeyDown);
      window.removeEventListener("click", handleGlobalClick);
    };
  });

  const handleToggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const expandPagePath = (pageId: string, pageMap = pagesById) => {
    const ancestorIds = collectAncestorPageIds(pageId, pageMap);
    if (ancestorIds.length === 0) return;
    setExpandedIds((prev) => {
      const next = new Set(prev);
      for (const ancestorId of ancestorIds) next.add(ancestorId);
      return next;
    });
  };

  const handleCreatePage = async (parentId: string | null = null, kind: "page" | "canvas" = "page") => {
    if (isReadOnlyUser) return;
    await flushAllPendingSaves();
    const { page, pages: updatedPages } = await workspaceApi.createPage({
      parentId,
      title: kind === "canvas" ? "제목 없는 캔버스" : "제목 없는 문서",
      insertIntoParentBlocks: true,
      kind,
    });
    setPages(updatedPages);
    if (parentId) {
      const updatedPageMap = new Map(updatedPages.map((item) => [item.id, item]));
      expandPagePath(parentId, updatedPageMap);
      setExpandedIds((prev) => new Set(prev).add(parentId));
      // 부모 페이지가 캐시돼 있으면 최신 본문으로 갱신 (열린 에디터는 reconcile 로 직접 반영)
      if (documentsByPageId[parentId]) {
        const parentMeta = updatedPages.find((p) => p.id === parentId);
        void loadPageContent(parentId, parentMeta?.title, { keepRevision: true });
      }
    }
    await loadPageContent(page.id, page.title);
    setTabs((prev) =>
      prev.map((item) => (item.id === activeTabId ? { ...item, pageId: page.id } : item)),
    );
  };

  const handleOpenOrCreateCollectionRowPage = async (
    parentPageId: string,
    rowTitle: string,
    existingPageId?: string,
    openInSplit = false,
    onCreated?: (pageId: string) => void,
  ): Promise<string> => {
    await flushAllPendingSaves();
    if (existingPageId && pagesById.has(existingPageId)) {
      if (openInSplit) {
        await handleOpenInSplitPane(existingPageId, activeTabId);
      } else {
        await handleSelectPage(existingPageId);
      }
      return existingPageId;
    }
    // 읽기 전용 계정은 기존 행 페이지 열기만 가능 (새로 만들지 않음)
    if (isReadOnlyUser) throw new Error("읽기 전용 계정은 페이지를 만들 수 없습니다.");

    const { page, pages: updatedPages } = await workspaceApi.createPage({
      parentId: parentPageId,
      title: rowTitle || "컬렉션 노트",
      insertIntoParentBlocks: false,
    });
    setPages(updatedPages);
    const updatedPageMap = new Map(updatedPages.map((item) => [item.id, item]));
    expandPagePath(parentPageId, updatedPageMap);
    setExpandedIds((prev) => new Set(prev).add(parentPageId));
    await loadPageContent(page.id, page.title);
    onCreated?.(page.id);
    await flushPendingSaveForPage(parentPageId);
    lastSelectedPageIdRef.current = page.id;
    setLastActivePageId(page.id);
    if (authSession) localStorage.setItem(`noty_last_page_${authSession.user.id}`, page.id);

    if (openInSplit) {
      await handleOpenInSplitPane(page.id, activeTabId, page);
    } else {
      setTabs((prev) => prev.map((tab) => tab.id === activeTabId ? { ...tab, pageId: page.id } : tab));
    }
    return page.id;
  };

  const handleInsertPageBlockAndOpen = async (
    parentId: string,
    getUpdatedParentBlocks: (newChildId: string) => readonly unknown[],
    sourceTabId?: string,
    kind: "page" | "canvas" = "page",
  ) => {
    if (isReadOnlyUser) return;
    const existingPending = pendingSavesRef.current.get(parentId);
    if (existingPending?.timerId !== undefined) {
      window.clearTimeout(existingPending.timerId);
    }
    pendingSavesRef.current.delete(parentId);

    const { page, pages: updatedPages } = await workspaceApi.createPage({
      parentId,
      title: kind === "canvas" ? "제목 없는 캔버스" : "제목 없는 문서",
      insertIntoParentBlocks: false,
      kind,
    });
    setPages(updatedPages);

    const updatedParentBlocks = getUpdatedParentBlocks(page.id);
    const parentTitle = extractDocumentTitle(updatedParentBlocks);
    const saveRes = await workspaceApi.saveDocument(updatedParentBlocks, {
      id: parentId,
      title: parentTitle,
    });

    let savedPages = saveRes.pages ?? updatedPages;
    // 커서 위치에 끼워 넣은 page 블록 순서를 사이드바 순서에도 반영 (새 페이지가 맨 끝으로 밀리지 않도록)
    const docChildOrder = Array.from(
      new Set(collectEditorPageBlocks(updatedParentBlocks as any[]).map((ref) => ref.pageId)),
    );
    if (!sameStringArray(docChildOrder, getOrderedChildPageIds(savedPages, parentId))) {
      const reorderRes = await workspaceApi.reorderChildPages(parentId, docChildOrder);
      savedPages = reorderRes.pages;
    }
    setPages(savedPages);
    const savedPageMap = new Map(savedPages.map((item) => [item.id, item]));
    expandPagePath(parentId, savedPageMap);
    setExpandedIds((prev) => new Set(prev).add(parentId));
    await loadPageContent(parentId, parentTitle, { keepRevision: true });
    await loadPageContent(page.id, page.title);

    const targetTabId = sourceTabId ?? activeTabId;
    setTabs((prev) =>
      prev.map((item) => (item.id === targetTabId ? { ...item, pageId: page.id } : item)),
    );
    setActiveTabId(targetTabId);
  };

  const handleStartRename = (page: PageItem) => {
    if (isReadOnlyUser) return;
    setContextMenu(null);
    setEditingId(page.id);
    setEditingTitle(page.title);
  };

  const handleCommitRename = async (id: string) => {
    if (isReadOnlyUser) return;
    if (editingId !== id) return;
    const trimmed = editingTitle.trim();
    setEditingId(null);
    const target = pagesById.get(id);
    if (!target) return;

    const nextTitle = trimmed || "제목 없는 문서";
    if (nextTitle === target.title) return;

    const { pages: updatedPages } = await workspaceApi.updatePage({
      id,
      title: nextTitle,
    });
    setPages(updatedPages);
  };

  const handleCancelRename = () => {
    setEditingId(null);
    setEditingTitle("");
  };

  const handleOutdentPage = async (page: PageItem) => {
    if (isReadOnlyUser) return;
    setContextMenu(null);
    if (!page.parentId) return;
    await flushAllPendingSaves();
    const oldParentId = page.parentId;
    const parent = pagesById.get(oldParentId);
    const nextParentId = parent ? parent.parentId : null;
    const { pages: updatedPages } = await workspaceApi.updatePage({
      id: page.id,
      parentId: nextParentId,
    });
    setPages(updatedPages);
    // 열린 에디터는 사이드바 구조 변경을 감지해 page 블록을 직접 보정하므로 다시 마운트하지 않는다.
    await refreshCachedParentDocuments([oldParentId, nextParentId], updatedPages);
  };

  const handleDeletePage = async (page: PageItem) => {
    if (isReadOnlyUser) return;
    setContextMenu(null);
    const hasSubpages = (pagesByParent.get(page.id)?.length ?? 0) > 0;
    const confirmed = window.confirm(
      hasSubpages
        ? `"${page.title}" 페이지와 모든 하위 페이지를 휴지통으로 이동하시겠습니까? (30일 내 복구 가능)`
        : `"${page.title}" 페이지를 휴지통으로 이동하시겠습니까? (30일 내 복구 가능)`,
    );
    if (!confirmed) return;

    await flushAllPendingSaves();
    const { pages: updatedPages, nextActivePageId } = await workspaceApi.deletePage(page.id);
    setPages(updatedPages);

    if (updatedPages.length === 0) {
      const homeTab: WorkspaceTabItem = { id: "tab-home", pageId: HOME_PAGE_ID };
      setLastActivePageId(null);
      setDocumentsByPageId({});
      setSaveStatesByPageId({});
      setTabs([homeTab]);
      setActiveTabId(homeTab.id);
      setSplitTabIds([homeTab.id]);
      setSplitRatios([100]);
      return;
    }

    const remainingIds = new Set(updatedPages.map((item) => item.id));
    const fallbackId = remainingIds.has(nextActivePageId)
      ? nextActivePageId
      : (updatedPages[0]?.id ?? "welcome");

    // 서버가 부모 본문에서 삭제된 page 블록을 정리한 뒤에도 열린 부모 에디터는
    // 재마운트하지 않는다. 재마운트하면 Yjs가 본문을 다시 병합하는 과정에서
    // 기존 텍스트 블록 경계가 불필요한 줄바꿈처럼 바뀔 수 있다.
    if (page.parentId && remainingIds.has(page.parentId)) {
      await refreshCachedParentDocuments([page.parentId], updatedPages);
    }

    const fallbackTarget = updatedPages.find((item) => item.id === fallbackId);
    if (!documentsByPageId[fallbackId]) {
      await loadPageContent(fallbackId, fallbackTarget?.title);
    }

    setTabs((prev) =>
      prev.map((tab) =>
        remainingIds.has(tab.pageId) ? tab : { ...tab, pageId: fallbackId },
      ),
    );
  };

  const handleTrashPageBlocks = async (
    parentId: string,
    childIds: string[],
    blocks: readonly unknown[],
    title?: string,
  ) => {
    if (isReadOnlyUser) return;
    const versionAtDeletion = saveVersionsRef.current.get(parentId) ?? 0;
    const existingPending = pendingSavesRef.current.get(parentId);
    if (existingPending?.timerId !== undefined) {
      window.clearTimeout(existingPending.timerId);
    }
    pendingSavesRef.current.delete(parentId);
    await flushAllPendingSaves();
    const { pages: updatedPages, nextActivePageId } = await workspaceApi.deletePages(childIds);
    setPages(updatedPages);
    // 삭제 요청 중 추가 편집이 있었다면 그 편집의 자동 저장을 존중한다.
    if ((saveVersionsRef.current.get(parentId) ?? 0) === versionAtDeletion) {
      scheduleSave(parentId, blocks, title);
    }
    const remaining = new Set(updatedPages.map((page) => page.id));
    const fallback = remaining.has(nextActivePageId) ? nextActivePageId : parentId;
    setTabs((prev) => prev.map((tab) => remaining.has(tab.pageId) || tab.pageId === HOME_PAGE_ID
      ? tab : { ...tab, pageId: fallback }));
    if (isTrashOpen) {
      const { pages: trash } = await workspaceApi.listTrash();
      setTrashPages(trash);
    }
  };

  const openTrash = async () => {
    setIsTrashOpen(true);
    setTrashError(null);
    try {
      const { pages: trash } = await workspaceApi.listTrash();
      setTrashPages(trash);
    } catch (error) {
      setTrashError(error instanceof Error ? error.message : "휴지통을 불러오지 못했습니다.");
    }
  };

  const handleRestorePage = async (item: TrashedPageItem) => {
    if (isReadOnlyUser) return;
    setTrashBusyId(item.id);
    setTrashError(null);
    try {
      const { pages: updatedPages } = await workspaceApi.restorePage(item.id);
      setPages(updatedPages);
      setTrashPages((prev) => prev.filter((page) => page.id !== item.id));
      if (item.parentId && updatedPages.some((page) => page.id === item.parentId)) {
        await refreshCachedParentDocuments([item.parentId], updatedPages);
      }
      await loadPageContent(item.id, item.title);
      setTabs((prev) => prev.map((tab) => tab.id === activeTabId ? { ...tab, pageId: item.id } : tab));
      setIsTrashOpen(false);
    } catch (error) {
      setTrashError(error instanceof Error ? error.message : "페이지를 복구하지 못했습니다.");
    } finally {
      setTrashBusyId(null);
    }
  };

  // 사이드바 다중 선택 토글 (Shift+클릭 시 범위 선택 지원)
  const handleToggleSelectPage = (pageId: string, shiftKey: boolean) => {
    setIsMultiSelectMode(true);
    setSelectedPageIds((prev) => {
      const next = new Set(prev);
      const anchorId = lastSelectedPageIdRef.current || activePageId;
      if (shiftKey && anchorId && visibleTreePageIds.includes(anchorId) && visibleTreePageIds.includes(pageId)) {
        const startIdx = visibleTreePageIds.indexOf(anchorId);
        const endIdx = visibleTreePageIds.indexOf(pageId);
        const [from, to] = startIdx <= endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
        for (let i = from; i <= to; i += 1) {
          next.add(visibleTreePageIds[i]);
        }
      } else if (next.has(pageId)) {
        next.delete(pageId);
      } else {
        next.add(pageId);
      }
      return next;
    });
    lastSelectedPageIdRef.current = pageId;
  };

  const handleToggleSelectAllPages = () => {
    setSelectedPageIds((prev) => {
      if (prev.size === pages.length) {
        return new Set();
      }
      return new Set(pages.map((p) => p.id));
    });
  };

  const handleClearMultiSelect = () => {
    setIsMultiSelectMode(false);
    setSelectedPageIds(new Set());
  };

  const handleBulkDeletePages = async (explicitIds?: string[]) => {
    if (isReadOnlyUser) return;
    setContextMenu(null);
    const idsToDelete = explicitIds ?? Array.from(selectedPageIds);
    if (idsToDelete.length === 0) return;

    const confirmed = window.confirm(
      `선택한 ${idsToDelete.length}개 페이지(하위 페이지 포함)를 휴지통으로 이동하시겠습니까? (30일 내 복구 가능)`,
    );
    if (!confirmed) return;

    await flushAllPendingSaves();
    const { pages: updatedPages, nextActivePageId } = await workspaceApi.deletePages(idsToDelete);
    setPages(updatedPages);
    setSelectedPageIds(new Set());
    setIsMultiSelectMode(false);

    if (updatedPages.length === 0) {
      const homeTab: WorkspaceTabItem = { id: "tab-home", pageId: HOME_PAGE_ID };
      setLastActivePageId(null);
      setDocumentsByPageId({});
      setSaveStatesByPageId({});
      setTabs([homeTab]);
      setActiveTabId(homeTab.id);
      setSplitTabIds([homeTab.id]);
      setSplitRatios([100]);
      return;
    }

    const remainingIds = new Set(updatedPages.map((item) => item.id));
    const fallbackId = remainingIds.has(nextActivePageId)
      ? nextActivePageId
      : (updatedPages[0]?.id ?? "welcome");

    // 살아남은 페이지 중 현재 열려 있는 페이지들의 본문 블록 새로고침
    for (const survivingPage of updatedPages) {
      if (documentsByPageId[survivingPage.id]) {
        await loadPageContent(survivingPage.id, survivingPage.title);
      }
    }

    const fallbackTarget = updatedPages.find((item) => item.id === fallbackId);
    await loadPageContent(fallbackId, fallbackTarget?.title);

    setTabs((prev) =>
      prev.map((tab) =>
        !tab.pageId || remainingIds.has(tab.pageId) ? tab : { ...tab, pageId: fallbackId },
      ),
    );
  };

  const handleDropPage = async (targetId: string, placement: DropPlacement) => {
    if (isReadOnlyUser) return;
    const draggedId = draggingPageId;
    setDraggingPageId(null);
    setDropIndicator(null);
    if (!draggedId || draggedId === targetId) return;

    const targetPage = pagesById.get(targetId);
    const nextParentId = placement === "inside" ? targetId : (targetPage?.parentId ?? null);
    if (isDescendantPage(pages, nextParentId, draggedId)) return;

    await flushAllPendingSaves();
    const oldParentId = pagesById.get(draggedId)?.parentId ?? null;
    const { pages: updatedPages } = await workspaceApi.updatePage({
      id: draggedId,
      targetId,
      placement,
    });
    setPages(updatedPages);
    if (placement === "inside") {
      const updatedPageMap = new Map(updatedPages.map((item) => [item.id, item]));
      expandPagePath(targetId, updatedPageMap);
      setExpandedIds((prev) => new Set(prev).add(targetId));
    }
    // 열린 에디터는 사이드바 구조 변경(이동·순서)을 감지해 page 블록을 직접 보정하므로 다시 마운트하지 않는다.
    await refreshCachedParentDocuments([oldParentId, nextParentId], updatedPages);
  };

  /** 구조 변경 후, 캐시돼 있는 부모 문서 본문을 리마운트 없이 서버 최신본으로 갱신한다. */
  const refreshCachedParentDocuments = async (
    parentIds: Array<string | null | undefined>,
    latestPages: PageItem[],
  ) => {
    const uniqueIds = Array.from(
      new Set(parentIds.filter((id): id is string => Boolean(id) && Boolean(documentsByPageId[id!]))),
    );
    await Promise.all(
      uniqueIds.map((id) =>
        loadPageContent(id, latestPages.find((item) => item.id === id)?.title, {
          keepRevision: true,
        }),
      ),
    );
  };

  /** 에디터 본문에서 page 블록 순서를 바꿨을 때 사이드바 순서를 낙관적으로 갱신하고 서버에 저장한다. */
  const handleReorderChildPages = (parentId: string, orderedIds: string[]) => {
    if (isReadOnlyUser) return;
    const orderIndex = new Map(orderedIds.map((id, index) => [id, index]));
    setPages((prev) =>
      prev.map((item) =>
        item.parentId === parentId && orderIndex.has(item.id)
          ? { ...item, order: orderIndex.get(item.id)! }
          : item,
      ),
    );
    void workspaceApi
      .reorderChildPages(parentId, orderedIds)
      .then(({ pages: updatedPages }) => setPages(updatedPages))
      .catch((error) => console.error("Failed to reorder child pages", error));
  };

  /** 다른 사용자의 구조 변경이 본문으로 전달됐을 때 페이지 목록을 서버에서 다시 받아온다. */
  /** 캔버스에서 새 페이지 만들기: 정해진 위치에 만들고(필요하면 본문을 채우고) id 를 돌려준다. 탭은 옮기지 않는다. */
  const handleCreatePageFromCanvas = async (parentId: string | null, title: string, bodyText?: string): Promise<string | null> => {
    if (isReadOnlyUser) return null;
    try {
      const { page, pages: updatedPages } = await workspaceApi.createPage({ parentId, title, insertIntoParentBlocks: true });
      setPages(updatedPages);
      if (bodyText) {
        const blocks = [
          { type: "heading", props: { level: 1 }, content: title },
          ...bodyText.split("\n").map((line) => ({ type: "paragraph", content: line })),
        ];
        await workspaceApi.saveDocument(blocks, { id: page.id, title });
      }
      if (parentId) {
        const updatedPageMap = new Map(updatedPages.map((item) => [item.id, item]));
        expandPagePath(parentId, updatedPageMap);
      }
      return page.id;
    } catch (error) {
      console.error("Failed to create page from canvas", error);
      window.alert(error instanceof Error ? error.message : "페이지를 만들지 못했습니다.");
      return null;
    }
  };

  const handleRenamePageTitle = (pageId: string, title: string) => {
    void workspaceApi
      .updatePage({ id: pageId, title })
      .then(({ pages: latestPages }) => setPages(latestPages))
      .catch((error) => console.error("Failed to rename page", error));
  };

  const handleRefreshPages = () => {
    void workspaceApi
      .listPages()
      .then(({ pages: latestPages }) => setPages(latestPages))
      .catch((error) => console.error("Failed to refresh pages", error));
  };

  const handleCopyPageLink = (page: PageItem) => {
    setContextMenu(null);
    void navigator.clipboard?.writeText(`noty://page/${page.id}`);
  };

  const handleUpdatePageIcon = async (pageId: string, icon: string | null) => {
    if (isReadOnlyUser) return;
    setEmojiPicker(null);
    setCustomEmojiInput("");
    setPages((prev) =>
      prev.map((item) => (item.id === pageId ? { ...item, icon } : item)),
    );
    try {
      const { pages: updatedPages } = await workspaceApi.updatePage({
        id: pageId,
        icon,
      });
      setPages(updatedPages);
    } catch (err) {
      console.error(err);
    }
  };

  const handleSetRandomEmoji = (pageId: string) => {
    if (isReadOnlyUser) return;
    const randomEmoji = ALL_EMOJIS[Math.floor(Math.random() * ALL_EMOJIS.length)] ?? "📝";
    void handleUpdatePageIcon(pageId, randomEmoji);
  };

  const handleUpdatePageWidth = (pageId: string, rawWidth: string) => {
    if (isReadOnlyUser) return;
    const nextWidth = normalizePageWidthValue(rawWidth);
    setPages((prev) =>
      prev.map((item) => (item.id === pageId ? { ...item, pageWidth: nextWidth } : item)),
    );
    const prevTimer = pendingPageWidthSavesRef.current.get(pageId);
    if (prevTimer !== undefined) window.clearTimeout(prevTimer);
    const timerId = window.setTimeout(() => {
      pendingPageWidthSavesRef.current.delete(pageId);
      void workspaceApi
        .updatePage({ id: pageId, pageWidth: nextWidth })
        .then(({ pages: updatedPages }) => setPages(updatedPages))
        .catch((err) => console.error("Failed to update page width", err));
    }, 220);
    pendingPageWidthSavesRef.current.set(pageId, timerId);
  };

  const handleSyncPageWidthFromYjs = (pageId: string, remoteWidth: string) => {
    const normalized = normalizePageWidthValue(remoteWidth);
    setPages((prev) =>
      prev.map((item) =>
        item.id === pageId && normalizePageWidthValue(item.pageWidth) !== normalized
          ? { ...item, pageWidth: normalized }
          : item,
      ),
    );
  };

  const handleTitlePreviewChange = (pageId: string, title: string) => {
    setPages((prev) =>
      prev.map((item) => (item.id === pageId && item.title !== title ? { ...item, title } : item)),
    );

    const previousTimer = pendingTitleSavesRef.current.get(pageId);
    if (previousTimer !== undefined) window.clearTimeout(previousTimer);
    const timerId = window.setTimeout(() => {
      pendingTitleSavesRef.current.delete(pageId);
      void workspaceApi
        .updatePage({ id: pageId, title })
        .then(({ pages: updatedPages }) => setPages(updatedPages))
        .catch((error) => console.error("Failed to save page title", error));
    }, 500);
    pendingTitleSavesRef.current.set(pageId, timerId);
  };

  const scheduleSave = (pageId: string, blocks: readonly unknown[], title?: string) => {
    saveVersionsRef.current.set(pageId, (saveVersionsRef.current.get(pageId) ?? 0) + 1);
    const existing = pendingSavesRef.current.get(pageId);
    if (existing?.timerId !== undefined) {
      window.clearTimeout(existing.timerId);
    }
    // 다른 페이지에 다녀와도 최신 작성 내용이 즉시 복원되도록 인메모리 문서 캐시도 함께 갱신 (revision은 유지해 타이핑 중 리마운트 방지)
    setDocumentsByPageId((prev) => {
      const current = prev[pageId];
      if (!current) return prev;
      return {
        ...prev,
        [pageId]: {
          ...current,
          blocks: normalizeStoredBlocks(blocks as unknown[]),
        },
      };
    });
    setSaveStatesByPageId((prev) => ({ ...prev, [pageId]: "saving" }));
    const timerId = window.setTimeout(() => {
      void flushPendingSaveForPage(pageId);
    }, 500);
    pendingSavesRef.current.set(pageId, { blocks, title, timerId });
  };

  if (!authSession) {
    return (
      <div className={`login-screen ${isElectronMac ? "login-screen--mac-electron" : ""}`}>
        {isElectronMac && <div className="login-mac-dragbar" />}
        <div className="login-card">
          <div className="login-card__brand">
            <div className="login-card__logo">N</div>
            <div>
              <h1 className="login-card__title">Noty에 로그인</h1>
              <p className="login-card__subtitle">
                서버 주소와 관리자에게 받은 계정으로 로그인하세요.
              </p>
            </div>
          </div>

          <form className="login-form" onSubmit={(e) => void handleLoginSubmit(e)}>
            <div className="login-field">
              <label className="login-field__label" htmlFor="noty-server-host">
                서버 호스트 (Server Host)
              </label>
              <div className="login-host-row">
                <input
                  id="noty-server-host"
                  type="text"
                  className="login-field__input"
                  value={loginServerHost}
                  onChange={(event) => {
                    setLoginServerHost(event.target.value);
                    if (serverPingStatus !== "idle") {
                      setServerPingStatus("idle");
                      setServerPingMessage("");
                    }
                  }}
                  placeholder="http://127.0.0.1:4000"
                  autoComplete="url"
                />
                <button
                  type="button"
                  className="ds-btn ds-btn--outline ds-btn--lg login-host-check-btn"
                  disabled={serverPingStatus === "checking"}
                  onClick={() => void handleCheckServerHost(loginServerHost)}
                >
                  {serverPingStatus === "checking" ? "확인 중…" : "연결 확인"}
                </button>
              </div>
              {serverPingMessage && (
                <div
                  className={`login-ping-status login-ping-status--${serverPingStatus}`}
                >
                  <span className="login-ping-dot" />
                  <span>{serverPingMessage}</span>
                </div>
              )}
            </div>

            <div className="login-field">
              <label className="login-field__label" htmlFor="noty-login-username">
                아이디
              </label>
              <input
                id="noty-login-username"
                type="text"
                className="login-field__input"
                value={loginUsername}
                onChange={(event) => setLoginUsername(event.target.value)}
                placeholder="아이디"
                autoComplete="username"
                autoFocus
              />
            </div>

            <div className="login-field">
              <label className="login-field__label" htmlFor="noty-login-password">
                비밀번호
              </label>
              <input
                id="noty-login-password"
                type="password"
                className="login-field__input"
                value={loginPassword}
                onChange={(event) => setLoginPassword(event.target.value)}
                placeholder="비밀번호"
                autoComplete="current-password"
              />
            </div>

            {loginError && <div className="login-error-banner">{loginError}</div>}

            <button
              type="submit"
              className="ds-btn ds-btn--primary login-submit-btn"
              disabled={isLoggingIn}
            >
              {isLoggingIn ? "로그인 중…" : "서버 연결 및 로그인"}
            </button>
          </form>

        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="center-message center-message--error">
        <div className="center-error-box">
          <p>{loadError}</p>
          <div className="center-error-actions">
            <button
              type="button"
              className="ds-btn ds-btn--outline ds-btn--lg login-host-check-btn"
              onClick={() => {
                setLoadError(null);
                setAuthSession({ ...authSession });
              }}
            >
              다시 시도
            </button>
            <button
              type="button"
              className="ds-btn ds-btn--primary login-submit-btn"
              onClick={() => void handleLogout()}
            >
              서버 호스트 변경 / 다시 로그인
            </button>
          </div>
        </div>
      </div>
    );
  }
  if (!isWorkspaceReady) return <div className="center-message">문서를 불러오는 중…</div>;

  const saveLabelMap: Record<SaveState, string> = {
    loading: "불러오는 중",
    saving: "저장 중…",
    saved: "저장됨",
    error: "저장 실패",
  };

  const rootPages = pagesByParent.get(null) ?? [];
  const visibleSplitTabs = splitTabIds
    .map((id) => tabs.find((t) => t.id === id))
    .filter((t): t is WorkspaceTabItem => Boolean(t));

  return (
    <div
      className={[
        "app-shell",
        isSidebarOpen ? "app-shell--sidebar-open" : "app-shell--sidebar-closed",
        isElectronMac ? "app-shell--mac-electron" : "",
        isReadOnlyUser ? "app-shell--read-only" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ "--ds-sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}
    >
      <aside className="sidebar" aria-label="문서 탐색 사이드바">
        {isElectronMac && <div className="sidebar-mac-dragbar" />}
        <div className="sidebar-header">
          <div className="workspace-brand-group" title={`접속 서버: ${authSession.serverHost}`}>
            <strong className="workspace-title">Noty</strong>
            <span className="workspace-user-pill">{authSession.user.displayName}</span>
          </div>
          <div className="sidebar-header-actions">
            {isSidebarOpen && (
              <button
                type="button"
                className="ds-btn ds-btn--ghost ds-btn--icon"
                onClick={() => setIsSidebarOpen(false)}
                title="사이드바 닫기 (⌘\)"
                aria-label="사이드바 닫기"
              >
                <CollapseSidebarSvgIcon />
              </button>
            )}
            <button
              type="button"
              className="ds-btn ds-btn--ghost ds-btn--icon"
              data-requires-edit
            onClick={() => void handleCreatePage(null)}
              title="새 페이지 만들기"
              aria-label="새 페이지 만들기"
            >
              <PlusSvgIcon />
            </button>
          </div>
        </div>

        {/* 노션 상단 퀵 액션 행 (홈 / 검색 ⌘K / 새 페이지) */}
        <div className="sidebar-quick-actions">
          <button
            type="button"
            className={`sidebar-action-row ${activeTab?.pageId === HOME_PAGE_ID ? "sidebar-action-row--active" : ""}`}
            onClick={handleOpenHome}
            title="개인 홈 대시보드"
          >
            <span className="sidebar-action-row__icon">
              <HomeSvgIcon />
            </span>
            <span className="sidebar-action-row__label">홈</span>
          </button>

          <button
            type="button"
            className="sidebar-action-row"
            onClick={() => {
              setIsSearchModalOpen(true);
              setSearchQuery("");
              setSearchSelectedIndex(0);
            }}
          >
            <span className="sidebar-action-row__icon">
              <SearchSvgIcon />
            </span>
            <span className="sidebar-action-row__label">검색</span>
            <kbd className="sidebar-action-row__shortcut">⌘K</kbd>
          </button>

          <button type="button" className="sidebar-action-row" onClick={() => setIsGraphOpen(true)} title="페이지와 링크를 한눈에 보기">
            <span className="sidebar-action-row__icon">
              <GraphSvgIcon />
            </span>
            <span className="sidebar-action-row__label">그래프</span>
          </button>

          <button
            type="button"
            className="sidebar-action-row"
            data-requires-edit
            onClick={() => void handleCreatePage(null)}
          >
            <span className="sidebar-action-row__icon">
              <PlusSvgIcon />
            </span>
            <span className="sidebar-action-row__label">새 페이지</span>
          </button>

          <button
            type="button"
            className="sidebar-action-row"
            data-requires-edit
            onClick={() => void handleCreatePage(null, "canvas")}
          >
            <span className="sidebar-action-row__icon">
              <CanvasSvgIcon />
            </span>
            <span className="sidebar-action-row__label">새 캔버스</span>
          </button>
        </div>

        <div className="sidebar-section-header">
          <span>개인 페이지</span>
          <div className="sidebar-section-actions">
            <button
              type="button"
              className={`ds-btn ds-btn--ghost section-select-btn ${isMultiSelectMode || selectedPageIds.size > 0 ? "section-select-btn--active" : ""}`}
              onClick={() => {
                if (isMultiSelectMode || selectedPageIds.size > 0) {
                  handleClearMultiSelect();
                } else {
                  setIsMultiSelectMode(true);
                }
              }}
              title="여러 페이지 선택 및 일괄 삭제"
            >
              {isMultiSelectMode || selectedPageIds.size > 0 ? "완료" : "선택"}
            </button>
            <button
              type="button"
              className="ds-btn ds-btn--ghost ds-btn--icon tree-action-btn section-plus-btn"
              data-requires-edit
            onClick={() => void handleCreatePage(null)}
              title="페이지 추가"
              aria-label="페이지 추가"
            >
              <PlusSvgIcon />
            </button>
          </div>
        </div>

        {(isMultiSelectMode || selectedPageIds.size > 0) && (
          <div className="sidebar-bulk-bar">
            <span className="sidebar-bulk-bar__count">
              {selectedPageIds.size}개 선택됨
            </span>
            <div className="sidebar-bulk-bar__actions">
              <button
                type="button"
                className="ds-btn ds-btn--outline ds-btn--sm sidebar-bulk-bar__btn"
                onClick={handleToggleSelectAllPages}
              >
                {selectedPageIds.size === pages.length && pages.length > 0
                  ? "해제"
                  : "전체"}
              </button>
              <button
                type="button"
                className="ds-btn ds-btn--outline ds-btn--sm sidebar-bulk-bar__btn sidebar-bulk-bar__btn--danger"
                disabled={selectedPageIds.size === 0}
                onClick={() => void handleBulkDeletePages()}
                title="선택한 페이지 모두 삭제"
              >
                <TrashSvgIcon />
                <span>삭제</span>
              </button>
            </div>
          </div>
        )}

        <nav className="sidebar-tree">
          <ul className="tree-list">
            {rootPages.map((page) => (
              <PageTreeNode
                key={page.id}
                page={page}
                pagesByParent={pagesByParent}
                activePageId={activePageId}
                expandedIds={expandedIds}
                editingId={editingId}
                editingTitle={editingTitle}
                dropIndicator={dropIndicator}
                depth={0}
                isMultiSelectMode={isMultiSelectMode}
                selectedPageIds={selectedPageIds}
                onToggleSelectPage={handleToggleSelectPage}
                onSelect={(id, opts) => void handleSelectPage(id, opts)}
                onToggleExpand={handleToggleExpand}
                onStartRename={handleStartRename}
                onChangeEditingTitle={setEditingTitle}
                onCommitRename={(id) => void handleCommitRename(id)}
                onCancelRename={handleCancelRename}
                onCreateChild={(parentId) => void handleCreatePage(parentId)}
                onOpenContextMenu={(target, x, y) => setContextMenu({ page: target, x, y })}
                onOpenEmojiPicker={(pageId, x, y) => {
                  setContextMenu(null);
                  setCustomEmojiInput("");
                  setEmojiPicker({ pageId, x, y });
                }}
                onDragStartPage={setDraggingPageId}
                onUpdateDropIndicator={setDropIndicator}
                onDropPage={(targetId, placement) => void handleDropPage(targetId, placement)}
              />
            ))}
          </ul>
        </nav>

        {/* 사이드바 최하단 구분선 및 설정/로그아웃 버튼 */}
        <div className="sidebar-footer">
          {!isReadOnlyUser && (
            <button type="button" className="sidebar-action-row" onClick={() => setIsImportOpen(true)}>
              <span className="sidebar-action-row__icon" aria-hidden="true">⇩</span>
              <span className="sidebar-action-row__label">Notion 가져오기</span>
            </button>
          )}
          <button type="button" className="sidebar-action-row" onClick={() => void openTrash()}>
            <span className="sidebar-action-row__icon"><TrashSvgIcon /></span>
            <span className="sidebar-action-row__label">휴지통</span>
          </button>
          <div className="sidebar-server-info" title={authSession.serverHost}>
            <span className="sidebar-server-dot" />
            <span className="sidebar-server-host">{authSession.serverHost}</span>
            <button
              type="button"
              className="ds-btn ds-btn--outline sidebar-logout-inline-btn"
              onClick={() => void handleLogout()}
              title="로그아웃 및 서버 호스트 변경"
            >
              로그아웃
            </button>
          </div>
          <button
            type="button"
            className="sidebar-action-row"
            onClick={() => setIsSettingsModalOpen(true)}
          >
            <span className="sidebar-action-row__icon">
              <SettingsGearSvgIcon />
            </span>
            <span className="sidebar-action-row__label">설정</span>
            <kbd className="sidebar-action-row__shortcut">⌘,</kbd>
          </button>
        </div>

        {/* 노션 스타일 사이드바 우측 너비 드래그 핸들 */}
        {isSidebarOpen && (
          <div
            className={`sidebar-resizer ${isResizingSidebar ? "sidebar-resizer--active" : ""}`}
            onMouseDown={(event) => {
              event.preventDefault();
              setIsResizingSidebar(true);
            }}
          />
        )}
      </aside>

      {/* 노션 `⋯` 더보기 / 우클릭 팝오버 메뉴 */}
      {contextMenu && (
        <div
          className="noty-popover-menu"
          style={{
            top: `${Math.min(window.innerHeight - 240, contextMenu.y)}px`,
            left: `${Math.min(window.innerWidth - 210, contextMenu.x)}px`,
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="noty-menu-item"
            onClick={() => {
              const targetId = contextMenu.page.id;
              setContextMenu(null);
              void handleOpenInNewTab(targetId, true);
            }}
          >
            <span>새 탭에서 열기</span>
          </button>
          <button
            type="button"
            className="noty-menu-item"
            onClick={() => {
              const targetId = contextMenu.page.id;
              setContextMenu(null);
              void handleOpenInSplitPane(targetId, activeTabId);
            }}
          >
            <span>우측 분할 화면으로 열기</span>
          </button>
          {!isReadOnlyUser && contextMenu.page.kind !== "canvas" && (
            <button
              type="button"
              className="noty-menu-item"
              onClick={() => {
                const targetId = contextMenu.page.id;
                setContextMenu(null);
                void openSaveTemplateDialog(targetId);
              }}
            >
              <span>템플릿으로 저장</span>
            </button>
          )}
          <button
            type="button"
            className="noty-menu-item"
            onClick={() => {
              const targetId = contextMenu.page.id;
              const currentWidth = normalizePageWidthValue(
                pagesById.get(targetId)?.pageWidth ?? contextMenu.page.pageWidth,
              );
              setContextMenu(null);
              handleUpdatePageWidth(targetId, currentWidth === "full" ? "default" : "full");
            }}
          >
            <span>
              {normalizePageWidthValue(
                pagesById.get(contextMenu.page.id)?.pageWidth ?? contextMenu.page.pageWidth,
              ) === "full"
                ? "기본 가로 사이즈(760px)로 전환"
                : "전체 화면 너비로 전환"}
            </span>
          </button>
          <div className="noty-menu-divider" />
          <button
            type="button"
            className="noty-menu-item"
            onClick={() => {
              const { page, x, y } = contextMenu;
              setContextMenu(null);
              setCustomEmojiInput("");
              setEmojiPicker({ pageId: page.id, x, y });
            }}
          >
            <span>아이콘 변경</span>
          </button>
          <button
            type="button"
            className="noty-menu-item"
            onClick={() => handleStartRename(contextMenu.page)}
          >
            <span>이름 바꾸기</span>
          </button>
          <button
            type="button"
            className="noty-menu-item"
            onClick={() => {
              const parentId = contextMenu.page.id;
              setContextMenu(null);
              void handleCreatePage(parentId);
            }}
          >
            <span>하위 페이지 추가</span>
          </button>
          {contextMenu.page.parentId && (
            <button
              type="button"
              className="noty-menu-item"
              onClick={() => void handleOutdentPage(contextMenu.page)}
            >
              <span>상위 계층으로 이동</span>
            </button>
          )}
          <button
            type="button"
            className="noty-menu-item"
            onClick={() => handleCopyPageLink(contextMenu.page)}
          >
            <span>링크 복사</span>
          </button>
          <button
            type="button"
            className="noty-menu-item"
            onClick={() => {
              const targetId = contextMenu.page.id;
              setContextMenu(null);
              setIsMultiSelectMode(true);
              setSelectedPageIds((prev) => new Set(prev).add(targetId));
              lastSelectedPageIdRef.current = targetId;
            }}
          >
            <span>여러 페이지 선택</span>
          </button>
          <div className="noty-menu-divider" />
          {selectedPageIds.size > 1 && selectedPageIds.has(contextMenu.page.id) ? (
            <button
              type="button"
              className="noty-menu-item noty-menu-item--danger"
              onClick={() => void handleBulkDeletePages()}
            >
              <span>선택한 {selectedPageIds.size}개 페이지 일괄 삭제</span>
            </button>
          ) : (
            <button
              type="button"
              className="noty-menu-item noty-menu-item--danger"
              onClick={() => void handleDeletePage(contextMenu.page)}
            >
              <span>삭제</span>
            </button>
          )}
        </div>
      )}

      {/* 페이지별 이모지 피커 팝오버 */}
      {emojiPicker && (
        <div
          className="emoji-picker-popover"
          style={{
            top: `${Math.min(window.innerHeight - 360, Math.max(12, emojiPicker.y))}px`,
            left: `${Math.min(window.innerWidth - 320, Math.max(12, emojiPicker.x))}px`,
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="emoji-picker-popover__header">
            <span className="emoji-picker-popover__title">이모지 선택</span>
            <div className="emoji-picker-popover__actions">
              <button
                type="button"
                className="ds-btn ds-btn--outline emoji-picker-popover__action-btn"
                onClick={() => handleSetRandomEmoji(emojiPicker.pageId)}
                title="무작위 이모지 선택"
              >
                🎲 랜덤
              </button>
              {pagesById.get(emojiPicker.pageId)?.icon && (
                <button
                  type="button"
                  className="ds-btn ds-btn--outline emoji-picker-popover__action-btn emoji-picker-popover__action-btn--danger"
                  onClick={() => void handleUpdatePageIcon(emojiPicker.pageId, null)}
                >
                  제거
                </button>
              )}
            </div>
          </div>

          <form
            className="emoji-picker-popover__custom"
            onSubmit={(event) => {
              event.preventDefault();
              const trimmed = customEmojiInput.trim();
              if (trimmed) {
                void handleUpdatePageIcon(emojiPicker.pageId, trimmed);
              }
            }}
          >
            <input
              type="text"
              className="emoji-picker-popover__input"
              placeholder="직접 이모지 입력 (예: 🦊) 후 Enter…"
              value={customEmojiInput}
              onChange={(event) => setCustomEmojiInput(event.target.value)}
            />
          </form>

          <div className="emoji-picker-popover__body">
            {EMOJI_GROUPS.map((group) => (
              <div key={group.label} className="emoji-picker-group">
                <div className="emoji-picker-group__label">{group.label}</div>
                <div className="emoji-picker-group__grid">
                  {group.emojis.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      className={[
                        "ds-btn ds-btn--ghost emoji-picker-btn",
                        pagesById.get(emojiPicker.pageId)?.icon === emoji
                          ? "emoji-picker-btn--selected"
                          : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      onClick={() => void handleUpdatePageIcon(emojiPicker.pageId, emoji)}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 페이지 가로 사이즈(너비) 설정 팝오버 */}
      {pageWidthMenu && (() => {
        const targetPage = pagesById.get(pageWidthMenu.pageId);
        const currentWidth = normalizePageWidthValue(targetPage?.pageWidth);
        const isFullWidth = currentWidth === "full";
        const numericWidth = resolvePageNumericWidth(currentWidth);
        return (
          <div
            className="page-width-popover"
            style={{
              top: `${Math.min(window.innerHeight - 280, Math.max(12, pageWidthMenu.y))}px`,
              left: `${Math.min(window.innerWidth - 290, Math.max(12, pageWidthMenu.x))}px`,
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="page-width-popover__header">
              <span className="page-width-popover__title">페이지 가로 사이즈</span>
              <span className="page-width-popover__badge">
                {getPageWidthShortLabel(currentWidth)}
              </span>
            </div>

            <label className="page-width-popover__toggle-row">
              <div className="page-width-popover__toggle-text">
                <strong>전체 화면 너비</strong>
                <span>창 전체 폭에 맞춰 페이지를 넓게 표시</span>
              </div>
              <input
                type="checkbox"
                className="page-width-popover__switch"
                checked={isFullWidth}
                onChange={(event) => {
                  handleUpdatePageWidth(
                    pageWidthMenu.pageId,
                    event.target.checked ? "full" : "default",
                  );
                }}
              />
            </label>

            <div className="page-width-popover__presets">
              <button
                type="button"
                className={`page-width-preset-btn ${currentWidth === "default" ? "page-width-preset-btn--active" : ""}`}
                onClick={() => handleUpdatePageWidth(pageWidthMenu.pageId, "default")}
              >
                <strong>기본</strong>
                <span>760px</span>
              </button>
              <button
                type="button"
                className={`page-width-preset-btn ${currentWidth === "wide" ? "page-width-preset-btn--active" : ""}`}
                onClick={() => handleUpdatePageWidth(pageWidthMenu.pageId, "wide")}
              >
                <strong>넓게</strong>
                <span>1080px</span>
              </button>
              <button
                type="button"
                className={`page-width-preset-btn ${currentWidth === "full" ? "page-width-preset-btn--active" : ""}`}
                onClick={() => handleUpdatePageWidth(pageWidthMenu.pageId, "full")}
              >
                <strong>전체 화면</strong>
                <span>100%</span>
              </button>
            </div>

            <div className="page-width-popover__custom">
              <div className="page-width-popover__custom-header">
                <span>지정 사이즈 직접 조절</span>
                <strong>{isFullWidth ? "전체 (100%)" : `${numericWidth}px`}</strong>
              </div>
              <input
                type="range"
                min={560}
                max={1600}
                step={20}
                value={numericWidth}
                className="page-width-popover__slider"
                onChange={(event) => {
                  handleUpdatePageWidth(pageWidthMenu.pageId, event.target.value);
                }}
              />
              <div className="page-width-popover__custom-ticks">
                <span>560px</span>
                <span>760px</span>
                <span>1080px</span>
                <span>1600px</span>
              </div>
            </div>
          </div>
        );
      })()}

      {/* 노션 ⌘K 빠른 검색 모달 */}
      {isTrashOpen && (
        <div className="search-modal-backdrop" onClick={() => setIsTrashOpen(false)}>
          <div className="search-modal trash-modal" role="dialog" aria-label="휴지통" onClick={(event) => event.stopPropagation()}>
            <div className="trash-modal__header">
              <div><strong>휴지통</strong><span>삭제된 페이지는 30일 동안 보관됩니다.</span></div>
              <button type="button" className="ds-btn ds-btn--ghost" onClick={() => setIsTrashOpen(false)} aria-label="휴지통 닫기">닫기</button>
            </div>
            {trashError && <p className="trash-modal__error" role="alert">{trashError}</p>}
            <div className="trash-modal__list">
              {trashPages.length === 0 && !trashError ? <p className="trash-modal__empty">휴지통이 비어 있습니다.</p> : null}
              {trashPages.map((item) => (
                <div className="trash-modal__item" key={item.id}>
                  <span className="trash-modal__icon">{item.icon || "📄"}</span>
                  <div className="trash-modal__details">
                    <strong>{item.title}</strong>
                    <span>하위 페이지 포함 {item.pageCount}개 · {new Date(item.expiresAt).toLocaleDateString("ko-KR")}까지 복구 가능</span>
                  </div>
                  <button type="button" className="ds-btn ds-btn--outline ds-btn--sm" disabled={trashBusyId !== null} onClick={() => void handleRestorePage(item)}>
                    {trashBusyId === item.id ? "복구 중…" : "복구"}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {isGraphOpen && (
        <GraphView
          currentPageId={activeTab?.pageId && activeTab.pageId !== HOME_PAGE_ID ? activeTab.pageId : undefined}
          onClose={() => setIsGraphOpen(false)}
          onSelectPage={(id) => {
            setIsGraphOpen(false);
            void handleSelectPage(id);
          }}
        />
      )}

      {isSearchModalOpen && (
        <div
          className="search-modal-backdrop"
          onClick={() => setIsSearchModalOpen(false)}
        >
          <div
            className="search-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="search-modal-input-wrap">
              <SearchSvgIcon />
              <input
                type="text"
                autoFocus
                value={searchQuery}
                onChange={(event) => {
                  setSearchQuery(event.target.value);
                  setSearchSelectedIndex(0);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setSearchSelectedIndex((prev) =>
                      Math.min(searchModalItems.all.length - 1, prev + 1),
                    );
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setSearchSelectedIndex((prev) => Math.max(0, prev - 1));
                  } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    const chosen = searchModalItems.all[searchSelectedIndex];
                    if (chosen) {
                      openSearchItem(chosen, {
                        newTab: event.metaKey || event.ctrlKey,
                        split: event.altKey,
                      });
                    }
                  }
                }}
                placeholder="페이지, 본문, 첨부파일 검색…"
              />
              {workspaceSearch.loading && <span className="search-modal-spinner" aria-label="검색 중" />}
            </div>
            <ul className="search-modal-list">
              {searchModalItems.all.length === 0 ? (
                <li className="search-modal-empty">
                  {workspaceSearch.loading
                    ? "검색 중…"
                    : workspaceSearch.error
                      ? `검색 오류: ${workspaceSearch.error}`
                      : "일치하는 페이지가 없습니다."}
                </li>
              ) : (
                <>
                  {searchQuery.trim() && searchModalItems.titleItems.length > 0 && (
                    <li className="search-modal-section">페이지 제목</li>
                  )}
                  {searchModalItems.titleItems.map((item, idx) => (
                    <li key={item.key}>
                      <button
                        type="button"
                        className={`search-modal-item ${idx === searchSelectedIndex ? "search-modal-item--selected" : ""}`}
                        onMouseEnter={() => setSearchSelectedIndex(idx)}
                        onClick={(event) =>
                          openSearchItem(item, { newTab: event.metaKey || event.ctrlKey, split: event.altKey })
                        }
                      >
                        <PageIconOrDoc icon={item.page.icon} kind={item.page.kind} />
                        <span>{item.page.title || "제목 없는 문서"}</span>
                      </button>
                    </li>
                  ))}
                  {searchModalItems.conceptItems.length > 0 && (
                    <li className="search-modal-section">개념 (AI 위키)</li>
                  )}
                  {searchModalItems.conceptItems.map((item, conceptIdx) => {
                    const idx = searchModalItems.titleItems.length + conceptIdx;
                    return (
                      <li key={item.key}>
                        <button
                          type="button"
                          className={`search-modal-item search-modal-item--content ${idx === searchSelectedIndex ? "search-modal-item--selected" : ""}`}
                          onMouseEnter={() => setSearchSelectedIndex(idx)}
                          onClick={() => openSearchItem(item, {})}
                        >
                          <span className="search-concept-icon" aria-hidden="true">◆</span>
                          <span className="search-hit">
                            <span className="search-hit__title-row">
                              <span className="search-hit__title">{item.concept.name}</span>
                              <span className="search-hit__location">{item.concept.pageCount}개 페이지</span>
                            </span>
                            {item.concept.summary && <span className="search-hit__snippet">{item.concept.summary}</span>}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                  {searchModalItems.contentItems.length > 0 && (
                    <li className="search-modal-section">본문 · 첨부파일</li>
                  )}
                  {searchModalItems.contentItems.map((item, contentIdx) => {
                    const idx = searchModalItems.titleItems.length + searchModalItems.conceptItems.length + contentIdx;
                    return (
                      <li key={item.key}>
                        <button
                          type="button"
                          className={`search-modal-item search-modal-item--content ${idx === searchSelectedIndex ? "search-modal-item--selected" : ""}`}
                          onMouseEnter={() => setSearchSelectedIndex(idx)}
                          onClick={(event) =>
                            openSearchItem(item, { newTab: event.metaKey || event.ctrlKey, split: event.altKey })
                          }
                        >
                          <PageIconOrDoc icon={pagesById.get(item.pageId)?.icon ?? item.result.pageIcon ?? undefined} kind={pagesById.get(item.pageId)?.kind} />
                          <SearchHitContent result={item.result} keywords={workspaceSearch.response?.keywords ?? []} />
                        </button>
                      </li>
                    );
                  })}
                </>
              )}
            </ul>
          </div>
        </div>
      )}

      {/* Noty 설정 모달 (⌘,) */}
      {isSettingsModalOpen && (
        <div
          className="search-modal-backdrop"
          onClick={() => setIsSettingsModalOpen(false)}
        >
          <div
            className="settings-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="settings-modal__header">
              <div className="settings-modal__title-group">
                <SettingsGearSvgIcon />
                <strong>Noty 설정</strong>
              </div>
              <button
                type="button"
                className="ds-btn ds-btn--ghost ds-btn--icon"
                onClick={() => setIsSettingsModalOpen(false)}
                aria-label="설정 닫기"
              >
                <CloseSvgIcon />
              </button>
            </div>
            <div className="settings-modal__body">
              <div className="settings-row">
                <div>
                  <div className="settings-row__label">로그인 계정</div>
                  <div className="settings-row__desc">
                    {authSession.user.displayName} (<code>@{authSession.user.username}</code>)
                  </div>
                </div>
                <button
                  type="button"
                  className="ds-btn ds-btn--outline ds-btn--md settings-logout-btn"
                  onClick={() => void handleLogout()}
                >
                  로그아웃 / 서버 변경
                </button>
              </div>
              <div className="settings-row">
                <div>
                  <div className="settings-row__label">연결된 서버 호스트</div>
                  <div className="settings-row__desc">
                    <code>{authSession.serverHost}</code>
                  </div>
                </div>
                <span className="settings-badge settings-badge--ok">연결됨</span>
              </div>
              <div className="settings-row">
                <div>
                  <div className="settings-row__label">단축키 안내</div>
                  <div className="settings-row__desc">
                    검색 <code>⌘K</code> · AI <code>⌘J</code> · 새 탭 <code>⌘T</code> · 탭 닫기 <code>⌘W</code> · 사이드바 <code>⌘\</code>
                  </div>
                </div>
              </div>
              <AIProviderSettings authSession={authSession} statusVersion={aiStatusVersion} />
            </div>
          </div>
        </div>
      )}


      <main className="workspace">
        {/* 노션 데스크톱 스타일 상단 단일 탭 바 */}
        <div className="noty-tabbar" role="tablist" aria-label="열린 페이지 탭">
          {!isSidebarOpen && (
            <button
              type="button"
              className="ds-btn ds-btn--ghost ds-btn--icon tabbar-sidebar-btn"
              onClick={() => setIsSidebarOpen(true)}
              title="사이드바 열기 (⌘\)"
              aria-label="사이드바 열기"
            >
              <SidebarToggleSvgIcon />
            </button>
          )}

          <div className="noty-tabbar__scroll">
            {tabs.map((tab) => {
              const isHomeTab = tab.pageId === HOME_PAGE_ID;
              const pageMeta = tab.pageId && !isHomeTab ? pagesById.get(tab.pageId) : undefined;
              const title = isHomeTab
                ? "홈"
                : tab.pageId
                ? pageMeta?.title || "제목 없는 문서"
                : "페이지 선택…";
              const isFocusedTab = tab.id === activeTabId;
              const splitIndex = splitTabIds.indexOf(tab.id);
              const isInSplit = splitIndex !== -1;

              return (
                <div
                  key={tab.id}
                  role="tab"
                  aria-selected={isFocusedTab}
                  draggable
                  onDragStart={(event) => {
                    setDraggingTabId(tab.id);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", tab.id);
                  }}
                  onDragOver={(event) => {
                    if (!draggingTabId || draggingTabId === tab.id) return;
                    event.preventDefault();
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (!draggingTabId || draggingTabId === tab.id) return;
                    setTabs((prev) => {
                      const fromIdx = prev.findIndex((t) => t.id === draggingTabId);
                      const toIdx = prev.findIndex((t) => t.id === tab.id);
                      if (fromIdx === -1 || toIdx === -1) return prev;
                      const copy = [...prev];
                      const [moved] = copy.splice(fromIdx, 1);
                      copy.splice(toIdx, 0, moved);
                      return copy;
                    });
                    setDraggingTabId(null);
                  }}
                  onDragEnd={() => setDraggingTabId(null)}
                  onClick={() => handleClickTab(tab.id)}
                  onAuxClick={(event) => {
                    if (event.button === 1 && tabs.length > 1) {
                      event.preventDefault();
                      handleCloseTab(tab.id);
                    }
                  }}
                  className={[
                    "noty-tab",
                    isFocusedTab ? "noty-tab--active" : "",
                    isInSplit && splitTabIds.length > 1 ? "noty-tab--in-split" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  <span className="noty-tab__icon">
                    {isHomeTab ? (
                      <HomeSvgIcon />
                    ) : (
                      <PageIconOrDoc
                        icon={pageMeta?.icon}
                        kind={pageMeta?.kind}
                        hasChildren={Boolean(tab.pageId && (pagesByParent.get(tab.pageId)?.length ?? 0) > 0)}
                      />
                    )}
                  </span>
                  <span className="noty-tab__title">{title}</span>
                  {isInSplit && splitTabIds.length > 1 && (
                    <span className="noty-tab__split-badge" title={`${splitIndex + 1}번째 분할 창에 표시 중`}>
                      {splitIndex + 1}
                    </span>
                  )}
                  <div className="noty-tab__actions">
                    {(tabs.length > 1 || splitTabIds.length > 1) && (
                      <button
                        type="button"
                        className={`ds-btn ds-btn--ghost ds-btn--icon noty-tab__btn ${isInSplit && splitTabIds.length > 1 ? "noty-tab__btn--active" : ""}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleToggleTabInSplit(tab.id);
                        }}
                        title={
                          isInSplit && splitTabIds.length > 1
                            ? "분할 화면에서 숨기기"
                            : "한 화면에 나란히 분할 표시 (최대 3개)"
                        }
                        aria-label="분할 화면 토글"
                      >
                        <SplitPaneSvgIcon />
                      </button>
                    )}
                    {tabs.length > 1 && (
                      <button
                        type="button"
                        className="ds-btn ds-btn--ghost ds-btn--icon noty-tab__btn"
                        onClick={(event) => handleCloseTab(tab.id, event)}
                        title="탭 닫기 (⌘W)"
                        aria-label="탭 닫기"
                      >
                        <CloseSvgIcon />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}

            <button
              type="button"
              className="ds-btn ds-btn--ghost ds-btn--icon noty-tabbar__add-btn"
              onClick={() => void handleOpenInNewTab("", true)}
              title="새 탭 열기 (⌘T)"
              aria-label="새 탭 열기"
            >
              <PlusSvgIcon />
            </button>
          </div>
        </div>

        {/* 1단 / 2단 / 3단 가변 분할 에디터 영역 */}
        <div
          ref={splitContainerRef}
          className={`split-workspace split-workspace--count-${visibleSplitTabs.length}`}
        >
          {/* 사이드바 페이지나 상단 탭을 드래그 중일 때 우측 분할 드롭 영역 표시 */}
          {(draggingTabId || draggingPageId) && visibleSplitTabs.length < 3 && (
            <div
              className="split-drop-zone"
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
              onDrop={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (draggingTabId) {
                  if (!splitTabIds.includes(draggingTabId)) {
                    handleToggleTabInSplit(draggingTabId);
                  }
                  setDraggingTabId(null);
                } else if (draggingPageId) {
                  const targetPid = draggingPageId;
                  setDraggingPageId(null);
                  setDropIndicator(null);
                  void handleOpenInSplitPane(targetPid, activeTabId);
                }
              }}
            >
              <div className="split-drop-zone__label">
                <SplitPaneSvgIcon />
                <span>여기에 놓아 우측 분할 화면으로 열기</span>
              </div>
            </div>
          )}

          {visibleSplitTabs.map((paneTab, paneIndex) => {
            const panePageId = paneTab.pageId;
            const paneDoc = panePageId ? documentsByPageId[panePageId] : undefined;
            const paneSaveState = panePageId ? (saveStatesByPageId[panePageId] ?? "saved") : "saved";
            const paneBreadcrumbs = panePageId
              ? buildBreadcrumbsForPage(panePageId, pagesById)
              : [];
            const isPaneFocused = paneTab.id === activeTabId;
            const ratio = splitRatios[paneIndex] ?? 100 / visibleSplitTabs.length;

            // 다른 분할 창에 이미 열려 있는 페이지 ID 집합
            const otherOpenPageIds = new Set(
              visibleSplitTabs
                .filter((t) => t.id !== paneTab.id && t.pageId)
                .map((t) => t.pageId),
            );
            const sortedCandidatePages = [
              ...pages.filter((p) => !otherOpenPageIds.has(p.id)),
              ...pages.filter((p) => otherOpenPageIds.has(p.id)),
            ];

            const paneContextValue: WorkspacePagesContextValue = {
              pagesById,
              pagesByParent,
              onSelectPage: (targetId, opts) => {
                void handleSelectPage(targetId, {
                  ...opts,
                  targetTabId: paneTab.id,
                });
              },
            };

            return (
              <div
                key={paneTab.id}
                className="split-pane-wrapper"
                style={{ width: `${ratio}%` }}
              >
                <div
                  className={[
                    "split-pane",
                    isPaneFocused ? "split-pane--focused" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onMouseDown={() => {
                    if (activeTabId !== paneTab.id) {
                      setActiveTabId(paneTab.id);
                    }
                  }}
                >
                  <header className="topbar">
                    <div className="topbar-left">
                      {panePageId === HOME_PAGE_ID ? (
                        <nav className="breadcrumbs" aria-label="문서 경로">
                          <span className="breadcrumb-segment">
                            <span className="breadcrumb-btn breadcrumb-btn--active">
                              <span className="breadcrumb-emoji" aria-hidden="true">
                                <HomeSvgIcon />
                              </span>
                              <span>홈</span>
                            </span>
                          </span>
                        </nav>
                      ) : panePageId ? (
                        <>
                          <nav className="breadcrumbs" aria-label="문서 경로">
                            {paneBreadcrumbs.map((crumb, index) => (
                              <span key={crumb.id} className="breadcrumb-segment">
                                {index > 0 && <span className="breadcrumb-sep">/</span>}
                                <button
                                  type="button"
                                  className={`breadcrumb-btn ${crumb.id === panePageId ? "breadcrumb-btn--active" : ""}`}
                                  onClick={(event) =>
                                    void handleSelectPage(crumb.id, {
                                      newTab: event.metaKey || event.ctrlKey,
                                      split: event.altKey,
                                      targetTabId: paneTab.id,
                                    })
                                  }
                                >
                                  {crumb.icon && (
                                    <span className="breadcrumb-emoji" aria-hidden="true">
                                      {crumb.icon}
                                    </span>
                                  )}
                                  <span>{crumb.title || "제목 없는 문서"}</span>
                                </button>
                              </span>
                            ))}
                          </nav>
                          <span className={`save-state save-state--${paneSaveState}`}>
                            {saveLabelMap[paneSaveState]}
                          </span>
                        </>
                      ) : (
                        <span className="breadcrumb-btn breadcrumb-btn--active">
                          열 페이지 선택
                        </span>
                      )}
                    </div>

                    <div className="topbar-right">
                      {panePageId && panePageId !== HOME_PAGE_ID && pagesById.get(panePageId)?.kind !== "canvas" && (() => {
                        const panePageWidth = normalizePageWidthValue(
                          pagesById.get(panePageId)?.pageWidth,
                        );
                        return (
                          <button
                            type="button"
                            className={`ds-btn ds-btn--ghost topbar-width-btn ${pageWidthMenu?.pageId === panePageId ? "topbar-width-btn--active" : ""}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              const rect = event.currentTarget.getBoundingClientRect();
                              setPageWidthMenu((prev) =>
                                prev?.pageId === panePageId
                                  ? null
                                  : {
                                      pageId: panePageId,
                                      x: Math.max(12, rect.right - 268),
                                      y: rect.bottom + 6,
                                    },
                              );
                            }}
                            title="페이지 가로 사이즈 설정 (기본 / 넓게 / 직접 지정 / 전체 화면)"
                            aria-label="페이지 가로 사이즈 설정"
                          >
                            <PageWidthSvgIcon isFull={panePageWidth === "full"} />
                            <span className="topbar-width-btn__label">
                              {getPageWidthShortLabel(panePageWidth)}
                            </span>
                          </button>
                        );
                      })()}
                      {panePageId && panePageId !== HOME_PAGE_ID && pagesById.get(panePageId)?.kind !== "canvas" && (
                        <button
                          type="button"
                          className={`ds-btn ds-btn--ghost ds-btn--icon topbar-action-btn ${historyTabId === paneTab.id ? "topbar-action-btn--active" : ""}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            setActiveTabId(paneTab.id);
                            setHistoryTabId(paneTab.id);
                          }}
                          title="페이지 기록"
                          aria-label="페이지 기록"
                        >
                          <HistorySvgIcon />
                        </button>
                      )}
                      {panePageId && panePageId !== HOME_PAGE_ID && pagesById.get(panePageId)?.kind !== "canvas" && !isReadOnlyUser && (
                        <button
                          type="button"
                          className={`ds-btn ds-btn--ghost ds-btn--icon topbar-action-btn ${isTemplatePanelOpen ? "topbar-action-btn--active" : ""}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            setActiveTabId(paneTab.id);
                            if (isTemplatePanelOpen) setIsTemplatePanelOpen(false);
                            else openTemplatePanel();
                          }}
                          title={isTemplatePanelOpen ? "템플릿 닫기" : "템플릿"}
                          aria-label="템플릿"
                          aria-pressed={isTemplatePanelOpen}
                        >
                          <TemplateSvgIcon />
                        </button>
                      )}
                      <button
                        type="button"
                        className={`ds-btn ds-btn--ghost ds-btn--icon topbar-action-btn ${isAIPanelOpen ? "topbar-action-btn--active" : ""}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setActiveTabId(paneTab.id);
                          setIsAIPanelOpen((prev) => !prev);
                        }}
                        title={isAIPanelOpen ? "AI 어시스턴트 닫기 (⌘J)" : "AI 어시스턴트 열기 (⌘J)"}
                        aria-label="AI 어시스턴트"
                        aria-pressed={isAIPanelOpen}
                      >
                        <AISparkleSvgIcon />
                      </button>
                      {visibleSplitTabs.length > 1 && (
                        <button
                          type="button"
                          className="ds-btn ds-btn--ghost ds-btn--icon topbar-action-btn"
                          onClick={(event) => {
                            event.stopPropagation();
                            handleCloseSplitPane(paneTab.id);
                          }}
                          title="이 분할 창 닫기"
                          aria-label="이 분할 창 닫기"
                        >
                          <CloseSvgIcon />
                        </button>
                      )}
                    </div>
                  </header>

                  <div className="split-pane__body">
                    {panePageId === HOME_PAGE_ID ? (
                      <HomeDashboard
                        authSession={authSession}
                        pages={pages}
                        pagesById={pagesById}
                        lastActivePageId={lastActivePageId}
                        onSelectPage={(id) =>
                          void handleSelectPage(id, { targetTabId: paneTab.id })
                        }
                        onCreatePage={(parentId) => void handleCreatePage(parentId)}
                        onOpenSearch={() => {
                          setIsSearchModalOpen(true);
                          setSearchQuery("");
                          setSearchSelectedIndex(0);
                        }}
                      />
                    ) : !panePageId ? (
                      <div className="empty-pane-picker">
                        <div className="empty-pane-picker__card">
                          <div className="empty-pane-picker__header">
                            <strong>이 화면에 열 페이지를 선택하세요</strong>
                            <span>
                              아래 목록에서 다른 페이지를 고르거나 왼쪽 사이드바에서 페이지를 클릭하세요.
                            </span>
                          </div>
                          <button
                            type="button"
                            className="ds-btn ds-btn--outline empty-pane-picker__create-btn"
                            data-requires-edit
                            onClick={() => {
                              setActiveTabId(paneTab.id);
                              void handleCreatePage(null);
                            }}
                          >
                            <PlusSvgIcon />
                            <span>새 페이지 만들어서 열기</span>
                          </button>
                          <ul className="empty-pane-picker__list">
                            {sortedCandidatePages.map((candidate) => {
                              const alreadyOpenElsewhere = otherOpenPageIds.has(candidate.id);
                              return (
                                <li key={candidate.id}>
                                  <button
                                    type="button"
                                    className="empty-pane-picker__item"
                                    onClick={() =>
                                      void handleSelectPage(candidate.id, {
                                        targetTabId: paneTab.id,
                                      })
                                    }
                                  >
                                    <PageIconOrDoc
                                      icon={candidate.icon}
                                      hasChildren={(pagesByParent.get(candidate.id)?.length ?? 0) > 0}
                                    />
                                    <span className="empty-pane-picker__item-title">
                                      {candidate.title || "제목 없는 문서"}
                                    </span>
                                    {alreadyOpenElsewhere && (
                                      <span className="empty-pane-picker__badge">
                                        다른 창에 열림
                                      </span>
                                    )}
                                  </button>
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      </div>
                    ) : pagesById.get(panePageId)?.kind === "canvas" ? (
                      <CanvasPane
                        key={`${paneTab.id}-${panePageId}`}
                        pageId={panePageId}
                        authSession={authSession}
                        pages={pages}
                        pagesById={pagesById}
                        readOnly={isReadOnlyUser}
                        onOpenPage={(id) => void handleSelectPage(id, { targetTabId: paneTab.id })}
                        onCreatePage={handleCreatePageFromCanvas}
                        onRename={(title) => handleRenamePageTitle(panePageId, title)}
                        renderPageEditor={(cardPageId) => (
                          <CanvasCardEditor
                            pageId={cardPageId}
                            contextValue={paneContextValue}
                            editorProps={{
                              authSession,
                              // 실제 페이지 폭 값을 넘긴다 (편집기가 이 값을 Yjs 에 맞춰 두므로 임의 값을 넘기면 페이지 설정이 바뀐다)
                              pageWidth: pagesById.get(cardPageId)?.pageWidth,
                              pages,
                              pagesById,
                              onSelectPage: (id) => void handleSelectPage(id, { targetTabId: paneTab.id }),
                              onInsertPageBlockAndOpen: (parentId, getUpdatedBlocks, kind) =>
                                handleInsertPageBlockAndOpen(parentId, getUpdatedBlocks, paneTab.id, kind),
                              onSaveBlocks: scheduleSave,
                              onTitlePreviewChange: handleTitlePreviewChange,
                              onReorderChildPages: handleReorderChildPages,
                              onRequestPagesRefresh: handleRefreshPages,
                              onTrashPageBlocks: handleTrashPageBlocks,
                              onOpenOrCreateCollectionRowPage: handleOpenOrCreateCollectionRowPage,
                            }}
                          />
                        )}
                      />
                    ) : paneDoc ? (
                      <WorkspacePagesContext.Provider value={paneContextValue}>
                        <CollectionActionsContext.Provider
                          value={{
                            parentPageId: paneDoc.pageId,
                            onOpenOrCreateRowPage: handleOpenOrCreateCollectionRowPage,
                          }}
                        >
                          <EditorPane
                            key={`${paneTab.id}-${paneDoc.pageId}-${paneDoc.revision}`}
                            authSession={authSession}
                            isHistoryOpen={historyTabId === paneTab.id}
                            onCloseHistory={closeHistory}
                            pageId={paneDoc.pageId}
                            pageWidth={pagesById.get(paneDoc.pageId)?.pageWidth}
                            pages={pages}
                            pagesById={pagesById}
                            initialContent={paneDoc.blocks}
                            onSelectPage={(id) =>
                              void handleSelectPage(id, { targetTabId: paneTab.id })
                            }
                            onInsertPageBlockAndOpen={(parentId, getUpdatedBlocks, kind) =>
                              handleInsertPageBlockAndOpen(
                                parentId,
                                getUpdatedBlocks,
                                paneTab.id,
                                kind,
                              )
                            }
                            onSaveBlocks={scheduleSave}
                            onTitlePreviewChange={handleTitlePreviewChange}
                            onReorderChildPages={handleReorderChildPages}
                            onRequestPagesRefresh={handleRefreshPages}
                            onTrashPageBlocks={handleTrashPageBlocks}
                            onOpenOrCreateCollectionRowPage={handleOpenOrCreateCollectionRowPage}
                            onSyncPageWidthFromYjs={handleSyncPageWidthFromYjs}
                            templatePreview={paneTab.id === activeTabId ? templatePreview : null}
                            templateApplyRequest={paneTab.id === activeTabId ? templateApplyRequest : null}
                            onOpenTemplates={() => {
                              setActiveTabId(paneTab.id);
                              openTemplatePanel();
                            }}
                            onAIBridgeChange={paneTab.id === activeTabId ? setAIEditorBridge : undefined}
                            onAskAI={paneTab.id === activeTabId ? openAIForSelection : undefined}
                          />
                        </CollectionActionsContext.Provider>
                      </WorkspacePagesContext.Provider>
                    ) : (
                      <div className="center-message">문서를 불러오는 중…</div>
                    )}
                  </div>
                </div>

                {/* 분할 창 사이의 드래그 리사이즈 핸들 (더블클릭 시 균등 정렬) */}
                {paneIndex < visibleSplitTabs.length - 1 && (
                  <div
                    className={`split-resizer ${resizingSplitIndex === paneIndex ? "split-resizer--active" : ""}`}
                    title="드래그하여 폭 조절 (더블클릭 시 균등 분할)"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      splitResizeStartRef.current = {
                        index: paneIndex,
                        startX: event.clientX,
                        initialRatios: [...splitRatios],
                      };
                      setResizingSplitIndex(paneIndex);
                    }}
                    onDoubleClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setSplitRatios(equalizeSplitRatios(visibleSplitTabs.length));
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </main>

      {isImportOpen && (
        <NotionImportDialog
          deps={{
            parseMarkdown: (() => {
              // 화면에 붙이지 않은 편집기: 앱과 같은 블록 스키마로 마크다운만 변환한다
              let parser: any = null;
              return (markdown: string) => {
                parser ??= BlockNoteEditor.create({ schema } as any);
                return parser.tryParseMarkdownToBlocks(markdown);
              };
            })(),
            createPage: async (parentId, title) =>
              (await workspaceApi.createPage({ parentId, title, insertIntoParentBlocks: false })).page.id,
            saveBlocks: async (id, blocks, title) => {
              await workspaceApi.saveDocument(blocks, { id, title });
            },
            uploadFile: async (name, type, bytes) => (await workspaceApi.saveAttachment({ name, type, bytes })).url,
            ensureCollection: async (id, ownerPageId, data) => {
              await workspaceApi.ensureCollection(id, ownerPageId, data);
            },
          }}
          onClose={() => {
            setIsImportOpen(false);
            handleRefreshPages();
          }}
          onOpenPage={setPendingOpenPageId}
        />
      )}
      {templateDialog && (
        <TemplateSaveDialog
          initial={templateDialog.initial}
          pageBlocks={templateDialog.blocks}
          onClose={() => setTemplateDialog(null)}
          onSave={async (values) => {
            const { template } = templateDialog;
            if (template) {
              const { template: saved } = await workspaceApi.updateTemplate(template.id, values);
              setUserTemplates((prev) => prev.map((t) => (t.id === saved.id ? toPageTemplate(saved) : t)));
            } else {
              const { template: saved } = await workspaceApi.createTemplate({ ...values, blocks: values.blocks ?? [] });
              setUserTemplates((prev) => [toPageTemplate(saved), ...prev]);
            }
            setTemplateDialog(null);
            openTemplatePanel();
          }}
        />
      )}
      <TemplatePanel
        isOpen={isTemplatePanelOpen}
        userTemplates={userTemplates}
        onSaveCurrent={() => activePageId && void openSaveTemplateDialog(activePageId)}
        onEditTemplate={(template) =>
          setTemplateDialog({
            template,
            initial: { name: template.name, icon: template.icon, description: template.description },
          })
        }
        onOverwriteTemplate={(template) => activePageId && void openSaveTemplateDialog(activePageId, template)}
        onDeleteTemplate={(template) =>
          void workspaceApi
            .deleteTemplate(template.id)
            .then(() => setUserTemplates((prev) => prev.filter((t) => t.id !== template.id)))
            .catch((error) => console.error("Failed to delete template", error))
        }
        canApply={
          !isReadOnlyUser &&
          Boolean(activePageId) &&
          activePageId !== HOME_PAGE_ID &&
          pagesById.get(activePageId)?.kind !== "canvas"
        }
        onClose={() => setIsTemplatePanelOpen(false)}
        onPreview={setTemplatePreview}
        onApply={(template) => setTemplateApplyRequest((prev) => ({ template, nonce: (prev?.nonce ?? 0) + 1 }))}
        onOpenAI={() => setIsAIPanelOpen(true)}
      />
      <AIChatPanel
        isOpen={isAIPanelOpen}
        activePageId={activePageId && activePageId !== HOME_PAGE_ID ? activePageId : undefined}
        activePageTitle={
          activePageId && activePageId !== HOME_PAGE_ID
            ? pagesById.get(activePageId)?.title || "제목 없는 문서"
            : undefined
        }
        getActivePageContext={() =>
          activePageId && activePageId !== HOME_PAGE_ID
            ? blocksToPlainText(documentsByPageId[activePageId]?.blocks as unknown[] | undefined)
            : ""
        }
        editorBridge={aiEditorBridge && aiEditorBridge.pageId === activePageId ? aiEditorBridge : null}
        focusNonce={aiFocusNonce}
        onClose={() => setIsAIPanelOpen(false)}
        onOpenSettings={() => setIsSettingsModalOpen(true)}
        statusVersion={aiStatusVersion}
        conceptRequest={aiConceptRequest}
        onOpenSource={(pageId, blockId) => {
          if (!pagesById.has(pageId)) return;
          void handleSelectPage(pageId);
          if (blockId) revealBlockWhenReady(blockId);
        }}
      />
    </div>
  );
}
