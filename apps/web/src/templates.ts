/** 페이지 템플릿 = 사용자가 저장한 페이지. 서버(/api/templates)에 계정별로 저장된다. */
export interface PageTemplate {
  id: string;
  name: string;
  icon: string;
  category: string;
  description: string;
  /** BlockNote 블록 (id 없이) — 제목 블록 아래에 들어간다 */
  blocks: unknown[];
}

export const USER_TEMPLATE_CATEGORY = "내 템플릿";
const LEGACY_USER_TEMPLATES_KEY = "noty.userTemplates";

/**
 * 서버 저장 이전에 이 브라우저(localStorage)에 저장해 둔 내 템플릿을 꺼내고 지운다.
 * 로그인 후 한 번 서버로 옮기는 데만 쓴다.
 */
export function takeLegacyUserTemplates(): PageTemplate[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(LEGACY_USER_TEMPLATES_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((t) => t && typeof t.name === "string" && Array.isArray(t.blocks)) : [];
  } catch {
    return [];
  }
}

export function clearLegacyUserTemplates(): void {
  try {
    window.localStorage.removeItem(LEGACY_USER_TEMPLATES_KEY);
  } catch {
    // 지울 수 없으면 다음 로그인 때 다시 옮기기를 시도한다 (같은 이름으로 중복될 수 있음)
  }
}

// 템플릿에 넣지 않는 블록: 하위 페이지·캔버스는 원본 페이지를 가리키므로 복사하면 같은 페이지로 연결된다.
const LINKED_BLOCK_TYPES = new Set(["page", "canvas"]);

/**
 * 데이터베이스 블록 → 원본과 연결되지 않은 새 데이터베이스 양식.
 * 데이터베이스 id 를 빼 두면 템플릿을 쓸 때 블록이 새 데이터베이스를 만든다 (기존 "새 데이터베이스" 흐름).
 * 속성·수식·보기 탭은 그대로, structureOnly 면 행(기록)은 비운다.
 * latest: 서버에서 받은 최신 구성 (블록 안의 dataJson 은 처음 만들 때의 값이라 오래됐을 수 있다)
 */
export function unlinkedCollectionDataJson(dataJson: unknown, keepRows: boolean, latest: ReadonlyMap<string, unknown> = new Map()): string {
  let data: any = {};
  try {
    data = JSON.parse(typeof dataJson === "string" ? dataJson : "{}");
  } catch {
    // 깨진 값이면 빈 데이터베이스로 만든다
  }
  const fresh = typeof data.collectionId === "string" ? latest.get(data.collectionId) : undefined;
  const { collectionId: _collectionId, pendingLink: _pendingLink, ...rest } = { ...data, ...(fresh as object) };
  return JSON.stringify({ ...rest, rows: keepRows ? rest.rows ?? [] : [] });
}

function collectionTemplateBlock(block: any, structureOnly: boolean, latest: ReadonlyMap<string, unknown>): any {
  return { ...block, type: "collection", props: { ...block.props, dataJson: unlinkedCollectionDataJson(block.props?.dataJson, !structureOnly, latest) } };
}

/** 페이지 본문에 있는 데이터베이스 id (템플릿 저장 전에 최신 구성을 받아 오려고) */
export function templateCollectionIds(blocks: readonly unknown[]): string[] {
  const ids = new Set<string>();
  const walk = (list: readonly any[]) => {
    for (const block of list) {
      if (block?.type === "collection" || block?.type === "linkedCollection") {
        try {
          const id = JSON.parse(block.props?.dataJson ?? "{}").collectionId;
          if (typeof id === "string") ids.add(id);
        } catch {
          // 무시
        }
      }
      if (Array.isArray(block?.children)) walk(block.children);
    }
  };
  walk(blocks);
  return [...ids];
}

/**
 * 페이지 본문 → 템플릿 블록.
 * 제목(첫 블록)은 빼고, 블록 id 는 지워서 적용할 때 새로 매기게 한다.
 * structureOnly 면 제목(heading)과 굵은 글씨 라벨만 남기고 본문 글은 비운다.
 */
export function pageBlocksToTemplate(
  blocks: readonly unknown[],
  structureOnly: boolean,
  latestCollections: ReadonlyMap<string, unknown> = new Map(),
): unknown[] {
  const convert = (list: readonly any[]): any[] =>
    list
      .filter((block) => block && typeof block === "object" && !LINKED_BLOCK_TYPES.has(block.type))
      .map(({ id: _id, children, ...block }) => {
        if (block.type === "collection" || block.type === "linkedCollection") {
          return collectionTemplateBlock(block, structureOnly, latestCollections);
        }
        const next: any = { ...block };
        if (structureOnly && block.type !== "heading" && Array.isArray(block.content)) {
          next.content = block.content.filter((item: any) => item?.styles?.bold);
          if (block.type === "checkListItem") next.props = { ...block.props, checked: false };
        }
        if (Array.isArray(children) && children.length > 0) next.children = convert(children);
        return next;
      });
  return convert(blocks.slice(1));
}
