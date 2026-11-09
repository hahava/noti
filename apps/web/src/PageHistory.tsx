import { useEffect, useState } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import { workspaceApi } from "./api";
import type { PageVersionSummary } from "./vite-env";

const dateFormat = new Intl.DateTimeFormat("ko-KR", {
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function inlineText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item: any) => (typeof item?.text === "string" ? item.text : inlineText(item?.content)))
    .join("");
}

/** 미리보기: 블록을 읽기 쉬운 줄로 보여 준다 (편집기 없이 가볍게). */
export function PreviewBlocks({ blocks, depth = 0 }: { blocks: readonly any[]; depth?: number }) {
  return (
    <>
      {blocks.map((block, index) => {
        const text = inlineText(block?.content);
        const children = Array.isArray(block?.children) && block.children.length > 0 && (
          <PreviewBlocks blocks={block.children} depth={block.type === "columnList" || block.type === "column" ? depth : depth + 1} />
        );
        if (block?.type === "columnList" || block?.type === "column") return <div key={index}>{children}</div>;
        const label =
          block?.type === "page" ? "📄 하위 페이지"
          : block?.type === "collection" ? "▦ 데이터베이스"
          : block?.type === "image" ? "🖼 이미지"
          : block?.type === "file" ? "📎 파일"
          : null;
        const prefix =
          block?.type === "bulletListItem" ? "• "
          : block?.type === "numberedListItem" ? "1. "
          : block?.type === "checkListItem" ? (block.props?.checked ? "☑ " : "☐ ")
          : "";
        return (
          <div key={index} style={{ paddingLeft: depth * 16 }}>
            <p className={`page-history__line page-history__line--${block?.type === "heading" ? `h${block.props?.level ?? 1}` : "text"}`}>
              {label ?? (text ? prefix + text : " ")}
            </p>
            {children}
          </div>
        );
      })}
    </>
  );
}

/**
 * 페이지 기록 창: 저장된 기록을 고르고, 미리 보고, 되돌린다.
 * 되돌리기는 열린 편집기에서 본문을 바꿔서 실시간 협업·저장이 평소처럼 이어지게 한다.
 */
export function PageHistoryModal({
  pageId,
  editor,
  readOnly,
  onClose,
}: {
  pageId: string;
  editor: BlockNoteEditor<any, any, any>;
  readOnly: boolean;
  onClose: () => void;
}) {
  const [versions, setVersions] = useState<PageVersionSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<unknown[] | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    workspaceApi
      .listPageVersions(pageId)
      .then(({ versions: list }) => {
        setVersions(list);
        setSelectedId(list[0]?.id ?? null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "기록을 불러오지 못했습니다."));
  }, [pageId]);

  useEffect(() => {
    setPreview(null);
    setConfirming(false);
    if (!selectedId) return;
    let cancelled = false;
    workspaceApi
      .getPageVersion(pageId, selectedId)
      .then(({ version }) => !cancelled && setPreview(version.blocks))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "기록을 불러오지 못했습니다."));
    return () => {
      cancelled = true;
    };
  }, [pageId, selectedId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const handleRestore = async () => {
    if (!selectedId) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { blocks } = await workspaceApi.restorePageVersion(pageId, selectedId);
      editor.replaceBlocks(editor.document, blocks as any);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "되돌리지 못했습니다.");
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <div className="search-modal-backdrop" onMouseDown={onClose}>
      <div
        className="search-modal page-history"
        role="dialog"
        aria-modal="true"
        aria-label="페이지 기록"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="page-history__header">
          <strong>페이지 기록</strong>
          <button type="button" className="ds-btn ds-btn--ghost ds-btn--icon" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </div>
        <div className="page-history__body">
          <ul className="page-history__list" aria-label="기록 목록">
            {versions === null && !error && <li className="page-history__empty">불러오는 중…</li>}
            {versions?.length === 0 && (
              <li className="page-history__empty">
                아직 기록이 없습니다. 페이지를 고치면 10분 간격으로 이전 내용이 남습니다.
              </li>
            )}
            {versions?.map((version) => (
              <li key={version.id}>
                <button
                  type="button"
                  className={`page-history__item ${version.id === selectedId ? "page-history__item--active" : ""}`}
                  aria-current={version.id === selectedId}
                  onClick={() => setSelectedId(version.id)}
                >
                  <span className="page-history__time">{dateFormat.format(new Date(version.editedAt))}</span>
                  <span className="page-history__title">{version.title || "제목 없는 문서"}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="page-history__preview" aria-label="미리보기">
            {preview ? <PreviewBlocks blocks={preview as any[]} /> : selectedId && <p className="page-history__empty">불러오는 중…</p>}
          </div>
        </div>
        {(error || (!readOnly && selectedId)) && (
          <div className="page-history__footer">
            {error && (
              <span className="page-history__error" role="alert">
                {error}
              </span>
            )}
            {confirming && <span className="page-history__confirm">지금 내용은 기록에 남고, 본문이 이 버전으로 바뀝니다.</span>}
            {!readOnly && selectedId && (
              <button
                type="button"
                className={`ds-btn ds-btn--md ${confirming ? "ds-btn--outline ds-btn--danger" : "ds-btn--primary"}`}
                disabled={busy || !preview}
                onClick={() => void handleRestore()}
              >
                {busy ? "되돌리는 중…" : confirming ? "되돌리기 확인" : "이 버전으로 되돌리기"}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
