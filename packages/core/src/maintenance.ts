import { pool } from "./db.js";
import { embeddingModelKey } from "./embedding-client.js";
import { getSystemSettingsFromDb, resolveBackgroundAISettings } from "./settings.js";

/**
 * 검색 색인·LLM 위키 상태와 유지 작업 (DB 만으로 계산).
 * 메인 서버의 작업자와 어드민 서버가 함께 쓴다. 작업자 메모리 상태(쉬는 중 등)는 각 서버가 덧붙인다.
 */

const PAGE_HASH_SQL = "md5(p.title || E'\\n' || p.blocks::text)";
const MIN_PAGES_FOR_ARTICLE = 2;

async function hasPgroonga(): Promise<boolean> {
  const res = await pool.query("SELECT 1 FROM pg_extension WHERE extname = 'pgroonga'");
  return Boolean(res.rowCount);
}

export async function getIndexingStatus() {
  const config = await getSystemSettingsFromDb(false);
  const model = embeddingModelKey(config.embedding);
  const res = await pool.query<{
    total: string;
    indexed: string;
    text_indexed: string;
    failed: string;
    chunks: string;
    dims: number | null;
    last_error: string | null;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM pages WHERE deleted_at IS NULL) AS total,
       (SELECT COUNT(*) FROM pages p JOIN page_index_state s ON s.page_id = p.id
         WHERE p.deleted_at IS NULL AND s.model = $1 AND s.error IS NULL
           AND s.content_hash = ${PAGE_HASH_SQL}) AS indexed,
       (SELECT COUNT(*) FROM pages p JOIN page_index_state s ON s.page_id = p.id
         WHERE p.deleted_at IS NULL AND s.text_hash = ${PAGE_HASH_SQL}) AS text_indexed,
       (SELECT COUNT(*) FROM page_index_state WHERE error IS NOT NULL) AS failed,
       (SELECT COUNT(*) FROM page_embeddings WHERE model = $1) AS chunks,
       (SELECT MAX(dims) FROM page_embeddings WHERE model = $1) AS dims,
       (SELECT error FROM page_index_state WHERE error IS NOT NULL ORDER BY indexed_at DESC LIMIT 1) AS last_error`,
    [model],
  );
  const attachmentRes = await pool.query<{ extract_status: string; count: string }>(
    "SELECT extract_status, COUNT(*) AS count FROM attachments GROUP BY extract_status",
  );
  const attachments = Object.fromEntries(attachmentRes.rows.map((r) => [r.extract_status, Number(r.count)]));
  const row = res.rows[0];
  return {
    enabled: config.embedding.enabled,
    model,
    dims: row?.dims ?? null,
    totalPages: Number(row?.total ?? 0),
    indexedPages: Number(row?.indexed ?? 0),
    textIndexedPages: Number(row?.text_indexed ?? 0),
    keywordEngine: (await hasPgroonga()) ? ("pgroonga" as const) : ("basic" as const),
    failedPages: Number(row?.failed ?? 0),
    chunkCount: Number(row?.chunks ?? 0),
    attachments: {
      done: attachments.done ?? 0,
      pending: attachments.pending ?? 0,
      empty: attachments.empty ?? 0,
      unsupported: attachments.unsupported ?? 0,
      failed: attachments.failed ?? 0,
    },
    lastError: row?.last_error ?? null,
  };
}

/** 모든 페이지를 처음부터 다시 색인하게 한다 (텍스트 조각 + 임베딩). */
export async function requestFullReindex(): Promise<void> {
  await pool.query("DELETE FROM page_index_state");
  await pool.query("DELETE FROM page_chunks");
}

const LIVE_MENTION_COUNT_SQL = `
  (SELECT COUNT(*)::int FROM wiki_concept_mentions cm JOIN pages p ON p.id = cm.page_id AND p.deleted_at IS NULL
    WHERE cm.concept_id = c.id)`;

export async function getConceptStats(): Promise<{ concepts: number; withArticle: number; multiPage: number }> {
  const res = await pool.query(
    `SELECT COUNT(*)::int AS concepts,
            COUNT(*) FILTER (WHERE article_status = 'done')::int AS with_article,
            COUNT(*) FILTER (WHERE ${LIVE_MENTION_COUNT_SQL} >= ${MIN_PAGES_FOR_ARTICLE})::int AS multi_page
       FROM wiki_concepts c
      WHERE ${LIVE_MENTION_COUNT_SQL} > 0`,
  );
  const row = res.rows[0];
  return { concepts: row?.concepts ?? 0, withArticle: row?.with_article ?? 0, multiPage: row?.multi_page ?? 0 };
}

export async function getDigestStats() {
  const config = await getSystemSettingsFromDb(false);
  const ai = resolveBackgroundAISettings(config);
  const res = await pool.query<{ status: string; count: string }>(
    `SELECT d.status, COUNT(*) AS count
       FROM page_digests d JOIN pages p ON p.id = d.page_id AND p.deleted_at IS NULL
      GROUP BY d.status`,
  );
  const counts = Object.fromEntries(res.rows.map((row) => [row.status, Number(row.count)]));
  const extra = await pool.query<{ total: string; failed: string; last_error: string | null }>(
    `SELECT
       (SELECT COUNT(*) FROM pages WHERE deleted_at IS NULL) AS total,
       (SELECT COUNT(*) FROM page_digests d JOIN pages p ON p.id = d.page_id AND p.deleted_at IS NULL
         WHERE d.failed_at IS NOT NULL) AS failed,
       (SELECT error FROM (
          SELECT error, failed_at AS at FROM page_digests WHERE failed_at IS NOT NULL
          UNION ALL
          SELECT '개념 글: ' || article_error, article_generated_at FROM wiki_concepts WHERE article_status = 'failed'
        ) e ORDER BY at DESC NULLS LAST LIMIT 1) AS last_error`,
  );
  const conceptStats = await getConceptStats();
  return {
    enabled: config.aiBackground.digestEnabled,
    model: `${ai.provider}:${(ai.model || "").trim()}`,
    totalPages: Number(extra.rows[0]?.total ?? 0),
    done: counts.done ?? 0,
    skipped: counts.skipped ?? 0,
    failed: Number(extra.rows[0]?.failed ?? 0),
    concepts: conceptStats.concepts,
    conceptArticles: conceptStats.withArticle,
    multiPageConcepts: conceptStats.multiPage,
    lastError: extra.rows[0]?.last_error ?? null,
  };
}

/** 모든 정리본과 개념 색인을 지워 처음부터 다시 만들게 한다. */
export async function requestDigestRegeneration(): Promise<void> {
  await pool.query("DELETE FROM page_digests");
  await pool.query("DELETE FROM wiki_concept_mentions");
  await pool.query("DELETE FROM wiki_concepts");
}
