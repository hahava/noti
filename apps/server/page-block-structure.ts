import { randomUUID } from "node:crypto";

function filterOutInlinePageLinks(content: unknown, targetPageIds: ReadonlySet<string>): unknown {
  if (!Array.isArray(content)) return content;
  return content
    .filter((item) => {
      if (!item || typeof item !== "object") return true;
      const inline = item as Record<string, unknown>;
      if (inline.type === "pageLink" && inline.props && typeof inline.props === "object") {
        const pageId = (inline.props as Record<string, unknown>).pageId;
        if (typeof pageId === "string" && targetPageIds.has(pageId)) return false;
      }
      return true;
    })
    .map((item) => {
      if (!item || typeof item !== "object") return item;
      const inline = item as Record<string, unknown>;
      return Array.isArray(inline.content)
        ? { ...inline, content: filterOutInlinePageLinks(inline.content, targetPageIds) }
        : item;
    });
}

/** 삭제된 페이지 참조만 제거한다. 빈 문단은 문서 루트나 빈 column에만 필요하다. */
export function removePageBlocksFromTree(
  blocks: readonly unknown[],
  targetPageIds: ReadonlySet<string>,
): unknown[] {
  const prune = (items: readonly unknown[], isRoot: boolean): unknown[] => {
    const result: unknown[] = [];
    for (const value of items) {
      if (!value || typeof value !== "object") {
        result.push(value);
        continue;
      }
      const block = value as Record<string, unknown>;
      if (block.type === "page" && block.props && typeof block.props === "object") {
        const pageId = (block.props as Record<string, unknown>).pageId;
        if (typeof pageId === "string" && targetPageIds.has(pageId)) continue;
      }

      let children = Array.isArray(block.children) ? prune(block.children, false) : undefined;
      if (block.type === "column" && children?.length === 0) {
        children = [{ id: randomUUID(), type: "paragraph", content: [], children: [] }];
      }
      result.push({
        ...block,
        ...(block.content !== undefined
          ? { content: filterOutInlinePageLinks(block.content, targetPageIds) }
          : {}),
        ...(children !== undefined ? { children } : {}),
      });
    }
    if (isRoot && result.length === 0) {
      result.push({ id: randomUUID(), type: "paragraph", content: [], children: [] });
    }
    return result;
  };
  return prune(blocks, true);
}

/**
 * 부모 문서 본문(blocks) 안의 `page` 블록 구조를 사이드바 계층(parent_id + sort_order)과 일치시킨다.
 *
 * - 현재 자식이 아닌 페이지를 가리키는 `page` 블록과 중복 블록은 제거한다.
 * - 본문에 없는 자식 페이지는 문서 맨 끝에 `page` 블록으로 추가한다.
 * - `reorder` 가 true 이면 기존 `page` 블록이 차지하던 자리(slot)는 유지한 채,
 *   각 자리에 들어갈 자식 페이지를 sort_order 순서대로 다시 배치한다.
 *   (다단 레이아웃 등 블록 위치는 건드리지 않고 순서만 맞춘다.)
 */
export function reconcileChildPageBlocks(
  blocks: readonly unknown[],
  orderedChildIds: readonly string[],
  options: { reorder: boolean },
): { blocks: unknown[]; changed: boolean } {
  const childSet = new Set(orderedChildIds);
  const seen = new Set<string>();
  const pageBlockById = new Map<string, Record<string, unknown>>();

  const getPageId = (block: Record<string, unknown>): string | null => {
    if (block.type !== "page" || !block.props || typeof block.props !== "object") return null;
    const pageId = (block.props as Record<string, unknown>).pageId;
    return typeof pageId === "string" ? pageId : null;
  };

  // 1) 자식이 아니거나 중복된 page 블록 제거
  const prune = (items: readonly unknown[], isTopLevel: boolean): unknown[] => {
    const result: unknown[] = [];
    for (const value of items) {
      if (!value || typeof value !== "object") {
        result.push(value);
        continue;
      }
      const block = value as Record<string, unknown>;
      const pageId = getPageId(block);
      if (block.type === "page") {
        if (!pageId || !childSet.has(pageId) || seen.has(pageId)) continue;
        seen.add(pageId);
        pageBlockById.set(pageId, block);
        result.push(block);
        continue;
      }

      if (Array.isArray(block.children)) {
        let nextChildren = prune(block.children, false);
        // 다단(column) 내부가 모두 비면 스키마 오류 방지를 위해 빈 문단 하나를 유지
        if (block.type === "column" && nextChildren.length === 0) {
          nextChildren = [{ id: randomUUID(), type: "paragraph", content: [], children: [] }];
        }
        result.push({ ...block, children: nextChildren });
      } else {
        result.push(block);
      }
    }
    if (isTopLevel && result.length === 0) {
      result.push({ id: randomUUID(), type: "paragraph", content: [], children: [] });
    }
    return result;
  };

  let nextBlocks = prune(blocks, true);

  const isEmptyParagraph = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false;
    const block = value as Record<string, unknown>;
    if (block.type !== "paragraph") return false;
    return (
      block.content === "" ||
      block.content === undefined ||
      (Array.isArray(block.content) && block.content.length === 0)
    );
  };

  // 2) 본문에 없는 자식 페이지를 마지막 빈 문단 앞에 추가한다.
  // BlockNote 문서에는 보통 입력용 빈 문단이 마지막에 있으므로, 그 뒤에
  // page 블록을 붙이면 부모 본문과 하위 페이지 사이에 불필요한 줄이 생긴다.
  const missing = orderedChildIds.filter((childId) => !seen.has(childId));
  if (missing.length > 0) {
    const appended = missing.map((childId) => {
      const block = {
        id: randomUUID(),
        type: "page",
        props: { pageId: childId },
        content: [],
        children: [],
      };
      pageBlockById.set(childId, block);
      return block;
    });
    const insertionIndex =
      nextBlocks.length > 0 && isEmptyParagraph(nextBlocks[nextBlocks.length - 1])
        ? nextBlocks.length - 1
        : nextBlocks.length;
    nextBlocks = [
      ...nextBlocks.slice(0, insertionIndex),
      ...appended,
      ...nextBlocks.slice(insertionIndex),
    ];
  }

  // 3) page 블록 자리는 유지하고, 자리별 자식 페이지를 sort_order 순으로 재배치
  if (options.reorder) {
    let slotIndex = 0;
    const assign = (items: unknown[]): unknown[] =>
      items.map((value) => {
        if (!value || typeof value !== "object") return value;
        const block = value as Record<string, unknown>;
        if (block.type === "page") {
          const desiredId = orderedChildIds[slotIndex];
          slotIndex += 1;
          return (desiredId && pageBlockById.get(desiredId)) || block;
        }
        if (Array.isArray(block.children)) {
          return { ...block, children: assign(block.children) };
        }
        return block;
      });
    nextBlocks = assign(nextBlocks);
  }

  return {
    blocks: nextBlocks,
    changed: JSON.stringify(nextBlocks) !== JSON.stringify(blocks),
  };
}

/** 본문에 등장하는 `page` 블록의 pageId 를 문서 순서대로(중복 제외) 반환한다. */
export function extractPageBlockIdsInOrder(blocks: readonly unknown[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const visit = (items: readonly unknown[]) => {
    for (const value of items) {
      if (!value || typeof value !== "object") continue;
      const block = value as Record<string, unknown>;
      if (block.type === "page" && block.props && typeof block.props === "object") {
        const pageId = (block.props as Record<string, unknown>).pageId;
        if (typeof pageId === "string" && !seen.has(pageId)) {
          seen.add(pageId);
          ids.push(pageId);
        }
      }
      if (Array.isArray(block.children)) visit(block.children);
    }
  };
  visit(blocks);
  return ids;
}
