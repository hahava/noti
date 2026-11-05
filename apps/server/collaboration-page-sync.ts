import type * as Y from "yjs";
import { pool } from "./db.js";
import {
  collectYjsPageReferences,
  ensureYjsChildPageBlocks,
  pruneYjsPageReferences,
} from "./collaboration-page-structure.js";

/**
 * DB 계층을 기준으로 협업(Yjs) 문서의 하위 페이지 블록을 맞춘다.
 *  - 삭제되었거나 다른 부모로 옮겨진 페이지의 블록/멘션 제거
 *  - 이 페이지로 옮겨 오거나 새로 만든 하위 페이지의 블록 추가 (중복 제거 포함)
 * 순서 재배치는 동기화된 클라이언트가 사이드바 순서에 맞춰 처리한다.
 */
export async function syncCollaborationPageReferences(
  document: Y.Doc,
  parentPageId: string,
): Promise<boolean> {
  const fragment = document.getXmlFragment("document-store");
  let changed = false;

  const referencedIds = collectYjsPageReferences(fragment);
  if (referencedIds.length > 0) {
    const result = await pool.query(
      "SELECT id, parent_id FROM pages WHERE id = ANY($1::text[]) AND deleted_at IS NULL",
      [referencedIds],
    );
    const survivingPageParents = new Map<string, string | null>(
      result.rows.map((row) => [String(row.id), row.parent_id ? String(row.parent_id) : null]),
    );
    changed = pruneYjsPageReferences(fragment, parentPageId, survivingPageParents) || changed;
  }

  // 빈 문서는 아직 클라이언트가 DB 본문으로 시드하기 전이므로 건드리지 않는다 (시드 본문에 이미 포함됨).
  if (fragment.length === 0) return changed;
  const children = await pool.query(
    "SELECT id FROM pages WHERE parent_id = $1 AND deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC",
    [parentPageId],
  );
  changed = ensureYjsChildPageBlocks(fragment, children.rows.map((row) => String(row.id))) || changed;
  return changed;
}
