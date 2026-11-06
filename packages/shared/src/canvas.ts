import * as Y from "yjs";

/**
 * 캔버스 데이터 구조 (화면과 서버가 함께 쓴다).
 *
 * 캔버스 문서는 페이지 협업 방(page:<캔버스 id>)의 Yjs 문서에 들어 있고, 여러 사람이 동시에 편집한다.
 *   - canvas-nodes    : 카드 id → Y.Map (카드 하나의 속성)
 *   - canvas-edges    : 연결선 id → Y.Map
 *   - canvas-settings : 캔버스 설정 (새 페이지를 만들 위치 등)
 * 카드·선 단위로 Y.Map 을 쓰므로, 서로 다른 카드를 동시에 옮기거나 고쳐도 충돌 없이 합쳐진다.
 * 필드 이름은 JSON Canvas(https://jsoncanvas.org) 형식을 따른다 (page 카드는 Noty 전용).
 */

export type CanvasNodeType = "page" | "text" | "image" | "link" | "group";
export type CanvasSide = "top" | "right" | "bottom" | "left";

export interface CanvasNode {
  id: string;
  type: CanvasNodeType;
  x: number;
  y: number;
  width: number;
  height: number;
  /** page 카드: 가리키는 페이지 id (페이지 위치와 무관하게 id 로만 연결) */
  pageId?: string;
  /** text 카드 내용 */
  text?: string;
  /** image·link 카드 주소 */
  url?: string;
  /** group 제목 */
  label?: string;
  color?: string;
}

export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: CanvasSide;
  toSide?: CanvasSide;
  label?: string;
}

export interface CanvasSettings {
  /**
   * 캔버스에서 새로 만든 페이지가 들어갈 위치.
   * 없으면(undefined) "캔버스와 같은 위치", null 이면 루트, 문자열이면 그 페이지 아래.
   */
  newPageParentId?: string | null;
}

export interface CanvasData {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  settings: CanvasSettings;
}

export const CANVAS_NODES_KEY = "canvas-nodes";
export const CANVAS_EDGES_KEY = "canvas-edges";
export const CANVAS_SETTINGS_KEY = "canvas-settings";

const NODE_TYPES = new Set<CanvasNodeType>(["page", "text", "image", "link", "group"]);
const SIDES = new Set<CanvasSide>(["top", "right", "bottom", "left"]);

export function canvasMaps(doc: Y.Doc) {
  return {
    nodes: doc.getMap<Y.Map<unknown>>(CANVAS_NODES_KEY),
    edges: doc.getMap<Y.Map<unknown>>(CANVAS_EDGES_KEY),
    settings: doc.getMap<unknown>(CANVAS_SETTINGS_KEY),
  };
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNode(id: string, map: Y.Map<unknown>): CanvasNode | null {
  const type = map.get("type");
  if (typeof type !== "string" || !NODE_TYPES.has(type as CanvasNodeType)) return null;
  return {
    id,
    type: type as CanvasNodeType,
    x: num(map.get("x"), 0),
    y: num(map.get("y"), 0),
    width: num(map.get("width"), 240),
    height: num(map.get("height"), 140),
    pageId: str(map.get("pageId")),
    text: str(map.get("text")),
    url: str(map.get("url")),
    label: str(map.get("label")),
    color: str(map.get("color")),
  };
}

function readEdge(id: string, map: Y.Map<unknown>): CanvasEdge | null {
  const fromNode = str(map.get("fromNode"));
  const toNode = str(map.get("toNode"));
  if (!fromNode || !toNode) return null;
  const fromSide = str(map.get("fromSide"));
  const toSide = str(map.get("toSide"));
  return {
    id,
    fromNode,
    toNode,
    fromSide: fromSide && SIDES.has(fromSide as CanvasSide) ? (fromSide as CanvasSide) : undefined,
    toSide: toSide && SIDES.has(toSide as CanvasSide) ? (toSide as CanvasSide) : undefined,
    label: str(map.get("label")),
  };
}

export function readCanvas(doc: Y.Doc): CanvasData {
  const { nodes, edges, settings } = canvasMaps(doc);
  const nodeList: CanvasNode[] = [];
  nodes.forEach((map, id) => {
    if (!(map instanceof Y.Map)) return;
    const node = readNode(id, map);
    if (node) nodeList.push(node);
  });
  const nodeIds = new Set(nodeList.map((node) => node.id));
  const edgeList: CanvasEdge[] = [];
  edges.forEach((map, id) => {
    if (!(map instanceof Y.Map)) return;
    const edge = readEdge(id, map);
    // 지워진 카드에 매달린 선은 보여 주지 않는다
    if (edge && nodeIds.has(edge.fromNode) && nodeIds.has(edge.toNode)) edgeList.push(edge);
  });
  const parent = settings.get("newPageParentId");
  return {
    nodes: nodeList,
    edges: edgeList,
    settings: settings.has("newPageParentId") ? { newPageParentId: typeof parent === "string" ? parent : null } : {},
  };
}

type Patch<T> = Partial<Omit<T, "id">>;

function applyPatch(map: Y.Map<unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) map.delete(key);
    else if (map.get(key) !== value) map.set(key, value);
  }
}

/** 카드를 만들거나 일부 속성을 고친다. */
export function upsertCanvasNode(doc: Y.Doc, id: string, patch: Patch<CanvasNode>): void {
  const { nodes } = canvasMaps(doc);
  doc.transact(() => {
    let map = nodes.get(id);
    if (!(map instanceof Y.Map)) {
      map = new Y.Map<unknown>();
      nodes.set(id, map);
    }
    applyPatch(map, patch as Record<string, unknown>);
  });
}

/** 카드를 지운다. 그 카드에 연결된 선도 함께 지운다. (페이지 카드를 지워도 페이지는 그대로) */
export function removeCanvasNodes(doc: Y.Doc, ids: readonly string[]): void {
  if (ids.length === 0) return;
  const { nodes, edges } = canvasMaps(doc);
  const removing = new Set(ids);
  doc.transact(() => {
    for (const id of ids) nodes.delete(id);
    edges.forEach((map, edgeId) => {
      if (!(map instanceof Y.Map)) return;
      if (removing.has(String(map.get("fromNode"))) || removing.has(String(map.get("toNode")))) edges.delete(edgeId);
    });
  });
}

export function upsertCanvasEdge(doc: Y.Doc, id: string, patch: Patch<CanvasEdge>): void {
  const { edges } = canvasMaps(doc);
  doc.transact(() => {
    let map = edges.get(id);
    if (!(map instanceof Y.Map)) {
      map = new Y.Map<unknown>();
      edges.set(id, map);
    }
    applyPatch(map, patch as Record<string, unknown>);
  });
}

export function removeCanvasEdges(doc: Y.Doc, ids: readonly string[]): void {
  const { edges } = canvasMaps(doc);
  doc.transact(() => {
    for (const id of ids) edges.delete(id);
  });
}

/** 새 페이지 위치를 정한다. undefined = 캔버스와 같은 위치, null = 루트, 문자열 = 그 페이지 아래 */
export function setCanvasNewPageParent(doc: Y.Doc, parentId: string | null | undefined): void {
  const { settings } = canvasMaps(doc);
  if (parentId === undefined) settings.delete("newPageParentId");
  else settings.set("newPageParentId", parentId ?? "");
}

/**
 * 새 페이지가 실제로 들어갈 상위 페이지 id.
 * @param canvasParentId 캔버스 자신의 상위 페이지 (루트면 null)
 * @param livePageIds 지금 살아 있는 페이지 id. 정해 둔 위치가 지워졌으면 캔버스와 같은 위치로 돌아간다.
 */
export function resolveNewPageParent(settings: CanvasSettings, canvasParentId: string | null, livePageIds: ReadonlySet<string>): string | null {
  if (!("newPageParentId" in settings) || settings.newPageParentId === undefined) return canvasParentId;
  if (!settings.newPageParentId) return null;
  return livePageIds.has(settings.newPageParentId) ? settings.newPageParentId : canvasParentId;
}

/** 캔버스에 카드로 올라간 페이지 id (그래프의 캔버스 → 페이지 링크) */
export function canvasPageIds(data: CanvasData): string[] {
  return [...new Set(data.nodes.filter((node) => node.type === "page" && node.pageId).map((node) => node.pageId!))];
}
