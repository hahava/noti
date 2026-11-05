import { useEffect, useState } from "react";
import { workspaceApi } from "./api";
import type { WikiConceptDetail } from "./vite-env";

/* ==========================================================================
 * LLM 위키 개념 보기 (AI 패널 안)
 * 여러 페이지를 종합한 개념 글, 문서 간 불일치, 언급된 페이지 목록을 보여준다.
 * ========================================================================== */

interface WikiConceptViewProps {
  conceptId: string;
  onBack: () => void;
  backLabel?: string;
  onOpenPage: (pageId: string) => void;
}

function PageChips({
  pageIds,
  titles,
  onOpenPage,
}: {
  pageIds: string[];
  titles: Map<string, string>;
  onOpenPage: (pageId: string) => void;
}) {
  if (pageIds.length === 0) return null;
  return (
    <span className="wiki-concept__chips">
      {pageIds.map((pageId) => (
        <button key={pageId} type="button" className="wiki-concept__chip" onClick={() => onOpenPage(pageId)}>
          {titles.get(pageId) || "페이지"}
        </button>
      ))}
    </span>
  );
}

export function WikiConceptView({ conceptId, onBack, onOpenPage, backLabel = "← 돌아가기" }: WikiConceptViewProps) {
  const [concept, setConcept] = useState<WikiConceptDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setConcept(null);
    setError(null);
    workspaceApi
      .getWikiConcept(conceptId)
      .then((detail) => {
        if (!cancelled) setConcept(detail);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "개념을 불러오지 못했습니다.");
      });
    return () => {
      cancelled = true;
    };
  }, [conceptId]);

  const titles = new Map((concept?.mentions ?? []).map((mention) => [mention.pageId, mention.pageTitle]));

  return (
    <div className="wiki-concept">
      <button type="button" className="wiki-concept__back" onClick={onBack}>
        {backLabel}
      </button>
      {error && <div className="ai-panel__error">{error}</div>}
      {!concept && !error && <div className="wiki-concept__loading">불러오는 중…</div>}
      {concept && (
        <>
          <div className="wiki-concept__header">
            <span className="wiki-concept__label">개념</span>
            <h3>{concept.name}</h3>
            <span className="wiki-concept__meta">
              {concept.pageCount}개 페이지에서 언급
              {concept.stale ? " · 관련 문서가 바뀌어 곧 다시 정리됩니다" : ""}
            </span>
          </div>

          {concept.article ? (
            <>
              <p className="wiki-concept__summary">{concept.article.summary}</p>
              {concept.article.points.length > 0 && (
                <ul className="wiki-concept__points">
                  {concept.article.points.map((point, index) => (
                    <li key={index}>
                      {point.text} <PageChips pageIds={point.pageIds} titles={titles} onOpenPage={onOpenPage} />
                    </li>
                  ))}
                </ul>
              )}
              {concept.article.conflicts.length > 0 && (
                <div className="wiki-concept__conflicts" role="note">
                  <div className="wiki-concept__section-title">문서 간 불일치</div>
                  <ul>
                    {concept.article.conflicts.map((conflict, index) => (
                      <li key={index}>
                        {conflict.text} <PageChips pageIds={conflict.pageIds} titles={titles} onOpenPage={onOpenPage} />
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {concept.articleGeneratedAt && (
                <div className="wiki-concept__meta">AI 종합 · {new Date(concept.articleGeneratedAt).toLocaleString()}</div>
              )}
            </>
          ) : (
            <p className="wiki-concept__summary wiki-concept__summary--muted">
              {concept.pageCount >= 2
                ? "여러 페이지의 내용을 종합하는 중입니다. 잠시 후 다시 열어 보세요."
                : "아직 한 페이지에서만 언급되어 종합 정리가 없습니다."}
            </p>
          )}

          <div className="wiki-concept__section-title">언급된 페이지</div>
          <ul className="wiki-concept__mentions">
            {concept.mentions.map((mention) => (
              <li key={mention.pageId}>
                <button type="button" className="wiki-concept__mention" onClick={() => onOpenPage(mention.pageId)}>
                  <strong>{mention.pageTitle || "제목 없는 문서"}</strong>
                  {mention.description && <span>{mention.description}</span>}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
