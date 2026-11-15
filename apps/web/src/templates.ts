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

// 템플릿에 넣지 않는 블록: 하위 페이지·데이터베이스는 원본과 연결돼 있어 복사하면 같은 대상을 가리킨다.
const LINKED_BLOCK_TYPES = new Set(["page", "canvas", "collection", "linkedCollection"]);

/**
 * 페이지 본문 → 템플릿 블록.
 * 제목(첫 블록)은 빼고, 블록 id 는 지워서 적용할 때 새로 매기게 한다.
 * structureOnly 면 제목(heading)과 굵은 글씨 라벨만 남기고 본문 글은 비운다.
 */
export function pageBlocksToTemplate(blocks: readonly unknown[], structureOnly: boolean): unknown[] {
  const convert = (list: readonly any[]): any[] =>
    list
      .filter((block) => block && typeof block === "object" && !LINKED_BLOCK_TYPES.has(block.type))
      .map(({ id: _id, children, ...block }) => {
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
