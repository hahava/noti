import { useMemo } from "react";
import type { AuthSession, PageItem } from "./vite-env";

export const HOME_PAGE_ID = "__home__";

export function HomeSvgIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.5 6.75L8 2.5l5.5 4.25v6.5a.75.75 0 0 1-.75.75h-3.5a.75.75 0 0 1-.75-.75v-3.25h-2v3.25a.75.75 0 0 1-.75.75h-3.5a.75.75 0 0 1-.75-.75v-6.5Z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ClockSvgIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.25" />
      <path d="M8 4.75V8l2.25 1.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

function PlusSmallSvgIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  );
}

function ArrowRightSvgIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.5 8h9M9 4.5L12.5 8 9 11.5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SearchSmallSvgIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10.5 10.5L13.5 13.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function formatRelativeTime(dateStr: string): string {
  if (!dateStr) return "";
  const time = new Date(dateStr).getTime();
  if (Number.isNaN(time)) return "";

  const diffMs = Date.now() - time;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "방금 전";

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}분 전`;

  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}시간 전`;

  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay}일 전`;

  const date = new Date(time);
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, "0")}.${String(date.getDate()).padStart(2, "0")}`;
}

interface HomeDashboardProps {
  authSession: AuthSession;
  pages: PageItem[];
  pagesById: Map<string, PageItem>;
  lastActivePageId: string | null;
  onSelectPage: (id: string) => void;
  onCreatePage: (parentId: string | null) => void;
  onOpenSearch: () => void;
}

export function HomeDashboard({
  authSession,
  pages,
  pagesById,
  lastActivePageId,
  onSelectPage,
  onCreatePage,
  onOpenSearch,
}: HomeDashboardProps) {
  // 오늘 날짜 표시
  const todayLabel = useMemo(() => {
    const now = new Date();
    const days = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];
    return `${now.getFullYear()}년 ${now.getMonth() + 1}월 ${now.getDate()}일 ${days[now.getDay()]}`;
  }, []);

  // 통계 계산
  const stats = useMemo(() => {
    const totalCount = pages.length;
    let rootCount = 0;
    let subCount = 0;

    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    let recentlyUpdatedCount = 0;

    for (const page of pages) {
      if (page.parentId) {
        subCount += 1;
      } else {
        rootCount += 1;
      }
      const updatedTime = new Date(page.updatedAt || page.createdAt).getTime();
      if (updatedTime >= sevenDaysAgo) {
        recentlyUpdatedCount += 1;
      }
    }

    return { totalCount, rootCount, subCount, recentlyUpdatedCount };
  }, [pages]);

  // 마지막으로 작업하던 페이지 (지정된 lastActivePageId가 유효하면 우선, 아니면 가장 최근 updatedAt 문서)
  const lastWorkingPage = useMemo(() => {
    if (lastActivePageId && pagesById.has(lastActivePageId)) {
      return pagesById.get(lastActivePageId)!;
    }
    if (pages.length === 0) return null;

    // updatedAt 내림차순 정렬 후 첫 번째 페이지
    const sorted = [...pages].sort((a, b) => {
      const timeA = new Date(a.updatedAt || a.createdAt).getTime();
      const timeB = new Date(b.updatedAt || b.createdAt).getTime();
      return timeB - timeA;
    });
    return sorted[0] || null;
  }, [lastActivePageId, pagesById, pages]);

  // 최근 작업한 문서 목록 (최대 6개)
  const recentPages = useMemo(() => {
    return [...pages]
      .sort((a, b) => {
        const timeA = new Date(a.updatedAt || a.createdAt).getTime();
        const timeB = new Date(b.updatedAt || b.createdAt).getTime();
        return timeB - timeA;
      })
      .slice(0, 6);
  }, [pages]);

  // 상위 문서 이름 찾기
  const getParentTitle = (parentId: string | null) => {
    if (!parentId) return null;
    return pagesById.get(parentId)?.title || "상위 문서";
  };

  return (
    <div className="home-dashboard">
      <div className="home-dashboard__container">
        {/* 상단 개인화 인사 헤더 */}
        <header className="home-dashboard__header">
          <div className="home-dashboard__greeting">
            <span className="home-dashboard__date-badge">{todayLabel}</span>
            <h1 className="home-dashboard__title">
              안녕하세요, <span className="home-dashboard__user-name">{authSession.user.displayName}</span>님 👋
            </h1>
            <p className="home-dashboard__subtitle">
              개인 작업 공간입니다. 문서 현황을 확인하고 이어서 작업해 보세요.
            </p>
          </div>

          <div className="home-dashboard__quick-buttons">
            <button
              type="button"
              className="ds-btn ds-btn--outline ds-btn--md"
              onClick={onOpenSearch}
              title="문서 검색 (⌘K)"
            >
              <SearchSmallSvgIcon />
              <span>문서 검색</span>
            </button>
            <button
              type="button"
              className="ds-btn ds-btn--primary ds-btn--md"
              onClick={() => onCreatePage(null)}
              title="새 페이지 만들기"
            >
              <PlusSmallSvgIcon />
              <span>새 페이지</span>
            </button>
          </div>
        </header>

        {/* 요약 통계 카드 그리드 */}
        <section className="home-dashboard__stats-grid" aria-label="문서 통계">
          <div className="home-stat-card">
            <span className="home-stat-card__icon">📄</span>
            <div className="home-stat-card__info">
              <span className="home-stat-card__label">전체 문서</span>
              <strong className="home-stat-card__value">{stats.totalCount}개</strong>
            </div>
            <span className="home-stat-card__hint">루트 {stats.rootCount} / 하위 {stats.subCount}</span>
          </div>

          <div className="home-stat-card">
            <span className="home-stat-card__icon">⚡</span>
            <div className="home-stat-card__info">
              <span className="home-stat-card__label">최근 7일 수정</span>
              <strong className="home-stat-card__value">{stats.recentlyUpdatedCount}개</strong>
            </div>
            <span className="home-stat-card__hint">최근 활발히 작업 중</span>
          </div>

          <div className="home-stat-card">
            <span className="home-stat-card__icon">👤</span>
            <div className="home-stat-card__info">
              <span className="home-stat-card__label">접속 계정</span>
              <strong className="home-stat-card__value">@{authSession.user.username}</strong>
            </div>
            <span className="home-stat-card__hint" title={authSession.serverHost}>
              {authSession.serverHost.replace(/^https?:\/\//, "")}
            </span>
          </div>
        </section>

        {/* 마지막으로 작업하던 페이지 (Featured Card) */}
        <section className="home-dashboard__section">
          <div className="home-section-header">
            <div className="home-section-header__title">
              <ClockSvgIcon />
              <h2>마지막으로 작업하던 페이지</h2>
            </div>
          </div>

          {lastWorkingPage ? (
            <div className="home-last-card" onClick={() => onSelectPage(lastWorkingPage.id)}>
              <div className="home-last-card__main">
                <span className="home-last-card__emoji">
                  {lastWorkingPage.icon || "📄"}
                </span>
                <div className="home-last-card__content">
                  <div className="home-last-card__title-row">
                    <strong className="home-last-card__title">
                      {lastWorkingPage.title || "제목 없는 문서"}
                    </strong>
                    {lastWorkingPage.parentId && (
                      <span className="home-last-card__parent-badge">
                        📁 {getParentTitle(lastWorkingPage.parentId)}
                      </span>
                    )}
                  </div>
                  <span className="home-last-card__time">
                    마지막 수정: {formatRelativeTime(lastWorkingPage.updatedAt || lastWorkingPage.createdAt)}
                  </span>
                </div>
              </div>

              <button
                type="button"
                className="ds-btn ds-btn--primary ds-btn--md home-last-card__action"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectPage(lastWorkingPage.id);
                }}
              >
                <span>이어서 작업하기</span>
                <ArrowRightSvgIcon />
              </button>
            </div>
          ) : (
            <div className="home-empty-card">
              <span className="home-empty-card__icon">📝</span>
              <p>아직 작업한 문서가 없습니다. 첫 페이지를 만들어 시작해 보세요!</p>
              <button
                type="button"
                className="ds-btn ds-btn--primary ds-btn--md"
                onClick={() => onCreatePage(null)}
              >
                <PlusSmallSvgIcon />
                <span>새 페이지 만들기</span>
              </button>
            </div>
          )}
        </section>

        {/* 최근 작업 문서 목록 (Recent Pages) */}
        {recentPages.length > 0 && (
          <section className="home-dashboard__section">
            <div className="home-section-header">
              <div className="home-section-header__title">
                <span>📚</span>
                <h2>최근 문서 목록</h2>
              </div>
              <span className="home-section-header__count">{recentPages.length}개 표시 중</span>
            </div>

            <div className="home-recent-list">
              {recentPages.map((page) => {
                const isCurrentLast = lastWorkingPage?.id === page.id;
                return (
                  <div
                    key={page.id}
                    className={`home-recent-item ${isCurrentLast ? "home-recent-item--active" : ""}`}
                    onClick={() => onSelectPage(page.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelectPage(page.id);
                      }
                    }}
                  >
                    <div className="home-recent-item__left">
                      <span className="home-recent-item__icon">{page.icon || "📄"}</span>
                      <div className="home-recent-item__info">
                        <strong className="home-recent-item__title">
                          {page.title || "제목 없는 문서"}
                        </strong>
                        {page.parentId && (
                          <span className="home-recent-item__parent">
                            in {getParentTitle(page.parentId)}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="home-recent-item__right">
                      <span className="home-recent-item__time">
                        {formatRelativeTime(page.updatedAt || page.createdAt)}
                      </span>
                      <span className="home-recent-item__arrow">
                        <ArrowRightSvgIcon />
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
