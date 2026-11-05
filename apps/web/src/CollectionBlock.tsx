import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createReactBlockSpec, useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import { withCollaboration } from "@blocknote/core/yjs";
import { ko } from "@blocknote/core/locales";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import {
  collectionMap,
  editCollectionCellText,
  editCollectionRowText,
  initializeCollectionMap,
  patchCollectionMap,
  readCollectionMap,
} from "@noty/shared/collection-yjs";
import { CollectionRichText } from "./CollectionRichText";
import { createDefaultCollectionData, migrateLegacyCollectionData, MULTI_VALUE_SEPARATOR } from "@noty/shared/collection-schema";
import { computeColumnCalculation, computePropertyValue } from "@noty/shared/collection-computed";
import { getStoredAuthSession, resolveUploadUrl, workspaceApi } from "./api";
import { resolveCollaborationWsUrl } from "./collaboration-url";
export { createDefaultCollectionData } from "@noty/shared/collection-schema";

import type {
  CollectionCalculationType,
  CollectionData,
  CollectionFilterOperator,
  CollectionOptionColor,
  CollectionProperty,
  CollectionPropertyType,
  CollectionRow,
  CollectionSortBy,
  CollectionSortDirection,
  CollectionSortRule,
  CollectionStatus,
  CollectionTagOption,
  CollectionTemplate,
  CollectionView,
  CollectionViewMode,
} from "@noty/shared/collection-types";
export type {
  CollectionData,
  CollectionProperty,
  CollectionPropertyType,
  CollectionRow,
  CollectionSortBy,
  CollectionStatus,
  CollectionTagOption,
  CollectionView,
  CollectionViewMode,
} from "@noty/shared/collection-types";

export interface CollectionActionsContextValue {
  parentPageId: string;
  collaborationDoc?: Y.Doc;
  collaborationProvider?: HocuspocusProvider | null;
  onCollectionDataChange?: () => void;
  onOpenOrCreateRowPage: (
    parentPageId: string,
    rowTitle: string,
    existingPageId?: string,
    openInSplit?: boolean,
    onCreated?: (pageId: string) => void,
  ) => Promise<string>;
}

export const CollectionActionsContext = createContext<CollectionActionsContextValue>({
  parentPageId: "",
  onOpenOrCreateRowPage: async () => "",
});

export const STATUS_META: Record<
  CollectionStatus,
  { label: string; colorClass: string; dotColor: string; order: number }
> = {
  todo: { label: "시작 전", colorClass: "ndb-pill--gray", dotColor: "#9b9a97", order: 0 },
  in_progress: { label: "진행 중", colorClass: "ndb-pill--blue", dotColor: "#2383e2", order: 1 },
  review: { label: "검토 중", colorClass: "ndb-pill--amber", dotColor: "#d9730d", order: 2 },
  done: { label: "완료", colorClass: "ndb-pill--green", dotColor: "#0f7b6c", order: 3 },
};

export const STATUS_KEYS: CollectionStatus[] = ["todo", "in_progress", "review", "done"];

const OPTION_COLOR_PALETTE: CollectionOptionColor[] = ["gray", "blue", "green", "amber", "purple", "rose"];

const PROPERTY_TYPE_META: Array<{ type: CollectionPropertyType; label: string; icon: string }> = [
  { type: "text", label: "텍스트", icon: "≡" },
  { type: "number", label: "숫자", icon: "#" },
  { type: "select", label: "선택", icon: "◉" },
  { type: "multi_select", label: "다중 선택", icon: "☰" },
  { type: "status", label: "상태", icon: "✦" },
  { type: "date", label: "날짜", icon: "📅" },
  { type: "checkbox", label: "체크박스", icon: "☑" },
  { type: "url", label: "URL", icon: "🔗" },
  { type: "email", label: "이메일", icon: "✉" },
  { type: "phone", label: "전화번호", icon: "☎" },
  { type: "relation", label: "관계형", icon: "↗" },
  { type: "rollup", label: "롤업", icon: "∑" },
  { type: "formula", label: "수식", icon: "ƒ" },
];

const VIEW_MODE_META: Array<{ mode: CollectionViewMode; label: string; icon: string }> = [
  { mode: "table", label: "표", icon: "☰" },
  { mode: "board", label: "보드", icon: "◫" },
  { mode: "calendar", label: "캘린더", icon: "▦" },
  { mode: "list", label: "리스트", icon: "≡" },
  { mode: "gallery", label: "갤러리", icon: "▧" },
];

const CALCULATION_LABELS: Record<CollectionCalculationType, string> = {
  none: "계산",
  count_all: "전체 개수",
  count_values: "값 있음",
  count_empty: "비어 있음",
  count_unique: "고유값 수",
  percent_checked: "체크 비율",
  percent_unchecked: "미체크 비율",
  sum: "합계",
  average: "평균",
  min: "최솟값",
  max: "최댓값",
};

const ROW_ICON_PRESETS = ["📄", "📝", "✅", "🔥", "💡", "📌", "🚀", "🎯", "📅", "⭐", "🐛", "📦", "📊", "🗂️", "💬", "⚡"];

function propertyIcon(type: CollectionPropertyType): string {
  return PROPERTY_TYPE_META.find((item) => item.type === type)?.icon ?? "Aa";
}

function getOptionColor(property: CollectionProperty, option: string): CollectionOptionColor {
  if (!option) return "gray";
  const explicit = property.optionColors?.[option];
  if (explicit && OPTION_COLOR_PALETTE.includes(explicit)) return explicit;
  if (option === "완료" || option.toLowerCase() === "done") return "green";
  if (option === "진행 중" || option.toLowerCase() === "in progress") return "blue";
  if (option === "검토 중" || option.toLowerCase() === "review") return "amber";
  if (option === "시작 전" || option.toLowerCase() === "todo") return "gray";
  const index = (property.options ?? []).indexOf(option);
  if (index >= 0) return OPTION_COLOR_PALETTE[(index + 1) % OPTION_COLOR_PALETTE.length];
  let hash = 0;
  for (let i = 0; i < option.length; i++) hash = (hash * 31 + option.charCodeAt(i)) >>> 0;
  return OPTION_COLOR_PALETTE[hash % OPTION_COLOR_PALETTE.length];
}

function formatNumberDisplay(raw: string | number | boolean | undefined, format?: CollectionProperty["numberFormat"]): string {
  if (raw === "" || raw === undefined || raw === false || raw === true) return "";
  const num = Number(raw);
  if (!Number.isFinite(num)) return String(raw);
  if (!format || format === "number") return String(raw);
  if (format === "comma") return num.toLocaleString("ko-KR");
  if (format === "krw") return `₩${num.toLocaleString("ko-KR")}`;
  if (format === "usd") return `$${num.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
  if (format === "percent") return `${num}%`;
  return String(raw);
}

function parseCollectionData(raw: string): CollectionData {
  if (!raw || !raw.trim()) {
    return createDefaultCollectionData();
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CollectionData> & { view?: CollectionViewMode };
    const defaults = createDefaultCollectionData();
    const parsedViews: CollectionView[] = Array.isArray(parsed.views)
      ? parsed.views
          .filter((view): view is CollectionView => Boolean(view && typeof view.id === "string"))
          .map((view, index): CollectionView => ({
            id: view.id || `view-${index + 1}`,
            name: typeof view.name === "string" && view.name.trim() ? view.name : `뷰 ${index + 1}`,
            mode: ["board", "calendar", "gallery", "list"].includes(view.mode) ? view.mode : "table",
            statusFilter: STATUS_KEYS.includes(view.statusFilter as CollectionStatus) ? view.statusFilter : "all",
            tagFilter: typeof view.tagFilter === "string" ? view.tagFilter : "all",
            propertyFilterId: typeof view.propertyFilterId === "string" ? view.propertyFilterId : "",
            propertyFilterValue: typeof view.propertyFilterValue === "string" ? view.propertyFilterValue : "",
            sortBy: typeof view.sortBy === "string" ? view.sortBy : "manual",
            sortDirection: view.sortDirection === "desc" ? "desc" : "asc",
            ...(Array.isArray(view.sorts) ? { sorts: view.sorts } : {}),
            hideCompleted: Boolean(view.hideCompleted),
            groupBy: typeof view.groupBy === "string" ? view.groupBy : "",
            ...(Array.isArray(view.collapsedGroups) ? { collapsedGroups: view.collapsedGroups } : {}),
            datePropertyId: typeof view.datePropertyId === "string" ? view.datePropertyId : "",
            hiddenPropertyIds: Array.isArray(view.hiddenPropertyIds)
              ? view.hiddenPropertyIds.filter((id): id is string => typeof id === "string")
              : [],
            filters: Array.isArray(view.filters)
              ? view.filters.filter((item) => item && typeof item.propertyId === "string" && typeof item.value === "string")
              : [],
            filterMode: view.filterMode === "or" ? "or" : "and",
            ...(view.peekMode === "side" || view.peekMode === "center" ? { peekMode: view.peekMode } : {}),
            ...(typeof view.showTitle === "boolean" ? { showTitle: view.showTitle } : {}),
            ...(typeof view.titleWidth === "number" && Number.isFinite(view.titleWidth) ? { titleWidth: view.titleWidth } : {}),
            ...(typeof view.boardColumnWidth === "number" && Number.isFinite(view.boardColumnWidth) ? { boardColumnWidth: view.boardColumnWidth } : {}),
            ...(typeof view.galleryCardWidth === "number" && Number.isFinite(view.galleryCardWidth) ? { galleryCardWidth: view.galleryCardWidth } : {}),
            ...(typeof view.peekWidth === "number" && Number.isFinite(view.peekWidth) ? { peekWidth: view.peekWidth } : {}),
            ...(typeof view.peekLabelWidth === "number" && Number.isFinite(view.peekLabelWidth) ? { peekLabelWidth: view.peekLabelWidth } : {}),
          }))
      : [];
    const views: CollectionView[] =
      parsedViews.length > 0
        ? parsedViews
        : defaults.views.map((view, index): CollectionView =>
            index === 0 && parsed.view ? { ...view, mode: parsed.view === "board" ? "board" : "table" } : view,
          );
    const rows = Array.isArray(parsed.rows)
      ? parsed.rows.map((row, index) => ({
          id: typeof row?.id === "string" ? row.id : `row-${index + 1}`,
          title: typeof row?.title === "string" ? row.title : "",
          ...(typeof row?.icon === "string" && row.icon ? { icon: row.icon } : {}),
          ...(parsed.schemaVersion === 2
            ? {}
            : {
                status: STATUS_KEYS.includes(row?.status as CollectionStatus) ? (row.status as CollectionStatus) : "todo",
                tags: Array.isArray(row?.tags) ? row.tags.filter((tag): tag is string => typeof tag === "string") : [],
                date: typeof row?.date === "string" ? row.date : "",
                checked: Boolean(row?.checked),
                text: typeof row?.text === "string" ? row.text : "",
              }),
          values: row?.values && typeof row.values === "object" ? row.values : {},
          ...(typeof row?.linkedPageId === "string" ? { linkedPageId: row.linkedPageId } : {}),
        }))
      : defaults.rows;
    return migrateLegacyCollectionData({
      collectionId: typeof parsed.collectionId === "string" ? parsed.collectionId : undefined,
      schemaVersion: parsed.schemaVersion,
      title: typeof parsed.title === "string" ? parsed.title : defaults.title,
      ...(typeof parsed.icon === "string" && parsed.icon ? { icon: parsed.icon } : {}),
      activeViewId: views.some((view) => view.id === parsed.activeViewId) ? String(parsed.activeViewId) : views[0].id,
      views,
      tagOptions: Array.isArray(parsed.tagOptions) ? parsed.tagOptions : defaults.tagOptions,
      properties: Array.isArray(parsed.properties)
        ? parsed.properties.filter(
            (property): property is CollectionProperty =>
              Boolean(property && typeof property.id === "string" && typeof property.name === "string"),
          )
        : [],
      rows,
      ...(Array.isArray(parsed.templates) && parsed.templates.length > 0 ? { templates: parsed.templates } : {}),
    });
  } catch {
    return createDefaultCollectionData();
  }
}

function createRowId(): string {
  return `row-${Math.random().toString(36).slice(2, 9)}`;
}

function createViewId(): string {
  return `view-${Math.random().toString(36).slice(2, 9)}`;
}

function createPropertyId(): string {
  return `prop-${Math.random().toString(36).slice(2, 9)}`;
}

/* ==========================================================================
 * 1. Notion Option Picker (Select / Status / Multi-select)
 * ========================================================================== */
function NotionOptionCell({
  property,
  value,
  onChangeValue,
  onUpdateProperty,
  ariaLabel,
}: {
  property: CollectionProperty;
  value: string;
  onChangeValue: (nextValue: string) => void;
  onUpdateProperty: (patch: Partial<CollectionProperty>) => void;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const multiple = property.type === "multi_select";
  const isStatus = property.type === "status";

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const selected = useMemo(
    () => (multiple ? value.split(MULTI_VALUE_SEPARATOR).filter(Boolean) : value ? [value] : []),
    [value, multiple],
  );

  const options = property.options ?? [];
  const trimmed = query.trim();
  const filteredOptions = options.filter((opt) => !trimmed || opt.toLowerCase().includes(trimmed.toLowerCase()));
  const canCreate = trimmed.length > 0 && !options.some((opt) => opt.toLowerCase() === trimmed.toLowerCase());

  const toggleOption = (opt: string) => {
    if (multiple) {
      const next = selected.includes(opt) ? selected.filter((item) => item !== opt) : [...selected, opt];
      onChangeValue(next.join(MULTI_VALUE_SEPARATOR));
    } else {
      onChangeValue(selected.includes(opt) && !isStatus ? "" : opt);
      setOpen(false);
    }
  };

  const handleCreateOption = (optName: string) => {
    const clean = optName.trim();
    if (!clean) return;
    const nextOptions = options.includes(clean) ? options : [...options, clean];
    const assignedColor = OPTION_COLOR_PALETTE[nextOptions.length % OPTION_COLOR_PALETTE.length];
    onUpdateProperty({
      options: nextOptions,
      optionColors: { ...(property.optionColors ?? {}), [clean]: assignedColor },
    });
    if (multiple) {
      const next = selected.includes(clean) ? selected : [...selected, clean];
      onChangeValue(next.join(MULTI_VALUE_SEPARATOR));
    } else {
      onChangeValue(clean);
      setOpen(false);
    }
    setQuery("");
  };

  const cycleColor = (optName: string, event: React.MouseEvent) => {
    event.stopPropagation();
    const current = getOptionColor(property, optName);
    const nextColor = OPTION_COLOR_PALETTE[(OPTION_COLOR_PALETTE.indexOf(current) + 1) % OPTION_COLOR_PALETTE.length];
    onUpdateProperty({
      optionColors: { ...(property.optionColors ?? {}), [optName]: nextColor },
    });
  };

  const handleDeleteOption = (optName: string, event: React.MouseEvent) => {
    event.stopPropagation();
    onUpdateProperty({
      options: options.filter((item) => item !== optName),
    });
    if (selected.includes(optName)) {
      const next = selected.filter((item) => item !== optName);
      onChangeValue(multiple ? next.join(MULTI_VALUE_SEPARATOR) : "");
    }
  };

  return (
    <div className="ndb-option-cell" ref={wrapRef}>
      <button
        type="button"
        className="ndb-option-cell__trigger"
        aria-label={ariaLabel}
        onClick={() => setOpen((prev) => !prev)}
      >
        {selected.length === 0 ? (
          <span className="ndb-cell-placeholder">비어 있음</span>
        ) : (
          <span className="ndb-pill-list">
            {selected.map((opt) => {
              const color = getOptionColor(property, opt);
              return (
                <span key={opt} className={`ndb-pill ndb-pill--${color} ${isStatus ? "ndb-pill--status" : ""}`}>
                  {isStatus && <span className="ndb-pill__dot" />}
                  {opt}
                </span>
              );
            })}
          </span>
        )}
      </button>

      {open && (
        <div className="ndb-popover ndb-option-popover" onClick={(event) => event.stopPropagation()}>
          <div className="ndb-option-popover__top">
            {selected.length > 0 && (
              <div className="ndb-option-popover__selected">
                {selected.map((opt) => (
                  <span key={opt} className={`ndb-pill ndb-pill--${getOptionColor(property, opt)}`}>
                    {opt}
                    <button
                      type="button"
                      className="ndb-pill__remove"
                      onClick={() => toggleOption(opt)}
                      aria-label={`${opt} 선택 해제`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            <input
              type="text"
              className="ndb-option-popover__input"
              placeholder="옵션 검색 또는 새 옵션 입력 후 Enter…"
              value={query}
              autoFocus
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (canCreate) handleCreateOption(trimmed);
                  else if (filteredOptions.length > 0) toggleOption(filteredOptions[0]);
                } else if (event.key === "Escape") {
                  setOpen(false);
                }
              }}
            />
          </div>
          <div className="ndb-option-popover__list">
            {filteredOptions.map((opt) => {
              const color = getOptionColor(property, opt);
              const isSelected = selected.includes(opt);
              return (
                <div key={opt} className={`ndb-option-popover__item ${isSelected ? "ndb-option-popover__item--active" : ""}`}>
                  <button
                    type="button"
                    className="ndb-option-popover__item-btn"
                    onClick={() => toggleOption(opt)}
                  >
                    <span className={`ndb-pill ndb-pill--${color} ${isStatus ? "ndb-pill--status" : ""}`}>
                      {isStatus && <span className="ndb-pill__dot" />}
                      {opt}
                    </span>
                    {isSelected && <span className="ndb-option-popover__check">✓</span>}
                  </button>
                  <button
                    type="button"
                    className={`ndb-option-popover__color-btn ndb-pill--${color}`}
                    onClick={(event) => cycleColor(opt, event)}
                    title="배지 색상 변경"
                  >
                    ●
                  </button>
                  <button
                    type="button"
                    className="ndb-option-popover__del-btn"
                    onClick={(event) => handleDeleteOption(opt, event)}
                    title="옵션 삭제"
                  >
                    ×
                  </button>
                </div>
              );
            })}
            {canCreate && (
              <button
                type="button"
                className="ndb-option-popover__create"
                onClick={() => handleCreateOption(trimmed)}
              >
                <span>+ 생성</span>
                <span className={`ndb-pill ndb-pill--${OPTION_COLOR_PALETTE[options.length % OPTION_COLOR_PALETTE.length]}`}>
                  {trimmed}
                </span>
              </button>
            )}
            {filteredOptions.length === 0 && !canCreate && (
              <span className="ndb-option-popover__empty">위 입력창에 새 옵션 이름을 입력하고 Enter를 누르세요</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ==========================================================================
 * 2. Notion Relation Picker Cell
 * ========================================================================== */
function NotionRelationCell({
  property,
  value,
  targetCollection,
  onChangeValue,
  ariaLabel,
}: {
  property: CollectionProperty;
  value: string;
  targetCollection?: CollectionData;
  onChangeValue: (nextValue: string) => void;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const selectedIds = useMemo(() => value.split(MULTI_VALUE_SEPARATOR).filter(Boolean), [value]);
  const linkedRows = useMemo(
    () => (targetCollection?.rows ?? []).filter((r) => selectedIds.includes(r.id)),
    [targetCollection, selectedIds],
  );
  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (targetCollection?.rows ?? []).filter((r) => !q || (r.title || "제목 없음").toLowerCase().includes(q));
  }, [targetCollection, query]);

  const toggleRelation = (rowId: string) => {
    const next = selectedIds.includes(rowId)
      ? selectedIds.filter((id) => id !== rowId)
      : [...selectedIds, rowId];
    onChangeValue(next.join(MULTI_VALUE_SEPARATOR));
  };

  return (
    <div className="ndb-option-cell" ref={wrapRef}>
      <button
        type="button"
        className="ndb-option-cell__trigger"
        aria-label={ariaLabel}
        onClick={() => setOpen((prev) => !prev)}
      >
        {linkedRows.length === 0 ? (
          <span className="ndb-cell-placeholder">비어 있음</span>
        ) : (
          <span className="ndb-pill-list">
            {linkedRows.map((item) => (
              <span key={item.id} className="ndb-relation-chip">
                <span>{item.icon || "📄"}</span>
                <span>{item.title || "제목 없음"}</span>
              </span>
            ))}
          </span>
        )}
      </button>
      {open && (
        <div className="ndb-popover ndb-option-popover" onClick={(e) => e.stopPropagation()}>
          <div className="ndb-option-popover__top">
            <input
              type="text"
              className="ndb-option-popover__input"
              placeholder="연결할 항목 검색…"
              value={query}
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="ndb-option-popover__caption">
            {targetCollection ? `${targetCollection.title}` : property.name}
          </div>
          <div className="ndb-option-popover__list">
            {filteredRows.map((item) => {
              const isLinked = selectedIds.includes(item.id);
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`ndb-option-popover__item-btn ${isLinked ? "ndb-option-popover__item--active" : ""}`}
                  onClick={() => toggleRelation(item.id)}
                >
                  <span className="ndb-relation-chip">
                    <span>{item.icon || "📄"}</span>
                    <span>{item.title || "제목 없음"}</span>
                  </span>
                  {isLinked && <span className="ndb-option-popover__check">✓</span>}
                </button>
              );
            })}
            {filteredRows.length === 0 && (
              <span className="ndb-option-popover__empty">연결 가능한 항목이 없습니다.</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ==========================================================================
 * 3. Collaborative Row Body (BlockNote + Yjs XmlFragment)
 * ========================================================================== */
function CollectionRowBody({
  rowId,
  doc,
  provider,
}: {
  rowId: string;
  doc?: Y.Doc | null;
  provider?: HocuspocusProvider | null;
}) {
  const auth = getStoredAuthSession();
  const fallbackDoc = useMemo(() => new Y.Doc(), [rowId]);
  useEffect(() => () => fallbackDoc.destroy(), [fallbackDoc]);
  const targetDoc = doc ?? fallbackDoc;

  const editor = useCreateBlockNote(
    withCollaboration({
      dictionary: ko,
      uploadFile: async (file: File) => {
        const saved = await workspaceApi.saveAttachment({
          name: file.name,
          type: file.type,
          bytes: new Uint8Array(await file.arrayBuffer()),
        });
        return saved.url;
      },
      resolveFileUrl: resolveUploadUrl,
      collaboration: {
        provider: { awareness: provider?.awareness ?? undefined },
        fragment: targetDoc.getXmlFragment(`collection-row:${rowId}:body`),
        user: { name: auth?.user.displayName ?? "사용자", color: "#2383e2" },
        showCursorLabels: "activity",
      },
    } as any),
    [rowId, targetDoc, provider],
  );

  const handleBodyClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    try {
      const blocks = editor.document;
      if (blocks.length > 0) {
        editor.setTextCursorPosition(blocks[blocks.length - 1], "end");
      }
      editor.focus();
    } catch {
      editor.focus();
    }
  };

  return (
    <div className="ndb-row-editor" onClick={handleBodyClick}>
      <BlockNoteView editor={editor as any} theme="light" />
    </div>
  );
}

/* ==========================================================================
 * 4. Notion Row Peek Drawer / Modal (Side Peek & Center Modal)
 * ========================================================================== */
function NotionRowPeek({
  row,
  rowIndex,
  totalRows,
  data,
  relatedCollections,
  session,
  peekMode,
  peekWidth,
  peekLabelWidth,
  onResizePeek,
  onTogglePeekMode,
  onNavigateRow,
  onClose,
  onChangeTitle,
  onChangeIcon,
  onChangeText,
  onChangeValue,
  onUpdateProperty,
  onAddProperty,
  onDuplicateRow,
  onDeleteRow,
  onOpenFullPage,
}: {
  row: CollectionRow;
  rowIndex: number;
  totalRows: number;
  data: CollectionData;
  relatedCollections: Record<string, CollectionData>;
  session: { doc: Y.Doc; provider?: HocuspocusProvider | null } | null;
  peekMode: "side" | "center";
  peekWidth?: number;
  peekLabelWidth?: number;
  onResizePeek: (patch: { peekWidth?: number; peekLabelWidth?: number }, options?: { skipSnapshotSave?: boolean }) => void;
  onTogglePeekMode: () => void;
  onNavigateRow: (delta: -1 | 1) => void;
  onClose: () => void;
  onChangeTitle: (value: string) => void;
  onChangeIcon: (icon: string) => void;
  onChangeText: (value: string) => void;
  onChangeValue: (propertyId: string, value: string | boolean) => void;
  onUpdateProperty: (propertyId: string, patch: Partial<CollectionProperty>) => void;
  onAddProperty: (name: string, type: CollectionPropertyType) => void;
  onDuplicateRow: () => void;
  onDeleteRow: () => void;
  onOpenFullPage: (openInSplit?: boolean) => void;
}) {
  const [showIconPicker, setShowIconPicker] = useState(false);
  const [showAddPropPicker, setShowAddPropPicker] = useState(false);
  const [newPropName, setNewPropName] = useState("");
  const [resizingPeekTarget, setResizingPeekTarget] = useState<"drawer" | "label" | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const startResizeDrawer = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const defaultWidth = peekMode === "side" ? 600 : 840;
    const startWidth = peekWidth ?? defaultWidth;
    let latestWidth = startWidth;
    setResizingPeekTarget("drawer");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMouseMove = (moveEvent: MouseEvent) => {
      const delta = peekMode === "side" ? startX - moveEvent.clientX : (moveEvent.clientX - startX) * 2;
      latestWidth = Math.round(Math.max(360, Math.min(1200, startWidth + delta)));
      onResizePeek({ peekWidth: latestWidth }, { skipSnapshotSave: true });
    };
    const onMouseUp = () => {
      setResizingPeekTarget(null);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      onResizePeek({ peekWidth: latestWidth });
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  const startResizePropLabel = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = peekLabelWidth ?? 150;
    let latestWidth = startWidth;
    setResizingPeekTarget("label");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMouseMove = (moveEvent: MouseEvent) => {
      latestWidth = Math.round(Math.max(90, Math.min(360, startWidth + (moveEvent.clientX - startX))));
      onResizePeek({ peekLabelWidth: latestWidth }, { skipSnapshotSave: true });
    };
    const onMouseUp = () => {
      setResizingPeekTarget(null);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      onResizePeek({ peekLabelWidth: latestWidth });
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  const effectiveLabelWidth = peekLabelWidth ?? 150;
  const stopPeekEvent = (event: React.SyntheticEvent) => {
    event.stopPropagation();
  };

  return createPortal(
    <div
      className={`ndb-peek-backdrop ${peekMode === "side" ? "ndb-peek-backdrop--side" : "ndb-peek-backdrop--center"}`}
      onClick={stopPeekEvent}
      onDoubleClick={stopPeekEvent}
      onMouseDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
      onMouseUp={stopPeekEvent}
      onKeyDown={stopPeekEvent}
      onKeyUp={stopPeekEvent}
      onKeyPress={stopPeekEvent}
      onBeforeInput={stopPeekEvent}
      onInput={stopPeekEvent}
      onPaste={stopPeekEvent}
      onCut={stopPeekEvent}
      onCopy={stopPeekEvent}
      onFocus={stopPeekEvent}
      onBlur={stopPeekEvent}
      onDragStart={stopPeekEvent}
      onDrop={stopPeekEvent}
    >
      <aside
        className={`ndb-peek ${peekMode === "side" ? "ndb-peek--side" : "ndb-peek--center"}`}
        style={peekWidth ? { width: `min(${peekWidth}px, 94vw)` } : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={`${row.title || "제목 없음"} 페이지`}
      >
        <span
          className={`ndb-peek__resizer ${resizingPeekTarget === "drawer" ? "ndb-col-resizer--active" : ""}`}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={startResizeDrawer}
          onDoubleClick={(e) => {
            e.stopPropagation();
            onResizePeek({ peekWidth: undefined });
          }}
          title="드래그하여 상세 창 가로 너비 조절 · 더블클릭 시 초기화"
        />
        <header className="ndb-peek__topbar">
          <div className="ndb-peek__topbar-left">
            <button
              type="button"
              className="ndb-icon-btn"
              onClick={onClose}
              title="닫기 (Esc)"
              aria-label="항목 닫기"
            >
              »
            </button>
            <button
              type="button"
              className="ndb-topbar-btn"
              onClick={(event) => onOpenFullPage(event.altKey)}
              title="독립 문서 페이지로 열기 (⌥+클릭 시 분할 창)"
            >
              ⤢ {row.linkedPageId ? "연결된 문서 열기" : "전체 페이지로 열기"}
            </button>
            <button
              type="button"
              className="ndb-topbar-btn"
              onClick={onTogglePeekMode}
              title="열기 모드 전환"
            >
              {peekMode === "side" ? "▣ 중앙 모달" : "◧ 사이드 피크"}
            </button>
            <span className="ndb-peek__divider" />
            <button
              type="button"
              className="ndb-icon-btn"
              disabled={rowIndex <= 0}
              onClick={() => onNavigateRow(-1)}
              title="이전 항목"
            >
              ↑
            </button>
            <button
              type="button"
              className="ndb-icon-btn"
              disabled={rowIndex < 0 || rowIndex >= totalRows - 1}
              onClick={() => onNavigateRow(1)}
              title="다음 항목"
            >
              ↓
            </button>
          </div>
          <div className="ndb-peek__topbar-right">
            <button type="button" className="ndb-topbar-btn" onClick={onDuplicateRow} title="복제">
              ⧉ 복제
            </button>
            <button
              type="button"
              className="ndb-topbar-btn ndb-topbar-btn--danger"
              onClick={onDeleteRow}
              title="삭제"
            >
              🗑 삭제
            </button>
          </div>
        </header>

        <div className="ndb-peek__scroll">
          <div className="ndb-peek__hero">
            <div className="ndb-peek__icon-box">
              <button
                type="button"
                className="ndb-peek__icon-trigger"
                onClick={() => setShowIconPicker((prev) => !prev)}
                title="아이콘 선택"
              >
                {row.icon || "📄"}
              </button>
              {showIconPicker && (
                <div className="ndb-popover ndb-icon-popover">
                  <div className="ndb-icon-popover__grid">
                    {ROW_ICON_PRESETS.map((emoji) => (
                      <button
                        key={emoji}
                        type="button"
                        onClick={() => {
                          onChangeIcon(emoji);
                          setShowIconPicker(false);
                        }}
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                  {row.icon && (
                    <button
                      type="button"
                      className="ndb-icon-popover__remove"
                      onClick={() => {
                        onChangeIcon("");
                        setShowIconPicker(false);
                      }}
                    >
                      아이콘 제거
                    </button>
                  )}
                </div>
              )}
            </div>
            <input
              type="text"
              className="ndb-peek__title-input"
              value={row.title}
              onChange={(event) => onChangeTitle(event.target.value)}
              placeholder="제목 없음"
              aria-label="항목 제목"
            />
          </div>

          <div className="ndb-peek__props">
            {data.properties.map((property) => {
              const value = row.values?.[property.id];
              const related =
                property.relationCollectionId === data.collectionId
                  ? data
                  : relatedCollections[property.relationCollectionId ?? ""];
              return (
                <div
                  className="ndb-peek__prop-row"
                  key={property.id}
                  style={{ gridTemplateColumns: `${effectiveLabelWidth}px 1fr` }}
                >
                  <div className="ndb-peek__prop-label">
                    <span className="ndb-prop-icon">{propertyIcon(property.type)}</span>
                    <span className="ndb-peek__prop-name">{property.name}</span>
                    <span
                      className={`ndb-peek__prop-resizer ${resizingPeekTarget === "label" ? "ndb-col-resizer--active" : ""}`}
                      onClick={(e) => e.stopPropagation()}
                      onMouseDown={startResizePropLabel}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        onResizePeek({ peekLabelWidth: undefined });
                      }}
                      title="드래그하여 속성 이름 가로 너비 조절 · 더블클릭 시 초기화"
                    />
                  </div>
                  <div className="ndb-peek__prop-val">
                    {property.type === "checkbox" ? (
                      <input
                        type="checkbox"
                        className="ndb-checkbox"
                        checked={value === true}
                        onChange={(event) => onChangeValue(property.id, event.target.checked)}
                      />
                    ) : property.type === "select" || property.type === "status" || property.type === "multi_select" ? (
                      <NotionOptionCell
                        property={property}
                        value={String(value ?? "")}
                        onChangeValue={(next) => onChangeValue(property.id, next)}
                        onUpdateProperty={(patch) => onUpdateProperty(property.id, patch)}
                        ariaLabel={`${property.name} 값`}
                      />
                    ) : property.type === "relation" ? (
                      <NotionRelationCell
                        property={property}
                        value={String(value ?? "")}
                        targetCollection={related}
                        onChangeValue={(next) => onChangeValue(property.id, next)}
                        ariaLabel={`${property.name} 값`}
                      />
                    ) : property.type === "rollup" || property.type === "formula" ? (
                      <span className="ndb-computed-val">
                        {String(computePropertyValue(data, row, property, relatedCollections)) || "비어 있음"}
                      </span>
                    ) : property.type === "text" ? (
                      <CollectionRichText
                        value={String(value ?? "")}
                        onChange={(next) => onChangeValue(property.id, next)}
                        ariaLabel={`${property.name} 값`}
                      />
                    ) : (
                      <input
                        className="ndb-cell-input"
                        type={
                          property.type === "date"
                            ? "date"
                            : property.type === "number"
                              ? "number"
                              : property.type === "email"
                                ? "email"
                                : property.type === "url"
                                  ? "url"
                                  : property.type === "phone"
                                    ? "tel"
                                    : "text"
                        }
                        value={String(value ?? "")}
                        onChange={(event) => onChangeValue(property.id, event.target.value)}
                        placeholder="비어 있음"
                      />
                    )}
                  </div>
                </div>
              );
            })}

            <div className="ndb-peek__add-prop-wrap">
              <button
                type="button"
                className="ndb-peek__add-prop-btn"
                onClick={() => setShowAddPropPicker((prev) => !prev)}
              >
                + 속성 추가
              </button>
              {showAddPropPicker && (
                <div className="ndb-popover ndb-type-picker">
                  <input
                    type="text"
                    className="ndb-prop-name-input"
                    placeholder="새 속성 이름 (선택사항)…"
                    value={newPropName}
                    autoFocus
                    onChange={(e) => setNewPropName(e.target.value)}
                  />
                  <div className="ndb-option-popover__caption">유형 선택</div>
                  <div className="ndb-type-picker__grid">
                    {PROPERTY_TYPE_META.map((item) => (
                      <button
                        key={item.type}
                        type="button"
                        className="ndb-type-picker__btn"
                        onClick={() => {
                          onAddProperty(newPropName.trim(), item.type);
                          setNewPropName("");
                          setShowAddPropPicker(false);
                        }}
                      >
                        <span className="ndb-prop-icon">{item.icon}</span>
                        <span>{item.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {row.text && (
            <div className="ndb-peek__legacy-note">
              <div className="ndb-option-popover__caption">기존 메모</div>
              <CollectionRichText value={row.text} onChange={onChangeText} ariaLabel="메모" />
            </div>
          )}

          <div className="ndb-peek__body">
            <CollectionRowBody
              key={row.id}
              rowId={row.id}
              doc={session?.doc ?? null}
              provider={session?.provider ?? null}
            />
          </div>
        </div>
      </aside>
    </div>,
    document.body,
  );
}

type OpenMenuState =
  | { kind: "view"; id: string }
  | { kind: "add-view" }
  | { kind: "group" }
  | { kind: "source" }
  | { kind: "template" }
  | { kind: "prop"; id: string }
  | { kind: "add-prop" }
  | null;

/* ==========================================================================
 * 5. Main Notion Database Block Component
 * ========================================================================== */
function CollectionBlockComponent({
  blockId,
  dataJson,
  onChangeDataJson,
}: {
  blockId: string;
  dataJson: string;
  onChangeDataJson: (nextJson: string) => void;
}) {
  const {
    parentPageId,
    onOpenOrCreateRowPage,
    collaborationDoc,
    collaborationProvider,
    onCollectionDataChange,
  } = useContext(CollectionActionsContext);

  const rootRef = useRef<HTMLDivElement>(null);
  const titleInputsRef = useRef<Map<string, HTMLInputElement>>(new Map());
  const pendingFocusRowIdRef = useRef<string | null>(null);

  const legacyData = useMemo(() => parseCollectionData(dataJson), [dataJson]);
  const pendingLink = useMemo(() => {
    try {
      return JSON.parse(dataJson).pendingLink === true;
    } catch {
      return false;
    }
  }, [dataJson]);

  const collectionId = legacyData.collectionId || `collection-${blockId}`;
  const [collectionSession, setCollectionSession] = useState<{
    id: string;
    doc: Y.Doc;
    provider: HocuspocusProvider;
    initialData: CollectionData;
  } | null>(null);
  const [availableCollections, setAvailableCollections] = useState<
    Array<{ id: string; title: string; ownerPageTitle: string }>
  >([]);

  useEffect(() => {
    if (!pendingLink) return;
    void workspaceApi.listCollections().then((result) => setAvailableCollections(result.collections));
  }, [pendingLink]);

  useEffect(() => {
    if (!collaborationProvider || !parentPageId || pendingLink) return;
    let cancelled = false;
    let connecting = false;
    let session: typeof collectionSession = null;
    const connect = async () => {
      if (!collaborationProvider.synced || cancelled || connecting || session) return;
      connecting = true;
      const fromPage = collaborationDoc ? readCollectionMap(collectionMap(collaborationDoc, blockId)) : null;
      const initialData = migrateLegacyCollectionData({ ...(fromPage ?? legacyData), collectionId });
      try {
        const result = await workspaceApi.ensureCollection(collectionId, parentPageId, initialData);
        if (cancelled) return;
        if (!legacyData.collectionId) onChangeDataJson(JSON.stringify({ ...initialData, collectionId }));
        const doc = new Y.Doc();
        const auth = getStoredAuthSession();
        if (!auth) return;
        const provider = new HocuspocusProvider({
          url: resolveCollaborationWsUrl(auth.serverHost),
          name: `collection:${collectionId}`,
          document: doc,
          token: auth.token,
        });
        session = { id: collectionId, doc, provider, initialData: result.data };
        setCollectionSession(session);
      } catch (error) {
        console.error(`[collection:${collectionId}] failed to connect`, error);
      } finally {
        connecting = false;
      }
    };
    const onSynced = ({ state }: { state: boolean }) => {
      if (state) void connect();
    };
    collaborationProvider.on("synced", onSynced);
    if (collaborationProvider.synced) void connect();
    return () => {
      cancelled = true;
      collaborationProvider.off("synced", onSynced);
      session?.provider.destroy();
      session?.doc.destroy();
    };
  }, [collectionId, blockId, parentPageId, collaborationDoc, collaborationProvider, pendingLink]);

  const activeSession = collectionSession?.id === collectionId ? collectionSession : null;
  const sharedMap = useMemo(
    () => (activeSession ? collectionMap(activeSession.doc, activeSession.id) : null),
    [activeSession],
  );
  const [sharedData, setSharedData] = useState<CollectionData | null>(null);

  useEffect(() => {
    setSharedData(null);
    if (!sharedMap || !activeSession) return;
    let active = true;
    const refresh = () => {
      if (active) setSharedData(readCollectionMap(sharedMap));
    };
    const handleSynced = ({ state }: { state: boolean }) => {
      if (!state) return;
      const previousSchemaVersion = sharedMap.get("schemaVersion");
      initializeCollectionMap(sharedMap, latestDataRef.current ?? activeSession.initialData);
      refresh();
      if (previousSchemaVersion !== 2 && sharedMap.get("schemaVersion") === 2) {
        onCollectionDataChange?.();
      }
    };
    sharedMap.observeDeep(refresh);
    activeSession.provider.on("synced", handleSynced);
    if (activeSession.provider.synced) handleSynced({ state: true });
    return () => {
      active = false;
      sharedMap.unobserveDeep(refresh);
      activeSession.provider.off("synced", handleSynced);
    };
  }, [sharedMap, activeSession]);

  const data = sharedMap ? sharedData ?? activeSession!.initialData : legacyData;

  // Focus newly added row title input automatically
  useEffect(() => {
    if (!pendingFocusRowIdRef.current) return;
    const targetId = pendingFocusRowIdRef.current;
    const input = titleInputsRef.current.get(targetId);
    if (input) {
      input.focus();
      pendingFocusRowIdRef.current = null;
    }
  }, [data.rows]);

  // Sync related collections over Yjs
  const relatedIds = Array.from(
    new Set(
      data.properties
        .filter((p) => p.type === "relation" && p.relationCollectionId && p.relationCollectionId !== collectionId)
        .map((p) => p.relationCollectionId!),
    ),
  );
  const relatedKey = relatedIds.join("\u0000");
  const [relatedCollections, setRelatedCollections] = useState<Record<string, CollectionData>>({});

  useEffect(() => {
    if (!relatedKey) return;
    let active = true;
    const sessions: Array<{ doc: Y.Doc; provider: HocuspocusProvider }> = [];
    const auth = getStoredAuthSession();
    for (const id of relatedKey.split("\u0000")) {
      void workspaceApi
        .getCollection(id)
        .then(({ data: snapshot }) => {
          if (active) setRelatedCollections((current) => ({ ...current, [id]: snapshot }));
        })
        .catch(() => undefined);
      if (!auth || !collaborationProvider) continue;
      const doc = new Y.Doc();
      const map = collectionMap(doc, id);
      const refresh = () => {
        const latest = readCollectionMap(map);
        if (active && latest) setRelatedCollections((current) => ({ ...current, [id]: latest }));
      };
      const provider = new HocuspocusProvider({
        url: resolveCollaborationWsUrl(auth.serverHost),
        name: `collection:${id}`,
        document: doc,
        token: auth.token,
      });
      map.observeDeep(refresh);
      provider.on("synced", refresh);
      if (provider.synced) refresh();
      sessions.push({ doc, provider });
    }
    return () => {
      active = false;
      for (const { doc, provider } of sessions) {
        provider.destroy();
        doc.destroy();
      }
    };
  }, [relatedKey, collaborationProvider]);

  const cellValue = (row: CollectionRow, property: CollectionProperty) =>
    computePropertyValue(data, row, property, relatedCollections);
  const relationTarget = (property: CollectionProperty) =>
    property.relationCollectionId === collectionId ? data : relatedCollections[property.relationCollectionId ?? ""];
  const rollupTarget = (property: CollectionProperty) => {
    const relation = data.properties.find((item) => item.id === property.rollupRelationId && item.type === "relation");
    return relation ? relationTarget(relation) : undefined;
  };

  // Unified Menu / Popover State with outside-click and Escape handler
  const [openMenu, setOpenMenu] = useState<OpenMenuState>(null);
  const [newPropNameInput, setNewPropNameInput] = useState("");
  const [newPropOptionInput, setNewPropOptionInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const [draggingRowId, setDraggingRowId] = useState<string | null>(null);
  const [dragOverRowId, setDragOverRowId] = useState<string | null>(null);
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);
  const [dragOverDate, setDragOverDate] = useState<string | null>(null);
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const today = new Date();
    return new Date(today.getFullYear(), today.getMonth(), 1);
  });
  const [newTemplateName, setNewTemplateName] = useState("");
  const [showFilterBar, setShowFilterBar] = useState(false);
  const [showSortBar, setShowSortBar] = useState(false);
  const [focusedNumberCell, setFocusedNumberCell] = useState<string | null>(null);

  useEffect(() => {
    if (!openMenu) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest(".ndb-popover") || target.closest("[data-ndb-menu-trigger]")) return;
      setOpenMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenu(null);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openMenu]);

  useEffect(() => {
    if (openMenu?.kind !== "add-prop" && openMenu?.kind !== "prop" && openMenu?.kind !== "source") return;
    void workspaceApi
      .listCollections()
      .then((result) => setAvailableCollections(result.collections))
      .catch(() => undefined);
  }, [openMenu]);

  const [selectedViewId, setSelectedViewId] = useState<string>(
    () => window.localStorage.getItem(`noty:collection-view:${blockId}`) || "",
  );
  useEffect(() => {
    setSelectedViewId(window.localStorage.getItem(`noty:collection-view:${blockId}`) || "");
  }, [blockId]);

  const latestDataRef = useRef(data);
  latestDataRef.current = data;
  const [resizingKey, setResizingKey] = useState<string | null>(null);

  const updateData = (
    updater: (prev: CollectionData) => CollectionData,
    options?: { skipSnapshotSave?: boolean },
  ) => {
    if (sharedMap) {
      const current = readCollectionMap(sharedMap);
      if (!current) return;
      patchCollectionMap(sharedMap, current, updater(current));
      if (!options?.skipSnapshotSave) {
        onCollectionDataChange?.();
      }
    } else {
      const next = updater(latestDataRef.current);
      latestDataRef.current = next;
      onChangeDataJson(JSON.stringify(next));
    }
  };

  const activeView =
    data.views.find((view) => view.id === selectedViewId) ??
    data.views.find((view) => view.id === data.activeViewId) ??
    data.views[0];
  const visibleProperties = data.properties.filter((property) => !activeView.hiddenPropertyIds?.includes(property.id));

  const selectView = (viewId: string) => {
    setSelectedViewId(viewId);
    window.localStorage.setItem(`noty:collection-view:${blockId}`, viewId);
  };

  const updateActiveView = (patch: Partial<CollectionView>, options?: { skipSnapshotSave?: boolean }) => {
    updateData(
      (prev) => ({
        ...prev,
        views: prev.views.map((view) => (view.id === activeView.id ? { ...view, ...patch } : view)),
      }),
      options,
    );
  };

  const handleAddView = (mode: CollectionViewMode) => {
    const id = createViewId();
    const viewLabel = VIEW_MODE_META.find((v) => v.mode === mode)?.label ?? "표";
    const nextView: CollectionView = {
      id,
      name: viewLabel,
      mode,
      statusFilter: "all",
      tagFilter: "all",
      sortBy: "manual",
      sortDirection: "asc",
      hideCompleted: false,
      groupBy:
        mode === "board"
          ? data.properties.find((property) => property.type === "status" || property.type === "select")?.id ?? ""
          : "",
      datePropertyId:
        mode === "calendar" ? data.properties.find((property) => property.type === "date")?.id ?? "" : "",
    };
    updateData((prev) => ({
      ...prev,
      views: [...prev.views, nextView],
    }));
    selectView(id);
    setOpenMenu(null);
  };

  const handleUpdateView = (viewId: string, patch: Partial<CollectionView>) => {
    updateData((prev) => ({
      ...prev,
      views: prev.views.map((item) => (item.id === viewId ? { ...item, ...patch } : item)),
    }));
  };

  const handleDuplicateView = (view: CollectionView) => {
    const id = createViewId();
    const copy: CollectionView = { ...view, id, name: `${view.name} 사본` };
    updateData((prev) => ({ ...prev, views: [...prev.views, copy] }));
    selectView(id);
    setOpenMenu(null);
  };

  const handleDeleteView = (viewId: string) => {
    if (data.views.length <= 1) return;
    if (activeView.id === viewId) {
      selectView(data.views.find((view) => view.id !== viewId)?.id ?? "");
    }
    updateData((prev) => {
      const views = prev.views.filter((view) => view.id !== viewId);
      return {
        ...prev,
        views,
        activeViewId: prev.activeViewId === viewId ? views[0].id : prev.activeViewId,
      };
    });
  };

  const handleUpdateRow = (rowId: string, patch: Partial<CollectionRow>) => {
    updateData((prev) => ({
      ...prev,
      rows: prev.rows.map((r) => (r.id === rowId ? { ...r, ...patch } : r)),
    }));
  };

  const handleUpdateRowText = (row: CollectionRow, field: "title" | "text", value: string) => {
    if (sharedMap && sharedData) {
      editCollectionRowText(sharedMap, row.id, field, row[field] ?? "", value);
      onCollectionDataChange?.();
    } else {
      handleUpdateRow(row.id, { [field]: value });
    }
  };

  const handleUpdateCellText = (row: CollectionRow, propertyId: string, value: string) => {
    if (sharedMap && sharedData) {
      editCollectionCellText(sharedMap, row.id, propertyId, String(row.values?.[propertyId] ?? ""), value);
      onCollectionDataChange?.();
    } else {
      handleUpdateValue(row, propertyId, value);
    }
  };

  const handleCreateProperty = (customName: string, type: CollectionPropertyType): string => {
    const typeLabel = PROPERTY_TYPE_META.find((t) => t.type === type)?.label ?? "속성";
    let name = customName.trim();
    if (!name) {
      const existingNames = new Set(data.properties.map((p) => p.name));
      name = typeLabel;
      let suffix = 2;
      while (existingNames.has(name)) {
        name = `${typeLabel} ${suffix++}`;
      }
    }
    const id = createPropertyId();
    updateData((prev) => ({
      ...prev,
      properties: [
        ...prev.properties,
        {
          id,
          name,
          type,
          options: type === "status" ? ["시작 전", "진행 중", "완료"] : [],
          ...(type === "status"
            ? { optionColors: { "시작 전": "gray", "진행 중": "blue", "완료": "green" } }
            : {}),
          ...(type === "relation" ? { relationCollectionId: collectionId } : {}),
          ...(type === "rollup"
            ? {
                rollupRelationId: prev.properties.find((p) => p.type === "relation")?.id ?? "",
                rollupFunction: "count" as const,
              }
            : {}),
        },
      ],
    }));
    setNewPropNameInput("");
    setOpenMenu({ kind: "prop", id });
    return id;
  };

  const handleUpdateProperty = (
    id: string,
    patch: Partial<CollectionProperty>,
    options?: { skipSnapshotSave?: boolean },
  ) => {
    updateData(
      (prev) => ({
        ...prev,
        properties: prev.properties.map((property) => (property.id === id ? { ...property, ...patch } : property)),
      }),
      options,
    );
  };

  const handleUpdateValue = (row: CollectionRow, propertyId: string, value: string | boolean) => {
    updateData((prev) => ({
      ...prev,
      rows: prev.rows.map((current) =>
        current.id === row.id ? { ...current, values: { ...current.values, [propertyId]: value } } : current,
      ),
    }));
  };

  const handleAddRow = (
    initialValues: Record<string, string | boolean> = {},
    options?: { title?: string; icon?: string; openAfterCreate?: boolean; afterRowId?: string },
  ) => {
    const newRow: CollectionRow = {
      id: createRowId(),
      title: options?.title ?? "",
      ...(options?.icon ? { icon: options.icon } : {}),
      values: { ...initialValues },
    };
    pendingFocusRowIdRef.current = newRow.id;
    updateData((prev) => {
      if (options?.afterRowId) {
        const idx = prev.rows.findIndex((r) => r.id === options.afterRowId);
        if (idx >= 0) {
          const nextRows = [...prev.rows];
          nextRows.splice(idx + 1, 0, newRow);
          return { ...prev, rows: nextRows };
        }
      }
      return {
        ...prev,
        rows: [...prev.rows, newRow],
      };
    });
    if (options?.openAfterCreate) {
      setActiveRowId(newRow.id);
    }
  };

  const handleCreateTemplate = () => {
    const name = newTemplateName.trim() || "새 템플릿";
    const nextTemplate: CollectionTemplate = {
      id: `tpl-${Math.random().toString(36).slice(2, 9)}`,
      name,
      icon: "📄",
      defaultTitle: name,
      values: {},
    };
    updateData((prev) => ({
      ...prev,
      templates: [...(prev.templates ?? []), nextTemplate],
    }));
    setNewTemplateName("");
  };

  const handleDeleteTemplate = (templateId: string) => {
    updateData((prev) => ({
      ...prev,
      templates: (prev.templates ?? []).filter((t) => t.id !== templateId),
    }));
  };

  const handleDeleteRow = (rowId: string) => {
    if (activeRowId === rowId) setActiveRowId(null);
    updateData((prev) => ({
      ...prev,
      rows: prev.rows.filter((r) => r.id !== rowId),
    }));
  };

  const handleDuplicateRow = (row: CollectionRow) => {
    const duplicate: CollectionRow = {
      ...row,
      id: createRowId(),
      title: row.title ? `${row.title} 사본` : "",
      linkedPageId: undefined,
    };
    updateData((prev) => {
      const sourceIndex = prev.rows.findIndex((item) => item.id === row.id);
      const rows = [...prev.rows];
      rows.splice(sourceIndex < 0 ? rows.length : sourceIndex + 1, 0, duplicate);
      return { ...prev, rows };
    });
  };

  const handleMoveRow = (rowId: string, beforeRowId: string) => {
    if (rowId === beforeRowId) return;
    updateData((prev) => {
      const rows = [...prev.rows];
      const from = rows.findIndex((row) => row.id === rowId);
      const target = rows.findIndex((row) => row.id === beforeRowId);
      if (from < 0 || target < 0) return prev;
      const [row] = rows.splice(from, 1);
      rows.splice(rows.findIndex((item) => item.id === beforeRowId), 0, row);
      return { ...prev, rows };
    });
  };

  const handleOpenRowNote = async (row: CollectionRow, openInSplit = false) => {
    if (!parentPageId) return;
    await onOpenOrCreateRowPage(
      parentPageId,
      row.title.trim() || "제목 없음",
      row.linkedPageId,
      openInSplit,
      (createdId) => handleUpdateRow(row.id, { linkedPageId: createdId }),
    );
  };

  const openRow = (row: CollectionRow, event?: React.MouseEvent) => {
    if (event?.altKey) {
      void handleOpenRowNote(row, true);
      return;
    }
    setActiveRowId(row.id);
  };

  const beginHorizontalResize = (
    key: string,
    startWidth: number,
    minWidth: number,
    maxWidth: number,
    event: React.MouseEvent,
    onApply: (nextWidth: number, options?: { skipSnapshotSave?: boolean }) => void,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    let latestWidth = startWidth;
    setResizingKey(key);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMouseMove = (moveEvent: MouseEvent) => {
      latestWidth = Math.round(Math.max(minWidth, Math.min(maxWidth, startWidth + (moveEvent.clientX - startX))));
      onApply(latestWidth, { skipSnapshotSave: true });
    };
    const onMouseUp = () => {
      setResizingKey(null);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      onApply(latestWidth);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  const startResizeTitleColumn = (event: React.MouseEvent) => {
    const thRect = (event.currentTarget as HTMLElement).parentElement?.getBoundingClientRect();
    const startWidth = activeView.titleWidth ?? (thRect ? Math.round(thRect.width) : 260);
    beginHorizontalResize("title", startWidth, 100, 720, event, (nextWidth, options) => {
      updateActiveView({ titleWidth: nextWidth }, options);
    });
  };

  const startResizeColumn = (property: CollectionProperty, event: React.MouseEvent) => {
    const thRect = (event.currentTarget as HTMLElement).parentElement?.getBoundingClientRect();
    const startWidth = property.width ?? (thRect ? Math.round(thRect.width) : 170);
    beginHorizontalResize(property.id, startWidth, 80, 720, event, (nextWidth, options) => {
      handleUpdateProperty(property.id, { width: nextWidth }, options);
    });
  };

  const startResizeViewMetric = (
    key: string,
    field: "boardColumnWidth" | "galleryCardWidth",
    startWidth: number,
    minWidth: number,
    maxWidth: number,
    event: React.MouseEvent,
  ) => {
    beginHorizontalResize(key, startWidth, minWidth, maxWidth, event, (nextWidth, options) => {
      updateActiveView({ [field]: nextWidth }, options);
    });
  };

  const activeSorts: CollectionSortRule[] = useMemo(() => {
    if (activeView.sorts && activeView.sorts.length > 0) return activeView.sorts;
    if (activeView.sortBy && activeView.sortBy !== "manual") {
      return [{ propertyId: activeView.sortBy, direction: activeView.sortDirection }];
    }
    return [];
  }, [activeView.sorts, activeView.sortBy, activeView.sortDirection]);

  const setViewSorts = (nextSorts: CollectionSortRule[]) => {
    if (nextSorts.length === 0) {
      updateActiveView({ sorts: undefined, sortBy: "manual", sortDirection: "asc" });
    } else {
      updateActiveView({
        sorts: nextSorts,
        sortBy: nextSorts[0].propertyId,
        sortDirection: nextSorts[0].direction,
      });
    }
  };

  const filteredAndSortedRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = data.rows.filter((row) => {
      if (activeView.propertyFilterId && activeView.propertyFilterValue) {
        const property = data.properties.find((item) => item.id === activeView.propertyFilterId);
        const value = property ? String(cellValue(row, property)) : "";
        if (!value.toLowerCase().includes(activeView.propertyFilterValue.toLowerCase())) return false;
      }
      if (activeView.filters?.length) {
        const matches = activeView.filters.map((filter) => {
          const property = data.properties.find((item) => item.id === filter.propertyId);
          const rawVal = filter.propertyId === "title" ? row.title : property ? cellValue(row, property) : "";
          const value = String(rawVal ?? "");
          if (filter.operator === "is_empty") return !value || rawVal === false;
          if (filter.operator === "is_not_empty") return Boolean(value) && rawVal !== false;
          if (filter.operator === "is_checked") return rawVal === true || value === "true";
          if (filter.operator === "is_not_checked") return rawVal !== true && value !== "true";
          if (filter.operator === "equals") return value.toLowerCase() === filter.value.toLowerCase();
          if (filter.operator === "not_equals") return value.toLowerCase() !== filter.value.toLowerCase();
          if (filter.operator === "not_contains") return !value.toLowerCase().includes(filter.value.toLowerCase());
          if (filter.operator === "gt") return Number(value) > Number(filter.value);
          if (filter.operator === "lt") return Number(value) < Number(filter.value);
          return value.toLowerCase().includes(filter.value.toLowerCase());
        });
        if (!(activeView.filterMode === "or" ? matches.some(Boolean) : matches.every(Boolean))) return false;
      }
      if (!q) return true;
      return (
        row.title.toLowerCase().includes(q) ||
        data.properties.some((property) => String(cellValue(row, property)).toLowerCase().includes(q))
      );
    });

    if (activeSorts.length === 0) return filtered;
    const copy = [...filtered];
    copy.sort((a, b) => {
      for (const rule of activeSorts) {
        let result = 0;
        if (rule.propertyId === "title") {
          result = (a.title || "").localeCompare(b.title || "", "ko");
        } else {
          const property = data.properties.find((item) => item.id === rule.propertyId);
          if (property) {
            const left = cellValue(a, property);
            const right = cellValue(b, property);
            if (property.type === "number" || typeof left === "number" || typeof right === "number") {
              result = Number(left || 0) - Number(right || 0);
            } else if (property.type === "checkbox") {
              result = Number(Boolean(left)) - Number(Boolean(right));
            } else {
              result = String(left ?? "").localeCompare(String(right ?? ""), "ko");
            }
          }
        }
        if (result !== 0) return rule.direction === "desc" ? -result : result;
      }
      return 0;
    });
    return copy;
  }, [data, relatedCollections, searchQuery, activeView, activeSorts]);

  const activeRowIndex = filteredAndSortedRows.findIndex((r) => r.id === activeRowId);
  const activeRow = data.rows.find((row) => row.id === activeRowId);

  const groupProperty = data.properties.find((property) => property.id === activeView.groupBy);
  const groupedRowBuckets = useMemo(() => {
    if (!groupProperty) return null;
    const buckets = new Map<string, CollectionRow[]>();
    if (groupProperty.type === "select" || groupProperty.type === "status") {
      for (const opt of groupProperty.options ?? []) buckets.set(opt, []);
      buckets.set("", []);
    }
    for (const row of filteredAndSortedRows) {
      const key = String(cellValue(row, groupProperty) ?? "");
      const list = buckets.get(key) ?? [];
      list.push(row);
      buckets.set(key, list);
    }
    return Array.from(buckets.entries());
  }, [groupProperty, filteredAndSortedRows, data, relatedCollections]);

  const toggleCollapseGroup = (groupKey: string) => {
    const current = activeView.collapsedGroups ?? [];
    const next = current.includes(groupKey) ? current.filter((g) => g !== groupKey) : [...current, groupKey];
    updateActiveView({ collapsedGroups: next });
  };

  const boardProperty = data.properties.find(
    (property) => property.id === activeView.groupBy && (property.type === "select" || property.type === "status"),
  );
  const boardGroups = boardProperty ? [...(boardProperty.options ?? []), ""] : [];

  const dateProperty = data.properties.find(
    (property) => property.id === activeView.datePropertyId && property.type === "date",
  );

  const calendarCells = useMemo(() => {
    const year = calendarMonth.getFullYear();
    const month = calendarMonth.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const days = new Date(year, month + 1, 0).getDate();
    return Array.from({ length: Math.ceil((firstDay + days) / 7) * 7 }, (_, index) => {
      const day = index - firstDay + 1;
      return day > 0 && day <= days
        ? `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`
        : "";
    });
  }, [calendarMonth]);

  const todayIso = useMemo(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }, []);

  const linkCollection = (id: string) => {
    const target = availableCollections.find((item) => item.id === id);
    if (!target) return;
    onChangeDataJson(JSON.stringify({ ...createDefaultCollectionData(target.title), collectionId: target.id }));
    setOpenMenu(null);
  };

  const renderTableCell = (row: CollectionRow, property: CollectionProperty) => {
    const rawValue = row.values?.[property.id];
    if (property.type === "checkbox") {
      return (
        <div className="ndb-cell-checkbox">
          <input
            type="checkbox"
            className="ndb-checkbox"
            checked={rawValue === true}
            onChange={(event) => handleUpdateValue(row, property.id, event.target.checked)}
            aria-label={`${row.title || "새 항목"} ${property.name}`}
          />
        </div>
      );
    }
    if (property.type === "select" || property.type === "status" || property.type === "multi_select") {
      return (
        <NotionOptionCell
          property={property}
          value={String(rawValue ?? "")}
          onChangeValue={(next) => handleUpdateValue(row, property.id, next)}
          onUpdateProperty={(patch) => handleUpdateProperty(property.id, patch)}
          ariaLabel={`${row.title || "새 항목"} ${property.name}`}
        />
      );
    }
    if (property.type === "relation") {
      return (
        <NotionRelationCell
          property={property}
          value={String(rawValue ?? "")}
          targetCollection={relationTarget(property)}
          onChangeValue={(next) => handleUpdateValue(row, property.id, next)}
          ariaLabel={`${row.title || "새 항목"} ${property.name}`}
        />
      );
    }
    if (property.type === "rollup" || property.type === "formula") {
      return (
        <span className="ndb-computed-val" aria-label={`${row.title || "새 항목"} ${property.name}`}>
          {String(cellValue(row, property))}
        </span>
      );
    }
    if (property.type === "text") {
      return (
        <CollectionRichText
          value={String(rawValue ?? "")}
          onChange={(value) => handleUpdateCellText(row, property.id, value)}
          ariaLabel={`${row.title || "새 항목"} ${property.name}`}
        />
      );
    }
    if (property.type === "number") {
      const cellKey = `${row.id}:${property.id}`;
      const isFocused = focusedNumberCell === cellKey;
      const displayVal = isFocused
        ? String(rawValue ?? "")
        : formatNumberDisplay(rawValue, property.numberFormat);
      return (
        <input
          className="ndb-cell-input ndb-cell-input--number"
          type={isFocused ? "number" : "text"}
          value={displayVal}
          placeholder="비어 있음"
          onFocus={() => setFocusedNumberCell(cellKey)}
          onBlur={() => setFocusedNumberCell(null)}
          onChange={(event) => handleUpdateValue(row, property.id, event.target.value)}
          aria-label={`${row.title || "새 항목"} ${property.name}`}
        />
      );
    }
    if (property.type === "url" || property.type === "email" || property.type === "phone") {
      const strVal = String(rawValue ?? "");
      const href =
        property.type === "email"
          ? `mailto:${strVal}`
          : property.type === "phone"
            ? `tel:${strVal}`
            : strVal.startsWith("http")
              ? strVal
              : `https://${strVal}`;
      return (
        <div className="ndb-cell-link-wrap">
          <input
            className="ndb-cell-input"
            type={property.type === "url" ? "url" : property.type === "email" ? "email" : "tel"}
            value={strVal}
            placeholder={property.type === "url" ? "https://…" : "비어 있음"}
            onChange={(event) => handleUpdateValue(row, property.id, event.target.value)}
            aria-label={`${row.title || "새 항목"} ${property.name}`}
          />
          {strVal && (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="ndb-cell-link-action"
              title="열기"
              onClick={(e) => e.stopPropagation()}
            >
              ↗
            </a>
          )}
        </div>
      );
    }
    return (
      <input
        className="ndb-cell-input"
        type={property.type === "date" ? "date" : "text"}
        value={String(rawValue ?? "")}
        placeholder="비어 있음"
        onChange={(event) => handleUpdateValue(row, property.id, event.target.value)}
        aria-label={`${row.title || "새 항목"} ${property.name}`}
      />
    );
  };

  const renderTableRow = (row: CollectionRow) => (
    <tr
      key={row.id}
      className={`ndb-tr ${dragOverRowId === row.id ? "ndb-tr--drag-over" : ""}`}
      onDragOver={(event) => {
        if (!draggingRowId || activeSorts.length > 0) return;
        event.preventDefault();
        setDragOverRowId(row.id);
      }}
      onDragLeave={() => setDragOverRowId(null)}
      onDrop={(event) => {
        event.preventDefault();
        if (draggingRowId && activeSorts.length === 0) {
          handleMoveRow(draggingRowId, row.id);
        }
        setDraggingRowId(null);
        setDragOverRowId(null);
      }}
    >
      <td className="ndb-td ndb-td--gutter">
        <div className="ndb-row-gutter">
          <span
            className="ndb-drag-handle"
            draggable={activeSorts.length === 0}
            title={activeSorts.length === 0 ? "드래그하여 이동" : "정렬 해제 후 이동 가능"}
            aria-label="행 순서 변경"
            onDragStart={(event) => {
              setDraggingRowId(row.id);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", row.id);
            }}
            onDragEnd={() => {
              setDraggingRowId(null);
              setDragOverRowId(null);
            }}
          >
            ⋮⋮
          </span>
        </div>
      </td>
      <td
        className="ndb-td ndb-td--title"
        style={{ width: `${activeView.titleWidth ?? 260}px` }}
      >
        <div className="ndb-title-cell">
          {row.icon && (
            <span className="ndb-row-icon" onClick={(event) => openRow(row, event)}>
              {row.icon}
            </span>
          )}
          <input
            ref={(el) => {
              if (el) titleInputsRef.current.set(row.id, el);
              else titleInputsRef.current.delete(row.id);
            }}
            type="text"
            className="ndb-cell-input ndb-cell-input--title"
            value={row.title}
            placeholder="항목 이름 입력…"
            onChange={(event) => handleUpdateRowText(row, "title", event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                handleAddRow({}, { afterRowId: row.id });
              } else if (event.key === "ArrowDown") {
                const idx = filteredAndSortedRows.findIndex((r) => r.id === row.id);
                const nextRow = filteredAndSortedRows[idx + 1];
                if (nextRow) {
                  event.preventDefault();
                  titleInputsRef.current.get(nextRow.id)?.focus();
                }
              } else if (event.key === "ArrowUp") {
                const idx = filteredAndSortedRows.findIndex((r) => r.id === row.id);
                const prevRow = filteredAndSortedRows[idx - 1];
                if (prevRow) {
                  event.preventDefault();
                  titleInputsRef.current.get(prevRow.id)?.focus();
                }
              }
            }}
          />
          <div className="ndb-title-cell__actions">
            <button
              type="button"
              className="ndb-open-btn"
              onClick={(event) => openRow(row, event)}
              title="상세 보기 열기 (⌥+클릭 시 분할 창)"
            >
              ◧ 열기
            </button>
            <button
              type="button"
              className="ndb-row-action-icon"
              onClick={() => handleDuplicateRow(row)}
              title="항목 복제"
              aria-label="항목 복제"
            >
              ⧉
            </button>
            <button
              type="button"
              className="ndb-row-action-icon ndb-row-action-icon--danger"
              onClick={() => handleDeleteRow(row.id)}
              title="항목 삭제"
              aria-label="항목 삭제"
            >
              ×
            </button>
          </div>
        </div>
        <span
          className={`ndb-col-resizer ${resizingKey === "title" ? "ndb-col-resizer--active" : ""}`}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={startResizeTitleColumn}
          onDoubleClick={(e) => {
            e.stopPropagation();
            updateActiveView({ titleWidth: undefined });
          }}
          title="드래그하여 항목 열 가로 너비 조절 · 더블클릭 시 초기화"
        />
      </td>
      {visibleProperties.map((property) => (
        <td
          key={property.id}
          className="ndb-td"
          style={{ width: `${property.width ?? 170}px` }}
        >
          {renderTableCell(row, property)}
          <span
            className={`ndb-col-resizer ${resizingKey === property.id ? "ndb-col-resizer--active" : ""}`}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(event) => startResizeColumn(property, event)}
            onDoubleClick={(e) => {
              e.stopPropagation();
              handleUpdateProperty(property.id, { width: undefined });
            }}
            title="드래그하여 열 가로 너비 조절 · 더블클릭 시 초기화"
          />
        </td>
      ))}
      <td className="ndb-td ndb-td--end" />
    </tr>
  );

  if (pendingLink) {
    return (
      <div className="ndb-pending-source" contentEditable={false}>
        <div className="ndb-pending-source__head">
          <span>🔗 연결할 데이터베이스 선택</span>
          <button
            type="button"
            className="ndb-topbar-btn"
            onClick={() => onChangeDataJson(JSON.stringify(createDefaultCollectionData("컬렉션")))}
          >
            + 새 데이터베이스 만들기
          </button>
        </div>
        <select
          aria-label="연결할 데이터베이스"
          value=""
          onChange={(event) => linkCollection(event.target.value)}
        >
          <option value="">데이터베이스 선택…</option>
          {availableCollections.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title} · {item.ownerPageTitle}
            </option>
          ))}
        </select>
      </div>
    );
  }

  return (
    <div className="ndb" ref={rootRef} contentEditable={false}>
      {/* 1. Database Title Row */}
      {activeView.showTitle !== false && (
        <div className="ndb-title-row">
          <input
            type="text"
            className="ndb-db-title"
            value={data.title}
            placeholder="제목 없는 데이터베이스"
            onChange={(event) => updateData((prev) => ({ ...prev, title: event.target.value }))}
          />
        </div>
      )}

      {/* 2. Top View Bar (Tabs on left, Actions on right) */}
      <div className="ndb-topbar">
        <div className="ndb-views">
          {data.views.map((view) => {
            const isActive = view.id === activeView.id;
            const isMenuOpen = openMenu?.kind === "view" && openMenu.id === view.id;
            const modeMeta = VIEW_MODE_META.find((m) => m.mode === view.mode) ?? VIEW_MODE_META[0];
            return (
              <div key={view.id} className={`ndb-view-tab-wrap ${isActive ? "ndb-view-tab-wrap--active" : ""}`}>
                <button
                  type="button"
                  data-ndb-menu-trigger
                  className={`ndb-view-tab ${isActive ? "ndb-view-tab--active" : ""}`}
                  onClick={() => {
                    if (isActive) {
                      setOpenMenu(isMenuOpen ? null : { kind: "view", id: view.id });
                    } else {
                      selectView(view.id);
                      setOpenMenu(null);
                    }
                  }}
                >
                  <span className="ndb-view-tab__icon">{modeMeta.icon}</span>
                  <span>{view.name}</span>
                </button>
                {isActive && (
                  <button
                    type="button"
                    data-ndb-menu-trigger
                    className="ndb-view-tab__more"
                    onClick={() => setOpenMenu(isMenuOpen ? null : { kind: "view", id: view.id })}
                    aria-label="뷰 설정"
                    title="뷰 설정"
                  >
                    ···
                  </button>
                )}

                {isMenuOpen && (
                  <div className="ndb-popover ndb-view-popover" onClick={(e) => e.stopPropagation()}>
                    <div className="ndb-popover-section">
                      <label className="ndb-field-label">
                        뷰 이름
                        <input
                          type="text"
                          value={view.name}
                          onChange={(e) => handleUpdateView(view.id, { name: e.target.value })}
                        />
                      </label>
                      <label className="ndb-field-label">
                        레이아웃
                        <div className="ndb-layout-grid">
                          {VIEW_MODE_META.map((m) => (
                            <button
                              key={m.mode}
                              type="button"
                              className={`ndb-layout-choice ${view.mode === m.mode ? "ndb-layout-choice--active" : ""}`}
                              onClick={() => handleUpdateView(view.id, { mode: m.mode })}
                            >
                              <span>{m.icon}</span>
                              <span>{m.label}</span>
                            </button>
                          ))}
                        </div>
                      </label>
                      <label className="ndb-field-label">
                        항목 열기 방식
                        <select
                          value={view.peekMode ?? "side"}
                          onChange={(e) => handleUpdateView(view.id, { peekMode: e.target.value as "side" | "center" })}
                        >
                          <option value="side">◧ 우측 사이드 피크</option>
                          <option value="center">▣ 중앙 모달</option>
                        </select>
                      </label>
                      {(view.mode === "board" || view.mode === "table" || view.mode === "list") && (
                        <label className="ndb-field-label">
                          그룹화 속성
                          <select
                            value={view.groupBy ?? ""}
                            onChange={(e) => handleUpdateView(view.id, { groupBy: e.target.value })}
                          >
                            <option value="">그룹화 없음</option>
                            {data.properties
                              .filter((p) =>
                                view.mode === "board"
                                  ? p.type === "status" || p.type === "select"
                                  : ["status", "select", "checkbox", "text"].includes(p.type),
                              )
                              .map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.name}
                                </option>
                              ))}
                          </select>
                        </label>
                      )}
                      {view.mode === "calendar" && (
                        <label className="ndb-field-label">
                          날짜 속성
                          <select
                            value={view.datePropertyId ?? ""}
                            onChange={(e) => handleUpdateView(view.id, { datePropertyId: e.target.value })}
                          >
                            <option value="">선택하세요</option>
                            {data.properties
                              .filter((p) => p.type === "date")
                              .map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.name}
                                </option>
                              ))}
                          </select>
                        </label>
                      )}
                      {(view.mode === "table" || view.mode === "list") && (
                        <div className="ndb-field-label">
                          <div className="ndb-width-control__head">
                            <span>항목(이름) 가로 너비</span>
                            <span className="ndb-width-control__val">
                              {view.titleWidth ?? 260}px
                              {view.titleWidth !== undefined && (
                                <button
                                  type="button"
                                  className="ndb-width-reset-btn"
                                  onClick={() => handleUpdateView(view.id, { titleWidth: undefined })}
                                >
                                  초기화
                                </button>
                              )}
                            </span>
                          </div>
                          <input
                            type="range"
                            className="ndb-width-slider"
                            min={100}
                            max={720}
                            step={4}
                            value={view.titleWidth ?? 260}
                            aria-label="항목 가로 너비"
                            onChange={(e) => handleUpdateView(view.id, { titleWidth: Number(e.target.value) })}
                          />
                        </div>
                      )}
                      {view.mode === "board" && (
                        <div className="ndb-field-label">
                          <div className="ndb-width-control__head">
                            <span>보드 열(카드) 가로 너비</span>
                            <span className="ndb-width-control__val">
                              {view.boardColumnWidth ?? 250}px
                              {view.boardColumnWidth !== undefined && (
                                <button
                                  type="button"
                                  className="ndb-width-reset-btn"
                                  onClick={() => handleUpdateView(view.id, { boardColumnWidth: undefined })}
                                >
                                  초기화
                                </button>
                              )}
                            </span>
                          </div>
                          <input
                            type="range"
                            className="ndb-width-slider"
                            min={180}
                            max={560}
                            step={4}
                            value={view.boardColumnWidth ?? 250}
                            aria-label="보드 열 가로 너비"
                            onChange={(e) => handleUpdateView(view.id, { boardColumnWidth: Number(e.target.value) })}
                          />
                        </div>
                      )}
                      {view.mode === "gallery" && (
                        <div className="ndb-field-label">
                          <div className="ndb-width-control__head">
                            <span>갤러리 카드 가로 너비</span>
                            <span className="ndb-width-control__val">
                              {view.galleryCardWidth ?? 220}px
                              {view.galleryCardWidth !== undefined && (
                                <button
                                  type="button"
                                  className="ndb-width-reset-btn"
                                  onClick={() => handleUpdateView(view.id, { galleryCardWidth: undefined })}
                                >
                                  초기화
                                </button>
                              )}
                            </span>
                          </div>
                          <input
                            type="range"
                            className="ndb-width-slider"
                            min={150}
                            max={560}
                            step={4}
                            value={view.galleryCardWidth ?? 220}
                            aria-label="갤러리 카드 가로 너비"
                            onChange={(e) => handleUpdateView(view.id, { galleryCardWidth: Number(e.target.value) })}
                          />
                        </div>
                      )}
                    </div>

                    {data.properties.length > 0 && (
                      <div className="ndb-popover-section">
                        <div className="ndb-option-popover__caption">표시할 속성</div>
                        <div className="ndb-prop-visibility-list">
                          {data.properties.map((property) => {
                            const visible = !view.hiddenPropertyIds?.includes(property.id);
                            return (
                              <label key={property.id} className="ndb-prop-visibility-item">
                                <span>
                                  <span className="ndb-prop-icon">{propertyIcon(property.type)}</span>
                                  {property.name}
                                </span>
                                <input
                                  type="checkbox"
                                  checked={visible}
                                  onChange={(e) =>
                                    handleUpdateView(view.id, {
                                      hiddenPropertyIds: e.target.checked
                                        ? (view.hiddenPropertyIds ?? []).filter((id) => id !== property.id)
                                        : [...(view.hiddenPropertyIds ?? []), property.id],
                                    })
                                  }
                                />
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    <div className="ndb-popover-footer">
                      <button type="button" className="ndb-menu-btn" onClick={() => handleDuplicateView(view)}>
                        ⧉ 뷰 복제
                      </button>
                      {data.views.length > 1 && (
                        <button
                          type="button"
                          className="ndb-menu-btn ndb-menu-btn--danger"
                          onClick={() => {
                            handleDeleteView(view.id);
                            setOpenMenu(null);
                          }}
                        >
                          🗑 뷰 삭제
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {/* + Add View Button */}
          <div className="ndb-add-view-wrap">
            <button
              type="button"
              data-ndb-menu-trigger
              className="ndb-add-view-btn"
              onClick={() => setOpenMenu(openMenu?.kind === "add-view" ? null : { kind: "add-view" })}
              title="새 뷰 추가"
              aria-label="새 뷰 추가"
            >
              +
            </button>
            {openMenu?.kind === "add-view" && (
              <div className="ndb-popover ndb-add-view-popover">
                <div className="ndb-option-popover__caption">뷰 레이아웃 추가</div>
                {VIEW_MODE_META.map((m) => (
                  <button
                    key={m.mode}
                    type="button"
                    className="ndb-menu-btn"
                    onClick={() => handleAddView(m.mode)}
                  >
                    <span className="ndb-prop-icon">{m.icon}</span>
                    <span>{m.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right Toolbar Actions */}
        <div className="ndb-actions">
          <button
            type="button"
            className={`ndb-topbar-btn ${(activeView.filters?.length ?? 0) > 0 || showFilterBar ? "ndb-topbar-btn--active" : ""}`}
            onClick={() => setShowFilterBar((prev) => !prev)}
          >
            필터 {(activeView.filters?.length ?? 0) > 0 ? `(${activeView.filters!.length})` : ""}
          </button>

          <button
            type="button"
            className={`ndb-topbar-btn ${activeSorts.length > 0 || showSortBar ? "ndb-topbar-btn--active" : ""}`}
            onClick={() => setShowSortBar((prev) => !prev)}
          >
            정렬 {activeSorts.length > 0 ? `(${activeSorts.length})` : ""}
          </button>

          {(activeView.mode === "table" || activeView.mode === "list" || activeView.mode === "board") &&
            data.properties.length > 0 && (
              <div className="ndb-action-pop-wrap">
                <button
                  type="button"
                  data-ndb-menu-trigger
                  className={`ndb-topbar-btn ${activeView.groupBy ? "ndb-topbar-btn--active" : ""}`}
                  onClick={() => setOpenMenu(openMenu?.kind === "group" ? null : { kind: "group" })}
                >
                  그룹
                </button>
                {openMenu?.kind === "group" && (
                  <div className="ndb-popover ndb-group-popover">
                    <div className="ndb-option-popover__caption">그룹화 기준 속성</div>
                    <button
                      type="button"
                      className={`ndb-menu-btn ${!activeView.groupBy ? "ndb-menu-btn--selected" : ""}`}
                      onClick={() => {
                        updateActiveView({ groupBy: "" });
                        setOpenMenu(null);
                      }}
                    >
                      없음
                    </button>
                    {data.properties
                      .filter((p) =>
                        activeView.mode === "board"
                          ? p.type === "status" || p.type === "select"
                          : ["status", "select", "checkbox", "text"].includes(p.type),
                      )
                      .map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          className={`ndb-menu-btn ${activeView.groupBy === p.id ? "ndb-menu-btn--selected" : ""}`}
                          onClick={() => {
                            updateActiveView({ groupBy: p.id });
                            setOpenMenu(null);
                          }}
                        >
                          <span className="ndb-prop-icon">{propertyIcon(p.type)}</span>
                          <span>{p.name}</span>
                        </button>
                      ))}
                  </div>
                )}
              </div>
            )}

          {searchOpen || searchQuery ? (
            <div className="ndb-search-box">
              <span>🔍</span>
              <input
                type="text"
                placeholder="검색…"
                value={searchQuery}
                autoFocus
                onChange={(e) => setSearchQuery(e.target.value)}
                onBlur={() => {
                  if (!searchQuery) setSearchOpen(false);
                }}
              />
              {searchQuery && (
                <button type="button" onClick={() => setSearchQuery("")} aria-label="검색어 지우기">
                  ×
                </button>
              )}
            </div>
          ) : (
            <button
              type="button"
              className="ndb-topbar-btn"
              onClick={() => setSearchOpen(true)}
              title="검색"
            >
              🔍
            </button>
          )}

          <div className="ndb-action-pop-wrap">
            <button
              type="button"
              data-ndb-menu-trigger
              className="ndb-topbar-btn"
              onClick={() => setOpenMenu(openMenu?.kind === "source" ? null : { kind: "source" })}
              title="다른 데이터베이스 연결"
            >
              🔗
            </button>
            {openMenu?.kind === "source" && (
              <div className="ndb-popover ndb-source-popover">
                <div className="ndb-option-popover__caption">데이터베이스 원본 연결</div>
                <select
                  aria-label="연결할 데이터베이스"
                  value={collectionId}
                  onChange={(e) => linkCollection(e.target.value)}
                >
                  <option value={collectionId}>{data.title} (현재)</option>
                  {availableCollections
                    .filter((item) => item.id !== collectionId)
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.title} · {item.ownerPageTitle}
                      </option>
                    ))}
                </select>
              </div>
            )}
          </div>

          {/* Notion Blue Split Button: 새로 만들기 | ▾ */}
          <div className="ndb-new-split">
            <button type="button" className="ndb-new-btn" onClick={() => handleAddRow()}>
              새로 만들기
            </button>
            <button
              type="button"
              data-ndb-menu-trigger
              className="ndb-new-caret"
              onClick={() => setOpenMenu(openMenu?.kind === "template" ? null : { kind: "template" })}
              aria-label="템플릿 메뉴"
            >
              ▾
            </button>
            {openMenu?.kind === "template" && (
              <div className="ndb-popover ndb-template-popover" onClick={(e) => e.stopPropagation()}>
                <div className="ndb-option-popover__caption">데이터베이스 템플릿</div>
                <button
                  type="button"
                  className="ndb-menu-btn"
                  onClick={() => {
                    handleAddRow({}, { openAfterCreate: true });
                    setOpenMenu(null);
                  }}
                >
                  📄 빈 항목 만들고 열기
                </button>
                {(data.templates ?? []).map((tpl) => (
                  <div key={tpl.id} className="ndb-template-row">
                    <button
                      type="button"
                      className="ndb-menu-btn"
                      onClick={() => {
                        handleAddRow(
                          { ...(tpl.values ?? {}) },
                          { title: tpl.defaultTitle ?? tpl.name, icon: tpl.icon, openAfterCreate: true },
                        );
                        setOpenMenu(null);
                      }}
                    >
                      <span>{tpl.icon || "📄"}</span>
                      <span>{tpl.name}</span>
                    </button>
                    <button
                      type="button"
                      className="ndb-row-action-icon ndb-row-action-icon--danger"
                      onClick={() => handleDeleteTemplate(tpl.id)}
                      aria-label={`${tpl.name} 삭제`}
                    >
                      ×
                    </button>
                  </div>
                ))}
                <div className="ndb-template-add">
                  <input
                    type="text"
                    placeholder="새 템플릿 이름…"
                    value={newTemplateName}
                    onChange={(e) => setNewTemplateName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleCreateTemplate();
                    }}
                  />
                  <button type="button" onClick={handleCreateTemplate}>
                    + 추가
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 3. Filter & Multi-Sort Pills Bar */}
      {(showFilterBar || showSortBar || (activeView.filters?.length ?? 0) > 0 || activeSorts.length > 0) && (
        <div className="ndb-pills-bar">
          {(showSortBar || activeSorts.length > 0) && (
            <div className="ndb-pills-group">
              {activeSorts.map((rule, idx) => (
                <div key={idx} className="ndb-rule-pill ndb-rule-pill--sort">
                  <span>↕</span>
                  <select
                    value={rule.propertyId}
                    onChange={(e) => {
                      const next = activeSorts.map((r, i) => (i === idx ? { ...r, propertyId: e.target.value } : r));
                      setViewSorts(next);
                    }}
                  >
                    <option value="title">이름</option>
                    {data.properties.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <select
                    value={rule.direction}
                    onChange={(e) => {
                      const next = activeSorts.map((r, i) =>
                        i === idx ? { ...r, direction: e.target.value as CollectionSortDirection } : r,
                      );
                      setViewSorts(next);
                    }}
                  >
                    <option value="asc">오름차순</option>
                    <option value="desc">내림차순</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => setViewSorts(activeSorts.filter((_, i) => i !== idx))}
                    aria-label="정렬 삭제"
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="ndb-add-rule-btn"
                onClick={() => setViewSorts([...activeSorts, { propertyId: "title", direction: "asc" }])}
              >
                + 정렬 추가
              </button>
            </div>
          )}

          {(showFilterBar || (activeView.filters?.length ?? 0) > 0) && (
            <div className="ndb-pills-group">
              {(activeView.filters?.length ?? 0) > 1 && (
                <button
                  type="button"
                  className="ndb-logic-toggle"
                  onClick={() => updateActiveView({ filterMode: activeView.filterMode === "or" ? "and" : "or" })}
                >
                  {activeView.filterMode === "or" ? "OR (하나 이상)" : "AND (모두 만족)"}
                </button>
              )}
              {(activeView.filters ?? []).map((filter, index) => (
                <div className="ndb-rule-pill" key={index}>
                  <select
                    value={filter.propertyId}
                    onChange={(e) =>
                      updateActiveView({
                        filters: (activeView.filters ?? []).map((item, idx) =>
                          idx === index ? { ...item, propertyId: e.target.value } : item,
                        ),
                      })
                    }
                  >
                    <option value="title">이름</option>
                    {data.properties.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <select
                    value={filter.operator}
                    onChange={(e) =>
                      updateActiveView({
                        filters: (activeView.filters ?? []).map((item, idx) =>
                          idx === index ? { ...item, operator: e.target.value as CollectionFilterOperator } : item,
                        ),
                      })
                    }
                  >
                    <option value="contains">포함</option>
                    <option value="not_contains">포함 안 함</option>
                    <option value="equals">일치</option>
                    <option value="not_equals">불일치</option>
                    <option value="gt">&gt;</option>
                    <option value="lt">&lt;</option>
                    <option value="is_empty">비어 있음</option>
                    <option value="is_not_empty">비어 있지 않음</option>
                    <option value="is_checked">체크됨</option>
                    <option value="is_not_checked">체크 안 됨</option>
                  </select>
                  {!filter.operator.startsWith("is_") && (
                    <input
                      type="text"
                      value={filter.value}
                      placeholder="값 입력…"
                      onChange={(e) =>
                        updateActiveView({
                          filters: (activeView.filters ?? []).map((item, idx) =>
                            idx === index ? { ...item, value: e.target.value } : item,
                          ),
                        })
                      }
                    />
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      updateActiveView({
                        filters: (activeView.filters ?? []).filter((_, idx) => idx !== index),
                      })
                    }
                    aria-label="필터 삭제"
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="ndb-add-rule-btn"
                onClick={() =>
                  updateActiveView({
                    filters: [...(activeView.filters ?? []), { propertyId: "title", operator: "contains", value: "" }],
                  })
                }
              >
                + 필터 추가
              </button>
            </div>
          )}
        </div>
      )}

      {/* 4. Views */}
      {activeView.mode === "table" ? (
        <div className="ndb-table-wrap">
          <table
            className="ndb-table"
            style={{
              minWidth: `${
                28 +
                (activeView.titleWidth ?? 260) +
                visibleProperties.reduce((sum, prop) => sum + (prop.width ?? 170), 0) +
                44
              }px`,
            }}
          >
            <colgroup>
              <col style={{ width: "28px" }} />
              <col style={{ width: `${activeView.titleWidth ?? 260}px` }} />
              {visibleProperties.map((property) => (
                <col key={property.id} style={{ width: `${property.width ?? 170}px` }} />
              ))}
              <col style={{ width: "auto", minWidth: "44px" }} />
            </colgroup>
            <thead>
              <tr>
                <th className="ndb-th ndb-th--gutter" aria-label="행 이동" />
                <th
                  className="ndb-th ndb-th--title"
                  style={activeView.titleWidth ? { width: `${activeView.titleWidth}px` } : undefined}
                >
                  <div className="ndb-th-inner">
                    <span className="ndb-prop-icon">Aa</span>
                    <span>이름</span>
                  </div>
                  <span
                    className={`ndb-col-resizer ${resizingKey === "title" ? "ndb-col-resizer--active" : ""}`}
                    onClick={(e) => e.stopPropagation()}
                    onMouseDown={startResizeTitleColumn}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      updateActiveView({ titleWidth: undefined });
                    }}
                    title="드래그하여 항목 열 가로 너비 조절 · 더블클릭 시 초기화"
                  />
                </th>
                {visibleProperties.map((property) => {
                  const propertyIndex = data.properties.findIndex((item) => item.id === property.id);
                  const isPropOpen = openMenu?.kind === "prop" && openMenu.id === property.id;
                  return (
                    <th
                      key={property.id}
                      className="ndb-th ndb-th--prop"
                      style={property.width ? { width: `${property.width}px` } : undefined}
                    >
                      <button
                        type="button"
                        data-ndb-menu-trigger
                        className="ndb-th-btn"
                        onClick={() => setOpenMenu(isPropOpen ? null : { kind: "prop", id: property.id })}
                      >
                        <span className="ndb-prop-icon">{propertyIcon(property.type)}</span>
                        <span className="ndb-th-name">{property.name}</span>
                      </button>
                      <span
                        className={`ndb-col-resizer ${resizingKey === property.id ? "ndb-col-resizer--active" : ""}`}
                        onClick={(e) => e.stopPropagation()}
                        onMouseDown={(event) => startResizeColumn(property, event)}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          handleUpdateProperty(property.id, { width: undefined });
                        }}
                        title="드래그하여 열 가로 너비 조절 · 더블클릭 시 초기화"
                      />

                      {isPropOpen && (
                        <div className="ndb-popover ndb-prop-popover" onClick={(e) => e.stopPropagation()}>
                          <div className="ndb-popover-section">
                            <input
                              type="text"
                              className="ndb-prop-name-input"
                              value={property.name}
                              aria-label="속성 이름"
                              autoFocus
                              onChange={(e) => handleUpdateProperty(property.id, { name: e.target.value })}
                            />
                            <label className="ndb-field-label">
                              유형
                              <select
                                value={property.type}
                                onChange={(e) =>
                                  handleUpdateProperty(property.id, {
                                    type: e.target.value as CollectionPropertyType,
                                  })
                                }
                              >
                                {PROPERTY_TYPE_META.map((item) => (
                                  <option key={item.type} value={item.type}>
                                    {item.icon} {item.label}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <div className="ndb-field-label">
                              <div className="ndb-width-control__head">
                                <span>열 가로 너비</span>
                                <span className="ndb-width-control__val">
                                  {property.width ?? 170}px
                                  {property.width !== undefined && (
                                    <button
                                      type="button"
                                      className="ndb-width-reset-btn"
                                      onClick={() => handleUpdateProperty(property.id, { width: undefined })}
                                    >
                                      초기화
                                    </button>
                                  )}
                                </span>
                              </div>
                              <input
                                type="range"
                                className="ndb-width-slider"
                                min={80}
                                max={720}
                                step={4}
                                value={property.width ?? 170}
                                aria-label={`${property.name} 열 가로 너비`}
                                onChange={(e) => handleUpdateProperty(property.id, { width: Number(e.target.value) })}
                              />
                            </div>

                            {property.type === "number" && (
                              <label className="ndb-field-label">
                                숫자 형식
                                <select
                                  value={property.numberFormat ?? "number"}
                                  onChange={(e) =>
                                    handleUpdateProperty(property.id, {
                                      numberFormat: e.target.value as CollectionProperty["numberFormat"],
                                    })
                                  }
                                >
                                  <option value="number">일반 숫자</option>
                                  <option value="comma">천 단위 구분 (1,000)</option>
                                  <option value="krw">원화 (₩)</option>
                                  <option value="usd">달러 ($)</option>
                                  <option value="percent">퍼센트 (%)</option>
                                </select>
                              </label>
                            )}

                            {(property.type === "select" ||
                              property.type === "status" ||
                              property.type === "multi_select") && (
                              <div className="ndb-field-label">
                                <span>옵션 관리</span>
                                <div className="ndb-prop-options-list">
                                  {(property.options ?? []).map((opt) => {
                                    const color = getOptionColor(property, opt);
                                    return (
                                      <div key={opt} className="ndb-prop-option-row">
                                        <span className={`ndb-pill ndb-pill--${color}`}>{opt}</span>
                                        <button
                                          type="button"
                                          className="ndb-option-popover__del-btn"
                                          onClick={() =>
                                            handleUpdateProperty(property.id, {
                                              options: (property.options ?? []).filter((item) => item !== opt),
                                            })
                                          }
                                        >
                                          ×
                                        </button>
                                      </div>
                                    );
                                  })}
                                  <input
                                    type="text"
                                    placeholder="새 옵션 입력 후 Enter…"
                                    value={newPropOptionInput}
                                    onChange={(e) => setNewPropOptionInput(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter" && newPropOptionInput.trim()) {
                                        e.preventDefault();
                                        const clean = newPropOptionInput.trim();
                                        const currentOpts = property.options ?? [];
                                        if (!currentOpts.includes(clean)) {
                                          handleUpdateProperty(property.id, {
                                            options: [...currentOpts, clean],
                                          });
                                        }
                                        setNewPropOptionInput("");
                                      }
                                    }}
                                  />
                                </div>
                              </div>
                            )}

                            {property.type === "relation" && (
                              <label className="ndb-field-label">
                                연결할 데이터베이스
                                <select
                                  value={property.relationCollectionId ?? ""}
                                  onChange={(e) =>
                                    handleUpdateProperty(property.id, { relationCollectionId: e.target.value })
                                  }
                                >
                                  <option value="">선택하세요</option>
                                  <option value={collectionId}>{data.title} (현재 데이터베이스)</option>
                                  {availableCollections
                                    .filter((item) => item.id !== collectionId)
                                    .map((item) => (
                                      <option key={item.id} value={item.id}>
                                        {item.title} · {item.ownerPageTitle}
                                      </option>
                                    ))}
                                </select>
                              </label>
                            )}

                            {property.type === "rollup" && (
                              <>
                                <label className="ndb-field-label">
                                  관계형 속성
                                  <select
                                    value={property.rollupRelationId ?? ""}
                                    onChange={(e) =>
                                      handleUpdateProperty(property.id, {
                                        rollupRelationId: e.target.value,
                                        rollupPropertyId: "",
                                      })
                                    }
                                  >
                                    <option value="">선택하세요</option>
                                    {data.properties
                                      .filter((item) => item.type === "relation")
                                      .map((item) => (
                                        <option key={item.id} value={item.id}>
                                          {item.name}
                                        </option>
                                      ))}
                                  </select>
                                </label>
                                <label className="ndb-field-label">
                                  대상 속성
                                  <select
                                    value={property.rollupPropertyId ?? ""}
                                    onChange={(e) =>
                                      handleUpdateProperty(property.id, { rollupPropertyId: e.target.value })
                                    }
                                  >
                                    <option value="">선택하세요</option>
                                    <option value="title">이름</option>
                                    {rollupTarget(property)
                                      ?.properties.filter((item) => item.type !== "relation" && item.id !== property.id)
                                      .map((item) => (
                                        <option key={item.id} value={item.id}>
                                          {item.name}
                                        </option>
                                      ))}
                                  </select>
                                </label>
                                <label className="ndb-field-label">
                                  계산 방식
                                  <select
                                    value={property.rollupFunction ?? "count"}
                                    onChange={(e) =>
                                      handleUpdateProperty(property.id, {
                                        rollupFunction: e.target.value as CollectionProperty["rollupFunction"],
                                      })
                                    }
                                  >
                                    <option value="count">항목 수</option>
                                    <option value="sum">합계</option>
                                    <option value="average">평균</option>
                                    <option value="min">최솟값</option>
                                    <option value="max">최댓값</option>
                                    <option value="show_unique">고유값 표시</option>
                                  </select>
                                </label>
                              </>
                            )}

                            {property.type === "formula" && (
                              <label className="ndb-field-label">
                                수식 입력
                                <input
                                  type="text"
                                  value={property.formula ?? ""}
                                  placeholder={'prop("금액") * prop("수량")'}
                                  onChange={(e) => handleUpdateProperty(property.id, { formula: e.target.value })}
                                />
                                <small>prop("속성"), if(), round(), concat(), empty(), length()</small>
                              </label>
                            )}
                          </div>

                          <div className="ndb-popover-section">
                            <button
                              type="button"
                              className="ndb-menu-btn"
                              onClick={() => {
                                setViewSorts([{ propertyId: property.id, direction: "asc" }]);
                                setOpenMenu(null);
                              }}
                            >
                              ↑ 오름차순 정렬
                            </button>
                            <button
                              type="button"
                              className="ndb-menu-btn"
                              onClick={() => {
                                setViewSorts([{ propertyId: property.id, direction: "desc" }]);
                                setOpenMenu(null);
                              }}
                            >
                              ↓ 내림차순 정렬
                            </button>
                            <button
                              type="button"
                              className="ndb-menu-btn"
                              onClick={() => {
                                updateActiveView({
                                  filters: [
                                    ...(activeView.filters ?? []),
                                    { propertyId: property.id, operator: "contains", value: "" },
                                  ],
                                });
                                setShowFilterBar(true);
                                setOpenMenu(null);
                              }}
                            >
                              ⧩ 이 속성으로 필터
                            </button>
                            <button
                              type="button"
                              className="ndb-menu-btn"
                              onClick={() => {
                                updateActiveView({
                                  groupBy: activeView.groupBy === property.id ? "" : property.id,
                                });
                                setOpenMenu(null);
                              }}
                            >
                              ◫ {activeView.groupBy === property.id ? "그룹화 해제" : "이 속성으로 그룹화"}
                            </button>
                            <button
                              type="button"
                              className="ndb-menu-btn"
                              onClick={() => {
                                updateActiveView({
                                  hiddenPropertyIds: [...(activeView.hiddenPropertyIds ?? []), property.id],
                                });
                                setOpenMenu(null);
                              }}
                            >
                              👁 뷰에서 숨기기
                            </button>
                          </div>

                          <div className="ndb-popover-footer">
                            <div className="ndb-prop-move-btns">
                              <button
                                type="button"
                                disabled={propertyIndex === 0}
                                onClick={() =>
                                  updateData((prev) => {
                                    const properties = [...prev.properties];
                                    const idx = properties.findIndex((item) => item.id === property.id);
                                    if (idx > 0) [properties[idx - 1], properties[idx]] = [properties[idx], properties[idx - 1]];
                                    return { ...prev, properties };
                                  })
                                }
                              >
                                ← 왼쪽으로
                              </button>
                              <button
                                type="button"
                                disabled={propertyIndex === data.properties.length - 1}
                                onClick={() =>
                                  updateData((prev) => {
                                    const properties = [...prev.properties];
                                    const idx = properties.findIndex((item) => item.id === property.id);
                                    if (idx >= 0 && idx < properties.length - 1)
                                      [properties[idx], properties[idx + 1]] = [properties[idx + 1], properties[idx]];
                                    return { ...prev, properties };
                                  })
                                }
                              >
                                오른쪽으로 →
                              </button>
                            </div>
                            <button
                              type="button"
                              className="ndb-menu-btn ndb-menu-btn--danger"
                              onClick={() => {
                                updateData((prev) => ({
                                  ...prev,
                                  properties: prev.properties.filter((item) => item.id !== property.id),
                                  rows: prev.rows.map((row) => ({
                                    ...row,
                                    values: Object.fromEntries(
                                      Object.entries(row.values ?? {}).filter(([id]) => id !== property.id),
                                    ),
                                  })),
                                }));
                                setOpenMenu(null);
                              }}
                            >
                              🗑 속성 삭제
                            </button>
                          </div>
                        </div>
                      )}
                    </th>
                  );
                })}
                <th className="ndb-th ndb-th--add">
                  <button
                    type="button"
                    data-ndb-menu-trigger
                    className="ndb-add-prop-th-btn"
                    onClick={() => setOpenMenu(openMenu?.kind === "add-prop" ? null : { kind: "add-prop" })}
                    aria-label="속성 추가"
                    title="속성 추가"
                  >
                    +
                  </button>
                  {openMenu?.kind === "add-prop" && (
                    <div className="ndb-popover ndb-type-picker ndb-type-picker--right" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="text"
                        className="ndb-prop-name-input"
                        placeholder="속성 이름 (선택사항)…"
                        value={newPropNameInput}
                        autoFocus
                        onChange={(e) => setNewPropNameInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            handleCreateProperty(newPropNameInput, "text");
                          }
                        }}
                      />
                      <div className="ndb-option-popover__caption">유형 선택 (클릭 시 바로 추가)</div>
                      <div className="ndb-type-picker__grid">
                        {PROPERTY_TYPE_META.map((item) => (
                          <button
                            key={item.type}
                            type="button"
                            className="ndb-type-picker__btn"
                            onClick={() => handleCreateProperty(newPropNameInput, item.type)}
                          >
                            <span className="ndb-prop-icon">{item.icon}</span>
                            <span>{item.label}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </th>
              </tr>
            </thead>

            <tbody>
              {groupedRowBuckets && groupProperty ? (
                groupedRowBuckets.map(([groupKey, groupRows]) => {
                  const isCollapsed = activeView.collapsedGroups?.includes(groupKey);
                  const color = getOptionColor(groupProperty, groupKey);
                  return (
                    <>
                      <tr key={`group-${groupKey}`} className="ndb-group-tr">
                        <td colSpan={visibleProperties.length + 3}>
                          <div className="ndb-group-header">
                            <button
                              type="button"
                              className="ndb-group-header__toggle"
                              onClick={() => toggleCollapseGroup(groupKey)}
                            >
                              <span className="ndb-group-header__caret">{isCollapsed ? "▸" : "▾"}</span>
                              <span className={`ndb-pill ndb-pill--${color}`}>
                                {groupKey || "비어 있음"}
                              </span>
                              <span className="ndb-group-header__count">{groupRows.length}</span>
                            </button>
                            <button
                              type="button"
                              className="ndb-group-header__add"
                              onClick={() => handleAddRow({ [groupProperty.id]: groupKey })}
                            >
                              + 새로 만들기
                            </button>
                          </div>
                        </td>
                      </tr>
                      {!isCollapsed && groupRows.map((row) => renderTableRow(row))}
                    </>
                  );
                })
              ) : (
                filteredAndSortedRows.map((row) => renderTableRow(row))
              )}

              <tr className="ndb-new-row-tr">
                <td />
                <td colSpan={visibleProperties.length + 2}>
                  <button type="button" className="ndb-table-new-row-btn" onClick={() => handleAddRow()}>
                    + 새로 만들기
                  </button>
                </td>
              </tr>
            </tbody>

            <tfoot>
              <tr className="ndb-calc-tr">
                <td />
                <td className="ndb-calc-td">
                  <span className="ndb-calc-summary">개수 {filteredAndSortedRows.length}</span>
                </td>
                {visibleProperties.map((property) => {
                  const calcValue = computeColumnCalculation(
                    data,
                    filteredAndSortedRows,
                    property,
                    property.calculation,
                    relatedCollections,
                  );
                  const calcLabel = CALCULATION_LABELS[property.calculation ?? "none"];
                  return (
                    <td key={property.id} className="ndb-calc-td">
                      <div className="ndb-calc-cell">
                        <select
                          className={`ndb-calc-select ${property.calculation && property.calculation !== "none" ? "ndb-calc-select--active" : ""}`}
                          aria-label={`${property.name} 열 계산`}
                          value={property.calculation ?? "none"}
                          onChange={(e) =>
                            handleUpdateProperty(property.id, {
                              calculation: e.target.value as CollectionCalculationType,
                            })
                          }
                        >
                          {Object.entries(CALCULATION_LABELS).map(([k, label]) => (
                            <option key={k} value={k}>
                              {label}
                            </option>
                          ))}
                        </select>
                        {calcValue && (
                          <span className="ndb-calc-value">
                            <small>{calcLabel}</small> <strong>{calcValue}</strong>
                          </span>
                        )}
                      </div>
                    </td>
                  );
                })}
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      ) : activeView.mode === "board" ? (
        <div className="ndb-board">
          {!boardProperty ? (
            <div className="ndb-empty-state">
              <p>보드를 사용하려면 상태 또는 선택 속성을 지정하세요.</p>
              <div className="ndb-empty-state__actions">
                {data.properties.some((p) => p.type === "status" || p.type === "select") && (
                  <select
                    aria-label="보드 그룹화 속성"
                    value=""
                    onChange={(e) => updateActiveView({ groupBy: e.target.value })}
                  >
                    <option value="">기존 속성 선택…</option>
                    {data.properties
                      .filter((p) => p.type === "status" || p.type === "select")
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </select>
                )}
                <button
                  type="button"
                  className="ndb-new-btn"
                  style={{ borderRadius: 5 }}
                  onClick={() => {
                    const id = handleCreateProperty("상태", "status");
                    updateActiveView({ groupBy: id });
                    setOpenMenu(null);
                  }}
                >
                  + 상태 속성 만들기
                </button>
              </div>
            </div>
          ) : (
            boardGroups.map((group) => {
              const columnRows = filteredAndSortedRows.filter(
                (row) => String(row.values?.[boardProperty.id] ?? "") === group,
              );
              const groupColor = getOptionColor(boardProperty, group);
              const boardColWidth = activeView.boardColumnWidth ?? 250;
              return (
                <div
                  key={group || "__empty"}
                  className={`ndb-board-col ${dragOverGroup === group ? "ndb-board-col--drop" : ""}`}
                  style={{ flex: `0 0 ${boardColWidth}px`, width: `${boardColWidth}px` }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOverGroup(group);
                  }}
                  onDragLeave={() => setDragOverGroup(null)}
                  onDrop={(e) => {
                    e.preventDefault();
                    const row = data.rows.find((item) => item.id === draggingRowId);
                    if (row) handleUpdateValue(row, boardProperty.id, group);
                    setDraggingRowId(null);
                    setDragOverGroup(null);
                  }}
                >
                  <span
                    className={`ndb-board-col__resizer ${resizingKey === "board" ? "ndb-col-resizer--active" : ""}`}
                    onClick={(e) => e.stopPropagation()}
                    onMouseDown={(e) =>
                      startResizeViewMetric("board", "boardColumnWidth", boardColWidth, 180, 560, e)
                    }
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      updateActiveView({ boardColumnWidth: undefined });
                    }}
                    title="드래그하여 보드 항목 가로 너비 조절 · 더블클릭 시 초기화"
                  />
                  <div className="ndb-board-col__head">
                    <span className={`ndb-pill ndb-pill--${groupColor} ${boardProperty.type === "status" ? "ndb-pill--status" : ""}`}>
                      {boardProperty.type === "status" && <span className="ndb-pill__dot" />}
                      {group || "비어 있음"}
                    </span>
                    <span className="ndb-board-col__count">{columnRows.length}</span>
                    <button
                      type="button"
                      className="ndb-board-col__plus"
                      onClick={() => handleAddRow({ [boardProperty.id]: group })}
                      title="항목 추가"
                    >
                      +
                    </button>
                  </div>

                  <div className="ndb-board-col__list">
                    {columnRows.map((row) => (
                      <div
                        key={row.id}
                        className="ndb-board-card"
                        draggable
                        onDragStart={(e) => {
                          setDraggingRowId(row.id);
                          e.dataTransfer.setData("text/plain", row.id);
                        }}
                        onDragEnd={() => {
                          setDraggingRowId(null);
                          setDragOverGroup(null);
                        }}
                      >
                        <div className="ndb-board-card__top">
                          {row.icon && <span className="ndb-row-icon">{row.icon}</span>}
                          <input
                            ref={(el) => {
                              if (el) titleInputsRef.current.set(row.id, el);
                              else titleInputsRef.current.delete(row.id);
                            }}
                            type="text"
                            className="ndb-board-card__title"
                            value={row.title}
                            placeholder="항목 이름…"
                            onChange={(e) => handleUpdateRowText(row, "title", e.target.value)}
                          />
                          <div className="ndb-board-card__actions">
                            <button
                              type="button"
                              className="ndb-open-btn"
                              onClick={(e) => openRow(row, e)}
                              title="상세 열기"
                            >
                              열기
                            </button>
                            <button
                              type="button"
                              className="ndb-row-action-icon ndb-row-action-icon--danger"
                              onClick={() => handleDeleteRow(row.id)}
                              title="삭제"
                            >
                              ×
                            </button>
                          </div>
                        </div>

                        <div className="ndb-board-card__props" onClick={(e) => openRow(row, e)}>
                          {visibleProperties
                            .filter((p) => p.id !== boardProperty.id && cellValue(row, p) !== "")
                            .map((p) => {
                              const val = String(cellValue(row, p));
                              if (p.type === "select" || p.type === "status" || p.type === "multi_select") {
                                return (
                                  <div key={p.id} className="ndb-pill-list">
                                    {val
                                      .split(MULTI_VALUE_SEPARATOR)
                                      .filter(Boolean)
                                      .map((opt) => (
                                        <span key={opt} className={`ndb-pill ndb-pill--${getOptionColor(p, opt)}`}>
                                          {opt}
                                        </span>
                                      ))}
                                  </div>
                                );
                              }
                              return (
                                <span key={p.id} className="ndb-board-card__meta">
                                  {p.type === "checkbox" ? `☑ ${p.name}` : val}
                                </span>
                              );
                            })}
                        </div>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="ndb-board-col__new"
                      onClick={() => handleAddRow({ [boardProperty.id]: group })}
                    >
                      + 새로 만들기
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      ) : activeView.mode === "calendar" ? (
        <div className="ndb-calendar">
          {!dateProperty ? (
            <div className="ndb-empty-state">
              <p>캘린더를 사용하려면 날짜 속성을 지정하세요.</p>
              <div className="ndb-empty-state__actions">
                {data.properties.some((p) => p.type === "date") && (
                  <select
                    aria-label="캘린더 날짜 속성"
                    value=""
                    onChange={(e) => updateActiveView({ datePropertyId: e.target.value })}
                  >
                    <option value="">기존 날짜 속성 선택…</option>
                    {data.properties
                      .filter((p) => p.type === "date")
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </select>
                )}
                <button
                  type="button"
                  className="ndb-new-btn"
                  style={{ borderRadius: 5 }}
                  onClick={() => {
                    const id = handleCreateProperty("날짜", "date");
                    updateActiveView({ datePropertyId: id });
                    setOpenMenu(null);
                  }}
                >
                  + 날짜 속성 만들기
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="ndb-calendar__bar">
                <strong>
                  {calendarMonth.getFullYear()}년 {calendarMonth.getMonth() + 1}월
                </strong>
                <div className="ndb-calendar__nav">
                  <button
                    type="button"
                    onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1))}
                    aria-label="이전 달"
                  >
                    ‹
                  </button>
                  <button
                    type="button"
                    onClick={() => setCalendarMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}
                  >
                    오늘
                  </button>
                  <button
                    type="button"
                    onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1))}
                    aria-label="다음 달"
                  >
                    ›
                  </button>
                </div>
              </div>

              <div className="ndb-calendar__grid">
                {["일", "월", "화", "수", "목", "금", "토"].map((day) => (
                  <div key={day} className="ndb-calendar__weekday">
                    {day}
                  </div>
                ))}
                {calendarCells.map((date, index) => {
                  const isToday = date === todayIso;
                  return (
                    <div
                      key={index}
                      className={`ndb-calendar__cell ${!date ? "ndb-calendar__cell--empty" : ""} ${
                        date && dragOverDate === date ? "ndb-calendar__cell--drop" : ""
                      }`}
                      onDragOver={(e) => {
                        if (!date || !draggingRowId) return;
                        e.preventDefault();
                        setDragOverDate(date);
                      }}
                      onDragLeave={() => setDragOverDate(null)}
                      onDrop={(e) => {
                        if (!date || !draggingRowId) return;
                        e.preventDefault();
                        const row = data.rows.find((item) => item.id === draggingRowId);
                        if (row) handleUpdateValue(row, dateProperty.id, date);
                        setDraggingRowId(null);
                        setDragOverDate(null);
                      }}
                    >
                      {date && (
                        <>
                          <div className="ndb-calendar__cell-head">
                            <button
                              type="button"
                              className="ndb-calendar__add-btn"
                              onClick={() => handleAddRow({ [dateProperty.id]: date }, { openAfterCreate: true })}
                              aria-label={`${date} 항목 추가`}
                            >
                              +
                            </button>
                            <span className={`ndb-calendar__day-num ${isToday ? "ndb-calendar__day-num--today" : ""}`}>
                              {Number(date.slice(-2))}
                            </span>
                          </div>
                          <div className="ndb-calendar__events">
                            {filteredAndSortedRows
                              .filter((row) => row.values?.[dateProperty.id] === date)
                              .map((row) => (
                                <button
                                  key={row.id}
                                  type="button"
                                  draggable
                                  onDragStart={(e) => {
                                    setDraggingRowId(row.id);
                                    e.dataTransfer.setData("text/plain", row.id);
                                  }}
                                  onDragEnd={() => {
                                    setDraggingRowId(null);
                                    setDragOverDate(null);
                                  }}
                                  className="ndb-calendar__event"
                                  onClick={(e) => openRow(row, e)}
                                >
                                  <span>{row.icon || "📄"}</span>
                                  <span>{row.title || "제목 없음"}</span>
                                </button>
                              ))}
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>

              {filteredAndSortedRows.some((row) => !row.values?.[dateProperty.id]) && (
                <div className="ndb-calendar__unscheduled">
                  <span>날짜 없음 ({filteredAndSortedRows.filter((row) => !row.values?.[dateProperty.id]).length})</span>
                  <div className="ndb-calendar__unscheduled-list">
                    {filteredAndSortedRows
                      .filter((row) => !row.values?.[dateProperty.id])
                      .map((row) => (
                        <button
                          key={row.id}
                          type="button"
                          draggable
                          onDragStart={(e) => {
                            setDraggingRowId(row.id);
                            e.dataTransfer.setData("text/plain", row.id);
                          }}
                          onDragEnd={() => {
                            setDraggingRowId(null);
                            setDragOverDate(null);
                          }}
                          className="ndb-calendar__event"
                          onClick={(e) => openRow(row, e)}
                        >
                          <span>{row.icon || "📄"}</span>
                          <span>{row.title || "제목 없음"}</span>
                        </button>
                      ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      ) : activeView.mode === "list" ? (
        <div className="ndb-list">
          {filteredAndSortedRows.map((row) => (
            <div key={row.id} className="ndb-list__item">
              <div className="ndb-list__left">
                <span className="ndb-row-icon" onClick={(e) => openRow(row, e)}>
                  {row.icon || "📄"}
                </span>
                <div
                  className="ndb-list__title-wrap"
                  style={{ width: `${activeView.titleWidth ?? 260}px` }}
                >
                  <input
                    ref={(el) => {
                      if (el) titleInputsRef.current.set(row.id, el);
                      else titleInputsRef.current.delete(row.id);
                    }}
                    type="text"
                    className="ndb-list__title"
                    value={row.title}
                    placeholder="제목 없음"
                    onChange={(e) => handleUpdateRowText(row, "title", e.target.value)}
                  />
                  <span
                    className={`ndb-list__resizer ${resizingKey === "title" ? "ndb-col-resizer--active" : ""}`}
                    onClick={(e) => e.stopPropagation()}
                    onMouseDown={startResizeTitleColumn}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      updateActiveView({ titleWidth: undefined });
                    }}
                    title="드래그하여 항목 가로 너비 조절 · 더블클릭 시 초기화"
                  />
                </div>
                <button type="button" className="ndb-open-btn" onClick={(e) => openRow(row, e)}>
                  ◧ 열기
                </button>
              </div>
              <div className="ndb-list__right">
                {visibleProperties
                  .filter((p) => cellValue(row, p) !== "")
                  .map((p) => {
                    const val = String(cellValue(row, p));
                    if (p.type === "select" || p.type === "status" || p.type === "multi_select") {
                      return (
                        <span key={p.id} className="ndb-pill-list">
                          {val
                            .split(MULTI_VALUE_SEPARATOR)
                            .filter(Boolean)
                            .map((opt) => (
                              <span key={opt} className={`ndb-pill ndb-pill--${getOptionColor(p, opt)}`}>
                                {opt}
                              </span>
                            ))}
                        </span>
                      );
                    }
                    return (
                      <span key={p.id} className="ndb-list__meta">
                        {val.split(MULTI_VALUE_SEPARATOR).join(", ")}
                      </span>
                    );
                  })}
                <button
                  type="button"
                  className="ndb-row-action-icon ndb-row-action-icon--danger"
                  onClick={() => handleDeleteRow(row.id)}
                  aria-label="삭제"
                >
                  ×
                </button>
              </div>
            </div>
          ))}
          <button type="button" className="ndb-table-new-row-btn" onClick={() => handleAddRow()}>
            + 새로 만들기
          </button>
        </div>
      ) : (
        <div
          className="ndb-gallery"
          style={
            activeView.galleryCardWidth
              ? { gridTemplateColumns: `repeat(auto-fill, min(100%, ${activeView.galleryCardWidth}px))` }
              : undefined
          }
        >
          {filteredAndSortedRows.map((row) => {
            const galleryCardWidth = activeView.galleryCardWidth ?? 220;
            return (
            <article key={row.id} className="ndb-gallery__card">
              <span
                className={`ndb-gallery__resizer ${resizingKey === "gallery" ? "ndb-col-resizer--active" : ""}`}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) =>
                  startResizeViewMetric("gallery", "galleryCardWidth", galleryCardWidth, 150, 560, e)
                }
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  updateActiveView({ galleryCardWidth: undefined });
                }}
                title="드래그하여 카드 가로 너비 조절 · 더블클릭 시 초기화"
              />
              <div className="ndb-gallery__preview" onClick={(e) => openRow(row, e)}>
                {row.text ? (
                  <p className="ndb-gallery__preview-text">{row.text}</p>
                ) : (
                  <span className="ndb-gallery__preview-icon">{row.icon || "📄"}</span>
                )}
              </div>
              <div className="ndb-gallery__body">
                <div className="ndb-gallery__title-row">
                  {row.icon && <span>{row.icon}</span>}
                  <input
                    ref={(el) => {
                      if (el) titleInputsRef.current.set(row.id, el);
                      else titleInputsRef.current.delete(row.id);
                    }}
                    type="text"
                    className="ndb-gallery__title"
                    value={row.title}
                    placeholder="제목 없음"
                    onChange={(e) => handleUpdateRowText(row, "title", e.target.value)}
                  />
                  <button type="button" className="ndb-open-btn" onClick={(e) => openRow(row, e)}>
                    열기
                  </button>
                </div>
                <div className="ndb-gallery__props">
                  {visibleProperties
                    .filter((p) => cellValue(row, p) !== "")
                    .slice(0, 3)
                    .map((p) => {
                      const val = String(cellValue(row, p));
                      if (p.type === "select" || p.type === "status" || p.type === "multi_select") {
                        return (
                          <div key={p.id} className="ndb-pill-list">
                            {val
                              .split(MULTI_VALUE_SEPARATOR)
                              .filter(Boolean)
                              .map((opt) => (
                                <span key={opt} className={`ndb-pill ndb-pill--${getOptionColor(p, opt)}`}>
                                  {opt}
                                </span>
                              ))}
                          </div>
                        );
                      }
                      return (
                        <span key={p.id} className="ndb-board-card__meta">
                          {val.split(MULTI_VALUE_SEPARATOR).join(", ")}
                        </span>
                      );
                    })}
                </div>
              </div>
            </article>
            );
          })}
          <button type="button" className="ndb-gallery__add" onClick={() => handleAddRow()}>
            + 새로 만들기
          </button>
        </div>
      )}

      {/* 5. Notion Row Peek Drawer / Modal */}
      {activeRow && (
        <NotionRowPeek
          row={activeRow}
          rowIndex={activeRowIndex}
          totalRows={filteredAndSortedRows.length}
          data={data}
          relatedCollections={relatedCollections}
          session={
            activeSession
              ? { doc: activeSession.doc, provider: activeSession.provider }
              : collaborationDoc
                ? { doc: collaborationDoc, provider: collaborationProvider ?? null }
                : null
          }
          peekMode={activeView.peekMode ?? "side"}
          peekWidth={activeView.peekWidth}
          peekLabelWidth={activeView.peekLabelWidth}
          onResizePeek={(patch, options) => updateActiveView(patch, options)}
          onTogglePeekMode={() =>
            updateActiveView({ peekMode: (activeView.peekMode ?? "side") === "side" ? "center" : "side" })
          }
          onNavigateRow={(delta) => {
            const nextRow = filteredAndSortedRows[activeRowIndex + delta];
            if (nextRow) setActiveRowId(nextRow.id);
          }}
          onClose={() => setActiveRowId(null)}
          onChangeTitle={(next) => handleUpdateRowText(activeRow, "title", next)}
          onChangeIcon={(icon) => handleUpdateRow(activeRow.id, { icon })}
          onChangeText={(next) => handleUpdateRowText(activeRow, "text", next)}
          onChangeValue={(propertyId, value) => {
            const prop = data.properties.find((p) => p.id === propertyId);
            if (prop?.type === "text" && typeof value === "string") {
              handleUpdateCellText(activeRow, propertyId, value);
            } else {
              handleUpdateValue(activeRow, propertyId, value);
            }
          }}
          onUpdateProperty={(propertyId, patch) => handleUpdateProperty(propertyId, patch)}
          onAddProperty={(name, type) => handleCreateProperty(name, type)}
          onDuplicateRow={() => handleDuplicateRow(activeRow)}
          onDeleteRow={() => handleDeleteRow(activeRow.id)}
          onOpenFullPage={(openInSplit) => void handleOpenRowNote(activeRow, openInSplit)}
        />
      )}
    </div>
  );
}

export const createCollectionBlockSpec = createReactBlockSpec(
  {
    type: "collection",
    propSchema: {
      dataJson: {
        default: "",
      },
    },
    content: "none",
  } as const,
  {
    render: (props) => (
      <CollectionBlockComponent
        blockId={props.block.id}
        dataJson={props.block.props.dataJson}
        onChangeDataJson={(nextJson) => {
          props.editor.updateBlock(props.block, {
            type: "collection",
            props: { dataJson: nextJson },
          } as any);
        }}
      />
    ),
  },
);
