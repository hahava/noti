import * as Y from "yjs";
import { canvasPageIds, readCanvas, type CanvasData } from "@noty/shared/canvas";
import { pool } from "./db.js";

/**
 * 그래프 뷰와 캔버스용 조회.
 *  - 그래프: 살아 있는 페이지(점)와 page_links(선). Obsidian 처럼 링크만 보여 준다.
 *    (본문 속 하위 페이지 블록·@멘션, 캔버스에 올린 페이지 카드가 링크가 된다)
 *  - 캔버스: 협업 저장소의 Yjs 상태를 읽어 카드·선 JSON 으로 돌려준다 (페이지 안 미리보기용).
 */

export interface GraphNode {
  id: string;
  title: string;
  icon: string | null;
  kind: "page" | "canvas";
}

export interface GraphLink {
  source: string;
  target: string;
}

export async function getWorkspaceGraph(): Promise<{ nodes: GraphNode[]; links: GraphLink[] }> {
  const [pages, links] = await Promise.all([
    pool.query<{ id: string; title: string; icon: string | null; kind: string }>(
      "SELECT id, title, icon, kind FROM pages WHERE deleted_at IS NULL ORDER BY created_at ASC",
    ),
    pool.query<{ source_id: string; target_id: string }>(
      `SELECT l.source_id, l.target_id
       FROM page_links l
       JOIN pages s ON s.id = l.source_id AND s.deleted_at IS NULL
       JOIN pages t ON t.id = l.target_id AND t.deleted_at IS NULL
       WHERE l.source_id <> l.target_id`,
    ),
  ]);
  // 같은 두 페이지 사이의 양방향 링크는 선 하나로 그린다.
  const seen = new Set<string>();
  const unique: GraphLink[] = [];
  for (const row of links.rows) {
    const key = [row.source_id, row.target_id].sort().join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ source: row.source_id, target: row.target_id });
  }
  return {
    nodes: pages.rows.map((row) => ({
      id: row.id,
      title: row.title || "제목 없는 문서",
      icon: row.icon,
      kind: row.kind === "canvas" ? "canvas" : "page",
    })),
    links: unique,
  };
}

export function decodeCanvasState(state: Uint8Array | Buffer | null | undefined): CanvasData {
  const doc = new Y.Doc();
  if (state && state.length > 0) Y.applyUpdate(doc, new Uint8Array(state));
  const data = readCanvas(doc);
  doc.destroy();
  return data;
}

export async function getCanvasSnapshot(pageId: string): Promise<CanvasData | null> {
  const res = await pool.query<{ kind: string; yjs_state: Buffer | null }>(
    `SELECT p.kind, cd.yjs_state
     FROM pages p
     LEFT JOIN collaboration_documents cd ON cd.document_name = 'page:' || p.id
     WHERE p.id = $1 AND p.deleted_at IS NULL`,
    [pageId],
  );
  const row = res.rows[0];
  if (!row || row.kind !== "canvas") return null;
  return decodeCanvasState(row.yjs_state);
}

/** 캔버스에 올라간 페이지 카드를 그래프 링크(캔버스 → 페이지)로 맞춘다. 협업 저장 때 부른다. */
export async function syncCanvasLinks(canvasId: string, data: CanvasData): Promise<void> {
  const targets = canvasPageIds(data).filter((id) => id !== canvasId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM page_links WHERE source_id = $1", [canvasId]);
    if (targets.length > 0) {
      await client.query(
        `INSERT INTO page_links (source_id, target_id)
         SELECT $1, id FROM pages WHERE id = ANY($2::text[])
         ON CONFLICT DO NOTHING`,
        [canvasId, targets],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** 캔버스 페이지 카드에 보여 줄 제목·아이콘·첫 부분 미리보기 */
export async function getPagePreviews(ids: readonly string[]) {
  if (ids.length === 0) return {};
  const res = await pool.query<{ id: string; title: string; icon: string | null; kind: string; plain_text: string; deleted_at: Date | null }>(
    "SELECT id, title, icon, kind, plain_text, deleted_at FROM pages WHERE id = ANY($1::text[])",
    [ids.slice(0, 500)],
  );
  const result: Record<string, { title: string; icon: string | null; kind: string; excerpt: string; deleted: boolean }> = {};
  for (const row of res.rows) {
    // plain_text 는 제목으로 시작하므로 제목을 빼고 본문 앞부분만 보여 준다.
    const text = (row.plain_text || "").replace(/\s+/g, " ").trim();
    const title = row.title || "";
    const body = text.startsWith(title) ? text.slice(title.length).trim() : text;
    result[row.id] = {
      title: title || "제목 없는 문서",
      icon: row.icon,
      kind: row.kind,
      excerpt: body.slice(0, 220),
      deleted: Boolean(row.deleted_at),
    };
  }
  return result;
}
