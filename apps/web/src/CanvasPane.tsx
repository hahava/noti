import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import {
  Background,
  ConnectionMode,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  NodeResizer,
  NodeToolbar,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type FinalConnectionState,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import {
  CANVAS_PRESET_COLORS,
  canvasMaps,
  cardsInsideGroups,
  readCanvas,
  removeCanvasEdges,
  removeCanvasNodes,
  resolveNewPageParent,
  setCanvasNewPageParent,
  upsertCanvasEdge,
  upsertCanvasNode,
  type CanvasData,
  type CanvasEdge,
  type CanvasNode,
  type CanvasSide,
} from "@noty/shared/canvas";
import { resolveCollaborationWsUrl } from "./collaboration-url";
import { resolveUploadUrl, workspaceApi, type PagePreview } from "./api";
import type { AuthSession, PageItem } from "./vite-env";
import { PreviewBlocks } from "./PageHistory";
import { CanvasMarkdown, toggleCheckLine } from "./canvas-markdown";

/**
 * 캔버스: 페이지 카드·메모·이미지·링크·그룹을 자유롭게 놓고 선으로 잇는 화면.
 * 내용은 페이지 협업 방(page:<캔버스 id>)의 Yjs 문서에 저장돼 여러 사람이 동시에 편집한다.
 * 페이지 카드는 페이지 id 만 가리킨다 (페이지가 사이드바 어디에 있든 상관없음, 카드를 지워도 페이지는 남음).
 */

const SIDES: CanvasSide[] = ["top", "right", "bottom", "left"];
const SIDE_POSITION: Record<CanvasSide, Position> = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
};
const DEFAULT_SIZE: Record<CanvasNode["type"], { width: number; height: number }> = {
  page: { width: 260, height: 150 },
  text: { width: 220, height: 120 },
  image: { width: 280, height: 200 },
  link: { width: 260, height: 90 },
  group: { width: 480, height: 320 },
};

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).replace(/-/g, "").slice(0, 16);

type CardData = {
  card: CanvasNode;
  readOnly: boolean;
  preview?: PagePreview;
  pageMeta?: PageItem;
  onOpenPage: (pageId: string) => void;
  onUpdate: (id: string, patch: Partial<CanvasNode>) => void;
  onConvertToPage: (card: CanvasNode) => void;
  compact?: boolean;
  /** 이 페이지 카드를 지금 카드 안에서 편집 중인지 */
  editing?: boolean;
  onStartEditing?: (card: CanvasNode) => void;
  /** 카드 안에 띄울 페이지 편집기 (App 의 EditorPane) */
  renderPageEditor?: (pageId: string) => ReactNode;
  /** 메모의 [[페이지 제목]] → 페이지 id */
  resolvePageByTitle?: (title: string) => string | undefined;
};

/** 미리 정한 색 "1"~"6" → CSS 색 (그 밖의 값은 #hex 그대로) */
const COLOR_VALUES: Record<string, string> = {
  "1": "#e03e3e",
  "2": "#d9730d",
  "3": "#cb912f",
  "4": "#448361",
  "5": "#337ea9",
  "6": "#9065b0",
};
const COLOR_NAMES: Record<string, string> = { "1": "빨강", "2": "주황", "3": "노랑", "4": "초록", "5": "파랑", "6": "보라" };
const colorValue = (color?: string) => (color ? COLOR_VALUES[color] ?? (/^#[0-9a-f]{3,8}$/i.test(color) ? color : undefined) : undefined);

/** 연결선 화살표: 없음 / 한쪽 / 양쪽 (JSON Canvas 의 fromEnd·toEnd 조합) */
type EdgeDirection = "none" | "forward" | "both";
const edgeDirection = (edge: CanvasEdge): EdgeDirection =>
  (edge.toEnd ?? "arrow") === "none" ? "none" : edge.fromEnd === "arrow" ? "both" : "forward";
const DIRECTION_ENDS: Record<EdgeDirection, Pick<CanvasEdge, "fromEnd" | "toEnd">> = {
  none: { fromEnd: undefined, toEnd: "none" },
  forward: { fromEnd: undefined, toEnd: undefined },
  both: { fromEnd: "arrow", toEnd: undefined },
};

/** 색 고르기: 없음 + 미리 정한 6가지 */
function ColorSwatches({ value, onChange }: { value?: string; onChange: (color: string | undefined) => void }) {
  return (
    <div className="canvas-swatches" role="group" aria-label="색">
      <button
        type="button"
        className={`canvas-swatch canvas-swatch--none ${!value ? "canvas-swatch--active" : ""}`}
        aria-label="색 없음"
        aria-pressed={!value}
        title="색 없음"
        onClick={() => onChange(undefined)}
      />
      {CANVAS_PRESET_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          className={`canvas-swatch ${value === color ? "canvas-swatch--active" : ""}`}
          style={{ background: COLOR_VALUES[color] }}
          aria-label={COLOR_NAMES[color]}
          aria-pressed={value === color}
          title={COLOR_NAMES[color]}
          onClick={() => onChange(color)}
        />
      ))}
    </div>
  );
}

const OPPOSITE_SIDE: Record<CanvasSide, CanvasSide> = { top: "bottom", bottom: "top", left: "right", right: "left" };

// 페이지 카드 본문 캐시 (같은 페이지 카드를 다시 그릴 때 다시 받지 않게)
// shortcut: 카드마다 본문 전체를 한 번씩 받는다, 카드가 아주 많아지면 화면에 보이는 카드만 받게 바꾼다.
const pageBlocksCache = new Map<string, unknown[]>();

/** 페이지 카드에 보여 줄 본문 전체. refreshKey 가 바뀌면(편집을 마치면) 다시 받는다. */
function usePageBlocks(pageId: string | undefined, enabled: boolean, refreshKey: unknown) {
  const [blocks, setBlocks] = useState<unknown[] | null>(() => (pageId ? pageBlocksCache.get(pageId) ?? null : null));
  useEffect(() => {
    if (!pageId || !enabled) return;
    let cancelled = false;
    workspaceApi
      .loadDocument(pageId)
      .then(({ blocks: loaded }) => {
        const list = Array.isArray(loaded) ? loaded : [];
        pageBlocksCache.set(pageId, list);
        if (!cancelled) setBlocks(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [pageId, enabled, refreshKey]);
  return blocks;
}

function SideHandles({ hidden }: { hidden: boolean }) {
  return (
    <>
      {SIDES.map((side) => (
        <Handle
          key={side}
          id={side}
          type="source"
          position={SIDE_POSITION[side]}
          className={`canvas-handle ${hidden ? "canvas-handle--hidden" : ""}`}
          isConnectable={!hidden}
        />
      ))}
    </>
  );
}

function Resizer({ selected, readOnly, id, onUpdate, minWidth = 120, minHeight = 60 }: { selected: boolean; readOnly: boolean; id: string; onUpdate: CardData["onUpdate"]; minWidth?: number; minHeight?: number }) {
  if (readOnly) return null;
  return (
    <NodeResizer
      isVisible={selected}
      minWidth={minWidth}
      minHeight={minHeight}
      lineClassName="canvas-resize-line"
      handleClassName="canvas-resize-handle"
      onResizeEnd={(_event, params) => onUpdate(id, { x: params.x, y: params.y, width: params.width, height: params.height })}
    />
  );
}

function PageCardNode({ data, selected }: NodeProps<Node<CardData>>) {
  const { card, preview, pageMeta, readOnly, onOpenPage, onUpdate, compact, editing, onStartEditing, renderPageEditor } = data;
  const missing = !pageMeta;
  const title = pageMeta?.title || preview?.title || "제목 없는 문서";
  const icon = pageMeta?.icon ?? preview?.icon;
  const isCanvas = pageMeta?.kind === "canvas";
  const canEdit = !readOnly && !compact && !missing && !isCanvas && Boolean(renderPageEditor);
  // 편집을 마칠 때마다 본문을 다시 받는다
  const [editRound, setEditRound] = useState(0);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && !editing) setEditRound((n) => n + 1);
    wasEditing.current = Boolean(editing);
  }, [editing]);
  const blocks = usePageBlocks(card.pageId, !compact && !missing && !isCanvas && !editing, editRound);
  // 첫 블록은 카드 머리의 제목과 같으므로 본문에서는 뺀다
  const body = blocks && blocks.length > 1 ? blocks.slice(1) : null;
  return (
    <div
      className={`canvas-card canvas-card--page ${missing ? "canvas-card--missing" : ""} ${editing ? "canvas-card--editing" : ""}`}
      onDoubleClick={() => {
        if (missing || !card.pageId || editing) return;
        if (canEdit) onStartEditing?.(card);
        else onOpenPage(card.pageId);
      }}
      title={missing || editing ? undefined : canEdit ? "더블클릭해서 카드 안에서 편집" : "더블클릭해서 열기"}
    >
      <Resizer selected={selected} readOnly={readOnly || Boolean(compact)} id={card.id} onUpdate={onUpdate} minWidth={160} minHeight={70} />
      <SideHandles hidden={readOnly || Boolean(compact)} />
      <div className="canvas-card__title">
        <span className="canvas-card__icon">{icon || (isCanvas ? "🎨" : "📄")}</span>
        <span className="canvas-card__title-text">{missing ? "삭제된 페이지" : title}</span>
        {!missing && !compact && card.pageId && (
          <button
            type="button"
            className="canvas-card__open nodrag"
            title="페이지로 열기"
            aria-label="페이지로 열기"
            onClick={(event) => {
              event.stopPropagation();
              onOpenPage(card.pageId!);
            }}
          >
            ↗
          </button>
        )}
      </div>
      {missing ? (
        <div className="canvas-card__excerpt">이 페이지는 휴지통에 있거나 삭제되었습니다.</div>
      ) : editing && card.pageId && renderPageEditor ? (
        <div className="canvas-card__editor nodrag nowheel nopan nokey" onDoubleClick={(e) => e.stopPropagation()}>
          {renderPageEditor(card.pageId)}
        </div>
      ) : body && !compact ? (
        <div className="canvas-card__body nowheel">
          <PreviewBlocks blocks={body as any[]} />
        </div>
      ) : (
        preview?.excerpt && <div className="canvas-card__excerpt">{preview.excerpt}</div>
      )}
    </div>
  );
}

function TextCardNode({ data, selected }: NodeProps<Node<CardData>>) {
  const { card, readOnly, onUpdate, compact, onOpenPage, resolvePageByTitle } = data;
  const [editing, setEditing] = useState(!card.text && !readOnly && !compact);
  const [draft, setDraft] = useState(card.text ?? "");
  useEffect(() => {
    if (!editing) setDraft(card.text ?? "");
  }, [card.text, editing]);
  const commit = () => {
    setEditing(false);
    if (draft !== (card.text ?? "")) onUpdate(card.id, { text: draft });
  };
  return (
    <div className="canvas-card canvas-card--text" onDoubleClick={() => !readOnly && !compact && setEditing(true)}>
      <Resizer selected={selected} readOnly={readOnly || Boolean(compact)} id={card.id} onUpdate={onUpdate} />
      <SideHandles hidden={readOnly || Boolean(compact)} />
      {editing ? (
        <textarea
          className="canvas-card__textarea nodrag nowheel"
          autoFocus
          value={draft}
          placeholder={"메모를 입력하세요\n# 제목  - 목록  - [ ] 할 일  **굵게**  [[페이지]]"}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Escape") commit();
            event.stopPropagation();
          }}
        />
      ) : (
        <div className="canvas-card__text nowheel">
          {card.text ? (
            <CanvasMarkdown
              source={card.text}
              resolvePage={resolvePageByTitle}
              onOpenPage={onOpenPage}
              onToggleCheck={readOnly || compact ? undefined : (line) => onUpdate(card.id, { text: toggleCheckLine(card.text ?? "", line) })}
            />
          ) : (
            <span className="canvas-card__placeholder">빈 메모 — 더블클릭해서 쓰기 (마크다운 지원)</span>
          )}
        </div>
      )}
    </div>
  );
}

function ImageCardNode({ data, selected }: NodeProps<Node<CardData>>) {
  const { card, readOnly, onUpdate, compact } = data;
  const [src, setSrc] = useState("");
  useEffect(() => {
    let cancelled = false;
    if (card.url) void resolveUploadUrl(card.url).then((resolved) => !cancelled && setSrc(resolved));
    return () => {
      cancelled = true;
    };
  }, [card.url]);
  return (
    <div className="canvas-card canvas-card--image">
      <Resizer selected={selected} readOnly={readOnly || Boolean(compact)} id={card.id} onUpdate={onUpdate} minWidth={80} minHeight={60} />
      <SideHandles hidden={readOnly || Boolean(compact)} />
      {src ? <img src={src} alt="" draggable={false} /> : <span className="canvas-card__placeholder">이미지 불러오는 중…</span>}
    </div>
  );
}

function LinkCardNode({ data, selected }: NodeProps<Node<CardData>>) {
  const { card, readOnly, onUpdate, compact } = data;
  let host = card.url ?? "";
  try {
    host = new URL(card.url ?? "").hostname;
  } catch {
    // 그대로
  }
  return (
    <div
      className="canvas-card canvas-card--link"
      onDoubleClick={() => card.url && window.open(card.url, "_blank", "noopener,noreferrer")}
      title="더블클릭해서 열기"
    >
      <Resizer selected={selected} readOnly={readOnly || Boolean(compact)} id={card.id} onUpdate={onUpdate} minWidth={140} minHeight={50} />
      <SideHandles hidden={readOnly || Boolean(compact)} />
      <div className="canvas-card__title">
        <span className="canvas-card__icon">🔗</span>
        <span>{host}</span>
      </div>
      <div className="canvas-card__excerpt canvas-card__url">{card.url}</div>
    </div>
  );
}

function GroupNode({ data, selected }: NodeProps<Node<CardData>>) {
  const { card, readOnly, onUpdate, compact } = data;
  return (
    <div className="canvas-group">
      <Resizer selected={selected} readOnly={readOnly || Boolean(compact)} id={card.id} onUpdate={onUpdate} minWidth={160} minHeight={100} />
      <div
        className="canvas-group__label"
        onDoubleClick={() => {
          if (readOnly || compact) return;
          const label = window.prompt("그룹 이름", card.label ?? "");
          if (label !== null) onUpdate(card.id, { label });
        }}
      >
        {card.label || "그룹"}
      </div>
    </div>
  );
}

const NODE_TYPES = { page: PageCardNode, text: TextCardNode, image: ImageCardNode, link: LinkCardNode, group: GroupNode };

function toFlowNodes(canvas: CanvasData, extra: Omit<CardData, "card" | "preview" | "pageMeta" | "editing"> & { editingCardId?: string | null }, previews: Record<string, PagePreview>, pagesById: Map<string, PageItem>, selected: ReadonlySet<string>): Node<CardData>[] {
  return canvas.nodes.map((card) => ({
    id: card.id,
    type: card.type,
    position: { x: card.x, y: card.y },
    width: card.width,
    height: card.height,
    // 카드 크기는 정해져 있으므로 측정값도 같다. 이 값이 없으면 노드 객체가 새로 만들어질 때마다
    // React Flow 가 연결 손잡이 위치를 버리고 다시 재는데, 그 사이에 선이 안 그려지는 경우가 생긴다.
    measured: { width: card.width, height: card.height },
    style: { width: card.width, height: card.height, ...(colorValue(card.color) ? { "--card-color": colorValue(card.color) } : {}) } as CSSProperties,
    className: colorValue(card.color) ? "canvas-node--colored" : undefined,
    // 그룹은 다른 카드 뒤에 깔린다
    zIndex: card.type === "group" ? -1 : 1,
    selected: selected.has(card.id),
    // 카드 안에서 편집 중이면 끌어서 옮기지 않는다 (글자 선택·드래그가 편집기로 가게)
    draggable: extra.editingCardId === card.id ? false : undefined,
    data: {
      editing: extra.editingCardId === card.id,
      ...extra,
      card,
      preview: card.pageId ? previews[card.pageId] : undefined,
      pageMeta: card.pageId ? pagesById.get(card.pageId) : undefined,
    },
  }));
}

function toFlowEdges(canvas: CanvasData, selected: ReadonlySet<string>): Edge[] {
  return canvas.edges.map((edge) => {
    const color = colorValue(edge.color);
    const marker = { type: MarkerType.ArrowClosed, ...(color ? { color } : {}) };
    return {
      id: edge.id,
      source: edge.fromNode,
      target: edge.toNode,
      sourceHandle: edge.fromSide ?? "right",
      targetHandle: edge.toSide ?? "left",
      label: edge.label,
      selected: selected.has(edge.id),
      markerEnd: (edge.toEnd ?? "arrow") === "arrow" ? marker : undefined,
      markerStart: edge.fromEnd === "arrow" ? marker : undefined,
      style: color ? { stroke: color } : undefined,
      className: "canvas-edge",
    };
  });
}

/** 캔버스 Yjs 문서를 열고 바뀔 때마다 CanvasData 로 읽는다. */
function useCanvasDocument(pageId: string, authSession: AuthSession) {
  const doc = useMemo(() => new Y.Doc(), [pageId]);
  const [canvas, setCanvas] = useState<CanvasData>(() => readCanvas(doc));
  const [status, setStatus] = useState<"connecting" | "synced" | "error">("connecting");
  useEffect(() => {
    const provider = new HocuspocusProvider({
      url: resolveCollaborationWsUrl(authSession.serverHost),
      name: `page:${pageId}`,
      document: doc,
      token: authSession.token,
      onSynced: () => setStatus("synced"),
      onAuthenticationFailed: () => setStatus("error"),
    });
    const update = () => setCanvas(readCanvas(doc));
    const maps = canvasMaps(doc);
    maps.nodes.observeDeep(update);
    maps.edges.observeDeep(update);
    maps.settings.observe(update);
    update();
    return () => {
      maps.nodes.unobserveDeep(update);
      maps.edges.unobserveDeep(update);
      maps.settings.unobserve(update);
      provider.destroy();
      doc.destroy();
    };
  }, [doc, pageId, authSession.serverHost, authSession.token]);
  return { doc, canvas, status };
}

/** 페이지 카드에 보여 줄 미리보기(본문 앞부분). 카드가 바뀌거나 30초마다 새로 읽는다. */
function usePagePreviews(pageIds: string[], refreshKey: unknown) {
  const [previews, setPreviews] = useState<Record<string, PagePreview>>({});
  const key = [...pageIds].sort().join(",");
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const load = () =>
      workspaceApi
        .getPagePreviews(key.split(","))
        .then((res) => !cancelled && setPreviews(res.previews))
        .catch(() => undefined);
    void load();
    const timer = window.setInterval(load, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [key, refreshKey]);
  return previews;
}

type CanvasEditorProps = {
  pageId: string;
  /** 페이지 카드를 카드 안에서 편집할 때 띄울 편집기 */
  renderPageEditor?: (pageId: string) => ReactNode;
  authSession: AuthSession;
  pages: PageItem[];
  pagesById: Map<string, PageItem>;
  readOnly: boolean;
  onOpenPage: (pageId: string) => void;
  /** 새 페이지를 만들고 id 를 돌려준다. bodyText 가 있으면 본문으로 넣는다. */
  onCreatePage: (parentId: string | null, title: string, bodyText?: string) => Promise<string | null>;
  onRename: (title: string) => void;
};

function CanvasEditor({ pageId, authSession, pages, pagesById, readOnly, onOpenPage, onCreatePage, onRename, renderPageEditor }: CanvasEditorProps) {
  const { doc, canvas, status } = useCanvasDocument(pageId, authSession);
  const flow = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  // 카드 안에서 편집 중인 페이지 카드 (한 번에 하나만: 편집기는 무거워서)
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const self = pagesById.get(pageId);
  const [title, setTitle] = useState(self?.title ?? "");
  useEffect(() => setTitle(self?.title ?? ""), [self?.title]);

  const pageCardIds = useMemo(() => canvas.nodes.filter((n) => n.type === "page" && n.pageId).map((n) => n.pageId!), [canvas.nodes]);
  const previews = usePagePreviews(pageCardIds, pages);

  const livePageIds = useMemo(() => new Set(pages.map((p) => p.id)), [pages]);
  const targetParentId = resolveNewPageParent(canvas.settings, self?.parentId ?? null, livePageIds);
  // 새 페이지 위치로 고를 수 있는 곳 (캔버스 아래에는 페이지를 둘 수 없다)
  const parentOptions = useMemo(() => {
    const depthOf = (page: PageItem) => {
      let depth = 0;
      let cursor = page.parentId ? pagesById.get(page.parentId) : undefined;
      while (cursor && depth < 8) {
        depth += 1;
        cursor = cursor.parentId ? pagesById.get(cursor.parentId) : undefined;
      }
      return depth;
    };
    return pages.filter((p) => p.kind !== "canvas").map((p) => ({ id: p.id, label: `${"  ".repeat(depthOf(p))}${p.icon ? `${p.icon} ` : ""}${p.title || "제목 없는 문서"}` }));
  }, [pages, pagesById]);

  const update = useCallback((id: string, patch: Partial<CanvasNode>) => upsertCanvasNode(doc, id, patch), [doc]);

  const centerPosition = (offset = 0) => {
    const rect = wrapperRef.current?.getBoundingClientRect();
    const point = flow.screenToFlowPosition({ x: (rect?.left ?? 0) + (rect?.width ?? 800) / 2, y: (rect?.top ?? 0) + (rect?.height ?? 600) / 2 });
    return { x: point.x - 120 + offset, y: point.y - 70 + offset };
  };

  /**
   * 화면 가운데에서 시작해 다른 카드와 겹치지 않는 자리를 찾는다 (오른쪽 → 아래 → 왼쪽 → 위 순으로 한 칸씩).
   * 그룹은 카드 뒤에 깔리는 영역이라 겹쳐도 된다.
   */
  const freePosition = (type: CanvasNode["type"]) => {
    const start = centerPosition();
    const size = DEFAULT_SIZE[type];
    const gap = 40;
    const occupied = canvas.nodes.filter((node) => node.type !== "group");
    const overlaps = (x: number, y: number) =>
      occupied.some((node) => x < node.x + node.width + gap / 2 && x + size.width + gap / 2 > node.x && y < node.y + node.height + gap / 2 && y + size.height + gap / 2 > node.y);
    if (!overlaps(start.x, start.y)) return start;
    const stepX = size.width + gap;
    const stepY = size.height + gap;
    for (let ring = 1; ring <= 6; ring += 1) {
      const candidates = [
        [ring, 0], [0, ring], [-ring, 0], [0, -ring],
        [ring, ring], [-ring, ring], [ring, -ring], [-ring, -ring],
      ];
      for (const [dx, dy] of candidates) {
        const x = start.x + dx * stepX;
        const y = start.y + dy * stepY;
        if (!overlaps(x, y)) return { x, y };
      }
    }
    return start;
  };

  const addCard = (card: Omit<CanvasNode, "id" | "width" | "height"> & Partial<Pick<CanvasNode, "width" | "height">>) => {
    const id = newId();
    const size = DEFAULT_SIZE[card.type];
    upsertCanvasNode(doc, id, { width: size.width, height: size.height, ...card });
    setSelected(new Set([id]));
    return id;
  };

  const addPageCard = (pageIdToAdd: string, position = freePosition("page")) => {
    if (pageIdToAdd === pageId) return setMessage("캔버스 자신은 카드로 올릴 수 없습니다.");
    addCard({ type: "page", pageId: pageIdToAdd, ...position });
  };

  const createPageCard = async () => {
    const position = freePosition("page");
    const id = await onCreatePage(targetParentId, "제목 없는 문서");
    if (id) addCard({ type: "page", pageId: id, ...position });
  };

  const convertToPage = async (card: CanvasNode) => {
    const text = (card.text ?? "").trim();
    const [firstLine, ...rest] = text.split("\n");
    const id = await onCreatePage(targetParentId, firstLine?.trim() || "제목 없는 문서", rest.join("\n").trim() || undefined);
    if (!id) return;
    upsertCanvasNode(doc, card.id, { type: "page", pageId: id, text: undefined, height: Math.max(card.height, DEFAULT_SIZE.page.height) });
  };

  const pageIdByTitle = useMemo(() => {
    const map = new Map<string, string>();
    for (const page of pages) {
      const key = (page.title || "").trim().toLowerCase();
      if (key && !map.has(key)) map.set(key, page.id);
    }
    return map;
  }, [pages]);

  const startEditing = (card: CanvasNode) => {
    // 편집하기 좋은 크기로 키운다 (이미 크면 그대로)
    if (card.width < 420 || card.height < 320) {
      upsertCanvasNode(doc, card.id, { width: Math.max(card.width, 420), height: Math.max(card.height, 320) });
    }
    setSelected(new Set([card.id]));
    setEditingCardId(card.id);
  };

  const extra = {
    readOnly,
    onOpenPage,
    onUpdate: update,
    onConvertToPage: (card: CanvasNode) => void convertToPage(card),
    editingCardId,
    onStartEditing: startEditing,
    renderPageEditor,
    resolvePageByTitle: (title: string) => pageIdByTitle.get(title.trim().toLowerCase()),
  };
  const nodes = useMemo(
    () => toFlowNodes(canvas, extra, previews, pagesById, selected),
    [canvas, previews, pagesById, selected, readOnly, editingCardId, pageIdByTitle, renderPageEditor],
  );
  // 편집 중인 카드가 선택에서 빠지거나 지워지면 편집을 끝낸다
  useEffect(() => {
    if (editingCardId && (!selected.has(editingCardId) || !canvas.nodes.some((n) => n.id === editingCardId))) setEditingCardId(null);
  }, [selected, canvas.nodes, editingCardId]);
  useEffect(() => {
    if (!editingCardId) return;
    // 편집기(BlockNote)가 Esc 를 먼저 써 버리므로 캡처 단계에서 받는다. 슬래시 메뉴 등 편집기 메뉴가 열려 있으면 그 메뉴를 닫게 둔다.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || document.querySelector(".bn-suggestion-menu, .bn-grid-suggestion-menu")) return;
      setEditingCardId(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [editingCardId]);
  const edges = useMemo(() => toFlowEdges(canvas, selected), [canvas, selected]);

  // 그룹을 끌기 시작할 때 그 안에 완전히 들어 있던 카드 (끄는 동안 지나치는 카드는 따라오지 않게 시작할 때 정한다)
  const groupCargoRef = useRef<Set<string>>(new Set());
  const onNodeDragStart = (_event: unknown, _node: Node, dragged: Node[]) => {
    const groupIds = new Set(dragged.filter((n) => n.type === "group").map((n) => n.id));
    const cargo = cardsInsideGroups(canvas.nodes, groupIds);
    // 함께 선택돼 이미 같이 끌리는 카드는 빼야 두 번 움직이지 않는다
    for (const n of dragged) cargo.delete(n.id);
    groupCargoRef.current = cargo;
  };
  const onNodeDragStop = () => {
    groupCargoRef.current = new Set();
  };

  const onNodesChange = (changes: NodeChange<Node<CardData>>[]) => {
    const nextSelected = new Set(selected);
    let selectionChanged = false;
    const byId = new Map(canvas.nodes.map((n) => [n.id, n]));
    doc.transact(() => {
      for (const change of changes) {
        if (change.type === "position" && change.position && !readOnly) {
          const x = Math.round(change.position.x);
          const y = Math.round(change.position.y);
          const before = byId.get(change.id);
          if (before?.type === "group" && groupCargoRef.current.size > 0 && (x !== before.x || y !== before.y)) {
            const dx = x - before.x;
            const dy = y - before.y;
            const inside = cardsInsideGroups(canvas.nodes, new Set([change.id]));
            for (const id of groupCargoRef.current) {
              const card = byId.get(id);
              if (card && inside.has(id)) upsertCanvasNode(doc, id, { x: card.x + dx, y: card.y + dy });
            }
          }
          upsertCanvasNode(doc, change.id, { x, y });
        } else if (change.type === "select") {
          selectionChanged = true;
          if (change.selected) nextSelected.add(change.id);
          else nextSelected.delete(change.id);
        }
      }
    });
    const removed = changes.filter((c) => c.type === "remove").map((c) => c.id);
    if (removed.length && !readOnly) removeCanvasNodes(doc, removed);
    if (selectionChanged) setSelected(nextSelected);
  };

  const onEdgesChange = (changes: EdgeChange[]) => {
    const nextSelected = new Set(selected);
    let selectionChanged = false;
    for (const change of changes) {
      if (change.type === "select") {
        selectionChanged = true;
        if (change.selected) nextSelected.add(change.id);
        else nextSelected.delete(change.id);
      }
    }
    const removed = changes.filter((c) => c.type === "remove").map((c) => c.id);
    if (removed.length && !readOnly) removeCanvasEdges(doc, removed);
    if (selectionChanged) setSelected(nextSelected);
  };

  const onConnect = (connection: Connection) => {
    if (readOnly || !connection.source || !connection.target || connection.source === connection.target) return;
    upsertCanvasEdge(doc, newId(), {
      fromNode: connection.source,
      toNode: connection.target,
      fromSide: (connection.sourceHandle as CanvasSide) || "right",
      toSide: (connection.targetHandle as CanvasSide) || "left",
    });
  };

  const renameEdge = (edge: CanvasEdge) => {
    if (readOnly) return;
    const label = window.prompt("연결선 이름 (비우면 없앰)", edge.label ?? "");
    if (label !== null) upsertCanvasEdge(doc, edge.id, { label: label.trim() || undefined });
  };

  // 선택 도구 모음: 고른 카드·선에 한꺼번에 적용한다
  const selectedCards = canvas.nodes.filter((n) => selected.has(n.id));
  const selectedEdges = canvas.edges.filter((e) => selected.has(e.id));
  const sharedValue = <T,>(values: T[]) => (values.length > 0 && values.every((v) => v === values[0]) ? values[0] : undefined);
  const setCardsColor = (color: string | undefined) =>
    doc.transact(() => selectedCards.forEach((card) => upsertCanvasNode(doc, card.id, { color })));
  const setEdgesPatch = (patch: Partial<CanvasEdge>) =>
    doc.transact(() => selectedEdges.forEach((edge) => upsertCanvasEdge(doc, edge.id, patch)));

  /** 연결선을 빈 곳에 놓으면 그 자리에 메모를 만들고 잇는다 */
  const onConnectEnd = (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    if (readOnly || state.isValid || !state.fromNode) return;
    const target = event.target as HTMLElement | null;
    if (!target?.classList.contains("react-flow__pane")) return;
    const point = "changedTouches" in event ? event.changedTouches[0] : event;
    const p = flow.screenToFlowPosition({ x: point.clientX, y: point.clientY });
    const fromSide = (state.fromHandle?.id as CanvasSide) || "right";
    const toSide = OPPOSITE_SIDE[fromSide];
    const { width, height } = DEFAULT_SIZE.text;
    // 새 메모의 연결 쪽 가운데가 놓은 자리에 오게
    const x = toSide === "left" ? p.x : toSide === "right" ? p.x - width : p.x - width / 2;
    const y = toSide === "top" ? p.y : toSide === "bottom" ? p.y - height : p.y - height / 2;
    doc.transact(() => {
      const id = addCard({ type: "text", text: "", x: Math.round(x), y: Math.round(y) });
      upsertCanvasEdge(doc, newId(), { fromNode: state.fromNode!.id, toNode: id, fromSide, toSide });
    });
  };

  const onPaneDoubleClick = (event: ReactMouseEvent) => {
    if (readOnly) return;
    const target = event.target as HTMLElement;
    if (!target.classList.contains("react-flow__pane")) return;
    const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    addCard({ type: "text", text: "", x: point.x - 110, y: point.y - 60 });
  };

  const uploadImage = async (file: File, position: { x: number; y: number }) => {
    try {
      const saved = await workspaceApi.saveAttachment({ name: file.name || "image.png", type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) });
      addCard({ type: "image", url: saved.url, ...position });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "이미지를 올리지 못했습니다.");
    }
  };

  // 붙여 넣기: 이미지 → 이미지 카드, 주소 → 링크 카드, 그 밖의 글 → 메모
  useEffect(() => {
    if (readOnly) return;
    const onPaste = (event: ClipboardEvent) => {
      const active = document.activeElement as HTMLElement | null;
      if (!wrapperRef.current?.contains(active) && active !== document.body) return;
      if (active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT" || active.isContentEditable)) return;
      const file = [...(event.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
      if (file) {
        event.preventDefault();
        void uploadImage(file, freePosition("image"));
        return;
      }
      const text = event.clipboardData?.getData("text/plain")?.trim();
      if (!text) return;
      event.preventDefault();
      if (/^https?:\/\/\S+$/i.test(text)) addCard({ type: "link", url: text, ...freePosition("link") });
      else addCard({ type: "text", text, ...freePosition("text") });
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });

  // 사이드바의 페이지나 이미지 파일을 끌어다 놓기
  const onDragOver = (event: DragEvent) => {
    if (readOnly) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const onDrop = (event: DragEvent) => {
    if (readOnly) return;
    event.preventDefault();
    const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const dropped = event.dataTransfer.getData("application/x-noty-page") || event.dataTransfer.getData("text/plain");
    if (dropped && pagesById.has(dropped)) {
      addPageCard(dropped, { x: position.x - 130, y: position.y - 75 });
      return;
    }
    const image = [...event.dataTransfer.files].find((f) => f.type.startsWith("image/"));
    if (image) void uploadImage(image, position);
  };

  const pickerResults = useMemo(() => {
    const needle = pickerQuery.trim().toLowerCase();
    return pages
      .filter((p) => p.id !== pageId && (!needle || (p.title || "").toLowerCase().includes(needle)))
      .slice(0, 30);
  }, [pages, pickerQuery, pageId]);

  return (
    <div className="canvas-pane" ref={wrapperRef} onDoubleClick={onPaneDoubleClick} onDragOver={onDragOver} onDrop={onDrop}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        onPaneClick={() => setEditingCardId(null)}
        onEdgeDoubleClick={(_event, edge) => {
          const target = canvas.edges.find((e) => e.id === edge.id);
          if (target) renameEdge(target);
        }}
        connectionMode={ConnectionMode.Loose}
        // 선택한 카드를 위로 올리지 않는다: 그룹을 선택해도 안의 카드를 계속 누를 수 있게
        elevateNodesOnSelect={false}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
        zoomOnDoubleClick={false}
        minZoom={0.1}
        maxZoom={3}
        fitView
        fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} size={1} />
        {!readOnly && selectedCards.length > 0 && !editingCardId && (
          <NodeToolbar nodeId={selectedCards.map((c) => c.id)} isVisible position={Position.Top} offset={12} className="canvas-selection-toolbar">
            <ColorSwatches value={sharedValue(selectedCards.map((c) => c.color))} onChange={setCardsColor} />
            {selectedCards.length === 1 && selectedCards[0].type === "text" && (
              <button type="button" className="canvas-toolbar-btn" onClick={() => void convertToPage(selectedCards[0])}>
                페이지로 만들기
              </button>
            )}
            <button
              type="button"
              className="canvas-toolbar-btn canvas-toolbar-btn--danger"
              title="카드 지우기 (페이지는 지워지지 않습니다)"
              onClick={() => removeCanvasNodes(doc, selectedCards.map((c) => c.id))}
            >
              지우기
            </button>
          </NodeToolbar>
        )}
        {!readOnly && selectedEdges.length > 0 && (
          <Panel position="bottom-center" className="canvas-selection-toolbar canvas-edge-toolbar">
            <span className="canvas-edge-toolbar__label">연결선</span>
            <ColorSwatches value={sharedValue(selectedEdges.map((e) => e.color))} onChange={(color) => setEdgesPatch({ color })} />
            <div className="canvas-segmented" role="group" aria-label="화살표">
              {(
                [
                  ["none", "─", "화살표 없음"],
                  ["forward", "→", "한쪽 화살표"],
                  ["both", "↔", "양쪽 화살표"],
                ] as const
              ).map(([direction, symbol, label]) => {
                const active = sharedValue(selectedEdges.map(edgeDirection)) === direction;
                return (
                  <button
                    key={direction}
                    type="button"
                    className={`canvas-segmented__btn ${active ? "canvas-segmented__btn--active" : ""}`}
                    aria-label={label}
                    aria-pressed={active}
                    title={label}
                    onClick={() => setEdgesPatch(DIRECTION_ENDS[direction])}
                  >
                    {symbol}
                  </button>
                );
              })}
            </div>
            {selectedEdges.length === 1 && (
              <button type="button" className="canvas-toolbar-btn" onClick={() => renameEdge(selectedEdges[0])}>
                이름
              </button>
            )}
            <button type="button" className="canvas-toolbar-btn canvas-toolbar-btn--danger" onClick={() => removeCanvasEdges(doc, selectedEdges.map((e) => e.id))}>
              지우기
            </button>
          </Panel>
        )}
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable className="canvas-minimap" />
        <Panel position="top-left" className="canvas-toolbar">
          <input
            className="canvas-toolbar__title"
            value={title}
            disabled={readOnly}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => title.trim() && title !== self?.title && onRename(title.trim())}
            onKeyDown={(event) => event.key === "Enter" && (event.target as HTMLInputElement).blur()}
            aria-label="캔버스 이름"
          />
          {status !== "synced" && <span className="canvas-toolbar__status">{status === "error" ? "연결 실패" : "연결 중…"}</span>}
          {!readOnly && (
            <>
              <button type="button" className="canvas-toolbar-btn" onClick={() => void createPageCard()}>
                + 새 페이지
              </button>
              <button type="button" className="canvas-toolbar-btn" onClick={() => setPickerOpen((v) => !v)}>
                + 기존 페이지
              </button>
              <button type="button" className="canvas-toolbar-btn" onClick={() => addCard({ type: "text", text: "", ...freePosition("text") })}>
                + 메모
              </button>
              <button type="button" className="canvas-toolbar-btn" onClick={() => addCard({ type: "group", label: "그룹", ...centerPosition(-120) })}>
                + 그룹
              </button>
              <label className="canvas-toolbar__location" title="캔버스에서 새로 만드는 페이지가 들어갈 곳">
                새 페이지 위치
                <select
                  value={!("newPageParentId" in canvas.settings) ? "__same__" : canvas.settings.newPageParentId ? canvas.settings.newPageParentId : "__root__"}
                  onChange={(event) => {
                    const value = event.target.value;
                    setCanvasNewPageParent(doc, value === "__same__" ? undefined : value === "__root__" ? null : value);
                  }}
                >
                  <option value="__same__">캔버스와 같은 위치</option>
                  <option value="__root__">맨 위 (루트)</option>
                  {parentOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
        </Panel>
        {pickerOpen && (
          <Panel position="top-left" className="canvas-picker">
            <input autoFocus value={pickerQuery} onChange={(event) => setPickerQuery(event.target.value)} placeholder="페이지 이름 검색" />
            <ul>
              {pickerResults.map((page) => (
                <li key={page.id}>
                  <button
                    type="button"
                    onClick={() => {
                      addPageCard(page.id);
                      setPickerOpen(false);
                      setPickerQuery("");
                    }}
                  >
                    {page.icon ? `${page.icon} ` : page.kind === "canvas" ? "🎨 " : "📄 "}
                    {page.title || "제목 없는 문서"}
                  </button>
                </li>
              ))}
              {pickerResults.length === 0 && <li className="canvas-picker__empty">맞는 페이지가 없습니다.</li>}
            </ul>
          </Panel>
        )}
        {message && (
          <Panel position="bottom-center" className="canvas-message" onClick={() => setMessage(null)}>
            {message}
          </Panel>
        )}
        {canvas.nodes.length === 0 && status === "synced" && (
          <Panel position="top-center" className="canvas-empty-hint">
            {readOnly
              ? "빈 캔버스입니다."
              : "빈 곳을 더블클릭해 메모를 만들거나, 사이드바의 페이지를 끌어다 놓으세요. 카드 가장자리를 끌어 다른 카드나 빈 곳에 놓으면 선으로 이어집니다."}
          </Panel>
        )}
      </ReactFlow>
    </div>
  );
}

export function CanvasPane(props: CanvasEditorProps) {
  return (
    <ReactFlowProvider>
      <CanvasEditor {...props} />
    </ReactFlowProvider>
  );
}

/** 페이지 본문 안의 캔버스 미리보기 (보기 전용). 누르면 캔버스를 연다. */
export function CanvasPreview({ pageId, pagesById, onOpen }: { pageId: string; pagesById: Map<string, PageItem>; onOpen: () => void }) {
  const [canvas, setCanvas] = useState<CanvasData | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      workspaceApi
        .getCanvas(pageId)
        .then((res) => !cancelled && setCanvas(res.canvas))
        .catch(() => !cancelled && setFailed(true));
    void load();
    window.addEventListener("focus", load);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", load);
    };
  }, [pageId]);
  const pageCardIds = useMemo(() => (canvas?.nodes ?? []).filter((n) => n.type === "page" && n.pageId).map((n) => n.pageId!), [canvas]);
  const previews = usePagePreviews(pageCardIds, canvas);
  const extra = { readOnly: true, compact: true, onOpenPage: () => undefined, onUpdate: () => undefined, onConvertToPage: () => undefined };
  const nodes = useMemo(() => (canvas ? toFlowNodes(canvas, extra, previews, pagesById, new Set()) : []), [canvas, previews, pagesById]);
  const edges = useMemo(() => (canvas ? toFlowEdges(canvas, new Set()) : []), [canvas]);
  const title = pagesById.get(pageId)?.title || "제목 없는 캔버스";
  return (
    <div className="canvas-preview" contentEditable={false} onClick={onOpen} role="button" title="캔버스 열기">
      <div className="canvas-preview__header">
        <span>🎨 {title}</span>
        <span className="canvas-preview__open">열기 →</span>
      </div>
      <div className="canvas-preview__body">
        {failed ? (
          <span className="canvas-preview__empty">캔버스를 불러오지 못했습니다.</span>
        ) : canvas && canvas.nodes.length === 0 ? (
          <span className="canvas-preview__empty">빈 캔버스 — 눌러서 열기</span>
        ) : canvas ? (
          <ReactFlowProvider>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={NODE_TYPES}
              fitView
              fitViewOptions={{ padding: 0.15 }}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
              panOnDrag={false}
              zoomOnScroll={false}
              zoomOnPinch={false}
              zoomOnDoubleClick={false}
              preventScrolling={false}
              proOptions={{ hideAttribution: true }}
            />
          </ReactFlowProvider>
        ) : (
          <span className="canvas-preview__empty">불러오는 중…</span>
        )}
      </div>
    </div>
  );
}
