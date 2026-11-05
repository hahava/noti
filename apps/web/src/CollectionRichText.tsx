import { useEffect, useRef, useState } from "react";

function safeHref(value: string): string | undefined {
  try {
    const url = new URL(value);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function renderMarkdown(value: string) {
  const parts = value.split(/(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|~~[^~]+~~|\*[^*]+\*|`[^`]+`|\n)/g);
  return parts.map((part, index) => {
    if (part === "\n") return <br key={index} />;
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link) {
      const href = safeHref(link[2]);
      return href
        ? <a key={index} href={href} target="_blank" rel="noopener noreferrer" onClick={(event) => event.stopPropagation()}>{link[1]}</a>
        : <span key={index}>{link[1]}</span>;
    }
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("~~") && part.endsWith("~~")) return <s key={index}>{part.slice(2, -2)}</s>;
    if (part.startsWith("*") && part.endsWith("*")) return <em key={index}>{part.slice(1, -1)}</em>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    return <span key={index}>{part}</span>;
  });
}

export function CollectionRichText({
  value,
  onChange,
  placeholder = "비어 있음",
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel: string;
}) {
  const [editing, setEditing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  const wrapSelection = (before: string, after = before) => {
    const element = textareaRef.current;
    if (!element) return;
    const start = element.selectionStart;
    const end = element.selectionEnd;
    const selected = value.slice(start, end) || "텍스트";
    const next = value.slice(0, start) + before + selected + after + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(start + before.length, start + before.length + selected.length);
    });
  };

  return (
    <div className={`noty-rich-cell ${editing ? "noty-rich-cell--editing" : ""}`}>
      {editing ? (
        <>
          <div className="noty-rich-cell__toolbar" onMouseDown={(event) => event.preventDefault()}>
            <button type="button" onClick={() => wrapSelection("**")} title="굵게" aria-label={`${ariaLabel} 굵게`}>B</button>
            <button type="button" onClick={() => wrapSelection("*")} title="기울임" aria-label={`${ariaLabel} 기울임`}><em>I</em></button>
            <button type="button" onClick={() => wrapSelection("~~")} title="취소선" aria-label={`${ariaLabel} 취소선`}>S̶</button>
            <button type="button" onClick={() => wrapSelection("`")} title="코드" aria-label={`${ariaLabel} 코드`}>⌘</button>
            <button type="button" onClick={() => wrapSelection("[", "](https://example.com)")} title="링크" aria-label={`${ariaLabel} 링크`}>↗</button>
          </div>
          <textarea
            ref={textareaRef}
            value={value}
            aria-label={ariaLabel}
            rows={Math.max(2, Math.min(6, value.split("\n").length))}
            onChange={(event) => onChange(event.target.value)}
            onBlur={() => setEditing(false)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setEditing(false);
              }
            }}
          />
        </>
      ) : (
        <div
          className={`noty-rich-cell__preview ${value ? "" : "noty-rich-cell__preview--empty"}`}
          role="button"
          tabIndex={0}
          aria-label={`${ariaLabel} 편집`}
          onClick={() => setEditing(true)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setEditing(true);
            }
          }}
        >
          {value ? renderMarkdown(value) : placeholder}
        </div>
      )}
    </div>
  );
}
