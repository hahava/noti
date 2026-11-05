import { getSystemSettingsFromDb, pgroongaAvailable, pool } from "./db.js";
import { semanticSearch, type ChunkKind } from "./embeddings.js";
import { findConcepts, type ConceptListItem } from "./wiki-concepts.js";

/**
 * 하이브리드 검색: 키워드(PGroonga) + 의미(pgvector) 결과를 조각 단위로 합친 뒤 페이지별로 묶는다.
 *  - 키워드: page_chunks 전문 검색. PGroonga 가 없으면 ILIKE 로 대체.
 *  - 의미: page_embeddings 코사인 유사도 (임베딩이 켜져 있을 때만)
 *  - 합치기: RRF(Reciprocal Rank Fusion) — 점수 척도가 다른 두 결과를 순위로만 합친다.
 *  - 공유 워크스페이스: 로그인한 사용자가 볼 수 있는 페이지(삭제되지 않은 전체)를 검색한다.
 *    페이지 목록·본문 REST, 협업 서버와 같은 접근 기준이다.
 */

const RRF_K = 60;
const CANDIDATES_PER_SOURCE = 40;
/** 의미 검색 결과 중 1등 대비 이만큼 이상 낮은 조각은 버린다 (모델마다 점수 척도가 달라 상대값 사용) */
const SEMANTIC_RELATIVE_CUTOFF = 0.15;
const SEMANTIC_MIN_RATIO = 0.8;
const SNIPPET_BEFORE = 40;
const SNIPPET_AFTER = 110;

interface ChunkHit {
  pageId: string;
  pageTitle: string;
  pageIcon: string | null;
  kind: ChunkKind;
  chunkIndex: number;
  blockId: string | null;
  attachmentId: string | null;
  attachmentName: string | null;
  content: string;
}

export interface SearchResult {
  pageId: string;
  pageTitle: string;
  pageIcon: string | null;
  /** 가장 잘 맞는 조각의 위치: "제목 > 헤딩" 또는 "제목 > 📎 파일명 (3쪽)" */
  context: string;
  snippet: string;
  blockId: string | null;
  attachmentId: string | null;
  attachmentName: string | null;
  matchedBy: Array<"keyword" | "semantic">;
  score: number;
}

export interface SearchResponse {
  results: SearchResult[];
  /** 질의와 맞는 LLM 위키 개념 */
  concepts?: ConceptListItem[];
  /** 클라이언트 하이라이트용 키워드 */
  keywords: string[];
  engines: { keyword: "pgroonga" | "basic"; semantic: boolean };
  semanticError?: string;
}

/** 길이가 긴 것부터 확인하는 한국어 조사 목록 */
const KOREAN_PARTICLES = [
  "에서부터", "으로부터", "에게서", "한테서", "으로서", "으로써", "이라고", "에서", "에게", "한테", "께서", "부터",
  "까지", "마저", "조차", "처럼", "보다", "으로", "이나", "이랑", "라고", "하고", "은", "는", "이", "가", "을",
  "를", "의", "에", "와", "과", "도", "만", "로", "나", "랑",
];

/** 단어 끝 조사를 뗀 형태. 남는 부분이 2글자 미만이면 떼지 않는다. */
export function stripKoreanParticle(term: string): string {
  if (!/[가-힣]$/.test(term)) return term;
  for (const particle of KOREAN_PARTICLES) {
    if (term.endsWith(particle) && term.length - particle.length >= 2) return term.slice(0, -particle.length);
  }
  return term;
}

/**
 * 2글자 N-gram 색인은 "레플리카를"처럼 조사가 붙은 검색어를 놓친다.
 * 문법 기호가 없는 일반 단어는 (원형 OR 조사 뗀 형태)로 바꿔서 둘 다 찾게 한다.
 */
export function expandKoreanQuery(query: string): string {
  return (query.match(/"[^"]*"|\S+/g) ?? [])
    .map((token) => {
      if (token === "OR" || /^[-+(]|["()\\*]/.test(token)) return token;
      const stripped = stripKoreanParticle(token);
      return stripped === token ? token : `(${token} OR ${stripped})`;
    })
    .join(" ");
}

/** 검색 방식: all = 모든 단어 포함(⌘K), any = 하나라도 포함하고 많이 맞을수록 위로(문장형 AI 질문) */
export type KeywordMode = "all" | "any";

/** 문장형 질문용: 단어마다 (원형 OR 조사 뗀 형태)로 만들고 전체를 OR 로 잇는다. */
export function toAnyQuery(query: string): string {
  const terms = query
    .replace(/["()\\]/g, " ")
    .split(/\s+/)
    .map((term) => term.replace(/^[-+]+|[?!.,;:~…]+$/g, "").trim())
    .filter((term) => term && term !== "OR" && term.length >= 2);
  return Array.from(new Set(terms))
    .map((term) => {
      const stripped = stripKoreanParticle(term);
      return stripped === term ? term : `(${term} OR ${stripped})`;
    })
    .join(" OR ");
}

function splitTerms(query: string): string[] {
  return Array.from(new Set(query.split(/\s+/).map((term) => term.replace(/^[-+]|["()]/g, "").trim()).filter(Boolean)));
}

type ChunkRow = {
  page_id: string;
  title: string;
  icon: string | null;
  kind: ChunkKind;
  chunk_index: number;
  block_id: string | null;
  attachment_id: string | null;
  attachment_name: string | null;
  content: string;
};

function toChunkHit(row: ChunkRow): ChunkHit {
  return {
    pageId: row.page_id,
    pageTitle: row.title,
    pageIcon: row.icon,
    kind: row.kind,
    chunkIndex: row.chunk_index,
    blockId: row.block_id,
    attachmentId: row.attachment_id,
    attachmentName: row.attachment_name,
    content: row.content,
  };
}

const CHUNK_SELECT = `
  SELECT c.page_id, p.title, p.icon, c.kind, c.chunk_index, c.block_id, c.attachment_id,
         a.original_name AS attachment_name, c.content`;
const CHUNK_JOINS = `
  FROM page_chunks c
  JOIN pages p ON p.id = c.page_id
  LEFT JOIN attachments a ON a.id = c.attachment_id`;

/** PGroonga 쿼리 문법(OR, -제외, "구문")으로 검색하고, 문법 오류면 이스케이프해서 다시 시도한다. */
async function pgroongaSearch(
  userId: string,
  query: string,
  limit: number,
  mode: KeywordMode,
): Promise<{ hits: ChunkHit[]; keywords: string[] }> {
  const run = async (groongaQuery: string, escape: boolean) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // pgroonga_score 는 PGroonga 인덱스로 찾았을 때만 의미가 있어서 순차 스캔을 막는다.
      await client.query("SET LOCAL enable_seqscan = off");
      const queryExpr = escape ? "pgroonga_query_escape($1)" : "$1";
      const res = await client.query<ChunkRow & { score: number }>(
        `${CHUNK_SELECT}, pgroonga_score(c.tableoid, c.ctid) AS score
         ${CHUNK_JOINS}
         WHERE c.content &@~ ${queryExpr}
           AND p.deleted_at IS NULL
         ORDER BY score DESC, length(c.content) ASC
         LIMIT $2`,
        [groongaQuery, limit],
      );
      const keywords = await client.query<{ keywords: string[] }>(
        `SELECT pgroonga_query_extract_keywords(${queryExpr}) AS keywords`,
        [groongaQuery],
      );
      await client.query("COMMIT");
      return { hits: res.rows.map(toChunkHit), keywords: keywords.rows[0]?.keywords ?? [] };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };
  // PGroonga 는 문법 오류를 에러 대신 "문자 그대로 검색"으로 처리해서 결과가 0건이 된다.
  // 짝이 안 맞는 따옴표/괄호는 미리 지운다.
  let balanced = query;
  if ((balanced.match(/"/g) ?? []).length % 2 === 1) balanced = balanced.replace(/"/g, " ");
  const opens = (balanced.match(/\(/g) ?? []).length;
  const closes = (balanced.match(/\)/g) ?? []).length;
  if (opens !== closes) balanced = balanced.replace(/[()]/g, " ");
  balanced = balanced.replace(/\s+/g, " ").trim();
  if (!balanced) return { hits: [], keywords: [] };
  query = balanced;

  if (mode === "any") {
    const anyQuery = toAnyQuery(query);
    if (!anyQuery) return { hits: [], keywords: [] };
    return run(anyQuery, false);
  }

  try {
    return await run(expandKoreanQuery(query), false);
  } catch {
    // 짝이 안 맞는 따옴표/괄호 등 쿼리 문법 오류 → 기호를 빼고 단어만으로 다시 검색
    const plain = query.replace(/["()\\]/g, " ").replace(/\s+/g, " ").trim();
    try {
      if (plain) return await run(expandKoreanQuery(plain), false);
    } catch {
      // 그래도 실패하면 아래에서 문자 그대로 검색
    }
    return run(query, true);
  }
}

/** PGroonga 가 없을 때: 모든 단어를 포함하는 조각 (ILIKE) */
async function basicKeywordSearch(
  userId: string,
  query: string,
  limit: number,
  mode: KeywordMode,
): Promise<{ hits: ChunkHit[]; keywords: string[] }> {
  const terms = splitTerms(query)
    .map((term) => term.replace(/[?!.,;:~…]+$/g, ""))
    .filter((term) => (mode === "any" ? term.length >= 2 : term.length > 0));
  if (terms.length === 0) return { hits: [], keywords: [] };
  // 조사를 뗀 형태로 찾으면 원형도 포함되므로 조사 뗀 형태만 쓴다.
  const patterns = terms.map((term) => `%${stripKoreanParticle(term).replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
  const res = await pool.query<ChunkRow>(
    `${CHUNK_SELECT}
     ${CHUNK_JOINS}
     WHERE c.content ILIKE ${mode === "any" ? "ANY" : "ALL"}($1::text[])
       AND p.deleted_at IS NULL
     ORDER BY (SELECT COUNT(*) FROM unnest($1::text[]) AS pattern WHERE c.content ILIKE pattern) DESC,
              length(c.content) ASC
     LIMIT $2`,
    [patterns, limit],
  );
  return { hits: res.rows.map(toChunkHit), keywords: terms.map(stripKoreanParticle) };
}

export async function keywordSearch(userId: string, query: string, limit = CANDIDATES_PER_SOURCE, mode: KeywordMode = "all") {
  return pgroongaAvailable
    ? pgroongaSearch(userId, query, limit, mode)
    : basicKeywordSearch(userId, query, limit, mode);
}

/** 조각 첫 줄(맥락)을 떼고, 첫 키워드 주변을 잘라 스니펫을 만든다. */
function buildSnippet(content: string, keywords: string[]): { context: string; snippet: string } {
  const newline = content.indexOf("\n");
  const context = newline >= 0 ? content.slice(0, newline) : content;
  const body = (newline >= 0 ? content.slice(newline + 1) : "").replace(/\s+/g, " ").trim();
  if (!body) return { context, snippet: "" };
  const lower = body.toLowerCase();
  let position = -1;
  for (const keyword of keywords) {
    const index = lower.indexOf(keyword.toLowerCase());
    if (index >= 0 && (position < 0 || index < position)) position = index;
  }
  if (position < 0) return { context, snippet: body.slice(0, SNIPPET_BEFORE + SNIPPET_AFTER) + (body.length > SNIPPET_BEFORE + SNIPPET_AFTER ? "…" : "") };
  const start = Math.max(0, position - SNIPPET_BEFORE);
  const end = Math.min(body.length, position + SNIPPET_AFTER);
  return { context, snippet: `${start > 0 ? "…" : ""}${body.slice(start, end)}${end < body.length ? "…" : ""}` };
}

type FusedChunk = { hit: ChunkHit; score: number; matchedBy: Set<"keyword" | "semantic"> };

/** 키워드 + 의미 결과를 조각 단위로 합친다 (점수 내림차순). ⌘K 검색과 AI 워크스페이스 참고가 함께 쓴다. */
async function fuseChunks(userId: string, query: string, mode: KeywordMode = "all") {
  const config = await getSystemSettingsFromDb(false);
  const semanticEnabled = config.embedding.enabled;
  const engines = { keyword: pgroongaAvailable ? ("pgroonga" as const) : ("basic" as const), semantic: semanticEnabled };

  const [keywordResult, semanticResult] = await Promise.all([
    keywordSearch(userId, query, CANDIDATES_PER_SOURCE, mode),
    semanticEnabled
      ? semanticSearch(userId, query, CANDIDATES_PER_SOURCE).then(
          (hits) => ({ hits, error: undefined as string | undefined }),
          (error) => ({ hits: [], error: error instanceof Error ? error.message : String(error) }),
        )
      : Promise.resolve({ hits: [], error: undefined as string | undefined }),
  ]);

  // 의미 검색은 관련 없어도 항상 k개를 돌려주므로 1등 대비 너무 낮은 조각은 버린다.
  // 절대 차이와 비율 중 더 엄격한 기준을 쓴다 (모델마다 점수 척도가 다름).
  const topSemantic = semanticResult.hits[0]?.score ?? 0;
  const semanticFloor = Math.max(topSemantic - SEMANTIC_RELATIVE_CUTOFF, topSemantic * SEMANTIC_MIN_RATIO);
  const semanticHits = semanticResult.hits.filter((hit) => hit.score >= semanticFloor);

  // RRF: 조각마다 각 결과에서의 순위로 점수를 더한다.
  const fused = new Map<string, FusedChunk>();
  const add = (hit: ChunkHit, rank: number, source: "keyword" | "semantic") => {
    const key = `${hit.pageId}:${hit.kind}:${hit.chunkIndex}`;
    const entry = fused.get(key) ?? { hit, score: 0, matchedBy: new Set() };
    entry.score += 1 / (RRF_K + rank + 1);
    entry.matchedBy.add(source);
    fused.set(key, entry);
  };
  keywordResult.hits.forEach((hit, rank) => add(hit, rank, "keyword"));
  semanticHits.forEach((hit, rank) =>
    add(
      {
        pageId: hit.pageId,
        pageTitle: hit.pageTitle,
        pageIcon: null,
        kind: hit.kind,
        chunkIndex: hit.chunkIndex,
        blockId: hit.blockId,
        attachmentId: hit.attachmentId,
        attachmentName: hit.attachmentName,
        content: hit.content,
      },
      rank,
      "semantic",
    ),
  );

  return {
    chunks: Array.from(fused.values()).sort((a, b) => b.score - a.score),
    keywords: keywordResult.keywords.length > 0 ? keywordResult.keywords : splitTerms(query),
    engines,
    semanticError: semanticResult.error,
  };
}

/** AI 에게 넘길 출처 조각 */
export interface RetrievedSource {
  /** 답변에서 인용할 번호 [n] (1부터) */
  n: number;
  pageId: string;
  pageTitle: string;
  context: string;
  content: string;
  blockId: string | null;
  attachmentName: string | null;
}

/**
 * AI 워크스페이스 참고용 조각 검색.
 * 점수 순으로 페이지당 최대 maxPerPage 개, 전체 maxChars 안에서 조각 전체 내용을 돌려준다.
 */
export async function retrieveSources(
  userId: string,
  rawQuery: string,
  options: { maxSources?: number; maxPerPage?: number; maxChars?: number } = {},
): Promise<{ sources: RetrievedSource[]; semanticError?: string }> {
  const query = rawQuery.trim().slice(0, 300);
  if (!query) return { sources: [] };
  const { maxSources = 8, maxPerPage = 3, maxChars = 9000 } = options;
  // 문장형 질문이라 모든 단어가 들어 있는 조각은 드물다 → 하나라도 맞으면 찾고 많이 맞는 순으로.
  const { chunks, semanticError } = await fuseChunks(userId, query, "any");

  const perPage = new Map<string, number>();
  const sources: RetrievedSource[] = [];
  let total = 0;
  for (const { hit } of chunks) {
    if (sources.length >= maxSources) break;
    const count = perPage.get(hit.pageId) ?? 0;
    if (count >= maxPerPage) continue;
    if (total + hit.content.length > maxChars && sources.length > 0) continue;
    const newline = hit.content.indexOf("\n");
    sources.push({
      n: sources.length + 1,
      pageId: hit.pageId,
      pageTitle: hit.pageTitle,
      context: newline >= 0 ? hit.content.slice(0, newline) : hit.content,
      content: newline >= 0 ? hit.content.slice(newline + 1) : "",
      blockId: hit.blockId,
      attachmentName: hit.attachmentName,
    });
    perPage.set(hit.pageId, count + 1);
    total += hit.content.length;
  }
  return { sources, semanticError };
}

export async function hybridSearch(userId: string, rawQuery: string, limit = 20): Promise<SearchResponse> {
  const query = rawQuery.trim().slice(0, 200);
  if (!query) {
    const config = await getSystemSettingsFromDb(false);
    return {
      results: [],
      keywords: [],
      engines: { keyword: pgroongaAvailable ? "pgroonga" : "basic", semantic: config.embedding.enabled },
    };
  }
  const [{ chunks, keywords, engines, semanticError }, concepts] = await Promise.all([
    fuseChunks(userId, query),
    findConcepts(query, 3).catch(() => [] as ConceptListItem[]),
  ]);

  // 페이지별로 가장 점수가 높은 조각을 대표로 쓴다. 다른 조각들도 맞으면 조금 가산한다.
  const byPage = new Map<string, { best: FusedChunk; extra: number; matchedBy: Set<"keyword" | "semantic"> }>();
  for (const entry of chunks) {
    const current = byPage.get(entry.hit.pageId);
    if (!current) {
      byPage.set(entry.hit.pageId, { best: entry, extra: 0, matchedBy: new Set(entry.matchedBy) });
      continue;
    }
    entry.matchedBy.forEach((source) => current.matchedBy.add(source));
    if (entry.score > current.best.score) {
      current.extra += current.best.score * 0.1;
      current.best = entry;
    } else {
      current.extra += entry.score * 0.1;
    }
  }

  // 아이콘은 키워드 결과에만 있으므로 의미 검색으로만 찾은 페이지는 한 번에 채운다.
  const missingIcons = Array.from(byPage.values()).filter((page) => page.best.hit.pageIcon === null).map((page) => page.best.hit.pageId);
  const icons = new Map<string, string | null>();
  if (missingIcons.length > 0) {
    const res = await pool.query<{ id: string; icon: string | null }>("SELECT id, icon FROM pages WHERE id = ANY($1::text[])", [missingIcons]);
    res.rows.forEach((row) => icons.set(row.id, row.icon));
  }

  const results = Array.from(byPage.values())
    .map(({ best, extra, matchedBy }) => {
      const { context, snippet } = buildSnippet(best.hit.content, keywords);
      return {
        pageId: best.hit.pageId,
        pageTitle: best.hit.pageTitle,
        pageIcon: best.hit.pageIcon ?? icons.get(best.hit.pageId) ?? null,
        context,
        snippet,
        blockId: best.hit.blockId,
        attachmentId: best.hit.attachmentId,
        attachmentName: best.hit.attachmentName,
        matchedBy: Array.from(matchedBy).sort(),
        score: best.score + extra,
      } satisfies SearchResult;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(50, limit)));

  return { results, concepts, keywords, engines, semanticError };
}
