-- PostgreSQL + pgvector 초기화 스크립트
CREATE EXTENSION IF NOT EXISTS vector;

-- 0. 사전 발급 사용자 계정 및 세션 테이블
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'editor',     -- admin | editor | viewer
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'editor';

CREATE TABLE IF NOT EXISTS user_sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days')
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);

-- 1. 페이지(문서) 및 계층 트리 테이블
CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '제목 없는 문서',
  icon TEXT,
  page_width VARCHAR(32) NOT NULL DEFAULT 'default',
  parent_id TEXT REFERENCES pages(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  blocks JSONB NOT NULL DEFAULT '[]'::jsonb,
  plain_text TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE pages ADD COLUMN IF NOT EXISTS icon TEXT;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS page_width VARCHAR(32) NOT NULL DEFAULT 'default';
ALTER TABLE pages ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS deleted_root_id TEXT;
CREATE INDEX IF NOT EXISTS idx_pages_deleted_at ON pages(deleted_at);
-- 서버가 본문(blocks)을 직접 수정한 시각. 협업(Yjs) 상태보다 최신이면 Yjs 를 REST 본문으로 다시 시드한다.
-- (제목/아이콘/순서 같은 메타데이터 변경은 updated_at 만 갱신하므로 Yjs 를 버리지 않는다.)
ALTER TABLE pages ADD COLUMN IF NOT EXISTS blocks_server_modified_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_pages_parent_id ON pages(parent_id);
CREATE INDEX IF NOT EXISTS idx_pages_user_id ON pages(user_id);

-- 2. 페이지 간 링크 그래프 테이블 (정방향 링크 & 역방향 백링크 조회용)
CREATE TABLE IF NOT EXISTS page_links (
  source_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_id, target_id)
);

CREATE INDEX IF NOT EXISTS idx_page_links_target_id ON page_links(target_id);

-- 3. 임베딩 테이블 (pgvector 기반 시맨틱 검색 / LLM 위키 정리본)
-- 예전의 고정 차원(vector(1536)) block_embeddings 는 사용된 적이 없으므로 비어 있으면 제거한다.
DO $$
BEGIN
  -- 표가 없는 새 DB 에서는 SELECT 자체가 실패하므로 존재 여부를 먼저 따로 확인한다.
  IF to_regclass('public.block_embeddings') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM block_embeddings LIMIT 1) THEN
      DROP TABLE block_embeddings;
    END IF;
  END IF;
END $$;

-- 차원을 고정하지 않은 vector 컬럼에 모델/차원을 함께 저장한다.
-- 모델을 바꿔도(예: bge-m3 1024 → 다른 모델 768) 스키마 변경 없이 다시 인덱싱만 하면 된다.
-- HNSW 인덱스는 차원별 부분 인덱스로 서버가 필요할 때 만든다 (idx_page_embeddings_hnsw_d<차원>).
CREATE TABLE IF NOT EXISTS page_embeddings (
  id BIGSERIAL PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'chunk',           -- chunk: 본문 조각, digest: LLM 정리본(예정)
  chunk_index INTEGER NOT NULL,
  block_id TEXT,                                -- 조각이 시작되는 블록 (검색 결과에서 이동용)
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,                   -- 바뀐 조각만 다시 임베딩하기 위한 해시
  model TEXT NOT NULL,                          -- "<provider>:<model>"
  dims INTEGER NOT NULL,
  embedding vector NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (page_id, kind, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_page_embeddings_user_model ON page_embeddings(user_id, model);

-- 3-1. 첨부파일 (업로드 기록 + 추출 텍스트)
-- id 는 디스크에 저장된 파일명(<uuid>.<ext>)과 같다. 본문 블록의 url(/uploads/<id>)로 페이지와 연결된다.
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT '',
  size_bytes BIGINT NOT NULL DEFAULT 0,
  -- pending: 추출 대기, done: 추출 완료, empty: 텍스트 없음, unsupported: 미지원 형식, failed: 오류
  extract_status TEXT NOT NULL DEFAULT 'pending',
  extract_message TEXT,
  segments JSONB,                               -- [{ "label": "3쪽", "text": "..." }, ...]
  char_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  extracted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_attachments_status ON attachments(extract_status);

-- 파일에서 나온 조각(kind = 'file')은 어느 첨부파일인지 기록한다.
ALTER TABLE page_embeddings ADD COLUMN IF NOT EXISTS attachment_id TEXT;

-- 텍스트 조각 (키워드 검색용, 임베딩 설정과 무관하게 항상 유지)
-- page_embeddings 와 같은 (page_id, kind, chunk_index) 로 조각을 식별해서 두 검색 결과를 합친다.
-- 한국어 전문 검색 인덱스(PGroonga)는 확장이 설치된 경우에만 서버가 만든다 (idx_page_chunks_pgroonga).
CREATE TABLE IF NOT EXISTS page_chunks (
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  block_id TEXT,
  attachment_id TEXT,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  PRIMARY KEY (page_id, kind, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_page_chunks_user_id ON page_chunks(user_id);

-- LLM 위키: 페이지 정리본 (백그라운드 모델이 페이지 + 첨부파일 내용을 읽고 만든 요약/개념/결정/할 일)
-- source_hash 는 정리할 때 읽은 텍스트 조각(page_chunks)의 해시. 조각이 바뀌면(첨부파일 포함) 다시 만든다.
CREATE TABLE IF NOT EXISTS page_digests (
  page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  model TEXT NOT NULL,                          -- "<provider>:<model>"
  status TEXT NOT NULL,                         -- done | skipped(내용이 너무 짧음) | failed
  summary TEXT NOT NULL DEFAULT '',
  key_points JSONB NOT NULL DEFAULT '[]'::jsonb,     -- string[]
  concepts JSONB NOT NULL DEFAULT '[]'::jsonb,       -- [{ "name", "description" }]
  decisions JSONB NOT NULL DEFAULT '[]'::jsonb,      -- string[]
  action_items JSONB NOT NULL DEFAULT '[]'::jsonb,   -- string[]
  open_questions JSONB NOT NULL DEFAULT '[]'::jsonb, -- string[]
  truncated BOOLEAN NOT NULL DEFAULT FALSE,     -- 입력이 길어 앞부분만 읽은 경우
  error TEXT,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 다시 만들다 실패하면 이전 정리본은 그대로 두고 실패 기록만 남긴다 (같은 내용으로 바로 재시도하지 않도록).
ALTER TABLE page_digests ADD COLUMN IF NOT EXISTS failed_source_hash TEXT;
ALTER TABLE page_digests ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ;

-- LLM 위키: 개념 색인
-- 페이지 정리본(page_digests.concepts)의 개념을 정규화한 이름으로 묶는다. 언급(mentions)은 LLM 없이 바로 만들고,
-- 2개 이상 페이지에서 언급된 개념은 백그라운드 모델이 여러 문서를 종합한 개념 글(article)을 만든다.
CREATE TABLE IF NOT EXISTS wiki_concepts (
  id TEXT PRIMARY KEY,                          -- "concept-" + md5(normalized_name) 앞 16자
  name TEXT NOT NULL,                           -- 처음 발견된 표기
  normalized_name TEXT NOT NULL UNIQUE,         -- 대소문자·전각·공백 등을 통일한 키
  article JSONB,                                -- { summary, points: [{ text, pageIds }], conflicts: [] }
  article_status TEXT,                          -- done | failed
  article_source_hash TEXT,                     -- 종합할 때 읽은 언급/정리본의 해시
  article_model TEXT,
  article_error TEXT,
  article_generated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wiki_concept_mentions (
  concept_id TEXT NOT NULL REFERENCES wiki_concepts(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  description TEXT NOT NULL DEFAULT '',          -- 이 페이지에서 그 개념의 의미/맥락
  PRIMARY KEY (concept_id, page_id)
);

CREATE INDEX IF NOT EXISTS idx_wiki_concept_mentions_page ON wiki_concept_mentions(page_id);

-- 페이지별 인덱싱 상태. content_hash 가 현재 본문과 다르거나 model 이 바뀌면 다시 인덱싱한다.
CREATE TABLE IF NOT EXISTS page_index_state (
  page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 텍스트 조각(page_chunks)을 만든 본문 해시. content_hash/model 은 임베딩 기준이다.
ALTER TABLE page_index_state ADD COLUMN IF NOT EXISTS text_hash TEXT;

-- 4. 워크스페이스 상태 테이블 (마지막 열린 페이지 및 계정별 탭/분할 레이아웃)
CREATE TABLE IF NOT EXISTS workspace_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_workspace_state (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, key)
);

-- 5. Yjs 협업 문서 원본
-- REST의 pages.blocks(JSONB)는 현재 에디터가 사용하는 뷰이며,
-- 협업 모드가 활성화되면 이 BYTEA 상태가 충돌 병합 가능한 원본이 됩니다.
CREATE TABLE IF NOT EXISTS collaboration_documents (
  document_name TEXT PRIMARY KEY,
  page_id TEXT NOT NULL UNIQUE REFERENCES pages(id) ON DELETE CASCADE,
  yjs_state BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (document_name = 'page:' || page_id)
);

CREATE INDEX IF NOT EXISTS idx_collaboration_documents_page_id
  ON collaboration_documents(page_id);

-- 독립 데이터베이스: 문서의 컬렉션 블록은 이 ID를 참조하는 뷰다.
CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  owner_page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT '컬렉션',
  initial_data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS collection_documents (
  collection_id TEXT PRIMARY KEY REFERENCES collections(id) ON DELETE CASCADE,
  yjs_state BYTEA NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. 시스템 관리자 설정 테이블 (AI 모델, 스토리지 디렉터리, Redis/DB 연결 등)
CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
);
