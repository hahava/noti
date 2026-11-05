import { useEffect, useState } from "react";
import { workspaceApi } from "./api";
import type { WikiConceptListItem, WikiOverview } from "./vite-env";

/* ==========================================================================
 * AI 패널 "위키" 탭 첫 화면
 * 주제(개념) 검색·목록, 문서 간 불일치, 모든 페이지의 할 일을 보여준다.
 * ========================================================================== */

interface WikiHomeProps {
  overview: WikiOverview | null;
  loading: boolean;
  error: string | null;
  onOpenConcept: (conceptId: string) => void;
  onOpenPage: (pageId: string) => void;
}

const SEARCH_DEBOUNCE_MS = 250;
const ACTIONS_COLLAPSED = 6;

function ConceptRow({ concept, onOpen }: { concept: WikiConceptListItem; onOpen: () => void }) {
  return (
    <li>
      <button type="button" className="wiki-home__concept" onClick={onOpen}>
        <span className="wiki-home__concept-head">
          <span className="wiki-home__concept-icon" aria-hidden="true">◆</span>
          <strong>{concept.name}</strong>
          <span className="wiki-home__count">{concept.pageCount}페이지</span>
        </span>
        {concept.summary && <span className="wiki-home__concept-summary">{concept.summary}</span>}
      </button>
    </li>
  );
}

export function WikiHome({ overview, loading, error, onOpenConcept, onOpenPage }: WikiHomeProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WikiConceptListItem[] | null>(null);
  const [showAllActions, setShowAllActions] = useState(false);

  // 주제 검색 (입력이 멈춘 뒤)
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      workspaceApi
        .findWikiConcepts(trimmed, 20)
        .then((res) => {
          if (!cancelled) setResults(res.concepts);
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  const isEmpty = overview && overview.stats.pagesWithDigest === 0;
  // 여러 페이지에 걸친 주제를 먼저, 한 페이지에서만 나온 주제는 뒤에 접어서
  const sharedConcepts = (overview?.concepts ?? []).filter((concept) => concept.pageCount >= 2);
  const singleConcepts = (overview?.concepts ?? []).filter((concept) => concept.pageCount < 2);
  const actions = overview?.actionItems ?? [];
  const visibleActions = showAllActions ? actions : actions.slice(0, ACTIONS_COLLAPSED);

  return (
    <div className="wiki-home">
      <input
        type="search"
        className="wiki-home__search"
        placeholder="주제 검색…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        aria-label="위키 주제 검색"
      />

      {error && <div className="ai-panel__error">{error}</div>}
      {loading && !overview && <div className="wiki-home__muted">불러오는 중…</div>}

      {results ? (
        <section className="wiki-home__section">
          <div className="wiki-home__section-title">검색 결과</div>
          {results.length === 0 ? (
            <div className="wiki-home__muted">일치하는 주제가 없습니다.</div>
          ) : (
            <ul className="wiki-home__list">
              {results.map((concept) => (
                <ConceptRow key={concept.id} concept={concept} onOpen={() => onOpenConcept(concept.id)} />
              ))}
            </ul>
          )}
        </section>
      ) : isEmpty ? (
        <div className="wiki-home__empty">
          <strong>아직 위키가 비어 있습니다</strong>
          <span>
            페이지가 바뀌면 AI가 정리 노트를 만들고, 여러 페이지에 나오는 주제를 모아 위키를 채웁니다. 설정(⌘,)의 "LLM 위키 ·
            백그라운드 작업"이 켜져 있어야 합니다.
          </span>
        </div>
      ) : (
        overview && (
          <>
            {overview.conflicts.length > 0 && (
              <section className="wiki-home__section wiki-home__conflicts">
                <div className="wiki-home__section-title">⚠ 확인 필요 · 문서끼리 다른 내용</div>
                <ul className="wiki-home__list">
                  {overview.conflicts.map((conflict, index) => (
                    <li key={index} className="wiki-home__conflict">
                      <span>{conflict.text}</span>
                      <span className="wiki-home__links">
                        {conflict.pages.map((page) => (
                          <button key={page.pageId} type="button" className="wiki-concept__chip" onClick={() => onOpenPage(page.pageId)}>
                            {page.pageTitle}
                          </button>
                        ))}
                        <button type="button" className="wiki-home__text-btn" onClick={() => onOpenConcept(conflict.conceptId)}>
                          {conflict.conceptName} 항목 보기
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="wiki-home__section">
              <div className="wiki-home__section-title">주제</div>
              {sharedConcepts.length === 0 && singleConcepts.length === 0 ? (
                <div className="wiki-home__muted">아직 정리된 주제가 없습니다.</div>
              ) : (
                <ul className="wiki-home__list">
                  {sharedConcepts.map((concept) => (
                    <ConceptRow key={concept.id} concept={concept} onOpen={() => onOpenConcept(concept.id)} />
                  ))}
                </ul>
              )}
              {singleConcepts.length > 0 && (
                <details className="wiki-home__more">
                  <summary>한 페이지에서만 나온 주제 {singleConcepts.length}개</summary>
                  <div className="wiki-home__tags">
                    {singleConcepts.map((concept) => (
                      <button key={concept.id} type="button" className="ai-digest__concept" onClick={() => onOpenConcept(concept.id)}>
                        {concept.name}
                      </button>
                    ))}
                  </div>
                </details>
              )}
            </section>

            {actions.length > 0 && (
              <section className="wiki-home__section">
                <div className="wiki-home__section-title">할 일 (모든 페이지의 AI 정리)</div>
                <ul className="wiki-home__list">
                  {visibleActions.map((action, index) => (
                    <li key={index}>
                      <button type="button" className="wiki-home__action" onClick={() => onOpenPage(action.pageId)}>
                        <span>□ {action.text}</span>
                        <span className="wiki-home__action-page">{action.pageTitle}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                {actions.length > ACTIONS_COLLAPSED && (
                  <button type="button" className="wiki-home__text-btn" onClick={() => setShowAllActions((prev) => !prev)}>
                    {showAllActions ? "접기" : `${actions.length - ACTIONS_COLLAPSED}개 더 보기`}
                  </button>
                )}
              </section>
            )}

            <div className="wiki-home__muted">
              정리된 페이지 {overview.stats.pagesWithDigest}개 · 주제 {overview.stats.concepts}개 · 종합 글{" "}
              {overview.stats.conceptArticles}개
            </div>
          </>
        )
      )}
    </div>
  );
}
