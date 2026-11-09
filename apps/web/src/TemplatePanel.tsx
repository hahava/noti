import { useEffect, useMemo, useState } from "react";
import { PreviewBlocks } from "./PageHistory";
import { PAGE_TEMPLATES, USER_TEMPLATE_CATEGORY, pageBlocksToTemplate, type PageTemplate } from "./templates";

const RECENT_KEY = "noty.recentTemplates";

function readRecent(): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function writeRecent(ids: string[]): void {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(ids));
  } catch {
    // 저장소를 쓸 수 없으면 최근 목록 없이 동작
  }
}

export function TemplateSvgIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.25" />
      <path d="M2.5 6h11M6 6v7.5" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  );
}

/**
 * 우측 템플릿 패널: 항목에 마우스를 올리면 현재 페이지에 미리보기가 깔리고, 누르면 적용된다.
 * 패널 틀은 AI 패널(.ai-panel)과 같은 자리·모양을 쓴다.
 */
export function TemplatePanel({
  isOpen,
  canApply,
  userTemplates,
  onClose,
  onPreview,
  onApply,
  onOpenAI,
  onSaveCurrent,
  onEditTemplate,
  onOverwriteTemplate,
  onDeleteTemplate,
}: {
  isOpen: boolean;
  /** 편집 가능한 문서 페이지가 열려 있을 때만 적용·저장할 수 있다 */
  canApply: boolean;
  userTemplates: PageTemplate[];
  onClose: () => void;
  onPreview: (template: PageTemplate | null) => void;
  onApply: (template: PageTemplate) => void;
  onOpenAI: () => void;
  onSaveCurrent: () => void;
  onEditTemplate: (template: PageTemplate) => void;
  onOverwriteTemplate: (template: PageTemplate) => void;
  onDeleteTemplate: (template: PageTemplate) => void;
}) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [recentIds, setRecentIds] = useState(readRecent);
  const [menu, setMenu] = useState<{ id: string; confirmDelete: boolean } | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menu]);

  // 내 템플릿 → 기본 제공 순서
  const allTemplates = useMemo(() => [...userTemplates, ...PAGE_TEMPLATES], [userTemplates]);
  const categories = useMemo(() => [...new Set(allTemplates.map((t) => t.category))], [allTemplates]);
  const q = query.trim().toLowerCase();
  const matches = q
    ? allTemplates.filter((t) => `${t.name} ${t.description} ${t.category}`.toLowerCase().includes(q))
    : allTemplates;
  const recent = recentIds
    .map((id) => allTemplates.find((t) => t.id === id))
    .filter((t): t is PageTemplate => Boolean(t));

  const apply = (template: PageTemplate) => {
    if (!canApply) return;
    const next = [template.id, ...recentIds.filter((id) => id !== template.id)].slice(0, 3);
    setRecentIds(next);
    writeRecent(next);
    onPreview(null);
    onApply(template);
  };

  const renderItem = (template: PageTemplate) => {
    const isUser = template.category === USER_TEMPLATE_CATEGORY;
    const menuOpen = menu?.id === template.id;
    return (
      <li key={template.id} className="template-panel__row">
        <button
          type="button"
          className="template-panel__item"
          disabled={!canApply}
          onMouseEnter={() => canApply && onPreview(template)}
          onFocus={() => canApply && onPreview(template)}
          onClick={() => apply(template)}
          title={canApply ? "누르면 현재 페이지에 적용" : undefined}
        >
          <span className="template-panel__icon" aria-hidden="true">
            {template.icon}
          </span>
          <span className="template-panel__text">
            <span className="template-panel__name">{template.name}</span>
            {template.description && <span className="template-panel__desc">{template.description}</span>}
          </span>
        </button>
        {isUser && (
          <button
            type="button"
            className={`template-panel__more ${menuOpen ? "template-panel__more--open" : ""}`}
            aria-label={`${template.name} 템플릿 메뉴`}
            aria-expanded={menuOpen}
            onClick={(event) => {
              event.stopPropagation();
              setMenu(menuOpen ? null : { id: template.id, confirmDelete: false });
            }}
          >
            ⋯
          </button>
        )}
        {menuOpen && (
          <div className="noty-popover-menu template-panel__menu" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              className="noty-menu-item"
              onClick={() => {
                setMenu(null);
                onEditTemplate(template);
              }}
            >
              <span>이름·아이콘 바꾸기</span>
            </button>
            <button
              type="button"
              className="noty-menu-item"
              disabled={!canApply}
              onClick={() => {
                setMenu(null);
                onOverwriteTemplate(template);
              }}
            >
              <span>현재 페이지로 덮어쓰기</span>
            </button>
            <div className="noty-menu-divider" />
            <button
              type="button"
              className="noty-menu-item template-panel__danger"
              onClick={() => {
                if (!menu.confirmDelete) {
                  setMenu({ id: template.id, confirmDelete: true });
                  return;
                }
                setMenu(null);
                onDeleteTemplate(template);
              }}
            >
              <span>{menu.confirmDelete ? "한 번 더 누르면 삭제" : "삭제"}</span>
            </button>
          </div>
        )}
      </li>
    );
  };

  return (
    <aside
      className={`ai-panel template-panel ${isOpen ? "ai-panel--open" : ""}`}
      aria-label="템플릿"
      aria-hidden={!isOpen}
      inert={!isOpen}
    >
      <div className="ai-panel__inner">
        <header className="ai-panel__header">
          <div className="ai-panel__title">
            <TemplateSvgIcon />
            <strong>템플릿</strong>
          </div>
          <div className="ai-panel__header-actions">
            <button
              type="button"
              className="ds-btn ds-btn--ghost ds-btn--icon"
              onClick={onClose}
              title="템플릿 패널 닫기"
              aria-label="템플릿 패널 닫기"
            >
              ✕
            </button>
          </div>
        </header>

        <div className="template-panel__search">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="템플릿 검색"
            aria-label="템플릿 검색"
          />
          <button type="button" className="template-panel__save" disabled={!canApply} onClick={onSaveCurrent}>
            ＋ 현재 페이지를 템플릿으로 저장
          </button>
        </div>

        {/* 목록에서 마우스가 벗어나면 미리보기를 걷는다 */}
        <div className="template-panel__body" onMouseLeave={() => onPreview(null)} onBlur={() => onPreview(null)}>
          {!canApply && (
            <div className="ai-panel__notice">문서 페이지를 열면 템플릿을 적용하거나 저장할 수 있습니다.</div>
          )}

          {q ? (
            matches.length === 0 ? (
              <p className="template-panel__empty">“{query}”에 맞는 템플릿이 없습니다.</p>
            ) : (
              <ul className="template-panel__list">{matches.map(renderItem)}</ul>
            )
          ) : (
            <>
              {recent.length > 0 && (
                <section className="template-panel__group">
                  <h3 className="template-panel__group-label">최근 사용</h3>
                  <ul className="template-panel__list">{recent.map(renderItem)}</ul>
                </section>
              )}
              {categories.map((category) => {
                const isCollapsed = collapsed.has(category);
                return (
                  <section key={category} className="template-panel__group">
                    <button
                      type="button"
                      className="template-panel__group-toggle"
                      aria-expanded={!isCollapsed}
                      onClick={() =>
                        setCollapsed((prev) => {
                          const next = new Set(prev);
                          if (next.has(category)) next.delete(category);
                          else next.add(category);
                          return next;
                        })
                      }
                    >
                      <span className="template-panel__chevron" aria-hidden="true">
                        {isCollapsed ? "▸" : "▾"}
                      </span>
                      {category}
                    </button>
                    {!isCollapsed && (
                      <ul className="template-panel__list">
                        {allTemplates.filter((t) => t.category === category).map(renderItem)}
                      </ul>
                    )}
                  </section>
                );
              })}
            </>
          )}
        </div>

        <button type="button" className="template-panel__ai" onClick={onOpenAI}>
          <span>✨ 원하는 게 없나요?</span>
          <strong>AI로 만들기 →</strong>
        </button>
      </div>
    </aside>
  );
}

/**
 * 템플릿으로 저장 / 이름·아이콘 바꾸기 창.
 * pageBlocks 가 있으면 새로 저장(또는 덮어쓰기)이고, 없으면 기존 템플릿의 이름·아이콘·설명만 바꾼다.
 */
export function TemplateSaveDialog({
  initial,
  pageBlocks,
  onSave,
  onClose,
}: {
  initial: { name: string; icon: string; description: string };
  pageBlocks?: readonly unknown[];
  onSave: (values: { name: string; icon: string; description: string; blocks?: unknown[] }) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [icon, setIcon] = useState(initial.icon);
  const [description, setDescription] = useState(initial.description);
  const [structureOnly, setStructureOnly] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocks = useMemo(
    () => (pageBlocks ? pageBlocksToTemplate(pageBlocks, structureOnly) : undefined),
    [pageBlocks, structureOnly],
  );
  const droppedLinked = pageBlocks ? JSON.stringify(pageBlocks).match(/"type":"(page|collection)"/) : null;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const submit = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({ name: name.trim(), icon: icon.trim() || "📄", description: description.trim(), blocks });
    } catch (err) {
      setError(err instanceof Error ? err.message : "저장하지 못했습니다.");
      setSaving(false);
    }
  };

  return (
    <div className="search-modal-backdrop" onMouseDown={onClose}>
      <form
        className="search-modal template-save"
        role="dialog"
        aria-modal="true"
        aria-label={pageBlocks ? "템플릿으로 저장" : "템플릿 이름·아이콘 바꾸기"}
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="template-save__header">
          <strong>{pageBlocks ? "템플릿으로 저장" : "템플릿 이름·아이콘 바꾸기"}</strong>
          <button type="button" className="ds-btn ds-btn--ghost ds-btn--icon" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </div>
        <div className="template-save__fields">
          <input
            className="template-save__icon"
            value={icon}
            onChange={(e) => setIcon(e.target.value)}
            aria-label="아이콘"
            maxLength={4}
          />
          <div className="template-save__inputs">
            <label>
              <span>이름</span>
              <input value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
            </label>
            <label>
              <span>설명</span>
              <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="선택" />
            </label>
          </div>
        </div>
        {blocks && (
          <>
            <label className="template-save__check">
              <input type="checkbox" checked={structureOnly} onChange={(e) => setStructureOnly(e.target.checked)} />
              내용은 비우고 구조만 저장 (제목·굵은 라벨·목록 모양만 남김)
            </label>
            <div className="template-save__preview" aria-label="저장될 내용 미리보기">
              {blocks.length > 0 ? (
                <PreviewBlocks blocks={blocks as any[]} />
              ) : (
                <p className="page-history__empty">제목 아래에 내용이 없습니다.</p>
              )}
            </div>
            {droppedLinked && (
              <p className="template-save__note">하위 페이지와 데이터베이스는 템플릿에 포함되지 않습니다.</p>
            )}
          </>
        )}
        {error && (
          <p className="template-save__note template-save__error" role="alert">
            {error}
          </p>
        )}
        <div className="template-save__footer">
          <span className="template-save__scope">🔒 나만 사용</span>
          <button type="button" className="ds-btn ds-btn--md ds-btn--outline" onClick={onClose}>
            취소
          </button>
          <button type="submit" className="ds-btn ds-btn--md ds-btn--primary" disabled={!name.trim() || saving}>
            {saving ? "저장 중…" : "저장"}
          </button>
        </div>
      </form>
    </div>
  );
}
