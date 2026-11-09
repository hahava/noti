import { useEffect, useRef, useState, type FormEvent } from "react";
import { insertOrUpdateBlockForSlashMenu } from "@blocknote/core";
import { createReactBlockSpec, useEditorChange, type DefaultReactSuggestionItem } from "@blocknote/react";
import { workspaceApi } from "./api";
import { EMBED_PROVIDERS, removePastedLink, safeHttpUrl, toEmbed } from "./link-embeds";

/**
 * 목차 · 북마크 · 임베드 블록
 *  - 목차: 저장하는 값 없이 문서의 제목(H1~H3)을 그때그때 모아 보여 준다.
 *  - 북마크: 서버(/api/link-preview)가 가져온 제목·설명·이미지를 블록 속성에 저장해 다시 받지 않는다.
 *  - 임베드: 허용한 사이트만 iframe 으로 띄운다 (link-embeds.ts). 그 밖의 주소는 북마크로 바꾸게 한다.
 */

function inlineText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item: any) => (typeof item?.text === "string" ? item.text : inlineText(item?.content))).join("");
}

/* ------------------------------------------------------------------ 목차 */

type Heading = { id: string; level: number; text: string };

function collectHeadings(blocks: readonly any[], out: Heading[] = []): Heading[] {
  for (const block of blocks) {
    if (block?.type === "heading") {
      const text = inlineText(block.content).trim();
      if (text) out.push({ id: block.id, level: Number(block.props?.level) || 1, text });
    }
    if (Array.isArray(block?.children)) collectHeadings(block.children, out);
  }
  return out;
}

function TableOfContents({ editor }: { editor: any }) {
  // 첫 블록은 페이지 제목이므로 뺀다
  const read = () => collectHeadings(editor.document.slice(1));
  const [headings, setHeadings] = useState<Heading[]>(read);
  useEditorChange(() => setHeadings(read()), editor);
  if (headings.length === 0) {
    return <div className="noty-toc noty-toc--empty">제목(# · ## · ###)을 추가하면 여기에 목차가 생깁니다.</div>;
  }
  const minLevel = Math.min(...headings.map((h) => h.level));
  return (
    <nav className="noty-toc" aria-label="목차" contentEditable={false}>
      {headings.map((heading) => (
        <button
          key={heading.id}
          type="button"
          className="noty-toc__item"
          style={{ paddingLeft: (heading.level - minLevel) * 16 + 6 }}
          onClick={() => {
            const target = editor.domElement?.querySelector(`[data-id="${CSS.escape(heading.id)}"]`) as HTMLElement | null;
            target?.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
        >
          {heading.text}
        </button>
      ))}
    </nav>
  );
}

export const createTocBlockSpec = createReactBlockSpec(
  { type: "toc", propSchema: {}, content: "none" } as const,
  { render: (props) => <TableOfContents editor={props.editor} /> },
);

/* ------------------------------------------------------------------ 주소 입력 (북마크·임베드 공통) */

function UrlPrompt({ placeholder, hint, editable, onSubmit }: { placeholder: string; hint: string; editable: boolean; onSubmit: (url: string) => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!editable) return <div className="noty-linkblock__empty">주소가 비어 있습니다.</div>;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const url = safeHttpUrl(value.trim());
    if (!url) {
      setError("http:// 또는 https:// 로 시작하는 주소를 넣어 주세요.");
      return;
    }
    onSubmit(url);
  };
  return (
    <form className="noty-linkblock__prompt" contentEditable={false} onSubmit={submit}>
      <input
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        // 편집기 단축키가 입력을 가로채지 않게
        onKeyDown={(e) => e.stopPropagation()}
        autoFocus
      />
      <button type="submit">확인</button>
      <span className={error ? "noty-linkblock__error" : "noty-linkblock__hint"}>{error ?? hint}</span>
    </form>
  );
}

/* ------------------------------------------------------------------ 북마크 */

function BookmarkView({ block, editor }: { block: any; editor: any }) {
  const { url, title, description, image, icon, siteName } = block.props as Record<string, string>;
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");
  const [error, setError] = useState("");
  const href = safeHttpUrl(url);

  // 주소만 있고 정보가 없으면 한 번 가져와 블록에 저장한다 (편집할 수 있는 사람만)
  useEffect(() => {
    if (!href || title || !editor.isEditable || state !== "idle") return;
    setState("loading");
    workspaceApi
      .getLinkPreview(href)
      .then(({ preview }) => {
        editor.updateBlock(block, {
          props: { title: preview.title, description: preview.description, image: preview.image, icon: preview.icon, siteName: preview.siteName },
        });
        setState("idle");
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "링크 정보를 가져오지 못했습니다.");
        setState("failed");
      });
  }, [href, title]);

  if (!href) {
    return (
      <UrlPrompt
        placeholder="북마크할 웹 주소 붙여 넣기"
        hint="제목·설명·대표 이미지가 있는 링크 카드를 만듭니다."
        editable={editor.isEditable}
        onSubmit={(next) => editor.updateBlock(block, { props: { url: next } })}
      />
    );
  }
  let host = href;
  try {
    host = new URL(href).hostname.replace(/^www\./, "");
  } catch {
    // 그대로
  }
  const imageSrc = safeHttpUrl(image);
  const iconSrc = safeHttpUrl(icon);
  return (
    <a className="noty-bookmark" href={href} target="_blank" rel="noopener noreferrer" contentEditable={false} draggable={false}>
      <span className="noty-bookmark__text">
        <span className="noty-bookmark__title">{title || (state === "loading" ? "불러오는 중…" : host)}</span>
        {description && <span className="noty-bookmark__desc">{description}</span>}
        {state === "failed" && <span className="noty-bookmark__desc">{error}</span>}
        <span className="noty-bookmark__url">
          {iconSrc && <img src={iconSrc} alt="" width={14} height={14} referrerPolicy="no-referrer" onError={(e) => (e.currentTarget.style.display = "none")} />}
          <span>{siteName && siteName !== host ? `${siteName} · ${href}` : href}</span>
        </span>
      </span>
      {imageSrc && (
        <span className="noty-bookmark__image">
          <img src={imageSrc} alt="" referrerPolicy="no-referrer" loading="lazy" onError={(e) => (e.currentTarget.parentElement!.style.display = "none")} />
        </span>
      )}
    </a>
  );
}

export const createBookmarkBlockSpec = createReactBlockSpec(
  {
    type: "bookmark",
    propSchema: {
      url: { default: "" },
      title: { default: "" },
      description: { default: "" },
      image: { default: "" },
      icon: { default: "" },
      siteName: { default: "" },
    },
    content: "none",
  } as const,
  { render: (props) => <BookmarkView block={props.block} editor={props.editor} /> },
);

/* ------------------------------------------------------------------ 임베드 */

function EmbedView({ block, editor }: { block: any; editor: any }) {
  const url = String(block.props.url ?? "");
  if (!url) {
    return (
      <UrlPrompt
        placeholder="임베드할 주소 붙여 넣기"
        hint={`지원: ${EMBED_PROVIDERS.join(", ")}`}
        editable={editor.isEditable}
        onSubmit={(next) => editor.updateBlock(block, { props: { url: next } })}
      />
    );
  }
  const target = toEmbed(url);
  if (!target) {
    return (
      <div className="noty-linkblock__empty" contentEditable={false}>
        이 주소는 임베드를 지원하지 않습니다.
        {editor.isEditable && (
          <button type="button" onClick={() => editor.updateBlock(block, { type: "bookmark", props: { url } })}>
            북마크로 바꾸기
          </button>
        )}
      </div>
    );
  }
  return (
    <div className={`noty-embed ${target.video ? "noty-embed--video" : ""}`} contentEditable={false} style={target.video ? undefined : { height: target.height }}>
      <iframe
        src={target.src}
        title={`${target.provider} 임베드`}
        loading="lazy"
        // 다른 출처라 이 페이지에 접근할 수는 없고, 여기에 더해 이 창 자체를 다른 주소로 옮기는 것(top navigation)을 막는다
        sandbox="allow-scripts allow-same-origin allow-popups allow-presentation allow-forms"
        allow="fullscreen; picture-in-picture; encrypted-media; clipboard-write"
        referrerPolicy="strict-origin-when-cross-origin"
      />
    </div>
  );
}

export const createEmbedBlockSpec = createReactBlockSpec(
  { type: "embed", propSchema: { url: { default: "" } }, content: "none" } as const,
  { render: (props) => <EmbedView block={props.block} editor={props.editor} /> },
);

/* ------------------------------------------------------------------ 슬래시 메뉴 */

export function getLinkBlockSlashMenuItems(editor: any): DefaultReactSuggestionItem[] {
  return [
    {
      title: "목차",
      subtext: "이 페이지의 제목들로 목차를 만듭니다",
      aliases: ["toc", "table of contents", "목차", "차례"],
      group: "고급",
      icon: <span aria-hidden="true">☰</span>,
      onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: "toc" } as any),
    },
    {
      title: "북마크",
      subtext: "웹 링크를 제목·설명·이미지가 있는 카드로",
      aliases: ["bookmark", "link", "web", "북마크", "링크", "웹"],
      group: "미디어",
      icon: <span aria-hidden="true">🔖</span>,
      onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: "bookmark" } as any),
    },
    {
      title: "임베드",
      subtext: "YouTube·Figma·Google 문서 등을 페이지 안에서 보기",
      aliases: ["embed", "youtube", "video", "figma", "임베드", "영상", "유튜브"],
      group: "미디어",
      icon: <span aria-hidden="true">▶</span>,
      onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: "embed" } as any),
    },
  ];
}

/* ------------------------------------------------------------------ 링크 붙여 넣기 메뉴 */

export interface LinkPasteState {
  blockId: string;
  url: string;
  /** 화면 좌표 (커서 아래) */
  x: number;
  y: number;
}

/** 붙여 넣은 링크를 북마크·임베드 블록으로 바꾼다. 문단에 링크만 있었으면 문단을 통째로 바꾼다. */
export function convertPastedLink(editor: any, state: LinkPasteState, type: "bookmark" | "embed"): void {
  const block = editor.getBlock(state.blockId);
  if (!block) return;
  const next = { type, props: { url: state.url } };
  const { content, onlyLink } = removePastedLink(block.content, state.url);
  editor.transact(() => {
    if (block.type === "paragraph" && onlyLink) {
      editor.replaceBlocks([block], [next]);
      return;
    }
    editor.updateBlock(block, { content });
    editor.insertBlocks([next], block, "after");
  });
}

/**
 * 웹 주소를 붙여 넣으면 커서 아래에 뜨는 메뉴: 링크로 두기 / 북마크 / 임베드(지원하는 주소만).
 * 다른 키를 누르거나 다른 곳을 누르면 링크로 둔 채 닫힌다.
 */
export function LinkPasteMenu({ editor, state, onClose }: { editor: any; state: LinkPasteState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const embed = toEmbed(state.url);
  const options: { key: string; label: string; hint: string; run: () => void }[] = [
    { key: "link", label: "링크로 두기", hint: "Esc", run: () => undefined },
    { key: "bookmark", label: "북마크", hint: "제목·설명·이미지 카드", run: () => convertPastedLink(editor, state, "bookmark") },
    ...(embed ? [{ key: "embed", label: "임베드", hint: `${embed.provider}를 페이지 안에서 보기`, run: () => convertPastedLink(editor, state, "embed") }] : []),
  ];
  const [active, setActive] = useState(0);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        setActive((i) => (i + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        options[activeRef.current].run();
        onClose();
        return;
      }
      // Esc 나 그 밖의 키: 링크로 두고 닫는다 (입력은 그대로 편집기로 간다)
      if (!["Shift", "Control", "Alt", "Meta"].includes(event.key)) onClose();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    // 편집기보다 먼저 받아야 화살표·Enter 가 편집기로 가지 않는다
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [state]);

  return (
    <div
      ref={ref}
      className="noty-paste-menu"
      role="menu"
      aria-label="붙여 넣은 링크"
      style={{ left: Math.min(state.x, window.innerWidth - 248), top: Math.min(state.y + 6, window.innerHeight - 140) }}
    >
      {options.map((option, index) => (
        <button
          key={option.key}
          type="button"
          role="menuitem"
          className={`noty-paste-menu__item ${index === active ? "noty-paste-menu__item--active" : ""}`}
          onMouseEnter={() => setActive(index)}
          onClick={() => {
            option.run();
            onClose();
          }}
        >
          <span>{option.label}</span>
          <span className="noty-paste-menu__hint">{option.hint}</span>
        </button>
      ))}
    </div>
  );
}
