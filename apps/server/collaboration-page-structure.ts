import { randomUUID } from "node:crypto";
import * as Y from "yjs";

export const PAGE_STRUCTURE_CHANGED_CHANNEL = "noty_page_structure_changed";

type XmlChildren = Y.XmlFragment | Y.XmlElement;

function visitElements(parent: XmlChildren, visit: (element: Y.XmlElement) => void): void {
  for (const child of parent.toArray()) {
    if (!(child instanceof Y.XmlElement)) continue;
    visit(child);
    visitElements(child, visit);
  }
}

/** 협업 문서가 참조하는 페이지 ID를 DB 계층과 대조할 때 사용한다. */
export function collectYjsPageReferences(fragment: Y.XmlFragment): string[] {
  const ids = new Set<string>();
  visitElements(fragment, (element) => {
    if (element.nodeName !== "page" && element.nodeName !== "pageLink") return;
    const pageId = element.getAttribute("pageId");
    if (typeof pageId === "string" && pageId) ids.add(pageId);
  });
  return Array.from(ids);
}

/** 죽은 페이지 블록/멘션만 Yjs 문서 안에서 제거한다. 주변 텍스트 노드는 유지한다. */
export function pruneYjsPageReferences(
  fragment: Y.XmlFragment,
  parentPageId: string,
  survivingPageParents: ReadonlyMap<string, string | null>,
): boolean {
  if (fragment.length === 0) return false;
  let changed = false;

  const prune = (parent: XmlChildren) => {
    for (let index = parent.length - 1; index >= 0; index -= 1) {
      const child = parent.toArray()[index];
      if (!(child instanceof Y.XmlElement)) continue;

      if (child.nodeName === "blockContainer") {
        const pageBlock = child.toArray().find(
          (node): node is Y.XmlElement =>
            node instanceof Y.XmlElement && node.nodeName === "page",
        );
        if (pageBlock) {
          const pageId = pageBlock.getAttribute("pageId");
          if (
            typeof pageId !== "string" ||
            survivingPageParents.get(pageId) !== parentPageId
          ) {
            parent.delete(index, 1);
            changed = true;
            continue;
          }
        }
      }

      if (child.nodeName === "pageLink") {
        const pageId = child.getAttribute("pageId");
        if (typeof pageId !== "string" || !survivingPageParents.has(pageId)) {
          parent.delete(index, 1);
          changed = true;
          continue;
        }
      }

      prune(child);
    }
  };

  fragment.doc?.transact(() => {
    prune(fragment);
    for (const group of fragment.toArray()) {
      if (!(group instanceof Y.XmlElement) || group.nodeName !== "blockGroup") continue;
      if (group.length > 0) continue;
      const container = new Y.XmlElement("blockContainer");
      container.setAttribute("id", randomUUID());
      container.insert(0, [new Y.XmlElement("paragraph")]);
      group.insert(0, [container]);
      changed = true;
    }
  });
  return changed;
}

function allPageBlockIds(fragment: Y.XmlFragment): Set<string> {
  const ids = new Set<string>();
  visitElements(fragment, (element) => {
    if (element.nodeName !== "page") return;
    const pageId = element.getAttribute("pageId");
    if (typeof pageId === "string" && pageId) ids.add(pageId);
  });
  return ids;
}

function isEmptyParagraphContainer(node: unknown): boolean {
  if (!(node instanceof Y.XmlElement) || node.nodeName !== "blockContainer") return false;
  const children = node.toArray();
  if (children.length !== 1) return false;
  const content = children[0];
  return content instanceof Y.XmlElement && content.nodeName === "paragraph" && content.length === 0;
}

/**
 * 사이드바 계층의 하위 페이지 중 본문(Yjs)에 page 블록이 없는 것을 추가하고, 같은 페이지 블록이
 * 두 번 이상 있으면 첫 번째만 남긴다. 클라이언트 보정과 같은 규칙으로, 문서 끝(마지막 빈 문단 앞)에 붙인다.
 * 서버가 열린 협업 문서에 페이지 이동/생성을 바로 반영할 때 사용한다.
 */
export function ensureYjsChildPageBlocks(fragment: Y.XmlFragment, childPageIds: readonly string[]): boolean {
  if (childPageIds.length === 0) return false;
  let changed = false;

  fragment.doc?.transact(() => {
    // 1) 중복 page 블록 제거 (먼저 나온 것을 유지)
    const seen = new Set<string>();
    const dedupe = (parent: XmlChildren) => {
      for (let index = 0; index < parent.length; index += 1) {
        const child = parent.toArray()[index];
        if (!(child instanceof Y.XmlElement)) continue;
        if (child.nodeName === "blockContainer") {
          const pageBlock = child.toArray().find(
            (node): node is Y.XmlElement => node instanceof Y.XmlElement && node.nodeName === "page",
          );
          const pageId = pageBlock?.getAttribute("pageId");
          if (typeof pageId === "string" && pageId) {
            if (seen.has(pageId)) {
              parent.delete(index, 1);
              index -= 1;
              changed = true;
              continue;
            }
            seen.add(pageId);
          }
        }
        dedupe(child);
      }
    };
    dedupe(fragment);

    // 2) 누락된 하위 페이지 블록 추가
    const present = allPageBlockIds(fragment);
    const missing = childPageIds.filter((id) => !present.has(id));
    if (missing.length === 0) return;

    let group = fragment.toArray().find(
      (node): node is Y.XmlElement => node instanceof Y.XmlElement && node.nodeName === "blockGroup",
    );
    if (!group) {
      group = new Y.XmlElement("blockGroup");
      fragment.insert(fragment.length, [group]);
    }
    const containers = missing.map((pageId) => {
      const container = new Y.XmlElement("blockContainer");
      container.setAttribute("id", randomUUID());
      const page = new Y.XmlElement("page");
      page.setAttribute("pageId", pageId);
      container.insert(0, [page]);
      return container;
    });
    const last = group.length > 0 ? group.toArray()[group.length - 1] : null;
    const insertAt = isEmptyParagraphContainer(last) ? group.length - 1 : group.length;
    group.insert(insertAt, containers);
    changed = true;
  });
  return changed;
}
