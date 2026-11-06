import { pool } from "./db.js";
import { decodeCanvasState, syncCanvasLinks } from "./graph.js";
import { collectionExists, loadCollectionState, storeCollectionState } from "./collection-db.js";

const PAGE_ROOM_PREFIX = "page:";
const PAGE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function pageIdFromDocumentName(documentName: string): string | null {
  if (!documentName.startsWith(PAGE_ROOM_PREFIX)) return null;
  const pageId = documentName.slice(PAGE_ROOM_PREFIX.length);
  return PAGE_ID_PATTERN.test(pageId) ? pageId : null;
}

export function collectionIdFromDocumentName(documentName: string): string | null {
  if (!documentName.startsWith("collection:")) return null;
  const id = documentName.slice("collection:".length);
  return /^collection-[a-zA-Z0-9_-]+$/.test(id) ? id : null;
}

/**
 * 협업 문서(페이지/컬렉션)가 살아 있는지 확인한다.
 * 공유 워크스페이스라 소유자는 확인하지 않는다 (로그인 여부는 onAuthenticate 에서 확인).
 */
export async function assertCollaborationDocumentExists(
  documentName: string,
): Promise<{ pageId?: string; collectionId?: string }> {
  const collectionId = collectionIdFromDocumentName(documentName);
  if (collectionId) {
    if (!await collectionExists(collectionId)) throw new Error("Collection not found");
    return { collectionId };
  }
  const pageId = pageIdFromDocumentName(documentName);
  if (!pageId) {
    throw new Error("Invalid collaboration document name");
  }

  const result = await pool.query("SELECT 1 FROM pages WHERE id = $1 AND deleted_at IS NULL", [pageId]);
  if (!result.rowCount) {
    throw new Error("Page not found");
  }

  return { pageId };
}

export async function loadCollaborationState(
  documentName: string,
): Promise<Uint8Array | null> {
  const collectionId = collectionIdFromDocumentName(documentName);
  if (collectionId) {
    await assertCollaborationDocumentExists(documentName);
    return loadCollectionState(collectionId);
  }
  const { pageId } = await assertCollaborationDocumentExists(documentName);
  const result = await pool.query(
    `SELECT cd.yjs_state,
            cd.updated_at AS collaboration_updated_at,
            p.blocks_server_modified_at
     FROM pages p
     LEFT JOIN collaboration_documents cd ON cd.document_name = $1
     WHERE p.id = $2`,
    [documentName, pageId],
  );
  const row = result.rows[0];
  const state = row?.yjs_state;
  if (!state) return null;

  // 제목·아이콘·순서 같은 메타데이터 변경(updated_at)으로는 Yjs 상태를 버리지 않는다.
  // 서버가 본문(blocks)을 직접 수정한 경우(페이지 이동/삭제 정리 등)에만 REST 본문으로 다시 시드한다.
  if (row.blocks_server_modified_at) {
    const collaborationUpdatedAt = new Date(row.collaboration_updated_at).getTime();
    const serverModifiedAt = new Date(row.blocks_server_modified_at).getTime();
    if (
      Number.isFinite(serverModifiedAt) &&
      Number.isFinite(collaborationUpdatedAt) &&
      serverModifiedAt > collaborationUpdatedAt
    ) {
      return null;
    }
  }
  return new Uint8Array(state as Buffer);
}

export async function storeCollaborationState(
  documentName: string,
  state: Uint8Array,
): Promise<void> {
  const collectionId = collectionIdFromDocumentName(documentName);
  if (collectionId) {
    await assertCollaborationDocumentExists(documentName);
    await storeCollectionState(collectionId, state);
    return;
  }
  const { pageId } = await assertCollaborationDocumentExists(documentName);
  await pool.query(
    `INSERT INTO collaboration_documents (document_name, page_id, yjs_state)
     VALUES ($1, $2, $3)
     ON CONFLICT (document_name) DO UPDATE
       SET yjs_state = EXCLUDED.yjs_state,
           updated_at = NOW()`,
    [documentName, pageId, Buffer.from(state)],
  );
  // 캔버스면 카드로 올린 페이지를 그래프 링크(캔버스 → 페이지)로 맞춘다.
  const kind = await pool.query<{ kind: string }>("SELECT kind FROM pages WHERE id = $1", [pageId]);
  if (kind.rows[0]?.kind === "canvas") {
    await syncCanvasLinks(pageId, decodeCanvasState(state)).catch((error) =>
      console.error(`[canvas] ${pageId} 링크 갱신 실패:`, error),
    );
  }
}
