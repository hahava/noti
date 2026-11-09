import { useEffect, useRef, useState } from "react";
import { importNotionZip, type NotionImportDeps, type NotionImportProgress, type NotionImportReport } from "./notion-import";

const PHASE_LABEL: Record<NotionImportProgress["phase"], string> = {
  unzip: "압축 푸는 중",
  pages: "페이지 만드는 중",
  content: "본문·첨부 옮기는 중",
  done: "마무리 중",
};

/** 사이드바 "가져오기" → Notion 내보내기 ZIP 올리기 · 진행률 · 결과 보고 */
export function NotionImportDialog({
  deps,
  onClose,
  onOpenPage,
}: {
  deps: Omit<NotionImportDeps, "onProgress" | "isCancelled">;
  onClose: () => void;
  onOpenPage: (pageId: string) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [progress, setProgress] = useState<NotionImportProgress | null>(null);
  const [report, setReport] = useState<NotionImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef(false);
  const running = Boolean(progress) && !report && !error;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => event.key === "Escape" && !running && onClose();
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [running, onClose]);

  // 가져오는 중에 창을 닫거나 새로 고치면 중간까지만 들어간다
  useEffect(() => {
    if (!running) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [running]);

  const start = async () => {
    if (!file) return;
    cancelRef.current = false;
    setError(null);
    setProgress({ phase: "unzip", done: 0, total: 1 });
    try {
      const stamp = new Date().toLocaleDateString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" });
      const result = await importNotionZip(file, `Notion 가져오기 (${stamp})`, {
        ...deps,
        onProgress: setProgress,
        isCancelled: () => cancelRef.current,
      });
      setReport(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "가져오지 못했습니다.");
    }
  };

  const pickFile = (candidate: File | undefined) => {
    if (!candidate) return;
    if (!/\.zip$/i.test(candidate.name)) {
      setError("ZIP 파일을 올려 주세요.");
      return;
    }
    setError(null);
    setFile(candidate);
  };

  const percent = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="search-modal-backdrop" onMouseDown={() => !running && onClose()}>
      <div className="search-modal notion-import" role="dialog" aria-modal="true" aria-label="Notion 에서 가져오기" onMouseDown={(e) => e.stopPropagation()}>
        <div className="notion-import__header">
          <strong>Notion 에서 가져오기</strong>
          {!running && (
            <button type="button" className="ds-btn ds-btn--ghost ds-btn--icon" onClick={onClose} aria-label="닫기">
              ✕
            </button>
          )}
        </div>

        {report ? (
          <div className="notion-import__body">
            <div className={`notion-import__result ${report.cancelled ? "notion-import__result--warn" : ""}`}>
              {report.cancelled ? "중간에 멈췄습니다. 여기까지 가져온 내용은 남아 있습니다." : "가져오기를 마쳤습니다."}
            </div>
            <ul className="notion-import__stats">
              <li>
                <strong>{report.pages}</strong> 페이지
              </li>
              <li>
                <strong>{report.databases}</strong> 데이터베이스 ({report.rows}행)
              </li>
              <li>
                <strong>{report.files}</strong> 첨부·이미지
              </li>
            </ul>
            {report.warnings.length > 0 && (
              <details className="notion-import__warnings">
                <summary>확인이 필요한 항목 {report.warnings.length}개</summary>
                <ul>
                  {report.warnings.slice(0, 200).map((warning, index) => (
                    <li key={index}>{warning}</li>
                  ))}
                </ul>
              </details>
            )}
            <div className="notion-import__footer">
              <button type="button" className="ds-btn ds-btn--md ds-btn--outline" onClick={onClose}>
                닫기
              </button>
              <button
                type="button"
                className="ds-btn ds-btn--md ds-btn--primary"
                onClick={() => {
                  onOpenPage(report.rootPageId);
                  onClose();
                }}
              >
                가져온 페이지 열기
              </button>
            </div>
          </div>
        ) : running && progress ? (
          <div className="notion-import__body">
            <div className="notion-import__phase">
              {PHASE_LABEL[progress.phase]}
              {progress.phase !== "unzip" && ` · ${progress.done}/${progress.total}`}
            </div>
            <div className="notion-import__bar" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${progress.phase === "unzip" ? 5 : progress.phase === "pages" ? percent * 0.3 : 30 + percent * 0.7}%` }} />
            </div>
            <div className="notion-import__current">{progress.current ?? " "}</div>
            <p className="notion-import__hint">이 창을 닫거나 새로 고치지 마세요. 페이지가 많으면 몇 분 걸릴 수 있습니다.</p>
            <div className="notion-import__footer">
              <button type="button" className="ds-btn ds-btn--md ds-btn--outline" onClick={() => (cancelRef.current = true)}>
                멈추기
              </button>
            </div>
          </div>
        ) : (
          <div className="notion-import__body">
            <ol className="notion-import__steps">
              <li>
                Notion 에서 <b>설정 → 일반 → 모든 워크스페이스 콘텐츠 내보내기</b>, 또는 페이지 <b>⋯ → 내보내기</b>
              </li>
              <li>
                형식은 <b>Markdown &amp; CSV</b>, <b>하위 페이지 포함</b>을 켜고 내보낸 ZIP 을 받습니다.
              </li>
              <li>받은 ZIP 을 그대로 아래에 올리세요 (압축을 풀 필요 없음).</li>
            </ol>
            <label
              className={`notion-import__drop ${dragOver ? "notion-import__drop--over" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                pickFile(e.dataTransfer.files[0]);
              }}
            >
              <input type="file" accept=".zip,application/zip" onChange={(e) => pickFile(e.target.files?.[0])} />
              {file ? (
                <span>
                  📦 <b>{file.name}</b> ({(file.size / 1024 / 1024).toFixed(1)}MB)
                </span>
              ) : (
                <span>ZIP 파일을 끌어다 놓거나 눌러서 고르기</span>
              )}
            </label>
            <p className="notion-import__hint">
              가져온 내용은 새 페이지 <b>“Notion 가져오기 (날짜)”</b> 아래에 모입니다. 데이터베이스는 페이지마다 하나씩 만들어지고, 20MB 가 넘는 첨부는 건너뜁니다.
            </p>
            {error && (
              <p className="notion-import__error" role="alert">
                {error}
              </p>
            )}
            <div className="notion-import__footer">
              <button type="button" className="ds-btn ds-btn--md ds-btn--outline" onClick={onClose}>
                취소
              </button>
              <button type="button" className="ds-btn ds-btn--md ds-btn--primary" disabled={!file} onClick={() => void start()}>
                가져오기
              </button>
            </div>
          </div>
        )}
        {error && (report || running) && (
          <p className="notion-import__error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
