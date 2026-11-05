import * as Y from "yjs";
import { pool } from "./db.js";
import { collectionMap, initializeCollectionMap, readCollectionMap } from "@noty/shared/collection-yjs";
import { migrateLegacyCollectionData } from "@noty/shared/collection-schema";
import type { CollectionData } from "@noty/shared/collection-types";

const COLLECTION_ID = /^collection-[a-zA-Z0-9_-]+$/;

export function assertCollectionId(id: string): void {
  if (!COLLECTION_ID.test(id)) throw new Error("Invalid collection ID");
}

function asCollectionData(value: unknown): CollectionData {
  if (!value || typeof value !== "object") throw new Error("Invalid collection data");
  const data = value as CollectionData;
  if (typeof data.title !== "string" || !Array.isArray(data.views) || !Array.isArray(data.properties) || !Array.isArray(data.rows)) {
    throw new Error("Invalid collection data");
  }
  return data;
}

/*
 * 공유 워크스페이스: 로그인한 사용자는 모든 페이지(와 그 안의 컬렉션)에 접근한다.
 * 페이지 목록/본문 REST 와 협업 서버가 같은 기준을 쓴다. userId 인자는 호출 호환을 위해 남겨 둔다.
 */
export async function ensureCollectionInDb(id: string, ownerPageId: string, initial: unknown, _userId?: string): Promise<CollectionData> {
  assertCollectionId(id);
  if (!/^[a-zA-Z0-9_-]+$/.test(ownerPageId)) throw new Error("Invalid page ID");
  const existing = await pool.query(
    "SELECT c.initial_data FROM collections c JOIN pages p ON p.id = c.owner_page_id WHERE c.id = $1 AND p.deleted_at IS NULL",
    [id],
  );
  if (existing.rowCount) return asCollectionData(existing.rows[0].initial_data);
  const data = migrateLegacyCollectionData({ ...asCollectionData(initial), collectionId: id });
  const doc = new Y.Doc();
  initializeCollectionMap(collectionMap(doc, id), data);
  const state = Buffer.from(Y.encodeStateAsUpdate(doc));
  doc.destroy();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const owner = await client.query("SELECT 1 FROM pages WHERE id = $1 AND deleted_at IS NULL", [ownerPageId]);
    if (!owner.rowCount) throw new Error("Owner page not found");
    const inserted = await client.query(
      `INSERT INTO collections (id, owner_page_id, title, initial_data)
       VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (id) DO NOTHING RETURNING id`,
      [id, ownerPageId, data.title, JSON.stringify(data)],
    );
    if (inserted.rowCount) {
      await client.query(
        "INSERT INTO collection_documents (collection_id, yjs_state) VALUES ($1, $2)",
        [id, state],
      );
    }
    const result = await client.query(
      "SELECT c.initial_data FROM collections c JOIN pages p ON p.id = c.owner_page_id WHERE c.id = $1 AND p.deleted_at IS NULL",
      [id],
    );
    if (!result.rowCount) throw new Error("Collection not found");
    await client.query("COMMIT");
    return asCollectionData(result.rows[0].initial_data);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listCollectionsFromDb(_userId?: string): Promise<Array<{ id: string; title: string; ownerPageTitle: string }>> {
  const result = await pool.query(
    `SELECT c.id, c.title, p.title AS owner_page_title
     FROM collections c JOIN pages p ON p.id = c.owner_page_id
     WHERE p.deleted_at IS NULL ORDER BY c.created_at DESC`,
  );
  return result.rows.map((row) => ({ id: String(row.id), title: String(row.title), ownerPageTitle: String(row.owner_page_title) }));
}

export async function getCollectionFromDb(id: string, _userId?: string): Promise<CollectionData | null> {
  assertCollectionId(id);
  const result = await pool.query(
    "SELECT c.initial_data FROM collections c JOIN pages p ON p.id = c.owner_page_id WHERE c.id = $1 AND p.deleted_at IS NULL",
    [id],
  );
  return result.rowCount ? asCollectionData(result.rows[0].initial_data) : null;
}

export async function collectionExists(id: string): Promise<boolean> {
  assertCollectionId(id);
  const result = await pool.query(
    "SELECT 1 FROM collections c JOIN pages p ON p.id = c.owner_page_id WHERE c.id = $1 AND p.deleted_at IS NULL",
    [id],
  );
  return Boolean(result.rowCount);
}

export async function loadCollectionState(id: string): Promise<Uint8Array | null> {
  assertCollectionId(id);
  const result = await pool.query("SELECT yjs_state FROM collection_documents WHERE collection_id = $1", [id]);
  return result.rows[0]?.yjs_state ? new Uint8Array(result.rows[0].yjs_state as Buffer) : null;
}

export async function storeCollectionState(id: string, state: Uint8Array): Promise<void> {
  assertCollectionId(id);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const data = readCollectionMap(collectionMap(doc, id));
  doc.destroy();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO collection_documents (collection_id, yjs_state) VALUES ($1, $2)
       ON CONFLICT (collection_id) DO UPDATE SET yjs_state = EXCLUDED.yjs_state, updated_at = NOW()`,
      [id, Buffer.from(state)],
    );
    if (data) await client.query(
      "UPDATE collections SET title = $2, initial_data = $3::jsonb, updated_at = NOW() WHERE id = $1",
      [id, data.title, JSON.stringify(data)],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
