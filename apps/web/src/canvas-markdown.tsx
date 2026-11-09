import type { ReactNode } from "react";

/**
 * 캔버스 메모 카드용 작은 마크다운 렌더러 (HTML 을 만들지 않고 React 요소로만 그린다).
 * 지원: # 제목(1~3), - / * 목록, 1. 번호 목록, - [ ] 체크박스, > 인용, ``` 코드 블록,
 *       **굵게**, *기울임*, `코드`, [글자](http 주소), [[페이지 제목]]
 * shortcut: 표·중첩 목록·이미지는 지원하지 않는다, 필요해지면 마크다운 라이브러리로 바꾼다.
 */

export type MarkdownLine =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "check"; checked: boolean; text: string; line: number }
  | { kind: "bullet"; text: string }
  | { kind: "number"; n: string; text: string }
  | { kind: "quote"; text: string }
  | { kind: "code"; text: string }
  | { kind: "blank" }
  | { kind: "text"; text: string };

export function parseMarkdownLines(source: string): MarkdownLine[] {
  const lines = source.split("\n");
  const out: MarkdownLine[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trimStart().startsWith("```")) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) body.push(lines[i++]);
      out.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) out.push({ kind: "heading", level: m[1].length as 1 | 2 | 3, text: m[2] });
    else if ((m = line.match(/^\s*[-*]\s+\[([ xX])\]\s?(.*)$/))) out.push({ kind: "check", checked: m[1] !== " ", text: m[2], line: i });
    else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) out.push({ kind: "bullet", text: m[1] });
    else if ((m = line.match(/^\s*(\d+)[.)]\s+(.*)$/))) out.push({ kind: "number", n: m[1], text: m[2] });
    else if ((m = line.match(/^>\s?(.*)$/))) out.push({ kind: "quote", text: m[1] });
    else if (!line.trim()) out.push({ kind: "blank" });
    else out.push({ kind: "text", text: line });
  }
  return out;
}

/** 체크박스 줄(line 번호)의 [ ] ↔ [x] 를 바꾼 원문 */
export function toggleCheckLine(source: string, line: number): string {
  const lines = source.split("\n");
  lines[line] = lines[line].replace(/\[([ xX])\]/, (_all, mark: string) => (mark === " " ? "[x]" : "[ ]"));
  return lines.join("\n");
}

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[\[[^\]]+\]\]|\[[^\]]+\]\([^)\s]+\)|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;

function renderInline(text: string, ctx: MarkdownContext): ReactNode[] {
  return text.split(INLINE).map((part, index) => {
    if (!part) return null;
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    if (part.startsWith("[[") && part.endsWith("]]")) {
      const title = part.slice(2, -2).trim();
      const pageId = ctx.resolvePage?.(title);
      return (
        <button
          key={index}
          type="button"
          className={`canvas-md__wikilink nodrag ${pageId ? "" : "canvas-md__wikilink--missing"}`}
          title={pageId ? "페이지 열기" : "이 제목의 페이지가 없습니다"}
          onClick={(event) => {
            event.stopPropagation();
            if (pageId) ctx.onOpenPage?.(pageId);
          }}
        >
          {title}
        </button>
      );
    }
    const link = part.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
    if (link) {
      // http(s) 주소만 링크로 만든다 (javascript: 같은 주소 차단)
      return /^https?:\/\//i.test(link[2]) ? (
        <a key={index} className="nodrag" href={link[2]} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
          {link[1]}
        </a>
      ) : (
        link[1]
      );
    }
    if ((part.startsWith("*") && part.endsWith("*")) || (part.startsWith("_") && part.endsWith("_"))) return <em key={index}>{part.slice(1, -1)}</em>;
    return part;
  });
}

interface MarkdownContext {
  resolvePage?: (title: string) => string | undefined;
  onOpenPage?: (pageId: string) => void;
  onToggleCheck?: (line: number) => void;
}

export function CanvasMarkdown({ source, ...ctx }: { source: string } & MarkdownContext) {
  const lines = parseMarkdownLines(source);
  return (
    <div className="canvas-md">
      {lines.map((line, index) => {
        switch (line.kind) {
          case "heading": {
            const Tag = `h${line.level}` as "h1" | "h2" | "h3";
            return <Tag key={index}>{renderInline(line.text, ctx)}</Tag>;
          }
          case "check":
            return (
              <label key={index} className={`canvas-md__check nodrag ${line.checked ? "canvas-md__check--done" : ""}`} onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={line.checked}
                  disabled={!ctx.onToggleCheck}
                  onChange={() => ctx.onToggleCheck?.(line.line)}
                />
                <span>{renderInline(line.text, ctx)}</span>
              </label>
            );
          case "bullet":
            return (
              <div key={index} className="canvas-md__item">
                <span className="canvas-md__marker">•</span>
                <span>{renderInline(line.text, ctx)}</span>
              </div>
            );
          case "number":
            return (
              <div key={index} className="canvas-md__item">
                <span className="canvas-md__marker">{line.n}.</span>
                <span>{renderInline(line.text, ctx)}</span>
              </div>
            );
          case "quote":
            return <blockquote key={index}>{renderInline(line.text, ctx)}</blockquote>;
          case "code":
            return <pre key={index}>{line.text}</pre>;
          case "blank":
            return <div key={index} className="canvas-md__blank" />;
          default:
            return <p key={index}>{renderInline(line.text, ctx)}</p>;
        }
      })}
    </div>
  );
}
