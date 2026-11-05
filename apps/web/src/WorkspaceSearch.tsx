import { Fragment, useEffect, useState } from "react";
import { workspaceApi } from "./api";
import type { WorkspaceSearchResponse, WorkspaceSearchResult } from "./vite-env";

/* ==========================================================================
 * ⌘K 검색의 "본문 · 파일" 결과 (서버 통합 검색: PGroonga 키워드 + pgvector 의미)
 * ========================================================================== */

const DEBOUNCE_MS = 250;

export function useWorkspaceSearch(query: string) {
  const [response, setResponse] = useState<WorkspaceSearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResponse(null);
      setLoading(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(() => {
      workspaceApi
        .searchWorkspace(trimmed, 20, controller.signal)
        .then((next) => {
          setResponse(next);
          setError(null);
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          setError(err instanceof Error ? err.message : "검색에 실패했습니다.");
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  return { response, loading, error };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 키워드를 <mark> 로 감싼다. (HTML 을 쓰지 않고 React 요소로 만들어 XSS 걱정이 없다) */
export function HighlightedText({ text, keywords }: { text: string; keywords: string[] }) {
  const usable = keywords.map((keyword) => keyword.trim()).filter((keyword) => keyword.length > 0);
  if (usable.length === 0 || !text) return <>{text}</>;
  // 긴 키워드부터 맞춰야 "레플리카를"과 "레플리카"가 겹칠 때 긴 쪽이 우선한다.
  const pattern = new RegExp(`(${usable.sort((a, b) => b.length - a.length).map(escapeRegExp).join("|")})`, "gi");
  const lowerKeywords = new Set(usable.map((keyword) => keyword.toLowerCase()));
  return (
    <>
      {text.split(pattern).map((part, index) =>
        lowerKeywords.has(part.toLowerCase()) ? (
          <mark key={index} className="search-hit__mark">
            {part}
          </mark>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </>
  );
}

/** "제목 > 헤딩" 맥락에서 페이지 제목 부분을 빼고 위치만 보여준다. */
function contextWithoutTitle(result: WorkspaceSearchResult): string {
  const prefix = `${result.pageTitle || "제목 없는 문서"} > `;
  return result.context.startsWith(prefix) ? result.context.slice(prefix.length) : "";
}

export function SearchHitContent({ result, keywords }: { result: WorkspaceSearchResult; keywords: string[] }) {
  const location = contextWithoutTitle(result);
  return (
    <span className="search-hit">
      <span className="search-hit__title-row">
        <span className="search-hit__title">
          <HighlightedText text={result.pageTitle || "제목 없는 문서"} keywords={keywords} />
        </span>
        {location && <span className="search-hit__location">{location}</span>}
        {result.matchedBy.length === 1 && result.matchedBy[0] === "semantic" && (
          <span className="search-hit__badge" title="키워드는 없지만 의미가 비슷한 내용">
            의미 유사
          </span>
        )}
      </span>
      {result.snippet && (
        <span className="search-hit__snippet">
          <HighlightedText text={result.snippet} keywords={keywords} />
        </span>
      )}
    </span>
  );
}

/**
 * 검색 결과에서 연 페이지의 해당 블록으로 스크롤한다.
 * 편집기가 그려질 때까지 잠시 기다렸다가 BlockNote 블록(data-id)을 찾는다.
 */
export function revealBlockWhenReady(blockId: string, timeoutMs = 2500): void {
  const started = Date.now();
  const tryReveal = () => {
    const element = document.querySelector<HTMLElement>(`.bn-block-outer[data-id="${CSS.escape(blockId)}"]`);
    if (element) {
      element.scrollIntoView({ block: "center", behavior: "smooth" });
      element.classList.add("search-hit-flash");
      window.setTimeout(() => element.classList.remove("search-hit-flash"), 1800);
      return;
    }
    if (Date.now() - started < timeoutMs) window.setTimeout(tryReveal, 100);
  };
  window.setTimeout(tryReveal, 80);
}
