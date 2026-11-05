import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  extractInlineText,
  getEffectiveUploadsDir,
  getSystemSettingsFromDb,
  pgroongaAvailable,
  pool,
  type EmbeddingSystemSettings,
} from "./db.js";
import { extractFileText } from "./file-extract.js";
import { embeddingModelKey, embedTexts } from "@noty/core/embedding-client";
import { DEFAULT_UPLOADS_DIR } from "@noty/core/paths";
import { getIndexingStatus, requestFullReindex as clearIndexState } from "@noty/core/maintenance";

export { embeddingModelKey, embedTexts, testEmbeddingConnection } from "@noty/core/embedding-client";

/**
 * 임베딩 / 벡터 검색 (LLM 위키의 검색 계층)
 *
 * - 페이지 본문을 제목·헤딩 맥락이 붙은 조각(chunk)으로 나눠 임베딩하고 page_embeddings 에 저장한다.
 * - 백그라운드 인덱서가 주기적으로 "본문 해시가 바뀐 페이지"만 찾아 처리한다.
 *   (REST 저장, 협업 서버 저장 등 어떤 경로로 바뀌어도 잡아낸다)
 * - 페이지 안에서도 내용이 바뀐 조각만 다시 임베딩하고, 나머지는 기존 벡터를 재사용한다.
 * - 공유 워크스페이스라 검색 대상은 삭제되지 않은 페이지 전체다 (페이지 목록 REST 와 같은 기준).
 */

const INDEX_INTERVAL_MS = 10_000;
/** 마지막 수정 후 이 시간이 지나야 인덱싱한다 (타이핑 중 반복 인덱싱 방지) */
const SETTLE_MS = 5_000;
const PAGES_PER_TICK = 10;
const EMBED_BATCH_SIZE = 16;
/** 연결 실패 시 다음 시도까지 대기 */
const ERROR_BACKOFF_MS = 60_000;
const CHUNK_TARGET_CHARS = 800;
const CHUNK_MAX_CHARS = 1500;
/** 단일 인덱서 보장을 위한 advisory lock 키 (API 서버가 여러 대여도 한 대만 인덱싱) */
const INDEXER_LOCK_KEY = 872_341_901;

function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

/* --------------------------------------------------------------------------
 * 본문 조각 나누기
 * ------------------------------------------------------------------------ */

export type ChunkKind = "chunk" | "file";

export interface PageChunk {
  kind: ChunkKind;
  /** kind 별로 0부터 매기는 순번 */
  index: number;
  blockId: string | null;
  attachmentId: string | null;
  /** 임베딩/검색에 쓰는 텍스트: "제목 > 헤딩\n본문" 또는 "제목 > 📎 파일명 (3쪽)\n본문" */
  content: string;
  hash: string;
}

/** 본문에서 참조하는 첨부파일 (블록 url 이 /uploads/<id> 인 블록) */
export interface AttachmentRef {
  attachmentId: string;
  blockId: string | null;
  name: string;
}

/** 추출이 끝난 첨부파일 텍스트 */
export interface AttachmentText {
  name: string;
  segments: { label: string | null; text: string }[];
}

interface FlatBlock {
  id: string | null;
  type: string;
  text: string;
  headingLevel: number;
}

/** 업로드 URL(상대/절대)에서 첨부파일 id(저장 파일명)를 꺼낸다. */
export function attachmentIdFromUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const match = url.match(/\/uploads\/([^/?#]+)/);
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[1]);
    return id && !id.includes("/") && !id.includes("..") ? id : null;
  } catch {
    return null;
  }
}

function flattenBlocks(
  blocks: readonly unknown[],
  depth = 0,
  out: FlatBlock[] = [],
  refs: AttachmentRef[] = [],
): { flat: FlatBlock[]; refs: AttachmentRef[] } {
  for (const value of blocks) {
    if (!value || typeof value !== "object") continue;
    const block = value as Record<string, any>;
    const type = String(block.type ?? "");
    const blockId = typeof block.id === "string" ? block.id : null;
    let text = extractInlineText(block.content);
    if (type === "table" && Array.isArray(block.content?.rows)) {
      text = block.content.rows
        .map((row: any) => (row.cells ?? []).map((cell: any) => extractInlineText(cell?.content ?? cell)).join(" | "))
        .join("\n");
    }

    // 파일/이미지/영상 블록: 파일명과 캡션을 본문 조각에 넣고, 파일 내용은 따로 조각을 만든다.
    const attachmentId = attachmentIdFromUrl(block.props?.url);
    if (attachmentId) {
      const name = String(block.props?.name || "").trim() || attachmentId;
      const caption = String(block.props?.caption || "").trim();
      refs.push({ attachmentId, blockId, name });
      text = [`📎 ${name}`, caption, text].filter(Boolean).join(" — ");
    }

    text = text.trim();
    if (text) {
      out.push({
        id: blockId,
        type,
        text: depth > 0 ? `${"  ".repeat(depth)}${text}` : text,
        headingLevel: type === "heading" ? Number(block.props?.level) || 1 : 0,
      });
    }
    if (Array.isArray(block.children) && block.children.length > 0) {
      flattenBlocks(block.children, depth + 1, out, refs);
    }
  }
  return { flat: out, refs };
}

export function findAttachmentRefs(blocks: readonly unknown[]): AttachmentRef[] {
  return flattenBlocks(blocks).refs;
}

/** 긴 텍스트를 줄 경계 우선으로 ~800자 조각으로 나눈다. */
function splitText(text: string): string[] {
  const pieces: string[] = [];
  let current = "";
  for (const rawLine of text.split("\n")) {
    // 줄 하나가 너무 길면 강제로 자른다.
    for (let i = 0; i < Math.max(1, rawLine.length); i += CHUNK_MAX_CHARS) {
      const line = rawLine.slice(i, i + CHUNK_MAX_CHARS);
      if (current && current.length + line.length + 1 > CHUNK_TARGET_CHARS) {
        pieces.push(current);
        current = "";
      }
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current.trim()) pieces.push(current);
  return pieces.filter((piece) => piece.trim());
}

/**
 * 헤딩 경계를 우선해서 ~800자 단위로 묶고, 각 조각 앞에 "제목 > 상위 헤딩" 맥락을 붙인다.
 * attachments 가 주어지면 참조된 첨부파일 텍스트도 "제목 > 📎 파일명 (구간)" 맥락으로 조각을 만든다.
 */
export function chunkPage(
  title: string,
  blocks: readonly unknown[],
  attachments: Map<string, AttachmentText> = new Map(),
): PageChunk[] {
  const { flat, refs } = flattenBlocks(blocks);
  const pageTitle = title.trim() || "제목 없는 문서";
  const chunks: PageChunk[] = [];
  const headingPath: string[] = [];
  let buffer: string[] = [];
  let bufferLength = 0;
  let bufferBlockId: string | null = null;
  let bufferContext = pageTitle;
  let blockChunkCount = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    const content = `${bufferContext}\n${buffer.join("\n")}`;
    chunks.push({ kind: "chunk", index: blockChunkCount++, blockId: bufferBlockId, attachmentId: null, content, hash: sha1(content) });
    buffer = [];
    bufferLength = 0;
    bufferBlockId = null;
  };

  for (const block of flat) {
    if (block.headingLevel > 0) {
      // 새 섹션이 시작되면 이전 조각을 닫는다.
      flush();
      headingPath.length = Math.min(headingPath.length, block.headingLevel - 1);
      headingPath[block.headingLevel - 1] = block.text;
    }
    // 아주 긴 단일 블록은 잘라서 여러 조각으로 만든다.
    const pieces: string[] = [];
    for (let i = 0; i < block.text.length; i += CHUNK_MAX_CHARS) pieces.push(block.text.slice(i, i + CHUNK_MAX_CHARS));
    for (const piece of pieces) {
      if (bufferLength > 0 && bufferLength + piece.length > CHUNK_TARGET_CHARS) flush();
      if (buffer.length === 0) {
        bufferBlockId = block.id;
        bufferContext = [pageTitle, ...headingPath.filter(Boolean)].join(" > ");
      }
      buffer.push(piece);
      bufferLength += piece.length + 1;
    }
  }
  flush();

  // 본문이 비어 있어도 제목으로는 찾을 수 있게 한다.
  if (blockChunkCount === 0 && title.trim()) {
    chunks.push({ kind: "chunk", index: blockChunkCount++, blockId: null, attachmentId: null, content: pageTitle, hash: sha1(pageTitle) });
  }

  // 첨부파일 내용 조각 (같은 파일이 여러 번 들어 있어도 한 번만)
  let fileChunkCount = 0;
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref.attachmentId)) continue;
    seen.add(ref.attachmentId);
    const file = attachments.get(ref.attachmentId);
    if (!file) continue;
    const name = ref.name || file.name;
    for (const segment of file.segments) {
      const context = `${pageTitle} > 📎 ${name}${segment.label ? ` (${segment.label})` : ""}`;
      for (const piece of splitText(segment.text)) {
        const content = `${context}\n${piece}`;
        chunks.push({ kind: "file", index: fileChunkCount++, blockId: ref.blockId, attachmentId: ref.attachmentId, content, hash: sha1(content) });
      }
    }
  }
  return chunks;
}

/* --------------------------------------------------------------------------
 * 차원별 HNSW 부분 인덱스
 * ------------------------------------------------------------------------ */

const ensuredDimIndexes = new Set<number>();

/** pgvector HNSW 는 vector 2000차원, halfvec 4000차원까지 지원한다. 그 이상은 인덱스 없이 정확 검색한다. */
function vectorCastFor(dims: number): { cast: string; ops: string } | null {
  if (dims <= 2000) return { cast: `vector(${dims})`, ops: "vector_cosine_ops" };
  if (dims <= 4000) return { cast: `halfvec(${dims})`, ops: "halfvec_cosine_ops" };
  return null;
}

async function ensureDimIndex(dims: number): Promise<void> {
  if (ensuredDimIndexes.has(dims) || !Number.isInteger(dims) || dims <= 0) return;
  const spec = vectorCastFor(dims);
  if (spec) {
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_page_embeddings_hnsw_d${dims}
         ON page_embeddings USING hnsw ((embedding::${spec.cast}) ${spec.ops})
         WHERE dims = ${dims}`,
    );
  }
  ensuredDimIndexes.add(dims);
}

function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

/* --------------------------------------------------------------------------
 * 첨부파일 텍스트 추출
 * ------------------------------------------------------------------------ */


const ATTACHMENTS_PER_TICK = 3;

async function readUploadedFile(attachmentId: string): Promise<Buffer | null> {
  const safeName = path.basename(attachmentId);
  for (const dir of [await getEffectiveUploadsDir(), DEFAULT_UPLOADS_DIR]) {
    try {
      return await readFile(path.join(dir, safeName));
    } catch {
      // 다음 경로 시도
    }
  }
  return null;
}

/** 업로드 직후 기록. 추출은 인덱서가 백그라운드에서 한다. */
export async function registerAttachment(params: {
  id: string;
  userId: string | null;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
}): Promise<void> {
  await pool.query(
    `INSERT INTO attachments (id, user_id, original_name, mime_type, size_bytes)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO NOTHING`,
    [params.id, params.userId, params.originalName, params.mimeType, params.sizeBytes],
  );
  scheduleIndexerSoon();
}

/** 추출 대기 중인 첨부파일을 처리하고, 그 파일을 참조하는 페이지를 다시 인덱싱 대상으로 만든다. */
async function processPendingAttachments(limit: number): Promise<number> {
  const pending = await pool.query<{ id: string; original_name: string; mime_type: string }>(
    `SELECT id, original_name, mime_type FROM attachments
      WHERE extract_status = 'pending' ORDER BY created_at ASC LIMIT $1`,
    [limit],
  );
  for (const row of pending.rows) {
    let status: string;
    let message: string | null = null;
    let segments: unknown = null;
    let charCount = 0;
    try {
      const buffer = await readUploadedFile(row.id);
      if (!buffer) {
        status = "failed";
        message = "업로드 파일을 찾을 수 없습니다.";
      } else {
        const result = await extractFileText(buffer, row.original_name || row.id, row.mime_type);
        status = result.status;
        if (result.status === "done") {
          segments = result.segments;
          charCount = result.segments.reduce((sum, segment) => sum + segment.text.length, 0);
        } else {
          message = result.message;
        }
      }
    } catch (error) {
      status = "failed";
      message = `텍스트 추출 실패: ${error instanceof Error ? error.message : String(error)}`;
    }
    await pool.query(
      `UPDATE attachments
          SET extract_status = $2, extract_message = $3, segments = $4::jsonb, char_count = $5, extracted_at = NOW()
        WHERE id = $1`,
      [row.id, status, message, segments === null ? null : JSON.stringify(segments), charCount],
    );
    if (status === "done") {
      // 이 파일을 참조하는 페이지는 본문 해시가 그대로라도 다시 인덱싱해야 한다.
      await pool.query(
        `DELETE FROM page_index_state s USING pages p
          WHERE s.page_id = p.id AND strpos(p.blocks::text, $1) > 0`,
        [`/uploads/${row.id}`],
      );
    }
    console.log(`[attachments] ${row.original_name}: ${status}${message ? ` (${message})` : ""}`);
  }
  return pending.rows.length;
}

/**
 * 페이지가 참조하는 첨부파일의 추출 텍스트를 가져온다.
 * 이 기능 이전에 업로드되어 기록이 없는 파일은 디스크에 있으면 페이지 소유자 기준으로 등록한다.
 */
async function loadPageAttachments(
  blocks: readonly unknown[],
  ownerId: string | null,
): Promise<Map<string, AttachmentText>> {
  const refs = findAttachmentRefs(blocks);
  const ids = Array.from(new Set(refs.map((ref) => ref.attachmentId)));
  const result = new Map<string, AttachmentText>();
  if (ids.length === 0) return result;

  const res = await pool.query<{ id: string; original_name: string; extract_status: string; segments: any }>(
    `SELECT id, original_name, extract_status, segments FROM attachments WHERE id = ANY($1::text[])`,
    [ids],
  );
  const known = new Set(res.rows.map((row) => row.id));
  for (const row of res.rows) {
    if (row.extract_status === "done" && Array.isArray(row.segments)) {
      result.set(row.id, { name: row.original_name, segments: row.segments });
    }
  }
  for (const ref of refs) {
    if (known.has(ref.attachmentId)) continue;
    known.add(ref.attachmentId);
    const buffer = await readUploadedFile(ref.attachmentId);
    if (!buffer) continue;
    await pool.query(
      `INSERT INTO attachments (id, user_id, original_name, mime_type, size_bytes)
       VALUES ($1, $2, $3, '', $4) ON CONFLICT (id) DO NOTHING`,
      [ref.attachmentId, ownerId, ref.name || ref.attachmentId, buffer.length],
    );
  }
  return result;
}

/* --------------------------------------------------------------------------
 * 페이지 인덱싱
 * ------------------------------------------------------------------------ */

const PAGE_HASH_SQL = "md5(p.title || E'\\n' || p.blocks::text)";

type IndexablePage = { id: string; user_id: string | null; title: string; blocks: unknown; content_hash: string };

/** 텍스트 조각을 page_chunks 에 반영한다 (키워드 검색용, 임베딩 설정과 무관). */
async function writeTextChunks(page: IndexablePage, chunks: PageChunk[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM page_chunks WHERE page_id = $1", [page.id]);
    for (const chunk of chunks) {
      await client.query(
        `INSERT INTO page_chunks (page_id, user_id, kind, chunk_index, block_id, attachment_id, content, content_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [page.id, page.user_id, chunk.kind, chunk.index, chunk.blockId, chunk.attachmentId, chunk.content, chunk.hash],
      );
    }
    await client.query(
      `INSERT INTO page_index_state (page_id, content_hash, model, chunk_count, text_hash, indexed_at)
       VALUES ($1, '', '', $2, $3, NOW())
       ON CONFLICT (page_id) DO UPDATE SET text_hash = EXCLUDED.text_hash, chunk_count = EXCLUDED.chunk_count`,
      [page.id, chunks.length, page.content_hash],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** 조각을 임베딩해서 page_embeddings 에 반영한다. 반환값은 새로 임베딩한 조각 수. */
async function writeEmbeddings(settings: EmbeddingSystemSettings, page: IndexablePage, chunks: PageChunk[]): Promise<number> {
  const model = embeddingModelKey(settings);

  // 같은 모델로 이미 임베딩한 조각은 해시가 같으면 재사용한다. (파일 조각 포함)
  const existing = await pool.query<{ content_hash: string; dims: number; embedding: string }>(
    `SELECT content_hash, dims, embedding::text AS embedding
       FROM page_embeddings
      WHERE page_id = $1 AND kind IN ('chunk', 'file') AND model = $2`,
    [page.id, model],
  );
  const reusable = new Map(existing.rows.map((row) => [row.content_hash, row]));
  const missing = Array.from(
    new Map(chunks.filter((chunk) => !reusable.has(chunk.hash)).map((chunk) => [chunk.hash, chunk])).values(),
  );

  const fresh = new Map<string, number[]>();
  for (let i = 0; i < missing.length; i += EMBED_BATCH_SIZE) {
    const batch = missing.slice(i, i + EMBED_BATCH_SIZE);
    const vectors = await embedTexts(settings, batch.map((chunk) => chunk.content));
    batch.forEach((chunk, idx) => fresh.set(chunk.hash, vectors[idx]));
  }

  const rows = chunks.map((chunk) => {
    const freshVector = fresh.get(chunk.hash);
    const reused = reusable.get(chunk.hash);
    return {
      chunk,
      literal: freshVector ? toVectorLiteral(freshVector) : reused!.embedding,
      dims: freshVector ? freshVector.length : reused!.dims,
    };
  });
  // 인덱스 생성은 트랜잭션 밖에서 해야 한다 (같은 테이블에 쓰는 트랜잭션과 서로 기다리게 됨).
  for (const dims of new Set(rows.map((row) => row.dims))) await ensureDimIndex(dims);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM page_embeddings WHERE page_id = $1 AND kind IN ('chunk', 'file')", [page.id]);
    for (const { chunk, literal, dims } of rows) {
      await client.query(
        `INSERT INTO page_embeddings
           (page_id, user_id, kind, chunk_index, block_id, attachment_id, content, content_hash, model, dims, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::vector)`,
        [
          page.id,
          page.user_id,
          chunk.kind,
          chunk.index,
          chunk.blockId,
          chunk.attachmentId,
          chunk.content,
          chunk.hash,
          model,
          dims,
          literal,
        ],
      );
    }
    await client.query(
      `INSERT INTO page_index_state (page_id, content_hash, model, chunk_count, error, indexed_at)
       VALUES ($1, $2, $3, $4, NULL, NOW())
       ON CONFLICT (page_id) DO UPDATE
         SET content_hash = EXCLUDED.content_hash, model = EXCLUDED.model,
             chunk_count = EXCLUDED.chunk_count, error = NULL, indexed_at = NOW()`,
      [page.id, page.content_hash, model, chunks.length],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return missing.length;
}

/**
 * 인덱싱이 필요한 페이지 (마지막 수정 후 잠시 지난 것만)
 *  - text_stale: 텍스트 조각을 만든 해시가 현재 본문과 다름
 *  - vector_stale: 임베딩이 켜져 있고, 임베딩 해시나 모델이 다름
 */
async function findStalePages(model: string, vectorActive: boolean, limit: number) {
  const res = await pool.query<IndexablePage & { text_stale: boolean; vector_stale: boolean }>(
    `SELECT id, user_id, title, blocks, content_hash, text_stale, vector_stale FROM (
       SELECT p.id, p.user_id, p.title, p.blocks, p.updated_at, ${PAGE_HASH_SQL} AS content_hash,
              (s.text_hash IS DISTINCT FROM ${PAGE_HASH_SQL}) AS text_stale,
              ($4::boolean AND (s.page_id IS NULL OR s.model <> $1 OR s.content_hash <> ${PAGE_HASH_SQL})) AS vector_stale
         FROM pages p
         LEFT JOIN page_index_state s ON s.page_id = p.id
        WHERE p.deleted_at IS NULL
          AND p.updated_at < NOW() - ($3::int * INTERVAL '1 millisecond')
     ) t
     WHERE text_stale OR vector_stale
     ORDER BY updated_at DESC
     LIMIT $2`,
    [model, limit, SETTLE_MS, vectorActive],
  );
  return res.rows;
}

let indexerTimer: NodeJS.Timeout | null = null;
let soonTimer: NodeJS.Timeout | null = null;
let indexerRunning = false;
let backoffUntil = 0;
let lastIndexerError: string | null = null;
let lastIndexedAt: string | null = null;
let lastEmbeddingFingerprint = "";

export async function runIndexerTick(): Promise<{
  textIndexed: number;
  indexed: number;
  embedded: number;
  extracted: number;
}> {
  const result = { textIndexed: 0, indexed: 0, embedded: 0, extracted: 0 };
  if (indexerRunning) return result;
  indexerRunning = true;
  const lockClient = await pool.connect();
  try {
    const lock = await lockClient.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [INDEXER_LOCK_KEY]);
    if (!lock.rows[0]?.locked) return result;
    try {
      // 1) 첨부파일 텍스트 추출은 임베딩 설정과 무관하게 진행한다 (키워드 검색에도 쓰임).
      result.extracted = await processPendingAttachments(ATTACHMENTS_PER_TICK);

      // 2) 페이지 조각: 텍스트는 항상, 벡터는 임베딩이 켜져 있을 때만
      const config = await getSystemSettingsFromDb(false);
      const settings = config.embedding;
      // 어드민(다른 프로세스)에서 임베딩 설정을 바꾸면 쉬던 벡터 작업을 바로 다시 시도한다.
      const fingerprint = JSON.stringify([settings.enabled, settings.provider, settings.model, settings.baseUrl, settings.apiKey]);
      if (fingerprint !== lastEmbeddingFingerprint) {
        lastEmbeddingFingerprint = fingerprint;
        backoffUntil = 0;
      }
      let vectorActive = settings.enabled && Boolean(settings.model.trim()) && Date.now() >= backoffUntil;
      const model = embeddingModelKey(settings);

      // 휴지통으로 간 페이지의 조각은 지운다 (복원되면 해시 비교로 다시 인덱싱됨).
      await pool.query(`DELETE FROM page_index_state s USING pages p WHERE s.page_id = p.id AND p.deleted_at IS NOT NULL`);
      await pool.query(`DELETE FROM page_chunks c USING pages p WHERE c.page_id = p.id AND p.deleted_at IS NOT NULL`);
      await pool.query(`DELETE FROM page_embeddings e USING pages p WHERE e.page_id = p.id AND p.deleted_at IS NOT NULL`);

      const pages = await findStalePages(model, vectorActive, PAGES_PER_TICK);
      for (const page of pages) {
        const blocks = Array.isArray(page.blocks) ? page.blocks : [];
        let chunks: PageChunk[];
        try {
          const attachments = await loadPageAttachments(blocks, page.user_id);
          chunks = chunkPage(page.title, blocks, attachments);
          if (page.text_stale) {
            await writeTextChunks(page, chunks);
            result.textIndexed += 1;
          }
        } catch (error) {
          console.error(`[search] ${page.id} 텍스트 인덱싱 실패:`, error instanceof Error ? error.message : error);
          continue;
        }

        if (!vectorActive || !page.vector_stale) continue;
        try {
          result.embedded += await writeEmbeddings(settings, page, chunks);
          result.indexed += 1;
          lastIndexerError = null;
          lastIndexedAt = new Date().toISOString();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          lastIndexerError = message;
          await pool
            .query(
              `INSERT INTO page_index_state (page_id, content_hash, model, chunk_count, error, indexed_at)
               VALUES ($1, '', $2, 0, $3, NOW())
               ON CONFLICT (page_id) DO UPDATE SET error = EXCLUDED.error, indexed_at = NOW()`,
              [page.id, model, message],
            )
            .catch(() => undefined);
          // 엔드포인트 문제는 모든 페이지에 똑같이 실패하므로 벡터 작업만 잠시 쉰다 (텍스트는 계속).
          backoffUntil = Date.now() + ERROR_BACKOFF_MS;
          vectorActive = false;
          console.error(`[embedding] ${page.id} 임베딩 실패:`, message);
        }
      }
      if (result.textIndexed > 0 || result.indexed > 0) {
        console.log(
          `[search] 텍스트 ${result.textIndexed}개 · 임베딩 ${result.indexed}개 페이지 인덱싱 (새 임베딩 ${result.embedded}개)`,
        );
      }
    } finally {
      await lockClient.query("SELECT pg_advisory_unlock($1)", [INDEXER_LOCK_KEY]).catch(() => undefined);
    }
  } finally {
    lockClient.release();
    indexerRunning = false;
  }
  return result;
}

/** 업로드 직후처럼 바로 처리할 일이 생겼을 때 다음 주기를 기다리지 않고 곧 실행한다. */
function scheduleIndexerSoon(): void {
  if (soonTimer) return;
  soonTimer = setTimeout(() => {
    soonTimer = null;
    void runIndexerTick().catch((error) => console.error("[embedding] 인덱서 오류:", error));
  }, 500);
  soonTimer.unref();
}

export function startEmbeddingIndexer(): void {
  if (indexerTimer) return;
  indexerTimer = setInterval(() => {
    void runIndexerTick().catch((error) => console.error("[embedding] 인덱서 오류:", error));
  }, INDEX_INTERVAL_MS);
  indexerTimer.unref();
}

/** 설정이 바뀌었을 때 즉시 다시 시도하도록 대기 상태를 풀어준다. */
export function resetEmbeddingBackoff(): void {
  backoffUntil = 0;
  lastIndexerError = null;
}

export async function requestFullReindex(): Promise<void> {
  await clearIndexState();
  resetEmbeddingBackoff();
}

/** DB 기준 상태(공유 모듈) + 이 프로세스의 인덱서 상태(최근 오류, 쉬는 중) */
export async function getEmbeddingStatus() {
  const status = await getIndexingStatus();
  return {
    ...status,
    lastError: lastIndexerError ?? status.lastError,
    lastIndexedAt,
    pausedUntil: backoffUntil > Date.now() ? new Date(backoffUntil).toISOString() : null,
  };
}

/* --------------------------------------------------------------------------
 * 벡터 검색
 * ------------------------------------------------------------------------ */

export interface SemanticSearchHit {
  pageId: string;
  pageTitle: string;
  blockId: string | null;
  kind: ChunkKind;
  chunkIndex: number;
  /** 파일 내용에서 찾은 경우 */
  attachmentId: string | null;
  attachmentName: string | null;
  content: string;
  /** 코사인 유사도 (1에 가까울수록 유사) */
  score: number;
}

export async function semanticSearch(userId: string, query: string, limit = 10): Promise<SemanticSearchHit[]> {
  const text = query.trim();
  if (!text) return [];
  const config = await getSystemSettingsFromDb(false);
  const settings = config.embedding;
  if (!settings.enabled) throw new Error("임베딩 검색이 꺼져 있습니다. 설정에서 임베딩을 켜 주세요.");

  const [vector] = await embedTexts(settings, [text]);
  const dims = Math.floor(vector.length); // 쿼리에 직접 넣어 차원별 부분 인덱스가 선택되게 한다
  const spec = vectorCastFor(dims);
  const castExpr = spec ? `embedding::${spec.cast}` : "embedding";
  const paramCast = spec ? spec.cast : "vector";
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // 모델/차원 필터와 함께 HNSW 를 쓰면 결과가 모자랄 수 있어 iterative scan 을 켠다 (pgvector 0.8+).
    if (spec) await client.query("SET LOCAL hnsw.iterative_scan = relaxed_order");
    const res = await client.query<{
      page_id: string;
      title: string;
      block_id: string | null;
      kind: ChunkKind;
      chunk_index: number;
      attachment_id: string | null;
      attachment_name: string | null;
      content: string;
      distance: number;
    }>(
      `SELECT e.page_id, p.title, e.block_id, e.kind, e.chunk_index, e.attachment_id, a.original_name AS attachment_name,
              e.content, e.distance
         FROM (
           SELECT page_id, block_id, kind, chunk_index, attachment_id, content, ${castExpr} <=> $1::${paramCast} AS distance
             FROM page_embeddings
            WHERE dims = ${dims} AND model = $2
            ORDER BY ${castExpr} <=> $1::${paramCast}
            LIMIT $3
         ) e
         JOIN pages p ON p.id = e.page_id
         LEFT JOIN attachments a ON a.id = e.attachment_id
        WHERE p.deleted_at IS NULL
        ORDER BY e.distance`,
      [toVectorLiteral(vector), embeddingModelKey(settings), safeLimit],
    );
    await client.query("COMMIT");
    return res.rows.map((row) => ({
      pageId: row.page_id,
      pageTitle: row.title,
      blockId: row.block_id,
      kind: row.kind,
      chunkIndex: row.chunk_index,
      attachmentId: row.attachment_id,
      attachmentName: row.attachment_name,
      content: row.content,
      score: 1 - Number(row.distance),
    }));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
